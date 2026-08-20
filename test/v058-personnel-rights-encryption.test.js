"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createAmuStorage } = require("../lib/amu-storage");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v058-personnel-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  app,
  db,
  migrateProtectedPersonnelRecords,
  parseProtectedJson,
  releaseInstanceLockForTests,
} = require("../server");

let httpServer;
let baseUrl;
let locationId;
let positionId;
let departmentId;

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, role_locked, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, role_locked = excluded.role_locked,
      active = 1, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role, role === "developer" ? 1 : 0);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare("INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at) VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')")
    .run(id, employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { id, cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

function mobileSession(employeeNumber) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mobile_sessions (
      id, employee_number, access_token_hash, access_expires_at,
      refresh_token_hash, refresh_expires_at, installation_id_hash,
      platform, device_label, app_version
    ) VALUES (
      ?, ?, ?, '2099-12-31T23:59:59.000Z',
      ?, '2099-12-31T23:59:59.000Z', ?, 'android', 'Learning Test', 'test'
    )
  `).run(
    id,
    employeeNumber,
    crypto.createHash("sha256").update(`access-${id}`).digest("hex"),
    crypto.createHash("sha256").update(`refresh-${id}`).digest("hex"),
    crypto.createHash("sha256").update(`installation-${id}`).digest("hex"),
  );
  return id;
}

async function request(route, { method = "GET", auth = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

async function requestRaw(route, { auth = null, body }) {
  const headers = { Accept: "application/json", "Content-Type": "application/octet-stream" };
  if (auth) {
    headers.Cookie = auth.cookie;
    headers["X-CSRF-Token"] = auth.csrf;
  }
  const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers, body });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function employeePayload(personnelNumber, extras = {}) {
  return {
    personnelNumber,
    fullName: `Testperson ${personnelNumber}`,
    nickname: `T${personnelNumber}`,
    contractedHours: 38.5,
    positionId,
    homeLocationId: locationId,
    preferredDepartmentId: "",
    preferredDayOff: "",
    fixedWorkdays: [],
    color: "#2c7a68",
    active: true,
    ...extras,
  };
}

function reset() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM portal_sessions").run();
    db.prepare("DELETE FROM personnel_learning_permission_denial_authorities").run();
    db.prepare("DELETE FROM portal_permission_denials WHERE permission LIKE 'personnel:learning:%'").run();
    db.prepare("DELETE FROM portal_permission_grants").run();
    db.prepare("DELETE FROM portal_access_scopes").run();
    db.prepare("DELETE FROM portal_users").run();
    db.prepare("DELETE FROM amu_documents").run();
    db.prepare("DELETE FROM amu_reports").run();
    db.prepare("DELETE FROM personnel_sensitive_records").run();
    db.prepare("DELETE FROM audit_log WHERE action LIKE 'personnel-record.%'").run();
    db.prepare("UPDATE employees SET time_confirmation_level = 'C' WHERE personnel_number IN ('104','105')").run();
    db.prepare("UPDATE portal_settings SET value = '1' WHERE key = 'trust_levels_enabled'").run();
    db.prepare("DELETE FROM employees WHERE personnel_number LIKE '88%' OR personnel_number LIKE '89%'").run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function assertNoLearningRightsInPortalAccess(profile) {
  assert.ok(profile && typeof profile === "object");
  for (const field of [
    "rolePermissions",
    "grantedPermissions",
    "deniedPermissions",
    "effectivePermissions",
  ]) {
    assert.equal((profile[field] || []).some(
      (permission) => String(permission).startsWith("personnel:learning:"),
    ), false, field);
  }
  assert.equal((profile.personnelLifecyclePermissionScopes || []).some(
    (scope) => String(scope.permission || "").startsWith("personnel:learning:"),
  ), false, "personnelLifecyclePermissionScopes");
}

function assertLearningRightsVisibleInPortalAccess(profile, { permissionScope = false } = {}) {
  assert.equal((profile.rolePermissions || []).some(
    (permission) => String(permission).startsWith("personnel:learning:"),
  ), true);
  assert.equal((profile.effectivePermissions || []).some(
    (permission) => String(permission).startsWith("personnel:learning:"),
  ), true);
  if (permissionScope) {
    assert.equal((profile.personnelLifecyclePermissionScopes || []).some(
      (scope) => String(scope.permission || "").startsWith("personnel:learning:"),
    ), true);
  }
}

function sqliteText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function installSessionTouchRaceMutation(auth, statements) {
  const triggerName = `test_employee_actor_race_${crypto.randomBytes(8).toString("hex")}`;
  db.exec(`
    CREATE TRIGGER ${triggerName}
    AFTER UPDATE OF expires_at ON portal_sessions
    WHEN NEW.id = ${sqliteText(auth.id)}
    BEGIN
      ${statements}
    END
  `);
  return () => db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
}

async function withPermissionRevokedAtNextPersonnelTransaction(
  auth,
  employeeNumber,
  permission,
  operation,
) {
  const dropTrigger = installSessionTouchRaceMutation(auth, `
    INSERT OR IGNORE INTO portal_permission_denials
      (employee_number, permission, denied_by)
    VALUES (${sqliteText(employeeNumber)}, ${sqliteText(permission)}, 'learning-route-race');
  `);
  try {
    return await operation();
  } finally {
    dropTrigger();
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ? AND permission = ?
    `).run(employeeNumber, permission);
  }
}

test.before(async () => {
  locationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = '101'").get().home_location_id;
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  departmentId = db.prepare("SELECT id FROM departments WHERE location_id = ? ORDER BY id LIMIT 1").get(locationId)?.id || null;
  if (!departmentId) {
    departmentId = Number(db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Learning Rechteprofil', 0, 1, 9580)
    `).run(locationId).lastInsertRowid);
  }
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(reset);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.58: Developer legt Personalstammdaten und freigegebene Leitungsrolle atomar an", async () => {
  const developer = session("101", "developer");
  const result = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload("880", {
      accessProfile: { role: "manager", permissions: [] },
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.portal_access.role, "manager");
  assertLearningRightsVisibleInPortalAccess(result.payload.portal_access);
  assert.deepEqual(result.payload.portal_access.grantedPermissions, []);
  assert.equal(db.prepare("SELECT role FROM portal_users WHERE employee_number = '880'").get().role, "manager");
  assert.deepEqual(db.prepare("SELECT permission FROM portal_permission_grants WHERE employee_number = '880' ORDER BY permission").all().map((row) => row.permission), []);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'employee.access-profile.update' AND entity_id = '880'").get());
});

test("Live-Entzug von employees:write stoppt POST und PUT ohne Seiteneffekte", async () => {
  const developer = session("101", "developer");
  const createAuditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count;
  const deniedCreate = await withPermissionRevokedAtNextPersonnelTransaction(
    developer,
    "101",
    "employees:write",
    () => request("/api/employees", {
      method: "POST",
      auth: developer,
      body: employeePayload("898"),
    }),
  );
  assert.equal(deniedCreate.response.status, 403, JSON.stringify(deniedCreate.payload));
  assert.equal(deniedCreate.payload.code, "PORTAL_PERMISSION_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '898'").get(), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, createAuditBefore);

  const created = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload("899"),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const targetSession = session("899", "employee");
  const before = { ...db.prepare(`
    SELECT full_name, nickname, home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = '899'
  `).get() };
  const updateAuditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count;
  const deniedUpdate = await withPermissionRevokedAtNextPersonnelTransaction(
    developer,
    "101",
    "employees:write",
    () => request("/api/employees/899", {
      method: "PUT",
      auth: developer,
      body: employeePayload("899", { nickname: "Unzulaessig" }),
    }),
  );
  assert.equal(deniedUpdate.response.status, 403, JSON.stringify(deniedUpdate.payload));
  assert.equal(deniedUpdate.payload.code, "PORTAL_PERMISSION_DENIED");
  assert.deepEqual({ ...db.prepare(`
    SELECT full_name, nickname, home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = '899'
  `).get() }, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, updateAuditBefore);
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(targetSession.id).revoked_at, null);
});

test("Employee-Mutationen prüfen Scope, Anzeigenrechte und Learning-Hierarchie live", async () => {
  const developer = session("101", "developer");
  const managerNumber = "892";
  const createdManager = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload(managerNumber, {
      accessProfile: { role: "manager", permissions: [] },
    }),
  });
  assert.equal(createdManager.response.status, 201, JSON.stringify(createdManager.payload));
  for (const permission of [
    "employees:write",
    "employees:display:write",
    "employees:nickname:write",
  ]) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, ?, '101')
    `).run(managerNumber, permission);
  }
  const restoreManagerScope = () => {
    db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?")
      .run(managerNumber);
    db.prepare(`
      INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, '101')
    `).run(managerNumber, locationId);
  };

  let manager = session(managerNumber, "manager");
  let auditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  let dropTrigger = installSessionTouchRaceMutation(manager, `
    DELETE FROM portal_access_scopes WHERE employee_number = ${sqliteText(managerNumber)};
  `);
  try {
    const denied = await request("/api/employees", {
      method: "POST",
      auth: manager,
      body: employeePayload("899"),
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_SCOPE_DENIED");
    assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '899'").get(), undefined);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), auditBefore);
  } finally {
    dropTrigger();
    restoreManagerScope();
  }

  const createdTarget = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload("899"),
  });
  assert.equal(createdTarget.response.status, 201, JSON.stringify(createdTarget.payload));
  const employeeBefore = { ...db.prepare(`
    SELECT full_name, nickname, color, active
    FROM employees WHERE personnel_number = '899'
  `).get() };
  manager = session(managerNumber, "manager");
  auditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  dropTrigger = installSessionTouchRaceMutation(manager, `
    DELETE FROM portal_access_scopes WHERE employee_number = ${sqliteText(managerNumber)};
  `);
  try {
    const denied = await request("/api/employees/899", {
      method: "PUT",
      auth: manager,
      body: employeePayload("899", { nickname: "ScopeRaceDenied" }),
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_SCOPE_DENIED");
    assert.deepEqual({ ...db.prepare(`
      SELECT full_name, nickname, color, active
      FROM employees WHERE personnel_number = '899'
    `).get() }, employeeBefore);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), auditBefore);
  } finally {
    dropTrigger();
    restoreManagerScope();
  }

  db.prepare("UPDATE locations SET active = 0 WHERE id = ?").run(locationId);
  try {
    manager = session(managerNumber, "manager");
    auditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
    const denied = await request("/api/employees/899", {
      method: "PUT",
      auth: manager,
      body: employeePayload("899", { nickname: "InactiveScopeDenied" }),
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_SCOPE_DENIED");
    assert.deepEqual({ ...db.prepare(`
      SELECT full_name, nickname, color, active
      FROM employees WHERE personnel_number = '899'
    `).get() }, employeeBefore);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), auditBefore);
  } finally {
    db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(locationId);
  }

  manager = session(managerNumber, "manager");
  auditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  dropTrigger = installSessionTouchRaceMutation(manager, `
    INSERT OR IGNORE INTO portal_permission_denials
      (employee_number, permission, denied_by)
    VALUES (
      ${sqliteText(managerNumber)},
      'employees:nickname:write',
      'employee-display-live-race'
    );
  `);
  try {
    const denied = await request("/api/employees/899/display", {
      method: "PATCH",
      auth: manager,
      body: { nickname: "DisplayRaceDenied" },
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "EMPLOYEE_NICKNAME_WRITE_DENIED");
    assert.equal(db.prepare("SELECT nickname FROM employees WHERE personnel_number = '899'")
      .get().nickname, employeeBefore.nickname);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), auditBefore);
  } finally {
    dropTrigger();
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ? AND permission = 'employees:nickname:write'
    `).run(managerNumber);
  }

  const createdAl = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload("893", {
      preferredDepartmentId: departmentId,
      accessProfile: { role: "department_manager", permissions: [] },
    }),
  });
  assert.equal(createdAl.response.status, 201, JSON.stringify(createdAl.payload));
  const targetPortalSession = session("893", "department_manager");
  const targetMobileSession = mobileSession("893");
  manager = session(managerNumber, "manager");
  auditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  dropTrigger = installSessionTouchRaceMutation(manager, `
    INSERT OR IGNORE INTO portal_permission_denials
      (employee_number, permission, denied_by)
    VALUES (
      ${sqliteText(managerNumber)},
      'personnel:learning:cross_location:assign',
      'employee-delete-live-race'
    );
  `);
  try {
    const denied = await request("/api/employees/893", {
      method: "DELETE",
      auth: manager,
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
    assert.equal(Number(db.prepare("SELECT active FROM employees WHERE personnel_number = '893'")
      .get().active), 1);
    assert.equal(Number(db.prepare("SELECT active FROM portal_users WHERE employee_number = '893'")
      .get().active), 1);
    assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
      .get(targetPortalSession.id).revoked_at, null);
    const mobile = db.prepare("SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?")
      .get(targetMobileSession);
    assert.equal(mobile.revoked_at, null);
    assert.equal(mobile.revoked_reason, "");
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), auditBefore);
  } finally {
    dropTrigger();
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ?
        AND permission = 'personnel:learning:cross_location:assign'
    `).run(managerNumber);
  }
});

test("Learning-Deaktivierung über PUT und DELETE erzeugt Scope-Delta und widerruft Sitzungen", async () => {
  const developer = session("101", "developer");
  for (const employeeNumber of ["894", "895"]) {
    const created = await request("/api/employees", {
      method: "POST",
      auth: developer,
      body: employeePayload(employeeNumber, {
        preferredDepartmentId: departmentId,
        accessProfile: { role: "department_manager", permissions: [] },
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  }

  const putPortalSession = session("894", "department_manager");
  const putMobileSession = mobileSession("894");
  const put = await request("/api/employees/894", {
    method: "PUT",
    auth: developer,
    body: employeePayload("894", {
      preferredDepartmentId: departmentId,
      active: false,
    }),
  });
  assert.equal(put.response.status, 200, JSON.stringify(put.payload));

  const deletePortalSession = session("895", "department_manager");
  const deleteMobileSession = mobileSession("895");
  const deleted = await request("/api/employees/895", {
    method: "DELETE",
    auth: developer,
  });
  assert.equal(deleted.response.status, 204, JSON.stringify(deleted.payload));

  for (const [employeeNumber, portal, mobile] of [
    ["894", putPortalSession, putMobileSession],
    ["895", deletePortalSession, deleteMobileSession],
  ]) {
    assert.equal(Number(db.prepare("SELECT active FROM employees WHERE personnel_number = ?")
      .get(employeeNumber).active), 0);
    assert.equal(Number(db.prepare("SELECT active FROM portal_users WHERE employee_number = ?")
      .get(employeeNumber).active), 0);
    assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
      .get(portal.id).revoked_at);
    const mobileState = db.prepare(
      "SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?",
    ).get(mobile);
    assert.ok(mobileState.revoked_at);
    assert.equal(mobileState.revoked_reason, "employee_deactivated");
    const audit = db.prepare(`
      SELECT detail FROM audit_log
      WHERE action = 'personnel.learning.organization-scope.update'
        AND entity_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(employeeNumber);
    assert.ok(audit, employeeNumber);
    const detail = JSON.parse(audit.detail);
    assert.deepEqual(detail.scopeBefore, { locationId, departmentId });
    assert.equal(detail.scopeAfter, null);
    assert.equal(detail.sourceType, "employee");
    assert.equal(detail.sourceId, employeeNumber);
    assert.equal(detail.reasonCode, "PRINCIPAL_ORGANIZATION_SCOPE_CHANGED");
  }
});

test("Create-, Display- und Delete-Auditfehler rollen alle Fachmutationen atomar zurück", async () => {
  const developer = session("101", "developer");
  const createAuditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  db.exec(`
    CREATE TRIGGER test_employee_create_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'employee.create'
    BEGIN
      SELECT RAISE(ABORT, 'test employee create audit abort');
    END;
  `);
  try {
    const failed = await request("/api/employees", {
      method: "POST",
      auth: developer,
      body: employeePayload("896", {
        accessProfile: { role: "manager", permissions: [] },
        personnelRecord: { phone: "+43 512 5550896" },
      }),
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '896'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = '896'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM portal_access_scopes WHERE employee_number = '896'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM personnel_sensitive_records WHERE employee_number = '896'").get(), undefined);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), createAuditBefore);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_employee_create_audit_abort");
  }

  const displayTarget = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload("897"),
  });
  assert.equal(displayTarget.response.status, 201, JSON.stringify(displayTarget.payload));
  const displayBefore = { ...db.prepare(
    "SELECT color, nickname FROM employees WHERE personnel_number = '897'",
  ).get() };
  const displayAuditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  db.exec(`
    CREATE TRIGGER test_employee_display_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'employee.display.update'
    BEGIN
      SELECT RAISE(ABORT, 'test employee display audit abort');
    END;
  `);
  try {
    const failed = await request("/api/employees/897/display", {
      method: "PATCH",
      auth: developer,
      body: { color: "#123456", nickname: "DisplayRollback" },
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.deepEqual({ ...db.prepare(
      "SELECT color, nickname FROM employees WHERE personnel_number = '897'",
    ).get() }, displayBefore);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), displayAuditBefore);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_employee_display_audit_abort");
  }

  const deleteTarget = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload("898", {
      preferredDepartmentId: departmentId,
      accessProfile: { role: "department_manager", permissions: [] },
    }),
  });
  assert.equal(deleteTarget.response.status, 201, JSON.stringify(deleteTarget.payload));
  const targetPortalSession = session("898", "department_manager");
  const targetMobileSession = mobileSession("898");
  const deleteAuditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  db.exec(`
    CREATE TRIGGER test_employee_delete_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'employee.deactivate'
    BEGIN
      SELECT RAISE(ABORT, 'test employee delete audit abort');
    END;
  `);
  try {
    const failed = await request("/api/employees/898", {
      method: "DELETE",
      auth: developer,
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.equal(Number(db.prepare("SELECT active FROM employees WHERE personnel_number = '898'")
      .get().active), 1);
    assert.equal(Number(db.prepare("SELECT active FROM portal_users WHERE employee_number = '898'")
      .get().active), 1);
    assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
      .get(targetPortalSession.id).revoked_at, null);
    const mobile = db.prepare("SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?")
      .get(targetMobileSession);
    assert.equal(mobile.revoked_at, null);
    assert.equal(mobile.revoked_reason, "");
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), deleteAuditBefore);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_employee_delete_audit_abort");
  }
});

test("Employee-DTOS projizieren Learning-Rechte nur mit wirksamer Delegate-Authority", async () => {
  const target = "890";
  const localAl = "894";
  const developer = session("101", "developer");
  for (const [employeeNumber, role, preferredDepartmentId] of [
    [target, "manager", ""],
    [localAl, "department_manager", departmentId],
  ]) {
    const created = await request("/api/employees", {
      method: "POST",
      auth: developer,
      body: employeePayload(employeeNumber, {
        preferredDepartmentId,
        accessProfile: { role, permissions: [] },
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  }
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'personnel:learning:cross_location:assign', '101')
  `).run(target);
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'personnel:learning:assignments:write', '101')
  `).run(target);
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, 'personnel:learning:cross_location:assign', '101')
  `).run(target);
  db.exec("PRAGMA ignore_check_constraints = ON");
  try {
    db.prepare(`
      INSERT INTO portal_permission_scope_grants (
        employee_number, permission, location_id, department_id, approved_by
      ) VALUES (?, 'personnel:learning:assignments:write', ?, 0, '101')
    `).run(target, locationId);
  } finally {
    db.exec("PRAGMA ignore_check_constraints = OFF");
  }
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'employees:write', '101')
  `).run(localAl);
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(localAl);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, '101')
  `).run(localAl, locationId);

  const portalAccessFromList = async (auth) => {
    const listed = await request("/api/employees", { auth });
    assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
    const employee = listed.payload.find((entry) => entry.personnel_number === target);
    assert.ok(employee, JSON.stringify(listed.payload));
    return employee.portal_access;
  };

  assertLearningRightsVisibleInPortalAccess(await portalAccessFromList(developer), {
    permissionScope: true,
  });
  const hrWithDelegate = session("103", "hr");
  assertLearningRightsVisibleInPortalAccess(await portalAccessFromList(hrWithDelegate), {
    permissionScope: true,
  });
  const authorizedPut = await request(`/api/employees/${target}`, {
    method: "PUT",
    auth: hrWithDelegate,
    body: employeePayload(target),
  });
  assert.equal(authorizedPut.response.status, 200, JSON.stringify(authorizedPut.payload));
  assertLearningRightsVisibleInPortalAccess(authorizedPut.payload.portal_access, {
    permissionScope: true,
  });

  const liveProjectionPut = await withPermissionRevokedAtNextPersonnelTransaction(
    hrWithDelegate,
    "103",
    "personnel:learning:delegate",
    () => request(`/api/employees/${target}`, {
      method: "PUT",
      auth: hrWithDelegate,
      body: employeePayload(target, { nickname: "Live DTO" }),
    }),
  );
  assert.equal(
    liveProjectionPut.response.status,
    200,
    JSON.stringify(liveProjectionPut.payload),
  );
  assertNoLearningRightsInPortalAccess(liveProjectionPut.payload.portal_access);
  assert.equal(liveProjectionPut.payload.nickname, "Live DTO");

  const unauthorizedActors = [
    { employeeNumber: "106", role: "it_admin", denyDelegate: false },
    { employeeNumber: localAl, role: "department_manager", denyDelegate: false },
    { employeeNumber: "101", role: "admin", denyDelegate: true },
    { employeeNumber: "103", role: "hr", denyDelegate: true },
  ];
  for (const actor of unauthorizedActors) {
    if (actor.denyDelegate) {
      db.prepare(`
        INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
        VALUES (?, 'personnel:learning:delegate', 'dto-test')
      `).run(actor.employeeNumber);
    }
    try {
      const auth = session(actor.employeeNumber, actor.role);
      const listedProfile = await portalAccessFromList(auth);
      assertNoLearningRightsInPortalAccess(listedProfile);
      assert.equal(listedProfile.role, "manager");
      assert.equal(listedProfile.configured, true);
      assert.equal(listedProfile.rolePermissions.includes("schedule:read"), true);
      assert.deepEqual(listedProfile.scopes, [{
        locationId,
        departmentId: null,
      }]);
      const updated = await request(`/api/employees/${target}`, {
        method: "PUT",
        auth,
        body: employeePayload(target),
      });
      assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
      assertNoLearningRightsInPortalAccess(updated.payload.portal_access);
      assert.equal(updated.payload.portal_access.role, "manager");
      assert.equal(updated.payload.portal_access.rolePermissions.includes("schedule:read"), true);
    } finally {
      if (actor.denyDelegate) {
        db.prepare(`
          DELETE FROM portal_permission_denials
          WHERE employee_number = ? AND permission = 'personnel:learning:delegate'
        `).run(actor.employeeNumber);
      }
    }
  }

  const postEmployeeNumber = "895";
  db.exec(`
    CREATE TRIGGER test_employee_dto_learning_profile
    AFTER INSERT ON employees
    WHEN NEW.personnel_number = '${postEmployeeNumber}'
    BEGIN
      INSERT INTO portal_users (
        employee_number, password_hash, role, active, must_change_password,
        password_changed_at, updated_at
      ) VALUES (
        NEW.personnel_number, 'test-only', 'manager', 1, 0,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    END;
  `);
  try {
    const itAdmin = session("106", "it_admin");
    const created = await request("/api/employees", {
      method: "POST",
      auth: itAdmin,
      body: employeePayload(postEmployeeNumber),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.equal(created.payload.portal_access.role, "manager");
    assertNoLearningRightsInPortalAccess(created.payload.portal_access);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_employee_dto_learning_profile");
  }
});

test("Identisches Employee-Full-Form-Save mit AccessProfile bleibt nebenwirkungsfrei", async () => {
  const employeeNumber = "899";
  const developer = session("101", "developer");
  const fullForm = employeePayload(employeeNumber, {
    accessProfile: { role: "manager", permissions: [] },
  });
  const created = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: fullForm,
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));

  const targetPortalSession = session(employeeNumber, "manager");
  const targetMobileSession = mobileSession(employeeNumber);
  const employeeBefore = { ...db.prepare(`
    SELECT * FROM employees WHERE personnel_number = ?
  `).get(employeeNumber) };
  const accessBefore = { ...db.prepare(`
    SELECT role, active, must_change_password, updated_at
    FROM portal_users WHERE employee_number = ?
  `).get(employeeNumber) };
  const scopesBefore = db.prepare(`
    SELECT location_id, department_id FROM portal_access_scopes
    WHERE employee_number = ? ORDER BY location_id, department_id
  `).all(employeeNumber).map((row) => ({ ...row }));
  const auditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);

  const noOp = await request(`/api/employees/${employeeNumber}`, {
    method: "PUT",
    auth: developer,
    body: fullForm,
  });
  assert.equal(noOp.response.status, 200, JSON.stringify(noOp.payload));
  assert.deepEqual({ ...db.prepare(`
    SELECT * FROM employees WHERE personnel_number = ?
  `).get(employeeNumber) }, employeeBefore);
  assert.deepEqual({ ...db.prepare(`
    SELECT role, active, must_change_password, updated_at
    FROM portal_users WHERE employee_number = ?
  `).get(employeeNumber) }, accessBefore);
  assert.deepEqual(db.prepare(`
    SELECT location_id, department_id FROM portal_access_scopes
    WHERE employee_number = ? ORDER BY location_id, department_id
  `).all(employeeNumber).map((row) => ({ ...row })), scopesBefore);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), auditBefore);
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(targetPortalSession.id).revoked_at, null);
  const mobile = db.prepare("SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?")
    .get(targetMobileSession);
  assert.equal(mobile.revoked_at, null);
  assert.equal(mobile.revoked_reason, "");
});

test("Learning-Denial bleibt außerhalb der zentralen Rechteverwaltung unverändert", async () => {
  const developer = session("101", "developer");
  const employeeNumber = "891";
  const created = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload(employeeNumber, {
      accessProfile: { role: "manager", permissions: [] },
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, 'personnel:learning:cross_location:assign', 'learning-pl-plus')
  `).run(employeeNumber);
  db.prepare(`
    INSERT INTO personnel_learning_permission_denial_authorities (
      employee_number, permission, authority_level, scope_location_id,
      denied_by, created_at, updated_at, revision
    ) VALUES (
      ?, 'personnel:learning:cross_location:assign', 'pl_plus', '',
      'learning-pl-plus', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
    )
  `).run(employeeNumber);
  const authorityBefore = db.prepare(`
    SELECT authority_level, scope_location_id, generation_id, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ?
  `).get(employeeNumber);
  const auditCountBefore = db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'employee.access-profile.update' AND entity_id = ?
  `).get(employeeNumber).count;

  const blocked = await request(`/api/employees/${employeeNumber}`, {
    method: "PUT",
    auth: developer,
    body: employeePayload(employeeNumber, {
      accessProfile: { role: "manager", permissions: [] },
    }),
  });
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, "PERSONNEL_LIFECYCLE_RIGHTS_PROFILE_PROTECTED");
  assert.deepEqual({ ...db.prepare(`
    SELECT authority_level, scope_location_id, generation_id, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ?
  `).get(employeeNumber) }, { ...authorityBefore });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_permission_denials
    WHERE employee_number = ? AND permission = 'personnel:learning:cross_location:assign'
  `).get(employeeNumber).count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'employee.access-profile.update' AND entity_id = ?
  `).get(employeeNumber).count, auditCountBefore);
});

test("v0.58: IT-Admin kann credentiallos keine Learning-Standardrolle erzeugen", async () => {
  const itAdmin = session("106", "it_admin");
  for (const [personnelNumber, role] of [
    ["886", "manager"],
    ["895", "department_manager"],
    ["896", "hr"],
  ]) {
    const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count;
    const denied = await request("/api/employees", {
      method: "POST",
      auth: itAdmin,
      body: employeePayload(personnelNumber, {
        preferredDepartmentId: role === "department_manager" ? departmentId : "",
        accessProfile: { role, permissions: [] },
      }),
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
    assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(personnelNumber), undefined);
    assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = ?").get(personnelNumber), undefined);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM portal_access_scopes WHERE employee_number = ?
    `).get(personnelNumber).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, auditBefore);
  }
});

test("Learning-Organisationsscope wird vor Stammdatenmutation fachlich geprueft", async () => {
  if (!departmentId) return;
  const developer = session("101", "developer");
  const employeeNumber = "897";
  const created = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload(employeeNumber, {
      preferredDepartmentId: departmentId,
      accessProfile: { role: "department_manager", permissions: [] },
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));

  const targetSession = session(employeeNumber, "department_manager");
  const targetMobileSession = mobileSession(employeeNumber);
  const employeeBefore = { ...db.prepare(`
    SELECT home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ?
  `).get(employeeNumber) };
  const scopesBefore = db.prepare(`
    SELECT location_id, department_id
    FROM portal_access_scopes WHERE employee_number = ?
    ORDER BY location_id, department_id
  `).all(employeeNumber).map((row) => ({ ...row }));
  const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count;

  const itAdmin = session("106", "it_admin");
  const denied = await request(`/api/employees/${employeeNumber}`, {
    method: "PUT",
    auth: itAdmin,
    body: employeePayload(employeeNumber, { preferredDepartmentId: "" }),
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.deepEqual({ ...db.prepare(`
    SELECT home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ?
  `).get(employeeNumber) }, employeeBefore);
  assert.deepEqual(db.prepare(`
    SELECT location_id, department_id
    FROM portal_access_scopes WHERE employee_number = ?
    ORDER BY location_id, department_id
  `).all(employeeNumber).map((row) => ({ ...row })), scopesBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, auditBefore);
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(targetSession.id).revoked_at, null);

  const noOp = await request(`/api/employees/${employeeNumber}`, {
    method: "PUT",
    auth: itAdmin,
    body: employeePayload(employeeNumber, { preferredDepartmentId: departmentId }),
  });
  assert.equal(noOp.response.status, 200, JSON.stringify(noOp.payload));
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(targetSession.id).revoked_at, null);
  assert.equal(db.prepare("SELECT revoked_at FROM mobile_sessions WHERE id = ?")
    .get(targetMobileSession).revoked_at, null);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_log
    WHERE action = 'personnel.learning.organization-scope.update'
      AND entity_id = ?
  `).get(employeeNumber).count, 0);

  const allowed = await request(`/api/employees/${employeeNumber}`, {
    method: "PUT",
    auth: developer,
    body: employeePayload(employeeNumber, { preferredDepartmentId: "" }),
  });
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
  assert.equal(db.prepare(`
    SELECT preferred_department_id FROM employees WHERE personnel_number = ?
  `).get(employeeNumber).preferred_department_id, null);
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(targetSession.id).revoked_at);
  const revokedMobileSession = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
  `).get(targetMobileSession);
  assert.ok(revokedMobileSession.revoked_at);
  assert.equal(revokedMobileSession.revoked_reason, "learning_organization_scope_changed");
  const learningAudit = db.prepare(`
    SELECT detail
    FROM audit_log
    WHERE action = 'personnel.learning.organization-scope.update'
      AND entity_type = 'portal_user' AND entity_id = ?
  `).get(employeeNumber);
  assert.ok(learningAudit);
  const learningDetail = JSON.parse(learningAudit.detail);
  assert.deepEqual(Object.keys(learningDetail).sort(), [
    "reasonCode",
    "schemaVersion",
    "scopeAfter",
    "scopeBefore",
    "sourceId",
    "sourceType",
  ]);
  assert.deepEqual(learningDetail, {
    schemaVersion: 1,
    sourceType: "employee",
    sourceId: employeeNumber,
    scopeBefore: { locationId, departmentId },
    scopeAfter: null,
    reasonCode: "PRINCIPAL_ORGANIZATION_SCOPE_CHANGED",
  });
});

test("Learning-Employee-Scope, Sitzungen und Audits rollen bei Auditfehler gemeinsam zurueck", async () => {
  if (!departmentId) return;
  const developer = session("101", "developer");
  const employeeNumber = "898";
  const created = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload(employeeNumber, {
      preferredDepartmentId: departmentId,
      accessProfile: { role: "department_manager", permissions: [] },
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const targetSession = session(employeeNumber, "department_manager");
  const targetMobileSession = mobileSession(employeeNumber);
  const employeeBefore = { ...db.prepare(`
    SELECT home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ?
  `).get(employeeNumber) };
  const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count;
  db.exec(`
    CREATE TRIGGER test_employee_update_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'employee.update'
    BEGIN
      SELECT RAISE(ABORT, 'test employee update audit abort');
    END;
  `);
  try {
    const failed = await request(`/api/employees/${employeeNumber}`, {
      method: "PUT",
      auth: developer,
      body: employeePayload(employeeNumber, { preferredDepartmentId: "" }),
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.deepEqual({ ...db.prepare(`
      SELECT home_location_id, preferred_department_id
      FROM employees WHERE personnel_number = ?
    `).get(employeeNumber) }, employeeBefore);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, auditBefore);
    assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
      .get(targetSession.id).revoked_at, null);
    const mobile = db.prepare(`
      SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
    `).get(targetMobileSession);
    assert.equal(mobile.revoked_at, null);
    assert.equal(mobile.revoked_reason, "");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_employee_update_audit_abort");
  }
});

test("Learning-Organisationsscope folgt FL-, AL- und PL+-Hierarchie", async () => {
  if (!departmentId) return;
  let alternateDepartmentId = Number(db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1 AND id <> ?
    ORDER BY id LIMIT 1
  `).get(locationId, departmentId)?.id || 0);
  if (!alternateDepartmentId) {
    alternateDepartmentId = Number(db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, ?, 0, 1, 9581)
    `).run(locationId, `Learning Hierarchie ${crypto.randomUUID()}`).lastInsertRowid);
  }
  const developer = session("101", "developer");
  for (const [employeeNumber, role, preferredDepartmentId] of [
    ["892", "manager", ""],
    ["893", "department_manager", departmentId],
  ]) {
    const created = await request("/api/employees", {
      method: "POST",
      auth: developer,
      body: employeePayload(employeeNumber, {
        preferredDepartmentId,
        accessProfile: { role, permissions: [] },
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  }
  for (const employeeNumber of ["892", "893"]) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, 'employees:write', '101')
    `).run(employeeNumber);
  }

  const assignment = () => ({ ...db.prepare(`
    SELECT home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = '893'
  `).get() });
  const updateAssignment = (auth, preferredDepartmentId) => request("/api/employees/893", {
    method: "PUT",
    auth,
    body: employeePayload("893", { preferredDepartmentId }),
  });
  const assertDeniedWithoutSideEffects = async (auth, preferredDepartmentId) => {
    const before = assignment();
    const auditBefore = db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count;
    const denied = await updateAssignment(auth, preferredDepartmentId);
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED",
      JSON.stringify(denied.payload));
    assert.deepEqual(assignment(), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, auditBefore);
  };

  const manager = session("892", "manager");
  const managerAllowed = await updateAssignment(manager, alternateDepartmentId);
  assert.equal(managerAllowed.response.status, 200, JSON.stringify(managerAllowed.payload));
  assert.equal(assignment().preferred_department_id, alternateDepartmentId);

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES ('892', 'personnel:learning:cross_location:assign', '103')
  `).run();
  await assertDeniedWithoutSideEffects(manager, departmentId);
  db.prepare(`
    DELETE FROM portal_permission_denials
    WHERE employee_number = '892' AND permission = 'personnel:learning:cross_location:assign'
  `).run();

  const hr = session("103", "hr");
  const hrAllowed = await updateAssignment(hr, departmentId);
  assert.equal(hrAllowed.response.status, 200, JSON.stringify(hrAllowed.payload));
  assert.equal(assignment().preferred_department_id, departmentId);

  for (const [actorEmployeeNumber, role] of [["103", "hr"], ["101", "admin"]]) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, 'personnel:learning:delegate', 'learning-test')
    `).run(actorEmployeeNumber);
    try {
      await assertDeniedWithoutSideEffects(session(actorEmployeeNumber, role), alternateDepartmentId);
    } finally {
      db.prepare(`
        DELETE FROM portal_permission_denials
        WHERE employee_number = ? AND permission = 'personnel:learning:delegate'
      `).run(actorEmployeeNumber);
    }
  }

  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = '893'").run();
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES ('893', ?, 0, '101')
  `).run(locationId);
  await assertDeniedWithoutSideEffects(
    session("893", "department_manager"),
    alternateDepartmentId,
  );
});

test("v0.58: ungültiges Rechteprofil rollt die komplette Neuanlage zurück", async () => {
  const developer = session("101", "developer");
  const result = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload("881", {
      accessProfile: { role: "manager", permissions: ["developer:system"] },
    }),
  });
  assert.equal(result.response.status, 403, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '881'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = '881'").get(), undefined);
});

test("Personalmodul R1: konkurrierender AccessProfile-Scope endet kontrolliert und atomar", async () => {
  const developer = session("101", "developer");
  const employeeNumber = "889";
  db.exec(`
    CREATE TRIGGER test_access_profile_scope_unique_race
    BEFORE INSERT ON portal_access_scopes
    WHEN NEW.employee_number = '${employeeNumber}'
    BEGIN
      INSERT INTO portal_access_scopes (
        employee_number, location_id, department_id, assigned_by
      ) VALUES (
        NEW.employee_number, NEW.location_id, NEW.department_id, NEW.assigned_by
      );
    END;
  `);
  try {
    const result = await request("/api/employees", {
      method: "POST",
      auth: developer,
      body: employeePayload(employeeNumber, {
        accessProfile: { role: "manager", permissions: [] },
      }),
    });
    assert.equal(result.response.status, 409, JSON.stringify(result.payload));
    assert.equal(result.payload.code, "PERSONNEL_LIFECYCLE_SCOPE_CONCURRENT_CHANGE");
    assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(employeeNumber), undefined);
    assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = ?").get(employeeNumber), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_access_scopes WHERE employee_number = ?")
      .get(employeeNumber).count, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_access_profile_scope_unique_race");
  }
});

test("v0.58: PL darf Stammdaten anlegen, aber das geschützte Rechteprofil nicht ändern", async () => {
  const hr = session("103", "hr");
  const regular = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload("882"),
  });
  assert.equal(regular.response.status, 201, JSON.stringify(regular.payload));
  assert.equal(regular.payload.portal_access.configured, false);

  const denied = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload("883", { accessProfile: { role: "employee", permissions: [] } }),
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PERSONNEL_ACCESS_PROFILE_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '883'").get(), undefined);
});

test("v0.58: auch ein Admin darf das ausschließlich technische Rechteprofil nicht ändern", async () => {
  const admin = session("101", "admin");
  const denied = await request("/api/employees", {
    method: "POST",
    auth: admin,
    body: employeePayload("885", { accessProfile: { role: "hr", permissions: [] } }),
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PERSONNEL_ACCESS_PROFILE_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '885'").get(), undefined);
});

test("v0.58: Admin kann sich auch über die alte Zugangsverwaltung nicht zum IT-Admin hochstufen", async () => {
  const admin = session("101", "admin");
  const denied = await request("/api/portal/v1/users/102", {
    method: "PUT",
    auth: admin,
    body: { role: "it_admin", password: "987654", active: true, mustChangePassword: false },
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = '102'").get(), undefined);
});

test("v0.58: Developer-Ziel bleibt auch für den Developer selbst unveränderlich", async () => {
  const developer = session("101", "developer");
  const current = db.prepare("SELECT * FROM employees WHERE personnel_number = '101'").get();
  const result = await request("/api/employees/101", {
    method: "PUT",
    auth: developer,
    body: employeePayload("101", {
      fullName: current.full_name,
      nickname: current.nickname,
      contractedHours: current.contracted_hours,
      positionId: current.position_id,
      homeLocationId: current.home_location_id,
      preferredDepartmentId: current.preferred_department_id || "",
      color: current.color,
      accessProfile: { role: "employee", permissions: [] },
    }),
  });
  assert.equal(result.response.status, 403, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "PORTAL_DEVELOPER_PROTECTED");
  assert.equal(db.prepare("SELECT role FROM portal_users WHERE employee_number = '101'").get().role, "developer");
});

test("v0.58: Leitungsrolle erhält beim Speichern automatisch den passenden Bereich", async () => {
  if (!departmentId) return;
  const developer = session("101", "developer");
  const result = await request("/api/employees", {
    method: "POST",
    auth: developer,
    body: employeePayload("884", {
      preferredDepartmentId: departmentId,
      accessProfile: { role: "department_manager", permissions: [] },
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.deepEqual(db.prepare("SELECT location_id, department_id FROM portal_access_scopes WHERE employee_number = '884'").all().map((row) => ({ ...row })), [
    { location_id: locationId, department_id: departmentId },
  ]);
});

test("Personalmodul R1: Rechteprofile binden keine Leitungsrolle an inaktive Bereiche", async () => {
  if (!departmentId) return;
  const developer = session("101", "developer");
  const locationEmployee = "887";
  const departmentEmployee = "888";
  try {
    const createdLocationEmployee = await request("/api/employees", {
      method: "POST",
      auth: developer,
      body: employeePayload(locationEmployee),
    });
    assert.equal(createdLocationEmployee.response.status, 201, JSON.stringify(createdLocationEmployee.payload));
    db.prepare("UPDATE locations SET active = 0 WHERE id = ?").run(locationId);
    const inactiveLocation = await request(`/api/employees/${locationEmployee}`, {
      method: "PUT",
      auth: developer,
      body: employeePayload(locationEmployee, {
        accessProfile: { role: "manager", permissions: [] },
      }),
    });
    assert.equal(inactiveLocation.response.status, 409, JSON.stringify(inactiveLocation.payload));
    assert.equal(inactiveLocation.payload.code, "PORTAL_SCOPE_LOCATION_INACTIVE");
    assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = ?").get(locationEmployee), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_access_scopes WHERE employee_number = ?")
      .get(locationEmployee).count, 0);

    db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(locationId);
    const createdDepartmentEmployee = await request("/api/employees", {
      method: "POST",
      auth: developer,
      body: employeePayload(departmentEmployee, { preferredDepartmentId: departmentId }),
    });
    assert.equal(createdDepartmentEmployee.response.status, 201, JSON.stringify(createdDepartmentEmployee.payload));
    db.prepare("UPDATE departments SET active = 0 WHERE id = ?").run(departmentId);
    const inactiveDepartment = await request(`/api/employees/${departmentEmployee}`, {
      method: "PUT",
      auth: developer,
      body: employeePayload(departmentEmployee, {
        preferredDepartmentId: departmentId,
        accessProfile: { role: "department_manager", permissions: [] },
      }),
    });
    assert.equal(inactiveDepartment.response.status, 409, JSON.stringify(inactiveDepartment.payload));
    assert.equal(inactiveDepartment.payload.code, "PORTAL_SCOPE_DEPARTMENT_INACTIVE");
    assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = ?").get(departmentEmployee), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_access_scopes WHERE employee_number = ?")
      .get(departmentEmployee).count, 0);
  } finally {
    db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(locationId);
    db.prepare("UPDATE departments SET active = 1 WHERE id = ?").run(departmentId);
  }
});

test("v0.58: bestehende Klartext-Personalaktfelder werden einmalig verschlüsselt und geleert", () => {
  const reportId = Number(db.prepare(`
    INSERT INTO amu_reports
      (employee_number, location_id, department_id, incapacity_from, incapacity_to, employee_note, review_note,
       reviewed_by, reviewed_at, retention_until, status, protected_payload)
    VALUES ('102', ?, NULL, '2027-09-01', '2027-09-03', 'Klartextnotiz', 'Geprüft', '101',
      '2027-09-04T10:00:00.000Z', '2029-09-03', 'reviewed', '')
  `).run(locationId).lastInsertRowid);
  const documentId = crypto.randomUUID();
  const storageKey = `${documentId.slice(0, 2)}/${documentId}.amu`;
  db.prepare(`
    INSERT INTO amu_documents
      (id, report_id, storage_key, original_filename, detected_mime, byte_size, sha256, scan_status,
       encryption_key_id, encryption_iv, encryption_tag, status, uploaded_by, protected_payload)
    VALUES (?, ?, ?, 'Befund.pdf', 'application/pdf', 1234, ?, 'clean', 'local-v1', '', '', 'active', '102', '')
  `).run(documentId, reportId, storageKey, "a".repeat(64));

  const migrated = migrateProtectedPersonnelRecords();
  assert.deepEqual(migrated, { reports: 1, documents: 1 });
  const report = db.prepare("SELECT * FROM amu_reports WHERE id = ?").get(reportId);
  const document = db.prepare("SELECT * FROM amu_documents WHERE id = ?").get(documentId);
  assert.equal(report.incapacity_from, "");
  assert.equal(report.employee_note, "");
  assert.equal(report.review_note, "");
  assert.match(report.protected_payload, /^enc:v2:/);
  assert.equal(document.original_filename, "");
  assert.equal(document.byte_size, 0);
  assert.match(document.protected_payload, /^enc:v2:/);
  const reportPayload = parseProtectedJson(report.protected_payload, {
    namespace: "personnel-record", recordId: String(reportId), field: "payload", employeeNumber: "102",
  });
  assert.equal(reportPayload.incapacityFrom, "2027-09-01");
  assert.equal(reportPayload.employeeNote, "Klartextnotiz");
  assert.equal(reportPayload.reviewNote, "Geprüft");
  assert.deepEqual(migrateProtectedPersonnelRecords(), { reports: 0, documents: 0 });
});

test("v0.58: Admin darf keine Datenbank über die geschützte API importieren", async () => {
  const admin = session("101", "admin");
  const denied = await requestRaw("/api/backup/import", { auth: admin, body: Buffer.alloc(2048) });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "BACKUP_IMPORT_ROLE_DENIED");
});

test("v0.87: unlesbarer DB-Import wird unter Windows erst geschlossen und dann entfernt", async () => {
  const itAdmin = session("106", "it_admin");
  const importDirectory = path.join(process.env.GRABENPLANER_DATA_DIR, "data");
  const pendingImports = () => fs.existsSync(importDirectory)
    ? fs.readdirSync(importDirectory).filter((name) => name.startsWith("pending-import-")).sort()
    : [];
  const before = pendingImports();
  const denied = await requestRaw("/api/backup/import", {
    auth: itAdmin,
    body: Buffer.alloc(2048),
  });
  assert.equal(denied.response.status, 400, JSON.stringify(denied.payload));
  assert.match(denied.payload.error, /keine lesbare SQLite-Backup-Datei/i);
  assert.deepEqual(pendingImports(), before);
});

test("v0.58: DB-Import lehnt auch bereinigte Personalakten mit fremdem Schlüssel ab", async () => {
  const foreignRoot = fs.mkdtempSync(path.join(testRoot, "foreign-personnel-key-"));
  const foreignStorage = createAmuStorage({
    rootDirectory: path.join(foreignRoot, "amu"),
    encryptionKeys: { foreign: Buffer.alloc(32, 0x5a) },
    activeKeyId: "foreign",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const importedPath = path.join(foreignRoot, "foreign.db");
  const imported = new DatabaseSync(importedPath);
  imported.exec(`
    CREATE TABLE amu_reports (
      id INTEGER PRIMARY KEY,
      employee_number TEXT NOT NULL,
      status TEXT NOT NULL,
      protected_payload TEXT NOT NULL DEFAULT ''
    );
  `);
  const context = { namespace: "personnel-record", recordId: "1", field: "payload", employeeNumber: "102" };
  imported.prepare("INSERT INTO amu_reports (id, employee_number, status, protected_payload) VALUES (1, '102', 'purged', ?)")
    .run(foreignStorage.protectRecord(JSON.stringify({ retentionUntil: "" }), context));
  imported.close();

  const itAdmin = session("106", "it_admin");
  const denied = await requestRaw("/api/backup/import", { auth: itAdmin, body: fs.readFileSync(importedPath) });
  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "AMU_FULL_RESTORE_REQUIRED");
});

test("v0.58: DB-Import prüft auch alte enc:v1-Personalaktfelder mit dem lokalen Schlüssel", async () => {
  const foreignRoot = fs.mkdtempSync(path.join(testRoot, "foreign-legacy-key-"));
  const foreignStorage = createAmuStorage({
    rootDirectory: path.join(foreignRoot, "amu"),
    encryptionKeys: { foreign: Buffer.alloc(32, 0x6b) },
    activeKeyId: "foreign",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const importedPath = path.join(foreignRoot, "foreign-v057.db");
  const imported = new DatabaseSync(importedPath);
  imported.exec(`
    CREATE TABLE amu_reports (
      id INTEGER PRIMARY KEY,
      employee_number TEXT NOT NULL,
      status TEXT NOT NULL,
      employee_note TEXT NOT NULL DEFAULT '',
      review_note TEXT NOT NULL DEFAULT ''
    );
  `);
  imported.prepare("INSERT INTO amu_reports (id, employee_number, status, employee_note) VALUES (1, '102', 'purged', ?)")
    .run(foreignStorage.protectText("Alte verschlüsselte Notiz"));
  imported.close();

  const itAdmin = session("106", "it_admin");
  const denied = await requestRaw("/api/backup/import", { auth: itAdmin, body: fs.readFileSync(importedPath) });
  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "AMU_FULL_RESTORE_REQUIRED");
});

test("v0.70 Block 2: sensible Personalaktfelder werden verschlüsselt gespeichert und feldgenau ausgegeben", async () => {
  const hr = session("103", "hr");
  const saved = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT",
    auth: hr,
    body: {
      phone: "+43 664 1234567",
      sensitive: {
        socialSecurityNumber: "1238010190",
        iban: "AT611904300234573201",
        bic: "BKAUATWW",
        accountHolder: "Demo Person",
        address: { street: "Musterweg 12", postalCode: "6020", city: "Innsbruck", country: "Österreich" },
      },
    },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.deepEqual(saved.payload.changedFields.sort(), [
    "accountHolder", "address.city", "address.postalCode", "address.street", "bic", "iban", "phone",
    "socialSecurityNumber",
  ]);

  const stored = db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number = '102'").get();
  assert.match(stored.protected_payload, /^enc:v2:/);
  assert.notEqual(stored.social_security_lookup, "1238010190");
  assert.equal(stored.protected_payload.includes("1238010190"), false);
  assert.equal(stored.protected_payload.includes("AT611904300234573201"), false);
  assert.equal(stored.protected_payload.includes("Musterweg"), false);

  const loaded = await request("/api/portal/v1/personnel-records/102", { auth: hr });
  assert.equal(loaded.response.status, 200, JSON.stringify(loaded.payload));
  assert.equal(loaded.payload.profile.phone, "+43 664 1234567");
  assert.equal(loaded.payload.profile.sensitive.socialSecurityNumber, "1238010190");
  assert.equal(loaded.payload.profile.sensitive.iban, "AT611904300234573201");
  assert.equal(loaded.payload.profile.sensitive.address.city, "Innsbruck");
  assert.equal(loaded.payload.access.canWriteSensitive, true);

  const audit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE action = 'personnel-record.update' AND entity_id = '102'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.ok(audit);
  assert.equal(audit.detail.includes("1238010190"), false);
  assert.equal(audit.detail.includes("AT611904300234573201"), false);
  assert.equal(audit.detail.includes("+43 664"), false);
  assert.match(audit.detail, /socialSecurityNumber/);
});

test("v0.70 Block 2: Leitungen sehen Telefon und private E-Mail, Telefon-Schreiben benötigt weiterhin Vertrauensstufe A", async () => {
  const hr = session("103", "hr");
  await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: hr,
    body: { phone: "+43 512 555111", sensitive: { socialSecurityNumber: "1238010190" } },
  });
  let manager = session("104", "manager");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES ('104', ?, 0, 'test')
  `).run(locationId);
  const visible = await request("/api/portal/v1/personnel-records/102", { auth: manager });
  assert.equal(visible.response.status, 200, JSON.stringify(visible.payload));
  assert.equal(visible.payload.profile.phone, "+43 512 555111");
  assert.deepEqual(visible.payload.profile.sensitive, { privateEmail: "" });
  assert.deepEqual(visible.payload.reports, []);
  assert.equal(visible.payload.access.canWritePhone, false);

  const withoutGrant = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: manager, body: { phone: "+43 512 555222" },
  });
  assert.equal(withoutGrant.response.status, 403, JSON.stringify(withoutGrant.payload));
  assert.equal(withoutGrant.payload.code, "PERSONNEL_PHONE_WRITE_DENIED");

  const delegated = await request("/api/portal/v1/rights/104", {
    method: "PUT", auth: hr, body: { permissions: ["personnel:phone:write"] },
  });
  assert.equal(delegated.response.status, 200, JSON.stringify(delegated.payload));
  manager = session("104", "manager");
  const withoutTrustA = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: manager, body: { phone: "+43 512 555222" },
  });
  assert.equal(withoutTrustA.response.status, 403, JSON.stringify(withoutTrustA.payload));
  assert.equal(withoutTrustA.payload.code, "PERSONNEL_PHONE_WRITE_DENIED");

  db.prepare("UPDATE employees SET time_confirmation_level = 'A' WHERE personnel_number = '104'").run();
  const changed = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: manager, body: { phone: "+43 512 555222" },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.deepEqual(changed.payload.changedFields, ["phone"]);

  db.prepare("UPDATE portal_settings SET value = '0' WHERE key = 'trust_levels_enabled'").run();
  const disabledPolicy = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: manager, body: { phone: "+43 512 555333" },
  });
  assert.equal(disabledPolicy.response.status, 403, JSON.stringify(disabledPolicy.payload));
  assert.equal(db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = '104'").get().time_confirmation_level, "A");
});

test("v0.70 Block 2: IT-Admin hat sensible Personaldaten nicht automatisch und doppelte SV-Nummern werden verhindert", async () => {
  const hr = session("103", "hr");
  const first = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: hr, body: { sensitive: { socialSecurityNumber: "1238010190" } },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));

  const itAdmin = session("106", "it_admin");
  const denied = await request("/api/portal/v1/personnel-records/102", { auth: itAdmin });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));

  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES ('106', 'personnel:sensitive:read', '101')
  `).run();
  const explicitlyAllowed = await request("/api/portal/v1/personnel-records/102", { auth: itAdmin });
  assert.equal(explicitlyAllowed.response.status, 200, JSON.stringify(explicitlyAllowed.payload));
  assert.equal(explicitlyAllowed.payload.profile.sensitive.socialSecurityNumber, "1238010190");
  assert.equal(explicitlyAllowed.payload.access.canWriteSensitive, false);

  const duplicate = await request("/api/portal/v1/personnel-records/105", {
    method: "PUT", auth: hr, body: { sensitive: { socialSecurityNumber: "1238010190" } },
  });
  assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.payload));
  assert.equal(duplicate.payload.code, "PERSONNEL_SOCIAL_SECURITY_DUPLICATE");

  const invalid = await request("/api/portal/v1/personnel-records/105", {
    method: "PUT", auth: hr, body: { sensitive: { socialSecurityNumber: "1230010190" } },
  });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
  assert.equal(invalid.payload.code, "PERSONNEL_SOCIAL_SECURITY_INVALID");
});

test("v0.70 Block 2: DB-Import lehnt sensible Personalakten mit fremdem Schlüssel ab", async () => {
  const foreignRoot = fs.mkdtempSync(path.join(testRoot, "foreign-sensitive-profile-"));
  const foreignStorage = createAmuStorage({
    rootDirectory: path.join(foreignRoot, "amu"),
    encryptionKeys: { foreign: Buffer.alloc(32, 0x7c) },
    activeKeyId: "foreign",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const importedPath = path.join(foreignRoot, "foreign-sensitive.db");
  const imported = new DatabaseSync(importedPath);
  imported.exec(`
    CREATE TABLE personnel_sensitive_records (
      employee_number TEXT PRIMARY KEY,
      protected_payload TEXT NOT NULL
    );
  `);
  const context = { namespace: "personnel-sensitive-record", recordId: "102", field: "payload", employeeNumber: "102" };
  imported.prepare("INSERT INTO personnel_sensitive_records (employee_number, protected_payload) VALUES ('102', ?)")
    .run(foreignStorage.protectRecord(JSON.stringify({ socialSecurityNumber: "1238010190" }), context));
  imported.close();

  const itAdmin = session("106", "it_admin");
  const denied = await requestRaw("/api/backup/import", { auth: itAdmin, body: fs.readFileSync(importedPath) });
  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "AMU_FULL_RESTORE_REQUIRED");
});

test("v0.70 Block 2: Personalakt-Oberfläche trennt Kontakt, sensible Daten und AUM-Verlauf kompakt", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(html, /id="personnelRecordForm"/);
  assert.match(html, /id="savePersonnelRecordButton"/);
  assert.match(script, /personnelRecordField\("socialSecurityNumber"/);
  assert.match(script, /personnel:sensitive:read/);
  assert.match(script, /phoneWriteRequiresTrustA/);
  assert.match(styles, /\.personnel-record-field-grid/);
  assert.match(styles, /\.sensitive-personnel-section/);
});

test("Personalmodul: DB-Import verwirft entschluesselbare, aber semantisch beschaedigte Bewerberdaten vor Aktivierung", async () => {
  const configuredFeatures = JSON.parse(
    String(db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get()?.value || "[]"),
  );
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
    .run(JSON.stringify([...new Set([...configuredFeatures, "personnelLifecycle"])]));

  const admin = session("101", "admin");
  const created = await request("/api/portal/v1/personnel-lifecycle/candidates", {
    method: "POST",
    auth: admin,
    body: {
      profile: {
        firstName: "Import",
        lastName: "Integritaet",
        email: "import-integrity@example.invalid",
      },
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const candidate = created.payload.candidate;
  const currentRow = db.prepare(
    "SELECT id, protected_payload, revision FROM candidates WHERE id = ?",
  ).get(candidate.id);
  assert.equal(currentRow.revision, 1);

  const importedPath = path.join(testRoot, "candidate-semantic-corruption.db");
  fs.rmSync(importedPath, { force: true });
  db.exec(`VACUUM INTO '${importedPath.replace(/'/g, "''")}'`);
  const imported = new DatabaseSync(importedPath);
  try {
    imported.prepare("UPDATE candidates SET revision = revision + 1 WHERE id = ?")
      .run(candidate.id);
    const corruptedRow = imported.prepare(
      "SELECT id, protected_payload, revision FROM candidates WHERE id = ?",
    ).get(candidate.id);
    assert.equal(corruptedRow.revision, 2);
    assert.equal(corruptedRow.protected_payload, currentRow.protected_payload);
    assert.equal(parseProtectedJson(corruptedRow.protected_payload, {
      namespace: "candidate-profile",
      recordId: candidate.id,
      field: "payload",
      employeeNumber: `candidate:${candidate.id}`,
    }).firstName, "Import");
  } finally {
    imported.close();
  }

  const importDirectory = path.join(process.env.GRABENPLANER_DATA_DIR, "data");
  const pendingImports = () => fs.existsSync(importDirectory)
    ? fs.readdirSync(importDirectory).filter((name) => name.startsWith("pending-import-")).sort()
    : [];
  const before = pendingImports();
  const denied = await requestRaw("/api/backup/import", {
    auth: session("106", "it_admin"),
    body: fs.readFileSync(importedPath),
  });
  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "AMU_FULL_RESTORE_REQUIRED");
  assert.deepEqual(pendingImports(), before);
  assert.deepEqual(
    db.prepare("SELECT id, protected_payload, revision FROM candidates WHERE id = ?").get(candidate.id),
    currentRow,
  );
});
