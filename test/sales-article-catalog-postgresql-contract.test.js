"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  POSTGRESQL_SALES_ARTICLE_CATALOG_SCHEMA_CONTRACT_VERSION,
  POSTGRESQL_SALES_ARTICLE_CONSUMER_REFERENCE_CONTRACT,
  POSTGRESQL_SALES_ARTICLE_PRICE_AMOUNT_CONTRACT,
  POSTGRESQL_SALES_ARTICLE_UUID_CONTRACT,
  createPostgresqlSalesArticleCatalogSchemaContract,
} = require("../lib/persistence/postgresql/sales-article-catalog-schema");

function ddlFor(contract) {
  return contract.statements.map(({ sql }) => sql).join("\n");
}

test("Sales-Artikelstamm liefert einen reproduzierbaren, deaktivierten PostgreSQL-Vertrag", () => {
  const first = createPostgresqlSalesArticleCatalogSchemaContract({
    schemaName: "gp_sales_article_contract",
  });
  const second = createPostgresqlSalesArticleCatalogSchemaContract({
    schemaName: "gp_sales_article_contract",
  });

  assert.equal(POSTGRESQL_SALES_ARTICLE_CATALOG_SCHEMA_CONTRACT_VERSION, 6);
  assert.deepEqual(POSTGRESQL_SALES_ARTICLE_UUID_CONTRACT, {
    applicationType: "canonical-uuid-string",
    storageType: "UUID",
    generatedBy: "application",
  });
  assert.deepEqual(POSTGRESQL_SALES_ARTICLE_PRICE_AMOUNT_CONTRACT, {
    applicationType: "canonical-decimal12-string-or-null",
    storageType: "NUMERIC(30,12)",
    nullable: true,
    javascriptNumberAllowed: false,
  });
  assert.deepEqual(POSTGRESQL_SALES_ARTICLE_CONSUMER_REFERENCE_CONTRACT, {
    productId: {
      applicationType: "canonical-uuid-string",
      storageType: "UUID",
      nullable: false,
    },
    productRevisionSnapshot: {
      applicationType: "positive-safe-integer",
      storageType: "INTEGER",
      nullable: false,
    },
    articleNumberSnapshot: {
      applicationType: "trimmed-string",
      storageType: "TEXT",
      nullable: false,
      maximumLength: 80,
    },
    foreignKey: {
      columns: ["product_id", "product_revision_snapshot"],
      targetRelation: "sales_article_revisions",
      targetColumns: ["product_id", "revision"],
      onUpdate: "RESTRICT",
      onDelete: "RESTRICT",
    },
  });
  assert.equal(first.consumerReferenceContract,
    POSTGRESQL_SALES_ARTICLE_CONSUMER_REFERENCE_CONTRACT);
  assert.equal(first.contractVersion, 6);
  assert.equal(first.status, "development-contract");
  assert.equal(first.executable, true);
  assert.equal(first.applicationExecutable, false);
  assert.equal(first.productActivation, false);
  assert.equal(first.statements.length, 39);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.statements), true);
  assert.equal(first.statements.every(Object.isFrozen), true);
  assert.doesNotMatch(ddlFor(first), /CREATE\s+SCHEMA/i);

  const otherSchema = createPostgresqlSalesArticleCatalogSchemaContract({
    schemaName: "gp_sales_article_other",
  });
  assert.notEqual(first.fingerprint, otherSchema.fingerprint);

  for (const invalid of ["", "Public", "has-dash", "public;drop", "a".repeat(64)]) {
    assert.throws(
      () => createPostgresqlSalesArticleCatalogSchemaContract({ schemaName: invalid }),
      TypeError,
    );
  }
});

test("Sales-Artikelstamm trennt Business-Schluessel und UUID-Identitaet revisionssicher", () => {
  const contract = createPostgresqlSalesArticleCatalogSchemaContract({
    schemaName: "gp_sales_article_contract",
  });
  const ddl = ddlFor(contract);

  for (const relation of [
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
  ]) {
    assert.match(ddl, new RegExp(`"gp_sales_article_contract"\\."${relation}"`));
  }

  assert.match(ddl, /id TEXT PRIMARY KEY CHECK\(id ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(ddl, /source_profile_version TEXT NOT NULL/);
  assert.match(ddl, /char_length\(source_profile_version\) BETWEEN 1 AND 64/);
  assert.match(ddl, /source_profile_version ~ '\^\[a-z0-9\]\[a-z0-9\._-\]\*\$'/);
  assert.match(
    ddl,
    /source_file_sha256 TEXT NOT NULL[\s\S]*?source_file_sha256 ~ '\^\[a-f0-9\]\{64\}\$'/,
  );
  assert.match(
    ddl,
    /UNIQUE \(\s*source_system,\s*source_profile_version,\s*source_schema_sha256,\s*source_file_sha256,\s*content_sha256\s*\)/,
  );
  assert.match(ddl, /sales_article_import_findings" \([\s\S]*?source_row INTEGER NOT NULL/);
  assert.match(ddl, /sales_article_import_findings" \([\s\S]*?detail_sha256 TEXT NOT NULL/);
  assert.match(ddl, /sales_article_import_run_metadata" \([\s\S]*?quarantined_count INTEGER NOT NULL/);
  assert.match(ddl, /sales_article_import_impacts" \([\s\S]*?previous_current_revision INTEGER/);
  assert.match(ddl, /PRIMARY KEY \(snapshot_id, ordinal\)/);
  assert.doesNotMatch(ddl, /UNIQUE \(source_system, content_sha256\)/);
  assert.match(ddl, /product_id UUID PRIMARY KEY/);
  assert.match(ddl, /article_number TEXT NOT NULL UNIQUE/);
  assert.match(ddl, /char_length\(article_number\) BETWEEN 1 AND 80/);
  assert.doesNotMatch(ddl, /char_length\(article_number\)\s*=\s*6/);
  assert.match(ddl, /UNIQUE \(source_system, source_article_key\)/);
  assert.match(ddl, /match_method IN \([\s\S]*?'source_import'[\s\S]*?'article_number_exact'[\s\S]*?'legacy_migration'[\s\S]*?'manual_review'[\s\S]*?\)/);
  assert.match(ddl, /match_confidence IN \([\s\S]*?'authoritative'[\s\S]*?'exact'[\s\S]*?'reviewed'[\s\S]*?\)/);
  assert.match(ddl, /PRIMARY KEY \(source_system, source_article_key\)/);
  assert.match(ddl, /UNIQUE \(product_id, source_system\)/);
  assert.match(
    ddl,
    /CREATE INDEX sales_article_source_links_product_idx[\s\S]*?\(product_id, source_system\)/,
  );
  assert.doesNotMatch(ddl, /gen_random_uuid|uuid_generate/i);
  assert.match(
    ddl,
    /FOREIGN KEY \(product_id, current_revision\)[\s\S]*?sales_article_revisions"\(product_id, revision\)[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(ddl, /PRIMARY KEY \(product_id, revision\)/);
  assert.match(ddl, /UNIQUE \(source_snapshot_id, product_id\)/);
  assert.match(ddl, /description TEXT NOT NULL/);
  assert.match(ddl, /active BOOLEAN NOT NULL/);
  assert.match(ddl, /TIMESTAMPTZ/);
});

test("Sales-Artikel-Identifier und Preise sind qualitaetsgesichert und unveraenderlich", () => {
  const contract = createPostgresqlSalesArticleCatalogSchemaContract({
    schemaName: "gp_sales_article_contract",
  });
  const ddl = ddlFor(contract);
  const identifierDdl = contract.statements.find(({ id }) => id === "article-identifiers").sql;
  const priceDdl = contract.statements.find(({ id }) => id === "article-price-snapshots").sql;

  assert.match(ddl, /identifier_type IN \('ean8', 'upca', 'ean13', 'gtin14'\)/);
  assert.match(ddl, /identifier_value ~ '\^\[0-9\]\+\$'/);
  assert.match(ddl, /canonical_gtin14 TEXT NOT NULL/);
  assert.match(ddl, /canonical_gtin14 = lpad\(identifier_value, 14, '0'\)/);
  assert.match(
    ddl,
    /sales_article_identifier_owners" \([\s\S]*?canonical_gtin14 TEXT PRIMARY KEY/,
  );
  assert.match(ddl, /sales_article_claim_identifier_owner/);
  assert.match(ddl, /sales-article-identifier-owner-conflict/);
  assert.doesNotMatch(
    contract.statements.find(({ id }) => id === "article-identifier-owners").sql,
    /UNIQUE \(first_source_snapshot_id, canonical_gtin14\)/,
  );
  assert.match(ddl, /source_rank SMALLINT/);
  assert.match(ddl, /identifier_type = 'ean13' AND char_length\(identifier_value\) = 13/);
  assert.match(ddl, /UNIQUE \(source_snapshot_id, canonical_gtin14\)/);
  assert.match(
    ddl,
    /CREATE INDEX sales_article_identifiers_lookup_idx[\s\S]*?\(canonical_gtin14, product_id\)/,
  );
  assert.match(
    ddl,
    /CREATE UNIQUE INDEX sales_article_identifiers_one_primary_idx[\s\S]*?WHERE is_primary/,
  );
  assert.match(identifierDdl,
    /FOREIGN KEY \(product_id\)[\s\S]*?sales_articles"\(product_id\)/);
  assert.match(identifierDdl,
    /FOREIGN KEY \(source_snapshot_id\)[\s\S]*?sales_article_import_snapshots"\(id\)/);
  assert.doesNotMatch(identifierDdl, /FOREIGN KEY \(source_snapshot_id, product_id\)/);

  assert.match(ddl, /amount NUMERIC\(30,12\)/);
  assert.doesNotMatch(ddl, /amount NUMERIC\(30,12\) NOT NULL/);
  assert.doesNotMatch(ddl, /CHECK\(amount >= 0\)/);
  assert.match(ddl, /currency CHAR\(3\) NOT NULL/);
  assert.match(ddl, /currency::TEXT ~ '\^\[A-Z\]\{3\}\$'/);
  assert.match(ddl, /price_basis IN \('unknown', 'gross', 'net'\)/);
  assert.match(
    ddl,
    /quality_status IN \('confirmed', 'inferred', 'unresolved', 'quarantined'\)/,
  );
  for (const priceType of [
    "upe",
    "average_purchase",
    "list_purchase",
    "invoice_purchase",
    "sales",
    "net_net_purchase",
    "wholesale",
    "special",
    "internet_1",
    "internet_2",
    "internet_3",
    "internet_4",
    "internet_5",
    "zdek",
    "dek_a",
    "future_upe",
    "order_purchase",
    "future_purchase",
    "calculation",
    "deposit",
    "other",
  ]) {
    assert.match(ddl, new RegExp(`'${priceType}'`));
  }
  assert.doesNotMatch(ddl, /'cash_on_delivery'/);
  assert.match(
    priceDdl,
    /UNIQUE \(source_snapshot_id, product_id, price_type, price_basis, source_field\)/,
  );
  assert.match(
    priceDdl,
    /FOREIGN KEY \(source_snapshot_id, product_id\)[\s\S]*?sales_article_revisions"\(source_snapshot_id, product_id\)/,
  );
  assert.match(ddl, /amount IS NULL OR amount >= 0 OR quality_status = 'quarantined'/);
  assert.doesNotMatch(ddl, /UNIQUE \(source_snapshot_id, product_id, price_type\)\s*[,)]/);

  assert.match(ddl, /sales_article_reject_immutable_mutation/);
  assert.match(ddl, /RAISE EXCEPTION 'sales-article-record-immutable'/);
  assert.equal(
    contract.statements.filter(({ id }) => id.endsWith("no-mutation")).length,
    9,
  );
  for (const immutableRelation of [
    "sales_article_import_snapshots",
    "sales_article_import_findings",
    "sales_article_import_run_metadata",
    "sales_article_import_impacts",
    "sales_article_revisions",
    "sales_article_source_links",
    "sales_article_identifier_owners",
    "sales_article_identifiers",
    "sales_article_price_snapshots",
  ]) {
    assert.match(
      ddl,
      new RegExp(`BEFORE UPDATE OR DELETE ON "gp_sales_article_contract"\\."${immutableRelation}"`),
    );
  }
  assert.doesNotMatch(
    ddl,
    /BEFORE UPDATE OR DELETE ON "gp_sales_article_contract"\."sales_articles"/,
  );
});
