"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

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
process.env.GRABENPLANER_SERVICE_CONTROL_TOKEN = "v0862-service-control-token-0123456789abcdef";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, hashPortalPassword } = subject;

let httpServer;
let baseUrl;
const actors = {};

function downloadTemporaryDirectories() {
  return new Set(fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("grabenplaner-db-download-"))
    .map((entry) => entry.name));
}

async function waitForNoNewDownloadTemporaryDirectories(before, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const current = downloadTemporaryDirectories();
    const added = [...current].filter((name) => !before.has(name));
    if (!added.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const current = downloadTemporaryDirectories();
  assert.deepEqual([...current].filter((name) => !before.has(name)), []);
}

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
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
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
  try { db.close(); } catch {}
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

  const missingPassword = await postJson(
    "/api/backup/database-download",
    actors.admin,
    { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword: "" },
  );
  assert.equal(missingPassword.status, 403);
  assert.equal((await errorPayload(missingPassword)).code, "BACKUP_ADMIN_AUTH_FAILED");

  const wrongPassword = await postJson(
    "/api/backup/database-download",
    actors.admin,
    { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword: "Falsches-Passwort!" },
  );
  assert.equal(wrongPassword.status, 403);
  assert.equal((await errorPayload(wrongPassword)).code, "BACKUP_ADMIN_AUTH_FAILED");
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

  const activateWithoutPassword = await requestJson(
    "PUT",
    "/api/backup/offsite-folders/active",
    actors.developer,
    {
      confirmation: "ACTIVATE_MANAGED_OFFSITE_FOLDER",
      folderLabel: "Sicherung_2026",
      currentPassword: "",
    },
  );
  assert.equal(activateWithoutPassword.status, 403);
  assert.equal((await errorPayload(activateWithoutPassword)).code, "BACKUP_ADMIN_AUTH_FAILED");

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

test("v0.86.2: Admin, IT-Admin und Developer erhalten eine geprüfte SQLite-Kopie ohne Temp-Rest", async () => {
  const temporaryBefore = downloadTemporaryDirectories();
  for (const actor of [actors.admin, actors.itAdmin, actors.developer]) {
    const response = await postJson(
      "/api/backup/database-download",
      actor,
      { confirmation: "DATABASE_BACKUP_DOWNLOAD", currentPassword },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("content-type"), "application/vnd.sqlite3");
    assert.match(response.headers.get("content-disposition") || "", /^attachment;/i);
    assert.match(response.headers.get("cache-control") || "", /private/);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");

    const content = Buffer.from(await response.arrayBuffer());
    assert.equal(content.subarray(0, 16).toString("binary"), "SQLite format 3\u0000");
    const downloadedPath = path.join(testRoot, `download-${actor.role}.db`);
    fs.writeFileSync(downloadedPath, content, { mode: 0o600 });
    const downloaded = new DatabaseSync(downloadedPath, { readOnly: true });
    try {
      assert.deepEqual(
        downloaded.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]),
        ["ok"],
      );
      assert.equal(
        downloaded.prepare("SELECT value FROM settings WHERE key = 'v0862_download_marker'").get().value,
        "vollstaendige-sqlite-kopie",
      );
    } finally {
      downloaded.close();
      fs.rmSync(downloadedPath, { force: true });
    }
  }
  await waitForNoNewDownloadTemporaryDirectories(temporaryBefore);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'backup.database-download.completed'").get().count,
    3,
  );
  const sensitiveAuditText = db.prepare(`
    SELECT GROUP_CONCAT(detail, '\n') AS details
    FROM audit_log
    WHERE action LIKE 'backup.%'
  `).get().details || "";
  assert.doesNotMatch(sensitiveAuditText, /Sicheres-Download-Passwort|Falsches-Passwort|currentPassword/i);
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
