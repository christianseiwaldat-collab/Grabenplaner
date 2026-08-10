"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  SALES_ANALYTICS_PERMISSIONS,
  SALES_ANALYTICS_PERMISSION_IDS,
  buildSalesAnalyticsProjection,
} = require("../lib/sales-analytics-access");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const contract = fs.readFileSync(
  path.join(root, "docs", "VERKAUFSANALYSEN-RECHTE-SICHTEN-v0.1.md"),
  "utf8",
);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Verkaufsanalyse-Rechte verwenden einen stabilen, getrennten Katalog", () => {
  assert.deepEqual(SALES_ANALYTICS_PERMISSIONS, {
    ACCESS: "sales:analytics:access",
    LOCATION_READ: "sales:analytics:location:read",
    COMPANY_READ: "sales:analytics:company:read",
    ONLINE_READ: "sales:analytics:online:read",
    INVENTORY_READ: "sales:analytics:inventory:read",
    MARGIN_READ: "sales:analytics:margin:read",
    IMPORT_MANAGE: "sales:analytics:imports:manage",
  });
  assert.equal(SALES_ANALYTICS_PERMISSION_IDS.length, 7);
  assert.equal(new Set(SALES_ANALYTICS_PERMISSION_IDS).size, 7);

  const permissionCatalog = between(
    server,
    "const delegablePortalPermissionCatalog = Object.freeze([",
    "const delegablePortalPermissions",
  );
  for (const permissionKey of Object.keys(SALES_ANALYTICS_PERMISSIONS)) {
    assert.match(permissionCatalog, new RegExp(`id: SALES_ANALYTICS_PERMISSIONS\\.${permissionKey}`));
  }
  const salesPermissionLines = permissionCatalog.split(/\r?\n/)
    .filter((line) => line.includes("id: SALES_ANALYTICS_PERMISSIONS."));
  assert.equal(salesPermissionLines.length, 7);
  for (const line of salesPermissionLines) {
    assert.match(line, /eligibleRoles: \["manager", "admin", "developer"\]/);
    assert.doesNotMatch(line, /"it_admin"/);
  }
  assert.match(permissionCatalog, /Verkaufsdaten zugewiesener Filialen lesen/);
  assert.match(permissionCatalog, /Getrennte Onlineshop-Projektion/);
  assert.match(permissionCatalog, /Onlineshops bleiben ein eigenes Zusatzrecht/);
});

test("Ohne Arbeitsbereich bleiben alle Datenprojektionen fail-closed", () => {
  const projection = buildSalesAnalyticsProjection({
    permissions: [
      SALES_ANALYTICS_PERMISSIONS.LOCATION_READ,
      SALES_ANALYTICS_PERMISSIONS.COMPANY_READ,
      SALES_ANALYTICS_PERMISSIONS.ONLINE_READ,
      SALES_ANALYTICS_PERMISSIONS.INVENTORY_READ,
      SALES_ANALYTICS_PERMISSIONS.MARGIN_READ,
      SALES_ANALYTICS_PERMISSIONS.IMPORT_MANAGE,
    ],
    scopes: [{ locationId: "01", departmentId: null }],
  });

  assert.deepEqual(projection, {
    workspace: false,
    locationMode: "none",
    locationIds: [],
    company: false,
    onlineShop: false,
    inventory: false,
    grossMargin: false,
    importManagement: false,
    hasDataProjection: false,
  });
});

test("Filialprojektion übernimmt nur vollständige, zugewiesene Standorte", () => {
  const projection = buildSalesAnalyticsProjection({
    permissions: [
      SALES_ANALYTICS_PERMISSIONS.ACCESS,
      SALES_ANALYTICS_PERMISSIONS.LOCATION_READ,
      SALES_ANALYTICS_PERMISSIONS.INVENTORY_READ,
    ],
    scopes: [
      { locationId: "02", departmentId: null },
      { locationId: "01", departmentId: 7 },
      { location_id: "03", department_id: 0 },
      { locationId: "02", departmentId: null },
      { locationId: "", departmentId: null },
    ],
  });

  assert.equal(projection.workspace, true);
  assert.equal(projection.locationMode, "scoped");
  assert.deepEqual(projection.locationIds, ["02", "03"]);
  assert.equal(projection.company, false);
  assert.equal(projection.inventory, true);
  assert.equal(projection.grossMargin, false);
  assert.equal(projection.importManagement, false);
  assert.equal(projection.hasDataProjection, true);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.locationIds), true);
});

test("Abteilungsscope wird nicht zur vollständigen Filialfreigabe erweitert", () => {
  const projection = buildSalesAnalyticsProjection({
    permissions: [
      SALES_ANALYTICS_PERMISSIONS.ACCESS,
      SALES_ANALYTICS_PERMISSIONS.LOCATION_READ,
      SALES_ANALYTICS_PERMISSIONS.MARGIN_READ,
    ],
    scopes: [{ locationId: "01", departmentId: 7 }],
  });

  assert.equal(projection.locationMode, "none");
  assert.deepEqual(projection.locationIds, []);
  assert.equal(projection.grossMargin, false);
  assert.equal(projection.hasDataProjection, false);
});

test("Gesamtfirma, Onlineshop, Bestand und Rohertrag bleiben getrennte Schichten", () => {
  const companyProjection = buildSalesAnalyticsProjection({
    permissions: [
      SALES_ANALYTICS_PERMISSIONS.ACCESS,
      SALES_ANALYTICS_PERMISSIONS.COMPANY_READ,
      SALES_ANALYTICS_PERMISSIONS.INVENTORY_READ,
      SALES_ANALYTICS_PERMISSIONS.MARGIN_READ,
    ],
    scopes: [{ locationId: "01", departmentId: null }],
  });
  assert.equal(companyProjection.locationMode, "company");
  assert.equal(companyProjection.company, true);
  assert.deepEqual(companyProjection.locationIds, []);
  assert.equal(companyProjection.onlineShop, false);
  assert.equal(companyProjection.inventory, true);
  assert.equal(companyProjection.grossMargin, true);
  assert.equal(companyProjection.importManagement, false);

  const importProjection = buildSalesAnalyticsProjection({
    permissions: [
      SALES_ANALYTICS_PERMISSIONS.ACCESS,
      SALES_ANALYTICS_PERMISSIONS.COMPANY_READ,
      SALES_ANALYTICS_PERMISSIONS.MARGIN_READ,
      SALES_ANALYTICS_PERMISSIONS.IMPORT_MANAGE,
    ],
  });
  assert.equal(importProjection.importManagement, true);

  const onlineProjection = buildSalesAnalyticsProjection({
    permissions: [
      SALES_ANALYTICS_PERMISSIONS.ACCESS,
      SALES_ANALYTICS_PERMISSIONS.ONLINE_READ,
      SALES_ANALYTICS_PERMISSIONS.INVENTORY_READ,
      SALES_ANALYTICS_PERMISSIONS.MARGIN_READ,
    ],
  });
  assert.equal(onlineProjection.locationMode, "none");
  assert.equal(onlineProjection.onlineShop, true);
  assert.equal(onlineProjection.inventory, false);
  assert.equal(onlineProjection.grossMargin, false);
  assert.equal(onlineProjection.hasDataProjection, true);
});

test("Rechtevergabe erzwingt Abhängigkeiten und trennt technische Verwaltung vom Datennutzen", () => {
  const dependencyPolicy = between(
    server,
    "function assertPortalPermissionDependencies(permissions)",
    "const portalDashboardPermissionDetails",
  );
  assert.match(dependencyPolicy, /SALES_ANALYTICS_PERMISSION_IDS\.filter/);
  assert.match(dependencyPolicy, /SALES_ANALYTICS_PERMISSIONS\.ACCESS/);
  assert.match(dependencyPolicy, /SALES_ANALYTICS_PERMISSIONS\.LOCATION_READ, SALES_ANALYTICS_PERMISSIONS\.COMPANY_READ/);
  assert.match(dependencyPolicy, /SALES_ANALYTICS_PERMISSIONS\.IMPORT_MANAGE/);

  const manageablePolicy = between(
    server,
    "function manageablePortalPermissionsForActor(actor)",
    "function portalPermissionCatalogForActor(actor)",
  );
  assert.match(manageablePolicy, /actor\.role === "it_admin"/);
  assert.doesNotMatch(manageablePolicy, /!permission\.startsWith\("sales:analytics:"\)/);

  const builtinRoles = between(server, "const builtinPortalRoles = [", "const adminPortalRole");
  assert.doesNotMatch(builtinRoles, /SALES_ANALYTICS_PERMISSIONS|sales:analytics:/);
  assert.match(server, /addBuiltinRolePermissions\(\s*"developer",\s*delegablePortalPermissionCatalog\.map/);
  assert.doesNotMatch(server, /addBuiltinRolePermissions\(\s*"(?:it_admin|admin|hr)",\s*delegablePortalPermissionCatalog\.map/);
});

test("Server liefert die reduzierte Projektion und der Browser verwendet sie nur für den Arbeitsbereich", () => {
  assert.equal(
    (server.match(/salesAnalytics: buildSalesAnalyticsProjection\(session\)/g) || []).length,
    2,
  );
  const accessHelper = between(app, "function canAccessSalesAnalytics()", "function canReadVacationAccounts()");
  assert.match(accessHelper, /user\?\.salesAnalytics\?\.workspace === true/);
  assert.doesNotMatch(accessHelper, /sales:analytics:location:read|sales:analytics:company:read/);
  assert.match(app, /user\?\.salesAnalytics\?\.importManagement === true/);
  assert.match(server, /salesAnalyticsRequestContext\(request, \{ importManagement: true/);
  assert.match(html, /id="salesReportImportPanel"/);
  assert.match(html, /Filiale, EUR und Berichtssumme best/);
});

test("Block-3-Vertrag hält Daten- und Implementierungsgrenzen fest", () => {
  assert.match(contract, /^# Verkaufsanalysen · Rechte- und Sichtkonzept v0\.1/m);
  assert.match(contract, /\| Block \| 3 · Rechte, Sichten und Datenschutz \|/);
  assert.match(contract, /Keine eingebaute Rolle erhält in Block 3 automatisch ein Verkaufsanalyse-Recht/);
  assert.match(contract, /Ein reiner Abteilungsbereich darf nicht zur vollständigen Filialauswertung hochgestuft werden/);
  assert.match(contract, /Shopware_Artikel` enthält nur Produktzuordnungen/);
  assert.match(contract, /Es wurden keine Verkaufsdaten verarbeitet oder gespeichert/);
  assert.match(contract, /keine automatische Freigabe für Datenmodell, Importassistent, Analyse-API, Kennzahlen oder Oberflächeninhalte/);
});
