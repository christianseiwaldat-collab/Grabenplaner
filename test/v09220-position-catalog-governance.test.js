"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

const {
  POSITION_ASSIGNMENT_MIGRATION_ID,
  POSITION_CATALOG_MIGRATION_ID,
  migrateSqlitePositionCatalogAssignments,
  migrateSqlitePositionCatalogGovernance,
} = require("../lib/persistence/sqlite/operations/position-catalog-governance");

function fixture() {
  const db = openSqliteLegacyDatabase(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      app_version TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE cost_center_types (
      id TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE positions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      builtin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      employment_classification TEXT NOT NULL DEFAULT 'standard',
      sort_order INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT '',
      archived_by TEXT,
      archived_at TEXT
    );
    CREATE TABLE cost_center_type_positions (
      cost_center_type_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cost_center_type_id, position_id),
      FOREIGN KEY (cost_center_type_id) REFERENCES cost_center_types(id),
      FOREIGN KEY (position_id) REFERENCES positions(id)
    );
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY,
      position_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (position_id) REFERENCES positions(id)
    );

    INSERT INTO cost_center_types (id) VALUES ('branch'), ('administration'), ('production'), ('other');
    INSERT INTO positions (id, name, builtin, sort_order)
    VALUES
      ('teamleitung', 'Teamleitung', 1, 1),
      ('abteilungsleitung', 'Abteilungsleitung', 1, 2),
      ('verkaufsmitarbeiter', 'Verkaufsmitarbeiter', 1, 3),
      ('lehrling', 'Auszubildende Person', 1, 4);
    INSERT INTO employees (personnel_number, position_id, active)
    VALUES ('E1', 'verkaufsmitarbeiter', 1), ('E2', 'lehrling', 0), ('419', 'verkaufsmitarbeiter', 1);
  `);
  return db;
}

test("v0.92.20 Positionskatalog migriert bestehende Namen idempotent und revisionssicher", () => {
  const db = fixture();
  try {
    const first = migrateSqlitePositionCatalogGovernance(db, { appVersion: "0.92.20-beta" });
    assert.equal(first.applied, true);
    assert.ok(first.insertedIds.includes("fl-stellvertretung"));
    assert.equal(db.prepare("SELECT name FROM positions WHERE id = 'lehrling'").get().name, "Auszubildende Person");
    assert.equal(
      db.prepare("SELECT employment_classification FROM positions WHERE id = 'lehrling'").get().employment_classification,
      "apprentice",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM positions WHERE builtin <> 0").get().count, 0);
    assert.equal(
      db.prepare("SELECT id FROM positions WHERE active = 1 AND is_default = 1").get().id,
      "verkaufsmitarbeiter",
    );
    assert.ok(db.prepare(`
      SELECT 1 FROM cost_center_type_positions
      WHERE cost_center_type_id = 'branch' AND position_id = 'fl-stellvertretung'
    `).get());
    assert.ok(db.prepare(`
      SELECT 1 FROM cost_center_type_positions
      WHERE cost_center_type_id = 'administration' AND position_id = 'personalleitung'
    `).get());

    const second = migrateSqlitePositionCatalogGovernance(db, { appVersion: "0.92.20-beta" });
    assert.equal(second.applied, false);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?").get(POSITION_CATALOG_MIGRATION_ID).count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'position.catalog.migrate'").get().count,
      1,
    );
  } finally {
    db.close();
  }
});

test("v0.92.20 ordnet Maria 419 einmalig und auditierbar der FL Stellvertretung zu", () => {
  const db = fixture();
  try {
    migrateSqlitePositionCatalogGovernance(db, { appVersion: "0.92.20-beta" });
    const first = migrateSqlitePositionCatalogAssignments(db, { appVersion: "0.92.20-beta" });
    assert.deepEqual(first, {
      applied: true,
      migrationId: POSITION_ASSIGNMENT_MIGRATION_ID,
      employeeFound: true,
      changed: true,
    });
    assert.equal(
      db.prepare("SELECT position_id FROM employees WHERE personnel_number = '419'").get().position_id,
      "fl-stellvertretung",
    );
    const audit = db.prepare(`
      SELECT actor, entity_type, entity_id, detail
      FROM audit_log
      WHERE action = 'employee.position.migrate'
    `).get();
    assert.equal(audit.actor, "migration");
    assert.equal(audit.entity_type, "employee");
    assert.equal(audit.entity_id, "419");
    assert.deepEqual(JSON.parse(audit.detail), {
      migrationId: POSITION_ASSIGNMENT_MIGRATION_ID,
      employeeNumber: "419",
      employeeFound: true,
      employeeActive: true,
      beforePositionId: "verkaufsmitarbeiter",
      afterPositionId: "fl-stellvertretung",
      changed: true,
    });

    const second = migrateSqlitePositionCatalogAssignments(db, { appVersion: "0.92.20-beta" });
    assert.equal(second.applied, false);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?").get(POSITION_ASSIGNMENT_MIGRATION_ID).count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'employee.position.migrate'").get().count,
      1,
    );
  } finally {
    db.close();
  }
});

test("v0.92.20 Positionskatalog erzwingt Archivierung und schützt aktive Zuordnungen auf Datenbankebene", () => {
  const db = fixture();
  try {
    migrateSqlitePositionCatalogGovernance(db, { appVersion: "0.92.20-beta" });
    assert.throws(
      () => db.prepare("UPDATE positions SET active = 0 WHERE id = 'verkaufsmitarbeiter'").run(),
      /POSITION_ACTIVE_EMPLOYEES_IN_USE/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM positions WHERE id = 'teamleitung'").run(),
      /POSITION_ARCHIVE_ONLY/,
    );
    db.prepare(`
      UPDATE positions
      SET active = 0, is_default = 0, archived_by = 'test', archived_at = CURRENT_TIMESTAMP
      WHERE id = 'teamleitung'
    `).run();
    assert.throws(
      () => db.prepare("UPDATE employees SET position_id = 'teamleitung' WHERE personnel_number = 'E1'").run(),
      /EMPLOYEE_POSITION_INACTIVE/,
    );
  } finally {
    db.close();
  }
});
