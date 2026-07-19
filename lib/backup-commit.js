"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const COMMIT_FORMAT = "grabenplaner-backup-commit";
const COMMIT_SCHEMA_VERSION = 1;
const SNAPSHOT_PATTERN = /^dienstplan-[0-9A-Za-z._-]+$/;
const MAX_MARKER_BYTES = 64 * 1024;

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertSnapshotName(value) {
  const snapshot = String(value || "");
  if (!SNAPSHOT_PATTERN.test(snapshot)) throw new Error("Der Sicherungsname ist ungueltig.");
  return snapshot;
}

function markerPathFor(backupDirectory, snapshot) {
  return path.join(path.resolve(backupDirectory), `${assertSnapshotName(snapshot)}.complete.json`);
}

function backupPaths(backupDirectory, snapshot) {
  const root = path.resolve(backupDirectory);
  const safeSnapshot = assertSnapshotName(snapshot);
  return {
    snapshot: safeSnapshot,
    databasePath: path.join(root, `${safeSnapshot}.db`),
    protectedDirectory: path.join(root, `${safeSnapshot}.amu`),
    markerPath: markerPathFor(root, safeSnapshot),
  };
}

function readJsonFile(filePath, label, { maximumBytes = Number.POSITIVE_INFINITY } = {}) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} ist keine regulaere Datei.`);
  if (stat.size <= 0 || stat.size > maximumBytes) throw new Error(`${label} hat eine unzulaessige Groesse.`);
  try { return { value: JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")), stat }; }
  catch (error) { throw new Error(`${label} ist ungueltig: ${error.message}`); }
}

function validateMarker(marker, paths) {
  if (marker?.format !== COMMIT_FORMAT || marker?.schemaVersion !== COMMIT_SCHEMA_VERSION
    || marker?.snapshot !== paths.snapshot || !Number.isFinite(Date.parse(String(marker?.committedAt || "")))
    || marker?.database?.fileName !== path.basename(paths.databasePath)
    || !/^[0-9a-f]{64}$/i.test(String(marker?.database?.sha256 || ""))
    || !Number.isSafeInteger(marker?.database?.bytes) || marker.database.bytes <= 0
    || marker?.protectedDocuments?.directoryName !== path.basename(paths.protectedDirectory)
    || marker?.protectedDocuments?.manifestFileName !== "manifest.json"
    || !Number.isSafeInteger(marker?.protectedDocuments?.files) || marker.protectedDocuments.files < 0
    || !/^[0-9a-f]{64}$/i.test(String(marker?.protectedDocuments?.manifestSha256 || ""))
    || !Number.isSafeInteger(marker?.protectedDocuments?.manifestBytes) || marker.protectedDocuments.manifestBytes <= 0
    || marker?.verification?.status !== "verified"
    || !Number.isFinite(Date.parse(String(marker?.verification?.verifiedAt || "")))) {
    throw new Error("Der Sicherungsmarker passt nicht zum Sicherungspaar.");
  }
}

function inspectCommittedBackupMetadata(backupDirectory, markerNameOrPath) {
  const root = path.resolve(backupDirectory);
  const markerName = path.basename(String(markerNameOrPath || ""));
  const match = markerName.match(/^(dienstplan-[0-9A-Za-z._-]+)\.complete\.json$/);
  if (!match || markerName !== String(markerNameOrPath).replace(/^.*[\\/]/, "")) throw new Error("Der Sicherungsmarkername ist ungueltig.");
  const paths = backupPaths(root, match[1]);
  const { value: marker, stat: markerStat } = readJsonFile(paths.markerPath, "Der Sicherungsmarker", { maximumBytes: MAX_MARKER_BYTES });
  validateMarker(marker, paths);
  const databaseStat = fs.lstatSync(paths.databasePath);
  const protectedStat = fs.lstatSync(paths.protectedDirectory);
  const manifestPath = path.join(paths.protectedDirectory, "manifest.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || databaseStat.size !== marker.database.bytes
    || !protectedStat.isDirectory() || protectedStat.isSymbolicLink()
    || !manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size !== marker.protectedDocuments.manifestBytes) {
    throw new Error("Der gecachte Sicherungsbeleg passt nicht mehr zu den Dateimetadaten.");
  }
  return {
    ...paths,
    marker,
    databaseSha256: String(marker.database.sha256).toLowerCase(),
    modifiedMs: markerStat.mtimeMs,
    modifiedAt: markerStat.mtime.toISOString(),
    committed: true,
    legacy: false,
    verified: true,
    verificationCached: true,
  };
}

function verifyCommittedBackup(backupDirectory, markerNameOrPath, { verifyPair } = {}) {
  const metadata = inspectCommittedBackupMetadata(backupDirectory, markerNameOrPath);
  const { marker } = metadata;
  const databaseSha256 = sha256File(metadata.databasePath);
  if (databaseSha256 !== metadata.databaseSha256) throw new Error("Die Datenbank-Pruefsumme passt nicht zum Sicherungsmarker.");
  const manifestPath = path.join(metadata.protectedDirectory, "manifest.json");
  if (sha256File(manifestPath) !== String(marker.protectedDocuments.manifestSha256).toLowerCase()) {
    throw new Error("Die Dokumentmanifest-Pruefsumme passt nicht zum Sicherungsmarker.");
  }
  const { value: protectedManifest } = readJsonFile(manifestPath, "Das Dokumentmanifest");
  if (protectedManifest?.database?.fileName !== path.basename(metadata.databasePath)
    || String(protectedManifest?.database?.sha256 || "").toLowerCase() !== databaseSha256
    || !Array.isArray(protectedManifest?.files)
    || protectedManifest.files.length !== marker.protectedDocuments.files) {
    throw new Error("Datenbank, Dokumentmanifest und Commitmarker gehoeren nicht zusammen.");
  }
  if (typeof verifyPair === "function") verifyPair(metadata, marker);
  return {
    ...metadata,
    databaseSha256,
    verificationCached: false,
  };
}

function writeBackupCommitMarker({ backupDirectory, snapshot, databaseSha256, protectedFiles, committedAt = new Date().toISOString() }) {
  const paths = backupPaths(backupDirectory, snapshot);
  if (!/^[0-9a-f]{64}$/i.test(String(databaseSha256 || ""))) throw new Error("Die Datenbank-Pruefsumme fuer den Commitmarker ist ungueltig.");
  const databaseStat = fs.lstatSync(paths.databasePath);
  const manifestPath = path.join(paths.protectedDirectory, "manifest.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("Der Commitmarker kann nur fuer regulaere Sicherungsdateien erstellt werden.");
  }
  const { value: manifest } = readJsonFile(manifestPath, "Das Dokumentmanifest");
  if (!Array.isArray(manifest?.files)) throw new Error("Das Dokumentmanifest enthaelt keine gueltige Dateiliste.");
  const actualProtectedFiles = manifest.files.length;
  if (protectedFiles !== undefined
    && (!Number.isSafeInteger(protectedFiles) || protectedFiles < 0 || protectedFiles !== actualProtectedFiles)) {
    throw new Error("Die Anzahl geschuetzter Dateien fuer den Commitmarker ist ungueltig.");
  }
  const temporaryMarker = `${paths.markerPath}.partial-${crypto.randomUUID()}`;
  const payload = {
    format: COMMIT_FORMAT,
    schemaVersion: COMMIT_SCHEMA_VERSION,
    snapshot: paths.snapshot,
    committedAt,
    database: { fileName: path.basename(paths.databasePath), sha256: String(databaseSha256).toLowerCase(), bytes: databaseStat.size },
    protectedDocuments: {
      directoryName: path.basename(paths.protectedDirectory),
      files: actualProtectedFiles,
      manifestFileName: "manifest.json",
      manifestSha256: sha256File(manifestPath),
      manifestBytes: manifestStat.size,
    },
    verification: { status: "verified", verifiedAt: committedAt },
  };
  try {
    fs.writeFileSync(temporaryMarker, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporaryMarker, paths.markerPath);
    return paths.markerPath;
  } catch (error) {
    fs.rmSync(temporaryMarker, { force: true });
    throw error;
  }
}

function committedMarkerCandidates(root) {
  let names;
  try { names = fs.readdirSync(root).filter((name) => /^dienstplan-[0-9A-Za-z._-]+\.complete\.json$/.test(name)); }
  catch { return []; }
  return names.map((name) => {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      return stat.isFile() && !stat.isSymbolicLink() ? { name, modifiedMs: stat.mtimeMs } : null;
    } catch { return null; }
  }).filter(Boolean).sort((left, right) => right.modifiedMs - left.modifiedMs);
}

function listCommittedBackups(backupDirectory, options = {}) {
  const root = path.resolve(backupDirectory);
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY;
  const candidates = committedMarkerCandidates(root);
  const backups = [];
  for (const candidate of candidates) {
    try {
      backups.push(verifyCommittedBackup(root, candidate.name, options));
      if (backups.length >= limit) break;
    } catch {}
  }
  return backups;
}

function listCommittedBackupMetadata(backupDirectory, { limit: requestedLimit } = {}) {
  const root = path.resolve(backupDirectory);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : Number.POSITIVE_INFINITY;
  const backups = [];
  for (const candidate of committedMarkerCandidates(root)) {
    try {
      backups.push(inspectCommittedBackupMetadata(root, candidate.name));
      if (backups.length >= limit) break;
    } catch {}
  }
  return backups;
}

function listLegacyBackupPairs(backupDirectory, { verifyPair, limit: requestedLimit } = {}) {
  const root = path.resolve(backupDirectory);
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : Number.POSITIVE_INFINITY;
  const committedSnapshots = new Set(names
    .map((name) => name.match(/^(dienstplan-[0-9A-Za-z._-]+)\.complete\.json$/)?.[1])
    .filter(Boolean));
  const candidates = names.filter((entry) => /^dienstplan-[0-9A-Za-z._-]+\.db$/.test(entry)).map((name) => {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      return stat.isFile() && !stat.isSymbolicLink() ? { name, modifiedMs: stat.mtimeMs } : null;
    } catch { return null; }
  }).filter(Boolean).sort((left, right) => right.modifiedMs - left.modifiedMs);
  const backups = [];
  for (const { name } of candidates) {
    const snapshot = path.basename(name, ".db");
    if (committedSnapshots.has(snapshot)) continue;
    const paths = backupPaths(root, snapshot);
    try {
      const databaseStat = fs.lstatSync(paths.databasePath);
      const protectedStat = fs.lstatSync(paths.protectedDirectory);
      if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || !protectedStat.isDirectory() || protectedStat.isSymbolicLink()) continue;
      const databaseSha256 = sha256File(paths.databasePath);
      const { value: protectedManifest } = readJsonFile(path.join(paths.protectedDirectory, "manifest.json"), "Das Legacy-Dokumentmanifest");
      if (protectedManifest?.database?.fileName !== name
        || String(protectedManifest?.database?.sha256 || "").toLowerCase() !== databaseSha256) continue;
      if (typeof verifyPair === "function") verifyPair(paths, null);
      backups.push({
        ...paths,
        markerPath: null,
        databaseSha256,
        modifiedMs: databaseStat.mtimeMs,
        modifiedAt: databaseStat.mtime.toISOString(),
        committed: false,
        legacy: true,
        verified: true,
      });
      if (backups.length >= limit) break;
    } catch {}
  }
  return backups;
}

function listLegacyBackupMetadata(backupDirectory, { limit: requestedLimit } = {}) {
  const root = path.resolve(backupDirectory);
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : Number.POSITIVE_INFINITY;
  const committedSnapshots = new Set(names
    .map((name) => name.match(/^(dienstplan-[0-9A-Za-z._-]+)\.complete\.json$/)?.[1])
    .filter(Boolean));
  const candidates = names.filter((entry) => /^dienstplan-[0-9A-Za-z._-]+\.db$/.test(entry)).map((name) => {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      return stat.isFile() && !stat.isSymbolicLink() ? { name, stat } : null;
    } catch { return null; }
  }).filter(Boolean).sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  const backups = [];
  for (const { name, stat } of candidates) {
    const snapshot = path.basename(name, ".db");
    if (committedSnapshots.has(snapshot)) continue;
    const paths = backupPaths(root, snapshot);
    try {
      const protectedStat = fs.lstatSync(paths.protectedDirectory);
      const manifestStat = fs.lstatSync(path.join(paths.protectedDirectory, "manifest.json"));
      if (!protectedStat.isDirectory() || protectedStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;
      backups.push({
        ...paths,
        markerPath: null,
        modifiedMs: stat.mtimeMs,
        modifiedAt: stat.mtime.toISOString(),
        committed: false,
        legacy: true,
        verified: false,
        verificationCached: false,
      });
      if (backups.length >= limit) break;
    } catch {}
  }
  return backups;
}

function pruneCommittedBackups(backupDirectory, keep = 30, options = {}) {
  const safeKeep = Math.max(0, Number.parseInt(keep, 10) || 0);
  const validBackups = listCommittedBackups(backupDirectory, options);
  const deletionCandidates = validBackups.slice(safeKeep);
  let removed = 0;
  for (const backup of deletionCandidates) {
    try {
      fs.rmSync(backup.markerPath, { force: true });
      fs.rmSync(backup.databasePath, { force: true });
      fs.rmSync(backup.protectedDirectory, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return { removed, retained: validBackups.length - removed };
}

module.exports = {
  COMMIT_FORMAT,
  COMMIT_SCHEMA_VERSION,
  inspectCommittedBackupMetadata,
  listCommittedBackups,
  listCommittedBackupMetadata,
  listLegacyBackupMetadata,
  listLegacyBackupPairs,
  markerPathFor,
  pruneCommittedBackups,
  verifyCommittedBackup,
  writeBackupCommitMarker,
};
