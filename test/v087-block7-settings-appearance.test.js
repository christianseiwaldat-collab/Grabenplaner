const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const projectRoot = path.resolve(__dirname, "..");

test("v0.87 Block 7: Grundeinstellungen verwenden Accordions und eine globale numerische Schriftvorschau", () => {
  const html = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.doesNotMatch(html, /data-settings-tab="(?:branding|pdf)"/);
  assert.doesNotMatch(html, /id="operationModeSettingsCard"|name="operationMode"/);
  assert.doesNotMatch(script, /\/api\/operation-mode|desiredOperationMode|saveOperationMode/);

  for (const id of ["loanSettingsCard", "brandingSettings", "pdfSettings"]) {
    assert.match(html, new RegExp(`<details[^>]+id="${id}"`));
    assert.doesNotMatch(html, new RegExp(`<details[^>]+id="${id}"[^>]*\\sopen(?:\\s|=|>)`));
  }
  assert.ok(html.indexOf('id="loanSettingsCard"') < html.indexOf('id="brandingSettings"'));
  assert.match(script, /function integrateSchedulePdfSettings\(\)[\s\S]*elements\.scheduleSettings\.append\(elements\.pdfSettings\)/);
  assert.ok(script.indexOf("integrateSchedulePdfSettings();") < script.indexOf("initializeSettingsCardDisclosures();"));
  const viewSettingsMarkup = html.slice(
    html.indexOf('id="viewBehaviorSettingsCard"'),
    html.indexOf('id="loanSettingsCard"'),
  );
  assert.match(viewSettingsMarkup, /id="toastDuration"/);
  assert.match(viewSettingsMarkup, /id="decreaseAppFontScale"/);
  assert.match(viewSettingsMarkup, /id="appFontScalePercent"[^>]+min="75"[^>]+max="150"[^>]+step="5"/);
  assert.match(viewSettingsMarkup, /id="increaseAppFontScale"/);
  assert.match(viewSettingsMarkup, /sofort[\s\S]*Vorschau[\s\S]*erst mit „Einstellungen speichern“/);

  assert.match(script, /--app-font-scale/);
  assert.match(script, /--app-font-scale-inverse/);
  assert.doesNotMatch(script, /--app-font-scale-(?:width|min-height)/);
  assert.match(script, /state\.persistedAppFontScalePercent/);
  assert.match(script, /const saveFont = !silent && canSaveGeneralSettings && elements\.appFontScalePercent;/);
  assert.match(script, /const saveBranding = !silent && canSaveBranding && state\.brandingFormDirty;/);
  assert.match(styles, /body\s*\{[^}]*font-family:[^;}]*sans-serif[^}]*zoom:\s*var\(--app-font-scale\)/);
  assert.match(styles, /min-width:\s*calc\(320px \* var\(--app-font-scale-inverse\)\)/);
  assert.match(styles, /\.settings-two-column\s*\{[^}]*grid-auto-rows:\s*max-content[^}]*align-items:\s*start/);
  assert.match(styles, /\.settings-accordion-grid\s*\{[^}]*grid-auto-rows:\s*max-content[^}]*align-items:\s*start/);
  assert.match(styles, /\.settings-packed-grid\s*\{[^}]*grid-auto-flow:\s*row[^}]*grid-auto-rows:\s*1px/);
  assert.match(script, /function applyAppFontScalePercent[\s\S]*?scheduleAllSettingsPackedGrids\(\);[\s\S]*?return normalized;/);
  assert.doesNotMatch(styles, /--app-font-scale-(?:width|min-height)/);

  assert.match(html, /id="sidebarSessionInfo"[\s\S]*id="sidebarDarkmodeToggle"[\s\S]*role="switch"/);
  assert.match(script, /darkmodeToggle\.setAttribute\("aria-checked", String\(enabled\)\)/);
  assert.match(styles, /\.view \.page-theme-switch \{ display:none !important; \}/);
  assert.match(script, /function applyGlobalTheme\(theme\)[\s\S]*for \(const view of UI_APPEARANCE_VIEWS\) applyPageTheme\(view, normalized\)/);
  assert.match(script, /pageThemes: Object\.fromEntries\(UI_APPEARANCE_VIEWS\.map\(\(view\) => \[view, normalized\]\)\)/);
  assert.doesNotMatch(script, /querySelectorAll\("button\[data-page-theme-choice\]"\)\.forEach\(\(button\) => button\.addEventListener/);

  assert.doesNotMatch(html, /data-settings-tab="usbProvisioning"/);
  assert.doesNotMatch(script, /Lokale Altinstallation auf USB-Stick/);
  assert.match(html, /id="databaseImportSettings"[\s\S]*<strong>Datenbankimporte<\/strong>/);
  assert.match(script, /function initializeSettingsCardDisclosures\(\)[\s\S]*settings-field-disclosure-chevron[\s\S]*chevron\.textContent = "›"/);
  assert.ok(script.indexOf("integratePersonnelSettings();") < script.indexOf("initializeSettingsCardDisclosures();"));
  assert.match(styles, /\.portal-active input\[type="checkbox"\] \{ width:18px; min-width:18px; height:18px; min-height:18px/);
  assert.match(styles, /\.portal-user-controls \{ display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("immutable historical legacy font/settings migration", { timeout: 210000 }, () => require("../test-support/historical-server-tests").runHistoricalServerTest("test/v087-block7-settings-appearance.test.js"));
