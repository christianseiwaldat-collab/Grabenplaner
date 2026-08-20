"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-cross-schedule-rights-"));
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
  CROSS_LOCATION_SCHEDULE_PERMISSIONS,
  CROSS_LOCATION_SCHEDULE_PERMISSION_IDS,
  CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS,
} = require("../lib/cross-location-schedule-access");
const subject = require("../server");
const { app, db, validateUsbEmployees } = subject;

const PREFIX = "cross-schedule-";
const EMPLOYEES = Object.freeze({
  hr: `${PREFIX}hr`,
  admin: `${PREFIX}admin`,
  itAdmin: `${PREFIX}it`,
  developer: `${PREFIX}developer`,
  manager: `${PREFIX}manager`,
  departmentManager: `${PREFIX}department-manager`,
  departmentManagerTwo: `${PREFIX}department-manager-two`,
  usbDepartmentManager: "9291001",
});

let httpServer;
let baseUrl;
let locationId;
let departmentId;
let positionId;

function parsePermissions(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(String(value || "[]")); } catch { return []; }
}

function ensureAccount(employeeNumber, role, department = null) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, position_id, active
    ) VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, ?, 1)
  `).run(employeeNumber, employeeNumber, employeeNumber, locationId, department, positionId);
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  if (role === "manager" || role === "department_manager") {
    db.prepare(`
      INSERT INTO portal_access_scopes (
        employee_number, location_id, department_id, assigned_by
      ) VALUES (?, ?, ?, ?)
    `).run(employeeNumber, locationId, role === "manager" ? 0 : department, EMPLOYEES.developer);
  }
}

function session(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
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
  const responseText = await response.text();
  let payload = null;
  try { payload = responseText ? JSON.parse(responseText) : null; } catch { payload = { raw: responseText }; }
  return { response, payload };
}

function rightsBody(grantedPermissions) {
  return {
    grantedPermissions,
    deniedPermissions: [],
    scopes: [{ locationId, departmentId }],
  };
}

function employeeBody(employeeNumber, accessProfile) {
  return {
    personnelNumber: employeeNumber,
    fullName: employeeNumber,
    nickname: employeeNumber,
    contractedHours: 38.5,
    positionId,
    homeLocationId: locationId,
    preferredDepartmentId: departmentId,
    preferredDayOff: "",
    fixedWorkdays: [],
    color: "#26785f",
    active: true,
    accessProfile,
  };
}

function assertFeatureRightsHidden(payload) {
  const serialized = JSON.stringify(payload);
  for (const permission of CROSS_LOCATION_SCHEDULE_PERMISSION_IDS) {
    assert.equal(serialized.includes(permission), false, permission);
  }
}

function assertFeatureRightsVisible(payload) {
  const serialized = JSON.stringify(payload);
  for (const permission of CROSS_LOCATION_SCHEDULE_PERMISSION_IDS) {
    assert.equal(serialized.includes(permission), true, permission);
  }
}

test.before(async () => {
  const location = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get();
  assert.ok(location);
  locationId = String(location.id);
  let department = db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1
    ORDER BY id LIMIT 1
  `).get(locationId);
  if (!department) {
    department = db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Standortübergreifender Test', 0, 1, 9291)
      RETURNING id
    `).get(locationId);
  }
  departmentId = Number(department.id);
  positionId = String(db.prepare("SELECT id FROM positions ORDER BY id LIMIT 1").get().id);
  ensureAccount(EMPLOYEES.hr, "hr");
  ensureAccount(EMPLOYEES.admin, "admin");
  ensureAccount(EMPLOYEES.itAdmin, "it_admin");
  ensureAccount(EMPLOYEES.developer, "developer");
  ensureAccount(EMPLOYEES.manager, "manager");
  ensureAccount(EMPLOYEES.departmentManager, "department_manager", departmentId);
  ensureAccount(EMPLOYEES.departmentManagerTwo, "department_manager", departmentId);
  ensureAccount(EMPLOYEES.usbDepartmentManager, "department_manager", departmentId);
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(() => {
  db.prepare(`DELETE FROM portal_sessions WHERE employee_number LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM portal_permission_grants WHERE employee_number LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM portal_permission_denials WHERE employee_number LIKE '${PREFIX}%'`).run();
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Block 1 API: Rollenstandards trennen FL, AL, PL+, IT und Developer", () => {
  const rows = new Map(db.prepare(`
    SELECT id, permissions FROM portal_roles
    WHERE id IN ('department_manager', 'manager', 'hr', 'admin', 'it_admin', 'developer')
  `).all().map((row) => [row.id, new Set(parsePermissions(row.permissions))]));
  assert.deepEqual(
    CROSS_LOCATION_SCHEDULE_PERMISSION_IDS.filter((permission) => rows.get("manager").has(permission)),
    [...CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS],
  );
  assert.deepEqual(
    CROSS_LOCATION_SCHEDULE_PERMISSION_IDS.filter((permission) => rows.get("department_manager").has(permission)),
    [],
  );
  for (const role of ["hr", "admin"]) {
    assert.deepEqual(
      CROSS_LOCATION_SCHEDULE_PERMISSION_IDS.filter((permission) => rows.get(role).has(permission)),
      [CROSS_LOCATION_SCHEDULE_PERMISSIONS.SETTINGS_WRITE],
    );
  }
  assert.deepEqual(
    CROSS_LOCATION_SCHEDULE_PERMISSION_IDS.filter((permission) => rows.get("it_admin").has(permission)),
    [],
  );
  assert.deepEqual(
    CROSS_LOCATION_SCHEDULE_PERMISSION_IDS.filter((permission) => rows.get("developer").has(permission)),
    [...CROSS_LOCATION_SCHEDULE_PERMISSION_IDS],
  );
});

test("Block 1 API: Zusatzrechte für AL erzwingen die vollständige Leserechtskette", async () => {
  const hr = session(EMPLOYEES.hr);
  const incomplete = await request(
    `/api/portal/v1/rights/${encodeURIComponent(EMPLOYEES.departmentManager)}`,
    {
      method: "PUT",
      auth: hr,
      body: rightsBody([CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_CREATE]),
    },
  );
  assert.equal(incomplete.response.status, 400, JSON.stringify(incomplete.payload));
  assert.equal(incomplete.payload.code, "PORTAL_PERMISSION_DEPENDENCY");
  const complete = await request(
    `/api/portal/v1/rights/${encodeURIComponent(EMPLOYEES.departmentManager)}`,
    {
      method: "PUT",
      auth: hr,
      body: rightsBody([
        CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ,
        CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_CREATE,
        CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_REVIEW,
      ]),
    },
  );
  assert.equal(complete.response.status, 200, JSON.stringify(complete.payload));
  const grants = db.prepare(`
    SELECT permission FROM portal_permission_grants
    WHERE employee_number = ? ORDER BY permission
  `).all(EMPLOYEES.departmentManager).map((row) => row.permission);
  assert.deepEqual(grants, [...CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS].sort());
});

test("Block 1 API: Entzug des Basis-Leserechts entzieht alle abhängigen FL-Grundrechte", async () => {
  const hr = session(EMPLOYEES.hr);
  const result = await request(
    `/api/portal/v1/rights/${encodeURIComponent(EMPLOYEES.manager)}`,
    {
      method: "PUT",
      auth: hr,
      body: {
        grantedPermissions: [],
        deniedPermissions: ["schedule:read"],
        scopes: [{ locationId, departmentId: null }],
      },
    },
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const denials = db.prepare(`
    SELECT permission FROM portal_permission_denials
    WHERE employee_number = ? ORDER BY permission
  `).all(EMPLOYEES.manager).map((row) => row.permission);
  assert.deepEqual(denials, [
    "schedule:read",
    "schedule:write",
    ...CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS,
  ].sort());
});

test("Block 1 API: IT und PL+ nach Metarechtsentzug können die Fachrechte weder sehen noch vergeben", async () => {
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(
    EMPLOYEES.hr,
    CROSS_LOCATION_SCHEDULE_PERMISSIONS.SETTINGS_WRITE,
    EMPLOYEES.developer,
  );
  for (const employeeNumber of [EMPLOYEES.itAdmin, EMPLOYEES.hr]) {
    const auth = session(employeeNumber);
    const roles = await request("/api/portal/v1/roles", { auth });
    assert.equal(roles.response.status, 200, JSON.stringify(roles.payload));
    assertFeatureRightsHidden(roles.payload);
    const rights = await request("/api/portal/v1/rights", { auth });
    assert.equal(rights.response.status, 200, JSON.stringify(rights.payload));
    assertFeatureRightsHidden(rights.payload);
    const denied = await request(
      `/api/portal/v1/rights/${encodeURIComponent(EMPLOYEES.departmentManagerTwo)}`,
      {
        method: "PUT",
        auth,
        body: rightsBody([CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ]),
      },
    );
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");
  }
});

test("Block 1 API: autorisierte PL+ und Developer erhalten den vollständigen, getrennten Katalog", async () => {
  for (const employeeNumber of [EMPLOYEES.admin, EMPLOYEES.developer]) {
    const auth = session(employeeNumber);
    const roles = await request("/api/portal/v1/roles", { auth });
    assert.equal(roles.response.status, 200, JSON.stringify(roles.payload));
    assertFeatureRightsVisible(roles.payload);
    const rights = await request("/api/portal/v1/rights", { auth });
    assert.equal(rights.response.status, 200, JSON.stringify(rights.payload));
    assertFeatureRightsVisible(rights.payload);
  }
});

test("Block 1 API: technisches Rechteprofil darf zentrale Fachrechte nicht entfernen", async () => {
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, ?)
  `).run(
    EMPLOYEES.departmentManagerTwo,
    CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ,
    EMPLOYEES.hr,
  );
  const developer = session(EMPLOYEES.developer);
  const blocked = await request(
    `/api/employees/${encodeURIComponent(EMPLOYEES.departmentManagerTwo)}`,
    {
      method: "PUT",
      auth: developer,
      body: employeeBody(EMPLOYEES.departmentManagerTwo, {
        role: "department_manager",
        permissions: [],
      }),
    },
  );
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, "CROSS_LOCATION_SCHEDULE_RIGHTS_PROFILE_PROTECTED");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_permission_grants
    WHERE employee_number = ? AND permission = ?
  `).get(
    EMPLOYEES.departmentManagerTwo,
    CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ,
  ).count, 1);
});

test("Block 1 API: USB-Profile respektieren das aktuell wirksame PL+-Metarecht", async () => {
  const source = db.prepare(`
    SELECT personnel_number, home_location_id
    FROM employees WHERE personnel_number = ?
  `).get(EMPLOYEES.usbDepartmentManager);
  assert.ok(source);
  const input = [{
    sourcePersonnelNumber: source.personnel_number,
    role: "department_manager",
    additionalPermissions: [CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ],
  }];
  await assert.rejects(
    validateUsbEmployees(input, [String(source.home_location_id)], {
      personnelNumber: EMPLOYEES.admin,
      role: "admin",
      permissions: ["personnel:learning:delegate"],
    }),
    { code: "USB_EMPLOYEE_PERMISSION_DENIED" },
  );
  const [validated] = await validateUsbEmployees(input, [String(source.home_location_id)], {
    personnelNumber: EMPLOYEES.admin,
    role: "admin",
    permissions: [
      "personnel:learning:delegate",
      CROSS_LOCATION_SCHEDULE_PERMISSIONS.SETTINGS_WRITE,
    ],
  });
  assert.equal(
    validated.additionalPermissions.includes(CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ),
    true,
  );
});
