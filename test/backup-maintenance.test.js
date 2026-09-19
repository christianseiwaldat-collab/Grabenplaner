"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ownsLifecycleBackup, FORMAT } = require("../lib/backup-maintenance");

function readerFixture() {
  const databasePath = path.resolve("synthetic-live.db");
  const file = { uid: 0, gid: 0, mode: 0o100644, dev: 1, ino: 3, size: 123, nlink: 1, mtimeMs: 123,
    isFile: () => true, isSymbolicLink: () => false };
  const directory = { uid: 0, mode: 0o40755, isDirectory: () => true, isSymbolicLink: () => false };
  let receipt = { format: FORMAT, databasePath, createdAt: new Date().toISOString() };
  let result = { status: 73 }, closed = 0, changed;
  const leasePath = path.resolve("synthetic-owner.json");
  const options = { platform: "linux", leasePath, io: {
    lstatSync: name => name === leasePath ? (changed || file) : directory,
    openSync: () => 42, fstatSync: () => file, readFileSync: () => JSON.stringify(receipt), closeSync: () => closed++,
  }, run(command, args, config) {
    assert.equal(command, "/usr/bin/flock");
    assert.deepEqual(config.stdio, ["ignore", "ignore", "ignore", 42]);
    assert.deepEqual(args, ["--shared", "--nonblock", "--conflict-exit-code", "73", "3"]);
    return result;
  } };
  return { databasePath, options, file, directory, setReceipt: value => { receipt = value; },
    setResult: value => { result = value; }, replace: value => { changed = value; }, closed: () => closed };
}

test("only a live trusted owner for this database replaces lifecycle backups", () => {
  const f = readerFixture(), read = () => ownsLifecycleBackup(f.databasePath, f.options);
  assert.equal(read(), true);
  assert.equal(ownsLifecycleBackup(path.resolve("another.db"), f.options), false);
  assert.equal(ownsLifecycleBackup(f.databasePath, { ...f.options, platform: "win32" }), false);
  for (const result of [{ status: 0 }, { status: 1 }, { status: null, signal: "SIGTERM" }, { status: 73, error: new Error("timeout") }]) {
    f.setResult(result); assert.equal(read(), false, "idle, failure and timeout must keep the app backup");
  }
  assert.equal(f.closed(), 6);
});

test("forged, writable, linked, replaced or malformed owner evidence never disables a backup", () => {
  for (const mutation of [
    f => { f.file.uid = 1000; }, f => { f.file.mode = 0o100666; }, f => { f.file.nlink = 2; },
    f => { f.file.isSymbolicLink = () => true; }, f => { f.directory.mode = 0o40777; },
    f => { f.file.size = 3000; }, f => f.setReceipt({ format: FORMAT, databasePath: f.databasePath }),
    f => { f.options.io.readFileSync = () => "invalid JSON"; },
    f => { const run = f.options.run; f.options.run = (...args) => { const result = run(...args); f.replace({ ...f.file, ino: 99 }); return result; }; },
  ]) {
    const f = readerFixture(); mutation(f);
    assert.equal(ownsLifecycleBackup(f.databasePath, f.options), false);
  }
  assert.equal(ownsLifecycleBackup(undefined, { platform: "linux" }), false);
});

test("updater-owned shutdown still drains work and closes persistence before releasing the instance", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = source.indexOf("function shutdown("), end = source.indexOf("if (require.main === module)", start);
  const events = [];
  let finishScanner;
  const amuScannerProbe = new Promise(resolve => { finishScanner = resolve; });
  const dependencies = { postgresqlActive: false, shutdownStarted: false, server: null, databaseClosed: false,
    amuScannerProbe,
    dataImportJobs: { stop: async () => events.push("imports-stop") },
    dataImportRoutes: { stop: async () => events.push("import-routes-stop") },
    salesReportJobs: { stop: async () => events.push("reports-stop") },
    postgresqlReceiptWorkers: {close:async()=>events.push('receipt-workers-stop')},
    backupInterval: null, retentionInterval: null, scannerProbeInterval: null, sicknessSweepInterval: null,
    notificationDispatchInterval: null, rateLimitCleanupInterval: null, systemCenterHealthInterval: null,
    localBackupArchiveEnabled: () => true, maintenanceOwnsLifecycleBackup: () => true,
    require: () => ({ drainBackgroundBackups: async () => events.push("drain") }),
    createDatabaseBackup: async () => events.push("duplicate-backup"),
    persistenceProvider: { close: async () => events.push("persistence-close") },
    sqliteMaintenanceOperations: { checkpointWal: () => events.push("checkpoint") }, db: { close: () => events.push("database-close") },
    releaseInstanceLock: () => events.push("release"), process: { exit: code => events.push(`exit-${code}`) }, console };
  const stop = vm.runInNewContext(`${source.slice(start, end)}; shutdown`, dependencies);
  stop(); await new Promise(setImmediate);
  assert.deepEqual(events, ["imports-stop", "import-routes-stop"], "shutdown must wait for the active scanner before backup and persistence cleanup");
  finishScanner(); await new Promise(setImmediate);
  assert.deepEqual(events, ["imports-stop", "import-routes-stop", "reports-stop", "receipt-workers-stop", "drain", "persistence-close", "checkpoint", "database-close", "release", "exit-0"]);
});
