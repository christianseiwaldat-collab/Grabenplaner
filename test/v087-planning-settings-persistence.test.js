"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPlanningSettingsRepository,
} = require("../lib/persistence/repositories/planning-settings");
const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  SQLITE_PLANNING_SETTINGS_CATALOG,
} = require("../lib/persistence/sqlite/planning-settings-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PLANNING_SETTINGS_STATEMENTS,
} = require("../lib/persistence/statements/planning-settings");


function weekOption(overrides = {}) {
  return {
    employeeNumber: "E18",
    groupId: "group-1",
    weekStart: "2026-08-03",
    dateFrom: "2026-08-04",
    dateTo: "2026-08-04",
    optionType: "vacation",
    note: "Urlaub",
    creditedMinutesPerDay: 360,
    allDay: 1,
    startTime: null,
    endTime: null,
    ...overrides,
  };
}

function dayBlock(overrides = {}) {
  return {
    locationId: "18",
    weekStart: "2026-08-03",
    blockDate: "2026-08-05",
    reason: "Geschlossen",
    isPublicHoliday: 0,
    ...overrides,
  };
}

test("Block 3/7: Planning-Settings-Katalog deckt jedes Statement genau einmal ab", () => {
  const statements = Object.values(PLANNING_SETTINGS_STATEMENTS);
  assert.equal(SQLITE_PLANNING_SETTINGS_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_PLANNING_SETTINGS_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_PLANNING_SETTINGS_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});
