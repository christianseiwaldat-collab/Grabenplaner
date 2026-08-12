"use strict";

const { definePersistenceStatement } = require("../contract");

const nullable = (kind) => Object.freeze({ kind, nullable: true });

function queryOne(id, parameters, columns) {
  return definePersistenceStatement({
    id: `sales-analytics.${id}`,
    operation: "queryOne",
    parameters,
    columns,
  });
}

function queryAll(id, parameters, columns) {
  return definePersistenceStatement({
    id: `sales-analytics.${id}`,
    operation: "queryAll",
    parameters,
    columns,
  });
}

function execute(id, parameters) {
  return definePersistenceStatement({
    id: `sales-analytics.${id}`,
    operation: "execute",
    parameters,
  });
}

const PROFILE_COLUMNS = Object.freeze({
  id: "text",
  name: "text",
  entityId: "text",
  activeRevision: nullable("safe_integer"),
  active: "boolean",
  createdBy: "text",
  updatedBy: "text",
  createdAt: "utc_timestamp",
  updatedAt: "utc_timestamp",
});

const PROFILE_REVISION_COLUMNS = Object.freeze({
  profileId: "text",
  revision: "safe_integer",
  contractVersion: "safe_integer",
  modelVersion: "safe_integer",
  sourceSchemaSha256: "text",
  profileSha256: "text",
  profile: "json",
  createdBy: "text",
  createdAt: "utc_timestamp",
});

const RUN_COLUMNS = Object.freeze({
  id: "text",
  idempotencyKey: "text",
  profileId: "text",
  profileRevision: "safe_integer",
  entityId: "text",
  profileSha256: "text",
  contentSha256: "text",
  sourceSchemaSha256: "text",
  snapshotAt: "utc_timestamp",
  status: "text",
  totalCount: "safe_integer",
  acceptedCount: "safe_integer",
  needsReviewCount: "safe_integer",
  rejectedCount: "safe_integer",
  duplicateCount: "safe_integer",
  unresolvedDecisionIds: "json",
  createdBy: "text",
  startedAt: "utc_timestamp",
  completedAt: "utc_timestamp",
  expiresAt: "utc_timestamp",
});

const STAGING_COLUMNS = Object.freeze({
  runId: "text",
  rowNumber: "safe_integer",
  entityId: "text",
  recordFingerprint: nullable("text"),
  status: "text",
  canonicalData: "json",
  issues: "json",
  createdAt: "utc_timestamp",
  expiresAt: "utc_timestamp",
});

const BRANCH_MAPPING_HEAD_COLUMNS = Object.freeze({
  sourceSystem: "text",
  externalBranchId: "text",
  activeRevision: nullable("safe_integer"),
  createdBy: "text",
  updatedBy: "text",
  createdAt: "utc_timestamp",
  updatedAt: "utc_timestamp",
});

const BRANCH_MAPPING_REVISION_COLUMNS = Object.freeze({
  sourceSystem: "text",
  externalBranchId: "text",
  revision: "safe_integer",
  locationId: nullable("text"),
  status: "text",
  validFrom: "date",
  validTo: nullable("date"),
  evidenceId: "text",
  mappingSha256: "text",
  createdBy: "text",
  createdAt: "utc_timestamp",
});

const REPORT_COLUMNS = Object.freeze({
  id: "text",
  sourceSystem: "text",
  sourceFileSha256: "text",
  parserVersion: "safe_integer",
  extraction: "text",
  reviewMethod: "text",
  reportKind: "text",
  externalBranchId: "text",
  locationId: "text",
  currency: "text",
  periodStart: "date",
  periodEnd: "date",
  comparisonStart: "date",
  comparisonEnd: "date",
  yearToDateStart: "date",
  yearToDateComparisonStart: "date",
  generatedOn: nullable("date"),
  pageCount: "safe_integer",
  productGroupCount: "safe_integer",
  issueCount: "safe_integer",
  reconciliationStatus: "text",
  importedBy: "text",
  importedAt: "utc_timestamp",
});

const REPORT_METRIC_COLUMNS = Object.freeze({
  reportId: "text",
  horizon: "text",
  externalProductGroupId: "text",
  productGroupLabel: "text",
  currentQuantity: "text",
  comparisonQuantity: "text",
  currentNetRevenue: "text",
  comparisonNetRevenue: "text",
  currentGrossMargin: "text",
  comparisonGrossMargin: "text",
  currentCustomerCount: "text",
  comparisonCustomerCount: "text",
  currentRevenuePerCustomer: nullable("text"),
  comparisonRevenuePerCustomer: nullable("text"),
  sourcePage: "safe_integer",
  sourceOrdinate: "text",
});

const REPORT_TOTAL_COLUMNS = Object.freeze({
  reportId: "text",
  horizon: "text",
  currentQuantity: "text",
  comparisonQuantity: "text",
  currentNetRevenue: "text",
  comparisonNetRevenue: "text",
  currentGrossMargin: "text",
  comparisonGrossMargin: "text",
  currentCustomerCount: "text",
  comparisonCustomerCount: "text",
  currentRevenuePerCustomer: nullable("text"),
  comparisonRevenuePerCustomer: nullable("text"),
  sourcePage: "safe_integer",
});

const SALES_ANALYTICS_PERSISTENCE_STATEMENTS = Object.freeze({
  listProfiles: queryAll("profiles.list", {
    activeOnly: "boolean",
  }, PROFILE_COLUMNS),
  getProfile: queryOne("profiles.get", {
    id: "text",
  }, PROFILE_COLUMNS),
  getProfileRevision: queryOne("profile-revisions.get", {
    profileId: "text",
    revision: "safe_integer",
  }, PROFILE_REVISION_COLUMNS),
  listProfileRevisions: queryAll("profile-revisions.list", {
    profileId: "text",
  }, PROFILE_REVISION_COLUMNS),
  insertProfile: execute("profiles.insert", {
    id: "text",
    name: "text",
    entityId: "text",
    active: "boolean",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  insertProfileRevision: execute("profile-revisions.insert", {
    profileId: "text",
    revision: "safe_integer",
    contractVersion: "safe_integer",
    modelVersion: "safe_integer",
    sourceSchemaSha256: "text",
    profileSha256: "text",
    profile: "json",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  activateProfileRevision: execute("profiles.activate-revision", {
    id: "text",
    name: "text",
    revision: "safe_integer",
    expectedRevision: nullable("safe_integer"),
    actor: "text",
    timestamp: "utc_timestamp",
  }),

  getRun: queryOne("runs.get", {
    id: "text",
  }, RUN_COLUMNS),
  getRunByIdempotencyKey: queryOne("runs.get-by-idempotency-key", {
    idempotencyKey: "text",
  }, RUN_COLUMNS),
  listRuns: queryAll("runs.list", {
    profileId: nullable("text"),
    limit: "safe_integer",
  }, RUN_COLUMNS),
  insertRun: execute("runs.insert", {
    id: "text",
    idempotencyKey: "text",
    profileId: "text",
    profileRevision: "safe_integer",
    entityId: "text",
    profileSha256: "text",
    contentSha256: "text",
    sourceSchemaSha256: "text",
    snapshotAt: "utc_timestamp",
    status: "text",
    totalCount: "safe_integer",
    acceptedCount: "safe_integer",
    needsReviewCount: "safe_integer",
    rejectedCount: "safe_integer",
    duplicateCount: "safe_integer",
    unresolvedDecisionIds: "json",
    actor: "text",
    startedAt: "utc_timestamp",
    completedAt: "utc_timestamp",
    expiresAt: "utc_timestamp",
  }),
  insertStagingRecord: execute("staging.insert", {
    runId: "text",
    rowNumber: "safe_integer",
    entityId: "text",
    recordFingerprint: nullable("text"),
    status: "text",
    canonicalData: "json",
    issues: "json",
    createdAt: "utc_timestamp",
    expiresAt: "utc_timestamp",
  }),
  listStagingRecords: queryAll("staging.list", {
    runId: "text",
  }, STAGING_COLUMNS),
  purgeExpiredStaging: execute("staging.purge-expired", {
    before: "utc_timestamp",
  }),

  getBranchMappingHead: queryOne("branch-mapping-heads.get", {
    sourceSystem: "text",
    externalBranchId: "text",
  }, BRANCH_MAPPING_HEAD_COLUMNS),
  getBranchMappingRevision: queryOne("branch-mapping-revisions.get", {
    sourceSystem: "text",
    externalBranchId: "text",
    revision: "safe_integer",
  }, BRANCH_MAPPING_REVISION_COLUMNS),
  listBranchMappingRevisions: queryAll("branch-mapping-revisions.list", {
    sourceSystem: "text",
    externalBranchId: "text",
  }, BRANCH_MAPPING_REVISION_COLUMNS),
  listActiveBranchMappings: queryAll("branch-mappings.list-active", {
    sourceSystem: "text",
  }, BRANCH_MAPPING_REVISION_COLUMNS),
  insertBranchMappingHead: execute("branch-mapping-heads.insert", {
    sourceSystem: "text",
    externalBranchId: "text",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  insertBranchMappingRevision: execute("branch-mapping-revisions.insert", {
    sourceSystem: "text",
    externalBranchId: "text",
    revision: "safe_integer",
    locationId: nullable("text"),
    status: "text",
    validFrom: "date",
    validTo: nullable("date"),
    evidenceId: "text",
    mappingSha256: "text",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  activateBranchMappingRevision: execute("branch-mapping-heads.activate-revision", {
    sourceSystem: "text",
    externalBranchId: "text",
    revision: "safe_integer",
    expectedRevision: nullable("safe_integer"),
    actor: "text",
    timestamp: "utc_timestamp",
  }),

  getReport: queryOne("reports.get", {
    id: "text",
  }, REPORT_COLUMNS),
  getReportBySourceSha256: queryOne("reports.get-by-source-sha256", {
    sourceFileSha256: "text",
  }, REPORT_COLUMNS),
  listReports: queryAll("reports.list", {
    locationId: nullable("text"),
    limit: "safe_integer",
  }, REPORT_COLUMNS),
  insertReport: execute("reports.insert", {
    id: "text",
    sourceSystem: "text",
    sourceFileSha256: "text",
    parserVersion: "safe_integer",
    extraction: "text",
    reviewMethod: "text",
    reportKind: "text",
    externalBranchId: "text",
    locationId: "text",
    currency: "text",
    periodStart: "date",
    periodEnd: "date",
    comparisonStart: "date",
    comparisonEnd: "date",
    yearToDateStart: "date",
    yearToDateComparisonStart: "date",
    generatedOn: nullable("date"),
    pageCount: "safe_integer",
    productGroupCount: "safe_integer",
    issueCount: "safe_integer",
    reconciliationStatus: "text",
    actor: "text",
    timestamp: "utc_timestamp",
  }),
  insertReportProductGroupMetric: execute("report-product-group-metrics.insert", {
    reportId: "text",
    horizon: "text",
    externalProductGroupId: "text",
    productGroupLabel: "text",
    currentQuantity: "text",
    comparisonQuantity: "text",
    currentNetRevenue: "text",
    comparisonNetRevenue: "text",
    currentGrossMargin: "text",
    comparisonGrossMargin: "text",
    currentCustomerCount: "text",
    comparisonCustomerCount: "text",
    currentRevenuePerCustomer: nullable("text"),
    comparisonRevenuePerCustomer: nullable("text"),
    sourcePage: "safe_integer",
    sourceOrdinate: "text",
  }),
  listReportProductGroupMetrics: queryAll("report-product-group-metrics.list", {
    reportId: "text",
  }, REPORT_METRIC_COLUMNS),
  insertReportTotalMetric: execute("report-total-metrics.insert", {
    reportId: "text",
    horizon: "text",
    currentQuantity: "text",
    comparisonQuantity: "text",
    currentNetRevenue: "text",
    comparisonNetRevenue: "text",
    currentGrossMargin: "text",
    comparisonGrossMargin: "text",
    currentCustomerCount: "text",
    comparisonCustomerCount: "text",
    currentRevenuePerCustomer: nullable("text"),
    comparisonRevenuePerCustomer: nullable("text"),
    sourcePage: "safe_integer",
  }),
  listReportTotalMetrics: queryAll("report-total-metrics.list", {
    reportId: "text",
  }, REPORT_TOTAL_COLUMNS),
});

module.exports = {
  SALES_ANALYTICS_PERSISTENCE_STATEMENTS,
};
