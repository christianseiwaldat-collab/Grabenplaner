"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAmuStorage } = require("../lib/amu-storage");
const {
  createPersonnelLifecycleRepository,
} = require("../lib/persistence/repositories/personnel-lifecycle");
const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  inspectSqliteImportFile,
} = require("../lib/persistence/sqlite/operations/database-import");
const {
  protectedStorageReferencesFromFile,
} = require("../lib/persistence/sqlite/operations/maintenance");
const {
  PERSONNEL_LIFECYCLE_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_PROFILE_PHOTO_CATEGORY_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TRIGGER_NAMES,
  inspectSqlitePersonnelLifecycleSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  SQLITE_PERSONNEL_LIFECYCLE_CATALOG,
} = require("../lib/persistence/sqlite/personnel-lifecycle-catalog");
const {
  openSqliteApplicationPersistence,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const {
  PERSONNEL_LIFECYCLE_STATEMENTS,
} = require("../lib/persistence/statements/personnel-lifecycle");
const {
  createPersonnelLifecycleService,
} = require("../lib/personnel-lifecycle");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

function runMigrations(database, {
  databaseExistedBeforeOpen = false,
  onBackup = () => {},
} = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.89-personnel-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function normalizeTriggerSql(sql) {
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(/^create trigger if not exists /i, "create trigger ")
    .toLowerCase();
}

function normalizeTableSql(sql) {
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(/^create table if not exists /i, "create table ")
    .toLowerCase();
}

async function serviceFixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_PERSONNEL_LIFECYCLE_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-personnel-lifecycle-"));
  const storage = createAmuStorage({
    rootDirectory: storageRoot,
    encryptionKeys: { test: crypto.createHash("sha256").update("personnel-lifecycle-test-key").digest() },
    activeKeyId: "test",
    scanner: async () => true,
  });
  const repository = createPersonnelLifecycleRepository(application.provider);
  const service = createPersonnelLifecycleService(repository, {
    protectJson: (value, context) => storage.protectRecord(JSON.stringify(value), context),
    parseProtectedJson: (value, context) => JSON.parse(storage.unprotectRecord(value, context)),
  });
  return {
    ...application,
    repository,
    service,
    storage,
    async close() {
      try {
        await application.provider.close();
      } finally {
        application.database.close();
        const resolvedRoot = path.resolve(storageRoot);
        if (resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
          fs.rmSync(resolvedRoot, { recursive: true, force: true });
        }
      }
    },
  };
}

test("Personalmodul-Datenfundament: Dokumentmutationen lesen ihr Ergebnis vor dem Commit", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "personnel-lifecycle.js"),
    "utf8",
  );
  const registerDocument = source.slice(
    source.indexOf("  async function registerDocument("),
    source.indexOf("  async function candidatePhotoFile("),
  );
  const addDocumentVersion = source.slice(
    source.indexOf("  async function addDocumentVersion("),
    source.indexOf("  async function listCandidates("),
  );

  assert.match(registerDocument, /registeredDocument = await serializeDocument\([\s\S]*transactionRepository\.getDocument/);
  assert.match(registerDocument, /\}, \{ isolation: "serializable" \}\);\s*return registeredDocument;/);
  assert.match(addDocumentVersion, /versionedDocument = await serializeDocument\([\s\S]*transactionRepository\.getDocument/);
  assert.match(addDocumentVersion, /\}, \{ isolation: "serializable" \}\);\s*return versionedDocument;/);
  assert.doesNotMatch(registerDocument, /return await repository\.getDocument/);
  assert.doesNotMatch(addDocumentVersion, /return await repository\.getDocument/);
});

test("Personalmodul-Datenfundament: jedes typisierte Statement besitzt genau eine SQLite-Bindung", () => {
  const statements = Object.values(PERSONNEL_LIFECYCLE_STATEMENTS);
  assert.equal(statements.length, 23);
  assert.equal(SQLITE_PERSONNEL_LIFECYCLE_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_PERSONNEL_LIFECYCLE_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_PERSONNEL_LIFECYCLE_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Personalmodul-Datenfundament: Repository reicht Transaktionsoptionen unverändert weiter", async () => {
  const context = await serviceFixture();
  try {
    await assert.rejects(
      context.repository.transaction(async (repository) => {
        await repository.insertCandidate({
          id: "read-only-candidate",
          protectedPayload: "test-only",
          actor: "TEST",
          occurredAt: "2026-08-01T12:00:00.000Z",
        });
      }, { readOnly: true }),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
    );
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 0);

    let callbackCalled = false;
    await assert.rejects(
      context.repository.transaction(async () => { callbackCalled = true; }, { unexpected: true }),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION,
    );
    assert.equal(callbackCalled, false);
  } finally {
    await context.close();
  }
});

test("Personalmodul-Datenfundament: Bewerber bleiben ohne Personalnummer und Historien unveränderbar", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    const absentInspection = inspectSqlitePersonnelLifecycleSchema(database);
    assert.equal(absentInspection.valid, false);
    assert.equal(absentInspection.absent, true);
    assert.deepEqual(absentInspection.missingTables, [...PERSONNEL_LIFECYCLE_TABLE_NAMES]);
    assert.deepEqual(absentInspection.invalidTables, []);
    ensureSqliteApplicationSchema(database);
    const tables = new Set(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map(({ name }) => name));
    for (const tableName of PERSONNEL_LIFECYCLE_TABLE_NAMES) {
      assert.equal(tables.has(tableName), true, tableName);
    }
    assert.deepEqual(
      PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS.map(({ name }) => name),
      [...PERSONNEL_LIFECYCLE_TABLE_NAMES],
    );
    const tableDefinitions = new Map(database.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'table'
    `).all().map(({ name, sql }) => [name, sql]));
    for (const definition of PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS) {
      assert.equal(
        normalizeTableSql(tableDefinitions.get(definition.name)),
        normalizeTableSql(definition.sql),
        definition.name,
      );
    }

    const candidateColumns = database.prepare("PRAGMA table_info(candidates)").all()
      .map(({ name }) => String(name));
    const applicationColumns = database.prepare("PRAGMA table_info(candidate_applications)").all()
      .map(({ name }) => String(name));
    assert.equal(candidateColumns.includes("personnel_number"), false);
    assert.equal(candidateColumns.includes("employee_number"), false);
    assert.equal(applicationColumns.includes("source"), false);
    assert.equal(
      database.prepare("PRAGMA foreign_key_list(candidate_applications)").all()
        .some(({ table, from, to, on_delete: onDelete }) => (
          table === "employees"
          && from === "owner_employee_number"
          && to === "personnel_number"
          && onDelete === "RESTRICT"
        )),
      true,
    );
    assert.deepEqual(
      database.prepare(`
        SELECT code, builtin, active
        FROM candidate_document_categories
        ORDER BY sort_order
      `).all().map((row) => ({ ...row })),
      [
        { code: "resume", builtin: 1, active: 1 },
        { code: "cover_letter", builtin: 1, active: 1 },
        { code: "certificate", builtin: 1, active: 1 },
        { code: "reference", builtin: 1, active: 1 },
        { code: "work_sample", builtin: 1, active: 1 },
        { code: "other", builtin: 1, active: 1 },
        { code: "profile_photo", builtin: 1, active: 1 },
      ],
    );
    assert.deepEqual(
      PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS.map(({ name }) => name),
      [...PERSONNEL_LIFECYCLE_TRIGGER_NAMES],
    );
    const triggers = new Map(database.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
    `).all().map(({ name, sql }) => [name, sql]));
    for (const definition of PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS) {
      assert.equal(
        normalizeTriggerSql(triggers.get(definition.name)),
        normalizeTriggerSql(definition.sql),
        definition.name,
      );
    }
    assert.deepEqual(inspectSqlitePersonnelLifecycleSchema(database), {
      valid: true,
      absent: false,
      issues: [],
      missingTables: [],
      invalidTables: [],
      missingTriggers: [],
      invalidTriggers: [],
    });
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: Startup-Migration sichert vor Reparatur und läuft idempotent", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    const initial = runMigrations(database);
    assert.equal(initial.personnelLifecycleMigrationRequired, true);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LIFECYCLE_MIGRATION_ID).count,
      1,
    );

    const malformedTriggerName = "trg_candidate_events_immutable_update";
    const expectedTrigger = PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS
      .find(({ name }) => name === malformedTriggerName);
    database.exec(`
      DROP TRIGGER ${malformedTriggerName};
      CREATE TRIGGER ${malformedTriggerName}
      BEFORE UPDATE ON candidate_events
      BEGIN
        SELECT 1;
      END;
    `);
    const malformedTriggerSql = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
    `).get(malformedTriggerName).sql;
    assert.notEqual(
      normalizeTriggerSql(malformedTriggerSql),
      normalizeTriggerSql(expectedTrigger.sql),
    );
    let backupObserved = false;
    const repaired = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup() {
        backupObserved = true;
        assert.equal(
          database.prepare(`
            SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
          `).get(PERSONNEL_LIFECYCLE_MIGRATION_ID).count,
          1,
        );
        assert.equal(
          normalizeTriggerSql(database.prepare(`
            SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
          `).get(malformedTriggerName).sql),
          normalizeTriggerSql(malformedTriggerSql),
        );
      },
    });
    assert.equal(backupObserved, true);
    assert.equal(repaired.personnelLifecycleMigrationRequired, true);
    assert.equal(
      normalizeTriggerSql(database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
      `).get(malformedTriggerName).sql),
      normalizeTriggerSql(expectedTrigger.sql),
    );

    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelLifecycleMigrationRequired, false);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LIFECYCLE_MIGRATION_ID).count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: bestehender v0.89-Katalog erhält Bewerberfoto erst nach Backup und eigener Migration", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    database.exec(`
      DELETE FROM schema_migrations
      WHERE id = '${PERSONNEL_LIFECYCLE_PROFILE_PHOTO_CATEGORY_MIGRATION_ID}';
      DELETE FROM candidate_document_categories WHERE id = 'profile-photo';
      INSERT INTO candidate_document_categories (
        id, code, label, default_visibility, retention_disposition,
        default_retention_days, transfer_eligible, active, builtin, sort_order
      ) VALUES (
        'custom-portfolio', 'custom_portfolio', 'Portfolio', 'recruiting',
        'manual_review', NULL, 0, 1, 0, 900
      );
      INSERT INTO candidates (
        id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'candidate-existing-v089', 'active', 'enc:v2:existing', 1,
        'PL-1', 'PL-1', '2026-08-25T08:00:00.000Z', '2026-08-25T08:00:00.000Z'
      );
    `);

    let backupObserved = false;
    const migrated = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup() {
        backupObserved = true;
        assert.equal(
          database.prepare("SELECT COUNT(*) AS count FROM candidate_document_categories WHERE id = 'profile-photo'")
            .get().count,
          0,
        );
        assert.equal(
          database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
            .get(PERSONNEL_LIFECYCLE_PROFILE_PHOTO_CATEGORY_MIGRATION_ID).count,
          0,
        );
        assert.equal(
          database.prepare("SELECT COUNT(*) AS count FROM candidates WHERE id = 'candidate-existing-v089'")
            .get().count,
          1,
        );
      },
    });

    assert.equal(backupObserved, true);
    assert.equal(migrated.personnelLifecycleProfilePhotoCategoryMigrationRequired, true);
    assert.equal(
      migrated.personnelLifecycleProfilePhotoCategoryCatalogBeforeMigration.state,
      "legacy",
    );
    assert.deepEqual(migrated.personnelLifecycleProfilePhotoCategoryMigrationResult, {
      migrated: true,
      deferred: false,
    });
    assert.deepEqual(
      {
        ...database.prepare(`
          SELECT id, code, label, default_visibility, retention_disposition,
                 default_retention_days, transfer_eligible, active, builtin, sort_order
          FROM candidate_document_categories
          WHERE id = 'profile-photo'
        `).get(),
      },
      {
        id: "profile-photo",
        code: "profile_photo",
        label: "Bewerberfoto",
        default_visibility: "scoped_leadership",
        retention_disposition: "manual_review",
        default_retention_days: null,
        transfer_eligible: 0,
        active: 1,
        builtin: 1,
        sort_order: 70,
      },
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM candidate_document_categories WHERE id = 'custom-portfolio'")
        .get().count,
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM candidates WHERE id = 'candidate-existing-v089'")
        .get().count,
      1,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LIFECYCLE_PROFILE_PHOTO_CATEGORY_MIGRATION_ID).count,
      1,
    );

    const catalogBeforeRepeat = database.prepare(`
      SELECT id, code, label, active, builtin, sort_order, created_at, updated_at
      FROM candidate_document_categories
      ORDER BY sort_order, id
    `).all().map((row) => ({ ...row }));
    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelLifecycleProfilePhotoCategoryMigrationRequired, false);
    assert.equal(
      repeated.personnelLifecycleProfilePhotoCategoryCatalogBeforeMigration.state,
      "current",
    );
    assert.deepEqual(repeated.personnelLifecycleProfilePhotoCategoryMigrationResult, {
      migrated: false,
      deferred: false,
    });
    assert.deepEqual(
      database.prepare(`
        SELECT id, code, label, active, builtin, sort_order, created_at, updated_at
        FROM candidate_document_categories
        ORDER BY sort_order, id
      `).all().map((row) => ({ ...row })),
      catalogBeforeRepeat,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: abweichende Bewerberfoto-Katalogzeile bricht nach Backup unverändert ab", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    database.exec(`
      DELETE FROM schema_migrations
      WHERE id = '${PERSONNEL_LIFECYCLE_PROFILE_PHOTO_CATEGORY_MIGRATION_ID}';
      UPDATE candidate_document_categories
      SET active = 0, updated_at = '2026-08-25T08:30:00.000Z'
      WHERE id = 'profile-photo';
    `);
    let backupObserved = false;
    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup() {
          backupObserved = true;
          assert.deepEqual(
            { ...database.prepare(`
              SELECT active, updated_at
              FROM candidate_document_categories
              WHERE id = 'profile-photo'
            `).get() },
            { active: 0, updated_at: "2026-08-25T08:30:00.000Z" },
          );
        },
      }),
      (error) => (
        error?.code === "PERSONNEL_LIFECYCLE_PROFILE_PHOTO_CATEGORY_MIGRATION_UNSAFE"
        && error?.details?.includes("profile-photo-reserved-row-conflict")
      ),
    );
    assert.equal(backupObserved, true);
    assert.deepEqual(
      { ...database.prepare(`
        SELECT active, updated_at
        FROM candidate_document_categories
        WHERE id = 'profile-photo'
      `).get() },
      { active: 0, updated_at: "2026-08-25T08:30:00.000Z" },
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LIFECYCLE_PROFILE_PHOTO_CATEGORY_MIGRATION_ID).count,
      0,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: leere abweichende Tabellen werden nach Backup sicher repariert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    database.exec("ALTER TABLE candidate_applications ADD COLUMN source TEXT");
    const malformedInspection = inspectSqlitePersonnelLifecycleSchema(database);
    assert.equal(malformedInspection.valid, false);
    assert.deepEqual(malformedInspection.invalidTables, ["candidate_applications"]);

    let backupObserved = false;
    const repaired = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup() {
        backupObserved = true;
        assert.equal(
          database.prepare("PRAGMA table_info(candidate_applications)").all()
            .some(({ name }) => name === "source"),
          true,
        );
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 0);
      },
    });
    assert.equal(backupObserved, true);
    assert.equal(repaired.personnelLifecycleMigrationRequired, true);
    assert.equal(
      database.prepare("PRAGMA table_info(candidate_applications)").all()
        .some(({ name }) => name === "source"),
      false,
    );
    assert.equal(inspectSqlitePersonnelLifecycleSchema(database).valid, true);
    const repairedTableSql = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidate_applications'
    `).get().sql;

    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelLifecycleMigrationRequired, false);
    assert.equal(
      normalizeTableSql(database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidate_applications'
      `).get().sql),
      normalizeTableSql(repairedTableSql),
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LIFECYCLE_MIGRATION_ID).count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: abweichende Tabellen mit Fachdaten brechen nach Backup unveraendert ab", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    database.exec(`
      ALTER TABLE candidate_applications ADD COLUMN source TEXT;
      INSERT INTO candidates (
        id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'candidate-schema-guard', 'active', 'enc:v2:schema-guard', 1,
        'HR-1', 'HR-1', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
      );
    `);

    let backupObserved = false;
    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup() {
          backupObserved = true;
          assert.equal(
            database.prepare("PRAGMA table_info(candidate_applications)").all()
              .some(({ name }) => name === "source"),
            true,
          );
          assert.equal(
            database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count,
            1,
          );
        },
      }),
      (error) => (
        error?.code === "PERSONNEL_LIFECYCLE_SCHEMA_DATA_PRESENT"
        && /enthaelt bereits Fachdaten/.test(error.message)
      ),
    );
    assert.equal(backupObserved, true);
    assert.equal(
      database.prepare("SELECT id FROM candidates WHERE id = ?")
        .get("candidate-schema-guard").id,
      "candidate-schema-guard",
    );
    assert.equal(
      database.prepare("PRAGMA table_info(candidate_applications)").all()
        .some(({ name }) => name === "source"),
      true,
    );
    assert.deepEqual(
      inspectSqlitePersonnelLifecycleSchema(database).invalidTables,
      ["candidate_applications"],
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LIFECYCLE_MIGRATION_ID).count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: leeres Teilschema wird nach Backup vollstaendig aufgebaut", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    database.exec("DROP TABLE candidate_events");
    const partialInspection = inspectSqlitePersonnelLifecycleSchema(database);
    assert.equal(partialInspection.absent, false);
    assert.deepEqual(partialInspection.missingTables, ["candidate_events"]);

    let backupObserved = false;
    const repaired = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup() {
        backupObserved = true;
        assert.deepEqual(
          inspectSqlitePersonnelLifecycleSchema(database).missingTables,
          ["candidate_events"],
        );
      },
    });
    assert.equal(backupObserved, true);
    assert.equal(repaired.personnelLifecycleMigrationRequired, true);
    assert.equal(inspectSqlitePersonnelLifecycleSchema(database).valid, true);

    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelLifecycleMigrationRequired, false);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LIFECYCLE_MIGRATION_ID).count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: Teilschema mit Fachdaten bleibt nach Backup unveraendert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    database.exec(`
      INSERT INTO candidates (
        id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'candidate-partial-schema', 'active', 'enc:v2:partial-schema', 1,
        'HR-1', 'HR-1', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
      );
      DROP TABLE candidate_events;
    `);
    const partialInspection = inspectSqlitePersonnelLifecycleSchema(database);
    assert.equal(partialInspection.absent, false);
    assert.deepEqual(partialInspection.missingTables, ["candidate_events"]);

    let backupObserved = false;
    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup() {
          backupObserved = true;
          assert.equal(
            database.prepare("SELECT id FROM candidates WHERE id = ?")
              .get("candidate-partial-schema").id,
            "candidate-partial-schema",
          );
          assert.equal(
            database.prepare(`
              SELECT COUNT(*) AS count
              FROM sqlite_master
              WHERE type = 'table' AND name = 'candidate_events'
            `).get().count,
            0,
          );
        },
      }),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_SCHEMA_DATA_PRESENT",
    );
    assert.equal(backupObserved, true);
    assert.equal(
      database.prepare("SELECT id FROM candidates WHERE id = ?")
        .get("candidate-partial-schema").id,
      "candidate-partial-schema",
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'candidate_events'
      `).get().count,
      0,
    );
    assert.deepEqual(
      inspectSqlitePersonnelLifecycleSchema(database).missingTables,
      ["candidate_events"],
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LIFECYCLE_MIGRATION_ID).count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: Backup- und Importprüfung erfassen Bewerberdokumente", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-personnel-backup-"));
  const databasePath = path.join(temporaryRoot, "personnel.sqlite");
  const application = openSqliteApplicationPersistence({
    databasePath,
    catalog: SQLITE_PERSONNEL_LIFECYCLE_CATALOG,
  });
  try {
    ensureSqliteApplicationSchema(application.database);
    application.database.exec(`
      INSERT INTO candidates (
        id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'candidate-backup', 'active', 'enc:v2:candidate', 1, 'HR-1', 'HR-1',
        '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
      );
      INSERT INTO candidate_documents (
        id, candidate_id, category_id, visibility, status, current_version,
        protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'document-backup', 'candidate-backup', 'resume', 'recruiting', 'active', 0,
        'enc:v2:document', 1, 'HR-1', 'HR-1',
        '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
      );
      INSERT INTO candidate_document_versions (
        document_id, version_number, storage_key, content_sha256, size_bytes,
        media_type, protected_payload, uploaded_by, created_at
      ) VALUES (
        'document-backup', 1,
        'ef/123e4567-e89b-42d3-8456-426614174002.amu',
        '${"d".repeat(64)}', 512, 'application/pdf', 'enc:v2:version', 'HR-1',
        '2026-08-01T10:00:00.000Z'
      );
    `);
  } finally {
    await application.provider.close();
    application.database.close();
  }

  try {
    assert.deepEqual(
      protectedStorageReferencesFromFile(databasePath),
      ["ef/123e4567-e89b-42d3-8456-426614174002.amu"],
    );
    const inspection = inspectSqliteImportFile(databasePath);
    assert.equal(inspection.candidateDocuments, 1);
    assert.equal(inspection.protected.candidates.length, 1);
    assert.equal(inspection.protected.candidateDocuments.length, 1);
    assert.equal(inspection.protected.candidateDocumentVersions.length, 1);
    assert.equal(inspection.protected.candidateApplications.length, 0);
    assert.equal(inspection.protected.candidateEvents.length, 0);
  } finally {
    const resolvedRoot = path.resolve(temporaryRoot);
    if (resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
  }
});

test("Personalmodul-Datenfundament: Recruitingprofil, Schnuppertermine und Bewertungen bleiben geschützt und integer", async () => {
  const fixture = await serviceFixture();
  try {
    fixture.database.prepare("INSERT INTO locations (id, name) VALUES ('05', 'Filiale 05'), ('18', 'Filiale 18')").run();
    fixture.database.prepare("INSERT INTO departments (id, location_id, name) VALUES (7, '18', 'Fotowelt')").run();
    const created = await fixture.service.createCandidate({
      dataProcessingAuthorizationConfirmed: true,
      profile: {
        firstName: "Mira",
        lastName: "Muster",
        phone: "+43 660 1234567",
        birthDate: "1998-02-28",
        citizenships: ["Österreich", "Deutschland", "Österreich"],
        address: {
          street: "Beispielweg 7",
          postalCode: "6020",
          city: "Innsbruck",
          state: "Tirol",
          country: "Österreich",
        },
      },
      application: {
        desiredRoleTitle: "Fotowelt",
        targetAreas: [
          { locationId: "05", preferred: false },
          { locationId: "18", departmentId: 7, preferred: true },
        ],
        trialAppointments: [
          {
            id: "trial-2026-09-01",
            dateFrom: "2026-09-01",
            dateTo: "2026-09-01",
            startTime: "09:00",
            endTime: "13:00",
            locationId: "05",
            status: "planned",
            note: "Erster Schnuppertag",
          },
          {
            id: "trial-2026-09-03",
            dateFrom: "2026-09-03",
            dateTo: "2026-09-03",
            startTime: "10:00",
            endTime: "17:30",
            locationId: "18",
            departmentId: 7,
            status: "planned",
            note: "Zweiter Schnuppertag",
          },
        ],
        competencyRatings: [
          { id: "professional", label: "Fachlich", rating: 1, note: "Basis" },
          { id: "team-fit", label: "Menschlich", rating: 2 },
          { id: "experience", label: "Erfahrung", rating: 3 },
          { id: "education", label: "Bildung", rating: 4 },
          { id: "languages", label: "Sprachen", rating: 5, note: "Mehrsprachig" },
        ],
        teamFeedback: [{
          id: "client-controlled-feedback",
          employeeNumber: "999",
          rating: 5,
          comment: "Darf nicht übernommen werden",
          recordedByEmployeeNumber: "999",
          recordedAt: "2020-01-01T00:00:00.000Z",
        }],
      },
    }, "FL-252");

    assert.equal(created.profile.email, "");
    assert.equal(created.profile.phone, "+43 660 1234567");
    assert.equal(created.profile.birthDate, "1998-02-28");
    assert.deepEqual(created.profile.citizenships, ["Österreich", "Deutschland"]);
    assert.deepEqual(created.profile.address, {
      street: "Beispielweg 7",
      supplement: "",
      postalCode: "6020",
      city: "Innsbruck",
      state: "Tirol",
      country: "Österreich",
    });

    const application = created.applications[0];
    assert.equal(application.desiredLocationId, "18");
    assert.equal(application.desiredDepartmentId, 7);
    assert.deepEqual(application.targetAreas, [
      { locationId: "05", departmentId: null, preferred: false },
      { locationId: "18", departmentId: 7, preferred: true },
    ]);
    assert.deepEqual(
      application.trialAppointments.map((appointment) => ({
        id: appointment.id,
        dateFrom: appointment.dateFrom,
        dateTo: appointment.dateTo,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        locationId: appointment.locationId,
        departmentId: appointment.departmentId,
      })),
      [
        {
          id: "trial-2026-09-01",
          dateFrom: "2026-09-01",
          dateTo: "2026-09-01",
          startTime: "09:00",
          endTime: "13:00",
          locationId: "05",
          departmentId: null,
        },
        {
          id: "trial-2026-09-03",
          dateFrom: "2026-09-03",
          dateTo: "2026-09-03",
          startTime: "10:00",
          endTime: "17:30",
          locationId: "18",
          departmentId: 7,
        },
      ],
    );
    assert.deepEqual(
      application.competencyRatings.map(({ id, rating }) => ({ id, rating })),
      [
        { id: "professional", rating: 1 },
        { id: "team-fit", rating: 2 },
        { id: "experience", rating: 3 },
        { id: "education", rating: 4 },
        { id: "languages", rating: 5 },
      ],
    );
    assert.equal(Object.hasOwn(application, "teamFeedback"), false);

    for (const invalidRating of [0, 6]) {
      await assert.rejects(
        fixture.service.updateApplication(created.id, application.id, {
          revision: application.revision,
          competencyRatings: [{
            id: `invalid-${invalidRating}`,
            label: "Ungültig",
            rating: invalidRating,
          }],
        }, "FL-252"),
        (error) => error?.code === "PERSONNEL_LIFECYCLE_INVALID",
      );
    }

    const withFeedback = await fixture.service.addTeamFeedback(
      created.id,
      application.id,
      {
        revision: application.revision,
        trialAppointmentId: "trial-2026-09-03",
        employeeNumber: "430",
        rating: 4,
        comment: "Konstruktive Rückmeldung aus dem Team",
        id: "client-must-not-control-id",
        recordedByEmployeeNumber: "client-must-not-control-actor",
        recordedAt: "2020-01-01T00:00:00.000Z",
      },
      "FL-252",
    );
    assert.equal(withFeedback.revision, 2);
    assert.equal(withFeedback.teamFeedback.length, 1);
    assert.match(withFeedback.teamFeedback[0].id, /^[0-9a-f-]{36}$/i);
    assert.notEqual(withFeedback.teamFeedback[0].id, "client-must-not-control-id");
    assert.equal(withFeedback.teamFeedback[0].trialAppointmentId, "trial-2026-09-03");
    assert.equal(withFeedback.teamFeedback[0].employeeNumber, "430");
    assert.equal(withFeedback.teamFeedback[0].rating, 4);
    assert.equal(withFeedback.teamFeedback[0].recordedByEmployeeNumber, "FL-252");
    assert.notEqual(withFeedback.teamFeedback[0].recordedAt, "2020-01-01T00:00:00.000Z");
    assert.deepEqual(withFeedback.targetAreas, application.targetAreas);
    assert.deepEqual(withFeedback.trialAppointments, application.trialAppointments);
    assert.deepEqual(withFeedback.competencyRatings, application.competencyRatings);

    const rawProtectedPayloads = [
      fixture.database.prepare("SELECT protected_payload FROM candidates WHERE id = ?")
        .get(created.id).protected_payload,
      fixture.database.prepare("SELECT protected_payload FROM candidate_applications WHERE id = ?")
        .get(application.id).protected_payload,
    ].map(String);
    assert.equal(rawProtectedPayloads.every((payload) => payload.startsWith("enc:v2:")), true);
    for (const protectedValue of [
      "1998-02-28",
      "Innsbruck",
      "Deutschland",
      "Erster Schnuppertag",
      "Mehrsprachig",
      "Konstruktive Rückmeldung aus dem Team",
    ]) {
      assert.equal(rawProtectedPayloads.some((payload) => payload.includes(protectedValue)), false);
    }

    assert.deepEqual(
      { ...await fixture.service.verifyIntegrity() },
      { candidates: 1, applications: 1, documents: 0, events: 3 },
    );

    const applicationContext = {
      namespace: "candidate-application",
      recordId: application.id,
      field: "payload",
      employeeNumber: `candidate:${created.id}`,
    };
    const storedApplication = fixture.database.prepare(`
      SELECT protected_payload FROM candidate_applications WHERE id = ?
    `).get(application.id);
    const tamperedPayload = JSON.parse(fixture.storage.unprotectRecord(
      storedApplication.protected_payload,
      applicationContext,
    ));
    tamperedPayload.competencyRatings[0].rating = 5;
    fixture.database.prepare(`
      UPDATE candidate_applications SET protected_payload = ? WHERE id = ?
    `).run(
      fixture.storage.protectRecord(JSON.stringify(tamperedPayload), applicationContext),
      application.id,
    );
    await assert.rejects(
      fixture.service.verifyIntegrity(),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_STATE_INTEGRITY_FAILED",
    );
  } finally {
    await fixture.close();
  }
});

test("Personalmodul-Datenfundament: zu großer Bewerbungszustand wird vor Persistenz und Audit abgewiesen", async () => {
  const fixture = await serviceFixture();
  try {
    const created = await fixture.service.createCandidate({
      dataProcessingAuthorizationConfirmed: true,
      profile: {
        firstName: "Grenze",
        lastName: "Bewerbung",
        phone: "+43 660 1234567",
      },
      application: { desiredRoleTitle: "Fotowelt" },
    }, "PL-1");
    const application = created.applications[0];
    const rowBefore = { ...fixture.database.prepare(`
      SELECT revision, protected_payload
      FROM candidate_applications
      WHERE id = ?
    `).get(application.id) };
    const eventCountBefore = fixture.database.prepare(`
      SELECT COUNT(*) AS count
      FROM candidate_events
      WHERE candidate_id = ?
    `).get(created.id).count;
    const competencyRatings = Array.from({ length: 40 }, (_, index) => ({
      id: `competency-${index}`,
      label: `Kompetenz ${index}`,
      rating: 3,
      note: "K".repeat(1000),
    }));
    const trialAppointments = Array.from({ length: 30 }, (_, index) => ({
      id: `trial-${index}`,
      dateFrom: "2026-09-01",
      dateTo: "2026-09-01",
      startTime: "09:00",
      endTime: "12:00",
      locationId: "18",
      departmentId: null,
      status: "planned",
      note: "T".repeat(1000),
    }));

    await assert.rejects(
      fixture.service.updateApplication(
        created.id,
        application.id,
        { revision: application.revision, competencyRatings, trialAppointments },
        "PL-1",
      ),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_APPLICATION_STATE_TOO_LARGE",
    );
    assert.deepEqual(
      { ...fixture.database.prepare(`
        SELECT revision, protected_payload
        FROM candidate_applications
        WHERE id = ?
      `).get(application.id) },
      rowBefore,
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_events
        WHERE candidate_id = ?
      `).get(created.id).count,
      eventCountBefore,
    );
  } finally {
    await fixture.close();
  }
});

test("Personalmodul-Datenfundament: bevorzugter Zielbereich und primärer Bewerbungsbereich bleiben eindeutig", async () => {
  const fixture = await serviceFixture();
  try {
    fixture.database.prepare("INSERT INTO locations (id, name) VALUES ('05', 'Filiale 05'), ('18', 'Filiale 18')").run();
    fixture.database.prepare(`
      INSERT INTO departments (id, location_id, name)
      VALUES (3, '05', 'Verkauf'), (7, '18', 'Fotowelt')
    `).run();
    for (const [index, targetAreas] of [
      [{ locationId: "05", departmentId: 3, preferred: false }],
      [
        { locationId: "05", departmentId: 3, preferred: true },
        { locationId: "18", departmentId: 7, preferred: true },
      ],
    ].entries()) {
      await assert.rejects(
        fixture.service.createCandidate({
          dataProcessingAuthorizationConfirmed: true,
          profile: {
            firstName: "Ungültig",
            lastName: `Zielbereich ${index + 1}`,
            phone: "+43 660 1234567",
          },
          application: { targetAreas },
        }, "PL-1"),
        (error) => error?.code === "PERSONNEL_LIFECYCLE_TARGET_AREA_PREFERRED_INVALID",
      );
    }
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 0);

    const created = await fixture.service.createCandidate({
      dataProcessingAuthorizationConfirmed: true,
      profile: {
        firstName: "Ziel",
        lastName: "Bereich",
        phone: "+43 660 1234567",
      },
      application: {
        desiredLocationId: "05",
        desiredDepartmentId: 3,
      },
    }, "PL-1");
    let application = created.applications[0];
    assert.deepEqual(application.targetAreas, [{
      locationId: "05",
      departmentId: 3,
      preferred: true,
    }]);

    application = await fixture.service.updateApplication(
      created.id,
      application.id,
      {
        revision: application.revision,
        targetAreas: [
          { locationId: "05", departmentId: 3, preferred: false },
          { locationId: "18", departmentId: 7, preferred: true },
        ],
      },
      "PL-1",
    );
    assert.equal(application.desiredLocationId, "18");
    assert.equal(application.desiredDepartmentId, 7);
    assert.equal(application.targetAreas.filter((area) => area.preferred).length, 1);

    application = await fixture.service.updateApplication(
      created.id,
      application.id,
      {
        revision: application.revision,
        desiredLocationId: "05",
        desiredDepartmentId: 3,
      },
      "PL-1",
    );
    assert.equal(application.desiredLocationId, "05");
    assert.equal(application.desiredDepartmentId, 3);
    assert.deepEqual(application.targetAreas, [
      { locationId: "05", departmentId: 3, preferred: true },
      { locationId: "18", departmentId: 7, preferred: false },
    ]);

    for (const targetAreas of [
      [{ locationId: "05", departmentId: 3, preferred: false }],
      [
        { locationId: "05", departmentId: 3, preferred: true },
        { locationId: "18", departmentId: 7, preferred: true },
      ],
    ]) {
      await assert.rejects(
        fixture.service.updateApplication(
          created.id,
          application.id,
          { revision: application.revision, targetAreas },
          "PL-1",
        ),
        (error) => error?.code === "PERSONNEL_LIFECYCLE_TARGET_AREA_PREFERRED_INVALID",
      );
    }
  } finally {
    await fixture.close();
  }
});

test("Personalmodul-Datenfundament: Service verschlüsselt Daten, erzwingt Revisionen und schützt Historien", async () => {
  const fixture = await serviceFixture();
  try {
    for (const submitted of [undefined, false, "true", 1]) {
      const input = {
        profile: {
          firstName: "Nicht",
          lastName: "Anlegen",
          email: "nicht-anlegen@example.invalid",
        },
      };
      if (submitted !== undefined) input.dataProcessingAuthorizationConfirmed = submitted;
      await assert.rejects(
        fixture.service.createCandidate(input, "HR-0"),
        (error) => error?.code === "PERSONNEL_LIFECYCLE_DATA_PROCESSING_AUTHORIZATION_REQUIRED",
      );
      assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 0);
      assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM candidate_applications").get().count, 0);
      assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM candidate_events").get().count, 0);
    }
    const created = await fixture.service.createCandidate({
      dataProcessingAuthorizationConfirmed: true,
      profile: {
        firstName: "Geheimname",
        lastName: "Beispiel",
        email: "bewerbung@example.invalid",
      },
      application: {
        desiredRoleTitle: "Verkauf",
        internalNotes: "nicht offenlegen",
        source: "Direktbewerbung",
      },
    }, "HR-1");
    assert.equal(created.profile.firstName, "Geheimname");
    assert.equal(created.applications.length, 1);
    assert.equal(created.applications[0].status, "new");
    assert.equal(created.history.length, 2);
    const creationEvent = created.history.find(({ eventType }) => eventType === "candidate_created");
    assert.deepEqual(creationEvent.detail.dataProcessingAuthorization, {
      confirmed: true,
      statementVersion: "candidate-data-processing-authorization-v1",
    });
    assert.equal(creationEvent.actorEmployeeNumber, "HR-1");
    assert.match(creationEvent.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const rawProtected = [
      ...fixture.database.prepare("SELECT protected_payload FROM candidates").all(),
      ...fixture.database.prepare("SELECT protected_payload FROM candidate_applications").all(),
      ...fixture.database.prepare("SELECT protected_payload FROM candidate_events").all(),
    ].map(({ protected_payload: payload }) => String(payload));
    assert.equal(rawProtected.every((payload) => payload.startsWith("enc:v2:")), true);
    assert.equal(rawProtected.some((payload) => payload.includes("Geheimname")), false);
    assert.equal(rawProtected.some((payload) => payload.includes("nicht offenlegen")), false);

    const updated = await fixture.service.updateCandidate(created.id, {
      revision: created.revision,
      profile: { firstName: "Neu", lastName: "Beispiel", email: "bewerbung@example.invalid" },
    }, "HR-2");
    assert.equal(updated.revision, 2);
    assert.equal(updated.profile.firstName, "Neu");

    const application = await fixture.service.transitionApplication(
      created.id,
      created.applications[0].id,
      { revision: created.applications[0].revision, status: "screening", reason: "Unterlagen vollständig" },
      "HR-2",
    );
    assert.equal(application.status, "screening");
    assert.equal(application.revision, 2);

    await assert.rejects(
      fixture.service.transitionApplication(created.id, application.id, {
        revision: application.revision,
        status: "rejected",
      }, "HR-2"),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_STATUS_REASON_REQUIRED",
    );

    const applicationUpdated = await fixture.service.updateApplication(
      created.id,
      application.id,
      {
        revision: application.revision,
        internalNotes: "nachvollziehbar geändert",
      },
      "HR-2",
    );
    assert.equal(applicationUpdated.revision, 3);
    const detailAfterApplicationUpdate = await fixture.service.getCandidate(created.id);
    const updateEvent = detailAfterApplicationUpdate.history
      .find(({ eventType }) => eventType === "application_updated");
    assert.deepEqual(updateEvent.detail.changedFields, ["internalNotes", "revision"]);
    assert.match(updateEvent.detail.previousStateSha256, /^[a-f0-9]{64}$/);
    assert.match(updateEvent.detail.stateSha256, /^[a-f0-9]{64}$/);

    const page = await fixture.service.listCandidates({ limit: "1", offset: "0" });
    assert.deepEqual(page.pagination, {
      limit: 1,
      offset: 0,
      hasMore: false,
      includeArchived: false,
    });
    assert.deepEqual(Object.keys(page.items[0].profile).sort(), [
      "email",
      "firstName",
      "lastName",
      "phone",
    ]);
    for (const field of [
      "internalRating",
      "internalNotes",
      "communicationNotes",
      "source",
      "tags",
    ]) assert.equal(Object.hasOwn(page.items[0].applications[0], field), false, field);
    await assert.rejects(
      fixture.service.listCandidates({ limit: 0 }),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_PAGINATION_INVALID",
    );

    await assert.rejects(
      fixture.service.updateApplication(created.id, application.id, {
        revision: 1,
        internalNotes: "veraltet",
      }, "HR-2"),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_REVISION_CONFLICT",
    );
    await assert.rejects(
      fixture.service.transitionApplication(created.id, application.id, {
        revision: applicationUpdated.revision,
        status: "converted",
      }, "HR-2"),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_CONVERSION_NOT_AVAILABLE",
    );

    const document = await fixture.service.registerDocument(created.id, {
      categoryId: "resume",
      applicationId: application.id,
      title: "Lebenslauf",
      visibility: "recruiting",
    }, {
      storageKey: "ab/123e4567-e89b-42d3-a456-426614174000.amu",
      contentSha256: "a".repeat(64),
      sizeBytes: 2048,
      mediaType: "application/pdf",
      originalFilename: "lebenslauf.pdf",
    }, "HR-2");
    assert.equal(document.currentVersion, 1);
    assert.equal(document.versions.length, 1);
    assert.equal(Object.hasOwn(document.versions[0], "storageKey"), false);

    const versioned = await fixture.service.addDocumentVersion(created.id, document.id, {
      storageKey: "cd/123e4567-e89b-42d3-b456-426614174001.amu",
      contentSha256: "b".repeat(64),
      sizeBytes: 4096,
      mediaType: "application/pdf",
      originalFilename: "lebenslauf-neu.pdf",
      note: "Aktualisiert",
    }, "HR-2");
    assert.equal(versioned.currentVersion, 2);
    assert.deepEqual(versioned.versions.map(({ versionNumber }) => versionNumber), [1, 2]);
    assert.equal(
      fixture.database.prepare("SELECT revision FROM candidate_documents WHERE id = ?")
        .get(document.id).revision,
      3,
    );

    assert.throws(
      () => fixture.database.prepare(`
        UPDATE candidate_document_versions SET size_bytes = 1
        WHERE document_id = ? AND version_number = 1
      `).run(document.id),
      /candidate document versions are immutable/,
    );
    assert.throws(
      () => fixture.database.prepare("DELETE FROM candidate_events WHERE candidate_id = ?")
        .run(created.id),
      /candidate events are immutable/,
    );

    assert.deepEqual(
      { ...await fixture.service.verifyIntegrity() },
      { candidates: 1, applications: 1, documents: 1, events: 7 },
    );

    fixture.database.exec("DROP TRIGGER trg_candidate_document_versions_immutable_update");
    fixture.database.prepare(`
      UPDATE candidate_document_versions SET storage_key = ?
      WHERE document_id = ? AND version_number = 1
    `).run("de/123e4567-e89b-42d3-8456-426614174003.amu", document.id);
    await assert.rejects(
      fixture.service.verifyIntegrity(),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_STATE_INTEGRITY_FAILED",
    );
    fixture.database.prepare(`
      UPDATE candidate_document_versions SET storage_key = ?
      WHERE document_id = ? AND version_number = 1
    `).run("ab/123e4567-e89b-42d3-a456-426614174000.amu", document.id);
    fixture.database.prepare(`
      UPDATE candidate_document_versions SET created_at = ?
      WHERE document_id = ? AND version_number = 1
    `).run("2026-08-01T23:59:59.000Z", document.id);
    await assert.rejects(
      fixture.service.verifyIntegrity(),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_STATE_INTEGRITY_FAILED",
    );
    fixture.database.prepare(`
      UPDATE candidate_document_versions SET created_at = ?
      WHERE document_id = ? AND version_number = 1
    `).run(document.versions[0].createdAt, document.id);

    fixture.database.prepare(`
      UPDATE candidate_applications SET status = 'first_interview' WHERE id = ?
    `).run(application.id);
    await assert.rejects(
      fixture.service.verifyIntegrity(),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_STATE_INTEGRITY_FAILED",
    );
    fixture.database.prepare(`
      UPDATE candidate_applications SET status = 'screening' WHERE id = ?
    `).run(application.id);

    fixture.database.exec("DROP TRIGGER trg_candidate_events_immutable_update");
    const finalEventRow = fixture.database.prepare(`
      SELECT * FROM candidate_events
      WHERE candidate_id = ?
      ORDER BY sequence_number DESC
      LIMIT 1
    `).get(created.id);
    const finalEventContext = {
      namespace: "candidate-event",
      recordId: finalEventRow.id,
      field: "payload",
      employeeNumber: `candidate:${created.id}`,
    };
    const forgedDetail = JSON.parse(fixture.storage.unprotectRecord(
      finalEventRow.protected_payload,
      finalEventContext,
    ));
    forgedDetail.previousStateSha256 = "f".repeat(64);
    const forgedProtectedPayload = fixture.storage.protectRecord(
      JSON.stringify(forgedDetail),
      finalEventContext,
    );
    const forgedReceipt = canonicalSha256({
      schemaVersion: 1,
      id: finalEventRow.id,
      candidateId: finalEventRow.candidate_id,
      sequenceNumber: finalEventRow.sequence_number,
      applicationId: finalEventRow.application_id || null,
      documentId: finalEventRow.document_id || null,
      eventType: finalEventRow.event_type,
      protectedPayload: forgedProtectedPayload,
      previousReceiptSha256: finalEventRow.previous_receipt_sha256,
      actorEmployeeNumber: finalEventRow.actor_employee_number,
      createdAt: finalEventRow.created_at,
    });
    fixture.database.prepare(`
      UPDATE candidate_events
      SET protected_payload = ?, receipt_sha256 = ?
      WHERE id = ?
    `).run(forgedProtectedPayload, forgedReceipt, finalEventRow.id);
    await assert.rejects(
      fixture.service.verifyIntegrity(),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_STATE_INTEGRITY_FAILED",
    );

    fixture.database.prepare(`
      UPDATE candidate_events SET receipt_sha256 = ?
      WHERE candidate_id = ? AND sequence_number = 1
    `).run("c".repeat(64), created.id);
    await assert.rejects(
      fixture.service.verifyIntegrity(),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_EVENT_INTEGRITY_FAILED",
    );
  } finally {
    await fixture.close();
  }
});

test("Personalmodul-Datenfundament: Startup sperrt bestehenden reservierten Systemprinzipal", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);
    database.exec(`
      DROP TRIGGER trg_employees_reserved_principal_insert;
      DROP TRIGGER trg_employees_reserved_principal_update;
    `);
    database.prepare(`
      INSERT INTO employees (personnel_number, full_name, nickname)
      VALUES (?, ?, ?)
    `).run("\tLoCaL\r\n", "Bestehender Konflikt", "Konflikt");

    assert.throws(
      () => runMigrations(database, { databaseExistedBeforeOpen: true }),
      (error) => (
        error?.code === "EMPLOYEE_PRINCIPAL_RESERVED"
        && /reservierte Personalnummer local/.test(error.message)
      ),
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM employees
        WHERE LOWER(TRIM(
          personnel_number,
          CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13) || CHAR(32)
        )) = 'local'
      `).get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Personalmodul-Datenfundament: Importpruefung sperrt reservierten Systemprinzipal read-only", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-local-import-"));
  const databasePath = path.join(temporaryRoot, "reserved-local.db");
  const database = openSqliteLegacyDatabase(databasePath);
  try {
    ensureSqliteApplicationSchema(database);
    database.exec(`
      DROP TRIGGER trg_employees_reserved_principal_insert;
      DROP TRIGGER trg_employees_reserved_principal_update;
    `);
    database.prepare(`
      INSERT INTO employees (personnel_number, full_name, nickname)
      VALUES (?, ?, ?)
    `).run("\tLoCaL\r\n", "Importkonflikt", "Konflikt");
  } finally {
    database.close();
  }

  try {
    const before = fs.readFileSync(databasePath);
    const inspection = inspectSqliteImportFile(databasePath);
    assert.equal(inspection.protectedInspectionError, true);
    assert.deepEqual(fs.readFileSync(databasePath), before);
  } finally {
    const resolvedRoot = path.resolve(temporaryRoot);
    if (resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
  }
});
