"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("UI Block 1: Personalverwaltung trennt Dashboard-Ziel und Disclosure semantisch", () => {
  const navigation = between(
    html,
    '<section class="nav-module hidden" id="personnelAdministrationNav"',
    '<div class="nav-module-children" id="personnelAdministrationNavChildren">',
  );
  assert.match(navigation, /<button(?=[^>]*id="personnelAdministrationToggle")(?=[^>]*class="nav-disclosure expanded")(?=[^>]*data-nav-toggle="personnelAdministration")[^>]*>/);
  assert.match(navigation, /<button(?=[^>]*id="personnelDashboardNavButton")(?=[^>]*data-view="personnelAdministration")(?=[^>]*data-personnel-administration-route="dashboard")[^>]*>/);
  assert.ok(navigation.indexOf("</button>") < navigation.indexOf("personnelDashboardNavButton"), "Disclosure und Navigationsziel dürfen nicht ineinander verschachtelt sein");
  assert.match(app, /personnelAdministrationTab:\s*"dashboard"/);
  assert.match(app, /\["dashboard", "employees", "applications", "workflows", "learning", "tasks", "costCenters", "ruleDrafts", "collectiveAgreements", "vacations"\]\.includes\(requestedSection\)/);
});

test("UI Block 1: Dashboard ist persönlich anpassbar und zeigt nur erlaubte Arbeitsbereiche", () => {
  const section = between(
    html,
    '<section class="personnel-administration-section personnel-dashboard-section active"',
    '<div class="settings-tabs personnel-administration-tabs"',
  );
  for (const id of [
    "personnelDashboardGrid",
    "personnelDashboardCustomizeButton",
    "personnelDashboardCustomizer",
    "personnelDashboardCustomizerList",
    "resetPersonnelDashboardLayout",
    "savePersonnelDashboardLayout",
  ]) assert.match(section, new RegExp(`id="${id}"`));
  assert.doesNotMatch(section, /Onboarding|Offboarding|Eintritt|Austritt/i);

  const catalog = between(app, "function personnelDashboardCatalog()", "function orderedPersonnelDashboardItems");
  for (const id of ["employees", "applications", "workflows", "tasks", "requests", "timeTracking", "costCenters", "ruleDrafts", "collectiveAgreements", "vacations", "dataRequests"]) {
    assert.match(catalog, new RegExp(`id:\\s*"${id}"`));
  }
  for (const helper of [
    "canReadCentralPersonnel",
    "canReadCandidatePreboarding",
    "canOpenWorkflowCenter",
    "canReadPersonnelTasks",
    "canReadManagerRequests",
    "canReadManagedTimeTracking",
    "canReadCostCenters",
    "canAccessCustomWorkRuleGovernance",
    "canReadCollectiveAgreements",
    "canReadCentralVacations",
    "canReadDataSubjectRequests",
  ]) assert.match(catalog, new RegExp(`${helper}\\(\\)`));
  assert.match(app, /filter\(\(item\) => item\?\.available\)/);
  assert.match(app, /persistPersonnelDashboardLayout/);
  assert.match(app, /personnel-dashboard-layout-v1/);
});

test("UI Block 1: Präferenz nutzt den bestehenden UI-Pfad ohne neue Datenbankkopplung", () => {
  const readPreferences = between(
    server,
    "async function uiPreferencesForActor(actor, overrides = {})",
    "async function saveUiPreferencesForActor(actor, input = {})",
  );
  const savePreferences = between(
    server,
    "async function saveUiPreferencesForActor(actor, input = {})",
    "async function rightsDashboardThemeForActor(actor)",
  );
  assert.match(readPreferences, /await uiPreferencesRepository\.list\(actor\.employeeNumber\)/);
  assert.match(savePreferences, /uiPreferencesRepository\.saveChanges\(actor\.employeeNumber/);
  assert.match(savePreferences, /preferenceKey: "personnel_dashboard_layout_v1"/);
  assert.doesNotMatch(`${readPreferences}\n${savePreferences}`, /\bdb\.(?:prepare|exec)\b|portal_user_preferences|store\.run/);
  assert.match(server, /function validatePersonnelDashboardLayout\(value\)/);
  assert.match(server, /personnelDashboardLayout,/);
  assert.match(app, /api\("\/api\/portal\/v1\/ui-preferences",\s*\{[\s\S]*?personnelDashboardLayout: normalized/);
});

test("UI Block 1: schmale Ansichten verwenden einen vertikalen, zugänglichen Drawer", () => {
  assert.match(html, /id="mobileNavigationToggle"[^>]*aria-controls="mainSidebar"[^>]*aria-expanded="false"/);
  assert.match(html, /id="mainSidebar"/);
  assert.match(html, /id="mobileNavigationBackdrop"/);
  assert.match(styles, /@media \(max-width: 820px\) \{[\s\S]*?\.sidebar \{[^}]*position:fixed;[^}]*transform:translateX\(-105%\);/);
  assert.match(styles, /@media \(max-width: 820px\) \{[\s\S]*?\.main-nav \{[^}]*display:grid;[^}]*overflow-x:clip;[^}]*overflow-y:auto;/);
  assert.doesNotMatch(styles, /@media \(max-width: 820px\) \{[\s\S]*?\.main-nav \{[^}]*overflow-x:auto;/);
  assert.match(app, /function openMobileNavigation\(\)/);
  assert.match(app, /function closeMobileNavigation\(\{ restoreFocus = true \} = \{\}\)/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /mobileNavigationPreviousFocus/);
  assert.match(app, /elements\.mainSidebar\.inert = true/);
});

test("Startdashboard: drei Hauptgruppen navigieren und zeigen nur freigegebene persönliche Inhalte", () => {
  const section = between(
    html,
    '<section id="startDashboardView"',
    '<section id="filialAdministrationView"',
  );
  for (const [label, target] of [
    ["Filialverwaltung", "filialAdministration"],
    ["Personalverwaltung", "personnelAdministration"],
    ["Verkaufsverwaltung", "salesAdministration"],
  ]) {
    assert.match(section, new RegExp(`data-start-dashboard-view="${target}"[\\s\\S]{0,240}<strong>${label}<\\/strong>`));
  }
  for (const id of [
    "startDashboardLocation",
    "startDashboardDepartment",
    "startDashboardPreviousLocation",
    "startDashboardNextLocation",
    "startDashboardLocationPosition",
    "startDashboardOnDuty",
    "startDashboardAbsences",
    "startDashboardPersonnelTeam",
    "startDashboardPersonnelRequests",
    "startDashboardSalesLocation",
    "startDashboardPreviousSalesLocation",
    "startDashboardNextSalesLocation",
    "startDashboardSalesLocationPosition",
    "startDashboardSalesKpis",
    "startDashboardSalesTopGroups",
    "startDashboardScheduleSummary",
    "startDashboardVacationSummary",
    "startDashboardLoanSummary",
    "startDashboardBranchOrdersSummary",
  ]) assert.match(section, new RegExp(`id="${id}"`));
  for (const cardId of ["schedule", "vacation", "loans", "branchOrders", "personnel", "sales"]) {
    assert.match(section, new RegExp(`data-start-dashboard-card="${cardId}"`));
  }
  assert.match(app, /function renderStartDashboard\(\)/);
  assert.match(app, /canOpenPersonnelAdministrationModule\(\)/);
  assert.match(app, /canAccessSalesAnalytics\(\)/);
  assert.match(app, /\/api\/schedule\?/);
  assert.match(app, /\/api\/sales-analytics\/reports\?limit=100/);
  assert.match(app, /start-dashboard-preferences-v3/);
  assert.match(server, /preferenceKey: "start_dashboard_preferences_v3"/);
  assert.match(app, /function navigateFromStartDashboardCard\(button\)/);
  assert.match(app, /function cycleStartDashboardLocation\(direction\)/);
  assert.match(app, /function cycleStartDashboardSalesLocation\(direction\)/);
  assert.match(app, /state\.startDashboardScopeSaving/);
  assert.match(app, /loadAll\(\{ restoreContext: false \}\)/);
  assert.match(app, /data-start-dashboard-card-move/);
  assert.match(app, /data-start-dashboard-group-size/);
  assert.match(app, /data-start-dashboard-widget-choice/);
  assert.match(app, /groupSizes: Object\.fromEntries/);
  assert.match(server, /function validateStartDashboardPreferences\(value\)/);
  assert.doesNotMatch(server, /installationFeatureCatalog[\s\S]{0,400}sales:analytics/);
  assert.match(styles, /\.start-dashboard-scope-switcher \{[^}]*grid-template-columns:36px minmax\(0,1fr\) 36px;/);
  assert.match(styles, /\.start-dashboard-group\[data-start-dashboard-size="compact"\] \{ grid-column:span 3; \}/);
  assert.match(styles, /\.start-dashboard-group\[data-start-dashboard-size="full"\] \{ grid-column:1 \/ -1; \}/);
  assert.match(styles, /@media \(max-width:760px\) \{[\s\S]*?\.start-dashboard-group\[data-start-dashboard-size\] \{ grid-column:1; \}[\s\S]*?\.start-dashboard-scope-controls \{ grid-template-columns:1fr; \}/);
});

test("Verkaufsanalyse: Archiv, Sortierung, Grafikvarianten und PDF-Export sind integriert", () => {
  const section = between(
    html,
    '<section id="salesAnalyticsView"',
    '<section id="personnelView"',
  );
  assert.doesNotMatch(section, /Aufgearbeitete TradeFoto-Berichte/);
  assert.match(section, /Der Warengruppenvergleich wird als strukturierter/);
  assert.doesNotMatch(section, /id="salesReportTableSort"/);
  assert.match(section, /id="salesReportChartType"[\s\S]*?value="ranking"[\s\S]*?value="change"[\s\S]*?value="share"/);
  assert.match(section, /id="salesReportChartPdfButton"/);
  assert.match(section, /<details class="sales-analytics-archive" id="salesReportArchive"/);
  assert.ok(section.indexOf('id="salesReportArchive"') > section.indexOf('id="salesReportTableBody"'));
  assert.match(app, /function changeSalesAnalyticsTableSort\(key, hasGrossMargin\)/);
  assert.match(app, /data-sales-table-sort/);
  assert.match(app, /function downloadSalesAnalyticsChartsPdf\(\)/);
  assert.match(server, /app\.post\("\/api\/sales-analytics\/charts\.pdf"/);
  assert.match(server, /salesAnalyticsRequestContext\(request, \{ csrf: true \}\)/);
  assert.match(server, /projectedSalesAnalyticsChartsPdfData/);
  assert.match(server, /sales\.report\.charts\.export/);
  assert.match(server, /Cache-Control", "private, no-store"/);
});
