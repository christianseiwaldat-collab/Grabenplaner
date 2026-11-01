"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0862-db-download-"));
const databasePath = path.join(testRoot, "data", "dienstplan.db");
const publicOrigin = "https://plan.example.test";
const currentPassword = "Sicheres-Download-Passwort-2026!";

process.env.DB_PATH = databasePath;
process.env.GRABENPLANER_DATA_DIR = testRoot;
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_OPERATION_MODE = "server";
process.env.GRABENPLANER_PUBLIC_URL = publicOrigin;
process.env.GRABENPLANER_TRUST_PROXY = "loopback";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.GRABENPLANER_AMU_KEY_ID = "v0862-download-test";
process.env.GRABENPLANER_AMU_KEY = Buffer.alloc(32, 26).toString("base64");
process.env.GRABENPLANER_INTEGRATION_KEY_ID = "v0862-download-test";
process.env.GRABENPLANER_INTEGRATION_KEY = Buffer.alloc(32, 74).toString("base64");
process.env.GRABENPLANER_SERVICE_CONTROL_TOKEN = "v0862-service-control-token-0123456789abcdef";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, hashPortalPassword } = subject;

let httpServer;
let baseUrl;
const actors = {};

async function createActor(employeeNumber, role, {
  grantBackup = false,
  denyBackup = false,
  grantOffsite = false,
  denyOffsite = false,
} = {}) {
  const location = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get();
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id, active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, `Backup-Test ${employeeNumber}`, `DB-${employeeNumber}`, location.id);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, role_locked, password_changed_at, updated_at)
    VALUES (?, ?, ?, 1, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = excluded.role,
      active = 1,
      must_change_password = 0,
      role_locked = excluded.role_locked,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, await hashPortalPassword(currentPassword), role, role === "developer" ? 1 : 0);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM portal_permission_denials WHERE employee_number = ?").run(employeeNumber);
  if (grantBackup) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, 'backup:write', 'v0862-test')
    `).run(employeeNumber);
  }
  if (denyBackup) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, 'backup:write', 'v0862-test')
    `).run(employeeNumber);
  }
  if (grantOffsite) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, 'system:offsite:configure', 'v0862-test')
    `).run(employeeNumber);
  }
  if (denyOffsite) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, 'system:offsite:configure', 'v0862-test')
    `).run(employeeNumber);
  }
  const token = `v0862-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.createHash("sha256").update(`gp-browser-csrf-v2\0${token}`).digest("hex");
  const now = new Date();
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at, authenticated_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"),
    new Date(now.getTime() + 30 * 60000).toISOString(), now.toISOString(),
    new Date(now.getTime() + 8 * 3600000).toISOString());
  return {
    employeeNumber,
    role,
    csrf,
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
  };
}

function requestHeaders(actor, {
  includeCsrf = true,
  origin = publicOrigin,
  fetchSite = "same-origin",
} = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Cookie: actor.cookie,
    "X-Forwarded-Proto": "https",
  };
  if (includeCsrf) headers["X-CSRF-Token"] = actor.csrf;
  if (origin) headers.Origin = origin;
  if (fetchSite) headers["Sec-Fetch-Site"] = fetchSite;
  return headers;
}

async function postJson(route, actor, body, options = {}) {
  return requestJson("POST", route, actor, body, options);
}

async function requestJson(method, route, actor, body, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: requestHeaders(actor, options),
    body: JSON.stringify(body),
  });
  if (response.headers.get("X-GP-Session-Changed") === "1") {
    const cookies = response.headers.getSetCookie();
    const csrf = cookies.find(value => value.startsWith("grabenplaner_csrf="));
    assert.ok(cookies.some(value => value.startsWith("grabenplaner_session=")) && csrf);
    const previousCsrf = actor.csrf;
    actor.cookie = cookies.map(value => value.split(";")[0]).join("; ");
    actor.csrf = decodeURIComponent(csrf.split(";")[0].slice("grabenplaner_csrf=".length));
    assert.notEqual(actor.csrf, previousCsrf);
  }
  return response;
}

async function errorPayload(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function rejectedBackupState(actor) {
  const exportRoot = path.join(testRoot, "transient", "database-exports");
  return {
    sessions: db.prepare(`
      SELECT id, token_hash, authenticated_at, absolute_expires_at, revoked_at
      FROM portal_sessions WHERE employee_number = ? ORDER BY id
    `).all(actor.employeeNumber).map(row => ({ ...row })),
    acceptedOrRequested: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_log WHERE action IN (
        'backup.admin.reauthentication.accepted', 'backup.database-download.requested',
        'backup.offsite-folder.create.requested', 'backup.offsite-folder.activate.requested'
      )
    `).get().count),
    exportFiles: fs.existsSync(exportRoot) ? fs.readdirSync(exportRoot, { recursive: true }).sort() : [],
  };
}

async function assertReauthenticationRejected(method, route, actor, body, status, code) {
  const before = rejectedBackupState(actor), cookie = actor.cookie, csrf = actor.csrf;
  const response = await requestJson(method, route, actor, body);
  assert.equal(response.status, status);
  assert.equal((await errorPayload(response)).code, code);
  assert.equal(response.headers.get("X-GP-Session-Changed"), null);
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal(actor.cookie, cookie); assert.equal(actor.csrf, csrf);
  assert.deepEqual(rejectedBackupState(actor), before,
    "rejected proof must not rotate credentials, accept or request an operation, or create an export");
}

function structurallyInvalidReauthenticationProofs() {
  const passkey = { challengeId: crypto.randomUUID(), response: {} };
  return [{}, { currentPassword: "" }, { currentPassword: "x".repeat(513) },
    { currentPassword, passkey }, { passkey: { ...passkey, response: [] } }];
}

test.before(async () => {
  actors.admin = await createActor("98621", "admin", { grantOffsite: true });
  actors.itAdmin = await createActor("98622", "it_admin", { grantOffsite: true });
  actors.developer = await createActor("98623", "developer");
  actors.hrWithBackup = await createActor("98624", "hr", { grantBackup: true, grantOffsite: true });
  actors.adminWithoutBackup = await createActor("98625", "admin", { denyBackup: true });
  actors.adminWithoutOffsite = await createActor("98626", "admin", { denyOffsite: true });
  actors.developerWithoutBackup = await createActor("98627", "developer", { denyBackup: true });
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('v0862_download_marker', 'vollstaendige-sqlite-kopie')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { await db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.86.2: Aufräumfehler der temporären Datenbankkopie bleiben redigiert und prozesssicher", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = source.slice(
    source.indexOf('app.post("/api/backup/database-download"'),
    source.indexOf('app.get("/api/backup/offsite-folders"'),
  );
  assert.match(route, /fs\.rmSync\(snapshot\.temporaryRoot,[\s\S]*maxRetries:\s*3/);
  assert.match(route, /catch \(error\)[\s\S]*backup\.database-download\.cleanup-failed/);
  assert.doesNotMatch(route, /console\.error\([^)]*snapshot\.temporaryRoot/);
});

test("v0.86.2: Datenbankdownload verlangt Bestätigung, CSRF, Same-Origin und aktuelles Passwort", async () => {
  const missingConfirmation = await postJson(
    "/api/backup/database-download",
    actors.admin,
    { currentPassword },
  );
  assert.equal(missingConfirmation.status, 400);
  assert.equal((await errorPayload(missingConfirmation)).code, "DATABASE_DOWNLOAD_CONFIRMATION_REQUIRED");

  const missingCsrf = await postJson(
    "/api/backup/database-download",
    actors.admin,
    { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword },
    { includeCsrf: false },
  );
  assert.equal(missingCsrf.status, 403);

  const missingOrigin = await postJson(
    "/api/backup/database-download",
    actors.admin,
    { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword },
    { origin: "" },
  );
  assert.equal(missingOrigin.status, 403);
  assert.equal((await errorPayload(missingOrigin)).code, "BACKUP_ADMIN_ORIGIN_REQUIRED");

  const crossSite = await postJson(
    "/api/backup/database-download",
    actors.admin,
    { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword },
    { origin: "https://other.example.test", fetchSite: "cross-site" },
  );
  assert.equal(crossSite.status, 403);
  assert.equal((await errorPayload(crossSite)).code, "ORIGIN_NOT_ALLOWED");

  // Exactly one bounded password or structurally valid passkey is required.
  // Invalid request shapes fail before password verification or any operation.
  for (const proof of structurallyInvalidReauthenticationProofs()) {
    await assertReauthenticationRejected("POST", "/api/backup/database-download", actors.admin,
      { confirmation: "DATABASE_BACKUP_DOWNLOAD", ...proof }, 400, "DATABASE_DOWNLOAD_CONFIRMATION_REQUIRED");
  }
  await assertReauthenticationRejected("POST", "/api/backup/database-download", actors.admin,
    { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword: "Falsches-Passwort!" },
    403, "BACKUP_ADMIN_AUTH_FAILED");
});

test("v0.86.2: Rolle und backup:write müssen gemeinsam wirksam sein", async () => {
  const wrongRole = await postJson(
    "/api/backup/database-download",
    actors.hrWithBackup,
    { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword },
  );
  assert.equal(wrongRole.status, 403);

  const missingPermission = await postJson(
    "/api/backup/database-download",
    actors.adminWithoutBackup,
    { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword },
  );
  assert.equal(missingPermission.status, 403);
});

test("v0.88.3: Offsite-Pfadänderungen verlangen Developer, Recht, Same-Origin und aktuelles Passwort", async () => {
  const createWithWrongPassword = await postJson(
    "/api/backup/offsite-folders",
    actors.developer,
    {
      confirmation: "CREATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword: "Falsches-Passwort!",
    },
  );
  assert.equal(createWithWrongPassword.status, 403);
  assert.equal((await errorPayload(createWithWrongPassword)).code, "BACKUP_ADMIN_AUTH_FAILED");

  for (const proof of structurallyInvalidReauthenticationProofs()) {
    await assertReauthenticationRejected("PUT", "/api/backup/offsite-folders/active", actors.developer,
      { confirmation: "ACTIVATE_MANAGED_OFFSITE_FOLDER", folderLabel: "Sicherung_2026", ...proof },
      400, "OFFSITE_TARGET_REQUEST_INVALID");
  }

  const wrongRole = await postJson(
    "/api/backup/offsite-folders",
    actors.hrWithBackup,
    {
      confirmation: "CREATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword,
    },
  );
  assert.equal(wrongRole.status, 403);

  const deniedPermission = await postJson(
    "/api/backup/offsite-folders",
    actors.adminWithoutOffsite,
    {
      confirmation: "CREATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword,
    },
  );
  assert.equal(deniedPermission.status, 403);

  const adminRoleDenied = await postJson(
    "/api/backup/offsite-folders",
    actors.admin,
    {
      confirmation: "CREATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword,
    },
  );
  assert.equal(adminRoleDenied.status, 403);

  const itAdminRoleDenied = await postJson(
    "/api/backup/offsite-folders",
    actors.itAdmin,
    {
      confirmation: "CREATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword,
    },
  );
  assert.equal(itAdminRoleDenied.status, 403);

  const offsiteWithoutBackupWrite = await requestJson(
    "PUT",
    "/api/backup/offsite-folders/active",
    actors.developerWithoutBackup,
    {
      confirmation: "ACTIVATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword,
    },
  );
  const offsiteWithoutBackupWriteError = await errorPayload(offsiteWithoutBackupWrite);
  assert.equal(offsiteWithoutBackupWrite.status, 503, JSON.stringify(offsiteWithoutBackupWriteError));

  const crossSite = await postJson(
    "/api/backup/offsite-folders",
    actors.developer,
    {
      confirmation: "CREATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword,
    },
    { origin: "https://other.example.test", fetchSite: "cross-site" },
  );
  assert.equal(crossSite.status, 403);

  const authenticatedRequest = await postJson(
    "/api/backup/offsite-folders",
    actors.developer,
    {
      confirmation: "CREATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword,
    },
  );
  assert.equal(authenticatedRequest.status, 503);
  assert.equal((await errorPayload(authenticatedRequest)).code, "INTERNAL_ERROR");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'backup.admin.reauthentication.accepted' AND entity_id = 'offsite-folder-create'").get().count,
    1,
  );
});

// Execute only the explicitly selected immutable historical assertion. The
// current server and current PostgreSQL API fixtures are never redirected.
function runFrozenHistoricalBackupTest(t, relative, expectedSha256, pattern, expectedPass) {
  const historical = require("../test-support/legacy-baseline");
  assert.equal(historical.BASELINE, "b2ba03cdc0b738d44766857de052e090db557807");
  historical.linkFrozenDependencies();
  const original = execFileSync("git", ["--no-replace-objects", "-C", path.resolve(__dirname, ".."),
    "show", historical.BASELINE + ":" + relative], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  assert.equal(crypto.createHash("sha256").update(original).digest("hex"), expectedSha256);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-immutable-backup-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const driver = path.join(directory, "immutable-backup.test.js"), filename = historical.legacyPath(relative);
  fs.writeFileSync(driver, `const Module=require('node:module'),path=require('node:path');
const filename=${JSON.stringify(filename)},subject=new Module(filename,module);
subject.filename=filename;subject.paths=Module._nodeModulePaths(path.dirname(filename));
subject._compile(${JSON.stringify(original.toString("utf8"))},filename);\n`);
  // execFileSync deliberately avoids the PostgreSQL fixture's spawn adapter.
  // The child receives no inherited NODE_OPTIONS, connection URLs or owner marker.
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
    LANG: "C.UTF-8", NODE_ENV: "test", GP_PG_API_FIXTURE_BRIDGE: "0" };
  let output;
  try {
    output = execFileSync(process.execPath, ["--no-global-search-paths", "--test", "--test-reporter=tap",
      ...(pattern ? ["--test-name-pattern=" + pattern] : []), driver], {
      cwd: historical.sourceRoot(), env: environment, encoding: "utf8", timeout: 180000,
      maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
  } catch (error) {
    assert.fail(String(error.stdout || "").slice(-18000) + "\n" + String(error.stderr || error.message).slice(-4000));
  }
  assert.match(output, new RegExp("^# pass " + expectedPass + "$", "m"));
  assert.match(output, /^# fail 0$/m);
  t.diagnostic(`Immutable ${historical.BASELINE} ${relative}: ${expectedPass} original assertions passed; SHA256 ${expectedSha256}`);
}

test("immutable historical SQLite download validates the original copy and removes temporary files", { timeout: 240000 }, t => {
  runFrozenHistoricalBackupTest(t, "test/v0862-server-backup-download.test.js",
    "8166bde27dfe2d23831cf678741fab66d71f063db38a2405711656a165bcfd0b",
    "^v0\\.86\\.2: Admin, IT-Admin und Developer erhalten", 1);
});

test("v0.86.2: Servermodus blockiert App-Pfadsicherung und manuelles lokales Backup", async () => {
  const settingsBefore = db.prepare(`
    SELECT key, value FROM settings
    WHERE key IN ('external_backup_enabled', 'backup_directory', 'backup_interval_hours')
    ORDER BY key
  `).all().map((row) => ({ ...row }));
  const appBackupDirectory = path.join(testRoot, "backups");
  const backupFilesBefore = fs.existsSync(appBackupDirectory)
    ? fs.readdirSync(appBackupDirectory).sort()
    : [];

  const settingsResponse = await fetch(`${baseUrl}/api/backup/settings`, {
    method: "PUT",
    headers: requestHeaders(actors.admin),
    body: JSON.stringify({
      externalBackupEnabled: true,
      backupDirectory: path.join(testRoot, "obsolete-second-backup"),
      backupIntervalHours: 2,
    }),
  });
  assert.equal(settingsResponse.status, 409);
  assert.equal((await errorPayload(settingsResponse)).code, "SERVER_MANAGED_BACKUP");

  const manualResponse = await postJson("/api/backup", actors.admin, {});
  assert.equal(manualResponse.status, 409);
  assert.equal((await errorPayload(manualResponse)).code, "SERVER_MANAGED_BACKUP");

  assert.deepEqual(
    db.prepare(`
      SELECT key, value FROM settings
      WHERE key IN ('external_backup_enabled', 'backup_directory', 'backup_interval_hours')
      ORDER BY key
    `).all().map((row) => ({ ...row })),
    settingsBefore,
  );
  assert.deepEqual(
    fs.existsSync(appBackupDirectory) ? fs.readdirSync(appBackupDirectory).sort() : [],
    backupFilesBefore,
  );
  assert.equal(fs.existsSync(path.join(testRoot, "obsolete-second-backup")), false);
});
