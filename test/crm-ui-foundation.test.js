"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const functionSearchCatalog = fs.readFileSync(path.join(root, "public", "function-search-catalog.js"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("CRM ist ein eigener, berechtigungsgefilterter Unterpunkt der Verkaufsverwaltung", () => {
  const navigation = between(
    html,
    '<section class="nav-module hidden" id="salesAdministrationNav"',
    "</nav>",
  );
  assert.match(navigation, /aria-label="Verkaufsverwaltung"/);
  assert.match(navigation, /id="salesDashboardNavButton"[^>]*>[\s\S]*?<span>Verkauf<\/span>/);
  assert.match(navigation, /<button(?=[^>]*id="crmNavButton")(?=[^>]*data-view="crm")[^>]*>/);

  const landing = between(html, '<section id="salesAdministrationView"', '<section id="crmView"');
  assert.match(landing, /id="crmDashboardCard"[^>]*data-sales-dashboard-view="crm"/);

  assert.match(app, /function canAccessCrm\(\)/);
  assert.match(app, /function canWriteCrm\(\)/);
  assert.match(app, /function canOpenSalesAdministrationModule\(\)/);
  assert.match(app, /crmNavButton\?\.classList\.toggle\("hidden", !crmAccess\)/);
  assert.match(app, /crmDashboardCard\?\.classList\.toggle\("hidden", !crmAccess\)/);
  assert.match(app, /salesAdministrationNav\?\.classList\.toggle\("hidden", !salesModuleAccess\)/);

  assert.match(
    functionSearchCatalog,
    /entry\(\s*"sales\.crm",[\s\S]*?\["crmNavButton"\],[\s\S]*?\{ view: "crm", focusId: "crmSearchForm" \}/,
  );
});

test("CRM bleibt suchzentriert und lädt ohne ausdrückliche Suche keine Kundenliste", () => {
  const view = between(html, '<section id="crmView"', '<section id="salesAnalyticsView"');
  assert.match(view, /id="crmSearchForm"/);
  assert.match(view, /id="crmSearchQuery"[^>]*minlength="2"[^>]*maxlength="120"[^>]*required/);
  assert.match(view, /id="crmSearchCustomerType"/);
  assert.match(view, /<section(?=[^>]*id="crmResults")(?=[^>]*class="crm-results hidden")[^>]*>/);
  assert.match(view, /Ergebnisse werden erst nach einer ausdrücklichen Suche geladen/);
  assert.match(view, /id="crmPreviousPage"/);
  assert.match(view, /id="crmNextPage"/);

  assert.match(app, /crmSearchForm\?\.addEventListener\("submit"/);
  assert.match(app, /crmSearchSubmit/);
  assert.match(app, /\/api\/crm\/customers\?/);

  const bootstrap = between(app, "async function bootstrapApplication()", "async function loginToAdministration(event)");
  assert.doesNotMatch(bootstrap, /loadCrmCustomers|searchCrmCustomers|\/api\/crm\/customers/);
});

test("CRM-Anzeigespalten werden validiert, geordnet und kontobezogen gespeichert", () => {
  const view = between(html, '<section id="crmView"', '<section id="salesAnalyticsView"');
  assert.match(view, /id="crmColumnsButton"/);
  assert.match(html, /id="crmColumnsDialog"/);
  assert.match(html, /id="crmColumnsForm"/);
  assert.match(html, /id="crmColumnOptions"/);
  assert.match(html, /id="crmColumnsSave"/);

  assert.match(app, /function normalizeCrmDisplayColumns\(/);
  assert.match(app, /function normalizeCrmSort\(/);
  assert.match(app, /async function loadCrmPreferences\(/);
  assert.match(app, /async function saveCrmPreferences\(/);
  assert.match(app, /api\("\/api\/crm\/preferences"/);
  assert.match(app, /method:\s*"PUT"/);
  assert.match(app, /crmColumnOptions/);
  assert.match(app, /crmTableHead/);
  assert.match(app, /crmTableBody/);
});

test("Kundenkartei nutzt die volle CRM-Arbeitsbreite und bleibt nicht in einer Halbkachel", () => {
  const view = between(html, '<section id="crmView"', '<section id="salesAnalyticsView"');
  assert.match(view, /class="crm-customer-workspace hidden"[^>]*id="crmCustomerWorkspace"/);
  assert.match(view, /class="crm-customer-shell"[^>]*id="crmCustomerShell"/);
  assert.match(view, /class="crm-customer-detail"[^>]*id="crmCustomerDetail"/);

  assert.match(styles, /\.crm-customer-workspace\s*\{[^}]*width:\s*100%/s);
  assert.match(styles, /\.crm-customer-shell\s*\{[^}]*width:\s*100%/s);
  assert.doesNotMatch(styles, /\.crm-(?:customer-workspace|customer-shell)[^{]*\{[^}]*max-width:\s*(?:50%|[0-7]\d\dpx)/s);
});
