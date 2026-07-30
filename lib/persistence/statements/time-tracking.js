"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function queryOne(id) {
  return definePersistenceStatement({
    id: `time-tracking.${id}`,
    operation: "queryOne",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  });
}

function queryAll(id) {
  return definePersistenceStatement({
    id: `time-tracking.${id}`,
    operation: "queryAll",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  });
}

function execute(id, returning = false) {
  return definePersistenceStatement({
    id: `time-tracking.${id}`,
    operation: "execute",
    parameters: JSON_PARAMETER,
    ...(returning ? { columns: JSON_ROW } : {}),
  });
}

const TIME_TRACKING_STATEMENTS = Object.freeze({
  getClientRequestEntry: definePersistenceStatement({
    id: "time-tracking.get-client-request-entry",
    operation: "queryOne",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  }),
  insertTimeEntry: definePersistenceStatement({
    id: "time-tracking.insert-time-entry",
    operation: "execute",
    parameters: JSON_PARAMETER,
    columns: JSON_ROW,
  }),
  invalidateDayReview: definePersistenceStatement({
    id: "time-tracking.invalidate-day-review",
    operation: "execute",
    parameters: JSON_PARAMETER,
  }),

  getEmployeeContext: queryOne("get-employee-context"),
  getShiftDepartmentForDate: queryOne("get-shift-department-for-date"),
  getLatestEntryContext: queryOne("get-latest-entry-context"),
  getPlannedShiftContext: queryOne("get-planned-shift-context"),
  getLatestShiftEnd: queryOne("get-latest-shift-end"),
  listPlannedDayShifts: queryAll("list-planned-day-shifts"),
  listExcusedOptions: queryAll("list-excused-options"),

  getDayReview: queryOne("get-day-review"),
  invalidateDayReviewsForRange: execute("invalidate-day-reviews-for-range"),
  deleteScopedDayReview: execute("delete-scoped-day-review"),
  upsertDayReview: execute("upsert-day-review"),

  hasPendingCorrection: queryOne("has-pending-correction"),
  listTimeEntriesForDay: queryAll("list-time-entries-for-day"),
  listPastTimeEntryDates: queryAll("list-past-time-entry-dates"),
  listScheduledShiftDepartments: queryAll("list-scheduled-shift-departments"),
  listContextEmployees: queryAll("list-context-employees"),
  listSummaryEmployees: queryAll("list-summary-employees"),

  listCorrections: queryAll("list-corrections"),
  getCorrection: queryOne("get-correction"),
  findPendingCorrection: queryOne("find-pending-correction"),
  listActiveTimeEntriesForRange: queryAll("list-active-time-entries-for-range"),
  listDistinctShiftDepartments: queryAll("list-distinct-shift-departments"),
  insertCorrection: execute("insert-correction", true),
  updateCorrectionRequestedChange: execute("update-correction-requested-change"),
  updateOwnCorrection: execute("update-own-correction"),
  withdrawOwnCorrection: execute("withdraw-own-correction"),
  updateCorrectionScope: execute("update-correction-scope"),
  voidActiveTimeEntries: execute("void-active-time-entries"),
  insertCorrectionTimeEntry: execute("insert-correction-time-entry", true),
  decideCorrection: execute("decide-correction"),
  markCorrectionNotificationsRead: execute("mark-correction-notifications-read"),

  listGreetingShiftDates: queryAll("list-greeting-shift-dates"),
  getEmployeeHomeLocation: queryOne("get-employee-home-location"),
});

module.exports = {
  TIME_TRACKING_STATEMENTS,
};
