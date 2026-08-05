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
  workflowPublicationById: queryOne("workflow-publication-by-id"),
  insertWorkflowPublication: execute("insert-workflow-publication"),
  insertWorkflowPublicationArchive: execute("insert-workflow-publication-archive"),
  processHasWorkflowPublications: queryOne("process-has-workflow-publications"),

  personnelWorkflowCandidateSubject: queryOne("personnel-workflow-candidate-subject"),
  personnelWorkflowEmployeeSubject: queryOne("personnel-workflow-employee-subject"),
  runBindingByOperationId: queryOne("run-binding-by-operation-id"),
  personnelWorkflowInstanceById: queryOne("personnel-workflow-instance-by-id"),
  insertRunBinding: execute("insert-run-binding"),
  insertRunStepAssignment: execute("insert-run-step-assignment"),
  listRunStepAssignments: queryAll("list-run-step-assignments"),
  listPersonnelWorkflowInstances: queryAll("list-personnel-workflow-instances", {}),
  listActivePersonnelWorkflowTaskRuns: queryAll("list-active-personnel-workflow-task-runs"),

  onboardingOperationById: queryOne("onboarding-operation-by-id"),
  onboardingCaseById: queryOne("onboarding-case-by-id"),
  currentEpisodeOnboardingCaseForEmployee: queryOne("current-episode-onboarding-case-for-employee"),
  employmentEpisodeForEmployee: queryOne("employment-episode-for-employee"),
  insertEmploymentEpisode: execute("insert-employment-episode"),
  insertLifecycleCase: execute("insert-lifecycle-case"),
  transitionLifecycleCase: execute("transition-lifecycle-case"),
  insertLifecycleReferenceDates: execute("insert-lifecycle-reference-dates"),
  insertLifecyclePackageBinding: execute("insert-lifecycle-package-binding"),
  insertLifecyclePackageRun: execute("insert-lifecycle-package-run"),
  insertLifecycleAssignment: execute("insert-lifecycle-assignment"),
  insertLifecycleAssignmentBinding: execute("insert-lifecycle-assignment-binding"),
  lifecycleCaseLastEvent: queryOne("lifecycle-case-last-event"),
  lifecycleCaseEventById: queryOne("lifecycle-case-event-by-id"),
  insertLifecycleCaseEvent: execute("insert-lifecycle-case-event"),
  insertOnboardingOperation: execute("insert-onboarding-operation"),
  listLifecyclePackageRuns: queryAll("list-lifecycle-package-runs"),
  listLifecycleAssignments: queryAll("list-lifecycle-assignments"),
  lifecycleCaseProgress: queryOne("lifecycle-case-progress"),
  listActiveLifecycleOnboardingTasks: queryAll("list-active-lifecycle-onboarding-tasks"),
  lifecycleOnboardingTaskContext: queryOne("lifecycle-onboarding-task-context"),

  offboardingOperationById: queryOne("offboarding-operation-by-id"),
  offboardingCaseById: queryOne("offboarding-case-by-id"),
  currentEpisodeOffboardingCaseForEmployee: queryOne(
    "current-episode-offboarding-case-for-employee",
  ),
  offboardingEmploymentContextForEmployee: queryOne(
    "offboarding-employment-context-for-employee",
  ),
  offboardingLatestReferenceDates: queryOne("offboarding-latest-reference-dates"),
  offboardingCaseEventById: queryOne("offboarding-case-event-by-id"),
  offboardingCaseLastEvent: queryOne("offboarding-case-last-event"),
  offboardingConfidentialAccessLastEvent: queryOne(
    "offboarding-confidential-access-last-event",
  ),
  listOffboardingConfidentialAccessEvents: queryAll(
    "list-offboarding-confidential-access-events",
  ),
  offboardingRuntimeProcessShellById: queryOne("offboarding-runtime-process-shell-by-id"),
  offboardingPackageVersionById: queryOne("offboarding-package-version-by-id"),
  listApplicableOffboardingPackageVersions: queryAll(
    "list-applicable-offboarding-package-versions",
  ),
  listOffboardingPackageRuns: queryAll("list-offboarding-package-runs"),
  listOffboardingAssignments: queryAll("list-offboarding-assignments"),
  offboardingCaseProjection: queryOne("offboarding-case-projection"),
  offboardingCaseProgress: queryOne("offboarding-case-progress"),
  offboardingTimeCriticalApprovalStatus: queryOne(
    "offboarding-time-critical-approval-status",
  ),
  listActiveLifecycleOffboardingTasks: queryAll(
    "list-active-lifecycle-offboarding-tasks",
  ),
  lifecycleOffboardingTaskContext: queryOne("lifecycle-offboarding-task-context"),
  offboardingRunTerminationByRunId: queryOne("offboarding-run-termination-by-run-id"),
  insertOffboardingRuntimeProcessShell: execute("insert-offboarding-runtime-process-shell"),
  insertOffboardingPackageVersion: execute("insert-offboarding-package-version"),
  insertOffboardingPackageVersionArchive: execute(
    "insert-offboarding-package-version-archive",
  ),
  insertOffboardingLifecycleCase: execute("insert-offboarding-lifecycle-case"),
  insertOffboardingEmploymentEpisode: execute("insert-offboarding-employment-episode"),
  transitionOffboardingLifecycleCase: execute("transition-offboarding-lifecycle-case"),
  transitionOffboardingEmploymentEpisode: execute(
    "transition-offboarding-employment-episode",
  ),
  insertOffboardingReferenceDates: execute("insert-offboarding-reference-dates"),
  insertOffboardingLifecycleCaseEvent: execute("insert-offboarding-lifecycle-case-event"),
  insertOffboardingConfidentialAccessEvent: execute(
    "insert-offboarding-confidential-access-event",
  ),
  insertOffboardingPackageBinding: execute("insert-offboarding-package-binding"),
  insertOffboardingRun: execute("insert-offboarding-run"),
  insertOffboardingPackageRun: execute("insert-offboarding-package-run"),
  insertOffboardingRuntimeStep: execute("insert-offboarding-runtime-step"),
  insertOffboardingRunStep: execute("insert-offboarding-run-step"),
  insertOffboardingAssignment: execute("insert-offboarding-assignment"),
  insertOffboardingAssignmentBinding: execute("insert-offboarding-assignment-binding"),
  insertOffboardingOperation: execute("insert-offboarding-operation"),
  completeOffboardingRunStep: execute("complete-offboarding-run-step"),
  activateNextOffboardingRunStep: execute("activate-next-offboarding-run-step"),
  resolveOffboardingRun: execute("resolve-offboarding-run"),
  insertOffboardingRunTermination: execute("insert-offboarding-run-termination"),

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
