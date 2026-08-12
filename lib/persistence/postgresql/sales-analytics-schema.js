"use strict";

const crypto = require("node:crypto");

const POSTGRESQL_SALES_ANALYTICS_SCHEMA_CONTRACT_VERSION = 3;

function quotedSchemaName(schemaName) {
  if (typeof schemaName !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new TypeError("Das PostgreSQL-Sales-Schema ist ungueltig.");
  }
  return `"${schemaName}"`;
}

function statement(id, sql) {
  return Object.freeze({ id, sql: sql.trim() });
}

function createPostgresqlSalesAnalyticsSchemaContract({ schemaName } = {}) {
  const schema = quotedSchemaName(schemaName);
  const relation = (name) => `${schema}."${name}"`;
  const statements = Object.freeze([
    statement("profiles", `
      CREATE TABLE ${relation("sales_import_profiles")} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 120),
        entity_id TEXT NOT NULL CHECK(char_length(entity_id) BETWEEN 1 AND 80),
        active_revision INTEGER CHECK(active_revision IS NULL OR active_revision > 0),
        active BOOLEAN NOT NULL,
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        updated_by TEXT NOT NULL CHECK(char_length(updated_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `),
    statement("profile-revisions", `
      CREATE TABLE ${relation("sales_import_profile_revisions")} (
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        contract_version INTEGER NOT NULL CHECK(contract_version > 0),
        model_version INTEGER NOT NULL CHECK(model_version > 0),
        source_schema_sha256 TEXT NOT NULL CHECK(source_schema_sha256 ~ '^[a-f0-9]{64}$'),
        profile_sha256 TEXT NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
        profile_json JSONB NOT NULL CHECK(jsonb_typeof(profile_json) = 'object'),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (profile_id, revision),
        UNIQUE (profile_id, profile_sha256),
        FOREIGN KEY (profile_id) REFERENCES ${relation("sales_import_profiles")}(id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      )
    `),
    statement("profiles-active-revision-fk", `
      ALTER TABLE ${relation("sales_import_profiles")}
      ADD CONSTRAINT sales_import_profiles_active_revision_fk
      FOREIGN KEY (id, active_revision)
      REFERENCES ${relation("sales_import_profile_revisions")}(profile_id, revision)
      DEFERRABLE INITIALLY DEFERRED
    `),
    statement("runs", `
      CREATE TABLE ${relation("sales_import_runs")} (
        id TEXT PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
        idempotency_key TEXT NOT NULL UNIQUE CHECK(idempotency_key ~ '^[a-f0-9]{64}$'),
        profile_id TEXT NOT NULL,
        profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
        entity_id TEXT NOT NULL CHECK(char_length(entity_id) BETWEEN 1 AND 80),
        profile_sha256 TEXT NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
        content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
        source_schema_sha256 TEXT NOT NULL CHECK(source_schema_sha256 ~ '^[a-f0-9]{64}$'),
        snapshot_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('previewed', 'needs_review')),
        total_count INTEGER NOT NULL CHECK(total_count >= 0),
        accepted_count INTEGER NOT NULL CHECK(accepted_count >= 0),
        needs_review_count INTEGER NOT NULL CHECK(needs_review_count >= 0),
        rejected_count INTEGER NOT NULL CHECK(rejected_count >= 0),
        duplicate_count INTEGER NOT NULL CHECK(duplicate_count >= 0),
        unresolved_decision_ids_json JSONB NOT NULL
          CHECK(jsonb_typeof(unresolved_decision_ids_json) = 'array'),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        CHECK(
          accepted_count + needs_review_count + rejected_count + duplicate_count
            = total_count
        ),
        CHECK(started_at <= completed_at),
        CHECK(completed_at < expires_at),
        FOREIGN KEY (profile_id, profile_revision)
          REFERENCES ${relation("sales_import_profile_revisions")}(profile_id, revision)
          ON UPDATE CASCADE ON DELETE RESTRICT
      )
    `),
    statement("runs-profile-index", `
      CREATE INDEX sales_import_runs_profile_started_idx
      ON ${relation("sales_import_runs")}(profile_id, started_at DESC)
    `),
    statement("staging", `
      CREATE TABLE ${relation("sales_import_staging_records")} (
        run_id TEXT NOT NULL,
        row_number INTEGER NOT NULL CHECK(row_number > 0),
        entity_id TEXT NOT NULL CHECK(char_length(entity_id) BETWEEN 1 AND 80),
        record_fingerprint TEXT
          CHECK(record_fingerprint IS NULL OR record_fingerprint ~ '^[a-f0-9]{64}$'),
        status TEXT NOT NULL
          CHECK(status IN ('accepted', 'needs_review', 'rejected', 'duplicate')),
        canonical_data_json JSONB NOT NULL CHECK(jsonb_typeof(canonical_data_json) = 'object'),
        issues_json JSONB NOT NULL CHECK(jsonb_typeof(issues_json) = 'array'),
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (run_id, row_number),
        CHECK(created_at < expires_at),
        FOREIGN KEY (run_id) REFERENCES ${relation("sales_import_runs")}(id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      )
    `),
    statement("staging-expiry-index", `
      CREATE INDEX sales_import_staging_expiry_idx
      ON ${relation("sales_import_staging_records")}(expires_at)
    `),
    statement("branch-mapping-heads", `
      CREATE TABLE ${relation("sales_branch_mapping_heads")} (
        source_system TEXT NOT NULL CHECK(char_length(source_system) BETWEEN 1 AND 80),
        external_branch_id TEXT NOT NULL CHECK(char_length(external_branch_id) BETWEEN 1 AND 80),
        active_revision INTEGER CHECK(active_revision IS NULL OR active_revision > 0),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        updated_by TEXT NOT NULL CHECK(char_length(updated_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (source_system, external_branch_id)
      )
    `),
    statement("branch-mapping-revisions", `
      CREATE TABLE ${relation("sales_branch_mapping_revisions")} (
        source_system TEXT NOT NULL,
        external_branch_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        location_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('approved', 'rejected')),
        valid_from DATE NOT NULL,
        valid_to DATE,
        evidence_id TEXT NOT NULL CHECK(char_length(evidence_id) BETWEEN 1 AND 120),
        mapping_sha256 TEXT NOT NULL CHECK(mapping_sha256 ~ '^[a-f0-9]{64}$'),
        created_by TEXT NOT NULL CHECK(char_length(created_by) BETWEEN 1 AND 120),
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (source_system, external_branch_id, revision),
        UNIQUE (source_system, external_branch_id, mapping_sha256),
        CHECK(valid_to IS NULL OR valid_from <= valid_to),
        CHECK(
          (status = 'approved' AND location_id IS NOT NULL)
          OR (status = 'rejected' AND location_id IS NULL)
        ),
        FOREIGN KEY (source_system, external_branch_id)
          REFERENCES ${relation("sales_branch_mapping_heads")}(source_system, external_branch_id)
          ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (location_id) REFERENCES ${relation("locations")}(id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      )
    `),
    statement("branch-mapping-active-revision-fk", `
      ALTER TABLE ${relation("sales_branch_mapping_heads")}
      ADD CONSTRAINT sales_branch_mapping_heads_active_revision_fk
      FOREIGN KEY (source_system, external_branch_id, active_revision)
      REFERENCES ${relation("sales_branch_mapping_revisions")}(
        source_system, external_branch_id, revision
      )
      DEFERRABLE INITIALLY DEFERRED
    `),
    statement("branch-mapping-location-index", `
      CREATE INDEX sales_branch_mapping_location_idx
      ON ${relation("sales_branch_mapping_revisions")}(location_id, valid_from, valid_to)
    `),
    statement("aggregate-reports", `
      CREATE TABLE ${relation("sales_aggregate_reports")} (
        id TEXT PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
        source_system TEXT NOT NULL CHECK(char_length(source_system) BETWEEN 1 AND 80),
        source_file_sha256 TEXT NOT NULL UNIQUE CHECK(source_file_sha256 ~ '^[a-f0-9]{64}$'),
        parser_version INTEGER NOT NULL CHECK(parser_version > 0),
        extraction TEXT NOT NULL
          CHECK(extraction IN ('pdf_text_coordinates', 'local_ocr_coordinates')),
        review_method TEXT NOT NULL
          CHECK(review_method IN ('source_text_confirmed', 'ocr_human_confirmed')),
        report_kind TEXT NOT NULL CHECK(char_length(report_kind) BETWEEN 1 AND 80),
        external_branch_id TEXT NOT NULL CHECK(char_length(external_branch_id) BETWEEN 1 AND 80),
        location_id TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        comparison_start DATE NOT NULL,
        comparison_end DATE NOT NULL,
        year_to_date_start DATE NOT NULL,
        year_to_date_comparison_start DATE NOT NULL,
        generated_on DATE,
        page_count INTEGER NOT NULL CHECK(page_count BETWEEN 1 AND 120),
        product_group_count INTEGER NOT NULL CHECK(product_group_count > 0),
        issue_count INTEGER NOT NULL CHECK(issue_count >= 0),
        reconciliation_status TEXT NOT NULL
          CHECK(reconciliation_status IN ('match', 'within_tolerance')),
        imported_by TEXT NOT NULL CHECK(char_length(imported_by) BETWEEN 1 AND 120),
        imported_at TIMESTAMPTZ NOT NULL,
        CHECK(period_start <= period_end),
        CHECK(comparison_start <= comparison_end),
        FOREIGN KEY (location_id) REFERENCES ${relation("locations")}(id)
          ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT sales_aggregate_reports_natural_key_unique UNIQUE (
          source_system,
          report_kind,
          external_branch_id,
          location_id,
          currency,
          period_start,
          period_end,
          comparison_start,
          comparison_end,
          year_to_date_start,
          year_to_date_comparison_start
        )
      )
    `),
    statement("aggregate-reports-location-index", `
      CREATE INDEX sales_aggregate_reports_location_period_idx
      ON ${relation("sales_aggregate_reports")}(location_id, period_end DESC, imported_at DESC)
    `),
    statement("report-product-group-metrics", `
      CREATE TABLE ${relation("sales_report_product_group_metrics")} (
        report_id TEXT NOT NULL,
        horizon TEXT NOT NULL CHECK(horizon IN ('period', 'year_to_date')),
        external_product_group_id TEXT NOT NULL
          CHECK(char_length(external_product_group_id) BETWEEN 1 AND 80),
        product_group_label TEXT NOT NULL
          CHECK(char_length(btrim(product_group_label)) BETWEEN 1 AND 240),
        current_quantity TEXT NOT NULL,
        comparison_quantity TEXT NOT NULL,
        current_net_revenue TEXT NOT NULL,
        comparison_net_revenue TEXT NOT NULL,
        current_gross_margin TEXT NOT NULL,
        comparison_gross_margin TEXT NOT NULL,
        current_customer_count TEXT NOT NULL,
        comparison_customer_count TEXT NOT NULL,
        current_revenue_per_customer TEXT,
        comparison_revenue_per_customer TEXT,
        source_page INTEGER NOT NULL CHECK(source_page > 0),
        source_ordinate TEXT NOT NULL,
        PRIMARY KEY (report_id, horizon, external_product_group_id),
        FOREIGN KEY (report_id) REFERENCES ${relation("sales_aggregate_reports")}(id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      )
    `),
    statement("report-product-group-metrics-index", `
      CREATE INDEX sales_report_product_group_metrics_group_idx
      ON ${relation("sales_report_product_group_metrics")}(external_product_group_id, horizon)
    `),
    statement("report-total-metrics", `
      CREATE TABLE ${relation("sales_report_total_metrics")} (
        report_id TEXT NOT NULL,
        horizon TEXT NOT NULL CHECK(horizon IN ('period', 'year_to_date')),
        current_quantity TEXT NOT NULL,
        comparison_quantity TEXT NOT NULL,
        current_net_revenue TEXT NOT NULL,
        comparison_net_revenue TEXT NOT NULL,
        current_gross_margin TEXT NOT NULL,
        comparison_gross_margin TEXT NOT NULL,
        current_customer_count TEXT NOT NULL,
        comparison_customer_count TEXT NOT NULL,
        current_revenue_per_customer TEXT,
        comparison_revenue_per_customer TEXT,
        source_page INTEGER NOT NULL CHECK(source_page > 0),
        PRIMARY KEY (report_id, horizon),
        FOREIGN KEY (report_id) REFERENCES ${relation("sales_aggregate_reports")}(id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      )
    `),
    statement("immutable-function", `
      CREATE FUNCTION ${schema}."sales_reject_immutable_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'sales-analytics-record-immutable' USING ERRCODE = '23514';
        RETURN NULL;
      END
      $$
    `),
    statement("profile-revisions-no-update", `
      CREATE TRIGGER sales_import_profile_revisions_no_update
      BEFORE UPDATE OR DELETE ON ${relation("sales_import_profile_revisions")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_reject_immutable_mutation"()
    `),
    statement("runs-no-update", `
      CREATE TRIGGER sales_import_runs_no_update
      BEFORE UPDATE OR DELETE ON ${relation("sales_import_runs")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_reject_immutable_mutation"()
    `),
    statement("staging-no-update", `
      CREATE TRIGGER sales_import_staging_no_update
      BEFORE UPDATE ON ${relation("sales_import_staging_records")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_reject_immutable_mutation"()
    `),
    statement("branch-revisions-no-update", `
      CREATE TRIGGER sales_branch_mapping_revisions_no_update
      BEFORE UPDATE OR DELETE ON ${relation("sales_branch_mapping_revisions")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_reject_immutable_mutation"()
    `),
    statement("aggregate-reports-no-update", `
      CREATE TRIGGER sales_aggregate_reports_no_update
      BEFORE UPDATE OR DELETE ON ${relation("sales_aggregate_reports")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_reject_immutable_mutation"()
    `),
    statement("report-product-group-metrics-no-update", `
      CREATE TRIGGER sales_report_product_group_metrics_no_update
      BEFORE UPDATE OR DELETE ON ${relation("sales_report_product_group_metrics")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_reject_immutable_mutation"()
    `),
    statement("report-total-metrics-no-update", `
      CREATE TRIGGER sales_report_total_metrics_no_update
      BEFORE UPDATE OR DELETE ON ${relation("sales_report_total_metrics")}
      FOR EACH ROW EXECUTE FUNCTION ${schema}."sales_reject_immutable_mutation"()
    `),
  ]);
  const snapshot = {
    contractVersion: POSTGRESQL_SALES_ANALYTICS_SCHEMA_CONTRACT_VERSION,
    schemaName,
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
  POSTGRESQL_SALES_ANALYTICS_SCHEMA_CONTRACT_VERSION,
  createPostgresqlSalesAnalyticsSchemaContract,
};
