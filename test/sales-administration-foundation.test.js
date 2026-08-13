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
const contract = fs.readFileSync(path.join(root, "docs", "VERKAUFSVERWALTUNG-FUNDAMENT-v0.1.md"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Verkaufsverwaltung ist ein fester Hauptbereich mit erstem Unterpunkt", () => {
  const navigation = between(
    html,
    '<section class="nav-module hidden" id="salesAdministrationNav"',
    "</nav>",
  );
  assert.match(navigation, /id="salesAdministrationToggle"[^>]*data-nav-toggle="salesAdministration"[^>]*aria-controls="salesAdministrationNavChildren"/);
  assert.match(navigation, /<span>Verkaufsverwaltung<\/span>/);
  assert.match(navigation, /<button(?=[^>]*id="salesDashboardNavButton")(?=[^>]*data-view="salesAdministration")[^>]*>/);
  assert.match(navigation, /<button(?=[^>]*id="salesAnalyticsNavButton")(?=[^>]*data-view="salesAnalytics")[^>]*>/);
  assert.match(navigation, /<span>Verkaufsanalysen<\/span>/);
  assert.ok(html.indexOf("personnelAdministrationNav") < html.indexOf("salesAdministrationNav"));
});

test("Verkaufsverwaltung bleibt außerhalb des optionalen Installationskatalogs", () => {
  const featureCatalog = between(
    server,
    "const installationFeatureCatalog = Object.freeze([",
    "const installationFeatureIds",
  );
  assert.doesNotMatch(featureCatalog, /sales|verkauf/i);

  const permissionCatalog = between(
    server,
    "const delegablePortalPermissionCatalog = Object.freeze([",
    "const delegablePortalPermissions",
  );
  assert.match(permissionCatalog, /id: SALES_ANALYTICS_PERMISSIONS\.ACCESS/);
  assert.match(permissionCatalog, /group: "Verkaufsverwaltung"/);

  const builtinRoles = between(server, "const builtinPortalRoles = [", "const adminPortalRole");
  assert.doesNotMatch(builtinRoles, /sales:analytics:access/);
});

test("Navigation und Direktaufruf bleiben ohne Zugangsrecht fail-closed", () => {
  const accessHelper = between(app, "function canAccessSalesAnalytics()", "function canReadVacationAccounts()");
  assert.match(accessHelper, /user\?\.salesAnalytics\?\.workspace === true/);

  const visibility = between(app, "function applyRoleVisibility()", "async function bootstrapApplication()");
  assert.match(visibility, /salesAdministrationNav\?\.classList\.toggle\("hidden", !salesAnalyticsAccess\)/);
  assert.match(visibility, /salesAnalyticsNavButton\?\.classList\.toggle\("hidden", !salesAnalyticsAccess\)/);
  assert.match(visibility, /!salesAnalyticsAccess && state\.currentView === "salesAnalytics"/);

  const groups = between(app, "function navigationGroups()", "function setNavigationCurrent");
  assert.match(groups, /salesAdministration:\s*\{\s*toggle:\s*elements\.salesAdministrationToggle,\s*children:\s*elements\.salesAdministrationNavChildren\s*\}/);

  const viewSwitch = between(app, "function setView(view)", "function applyRequestedView()");
  assert.match(viewSwitch, /view === "salesAdministration" && !canAccessSalesAnalytics\(\)/);
  assert.match(viewSwitch, /view === "salesAnalytics" && !canAccessSalesAnalytics\(\)/);
  assert.match(viewSwitch, /salesAdministrationView\?\.classList\.toggle\("active", view === "salesAdministration"\)/);
  assert.match(viewSwitch, /salesAnalyticsView\?\.classList\.toggle\("active", view === "salesAnalytics"\)/);

  const requestedView = between(app, "function applyRequestedView()", "function setSettingsTab");
  assert.match(requestedView, /"salesAnalytics"/);
});

test("Fest integrierter Verkaufsbereich bleibt eine klar gekennzeichnete Desktop-Arbeitsfläche", () => {
  const landing = between(html, '<section id="salesAdministrationView"', '<section id="salesAnalyticsView"');
  assert.match(landing, /Verkaufsverwaltung im Überblick/);
  assert.match(landing, /class="personnel-dashboard-card"[^>]*data-view="salesAnalytics"/);
  assert.match(landing, />Verkaufsanalysen</);

  const view = between(html, '<section id="salesAnalyticsView"', '<section id="personnelView"');
  assert.match(view, /id="salesAnalyticsTitle">Verkaufsanalysen/);
  assert.match(view, /TradeFoto-PDF-Statistiken sicher erkennen und auswerten/);
  assert.match(view, /Desktop für Tabellen und Grafiken/);
  assert.match(view, /id="salesReportImportFile"[^>]*accept="application\/pdf,.pdf"/);
  assert.match(view, /id="salesReportImportConfirmed"/);
  assert.match(view, /Die PDF selbst wird nach der .* nicht gespeichert/);
  assert.match(view, /<table\b/);
  assert.doesNotMatch(view, /sales.*mobile|mobile.*sales/i);

  assert.match(styles, /\.sales-analytics-topbar,\.sales-analytics-desktop-workspace \{ min-width:1120px; \}/);
  assert.match(contract, /nicht als optionales Installationsmerkmal/);
  assert.match(contract, /keine[\s\S]*mobile Fachansicht oder mobile Abnahme/);
  assert.match(contract, /keine[\s\S]*API-Endpunkte, Migrationen oder Hintergrundverarbeitung/);
});
