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
const {
  createSqlitePersistenceProvider,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

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

function fixture() {
  const database = openSqliteLegacyDatabase(":memory:");
  ensureSqliteApplicationSchema(database);
  seed(database);
  const provider = createSqlitePersistenceProvider({
    database,
    catalog: SQLITE_APPLICATION_CATALOG,
  });
  const repository = createApplicationRepositories(provider).staffAssignmentRequests;
  let id = 0;
  let tick = 0;
  const service = createStaffAssignmentRequestLifecycleService(repository, {
    idFactory: () => `staff-request-id-${++id}`,
    now: () => `2026-08-19T10:${String(tick++).padStart(2, "0")}:00.000Z`,
  });
  return { database, provider, repository, service };
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

test("Block 3: versionierte Einsatzanfrage durchläuft Annahme und Stornierung revisionssicher", async () => {
  const { database, provider, service } = fixture();
  try {
    const draft = await service.createDraft(requestInput({ requestReason: "" }), REQUESTER);
    const revised = await service.reviseDraft(draft.request.id, {
      requestReason: "Unterstützung in der Fotowelt-Abteilung",
      periodStartDate: "2026-08-27",
      periodEndDate: "2026-08-28",
      timeKind: "multi_day",
    }, REQUESTER, { expectedRevision: 1 });
    const submitted = await service.submit(draft.request.id, REQUESTER, { expectedRevision: 2 });
    const accepted = await service.accept(draft.request.id, {
      confirmedEmployeeNumber: CONFIRMED,
      decisionReason: "Einsatz organisatorisch bestätigt",
    }, REQUESTER, { expectedRevision: 3 });
    const cancelled = await service.cancel(draft.request.id, {
      decisionReason: "Bedarf ist entfallen",
    }, REQUESTER, { expectedRevision: 4 });

    assert.equal(revised.current.status, "draft");
    assert.equal(submitted.current.status, "submitted");
    assert.equal(accepted.current.status, "accepted");
    assert.equal(cancelled.current.status, "cancelled");
    assert.equal(cancelled.current.confirmedEmployeeNumber, CONFIRMED);
    assert.deepEqual(cancelled.revisions.map(({ revisionNumber }) => revisionNumber), [1, 2, 3, 4, 5]);
    assert.deepEqual(cancelled.events.map(({ eventType }) => eventType), [
      "created", "revised", "submitted", "accepted", "cancelled",
    ]);
    for (let index = 0; index < cancelled.events.length; index += 1) {
      assert.equal(
        cancelled.events[index].previousReceiptSha256,
        index === 0 ? "" : cancelled.events[index - 1].receiptSha256,
      );
      assert.equal(
        cancelled.revisions[index].previousReceiptSha256,
        index === 0 ? "" : cancelled.revisions[index - 1].receiptSha256,
      );
    }
    assert.deepEqual(inspectSqliteStaffAssignmentRequestRows(database), {
      valid: true,
      absent: false,
      issues: [],
    });
  } finally {
    await provider.close();
    database.close();
  }
});

test("Block 4: Dialogeinreichung erzeugt Entwurf und Einreichung atomar in einer Belegkette", async () => {
  const { database, provider, service } = fixture();
  try {
    const submitted = await service.createSubmitted(requestInput(), REQUESTER);
    assert.equal(submitted.current.status, "submitted");
    assert.equal(submitted.current.revisionNumber, 2);
    assert.deepEqual(submitted.revisions.map(({ status }) => status), ["draft", "submitted"]);
    assert.deepEqual(submitted.events.map(({ eventType }) => eventType), ["created", "submitted"]);
    assert.equal(
      submitted.revisions[1].previousReceiptSha256,
      submitted.revisions[0].receiptSha256,
    );
    assert.equal(
      submitted.events[1].previousReceiptSha256,
      submitted.events[0].receiptSha256,
    );
    assert.equal(inspectSqliteStaffAssignmentRequestRows(database).valid, true);
  } finally {
    await provider.close();
    database.close();
  }
});

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

test("Block 3: Zeitraumarten, Statusübergänge und konkurrierende Revisionen scheitern geschlossen", async () => {
  assert.throws(
    () => normalizeStaffAssignmentRequestInput(requestInput({
      timeKind: "hourly",
      startTime: "14:00",
      endTime: "13:00",
    })),
    (error) => error.code === "STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID",
  );
  assert.throws(
    () => normalizeStaffAssignmentRequestInput(requestInput({
      timeKind: "hourly",
      startTime: "13:05",
      endTime: "14:00",
    })),
    (error) => error.code === "STAFF_ASSIGNMENT_REQUEST_PERIOD_INVALID",
  );
  assert.throws(
    () => normalizeStaffAssignmentRequestInput(requestInput({
      destinationLocationId: SOURCE,
    })),
    (error) => error.code === "STAFF_ASSIGNMENT_REQUEST_SCOPE_INVALID",
  );

  const { database, provider, service } = fixture();
  try {
    const draft = await service.createDraft(requestInput(), REQUESTER);
    await service.submit(draft.request.id, REQUESTER, { expectedRevision: 1 });
    await assert.rejects(
      service.submit(draft.request.id, REQUESTER, { expectedRevision: 1 }),
      (error) => error.code === "STAFF_ASSIGNMENT_REQUEST_REVISION_CONFLICT",
    );
    await assert.rejects(
      service.reviseDraft(draft.request.id, { requestReason: "Manipulation" }, REQUESTER, {
        expectedRevision: 2,
      }),
      (error) => error.code === "STAFF_ASSIGNMENT_REQUEST_TRANSITION_INVALID",
    );
    await assert.rejects(
      service.accept(draft.request.id, {}, REQUESTER, { expectedRevision: 2 }),
      (error) => error.code === "STAFF_ASSIGNMENT_REQUEST_CONFIRMED_EMPLOYEE_INVALID",
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM staff_assignment_request_revisions
    `).get().count, 2);
    assert.equal(inspectSqliteStaffAssignmentRequestRows(database).valid, true);
  } finally {
    await provider.close();
    database.close();
  }
});

test("Block 3: SQLite-Wächter schützen Topologie, Ketten und Unveränderlichkeit", async () => {
  const { database, provider, service } = fixture();
  try {
    const schema = inspectSqliteStaffAssignmentRequestSchema(database);
    assert.equal(schema.valid, true);
    assert.deepEqual(
      STAFF_ASSIGNMENT_REQUEST_TABLE_NAMES.every((name) => !schema.missingTables.includes(name)),
      true,
    );
    assert.deepEqual(
      STAFF_ASSIGNMENT_REQUEST_TRIGGER_NAMES.every((name) => !schema.missingTriggers.includes(name)),
      true,
    );
    assert.deepEqual(
      STAFF_ASSIGNMENT_REQUEST_INDEX_NAMES.every((name) => !schema.missingIndexes.includes(name)),
      true,
    );

    const draft = await service.createDraft(requestInput(), REQUESTER);
    assert.throws(
      () => database.prepare(`
        UPDATE staff_assignment_request_revisions
        SET request_reason = 'Manipuliert'
        WHERE request_id = ? AND revision_number = 1
      `).run(draft.request.id),
      /immutable/,
    );
    assert.throws(
      () => database.prepare(`
        DELETE FROM staff_assignment_request_events WHERE request_id = ?
      `).run(draft.request.id),
      /immutable/,
    );
    assert.throws(
      () => database.prepare(`
        UPDATE departments SET location_id = ? WHERE id = ?
      `).run(FOREIGN, DESTINATION_DEPARTMENT),
      /referenced/,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO staff_assignment_request_revisions (
          request_id, revision_number, status, source_location_id,
          destination_location_id, destination_department_id,
          period_start_date, period_end_date, time_kind, start_time, end_time,
          preferred_employee_number, confirmed_employee_number,
          request_reason, decision_reason, previous_receipt_sha256, receipt_sha256,
          changed_by_employee_number, changed_at
        ) VALUES (?, 3, 'draft', ?, ?, ?, '2026-08-27', '2026-08-27',
          'full_day', NULL, NULL, NULL, NULL, 'Test', '', '', ?, ?, ?)
      `).run(
        draft.request.id,
        SOURCE,
        DESTINATION,
        FOREIGN_DEPARTMENT,
        "a".repeat(64),
        REQUESTER,
        "2026-08-19T11:00:00.000Z",
      ),
      /chain|department/,
    );
  } finally {
    await provider.close();
    database.close();
  }
});

test("Block 3: Fachrevision und Auditereignis werden atomar geschrieben", async () => {
  const { database, provider, service } = fixture();
  try {
    database.exec(`
      CREATE TRIGGER test_staff_assignment_request_event_abort
      BEFORE INSERT ON staff_assignment_request_events
      BEGIN
        SELECT RAISE(ABORT, 'test event audit failure');
      END
    `);
    await assert.rejects(
      service.createDraft(requestInput(), REQUESTER),
      (error) => error.name === "PersistenceError",
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_assignment_requests").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_assignment_request_revisions").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_assignment_request_events").get().count, 0);
  } finally {
    await provider.close();
    database.close();
  }
});
