"use strict";

const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sha256File } = require("./lib/file-integrity");
const { syncEncryptedFilesBackup, verifyBackupReferences } = require("./lib/amu-storage");
const { acquireDatabaseLock, releaseDatabaseLock } = require("./lib/database-lock");
const { pruneCommittedBackups, verifyCommittedBackup, writeBackupCommitMarker } = require("./lib/backup-commit");
const { prepareLocalBackupArchive, archivePublishedBackup } = require("./lib/backup-archive-workflow");
const { protectedStorageReferencesFromFile, verifySqliteDatabaseFile } = require("./lib/persistence/sqlite/operations/maintenance");
const { localBackupArchiveEnabled } = require("./lib/local-backup-environment");
const { verifyBackupRecoveryKeys } = require("./lib/backup-recovery-keys");
const { acquireBackupWorkspace } = require("./lib/backup-workspace");
const { parseBackupKeep } = require('./lib/server-runtime');
const packageMetadata = require("./package.json");

const configuredDataRoot = String(process.env.GRABENPLANER_DATA_ROOT || "").trim();
const dataDirectory = configuredDataRoot ? path.join(configuredDataRoot, "data") : path.join(__dirname, "data");
const databasePath = process.env.DB_PATH || path.join(dataDirectory, "dienstplan.db");
const appBackupDirectory = configuredDataRoot ? path.join(configuredDataRoot, "backups") : path.join(__dirname, "backups");
const defaultBackupDirectorySetting = "%USERPROFILE%\\Documents\\grabenplaner-backups";
const defaultBackupDirectory = process.env.BACKUP_DIR || path.join(os.homedir(), "Documents", "grabenplaner-backups");
const protectedDocumentsDirectory = process.env.GRABENPLANER_AMU_DIR
  || (configuredDataRoot ? path.join(configuredDataRoot, "private", "amu") : path.join(dataDirectory, "private", "amu"));

function resolveBackupDirectory(value) {
  const raw = String(value || defaultBackupDirectorySetting).trim()
    .replace(/%GRABENPLANER_ROOT%/gi, path.basename(__dirname).toLowerCase() === "app" ? path.dirname(__dirname) : __dirname)
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/%HOME%/gi, os.homedir());
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function verifyStandaloneBackupPair(paths, _marker = null, { environment = process.env } = {}) {
  if (!verifySqliteDatabaseFile(paths.databasePath).ok) throw new Error("BACKUP_DATABASE_INTEGRITY_FAILED");
  const requiredStorageKeys = protectedStorageReferencesFromFile(paths.databasePath);
  verifyBackupReferences({ backupDirectory: paths.protectedDirectory, requiredStorageKeys });
  if (localBackupArchiveEnabled(environment)) verifyBackupRecoveryKeys({
    databasePath: paths.databasePath, protectedDirectory: paths.protectedDirectory, environment,
  });
}

function createPairedBackup(database, backupDirectory, timestamp, label, expectedStream = "external") {
  const retentionDays = parseBackupKeep(process.env.GRABENPLANER_BACKUP_RETENTION_DAYS, 20);
  const archive = prepareLocalBackupArchive({ backupDirectory, expectedStream, keep: retentionDays });
  if (archive) archive.preflightBackup();
  fs.mkdirSync(backupDirectory, { recursive: true });
  const snapshotName = `dienstplan-${timestamp}-${crypto.randomBytes(6).toString("hex")}`;
  const target = path.join(backupDirectory, `${snapshotName}.db`);
  const protectedTarget = path.join(backupDirectory, `${snapshotName}.amu`);
  const markerTarget = path.join(backupDirectory, `${snapshotName}.complete.json`);
  const nonce = crypto.randomUUID();
  const temporaryDatabase = `${target}.partial-${nonce}`;
  const temporaryProtected = `${protectedTarget}.partial-${nonce}`;
  try {
    if (!fs.existsSync(protectedDocumentsDirectory)) {
      throw new Error("Der geschützte Dokumentenspeicher fehlt. Bitte Grabenplaner einmal starten und das Backup erneut ausführen.");
    }
    const escapedTarget = temporaryDatabase.replaceAll("\\", "/").replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escapedTarget}'`);
    const databaseHash = sha256File(temporaryDatabase);
    const protectedBackup = syncEncryptedFilesBackup({
      sourceDirectory: protectedDocumentsDirectory,
      targetDirectory: temporaryProtected,
      manifestMetadata: { database: { fileName: path.basename(target), sha256: databaseHash } },
    });
    fs.renameSync(temporaryProtected, protectedTarget);
    fs.renameSync(temporaryDatabase, target);
    writeBackupCommitMarker({
      backupDirectory,
      snapshot: snapshotName,
      databaseSha256: databaseHash,
      protectedFiles: protectedBackup.fileCount,
    });
    verifyCommittedBackup(backupDirectory, path.basename(markerTarget), { verifyPair: verifyStandaloneBackupPair });
  } catch (error) {
    fs.rmSync(temporaryDatabase, { force: true });
    fs.rmSync(temporaryProtected, { recursive: true, force: true });
    fs.rmSync(target, { force: true });
    fs.rmSync(protectedTarget, { recursive: true, force: true });
    fs.rmSync(markerTarget, { force: true });
    throw error;
  }

  const archiveResult = archive ? archivePublishedBackup(archive, snapshotName, verifyStandaloneBackupPair) : null;
  if (!archive) pruneCommittedBackups(backupDirectory, retentionDays, { verifyPair: verifyStandaloneBackupPair });
  console.log(`${label}: ${target} + ${protectedTarget} + ${markerTarget}`);
  return { path: target, protectedDirectory: protectedTarget, marker: markerTarget, committed: true, archive: archiveResult };
}

function main() {
  if (!fs.existsSync(databasePath)) throw new Error("Noch keine Dienstplan-Datenbank vorhanden.");
  const lock = acquireDatabaseLock({ databasePath, kind: "backup", appVersion: packageMetadata.version });
  let database, workspace;
  try {
    workspace = acquireBackupWorkspace({ databasePath });
    database = new DatabaseSync(databasePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backupDirectory = defaultBackupDirectory;
    let externalBackupEnabled = true;
    try {
      const rows = Object.fromEntries(database.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
      if (rows.backup_directory) backupDirectory = process.env.BACKUP_DIR || resolveBackupDirectory(rows.backup_directory);
      externalBackupEnabled = rows.external_backup_enabled !== "0";
    } catch {}
    createPairedBackup(database, appBackupDirectory, timestamp, "Internes Backup erstellt", "app");
    if (externalBackupEnabled) createPairedBackup(database, backupDirectory, timestamp, "Lokales PC-Backup erstellt");
    if (!externalBackupEnabled) console.log("Lokales PC-Backup ist in den Datenbank-Einstellungen deaktiviert.");
  } finally {
    try { database?.close(); } finally { try { workspace?.release(); } finally { releaseDatabaseLock(lock); } }
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`Backup nicht erstellt: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createPairedBackup, main, resolveBackupDirectory, verifyStandaloneBackupPair };
