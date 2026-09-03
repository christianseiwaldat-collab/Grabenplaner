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
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteLegacyDatabase,
  createSqlitePersistenceProvider,
} = require("../lib/persistence/sqlite/provider");
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

async function importTradeFoto(database, snapshot, timestamp = snapshot.snapshotAt) {
  const provider = createSqlitePersistenceProvider({
    database,
    catalog: SQLITE_SALES_ARTICLE_CATALOG,
    closeDatabase: false,
    initializeConnection: false,
  });
  try {
    return await createSalesArticleCatalogRepository(provider).importSnapshot({
      snapshot,
      actor: "419",
      timestamp,
    });
  } finally {
    await provider.close();
  }
}

function runStartup(database, {
  databaseExistedBeforeOpen = false,
  onBackup = () => {},
} = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.92.24-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

test("Zentrale Leihartikelmigration laesst eine vollstaendig frische Datenbank unangetastet", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    assert.equal(inspectSqliteCentralArticleLoanMigration(database).required, false);
    ensureSqliteSalesArticleCatalogSchema(database);
    assert.equal(inspectSqliteCentralArticleLoanMigration(database).required, false);
    assert.deepEqual(migrateSqliteCentralArticleLoans(database), {
      migrated: false,
      articleCount: 0,
      identifierCount: 0,
      loanItemCount: 0,
    });
  } finally {
    database.close();
  }
});

test("Legacy-Leihnummer ergibt nur einen vorgemerkten, nicht behaupteten TradeFoto-Quellschluessel", () => {
  assert.equal(sourceKeyForTradeFotoArticleNumber("093757"), "0000000093757");
  assert.throws(
    () => sourceKeyForTradeFotoArticleNumber("93757"),
    { code: "CENTRAL_ARTICLE_LEGACY_NUMBER_INVALID" },
  );
});

test("Legacy-Leihartikel und historische Beleg-Snapshots werden verlustfrei zentralisiert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    installLegacyLoanCatalog(database);
    database.prepare(`
      UPDATE articles
      SET source_product_number = 'MAN-093757',
          source_url = 'https://example.test/manual/093757',
          source_fetched_at = '2026-09-02T08:00:00.000Z',
          created_by = 'legacy-creator',
          updated_by = 'legacy-editor',
          created_at = '2026-08-01T07:00:00.000Z',
          updated_at = '2026-09-02T08:30:00.000Z'
      WHERE article_number = '093757'
    `).run();
    database.prepare(`
      UPDATE article_identifiers
      SET verified_at = '2026-08-02T09:00:00.000Z',
          created_by = 'identifier-creator',
          updated_by = 'identifier-editor',
          created_at = '2026-08-02T08:00:00.000Z',
          updated_at = '2026-08-03T10:00:00.000Z'
      WHERE article_number = '093757'
    `).run();
    const receiptBefore = database.prepare("SELECT * FROM loan_migration_receipts").all();
    const before = inspectSqliteCentralArticleLoanMigration(database);
    assert.equal(before.required, true);
    assert.equal(before.centralArticles, false);

    ensureSqliteSalesArticleCatalogSchema(database);
    const result = migrateSqliteCentralArticleLoans(database, { timestamp: MIGRATED_AT });
    assert.deepEqual({
      migrated: result.migrated,
      articleCount: result.articleCount,
      identifierCount: result.identifierCount,
      loanItemCount: result.loanItemCount,
      createdArticleCount: result.createdArticleCount,
      reusedArticleCount: result.reusedArticleCount,
    }, {
      migrated: true,
      articleCount: 1,
      identifierCount: 1,
      loanItemCount: 1,
      createdArticleCount: 1,
      reusedArticleCount: 0,
    });
    assert.equal(tableExists(database, "articles"), false);
    assert.equal(tableExists(database, "article_identifiers"), false);
    assert.equal(inspectSqliteCentralArticleLoanMigration(database).required, false);

    const product = database.prepare(`
      SELECT product_id, article_number, source_system, source_article_key, current_revision,
             created_by, updated_by, created_at, updated_at
      FROM sales_articles
    `).get();
    assert.deepEqual({
      article_number: product.article_number,
      source_system: product.source_system,
      source_article_key: product.source_article_key,
      current_revision: Number(product.current_revision),
      created_by: product.created_by,
      updated_by: product.updated_by,
      created_at: product.created_at,
      updated_at: product.updated_at,
    }, {
      article_number: "093757",
      source_system: "legacy.loan_articles",
      source_article_key: "093757",
      current_revision: 1,
      created_by: "legacy-creator",
      updated_by: "legacy-editor",
      created_at: "2026-08-01T07:00:00.000Z",
      updated_at: "2026-09-02T08:30:00.000Z",
    });
    assert.deepEqual({ ...database.prepare(`
      SELECT match_method, match_confidence, matched_source_system, matched_source_article_key,
             source_provider, source_product_number, source_url, source_fetched_at,
             source_created_by, source_updated_by, source_created_at, source_updated_at
      FROM sales_article_source_links
      WHERE source_system = 'legacy.loan_articles' AND source_article_key = '093757'
    `).get() }, {
      match_method: "legacy_migration",
      match_confidence: "authoritative",
      matched_source_system: null,
      matched_source_article_key: null,
      source_provider: "manual",
      source_product_number: "MAN-093757",
      source_url: "https://example.test/manual/093757",
      source_fetched_at: "2026-09-02T08:00:00.000Z",
      source_created_by: "legacy-creator",
      source_updated_by: "legacy-editor",
      source_created_at: "2026-08-01T07:00:00.000Z",
      source_updated_at: "2026-09-02T08:30:00.000Z",
    });
    assert.deepEqual({ ...database.prepare(`
      SELECT source_provider, verified_at, created_by, updated_by, created_at, updated_at,
             equivalent_identifiers_json
      FROM sales_article_identifiers
    `).get() }, {
      source_provider: "manual",
      verified_at: "2026-08-02T09:00:00.000Z",
      created_by: "identifier-creator",
      updated_by: "identifier-editor",
      created_at: "2026-08-02T08:00:00.000Z",
      updated_at: "2026-08-03T10:00:00.000Z",
      equivalent_identifiers_json: "[]",
    });
    assert.deepEqual({ ...database.prepare(`
      SELECT product_id, product_revision_snapshot, article_number_snapshot,
             description_snapshot, serial_number, item_note
      FROM loan_items WHERE id = 'loan-item-legacy-1'
    `).get() }, {
      product_id: product.product_id,
      product_revision_snapshot: 1,
      article_number_snapshot: "093757",
      description_snapshot: "Belegtext bleibt unveraendert",
      serial_number: "SN-42",
      item_note: "historische Notiz",
    });
    assert.deepEqual(database.prepare("SELECT * FROM loan_migration_receipts").all(), receiptBefore);
    assert.deepEqual(database.prepare(`
      SELECT action FROM audit_log ORDER BY id
    `).all().map((row) => row.action), [
      "sales.article-catalog.source-link",
      "sales.article-catalog.legacy-loans.migrate",
    ]);
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(database.prepare("PRAGMA foreign_key_check").get(), undefined);
    assert.equal(migrateSqliteCentralArticleLoans(database).migrated, false);
  } finally {
    database.close();
  }
});

test("Spaeterer TradeFoto-Import bindet dieselbe Produktidentitaet und belaesst Leihbelege historisch", async () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    installLegacyLoanCatalog(database);
    ensureSqliteSalesArticleCatalogSchema(database);
    migrateSqliteCentralArticleLoans(database, { timestamp: MIGRATED_AT });
    const before = database.prepare(`
      SELECT product_id, current_revision FROM sales_articles WHERE article_number = '093757'
    `).get();

    await importTradeFoto(database, tradeFotoSnapshot());

    const after = database.prepare(`
      SELECT product_id, current_revision FROM sales_articles WHERE article_number = '093757'
    `).get();
    assert.equal(after.product_id, before.product_id);
    assert.equal(Number(after.current_revision), 2);
    assert.deepEqual({ ...database.prepare(`
      SELECT product_id, match_method, match_confidence,
             matched_source_system, matched_source_article_key
      FROM sales_article_source_links
      WHERE source_system = 'tradefoto.artikel_stamm'
    `).get() }, {
      product_id: before.product_id,
      match_method: "article_number_exact",
      match_confidence: "exact",
      matched_source_system: "legacy.loan_articles",
      matched_source_article_key: "093757",
    });
    assert.deepEqual({ ...database.prepare(`
      SELECT product_id, product_revision_snapshot, article_number_snapshot, description_snapshot
      FROM loan_items WHERE id = 'loan-item-legacy-1'
    `).get() }, {
      product_id: before.product_id,
      product_revision_snapshot: 1,
      article_number_snapshot: "093757",
      description_snapshot: "Belegtext bleibt unveraendert",
    });
  } finally {
    database.close();
  }
});

test("Cutover verwendet einen vorbefuellten eindeutigen Zentralartikel ohne neue Produktidentitaet", async () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec(`
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
    ensureSqliteSalesArticleCatalogSchema(database);
    await importTradeFoto(database, tradeFotoSnapshot({ description: "Bereits zentral" }));
    const centralBefore = database.prepare(`
      SELECT product_id, current_revision FROM sales_articles WHERE article_number = '093757'
    `).get();
    installLegacyLoanCatalog(database);

    const result = migrateSqliteCentralArticleLoans(database, { timestamp: MIGRATED_AT });

    assert.equal(result.createdArticleCount, 0);
    assert.equal(result.reusedArticleCount, 1);
    assert.deepEqual(database.prepare(`
      SELECT product_id, current_revision FROM sales_articles WHERE article_number = '093757'
    `).get(), centralBefore);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sales_article_revisions").get().count, 1);
    assert.deepEqual({ ...database.prepare(`
      SELECT product_id, match_method, match_confidence,
             matched_source_system, matched_source_article_key
      FROM sales_article_source_links
      WHERE source_system = 'legacy.loan_articles'
    `).get() }, {
      product_id: centralBefore.product_id,
      match_method: "article_number_exact",
      match_confidence: "exact",
      matched_source_system: "tradefoto.artikel_stamm",
      matched_source_article_key: "0000000093757",
    });
    assert.equal(database.prepare(`
      SELECT product_revision_snapshot FROM loan_items WHERE id = 'loan-item-legacy-1'
    `).get().product_revision_snapshot, 1);
  } finally {
    database.close();
  }
});

test("Mehrdeutiger GTIN-Besitz stoppt den Cutover und erhaelt den Legacy-Stand", async () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec(`
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
    ensureSqliteSalesArticleCatalogSchema(database);
    await importTradeFoto(database, tradeFotoSnapshot({
      articleNumber: "654321",
      sourceArticleKey: "0000000654321",
      description: "Anderes Produkt mit derselben GTIN",
      sourceFileSha256: "1".repeat(64),
    }));
    await importTradeFoto(database, tradeFotoSnapshot({
      description: "Zentralartikel ohne Barcode",
      identifierValue: null,
      sourceFileSha256: "2".repeat(64),
      snapshotAt: "2026-09-03T10:01:00.000Z",
    }));
    installLegacyLoanCatalog(database);
    const articleCountBefore = database.prepare("SELECT COUNT(*) AS count FROM sales_articles")
      .get().count;
    const snapshotCountBefore = database.prepare(`
      SELECT COUNT(*) AS count FROM sales_article_import_snapshots
    `).get().count;

    assert.throws(
      () => migrateSqliteCentralArticleLoans(database, { timestamp: MIGRATED_AT }),
      { code: "CENTRAL_ARTICLE_IDENTIFIER_CONFLICT" },
    );

    assert.equal(tableExists(database, "articles"), true);
    assert.equal(tableExists(database, "article_identifiers"), true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM loan_items").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sales_articles").get().count,
      articleCountBefore);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sales_article_import_snapshots
    `).get().count, snapshotCountBefore);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM sales_article_source_links
      WHERE source_system = 'legacy.loan_articles'
    `).get().count, 0);
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    database.close();
  }
});

test("Fehlende Ursprungslinks bestehender Zentralartikel werden einmalig belegt und auditiert", async () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec(`
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
    ensureSqliteSalesArticleCatalogSchema(database);
    await importTradeFoto(database, tradeFotoSnapshot());
    database.exec(`
      DROP TRIGGER trg_sales_article_source_links_immutable_delete;
      DELETE FROM sales_article_source_links;
    `);
    ensureSqliteSalesArticleCatalogSchema(database);
    assert.equal(inspectSqliteCentralArticleLoanMigration(database).missingOriginSourceLinks, 1);

    const result = migrateSqliteCentralArticleLoans(database, { timestamp: MIGRATED_AT });

    assert.equal(result.migrated, true);
    assert.equal(result.sourceLinkBackfillCount, 1);
    assert.deepEqual({ ...database.prepare(`
      SELECT source_system, source_article_key, match_method, match_confidence
      FROM sales_article_source_links
    `).get() }, {
      source_system: "tradefoto.artikel_stamm",
      source_article_key: "0000000093757",
      match_method: "source_import",
      match_confidence: "authoritative",
    });
    assert.equal(database.prepare(`
      SELECT action FROM audit_log ORDER BY id DESC LIMIT 1
    `).get().action, "sales.article-catalog.source-links.backfill");
    assert.equal(migrateSqliteCentralArticleLoans(database).migrated, false);
  } finally {
    database.close();
  }
});

test("Ursprungslink-Backfill scheitert geschlossen ohne Snapshot desselben Quellsystems", async () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    database.exec(`
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
    ensureSqliteSalesArticleCatalogSchema(database);
    await importTradeFoto(database, tradeFotoSnapshot());
    database.exec(`
      DROP TRIGGER trg_sales_article_source_links_immutable_delete;
      DROP TRIGGER trg_sales_article_import_snapshots_immutable_update;
      DELETE FROM sales_article_source_links;
      UPDATE sales_article_import_snapshots SET source_system = 'unknown.legacy';
    `);
    ensureSqliteSalesArticleCatalogSchema(database);

    assert.throws(
      () => migrateSqliteCentralArticleLoans(database, { timestamp: MIGRATED_AT }),
      { code: "CENTRAL_ARTICLE_SOURCE_LINK_SNAPSHOT_MISSING" },
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sales_article_source_links")
      .get().count, 0);
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    database.close();
  }
});

test("Startup legt vor dem Cutover ein Backup an und mutiert erst danach das zentrale Schema", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const observations = [];
  try {
    runStartup(database);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE loan_items;
      DROP TABLE sales_article_identifiers;
      DROP TABLE sales_article_identifier_owners;
      DROP TABLE sales_article_price_snapshots;
      DROP TABLE sales_article_source_links;
      DROP TABLE sales_article_revisions;
      DROP TABLE sales_articles;
      DROP TABLE sales_article_import_snapshots;
      DELETE FROM schema_migrations WHERE id = '${CENTRAL_ARTICLE_LOAN_MIGRATION_ID}';
    `);
    installLegacyLoanCatalog(database, { withLoanItem: false, identifierValue: null });
    database.exec("PRAGMA foreign_keys = ON");

    const result = runStartup(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => observations.push({
        centralTablePresent: tableExists(database, "sales_articles"),
        legacyArticle: database.prepare("SELECT article_number FROM articles").get().article_number,
      }),
    });

    assert.deepEqual(observations, [{
      centralTablePresent: false,
      legacyArticle: "093757",
    }]);
    assert.equal(result.centralArticleLoanMigrationResult.migrated, true);
    assert.equal(tableExists(database, "articles"), false);
    assert.equal(tableExists(database, "sales_articles"), true);
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    database.close();
  }
});

test("Startup dedupliziert aequivalente Legacy-UPC- und EAN-Beobachtungen", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runStartup(database);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE loan_items;
      DROP TABLE sales_article_identifiers;
      DROP TABLE sales_article_identifier_owners;
      DROP TABLE sales_article_price_snapshots;
      DROP TABLE sales_article_source_links;
      DROP TABLE sales_article_revisions;
      DROP TABLE sales_articles;
      DROP TABLE sales_article_import_snapshots;
      DELETE FROM schema_migrations WHERE id = '${CENTRAL_ARTICLE_LOAN_MIGRATION_ID}';
    `);
    installLegacyLoanCatalog(database, {
      identifierValue: "036000291452",
      withLoanItem: false,
    });
    database.exec("UPDATE article_identifiers SET identifier_type = 'upca'");
    database.prepare(`
      INSERT INTO article_identifiers (
        article_number, identifier_type, identifier_value, source_provider,
        verified_at, created_by, updated_by, created_at, updated_at
      ) VALUES ('093757', 'ean13', '0036000291452', 'import', ?, '419', '419', ?, ?)
    `).run(MIGRATED_AT, MIGRATED_AT, MIGRATED_AT);
    database.exec("PRAGMA foreign_keys = ON");

    assert.doesNotThrow(() => runStartup(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => {},
    }));
    const identifier = database.prepare(`
      SELECT canonical_gtin14, equivalent_identifiers_json
      FROM sales_article_identifiers
    `).get();
    assert.equal(identifier.canonical_gtin14, "00036000291452");
    assert.deepEqual(
      new Set(JSON.parse(identifier.equivalent_identifiers_json)
        .map((entry) => entry.identifierValue)),
      new Set(["036000291452", "0036000291452"]),
    );
    assert.equal(database.prepare(`
      SELECT product_id FROM sales_article_identifier_owners
      WHERE canonical_gtin14 = '00036000291452'
    `).get().product_id, database.prepare(`
      SELECT product_id FROM sales_articles WHERE article_number = '093757'
    `).get().product_id);
  } finally {
    database.close();
  }
});

test("Leih-Laufzeit und F18-Import verwenden ausschliesslich den zentralen Artikelstamm", () => {
  const repositoryRoot = path.join(__dirname, "..");
  const loanCatalogSource = fs.readFileSync(path.join(
    repositoryRoot,
    "lib/persistence/sqlite/loan-module-catalog.js",
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
