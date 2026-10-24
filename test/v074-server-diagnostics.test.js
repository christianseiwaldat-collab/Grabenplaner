"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

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
  db,
  newestDatabaseBackup,
  releaseInstanceLockForTests,
  serverDiagnostics,
  serverStatusSummary,
} = require("../server");

test.after(async () => {
  await db.close();
  releaseInstanceLockForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

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

test("immutable historical SQLite backup rejects its future-dated commit marker", { timeout: 240000 }, t => {
  runFrozenHistoricalBackupTest(t, "test/v074-server-diagnostics.test.js",
    "91f4748693806d43693a06e84c6f37fe7b1caed6f0e8ffb6eb3b48f91256cb5d",
    "^v0\\.74 never treats a future-dated local backup as fresh$", 1);
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
