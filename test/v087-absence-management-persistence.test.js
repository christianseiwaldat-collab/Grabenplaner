"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAbsenceManagementRepository,
} = require("../lib/persistence/repositories/absence-management");
const {
  SQLITE_ABSENCE_MANAGEMENT_CATALOG,
} = require("../lib/persistence/sqlite/absence-management-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  runSqliteHistoricalCompatibilityMigrations,
} = require("../lib/persistence/sqlite/operations/historical-compatibility-migrations");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  ABSENCE_MANAGEMENT_STATEMENTS,
} = require("../lib/persistence/statements/absence-management");

function flattenedStatements(value, result = []) {
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === "object" && typeof entry.id === "string") {
      result.push(entry);
    } else if (entry && typeof entry === "object") {
      flattenedStatements(entry, result);
    }
  }
  return result;
}

async function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_ABSENCE_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  runSqliteHistoricalCompatibilityMigrations(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active) VALUES ('01', 'Filiale 01', 1);
    INSERT INTO departments (id, location_id, name, min_staff, active)
      VALUES (1, '01', 'Verkauf', 1, 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES
      ('E1', 'Erika Beispiel', 'Erika', '01', 1, 1),
      ('M1', 'Max Leitung', 'Max', '01', 1, 1);
    INSERT INTO portal_users (employee_number, password_hash, role, active)
      VALUES
        ('E1', 'hash', 'employee', 1),
        ('M1', 'hash', 'manager', 1);
  `);
  return {
    ...application,
    repository: createAbsenceManagementRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("Block 3/7: Abwesenheitskatalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = flattenedStatements(ABSENCE_MANAGEMENT_STATEMENTS);
  assert.equal(SQLITE_ABSENCE_MANAGEMENT_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_ABSENCE_MANAGEMENT_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_ABSENCE_MANAGEMENT_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: Antrag, Entscheidung und Benachrichtigung teilen exakt eine Providertransaktion", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      context.repository.transaction(async (absence) => {
        const inserted = await absence.insertVacationRequest({
          employeeNumber: "E1",
          locationId: "01",
          dateFrom: "2026-08-10",
          dateTo: "2026-08-14",
          note: "Sommerurlaub",
        });
        const id = inserted.rows[0].id;
        await absence.insertRequestDecision({
          kind: "vacation",
          id,
          stage: "local",
          action: "submit",
          actor: "E1",
          note: "",
        });
        await absence.insertNotification({
          id: "notification-rollback",
          recipient: "M1",
          eventType: "request.review",
          title: "Urlaubsantrag wartet auf Pruefung",
          message: "E1 hat einen Antrag eingereicht.",
          target: "/?view=requests&kind=vacation",
          entityType: "vacation",
          entityId: String(id),
          dedupeKey: `vacation:${id}:local:review`,
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM vacation_requests").get().count, 0);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM request_decisions").get().count, 0);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM portal_notifications").get().count, 0);

    const id = await context.repository.transaction(async (absence) => {
      const inserted = await absence.insertVacationRequest({
        employeeNumber: "E1",
        locationId: "01",
        dateFrom: "2026-08-10",
        dateTo: "2026-08-14",
        note: "Sommerurlaub",
      });
      const requestId = inserted.rows[0].id;
      await absence.insertRequestDecision({
        kind: "vacation",
        id: requestId,
        stage: "local",
        action: "submit",
        actor: "E1",
        note: "",
      });
      await absence.insertNotification({
        id: "notification-commit",
        recipient: "M1",
        eventType: "request.review",
        title: "Urlaubsantrag wartet auf Pruefung",
        message: "E1 hat einen Antrag eingereicht.",
        target: "/?view=requests&kind=vacation",
        entityType: "vacation",
        entityId: String(requestId),
        dedupeKey: `vacation:${requestId}:local:review`,
      });
      return requestId;
    });

    assert.equal((await context.repository.requestByIdVacation(id)).employee_number, "E1");
    assert.equal((await context.repository.requestDecisions({ kind: "vacation", id })).length, 1);
    assert.equal((await context.repository.portalUnreadCount("M1")).count, 1);
  } finally {
    await context.close();
  }
});

test("Block 3/7: Antragssperren und mobile Benachrichtigungen bleiben providerneutral lesbar", async () => {
  const context = await fixture();
  try {
    const result = await context.repository.insertBlackout({
      locationId: "01",
      departmentId: 1,
      dateFrom: "2026-12-20",
      dateTo: "2026-12-31",
      blockVacation: 1,
      blockTimeOff: 1,
      reason: "Jahresabschluss",
      active: 1,
      createdBy: "M1",
    });
    assert.equal(result.rows[0].id, 1);
    assert.equal((await context.repository.listBlackouts(true))[0].department_name, "Verkauf");

    await context.repository.insertNotification({
      id: "notification-mobile",
      recipient: "E1",
      eventType: "request.decision",
      title: "Antrag bearbeitet",
      message: "",
      target: "/portal.html?tab=requests",
      entityType: "vacation",
      entityId: "1",
      dedupeKey: "vacation:1:approved:M1",
    });
    const page = await context.repository.mobileNotifications({
      employeeNumber: "E1",
      cursor: Number.MAX_SAFE_INTEGER,
      limit: 21,
    });
    assert.equal(page[0].id, "notification-mobile");
    assert.equal(Object.hasOwn(page[0], "target"), false);
    assert.equal((await context.repository.mobileUnreadCount("E1")).count, 1);
    assert.equal((await context.repository.markNotificationRead({
      id: "notification-mobile",
      employeeNumber: "E1",
    })).rowsAffected, 1);
    assert.equal((await context.repository.mobileUnreadCount("E1")).count, 0);
  } finally {
    await context.close();
  }
});

test("Block 3/7: bereits entschiedene Anträge können nicht durch parallele Eigendatenänderungen wieder geöffnet werden", async () => {
  const context = await fixture();
  try {
    const vacationId = (await context.repository.insertVacationRequest({
      employeeNumber: "E1",
      locationId: "01",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-05",
      note: "",
    })).rows[0].id;
    context.database.prepare(`
      UPDATE vacation_requests
      SET status = 'approved', approval_stage = 'complete'
      WHERE id = ?
    `).run(vacationId);
    const vacationUpdate = await context.repository.updateVacationRequest({
      id: vacationId,
      dateFrom: "2026-09-02",
      dateTo: "2026-09-06",
      note: "zu spät",
    });
    assert.equal(vacationUpdate.rowsAffected, 0);
    assert.equal(
      context.database.prepare("SELECT date_from FROM vacation_requests WHERE id = ?").get(vacationId).date_from,
      "2026-09-01",
    );

    const timeOffId = (await context.repository.insertTimeOffRequest({
      employeeNumber: "E1",
      locationId: "01",
      requestDate: "2026-09-10",
      dateFrom: "2026-09-10",
      dateTo: "2026-09-10",
      allDay: 0,
      startTime: "10:00",
      endTime: "11:00",
      note: "",
      trafficLight: "green",
      checkReason: "",
      approvalType: "local",
    })).rows[0].id;
    context.database.prepare(`
      UPDATE time_off_requests
      SET status = 'approved', approval_stage = 'complete'
      WHERE id = ?
    `).run(timeOffId);
    const timeOffUpdate = await context.repository.updateTimeOffRequest({
      id: timeOffId,
      requestDate: "2026-09-10",
      dateFrom: "2026-09-10",
      dateTo: "2026-09-10",
      allDay: 0,
      startTime: "12:00",
      endTime: "13:00",
      note: "zu spät",
      trafficLight: "green",
      checkReason: "",
      approvalType: "local",
    });
    assert.equal(timeOffUpdate.rowsAffected, 0);
    assert.equal(
      context.database.prepare("SELECT start_time FROM time_off_requests WHERE id = ?").get(timeOffId).start_time,
      "10:00",
    );
  } finally {
    await context.close();
  }
});
