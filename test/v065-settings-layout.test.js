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

function detailsTag(id) {
  return html.match(new RegExp(`<details[^>]*\\bid="${id}"[^>]*>`))?.[0] || "";
}

test("v0.65: Einstellungen sind fachlich in Urlaub, Zeiterfassung und Personal gegliedert", () => {
  assert.match(html, /data-settings-tab="vacation">Urlaub</);
  assert.match(html, /data-settings-tab="timeTracking">Zeiterfassung</);
  assert.doesNotMatch(html, /data-settings-tab="wifiAutomation"/);
  assert.doesNotMatch(html, /data-settings-tab="branding"|data-settings-tab="pdf"/);

  const general = section("generalSettings");
  const vacation = section("vacationSettings");
  const timeTracking = section("timeTrackingSettings");
  const personnel = section("personnelSettings");
  assert.match(general, /Ansicht &amp; Startverhalten/);
  assert.match(general, /id="showSunday"/);
  assert.doesNotMatch(general, /id="breakRuleEnabled"|id="saturdayBonusEnabled"/);
  assert.match(vacation, /id="workflowSettingsCard"/);
  assert.match(vacation, /id="delegationSettingsCard"/);
  assert.match(timeTracking, /id="breakRuleEnabled"/);
  assert.match(timeTracking, /id="saturdayBonusEnabled"/);
  assert.doesNotMatch(html, /vacationCountSaturday|Samstag als Urlaubstag|vacation_count_saturday/);
  assert.doesNotMatch(app, /vacationCountSaturday|vacation_count_saturday/);
  assert.match(timeTracking, /id="wifiSettingsCard"/);
  assert.match(personnel, /id="trustLevelSettingsCard"/);
});

test("Block 7: Leihe, Branding und PDF sind geschlossene Bereiche der Grundeinstellungen", () => {
  const general = section("generalSettings");
  const viewBehavior = general.match(
    /<div class="settings-card" id="viewBehaviorSettingsCard">[\s\S]*?<\/div>\s*<div class="settings-card past-week-card">/,
  )?.[0] || "";

  assert.match(viewBehavior, /id="toastDuration"/);
  assert.match(viewBehavior, /id="decreaseAppFontScale"/);
  assert.match(viewBehavior, /id="appFontScalePercent"[^>]*type="number"[^>]*min="75"[^>]*max="150"[^>]*step="5"/);
  assert.match(viewBehavior, /id="increaseAppFontScale"/);
  assert.doesNotMatch(general, /id="dashboardFontSize"|operation-mode-card|Betriebsmodus/);

  for (const id of ["loanSettingsCard", "brandingSettings", "pdfSettings"]) {
    const tag = detailsTag(id);
    assert.match(tag, /class="[^"]*\bsettings-accordion\b[^"]*\bfull-settings-card\b[^"]*"/);
    assert.doesNotMatch(tag, /\sopen(?:\s|=|>)/);
    assert.ok(general.includes(tag), `${id} muss innerhalb der Grundeinstellungen liegen`);
  }

  const loanIndex = general.indexOf('id="loanSettingsCard"');
  const brandingIndex = general.indexOf('id="brandingSettings"');
  const pdfIndex = general.indexOf('id="pdfSettings"');
  assert.ok(loanIndex >= 0 && loanIndex < brandingIndex, "Leihe muss vor Branding stehen");
  assert.ok(brandingIndex < pdfIndex, "PDF-Ausgabe muss am Ende der integrierten Bereiche stehen");
  assert.match(general, /id="brandingCompanyName"/);
  assert.match(general, /id="brandingAssignmentList"/);
  assert.match(general, /id="pdfTitleSetting"/);
  assert.match(general, /id="vacationPdfTitleSetting"/);

  assert.match(styles, /\.settings-two-column \{[^}]*grid-auto-rows:\s*max-content;[^}]*align-items:\s*start;/);
  assert.match(styles, /\.settings-card \{[^}]*align-self:\s*start;[^}]*height:\s*auto;/);
  assert.match(styles, /\.settings-accordion-grid \{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\);[^}]*grid-auto-rows:\s*max-content;[^}]*align-items:\s*start;/);
  assert.match(styles, /\.settings-packed-grid \{[^}]*grid-auto-flow:\s*row;[^}]*grid-auto-rows:\s*1px;[^}]*row-gap:\s*0;/);
  assert.match(app, /Math\.ceil\(item\.offsetHeight \+ 15\)/);
  assert.match(app, /new ResizeObserver/);
  assert.match(styles, /@media \(max-width:\s*820px\)[\s\S]*?\.settings-accordion-grid \{ grid-template-columns:\s*1fr; \}/);
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
