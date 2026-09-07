"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
const { writeBackupCommitMarker } = require("../lib/backup-commit");
const { sha256File } = require("../lib/file-integrity");
const { acquireDatabaseLock, releaseDatabaseLock } = require("../lib/database-lock");
const { acquireBackupWorkspace } = require("../lib/backup-workspace");
const { __test, validateJob, childEnvironment, validateResult } = require("../lib/background-backup-process");
const project = path.resolve(__dirname, "..");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const temporaryRoot = path.join(project, "tmp"); fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "background-backup-process-test-"));
  const source = path.join(directory, "source"), protectedDirectory = path.join(source, "amu"), backupDirectory = path.join(directory, "backups");
  fs.mkdirSync(source); fs.mkdirSync(backupDirectory);
  const databasePath = path.join(source, "live.db"), database = openSqliteLegacyDatabase(databasePath);
  try { database.exec("CREATE TABLE synthetic_backup_payload(value TEXT); INSERT INTO synthetic_backup_payload VALUES('synthetic-only');"); }
  finally { database.close(); }
  const key = crypto.randomBytes(32);
  createAmuStorage({ rootDirectory: protectedDirectory, encryptionKeys: { synthetic: key }, activeKeyId: "synthetic" });
  key.fill(0);
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(temporaryRoot)); fs.rmSync(directory, { recursive: true }); });
  const snapshot = "dienstplan-synthetic-background", copiedDatabase = path.join(backupDirectory, `${snapshot}.db`);
  fs.copyFileSync(databasePath, copiedDatabase);
  const hash = sha256File(copiedDatabase), copiedDocuments = path.join(backupDirectory, `${snapshot}.amu`);
  syncEncryptedFilesBackup({ sourceDirectory: protectedDirectory, targetDirectory: copiedDocuments,
    manifestMetadata: { database: { fileName: `${snapshot}.db`, sha256: hash } } });
  writeBackupCommitMarker({ backupDirectory, snapshot, databaseSha256: hash });
  const backup = { path: copiedDatabase, protectedDirectory: copiedDocuments, marker: path.join(backupDirectory, `${snapshot}.complete.json`),
    snapshot, databaseSha256: hash, verified: true, committed: true, archive: null };
  return { directory, job: { databasePath, protectedDirectory, backupDirectory, expectedStream: "app", environment: { GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "0" } },
    protocol: JSON.stringify({ format: "grabenplaner-background-backup-result", schemaVersion: 1, backup }), backup };
}
function fakeChild(pid = 12345) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.finish = (code, output = "") => {
    child.exitCode = code;
    if (output) child.stdout.write(output);
    child.stdout.end(); child.stderr.end(); child.emit("close", code);
  };
  return child;
}

test("background backup input and child environment are scoped without secret arguments or implicit paths", t => {
  const f = fixture(t), job = validateJob(f.job);
  for (const changed of [{ databasePath: "relative" }, { backupDirectory: f.directory }, { expectedStream: "other" }]) {
    assert.throws(() => validateJob({ ...f.job, ...changed }));
  }
  const link = path.join(f.directory, "source-link");
  fs.symlinkSync(path.dirname(f.job.databasePath), link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => validateJob({ ...f.job, databasePath: path.join(link, "live.db") }));
  const environment = childEnvironment(job, { GRABENPLANER_INTEGRATION_KEY: "SYNTHETIC-SECRET", NODE_OPTIONS: "--require=unsafe",
    RESTIC_PASSWORD_COMMAND: "unsafe", SSH_AUTH_SOCK: "unsafe", DB_PATH: "unsafe", GRABENPLANER_AMU_DIR: "unsafe" });
  assert.equal(environment.GRABENPLANER_INTEGRATION_KEY, "SYNTHETIC-SECRET");
  assert.equal(environment.DB_PATH, job.databasePath);
  assert.equal(environment.GRABENPLANER_AMU_DIR, job.protectedDirectory);
  assert.equal(childEnvironment(job, { GRABENPLANER_AMU_KEY: "SYNTHETIC-DOCUMENT-KEY" }).GRABENPLANER_AMU_KEY, "SYNTHETIC-DOCUMENT-KEY");
  for (const key of ["NODE_OPTIONS", "RESTIC_PASSWORD_COMMAND", "SSH_AUTH_SOCK"]) assert.equal(environment[key], undefined);
});

test("background scheduler serializes complete jobs and drain waits for actual child close", async t => {
  const f = fixture(t), children = [], seen = [];
  const scheduler = __test.createScheduler({ platform: "linux", spawn: (executable, args, options) => {
    seen.push({ executable, args, options });
    const child = fakeChild(12000 + children.length); children.push(child); return child;
  } });
  const options = { ...f.job, environment: { GRABENPLANER_INTEGRATION_KEY: "SYNTHETIC-SECRET" } };
  const first = scheduler.createBackgroundBackup(options), second = scheduler.createBackgroundBackup(options);
  assert.equal(children.length, 1);
  assert.deepEqual(scheduler.backgroundBackupStatus(), { running: true, queued: 1, lastSuccessAt: null, lastErrorCode: null });
  assert.equal(seen[0].executable, process.execPath);
  assert.deepEqual(seen[0].args, ["--max-old-space-size=512", __test.CHILD_ENTRY]);
  assert.equal(seen[0].options.detached, true);
  assert.equal(seen[0].options.shell, false);
  assert.equal(seen[0].options.windowsHide, true);
  assert.equal(JSON.stringify(seen[0].args).includes("SYNTHETIC-SECRET"), false);
  let drained = false;
  const drain = scheduler.drainBackgroundBackups().then(() => { drained = true; });
  children[0].finish(0, f.protocol);
  assert.equal((await first).path, f.backup.path);
  await tick();
  assert.equal(children.length, 2);
  assert.equal(drained, false);
  children[1].finish(0, f.protocol);
  await second; await drain;
  assert.equal(drained, true);
  assert.equal(scheduler.backgroundBackupStatus().running, false);
  assert.equal(scheduler.backgroundBackupStatus().queued, 0);
  assert.ok(scheduler.backgroundBackupStatus().lastSuccessAt);
});

test("background result validation rejects logged or forged paths and only accepts exit zero", async t => {
  const f = fixture(t);
  assert.throws(() => validateResult(`log\n${f.protocol}`, f.job));
  assert.throws(() => validateResult(f.protocol, f.job, { archiveRequired: true }));
  const tampered = JSON.parse(f.protocol); tampered.backup.path = f.job.databasePath;
  assert.throws(() => validateResult(JSON.stringify(tampered), f.job));
  const child = fakeChild();
  const scheduler = __test.createScheduler({ spawn: () => child });
  const promise = scheduler.createBackgroundBackup(f.job);
  child.stderr.write("SYNTHETIC-SECRET-MUST-NOT-LEAK");
  child.finish(1, f.protocol);
  await assert.rejects(promise, error => error.code === "BACKGROUND_BACKUP_FAILED" && !error.message.includes("SYNTHETIC-SECRET"));
  await scheduler.drainBackgroundBackups();
  assert.equal(scheduler.backgroundBackupStatus().lastSuccessAt, null);
  assert.equal(scheduler.backgroundBackupStatus().lastErrorCode, "BACKGROUND_BACKUP_FAILED");
});

test("background output limits and timeout wait for the owned process tree before releasing queue", async t => {
  const f = fixture(t);
  for (const condition of ["overflow", "timeout"]) {
    const child = fakeChild(); let killCalled = false, confirmTreeStopped;
    const scheduler = __test.createScheduler({ timeoutMs: 15, spawn: () => child,
      terminateTree: actual => { assert.equal(actual, child); killCalled = true; return new Promise(resolve => { confirmTreeStopped = resolve; }); } });
    const pending = scheduler.createBackgroundBackup(f.job);
    const rejected = assert.rejects(pending, { code: condition === "overflow" ? "BACKGROUND_BACKUP_OUTPUT_LIMIT" : "BACKGROUND_BACKUP_TIMEOUT" });
    if (condition === "overflow") child.stdout.write(Buffer.alloc(__test.MAX_OUTPUT_BYTES + 1));
    else await new Promise(resolve => setTimeout(resolve, 30));
    await tick();
    assert.equal(killCalled, true);
    child.finish(1);
    assert.equal(scheduler.backgroundBackupStatus().running, true, "close alone cannot release a terminating tree");
    confirmTreeStopped();
    await rejected; await scheduler.drainBackgroundBackups();
    assert.equal(scheduler.backgroundBackupStatus().running, false);
  }
});

test("unverified process-tree termination blocks queued jobs and Linux kill targets only the owned group", async t => {
  const f = fixture(t), child = fakeChild(); let spawns = 0;
  const scheduler = __test.createScheduler({ spawn: () => { spawns++; return child; }, terminateTree: async () => { throw new Error("unverified"); } });
  const first = scheduler.createBackgroundBackup(f.job), second = scheduler.createBackgroundBackup(f.job);
  const rejected = Promise.all([assert.rejects(first, { code: "BACKGROUND_BACKUP_TREE_UNVERIFIED" }),
    assert.rejects(second, { code: "BACKGROUND_BACKUP_TREE_UNVERIFIED" })]);
  child.stderr.write(Buffer.alloc(__test.MAX_OUTPUT_BYTES + 1));
  await tick(); child.finish(1); await rejected;
  assert.equal(spawns, 1);
  const signals = []; let alive = true;
  await __test.terminateOwnedTree(fakeChild(65432), { platform: "linux", graceMs: 0, settleMs: 1,
    kill: (pid, signal) => {
      assert.equal(pid, -65432); signals.push(signal);
      if (!alive) { const error = new Error("gone"); error.code = "ESRCH"; throw error; }
      if (signal === "SIGKILL") alive = false;
    } });
  assert.ok(signals.includes("SIGTERM"));
  assert.ok(signals.includes("SIGKILL"));
});

test("unconfirmed tree termination rejects jobs and drain even without child close", async t => {
  const f = fixture(t), child = fakeChild();
  const scheduler = __test.createScheduler({ timeoutMs: 10, spawn: () => child,
    terminateTree: async () => { throw new Error("cannot prove tree exit"); } });
  const first = scheduler.createBackgroundBackup(f.job), second = scheduler.createBackgroundBackup(f.job);
  await Promise.all([assert.rejects(first, { code: "BACKGROUND_BACKUP_TREE_UNVERIFIED" }),
    assert.rejects(second, { code: "BACKGROUND_BACKUP_TREE_UNVERIFIED" }),
    assert.rejects(scheduler.drainBackgroundBackups(), { code: "BACKGROUND_BACKUP_TREE_UNVERIFIED" })]);
  assert.deepEqual(scheduler.backgroundBackupStatus(), { running: true, queued: 0, lastSuccessAt: null, lastErrorCode: "BACKGROUND_BACKUP_TREE_UNVERIFIED" });
  await assert.rejects(scheduler.createBackgroundBackup(f.job), { code: "BACKGROUND_BACKUP_TREE_UNVERIFIED" });
  child.finish(1); // Late close cannot turn an unconfirmed tree into claimed success.
  assert.equal(scheduler.backgroundBackupStatus().running, true);
});

test("background queue is bounded at four complete jobs including the active child", async t => {
  const f = fixture(t), children = [];
  const scheduler = __test.createScheduler({ spawn: () => { const child = fakeChild(); children.push(child); return child; } });
  const jobs = Array.from({ length: 4 }, () => scheduler.createBackgroundBackup(f.job));
  assert.equal(scheduler.backgroundBackupStatus().queued, 3);
  await assert.rejects(scheduler.createBackgroundBackup(f.job), { code: "BACKGROUND_BACKUP_QUEUE_FULL" });
  for (let i = 0; i < 4; i++) { children[i].finish(0, f.protocol); await jobs[i]; await tick(); }
  await scheduler.drainBackgroundBackups();
  assert.equal(children.length, 4);
});

test("a reported tree stop without child close cannot leave drain pending forever", async t => {
  const f = fixture(t), child = fakeChild();
  const scheduler = __test.createScheduler({ timeoutMs: 10, closeSettleMs: 10, spawn: () => child, terminateTree: async () => {} });
  const job = scheduler.createBackgroundBackup(f.job);
  await Promise.all([assert.rejects(job, { code: "BACKGROUND_BACKUP_TREE_UNVERIFIED" }),
    assert.rejects(scheduler.drainBackgroundBackups(), { code: "BACKGROUND_BACKUP_TREE_UNVERIFIED" })]);
  assert.equal(scheduler.backgroundBackupStatus().running, true, "unconfirmed close is not reported as stopped");
  child.finish(1);
});

test("constant-time reserve is checked before spawn and monitored while the child runs", async t => {
  const f = fixture(t); let spawns = 0;
  const tooSmall = __test.createScheduler({ statfs: () => ({ bavail: __test.MINIMUM_FREE_BYTES, bsize: 1 }),
    spawn: () => { spawns++; return fakeChild(); } });
  await assert.rejects(tooSmall.createBackgroundBackup(f.job), { code: "BACKGROUND_BACKUP_CAPACITY_REQUIRED" });
  assert.equal(spawns, 0);
  const child = fakeChild(); let checks = 0, stopped = false;
  const monitored = __test.createScheduler({ monitorMs: 5, spawn: () => child,
    statfs: () => ({ bavail: ++checks === 1 ? 100 * 1024 ** 3 : __test.MINIMUM_FREE_BYTES - 1, bsize: 1 }),
    terminateTree: async () => { stopped = true; child.finish(1); } });
  await assert.rejects(monitored.createBackgroundBackup(f.job), { code: "BACKGROUND_BACKUP_CAPACITY_REQUIRED" });
  await monitored.drainBackgroundBackups();
  assert.equal(stopped, true);
});

test("an archive job failure blocks its scope until deliberate restart and drain rejects", async t => {
  const f = fixture(t), child = fakeChild(); let spawns = 0;
  const job = { ...f.job, environment: { GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1" } };
  const scheduler = __test.createScheduler({ platform: "linux", spawn: () => { spawns++; return child; }, terminateTree: async () => {} });
  const first = scheduler.createBackgroundBackup(job), second = scheduler.createBackgroundBackup(job);
  const assertions = Promise.all([assert.rejects(first, { code: "BACKGROUND_BACKUP_FAILED" }),
    assert.rejects(second, { code: "BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED" }),
    assert.rejects(scheduler.drainBackgroundBackups(), { code: "BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED" })]);
  child.finish(1); await assertions;
  await assert.rejects(scheduler.createBackgroundBackup(job), { code: "BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED" });
  await assert.rejects(scheduler.drainBackgroundBackups(), { code: "BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED" });
  assert.equal(spawns, 1);
  assert.equal(scheduler.backgroundBackupStatus().running, false);
  assert.deepEqual(scheduler.backgroundBackupStatus().failedScopes, [{ stream: "app", code: "BACKGROUND_BACKUP_FAILED" }]);
});

test("one absolute deadline includes queue time and prevents the second child from starting late", async t => {
  const f = fixture(t), children = [];
  const scheduler = __test.createScheduler({ spawn: () => { const child = fakeChild(); children.push(child); return child; },
    terminateTree: async child => { child.finish(1); } });
  for (const deadlineMs of ["wrong", 0, -1, 1.5]) {
    await assert.rejects(scheduler.createBackgroundBackup({ ...f.job, deadlineMs }), { code: "BACKGROUND_BACKUP_DEADLINE_INVALID" });
  }
  const deadlineMs = Date.now() + 50;
  const first = scheduler.createBackgroundBackup({ ...f.job, deadlineMs });
  const second = scheduler.createBackgroundBackup({ ...f.job, deadlineMs });
  await Promise.all([assert.rejects(first, { code: "BACKGROUND_BACKUP_TIMEOUT" }),
    assert.rejects(second, { code: "BACKGROUND_BACKUP_TIMEOUT" })]);
  await scheduler.drainBackgroundBackups();
  assert.equal(children.length, 1);
  assert.equal(scheduler.backgroundBackupStatus().running, false);
});

test("document tree inventory never runs in the parent HTTP process", async t => {
  const f = fixture(t), child = fakeChild();
  const originalReadDir = fs.readdirSync;
  const scheduler = __test.createScheduler({ spawn: () => child });
  let job;
  try {
    fs.readdirSync = () => { throw new Error("parent document traversal is forbidden"); };
    job = scheduler.createBackgroundBackup(f.job);
  } finally { fs.readdirSync = originalReadDir; }
  child.finish(0, f.protocol);
  assert.equal((await job).verified, true);
  const childSource = fs.readFileSync(path.join(project, "scripts/run-background-backup.js"), "utf8");
  assert.ok(childSource.indexOf("assertRawBackupCapacity(job)") < childSource.indexOf("createPairedBackup(database"));
});

test("shutdown drain only shortens deadlines for an already active child and queued jobs", async t => {
  const f = fixture(t), children = [];
  const scheduler = __test.createScheduler({ spawn: () => { const child = fakeChild(); children.push(child); return child; },
    terminateTree: async child => { child.finish(1); } });
  const first = scheduler.createBackgroundBackup({ ...f.job, deadlineMs: Date.now() + 5000 });
  const second = scheduler.createBackgroundBackup({ ...f.job, deadlineMs: Date.now() + 5000 });
  const results = Promise.all([assert.rejects(first, { code: "BACKGROUND_BACKUP_TIMEOUT" }),
    assert.rejects(second, { code: "BACKGROUND_BACKUP_TIMEOUT" })]);
  await assert.rejects(scheduler.drainBackgroundBackups({ deadlineMs: "invalid" }), { code: "BACKGROUND_BACKUP_DEADLINE_INVALID" });
  const shortDrain = scheduler.drainBackgroundBackups({ deadlineMs: Date.now() + 50 });
  const cannotExtend = scheduler.drainBackgroundBackups({ deadlineMs: Date.now() + 10000 });
  await Promise.all([results, shortDrain, cannotExtend]);
  assert.equal(children.length, 1);
  assert.equal(scheduler.backgroundBackupStatus().running, false);
});

test("nonzero Linux child close checks remaining owned descendants before settlement", async t => {
  const f = fixture(t), child = fakeChild(); let checked = false;
  const scheduler = __test.createScheduler({ platform: "linux", spawn: () => child,
    terminateTree: async actual => { assert.equal(actual, child); checked = true; } });
  const job = scheduler.createBackgroundBackup(f.job);
  child.finish(1);
  await assert.rejects(job, { code: "BACKGROUND_BACKUP_FAILED" });
  assert.equal(checked, true);
});

test("real background child produces a verified backup while application instance lock remains held", async t => {
  const f = fixture(t), before = sha256File(f.job.databasePath);
  const lock = acquireDatabaseLock({ databasePath: f.job.databasePath, kind: "app", appVersion: "synthetic-test" });
  const scheduler = __test.createScheduler();
  let ticks = 0;
  const interval = setInterval(() => { ticks++; }, 5);
  try {
    const result = await scheduler.createBackgroundBackup(f.job);
    await scheduler.drainBackgroundBackups();
    assert.equal(result.verified, true);
    assert.equal(result.committed, true);
    assert.equal(result.archive, null);
    assert.notEqual(result.snapshot, f.backup.snapshot);
    assert.ok(ticks > 0, "main event loop remains responsive throughout child backup");
    assert.equal(sha256File(f.job.databasePath), before);
    assert.ok(fs.existsSync(lock.lockPath));
    assert.equal(scheduler.backgroundBackupStatus().lastErrorCode, null);
  } finally { clearInterval(interval); releaseDatabaseLock(lock); }
  const childSource = fs.readFileSync(path.join(project, "scripts/run-background-backup.js"), "utf8");
  assert.match(childSource, /readOnly: true/);
  assert.doesNotMatch(childSource, /acquireDatabaseLock|releaseDatabaseLock/);
  assert.match(childSource, /console\.log = \(\) => \{\}/);
  assert.equal(__test.TIMEOUT_MS, 1500000);
});

test("real background worker waits for the shared workspace before allocating a new backup", { timeout: 30000 }, async t => {
  const f = fixture(t);
  const before = fs.readdirSync(f.job.backupDirectory).sort();
  const lease = acquireBackupWorkspace({ databasePath: f.job.databasePath });
  const scheduler = __test.createScheduler();
  let settled = false;
  const pending = scheduler.createBackgroundBackup({ ...f.job, deadlineMs: Date.now() + 20000 });
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(settled, false);
    assert.equal(scheduler.backgroundBackupStatus().running, true);
    assert.deepEqual(fs.readdirSync(f.job.backupDirectory).sort(), before, "no new raw copy while a restore/download holds the workspace");
  } finally { lease.release(); }
  const result = await pending;
  await scheduler.drainBackgroundBackups();
  assert.equal(result.verified, true);
  assert.equal(result.committed, true);
  assert.notEqual(result.snapshot, f.backup.snapshot);
});
