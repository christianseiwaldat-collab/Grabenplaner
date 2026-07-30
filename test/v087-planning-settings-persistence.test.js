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
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  PLANNING_SETTINGS_STATEMENTS,
} = require("../lib/persistence/statements/planning-settings");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_PLANNING_SETTINGS_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, min_staff, active)
      VALUES ('18', 'Filiale 18', 2, 1);
    INSERT INTO departments (id, location_id, name, min_staff, active, sort_order)
      VALUES (1801, '18', 'Verkauf', 1, 1, 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, home_location_id, preferred_department_id, active
    ) VALUES
      ('E18', 'Erika Beispiel', 'Erika', '#26785f', 30, 4, '18', 1801, 1),
      ('M18', 'Max Muster', 'Max', '#0b84c6', 38.5, 5, '18', 1801, 1);
    INSERT INTO vacation_entitlements (employee_number, year, days)
      VALUES ('E18', 2026, 25);
    INSERT INTO shifts (
      employee_number, location_id, department_id, shift_date,
      start_time, end_time, area, note
    ) VALUES
      ('E18', '18', 1801, '2026-08-03', '08:00', '16:30', 'Verkauf', '');
  `);
  return {
    database: application.database,
    repository: createPlanningSettingsRepository(application.provider),
    transaction(work) {
      return application.provider.transaction(
        (executor) => work(createPlanningSettingsRepository(executor)),
      );
    },
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

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

test("Block 5/7: Setting-Schlüssel und -Wert werden providerneutral validiert", async () => {
  const context = fixture();
  const rejectsInvalidSetting = (error) => (
    error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID
    && error?.operation === "upsertSetting"
  );
  try {
    await assert.rejects(
      context.repository.upsertSetting({ key: null, value: "x" }),
      rejectsInvalidSetting,
    );
    await assert.rejects(
      context.repository.upsertSetting({ key: "x", value: null }),
      rejectsInvalidSetting,
    );
    await assert.rejects(
      context.repository.upsertSetting({ key: "x\0", value: "y" }),
      rejectsInvalidSetting,
    );
    await assert.rejects(
      context.repository.upsertSetting({ key: "x", value: "y\0" }),
      rejectsInvalidSetting,
    );
    assert.deepEqual(await context.repository.listSettings(), []);
  } finally {
    await context.close();
  }
});

test("Block 3/7: Einstellungen, Branding und Planung bleiben providerneutral les- und schreibbar", async () => {
  const context = fixture();
  try {
    await context.repository.upsertSetting({ key: "toast_duration", value: "medium" });
    await context.repository.upsertPortalSetting({
      key: "vacation_hr_approval_required",
      value: "1",
    });
    await context.repository.upsertPdfSetting({
      scopeType: "schedule",
      locationId: "18",
      departmentKey: "1801",
      key: "pdf_title",
      value: "Dienstplan Filiale 18",
    });
    await context.repository.upsertLocationBranding({
      locationId: "18",
      kitId: "neutral",
      companyName: "Grabenplaner",
      logoUrl: "/assets/grabenplaner-logo.svg",
      iconUrl: "/assets/webicon.svg",
      logoAlt: "Grabenplaner",
      adminEmail: "dev@example.test",
      updatedBy: "M18",
    });

    const optionResult = await context.repository.insertWeekOption(weekOption());
    const optionId = Number(optionResult.rows[0]?.id);
    const blockResult = await context.repository.insertGlobalDayBlock(dayBlock());
    const blockId = Number(blockResult.rows[0]?.id);

    assert.ok(Number.isInteger(optionId) && optionId > 0);
    assert.ok(Number.isInteger(blockId) && blockId > 0);
    assert.deepEqual(await context.repository.listSettings(), [{
      key: "toast_duration",
      value: "medium",
    }]);
    assert.deepEqual(await context.repository.listPortalSettings(), [{
      key: "vacation_hr_approval_required",
      value: "1",
    }]);
    assert.equal((await context.repository.listPdfSettings())[0].value, "Dienstplan Filiale 18");
    assert.equal((await context.repository.listLocationBranding())[0].kit_id, "neutral");
    assert.equal((await context.repository.getWeekOptionById({ id: optionId })).option_type, "vacation");
    assert.equal((await context.repository.getGlobalDayBlockById({ id: blockId })).reason, "Geschlossen");
    assert.equal((await context.repository.countShiftsForDateLocation({
      date: "2026-08-03",
      locationId: "18",
    })).count, 1);
    assert.equal((await context.repository.listScheduleEmployees({
      weekStart: "2026-08-03",
      weekEnd: "2026-08-09",
      locationId: "18",
      departmentId: 1801,
    })).length, 2);
    assert.equal((await context.repository.listDashboardOptions({ date: "2026-08-04" })).length, 1);
    assert.equal((await context.repository.listLocationDashboardScheduleShifts({
      locationId: "18",
      weekStart: "2026-08-03",
      weekEnd: "2026-08-09",
    }))[0].nickname, "Erika");
    assert.equal((await context.repository.listAutoPlanningEmployees({
      weekStart: "2026-08-03",
      weekEnd: "2026-08-09",
      locationId: "18",
      departmentId: 1801,
    })).length, 2);
  } finally {
    await context.close();
  }
});

test("Block 3/7: Gebundene Planning-Transaktion rollt gemischte Schreibvorgänge zurück", async () => {
  const context = fixture();
  let optionId = 0;
  let blockId = 0;
  try {
    await assert.rejects(
      context.transaction(async (repository) => {
        await repository.upsertSetting({ key: "rollback_setting", value: "1" });
        await repository.upsertLocationBranding({
          locationId: "18",
          kitId: "rollback",
          companyName: "Rollback",
          logoUrl: "/assets/rollback.svg",
          iconUrl: "/assets/rollback-icon.svg",
          logoAlt: "Rollback",
          adminEmail: "",
          updatedBy: "M18",
        });
        optionId = Number((await repository.insertWeekOption(
          weekOption({ groupId: "rollback-option", dateFrom: "2026-08-06", dateTo: "2026-08-06" }),
        )).rows[0]?.id);
        blockId = Number((await repository.insertGlobalDayBlock(
          dayBlock({ blockDate: "2026-08-07", reason: "Rollback" }),
        )).rows[0]?.id);
        throw new Error("rollback");
      }),
      /rollback/,
    );

    assert.equal(
      (await context.repository.listSettings()).some((entry) => entry.key === "rollback_setting"),
      false,
    );
    assert.deepEqual(await context.repository.listLocationBranding(), []);
    assert.equal(await context.repository.getWeekOptionById({ id: optionId }), null);
    assert.equal(await context.repository.getGlobalDayBlockById({ id: blockId }), null);
  } finally {
    await context.close();
  }
});
