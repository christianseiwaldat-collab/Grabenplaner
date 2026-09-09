"use strict";

const crypto = require("node:crypto");

const POSTGRESQL_SALES_ARTICLE_CATALOG_SCHEMA_CONTRACT_VERSION = 6;
const POSTGRESQL_SALES_ARTICLE_UUID_CONTRACT = Object.freeze({
  applicationType: "canonical-uuid-string",
  storageType: "UUID",
  generatedBy: "application",
});
const POSTGRESQL_SALES_ARTICLE_PRICE_AMOUNT_CONTRACT = Object.freeze({
  applicationType: "canonical-decimal12-string-or-null",
  storageType: "NUMERIC(30,12)",
  nullable: true,
  javascriptNumberAllowed: false,
});
const POSTGRESQL_SALES_ARTICLE_CONSUMER_REFERENCE_CONTRACT = Object.freeze({
  productId: Object.freeze({
    applicationType: "canonical-uuid-string",
    storageType: "UUID",
    nullable: false,
  }),
  productRevisionSnapshot: Object.freeze({
    applicationType: "positive-safe-integer",
    storageType: "INTEGER",
    nullable: false,
  }),
  articleNumberSnapshot: Object.freeze({
    applicationType: "trimmed-string",
    storageType: "TEXT",
    nullable: false,
    maximumLength: 80,
  }),
  foreignKey: Object.freeze({
    columns: Object.freeze(["product_id", "product_revision_snapshot"]),
    targetRelation: "sales_article_revisions",
    targetColumns: Object.freeze(["product_id", "revision"]),
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
  }),
});

function quotedSchemaName(schemaName) {
  if (typeof schemaName !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new TypeError("Das PostgreSQL-Sales-Artikel-Schema ist ungueltig.");
  }
  return `"${schemaName}"`;
}

function statement(id, sql) {
  return Object.freeze({ id, sql: sql.trim() });
}

function createPostgresqlSalesArticleCatalogSchemaContract({ schemaName } = {}) {
  const schema = quotedSchemaName(schemaName);
  const relation = (name) => `${schema}."${name}"`;
  const uuidV4Check = (column) => (
    `${column}::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
  );
  const statements = Object.freeze([
    statement("import-snapshots", `
      CREATE TABLE ${relation("sales_article_import_snapshots")} (
        id TEXT PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
        idempotency_key TEXT NOT NULL UNIQUE
          CHECK(idempotency_key ~ '^[a-f0-9]{64}$'),
        source_system TEXT NOT NULL
          CHECK(
            source_system = btrim(source_system)
            AND char_length(source_system) BETWEEN 1 AND 80
            AND source_system ~ '^[a-z][a-z0-9._-]*$'
          ),
        source_profile_version TEXT NOT NULL
          CHECK(
            source_profile_version = btrim(source_profile_version)
            AND char_length(source_profile_version) BETWEEN 1 AND 64
            AND source_profile_version ~ '^[a-z0-9][a-z0-9._-]*$'
          ),
        source_schema_sha256 TEXT NOT NULL
          CHECK(source_schema_sha256 ~ '^[a-f0-9]{64}$'),
        source_file_sha256 TEXT NOT NULL
          CHECK(source_file_sha256 ~ '^[a-f0-9]{64}$'),
        content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
        snapshot_at TIMESTAMPTZ NOT NULL,
        article_count INTEGER NOT NULL CHECK(article_count >= 0),
        identifier_count INTEGER NOT NULL CHECK(identifier_count >= 0),
        price_count INTEGER NOT NULL CHECK(price_count >= 0),
        imported_by TEXT NOT NULL CHECK(char_length(imported_by) BETWEEN 1 AND 120),
        imported_at TIMESTAMPTZ NOT NULL,
        UNIQUE (
          source_system,
          source_profile_version,
          source_schema_sha256,
          source_file_sha256,
          content_sha256
        )
      )
    `),
    statement("import-findings", `
      CREATE TABLE ${relation("sales_article_import_findings")} (
        snapshot_id TEXT NOT NULL CHECK(snapshot_id ~ '^[a-f0-9]{64}$'),
        ordinal INTEGER NOT NULL CHECK(ordinal > 0),
        source_row INTEGER NOT NULL CHECK(source_row BETWEEN 1 AND 25000),
        article_number TEXT CHECK(article_number IS NULL OR (
          article_number = btrim(article_number)
          AND char_length(article_number) BETWEEN 1 AND 80
        )),
        code TEXT NOT NULL CHECK(code ~ '^[a-z0-9_]{1,80}$'),
        detail_sha256 TEXT NOT NULL CHECK(detail_sha256 ~ '^[a-f0-9]{64}$'),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (snapshot_id, ordinal),
        FOREIGN KEY (snapshot_id)
          REFERENCES ${relation("sales_article_import_snapshots")}(id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `),
    statement("import-findings-code-index", `
      CREATE INDEX sales_article_import_findings_code_idx
      ON ${relation("sales_article_import_findings")}(snapshot_id, code, source_row)
    `),
    statement("import-run-metadata", `
      CREATE TABLE ${relation("sales_article_import_run_metadata")} (
        snapshot_id TEXT PRIMARY KEY CHECK(snapshot_id ~ '^[a-f0-9]{64}$'),
        total_count INTEGER NOT NULL CHECK(total_count BETWEEN 0 AND 25000),
        create_count INTEGER NOT NULL CHECK(create_count BETWEEN 0 AND 25000),
        update_count INTEGER NOT NULL CHECK(update_count BETWEEN 0 AND 25000),
        unchanged_count INTEGER NOT NULL CHECK(unchanged_count BETWEEN 0 AND 25000),
        quarantined_count INTEGER NOT NULL CHECK(quarantined_count BETWEEN 0 AND 25000),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        CHECK(
          total_count = create_count + update_count + unchanged_count + quarantined_count
        ),
        FOREIGN KEY (snapshot_id)
          REFERENCES ${relation("sales_article_import_snapshots")}(id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `),
    statement("articles", `
      CREATE TABLE ${relation("sales_articles")} (
        product_id UUID PRIMARY KEY CHECK(${uuidV4Check("product_id")}),
        article_number TEXT NOT NULL UNIQUE
          CHECK(
            article_number = btrim(article_number)
            AND char_length(article_number) BETWEEN 1 AND 80
          ),
        source_system TEXT NOT NULL
          CHECK(
            source_system = btrim(source_system)
            AND char_length(source_system) BETWEEN 1 AND 80
            AND source_system ~ '^[a-z][a-z0-9._-]*$'
          ),
        source_article_key TEXT NOT NULL
          CHECK(
            source_article_key = btrim(source_article_key)
            AND char_length(source_article_key) BETWEEN 1 AND 160
          ),
        current_revision INTEGER NOT NULL CHECK(current_revision > 0),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT NOT NULL CHECK(char_length(updated_by) BETWEEN 1 AND 120),
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (source_system, source_article_key),
        UNIQUE (product_id, current_revision),
        CHECK(created_at <= updated_at)
      )
    `),
    statement("article-revisions", `
      CREATE TABLE ${relation("sales_article_revisions")} (
        product_id UUID NOT NULL CHECK(${uuidV4Check("product_id")}),
        revision INTEGER NOT NULL CHECK(revision > 0),
        article_number TEXT NOT NULL
          CHECK(
            article_number = btrim(article_number)
            AND char_length(article_number) BETWEEN 1 AND 80
          ),
        description TEXT NOT NULL
          CHECK(
            description = btrim(description)
            AND char_length(description) BETWEEN 1 AND 300
          ),
        active BOOLEAN NOT NULL,
        source_snapshot_id TEXT NOT NULL CHECK(source_snapshot_id ~ '^[a-f0-9]{64}$'),
        source_updated_at TIMESTAMPTZ,
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (product_id, revision),
        UNIQUE (source_snapshot_id, product_id),
        FOREIGN KEY (product_id) REFERENCES ${relation("sales_articles")}(product_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        FOREIGN KEY (source_snapshot_id)
          REFERENCES ${relation("sales_article_import_snapshots")}(id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `),
    statement("articles-current-revision-fk", `
      ALTER TABLE ${relation("sales_articles")}
      ADD CONSTRAINT sales_articles_current_revision_fk
      FOREIGN KEY (product_id, current_revision)
      REFERENCES ${relation("sales_article_revisions")}(product_id, revision)
      ON UPDATE RESTRICT ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED
    `),
    statement("import-impacts", `
      CREATE TABLE ${relation("sales_article_import_impacts")} (
        snapshot_id TEXT NOT NULL CHECK(snapshot_id ~ '^[a-f0-9]{64}$'),
        ordinal INTEGER NOT NULL CHECK(ordinal > 0),
        product_id UUID NOT NULL CHECK(${uuidV4Check("product_id")}),
        imported_revision INTEGER NOT NULL CHECK(imported_revision > 0),
        previous_current_revision INTEGER CHECK(previous_current_revision > 0),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (snapshot_id, ordinal),
        UNIQUE (snapshot_id, product_id),
        UNIQUE (product_id, imported_revision),
        CHECK(
          previous_current_revision IS NULL
          OR previous_current_revision <> imported_revision
        ),
        FOREIGN KEY (snapshot_id)
          REFERENCES ${relation("sales_article_import_snapshots")}(id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        FOREIGN KEY (product_id, imported_revision)
          REFERENCES ${relation("sales_article_revisions")}(product_id, revision)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        FOREIGN KEY (product_id, previous_current_revision)
          REFERENCES ${relation("sales_article_revisions")}(product_id, revision)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `),
    statement("import-impacts-product-index", `
      CREATE INDEX sales_article_import_impacts_product_idx
      ON ${relation("sales_article_import_impacts")}(product_id, imported_revision)
    `),
    statement("article-source-links", `
      CREATE TABLE ${relation("sales_article_source_links")} (
        product_id UUID NOT NULL CHECK(${uuidV4Check("product_id")}),
        source_system TEXT NOT NULL
          CHECK(
            source_system = btrim(source_system)
            AND char_length(source_system) BETWEEN 1 AND 80
            AND source_system ~ '^[a-z][a-z0-9._-]*$'
          ),
        source_article_key TEXT NOT NULL
          CHECK(
            source_article_key = btrim(source_article_key)
            AND char_length(source_article_key) BETWEEN 1 AND 160
          ),
        source_snapshot_id TEXT NOT NULL CHECK(source_snapshot_id ~ '^[a-f0-9]{64}$'),
        match_method TEXT NOT NULL CHECK(match_method IN (
          'source_import', 'article_number_exact', 'legacy_migration', 'manual_review'
        )),
        match_confidence TEXT NOT NULL CHECK(match_confidence IN (
          'authoritative', 'exact', 'reviewed'
        )),
        matched_source_system TEXT,
        matched_source_article_key TEXT,
        source_provider TEXT NOT NULL CHECK(char_length(source_provider) <= 80),
        source_product_number TEXT NOT NULL CHECK(char_length(source_product_number) <= 1000),
        source_url TEXT NOT NULL CHECK(char_length(source_url) <= 4000),
        source_fetched_at TEXT CHECK(source_fetched_at IS NULL OR char_length(source_fetched_at) <= 80),
        source_created_by TEXT NOT NULL CHECK(char_length(source_created_by) <= 120),
        source_updated_by TEXT NOT NULL CHECK(char_length(source_updated_by) <= 120),
        source_created_at TEXT CHECK(source_created_at IS NULL OR char_length(source_created_at) <= 80),
        source_updated_at TEXT CHECK(source_updated_at IS NULL OR char_length(source_updated_at) <= 80),
        linked_by TEXT NOT NULL CHECK(char_length(linked_by) BETWEEN 1 AND 120),
        linked_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (source_system, source_article_key),
        UNIQUE (product_id, source_system),
        CHECK((matched_source_system IS NULL) = (matched_source_article_key IS NULL)),
        CHECK(matched_source_system IS NULL OR matched_source_system ~ '^[a-z][a-z0-9._-]*$'),
        CHECK(matched_source_article_key IS NULL OR (
          matched_source_article_key = btrim(matched_source_article_key)
          AND char_length(matched_source_article_key) BETWEEN 1 AND 160
        )),
        FOREIGN KEY (product_id) REFERENCES ${relation("sales_articles")}(product_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        FOREIGN KEY (source_snapshot_id)
          REFERENCES ${relation("sales_article_import_snapshots")}(id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `),
    statement("article-source-links-product-index", `
      CREATE INDEX sales_article_source_links_product_idx
      ON ${relation("sales_article_source_links")}(product_id, source_system)
    `),
    statement("article-identifier-owners", `
      CREATE TABLE ${relation("sales_article_identifier_owners")} (
        canonical_gtin14 TEXT PRIMARY KEY CHECK(canonical_gtin14 ~ '^[0-9]{14}$'),
        product_id UUID NOT NULL CHECK(${uuidV4Check("product_id")}),
        first_source_snapshot_id TEXT NOT NULL CHECK(first_source_snapshot_id ~ '^[a-f0-9]{64}$'),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (canonical_gtin14, product_id),
        FOREIGN KEY (product_id) REFERENCES ${relation("sales_articles")}(product_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        FOREIGN KEY (first_source_snapshot_id)
          REFERENCES ${relation("sales_article_import_snapshots")}(id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `),
    statement("article-identifier-owners-product-index", `
      CREATE INDEX sales_article_identifier_owners_product_idx
      ON ${relation("sales_article_identifier_owners")}(product_id, canonical_gtin14)
    `),
    statement("article-identifiers", `
      CREATE TABLE ${relation("sales_article_identifiers")} (
        id UUID PRIMARY KEY CHECK(${uuidV4Check("id")}),
        product_id UUID NOT NULL CHECK(${uuidV4Check("product_id")}),
        source_snapshot_id TEXT NOT NULL CHECK(source_snapshot_id ~ '^[a-f0-9]{64}$'),
        identifier_type TEXT NOT NULL
          CHECK(identifier_type IN ('ean8', 'upca', 'ean13', 'gtin14')),
        identifier_value TEXT NOT NULL CHECK(identifier_value ~ '^[0-9]+$'),
        canonical_gtin14 TEXT NOT NULL CHECK(canonical_gtin14 ~ '^[0-9]{14}$'),
        is_primary BOOLEAN NOT NULL,
        source_field TEXT NOT NULL
          CHECK(
            source_field = btrim(source_field)
            AND char_length(source_field) BETWEEN 1 AND 80
          ),
        source_rank SMALLINT CHECK(source_rank IS NULL OR source_rank BETWEEN 0 AND 255),
        equivalent_identifiers JSONB NOT NULL DEFAULT '[]'::JSONB
          CHECK(jsonb_typeof(equivalent_identifiers) = 'array'),
        source_provider TEXT NOT NULL CHECK(char_length(source_provider) <= 80),
        verified_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT NOT NULL CHECK(char_length(updated_by) BETWEEN 1 AND 120),
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE (source_snapshot_id, canonical_gtin14),
        CHECK(
          (identifier_type = 'ean8' AND char_length(identifier_value) = 8)
          OR (identifier_type = 'upca' AND char_length(identifier_value) = 12)
          OR (identifier_type = 'ean13' AND char_length(identifier_value) = 13)
          OR (identifier_type = 'gtin14' AND char_length(identifier_value) = 14)
        ),
        CHECK(canonical_gtin14 = lpad(identifier_value, 14, '0')),
        FOREIGN KEY (product_id) REFERENCES ${relation("sales_articles")}(product_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        FOREIGN KEY (source_snapshot_id)
          REFERENCES ${relation("sales_article_import_snapshots")}(id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        FOREIGN KEY (canonical_gtin14, product_id)
          REFERENCES ${relation("sales_article_identifier_owners")}(canonical_gtin14, product_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `),
    statement("article-identifiers-product-index", `
      CREATE INDEX sales_article_identifiers_product_idx
      ON ${relation("sales_article_identifiers")}(product_id, source_snapshot_id)
    `),
    statement("article-identifiers-lookup-index", `
      CREATE INDEX sales_article_identifiers_lookup_idx
      ON ${relation("sales_article_identifiers")}(canonical_gtin14, product_id)
    `),
    statement("article-identifiers-primary-index", `
      CREATE UNIQUE INDEX sales_article_identifiers_one_primary_idx
      ON ${relation("sales_article_identifiers")}(product_id, source_snapshot_id)
      WHERE is_primary
    `),
    statement("article-identifier-owner-claim-function", `
      CREATE FUNCTION ${schema}."sales_article_claim_identifier_owner"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        claimed_product_id UUID;
      BEGIN
        INSERT INTO ${relation("sales_article_identifier_owners")} (
          canonical_gtin14, product_id, first_source_snapshot_id, created_by, created_at
        ) VALUES (
          NEW.canonical_gtin14, NEW.product_id, NEW.source_snapshot_id,
          NEW.created_by, NEW.created_at
        ) ON CONFLICT (canonical_gtin14) DO NOTHING;
        SELECT product_id INTO claimed_product_id
        FROM ${relation("sales_article_identifier_owners")}
        WHERE canonical_gtin14 = NEW.canonical_gtin14;
        IF claimed_product_id IS DISTINCT FROM NEW.product_id THEN
          RAISE EXCEPTION 'sales-article-identifier-owner-conflict' USING ERRCODE = '23505';
        END IF;
        RETURN NEW;
      END
      $$
    `),
    statement("article-identifier-owner-claim-trigger", `
      CREATE TRIGGER sales_article_identifier_owner_claim
      BEFORE INSERT ON ${relation("sales_article_identifiers")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_claim_identifier_owner"()
    `),
    statement("article-price-snapshots", `
      CREATE TABLE ${relation("sales_article_price_snapshots")} (
        id UUID PRIMARY KEY CHECK(${uuidV4Check("id")}),
        product_id UUID NOT NULL CHECK(${uuidV4Check("product_id")}),
        source_snapshot_id TEXT NOT NULL CHECK(source_snapshot_id ~ '^[a-f0-9]{64}$'),
        price_type TEXT NOT NULL CHECK(price_type IN (
          'upe',
          'average_purchase',
          'list_purchase',
          'invoice_purchase',
          'sales',
          'net_net_purchase',
          'wholesale',
          'special',
          'internet_1',
          'internet_2',
          'internet_3',
          'internet_4',
          'internet_5',
          'zdek',
          'dek_a',
          'future_upe',
          'order_purchase',
          'future_purchase',
          'calculation',
          'deposit',
          'other'
        )),
        amount NUMERIC(30,12),
        currency CHAR(3) NOT NULL CHECK(currency::TEXT ~ '^[A-Z]{3}$'),
        price_basis TEXT NOT NULL CHECK(price_basis IN ('unknown', 'gross', 'net')),
        quality_status TEXT NOT NULL
          CHECK(quality_status IN ('confirmed', 'inferred', 'unresolved', 'quarantined')),
        source_field TEXT NOT NULL
          CHECK(
            source_field = btrim(source_field)
            AND char_length(source_field) BETWEEN 1 AND 80
          ),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (source_snapshot_id, product_id, price_type, price_basis, source_field),
        CHECK(amount IS NULL OR amount >= 0 OR quality_status = 'quarantined'),
        FOREIGN KEY (source_snapshot_id, product_id)
          REFERENCES ${relation("sales_article_revisions")}(source_snapshot_id, product_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      )
    `),
    statement("article-price-snapshots-product-index", `
      CREATE INDEX sales_article_price_snapshots_product_idx
      ON ${relation("sales_article_price_snapshots")}(product_id, source_snapshot_id)
    `),
    statement("immutable-function", `
      CREATE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'sales-article-record-immutable' USING ERRCODE = '23514';
        RETURN NULL;
      END
      $$
    `),
    statement("search-projection", `
      CREATE TABLE ${relation("sales_article_search_projection")} (
        product_id UUID PRIMARY KEY REFERENCES ${relation("sales_articles")}(product_id),
        article_number TEXT NOT NULL, current_revision INTEGER NOT NULL,
        description TEXT NOT NULL, active BOOLEAN NOT NULL,
        source_snapshot_id TEXT NOT NULL REFERENCES ${relation("sales_article_import_snapshots")}(id),
        source_system TEXT NOT NULL, primary_identifier TEXT,
        search_text TEXT NOT NULL, article_number_sort TEXT NOT NULL, description_sort TEXT NOT NULL
      )
    `),
    statement("search-projection-number-index", `
      CREATE INDEX idx_sales_article_search_number ON ${relation("sales_article_search_projection")}
        (active, article_number_sort, product_id)
    `),
    statement("search-projection-description-index", `
      CREATE INDEX idx_sales_article_search_description ON ${relation("sales_article_search_projection")}
        (active, description_sort, article_number_sort, product_id)
    `),
    statement("search-projection-dirty", `
      CREATE TABLE ${relation("sales_article_search_dirty")} (product_id UUID PRIMARY KEY)
    `),
    statement("search-projection-mark-dirty", `
      CREATE FUNCTION ${schema}."sales_article_search_mark_dirty"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO ${relation("sales_article_search_dirty")}(product_id) VALUES (NEW.product_id)
          ON CONFLICT DO NOTHING;
        RETURN NEW;
      END;
      $$
    `),
    ...["sales_articles", "sales_article_revisions", "sales_article_identifiers"].map(table => statement(`search-dirty-${table}`, `
      CREATE TRIGGER ${table}_search_dirty AFTER INSERT ${table === "sales_articles" ? "OR UPDATE OF article_number,current_revision" : ""}
      ON ${relation(table)} FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_search_mark_dirty"()
    `)),
    statement("import-snapshots-no-mutation", `
      CREATE TRIGGER sales_article_import_snapshots_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_import_snapshots")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
    statement("import-findings-no-mutation", `
      CREATE TRIGGER sales_article_import_findings_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_import_findings")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
    statement("import-run-metadata-no-mutation", `
      CREATE TRIGGER sales_article_import_run_metadata_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_import_run_metadata")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
    statement("import-impacts-no-mutation", `
      CREATE TRIGGER sales_article_import_impacts_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_import_impacts")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
    statement("article-revisions-no-mutation", `
      CREATE TRIGGER sales_article_revisions_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_revisions")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
    statement("article-source-links-no-mutation", `
      CREATE TRIGGER sales_article_source_links_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_source_links")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
    statement("article-identifier-owners-no-mutation", `
      CREATE TRIGGER sales_article_identifier_owners_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_identifier_owners")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
    statement("article-identifiers-no-mutation", `
      CREATE TRIGGER sales_article_identifiers_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_identifiers")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
    statement("article-price-snapshots-no-mutation", `
      CREATE TRIGGER sales_article_price_snapshots_no_mutation
      BEFORE UPDATE OR DELETE ON ${relation("sales_article_price_snapshots")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_article_reject_immutable_mutation"()
    `),
  ]);
  const snapshot = {
    contractVersion: POSTGRESQL_SALES_ARTICLE_CATALOG_SCHEMA_CONTRACT_VERSION,
    schemaName,
    uuidContract: POSTGRESQL_SALES_ARTICLE_UUID_CONTRACT,
    priceAmountContract: POSTGRESQL_SALES_ARTICLE_PRICE_AMOUNT_CONTRACT,
    consumerReferenceContract: POSTGRESQL_SALES_ARTICLE_CONSUMER_REFERENCE_CONTRACT,
    statements,
  };
  return Object.freeze({
    ...snapshot,
    status: "development-contract",
    executable: true,
    applicationExecutable: false,
    productActivation: false,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  });
}

module.exports = {
  POSTGRESQL_SALES_ARTICLE_CATALOG_SCHEMA_CONTRACT_VERSION,
  POSTGRESQL_SALES_ARTICLE_CONSUMER_REFERENCE_CONTRACT,
  POSTGRESQL_SALES_ARTICLE_PRICE_AMOUNT_CONTRACT,
  POSTGRESQL_SALES_ARTICLE_UUID_CONTRACT,
  createPostgresqlSalesArticleCatalogSchemaContract,
};
