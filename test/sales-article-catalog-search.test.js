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


test("Suchstatements bleiben PostgreSQL-portabel und lesen Preise nur aus der vorbereiteten Suchprojektion", () => {
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
  assert.match(searchSql, /article\.article_number_sort/);
  assert.match(searchSql, /article\.description_sort/);
  assert.doesNotMatch(compiledSearch.compiledSql, /gp_unicode_casefold/i);
  assert.match(compiledSearch.compiledSql, /LOWER\(article\.search_text\)/);
  assert.doesNotMatch(searchSql, /REPLACE\(|SELECT identifier\.identifier_value/);
  assert.match(searchSql, /\$sort = 'primaryIdentifier' AND article\.primary_identifier IS NULL/);
  assert.match(searchSql, /searched_identifier\.canonical_gtin14/);
  assert.deepEqual(Object.keys(SALES_ARTICLE_CATALOG_STATEMENTS.search.columns), [
    "productId", "articleNumber", "description", "primaryIdentifier",
    "active", "sourceSystem", "currentRevision",
    "retailGross", "internetGross", "retailNet", "internetNet", "purchaseNet", "purchaseGross",
  ]);
});
