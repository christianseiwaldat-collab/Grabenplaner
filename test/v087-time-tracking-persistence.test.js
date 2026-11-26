"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTimeTrackingRepository,
} = require("../lib/persistence/repositories/time-tracking");
const {
  SQLITE_TIME_TRACKING_CATALOG,
} = require("../lib/persistence/sqlite/time-tracking-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  TIME_TRACKING_STATEMENTS,
} = require("../lib/persistence/statements/time-tracking");


function timeEntry(clientRequestId) {
  return {
    employeeNumber: "E18",
    locationId: "18",
    departmentId: null,
    workDate: "2026-07-29",
    entryType: "clock_in",
    entryTimestamp: "2026-07-29T06:00:00.000Z",
    source: "mobile",
    createdBy: "E18",
    clientRequestId,
    mobileSessionId: "session-1",
  };
}

test("Block 3/7: Zeiterfassungs-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(TIME_TRACKING_STATEMENTS);
  assert.equal(SQLITE_TIME_TRACKING_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_TIME_TRACKING_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_TIME_TRACKING_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});
