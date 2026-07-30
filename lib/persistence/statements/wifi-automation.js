"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function queryOne(id) {
  return definePersistenceStatement({
    id: `wifi-automation.${id}`,
    operation: "queryOne",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  });
}

function queryAll(id) {
  return definePersistenceStatement({
    id: `wifi-automation.${id}`,
    operation: "queryAll",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  });
}

function execute(id) {
  return definePersistenceStatement({
    id: `wifi-automation.${id}`,
    operation: "execute",
    parameters: JSON_PARAMETER,
  });
}

const WIFI_AUTOMATION_STATEMENTS = Object.freeze({
  listConfirmationLevels: queryAll("list-confirmation-levels"),
  employeeExists: queryOne("employee-exists"),
  listLocationMappings: queryAll("list-location-mappings"),
  listLocations: queryAll("list-locations"),
  getPreference: queryOne("get-preference"),
  getEmployeeConfirmationLevel: queryOne("get-employee-confirmation-level"),
  listExpiredGraceSessions: queryAll("list-expired-grace-sessions"),
  getGraceSession: queryOne("get-grace-session"),
  findActivePreference: queryOne("find-active-preference"),
  findLocationMapping: queryOne("find-location-mapping"),
  findOpenPresenceSession: queryOne("find-open-presence-session"),
  getEmployeeAutomationContext: queryOne("get-employee-automation-context"),
  hasLocationMapping: queryOne("has-location-mapping"),
  listEmployeeSuggestions: queryAll("list-employee-suggestions"),
  getSuggestionForEmployee: queryOne("get-suggestion-for-employee"),
  listPendingSuggestionIds: queryAll("list-pending-suggestion-ids"),
  listScheduledDepartments: queryAll("list-scheduled-departments"),
  getEmployeeRequestContext: queryOne("get-employee-request-context"),
  listTimeEntriesForDay: queryAll("list-time-entries-for-day"),

  removeLocationMapping: execute("remove-location-mapping"),
  upsertLocationMapping: execute("upsert-location-mapping"),
  upsertPreference: execute("upsert-preference"),
  cancelPresenceSessions: execute("cancel-presence-sessions"),
  insertSuggestion: execute("insert-suggestion"),
  markPresenceInvalid: execute("mark-presence-invalid"),
  closePresenceSession: execute("close-presence-session"),
  insertInboxEvent: execute("insert-inbox-event"),
  markInboxStatus: execute("mark-inbox-status"),
  reconnectPresenceSession: execute("reconnect-presence-session"),
  touchPresenceSession: execute("touch-presence-session"),
  insertPresenceSession: execute("insert-presence-session"),
  startPresenceGrace: execute("start-presence-grace"),
  completeInboxEvent: execute("complete-inbox-event"),
  insertTimeEntry: execute("insert-time-entry"),
  confirmSuggestion: execute("confirm-suggestion"),
  invalidateTimeDayReview: execute("invalidate-time-day-review"),
  rejectSuggestion: execute("reject-suggestion"),
  upsertPortalSetting: execute("upsert-portal-setting"),
  updateEmployeeConfirmationLevel: execute("update-employee-confirmation-level"),
});

module.exports = {
  WIFI_AUTOMATION_STATEMENTS,
};
