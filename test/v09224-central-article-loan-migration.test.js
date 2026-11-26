"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createSalesArticleCatalogRepository,
} = require("../lib/persistence/repositories/sales-article-catalog");
const {
  CENTRAL_ARTICLE_LOAN_MIGRATION_ID,
  inspectSqliteCentralArticleLoanMigration,
  migrateSqliteCentralArticleLoans,
  sourceKeyForTradeFotoArticleNumber,
} = require("../lib/persistence/sqlite/operations/central-article-loan-migration");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  ensureSqliteSalesArticleCatalogSchema,
} = require("../lib/persistence/sqlite/operations/sales-article-catalog-schema");
const {
  SQLITE_SALES_ARTICLE_CATALOG,
} = require("../lib/persistence/sqlite/sales-article-catalog-catalog");
const {
  salesArticleImportContentSha256,
} = require("../lib/sales-article-catalog");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

const MIGRATED_AT = "2026-09-03T09:00:00.000Z";
const EAN = "5025232978748";

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function installLegacyLoanCatalog(database, {
  articleNumber = "093757",
  description = "Legacy Leihartikel",
  identifierValue = EAN,
  withLoanItem = true,
} = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loans (id TEXT PRIMARY KEY);
    CREATE TABLE articles (
      article_number TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      source_provider TEXT NOT NULL DEFAULT 'manual',
      source_product_number TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_fetched_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE article_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_number TEXT NOT NULL,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      source_provider TEXT NOT NULL DEFAULT 'manual',
      verified_at TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE loan_items (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      article_number TEXT NOT NULL,
      description_snapshot TEXT NOT NULL,
      serial_number TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      condition_out TEXT NOT NULL DEFAULT '',
      condition_return TEXT NOT NULL DEFAULT '',
      item_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(loan_id, position),
      FOREIGN KEY (loan_id) REFERENCES loans(id),
      FOREIGN KEY (article_number) REFERENCES articles(article_number)
    );
    CREATE TABLE IF NOT EXISTS loan_migration_receipts (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
  `);
  database.prepare(`
    INSERT INTO articles (
      article_number, description, source_provider, source_product_number,
      source_url, source_fetched_at, active, created_by, updated_by,
      created_at, updated_at
    ) VALUES (?, ?, 'manual', '', '', NULL, 1, '419', '419', ?, ?)
  `).run(articleNumber, description, MIGRATED_AT, MIGRATED_AT);
  if (identifierValue) {
    database.prepare(`
      INSERT INTO article_identifiers (
        article_number, identifier_type, identifier_value, source_provider,
        verified_at, created_by, updated_by, created_at, updated_at
      ) VALUES (?, 'ean13', ?, 'manual', ?, '419', '419', ?, ?)
    `).run(articleNumber, identifierValue, MIGRATED_AT, MIGRATED_AT, MIGRATED_AT);
  }
  database.prepare(`
    INSERT OR REPLACE INTO loan_migration_receipts (id, payload)
    VALUES ('immutable-before-cutover', '{"status":"issued"}')
  `).run();
  if (withLoanItem) {
    database.prepare("INSERT INTO loans (id) VALUES ('loan-legacy-1')").run();
    database.prepare(`
      INSERT INTO loan_items (
        id, loan_id, position, article_number, description_snapshot,
        serial_number, quantity, condition_out, condition_return,
        item_note, created_at, updated_at
      ) VALUES (
        'loan-item-legacy-1', 'loan-legacy-1', 1, ?, 'Belegtext bleibt unveraendert',
        'SN-42', 1, 'gut', '', 'historische Notiz', ?, ?
      )
    `).run(articleNumber, MIGRATED_AT, MIGRATED_AT);
  }
}

function tradeFotoSnapshot({
  articleNumber = "093757",
  sourceArticleKey = "0000000093757",
  description = "TradeFoto Artikelbeschreibung",
  identifierValue = EAN,
  snapshotAt = "2026-09-03T10:00:00.000Z",
  sourceFileSha256 = "f".repeat(64),
} = {}) {
  const articles = [{
    sourceArticleKey,
    articleNumber,
    description,
    active: true,
    sourceUpdatedAt: snapshotAt,
    identifiers: identifierValue ? [{
      identifierType: "ean13",
      identifierValue,
      isPrimary: true,
      sourceField: "EAN",
      sourceRank: 1,
    }] : [],
    prices: [],
  }];
  return {
    sourceSystem: "tradefoto.artikel_stamm",
    sourceProfileVersion: "tradefoto-article-v1",
    sourceSchemaSha256: "a".repeat(64),
    sourceFileSha256,
    contentSha256: salesArticleImportContentSha256(articles),
    snapshotAt,
    articles,
  };
}

test("Legacy-Leihnummer ergibt nur einen vorgemerkten, nicht behaupteten TradeFoto-Quellschluessel", () => {
  assert.equal(sourceKeyForTradeFotoArticleNumber("093757"), "0000000093757");
  assert.throws(
    () => sourceKeyForTradeFotoArticleNumber("93757"),
    { code: "CENTRAL_ARTICLE_LEGACY_NUMBER_INVALID" },
  );
});

test("Leih-Laufzeit und F18-Import verwenden ausschliesslich den zentralen Artikelstamm", () => {
  const repositoryRoot = path.join(__dirname, "..");
  const loanCatalogSource = fs.readFileSync(path.join(
    repositoryRoot,
    "lib/persistence/catalogs/loan-module-catalog.js",
  ), "utf8");
  const applicationSchemaSource = fs.readFileSync(path.join(
    repositoryRoot,
    "lib/persistence/sqlite/operations/application-schema.js",
  ), "utf8");
  const serverSource = fs.readFileSync(path.join(repositoryRoot, "server.js"), "utf8");
  const f18Start = serverSource.indexOf("async function insertF18Migration");
  const f18End = serverSource.indexOf(
    'app.get("/api/portal/v1/loans/articles"',
    f18Start,
  );

  assert.match(loanCatalogSource, /\bFROM\s+sales_articles\b/i);
  assert.match(loanCatalogSource, /\bJOIN\s+sales_article_revisions\b/i);
  assert.match(loanCatalogSource, /\bFROM\s+sales_article_identifiers\b/i);
  assert.doesNotMatch(
    loanCatalogSource,
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:articles|article_identifiers)\b/i,
  );
  assert.doesNotMatch(
    applicationSchemaSource,
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:articles|article_identifiers)\b/i,
  );
  assert.ok(f18Start >= 0 && f18End > f18Start, "F18-Migrationsfunktion muss auffindbar sein");
  const f18Source = serverSource.slice(f18Start, f18End);
  assert.match(f18Source, /saveArticleRecord\s*\(/);
  assert.match(f18Source, /catalogRepository:\s*repositories\.salesArticleCatalog/);
  assert.doesNotMatch(
    f18Source,
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:articles|article_identifiers)\b/i,
  );
});
