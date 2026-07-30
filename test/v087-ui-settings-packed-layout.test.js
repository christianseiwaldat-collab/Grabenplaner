const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("UI-Block 2: alle Einstellungshauptbereiche verwenden das globale adaptive Raster", () => {
  const settingsSections = [...html.matchAll(
    /<section id="[^"]+Settings" class="settings-section ([^"]+)"/g,
  )];
  assert.ok(settingsSections.length >= 9, "die Einstellungsbereiche müssen im Markup auffindbar sein");
  for (const section of settingsSections) {
    assert.match(section[1], /\bsettings-two-column\b/);
  }

  assert.match(
    app,
    /const SETTINGS_PACKED_GRID_SELECTOR = "#settingsView \.settings-two-column, #settingsView \.settings-accordion-grid";/,
  );
  assert.match(app, /directSettingsPackedItems\(grid\)[\s\S]*?grid\.children/);
  assert.match(app, /item\.matches\("\.settings-card, \.settings-accordion"\)/);
});

test("UI-Block 2: Höhen werden zoombeständig gemessen und ohne visuelle Neuordnung gepackt", () => {
  const packedRule = styles.match(/\.settings-packed-grid \{[^}]+\}/)?.[0] || "";
  assert.match(packedRule, /grid-auto-flow:\s*row;/);
  assert.doesNotMatch(packedRule, /\bdense\b/);
  assert.match(packedRule, /grid-auto-rows:\s*1px;/);
  assert.match(packedRule, /column-gap:\s*var\(--settings-grid-gap\);/);
  assert.match(packedRule, /row-gap:\s*0;/);
  assert.match(packedRule, /margin-bottom:\s*calc\(-1 \* var\(--settings-grid-gap\)\);/);

  assert.match(app, /Math\.ceil\(item\.offsetHeight \+ 15\)/);
  assert.doesNotMatch(app, /getBoundingClientRect\(\)\.height \+ 15/);
  assert.match(app, /const columnEnds = \[1, 1\]/);
  assert.match(app, /const columnIndex = columnEnds\[0\] <= columnEnds\[1\] \? 0 : 1/);
  assert.match(app, /--settings-grid-column/);
  assert.match(app, /--settings-grid-row-start/);
  assert.match(styles, /grid-column-start:\s*var\(--settings-grid-column,auto\);/);
  assert.match(styles, /grid-row-start:\s*var\(--settings-grid-row-start,auto\);/);
  assert.match(styles, /grid-row-end:\s*span var\(--settings-grid-row-span,1\);/);
  assert.match(
    styles,
    /\.settings-packed-grid > \.settings-card\.full-span,[\s\S]*?\.settings-packed-grid > \.settings-accordion\.full-settings-card \{ grid-column:\s*1 \/ -1; \}/,
  );
});

test("UI-Block 2: dynamische Inhalte, Accordions, Tabs und Schriftgröße lösen Neuvermessung aus", () => {
  assert.match(app, /if \(typeof ResizeObserver !== "function"\) return;/);
  assert.match(app, /settingsPackedResizeObserver = new ResizeObserver/);
  assert.match(app, /settingsPackedMutationObserver = new MutationObserver/);
  assert.match(app, /attributeFilter:\s*\["class", "open"\]/);
  assert.match(app, /settingsPackedGridFrame = requestAnimationFrame/);
  assert.match(app, /document\.fonts\?\.ready\?\.then\(scheduleAllSettingsPackedGrids\)/);
  assert.match(app, /function setSettingsTab[\s\S]*?scheduleAllSettingsPackedGrids\(\);\s*\}/);
  assert.match(app, /function applyAppFontScalePercent[\s\S]*?scheduleAllSettingsPackedGrids\(\);[\s\S]*?return normalized;/);
});

test("UI-Block 2: unter 821 Pixeln bleibt die sichere einspaltige Darstellung aktiv", () => {
  assert.match(app, /window\.matchMedia\("\(min-width: 821px\)"\)/);
  assert.match(app, /settingsPackedGrids\(\)\.forEach\(resetSettingsPackedGrid\)/);
  assert.match(
    styles,
    /@media \(max-width:\s*820px\)[\s\S]*?\.settings-two-column\.active \{ display:\s*block; \}[\s\S]*?\.settings-packed-grid \{ grid-auto-rows:\s*max-content; row-gap:\s*15px; margin-bottom:\s*0; \}/,
  );
});
