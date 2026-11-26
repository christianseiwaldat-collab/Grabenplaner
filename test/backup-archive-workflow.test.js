"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { prepareLocalBackupArchive, archivePublishedBackup } = require("../lib/backup-archive-workflow");

const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function serverFunction(name, next, dependencies) {
  const index = serverSource.indexOf(`function ${name}(`);
  const start = serverSource.slice(index - 6, index) === "async " ? index - 6 : index;
  const end = serverSource.indexOf(next, index);
  assert.ok(index >= 0 && end > index, `Missing exact server-function boundary: ${name}`);
  const source = serverSource.slice(start, end);
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

test("PostgreSQL never publishes a successful SQLite lifecycle backup", async () => {
  const dependencies = { postgresqlActive: true, lastBackup: null };
  const create = serverFunction("createDatabaseBackup", "const startupSchemaMigrationState", dependencies);
  await assert.rejects(create("shutdown-signal"), { code: "PG_PAIRED_BACKUP_REQUIRED" });
  assert.equal(dependencies.lastBackup, null);
});
