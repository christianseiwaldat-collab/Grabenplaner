const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-dashboard-center-"));
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
let httpServer;
let baseUrl;

const fixtureDate = "2032-08-17";
const locationIds = ["v071-d1", "v071-d2"];

function createPortalSession(employeeNumber, role) {
  const token = `v071-dashboard-${employeeNumber}-${crypto.randomBytes(20).toString("hex")}`;
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
    db.prepare("DELETE FROM portal_sessions WHERE employee_number LIKE 'v071-dash-%'").run();
    db.prepare("DELETE FROM portal_user_preferences WHERE employee_number LIKE 'v071-dash-%'").run();
    db.prepare("DELETE FROM portal_users WHERE employee_number LIKE 'v071-dash-%'").run();
    db.prepare("DELETE FROM shifts WHERE employee_number LIKE 'v071-dash-%'").run();
    db.prepare("DELETE FROM week_options WHERE employee_number LIKE 'v071-dash-%'").run();
    db.prepare("DELETE FROM employees WHERE personnel_number LIKE 'v071-dash-%'").run();
    db.prepare("DELETE FROM departments WHERE location_id IN (?, ?)").run(...locationIds);
    db.prepare("DELETE FROM locations WHERE id IN (?, ?)").run(...locationIds);
    db.prepare("UPDATE locations SET active = 0").run();
    db.prepare("INSERT INTO locations (id, name, min_staff, active) VALUES (?, 'Nord Demo', 2, 1)").run(locationIds[0]);
    db.prepare("INSERT INTO locations (id, name, min_staff, active) VALUES (?, 'Süd Demo', 2, 1)").run(locationIds[1]);
    db.prepare("INSERT INTO departments (location_id, name, min_staff, active, sort_order) VALUES (?, 'Fotowelt', 1, 1, 1)").run(locationIds[0]);
    db.prepare("INSERT INTO departments (location_id, name, min_staff, active, sort_order) VALUES (?, 'Hardware', 1, 1, 1)").run(locationIds[1]);
    const department1 = db.prepare("SELECT id FROM departments WHERE location_id = ?").get(locationIds[0]).id;
    const department2 = db.prepare("SELECT id FROM departments WHERE location_id = ?").get(locationIds[1]).id;
    const addEmployee = db.prepare(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, home_location_id, preferred_department_id, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    addEmployee.run("v071-dash-admin", "Ada Leitung", "Ada", "#26785f", locationIds[0], department1);
    addEmployee.run("v071-dash-sick", "Kira Krank", "Kira", "#c45347", locationIds[0], department1);
    addEmployee.run("v071-dash-vac", "Uli Urlaub", "Uli", "#8d68c4", locationIds[0], department1);
    addEmployee.run("v071-dash-za", "Zara Ausgleich", "Zara", "#b77a12", locationIds[1], department2);
    addEmployee.run("v071-dash-school", "Sina Schule", "Sina", "#3976aa", locationIds[1], department2);
    addEmployee.run("v071-dash-branch", "Fiona Filiale", "Fiona", "#238f92", locationIds[1], department2);
    const addShift = db.prepare("INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time) VALUES (?, ?, ?, '09:00', '18:00')");
    addShift.run("v071-dash-admin", department1, fixtureDate);
    addShift.run("v071-dash-sick", department1, fixtureDate);
    addShift.run("v071-dash-za", department2, fixtureDate);
    const addOption = db.prepare(`
      INSERT INTO week_options
        (employee_number, week_start, date_from, date_to, option_type, note, all_day, start_time, end_time)
      VALUES (?, '2032-08-16', ?, ?, ?, ?, ?, ?, ?)
    `);
    addOption.run("v071-dash-sick", fixtureDate, fixtureDate, "sick", "VERTRAULICHE AUM-BEMERKUNG", 1, null, null);
    addOption.run("v071-dash-vac", fixtureDate, fixtureDate, "vacation", "Privater Urlaubsgrund", 1, null, null);
    addOption.run("v071-dash-za", fixtureDate, fixtureDate, "time_off", "Privater ZA-Grund", 0, "11:00", "14:00");
    addOption.run("v071-dash-school", fixtureDate, fixtureDate, "vocational_school", "Schulungsdetails", 1, null, null);
    addOption.run("v071-dash-branch", fixtureDate, fixtureDate, "branch", "Zielstandort geheim", 1, null, null);
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

test("v0.71 Block 2: persönliches Dashboard steht zuerst und das Steuerungscenter bleibt getrennt", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(html.indexOf("startDashboardNavButton") < html.indexOf("data-nav-toggle=\"planning\""));
  assert.ok(html.indexOf("rightsDashboardNavButton") > html.indexOf("<\/nav>"));
  assert.match(html, /id="startDashboardNavButton"[\s\S]{0,100}<span>Dashboard<\/span>/);
  assert.match(html, /id="rightsDashboardNavButton"[\s\S]{0,100}<span>Steuerungscenter<\/span>/);
  for (const mode of ["locations", "rights", "processes"]) assert.match(html, new RegExp(`data-rights-dashboard-mode="${mode}"`));
  for (const marker of ["locationDashboardGrid", "locationDashboardFilters", "locationDashboardDate"]) assert.match(html, new RegExp(marker));
  assert.match(script, /reorderLocationDashboardCard/);
  assert.match(script, /dashboard-location-order/);
  assert.match(styles, /location-dashboard-card\.drag-target/);
});

test("v0.71 Block 2: Filialübersicht zeigt Besetzung und minimierte Abwesenheitsdaten", async () => {
  const admin = createPortalSession("v071-dash-admin", "admin");
  const result = await requestJson(`/api/portal/v1/dashboards/locations?date=${fixtureDate}`, { session: admin });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.locations.length, 2);
  assert.equal(result.payload.summary.scheduledEmployees, 3);
  assert.equal(result.payload.summary.absentEntries, 5);
  assert.equal(result.payload.summary.criticalLocations, 1);
  assert.equal(result.payload.categories.find((entry) => entry.id === "sick").count, 1);
  assert.equal(result.payload.categories.find((entry) => entry.id === "training").count, 1);
  const north = result.payload.locations.find((location) => location.id === locationIds[0]);
  const south = result.payload.locations.find((location) => location.id === locationIds[1]);
  assert.equal(north.status, "attention");
  assert.equal(north.scheduledCount, 2);
  assert.equal(south.status, "critical");
  assert.equal(south.scheduledCount, 1);
  const serialized = JSON.stringify(result.payload);
  assert.equal(serialized.includes("VERTRAULICHE AUM-BEMERKUNG"), false);
  assert.equal(serialized.includes("Privater Urlaubsgrund"), false);
  assert.equal(serialized.includes('"note"'), false);
});

test("v0.71 Block 2: Filialreihenfolge wird pro Benutzer gespeichert", async () => {
  const admin = createPortalSession("v071-dash-admin", "admin");
  const changed = await requestJson("/api/portal/v1/dashboards/locations/preferences", {
    method: "PUT",
    session: admin,
    body: { locationOrder: [locationIds[1], locationIds[0]] },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.deepEqual(changed.payload.locationOrder, [locationIds[1], locationIds[0]]);
  const refreshed = await requestJson(`/api/portal/v1/dashboards/locations?date=${fixtureDate}`, { session: admin });
  assert.deepEqual(refreshed.payload.locations.map((location) => location.id), [locationIds[1], locationIds[0]]);
  const stored = db.prepare("SELECT value FROM portal_user_preferences WHERE employee_number = ? AND preference_key = 'dashboard_location_order'").get("v071-dash-admin");
  assert.deepEqual(JSON.parse(stored.value), [locationIds[1], locationIds[0]]);
});

test("v0.71 Block 2: Ungültige Reihenfolgen und unberechtigte Zugriffe werden abgewiesen", async () => {
  const admin = createPortalSession("v071-dash-admin", "admin");
  const invalid = await requestJson("/api/portal/v1/dashboards/locations/preferences", {
    method: "PUT",
    session: admin,
    body: { locationOrder: [locationIds[0], locationIds[0]] },
  });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
  const invalidDate = await requestJson("/api/portal/v1/dashboards/locations?date=17.08.2032", { session: admin });
  assert.equal(invalidDate.response.status, 400, JSON.stringify(invalidDate.payload));
  const manager = createPortalSession("v071-dash-sick", "manager");
  const denied = await requestJson(`/api/portal/v1/dashboards/locations?date=${fixtureDate}`, { session: manager });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  const anonymous = await requestJson(`/api/portal/v1/dashboards/locations?date=${fixtureDate}`);
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));
});
