"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
  inspectSqlitePersonalNotificationContactsSchema,
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
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'v0.89-personal-notification-preferences'").get().count,
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

test("v0.89: Praeferenzmigration markiert eine inkompatible Kontakttabelle nicht", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    database.exec(`
      CREATE TABLE personal_notification_contacts (
        employee_number TEXT PRIMARY KEY,
        protected_address TEXT NOT NULL,
        verified_at TEXT,
        verification_hash TEXT NOT NULL DEFAULT '',
        verification_salt TEXT NOT NULL DEFAULT '',
        verification_expires_at TEXT,
        verification_attempts INTEGER NOT NULL DEFAULT 0,
        verification_sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => { backups += 1; },
      }),
      /personal_notification_contacts.*email_target_fingerprint/i,
    );
    assert.equal(backups, 1);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM schema_migrations
        WHERE id = 'v0.89-personal-notification-preferences'
      `).get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("v0.89: Legacy-Kontakte werden PII-frei migriert und alte Zielkopien entfernt", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    ensureSqliteApplicationSchema(database);
    database.exec(`
      DROP TABLE personal_notification_contacts;
      CREATE TABLE personal_notification_contacts (
        employee_number TEXT PRIMARY KEY,
        protected_address TEXT NOT NULL CHECK(TRIM(protected_address) <> ''),
        address_active INTEGER NOT NULL DEFAULT 1 CHECK(address_active IN (0,1)),
        verified_at TEXT,
        verification_hash TEXT NOT NULL DEFAULT '',
        verification_salt TEXT NOT NULL DEFAULT '',
        verification_generation TEXT NOT NULL DEFAULT '',
        verification_expires_at TEXT,
        verification_attempts INTEGER NOT NULL DEFAULT 0,
        verification_sent_at TEXT,
        verification_rate_window_started_at TEXT,
        verification_rate_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
      INSERT INTO employees (personnel_number, full_name, nickname)
      VALUES ('101', 'Legacy Kontakt', 'Legacy');
      INSERT INTO personal_notification_contacts (
        employee_number,
        protected_address,
        address_active,
        verified_at,
        verification_hash,
        verification_salt,
        verification_generation,
        verification_expires_at,
        verification_attempts,
        verification_sent_at,
        verification_rate_window_started_at,
        verification_rate_count,
        created_at,
        updated_at
      ) VALUES (
        '101',
        'enc:v2:legacy-address',
        1,
        '2026-07-30T07:00:00.000Z',
        'legacy-hash',
        'legacy-salt',
        'legacy-generation',
        '2026-07-30T07:10:00.000Z',
        3,
        '2026-07-30T07:00:00.000Z',
        '2026-07-30T06:00:00.000Z',
        4,
        '2026-07-29T08:00:00.000Z',
        '2026-07-30T08:00:00.000Z'
      );
      INSERT INTO sickness_notification_preferences (
        employee_number,
        channel,
        enabled,
        process_notifications_enabled,
        earliest_time,
        protected_destination,
        verified_at,
        verification_hash,
        verification_salt,
        verification_expires_at,
        verification_attempts,
        verification_sent_at
      ) VALUES (
        '101',
        'email',
        1,
        1,
        '06:45',
        'enc:v2:legacy-destination',
        '2026-07-30T07:00:00.000Z',
        'legacy-hash',
        'legacy-salt',
        '2026-07-30T07:10:00.000Z',
        2,
        '2026-07-30T07:00:00.000Z'
      );
      INSERT INTO outbound_notification_jobs (
        id,
        recipient_lookup,
        channel,
        entity_lookup,
        protected_payload,
        not_before,
        purge_after,
        dedupe_lookup
      ) VALUES (
        'legacy-job',
        'recipient',
        'email',
        'entity',
        'enc:v2:legacy-job-destination',
        '2026-07-30T07:00:00.000Z',
        '2026-08-30T07:00:00.000Z',
        'legacy-job-dedupe'
      );
    `);

    runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => { backups += 1; },
    });
    assert.equal(backups, 1);
    assert.deepEqual(inspectSqlitePersonalNotificationContactsSchema(database), {
      exists: true,
      valid: true,
      issues: [],
    });
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT
            email_target_fingerprint,
            phone_target_fingerprint,
            email_verified_at,
            phone_verified_at,
            email_enabled,
            sms_enabled,
            whatsapp_enabled,
            earliest_time,
            verification_target,
            verification_channel,
            verification_target_fingerprint,
            verification_hash,
            verification_salt,
            verification_generation,
            verification_expires_at,
            verification_attempts,
            verification_sent_at,
            verification_rate_window_started_at,
            verification_rate_count,
            created_at,
            updated_at
          FROM personal_notification_contacts
          WHERE employee_number = '101'
        `).get(),
      },
      {
        email_target_fingerprint: "",
        phone_target_fingerprint: "",
        email_verified_at: null,
        phone_verified_at: null,
        email_enabled: 0,
        sms_enabled: 0,
        whatsapp_enabled: 0,
        earliest_time: "08:00",
        verification_target: "",
        verification_channel: "",
        verification_target_fingerprint: "",
        verification_hash: "",
        verification_salt: "",
        verification_generation: "",
        verification_expires_at: null,
        verification_attempts: 0,
        verification_sent_at: null,
        verification_rate_window_started_at: "2026-07-30T06:00:00.000Z",
        verification_rate_count: 4,
        created_at: "2026-07-29T08:00:00.000Z",
        updated_at: "2026-07-30T08:00:00.000Z",
      },
    );
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT enabled, process_notifications_enabled, earliest_time,
                 protected_destination, verified_at, verification_hash,
                 verification_salt, verification_expires_at,
                 verification_attempts, verification_sent_at
          FROM sickness_notification_preferences
          WHERE employee_number = '101' AND channel = 'email'
        `).get(),
      },
      {
        enabled: 1,
        process_notifications_enabled: 1,
        earliest_time: "06:45",
        protected_destination: "",
        verified_at: null,
        verification_hash: "",
        verification_salt: "",
        verification_expires_at: null,
        verification_attempts: 0,
        verification_sent_at: null,
      },
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM outbound_notification_jobs").get().count,
      0,
    );
    assert.equal(
      database.prepare("PRAGMA table_info(personal_notification_contacts)").all()
        .some((column) => column.name === "protected_address"),
      false,
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations
      WHERE id = 'v0.89-personal-notification-preferences'
    `).get().count, 1);
  } finally {
    database.close();
  }
});
