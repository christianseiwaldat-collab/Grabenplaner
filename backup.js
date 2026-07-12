const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const databasePath = path.join(__dirname, "data", "dienstplan.db");
const appBackupDirectory = path.join(__dirname, "backups");
const defaultBackupDirectorySetting = "%USERPROFILE%\\Documents\\grabenplaner-backups";
const defaultBackupDirectory = process.env.BACKUP_DIR || path.join(os.homedir(), "Documents", "grabenplaner-backups");

function resolveBackupDirectory(value) {
  const raw = String(value || defaultBackupDirectorySetting).trim()
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/%HOME%/gi, os.homedir());
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

if (!fs.existsSync(databasePath)) {
  console.error("Noch keine Dienstplan-Datenbank vorhanden.");
  process.exit(1);
}

const database = new DatabaseSync(databasePath);

try {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  function backupTo(backupDirectory, label) {
    fs.mkdirSync(backupDirectory, { recursive: true });
    const target = path.join(backupDirectory, `dienstplan-${timestamp}.db`);
    const escapedTarget = target.replaceAll("\\", "/").replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escapedTarget}'`);
    const backups = fs
      .readdirSync(backupDirectory)
      .filter((name) => /^dienstplan-.*\.db$/.test(name))
      .map((name) => ({
        path: path.join(backupDirectory, name),
        time: fs.statSync(path.join(backupDirectory, name)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);
    for (const oldBackup of backups.slice(30)) fs.rmSync(oldBackup.path, { force: true });
    console.log(`${label}: ${target}`);
  }

  let backupDirectory = defaultBackupDirectory;
  let externalBackupEnabled = true;
  try {
    const rows = Object.fromEntries(database.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
    if (rows.backup_directory) backupDirectory = process.env.BACKUP_DIR || resolveBackupDirectory(rows.backup_directory);
    externalBackupEnabled = rows.external_backup_enabled !== "0";
  } catch {}
  backupTo(appBackupDirectory, "Internes Backup erstellt");
  if (externalBackupEnabled) backupTo(backupDirectory, "Lokales PC-Backup erstellt");
  if (!externalBackupEnabled) console.log("Lokales PC-Backup ist in den Datenbank-Einstellungen deaktiviert.");
} finally {
  database.close();
}
