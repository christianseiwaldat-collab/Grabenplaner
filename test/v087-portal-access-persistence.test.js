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
const {
  PORTAL_ACCESS_STATEMENTS,
} = require("../lib/persistence/statements/portal-access");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_PORTAL_ACCESS_CATALOG,
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
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES ('E18', 'personnel:candidates:read', 'PL-PLUS');
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id)
      VALUES ('E18', '18', 0);
    INSERT INTO portal_permission_scope_grants (
      employee_number, permission, location_id, department_id, approved_by
    ) VALUES ('E18', 'personnel:candidates:read', '18', 0, 'PL-PLUS');
    INSERT INTO portal_sessions (
      id, employee_number, token_hash, expires_at
    ) VALUES (
      'browser-session', 'E18', 'token-hash', '2099-01-01T00:00:00.000Z'
    );
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

test("Block 3/7: Portal-Access-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(PORTAL_ACCESS_STATEMENTS);
  assert.equal(SQLITE_PORTAL_ACCESS_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_PORTAL_ACCESS_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_PORTAL_ACCESS_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: Browser-Sitzung wird über den Provider vollständig projiziert", async () => {
  const context = fixture();
  try {
    const session = await context.repository.getEmployeeSessionByToken({
      tokenHash: "token-hash",
      now: "2026-07-29T12:00:00.000Z",
    });
    assert.equal(session.employee_number, "E18");
    assert.equal(session.role, "manager");
    assert.equal(session.home_location_id, "18");
    assert.equal(session.time_confirmation_level, "B");
    assert.deepEqual(JSON.parse(session.permissions), ["own_time:read"]);
    const permissionScopes = Array.isArray(session.permission_scopes)
      ? session.permission_scopes
      : JSON.parse(session.permission_scopes);
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

test("Browser-Sitzung bewertet Vertretungen mit dem expliziten Wiener Geschäftstag", async () => {
  const context = fixture();
  const substitutionActive = async (businessDate) => {
    const session = await context.repository.getEmployeeSessionByToken({
      tokenHash: "token-hash",
      now: "2026-08-02T12:00:00.000Z",
      businessDate,
    });
    const scopes = Array.isArray(session.access_scopes)
      ? session.access_scopes
      : JSON.parse(session.access_scopes);
    return Number(scopes[0]?.departmentManagerSubstitutionActive || 0);
  };
  try {
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

test("Personalmodul R1: deaktivierte Mitarbeiter bleiben trotz Legacy-Portalstatus abgemeldet", async () => {
  const context = fixture();
  try {
    context.database.prepare("UPDATE employees SET active = 0 WHERE personnel_number = 'E18'").run();
    assert.equal(await context.repository.getEmployeeSessionByToken({
      tokenHash: "token-hash",
      now: "2026-07-29T12:00:00.000Z",
    }), null);
    assert.equal(context.database.prepare(`
      SELECT active FROM portal_users WHERE employee_number = 'E18'
    `).get().active, 1);
  } finally {
    await context.close();
  }
});

test("Personalmodul R1: Browser-Sitzungen blenden inaktive Standort- und Abteilungsscopes aus", async () => {
  const context = fixture();
  const loadSession = async () => context.repository.getEmployeeSessionByToken({
    tokenHash: "token-hash",
    now: "2026-07-29T12:00:00.000Z",
  });
  const projectionArray = (value) => (Array.isArray(value) ? value : JSON.parse(value));
  try {
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
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM portal_permission_scope_grants
      WHERE employee_number = 'E18'
    `).get().count, 1);

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

test("Personalmodul R1: Organisationssitzungen blenden inaktive Standortscopes aus", async () => {
  const context = fixture();
  const projectionArray = (value) => (Array.isArray(value) ? value : JSON.parse(value));
  try {
    context.database.exec(`
      INSERT INTO portal_organization_accounts (
        id, login_name, display_name, account_type, password_hash, active,
        must_change_password, created_by, updated_by
      ) VALUES (
        'organization-r1', 'organization-r1', 'Organisation R1', 'branch',
        'test-only', 1, 0, 'test', 'test'
      );
      INSERT INTO portal_organization_account_scopes (
        account_id, location_id, department_id, assigned_by
      ) VALUES ('organization-r1', '18', 0, 'test');
      INSERT INTO portal_organization_sessions (
        id, account_id, token_hash, expires_at
      ) VALUES (
        'organization-session-r1', 'organization-r1', 'organization-token-r1',
        '2099-01-01T00:00:00.000Z'
      );
    `);
    const loadSession = async () => context.repository.getOrganizationSessionByToken({
      tokenHash: "organization-token-r1",
      now: "2026-07-29T12:00:00.000Z",
    });

    let session = await loadSession();
    assert.deepEqual(projectionArray(session.access_scopes), [{
      locationId: "18",
      departmentId: null,
    }]);

    context.database.prepare("UPDATE locations SET active = 0 WHERE id = '18'").run();
    session = await loadSession();
    assert.deepEqual(projectionArray(session.access_scopes), []);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM portal_organization_account_scopes
      WHERE account_id = 'organization-r1'
    `).get().count, 1);
  } finally {
    await context.close();
  }
});

test("Block 3/7: USB-Erstellerliste und Passwortpruefung lesen ueber Portal-Access", async () => {
  const context = fixture();
  try {
    context.database.exec(`
      INSERT INTO positions (id, name, builtin, sort_order)
        VALUES ('developer', 'Developer', 1, 1);
      UPDATE employees SET position_id = 'developer' WHERE personnel_number = 'E18';
      UPDATE portal_users SET role = 'developer' WHERE employee_number = 'E18';
    `);

    const candidates = await context.repository.listUsbCreatorCandidates({});
    assert.deepEqual(candidates.map((candidate) => candidate.employee_number), ["E18"]);
    assert.equal(candidates[0].position_name, "Developer");

    const creator = await context.repository.getUsbCreator({ employeeNumber: "E18" });
    assert.equal(creator.role, "developer");
    assert.equal(creator.password_hash, "hash");
    assert.equal(creator.personnel_number, "E18");
    assert.equal(creator.home_location_id, "18");

    context.database.prepare("UPDATE employees SET active = 0 WHERE personnel_number = 'E18'").run();
    assert.equal(await context.repository.getUsbCreator({ employeeNumber: "E18" }), null);
    assert.deepEqual(await context.repository.listUsbCreatorCandidates({}), []);
  } finally {
    await context.close();
  }
});

test("Block 3/7: USB-Ersteller-Serverpfad bleibt raw-frei und wird abgewartet", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const creatorSlice = source.match(
    /async function usbCreatorCandidates[\s\S]*?function usbCandidateOptions/,
  )?.[0] || "";
  assert.ok(creatorSlice);
  assert.doesNotMatch(creatorSlice, /\bdb\.(?:prepare|exec)\b/);
  assert.match(creatorSlice, /await portalAccessRepository\.listUsbCreatorCandidates/);
  assert.match(creatorSlice, /await portalAccessRepository\.getUsbCreator/);

  const statusRoute = source.match(
    /app\.get\("\/api\/usb-provisioning\/status"[\s\S]*?app\.get\("\/api\/usb-provisioning\/drives"/,
  )?.[0] || "";
  assert.match(statusRoute, /creators:\s*await usbCreatorCandidates\(session\)/);
});

test("Block 3/7: Portal-Benachrichtigung und Login-Sitzung rollen gemeinsam zurück", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      context.repository.transaction(async (repository) => {
        await repository.insertNotification({
          id: "notification-1",
          employeeNumber: "E18",
          eventType: "test",
          title: "Test",
          message: "",
          target: "/portal.html",
          entityType: "test",
          entityId: "1",
          dedupeKey: "test:1",
        });
        await repository.revokeEmployeeSessionsForEmployee({ employeeNumber: "E18" });
        throw new Error("rollback");
      }),
      /rollback/,
    );

    assert.equal(await context.repository.getNotificationByDedupe({
      employeeNumber: "E18",
      dedupeKey: "test:1",
    }), null);
    assert.ok(await context.repository.getEmployeeSessionByToken({
      tokenHash: "token-hash",
      now: "2026-07-29T12:00:00.000Z",
    }));
  } finally {
    await context.close();
  }
});
