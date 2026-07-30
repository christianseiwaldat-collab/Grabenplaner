"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BACKUP_BUNDLE_FORMAT = "grabenplaner-backup-bundle";
const BACKUP_BUNDLE_SCHEMA_VERSION = 2;
const BACKUP_BUNDLE_METHODS = Object.freeze({
  sqlite: "sqlite-vacuum-into",
  postgresql: "postgresql-pg-dump-custom",
});
const BACKUP_BUNDLE_DATABASE_FORMATS = Object.freeze({
  sqlite: "sqlite3",
  postgresql: "postgresql-custom",
});
const BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS = Object.freeze([
  "databaseComponent",
  "protectedDocumentsComponent",
  "providerMethod",
]);

const PROVIDER_IDS = new Set(Object.keys(BACKUP_BUNDLE_METHODS));
const METHOD_PROVIDER = new Map(
  Object.entries(BACKUP_BUNDLE_METHODS).map(([providerId, method]) => [method, providerId]),
);
const SNAPSHOT_PATTERN = /^dienstplan-[0-9A-Za-z][0-9A-Za-z._-]{0,170}$/;
const SAFE_LEAF_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,190}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PROTECTED_STORAGE_KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/;
const PROTECTED_MANIFEST_FORMAT = "grabenplaner-amu-backup";
const PROTECTED_MANIFEST_VERSION = 1;
const PROTECTED_KEY_CHECK_FILE = "key-check.amu";
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_TREE_ENTRIES = 100_000;
const MAX_BUNDLE_CANDIDATES = 10_000;
const TOP_LEVEL_KEYS = new Set([
  "format",
  "schemaVersion",
  "providerId",
  "method",
  "snapshotId",
  "createdAt",
  "appVersion",
  "database",
  "protectedDocuments",
  "verification",
  "bundleHash",
]);
const HASH_PAYLOAD_KEYS = new Set([...TOP_LEVEL_KEYS].filter((key) => key !== "bundleHash"));
const DATABASE_KEYS = new Set(["fileName", "sha256", "bytes", "format", "toolMajor"]);
const PROTECTED_DOCUMENT_KEYS = new Set([
  "directoryName",
  "manifestFileName",
  "manifestSha256",
  "manifestBytes",
  "files",
  "bytes",
]);
const VERIFICATION_KEYS = new Set(["status", "verifiedAt", "checks"]);
const VERIFICATION_CHECK_KEYS = new Set(BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS);
const PROTECTED_MANIFEST_FILE_KEYS = new Set(["storageKey", "byteSize", "sha256"]);
const PROTECTED_KEY_CHECK_KEYS = new Set(["fileName", "byteSize", "sha256"]);
const PROTECTED_MANIFEST_KEYS = new Set([
  "format",
  "version",
  "createdAt",
  "database",
  "snapshot",
  "keyCheck",
  "files",
]);
const PROTECTED_MANIFEST_DATABASE_KEYS = new Set(["fileName", "sha256"]);
const PROTECTED_MANIFEST_SNAPSHOT_KEYS = new Set([
  "providerId",
  "method",
  "snapshotId",
  "sourceEvidenceFingerprint",
  "referenceCount",
]);
const WRITE_OPTION_KEYS = new Set(["backupDirectory", ...HASH_PAYLOAD_KEYS]);
const VERIFY_OPTION_KEYS = new Set(["expectedProviderId", "expectedMethod"]);
const LIST_OPTION_KEYS = new Set(["limit", "providerId", "method"]);

class BackupBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupBundleError";
    this.code = code;
  }
}

function bundleError(code, message) {
  return new BackupBundleError(code, message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  if (!isPlainRecord(value)
    || Object.keys(value).length !== expected.size
    || Object.keys(value).some((key) => !expected.has(key))) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} entspricht nicht dem freigegebenen Schema.`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} enthaelt unzulaessige Felder.`);
  }
}

function assertSnapshotId(value) {
  if (typeof value !== "string" || !SNAPSHOT_PATTERN.test(value)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Die Bundle-Snapshotkennung ist ungueltig.");
  }
  return value;
}

function assertSafeLeaf(value, label) {
  if (typeof value !== "string"
    || !SAFE_LEAF_PATTERN.test(value)
    || value === "."
    || value === ".."
    || path.basename(value) !== value
    || /[\\/]/.test(value)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} ist ungueltig.`);
  }
  return value;
}

function assertComponentName(value, snapshotId, label) {
  const name = assertSafeLeaf(value, label);
  if (!name.startsWith(`${snapshotId}.`)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} ist nicht an die Snapshotkennung gebunden.`);
  }
  return name;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} ist ungueltig.`);
  }
  return value;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} ist ungueltig.`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} ist ungueltig.`);
  }
  return value;
}

function assertCanonicalTimestamp(value, label) {
  if (typeof value !== "string") {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} ist kein kanonischer UTC-Zeitstempel.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", `${label} ist kein kanonischer UTC-Zeitstempel.`);
  }
  return value;
}

function assertProviderMethod(providerId, method, databaseFormat) {
  if (!PROVIDER_IDS.has(providerId)
    || BACKUP_BUNDLE_METHODS[providerId] !== method
    || BACKUP_BUNDLE_DATABASE_FORMATS[providerId] !== databaseFormat) {
    throw bundleError(
      "BACKUP_BUNDLE_PROVIDER_MISMATCH",
      "Provider, Sicherungsmethode und Datenbankformat passen nicht zusammen.",
    );
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Der Bundle-Hash enthaelt eine ungueltige Zahl.");
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainRecord(value)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Der Bundle-Hash enthaelt einen ungueltigen Wert.");
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function markerHashPayload(marker) {
  return Object.fromEntries(
    [...HASH_PAYLOAD_KEYS].map((key) => [key, marker[key]]),
  );
}

function computeBackupBundleHash(marker) {
  return crypto.createHash("sha256")
    .update(canonicalJson(markerHashPayload(marker)), "utf8")
    .digest("hex");
}

function normalizedVerification(value) {
  assertExactKeys(value, VERIFICATION_KEYS, "Der Bundle-Verifikationsbeleg");
  if (value.status !== "verified") {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Der Bundle-Verifikationsstatus ist ungueltig.");
  }
  assertExactKeys(value.checks, VERIFICATION_CHECK_KEYS, "Die Bundle-Verifikationspruefungen");
  if (BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS.some((key) => value.checks[key] !== true)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Das Bundle ist nicht vollstaendig verifiziert.");
  }
  return Object.freeze({
    status: "verified",
    verifiedAt: assertCanonicalTimestamp(value.verifiedAt, "verification.verifiedAt"),
    checks: Object.freeze(Object.fromEntries(
      BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS.map((key) => [key, true]),
    )),
  });
}

function normalizeBackupBundleMarker(marker, expectedSnapshotId) {
  assertExactKeys(marker, TOP_LEVEL_KEYS, "Der Backup-Bundle-Commitmarker");
  if (marker.format !== BACKUP_BUNDLE_FORMAT
    || marker.schemaVersion !== BACKUP_BUNDLE_SCHEMA_VERSION) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Das Backup-Bundle-Format wird nicht unterstuetzt.");
  }
  const snapshotId = assertSnapshotId(marker.snapshotId);
  if (expectedSnapshotId !== undefined && snapshotId !== expectedSnapshotId) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Markername und Snapshotkennung widersprechen einander.");
  }
  const createdAt = assertCanonicalTimestamp(marker.createdAt, "createdAt");
  if (typeof marker.appVersion !== "string" || !SEMVER_PATTERN.test(marker.appVersion)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Die App-Version des Backup-Bundles ist ungueltig.");
  }

  assertExactKeys(marker.database, DATABASE_KEYS, "Die Datenbankkomponente");
  assertExactKeys(
    marker.protectedDocuments,
    PROTECTED_DOCUMENT_KEYS,
    "Die geschuetzte Dokumentkomponente",
  );
  const verification = normalizedVerification(marker.verification);
  if (Date.parse(verification.verifiedAt) < Date.parse(createdAt)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Der Verifikationszeitpunkt liegt vor dem Sicherungszeitpunkt.");
  }
  assertProviderMethod(marker.providerId, marker.method, marker.database.format);

  const database = Object.freeze({
    fileName: assertComponentName(marker.database.fileName, snapshotId, "database.fileName"),
    sha256: assertSha256(marker.database.sha256, "database.sha256"),
    bytes: assertPositiveSafeInteger(marker.database.bytes, "database.bytes"),
    format: marker.database.format,
    toolMajor: assertPositiveSafeInteger(marker.database.toolMajor, "database.toolMajor"),
  });
  if (database.toolMajor > 999) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "database.toolMajor ist ungueltig.");
  }

  const protectedDocuments = Object.freeze({
    directoryName: assertComponentName(
      marker.protectedDocuments.directoryName,
      snapshotId,
      "protectedDocuments.directoryName",
    ),
    manifestFileName: assertSafeLeaf(
      marker.protectedDocuments.manifestFileName,
      "protectedDocuments.manifestFileName",
    ),
    manifestSha256: assertSha256(
      marker.protectedDocuments.manifestSha256,
      "protectedDocuments.manifestSha256",
    ),
    manifestBytes: assertPositiveSafeInteger(
      marker.protectedDocuments.manifestBytes,
      "protectedDocuments.manifestBytes",
    ),
    files: assertNonNegativeSafeInteger(
      marker.protectedDocuments.files,
      "protectedDocuments.files",
    ),
    bytes: assertPositiveSafeInteger(
      marker.protectedDocuments.bytes,
      "protectedDocuments.bytes",
    ),
  });
  if (protectedDocuments.manifestFileName !== "manifest.json"
    || protectedDocuments.bytes < protectedDocuments.manifestBytes
    || protectedDocuments.directoryName === database.fileName) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Die geschuetzte Dokumentkomponente ist ungueltig.");
  }

  const normalized = {
    format: BACKUP_BUNDLE_FORMAT,
    schemaVersion: BACKUP_BUNDLE_SCHEMA_VERSION,
    providerId: marker.providerId,
    method: marker.method,
    snapshotId,
    createdAt,
    appVersion: marker.appVersion,
    database,
    protectedDocuments,
    verification,
    bundleHash: assertSha256(marker.bundleHash, "bundleHash"),
  };
  if (computeBackupBundleHash(normalized) !== normalized.bundleHash) {
    throw bundleError("BACKUP_BUNDLE_HASH_MISMATCH", "Der Backup-Bundle-Hash stimmt nicht.");
  }
  return Object.freeze(normalized);
}

function assertSafeRoot(backupDirectory) {
  if (typeof backupDirectory !== "string" || !backupDirectory.trim()) {
    throw bundleError("BACKUP_BUNDLE_PATH_INVALID", "Der Backup-Bundle-Ordner ist ungueltig.");
  }
  const root = path.resolve(backupDirectory);
  if (root === path.parse(root).root) {
    throw bundleError("BACKUP_BUNDLE_PATH_INVALID", "Der Backup-Bundle-Ordner ist ungueltig.");
  }
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    throw bundleError("BACKUP_BUNDLE_PATH_INVALID", "Der Backup-Bundle-Ordner ist nicht sicher lesbar.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw bundleError("BACKUP_BUNDLE_PATH_INVALID", "Der Backup-Bundle-Ordner ist nicht sicher lesbar.");
  }
  return root;
}

function componentPath(root, name) {
  const target = path.join(root, assertSafeLeaf(name, "Der Komponentenname"));
  if (path.dirname(target) !== root) {
    throw bundleError("BACKUP_BUNDLE_PATH_INVALID", "Eine Bundle-Komponente verlaesst den Sicherungsordner.");
  }
  return target;
}

function assertRegularStat(stat, label, { maximumBytes = Number.MAX_SAFE_INTEGER } = {}) {
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size)
    || stat.size <= 0
    || stat.size > maximumBytes) {
    throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", `${label} ist keine sichere regulaere Datei.`);
  }
}

function openRegularFile(file, label, options = {}) {
  let pathStat;
  try {
    pathStat = fs.lstatSync(file);
    assertRegularStat(pathStat, label, options);
  } catch (error) {
    if (error instanceof BackupBundleError) throw error;
    throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", `${label} ist nicht sicher lesbar.`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const descriptorStat = fs.fstatSync(descriptor);
    assertRegularStat(descriptorStat, label, options);
    if (descriptorStat.dev !== pathStat.dev
      || descriptorStat.ino !== pathStat.ino
      || descriptorStat.size !== pathStat.size) {
      throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", `${label} wurde beim Oeffnen ausgetauscht.`);
    }
    return { descriptor, stat: descriptorStat };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error instanceof BackupBundleError) throw error;
    throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", `${label} ist nicht sicher lesbar.`);
  }
}

function readRegularFile(file, label, options = {}) {
  const { descriptor, stat } = openRegularFile(file, label, options);
  try {
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", `${label} wurde waehrend des Lesens veraendert.`);
    }
    return { content, stat };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256RegularFile(file, label, options = {}) {
  const { descriptor, stat } = openRegularFile(file, label, options);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (position < stat.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (bytesRead <= 0) {
        throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", `${label} endete unerwartet.`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", `${label} wurde waehrend des Lesens veraendert.`);
    }
    return { sha256: hash.digest("hex"), stat };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJsonRegularFile(file, label, options = {}) {
  const { content, stat } = readRegularFile(file, label, options);
  try {
    return {
      value: JSON.parse(content.toString("utf8").replace(/^\uFEFF/, "")),
      stat,
    };
  } catch {
    throw bundleError("BACKUP_BUNDLE_JSON_INVALID", `${label} enthaelt kein gueltiges JSON.`);
  }
}

function inspectProtectedDocumentTree(directory, manifestFileName, binding) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(directory);
  } catch {
    throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", "Der geschuetzte Dokumentordner fehlt.");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", "Der geschuetzte Dokumentordner ist unsicher.");
  }

  const manifestPath = path.join(directory, manifestFileName);
  const stack = [directory];
  const actualFiles = new Set();
  let entriesSeen = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    let names;
    try {
      names = fs.readdirSync(current);
    } catch {
      throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", "Der geschuetzte Dokumentbaum ist nicht sicher lesbar.");
    }
    for (const name of names) {
      entriesSeen += 1;
      if (entriesSeen > MAX_DOCUMENT_TREE_ENTRIES) {
        throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", "Der geschuetzte Dokumentbaum ist zu gross.");
      }
      const candidate = path.join(current, name);
      let stat;
      try {
        stat = fs.lstatSync(candidate);
      } catch {
        throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", "Der geschuetzte Dokumentbaum ist instabil.");
      }
      if (stat.isSymbolicLink()) {
        throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", "Der geschuetzte Dokumentbaum enthaelt einen Link.");
      }
      if (stat.isDirectory()) {
        stack.push(candidate);
      } else if (stat.isFile() && stat.nlink === 1 && Number.isSafeInteger(stat.size) && stat.size >= 0) {
        actualFiles.add(path.relative(directory, candidate).split(path.sep).join("/"));
        bytes += stat.size;
        if (!Number.isSafeInteger(bytes)) {
          throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", "Der geschuetzte Dokumentbaum ist zu gross.");
        }
      } else {
        throw bundleError("BACKUP_BUNDLE_FILE_UNSAFE", "Der geschuetzte Dokumentbaum enthaelt einen unzulaessigen Eintrag.");
      }
    }
  }

  const { value: manifest, stat: manifestStat } = readJsonRegularFile(
    manifestPath,
    "Das geschuetzte Dokumentmanifest",
    { maximumBytes: MAX_MANIFEST_BYTES },
  );
  if (!isPlainRecord(manifest) || !Array.isArray(manifest.files)) {
    throw bundleError(
      "BACKUP_BUNDLE_JSON_INVALID",
      "Das geschuetzte Dokumentmanifest enthaelt keine gueltige Dateiliste.",
    );
  }
  if (manifest.files.length > MAX_DOCUMENT_TREE_ENTRIES) {
    throw bundleError(
      "BACKUP_BUNDLE_JSON_INVALID",
      "Die Dateiliste des geschuetzten Dokumentmanifests ist zu gross.",
    );
  }
  if (manifest.format !== PROTECTED_MANIFEST_FORMAT
    || manifest.version !== PROTECTED_MANIFEST_VERSION) {
    throw bundleError(
      "BACKUP_BUNDLE_JSON_INVALID",
      "Das Format des geschuetzten Dokumentmanifests wird nicht unterstuetzt.",
    );
  }
  assertExactKeys(
    manifest,
    PROTECTED_MANIFEST_KEYS,
    "Das geschuetzte Dokumentmanifest",
  );
  assertCanonicalTimestamp(
    manifest.createdAt,
    "protectedDocuments.createdAt",
  );
  assertExactKeys(
    manifest.database,
    PROTECTED_MANIFEST_DATABASE_KEYS,
    "Die Datenbankbindung des geschuetzten Dokumentmanifests",
  );
  assertExactKeys(
    manifest.snapshot,
    PROTECTED_MANIFEST_SNAPSHOT_KEYS,
    "Die Snapshotbindung des geschuetzten Dokumentmanifests",
  );
  const referenceCount = assertNonNegativeSafeInteger(
    manifest.snapshot.referenceCount,
    "protectedDocuments.snapshot.referenceCount",
  );
  if (manifest.database.fileName !== binding.database.fileName
    || assertSha256(
      manifest.database.sha256,
      "protectedDocuments.database.sha256",
    ) !== binding.database.sha256
    || manifest.snapshot.providerId !== binding.providerId
    || manifest.snapshot.method !== binding.method
    || manifest.snapshot.snapshotId !== binding.snapshotId
    || !SHA256_PATTERN.test(String(manifest.snapshot.sourceEvidenceFingerprint || ""))
    || referenceCount > manifest.files.length
    || Date.parse(manifest.createdAt) < Date.parse(binding.createdAt)
    || Date.parse(manifest.createdAt) > Date.parse(binding.verifiedAt)) {
    throw bundleError(
      "BACKUP_BUNDLE_COMPONENT_MISMATCH",
      "Datenbank, Snapshot und geschuetztes Dokumentmanifest gehoeren nicht zusammen.",
    );
  }
  assertExactKeys(
    manifest.keyCheck,
    PROTECTED_KEY_CHECK_KEYS,
    "Der Schluesselpruefwert des geschuetzten Dokumentmanifests",
  );
  if (manifest.keyCheck.fileName !== PROTECTED_KEY_CHECK_FILE) {
    throw bundleError(
      "BACKUP_BUNDLE_JSON_INVALID",
      "Der Schluesselpruefwert des geschuetzten Dokumentmanifests ist ungueltig.",
    );
  }
  const expectedFiles = new Set([manifestFileName, PROTECTED_KEY_CHECK_FILE]);
  const keyCheckPath = path.join(directory, PROTECTED_KEY_CHECK_FILE);
  const keyCheckVerification = sha256RegularFile(
    keyCheckPath,
    "Der Schluesselpruefwert der geschuetzten Dokumentkomponente",
  );
  if (keyCheckVerification.stat.size !== assertPositiveSafeInteger(
    manifest.keyCheck.byteSize,
    "protectedDocuments.keyCheck.byteSize",
  ) || keyCheckVerification.sha256 !== assertSha256(
    manifest.keyCheck.sha256,
    "protectedDocuments.keyCheck.sha256",
  )) {
    throw bundleError(
      "BACKUP_BUNDLE_COMPONENT_MISMATCH",
      "Der Schluesselpruefwert passt nicht zum geschuetzten Dokumentmanifest.",
    );
  }
  const storageKeys = new Set();
  for (const file of manifest.files) {
    assertExactKeys(file, PROTECTED_MANIFEST_FILE_KEYS, "Ein geschuetzter Dokumenteintrag");
    if (typeof file.storageKey !== "string"
      || !PROTECTED_STORAGE_KEY_PATTERN.test(file.storageKey)
      || storageKeys.has(file.storageKey)) {
      throw bundleError(
        "BACKUP_BUNDLE_JSON_INVALID",
        "Das geschuetzte Dokumentmanifest enthaelt einen ungueltigen Speicherschluessel.",
      );
    }
    storageKeys.add(file.storageKey);
    const relativeFile = `blobs/${file.storageKey}`;
    expectedFiles.add(relativeFile);
    const documentVerification = sha256RegularFile(
      path.join(directory, ...relativeFile.split("/")),
      `Die geschuetzte Dokumentdatei ${file.storageKey}`,
    );
    if (documentVerification.stat.size !== assertPositiveSafeInteger(
      file.byteSize,
      "protectedDocuments.files.byteSize",
    ) || documentVerification.sha256 !== assertSha256(
      file.sha256,
      "protectedDocuments.files.sha256",
    )) {
      throw bundleError(
        "BACKUP_BUNDLE_COMPONENT_MISMATCH",
        `Die geschuetzte Dokumentdatei ${file.storageKey} passt nicht zum Manifest.`,
      );
    }
  }
  if (actualFiles.size !== expectedFiles.size
    || [...actualFiles].some((file) => !expectedFiles.has(file))) {
    throw bundleError(
      "BACKUP_BUNDLE_COMPONENT_MISMATCH",
      "Die geschuetzte Dokumentkomponente enthaelt nicht manifestierte Dateien.",
    );
  }
  return {
    bytes,
    files: manifest.files.length,
    manifestPath,
    manifestStat,
    sourceEvidence: Object.freeze({
      fingerprint: manifest.snapshot.sourceEvidenceFingerprint,
      referenceCount,
    }),
  };
}

function markerPathForBackupBundle(backupDirectory, snapshotId) {
  const root = path.resolve(backupDirectory);
  return path.join(root, `${assertSnapshotId(snapshotId)}.bundle.complete.json`);
}

function markerNameAndSnapshot(root, markerNameOrPath) {
  const supplied = String(markerNameOrPath || "");
  const markerName = path.basename(supplied);
  const match = markerName.match(
    /^(dienstplan-[0-9A-Za-z][0-9A-Za-z._-]{0,170})\.bundle\.complete\.json$/,
  );
  if (!match
    || (supplied !== markerName && path.resolve(supplied) !== path.join(root, markerName))) {
    throw bundleError("BACKUP_BUNDLE_MARKER_INVALID", "Der Backup-Bundle-Markername ist ungueltig.");
  }
  return { markerName, snapshotId: match[1] };
}

function readMarker(root, markerNameOrPath) {
  const { markerName, snapshotId } = markerNameAndSnapshot(root, markerNameOrPath);
  const markerPath = componentPath(root, markerName);
  const { value, stat } = readJsonRegularFile(
    markerPath,
    "Der Backup-Bundle-Commitmarker",
    { maximumBytes: MAX_MARKER_BYTES },
  );
  return {
    marker: normalizeBackupBundleMarker(value, snapshotId),
    markerPath,
    markerStat: stat,
  };
}

function verifyBundleComponents(root, marker) {
  const databasePath = componentPath(root, marker.database.fileName);
  const protectedDirectory = componentPath(root, marker.protectedDocuments.directoryName);
  const databaseVerification = sha256RegularFile(databasePath, "Die Datenbankkomponente");
  if (databaseVerification.stat.size !== marker.database.bytes
    || databaseVerification.sha256 !== marker.database.sha256) {
    throw bundleError(
      "BACKUP_BUNDLE_COMPONENT_MISMATCH",
      "Die Datenbankkomponente passt nicht zum Backup-Bundle.",
    );
  }
  const documents = inspectProtectedDocumentTree(
    protectedDirectory,
    marker.protectedDocuments.manifestFileName,
    {
      providerId: marker.providerId,
      method: marker.method,
      snapshotId: marker.snapshotId,
      createdAt: marker.createdAt,
      verifiedAt: marker.verification.verifiedAt,
      database: marker.database,
    },
  );
  const manifestVerification = sha256RegularFile(
    documents.manifestPath,
    "Das geschuetzte Dokumentmanifest",
    { maximumBytes: MAX_MANIFEST_BYTES },
  );
  if (documents.manifestStat.size !== marker.protectedDocuments.manifestBytes
    || documents.files !== marker.protectedDocuments.files
    || documents.bytes !== marker.protectedDocuments.bytes
    || manifestVerification.sha256 !== marker.protectedDocuments.manifestSha256) {
    throw bundleError(
      "BACKUP_BUNDLE_COMPONENT_MISMATCH",
      "Die geschuetzte Dokumentkomponente passt nicht zum Backup-Bundle.",
    );
  }
  return {
    databasePath,
    protectedDirectory,
    sourceEvidence: documents.sourceEvidence,
  };
}

function normalizeExpectedProvider(options) {
  const supplied = options === undefined ? {} : options;
  assertAllowedKeys(supplied, VERIFY_OPTION_KEYS, "Die Bundle-Verifikationsoptionen");
  const expectedProviderId = supplied.expectedProviderId;
  const expectedMethod = supplied.expectedMethod;
  if (expectedProviderId !== undefined && !PROVIDER_IDS.has(expectedProviderId)) {
    throw bundleError("BACKUP_BUNDLE_PROVIDER_MISMATCH", "Der erwartete Provider ist ungueltig.");
  }
  if (expectedMethod !== undefined && !METHOD_PROVIDER.has(expectedMethod)) {
    throw bundleError("BACKUP_BUNDLE_PROVIDER_MISMATCH", "Die erwartete Sicherungsmethode ist ungueltig.");
  }
  if (expectedProviderId !== undefined
    && expectedMethod !== undefined
    && BACKUP_BUNDLE_METHODS[expectedProviderId] !== expectedMethod) {
    throw bundleError("BACKUP_BUNDLE_PROVIDER_MISMATCH", "Provider und Sicherungsmethode widersprechen einander.");
  }
  return { expectedProviderId, expectedMethod };
}

function verifyBackupBundle(backupDirectory, markerNameOrPath, options = {}) {
  const root = assertSafeRoot(backupDirectory);
  const expected = normalizeExpectedProvider(options);
  const { marker, markerPath, markerStat } = readMarker(root, markerNameOrPath);
  if ((expected.expectedProviderId !== undefined
      && marker.providerId !== expected.expectedProviderId)
    || (expected.expectedMethod !== undefined && marker.method !== expected.expectedMethod)) {
    throw bundleError(
      "BACKUP_BUNDLE_PROVIDER_MISMATCH",
      "Das Backup-Bundle passt nicht zum erwarteten Providerpfad.",
    );
  }
  const components = verifyBundleComponents(root, marker);
  return Object.freeze({
    format: marker.format,
    schemaVersion: marker.schemaVersion,
    snapshotId: marker.snapshotId,
    providerId: marker.providerId,
    method: marker.method,
    createdAt: marker.createdAt,
    appVersion: marker.appVersion,
    bundleHash: marker.bundleHash,
    marker,
    markerPath,
    databasePath: components.databasePath,
    protectedDirectory: components.protectedDirectory,
    sourceEvidence: components.sourceEvidence,
    modifiedMs: markerStat.mtimeMs,
    modifiedAt: markerStat.mtime.toISOString(),
    committed: true,
    verified: true,
  });
}

function readBackupBundle(backupDirectory, markerNameOrPath, options = {}) {
  return verifyBackupBundle(backupDirectory, markerNameOrPath, options);
}

function normalizeWriteOptions(options) {
  assertExactKeys(options, WRITE_OPTION_KEYS, "Die Bundle-Schreiboptionen");
  const marker = {
    format: options.format,
    schemaVersion: options.schemaVersion,
    providerId: options.providerId,
    method: options.method,
    snapshotId: options.snapshotId,
    createdAt: options.createdAt,
    appVersion: options.appVersion,
    database: options.database,
    protectedDocuments: options.protectedDocuments,
    verification: options.verification,
  };
  marker.bundleHash = computeBackupBundleHash(marker);
  return {
    backupDirectory: options.backupDirectory,
    marker: normalizeBackupBundleMarker(marker, options.snapshotId),
  };
}

function writeBackupBundleCommitMarker(options) {
  const normalized = normalizeWriteOptions(options);
  const root = assertSafeRoot(normalized.backupDirectory);
  const markerPath = markerPathForBackupBundle(root, normalized.marker.snapshotId);
  verifyBundleComponents(root, normalized.marker);
  if (fs.existsSync(markerPath)) {
    throw bundleError("BACKUP_BUNDLE_ALREADY_COMMITTED", "Das Backup-Bundle besitzt bereits einen Commitmarker.");
  }

  const partialPath = `${markerPath}.partial-${crypto.randomUUID()}`;
  let descriptor;
  let published = false;
  try {
    descriptor = fs.openSync(partialPath, "wx", 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify(normalized.marker, null, 2)}\n`,
      { encoding: "utf8" },
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertSafeRoot(root);
    if (fs.existsSync(markerPath)) {
      throw bundleError("BACKUP_BUNDLE_ALREADY_COMMITTED", "Das Backup-Bundle besitzt bereits einen Commitmarker.");
    }
    fs.renameSync(partialPath, markerPath);
    published = true;
    verifyBackupBundle(root, markerPath, {
      expectedProviderId: normalized.marker.providerId,
      expectedMethod: normalized.marker.method,
    });
    return markerPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(partialPath, { force: true }); } catch {}
    if (published) {
      try { fs.rmSync(markerPath, { force: true }); } catch {}
    }
    throw error;
  }
}

function committedBundleCandidates(root) {
  let names;
  try {
    names = fs.readdirSync(root)
      .filter((name) => (
        /^(dienstplan-[0-9A-Za-z][0-9A-Za-z._-]{0,170})\.bundle\.complete\.json$/.test(name)
      ))
      .slice(0, MAX_BUNDLE_CANDIDATES);
  } catch {
    return [];
  }
  return names.filter((name) => {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
    } catch {
      return false;
    }
  });
}

function normalizeListOptions(options) {
  const supplied = options === undefined ? {} : options;
  assertAllowedKeys(supplied, LIST_OPTION_KEYS, "Die Bundle-Listenoptionen");
  const limit = supplied.limit === undefined
    ? Number.POSITIVE_INFINITY
    : supplied.limit;
  if (limit !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_BUNDLE_CANDIDATES)) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Das Bundle-Listenlimit ist ungueltig.");
  }
  if (supplied.providerId !== undefined && !PROVIDER_IDS.has(supplied.providerId)) {
    throw bundleError("BACKUP_BUNDLE_PROVIDER_MISMATCH", "Der Bundle-Listenprovider ist ungueltig.");
  }
  if (supplied.method !== undefined && !METHOD_PROVIDER.has(supplied.method)) {
    throw bundleError("BACKUP_BUNDLE_PROVIDER_MISMATCH", "Die Bundle-Listenmethode ist ungueltig.");
  }
  if (supplied.providerId !== undefined
    && supplied.method !== undefined
    && BACKUP_BUNDLE_METHODS[supplied.providerId] !== supplied.method) {
    throw bundleError("BACKUP_BUNDLE_PROVIDER_MISMATCH", "Bundle-Listenprovider und -methode widersprechen einander.");
  }
  return {
    limit,
    providerId: supplied.providerId,
    method: supplied.method,
  };
}

function listBackupBundles(backupDirectory, options = {}) {
  const normalized = normalizeListOptions(options);
  let root;
  try {
    root = assertSafeRoot(backupDirectory);
  } catch {
    return [];
  }
  const bundles = [];
  for (const markerName of committedBundleCandidates(root)) {
    try {
      const bundle = verifyBackupBundle(root, markerName);
      if (normalized.providerId !== undefined && bundle.providerId !== normalized.providerId) continue;
      if (normalized.method !== undefined && bundle.method !== normalized.method) continue;
      bundles.push(bundle);
    } catch {}
  }
  bundles.sort((left, right) => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || right.snapshotId.localeCompare(left.snapshotId)
  ));
  return bundles.slice(0, normalized.limit);
}

function pruneBackupBundles(backupDirectory, keep = 30, options = {}) {
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > MAX_BUNDLE_CANDIDATES) {
    throw bundleError("BACKUP_BUNDLE_SCHEMA_INVALID", "Die Bundle-Aufbewahrungsgrenze ist ungueltig.");
  }
  const normalized = normalizeListOptions(options);
  const bundles = listBackupBundles(backupDirectory, {
    limit: MAX_BUNDLE_CANDIDATES,
    providerId: normalized.providerId,
    method: normalized.method,
  });
  const deletionCandidates = bundles.slice(keep);
  let removed = 0;
  for (const candidate of deletionCandidates) {
    try {
      const current = verifyBackupBundle(backupDirectory, candidate.markerPath, {
        expectedProviderId: candidate.providerId,
        expectedMethod: candidate.method,
      });
      fs.rmSync(current.markerPath);
      fs.rmSync(current.databasePath);
      fs.rmSync(current.protectedDirectory, { recursive: true });
      removed += 1;
    } catch {}
  }
  return Object.freeze({
    removed,
    retained: bundles.length - removed,
  });
}

module.exports = {
  BACKUP_BUNDLE_DATABASE_FORMATS,
  BACKUP_BUNDLE_FORMAT,
  BACKUP_BUNDLE_METHODS,
  BACKUP_BUNDLE_SCHEMA_VERSION,
  BACKUP_BUNDLE_VERIFICATION_CHECK_KEYS,
  BackupBundleError,
  computeBackupBundleHash,
  listBackupBundles,
  markerPathForBackupBundle,
  pruneBackupBundles,
  readBackupBundle,
  verifyBackupBundle,
  writeBackupBundleCommitMarker,
};
