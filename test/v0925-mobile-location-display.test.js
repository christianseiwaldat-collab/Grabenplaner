"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
const adminScript = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
const portalScript = fs.readFileSync(path.join(projectRoot, "public", "portal.js"), "utf8");

test("v0.92.5: Standortauswahl bleibt eine Schnittmenge aus Fachrecht, Filialpolicy und persönlicher Auswahl", () => {
  assert.match(serverSource, /mobile_portal:location_display:manage/);
  assert.match(serverSource, /eligibleRoles: \["department_manager", "manager", "hr", "admin", "developer"\]/);
  assert.match(serverSource, /assertPortalCsrf\(request\)[\s\S]*mobilePortalLocationDisplayManagementLocation/);
  assert.match(adminHtml, /id="mobilePortalLocationDisplayCard"[\s\S]*id="mobilePortalLocationDisplayModules"/);
  assert.match(adminScript, /canManageMobilePortalLocationDisplay\(\)[\s\S]*mobile_portal:location_display:manage/);
  assert.match(portalScript, /function mobileLocationDisplayAllows/);
  assert.match(portalScript, /if \(!mobileLocationDisplayAllows\(module\)\) return false/);
  assert.match(portalScript, /\.filter\(\(id\) => available\.has\(id\) && draft\.selected\.includes\(id\)\)/);
  assert.match(serverSource, /mobileHomePayload\(session, request, now, \{ applyLocationDisplay: true \}\)/);
  for (const mapping of [
    "timeTracking: \"time\"", "processTasks: \"tasks\"", "schedule: \"schedule\"",
    "history: \"requests\"", "loan: \"loan\"", "amu: \"sickness\"",
    "branchOrders: \"branchOrders\"", "branchVacation: \"branchVacation\"",
  ]) assert.match(portalScript, new RegExp(mapping));
  assert.match(serverSource, /timeTracking: "time",\s*team: "team",\s*approvals: "approvals"/);
  const locationPolicyCatalog = serverSource.match(
    /const mobilePortalLocationDisplayModules = Object\.freeze\(\[([\s\S]*?)\]\);/,
  )?.[1] || "";
  assert.doesNotMatch(locationPolicyCatalog, /\{ id: "(?:settings|more)", label:/);
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0925-mobile-location-display-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db } = subject;

const LOCATION = "91";
const REMOTE_LOCATION = "92";
const MANAGER = "9951";
const DEPARTMENT_MANAGER = "9952";
const HR = "9953";
const EMPLOYEE = "9954";
const PERMISSION = "mobile_portal:location_display:manage";

let httpServer;
let baseUrl;
let positionId;
let localDepartmentId;

function ensureEmployee(employeeNumber, fullName, locationId, departmentId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       position_id, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#276e55', 38.5, 5, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      position_id = excluded.position_id,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], positionId, locationId, departmentId);
}

function ensurePortalUser(employeeNumber, role) {
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, role_locked = 0, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
}

function createSession(employeeNumber, role) {
  ensurePortalUser(employeeNumber, role);
  const token = `v0925-location-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function requestJson(route, { method = "GET", auth = null, body, csrf = true } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && csrf && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
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
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  const template = db.prepare("SELECT day_settings_json FROM locations ORDER BY id LIMIT 1").get();
  for (const [id, name] of [[LOCATION, "Mobile Stammfiliale"], [REMOTE_LOCATION, "Mobile Fremdfiliale"]]) {
    db.prepare(`
      INSERT OR REPLACE INTO locations
        (id, name, min_staff, day_settings_json, time_tracking_enabled, time_tracking_access_mode,
         time_tracking_allowed_networks, time_tracking_variance_minutes, active)
      VALUES (?, ?, 1, ?, 1, 'anywhere', '', 15, 1)
    `).run(id, name, template?.day_settings_json || "{}");
    db.prepare(`
      INSERT OR IGNORE INTO departments (location_id, name, active, sort_order)
      VALUES (?, 'Testabteilung', 1, 1)
    `).run(id);
  }
  localDepartmentId = db.prepare(
    "SELECT id FROM departments WHERE location_id = ? AND name = 'Testabteilung'",
  ).get(LOCATION).id;
  const remoteDepartmentId = db.prepare(
    "SELECT id FROM departments WHERE location_id = ? AND name = 'Testabteilung'",
  ).get(REMOTE_LOCATION).id;

  ensureEmployee(MANAGER, "Mara Filialleitung", LOCATION, localDepartmentId);
  ensureEmployee(DEPARTMENT_MANAGER, "Alina Abteilungsleitung", LOCATION, localDepartmentId);
  ensureEmployee(HR, "Petra Personalleitung", LOCATION, localDepartmentId);
  ensureEmployee(EMPLOYEE, "Emil Mitarbeiter", LOCATION, localDepartmentId);
  ensurePortalUser(MANAGER, "manager");
  ensurePortalUser(DEPARTMENT_MANAGER, "department_manager");
  ensurePortalUser(HR, "hr");
  ensurePortalUser(EMPLOYEE, "employee");

  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number IN (?, ?)")
    .run(MANAGER, DEPARTMENT_MANAGER);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'test')
  `).run(MANAGER, LOCATION);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, 'test')
  `).run(DEPARTMENT_MANAGER, LOCATION, localDepartmentId);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.92.5: FL und PL+ besitzen das Grundrecht, AL nur nach ausdrücklicher Freigabe", () => {
  const rolePermissions = (role) => new Set(JSON.parse(
    db.prepare("SELECT permissions FROM portal_roles WHERE id = ?").get(role).permissions,
  ));
  for (const role of ["manager", "hr", "admin", "developer"]) {
    assert.equal(rolePermissions(role).has(PERMISSION), true, `Grundrecht fehlt bei ${role}`);
  }
  assert.equal(rolePermissions("department_manager").has(PERMISSION), false);
  const developer = rolePermissions("developer");
  const catalog = JSON.parse(db.prepare("SELECT permissions FROM portal_roles WHERE id = 'developer'").get().permissions);
  assert.equal(developer.size, new Set(catalog).size);
});

test("v0.92.5: FL verwaltet nur die eigene Filiale; PUT ist CSRF-geschützt und streng validiert", async () => {
  const manager = createSession(MANAGER, "manager");
  const initial = await requestJson(`/api/portal/v1/mobile-portal-location-display?locationId=${LOCATION}`, { auth: manager });
  assert.equal(initial.response.status, 200, initial.text);
  assert.equal(initial.payload.configured, false);
  assert.equal(initial.payload.allowedModules.length, 10);

  const remote = await requestJson(`/api/portal/v1/mobile-portal-location-display?locationId=${REMOTE_LOCATION}`, { auth: manager });
  assert.equal(remote.response.status, 403, remote.text);
  assert.equal(remote.payload.code, "PORTAL_SCOPE_DENIED");

  const missingCsrf = await requestJson("/api/portal/v1/mobile-portal-location-display", {
    method: "PUT",
    auth: manager,
    csrf: false,
    body: { locationId: LOCATION, allowedModules: ["schedule"] },
  });
  assert.equal(missingCsrf.response.status, 403, missingCsrf.text);
  assert.equal(missingCsrf.payload.code, "PORTAL_CSRF_INVALID");

  const invalid = await requestJson("/api/portal/v1/mobile-portal-location-display", {
    method: "PUT",
    auth: manager,
    body: { locationId: LOCATION, allowedModules: ["schedule", "unknown"] },
  });
  assert.equal(invalid.response.status, 400, invalid.text);
  assert.equal(invalid.payload.code, "MOBILE_PORTAL_LOCATION_DISPLAY_INVALID");

  const saved = await requestJson("/api/portal/v1/mobile-portal-location-display", {
    method: "PUT",
    auth: manager,
    body: { locationId: LOCATION, allowedModules: ["schedule", "requests", "time"] },
  });
  assert.equal(saved.response.status, 200, saved.text);
  assert.equal(saved.payload.configured, true);
  assert.deepEqual(saved.payload.allowedModules, ["time", "schedule", "requests"]);

  const managerLayout = await requestJson("/api/portal/v1/mobile-layout", { auth: manager });
  assert.equal(managerLayout.response.status, 200, managerLayout.text);
  assert.equal(managerLayout.payload.modules.includes("team"), false);
  assert.equal(managerLayout.payload.modules.includes("approvals"), false);
  assert.equal(managerLayout.payload.availableModules.some(({ id }) => id === "team" || id === "approvals"), false);

  const employee = createSession(EMPLOYEE, "employee");
  const preferences = await requestJson("/api/portal/v1/ui-preferences", { auth: employee });
  assert.equal(preferences.response.status, 200, preferences.text);
  assert.deepEqual(preferences.payload.mobilePortalLocationDisplay, {
    version: 1,
    locationId: LOCATION,
    allowedModules: ["time", "schedule", "requests"],
    configured: true,
  });
});

test("v0.92.5: PL+ kann FL-Grundrecht entziehen und AL gezielt freigeben", async () => {
  const hr = createSession(HR, "hr");
  const manager = createSession(MANAGER, "manager");
  const departmentManager = createSession(DEPARTMENT_MANAGER, "department_manager");

  const alBefore = await requestJson(`/api/portal/v1/mobile-portal-location-display?locationId=${LOCATION}`, {
    auth: departmentManager,
  });
  assert.equal(alBefore.response.status, 403, alBefore.text);
  assert.equal(alBefore.payload.code, "PORTAL_PERMISSION_DENIED");

  const denyManager = await requestJson(`/api/portal/v1/rights/${MANAGER}`, {
    method: "PUT",
    auth: hr,
    body: { grantedPermissions: [], deniedPermissions: [PERMISSION] },
  });
  assert.equal(denyManager.response.status, 200, denyManager.text);
  const managerAfter = await requestJson(`/api/portal/v1/mobile-portal-location-display?locationId=${LOCATION}`, {
    auth: createSession(MANAGER, "manager"),
  });
  assert.equal(managerAfter.response.status, 403, managerAfter.text);
  assert.equal(managerAfter.payload.code, "PORTAL_PERMISSION_DENIED");

  const grantAl = await requestJson(`/api/portal/v1/rights/${DEPARTMENT_MANAGER}`, {
    method: "PUT",
    auth: hr,
    body: { grantedPermissions: [PERMISSION], deniedPermissions: [] },
  });
  assert.equal(grantAl.response.status, 200, grantAl.text);

  const departmentManagerAfterGrant = createSession(DEPARTMENT_MANAGER, "department_manager");
  const alOwn = await requestJson(`/api/portal/v1/mobile-portal-location-display?locationId=${LOCATION}`, {
    auth: departmentManagerAfterGrant,
  });
  assert.equal(alOwn.response.status, 200, alOwn.text);
  const alRemote = await requestJson(`/api/portal/v1/mobile-portal-location-display?locationId=${REMOTE_LOCATION}`, {
    auth: departmentManagerAfterGrant,
  });
  assert.equal(alRemote.response.status, 403, alRemote.text);
  assert.equal(alRemote.payload.code, "PORTAL_SCOPE_DENIED");
});

test("v0.92.5: PL+ kann standortübergreifend konfigurieren", async () => {
  const hr = createSession(HR, "hr");
  const saved = await requestJson("/api/portal/v1/mobile-portal-location-display", {
    method: "PUT",
    auth: hr,
    body: { locationId: REMOTE_LOCATION, allowedModules: [] },
  });
  assert.equal(saved.response.status, 200, saved.text);
  assert.equal(saved.payload.locationId, REMOTE_LOCATION);
  assert.deepEqual(saved.payload.allowedModules, []);
});
