"use strict";

const {
  SALES_ANALYTICS_PERSISTENCE_STATEMENTS: S,
} = require("../statements/sales-analytics");

function entry(statement, sql) {
  return Object.freeze({ statement, sql, returning: false });
}

const PROFILE_COLUMNS = `
  id,
  name,
  entity_id AS entityId,
  active_revision AS activeRevision,
  active,
  created_by AS createdBy,
  updated_by AS updatedBy,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const PROFILE_REVISION_COLUMNS = `
  profile_id AS profileId,
  revision,
  contract_version AS contractVersion,
  model_version AS modelVersion,
  source_schema_sha256 AS sourceSchemaSha256,
  profile_sha256 AS profileSha256,
  profile_json AS profile,
  created_by AS createdBy,
  created_at AS createdAt
`;

const RUN_COLUMNS = `
  id,
  idempotency_key AS idempotencyKey,
  profile_id AS profileId,
  profile_revision AS profileRevision,
  entity_id AS entityId,
  profile_sha256 AS profileSha256,
  content_sha256 AS contentSha256,
  source_schema_sha256 AS sourceSchemaSha256,
  snapshot_at AS snapshotAt,
  status,
  total_count AS totalCount,
  accepted_count AS acceptedCount,
  needs_review_count AS needsReviewCount,
  rejected_count AS rejectedCount,
  duplicate_count AS duplicateCount,
  unresolved_decision_ids_json AS unresolvedDecisionIds,
  created_by AS createdBy,
  started_at AS startedAt,
  completed_at AS completedAt,
  expires_at AS expiresAt
`;

const STAGING_COLUMNS = `
  run_id AS runId,
  row_number AS rowNumber,
  entity_id AS entityId,
  record_fingerprint AS recordFingerprint,
  status,
  canonical_data_json AS canonicalData,
  issues_json AS issues,
  created_at AS createdAt,
  expires_at AS expiresAt
`;

const BRANCH_MAPPING_HEAD_COLUMNS = `
  source_system AS sourceSystem,
  external_branch_id AS externalBranchId,
  active_revision AS activeRevision,
  created_by AS createdBy,
  updated_by AS updatedBy,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const BRANCH_MAPPING_REVISION_COLUMNS = `
  source_system AS sourceSystem,
  external_branch_id AS externalBranchId,
  revision,
  location_id AS locationId,
  status,
  valid_from AS validFrom,
  valid_to AS validTo,
  evidence_id AS evidenceId,
  mapping_sha256 AS mappingSha256,
  created_by AS createdBy,
  created_at AS createdAt
`;

const REPORT_COLUMNS = `
  id,
  source_system AS sourceSystem,
  source_file_sha256 AS sourceFileSha256,
  parser_version AS parserVersion,
  extraction,
  review_method AS reviewMethod,
  report_kind AS reportKind,
  external_branch_id AS externalBranchId,
  location_id AS locationId,
  currency,
  period_start AS periodStart,
  period_end AS periodEnd,
  comparison_start AS comparisonStart,
  comparison_end AS comparisonEnd,
  year_to_date_start AS yearToDateStart,
  year_to_date_comparison_start AS yearToDateComparisonStart,
  generated_on AS generatedOn,
  page_count AS pageCount,
  product_group_count AS productGroupCount,
  issue_count AS issueCount,
  reconciliation_status AS reconciliationStatus,
  imported_by AS importedBy,
  imported_at AS importedAt
`;

const REPORT_METRIC_COLUMNS = `
  report_id AS reportId,
  horizon,
  external_product_group_id AS externalProductGroupId,
  product_group_label AS productGroupLabel,
  current_quantity AS currentQuantity,
  comparison_quantity AS comparisonQuantity,
  current_net_revenue AS currentNetRevenue,
  comparison_net_revenue AS comparisonNetRevenue,
  current_gross_margin AS currentGrossMargin,
  comparison_gross_margin AS comparisonGrossMargin,
  current_customer_count AS currentCustomerCount,
  comparison_customer_count AS comparisonCustomerCount,
  current_revenue_per_customer AS currentRevenuePerCustomer,
  comparison_revenue_per_customer AS comparisonRevenuePerCustomer,
  source_page AS sourcePage,
  source_ordinate AS sourceOrdinate
`;

const REPORT_TOTAL_COLUMNS = `
  report_id AS reportId,
  horizon,
  current_quantity AS currentQuantity,
  comparison_quantity AS comparisonQuantity,
  current_net_revenue AS currentNetRevenue,
  comparison_net_revenue AS comparisonNetRevenue,
  current_gross_margin AS currentGrossMargin,
  comparison_gross_margin AS comparisonGrossMargin,
  current_customer_count AS currentCustomerCount,
  comparison_customer_count AS comparisonCustomerCount,
  current_revenue_per_customer AS currentRevenuePerCustomer,
  comparison_revenue_per_customer AS comparisonRevenuePerCustomer,
  source_page AS sourcePage
`;

const SQLITE_SALES_ANALYTICS_CATALOG = Object.freeze([
  entry(S.listProfiles, `
    SELECT ${PROFILE_COLUMNS}
    FROM sales_import_profiles
    WHERE $activeOnly = FALSE OR active = TRUE
    ORDER BY active DESC, name, id
  `),
  entry(S.getProfile, `
    SELECT ${PROFILE_COLUMNS}
    FROM sales_import_profiles
    WHERE id = $id
  `),
  entry(S.getProfileRevision, `
    SELECT ${PROFILE_REVISION_COLUMNS}
    FROM sales_import_profile_revisions
    WHERE profile_id = $profileId
      AND revision = $revision
  `),
  entry(S.listProfileRevisions, `
    SELECT ${PROFILE_REVISION_COLUMNS}
    FROM sales_import_profile_revisions
    WHERE profile_id = $profileId
    ORDER BY revision DESC
  `),
  entry(S.insertProfile, `
    INSERT INTO sales_import_profiles (
      id, name, entity_id, active, created_by, updated_by, created_at, updated_at
    ) VALUES (
      $id, $name, $entityId, $active, $actor, $actor, $timestamp, $timestamp
    )
  `),
  entry(S.insertProfileRevision, `
    INSERT INTO sales_import_profile_revisions (
      profile_id, revision, contract_version, model_version,
      source_schema_sha256, profile_sha256, profile_json, created_by, created_at
    ) VALUES (
      $profileId, $revision, $contractVersion, $modelVersion,
      $sourceSchemaSha256, $profileSha256, $profile, $actor, $timestamp
    )
  `),
  entry(S.activateProfileRevision, `
    UPDATE sales_import_profiles
    SET name = $name,
        active_revision = $revision,
        updated_by = $actor,
        updated_at = $timestamp
    WHERE id = $id
      AND (
        ($expectedRevision IS NULL AND active_revision IS NULL)
        OR active_revision = $expectedRevision
      )
      AND EXISTS (
        SELECT 1
        FROM sales_import_profile_revisions revision_row
        WHERE revision_row.profile_id = $id
          AND revision_row.revision = $revision
      )
  `),

  entry(S.getRun, `
    SELECT ${RUN_COLUMNS}
    FROM sales_import_runs
    WHERE id = $id
  `),
  entry(S.getRunByIdempotencyKey, `
    SELECT ${RUN_COLUMNS}
    FROM sales_import_runs
    WHERE idempotency_key = $idempotencyKey
  `),
  entry(S.listRuns, `
    SELECT ${RUN_COLUMNS}
    FROM sales_import_runs
    WHERE $profileId IS NULL OR profile_id = $profileId
    ORDER BY started_at DESC, id DESC
    LIMIT $limit
  `),
  entry(S.insertRun, `
    INSERT INTO sales_import_runs (
      id, idempotency_key, profile_id, profile_revision, entity_id,
      profile_sha256, content_sha256, source_schema_sha256, snapshot_at,
      status, total_count, accepted_count, needs_review_count,
      rejected_count, duplicate_count, unresolved_decision_ids_json,
      created_by, started_at, completed_at, expires_at
    ) VALUES (
      $id, $idempotencyKey, $profileId, $profileRevision, $entityId,
      $profileSha256, $contentSha256, $sourceSchemaSha256, $snapshotAt,
      $status, $totalCount, $acceptedCount, $needsReviewCount,
      $rejectedCount, $duplicateCount, $unresolvedDecisionIds,
      $actor, $startedAt, $completedAt, $expiresAt
    )
  `),
  entry(S.insertStagingRecord, `
    INSERT INTO sales_import_staging_records (
      run_id, row_number, entity_id, record_fingerprint, status,
      canonical_data_json, issues_json, created_at, expires_at
    ) VALUES (
      $runId, $rowNumber, $entityId, $recordFingerprint, $status,
      $canonicalData, $issues, $createdAt, $expiresAt
    )
  `),
  entry(S.listStagingRecords, `
    SELECT ${STAGING_COLUMNS}
    FROM sales_import_staging_records
    WHERE run_id = $runId
    ORDER BY row_number
  `),
  entry(S.purgeExpiredStaging, `
    DELETE FROM sales_import_staging_records
    WHERE expires_at <= $before
  `),

  entry(S.getBranchMappingHead, `
    SELECT ${BRANCH_MAPPING_HEAD_COLUMNS}
    FROM sales_branch_mapping_heads
    WHERE source_system = $sourceSystem
      AND external_branch_id = $externalBranchId
  `),
  entry(S.getBranchMappingRevision, `
    SELECT ${BRANCH_MAPPING_REVISION_COLUMNS}
    FROM sales_branch_mapping_revisions
    WHERE source_system = $sourceSystem
      AND external_branch_id = $externalBranchId
      AND revision = $revision
  `),
  entry(S.listBranchMappingRevisions, `
    SELECT ${BRANCH_MAPPING_REVISION_COLUMNS}
    FROM sales_branch_mapping_revisions
    WHERE source_system = $sourceSystem
      AND external_branch_id = $externalBranchId
    ORDER BY revision DESC
  `),
  entry(S.listActiveBranchMappings, `
    SELECT
      revision_row.source_system AS sourceSystem,
      revision_row.external_branch_id AS externalBranchId,
      revision_row.revision,
      revision_row.location_id AS locationId,
      revision_row.status,
      revision_row.valid_from AS validFrom,
      revision_row.valid_to AS validTo,
      revision_row.evidence_id AS evidenceId,
      revision_row.mapping_sha256 AS mappingSha256,
      revision_row.created_by AS createdBy,
      revision_row.created_at AS createdAt
    FROM sales_branch_mapping_heads head
    JOIN sales_branch_mapping_revisions revision_row
      ON revision_row.source_system = head.source_system
     AND revision_row.external_branch_id = head.external_branch_id
     AND revision_row.revision = head.active_revision
    WHERE head.source_system = $sourceSystem
      AND revision_row.status = 'approved'
    ORDER BY revision_row.external_branch_id
  `),
  entry(S.insertBranchMappingHead, `
    INSERT INTO sales_branch_mapping_heads (
      source_system, external_branch_id, created_by, updated_by, created_at, updated_at
    ) VALUES (
      $sourceSystem, $externalBranchId, $actor, $actor, $timestamp, $timestamp
    )
  `),
  entry(S.insertBranchMappingRevision, `
    INSERT INTO sales_branch_mapping_revisions (
      source_system, external_branch_id, revision, location_id, status,
      valid_from, valid_to, evidence_id, mapping_sha256, created_by, created_at
    ) VALUES (
      $sourceSystem, $externalBranchId, $revision, $locationId, $status,
      $validFrom, $validTo, $evidenceId, $mappingSha256, $actor, $timestamp
    )
  `),
  entry(S.activateBranchMappingRevision, `
    UPDATE sales_branch_mapping_heads
    SET active_revision = $revision,
        updated_by = $actor,
        updated_at = $timestamp
    WHERE source_system = $sourceSystem
      AND external_branch_id = $externalBranchId
      AND (
        ($expectedRevision IS NULL AND active_revision IS NULL)
        OR active_revision = $expectedRevision
      )
      AND EXISTS (
        SELECT 1
        FROM sales_branch_mapping_revisions revision_row
        WHERE revision_row.source_system = $sourceSystem
          AND revision_row.external_branch_id = $externalBranchId
          AND revision_row.revision = $revision
      )
  `),
  entry(S.getReport, `
    SELECT ${REPORT_COLUMNS}
    FROM sales_aggregate_reports
    WHERE id = $id
  `),
  entry(S.getReportBySourceSha256, `
    SELECT ${REPORT_COLUMNS}
    FROM sales_aggregate_reports
    WHERE source_file_sha256 = $sourceFileSha256
  `),
  entry(S.listReports, `
    SELECT ${REPORT_COLUMNS}
    FROM sales_aggregate_reports
    WHERE $locationId IS NULL OR location_id = $locationId
    ORDER BY period_end DESC, imported_at DESC, id DESC
    LIMIT $limit
  `),
  entry(S.insertReport, `
    INSERT INTO sales_aggregate_reports (
      id, source_system, source_file_sha256, parser_version, extraction,
      review_method, report_kind,
      external_branch_id, location_id, currency, period_start, period_end,
      comparison_start, comparison_end, year_to_date_start,
      year_to_date_comparison_start, generated_on, page_count,
      product_group_count, issue_count, reconciliation_status,
      imported_by, imported_at
    ) VALUES (
      $id, $sourceSystem, $sourceFileSha256, $parserVersion, $extraction,
      $reviewMethod, $reportKind,
      $externalBranchId, $locationId, $currency, $periodStart, $periodEnd,
      $comparisonStart, $comparisonEnd, $yearToDateStart,
      $yearToDateComparisonStart, $generatedOn, $pageCount,
      $productGroupCount, $issueCount, $reconciliationStatus,
      $actor, $timestamp
    )
  `),
  entry(S.insertReportProductGroupMetric, `
    INSERT INTO sales_report_product_group_metrics (
      report_id, horizon, external_product_group_id, product_group_label,
      current_quantity, comparison_quantity, current_net_revenue,
      comparison_net_revenue, current_gross_margin, comparison_gross_margin,
      current_customer_count, comparison_customer_count,
      current_revenue_per_customer, comparison_revenue_per_customer,
      source_page, source_ordinate
    ) VALUES (
      $reportId, $horizon, $externalProductGroupId, $productGroupLabel,
      $currentQuantity, $comparisonQuantity, $currentNetRevenue,
      $comparisonNetRevenue, $currentGrossMargin, $comparisonGrossMargin,
      $currentCustomerCount, $comparisonCustomerCount,
      $currentRevenuePerCustomer, $comparisonRevenuePerCustomer,
      $sourcePage, $sourceOrdinate
    )
  `),
  entry(S.listReportProductGroupMetrics, `
    SELECT ${REPORT_METRIC_COLUMNS}
    FROM sales_report_product_group_metrics
    WHERE report_id = $reportId
    ORDER BY CASE horizon WHEN 'period' THEN 0 ELSE 1 END,
      external_product_group_id
  `),
  entry(S.insertReportTotalMetric, `
    INSERT INTO sales_report_total_metrics (
      report_id, horizon, current_quantity, comparison_quantity,
      current_net_revenue, comparison_net_revenue, current_gross_margin,
      comparison_gross_margin, current_customer_count,
      comparison_customer_count, current_revenue_per_customer,
      comparison_revenue_per_customer, source_page
    ) VALUES (
      $reportId, $horizon, $currentQuantity, $comparisonQuantity,
      $currentNetRevenue, $comparisonNetRevenue, $currentGrossMargin,
      $comparisonGrossMargin, $currentCustomerCount,
      $comparisonCustomerCount, $currentRevenuePerCustomer,
      $comparisonRevenuePerCustomer, $sourcePage
    )
  `),
  entry(S.listReportTotalMetrics, `
    SELECT ${REPORT_TOTAL_COLUMNS}
    FROM sales_report_total_metrics
    WHERE report_id = $reportId
    ORDER BY CASE horizon WHEN 'period' THEN 0 ELSE 1 END
  `),
]);

module.exports = {
  SQLITE_SALES_ANALYTICS_CATALOG,
};
