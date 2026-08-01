"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PERSONNEL_LIFECYCLE_CONVERSION_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_CONVERSION_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelLifecycleConversionSchema,
  inspectSqlitePersonnelLifecycleSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

function runMigrations(database, {
  databaseExistedBeforeOpen = false,
  onBackup = () => {},
} = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.89-personnel-conversion-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function normalizeDefinitionSql(sql, type) {
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(new RegExp(`^create ${type} if not exists `, "i"), `create ${type} `)
    .toLowerCase();
}

function removeConversionSchema(database) {
  for (const definition of PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  database.exec("DROP TABLE IF EXISTS candidate_conversions");
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_LIFECYCLE_CONVERSION_MIGRATION_ID);
}

function insertCandidateFixture(database, suffix = "one") {
  const employeeNumber = `m3-${suffix}`;
  const candidateId = `candidate-${suffix}`;
  const applicationId = `application-${suffix}`;
  const occurredAt = "2026-08-01T12:00:00.000Z";
  database.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname)
    VALUES (?, ?, ?)
  `).run(employeeNumber, `M3 Person ${suffix}`, `M3 ${suffix}`);
  database.prepare(`
    INSERT INTO candidates (
      id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
    ) VALUES (?, 'active', ?, 1, 'M3-HR', 'M3-HR', ?, ?)
  `).run(candidateId, `enc:v2:candidate-${suffix}`, occurredAt, occurredAt);
  database.prepare(`
    INSERT INTO candidate_applications (
      id, candidate_id, status, protected_payload, revision, status_changed_at,
      created_by, updated_by, created_at, updated_at
    ) VALUES (?, ?, 'preboarding', ?, 1, ?, 'M3-HR', 'M3-HR', ?, ?)
  `).run(applicationId, candidateId, `enc:v2:application-${suffix}`, occurredAt, occurredAt, occurredAt);
  return { applicationId, candidateId, employeeNumber, occurredAt };
}

function insertConversion(database, fixture, id = "123e4567-e89b-42d3-a456-426614174000") {
  database.prepare(`
    INSERT INTO candidate_conversions (
      id, candidate_id, application_id, employee_number, request_sha256,
      protected_payload, receipt_sha256, actor_employee_number, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'M3-HR', ?)
  `).run(
    id,
    fixture.candidateId,
    fixture.applicationId,
    fixture.employeeNumber,
    "a".repeat(64),
    "enc:v2:conversion",
    "b".repeat(64),
    fixture.occurredAt,
  );
}

test("Personalmodul M3: vorhandene Bewerberdaten erhalten die Conversion-Tabelle additiv", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backupObservations = [];
  try {
    runMigrations(database);
    removeConversionSchema(database);
    const fixture = insertCandidateFixture(database, "preserved");

    assert.equal(inspectSqlitePersonnelLifecycleSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleConversionSchema(database).absent, true);

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => {
        backupObservations.push({
          candidates: database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count,
          applications: database.prepare("SELECT COUNT(*) AS count FROM candidate_applications").get().count,
          conversionTablePresent: Boolean(database.prepare(`
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'candidate_conversions'
          `).get()),
        });
      },
    });

    assert.equal(result.personnelLifecycleConversionMigrationRequired, true);
    assert.deepEqual(backupObservations, [{
      candidates: 1,
      applications: 1,
      conversionTablePresent: false,
    }]);
    assert.equal(database.prepare("SELECT protected_payload FROM candidates WHERE id = ?")
      .get(fixture.candidateId).protected_payload, "enc:v2:candidate-preserved");
    assert.equal(database.prepare("SELECT protected_payload FROM candidate_applications WHERE id = ?")
      .get(fixture.applicationId).protected_payload, "enc:v2:application-preserved");
    assert.equal(inspectSqlitePersonnelLifecycleSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleConversionSchema(database).valid, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_LIFECYCLE_CONVERSION_MIGRATION_ID).count, 1);

    const rerun = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(rerun.personnelLifecycleConversionMigrationRequired, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM candidate_applications").get().count, 1);
  } finally {
    database.close();
  }
});

test("Personalmodul M3: Tabelle und Immutability-Trigger entsprechen exakt dem Vertrag", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const inspection = inspectSqlitePersonnelLifecycleConversionSchema(database);
    assert.deepEqual(inspection, {
      valid: true,
      absent: false,
      issues: [],
      missingTables: [],
      invalidTables: [],
      missingTriggers: [],
      invalidTriggers: [],
    });

    for (const [type, definitions] of [
      ["table", PERSONNEL_LIFECYCLE_CONVERSION_TABLE_DEFINITIONS],
      ["trigger", PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS],
    ]) {
      for (const definition of definitions) {
        const stored = database.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
          .get(type, definition.name);
        assert.equal(
          normalizeDefinitionSql(stored?.sql, type),
          normalizeDefinitionSql(definition.sql, type),
          definition.name,
        );
      }
    }

    const fixture = insertCandidateFixture(database, "immutable");
    insertConversion(database, fixture);
    assert.throws(
      () => database.prepare("UPDATE candidate_conversions SET actor_employee_number = 'other' WHERE candidate_id = ?")
        .run(fixture.candidateId),
      /candidate conversions are immutable/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM candidate_conversions WHERE candidate_id = ?")
        .run(fixture.candidateId),
      /candidate conversions are immutable/,
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("Personalmodul M3: ein abweichender Trigger wird nach Backup ohne Datenverlust repariert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backupObservations = [];
  try {
    runMigrations(database);
    const fixture = insertCandidateFixture(database, "trigger-repair");
    insertConversion(database, fixture, "123e4567-e89b-42d3-a456-426614174001");
    database.exec(`
      DROP TRIGGER trg_candidate_conversions_immutable_update;
      CREATE TRIGGER trg_candidate_conversions_immutable_update
      BEFORE UPDATE ON candidate_conversions
      BEGIN
        SELECT RAISE(ABORT, 'wrong conversion trigger');
      END;
    `);

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backupObservations.push(
        database.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count,
      ),
    });

    assert.equal(result.personnelLifecycleConversionMigrationRequired, true);
    assert.deepEqual(backupObservations, [1]);
    assert.equal(inspectSqlitePersonnelLifecycleConversionSchema(database).valid, true);
    assert.equal(database.prepare("SELECT employee_number FROM candidate_conversions WHERE id = ?")
      .get("123e4567-e89b-42d3-a456-426614174001").employee_number, fixture.employeeNumber);
    assert.throws(
      () => database.prepare("UPDATE candidate_conversions SET actor_employee_number = 'other' WHERE id = ?")
        .run("123e4567-e89b-42d3-a456-426614174001"),
      /candidate conversions are immutable/,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul M3: ein fremdes Conversion-Schema mit Daten bricht nach Backup unveraendert ab", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backupObservations = [];
  try {
    runMigrations(database);
    removeConversionSchema(database);
    const fixture = insertCandidateFixture(database, "fail-closed");
    database.exec(`
      CREATE TABLE candidate_conversions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        legacy_payload TEXT NOT NULL
      );
      INSERT INTO candidate_conversions (id, candidate_id, legacy_payload)
      VALUES ('legacy-conversion', '${fixture.candidateId}', 'must-survive');
    `);

    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => backupObservations.push({
          candidates: database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count,
          conversions: database.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count,
        }),
      }),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_CONVERSION_SCHEMA_DATA_PRESENT",
    );
    assert.deepEqual(backupObservations, [{ candidates: 1, conversions: 1 }]);
    assert.deepEqual(
      { ...database.prepare("SELECT id, candidate_id, legacy_payload FROM candidate_conversions").get() },
      { id: "legacy-conversion", candidate_id: fixture.candidateId, legacy_payload: "must-survive" },
    );
    assert.equal(database.prepare("SELECT protected_payload FROM candidates WHERE id = ?")
      .get(fixture.candidateId).protected_payload, "enc:v2:candidate-fail-closed");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_LIFECYCLE_CONVERSION_MIGRATION_ID).count, 0);
  } finally {
    database.close();
  }
});
