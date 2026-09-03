"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteSalesArticleCatalogSchema,
} = require("../lib/persistence/sqlite/operations/sales-article-catalog-schema");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

const SNAPSHOT_ID = "a".repeat(64);
const IDEMPOTENCY_KEY = "b".repeat(64);
const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "2026-09-03T08:00:00.000Z";

function fixture() {
  const database = openSqliteLegacyDatabase(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  ensureSqliteSalesArticleCatalogSchema(database);
  return database;
}

function insertSnapshot(database) {
  database.prepare(`
    INSERT INTO sales_article_import_snapshots (
      id, idempotency_key, source_system, source_profile_version, source_schema_sha256,
      source_file_sha256, content_sha256,
      snapshot_at, article_count, identifier_count, price_count, imported_by, imported_at
    ) VALUES (?, ?, 'tradefoto', 'tradefoto-article-v1', ?, ?, ?, ?, 1, 1, 4, 'tester', ?)
  `).run(
    SNAPSHOT_ID,
    IDEMPOTENCY_KEY,
    "c".repeat(64),
    "e".repeat(64),
    "d".repeat(64),
    TIMESTAMP,
    TIMESTAMP,
  );
}

function insertArticleGraph(database) {
  database.exec("BEGIN");
  try {
    insertSnapshot(database);
    database.prepare(`
      INSERT INTO sales_articles (
        product_id, article_number, source_system, source_article_key, current_revision,
        created_by, created_at, updated_by, updated_at
      ) VALUES (?, '093757', 'tradefoto', '0000000093757', 1, 'tester', ?, 'tester', ?)
    `).run(PRODUCT_ID, TIMESTAMP, TIMESTAMP);
    database.prepare(`
      INSERT INTO sales_article_revisions (
        product_id, revision, article_number, description, active, source_snapshot_id,
        source_updated_at, created_by, created_at
      ) VALUES (?, 1, '093757', 'Synthetischer Testartikel', 1, ?, NULL, 'tester', ?)
    `).run(PRODUCT_ID, SNAPSHOT_ID, TIMESTAMP);
    database.prepare(`
      INSERT INTO sales_article_source_links (
        product_id, source_system, source_article_key, source_snapshot_id,
        match_method, match_confidence, matched_source_system,
        matched_source_article_key, linked_by, linked_at
      ) VALUES (?, 'tradefoto', '0000000093757', ?, 'source_import',
        'authoritative', NULL, NULL, 'tester', ?)
    `).run(PRODUCT_ID, SNAPSHOT_ID, TIMESTAMP);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function insertPrice(database, {
  id,
  priceType,
  amount,
  priceBasis = "gross",
  qualityStatus = "confirmed",
  sourceField,
}) {
  return database.prepare(`
    INSERT INTO sales_article_price_snapshots (
      id, product_id, source_snapshot_id, price_type, amount, currency,
      price_basis, quality_status, source_field, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 'tester', ?)
  `).run(
    id,
    PRODUCT_ID,
    SNAPSHOT_ID,
    priceType,
    amount,
    priceBasis,
    qualityStatus,
    sourceField,
    TIMESTAMP,
  );
}

test("SQLite-Sales-Artikelstamm ist idempotent und trennt Katalog und GTIN-Besitz", () => {
  const database = fixture();
  try {
    ensureSqliteSalesArticleCatalogSchema(database);
    const expected = new Set([
      "sales_article_import_snapshots",
      "sales_article_import_findings",
      "sales_article_import_run_metadata",
      "sales_article_import_impacts",
      "sales_articles",
      "sales_article_revisions",
      "sales_article_source_links",
      "sales_article_identifier_owners",
      "sales_article_identifiers",
      "sales_article_price_snapshots",
    ]);
    const actual = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'sales_article%'
    `).all().map(({ name }) => name);
    assert.deepEqual(new Set(actual), expected);
    const indexes = new Set(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'sales_article_identifiers'
    `).all().map(({ name }) => name));
    assert.equal(indexes.has("idx_sales_article_identifiers_product"), true);
    const sourceLinkIndexes = new Set(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'sales_article_source_links'
    `).all().map(({ name }) => name));
    assert.equal(sourceLinkIndexes.has("idx_sales_article_source_links_product"), true);
    const findingIndexes = new Set(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'sales_article_import_findings'
    `).all().map(({ name }) => name));
    assert.equal(findingIndexes.has("idx_sales_article_import_findings_code"), true);
    const impactIndexes = new Set(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'sales_article_import_impacts'
    `).all().map(({ name }) => name));
    assert.equal(impactIndexes.has("idx_sales_article_import_impacts_product"), true);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("Kanonische GTIN gehoert global genau einem Produkt", () => {
  const database = fixture();
  const secondSnapshotId = "2".repeat(64);
  const secondProductId = "99999999-9999-4999-8999-999999999999";
  try {
    insertArticleGraph(database);
    database.prepare(`
      INSERT INTO sales_article_identifiers (
        id, product_id, source_snapshot_id, identifier_type, identifier_value,
        canonical_gtin14, is_primary, source_field, source_rank,
        verified_at, created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, ?, 'upca', '036000291452', '00036000291452', 1,
        'UPC', 1, ?, 'tester', ?, 'tester', ?)
    `).run(
      "22222222-2222-4222-8222-222222222222",
      PRODUCT_ID,
      SNAPSHOT_ID,
      TIMESTAMP,
      TIMESTAMP,
      TIMESTAMP,
    );
    database.exec("BEGIN");
    database.prepare(`
      INSERT INTO sales_article_import_snapshots (
        id, idempotency_key, source_system, source_profile_version,
        source_schema_sha256, source_file_sha256, content_sha256, snapshot_at,
        article_count, identifier_count, price_count, imported_by, imported_at
      ) VALUES (?, ?, 'other', 'other-v1', ?, ?, ?, ?, 1, 1, 0, 'tester', ?)
    `).run(
      secondSnapshotId,
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
      "6".repeat(64),
      TIMESTAMP,
      TIMESTAMP,
    );
    database.prepare(`
      INSERT INTO sales_articles (
        product_id, article_number, source_system, source_article_key,
        current_revision, created_by, created_at, updated_by, updated_at
      ) VALUES (?, '654321', 'other', '654321', 1, 'tester', ?, 'tester', ?)
    `).run(secondProductId, TIMESTAMP, TIMESTAMP);
    database.prepare(`
      INSERT INTO sales_article_revisions (
        product_id, revision, article_number, description, active,
        source_snapshot_id, source_updated_at, created_by, created_at
      ) VALUES (?, 1, '654321', 'Anderes Produkt', 1, ?, NULL, 'tester', ?)
    `).run(secondProductId, secondSnapshotId, TIMESTAMP);
    database.exec("COMMIT");

    assert.throws(() => database.prepare(`
      INSERT INTO sales_article_identifiers (
        id, product_id, source_snapshot_id, identifier_type, identifier_value,
        canonical_gtin14, is_primary, source_field, source_rank,
        verified_at, created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, ?, 'ean13', '0036000291452', '00036000291452', 1,
        'EAN', 1, ?, 'tester', ?, 'tester', ?)
    `).run(
      "33333333-3333-4333-8333-333333333333",
      secondProductId,
      secondSnapshotId,
      TIMESTAMP,
      TIMESTAMP,
      TIMESTAMP,
    ), /sales-article-identifier-owner-conflict/);
    assert.equal(database.prepare(`
      SELECT product_id FROM sales_article_identifier_owners
      WHERE canonical_gtin14 = '00036000291452'
    `).get().product_id, PRODUCT_ID);
  } finally {
    database.close();
  }
});

test("SQLite erzwingt getrimmte Kerndaten und kanonisch eindeutige GTIN-14", () => {
  const database = fixture();
  try {
    database.exec("BEGIN");
    insertSnapshot(database);
    assert.throws(() => database.prepare(`
      INSERT INTO sales_articles (
        product_id, article_number, source_system, source_article_key, current_revision,
        created_by, created_at, updated_by, updated_at
      ) VALUES (?, ' 093757', 'tradefoto', '0000000093757', 1, 'tester', ?, 'tester', ?)
    `).run(PRODUCT_ID, TIMESTAMP, TIMESTAMP), /CHECK constraint failed/);
    database.exec("ROLLBACK");

    insertArticleGraph(database);
    const insertIdentifier = database.prepare(`
      INSERT INTO sales_article_identifiers (
        id, product_id, source_snapshot_id, identifier_type, identifier_value,
        canonical_gtin14, is_primary, source_field, source_rank,
        verified_at, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ARTIKEL_ZWEITEAN.ZweitEAN', ?, ?, 'tester', ?)
    `);
    insertIdentifier.run(
      "22222222-2222-4222-8222-222222222222",
      PRODUCT_ID,
      SNAPSHOT_ID,
      "upca",
      "036000291452",
      "00036000291452",
      1,
      1,
      TIMESTAMP,
      TIMESTAMP,
    );
    assert.throws(() => insertIdentifier.run(
      "33333333-3333-4333-8333-333333333333",
      PRODUCT_ID,
      SNAPSHOT_ID,
      "ean13",
      "0036000291452",
      "00036000291452",
      0,
      2,
      TIMESTAMP,
      TIMESTAMP,
    ), /UNIQUE constraint failed/);
    assert.throws(() => insertIdentifier.run(
      "44444444-4444-4444-8444-444444444444",
      PRODUCT_ID,
      SNAPSHOT_ID,
      "ean13",
      "4006381333931",
      "00000000000000",
      0,
      3,
      TIMESTAMP,
      TIMESTAMP,
    ), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});

test("Der aktuelle Revisionszeiger ist deferrable, aber niemals verwaist", () => {
  const database = fixture();
  try {
    insertArticleGraph(database);
    const current = database.prepare(`
      SELECT article_number, current_revision FROM sales_articles
    `).get();
    assert.equal(current.article_number, "093757");
    assert.equal(current.current_revision, 1);

    database.exec("BEGIN");
    database.prepare(`
      INSERT INTO sales_articles (
        product_id, article_number, source_system, source_article_key, current_revision,
        created_by, created_at, updated_by, updated_at
      ) VALUES (?, '999999', 'other', 'missing-revision', 1, 'tester', ?, 'tester', ?)
    `).run("99999999-9999-4999-8999-999999999999", TIMESTAMP, TIMESTAMP);
    assert.throws(() => database.exec("COMMIT"), /FOREIGN KEY constraint failed/);
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sales_articles").get().count, 1);
  } finally {
    database.close();
  }
});

test("Preis-Snapshots erhalten NULL, Null, hohe Präzision sowie quarantänisierte Negativwerte", () => {
  const database = fixture();
  try {
    insertArticleGraph(database);
    insertPrice(database, {
      id: "22222222-2222-4222-8222-222222222222",
      priceType: "sales",
      amount: "13.671442678740",
      sourceField: "Verkaufspreis",
    });
    insertPrice(database, {
      id: "33333333-3333-4333-8333-333333333333",
      priceType: "internet_2",
      amount: "0.000000000000",
      sourceField: "InternetVK2",
    });
    insertPrice(database, {
      id: "44444444-4444-4444-8444-444444444444",
      priceType: "internet_2",
      amount: null,
      priceBasis: "net",
      qualityStatus: "unresolved",
      sourceField: "InternetVKN2",
    });
    insertPrice(database, {
      id: "55555555-5555-4555-8555-555555555555",
      priceType: "internet_5",
      amount: "-1.250000000000",
      qualityStatus: "quarantined",
      sourceField: "InternetVK5",
    });

    const values = database.prepare(`
      SELECT source_field, amount, quality_status
      FROM sales_article_price_snapshots ORDER BY source_field
    `).all();
    assert.equal(values.length, 4);
    assert.equal(values.find(({ source_field }) => source_field === "InternetVKN2").amount, null);
    assert.equal(
      values.find(({ source_field }) => source_field === "Verkaufspreis").amount,
      "13.671442678740",
    );

    assert.throws(() => insertPrice(database, {
      id: "66666666-6666-4666-8666-666666666666",
      priceType: "other",
      amount: "13.67",
      sourceField: "Malformed",
    }), /CHECK constraint failed/);
    assert.throws(() => insertPrice(database, {
      id: "77777777-7777-4777-8777-777777777777",
      priceType: "other",
      amount: "1234567890123456789.000000000000",
      sourceField: "Overflow",
    }), /CHECK constraint failed/);
    assert.throws(() => insertPrice(database, {
      id: "88888888-8888-4888-8888-888888888888",
      priceType: "other",
      amount: "-1.000000000000",
      sourceField: "NotQuarantined",
    }), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});

test("Revisions-, Identifier-, Preis- und Importzeilen sind unveränderlich", () => {
  const database = fixture();
  try {
    insertArticleGraph(database);
    database.prepare(`
      INSERT INTO sales_article_identifiers (
        id, product_id, source_snapshot_id, identifier_type, identifier_value,
        canonical_gtin14, is_primary, source_field, source_rank,
        verified_at, created_by, created_at
      ) VALUES (?, ?, ?, 'ean13', '4006381333931', '04006381333931', 1, 'EAN', 1,
        ?, 'tester', ?)
    `).run(
      "22222222-2222-4222-8222-222222222222",
      PRODUCT_ID,
      SNAPSHOT_ID,
      TIMESTAMP,
      TIMESTAMP,
    );
    insertPrice(database, {
      id: "33333333-3333-4333-8333-333333333333",
      priceType: "sales",
      amount: "1.000000000000",
      sourceField: "Verkaufspreis",
    });
    database.prepare(`
      INSERT INTO sales_article_import_findings (
        snapshot_id, ordinal, source_row, article_number, code, detail_sha256,
        created_by, created_at
      ) VALUES (?, 1, 1, '123456', 'negative_price', ?, 'tester', ?)
    `).run(SNAPSHOT_ID, "f".repeat(64), TIMESTAMP);
    database.prepare(`
      INSERT INTO sales_article_import_run_metadata (
        snapshot_id, total_count, create_count, update_count,
        unchanged_count, quarantined_count, created_by, created_at
      ) VALUES (?, 1, 1, 0, 0, 0, 'tester', ?)
    `).run(SNAPSHOT_ID, TIMESTAMP);
    database.prepare(`
      INSERT INTO sales_article_import_impacts (
        snapshot_id, ordinal, product_id, imported_revision,
        previous_current_revision, created_by, created_at
      ) VALUES (?, 1, ?, 1, NULL, 'tester', ?)
    `).run(SNAPSHOT_ID, PRODUCT_ID, TIMESTAMP);

    for (const [sql, marker] of [
      ["UPDATE sales_article_import_snapshots SET imported_by = 'other'", "import-snapshot"],
      ["UPDATE sales_article_import_findings SET code = 'other'", "import-finding"],
      ["UPDATE sales_article_import_run_metadata SET total_count = 0", "import-run-metadata"],
      ["UPDATE sales_article_import_impacts SET created_by = 'other'", "import-impact"],
      ["UPDATE sales_article_revisions SET description = 'other'", "revision"],
      ["UPDATE sales_article_source_links SET linked_by = 'other'", "source-link"],
      ["UPDATE sales_article_identifier_owners SET created_by = 'other'", "identifier-owner"],
      ["UPDATE sales_article_identifiers SET source_field = 'other'", "identifier"],
      ["UPDATE sales_article_price_snapshots SET source_field = 'other'", "price-snapshot"],
    ]) {
      assert.throws(() => database.exec(sql), new RegExp(`sales-article-${marker}-immutable`));
    }
    for (const [table, marker] of [
      ["sales_article_import_snapshots", "import-snapshot"],
      ["sales_article_import_findings", "import-finding"],
      ["sales_article_import_run_metadata", "import-run-metadata"],
      ["sales_article_import_impacts", "import-impact"],
      ["sales_article_revisions", "revision"],
      ["sales_article_source_links", "source-link"],
      ["sales_article_identifier_owners", "identifier-owner"],
      ["sales_article_identifiers", "identifier"],
      ["sales_article_price_snapshots", "price-snapshot"],
    ]) {
      assert.throws(
        () => database.exec(`DELETE FROM ${table}`),
        new RegExp(`sales-article-${marker}-immutable`),
      );
    }
  } finally {
    database.close();
  }
});

test("Identifier brauchen Produkt und Snapshot; Preise zusätzlich dessen Revision", () => {
  const database = fixture();
  try {
    insertArticleGraph(database);
    assert.throws(() => database.prepare(`
      INSERT INTO sales_article_identifiers (
        id, product_id, source_snapshot_id, identifier_type, identifier_value,
        canonical_gtin14, is_primary, source_field, source_rank,
        verified_at, created_by, created_at
      ) VALUES (?, ?, ?, 'ean13', '4006381333931', '04006381333931', 1, 'EAN', 1,
        ?, 'tester', ?)
    `).run(
      "22222222-2222-4222-8222-222222222222",
      "99999999-9999-4999-8999-999999999999",
      SNAPSHOT_ID,
      TIMESTAMP,
      TIMESTAMP,
    ), /FOREIGN KEY constraint failed/);
  } finally {
    database.close();
  }
});
