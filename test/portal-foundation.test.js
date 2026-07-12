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
  assert.ok(tables.has("time_entries"));
  assert.ok(tables.has("time_corrections"));
  assert.ok(tables.has("audit_log"));

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
  assert.equal(custom.name, "Eigene Prüferrolle");
  assert.deepEqual(custom.permissions, ["audit:read"]);
});

test("Status meldet sicheren Lokalbetrieb ohne Loginpflicht", async () => {
  const directStatus = getPortalStatus();
  assert.equal(directStatus.operationMode, "local");
  assert.equal(directStatus.serverModeStatus, "prepared");
  assert.equal(directStatus.portalEnabled, false);
  assert.equal(directStatus.loginRequired, false);
  assert.equal(directStatus.localOnly, true);

  const response = await fetch(`${baseUrl}/api/portal/v1/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.apiVersion, 1);
  assert.equal(status.operationMode, "local");
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

test("Servermodus kann in v0.45 nicht versehentlich aktiviert werden", async () => {
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationMode: "server" }),
  });
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.code, "SERVER_MODE_NOT_READY");
  assert.equal(getPortalStatus().operationMode, "local");
});

test("bestehende lokale Dienstplan-API bleibt erreichbar", async () => {
  const response = await fetch(`${baseUrl}/api/schedule?week=2026-07-13`);
  assert.equal(response.status, 200);
  const schedule = await response.json();
  assert.equal(schedule.weekStart, "2026-07-13");
  assert.equal(schedule.settings.operation_mode, "local");
  assert.equal(schedule.settings.server_mode_status, "prepared");
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
  assert.match(blockedError, /externe Netzwerkbindung/i);
});
