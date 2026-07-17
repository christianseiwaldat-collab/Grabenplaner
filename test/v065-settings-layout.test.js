const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function section(id) {
  return html.match(new RegExp(`<section id="${id}"[\\s\\S]*?(?=<section id="|</main>)`))?.[0] || "";
}

test("v0.65: Einstellungen sind fachlich in Urlaub, Zeiterfassung und Personal gegliedert", () => {
  assert.match(html, /data-settings-tab="vacation">Urlaub</);
  assert.match(html, /data-settings-tab="timeTracking">Zeiterfassung</);
  assert.doesNotMatch(html, /data-settings-tab="wifiAutomation"/);

  const general = section("generalSettings");
  const vacation = section("vacationSettings");
  const timeTracking = section("timeTrackingSettings");
  const personnel = section("personnelSettings");
  assert.match(general, /Ansicht &amp; Startverhalten/);
  assert.match(general, /id="showSunday"/);
  assert.doesNotMatch(general, /id="breakRuleEnabled"|id="saturdayBonusEnabled"|id="vacationCountSaturday"/);
  assert.match(vacation, /id="workflowSettingsCard"/);
  assert.match(vacation, /id="delegationSettingsCard"/);
  assert.match(timeTracking, /id="breakRuleEnabled"/);
  assert.match(timeTracking, /id="saturdayBonusEnabled"/);
  assert.match(timeTracking, /id="vacationCountSaturday"/);
  assert.match(timeTracking, /id="wifiSettingsCard"/);
  assert.match(personnel, /id="trustLevelSettingsCard"/);
});

test("v0.65: Zugänge und Rechtemanagement bleiben echte Zweispalten-Bereiche", () => {
  const access = section("accessSettings");
  const rights = section("rightsSettings");
  assert.match(access, /settings-section settings-two-column/);
  assert.match(rights, /settings-section settings-two-column/);
  assert.doesNotMatch(access, /settings-card full-span/);
  assert.doesNotMatch(rights, /settings-card full-span/);
  assert.match(styles, /#accessSettings \.greeting-template-grid \{ grid-template-columns:minmax\(0,1fr\); \}/);
});

test("v0.65: Letzte Gesamtpläne werden benutzerbezogen und nur lokal im Browser gemerkt", () => {
  assert.match(app, /grabenplaner-last-overall-plan:\$\{contextPreferenceUserKey\(\)\}:\$\{view\}/);
  assert.match(app, /function restoreRememberedOverallContext/);
  assert.match(app, /rememberOverallContext\(button\.dataset\.contextView/);
  assert.doesNotMatch(app, /fetch\([^\n]*last-overall-plan/);
});
