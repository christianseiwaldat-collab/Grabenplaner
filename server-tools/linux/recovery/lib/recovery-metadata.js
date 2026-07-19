"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SNAPSHOT_ID = /^[a-f0-9]{64}$/;
const RECOVERY_ID = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;

function fail(message) { throw new Error(message); }
function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}
function sha256Text(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }

function regular(file, { maximumBytes = 16 * 1024 * 1024 } = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumBytes) {
    fail("Eine Recovery-Datei ist unzulaessig.");
  }
  return stat;
}

function readJson(file, options) {
  regular(file, options);
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function exactSnapshot(value, expectedHost, expectedPath) {
  const id = String(value?.id || "").toLowerCase();
  const hostname = String(value?.hostname || "");
  const paths = Array.isArray(value?.paths) ? value.paths.map(String) : [];
  const tags = Array.isArray(value?.tags) ? value.tags.map(String) : [];
  const timestamp = String(value?.time || "");
  if (!SNAPSHOT_ID.test(id) || hostname !== expectedHost || !paths.includes(expectedPath)
    || !tags.includes("grabenplaner-offsite") || !Number.isFinite(Date.parse(timestamp))) return null;
  return { id, time: new Date(timestamp).toISOString(), hostname, path: expectedPath, tags: [...new Set(tags)].sort() };
}

function snapshots(file, expectedHost, expectedPath) {
  const values = readJson(file);
  if (!Array.isArray(values)) fail("Die Snapshotliste ist ungueltig.");
  const result = values.map((value) => exactSnapshot(value, expectedHost, expectedPath)).filter(Boolean)
    .sort((left, right) => Date.parse(right.time) - Date.parse(left.time) || left.id.localeCompare(right.id));
  const seen = new Set();
  for (const item of result) {
    if (seen.has(item.id)) fail("Die Snapshotliste enthaelt eine doppelte Snapshot-ID.");
    seen.add(item.id);
  }
  return result;
}

function selectExact(file, id, expectedHost, expectedPath) {
  const normalized = String(id || "").toLowerCase();
  if (!SNAPSHOT_ID.test(normalized)) fail("Es ist eine vollstaendige 64-stellige Snapshot-ID erforderlich.");
  const matches = snapshots(file, expectedHost, expectedPath).filter((item) => item.id === normalized);
  if (matches.length !== 1) fail("Der angeforderte Snapshot ist fuer Installation, Host, Tag und Pfad nicht eindeutig freigegeben.");
  return matches[0];
}

function selectLatest(file, expectedHost, expectedPath) {
  const values = snapshots(file, expectedHost, expectedPath);
  if (!values.length) fail("Es wurde kein passender Offsite-Snapshot gefunden.");
  return values[0];
}

function parseStats(file) {
  const value = readJson(file);
  const totalSize = Number(value?.total_size);
  const totalFileCount = Number(value?.total_file_count);
  if (!Number.isSafeInteger(totalSize) || totalSize < 1 || !Number.isSafeInteger(totalFileCount) || totalFileCount < 1) {
    fail("Die Restore-Groessenangabe ist ungueltig.");
  }
  return { totalSize, totalFileCount };
}

function assertFrozenTree(root, { requireRootOwner = process.platform === "linux" } = {}) {
  const resolvedRoot = path.resolve(root);
  if (!path.isAbsolute(root) || resolvedRoot === path.parse(resolvedRoot).root) fail("Der Recovery-Baum ist ungueltig.");
  const files = [];
  const walk = (directory) => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o222) !== 0
      || (requireRootOwner && directoryStat.uid !== 0)) fail("Der Recovery-Baum ist nicht unveraenderlich eingefroren.");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!SAFE_NAME.test(entry.name)) fail("Ein Recovery-Dateiname ist unzulaessig.");
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail("Symbolische Links sind im Recovery-Baum nicht erlaubt.");
      if (stat.isDirectory()) walk(target);
      else if (stat.isFile() && stat.nlink === 1 && (stat.mode & 0o222) === 0 && (!requireRootOwner || stat.uid === 0)) {
        files.push({ path: path.relative(resolvedRoot, target).split(path.sep).join("/"), bytes: stat.size, sha256: sha256File(target) });
      } else fail("Hardlinks und besondere Dateitypen sind im Recovery-Baum nicht erlaubt.");
    }
  };
  walk(resolvedRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function atomicJson(file, value, mode = 0o400) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
  if (process.platform !== "win32") {
    const directoryHandle = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  }
}

function preparedReceipt(output, recoveryId, snapshotFile, statsFile, verificationFile, repositoryIdFile, installationIdFile) {
  const normalizedRecovery = String(recoveryId || "").toLowerCase();
  if (!RECOVERY_ID.test(normalizedRecovery)) fail("Die Recovery-ID ist ungueltig.");
  const snapshot = readJson(snapshotFile, { maximumBytes: 64 * 1024 });
  const stats = parseStats(statsFile);
  const verification = readJson(verificationFile, { maximumBytes: 1024 * 1024 });
  regular(repositoryIdFile, { maximumBytes: 256 });
  regular(installationIdFile, { maximumBytes: 256 });
  const repositoryId = fs.readFileSync(repositoryIdFile, "utf8").trim().toLowerCase();
  const installationId = fs.readFileSync(installationIdFile, "utf8").trim().toLowerCase();
  if (!SNAPSHOT_ID.test(String(snapshot.id || "")) || !/^[a-f0-9]{16,64}$/.test(repositoryId)
    || !/^[a-f0-9]{32}$/.test(installationId) || verification?.ok !== true
    || !SNAPSHOT_ID.test(String(verification.databaseSha256 || ""))
    || !SNAPSHOT_ID.test(String(verification.stageManifestSha256 || ""))) {
    fail("Der vorbereitete Recovery-Beleg ist unvollstaendig.");
  }
  if (snapshot.hostname !== `grabenplaner-${installationId}`) {
    fail("Der Snapshot gehoert nicht zur eingerichteten Installation.");
  }
  const now = new Date().toISOString();
  const receipt = {
    format: "grabenplaner-linux-recovery",
    schemaVersion: 1,
    state: "prepared",
    recoveryId: normalizedRecovery,
    snapshotId: snapshot.id,
    snapshotTime: snapshot.time,
    installationHost: snapshot.hostname,
    repositoryId,
    installationId,
    sourcePath: snapshot.path,
    expectedBytes: stats.totalSize,
    expectedFiles: stats.totalFileCount,
    databaseSha256: verification.databaseSha256,
    stageManifestSha256: verification.stageManifestSha256,
    sourceAppVersion: verification.sourceAppVersion,
    targetAppVersion: verification.targetAppVersion,
    deploymentSchemaVersion: verification.deploymentSchemaVersion,
    preparedAt: now,
    verificationSha256: sha256File(verificationFile),
  };
  atomicJson(output, receipt);
  return receipt;
}

function validateReceipt(receipt, expectedState, recoveryId, snapshotId) {
  if (receipt?.format !== "grabenplaner-linux-recovery" || receipt?.schemaVersion !== 1 || receipt?.state !== expectedState
    || receipt?.recoveryId !== String(recoveryId || "").toLowerCase()
    || receipt?.snapshotId !== String(snapshotId || "").toLowerCase()
    || !RECOVERY_ID.test(String(receipt?.recoveryId || "")) || !SNAPSHOT_ID.test(String(receipt?.snapshotId || ""))) {
    fail("Der Recovery-Beleg passt nicht zur ausdruecklich gewaehlten Wiederherstellung.");
  }
  return receipt;
}

function verifiedReceipt(output, preparedFile, verificationFile, recoveryId, snapshotId) {
  const prepared = validateReceipt(readJson(preparedFile, { maximumBytes: 256 * 1024 }), "prepared", recoveryId, snapshotId);
  const verification = readJson(verificationFile, { maximumBytes: 1024 * 1024 });
  if (verification?.ok !== true || verification.databaseSha256 !== prepared.databaseSha256
    || verification.stageManifestSha256 !== prepared.stageManifestSha256) fail("Die erneute Recovery-Pruefung stimmt nicht mit der Vorbereitung ueberein.");
  const receipt = { ...prepared, state: "verified", verifiedAt: new Date().toISOString(), verificationSha256: sha256File(verificationFile) };
  atomicJson(output, receipt);
  return receipt;
}

function checkBinding(receiptFile, repositoryIdFile, installationIdFile, expectedPath) {
  const receipt = readJson(receiptFile, { maximumBytes: 256 * 1024 });
  regular(repositoryIdFile, { maximumBytes: 256 });
  regular(installationIdFile, { maximumBytes: 256 });
  const repositoryId = fs.readFileSync(repositoryIdFile, "utf8").trim().toLowerCase();
  const installationId = fs.readFileSync(installationIdFile, "utf8").trim().toLowerCase();
  if (!/^[a-f0-9]{16,64}$/.test(repositoryId) || !/^[a-f0-9]{32}$/.test(installationId)
    || receipt?.repositoryId !== repositoryId || receipt?.installationId !== installationId
    || receipt?.installationHost !== `grabenplaner-${installationId}` || receipt?.sourcePath !== expectedPath) {
    fail("Der Recovery-Beleg gehoert nicht zur eingerichteten Repository-/Installationsbindung.");
  }
  return { ok: true, repositoryId, installationId, installationHost: receipt.installationHost, sourcePath: receipt.sourcePath };
}

function safetyReceipt(output, safetyRoot, recoveryId, snapshotId) {
  const normalizedRecovery = String(recoveryId || "").toLowerCase();
  const normalizedSnapshot = String(snapshotId || "").toLowerCase();
  if (!RECOVERY_ID.test(normalizedRecovery) || !SNAPSHOT_ID.test(normalizedSnapshot)) fail("Der Sicherheitsbeleg hat ungueltige Kennungen.");
  const files = assertFrozenTree(safetyRoot);
  if (!files.length) fail("Der Sicherheitsbeleg darf keinen leeren Live-Zustand bestaetigen.");
  const receipt = {
    format: "grabenplaner-pre-restore-safety",
    schemaVersion: 1,
    recoveryId: normalizedRecovery,
    snapshotId: normalizedSnapshot,
    createdAt: new Date().toISOString(),
    files,
    treeSha256: sha256Text(files.map((item) => `${item.path}\0${item.bytes}\0${item.sha256}\n`).join("")),
  };
  atomicJson(output, receipt);
  return receipt;
}

function operationStatus(output, state, recoveryId, snapshotId, code = "") {
  const states = new Set(["started", "prepared", "verified", "applying", "applied", "failed"]);
  const normalizedRecovery = String(recoveryId || "").toLowerCase();
  const normalizedSnapshot = String(snapshotId || "").toLowerCase();
  if (!states.has(state) || !RECOVERY_ID.test(normalizedRecovery) || !SNAPSHOT_ID.test(normalizedSnapshot)
    || (code && !/^[A-Z][A-Z0-9_]{2,63}$/.test(code))) fail("Der Recovery-Vorgangsstatus ist ungueltig.");
  const receipt = {
    format: "grabenplaner-linux-recovery-operation",
    schemaVersion: 1,
    state,
    recoveryId: normalizedRecovery,
    snapshotId: normalizedSnapshot,
    code: code || null,
    updatedAt: new Date().toISOString(),
  };
  atomicJson(output, receipt);
  return receipt;
}

function restoreTestReceipt(output, snapshotFile, statsFile, verificationFile, startedAt, repositoryIdFile, installationIdFile, expectedPath) {
  const snapshot = readJson(snapshotFile, { maximumBytes: 64 * 1024 });
  const stats = parseStats(statsFile);
  const verification = readJson(verificationFile, { maximumBytes: 1024 * 1024 });
  const started = Date.parse(String(startedAt || ""));
  const completedAt = new Date();
  regular(repositoryIdFile, { maximumBytes: 256 });
  regular(installationIdFile, { maximumBytes: 256 });
  const repositoryId = fs.readFileSync(repositoryIdFile, "utf8").trim().toLowerCase();
  const installationId = fs.readFileSync(installationIdFile, "utf8").trim().toLowerCase();
  if (!SNAPSHOT_ID.test(String(snapshot?.id || "")) || verification?.ok !== true || !Number.isFinite(started)
    || !SNAPSHOT_ID.test(String(verification.databaseSha256 || "")) || !SNAPSHOT_ID.test(String(verification.stageManifestSha256 || ""))
    || !/^[a-f0-9]{16,64}$/.test(repositoryId) || !/^[a-f0-9]{32}$/.test(installationId)
    || snapshot.hostname !== `grabenplaner-${installationId}` || snapshot.path !== expectedPath
    || !Number.isSafeInteger(verification.frozenFiles) || verification.frozenFiles < 1
    || !Number.isSafeInteger(verification.protectedDocuments) || verification.protectedDocuments < 0
    || !Number.isSafeInteger(verification.protectedRecords) || verification.protectedRecords < 0
    || !Number.isSafeInteger(verification.integrationCredentials) || verification.integrationCredentials < 0) {
    fail("Der Restore-Testbeleg ist unvollstaendig.");
  }
  const receipt = {
    format: "grabenplaner-offsite-restore-test",
    schemaVersion: 1,
    result: "verified",
    snapshotId: snapshot.id,
    snapshotTime: snapshot.time,
    expectedBytes: stats.totalSize,
    expectedFiles: stats.totalFileCount,
    sourceAppVersion: verification.sourceAppVersion,
    targetAppVersion: verification.targetAppVersion,
    deploymentSchemaVersion: verification.deploymentSchemaVersion,
    protectedDocuments: verification.protectedDocuments,
    protectedRecords: verification.protectedRecords,
    integrationCredentials: verification.integrationCredentials,
    frozenFiles: verification.frozenFiles,
    databaseSha256: verification.databaseSha256,
    stageManifestSha256: verification.stageManifestSha256,
    repositoryBindingSha256: sha256Text(repositoryId),
    installationBindingSha256: sha256Text(installationId),
    sourcePathSha256: sha256Text(expectedPath),
    startedAt: new Date(started).toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - started),
    applicationSmoke: {
      status: "not-run",
      reasonCode: "RECOVERY_TEST_MODE_UNAVAILABLE",
      boundary: "Kein nachweislich nebenwirkungsfreier isolierter App-Testmodus vorhanden.",
    },
  };
  atomicJson(output, receipt);
  return receipt;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === "list") result = snapshots(args[0], args[1], args[2]);
  else if (command === "select-exact") result = selectExact(args[0], args[1], args[2], args[3]);
  else if (command === "select-latest") result = selectLatest(args[0], args[1], args[2]);
  else if (command === "stats") result = parseStats(args[0]);
  else if (command === "frozen-tree") result = { ok: true, files: assertFrozenTree(args[0]).length };
  else if (command === "prepared") result = preparedReceipt(...args);
  else if (command === "verified") result = verifiedReceipt(...args);
  else if (command === "safety") result = safetyReceipt(...args);
  else if (command === "operation") result = operationStatus(...args);
  else if (command === "restore-test-receipt") result = restoreTestReceipt(...args);
  else if (command === "check-receipt") result = validateReceipt(readJson(args[0]), args[1], args[2], args[3]);
  else if (command === "check-binding") result = checkBinding(...args);
  else fail("Unbekannter Recovery-Metadatenvorgang.");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error?.message || "Recovery-Metadatenpruefung fehlgeschlagen."}\n`); process.exitCode = 1; }
}

module.exports = { assertFrozenTree, checkBinding, parseStats, safetyReceipt, selectExact, selectLatest, snapshots, validateReceipt };
