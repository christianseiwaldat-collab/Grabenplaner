"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

test("v0.60: Einstellungen stehen zuerst und bündeln Passwort sowie WLAN", () => {
  const html = fs.readFileSync(path.join(projectRoot, "public", "portal.html"), "utf8");
  const navigation = html.match(/<nav class="portal-tabs"[\s\S]*?<\/nav>/)?.[0] || "";
  const settingsView = html.match(/<section class="portal-view" id="settingsView"[\s\S]*?(?=<section class="portal-view active" id="scheduleView")/)?.[0] || "";
  const timeView = html.match(/<section class="portal-view" id="timeTrackingView"[\s\S]*?(?=<section class="portal-view leadership-view" id="leadershipTeamView")/)?.[0] || "";

  assert.match(navigation, /<button data-tab="settings"/);
  assert.equal(navigation.indexOf('data-tab="settings"') < navigation.indexOf('data-tab="schedule"'), true);
  assert.match(settingsView, /id="settingsPasswordButton"/);
  assert.match(settingsView, /id="wifiAutomationCard"/);
  assert.match(settingsView, /WLAN-Zeitvorschläge/);
  assert.doesNotMatch(timeView, /id="wifiAutomationCard"|WLAN-Zeitvorschläge/);
  assert.equal(timeView.indexOf('id="timeTrackingCard"') < timeView.indexOf('id="timeEntryList"'), true);
  assert.match(timeView, /Mein Arbeitstag[\s\S]*?id="timeTrackingGreeting"[\s\S]*?id="timeTrackingDate"[\s\S]*?id="timeTrackingCard"[\s\S]*?Aktueller Zustand/);
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v060-mobile-"));
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
let httpServer;
let baseUrl;

function ensureEmployee(employeeNumber, fullName) {
  const locationId = db.prepare("SELECT id FROM locations ORDER BY id LIMIT 1").get()?.id || null;
  db.prepare(`
    INSERT OR IGNORE INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
    VALUES (?, ?, ?, '#287a67', 38.5, ?, 1)
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId);
}

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function request(route, { method = "GET", auth = null, body, requestId } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (requestId) headers["X-Request-Id"] = requestId;
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

test.before(async () => {
  ensureEmployee("960", "Petra Leitung");
  ensureEmployee("961", "Martin Filiale");
  ensureEmployee("962", "Anna Mitarbeit");
  httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.60: Personalleitung verwaltet Begrüßungen, Filialleitung erhält 403", async () => {
  const hr = session("960", "hr");
  const manager = session("961", "manager");

  const current = await request("/api/portal/v1/greeting-settings", { auth: hr });
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  assert.equal(current.payload.canChange, true);
  assert.equal(typeof current.payload.settings.enabled, "boolean");

  const saved = await request("/api/portal/v1/greeting-settings", {
    method: "PUT",
    auth: hr,
    body: { ...current.payload.settings, enabled: !current.payload.settings.enabled },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.settings.enabled, !current.payload.settings.enabled);

  const denied = await request("/api/portal/v1/greeting-settings", { auth: manager });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_PERMISSION_DENIED");
});

test("v0.60: Mobile-v1 meldet den lokalen Grundvertrag ohne native Anmeldung", async () => {
  const employee = session("962", "employee");

  const status = await request("/api/mobile/v1/status");
  assert.equal(status.response.status, 200, JSON.stringify(status.payload));
  assert.equal(status.payload.appName, "Grabenplaner");
  assert.equal(status.payload.apiVersion, 1);
  assert.equal(status.payload.nativeAuthentication, false);
  assert.equal(status.payload.minimumMobileVersion, "0.3.0-alpha.1");
  assert.equal(status.payload.capabilities.personalSettingsRead, true);
  assert.equal(status.payload.capabilities.personalSettingsWrite, false);
  assert.equal(typeof status.payload.capabilities.personalizedGreetings, "boolean");

  const home = await request("/api/mobile/v1/me/home", { auth: employee });
  assert.equal(home.response.status, 409, JSON.stringify(home.payload));
  assert.equal(home.payload.error.code, "MOBILE_AUTH_UNAVAILABLE");

  const bootstrap = await request("/api/mobile/v1/bootstrap", { auth: employee });
  assert.equal(bootstrap.response.status, 409, JSON.stringify(bootstrap.payload));
  assert.equal(bootstrap.payload.error.code, "MOBILE_AUTH_UNAVAILABLE");
});

test("v0.60: Mobile-v1-Fehler besitzen Code, Meldung und nachvollziehbare Request-ID", async () => {
  const requestId = "v060-mobile-request-0001";
  const denied = await request("/api/mobile/v1/bootstrap", { requestId });

  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.response.headers.get("x-request-id"), requestId);
  assert.deepEqual(Object.keys(denied.payload), ["error"]);
  assert.equal(denied.payload.error.code, "MOBILE_AUTH_UNAVAILABLE");
  assert.equal(typeof denied.payload.error.message, "string");
  assert.equal(denied.payload.error.requestId, requestId);
});
