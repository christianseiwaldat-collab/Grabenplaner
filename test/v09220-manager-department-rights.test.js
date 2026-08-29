"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v09220-fl-al-rights-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db, releaseInstanceLockForTests } = require("../server");

const MANAGER = "v09220-fl";
const LOCAL_DEPARTMENT_MANAGER = "v09220-al-local";
const REMOTE_DEPARTMENT_MANAGER = "v09220-al-remote";
const LOCAL_EMPLOYEE = "v09220-ma-local";
const REMOTE_LOCATION = "v09220-remote";

let httpServer;
let baseUrl;
let localLocation;
let localDepartment;
let remoteDepartment;
let managerSession;
let localDepartmentManagerSessionId;

function ensureEmployee(employeeNumber, fullName, locationId, departmentId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id,
       preferred_department_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId, departmentId);
}

function createSession(employeeNumber, role) {
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active,
       must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(id, employeeNumber, crypto.createHash("sha256").update(rawToken).digest("hex"));
  return {
    id,
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json", Cookie: managerSession.cookie };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = managerSession.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

test.before(async () => {
  const local = db.prepare("SELECT id, day_settings_json FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get();
  localLocation = String(local.id);
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Entfernte Testfiliale', 1, ?, 1)
  `).run(REMOTE_LOCATION, local.day_settings_json || "{}");
  localDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Lokale AL-Abteilung', 1, 1, 99220)
  `).run(localLocation).lastInsertRowid);
  remoteDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Entfernte AL-Abteilung', 1, 1, 99221)
  `).run(REMOTE_LOCATION).lastInsertRowid);

  ensureEmployee(MANAGER, "Flora Filialleitung", localLocation, localDepartment);
  ensureEmployee(LOCAL_DEPARTMENT_MANAGER, "Anton Abteilungsleitung", localLocation, localDepartment);
  ensureEmployee(REMOTE_DEPARTMENT_MANAGER, "Rita Remoteleitung", REMOTE_LOCATION, remoteDepartment);
  ensureEmployee(LOCAL_EMPLOYEE, "Mona Mitarbeiterin", localLocation, localDepartment);

  managerSession = createSession(MANAGER, "manager");
  localDepartmentManagerSessionId = createSession(LOCAL_DEPARTMENT_MANAGER, "department_manager").id;
  createSession(REMOTE_DEPARTMENT_MANAGER, "department_manager");
  createSession(LOCAL_EMPLOYEE, "employee");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(MANAGER, localLocation, MANAGER);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, ?)
  `).run(LOCAL_DEPARTMENT_MANAGER, localLocation, localDepartment, MANAGER);

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

test("v0.92.20: FL entzieht nur AL-Grundrechte im eigenen Standort", async () => {
  const overview = await request("/api/portal/v1/rights");
  assert.equal(overview.response.status, 200, overview.text);
  assert.ok(overview.payload.users.some((user) => user.employeeNumber === LOCAL_DEPARTMENT_MANAGER));
  assert.ok(overview.payload.users.every((user) => (
    user.role === "department_manager" && user.homeLocationId === localLocation
  )));
  assert.equal(overview.payload.users.some((user) => user.employeeNumber === REMOTE_DEPARTMENT_MANAGER), false);
  assert.ok(overview.payload.catalog.some((permission) => permission.id === "time:review" && permission.editable));
  assert.equal(overview.payload.catalog.some((permission) => permission.id.startsWith("personnel:learning:")), false);
  assert.equal(overview.payload.catalog.some((permission) => permission.scopeBehavior === "global"), false);
  const localOverview = overview.payload.users
    .find((user) => user.employeeNumber === LOCAL_DEPARTMENT_MANAGER);
  assert.equal(Object.hasOwn(localOverview, "passwordConfigured"), false);
  assert.equal(Object.hasOwn(localOverview, "lastLoginAt"), false);
  assert.equal(localOverview.rolePermissions.some((permission) => permission.startsWith("personnel:learning:")), false);
  assert.deepEqual(localOverview.grantedPermissions, []);

  const denied = await request(`/api/portal/v1/rights/${LOCAL_DEPARTMENT_MANAGER}`, {
    method: "PUT",
    body: { grantedPermissions: [], deniedPermissions: ["time:review"] },
  });
  assert.equal(denied.response.status, 200, denied.text);
  const localAl = denied.payload.users.find((user) => user.employeeNumber === LOCAL_DEPARTMENT_MANAGER);
  assert.ok(localAl.deniedPermissions.includes("time:review"));
  assert.equal(localAl.effectivePermissions.includes("time:review"), false);
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(localDepartmentManagerSessionId).revoked_at);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE actor = ? AND action = 'portal.rights.update'
      AND entity_id = ?
  `).get(MANAGER, LOCAL_DEPARTMENT_MANAGER).count, 1);

  const additionalGrant = await request(`/api/portal/v1/rights/${LOCAL_DEPARTMENT_MANAGER}`, {
    method: "PUT",
    body: { grantedPermissions: ["amu:local:manage"], deniedPermissions: ["time:review"] },
  });
  assert.equal(additionalGrant.response.status, 403, additionalGrant.text);
  assert.equal(additionalGrant.payload.code, "MANAGER_DEPARTMENT_RIGHTS_DENIAL_ONLY");

  const protectedDenial = await request(`/api/portal/v1/rights/${LOCAL_DEPARTMENT_MANAGER}`, {
    method: "PUT",
    body: {
      grantedPermissions: [],
      deniedPermissions: ["time:review", "personnel:learning:catalog:read"],
    },
  });
  assert.equal(protectedDenial.response.status, 403, protectedDenial.text);
  assert.equal(protectedDenial.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");

  for (const target of [REMOTE_DEPARTMENT_MANAGER, LOCAL_EMPLOYEE]) {
    const outsideHierarchy = await request(`/api/portal/v1/rights/${target}`, {
      method: "PUT",
      body: { grantedPermissions: [], deniedPermissions: ["time:review"] },
    });
    assert.equal(outsideHierarchy.response.status, 403, outsideHierarchy.text);
    assert.equal(outsideHierarchy.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  }

  const restored = await request(`/api/portal/v1/rights/${LOCAL_DEPARTMENT_MANAGER}`, {
    method: "PUT",
    body: { grantedPermissions: [], deniedPermissions: [] },
  });
  assert.equal(restored.response.status, 200, restored.text);
  const restoredAl = restored.payload.users.find((user) => user.employeeNumber === LOCAL_DEPARTMENT_MANAGER);
  assert.equal(restoredAl.deniedPermissions.includes("time:review"), false);
  assert.equal(restoredAl.effectivePermissions.includes("time:review"), true);

  const scheduleCascade = await request(`/api/portal/v1/rights/${LOCAL_DEPARTMENT_MANAGER}`, {
    method: "PUT",
    body: { grantedPermissions: [], deniedPermissions: ["schedule:read"] },
  });
  assert.equal(scheduleCascade.response.status, 200, scheduleCascade.text);
  const scheduleRestrictedAl = scheduleCascade.payload.users
    .find((user) => user.employeeNumber === LOCAL_DEPARTMENT_MANAGER);
  assert.ok(scheduleRestrictedAl.deniedPermissions.includes("schedule:read"));
  assert.ok(scheduleRestrictedAl.deniedPermissions.includes("schedule:write"));

  const scheduleRestored = await request(`/api/portal/v1/rights/${LOCAL_DEPARTMENT_MANAGER}`, {
    method: "PUT",
    body: { grantedPermissions: [], deniedPermissions: [] },
  });
  assert.equal(scheduleRestored.response.status, 200, scheduleRestored.text);
});

test("v0.92.20: FL-Rechteoberfläche ist auf AL-Grundrechtsentzug beschränkt", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(appSource, /globalAdministration \|\| role === "manager"/);
  assert.match(appSource, /managerDenialOnly[\s\S]*Zusatzrechte, Rollen und Geltungsbereiche bleiben unverändert/);
  assert.match(appSource, /managerDenialOnly[\s\S]*JSON\.stringify\(\{ grantedPermissions, deniedPermissions \}\)[\s\S]*JSON\.stringify\(\{ grantedPermissions, deniedPermissions, scopes \}\)/);
  assert.match(html, /Filialleitungen dürfen ausschließlich Grundrechte aktiver Abteilungsleitungen im eigenen Standort einschränken/);
});
