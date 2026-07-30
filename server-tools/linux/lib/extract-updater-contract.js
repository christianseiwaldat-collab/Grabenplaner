"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONTRACT_KEYS = Object.freeze([
  "backup",
  "installedVersion",
  "ok",
  "packageSha256",
  "previousVersion",
  "publicReadiness",
  "receipt",
]);
const COMMIT_KEYS = Object.freeze([
  "committedAt",
  "format",
  "installedVersion",
  "packageSha256",
  "schemaVersion",
  "status",
  "updateReceipt",
]);
const RECEIPT_KEYS = Object.freeze([
  "backupFile",
  "completedAt",
  "error",
  "packageFile",
  "packageSha256",
  "previousVersion",
  "requestedVersion",
  "rollbackAppReady",
  "rollbackDataReady",
  "rollbackPublicReady",
  "rollbackServiceStopped",
  "status",
]);

function fail(message) {
  const error = new Error(message);
  error.code = "UPDATER_CONTRACT_INVALID";
  throw error;
}

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === expected.join(",");
}

function safeTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value
    && parsed.getTime() <= Date.now() + (5 * 60 * 1000);
}

function readProtectedFile(file, {
  maximumBytes,
  requireRootOwner,
  privateFile = false,
}) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (requireRootOwner && before.uid !== 0)
    || (before.mode & (privateFile ? 0o077 : 0o022)) !== 0
    || before.size < 2 || before.size > maximumBytes) {
    fail("Eine geschützte Ergebnisdatei ist unsicher.");
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      fail("Eine geschützte Ergebnisdatei wurde ausgetauscht.");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function exactChild(candidate, root, pattern) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)
    || candidate !== path.resolve(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) return false;
  const normalizedRoot = path.resolve(root);
  return path.dirname(candidate) === normalizedRoot && pattern.test(path.basename(candidate));
}

function parseJson(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    fail(message);
  }
}

function extractUpdaterContract({
  sourcePath,
  targetPath,
  commitMarkerPath,
  expectedPreviousVersion,
  expectedInstalledVersion,
  expectedPackageSha256,
  expectedPublicReadiness,
  expectedBackupRoot,
  expectedHistoryRoot,
  requireRootOwner = true,
}) {
  if (![sourcePath, targetPath, commitMarkerPath, expectedPreviousVersion, expectedInstalledVersion,
    expectedPackageSha256, expectedPublicReadiness, expectedBackupRoot, expectedHistoryRoot]
    .every((value) => typeof value === "string" && value.length > 0)
    || !/^[a-f0-9]{64}$/.test(expectedPackageSha256)) {
    fail("Der erwartete Updater-Vertrag ist unvollständig.");
  }

  const output = readProtectedFile(sourcePath, {
    maximumBytes: 16 * 1024 * 1024,
    requireRootOwner,
    privateFile: true,
  });
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  const contractLine = lines.at(-1);
  if (!contractLine || Buffer.byteLength(contractLine, "utf8") > 64 * 1024) {
    fail("Der strukturierte Updater-Vertrag fehlt.");
  }
  for (const earlierLine of lines.slice(0, -1)) {
    try {
      if (exactKeys(JSON.parse(earlierLine), CONTRACT_KEYS)) {
        fail("Der strukturierte Updater-Vertrag ist nicht eindeutig.");
      }
    } catch (error) {
      if (error?.code === "UPDATER_CONTRACT_INVALID") throw error;
    }
  }
  const contract = parseJson(contractLine, "Der strukturierte Updater-Vertrag ist kein gültiges JSON.");
  if (!exactKeys(contract, CONTRACT_KEYS)
    || contract.ok !== true
    || contract.previousVersion !== expectedPreviousVersion
    || contract.installedVersion !== expectedInstalledVersion
    || contract.packageSha256 !== expectedPackageSha256
    || contract.publicReadiness !== expectedPublicReadiness
    || !exactChild(contract.backup, expectedBackupRoot, /^dienstplan-[A-Za-z0-9._-]+\.db$/)
    || !exactChild(contract.receipt, expectedHistoryRoot, /^update-[A-Za-z0-9._-]+\.json$/)) {
    fail("Der strukturierte Updater-Vertrag weicht vom erwarteten Commit ab.");
  }

  const commit = parseJson(readProtectedFile(commitMarkerPath, {
    maximumBytes: 64 * 1024,
    requireRootOwner,
    privateFile: true,
  }), "Der Updater-Commitmarker ist kein gültiges JSON.");
  if (!exactKeys(commit, COMMIT_KEYS)
    || commit.format !== "grabenplaner-update-commit"
    || commit.schemaVersion !== 1
    || commit.status !== "committed"
    || commit.installedVersion !== expectedInstalledVersion
    || commit.packageSha256 !== expectedPackageSha256
    || !safeTimestamp(commit.committedAt)
    || commit.updateReceipt !== path.basename(contract.receipt)) {
    fail("Der Updater-Commitmarker stimmt nicht mit dem Ergebnisvertrag überein.");
  }

  const updateReceipt = parseJson(readProtectedFile(contract.receipt, {
    maximumBytes: 64 * 1024,
    requireRootOwner,
  }), "Der Updatebeleg ist kein gültiges JSON.");
  if (!exactKeys(updateReceipt, RECEIPT_KEYS)
    || updateReceipt.status !== "success"
    || updateReceipt.previousVersion !== expectedPreviousVersion
    || updateReceipt.requestedVersion !== expectedInstalledVersion
    || updateReceipt.packageSha256 !== expectedPackageSha256
    || updateReceipt.backupFile !== contract.backup
    || updateReceipt.error !== null
    || updateReceipt.rollbackServiceStopped !== true
    || updateReceipt.rollbackAppReady !== true
    || updateReceipt.rollbackDataReady !== true
    || updateReceipt.rollbackPublicReady !== true
    || !safeTimestamp(updateReceipt.completedAt)
    || Date.parse(updateReceipt.completedAt) > Date.parse(commit.committedAt)
    || updateReceipt.packageFile !== "package.zip") {
    fail("Der dauerhafte Updatebeleg stimmt nicht mit dem Ergebnisvertrag überein.");
  }

  fs.writeFileSync(targetPath, `${JSON.stringify(contract)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return contract;
}

function main() {
  const [
    sourcePath,
    targetPath,
    commitMarkerPath,
    expectedPreviousVersion,
    expectedInstalledVersion,
    expectedPackageSha256,
    expectedPublicReadiness,
    expectedBackupRoot,
    expectedHistoryRoot,
  ] = process.argv.slice(2);
  if (process.argv.length !== 11) fail("Verwendung: extract-updater-contract.js AUSGABE ZIEL COMMIT ALT NEU SHA READY BACKUPROOT HISTORYROOT");
  extractUpdaterContract({
    sourcePath,
    targetPath,
    commitMarkerPath,
    expectedPreviousVersion,
    expectedInstalledVersion,
    expectedPackageSha256,
    expectedPublicReadiness,
    expectedBackupRoot,
    expectedHistoryRoot,
    requireRootOwner: true,
  });
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stderr.write("Der strukturierte Updater-Ergebnisvertrag ist ungültig.\n");
    process.exitCode = 1;
  }
}

module.exports = {
  extractUpdaterContract,
};
