"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function queryOne(id, parameters = JSON_PARAMETER) {
  return definePersistenceStatement({
    id: `custom-process-management.${id}`,
    operation: "queryOne",
    parameters,
    columns: JSON_ROW,
  });
}

function queryAll(id, parameters = JSON_PARAMETER) {
  return definePersistenceStatement({
    id: `custom-process-management.${id}`,
    operation: "queryAll",
    parameters,
    columns: JSON_ROW,
  });
}

function execute(id, parameters = JSON_PARAMETER) {
  return definePersistenceStatement({
    id: `custom-process-management.${id}`,
    operation: "execute",
    parameters,
  });
}

const CUSTOM_PROCESS_MANAGEMENT_STATEMENTS = Object.freeze({
  activeLocation: queryOne("active-location"),
  activeDepartment: queryOne("active-department"),
  responsibilityCandidate: queryOne("responsibility-candidate"),
  listRecipientCandidates: queryAll("list-recipient-candidates", {}),
  listActiveLocations: queryAll("list-active-locations", {}),
  activeDepartmentStaffing: queryOne("active-department-staffing"),
  scopeIsActive: queryOne("scope-is-active"),

  listProcesses: queryAll("list-processes"),
  processById: queryOne("process-by-id"),
  listAllSteps: queryAll("list-all-steps", {}),
  listProcessSteps: queryAll("list-process-steps"),
  conflictingStep: queryOne("conflicting-step"),
  insertProcess: execute("insert-process"),
  updateProcess: execute("update-process"),
  setProcessStatus: execute("set-process-status"),
  deleteProcessSteps: execute("delete-process-steps"),
  insertProcessStep: execute("insert-process-step"),

  processRevision: queryOne("process-revision"),
  processRevisionExists: queryOne("process-revision-exists"),
  insertProcessRevision: execute("insert-process-revision"),

  listWorkflowPublications: queryAll("list-workflow-publications"),
  insertWorkflowPublication: execute("insert-workflow-publication"),
  insertWorkflowPublicationArchive: execute("insert-workflow-publication-archive"),

  runById: queryOne("run-by-id"),
  openRunForExternalJob: queryOne("open-run-for-external-job"),
  listOpenRunsForProcess: queryAll("list-open-runs-for-process"),
  runByTriggerKey: queryOne("run-by-trigger-key"),
  insertRun: execute("insert-run"),
  reopenRun: execute("reopen-run"),
  deleteRunSteps: execute("delete-run-steps"),
  countRunSteps: queryOne("count-run-steps"),
  insertRunStep: execute("insert-run-step"),
  openRunById: queryOne("open-run-by-id"),
  activeRunStep: queryOne("active-run-step"),
  pendingRunStep: queryOne("pending-run-step"),
  runStepById: queryOne("run-step-by-id"),
  completeSystemRunStep: execute("complete-system-run-step"),
  activateRunStep: execute("activate-run-step"),
  completeRunStep: execute("complete-run-step"),
  skipOpenRunSteps: execute("skip-open-run-steps"),
  resolveRun: execute("resolve-run"),
  listOpenStaffingRuns: queryAll("list-open-staffing-runs", {}),
  listOpenRuns: queryAll("list-open-runs", {}),
  listActiveTaskRuns: queryAll("list-active-task-runs", {}),
  runStepCounts: queryOne("run-step-counts"),

  insertPortalNotification: execute("insert-portal-notification"),
  markRunNotificationsRead: execute("mark-run-notifications-read"),
  markTaskNotificationRead: execute("mark-task-notification-read"),

  listNotificationPreferences: queryAll("list-notification-preferences"),
  notificationPreference: queryOne("notification-preference"),
  listEnabledStaffingPreferences: queryAll("list-enabled-staffing-preferences"),
  upsertNotificationPreference: execute("upsert-notification-preference"),
  startNotificationVerification: execute("start-notification-verification"),
  clearNotificationVerification: execute("clear-notification-verification"),
  updateNotificationVerificationAttempts: execute("update-notification-verification-attempts"),
  confirmNotificationVerification: execute("confirm-notification-verification"),

  insertOutboundJob: execute("insert-outbound-job"),
  outboundJobByDedupe: queryOne("outbound-job-by-dedupe"),
  listDueOutboundJobs: queryAll("list-due-outbound-jobs"),
  claimOutboundJob: execute("claim-outbound-job"),
  rearmOutboundJob: execute("rearm-outbound-job"),
  cancelOutboundJob: execute("cancel-outbound-job"),
  cancelOutboundJobsByEntity: execute("cancel-outbound-jobs-by-entity"),
  markOutboundJobSent: execute("mark-outbound-job-sent"),
  markOutboundJobFailed: execute("mark-outbound-job-failed"),

  insertAudit: execute("insert-audit"),
});

module.exports = {
  CUSTOM_PROCESS_MANAGEMENT_STATEMENTS,
};
