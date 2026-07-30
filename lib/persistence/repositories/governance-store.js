"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  GOVERNANCE_STORE_STATEMENTS,
} = require("../statements/governance-store");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function requiredText(value, operation) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw invalidInput(operation);
  }
  return value;
}

function textValue(value, operation) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw invalidInput(operation);
  }
  return value;
}

function requiredRecord(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(operation);
  }
  return value;
}

function unwrap(row) {
  return row?.data || null;
}

function unwrapAll(rows) {
  return rows.map(({ data }) => data);
}

function methodsFor(access) {
  const queryOne = async (statement, parameters) => unwrap(
    await access.queryOne(statement, parameters),
  );
  const queryAll = async (statement, parameters) => unwrapAll(
    await access.queryAll(statement, parameters),
  );
  const execute = (statement, data, operation) => access.execute(statement, {
    data: requiredRecord(data, operation),
  });

  return {
    listRetentionRules: () => queryAll(GOVERNANCE_STORE_STATEMENTS.listRetentionRules),
    insertRetentionRule: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertRetentionRule,
      data,
      "insertRetentionRule",
    ),
    retentionRuleExists: (id) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.retentionRuleExists,
      { id: requiredText(id, "retentionRuleExists") },
    ),
    listLegalHolds: () => queryAll(GOVERNANCE_STORE_STATEMENTS.listLegalHolds),
    insertLegalHold: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertLegalHold,
      data,
      "insertLegalHold",
    ),
    releaseLegalHold: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.releaseLegalHold,
      data,
      "releaseLegalHold",
    ),
    insertRetentionPreview: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertRetentionPreview,
      data,
      "insertRetentionPreview",
    ),
    latestRetentionPreview: () => queryOne(
      GOVERNANCE_STORE_STATEMENTS.latestRetentionPreview,
    ),

    privacyRequestById: (id) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.privacyRequestById,
      { id: requiredText(id, "privacyRequestById") },
    ),
    privacyRequestEvents: (requestId) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.privacyRequestEvents,
      { requestId: requiredText(requestId, "privacyRequestEvents") },
    ),
    privacyRequestRevision: (id) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.privacyRequestRevision,
      { id: requiredText(id, "privacyRequestRevision") },
    ),
    upsertPrivacyRequest: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.upsertPrivacyRequest,
      data,
      "upsertPrivacyRequest",
    ),
    insertPrivacyRequestEvent: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertPrivacyRequestEvent,
      data,
      "insertPrivacyRequestEvent",
    ),
    listPrivacyRequests(employeeNumber = "") {
      if (!employeeNumber) {
        return queryAll(GOVERNANCE_STORE_STATEMENTS.listPrivacyRequests);
      }
      return queryAll(GOVERNANCE_STORE_STATEMENTS.listPrivacyRequestsByEmployee, {
        employeeNumber: requiredText(employeeNumber, "listPrivacyRequests"),
      });
    },
    retentionTimeEntries: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.retentionTimeEntries,
    ),
    retentionVacationHistory: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.retentionVacationHistory,
    ),
    retentionPrivacyRequests: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.retentionPrivacyRequests,
    ),
    retentionAmuReports: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.retentionAmuReports,
    ),
    openPrivacyRequests: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.openPrivacyRequests,
    ),
    privacyExportEmployee: (employeeNumber) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.privacyExportEmployee,
      { employeeNumber: requiredText(employeeNumber, "privacyExportEmployee") },
    ),
    privacyExportTimeEntries: (employeeNumber) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.privacyExportTimeEntries,
      { employeeNumber: requiredText(employeeNumber, "privacyExportTimeEntries") },
    ),
    privacyExportTimeCorrections: (employeeNumber) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.privacyExportTimeCorrections,
      { employeeNumber: requiredText(employeeNumber, "privacyExportTimeCorrections") },
    ),
    privacyExportVacationEntitlements: (employeeNumber) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.privacyExportVacationEntitlements,
      { employeeNumber: requiredText(employeeNumber, "privacyExportVacationEntitlements") },
    ),
    privacyExportVacationHistory: (employeeNumber) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.privacyExportVacationHistory,
      { employeeNumber: requiredText(employeeNumber, "privacyExportVacationHistory") },
    ),
    privacyExportSicknessMetadata: (employeeNumber) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.privacyExportSicknessMetadata,
      { employeeNumber: requiredText(employeeNumber, "privacyExportSicknessMetadata") },
    ),
    insertPrivacyExportReceipt: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertPrivacyExportReceipt,
      data,
      "insertPrivacyExportReceipt",
    ),
    listVacationHistoryForIntegrity: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listVacationHistoryForIntegrity,
    ),
    listRetentionPreviewsForIntegrity: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listRetentionPreviewsForIntegrity,
    ),
    listPrivacyEventsForIntegrity: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listPrivacyEventsForIntegrity,
    ),

    latestVacationAccount: (employeeNumber, year) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.latestVacationAccount,
      {
        employeeNumber: requiredText(employeeNumber, "latestVacationAccount"),
        year,
      },
    ),
    vacationEntitlementEmployee: (employeeNumber) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.vacationEntitlementEmployee,
      { employeeNumber: requiredText(employeeNumber, "vacationEntitlementEmployee") },
    ),
    upsertVacationEntitlement: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.upsertVacationEntitlement,
      data,
      "upsertVacationEntitlement",
    ),
    vacationAccountById: (id) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.vacationAccountById,
      { id: requiredText(id, "vacationAccountById") },
    ),
    listVacationAccounts: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listVacationAccounts,
    ),
    insertVacationAccount: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertVacationAccount,
      data,
      "insertVacationAccount",
    ),
    listVacationAccountEvents: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listVacationAccountEvents,
    ),
    insertVacationAccountEvent: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertVacationAccountEvent,
      data,
      "insertVacationAccountEvent",
    ),
    vacationEntitlementsForBackfill: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.vacationEntitlementsForBackfill,
    ),

    timeStatementById: (id) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.timeStatementById,
      { id: requiredText(id, "timeStatementById") },
    ),
    timeStatementSuccessor: (id) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.timeStatementSuccessor,
      { id: requiredText(id, "timeStatementSuccessor") },
    ),
    listTimeStatementsForIntegrity: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listTimeStatementsForIntegrity,
    ),
    listTimeStatementEvents: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listTimeStatementEvents,
    ),
    insertTimeStatement: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertTimeStatement,
      data,
      "insertTimeStatement",
    ),
    insertTimeStatementEvent: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertTimeStatementEvent,
      data,
      "insertTimeStatementEvent",
    ),
    latestTimeStatement: ({ employeeNumber, periodStart, periodEnd }) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.latestTimeStatement,
      {
        employeeNumber: requiredText(employeeNumber, "latestTimeStatement"),
        periodStart,
        periodEnd,
      },
    ),
    listTimeStatementsForPeriod: ({ periodStart, periodEnd }) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listTimeStatementsForPeriod,
      { periodStart, periodEnd },
    ),
    timeEntriesForStatement: ({ employeeNumber, periodStart, periodEnd }) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.timeEntriesForStatement,
      {
        employeeNumber: requiredText(employeeNumber, "timeEntriesForStatement"),
        periodStart,
        periodEnd,
      },
    ),

    payrollHandoffById: (id) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.payrollHandoffById,
      { id: requiredText(id, "payrollHandoffById") },
    ),
    payrollHandoffEvents: (handoffId) => queryAll(
      GOVERNANCE_STORE_STATEMENTS.payrollHandoffEvents,
      { handoffId: requiredText(handoffId, "payrollHandoffEvents") },
    ),
    insertPayrollHandoffEvent: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertPayrollHandoffEvent,
      data,
      "insertPayrollHandoffEvent",
    ),
    latestPayrollHandoff: ({ month, locationId, departmentId }) => queryOne(
      GOVERNANCE_STORE_STATEMENTS.latestPayrollHandoff,
      {
        month: requiredText(month, "latestPayrollHandoff"),
        locationId: textValue(locationId, "latestPayrollHandoff"),
        departmentId: textValue(departmentId, "latestPayrollHandoff"),
      },
    ),
    insertPayrollHandoff: (data) => execute(
      GOVERNANCE_STORE_STATEMENTS.insertPayrollHandoff,
      data,
      "insertPayrollHandoff",
    ),
    listPayrollHandoffReferences: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listPayrollHandoffReferences,
    ),
    listPayrollHandoffsForIntegrity: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listPayrollHandoffsForIntegrity,
    ),
    listPayrollHandoffEventsForIntegrity: () => queryAll(
      GOVERNANCE_STORE_STATEMENTS.listPayrollHandoffEventsForIntegrity,
    ),
    async payrollHandoffEventCount() {
      const row = await access.queryOne(
        GOVERNANCE_STORE_STATEMENTS.payrollHandoffEventCount,
      );
      return row?.count || 0;
    },
  };
}

function createGovernanceStoreRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => (
          work(createGovernanceStoreRepository(executor))
        ));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
}

function assertGovernanceStoreRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new TypeError("Ein Governance-Repository wird benÃ¶tigt.");
  }
  return repository;
}

module.exports = {
  assertGovernanceStoreRepository,
  createGovernanceStoreRepository,
};
