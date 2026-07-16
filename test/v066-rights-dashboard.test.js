const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v066-rights-dashboard-"));
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
const { app, db } = subject;
let httpServer;
let baseUrl;

function ensureEmployee(employeeNumber, fullName, locationId, departmentId = null) {
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId, departmentId);
}

function createPortalSession(employeeNumber, role) {
  const token = `v066-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
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

async function requestJson(route, { method = "GET", session = null, body } = {}) {
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
  return { response, payload: text ? JSON.parse(text) : null };
}

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ["portal_sessions", "portal_user_preferences", "portal_permission_grants", "portal_access_scopes"]) {
      db.prepare(`DELETE FROM ${table} WHERE employee_number LIKE 'v066-%'`).run();
    }
    db.prepare("DELETE FROM portal_users WHERE employee_number LIKE 'v066-%'").run();
    db.prepare("DELETE FROM employees WHERE personnel_number LIKE 'v066-%'").run();
    const location = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get();
    const locationId = location.id;
    db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      SELECT ?, 'v0.66 Dashboard-Abteilung', 1, 1, 9066
      WHERE NOT EXISTS (SELECT 1 FROM departments WHERE location_id = ? AND name = 'v0.66 Dashboard-Abteilung')
    `).run(locationId, locationId);
    const departmentId = Number(db.prepare("SELECT id FROM departments WHERE location_id = ? AND name = 'v0.66 Dashboard-Abteilung'").get(locationId).id);
    ensureEmployee("v066-admin", "Ada Administration", locationId);
    ensureEmployee("v066-manager", "Mara Filialleitung", locationId);
    ensureEmployee("v066-department", "Dora Abteilungsleitung", locationId, departmentId);
    ensureEmployee("v066-employee", "Emil Verkauf", locationId, departmentId);
    createPortalSession("v066-admin", "admin");
    createPortalSession("v066-manager", "manager");
    createPortalSession("v066-department", "department_manager");
    createPortalSession("v066-employee", "employee");
    db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES (?, ?, 0, 'v066-test')")
      .run("v066-manager", locationId);
    db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES (?, ?, ?, 'v066-test')")
      .run("v066-department", locationId, departmentId);
    db.prepare("INSERT INTO portal_permission_grants (employee_number, permission, granted_by) VALUES ('v066-manager', 'branding:read', 'v066-test')").run();
    db.prepare("INSERT INTO portal_permission_grants (employee_number, permission, granted_by) VALUES ('v066-department', 'employees:display:write', 'v066-test')").run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(resetFixture);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.66: Migration und Dashboard-Oberfläche sind vollständig vorhanden", () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.66-rights-dashboard'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portal_user_preferences'").get());
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const marker of ["rightsDashboardView", "rightsDashboardSearch", "rightsDashboardRoleFilter", "rightsDashboardLocationFilter", "rightsDashboardDepartmentFilter", "rightsDashboardOriginFilter"]) assert.match(html, new RegExp(marker));
  for (const marker of ["loadRightsDashboard", "renderRightsDashboardSelection", "saveRightsDashboardTheme"]) assert.match(script, new RegExp(marker));
  assert.match(styles, /rights-dashboard\[data-dashboard-theme="dark"\]/);
});

test("v0.66: Dashboard erklärt Rollenrechte, Zusatzrechte und Bereichsgrenzen", async () => {
  const admin = createPortalSession("v066-admin", "admin");
  const result = await requestJson("/api/portal/v1/rights-dashboard", { session: admin });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const manager = result.payload.users.find((user) => user.employeeNumber === "v066-manager");
  const department = result.payload.users.find((user) => user.employeeNumber === "v066-department");
  const employee = result.payload.users.find((user) => user.employeeNumber === "v066-employee");
  assert.equal(manager.permissions.find((permission) => permission.id === "schedule:read").origin, "role");
  assert.equal(manager.permissions.find((permission) => permission.id === "schedule:read").coverage.type, "location");
  assert.equal(manager.permissions.find((permission) => permission.id === "branding:read").origin, "delegated");
  assert.equal(manager.permissions.find((permission) => permission.id === "branding:read").coverage.type, "global");
  assert.equal(department.permissions.find((permission) => permission.id === "employees:display:write").coverage.type, "department");
  assert.equal(employee.permissions.find((permission) => permission.id === "own_schedule:read").coverage.type, "self");
  assert.equal(JSON.stringify(result.payload).includes("password_hash"), false);
});

test("v0.66: Dashboard bleibt Personalleitung und höheren Rollen vorbehalten", async () => {
  const manager = createPortalSession("v066-manager", "manager");
  const denied = await requestJson("/api/portal/v1/rights-dashboard", { session: manager });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
});

test("v0.66: Dashboard-Darstellung wird benutzerbezogen gespeichert", async () => {
  const admin = createPortalSession("v066-admin", "admin");
  const changed = await requestJson("/api/portal/v1/rights-dashboard/preferences", { method: "PUT", session: admin, body: { theme: "dark" } });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.theme, "dark");
  const refreshed = await requestJson("/api/portal/v1/rights-dashboard", { session: admin });
  assert.equal(refreshed.payload.preferences.theme, "dark");
  const invalid = await requestJson("/api/portal/v1/rights-dashboard/preferences", { method: "PUT", session: admin, body: { theme: "midnight" } });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
});
