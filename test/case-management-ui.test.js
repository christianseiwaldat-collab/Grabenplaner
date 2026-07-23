const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const desktopHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const desktopSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const portalHtml = fs.readFileSync(path.join(root, "public", "portal.html"), "utf8");
const portalSource = fs.readFileSync(path.join(root, "public", "portal.js"), "utf8");

function sourceFunction(source, name, nextName) {
  const pattern = new RegExp(`function ${name}\\([\\s\\S]+?(?=\\r?\\n\\r?\\n(?:async )?function ${nextName}\\()`);
  const match = source.match(pattern);
  assert.ok(match, `${name} konnte nicht aus dem Quelltext gelesen werden`);
  const context = {};
  vm.runInNewContext(`${match[0]}\nthis.result = ${name};`, context);
  return context.result;
}

test("UI-Funktionsprüfung unterstützt LF- und CRLF-Zeilenenden", () => {
  const crlfSource = portalSource.replace(/\r?\n/g, "\r\n");
  assert.equal(typeof sourceFunction(crlfSource, "leadershipDialogActions", "openLeadershipRequest"), "function");
});

test("Fallverwaltung zeigt offene und abgeschlossene Krankheits- und AUM-Status", () => {
  for (const status of ["reported", "aum_received", "recovered", "submitted", "returned", "reviewed", "withdrawn", "all"]) {
    assert.match(desktopHtml, new RegExp(`<option value="${status}"`), `Status ${status} fehlt im Desktop-Filter`);
  }
  assert.match(desktopSource, /const sicknessCases = state\.sicknessCases\.filter\(\(entry\) => statusFilter === "all"\s*\?\s*true/);
  assert.match(desktopSource, /const reports = state\.amuReports\.filter\(\(report\) => statusFilter === "all"\s*\?\s*true/);
  assert.match(desktopSource, /capabilities\.view === true \? '<button class="secondary-button" data-open-sickness-action/);
  assert.match(desktopSource, /const reportCanOpen = capabilities\.view === true/);

  assert.match(portalSource, /items = portalState\.leadershipSicknessCases\.filter\(leadershipItemInContext\)/);
  assert.match(portalSource, /items = portalState\.leadershipAmuReports\.filter\(leadershipItemInContext\)/);
  assert.match(portalSource, /item\.capabilities\?\.view === true/);
  assert.match(portalSource, /data-open-leadership-request>Öffnen/);
});

test("Krankenstandsabschluss und Korrektur verwenden Revision und Status als Sperre", () => {
  assert.match(desktopHtml, /data-sickness-action="close"[^>]*>Krankenstand schließen</);
  assert.match(desktopHtml, /data-sickness-action="correct_closed"[^>]*>Abschluss korrigieren</);
  assert.match(desktopSource, /expectedRevision: entry\.revision/);
  assert.match(desktopSource, /expectedStatus: entry\.status/);
  assert.match(desktopSource, /action === "correct_closed" && !note/);

  assert.match(portalHtml, /id="leadershipSicknessExpectedEnd"/);
  assert.match(portalHtml, /id="leadershipSicknessReturnDate"/);
  assert.match(portalSource, /expectedRevision: request\.revision/);
  assert.match(portalSource, /expectedStatus: request\.status/);
  assert.match(portalSource, /action === "correct_closed" && !note/);
});

test("AUM-Prüfung, Rückgabe und Notiz sind capability- und revisionsgebunden", () => {
  for (const action of ["review", "return", "add_note"]) {
    assert.match(desktopHtml, new RegExp(`data-amu-action="${action}"`));
  }
  assert.match(desktopSource, /capabilities\.review === true && \["submitted", "returned"\]\.includes\(report\.status\)/);
  assert.match(desktopSource, /capabilities\.returnForCompletion === true/);
  assert.match(desktopSource, /capabilities\.addNote === true/);
  assert.match(desktopSource, /expectedRevision: report\.revision/);
  assert.match(desktopSource, /expectedStatus: report\.status/);

  const leadershipDialogActions = sourceFunction(portalSource, "leadershipDialogActions", "openLeadershipRequest");
  assert.deepEqual(
    JSON.parse(JSON.stringify(leadershipDialogActions({
      status: "returned",
      capabilities: { view: true, review: true, returnForCompletion: false, addNote: true },
    }, "amu"))).map(([action]) => action),
    ["review", "add_note"],
  );
  assert.match(portalSource, /api\(`\/api\/portal\/v1\/amu-reports\/\$\{encodeURIComponent\(request\.id\)\}`\)/);
  assert.match(portalSource, /body = \{ action, note, expectedRevision: request\.revision, expectedStatus: request\.status \}/);
});

test("AUM-Dokumente werden ohne explizites Dateirecht weder benannt noch verlinkt", () => {
  assert.match(desktopSource, /const reportCanOpenFiles = capabilities\.openFiles === true/);
  assert.match(desktopSource, /const canOpenFiles = report\.capabilities\?\.openFiles === true/);
  assert.match(desktopSource, /Dokument geschützt · kein Dateizugriff/);
  assert.doesNotMatch(desktopSource, /reportCanOpenFiles[\s\S]{0,450}\?\s*`<a[\s\S]{0,300}:\s*`<span>\$\{escapeHtml\(document\.original_name/);

  assert.match(portalHtml, /id="leadershipRequestDocuments"/);
  assert.match(portalSource, /const canOpenAmuFiles = kind === "amu" && request\.capabilities\?\.openFiles === true/);
  assert.match(portalSource, /leadershipRequestDocuments\.innerHTML = canOpenAmuFiles\s*\?/);
  assert.match(portalSource, /leadershipRequestDocuments\.classList\.toggle\("hidden", !canOpenAmuFiles/);
});

test("Abgelehnte und abgeschlossene Abwesenheitsanträge bleiben lesbar, aber aktionslos", () => {
  assert.match(desktopSource, /const canOpen = request\.capabilities\?\.view === true/);
  assert.match(desktopSource, /const canDecide = capabilities\.decide === true/);
  assert.match(desktopSource, /const canUpdate = capabilities\.update === true/);
  assert.match(desktopSource, /const canClose = capabilities\.close === true/);
  assert.match(desktopSource, /canOpen \? '<button class="secondary-button" data-open-request-action type="button">Antrag öffnen/);

  const leadershipDialogActions = sourceFunction(portalSource, "leadershipDialogActions", "openLeadershipRequest");
  for (const status of ["rejected", "cancelled", "withdrawn"]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(leadershipDialogActions({ status, capabilities: { view: true } }, "absence"))),
      [],
      `${status} darf keine Entscheidungsaktion anbieten`,
    );
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(leadershipDialogActions({
      status: "approved",
      capabilities: { view: true, update: true, close: true },
    }, "absence"))).map(([action]) => action),
    ["change", "cancel"],
  );
});
