"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const catalogApi = require("../public/function-search-catalog");
const searchApi = require("../public/function-search");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const catalogSource = read("public/function-search-catalog.js");
const appSource = read("public/app.js");
const indexHtml = read("public/index.html");
const stylesSource = read("public/styles.css");
const serverSource = read("server.js");
const packageBuilder = read("server-tools/package/New-GrabenplanerLinuxServerPackage.ps1");
const persistenceAudit = read("scripts/audit-persistence-coupling.js");

const PORTAL_ROLES = Object.freeze([
  "employee",
  "location_planner",
  "department_manager",
  "manager",
  "hr",
  "admin",
  "it_admin",
  "developer",
]);
const ALL_GATE_IDS = new Set(catalogApi.FUNCTION_SEARCH_CATALOG.flatMap((item) => item.access.gateIds));
const FULL_ACCESS = Object.freeze({ authenticated: true, availableGateIds: ALL_GATE_IDS });

const FEATURE_CASES = Object.freeze([
  {
    id: "vacation",
    removedGateIds: ["vacationsNavButton", "centralVacationsNavButton", "settingsVacationTab"],
    hiddenEntryIds: [
      "personnel.central-vacations",
      "personnel.vacation-accounts",
      "settings.vacation-delegation",
      "settings.vacation-workflow",
      "vacation.approved-entry",
      "vacation.balance",
      "vacation.overview",
      "vacation.pdf",
      "vacation.request-blackouts",
    ],
  },
  {
    id: "requests",
    removedGateIds: ["requestsNavButton"],
    hiddenEntryIds: ["requests.amu", "requests.overview", "requests.time-off", "requests.vacation"],
  },
  {
    id: "employeePortal",
    removedGateIds: [
      "birthdayPresentationSettingsCard",
      "greetingSettingsCard",
      "mobilePortalLocationDisplayCard",
    ],
    hiddenEntryIds: [
      "settings.birthday-presentation",
      "settings.greetings",
      "settings.mobile-location-view",
    ],
  },
  {
    id: "timeTracking",
    removedGateIds: ["timeTrackingNavButton", "wifiSettingsCard"],
    hiddenEntryIds: [
      "settings.wifi",
      "time.corrections",
      "time.day-review",
      "time.live-presence",
      "time.monthly-records",
      "time.period-summary",
    ],
  },
  {
    id: "sicknessAmu",
    removedGateIds: ["requestAmuTab", "amuSettingsCard"],
    hiddenEntryIds: ["requests.amu", "settings.amu"],
  },
  {
    id: "wifiSuggestions",
    removedGateIds: ["wifiSettingsCard"],
    hiddenEntryIds: ["settings.wifi"],
  },
  {
    id: "integrations",
    removedGateIds: ["settingsIntegrationsTab"],
    hiddenEntryIds: [
      "settings.export-profiles",
      "settings.import-profiles",
      "settings.integration-connections",
      "settings.integration-contracts",
      "settings.integration-history",
      "settings.integration-information",
      "settings.payroll-export",
      "settings.payroll-handoffs",
      "settings.personnel-import",
    ],
  },
  {
    id: "loans",
    removedGateIds: ["loanManagementNavButton", "loanSettingsCard"],
    hiddenEntryIds: ["filial.loans", "settings.loans"],
  },
  {
    id: "personnelLifecycle",
    removedGateIds: ["candidatePreboardingNavButton", "workflowCenterNavButton", "personnelTasksNavButton"],
    hiddenEntryIds: [
      "personnel.applications",
      "personnel.lifecycle-automation",
      "personnel.lifecycle-editor",
      "personnel.lifecycle-interfaces",
      "personnel.tasks",
      "personnel.workflows",
    ],
  },
]);

function availableIds(availableGateIds) {
  return catalogApi.availableFunctionSearchEntries({
    authenticated: true,
    availableGateIds,
  }).map((item) => item.id);
}

test("Block 5: alle Portalrollen bleiben vollständig an die projizierten UI-Gates gebunden", () => {
  assert.equal(catalogApi.FUNCTION_SEARCH_CATALOG.length, 103);
  assert.equal(ALL_GATE_IDS.size, 99);
  assert.doesNotMatch(catalogSource, /options\?\.role|options\.role|role\s*===\s*["']/);
  assert.match(appSource, /isGateAvailable: functionSearchGateAvailable/);

  for (const role of PORTAL_ROLES) {
    assert.match(serverSource, new RegExp(`id:\\s*"${role}"`), role);
    assert.deepEqual(catalogApi.availableFunctionSearchEntries({ authenticated: true, role }), [], role);
    for (const item of catalogApi.FUNCTION_SEARCH_CATALOG) {
      assert.equal(catalogApi.functionSearchEntryIsAvailable(item, {
        authenticated: true,
        role,
        availableGateIds: item.access.gateIds,
      }), true, `${role}: ${item.id}`);
      for (const missingGateId of item.access.gateIds) {
        assert.equal(catalogApi.functionSearchEntryIsAvailable(item, {
          authenticated: true,
          role,
          availableGateIds: item.access.gateIds.filter((gateId) => gateId !== missingGateId),
        }), false, `${role}: ${item.id} ohne ${missingGateId}`);
      }
    }
  }
});

test("Block 5: jeder Installationsschalter entfernt exakt seine projizierten Suchziele", () => {
  assert.match(serverSource, /\{ id: "schedule", label: "Dienstplanung", required: true \}/);
  for (const feature of FEATURE_CASES) {
    assert.match(serverSource, new RegExp(`id:\\s*"${feature.id}"`), feature.id);
    const appFeaturePattern = ["loans", "personnelLifecycle"].includes(feature.id)
      ? new RegExp(`installationFeatures\\?\\.${feature.id}`)
      : new RegExp(`features\\.${feature.id}`);
    assert.match(appSource, appFeaturePattern, feature.id);
    const availableGateIds = new Set([...ALL_GATE_IDS]
      .filter((gateId) => !feature.removedGateIds.includes(gateId)));
    const remaining = new Set(availableIds(availableGateIds));
    const hidden = catalogApi.FUNCTION_SEARCH_CATALOG
      .map((item) => item.id)
      .filter((entryId) => !remaining.has(entryId))
      .sort();
    assert.deepEqual(hidden, feature.hiddenEntryIds.slice().sort(), feature.id);
  }
});

test("Block 5: jede eindeutige mehrteilige Zielphrase gewinnt auch im vollständigen Katalog", () => {
  const owners = new Map();
  for (const item of catalogApi.FUNCTION_SEARCH_CATALOG) {
    for (const synonym of item.synonyms) {
      const normalized = searchApi.normalizeFunctionSearchText(synonym);
      if (!owners.has(normalized)) owners.set(normalized, []);
      owners.get(normalized).push({ id: item.id, synonym });
    }
  }
  const precisePhrases = [...owners.entries()]
    .filter(([normalized, entries]) => normalized.includes(" ") && entries.length === 1)
    .map(([, entries]) => entries[0]);
  assert.ok(precisePhrases.length >= 170);
  for (const { id, synonym } of precisePhrases) {
    const result = searchApi.searchAvailableFunctions(synonym, FULL_ACCESS, { limit: 5 });
    assert.equal(result[0]?.id, id, `${id}: ${synonym}`);
  }
});

test("Block 5: sämtliche Aliasvarianten expandieren deterministisch in genau ihre Synonymgruppe", () => {
  let checkedTerms = 0;
  for (const group of searchApi.FUNCTION_SEARCH_ALIAS_GROUPS) {
    const expected = group.terms.map(searchApi.normalizeFunctionSearchText).sort();
    for (const term of group.terms) {
      const units = searchApi.expandedFunctionSearchQuery(term);
      assert.equal(units.length, 1, `${group.id}: ${term}`);
      assert.deepEqual(units[0].terms.slice().sort(), expected, `${group.id}: ${term}`);
      checkedTerms += 1;
    }
  }
  assert.ok(checkedTerms >= 225);
});

test("Block 5: Suchlänge, Suchbegriffe und Ergebniszahl bleiben hart begrenzt", () => {
  const oversizedQuery = "Urlaub und Dienstplan ".repeat(1000);
  assert.ok(searchApi.normalizeFunctionSearchText(oversizedQuery).length <= 640);
  assert.ok(searchApi.expandedFunctionSearchQuery(oversizedQuery).length <= 10);
  assert.equal(searchApi.searchAvailableFunctions("Einstellungen", FULL_ACCESS, {
    limit: 0,
    minimumScore: 0,
    minimumRelativeScore: 0,
  }).length, 1);
  assert.equal(searchApi.searchAvailableFunctions("Einstellungen", FULL_ACCESS, {
    limit: 999,
    minimumScore: 0,
    minimumRelativeScore: 0,
  }).length, 25);
});

test("Block 5: Tastatur-, Screenreader-, Mobile- und Bewegungsreduktion sind vollständig deklariert", () => {
  assert.match(indexHtml, /role="combobox"/);
  assert.match(indexHtml, /aria-haspopup="listbox"/);
  assert.match(indexHtml, /aria-keyshortcuts="Control\+K Meta\+K"/);
  assert.match(indexHtml, /aria-describedby="functionSearchHint"/);
  assert.match(indexHtml, /role="listbox" aria-label="Gefundene Funktionen"/);
  assert.match(indexHtml, /role="status" aria-live="polite"/);
  assert.match(stylesSource, /@media \(max-width: 820px\)[\s\S]*?\.function-search-option \{ min-height:54px;/);
  assert.match(stylesSource, /\.function-search-popover \{[^}]*overflow-x:hidden;[^}]*overflow-y:auto;[^}]*overscroll-behavior:contain;/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\) \{\s*\.function-search-target-highlight \{ animation:none; \}/);
});

test("Block 5: alle Suchmodule sind versionsgebunden, paketfähig und persistenzfrei klassifiziert", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.version, "0.92.24-beta");
  assert.match(read("README.md"), /v0\.92\.24 Beta/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.24 Beta · CRM, zentraler Artikelstamm und bearbeitbare Schnuppertermine/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.23 Beta · Persönliche Bewerbungsbewertungs-PDFs/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.22 Beta · Team-Bewerbungsbewertungen und Dienstplan-Einstellungen/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.21 Beta · Delegierbare AL-Grundrechte und optionale Positionszeile/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.20 Beta · Positionsverwaltung, Filialaufsicht und Dienstplansperre/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.19 Beta · Strukturierte Bewerberprofile und Schnuppertage/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.18 Beta · Filialbestellungen und bereichsgebundene Bewerberanlage/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.17 Beta · Sichtbare Einsätze in anderen Filialen/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.16 Beta · Präzisierte Wochenmatrix und standortübergreifende Einplanung/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.15 Beta · Anpassbare Wochenmatrix und Katalogsuche/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.14 Beta · Vollständige Bestellkatalog-Migration beim Serverstart/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.13 Beta · Konfigurierbare Startwidgets und kompakter Bestellkatalog/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.12 Beta · Dienstplan-PDFs, persönliches Startdashboard und Dienstsuche/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.11 Beta · Stabile Filialbestellungsverwaltung/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.10 Beta · Standortübergreifende Einsatzanfragen und Geburtstagsportal/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.9 Beta · Neustartsichere Schulungsbelege/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.8 Beta · Schulungsprozesse und Fähigkeitsprofile/);
  assert.match(read("VERSIONS-LOG.md"), /v0\.92\.7 Beta · Berechtigungsgefilterte Funktionssuche/);
  assert.equal(JSON.parse(read(".devcontainer/devcontainer.json")).name, "Grabenplaner v0.92.24 Codespaces-Demo");

  const runtimeFiles = [
    "public/function-search-catalog.js",
    "public/function-search.js",
    "public/function-search-ui.js",
    "public/function-search-navigation.js",
  ];
  runtimeFiles.forEach((relativePath) => assert.equal(fs.existsSync(path.join(root, relativePath)), true, relativePath));
  assert.match(packageBuilder, /git -C \$sourceRoot status --porcelain --untracked-files=all/);
  assert.match(packageBuilder, /git -C \$sourceRoot ls-files/);
  assert.match(packageBuilder, /StartsWith\('public\/'\)/);
  assert.match(packageBuilder, /files = \$manifestFiles/);

  const projectionStart = persistenceAudit.indexOf('id: "function-search-projection"');
  const projectionEnd = persistenceAudit.indexOf("    },", projectionStart);
  const projection = persistenceAudit.slice(projectionStart, projectionEnd);
  assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
  runtimeFiles.forEach((relativePath) => assert.match(projection, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
});
