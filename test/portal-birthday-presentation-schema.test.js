"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PORTAL_BIRTHDAY_PRESENTATION_CATALOG_MIGRATION_ID,
  PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_TABLE_DEFINITIONS,
  PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID,
  PORTAL_BIRTHDAY_PRESENTATION_STORAGE_IDS,
  PORTAL_BIRTHDAY_PRESENTATION_TABLE_NAMES,
  PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS,
  PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_NAMES,
  ensureSqlitePortalBirthdayPresentationSchema,
  inspectSqlitePortalBirthdayPresentationLegacyV1Rows,
  inspectSqlitePortalBirthdayPresentationLegacyV1Schema,
  inspectSqlitePortalBirthdayPresentationRows,
  inspectSqlitePortalBirthdayPresentationSchema,
  migrateSqlitePortalBirthdayPresentationCatalogV2,
} = require("../lib/persistence/sqlite/operations/portal-birthday-presentation-schema");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function databaseFixture() {
  const database = openSqliteLegacyDatabase(":memory:");
  database.exec(`
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1
    )
  `);
  return database;
}

function ensureLegacyV1Schema(database) {
  for (const item of PORTAL_BIRTHDAY_PRESENTATION_LEGACY_V1_TABLE_DEFINITIONS) {
    database.exec(item.sql);
  }
  database.exec(`
    INSERT OR IGNORE INTO portal_birthday_presentation_policy (
      singleton_id, enabled, revision, updated_at
    ) VALUES (1, 0, 1, '2026-08-20T09:00:00.000Z')
  `);
  for (const item of PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_DEFINITIONS) {
    database.exec(item.sql);
  }
}

test("Geburtstagsdarstellungs-Schema ist isoliert, idempotent und ohne Geburtsdaten", () => {
  const database = databaseFixture();
  try {
    assert.equal(
      PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID,
      "v0.92.10-portal-birthday-presentation-settings",
    );
    assert.equal(
      PORTAL_BIRTHDAY_PRESENTATION_CATALOG_MIGRATION_ID,
      "v0.92.10-portal-birthday-presentation-catalog",
    );
    assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_STORAGE_IDS, [
      "off", "standard", "elegant", "farbenfroh", "fotowelt", "technik",
    ]);
    assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_TABLE_NAMES, [
      "portal_birthday_presentation_policy",
      "portal_birthday_presentation_assignments",
    ]);
    assert.equal(inspectSqlitePortalBirthdayPresentationSchema(database).absent, true);
    assert.deepEqual(inspectSqlitePortalBirthdayPresentationRows(database), {
      valid: true,
      absent: true,
      issues: [],
    });

    ensureSqlitePortalBirthdayPresentationSchema(database);
    ensureSqlitePortalBirthdayPresentationSchema(database);

    const schema = inspectSqlitePortalBirthdayPresentationSchema(database);
    assert.equal(schema.valid, true);
    assert.equal(schema.absent, false);
    assert.deepEqual(schema.issues, []);
    assert.equal(PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_NAMES.length, 4);
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);

    const policy = database.prepare(`
      SELECT singleton_id, enabled, revision, updated_at
      FROM portal_birthday_presentation_policy
    `).get();
    assert.equal(policy.singleton_id, 1);
    assert.equal(policy.enabled, 0);
    assert.equal(policy.revision, 1);
    assert.match(policy.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    assert.deepEqual(database.prepare(
      "PRAGMA table_info(portal_birthday_presentation_policy)",
    ).all().map(({ name }) => name), ["singleton_id", "enabled", "revision", "updated_at"]);
    assert.deepEqual(database.prepare(
      "PRAGMA table_info(portal_birthday_presentation_assignments)",
    ).all().map(({ name }) => name), [
      "employee_number",
      "presentation_id",
      "revision",
      "created_at",
      "updated_at",
    ]);
  } finally {
    database.close();
  }
});

test("Katalog-V2 speichert nur die fünf festen Designs und off", () => {
  const database = databaseFixture();
  try {
    ensureSqlitePortalBirthdayPresentationSchema(database);
    const insertEmployee = database.prepare(
      "INSERT INTO employees (personnel_number, full_name) VALUES (?, ?)",
    );
    const insertAssignment = database.prepare(`
      INSERT INTO portal_birthday_presentation_assignments (
        employee_number, presentation_id, revision, created_at, updated_at
      ) VALUES (?, ?, 1, '2026-08-20T10:00:00.000Z', '2026-08-20T10:00:00.000Z')
    `);
    for (const [index, presentationId] of PORTAL_BIRTHDAY_PRESENTATION_STORAGE_IDS.entries()) {
      const employeeNumber = String(800 + index);
      insertEmployee.run(employeeNumber, `Katalog ${presentationId}`);
      insertAssignment.run(employeeNumber, presentationId);
    }
    insertEmployee.run("899", "Nicht freigegeben");
    assert.throws(
      () => insertAssignment.run("899", "upload"),
      /CHECK constraint failed/,
    );
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);
  } finally {
    database.close();
  }
});

test("Legacy-V1 wird atomar auf Katalog-V2 migriert und erhält alle Fachdaten", () => {
  const database = databaseFixture();
  try {
    database.exec(`
      INSERT INTO employees (personnel_number, full_name) VALUES
        ('252', 'Seiwald Christian'),
        ('412', 'Weber Nicolai Sascha')
    `);
    ensureLegacyV1Schema(database);
    database.prepare(`
      UPDATE portal_birthday_presentation_policy
      SET enabled = 1, revision = 2, updated_at = '2026-08-20T10:00:00.000Z'
      WHERE singleton_id = 1
    `).run();
    database.exec(`
      INSERT INTO portal_birthday_presentation_assignments (
        employee_number, presentation_id, revision, created_at, updated_at
      ) VALUES
        ('252', 'standard', 3, '2026-08-20T10:01:00.000Z', '2026-08-20T10:02:00.000Z'),
        ('412', 'off', 2, '2026-08-20T10:03:00.000Z', '2026-08-20T10:04:00.000Z')
    `);

    assert.equal(inspectSqlitePortalBirthdayPresentationLegacyV1Schema(database).valid, true);
    assert.equal(inspectSqlitePortalBirthdayPresentationLegacyV1Rows(database).valid, true);
    assert.equal(inspectSqlitePortalBirthdayPresentationSchema(database).valid, false);
    assert.deepEqual(migrateSqlitePortalBirthdayPresentationCatalogV2(database), {
      migrated: true,
      rowsPreserved: 2,
    });
    assert.equal(inspectSqlitePortalBirthdayPresentationSchema(database).valid, true);
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);
    assert.deepEqual(database.prepare(`
      SELECT employee_number AS employeeNumber, presentation_id AS presentationId,
             revision, created_at AS createdAt, updated_at AS updatedAt
      FROM portal_birthday_presentation_assignments ORDER BY employee_number
    `).all().map((row) => ({ ...row })), [
      {
        employeeNumber: "252", presentationId: "standard", revision: 3,
        createdAt: "2026-08-20T10:01:00.000Z", updatedAt: "2026-08-20T10:02:00.000Z",
      },
      {
        employeeNumber: "412", presentationId: "off", revision: 2,
        createdAt: "2026-08-20T10:03:00.000Z", updatedAt: "2026-08-20T10:04:00.000Z",
      },
    ]);
    assert.deepEqual({ ...database.prepare(`
      SELECT enabled, revision, updated_at AS updatedAt
      FROM portal_birthday_presentation_policy WHERE singleton_id = 1
    `).get() }, {
      enabled: 1,
      revision: 2,
      updatedAt: "2026-08-20T10:00:00.000Z",
    });
    database.prepare(`
      UPDATE portal_birthday_presentation_assignments
      SET presentation_id = 'fotowelt', revision = 4,
          updated_at = '2026-08-20T10:05:00.000Z'
      WHERE employee_number = '252'
    `).run();
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);
    assert.deepEqual(migrateSqlitePortalBirthdayPresentationCatalogV2(database), {
      migrated: false,
      rowsPreserved: 0,
    });
  } finally {
    database.close();
  }
});

test("Katalogmigration rollt bei einem strukturellen Konflikt vollständig zurück", () => {
  const database = databaseFixture();
  try {
    database.exec("INSERT INTO employees (personnel_number, full_name) VALUES ('252', 'Test')");
    ensureLegacyV1Schema(database);
    database.exec(`
      INSERT INTO portal_birthday_presentation_assignments (
        employee_number, presentation_id, revision, created_at, updated_at
      ) VALUES ('252', 'standard', 1, '2026-08-20T10:00:00.000Z', '2026-08-20T10:00:00.000Z');
      CREATE TABLE portal_birthday_presentation_assignments_legacy_v1 (id INTEGER)
    `);

    assert.throws(
      () => migrateSqlitePortalBirthdayPresentationCatalogV2(database),
      /already another table|already exists/i,
    );
    assert.equal(inspectSqlitePortalBirthdayPresentationLegacyV1Schema(database).valid, true);
    assert.equal(database.prepare(`
      SELECT presentation_id FROM portal_birthday_presentation_assignments
      WHERE employee_number = '252'
    `).get().presentation_id, "standard");
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_portal_birthday_presentation_assignment_%'
    `).get().count, 2);
  } finally {
    database.close();
  }
});

test("Policy und Zuordnungen erzwingen Revisionssprung und verhindern Löschung", () => {
  const database = databaseFixture();
  try {
    ensureSqlitePortalBirthdayPresentationSchema(database);
    database.prepare("INSERT INTO employees (personnel_number, full_name) VALUES (?, ?)")
      .run("252", "Seiwald Christian");
    database.prepare(`
      INSERT INTO portal_birthday_presentation_assignments (
        employee_number, presentation_id, revision, created_at, updated_at
      ) VALUES (?, 'standard', 1, ?, ?)
    `).run("252", "2026-08-20T10:00:00.000Z", "2026-08-20T10:00:00.000Z");

    assert.throws(() => database.prepare(`
      UPDATE portal_birthday_presentation_policy
      SET enabled = 1, updated_at = ?
      WHERE singleton_id = 1
    `).run("2026-08-20T10:01:00.000Z"), /revision is invalid/);
    database.prepare(`
      UPDATE portal_birthday_presentation_policy
      SET enabled = 1, revision = 2, updated_at = ?
      WHERE singleton_id = 1
    `).run("2026-08-20T10:01:00.000Z");
    assert.throws(
      () => database.prepare("DELETE FROM portal_birthday_presentation_policy").run(),
      /cannot be deleted/,
    );

    assert.throws(() => database.prepare(`
      UPDATE portal_birthday_presentation_assignments
      SET presentation_id = 'off', updated_at = ?
      WHERE employee_number = '252'
    `).run("2026-08-20T10:02:00.000Z"), /revision is invalid/);
    database.prepare(`
      UPDATE portal_birthday_presentation_assignments
      SET presentation_id = 'off', revision = 2, updated_at = ?
      WHERE employee_number = '252'
    `).run("2026-08-20T10:02:00.000Z");
    assert.throws(
      () => database.prepare(`
        DELETE FROM portal_birthday_presentation_assignments
        WHERE employee_number = '252'
      `).run(),
      /cannot be deleted/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM employees WHERE personnel_number = '252'").run(),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);
  } finally {
    database.close();
  }
});

test("Inspektor erkennt strukturelle Drift und ungültige Zeilen fail-closed", () => {
  const database = databaseFixture();
  try {
    ensureSqlitePortalBirthdayPresentationSchema(database);
    database.exec("DROP TRIGGER trg_portal_birthday_presentation_assignment_no_delete");
    const drift = inspectSqlitePortalBirthdayPresentationSchema(database);
    assert.equal(drift.valid, false);
    assert.deepEqual(drift.missingTriggers, [
      "trg_portal_birthday_presentation_assignment_no_delete",
    ]);
    assert.deepEqual(inspectSqlitePortalBirthdayPresentationRows(database), {
      valid: false,
      absent: false,
      issues: ["schema-invalid"],
    });

    ensureSqlitePortalBirthdayPresentationSchema(database);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(`
      UPDATE portal_birthday_presentation_policy
      SET enabled = 1, revision = 2, updated_at = 'invalid'
      WHERE singleton_id = 1
    `).run();
    database.exec("PRAGMA ignore_check_constraints = OFF");
    assert.deepEqual(inspectSqlitePortalBirthdayPresentationRows(database).issues, [
      "policy-row-invalid",
    ]);
  } finally {
    database.close();
  }
});
