"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const styles = read("public/styles.css");
const portal = read("public/portal.html");
const catalog = read("public/function-search-catalog.js");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `Startmarke fehlt: ${start}`);
  assert.ok(to > from, `Endmarke fehlt: ${end}`);
  return source.slice(from, to);
}

test("Block 8: Geburtstagsdarstellung ist eine getrennte Karte direkt nach den globalen Begrüßungen", () => {
  const access = between(html, '<section id="accessSettings"', '<section id="rightsSettings"');
  const greetingIndex = access.indexOf('id="greetingSettingsCard"');
  const birthdayIndex = access.indexOf('id="birthdayPresentationSettingsCard"');
  const portalUsersIndex = access.indexOf('id="portalUserAccessCard"');

  assert.ok(greetingIndex >= 0 && greetingIndex < birthdayIndex);
  assert.ok(birthdayIndex < portalUsersIndex);
  assert.match(access, /id="greetingMorningTemplates"/);
  assert.match(access, /id="saveGreetingSettingsButton"/);

  const card = between(access, '<div class="settings-card hidden" id="birthdayPresentationSettingsCard">', '<div class="settings-card" id="portalUserAccessCard">');
  for (const id of [
    "birthdayPresentationScope",
    "birthdayPresentationGlobalSection",
    "birthdayPresentationEnabled",
    "birthdayPresentationTeamSection",
    "birthdayPresentationEmployeeSearch",
    "birthdayPresentationLocationFilter",
    "birthdayPresentationEmployeeList",
    "birthdayPresentationDelegatesSection",
    "birthdayPresentationDelegateList",
    "birthdayPresentationSettingsHint",
    "saveBirthdayPresentationSettingsButton",
  ]) assert.match(card, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(card, /<(?:img|canvas)|Vorschau erzeugen|data-page-theme|showModal/i);
});

test("Block 8: Sichtbarkeit folgt ausschließlich den beiden Geburtstagsrechten und Server-Capabilities", () => {
  assert.match(app, /permissions\.includes\("portal:birthday:team:write"\)/);
  assert.match(app, /permissions\.includes\("portal:birthday:settings:write"\)/);
  assert.match(app, /birthdayPresentationSettingsAccess/);
  assert.match(app, /birthdayPresentationSettingsAccess = features\.employeePortal !== false && \(\s*permissions\.includes\("portal:birthday:team:write"\)/);
  assert.doesNotMatch(app, /birthdayPresentationSettingsAccess = features\.employeePortal !== false && \(\s*!lanActive/);
  assert.match(app, /access:\s*birthdayPresentationSettingsAccess/);
  assert.match(app, /birthdayPresentationSettingsCard\?\.classList\.toggle\("hidden", !birthdayPresentationSettingsAccess\)/);

  const implementation = between(app, "function birthdayPresentationCatalog", "function renderWifiConfirmationLevels");
  assert.match(implementation, /capabilities\.canManageGlobal === true/);
  assert.match(implementation, /capabilities\.canManageTeam === true/);
  assert.match(implementation, /capabilities\.canDelegateTeam === true/);
  assert.match(implementation, /const canOverrideDeniedDelegation = capabilities\.canManageGlobal === true/);
  assert.match(implementation, /const delegationLocked = denied && !canOverrideDeniedDelegation/);
  assert.match(implementation, /delegationLocked \? "disabled" : ""/);
  assert.match(implementation, /Übergeordnet durch PL\+ gesperrt · nur PL\+ kann diese Sperre aufheben/);
  assert.match(implementation, /Übergeordnet gesperrt · als PL\+ können Sie diese Sperre hier aufheben/);
  assert.match(implementation, /denied && canOverrideDeniedDelegation \? "Sperre aufheben" : "Delegiert"/);
  assert.doesNotMatch(implementation, /\$\{denied \? "disabled" : ""\}/);
  assert.doesNotMatch(implementation, /\.role\b|globalAdministration|birthDate|dateOfBirth|Geburtsdatum/);
});

test("Block 8: Team und Varianten werden nur aus der Serverprojektion gerendert", () => {
  const implementation = between(app, "function birthdayPresentationCatalog", "function renderWifiConfirmationLevels");
  assert.match(implementation, /result\?\.presentations/);
  assert.match(implementation, /birthdayPresentationSettings\.employees/);
  assert.match(implementation, /birthdayPresentationSettings\.delegates/);
  assert.match(implementation, /<option value=""[^>]*>Deaktiviert<\/option>/);
  assert.match(implementation, /birthdayPresentationCatalog\(\)\.map/);
  assert.doesNotMatch(implementation, /<option value="standard"/);
  assert.match(implementation, /employee\?\.employeeNumber/);
  assert.match(implementation, /employee\?\.displayName/);
  assert.match(implementation, /employee\?\.locationName/);
  assert.match(implementation, /employee\?\.departmentName/);
});

test("Block 8: Speicherung ist revisionsgebunden und überträgt nur geänderte Werte", () => {
  const implementation = between(app, "function birthdayPresentationCatalog", "function renderWifiConfirmationLevels");
  assert.match(implementation, /checked !== \(result\.policy\?\.enabled === true\)/);
  assert.match(implementation, /select\.value[\s\S]*?select\.dataset\.birthdayPresentationOriginal/);
  assert.match(implementation, /input\.checked !== \(input\.dataset\.birthdayPresentationOriginal === "1"\)/);
  assert.match(implementation, /\/api\/portal\/v1\/birthday-presentation-settings\/global/);
  assert.match(implementation, /expectedRevision:\s*result\.policy\?\.revision/);
  assert.match(implementation, /birthday-presentation-settings\/employees\/\$\{encodeURIComponent\(employee\.employeeNumber\)\}/);
  assert.match(implementation, /presentationId:\s*employee\.presentationId,[\s\S]*?expectedRevision:\s*employee\.expectedRevision/);
  assert.match(implementation, /birthday-presentation-settings\/delegates\/\$\{encodeURIComponent\(delegate\.employeeNumber\)\}/);
  assert.match(implementation, /JSON\.stringify\(\{ enabled:\s*delegate\.enabled \}\)/);
});

test("Block 8: Portal, Grafik, Einmaleinblendung und Geburtstagstheme bleiben unangetastet", () => {
  assert.doesNotMatch(portal, /birthdayPresentation|birthdayOverlay|birthdayModal|birthdayTheme/);
  assert.match(app, /loadBirthdayPresentationSettings\(\)/);
  assert.doesNotMatch(styles, /birthday-(?:overlay|modal|theme)|--birthday-/);
});

test("Block 8: Funktionssuche navigiert präzise zur berechtigten Geburtstagskarte", () => {
  const entry = between(catalog, '"settings.birthday-presentation"', '"settings.portal-users"');
  assert.match(entry, /Geburtstagsdarstellung einstellen/);
  assert.match(entry, /"geburtstag"/);
  assert.match(entry, /"gb einblendung"/);
  assert.match(entry, /\["settingsAccessTab", "birthdayPresentationSettingsCard"\]/);
  assert.match(entry, /settingsTab:\s*"access"/);
  assert.match(entry, /focusId:\s*"birthdayPresentationSettingsCard"/);
});

test("Block 8: Geburtstagskonfiguration bleibt responsiv und ohne starre Desktopbreite", () => {
  assert.match(styles, /\.birthday-presentation-toolbar \{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(150px,\.65fr\)/);
  assert.match(styles, /\.birthday-presentation-row \{[^}]*display:flex/);
  assert.match(styles, /\.greeting-rule-grid,\.greeting-template-grid,\.birthday-presentation-toolbar \{ grid-template-columns:1fr; \}/);
  assert.match(styles, /\.birthday-presentation-section-heading,\.birthday-presentation-row \{ align-items:stretch; flex-direction:column; \}/);
  assert.match(styles, /\.birthday-presentation-row select \{ width:min\(100%,320px\); min-width:0; \}/);
});
