const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { acquireDatabaseLock, releaseDatabaseLock } = require("../lib/database-lock");
const packageMetadata = require("../package.json");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function defaultDatabasePath() {
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  const configuredRoot = String(process.env.GRABENPLANER_DATA_DIR || "").trim();
  if (configuredRoot) return path.resolve(configuredRoot, "data", "dienstplan.db");
  return path.resolve(__dirname, "..", "data", "dienstplan.db");
}

const employeeNumber = argument("employee-number");
const databasePath = path.resolve(argument("database") || defaultDatabasePath());

if (!/^[A-Za-z0-9._-]{1,24}$/.test(employeeNumber)) {
  throw new Error("Bitte --employee-number mit einer gültigen Personalnummer angeben.");
}
if (!fs.existsSync(databasePath)) throw new Error(`Datenbank nicht gefunden: ${databasePath}`);
let databaseLock = acquireDatabaseLock({ databasePath, kind: "app", appVersion: packageMetadata.version });
const releaseLock = () => {
  if (!databaseLock) return;
  releaseDatabaseLock(databaseLock);
  databaseLock = null;
};
process.once("exit", releaseLock);

let database = new DatabaseSync(databasePath);
const integrity = database.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
if (integrity.length !== 1 || integrity[0] !== "ok") {
  database.close();
  throw new Error(`Datenbankprüfung fehlgeschlagen: ${integrity.join("; ")}`);
}
const userColumns = new Set(database.prepare("PRAGMA table_info(portal_users)").all().map((column) => column.name));
if (!userColumns.has("role_locked")) {
  database.close();
  throw new Error("Bitte Grabenplaner v0.55 zuerst einmal starten, damit die Datenbankmigration ausgeführt wird.");
}
const employee = database.prepare("SELECT personnel_number, full_name FROM employees WHERE personnel_number = ?").get(employeeNumber);
if (!employee) {
  database.close();
  throw new Error(`Teammitglied ${employeeNumber} wurde nicht gefunden.`);
}
const otherDeveloper = database.prepare("SELECT employee_number FROM portal_users WHERE role = 'developer' AND employee_number <> ?").get(employeeNumber);
if (otherDeveloper) {
  database.close();
  throw new Error(`Es besteht bereits ein Developer-Zugang für Personalnummer ${otherDeveloper.employee_number}.`);
}
const portalUser = database.prepare("SELECT employee_number, password_hash FROM portal_users WHERE employee_number = ?").get(employeeNumber);
if (!portalUser || !String(portalUser.password_hash || "").trim()) {
  database.close();
  throw new Error("Für dieses Teammitglied muss zuerst ein funktionierender Portal-Zugang mit Passwort eingerichtet werden.");
}
database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
database.close();

const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = path.join(path.dirname(databasePath), `developer-binding-backup-${timestamp}.db`);
fs.copyFileSync(databasePath, backupPath, fs.constants.COPYFILE_EXCL);

database = new DatabaseSync(databasePath);
database.exec("BEGIN IMMEDIATE");
try {
  database.prepare(`
    UPDATE portal_users
    SET role = 'developer', role_locked = 1, active = 1, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(employeeNumber);
  database.prepare("UPDATE portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND revoked_at IS NULL").run(employeeNumber);
  database.prepare(`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
    VALUES ('developer-tool', 'portal.developer.bind', 'portal_user', ?, 'offline protected role binding')
  `).run(employeeNumber);
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  database.close();
  throw error;
}
database.close();
releaseLock();

console.log(`Developer-Zugang geschützt gebunden: ${employeeNumber} · ${employee.full_name}`);
console.log(`Sicherungsdatei: ${backupPath}`);
console.log("Das bestehende Passwort und eine gegebenenfalls vorgesehene Passwortänderung bleiben erhalten.");
