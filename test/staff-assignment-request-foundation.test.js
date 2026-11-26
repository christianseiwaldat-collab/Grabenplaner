"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createStaffAssignmentRequestLifecycleService,
  normalizeStaffAssignmentRequestInput,
} = require("../lib/staff-assignment-requests");
const {
  boundAssignmentFromRequest,
  staffAssignmentRequestAssignmentId,
  staffAssignmentRequestIdFromAssignmentId,
} = require("../lib/staff-assignment-request-fulfillment");
const {
  createApplicationRepositories,
} = require("../lib/persistence/application-repositories");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../lib/persistence/sqlite/application-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  STAFF_ASSIGNMENT_REQUEST_INDEX_NAMES,
  STAFF_ASSIGNMENT_REQUEST_TABLE_NAMES,
  STAFF_ASSIGNMENT_REQUEST_TRIGGER_NAMES,
  inspectSqliteStaffAssignmentRequestRows,
  inspectSqliteStaffAssignmentRequestSchema,
} = require("../lib/persistence/sqlite/operations/staff-assignment-request-schema");

const SOURCE = "staff-request-source";
const DESTINATION = "staff-request-destination";
const FOREIGN = "staff-request-foreign";
const DESTINATION_DEPARTMENT = 92901;
const FOREIGN_DEPARTMENT = 92902;
const REQUESTER = "STAFF-REQUESTER";
const PREFERRED = "STAFF-PREFERRED";
const CONFIRMED = "STAFF-CONFIRMED";

function seed(database) {
  for (const [id, name] of [
    [SOURCE, "Quellfiliale"],
    [DESTINATION, "Zielfiliale"],
    [FOREIGN, "Fremdfiliale"],
  ]) {
    database.prepare("INSERT INTO locations (id, name, active) VALUES (?, ?, 1)")
      .run(id, name);
  }
  database.prepare(`
    INSERT INTO departments (id, location_id, name, active)
    VALUES (?, ?, 'Zielabteilung', 1), (?, ?, 'Fremdabteilung', 1)
  `).run(DESTINATION_DEPARTMENT, DESTINATION, FOREIGN_DEPARTMENT, FOREIGN);
  for (const [personnelNumber, name, locationId] of [
    [REQUESTER, "Anfragende Leitung", DESTINATION],
    [PREFERRED, "Bevorzugtes Teammitglied", SOURCE],
    [CONFIRMED, "Bestätigtes Teammitglied", SOURCE],
  ]) {
    database.prepare(`
      INSERT INTO employees (
        personnel_number, full_name, nickname, home_location_id, active
      ) VALUES (?, ?, ?, ?, 1)
    `).run(personnelNumber, name, name, locationId);
  }
}


function requestInput(overrides = {}) {
  return {
    sourceLocationId: SOURCE,
    destinationLocationId: DESTINATION,
    destinationDepartmentId: DESTINATION_DEPARTMENT,
    periodStartDate: "2026-08-27",
    periodEndDate: "2026-08-27",
    timeKind: "full_day",
    startTime: null,
    endTime: null,
    preferredEmployeeNumber: PREFERRED,
    confirmedEmployeeNumber: null,
    requestReason: "Unterstützung in der Fotowelt-Abteilung",
    decisionReason: "",
    ...overrides,
  };
}

test("Block 6: Stunden-, Tages- und Mehrtagesanfragen werden exakt an Filialeinsätze gebunden", () => {
  const timestamp = "2026-08-19T12:00:00.000Z";
  const assignmentFor = (requestId, overrides) => boundAssignmentFromRequest({
    requestId,
    current: normalizeStaffAssignmentRequestInput(requestInput(overrides)),
    confirmedEmployeeNumber: CONFIRMED,
    actorEmployeeNumber: REQUESTER,
    timestamp,
  });
  const hourly = assignmentFor("hourly", {
    timeKind: "hourly",
    startTime: "13:15",
    endTime: "17:30",
  });
  const fullDay = assignmentFor("full-day", {});
  const multiDay = assignmentFor("multi-day", {
    periodEndDate: "2026-08-29",
    timeKind: "multi_day",
  });

  assert.deepEqual(hourly, {
    id: staffAssignmentRequestAssignmentId("hourly"),
    employeeNumber: CONFIRMED,
    homeLocationId: SOURCE,
    destinationLocationId: DESTINATION,
    destinationDepartmentId: DESTINATION_DEPARTMENT,
    dateFrom: "2026-08-27",
    dateTo: "2026-08-27",
    allDay: false,
    startTime: "13:15",
    endTime: "17:30",
    note: "",
    actor: REQUESTER,
    timestamp,
  });
  assert.equal(fullDay.allDay, true);
  assert.equal(fullDay.startTime, null);
  assert.equal(fullDay.endTime, null);
  assert.equal(multiDay.allDay, true);
  assert.equal(multiDay.dateFrom, "2026-08-27");
  assert.equal(multiDay.dateTo, "2026-08-29");
  assert.equal(
    staffAssignmentRequestIdFromAssignmentId(multiDay.id),
    "multi-day",
  );
});
