"use strict";

const { definePersistenceStatement } = require("../contract");

const JSON_PARAMETER = Object.freeze({ payload: "json" });
const JSON_ROW = Object.freeze({ data: "json" });

function queryOne(id, { parameters = JSON_PARAMETER } = {}) {
  return definePersistenceStatement({
    id: `planning-settings.${id}`,
    operation: "queryOne",
    parameters,
    columns: JSON_ROW,
  });
}

function queryAll(id, { parameters = JSON_PARAMETER } = {}) {
  return definePersistenceStatement({
    id: `planning-settings.${id}`,
    operation: "queryAll",
    parameters,
    columns: JSON_ROW,
  });
}

function execute(id, { parameters = JSON_PARAMETER, returning = false } = {}) {
  return definePersistenceStatement({
    id: `planning-settings.${id}`,
    operation: "execute",
    parameters,
    columns: returning ? JSON_ROW : {},
  });
}

const PLANNING_SETTINGS_STATEMENTS = Object.freeze({
  listSettings: queryAll("settings.list", { parameters: {} }),
  upsertSetting: execute("settings.upsert"),
  listPortalSettings: queryAll("portal-settings.list", { parameters: {} }),
  upsertPortalSetting: execute("portal-settings.upsert"),
  listPdfSettings: queryAll("pdf-settings.list", { parameters: {} }),
  upsertPdfSetting: execute("pdf-settings.upsert"),
  listLocationBranding: queryAll("location-branding.list", { parameters: {} }),
  upsertLocationBranding: execute("location-branding.upsert"),
  deleteLocationBranding: execute("location-branding.delete"),
  listGlobalDayBlocks: queryAll("global-day-blocks.list", { parameters: {} }),

  listMobileScheduleShifts: queryAll("mobile-schedule.shifts"),
  listMobileScheduleOptions: queryAll("mobile-schedule.options"),
  listLocationDashboardScheduleShifts: queryAll("location-dashboard.schedule-shifts"),

  listWeekOptionsForEmployeeDate: queryAll("validation.week-options-for-date"),
  getPlanningEmployee: queryOne("validation.employee"),
  getOtherLocationShift: queryOne("validation.other-location-shift"),
  getOverlappingShift: queryOne("validation.overlapping-shift"),
  listOverlappingWeekOptions: queryAll("validation.overlapping-week-options"),
  listShiftConflictsForRange: queryAll("validation.shift-conflicts"),
  listSaturdayServiceShifts: queryAll("schedule.saturday-service-shifts"),
  listWorkRuleShiftsForRange: queryAll("work-rules.shifts-for-range"),
  getActivePlanningEmployee: queryOne("work-rules.active-employee"),

  listScheduleEmployees: queryAll("schedule.employees"),
  listScheduleShifts: queryAll("schedule.shifts"),
  listScheduleWeekOptions: queryAll("schedule.week-options"),
  listVacationEmployees: queryAll("vacation.employees"),
  listVacationEntitlements: queryAll("vacation.entitlements"),
  listVacationOptions: queryAll("vacation.options"),
  listCentralVacationEmployees: queryAll("vacation.central-employees"),
  listCentralVacationOptions: queryAll("vacation.central-options"),
  countShiftsForDateLocation: queryOne("global-day-blocks.shift-count"),

  listDashboardLocations: queryAll("dashboard.locations", { parameters: {} }),
  listDashboardDepartments: queryAll("dashboard.departments", { parameters: {} }),
  listDashboardTeamCounts: queryAll("dashboard.team-counts", { parameters: {} }),
  listDashboardScheduledCounts: queryAll("dashboard.scheduled-counts"),
  listDashboardOptions: queryAll("dashboard.options"),
  getProcessDashboardCounts: queryOne("dashboard.process-counts", { parameters: {} }),

  getShiftById: queryOne("shift.get"),
  insertWeekOption: execute("week-option.insert", { returning: true }),
  getWeekOptionById: queryOne("week-option.get"),
  updateWeekOption: execute("week-option.update"),
  deleteWeekOption: execute("week-option.delete"),
  insertGlobalDayBlock: execute("global-day-block.insert", { returning: true }),
  getGlobalDayBlockById: queryOne("global-day-block.get"),
  updateGlobalDayBlock: execute("global-day-block.update"),
  deleteGlobalDayBlock: execute("global-day-block.delete"),

  listAutoPlanningEmployees: queryAll("auto-planning.employees"),
  listAutoPlanningShifts: queryAll("auto-planning.shifts"),
  listAutoPlanningOptions: queryAll("auto-planning.options"),
});

module.exports = {
  PLANNING_SETTINGS_STATEMENTS,
};
