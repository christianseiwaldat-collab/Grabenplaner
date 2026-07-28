const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("v0.78: System-Center zeigt Nachtbetrieb, App-Smoke und redigierte Eskalation", () => {
  const operationsStart = script.indexOf("function renderSystemCenterOperations");
  const operationsEnd = script.indexOf("function normalizedSystemCenterTrendPoints", operationsStart);
  const operations = script.slice(operationsStart, operationsEnd);
  assert.match(script, /"scheduled-nightly": "Nächtliche Automatik"/);
  assert.match(script, /"application-smoke-passed": "Isolierter App-Start"/);
  assert.match(script, /"application-smoke-failed": "Isolierter App-Start"/);
  assert.match(script, /function renderSystemCenterOperations\(automation, notifications\)/);
  assert.match(script, /Nächtliche Recovery Assurance/);
  assert.match(script, /Fehlgeschlagene oder überfällige Nachweise werden dedupliziert/);
  assert.match(script, /Empfängerdaten bleiben im System-Center verborgen/);
  assert.match(operations, /delivery\.failedRecoveryRuns/);
  assert.match(operations, /Fehlgeschlagene Recovery-Läufe/);
  assert.doesNotMatch(operations, /delivery\.failures/);
  assert.doesNotMatch(operations, /delivery\.(?:recipients(?!Count)|email|address)/);
});

test("v0.78: Langzeitwerte sind begrenzt, barrierearm und ohne externe Diagrammbibliothek", () => {
  assert.match(script, /function normalizedSystemCenterTrendPoints\(trends\)/);
  assert.match(script, /\.slice\(-120\)/);
  assert.match(script, /trustScore/);
  assert.match(script, /databaseBytes/);
  assert.match(script, /backupDurationSeconds/);
  assert.match(script, /recoveryDurationSeconds/);
  assert.match(script, /<svg viewBox="0 0 \$\{width\} \$\{height\}" role="img" aria-label=/);
  assert.doesNotMatch(script, /Chart\(|d3\.|plotly/i);
});

test("v0.78: neue System-Center-Bereiche folgen Darkmode, globaler Schriftgröße und responsivem Raster", () => {
  for (const marker of [
    ".system-center-operations",
    ".system-center-operation",
    ".system-center-trends",
    ".system-center-trend-grid",
    ".system-center-trend-card",
  ]) assert.match(styles, new RegExp(marker.replace(".", "\\.")));
  assert.match(styles, /@media \(max-width: 1250px\)[\s\S]*system-center-trend-grid/);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*system-center-operations/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*system-center-trend-grid/);
  assert.match(styles, /--app-font-scale:\s*1;/);
  assert.match(styles, /body \{[^}]*zoom:\s*var\(--app-font-scale\);/);
  assert.doesNotMatch(styles, /data-dashboard-font-size=/);
  assert.match(styles, /rights-dashboard\[data-dashboard-theme="dark"\]/);
});
