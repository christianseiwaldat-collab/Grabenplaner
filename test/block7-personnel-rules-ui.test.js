"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const documentation = fs.readFileSync(
  path.join(root, "docs", "PERSONAL-REGELWERK-ABSCHLUSS-v0.1.md"),
  "utf8",
);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarke fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarke fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Block 7/7: FL/AL-Dashboard benennt Lesescope und enthält keine Governance-Bedienung", () => {
  const panel = between(
    html,
    '<section class="personnel-rules-dashboard-panel hidden" id="personnelRulesDashboardPanel"',
    '<section class="rights-dashboard-process-panel hidden"',
  );

  assert.match(panel, /Lesesicht &amp; Planvorschau/);
  assert.match(panel, /id="personnelRulesReadBoundary"/);
  assert.match(panel, /Bereichsbezogene Lesesicht/);
  assert.match(panel, /Nur lesen/);
  assert.match(panel, /Planvorschau/);
  assert.match(panel, /Keine Freigabe oder Änderung/);
  assert.match(panel, /Aktuelle, künftige und inaktive Bereiche/);
  assert.match(panel, /keine Rechtsberatung oder Rechtsfreigabe/i);
  assert.doesNotMatch(panel, /<form\b/i);
  assert.doesNotMatch(panel, /\bid="[^"]*(?:save|publish|approve|review|delete|edit|add)[^"]*"/i);
});

test("Block 7/7: Lesesicht und Planvorschau besitzen zugängliche Namen und Live-Status", () => {
  const panel = between(
    html,
    '<section class="personnel-rules-dashboard-panel hidden" id="personnelRulesDashboardPanel"',
    '<section class="rights-dashboard-process-panel hidden"',
  );
  const ids = [...panel.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

  assert.equal(new Set(ids).size, ids.length, "IDs innerhalb des Personal-Regelwerks müssen eindeutig sein");
  assert.match(panel, /id="personnelRulesScope" role="status"/);
  assert.match(panel, /id="personnelRulesAssignmentLegend"[^>]*aria-label="[^"]+"[^>]*aria-live="polite"/);
  assert.match(panel, /id="refreshPersonnelRulesDashboard"[^>]*aria-controls="personnelRulesDashboardPanel"[^>]*aria-describedby="personnelRulesReadBoundary"/);
  assert.match(panel, /id="personnelRulesSimulationHint" role="status"/);
  assert.match(panel, /id="runPersonnelRulesSimulation"[^>]*aria-controls="personnelRulesSimulationResult"[^>]*aria-describedby="personnelRulesSimulationTitle"/);
  assert.match(panel, /id="personnelRulesSimulationResult"[^>]*aria-live="polite"[^>]*aria-atomic="false"/);
  assert.match(app, /data-personnel-rules-profile=[\s\S]{0,500}aria-label="\$\{escapeHtmlAttribute\(accessibleName\)\}"/);
  assert.match(app, /const versionLabel = profile\.version \? `Version \$\{profile\.version\}` : "Fassung ohne Versionsangabe"/);
  assert.match(app, /accessibleName = `\$\{profile\.title\}, \$\{profile\.layerLabel \|\| "Regelprofil"\}, \$\{versionLabel\}/);
  assert.match(app, /personnel-rules-assignment-state" aria-hidden="true"/);
});

test("Block 7/7: Dashboard bleibt auf Lesen und unverändernde Vorschau begrenzt", () => {
  const accessFunction = between(
    app,
    "function canReadPersonnelRulesDashboard()",
    "function accessibleDashboardModes()",
  );
  const dashboardFunctions = between(
    app,
    "function personnelRulesProfiles()",
    "function rightsProcessDashboard()",
  );

  assert.match(accessFunction, /permissions \|\| \[\]\)\.includes\("work_rules:read"\)/);
  assert.doesNotMatch(accessFunction, /work_rules:(?:draft|review|publish|assign|manage)/);
  assert.match(dashboardFunctions, /api\("\/api\/work-rules\/dashboard"\)/);
  assert.match(dashboardFunctions, /api\("\/api\/work-rules\/evaluate"/);
  assert.match(dashboardFunctions, /targetType: "planned_schedule"/);
  assert.match(dashboardFunctions, /preview: true/);
  assert.doesNotMatch(dashboardFunctions, /\/api\/work-rules\/(?:governance|drafts|assignments)/);
  assert.doesNotMatch(dashboardFunctions, /\/api\/collective-agreements/);
});

test("Block 7/7: AL-Planvorschau bietet keinen unzulässigen Filial-Gesamtscope an", () => {
  const controls = between(
    app,
    "function updatePersonnelRulesSimulationDepartments()",
    "function renderPersonnelRulesSimulation()",
  );

  assert.match(controls, /selectedLocation\?\.canSimulateWholeLocation !== false/);
  assert.match(controls, /canSimulateWholeLocation \? \['<option value=\"\">Gesamte Filiale<\/option>'\] : \[\]/);
  assert.match(controls, /canSimulateWholeLocation \? \"\" : String\(departments\[0\]\?\.id \|\| \"\"\)/);
  assert.match(controls, /hasVisibleSimulationScope/);
});

test("Block 7/7: unsichtbare aktuelle KV-Fassung wird nicht durch Historie vorgetäuscht", () => {
  const list = between(
    app,
    "function renderCollectiveAgreementList(registry)",
    "function collectiveAgreementDefinitionList(version)",
  );
  const detail = between(
    app,
    "function renderCollectiveAgreementDetail(registry)",
    "function renderCollectiveAgreementBusinessUnits(registry)",
  );

  assert.match(list, /const current = agreement\.versions\.find\([^;]+ \|\| null;/);
  assert.match(list, /zugeordnete historische Fassung/);
  assert.match(detail, /Der aktuelle Registerstand ist in dieser bereichsbezogenen Lesesicht nicht sichtbar/);
  assert.match(detail, /Zugeordnete historische Fassung/);
});

test("Block 7/7: Zuordnungsstände werden mit Text, Struktur und responsiven Farben unterschieden", () => {
  assert.match(app, /current: "Aktuell wirksam"/);
  assert.match(app, /future: "Künftig"/);
  assert.match(app, /expired: "Abgelaufen"/);
  assert.match(app, /inactive: "Inaktiv"/);
  assert.match(app, /"Inaktiv oder abgelaufen"[\s\S]{0,120}"Die Zuordnung hat heute keine Planwirkung\."/);
  assert.match(app, /personnel-rules-assignment-badges/);
  assert.match(styles, /\.personnel-rules-assignment-legend\s*\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.personnel-rules-assignment-badge\.current\s*\{[^}]*var\(--rd-good\)/);
  assert.match(styles, /\.personnel-rules-assignment-badge\.future\s*\{[^}]*var\(--rd-warning\)/);
  assert.match(styles, /\.personnel-rules-assignment-badge:is\(\.inactive,\.expired\)/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.personnel-rules-assignment-legend[\s\S]*grid-template-columns:1fr/);
});

test("Block 7/7: neue Flächen folgen Dark-Mode-, Fokus- und Responsive-System", () => {
  assert.match(styles, /\.rights-dashboard\[data-dashboard-theme="dark"\]\s*\{/);
  assert.match(styles, /\.personnel-rules-read-boundary\s*\{[^}]*var\(--rd-accent\)[^}]*var\(--rd-line\)/);
  assert.match(styles, /\.personnel-rules-read-boundary-badges span\s*\{[^}]*var\(--rd-surface\)/);
  assert.match(styles, /\.personnel-rules-source-list a:focus-visible/);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*\.personnel-rules-read-boundary/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.personnel-rules-read-boundary-badges/);
});

test("Block 7/7: Abschlussdokumentation hält Rechte- und Rechtsgrenze fest", () => {
  assert.match(documentation, /benötigt ausschließlich `work_rules:read`/);
  assert.match(documentation, /keine Schreib-, Veröffentlichungs-, Freigabe- oder Zuordnungsfunktion/);
  assert.match(documentation, /Auch ein unauffälliges oder grünes Prüfergebnis ist keine Rechtsfreigabe/);
  assert.match(documentation, /\| Künftig \| zeitlich noch nicht wirksame Zuordnung/);
  assert.doesNotMatch(documentation, /\| Künftig \| aktive und freigegebene Zuordnung/);
  assert.match(documentation, /Betriebsübernahme[\s\S]*Sicherungs-, Migrations- und Gesundheitsprüfungen/);
  assert.match(documentation, /nicht Bestandteil dieser fachlichen Block-Abnahme[\s\S]*eigener kontrollierter Rollout/);
});

test("Block 7/7: UI-Artefakte bleiben UTF-8-sauber und HTML-IDs eindeutig", () => {
  for (const [name, content] of Object.entries({
    "index.html": html,
    "app.js": app,
    "styles.css": styles,
    "Abschlussdokumentation": documentation,
  })) {
    assert.doesNotMatch(content, /[\u00c3\u00c2]|\u00e2[\u0080-\u00bf]/u, `${name} enthält mögliches Mojibake`);
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, []);
});
