"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID,
  PORTAL_BIRTHDAY_PRESENTATION_TABLE_NAMES,
  PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_NAMES,
  ensureSqlitePortalBirthdayPresentationSchema,
  inspectSqlitePortalBirthdayPresentationRows,
  inspectSqlitePortalBirthdayPresentationSchema,
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

test("Geburtstagsdarstellungs-Schema ist isoliert, idempotent und ohne Geburtsdaten", () => {
  const database = databaseFixture();
  try {
    assert.equal(
      PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID,
      "v0.92.10-portal-birthday-presentation-settings",
    );
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
