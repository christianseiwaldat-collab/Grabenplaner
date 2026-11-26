"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  compilePostgresqlDialectEntry,
} = require("../lib/persistence/postgresql/dialect-compiler");
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
  salesArticleImportContentSha256,
} = require("../lib/sales-article-catalog");

const IMPORTED_AT = "2026-09-03T08:05:00.000Z";

function price(overrides = {}) {
  return {
    priceType: "sales",
    amount: "13.67144267874",
    currency: "EUR",
    priceBasis: "gross",
    qualityStatus: "confirmed",
    sourceField: "Verkaufspreis",
    ...overrides,
  };
}

function article(overrides = {}) {
  return {
    sourceArticleKey: "0000000093757",
    articleNumber: "093757",
    description: "Synthetischer Testartikel",
    active: true,
    sourceUpdatedAt: null,
    identifiers: [],
    prices: [
      price(),
      price({ priceType: "internet_2", amount: "0", sourceField: "InternetVK2" }),
      price({
        priceType: "internet_2",
        amount: null,
        priceBasis: "net",
        qualityStatus: "unresolved",
        sourceField: "InternetVKN2",
      }),
      price({
        priceType: "internet_5",
        amount: "-1.25",
        qualityStatus: "quarantined",
        sourceField: "InternetVK5",
      }),
    ],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const value = {
    sourceSystem: "tradefoto",
    sourceProfileVersion: "tradefoto-article-v1",
    sourceSchemaSha256: "a".repeat(64),
    sourceFileSha256: "f".repeat(64),
    snapshotAt: "2026-09-03T08:00:00.000Z",
    articles: [article()],
    ...overrides,
  };
  return {
    ...value,
    contentSha256: Object.hasOwn(overrides, "contentSha256")
      ? overrides.contentSha256
      : salesArticleImportContentSha256(value.articles),
  };
}


function count(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function persistenceCode(code) {
  return (error) => error?.code === code;
}

test("Statementkatalog ist vollständig und PostgreSQL-portabel kompilierbar", () => {
  const statements = Object.values(SALES_ARTICLE_CATALOG_STATEMENTS);
  assert.equal(statements.length, 34);
  assert.equal(SQLITE_SALES_ARTICLE_CATALOG.length, statements.length);
  assert.equal(new Set(statements).size, statements.length);
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_SALES_ARTICLE_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
  for (const entry of SQLITE_SALES_ARTICLE_CATALOG) {
    const compiled = compilePostgresqlDialectEntry(entry);
    assert.equal(compiled.strategy, "portable-generated", entry.statement.id);
  }
});

function manualMutation(input, overrides = {}) {
  return {
    input,
    actor: "article-manager",
    timestamp: "2026-09-03T10:00:00.000Z",
    mutationId: crypto.randomUUID(),
    ...overrides,
  };
}
