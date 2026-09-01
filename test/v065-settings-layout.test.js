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

test("Block 7: Leihe und Branding bleiben in den Grundeinstellungen, PDF wechselt zur Dienstplanung", () => {
  const general = section("generalSettings");
  const viewBehavior = general.match(
    /<div class="settings-card" id="viewBehaviorSettingsCard">[\s\S]*?<\/div>\s*<details/,
  )?.[0] || "";

  assert.match(viewBehavior, /id="toastDuration"/);
  assert.match(viewBehavior, /id="decreaseAppFontScale"/);
  assert.match(viewBehavior, /id="appFontScalePercent"[^>]*type="number"[^>]*min="75"[^>]*max="150"[^>]*step="5"/);
  assert.match(viewBehavior, /id="increaseAppFontScale"/);
  assert.doesNotMatch(general, /id="dashboardFontSize"|operation-mode-card|Betriebsmodus/);

  for (const id of ["loanSettingsCard", "brandingSettings"]) {
    const tag = detailsTag(id);
    assert.match(tag, /class="[^"]*\bsettings-accordion\b[^"]*\bfull-settings-card\b[^"]*"/);
    assert.doesNotMatch(tag, /\sopen(?:\s|=|>)/);
    assert.ok(general.includes(tag), `${id} muss innerhalb der Grundeinstellungen liegen`);
  }

  const loanIndex = general.indexOf('id="loanSettingsCard"');
  const brandingIndex = general.indexOf('id="brandingSettings"');
  assert.ok(loanIndex >= 0 && loanIndex < brandingIndex, "Leihe muss vor Branding stehen");
  assert.match(general, /id="brandingCompanyName"/);
  assert.match(general, /id="brandingAssignmentList"/);
  const pdfTag = detailsTag("pdfSettings");
  assert.match(pdfTag, /class="[^"]*\bsettings-accordion\b[^"]*\bfull-settings-card\b[^"]*"/);
  assert.doesNotMatch(pdfTag, /\sopen(?:\s|=|>)/);
  assert.match(html, /data-settings-tab="schedule">Dienstplanung</);
  assert.match(html, /id="pdfTitleSetting"/);
  assert.match(html, /id="vacationPdfTitleSetting"/);
  assert.equal(
    (html.match(/class="settings-card pdf-card"/g) || []).length,
    2,
    "Dienstplan- und Urlaubs-PDF müssen als zwei eigene Karten im PDF-Accordion liegen",
  );
  assert.equal(
    (html.match(/class="pdf-settings-fields"/g) || []).length,
    2,
    "beide PDF-Karten brauchen einen vollbreiten inneren Einstellungsraster",
  );

  assert.match(styles, /\.settings-two-column \{[^}]*grid-auto-rows:\s*max-content;[^}]*align-items:\s*start;/);
  assert.match(styles, /\.settings-card \{[^}]*align-self:\s*start;[^}]*height:\s*auto;/);
  assert.match(styles, /\.settings-accordion-grid \{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\);[^}]*grid-auto-rows:\s*max-content;[^}]*align-items:\s*start;/);
  assert.match(
    styles,
    /\.settings-accordion-stack \{[^}]*grid-template-columns:\s*minmax\(0,1fr\);/,
    "der PDF-Accordion-Stack braucht eine explizite volle Spalte",
  );
  assert.match(
    styles,
    /\.settings-accordion-stack > \.settings-card \{[^}]*grid-column:\s*1 \/ -1;[^}]*min-width:\s*0;[^}]*width:\s*100%;/,
    "beide PDF-Karten müssen die volle Accordion-Breite belegen",
  );
  assert.match(
    styles,
    /\.pdf-card \{[^}]*grid-template-columns:\s*minmax\(0,1fr\);/,
    "PDF-Karten dürfen intern keine dauerhaft reservierte Vorschau-Spalte behalten",
  );
  assert.match(
    styles,
    /\.pdf-settings-fields \{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\);[^}]*width:\s*100%;/,
    "die PDF-Felder müssen die gesamte Kartenbreite als gleichmäßigen Raster nutzen",
  );
  assert.doesNotMatch(styles, /\.pdf-card > :not\(\.card-heading\):not\(\.pdf-live-preview\)/);
  assert.match(styles, /\.settings-packed-grid \{[^}]*grid-auto-flow:\s*row;[^}]*grid-auto-rows:\s*1px;[^}]*row-gap:\s*0;/);
  assert.match(app, /Math\.ceil\(item\.offsetHeight \+ 15\)/);
  assert.match(app, /new ResizeObserver/);
  assert.match(app, /function integrateSchedulePdfSettings\(\)[\s\S]*elements\.scheduleSettings\.append\(elements\.pdfSettings\)/);
  assert.match(app, /schedule:\s*settingsAccess \|\| scheduleSettingsAccess \|\| pdfSettingsAccess/);
  assert.match(app, /integratedTarget === "pdf" \? "schedule"/);
  assert.match(app, /canSaveScheduleSettings \|\| canSaveSchedulePdfSettings \|\| canSaveGeneralSettings/);
  assert.ok(
    app.indexOf("integrateSchedulePdfSettings();") < app.indexOf("initializeSettingsCardDisclosures();"),
    "PDF-Ausgabe muss vor der Accordion-Initialisierung an das Ende der Dienstplanung verschoben werden",
  );
  assert.match(styles, /\.schedule-settings-section > \.settings-field-disclosure > \.settings-field-disclosure-summary \{[^}]*padding:11px 13px;/);
  assert.match(styles, /@media \(max-width:\s*820px\)[\s\S]*?\.settings-accordion-grid \{ grid-template-columns:\s*1fr; \}/);
});

test("Urlaubsanzeige zieht österreichische Feiertage im gewählten Zeitraum immer ab", () => {
  const source = app.match(/function vacationDayCount\(dateFrom, dateTo\) \{[\s\S]*?\n\}/)?.[0] || "";
  const countVacationDays = new Function(
    "addDays",
    "vacationHolidayForDate",
    `${source}; return vacationDayCount;`,
  )(
    (isoDate, amount) => {
      const date = new Date(`${isoDate}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + amount);
      return date.toISOString().slice(0, 10);
    },
    (isoDate) => isoDate === "2026-08-15",
  );

  assert.equal(countVacationDays("2026-08-10", "2026-08-23"), 9);
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
