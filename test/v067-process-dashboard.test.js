const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v067-process-dashboard-"));
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

function setPortalSetting(key, value) {
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
}

function createPortalSession() {
  const employeeNumber = "v067-admin";
  const token = `v067-${crypto.randomBytes(32).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active)
    VALUES (?, 'Paula Prozess', 'Paula', ?, 1)
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
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function requestJson(route, session) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Accept: "application/json", Cookie: session.cookie },
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

function resetFixture() {
  locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = 'v067-admin'").run();
  db.prepare("DELETE FROM portal_users WHERE employee_number = 'v067-admin'").run();
  db.prepare("DELETE FROM employees WHERE personnel_number = 'v067-admin'").run();
  db.prepare("DELETE FROM request_blackouts WHERE created_by = 'v067-test'").run();
  setPortalSetting("vacation_hr_approval_required", "0");
  setPortalSetting("amu_ocr_enabled", "1");
  setPortalSetting("sickness_local_warning_days", "2");
  setPortalSetting("sickness_hr_warning_days", "3");
  db.prepare(`
    UPDATE locations SET time_tracking_enabled = 1, time_tracking_access_mode = 'anywhere',
      time_tracking_variance_minutes = 5 WHERE id = ?
  `).run(locationId);
}

function processById(payload, id) {
  return payload.processDashboard.processes.find((process) => process.id === id);
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

test("v0.67: Prozessansicht und Bedienung sind vollständig verdrahtet", () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.67-process-dashboard'").get());
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const marker of ["data-rights-dashboard-mode=\"processes\"", "rightsProcessLocation", "rightsProcessList", "rightsProcessTimeline", "rightsProcessExplanation"]) assert.match(html, new RegExp(marker));
  for (const marker of ["setRightsDashboardMode", "renderRightsProcessDashboard", "data-rights-process-step", "rightsProcessLocation?.addEventListener"]) assert.ok(script.includes(marker), marker);
  for (const marker of [".rights-process-timeline", ".rights-process-step", ".rights-process-explanation"]) assert.ok(styles.includes(marker), marker);
});

test("v0.67: API liefert fünf sichere, erklärbare Standardprozesse", async () => {
  const result = await requestJson("/api/portal/v1/rights-dashboard", createPortalSession());
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.processDashboard.processes.map((process) => process.id), [
    "vacation", "time_off", "sickness_amu", "time_review", "payroll",
  ]);
  for (const process of result.payload.processDashboard.processes) {
    assert.ok(process.title);
    assert.ok(process.summary);
    assert.ok(process.rules.length >= 3);
    assert.ok(process.steps.length >= 5);
    for (const step of process.steps) {
      assert.ok(step.actor);
      assert.ok(step.description);
      assert.ok(["active", "conditional", "bypassed", "inactive"].includes(step.state));
    }
  }
  const serialized = JSON.stringify(result.payload.processDashboard);
  for (const forbidden of ["password_hash", "protected_credentials", "time_tracking_allowed_networks", "credentials"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("v0.67: Freigabe-, AUM- und Sperrregeln verändern den dargestellten Prozess", async () => {
  setPortalSetting("vacation_hr_approval_required", "1");
  setPortalSetting("amu_ocr_enabled", "0");
  setPortalSetting("sickness_local_warning_days", "4");
  setPortalSetting("sickness_hr_warning_days", "7");
  db.prepare(`
    INSERT INTO request_blackouts
      (location_id, date_from, date_to, block_vacation, block_time_off, reason, active, created_by)
    VALUES (?, '2099-12-01', '2099-12-24', 1, 1, 'Test', 1, 'v067-test')
  `).run(locationId);
  const result = await requestJson("/api/portal/v1/rights-dashboard", createPortalSession());
  const vacation = processById(result.payload, "vacation");
  const timeOff = processById(result.payload, "time_off");
  const sickness = processById(result.payload, "sickness_amu");
  assert.equal(vacation.steps.find((step) => step.id === "hr_approval").state, "active");
  assert.equal(vacation.rules.find((rule) => rule.label === "Aktive Antragssperren").value, "1");
  assert.equal(timeOff.rules.find((rule) => rule.label === "Aktive ZA-Sperren").value, "1");
  assert.equal(sickness.steps.find((step) => step.id === "ocr").state, "bypassed");
  assert.equal(sickness.rules.find((rule) => rule.label === "AUM-Dateizugriff").value, "PL+ mit Zusatzrecht");
  assert.equal(sickness.rules.find((rule) => rule.label === "Lokaler Hinweis").value, "nach 4 Tag(en)");
  assert.equal(sickness.rules.find((rule) => rule.label === "PL-Eskalation").value, "nach 7 Tag(en)");
});

test("v0.67: Standortbezogene Zeiterfassungsregeln bleiben im Prozesskontext", async () => {
  db.prepare(`
    UPDATE locations SET time_tracking_enabled = 0, time_tracking_access_mode = 'trusted_network',
      time_tracking_variance_minutes = 11 WHERE id = ?
  `).run(locationId);
  const result = await requestJson("/api/portal/v1/rights-dashboard", createPortalSession());
  const location = result.payload.processDashboard.locations.find((entry) => entry.id === locationId);
  const timeReview = processById(result.payload, "time_review");
  assert.equal(location.timeTrackingEnabled, false);
  assert.equal(location.timeTrackingAccessMode, "trusted_network");
  assert.equal(location.timeTrackingAccessLabel, "Nur freigegebene Netzwerke");
  assert.equal(location.timeTrackingVarianceMinutes, 11);
  assert.equal(timeReview.locationSensitive, true);
  assert.equal(timeReview.steps.find((step) => step.id === "booking").stateRule, "timeTrackingEnabled");
});
