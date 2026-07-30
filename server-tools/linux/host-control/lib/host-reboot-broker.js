#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUEST_FORMAT = "grabenplaner-host-reboot-request";
const RESPONSE_FORMAT = "grabenplaner-host-reboot-response";
const STATE_FORMAT = "grabenplaner-host-reboot-control-state";
const SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const MAX_REQUEST_BYTES = 2048;
const RATE_LIMIT_SECONDS = 15 * 60;
const MAX_BACKUP_AGE_SECONDS = 5 * 60;
const MAX_PROTECTED_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PROTECTED_FILES = 100_000;
const MAX_PROTECTED_TREE_ENTRIES = MAX_PROTECTED_FILES + 512;
const MAX_PROTECTED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_KEY_CHECK_BYTES = 64 * 1024;
const SYSTEMCTL = "/usr/bin/systemctl";
const FLOCK = "/usr/bin/flock";
const TRUE = "/usr/bin/true";
const REBOOT_UNIT = "grabenplaner-host-reboot.service";
const REBOOT_UNIT_FRAGMENT = "/etc/systemd/system/grabenplaner-host-reboot.service";
const REBOOT_REQUIRED_PATH = "/run/reboot-required";
const STATE_PATH = "/var/lib/grabenplaner-host-control/state.json";
const MAINTENANCE_LOCK_PATH = "/run/grabenplaner/maintenance.lock";
const CONTROL_PENDING_PATH = "/run/grabenplaner-host-control/reboot-pending.json";
const CONTROL_ARMED_PATH = "/run/grabenplaner-host-control/reboot-armed.json";
const HOST_SECURITY_STATUS_PATH = "/var/lib/grabenplaner-host-security/status.json";
const BACKUP_DIRECTORY = "/var/lib/grabenplaner/backups";
const REQUEST_KEYS = new Set([
  "action",
  "backupMarkerFileName",
  "format",
  "requestId",
  "schemaVersion",
]);
const STATE_KEYS = new Set(["format", "lastAcceptedAt", "lastRequestId", "schemaVersion"]);
const BACKUP_MARKER_KEYS = new Set([
  "committedAt",
  "database",
  "format",
  "protectedDocuments",
  "schemaVersion",
  "snapshot",
  "verification",
]);
const BACKUP_DATABASE_KEYS = new Set(["bytes", "fileName", "sha256"]);
const BACKUP_PROTECTED_KEYS = new Set([
  "directoryName",
  "files",
  "manifestBytes",
  "manifestFileName",
  "manifestSha256",
]);
const BACKUP_VERIFICATION_KEYS = new Set(["status", "verifiedAt"]);
const PROTECTED_MANIFEST_KEYS = new Set([
  "createdAt",
  "database",
  "files",
  "format",
  "keyCheck",
  "version",
]);
const PROTECTED_MANIFEST_DATABASE_KEYS = new Set(["fileName", "sha256"]);
const PROTECTED_MANIFEST_KEY_CHECK_KEYS = new Set(["byteSize", "fileName", "sha256"]);
const PROTECTED_MANIFEST_FILE_KEYS = new Set(["byteSize", "sha256", "storageKey"]);
const HOST_SECURITY_KEYS = new Set([
  "checkedAt",
  "checks",
  "configured",
  "format",
  "pendingConfirmation",
  "rebootRequired",
  "schemaVersion",
  "state",
]);
const HOST_SECURITY_CHECK_KEYS = new Set([
  "accountProtection",
  "automaticUpdates",
  "failedUnits",
  "firewall",
  "journald",
  "publicPorts",
  "secretFiles",
  "ssh",
  "sysctl",
  "timeSync",
]);
const CONTROL_SIGNAL_KEYS = new Set([
  "format",
  "requestId",
  "requestedAt",
  "schemaVersion",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BACKUP_MARKER_PATTERN = /^(dienstplan-[0-9A-Za-z._-]+)\.complete\.json$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROTECTED_STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;
const PROTECTED_MANIFEST_FORMAT = "grabenplaner-amu-backup";
const PROTECTED_MANIFEST_VERSION = 1;
const PROTECTED_KEY_CHECK_FILE = "key-check.amu";
const CONTROL_PENDING_FORMAT = "grabenplaner-host-reboot-pending";
const CONTROL_ARMED_FORMAT = "grabenplaner-host-reboot-armed";

class HostRebootBrokerError extends Error {
  constructor(code) {
    super(code);
    this.name = "HostRebootBrokerError";
    this.code = code;
  }
}

function fail(code) {
  throw new HostRebootBrokerError(code);
}

function exactKeys(value, expected) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function canonicalUtcTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function normalizedUtcTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/,
  );
  if (!match) return null;
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${String(match[7] || "").padEnd(3, "0").slice(0, 3)}Z`;
  const milliseconds = Date.parse(canonical);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === canonical
    ? canonical
    : null;
}

function parseRequest(buffer) {
  if (!Buffer.isBuffer(buffer)
    || buffer.length < 2
    || buffer.length > MAX_REQUEST_BYTES
    || buffer.includes(0)) {
    fail("HOST_REBOOT_REQUEST_INVALID");
  }
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    fail("HOST_REBOOT_REQUEST_INVALID");
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    fail("HOST_REBOOT_REQUEST_INVALID");
  }
  if (!exactKeys(value, REQUEST_KEYS)
    || value.format !== REQUEST_FORMAT
    || value.schemaVersion !== SCHEMA_VERSION
    || value.action !== "host-reboot"
    || !UUID_PATTERN.test(String(value.requestId || ""))
    || !BACKUP_MARKER_PATTERN.test(String(value.backupMarkerFileName || ""))) {
    fail("HOST_REBOOT_REQUEST_INVALID");
  }
  return value;
}

function response(requestId, code, options = {}) {
  const accepted = options.accepted === true;
  return {
    format: RESPONSE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    requestId: UUID_PATTERN.test(String(requestId || "")) ? requestId : crypto.randomUUID(),
    accepted,
    code,
    acceptedAt: accepted ? options.acceptedAt : null,
    retryAfterSeconds: code === "HOST_REBOOT_RATE_LIMITED" ? options.retryAfterSeconds : null,
  };
}

function assertRebootRequired(markerPath = REBOOT_REQUIRED_PATH, options = {}) {
  const resolved = path.resolve(String(markerPath || ""));
  if (resolved !== path.resolve(REBOOT_REQUIRED_PATH) && options.allowAlternateMarkerPath !== true) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  const requireRootOwner = options.requireRootOwner !== false;
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.size > 4096
    || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)
    || (requireRootOwner
      && typeof stat.uid === "number"
      && (stat.uid !== 0 || stat.gid !== 0))) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  return true;
}

function readRegularFile(filePath, maximumBytes, options = {}) {
  const failureCode = String(options.failureCode || "HOST_REBOOT_BACKUP_REQUIRED");
  let descriptor;
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || before.size < 1
      || before.size > maximumBytes
      || (process.platform !== "win32" && (before.mode & 0o022) !== 0)
      || (options.requireRootOwner === true
        && typeof before.uid === "number"
        && (before.uid !== 0 || before.gid !== 0))) {
      fail(failureCode);
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0),
    );
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== 1
      || after.size !== before.size
      || (options.requireRootOwner === true
        && typeof after.uid === "number"
        && (after.uid !== 0 || after.gid !== 0))) {
      fail(failureCode);
    }
    return { descriptor, stat: after };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof HostRebootBrokerError) throw error;
    fail(failureCode);
  }
}

function sha256Descriptor(descriptor, expectedBytes) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expectedBytes) {
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, expectedBytes - position),
      position,
    );
    if (bytesRead < 1) fail("HOST_REBOOT_BACKUP_REQUIRED");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (fs.readSync(descriptor, buffer, 0, 1, position) !== 0) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  return hash.digest("hex");
}

function assertDescriptorUnchanged(descriptor, before) {
  let after;
  try {
    after = fs.fstatSync(descriptor);
  } catch {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  if (after.dev !== before.dev
    || after.ino !== before.ino
    || after.nlink !== 1
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
}

function sha256RegularFile(filePath, expectedBytes) {
  const { descriptor, stat } = readRegularFile(filePath, expectedBytes);
  try {
    if (stat.size !== expectedBytes) fail("HOST_REBOOT_BACKUP_REQUIRED");
    const digest = sha256Descriptor(descriptor, expectedBytes);
    assertDescriptorUnchanged(descriptor, stat);
    return digest;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readExactRegularFile(filePath, expectedBytes, maximumBytes) {
  if (!Number.isSafeInteger(expectedBytes)
    || expectedBytes < 1
    || expectedBytes > maximumBytes) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  const { descriptor, stat } = readRegularFile(filePath, maximumBytes);
  try {
    if (stat.size !== expectedBytes) fail("HOST_REBOOT_BACKUP_REQUIRED");
    const content = Buffer.allocUnsafe(expectedBytes);
    let position = 0;
    while (position < expectedBytes) {
      const bytesRead = fs.readSync(
        descriptor,
        content,
        position,
        expectedBytes - position,
        position,
      );
      if (bytesRead < 1) fail("HOST_REBOOT_BACKUP_REQUIRED");
      position += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (fs.readSync(descriptor, trailing, 0, 1, position) !== 0) {
      fail("HOST_REBOOT_BACKUP_REQUIRED");
    }
    assertDescriptorUnchanged(descriptor, stat);
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function protectedComponentPath(protectedDirectory, relativePath) {
  const root = path.resolve(protectedDirectory);
  const candidate = path.resolve(root, ...String(relativePath || "").split("/"));
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  return candidate;
}

function assertProtectedDocumentTree(protectedDirectory, expectedFiles, expectedDirectories) {
  const actualFiles = new Set();
  const actualDirectories = new Set();
  const stack = [{ directory: protectedDirectory, relative: "" }];
  let entriesSeen = 0;
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = fs.readdirSync(current.directory);
    } catch {
      fail("HOST_REBOOT_BACKUP_REQUIRED");
    }
    for (const name of names) {
      entriesSeen += 1;
      if (entriesSeen > MAX_PROTECTED_TREE_ENTRIES) {
        fail("HOST_REBOOT_BACKUP_REQUIRED");
      }
      const candidate = path.join(current.directory, name);
      const relative = current.relative ? `${current.relative}/${name}` : name;
      let stat;
      try {
        stat = fs.lstatSync(candidate);
      } catch {
        fail("HOST_REBOOT_BACKUP_REQUIRED");
      }
      if (stat.isSymbolicLink()
        || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) {
        fail("HOST_REBOOT_BACKUP_REQUIRED");
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relative)) fail("HOST_REBOOT_BACKUP_REQUIRED");
        actualDirectories.add(relative);
        stack.push({ directory: candidate, relative });
      } else if (stat.isFile()
        && stat.nlink === 1
        && Number.isSafeInteger(stat.size)
        && stat.size > 0) {
        actualFiles.add(relative);
      } else {
        fail("HOST_REBOOT_BACKUP_REQUIRED");
      }
    }
  }
  if (actualFiles.size !== expectedFiles.size
    || [...actualFiles].some((relative) => !expectedFiles.has(relative))
    || actualDirectories.size !== expectedDirectories.size
    || [...actualDirectories].some((relative) => !expectedDirectories.has(relative))) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
}

function assertProtectedDocumentManifest(protectedDirectory, marker) {
  const manifestPath = protectedComponentPath(
    protectedDirectory,
    marker.protectedDocuments.manifestFileName,
  );
  const content = readExactRegularFile(
    manifestPath,
    marker.protectedDocuments.manifestBytes,
    MAX_PROTECTED_MANIFEST_BYTES,
  );
  if (crypto.createHash("sha256").update(content).digest("hex")
    !== marker.protectedDocuments.manifestSha256) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  let manifest;
  try {
    manifest = JSON.parse(content.toString("utf8"));
  } catch {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  if (!exactKeys(manifest, PROTECTED_MANIFEST_KEYS)
    || manifest.format !== PROTECTED_MANIFEST_FORMAT
    || manifest.version !== PROTECTED_MANIFEST_VERSION
    || !canonicalUtcTimestamp(manifest.createdAt)
    || Date.parse(manifest.createdAt) > Date.parse(marker.committedAt)
    || !exactKeys(manifest.database, PROTECTED_MANIFEST_DATABASE_KEYS)
    || manifest.database.fileName !== marker.database.fileName
    || manifest.database.sha256 !== marker.database.sha256
    || !exactKeys(manifest.keyCheck, PROTECTED_MANIFEST_KEY_CHECK_KEYS)
    || manifest.keyCheck.fileName !== PROTECTED_KEY_CHECK_FILE
    || !Number.isSafeInteger(manifest.keyCheck.byteSize)
    || manifest.keyCheck.byteSize < 1
    || manifest.keyCheck.byteSize > MAX_KEY_CHECK_BYTES
    || !SHA256_PATTERN.test(String(manifest.keyCheck.sha256 || ""))
    || !Array.isArray(manifest.files)
    || manifest.files.length !== marker.protectedDocuments.files
    || manifest.files.length > MAX_PROTECTED_FILES) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }

  const expectedFiles = new Set([
    marker.protectedDocuments.manifestFileName,
    PROTECTED_KEY_CHECK_FILE,
  ]);
  const expectedDirectories = new Set(["blobs"]);
  const keyCheckPath = protectedComponentPath(protectedDirectory, PROTECTED_KEY_CHECK_FILE);
  if (sha256RegularFile(keyCheckPath, manifest.keyCheck.byteSize) !== manifest.keyCheck.sha256) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }

  const storageKeys = new Set();
  for (const file of manifest.files) {
    if (!exactKeys(file, PROTECTED_MANIFEST_FILE_KEYS)
      || typeof file.storageKey !== "string"
      || !PROTECTED_STORAGE_KEY_PATTERN.test(file.storageKey)
      || storageKeys.has(file.storageKey)
      || !Number.isSafeInteger(file.byteSize)
      || file.byteSize < 1
      || file.byteSize > MAX_PROTECTED_FILE_BYTES
      || !SHA256_PATTERN.test(String(file.sha256 || ""))) {
      fail("HOST_REBOOT_BACKUP_REQUIRED");
    }
    storageKeys.add(file.storageKey);
    const relative = `blobs/${file.storageKey}`;
    expectedFiles.add(relative);
    expectedDirectories.add(`blobs/${file.storageKey.slice(0, 2)}`);
    const filePath = protectedComponentPath(protectedDirectory, relative);
    if (sha256RegularFile(filePath, file.byteSize) !== file.sha256) {
      fail("HOST_REBOOT_BACKUP_REQUIRED");
    }
  }
  assertProtectedDocumentTree(protectedDirectory, expectedFiles, expectedDirectories);
  return manifest;
}

function readBackupMarker(markerPath) {
  const { descriptor, stat } = readRegularFile(markerPath, 64 * 1024);
  try {
    return {
      marker: JSON.parse(fs.readFileSync(descriptor, "utf8")),
      stat,
    };
  } catch (error) {
    if (error instanceof HostRebootBrokerError) throw error;
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertVerifiedBackupEvidence(markerFileName, nowMs = Date.now(), options = {}) {
  if (!BACKUP_MARKER_PATTERN.test(String(markerFileName || ""))) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  const backupDirectory = path.resolve(options.backupDirectory || BACKUP_DIRECTORY);
  if (backupDirectory !== path.resolve(BACKUP_DIRECTORY)
    && options.allowAlternateBackupDirectory !== true) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(backupDirectory);
  } catch {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  if (!directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || (process.platform !== "win32"
      && (directoryStat.nlink < 2 || (directoryStat.mode & 0o022) !== 0))
    || fs.realpathSync(backupDirectory) !== backupDirectory) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }

  const match = markerFileName.match(BACKUP_MARKER_PATTERN);
  const snapshot = match?.[1] || "";
  const markerPath = path.join(backupDirectory, markerFileName);
  const { marker, stat: markerStat } = readBackupMarker(markerPath);
  if (!exactKeys(marker, BACKUP_MARKER_KEYS)
    || marker.format !== "grabenplaner-backup-commit"
    || marker.schemaVersion !== 1
    || marker.snapshot !== snapshot
    || !canonicalUtcTimestamp(marker.committedAt)
    || !exactKeys(marker.database, BACKUP_DATABASE_KEYS)
    || marker.database.fileName !== `${snapshot}.db`
    || !SHA256_PATTERN.test(String(marker.database.sha256 || ""))
    || !Number.isSafeInteger(marker.database.bytes)
    || marker.database.bytes < 1
    || !exactKeys(marker.protectedDocuments, BACKUP_PROTECTED_KEYS)
    || marker.protectedDocuments.directoryName !== `${snapshot}.amu`
    || marker.protectedDocuments.manifestFileName !== "manifest.json"
    || !SHA256_PATTERN.test(String(marker.protectedDocuments.manifestSha256 || ""))
    || !Number.isSafeInteger(marker.protectedDocuments.manifestBytes)
    || marker.protectedDocuments.manifestBytes < 1
    || marker.protectedDocuments.manifestBytes > MAX_PROTECTED_MANIFEST_BYTES
    || !Number.isSafeInteger(marker.protectedDocuments.files)
    || marker.protectedDocuments.files < 0
    || marker.protectedDocuments.files > MAX_PROTECTED_FILES
    || !exactKeys(marker.verification, BACKUP_VERIFICATION_KEYS)
    || marker.verification.status !== "verified"
    || !canonicalUtcTimestamp(marker.verification.verifiedAt)) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }

  const committedMs = Date.parse(marker.committedAt);
  const verifiedMs = Date.parse(marker.verification.verifiedAt);
  const futureToleranceMs = 60 * 1000;
  if (!Number.isFinite(nowMs)
    || committedMs > nowMs + futureToleranceMs
    || verifiedMs > nowMs + futureToleranceMs
    || verifiedMs < committedMs
    || nowMs - verifiedMs > MAX_BACKUP_AGE_SECONDS * 1000
    || Math.abs(markerStat.mtimeMs - committedMs) > futureToleranceMs) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }

  const databasePath = path.join(backupDirectory, marker.database.fileName);
  if (sha256RegularFile(databasePath, marker.database.bytes) !== marker.database.sha256) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  const protectedDirectory = path.join(
    backupDirectory,
    marker.protectedDocuments.directoryName,
  );
  let protectedStat;
  try {
    protectedStat = fs.lstatSync(protectedDirectory);
  } catch {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  if (!protectedStat.isDirectory()
    || protectedStat.isSymbolicLink()
    || (process.platform !== "win32" && (protectedStat.mode & 0o022) !== 0)
    || fs.realpathSync(protectedDirectory) !== protectedDirectory) {
    fail("HOST_REBOOT_BACKUP_REQUIRED");
  }
  assertProtectedDocumentManifest(protectedDirectory, marker);
  return {
    markerFileName,
    committedAt: marker.committedAt,
    databaseSha256: marker.database.sha256,
  };
}

function assertHostSecurityAllowsReboot(nowMs = Date.now(), options = {}) {
  const statusPath = path.resolve(
    options.hostSecurityStatusPath || HOST_SECURITY_STATUS_PATH,
  );
  if (statusPath !== path.resolve(HOST_SECURITY_STATUS_PATH)
    && options.allowAlternateHostSecurityStatusPath !== true) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  const { descriptor } = readRegularFile(statusPath, 16 * 1024, {
    failureCode: "HOST_REBOOT_CONTROL_FAILED",
    requireRootOwner: options.requireRootOwner !== false,
  });
  let value;
  try {
    value = JSON.parse(fs.readFileSync(descriptor, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    fail("HOST_REBOOT_CONTROL_FAILED");
  } finally {
    fs.closeSync(descriptor);
  }
  const checkedAt = normalizedUtcTimestamp(value?.checkedAt);
  if (!exactKeys(value, HOST_SECURITY_KEYS)
    || value.format !== "grabenplaner-host-security-status"
    || value.schemaVersion !== 1
    || !["ok", "warning", "error"].includes(value.state)
    || typeof value.configured !== "boolean"
    || typeof value.pendingConfirmation !== "boolean"
    || typeof value.rebootRequired !== "boolean"
    || !exactKeys(value.checks, HOST_SECURITY_CHECK_KEYS)
    || [...HOST_SECURITY_CHECK_KEYS].some(
      (key) => typeof value.checks[key] !== "boolean" && value.checks[key] !== null,
    )
    || !checkedAt) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  if (value.pendingConfirmation) fail("HOST_REBOOT_SECURITY_PENDING");
  const ageMs = nowMs - Date.parse(checkedAt);
  if (!value.configured
    || !value.rebootRequired
    || !Number.isFinite(ageMs)
    || ageMs < -(5 * 60 * 1000)
    || ageMs > 36 * 60 * 60 * 1000) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  return true;
}

function assertStateDirectory(statePath, options = {}) {
  const directory = path.dirname(path.resolve(statePath));
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || (process.platform !== "win32"
      && (stat.nlink < 2
        || ![0o700, 0o755].includes(stat.mode & 0o7777)
        || (stat.mode & 0o022) !== 0))
    || (options.requireRootOwner !== false
      && typeof stat.uid === "number"
      && (stat.uid !== 0 || stat.gid !== 0))) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  return directory;
}

function assertMaintenanceLock(options = {}) {
  const lockPath = path.resolve(options.maintenanceLockPath || MAINTENANCE_LOCK_PATH);
  if (lockPath !== path.resolve(MAINTENANCE_LOCK_PATH)
    && options.allowAlternateMaintenanceLockPath !== true) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  const directory = path.dirname(lockPath);
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  if (!directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || (process.platform !== "win32"
      && (directoryStat.nlink < 2
        || (directoryStat.mode & 0o7777) !== 0o755
        || (directoryStat.mode & 0o022) !== 0))
    || (options.requireRootOwner !== false
      && typeof directoryStat.uid === "number"
      && (directoryStat.uid !== 0 || directoryStat.gid !== 0))) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600)
    || (options.requireRootOwner !== false
      && typeof stat.uid === "number"
      && (stat.uid !== 0 || stat.gid !== 0))) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  return lockPath;
}

function ensureMaintenanceLock(options = {}) {
  const lockPath = path.resolve(options.maintenanceLockPath || MAINTENANCE_LOCK_PATH);
  if (lockPath !== path.resolve(MAINTENANCE_LOCK_PATH)
    && options.allowAlternateMaintenanceLockPath !== true) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  const directory = path.dirname(lockPath);
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  if (!directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || (process.platform !== "win32"
      && (directoryStat.nlink < 2
        || (directoryStat.mode & 0o7777) !== 0o755
        || directoryStat.uid !== 0
        || directoryStat.gid !== 0))) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  if (!fs.existsSync(lockPath)) {
    let descriptor;
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0)
          | (fs.constants.O_CLOEXEC || 0),
        0o600,
      );
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (error?.code !== "EEXIST") fail("HOST_REBOOT_CONTROL_FAILED");
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return assertMaintenanceLock(options);
}

function maintenanceLockBusy(options = {}) {
  const lockPath = assertMaintenanceLock(options);
  const runner = options.spawnSync || childProcess.spawnSync;
  const result = runner(
    FLOCK,
    ["--exclusive", "--nonblock", lockPath, TRUE],
    {
      timeout: 2000,
      stdio: "ignore",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    },
  );
  if (result?.error) fail("HOST_REBOOT_CONTROL_FAILED");
  if (result?.status === 1) return true;
  if (result?.status !== 0) fail("HOST_REBOOT_CONTROL_FAILED");
  return false;
}

function controlSignalValue(format, requestId, requestedAt) {
  const value = {
    format,
    schemaVersion: 1,
    requestId,
    requestedAt,
  };
  if (!exactKeys(value, CONTROL_SIGNAL_KEYS)
    || ![CONTROL_PENDING_FORMAT, CONTROL_ARMED_FORMAT].includes(format)
    || !UUID_PATTERN.test(String(requestId || ""))
    || !canonicalUtcTimestamp(requestedAt)) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  return value;
}

function writeControlSignal(signalPath, value, options = {}) {
  const directory = assertStateDirectory(signalPath, options);
  controlSignalValue(value.format, value.requestId, value.requestedAt);
  const temporary = path.join(
    directory,
    `.signal.${process.pid}.${crypto.randomBytes(8).toString("hex")}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_CLOEXEC || 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, signalPath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // best effort
    }
    if (error instanceof HostRebootBrokerError) throw error;
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
}

function readControlSignal(signalPath, expectedFormat, options = {}) {
  const { descriptor } = readRegularFile(signalPath, 4096, {
    failureCode: "HOST_REBOOT_CONTROL_FAILED",
    requireRootOwner: options.requireRootOwner !== false,
  });
  try {
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    controlSignalValue(value?.format, value?.requestId, value?.requestedAt);
    if (value.format !== expectedFormat) fail("HOST_REBOOT_CONTROL_FAILED");
    return value;
  } catch (error) {
    if (error instanceof HostRebootBrokerError) throw error;
    fail("HOST_REBOOT_CONTROL_FAILED");
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeControlSignal(signalPath, options = {}) {
  if (!fs.existsSync(signalPath)) return;
  const { descriptor } = readRegularFile(signalPath, 4096, {
    failureCode: "HOST_REBOOT_CONTROL_FAILED",
    requireRootOwner: options.requireRootOwner !== false,
  });
  fs.closeSync(descriptor);
  try {
    fs.unlinkSync(signalPath);
  } catch {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
}

function readRateLimitState(statePath = STATE_PATH, options = {}) {
  assertStateDirectory(statePath, options);
  if (!fs.existsSync(statePath)) return null;
  let descriptor;
  try {
    const before = fs.lstatSync(statePath);
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || before.size < 2
      || before.size > 4096
      || (process.platform !== "win32" && (before.mode & 0o7777) !== 0o600)
      || (options.requireRootOwner !== false
        && typeof before.uid === "number"
        && (before.uid !== 0 || before.gid !== 0))) {
      fail("HOST_REBOOT_CONTROL_FAILED");
    }
    descriptor = fs.openSync(
      statePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_CLOEXEC || 0),
    );
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== 1
      || after.size !== before.size) {
      fail("HOST_REBOOT_CONTROL_FAILED");
    }
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!exactKeys(value, STATE_KEYS)
      || value.format !== STATE_FORMAT
      || value.schemaVersion !== STATE_SCHEMA_VERSION
      || !UUID_PATTERN.test(String(value.lastRequestId || ""))
      || !canonicalUtcTimestamp(value.lastAcceptedAt)) {
      fail("HOST_REBOOT_CONTROL_FAILED");
    }
    return value;
  } catch (error) {
    if (error instanceof HostRebootBrokerError) throw error;
    fail("HOST_REBOOT_CONTROL_FAILED");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeRateLimitState(statePath, value, options = {}) {
  const directory = assertStateDirectory(statePath, options);
  if (!exactKeys(value, STATE_KEYS)
    || value.format !== STATE_FORMAT
    || value.schemaVersion !== STATE_SCHEMA_VERSION
    || !UUID_PATTERN.test(String(value.lastRequestId || ""))
    || !canonicalUtcTimestamp(value.lastAcceptedAt)) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  const temporary = path.join(directory, `.state.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_CLOEXEC || 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, statePath);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(
        directory,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
      );
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // best effort
    }
    if (error instanceof HostRebootBrokerError) throw error;
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
}

function systemctlUnitState(options = {}) {
  const runner = options.spawnSync || childProcess.spawnSync;
  const result = runner(
    SYSTEMCTL,
    [
      "show",
      "--property=LoadState",
      "--property=FragmentPath",
      "--property=ActiveState",
      REBOOT_UNIT,
    ],
    {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    },
  );
  if (result?.error
    || result?.status !== 0
    || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > 768
    || result.stdout.includes("\0")
    || result.stdout.includes("\r")) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  const values = {};
  for (const line of result.stdout.trimEnd().split("\n")) {
    const match = line.match(/^(LoadState|FragmentPath|ActiveState)=(.*)$/);
    if (!match || Object.hasOwn(values, match[1])) fail("HOST_REBOOT_CONTROL_FAILED");
    values[match[1]] = match[2];
  }
  if (Object.keys(values).length !== 3) fail("HOST_REBOOT_CONTROL_FAILED");
  return values;
}

function rebootUnitBusy(options = {}) {
  const state = systemctlUnitState(options);
  if (state.LoadState !== "loaded") fail("HOST_REBOOT_CONTROL_FAILED");
  if (state.FragmentPath !== REBOOT_UNIT_FRAGMENT) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  const activeState = state.ActiveState;
  if (["active", "activating", "reloading", "deactivating"].includes(activeState)) return true;
  if (!["inactive", "failed"].includes(activeState)) fail("HOST_REBOOT_CONTROL_FAILED");
  return false;
}

function sleepSynchronously(milliseconds) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function startRebootUnit(requestId, acceptedAt, options = {}) {
  const pendingPath = options.pendingPath || CONTROL_PENDING_PATH;
  const armedPath = options.armedPath || CONTROL_ARMED_PATH;
  removeControlSignal(armedPath, options);
  writeControlSignal(
    pendingPath,
    controlSignalValue(CONTROL_PENDING_FORMAT, requestId, acceptedAt),
    options,
  );
  const runner = options.spawnSync || childProcess.spawnSync;
  const result = runner(
    SYSTEMCTL,
    ["start", "--no-block", REBOOT_UNIT],
    {
      timeout: 5000,
      stdio: "ignore",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    },
  );
  if (result?.error || result?.status !== 0) fail("HOST_REBOOT_CONTROL_FAILED");
  if (typeof options.afterUnitStart === "function") {
    options.afterUnitStart({ armedPath, requestId, acceptedAt });
  }
  const deadline = Date.now() + (Number.isSafeInteger(options.armedTimeoutMs)
    ? Math.max(100, Math.min(options.armedTimeoutMs, 5000))
    : 4000);
  while (Date.now() < deadline) {
    try {
      const armed = readControlSignal(armedPath, CONTROL_ARMED_FORMAT, options);
      if (armed.requestId === requestId && armed.requestedAt === acceptedAt) return;
      fail("HOST_REBOOT_CONTROL_FAILED");
    } catch (error) {
      if (error?.code !== "HOST_REBOOT_CONTROL_FAILED" || fs.existsSync(armedPath)) throw error;
    }
    sleepSynchronously(50);
  }
  fail("HOST_REBOOT_CONTROL_FAILED");
}

function executePendingReboot(options = {}) {
  const pendingPath = options.pendingPath || CONTROL_PENDING_PATH;
  const armedPath = options.armedPath || CONTROL_ARMED_PATH;
  const pending = readControlSignal(pendingPath, CONTROL_PENDING_FORMAT, options);
  const ageMs = Date.now() - Date.parse(pending.requestedAt);
  if (!Number.isFinite(ageMs) || ageMs < -5000 || ageMs > 30_000) {
    fail("HOST_REBOOT_CONTROL_FAILED");
  }
  writeControlSignal(
    armedPath,
    controlSignalValue(CONTROL_ARMED_FORMAT, pending.requestId, pending.requestedAt),
    options,
  );
  sleepSynchronously(Number.isSafeInteger(options.rebootDelayMs)
    ? Math.max(0, Math.min(options.rebootDelayMs, 5000))
    : 5000);
  const runner = options.spawnSync || childProcess.spawnSync;
  const result = runner(
    SYSTEMCTL,
    ["reboot", "--no-wall"],
    {
      timeout: 5000,
      stdio: "ignore",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    },
  );
  if (result?.error || result?.status !== 0) fail("HOST_REBOOT_CONTROL_FAILED");
}

function handleRequest(buffer, options = {}) {
  let request;
  try {
    request = parseRequest(buffer);
  } catch (error) {
    return response(
      null,
      error?.code === "HOST_REBOOT_REQUEST_INVALID"
        ? error.code
        : "HOST_REBOOT_CONTROL_FAILED",
    );
  }

  try {
    const markerPath = options.rebootRequiredPath || REBOOT_REQUIRED_PATH;
    const markerReady = assertRebootRequired(markerPath, {
      ...options,
      allowAlternateMarkerPath: options.allowAlternateMarkerPath === true,
    });
    if (!markerReady) return response(request.requestId, "HOST_REBOOT_NOT_REQUIRED");
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const now = new Date(nowMs);
    if (!Number.isFinite(now.getTime())) fail("HOST_REBOOT_CONTROL_FAILED");
    assertHostSecurityAllowsReboot(nowMs, options);
    if (maintenanceLockBusy(options)) {
      return response(request.requestId, "HOST_REBOOT_MAINTENANCE_BUSY");
    }
    if (rebootUnitBusy(options)) return response(request.requestId, "HOST_REBOOT_BUSY");

    assertVerifiedBackupEvidence(request.backupMarkerFileName, nowMs, options);
    const statePath = options.statePath || STATE_PATH;
    const state = readRateLimitState(statePath, options);
    if (state) {
      const elapsedSeconds = Math.floor((nowMs - Date.parse(state.lastAcceptedAt)) / 1000);
      if (!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0) {
        fail("HOST_REBOOT_CONTROL_FAILED");
      }
      if (elapsedSeconds < RATE_LIMIT_SECONDS) {
        return response(request.requestId, "HOST_REBOOT_RATE_LIMITED", {
          retryAfterSeconds: RATE_LIMIT_SECONDS - elapsedSeconds,
        });
      }
    }

    const acceptedAt = now.toISOString();
    // Reserve the root-side cooldown before starting the fixed unit. If
    // systemd rejects the start, retaining the slot fails closed.
    writeRateLimitState(statePath, {
      format: STATE_FORMAT,
      schemaVersion: STATE_SCHEMA_VERSION,
      lastAcceptedAt: acceptedAt,
      lastRequestId: request.requestId,
    }, options);
    startRebootUnit(request.requestId, acceptedAt, options);
    return response(request.requestId, "HOST_REBOOT_ACCEPTED", {
      accepted: true,
      acceptedAt,
    });
  } catch (error) {
    return response(
      request.requestId,
      ["HOST_REBOOT_BACKUP_REQUIRED", "HOST_REBOOT_SECURITY_PENDING"].includes(error?.code)
        ? error.code
        : "HOST_REBOOT_CONTROL_FAILED",
    );
  }
}

function readStandardInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(
      () => reject(new HostRebootBrokerError("HOST_REBOOT_REQUEST_INVALID")),
      2000,
    );
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        clearTimeout(timer);
        process.stdin.destroy();
        reject(new HostRebootBrokerError("HOST_REBOOT_REQUEST_INVALID"));
      } else {
        chunks.push(chunk);
      }
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      reject(new HostRebootBrokerError("HOST_REBOOT_REQUEST_INVALID"));
    });
  });
}

async function main() {
  if (process.platform !== "linux"
    || typeof process.getuid !== "function"
    || process.getuid() !== 0) {
    process.exitCode = 1;
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === "--execute-pending-reboot") {
    try {
      executePendingReboot();
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === "--ensure-maintenance-lock") {
    try {
      ensureMaintenanceLock();
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  if (process.argv.length !== 2) {
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    result = handleRequest(await readStandardInput());
  } catch {
    result = response(null, "HOST_REBOOT_REQUEST_INVALID");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_BACKUP_AGE_SECONDS,
  RATE_LIMIT_SECONDS,
  BACKUP_DIRECTORY,
  CONTROL_ARMED_PATH,
  CONTROL_PENDING_PATH,
  HOST_SECURITY_STATUS_PATH,
  MAINTENANCE_LOCK_PATH,
  REBOOT_REQUIRED_PATH,
  REBOOT_UNIT,
  REBOOT_UNIT_FRAGMENT,
  REQUEST_FORMAT,
  RESPONSE_FORMAT,
  SCHEMA_VERSION,
  STATE_FORMAT,
  STATE_PATH,
  STATE_SCHEMA_VERSION,
  HostRebootBrokerError,
  assertRebootRequired,
  assertHostSecurityAllowsReboot,
  assertMaintenanceLock,
  assertVerifiedBackupEvidence,
  executePendingReboot,
  ensureMaintenanceLock,
  handleRequest,
  maintenanceLockBusy,
  parseRequest,
  readRateLimitState,
  rebootUnitBusy,
  startRebootUnit,
  writeRateLimitState,
};
