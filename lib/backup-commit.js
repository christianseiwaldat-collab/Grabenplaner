"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const COMMIT_FORMAT = "grabenplaner-backup-commit";
const COMMIT_SCHEMA_VERSION = 1;
const SNAPSHOT_PATTERN = /^dienstplan-[0-9A-Za-z._-]+$/;

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

function readJsonFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} ist keine regulaere Datei.`);
  try { return { value: JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")), stat }; }
  catch (error) { throw new Error(`${label} ist ungueltig: ${error.message}`); }
}

function verifyCommittedBackup(backupDirectory, markerNameOrPath, { verifyPair } = {}) {
  const root = path.resolve(backupDirectory);
  const markerName = path.basename(String(markerNameOrPath || ""));
  const match = markerName.match(/^(dienstplan-[0-9A-Za-z._-]+)\.complete\.json$/);
  if (!match || markerName !== String(markerNameOrPath).replace(/^.*[\\/]/, "")) throw new Error("Der Sicherungsmarkername ist ungueltig.");
  const paths = backupPaths(root, match[1]);
  const { value: marker, stat: markerStat } = readJsonFile(paths.markerPath, "Der Sicherungsmarker");
  if (marker?.format !== COMMIT_FORMAT || marker?.schemaVersion !== COMMIT_SCHEMA_VERSION
    || marker?.snapshot !== paths.snapshot || !Number.isFinite(Date.parse(String(marker?.committedAt || "")))
    || marker?.database?.fileName !== path.basename(paths.databasePath)
    || !/^[0-9a-f]{64}$/i.test(String(marker?.database?.sha256 || ""))
    || marker?.protectedDocuments?.directoryName !== path.basename(paths.protectedDirectory)) {
    throw new Error("Der Sicherungsmarker passt nicht zum Sicherungspaar.");
  }
  const databaseStat = fs.lstatSync(paths.databasePath);
  const protectedStat = fs.lstatSync(paths.protectedDirectory);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || !protectedStat.isDirectory() || protectedStat.isSymbolicLink()) {
    throw new Error("Das committed Sicherungspaar ist unvollstaendig oder enthaelt Links.");
  }
  const databaseSha256 = sha256File(paths.databasePath);
  if (databaseSha256 !== String(marker.database.sha256).toLowerCase()) throw new Error("Die Datenbank-Pruefsumme passt nicht zum Sicherungsmarker.");
  const { value: protectedManifest } = readJsonFile(path.join(paths.protectedDirectory, "manifest.json"), "Das Dokumentmanifest");
  if (protectedManifest?.database?.fileName !== path.basename(paths.databasePath)
    || String(protectedManifest?.database?.sha256 || "").toLowerCase() !== databaseSha256) {
    throw new Error("Datenbank, Dokumentmanifest und Commitmarker gehoeren nicht zusammen.");
  }
  if (typeof verifyPair === "function") verifyPair(paths, marker);
  return {
    ...paths,
    marker,
    databaseSha256,
    modifiedMs: markerStat.mtimeMs,
    modifiedAt: markerStat.mtime.toISOString(),
    committed: true,
    legacy: false,
    verified: true,
  };
}

function writeBackupCommitMarker({ backupDirectory, snapshot, databaseSha256, protectedFiles = 0, committedAt = new Date().toISOString() }) {
  const paths = backupPaths(backupDirectory, snapshot);
  if (!/^[0-9a-f]{64}$/i.test(String(databaseSha256 || ""))) throw new Error("Die Datenbank-Pruefsumme fuer den Commitmarker ist ungueltig.");
  const temporaryMarker = `${paths.markerPath}.partial-${crypto.randomUUID()}`;
  const payload = {
    format: COMMIT_FORMAT,
    schemaVersion: COMMIT_SCHEMA_VERSION,
    snapshot: paths.snapshot,
    committedAt,
    database: { fileName: path.basename(paths.databasePath), sha256: String(databaseSha256).toLowerCase() },
    protectedDocuments: { directoryName: path.basename(paths.protectedDirectory), files: Math.max(0, Number(protectedFiles) || 0) },
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

function pruneCommittedBackups(backupDirectory, keep = 30, options = {}) {
  const root = path.resolve(backupDirectory);
  const safeKeep = Math.max(0, Number.parseInt(keep, 10) || 0);
  const deletionCandidates = committedMarkerCandidates(root).slice(safeKeep);
  let removed = 0;
  for (const candidate of deletionCandidates) {
    try {
      const backup = verifyCommittedBackup(root, candidate.name, options);
      fs.rmSync(backup.markerPath, { force: true });
      fs.rmSync(backup.databasePath, { force: true });
      fs.rmSync(backup.protectedDirectory, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return { removed, retained: committedMarkerCandidates(root).length };
}

module.exports = {
  COMMIT_FORMAT,
  COMMIT_SCHEMA_VERSION,
  listCommittedBackups,
  listLegacyBackupPairs,
  markerPathFor,
  pruneCommittedBackups,
  verifyCommittedBackup,
  writeBackupCommitMarker,
};
