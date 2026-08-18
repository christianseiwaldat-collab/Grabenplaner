"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createMobileAuthRepository,
} = require("../lib/persistence/repositories/mobile-auth");
const {
  SQLITE_MOBILE_AUTH_CATALOG,
} = require("../lib/persistence/sqlite/mobile-auth-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  MOBILE_AUTH_STATEMENTS,
} = require("../lib/persistence/statements/mobile-auth");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_MOBILE_AUTH_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active) VALUES ('18', 'Filiale 18', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      time_confirmation_level, active
    ) VALUES ('E18', 'Erika Beispiel', 'Erika', '18', 'B', 1);
    INSERT INTO portal_roles (id, name, permissions, builtin, sort_order)
      VALUES ('manager', 'Filialleitung', '["own_time:read"]', 1, 10);
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password
    ) VALUES ('E18', 'hash', 'manager', 1, 0);
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id)
      VALUES ('E18', '18', 0);
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES ('E18', 'personnel:candidates:read', 'PL-PLUS');
    INSERT INTO portal_permission_scope_grants (
      employee_number, permission, location_id, department_id, approved_by
    ) VALUES ('E18', 'personnel:candidates:read', '18', 0, 'PL-PLUS');
    INSERT INTO personnel_field_permissions (role_id, field_key, access_level)
      VALUES ('manager', 'nickname', 'read');
    INSERT INTO amu_local_access_overrides (employee_number, access_mode, updated_by)
      VALUES ('E18', 'allow', 'admin');
  `);
  return {
    ...application,
    repository: createMobileAuthRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

function sessionInput(overrides = {}) {
  return {
    id: "mobile-session",
    employeeNumber: "E18",
    accessTokenHash: "a".repeat(64),
    accessExpiresAt: "2026-07-29T12:00:00.000Z",
    refreshTokenHash: "b".repeat(64),
    refreshExpiresAt: "2026-08-29T12:00:00.000Z",
    installationIdHash: "c".repeat(64),
    platform: "android",
    deviceLabel: "Testgerät",
    appVersion: "1.0.0",
    ...overrides,
  };
}

test("Block 3/7: Mobile-Auth-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(MOBILE_AUTH_STATEMENTS);
  assert.equal(SQLITE_MOBILE_AUTH_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_MOBILE_AUTH_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_MOBILE_AUTH_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: Mobile-Projektion enthält Rechte-, AUM- und Vertretungskontext", async () => {
  const context = fixture();
  try {
    await context.repository.insertSession(sessionInput());
    const session = await context.repository.getSession({ sessionId: "mobile-session" });
    assert.equal(session.employee_number, "E18");
    assert.equal(session.time_confirmation_level, "B");
    assert.equal(session.amu_local_access_mode, "allow");
    const fieldPermissions = Array.isArray(session.personnel_field_permissions)
      ? session.personnel_field_permissions
      : JSON.parse(session.personnel_field_permissions);
    const accessScopes = Array.isArray(session.access_scopes)
      ? session.access_scopes
      : JSON.parse(session.access_scopes);
    const permissionScopes = Array.isArray(session.permission_scopes)
      ? session.permission_scopes
      : JSON.parse(session.permission_scopes);
    assert.deepEqual(fieldPermissions, [
      { fieldKey: "nickname", accessLevel: "read" },
    ]);
    assert.deepEqual(accessScopes, [
      {
        locationId: "18",
        departmentId: null,
        departmentManagerSubstitutionActive: 0,
      },
    ]);
    assert.deepEqual(permissionScopes, [{
      permission: "personnel:candidates:read",
      locationId: "18",
      departmentId: null,
      approvedBy: "PL-PLUS",
    }]);
  } finally {
    await context.close();
  }
});

test("Mobile-Sitzung bewertet Vertretungen mit dem expliziten Wiener Geschäftstag", async () => {
  const context = fixture();
  const substitutionActive = async (businessDate) => {
    const session = await context.repository.getSession({
      sessionId: "mobile-session",
      businessDate,
    });
    const scopes = Array.isArray(session.access_scopes)
      ? session.access_scopes
      : JSON.parse(session.access_scopes);
    return Number(scopes[0]?.departmentManagerSubstitutionActive || 0);
  };
  try {
    await context.repository.insertSession(sessionInput());
    context.database.prepare(`
      INSERT INTO approval_delegations (
        location_id, delegate_employee_number, date_from, date_to, note, created_by
      ) VALUES ('18', 'E18', '2026-08-02', '2026-08-02', 'Geschäftstag', 'E18')
    `).run();

    assert.equal(await substitutionActive("2026-08-01"), 0);
    assert.equal(await substitutionActive("2026-08-02"), 1);
    assert.equal(await substitutionActive("2026-08-03"), 0);

    context.database.prepare("DELETE FROM approval_delegations").run();
    context.database.prepare(`
      INSERT INTO week_options (
        employee_number, week_start, date_from, date_to, option_type, note, all_day
      ) VALUES (
        'E18', '2026-07-27', '2026-08-02', '2026-08-02',
        'vacation', 'Geschäftstag', 1
      )
    `).run();

    assert.equal(await substitutionActive("2026-08-01"), 0);
    assert.equal(await substitutionActive("2026-08-02"), 1);
    assert.equal(await substitutionActive("2026-08-03"), 0);
  } finally {
    await context.close();
  }
});

test("Personalmodul R1: Mobile-Sitzungen blenden inaktive Standort- und Abteilungsscopes aus", async () => {
  const context = fixture();
  const projectionArray = (value) => (Array.isArray(value) ? value : JSON.parse(value));
  try {
    await context.repository.insertSession(sessionInput());
    const loadSession = async () => context.repository.getSession({
      sessionId: "mobile-session",
    });

    let session = await loadSession();
    assert.equal(Number(session.access_scope_assignment_count), 1);
    assert.equal(Number(session.home_location_active), 1);
    assert.equal(projectionArray(session.access_scopes).length, 1);
    assert.equal(projectionArray(session.permission_scopes).length, 1);

    context.database.prepare("UPDATE locations SET active = 0 WHERE id = '18'").run();
    session = await loadSession();
    assert.equal(Number(session.access_scope_assignment_count), 1);
    assert.equal(Number(session.home_location_active), 0);
    assert.deepEqual(projectionArray(session.access_scopes), []);
    assert.deepEqual(projectionArray(session.permission_scopes), []);

    context.database.prepare("UPDATE locations SET active = 1 WHERE id = '18'").run();
    const departmentId = Number(context.database.prepare(`
      INSERT INTO departments (location_id, name, active)
      VALUES ('18', 'Verkauf', 1)
    `).run().lastInsertRowid);
    context.database.prepare(`
      DELETE FROM portal_access_scopes WHERE employee_number = 'E18'
    `).run();
    context.database.prepare(`
      INSERT INTO portal_access_scopes (employee_number, location_id, department_id)
      VALUES ('E18', '18', ?)
    `).run(departmentId);
    context.database.prepare(`
      INSERT INTO portal_permission_scope_grants (
        employee_number, permission, location_id, department_id, approved_by
      ) VALUES ('E18', 'personnel:candidates:read', '18', ?, 'PL-PLUS')
    `).run(departmentId);

    session = await loadSession();
    assert.deepEqual(projectionArray(session.access_scopes).map((scope) => ({
      locationId: scope.locationId,
      departmentId: scope.departmentId,
    })), [{ locationId: "18", departmentId }]);
    assert.deepEqual(projectionArray(session.permission_scopes).map((scope) => ({
      locationId: scope.locationId,
      departmentId: scope.departmentId,
    })), [{ locationId: "18", departmentId }]);

    context.database.prepare("UPDATE departments SET active = 0 WHERE id = ?")
      .run(departmentId);
    session = await loadSession();
    assert.deepEqual(projectionArray(session.access_scopes), []);
    assert.deepEqual(projectionArray(session.permission_scopes), []);
  } finally {
    await context.close();
  }
});

test("Block 3/7: Refresh-Rotation und Mutation-Receipt rollen atomar zurück", async () => {
  const context = fixture();
  try {
    await context.repository.insertSession(sessionInput());
    await assert.rejects(
      context.repository.transaction(async (repository) => {
        await repository.rememberRefreshToken({
          sessionId: "mobile-session",
          tokenHash: "b".repeat(64),
          consumedAt: "2026-07-29T10:00:00.000Z",
        });
        await repository.rotateSession({
          sessionId: "mobile-session",
          accessTokenHash: "d".repeat(64),
          accessExpiresAt: "2026-07-29T13:00:00.000Z",
          refreshTokenHash: "e".repeat(64),
        });
        await repository.insertMutationReceipt({
          employeeNumber: "E18",
          idempotencyKey: "receipt-1",
          operation: "time-entry",
          requestSha256: "f".repeat(64),
          expiresAt: "2026-08-01",
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );

    const session = await context.repository.getSession({ sessionId: "mobile-session" });
    assert.equal(session.access_token_hash, "a".repeat(64));
    assert.equal(session.refresh_token_hash, "b".repeat(64));
    assert.equal(await context.repository.refreshTokenWasConsumed({
      sessionId: "mobile-session",
      tokenHash: "b".repeat(64),
    }), null);
    assert.equal(await context.repository.getMutationReceipt({
      employeeNumber: "E18",
      idempotencyKey: "receipt-1",
    }), null);
  } finally {
    await context.close();
  }
});
