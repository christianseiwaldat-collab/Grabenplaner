"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION,
  PERSONNEL_LEARNING_FOUNDATION_MIGRATION_ID,
  PERSONNEL_LEARNING_INDEX_NAMES,
  PERSONNEL_LEARNING_TABLE_NAMES,
  PERSONNEL_LEARNING_TRIGGER_NAMES,
  inspectSqlitePersonnelLearningRows,
  inspectSqlitePersonnelLearningSchema,
  moduleEventReceiptSha256,
  moduleReceiptSha256,
  moduleVersionReceiptSha256,
  sha256Text,
} = require("../lib/persistence/sqlite/operations/personnel-learning-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

const LOCATION_A = "learning-location-a";
const LOCATION_B = "learning-location-b";
const DEPARTMENT_A = 92801;
const TARGET_EMPLOYEE = "LEARNING-TARGET-1";

function runMigrations(database, {
  databaseExistedBeforeOpen = false,
  onBackup = () => {},
} = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.92.8-learning-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function insertScopes(database) {
  database.prepare(`
    INSERT OR IGNORE INTO locations (id, name, active)
    VALUES (?, 'Lernstandort A', 1)
  `).run(LOCATION_A);
  database.prepare(`
    INSERT OR IGNORE INTO locations (id, name, active)
    VALUES (?, 'Lernstandort B', 1)
  `).run(LOCATION_B);
  database.prepare(`
    INSERT OR IGNORE INTO departments (id, location_id, name, active)
    VALUES (?, ?, 'Lernabteilung A', 1)
  `).run(DEPARTMENT_A, LOCATION_A);
}

function insertPortalTarget(database) {
  insertScopes(database);
  database.prepare(`
    INSERT OR IGNORE INTO employees (
      personnel_number, full_name, nickname, home_location_id, active
    ) VALUES (?, 'Lernziel Person', 'Lernziel', ?, 1)
  `).run(TARGET_EMPLOYEE, LOCATION_A);
  database.prepare(`
    INSERT OR IGNORE INTO portal_users (
      employee_number, password_hash, role, active, must_change_password
    ) VALUES (?, 'test-only', 'department_manager', 1, 0)
  `).run(TARGET_EMPLOYEE);
}

function insertModule(database, suffix = "base") {
  const moduleRow = {
    id: `learning-module-${suffix}`,
    module_code: `LEARNING-${suffix}`,
    module_type: "training",
    created_by: "HR-LEARNING",
    created_at: "2026-08-18T08:00:00.000Z",
  };
  moduleRow.receipt_sha256 = moduleReceiptSha256(moduleRow);
  database.prepare(`
    INSERT INTO personnel_learning_modules (
      id, module_code, module_type, receipt_sha256, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    moduleRow.id,
    moduleRow.module_code,
    moduleRow.module_type,
    moduleRow.receipt_sha256,
    moduleRow.created_by,
    moduleRow.created_at,
  );

  const eventPayload = { source: "standalone", schemaVersion: 1 };
  const eventPayloadJson = JSON.stringify(eventPayload);
  const eventRow = {
    id: `learning-event-${suffix}-1`,
    module_id: moduleRow.id,
    sequence_number: 1,
    event_type: "created",
    module_version_number: null,
    event_payload_sha256: canonicalSha256(eventPayload),
    previous_receipt_sha256: "",
    actor_id: "HR-LEARNING",
    occurred_at: "2026-08-18T08:00:00.000Z",
  };
  eventRow.receipt_sha256 = moduleEventReceiptSha256(eventRow);
  database.prepare(`
    INSERT INTO personnel_learning_module_events (
      id, module_id, sequence_number, event_type, module_version_number,
      event_payload_json, event_payload_sha256, previous_receipt_sha256,
      receipt_sha256, actor_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventRow.id,
    eventRow.module_id,
    eventRow.sequence_number,
    eventRow.event_type,
    eventRow.module_version_number,
    eventPayloadJson,
    eventRow.event_payload_sha256,
    eventRow.previous_receipt_sha256,
    eventRow.receipt_sha256,
    eventRow.actor_id,
    eventRow.occurred_at,
  );
  return { moduleRow, lastEvent: eventRow };
}

function versionRow({ moduleId, versionNumber = 1, previousReceiptSha256 = "" } = {}) {
  const content = {
    summary: "Testinhalt",
    blocks: [{ type: "text", text: "Testinhalt" }],
  };
  const contentJson = JSON.stringify(content);
  const scopeSnapshot = {
    type: "department",
    locationId: LOCATION_A,
    departmentId: DEPARTMENT_A,
  };
  const scopeSnapshotJson = JSON.stringify(scopeSnapshot);
  const row = {
    module_id: moduleId,
    version_number: versionNumber,
    title: `Lernversion ${versionNumber}`,
    content_json: contentJson,
    content_sha256: canonicalSha256(content),
    scope_type: "department",
    scope_location_id: LOCATION_A,
    scope_department_id: DEPARTMENT_A,
    scope_snapshot_json: scopeSnapshotJson,
    scope_snapshot_sha256: canonicalSha256(scopeSnapshot),
    previous_receipt_sha256: previousReceiptSha256,
    created_by: "HR-LEARNING",
    created_at: `2026-08-18T08:0${versionNumber}:00.000Z`,
  };
  row.receipt_sha256 = moduleVersionReceiptSha256(row);
  return row;
}

function insertVersion(database, row) {
  database.prepare(`
    INSERT INTO personnel_learning_module_versions (
      module_id, version_number, title, content_json, content_sha256,
      scope_type, scope_location_id, scope_department_id, scope_snapshot_json,
      scope_snapshot_sha256, previous_receipt_sha256, receipt_sha256,
      created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.module_id,
    row.version_number,
    row.title,
    row.content_json,
    row.content_sha256,
    row.scope_type,
    row.scope_location_id,
    row.scope_department_id,
    row.scope_snapshot_json,
    row.scope_snapshot_sha256,
    row.previous_receipt_sha256,
    row.receipt_sha256,
    row.created_by,
    row.created_at,
  );
}

function insertVersionAddedEvent(database, { moduleId, versionNumber, previousEvent }) {
  const eventPayload = { versionNumber, schemaVersion: 1 };
  const eventPayloadJson = JSON.stringify(eventPayload);
  const row = {
    id: `learning-event-${moduleId}-${versionNumber + 1}`,
    module_id: moduleId,
    sequence_number: Number(previousEvent.sequence_number) + 1,
    event_type: "version_added",
    module_version_number: versionNumber,
    event_payload_sha256: canonicalSha256(eventPayload),
    previous_receipt_sha256: previousEvent.receipt_sha256,
    actor_id: "HR-LEARNING",
    occurred_at: `2026-08-18T08:1${versionNumber}:00.000Z`,
  };
  row.receipt_sha256 = moduleEventReceiptSha256(row);
  database.prepare(`
    INSERT INTO personnel_learning_module_events (
      id, module_id, sequence_number, event_type, module_version_number,
      event_payload_json, event_payload_sha256, previous_receipt_sha256,
      receipt_sha256, actor_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.module_id,
    row.sequence_number,
    row.event_type,
    row.module_version_number,
    eventPayloadJson,
    row.event_payload_sha256,
    row.previous_receipt_sha256,
    row.receipt_sha256,
    row.actor_id,
    row.occurred_at,
  );
  return row;
}

function insertCompleteModule(database, suffix = "complete") {
  insertScopes(database);
  const fixture = insertModule(database, suffix);
  const version = versionRow({ moduleId: fixture.moduleRow.id });
  insertVersion(database, version);
  const lastEvent = insertVersionAddedEvent(database, {
    moduleId: fixture.moduleRow.id,
    versionNumber: 1,
    previousEvent: fixture.lastEvent,
  });
  return { ...fixture, version, lastEvent };
}

test("Lernmodul-Block 1: vier eigenstaendige Tabellen werden ohne O6-/Prozess-Backfill angelegt", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);
    assert.deepEqual(PERSONNEL_LEARNING_TABLE_NAMES, [
      "personnel_learning_modules",
      "personnel_learning_module_versions",
      "personnel_learning_module_events",
      "personnel_learning_permission_denial_authorities",
    ]);
    assert.equal(inspectSqlitePersonnelLearningSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLearningRows(database).valid, true);
    assert.equal(PERSONNEL_LEARNING_TRIGGER_NAMES.length >= 10, true);
    assert.equal(PERSONNEL_LEARNING_INDEX_NAMES.length, 5);

    database.prepare(`
      INSERT INTO custom_processes (
        id, title, category, scope_type, trigger_type, status, created_by, updated_by
      ) VALUES (
        'legacy-training-process', 'Legacy Schulung', 'other', 'company',
        'manual', 'active', 'TEST', 'TEST'
      )
    `).run();
    ensureSqliteApplicationSchema(database);
    for (const tableName of [
      "personnel_learning_modules",
      "personnel_learning_module_versions",
      "personnel_learning_module_events",
    ]) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count,
        0,
        tableName,
      );
      assert.equal(
        database.prepare(`PRAGMA foreign_key_list("${tableName}")`).all()
          .some(({ table }) => String(table).startsWith("custom_process")),
        false,
        tableName,
      );
    }
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    database.close();
  }
});

test("Lernmodul-Block 1: kanonische JSON-Belege bleiben nach Speicherung und Neustart gültig", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const fixture = insertCompleteModule(database, "canonical-restart");
    const storedVersion = database.prepare(`
      SELECT content_json, content_sha256, scope_snapshot_json, scope_snapshot_sha256
      FROM personnel_learning_module_versions
      WHERE module_id = ? AND version_number = 1
    `).get(fixture.moduleRow.id);
    const storedEvents = database.prepare(`
      SELECT event_payload_json, event_payload_sha256
      FROM personnel_learning_module_events
      WHERE module_id = ?
      ORDER BY sequence_number
    `).all(fixture.moduleRow.id);

    assert.notEqual(sha256Text(storedVersion.content_json), storedVersion.content_sha256);
    assert.notEqual(
      sha256Text(storedVersion.scope_snapshot_json),
      storedVersion.scope_snapshot_sha256,
    );
    assert.equal(
      storedEvents.every((event) => sha256Text(event.event_payload_json)
        !== event.event_payload_sha256),
      true,
    );
    assert.equal(inspectSqlitePersonnelLearningRows(database).valid, true);

    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelLearningFoundationMigrationRequired, false);
    assert.equal(inspectSqlitePersonnelLearningRows(database).valid, true);
  } finally {
    database.close();
  }
});

test("Lernmodul-Block 1: Versionen und Ereignisse erzwingen Scope, Sequenz, Hashkette und Unveraenderbarkeit", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);
    insertScopes(database);
    const fixture = insertModule(database, "guards");

    const skippedVersion = versionRow({ moduleId: fixture.moduleRow.id, versionNumber: 2 });
    assert.throws(() => insertVersion(database, skippedVersion), /version chain is invalid/);

    const invalidScope = versionRow({ moduleId: fixture.moduleRow.id });
    invalidScope.scope_location_id = LOCATION_B;
    invalidScope.scope_snapshot_json = JSON.stringify({
      type: "department",
      locationId: LOCATION_B,
      departmentId: DEPARTMENT_A,
    });
    invalidScope.scope_snapshot_sha256 = sha256Text(invalidScope.scope_snapshot_json);
    invalidScope.receipt_sha256 = moduleVersionReceiptSha256(invalidScope);
    assert.throws(() => insertVersion(database, invalidScope), /version scope is invalid/);

    const version = versionRow({ moduleId: fixture.moduleRow.id });
    insertVersion(database, version);
    assert.throws(
      () => database.prepare(`
        UPDATE departments SET location_id = ? WHERE id = ?
      `).run(LOCATION_B, DEPARTMENT_A),
      /module version department location is referenced/,
    );
    assert.equal(
      database.prepare("SELECT location_id FROM departments WHERE id = ?")
        .get(DEPARTMENT_A).location_id,
      LOCATION_A,
    );
    const badSecondVersion = versionRow({
      moduleId: fixture.moduleRow.id,
      versionNumber: 2,
      previousReceiptSha256: "0".repeat(64),
    });
    assert.throws(() => insertVersion(database, badSecondVersion), /version chain is invalid/);

    assert.throws(() => {
      database.prepare(`
        INSERT INTO personnel_learning_module_events (
          id, module_id, sequence_number, event_type, module_version_number,
          event_payload_json, event_payload_sha256, previous_receipt_sha256,
          receipt_sha256, actor_id, occurred_at
        ) VALUES (?, ?, 2, 'version_added', 1, '{}', ?, ?, ?, 'HR-LEARNING', ?)
      `).run(
        "bad-chain-event",
        fixture.moduleRow.id,
        sha256Text("{}"),
        "0".repeat(64),
        "1".repeat(64),
        "2026-08-18T08:11:00.000Z",
      );
    }, /event chain is invalid/);
    assert.throws(() => {
      database.prepare(`
        INSERT INTO personnel_learning_module_events (
          id, module_id, sequence_number, event_type, module_version_number,
          event_payload_json, event_payload_sha256, previous_receipt_sha256,
          receipt_sha256, actor_id, occurred_at
        ) VALUES (?, ?, 2, 'published', 1, '{}', ?, ?, ?, 'HR-LEARNING', ?)
      `).run(
        "premature-published-event",
        fixture.moduleRow.id,
        sha256Text("{}"),
        fixture.lastEvent.receipt_sha256,
        "2".repeat(64),
        "2026-08-18T08:11:00.000Z",
      );
    }, /event chain is invalid/);

    insertVersionAddedEvent(database, {
      moduleId: fixture.moduleRow.id,
      versionNumber: 1,
      previousEvent: fixture.lastEvent,
    });
    assert.equal(inspectSqlitePersonnelLearningRows(database).valid, true);

    assert.throws(
      () => database.prepare(`
        UPDATE personnel_learning_modules SET module_code = 'CHANGED' WHERE id = ?
      `).run(fixture.moduleRow.id),
      /modules are immutable/,
    );
    assert.throws(
      () => database.prepare(`
        UPDATE personnel_learning_module_versions SET title = 'Changed'
        WHERE module_id = ? AND version_number = 1
      `).run(fixture.moduleRow.id),
      /versions are immutable/,
    );
    assert.throws(
      () => database.prepare(`
        DELETE FROM personnel_learning_module_events WHERE module_id = ?
      `).run(fixture.moduleRow.id),
      /events are immutable/,
    );
  } finally {
    database.close();
  }
});

test("Lernmodul-Block 1: Scope-Drift mit fachfremder Abteilung bleibt auch ohne Trigger fail-closed", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);
    insertScopes(database);
    const fixture = insertModule(database, "scope-drift");
    database.exec("DROP TRIGGER trg_personnel_learning_module_versions_scope");
    const invalidScope = versionRow({ moduleId: fixture.moduleRow.id });
    invalidScope.scope_location_id = LOCATION_B;
    invalidScope.scope_snapshot_json = JSON.stringify({
      type: "department",
      locationId: LOCATION_B,
      departmentId: DEPARTMENT_A,
    });
    invalidScope.scope_snapshot_sha256 = sha256Text(invalidScope.scope_snapshot_json);
    invalidScope.receipt_sha256 = moduleVersionReceiptSha256(invalidScope);
    insertVersion(database, invalidScope);
    insertVersionAddedEvent(database, {
      moduleId: fixture.moduleRow.id,
      versionNumber: 1,
      previousEvent: fixture.lastEvent,
    });

    assert.equal(
      inspectSqlitePersonnelLearningRows(database).issues.includes(
        `module-version-scope-invalid:${fixture.moduleRow.id}:1`,
      ),
      true,
    );
    let backupObserved = false;
    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup() { backupObserved = true; },
      }),
      (error) => error?.code === "PERSONNEL_LEARNING_FOUNDATION_SCHEMA_DATA_PRESENT",
    );
    assert.equal(backupObserved, true);
    assert.equal(
      database.prepare(`
        SELECT scope_location_id
        FROM personnel_learning_module_versions
        WHERE module_id = ? AND version_number = 1
      `).get(fixture.moduleRow.id).scope_location_id,
      LOCATION_B,
    );
  } finally {
    database.close();
  }
});

test("Lernmodul-Block 1: Denial-Provenienz ist permissiongebunden, scoped und revisionskontrolliert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    ensureSqliteApplicationSchema(database);
    insertPortalTarget(database);
    const insertAuthority = database.prepare(`
      INSERT INTO personnel_learning_permission_denial_authorities (
        employee_number, permission, authority_level, scope_location_id,
        denied_by, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, 'MANAGER-1', ?, ?, 1)
    `);
    assert.throws(
      () => insertAuthority.run(
        TARGET_EMPLOYEE,
        PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION,
        "manager",
        LOCATION_A,
        "2026-08-18T09:00:00.000Z",
        "2026-08-18T09:00:00.000Z",
      ),
      /FOREIGN KEY constraint failed/,
    );

    database.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, ?, 'MANAGER-1')
    `).run(TARGET_EMPLOYEE, PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION);
    assert.deepEqual(inspectSqlitePersonnelLearningRows(database).issues, [
      `permission-denial-authority-missing:${TARGET_EMPLOYEE}`,
    ]);
    assert.throws(
      () => insertAuthority.run(
        TARGET_EMPLOYEE,
        PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION,
        "manager",
        "",
        "2026-08-18T09:00:00.000Z",
        "2026-08-18T09:00:00.000Z",
      ),
      /denial authority is invalid|CHECK constraint failed/,
    );
    assert.throws(
      () => insertAuthority.run(
        TARGET_EMPLOYEE,
        PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION,
        "manager",
        "missing-location",
        "2026-08-18T09:00:00.000Z",
        "2026-08-18T09:00:00.000Z",
      ),
      /denial authority is invalid/,
    );
    insertAuthority.run(
      TARGET_EMPLOYEE,
      PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION,
      "manager",
      LOCATION_A,
      "2026-08-18T09:00:00.000Z",
      "2026-08-18T09:00:00.000Z",
    );
    assert.equal(inspectSqlitePersonnelLearningRows(database).valid, true);

    assert.throws(
      () => database.prepare(`
        DELETE FROM portal_permission_denials
        WHERE employee_number = ? AND permission = ?
      `).run(TARGET_EMPLOYEE, PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare(`
        UPDATE personnel_learning_permission_denial_authorities
        SET authority_level = 'pl_plus', scope_location_id = '', updated_at = ?
        WHERE employee_number = ? AND permission = ?
      `).run(
        "2026-08-18T09:01:00.000Z",
        TARGET_EMPLOYEE,
        PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION,
      ),
      /authority revision is invalid/,
    );
    database.prepare(`
      UPDATE personnel_learning_permission_denial_authorities
      SET authority_level = 'pl_plus', scope_location_id = '',
          updated_at = ?, revision = revision + 1
      WHERE employee_number = ? AND permission = ?
    `).run(
      "2026-08-18T09:01:00.000Z",
      TARGET_EMPLOYEE,
      PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION,
    );
    assert.deepEqual(
      { ...database.prepare(`
        SELECT authority_level, scope_location_id, revision
        FROM personnel_learning_permission_denial_authorities
        WHERE employee_number = ? AND permission = ?
      `).get(TARGET_EMPLOYEE, PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION) },
      { authority_level: "pl_plus", scope_location_id: "", revision: 2 },
    );
    assert.equal(inspectSqlitePersonnelLearningRows(database).valid, true);
  } finally {
    database.close();
  }
});

test("Lernmodul-Block 1: Startup-Migration sichert, markiert, repariert leer und bleibt idempotent", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    const initial = runMigrations(database);
    assert.equal(initial.personnelLearningFoundationMigrationRequired, true);
    assert.equal(initial.personnelLearningFoundationMigrationId, PERSONNEL_LEARNING_FOUNDATION_MIGRATION_ID);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LEARNING_FOUNDATION_MIGRATION_ID).count,
      1,
    );

    const triggerName = "trg_personnel_learning_module_events_chain";
    database.exec(`
      DROP TRIGGER ${triggerName};
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON personnel_learning_module_events
      BEGIN
        SELECT 1;
      END;
    `);
    assert.deepEqual(inspectSqlitePersonnelLearningSchema(database).invalidTriggers, [triggerName]);
    let backupObserved = false;
    const repaired = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup() {
        backupObserved = true;
        assert.deepEqual(
          inspectSqlitePersonnelLearningSchema(database).invalidTriggers,
          [triggerName],
        );
      },
    });
    assert.equal(backupObserved, true);
    assert.equal(repaired.personnelLearningFoundationMigrationRequired, true);
    assert.equal(inspectSqlitePersonnelLearningSchema(database).valid, true);

    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelLearningFoundationMigrationRequired, false);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
        .get(PERSONNEL_LEARNING_FOUNDATION_MIGRATION_ID).count,
      1,
    );
  } finally {
    database.close();
  }
});

test("Lernmodul-Block 1: Startup ergaenzt den Abteilungsreferenz-Trigger datenbewahrend und idempotent", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const fixture = insertCompleteModule(database, "department-trigger-upgrade");
    const triggerName = "trg_personnel_learning_department_location_update";
    database.exec(`DROP TRIGGER ${triggerName}`);
    assert.deepEqual(inspectSqlitePersonnelLearningSchema(database).missingTriggers, [triggerName]);

    let backupObserved = false;
    const repaired = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup() {
        backupObserved = true;
        assert.equal(
          database.prepare(`
            SELECT COUNT(*) AS count
            FROM personnel_learning_module_versions
            WHERE module_id = ?
          `).get(fixture.moduleRow.id).count,
          1,
        );
      },
    });
    assert.equal(backupObserved, true);
    assert.equal(repaired.personnelLearningFoundationMigrationRequired, true);
    assert.equal(inspectSqlitePersonnelLearningSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLearningRows(database).valid, true);
    assert.equal(
      database.prepare("SELECT location_id FROM departments WHERE id = ?")
        .get(DEPARTMENT_A).location_id,
      LOCATION_A,
    );

    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelLearningFoundationMigrationRequired, false);
  } finally {
    database.close();
  }
});

test("Lernmodul-Block 1: bestehender Abteilungs-Scope-Drift bleibt beim Startup fail-closed", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const fixture = insertCompleteModule(database, "department-scope-drift");
    const triggerName = "trg_personnel_learning_department_location_update";
    database.exec(`DROP TRIGGER ${triggerName}`);
    database.prepare("UPDATE departments SET location_id = ? WHERE id = ?")
      .run(LOCATION_B, DEPARTMENT_A);
    assert.equal(
      inspectSqlitePersonnelLearningRows(database).issues.includes(
        `module-version-scope-invalid:${fixture.moduleRow.id}:1`,
      ),
      true,
    );

    let backupObserved = false;
    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup() { backupObserved = true; },
      }),
      (error) => error?.code === "PERSONNEL_LEARNING_FOUNDATION_SCHEMA_DATA_PRESENT",
    );
    assert.equal(backupObserved, true);
    assert.equal(
      database.prepare("SELECT location_id FROM departments WHERE id = ?")
        .get(DEPARTMENT_A).location_id,
      LOCATION_B,
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'trigger' AND name = ?
      `).get(triggerName).count,
      0,
    );
  } finally {
    database.close();
  }
});

test("Lernmodul-Block 1: Startup bricht bei Schemadrift mit Fachdaten und fehlender Provenienz fail-closed ab", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const fixture = insertCompleteModule(database, "startup-guard");
    database.exec("ALTER TABLE personnel_learning_modules ADD COLUMN legacy_source TEXT");
    let backupObserved = false;
    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup() {
          backupObserved = true;
          assert.equal(
            database.prepare("SELECT id FROM personnel_learning_modules WHERE id = ?")
              .get(fixture.moduleRow.id).id,
            fixture.moduleRow.id,
          );
        },
      }),
      (error) => error?.code === "PERSONNEL_LEARNING_FOUNDATION_SCHEMA_DATA_PRESENT",
    );
    assert.equal(backupObserved, true);
    assert.equal(
      database.prepare("PRAGMA table_info(personnel_learning_modules)").all()
        .some(({ name }) => name === "legacy_source"),
      true,
    );
  } finally {
    database.close();
  }

  const missingProvenanceDatabase = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(missingProvenanceDatabase);
    insertPortalTarget(missingProvenanceDatabase);
    missingProvenanceDatabase.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, ?, 'PL-PLUS-1')
    `).run(TARGET_EMPLOYEE, PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION);
    let backupObserved = false;
    assert.throws(
      () => runMigrations(missingProvenanceDatabase, {
        databaseExistedBeforeOpen: true,
        onBackup() {
          backupObserved = true;
          assert.deepEqual(inspectSqlitePersonnelLearningRows(missingProvenanceDatabase).issues, [
            `permission-denial-authority-missing:${TARGET_EMPLOYEE}`,
          ]);
        },
      }),
      (error) => error?.code === "PERSONNEL_LEARNING_FOUNDATION_SCHEMA_DATA_PRESENT",
    );
    assert.equal(backupObserved, true);
    assert.equal(
      missingProvenanceDatabase.prepare(`
        SELECT COUNT(*) AS count
        FROM portal_permission_denials
        WHERE employee_number = ? AND permission = ?
      `).get(TARGET_EMPLOYEE, PERSONNEL_LEARNING_CROSS_LOCATION_PERMISSION).count,
      1,
    );
  } finally {
    missingProvenanceDatabase.close();
  }
});
