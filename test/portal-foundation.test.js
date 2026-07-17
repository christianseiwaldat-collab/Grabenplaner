const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createAmuStorage } = require("../lib/amu-storage");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-portal-test-"));
const databasePath = path.join(testRoot, "legacy.db");
const backupPath = path.join(testRoot, "backups");

const legacyDb = new DatabaseSync(databasePath);
legacyDb.exec(`
  CREATE TABLE portal_users (
    employee_number TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'employee',
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE portal_roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_number TEXT NOT NULL,
    entry_type TEXT NOT NULL,
    entry_timestamp TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'portal',
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO portal_roles (id, name, builtin, permissions)
  VALUES ('employee', 'Alt', 1, '["legacy"]');
  INSERT INTO portal_roles (id, name, builtin, permissions)
  VALUES ('custom-auditor', 'Eigene Prüferrolle', 0, '["audit:read"]');
`);
legacyDb.close();

process.env.DB_PATH = databasePath;
process.env.BACKUP_DIR = backupPath;
process.env.GRABENPLANER_HOST = "127.0.0.1";

const {
  app,
  db,
  getPortalRoles,
  getPortalStatus,
  hashPortalPassword,
  verifyPortalPassword,
  timeTrackingDayStatus,
  bookTimeEntry,
  resolveStaleTimeEntry,
  timePresenceForContext,
  releaseInstanceLockForTests,
} = require("../server");

let httpServer;
let baseUrl;

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForJson(url, child, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Serverprozess wurde vorzeitig mit Code ${child.exitCode} beendet.`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server war nach ${timeoutMs} ms nicht erreichbar.`);
}

async function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Serverprozess wurde nach ${timeoutMs} ms nicht beendet.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  db.close();
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("alte Datenbank wird um das Portal-Fundament erweitert", () => {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  assert.ok(tables.has("portal_sessions"));
  assert.ok(tables.has("mobile_sessions"));
  assert.ok(tables.has("mobile_refresh_token_history"));
  assert.ok(tables.has("vacation_requests"));
  assert.ok(tables.has("time_off_requests"));
  assert.ok(tables.has("time_off_change_requests"));
  assert.ok(tables.has("vacation_change_requests"));
  assert.ok(tables.has("request_blackouts"));
  assert.ok(tables.has("request_decisions"));
  assert.ok(tables.has("approval_delegations"));
  assert.ok(tables.has("time_entries"));
  assert.ok(tables.has("time_corrections"));
  assert.ok(tables.has("audit_log"));
  assert.ok(tables.has("portal_permission_grants"));
  assert.ok(tables.has("location_branding"));
  assert.ok(tables.has("schema_migrations"));
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.49-server-foundation'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.53-rights-branding-time-corrections-mobile'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.53.1-branch-branding-snapshots'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.54-protected-developer-role-rights'").get());

  const userColumns = new Set(db.prepare("PRAGMA table_info(portal_users)").all().map((column) => column.name));
  assert.ok(userColumns.has("password_changed_at"));
  assert.ok(userColumns.has("failed_login_attempts"));
  assert.ok(userColumns.has("locked_until"));
  assert.ok(userColumns.has("role_locked"));

  const roleColumns = new Set(db.prepare("PRAGMA table_info(portal_roles)").all().map((column) => column.name));
  assert.ok(roleColumns.has("description"));
  assert.ok(roleColumns.has("sort_order"));
  assert.ok(roleColumns.has("updated_at"));

  const timeEntryColumns = new Set(db.prepare("PRAGMA table_info(time_entries)").all().map((column) => column.name));
  assert.ok(timeEntryColumns.has("client_request_id"));
  assert.ok(timeEntryColumns.has("mobile_session_id"));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_time_entries_mobile_request'").get());
});

test("Built-in-Rollen werden aktualisiert und eigene Rollen bleiben erhalten", () => {
  const roles = getPortalRoles();
  const employee = roles.find((role) => role.id === "employee");
  const custom = roles.find((role) => role.id === "custom-auditor");
  assert.equal(employee.name, "Mitarbeiter");
  assert.ok(employee.permissions.includes("own_schedule:read"));
  assert.ok(employee.permissions.includes("own_vacation:request"));
  assert.ok(roles.some((role) => role.id === "hr" && role.name === "Personalleitung" && role.permissions.includes("hr:approve")));
  assert.ok(roles.some((role) => role.id === "admin" && role.permissions.includes("rights:write") && role.permissions.includes("branding:write")));
  assert.ok(roles.some((role) => role.id === "hr" && role.permissions.includes("rights:write") && role.permissions.includes("operation_mode:write")));
  assert.ok(roles.some((role) => role.id === "it_admin" && role.permissions.includes("rights:write") && role.permissions.includes("update:write") && role.permissions.includes("employees:write")));
  assert.ok(roles.some((role) => role.id === "developer" && role.protected && !role.assignable && role.permissions.includes("developer:system")));
  assert.equal(custom.name, "Eigene Prüferrolle");
  assert.deepEqual(custom.permissions, ["audit:read"]);
});

test("Status meldet verfügbaren LAN-Modus bei weiterhin sicherem Lokalbetrieb", async () => {
  const directStatus = getPortalStatus();
  assert.equal(directStatus.operationMode, "local");
  assert.equal(directStatus.serverModeStatus, "active");
  assert.equal(directStatus.portalEnabled, false);
  assert.equal(directStatus.loginRequired, false);
  assert.equal(directStatus.localOnly, true);

  const response = await fetch(`${baseUrl}/api/portal/v1/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.apiVersion, 1);
  assert.equal(status.operationMode, "local");
  assert.equal(status.capabilities.timeOffRequests, false);
  assert.equal(status.capabilities.vacationChanges, false);
  assert.equal(status.capabilities.requestBlackouts, false);
  assert.equal(status.capabilities.timeTracking, false);
});

test("Session- und Rollen-Endpunkte haben einen stabilen v1-Vertrag", async () => {
  const sessionResponse = await fetch(`${baseUrl}/api/portal/v1/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, false);
  assert.equal(session.loginRequired, false);
  assert.equal(session.user, null);

  const rolesResponse = await fetch(`${baseUrl}/api/portal/v1/roles`);
  assert.equal(rolesResponse.status, 200);
  const roles = await rolesResponse.json();
  assert.equal(roles.apiVersion, 1);
  assert.ok(roles.roles.some((role) => role.id === "admin" && role.builtin));
});

test("Login und Mitarbeiterfunktionen bleiben bis zum Servermodus gesperrt", async () => {
  const response = await fetch(`${baseUrl}/api/portal/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personnelNumber: "07", password: "nicht-aktiv" }),
  });
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.code, "PORTAL_INACTIVE");
  assert.equal(result.status.operationMode, "local");
});

test("Servermodus kann im Browser nicht ungeschützt aktiviert werden", async () => {
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationMode: "server" }),
  });
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.match(result.error, /Serverkonfiguration/i);
  assert.equal(getPortalStatus().operationMode, "local");
});

test("bestehende lokale Dienstplan-API bleibt erreichbar", async () => {
  const response = await fetch(`${baseUrl}/api/schedule?week=2026-07-13`);
  assert.equal(response.status, 200);
  const schedule = await response.json();
  assert.equal(schedule.weekStart, "2026-07-13");
  assert.equal(schedule.settings.operation_mode, "local");
  assert.equal(schedule.settings.server_mode_status, "active");
});

test("PDF-Vorschauen dürfen nur gleichursprünglich eingebettet werden", async () => {
  for (const previewPath of [
    "/api/schedule-preview.pdf?week=2026-07-13",
    "/api/vacations-preview.pdf?year=2026&view=year",
  ]) {
    const response = await fetch(`${baseUrl}${previewPath}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("content-type") || "", /^application\/pdf/i);
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(response.headers.get("content-security-policy") || "", /frame-ancestors 'self'/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("ascii"), "%PDF");
  }

  const protectedResponse = await fetch(`${baseUrl}/api/portal/v1/status`);
  assert.equal(protectedResponse.headers.get("x-frame-options"), "DENY");
  assert.match(protectedResponse.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
});

test("vorbereitete Passwort-Hashes verwenden scrypt, Salz und Versionskennung", async () => {
  const password = "EinSicheresTestpasswort!";
  const hashA = await hashPortalPassword(password);
  const hashB = await hashPortalPassword(password);
  assert.match(hashA, /^scrypt-v1\$/);
  assert.notEqual(hashA, hashB);
  assert.equal(hashA.includes(password), false);
  assert.equal(await verifyPortalPassword(password, hashA), true);
  assert.equal(await verifyPortalPassword("falsch", hashA), false);
  assert.equal(await verifyPortalPassword(password, "ungueltig"), false);
});

test("Zeiterfassung erzwingt die sichere Buchungsfolge und berechnet die Ist-Zeit", () => {
  const location = db.prepare("SELECT id, name FROM locations ORDER BY id LIMIT 1").get();
  assert.ok(location);
  const employeeNumber = "991";
  db.prepare(`
    INSERT OR REPLACE INTO employees (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
    VALUES (?, 'Zeit Test', 'Zeit', '#446688', 38.5, ?, 1)
  `).run(employeeNumber, location.id);
  db.prepare("UPDATE locations SET time_tracking_enabled = 1 WHERE id = ?").run(location.id);
  const times = [
    new Date("2026-07-13T07:00:00.000Z"),
    new Date("2026-07-13T10:00:00.000Z"),
    new Date("2026-07-13T10:30:00.000Z"),
    new Date("2026-07-13T15:00:00.000Z"),
  ];
  try {
    assert.deepEqual(timeTrackingDayStatus(employeeNumber, "2026-07-13", times[0]).allowedActions, ["clock_in"]);
    assert.equal(bookTimeEntry(employeeNumber, "clock_in", times[0]).state, "working");
    assert.throws(() => bookTimeEntry(employeeNumber, "clock_in", times[0]), (error) => error.code === "TIME_ENTRY_STATE_CONFLICT");
    assert.equal(bookTimeEntry(employeeNumber, "break_start", times[1]).state, "paused");
    assert.equal(bookTimeEntry(employeeNumber, "break_end", times[2]).state, "working");
    const completed = bookTimeEntry(employeeNumber, "clock_out", times[3]);
    assert.equal(completed.state, "off");
    assert.equal(completed.actualMinutes, 450);
    assert.deepEqual(completed.allowedActions, ["clock_in"]);
    const presence = timePresenceForContext({ employeeNumber: "local", role: "admin", permissions: ["time:read"] }, {
      locationId: location.id, locationName: location.name, departmentId: null, departmentName: "",
    }, "2026-07-13", times[3]);
    assert.equal(presence.employees.find((employee) => employee.employeeNumber === employeeNumber)?.actualMinutes, 450);

    db.prepare("DELETE FROM time_entries WHERE employee_number = ?").run(employeeNumber);
    bookTimeEntry(employeeNumber, "clock_in", times[0]);
    const nextMorning = new Date("2026-07-14T08:00:00.000Z");
    const stale = timeTrackingDayStatus(employeeNumber, "2026-07-14", nextMorning);
    assert.equal(stale.state, "attention");
    assert.equal(stale.allowedActions.length, 0);
    assert.equal(stale.staleEntry.date, "2026-07-13");
    const resolved = resolveStaleTimeEntry(
      { employeeNumber: "local", role: "admin", permissions: ["time:review"] },
      employeeNumber,
      "2026-07-13",
      "17:00",
      nextMorning,
    );
    assert.equal(resolved.state, "off");
    assert.equal(resolved.staleEntry, null);
    assert.equal(timeTrackingDayStatus(employeeNumber, "2026-07-13", nextMorning).actualMinutes, 480);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM time_corrections WHERE employee_number = ?").get(employeeNumber).count, 1);
    const staleCorrection = db.prepare(`
      SELECT id, location_id, requested_by, decided_by, decision_note
      FROM time_corrections WHERE employee_number = ?
    `).get(employeeNumber);
    assert.equal(staleCorrection.location_id, location.id);
    assert.equal(staleCorrection.requested_by, "local");
    assert.equal(staleCorrection.decided_by, "local");
    assert.ok(staleCorrection.decision_note);
    assert.equal(db.prepare(`
      SELECT correction_id FROM time_entries
      WHERE employee_number = ? AND entry_type = 'clock_out' ORDER BY id DESC LIMIT 1
    `).get(employeeNumber).correction_id, staleCorrection.id);
  } finally {
    db.prepare("DELETE FROM time_entries WHERE employee_number = ?").run(employeeNumber);
    db.prepare("DELETE FROM time_corrections WHERE employee_number = ?").run(employeeNumber);
    db.prepare("DELETE FROM employees WHERE personnel_number = ?").run(employeeNumber);
    db.prepare("UPDATE locations SET time_tracking_enabled = 0 WHERE id = ?").run(location.id);
  }
});

test("produktiver Start bleibt auf Loopback und blockiert externe Bindung", async () => {
  const childRoot = path.join(testRoot, "child-start");
  fs.mkdirSync(childRoot, { recursive: true });
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(childRoot, "dienstplan.db"),
      BACKUP_DIR: path.join(childRoot, "backups"),
      GRABENPLANER_DATA_DIR: path.join(childRoot, "app-data"),
      GRABENPLANER_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const status = await waitForJson(`http://127.0.0.1:${port}/api/portal/v1/status`, child);
    assert.equal(status.localOnly, true);
    assert.equal(status.portalEnabled, false);
    const exitResponse = await fetch(`http://127.0.0.1:${port}/api/system/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(exitResponse.status, 200);
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, stderr);
    assert.match(stdout, new RegExp(`http://localhost:${port}`));
  } finally {
    if (child.exitCode === null) child.kill();
  }

  const blockedPort = await getFreePort();
  const blocked = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(blockedPort),
      DB_PATH: path.join(childRoot, "blocked.db"),
      BACKUP_DIR: path.join(childRoot, "blocked-backups"),
      GRABENPLANER_HOST: "0.0.0.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let blockedError = "";
  blocked.stderr.on("data", (chunk) => { blockedError += chunk.toString(); });
  const blockedExit = await waitForExit(blocked);
  assert.notEqual(blockedExit.code, 0);
  assert.match(blockedError, /LAN-Bindung/i);
});

test("LAN-Pilot: Admin, Mitarbeiter-Login und Urlaubsfreigabe funktionieren durchgängig", async () => {
  const childRoot = path.join(testRoot, "lan-pilot");
  fs.mkdirSync(childRoot, { recursive: true });
  const childDatabase = path.join(childRoot, "dienstplan.db");
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: childDatabase,
      BACKUP_DIR: path.join(childRoot, "backups"),
      GRABENPLANER_DATA_DIR: path.join(childRoot, "app-data"),
      GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_FORCE_PORTAL: "1",
      GRABENPLANER_SEED_DEMO: "1",
      NODE_ENV: "test",
      GRABENPLANER_TEST_AMU_SCANNER: "clean",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;

  function sessionHeaders(response) {
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrfCookie = setCookies.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("grabenplaner_csrf="));
    return { cookie, csrf: decodeURIComponent(csrfCookie.split("=").slice(1).join("=")) };
  }

  try {
    const status = await waitForJson(`${url}/api/portal/v1/status`, child);
    assert.equal(status.portalEnabled, true);

    const setup = await fetch(`${url}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: "987654" }),
    });
    assert.equal(setup.status, 201, await setup.clone().text());

    const adminLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: "987654" }),
    });
    assert.equal(adminLogin.status, 200, await adminLogin.clone().text());
    const admin = sessionHeaders(adminLogin);

    // Branding-ZIP-Dateien werden in der portablen Windows-App bewusst mit
    // PowerShell gepackt. Codespaces prüft die plattformneutralen Portalabläufe;
    // der ZIP-Roundtrip bleibt Teil der vollständigen Windows-Testsuite.
    if (process.platform === "win32") {
      const brandingExport = await fetch(`${url}/api/branding/export.zip?locationId=01`, { headers: { Cookie: admin.cookie } });
      assert.equal(brandingExport.status, 200, await brandingExport.clone().text());
      const brandingImport = await fetch(`${url}/api/branding/import.zip?locationId=01`, {
        method: "PUT",
        headers: { "Content-Type": "application/zip", "X-Branding-Filename": "roundtrip.zip", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
        body: await brandingExport.arrayBuffer(),
      });
      assert.equal(brandingImport.status, 200, await brandingImport.clone().text());
      for (const fileName of ["fokus-und-licht-branding-kit.zip", "berg-und-ball-branding-kit.zip"]) {
        const kitPath = path.join(__dirname, "..", "demo", "branding-kits", fileName);
        const demoImport = await fetch(`${url}/api/branding/import.zip?locationId=01`, {
          method: "PUT",
          headers: { "Content-Type": "application/zip", "X-Branding-Filename": fileName, Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
          body: fs.readFileSync(kitPath),
        });
        assert.equal(demoImport.status, 200, `${fileName}: ${await demoImport.clone().text()}`);
      }
    }

    const createEmployeeAccess = await fetch(`${url}/api/portal/v1/users/102`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "employee", active: true, password: "654321", mustChangePassword: true }),
    });
    assert.equal(createEmployeeAccess.status, 200, await createEmployeeAccess.clone().text());

    const employeeLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "102", password: "654321" }),
    });
    assert.equal(employeeLogin.status, 200, await employeeLogin.clone().text());
    const employee = sessionHeaders(employeeLogin);

    const passwordChange = await fetch(`${url}/api/portal/v1/me/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ currentPassword: "654321", newPassword: "123456" }),
    });
    assert.equal(passwordChange.status, 200, await passwordChange.clone().text());

    const locationsResponse = await fetch(`${url}/api/locations`, { headers: { Cookie: admin.cookie } });
    assert.equal(locationsResponse.status, 200, await locationsResponse.clone().text());
    const location = (await locationsResponse.json()).find((item) => item.id === "01");
    const enableTimeTracking = await fetch(`${url}/api/locations/01`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        id: location.id, name: location.name, minStaff: location.min_staff, active: location.active,
        daySettings: location.day_settings, timeTrackingEnabled: true,
      }),
    });
    assert.equal(enableTimeTracking.status, 200, await enableTimeTracking.clone().text());
    const initialTimeStatus = await fetch(`${url}/api/portal/v1/me/time-entries`, { headers: { Cookie: employee.cookie } });
    assert.equal(initialTimeStatus.status, 200, await initialTimeStatus.clone().text());
    assert.equal((await initialTimeStatus.json()).status.trackingEnabled, true);
    const clockIn = await fetch(`${url}/api/portal/v1/me/time-entries`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ type: "clock_in" }),
    });
    assert.equal(clockIn.status, 201, await clockIn.clone().text());
    assert.equal((await clockIn.json()).status.state, "working");
    const duplicateClockIn = await fetch(`${url}/api/portal/v1/me/time-entries`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ type: "clock_in" }),
    });
    assert.equal(duplicateClockIn.status, 409, await duplicateClockIn.clone().text());
    const clockOut = await fetch(`${url}/api/portal/v1/me/time-entries`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ type: "clock_out" }),
    });
    assert.equal(clockOut.status, 201, await clockOut.clone().text());
    assert.equal((await clockOut.json()).status.state, "off");
    const presenceResponse = await fetch(`${url}/api/portal/v1/time-presence?locationId=01`, { headers: { Cookie: admin.cookie } });
    assert.equal(presenceResponse.status, 200, await presenceResponse.clone().text());
    assert.ok((await presenceResponse.json()).presence.employees.some((item) => item.employeeNumber === "102"));

    const createManagerAccess = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "manager", active: true, password: "112233", mustChangePassword: true }),
    });
    assert.equal(createManagerAccess.status, 200, await createManagerAccess.clone().text());
    const assignManagerScope = await fetch(`${url}/api/portal/v1/users/103/scopes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ scopes: [{ locationId: "01" }] }),
    });
    assert.equal(assignManagerScope.status, 200, await assignManagerScope.clone().text());
    const scopedUsers = await assignManagerScope.json();
    assert.deepEqual(scopedUsers.users.find((item) => item.employeeNumber === "103").scopes, [{ locationId: "01", departmentId: null }]);

    const createHrAccess = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "hr", active: true, password: "112233", mustChangePassword: true }),
    });
    assert.equal(createHrAccess.status, 200, await createHrAccess.clone().text());
    const hrLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "103", password: "112233" }),
    });
    assert.equal(hrLogin.status, 200, await hrLogin.clone().text());
    const hr = sessionHeaders(hrLogin);
    const hrPasswordChange = await fetch(`${url}/api/portal/v1/me/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ currentPassword: "112233", newPassword: "332211" }),
    });
    assert.equal(hrPasswordChange.status, 200, await hrPasswordChange.clone().text());
    const saturdaySlotsResponse = await fetch(`${url}/api/portal/v1/me/time-off-slots?date=2027-03-13`, { headers: { Cookie: employee.cookie } });
    assert.equal(saturdaySlotsResponse.status, 200, await saturdaySlotsResponse.clone().text());
    const saturdaySlots = await saturdaySlotsResponse.json();
    assert.equal(saturdaySlots.startTimes[0], "10:00");
    assert.equal(saturdaySlots.endTimes.at(-1), "17:00");

    const blackoutResponse = await fetch(`${url}/api/portal/v1/request-blackouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        locationId: "01",
        dateFrom: "2027-12-01",
        dateTo: "2027-12-24",
        blockVacation: true,
        blockTimeOff: false,
        reason: "Weihnachtsgeschäft",
      }),
    });
    assert.equal(blackoutResponse.status, 201, await blackoutResponse.clone().text());

    const blockedVacationCheck = await fetch(`${url}/api/portal/v1/me/vacation-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-12-06", dateTo: "2027-12-10" }),
    });
    assert.equal(blockedVacationCheck.status, 200, await blockedVacationCheck.clone().text());
    const blockedVacation = await blockedVacationCheck.json();
    assert.equal(blockedVacation.trafficLight, "red");
    assert.match(blockedVacation.reason, /Weihnachtsgeschäft/);

    const allowedTimeOffCheck = await fetch(`${url}/api/portal/v1/me/time-off-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ date: "2027-12-10", startTime: "11:00", endTime: "14:00" }),
    });
    assert.equal(allowedTimeOffCheck.status, 200, await allowedTimeOffCheck.clone().text());
    const allowedTimeOff = await allowedTimeOffCheck.json();
    assert.equal(allowedTimeOff.trafficLight, "yellow");
    assert.equal(allowedTimeOff.allowed, true);

    const multiDayTimeOffResponse = await fetch(`${url}/api/portal/v1/me/time-off-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-11-08", dateTo: "2027-11-09", allDay: true, note: "Zwei Tage ZA" }),
    });
    assert.equal(multiDayTimeOffResponse.status, 201, await multiDayTimeOffResponse.clone().text());
    const multiDayTimeOff = await multiDayTimeOffResponse.json();
    const editMultiDayTimeOff = await fetch(`${url}/api/portal/v1/me/time-off-requests/${multiDayTimeOff.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-11-10", dateTo: "2027-11-12", allDay: true, note: "Drei Tage ZA" }),
    });
    assert.equal(editMultiDayTimeOff.status, 200, await editMultiDayTimeOff.clone().text());
    const ownTimeOffResponse = await fetch(`${url}/api/portal/v1/me/time-off-requests`, { headers: { Cookie: employee.cookie } });
    const ownTimeOff = await ownTimeOffResponse.json();
    const editedMultiDay = ownTimeOff.requests.find((item) => item.id === multiDayTimeOff.id);
    assert.equal(editedMultiDay.date_from, "2027-11-10");
    assert.equal(editedMultiDay.date_to, "2027-11-12");
    assert.equal(Boolean(editedMultiDay.all_day), true);
    const approveMultiDayTimeOff = await fetch(`${url}/api/portal/v1/absence-requests/time_off/${multiDayTimeOff.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "approve", note: "Mehrtagestest" }),
    });
    assert.equal(approveMultiDayTimeOff.status, 200, await approveMultiDayTimeOff.clone().text());
    assert.equal((await approveMultiDayTimeOff.json()).request.status, "approved");
    const approvedMultiDayResponse = await fetch(`${url}/api/portal/v1/me/approved-time-off`, { headers: { Cookie: employee.cookie } });
    assert.equal(approvedMultiDayResponse.status, 200, await approvedMultiDayResponse.clone().text());
    const approvedMultiDay = (await approvedMultiDayResponse.json()).requests.find((item) => item.id === multiDayTimeOff.id);
    assert.equal(approvedMultiDay.date_from, "2027-11-10");
    assert.equal(approvedMultiDay.date_to, "2027-11-12");
    assert.equal(Boolean(approvedMultiDay.all_day), true);

    const multiDayChangeResponse = await fetch(`${url}/api/portal/v1/me/time-off-change-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ requestId: multiDayTimeOff.id, requestType: "change", dateFrom: "2027-11-15", dateTo: "2027-11-16", allDay: true, note: "Termin verschieben" }),
    });
    assert.equal(multiDayChangeResponse.status, 201, await multiDayChangeResponse.clone().text());
    const multiDayChange = await multiDayChangeResponse.json();
    const approveMultiDayChange = await fetch(`${url}/api/portal/v1/absence-requests/time_off_change/${multiDayChange.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "approve", note: "Verschiebung genehmigt" }),
    });
    assert.equal(approveMultiDayChange.status, 200, await approveMultiDayChange.clone().text());
    assert.equal((await approveMultiDayChange.json()).request.status, "approved");
    const changedApprovedResponse = await fetch(`${url}/api/portal/v1/me/approved-time-off`, { headers: { Cookie: employee.cookie } });
    const changedApproved = (await changedApprovedResponse.json()).requests.find((item) => item.id === multiDayTimeOff.id);
    assert.equal(changedApproved.date_from, "2027-11-15");
    assert.equal(changedApproved.date_to, "2027-11-16");

    const requestResponse = await fetch(`${url}/api/portal/v1/me/vacation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-02-08", dateTo: "2027-02-12", note: "Testurlaub" }),
    });
    assert.equal(requestResponse.status, 201, await requestResponse.clone().text());
    const vacationRequest = await requestResponse.json();

    const decisionResponse = await fetch(`${url}/api/portal/v1/vacation-requests/${vacationRequest.id}/decision`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(decisionResponse.status, 200, await decisionResponse.clone().text());
    const decision = await decisionResponse.json();
    assert.equal(decision.status, "approved");
    assert.match(decision.vacationGroupId, /^vac-/);

    const approvedVacationsResponse = await fetch(`${url}/api/portal/v1/me/approved-vacations`, {
      headers: { Cookie: employee.cookie },
    });
    assert.equal(approvedVacationsResponse.status, 200, await approvedVacationsResponse.clone().text());
    const approvedVacations = await approvedVacationsResponse.json();
    assert.ok(approvedVacations.vacations.some((item) => item.groupId === decision.vacationGroupId));

    const changeRequestResponse = await fetch(`${url}/api/portal/v1/me/vacation-change-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({
        groupId: decision.vacationGroupId,
        requestType: "change",
        dateFrom: "2027-02-15",
        dateTo: "2027-02-19",
        note: "Terminverschiebung",
      }),
    });
    assert.equal(changeRequestResponse.status, 201, await changeRequestResponse.clone().text());
    const changeRequest = await changeRequestResponse.json();

    const changeDecisionResponse = await fetch(`${url}/api/portal/v1/vacation-change-requests/${changeRequest.id}/decision`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(changeDecisionResponse.status, 200, await changeDecisionResponse.clone().text());

    for (const employeeNumber of ["101", "102", "103"]) {
      const shiftResponse = await fetch(`${url}/api/shifts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
        body: JSON.stringify({ employeeNumber, date: "2027-03-08", startTime: "09:00", endTime: "18:00" }),
      });
      assert.equal(shiftResponse.status, 201, await shiftResponse.clone().text());
    }

    const greenTimeOffCheckResponse = await fetch(`${url}/api/portal/v1/me/time-off-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ date: "2027-03-08", startTime: "11:00", endTime: "14:00" }),
    });
    assert.equal(greenTimeOffCheckResponse.status, 200, await greenTimeOffCheckResponse.clone().text());
    const greenTimeOffCheck = await greenTimeOffCheckResponse.json();
    assert.equal(greenTimeOffCheck.trafficLight, "green", greenTimeOffCheck.reason);

    const timeOffRequestResponse = await fetch(`${url}/api/portal/v1/me/time-off-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ date: "2027-03-08", startTime: "11:00", endTime: "14:00", note: "Privater Termin" }),
    });
    assert.equal(timeOffRequestResponse.status, 201, await timeOffRequestResponse.clone().text());
    const timeOffRequest = await timeOffRequestResponse.json();

    const openAbsencesResponse = await fetch(`${url}/api/portal/v1/absence-requests`, {
      headers: { Cookie: admin.cookie },
    });
    assert.equal(openAbsencesResponse.status, 200, await openAbsencesResponse.clone().text());
    const openAbsences = await openAbsencesResponse.json();
    assert.ok(openAbsences.requests.some((item) => item.kind === "time_off" && item.id === timeOffRequest.id));

    const timeOffDecisionResponse = await fetch(`${url}/api/portal/v1/time-off-requests/${timeOffRequest.id}/decision`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(timeOffDecisionResponse.status, 200, await timeOffDecisionResponse.clone().text());

    const workflowSettings = await fetch(`${url}/api/portal/v1/workflow-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ vacationHrApprovalRequired: true }),
    });
    assert.equal(workflowSettings.status, 200, await workflowSettings.clone().text());

    const twoStageVacationResponse = await fetch(`${url}/api/portal/v1/me/vacation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-05-03", dateTo: "2027-05-07", note: "Zweistufig" }),
    });
    assert.equal(twoStageVacationResponse.status, 201, await twoStageVacationResponse.clone().text());
    const twoStageVacation = await twoStageVacationResponse.json();
    const forbiddenHrFirstApproval = await fetch(`${url}/api/portal/v1/absence-requests/vacation/${twoStageVacation.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(forbiddenHrFirstApproval.status, 403, await forbiddenHrFirstApproval.clone().text());
    const localVacationApproval = await fetch(`${url}/api/portal/v1/absence-requests/vacation/${twoStageVacation.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "approve", note: "Filiale einverstanden" }),
    });
    assert.equal(localVacationApproval.status, 200, await localVacationApproval.clone().text());
    assert.equal((await localVacationApproval.json()).request.status, "pending_hr");
    const hrVacationApproval = await fetch(`${url}/api/portal/v1/absence-requests/vacation/${twoStageVacation.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ action: "approve", note: "PL genehmigt" }),
    });
    assert.equal(hrVacationApproval.status, 200, await hrVacationApproval.clone().text());
    assert.equal((await hrVacationApproval.json()).request.status, "approved");

    const plTimeOffResponse = await fetch(`${url}/api/portal/v1/me/time-off-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ date: "2027-03-10", startTime: "11:00", endTime: "14:00", approvalType: "hr", note: "Verbindlich" }),
    });
    assert.equal(plTimeOffResponse.status, 201, await plTimeOffResponse.clone().text());
    const plTimeOff = await plTimeOffResponse.json();
    const localPlTimeOffApproval = await fetch(`${url}/api/portal/v1/absence-requests/time_off/${plTimeOff.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(localPlTimeOffApproval.status, 200, await localPlTimeOffApproval.clone().text());
    assert.equal((await localPlTimeOffApproval.json()).request.status, "pending_hr");
    const hrPlTimeOffApproval = await fetch(`${url}/api/portal/v1/absence-requests/time_off/${plTimeOff.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(hrPlTimeOffApproval.status, 200, await hrPlTimeOffApproval.clone().text());
    assert.equal((await hrPlTimeOffApproval.json()).request.status, "approved");

    const withdrawnVacationResponse = await fetch(`${url}/api/portal/v1/me/vacation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-06-07", dateTo: "2027-06-11", note: "Wird zurückgezogen" }),
    });
    assert.equal(withdrawnVacationResponse.status, 201, await withdrawnVacationResponse.clone().text());
    const withdrawnVacation = await withdrawnVacationResponse.json();
    const withdrawResponse = await fetch(`${url}/api/portal/v1/me/vacation-requests/${withdrawnVacation.id}`, {
      method: "DELETE", headers: { Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
    });
    assert.equal(withdrawResponse.status, 204, await withdrawResponse.clone().text());
    const historyResponse = await fetch(`${url}/api/portal/v1/me/absence-history`, { headers: { Cookie: employee.cookie } });
    assert.equal(historyResponse.status, 200, await historyResponse.clone().text());
    const history = await historyResponse.json();
    const withdrawnHistory = history.items.find((item) => item.kind === "vacation" && item.id === withdrawnVacation.id);
    assert.equal(withdrawnHistory.status, "withdrawn");
    assert.ok(withdrawnHistory.decisions.some((item) => item.action === "withdraw"));

    const amuForm = new FormData();
    amuForm.append("incapacityFrom", "2027-03-11");
    amuForm.append("incapacityTo", "2027-03-13");
    amuForm.append("employeeNote", "Arbeitsunfähig");
    const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    amuForm.append("documents", new Blob([onePixelPng], { type: "image/png" }), "amu-test.png");
    const amuUploadResponse = await fetch(`${url}/api/portal/v1/me/amu-reports`, {
      method: "POST", headers: { Cookie: employee.cookie, "X-CSRF-Token": employee.csrf }, body: amuForm,
    });
    assert.equal(amuUploadResponse.status, 201, await amuUploadResponse.clone().text());
    const amuUpload = await amuUploadResponse.json();
    assert.equal(amuUpload.report.status, "submitted");
    assert.equal(amuUpload.report.employee_note, "Arbeitsunfähig");
    assert.equal(amuUpload.report.documents.length, 1);
    const amuDocument = amuUpload.report.documents[0];

    const ownAmuContent = await fetch(`${url}/api/portal/v1/me/amu-reports/${amuUpload.report.id}/documents/${amuDocument.id}/content`, { headers: { Cookie: employee.cookie } });
    assert.equal(ownAmuContent.status, 200, await ownAmuContent.clone().text());
    assert.equal(amuDocument.detected_mime, "application/pdf");
    assert.match(amuDocument.original_filename, /\.pdf$/i);
    assert.equal(Buffer.from(await ownAmuContent.arrayBuffer()).subarray(0, 5).toString("ascii"), "%PDF-");

    const amuSettingsResponse = await fetch(`${url}/api/portal/v1/amu-settings`, { headers: { Cookie: admin.cookie } });
    assert.equal(amuSettingsResponse.status, 200, await amuSettingsResponse.clone().text());
    assert.equal((await amuSettingsResponse.json()).policy.convertImagesToPdf, true);
    const updateAmuSettings = await fetch(`${url}/api/portal/v1/amu-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ uploadMaxMb: 8, storedMaxMb: 2, convertImagesToPdf: true, grayscaleImages: true }),
    });
    assert.equal(updateAmuSettings.status, 200, await updateAmuSettings.clone().text());
    const personnelRecord = await fetch(`${url}/api/portal/v1/personnel-records/102`, { headers: { Cookie: admin.cookie } });
    assert.equal(personnelRecord.status, 200, await personnelRecord.clone().text());
    const personnelRecordData = await personnelRecord.json();
    assert.equal(personnelRecordData.canOpenFiles, true);
    assert.ok(personnelRecordData.reports.some((report) => report.id === amuUpload.report.id));
    const adminAmuContent = await fetch(`${url}/api/portal/v1/amu-reports/${amuUpload.report.id}/documents/${amuDocument.id}/content`, { headers: { Cookie: admin.cookie } });
    assert.equal(adminAmuContent.status, 200, await adminAmuContent.clone().text());
    const auditDatabase = new DatabaseSync(childDatabase);
    assert.ok(auditDatabase.prepare("SELECT 1 FROM audit_log WHERE actor = '101' AND action = 'amu.document.download' AND entity_id = ?").get(amuDocument.id));
    auditDatabase.close();

    const adminAmuResponse = await fetch(`${url}/api/portal/v1/amu-reports`, { headers: { Cookie: admin.cookie } });
    assert.equal(adminAmuResponse.status, 200, await adminAmuResponse.clone().text());
    assert.equal((await adminAmuResponse.json()).pendingCount, 1);
    const reviewAmuResponse = await fetch(`${url}/api/portal/v1/amu-reports/${amuUpload.report.id}/review`, {
      method: "PUT", headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "reviewed", note: "Geprüft" }),
    });
    assert.equal(reviewAmuResponse.status, 200, await reviewAmuResponse.clone().text());
    assert.equal((await reviewAmuResponse.json()).report.status, "reviewed");

    const employeeNotificationsResponse = await fetch(`${url}/api/portal/v1/me/notifications`, { headers: { Cookie: employee.cookie } });
    assert.equal(employeeNotificationsResponse.status, 200, await employeeNotificationsResponse.clone().text());
    const employeeNotifications = await employeeNotificationsResponse.json();
    const protectedUpdate = employeeNotifications.notifications.find((item) => item.event_type === "protected.update");
    assert.ok(protectedUpdate);
    assert.equal(protectedUpdate.title, "Geschützte Meldung aktualisiert");
    assert.equal(protectedUpdate.message, "Bitte im geschützten Portal anmelden.");
    assert.doesNotMatch(JSON.stringify(protectedUpdate), /Arbeitsunf|krank|AUM|Geprüft/i);

    const encryptedBlobs = fs.readdirSync(path.join(childRoot, "app-data", "private", "amu", "blobs"), { recursive: true })
      .filter((name) => String(name).endsWith(".amu"));
    assert.equal(encryptedBlobs.length, 1);
    const encryptedContent = fs.readFileSync(path.join(childRoot, "app-data", "private", "amu", "blobs", encryptedBlobs[0]));
    assert.equal(encryptedContent.includes(onePixelPng.subarray(0, 8)), false);

    const exitResponse = await fetch(`${url}/api/system/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: "{}",
    });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, stderr);
    const backupRoot = path.join(childRoot, "backups");
    const latestBackup = fs.readdirSync(backupRoot).filter((name) => /^dienstplan-.*\.db$/.test(name)).sort().at(-1);
    assert.ok(latestBackup);
    const amuSnapshot = path.join(backupRoot, `${path.basename(latestBackup, ".db")}.amu`);
    const amuManifest = JSON.parse(fs.readFileSync(path.join(amuSnapshot, "manifest.json"), "utf8"));
    assert.equal(amuManifest.database.fileName, latestBackup);
    assert.equal(amuManifest.database.sha256, crypto.createHash("sha256").update(fs.readFileSync(path.join(backupRoot, latestBackup))).digest("hex"));

    const verified = new DatabaseSync(childDatabase);
    const storedRequest = verified.prepare("SELECT status, vacation_group_id FROM vacation_requests WHERE id = ?").get(vacationRequest.id);
    assert.equal(storedRequest.status, "approved");
    assert.match(storedRequest.vacation_group_id, /^vac-/);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM week_options WHERE group_id = ? AND option_type = 'vacation'").get(storedRequest.vacation_group_id).count, 1);
    const storedVacation = verified.prepare("SELECT date_from, date_to FROM week_options WHERE group_id = ? AND option_type = 'vacation'").get(storedRequest.vacation_group_id);
    assert.equal(storedVacation.date_from, "2027-02-15");
    assert.equal(storedVacation.date_to, "2027-02-19");
    const storedTimeOff = verified.prepare("SELECT status, option_id FROM time_off_requests WHERE id = ?").get(timeOffRequest.id);
    assert.equal(storedTimeOff.status, "approved");
    assert.ok(storedTimeOff.option_id);
    const storedAmu = verified.prepare("SELECT incapacity_from, incapacity_to, employee_note, review_note, protected_payload FROM amu_reports WHERE id = ?").get(amuUpload.report.id);
    const storedAmuDocument = verified.prepare("SELECT original_filename, detected_mime, byte_size, sha256, uploaded_by, protected_payload FROM amu_documents WHERE report_id = ?").get(amuUpload.report.id);
    assert.equal(storedAmu.incapacity_from, "");
    assert.equal(storedAmu.incapacity_to, "");
    assert.equal(storedAmu.employee_note, "");
    assert.equal(storedAmu.review_note, "");
    assert.match(storedAmu.protected_payload, /^enc:v2:/);
    assert.equal(storedAmuDocument.original_filename, "");
    assert.equal(storedAmuDocument.detected_mime, "application/octet-stream");
    assert.equal(storedAmuDocument.byte_size, 0);
    assert.equal(storedAmuDocument.sha256, "");
    assert.equal(storedAmuDocument.uploaded_by, "");
    assert.match(storedAmuDocument.protected_payload, /^enc:v2:/);
    const storedPlTimeOff = verified.prepare("SELECT status, approval_type, local_approved_by, hr_approved_by FROM time_off_requests WHERE id = ?").get(plTimeOff.id);
    assert.equal(storedPlTimeOff.status, "approved");
    assert.equal(storedPlTimeOff.approval_type, "hr");
    assert.equal(storedPlTimeOff.local_approved_by, "101");
    assert.equal(storedPlTimeOff.hr_approved_by, "103");
    assert.ok(verified.prepare("SELECT COUNT(*) AS count FROM request_decisions WHERE request_kind = 'vacation' AND request_id = ?").get(twoStageVacation.id).count >= 2);
    assert.deepEqual(verified.prepare("SELECT start_time, end_time FROM shifts WHERE employee_number = '102' AND shift_date = '2027-03-08' ORDER BY start_time").all().map((row) => ({ ...row })), [
      { start_time: "09:00", end_time: "11:00" },
      { start_time: "14:00", end_time: "18:00" },
    ]);
    verified.close();
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("LAN-Bereichsrechte trennen Filial- und Abteilungsdaten zuverlässig", async () => {
  const childRoot = path.join(testRoot, "lan-scope-isolation");
  fs.mkdirSync(childRoot, { recursive: true });
  const childDatabase = path.join(childRoot, "dienstplan.db");
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: childDatabase,
      BACKUP_DIR: path.join(childRoot, "backups"),
      GRABENPLANER_DATA_DIR: path.join(childRoot, "app-data"),
      GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_FORCE_PORTAL: "1",
      GRABENPLANER_SEED_DEMO: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;

  function sessionHeaders(response) {
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrfCookie = setCookies.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("grabenplaner_csrf="));
    return { cookie, csrf: decodeURIComponent(csrfCookie.split("=").slice(1).join("=")) };
  }

  async function login(employeeNumber, password) {
    const response = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber, password }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return sessionHeaders(response);
  }

  async function changePassword(session, currentPassword, newPassword) {
    const response = await fetch(`${url}/api/portal/v1/me/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    assert.equal(response.status, 200, await response.clone().text());
  }

  try {
    await waitForJson(`${url}/api/portal/v1/status`, child);
    const setup = await fetch(`${url}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: "987654" }),
    });
    assert.equal(setup.status, 201, await setup.clone().text());
    const admin = await login("101", "987654");

    const initialLocationsResponse = await fetch(`${url}/api/locations`, { headers: { Cookie: admin.cookie } });
    assert.equal(initialLocationsResponse.status, 200, await initialLocationsResponse.clone().text());
    const initialLocations = await initialLocationsResponse.json();
    const daySettings = initialLocations.find((location) => location.id === "01").day_settings;

    const secondLocationResponse = await fetch(`${url}/api/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ id: "02", name: "Zweiter Standort", minStaff: 1, daySettings, active: true }),
    });
    assert.equal(secondLocationResponse.status, 201, await secondLocationResponse.clone().text());

    const firstDepartmentResponse = await fetch(`${url}/api/departments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ locationId: "01", name: "Abteilung Eins", minStaff: 1, active: true }),
    });
    assert.equal(firstDepartmentResponse.status, 201, await firstDepartmentResponse.clone().text());
    const afterFirstDepartment = await firstDepartmentResponse.json();
    const firstDepartment = afterFirstDepartment.find((location) => location.id === "01").departments.find((department) => department.name === "Abteilung Eins");
    const secondDepartmentResponse = await fetch(`${url}/api/departments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ locationId: "01", name: "Abteilung Zwei", minStaff: 1, active: true }),
    });
    assert.equal(secondDepartmentResponse.status, 201, await secondDepartmentResponse.clone().text());
    const afterSecondDepartment = await secondDepartmentResponse.json();
    const secondDepartment = afterSecondDepartment.find((location) => location.id === "01").departments.find((department) => department.name === "Abteilung Zwei");
    assert.ok(firstDepartment?.id);
    assert.ok(secondDepartment?.id);

    for (const [employeeNumber, role, password] of [
      ["102", "employee", "223344"],
      ["103", "hr", "334455"],
      ["104", "manager", "445566"],
      ["105", "department_manager", "556677"],
    ]) {
      const accessResponse = await fetch(`${url}/api/portal/v1/users/${employeeNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
        body: JSON.stringify({ role, active: true, password, mustChangePassword: true }),
      });
      assert.equal(accessResponse.status, 200, await accessResponse.clone().text());
    }
    const fixtureDatabase = new DatabaseSync(childDatabase);
    try {
      fixtureDatabase.prepare(`
        INSERT INTO portal_users
          (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
        VALUES ('106', ?, 'it_admin', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(employee_number) DO UPDATE SET
          password_hash = excluded.password_hash, role = 'it_admin', active = 1,
          must_change_password = 1, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      `).run(await hashPortalPassword("667788"));
    } finally {
      fixtureDatabase.close();
    }

    const managerScopeResponse = await fetch(`${url}/api/portal/v1/users/104/scopes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ scopes: [{ locationId: "01" }] }),
    });
    assert.equal(managerScopeResponse.status, 200, await managerScopeResponse.clone().text());
    const departmentManagerScopeResponse = await fetch(`${url}/api/portal/v1/users/105/scopes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ scopes: [{ locationId: "01", departmentId: firstDepartment.id }] }),
    });
    assert.equal(departmentManagerScopeResponse.status, 200, await departmentManagerScopeResponse.clone().text());

    const manager = await login("104", "445566");
    await changePassword(manager, "445566", "665544");
    const departmentManager = await login("105", "556677");
    await changePassword(departmentManager, "556677", "776655");
    const employee = await login("102", "223344");
    await changePassword(employee, "223344", "554433");
    const hr = await login("103", "334455");
    await changePassword(hr, "334455", "887766");
    const itAdmin = await login("106", "667788");
    await changePassword(itAdmin, "667788", "998877");

    const managerRightsDenied = await fetch(`${url}/api/portal/v1/rights`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerRightsDenied.status, 403, await managerRightsDenied.clone().text());
    const hrRightsResponse = await fetch(`${url}/api/portal/v1/rights`, { headers: { Cookie: hr.cookie } });
    assert.equal(hrRightsResponse.status, 200, await hrRightsResponse.clone().text());
    const rightsPayload = await hrRightsResponse.json();
    assert.ok(rightsPayload.catalog.some((permission) => permission.id === "operation_mode:write" && permission.warningLevel === "critical" && !permission.editable));
    assert.ok(rightsPayload.catalog.some((permission) => permission.id === "employees:display:write" && permission.editable));
    assert.ok(rightsPayload.catalog.some((permission) => permission.id === "employees:write" && !permission.editable));
    assert.ok(rightsPayload.catalog.some((permission) => permission.id === "backup:write" && !permission.editable));
    assert.equal(rightsPayload.catalog.some((permission) => permission.id === "developer:system"), false);
    assert.ok(rightsPayload.users.some((user) => user.employeeNumber === "102" && user.role === "employee" && user.manageable));
    assert.ok(rightsPayload.users.some((user) => user.employeeNumber === "104" && user.role === "manager" && user.manageable));
    const managerRightsProfile = rightsPayload.users.find((user) => user.employeeNumber === "104");
    assert.equal(managerRightsProfile.rolePermissions.includes("amu:metadata:read"), false);
    assert.deepEqual(rightsPayload.catalog.find((permission) => permission.id === "amu:file:read").eligibleRoles,
      ["hr", "admin", "it_admin", "developer"]);
    assert.ok(rightsPayload.users.some((user) => user.employeeNumber === "103" && !user.manageable));
    const itAdminRights = await fetch(`${url}/api/portal/v1/rights`, { headers: { Cookie: itAdmin.cookie } });
    assert.equal(itAdminRights.status, 200, await itAdminRights.clone().text());
    const itAdminRightsPayload = await itAdminRights.json();
    assert.ok(itAdminRightsPayload.catalog.every((permission) => permission.editable));
    assert.ok(itAdminRightsPayload.users.some((user) => user.employeeNumber === "102" && user.manageable));

    const grantEmployeeTechnicalRights = await fetch(`${url}/api/portal/v1/rights/102`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({ permissions: ["schedule:read", "branding:read", "branding:write", "employees:write", "hr:approve", "backup:write", "update:write"] }),
    });
    assert.equal(grantEmployeeTechnicalRights.status, 200, await grantEmployeeTechnicalRights.clone().text());
    const employeeWithTechnicalRights = (await grantEmployeeTechnicalRights.json()).users.find((user) => user.employeeNumber === "102");
    assert.deepEqual(employeeWithTechnicalRights.grantedPermissions, ["backup:write", "branding:read", "branding:write", "employees:write", "hr:approve", "schedule:read", "update:write"]);
    const employeeSessionWithGrants = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: employee.cookie } });
    assert.equal(employeeSessionWithGrants.status, 200, await employeeSessionWithGrants.clone().text());
    const employeeEffectivePermissions = (await employeeSessionWithGrants.json()).user.permissions;
    for (const permission of ["employees:write", "hr:approve", "backup:write", "update:write"]) {
      assert.ok(employeeEffectivePermissions.includes(permission), `${permission} fehlt in ${employeeEffectivePermissions.join(", ")}`);
    }
    const employeeBrandingAccess = await fetch(`${url}/api/branding/assignments`, { headers: { Cookie: employee.cookie, "X-CSRF-Token": employee.csrf } });
    assert.equal(employeeBrandingAccess.status, 200, await employeeBrandingAccess.clone().text());

    const itAdminCanManageHr = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({ role: "employee", active: true }),
    });
    assert.equal(itAdminCanManageHr.status, 200, await itAdminCanManageHr.clone().text());
    assert.equal((await itAdminCanManageHr.json()).users.find((user) => user.employeeNumber === "103").role, "employee");
    const restoreHrByItAdmin = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({ role: "hr", active: true }),
    });
    assert.equal(restoreHrByItAdmin.status, 200, await restoreHrByItAdmin.clone().text());
    const developerRoleCannotBeAssigned = await fetch(`${url}/api/portal/v1/users/106`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "developer", active: true }),
    });
    assert.equal(developerRoleCannotBeAssigned.status, 403, await developerRoleCannotBeAssigned.clone().text());
    assert.equal((await developerRoleCannotBeAssigned.json()).code, "PORTAL_DEVELOPER_PROTECTED");
    const hrCannotTargetItself = await fetch(`${url}/api/portal/v1/rights/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ permissions: [] }),
    });
    assert.equal(hrCannotTargetItself.status, 403, await hrCannotTargetItself.clone().text());

    const invalidGrant = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ permissions: ["branding:write"] }),
    });
    assert.equal(invalidGrant.status, 403, await invalidGrant.clone().text());
    assert.equal((await invalidGrant.json()).code, "PORTAL_PERMISSION_NOT_DELEGABLE");

    const grantManagerRights = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ permissions: ["employees:display:write", "departments:write"] }),
    });
    assert.equal(grantManagerRights.status, 200, await grantManagerRights.clone().text());
    const managerWithHrRights = (await grantManagerRights.json()).users.find((user) => user.employeeNumber === "104");
    assert.deepEqual(managerWithHrRights.grantedPermissions, ["departments:write", "employees:display:write"]);

    const grantManagerTechnicalRights = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({ permissions: ["employees:display:write", "locations:write", "departments:write", "operation_mode:write"] }),
    });
    assert.equal(grantManagerTechnicalRights.status, 200, await grantManagerTechnicalRights.clone().text());
    const grantedManager = (await grantManagerTechnicalRights.json()).users.find((user) => user.employeeNumber === "104");
    assert.deepEqual(grantedManager.grantedPermissions, ["departments:write", "employees:display:write", "locations:write", "operation_mode:write"]);

    const managerSessionWithGrant = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerSessionWithGrant.status, 200, await managerSessionWithGrant.clone().text());
    assert.ok((await managerSessionWithGrant.json()).user.permissions.includes("employees:display:write"));
    const delegatedOperationMode = await fetch(`${url}/api/operation-mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ operationMode: "local" }),
    });
    assert.equal(delegatedOperationMode.status, 200, await delegatedOperationMode.clone().text());
    assert.equal((await delegatedOperationMode.json()).restartRequired, false);

    const scopedEmployeesResponse = await fetch(`${url}/api/employees`, { headers: { Cookie: manager.cookie } });
    assert.equal(scopedEmployeesResponse.status, 200, await scopedEmployeesResponse.clone().text());
    const scopedEmployees = await scopedEmployeesResponse.json();
    const ownEmployee = scopedEmployees.find((employee) => employee.personnel_number === "104");
    const ownEmployeeUpdatePayload = {
      fullName: ownEmployee.full_name,
      nickname: "Dana R",
      color: ownEmployee.color,
      contractedHours: ownEmployee.contracted_hours,
      preferredDayOff: ownEmployee.preferred_day_off || "",
      fixedWorkdays: ownEmployee.fixed_workdays || "",
      positionId: ownEmployee.position_id,
      homeLocationId: ownEmployee.home_location_id,
      preferredDepartmentId: ownEmployee.preferred_department_id || "",
      active: ownEmployee.active,
    };
    const ownEmployeeUpdate = await fetch(`${url}/api/employees/104/display`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ color: "#123abc", fullName: "Manipulationsversuch", contractedHours: 0 }),
    });
    assert.equal(ownEmployeeUpdate.status, 200, await ownEmployeeUpdate.clone().text());
    const afterDisplayUpdate = await fetch(`${url}/api/employees`, { headers: { Cookie: manager.cookie } }).then((response) => response.json());
    const protectedEmployee = afterDisplayUpdate.find((employee) => employee.personnel_number === "104");
    assert.equal(protectedEmployee.color, "#123abc");
    assert.equal(protectedEmployee.full_name, ownEmployee.full_name);
    assert.equal(protectedEmployee.contracted_hours, ownEmployee.contracted_hours);
    const fullEmployeeUpdateDenied = await fetch(`${url}/api/employees/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify(ownEmployeeUpdatePayload),
    });
    assert.equal(fullEmployeeUpdateDenied.status, 403, await fullEmployeeUpdateDenied.clone().text());

    const moveOutsideScope = await fetch(`${url}/api/employees/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ ...ownEmployeeUpdatePayload, homeLocationId: "02", preferredDepartmentId: "" }),
    });
    assert.equal(moveOutsideScope.status, 403, await moveOutsideScope.clone().text());
    const createRemoteEmployee = await fetch(`${url}/api/employees`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        personnelNumber: "107", fullName: "Gina Remote", nickname: "Gina", color: "#225588",
        contractedHours: 20, preferredDayOff: "", fixedWorkdays: "", positionId: "verkaufsmitarbeiter",
        homeLocationId: "02", preferredDepartmentId: "", active: true,
      }),
    });
    assert.equal(createRemoteEmployee.status, 201, await createRemoteEmployee.clone().text());
    const remoteEmployeeUpdate = await fetch(`${url}/api/employees/107`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({
        fullName: "Gina Remote", nickname: "Unzulässig", color: "#225588", contractedHours: 20,
        preferredDayOff: "", fixedWorkdays: "", positionId: "verkaufsmitarbeiter",
        homeLocationId: "02", preferredDepartmentId: "", active: true,
      }),
    });
    assert.equal(remoteEmployeeUpdate.status, 403, await remoteEmployeeUpdate.clone().text());

    const updateOwnLocation = await fetch(`${url}/api/locations/01`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({
        id: "01", name: "Hauptstandort intern", minStaff: initialLocations.find((location) => location.id === "01").min_staff,
        daySettings, timeTrackingEnabled: false, active: true,
      }),
    });
    assert.equal(updateOwnLocation.status, 200, await updateOwnLocation.clone().text());
    const updateRemoteLocation = await fetch(`${url}/api/locations/02`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ id: "02", name: "Unzulässige Änderung", minStaff: 1, daySettings, timeTrackingEnabled: false, active: true }),
    });
    assert.equal(updateRemoteLocation.status, 403, await updateRemoteLocation.clone().text());
    const createDelegatedLocation = await fetch(`${url}/api/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ id: "03", name: "Delegiert angelegt", minStaff: 1, daySettings, timeTrackingEnabled: false, active: true }),
    });
    assert.equal(createDelegatedLocation.status, 201, await createDelegatedLocation.clone().text());
    assert.ok((await createDelegatedLocation.json()).some((location) => location.id === "03"));
    const updateDelegatedLocation = await fetch(`${url}/api/locations/03`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ id: "03", name: "Delegiert gespeichert", minStaff: 2, daySettings, timeTrackingEnabled: false, active: true }),
    });
    assert.equal(updateDelegatedLocation.status, 200, await updateDelegatedLocation.clone().text());

    const remoteDepartmentResponse = await fetch(`${url}/api/departments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ locationId: "02", name: "Remote-Abteilung", minStaff: 1, active: true }),
    });
    assert.equal(remoteDepartmentResponse.status, 201, await remoteDepartmentResponse.clone().text());
    const remoteDepartment = (await remoteDepartmentResponse.json()).find((location) => location.id === "02").departments[0];
    const updateOwnDepartment = await fetch(`${url}/api/departments/${firstDepartment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ locationId: "01", name: "Abteilung Eins intern", minStaff: 1, active: true }),
    });
    assert.equal(updateOwnDepartment.status, 200, await updateOwnDepartment.clone().text());
    const updateRemoteDepartment = await fetch(`${url}/api/departments/${remoteDepartment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ locationId: "02", name: "Remote manipuliert", minStaff: 1, active: true }),
    });
    assert.equal(updateRemoteDepartment.status, 403, await updateRemoteDepartment.clone().text());

    const revokeManagerRights = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ permissions: [] }),
    });
    assert.equal(revokeManagerRights.status, 200, await revokeManagerRights.clone().text());
    const updateAfterRevoke = await fetch(`${url}/api/employees/104/display`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ color: "#654321" }),
    });
    assert.equal(updateAfterRevoke.status, 403, await updateAfterRevoke.clone().text());
    const managerSessionAfterRevoke = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerSessionAfterRevoke.status, 200, await managerSessionAfterRevoke.clone().text());
    const permissionsAfterHrRevoke = (await managerSessionAfterRevoke.json()).user.permissions;
    assert.equal(permissionsAfterHrRevoke.includes("employees:display:write"), false);
    assert.ok(permissionsAfterHrRevoke.includes("locations:write"));
    assert.ok(permissionsAfterHrRevoke.includes("operation_mode:write"));

    const managerBrandingDenied = await fetch(`${url}/api/branding/assignments`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerBrandingDenied.status, 403, await managerBrandingDenied.clone().text());
    const managerSystemInfo = await fetch(`${url}/api/system-info`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerSystemInfo.status, 200, await managerSystemInfo.clone().text());
    const managerSystemInfoData = await managerSystemInfo.json();
    assert.equal(managerSystemInfoData.serverDiagnostics, null);
    assert.equal(managerSystemInfoData.runtimeDrive, null);
    assert.equal(managerSystemInfoData.appBackupDirectory, "");
    const assignFirstBranding = await fetch(`${url}/api/branding/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        locationId: "01", kitId: "custom",
        branding: { companyName: "Filiale Eins", logoUrl: "/assets/one.svg", iconUrl: "/assets/one-icon.svg", logoAlt: "Eins", adminEmail: "eins@example.test" },
      }),
    });
    assert.equal(assignFirstBranding.status, 200, await assignFirstBranding.clone().text());
    const assignSecondBranding = await fetch(`${url}/api/branding/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({
        locationId: "02", kitId: "custom",
        branding: { companyName: "Filiale Zwei", logoUrl: "/assets/two.svg", iconUrl: "/assets/two-icon.svg", logoAlt: "Zwei", adminEmail: "zwei@example.test" },
      }),
    });
    assert.equal(assignSecondBranding.status, 200, await assignSecondBranding.clone().text());
    const brandingAssignmentsResponse = await fetch(`${url}/api/branding/assignments`, { headers: { Cookie: hr.cookie } });
    assert.equal(brandingAssignmentsResponse.status, 200, await brandingAssignmentsResponse.clone().text());
    const brandingAssignments = (await brandingAssignmentsResponse.json()).assignments;
    assert.equal(brandingAssignments.find((assignment) => assignment.locationId === "01").branding.companyName, "Filiale Eins");
    assert.equal(brandingAssignments.find((assignment) => assignment.locationId === "02").branding.companyName, "Filiale Zwei");
    const firstBrandSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=01`, { headers: { Cookie: admin.cookie } });
    const secondBrandSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=02`, { headers: { Cookie: admin.cookie } });
    assert.equal(firstBrandSchedule.status, 200, await firstBrandSchedule.clone().text());
    assert.equal(secondBrandSchedule.status, 200, await secondBrandSchedule.clone().text());
    assert.equal((await firstBrandSchedule.json()).settings.branding_company_name, "Filiale Eins");
    assert.equal((await secondBrandSchedule.json()).settings.branding_company_name, "Filiale Zwei");
    const brandedManagerSession = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: manager.cookie } });
    assert.equal(brandedManagerSession.status, 200, await brandedManagerSession.clone().text());
    assert.equal((await brandedManagerSession.json()).status.branding.companyName, "Filiale Eins");

    const managementPreferenceResponse = await fetch(`${url}/api/branding/preference`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({
        kitId: "custom",
        branding: { companyName: "Zentrale Leitung", logoUrl: "/assets/central.svg", iconUrl: "/assets/central-icon.svg", logoAlt: "Zentrale", adminEmail: "leitung@example.test" },
      }),
    });
    assert.equal(managementPreferenceResponse.status, 200, await managementPreferenceResponse.clone().text());
    assert.equal((await managementPreferenceResponse.json()).branding.companyName, "Zentrale Leitung");
    const hrBrandedSession = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: hr.cookie } });
    assert.equal(hrBrandedSession.status, 200, await hrBrandedSession.clone().text());
    assert.equal((await hrBrandedSession.json()).status.branding.companyName, "Zentrale Leitung");
    const managerSessionAfterPreference = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerSessionAfterPreference.status, 200, await managerSessionAfterPreference.clone().text());
    assert.equal((await managerSessionAfterPreference.json()).status.branding.companyName, "Filiale Eins");
    const unassignedLocationSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=03`, { headers: { Cookie: admin.cookie } });
    assert.equal(unassignedLocationSchedule.status, 200, await unassignedLocationSchedule.clone().text());
    assert.equal((await unassignedLocationSchedule.json()).settings.branding_company_name, "");

    for (const [employeeNumber, expectedCompany] of [["104", "Filiale Eins"], ["103", "Zentrale Leitung"], ["999999", "Zentrale Leitung"]]) {
      const loginBranding = await fetch(`${url}/api/portal/v1/auth/branding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeNumber }),
      });
      assert.equal(loginBranding.status, 200, await loginBranding.clone().text());
      assert.equal((await loginBranding.json()).branding.companyName, expectedCompany);
    }

    const disposableKitImport = await fetch(`${url}/api/branding/import`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf, "X-Branding-Filename": "disposable.json" },
      body: JSON.stringify({
        locationId: "02",
        kit: {
          name: "Loeschbares Test-Branding",
          branding: { companyName: "Test Kit", logoUrl: "/assets/test.svg", iconUrl: "/assets/test-icon.svg", logoAlt: "Test", adminEmail: "test@example.test" },
        },
      }),
    });
    assert.equal(disposableKitImport.status, 200, await disposableKitImport.clone().text());
    const disposableKit = (await disposableKitImport.json()).kit;
    assert.ok(disposableKit.id);
    const selectDisposablePreference = await fetch(`${url}/api/branding/preference`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ kitId: disposableKit.id }),
    });
    assert.equal(selectDisposablePreference.status, 200, await selectDisposablePreference.clone().text());
    const deleteUsedKit = await fetch(`${url}/api/branding/kits/${encodeURIComponent(disposableKit.id)}`, {
      method: "DELETE",
      headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
    });
    assert.equal(deleteUsedKit.status, 409, await deleteUsedKit.clone().text());
    assert.equal((await deleteUsedKit.json()).code, "BRANDING_KIT_IN_USE");

    const batchAssignments = await fetch(`${url}/api/branding/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ assignments: [
        { locationId: "01", kitId: "custom", branding: { companyName: "Stapel Eins", logoUrl: "/assets/batch-one.svg", iconUrl: "/assets/batch-one-icon.svg", logoAlt: "Eins", adminEmail: "eins@example.test" } },
        { locationId: "02", kitId: "custom", branding: { companyName: "Stapel Zwei", logoUrl: "/assets/batch-two.svg", iconUrl: "/assets/batch-two-icon.svg", logoAlt: "Zwei", adminEmail: "zwei@example.test" } },
      ] }),
    });
    assert.equal(batchAssignments.status, 200, await batchAssignments.clone().text());
    const batchAssignmentData = await batchAssignments.json();
    assert.equal(batchAssignmentData.assignments.find((assignment) => assignment.locationId === "01").branding.companyName, "Stapel Eins");
    assert.equal(batchAssignmentData.assignments.find((assignment) => assignment.locationId === "02").branding.companyName, "Stapel Zwei");
    const restoreManagementPreference = await fetch(`${url}/api/branding/preference`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        kitId: "custom",
        branding: { companyName: "Zentrale Leitung", logoUrl: "/assets/central.svg", iconUrl: "/assets/central-icon.svg", logoAlt: "Zentrale", adminEmail: "leitung@example.test" },
      }),
    });
    assert.equal(restoreManagementPreference.status, 200, await restoreManagementPreference.clone().text());
    const deleteUnusedKit = await fetch(`${url}/api/branding/kits/${encodeURIComponent(disposableKit.id)}`, {
      method: "DELETE",
      headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
    });
    assert.equal(deleteUnusedKit.status, 200, await deleteUnusedKit.clone().text());
    assert.equal((await deleteUnusedKit.json()).deleted.id, disposableKit.id);

    const resetFirstBranding = await fetch(`${url}/api/branding/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ locationId: "01", kitId: "" }),
    });
    assert.equal(resetFirstBranding.status, 200, await resetFirstBranding.clone().text());
    const resetFirstBrandingData = await resetFirstBranding.json();
    const resetFirstAssignment = resetFirstBrandingData.assignments.find((assignment) => assignment.locationId === "01");
    assert.equal(resetFirstAssignment.assigned, false);
    assert.notEqual(resetFirstAssignment.branding.companyName, "Filiale Eins");

    const scopedAmuDatabase = new DatabaseSync(childDatabase);
    scopedAmuDatabase.exec("PRAGMA busy_timeout = 5000");
    scopedAmuDatabase.prepare("UPDATE employees SET preferred_department_id = ? WHERE personnel_number = '104'").run(firstDepartment.id);
    const scopedAmuStorage = createAmuStorage({
      rootDirectory: path.join(childRoot, "app-data", "private", "amu"),
      encryptionKeys: { "local-v1": fs.readFileSync(path.join(childRoot, "app-data", "private", "amu-local.key"), "utf8").trim() },
      activeKeyId: "local-v1",
      scanner: async () => true,
    });
    const insertScopedAmu = scopedAmuDatabase.prepare(`
      INSERT INTO amu_reports
        (employee_number, location_id, department_id, incapacity_from, incapacity_to, employee_note, review_note, status, protected_payload)
      VALUES (?, ?, ?, '', '', '', '', 'submitted', '')
    `);
    const updateScopedAmu = scopedAmuDatabase.prepare("UPDATE amu_reports SET protected_payload = ? WHERE id = ?");
    function insertProtectedScopedAmu(locationId, from, to) {
      const id = Number(insertScopedAmu.run("104", locationId, null).lastInsertRowid);
      const protectedPayload = scopedAmuStorage.protectRecord(JSON.stringify({
        incapacityFrom: from, incapacityTo: to, employeeNote: "Interne Notiz", reviewedBy: "101",
        reviewedAt: "2027-06-30T10:00:00.000Z", reviewNote: "Leitungsnotiz", retentionUntil: "2029-07-04", withdrawnAt: "",
      }), { namespace: "personnel-record", recordId: String(id), field: "payload", employeeNumber: "104" });
      updateScopedAmu.run(protectedPayload, id);
      return id;
    }
    const localAmuId = insertProtectedScopedAmu("01", "2027-07-01", "2027-07-02");
    const remoteAmuId = insertProtectedScopedAmu("02", "2027-07-03", "2027-07-04");
    scopedAmuDatabase.close();

    const managerPersonnelRecord = await fetch(`${url}/api/portal/v1/personnel-records/104`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerPersonnelRecord.status, 200, await managerPersonnelRecord.clone().text());
    const managerPersonnelPayload = await managerPersonnelRecord.json();
    assert.equal(managerPersonnelPayload.profile.phone, "");
    assert.equal(managerPersonnelPayload.profile.sensitive, null);
    assert.deepEqual(managerPersonnelPayload.reports, []);
    assert.equal(managerPersonnelPayload.access.canReadPhone, true);
    assert.equal(managerPersonnelPayload.access.canReadAmu, false);

    const managerAmuOverview = await fetch(`${url}/api/portal/v1/amu-reports`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerAmuOverview.status, 403, await managerAmuOverview.clone().text());

    const departmentManagerLegacyAmu = await fetch(`${url}/api/portal/v1/amu-reports`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(departmentManagerLegacyAmu.status, 403, await departmentManagerLegacyAmu.clone().text());
    const departmentManagerLegacyRecord = await fetch(`${url}/api/portal/v1/personnel-records/104`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(departmentManagerLegacyRecord.status, 403, await departmentManagerLegacyRecord.clone().text());

    const obsoleteManagerAmuSetting = await fetch(`${url}/api/portal/v1/amu-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ uploadMaxMb: 10, storedMaxMb: 2, convertImagesToPdf: true, grayscaleImages: true, managerFileAccess: true }),
    });
    assert.equal(obsoleteManagerAmuSetting.status, 200, await obsoleteManagerAmuSetting.clone().text());
    assert.equal(Object.hasOwn((await obsoleteManagerAmuSetting.json()).policy, "managerFileAccess"), false);
    const managerAmuStillDenied = await fetch(`${url}/api/portal/v1/amu-reports`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerAmuStillDenied.status, 403, await managerAmuStillDenied.clone().text());

    const protectedRightCannotBeDelegated = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ permissions: ["amu:file:read"] }),
    });
    assert.equal(protectedRightCannotBeDelegated.status, 403, await protectedRightCannotBeDelegated.clone().text());
    assert.equal((await protectedRightCannotBeDelegated.json()).code, "AMU_PERMISSION_ROLE_RESTRICTED");

    const remoteBlackoutResponse = await fetch(`${url}/api/portal/v1/request-blackouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        locationId: "02", dateFrom: "2027-12-01", dateTo: "2027-12-24",
        blockVacation: true, blockTimeOff: true, reason: "Nur Standort Zwei", active: true,
      }),
    });
    assert.equal(remoteBlackoutResponse.status, 201, await remoteBlackoutResponse.clone().text());
    const remoteBlackout = (await remoteBlackoutResponse.json()).blackouts.find((item) => item.reason === "Nur Standort Zwei");
    assert.ok(remoteBlackout?.id);

    const managerRemoteSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=02`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerRemoteSchedule.status, 403, await managerRemoteSchedule.clone().text());
    const managerRemoteScheduleDelete = await fetch(`${url}/api/schedule?week=2027-08-02&location=02`, {
      method: "DELETE", headers: { Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
    });
    assert.equal(managerRemoteScheduleDelete.status, 403, await managerRemoteScheduleDelete.clone().text());

    const managerBlackoutsResponse = await fetch(`${url}/api/portal/v1/request-blackouts`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerBlackoutsResponse.status, 200, await managerBlackoutsResponse.clone().text());
    assert.equal((await managerBlackoutsResponse.json()).blackouts.some((item) => item.locationId === "02"), false);
    const managerRemoteBlackoutCreate = await fetch(`${url}/api/portal/v1/request-blackouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ locationId: "02", dateFrom: "2028-01-02", dateTo: "2028-01-03", blockVacation: true, reason: "Verbotener Eintrag" }),
    });
    assert.equal(managerRemoteBlackoutCreate.status, 403, await managerRemoteBlackoutCreate.clone().text());
    const managerRemoteBlackoutUpdate = await fetch(`${url}/api/portal/v1/request-blackouts/${remoteBlackout.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ locationId: "02", dateFrom: "2027-12-01", dateTo: "2027-12-24", blockVacation: true, blockTimeOff: true, reason: "Manipuliert" }),
    });
    assert.equal(managerRemoteBlackoutUpdate.status, 403, await managerRemoteBlackoutUpdate.clone().text());
    const managerRemoteBlackoutDelete = await fetch(`${url}/api/portal/v1/request-blackouts/${remoteBlackout.id}`, {
      method: "DELETE", headers: { Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
    });
    assert.equal(managerRemoteBlackoutDelete.status, 403, await managerRemoteBlackoutDelete.clone().text());

    const departmentSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=01&department=${firstDepartment.id}`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(departmentSchedule.status, 200, await departmentSchedule.clone().text());
    const broadDepartmentSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=01`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(broadDepartmentSchedule.status, 403, await broadDepartmentSchedule.clone().text());
    const otherDepartmentSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=01&department=${secondDepartment.id}`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(otherDepartmentSchedule.status, 403, await otherDepartmentSchedule.clone().text());

    const departmentVacations = await fetch(`${url}/api/vacations?year=2027&location=01&department=${firstDepartment.id}`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(departmentVacations.status, 200, await departmentVacations.clone().text());
    const broadDepartmentVacations = await fetch(`${url}/api/vacations?year=2027&location=01`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(broadDepartmentVacations.status, 403, await broadDepartmentVacations.clone().text());
    const otherDepartmentVacations = await fetch(`${url}/api/vacations?year=2027&location=01&department=${secondDepartment.id}`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(otherDepartmentVacations.status, 403, await otherDepartmentVacations.clone().text());

    const remoteBlackoutStillExists = await fetch(`${url}/api/portal/v1/request-blackouts`, { headers: { Cookie: admin.cookie } });
    assert.equal(remoteBlackoutStillExists.status, 200, await remoteBlackoutStillExists.clone().text());
    assert.ok((await remoteBlackoutStillExists.json()).blackouts.some((item) => item.id === remoteBlackout.id && item.reason === "Nur Standort Zwei"));

    const exitResponse = await fetch(`${url}/api/system/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: "{}",
    });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    assert.equal((await waitForExit(child)).code, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("HTTPS-Serverfundament erzwingt Proxy-Sicherheit und verhindert eine zweite Instanz", async () => {
  const childRoot = path.join(testRoot, "server-foundation");
  fs.mkdirSync(childRoot, { recursive: true });
  const childDatabase = path.join(childRoot, "dienstplan.db");
  const initPort = await getFreePort();
  const initChild = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."), windowsHide: true,
    env: { ...process.env, PORT: String(initPort), DB_PATH: childDatabase, BACKUP_DIR: path.join(childRoot, "backups"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_SEED_DEMO: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let initError = "";
  initChild.stderr.on("data", (chunk) => { initError += chunk.toString(); });
  try {
    await waitForJson(`http://127.0.0.1:${initPort}/api/health`, initChild);
    const exitResponse = await fetch(`http://127.0.0.1:${initPort}/api/system/exit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    assert.equal((await waitForExit(initChild)).code, 0, initError);
  } finally {
    if (initChild.exitCode === null) initChild.kill();
  }

  const adminPassword = "SicheresServerPasswort!";
  const prepared = new DatabaseSync(childDatabase);
  prepared.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at)
    VALUES ('101', ?, 'admin', 1, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', active = 1, must_change_password = 0
  `).run(await hashPortalPassword(adminPassword));
  prepared.close();

  const port = await getFreePort();
  const publicAddress = "https://plan.example.test";
  const serviceControlToken = "test-service-control-token-0123456789abcdef";
  const serverEnvironment = {
    ...process.env,
    PORT: String(port),
    DB_PATH: childDatabase,
    BACKUP_DIR: path.join(childRoot, "backups"),
    GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_PUBLIC_URL: publicAddress,
    GRABENPLANER_TRUST_PROXY: "loopback",
    GRABENPLANER_DATA_DIR: path.join(childRoot, "server-data"),
    GRABENPLANER_AMU_KEY_ID: "test-v1",
    GRABENPLANER_AMU_KEY: Buffer.alloc(32, 7).toString("base64"),
    NODE_ENV: "test",
    GRABENPLANER_TEST_AMU_SCANNER: "clean",
    GRABENPLANER_SERVICE_CONTROL_TOKEN: serviceControlToken,
  };
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."), windowsHide: true, env: serverEnvironment, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForJson(`${url}/api/health`, child);
    assert.deepEqual(health, { ok: true });
    const livenessResponse = await fetch(`${url}/api/health/live`);
    assert.equal(livenessResponse.status, 200);
    assert.equal(livenessResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await livenessResponse.json(), { ok: true });
    const readinessResponse = await fetch(`${url}/api/health/ready`);
    assert.equal(readinessResponse.status, 200);
    assert.deepEqual(await readinessResponse.json(), { ok: true });

    const insecureStatus = await fetch(`${url}/api/portal/v1/status`);
    assert.equal(insecureStatus.status, 426);

    const secureHeaders = { "X-Forwarded-Proto": "https", Origin: publicAddress };
    const statusResponse = await fetch(`${url}/api/portal/v1/status`, { headers: secureHeaders });
    assert.equal(statusResponse.status, 200, await statusResponse.clone().text());
    assert.match(statusResponse.headers.get("strict-transport-security") || "", /max-age=31536000/);
    assert.equal(statusResponse.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(statusResponse.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(statusResponse.headers.get("x-permitted-cross-domain-policies"), "none");
    assert.match(statusResponse.headers.get("content-security-policy") || "", /form-action 'self'/);
    assert.match(statusResponse.headers.get("x-request-id") || "", /^[a-f0-9-]{36}$/i);
    assert.equal(statusResponse.headers.get("cache-control"), "no-store");
    const status = await statusResponse.json();
    assert.equal(status.operationMode, "server");
    assert.equal(status.httpsRequired, true);
    assert.equal(status.publicUrl, publicAddress);
    assert.equal(status.passwordMinLength, 10);
    assert.equal(status.usbProvisioning.hostCapable, true);
    assert.equal(status.usbProvisioning.available, false);
    assert.equal(status.usbProvisioning.reasonCode, "USB_HOST_CONSOLE_REQUIRED");

    const hostSecureHeaders = { ...secureHeaders, "X-Forwarded-For": "127.0.0.1" };
    const hostStatusResponse = await fetch(`${url}/api/portal/v1/status`, { headers: hostSecureHeaders });
    assert.equal(hostStatusResponse.status, 200, await hostStatusResponse.clone().text());
    assert.equal((await hostStatusResponse.json()).usbProvisioning.available, true);
    const remoteStatusResponse = await fetch(`${url}/api/portal/v1/status`, {
      headers: { ...secureHeaders, "X-Forwarded-For": "203.0.113.44" },
    });
    assert.equal(remoteStatusResponse.status, 200, await remoteStatusResponse.clone().text());
    assert.equal((await remoteStatusResponse.json()).usbProvisioning.available, false);

    const loginResponse = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { ...secureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: adminPassword }),
    });
    assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
    const setCookies = typeof loginResponse.headers.getSetCookie === "function" ? loginResponse.headers.getSetCookie() : [loginResponse.headers.get("set-cookie")].filter(Boolean);
    assert.ok(setCookies.every((cookie) => /; Secure/i.test(cookie)));
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrfCookie = setCookies.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("grabenplaner_csrf="));
    const csrf = decodeURIComponent(csrfCookie.split("=").slice(1).join("="));

    const usbStatusWithoutActionHeader = await fetch(`${url}/api/usb-provisioning/status`, {
      headers: { ...hostSecureHeaders, Cookie: cookie },
    });
    assert.equal(usbStatusWithoutActionHeader.status, 403, await usbStatusWithoutActionHeader.clone().text());
    assert.equal((await usbStatusWithoutActionHeader.json()).code, "USB_ACTION_HEADER_REQUIRED");
    const usbStatusCrossSite = await fetch(`${url}/api/usb-provisioning/status`, {
      headers: {
        ...hostSecureHeaders,
        Cookie: cookie,
        "Sec-Fetch-Site": "cross-site",
        "X-Grabenplaner-USB-Action": "provisioning",
      },
    });
    assert.equal(usbStatusCrossSite.status, 403, await usbStatusCrossSite.clone().text());
    assert.equal((await usbStatusCrossSite.json()).code, "USB_ORIGIN_REQUIRED");

    const usbGuideResponse = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
      method: "POST",
      headers: {
        ...hostSecureHeaders,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "X-Grabenplaner-USB-Action": "provisioning",
      },
      body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
    });
    assert.equal(usbGuideResponse.status, 200, await usbGuideResponse.clone().text());
    assert.equal(usbGuideResponse.headers.get("content-type"), "application/pdf");
    assert.ok((await usbGuideResponse.arrayBuffer()).byteLength > 1000);

    const usbGuideWithoutActionHeader = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
      method: "POST",
      headers: { ...hostSecureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
    });
    assert.equal(usbGuideWithoutActionHeader.status, 403, await usbGuideWithoutActionHeader.clone().text());
    assert.equal((await usbGuideWithoutActionHeader.json()).code, "USB_ACTION_HEADER_REQUIRED");

    const usbGuideWithoutCsrf = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
      method: "POST",
      headers: {
        ...hostSecureHeaders,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Grabenplaner-USB-Action": "provisioning",
      },
      body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
    });
    assert.equal(usbGuideWithoutCsrf.status, 403, await usbGuideWithoutCsrf.clone().text());
    assert.equal((await usbGuideWithoutCsrf.json()).code, "PORTAL_CSRF_INVALID");

    const usbGuideWithoutOrigin = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
      method: "POST",
      headers: {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "127.0.0.1",
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "X-Grabenplaner-USB-Action": "provisioning",
      },
      body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
    });
    assert.equal(usbGuideWithoutOrigin.status, 403, await usbGuideWithoutOrigin.clone().text());
    assert.equal((await usbGuideWithoutOrigin.json()).code, "USB_ORIGIN_REQUIRED");

    const usbGuideCrossSite = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
      method: "POST",
      headers: {
        ...hostSecureHeaders,
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "X-Grabenplaner-USB-Action": "provisioning",
      },
      body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
    });
    assert.equal(usbGuideCrossSite.status, 403, await usbGuideCrossSite.clone().text());
    assert.equal((await usbGuideCrossSite.json()).code, "USB_ORIGIN_REQUIRED");

    const remoteUsbGuideResponse = await fetch(`${url}/api/usb-provisioning/first-steps.pdf`, {
      method: "POST",
      headers: {
        ...secureHeaders,
        "X-Forwarded-For": "203.0.113.44",
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "X-Grabenplaner-USB-Action": "provisioning",
      },
      body: JSON.stringify({ profile: "planning-vacation", primaryBrandingKitId: "neutral" }),
    });
    assert.equal(remoteUsbGuideResponse.status, 403, await remoteUsbGuideResponse.clone().text());
    assert.equal((await remoteUsbGuideResponse.json()).code, "USB_HOST_CONSOLE_REQUIRED");

    const diagnosticsResponse = await fetch(`${url}/api/server-diagnostics`, { headers: { ...secureHeaders, Cookie: cookie } });
    assert.equal(diagnosticsResponse.status, 200, await diagnosticsResponse.clone().text());
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.ready, true);
    assert.equal(diagnostics.database.journalMode, "wal");
    assert.equal(diagnostics.database.busyTimeoutMs, 5000);
    assert.equal(diagnostics.instanceLock.held, true);
    assert.ok(diagnostics.productionChecks.every((check) => check.ok), JSON.stringify(diagnostics.productionChecks));
    assert.equal(diagnostics.backups.retentionCount, 30);

    const shortPasswordResponse = await fetch(`${url}/api/portal/v1/users/102`, {
      method: "PUT", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ role: "employee", active: true, password: "123456" }),
    });
    assert.equal(shortPasswordResponse.status, 400);
    const employeePassword = "MitarbeiterPasswort!";
    const employeeAccessResponse = await fetch(`${url}/api/portal/v1/users/102`, {
      method: "PUT", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ role: "employee", active: true, password: employeePassword, mustChangePassword: false }),
    });
    assert.equal(employeeAccessResponse.status, 200, await employeeAccessResponse.clone().text());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
        method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ employeeNumber: "102", password: "falsch-falsch" }),
      });
      assert.equal(failedLogin.status, 401);
    }
    const lockedLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "102", password: employeePassword }),
    });
    assert.equal(lockedLogin.status, 429);
    const unlockResponse = await fetch(`${url}/api/portal/v1/users/102/unlock`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}",
    });
    assert.equal(unlockResponse.status, 200, await unlockResponse.clone().text());
    const unlockedLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "102", password: employeePassword }),
    });
    assert.equal(unlockedLogin.status, 200, await unlockedLogin.clone().text());
    const employeeCookies = typeof unlockedLogin.headers.getSetCookie === "function" ? unlockedLogin.headers.getSetCookie() : [unlockedLogin.headers.get("set-cookie")].filter(Boolean);
    const employeeCookie = employeeCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const employeeCsrfCookie = employeeCookies.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("grabenplaner_csrf="));
    const employeeCsrf = decodeURIComponent(employeeCsrfCookie.split("=").slice(1).join("="));
    const deniedEmployeeUsbStatus = await fetch(`${url}/api/usb-provisioning/status`, {
      headers: { ...hostSecureHeaders, Cookie: employeeCookie },
    });
    assert.equal(deniedEmployeeUsbStatus.status, 403, await deniedEmployeeUsbStatus.clone().text());
    assert.equal((await deniedEmployeeUsbStatus.json()).code, "PORTAL_PERMISSION_DENIED");
    const employeePasswordChange = await fetch(`${url}/api/portal/v1/me/password`, {
      method: "PUT", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: employeeCookie, "X-CSRF-Token": employeeCsrf },
      body: JSON.stringify({ currentPassword: employeePassword, newPassword: "MitarbeiterPasswortNeu!" }),
    });
    assert.equal(employeePasswordChange.status, 200, await employeePasswordChange.clone().text());
    const deniedEmployeeExit = await fetch(`${url}/api/system/exit`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: employeeCookie, "X-CSRF-Token": employeeCsrf }, body: "{}",
    });
    assert.equal(deniedEmployeeExit.status, 403, await deniedEmployeeExit.clone().text());
    const employeeLogout = await fetch(`${url}/api/portal/v1/auth/logout`, {
      method: "POST", headers: { ...secureHeaders, Cookie: employeeCookie, "X-CSRF-Token": employeeCsrf },
    });
    assert.equal(employeeLogout.status, 200, await employeeLogout.clone().text());
    assert.equal(employeeLogout.headers.get("clear-site-data"), '"cache", "cookies", "storage"');

    const secondPort = await getFreePort();
    const second = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      cwd: path.join(__dirname, ".."), windowsHide: true, env: { ...serverEnvironment, PORT: String(secondPort) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let secondError = "";
    second.stderr.on("data", (chunk) => { secondError += chunk.toString(); });
    const secondExit = await waitForExit(second);
    assert.notEqual(secondExit.code, 0);
    assert.match(secondError, /zweite Serverinstanz|bereits in Prozess/i);

    const foreignOriginResponse = await fetch(`${url}/api/portal/v1/auth/logout`, {
      method: "POST", headers: { "X-Forwarded-Proto": "https", Origin: "https://evil.example", "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}",
    });
    assert.equal(foreignOriginResponse.status, 403);

    const exitResponse = await fetch(`${url}/api/system/exit`, {
      method: "POST", headers: { ...secureHeaders, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: "{}",
    });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    assert.equal((await exitResponse.json()).ok, true);
    assert.equal((await waitForExit(child)).code, 0, stderr);
    assert.equal(fs.existsSync(`${path.resolve(childDatabase)}.server.lock`), false);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
