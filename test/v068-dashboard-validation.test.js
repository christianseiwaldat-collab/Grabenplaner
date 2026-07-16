const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v068-dashboard-validation-"));
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
let locationId;

function createPortalSession() {
  const employeeNumber = "v068-admin";
  const token = `v068-${crypto.randomBytes(32).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active)
    VALUES (?, 'Vera Validierung', 'Vera', ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET home_location_id = excluded.home_location_id, active = 1
  `).run(employeeNumber, locationId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', 'admin', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = 'admin', active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`, csrf };
}

async function request(route, session) {
  return fetch(`${baseUrl}${route}`, { headers: { Cookie: session.cookie } });
}

async function requestJson(route, session) {
  const response = await request(route, session);
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

function resetFixture() {
  locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = 'v068-admin'").run();
  db.prepare("DELETE FROM portal_users WHERE employee_number = 'v068-admin'").run();
  db.prepare("DELETE FROM employees WHERE personnel_number = 'v068-admin'").run();
  db.prepare(`
    UPDATE locations SET time_tracking_enabled = 0, time_tracking_access_mode = 'anywhere',
      time_tracking_allowed_networks = '', time_tracking_variance_minutes = 5 WHERE active = 1
  `).run();
  db.prepare("UPDATE locations SET time_tracking_enabled = 1 WHERE id = ?").run(locationId);
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

test("v0.68: Prüfung, Simulation, Export und Navigation sind vollständig verdrahtet", () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.68-dashboard-validation'").get());
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const marker of ["rightsProcessScenario", "rightsProcessExportPdf", "rightsProcessValidationSummary", "rightsProcessValidationList", "rightsProcessSimulationNote"]) assert.ok(html.includes(marker), marker);
  for (const marker of ["rightsProcessWithScenario", "renderRightsProcessValidation", "exportRightsProcessPdf", "showRightsProcessPermission", "openRightsProcessSettings"]) assert.ok(script.includes(marker), marker);
  for (const marker of [".rights-process-validation", ".rights-process-simulation-note", ".rights-process-explanation-actions"]) assert.ok(styles.includes(marker), marker);
});

test("v0.68: API liefert Simulationen und eine sichere Gesamtprüfung", async () => {
  const result = await requestJson("/api/portal/v1/rights-dashboard", createPortalSession());
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const dashboard = result.payload.processDashboard;
  assert.equal(dashboard.processes.length, 5);
  assert.ok(dashboard.processes.every((process) => process.simulations.length >= 3));
  assert.equal(dashboard.validation.summary.blocker, 0, JSON.stringify(dashboard.validation));
  assert.ok(dashboard.validation.summary.ok >= 3);
  assert.ok(dashboard.validation.checks.some((check) => check.processId === "payroll" && check.settingsTarget?.tab === "integrations"));
  const serialized = JSON.stringify(dashboard);
  for (const forbidden of ["password_hash", "protected_credentials", "time_tracking_allowed_networks", "credentials"]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("v0.68: Fehlende freigegebene Netzwerke werden ohne Offenlegung als Blocker erkannt", async () => {
  db.prepare(`
    UPDATE locations SET time_tracking_enabled = 1, time_tracking_access_mode = 'trusted_network',
      time_tracking_allowed_networks = '' WHERE id = ?
  `).run(locationId);
  const result = await requestJson("/api/portal/v1/rights-dashboard", createPortalSession());
  const blocker = result.payload.processDashboard.validation.checks.find((check) => check.title === "Freigegebenes Netzwerk fehlt");
  assert.ok(blocker);
  assert.equal(blocker.severity, "blocker");
  assert.equal(result.payload.processDashboard.validation.ready, false);
  assert.equal(JSON.stringify(blocker).includes("192.168"), false);
});

test("v0.68: Simulationen bleiben reine Vorschau und verändern keine Einstellungen", async () => {
  const session = createPortalSession();
  const before = db.prepare("SELECT value FROM portal_settings WHERE key = 'vacation_hr_approval_required'").get()?.value || "0";
  const result = await requestJson("/api/portal/v1/rights-dashboard", session);
  const vacation = result.payload.processDashboard.processes.find((process) => process.id === "vacation");
  assert.equal(vacation.simulations.find((scenario) => scenario.id === "two_stage").stepStates.hr_approval, "active");
  assert.equal(vacation.simulations.find((scenario) => scenario.id === "local_only").stepStates.hr_approval, "bypassed");
  const after = db.prepare("SELECT value FROM portal_settings WHERE key = 'vacation_hr_approval_required'").get()?.value || "0";
  assert.equal(after, before);
});

test("v0.68: Gewählter Prozess lässt sich als geschützte PDF-Dokumentation exportieren", async () => {
  const session = createPortalSession();
  const response = await request(`/api/portal/v1/rights-dashboard/process-export.pdf?process=time_off&scenario=hr_bound&location=${encodeURIComponent(locationId)}`, session);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition"), /Prozessweg/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(bytes.length > 2000);
  const invalid = await requestJson("/api/portal/v1/rights-dashboard/process-export.pdf?process=unknown", session);
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, "RIGHTS_DASHBOARD_PROCESS_INVALID");
});
