"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v080-rights-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const {
  app,
  db,
  loadPortalSessionFromRequest,
  mobileSessionPrincipal,
  mobileSessionRow,
  releaseInstanceLockForTests,
} = subject;

const ADMIN = "v080-admin";
const MANAGER = "v080-manager";
const MARIA = "v080-maria";
const NO_DEPARTMENT = "v080-no-department";
const SHIFT_EMPLOYEE = "v080-shift";
const OTHER_SHIFT_EMPLOYEE = "v080-other-shift";
const WEEK = "2031-03-03";

let httpServer;
let baseUrl;
let locationId;
let departmentId;
let otherDepartmentId;
let adminSession;

function ensureEmployee(employeeNumber, fullName, department = null) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id,
       preferred_department_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId, department);
}

function createPortalSession(employeeNumber, role) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(id, employeeNumber, crypto.createHash("sha256").update(rawToken).digest("hex"));
  return {
    id,
    rawToken,
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function createMobileSession(employeeNumber) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mobile_sessions
      (id, employee_number, access_token_hash, access_expires_at,
       refresh_token_hash, refresh_expires_at, installation_id_hash,
       platform, device_label, app_version)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z',
            ?, '2099-12-31T23:59:59.000Z', ?, 'android', 'v0.80 Test', '0.4.0')
  `).run(
    id,
    employeeNumber,
    crypto.createHash("sha256").update(`access-${id}`).digest("hex"),
    crypto.createHash("sha256").update(`refresh-${id}`).digest("hex"),
    crypto.createHash("sha256").update(`install-${id}`).digest("hex"),
  );
  return id;
}

async function request(route, { method = "GET", session = adminSession, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
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

function rightsBody(grantedPermissions, deniedPermissions, scopes) {
  return { grantedPermissions, deniedPermissions, scopes };
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'v0.80 Fotowelt', 1, 1, 9080)
  `).run(locationId);
  db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'v0.80 Hardware', 1, 1, 9081)
  `).run(locationId);
  departmentId = Number(db.prepare("SELECT id FROM departments WHERE location_id = ? AND name = 'v0.80 Fotowelt'").get(locationId).id);
  otherDepartmentId = Number(db.prepare("SELECT id FROM departments WHERE location_id = ? AND name = 'v0.80 Hardware'").get(locationId).id);

  ensureEmployee(ADMIN, "Ada Administration");
  ensureEmployee(MANAGER, "Florian Filialleitung", departmentId);
  ensureEmployee(MARIA, "Maria Fotowelt", departmentId);
  ensureEmployee(NO_DEPARTMENT, "Nora Ohneabteilung");
  ensureEmployee(SHIFT_EMPLOYEE, "Simon Schicht", departmentId);
  ensureEmployee(OTHER_SHIFT_EMPLOYEE, "Hanna Hardware", otherDepartmentId);
  adminSession = createPortalSession(ADMIN, "admin");
  createPortalSession(MANAGER, "manager");
  createPortalSession(MARIA, "employee");
  createPortalSession(NO_DEPARTMENT, "employee");
  createPortalSession(SHIFT_EMPLOYEE, "employee");
  createPortalSession(OTHER_SHIFT_EMPLOYEE, "employee");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(MANAGER, locationId, ADMIN);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.80: Grundrecht kann entzogen und wiederhergestellt werden; alle Sitzungen werden widerrufen", async () => {
  const managerWeb = createPortalSession(MANAGER, "manager");
  const managerMobileId = createMobileSession(MANAGER);
  const changed = await request(`/api/portal/v1/rights/${MANAGER}`, {
    method: "PUT",
    body: rightsBody([], ["schedule:write"], [{ locationId, departmentId: null }]),
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  const user = changed.payload.users.find((entry) => entry.employeeNumber === MANAGER);
  assert.deepEqual(user.deniedPermissions, ["schedule:write"]);
  assert.equal(user.effectivePermissions.includes("schedule:read"), true);
  assert.equal(user.effectivePermissions.includes("schedule:write"), false);
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?").get(managerWeb.id).revoked_at);
  assert.ok(db.prepare("SELECT revoked_at FROM mobile_sessions WHERE id = ?").get(managerMobileId).revoked_at);

  const readOnly = createPortalSession(MANAGER, "manager");
  const readable = await request(`/api/schedule?week=${WEEK}&location=${locationId}`, { session: readOnly });
  assert.equal(readable.response.status, 200, JSON.stringify(readable.payload));
  const blockedWrite = await request("/api/shifts", {
    method: "POST",
    session: readOnly,
    body: {
      employeeNumber: SHIFT_EMPLOYEE,
      locationId,
      departmentId,
      date: WEEK,
      startTime: "09:00",
      endTime: "17:00",
      area: "Fotowelt",
      note: "",
    },
  });
  assert.equal(blockedWrite.response.status, 403, JSON.stringify(blockedWrite.payload));

  const restored = await request(`/api/portal/v1/rights/${MANAGER}`, {
    method: "PUT",
    body: rightsBody([], [], [{ locationId, departmentId: null }]),
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  const manager = restored.payload.users.find((entry) => entry.employeeNumber === MANAGER);
  assert.deepEqual(manager.deniedPermissions, []);
  assert.equal(manager.effectivePermissions.includes("schedule:write"), true);

  const writable = createPortalSession(MANAGER, "manager");
  const created = await request("/api/shifts", {
    method: "POST",
    session: writable,
    body: {
      employeeNumber: SHIFT_EMPLOYEE,
      locationId,
      departmentId,
      date: WEEK,
      startTime: "09:00",
      endTime: "17:00",
      area: "Fotowelt",
      note: "",
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
});

test("v0.80: Web und Mobile berechnen Entzüge identisch", async () => {
  const changed = await request(`/api/portal/v1/rights/${MANAGER}`, {
    method: "PUT",
    body: rightsBody([], ["schedule:write"], [{ locationId, departmentId: null }]),
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  const webAuth = createPortalSession(MANAGER, "manager");
  const mobileId = createMobileSession(MANAGER);
  const web = await loadPortalSessionFromRequest(
    { headers: { cookie: webAuth.cookie } },
    { touch: false },
  );
  const mobile = mobileSessionPrincipal(await mobileSessionRow(mobileId));
  assert.deepEqual(web.rolePermissions, mobile.rolePermissions);
  assert.deepEqual(web.grantedPermissions, mobile.grantedPermissions);
  assert.deepEqual(web.deniedPermissions, mobile.deniedPermissions);
  assert.deepEqual(web.permissions, mobile.permissions);
});

test("v0.80: Web und Mobile behandeln aktive, inaktive und echte Legacy-Scopes identisch", async () => {
  const webAuth = createPortalSession(MANAGER, "manager");
  const mobileId = createMobileSession(MANAGER);
  const project = async () => ({
    web: await loadPortalSessionFromRequest(
      { headers: { cookie: webAuth.cookie } },
      { touch: false },
    ),
    mobile: mobileSessionPrincipal(await mobileSessionRow(mobileId)),
    mobileRow: await mobileSessionRow(mobileId),
  });
  const expectedLocationScope = [{ locationId: String(locationId), departmentId: null }];

  let current = await project();
  assert.equal(Number(current.mobileRow.access_scope_assignment_count), 1);
  assert.deepEqual(current.web.explicitScopes, expectedLocationScope);
  assert.deepEqual(current.mobile.explicitScopes, expectedLocationScope);
  assert.deepEqual(current.web.scopes, expectedLocationScope);
  assert.deepEqual(current.mobile.scopes, expectedLocationScope);
  assert.deepEqual(current.web.permissionScopes, current.mobile.permissionScopes);

  db.prepare("UPDATE locations SET active = 0 WHERE id = ?").run(locationId);
  try {
    current = await project();
    assert.equal(Number(current.mobileRow.access_scope_assignment_count), 1);
    assert.deepEqual(current.web.explicitScopes, []);
    assert.deepEqual(current.mobile.explicitScopes, []);
    assert.deepEqual(current.web.scopes, []);
    assert.deepEqual(current.mobile.scopes, []);
    assert.deepEqual(current.web.permissionScopes, current.mobile.permissionScopes);
  } finally {
    db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(locationId);
  }

  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(MANAGER);
  try {
    current = await project();
    assert.equal(Number(current.mobileRow.access_scope_assignment_count), 0);
    assert.deepEqual(current.web.explicitScopes, []);
    assert.deepEqual(current.mobile.explicitScopes, []);
    assert.deepEqual(current.web.scopes, expectedLocationScope);
    assert.deepEqual(current.mobile.scopes, expectedLocationScope);

    db.prepare("UPDATE locations SET active = 0 WHERE id = ?").run(locationId);
    current = await project();
    assert.equal(Number(current.mobileRow.access_scope_assignment_count), 0);
    assert.deepEqual(current.web.scopes, []);
    assert.deepEqual(current.mobile.scopes, []);
  } finally {
    db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(locationId);
    db.prepare(`
      INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, ?)
    `).run(MANAGER, locationId, ADMIN);
  }
});

test("v0.80: echter AL-Legacy-Scope bleibt an eine aktive Stammabteilung gebunden", async () => {
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(MARIA);
  const webAuth = createPortalSession(MARIA, "department_manager");
  const mobileId = createMobileSession(MARIA);
  const project = async () => ({
    web: await loadPortalSessionFromRequest(
      { headers: { cookie: webAuth.cookie } },
      { touch: false },
    ),
    mobile: mobileSessionPrincipal(await mobileSessionRow(mobileId)),
    mobileRow: await mobileSessionRow(mobileId),
  });
  const expectedDepartmentScope = [{
    locationId: String(locationId),
    departmentId,
  }];

  let current = await project();
  assert.equal(Number(current.mobileRow.access_scope_assignment_count), 0);
  assert.equal(Number(current.mobileRow.home_location_active), 1);
  assert.equal(Number(current.mobileRow.preferred_department_active), 1);
  assert.deepEqual(current.web.explicitScopes, []);
  assert.deepEqual(current.mobile.explicitScopes, []);
  assert.deepEqual(current.web.scopes, expectedDepartmentScope);
  assert.deepEqual(current.mobile.scopes, expectedDepartmentScope);

  db.prepare("UPDATE departments SET active = 0 WHERE id = ?").run(departmentId);
  try {
    current = await project();
    assert.equal(Number(current.mobileRow.access_scope_assignment_count), 0);
    assert.equal(Number(current.mobileRow.home_location_active), 1);
    assert.equal(Number(current.mobileRow.preferred_department_active), 0);
    assert.deepEqual(current.web.scopes, []);
    assert.deepEqual(current.mobile.scopes, []);
  } finally {
    db.prepare("UPDATE departments SET active = 1 WHERE id = ?").run(departmentId);
  }
});

test("v0.80: gespeicherte Scope-Provenienz schränkt globale Rollen nicht versehentlich ein", async () => {
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(ADMIN, locationId, ADMIN);
  try {
    const web = await loadPortalSessionFromRequest(
      { headers: { cookie: adminSession.cookie } },
      { touch: false },
    );
    const mobile = mobileSessionPrincipal(await mobileSessionRow(createMobileSession(ADMIN)));
    const storedScope = [{ locationId: String(locationId), departmentId: null }];
    assert.deepEqual(web.explicitScopes, storedScope);
    assert.deepEqual(mobile.explicitScopes, storedScope);
    assert.deepEqual(web.scopes, []);
    assert.deepEqual(mobile.scopes, []);
  } finally {
    db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(ADMIN);
  }
});

test("v0.80: Maria kann nur die eigene Abteilung oder nach expliziter Freigabe die ganze Filiale planen", async () => {
  const departmentOnly = await request(`/api/portal/v1/rights/${MARIA}`, {
    method: "PUT",
    body: rightsBody(["schedule:read", "schedule:write"], [], [{ locationId, departmentId }]),
  });
  assert.equal(departmentOnly.response.status, 200, JSON.stringify(departmentOnly.payload));
  let maria = createPortalSession(MARIA, "employee");
  const ownDepartment = await request(`/api/schedule?week=${WEEK}&location=${locationId}&department=${departmentId}`, { session: maria });
  assert.equal(ownDepartment.response.status, 200, JSON.stringify(ownDepartment.payload));
  const wholeLocationBlocked = await request(`/api/schedule?week=${WEEK}&location=${locationId}`, { session: maria });
  assert.equal(wholeLocationBlocked.response.status, 403, JSON.stringify(wholeLocationBlocked.payload));
  const otherDepartmentBlocked = await request(`/api/schedule?week=${WEEK}&location=${locationId}&department=${otherDepartmentId}`, { session: maria });
  assert.equal(otherDepartmentBlocked.response.status, 403, JSON.stringify(otherDepartmentBlocked.payload));
  const ownDepartmentWrite = await request("/api/shifts", {
    method: "POST",
    session: maria,
    body: {
      employeeNumber: SHIFT_EMPLOYEE,
      locationId,
      departmentId,
      date: "2031-03-04",
      startTime: "09:00",
      endTime: "17:00",
      area: "Fotowelt",
      note: "",
    },
  });
  assert.equal(ownDepartmentWrite.response.status, 201, JSON.stringify(ownDepartmentWrite.payload));
  const otherDepartmentWriteBlocked = await request("/api/shifts", {
    method: "POST",
    session: maria,
    body: {
      employeeNumber: OTHER_SHIFT_EMPLOYEE,
      locationId,
      departmentId: otherDepartmentId,
      date: "2031-03-04",
      startTime: "09:00",
      endTime: "17:00",
      area: "Hardware",
      note: "",
    },
  });
  assert.equal(otherDepartmentWriteBlocked.response.status, 403, JSON.stringify(otherDepartmentWriteBlocked.payload));

  const wholeLocation = await request(`/api/portal/v1/rights/${MARIA}`, {
    method: "PUT",
    body: rightsBody(["schedule:read", "schedule:write"], [], [{ locationId, departmentId: null }]),
  });
  assert.equal(wholeLocation.response.status, 200, JSON.stringify(wholeLocation.payload));
  maria = createPortalSession(MARIA, "employee");
  const overall = await request(`/api/schedule?week=${WEEK}&location=${locationId}`, { session: maria });
  assert.equal(overall.response.status, 200, JSON.stringify(overall.payload));
  const wholeLocationWrite = await request("/api/shifts", {
    method: "POST",
    session: maria,
    body: {
      employeeNumber: OTHER_SHIFT_EMPLOYEE,
      locationId,
      departmentId: otherDepartmentId,
      date: "2031-03-05",
      startTime: "09:00",
      endTime: "17:00",
      area: "Hardware",
      note: "",
    },
  });
  assert.equal(wholeLocationWrite.response.status, 201, JSON.stringify(wholeLocationWrite.payload));
});

test("v0.80: Ohne Stammabteilung entsteht niemals stillschweigend ein Gesamtfilial-Recht", async () => {
  const denied = await request(`/api/portal/v1/rights/${NO_DEPARTMENT}`, {
    method: "PUT",
    body: rightsBody(["schedule:read", "schedule:write"], [], []),
  });
  assert.equal(denied.response.status, 400, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_SCOPE_REQUIRED");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_permission_grants WHERE employee_number = ?").get(NO_DEPARTMENT).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_access_scopes WHERE employee_number = ?").get(NO_DEPARTMENT).count, 0);
});

test("v0.80: Leserecht-Entzug normalisiert das abhängige Schreibrecht", async () => {
  const changed = await request(`/api/portal/v1/rights/${MANAGER}`, {
    method: "PUT",
    body: rightsBody([], ["schedule:read"], [{ locationId, departmentId: null }]),
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  const manager = changed.payload.users.find((entry) => entry.employeeNumber === MANAGER);
  assert.deepEqual(manager.deniedPermissions.filter((permission) => permission.startsWith("schedule:")),
    ["schedule:read", "schedule:write"]);
  assert.equal(manager.effectivePermissions.includes("schedule:read"), false);
  assert.equal(manager.effectivePermissions.includes("schedule:write"), false);
});

test("v0.80: Migration und Dashboard weisen entzogene Rechte transparent aus", async () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.80-revocable-role-rights'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portal_permission_denials'").get());
  const dashboard = await request("/api/portal/v1/rights-dashboard");
  assert.equal(dashboard.response.status, 200, JSON.stringify(dashboard.payload));
  const manager = dashboard.payload.users.find((entry) => entry.employeeNumber === MANAGER);
  const scheduleRead = manager.permissions.find((permission) => permission.id === "schedule:read");
  assert.equal(scheduleRead.revoked, true);
  assert.equal(scheduleRead.effective, false);
  assert.ok(dashboard.payload.summary.revokedRights >= 2);
});
