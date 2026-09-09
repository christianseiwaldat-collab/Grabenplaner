"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
const { verifyCommittedBackup, writeBackupCommitMarker } = require("../lib/backup-commit");
const { sha256File } = require("../lib/file-integrity");
const { prepareLocalBackupArchive, archivePublishedBackup } = require("../lib/backup-archive-workflow");
const { withBackupWorkspace, MAX_WAIT_MS: BACKUP_WORKSPACE_MAX_WAIT_MS } = require("../lib/backup-workspace");

const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function serverFunction(name, next, dependencies) {
  const index = serverSource.indexOf(`function ${name}(`);
  const start = serverSource.slice(index - 6, index) === "async " ? index - 6 : index;
  const source = serverSource.slice(start, serverSource.indexOf(next, index));
  return vm.runInNewContext(`${source}; ${name}`, dependencies);
}

test("archive workflow preserves twenty daily points and requires a published verified receipt before retention", () => {
  const environment = { GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1", GRABENPLANER_LOCAL_BACKUP_RESTIC: path.resolve("test-restic"), GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256: "a".repeat(64) };
  const vault = { seal() {}, useSecretSync() {} }, archiveFactory = () => ({ configured: () => true });
  assert.throws(() => prepareLocalBackupArchive({ backupDirectory: path.resolve("no-write"), keep: 29, environment, vault, archiveFactory }), /RETENTION_REQUIRES_20_DAYS/);
  let retained = false;
  assert.throws(() => archivePublishedBackup({ archivePair: () => ({}), maintainRetention() { retained = true; } }, "dienstplan-test", () => {}), /RECEIPT_INVALID/);
  assert.equal(retained, false);
  const verifier = () => {}, events = [];
  const result = archivePublishedBackup({ archivePair(snapshot, options) {
    events.push("archive"); assert.equal(options.verifyPair, verifier);
    return { archived: true, archiveSnapshotId: "a".repeat(64) };
  }, maintainRetention(snapshot, options) {
    events.push("retention"); assert.equal(options.verifyPair, verifier);
    return { retained: 20, removedArchives: 1, removedRaw: 1 };
  } }, "dienstplan-test", verifier);
  assert.deepEqual(events, ["archive", "retention"]);
  assert.equal(result.retained, 20);
});

test("app forbids synchronous archive work and preserves a pre-listen raw safety pair without pruning", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-app-archive-workflow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "source.db"), amuStorageDirectory = path.join(root, "protected");
  fs.writeFileSync(databasePath, "synthetic database bytes");
  createAmuStorage({ rootDirectory: amuStorageDirectory, encryptionKeys: { fixture: crypto.randomBytes(32) }, activeKeyId: "fixture" });
  const backupDirectory = path.join(root, "backups");
  let pruned = false;
  const dependencies = { fs, path, crypto, databasePath, amuStorageDirectory, amuStorage: {}, amuMutationInProgress: 0,
    withBackupWorkspace, BACKUP_WORKSPACE_MAX_WAIT_MS,
    backupKeep: 20, integrationSecretVault: {}, prepareLocalBackupArchive: () => ({ preflightBackup() {} }),
    verifyActiveProtectedDocumentBlobsForBackup() {}, backupTimestamp: () => "2026-09-06T12-00-00Z",
    sqliteMaintenanceOperations: { vacuumInto: destination => fs.copyFileSync(databasePath, destination) },
    verifyDatabaseFile: () => ({ ok: true }), fileSha256: sha256File, syncEncryptedFilesBackup,
    verifyProtectedBackupPair() {}, verifyBackupPairPaths() {}, verifyArchivedBackupPair() {},
    writeBackupCommitMarker, verifyCommittedBackup, safeRemoveFile: file => fs.rmSync(file, { force: true }),
    archivePublishedBackup() { throw new Error("injected archive failure"); }, pruneDatabaseBackups() { pruned = true; } };
  const create = serverFunction("createDatabaseBackupToDirectory", "function createInternalDatabaseBackup", dependencies);
  assert.throws(() => create(backupDirectory), /BACKGROUND_REQUIRED/);
  assert.equal(fs.existsSync(backupDirectory), false);
  const result = create(backupDirectory, "pre-migration", "app", { beforeListen: true });
  assert.equal(result.archive.archived, false);
  assert.equal(result.archive.rawSafetyPointRetained, true);
  const markers = fs.readdirSync(backupDirectory).filter(file => file.endsWith(".complete.json"));
  assert.equal(markers.length, 1);
  assert.equal(verifyCommittedBackup(backupDirectory, markers[0]).committed, true);
  assert.equal(pruned, false);
  assert.equal(fs.readdirSync(backupDirectory).some(file => file.includes(".partial-")), false);
  const blockedDirectory = path.join(root, "blocked");
  const blocked = serverFunction("createDatabaseBackupToDirectory", "function createInternalDatabaseBackup", {
    ...dependencies, prepareLocalBackupArchive() { throw new Error("invalid archive configuration"); },
  });
  assert.throws(() => blocked(blockedDirectory), /invalid archive configuration/);
  assert.equal(fs.existsSync(blockedDirectory), false);
});

test("backup health reads cached authenticated archive points without inventing a raw path and surfaces invalid history", () => {
  let cached = false;
  const dependencies = { path, backupKeep: 20, integrationSecretVault: {},
    prepareLocalBackupArchive: input => { assert.equal(input.cachedMetadataOnly, true); return { listMetadata(options) {
      cached = options.verifyInventory === false;
      return [{ databaseFileName: "dienstplan-archived.db", modifiedMs: 123, modifiedAt: "2026-09-06", archived: true,
        archiveSnapshotId: "b".repeat(64), committed: true, verified: true }];
    } }; }, listCommittedBackupMetadata: () => [], listLegacyBackupMetadata: () => [] };
  const latest = serverFunction("latestDatabaseBackup", "const BACKUP_FUTURE_TOLERANCE_MS", dependencies);
  const point = latest(path.resolve("no-write"));
  assert.equal(cached, true);
  assert.equal(point.name, "dienstplan-archived.db");
  assert.equal(point.path, null);
  assert.equal(point.marker, null);
  assert.equal(point.archived, true);
  assert.equal(point.verificationCached, true);
  const failed = serverFunction("latestDatabaseBackup", "const BACKUP_FUTURE_TOLERANCE_MS", { ...dependencies,
    prepareLocalBackupArchive() { throw new Error("history invalid"); } });
  let reported = false;
  assert.equal(failed(path.resolve("no-write"), () => { reported = true; }), null);
  assert.equal(reported, true);
  const rawDespiteArchiveError = serverFunction("latestDatabaseBackup", "const BACKUP_FUTURE_TOLERANCE_MS", { ...dependencies,
    prepareLocalBackupArchive() { throw new Error("archive locked"); },
    listCommittedBackupMetadata: () => [{ databasePath: path.resolve("dienstplan-current.db"), modifiedMs: 1000, committed: true, verified: true }],
  });
  const raw = rawDespiteArchiveError(path.resolve("no-write"));
  assert.equal(raw.committed, true);
  assert.equal(raw.archiveNeedsReview, true);
  assert.equal(raw.archived, false);
});

test("app and external backup share one deadline and publish success only after both awaited points", async () => {
  const calls = [], releases = [];
  const dependencies = { tableExists: () => true, getSettings: () => ({}), serverModeActive: false,
    appBackupDirectory: "app", backupDirectoryFromSettings: () => "external", lastBackup: null,
    createDatabaseBackupInBackground: (directory, reason, kind, options) => {
      calls.push({ directory, reason, kind, deadlineMs: options.deadlineMs });
      return new Promise(resolve => releases.push(() => resolve({ path: directory })));
    } };
  const create = serverFunction("createDatabaseBackup", "function createSchema", dependencies);
  const resultPromise = create("fixture", { deadlineMs: 1234567890 });
  assert.equal(calls.length, 1);
  assert.equal(dependencies.lastBackup, null);
  releases.shift()();
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(dependencies.lastBackup, null);
  assert.deepEqual(calls.map(call => call.deadlineMs), [1234567890, 1234567890]);
  assert.deepEqual(calls.map(call => call.kind), ["app", "external"]);
  releases.shift()();
  const result = await resultPromise;
  assert.equal(result.path, "external");
  assert.equal(dependencies.lastBackup, result);
});

test("server forwards existing recovery keys and the shared deadline only to the protected child environment", async () => {
  let received;
  const dependencies = { localBackupArchiveEnabled: () => true, shutdownStarted: false,
    databasePath: "database", fs: { existsSync: () => true }, amuStorage: {}, amuStorageDirectory: "documents",
    backupKeep: 20, integrationSecretVault: {}, prepareLocalBackupArchive() {}, process: { env: { FIXTURE: "yes" } },
    integrationEncryptionConfiguration: { keyId: "vault", keys: { vault: "existing-vault-key" } },
    amuEncryptionConfiguration: { keyId: "amu", key: "existing-amu-key" },
    require: name => { assert.equal(name, "./lib/background-backup-process"); return { createBackgroundBackup: async input => {
      received = input; return { protectedDirectory: "paired-documents" };
    } }; } };
  const create = serverFunction("createDatabaseBackupInBackground", "function createExternalDatabaseBackup", dependencies);
  const result = await create("backups", "fixture", "app", { deadlineMs: 1234567890 });
  assert.equal(received.deadlineMs, 1234567890);
  assert.equal(received.environment.GRABENPLANER_AMU_KEY, "existing-amu-key");
  assert.equal(received.environment.GRABENPLANER_INTEGRATION_KEYS, JSON.stringify({ vault: "existing-vault-key" }));
  assert.equal(result.verified, true);
  dependencies.shutdownStarted = true;
  await assert.rejects(create("backups", "scheduled", "app"), { code: "BACKGROUND_BACKUP_SHUTDOWN_IN_PROGRESS" });
  await create("backups", "shutdown-signal", "app");
});

test("shutdown shares one deadline with drain and does not release the instance when child termination is unverified", async () => {
  for (const code of [null, "BACKGROUND_BACKUP_TREE_UNVERIFIED", "BACKGROUND_BACKUP_ARCHIVE_RECOVERY_REQUIRED"]) {
    const events = [], deadlines = [];
    const dependencies = { shutdownStarted: false, server: null, databaseClosed: false, maintenanceOwnsLifecycleBackup: () => false,
      salesReportJobs: { stop: async () => {} },
      backupInterval: null, retentionInterval: null, scannerProbeInterval: null, sicknessSweepInterval: null,
      notificationDispatchInterval: null, rateLimitCleanupInterval: null, systemCenterHealthInterval: null,
      localBackupArchiveEnabled: () => true, console: { error() {} }, setInterval: () => events.push("recovery-wait"),
      require: () => ({ drainBackgroundBackups: async options => {
        events.push("drain"); deadlines.push(options.deadlineMs);
        if (code) throw Object.assign(new Error("fixture"), { code });
      } }), createDatabaseBackup: async (reason, options) => {
        assert.equal(reason, "shutdown-signal"); events.push("backup"); deadlines.push(options.deadlineMs);
      }, persistenceProvider: { close: async () => events.push("provider-close") },
      sqliteMaintenanceOperations: { checkpointWal: () => events.push("checkpoint") }, db: { close: () => events.push("db-close") },
      releaseInstanceLock: () => events.push("release"), process: { exit: value => events.push(`exit-${value}`) } };
    const stop = serverFunction("shutdown", "if (require.main === module)", dependencies);
    stop();
    await new Promise(setImmediate);
    if (code === "BACKGROUND_BACKUP_TREE_UNVERIFIED") {
      assert.deepEqual(events, ["drain", "recovery-wait"]);
      assert.equal(dependencies.databaseClosed, false);
    } else {
      assert.equal(events.at(-1), code ? "exit-1" : "exit-0");
      assert.equal(dependencies.databaseClosed, true);
      if (!code) assert.equal(deadlines[0], deadlines[1]);
    }
  }
});
