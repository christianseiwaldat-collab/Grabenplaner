"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createPortalAccessRepository,
} = require("../lib/persistence/repositories/portal-access");
const {
  SQLITE_PORTAL_ACCESS_CATALOG,
} = require("../lib/persistence/sqlite/portal-access-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_PORTAL_ACCESS_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active) VALUES ('18', 'Grabenweg', 1);
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active)
      VALUES ('E18', 'Erika Beispiel', 'Erika', '18', 1);
    INSERT INTO portal_roles (id, name, permissions, builtin, sort_order)
      VALUES ('employee', 'Mitarbeiter', '[]', 1, 10);
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password)
      VALUES ('E18', 'hash', 'employee', 1, 0);
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
      VALUES ('employee-session', 'E18', 'employee-token', '2026-08-13T22:15:00.000Z');

    INSERT INTO portal_organization_accounts (
      id, login_name, display_name, account_type, password_hash, active, must_change_password
    ) VALUES ('branch-18', 'fil18', 'Filiale 18', 'branch', 'hash', 1, 0);
    INSERT INTO portal_organization_account_scopes (account_id, location_id)
      VALUES ('branch-18', '18');
    INSERT INTO portal_organization_sessions (id, account_id, token_hash, expires_at)
      VALUES ('branch-session', 'branch-18', 'branch-token', '2026-08-13T22:15:00.000Z');
  `);
  return {
    ...application,
    repository: createPortalAccessRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("v0.92.5: Browser-Sitzungen erhalten bei Aktivität ein neues Ablaufdatum", async () => {
  const context = fixture();
  const extendedExpiry = "2026-08-14T06:00:00.000Z";
  try {
    await context.repository.touchEmployeeSession({ id: "employee-session", expiresAt: extendedExpiry });
    await context.repository.touchOrganizationSession({ id: "branch-session", expiresAt: extendedExpiry });

    assert.equal(context.database.prepare(
      "SELECT expires_at FROM portal_sessions WHERE id = 'employee-session'",
    ).get().expires_at, extendedExpiry);
    assert.equal(context.database.prepare(
      "SELECT expires_at FROM portal_organization_sessions WHERE id = 'branch-session'",
    ).get().expires_at, extendedExpiry);
    assert.ok(await context.repository.getEmployeeSessionByToken({
      tokenHash: "employee-token",
      now: "2026-08-14T05:59:59.000Z",
      businessDate: "2026-08-14",
    }));
    assert.ok(await context.repository.getOrganizationSessionByToken({
      tokenHash: "branch-token",
      now: "2026-08-14T05:59:59.000Z",
    }));
  } finally {
    await context.close();
  }
});

test("v0.92.5: Server verlängert DB-Sitzung und beide Browser-Cookies gemeinsam", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /function portalSessionTimeoutMinutes\(\)[\s\S]*?session_timeout_minutes \|\| 480/);
  assert.match(source, /renewPortalSession\(\{ session, kind: 'employee'[\s\S]*?expiresAt: refreshedExpiresAt,[\s\S]*?write: value => repository\.touchEmployeeSession\(value\)/);
  assert.match(source, /renewPortalSession\(\{ session: organizationSession, kind: 'organization'[\s\S]*?expiresAt: refreshedExpiresAt,[\s\S]*?write: value => repository\.touchOrganizationSession\(value\)/);
  assert.match(source, /PORTAL_SESSION_COOKIE,[\s\S]*?\{ httpOnly: true, maxAge \}/);
  assert.match(source, /PORTAL_CSRF_COOKIE,[\s\S]*?\{ maxAge \}/);
});
