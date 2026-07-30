"use strict";

const { definePersistenceStatement } = require("../contract");

const DATA_ROW = Object.freeze({ data: "json" });
const RECORD_PARAMETER = Object.freeze({ data: "json" });

function queryOne(id, parameters = {}) {
  return definePersistenceStatement({
    id: `governance-store.${id}`,
    operation: "queryOne",
    parameters,
    columns: DATA_ROW,
  });
}

function queryAll(id, parameters = {}) {
  return definePersistenceStatement({
    id: `governance-store.${id}`,
    operation: "queryAll",
    parameters,
    columns: DATA_ROW,
  });
}

function execute(id) {
  return definePersistenceStatement({
    id: `governance-store.${id}`,
    operation: "execute",
    parameters: RECORD_PARAMETER,
  });
}

const GOVERNANCE_STORE_STATEMENTS = Object.freeze({
  listRetentionRules: queryAll("list-retention-rules"),
  insertRetentionRule: execute("insert-retention-rule"),
  retentionRuleExists: queryOne("retention-rule-exists", { id: "text" }),
  listLegalHolds: queryAll("list-legal-holds"),
  insertLegalHold: execute("insert-legal-hold"),
  releaseLegalHold: execute("release-legal-hold"),
  insertRetentionPreview: execute("insert-retention-preview"),
  latestRetentionPreview: queryOne("latest-retention-preview"),

  privacyRequestById: queryOne("privacy-request-by-id", { id: "text" }),
  privacyRequestEvents: queryAll("privacy-request-events", { requestId: "text" }),
  privacyRequestRevision: queryOne("privacy-request-revision", { id: "text" }),
  upsertPrivacyRequest: execute("upsert-privacy-request"),
  insertPrivacyRequestEvent: execute("insert-privacy-request-event"),
  listPrivacyRequests: queryAll("list-privacy-requests"),
  listPrivacyRequestsByEmployee: queryAll("list-privacy-requests-by-employee", {
    employeeNumber: "text",
  }),
  retentionTimeEntries: queryAll("retention-time-entries"),
  retentionVacationHistory: queryAll("retention-vacation-history"),
  retentionPrivacyRequests: queryAll("retention-privacy-requests"),
  retentionAmuReports: queryAll("retention-amu-reports"),
  openPrivacyRequests: queryAll("open-privacy-requests"),
  privacyExportEmployee: queryOne("privacy-export-employee", {
    employeeNumber: "text",
  }),
  privacyExportTimeEntries: queryAll("privacy-export-time-entries", {
    employeeNumber: "text",
  }),
  privacyExportTimeCorrections: queryAll("privacy-export-time-corrections", {
    employeeNumber: "text",
  }),
  privacyExportVacationEntitlements: queryAll("privacy-export-vacation-entitlements", {
    employeeNumber: "text",
  }),
  privacyExportVacationHistory: queryAll("privacy-export-vacation-history", {
    employeeNumber: "text",
  }),
  privacyExportSicknessMetadata: queryAll("privacy-export-sickness-metadata", {
    employeeNumber: "text",
  }),
  insertPrivacyExportReceipt: execute("insert-privacy-export-receipt"),
  listVacationHistoryForIntegrity: queryAll("list-vacation-history-for-integrity"),
  listRetentionPreviewsForIntegrity: queryAll("list-retention-previews-for-integrity"),
  listPrivacyEventsForIntegrity: queryAll("list-privacy-events-for-integrity"),

  latestVacationAccount: queryOne("latest-vacation-account", {
    employeeNumber: "text",
    year: "safe_integer",
  }),
  vacationEntitlementEmployee: queryOne("vacation-entitlement-employee", {
    employeeNumber: "text",
  }),
  upsertVacationEntitlement: execute("upsert-vacation-entitlement"),
  vacationAccountById: queryOne("vacation-account-by-id", { id: "text" }),
  listVacationAccounts: queryAll("list-vacation-accounts"),
  insertVacationAccount: execute("insert-vacation-account"),
  listVacationAccountEvents: queryAll("list-vacation-account-events"),
  insertVacationAccountEvent: execute("insert-vacation-account-event"),
  vacationEntitlementsForBackfill: queryAll("vacation-entitlements-for-backfill"),

  timeStatementById: queryOne("time-statement-by-id", { id: "text" }),
  timeStatementSuccessor: queryOne("time-statement-successor", { id: "text" }),
  listTimeStatementsForIntegrity: queryAll("list-time-statements-for-integrity"),
  listTimeStatementEvents: queryAll("list-time-statement-events"),
  insertTimeStatement: execute("insert-time-statement"),
  insertTimeStatementEvent: execute("insert-time-statement-event"),
  latestTimeStatement: queryOne("latest-time-statement", {
    employeeNumber: "text",
    periodStart: "date",
    periodEnd: "date",
  }),
  listTimeStatementsForPeriod: queryAll("list-time-statements-for-period", {
    periodStart: "date",
    periodEnd: "date",
  }),
  timeEntriesForStatement: queryAll("time-entries-for-statement", {
    employeeNumber: "text",
    periodStart: "date",
    periodEnd: "date",
  }),

  payrollHandoffById: queryOne("payroll-handoff-by-id", { id: "text" }),
  payrollHandoffEvents: queryAll("payroll-handoff-events", { handoffId: "text" }),
  insertPayrollHandoffEvent: execute("insert-payroll-handoff-event"),
  latestPayrollHandoff: queryOne("latest-payroll-handoff", {
    month: "text",
    locationId: "text",
    departmentId: "text",
  }),
  insertPayrollHandoff: execute("insert-payroll-handoff"),
  listPayrollHandoffReferences: queryAll("list-payroll-handoff-references"),
  listPayrollHandoffsForIntegrity: queryAll("list-payroll-handoffs-for-integrity"),
  listPayrollHandoffEventsForIntegrity: queryAll("list-payroll-handoff-events-for-integrity"),
  payrollHandoffEventCount: definePersistenceStatement({
    id: "governance-store.payroll-handoff-event-count",
    operation: "queryOne",
    columns: { count: "safe_integer" },
  }),
});

module.exports = {
  GOVERNANCE_STORE_STATEMENTS,
};
