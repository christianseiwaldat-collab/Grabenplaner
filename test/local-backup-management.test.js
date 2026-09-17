"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { manage, parseArguments, copyExclusiveFile, RESERVE_BYTES, RECEIPT_RESERVE_BYTES } = require("../scripts/manage-local-backup-archive");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");
const { writeBackupCommitMarker, verifyCommittedBackup } = require("../lib/backup-commit");
const { sha256File } = require("../lib/file-integrity");
const { verifyStandaloneBackupPair } = require("../backup");
const { createAmuStorage, syncEncryptedFilesBackup } = require("../lib/amu-storage");
const project = path.resolve(__dirname, "..");
const unlimited = () => ({ bavail: 100 * 1024 ** 3, bsize: 1 });

function fixture(t, payloadMiB = 0) {
  const temporaryRoot = path.join(project, "tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "local-backup-management-test-"));
  const backups = path.join(directory, "backups"), destination = path.join(directory, "exports"), materialized = path.join(directory, "materialized");
  for (const target of [backups, destination, materialized]) fs.mkdirSync(target);
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(temporaryRoot));
    fs.rmSync(directory, { recursive: true });
  });
  const snapshot = "dienstplan-synthetic-management";
  const databasePath = path.join(materialized, `${snapshot}.db`);
  const database = openSqliteLegacyDatabase(databasePath);
  try {
    database.exec("CREATE TABLE synthetic_backup_payload(value TEXT); INSERT INTO synthetic_backup_payload VALUES('synthetic-only');");
    if (payloadMiB) {
      assert.ok(Number.isSafeInteger(payloadMiB) && payloadMiB > 0 && payloadMiB <= 512);
      const free = fs.statfsSync(directory);
      assert.ok(free.bavail * free.bsize > RESERVE_BYTES + payloadMiB * 8 * 1024 ** 2);
      database.exec("BEGIN");
      const insert = database.prepare("INSERT INTO synthetic_backup_payload(value) VALUES(?)");
      for (let i = 0; i < payloadMiB; i++) insert.run(crypto.randomBytes(1024 ** 2));
      database.exec("COMMIT");
    }
  }
  finally { database.close(); }
  const protectedDirectory = path.join(materialized, `${snapshot}.amu`);
  const protectedSource = path.join(directory, "synthetic-amu-source"), documentKey = crypto.randomBytes(32);
  const documentKeyEncoded = documentKey.toString("base64");
  createAmuStorage({ rootDirectory: protectedSource, encryptionKeys: { synthetic: documentKey }, activeKeyId: "synthetic" });
  documentKey.fill(0);
  const hash = sha256File(databasePath);
  syncEncryptedFilesBackup({ sourceDirectory: protectedSource, targetDirectory: protectedDirectory,
    manifestMetadata: { database: { fileName: `${snapshot}.db`, sha256: hash } } });
  writeBackupCommitMarker({ backupDirectory: materialized, snapshot, databaseSha256: hash });
  const markerPath = path.join(materialized, `${snapshot}.complete.json`);
  const pair = { snapshot, databasePath, protectedDirectory, markerPath, temporaryRoot: materialized };
  const archivedFixture = path.join(directory, "fixture-archive");
  fs.cpSync(materialized, archivedFixture, { recursive: true, errorOnExist: true, force: false });
  const metadata = { snapshot, databaseSha256: hash, databaseBytes: fs.statSync(databasePath).size,
    coupledBytes: [databasePath, markerPath, ...fs.readdirSync(protectedDirectory).map(name => path.join(protectedDirectory, name))
      .filter(file => fs.statSync(file).isFile())].reduce((sum, file) => sum + fs.statSync(file).size, 0),
    createdAt: verifyCommittedBackup(materialized, `${snapshot}.complete.json`).marker.committedAt,
    archived: true, archiveSnapshotId: "b".repeat(64), ignoredSecret: "SYNTHETIC-SECRET" };
  const calls = { cleanup: 0, materialize: 0, initialize: 0, open: [] };
  const archive = {
    initialize: () => { calls.initialize++; return { secret: "SYNTHETIC-SECRET" }; },
    listMetadata: () => [metadata],
    inspect: () => ({ configured: true, retention: 20, retained: 1, archiveBytes: 123, temporaryBytes: 0, secret: "SYNTHETIC-SECRET" }),
    materialize: (_snapshot, { verifyPair }) => {
      calls.materialize++;
      if (!fs.existsSync(databasePath)) {
        for (const entry of fs.readdirSync(archivedFixture)) fs.cpSync(path.join(archivedFixture, entry), path.join(materialized, entry),
          { recursive: true, errorOnExist: true, force: false });
      }
      verifyPair(pair);
      return { ...pair, cleanup() { calls.cleanup++; } };
    },
  };
  const liveDatabase = path.join(directory, "live.db");
  fs.copyFileSync(databasePath, liveDatabase);
  const dependencies = { databasePath: liveDatabase, statfs: unlimited, openArchive: options => { calls.open.push(options); return archive; } };
  return { directory, backups, destination, materialized, snapshot, pair, metadata, archive, calls, dependencies, documentKeyEncoded };
}

test("archive management allows explicit initialization only, all other commands require existing configuration", t => {
  const f = fixture(t);
  for (const args of [[], ["unknown", f.backups], ["list", f.backups, "extra"], ["list", "relative"],
    ["initialize", f.backups, "foreign", "app", "initialize-local-archive"],
    ["initialize", f.backups, "gp-synthetic", "wrong", "initialize-local-archive"],
    ["initialize", f.backups, "gp-synthetic", "app", "yes"],
    ["export", f.backups, "../snapshot", f.destination], ["list", path.parse(f.backups).root]]) assert.throws(() => parseArguments(args));
  assert.equal(f.calls.initialize, 0);
  assert.deepEqual(manage(["initialize", f.backups, "gp-synthetic", "external", "initialize-local-archive"], f.dependencies),
    { ok: true, action: "initialize", configured: true, retention: 20, stream: "external" });
  assert.equal(f.calls.open.at(-1).requireConfigured, false);
  assert.equal(f.calls.initialize, 1);
  for (const action of ["list", "inspect"]) {
    const output = manage([action, f.backups], f.dependencies);
    assert.equal(f.calls.open.at(-1).requireConfigured, true);
    assert.equal(JSON.stringify(output).includes("SYNTHETIC-SECRET"), false);
  }
  assert.equal(f.calls.initialize, 1);
  assert.throws(() => manage(["list", f.backups], { openArchive: () => null }), /sicher/);
});

test("archive export creates a new private verified raw pair without overwriting or activation", t => {
  const f = fixture(t), sentinel = path.join(f.destination, "existing.txt");
  fs.writeFileSync(sentinel, "keep unchanged");
  const verifiedDirectories = [];
  const result = manage(["export", f.backups, f.snapshot, f.destination], { ...f.dependencies,
    verifyPair: pair => { verifiedDirectories.push(path.dirname(pair.databasePath)); verifyStandaloneBackupPair(pair); } });
  assert.equal(result.verified, true);
  assert.equal(result.activated, false);
  assert.equal(path.dirname(result.exportDirectory), f.destination);
  assert.equal(f.calls.cleanup, 1);
  assert.ok(verifiedDirectories.includes(result.exportDirectory), "actual copied SQLite and document references must be verified");
  assert.equal(verifiedDirectories.length, 3);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep unchanged");
  const copied = verifyCommittedBackup(result.exportDirectory, `${f.snapshot}.complete.json`, { verifyPair: verifyStandaloneBackupPair });
  assert.equal(copied.databaseSha256, f.metadata.databaseSha256);
  assert.deepEqual(fs.readdirSync(result.exportDirectory).sort(), [`${f.snapshot}.amu`, `${f.snapshot}.complete.json`, `${f.snapshot}.db`, "export-receipt.json"].sort());
  const receipt = JSON.parse(fs.readFileSync(path.join(result.exportDirectory, "export-receipt.json"), "utf8"));
  assert.equal(receipt.activated, false);
  assert.equal(JSON.stringify(receipt).includes("SYNTHETIC-SECRET"), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(result.exportDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(copied.databasePath).mode & 0o777, 0o600);
    const privateEntries = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        assert.equal(fs.statSync(target).mode & 0o777, entry.isDirectory() ? 0o700 : 0o600, entry.name);
        if (entry.isDirectory()) privateEntries(target);
      }
    };
    privateEntries(result.exportDirectory);
  }
  const again = manage(["export", f.backups, f.snapshot, f.destination], f.dependencies);
  assert.notEqual(again.exportDirectory, result.exportDirectory);
  assert.ok(fs.existsSync(copied.databasePath));
});

test("archive export reserves one pair per volume plus ten GiB and rechecks capacity", t => {
  const f = fixture(t);
  const boundary = RESERVE_BYTES + f.metadata.coupledBytes + RECEIPT_RESERVE_BYTES;
  assert.throws(() => manage(["export", f.backups, f.snapshot, f.destination], { ...f.dependencies,
    statfs: () => ({ bavail: boundary - 1, bsize: 1 }) }), { code: "LOCAL_ARCHIVE_MANAGEMENT_CAPACITY_REQUIRED" });
  assert.equal(f.calls.materialize, 0);
  assert.equal(f.calls.cleanup, 0);
  let checks = 0;
  assert.throws(() => manage(["export", f.backups, f.snapshot, f.destination], { ...f.dependencies,
    statfs: () => ({ bavail: ++checks > 2 ? RESERVE_BYTES : boundary, bsize: 1 }) }), { code: "LOCAL_ARCHIVE_MANAGEMENT_CAPACITY_REQUIRED" });
  assert.equal(f.calls.materialize, 1);
  assert.equal(f.calls.cleanup, 1);
  assert.deepEqual(fs.readdirSync(f.destination), []);
});

test("archive export cleanup runs after copy verification failures without touching existing exports", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.destination, "unrelated.txt"), "keep");
  assert.throws(() => manage(["export", f.backups, f.snapshot, f.destination], { ...f.dependencies,
    verifyPair: pair => {
      if (path.dirname(pair.databasePath) !== f.materialized) throw new Error("synthetic copied-pair failure");
      verifyStandaloneBackupPair(pair);
    } }), /synthetic copied-pair failure/);
  assert.equal(f.calls.cleanup, 1);
  assert.deepEqual(fs.readdirSync(f.destination), ["unrelated.txt"]);
  const originalMaterialize = f.archive.materialize;
  f.archive.materialize = (...args) => ({ ...originalMaterialize(...args), cleanup: () => { f.calls.cleanup++; throw new Error("synthetic cleanup failure"); } });
  assert.throws(() => manage(["export", f.backups, f.snapshot, f.destination], f.dependencies), /synthetic cleanup failure/);
  assert.equal(f.calls.cleanup, 2);
  const completed = fs.readdirSync(f.destination).find(name => name.startsWith("grabenplaner-backup-export-"));
  assert.ok(completed, "verified export remains recoverable if archive temporary cleanup fails");
  assert.ok(fs.existsSync(path.join(f.destination, completed, "export-receipt.json")));
});

test("same-volume export moves the verified inode and does not allocate another database copy", t => {
  const f = fixture(t);
  const original = fs.statSync(f.pair.databasePath);
  let capacityChecks = 0;
  const output = manage(["export", f.backups, f.snapshot, f.destination], { ...f.dependencies,
    statfs: () => ({ bavail: RESERVE_BYTES + RECEIPT_RESERVE_BYTES
      + (++capacityChecks <= 2 ? f.metadata.coupledBytes : 0), bsize: 1 }) });
  const published = fs.statSync(path.join(output.exportDirectory, `${f.snapshot}.db`));
  assert.equal(published.dev, original.dev);
  assert.equal(published.ino, original.ino);
  assert.equal(fs.existsSync(f.pair.databasePath), false);
  assert.equal(verifyCommittedBackup(output.exportDirectory, `${f.snapshot}.complete.json`).databaseSha256, f.metadata.databaseSha256);
});

test("archive export rejects tree overlap, hardlinks and tampered materialization", t => {
  const f = fixture(t);
  for (const destination of [f.backups, f.directory]) assert.throws(() => manage(["export", f.backups, f.snapshot, destination], f.dependencies),
    { code: "LOCAL_ARCHIVE_MANAGEMENT_EXPORT_SCOPE_OVERLAP" });
  const extraLink = path.join(f.directory, "synthetic-hardlink.db");
  fs.linkSync(f.pair.databasePath, extraLink);
  assert.throws(() => manage(["export", f.backups, f.snapshot, f.destination], f.dependencies), { code: "LOCAL_ARCHIVE_MANAGEMENT_LINK_OR_PATH_INVALID" });
  assert.equal(f.calls.cleanup, 1);
  assert.deepEqual(fs.readdirSync(f.destination), []);
  fs.unlinkSync(extraLink);
  f.archive.materialize = () => ({ ...f.pair, databasePath: path.join(f.directory, "wrong.db"), cleanup: () => { f.calls.cleanup++; } });
  assert.throws(() => manage(["export", f.backups, f.snapshot, f.destination], f.dependencies), { code: "LOCAL_ARCHIVE_MANAGEMENT_MATERIALIZATION_MISMATCH" });
  assert.equal(f.calls.cleanup, 2);
  const junction = path.join(f.directory, "destination-link");
  fs.symlinkSync(f.destination, junction, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => manage(["export", f.backups, f.snapshot, junction], f.dependencies), { code: "LOCAL_ARCHIVE_MANAGEMENT_LINK_OR_PATH_INVALID" });
});

test("exclusive export copy hashes with bounded buffers and never overwrites targets", t => {
  const f = fixture(t), source = path.join(f.directory, "synthetic-large.bin"), destination = path.join(f.destination, "copied.bin");
  const bytes = crypto.randomBytes(3 * 1024 * 1024 + 7);
  fs.writeFileSync(source, bytes);
  const result = copyExclusiveFile(source, destination);
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.throws(() => copyExclusiveFile(source, destination), { code: "EEXIST" });
  assert.equal(sha256File(destination), result.sha256);
  const script = fs.readFileSync(path.join(project, "scripts/manage-local-backup-archive.js"), "utf8");
  assert.match(script, /Buffer\.allocUnsafe\(HASH_BUFFER_BYTES\)/);
  assert.doesNotMatch(script, /readFileSync\(/);
  const child = spawnSync(process.execPath, [path.join(project, "scripts/manage-local-backup-archive.js"), "initialize", f.backups,
    "gp-synthetic", "external", "SYNTHETIC-SECRET"], { encoding: "utf8" });
  assert.notEqual(child.status, 0);
  assert.equal(`${child.stdout}${child.stderr}`.includes("SYNTHETIC-SECRET"), false);
});

test("archive crash recovery requires exact confirmations and never runs implicitly", t => {
  const f = fixture(t), token = crypto.randomUUID();
  let reconciliations = 0, releases = 0;
  f.archive.reconcile = ({ confirmation, verifyPair }) => {
    reconciliations++;
    assert.equal(confirmation, "reconcile-local-archive");
    verifyPair(f.pair);
    return { reconciled: true, removedRaw: 0, removedArchives: 0, secretEnvelope: "SYNTHETIC-SECRET" };
  };
  f.archive.releaseStaleLock = ({ expectedToken, confirmation }) => {
    releases++;
    assert.equal(expectedToken, token);
    assert.equal(confirmation, "release-local-archive-lock");
    return { released: true, pendingReconciliationRequired: true, removedRaw: 0, removedArchives: 0, ignored: "SYNTHETIC-SECRET" };
  };
  for (const args of [["reconcile", f.backups], ["reconcile", f.backups, "yes"],
    ["release-stale-lock", f.backups, token, "yes"], ["release-stale-lock", f.backups, "wrong", "release-local-archive-lock"]]) {
    assert.throws(() => manage(args, f.dependencies));
  }
  for (const action of ["list", "inspect"]) manage([action, f.backups], f.dependencies);
  assert.equal(reconciliations, 0);
  assert.equal(releases, 0);
  const repaired = manage(["reconcile", f.backups, "reconcile-local-archive"], f.dependencies);
  assert.deepEqual(repaired, { ok: true, action: "reconcile", reconciled: true, removedRaw: 0, removedArchives: 0 });
  assert.equal(f.calls.open.at(-1).requireConfigured, true);
  const released = manage(["release-stale-lock", f.backups, token, "release-local-archive-lock"], f.dependencies);
  assert.deepEqual(released, { ok: true, action: "release-stale-lock", released: true, pendingReconciliationRequired: true, removedRaw: 0, removedArchives: 0 });
  assert.equal(reconciliations, 1);
  assert.equal(releases, 1);
  f.archive.releaseStaleLock = () => { throw new Error("LOCK_OWNER_STILL_RUNNING"); };
  assert.throws(() => manage(["release-stale-lock", f.backups, token, "release-local-archive-lock"], f.dependencies), /LOCK_OWNER_STILL_RUNNING/);
  let existingArchived = 0;
  for (const entry of fs.readdirSync(f.materialized)) fs.cpSync(path.join(f.materialized, entry), path.join(f.backups, entry),
    { recursive: true, errorOnExist: true, force: false });
  f.archive.archivePair = (snapshot, { verifyPair }) => {
    assert.equal(snapshot, f.snapshot); verifyPair(f.pair); existingArchived++;
    return { archived: true, archiveSnapshotId: "b".repeat(64) };
  };
  let retentions = 0;
  f.archive.maintainRetention = (snapshot, { verifyPair }) => {
    assert.equal(snapshot, f.snapshot); verifyPair(f.pair); retentions++;
    return { retained: 1, removedRaw: 0, removedArchives: 0, latestRawRetained: f.snapshot, unregisteredRawRemoved: 0 };
  };
  assert.throws(() => manage(["archive-existing", f.backups, f.snapshot, "yes"], f.dependencies));
  assert.equal(existingArchived, 0);
  const archived = manage(["archive-existing", f.backups, f.snapshot, "archive-existing-local-backup"], f.dependencies);
  assert.deepEqual(archived, { ok: true, action: "archive-existing", archived: true, snapshot: f.snapshot,
    archiveSnapshotId: "b".repeat(64), retention: 20, retained: 1, rawRetained: true, removedRaw: 0, removedArchives: 0, unregisteredRawRemoved: 0 });
  assert.equal(existingArchived, 1);
  assert.equal(retentions, 1);
  assert.throws(() => manage(["finish-retention", f.backups, f.snapshot, "yes"], f.dependencies));
  const retained = manage(["finish-retention", f.backups, f.snapshot, "finish-local-archive-retention"], f.dependencies);
  assert.deepEqual(retained, { ...archived, action: "finish-retention" });
  assert.equal(existingArchived, 1, "finishing retention must not create another archive point");
  assert.equal(retentions, 2);
  f.archive.listMetadata = () => [{ ...f.metadata, createdAt: new Date(Date.parse(f.metadata.createdAt) + 1000).toISOString() }];
  for (const [action, confirmation] of [["archive-existing", "archive-existing-local-backup"], ["finish-retention", "finish-local-archive-retention"]]) {
    assert.throws(() => manage([action, f.backups, f.snapshot, confirmation], f.dependencies), { code: "LOCAL_ARCHIVE_MANAGEMENT_NEWEST_RAW_POINT_REQUIRED" });
  }
  assert.equal(existingArchived, 1);
  assert.equal(retentions, 2);
  f.archive.listMetadata = () => [f.metadata];
  const newer = "dienstplan-newer-synthetic";
  fs.copyFileSync(f.pair.databasePath, path.join(f.backups, `${newer}.db`));
  syncEncryptedFilesBackup({ sourceDirectory: path.join(f.directory, "synthetic-amu-source"), targetDirectory: path.join(f.backups, `${newer}.amu`),
    manifestMetadata: { database: { fileName: `${newer}.db`, sha256: f.metadata.databaseSha256 } } });
  writeBackupCommitMarker({ backupDirectory: f.backups, snapshot: newer, databaseSha256: f.metadata.databaseSha256,
    committedAt: new Date(Date.parse(f.metadata.createdAt) + 1000).toISOString() });
  assert.throws(() => manage(["archive-existing", f.backups, f.snapshot, "archive-existing-local-backup"], f.dependencies),
    { code: "LOCAL_ARCHIVE_MANAGEMENT_NEWEST_RAW_POINT_REQUIRED" });
  assert.equal(existingArchived, 1);
});

test("optional real Restic management initializes explicitly and exports a verified historical SQLite pair", {
  skip: !process.env.GP_TEST_RESTIC_BINARY || !process.env.GP_TEST_RESTIC_SHA256, timeout: 180000,
}, t => {
  const f = fixture(t, Number(process.env.GP_TEST_WORKSPACE_PAYLOAD_MIB || 0));
  const { openLocalBackupArchiveFromEnvironment } = require("../lib/local-backup-environment");
  const key = crypto.randomBytes(32);
  t.after(() => key.fill(0));
  const environment = { DB_PATH: f.dependencies.databasePath, GRABENPLANER_LOCAL_BACKUP_ARCHIVE: "1", GRABENPLANER_LOCAL_BACKUP_RESTIC: process.env.GP_TEST_RESTIC_BINARY,
    GRABENPLANER_LOCAL_BACKUP_RESTIC_SHA256: process.env.GP_TEST_RESTIC_SHA256,
    GRABENPLANER_INTEGRATION_KEY_ID: "synthetic-management", GRABENPLANER_INTEGRATION_KEY: key.toString("base64"),
    GRABENPLANER_AMU_KEY_ID: "synthetic", GRABENPLANER_AMU_KEY: f.documentKeyEncoded };
  const initialized = manage(["initialize", f.backups, "gp-synthetic-management", "external", "initialize-local-archive"], { environment });
  assert.equal(initialized.configured, true);
  const archive = openLocalBackupArchiveFromEnvironment({ backupDirectory: f.backups, environment });
  for (const entry of fs.readdirSync(f.materialized)) fs.cpSync(path.join(f.materialized, entry), path.join(f.backups, entry), { recursive: true, errorOnExist: true, force: false });
  archive.archivePair(f.snapshot, { verifyPair: verifyStandaloneBackupPair });
  assert.equal(manage(["list", f.backups], { environment }).count, 1);
  assert.throws(() => manage(["export", f.backups, f.snapshot, f.destination], {
    environment: { ...environment, GRABENPLANER_AMU_KEY: crypto.randomBytes(32).toString("base64") },
  }), /PAIR_VERIFICATION_FAILED|Wiederherstellungsschluessel|BACKUP_RECOVERY_KEYS_UNVERIFIED/);
  assert.deepEqual(fs.readdirSync(f.destination), [], "unavailable recovery keys cannot produce a claimed verified export");
  const verifiedFiles = [], exportStarted = performance.now();
  const output = manage(["export", f.backups, f.snapshot, f.destination], { environment,
    verifyPair: (pair, marker, options) => {
      const result = verifyStandaloneBackupPair(pair, marker, options);
      const stat = fs.statSync(pair.databasePath);
      verifiedFiles.push({ dev: stat.dev, ino: stat.ino, bytes: stat.size });
      return result;
    },
  });
  assert.equal(output.verified, true);
  assert.ok(verifiedFiles.length >= 2);
  assert.deepEqual(verifiedFiles.at(-1), verifiedFiles[0], "the restored database itself becomes the export, without another full copy");
  t.diagnostic(JSON.stringify({ syntheticOnly: true, databaseBytes: verifiedFiles[0].bytes,
    duplicateExportDatabaseBytes: 0, sameFileIdentity: true, exportMs: Math.round(performance.now() - exportStarted) }));
  const copied = verifyCommittedBackup(output.exportDirectory, `${f.snapshot}.complete.json`, { verifyPair: verifyStandaloneBackupPair });
  assert.equal(copied.databaseSha256, f.metadata.databaseSha256);
  assert.equal(archive.inspect().temporaryBytes, 0);
  assert.equal(manage(["reconcile", f.backups, "reconcile-local-archive"], { environment }).reconciled, false);
  assert.ok(fs.existsSync(path.join(f.backups, ".gp-local-archive/recovery-envelope.json")));
});
