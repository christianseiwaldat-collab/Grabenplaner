"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION,
  PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS,
  PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID,
  inspectSqlitePersonnelLifecycleScopedRightsRows,
  inspectSqlitePersonnelLifecycleScopedRightsSchema,
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
    appVersion: "0.90-personnel-profile-scoped-rights-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function insertFixture(database, suffix = "m7") {
  const employeeNumber = `profile-scope-${suffix}`;
  const locationId = `profile-location-${suffix}`;
  database.prepare("INSERT INTO locations (id, name) VALUES (?, ?)")
    .run(locationId, `Profile location ${suffix}`);
  database.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id)
    VALUES (?, ?, ?, ?)
  `).run(employeeNumber, `Profile employee ${suffix}`, `Profile ${suffix}`, locationId);
  database.prepare(`
    INSERT INTO portal_users (employee_number, role, active, must_change_password)
    VALUES (?, 'manager', 1, 0)
  `).run(employeeNumber);
  database.prepare(`
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'pl-plus')
  `).run(employeeNumber, locationId);
  return { employeeNumber, locationId };
}

function insertDirectGrant(database, employeeNumber, permission) {
  database.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, 'pl-plus')
  `).run(employeeNumber, permission);
}

function dropScopedRightsTriggers(database) {
  for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
    database.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
  }
}

function installHistoricalScopedRightsTable(database, tableDefinition) {
  dropScopedRightsTriggers(database);
  database.exec("DROP TABLE portal_permission_scope_grants");
  database.exec(tableDefinition.sql);
  for (const definition of PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS) {
    database.exec(definition.sql);
  }
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID);
}

function installM4ScopedRightsTable(database) {
  installHistoricalScopedRightsTable(
    database,
    PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION,
  );
}

function readScopedRightsSchema(database) {
  const names = [
    "portal_permission_scope_grants",
    ...PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS.map(({ name }) => name),
  ];
  const placeholders = names.map(() => "?").join(", ");
  return database.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name IN (${placeholders})
    ORDER BY type, name
  `).all(...names);
}

test("M7 Profilrechte: M4-Scopezeilen werden nach genau einem Backup verlustfrei übernommen", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    const fixture = insertFixture(database, "migration");
    installM4ScopedRightsTable(database);
    for (const permission of [
      "personnel:candidates:read",
      "personnel:workflows:read",
    ]) {
      insertDirectGrant(database, fixture.employeeNumber, permission);
    }
    const insertScope = database.prepare(`
      INSERT INTO portal_permission_scope_grants (
        employee_number, permission, location_id, department_id,
        approved_by, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?)
    `);
    insertScope.run(
      fixture.employeeNumber,
      "personnel:candidates:read",
      fixture.locationId,
      "pl-plus-1",
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T10:01:00.000Z",
    );
    insertScope.run(
      fixture.employeeNumber,
      "personnel:workflows:read",
      fixture.locationId,
      "pl-plus-2",
      "2026-08-01T11:00:00.000Z",
      "2026-08-01T11:01:00.000Z",
    );
    const before = database.prepare(`
      SELECT employee_number, permission, location_id, department_id,
             approved_by, created_at, updated_at
      FROM portal_permission_scope_grants
      ORDER BY permission
    `).all();

    const result = runMigrations(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => backups.push(database.prepare(`
        SELECT employee_number, permission, location_id, department_id,
               approved_by, created_at, updated_at
        FROM portal_permission_scope_grants
        ORDER BY permission
      `).all()),
    });

    assert.equal(result.personnelProfileScopedRightsMigrationRequired, true);
    assert.deepEqual(backups, [before]);
    assert.deepEqual(database.prepare(`
      SELECT employee_number, permission, location_id, department_id,
             approved_by, created_at, updated_at
      FROM portal_permission_scope_grants
      ORDER BY permission
    `).all(), before);
    assert.equal(inspectSqlitePersonnelLifecycleScopedRightsSchema(database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleScopedRightsRows(database).valid, true);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID).count, 1);

    const repeated = runMigrations(database, { databaseExistedBeforeOpen: true });
    assert.equal(repeated.personnelProfileScopedRightsMigrationRequired, false);
    assert.equal(repeated.personnelLifecycleScopedRightsMigrationRequired, false);
    assert.deepEqual(backups, [before]);
  } finally {
    database.close();
  }
});

for (const scenario of [
  {
    label: "R1 mit fehlendem Trigger",
    tableDefinition: PERSONNEL_LIFECYCLE_LEGACY_SCOPED_RIGHTS_TABLE_DEFINITION,
    alterTriggers(database) {
      const definition = PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS.find(
        ({ name }) => name === "trg_portal_permission_scope_grants_scope_insert",
      );
      database.exec(`DROP TRIGGER "${definition.name}"`);
    },
  },
  {
    label: "M4 mit manipuliertem Trigger",
    tableDefinition: PERSONNEL_LIFECYCLE_M4_SCOPED_RIGHTS_TABLE_DEFINITION,
    alterTriggers(database) {
      const definition = PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_TRIGGER_DEFINITIONS.find(
        ({ name }) => name === "trg_portal_permission_scope_grants_scope_insert",
      );
      database.exec(`DROP TRIGGER "${definition.name}"`);
      database.exec(definition.sql.replace(
        "permission scope grant is outside the portal access scope",
        "permission scope grant trigger was modified",
      ));
    },
  },
]) {
  test(`M7 Profilrechte: ${scenario.label} bleibt nach genau einem Backup unverändert`, () => {
    const database = openSqliteLegacyDatabase(":memory:");
    let backupCount = 0;
    try {
      runMigrations(database);
      const fixture = insertFixture(database, `partial-${scenario.label.slice(0, 2).toLowerCase()}`);
      installHistoricalScopedRightsTable(database, scenario.tableDefinition);
      insertDirectGrant(database, fixture.employeeNumber, "personnel:candidates:read");
      database.prepare(`
        INSERT INTO portal_permission_scope_grants (
          employee_number, permission, location_id, department_id,
          approved_by, created_at, updated_at
        ) VALUES (?, 'personnel:candidates:read', ?, 0, ?, ?, ?)
      `).run(
        fixture.employeeNumber,
        fixture.locationId,
        "pl-plus",
        "2026-08-02T10:00:00.000Z",
        "2026-08-02T10:01:00.000Z",
      );
      scenario.alterTriggers(database);
      const schemaBefore = readScopedRightsSchema(database);
      const rowsBefore = database.prepare(`
        SELECT employee_number, permission, location_id, department_id,
               approved_by, created_at, updated_at
        FROM portal_permission_scope_grants
        ORDER BY employee_number, permission, location_id, department_id
      `).all();

      assert.throws(
        () => runMigrations(database, {
          databaseExistedBeforeOpen: true,
          onBackup: () => { backupCount += 1; },
        }),
        (error) => error?.code === "PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_SCHEMA_DATA_PRESENT",
      );

      assert.equal(backupCount, 1);
      assert.deepEqual(readScopedRightsSchema(database), schemaBefore);
      assert.deepEqual(database.prepare(`
        SELECT employee_number, permission, location_id, department_id,
               approved_by, created_at, updated_at
        FROM portal_permission_scope_grants
        ORDER BY employee_number, permission, location_id, department_id
      `).all(), rowsBefore);
      assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
      `).get(PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID).count, 0);
    } finally {
      database.close();
    }
  });
}

test("M7 Profilrechte: nur Profil-Lesen und Stammdaten-Lesen besitzen Scopezeilen", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  try {
    runMigrations(database);
    const fixture = insertFixture(database, "constraints");
    const permissions = [
      "personnel:profiles:read",
      "personnel:profiles:master:read",
      "personnel:profiles:documents:read",
      "personnel:profiles:delegate",
    ];
    for (const permission of permissions) {
      insertDirectGrant(database, fixture.employeeNumber, permission);
    }
    const insertScope = database.prepare(`
      INSERT INTO portal_permission_scope_grants
        (employee_number, permission, location_id, department_id, approved_by)
      VALUES (?, ?, ?, 0, 'pl-plus')
    `);
    assert.doesNotThrow(() => insertScope.run(
      fixture.employeeNumber,
      "personnel:profiles:read",
      fixture.locationId,
    ));
    assert.doesNotThrow(() => insertScope.run(
      fixture.employeeNumber,
      "personnel:profiles:master:read",
      fixture.locationId,
    ));
    for (const permission of [
      "personnel:profiles:documents:read",
      "personnel:profiles:delegate",
    ]) {
      assert.throws(
        () => insertScope.run(fixture.employeeNumber, permission, fixture.locationId),
        /check constraint/i,
        permission,
      );
    }
    assert.deepEqual(database.prepare(`
      SELECT permission FROM portal_permission_scope_grants ORDER BY permission
    `).all().map((row) => row.permission), [
      "personnel:profiles:master:read",
      "personnel:profiles:read",
    ]);
    assert.equal(inspectSqlitePersonnelLifecycleScopedRightsRows(database).valid, true);
  } finally {
    database.close();
  }
});

test("M7 Profilrechte: unbekannte nichtleere Scope-Strukturen bleiben nach Backup unverändert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  const backups = [];
  try {
    runMigrations(database);
    const fixture = insertFixture(database, "divergent");
    insertDirectGrant(database, fixture.employeeNumber, "personnel:profiles:read");
    database.prepare(`
      INSERT INTO portal_permission_scope_grants
        (employee_number, permission, location_id, department_id, approved_by)
      VALUES (?, 'personnel:profiles:read', ?, 0, 'pl-plus')
    `).run(fixture.employeeNumber, fixture.locationId);
    database.prepare("DELETE FROM schema_migrations WHERE id = ?")
      .run(PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID);
    database.exec("ALTER TABLE portal_permission_scope_grants ADD COLUMN foreign_column TEXT");

    assert.throws(
      () => runMigrations(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => backups.push({ ...database.prepare(`
          SELECT permission, approved_by
          FROM portal_permission_scope_grants
          WHERE employee_number = ?
        `).get(fixture.employeeNumber) }),
      }),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_SCOPED_RIGHTS_SCHEMA_DATA_PRESENT",
    );
    assert.deepEqual(backups, [{
      permission: "personnel:profiles:read",
      approved_by: "pl-plus",
    }]);
    assert.deepEqual({ ...database.prepare(`
      SELECT permission, approved_by
      FROM portal_permission_scope_grants
      WHERE employee_number = ?
    `).get(fixture.employeeNumber) }, backups[0]);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(PERSONNEL_PROFILE_SCOPED_RIGHTS_MIGRATION_ID).count, 0);
  } finally {
    database.close();
  }
});
