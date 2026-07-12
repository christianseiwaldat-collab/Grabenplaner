const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

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
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("alte Datenbank wird um das Portal-Fundament erweitert", () => {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  assert.ok(tables.has("portal_sessions"));
  assert.ok(tables.has("vacation_requests"));
  assert.ok(tables.has("time_off_requests"));
  assert.ok(tables.has("vacation_change_requests"));
  assert.ok(tables.has("request_blackouts"));
  assert.ok(tables.has("request_decisions"));
  assert.ok(tables.has("approval_delegations"));
  assert.ok(tables.has("time_entries"));
  assert.ok(tables.has("time_corrections"));
  assert.ok(tables.has("audit_log"));
  assert.ok(tables.has("schema_migrations"));
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.49-server-foundation'").get());

  const userColumns = new Set(db.prepare("PRAGMA table_info(portal_users)").all().map((column) => column.name));
  assert.ok(userColumns.has("password_changed_at"));
  assert.ok(userColumns.has("failed_login_attempts"));
  assert.ok(userColumns.has("locked_until"));

  const roleColumns = new Set(db.prepare("PRAGMA table_info(portal_roles)").all().map((column) => column.name));
  assert.ok(roleColumns.has("description"));
  assert.ok(roleColumns.has("sort_order"));
  assert.ok(roleColumns.has("updated_at"));
});

test("Built-in-Rollen werden aktualisiert und eigene Rollen bleiben erhalten", () => {
  const roles = getPortalRoles();
  const employee = roles.find((role) => role.id === "employee");
  const custom = roles.find((role) => role.id === "custom-auditor");
  assert.equal(employee.name, "Mitarbeiter");
  assert.ok(employee.permissions.includes("own_schedule:read"));
  assert.ok(employee.permissions.includes("own_vacation:request"));
  assert.ok(roles.some((role) => role.id === "hr" && role.name === "Personalleitung" && role.permissions.includes("hr:approve")));
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
      GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_FORCE_PORTAL: "1",
      GRABENPLANER_SEED_DEMO: "1",
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

    const exitResponse = await fetch(`${url}/api/system/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: "{}",
    });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, stderr);

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
  const serverEnvironment = {
    ...process.env,
    PORT: String(port),
    DB_PATH: childDatabase,
    BACKUP_DIR: path.join(childRoot, "backups"),
    GRABENPLANER_HOST: "127.0.0.1",
    GRABENPLANER_OPERATION_MODE: "server",
    GRABENPLANER_PUBLIC_URL: publicAddress,
    GRABENPLANER_TRUST_PROXY: "loopback",
  };
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."), windowsHide: true, env: serverEnvironment, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForJson(`${url}/api/health`, child);
    assert.equal(health.ok, true);
    assert.equal(health.mode, "server");

    const insecureStatus = await fetch(`${url}/api/portal/v1/status`);
    assert.equal(insecureStatus.status, 426);

    const secureHeaders = { "X-Forwarded-Proto": "https", Origin: publicAddress };
    const statusResponse = await fetch(`${url}/api/portal/v1/status`, { headers: secureHeaders });
    assert.equal(statusResponse.status, 200, await statusResponse.clone().text());
    assert.match(statusResponse.headers.get("strict-transport-security") || "", /max-age=31536000/);
    const status = await statusResponse.json();
    assert.equal(status.operationMode, "server");
    assert.equal(status.httpsRequired, true);
    assert.equal(status.publicUrl, publicAddress);
    assert.equal(status.passwordMinLength, 10);

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

    const diagnosticsResponse = await fetch(`${url}/api/server-diagnostics`, { headers: { ...secureHeaders, Cookie: cookie } });
    assert.equal(diagnosticsResponse.status, 200, await diagnosticsResponse.clone().text());
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.ready, true);
    assert.equal(diagnostics.database.journalMode, "wal");
    assert.equal(diagnostics.database.busyTimeoutMs, 5000);
    assert.equal(diagnostics.instanceLock.held, true);

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
    assert.equal((await waitForExit(child)).code, 0, stderr);
    assert.equal(fs.existsSync(`${path.resolve(childDatabase)}.server.lock`), false);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
