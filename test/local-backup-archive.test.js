"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createLocalBackupArchive, TIMEOUT_MS } = require("../lib/local-backup-archive");
const { createIntegrationSecretVault } = require("../lib/integration-secret-vault");
const { writeBackupCommitMarker } = require("../lib/backup-commit");
const { sha256File } = require("../lib/file-integrity");
const project = path.resolve(__dirname, "..");
const binary = path.join(project, "tmp/backup-restic-tools-20260906/bin/restic_0.18.1_windows_amd64.exe");
const binarySha256 = "034b7bf67a23049d30d58ddf4fb318239726cc74728b80bff876de824f2fc786";
const available = process.platform === "win32" && fs.existsSync(binary);

function fixture(t) {
  const tmp = path.join(project, "tmp"); fs.mkdirSync(tmp, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tmp, "local-backup-archive-test-"));
  const key = crypto.randomBytes(32);
  const vault = createIntegrationSecretVault({ activeKeyId: "synthetic", resolveKey: id => id === "synthetic" ? key : null });
  const options = { backupDirectory: directory, binary, binarySha256, vault, minimumFreeBytes: 0, clock: () => new Date("2026-10-02T20:00:00Z") };
  t.after(() => {
    key.fill(0);
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(tmp));
    fs.rmSync(directory, { recursive: true });
  });
  return { directory, options, vault, archive: createLocalBackupArchive(options) };
}
function pair(directory, index) {
  const snapshot = `dienstplan-synthetic-${String(index).padStart(3, "0")}`;
  const contents = Buffer.concat([Buffer.from(`synthetic-point-${index}\n`), crypto.randomBytes(32 * 1024)]);
  const databasePath = path.join(directory, `${snapshot}.db`);
  fs.writeFileSync(databasePath, contents, { flag: "wx" });
  const protectedDirectory = path.join(directory, `${snapshot}.amu`); fs.mkdirSync(protectedDirectory);
  const hash = sha256File(databasePath);
  fs.writeFileSync(path.join(protectedDirectory, "manifest.json"), JSON.stringify({ database: { fileName: `${snapshot}.db`, sha256: hash }, files: [] }), { flag: "wx" });
  writeBackupCommitMarker({ backupDirectory: directory, snapshot, databaseSha256: hash,
    committedAt: new Date(Date.UTC(2026, 8, 1 + index, 12)).toISOString() });
  return { snapshot, hash, databasePath };
}
const verifyPair = metadata => {
  assert.match(fs.readFileSync(metadata.databasePath).subarray(0, 25).toString(), /^synthetic-point-/);
};

function observedArchive(options, beforeCommand) {
  const file = path.join(project, "lib/local-backup-archive.js"), localRequire = createRequire(file), exported = { exports: {} };
  const childProcess = require("node:child_process");
  vm.runInThisContext(`(function(require, module, exports) { ${fs.readFileSync(file, "utf8")}\n})`, { filename: file })(
    name => name === "node:child_process" ? { ...childProcess, spawnSync(binary, args, config) {
      const result = beforeCommand(args.slice(7));
      return result || childProcess.spawnSync(binary, args, config);
    } } : localRequire(name), exported, exported.exports);
  return exported.exports.createLocalBackupArchive(options);
}

test("real optimized backup proves recovery once, reads all archive data once, and keeps the exact rollback pair", { skip: !available, timeout: 90000 }, t => {
  const f = fixture(t), commands = [];
  const archive = observedArchive(f.options, command => { commands.push(command); });
  archive.initialize({ host: "gp-synthetic-test", stream: "app", confirmation: "initialize-local-archive" });
  const first = pair(f.directory, 30);
  archive.archivePair(first.snapshot, { verifyPair });
  archive.maintainRetention(first.snapshot, { verifyPair });
  const latest = pair(f.directory, 31);
  commands.length = 0;
  archive.preflightBackup();
  archive.archivePair(latest.snapshot, { verifyPair });
  const retention = archive.maintainRetention(latest.snapshot, { verifyPair });
  assert.equal(commands.filter(c => c[0] === "restore").length, 1);
  assert.equal(commands.filter(c => c[0] === "check" && c.includes("--read-data")).length, 1);
  assert.equal(commands.filter(c => c[0] === "check" && !c.includes("--read-data")).length, 2);
  assert.equal(retention.removedRaw, 1);
  assert.equal(fs.existsSync(first.databasePath), false);
  assert.equal(sha256File(latest.databasePath), latest.hash);
  const recovered = archive.materialize(first.snapshot, { verifyPair });
  assert.equal(sha256File(recovered.databasePath), first.hash);
  recovered.cleanup();
});

test("a post-prune structure failure preserves every raw fallback and blocks new backup retries", { skip: !available, timeout: 90000 }, t => {
  const f = fixture(t); let rejectAfterPrune = false, pruned = false;
  const archive = observedArchive(f.options, command => {
    if (command[0] === "prune") pruned = true;
    if (rejectAfterPrune && pruned && command[0] === "check") return { status: 1, stdout: "", stderr: "synthetic failure" };
  });
  archive.initialize({ host: "gp-synthetic-test", stream: "app", confirmation: "initialize-local-archive" });
  const first = pair(f.directory, 30), latest = pair(f.directory, 31);
  archive.archivePair(first.snapshot, { verifyPair }); archive.archivePair(latest.snapshot, { verifyPair });
  rejectAfterPrune = true;
  assert.throws(() => archive.maintainRetention(latest.snapshot, { verifyPair }), /CHECK_FAILED/);
  assert.equal(fs.existsSync(first.databasePath), true); assert.equal(fs.existsSync(latest.databasePath), true);
  assert.throws(() => archive.preflightBackup(), /PENDING_RECONCILIATION_REQUIRED/);
  rejectAfterPrune = false;
  archive.reconcile({ confirmation: "reconcile-local-archive", verifyPair });
  const retention = archive.maintainRetention(latest.snapshot, { verifyPair });
  assert.equal(retention.removedRaw, 1);
});

test("local archive fixed subprocess and independent verification contracts", () => {
  assert.equal(TIMEOUT_MS, 1500000);
  const source = fs.readFileSync(path.join(project, "lib/local-backup-archive.js"), "utf8");
  assert.match(source, /shell: false/);
  assert.match(source, /sha256File\(executable\)/);
  assert.match(source, /"restore", r\.archiveSnapshotId, "--target", target, "--verify"/);
  assert.match(source, /"check", "--read-data"/);
  assert.doesNotMatch(source, /env:\s*process\.env|\.\.\.process\.env|unlock|--password-command|--remove-all/);
});

test("real local archive: 32 independently verified points, exactly 20 retained, authenticated recovery", { skip: !available, timeout: 600000 }, async t => {
  const f = fixture(t), archive = f.archive, state = path.join(f.directory, ".gp-local-archive");
  assert.equal(archive.configured(), false);
  assert.equal(fs.existsSync(state), false, "construction must not initialize storage");
  assert.throws(() => archive.initialize({ host: "gp-test", stream: "app" }), /EXPLICIT_INITIALIZATION_REQUIRED/);
  assert.throws(() => archive.initialize({ host: "foreign", stream: "app", confirmation: "initialize-local-archive" }), /SCOPE_INVALID/);
  const old = { RESTIC_REPOSITORY: process.env.RESTIC_REPOSITORY, RESTIC_PASSWORD_COMMAND: process.env.RESTIC_PASSWORD_COMMAND };
  process.env.RESTIC_REPOSITORY = "sftp:foreign-host:/never";
  process.env.RESTIC_PASSWORD_COMMAND = "a-command-that-must-never-execute";
  try {
  const initialized = archive.initialize({ host: "gp-synthetic-test", stream: "app", confirmation: "initialize-local-archive" });
    assert.match(initialized.repositoryId, /^[a-f0-9]{64}$/);
    assert.equal(archive.configured(), true);
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const envelope = JSON.parse(fs.readFileSync(path.join(state, "recovery-envelope.json")));
  assert.throws(() => createLocalBackupArchive({ ...f.options, expectedStream: "external" }).configured(), /EXPECTED_STREAM_MISMATCH/);
  assert.match(envelope.secretEnvelope, /^gp-integration-secret:v1:/);
  assert.equal(path.dirname(path.join(state, "recovery-envelope.json")), state);
  assert.throws(() => archive.initialize({ host: "gp-synthetic-test", stream: "app", confirmation: "initialize-local-archive" }), /ALREADY_EXISTS/);
  const legacy = pair(f.directory, 99), points = [];
  let calls = 0;
  for (let i = 0; i < 32; i++) {
    const p = pair(f.directory, i); points.push(p);
    const result = archive.archivePair(p.snapshot, { verifyPair(metadata) { calls++; verifyPair(metadata); } });
    assert.equal(result.databaseSha256, p.hash);
    assert.equal(result.archived, true);
    assert.equal(result.databasePath, undefined, "metadata must not masquerade as a materialized raw path");
    assert.ok(fs.existsSync(p.databasePath), "archive publication keeps all raw pairs");
  }
  assert.equal(calls, 96, "source, independent restored pair and source recheck for each point");
  const before = archive.listMetadata(); assert.equal(before.length, 32);
  assert.throws(() => archive.listMetadata({ verifyInventory: false }), /ACTIVE_RECEIPT_WINDOW_EXCEEDED/);
  assert.equal(archive.archivePair(points[0].snapshot, { verifyPair }).archiveSnapshotId,
    before.find(p => p.snapshot === points[0].snapshot).archiveSnapshotId, "same immutable point is idempotent");
  assert.throws(() => archive.materialize("../../unrelated", { verifyPair }), /SNAPSHOT_INVALID/);
  // Simulate an interruption after exact snapshot forgetting, before receipt
  // retirement. Reconciliation may repair receipts, never delete more data.
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (path.dirname(source) === path.join(state, "receipts") && path.dirname(target) === path.join(state, "retired")) {
      throw new Error("synthetic-retirement-interruption");
    }
    return rename(source, target);
  };
  try { assert.throws(() => archive.maintainRetention(points[31].snapshot, { verifyPair }), /synthetic-retirement-interruption/); }
  finally { fs.renameSync = rename; }
  assert.throws(() => archive.listMetadata(), /PENDING_RECONCILIATION_REQUIRED/);
  const reconciled = archive.reconcile({ confirmation: "reconcile-local-archive", verifyPair });
  assert.equal(reconciled.retiredReceipts, 12); assert.equal(reconciled.removedRaw, 0); assert.equal(reconciled.removedArchives, 0);
  assert.ok(points.every(p => fs.existsSync(p.databasePath)), "reconciliation never removes raw pairs");
  let rawPasses = 0;
  assert.throws(() => archive.maintainRetention(points[31].snapshot, { verifyPair(metadata) {
    verifyPair(metadata);
    // Active receipts are visited before retired ones. Reject the first raw
    // deletion candidate; the independent test above rejects the post-prune
    // structural proof itself before any candidate can be deleted.
    if (metadata.databasePath === points[12].databasePath && ++rawPasses === 2) throw new Error("synthetic-post-prune-rejection");
  } }), /synthetic-post-prune-rejection/);
  assert.ok(points.every(p => fs.existsSync(p.databasePath)), "post-prune proof failure must preserve every raw fallback");
  assert.equal(archive.reconcile({ confirmation: "reconcile-local-archive", verifyPair }).removedRaw, 0);
  const retention = archive.maintainRetention(points[31].snapshot, { verifyPair });
  assert.deepEqual(retention, { retained: 20, removedArchives: 0, removedRaw: 31,
    latestRawRetained: points[31].snapshot, unregisteredRawRemoved: 0 });
  assert.ok(fs.existsSync(legacy.databasePath), "unregistered legacy pair must survive");
  assert.ok(fs.existsSync(points[31].databasePath), "newest raw pair remains updater/offsite compatible");
  assert.equal(fs.existsSync(points[12].databasePath), false);
  const retained = archive.listMetadata(); assert.equal(retained.length, 20);
  assert.equal(fs.readdirSync(path.join(state, "retired")).length, 12);
  const restored = archive.materialize(points[12].snapshot, { verifyPair });
  assert.equal(sha256File(restored.databasePath), points[12].hash);
  const temporaryRoot = restored.temporaryRoot; restored.cleanup(); restored.cleanup();
  assert.equal(fs.existsSync(temporaryRoot), false);
  assert.throws(() => archive.materialize(points[0].snapshot, { verifyPair }), /SNAPSHOT_NOT_FOUND/);
  const status = archive.inspect(); assert.equal(status.retained, 20); assert.equal(status.temporaryBytes, 0);
  assert.equal(status.host, "gp-synthetic-test");

  await t.test("wrong existing vault key, forged receipt and stale lock fail closed", () => {
    const wrongVault = createIntegrationSecretVault({ activeKeyId: "synthetic", keys: { synthetic: Buffer.alloc(32) } });
    assert.throws(() => createLocalBackupArchive({ ...f.options, vault: wrongVault }).configured(), /beschädigt|vertauscht|Schlüssel/);
    const receiptPath = path.join(state, "receipts", `${points[12].snapshot}.json`);
    const original = fs.readFileSync(receiptPath); const altered = JSON.parse(original);
    altered.payload.marker.database.bytes += 1; fs.writeFileSync(receiptPath, JSON.stringify(altered));
    assert.throws(() => archive.listMetadata(), /AUTHENTICATION_FAILED/);
    assert.throws(() => archive.maintainRetention(points[31].snapshot, { verifyPair }), /AUTHENTICATION_FAILED/);
    assert.ok(fs.existsSync(points[31].databasePath)); fs.writeFileSync(receiptPath, original);
    const lock = path.join(state, "operation.lock"); fs.writeFileSync(lock, "stale", { flag: "wx" });
    assert.throws(() => archive.listMetadata(), /LOCKED_REQUIRES_REVIEW/);
    assert.equal(fs.readFileSync(lock, "utf8"), "stale"); fs.unlinkSync(lock);
  });

  await t.test("recovery works from the protected external envelope and archive, no original raw pair required", () => {
    const reopened = createLocalBackupArchive({ ...f.options, vault: f.vault });
    const r = reopened.materialize(points[13].snapshot, { verifyPair });
    assert.equal(sha256File(r.databasePath), points[13].hash); r.cleanup();
  });

  await t.test("cached metadata reads no repository files and retired snapshot names cannot be reused", () => {
    const repo = path.join(state, "repository"), hidden = path.join(f.directory, "synthetic-hidden-repository");
    fs.renameSync(repo, hidden); fs.mkdirSync(repo);
    try {
      const cached = archive.listMetadata({ verifyInventory: false });
      assert.equal(cached.length, 20); assert.ok(cached.every(r => r.verificationCached === true));
      assert.throws(() => archive.listMetadata(), /CAT_FAILED/);
    } finally { fs.rmdirSync(repo); fs.renameSync(hidden, repo); }
    pair(f.directory, 0);
    assert.throws(() => archive.archivePair(points[0].snapshot, { verifyPair }), /RETIRED_SNAPSHOT_NAME_REUSED/);
    const older = pair(f.directory, -1);
    assert.throws(() => archive.archivePair(older.snapshot, { verifyPair }), /OLDER_RAW_POINT_CANNOT_DISPLACE_NEWER/);
    const readDirectory = fs.readdirSync;
    fs.readdirSync = (directory, ...args) => {
      if (directory === path.join(state, "retired")) throw new Error("synthetic-retired-fullscan-forbidden");
      return readDirectory(directory, ...args);
    };
    try {
      assert.equal(archive.listMetadata({ verifyInventory: false }).length, 20);
      assert.equal(archive.listMetadata().length, 20);
      assert.throws(() => archive.inspect({ auditRetired: true }), /synthetic-retired-fullscan-forbidden/);
    } finally { fs.readdirSync = readDirectory; }
    assert.deepEqual(archive.inspect({ auditRetired: true }).retiredAudit, { verified: true, receipts: 12 });
  });

});

// This needs its own fixture. The retired-name test above deliberately leaves
// a changed raw pair, which must not mask the repository-corruption failure.
test("corrupt repository data blocks pruning and future retries without deleting either raw pair", { skip: !available, timeout: 60000 }, t => {
  const f = fixture(t), archive = f.archive;
  archive.initialize({ host: "gp-synthetic-test", stream: "app", confirmation: "initialize-local-archive" });
  const first = pair(f.directory, 0), latest = pair(f.directory, 31);
  archive.archivePair(first.snapshot, { verifyPair }); archive.archivePair(latest.snapshot, { verifyPair });
  const data = path.join(f.directory, ".gp-local-archive", "repository", "data");
  const sub = fs.readdirSync(data).find(p => fs.readdirSync(path.join(data, p)).length);
  const file = path.join(data, sub, fs.readdirSync(path.join(data, sub))[0]);
  const fd = fs.openSync(file, "r+"), byte = Buffer.alloc(1);
  try { fs.readSync(fd, byte, 0, 1, 0); byte[0] ^= 1; fs.writeSync(fd, byte, 0, 1, 0); } finally { fs.closeSync(fd); }
  assert.throws(() => archive.maintainRetention(latest.snapshot, { verifyPair }), /CHECK_FAILED/);
  assert.throws(() => archive.preflightBackup(), /PENDING_RECONCILIATION_REQUIRED/);
  assert.equal(fs.existsSync(first.databasePath), true); assert.equal(fs.existsSync(latest.databasePath), true);
  const state = path.join(f.directory, ".gp-local-archive");
  assert.equal(fs.readdirSync(path.join(state, "receipts")).length, 2, "full-read failure precedes forgetting the expired point");
  assert.equal(fs.readdirSync(path.join(state, "retired")).length, 0);
});

test("local archive refuses untrusted executable, hardlinked input and incomplete publication", { skip: !available, timeout: 60000 }, t => {
  const f = fixture(t), state = path.join(f.directory, ".gp-local-archive");
  assert.throws(() => createLocalBackupArchive({ ...f.options, binarySha256: "0".repeat(64) }), /BINARY_HASH_MISMATCH/);
  assert.throws(() => createLocalBackupArchive({ ...f.options, backupDirectory: path.parse(f.directory).root }), /ROOT_PATH_FORBIDDEN/);
  assert.throws(() => createLocalBackupArchive({ ...f.options, vault: null }), /EXISTING_VAULT_REQUIRED/);
  assert.throws(() => createLocalBackupArchive({ ...f.options, minimumFreeBytes: Number.MAX_SAFE_INTEGER }).initialize({
    host: "gp-test", stream: "external", confirmation: "initialize-local-archive" }), /CAPACITY_REQUIRED/);
  const brokenVault = createIntegrationSecretVault({ activeKeyId: "missing", resolveKey: () => null });
  assert.throws(() => createLocalBackupArchive({ ...f.options, vault: brokenVault }).initialize({
    host: "gp-test", stream: "external", confirmation: "initialize-local-archive" }), /Schlüssel/);
  assert.equal(fs.existsSync(state), false, "missing preexisting key cannot create a repository");
  f.archive.initialize({ host: "gp-test", stream: "external", confirmation: "initialize-local-archive" });
  const p = pair(f.directory, 0);
  const link = path.join(f.directory, "synthetic-hardlink.db"); fs.linkSync(p.databasePath, link);
  assert.throws(() => f.archive.archivePair(p.snapshot, { verifyPair }), /LINK_OR_SPECIAL_PATH/);
  fs.unlinkSync(link);
  assert.throws(() => f.archive.archivePair(p.snapshot), /PAIR_VERIFIER_REQUIRED/);
  let calls = 0;
  assert.throws(() => f.archive.archivePair(p.snapshot, { verifyPair(metadata) {
    verifyPair(metadata); if (++calls === 2) throw new Error("independent-restore-rejected");
  } }), /independent-restore-rejected/);
  assert.equal(fs.readdirSync(path.join(state, "receipts")).length, 0, "failed independent restore cannot publish a receipt");
  assert.ok(fs.existsSync(path.join(state, "recovery-envelope.json")), "protected recovery secret is never discarded");
  assert.ok(fs.existsSync(p.databasePath), "failed publication must preserve raw pair");
  assert.throws(() => f.archive.listMetadata(), /PENDING_RECONCILIATION_REQUIRED/);
  assert.throws(() => f.archive.preflightBackup(), /PENDING_RECONCILIATION_REQUIRED/);
  assert.throws(() => f.archive.archivePair(p.snapshot, { verifyPair }), /PENDING_RECONCILIATION_REQUIRED/);
  assert.throws(() => f.archive.maintainRetention(p.snapshot, { verifyPair }), /PENDING_RECONCILIATION_REQUIRED/);
  assert.equal(fs.readdirSync(path.join(state, "temporary")).length, 0);
  assert.throws(() => f.archive.reconcile({ verifyPair }), /EXPLICIT_RECONCILIATION_REQUIRED/);
  const recovered = f.archive.reconcile({ confirmation: "reconcile-local-archive", verifyPair });
  assert.equal(recovered.outcome, "verified-receipt-published"); assert.equal(recovered.removedRaw, 0);
  assert.equal(f.archive.listMetadata().length, 1);
  assert.ok(fs.existsSync(p.databasePath));
});

test("local archive journal safely aborts zero-snapshot attempts and only releases authenticated dead-process locks", { skip: !available, timeout: 60000 }, t => {
  const f = fixture(t), state = path.join(f.directory, ".gp-local-archive");
  assert.throws(() => createLocalBackupArchive({ ...f.options, expectedStream: "external" }).initialize({
    host: "gp-test", stream: "app", confirmation: "initialize-local-archive" }), /EXPECTED_STREAM_MISMATCH/);
  f.archive.initialize({ host: "gp-test", stream: "app", confirmation: "initialize-local-archive" });
  const p = pair(f.directory, 0), open = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (file === binary && fs.existsSync(path.join(state, "pending-operation.json"))) throw new Error("synthetic-before-backup-interruption");
    return open(file, ...args);
  };
  try { assert.throws(() => f.archive.archivePair(p.snapshot, { verifyPair }), /synthetic-before-backup-interruption/); }
  finally { fs.openSync = open; }
  assert.equal(f.archive.reconcile({ confirmation: "reconcile-local-archive", verifyPair }).outcome, "no-snapshot-created");
  assert.equal(f.archive.listMetadata().length, 0); assert.ok(fs.existsSync(p.databasePath));
  let savedLock;
  f.archive.archivePair(p.snapshot, { verifyPair(metadata) {
    verifyPair(metadata); savedLock = fs.readFileSync(path.join(state, "operation.lock"));
  } });
  fs.writeFileSync(path.join(state, "operation.lock"), savedLock, { flag: "wx" });
  const expectedToken = JSON.parse(savedLock).payload.token;
  assert.throws(() => f.archive.releaseStaleLock({ confirmation: "release-local-archive-lock", expectedToken }), /LOCK_OWNER_STILL_RUNNING/);
  const kill = process.kill;
  process.kill = (pid, signal) => {
    assert.equal(pid, process.pid); assert.equal(signal, 0);
    const error = new Error("synthetic departed process"); error.code = "ESRCH"; throw error;
  };
  try {
    const result = f.archive.releaseStaleLock({ confirmation: "release-local-archive-lock", expectedToken });
    assert.equal(result.released, true); assert.equal(result.removedRaw, 0);
  } finally { process.kill = kill; }
  assert.equal(fs.existsSync(path.join(state, "operation.lock")), false);
  assert.equal(f.archive.inspect().retained, 1);
  const preflight = f.archive.preflightBackup();
  assert.equal(preflight.ready, true); assert.equal(preflight.retained, 1); assert.equal(preflight.stream, "app");
});

test("cached construction never hashes the binary, operations still enforce its pin, and published-receipt reconciliation is idempotent", { skip: !available, timeout: 90000 }, t => {
  const f = fixture(t), state = path.join(f.directory, ".gp-local-archive");
  f.archive.initialize({ host: "gp-test", stream: "app", confirmation: "initialize-local-archive" });
  const p = pair(f.directory, 0), pending = path.join(state, "pending-operation.json");
  const receiptPath = path.join(state, "receipts", `${p.snapshot}.json`), unlink = fs.unlinkSync;
  fs.unlinkSync = (file, ...args) => {
    if (file === pending) throw new Error("synthetic-after-receipt-publication");
    return unlink(file, ...args);
  };
  try { assert.throws(() => f.archive.archivePair(p.snapshot, { verifyPair }), /synthetic-after-receipt-publication/); }
  finally { fs.unlinkSync = unlink; }
  const originalReceipt = fs.readFileSync(receiptPath);
  assert.ok(fs.existsSync(p.databasePath));
  assert.throws(() => f.archive.preflightBackup(), /PENDING_RECONCILIATION_REQUIRED/);
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === receiptPath) throw new Error("existing-receipt-must-not-be-republished");
    return rename(source, target);
  };
  try {
    const result = f.archive.reconcile({ confirmation: "reconcile-local-archive", verifyPair });
    assert.equal(result.outcome, "verified-existing-receipt");
    assert.equal(result.removedRaw, 0); assert.equal(result.removedArchives, 0);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(receiptPath), originalReceipt);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(f.archive.reconcile({ confirmation: "reconcile-local-archive", verifyPair }).reconciled, false);

  assert.throws(() => createLocalBackupArchive({ ...f.options, verifyBinaryOnConstruction: "false" }), /OPTIONS_INVALID/);
  const open = fs.openSync, write = fs.writeFileSync;
  let cached;
  fs.openSync = (file, ...args) => {
    if (file === binary) throw new Error("cached-health-binary-read-forbidden");
    if (args[0] !== "r") throw new Error("cached-health-write-forbidden");
    return open(file, ...args);
  };
  fs.writeFileSync = () => { throw new Error("cached-health-write-forbidden"); };
  fs.renameSync = () => { throw new Error("cached-health-write-forbidden"); };
  fs.unlinkSync = () => { throw new Error("cached-health-write-forbidden"); };
  try {
    cached = createLocalBackupArchive({ ...f.options, verifyBinaryOnConstruction: false });
    assert.equal(cached.configured(), true);
    assert.equal(cached.listMetadata({ verifyInventory: false }).length, 1);
    assert.throws(() => createLocalBackupArchive(f.options), /cached-health-binary-read-forbidden/);
    assert.throws(() => cached.listMetadata(), /cached-health-write-forbidden/, "operational inventory still requires its lock");
    assert.throws(() => cached.preflightBackup(), /cached-health-write-forbidden/, "preflight still requires its lock");
  } finally { fs.openSync = open; fs.writeFileSync = write; fs.renameSync = rename; fs.unlinkSync = unlink; }
  const operationLock = path.join(state, "operation.lock");
  fs.writeFileSync(operationLock, "synthetic-other-operation", { flag: "wx" });
  try {
    assert.throws(() => cached.listMetadata({ verifyInventory: false }), /LOCKED_REQUIRES_REVIEW/);
    assert.equal(fs.readFileSync(operationLock, "utf8"), "synthetic-other-operation");
  } finally { fs.unlinkSync(operationLock); }
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    const result = read(file, ...args);
    if (file === receiptPath) fs.writeFileSync(operationLock, "synthetic-read-race", { flag: "wx" });
    return result;
  };
  try {
    assert.throws(() => cached.listMetadata({ verifyInventory: false }), /LOCKED_REQUIRES_REVIEW/);
    assert.equal(read(operationLock, "utf8"), "synthetic-read-race");
  } finally { fs.readFileSync = read; fs.unlinkSync(operationLock); }
  const materialized = cached.materialize(p.snapshot, { verifyPair });
  assert.equal(sha256File(materialized.databasePath), p.hash); materialized.cleanup();
  const wrongPin = createLocalBackupArchive({ ...f.options, binarySha256: "0".repeat(64), verifyBinaryOnConstruction: false });
  assert.equal(wrongPin.listMetadata({ verifyInventory: false }).length, 1);
  assert.throws(() => wrongPin.archivePair(p.snapshot, { verifyPair }), /BINARY_HASH_MISMATCH/);
  assert.throws(() => wrongPin.materialize(p.snapshot, { verifyPair }), /BINARY_HASH_MISMATCH/);
  assert.throws(() => wrongPin.preflightBackup(), /BINARY_HASH_MISMATCH/);
  assert.deepEqual(fs.readFileSync(receiptPath), originalReceipt);
  assert.ok(fs.existsSync(p.databasePath));
});
