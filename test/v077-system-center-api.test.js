const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v077-system-center-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const packageMetadata = require("../package.json");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const nativeFetch = global.fetch;
global.fetch = (input, init) => {
  if (String(input).startsWith("https://api.github.com/repos/")) {
    return Promise.resolve(new Response(JSON.stringify([{
      tag_name: `v${packageMetadata.version}`,
      name: "Test release",
      html_url: "https://github.example.invalid/releases/test",
      draft: false,
      prerelease: true,
      created_at: "2026-07-22T10:00:00.000Z",
      published_at: "2026-07-22T10:00:00.000Z",
      assets: [],
    }]), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  return nativeFetch(input, init);
};

const subject = require("../server");
const { app, db } = subject;
let httpServer;
let baseUrl;

function ensureTestUser(employeeNumber, role) {
  const location = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get();
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET full_name = excluded.full_name, active = 1
  `).run(employeeNumber, `Systemtest ${employeeNumber}`, employeeNumber, location.id);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  const token = `v077-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
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

async function requestJson(route, { method = "GET", session = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await nativeFetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  global.fetch = nativeFetch;
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.77: System-Center liefert redigierten Status, acht Karten und keine falsche 100", async () => {
  const admin = ensureTestUser("9701", "admin");
  const result = await requestJson("/api/portal/v1/system-center", { session: admin });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.schemaVersion, 2);
  assert.equal(result.payload.capabilities.technicalDiagnostics, true);
  assert.equal(result.payload.capabilities.canRunRecoveryAssurance, false);
  assert.equal(result.payload.manualRun.allowed, false);
  assert.equal(result.payload.recoveryAssurance.configured, false);
  assert.equal(result.payload.trustIndex.cards.length, 8);
  assert.ok(result.payload.trustIndex.score < 100);
  assert.match(result.payload.trustIndex.disclaimer, /keine (?:Verfügbarkeits)?garantie/i);
  assert.ok(Array.isArray(result.payload.recoveryAssurance.recentRuns));
  assert.equal(result.payload.automation.state, "unconfigured");
  assert.ok(Array.isArray(result.payload.trends.points));
  assert.equal(result.payload.trends.integrityVerified, true);
  assert.equal(result.payload.notifications.state, "quiet");
  const serialized = JSON.stringify(result.payload);
  for (const forbidden of [testRoot, "GRABENPLANER_", "password", "privateDataDirectory", "appBackupDirectory"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("v0.77: Dashboard und manueller Start sind getrennt berechtigt", async () => {
  const manager = ensureTestUser("9702", "manager");
  const deniedRead = await requestJson("/api/portal/v1/system-center", { session: manager });
  assert.equal(deniedRead.response.status, 403, JSON.stringify(deniedRead.payload));

  const admin = ensureTestUser("9701", "admin");
  const deniedRun = await requestJson("/api/portal/v1/system-center/recovery-assurance/run", {
    method: "POST",
    session: admin,
    body: { confirmation: "RECOVERY_ASSURANCE_START" },
  });
  assert.equal(deniedRun.response.status, 403, JSON.stringify(deniedRun.payload));

  const itAdmin = ensureTestUser("9703", "it_admin");
  const localModeRun = await requestJson("/api/portal/v1/system-center/recovery-assurance/run", {
    method: "POST",
    session: itAdmin,
    body: { confirmation: "RECOVERY_ASSURANCE_START" },
  });
  assert.equal(localModeRun.response.status, 409, JSON.stringify(localModeRun.payload));
  assert.equal(localModeRun.payload.code, "RECOVERY_ASSURANCE_SERVER_REQUIRED");

  const anonymous = await requestJson("/api/portal/v1/system-center");
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));
});

test("v0.78: reine Leseberechtigung bleibt redigiert und GET ist nebenwirkungsfrei", async () => {
  const hr = ensureTestUser("9704", "hr");
  db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES ('9704', 'system:diagnostics:read', '9703')
  `).run();
  const metricsBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM system_center_trust_metrics").get().count);
  const notificationsBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications").get().count);
  const result = await requestJson("/api/portal/v1/system-center", { session: hr });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.capabilities.technicalDiagnostics, false);
  assert.equal(result.payload.resources, null);
  assert.equal(result.payload.notifications.lastNotifiedAt, null);
  assert.equal(result.payload.notifications.recipientsCount, null);
  assert.ok(result.payload.trends.points.every((point) => point.databaseBytes === null));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM system_center_trust_metrics").get().count), metricsBefore);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications").get().count), notificationsBefore);
  assert.match(serverSource, /createPortalNotification\(employeeNumber,\s*"system\.recovery\.alert",[\s\S]{0,1000}?reactivate:\s*true/);
});
