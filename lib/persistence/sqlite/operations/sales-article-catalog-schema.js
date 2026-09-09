"use strict";

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function columnExists(database, table, column) {
  return database.prepare(`PRAGMA table_info("${table}")`).all()
    .some((entry) => String(entry.name || "") === column);
}

function ensureColumn(database, table, column, definition) {
  if (!columnExists(database, table, column)) {
    database.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

function identifierOwnershipError(detail) {
  const error = new Error("Ein kanonischer GTIN-Identifier ist mehreren Produkten zugeordnet.");
  error.code = "SALES_ARTICLE_IDENTIFIER_OWNER_CONFLICT";
  error.detail = detail;
  return error;
}

function backfillIdentifierOwners(database) {
  const conflicts = database.prepare(`
    SELECT canonical_gtin14, COUNT(DISTINCT product_id) AS product_count
    FROM sales_article_identifiers
    GROUP BY canonical_gtin14
    HAVING COUNT(DISTINCT product_id) > 1
    ORDER BY canonical_gtin14
  `).all();
  if (conflicts.length) throw identifierOwnershipError(conflicts);
  database.exec(`
    INSERT OR IGNORE INTO sales_article_identifier_owners (
      canonical_gtin14, product_id, first_source_snapshot_id, created_by, created_at
    )
    SELECT identifier.canonical_gtin14,
           identifier.product_id,
           identifier.source_snapshot_id,
           identifier.created_by,
           identifier.created_at
    FROM sales_article_identifiers identifier
    WHERE identifier.id = (
      SELECT first_identifier.id
      FROM sales_article_identifiers first_identifier
      WHERE first_identifier.canonical_gtin14 = identifier.canonical_gtin14
      ORDER BY first_identifier.created_at, first_identifier.id
      LIMIT 1
    )
  `);
  const drift = database.prepare(`
    SELECT identifier.canonical_gtin14, identifier.product_id,
           owner.product_id AS owner_product_id
    FROM sales_article_identifiers identifier
    LEFT JOIN sales_article_identifier_owners owner
      ON owner.canonical_gtin14 = identifier.canonical_gtin14
    WHERE owner.product_id IS NULL OR owner.product_id <> identifier.product_id
    ORDER BY identifier.canonical_gtin14, identifier.product_id
    LIMIT 1
  `).get();
  if (drift) throw identifierOwnershipError(drift);
}

function ensureSqliteSalesArticleCatalogSchema(database) {
  const target = assertSqliteOperationsDatabase(database);
  target.exec(`
    CREATE TABLE IF NOT EXISTS sales_article_import_snapshots (
      id TEXT PRIMARY KEY
        CHECK(length(id) = 64 AND id = lower(id) AND id NOT GLOB '*[^0-9a-f]*'),
      idempotency_key TEXT NOT NULL UNIQUE
        CHECK(length(idempotency_key) = 64
          AND idempotency_key = lower(idempotency_key)
          AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
      source_system TEXT NOT NULL
        CHECK(length(source_system) BETWEEN 1 AND 80
          AND source_system = lower(source_system)
          AND source_system NOT GLOB '*[^a-z0-9._-]*'
          AND substr(source_system, 1, 1) GLOB '[a-z]'),
      source_profile_version TEXT NOT NULL
        CHECK(length(source_profile_version) BETWEEN 1 AND 64
          AND source_profile_version = lower(source_profile_version)
          AND source_profile_version NOT GLOB '*[^a-z0-9._-]*'
          AND substr(source_profile_version, 1, 1) GLOB '[a-z0-9]'),
      source_schema_sha256 TEXT NOT NULL
        CHECK(length(source_schema_sha256) = 64
          AND source_schema_sha256 = lower(source_schema_sha256)
          AND source_schema_sha256 NOT GLOB '*[^0-9a-f]*'),
      source_file_sha256 TEXT NOT NULL
        CHECK(length(source_file_sha256) = 64
          AND source_file_sha256 = lower(source_file_sha256)
          AND source_file_sha256 NOT GLOB '*[^0-9a-f]*'),
      content_sha256 TEXT NOT NULL
        CHECK(length(content_sha256) = 64
          AND content_sha256 = lower(content_sha256)
          AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
      snapshot_at TEXT NOT NULL CHECK(length(snapshot_at) = 24),
      article_count INTEGER NOT NULL CHECK(article_count >= 0),
      identifier_count INTEGER NOT NULL CHECK(identifier_count >= 0),
      price_count INTEGER NOT NULL CHECK(price_count >= 0),
      imported_by TEXT NOT NULL CHECK(length(imported_by) BETWEEN 1 AND 120),
      imported_at TEXT NOT NULL CHECK(length(imported_at) = 24),
      UNIQUE(
        source_system, source_profile_version, source_schema_sha256,
        source_file_sha256, content_sha256
      )
    );

    CREATE TABLE IF NOT EXISTS sales_article_import_findings (
      snapshot_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      source_row INTEGER NOT NULL CHECK(source_row BETWEEN 1 AND 25000),
      article_number TEXT
        CHECK(article_number IS NULL OR (
          article_number = trim(article_number)
          AND length(article_number) BETWEEN 1 AND 80
        )),
      code TEXT NOT NULL
        CHECK(length(code) BETWEEN 1 AND 80
          AND code = lower(code)
          AND code NOT GLOB '*[^a-z0-9_]*'),
      detail_sha256 TEXT NOT NULL
        CHECK(length(detail_sha256) = 64
          AND detail_sha256 = lower(detail_sha256)
          AND detail_sha256 NOT GLOB '*[^0-9a-f]*'),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      PRIMARY KEY (snapshot_id, ordinal),
      FOREIGN KEY (snapshot_id) REFERENCES sales_article_import_snapshots(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_article_import_findings_code
      ON sales_article_import_findings(snapshot_id, code, source_row);

    CREATE TABLE IF NOT EXISTS sales_article_import_run_metadata (
      snapshot_id TEXT PRIMARY KEY,
      total_count INTEGER NOT NULL CHECK(total_count BETWEEN 0 AND 25000),
      create_count INTEGER NOT NULL CHECK(create_count BETWEEN 0 AND 25000),
      update_count INTEGER NOT NULL CHECK(update_count BETWEEN 0 AND 25000),
      unchanged_count INTEGER NOT NULL CHECK(unchanged_count BETWEEN 0 AND 25000),
      quarantined_count INTEGER NOT NULL CHECK(quarantined_count BETWEEN 0 AND 25000),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      CHECK(total_count = create_count + update_count + unchanged_count + quarantined_count),
      FOREIGN KEY (snapshot_id) REFERENCES sales_article_import_snapshots(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS sales_articles (
      product_id TEXT PRIMARY KEY
        CHECK(length(product_id) = 36
          AND product_id = lower(product_id)
          AND product_id NOT GLOB '*[^0-9a-f-]*'
          AND substr(product_id, 9, 1) = '-'
          AND substr(product_id, 14, 1) = '-'
          AND substr(product_id, 19, 1) = '-'
          AND substr(product_id, 24, 1) = '-'
          AND length(replace(product_id, '-', '')) = 32
          AND substr(product_id, 15, 1) = '4'
          AND substr(product_id, 20, 1) GLOB '[89ab]'),
      article_number TEXT NOT NULL UNIQUE
        CHECK(article_number = trim(article_number)
          AND length(article_number) BETWEEN 1 AND 80),
      source_system TEXT NOT NULL
        CHECK(length(source_system) BETWEEN 1 AND 80
          AND source_system = lower(source_system)
          AND source_system NOT GLOB '*[^a-z0-9._-]*'
          AND substr(source_system, 1, 1) GLOB '[a-z]'),
      source_article_key TEXT NOT NULL
        CHECK(source_article_key = trim(source_article_key)
          AND length(source_article_key) BETWEEN 1 AND 160),
      current_revision INTEGER NOT NULL CHECK(current_revision > 0),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 120),
      updated_at TEXT NOT NULL CHECK(length(updated_at) = 24),
      UNIQUE(source_system, source_article_key),
      UNIQUE(product_id, current_revision),
      CHECK(created_at <= updated_at),
      FOREIGN KEY (product_id, current_revision)
        REFERENCES sales_article_revisions(product_id, revision)
        ON UPDATE CASCADE ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE IF NOT EXISTS sales_article_revisions (
      product_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      article_number TEXT NOT NULL
        CHECK(article_number = trim(article_number)
          AND length(article_number) BETWEEN 1 AND 80),
      description TEXT NOT NULL
        CHECK(description = trim(description)
          AND length(description) BETWEEN 1 AND 300),
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      source_snapshot_id TEXT NOT NULL,
      source_updated_at TEXT CHECK(source_updated_at IS NULL OR length(source_updated_at) = 24),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      PRIMARY KEY (product_id, revision),
      UNIQUE(product_id, revision, article_number),
      UNIQUE(source_snapshot_id, product_id),
      FOREIGN KEY (product_id) REFERENCES sales_articles(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (source_snapshot_id) REFERENCES sales_article_import_snapshots(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_article_revisions_snapshot
      ON sales_article_revisions(source_snapshot_id, product_id);

    CREATE TABLE IF NOT EXISTS sales_article_import_impacts (
      snapshot_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      product_id TEXT NOT NULL,
      imported_revision INTEGER NOT NULL CHECK(imported_revision > 0),
      previous_current_revision INTEGER CHECK(
        previous_current_revision IS NULL OR previous_current_revision > 0
      ),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      PRIMARY KEY (snapshot_id, ordinal),
      UNIQUE (snapshot_id, product_id),
      UNIQUE (product_id, imported_revision),
      CHECK(previous_current_revision IS NULL OR previous_current_revision <> imported_revision),
      FOREIGN KEY (snapshot_id) REFERENCES sales_article_import_snapshots(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (product_id, imported_revision)
        REFERENCES sales_article_revisions(product_id, revision)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (product_id, previous_current_revision)
        REFERENCES sales_article_revisions(product_id, revision)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_article_import_impacts_product
      ON sales_article_import_impacts(product_id, imported_revision);

    CREATE TABLE IF NOT EXISTS sales_article_source_links (
      product_id TEXT NOT NULL,
      source_system TEXT NOT NULL
        CHECK(length(source_system) BETWEEN 1 AND 80
          AND source_system = lower(source_system)
          AND source_system NOT GLOB '*[^a-z0-9._-]*'
          AND substr(source_system, 1, 1) GLOB '[a-z]'),
      source_article_key TEXT NOT NULL
        CHECK(source_article_key = trim(source_article_key)
          AND length(source_article_key) BETWEEN 1 AND 160),
      source_snapshot_id TEXT NOT NULL,
      match_method TEXT NOT NULL
        CHECK(match_method IN ('source_import', 'article_number_exact', 'legacy_migration', 'manual_review')),
      match_confidence TEXT NOT NULL
        CHECK(match_confidence IN ('authoritative', 'exact', 'reviewed')),
      matched_source_system TEXT,
      matched_source_article_key TEXT,
      source_provider TEXT NOT NULL DEFAULT '' CHECK(length(source_provider) <= 80),
      source_product_number TEXT NOT NULL DEFAULT ''
        CHECK(length(source_product_number) <= 1000),
      source_url TEXT NOT NULL DEFAULT '' CHECK(length(source_url) <= 4000),
      source_fetched_at TEXT CHECK(source_fetched_at IS NULL OR length(source_fetched_at) <= 80),
      source_created_by TEXT NOT NULL DEFAULT '' CHECK(length(source_created_by) <= 120),
      source_updated_by TEXT NOT NULL DEFAULT '' CHECK(length(source_updated_by) <= 120),
      source_created_at TEXT CHECK(source_created_at IS NULL OR length(source_created_at) <= 80),
      source_updated_at TEXT CHECK(source_updated_at IS NULL OR length(source_updated_at) <= 80),
      linked_by TEXT NOT NULL CHECK(length(linked_by) BETWEEN 1 AND 120),
      linked_at TEXT NOT NULL CHECK(length(linked_at) = 24),
      PRIMARY KEY (source_system, source_article_key),
      UNIQUE(product_id, source_system),
      CHECK((matched_source_system IS NULL) = (matched_source_article_key IS NULL)),
      CHECK(matched_source_system IS NULL OR (
        length(matched_source_system) BETWEEN 1 AND 80
        AND matched_source_system = lower(matched_source_system)
        AND matched_source_system NOT GLOB '*[^a-z0-9._-]*'
      )),
      CHECK(matched_source_article_key IS NULL OR (
        matched_source_article_key = trim(matched_source_article_key)
        AND length(matched_source_article_key) BETWEEN 1 AND 160
      )),
      FOREIGN KEY (product_id) REFERENCES sales_articles(product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (source_snapshot_id) REFERENCES sales_article_import_snapshots(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_article_source_links_product
      ON sales_article_source_links(product_id, source_system);

    CREATE TABLE IF NOT EXISTS sales_article_identifier_owners (
      canonical_gtin14 TEXT PRIMARY KEY
        CHECK(length(canonical_gtin14) = 14
          AND canonical_gtin14 NOT GLOB '*[^0-9]*'),
      product_id TEXT NOT NULL,
      first_source_snapshot_id TEXT NOT NULL,
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      UNIQUE(canonical_gtin14, product_id),
      FOREIGN KEY (product_id) REFERENCES sales_articles(product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (first_source_snapshot_id) REFERENCES sales_article_import_snapshots(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_article_identifier_owners_product
      ON sales_article_identifier_owners(product_id, canonical_gtin14);

    CREATE TABLE IF NOT EXISTS sales_article_identifiers (
      id TEXT PRIMARY KEY
        CHECK(length(id) = 36
          AND id = lower(id)
          AND id NOT GLOB '*[^0-9a-f-]*'
          AND substr(id, 9, 1) = '-'
          AND substr(id, 14, 1) = '-'
          AND substr(id, 19, 1) = '-'
          AND substr(id, 24, 1) = '-'
          AND length(replace(id, '-', '')) = 32
          AND substr(id, 15, 1) = '4'
          AND substr(id, 20, 1) GLOB '[89ab]'),
      product_id TEXT NOT NULL,
      source_snapshot_id TEXT NOT NULL,
      identifier_type TEXT NOT NULL
        CHECK(identifier_type IN ('ean8', 'upca', 'ean13', 'gtin14')),
      identifier_value TEXT NOT NULL
        CHECK(identifier_value NOT GLOB '*[^0-9]*'
          AND ((identifier_type = 'ean8' AND length(identifier_value) = 8)
            OR (identifier_type = 'upca' AND length(identifier_value) = 12)
            OR (identifier_type = 'ean13' AND length(identifier_value) = 13)
            OR (identifier_type = 'gtin14' AND length(identifier_value) = 14))),
      canonical_gtin14 TEXT NOT NULL
        CHECK(length(canonical_gtin14) = 14
          AND canonical_gtin14 NOT GLOB '*[^0-9]*'
          AND canonical_gtin14 = substr('00000000000000' || identifier_value, -14, 14)),
      is_primary INTEGER NOT NULL CHECK(is_primary IN (0, 1)),
      source_field TEXT NOT NULL
        CHECK(source_field = trim(source_field)
          AND length(source_field) BETWEEN 1 AND 80),
      source_rank INTEGER CHECK(source_rank IS NULL OR source_rank BETWEEN 0 AND 255),
      equivalent_identifiers_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(equivalent_identifiers_json)
          AND json_type(equivalent_identifiers_json) = 'array'),
      source_provider TEXT NOT NULL DEFAULT '' CHECK(length(source_provider) <= 80),
      verified_at TEXT NOT NULL CHECK(length(verified_at) = 24),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      updated_by TEXT NOT NULL DEFAULT '' CHECK(length(updated_by) <= 120),
      updated_at TEXT NOT NULL DEFAULT '' CHECK(length(updated_at) <= 24),
      UNIQUE(source_snapshot_id, canonical_gtin14),
      FOREIGN KEY (product_id) REFERENCES sales_articles(product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      FOREIGN KEY (source_snapshot_id) REFERENCES sales_article_import_snapshots(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_article_identifiers_primary
      ON sales_article_identifiers(product_id, source_snapshot_id)
      WHERE is_primary = 1;
    CREATE INDEX IF NOT EXISTS idx_sales_article_identifiers_lookup
      ON sales_article_identifiers(canonical_gtin14, product_id);
    CREATE INDEX IF NOT EXISTS idx_sales_article_identifiers_product
      ON sales_article_identifiers(product_id, source_snapshot_id);

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_identifier_owner_claim
    BEFORE INSERT ON sales_article_identifiers
    BEGIN
      INSERT OR IGNORE INTO sales_article_identifier_owners (
        canonical_gtin14, product_id, first_source_snapshot_id, created_by, created_at
      ) VALUES (
        NEW.canonical_gtin14, NEW.product_id, NEW.source_snapshot_id,
        NEW.created_by, NEW.created_at
      );
      SELECT CASE WHEN (
        SELECT owner.product_id
        FROM sales_article_identifier_owners owner
        WHERE owner.canonical_gtin14 = NEW.canonical_gtin14
      ) <> NEW.product_id
      THEN RAISE(ABORT, 'sales-article-identifier-owner-conflict') END;
    END;

    CREATE TABLE IF NOT EXISTS sales_article_price_snapshots (
      id TEXT PRIMARY KEY
        CHECK(length(id) = 36
          AND id = lower(id)
          AND id NOT GLOB '*[^0-9a-f-]*'
          AND substr(id, 9, 1) = '-'
          AND substr(id, 14, 1) = '-'
          AND substr(id, 19, 1) = '-'
          AND substr(id, 24, 1) = '-'
          AND length(replace(id, '-', '')) = 32
          AND substr(id, 15, 1) = '4'
          AND substr(id, 20, 1) GLOB '[89ab]'),
      product_id TEXT NOT NULL,
      source_snapshot_id TEXT NOT NULL,
      price_type TEXT NOT NULL CHECK(price_type IN (
        'upe', 'average_purchase', 'list_purchase', 'invoice_purchase', 'sales',
        'net_net_purchase', 'wholesale', 'special', 'internet_1', 'internet_2',
        'internet_3', 'internet_4', 'internet_5', 'zdek', 'dek_a',
        'future_upe', 'order_purchase', 'future_purchase', 'calculation',
        'deposit', 'other'
      )),
      amount TEXT CHECK(amount IS NULL OR (
        length(amount) BETWEEN 14 AND 32
        AND amount NOT GLOB '*[^0-9.-]*'
        AND length(amount) - instr(amount, '.') = 12
        AND instr(amount, '.') - CASE
          WHEN substr(amount, 1, 1) = '-' THEN 2
          ELSE 1
        END BETWEEN 1 AND 18
        AND instr(substr(amount, instr(amount, '.') + 1), '.') = 0
        AND instr(substr(amount, 2), '-') = 0
        AND (
          (substr(amount, 1, 1) = '0' AND substr(amount, 2, 1) = '.')
          OR substr(amount, 1, 1) BETWEEN '1' AND '9'
          OR (substr(amount, 1, 1) = '-' AND (
            (substr(amount, 2, 1) = '0' AND substr(amount, 3, 1) = '.')
            OR substr(amount, 2, 1) BETWEEN '1' AND '9'
          ))
        )
        AND amount <> '-0.000000000000'
      )),
      currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
      price_basis TEXT NOT NULL CHECK(price_basis IN ('unknown', 'gross', 'net')),
      quality_status TEXT NOT NULL
        CHECK(quality_status IN ('confirmed', 'inferred', 'unresolved', 'quarantined')),
      source_field TEXT NOT NULL
        CHECK(source_field = trim(source_field)
          AND length(source_field) BETWEEN 1 AND 80),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      UNIQUE(source_snapshot_id, product_id, price_type, price_basis, source_field),
      CHECK(amount IS NULL OR substr(amount, 1, 1) <> '-' OR quality_status = 'quarantined'),
      FOREIGN KEY (source_snapshot_id, product_id)
        REFERENCES sales_article_revisions(source_snapshot_id, product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_article_prices_product
      ON sales_article_price_snapshots(product_id, price_type, created_at DESC);

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_import_snapshots_immutable_update
    BEFORE UPDATE ON sales_article_import_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-import-snapshot-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_import_snapshots_immutable_delete
    BEFORE DELETE ON sales_article_import_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-import-snapshot-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_import_findings_immutable_update
    BEFORE UPDATE ON sales_article_import_findings
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-import-finding-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_import_findings_immutable_delete
    BEFORE DELETE ON sales_article_import_findings
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-import-finding-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_import_run_metadata_immutable_update
    BEFORE UPDATE ON sales_article_import_run_metadata
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-import-run-metadata-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_import_run_metadata_immutable_delete
    BEFORE DELETE ON sales_article_import_run_metadata
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-import-run-metadata-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_import_impacts_immutable_update
    BEFORE UPDATE ON sales_article_import_impacts
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-import-impact-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_import_impacts_immutable_delete
    BEFORE DELETE ON sales_article_import_impacts
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-import-impact-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_revisions_immutable_update
    BEFORE UPDATE ON sales_article_revisions
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-revision-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_revisions_immutable_delete
    BEFORE DELETE ON sales_article_revisions
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-revision-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_source_links_immutable_update
    BEFORE UPDATE ON sales_article_source_links
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-source-link-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_source_links_immutable_delete
    BEFORE DELETE ON sales_article_source_links
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-source-link-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_identifier_owners_immutable_update
    BEFORE UPDATE ON sales_article_identifier_owners
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-identifier-owner-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_identifier_owners_immutable_delete
    BEFORE DELETE ON sales_article_identifier_owners
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-identifier-owner-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_identifiers_immutable_update
    BEFORE UPDATE ON sales_article_identifiers
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-identifier-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_identifiers_immutable_delete
    BEFORE DELETE ON sales_article_identifiers
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-identifier-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_prices_immutable_update
    BEFORE UPDATE ON sales_article_price_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-price-snapshot-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_article_prices_immutable_delete
    BEFORE DELETE ON sales_article_price_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'sales-article-price-snapshot-immutable');
    END;
  `);
  for (const [column, definition] of [
    ["source_provider", "TEXT NOT NULL DEFAULT '' CHECK(length(source_provider) <= 80)"],
    ["source_product_number", "TEXT NOT NULL DEFAULT '' CHECK(length(source_product_number) <= 1000)"],
    ["source_url", "TEXT NOT NULL DEFAULT '' CHECK(length(source_url) <= 4000)"],
    ["source_fetched_at", "TEXT"],
    ["source_created_by", "TEXT NOT NULL DEFAULT '' CHECK(length(source_created_by) <= 120)"],
    ["source_updated_by", "TEXT NOT NULL DEFAULT '' CHECK(length(source_updated_by) <= 120)"],
    ["source_created_at", "TEXT"],
    ["source_updated_at", "TEXT"],
  ]) ensureColumn(target, "sales_article_source_links", column, definition);
  for (const [column, definition] of [
    ["equivalent_identifiers_json", "TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(equivalent_identifiers_json) AND json_type(equivalent_identifiers_json) = 'array')"],
    ["source_provider", "TEXT NOT NULL DEFAULT '' CHECK(length(source_provider) <= 80)"],
    ["updated_by", "TEXT NOT NULL DEFAULT '' CHECK(length(updated_by) <= 120)"],
    ["updated_at", "TEXT NOT NULL DEFAULT '' CHECK(length(updated_at) <= 24)"],
  ]) ensureColumn(target, "sales_article_identifiers", column, definition);
  backfillIdentifierOwners(target);
  require("./sales-article-search-projection-schema").ensureSqliteArticleSearchProjection(target);
  require('./sales-article-images-schema').ensureSqliteSalesArticleImagesSchema(target);
}

module.exports = {
  ensureSqliteSalesArticleCatalogSchema,
};
