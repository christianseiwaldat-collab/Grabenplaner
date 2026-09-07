"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0862-local-backup-"));
const databasePath = path.join(testRoot, "dienstplan.db");
const externalBackupDirectory = path.join(testRoot, "configured-local-backups");

process.env.DB_PATH = databasePath;
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_OPERATION_MODE = "local";
process.env.GRABENPLANER_FORCE_PORTAL = "0";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";
delete process.env.BACKUP_DIR;
delete process.env.GRABENPLANER_PUBLIC_URL;

const subject = require("../server");
const { app, db } = subject;

let httpServer;
let baseUrl;

async function responseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
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
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.86.2: Lokaler Betrieb behält Pfadkonfiguration und manuelle Sicherung unverändert", async () => {
  const settingsResponse = await fetch(`${baseUrl}/api/backup/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      externalBackupEnabled: true,
      backupDirectory: externalBackupDirectory,
      backupIntervalHours: 3,
    }),
  });
  assert.equal(settingsResponse.status, 200, await settingsResponse.clone().text());
  const settingsPayload = await responseJson(settingsResponse);
  assert.equal(settingsPayload.externalBackupEnabled, true);
  assert.equal(settingsPayload.backupIntervalHours, 3);
  assert.deepEqual(
    Object.fromEntries(db.prepare(`
      SELECT key, value FROM settings
      WHERE key IN ('external_backup_enabled', 'backup_directory', 'backup_interval_hours')
    `).all().map((row) => [row.key, row.value])),
    {
      external_backup_enabled: "1",
      backup_directory: externalBackupDirectory,
      backup_interval_hours: "3",
    },
  );

  const backupResponse = await fetch(`${baseUrl}/api/backup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(backupResponse.status, 201, await backupResponse.clone().text());
  const backup = await responseJson(backupResponse);
  assert.equal(backup.appBackup?.verified, true);
  assert.equal(backup.appBackup?.committed, true);
  assert.equal(backup.externalBackup?.verified, true);
  assert.equal(backup.externalBackup?.committed, true);
  assert.equal(path.dirname(backup.externalBackup.path), externalBackupDirectory);

  const names = fs.readdirSync(externalBackupDirectory).sort();
  assert.equal(names.filter((name) => name.endsWith(".db")).length, 1);
  assert.equal(names.filter((name) => name.endsWith(".amu")).length, 1);
  assert.equal(names.filter((name) => name.endsWith(".complete.json")).length, 1);
});

test("Lokale Sicherung: 24-Stunden-Intervall wird gespeichert und ungueltige Aenderung bleibt atomar", async () => {
  const save = hours => fetch(`${baseUrl}/api/backup/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalBackupEnabled: true, backupDirectory: externalBackupDirectory, backupIntervalHours: hours }),
  });
  const accepted = await save(24);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal((await responseJson(accepted)).backupIntervalHours, 24);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='backup_interval_hours'").get().value, "24");

  const rejected = await save(25);
  assert.equal(rejected.status, 400, await rejected.clone().text());
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='backup_interval_hours'").get().value, "24");
});
