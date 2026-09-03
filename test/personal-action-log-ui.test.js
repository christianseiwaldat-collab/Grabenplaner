const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const portalHtml = fs.readFileSync(path.join(root, "public", "portal.html"), "utf8");
const portalScript = fs.readFileSync(path.join(root, "public", "portal.js"), "utf8");
const portalStyles = fs.readFileSync(path.join(root, "public", "portal.css"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const adminScript = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const adminStyles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Mitarbeiterportal bietet ein persönliches Aktionslog als eigenen Dialog", () => {
  for (const id of [
    "personalActionsButton",
    "personalActionsDialog",
    "personalActionsList",
    "personalActionsMessage",
    "personalActionsLoadMore",
  ]) assert.match(portalHtml, new RegExp(`id="${id}"`));
  assert.match(portalHtml, /ausschließlich deine eigenen protokollierten Aktionen/);
  assert.match(portalHtml, /wenn der aktuelle Stand unverändert ist/);
  assert.match(portalStyles, /\.personal-action-row/);
  assert.match(portalStyles, /\.personal-action-final/);
});

test("Aktionslog lädt ausschließlich die Self-Route und paginiert serverseitig", () => {
  assert.match(portalScript, /api\(`\/api\/portal\/v1\/me\/actions\?\$\{query\}`\)/);
  assert.match(portalScript, /new URLSearchParams\(\{ limit: "25" \}\)/);
  assert.match(portalScript, /query\.set\("cursor", cursor\)/);
  assert.doesNotMatch(portalScript, /actions\?[^`\n]*(employee|personnel|actor)/i);
});

test("Rückgängig nutzt die CSRF-geschützte POST-Gegenaktion und erhält die Historie", () => {
  assert.match(portalScript, /\/api\/portal\/v1\/me\/actions\/\$\{encodeURIComponent\(actionId\)\}\/undo/);
  assert.match(portalScript, /method: "POST"/);
  assert.match(portalScript, /Die ursprüngliche Historie bleibt erhalten/);
  assert.match(portalScript, /action\.canUndo === true \|\| action\.undo\?\.available === true/);
});

test("Aktionsbezeichnungen werden als Text und nicht als HTML gerendert", () => {
  assert.match(portalScript, /title\.textContent = String\(action\.title/);
  assert.match(portalScript, /summary\.textContent = String\(action\.summary/);
  assert.doesNotMatch(portalScript, /personalActionsList\.innerHTML/);
});

test("Desktop-Verwaltung bietet dasselbe persönliche Self-Service-Aktionslog", () => {
  for (const id of [
    "personalActionsAdminButton",
    "personalActionsAdminDialog",
    "personalActionsAdminList",
    "personalActionsAdminMessage",
    "personalActionsAdminLoadMore",
  ]) assert.match(adminHtml, new RegExp(`id="${id}"`));
  assert.match(adminHtml, /ausschließlich deine eigenen protokollierten Aktionen/);
  assert.match(adminScript, /api\(`\/api\/portal\/v1\/me\/actions\?\$\{query\}`\)/);
  assert.match(adminScript, /\/api\/portal\/v1\/me\/actions\/\$\{encodeURIComponent\(actionId\)\}\/undo/);
  assert.match(adminScript, /title\.textContent = String\(action\.title/);
  assert.match(adminScript, /summary\.textContent = String\(action\.summary/);
  assert.doesNotMatch(adminScript, /personalActionsAdminList\.innerHTML/);
  assert.match(adminStyles, /\.admin-personal-action-row/);
});

test("Actorwechsel und Abmeldung verwerfen persönliche Aktionslog-Zustände", () => {
  const portalActorSync = between(portalScript, "function showPortal(session)", "async function login(event)");
  const portalLoginGate = between(portalScript, "function showLogin(error", "function applySelfServiceVisibility()");
  const portalLogout = between(portalScript, "async function logout()", "function setTab(tab)");
  assert.match(portalActorSync, /portalPersonalActionsActorKey\(session\?\.user\)/);
  assert.match(portalActorSync, /resetPersonalActionsState\(nextPersonalActionsActor\)/);
  assert.match(portalLoginGate, /resetPersonalActionsState\(""\)[\s\S]*portalState\.session = null/);
  assert.match(portalLogout, /portalState\.session = null[\s\S]*showLogin\(\)/);

  const adminActorSync = between(adminScript, "function syncAdminPersonalActionsActorState()", "function adminPersonalActionsRequestIsCurrent");
  const adminLoginGate = between(adminScript, "function showLoginGate(message", "function hideLoginGate()");
  const adminLogout = between(adminScript, "async function logoutPortal()", "function openAdminSetup()");
  assert.match(adminActorSync, /currentAdminPersonalActionsActorKey\(\)[\s\S]*resetAdminPersonalActionsState\(actorKey\)/);
  assert.match(adminLoginGate, /resetAdminPersonalActionsState\(""\)/);
  assert.match(adminLogout, /window\.location\.reload\(\)/);
});

test("Veraltete Aktionslog-Antworten dürfen weder Admin- noch Portalzustand anwenden", () => {
  const portalReset = between(portalScript, "function resetPersonalActionsState", "function personalActionsRequestIsCurrent");
  const portalCurrent = between(portalScript, "function personalActionsRequestIsCurrent", "function renderPersonalActions");
  const portalLoad = between(portalScript, "async function loadPersonalActions", "async function openPersonalActions");
  assert.match(portalReset, /personalActionsRequestId \+= 1/);
  assert.match(portalCurrent, /personalActionsActorKey === actorKey[\s\S]*portalPersonalActionsActorKey\(\) === actorKey[\s\S]*personalActionsRequestId === requestId/);
  const portalResponse = portalLoad.indexOf("const result = await api(");
  assert.ok(
    portalLoad.indexOf("personalActionsRequestIsCurrent(actorKey, requestId)", portalResponse)
      < portalLoad.indexOf("portalState.personalActions =", portalResponse),
    "Portal darf Listendaten erst nach Actor- und Request-ID-Prüfung übernehmen.",
  );

  const adminReset = between(adminScript, "function resetAdminPersonalActionsState", "function syncAdminPersonalActionsActorState");
  const adminCurrent = between(adminScript, "function adminPersonalActionsRequestIsCurrent", "function adminPersonalActionTimestamp");
  const adminLoad = between(adminScript, "async function loadAdminPersonalActions", "async function openAdminPersonalActions");
  assert.match(adminReset, /personalActionsRequestId \+= 1/);
  assert.match(adminCurrent, /actorKey === currentAdminPersonalActionsActorKey\(\)[\s\S]*actorKey === state\.personalActionsActorKey[\s\S]*requestId === state\.personalActionsRequestId/);
  const adminResponse = adminLoad.indexOf("const result = await api(");
  assert.ok(
    adminLoad.indexOf("adminPersonalActionsRequestIsCurrent(actorKey, requestId)", adminResponse)
      < adminLoad.indexOf("state.personalActions = append", adminResponse),
    "Admin darf Listendaten erst nach Actor- und Request-ID-Prüfung übernehmen.",
  );
});

test("Rückgängig bleibt während Listenladen gesperrt und erhöht die Portal-Request-ID erst nach Bestätigung", () => {
  const portalUndo = between(portalScript, "async function undoPersonalAction", "function notificationIsRead");
  const adminUndo = between(adminScript, "async function undoAdminPersonalAction", "let functionSearchController");
  assert.match(portalUndo, /!action \|\| portalState\.personalActionsLoading \|\| portalState\.personalActionUndoPending/);
  assert.match(adminUndo, /!action \|\| state\.personalActionsLoading \|\| state\.personalActionUndoPending/);
  const portalConfirm = portalUndo.indexOf("window.confirm(");
  const portalRequestIncrement = portalUndo.indexOf("++portalState.personalActionsRequestId");
  assert.ok(portalConfirm >= 0 && portalConfirm < portalRequestIncrement,
    "Eine abgebrochene Bestätigung darf die Portal-Request-ID nicht verändern.");
  assert.match(portalScript, /undo\.disabled = portalState\.personalActionsLoading/);
  assert.match(adminScript, /undo\.disabled = state\.personalActionsLoading/);
});

test("Admin-Rückgängig aktualisiert die sichtbare Dienstplansperre nur im aktuellen Kontext", () => {
  const helper = between(adminScript, "function applyCurrentManualScheduleLockResult", "async function undoAdminPersonalAction");
  assert.match(helper, /manualScheduleLock\.locationId[\s\S]*state\.locationId/);
  assert.match(helper, /manualScheduleLock\.weekStart[\s\S]*state\.weekStart/);
  assert.match(helper, /state\.data\.manualScheduleLock = manualScheduleLock/);
  assert.match(helper, /renderManualScheduleLockControl\(\)/);
  const undo = between(adminScript, "async function undoAdminPersonalAction", "let functionSearchController");
  const responseAt = undo.indexOf("const result = await api(");
  const guardAt = undo.indexOf("adminPersonalActionsRequestIsCurrent(actorKey, requestId)", responseAt);
  const applyAt = undo.indexOf("applyCurrentManualScheduleLockResult(result?.manualScheduleLock)", guardAt);
  assert.ok(responseAt >= 0 && guardAt > responseAt && applyAt > guardAt);
});
