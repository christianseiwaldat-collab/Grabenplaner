const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const portalStyles = fs.readFileSync(path.join(root, "public", "portal.css"), "utf8");

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || "";
}

test("Admin-Pop-ups kapseln horizontales Überlaufen am Dialog und Formular", () => {
  const dialogs = [...html.matchAll(/<dialog\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(dialogs.length >= 20, "Die erwarteten Admin-Dialoge wurden nicht gefunden.");
  dialogs.forEach((dialog) => assert.match(dialog, /class="[^"]*\bmodal\b/));

  assert.match(cssRule(".modal"), /container-name:popup/);
  assert.match(cssRule(".modal"), /overflow:hidden/);
  assert.match(styles, /\.modal form\s*\{[^}]*overflow-x:hidden[^}]*overflow-y:auto/);
  assert.match(cssRule(".modal-actions"), /position:sticky/);
  assert.match(cssRule(".modal-actions"), /background:linear-gradient\(transparent,var\(--modal-surface\)/);
  assert.doesNotMatch(styles, /\.employee-modal\s*\{[^}]*overflow:auto/);
  assert.doesNotMatch(styles, /\.custom-process-modal\s*\{[^}]*overflow:auto/);
});

test("Standort-Pop-up nutzt auf 4K vier, auf Full HD zwei und mobil eine Spalte", () => {
  assert.match(styles, /\.modal\.location-editor-modal\s*\{\s*width:\s*min\(1120px,calc\(100vw - 28px\)\)/);
  assert.match(styles, /@media \(min-width:2400px\)[\s\S]*\.modal\.location-editor-modal[\s\S]*width:min\(2200px,calc\(100vw - 80px\)\)/);
  assert.match(styles, /\.time-tracking-location-settings\s*\{[^}]*grid-template-areas:"access variance" "networks networks"[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /@container popup \(min-width:1200px\)[\s\S]*grid-template-areas:"access networks networks variance"[\s\S]*repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.personnel-record-modal \.personnel-record-field-grid,[\s\S]*\.custom-process-modal \.custom-process-step-fields\s*\{\s*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.personnel-record-modal \.personnel-record-span-two\s*\{\s*grid-column:span 2/);
  assert.match(html, /class="field modal-span-2"[^>]*><span>Name<\/span>/);
  assert.match(html, /class="field modal-span-3"[^>]*><span>Beschreibung<\/span><textarea id="customProcessDescription"/);
  assert.match(styles, /@media \(max-width:760px\)[\s\S]*grid-template-columns:1fr/);

  const actions = cssRule(".location-modal-actions");
  assert.doesNotMatch(actions, /margin-(?:left|right):\s*-/);
});

test("Öffnungszeiten werden auf schmalen Pop-ups zu Karten statt zu einer breiten Tabelle", () => {
  assert.match(styles, /@media \(max-width:920px\)[\s\S]*\.day-settings-head\s*\{\s*display:none/);
  assert.match(styles, /\.day-settings-row\s*\{[^}]*grid-template-areas:"day day" "service lunch" "minimum period"[^}]*min-width:0/);
  assert.match(styles, /@media \(max-width:760px\)[\s\S]*grid-template-areas:"day" "service" "lunch" "minimum" "period"/);
});

test("Mitarbeiterportal-Dialoge bleiben ebenfalls horizontal gekapselt", () => {
  assert.match(portalStyles, /dialog form\s*\{[^}]*min-width:0[^}]*max-width:100%[^}]*overflow-x:hidden[^}]*overflow-y:auto/);
  assert.match(portalStyles, /\.dialog-actions\s*\{[^}]*flex-wrap:wrap[^}]*max-width:100%/);
});
