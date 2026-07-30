"use strict";

const { definePersistenceStatement } = require("../contract");

const DATA_ROW = Object.freeze({ data: "json" });
const RECORD_PARAMETER = Object.freeze({ data: "json" });

function queryOne(id, parameters = {}) {
  return definePersistenceStatement({
    id: `absence-management.${id}`,
    operation: "queryOne",
    parameters,
    columns: DATA_ROW,
  });
}

function queryAll(id, parameters = {}) {
  return definePersistenceStatement({
    id: `absence-management.${id}`,
    operation: "queryAll",
    parameters,
    columns: DATA_ROW,
  });
}

function execute(id, { returning = false } = {}) {
  return definePersistenceStatement({
    id: `absence-management.${id}`,
    operation: "execute",
    parameters: RECORD_PARAMETER,
    columns: returning ? DATA_ROW : {},
  });
}

const TEXT_EMPLOYEE = Object.freeze({ employeeNumber: "text" });
const INTEGER_ID = Object.freeze({ id: "safe_integer" });
const TEXT_ID = Object.freeze({ id: "text" });
const DATA_QUERY = Object.freeze({ data: "json" });
const REQUEST_KINDS = Object.freeze([
  "vacation",
  "timeOff",
  "vacationChange",
  "timeOffChange",
]);
const REQUEST_KIND_SLUGS = Object.freeze({
  vacation: "vacation",
  timeOff: "time-off",
  vacationChange: "vacation-change",
  timeOffChange: "time-off-change",
});

const requestById = {};
const reviewRequests = {};
const requestTransitions = {};
for (const kind of REQUEST_KINDS) {
  const slug = REQUEST_KIND_SLUGS[kind];
  requestById[kind] = queryOne(`request-by-id.${slug}`, INTEGER_ID);
  reviewRequests[kind] = queryAll(`review-requests.${slug}`);
  requestTransitions[kind] = Object.freeze({
    preliminary: execute(`request-transition.${slug}.preliminary`),
    reject: execute(`request-transition.${slug}.reject`),
    localApproved: execute(`request-transition.${slug}.local-approved`),
    pendingHr: execute(`request-transition.${slug}.pending-hr`),
    hrApproved: execute(`request-transition.${slug}.hr-approved`),
    cancel: execute(`request-transition.${slug}.cancel`),
  });
}

const ABSENCE_MANAGEMENT_STATEMENTS = Object.freeze({
  listBlackouts: queryAll("list-blackouts"),
  listActiveBlackouts: queryAll("list-active-blackouts"),
  duplicateBlackout: queryOne("duplicate-blackout", DATA_QUERY),
  matchingVacationBlackout: queryAll("matching-vacation-blackout", DATA_QUERY),
  matchingTimeOffBlackout: queryAll("matching-time-off-blackout", DATA_QUERY),
  blackoutById: queryOne("blackout-by-id", INTEGER_ID),
  insertBlackout: execute("insert-blackout", { returning: true }),
  updateBlackout: execute("update-blackout"),
  deleteBlackout: execute("delete-blackout"),

  reviewersHr: queryAll("reviewers-hr"),
  reviewersLocal: queryAll("reviewers-local", DATA_QUERY),
  insertNotification: execute("insert-notification"),
  notificationByDedupe: queryOne("notification-by-dedupe", DATA_QUERY),
  reactivateNotification: execute("reactivate-notification"),
  resolveReviewNotifications: execute("resolve-review-notifications"),
  resolveReviewNotificationsForStage: execute("resolve-review-notifications-for-stage"),
  portalNotifications: queryAll("portal-notifications", TEXT_EMPLOYEE),
  portalUnreadCount: queryOne("portal-unread-count", TEXT_EMPLOYEE),
  mobileNotifications: queryAll("mobile-notifications", DATA_QUERY),
  mobileUnreadNotifications: queryAll("mobile-unread-notifications", DATA_QUERY),
  markNotificationRead: execute("mark-notification-read"),
  markAllNotificationsRead: execute("mark-all-notifications-read"),

  insertRequestDecision: execute("insert-request-decision"),
  requestDecisions: queryAll("request-decisions", DATA_QUERY),
  insertAudit: execute("insert-audit"),

  vacationHistory: queryAll("vacation-history", TEXT_EMPLOYEE),
  timeOffHistory: queryAll("time-off-history", TEXT_EMPLOYEE),
  vacationChangeHistory: queryAll("vacation-change-history", TEXT_EMPLOYEE),
  timeOffChangeHistory: queryAll("time-off-change-history", TEXT_EMPLOYEE),
  approvedTimeOff: queryAll("approved-time-off", DATA_QUERY),
  pendingTimeOffChanges: queryAll("pending-time-off-changes", TEXT_EMPLOYEE),
  pendingVacationChanges: queryAll("pending-vacation-changes", TEXT_EMPLOYEE),
  approvedVacationRows: queryAll("approved-vacation-rows", DATA_QUERY),
  pendingAbsenceForLocation: queryAll("pending-absence-for-location", DATA_QUERY),
  pendingTimeOffForRange: queryAll("pending-time-off-for-range", DATA_QUERY),
  vacationRequestSources: queryAll("vacation-request-sources"),

  openVacationForOwner: queryOne("open-vacation-for-owner", DATA_QUERY),
  openTimeOffForOwner: queryOne("open-time-off-for-owner", DATA_QUERY),
  openVacationChangeForOwner: queryOne("open-vacation-change-for-owner", DATA_QUERY),
  openTimeOffChangeForOwner: queryOne("open-time-off-change-for-owner", DATA_QUERY),
  approvedTimeOffForOwner: queryOne("approved-time-off-for-owner", DATA_QUERY),
  vacationOverlap: queryOne("vacation-overlap", DATA_QUERY),
  pendingVacationChange: queryOne("pending-vacation-change", DATA_QUERY),
  pendingTimeOffChange: queryOne("pending-time-off-change", DATA_QUERY),
  timeOffRangeOverlap: queryOne("time-off-range-overlap", DATA_QUERY),
  timeOffPointOverlap: queryOne("time-off-point-overlap", DATA_QUERY),

  insertVacationRequest: execute("insert-vacation-request", { returning: true }),
  insertTimeOffRequest: execute("insert-time-off-request", { returning: true }),
  insertVacationChange: execute("insert-vacation-change", { returning: true }),
  insertTimeOffChange: execute("insert-time-off-change", { returning: true }),
  updateVacationRequest: execute("update-vacation-request"),
  updateTimeOffRequest: execute("update-time-off-request"),
  withdrawVacationRequest: execute("withdraw-vacation-request"),
  withdrawTimeOffRequest: execute("withdraw-time-off-request"),
  withdrawVacationChange: execute("withdraw-vacation-change"),
  withdrawTimeOffChange: execute("withdraw-time-off-change"),

  requestById: Object.freeze(requestById),
  reviewRequests: Object.freeze(reviewRequests),
  requestTransitions: Object.freeze(requestTransitions),

  employeeHomeLocation: queryOne("employee-home-location", TEXT_EMPLOYEE),
  employeeReviewScope: queryOne("employee-review-scope", DATA_QUERY),

  vacationEmployeeContext: queryOne("vacation-employee-context", TEXT_EMPLOYEE),
  vacationEntryEmployee: queryOne("vacation-entry-employee", TEXT_EMPLOYEE),
  vacationEntryOverlap: queryOne("vacation-entry-overlap", DATA_QUERY),
  vacationEntryShiftConflict: queryOne("vacation-entry-shift-conflict", DATA_QUERY),
  vacationOptionsForDate: queryAll("vacation-options-for-date", { date: "date" }),
  vacationCapacityEmployees: queryAll("vacation-capacity-employees", { locationId: "text" }),
  vacationShiftsForDate: queryAll("vacation-shifts-for-date", DATA_QUERY),
  departmentStaffing: queryOne("department-staffing", DATA_QUERY),
  plannedShiftOnDate: queryOne("planned-shift-on-date", DATA_QUERY),
  timeOffOptionsOnDate: queryAll("time-off-options-on-date", DATA_QUERY),
  coveringShift: queryOne("covering-shift", DATA_QUERY),
  overlappingShift: queryOne("overlapping-shift", DATA_QUERY),
  staffingAtLocation: queryOne("staffing-at-location", DATA_QUERY),
  staffingAtDepartment: queryOne("staffing-at-department", DATA_QUERY),
  departmentById: queryOne("department-by-id", INTEGER_ID),
  shiftsForTimeOffRange: queryAll("shifts-for-time-off-range", DATA_QUERY),
  shiftsForTimeOffPeriod: queryAll("shifts-for-time-off-period", DATA_QUERY),
  shiftsWithinOriginalWindow: queryAll("shifts-within-original-window", DATA_QUERY),
  workRuleEvaluationEmployee: queryOne("work-rule-evaluation-employee", TEXT_EMPLOYEE),

  vacationRowsByNumericId: queryAll("vacation-rows-by-numeric-id", INTEGER_ID),
  vacationRowsByGroupId: queryAll("vacation-rows-by-group-id", { groupId: "text" }),
  vacationExistsByNumericId: queryOne("vacation-exists-by-numeric-id", INTEGER_ID),
  vacationExistsByGroupId: queryOne("vacation-exists-by-group-id", { groupId: "text" }),
  vacationEmployeeByGroupId: queryOne("vacation-employee-by-group-id", { groupId: "text" }),
  insertVacationOption: execute("insert-vacation-option", { returning: true }),
  deleteVacationByNumericId: execute("delete-vacation-by-numeric-id"),
  deleteVacationByGroupId: execute("delete-vacation-by-group-id"),
  insertVacationHistory: execute("insert-vacation-history"),

  finalizeVacationRequest: execute("finalize-vacation-request"),
  finalizeTimeOffRequest: execute("finalize-time-off-request"),
  cancelOriginalTimeOff: execute("cancel-original-time-off"),
  replaceOriginalTimeOff: execute("replace-original-time-off"),
  setOriginalTimeOffOption: execute("set-original-time-off-option"),
  finalizeTimeOffChange: execute("finalize-time-off-change"),
  finalizeVacationChange: execute("finalize-vacation-change"),
  updateVacationRequestGroup: execute("update-vacation-request-group"),
  cancelVacationRequestGroup: execute("cancel-vacation-request-group"),
});

module.exports = {
  ABSENCE_MANAGEMENT_STATEMENTS,
  REQUEST_KINDS,
};
