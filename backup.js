"use strict";

const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncEncryptedFilesBackup } = require("./lib/amu-storage");
const { acquireDatabaseLock, releaseDatabaseLock } = require("./lib/database-lock");
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

function createPairedBackup(database, backupDirectory, timestamp, label) {
  fs.mkdirSync(backupDirectory, { recursive: true });
  const snapshotName = `dienstplan-${timestamp}`;
  const target = path.join(backupDirectory, `${snapshotName}.db`);
  const protectedTarget = path.join(backupDirectory, `${snapshotName}.amu`);
  const nonce = crypto.randomUUID();
  const temporaryDatabase = `${target}.partial-${nonce}`;
  const temporaryProtected = `${protectedTarget}.partial-${nonce}`;
  try {
    if (!fs.existsSync(protectedDocumentsDirectory)) {
      throw new Error("Der geschützte Dokumentenspeicher fehlt. Bitte Grabenplaner einmal starten und das Backup erneut ausführen.");
    }
    const escapedTarget = temporaryDatabase.replaceAll("\\", "/").replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escapedTarget}'`);
    const databaseHash = crypto.createHash("sha256").update(fs.readFileSync(temporaryDatabase)).digest("hex");
    syncEncryptedFilesBackup({
      sourceDirectory: protectedDocumentsDirectory,
      targetDirectory: temporaryProtected,
      manifestMetadata: { database: { fileName: path.basename(target), sha256: databaseHash } },
    });
    fs.renameSync(temporaryProtected, protectedTarget);
    fs.renameSync(temporaryDatabase, target);
  } catch (error) {
    fs.rmSync(temporaryDatabase, { force: true });
    fs.rmSync(temporaryProtected, { recursive: true, force: true });
    fs.rmSync(target, { force: true });
    fs.rmSync(protectedTarget, { recursive: true, force: true });
    throw error;
  }

  const backups = fs.readdirSync(backupDirectory)
    .filter((name) => /^dienstplan-.*\.db$/.test(name))
    .map((name) => ({
      path: path.join(backupDirectory, name),
      time: fs.statSync(path.join(backupDirectory, name)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);
  for (const oldBackup of backups.slice(30)) {
    fs.rmSync(oldBackup.path, { force: true });
    fs.rmSync(path.join(backupDirectory, `${path.basename(oldBackup.path, ".db")}.amu`), { recursive: true, force: true });
  }
  console.log(`${label}: ${target} + ${protectedTarget}`);
}

function main() {
  if (!fs.existsSync(databasePath)) throw new Error("Noch keine Dienstplan-Datenbank vorhanden.");
  const lock = acquireDatabaseLock({ databasePath, kind: "backup", appVersion: packageMetadata.version });
  let database;
  try {
    database = new DatabaseSync(databasePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backupDirectory = defaultBackupDirectory;
    let externalBackupEnabled = true;
    try {
      const rows = Object.fromEntries(database.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
      if (rows.backup_directory) backupDirectory = process.env.BACKUP_DIR || resolveBackupDirectory(rows.backup_directory);
      externalBackupEnabled = rows.external_backup_enabled !== "0";
    } catch {}
    createPairedBackup(database, appBackupDirectory, timestamp, "Internes Backup erstellt");
    if (externalBackupEnabled) createPairedBackup(database, backupDirectory, timestamp, "Lokales PC-Backup erstellt");
    if (!externalBackupEnabled) console.log("Lokales PC-Backup ist in den Datenbank-Einstellungen deaktiviert.");
  } finally {
    try { database?.close(); } finally { releaseDatabaseLock(lock); }
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`Backup nicht erstellt: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, resolveBackupDirectory };
