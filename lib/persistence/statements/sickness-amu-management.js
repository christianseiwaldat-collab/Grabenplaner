"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function statement(name, operation, returning = false) {
  const id = name.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`);
  return definePersistenceStatement({
    id: `sickness-amu-management.${id}`,
    operation,
    parameters: JSON_PARAMETER,
    ...(operation === "execute" && !returning ? {} : { columns: JSON_ROW }),
  });
}

const QUERY_ONE = Object.freeze([
  "getSicknessCaseRetention",
  "getSicknessAlertByDedupe",
  "getNotificationPreference",
  "getOutboundNotificationJobByDedupe",
  "getPersonnelDocument",
  "countPendingAmuForContext",
  "getSicknessContract",
  "getSicknessValuationContext",
  "getDepartmentStaffingRequirement",
  "getSicknessCaseDisplayContext",
  "getSicknessCase",
  "getAmuReport",
  "getAmuDocument",
  "getOwnOpenAmuReport",
  "countOtherAmuReportsForCase",
  "getEmployeePersonnelRecordProjection",
]);

const QUERY_ALL = Object.freeze([
  "listNotificationRecipientPrincipals",
  "listSicknessAlertsByCase",
  "listProtectedNotificationRecipients",
  "listEscalationSicknessCases",
  "listNotificationPreferences",
  "listActiveNotificationPreferences",
  "listDueOutboundJobs",
  "listExpiredSicknessCases",
  "listPersonnelDocuments",
  "listDeletedPersonnelDocuments",
  "listPersonnelDocumentStorageKeys",
  "listActivePersonnelDocuments",
  "listAmuDocumentsForReports",
  "listSicknessAllowanceCases",
  "listSicknessCasesForCredit",
  "listActiveSicknessCases",
  "listStaffingShiftsForEmployee",
  "listStaffingEmployeesAtPoint",
  "listProtectedCaseEvents",
  "listSicknessCaseReportStatuses",
  "listOwnSicknessCases",
  "listOwnAmuReports",
  "listOpenAmuReports",
  "listActiveAmuDocuments",
  "listAmuReportsForRetention",
  "listAmuDocumentsForReportIds",
  "listAmuDocumentStorageKeys",
  "listLinkedAmuReports",
  "listAllSicknessCases",
  "listAllAmuReports",
  "listAmuReportsForEmployee",
]);

const EXECUTE = Object.freeze([
  "recordAudit",
  "insertProtectedNotification",
  "reactivateProtectedNotification",
  "updateSicknessAlert",
  "insertSicknessAlert",
  "markProtectedNotificationRead",
  "markProtectedEntityNotificationsRead",
  "markNotificationReadByDedupe",
  "reactivateNotificationByDedupe",
  "cancelPendingJobsForEntity",
  "updateSicknessCasePayload",
  "upsertNotificationPreference",
  "requestNotificationVerification",
  "resetNotificationVerification",
  "incrementNotificationVerificationAttempts",
  "confirmNotificationVerification",
  "insertOutboundNotificationJob",
  "rearmOutboundNotificationJob",
  "claimOutboundJob",
  "cancelOutboundJob",
  "markOutboundJobSent",
  "rescheduleOutboundJob",
  "deleteExpiredSicknessAlerts",
  "deleteExpiredOutboundJobs",
  "deleteProtectedNotificationsByEntity",
  "deleteExpiredSicknessCase",
  "deleteProtectedCaseEvents",
  "insertProtectedCaseEvent",
  "upsertPersonnelSensitiveRecord",
  "markPersonnelDocumentPurged",
  "insertPersonnelDocument",
  "markPersonnelDocumentDeleted",
  "markPersonnelDocumentActive",
  "markAmuDocumentDeleted",
  "markAmuDocumentPurged",
  "purgeAmuReportIfNoDocuments",
  "updateAmuReportPayload",
  "updateAmuReportRetention",
  "insertSicknessCase",
  "updateSicknessCasePayloadInitial",
  "updateSicknessCaseWithdraw",
  "updateSicknessCaseVersioned",
  "updateSicknessCaseVersionedForEmployee",
  "upsertPortalSetting",
  "insertAmuReport",
  "insertAmuDocument",
  "updateAmuReportWithdraw",
  "markAmuDocumentsDeletedByReport",
  "updateAmuReportVersioned",
  "restoreAmuDocument",
]);

const RETURNING_EXECUTE = new Set([
  "insertSicknessCase",
  "insertAmuReport",
]);

const SICKNESS_AMU_MANAGEMENT_STATEMENTS = Object.freeze(Object.fromEntries([
  ...QUERY_ONE.map((name) => [name, statement(name, "queryOne")]),
  ...QUERY_ALL.map((name) => [name, statement(name, "queryAll")]),
  ...EXECUTE.map((name) => [name, statement(name, "execute", RETURNING_EXECUTE.has(name))]),
]));

module.exports = {
  SICKNESS_AMU_MANAGEMENT_STATEMENTS,
};
