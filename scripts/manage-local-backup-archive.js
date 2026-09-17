"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openLocalBackupArchiveFromEnvironment } = require("../lib/local-backup-environment");
const { markerPathFor, verifyCommittedBackup, inspectCommittedBackupMetadata } = require("../lib/backup-commit");
const { sha256File, HASH_BUFFER_BYTES } = require("../lib/file-integrity");
const { verifyStandaloneBackupPair } = require("../backup");
const { withBackupWorkspace } = require("../lib/backup-workspace");

const RESERVE_BYTES = 10 * 1024 ** 3;
const RECEIPT_RESERVE_BYTES = 64 * 1024;
const EXPORT_PREFIX = "grabenplaner-backup-export-";
const HASH = /^[a-f0-9]{64}$/;

function fail(code) {
  const error = new Error("Die lokale Archivverwaltung konnte nicht sicher abgeschlossen werden.");
  error.code = `LOCAL_ARCHIVE_MANAGEMENT_${code}`;
  throw error;
}
function checkedPath(target, type = "directory") {
  if (typeof target !== "string" || !path.isAbsolute(target) || /[\x00-\x1f\x7f]/.test(target)) fail("PATH_INVALID");
  const resolved = path.resolve(target), parsedRoot = path.parse(resolved).root;
  if (resolved === parsedRoot) fail("PATH_INVALID");
  let cursor = parsedRoot;
  for (const part of path.relative(parsedRoot, resolved).split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (cursor !== resolved && !stat.isDirectory())) fail("LINK_OR_PATH_INVALID");
  }
  const stat = fs.lstatSync(resolved);
  if (type === "directory" ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1)) fail("LINK_OR_PATH_INVALID");
  return { path: resolved, stat };
}
function checkedSnapshot(snapshot) {
  if (typeof snapshot !== "string") fail("SNAPSHOT_INVALID");
  try { markerPathFor(path.resolve("."), snapshot); }
  catch { fail("SNAPSHOT_INVALID"); }
  return snapshot;
}
function within(first, second) {
  const relative = path.relative(second, first);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function safeCount(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("METADATA_INVALID");
  return value;
}
function pointMetadata(point) {
  const snapshot = checkedSnapshot(point?.snapshot);
  if (!HASH.test(String(point?.databaseSha256 || "")) || !Number.isFinite(Date.parse(point?.createdAt))) fail("METADATA_INVALID");
  return { snapshot, sha256: point.databaseSha256, bytes: safeCount(point.databaseBytes, 1),
    coupledBytes: safeCount(point.coupledBytes, point.databaseBytes), createdAt: point.createdAt };
}
function parseArguments(args) {
  if (!Array.isArray(args) || !args.every(value => typeof value === "string")) fail("ARGUMENTS_INVALID");
  const [action, backupDirectory, ...values] = args;
  if (!["initialize", "list", "inspect", "export", "reconcile", "release-stale-lock", "archive-existing", "finish-retention"].includes(action)) fail("ARGUMENTS_INVALID");
  const required = { initialize: 3, export: 2, reconcile: 1, "release-stale-lock": 2, "archive-existing": 2, "finish-retention": 2 }[action] || 0;
  if (values.length !== required) fail("ARGUMENTS_INVALID");
  if (action === "initialize" && (!/^gp-[a-z0-9-]{1,80}$/.test(values[0])
    || !["app", "external"].includes(values[1]) || values[2] !== "initialize-local-archive")) fail("EXPLICIT_INITIALIZATION_REQUIRED");
  if (action === "export") checkedSnapshot(values[0]);
  if (action === "reconcile" && values[0] !== "reconcile-local-archive") fail("EXPLICIT_RECONCILIATION_REQUIRED");
  if (action === "release-stale-lock" && (!/^[a-f0-9-]{36}$/.test(values[0]) || values[1] !== "release-local-archive-lock")) fail("EXPLICIT_LOCK_RELEASE_REQUIRED");
  if (action === "archive-existing") {
    checkedSnapshot(values[0]);
    if (values[1] !== "archive-existing-local-backup") fail("EXPLICIT_ARCHIVE_EXISTING_REQUIRED");
  }
  if (action === "finish-retention") {
    checkedSnapshot(values[0]);
    if (values[1] !== "finish-local-archive-retention") fail("EXPLICIT_RETENTION_REQUIRED");
  }
  return { action, backupDirectory: checkedPath(backupDirectory).path, values };
}
function freeBytes(directory, statfs = fs.statfsSync) {
  const stat = statfs(directory);
  return safeCount(stat.bavail * stat.bsize);
}
function requireCapacity(backupDirectory, destinationRoot, coupledBytes, statfs) {
  const source = checkedPath(backupDirectory), destination = checkedPath(destinationRoot);
  const required = safeCount(coupledBytes, 1) + RECEIPT_RESERVE_BYTES;
  // On one volume the verified temporary pair is moved into the private
  // export directory. Different volumes need one full pair on each volume.
  if (!Number.isSafeInteger(required + RESERVE_BYTES)
    || freeBytes(source.path, statfs) < RESERVE_BYTES + required
    || freeBytes(destination.path, statfs) < RESERVE_BYTES + required) fail("CAPACITY_REQUIRED");
}
function inventory(directory) {
  checkedPath(directory);
  const files = [];
  function walk(current) {
    for (const name of fs.readdirSync(current)) {
      const target = path.join(current, name), stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { checkedPath(target); walk(target); }
      else {
        checkedPath(target, "file");
        files.push({ file: target, relative: path.relative(directory, target), bytes: safeCount(stat.size) });
      }
    }
  }
  walk(directory);
  return files;
}
function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function copyExclusiveFile(source, destination) {
  const original = checkedPath(source, "file").stat;
  checkedPath(path.dirname(destination));
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let destinationFd;
  try {
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES), digest = crypto.createHash("sha256");
    let copied = 0;
    while (copied < original.size) {
      const count = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, original.size - copied), null);
      if (count === 0) fail("SOURCE_CHANGED");
      digest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const step = fs.writeSync(destinationFd, buffer, written, count - written);
        if (step <= 0) fail("COPY_FAILED");
        written += step;
      }
      copied += count;
    }
    const after = fs.fstatSync(sourceFd), leaf = checkedPath(source, "file").stat;
    for (const stat of [after, leaf]) {
      if (stat.dev !== original.dev || stat.ino !== original.ino || stat.size !== original.size
        || stat.mtimeMs !== original.mtimeMs || stat.ctimeMs !== original.ctimeMs) fail("SOURCE_CHANGED");
    }
    fs.fsyncSync(destinationFd);
    const copiedSha256 = digest.digest("hex");
    if (sha256File(source) !== copiedSha256 || sha256File(destination) !== copiedSha256) fail("COPY_HASH_MISMATCH");
    return { bytes: copied, sha256: copiedSha256 };
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}
function copyDirectory(source, destination) {
  checkedPath(source);
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name), to = path.join(destination, name);
    if (fs.lstatSync(from).isDirectory() && !fs.lstatSync(from).isSymbolicLink()) copyDirectory(from, to);
    else copyExclusiveFile(from, to);
  }
  fsyncDirectory(destination);
}
function cleanupFailedExport(directory, destinationRoot, identity) {
  const current = checkedPath(directory);
  if (path.dirname(current.path) !== destinationRoot || !path.basename(current.path).startsWith(EXPORT_PREFIX)
    || current.stat.dev !== identity.dev || current.stat.ino !== identity.ino) fail("CLEANUP_SCOPE_INVALID");
  inventory(directory); // No link/hardlink escape, including after failed copy.
  fs.rmSync(directory, { recursive: true });
}
function moveExclusiveEntry(source, destination) {
  const original = fs.lstatSync(source);
  checkedPath(source, original.isDirectory() ? "directory" : "file");
  checkedPath(path.dirname(destination));
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) fail("MOVE_TARGET_EXISTS");
  // The destination is a new mode-0700 export directory owned by this run.
  // An unexpected cross-volume move fails; it never silently makes a copy.
  fs.renameSync(source, destination);
  const moved = checkedPath(destination, original.isDirectory() ? "directory" : "file").stat;
  if (moved.dev !== original.dev || moved.ino !== original.ino) fail("MOVE_IDENTITY_CHANGED");
  restrictPrivateEntry(destination);
}
function restrictPrivateEntry(target) {
  const directory = fs.lstatSync(target).isDirectory();
  checkedPath(target, directory ? "directory" : "file");
  fs.chmodSync(target, directory ? 0o700 : 0o600);
  if (directory) for (const name of fs.readdirSync(target)) restrictPrivateEntry(path.join(target, name));
}
function synchronousVerifier(verifyPair = verifyStandaloneBackupPair, environment = process.env) {
  return (pair, marker) => {
    const result = verifyPair(pair, marker, { environment });
    if (result && typeof result.then === "function") { Promise.resolve(result).catch(() => {}); fail("SYNC_VERIFIER_REQUIRED"); }
  };
}

function exportPoint({ archive, backupDirectory, snapshot, destinationRoot }, dependencies = {}) {
  const destination = checkedPath(destinationRoot).path;
  if (within(destination, backupDirectory) || within(backupDirectory, destination)) fail("EXPORT_SCOPE_OVERLAP");
  const point = archive.listMetadata().find(item => item.snapshot === snapshot);
  if (!point) fail("SNAPSHOT_NOT_FOUND");
  const metadata = pointMetadata(point);
  requireCapacity(backupDirectory, destination, metadata.coupledBytes, dependencies.statfs);
  const synchronousVerifyPair = synchronousVerifier(dependencies.verifyPair, dependencies.environment);
  let materialized, target, targetIdentity, completed = false;
  try {
    materialized = archive.materialize(snapshot, { verifyPair: synchronousVerifyPair });
    if (typeof materialized?.cleanup !== "function") fail("MATERIALIZATION_INVALID");
    const sourceState = checkedPath(materialized.temporaryRoot);
    const source = sourceState.path;
    if (within(destination, source) || within(source, destination)) fail("MATERIALIZATION_SCOPE_OVERLAP");
    const sameVolume = sourceState.stat.dev === checkedPath(destination).stat.dev;
    const pair = verifyCommittedBackup(source, `${snapshot}.complete.json`, { verifyPair: synchronousVerifyPair });
    if (pair.databaseSha256 !== metadata.sha256 || pair.marker.database.bytes !== metadata.bytes) fail("MATERIALIZATION_MISMATCH");
    for (const key of ["databasePath", "protectedDirectory", "markerPath"]) {
      if (materialized[key] !== pair[key]) fail("MATERIALIZATION_MISMATCH");
    }
    const sourceInventory = inventory(source);
    if (sourceInventory.some(file => ![`${snapshot}.db`, `${snapshot}.complete.json`].includes(file.relative)
      && !file.relative.startsWith(`${snapshot}.amu${path.sep}`))) fail("MATERIALIZATION_SCOPE_INVALID");
    if (sourceInventory.reduce((sum, file) => sum + file.bytes, 0) !== metadata.coupledBytes) fail("MATERIALIZATION_MISMATCH");
    if (freeBytes(destination, dependencies.statfs) < RESERVE_BYTES + RECEIPT_RESERVE_BYTES
      + (sameVolume ? 0 : metadata.coupledBytes)) fail("CAPACITY_REQUIRED");
    const markerSha256 = sha256File(pair.markerPath);
    target = fs.mkdtempSync(path.join(destination, EXPORT_PREFIX));
    fs.chmodSync(target, 0o700);
    targetIdentity = fs.lstatSync(target);
    if (sameVolume) {
      moveExclusiveEntry(pair.databasePath, path.join(target, `${snapshot}.db`));
      moveExclusiveEntry(pair.protectedDirectory, path.join(target, `${snapshot}.amu`));
      moveExclusiveEntry(pair.markerPath, path.join(target, `${snapshot}.complete.json`));
      fsyncDirectory(source);
    } else {
      copyExclusiveFile(pair.databasePath, path.join(target, `${snapshot}.db`));
      copyDirectory(pair.protectedDirectory, path.join(target, `${snapshot}.amu`));
      copyExclusiveFile(pair.markerPath, path.join(target, `${snapshot}.complete.json`));
    }
    const copied = verifyCommittedBackup(target, `${snapshot}.complete.json`, { verifyPair: synchronousVerifyPair });
    if (copied.databaseSha256 !== metadata.sha256 || sha256File(copied.markerPath) !== markerSha256) fail("COPIED_PAIR_MISMATCH");
    const receipt = { format: "grabenplaner-local-backup-export", schemaVersion: 1,
      snapshot, databaseSha256: metadata.sha256, databaseBytes: metadata.bytes, coupledBytes: metadata.coupledBytes,
      exportedAt: new Date().toISOString(), verification: "verified", activated: false };
    const fd = fs.openSync(path.join(target, "export-receipt.json"), "wx", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fsyncDirectory(target);
    fsyncDirectory(destination);
    completed = true;
    return { ok: true, action: "export", snapshot, exportDirectory: target, sha256: metadata.sha256, verified: true, activated: false };
  } finally {
    try { if (target && !completed) cleanupFailedExport(target, destination, targetIdentity); }
    finally { if (materialized && typeof materialized.cleanup === "function") materialized.cleanup(); }
  }
}

function requireNewestRawPoint(backupDirectory, snapshot, archive, verifyPair) {
  // Recovery is only for the newest complete point interrupted during creation,
  // never automatic adoption of historic, unregistered raw backups.
  const candidate = verifyCommittedBackup(backupDirectory, `${snapshot}.complete.json`, { verifyPair });
  const created = Date.parse(candidate.marker.committedAt);
  const names = fs.readdirSync(backupDirectory).filter(name => /^dienstplan-[0-9A-Za-z._-]+\.complete\.json$/.test(name));
  for (const name of names) {
    const other = inspectCommittedBackupMetadata(backupDirectory, name);
    if (other.snapshot !== snapshot && Date.parse(other.marker.committedAt) >= created) fail("NEWEST_RAW_POINT_REQUIRED");
  }
  const points = archive.listMetadata();
  for (const point of points) {
    if (!Number.isFinite(Date.parse(point.createdAt))) fail("METADATA_INVALID");
    if (Date.parse(point.createdAt) > created) fail("NEWEST_RAW_POINT_REQUIRED");
  }
  return { candidate, points };
}

function verifiedRetention(archive, snapshot, verifyPair) {
  const retention = archive.maintainRetention(snapshot, { verifyPair });
  if (retention?.latestRawRetained !== snapshot || retention.unregisteredRawRemoved !== 0
    || !Number.isSafeInteger(retention.retained) || retention.retained < 1 || retention.retained > 20) fail("RETENTION_RECEIPT_INVALID");
  return { retention: 20, retained: retention.retained, rawRetained: true,
    removedArchives: safeCount(retention.removedArchives), removedRaw: safeCount(retention.removedRaw), unregisteredRawRemoved: 0 };
}

function manage(args, dependencies = {}) {
  const input = parseArguments(args);
  if (["export", "archive-existing", "finish-retention", "reconcile"].includes(input.action)) {
    const databasePath = dependencies.databasePath || (dependencies.environment || process.env).DB_PATH;
    if (!databasePath) fail("WORKSPACE_DATABASE_REQUIRED");
    return withBackupWorkspace(databasePath, () => manageWhileLocked(input, dependencies));
  }
  return manageWhileLocked(input, dependencies);
}
function manageWhileLocked(input, dependencies) {
  const archive = (dependencies.openArchive || openLocalBackupArchiveFromEnvironment)({ backupDirectory: input.backupDirectory,
    environment: dependencies.environment || process.env, requireConfigured: input.action !== "initialize",
    ...(input.action === "initialize" ? { expectedStream: input.values[1] } : {}) });
  if (!archive) fail("MODE_NOT_ENABLED");
  if (input.action === "initialize") {
    const [host, stream, confirmation] = input.values;
    archive.initialize({ host, stream, confirmation });
    return { ok: true, action: "initialize", configured: true, retention: 20, stream };
  }
  if (input.action === "list") {
    const points = archive.listMetadata().map(pointMetadata);
    return { ok: true, action: "list", count: points.length, points };
  }
  if (input.action === "inspect") {
    const state = archive.inspect();
    if (state.configured !== true || state.retention !== 20) fail("INSPECTION_INVALID");
    return { ok: true, action: "inspect", configured: true, retention: 20, retained: safeCount(state.retained),
      archiveBytes: safeCount(state.archiveBytes), temporaryBytes: safeCount(state.temporaryBytes) };
  }
  if (input.action === "reconcile") {
    const result = archive.reconcile({ confirmation: input.values[0], verifyPair: synchronousVerifier(dependencies.verifyPair, dependencies.environment) });
    if (typeof result?.reconciled !== "boolean" || result.removedRaw !== 0 || result.removedArchives !== 0) fail("RECONCILIATION_RECEIPT_INVALID");
    return { ok: true, action: "reconcile", reconciled: result.reconciled, removedRaw: 0, removedArchives: 0 };
  }
  if (input.action === "release-stale-lock") {
    const result = archive.releaseStaleLock({ expectedToken: input.values[0], confirmation: input.values[1] });
    if (result?.released !== true || typeof result.pendingReconciliationRequired !== "boolean"
      || result.removedRaw !== 0 || result.removedArchives !== 0) fail("LOCK_RELEASE_RECEIPT_INVALID");
    return { ok: true, action: "release-stale-lock", released: true, pendingReconciliationRequired: result.pendingReconciliationRequired,
      removedRaw: 0, removedArchives: 0 };
  }
  if (["archive-existing", "finish-retention"].includes(input.action)) {
    const snapshot = input.values[0], verifyPair = synchronousVerifier(dependencies.verifyPair, dependencies.environment);
    const { points } = requireNewestRawPoint(input.backupDirectory, snapshot, archive, verifyPair);
    let point = points.find(value => value.snapshot === snapshot);
    if (input.action === "archive-existing") point = archive.archivePair(snapshot, { verifyPair });
    if (point?.archived !== true || !HASH.test(String(point.archiveSnapshotId || ""))) fail("ARCHIVE_RECEIPT_INVALID");
    const retention = verifiedRetention(archive, snapshot, verifyPair);
    return { ok: true, action: input.action, archived: true, snapshot, archiveSnapshotId: point.archiveSnapshotId, ...retention };
  }
  return exportPoint({ archive, backupDirectory: input.backupDirectory, snapshot: input.values[0], destinationRoot: input.values[1] }, dependencies);
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(manage(process.argv.slice(2)))}\n`); }
  catch {
    process.stderr.write("Die lokale Archivverwaltung wurde sicher abgebrochen. Es wurde keine Datenbank aktiviert; Konfiguration und temporaere Arbeitsdaten sind bei Bedarf zu pruefen.\n");
    process.exitCode = 1;
  }
}
module.exports = { manage, parseArguments, exportPoint, copyExclusiveFile, RESERVE_BYTES, RECEIPT_RESERVE_BYTES };
