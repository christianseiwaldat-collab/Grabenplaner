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
