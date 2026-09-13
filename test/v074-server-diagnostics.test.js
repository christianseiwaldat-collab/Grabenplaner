"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v074-diagnostics-"));
const databasePath = path.join(root, "data", "dienstplan.db");
const externalBackupPath = path.join(root, "external-backups");
process.env.DB_PATH = databasePath;
process.env.BACKUP_DIR = externalBackupPath;
process.env.GRABENPLANER_DATA_DIR = root;
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.NODE_ENV = "test";

const {
  backupAgeState,
  createDatabaseBackupToDirectory,
  db,
  newestDatabaseBackup,
  releaseInstanceLockForTests,
  serverDiagnostics,
  serverStatusSummary,
} = require("../server");

test.after(() => {
  db.close();
  releaseInstanceLockForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test("v0.74 never treats a future-dated local backup as fresh", async () => {
  const backup = createDatabaseBackupToDirectory(externalBackupPath, "future-clock-test", "external");
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  fs.utimesSync(backup.marker, future, future);

  const diagnostics = await serverDiagnostics();
  assert.equal(diagnostics.backups.latestExternalTimestampValid, false);
  assert.equal(diagnostics.backups.latestExternalAgeHours, null);
  assert.equal(diagnostics.productionChecks.find((check) => check.id === "backup").ok, false);
  assert.ok(diagnostics.alerts.some((alert) => alert.id === "EXTERNAL_BACKUP_TIMESTAMP_FUTURE" && alert.severity === "critical"));

  const status = await serverStatusSummary(diagnostics);
  assert.equal(status.backups.external.timestampValid, false);
  assert.equal(status.backups.external.ageHours, null);
  assert.ok(status.alerts.some((alert) => alert.id === "EXTERNAL_BACKUP_TIMESTAMP_FUTURE"));
});

test("v0.74 selects the actual newest backup and uses a bounded future tolerance", async () => {
  const now = Date.now();
  const olderExternal = { modifiedMs: now - 60_000, name: "external" };
  const newerInternal = { modifiedMs: now - 1_000, name: "internal" };
  assert.equal(newestDatabaseBackup(olderExternal, newerInternal).name, "internal");
  assert.equal(backupAgeState({ modifiedMs: now + 60_000 }, now).timestampValid, true);
  assert.equal(backupAgeState({ modifiedMs: now + 10 * 60_000 }, now).timestampValid, false);
  assert.equal(backupAgeState({ modifiedMs: now + 10 * 60_000 }, now).ageHours, null);
});

test("v0.74 redacted status DTO contains no internal paths or technical process metadata", async () => {
  const summary = await serverStatusSummary(await serverDiagnostics());
  const serialized = JSON.stringify(summary);
  for (const forbidden of [root, databasePath, externalBackupPath, "dataRoot", "appDirectory", "externalDirectory", "rootDirectory", "keyId", '"pid"']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(summary.live), ["ok"]);
  assert.deepEqual(Object.keys(summary.ready), ["ok"]);
  assert.ok(summary.alerts.every((alert) => ["info", "warning", "critical"].includes(alert.severity)));
});

test("v0.74 maps diagnostics routes before the generic schedule permission", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const preciseGate = source.indexOf('const preciseDiagnosticPermissions = request.path === "/server-status"');
  const genericGate = source.indexOf('let permission = usbProvisioningRoute ? "usb:provision" : "schedule:read"');
  assert.ok(preciseGate > 0 && genericGate > preciseGate);
  assert.match(source.slice(preciseGate, genericGate), /system:diagnostics:read/);
  assert.match(source.slice(preciseGate, genericGate), /system:diagnostics:technical/);
  assert.match(source.slice(preciseGate, genericGate), /requirePortalAnyPermission/);
});
