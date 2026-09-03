"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  SalesArticleCatalogError,
  normalizeSalesArticleSearch,
  salesArticleImportContentSha256,
} = require("../lib/sales-article-catalog");
const {
  createSalesArticleCatalogRepository,
} = require("../lib/persistence/repositories/sales-article-catalog");
const {
  ensureSqliteSalesArticleCatalogSchema,
} = require("../lib/persistence/sqlite/operations/sales-article-catalog-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  SQLITE_SALES_ARTICLE_CATALOG,
} = require("../lib/persistence/sqlite/sales-article-catalog-catalog");
const {
  SALES_ARTICLE_CATALOG_STATEMENTS,
} = require("../lib/persistence/statements/sales-article-catalog");
const {
  compilePostgresqlDialectEntry,
} = require("../lib/persistence/postgresql/dialect-compiler");

function gtin13(seed) {
  const base = String(seed).padStart(12, "0").slice(-12);
  let sum = 0;
  for (let index = 0; index < base.length; index += 1) {
    sum += Number(base[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function article(index, overrides = {}) {
  const identifierValue = gtin13(400000000000 + index);
  return {
    sourceArticleKey: `source-${index}`,
    articleNumber: `ART-${String(index).padStart(3, "0")}`,
    description: index <= 12 ? "Kamera gleicher Name" : `Objektiv ${index}`,
    active: index !== 4,
    sourceUpdatedAt: null,
    identifiers: [{
      identifierType: "ean13",
      identifierValue,
      isPrimary: true,
      sourceField: "EAN",
      sourceRank: 1,
    }],
    prices: [],
    ...overrides,
  };
}

function snapshot(sourceSystem, articles, marker) {
  return {
    sourceSystem,
    sourceProfileVersion: "search-test-v1",
    sourceSchemaSha256: crypto.createHash("sha256").update(`schema-${marker}`).digest("hex"),
    sourceFileSha256: crypto.createHash("sha256").update(`file-${marker}`).digest("hex"),
    contentSha256: salesArticleImportContentSha256(articles),
    snapshotAt: `2026-09-03T10:${String(marker).padStart(2, "0")}:00.000Z`,
    articles,
  };
}

async function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_SALES_ARTICLE_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  ensureSqliteSalesArticleCatalogSchema(application.database);
  const repository = createSalesArticleCatalogRepository(application.provider);
  await repository.importSnapshot({
    snapshot: snapshot("manual.loan", Array.from({ length: 12 }, (_, index) => (
      article(index + 1, index === 11 ? { identifiers: [] } : {})
    )), 1),
    actor: "tester",
    timestamp: "2026-09-03T11:01:00.000Z",
  });
  await repository.importSnapshot({
    snapshot: snapshot("tradefoto.artikel_stamm", [
      article(13, { description: "Spezialkamera für Prozent % und Unterstrich _" }),
      article(14, { description: "Ärmel und Ösen für Übergrößen · ÉTUI CAFÉ" }),
    ], 2),
    actor: "tester",
    timestamp: "2026-09-03T11:02:00.000Z",
  });
  return {
    ...application,
    repository,
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("Artikelstammsuche normalisiert nur freigegebene Filter und harte Seitenlimits", () => {
  assert.deepEqual(normalizeSalesArticleSearch({}), {
    query: "",
    likeQuery: "%%",
    identifier: "",
    identifierLike: "%%",
    status: "active",
    active: true,
    sourceSystem: null,
    sort: "articleNumber",
    direction: "asc",
    limit: 50,
    offset: 0,
  });
  const escaped = normalizeSalesArticleSearch({ query: "  A!%_  ", limit: "100", offset: "1000000" });
  assert.equal(escaped.likeQuery, "%a!!!%!_%");
  for (const invalid of [
    { identifier: "123A" },
    { status: "deleted" },
    { sort: "price" },
    { direction: "sideways" },
    { limit: 0 },
    { limit: 101 },
    { offset: 1000001 },
    { query: "x", unexpected: true },
  ]) {
    assert.throws(
      () => normalizeSalesArticleSearch(invalid),
      (error) => error instanceof SalesArticleCatalogError,
    );
  }
});

test("Artikelstammsuche paginiert stabil, zählt getrennt und filtert nur modellierte Felder", async () => {
  const context = await fixture();
  try {
    const first = await context.repository.search({
      query: "kamera",
      status: "all",
      sort: "description",
      direction: "asc",
      limit: 10,
      offset: 0,
    });
    const second = await context.repository.search({
      query: "kamera",
      status: "all",
      sort: "description",
      direction: "asc",
      limit: 10,
      offset: 10,
    });
    assert.equal(first.total, 13);
    assert.equal(first.items.length, 10);
    assert.equal(second.items.length, 3);
    assert.equal(new Set([...first.items, ...second.items].map(({ productId }) => productId)).size, 13);
    assert.deepEqual(first.items.map(({ articleNumber }) => articleNumber), [
      "ART-001", "ART-002", "ART-003", "ART-004", "ART-005",
      "ART-006", "ART-007", "ART-008", "ART-009", "ART-010",
    ]);
    assert.deepEqual(Object.keys(first.items[0]), [
      "productId", "articleNumber", "description", "primaryIdentifier",
      "active", "sourceSystem", "currentRevision",
    ]);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.items), true);

    const inactive = await context.repository.search({ status: "inactive" });
    assert.equal(inactive.total, 1);
    assert.equal(inactive.items[0].articleNumber, "ART-004");

    const source = await context.repository.search({
      status: "all",
      sourceSystem: "tradefoto.artikel_stamm",
      sort: "articleNumber",
      direction: "desc",
    });
    assert.equal(source.total, 2);
    assert.deepEqual(source.items.map(({ articleNumber }) => articleNumber), ["ART-014", "ART-013"]);

    const targetIdentifier = gtin13(400000000007);
    const identifier = await context.repository.search({
      identifier: targetIdentifier.slice(-6),
      status: "all",
    });
    assert.equal(identifier.total, 1);
    assert.equal(identifier.items[0].articleNumber, "ART-007");

    const canonicalIdentifier = await context.repository.search({
      identifier: `0${targetIdentifier}`,
      status: "all",
    });
    assert.equal(canonicalIdentifier.total, 1);
    assert.equal(canonicalIdentifier.items[0].articleNumber, "ART-007");

    for (const direction of ["asc", "desc"]) {
      const identifierOrder = await context.repository.search({
        status: "all",
        sort: "primaryIdentifier",
        direction,
        limit: 100,
      });
      assert.equal(identifierOrder.items.at(-1).articleNumber, "ART-012");
    }

    const literalWildcard = await context.repository.search({ query: "%", status: "all" });
    assert.equal(literalWildcard.total, 1);
    assert.equal(literalWildcard.items[0].articleNumber, "ART-013");

    const unicodeCase = await context.repository.search({ query: "ärmel", status: "all" });
    assert.equal(unicodeCase.total, 1);
    assert.equal(unicodeCase.items[0].articleNumber, "ART-014");

    const accentedUnicodeCase = await context.repository.search({ query: "ÉTUI CAFÉ", status: "all" });
    assert.equal(accentedUnicodeCase.total, 1);
    assert.equal(accentedUnicodeCase.items[0].articleNumber, "ART-014");

    await context.repository.importSnapshot({
      snapshot: snapshot("tradefoto.artikel_stamm", [
        article(1, {
          sourceArticleKey: "trade-source-1",
          description: "TradeFoto Update Kamera",
        }),
      ], 3),
      actor: "tester",
      timestamp: "2026-09-03T11:03:00.000Z",
    });
    const currentTradeFoto = await context.repository.search({
      status: "all",
      sourceSystem: "tradefoto.artikel_stamm",
    });
    assert.equal(currentTradeFoto.total, 3);
    assert.equal(currentTradeFoto.items.some(({ articleNumber }) => articleNumber === "ART-001"), true);
    const currentLegacy = await context.repository.search({
      status: "all",
      sourceSystem: "manual.loan",
    });
    assert.equal(currentLegacy.total, 11);
    assert.equal(currentLegacy.items.some(({ articleNumber }) => articleNumber === "ART-001"), false);
  } finally {
    await context.close();
  }
});

test("Suchstatements bleiben PostgreSQL-portabel und geben keine Preis- oder Kostenspalten frei", () => {
  for (const statement of [
    SALES_ARTICLE_CATALOG_STATEMENTS.search,
    SALES_ARTICLE_CATALOG_STATEMENTS.countSearch,
  ]) {
    const entry = SQLITE_SALES_ARTICLE_CATALOG.find((candidate) => candidate.statement === statement);
    assert.ok(entry);
    assert.equal(compilePostgresqlDialectEntry(entry).strategy, "portable-generated");
    assert.doesNotMatch(entry.sql, /sales_article_price|\bamount\b|\bcost\b/i);
  }
  const searchSql = SQLITE_SALES_ARTICLE_CATALOG.find(
    (candidate) => candidate.statement === SALES_ARTICLE_CATALOG_STATEMENTS.search,
  ).sql;
  const compiledSearch = compilePostgresqlDialectEntry(
    SQLITE_SALES_ARTICLE_CATALOG.find(
      (candidate) => candidate.statement === SALES_ARTICLE_CATALOG_STATEMENTS.search,
    ),
  );
  assert.match(searchSql, /gp_unicode_casefold\(article\.article_number\)/);
  assert.match(searchSql, /gp_unicode_casefold\(revision\.description\)/);
  assert.doesNotMatch(compiledSearch.compiledSql, /gp_unicode_casefold/i);
  assert.match(compiledSearch.compiledSql, /LOWER\(article\.article_number\)/);
  assert.equal(
    compiledSearch.coveredFeatures.includes("postgresql.sqlite-unicode-casefold"),
    true,
  );
  assert.match(searchSql, /CASE WHEN identifier\.source_rank IS NULL THEN 1 ELSE 0 END/);
  assert.match(searchSql, /\$sort = 'primaryIdentifier'[\s\S]*PRIMARY_IDENTIFIER|\$sort = 'primaryIdentifier'[\s\S]*\) IS NULL/);
  assert.match(searchSql, /searched_identifier\.canonical_gtin14/);
  assert.deepEqual(Object.keys(SALES_ARTICLE_CATALOG_STATEMENTS.search.columns), [
    "productId", "articleNumber", "description", "primaryIdentifier",
    "active", "sourceSystem", "currentRevision",
  ]);
});
