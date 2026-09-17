"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  SALES_ARTICLE_CATALOG_PERMISSIONS,
  SALES_ARTICLE_CATALOG_PERMISSION_IDS,
  SALES_ARTICLE_PRICE_GROUPS,
  buildSalesArticleCatalogProjection,
  resolveSalesArticleCatalogPermissionDependencies,
  salesArticlePriceGroup,
} = require("../lib/sales-article-catalog-access");
const {
  SALES_ARTICLE_PRICE_TYPES,
} = require("../lib/sales-article-catalog");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function between(start, end) {
  const from = server.indexOf(start);
  const to = server.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} .. ${end}`);
  return server.slice(from, to);
}

test("Artikelstamm trennt Arbeitsbereich und Leserecht mit geschlossener Abhängigkeit", () => {
  assert.deepEqual(SALES_ARTICLE_CATALOG_PERMISSION_IDS, [
    "sales:articles:access",
    "sales:articles:read",
    "sales:articles:prices:read",
    "sales:articles:costs:read",
    "sales:articles:write",
    "sales:articles:import",
  ]);
  assert.deepEqual(buildSalesArticleCatalogProjection({ permissions: [] }), {
    workspace: false,
    read: false,
    pricesRead: false,
    costsRead: false,
    write: false,
    import: false,
  });
  assert.deepEqual(buildSalesArticleCatalogProjection({
    permissions: [SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS],
  }), {
    workspace: true,
    read: false,
    pricesRead: false,
    costsRead: false,
    write: false,
    import: false,
  });
  assert.deepEqual(buildSalesArticleCatalogProjection({
    permissions: SALES_ARTICLE_CATALOG_PERMISSION_IDS,
  }), {
    workspace: true,
    read: true,
    pricesRead: true,
    costsRead: true,
    write: true,
    import: true,
  });
  assert.deepEqual(resolveSalesArticleCatalogPermissionDependencies([
    SALES_ARTICLE_CATALOG_PERMISSIONS.READ,
  ]), {
    valid: false,
    missing: [SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS],
  });
  assert.equal(resolveSalesArticleCatalogPermissionDependencies(
    SALES_ARTICLE_CATALOG_PERMISSION_IDS,
  ).valid, true);
  assert.deepEqual(resolveSalesArticleCatalogPermissionDependencies([
    SALES_ARTICLE_CATALOG_PERMISSIONS.PRICES_READ,
  ]), {
    valid: false,
    missing: [
      SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS,
      SALES_ARTICLE_CATALOG_PERMISSIONS.READ,
    ],
  });
  assert.deepEqual(resolveSalesArticleCatalogPermissionDependencies([
    SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS,
    SALES_ARTICLE_CATALOG_PERMISSIONS.COSTS_READ,
  ]), {
    valid: false,
    missing: [SALES_ARTICLE_CATALOG_PERMISSIONS.READ],
  });
  for (const independentRight of [
    SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE,
    SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT,
  ]) {
    assert.deepEqual(resolveSalesArticleCatalogPermissionDependencies([independentRight]), {
      valid: false,
      missing: [
        SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS,
        SALES_ARTICLE_CATALOG_PERMISSIONS.READ,
      ],
    });
    const projection = buildSalesArticleCatalogProjection({
      permissions: [
        SALES_ARTICLE_CATALOG_PERMISSIONS.ACCESS,
        SALES_ARTICLE_CATALOG_PERMISSIONS.READ,
        independentRight,
      ],
    });
    assert.equal(projection.write, independentRight === SALES_ARTICLE_CATALOG_PERMISSIONS.WRITE);
    assert.equal(projection.import, independentRight === SALES_ARTICLE_CATALOG_PERMISSIONS.IMPORT);
  }
});

test("Preisarten sind vollständig und ohne Überschneidung auf Verkaufs- und Kostenrechte verteilt", () => {
  const grouped = [
    ...SALES_ARTICLE_PRICE_GROUPS.PRICES,
    ...SALES_ARTICLE_PRICE_GROUPS.COSTS,
  ];
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual([...grouped].sort(), [...SALES_ARTICLE_PRICE_TYPES].sort());
  for (const priceType of SALES_ARTICLE_PRICE_GROUPS.PRICES) {
    assert.equal(salesArticlePriceGroup(priceType), "prices");
  }
  for (const priceType of SALES_ARTICLE_PRICE_GROUPS.COSTS) {
    assert.equal(salesArticlePriceGroup(priceType), "costs");
  }
  assert.equal(salesArticlePriceGroup("future-unclassified-price"), null);
});

test("Rechtekatalog begrenzt Artikelstamm auf kaufmännische Rollen und erhält Developer-Vollzugriff", () => {
  for (const permission of ["ACCESS", "READ", "PRICES_READ", "COSTS_READ", "WRITE", "IMPORT"]) {
    assert.match(
      server,
      new RegExp(`SALES_ARTICLE_CATALOG_PERMISSIONS\\.${permission}[\\s\\S]{0,420}eligibleRoles: \\["manager", "admin", "developer"\\]`),
    );
  }
  assert.match(server, /\.\.\.SALES_ARTICLE_CATALOG_PERMISSION_IDS/);
  assert.match(server, /resolveSalesArticleCatalogPermissionDependencies/);
  assert.match(server, /addBuiltinRolePermissions\("developer", \[[\s\S]*delegablePortalPermissionCatalog/);
  assert.match(server, /SALES_ARTICLE_CATALOG_PERMISSION_ROLE_RESTRICTED/);
});

test("GET-API ist persönlich, privat, read-only und validiert eine feste Query-Oberfläche", () => {
  const route = between(
    'app.get("/api/sales/articles"',
    "const SALES_ARTICLE_USABLE_PRICE_QUALITY_STATUSES",
  );
  assert.match(route, /salesArticleCatalogSession\(request, SALES_ARTICLE_CATALOG_PERMISSIONS\.READ\)/);
  assert.match(route, /setSalesArticleCatalogPrivateHeaders\(response\)/);
  assert.match(route, /normalizeSalesArticleSearch/);
  assert.match(route, /searchSalesArticleWorkspace/);
  assert.match(route, /"query", "identifier", "orderNumber", "status", "sourceSystem", "sort", "direction", "limit", "offset"/);
  assert.doesNotMatch(route, /assertPortalCsrf|\.importSnapshot|\.execute\(/i);
  assert.match(route, /projection\[priceSort.permission\]/);
  assert.match(route, /assertFreshSalesArticleRead/);

  const headers = between(
    "function setSalesArticleCatalogPrivateHeaders",
    'app.get("/api/sales/articles"',
  );
  assert.match(headers, /private, no-store, max-age=0/);
  assert.match(headers, /X-Content-Type-Options/);

  const sessionHelper = between(
    "function salesArticleCatalogSession",
    'app.get("/api/sales/articles"',
  );
  assert.match(sessionHelper, /requirePortalAnyPermissionOrLocal\(request, \[permission\]\)/);
  assert.match(sessionHelper, /if \(isLocalSystemSession\(session\)\) return session/);
  assert.match(sessionHelper, /session\.sessionKind === "organization" \|\| session\.isEmployee === false/);
  assert.match(sessionHelper, /buildSalesArticleCatalogProjection/);
  assert.match(sessionHelper, /projection\.read/);
  assert.match(sessionHelper, /projection\.pricesRead/);
  assert.match(sessionHelper, /projection\.costsRead/);
  assert.match(sessionHelper, /SALES_ARTICLE_CATALOG_PERMISSION_DENIED/);
});

test("Detail-API projiziert nur freigegebene Felder und trennt Preise serverseitig", () => {
  const projection = between(
    "function projectSalesArticleIdentifiers",
    'app.get("/api/sales/articles/detail"',
  );
  assert.match(projection, /equivalentIdentifiers/);
  assert.match(projection, /identifierType/);
  assert.match(projection, /identifierValue/);
  assert.match(projection, /originSourceSystem/);
  assert.match(projection, /projection\.pricesRead \? groupedPrices\.prices : null/);
  assert.match(projection, /projection\.costsRead \? groupedPrices\.costs : null/);
  assert.match(projection, /SALES_ARTICLE_USABLE_PRICE_QUALITY_STATUSES\.has/);
  assert.match(projection, /amount: usable \? price\.amount : null/);
  assert.doesNotMatch(
    projection,
    /sourceSnapshotId|sourceField|sourceRank|canonicalGtin14|createdBy|updatedBy|contentSha256/,
  );

  const route = between(
    'app.get("/api/sales/articles/detail"',
    "function setCrmPrivateHeaders",
  );
  assert.match(route, /SALES_ARTICLE_CATALOG_PERMISSIONS\.READ/);
  assert.match(route, /setSalesArticleCatalogPrivateHeaders/);
  assert.match(route, /new Set\(\["articleNumber"\]\)/);
  assert.match(route, /normalizeSalesArticleNumber/);
  assert.match(route, /salesArticleCatalogRepository\.getByArticleNumber/);
  assert.match(route, /salesArticleCatalogRepository\.listRevisions/);
  assert.match(route, /SALES_ARTICLE_NOT_FOUND/);
  assert.match(route, /const result = await projectSalesArticleDetail/);
  assert.match(route, /assertFreshSalesArticleRead/);
  assert.doesNotMatch(route, /assertPortalCsrf|\.importSnapshot|\.execute\(/);
});

test("Admin-API-Middleware verlangt für die Artikelsuche kein Dienstplanrecht", () => {
  const middleware = between("function enforceAdminApiAccess", "function isIsoDate");
  assert.match(
    middleware,
    /const salesArticleCatalogRoute = \/\^\\\/sales\\\/articles\(\?:\\\/\|\$\)\/\.test\(request\.path\)/,
  );
  assert.match(
    middleware,
    /const salesArticleImportRoute = \/\^\\\/sales\\\/articles\\\/import\(\?:\\\/\|\$\)\/\.test\(request\.path\)/,
  );
  assert.match(
    middleware,
    /if \(salesArticleCatalogRoute\) \{\s*permission = salesArticleImportRoute\s*\? SALES_ARTICLE_CATALOG_PERMISSIONS\.IMPORT\s*: request.path === '\/sales\/articles\/preferences' \|\| \["GET", "HEAD", "OPTIONS"\]\.includes\(method\)\s*\? SALES_ARTICLE_CATALOG_PERMISSIONS\.READ\s*: SALES_ARTICLE_CATALOG_PERMISSIONS\.WRITE;/,
  );
});
