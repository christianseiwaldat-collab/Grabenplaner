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
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  TIME_TRACKING_STATEMENTS,
} = require("../lib/persistence/statements/time-tracking");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_TIME_TRACKING_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active, time_tracking_enabled)
      VALUES ('18', 'Filiale 18', 1, 1);
    INSERT INTO departments (id, location_id, name, min_staff, active)
      VALUES (18, '18', 'Verkauf', 1, 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES ('E18', 'Erika Beispiel', 'Erika', '18', 18, 1);
    INSERT INTO shifts (
      employee_number, location_id, department_id, shift_date,
      start_time, end_time, area, note
    ) VALUES ('E18', '18', 18, '2026-07-29', '08:00', '17:00', 'Verkauf', '');
  `);
  return {
    ...application,
    repository: createTimeTrackingRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

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

test("Block 3/7: Zeitbuchung und Tagesprüfung teilen eine gebundene Transaktion", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      context.repository.transaction(async (repository) => {
        await repository.insertTimeEntry(timeEntry("request-rollback"));
        await repository.invalidateDayReview({
          employeeNumber: "E18",
          workDate: "2026-07-29",
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(await context.repository.getClientRequestEntry({
      employeeNumber: "E18",
      clientRequestId: "request-rollback",
    }), null);

    const inserted = await context.repository.transaction(async (repository) => {
      const result = await repository.insertTimeEntry(timeEntry("request-commit"));
      await repository.invalidateDayReview({
        employeeNumber: "E18",
        workDate: "2026-07-29",
      });
      return result.inserted;
    });
    assert.equal(Number(inserted.id) > 0, true);
    assert.equal((await context.repository.getClientRequestEntry({
      employeeNumber: "E18",
      clientRequestId: "request-commit",
    })).entry_type, "clock_in");
  } finally {
    await context.close();
  }
});

test("Block 3/7: Korrektur, Ersatzbuchung und Review-Invalidierung sind atomar", async () => {
  const context = fixture();
  const review = {
    employeeNumber: "E18",
    locationId: "18",
    departmentId: 18,
    departmentKey: 18,
    workDate: "2026-07-29",
    note: "Geprüft",
    reviewedBy: "M18",
    evaluationVersion: "v1",
    snapshotJson: JSON.stringify({ evaluationHash: "before" }),
  };
  const correctionInput = {
    employeeNumber: "E18",
    locationId: "18",
    departmentId: 18,
    correctionDate: "2026-07-29",
    requestedChange: JSON.stringify({ action: "replace" }),
    requestNote: "Bitte korrigieren",
    status: "approved",
    requestedBy: "E18",
    decidedBy: "M18",
    decideNow: 1,
    decisionNote: "Geprüft",
  };
  const correctionEntry = (correctionId) => ({
    employeeNumber: "E18",
    locationId: "18",
    departmentId: 18,
    workDate: "2026-07-29",
    entryType: "clock_in",
    entryTimestamp: "2026-07-29T06:00:00.000Z",
    note: "Korrektur",
    createdBy: "M18",
    correctionId,
  });
  const listCorrections = () => context.repository.listCorrections({
    employeeNumber: "E18",
    id: 0,
    dateFrom: "",
    dateTo: "",
    excludeWithdrawn: 0,
    locationId: "",
    filterDepartment: 0,
    departmentId: null,
    status: "",
  });
  try {
    await context.repository.upsertDayReview(review);
    await assert.rejects(
      context.repository.transaction(async (repository) => {
        const inserted = await repository.insertCorrection(correctionInput);
        const correctionId = inserted.returnedRows[0].data.id;
        await repository.insertCorrectionTimeEntry(correctionEntry(correctionId));
        await repository.invalidateDayReview({
          employeeNumber: "E18",
          workDate: "2026-07-29",
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal((await listCorrections()).length, 0);
    assert.equal((await context.repository.listTimeEntriesForDay({
      employeeNumber: "E18",
      date: "2026-07-29",
    })).length, 0);
    assert.ok(await context.repository.getDayReview({
      employeeNumber: "E18",
      workDate: "2026-07-29",
      departmentKey: 18,
    }));

    const correctionId = await context.repository.transaction(async (repository) => {
      const inserted = await repository.insertCorrection(correctionInput);
      const id = inserted.returnedRows[0].data.id;
      await repository.insertCorrectionTimeEntry(correctionEntry(id));
      await repository.invalidateDayReview({
        employeeNumber: "E18",
        workDate: "2026-07-29",
      });
      return id;
    });
    assert.equal((await context.repository.getCorrection({ id: correctionId })).status, "approved");
    assert.equal((await context.repository.listTimeEntriesForDay({
      employeeNumber: "E18",
      date: "2026-07-29",
    }))[0].correction_id, correctionId);
    assert.equal(await context.repository.getDayReview({
      employeeNumber: "E18",
      workDate: "2026-07-29",
      departmentKey: 18,
    }), null);
    assert.equal((await context.repository.listContextEmployees({
      employeeNumber: "",
      locationId: "18",
      date: "2026-07-29",
      filterDepartment: 1,
      departmentId: 18,
    }))[0].personnel_number, "E18");
    assert.equal((await context.repository.listPlannedDayShifts({
      employeeNumber: "E18",
      date: "2026-07-29",
      filterDepartment: 1,
      departmentId: 18,
      filterLocation: 1,
      locationId: "18",
    }))[0].start_time, "08:00");
  } finally {
    await context.close();
  }
});
