"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLoanModuleRepository,
} = require("../lib/persistence/repositories/loan-module");
const {
  createSalesArticleCatalogRepository,
} = require("../lib/persistence/repositories/sales-article-catalog");
const {
  SQLITE_LOAN_MODULE_CATALOG,
} = require("../lib/persistence/sqlite/loan-module-catalog");
const {
  SQLITE_SALES_ARTICLE_CATALOG,
} = require("../lib/persistence/sqlite/sales-article-catalog-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  LOAN_MODULE_STATEMENTS,
} = require("../lib/persistence/statements/loan-module");
const {
  salesArticleImportContentSha256,
} = require("../lib/sales-article-catalog");


async function importCentralArticle(context, articleNumber, description, identifier = null) {
  const article = {
    sourceArticleKey: articleNumber,
    articleNumber,
    description,
    active: true,
    sourceUpdatedAt: null,
    identifiers: identifier ? [{
      identifierType: "ean13",
      identifierValue: identifier,
      isPrimary: true,
      sourceField: "manual-test",
      sourceRank: 0,
    }] : [],
    prices: [],
  };
  const snapshot = {
    sourceSystem: "manual.loan",
    sourceProfileVersion: "test-v1",
    sourceSchemaSha256: "a".repeat(64),
    sourceFileSha256: "b".repeat(64),
    contentSha256: salesArticleImportContentSha256([article]),
    snapshotAt: "2026-07-29T11:59:00.000Z",
    articles: [article],
  };
  await context.salesArticleCatalog.importSnapshot({
    snapshot,
    actor: "M18",
    timestamp: "2026-07-29T12:00:00.000Z",
  });
  return context.salesArticleCatalog.getByArticleNumber(articleNumber);
}

test("Block 3/7: Leihmodul-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(LOAN_MODULE_STATEMENTS);
  assert.equal(SQLITE_LOAN_MODULE_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_LOAN_MODULE_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_LOAN_MODULE_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});
