"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v062-mobile-"));
const dataRoot = path.join(testRoot, "server-data");
process.env.DB_PATH = path.join(dataRoot, "data", "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = dataRoot;
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_OPERATION_MODE = "server";
process.env.GRABENPLANER_PUBLIC_URL = "https://plan.example.test";
process.env.GRABENPLANER_TRUST_PROXY = "loopback";
process.env.GRABENPLANER_DEPLOYMENT_KIND = "codespaces-test";
process.env.GRABENPLANER_AMU_KEY_ID = "test-v1";
process.env.GRABENPLANER_AMU_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GRABENPLANER_WIFI_WEBHOOK_SECRET = "test-wifi-webhook-secret-0123456789abcdef";
process.env.GRABENPLANER_SERVICE_CONTROL_TOKEN = "test-service-control-token-0123456789abcdef";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db, hashPortalPassword, releaseInstanceLockForTests } = require("../server");

const employeeNumber = "970";
const otherEmployeeNumber = "971";
const mustChangeEmployeeNumber = "972";
const password = "SicheresMobilPasswort!";
const mustChangePassword = "MobilesStartpasswort!";
const minimumMobileVersion = "0.3.0-alpha.1";
let baseUrl;
let httpServer;
let locationId;

function secureHeaders(extra = {}) {
  return { "X-Forwarded-Proto": "https", ...extra };
}

async function request(route, { method = "GET", accessToken = "", cookie = "", csrf = "", body, headers = {} } = {}) {
  const requestHeaders = secureHeaders({ Accept: "application/json", ...headers });
  if (accessToken) requestHeaders.Authorization = `Bearer ${accessToken}`;
  if (cookie) requestHeaders.Cookie = cookie;
  if (csrf) requestHeaders["X-CSRF-Token"] = csrf;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function mobileDevice(installationId, overrides = {}) {
  return {
    installationId,
    platform: "android",
    label: "Testgerät",
    appVersion: minimumMobileVersion,
    ...overrides,
  };
}

async function mobileLoginFor(number, loginPassword, installationId = `install-${crypto.randomUUID()}`, deviceOverrides = {}) {
  return request("/api/mobile/v1/auth/login", {
    method: "POST",
    body: {
      employeeNumber: number,
      password: loginPassword,
      device: mobileDevice(installationId, deviceOverrides),
    },
  });
}

async function mobileLogin(installationId = `install-${crypto.randomUUID()}`) {
  return mobileLoginFor(employeeNumber, password, installationId);
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations ORDER BY id LIMIT 1").get().id;
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
    VALUES (?, 'Mona Mobil', 'Mona', '#287a67', 38.5, ?, 1)
  `).run(employeeNumber, locationId);
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
    VALUES (?, 'Otto Andere', 'Otto', '#774477', 38.5, ?, 1)
  `).run(otherEmployeeNumber, locationId);
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
    VALUES (?, 'Paula Passwort', 'Paula', '#7a5d28', 32, ?, 1)
  `).run(mustChangeEmployeeNumber, locationId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, ?, 'employee', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, await hashPortalPassword(password));
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, updated_at)
    VALUES (?, ?, 'employee', 1, 1, CURRENT_TIMESTAMP)
  `).run(mustChangeEmployeeNumber, await hashPortalPassword(mustChangePassword));
  db.prepare("UPDATE locations SET time_tracking_enabled = 1, time_tracking_access_mode = 'anywhere' WHERE id = ?").run(locationId);

  const kitDirectory = path.join(dataRoot, "branding-kits", "mobil-test");
  fs.mkdirSync(kitDirectory, { recursive: true });
  fs.writeFileSync(path.join(kitDirectory, "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");
  fs.writeFileSync(path.join(kitDirectory, "manifest.json"), JSON.stringify({
    id: "mobil-test",
    name: "Mobil Test",
    branding: {
      appName: "Grabenplaner",
      companyName: "Mobil Test GmbH",
      logoUrl: "/branding-kits/mobil-test/logo.svg",
      iconUrl: "https://tracking.invalid/icon.svg",
      logoAlt: "Mobil Test",
      adminEmail: "admin@example.test",
      colors: { primary: "#123456", secondary: "#287a67", accent: "#ffcc00", text: "#111111", background: "#ffffff" },
    },
  }), "utf8");
  db.prepare(`
    INSERT INTO location_branding
      (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by)
    VALUES (?, 'mobil-test', 'Mobil Test GmbH', '/branding-kits/mobil-test/logo.svg',
            'https://tracking.invalid/icon.svg', 'Mobil Test', 'admin@example.test', 'test')
    ON CONFLICT(location_id) DO UPDATE SET kit_id = excluded.kit_id, company_name = excluded.company_name,
      logo_url = excluded.logo_url, icon_url = excluded.icon_url, logo_alt = excluded.logo_alt,
      admin_email = excluded.admin_email, updated_by = excluded.updated_by
  `).run(locationId);

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

test("v0.62: native Anmeldung liefert ausschließlich gehashte Gerätesitzungen und Standortbranding", async () => {
  const status = await request("/api/mobile/v1/status");
  assert.equal(status.response.status, 200, JSON.stringify(status.payload));
  assert.equal(status.payload.nativeAuthentication, true);
  assert.equal(status.payload.minimumMobileVersion, minimumMobileVersion);
  assert.equal(status.payload.capabilities.personalSettingsWrite, true);
  assert.equal(status.response.headers.get("access-control-allow-origin"), null);

  const knownBranding = await request("/api/mobile/v1/auth/branding", {
    method: "POST",
    body: { employeeNumber },
  });
  const unknownBranding = await request("/api/mobile/v1/auth/branding", {
    method: "POST",
    body: { employeeNumber: "unbekannt" },
  });
  assert.equal(knownBranding.response.status, 200, JSON.stringify(knownBranding.payload));
  assert.equal(unknownBranding.response.status, 200, JSON.stringify(unknownBranding.payload));
  assert.deepEqual(knownBranding.payload, unknownBranding.payload);
  assert.notEqual(knownBranding.payload.branding.companyName, "Mobil Test GmbH");

  const portalToken = crypto.randomBytes(32).toString("base64url");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(portalToken).digest("hex"));
  const cookieOnly = await request("/api/mobile/v1/bootstrap", { cookie: `grabenplaner_session=${portalToken}` });
  assert.equal(cookieOnly.response.status, 401, JSON.stringify(cookieOnly.payload));
  assert.equal(cookieOnly.payload.error.code, "MOBILE_AUTH_REQUIRED");

  const login = await mobileLogin();
  assert.equal(login.response.status, 201, JSON.stringify(login.payload));
  assert.equal(login.response.headers.get("set-cookie"), null);
  assert.deepEqual(Object.keys(login.payload.tokenSet).sort(), [
    "accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt",
  ]);
  assert.equal(login.payload.bootstrap.user.employeeNumber, employeeNumber);
  assert.equal(login.payload.bootstrap.branding.companyName, "Mobil Test GmbH");
  assert.equal(login.payload.bootstrap.branding.logoUrl, "/branding-kits/mobil-test/logo.svg");
  assert.equal(login.payload.bootstrap.branding.iconUrl, "/assets/webicon.svg");
  assert.equal(login.payload.bootstrap.branding.theme.primary, "#123456");
  assert.match(login.payload.bootstrap.branding.revision, /^[a-f0-9]{24}$/);

  const row = db.prepare("SELECT * FROM mobile_sessions WHERE employee_number = ? ORDER BY created_at DESC LIMIT 1").get(employeeNumber);
  assert.notEqual(row.access_token_hash, login.payload.tokenSet.accessToken);
  assert.notEqual(row.refresh_token_hash, login.payload.tokenSet.refreshToken);
  assert.equal(JSON.stringify(row).includes(login.payload.tokenSet.accessToken), false);
  assert.equal(JSON.stringify(row).includes(login.payload.tokenSet.refreshToken), false);
});

test("v0.62: SemVer-Mindeststand und genau eine Sitzung je Installation werden erzwungen", async () => {
  const outdated = await mobileLoginFor(employeeNumber, password, "install-version-old", { appVersion: "0.3.0-alpha.0" });
  assert.equal(outdated.response.status, 426, JSON.stringify(outdated.payload));
  assert.equal(outdated.payload.error.code, "MOBILE_APP_UPDATE_REQUIRED");

  const invalid = await mobileLoginFor(employeeNumber, password, "install-version-invalid", { appVersion: "0.3" });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
  assert.equal(invalid.payload.error.code, "MOBILE_APP_VERSION_INVALID");

  const installationId = "install-single-device";
  const first = await mobileLogin(installationId);
  const replacement = await mobileLogin(installationId);
  assert.equal(first.response.status, 201, JSON.stringify(first.payload));
  assert.equal(replacement.response.status, 201, JSON.stringify(replacement.payload));
  const oldAccess = await request("/api/mobile/v1/bootstrap", { accessToken: first.payload.tokenSet.accessToken });
  assert.equal(oldAccess.response.status, 401, JSON.stringify(oldAccess.payload));
  const installationHash = crypto.createHash("sha256").update(installationId).digest("hex");
  const sessions = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions
    WHERE employee_number = ? AND installation_id_hash = ? ORDER BY created_at
  `).all(employeeNumber, installationHash);
  assert.equal(sessions.filter((entry) => !entry.revoked_at).length, 1);
  assert.equal(sessions.some((entry) => entry.revoked_reason === "device_replaced"), true);
});

test("v0.62: Refresh bindet das Gerät, rotiert einmalig und erkennt Reuse", async () => {
  const installationId = "install-refresh-bound";
  const login = await mobileLogin(installationId);
  const first = login.payload.tokenSet;

  const mismatch = await request("/api/mobile/v1/auth/refresh", {
    method: "POST",
    body: { refreshToken: first.refreshToken, device: mobileDevice("install-other-device") },
  });
  assert.equal(mismatch.response.status, 401, JSON.stringify(mismatch.payload));
  assert.equal(mismatch.payload.error.code, "MOBILE_DEVICE_MISMATCH");

  const outdated = await request("/api/mobile/v1/auth/refresh", {
    method: "POST",
    body: { refreshToken: first.refreshToken, device: mobileDevice(installationId, { appVersion: "0.3.0-alpha.0" }) },
  });
  assert.equal(outdated.response.status, 426, JSON.stringify(outdated.payload));
  assert.equal(outdated.payload.error.code, "MOBILE_APP_UPDATE_REQUIRED");

  const refreshDevice = mobileDevice(installationId, { label: "Gerät nach Update", appVersion: "0.3.0+build.7" });
  const refreshed = await request("/api/mobile/v1/auth/refresh", {
    method: "POST",
    body: { refreshToken: first.refreshToken, device: refreshDevice },
  });
  assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.payload));
  assert.notEqual(refreshed.payload.tokenSet.accessToken, first.accessToken);
  assert.notEqual(refreshed.payload.tokenSet.refreshToken, first.refreshToken);
  const refreshedSessionId = refreshed.payload.tokenSet.accessToken.split(".")[1];
  const refreshedSession = db.prepare("SELECT device_label, app_version FROM mobile_sessions WHERE id = ?").get(refreshedSessionId);
  assert.equal(refreshedSession.device_label, "Gerät nach Update");
  assert.equal(refreshedSession.app_version, "0.3.0+build.7");

  const oldAccess = await request("/api/mobile/v1/bootstrap", { accessToken: first.accessToken });
  assert.equal(oldAccess.response.status, 401, JSON.stringify(oldAccess.payload));
  const currentAccess = await request("/api/mobile/v1/bootstrap", { accessToken: refreshed.payload.tokenSet.accessToken });
  assert.equal(currentAccess.response.status, 200, JSON.stringify(currentAccess.payload));

  const refreshedAgain = await request("/api/mobile/v1/auth/refresh", {
    method: "POST",
    body: { refreshToken: refreshed.payload.tokenSet.refreshToken, device: refreshDevice },
  });
  assert.equal(refreshedAgain.response.status, 200, JSON.stringify(refreshedAgain.payload));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mobile_refresh_token_history WHERE session_id = ?").get(refreshedSessionId).count, 2);

  const replay = await request("/api/mobile/v1/auth/refresh", {
    method: "POST",
    body: { refreshToken: first.refreshToken, device: refreshDevice },
  });
  assert.equal(replay.response.status, 401, JSON.stringify(replay.payload));
  assert.equal(replay.payload.error.code, "MOBILE_REFRESH_REUSED");
  const revokedFamily = await request("/api/mobile/v1/bootstrap", { accessToken: refreshedAgain.payload.tokenSet.accessToken });
  assert.equal(revokedFamily.response.status, 401, JSON.stringify(revokedFamily.payload));

  const nextLogin = await mobileLogin("install-logout-access");
  const logout = await request("/api/mobile/v1/auth/logout", {
    method: "POST",
    accessToken: nextLogin.payload.tokenSet.accessToken,
    body: { refreshToken: nextLogin.payload.tokenSet.refreshToken },
  });
  assert.equal(logout.response.status, 200, JSON.stringify(logout.payload));
  assert.deepEqual(logout.payload, { ok: true });
  const afterLogout = await request("/api/mobile/v1/bootstrap", { accessToken: nextLogin.payload.tokenSet.accessToken });
  assert.equal(afterLogout.response.status, 401, JSON.stringify(afterLogout.payload));

  const refreshOnlyLogin = await mobileLogin("install-logout-refresh");
  const refreshOnlySessionId = refreshOnlyLogin.payload.tokenSet.accessToken.split(".")[1];
  db.prepare("UPDATE mobile_sessions SET access_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(refreshOnlySessionId);
  const refreshOnlyLogout = await request("/api/mobile/v1/auth/logout", {
    method: "POST",
    body: { refreshToken: refreshOnlyLogin.payload.tokenSet.refreshToken },
  });
  assert.equal(refreshOnlyLogout.response.status, 200, JSON.stringify(refreshOnlyLogout.payload));
  assert.deepEqual(refreshOnlyLogout.payload, { ok: true });
  assert.equal(db.prepare("SELECT revoked_reason FROM mobile_sessions WHERE id = ?").get(refreshOnlySessionId).revoked_reason, "logout");

  const repeatedLogout = await request("/api/mobile/v1/auth/logout", {
    method: "POST",
    body: { refreshToken: refreshOnlyLogin.payload.tokenSet.refreshToken },
  });
  const unknownLogout = await request("/api/mobile/v1/auth/logout", {
    method: "POST",
    body: { refreshToken: "kein-gueltiger-token" },
  });
  assert.equal(repeatedLogout.response.status, 200, JSON.stringify(repeatedLogout.payload));
  assert.equal(unknownLogout.response.status, 200, JSON.stringify(unknownLogout.payload));
  assert.deepEqual(repeatedLogout.payload, unknownLogout.payload);
});

test("v0.62: mobile Zeitbuchung nutzt Serverzeit und idempotente Client-ID", async () => {
  db.prepare("DELETE FROM time_entries WHERE employee_number = ?").run(employeeNumber);
  const login = await mobileLogin();
  const accessToken = login.payload.tokenSet.accessToken;
  const before = Date.now();
  const clientRequestId = crypto.randomUUID();
  const booked = await request("/api/mobile/v1/me/time-entries", {
    method: "POST",
    accessToken,
    body: { type: "clock_in", clientRequestId },
  });
  assert.equal(booked.response.status, 201, JSON.stringify(booked.payload));
  assert.equal(booked.payload.replayed, false);
  assert.equal(booked.payload.status.state, "working");
  const timestamp = new Date(booked.payload.status.entries.at(-1).timestamp).getTime();
  assert.ok(timestamp >= before && timestamp <= Date.now());

  const retry = await request("/api/mobile/v1/me/time-entries", {
    method: "POST",
    accessToken,
    body: { type: "clock_in", clientRequestId },
  });
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
  assert.equal(retry.payload.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM time_entries WHERE employee_number = ? AND client_request_id = ?").get(employeeNumber, clientRequestId).count, 1);
  const stored = db.prepare("SELECT source, mobile_session_id FROM time_entries WHERE employee_number = ? AND client_request_id = ?").get(employeeNumber, clientRequestId);
  assert.equal(stored.source, "mobile");
  assert.ok(stored.mobile_session_id);

  const conflict = await request("/api/mobile/v1/me/time-entries", {
    method: "POST",
    accessToken,
    body: { type: "break_start", clientRequestId },
  });
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.payload));
  assert.equal(conflict.payload.error.code, "TIME_ENTRY_IDEMPOTENCY_CONFLICT");

  db.prepare(`
    INSERT OR IGNORE INTO portal_roles (id, name, description, builtin, permissions, sort_order)
    VALUES ('mobile-time-readonly', 'Mobile Zeit lesen', '', 0, '["own_time:read"]', 98)
  `).run();
  db.prepare("UPDATE portal_users SET role = 'mobile-time-readonly' WHERE employee_number = ?").run(employeeNumber);
  try {
    const readOnlyHome = await request("/api/mobile/v1/me/home", { accessToken });
    assert.equal(readOnlyHome.response.status, 200, JSON.stringify(readOnlyHome.payload));
    assert.equal(readOnlyHome.payload.timeTracking.state, "working");
    assert.deepEqual(readOnlyHome.payload.timeTracking.allowedActions, []);
    const readOnlyEntries = await request("/api/mobile/v1/me/time-entries", { accessToken });
    assert.equal(readOnlyEntries.response.status, 200, JSON.stringify(readOnlyEntries.payload));
    assert.deepEqual(readOnlyEntries.payload.status.allowedActions, []);
    const deniedWrite = await request("/api/mobile/v1/me/time-entries", {
      method: "POST",
      accessToken,
      body: { type: "break_start", clientRequestId: crypto.randomUUID() },
    });
    assert.equal(deniedWrite.response.status, 403, JSON.stringify(deniedWrite.payload));
    assert.equal(deniedWrite.payload.error.code, "MOBILE_PERMISSION_DENIED");
  } finally {
    db.prepare("UPDATE portal_users SET role = 'employee' WHERE employee_number = ?").run(employeeNumber);
  }
});

test("v0.62: persönlicher Dienstplan liefert nur eigene Daten und Rechte werden dynamisch geprüft", async () => {
  db.prepare("DELETE FROM shifts WHERE employee_number IN (?, ?)").run(employeeNumber, otherEmployeeNumber);
  db.prepare("DELETE FROM week_options WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`INSERT INTO shifts (employee_number, shift_date, start_time, end_time, area, note) VALUES (?, '2030-07-08', '09:00', '18:00', 'Verkauf', 'Eigener Dienst')`)
    .run(employeeNumber);
  db.prepare(`INSERT INTO shifts (employee_number, shift_date, start_time, end_time, area, note) VALUES (?, '2030-07-08', '10:00', '17:00', 'Fremd', 'Nicht ausliefern')`)
    .run(otherEmployeeNumber);
  db.prepare(`INSERT INTO week_options (employee_number, week_start, date_from, date_to, option_type, note, all_day) VALUES (?, '2030-07-08', '2030-07-09', '2030-07-09', 'urlaub', 'Frei', 1)`)
    .run(employeeNumber);

  const login = await mobileLogin();
  const accessToken = login.payload.tokenSet.accessToken;
  const schedule = await request("/api/mobile/v1/me/schedule?week=2030-07-08", { accessToken });
  assert.equal(schedule.response.status, 200, JSON.stringify(schedule.payload));
  assert.equal(schedule.payload.weekStart, "2030-07-08");
  assert.equal(schedule.payload.shifts.length, 1);
  assert.equal(schedule.payload.shifts[0].note, "Eigener Dienst");
  assert.equal(schedule.payload.options.length, 1);
  assert.equal(schedule.payload.options[0].allDay, true);
  assert.equal(JSON.stringify(schedule.payload).includes("Nicht ausliefern"), false);

  db.prepare(`INSERT OR IGNORE INTO portal_roles (id, name, description, builtin, permissions, sort_order) VALUES ('mobile-limited', 'Mobile eingeschränkt', '', 0, '[]', 99)`)
    .run();
  db.prepare("UPDATE portal_users SET role = 'mobile-limited' WHERE employee_number = ?").run(employeeNumber);
  const denied = await request("/api/mobile/v1/me/schedule?week=2030-07-08", { accessToken });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.error.code, "MOBILE_PERMISSION_DENIED");
  db.prepare("UPDATE portal_users SET role = 'employee' WHERE employee_number = ?").run(employeeNumber);
});

test("v0.62: Startpasswort erlaubt Bootstrap und wird mit sicherer Sitzungsrotation geändert", async () => {
  const primary = await mobileLoginFor(mustChangeEmployeeNumber, mustChangePassword, "install-password-primary");
  const secondary = await mobileLoginFor(mustChangeEmployeeNumber, mustChangePassword, "install-password-secondary");
  assert.equal(primary.response.status, 201, JSON.stringify(primary.payload));
  assert.equal(secondary.response.status, 201, JSON.stringify(secondary.payload));
  assert.equal(primary.payload.bootstrap.user.mustChangePassword, true);

  const recoverableBootstrap = await request("/api/mobile/v1/bootstrap", {
    accessToken: primary.payload.tokenSet.accessToken,
  });
  assert.equal(recoverableBootstrap.response.status, 200, JSON.stringify(recoverableBootstrap.payload));
  assert.equal(recoverableBootstrap.payload.user.mustChangePassword, true);

  const blockedHome = await request("/api/mobile/v1/me/home", {
    accessToken: primary.payload.tokenSet.accessToken,
  });
  assert.equal(blockedHome.response.status, 428, JSON.stringify(blockedHome.payload));
  assert.equal(blockedHome.payload.error.code, "MOBILE_PASSWORD_CHANGE_REQUIRED");

  const changed = await request("/api/mobile/v1/me/password", {
    method: "POST",
    accessToken: primary.payload.tokenSet.accessToken,
    body: { currentPassword: mustChangePassword, newPassword: "NeuesMobilesPasswort!" },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.ok, true);
  assert.deepEqual(Object.keys(changed.payload.tokenSet).sort(), [
    "accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt",
  ]);

  const oldPrimary = await request("/api/mobile/v1/bootstrap", {
    accessToken: primary.payload.tokenSet.accessToken,
  });
  const oldSecondary = await request("/api/mobile/v1/bootstrap", {
    accessToken: secondary.payload.tokenSet.accessToken,
  });
  assert.equal(oldPrimary.response.status, 401, JSON.stringify(oldPrimary.payload));
  assert.equal(oldSecondary.response.status, 401, JSON.stringify(oldSecondary.payload));

  const continued = await request("/api/mobile/v1/me/home", {
    accessToken: changed.payload.tokenSet.accessToken,
  });
  assert.equal(continued.response.status, 200, JSON.stringify(continued.payload));
  const after = await request("/api/mobile/v1/bootstrap", {
    accessToken: changed.payload.tokenSet.accessToken,
  });
  assert.equal(after.response.status, 200, JSON.stringify(after.payload));
  assert.equal(after.payload.user.mustChangePassword, false);
});

test("v0.62: Installation-Feature sperrt mobile Zeiterfassung und Passwortwechsel widerruft mobile Sessions", async () => {
  const login = await mobileLogin();
  const accessToken = login.payload.tokenSet.accessToken;
  const oldFeatures = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get()?.value || "";
  db.prepare("INSERT INTO settings (key, value) VALUES ('installation_features', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(["schedule", "employeePortal"]));
  const disabled = await request("/api/mobile/v1/me/time-entries", { accessToken });
  assert.equal(disabled.response.status, 403, JSON.stringify(disabled.payload));
  assert.equal(disabled.payload.error.code, "FEATURE_DISABLED");
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'").run(oldFeatures || JSON.stringify(["schedule", "vacation", "requests", "employeePortal", "timeTracking", "sicknessAmu", "wifiSuggestions"]));

  const portalToken = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  db.prepare(`INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at) VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')`)
    .run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(portalToken).digest("hex"));
  const changed = await request("/api/portal/v1/me/password", {
    method: "PUT",
    cookie: `grabenplaner_session=${portalToken}; grabenplaner_csrf=${csrf}`,
    csrf,
    body: { currentPassword: password, newPassword: "NochSichererMobilPass!" },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  const revoked = await request("/api/mobile/v1/bootstrap", { accessToken });
  assert.equal(revoked.response.status, 401, JSON.stringify(revoked.payload));
});
