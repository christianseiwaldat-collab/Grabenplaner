"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  runSqliteHistoricalCompatibilityMigrations,
} = require("../lib/persistence/sqlite/operations/historical-compatibility-migrations");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const {
  canonicalSha256,
} = require("../lib/work-rules/receipt");

function runMigrations(database, {
  databaseExistedBeforeOpen = false,
  onBackup = () => {},
} = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.87-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

test("Block 3/7: frische SQLite-Datenbank und idempotenter Wiederanlauf", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    runMigrations(database, {
      onBackup: () => { backups += 1; },
    });
    database.prepare(`
      INSERT INTO cost_center_types
        (id, code, name, is_branch, active, builtin, sort_order)
      VALUES ('fresh-test', 'FRESH-TEST', 'Fresh test', 0, 1, 0, 100)
    `).run();

    runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => { backups += 1; },
    });

    assert.equal(backups, 1);
    assert.equal(
      database.prepare("SELECT name FROM cost_center_types WHERE id = 'fresh-test'").get().name,
      "Fresh test",
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'v0.87-loan-photo-pdf-attachments'").get().count,
      1,
    );
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    database.close();
  }
});

test("Block 3/7: historische Mitarbeiter-/Dienstplanstruktur wird verlustfrei aktualisiert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backupObservations = [];
  try {
    database.exec(`
      CREATE TABLE employees (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        contracted_hours REAL NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE shifts (
        id INTEGER PRIMARY KEY,
        employee_id INTEGER NOT NULL,
        shift_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        area TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO employees
        (id, name, color, contracted_hours, active, created_at)
      VALUES
        (41, 'Historische Person', '#123456', 38.5, 1, '2024-01-01T08:00:00Z');
      INSERT INTO shifts
        (id, employee_id, shift_date, start_time, end_time, area, note, created_at)
      VALUES
        (91, 41, '2026-07-01', '08:00', '16:30', 'Verkauf', 'Historisch', '2026-06-01T08:00:00Z');
    `);

    runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => {
        backupObservations.push({
          legacyColumnPresent: database.prepare("PRAGMA table_info(employees)").all()
            .some((column) => column.name === "id"),
          employeeCount: database.prepare("SELECT COUNT(*) AS count FROM employees").get().count,
          shiftCount: database.prepare("SELECT COUNT(*) AS count FROM shifts").get().count,
        });
      },
    });

    assert.deepEqual(backupObservations, [{
      legacyColumnPresent: true,
      employeeCount: 1,
      shiftCount: 1,
    }]);
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT personnel_number, full_name, nickname, color, contracted_hours,
                 home_location_id, active, created_at
          FROM employees
          WHERE personnel_number = '41'
        `).get(),
      },
      {
        personnel_number: "41",
        full_name: "Historische Person",
        nickname: "Historische Person",
        color: "#123456",
        contracted_hours: 38.5,
        home_location_id: "01",
        active: 1,
        created_at: "2024-01-01T08:00:00Z",
      },
    );
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT id, employee_number, location_id, shift_date, start_time,
                 end_time, area, note, created_at
          FROM shifts
          WHERE id = 91
        `).get(),
      },
      {
        id: 91,
        employee_number: "41",
        location_id: "01",
        shift_date: "2026-07-01",
        start_time: "08:00",
        end_time: "16:30",
        area: "Verkauf",
        note: "Historisch",
        created_at: "2026-06-01T08:00:00Z",
      },
    );
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    database.close();
  }
});

test("Block 3/7: historischer globaler Sperrtag wird standortbezogen und idempotent aktualisiert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    database.exec(`
      INSERT INTO locations (id, name, active)
      VALUES ('18', 'Historischer Standort', 1);
      DROP INDEX IF EXISTS idx_global_day_blocks_location_week;
      DROP TABLE global_day_blocks;
      CREATE TABLE global_day_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start TEXT NOT NULL,
        block_date TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL DEFAULT '',
        is_public_holiday INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO global_day_blocks
        (id, week_start, block_date, reason, is_public_holiday, created_at)
      VALUES
        (7, '2026-06-29', '2026-07-01', 'Historische Sperre', 1, '2026-01-01T09:00:00Z');
    `);

    runSqliteHistoricalCompatibilityMigrations(database);
    runSqliteHistoricalCompatibilityMigrations(database);

    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT id, location_id, week_start, block_date, reason,
                 is_public_holiday, created_at
          FROM global_day_blocks
          WHERE id = 7
        `).get(),
      },
      {
        id: 7,
        location_id: "18",
        week_start: "2026-06-29",
        block_date: "2026-07-01",
        reason: "Historische Sperre",
        is_public_holiday: 1,
        created_at: "2026-01-01T09:00:00Z",
      },
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_global_day_blocks_location_week'
      `).get().count,
      1,
    );
  } finally {
    database.close();
  }
});
