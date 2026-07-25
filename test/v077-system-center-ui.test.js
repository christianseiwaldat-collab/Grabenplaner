const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function functionSource(name, nextName) {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} fehlt`);
  assert.ok(end > start, `${nextName} fehlt nach ${name}`);
  return script.slice(start, end);
}

test("Block 2/7: fachliche Dashboards stehen vorne und das System-Center ganz rechts", () => {
  const systemTab = html.indexOf('data-rights-dashboard-mode="systemCenter"');
  const locationTab = html.indexOf('data-rights-dashboard-mode="locations"');
  const rightsTab = html.indexOf('data-rights-dashboard-mode="rights"');
  const personnelRulesTab = html.indexOf('data-rights-dashboard-mode="personnelRules"');
  const processesTab = html.indexOf('data-rights-dashboard-mode="processes"');
  assert.ok(locationTab >= 0 && locationTab < rightsTab);
  assert.ok(rightsTab < personnelRulesTab);
  assert.ok(personnelRulesTab < processesTab);
  assert.ok(processesTab < systemTab);
  assert.match(html, /data-rights-dashboard-mode="systemCenter" data-dashboard-capability="system"/);
  assert.match(html, /data-rights-dashboard-mode="locations" data-dashboard-capability="rights"/);
  assert.match(html, /data-rights-dashboard-mode="processes"[^>]*>Abläufe &amp; Prozesse<\/button>/);
  assert.match(html, /class="system-center-panel hidden" id="systemCenterPanel"/);
  assert.match(html, /class="location-dashboard-panel" id="rightsDashboardLocationsPanel"/);
  for (const marker of ["systemCenterPanel", "systemCenterUpdated", "refreshSystemCenter", "startRecoveryAssurance", "systemCenterContent"]) {
    assert.match(html, new RegExp(`id="${marker}"`));
  }
  assert.match(html, /id="systemCenterContent"[^>]*aria-live="polite"[^>]*aria-busy="true"/);
  assert.match(script, /function canReadSystemCenter\(\)/);
  assert.match(script, /system:diagnostics:read/);
  assert.match(script, /system:diagnostics:technical/);
  assert.match(script, /rightsDashboardMode: "locations"/);
  assert.match(script, /\["locations", "rights", "personnelRules", "processes", "systemCenter"\]\.includes\(dashboardMode\)/);
});

test("v0.77: System-Center lädt nur seinen Diagnose-Endpunkt", () => {
  const systemLoader = functionSource("loadSystemCenter", "startRecoveryAssurance");
  const governanceLoader = functionSource("loadGovernanceDashboards", "loadRightsDashboard");
  const router = functionSource("loadRightsDashboard", "saveMobileLeadershipSettings");
  assert.match(systemLoader, /api\("\/api\/portal\/v1\/system-center"\)/);
  assert.doesNotMatch(systemLoader, /rights-dashboard|personnel-field-rights|dashboards\/locations/);
  assert.match(governanceLoader, /if \(!canReadGovernanceDashboards\(\)\) return;/);
  assert.match(governanceLoader, /\/api\/portal\/v1\/rights-dashboard/);
  assert.match(router, /if \(selected === "systemCenter"\) await loadSystemCenter\(\);/);
  assert.match(router, /else await loadGovernanceDashboards\(\);/);
});

test("v0.77: Manueller Recovery-Test benötigt Bestätigung und explizites API-Token", () => {
  const start = functionSource("startRecoveryAssurance", "setRightsDashboardMode");
  assert.match(start, /confirm\("Jetzt einen vollständigen Recovery-Assurance-Test starten\?/);
  assert.match(start, /\/api\/portal\/v1\/system-center\/recovery-assurance\/run/);
  assert.match(start, /method: "POST"/);
  assert.match(start, /confirmation: "RECOVERY_ASSURANCE_START"/);
  assert.match(script, /startRecoveryAssurance\?\.addEventListener\("click", startRecoveryAssurance\)/);
  assert.match(script, /refreshSystemCenter\?\.addEventListener\("click", \(\) => loadSystemCenter\(\)\)/);
});

test("v0.77: Vertrauensindex, Nachweiskarten und signierte Laufhistorie sind vertragstreu", () => {
  assert.match(script, /trustIndex\?\.cards/);
  assert.match(script, /possiblePoints/);
  assert.match(script, /earnedPoints/);
  assert.match(script, /coverage/);
  assert.match(script, /evidenceAt/);
  assert.match(script, /assurance\.recentRuns/);
  assert.match(script, /run\?\.phases/);
  for (const label of ["Bestätigt", "Kritisch", "Prüfen", "Nicht nachgewiesen"]) assert.match(script, new RegExp(label));
  assert.match(script, /aria-label="Technischer Vertrauensindex:/);
  assert.match(script, /system-center-state/);
});

test("v0.77: System-Center folgt Dashboard-Darkmode, Schriftgröße und Responsive Layout", () => {
  assert.match(styles, /\.system-center-hero/);
  assert.match(styles, /\.system-center-factor-grid/);
  assert.match(styles, /\.system-center-run-phases/);
  assert.match(styles, /\.system-center-state\.critical/);
  assert.match(styles, /\.system-center-state\.warning/);
  assert.match(styles, /\.system-center-state\.ok/);
  assert.match(styles, /rights-dashboard\[data-dashboard-theme="dark"\][\s\S]*--rd-critical-soft/);
  assert.match(styles, /rights-dashboard\[data-dashboard-font-size\][^\n]*system-center-factor/);
  assert.match(styles, /@media \(max-width: 1250px\)[\s\S]*system-center-factor-grid/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*system-center-factor-grid/);
});
