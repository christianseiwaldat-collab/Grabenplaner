const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-page-appearance-"));
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

function ensureEmployee(employeeNumber, fullName, locationId) {
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId);
}

function createPortalSession(employeeNumber, role) {
  const token = `v071-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
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
    db.prepare("DELETE FROM portal_sessions WHERE employee_number LIKE 'v071-%'").run();
    db.prepare("DELETE FROM portal_user_preferences WHERE employee_number LIKE 'v071-%'").run();
    db.prepare("DELETE FROM portal_users WHERE employee_number LIKE 'v071-%'").run();
    db.prepare("DELETE FROM employees WHERE personnel_number LIKE 'v071-%'").run();
    const locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
    ensureEmployee("v071-admin", "Ada Ansicht", locationId);
    ensureEmployee("v071-manager", "Mara Ansicht", locationId);
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

test("v0.71: Jede Hauptseite bietet eine eigene gespeicherte Darstellung", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.equal((html.match(/class="page-theme-switch/g) || []).length, 9);
  assert.match(script, /personnelAdministration:\s*"light"/);
  assert.match(script, /loans:\s*"light"/);
  const decreaseFontScale = html.indexOf('id="decreaseAppFontScale"');
  const fontScalePercent = html.indexOf('id="appFontScalePercent"');
  const increaseFontScale = html.indexOf('id="increaseAppFontScale"');
  assert.ok(decreaseFontScale >= 0 && decreaseFontScale < fontScalePercent);
  assert.ok(fontScalePercent < increaseFontScale);
  assert.match(html, /id="appFontScalePercent" type="number" min="75" max="150" step="5" value="100"/);
  assert.match(html, /class="app-font-scale-value"[\s\S]*?<span[^>]*>%<\/span>/);
  assert.doesNotMatch(html, /id="dashboardFontSize"/);
  assert.match(script, /loadUiPreferences/);
  assert.match(script, /function applyAppFontScalePercent\(value\)/);
  assert.match(script, /document\.documentElement\.style\.setProperty\("--app-font-scale"/);
  assert.match(script, /formatAmuPeriod/);
  assert.doesNotMatch(script, /formatDate\(report\.incapacity_to\)/);
  assert.match(styles, /data-active-page-theme="dark"[^\n]*\.system-footer/);
  assert.match(styles, /data-active-page-theme="dark"[^\n]*#planningView \.day-body/);
  assert.match(styles, /data-active-page-theme="dark"\] \.view\.active:not\(\.rights-dashboard\) :is\([\s\S]{0,900}\.integration-contract-row/);
  assert.match(styles, /data-active-page-theme="dark"\] \.view\.active:not\(\.rights-dashboard\) :is\([\s\S]{0,900}\.wifi-location-mapping-row/);
  assert.match(styles, /data-active-page-theme="dark"\] \.view\.active:not\(\.rights-dashboard\) :is\([\s\S]{0,900}\.pilot-checklist/);
  assert.match(styles, /data-active-page-theme="dark"\] :is\(\.settings-tabs,\.timeline-scroll/);
  assert.match(script, /--employee-contrast:\$\{contrastColor\(employee\.color\)\}/);
  assert.match(styles, /--app-font-scale:\s*1;/);
  assert.match(styles, /body \{[^}]*zoom:\s*var\(--app-font-scale\);/);
  assert.doesNotMatch(styles, /data-dashboard-font-size=/);
});

test("v0.71: Seitendarstellungen und Grabenplaner-Schriftgröße sind benutzerbezogen", async () => {
  const admin = createPortalSession("v071-admin", "admin");
  const manager = createPortalSession("v071-manager", "manager");

  const defaults = await requestJson("/api/portal/v1/ui-preferences", { session: admin });
  assert.equal(defaults.response.status, 200, JSON.stringify(defaults.payload));
  assert.equal(defaults.payload.pageThemes.planning, "light");
  assert.equal(defaults.payload.pageThemes.personnelAdministration, "light");
  assert.equal(defaults.payload.pageThemes.rightsDashboard, "light");
  assert.equal(defaults.payload.appFontScalePercent, 100);
  assert.equal(defaults.payload.dashboardFontSize, undefined);
  assert.ok(defaults.payload.employeeDisplayColumns.includes("name"));
  assert.deepEqual(defaults.payload.employeeDisplaySort, { key: "personnel_number", direction: "asc" });

  const changed = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: {
      pageThemes: { planning: "dark", personnelAdministration: "dark", rightsDashboard: "dark" },
      appFontScalePercent: 115,
      employeeDisplayColumns: ["name", "phone", "assignment"],
      employeeDisplaySort: { key: "name", direction: "desc" },
    },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.pageThemes.planning, "dark");
  assert.equal(changed.payload.pageThemes.personnelAdministration, "dark");
  assert.equal(changed.payload.pageThemes.rightsDashboard, "dark");
  assert.equal(changed.payload.appFontScalePercent, 115);
  assert.deepEqual(changed.payload.employeeDisplayColumns, ["name", "phone", "assignment"]);
  assert.deepEqual(changed.payload.employeeDisplaySort, { key: "name", direction: "desc" });

  const refreshed = await requestJson("/api/portal/v1/ui-preferences", { session: admin });
  assert.equal(refreshed.payload.pageThemes.planning, "dark");
  assert.equal(refreshed.payload.pageThemes.personnelAdministration, "dark");
  assert.equal(refreshed.payload.appFontScalePercent, 115);
  assert.deepEqual(refreshed.payload.employeeDisplayColumns, ["name", "phone", "assignment"]);
  assert.deepEqual(refreshed.payload.employeeDisplaySort, { key: "name", direction: "desc" });

  const managerDefaults = await requestJson("/api/portal/v1/ui-preferences", { session: manager });
  assert.equal(managerDefaults.response.status, 200, JSON.stringify(managerDefaults.payload));
  assert.equal(managerDefaults.payload.pageThemes.planning, "light");
  assert.equal(managerDefaults.payload.pageThemes.personnelAdministration, "light");
  assert.equal(managerDefaults.payload.appFontScalePercent, 100);
  assert.ok(managerDefaults.payload.employeeDisplayColumns.includes("name"));

  for (const appFontScalePercent of [75, 150]) {
    const boundary = await requestJson("/api/portal/v1/ui-preferences", {
      method: "PUT",
      session: admin,
      body: { appFontScalePercent },
    });
    assert.equal(boundary.response.status, 200, JSON.stringify(boundary.payload));
    assert.equal(boundary.payload.appFontScalePercent, appFontScalePercent);
  }
});

test("v0.71: Ungültige Darstellungswerte und anonyme Zugriffe werden abgewiesen", async () => {
  const admin = createPortalSession("v071-admin", "admin");
  const invalidView = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { pageThemes: { unknown: "dark" } },
  });
  assert.equal(invalidView.response.status, 400, JSON.stringify(invalidView.payload));
  for (const appFontScalePercent of [70, 155, 103, "110"]) {
    const invalidSize = await requestJson("/api/portal/v1/ui-preferences", {
      method: "PUT",
      session: admin,
      body: { appFontScalePercent },
    });
    assert.equal(invalidSize.response.status, 400, JSON.stringify(invalidSize.payload));
  }
  const invalidColumns = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { employeeDisplayColumns: ["name", "social_security_number"] },
  });
  assert.equal(invalidColumns.response.status, 400, JSON.stringify(invalidColumns.payload));
  const invalidSort = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: admin,
    body: { employeeDisplaySort: { key: "name", direction: "sideways" } },
  });
  assert.equal(invalidSort.response.status, 400, JSON.stringify(invalidSort.payload));
  const anonymous = await requestJson("/api/portal/v1/ui-preferences");
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));
});
