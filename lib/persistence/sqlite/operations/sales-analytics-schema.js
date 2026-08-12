"use strict";

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function ensureSqliteSalesAnalyticsSchema(database) {
  const target = assertSqliteOperationsDatabase(database);
  target.exec(`
    CREATE TABLE IF NOT EXISTS sales_import_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
      entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 80),
      active_revision INTEGER CHECK(active_revision IS NULL OR active_revision > 0),
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      updated_at TEXT NOT NULL CHECK(length(updated_at) = 24)
    );

    CREATE TABLE IF NOT EXISTS sales_import_profile_revisions (
      profile_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      contract_version INTEGER NOT NULL CHECK(contract_version > 0),
      model_version INTEGER NOT NULL CHECK(model_version > 0),
      source_schema_sha256 TEXT NOT NULL
        CHECK(length(source_schema_sha256) = 64
          AND source_schema_sha256 = lower(source_schema_sha256)
          AND source_schema_sha256 NOT GLOB '*[^0-9a-f]*'),
      profile_sha256 TEXT NOT NULL
        CHECK(length(profile_sha256) = 64
          AND profile_sha256 = lower(profile_sha256)
          AND profile_sha256 NOT GLOB '*[^0-9a-f]*'),
      profile_json TEXT NOT NULL
        CHECK(json_valid(profile_json) AND json_type(profile_json) = 'object'),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      PRIMARY KEY (profile_id, revision),
      UNIQUE (profile_id, profile_sha256),
      FOREIGN KEY (profile_id) REFERENCES sales_import_profiles(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TRIGGER IF NOT EXISTS trg_sales_import_profiles_active_revision
    BEFORE UPDATE OF active_revision ON sales_import_profiles
    WHEN NEW.active_revision IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sales_import_profile_revisions revision_row
        WHERE revision_row.profile_id = NEW.id
          AND revision_row.revision = NEW.active_revision
      )
    BEGIN
      SELECT RAISE(ABORT, 'sales-import-profile-revision-missing');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_import_profile_revisions_no_update
    BEFORE UPDATE ON sales_import_profile_revisions
    BEGIN
      SELECT RAISE(ABORT, 'sales-import-profile-revision-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_import_profile_revisions_no_delete
    BEFORE DELETE ON sales_import_profile_revisions
    BEGIN
      SELECT RAISE(ABORT, 'sales-import-profile-revision-immutable');
    END;

    CREATE TABLE IF NOT EXISTS sales_import_runs (
      id TEXT PRIMARY KEY
        CHECK(length(id) = 64 AND id = lower(id) AND id NOT GLOB '*[^0-9a-f]*'),
      idempotency_key TEXT NOT NULL UNIQUE
        CHECK(length(idempotency_key) = 64
          AND idempotency_key = lower(idempotency_key)
          AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
      profile_id TEXT NOT NULL,
      profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
      entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 80),
      profile_sha256 TEXT NOT NULL
        CHECK(length(profile_sha256) = 64
          AND profile_sha256 = lower(profile_sha256)
          AND profile_sha256 NOT GLOB '*[^0-9a-f]*'),
      content_sha256 TEXT NOT NULL
        CHECK(length(content_sha256) = 64
          AND content_sha256 = lower(content_sha256)
          AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
      source_schema_sha256 TEXT NOT NULL
        CHECK(length(source_schema_sha256) = 64
          AND source_schema_sha256 = lower(source_schema_sha256)
          AND source_schema_sha256 NOT GLOB '*[^0-9a-f]*'),
      snapshot_at TEXT NOT NULL CHECK(length(snapshot_at) = 24),
      status TEXT NOT NULL CHECK(status IN ('previewed', 'needs_review')),
      total_count INTEGER NOT NULL CHECK(total_count >= 0),
      accepted_count INTEGER NOT NULL CHECK(accepted_count >= 0),
      needs_review_count INTEGER NOT NULL CHECK(needs_review_count >= 0),
      rejected_count INTEGER NOT NULL CHECK(rejected_count >= 0),
      duplicate_count INTEGER NOT NULL CHECK(duplicate_count >= 0),
      unresolved_decision_ids_json TEXT NOT NULL
        CHECK(json_valid(unresolved_decision_ids_json)
          AND json_type(unresolved_decision_ids_json) = 'array'),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      started_at TEXT NOT NULL CHECK(length(started_at) = 24),
      completed_at TEXT NOT NULL CHECK(length(completed_at) = 24),
      expires_at TEXT NOT NULL CHECK(length(expires_at) = 24),
      CHECK(
        accepted_count + needs_review_count + rejected_count + duplicate_count
          = total_count
      ),
      CHECK(started_at <= completed_at),
      CHECK(completed_at < expires_at),
      FOREIGN KEY (profile_id, profile_revision)
        REFERENCES sales_import_profile_revisions(profile_id, revision)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_import_runs_profile_started
      ON sales_import_runs(profile_id, started_at DESC);

    CREATE TRIGGER IF NOT EXISTS trg_sales_import_runs_no_update
    BEFORE UPDATE ON sales_import_runs
    BEGIN
      SELECT RAISE(ABORT, 'sales-import-run-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_import_runs_no_delete
    BEFORE DELETE ON sales_import_runs
    BEGIN
      SELECT RAISE(ABORT, 'sales-import-run-immutable');
    END;

    CREATE TABLE IF NOT EXISTS sales_import_staging_records (
      run_id TEXT NOT NULL,
      row_number INTEGER NOT NULL CHECK(row_number > 0),
      entity_id TEXT NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 80),
      record_fingerprint TEXT
        CHECK(record_fingerprint IS NULL OR (
          length(record_fingerprint) = 64
          AND record_fingerprint = lower(record_fingerprint)
          AND record_fingerprint NOT GLOB '*[^0-9a-f]*'
        )),
      status TEXT NOT NULL
        CHECK(status IN ('accepted', 'needs_review', 'rejected', 'duplicate')),
      canonical_data_json TEXT NOT NULL
        CHECK(json_valid(canonical_data_json) AND json_type(canonical_data_json) = 'object'),
      issues_json TEXT NOT NULL
        CHECK(json_valid(issues_json) AND json_type(issues_json) = 'array'),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      expires_at TEXT NOT NULL CHECK(length(expires_at) = 24),
      PRIMARY KEY (run_id, row_number),
      CHECK(created_at < expires_at),
      FOREIGN KEY (run_id) REFERENCES sales_import_runs(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_import_staging_expiry
      ON sales_import_staging_records(expires_at);

    CREATE TRIGGER IF NOT EXISTS trg_sales_import_staging_no_update
    BEFORE UPDATE ON sales_import_staging_records
    BEGIN
      SELECT RAISE(ABORT, 'sales-import-staging-record-immutable');
    END;

    CREATE TABLE IF NOT EXISTS sales_branch_mapping_heads (
      source_system TEXT NOT NULL CHECK(length(source_system) BETWEEN 1 AND 80),
      external_branch_id TEXT NOT NULL
        CHECK(length(external_branch_id) BETWEEN 1 AND 80),
      active_revision INTEGER CHECK(active_revision IS NULL OR active_revision > 0),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      updated_at TEXT NOT NULL CHECK(length(updated_at) = 24),
      PRIMARY KEY (source_system, external_branch_id)
    );

    CREATE TABLE IF NOT EXISTS sales_branch_mapping_revisions (
      source_system TEXT NOT NULL,
      external_branch_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      location_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('approved', 'rejected')),
      valid_from TEXT NOT NULL CHECK(length(valid_from) = 10),
      valid_to TEXT CHECK(valid_to IS NULL OR length(valid_to) = 10),
      evidence_id TEXT NOT NULL CHECK(length(evidence_id) BETWEEN 1 AND 120),
      mapping_sha256 TEXT NOT NULL
        CHECK(length(mapping_sha256) = 64
          AND mapping_sha256 = lower(mapping_sha256)
          AND mapping_sha256 NOT GLOB '*[^0-9a-f]*'),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      PRIMARY KEY (source_system, external_branch_id, revision),
      UNIQUE (source_system, external_branch_id, mapping_sha256),
      CHECK(valid_to IS NULL OR valid_from <= valid_to),
      CHECK(
        (status = 'approved' AND location_id IS NOT NULL)
        OR (status = 'rejected' AND location_id IS NULL)
      ),
      FOREIGN KEY (source_system, external_branch_id)
        REFERENCES sales_branch_mapping_heads(source_system, external_branch_id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_branch_mapping_location
      ON sales_branch_mapping_revisions(location_id, valid_from, valid_to);

    CREATE TRIGGER IF NOT EXISTS trg_sales_branch_mapping_heads_active_revision
    BEFORE UPDATE OF active_revision ON sales_branch_mapping_heads
    WHEN NEW.active_revision IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sales_branch_mapping_revisions revision_row
        WHERE revision_row.source_system = NEW.source_system
          AND revision_row.external_branch_id = NEW.external_branch_id
          AND revision_row.revision = NEW.active_revision
      )
    BEGIN
      SELECT RAISE(ABORT, 'sales-branch-mapping-revision-missing');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_branch_mapping_revisions_no_update
    BEFORE UPDATE ON sales_branch_mapping_revisions
    BEGIN
      SELECT RAISE(ABORT, 'sales-branch-mapping-revision-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_branch_mapping_revisions_no_delete
    BEFORE DELETE ON sales_branch_mapping_revisions
    BEGIN
      SELECT RAISE(ABORT, 'sales-branch-mapping-revision-immutable');
    END;

    CREATE TABLE IF NOT EXISTS sales_aggregate_reports (
      id TEXT PRIMARY KEY
        CHECK(length(id) = 64 AND id = lower(id) AND id NOT GLOB '*[^0-9a-f]*'),
      source_system TEXT NOT NULL CHECK(length(source_system) BETWEEN 1 AND 80),
      source_file_sha256 TEXT NOT NULL UNIQUE
        CHECK(length(source_file_sha256) = 64
          AND source_file_sha256 = lower(source_file_sha256)
          AND source_file_sha256 NOT GLOB '*[^0-9a-f]*'),
      parser_version INTEGER NOT NULL CHECK(parser_version > 0),
      extraction TEXT NOT NULL
        CHECK(extraction IN ('pdf_text_coordinates', 'local_ocr_coordinates')),
      review_method TEXT NOT NULL
        CHECK(review_method IN ('source_text_confirmed', 'ocr_human_confirmed')),
      report_kind TEXT NOT NULL CHECK(length(report_kind) BETWEEN 1 AND 80),
      external_branch_id TEXT NOT NULL CHECK(length(external_branch_id) BETWEEN 1 AND 80),
      location_id TEXT NOT NULL,
      currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
      period_start TEXT NOT NULL CHECK(length(period_start) = 10),
      period_end TEXT NOT NULL CHECK(length(period_end) = 10),
      comparison_start TEXT NOT NULL CHECK(length(comparison_start) = 10),
      comparison_end TEXT NOT NULL CHECK(length(comparison_end) = 10),
      year_to_date_start TEXT NOT NULL CHECK(length(year_to_date_start) = 10),
      year_to_date_comparison_start TEXT NOT NULL
        CHECK(length(year_to_date_comparison_start) = 10),
      generated_on TEXT CHECK(generated_on IS NULL OR length(generated_on) = 10),
      page_count INTEGER NOT NULL CHECK(page_count BETWEEN 1 AND 120),
      product_group_count INTEGER NOT NULL CHECK(product_group_count > 0),
      issue_count INTEGER NOT NULL CHECK(issue_count >= 0),
      reconciliation_status TEXT NOT NULL
        CHECK(reconciliation_status IN ('match', 'within_tolerance')),
      imported_by TEXT NOT NULL CHECK(length(imported_by) BETWEEN 1 AND 120),
      imported_at TEXT NOT NULL CHECK(length(imported_at) = 24),
      CHECK(period_start <= period_end),
      CHECK(comparison_start <= comparison_end),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_aggregate_reports_natural_key
      ON sales_aggregate_reports(
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
      );

    CREATE INDEX IF NOT EXISTS idx_sales_aggregate_reports_location_period
      ON sales_aggregate_reports(location_id, period_end DESC, imported_at DESC);

    CREATE TABLE IF NOT EXISTS sales_report_product_group_metrics (
      report_id TEXT NOT NULL,
      horizon TEXT NOT NULL CHECK(horizon IN ('period', 'year_to_date')),
      external_product_group_id TEXT NOT NULL
        CHECK(length(external_product_group_id) BETWEEN 1 AND 80),
      product_group_label TEXT NOT NULL CHECK(length(trim(product_group_label)) BETWEEN 1 AND 240),
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
      FOREIGN KEY (report_id) REFERENCES sales_aggregate_reports(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_report_product_group_metrics_group
      ON sales_report_product_group_metrics(external_product_group_id, horizon);

    CREATE TABLE IF NOT EXISTS sales_report_total_metrics (
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
      FOREIGN KEY (report_id) REFERENCES sales_aggregate_reports(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TRIGGER IF NOT EXISTS trg_sales_aggregate_reports_immutable_update
    BEFORE UPDATE ON sales_aggregate_reports
    BEGIN
      SELECT RAISE(ABORT, 'sales-aggregate-report-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_aggregate_reports_immutable_delete
    BEFORE DELETE ON sales_aggregate_reports
    BEGIN
      SELECT RAISE(ABORT, 'sales-aggregate-report-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_report_product_group_metrics_immutable_update
    BEFORE UPDATE ON sales_report_product_group_metrics
    BEGIN
      SELECT RAISE(ABORT, 'sales-report-product-group-metric-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_report_product_group_metrics_immutable_delete
    BEFORE DELETE ON sales_report_product_group_metrics
    BEGIN
      SELECT RAISE(ABORT, 'sales-report-product-group-metric-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_report_total_metrics_immutable_update
    BEFORE UPDATE ON sales_report_total_metrics
    BEGIN
      SELECT RAISE(ABORT, 'sales-report-total-metric-immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sales_report_total_metrics_immutable_delete
    BEFORE DELETE ON sales_report_total_metrics
    BEGIN
      SELECT RAISE(ABORT, 'sales-report-total-metric-immutable');
    END;
  `);
  if (typeof target.prepare === "function") {
    const columns = new Set(
      target.prepare("PRAGMA table_info(sales_aggregate_reports)").all().map((row) => row.name),
    );
    if (!columns.has("extraction")) {
      target.exec(`
        ALTER TABLE sales_aggregate_reports
        ADD COLUMN extraction TEXT NOT NULL DEFAULT 'pdf_text_coordinates'
          CHECK(extraction IN ('pdf_text_coordinates', 'local_ocr_coordinates'));
      `);
    }
    if (!columns.has("review_method")) {
      target.exec(`
        ALTER TABLE sales_aggregate_reports
        ADD COLUMN review_method TEXT NOT NULL DEFAULT 'source_text_confirmed'
          CHECK(review_method IN ('source_text_confirmed', 'ocr_human_confirmed'));
      `);
    }
  }
}

module.exports = {
  ensureSqliteSalesAnalyticsSchema,
};
