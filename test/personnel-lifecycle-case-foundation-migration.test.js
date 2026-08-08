"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  inspectSqliteImportFile,
} = require("../lib/persistence/sqlite/operations/database-import");
const {
  PERSONNEL_LIFECYCLE_CASE_FOUNDATION_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelLifecycleCaseRows,
  inspectSqlitePersonnelLifecycleCaseSchema,
  ensureSqlitePersonnelLifecycleCaseSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-case-schema");
const {
  PERSONNEL_LIFECYCLE_ONBOARDING_INDEX_DEFINITIONS,
  PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelLifecycleOnboardingRows,
  inspectSqlitePersonnelLifecycleOnboardingSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-onboarding-schema");
const {
  PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNED_EMPLOYEE_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNMENT_TRIGGER_NAME,
  PERSONNEL_LIFECYCLE_OFFBOARDING_INDEX_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelLifecycleOffboardingRows,
  inspectSqlitePersonnelLifecycleOffboardingSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-offboarding-schema");
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
    appVersion: "0.91-o2-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function removeLifecycleCaseLayers(database) {
  for (const definition of PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  for (const definition of PERSONNEL_LIFECYCLE_OFFBOARDING_INDEX_DEFINITIONS) {
    database.exec(`DROP INDEX IF EXISTS "${definition.name}"`);
  }
  for (const name of [...PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  for (const definition of PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  for (const definition of PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  for (const name of [...PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  for (const name of [...PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES].reverse()) {
    database.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_LIFECYCLE_CASE_FOUNDATION_MIGRATION_ID);
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID);
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID);
}

function insertLegacyFixture(database) {
  database.exec(`
    INSERT INTO settings (key, value)
      VALUES ('o2-migration-byte-contract', 'unveraendert');
  `);
}

function legacyFixtureSnapshot(database) {
  return Object.freeze({
    setting: database.prepare(`
      SELECT * FROM settings WHERE key = 'o2-migration-byte-contract'
    `).get(),
  });
}

test("O2-Schema bleibt als historisches read-only Vorgaengerfundament exakt pruefbar", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);
    for (const definition of PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS) {
      database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
    for (const definition of PERSONNEL_LIFECYCLE_OFFBOARDING_INDEX_DEFINITIONS) {
      database.exec(`DROP INDEX IF EXISTS "${definition.name}"`);
    }
    for (const name of [...PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES].reverse()) {
      database.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    for (const definition of PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS) {
      database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
    for (const definition of PERSONNEL_LIFECYCLE_ONBOARDING_INDEX_DEFINITIONS) {
      database.exec(`DROP INDEX IF EXISTS "${definition.name}"`);
    }
    for (const name of [...PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES].reverse()) {
      database.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    ensureSqlitePersonnelLifecycleCaseSchema(database);
    const schema = inspectSqlitePersonnelLifecycleCaseSchema(database);
    const rows = inspectSqlitePersonnelLifecycleCaseRows(database);
    assert.equal(schema.valid, true);
    assert.equal(rows.valid, true);
    assert.equal(PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES.length, 7);
    assert.equal(PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS.length, 21);
    assert.deepEqual(PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES, [
      "personnel_employment_episodes",
      "personnel_lifecycle_cases",
      "personnel_lifecycle_case_reference_dates",
      "personnel_lifecycle_case_package_bindings",
      "personnel_lifecycle_case_assignments",
      "personnel_lifecycle_case_events",
      "personnel_lifecycle_confidential_access_events",
    ]);
    assert.throws(
      () => database.prepare(`
        INSERT INTO personnel_employment_episodes (
          id, employee_number, sequence_number, state, created_by, created_at
        ) VALUES (
          'episode-o2-blocked', 'EMP-NOT-CREATED', 1,
          'employment_active', 'PL-O2', '2026-08-02T12:00:00.000Z'
        )
      `).run(),
      /personnel lifecycle O2 persistence is read-only/,
    );
    for (const name of PERSONNEL_LIFECYCLE_CASE_TABLE_NAMES) {
      assert.equal(database.prepare(
        `SELECT COUNT(*) AS count FROM "${name}"`,
      ).get().count, 0, name);
    }
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("O4-Startup sichert vor der additiven O2-Nachfolgermigration und bleibt idempotent", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    insertLegacyFixture(database);
    removeLifecycleCaseLayers(database);
    const before = legacyFixtureSnapshot(database);

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: (label) => backups.push(label),
    });
    assert.equal(result.personnelLifecycleCaseFoundationMigrationId,
      PERSONNEL_LIFECYCLE_CASE_FOUNDATION_MIGRATION_ID);
    assert.equal(result.personnelLifecycleCaseFoundationMigrationRequired, true);
    assert.equal(result.personnelLifecycleOnboardingMigrationId,
      PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID);
    assert.equal(result.personnelLifecycleOnboardingMigrationRequired, true);
    assert.equal(result.personnelLifecycleOffboardingMigrationId,
      PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID);
    assert.equal(result.personnelLifecycleOffboardingMigrationRequired, true);
    assert.deepEqual(backups, ["pre-migration"]);
    assert.deepEqual(legacyFixtureSnapshot(database), before);
    assert.equal(inspectSqlitePersonnelLifecycleOnboardingSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleOnboardingRows(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingRows(database).valid, true);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(PERSONNEL_LIFECYCLE_CASE_FOUNDATION_MIGRATION_ID).count, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID).count, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID).count, 1);

    const repeated = runMigrations(database, {
      databaseExistedBeforeOpen: false,
      onBackup: () => backups.push("unexpected"),
    });
    assert.equal(repeated.personnelLifecycleCaseFoundationMigrationRequired, false);
    assert.equal(repeated.personnelLifecycleOnboardingMigrationRequired, false);
    assert.equal(repeated.personnelLifecycleOffboardingMigrationRequired, false);
    assert.deepEqual(backups, ["pre-migration"]);
    assert.deepEqual(legacyFixtureSnapshot(database), before);
  } finally {
    database.close();
  }
});

test("O5-Startup repariert leeren Triggerdrift erst nach Sicherung", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    const trigger = PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS.find(({ name }) => (
      name === "trg_custom_processes_o5_runtime_shell_update_blocked"
    ));
    database.exec(`DROP TRIGGER "${trigger.name}"`);
    assert.deepEqual(inspectSqlitePersonnelLifecycleOffboardingSchema(database).missingTriggers, [
      trigger.name,
    ]);

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: (label) => backups.push(label),
    });
    assert.equal(result.personnelLifecycleOffboardingMigrationRequired, true);
    assert.deepEqual(backups, ["pre-migration"]);
    assert.equal(inspectSqlitePersonnelLifecycleOnboardingSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleOnboardingRows(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingRows(database).valid, true);
  } finally {
    database.close();
  }
});

test("O5-Startup aktualisiert persoenliche Betriebsmittelaufgaben ohne Falldatenumbau", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    insertLegacyFixture(database);
    const before = legacyFixtureSnapshot(database);
    database.exec(`
      DROP TRIGGER ${PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNMENT_TRIGGER_NAME};
      CREATE TRIGGER ${PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNMENT_TRIGGER_NAME}
      BEFORE INSERT ON personnel_lifecycle_case_assignments
      BEGIN
        SELECT RAISE(ABORT, 'legacy O5 assignment trigger');
      END;
    `);
    database.prepare("DELETE FROM schema_migrations WHERE id = ?")
      .run(PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNED_EMPLOYEE_MIGRATION_ID);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingSchema(database).valid, false);

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: (label) => backups.push(label),
    });

    assert.equal(result.personnelLifecycleOffboardingAssignedEmployeeMigrationId,
      PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNED_EMPLOYEE_MIGRATION_ID);
    assert.equal(result.personnelLifecycleOffboardingAssignedEmployeeMigrationRequired, true);
    assert.deepEqual(backups, ["pre-migration"]);
    assert.deepEqual(legacyFixtureSnapshot(database), before);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingRows(database).valid, true);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNED_EMPLOYEE_MIGRATION_ID).count, 1);
  } finally {
    database.close();
  }
});

test("O5-Startup stoppt bei Triggerdrift mit Falldaten fail-closed und unveraendert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    database.exec(`
      INSERT INTO locations (id, name, active)
        VALUES ('o2-data-location', 'O2 Daten Standort', 1);
      INSERT INTO employees (
        personnel_number, full_name, nickname, home_location_id, active
      ) VALUES (
        'EMP-O2-DATA', 'O2 Daten Mitarbeiter', 'O2', 'o2-data-location', 1
      );
    `);
    database.prepare(`
      INSERT INTO personnel_employment_episodes (
        id, employee_number, sequence_number, state, protected_payload,
        created_by, created_at, updated_by, updated_at
      ) VALUES (
        ?, ?, 1, 'employment_active', 'enc:v2:fixture',
        'PL-O2', '2026-08-02T12:00:00.000Z',
        'PL-O2', '2026-08-02T12:00:00.000Z'
      )
    `).run("episode-illicit-o2", "EMP-O2-DATA");
    database.prepare(`
      INSERT INTO personnel_lifecycle_cases (
        id, case_type, employment_episode_id, predecessor_case_id, state,
        responsible_actor_id, scope_type, location_id, department_id,
        scope_snapshot_sha256, protected_payload, revision,
        created_by, created_at, updated_by, updated_at
      ) VALUES (
        'case-illicit-o5', 'offboarding', 'episode-illicit-o2', NULL,
        'internally_prepared', 'PL-O2', 'location', 'o2-data-location', NULL,
        ?, 'enc:v2:fixture-case', 1,
        'PL-O2', '2026-08-02T12:00:01.000Z',
        'PL-O2', '2026-08-02T12:00:01.000Z'
      )
    `).run("a".repeat(64));
    const driftTrigger = PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS.find(({ name }) => (
      name === "trg_personnel_lifecycle_cases_o5_transition_guard"
    ));
    database.exec(`DROP TRIGGER "${driftTrigger.name}"`);

    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup: (label) => backups.push(label),
      }),
      (error) => error?.code
        === "PERSONNEL_LIFECYCLE_OFFBOARDING_SCHEMA_DRIFT_WITH_DATA",
    );
    assert.deepEqual(backups, ["pre-migration"]);
    assert.deepEqual(database.prepare(`
      SELECT id, employee_number, state
      FROM personnel_employment_episodes
    `).all().map((row) => ({ ...row })), [{
      id: "episode-illicit-o2",
      employee_number: "EMP-O2-DATA",
      state: "employment_active",
    }]);
    assert.equal(database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(driftTrigger.name), undefined);
  } finally {
    database.close();
  }
});

test("Datenbankimport unterscheidet pre-O2, kanonisches O4 und manipuliertes O4", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-o2-import-"));
  const databasePath = path.join(root, "o2.sqlite");
  let database = openSqliteLegacyDatabase(databasePath);
  try {
    runMigrations(database);
  } finally {
    database.close();
  }
  try {
    const canonical = inspectSqliteImportFile(databasePath);
    assert.equal(canonical.personnelWorkflowInstanceSchemaState, "m5");
    assert.equal(canonical.personnelLifecycleCaseSchemaState, "o5-offboarding");

    database = openSqliteLegacyDatabase(databasePath);
    try { removeLifecycleCaseLayers(database); } finally { database.close(); }
    const predecessor = inspectSqliteImportFile(databasePath);
    assert.equal(predecessor.personnelLifecycleCaseSchemaState, "pre-o2-compatible");

    database = openSqliteLegacyDatabase(databasePath);
    try {
      ensureSqliteApplicationSchema(database);
      database.exec(`DROP TRIGGER "${PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS[0].name}"`);
    } finally {
      database.close();
    }
    const malformed = inspectSqliteImportFile(databasePath);
    assert.equal(malformed.personnelLifecycleCaseSchemaState, "invalid");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
