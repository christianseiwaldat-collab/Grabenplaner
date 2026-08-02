"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createOrganizationPersonnelRepository,
} = require("../lib/persistence/repositories/organization-personnel");
const {
  createPersonnelLifecycleRepository,
} = require("../lib/persistence/repositories/personnel-lifecycle");
const {
  createPortalAccessRepository,
} = require("../lib/persistence/repositories/portal-access");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../lib/persistence/sqlite/application-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  inspectSqliteImportFile,
} = require("../lib/persistence/sqlite/operations/database-import");
const {
  protectedSicknessAmuStorageSnapshotFromDatabase,
} = require("../lib/persistence/sqlite/operations/maintenance");
const {
  PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION,
  PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS,
  ensureSqlitePersonnelLifecycleSchema,
  ensureSqlitePersonnelLifecycleScopedRightsSchema,
  inspectSqlitePersonnelLifecycleScopedRightsRows,
  inspectSqlitePersonnelLifecycleScopedRightsSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteApplicationPersistence,
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
    appVersion: "0.89-personnel-scoped-rights-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function dropScopedRightsSchema(database) {
  for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
  database.exec("DROP TABLE IF EXISTS portal_permission_scope_grants");
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID);
}

function insertOrganizationFixture(database, suffix = "one") {
  const locationId = `scope-${suffix}`;
  const otherLocationId = `scope-${suffix}-other`;
  const employeeNumber = `scope-employee-${suffix}`;
  database.prepare("INSERT INTO locations (id, name) VALUES (?, ?)")
    .run(locationId, `Scope ${suffix}`);
  database.prepare("INSERT INTO locations (id, name) VALUES (?, ?)")
    .run(otherLocationId, `Scope ${suffix} Other`);
  const departmentId = Number(database.prepare(`
    INSERT INTO departments (location_id, name) VALUES (?, ?)
  `).run(locationId, `Department ${suffix}`).lastInsertRowid);
  const otherDepartmentId = Number(database.prepare(`
    INSERT INTO departments (location_id, name) VALUES (?, ?)
  `).run(otherLocationId, `Department ${suffix} Other`).lastInsertRowid);
  database.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id)
    VALUES (?, ?, ?, ?)
  `).run(employeeNumber, `Scope Employee ${suffix}`, `Scope ${suffix}`, locationId);
  database.prepare(`
    INSERT INTO portal_users (employee_number, role, active, must_change_password)
    VALUES (?, 'manager', 1, 0)
  `).run(employeeNumber);
  return {
    departmentId,
    employeeNumber,
    locationId,
    otherDepartmentId,
    otherLocationId,
  };
}

function insertPermissionAndAccessScope(database, fixture, permission) {
  database.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, 'pl-plus')
  `).run(fixture.employeeNumber, permission);
  database.prepare(`
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'pl-plus')
  `).run(fixture.employeeNumber, fixture.locationId);
}

function normalizeDefinitionSql(sql, type) {
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(new RegExp(`^create ${type} if not exists `, "i"), `create ${type} `)
    .toLowerCase();
}

test("Personalmodul R1: die fachrechtgebundene PL+-Huelle wird additiv und sicherungsbewehrt migriert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    dropScopedRightsSchema(database);
    const fixture = insertOrganizationFixture(database, "migration");
    database.prepare(`
      INSERT INTO candidates (
        id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'candidate-r1-preserved', 'active', 'enc:v2:must-survive', 1,
        'pl-plus', 'pl-plus', '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'
      )
    `).run();
    insertPermissionAndAccessScope(database, fixture, "personnel:candidates:read");

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backups.push({
        candidatePayload: database.prepare(`
          SELECT protected_payload FROM candidates WHERE id = 'candidate-r1-preserved'
        `).get().protected_payload,
        scopedRightsTablePresent: Boolean(database.prepare(`
          SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'portal_permission_scope_grants'
        `).get()),
      }),
    });

    assert.equal(result.personnelLifecycleScopedRightsMigrationRequired, true);
    assert.deepEqual(backups, [{
      candidatePayload: "enc:v2:must-survive",
      scopedRightsTablePresent: false,
    }]);
    assert.equal(inspectSqlitePersonnelLifecycleScopedRightsSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleScopedRightsRows(database).valid, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID).count, 1);
    assert.equal(database.prepare(`
      SELECT protected_payload FROM candidates WHERE id = 'candidate-r1-preserved'
    `).get().protected_payload, "enc:v2:must-survive");

    const rerun = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(rerun.personnelLifecycleScopedRightsMigrationRequired, false);
  } finally {
    database.close();
  }
});

test("Personalmodul R1: Tabelle, Trigger, Genehmiger und Scope-Schnittstelle sind fail-closed", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const fixture = insertOrganizationFixture(database, "constraints");
    insertPermissionAndAccessScope(database, fixture, "personnel:candidates:read");

    const inspection = inspectSqlitePersonnelLifecycleScopedRightsSchema(database);
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
      ["table", PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TABLE_DEFINITIONS],
      ["trigger", PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS],
    ]) {
      for (const definition of definitions) {
        const stored = database.prepare(
          "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
        ).get(type, definition.name);
        assert.equal(
          normalizeDefinitionSql(stored?.sql, type),
          normalizeDefinitionSql(definition.sql, type),
          definition.name,
        );
      }
    }

    const insert = database.prepare(`
      INSERT INTO portal_permission_scope_grants
        (employee_number, permission, location_id, department_id, approved_by)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run(
      fixture.employeeNumber,
      "personnel:candidates:read",
      fixture.locationId,
      fixture.departmentId,
      "pl-plus",
    );
    assert.doesNotThrow(() => database.prepare(`
      UPDATE departments
      SET location_id = ?, name = 'Department constraints renamed'
      WHERE id = ?
    `).run(fixture.locationId, fixture.departmentId));
    assert.throws(
      () => database.prepare(`
        UPDATE departments
        SET location_id = ?
        WHERE id = ?
      `).run(fixture.otherLocationId, fixture.departmentId),
      /department is referenced by a portal scope/,
    );
    assert.throws(
      () => insert.run(
        fixture.employeeNumber,
        "personnel:candidates:read",
        fixture.locationId,
        fixture.otherDepartmentId,
        "pl-plus",
      ),
      /permission scope grant is outside the portal access scope|scope is invalid/,
    );
    assert.throws(
      () => insert.run(
        fixture.employeeNumber,
        "personnel:candidates:read",
        fixture.otherLocationId,
        0,
        "pl-plus",
      ),
      /outside the portal access scope/,
    );
    assert.throws(
      () => insert.run(
        fixture.employeeNumber,
        "personnel:candidates:read",
        fixture.locationId,
        0,
        "",
      ),
      /check constraint/i,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO portal_access_scopes
          (employee_number, location_id, department_id, assigned_by)
        VALUES (?, ?, ?, 'pl-plus')
      `).run(fixture.employeeNumber, fixture.locationId, fixture.otherDepartmentId),
      /portal access scope is invalid/,
    );

    database.prepare(`
      DELETE FROM portal_access_scopes
      WHERE employee_number = ? AND location_id = ?
    `).run(fixture.employeeNumber, fixture.locationId);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM portal_permission_scope_grants
      WHERE employee_number = ?
    `).get(fixture.employeeNumber).count, 0);

    database.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, 'pl-plus')
    `).run(fixture.employeeNumber, fixture.locationId);
    insert.run(
      fixture.employeeNumber,
      "personnel:candidates:read",
      fixture.locationId,
      fixture.departmentId,
      "pl-plus",
    );
    database.prepare(`
      DELETE FROM portal_permission_grants
      WHERE employee_number = ? AND permission = 'personnel:candidates:read'
    `).run(fixture.employeeNumber);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM portal_permission_scope_grants
      WHERE employee_number = ?
    `).get(fixture.employeeNumber).count, 0);
    assert.equal(inspectSqlitePersonnelLifecycleScopedRightsRows(database).valid, true);
  } finally {
    database.close();
  }
});

test("Personalmodul R1: eine abweichende nichtleere Struktur bricht nach Backup unveraendert ab", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    const fixture = insertOrganizationFixture(database, "divergent");
    insertPermissionAndAccessScope(database, fixture, "personnel:candidates:read");
    database.prepare(`
      INSERT INTO portal_permission_scope_grants
        (employee_number, permission, location_id, department_id, approved_by)
      VALUES (?, 'personnel:candidates:read', ?, 0, 'pl-plus')
    `).run(fixture.employeeNumber, fixture.locationId);
    database.prepare("DELETE FROM schema_migrations WHERE id = ?")
      .run(PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID);
    database.exec(`
      DROP TRIGGER trg_portal_permission_scope_grants_scope_insert;
      CREATE TRIGGER trg_portal_permission_scope_grants_scope_insert
      BEFORE INSERT ON portal_permission_scope_grants
      BEGIN
        SELECT RAISE(ABORT, 'wrong scoped-rights trigger');
      END;
    `);

    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => backups.push(database.prepare(`
          SELECT approved_by FROM portal_permission_scope_grants
          WHERE employee_number = ?
        `).get(fixture.employeeNumber).approved_by),
      }),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_SCHEMA_DATA_PRESENT",
    );
    assert.deepEqual(backups, ["pl-plus"]);
    assert.equal(database.prepare(`
      SELECT approved_by FROM portal_permission_scope_grants
      WHERE employee_number = ?
    `).get(fixture.employeeNumber).approved_by, "pl-plus");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?")
      .get(PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_MIGRATION_ID).count, 0);
  } finally {
    database.close();
  }
});

test("Personalmodul R1: Import und Maintenance akzeptieren pre-R1, aber kein partielles R1", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-r1-import-"));
  const databasePath = path.join(temporaryRoot, "import.db");
  let database = openSqliteLegacyDatabase(databasePath);
  try {
    database.exec(`
      CREATE TABLE employees (
        personnel_number TEXT PRIMARY KEY,
        full_name TEXT NOT NULL DEFAULT '',
        nickname TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE locations (id TEXT PRIMARY KEY);
      CREATE TABLE departments (id INTEGER PRIMARY KEY, location_id TEXT);
      CREATE TABLE positions (id TEXT PRIMARY KEY);
    `);
    ensureSqlitePersonnelLifecycleSchema(database);
    database.close();
    database = null;

    const compatible = inspectSqliteImportFile(databasePath);
    assert.equal(compatible.candidateScopedRightsSchemaState, "pre-r1-compatible");
    assert.equal(compatible.protectedInspectionError, false);
    const compatibleDatabase = openSqliteLegacyDatabase(databasePath, { readOnly: true });
    try {
      assert.doesNotThrow(() => protectedSicknessAmuStorageSnapshotFromDatabase(compatibleDatabase));
    } finally {
      compatibleDatabase.close();
    }

    database = openSqliteLegacyDatabase(databasePath);
    database.exec(`
      CREATE TABLE portal_permission_grants (
        employee_number TEXT NOT NULL,
        permission TEXT NOT NULL,
        granted_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (employee_number, permission)
      );
      CREATE TABLE portal_access_scopes (
        employee_number TEXT NOT NULL,
        location_id TEXT NOT NULL,
        department_id INTEGER NOT NULL DEFAULT 0,
        assigned_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (employee_number, location_id, department_id)
      );
    `);
    database.exec(PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION.sql);
    for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
      database.exec(definition.sql);
    }
    database.close();
    database = null;

    const validHistoricalR1 = inspectSqliteImportFile(databasePath);
    assert.equal(validHistoricalR1.candidateScopedRightsSchemaState, "pre-m7-r1-compatible");
    assert.equal(validHistoricalR1.candidateScopedRightsPredecessorVersion, "r1");
    assert.equal(validHistoricalR1.protectedInspectionError, false);

    database = openSqliteLegacyDatabase(databasePath);
    for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
      database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
    database.exec("DROP TABLE portal_permission_scope_grants");
    database.exec(PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION.sql);
    for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
      database.exec(definition.sql);
    }
    database.prepare("INSERT INTO locations (id) VALUES ('historical-m4-location')").run();
    database.prepare(`
      INSERT INTO employees (personnel_number, full_name, nickname)
      VALUES ('historical-m4-employee', 'Historical M4', 'M4')
    `).run();
    database.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES ('historical-m4-employee', 'personnel:workflows:read', 'pl-plus')
    `).run();
    database.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES ('historical-m4-employee', 'historical-m4-location', 0, 'pl-plus')
    `).run();
    database.prepare(`
      INSERT INTO portal_permission_scope_grants
        (employee_number, permission, location_id, department_id, approved_by)
      VALUES (
        'historical-m4-employee', 'personnel:workflows:read',
        'historical-m4-location', 0, 'pl-plus'
      )
    `).run();
    database.close();
    database = null;

    const validHistoricalM4 = inspectSqliteImportFile(databasePath);
    assert.equal(validHistoricalM4.candidateScopedRightsSchemaState, "pre-m7-m4-compatible");
    assert.equal(validHistoricalM4.candidateScopedRightsPredecessorVersion, "m4");
    assert.equal(validHistoricalM4.protectedInspectionError, false);
    const historicalM4Database = openSqliteLegacyDatabase(databasePath, { readOnly: true });
    try {
      assert.doesNotThrow(() => protectedSicknessAmuStorageSnapshotFromDatabase(
        historicalM4Database,
      ));
    } finally {
      historicalM4Database.close();
    }

    database = openSqliteLegacyDatabase(databasePath);
    for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
      database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
    database.exec("DROP TABLE portal_permission_scope_grants");
    ensureSqlitePersonnelLifecycleScopedRightsSchema(database);
    database.close();
    database = null;

    const validM7 = inspectSqliteImportFile(databasePath);
    assert.equal(validM7.candidateScopedRightsSchemaState, "m7");
    assert.equal(validM7.candidateScopedRightsPredecessorVersion, null);
    assert.equal(validM7.protectedInspectionError, false);

    database = openSqliteLegacyDatabase(databasePath);
    database.exec("DROP TRIGGER trg_portal_permission_scope_grants_scope_insert");
    database.close();
    database = null;

    const partial = inspectSqliteImportFile(databasePath);
    assert.equal(partial.candidateScopedRightsSchemaState, "invalid");
    assert.equal(partial.protectedInspectionError, true);
    const partialDatabase = openSqliteLegacyDatabase(databasePath, { readOnly: true });
    try {
      assert.throws(
        () => protectedSicknessAmuStorageSnapshotFromDatabase(partialDatabase),
        /Providervertrag/i,
      );
    } finally {
      partialDatabase.close();
    }
  } finally {
    try { database?.close(); } catch {}
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Personalmodul R1: Repositories und Sessions liefern nur die vereinbarten Access-Projektionen", async () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_APPLICATION_CATALOG,
  });
  try {
    runMigrations(application.database);
    const fixture = insertOrganizationFixture(application.database, "repository");
    insertPermissionAndAccessScope(
      application.database,
      fixture,
      "personnel:candidates:read",
    );
    const organization = createOrganizationPersonnelRepository(application.provider);
    const personnel = createPersonnelLifecycleRepository(application.provider);
    const portalAccess = createPortalAccessRepository(application.provider);

    await organization.insertPermissionScopeGrant({
      employeeNumber: fixture.employeeNumber,
      permission: "personnel:candidates:read",
      locationId: fixture.locationId,
      departmentId: fixture.departmentId,
      approvedBy: "pl-plus",
    });
    const grants = await organization.listPortalPermissionScopeGrants(fixture.employeeNumber);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].permission, "personnel:candidates:read");
    assert.equal(grants[0].approved_by, "pl-plus");

    const occurredAt = "2026-08-01T12:00:00.000Z";
    application.database.prepare(`
      INSERT INTO candidates (
        id, state, protected_payload, revision, created_by, updated_by, created_at, updated_at
      ) VALUES ('candidate-r1-query', 'active', 'enc:v2:candidate-secret', 1,
        'pl-plus', 'pl-plus', ?, ?)
    `).run(occurredAt, occurredAt);
    application.database.prepare(`
      INSERT INTO candidate_applications (
        id, candidate_id, status, desired_location_id, desired_department_id,
        protected_payload, revision, status_changed_at, created_by, updated_by,
        created_at, updated_at
      ) VALUES ('application-r1-query', 'candidate-r1-query', 'screening', ?, ?,
        'enc:v2:application-secret', 1, ?, 'pl-plus', 'pl-plus', ?, ?)
    `).run(fixture.locationId, fixture.departmentId, occurredAt, occurredAt, occurredAt);

    const headers = await personnel.listCandidateAccessHeaders({
      includeArchived: false,
      limit: 10,
      offset: 0,
    });
    const header = headers.find((row) => row.id === "candidate-r1-query");
    assert.deepEqual(Object.keys(header).sort(), [
      "createdAt", "id", "revision", "state", "updatedAt",
    ]);
    const applicationScopes = await personnel.listApplicationAccessScopes("candidate-r1-query");
    assert.deepEqual(applicationScopes, [{
      id: "application-r1-query",
      candidateId: "candidate-r1-query",
      status: "screening",
      desiredLocationId: fixture.locationId,
      desiredDepartmentId: fixture.departmentId,
      revision: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }]);

    application.database.prepare(`
      INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
      VALUES ('session-r1', ?, 'token-r1', '2027-08-01T12:00:00.000Z')
    `).run(fixture.employeeNumber);
    const session = await portalAccess.getEmployeeSessionByToken({
      tokenHash: "token-r1",
      now: "2026-08-01T12:00:00.000Z",
    });
    assert.deepEqual(session.permission_scopes, [{
      permission: "personnel:candidates:read",
      locationId: fixture.locationId,
      departmentId: fixture.departmentId,
      approvedBy: "pl-plus",
    }]);

    await organization.deletePermissionScopeGrants(
      fixture.employeeNumber,
      "personnel:candidates:read",
    );
    assert.deepEqual(
      await organization.listPortalPermissionScopeGrants(fixture.employeeNumber),
      [],
    );
  } finally {
    await application.provider.close();
    try { application.database.close(); } catch {}
  }
});
