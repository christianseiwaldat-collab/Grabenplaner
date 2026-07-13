const express = require("express");
const PDFDocument = require("pdfkit");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { createAmuStorage, syncEncryptedFilesBackup } = require("./lib/amu-storage");
const { prepareAmuDocument } = require("./lib/amu-processing");
const packageMetadata = require("./package.json");
const APP_NAME = "Grabenplaner";
const PORTAL_API_VERSION = 1;
const DEFAULT_OPERATION_MODE = "local";
const SERVER_MODE_STATUS = "active";
const LOCAL_PORTAL_PASSWORD_MIN_LENGTH = 6;
const SERVER_PORTAL_PASSWORD_MIN_LENGTH = 10;
const PORTAL_SESSION_COOKIE = "grabenplaner_session";
const PORTAL_CSRF_COOKIE = "grabenplaner_csrf";
const scryptAsync = promisify(crypto.scrypt);

const delegablePortalPermissionCatalog = Object.freeze([
  { id: "settings:write", label: "Planungs- und Grundeinstellungen bearbeiten", group: "Einstellungen", warningLevel: "normal" },
  { id: "employees:write", label: "Teammitglieder anlegen, bearbeiten und löschen", group: "Teams & Standorte", warningLevel: "high" },
  { id: "locations:write", label: "Standorte bearbeiten", group: "Teams & Standorte", warningLevel: "high" },
  { id: "departments:write", label: "Abteilungen anlegen und bearbeiten", group: "Teams & Standorte", warningLevel: "normal" },
  { id: "positions:write", label: "Positionen anlegen, bearbeiten und löschen", group: "Teams & Standorte", warningLevel: "normal" },
  { id: "operation_mode:write", label: "Betriebsmodus umschalten", group: "System", warningLevel: "critical" },
]);
const delegablePortalPermissions = new Set(delegablePortalPermissionCatalog.map((entry) => entry.id));

const builtinPortalRoles = [
  {
    id: "employee",
    name: "Mitarbeiter",
    description: "Eigener Dienstplan, eigene Zeiterfassung und eigene Urlaubsanträge.",
    sortOrder: 10,
    permissions: [
      "own_schedule:read",
      "own_time:read",
      "own_time:write",
      "own_time:correction_request",
      "own_vacation:read",
      "own_vacation:request",
      "own_amu:create",
      "own_amu:read",
      "own_amu:withdraw",
    ],
  },
  {
    id: "manager",
    name: "Filialleitung",
    description: "Dienstplanung sowie Prüfung von Zeitbuchungen und Urlaubsanträgen.",
    sortOrder: 20,
    permissions: [
      "own_schedule:read",
      "own_time:read",
      "own_time:write",
      "own_time:correction_request",
      "own_vacation:read",
      "own_vacation:request",
      "own_amu:create",
      "own_amu:read",
      "own_amu:withdraw",
      "employees:read",
      "schedule:read",
      "schedule:write",
      "time:read",
      "time:review",
      "vacation:read",
      "vacation:approve",
      "amu:metadata:read",
      "scopes:write",
    ],
  },
  {
    id: "department_manager",
    name: "Abteilungsleitung",
    description: "Vertretende Antragsfreigabe bei Abwesenheit oder hinterlegter Delegation der Filialleitung.",
    sortOrder: 21,
    permissions: [
      "own_schedule:read", "own_time:read", "own_time:write", "own_time:correction_request",
      "own_vacation:read", "own_vacation:request", "own_amu:create", "own_amu:read", "own_amu:withdraw",
      "employees:read", "schedule:read", "schedule:write",
      "time:read", "time:review", "vacation:read", "vacation:approve",
      "amu:metadata:read",
    ],
  },
  {
    id: "admin",
    name: "Admin",
    description: "Vollzugriff auf Benutzer, Einstellungen, Rollen und Protokolle.",
    sortOrder: 30,
    permissions: [
      "own_schedule:read",
      "own_time:read",
      "own_time:write",
      "own_time:correction_request",
      "own_vacation:read",
      "own_vacation:request",
      "own_amu:create",
      "own_amu:read",
      "own_amu:withdraw",
      "employees:read",
      "schedule:read",
      "schedule:write",
      "time:read",
      "time:review",
      "vacation:read",
      "vacation:approve",
      "settings:write",
      "branding:read",
      "branding:write",
      "rights:read",
      "rights:write",
      "operation_mode:write",
      "employees:write",
      "locations:write",
      "departments:write",
      "positions:write",
      "backup:write",
      "update:write",
      "system:write",
      "users:write",
      "roles:read",
      "roles:write",
      "audit:read",
      "hr:approve",
      "hr:settings",
      "amu:metadata:read",
      "amu:file:read",
      "amu:review",
      "amu:delete",
      "amu:audit",
      "scopes:write",
    ],
  },
  {
    id: "hr",
    name: "Personalleitung",
    description: "Standortübergreifende Prüfung von Urlaub und verbindlichem PL-Zeitausgleich.",
    sortOrder: 25,
    permissions: [
      "own_schedule:read",
      "own_time:read",
      "own_time:write",
      "own_time:correction_request",
      "own_vacation:read",
      "own_vacation:request",
      "own_amu:create",
      "own_amu:read",
      "own_amu:withdraw",
      "employees:read",
      "schedule:read",
      "time:read",
      "time:review",
      "vacation:read",
      "vacation:approve",
      "hr:approve",
      "hr:settings",
      "users:write",
      "settings:write",
      "branding:read",
      "branding:write",
      "rights:read",
      "rights:write",
      "operation_mode:write",
      "employees:write",
      "locations:write",
      "departments:write",
      "positions:write",
      "amu:metadata:read",
      "amu:file:read",
      "amu:review",
      "amu:delete",
      "amu:audit",
      "scopes:write",
    ],
  },
];

const defaultPortalSettings = {
  login_required: "1",
  password_min_length: String(LOCAL_PORTAL_PASSWORD_MIN_LENGTH),
  session_timeout_minutes: "480",
  max_failed_login_attempts: "5",
  account_lock_minutes: "15",
  secure_cookies_required: "1",
  vacation_hr_approval_required: "0",
  amu_retention_days: "730",
  amu_upload_max_mb: "10",
  amu_stored_max_mb: "2",
  amu_convert_images_to_pdf: "1",
  amu_grayscale_images: "1",
  amu_manager_file_access: "0",
  mobile_leadership_layouts: JSON.stringify({
    department_manager: ["timeTracking", "team", "approvals", "schedule", "requests", "more"],
    manager: ["timeTracking", "team", "approvals", "schedule", "requests", "more"],
    hr: ["timeTracking", "approvals", "team", "schedule", "requests", "more"],
    admin: ["timeTracking", "approvals", "team", "schedule", "requests", "more"],
  }),
};

function formatVersionLabel(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)-beta/);
  if (!match) return `v${version}`;
  return match[3] === "0" ? `v${match[1]}.${match[2]} Beta` : `v${match[1]}.${match[2]}.${match[3]} Beta`;
}

const APP_VERSION_LABEL = formatVersionLabel(packageMetadata.version);
const defaultBranding = {
  app_name: "Grabenplaner",
  company_name: "",
  logo_url: "/assets/grabenplaner-logo.svg",
  icon_url: "/assets/webicon.svg",
  logo_alt: "Grabenplaner",
  admin_email: "",
};

const portableDataDirectory = path.join(__dirname, "data");
const configuredDataRoot = String(process.env.GRABENPLANER_DATA_DIR || "").trim();
const environmentOperationMode = String(process.env.GRABENPLANER_OPERATION_MODE || "").trim().toLowerCase();
const serverDataRoot = configuredDataRoot
  ? path.resolve(configuredDataRoot)
  : path.join(process.env.ProgramData || path.join(os.homedir(), "AppData", "Local"), "Grabenplaner");
const runtimeConfigPath = environmentOperationMode === "server" || configuredDataRoot
  ? path.join(serverDataRoot, "runtime-config.json")
  : path.join(portableDataDirectory, "runtime-config.json");

function readRuntimeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRuntimeConfig(values) {
  const next = { ...readRuntimeConfig(), ...values, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
  const temporaryPath = `${runtimeConfigPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, runtimeConfigPath);
  return next;
}

const runtimeConfig = readRuntimeConfig();
const configuredOperationMode = ["local", "lan", "server"].includes(environmentOperationMode)
  ? environmentOperationMode
  : (["local", "lan", "server"].includes(runtimeConfig.operationMode) ? runtimeConfig.operationMode : DEFAULT_OPERATION_MODE);
const serverModeActive = configuredOperationMode === "server";
const publicUrl = String(process.env.GRABENPLANER_PUBLIC_URL || runtimeConfig.publicUrl || "").trim().replace(/\/$/, "");
const trustProxySetting = String(process.env.GRABENPLANER_TRUST_PROXY || runtimeConfig.trustProxy || "loopback").trim() || "loopback";
const serviceControlToken = String(process.env.GRABENPLANER_SERVICE_CONTROL_TOKEN || "").trim();
const deploymentKind = String(process.env.GRABENPLANER_DEPLOYMENT_KIND || "local").trim().toLowerCase() || "local";
const app = express();
const PORT = Number(process.env.PORT || runtimeConfig.port || 3000);
const configuredHost = configuredOperationMode === "lan" ? "0.0.0.0" : "127.0.0.1";
const HOST = String(process.env.GRABENPLANER_HOST || configuredHost).trim() || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const dataRootDirectory = serverModeActive || configuredDataRoot ? serverDataRoot : __dirname;
const dataDirectory = serverModeActive || configuredDataRoot ? path.join(dataRootDirectory, "data") : portableDataDirectory;
const databasePath = process.env.DB_PATH || path.join(dataDirectory, "dienstplan.db");
const appBackupDirectory = serverModeActive || configuredDataRoot ? path.join(dataRootDirectory, "backups") : path.join(__dirname, "backups");
const brandingKitsDirectory = serverModeActive || configuredDataRoot ? path.join(dataRootDirectory, "branding-kits") : path.join(dataDirectory, "branding-kits");
const privateDataDirectory = serverModeActive || configuredDataRoot ? path.join(dataRootDirectory, "private") : path.join(dataDirectory, "private");
const amuStorageDirectory = path.join(privateDataDirectory, "amu");
const defaultBackupDirectorySetting = "%USERPROFILE%\\Documents\\grabenplaner-backups";
const defaultBackupDirectory = process.env.BACKUP_DIR || path.join(os.homedir(), "Documents", "grabenplaner-backups");
const instanceLockPath = databasePath === ":memory:" ? "" : `${path.resolve(databasePath)}.server.lock`;

if (serverModeActive) app.set("trust proxy", trustProxySetting);

function portalPasswordMinLength() {
  return serverModeActive ? SERVER_PORTAL_PASSWORD_MIN_LENGTH : LOCAL_PORTAL_PASSWORD_MIN_LENGTH;
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(appBackupDirectory, { recursive: true });
fs.mkdirSync(brandingKitsDirectory, { recursive: true });
fs.mkdirSync(amuStorageDirectory, { recursive: true });

function loadAmuEncryptionConfiguration() {
  const keyId = String(process.env.GRABENPLANER_AMU_KEY_ID || (serverModeActive ? "" : "local-v1")).trim();
  const environmentKey = String(process.env.GRABENPLANER_AMU_KEY || "").trim();
  if (environmentKey && keyId) return { keyId, key: environmentKey, source: "environment" };
  if (serverModeActive) return null;
  const keyPath = path.join(privateDataDirectory, "amu-local.key");
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, `${crypto.randomBytes(32).toString("base64")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  try { fs.chmodSync(keyPath, 0o600); } catch {}
  return { keyId, key: fs.readFileSync(keyPath, "utf8").trim(), source: "local-key-file", keyPath };
}

const amuEncryptionConfiguration = loadAmuEncryptionConfiguration();
let amuStorage = null;
let amuStorageStartupError = "";
let amuMutationInProgress = 0;
let amuScannerProbe = Promise.resolve(null);
if (amuEncryptionConfiguration) {
  try {
    amuStorage = createAmuStorage({
      rootDirectory: amuStorageDirectory,
      encryptionKeys: { [amuEncryptionConfiguration.keyId]: amuEncryptionConfiguration.key },
      activeKeyId: amuEncryptionConfiguration.keyId,
      scanner: process.env.NODE_ENV === "test" && process.env.GRABENPLANER_TEST_AMU_SCANNER === "clean"
        ? async () => ({ available: true, clean: true, engine: "test" })
        : null,
      requireScanner: serverModeActive && process.env.GRABENPLANER_ALLOW_UNSCANNED_AMU !== "1",
    });
    if (serverModeActive) {
      amuScannerProbe = amuStorage.probeScanner().catch((error) => {
        console.error("AUM-Virenscanner ist nicht betriebsbereit:", error.message);
        return null;
      });
    }
  } catch (error) {
    amuStorageStartupError = error.message;
  }
} else {
  amuStorageStartupError = "Im Serverbetrieb fehlt der konfigurierte AUM-Schlüssel.";
}

function safeRemoveFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o666);
  } catch {}
  fs.rmSync(filePath, { force: true });
}

function cleanupPortableInstallRoot() {
  safeRemoveFile(path.join(__dirname, "public", "assets", ["lamp", "rechter_logo.webp"].join("")));
  if (fs.existsSync(path.join(__dirname, ".git"))) return;

  safeRemoveFile(path.join(__dirname, "public", "assets", "webicon.png"));
  safeRemoveFile(path.join(__dirname, "public", "assets", "webicon.ico"));

  const currentStartFile = `Grabenplaner ${APP_VERSION_LABEL} starten.cmd`;
  const docsDirectory = path.join(__dirname, "docs");
  fs.mkdirSync(docsDirectory, { recursive: true });

  for (const docName of ["README.md", "USB-HINWEISE.txt", "LICENSE.md"]) {
    const source = path.join(__dirname, docName);
    const target = path.join(docsDirectory, docName);
    if (fs.existsSync(source)) {
      try {
        fs.copyFileSync(source, target);
      } catch {}
      safeRemoveFile(source);
    }
  }

  for (const fileName of fs.readdirSync(__dirname)) {
    const filePath = path.join(__dirname, fileName);
    if (!fs.statSync(filePath).isFile()) continue;
    if (/^Grabenplaner v.+ Beta starten\.cmd$/i.test(fileName) && fileName !== currentStartFile) {
      safeRemoveFile(filePath);
      continue;
    }
    if ([".gitignore", "package-lock.json", "pnpm-lock.yaml"].includes(fileName)) {
      safeRemoveFile(filePath);
    }
  }
}

cleanupPortableInstallRoot();

const databaseExistedBeforeOpen = databasePath !== ":memory:" && fs.existsSync(databasePath);
let instanceLockHeld = false;
if (serverModeActive) acquireInstanceLock();
let db;
try {
  db = new DatabaseSync(databasePath);
} catch (error) {
  releaseInstanceLock();
  throw error;
}
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA wal_autocheckpoint = 1000");
let lastBackup = null;
let backupInterval = null;
let retentionInterval = null;
let scannerProbeInterval = null;

function verifyDatabaseFile(filePath) {
  const verification = new DatabaseSync(filePath, { readOnly: true });
  try {
    const result = verification.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
    const ok = result.length === 1 && result[0] === "ok";
    return { ok, result };
  } finally {
    verification.close();
  }
}

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function pruneDatabaseBackups(backupDirectory, keep = 30) {
  const backups = fs
    .readdirSync(backupDirectory)
    .filter((name) => /^dienstplan-.*\.db$/.test(name))
    .map((name) => ({ name, path: path.join(backupDirectory, name), time: fs.statSync(path.join(backupDirectory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const oldBackup of backups.slice(keep)) {
    const pairedAmuDirectory = path.join(backupDirectory, `${path.basename(oldBackup.name, ".db")}.amu`);
    fs.rmSync(oldBackup.path, { force: true });
    fs.rmSync(pairedAmuDirectory, { recursive: true, force: true });
  }
}

function createDatabaseBackupToDirectory(backupDirectory, reason = "automatic", kind = "external") {
  if (databasePath === ":memory:" || !fs.existsSync(databasePath)) return null;
  if (amuMutationInProgress > 0) throw new Error("Die Sicherung wartet, bis der laufende AUM-Upload abgeschlossen ist.");
  if (!amuStorage) throw new Error("Ohne betriebsbereiten AUM-Speicher wird kein unvollständiger Sicherungspunkt erstellt.");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const snapshotName = `dienstplan-${backupTimestamp()}`;
  const target = path.join(backupDirectory, `${snapshotName}.db`);
  const amuTarget = path.join(backupDirectory, `${snapshotName}.amu`);
  const nonce = crypto.randomUUID();
  const temporaryDatabase = `${target}.partial-${nonce}`;
  const temporaryAmu = `${amuTarget}.partial-${nonce}`;
  let amuBackup = null;
  try {
    const escapedTarget = temporaryDatabase.replaceAll("\\", "/").replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escapedTarget}'`);
    const verification = verifyDatabaseFile(temporaryDatabase);
    if (!verification.ok) throw new Error("Das erstellte Datenbank-Backup hat die Integritätsprüfung nicht bestanden.");
    const databaseHash = fileSha256(temporaryDatabase);
    amuBackup = syncEncryptedFilesBackup({
      sourceDirectory: amuStorageDirectory,
      targetDirectory: temporaryAmu,
      manifestMetadata: { database: { fileName: path.basename(target), sha256: databaseHash } },
    });
    fs.renameSync(temporaryAmu, amuTarget);
    fs.renameSync(temporaryDatabase, target);
    if (amuBackup) amuBackup.targetDirectory = amuTarget;
  } catch (error) {
    safeRemoveFile(temporaryDatabase);
    fs.rmSync(temporaryAmu, { recursive: true, force: true });
    fs.rmSync(amuTarget, { recursive: true, force: true });
    safeRemoveFile(target);
    throw error;
  }
  pruneDatabaseBackups(backupDirectory, 30);
  return { path: target, createdAt: new Date().toISOString(), reason, kind, verified: true, amuBackup };
}

function createInternalDatabaseBackup(reason = "automatic") {
  return createDatabaseBackupToDirectory(appBackupDirectory, reason, "app");
}

function createExternalDatabaseBackup(reason = "automatic", settings = tableExists("settings") ? getSettings() : {}) {
  if (settings.external_backup_enabled === "0") return null;
  return createDatabaseBackupToDirectory(backupDirectoryFromSettings(settings), reason, "external");
}

function createDatabaseBackup(reason = "automatic") {
  const settings = tableExists("settings") ? getSettings() : {};
  const appBackup = createInternalDatabaseBackup(reason);
  const externalBackup = createExternalDatabaseBackup(reason, settings);
  lastBackup = {
    path: externalBackup?.path || appBackup?.path || null,
    createdAt: new Date().toISOString(),
    reason,
    appBackup,
    externalBackup,
  };
  return lastBackup;
}

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function ensureColumn(table, column, definition) {
  if (tableExists(table) && !columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      min_staff INTEGER NOT NULL DEFAULT 0,
      day_settings_json TEXT NOT NULL DEFAULT '',
      time_tracking_enabled INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS location_branding (
      location_id TEXT PRIMARY KEY,
      kit_id TEXT NOT NULL DEFAULT 'custom',
      company_name TEXT NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL DEFAULT '/assets/grabenplaner-logo.svg',
      icon_url TEXT NOT NULL DEFAULT '/assets/webicon.svg',
      logo_alt TEXT NOT NULL DEFAULT 'Grabenplaner',
      admin_email TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      name TEXT NOT NULL,
      min_staff INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location_id, name),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS employees (
      personnel_number TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#0b84c6',
      contracted_hours REAL NOT NULL DEFAULT 38.5,
      preferred_day_off TEXT,
      fixed_workdays TEXT NOT NULL DEFAULT '',
      position_id TEXT NOT NULL DEFAULT 'verkaufsmitarbeiter',
      home_location_id TEXT,
      preferred_department_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (home_location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (preferred_department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      builtin INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      department_id INTEGER,
      shift_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      area TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);
    CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_number);

    CREATE TABLE IF NOT EXISTS week_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      group_id TEXT,
      week_start TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      option_type TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      credited_minutes_per_day INTEGER,
      all_day INTEGER NOT NULL DEFAULT 1,
      start_time TEXT,
      end_time TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_week_options_week ON week_options(week_start);

    CREATE TABLE IF NOT EXISTS global_day_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL DEFAULT '01',
      week_start TEXT NOT NULL,
      block_date TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      is_public_holiday INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location_id, block_date),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_global_day_blocks_week ON global_day_blocks(week_start);

    CREATE TABLE IF NOT EXISTS vacation_entitlements (
      employee_number TEXT NOT NULL,
      year INTEGER NOT NULL,
      days REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, year),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pdf_settings (
      scope_type TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_key TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_type, location_id, department_key, key),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedule_notes (
      location_id TEXT NOT NULL,
      department_key TEXT NOT NULL DEFAULT '',
      week_start TEXT NOT NULL,
      note_text TEXT NOT NULL DEFAULT '',
      note_html TEXT NOT NULL DEFAULT '',
      font_size TEXT NOT NULL DEFAULT 'medium',
      bold INTEGER NOT NULL DEFAULT 0,
      italic INTEGER NOT NULL DEFAULT 0,
      underline INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (location_id, department_key, week_start),
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_users (
      employee_number TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'employee',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      password_changed_at TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_sessions (
      id TEXT PRIMARY KEY,
      employee_number TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_access_scopes (
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER NOT NULL DEFAULT 0,
      assigned_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, location_id, department_id),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_permission_grants (
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      granted_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_number, permission),
      FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vacation_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_off_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      request_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      traffic_light TEXT NOT NULL DEFAULT 'yellow',
      check_reason TEXT NOT NULL DEFAULT '',
      option_id INTEGER,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES week_options(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS vacation_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      vacation_group_id TEXT NOT NULL,
      request_type TEXT NOT NULL,
      original_date_from TEXT NOT NULL,
      original_date_to TEXT NOT NULL,
      requested_date_from TEXT,
      requested_date_to TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_off_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      original_request_id INTEGER NOT NULL,
      request_type TEXT NOT NULL,
      requested_date_from TEXT,
      requested_date_to TEXT,
      requested_all_day INTEGER NOT NULL DEFAULT 0,
      requested_start_time TEXT,
      requested_end_time TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_local',
      approval_type TEXT NOT NULL DEFAULT 'local',
      approval_stage TEXT NOT NULL DEFAULT 'local',
      decision_note TEXT NOT NULL DEFAULT '',
      local_approved_by TEXT,
      local_approved_at TEXT,
      hr_approved_by TEXT,
      hr_approved_at TEXT,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (original_request_id) REFERENCES time_off_requests(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_blackouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      block_vacation INTEGER NOT NULL DEFAULT 1,
      block_time_off INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_kind TEXT NOT NULL,
      request_id INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'local',
      action TEXT NOT NULL,
      actor_employee_number TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approval_delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT NOT NULL,
      delegate_employee_number TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (delegate_employee_number) REFERENCES employees(personnel_number) ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER,
      work_date TEXT NOT NULL DEFAULT '',
      entry_type TEXT NOT NULL,
      entry_timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'portal',
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      voided_at TEXT,
      voided_by TEXT,
      void_reason TEXT NOT NULL DEFAULT '',
      correction_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE SET NULL,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS time_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT,
      department_id INTEGER,
      correction_date TEXT NOT NULL,
      requested_change TEXT NOT NULL DEFAULT '',
      request_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      decision_note TEXT NOT NULL DEFAULT '',
      requested_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_notifications (
      id TEXT PRIMARY KEY,
      recipient_employee_number TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recipient_employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS amu_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      incapacity_from TEXT NOT NULL,
      incapacity_to TEXT NOT NULL,
      employee_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'submitted',
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      retention_until TEXT,
      withdrawn_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (location_id) REFERENCES locations(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS amu_documents (
      id TEXT PRIMARY KEY,
      report_id INTEGER NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      detected_mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      scan_status TEXT NOT NULL DEFAULT 'pending',
      encryption_key_id TEXT NOT NULL,
      encryption_iv TEXT NOT NULL,
      encryption_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_by TEXT,
      deleted_at TEXT,
      purged_at TEXT,
      FOREIGN KEY (report_id) REFERENCES amu_reports(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      app_version TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vacation_requests_employee ON vacation_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_time_off_requests_employee ON time_off_requests(employee_number, status, request_date);
    CREATE INDEX IF NOT EXISTS idx_vacation_change_requests_employee ON vacation_change_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_time_off_change_requests_employee ON time_off_change_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_request_blackouts_range ON request_blackouts(location_id, date_from, date_to, active);
    CREATE INDEX IF NOT EXISTS idx_request_decisions_request ON request_decisions(request_kind, request_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_approval_delegations_range ON approval_delegations(location_id, date_from, date_to, active);
    CREATE INDEX IF NOT EXISTS idx_time_entries_employee_date ON time_entries(employee_number, entry_timestamp);
    CREATE INDEX IF NOT EXISTS idx_time_corrections_employee ON time_corrections(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_portal_notifications_recipient ON portal_notifications(recipient_employee_number, read_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_notifications_dedupe ON portal_notifications(recipient_employee_number, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_amu_reports_employee ON amu_reports(employee_number, status, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_amu_reports_location ON amu_reports(location_id, status, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_amu_reports_retention ON amu_reports(retention_until, status);
    CREATE INDEX IF NOT EXISTS idx_amu_documents_report ON amu_documents(report_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_portal_users_role_active ON portal_users(role, active);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_employee ON portal_sessions(employee_number, expires_at);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry ON portal_sessions(expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_portal_permission_grants_employee ON portal_permission_grants(employee_number, permission);
  `);
}

function migrateLegacySchema() {
  if (!tableExists("employees") || columnExists("employees", "personnel_number")) return;

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      ALTER TABLE shifts RENAME TO shifts_legacy;
      ALTER TABLE employees RENAME TO employees_legacy;
    `);
    createSchema();
    db.exec(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours, active, created_at)
      SELECT CAST(id AS TEXT), name, name, color, contracted_hours, active, created_at
      FROM employees_legacy;

      INSERT INTO shifts
        (id, employee_number, shift_date, start_time, end_time, area, note, created_at)
      SELECT id, CAST(employee_id AS TEXT), shift_date, start_time, end_time, area, note, created_at
      FROM shifts_legacy;

      DROP TABLE shifts_legacy;
      DROP TABLE employees_legacy;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

if (serverModeActive && databaseExistedBeforeOpen) createInternalDatabaseBackup("pre-migration");

if (tableExists("employees") && !columnExists("employees", "personnel_number")) {
  migrateLegacySchema();
} else {
  createSchema();
}
createSchema();
if (!columnExists("week_options", "group_id")) {
  db.exec("ALTER TABLE week_options ADD COLUMN group_id TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_week_options_group ON week_options(group_id)");
if (!columnExists("week_options", "credited_minutes_per_day")) {
  db.exec("ALTER TABLE week_options ADD COLUMN credited_minutes_per_day INTEGER");
}
if (!columnExists("week_options", "all_day")) {
  db.exec("ALTER TABLE week_options ADD COLUMN all_day INTEGER NOT NULL DEFAULT 1");
}
if (!columnExists("week_options", "start_time")) {
  db.exec("ALTER TABLE week_options ADD COLUMN start_time TEXT");
}
if (!columnExists("week_options", "end_time")) {
  db.exec("ALTER TABLE week_options ADD COLUMN end_time TEXT");
}
if (!columnExists("employees", "preferred_day_off")) {
  db.exec("ALTER TABLE employees ADD COLUMN preferred_day_off TEXT");
}
if (!columnExists("employees", "fixed_workdays")) {
  db.exec("ALTER TABLE employees ADD COLUMN fixed_workdays TEXT NOT NULL DEFAULT ''");
}
if (!columnExists("employees", "position_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN position_id TEXT NOT NULL DEFAULT 'verkaufsmitarbeiter'");
}
if (!columnExists("employees", "home_location_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN home_location_id TEXT");
}
if (!columnExists("employees", "preferred_department_id")) {
  db.exec("ALTER TABLE employees ADD COLUMN preferred_department_id INTEGER");
}
if (tableExists("locations") && !columnExists("locations", "min_staff")) {
  db.exec("ALTER TABLE locations ADD COLUMN min_staff INTEGER NOT NULL DEFAULT 0");
}
ensureColumn("locations", "day_settings_json", "TEXT NOT NULL DEFAULT ''");
ensureColumn("locations", "time_tracking_enabled", "INTEGER NOT NULL DEFAULT 0");
if (tableExists("departments") && !columnExists("departments", "min_staff")) {
  db.exec("ALTER TABLE departments ADD COLUMN min_staff INTEGER NOT NULL DEFAULT 0");
}
if (tableExists("schedule_notes") && !columnExists("schedule_notes", "note_html")) {
  db.exec("ALTER TABLE schedule_notes ADD COLUMN note_html TEXT NOT NULL DEFAULT ''");
}
if (!columnExists("shifts", "department_id")) {
  db.exec("ALTER TABLE shifts ADD COLUMN department_id INTEGER");
}
ensureColumn("portal_users", "password_changed_at", "TEXT");
ensureColumn("portal_users", "failed_login_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("portal_users", "locked_until", "TEXT");
ensureColumn("portal_roles", "description", "TEXT NOT NULL DEFAULT ''");
ensureColumn("portal_roles", "sort_order", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("portal_roles", "updated_at", "TEXT");
ensureColumn("time_entries", "location_id", "TEXT");
ensureColumn("time_entries", "department_id", "INTEGER");
ensureColumn("time_entries", "work_date", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_entries", "voided_at", "TEXT");
ensureColumn("time_entries", "voided_by", "TEXT");
ensureColumn("time_entries", "void_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_entries", "correction_id", "INTEGER");
ensureColumn("time_corrections", "location_id", "TEXT");
ensureColumn("time_corrections", "department_id", "INTEGER");
ensureColumn("time_corrections", "request_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_corrections", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_corrections", "requested_by", "TEXT");
ensureColumn("amu_reports", "department_id", "INTEGER");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_entries_work_date ON time_entries(employee_number, work_date, entry_timestamp)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_entries_location_date ON time_entries(location_id, work_date, entry_timestamp)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_corrections_context ON time_corrections(location_id, department_id, status, correction_date)");
db.exec("CREATE INDEX IF NOT EXISTS idx_time_corrections_pending_employee_date ON time_corrections(employee_number, correction_date, status)");
db.prepare("UPDATE time_entries SET work_date = SUBSTR(entry_timestamp, 1, 10) WHERE TRIM(COALESCE(work_date, '')) = ''").run();
db.prepare(`
  UPDATE time_entries
  SET location_id = (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = time_entries.employee_number)
  WHERE TRIM(COALESCE(location_id, '')) = ''
`).run();
db.prepare(`
  UPDATE time_entries
  SET department_id = COALESCE(
    (SELECT s.department_id FROM shifts s
      WHERE s.employee_number = time_entries.employee_number AND s.shift_date = time_entries.work_date AND s.department_id IS NOT NULL
      ORDER BY s.start_time, s.id LIMIT 1),
    (SELECT e.preferred_department_id FROM employees e WHERE e.personnel_number = time_entries.employee_number)
  )
  WHERE department_id IS NULL
`).run();
db.prepare(`
  UPDATE time_corrections
  SET location_id = COALESCE(
    (SELECT t.location_id FROM time_entries t
      WHERE t.employee_number = time_corrections.employee_number AND t.work_date = time_corrections.correction_date
        AND TRIM(COALESCE(t.location_id, '')) <> ''
      ORDER BY t.entry_timestamp, t.id LIMIT 1),
    (SELECT e.home_location_id FROM employees e WHERE e.personnel_number = time_corrections.employee_number)
  )
  WHERE TRIM(COALESCE(location_id, '')) = ''
`).run();
db.prepare(`
  UPDATE time_corrections
  SET department_id = COALESCE(
    (SELECT t.department_id FROM time_entries t
      WHERE t.employee_number = time_corrections.employee_number AND t.work_date = time_corrections.correction_date
        AND t.department_id IS NOT NULL
      ORDER BY t.entry_timestamp, t.id LIMIT 1),
    (SELECT s.department_id FROM shifts s
      WHERE s.employee_number = time_corrections.employee_number AND s.shift_date = time_corrections.correction_date
        AND s.department_id IS NOT NULL
      ORDER BY s.start_time, s.id LIMIT 1),
    (SELECT e.preferred_department_id FROM employees e WHERE e.personnel_number = time_corrections.employee_number)
  )
  WHERE department_id IS NULL
`).run();
db.prepare(`
  UPDATE time_corrections SET requested_by = employee_number
  WHERE TRIM(COALESCE(requested_by, '')) = ''
`).run();
ensureColumn("vacation_requests", "vacation_group_id", "TEXT");
ensureColumn("vacation_requests", "location_id", "TEXT");
ensureColumn("vacation_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("vacation_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("vacation_requests", "local_approved_by", "TEXT");
ensureColumn("vacation_requests", "local_approved_at", "TEXT");
ensureColumn("vacation_requests", "hr_approved_by", "TEXT");
ensureColumn("vacation_requests", "hr_approved_at", "TEXT");
ensureColumn("time_off_requests", "location_id", "TEXT");
ensureColumn("time_off_requests", "approval_type", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("time_off_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("time_off_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("time_off_requests", "local_approved_by", "TEXT");
ensureColumn("time_off_requests", "local_approved_at", "TEXT");
ensureColumn("time_off_requests", "hr_approved_by", "TEXT");
ensureColumn("time_off_requests", "hr_approved_at", "TEXT");
ensureColumn("time_off_requests", "original_shifts_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("time_off_requests", "date_from", "TEXT");
ensureColumn("time_off_requests", "date_to", "TEXT");
ensureColumn("time_off_requests", "all_day", "INTEGER NOT NULL DEFAULT 0");
db.prepare("UPDATE time_off_requests SET date_from = COALESCE(date_from, request_date), date_to = COALESCE(date_to, request_date) WHERE date_from IS NULL OR date_to IS NULL").run();
ensureColumn("vacation_change_requests", "approval_stage", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("vacation_change_requests", "decision_note", "TEXT NOT NULL DEFAULT ''");
ensureColumn("vacation_change_requests", "local_approved_by", "TEXT");
ensureColumn("vacation_change_requests", "local_approved_at", "TEXT");
ensureColumn("vacation_change_requests", "hr_approved_by", "TEXT");
ensureColumn("vacation_change_requests", "hr_approved_at", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_portal_users_role_active ON portal_users(role, active)");

function rebuildGlobalDayBlocksForLocations() {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE global_day_blocks RENAME TO global_day_blocks_legacy");
    db.exec(`
      CREATE TABLE global_day_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id TEXT NOT NULL DEFAULT '01',
        week_start TEXT NOT NULL,
        block_date TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        is_public_holiday INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(location_id, block_date),
        FOREIGN KEY (location_id) REFERENCES locations(id)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT OR IGNORE INTO global_day_blocks
        (id, location_id, week_start, block_date, reason, is_public_holiday, created_at)
      SELECT id, '18', week_start, block_date, reason, is_public_holiday, created_at
      FROM global_day_blocks_legacy;
      DROP TABLE global_day_blocks_legacy;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

if (!columnExists("global_day_blocks", "location_id")) {
  rebuildGlobalDayBlocksForLocations();
}
db.exec("CREATE INDEX IF NOT EXISTS idx_global_day_blocks_location_week ON global_day_blocks(location_id, week_start)");

const defaultSettings = {
  branding_company_name: defaultBranding.company_name,
  branding_logo_url: defaultBranding.logo_url,
  branding_icon_url: defaultBranding.icon_url,
  branding_logo_alt: defaultBranding.logo_alt,
  branding_admin_email: defaultBranding.admin_email,
  operation_mode: DEFAULT_OPERATION_MODE,
  pdf_title: "Dienstplan",
  pdf_filename_prefix: "Dienstplan",
  pdf_filename_include_kw: "1",
  pdf_filename_include_timestamp: "0",
  vacation_pdf_title: "Urlaubsplanung",
  vacation_pdf_filename_prefix: "Urlaubsplanung",
  vacation_pdf_filename_include_period: "1",
  vacation_pdf_filename_include_timestamp: "0",
  vacation_pdf_show_balance: "1",
  vacation_pdf_balance_show_entitlement: "1",
  vacation_pdf_balance_show_planned: "1",
  vacation_pdf_balance_show_consumed: "0",
  vacation_pdf_calendar_style: "bars",
  toast_duration: "medium",
  show_inactive_personnel: "0",
  show_saturday_service_stats: "1",
  external_backup_enabled: "1",
  backup_directory: process.env.BACKUP_DIR || defaultBackupDirectorySetting,
  backup_interval_hours: "2",
  vacation_count_saturday: "0",
  vacation_pdf_size: "A4",
  allow_past_week_editing: "0",
  current_week_auto_lock: "1",
  current_week_lock_mode: "closing",
  current_week_lock_day: "saturday",
  current_week_lock_time: "17:00",
  break_rule_enabled: "1",
  break_after_minutes: "360",
  break_duration_minutes: "30",
  saturday_bonus_enabled: "1",
  saturday_bonus_from: "13:00",
  saturday_bonus_factor: "1.5",
  weekday_start_time: "09:00",
  weekday_end_time: "18:00",
  saturday_start_time: "10:00",
  saturday_end_time: "17:00",
  show_sunday: "0",
};

const planningDays = [
  ["monday", "09:00", "18:00"],
  ["tuesday", "09:00", "18:00"],
  ["wednesday", "09:00", "18:00"],
  ["thursday", "09:00", "18:00"],
  ["friday", "09:00", "18:00"],
  ["saturday", "10:00", "17:00"],
];
const fixedWorkdayKeys = planningDays.map(([day]) => day);

for (const [day, start, end] of planningDays) {
  defaultSettings[`${day}_open`] = "1";
  defaultSettings[`${day}_start_time`] = start;
  defaultSettings[`${day}_end_time`] = end;
  defaultSettings[`${day}_lunch_enabled`] = "0";
  defaultSettings[`${day}_lunch_start`] = "13:00";
  defaultSettings[`${day}_lunch_end`] = "14:00";
  defaultSettings[`${day}_min_staff`] = "0";
  defaultSettings[`${day}_min_from`] = start;
  defaultSettings[`${day}_min_to`] = end;
}

const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [key, value] of Object.entries(defaultSettings)) insertSetting.run(key, value);

function legacyDaySettingsSnapshot() {
  const stored = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  return Object.fromEntries(planningDays.map(([day]) => [day, {
    open: stored[`${day}_open`] !== "0",
    start: stored[`${day}_start_time`], end: stored[`${day}_end_time`],
    lunchEnabled: stored[`${day}_lunch_enabled`] === "1",
    lunchStart: stored[`${day}_lunch_start`], lunchEnd: stored[`${day}_lunch_end`],
    minStaff: Number(stored[`${day}_min_staff`] || 0),
    minFrom: stored[`${day}_min_from`], minTo: stored[`${day}_min_to`],
  }]));
}
db.prepare("UPDATE locations SET day_settings_json = ? WHERE TRIM(COALESCE(day_settings_json, '')) = ''")
  .run(JSON.stringify(legacyDaySettingsSnapshot()));

const builtinPositions = [
  ["teamleitung", "Teamleitung", 1],
  ["abteilungsleitung", "Abteilungsleitung", 2],
  ["verkaufsmitarbeiter", "Verkaufsmitarbeiter", 3],
  ["lehrling", "Lehrling", 4],
];
const insertPosition = db.prepare("INSERT OR IGNORE INTO positions (id, name, builtin, sort_order) VALUES (?, ?, 1, ?)");
for (const [id, name, order] of builtinPositions) insertPosition.run(id, name, order);
db.prepare("UPDATE employees SET position_id = 'verkaufsmitarbeiter' WHERE position_id IS NULL OR position_id = ''").run();

const upsertPortalRole = db.prepare(`
  INSERT INTO portal_roles (id, name, description, builtin, permissions, sort_order, updated_at)
  VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    builtin = 1,
    permissions = excluded.permissions,
    sort_order = excluded.sort_order,
    updated_at = CURRENT_TIMESTAMP
`);
for (const role of builtinPortalRoles) {
  upsertPortalRole.run(role.id, role.name, role.description, JSON.stringify(role.permissions), role.sortOrder);
}
const insertPortalSetting = db.prepare("INSERT OR IGNORE INTO portal_settings (key, value) VALUES (?, ?)");
for (const [key, value] of Object.entries(defaultPortalSettings)) insertPortalSetting.run(key, value);
db.prepare("UPDATE portal_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'password_min_length'")
  .run(String(portalPasswordMinLength()));
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.49-server-foundation", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.50-portal-notifications-amu", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.51-location-hours-scopes-request-ranges", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.52-time-tracking-amu-policies", packageMetadata.version);
db.prepare("INSERT OR IGNORE INTO schema_migrations (id, app_version) VALUES (?, ?)")
  .run("v0.53-rights-branding-time-corrections-mobile", packageMetadata.version);

const startupIntegrity = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
if (!(startupIntegrity.length === 1 && startupIntegrity[0] === "ok")) {
  throw new Error(`Datenbank-Integritätsprüfung fehlgeschlagen: ${startupIntegrity.join("; ")}`);
}

function ensureDefaultLocation() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM locations").get().count;
  if (count === 0) {
    db.prepare("INSERT INTO locations (id, name, day_settings_json, active) VALUES ('01', 'Hauptstandort', ?, 1)")
      .run(JSON.stringify(legacyDaySettingsSnapshot()));
  }
  const defaultLocation = db.prepare("SELECT id FROM locations ORDER BY active DESC, id LIMIT 1").get();
  if (defaultLocation) {
    db.prepare("UPDATE employees SET home_location_id = ? WHERE home_location_id IS NULL OR home_location_id = ''")
      .run(defaultLocation.id);
  }
}

ensureDefaultLocation();

const seedEmployees = [
  ["101", "Alex Demo", "Alex", "#0b84c6"],
  ["102", "Bea Demo", "Bea", "#e26500"],
  ["103", "Cem Demo", "Cem", "#07a67a"],
  ["104", "Dana Demo", "Dana", "#c873a5"],
  ["105", "Erik Demo", "Erik", "#7651b5"],
  ["106", "Fina Demo", "Fina", "#c58b00"],
];

if (process.env.GRABENPLANER_SEED_DEMO === "1" && db.prepare("SELECT COUNT(*) AS count FROM employees").get().count === 0) {
  const seedLocationId = db.prepare("SELECT id FROM locations ORDER BY active DESC, id LIMIT 1").get()?.id || "01";
  const insertEmployee = db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
    VALUES (?, ?, ?, ?, 38.5, ?, 1)
  `);
  for (const employee of seedEmployees) insertEmployee.run(...employee, seedLocationId);
}

app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (request.secure) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (request.path.startsWith("/api/portal/")) response.setHeader("Cache-Control", "no-store");
  if (serverModeActive && !request.secure) {
    const loopbackServiceEndpoint = isLoopbackRequest(request)
      && ((request.method === "GET" && request.path === "/api/health") || (request.method === "POST" && request.path === "/api/service/stop"));
    if (!loopbackServiceEndpoint) {
      response.status(426).json({ error: "Der öffentliche Serverbetrieb akzeptiert ausschließlich HTTPS.", code: "HTTPS_REQUIRED" });
      return;
    }
  }
  if (serverModeActive && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = String(request.headers.origin || "").replace(/\/$/, "");
    if (origin && publicUrl && origin !== publicUrl) {
      response.status(403).json({ error: "Die Anfrage stammt nicht von der konfigurierten Serveradresse.", code: "ORIGIN_NOT_ALLOWED" });
      return;
    }
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use("/branding-kits", express.static(brandingKitsDirectory));
app.use("/vendor/quill", express.static(path.join(__dirname, "node_modules", "quill", "dist")));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", enforceAdminApiAccess);

function httpError(status, message, code = "") {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function requireAmuStorage() {
  if (!amuStorage) throw httpError(503, amuStorageStartupError || "Der geschützte AUM-Speicher ist nicht verfügbar.", "AMU_STORAGE_UNAVAILABLE");
  return amuStorage;
}

function parseAmuMultipart(request, { maxFileBytes = 10 * 1024 * 1024, totalMaxBytes = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers["content-type"] || "");
    const boundaryMatch = contentType.match(/^multipart\/form-data\s*;[\s\S]*?boundary=(?:"([^"]+)"|([^;\s]+))/i);
    const boundary = String(boundaryMatch?.[1] || boundaryMatch?.[2] || "");
    if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) {
      reject(httpError(415, "Bitte die AUM als Formular mit PDF- oder Bilddateien senden.", "AMU_MULTIPART_REQUIRED"));
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > totalMaxBytes) {
        fail(httpError(413, `Der gesamte AUM-Upload darf höchstens ${Math.ceil(totalMaxBytes / 1024 / 1024)} MB groß sein.`, "AMU_UPLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => fail(httpError(400, "Der AUM-Upload konnte nicht gelesen werden.", "AMU_MULTIPART_INVALID")));
    request.on("end", () => {
      if (settled) return;
      try {
        const body = Buffer.concat(chunks);
        const delimiter = Buffer.from(`--${boundary}`, "utf8");
        const nextDelimiter = Buffer.from(`\r\n--${boundary}`, "utf8");
        const fields = {};
        const documents = [];
        let position = body.indexOf(delimiter);
        let partCount = 0;
        if (position !== 0) throw httpError(400, "Das Upload-Formular ist ungültig.", "AMU_MULTIPART_INVALID");
        while (position >= 0) {
          position += delimiter.length;
          if (body.subarray(position, position + 2).toString("ascii") === "--") break;
          if (body.subarray(position, position + 2).toString("ascii") !== "\r\n") throw httpError(400, "Das Upload-Formular ist ungültig.", "AMU_MULTIPART_INVALID");
          position += 2;
          const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), position);
          if (headerEnd < 0 || headerEnd - position > 8192) throw httpError(400, "Ein Upload-Teil hat ungültige Kopfzeilen.", "AMU_MULTIPART_INVALID");
          const headers = body.subarray(position, headerEnd).toString("utf8");
          const dataStart = headerEnd + 4;
          const dataEnd = body.indexOf(nextDelimiter, dataStart);
          if (dataEnd < 0) throw httpError(400, "Das Upload-Formular ist unvollständig.", "AMU_MULTIPART_INVALID");
          const data = body.subarray(dataStart, dataEnd);
          const disposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line)) || "";
          const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1] || "";
          const encodedFilename = disposition.match(/(?:^|;)\s*filename\*=UTF-8''([^;]+)/i)?.[1];
          const plainFilename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
          let filename = plainFilename || "";
          if (encodedFilename) { try { filename = decodeURIComponent(encodedFilename); } catch {} }
          partCount += 1;
          if (partCount > 9) throw httpError(413, "Das AUM-Formular enthält zu viele Teile.", "AMU_TOO_MANY_PARTS");
          if (filename && name === "documents") {
            if (data.length > maxFileBytes) throw httpError(413, `Eine AUM-Datei darf höchstens ${Math.ceil(maxFileBytes / 1024 / 1024)} MB groß sein.`, "AMU_DOCUMENT_TOO_LARGE");
            documents.push({ originalName: filename, buffer: Buffer.from(data) });
            if (documents.length > 3) throw httpError(413, "Pro AUM sind höchstens drei Dateien möglich.", "AMU_TOO_MANY_DOCUMENTS");
          } else if (!filename && ["incapacityFrom", "incapacityTo", "employeeNote"].includes(name)) {
            if (data.length > 4096) throw httpError(413, "Ein AUM-Textfeld ist zu groß.", "AMU_FIELD_TOO_LARGE");
            fields[name] = data.toString("utf8");
          }
          position = dataEnd + 2;
        }
        settled = true;
        resolve({ fields, documents });
      } catch (error) {
        fail(error.status ? error : httpError(400, "Das Upload-Formular ist ungültig.", "AMU_MULTIPART_INVALID"));
      }
    });
  });
}

async function hashPortalPassword(password) {
  const value = String(password || "");
  const minimum = portalPasswordMinLength();
  if (value.length < minimum) {
    throw httpError(400, `Das Passwort muss in diesem Betriebsmodus mindestens ${minimum} Zeichen lang sein.`, "PORTAL_PASSWORD_TOO_SHORT");
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptAsync(value, salt, 64);
  return `scrypt-v1$${salt.toString("base64url")}$${Buffer.from(derivedKey).toString("base64url")}`;
}

async function verifyPortalPassword(password, storedHash) {
  const [version, encodedSalt, encodedKey, ...remainder] = String(storedHash || "").split("$");
  if (version !== "scrypt-v1" || !encodedSalt || !encodedKey || remainder.length) return false;
  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const expectedKey = Buffer.from(encodedKey, "base64url");
    if (salt.length < 16 || expectedKey.length !== 64) return false;
    const actualKey = Buffer.from(await scryptAsync(String(password || ""), salt, expectedKey.length));
    return crypto.timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

const loginRateLimits = new Map();

function loginRateKey(request) {
  return String(request.ip || request.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function assertLoginRateLimit(request) {
  if (!serverModeActive) return;
  const key = loginRateKey(request);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const recent = (loginRateLimits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  loginRateLimits.set(key, recent);
  if (recent.length >= 15) {
    const retrySeconds = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    const error = httpError(429, "Von diesem Gerät gab es zu viele fehlgeschlagene Anmeldungen. Bitte später erneut versuchen.", "LOGIN_RATE_LIMITED");
    error.retryAfter = retrySeconds;
    throw error;
  }
}

function registerFailedLogin(request) {
  if (!serverModeActive) return;
  const key = loginRateKey(request);
  const attempts = loginRateLimits.get(key) || [];
  attempts.push(Date.now());
  loginRateLimits.set(key, attempts.slice(-15));
}

function clearLoginRate(request) {
  loginRateLimits.delete(loginRateKey(request));
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try { return [key, decodeURIComponent(rawValue)]; } catch { return [key, rawValue]; }
  }).filter(([key]) => key));
}

function appendCookie(response, value) {
  const current = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [current]), value] : value);
}

function portalCookie(name, value, request, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (serverModeActive || request.secure || String(request.headers["x-forwarded-proto"] || "").toLowerCase() === "https") parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join("; ");
}

function clearPortalCookies(request, response) {
  appendCookie(response, portalCookie(PORTAL_SESSION_COOKIE, "", request, { httpOnly: true, maxAge: 0 }));
  appendCookie(response, portalCookie(PORTAL_CSRF_COOKIE, "", request, { maxAge: 0 }));
}

function getLanUrls(port = PORT) {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal || address.address.startsWith("169.254.")) continue;
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return [...new Set(urls)].sort();
}

function isLoopbackRequest(request) {
  const address = String(request.socket?.remoteAddress || "").replace(/^::ffff:/, "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function auditPortal(actor, action, entityType = "", entityId = "", detail = "") {
  db.prepare(`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(String(actor || ""), String(action), String(entityType || ""), String(entityId || ""), String(detail || "").slice(0, 2000));
}

function createPortalNotification(recipient, eventType, title, message = "", options = {}) {
  const employeeNumber = String(recipient || "").trim();
  if (!employeeNumber || employeeNumber === "local") return null;
  const id = crypto.randomUUID();
  const dedupeKey = options.dedupeKey ? String(options.dedupeKey).slice(0, 240) : null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO portal_notifications
      (id, recipient_employee_number, event_type, title, message, target, entity_type, entity_id, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    employeeNumber,
    String(eventType || "info").slice(0, 80),
    stripEmoji(String(title || "")).slice(0, 160),
    stripEmoji(String(message || "")).slice(0, 500),
    String(options.target || "/portal/?tab=requests").slice(0, 240),
    String(options.entityType || "").slice(0, 80),
    String(options.entityId || "").slice(0, 120),
    dedupeKey,
  );
  return result.changes ? id : null;
}

function requestReviewerRecipients(locationId, departmentId = null, stage = "local", excludeEmployeeNumber = "") {
  const rows = stage === "hr"
    ? db.prepare(`
        SELECT u.employee_number FROM portal_users u
        WHERE u.active = 1 AND TRIM(u.password_hash) <> '' AND u.role IN ('hr','admin')
        ORDER BY u.employee_number
      `).all()
    : db.prepare(`
        SELECT u.employee_number FROM portal_users u
        JOIN employees e ON e.personnel_number = u.employee_number
        WHERE u.active = 1 AND TRIM(u.password_hash) <> ''
          AND (u.role = 'admin' OR (u.role IN ('manager','department_manager') AND (
            EXISTS (SELECT 1 FROM portal_access_scopes s WHERE s.employee_number = u.employee_number
              AND s.location_id = ? AND (u.role = 'manager' OR s.department_id = ?))
            OR (NOT EXISTS (SELECT 1 FROM portal_access_scopes s WHERE s.employee_number = u.employee_number)
              AND e.home_location_id = ? AND (u.role = 'manager' OR e.preferred_department_id = ?))
          )))
        ORDER BY u.employee_number
      `).all(String(locationId || ""), Number(departmentId || 0), String(locationId || ""), Number(departmentId || 0));
  return [...new Set(rows.map((row) => row.employee_number).filter((value) => value && value !== excludeEmployeeNumber))];
}

function notifyRequestReviewers(entry, kind, stage = "local", actor = "") {
  const labels = { vacation: "Urlaubsantrag", vacation_change: "Urlaubsänderung", time_off: "ZA-Antrag", time_off_change: "ZA-Änderung" };
  const label = labels[kind] || "Abwesenheitsantrag";
  const requestContext = employeeRequestContext(entry.employee_number, entry.request_date || entry.date_from);
  const locationId = entry.location_id || requestContext.locationId;
  const targetKind = kind.startsWith("time_off") ? "time_off" : "vacation";
  const target = `/?view=requests&kind=${targetKind}`;
  for (const recipient of requestReviewerRecipients(locationId, requestContext.departmentId, stage, actor)) {
    createPortalNotification(recipient, "request.review", `${label} wartet auf Prüfung`, `${entry.employee_number} hat einen Antrag eingereicht.`, {
      target,
      entityType: kind,
      entityId: entry.id,
      dedupeKey: `${kind}:${entry.id}:${stage}:review`,
    });
  }
}

function notifyRequestDecision(entry, kind, status, actor = "") {
  const labels = { vacation: "Urlaubsantrag", vacation_change: "Urlaubsänderung", time_off: "ZA-Antrag", time_off_change: "ZA-Änderung" };
  const statusText = {
    approved: "wurde genehmigt",
    rejected: "wurde abgelehnt",
    cancelled: "wurde storniert",
    withdrawn: "wurde zurückgezogen",
    preliminary_local: "wurde vorläufig genehmigt",
    pending_hr: "wurde an die Personalleitung weitergeleitet",
  }[status] || "wurde bearbeitet";
  createPortalNotification(entry.employee_number, "request.decision", `${labels[kind] || "Antrag"} ${statusText}`, actor ? `Bearbeitet von Personalnummer ${actor}.` : "", {
    target: "/portal/?tab=requests",
    entityType: kind,
    entityId: entry.id,
    dedupeKey: `${kind}:${entry.id}:${status}:${actor || "system"}`,
  });
}

function resolveRequestReviewNotifications(kind, id, stage = "") {
  const suffix = stage ? `${stage}:review` : ":review";
  const pattern = stage ? `${kind}:${id}:${suffix}` : `${kind}:${id}:%:review`;
  db.prepare(`
    UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE event_type = 'request.review' AND dedupe_key LIKE ?
  `).run(pattern);
}

function portalSessionFromRequest(request, { touch = true } = {}) {
  const token = parseCookies(request)[PORTAL_SESSION_COOKIE];
  if (!token) return null;
  const now = new Date().toISOString();
  const session = db.prepare(`
    SELECT s.id, s.employee_number, s.expires_at, s.revoked_at,
           u.role, u.active, u.must_change_password,
           e.full_name, e.nickname, e.color, e.home_location_id, e.preferred_department_id,
           r.name AS role_name, r.permissions
    FROM portal_sessions s
    JOIN portal_users u ON u.employee_number = s.employee_number
    JOIN employees e ON e.personnel_number = u.employee_number
    LEFT JOIN portal_roles r ON r.id = u.role
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
      AND u.active = 1
    LIMIT 1
  `).get(sha256(token), now);
  if (!session) return null;
  if (touch) db.prepare("UPDATE portal_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);
  const scopes = ["admin", "hr"].includes(session.role) ? [] : db.prepare(`
    SELECT location_id, department_id FROM portal_access_scopes
    WHERE employee_number = ? ORDER BY location_id, department_id
  `).all(session.employee_number).map((scope) => ({ locationId: scope.location_id, departmentId: Number(scope.department_id || 0) || null }));
  if (!scopes.length && !["admin", "hr"].includes(session.role) && session.home_location_id) {
    scopes.push({ locationId: session.home_location_id, departmentId: session.role === "department_manager" ? (Number(session.preferred_department_id) || null) : null });
  }
  const rolePermissions = parsePortalPermissions(session.permissions);
  const grantedPermissions = ["manager", "department_manager"].includes(session.role)
    ? portalPermissionGrantsForEmployee(session.employee_number)
    : [];
  return {
    id: session.id,
    employeeNumber: session.employee_number,
    fullName: session.full_name,
    nickname: session.nickname,
    color: session.color,
    homeLocationId: session.home_location_id,
    role: session.role,
    roleName: session.role_name || session.role,
    permissions: [...new Set([...rolePermissions, ...grantedPermissions])],
    rolePermissions,
    grantedPermissions,
    scopes,
    mustChangePassword: Boolean(session.must_change_password),
    expiresAt: session.expires_at,
  };
}

function publicPortalUser(session) {
  if (!session) return null;
  return {
    employeeNumber: session.employeeNumber,
    fullName: session.fullName,
    nickname: session.nickname,
    color: session.color,
    homeLocationId: session.homeLocationId,
    role: session.role,
    roleName: session.roleName,
    permissions: session.permissions,
    rolePermissions: session.rolePermissions || [],
    grantedPermissions: session.grantedPermissions || [],
    scopes: session.scopes || [],
    mustChangePassword: session.mustChangePassword,
  };
}

function sessionHasGlobalScope(session) {
  return !session || session.employeeNumber === "local" || ["admin", "hr"].includes(session.role);
}

function assertSessionContextScope(session, input = {}) {
  if (sessionHasGlobalScope(session)) return;
  const locationId = String(input.locationId || input.location || "").trim();
  const departmentId = Number(input.departmentId || input.department || 0) || null;
  if (!locationId) return;
  const matching = (session.scopes || []).filter((scope) => scope.locationId === locationId);
  if (!matching.length) throw httpError(403, "Diese Filiale ist dem Zugang nicht zugewiesen.", "PORTAL_SCOPE_DENIED");
  if (session.role === "department_manager") {
    if (!departmentId || !matching.some((scope) => Number(scope.departmentId) === departmentId)) {
      throw httpError(403, "Diese Abteilung ist dem Zugang nicht zugewiesen.", "PORTAL_SCOPE_DENIED");
    }
  }
}

function assertSessionEmployeeScope(session, employeeNumber) {
  if (sessionHasGlobalScope(session)) return;
  const employee = db.prepare("SELECT home_location_id, preferred_department_id FROM employees WHERE personnel_number = ?").get(employeeNumber);
  if (!employee) throw httpError(404, "Das Teammitglied wurde nicht gefunden.");
  assertSessionContextScope(session, { locationId: employee.home_location_id, departmentId: employee.preferred_department_id });
}

function assertSessionLocationAdministrationScope(session, locationId) {
  if (sessionHasGlobalScope(session)) return;
  if (!(session.scopes || []).some((scope) => scope.locationId === locationId)) {
    throw httpError(403, "Diese Filiale ist dem Zugang nicht zugewiesen.", "PORTAL_SCOPE_DENIED");
  }
}

function requirePortalSession(request, permission = "") {
  const session = portalSessionFromRequest(request);
  if (!session) throw httpError(401, "Bitte zuerst anmelden.", "PORTAL_LOGIN_REQUIRED");
  if (permission && session.mustChangePassword) {
    throw httpError(428, "Bitte zuerst das persönliche Startpasswort ändern.", "PORTAL_PASSWORD_CHANGE_REQUIRED");
  }
  if (permission && !session.permissions.includes(permission)) {
    throw httpError(403, "Für diese Aktion fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  }
  return session;
}

function assertPortalCsrf(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const cookies = parseCookies(request);
  const cookieToken = String(cookies[PORTAL_CSRF_COOKIE] || "");
  const headerToken = String(request.headers["x-csrf-token"] || "");
  const valid = cookieToken.length >= 24 && headerToken.length === cookieToken.length
    && crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
  if (!valid) throw httpError(403, "Die Sicherheitsprüfung ist abgelaufen. Bitte die Seite neu laden.", "PORTAL_CSRF_INVALID");
}

function enforceAdminApiAccess(request, _response, next) {
  try {
    if (request.path === "/health" || request.path === "/service/stop") return next();
    const status = getPortalStatus();
    if (!status.portalEnabled || request.path.startsWith("/portal/")) return next();
    const method = String(request.method || "GET").toUpperCase();
    let permission = "schedule:read";
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (/^\/branding/.test(request.path)) {
        permission = "branding:write";
      } else if (/^\/employees/.test(request.path)) {
        permission = "employees:write";
      } else if (/^\/locations/.test(request.path)) {
        permission = "locations:write";
      } else if (/^\/departments/.test(request.path)) {
        permission = "departments:write";
      } else if (/^\/positions/.test(request.path)) {
        permission = "positions:write";
      } else if (/^\/backup/.test(request.path)) {
        permission = "backup:write";
      } else if (/^\/update/.test(request.path)) {
        permission = "update:write";
      } else if (/^\/operation-mode/.test(request.path)) {
        permission = "operation_mode:write";
      } else if (/^\/system\/restart/.test(request.path)) {
        permission = "operation_mode:write";
      } else if (/^\/system/.test(request.path)) {
        permission = "system:write";
      } else if (/^\/settings/.test(request.path)) {
        permission = "settings:write";
      } else if (/^\/(vacations|vacation-entitlements)/.test(request.path)) {
        permission = "vacation:approve";
      } else {
        permission = "schedule:write";
      }
    }
    const session = requirePortalSession(request, permission);
    if (session.role === "employee") throw httpError(403, "Bitte das Mitarbeiterportal verwenden.", "PORTAL_EMPLOYEE_ONLY");
    assertPortalCsrf(request);
    assertSessionContextScope(session, { ...request.query, ...request.body });
    request.portalSession = session;
    next();
  } catch (error) {
    next(error);
  }
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function isTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function addDays(isoDate, amount) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function addMonths(isoDate, amount) {
  const source = new Date(`${isoDate}T12:00:00Z`);
  const day = source.getUTCDate();
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + amount, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const austrianHolidayCache = new Map();

function austrianPublicHolidays(year) {
  if (austrianHolidayCache.has(year)) return austrianHolidayCache.get(year);
  const easter = easterSunday(year);
  const holidays = {
    [`${year}-01-01`]: "Neujahr",
    [`${year}-01-06`]: "Heilige Drei Könige",
    [`${year}-03-19`]: "Hl. Josef (Tirol)",
    [addDays(easter, 1)]: "Ostermontag",
    [`${year}-05-01`]: "Staatsfeiertag",
    [addDays(easter, 39)]: "Christi Himmelfahrt",
    [addDays(easter, 50)]: "Pfingstmontag",
    [addDays(easter, 60)]: "Fronleichnam",
    [`${year}-08-15`]: "Mariä Himmelfahrt / Hoher Frauentag (Tirol)",
    [`${year}-10-26`]: "Nationalfeiertag",
    [`${year}-11-01`]: "Allerheiligen",
    [`${year}-12-08`]: "Mariä Empfängnis",
    [`${year}-12-25`]: "Christtag",
    [`${year}-12-26`]: "Stephanitag",
  };
  austrianHolidayCache.set(year, holidays);
  return holidays;
}

function publicHolidayName(isoDate) {
  if (!isIsoDate(isoDate)) return "";
  return austrianPublicHolidays(Number(isoDate.slice(0, 4)))[isoDate] || "";
}

function getMonday(value = new Date().toISOString().slice(0, 10)) {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function getIsoWeek(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const target = new Date(date.valueOf());
  const dayNumber = (date.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4, 12));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  return 1 + Math.round((target - firstThursday) / 604800000);
}

function viennaTodayIso(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function currentWeekStart() {
  return getMonday(viennaTodayIso());
}

function isPastWeekStart(weekStart) {
  return weekStart < currentWeekStart();
}

function viennaNowLocal(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

function viennaLocalDateTime(date, time) {
  if (!isIsoDate(date) || !isTime(time)) throw httpError(400, "Bitte eine gültige Abschlusszeit eingeben.", "TIME_CORRECTION_INVALID");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desiredWallTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = desiredWallTime;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(new Date(timestamp));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const representedWallTime = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    const difference = desiredWallTime - representedWallTime;
    timestamp += difference;
    if (difference === 0) break;
  }
  const result = new Date(timestamp);
  if (viennaNowLocal(result) !== `${date}T${time}`) throw httpError(400, "Diese lokale Uhrzeit ist nicht eindeutig oder nicht gültig.", "TIME_CORRECTION_INVALID");
  return result;
}

function currentWeekLockPoint(settings = getSettings()) {
  const weekStart = currentWeekStart();
  if (settings.current_week_lock_mode === "manual") {
    const offsets = { friday: 4, saturday: 5, sunday: 6 };
    const day = offsets[settings.current_week_lock_day] ?? 5;
    return `${addDays(weekStart, day)}T${isTime(settings.current_week_lock_time) ? settings.current_week_lock_time : "17:00"}`;
  }
  const openDays = planningDays
    .map(([day], index) => ({ day, index, open: settings[`${day}_open`] !== "0", end: settings[`${day}_end_time`] }))
    .filter((item) => item.open && isTime(item.end));
  const last = openDays.at(-1) || { index: 4, end: "18:00" };
  return `${addDays(weekStart, last.index)}T${last.end}`;
}

function assertWeekEditable(weekStart, settings = getSettings()) {
  if (isPastWeekStart(weekStart) && !settingEnabled(settings, "allow_past_week_editing")) {
    throw httpError(423, "Vergangene Kalenderwochen sind standardmäßig gesperrt. Das kann in den Grundeinstellungen aktiviert werden.");
  }
  if (weekStart === currentWeekStart() && settingEnabled(settings, "current_week_auto_lock") && viennaNowLocal() >= currentWeekLockPoint(settings)) {
    throw httpError(423, "Der Dienstplan der aktuellen Woche ist bereits für Änderungen gesperrt.");
  }
}

function assertDateEditable(isoDate, settings = getSettings()) {
  assertWeekEditable(getMonday(isoDate), settings);
}

function getSettings() {
  const stored = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  const effectiveMode = serverModeActive ? "server" : (configuredOperationMode === "lan" ? "lan" : "local");
  return {
    ...stored,
    operation_mode: effectiveMode,
    server_mode_status: SERVER_MODE_STATUS,
  };
}

function daySettingsFromLocation(locationId) {
  const row = db.prepare("SELECT day_settings_json FROM locations WHERE id = ?").get(locationId);
  try {
    const parsed = JSON.parse(row?.day_settings_json || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function settingsForLocation(locationId) {
  const settings = getSettings();
  const branding = brandingForLocation(locationId, settings);
  settings.branding_company_name = branding.companyName;
  settings.branding_logo_url = branding.logoUrl;
  settings.branding_icon_url = branding.iconUrl;
  settings.branding_logo_alt = branding.logoAlt;
  settings.branding_admin_email = branding.adminEmail;
  const days = daySettingsFromLocation(locationId);
  for (const [day] of planningDays) {
    const value = days[day];
    if (!value) continue;
    settings[`${day}_open`] = value.open === false ? "0" : "1";
    settings[`${day}_start_time`] = value.start;
    settings[`${day}_end_time`] = value.end;
    settings[`${day}_lunch_enabled`] = value.lunchEnabled === true ? "1" : "0";
    settings[`${day}_lunch_start`] = value.lunchStart;
    settings[`${day}_lunch_end`] = value.lunchEnd;
    settings[`${day}_min_staff`] = String(Number(value.minStaff || 0));
    settings[`${day}_min_from`] = value.minFrom;
    settings[`${day}_min_to`] = value.minTo;
  }
  return settings;
}

function getPortalSettings() {
  if (!tableExists("portal_settings")) return { ...defaultPortalSettings };
  return {
    ...defaultPortalSettings,
    ...Object.fromEntries(db.prepare("SELECT key, value FROM portal_settings").all().map((row) => [row.key, row.value])),
  };
}

function getAmuPolicy() {
  const settings = getPortalSettings();
  const uploadMaxMb = Math.min(25, Math.max(1, Number(settings.amu_upload_max_mb || 10)));
  const storedMaxMb = Math.min(uploadMaxMb, Math.max(0.5, Number(settings.amu_stored_max_mb || 2)));
  return {
    uploadMaxMb,
    storedMaxMb,
    convertImagesToPdf: settings.amu_convert_images_to_pdf !== "0",
    grayscaleImages: settings.amu_grayscale_images !== "0",
    managerFileAccess: settings.amu_manager_file_access === "1",
  };
}

function validateAmuPolicy(body = {}) {
  const uploadMaxMb = Number(body.uploadMaxMb);
  const storedMaxMb = Number(body.storedMaxMb);
  if (!Number.isFinite(uploadMaxMb) || uploadMaxMb < 1 || uploadMaxMb > 25) {
    throw httpError(400, "Der maximale AUM-Upload muss zwischen 1 und 25 MB liegen.", "AMU_POLICY_INVALID");
  }
  if (!Number.isFinite(storedMaxMb) || storedMaxMb < 0.5 || storedMaxMb > uploadMaxMb) {
    throw httpError(400, "Die gespeicherte AUM-Größe muss zwischen 0,5 MB und dem Upload-Limit liegen.", "AMU_POLICY_INVALID");
  }
  return {
    uploadMaxMb: Math.round(uploadMaxMb * 2) / 2,
    storedMaxMb: Math.round(storedMaxMb * 2) / 2,
    convertImagesToPdf: body.convertImagesToPdf !== false,
    grayscaleImages: body.grayscaleImages !== false,
    managerFileAccess: body.managerFileAccess === true,
  };
}

function actorCanReadAmuFiles(session) {
  if (!session) return false;
  if (session.employeeNumber === "local" || ["admin", "hr"].includes(session.role)) return true;
  if (session.permissions?.includes("amu:file:read")) return true;
  return ["manager", "department_manager"].includes(session.role) && getAmuPolicy().managerFileAccess;
}

function parsePortalPermissions(value) {
  try {
    const permissions = JSON.parse(value || "[]");
    return Array.isArray(permissions) ? permissions.filter((permission) => typeof permission === "string") : [];
  } catch {
    return [];
  }
}

function portalPermissionGrantsForEmployee(employeeNumber) {
  if (!employeeNumber || !tableExists("portal_permission_grants")) return [];
  return db.prepare(`
    SELECT permission FROM portal_permission_grants
    WHERE employee_number = ? ORDER BY permission
  `).all(String(employeeNumber)).map((row) => row.permission)
    .filter((permission) => delegablePortalPermissions.has(permission));
}

function getPortalRoles() {
  return db.prepare(`
    SELECT id, name, description, builtin, permissions, sort_order
    FROM portal_roles
    ORDER BY sort_order, name, id
  `).all().map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description || "",
    builtin: Boolean(role.builtin),
    permissions: parsePortalPermissions(role.permissions),
    sortOrder: Number(role.sort_order || 0),
  }));
}

function getPortalStatus(locationId = "") {
  const settings = getSettings();
  const portalSettings = getPortalSettings();
  const networkRuntimeActive = serverModeActive || !loopbackHosts.has(HOST.toLowerCase()) || process.env.GRABENPLANER_FORCE_PORTAL === "1";
  const portalEnabled = networkRuntimeActive && SERVER_MODE_STATUS === "active";
  const configuredAdmin = db.prepare(`
    SELECT 1
    FROM portal_users
    WHERE active = 1 AND role = 'admin' AND TRIM(password_hash) <> ''
    LIMIT 1
  `).get();
  return {
    apiVersion: PORTAL_API_VERSION,
    operationMode: settings.operation_mode,
    serverModeStatus: SERVER_MODE_STATUS,
    portalEnabled,
    serverModeAvailable: SERVER_MODE_STATUS === "active",
    loginRequired: portalEnabled,
    adminSetupState: configuredAdmin ? "configured" : "not-configured",
    adminSetupAvailable: !configuredAdmin,
    localOnly: loopbackHosts.has(HOST.toLowerCase()),
    listenHost: HOST,
    port: PORT,
    networkUrls: settings.operation_mode === "lan" && portalEnabled ? getLanUrls(PORT) : [],
    publicUrl: serverModeActive ? publicUrl : "",
    httpsRequired: serverModeActive,
    trustProxy: serverModeActive ? trustProxySetting : "",
    deploymentKind,
    passwordMinLength: portalPasswordMinLength(),
    branding: locationId ? brandingForLocation(locationId, settings) : brandingFromSettings(settings),
    capabilities: {
      login: portalEnabled,
      ownSchedule: portalEnabled,
      vacationRequests: portalEnabled,
      timeOffRequests: portalEnabled,
      vacationChanges: portalEnabled,
      requestBlackouts: portalEnabled,
      approvalWorkflow: portalEnabled,
      absenceHistory: portalEnabled,
      notifications: portalEnabled,
      amuReports: portalEnabled && Boolean(amuStorage),
      timeTracking: portalEnabled,
    },
    workflow: {
      vacationHrApprovalRequired: vacationHrApprovalRequired(),
    },
  };
}

function requirePortalAdminOrLocal(request, permission = "users:write") {
  if (!getPortalStatus().portalEnabled && isLoopbackRequest(request)) {
    return { employeeNumber: "local", role: "admin", permissions: [permission] };
  }
  const session = requirePortalSession(request, permission);
  assertPortalCsrf(request);
  return session;
}

function requirePortalReadOrLocal(request, permission = "schedule:read") {
  if (!getPortalStatus().portalEnabled && isLoopbackRequest(request)) {
    return {
      employeeNumber: "local",
      role: "admin",
      permissions: builtinPortalRoles.find((role) => role.id === "admin")?.permissions || [permission],
      scopes: [],
    };
  }
  return requirePortalSession(request, permission);
}

function requireAdminHrOrLocal(request, permission) {
  const session = requirePortalAdminOrLocal(request, permission);
  if (session.employeeNumber !== "local" && !["admin", "hr"].includes(session.role)) {
    throw httpError(403, "Diese Aktion ist nur für Admin oder Personalleitung verfügbar.", "PORTAL_PERMISSION_DENIED");
  }
  return session;
}

function requirePortalAnyPermission(request, permissions) {
  if (!getPortalStatus().portalEnabled && isLoopbackRequest(request)) return { employeeNumber: "local", role: "admin", permissions };
  const session = requirePortalSession(request);
  assertPortalCsrf(request);
  if (!permissions.some((permission) => session.permissions.includes(permission))) throw httpError(403, "Für diese Aktion fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  return session;
}

function portalUsersForAdmin() {
  return db.prepare(`
    SELECT e.personnel_number, e.full_name, e.nickname, e.home_location_id, e.preferred_department_id, e.active AS employee_active,
           u.role, u.active, u.must_change_password, u.last_login_at, u.failed_login_attempts, u.locked_until,
           CASE WHEN TRIM(COALESCE(u.password_hash, '')) <> '' THEN 1 ELSE 0 END AS password_configured,
           r.name AS role_name
    FROM employees e
    LEFT JOIN portal_users u ON u.employee_number = e.personnel_number
    LEFT JOIN portal_roles r ON r.id = u.role
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `).all().map((row) => ({
    employeeNumber: row.personnel_number,
    fullName: row.full_name,
    nickname: row.nickname,
    employeeActive: Boolean(row.employee_active),
    configured: Boolean(row.role),
    role: row.role || "employee",
    roleName: row.role_name || "Mitarbeiter",
    active: row.active === null ? false : Boolean(row.active),
    mustChangePassword: row.must_change_password === null ? true : Boolean(row.must_change_password),
    passwordConfigured: Boolean(row.password_configured),
    lastLoginAt: row.last_login_at || null,
    failedLoginAttempts: Number(row.failed_login_attempts || 0),
    lockedUntil: row.locked_until || null,
    locked: Boolean(row.locked_until && new Date(row.locked_until) > new Date()),
    homeLocationId: row.home_location_id || "",
    preferredDepartmentId: Number(row.preferred_department_id || 0) || null,
    grantedPermissions: portalPermissionGrantsForEmployee(row.personnel_number),
    scopes: db.prepare("SELECT location_id, department_id FROM portal_access_scopes WHERE employee_number = ? ORDER BY location_id, department_id")
      .all(row.personnel_number).map((scope) => ({ locationId: scope.location_id, departmentId: Number(scope.department_id || 0) || null })),
  }));
}

function portalUsersForActor(actor) {
  const users = portalUsersForAdmin();
  if (actor?.role !== "manager") return users;
  const locations = new Set((actor.scopes || []).map((scope) => scope.locationId));
  return users.filter((user) => user.role === "department_manager" && locations.has(user.homeLocationId));
}

function validateVacationRequestDates(employeeNumber, body) {
  const dateFrom = String(body.dateFrom || "");
  const dateTo = String(body.dateTo || "");
  const note = stripEmoji(String(body.note || "").trim()).slice(0, 500);
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Urlaubszeitraum eingeben.");
  }
  const availability = evaluateVacationRequest(employeeNumber, { dateFrom, dateTo });
  if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
  const overlapping = db.prepare(`
    SELECT id FROM vacation_requests
    WHERE employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr','approved')
      AND date_from <= ? AND date_to >= ?
    LIMIT 1
  `).get(employeeNumber, dateTo, dateFrom);
  if (overlapping) throw httpError(409, "Für diesen Zeitraum besteht bereits ein Urlaubsantrag.");
  return { employeeNumber, dateFrom, dateTo, note };
}

function employeeRequestContext(employeeNumber, date = null) {
  const employee = db.prepare(`
    SELECT personnel_number, full_name, nickname, home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ? AND active = 1
  `).get(employeeNumber);
  if (!employee) throw httpError(404, "Das aktive Teammitglied wurde nicht gefunden.");
  let departmentId = employee.preferred_department_id ? Number(employee.preferred_department_id) : null;
  if (date) {
    const shiftDepartment = db.prepare(`
      SELECT department_id FROM shifts
      WHERE employee_number = ? AND shift_date = ? AND department_id IS NOT NULL
      ORDER BY start_time LIMIT 1
    `).get(employeeNumber, date)?.department_id;
    if (shiftDepartment) departmentId = Number(shiftDepartment);
  }
  return {
    employee,
    locationId: employee.home_location_id || getLocations(true)[0]?.id || "01",
    departmentId,
  };
}

const timeEntryTypes = new Set(["clock_in", "break_start", "break_end", "clock_out"]);
const timeEntryLabels = {
  clock_in: "Kommen",
  break_start: "Pause",
  break_end: "Weiter",
  clock_out: "Gehen",
};

function timeEntryStateFromType(type) {
  if (type === "clock_in" || type === "break_end") return "working";
  if (type === "break_start") return "paused";
  return "off";
}

function allowedTimeEntryActions(state) {
  if (state === "off") return ["clock_in"];
  if (state === "working") return ["break_start", "clock_out"];
  if (state === "paused") return ["break_end", "clock_out"];
  return [];
}

function suggestedClockOutTime(employeeNumber, date, locationId, latestTimestamp = "") {
  const shiftEnd = db.prepare(`
    SELECT end_time FROM shifts WHERE employee_number = ? AND shift_date = ?
    ORDER BY end_time DESC LIMIT 1
  `).get(employeeNumber, date)?.end_time;
  const dayIndex = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const dayKey = planningDays[dayIndex]?.[0];
  const settings = settingsForLocation(locationId);
  let suggestion = isTime(shiftEnd) ? shiftEnd : (dayKey && isTime(settings[`${dayKey}_end_time`]) ? settings[`${dayKey}_end_time`] : "18:00");
  const latestLocalTime = latestTimestamp ? viennaNowLocal(new Date(latestTimestamp)).slice(11, 16) : "";
  if (isTime(latestLocalTime) && timeToMinutes(suggestion) < timeToMinutes(latestLocalTime)) suggestion = latestLocalTime;
  return suggestion;
}

function calculateWorkedMinutes(entries, now = new Date()) {
  let runningFrom = null;
  let totalMilliseconds = 0;
  for (const entry of entries) {
    const timestamp = new Date(entry.entry_timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;
    if (entry.entry_type === "clock_in") {
      if (!runningFrom) runningFrom = timestamp;
    } else if (entry.entry_type === "break_start") {
      if (runningFrom) totalMilliseconds += Math.max(0, timestamp - runningFrom);
      runningFrom = null;
    } else if (entry.entry_type === "break_end") {
      if (!runningFrom) runningFrom = timestamp;
    } else if (entry.entry_type === "clock_out") {
      if (runningFrom) totalMilliseconds += Math.max(0, timestamp - runningFrom);
      runningFrom = null;
    }
  }
  if (runningFrom) totalMilliseconds += Math.max(0, now - runningFrom);
  return Math.floor(totalMilliseconds / 60000);
}

function plannedMinutesForEmployeeDate(employeeNumber, date, locationId, departmentId = null) {
  const settings = settingsForLocation(locationId);
  return db.prepare(`
    SELECT id, employee_number, department_id, shift_date, start_time, end_time
    FROM shifts
    WHERE employee_number = ? AND shift_date = ?
      AND (? IS NULL OR department_id = ?)
    ORDER BY start_time, id
  `).all(employeeNumber, date, departmentId, departmentId).reduce((sum, shift) => {
    const metrics = shiftMetrics(shift, settings);
    return sum + Math.max(0, Number(metrics.raw_minutes || 0) - Number(metrics.break_minutes || 0));
  }, 0);
}

function timeEntriesForDay(employeeNumber, date) {
  return db.prepare(`
    SELECT id, employee_number, location_id, department_id, work_date, entry_type,
           entry_timestamp, source, note, created_by, created_at
    FROM time_entries WHERE employee_number = ? AND work_date = ? AND voided_at IS NULL
    ORDER BY entry_timestamp, id
  `).all(employeeNumber, date);
}

function timeTrackingDayStatus(employeeNumber, date = viennaTodayIso(), now = new Date()) {
  if (!isIsoDate(date)) throw httpError(400, "Bitte ein gültiges Datum auswählen.", "TIME_ENTRY_DATE_INVALID");
  const context = employeeRequestContext(employeeNumber, date);
  const location = validateLocationExists(context.locationId);
  const entries = timeEntriesForDay(employeeNumber, date);
  const latestToday = entries.at(-1) || null;
  const latestOverall = db.prepare(`
    SELECT id, location_id, department_id, work_date, entry_type, entry_timestamp
    FROM time_entries WHERE employee_number = ? AND voided_at IS NULL ORDER BY entry_timestamp DESC, id DESC LIMIT 1
  `).get(employeeNumber) || null;
  const today = viennaTodayIso(now);
  const staleEntry = latestOverall && latestOverall.work_date < today && timeEntryStateFromType(latestOverall.entry_type) !== "off"
    ? latestOverall
    : null;
  const state = staleEntry && date === today ? "attention" : timeEntryStateFromType(latestToday?.entry_type);
  const trackingEnabled = Boolean(location.time_tracking_enabled);
  const allowedActions = trackingEnabled && date === today && !staleEntry ? allowedTimeEntryActions(state) : [];
  const plannedMinutes = plannedMinutesForEmployeeDate(employeeNumber, date, context.locationId);
  const actualMinutes = calculateWorkedMinutes(entries, now);
  return {
    date,
    workDate: date,
    timezone: "Europe/Vienna",
    serverTime: now.toISOString(),
    trackingEnabled,
    enabled: trackingEnabled,
    locationId: context.locationId,
    locationName: location.name,
    departmentId: context.departmentId,
    state,
    stateSince: latestToday?.entry_timestamp || staleEntry?.entry_timestamp || null,
    staleEntry: staleEntry ? {
      date: staleEntry.work_date,
      type: staleEntry.entry_type,
      timestamp: staleEntry.entry_timestamp,
      suggestedClockOutTime: suggestedClockOutTime(employeeNumber, staleEntry.work_date, staleEntry.location_id || context.locationId, staleEntry.entry_timestamp),
      message: `Eine Buchung vom ${staleEntry.work_date} wurde nicht mit „Gehen“ abgeschlossen. Bitte die Leitung informieren.`,
    } : null,
    reason: !trackingEnabled
      ? "Die Zeiterfassung ist für diesen Standort noch nicht aktiviert."
      : staleEntry
        ? `Eine Buchung vom ${staleEntry.work_date} wurde nicht mit „Gehen“ abgeschlossen. Bitte die Leitung informieren.`
        : "",
    allowedActions,
    plannedMinutes,
    actualMinutes,
    differenceMinutes: actualMinutes - plannedMinutes,
    entries: entries.map((entry) => ({
      id: Number(entry.id),
      type: entry.entry_type,
      label: timeEntryLabels[entry.entry_type] || entry.entry_type,
      timestamp: entry.entry_timestamp,
      locationId: entry.location_id || context.locationId,
      departmentId: Number(entry.department_id || 0) || null,
    })),
  };
}

function bookTimeEntry(employeeNumber, action, now = new Date()) {
  if (!timeEntryTypes.has(action)) throw httpError(400, "Diese Zeitbuchung ist ungültig.", "TIME_ENTRY_ACTION_INVALID");
  const date = viennaTodayIso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = timeTrackingDayStatus(employeeNumber, date, now);
    if (!before.trackingEnabled) {
      throw httpError(409, "Die Zeiterfassung ist für diesen Standort noch nicht aktiviert.", "TIME_TRACKING_DISABLED");
    }
    if (before.staleEntry) {
      throw httpError(409, before.staleEntry.message, "TIME_ENTRY_PREVIOUS_DAY_OPEN");
    }
    if (!before.allowedActions.includes(action)) {
      throw httpError(409, "Diese Buchung passt nicht zum aktuellen Zeiterfassungsstatus. Bitte die Anzeige aktualisieren.", "TIME_ENTRY_STATE_CONFLICT");
    }
    const context = employeeRequestContext(employeeNumber, date);
    const timestamp = now.toISOString();
    const result = db.prepare(`
      INSERT INTO time_entries
        (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'portal', ?)
    `).run(employeeNumber, context.locationId, context.departmentId, date, action, timestamp, employeeNumber);
    auditPortal(employeeNumber, "time.entry.create", "time_entry", String(result.lastInsertRowid), JSON.stringify({ action, date, locationId: context.locationId }));
    db.exec("COMMIT");
    return timeTrackingDayStatus(employeeNumber, date, now);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function resolveStaleTimeEntry(session, employeeNumber, workDate, clockOutTime, now = new Date()) {
  if (!isIsoDate(workDate) || !isTime(clockOutTime)) throw httpError(400, "Bitte Datum und Uhrzeit vollständig eingeben.", "TIME_CORRECTION_INVALID");
  assertSessionEmployeeScope(session, employeeNumber);
  db.exec("BEGIN IMMEDIATE");
  try {
    const latest = db.prepare(`
      SELECT id, employee_number, location_id, department_id, work_date, entry_type, entry_timestamp
      FROM time_entries WHERE employee_number = ? AND voided_at IS NULL ORDER BY entry_timestamp DESC, id DESC LIMIT 1
    `).get(employeeNumber);
    if (!latest || latest.work_date !== workDate || latest.work_date >= viennaTodayIso(now)
      || timeEntryStateFromType(latest.entry_type) === "off") {
      throw httpError(409, "Die offene Altbuchung wurde bereits geändert oder ist nicht mehr vorhanden.", "TIME_CORRECTION_STATE_CONFLICT");
    }
    const fallbackContext = employeeRequestContext(employeeNumber, workDate);
    const correctionContext = {
      locationId: latest.location_id || fallbackContext.locationId,
      departmentId: Number(latest.department_id || 0) || fallbackContext.departmentId,
    };
    assertSessionContextScope(session, correctionContext);
    const correctedAt = viennaLocalDateTime(workDate, clockOutTime);
    const previousAt = new Date(latest.entry_timestamp);
    if (Number.isNaN(previousAt.getTime()) || correctedAt < previousAt || correctedAt >= now) {
      throw httpError(400, "Die Abschlusszeit muss nach der letzten Buchung und vor der aktuellen Serverzeit liegen.", "TIME_CORRECTION_INVALID");
    }
    const note = "Offene Buchung durch die Leitung abgeschlossen";
    const requestedChange = {
      action: "close_stale_entry",
      clockOutTime,
      originalEntryIds: timeEntriesForDay(employeeNumber, workDate).map((entry) => Number(entry.id)),
    };
    const correctionResult = db.prepare(`
      INSERT INTO time_corrections
        (employee_number, location_id, department_id, correction_date, requested_change, request_note,
         status, requested_by, decided_by, decided_at, decision_note)
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP, ?)
    `).run(employeeNumber, correctionContext.locationId, correctionContext.departmentId, workDate,
      JSON.stringify(requestedChange), note, session.employeeNumber, session.employeeNumber, note);
    const correctionId = Number(correctionResult.lastInsertRowid);
    const result = db.prepare(`
      INSERT INTO time_entries
        (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, note, created_by, correction_id)
      VALUES (?, ?, ?, ?, 'clock_out', ?, 'manager_correction', ?, ?, ?)
    `).run(employeeNumber, correctionContext.locationId, correctionContext.departmentId, workDate,
      correctedAt.toISOString(), note, session.employeeNumber, correctionId);
    requestedChange.timeEntryId = Number(result.lastInsertRowid);
    db.prepare("UPDATE time_corrections SET requested_change = ? WHERE id = ?")
      .run(JSON.stringify(requestedChange), correctionId);
    auditPortal(session.employeeNumber, "time.entry.stale.resolve", "time_entry", String(result.lastInsertRowid), JSON.stringify({ employeeNumber, workDate, clockOutTime }));
    auditPortal(session.employeeNumber, "time.correction.approved", "time_correction", String(correctionId), JSON.stringify(requestedChange));
    db.exec("COMMIT");
    return timeTrackingDayStatus(employeeNumber, viennaTodayIso(now), now);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function timePresenceForContext(session, context, date = viennaTodayIso(), now = new Date()) {
  assertSessionContextScope(session, context);
  const employees = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, home_location_id, preferred_department_id
    FROM employees WHERE active = 1 AND home_location_id = ?
  `).all(context.locationId)
    .filter((employee) => !context.departmentId || employeeRequestContext(employee.personnel_number, date).departmentId === context.departmentId)
    .sort((left, right) => left.personnel_number.localeCompare(right.personnel_number, "de", { numeric: true }));
  return {
    date,
    timezone: "Europe/Vienna",
    serverTime: now.toISOString(),
    locationId: context.locationId,
    locationName: context.locationName,
    departmentId: context.departmentId,
    departmentName: context.departmentName,
    trackingEnabled: Boolean(validateLocationExists(context.locationId).time_tracking_enabled),
    employees: employees.map((employee) => ({
      employeeNumber: employee.personnel_number,
      fullName: employee.full_name,
      nickname: employee.nickname,
      color: employee.color,
      ...timeTrackingDayStatus(employee.personnel_number, date, now),
    })),
  };
}

function calculateRecordedMinutes(entries, date, now = new Date()) {
  let runningFrom = null;
  let totalMilliseconds = 0;
  for (const entry of entries) {
    const timestamp = new Date(entry.entry_timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;
    if (entry.entry_type === "clock_in") {
      if (!runningFrom) runningFrom = timestamp;
    } else if (entry.entry_type === "break_start") {
      if (runningFrom) totalMilliseconds += Math.max(0, timestamp - runningFrom);
      runningFrom = null;
    } else if (entry.entry_type === "break_end") {
      if (!runningFrom) runningFrom = timestamp;
    } else if (entry.entry_type === "clock_out") {
      if (runningFrom) totalMilliseconds += Math.max(0, timestamp - runningFrom);
      runningFrom = null;
    }
  }
  if (runningFrom && date === viennaTodayIso(now)) totalMilliseconds += Math.max(0, now - runningFrom);
  return Math.floor(totalMilliseconds / 60000);
}

function parseTimeCorrectionChange(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializeTimeCorrection(row) {
  if (!row) return null;
  const requestedChange = parseTimeCorrectionChange(row.requested_change);
  const proposedEntries = requestedChange.proposedEntries || requestedChange.entries || [];
  return {
    id: Number(row.id),
    employeeNumber: row.employee_number,
    fullName: row.full_name || "",
    nickname: row.nickname || "",
    locationId: row.location_id || "",
    locationName: row.location_name || "",
    departmentId: Number(row.department_id || 0) || null,
    departmentName: row.department_name || "",
    correctionDate: row.correction_date,
    requestedChange,
    requested_change: requestedChange,
    proposedEntries,
    entries: proposedEntries,
    reason: row.request_note || requestedChange.note || "",
    note: row.request_note || requestedChange.note || "",
    status: row.status,
    requestedBy: row.requested_by || row.employee_number,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    decisionNote: row.decision_note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function timeCorrectionRows(whereSql = "", values = []) {
  return db.prepare(`
    SELECT c.*, e.full_name, e.nickname, l.name AS location_name, d.name AS department_name
    FROM time_corrections c
    JOIN employees e ON e.personnel_number = c.employee_number
    LEFT JOIN locations l ON l.id = c.location_id
    LEFT JOIN departments d ON d.id = c.department_id
    ${whereSql}
    ORDER BY c.correction_date DESC, c.created_at DESC, c.id DESC
  `).all(...values).map(serializeTimeCorrection);
}

function activeTimeEntriesForRange(employeeNumber, dateFrom, dateTo, departmentId = null) {
  return db.prepare(`
    SELECT id, employee_number, location_id, department_id, work_date, entry_type,
           entry_timestamp, source, note, created_by, correction_id, created_at
    FROM time_entries
    WHERE employee_number = ? AND work_date BETWEEN ? AND ? AND voided_at IS NULL
      AND (? IS NULL OR department_id = ?)
    ORDER BY work_date, entry_timestamp, id
  `).all(employeeNumber, dateFrom, dateTo, departmentId, departmentId);
}

function timeSummaryForEmployee(employeeNumber, dateFrom, dateTo, period = "range", now = new Date(), departmentId = null) {
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom || daysBetweenInclusive(dateFrom, dateTo) > 370) {
    throw httpError(400, "Bitte einen gültigen Auswertungszeitraum von höchstens 370 Tagen wählen.", "TIME_SUMMARY_RANGE_INVALID");
  }
  const employee = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ? AND active = 1
  `).get(employeeNumber);
  if (!employee) throw httpError(404, "Das aktive Teammitglied wurde nicht gefunden.");
  const entriesByDate = new Map();
  for (const entry of activeTimeEntriesForRange(employeeNumber, dateFrom, dateTo, departmentId)) {
    if (!entriesByDate.has(entry.work_date)) entriesByDate.set(entry.work_date, []);
    entriesByDate.get(entry.work_date).push(entry);
  }
  const correctionsByDate = new Map();
  for (const correction of timeCorrectionRows(
    `WHERE c.employee_number = ? AND c.correction_date BETWEEN ? AND ? AND c.status <> 'withdrawn'
       AND (? IS NULL OR c.department_id = ?)`,
    [employeeNumber, dateFrom, dateTo, departmentId, departmentId],
  )) {
    if (!correctionsByDate.has(correction.correctionDate)) correctionsByDate.set(correction.correctionDate, correction);
  }
  const days = [];
  for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
    const entries = entriesByDate.get(date) || [];
    const context = employeeRequestContext(employeeNumber, date);
    const plannedMinutes = plannedMinutesForEmployeeDate(employeeNumber, date, context.locationId, departmentId);
    const actualMinutes = calculateRecordedMinutes(entries, date, now);
    const finalState = timeEntryStateFromType(entries.at(-1)?.entry_type);
    days.push({
      date,
      workDate: date,
      plannedMinutes,
      actualMinutes,
      differenceMinutes: actualMinutes - plannedMinutes,
      incomplete: entries.length > 0 && finalState !== "off",
      entries: entries.map((entry) => ({
        id: Number(entry.id),
        type: entry.entry_type,
        label: timeEntryLabels[entry.entry_type] || entry.entry_type,
        timestamp: entry.entry_timestamp,
        source: entry.source,
      })),
      correction: correctionsByDate.get(date) || null,
    });
  }
  const totals = days.reduce((result, day) => ({
    plannedMinutes: result.plannedMinutes + day.plannedMinutes,
    actualMinutes: result.actualMinutes + day.actualMinutes,
    differenceMinutes: result.differenceMinutes + day.differenceMinutes,
  }), { plannedMinutes: 0, actualMinutes: 0, differenceMinutes: 0 });
  return {
    period,
    from: dateFrom,
    to: dateTo,
    dateFrom,
    dateTo,
    employeeNumber: employee.personnel_number,
    fullName: employee.full_name,
    nickname: employee.nickname,
    color: employee.color,
    ...totals,
    incompleteDays: days.filter((day) => day.incomplete).length,
    totals,
    days,
  };
}

function ownTimeSummary(employeeNumber, periodValue, anchorValue) {
  const period = periodValue === "month" ? "month" : "week";
  const anchor = isIsoDate(anchorValue) ? anchorValue : viennaTodayIso();
  if (period === "month") {
    const year = Number(anchor.slice(0, 4));
    const monthIndex = Number(anchor.slice(5, 7)) - 1;
    return timeSummaryForEmployee(employeeNumber, monthStart(year, monthIndex), monthEnd(year, monthIndex), period);
  }
  const from = getMonday(anchor);
  return timeSummaryForEmployee(employeeNumber, from, addDays(from, 6), period);
}

function validateProposedTimeEntries(correctionDate, entriesValue, now = new Date()) {
  const entries = Array.isArray(entriesValue) ? entriesValue.map((entry) => ({
    type: String(entry?.type || entry?.entryType || entry?.entry_type || "").trim(),
    time: String(entry?.time || "").trim().slice(0, 5),
  })) : [];
  const expectedTypes = entries.length === 2
    ? ["clock_in", "clock_out"]
    : entries.length === 4
      ? ["clock_in", "break_start", "break_end", "clock_out"]
      : null;
  if (!isIsoDate(correctionDate) || correctionDate > viennaTodayIso(now) || !expectedTypes) {
    throw httpError(400, "Bitte zwei Buchungen oder eine vollständige Buchungsfolge mit Pause angeben.", "TIME_CORRECTION_INVALID");
  }
  const timestamps = entries.map((entry, index) => {
    if (entry.type !== expectedTypes[index] || !isTime(entry.time)) {
      throw httpError(400, "Die Buchungsfolge muss mit Kommen beginnen, optional eine vollständige Pause enthalten und mit Gehen enden.", "TIME_CORRECTION_INVALID");
    }
    return viennaLocalDateTime(correctionDate, entry.time);
  });
  if (timestamps.some((timestamp, index) => index > 0 && timestamp <= timestamps[index - 1])) {
    throw httpError(400, "Die Uhrzeiten müssen in einer eindeutigen zeitlichen Reihenfolge liegen.", "TIME_CORRECTION_INVALID");
  }
  if (correctionDate === viennaTodayIso(now) && timestamps.at(-1) > now) {
    throw httpError(400, "Eine Zeitkorrektur darf nicht in der Zukunft enden.", "TIME_CORRECTION_INVALID");
  }
  return entries;
}

function validateOwnTimeCorrection(employeeNumber, body = {}, existingId = null) {
  const correctionDate = String(body.correctionDate || body.date || "").trim();
  const requestedEntries = body.requestedEntries || body.proposedEntries || body.entries;
  const entries = validateProposedTimeEntries(correctionDate, requestedEntries);
  const requestNote = stripEmoji(String(body.reason ?? body.note ?? "").trim()).slice(0, 500);
  const context = employeeRequestContext(employeeNumber, correctionDate);
  const duplicate = db.prepare(`
    SELECT id FROM time_corrections
    WHERE employee_number = ? AND correction_date = ? AND status = 'pending' AND id <> ?
    LIMIT 1
  `).get(employeeNumber, correctionDate, Number(existingId || 0));
  if (duplicate) throw httpError(409, "Für diesen Tag besteht bereits ein offener Korrekturantrag.", "TIME_CORRECTION_PENDING_EXISTS");
  const originals = timeEntriesForDay(employeeNumber, correctionDate);
  return {
    correctionDate,
    entries,
    requestNote,
    context,
    requestedChange: {
      proposedEntries: entries,
      entries,
      note: requestNote,
      originalEntryIds: originals.map((entry) => Number(entry.id)),
      originalEntries: originals.map((entry) => ({ id: Number(entry.id), type: entry.entry_type, timestamp: entry.entry_timestamp })),
    },
  };
}

function notifyTimeCorrectionReviewers(correction, actor = "") {
  for (const recipient of requestReviewerRecipients(correction.locationId, correction.departmentId, "local", actor)) {
    createPortalNotification(recipient, "time_correction.review", "Zeitkorrektur wartet auf Prüfung", `${correction.employeeNumber} hat eine Zeitkorrektur beantragt.`, {
      target: "/portal/?tab=approvals",
      entityType: "time_correction",
      entityId: correction.id,
      dedupeKey: `time_correction:${correction.id}:review`,
    });
  }
}

function createOwnTimeCorrection(session, body) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const input = validateOwnTimeCorrection(session.employeeNumber, body);
    const result = db.prepare(`
      INSERT INTO time_corrections
        (employee_number, location_id, department_id, correction_date, requested_change, request_note, status, requested_by)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(session.employeeNumber, input.context.locationId, input.context.departmentId, input.correctionDate,
      JSON.stringify(input.requestedChange), input.requestNote, session.employeeNumber);
    auditPortal(session.employeeNumber, "time.correction.request", "time_correction", String(result.lastInsertRowid), JSON.stringify(input.requestedChange));
    db.exec("COMMIT");
    const correction = timeCorrectionRows("WHERE c.id = ?", [Number(result.lastInsertRowid)])[0];
    notifyTimeCorrectionReviewers(correction, session.employeeNumber);
    return correction;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function updateOwnTimeCorrection(session, idValue, body) {
  const id = Number(idValue);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id, employee_number, status FROM time_corrections WHERE id = ?").get(id);
    if (!existing || existing.employee_number !== session.employeeNumber) throw httpError(404, "Der Korrekturantrag wurde nicht gefunden.");
    if (existing.status !== "pending") throw httpError(409, "Nur ein offener Korrekturantrag kann bearbeitet werden.", "TIME_CORRECTION_STATE_CONFLICT");
    const input = validateOwnTimeCorrection(session.employeeNumber, body, id);
    db.prepare(`
      UPDATE time_corrections
      SET location_id = ?, department_id = ?, correction_date = ?, requested_change = ?, request_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(input.context.locationId, input.context.departmentId, input.correctionDate, JSON.stringify(input.requestedChange), input.requestNote, id);
    auditPortal(session.employeeNumber, "time.correction.update", "time_correction", String(id), JSON.stringify(input.requestedChange));
    db.exec("COMMIT");
    return timeCorrectionRows("WHERE c.id = ?", [id])[0];
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function withdrawOwnTimeCorrection(session, idValue) {
  const id = Number(idValue);
  const result = db.prepare(`
    UPDATE time_corrections SET status = 'withdrawn', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND employee_number = ? AND status = 'pending'
  `).run(id, session.employeeNumber);
  if (!result.changes) throw httpError(409, "Der Korrekturantrag wurde bereits bearbeitet oder nicht gefunden.", "TIME_CORRECTION_STATE_CONFLICT");
  auditPortal(session.employeeNumber, "time.correction.withdraw", "time_correction", String(id));
}

function decideTimeCorrection(session, idValue, body = {}, now = new Date()) {
  const id = Number(idValue);
  const action = String(body.action || body.decision || "").toLowerCase();
  if (!Number.isInteger(id) || !["approve", "approved", "reject", "rejected"].includes(action)) {
    throw httpError(400, "Bitte eine gültige Entscheidung auswählen.", "TIME_CORRECTION_DECISION_INVALID");
  }
  const approved = action === "approve" || action === "approved";
  const decisionNote = stripEmoji(String(body.decisionNote ?? body.note ?? "").trim()).slice(0, 500);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM time_corrections WHERE id = ?").get(id);
    if (!row) throw httpError(404, "Der Korrekturantrag wurde nicht gefunden.");
    if (row.status !== "pending") throw httpError(409, "Der Korrekturantrag wurde bereits entschieden.", "TIME_CORRECTION_STATE_CONFLICT");
    const fallbackContext = employeeRequestContext(row.employee_number, row.correction_date);
    const correctionContext = {
      locationId: row.location_id || fallbackContext.locationId,
      departmentId: Number(row.department_id || 0) || fallbackContext.departmentId,
    };
    assertSessionContextScope(session, correctionContext);
    if (!row.location_id || (!row.department_id && correctionContext.departmentId)) {
      db.prepare("UPDATE time_corrections SET location_id = ?, department_id = ? WHERE id = ?")
        .run(correctionContext.locationId, correctionContext.departmentId, id);
    }
    const requestedChange = parseTimeCorrectionChange(row.requested_change);
    let decidedEntries = requestedChange.proposedEntries || requestedChange.entries || [];
    if (approved) {
      decidedEntries = validateProposedTimeEntries(row.correction_date, body.entries || body.proposedEntries || decidedEntries, now);
      const activeRows = timeEntriesForDay(row.employee_number, row.correction_date);
      const originalIds = (requestedChange.originalEntryIds || []).map(Number).sort((left, right) => left - right);
      const activeIds = activeRows.map((entry) => Number(entry.id)).sort((left, right) => left - right);
      if (JSON.stringify(originalIds) !== JSON.stringify(activeIds)) {
        throw httpError(409, "Die Originalbuchungen wurden seit dem Antrag verändert. Bitte einen neuen Korrekturantrag stellen.", "TIME_CORRECTION_SOURCE_CHANGED");
      }
      db.prepare(`
        UPDATE time_entries
        SET voided_at = CURRENT_TIMESTAMP, voided_by = ?, void_reason = ?, correction_id = ?
        WHERE employee_number = ? AND work_date = ? AND voided_at IS NULL
      `).run(session.employeeNumber, `Ersetzt durch genehmigte Zeitkorrektur ${id}`, id, row.employee_number, row.correction_date);
      const insert = db.prepare(`
        INSERT INTO time_entries
          (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, note, created_by, correction_id)
        VALUES (?, ?, ?, ?, ?, ?, 'manager_correction', ?, ?, ?)
      `);
      for (const entry of decidedEntries) {
        insert.run(row.employee_number, correctionContext.locationId, correctionContext.departmentId, row.correction_date, entry.type,
          viennaLocalDateTime(row.correction_date, entry.time).toISOString(), decisionNote, session.employeeNumber, id);
      }
    }
    const status = approved ? "approved" : "rejected";
    const result = db.prepare(`
      UPDATE time_corrections
      SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(status, session.employeeNumber, decisionNote, id);
    if (!result.changes) throw httpError(409, "Der Korrekturantrag wurde bereits entschieden.", "TIME_CORRECTION_STATE_CONFLICT");
    auditPortal(session.employeeNumber, `time.correction.${status}`, "time_correction", String(id), JSON.stringify({ decisionNote, entries: decidedEntries }));
    db.exec("COMMIT");
    db.prepare("UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE entity_type = 'time_correction' AND entity_id = ?").run(String(id));
    createPortalNotification(row.employee_number, "time_correction.decision", `Zeitkorrektur ${approved ? "genehmigt" : "abgelehnt"}`, `Bearbeitet von Personalnummer ${session.employeeNumber}.`, {
      target: "/portal/?tab=time", entityType: "time_correction", entityId: id,
      dedupeKey: `time_correction:${id}:${status}:${session.employeeNumber}`,
    });
    return timeCorrectionRows("WHERE c.id = ?", [id])[0];
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

const mobileLeadershipModules = Object.freeze([
  { id: "timeTracking", label: "Zeiterfassung" },
  { id: "team", label: "Team heute" },
  { id: "approvals", label: "Freigaben" },
  { id: "schedule", label: "Mein Dienstplan" },
  { id: "requests", label: "Meine Anträge" },
  { id: "more", label: "Mehr" },
]);
const mobileLeadershipModuleIds = new Set(mobileLeadershipModules.map((module) => module.id));

function mobileLeadershipLayouts() {
  const fallback = JSON.parse(defaultPortalSettings.mobile_leadership_layouts);
  try {
    const value = JSON.parse(getPortalSettings().mobile_leadership_layouts || "{}");
    for (const role of ["department_manager", "manager", "hr", "admin"]) {
      const requested = Array.isArray(value[role]) ? value[role].filter((id) => mobileLeadershipModuleIds.has(id)) : [];
      const modules = ["timeTracking", ...requested.filter((id) => id !== "timeTracking")];
      fallback[role] = [...new Set(modules)].slice(0, 6);
    }
  } catch {}
  return fallback;
}

function mobileModuleAllowedForSession(session, id) {
  const permissions = session.permissions || [];
  if (id === "timeTracking") return permissions.includes("own_time:read");
  if (id === "team") return permissions.includes("time:read");
  if (id === "approvals") return permissions.some((permission) => ["vacation:read", "vacation:approve", "time:review", "amu:metadata:read", "amu:review"].includes(permission));
  if (id === "schedule") return permissions.includes("own_schedule:read");
  if (id === "requests") return permissions.some((permission) => ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:correction_request"].includes(permission));
  return id === "more";
}

function mobileLayoutPayload(session) {
  const layouts = mobileLeadershipLayouts();
  const roleLayout = layouts[session.role] || layouts.manager;
  const modules = roleLayout.filter((id) => mobileModuleAllowedForSession(session, id));
  return {
    modules,
    availableModules: mobileLeadershipModules,
    layouts,
    canChange: session.employeeNumber === "local" || ["admin", "hr"].includes(session.role),
  };
}

function validateMobileLeadershipLayouts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "Bitte eine gültige Auswahl für die mobile Leitungsansicht übermitteln.", "MOBILE_LAYOUT_INVALID");
  }
  const result = mobileLeadershipLayouts();
  for (const role of ["department_manager", "manager", "hr", "admin"]) {
    const requested = Array.isArray(value[role]) ? value[role].map(String) : result[role];
    if (requested.some((id) => !mobileLeadershipModuleIds.has(id))) {
      throw httpError(400, "Die mobile Leitungsansicht enthält ein unbekanntes Element.", "MOBILE_LAYOUT_INVALID");
    }
    result[role] = [...new Set(["timeTracking", ...requested.filter((id) => id !== "timeTracking")])].slice(0, 6);
  }
  return result;
}

function leadershipOverviewForContext(session, context, now = new Date()) {
  const presence = timePresenceForContext(session, context, viennaTodayIso(now), now);
  const stateCounts = presence.employees.reduce((counts, employee) => {
    counts[employee.state] = (counts[employee.state] || 0) + 1;
    return counts;
  }, {});
  const corrections = timeCorrectionRows(`
    WHERE c.status = 'pending' AND c.location_id = ?
      AND (? IS NULL OR c.department_id = ?)
  `, [context.locationId, context.departmentId, context.departmentId])
    .filter((correction) => {
      try {
        assertSessionContextScope(session, correction);
        return true;
      } catch {
        return false;
      }
    });
  const pendingAbsenceRows = db.prepare(`
    SELECT employee_number, date_from AS request_date
    FROM vacation_requests
    WHERE location_id = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')
    UNION ALL
    SELECT employee_number, COALESCE(date_from, request_date) AS request_date
    FROM time_off_requests
    WHERE location_id = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')
  `).all(context.locationId, context.locationId);
  const absenceCount = pendingAbsenceRows.filter((entry) => !context.departmentId
    || Number(employeeRequestContext(entry.employee_number, entry.request_date).departmentId || 0) === Number(context.departmentId)).length;
  const amuCount = db.prepare(`
    SELECT COUNT(*) AS count FROM amu_reports
    WHERE location_id = ? AND status IN ('submitted','returned')
      AND (? IS NULL OR department_id = ?)
  `).get(context.locationId, context.departmentId, context.departmentId)?.count || 0;
  return {
    date: presence.date,
    context,
    presence,
    counts: {
      working: Number(stateCounts.working || 0),
      paused: Number(stateCounts.paused || 0),
      attention: Number(stateCounts.attention || 0),
      off: Number(stateCounts.off || 0),
      absenceRequests: Number(absenceCount),
      amuReports: Number(amuCount),
      timeCorrections: corrections.length,
    },
    timeCorrections: corrections,
  };
}

function serializeRequestBlackout(row) {
  return {
    id: Number(row.id),
    locationId: row.location_id,
    locationName: row.location_name || "",
    departmentId: row.department_id ? Number(row.department_id) : null,
    departmentName: row.department_name || "",
    dateFrom: row.date_from,
    dateTo: row.date_to,
    blockVacation: Boolean(row.block_vacation),
    blockTimeOff: Boolean(row.block_time_off),
    reason: row.reason || "",
    active: Boolean(row.active),
    createdBy: row.created_by || "",
  };
}

function getRequestBlackouts(activeOnly = false) {
  return db.prepare(`
    SELECT b.*, l.name AS location_name, d.name AS department_name
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    ${activeOnly ? "WHERE b.active = 1" : ""}
    ORDER BY b.active DESC, b.date_from, b.location_id, b.department_id
  `).all().map(serializeRequestBlackout);
}

function getRequestBlackoutsForSession(session, activeOnly = false) {
  const blackouts = getRequestBlackouts(activeOnly);
  if (sessionHasGlobalScope(session)) return blackouts;
  return blackouts.filter((blackout) => (session.scopes || []).some((scope) => scope.locationId === blackout.locationId
    && (session.role !== "department_manager" || Number(scope.departmentId) === Number(blackout.departmentId || 0))));
}

function validateRequestBlackout(body, existingId = 0) {
  const locationId = normalizeLocationId(body.locationId || body.location_id || "");
  const departmentId = normalizeDepartmentId(body.departmentId ?? body.department_id, true);
  const dateFrom = String(body.dateFrom || body.date_from || "");
  const dateTo = String(body.dateTo || body.date_to || "");
  const blockVacation = body.blockVacation !== false;
  const blockTimeOff = body.blockTimeOff === true;
  const reason = stripEmoji(String(body.reason || "").trim()).slice(0, 240);
  const active = body.active !== false;
  validateLocationExists(locationId);
  if (departmentId) validateDepartmentExists(departmentId, locationId);
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Sperrzeitraum eingeben.");
  }
  if (!blockVacation && !blockTimeOff) throw httpError(400, "Bitte Urlaub, Zeitausgleich oder beides sperren.");
  const duplicate = db.prepare(`
    SELECT id FROM request_blackouts
    WHERE id <> ? AND location_id = ? AND COALESCE(department_id, 0) = COALESCE(?, 0)
      AND date_from = ? AND date_to = ? AND block_vacation = ? AND block_time_off = ?
  `).get(Number(existingId || 0), locationId, departmentId, dateFrom, dateTo, blockVacation ? 1 : 0, blockTimeOff ? 1 : 0);
  if (duplicate) throw httpError(409, "Diese Antragssperre besteht bereits.");
  return { locationId, departmentId, dateFrom, dateTo, blockVacation, blockTimeOff, reason, active };
}

function findRequestBlackout(employeeNumber, requestType, dateFrom, dateTo, dateForDepartment = null) {
  const context = employeeRequestContext(employeeNumber, dateForDepartment || dateFrom);
  const typeColumn = requestType === "time_off" ? "block_time_off" : "block_vacation";
  const rows = db.prepare(`
    SELECT b.*, l.name AS location_name, d.name AS department_name
    FROM request_blackouts b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN departments d ON d.id = b.department_id
    WHERE b.active = 1 AND b.location_id = ? AND b.${typeColumn} = 1
      AND b.date_from <= ? AND b.date_to >= ?
      AND (b.department_id IS NULL OR b.department_id = ?)
    ORDER BY CASE WHEN b.department_id IS NULL THEN 1 ELSE 0 END, b.date_from
  `).all(context.locationId, dateTo, dateFrom, context.departmentId);
  return rows[0] ? serializeRequestBlackout(rows[0]) : null;
}

function requestBlackoutReason(blackout, requestLabel) {
  const scope = blackout.departmentName ? `Abteilung ${blackout.departmentName}` : `Filiale ${blackout.locationName}`;
  const reason = blackout.reason ? `: ${blackout.reason}` : ".";
  return `${requestLabel} ist von ${blackout.dateFrom} bis ${blackout.dateTo} für ${scope} gesperrt${reason}`;
}

function evaluateVacationRequest(employeeNumber, body) {
  const dateFrom = String(body.dateFrom || "");
  const dateTo = String(body.dateTo || "");
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    return { trafficLight: "red", allowed: false, reason: "Bitte einen gültigen Urlaubszeitraum eingeben." };
  }
  const blackout = findRequestBlackout(employeeNumber, "vacation", dateFrom, dateTo);
  if (blackout) return { trafficLight: "red", allowed: false, reason: requestBlackoutReason(blackout, "Urlaub") };
  return { trafficLight: "green", allowed: true, reason: "Für diesen Zeitraum besteht keine Antragssperre." };
}

function staffingCountAt(locationId, departmentId, date, pointTime, excludedEmployeeNumber) {
  const departmentClause = departmentId ? "AND s.department_id = ?" : "";
  const values = departmentId
    ? [date, locationId, pointTime, pointTime, excludedEmployeeNumber, departmentId]
    : [date, locationId, pointTime, pointTime, excludedEmployeeNumber];
  return Number(db.prepare(`
    SELECT COUNT(DISTINCT s.employee_number) AS count
    FROM shifts s JOIN employees e ON e.personnel_number = s.employee_number
    WHERE s.shift_date = ? AND e.home_location_id = ?
      AND s.start_time <= ? AND s.end_time > ? AND s.employee_number <> ?
      ${departmentClause}
  `).get(...values).count || 0);
}

function evaluateTimeOffRequest(employeeNumber, body) {
  const date = String(body.date || body.requestDate || body.dateFrom || "");
  const dateTo = String(body.dateTo || date);
  const allDay = body.allDay === true || dateTo !== date;
  const startTime = String(body.startTime || "");
  const endTime = String(body.endTime || "");
  if (!isIsoDate(date) || !isIsoDate(dateTo) || dateTo < date) {
    return { trafficLight: "red", allowed: false, reason: "Bitte einen gültigen ZA-Zeitraum eingeben." };
  }
  if (date < viennaTodayIso()) return { trafficLight: "red", allowed: false, reason: "Für vergangene Tage kann kein Zeitausgleich beantragt werden." };
  if (allDay) {
    const blackout = findRequestBlackout(employeeNumber, "time_off", date, dateTo, date);
    if (blackout) return { trafficLight: "red", allowed: false, reason: requestBlackoutReason(blackout, "Zeitausgleich") };
    const overlap = db.prepare(`SELECT id FROM time_off_requests WHERE employee_number = ?
      AND status IN ('pending','pending_local','preliminary_local','pending_hr','approved') AND id <> ?
      AND COALESCE(date_from, request_date) <= ? AND COALESCE(date_to, request_date) >= ? LIMIT 1`)
      .get(employeeNumber, Number(body.excludeRequestId || 0), dateTo, date);
    if (overlap) return { trafficLight: "red", allowed: false, reason: "Für diesen Zeitraum besteht bereits ein ZA-Antrag." };
    const missingDays = [];
    for (let current = date; current <= dateTo; current = addDays(current, 1)) {
      const context = employeeRequestContext(employeeNumber, current);
      if (!operatingHours(current, settingsForLocation(context.locationId))) {
        return { trafficLight: "red", allowed: false, reason: `Am ${current} ist die Filiale geschlossen; dafür kann kein ganztägiger ZA beantragt werden.` };
      }
      const globalBlock = getGlobalDayBlockForDate(current, context.locationId);
      if (globalBlock) return { trafficLight: "red", allowed: false, reason: `Der ${current} ist bereits gesperrt: ${globalBlock.reason || globalBlock.holiday_name || "gesperrt"}.` };
      const planned = db.prepare("SELECT 1 FROM shifts WHERE employee_number = ? AND shift_date = ? LIMIT 1").get(employeeNumber, current);
      if (!planned) missingDays.push(current);
    }
    return { trafficLight: "yellow", allowed: true, reason: missingDays.length
      ? "Der ganztägige ZA kann beantragt werden; der Dienstplan ist für mindestens einen Tag noch unvollständig und wird manuell geprüft."
      : "Der ganztägige ZA wird unabhängig von der Vorprüfung immer zur Genehmigung eingereicht." };
  }
  if (!isIsoDate(date) || !isTime(startTime) || !isTime(endTime) || endTime <= startTime) {
    return { trafficLight: "red", allowed: false, reason: "Bitte Datum und Uhrzeit für den Zeitausgleich vollständig eingeben." };
  }
  if (timeToMinutes(endTime) - timeToMinutes(startTime) < 15) {
    return { trafficLight: "red", allowed: false, reason: "Zeitausgleich muss mindestens 15 Minuten dauern." };
  }
  const context = employeeRequestContext(employeeNumber, date);
  const blackout = findRequestBlackout(employeeNumber, "time_off", date, date, date);
  if (blackout) return { trafficLight: "red", allowed: false, reason: requestBlackoutReason(blackout, "Zeitausgleich") };
  const settings = settingsForLocation(context.locationId);
  const hours = operatingHours(date, settings);
  if (!hours) return { trafficLight: "red", allowed: false, reason: "An diesem Tag ist die Filiale geschlossen." };
  if (startTime < hours.start || endTime > hours.end) {
    return { trafficLight: "red", allowed: false, reason: `Der Zeitraum liegt außerhalb der Öffnungszeit ${hours.start}–${hours.end} Uhr.` };
  }
  const globalBlock = getGlobalDayBlockForDate(date, context.locationId);
  if (globalBlock) {
    return { trafficLight: "red", allowed: false, reason: `Dieser Tag ist gesperrt: ${globalBlock.reason || globalBlock.holiday_name || "gesperrt"}.` };
  }
  const conflictingOption = db.prepare(`
    SELECT option_type, note, all_day, start_time, end_time, group_id FROM week_options
    WHERE employee_number = ? AND ? BETWEEN date_from AND date_to
  `).all(employeeNumber, date).find((option) => option.group_id !== `za-request-${Number(body.excludeRequestId || 0)}`
    && optionOverlapsTime(option, startTime, endTime));
  if (conflictingOption) {
    return { trafficLight: "red", allowed: false, reason: `Zu dieser Zeit ist bereits „${optionLabel(conflictingOption.option_type)}“ eingetragen.` };
  }
  const pendingOverlap = db.prepare(`
    SELECT id FROM time_off_requests
    WHERE employee_number = ? AND ? BETWEEN COALESCE(date_from, request_date) AND COALESCE(date_to, request_date)
      AND status IN ('pending','pending_local','preliminary_local','pending_hr','approved') AND id <> ?
      AND (all_day = 1 OR (start_time < ? AND ? < end_time)) LIMIT 1
  `).get(employeeNumber, date, Number(body.excludeRequestId || 0), endTime, startTime);
  if (pendingOverlap) return { trafficLight: "red", allowed: false, reason: "Für diesen Zeitraum besteht bereits ein offener ZA-Antrag." };
  const coveringShift = db.prepare(`
    SELECT * FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND start_time <= ? AND end_time >= ?
    ORDER BY start_time LIMIT 1
  `).get(employeeNumber, date, startTime, endTime);
  const overlappingShift = db.prepare(`
    SELECT * FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND start_time < ? AND ? < end_time
    ORDER BY start_time LIMIT 1
  `).get(employeeNumber, date, endTime, startTime);
  if (!coveringShift && overlappingShift) {
    return { trafficLight: "red", allowed: false, reason: `Der gewünschte Zeitraum liegt nicht vollständig innerhalb des Dienstes ${overlappingShift.start_time}–${overlappingShift.end_time} Uhr.` };
  }
  if (!coveringShift) {
    return { trafficLight: "yellow", allowed: true, reason: "Für diesen Zeitraum ist noch kein Dienst eingetragen. Der Antrag wird manuell geprüft." };
  }
  const locationContext = resolvePlanningContext({ locationId: context.locationId, departmentId: null });
  const locationRequired = Number(dayConfiguration(date, settings, locationContext)?.minStaff || 0);
  const departmentId = coveringShift.department_id ? Number(coveringShift.department_id) : context.departmentId;
  const departmentRequired = departmentId
    ? Number(db.prepare("SELECT min_staff FROM departments WHERE id = ?").get(departmentId)?.min_staff || 0)
    : 0;
  for (let minute = timeToMinutes(startTime); minute < timeToMinutes(endTime); minute += 15) {
    const point = minutesToTime(minute);
    const locationCount = staffingCountAt(context.locationId, null, date, point, employeeNumber);
    if (locationCount < locationRequired) {
      return { trafficLight: "red", allowed: false, reason: `Um ${point} Uhr würde die Filial-Mindestbesetzung auf ${locationCount} von ${locationRequired} Personen sinken.` };
    }
    if (departmentId && departmentRequired > 0) {
      const departmentCount = staffingCountAt(context.locationId, departmentId, date, point, employeeNumber);
      if (departmentCount < departmentRequired) {
        const departmentName = db.prepare("SELECT name FROM departments WHERE id = ?").get(departmentId)?.name || "Abteilung";
        return { trafficLight: "red", allowed: false, reason: `Um ${point} Uhr würde die Mindestbesetzung in ${departmentName} auf ${departmentCount} von ${departmentRequired} Personen sinken.` };
      }
    }
  }
  return { trafficLight: "green", allowed: true, reason: "Der Zeitausgleich ist nach dem aktuellen Dienstplan möglich und kann zur Genehmigung eingereicht werden." };
}

function approvedVacationsForEmployee(employeeNumber, fromDate = `${new Date().getUTCFullYear()}-01-01`) {
  const rows = db.prepare(`
    SELECT id, group_id, date_from, date_to, note FROM week_options
    WHERE employee_number = ? AND option_type = 'vacation' AND date_to >= ?
    ORDER BY date_from, id
  `).all(employeeNumber, fromDate);
  const grouped = new Map();
  for (const row of rows) {
    const groupId = vacationGroupKey(row);
    const item = grouped.get(groupId) || { groupId, dateFrom: row.date_from, dateTo: row.date_to, note: row.note || "" };
    item.dateFrom = item.dateFrom < row.date_from ? item.dateFrom : row.date_from;
    item.dateTo = item.dateTo > row.date_to ? item.dateTo : row.date_to;
    item.note ||= row.note || "";
    grouped.set(groupId, item);
  }
  return [...grouped.values()];
}

function insertApprovedTimeOff(entry) {
  const dateFrom = entry.date_from || entry.request_date;
  const dateTo = entry.date_to || entry.request_date;
  const allDay = Boolean(entry.all_day) || dateTo !== dateFrom;
  const shifts = allDay
    ? db.prepare("SELECT * FROM shifts WHERE employee_number = ? AND shift_date BETWEEN ? AND ? ORDER BY shift_date, start_time").all(entry.employee_number, dateFrom, dateTo)
    : db.prepare(`SELECT * FROM shifts WHERE employee_number = ? AND shift_date = ? AND start_time < ? AND ? < end_time ORDER BY start_time`)
      .all(entry.employee_number, entry.request_date, entry.end_time, entry.start_time);
  db.prepare("UPDATE time_off_requests SET original_shifts_json = ? WHERE id = ?")
    .run(JSON.stringify(shifts), entry.id);
  const insertShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const shift of shifts) {
    db.prepare("DELETE FROM shifts WHERE id = ?").run(shift.id);
    if (!allDay && shift.start_time < entry.start_time) {
      insertShift.run(shift.employee_number, shift.department_id, shift.shift_date, shift.start_time, entry.start_time, shift.area, shift.note);
    }
    if (!allDay && shift.end_time > entry.end_time) {
      insertShift.run(shift.employee_number, shift.department_id, shift.shift_date, entry.end_time, shift.end_time, shift.area, shift.note);
    }
  }
  const groupId = `za-request-${entry.id}`;
  const insert = db.prepare(`INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type, note, credited_minutes_per_day, all_day, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, 'time_off', ?, NULL, ?, ?, ?)`);
  let firstId = null;
  for (let segmentStart = dateFrom; segmentStart <= dateTo;) {
    const weekStart = getMonday(segmentStart);
    const segmentEnd = [dateTo, addDays(weekStart, 6)].sort()[0];
    const result = insert.run(entry.employee_number, groupId, weekStart, segmentStart, segmentEnd, entry.note || "", allDay ? 1 : 0,
      allDay ? null : entry.start_time, allDay ? null : entry.end_time);
    firstId ||= Number(result.lastInsertRowid);
    segmentStart = addDays(segmentEnd, 1);
  }
  return firstId;
}

function restoreApprovedTimeOff(entry) {
  let originals = [];
  try { originals = JSON.parse(entry.original_shifts_json || "[]"); } catch {}
  db.prepare("DELETE FROM week_options WHERE group_id = ? OR id = ?").run(`za-request-${entry.id}`, entry.option_id || 0);
  for (const original of originals) {
    db.prepare(`
      DELETE FROM shifts WHERE employee_number = ? AND shift_date = ?
        AND COALESCE(department_id, 0) = COALESCE(?, 0)
        AND start_time >= ? AND end_time <= ?
    `).run(original.employee_number, original.shift_date, original.department_id, original.start_time, original.end_time);
    db.prepare(`
      INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(original.employee_number, original.department_id, original.shift_date, original.start_time, original.end_time, original.area || "", original.note || "");
  }
}

function recordRequestDecision(kind, id, stage, action, actor, note = "") {
  db.prepare(`
    INSERT INTO request_decisions (request_kind, request_id, stage, action, actor_employee_number, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kind, Number(id), stage, action, actor, stripEmoji(String(note || "").trim()).slice(0, 500));
}

function requestDecisionHistory(kind, id) {
  return db.prepare(`
    SELECT id, stage, action, actor_employee_number, note, created_at
    FROM request_decisions WHERE request_kind = ? AND request_id = ? ORDER BY id
  `).all(kind, Number(id));
}

function absenceHistoryForEmployee(employeeNumber) {
  const visibleSince = addMonths(viennaTodayIso(), -6);
  const vacations = db.prepare(`
    SELECT id, date_from, date_to, note, status, approval_stage, decision_note,
           local_approved_by, local_approved_at, hr_approved_by, hr_approved_at,
           decided_by, decided_at, created_at, updated_at
    FROM vacation_requests WHERE employee_number = ?
  `).all(employeeNumber).map((item) => ({
    ...item,
    kind: "vacation",
    decisions: requestDecisionHistory("vacation", item.id),
  }));
  const timeOff = db.prepare(`
    SELECT id, request_date, COALESCE(date_from, request_date) AS date_from, COALESCE(date_to, request_date) AS date_to,
           all_day, start_time, end_time, note, status, approval_type, approval_stage,
           traffic_light, check_reason, decision_note, local_approved_by, local_approved_at,
           hr_approved_by, hr_approved_at, decided_by, decided_at, created_at, updated_at
    FROM time_off_requests WHERE employee_number = ?
  `).all(employeeNumber).map((item) => ({
    ...item,
    kind: "time_off",
    decisions: requestDecisionHistory("time_off", item.id),
  }));
  const changes = db.prepare(`
    SELECT id, vacation_group_id, request_type, original_date_from, original_date_to,
           requested_date_from, requested_date_to, note, status, approval_stage, decision_note,
           local_approved_by, local_approved_at, hr_approved_by, hr_approved_at,
           decided_by, decided_at, created_at, updated_at
    FROM vacation_change_requests WHERE employee_number = ?
  `).all(employeeNumber).map((item) => ({
    ...item,
    kind: item.request_type === "cancel" ? "vacation_cancel" : "vacation_change",
    decisions: requestDecisionHistory("vacation_change", item.id),
  }));
  const timeOffChanges = db.prepare(`
    SELECT c.id, c.original_request_id, c.request_type, c.requested_date_from,
           c.requested_date_to, c.requested_all_day, c.requested_start_time,
           c.requested_end_time, c.note, c.status, c.approval_type, c.approval_stage,
           c.decision_note, c.local_approved_by, c.local_approved_at, c.hr_approved_by,
           c.hr_approved_at, c.decided_by, c.decided_at, c.created_at, c.updated_at,
           COALESCE(t.date_from, t.request_date) AS original_date_from,
           COALESCE(t.date_to, t.request_date) AS original_date_to,
           t.all_day AS original_all_day, t.start_time AS original_start_time,
           t.end_time AS original_end_time
    FROM time_off_change_requests c
    JOIN time_off_requests t ON t.id = c.original_request_id
    WHERE c.employee_number = ?
  `).all(employeeNumber).map((item) => ({
    ...item,
    kind: item.request_type === "cancel" ? "time_off_cancel" : "time_off_change",
    decisions: requestDecisionHistory("time_off_change", item.id),
  }));
  return [...vacations, ...timeOff, ...changes, ...timeOffChanges]
    .filter((item) => ["pending", "pending_local", "preliminary_local", "pending_hr"].includes(item.status)
      || String(item.date_to || item.request_date || item.requested_date_to || item.original_date_to || item.created_at).slice(0, 10) >= visibleSince)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || Number(right.id) - Number(left.id));
}

function amuDocumentsForReports(reportIds) {
  const ids = [...new Set(reportIds.map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, report_id, original_filename, detected_mime, byte_size, scan_status, status, created_at
    FROM amu_documents WHERE report_id IN (${placeholders}) AND status = 'active'
    ORDER BY created_at, id
  `).all(...ids);
  const grouped = new Map(ids.map((id) => [id, []]));
  for (const row of rows) grouped.get(Number(row.report_id))?.push({
    id: row.id,
    original_name: amuStorage?.unprotectText(row.original_filename) || "Dokument",
    original_filename: amuStorage?.unprotectText(row.original_filename) || "Dokument",
    detected_mime: row.detected_mime,
    size: Number(row.byte_size),
    byte_size: Number(row.byte_size),
    scan_status: row.scan_status,
    status: row.status,
    created_at: row.created_at,
  });
  return grouped;
}

function serializeAmuReports(rows) {
  const documents = amuDocumentsForReports(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    employee_note: amuStorage?.unprotectText(row.employee_note) || "",
    review_note: amuStorage?.unprotectText(row.review_note) || "",
    documents: documents.get(Number(row.id)) || [],
  }));
}

function ownAmuReports(employeeNumber) {
  return serializeAmuReports(db.prepare(`
    SELECT r.*, l.name AS location_name
    FROM amu_reports r JOIN locations l ON l.id = r.location_id
    WHERE r.employee_number = ? ORDER BY r.submitted_at DESC, r.id DESC
  `).all(employeeNumber));
}

function amuReportMetadata(id) {
  return db.prepare(`
    SELECT r.*, e.full_name, e.nickname, e.color, e.preferred_department_id, l.name AS location_name,
           d.name AS department_name
    FROM amu_reports r JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id
    LEFT JOIN departments d ON d.id = r.department_id WHERE r.id = ?
  `).get(Number(id));
}

function assertAmuReportScope(session, report) {
  if (!report) throw httpError(404, "Die Arbeitsunfähigkeitsmeldung wurde nicht gefunden.", "AMU_REPORT_NOT_FOUND");
  if (session.employeeNumber === "local" || ["admin", "hr"].includes(session.role)) return;
  const assigned = (session.scopes || []).some((scope) => scope.locationId === report.location_id
    && (session.role !== "department_manager" || (report.department_id != null && Number(scope.departmentId) === Number(report.department_id))));
  if (!assigned) {
    auditPortal(session.employeeNumber, "amu.access.denied", "amu_report", String(report.id), "scope");
    throw httpError(403, "Diese Arbeitsunfähigkeitsmeldung gehört nicht zum eigenen Standort.", "PORTAL_PERMISSION_DENIED");
  }
}

function amuDocumentMetadata(reportId, documentId) {
  return db.prepare(`
    SELECT d.*, r.employee_number, r.location_id, r.department_id, r.status AS report_status
    FROM amu_documents d JOIN amu_reports r ON r.id = d.report_id
    WHERE d.report_id = ? AND d.id = ? AND d.status = 'active'
  `).get(Number(reportId), String(documentId));
}

function sendAmuDocument(response, metadata) {
  const originalFilename = requireAmuStorage().unprotectText(metadata.original_filename) || "Dokument";
  const content = requireAmuStorage().readBuffer({
    storageKey: metadata.storage_key,
    byteSize: metadata.byte_size,
    sha256: metadata.sha256,
    detectedMime: metadata.detected_mime,
    originalFilename,
  });
  response.setHeader("Content-Type", metadata.detected_mime);
  response.setHeader("Content-Length", String(content.length));
  response.setHeader("Content-Disposition", contentDispositionHeader(originalFilename));
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(content);
}

function purgeExpiredAmuDocuments(today = viennaTodayIso()) {
  if (!amuStorage || !tableExists("amu_documents") || amuMutationInProgress > 0) return { purged: 0 };
  const rows = db.prepare(`
    SELECT d.id, d.storage_key, d.report_id
    FROM amu_documents d JOIN amu_reports r ON r.id = d.report_id
    WHERE r.retention_until IS NOT NULL AND r.retention_until < ?
      AND r.status IN ('submitted','returned','reviewed','withdrawn','purged') AND d.status IN ('active','deleted')
    ORDER BY d.created_at, d.id
  `).all(today);
  let purged = 0;
  amuMutationInProgress += 1;
  try {
    for (const row of rows) {
      db.prepare("UPDATE amu_documents SET status = 'deleted', deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP) WHERE id = ?").run(row.id);
      try { amuStorage.deleteBlob(row.storage_key); } catch (error) {
        auditPortal("system", "amu.document.purge.error", "amu_document", row.id, error.message);
        continue;
      }
      db.prepare(`
        UPDATE amu_documents SET status = 'purged', original_filename = 'Dokument', purged_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(row.id);
      auditPortal("system", "amu.document.purge", "amu_document", row.id);
      purged += 1;
    }
    db.prepare(`
      UPDATE amu_reports SET status = 'purged', employee_note = '', review_note = '', updated_at = CURRENT_TIMESTAMP
      WHERE retention_until IS NOT NULL AND retention_until < ? AND status IN ('submitted','returned','reviewed','withdrawn')
        AND NOT EXISTS (SELECT 1 FROM amu_documents d WHERE d.report_id = amu_reports.id AND d.status <> 'purged')
    `).run(today);
  } finally {
    amuMutationInProgress = Math.max(0, amuMutationInProgress - 1);
  }
  return { purged };
}

function reconcileOrphanAmuBlobs() {
  if (!amuStorage || !tableExists("amu_documents") || amuMutationInProgress > 0) return { removed: 0 };
  const referenced = new Set(db.prepare("SELECT storage_key FROM amu_documents").all().map((row) => String(row.storage_key || "").toLowerCase()));
  let removed = 0;
  for (const storageKey of amuStorage.listStorageKeys()) {
    if (referenced.has(storageKey)) continue;
    if (amuStorage.deleteBlob(storageKey)) {
      auditPortal("system", "amu.document.orphan.purge", "amu_document", storageKey);
      removed += 1;
    }
  }
  return { removed };
}

function vacationHrApprovalRequired() {
  return getPortalSettings().vacation_hr_approval_required === "1";
}

function actorStage(session, entry) {
  if (entry.approval_stage === "hr" && (session.role === "hr" || session.role === "admin" || session.employeeNumber === "local")) return "hr";
  return "local";
}

function assertRequestScope(session, entry) {
  if (["admin", "hr"].includes(session.role) || session.employeeNumber === "local") return;
  const locationId = entry.location_id || db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(entry.employee_number)?.home_location_id;
  const assignedScopes = session.scopes || [];
  if (!assignedScopes.some((scope) => scope.locationId === locationId)) {
    throw httpError(403, "Dieser Antrag gehört nicht zum eigenen Standort.", "PORTAL_PERMISSION_DENIED");
  }
  if (session.role === "department_manager") {
    const employeeDepartment = employeeRequestContext(entry.employee_number, entry.request_date || entry.date_from).departmentId;
    if (!assignedScopes.some((scope) => scope.locationId === locationId && Number(scope.departmentId) === Number(employeeDepartment))) {
      throw httpError(403, "Dieser Antrag gehört nicht zur eigenen Abteilung.", "PORTAL_PERMISSION_DENIED");
    }
    const today = viennaTodayIso();
    const delegated = db.prepare(`
      SELECT 1 FROM approval_delegations WHERE location_id = ? AND delegate_employee_number = ?
        AND active = 1 AND date_from <= ? AND date_to >= ? LIMIT 1
    `).get(locationId, session.employeeNumber, today, today);
    const managerPresent = db.prepare(`
      SELECT u.employee_number FROM portal_users u JOIN employees e ON e.personnel_number = u.employee_number
      WHERE u.role = 'manager' AND u.active = 1 AND e.home_location_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM week_options w WHERE w.employee_number = u.employee_number
            AND ? BETWEEN w.date_from AND w.date_to AND w.option_type IN ('vacation','sick','time_off','branch')
        ) LIMIT 1
    `).get(locationId, today);
    if (!delegated && managerPresent) throw httpError(403, "Die Abteilungsleitung darf diesen Antrag nur bei Abwesenheit oder hinterlegter Vertretung der Filialleitung bearbeiten.");
  }
}

function publicRequestStatus(value) {
  return ({
    pending: "pending_local",
    pending_local: "pending_local",
    preliminary_local: "preliminary_local",
    pending_hr: "pending_hr",
    approved: "approved",
    rejected: "rejected",
    cancelled: "cancelled",
  })[value] || value;
}

function sendPortalInactive(_request, response) {
  response.status(503).json({
    error: "Der Mitarbeiterzugang ist technisch vorbereitet, aber in dieser Version noch nicht aktiv.",
    code: "PORTAL_INACTIVE",
    status: getPortalStatus(),
  });
}

function brandingFromSettings(settings = getSettings()) {
  const companyName = settings.companyName ?? settings.brandingCompanyName ?? settings.branding_company_name;
  const logoUrl = settings.logoUrl ?? settings.brandingLogoUrl ?? settings.branding_logo_url;
  const iconUrl = settings.iconUrl ?? settings.brandingIconUrl ?? settings.branding_icon_url;
  const logoAlt = settings.logoAlt ?? settings.brandingLogoAlt ?? settings.branding_logo_alt ?? companyName;
  const adminEmail = settings.adminEmail ?? settings.brandingAdminEmail ?? settings.branding_admin_email;
  return {
    appName: defaultBranding.app_name,
    companyName: String(companyName || defaultBranding.company_name).trim(),
    logoUrl: String(logoUrl || defaultBranding.logo_url).trim() || defaultBranding.logo_url,
    iconUrl: String(iconUrl || defaultBranding.icon_url).trim() || defaultBranding.icon_url,
    logoAlt: String(logoAlt || defaultBranding.logo_alt).trim() || defaultBranding.logo_alt,
    adminEmail: String(adminEmail || defaultBranding.admin_email).trim(),
  };
}

function locationBrandingRow(locationId) {
  if (!locationId || !tableExists("location_branding")) return null;
  return db.prepare(`
    SELECT location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by, updated_at
    FROM location_branding WHERE location_id = ?
  `).get(String(locationId));
}

function brandingForLocation(locationId, fallbackSettings = null) {
  const row = locationBrandingRow(locationId);
  if (!row) return brandingFromSettings(fallbackSettings || getSettings());
  return brandingFromSettings({
    companyName: row.company_name,
    logoUrl: row.logo_url,
    iconUrl: row.icon_url,
    logoAlt: row.logo_alt,
    adminEmail: row.admin_email,
  });
}

function saveLocationBrandingSnapshot(locationId, kitId, brandingInput, actor = "") {
  const normalizedLocationId = normalizeLocationId(locationId);
  validateLocationExists(normalizedLocationId);
  const normalizedKitId = validateBrandOptionalText(kitId || "custom", 120) || "custom";
  if (!/^[a-z0-9_-]+$/i.test(normalizedKitId)) throw httpError(400, "Die Branding-Kit-ID ist ungültig.");
  const values = brandingValuesFromBody(brandingInput || {});
  db.prepare(`
    INSERT INTO location_branding
      (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(location_id) DO UPDATE SET
      kit_id = excluded.kit_id,
      company_name = excluded.company_name,
      logo_url = excluded.logo_url,
      icon_url = excluded.icon_url,
      logo_alt = excluded.logo_alt,
      admin_email = excluded.admin_email,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    normalizedLocationId,
    normalizedKitId,
    values.branding_company_name,
    values.branding_logo_url,
    values.branding_icon_url,
    values.branding_logo_alt,
    values.branding_admin_email,
    String(actor || ""),
  );
  return brandingForLocation(normalizedLocationId);
}

function brandingAssignmentForLocation(location) {
  const row = locationBrandingRow(location.id);
  return {
    locationId: location.id,
    locationName: location.name,
    active: Boolean(location.active),
    assigned: Boolean(row),
    kitId: row?.kit_id || "",
    branding: brandingForLocation(location.id),
    updatedBy: row?.updated_by || "",
    updatedAt: row?.updated_at || null,
  };
}

function locationBrandingAssignments() {
  return getLocations(true).map(brandingAssignmentForLocation);
}

function pdfFooterContact(settings = getSettings(), createdAt = new Date()) {
  const branding = brandingFromSettings(settings);
  return `${branding.adminEmail ? `Admin: ${branding.adminEmail} · ` : ""}Erstellt am ${formatPdfTimestamp(createdAt)}`;
}

function settingEnabled(settings, key) {
  return settings[key] === "1";
}

function serializeLocation(row, departments = []) {
  return {
    ...row,
    min_staff: Number(row.min_staff || 0),
    day_settings: daySettingsFromLocation(row.id),
    time_tracking_enabled: Boolean(row.time_tracking_enabled),
    active: Boolean(row.active),
    departments,
  };
}

function serializeDepartment(row) {
  return {
    ...row,
    id: Number(row.id),
    min_staff: Number(row.min_staff || 0),
    active: Boolean(row.active),
    sort_order: Number(row.sort_order || 0),
  };
}

function serializePosition(row) {
  return {
    ...row,
    builtin: Boolean(row.builtin),
    sort_order: Number(row.sort_order || 0),
  };
}

function getPositions() {
  return db.prepare("SELECT id, name, builtin, sort_order, created_at FROM positions ORDER BY builtin DESC, sort_order, name")
    .all()
    .map(serializePosition);
}

function getLocations(includeInactive = true) {
  const locationRows = db
    .prepare(`
      SELECT id, name, min_staff, day_settings_json, time_tracking_enabled, active, created_at
      FROM locations
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY active DESC, id
    `)
    .all();
  const departmentRows = db
    .prepare(`
      SELECT id, location_id, name, min_staff, active, sort_order, created_at
      FROM departments
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY location_id, active DESC, sort_order, name
    `)
    .all()
    .map(serializeDepartment);
  return locationRows.map((location) =>
    serializeLocation(location, departmentRows.filter((department) => department.location_id === location.id)),
  );
}

function getLocationsForSession(session, includeInactive = true) {
  const locations = getLocations(includeInactive);
  if (sessionHasGlobalScope(session)) return locations;
  const allowed = new Map((session.scopes || []).map((scope) => [`${scope.locationId}:${scope.departmentId || 0}`, scope]));
  return locations.filter((location) => [...allowed.keys()].some((key) => key.startsWith(`${location.id}:`))).map((location) => ({
    ...location,
    departments: session.role === "department_manager"
      ? location.departments.filter((department) => allowed.has(`${location.id}:${department.id}`))
      : location.departments,
  }));
}

function normalizeLocationId(value) {
  const id = String(value || "").trim();
  if (!/^\d{2}$/.test(id)) {
    throw httpError(400, "Die Filial-ID muss aus genau 2 Ziffern bestehen.");
  }
  return id;
}

function normalizeDepartmentId(value, allowEmpty = true) {
  if ((value === undefined || value === null || value === "") && allowEmpty) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, "Die Abteilung ist ungültig.");
  }
  return id;
}

function validateLocationExists(locationId) {
  const location = db.prepare("SELECT id, name, min_staff, time_tracking_enabled, active FROM locations WHERE id = ?").get(locationId);
  if (!location) throw httpError(404, "Die Filiale wurde nicht gefunden.");
  return location;
}

function validateDepartmentExists(departmentId, locationId = null) {
  if (!departmentId) return null;
  const department = db.prepare("SELECT id, location_id, name, min_staff, active FROM departments WHERE id = ?").get(departmentId);
  if (!department) throw httpError(404, "Die Abteilung wurde nicht gefunden.");
  if (locationId && department.location_id !== locationId) {
    throw httpError(400, "Die Abteilung gehört nicht zur ausgewählten Filiale.");
  }
  return department;
}

function validateLocationPayload(body, isNew = false) {
  const id = normalizeLocationId(body.id || body.locationId);
  const name = String(body.name || "").trim();
  const minStaff = Number(body.minStaff ?? body.min_staff ?? 0);
  if (!name) throw httpError(400, "Bitte einen Namen für die Filiale eingeben.");
  if (name.length > 80) throw httpError(400, "Der Filialname darf maximal 80 Zeichen lang sein.");
  if (!Number.isInteger(minStaff) || minStaff < 0 || minStaff > 99) {
    throw httpError(400, "Die Mindestbesetzung der Filiale muss zwischen 0 und 99 liegen.");
  }
  if (!isNew) validateLocationExists(id);
  const daySettings = validateDaySettings(body.daySettings || (isNew ? legacyDaySettingsSnapshot() : daySettingsFromLocation(id)));
  return {
    id,
    name,
    minStaff,
    daySettings,
    timeTrackingEnabled: body.timeTrackingEnabled === true || body.time_tracking_enabled === true ? 1 : 0,
    active: body.active === false ? 0 : 1,
  };
}

function validateDaySettings(submittedDays = {}) {
  const result = {};
  for (const [day] of planningDays) {
    const submitted = submittedDays[day] || {};
    const open = submitted.open !== false;
    const start = String(submitted.start || "");
    const end = String(submitted.end || "");
    const lunchEnabled = submitted.lunchEnabled === true;
    const lunchStart = String(submitted.lunchStart || "13:00");
    const lunchEnd = String(submitted.lunchEnd || "14:00");
    const minStaff = Number(submitted.minStaff || 0);
    const minFrom = String(submitted.minFrom || start);
    const minTo = String(submitted.minTo || end);
    if (![start, end, lunchStart, lunchEnd, minFrom, minTo].every(isTime)) throw httpError(400, `Bitte gültige Zeiten für ${day} eingeben.`);
    if (open && end <= start) throw httpError(400, `Das Dienstende für ${day} muss nach dem Beginn liegen.`);
    if (lunchEnabled && (lunchEnd <= lunchStart || lunchStart < start || lunchEnd > end)) throw httpError(400, `Die Mittagspause für ${day} muss innerhalb der Dienstzeit liegen.`);
    if (!Number.isInteger(minStaff) || minStaff < 0 || minStaff > 99) throw httpError(400, `Die Mindestbesetzung für ${day} ist ungültig.`);
    if (open && (minTo <= minFrom || minFrom < start || minTo > end)) throw httpError(400, `Der Zeitraum der Mindestbesetzung für ${day} muss innerhalb der Dienstzeit liegen.`);
    result[day] = { open, start, end, lunchEnabled, lunchStart, lunchEnd, minStaff, minFrom, minTo };
  }
  return result;
}

function validateDepartmentPayload(body, existingId = null) {
  const locationId = normalizeLocationId(body.locationId || body.location_id);
  validateLocationExists(locationId);
  const name = String(body.name || "").trim();
  const minStaff = Number(body.minStaff ?? body.min_staff ?? 0);
  if (!name) throw httpError(400, "Bitte einen Namen für die Abteilung eingeben.");
  if (name.length > 80) throw httpError(400, "Der Abteilungsname darf maximal 80 Zeichen lang sein.");
  if (!Number.isInteger(minStaff) || minStaff < 0 || minStaff > 99) {
    throw httpError(400, "Die Mindestbesetzung der Abteilung muss zwischen 0 und 99 liegen.");
  }
  const active = body.active === false ? 0 : 1;
  const departmentCount = db
    .prepare("SELECT COUNT(*) AS count FROM departments WHERE location_id = ? AND id != ?")
    .get(locationId, Number(existingId || 0)).count;
  if (departmentCount >= 3) {
    throw httpError(400, "Pro Filiale können maximal 3 Abteilungen angelegt werden.");
  }
  return { locationId, name, minStaff, active };
}

function resolvePlanningContext(input = {}) {
  ensureDefaultLocation();
  const activeLocations = db.prepare("SELECT id, name FROM locations WHERE active = 1 ORDER BY id").all();
  const fallbackLocation = activeLocations[0] || db.prepare("SELECT id, name FROM locations ORDER BY id LIMIT 1").get();
  let locationId = String(input.locationId || input.location || "").trim();
  if (!locationId) locationId = fallbackLocation?.id || "01";
  locationId = normalizeLocationId(locationId);
  const location = validateLocationExists(locationId);
  let departmentId = normalizeDepartmentId(input.departmentId ?? input.department, true);
  const department = validateDepartmentExists(departmentId, locationId);
  return {
    locationId,
    locationName: location.name,
    departmentId,
    departmentName: department?.name || "",
  };
}

function staffingFloorForContext(context = {}) {
  if (!context.locationId) return 0;
  const location = db.prepare("SELECT min_staff FROM locations WHERE id = ?").get(context.locationId);
  const locationMinimum = Number(location?.min_staff || 0);
  if (context.departmentId) {
    const department = db.prepare("SELECT min_staff FROM departments WHERE id = ?").get(context.departmentId);
    return Math.max(locationMinimum, Number(department?.min_staff || 0));
  }
  const departmentSum = db.prepare("SELECT COALESCE(SUM(min_staff), 0) AS total FROM departments WHERE location_id = ? AND active = 1")
    .get(context.locationId).total;
  return Math.max(locationMinimum, Number(departmentSum || 0));
}

function pdfDepartmentKey(context = {}) {
  return context.departmentId ? String(context.departmentId) : "";
}

function defaultSchedulePdfSettings(context = {}) {
  const titleParts = [`${context.departmentName ? "Abteilungsplan" : "Dienstplan"} ${context.locationName || "Hauptstandort"}`];
  if (context.departmentName) titleParts.push(context.departmentName);
  const title = titleParts.join(" · ");
  return {
    pdf_title: title,
    pdf_filename_prefix: title,
    pdf_filename_include_kw: "1",
    pdf_filename_include_timestamp: "0",
  };
}

function defaultVacationPdfSettings(context = {}) {
  const title = `Urlaubsplanung ${context.locationName || "Hauptstandort"}`;
  return {
    vacation_pdf_title: title,
    vacation_pdf_filename_prefix: title,
    vacation_pdf_filename_include_period: "1",
    vacation_pdf_filename_include_timestamp: "0",
    vacation_pdf_show_balance: "1",
    vacation_pdf_balance_show_entitlement: "1",
    vacation_pdf_balance_show_planned: "1",
    vacation_pdf_balance_show_consumed: "0",
    vacation_pdf_calendar_style: "bars",
  };
}

function getScopedPdfSettings(scopeType, context) {
  const departmentKey = scopeType === "schedule" ? pdfDepartmentKey(context) : "";
  const rows = db
    .prepare(`
      SELECT key, value
      FROM pdf_settings
      WHERE scope_type = ? AND location_id = ? AND department_key = ?
    `)
    .all(scopeType, context.locationId, departmentKey);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function applyScopedPdfSettings(settings, context, scopeType) {
  const defaults = scopeType === "vacation"
    ? defaultVacationPdfSettings(context)
    : defaultSchedulePdfSettings(context);
  return {
    ...settings,
    ...defaults,
    ...getScopedPdfSettings(scopeType, context),
  };
}

function saveScopedPdfSettings(scopeType, context, values) {
  const departmentKey = scopeType === "schedule" ? pdfDepartmentKey(context) : "";
  const upsert = db.prepare(`
    INSERT INTO pdf_settings (scope_type, location_id, department_key, key, value, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scope_type, location_id, department_key, key)
    DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  for (const [key, value] of Object.entries(values)) {
    upsert.run(scopeType, context.locationId, departmentKey, key, String(value));
  }
}

function validatePdfText(value, fieldName, { min = 1, max = 80 } = {}) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, `Bitte ${fieldName} eingeben.`);
  if (text.length < min || text.length > max) {
    throw httpError(400, `${fieldName} muss zwischen ${min} und ${max} Zeichen lang sein.`);
  }
  return text;
}

function validateBrandText(value, fallback, max = 100) {
  const text = String(value ?? "").replace(/[\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, max) || fallback;
}

function validateBrandOptionalText(value, max = 120) {
  return String(value ?? "").replace(/[\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function validateBrandLogoUrl(value, fallback = defaultBranding.logo_url) {
  const text = validateBrandOptionalText(value, 300) || fallback;
  if (/^javascript:/i.test(text)) throw httpError(400, "Die Logo-Adresse ist ungültig.");
  return text;
}

function validateBrandEmail(value) {
  const text = validateBrandOptionalText(value, 180);
  if (text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw httpError(400, "Bitte eine gültige Admin-E-Mail eingeben oder leer lassen.");
  return text;
}

function brandingValuesFromBody(body = {}) {
  return {
    branding_company_name: validateBrandOptionalText(body.companyName ?? body.brandingCompanyName ?? body.branding_company_name, 100),
    branding_logo_url: validateBrandLogoUrl(body.logoUrl ?? body.brandingLogoUrl ?? body.branding_logo_url),
    branding_icon_url: validateBrandLogoUrl(body.iconUrl ?? body.brandingIconUrl ?? body.branding_icon_url, defaultBranding.icon_url),
    branding_logo_alt: validateBrandText(body.logoAlt ?? body.brandingLogoAlt ?? body.branding_logo_alt, defaultBranding.logo_alt, 120),
    branding_admin_email: validateBrandEmail(body.adminEmail ?? body.brandingAdminEmail ?? body.branding_admin_email),
  };
}

function brandingKitFromSettings(settings = getSettings()) {
  const branding = brandingFromSettings(settings);
  return {
    format: "grabenplaner-branding-kit",
    version: 1,
    exportedAt: new Date().toISOString(),
    branding,
    pdf: {
      scheduleTitle: settings.pdf_title || defaultSettings.pdf_title,
      scheduleFilenamePrefix: settings.pdf_filename_prefix || defaultSettings.pdf_filename_prefix,
      vacationTitle: settings.vacation_pdf_title || defaultSettings.vacation_pdf_title,
      vacationFilenamePrefix: settings.vacation_pdf_filename_prefix || defaultSettings.vacation_pdf_filename_prefix,
    },
  };
}

function runPowerShell(command, args = []) {
  return childProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command, ...args],
    { stdio: "pipe", windowsHide: true },
  );
}

function createZipArchive(sourcePath, zipPath) {
  runPowerShell(
    "& { param($sourcePath, $zipPath) $ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $sourcePath -DestinationPath $zipPath -Force }",
    [sourcePath, zipPath],
  );
}

function extractZipArchive(zipPath, extractPath) {
  runPowerShell(
    "& { param($zipPath, $extractPath) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force }",
    [zipPath, extractPath],
  );
}

function walkFiles(directory) {
  const result = [];
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(entryPath));
    if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

function safeBrandingAssetFilename(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (![".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(extension)) {
    throw httpError(400, "Das Branding-Logo muss eine Bilddatei sein.");
  }
  const base = path.basename(String(fileName || "branding-logo"), extension)
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "branding-logo";
  return `${base}${extension}`;
}

function findKitJsonFile(extractPath) {
  const files = walkFiles(extractPath);
  return files.find((file) => path.basename(file).toLowerCase() === "branding-kit.json")
    || files.find((file) => path.basename(file).toLowerCase() === "grabenplaner-branding-kit.json")
    || files.find((file) => path.extname(file).toLowerCase() === ".json");
}

function findBrandingAssetFile(extractPath, kit) {
  const files = walkFiles(extractPath);
  const candidates = [
    kit.assets?.logo,
    kit.logoAsset,
    kit.branding?.logoAsset,
    kit.branding?.logoFile,
    kit.branding?.logoUrl,
  ].filter(Boolean).map((value) => String(value).replace(/\\/g, "/"));
  for (const candidate of candidates) {
    const baseName = path.basename(candidate);
    if (!baseName || /^https?:/i.test(candidate)) continue;
    const found = files.find((file) => path.basename(file).toLowerCase() === baseName.toLowerCase());
    if (found) return found;
  }
  return files.find((file) => ["assets", "logo"].some((part) => file.toLowerCase().includes(part))
    && [".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(path.extname(file).toLowerCase()));
}

function findBrandingIconFile(extractPath, kit) {
  const files = walkFiles(extractPath);
  const candidates = [
    kit.assets?.icon,
    kit.assets?.favicon,
    kit.assets?.webicon,
    kit.iconAsset,
    kit.branding?.iconAsset,
    kit.branding?.iconFile,
    kit.branding?.iconUrl,
  ].filter(Boolean).map((value) => String(value).replace(/\\/g, "/"));
  for (const candidate of candidates) {
    const baseName = path.basename(candidate);
    if (!baseName || /^https?:/i.test(candidate)) continue;
    const found = files.find((file) => path.basename(file).toLowerCase() === baseName.toLowerCase());
    if (found) return found;
  }
  return files.find((file) => ["webicon", "favicon", "icon"].some((part) => path.basename(file).toLowerCase().includes(part))
    && [".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(path.extname(file).toLowerCase()));
}

function importBrandingAssetFromZip(extractPath, kit, brandingValues) {
  const assetFile = findBrandingAssetFile(extractPath, kit);
  if (!assetFile) return brandingValues;
  const targetDirectory = path.join(__dirname, "public", "assets", "branding");
  fs.mkdirSync(targetDirectory, { recursive: true });
  const safeName = safeBrandingAssetFilename(path.basename(assetFile));
  const targetPath = path.join(targetDirectory, safeName);
  fs.copyFileSync(assetFile, targetPath);
  return {
    ...brandingValues,
    branding_logo_url: `/assets/branding/${safeName}`,
  };
}

function applyBrandingKit(kit, contextInput = {}, actor = "") {
  const brandingSource = kit.branding || kit;
  const pdfSource = kit.pdf || {};
  const brandingValues = brandingValuesFromBody(brandingSource);
  const scheduleContext = resolvePlanningContext(contextInput);
  const vacationContext = resolvePlanningContext({ ...contextInput, departmentId: null, department: null });
  const scheduleTitle = pdfSource.scheduleTitle ? validatePdfText(pdfSource.scheduleTitle, "den Dienstplan-PDF-Titel") : null;
  const schedulePrefix = pdfSource.scheduleFilenamePrefix ? validatePdfText(pdfSource.scheduleFilenamePrefix, "der Dienstplan-PDF-Dateiname", { min: 5, max: 80 }) : null;
  const vacationTitle = pdfSource.vacationTitle ? validatePdfText(pdfSource.vacationTitle, "den Urlaubsplaner-PDF-Titel") : null;
  const vacationPrefix = pdfSource.vacationFilenamePrefix ? validatePdfText(pdfSource.vacationFilenamePrefix, "der Urlaubsplaner-PDF-Dateiname", { min: 5, max: 80 }) : null;
  db.exec("BEGIN");
  try {
    saveLocationBrandingSnapshot(scheduleContext.locationId, kit.id || "custom", brandingValues, actor);
    const scheduleValues = {};
    if (scheduleTitle) {
      scheduleValues.pdf_title = scheduleTitle;
    }
    if (schedulePrefix) {
      scheduleValues.pdf_filename_prefix = schedulePrefix;
    }
    const vacationValues = {};
    if (vacationTitle) {
      vacationValues.vacation_pdf_title = vacationTitle;
    }
    if (vacationPrefix) {
      vacationValues.vacation_pdf_filename_prefix = vacationPrefix;
    }
    if (Object.keys(scheduleValues).length) saveScopedPdfSettings("schedule", scheduleContext, scheduleValues);
    if (Object.keys(vacationValues).length) saveScopedPdfSettings("vacation", vacationContext, vacationValues);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const settings = settingsForLocation(scheduleContext.locationId);
  return { ok: true, settings, branding: brandingFromSettings(settings), locationId: scheduleContext.locationId };
}

function brandingKitForExport(requestQuery) {
  const scheduleContext = resolvePlanningContext(requestQuery);
  const vacationContext = resolvePlanningContext({ ...requestQuery, departmentId: null, department: null });
  const baseSettings = settingsForLocation(scheduleContext.locationId);
  const scheduleSettings = applyScopedPdfSettings(baseSettings, scheduleContext, "schedule");
  const vacationSettings = applyScopedPdfSettings(baseSettings, vacationContext, "vacation");
  return brandingKitFromSettings({
    ...baseSettings,
    pdf_title: scheduleSettings.pdf_title,
    pdf_filename_prefix: scheduleSettings.pdf_filename_prefix,
    vacation_pdf_title: vacationSettings.vacation_pdf_title,
    vacation_pdf_filename_prefix: vacationSettings.vacation_pdf_filename_prefix,
  });
}

function localAssetPathFromUrl(logoUrl) {
  const text = String(logoUrl || "");
  if (text.startsWith("/branding-kits/") && !text.includes("..")) {
    const assetPath = path.join(dataDirectory, ...text.split("/").filter(Boolean).slice(1));
    const normalizedAssetPath = path.resolve(assetPath);
    if (!normalizedAssetPath.startsWith(path.resolve(brandingKitsDirectory))) return null;
    return fs.existsSync(normalizedAssetPath) ? normalizedAssetPath : null;
  }
  if (!text.startsWith("/assets/") || text.includes("..")) return null;
  const assetPath = path.join(__dirname, "public", ...text.split("/").filter(Boolean));
  const normalizedAssetsRoot = path.join(__dirname, "public", "assets");
  const normalizedAssetPath = path.resolve(assetPath);
  if (!normalizedAssetPath.startsWith(path.resolve(normalizedAssetsRoot))) return null;
  return fs.existsSync(normalizedAssetPath) ? normalizedAssetPath : null;
}

function writeBrandingKitZip(kit, zipPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branding-export-"));
  const kitRoot = path.join(tempRoot, "grabenplaner-branding-kit");
  const assetsRoot = path.join(kitRoot, "assets");
  fs.mkdirSync(assetsRoot, { recursive: true });
  const logoPath = localAssetPathFromUrl(kit.branding?.logoUrl);
  if (logoPath) {
    const safeName = safeBrandingAssetFilename(path.basename(logoPath));
    fs.copyFileSync(logoPath, path.join(assetsRoot, safeName));
    kit.assets = { ...(kit.assets || {}), logo: `assets/${safeName}` };
    kit.branding.logoUrl = `/assets/branding/${safeName}`;
  }
  const iconPath = localAssetPathFromUrl(kit.branding?.iconUrl);
  if (iconPath) {
    const safeName = safeBrandingAssetFilename(path.basename(iconPath));
    fs.copyFileSync(iconPath, path.join(assetsRoot, safeName));
    kit.assets = { ...(kit.assets || {}), icon: `assets/${safeName}` };
    kit.branding.iconUrl = `/assets/branding/${safeName}`;
  }
  fs.writeFileSync(path.join(kitRoot, "branding-kit.json"), JSON.stringify(kit, null, 2), "utf8");
  createZipArchive(kitRoot, zipPath);
  return tempRoot;
}

function slugifyKitPart(value, fallback = "branding-kit") {
  return String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 48) || fallback;
}

function brandingKitName(kit = {}) {
  return String(kit.name || kit.branding?.companyName || kit.branding?.company_name || kit.branding?.logoAlt || "Branding-Kit").trim() || "Branding-Kit";
}

function copyKitAssetToLibrary(assetFile, kitDirectory, kitId) {
  if (!assetFile) return "";
  const assetsDirectory = path.join(kitDirectory, "assets");
  fs.mkdirSync(assetsDirectory, { recursive: true });
  const safeName = safeBrandingAssetFilename(path.basename(assetFile));
  fs.copyFileSync(assetFile, path.join(assetsDirectory, safeName));
  return `/branding-kits/${encodeURIComponent(kitId)}/assets/${encodeURIComponent(safeName)}`;
}

function installBrandingKit(kit, { extractPath = "", fileName = "" } = {}) {
  const sourceName = brandingKitName(kit);
  const kitId = `${slugifyKitPart(sourceName)}-${backupTimestamp().replace(/[^0-9A-Za-z-]/g, "").slice(0, 17)}`;
  const kitDirectory = path.join(brandingKitsDirectory, kitId);
  fs.mkdirSync(kitDirectory, { recursive: true });

  const installedKit = {
    ...kit,
    id: kitId,
    name: sourceName,
    installedAt: new Date().toISOString(),
    sourceFile: validateBrandOptionalText(fileName, 180),
    branding: { ...(kit.branding || kit) },
    assets: { ...(kit.assets || {}) },
  };
  installedKit.branding.appName = defaultBranding.app_name;

  if (extractPath) {
    const logoFile = findBrandingAssetFile(extractPath, kit);
    const iconFile = findBrandingIconFile(extractPath, kit);
    const logoUrl = copyKitAssetToLibrary(logoFile, kitDirectory, kitId);
    const iconUrl = copyKitAssetToLibrary(iconFile, kitDirectory, kitId);
    if (logoUrl) {
      installedKit.branding.logoUrl = logoUrl;
      installedKit.assets.logo = logoUrl;
    }
    if (iconUrl) {
      installedKit.branding.iconUrl = iconUrl;
      installedKit.assets.icon = iconUrl;
    }
  }

  fs.writeFileSync(path.join(kitDirectory, "manifest.json"), JSON.stringify(installedKit, null, 2), "utf8");
  return installedKit;
}

function neutralBrandingKit() {
  return {
    id: "neutral",
    name: "Grabenplaner Standard",
    builtin: true,
    branding: {
      appName: defaultBranding.app_name,
      companyName: defaultBranding.company_name,
      logoUrl: defaultBranding.logo_url,
      iconUrl: defaultBranding.icon_url,
      logoAlt: defaultBranding.logo_alt,
      adminEmail: defaultBranding.admin_email,
    },
    pdf: {
      scheduleTitle: defaultSettings.pdf_title,
      scheduleFilenamePrefix: defaultSettings.pdf_filename_prefix,
      vacationTitle: defaultSettings.vacation_pdf_title,
      vacationFilenamePrefix: defaultSettings.vacation_pdf_filename_prefix,
    },
  };
}

function readBrandingKitManifest(kitId) {
  if (kitId === "neutral") return neutralBrandingKit();
  if (!/^[a-z0-9-]+$/i.test(String(kitId || ""))) throw httpError(400, "Ungültiges Branding-Kit.");
  const manifestPath = path.join(brandingKitsDirectory, kitId, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw httpError(404, "Branding-Kit wurde nicht gefunden.");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
}

function listBrandingKits(locationId = "") {
  const assignment = locationId ? locationBrandingRow(locationId) : null;
  const current = locationId ? brandingForLocation(locationId) : brandingFromSettings(getSettings());
  const kits = [neutralBrandingKit()];
  for (const entry of fs.readdirSync(brandingKitsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      kits.push(readBrandingKitManifest(entry.name));
    } catch {}
  }
  return kits.map((kit) => {
    const branding = brandingFromSettings(kit.branding || {});
    return {
      id: kit.id || "neutral",
      name: kit.name || branding.companyName || "Branding-Kit",
      builtin: Boolean(kit.builtin),
      installedAt: kit.installedAt || "",
      branding,
      pdf: kit.pdf || {},
      active: assignment?.kit_id
        ? String(kit.id || "neutral") === assignment.kit_id
        : branding.logoUrl === current.logoUrl
          && branding.iconUrl === current.iconUrl
          && branding.companyName === current.companyName
          && branding.adminEmail === current.adminEmail,
    };
  }).sort((a, b) => Number(b.builtin) - Number(a.builtin) || String(a.name).localeCompare(String(b.name), "de"));
}

function employeeLocationFilterSql(context, alias = "e") {
  const prefix = alias ? `${alias}.` : "";
  const sql = [`${prefix}home_location_id = ?`];
  const values = [context.locationId];
  if (context.departmentId) {
    sql.push(`${prefix}preferred_department_id = ?`);
    values.push(context.departmentId);
  }
  return { sql: sql.join(" AND "), values };
}

function scheduleEmployeeFilterSql(context, weekStart, weekEnd, alias = "e") {
  const prefix = alias ? `${alias}.` : "";
  if (!context.departmentId) return employeeLocationFilterSql(context, alias);
  return {
    sql: `${prefix}home_location_id = ? AND (${prefix}preferred_department_id = ? OR EXISTS (
      SELECT 1
      FROM shifts sx
      WHERE sx.employee_number = ${prefix}personnel_number
        AND sx.shift_date BETWEEN ? AND ?
        AND sx.department_id = ?
    ))`,
    values: [context.locationId, context.departmentId, weekStart, weekEnd, context.departmentId],
  };
}

function resolveBackupDirectory(value) {
  const raw = String(value || defaultBackupDirectorySetting).trim()
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/%HOME%/gi, os.homedir());
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function backupDirectoryFromSettings(settings = getSettings()) {
  return process.env.BACKUP_DIR || resolveBackupDirectory(settings.backup_directory || defaultBackupDirectorySetting);
}

function validateBackupDirectory(value) {
  const stored = String(value || "").trim();
  if (!stored) throw httpError(400, "Bitte einen Backup-Ordner angeben.");
  const backupDirectory = process.env.BACKUP_DIR || resolveBackupDirectory(stored);
  if (!path.isAbsolute(backupDirectory)) {
    throw httpError(400, "Bitte einen vollständigen Backup-Pfad angeben.");
  }
  fs.mkdirSync(backupDirectory, { recursive: true });
  fs.accessSync(backupDirectory, fs.constants.W_OK);
  return { stored: process.env.BACKUP_DIR || stored, resolved: backupDirectory };
}

function backupIntervalMs(settings = getSettings()) {
  const hours = Number(settings.backup_interval_hours || 2);
  return Math.min(6, Math.max(1, Number.isFinite(hours) ? hours : 2)) * 60 * 60 * 1000;
}

function scheduleAutomaticBackups() {
  if (backupInterval) clearInterval(backupInterval);
  backupInterval = setInterval(() => {
    try {
      const settings = getSettings();
      const backup = createExternalDatabaseBackup("scheduled", settings);
      if (backup) {
        lastBackup = {
          path: backup.path,
          createdAt: backup.createdAt,
          reason: "scheduled",
          appBackup: lastBackup?.appBackup || null,
          externalBackup: backup,
        };
      }
    } catch (error) {
      console.error("Backup konnte nicht erstellt werden:", error);
    }
  }, backupIntervalMs());
  backupInterval.unref();
}

const dayKeyByNumber = {
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
};

function dayKeyForDate(isoDate) {
  return dayKeyByNumber[new Date(`${isoDate}T12:00:00Z`).getUTCDay()] || null;
}

function parseFixedWorkdays(value) {
  return String(value || "")
    .split(",")
    .map((day) => day.trim())
    .filter(Boolean);
}

function normalizeFixedWorkdays(value) {
  const submitted = Array.isArray(value) ? value : parseFixedWorkdays(value);
  const normalized = [...new Set(submitted.map((day) => String(day || "").trim()).filter(Boolean))];
  if (!normalized.every((day) => fixedWorkdayKeys.includes(day))) {
    throw httpError(400, "Die fixen Arbeitstage sind ungültig.");
  }
  return normalized;
}

function employeeCanWorkOnDate(employee, isoDate) {
  const fixedDays = parseFixedWorkdays(employee.fixed_workdays);
  return fixedDays.length === 0 || fixedDays.includes(dayKeyForDate(isoDate));
}

function dayConfiguration(isoDate, settings, context = null) {
  const key = dayKeyForDate(isoDate);
  if (!key) return null;
  const configuredMinStaff = Number(settings[`${key}_min_staff`] || 0);
  const contextMinStaff = context ? staffingFloorForContext(context) : 0;
  return {
    key,
    open: settings[`${key}_open`] !== "0",
    start: settings[`${key}_start_time`],
    end: settings[`${key}_end_time`],
    lunchEnabled: settingEnabled(settings, `${key}_lunch_enabled`),
    lunchStart: settings[`${key}_lunch_start`],
    lunchEnd: settings[`${key}_lunch_end`],
    minStaff: Math.max(configuredMinStaff, contextMinStaff),
    configuredMinStaff,
    contextMinStaff,
    minFrom: settings[`${key}_min_from`],
    minTo: settings[`${key}_min_to`],
  };
}

function operatingHours(isoDate, settings) {
  const config = dayConfiguration(isoDate, settings);
  return config?.open ? { start: config.start, end: config.end } : null;
}

function serializeGlobalDayBlock(row) {
  const holidayName = publicHolidayName(row.block_date);
  return {
    ...row,
    location_id: row.location_id || "01",
    is_public_holiday: Boolean(row.is_public_holiday),
    holiday_name: holidayName,
  };
}

function getGlobalDayBlocksForRange(start, end, locationId = null) {
  const locationFilter = locationId ? "AND location_id = ?" : "";
  const params = locationId ? [start, end, locationId] : [start, end];
  return db
    .prepare(`
      SELECT id, location_id, week_start, block_date, reason, is_public_holiday, created_at
      FROM global_day_blocks
      WHERE block_date BETWEEN ? AND ?
        ${locationFilter}
      ORDER BY block_date
    `)
    .all(...params)
    .map(serializeGlobalDayBlock);
}

function getGlobalDayBlockForDate(isoDate, locationId = null) {
  const locationFilter = locationId ? "AND location_id = ?" : "";
  const params = locationId ? [isoDate, locationId] : [isoDate];
  const row = db
    .prepare(`
      SELECT id, location_id, week_start, block_date, reason, is_public_holiday, created_at
      FROM global_day_blocks
      WHERE block_date = ?
        ${locationFilter}
    `)
    .get(...params);
  return row ? serializeGlobalDayBlock(row) : null;
}

function publicHolidaysForRange(start, end) {
  const holidays = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const name = publicHolidayName(date);
    if (name) holidays.push({ date, name });
  }
  return holidays;
}

function isVacationHoliday(isoDate, locationId = null) {
  if (publicHolidayName(isoDate)) return true;
  const block = getGlobalDayBlockForDate(isoDate, locationId);
  return Boolean(block?.is_public_holiday);
}

function holidayCreditMinutes(employee) {
  return Math.round((Number(employee.contracted_hours || 0) * 60) / 5);
}

function overlapMinutes(start, end, rangeStart, rangeEnd) {
  return Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart));
}

function overlappingWeekOption(employeeNumber, date, startTime, endTime) {
  return db.prepare(`
    SELECT o.*, e.nickname
    FROM week_options o
    JOIN employees e ON e.personnel_number = o.employee_number
    WHERE o.employee_number = ? AND ? BETWEEN o.date_from AND o.date_to
    ORDER BY o.all_day DESC, o.start_time
  `).all(employeeNumber, date)
    .find((option) => optionOverlapsTime(option, startTime, endTime));
}

function shiftMetrics(shift, settings) {
  const start = timeToMinutes(shift.start_time);
  let end = timeToMinutes(shift.end_time);
  if (end <= start) end += 24 * 60;
  const rawMinutes = end - start;
  const ruleBreakMinutes =
    settingEnabled(settings, "break_rule_enabled") &&
    rawMinutes > Number(settings.break_after_minutes)
      ? Number(settings.break_duration_minutes)
      : 0;
  const dayConfig = dayConfiguration(shift.shift_date, settings);
  const lunchBreakMinutes = dayConfig?.lunchEnabled
    ? overlapMinutes(
        start,
        end,
        timeToMinutes(dayConfig.lunchStart),
        timeToMinutes(dayConfig.lunchEnd),
      )
    : 0;
  const breakMinutes = Math.max(ruleBreakMinutes, lunchBreakMinutes);

  let countedMinutes = rawMinutes - breakMinutes;
  let bonusMinutes = 0;
  const isSaturday = new Date(`${shift.shift_date}T12:00:00Z`).getUTCDay() === 6;

  if (isSaturday && settingEnabled(settings, "saturday_bonus_enabled")) {
    const bonusStart = timeToMinutes(settings.saturday_bonus_from);
    let eligibleMinutes = Math.max(0, end - Math.max(start, bonusStart));
    if (dayConfig?.lunchEnabled) {
      eligibleMinutes -= overlapMinutes(
        Math.max(start, bonusStart),
        end,
        timeToMinutes(dayConfig.lunchStart),
        timeToMinutes(dayConfig.lunchEnd),
      );
    }
    bonusMinutes = eligibleMinutes * (Number(settings.saturday_bonus_factor) - 1);
    countedMinutes += bonusMinutes;
  }

  return {
    raw_minutes: rawMinutes,
    break_minutes: breakMinutes,
    lunch_break_minutes: lunchBreakMinutes,
    bonus_minutes: bonusMinutes,
    counted_minutes: countedMinutes,
  };
}

function serializeEmployee(row) {
  return {
    ...row,
    fixed_workdays: row.fixed_workdays || "",
    position_id: row.position_id || "verkaufsmitarbeiter",
    position_name: row.position_name || "Verkaufsmitarbeiter",
    home_location_id: row.home_location_id || "",
    home_location_name: row.home_location_name || "",
    preferred_department_id: row.preferred_department_id ? Number(row.preferred_department_id) : null,
    preferred_department_name: row.preferred_department_name || "",
    active: Boolean(row.active),
  };
}

function validateEmployee(body, isNew) {
  const personnelNumber = String(body.personnelNumber || "").trim();
  const fullName = String(body.fullName || "").trim();
  const nickname = String(body.nickname || "").trim();
  const color = /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color : "#0b84c6";
  const contractedHours = Number(body.contractedHours);
  const preferredDayOff = String(body.preferredDayOff || "").trim();
  const fixedWorkdays = normalizeFixedWorkdays(body.fixedWorkdays ?? body.fixed_workdays);
  const positionId = String(body.positionId || body.position_id || "verkaufsmitarbeiter").trim() || "verkaufsmitarbeiter";
  const allowedPreferredDays = ["", "monday", "tuesday", "wednesday", "thursday", "friday"];
  const homeLocationId = normalizeLocationId(body.homeLocationId || body.home_location_id || "01");
  validateLocationExists(homeLocationId);
  const preferredDepartmentId = normalizeDepartmentId(body.preferredDepartmentId ?? body.preferred_department_id, true);
  if (preferredDepartmentId) validateDepartmentExists(preferredDepartmentId, homeLocationId);
  if (!db.prepare("SELECT 1 FROM positions WHERE id = ?").get(positionId)) {
    throw httpError(400, "Bitte eine gültige Position auswählen.");
  }

  if (isNew && !/^[A-Za-z0-9._-]{1,24}$/.test(personnelNumber)) {
    throw httpError(400, "Bitte eine gültige Personalnummer eingeben.");
  }
  if (!fullName) throw httpError(400, "Bitte den Namen eingeben.");
  if (!nickname) throw httpError(400, "Bitte den Dienstplan-Namen eingeben.");
  if (!Number.isFinite(contractedHours) || contractedHours < 0 || contractedHours > 80) {
    throw httpError(400, "Die Wochen-Sollzeit muss zwischen 0 und 80 Stunden liegen.");
  }
  if (!allowedPreferredDays.includes(preferredDayOff)) {
    throw httpError(400, "Der bevorzugte freie Tag ist ungültig.");
  }

  return {
    personnelNumber,
    fullName,
    nickname,
    color,
    contractedHours,
    preferredDayOff: preferredDayOff || null,
    fixedWorkdays: fixedWorkdays.join(","),
    positionId,
    homeLocationId,
    preferredDepartmentId,
    active: body.active === false ? 0 : 1,
  };
}

function validateShift(body) {
  const employeeNumber = String(body.employeeNumber || "").trim();
  const shiftDate = String(body.date || "");
  const startTime = String(body.startTime || "");
  const endTime = String(body.endTime || "");
  const area = String(body.area || "").trim();
  const note = String(body.note || "").trim();
  const departmentId = normalizeDepartmentId(body.departmentId ?? body.department_id, true);

  if (!employeeNumber) throw httpError(400, "Bitte ein Teammitglied auswählen.");
  if (!isIsoDate(shiftDate)) throw httpError(400, "Das Datum ist ungültig.");
  if (!isTime(startTime) || !isTime(endTime)) throw httpError(400, "Die Arbeitszeit ist ungültig.");
  const employee = db.prepare("SELECT nickname, fixed_workdays, home_location_id FROM employees WHERE personnel_number = ?").get(employeeNumber);
  if (!employee) {
    throw httpError(404, "Die ausgewählte Person wurde nicht gefunden.");
  }
  if (departmentId) validateDepartmentExists(departmentId, employee.home_location_id);
  if (!employeeCanWorkOnDate(employee, shiftDate)) {
    throw httpError(409, `${employee.nickname} hat an diesem Wochentag keinen fix vereinbarten Arbeitstag.`);
  }
  const settings = settingsForLocation(employee.home_location_id);
  assertDateEditable(shiftDate, settings);
  const globalBlock = getGlobalDayBlockForDate(shiftDate, employee.home_location_id);
  if (globalBlock) {
    throw httpError(409, `Dieser Tag ist für alle gesperrt: ${globalBlock.reason || globalBlock.holiday_name || "gesperrt"}.`);
  }
  const hours = operatingHours(shiftDate, settings);
  if (!hours) throw httpError(400, "An Sonntagen kann kein Dienst eingetragen werden.");
  if (startTime < hours.start || endTime > hours.end || endTime <= startTime) {
    throw httpError(
      400,
      `Der Dienst muss innerhalb der Dienstzeit ${hours.start}–${hours.end} Uhr liegen.`,
    );
  }
  const dayConfig = dayConfiguration(shiftDate, settings);
  if (
    dayConfig.lunchEnabled &&
    startTime >= dayConfig.lunchStart &&
    endTime <= dayConfig.lunchEnd
  ) {
    throw httpError(400, "Der Dienst liegt vollständig innerhalb der eingestellten Mittagspause.");
  }
  const conflict = overlappingWeekOption(employeeNumber, shiftDate, startTime, endTime);
  if (conflict) {
    throw httpError(
      409,
      `${conflict.nickname} ist zu dieser Zeit bereits als „${optionLabel(conflict.option_type)}“ eingetragen.`,
    );
  }

  return { employeeNumber, departmentId, shiftDate, startTime, endTime, area, note };
}

const alwaysFullDayOptionTypes = new Set(["vacation", "sick", "branch", "vocational_school", "special_leave"]);
const timedOptionTypes = new Set(["school", "time_off", "external_appointment", "team_meeting", "other"]);
const manualAllDayCreditTypes = new Set(["school", "external_appointment", "team_meeting", "other"]);
const allowedWeekOptionTypes = [
  "vacation",
  "sick",
  "branch",
  "vocational_school",
  "school",
  "time_off",
  "special_leave",
  "external_appointment",
  "team_meeting",
  "other",
];

function optionIsAllDay(option) {
  return Number(option.all_day ?? 1) === 1;
}

function optionTimeRange(option) {
  if (optionIsAllDay(option)) return { start: "00:00", end: "23:59" };
  return { start: option.start_time, end: option.end_time };
}

function timeRangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function optionOverlapsTime(option, startTime, endTime) {
  if (optionIsAllDay(option)) return true;
  if (!isTime(option.start_time) || !isTime(option.end_time)) return true;
  return timeRangesOverlap(startTime, endTime, option.start_time, option.end_time);
}

function validateWeekOption(body, existingId = 0) {
  const employeeNumber = String(body.employeeNumber || "").trim();
  const weekStart = getMonday(String(body.weekStart || ""));
  const dateFrom = String(body.dateFrom || "");
  const dateTo = String(body.dateTo || "");
  const optionType = String(body.optionType || "");
  const note = String(body.note || "").trim();
  const allDay = alwaysFullDayOptionTypes.has(optionType) || body.allDay === true;
  const startTime = String(body.startTime || "");
  const endTime = String(body.endTime || "");
  const manualHours = body.manualHours === "" || body.manualHours === undefined
    ? null
    : Number(body.manualHours);

  const employee = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(employeeNumber);
  if (!employee) {
    throw httpError(404, "Die ausgewählte Person wurde nicht gefunden.");
  }
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Zeitraum eingeben.");
  }
  if (dateFrom < weekStart || dateTo > addDays(weekStart, 6)) {
    throw httpError(400, "Der Zeitraum muss innerhalb der ausgewählten Woche liegen.");
  }
  assertWeekEditable(weekStart, settingsForLocation(employee.home_location_id));
  if (!allowedWeekOptionTypes.includes(optionType)) throw httpError(400, "Bitte eine gültige Option auswählen.");
  if (!alwaysFullDayOptionTypes.has(optionType) && !timedOptionTypes.has(optionType)) {
    throw httpError(400, "Bitte eine gültige Option auswählen.");
  }
  if (!allDay) {
    if (!isTime(startTime) || !isTime(endTime) || endTime <= startTime) {
      throw httpError(400, "Bitte eine gültige Uhrzeit für die Planungsoption eingeben.");
    }
  }
  if (allDay && manualAllDayCreditTypes.has(optionType)) {
    if (!Number.isFinite(manualHours) || manualHours < 0 || manualHours > 24) {
      throw httpError(400, "Bitte die anrechenbaren Stunden pro Tag zwischen 0 und 24 eingeben.");
    }
  }
  const overlappingOption = db.prepare(`
    SELECT id, all_day, start_time, end_time
    FROM week_options
    WHERE employee_number = ? AND date_from <= ? AND date_to >= ? AND id != ?
  `).all(employeeNumber, dateTo, dateFrom, Number(existingId || 0))
    .some((option) => allDay || optionOverlapsTime(option, startTime, endTime));
  if (overlappingOption) {
    throw httpError(409, "Für diesen Zeitraum ist bereits eine überschneidende Planungsoption eingetragen.");
  }
  const existingShift = db.prepare(`
    SELECT shift_date, start_time, end_time
    FROM shifts
    WHERE employee_number = ? AND shift_date BETWEEN ? AND ?
  `).all(employeeNumber, dateFrom, dateTo)
    .find((shift) => allDay || timeRangesOverlap(startTime, endTime, shift.start_time, shift.end_time));
  if (existingShift) {
    throw httpError(
      409,
      `Für ${existingShift.shift_date} ist bereits ein Dienst von ${existingShift.start_time} bis ${existingShift.end_time} Uhr eingetragen.`,
    );
  }

  return {
    employeeNumber,
    weekStart,
    dateFrom,
    dateTo,
    optionType,
    note,
    groupId: String(body.groupId || "").trim() || null,
    allDay: allDay ? 1 : 0,
    startTime: allDay ? null : startTime,
    endTime: allDay ? null : endTime,
    creditedMinutesPerDay: allDay && manualAllDayCreditTypes.has(optionType) ? Math.round(manualHours * 60) : null,
  };
}

function optionMinutesPerDay(option, contractedHours) {
  if (alwaysFullDayOptionTypes.has(option.option_type)) {
    return Math.round((Number(contractedHours) * 60) / 5);
  }
  if (option.option_type === "time_off") return 0;
  if (!optionIsAllDay(option) && isTime(option.start_time) && isTime(option.end_time)) {
    return Math.max(0, timeToMinutes(option.end_time) - timeToMinutes(option.start_time));
  }
  return Math.max(0, Number(option.credited_minutes_per_day || 0));
}

function vacationDayCount(dateFrom, dateTo, settings = getSettings(), locationId = null) {
  let days = 0;
  const countSaturday = settingEnabled(settings, "vacation_count_saturday");
  for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (day === 0) continue;
    if (day === 6 && !countSaturday) continue;
    if (isVacationHoliday(date, locationId)) continue;
    days += 1;
  }
  return days;
}

function countCreditedOptionDays(option, settings = getSettings(), locationId = null) {
  if (option.option_type === "vacation") {
    return vacationDayCount(option.date_from, option.date_to, settings, locationId);
  }
  let days = 0;
  for (let date = option.date_from; date <= option.date_to; date = addDays(date, 1)) {
    if (new Date(`${date}T12:00:00Z`).getUTCDay() !== 0) days += 1;
  }
  return optionIsAllDay(option) && alwaysFullDayOptionTypes.has(option.option_type) ? Math.min(days, 5) : days;
}

function hasNonVacationCreditOnDate(options, employeeNumber, date) {
  return options.some((option) =>
    option.employee_number === employeeNumber &&
    option.option_type !== "vacation" &&
    date >= option.date_from &&
    date <= option.date_to &&
    optionMinutesPerDay(option, option.contracted_hours) > 0,
  );
}

function countSaturdaysInRange(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) return 0;
  let count = 0;
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 6) count += 1;
  }
  return count;
}

function saturdayShiftFilterSql(context, prefix = "s") {
  const clauses = [
    "strftime('%w', shift_date) = '6'",
    "((CAST(substr(end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(end_time, 4, 2) AS INTEGER)) - (CAST(substr(start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(start_time, 4, 2) AS INTEGER))) >= 120",
  ];
  if (context.departmentId) clauses.push(`${prefix}.department_id = ?`);
  return clauses.join(" AND ");
}

function buildSaturdayServiceStats(weekStart, context, employees, currentWeekShifts, settings) {
  const employeeNumbers = employees.map((employee) => employee.personnel_number);
  if (!employeeNumbers.length || !settingEnabled(settings, "show_saturday_service_stats")) {
    return { byEmployee: {}, estimated: false };
  }
  const employeeFilter = employeeLocationFilterSql(context, "e");
  const departmentValue = context.departmentId ? [context.departmentId] : [];
  const earliest = db.prepare(`
    SELECT MIN(s.shift_date) AS first_date
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    WHERE e.active = 1 AND ${employeeFilter.sql}
      ${context.departmentId ? "AND s.department_id = ?" : ""}
  `).get(...employeeFilter.values, ...departmentValue)?.first_date;
  const saturdayDate = addDays(weekStart, 5);
  const currentSaturdayStaff = new Set(
    currentWeekShifts
      .filter((shift) => shift.shift_date === saturdayDate)
      .filter((shift) => (shift.raw_minutes || 0) >= 120)
      .map((shift) => shift.employee_number),
  ).size;
  const fallbackStaffPerSaturday = Math.max(
    currentSaturdayStaff,
    Math.min(employees.length, Math.max(2, Number(dayConfiguration(saturdayDate, settings, context)?.minStaff || 0))),
  );
  const fallbackPerEmployee = employees.length ? fallbackStaffPerSaturday / employees.length : 0;

  function statsForWindow(startDate, endDate) {
    const totalSaturdays = countSaturdaysInRange(startDate, endDate);
    const complete = Boolean(earliest && earliest <= startDate);
    const observedStart = earliest && earliest > startDate ? earliest : startDate;
    const observedSaturdays = earliest && observedStart <= endDate ? countSaturdaysInRange(observedStart, endDate) : 0;
    const values = Object.fromEntries(employeeNumbers.map((number) => [number, 0]));
    if (earliest && observedStart <= endDate) {
      const rows = db.prepare(`
        SELECT s.employee_number, COUNT(DISTINCT s.shift_date) AS count
        FROM shifts s
        JOIN employees e ON e.personnel_number = s.employee_number
        WHERE s.shift_date BETWEEN ? AND ?
          AND e.active = 1 AND ${employeeFilter.sql}
          AND ${saturdayShiftFilterSql(context, "s")}
        GROUP BY s.employee_number
      `).all(observedStart, endDate, ...employeeFilter.values, ...departmentValue);
      for (const row of rows) values[row.employee_number] = Number(row.count || 0);
    }
    const estimated = !complete;
    const fallbackValue = estimated && observedSaturdays === 0 ? totalSaturdays * fallbackPerEmployee : 0;
    return {
      estimated,
      values: Object.fromEntries(
        employeeNumbers.map((number) => [
          number,
          estimated
            ? observedSaturdays > 0
              ? values[number] * (totalSaturdays / observedSaturdays)
              : fallbackValue
            : values[number],
        ]),
      ),
    };
  }

  const fourWeeks = statsForWindow(addDays(weekStart, -28), addDays(weekStart, -1));
  const threeMonths = statsForWindow(addMonths(weekStart, -3), addDays(weekStart, -1));
  return {
    byEmployee: Object.fromEntries(
      employeeNumbers.map((number) => [
        number,
        {
          fourWeeks: fourWeeks.values[number] || 0,
          fourWeeksEstimated: fourWeeks.estimated,
          threeMonths: threeMonths.values[number] || 0,
          threeMonthsEstimated: threeMonths.estimated,
        },
      ]),
    ),
    estimated: fourWeeks.estimated || threeMonths.estimated,
  };
}

function getSchedule(weekValue, contextInput = {}, session = null) {
  const weekStart = getMonday(isIsoDate(weekValue) ? weekValue : undefined);
  const weekEnd = addDays(weekStart, 6);
  const context = resolvePlanningContext(contextInput);
  assertSessionContextScope(session, context);
  const settings = applyScopedPdfSettings(settingsForLocation(context.locationId), context, "schedule");
  const globalDayBlocks = getGlobalDayBlocksForRange(weekStart, weekEnd, context.locationId);
  const globalBlockDates = new Set(globalDayBlocks.map((block) => block.block_date));
  const employeeFilter = scheduleEmployeeFilterSql(context, weekStart, weekEnd, "e");
  const employees = db
    .prepare(`
      SELECT e.personnel_number, e.full_name, e.nickname, e.color, e.contracted_hours,
             e.preferred_day_off, e.fixed_workdays, e.position_id, e.home_location_id, e.preferred_department_id,
             e.active, l.name AS home_location_name, d.name AS preferred_department_name,
             p.name AS position_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.home_location_id
      LEFT JOIN departments d ON d.id = e.preferred_department_id
      LEFT JOIN positions p ON p.id = e.position_id
      WHERE e.active = 1 AND ${employeeFilter.sql}
      ORDER BY CAST(personnel_number AS INTEGER), personnel_number
    `)
    .all(...employeeFilter.values)
    .map(serializeEmployee);
  const shiftDepartmentFilter = context.departmentId ? "AND s.department_id = ?" : "";
  const shiftValues = context.departmentId
    ? [weekStart, weekEnd, context.locationId, context.departmentId]
    : [weekStart, weekEnd, context.locationId];
  const shifts = db
    .prepare(`
      SELECT s.id, s.employee_number, s.department_id, s.shift_date, s.start_time, s.end_time,
             s.area, s.note, e.full_name, e.nickname, e.color, d.name AS department_name
      FROM shifts s
      JOIN employees e ON e.personnel_number = s.employee_number
      LEFT JOIN departments d ON d.id = s.department_id
      WHERE s.shift_date BETWEEN ? AND ?
        AND e.home_location_id = ?
        ${shiftDepartmentFilter}
      ORDER BY s.shift_date, s.start_time, CAST(s.employee_number AS INTEGER), s.employee_number
    `)
    .all(...shiftValues)
    .map((shift) => ({ ...shift, ...shiftMetrics(shift, settings) }));
  const weekOptions = db
    .prepare(`
      SELECT o.id, o.group_id, o.employee_number, o.week_start, o.date_from, o.date_to,
             o.option_type, o.note, o.credited_minutes_per_day,
             o.all_day, o.start_time, o.end_time,
             e.nickname, e.color, e.contracted_hours
      FROM week_options o
      JOIN employees e ON e.personnel_number = o.employee_number
      WHERE o.week_start = ? AND ${employeeFilter.sql}
      ORDER BY CAST(o.employee_number AS INTEGER), o.employee_number, o.date_from
    `)
    .all(weekStart, ...employeeFilter.values);
  const pendingTimeOff = db.prepare(`
    SELECT t.id, t.employee_number, COALESCE(t.date_from, t.request_date) AS date_from,
           COALESCE(t.date_to, t.request_date) AS date_to, t.all_day, t.start_time, t.end_time, t.note,
           e.nickname, e.color, e.contracted_hours
    FROM time_off_requests t JOIN employees e ON e.personnel_number = t.employee_number
    WHERE t.status IN ('pending','pending_local','preliminary_local','pending_hr')
      AND COALESCE(t.date_from, t.request_date) <= ? AND COALESCE(t.date_to, t.request_date) >= ?
      AND ${employeeFilter.sql}
  `).all(weekEnd, weekStart, ...employeeFilter.values).map((item) => ({
    ...item,
    id: `pending-za-${item.id}`,
    group_id: null,
    week_start: weekStart,
    option_type: "time_off",
    note: `Beantragt${item.note ? ` · ${item.note}` : ""}`,
    credited_minutes_per_day: 0,
    soft_pending: true,
  }));
  weekOptions.push(...pendingTimeOff);

  const totals = {};
  const plannedTotals = {};
  const inStoreTotals = {};
  const bonusTotals = {};
  const optionCreditTotals = {};
  for (const employee of employees) {
    totals[employee.personnel_number] = 0;
    plannedTotals[employee.personnel_number] = 0;
    inStoreTotals[employee.personnel_number] = 0;
    bonusTotals[employee.personnel_number] = 0;
    optionCreditTotals[employee.personnel_number] = 0;
  }
  for (const shift of shifts) {
    totals[shift.employee_number] =
      (totals[shift.employee_number] || 0) + shift.counted_minutes;
    plannedTotals[shift.employee_number] =
      (plannedTotals[shift.employee_number] || 0) + shift.raw_minutes - shift.break_minutes;
    inStoreTotals[shift.employee_number] =
      (inStoreTotals[shift.employee_number] || 0) + shift.raw_minutes - shift.break_minutes;
    bonusTotals[shift.employee_number] =
      (bonusTotals[shift.employee_number] || 0) + shift.bonus_minutes;
  }
  for (const option of weekOptions) {
    option.credited_minutes_per_day_effective = optionMinutesPerDay(option, option.contracted_hours);
    option.credited_minutes = option.credited_minutes_per_day_effective * countCreditedOptionDays(option, settings, context.locationId);
    optionCreditTotals[option.employee_number] =
      (optionCreditTotals[option.employee_number] || 0) + option.credited_minutes;
    totals[option.employee_number] =
      (totals[option.employee_number] || 0) + option.credited_minutes;
  }
  const saturdayStats = buildSaturdayServiceStats(weekStart, context, employees, shifts, settings);
  const creditedHolidayDates = new Set();
  for (const holiday of publicHolidaysForRange(weekStart, weekEnd)) {
    const day = new Date(`${holiday.date}T12:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) continue;
    for (const employee of employees) {
      if (hasNonVacationCreditOnDate(weekOptions, employee.personnel_number, holiday.date)) continue;
      const credit = holidayCreditMinutes(employee);
      optionCreditTotals[employee.personnel_number] = (optionCreditTotals[employee.personnel_number] || 0) + credit;
      totals[employee.personnel_number] = (totals[employee.personnel_number] || 0) + credit;
    }
    creditedHolidayDates.add(holiday.date);
  }
  for (const block of globalDayBlocks) {
    if (!block.is_public_holiday || creditedHolidayDates.has(block.block_date)) continue;
    const day = new Date(`${block.block_date}T12:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) continue;
    for (const employee of employees) {
      if (hasNonVacationCreditOnDate(weekOptions, employee.personnel_number, block.block_date)) continue;
      const credit = holidayCreditMinutes(employee);
      optionCreditTotals[employee.personnel_number] = (optionCreditTotals[employee.personnel_number] || 0) + credit;
      totals[employee.personnel_number] = (totals[employee.personnel_number] || 0) + credit;
    }
  }

  return {
    weekStart,
    weekEnd,
    calendarWeek: getIsoWeek(weekStart),
    context,
    locations: getLocationsForSession(session, true),
    settings,
    currentWeekStart: currentWeekStart(),
    isPastWeek: isPastWeekStart(weekStart),
    isPastWeekLocked: (isPastWeekStart(weekStart) && !settingEnabled(settings, "allow_past_week_editing"))
      || (weekStart === currentWeekStart() && settingEnabled(settings, "current_week_auto_lock") && viennaNowLocal() >= currentWeekLockPoint(settings)),
    currentWeekLockPoint: currentWeekLockPoint(settings),
    employees,
    shifts,
    weekOptions,
    globalDayBlocks,
    scheduleNote: getScheduleNote(weekStart, context),
    globalBlockDates: Array.from(globalBlockDates),
    publicHolidays: publicHolidaysForRange(weekStart, weekEnd),
    totals,
    plannedTotals,
    inStoreTotals,
    bonusTotals,
    optionCreditTotals,
    saturdayStats,
  };
}

function validateYear(value = new Date().getFullYear()) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw httpError(400, "Bitte ein gültiges Jahr auswählen.");
  }
  return year;
}

function daysBetweenInclusive(startDate, endDate) {
  return Math.round((new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / 86400000) + 1;
}

function overlapDateRange(startA, endA, startB, endB) {
  return startA <= endB && startB <= endA;
}

function monthStart(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;
}

function monthEnd(year, monthIndex) {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0, 12));
  return date.toISOString().slice(0, 10);
}

function vacationGroupKey(row) {
  return row.group_id || `legacy-${row.id}`;
}

function getVacationPlan(yearValue, contextInput = {}, session = null) {
  const year = validateYear(yearValue);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const today = new Date().toISOString().slice(0, 10);
  const consumedEnd = today < yearStart ? null : today > yearEnd ? yearEnd : today;
  const context = resolvePlanningContext(contextInput);
  assertSessionContextScope(session, context);
  const settings = applyScopedPdfSettings(settingsForLocation(context.locationId), context, "vacation");
  const employeeFilter = employeeLocationFilterSql(context, "e");
  const publicHolidays = publicHolidaysForRange(yearStart, yearEnd);
  const globalHolidayBlocks = getGlobalDayBlocksForRange(yearStart, yearEnd, context.locationId)
    .filter((block) => block.is_public_holiday)
    .map((block) => ({ date: block.block_date, name: block.reason || block.holiday_name || "Feiertag" }));
  const vacationHolidays = [...publicHolidays];
  for (const holiday of globalHolidayBlocks) {
    if (!vacationHolidays.some((item) => item.date === holiday.date)) vacationHolidays.push(holiday);
  }
  const employees = db
    .prepare(`
      SELECT e.personnel_number, e.full_name, e.nickname, e.color, e.contracted_hours,
             e.preferred_day_off, e.fixed_workdays, e.position_id, e.home_location_id, e.preferred_department_id,
             e.active, l.name AS home_location_name, d.name AS preferred_department_name,
             p.name AS position_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.home_location_id
      LEFT JOIN departments d ON d.id = e.preferred_department_id
      LEFT JOIN positions p ON p.id = e.position_id
      WHERE e.active = 1 AND ${employeeFilter.sql}
      ORDER BY CAST(personnel_number AS INTEGER), personnel_number
    `)
    .all(...employeeFilter.values)
    .map(serializeEmployee);
  const entitlementRows = db
    .prepare("SELECT employee_number, days FROM vacation_entitlements WHERE year = ?")
    .all(year);
  const entitlements = Object.fromEntries(employees.map((employee) => [employee.personnel_number, 0]));
  const entitlementsSaved = Object.fromEntries(employees.map((employee) => [employee.personnel_number, false]));
  for (const row of entitlementRows) {
    entitlements[row.employee_number] = Number(row.days || 0);
    entitlementsSaved[row.employee_number] = true;
  }

  const optionRows = db
    .prepare(`
      SELECT o.id, o.group_id, o.employee_number, o.week_start, o.date_from, o.date_to,
             o.option_type, o.note, o.credited_minutes_per_day, o.all_day, o.start_time, o.end_time,
             e.nickname, e.full_name, e.color
      FROM week_options o
      JOIN employees e ON e.personnel_number = o.employee_number
      WHERE o.option_type = 'vacation'
        AND o.date_from <= ?
        AND o.date_to >= ?
        AND ${employeeFilter.sql}
      ORDER BY o.date_from, CAST(o.employee_number AS INTEGER), o.employee_number
    `)
    .all(yearEnd, yearStart, ...employeeFilter.values);

  const grouped = new Map();
  for (const row of optionRows) {
    const key = vacationGroupKey(row);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        group_id: key,
        employee_number: row.employee_number,
        nickname: row.nickname,
        full_name: row.full_name,
        color: row.color,
        date_from: row.date_from,
        date_to: row.date_to,
        note: row.note || "",
        ids: [row.id],
      });
    } else {
      existing.date_from = existing.date_from < row.date_from ? existing.date_from : row.date_from;
      existing.date_to = existing.date_to > row.date_to ? existing.date_to : row.date_to;
      existing.note = existing.note || row.note || "";
      existing.ids.push(row.id);
    }
  }

  const vacations = Array.from(grouped.values())
    .map((vacation) => {
      const clippedFrom = vacation.date_from < yearStart ? yearStart : vacation.date_from;
      const clippedTo = vacation.date_to > yearEnd ? yearEnd : vacation.date_to;
      return {
        ...vacation,
        days: vacationDayCount(clippedFrom, clippedTo, settings, context.locationId),
        calendar_days: daysBetweenInclusive(clippedFrom, clippedTo),
      };
    })
    .sort((a, b) => a.date_from.localeCompare(b.date_from) || a.nickname.localeCompare(b.nickname));

  const plannedByEmployee = Object.fromEntries(employees.map((employee) => [employee.personnel_number, 0]));
  const consumedByEmployee = Object.fromEntries(employees.map((employee) => [employee.personnel_number, 0]));
  for (const vacation of vacations) {
    plannedByEmployee[vacation.employee_number] = (plannedByEmployee[vacation.employee_number] || 0) + vacation.days;
    if (consumedEnd && vacation.date_from <= consumedEnd) {
      const clippedFrom = vacation.date_from < yearStart ? yearStart : vacation.date_from;
      const clippedTo = vacation.date_to > consumedEnd ? consumedEnd : vacation.date_to;
      consumedByEmployee[vacation.employee_number] =
        (consumedByEmployee[vacation.employee_number] || 0) + vacationDayCount(clippedFrom, clippedTo, settings, context.locationId);
    }
  }
  const totals = Object.fromEntries(
    employees.map((employee) => {
      const entitlement = Number(entitlements[employee.personnel_number] || 0);
      const planned = Number(plannedByEmployee[employee.personnel_number] || 0);
      const consumed = Number(consumedByEmployee[employee.personnel_number] || 0);
      return [
        employee.personnel_number,
        {
          entitlement,
          entitlement_saved: Boolean(entitlementsSaved[employee.personnel_number]),
          used: planned,
          planned,
          consumed,
          remaining: entitlement - planned,
        },
      ];
    }),
  );

  return {
    year,
    context,
    locations: getLocationsForSession(session, true),
    settings,
    employees,
    entitlements,
    entitlementsSaved,
    vacations,
    totals,
    publicHolidays: vacationHolidays.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function validateVacationEntry(body, excludeGroupId = null) {
  const employeeNumber = String(body.employeeNumber || "").trim();
  const dateFrom = String(body.dateFrom || "");
  const dateTo = String(body.dateTo || "");
  const note = String(body.note || "").trim();

  if (!db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(employeeNumber)) {
    throw httpError(404, "Das ausgewählte Teammitglied wurde nicht gefunden.");
  }
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Urlaubszeitraum eingeben.");
  }
  const overlappingOption = db
    .prepare(`
      SELECT id, group_id, option_type, date_from, date_to
      FROM week_options
      WHERE employee_number = ? AND date_from <= ? AND date_to >= ?
    `)
    .all(employeeNumber, dateTo, dateFrom)
    .find((option) => vacationGroupKey(option) !== excludeGroupId);
  if (overlappingOption) {
    throw httpError(
      409,
      `In diesem Zeitraum ist bereits „${optionLabel(overlappingOption.option_type)}“ eingetragen.`,
    );
  }
  const existingShift = db
    .prepare(`
      SELECT shift_date, start_time, end_time
      FROM shifts
      WHERE employee_number = ? AND shift_date BETWEEN ? AND ?
      LIMIT 1
    `)
    .get(employeeNumber, dateFrom, dateTo);
  if (existingShift) {
    throw httpError(
      409,
      `Für ${existingShift.shift_date} ist bereits ein Dienst von ${existingShift.start_time} bis ${existingShift.end_time} Uhr eingetragen.`,
    );
  }

  return { employeeNumber, dateFrom, dateTo, note };
}

function validateGlobalDayBlock(body, existingId = 0) {
  const context = resolvePlanningContext({ ...body, departmentId: null, department: null });
  const blockDate = String(body.blockDate || body.date || "").trim();
  const weekStart = getMonday(String(body.weekStart || blockDate || ""));
  const reason = String(body.reason || "").trim();
  const isPublicHoliday = body.isPublicHoliday === true ? 1 : 0;

  if (!isIsoDate(blockDate)) throw httpError(400, "Bitte ein gültiges Datum für den Sperrtag auswählen.");
  if (blockDate < weekStart || blockDate > addDays(weekStart, 6)) {
    throw httpError(400, "Der Sperrtag muss innerhalb der ausgewählten Kalenderwoche liegen.");
  }
  if (!reason) throw httpError(400, "Bitte einen Grund für den Sperrtag eintragen.");
  assertWeekEditable(weekStart, settingsForLocation(context.locationId));

  const existingBlock = db
    .prepare("SELECT id FROM global_day_blocks WHERE location_id = ? AND block_date = ? AND id != ?")
    .get(context.locationId, blockDate, Number(existingId || 0));
  if (existingBlock) {
    throw httpError(409, "Für diesen Tag ist bereits eine ganztägige Sperre eingetragen.");
  }

  const shiftCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM shifts s
    JOIN employees e ON e.personnel_number = s.employee_number
    WHERE s.shift_date = ? AND e.home_location_id = ?
  `).get(blockDate, context.locationId).count;
  if (Number(shiftCount) > 0) {
    throw httpError(409, "Für diesen Tag sind bereits Dienste eingetragen. Bitte zuerst die Dienste entfernen.");
  }

  return { locationId: context.locationId, weekStart, blockDate, reason, isPublicHoliday };
}

const scheduleNoteMaxLength = 900;

function stripEmoji(value) {
  return String(value || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[\u2600-\u27BF]/gu, "")
    .replace(/\uFEFF/g, "");
}

function decodeBasicEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textFromScheduleNoteHtml(html) {
  return decodeBasicEntities(
    String(html || "")
      .replace(/<\/(div|p)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeScheduleNoteHtml(input) {
  let html = stripEmoji(String(input || ""));
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<span[^>]*class\s*=\s*["'][^"']*\bql-cursor\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, "");
  html = html.replace(/<[^>]*>/g, (tag) => {
    const lower = tag.toLowerCase();
    if (/^<(b|strong)(\s[^>]*)?>$/.test(lower)) return "<b>";
    if (/^<\/(b|strong)>$/.test(lower)) return "</b>";
    if (/^<(i|em)(\s[^>]*)?>$/.test(lower)) return "<i>";
    if (/^<\/(i|em)>$/.test(lower)) return "</i>";
    if (/^<u(\s[^>]*)?>$/.test(lower)) return "<u>";
    if (/^<\/u>$/.test(lower)) return "</u>";
    if (/^<br\s*\/?>$/.test(lower)) return "<br>";
    if (/^<(div|p)(\s[^>]*)?>$/.test(lower)) return "<div>";
    if (/^<\/(div|p)>$/.test(lower)) return "</div>";
    if (/^<span\b/i.test(lower)) {
      const size = lower.match(/data-size\s*=\s*["']?(small|normal|large)["']?/i)?.[1]
        || lower.match(/class\s*=\s*["'][^"']*\bql-size-(small|large)\b/i)?.[1]
        || "normal";
      return `<span data-size="${size}">`;
    }
    if (/^<\/span>$/.test(lower)) return "</span>";
    return "";
  });
  return html.trim();
}

function getScheduleNote(weekStart, context) {
  const row = db
    .prepare(`
      SELECT location_id, department_key, week_start, note_text, note_html, font_size, bold, italic, underline, updated_at
      FROM schedule_notes
      WHERE location_id = ? AND department_key = ? AND week_start = ?
    `)
    .get(context.locationId, pdfDepartmentKey(context), weekStart);
  if (!row || !String(row.note_text || "").trim()) return null;
  return {
    location_id: row.location_id,
    department_key: row.department_key,
    week_start: row.week_start,
    note_text: row.note_text,
    note_html: row.note_html || "",
    font_size: row.font_size,
    bold: Boolean(row.bold),
    italic: Boolean(row.italic),
    underline: Boolean(row.underline),
    updated_at: row.updated_at,
  };
}

function validateScheduleNote(body) {
  const weekStart = getMonday(isIsoDate(body.weekStart) ? body.weekStart : undefined);
  const context = resolvePlanningContext(body);
  assertWeekEditable(weekStart, settingsForLocation(context.locationId));
  const noteHtml = sanitizeScheduleNoteHtml(body.noteHtml || "");
  const noteText = stripEmoji(
    textFromScheduleNoteHtml(noteHtml) || String(body.noteText || body.text || ""),
  ).trim();
  if (!noteText) throw httpError(400, "Bitte eine Bemerkung eingeben.");
  if (noteText.length > scheduleNoteMaxLength) {
    throw httpError(400, `Die Bemerkung ist zu lang. Maximal ${scheduleNoteMaxLength} Zeichen.`);
  }
  return {
    weekStart,
    context,
    noteText,
    noteHtml: noteHtml || noteText,
    fontSize: "medium",
    bold: 0,
    italic: 0,
    underline: 0,
  };
}

function createVacationGroupId() {
  return `vac-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function insertVacationEntries(vacation, groupId) {
  const insertOption = db.prepare(`
    INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type, note, credited_minutes_per_day, all_day, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, 'vacation', ?, NULL, 1, NULL, NULL)
  `);
  let date = vacation.dateFrom;
  let created = 0;
  while (date <= vacation.dateTo) {
    const weekStart = getMonday(date);
    const weekEnd = addDays(weekStart, 6);
    const segmentEnd = weekEnd < vacation.dateTo ? weekEnd : vacation.dateTo;
    insertOption.run(vacation.employeeNumber, groupId, weekStart, date, segmentEnd, vacation.note);
    created += 1;
    date = addDays(segmentEnd, 1);
  }
  return created;
}

function createVacationEntries(vacation) {
  const groupId = createVacationGroupId();
  let created = 0;
  db.exec("BEGIN");
  try {
    created = insertVacationEntries(vacation, groupId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { groupId, created };
}

function vacationGroupExists(groupId) {
  if (String(groupId).startsWith("legacy-")) {
    const id = Number(String(groupId).replace("legacy-", ""));
    return Number.isInteger(id) && Boolean(db.prepare("SELECT 1 FROM week_options WHERE id = ? AND option_type = 'vacation'").get(id));
  }
  return Boolean(db.prepare("SELECT 1 FROM week_options WHERE group_id = ? AND option_type = 'vacation'").get(groupId));
}

function replaceVacationGroup(groupId, vacation) {
  let created = 0;
  db.exec("BEGIN");
  try {
    deleteVacationGroup(groupId);
    created = insertVacationEntries(vacation, groupId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { groupId, created };
}

function deleteVacationGroup(groupId) {
  if (String(groupId).startsWith("legacy-")) {
    const id = Number(String(groupId).replace("legacy-", ""));
    if (!Number.isInteger(id)) return 0;
    return db.prepare("DELETE FROM week_options WHERE id = ? AND option_type = 'vacation'").run(id).changes;
  }
  return db.prepare("DELETE FROM week_options WHERE group_id = ? AND option_type = 'vacation'").run(groupId).changes;
}

function databasePragmaValue(name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row ? Object.values(row)[0] : null;
}

function directoryDiagnostics(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    const stats = typeof fs.statfsSync === "function" ? fs.statfsSync(directory) : null;
    return {
      writable: true,
      freeBytes: stats ? Number(stats.bavail) * Number(stats.bsize) : null,
      volume: path.parse(path.resolve(directory)).root,
    };
  } catch (error) {
    return { writable: false, freeBytes: null, volume: path.parse(path.resolve(directory)).root, error: error.message };
  }
}

function latestDatabaseBackup(backupDirectory) {
  try {
    return fs.readdirSync(backupDirectory)
      .filter((name) => /^dienstplan-.*\.db$/.test(name))
      .map((name) => {
        const modified = fs.statSync(path.join(backupDirectory, name)).mtime;
        return { name, modifiedAt: modified.toISOString(), modifiedMs: modified.getTime() };
      })
      .sort((left, right) => right.modifiedMs - left.modifiedMs)[0] || null;
  } catch { return null; }
}

function serverDiagnostics() {
  const settings = getSettings();
  const portal = getPortalStatus();
  const migration = db.prepare("SELECT id, app_version, applied_at FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1").get() || null;
  const warnings = [];
  const dataHealth = directoryDiagnostics(dataRootDirectory);
  let externalDirectory = "";
  try { externalDirectory = backupDirectoryFromSettings(settings); } catch (error) { warnings.push(`Das externe Backupziel ist ungültig: ${error.message}`); }
  const backupHealth = externalDirectory ? directoryDiagnostics(externalDirectory) : { writable: false, freeBytes: null, volume: "" };
  const latestBackup = latestDatabaseBackup(externalDirectory || appBackupDirectory) || latestDatabaseBackup(appBackupDirectory);
  const latestBackupAgeHours = latestBackup ? Math.max(0, (Date.now() - latestBackup.modifiedMs) / 3600000) : null;
  const amu = amuStorage ? amuStorage.diagnostics() : { ok: false, writable: false, error: amuStorageStartupError };
  if (serverModeActive && !/^https:\/\//i.test(publicUrl)) warnings.push("Für den Serverbetrieb fehlt eine gültige HTTPS-Adresse.");
  if (serverModeActive && portal.adminSetupState !== "configured") warnings.push("Vor dem Serverstart muss ein Admin-Zugang eingerichtet sein.");
  if (serverModeActive && !loopbackHosts.has(HOST.toLowerCase())) warnings.push("Der Server lauscht nicht ausschließlich auf Loopback. Firewall und Reverse-Proxy-Konfiguration prüfen.");
  if (settings.external_backup_enabled === "0") warnings.push("Die zusätzliche externe Datensicherung ist deaktiviert.");
  if (!dataHealth.writable) warnings.push("Das Server-Datenverzeichnis ist nicht beschreibbar.");
  if (settingEnabled(settings, "external_backup_enabled") && !backupHealth.writable) warnings.push("Das externe Backupziel ist nicht beschreibbar.");
  if (latestBackupAgeHours === null || latestBackupAgeHours > Math.max(6, Number(settings.backup_interval_hours || 2) * 3)) warnings.push("Es wurde kein ausreichend aktuelles verifiziertes Datenbank-Backup gefunden.");
  if (externalDirectory && path.parse(path.resolve(databasePath)).root.toLowerCase() === path.parse(path.resolve(externalDirectory)).root.toLowerCase()) warnings.push("Datenbank und externes Backup liegen auf demselben Laufwerk.");
  if (!amu.ok) warnings.push(`Der geschützte AUM-Speicher ist nicht betriebsbereit${amu.error ? `: ${amu.error}` : "."}`);
  if (serverModeActive && serviceControlToken.length < 32) warnings.push("Der sichere Token für den Windows-Dienststopp fehlt.");
  const lockedAccounts = Number(db.prepare("SELECT COUNT(*) AS count FROM portal_users WHERE locked_until > CURRENT_TIMESTAMP").get().count || 0);
  if (lockedAccounts) warnings.push(`${lockedAccounts} Zugang/Zugänge sind derzeit gesperrt.`);
  return {
    ready: startupIntegrity.length === 1 && startupIntegrity[0] === "ok" && dataHealth.writable
      && (!serverModeActive || (/^https:\/\//i.test(publicUrl) && portal.adminSetupState === "configured" && backupHealth.writable && amu.ok && serviceControlToken.length >= 32)),
    mode: portal.operationMode,
    publicUrl: portal.publicUrl,
    httpsRequired: portal.httpsRequired,
    listenHost: HOST,
    port: PORT,
    trustProxy: portal.trustProxy,
    passwordMinLength: portal.passwordMinLength,
    database: {
      file: path.basename(databasePath),
      integrity: startupIntegrity[0] || "unknown",
      journalMode: databasePragmaValue("journal_mode"),
      synchronous: databasePragmaValue("synchronous"),
      busyTimeoutMs: Number(databasePragmaValue("busy_timeout") || 0),
      foreignKeys: Boolean(databasePragmaValue("foreign_keys")),
      migration,
    },
    instanceLock: { enabled: Boolean(instanceLockPath), held: instanceLockHeld },
    process: { pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() },
    storage: { dataRoot: dataRootDirectory, data: dataHealth, amu },
    backups: {
      appDirectory: appBackupDirectory,
      externalEnabled: settingEnabled(settings, "external_backup_enabled"),
      externalDirectory,
      externalWritable: backupHealth.writable,
      freeBytes: backupHealth.freeBytes,
      latest: latestBackup,
      latestAgeHours: latestBackupAgeHours,
      lastVerified: Boolean(lastBackup?.appBackup?.verified || lastBackup?.externalBackup?.verified),
    },
    pilotChecks: [
      { id: "mode", label: "Servermodus", ok: serverModeActive, detail: serverModeActive ? "aktiv" : "für den Pilot noch nicht aktiv" },
      { id: "https", label: "HTTPS-Adresse", ok: /^https:\/\//i.test(publicUrl), detail: publicUrl || "nicht konfiguriert" },
      { id: "admin", label: "Admin-Zugang", ok: portal.adminSetupState === "configured", detail: portal.adminSetupState },
      { id: "database", label: "SQLite-Integrität", ok: startupIntegrity[0] === "ok", detail: startupIntegrity[0] || "unbekannt" },
      { id: "data", label: "Datenverzeichnis", ok: dataHealth.writable, detail: dataHealth.writable ? "beschreibbar" : "nicht beschreibbar" },
      { id: "backup", label: "Externes Backup", ok: backupHealth.writable && latestBackupAgeHours !== null, detail: latestBackup ? latestBackup.modifiedAt : "noch kein Backup" },
      { id: "amu", label: "AUM-Speicher", ok: amu.ok, detail: amu.ok ? "verschlüsselt und beschreibbar" : (amu.error || "nicht bereit") },
      { id: "service-stop", label: "Dienststopp", ok: serviceControlToken.length >= 32, detail: serviceControlToken.length >= 32 ? "Token konfiguriert" : "Token fehlt" },
    ],
    security: {
      lockedAccounts,
      activeSessions: Number(db.prepare("SELECT COUNT(*) AS count FROM portal_sessions WHERE revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP").get().count || 0),
      loginRateLimitActive: serverModeActive,
      secureCookies: serverModeActive,
      serviceControlConfigured: serviceControlToken.length >= 32,
    },
    warnings,
  };
}

app.get("/api/health", (_request, response) => {
  const diagnostics = serverDiagnostics();
  response.status(diagnostics.ready ? 200 : 503).json({
    ok: diagnostics.ready,
    app: APP_NAME,
    version: packageMetadata.version,
    mode: diagnostics.mode,
    database: diagnostics.database.integrity,
  });
});

app.post("/api/service/stop", (request, response) => {
  if (!serverModeActive || !isLoopbackRequest(request) || serviceControlToken.length < 32) {
    throw httpError(404, "Der Dienststeuerungs-Endpunkt ist nicht verfügbar.", "SERVICE_CONTROL_UNAVAILABLE");
  }
  const provided = String(request.headers["x-grabenplaner-service-token"] || "");
  const valid = provided.length === serviceControlToken.length
    && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(serviceControlToken));
  if (!valid) {
    auditPortal("service", "service.stop.denied", "system", "server");
    throw httpError(403, "Die Dienststeuerung wurde abgelehnt.", "SERVICE_CONTROL_DENIED");
  }
  response.json({ ok: true, message: "Der Grabenplaner-Dienst wird kontrolliert beendet." });
  response.on("finish", () => setTimeout(() => shutdown({ reason: "windows-service" }), 150));
});

app.get("/api/server-diagnostics", (request, response) => {
  requirePortalAdminOrLocal(request, "settings:write");
  response.json(serverDiagnostics());
});

function runtimeDriveInfo() {
  const root = path.parse(__dirname).root;
  const match = root.match(/^([a-z]):\\/i);
  if (!match) return { root, drive: null, canEject: false };
  const drive = `${match[1].toUpperCase()}:`;
  return {
    root,
    drive,
    canEject: process.platform === "win32" && drive !== "C:",
  };
}

const GITHUB_REPO = "christianseiwaldat-collab/Grabenplaner";

function normalizeVersionTag(value) {
  const text = String(value || "").trim().replace(/^v/i, "");
  const shortBeta = text.match(/^(\d+)\.(\d+)-beta$/i);
  if (shortBeta) return `${shortBeta[1]}.${shortBeta[2]}.0-beta`;
  return text;
}

function compareVersions(a, b) {
  const parse = (value) => normalizeVersionTag(value).replace(/-beta$/i, "").split(".").map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function releaseTagName(release) {
  return release?.tag_name || release?.tagName || "";
}

function selectLatestRelease(releases = []) {
  const candidates = releases
    .filter((release) => releaseTagName(release) && !release.draft && !release.isDraft)
    .sort((a, b) => {
      const versionOrder = compareVersions(releaseTagName(b), releaseTagName(a));
      if (versionOrder) return versionOrder;
      return new Date(b.published_at || b.publishedAt || b.created_at || b.createdAt || 0)
        - new Date(a.published_at || a.publishedAt || a.created_at || a.createdAt || 0);
    });
  return candidates[0] || null;
}

function findGhExecutable() {
  const candidates = [
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    path.join(os.homedir(), "AppData", "Local", "Programs", "GitHub CLI", "gh.exe"),
    ...(() => {
      try {
        return childProcess.execFileSync("where.exe", ["gh"], { encoding: "utf8", timeout: 3000 })
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    })(),
    "gh",
  ];
  return [...new Set(candidates)].find((candidate) => {
    try {
      childProcess.execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }) || null;
}

async function latestReleaseViaFetch() {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": `${APP_NAME}/${packageMetadata.version}`,
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`, { headers });
  if (response.status === 404) throw new Error("GitHub release not found");
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const release = selectLatestRelease(await response.json());
  if (!release) throw new Error("GitHub release not found");
  return {
    source: token ? "github-token" : "github-public",
    tagName: release.tag_name,
    url: release.html_url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    })),
  };
}

function latestReleaseViaGh() {
  const gh = findGhExecutable();
  if (!gh) throw new Error("GitHub CLI nicht gefunden oder nicht angemeldet.");
  const listOutput = childProcess.execFileSync(
    gh,
    ["release", "list", "--repo", GITHUB_REPO, "--limit", "20", "--json", "tagName,isDraft,isPrerelease,createdAt,publishedAt"],
    { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const selected = selectLatestRelease(JSON.parse(listOutput));
  if (!selected) throw new Error("release not found");
  const output = childProcess.execFileSync(
    gh,
    ["release", "view", selected.tagName, "--repo", GITHUB_REPO, "--json", "tagName,url,assets"],
    { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const release = JSON.parse(output);
  return {
    source: "gh",
    tagName: release.tagName,
    url: release.url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.url,
    })),
  };
}

async function getLatestReleaseInfo() {
  const errors = [];
  try {
    return await latestReleaseViaFetch();
  } catch (error) {
    errors.push(error.message);
  }
  try {
    return latestReleaseViaGh();
  } catch (error) {
    errors.push(error.message);
  }
  if (errors.some((message) => /release not found|GitHub release not found|HTTP 404/i.test(message))) {
    return {
      source: "none",
      tagName: packageMetadata.version,
      url: `https://github.com/${GITHUB_REPO}/releases`,
      assets: [],
    };
  }
  const failure = new Error(`Update-Check nicht möglich: ${errors.join(" · ")}`);
  failure.status = 503;
  throw failure;
}

async function buildUpdateStatus() {
  const latest = await getLatestReleaseInfo();
  const comparison = compareVersions(latest.tagName, packageMetadata.version);
  const asset = latest.assets.find((item) => /windows-portable\.zip$/i.test(item.name)) || latest.assets[0] || null;
  return {
    ok: true,
    currentVersion: packageMetadata.version,
    currentLabel: APP_VERSION_LABEL,
    latestVersion: normalizeVersionTag(latest.tagName),
    latestTag: latest.tagName,
    latestUrl: latest.url,
    source: latest.source,
    updateAvailable: comparison > 0,
    assetName: asset?.name || "",
    canAutoUpdate: Boolean(asset) && !serverModeActive,
    managementNote: serverModeActive ? "Serverupdates werden kontrolliert am Server durchgeführt." : "",
  };
}

app.get("/api/system-info", (request, response) => {
  const settings = getSettings();
  const privileged = !getPortalStatus().portalEnabled || request.portalSession?.permissions?.includes("system:write");
  const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
  const serverTime = new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Europe/Vienna",
  }).format(new Date());
  response.json({
    serverTime,
    timezone: "Europe/Vienna",
    nodeVersion: process.version,
    sqliteVersion,
    platform: `${os.type()} ${os.release()} · ${os.arch()}`,
    uptimeSeconds: Math.floor(process.uptime()),
    database: path.basename(databasePath),
    appBackupDirectory: privileged ? appBackupDirectory : "",
    backupDirectory: privileged ? backupDirectoryFromSettings(settings) : "",
    externalBackupEnabled: settingEnabled(settings, "external_backup_enabled"),
    backupIntervalHours: Number(settings.backup_interval_hours || 2),
    lastBackup: privileged ? lastBackup : null,
    adminContact: brandingFromSettings(settings).adminEmail,
    appName: brandingFromSettings(settings).appName,
    branding: brandingFromSettings(settings),
    appVersion: packageMetadata.version,
    appVersionLabel: APP_VERSION_LABEL,
    portal: getPortalStatus(),
    serverDiagnostics: privileged ? serverDiagnostics() : null,
    runtimeDrive: privileged ? runtimeDriveInfo() : null,
  });
});

app.get("/api/update-status", async (_request, response) => {
  response.json(await buildUpdateStatus());
});

app.post("/api/update-apply", async (_request, response) => {
  if (serverModeActive) throw httpError(409, "Im Serverbetrieb werden Updates kontrolliert am Server eingespielt.", "SERVER_MANAGED_UPDATE");
  if (fs.existsSync(path.join(__dirname, ".git"))) {
    throw httpError(409, "Ein Quellcode-Checkout wird nicht über den Portable-Updater überschrieben. Bitte die Aktualisierung mit Git durchführen.", "SOURCE_CHECKOUT_UPDATE_BLOCKED");
  }
  const status = await buildUpdateStatus();
  if (!status.updateAvailable) {
    response.json({ ok: true, message: "Grabenplaner ist bereits aktuell.", status });
    return;
  }
  const gh = findGhExecutable();
  if (!gh) {
    throw httpError(503, "Automatische Aktualisierung ist nur möglich, wenn die GitHub CLI auf diesem PC angemeldet ist. Deine Daten bleiben bei einem manuellen Update trotzdem erhalten.");
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-update-"));
  const scriptPath = path.join(tempRoot, "apply-update.ps1");
  const launcherPath = path.join(tempRoot, "launch-update.cmd");
  const safeAppDir = __dirname.replaceAll("'", "''");
  const safeParentDir = path.dirname(__dirname).replaceAll("'", "''");
  const safeGh = gh.replaceAll("'", "''");
  const safeTag = status.latestTag.replaceAll("'", "''");
  const safeRepo = GITHUB_REPO.replaceAll("'", "''");
  const safeVersionLabel = formatVersionLabel(status.latestVersion).replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
$appDir = '${safeAppDir}'
$parentDir = '${safeParentDir}'
$workDir = '${tempRoot.replaceAll("'", "''")}'
$gh = '${safeGh}'
$tag = '${safeTag}'
$repo = '${safeRepo}'
$versionLabel = '${safeVersionLabel}'
$pidToWait = ${process.pid}
$logPath = Join-Path $appDir 'data\\update-last.log'
function Write-UpdateLog([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}
try {
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
  Set-Content -LiteralPath $logPath -Value ("[{0}] Updater gestartet: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $versionLabel) -Encoding UTF8
  Write-UpdateLog "App-Verzeichnis: $appDir"
  Write-UpdateLog "GitHub CLI: $gh"
  Write-UpdateLog "Warte auf Server-Prozess $pidToWait ..."
  $deadline = (Get-Date).AddMinutes(2)
  while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw "Server-Prozess $pidToWait wurde nicht rechtzeitig beendet." }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Milliseconds 800
$zipDir = Join-Path $workDir 'download'
$extractDir = Join-Path $workDir 'extract'
New-Item -ItemType Directory -Path $zipDir,$extractDir -Force | Out-Null
Write-UpdateLog "Lade Release $tag ..."
$ghOutput = & $gh release download $tag --repo $repo --pattern '*windows-portable.zip' --dir $zipDir --clobber 2>&1
$ghExitCode = $LASTEXITCODE
$ghOutput | ForEach-Object { Write-UpdateLog "gh: $_" }
if ($ghExitCode -ne 0) { throw "GitHub-Download fehlgeschlagen: $ghExitCode" }
$zip = Get-ChildItem $zipDir -Filter '*.zip' | Select-Object -First 1
if (-not $zip) { throw 'Release-ZIP wurde nicht gefunden.' }
Write-UpdateLog "Entpacke $($zip.Name) ..."
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $extractDir -Force
$source = Join-Path $extractDir 'Grabenplaner'
if (-not (Test-Path (Join-Path $source 'server.js'))) { throw 'Entpackte Version ist unvollständig.' }
Write-UpdateLog "Kopiere neue App-Dateien ..."
  $robocopyOutput = & robocopy $source $appDir /MIR /XD '.git' 'data' 'backups' 'release' 'usb-backups' /XF '*.db' '*.db-shm' '*.db-wal' '*.log' /NFL /NDL /NJH /NJS /NP 2>&1
$robocopyExitCode = $LASTEXITCODE
$robocopyOutput | ForEach-Object { Write-UpdateLog "robocopy: $_" }
if ($robocopyExitCode -gt 7) { throw "Robocopy fehlgeschlagen: $robocopyExitCode" }
if ((Split-Path $appDir -Leaf) -eq 'app') {
  $rootStart = Join-Path $parentDir "Grabenplaner $versionLabel starten.cmd"
  "@echo off\`r\`ncd /d ""%~dp0app""\`r\`ncall ""Grabenplaner $versionLabel starten.cmd""\`r\`n" | Set-Content -LiteralPath $rootStart -Encoding Default
  "@echo off\`r\`ncd /d ""%~dp0app""\`r\`ncall ""Dienstplan starten.cmd""\`r\`n" | Set-Content -LiteralPath (Join-Path $parentDir 'Dienstplan starten.cmd') -Encoding Default
}
$startFile = Join-Path $appDir "Grabenplaner $versionLabel starten.cmd"
if (-not (Test-Path $startFile)) { $startFile = Join-Path $appDir 'Dienstplan starten.cmd' }
Write-UpdateLog "Starte neu: $startFile"
Start-Process -FilePath $startFile -WorkingDirectory $appDir
Start-Sleep -Seconds 3
Write-UpdateLog "Update erfolgreich abgeschlossen."
Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  try {
    Write-UpdateLog ("FEHLER: " + $_.Exception.Message)
    Write-UpdateLog ("Details: " + $_.ScriptStackTrace)
  } catch {}
  exit 1
}
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.writeFileSync(
    launcherPath,
    `@echo off\r\nstart "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`,
    "utf8",
  );
  response.json({
    ok: true,
    message: "Update wird geladen und installiert. Grabenplaner startet danach automatisch neu. Alle Datenbanken und Backups bleiben erhalten.",
    logPath: path.join(__dirname, "data", "update-last.log"),
    status,
  });
  setTimeout(() => {
    childProcess.spawn("cmd.exe", ["/d", "/c", launcherPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    setTimeout(shutdown, 1500);
  }, 100);
});

app.post("/api/backup", (_request, response) => {
  response.status(201).json(createDatabaseBackup("manual"));
});

function scheduleApplicationRestart() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-restart-"));
  const scriptPath = path.join(tempRoot, "restart-grabenplaner.ps1");
  const launcherPath = path.join(tempRoot, "launch-restart.cmd");
  const safeAppDir = __dirname.replaceAll("'", "''");
  const safeVersionLabel = APP_VERSION_LABEL.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
$appDir = '${safeAppDir}'
$versionLabel = '${safeVersionLabel}'
$pidToWait = ${process.pid}
$deadline = (Get-Date).AddMinutes(2)
while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {
  if ((Get-Date) -gt $deadline) { throw "Server-Prozess $pidToWait wurde nicht rechtzeitig beendet." }
  Start-Sleep -Milliseconds 300
}
Start-Sleep -Milliseconds 600
$startFile = Join-Path $appDir "Grabenplaner $versionLabel starten.cmd"
if (-not (Test-Path $startFile)) { $startFile = Join-Path $appDir 'Dienstplan starten.cmd' }
Start-Process -FilePath $startFile -WorkingDirectory $appDir
Start-Sleep -Seconds 2
Remove-Item -LiteralPath '${tempRoot.replaceAll("'", "''")}' -Recurse -Force -ErrorAction SilentlyContinue
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.writeFileSync(launcherPath, `@echo off\r\nstart "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`, "utf8");
  childProcess.spawn("cmd.exe", ["/d", "/c", launcherPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  setTimeout(shutdown, 900);
}

app.post("/api/system/restart", (_request, response) => {
  if (serverModeActive) throw httpError(409, "Der Serverbetrieb wird über den Serverdienst neu gestartet.", "SERVER_MANAGED_RESTART");
  const backup = createDatabaseBackup("restart");
  response.json({ ok: true, message: "Grabenplaner wird sicher neu gestartet.", backup });
  response.on("finish", () => setTimeout(scheduleApplicationRestart, 250));
});

app.post("/api/system/exit", (_request, response) => {
  if (serverModeActive) throw httpError(409, "Der Serverbetrieb wird über den Windows-Dienst beendet.", "SERVER_MANAGED_SHUTDOWN");
  const driveInfo = runtimeDriveInfo();
  let backup = null;
  try {
    backup = createDatabaseBackup("shutdown");
  } catch (error) {
    console.error("Backup beim Beenden konnte nicht erstellt werden:", error);
  }
  response.json({
    ok: true,
    message: "Grabenplaner wird sicher beendet. Bitte dieses Fenster danach schließen.",
    backup,
    drive: driveInfo.drive,
  });
  response.on("finish", () => setTimeout(() => shutdown({ reason: "api", skipBackup: true }), 350));
});

function scheduleBackupImport(importPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-db-import-"));
  const scriptPath = path.join(tempRoot, "apply-db-import.ps1");
  const launcherPath = path.join(tempRoot, "launch-db-import.cmd");
  const safeAppDir = __dirname.replaceAll("'", "''");
  const safeDatabasePath = databasePath.replaceAll("'", "''");
  const safeImportPath = importPath.replaceAll("'", "''");
  const safeTempRoot = tempRoot.replaceAll("'", "''");
  const safeVersionLabel = APP_VERSION_LABEL.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
$appDir = '${safeAppDir}'
$databasePath = '${safeDatabasePath}'
$importPath = '${safeImportPath}'
$workDir = '${safeTempRoot}'
$versionLabel = '${safeVersionLabel}'
$pidToWait = ${process.pid}
$logPath = Join-Path $appDir 'data\\import-last.log'
function Write-ImportLog([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}
try {
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
  Set-Content -LiteralPath $logPath -Value ("[{0}] Datenbank-Import gestartet" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
  Write-ImportLog "App-Verzeichnis: $appDir"
  Write-ImportLog "Warte auf Server-Prozess $pidToWait ..."
  $deadline = (Get-Date).AddMinutes(2)
  while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw "Server-Prozess $pidToWait wurde nicht rechtzeitig beendet." }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Milliseconds 800
  Remove-Item -LiteralPath "$databasePath-wal" -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$databasePath-shm" -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $importPath -Destination $databasePath -Force
  Remove-Item -LiteralPath $importPath -Force -ErrorAction SilentlyContinue
  $runtimeConfigPath = Join-Path $appDir 'data\runtime-config.json'
  '{"operationMode":"local"}' | Set-Content -LiteralPath $runtimeConfigPath -Encoding UTF8
  Write-ImportLog "Datenbank ersetzt."
  Write-ImportLog "Betriebsmodus aus Sicherheitsgründen auf Lokalbetrieb zurückgesetzt."
  $startFile = Join-Path $appDir "Grabenplaner $versionLabel starten.cmd"
  if (-not (Test-Path $startFile)) { $startFile = Join-Path $appDir 'Dienstplan starten.cmd' }
  Write-ImportLog "Starte neu: $startFile"
  Start-Process -FilePath $startFile -WorkingDirectory $appDir
  Start-Sleep -Seconds 3
  Write-ImportLog "Datenbank-Import erfolgreich abgeschlossen."
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  try {
    Write-ImportLog ("FEHLER: " + $_.Exception.Message)
    Write-ImportLog ("Details: " + $_.ScriptStackTrace)
  } catch {}
  exit 1
}
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.writeFileSync(
    launcherPath,
    `@echo off\r\nstart "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`,
    "utf8",
  );
  setTimeout(() => {
    childProcess.spawn("cmd.exe", ["/d", "/c", launcherPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    setTimeout(shutdown, 900);
  }, 450);
}

const brandingPreserveSettingKeys = [
  "branding_company_name",
  "branding_logo_url",
  "branding_icon_url",
  "branding_logo_alt",
  "branding_admin_email",
  "pdf_title",
  "pdf_filename_prefix",
  "pdf_filename_include_kw",
  "pdf_filename_include_timestamp",
  "vacation_pdf_title",
  "vacation_pdf_filename_prefix",
  "vacation_pdf_filename_include_period",
  "vacation_pdf_filename_include_timestamp",
  "vacation_pdf_show_balance",
  "vacation_pdf_balance_show_entitlement",
  "vacation_pdf_balance_show_planned",
  "vacation_pdf_balance_show_consumed",
  "vacation_pdf_calendar_style",
];

function currentBrandingSnapshot() {
  const placeholders = brandingPreserveSettingKeys.map(() => "?").join(",");
  return {
    settings: db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`).all(...brandingPreserveSettingKeys),
    pdfSettings: tableExists("pdf_settings")
      ? db.prepare(`
          SELECT scope_type, location_id, department_key, key, value
          FROM pdf_settings
          WHERE key IN (${placeholders})
        `).all(...brandingPreserveSettingKeys)
      : [],
    locationBranding: tableExists("location_branding")
      ? db.prepare(`
          SELECT location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by
          FROM location_branding ORDER BY location_id
        `).all()
      : [],
  };
}

function applyBrandingSnapshotToDatabase(importPath, snapshot) {
  const imported = new DatabaseSync(importPath);
  try {
    imported.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pdf_settings (
        scope_type TEXT NOT NULL,
        location_id TEXT NOT NULL,
        department_key TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (scope_type, location_id, department_key, key)
      );
      CREATE TABLE IF NOT EXISTS location_branding (
        location_id TEXT PRIMARY KEY,
        kit_id TEXT NOT NULL DEFAULT 'custom',
        company_name TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '/assets/grabenplaner-logo.svg',
        icon_url TEXT NOT NULL DEFAULT '/assets/webicon.svg',
        logo_alt TEXT NOT NULL DEFAULT 'Grabenplaner',
        admin_email TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (location_id) REFERENCES locations(id)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
    `);
    const updateSetting = imported.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const updatePdfSetting = imported.prepare(`
      INSERT INTO pdf_settings (scope_type, location_id, department_key, key, value, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scope_type, location_id, department_key, key)
      DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    const updateLocationBranding = imported.prepare(`
      INSERT INTO location_branding
        (location_id, kit_id, company_name, logo_url, icon_url, logo_alt, admin_email, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(location_id) DO UPDATE SET
        kit_id = excluded.kit_id,
        company_name = excluded.company_name,
        logo_url = excluded.logo_url,
        icon_url = excluded.icon_url,
        logo_alt = excluded.logo_alt,
        admin_email = excluded.admin_email,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `);
    imported.exec("BEGIN");
    try {
      for (const row of snapshot.settings || []) updateSetting.run(row.key, row.value);
      for (const row of snapshot.pdfSettings || []) {
        updatePdfSetting.run(row.scope_type, row.location_id, row.department_key || "", row.key, row.value);
      }
      imported.prepare("DELETE FROM location_branding").run();
      const importedLocationExists = imported.prepare("SELECT 1 FROM locations WHERE id = ?");
      for (const row of snapshot.locationBranding || []) {
        if (!importedLocationExists.get(row.location_id)) continue;
        updateLocationBranding.run(
          row.location_id, row.kit_id, row.company_name, row.logo_url, row.icon_url,
          row.logo_alt, row.admin_email, row.updated_by || "",
        );
      }
      imported.exec("COMMIT");
    } catch (error) {
      imported.exec("ROLLBACK");
      throw error;
    }
  } finally {
    imported.close();
  }
}

app.post("/api/backup/import", express.raw({ type: "application/octet-stream", limit: "200mb" }), (request, response) => {
  const currentAmuDocuments = tableExists("amu_documents")
    ? Number(db.prepare("SELECT COUNT(*) AS count FROM amu_documents WHERE status = 'active'").get().count || 0)
    : 0;
  if (currentAmuDocuments > 0) {
    throw httpError(409, "Diese Datenbank enthält geschützte AUM-Dokumente. Bitte Datenbank und AUM-Dateisicherung gemeinsam über die Wartungswerkzeuge wiederherstellen.", "AMU_FULL_RESTORE_REQUIRED");
  }
  if (serverModeActive) throw httpError(409, "Datenbankimporte sind im laufenden Serverbetrieb gesperrt und müssen in einem Wartungsfenster am Server durchgeführt werden.", "SERVER_MAINTENANCE_REQUIRED");
  if (!Buffer.isBuffer(request.body) || request.body.length < 1024) {
    throw httpError(400, "Bitte eine gültige Backup-Datei auswählen.");
  }
  fs.mkdirSync(dataDirectory, { recursive: true });
  const importPath = path.join(dataDirectory, `pending-import-${backupTimestamp()}.db`);
  fs.writeFileSync(importPath, request.body);
  let importedDatabase;
  let importedAmuDocuments = 0;
  try {
    importedDatabase = new DatabaseSync(importPath, { readOnly: true });
    importedDatabase.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    const hasAmuDocuments = importedDatabase.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'amu_documents'").get();
    if (hasAmuDocuments) importedAmuDocuments = Number(importedDatabase.prepare("SELECT COUNT(*) AS count FROM amu_documents WHERE status = 'active'").get().count || 0);
  } catch {
    fs.rmSync(importPath, { force: true });
    throw httpError(400, "Die ausgewählte Datei ist keine lesbare SQLite-Backup-Datei.");
  } finally {
    if (importedDatabase) importedDatabase.close();
  }
  if (importedAmuDocuments > 0) {
    fs.rmSync(importPath, { force: true });
    throw httpError(409, "Das ausgewählte Backup enthält geschützte AUM-Dokumente. Bitte die vollständige Datenbank- und AUM-Sicherung gemeinsam wiederherstellen.", "AMU_FULL_RESTORE_REQUIRED");
  }
  const preserveBranding = String(request.query.preserveBranding ?? "1") !== "0";
  if (preserveBranding) {
    applyBrandingSnapshotToDatabase(importPath, currentBrandingSnapshot());
  }
  const safetyBackup = createDatabaseBackup("before-import");
  response.status(202).json({
    ok: true,
    message: preserveBranding
      ? "Backup wurde übernommen, aktuelles Branding bleibt erhalten. Grabenplaner wird sicher neu gestartet."
      : "Backup wurde vollständig übernommen. Grabenplaner wird sicher neu gestartet.",
    safetyBackup,
    preserveBranding,
  });
  scheduleBackupImport(importPath);
});

app.get("/api/schedule", (request, response) => {
  response.json(getSchedule(request.query.week, request.query, request.portalSession));
});

app.put("/api/schedule-note", (request, response) => {
  const note = validateScheduleNote(request.body);
  assertSessionContextScope(request.portalSession, note.context);
  db.prepare(`
    INSERT INTO schedule_notes
      (location_id, department_key, week_start, note_text, note_html, font_size, bold, italic, underline, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(location_id, department_key, week_start)
    DO UPDATE SET
      note_text = excluded.note_text,
      note_html = excluded.note_html,
      font_size = excluded.font_size,
      bold = excluded.bold,
      italic = excluded.italic,
      underline = excluded.underline,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    note.context.locationId,
    pdfDepartmentKey(note.context),
    note.weekStart,
    note.noteText,
    note.noteHtml,
    note.fontSize,
    note.bold,
    note.italic,
    note.underline,
  );
  response.json({ scheduleNote: getScheduleNote(note.weekStart, note.context) });
});

app.delete("/api/schedule-note", (request, response) => {
  const weekStart = getMonday(isIsoDate(request.query.week) ? request.query.week : undefined);
  const context = resolvePlanningContext(request.query);
  assertSessionContextScope(request.portalSession, context);
  assertWeekEditable(weekStart, settingsForLocation(context.locationId));
  db.prepare("DELETE FROM schedule_notes WHERE location_id = ? AND department_key = ? AND week_start = ?")
    .run(context.locationId, pdfDepartmentKey(context), weekStart);
  response.status(204).end();
});

app.get("/api/locations", (request, response) => {
  response.json(getLocationsForSession(request.portalSession, true));
});

app.post("/api/locations", (request, response) => {
  const location = validateLocationPayload(request.body, true);
  try {
    db.prepare("INSERT INTO locations (id, name, min_staff, day_settings_json, time_tracking_enabled, active) VALUES (?, ?, ?, ?, ?, ?)")
      .run(location.id, location.name, location.minStaff, JSON.stringify(location.daySettings), location.timeTrackingEnabled, location.active);
    if (!sessionHasGlobalScope(request.portalSession)) {
      db.prepare(`
        INSERT OR IGNORE INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
        VALUES (?, ?, 0, ?)
      `).run(request.portalSession.employeeNumber, location.id, request.portalSession.employeeNumber);
      request.portalSession.scopes = [...(request.portalSession.scopes || []), { locationId: location.id, departmentId: null }];
    }
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Filial-ID ist bereits vergeben.");
    throw error;
  }
  response.status(201).json(getLocationsForSession(request.portalSession, true));
});

app.put("/api/locations/:id", (request, response) => {
  const id = normalizeLocationId(request.params.id);
  assertSessionLocationAdministrationScope(request.portalSession, id);
  const location = validateLocationPayload({ ...request.body, id }, false);
  const result = db.prepare("UPDATE locations SET name = ?, min_staff = ?, day_settings_json = ?, time_tracking_enabled = ?, active = ? WHERE id = ?")
    .run(location.name, location.minStaff, JSON.stringify(location.daySettings), location.timeTrackingEnabled, location.active, id);
  if (!result.changes) throw httpError(404, "Die Filiale wurde nicht gefunden.");
  response.json(getLocationsForSession(request.portalSession, true));
});

app.post("/api/departments", (request, response) => {
  const department = validateDepartmentPayload(request.body);
  const departmentManagerCreatingInAssignedLocation = request.portalSession?.role === "department_manager"
    && (request.portalSession.scopes || []).some((scope) => scope.locationId === department.locationId);
  if (!departmentManagerCreatingInAssignedLocation) {
    assertSessionContextScope(request.portalSession, { locationId: department.locationId });
  }
  try {
    const sortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM departments WHERE location_id = ?")
      .get(department.locationId).next;
    const result = db.prepare("INSERT INTO departments (location_id, name, min_staff, active, sort_order) VALUES (?, ?, ?, ?, ?)")
      .run(department.locationId, department.name, department.minStaff, department.active, sortOrder);
    if (departmentManagerCreatingInAssignedLocation) {
      db.prepare(`
        INSERT OR IGNORE INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
        VALUES (?, ?, ?, ?)
      `).run(request.portalSession.employeeNumber, department.locationId, Number(result.lastInsertRowid), request.portalSession.employeeNumber);
      request.portalSession.scopes = [...(request.portalSession.scopes || []), {
        locationId: department.locationId,
        departmentId: Number(result.lastInsertRowid),
      }];
    }
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Abteilung gibt es in der Filiale bereits.");
    throw error;
  }
  response.status(201).json(getLocationsForSession(request.portalSession, true));
});

app.put("/api/departments/:id", (request, response) => {
  const id = normalizeDepartmentId(request.params.id, false);
  const existing = validateDepartmentExists(id);
  assertSessionContextScope(request.portalSession, { locationId: existing.location_id, departmentId: id });
  const department = validateDepartmentPayload(request.body, id);
  assertSessionContextScope(request.portalSession, { locationId: department.locationId, departmentId: id });
  try {
    const result = db.prepare("UPDATE departments SET location_id = ?, name = ?, min_staff = ?, active = ? WHERE id = ?")
      .run(department.locationId, department.name, department.minStaff, department.active, id);
    if (!result.changes) throw httpError(404, "Die Abteilung wurde nicht gefunden.");
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Abteilung gibt es in der Filiale bereits.");
    throw error;
  }
  response.json(getLocationsForSession(request.portalSession, true));
});

function positionSlug(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function validatePositionPayload(body, existingId = null) {
  const name = String(body.name || "").trim();
  if (!name) throw httpError(400, "Bitte eine Position eingeben.");
  if (name.length > 60) throw httpError(400, "Die Position darf maximal 60 Zeichen lang sein.");
  const id = existingId || positionSlug(name);
  if (!id) throw httpError(400, "Die Position braucht einen gültigen Namen.");
  return { id, name };
}

app.get("/api/positions", (_request, response) => {
  response.json(getPositions());
});

app.post("/api/positions", (request, response) => {
  const position = validatePositionPayload(request.body);
  try {
    const sortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM positions").get().next;
    db.prepare("INSERT INTO positions (id, name, builtin, sort_order) VALUES (?, ?, 0, ?)")
      .run(position.id, position.name, sortOrder);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Position gibt es bereits.");
    throw error;
  }
  response.status(201).json(getPositions());
});

app.put("/api/positions/:id", (request, response) => {
  const id = String(request.params.id || "").trim();
  const existing = db.prepare("SELECT id, builtin FROM positions WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Position wurde nicht gefunden.");
  if (existing.builtin) throw httpError(403, "Diese Standardposition kann nicht bearbeitet werden.");
  const position = validatePositionPayload(request.body, id);
  try {
    db.prepare("UPDATE positions SET name = ? WHERE id = ?").run(position.name, id);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Position gibt es bereits.");
    throw error;
  }
  response.json(getPositions());
});

app.delete("/api/positions/:id", (request, response) => {
  const id = String(request.params.id || "").trim();
  const existing = db.prepare("SELECT id, builtin FROM positions WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Position wurde nicht gefunden.");
  if (existing.builtin) throw httpError(403, "Diese Standardposition kann nicht gelöscht werden.");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE employees SET position_id = 'verkaufsmitarbeiter' WHERE position_id = ?").run(id);
    db.prepare("DELETE FROM positions WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  response.status(204).end();
});

app.get("/api/employees", (request, response) => {
  const session = request.portalSession;
  let employees = db
      .prepare(`
        SELECT e.personnel_number, e.full_name, e.nickname, e.color, e.contracted_hours,
               e.preferred_day_off, e.fixed_workdays, e.position_id, e.home_location_id, e.preferred_department_id,
               e.active, l.name AS home_location_name, d.name AS preferred_department_name,
               p.name AS position_name
        FROM employees e
        LEFT JOIN locations l ON l.id = e.home_location_id
        LEFT JOIN departments d ON d.id = e.preferred_department_id
        LEFT JOIN positions p ON p.id = e.position_id
        ORDER BY e.active DESC, CAST(e.personnel_number AS INTEGER), e.personnel_number
      `)
      .all().map(serializeEmployee);
  if (!sessionHasGlobalScope(session)) {
    const locations = new Set((session.scopes || []).map((scope) => scope.locationId));
    const departments = new Set((session.scopes || []).map((scope) => Number(scope.departmentId || 0)).filter(Boolean));
    employees = employees.filter((employee) => locations.has(employee.home_location_id)
      && (session.role !== "department_manager" || departments.has(Number(employee.preferred_department_id || 0))));
  }
  response.json(employees);
});

app.post("/api/employees", (request, response) => {
  const employee = validateEmployee(request.body, true);
  assertSessionContextScope(request.portalSession, { locationId: employee.homeLocationId, departmentId: employee.preferredDepartmentId });
  try {
    db.prepare(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours, preferred_day_off, fixed_workdays,
         position_id, home_location_id, preferred_department_id, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      employee.personnelNumber,
      employee.fullName,
      employee.nickname,
      employee.color,
      employee.contractedHours,
      employee.preferredDayOff,
      employee.fixedWorkdays,
      employee.positionId,
      employee.homeLocationId,
      employee.preferredDepartmentId,
      employee.active,
    );
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Personalnummer ist bereits vergeben.");
    throw error;
  }
  response.status(201).json({ ...employee, active: Boolean(employee.active) });
});

app.put("/api/employees/:personnelNumber", (request, response) => {
  const personnelNumber = request.params.personnelNumber;
  assertSessionEmployeeScope(request.portalSession, personnelNumber);
  const employee = validateEmployee({ ...request.body, personnelNumber }, false);
  assertSessionContextScope(request.portalSession, { locationId: employee.homeLocationId, departmentId: employee.preferredDepartmentId });
  const result = db.prepare(`
    UPDATE employees
    SET full_name = ?, nickname = ?, color = ?, contracted_hours = ?, preferred_day_off = ?, fixed_workdays = ?,
        position_id = ?, home_location_id = ?, preferred_department_id = ?, active = ?
    WHERE personnel_number = ?
  `).run(
    employee.fullName,
    employee.nickname,
    employee.color,
    employee.contractedHours,
    employee.preferredDayOff,
    employee.fixedWorkdays,
    employee.positionId,
    employee.homeLocationId,
    employee.preferredDepartmentId,
    employee.active,
    personnelNumber,
  );
  if (!result.changes) throw httpError(404, "Die Person wurde nicht gefunden.");
  response.json({ ...employee, personnelNumber, active: Boolean(employee.active) });
});

app.delete("/api/employees/:personnelNumber", (request, response) => {
  assertSessionEmployeeScope(request.portalSession, request.params.personnelNumber);
  const result = db.prepare("DELETE FROM employees WHERE personnel_number = ?").run(request.params.personnelNumber);
  if (!result.changes) throw httpError(404, "Die Person wurde nicht gefunden.");
  response.status(204).end();
});

app.get(["/api/portal/status", "/api/portal/v1/status"], (_request, response) => {
  response.json(getPortalStatus());
});

app.get("/api/portal/v1/roles", (_request, response) => {
  response.json({ apiVersion: PORTAL_API_VERSION, roles: getPortalRoles() });
});

app.get("/api/portal/v1/workflow-settings", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "vacation:read");
  response.json({
    vacationHrApprovalRequired: vacationHrApprovalRequired(),
    canChange: session.employeeNumber === "local" || session.role === "admin" || session.permissions?.includes("hr:settings"),
  });
});

app.put("/api/portal/v1/workflow-settings", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "hr:settings");
  const required = request.body.vacationHrApprovalRequired === true;
  if (required) {
    const hr = db.prepare("SELECT 1 FROM portal_users WHERE role = 'hr' AND active = 1 AND TRIM(password_hash) <> '' LIMIT 1").get();
    if (!hr) throw httpError(409, "Bitte zuerst mindestens einen aktiven Zugang mit der Rolle Personalleitung einrichten.");
  }
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES ('vacation_hr_approval_required', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(required ? "1" : "0");
  auditPortal(session.employeeNumber, "workflow.settings.update", "portal_settings", "vacation_hr_approval_required", required ? "1" : "0");
  response.json({ vacationHrApprovalRequired: required, canChange: true });
});

function approvalDelegations() {
  return db.prepare(`
    SELECT d.*, l.name AS location_name, e.full_name, e.nickname
    FROM approval_delegations d JOIN locations l ON l.id = d.location_id
    JOIN employees e ON e.personnel_number = d.delegate_employee_number
    ORDER BY d.active DESC, d.date_from DESC, d.id DESC
  `).all().map((row) => ({ ...row, active: Boolean(row.active) }));
}

app.get("/api/portal/v1/approval-delegations", (request, response) => {
  requirePortalAdminOrLocal(request, "vacation:read");
  response.json({ delegations: approvalDelegations() });
});

app.post("/api/portal/v1/approval-delegations", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "settings:write");
  const locationId = normalizeLocationId(request.body.locationId);
  const employeeNumber = String(request.body.employeeNumber || "").trim();
  const dateFrom = String(request.body.dateFrom || "");
  const dateTo = String(request.body.dateTo || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 240);
  validateLocationExists(locationId);
  const delegate = db.prepare(`
    SELECT e.personnel_number FROM employees e JOIN portal_users u ON u.employee_number = e.personnel_number
    WHERE e.personnel_number = ? AND e.home_location_id = ? AND u.role = 'department_manager' AND u.active = 1
  `).get(employeeNumber, locationId);
  if (!delegate) throw httpError(400, "Bitte eine aktive Abteilungsleitung dieser Filiale auswählen.");
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) throw httpError(400, "Bitte einen gültigen Vertretungszeitraum eingeben.");
  db.prepare(`INSERT INTO approval_delegations (location_id, delegate_employee_number, date_from, date_to, note, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(locationId, employeeNumber, dateFrom, dateTo, note, session.employeeNumber);
  response.status(201).json({ delegations: approvalDelegations() });
});

app.delete("/api/portal/v1/approval-delegations/:id", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "settings:write");
  const result = db.prepare("DELETE FROM approval_delegations WHERE id = ?").run(Number(request.params.id));
  if (!result.changes) throw httpError(404, "Die Vertretung wurde nicht gefunden.");
  auditPortal(session.employeeNumber, "approval_delegation.delete", "approval_delegation", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/session", (request, response) => {
  const publicStatus = getPortalStatus();
  const session = publicStatus.portalEnabled ? portalSessionFromRequest(request) : null;
  const status = session?.homeLocationId ? getPortalStatus(session.homeLocationId) : publicStatus;
  if (session && !parseCookies(request)[PORTAL_CSRF_COOKIE]) {
    appendCookie(response, portalCookie(PORTAL_CSRF_COOKIE, crypto.randomBytes(24).toString("base64url"), request, {
      maxAge: Math.max(60, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)),
    }));
  }
  response.json({
    apiVersion: PORTAL_API_VERSION,
    authenticated: Boolean(session),
    loginRequired: status.loginRequired,
    user: publicPortalUser(session),
    status,
  });
});

app.post("/api/portal/v1/setup/admin", async (request, response) => {
  if (!isLoopbackRequest(request)) throw httpError(403, "Die Admin-Ersteinrichtung ist nur direkt am Grabenplaner-PC möglich.");
  if (getPortalStatus().adminSetupState === "configured") throw httpError(409, "Die Admin-Ersteinrichtung wurde bereits abgeschlossen.");
  const employeeNumber = String(request.body.employeeNumber || "").trim();
  const employee = db.prepare("SELECT personnel_number, full_name FROM employees WHERE personnel_number = ? AND active = 1").get(employeeNumber);
  if (!employee) throw httpError(404, "Das ausgewählte aktive Teammitglied wurde nicht gefunden.");
  const passwordHash = await hashPortalPassword(request.body.password);
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, ?, 'admin', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = excluded.password_hash, role = 'admin', active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, passwordHash);
  auditPortal(employeeNumber, "portal.admin.setup", "portal_user", employeeNumber);
  response.status(201).json({ ok: true, status: getPortalStatus() });
});

app.post("/api/portal/v1/auth/login", async (request, response) => {
  if (!getPortalStatus().portalEnabled) return sendPortalInactive(request, response);
  assertLoginRateLimit(request);
  const employeeNumber = String(request.body.employeeNumber || "").trim();
  const user = db.prepare(`
    SELECT u.employee_number, u.password_hash, u.active, u.failed_login_attempts, u.locked_until,
           e.active AS employee_active
    FROM portal_users u JOIN employees e ON e.personnel_number = u.employee_number
    WHERE u.employee_number = ?
  `).get(employeeNumber);
  const now = new Date();
  if (user?.locked_until && new Date(user.locked_until) > now) {
    throw httpError(429, "Der Zugang ist vorübergehend gesperrt. Bitte später erneut versuchen.", "PORTAL_ACCOUNT_LOCKED");
  }
  const valid = Boolean(user?.active && user?.employee_active && user.password_hash)
    && await verifyPortalPassword(request.body.password, user.password_hash);
  if (!valid) {
    registerFailedLogin(request);
    if (user) {
      const portalSettings = getPortalSettings();
      const attempts = Number(user.failed_login_attempts || 0) + 1;
      const maximum = Number(portalSettings.max_failed_login_attempts || 5);
      const lockUntil = attempts >= maximum
        ? new Date(now.getTime() + Number(portalSettings.account_lock_minutes || 15) * 60000).toISOString()
        : null;
      db.prepare("UPDATE portal_users SET failed_login_attempts = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP WHERE employee_number = ?")
        .run(lockUntil ? 0 : attempts, lockUntil, employeeNumber);
    }
    auditPortal(employeeNumber, "portal.login.failed", "portal_user", employeeNumber, `ip=${loginRateKey(request)}`);
    throw httpError(401, "Personalnummer oder Passwort ist nicht korrekt.", "PORTAL_LOGIN_FAILED");
  }
  db.prepare("DELETE FROM portal_sessions WHERE expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL").run();
  clearLoginRate(request);
  db.prepare("UPDATE portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND revoked_at IS NULL").run(employeeNumber);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const timeoutMinutes = Math.min(1440, Math.max(15, Number(getPortalSettings().session_timeout_minutes || 480)));
  const expiresAt = new Date(now.getTime() + timeoutMinutes * 60000).toISOString();
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(crypto.randomUUID(), employeeNumber, sha256(rawToken), expiresAt);
  db.prepare(`
    UPDATE portal_users SET failed_login_attempts = 0, locked_until = NULL,
      last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(employeeNumber);
  appendCookie(response, portalCookie(PORTAL_SESSION_COOKIE, rawToken, request, { httpOnly: true, maxAge: timeoutMinutes * 60 }));
  appendCookie(response, portalCookie(PORTAL_CSRF_COOKIE, csrfToken, request, { maxAge: timeoutMinutes * 60 }));
  const session = portalSessionFromRequest({ ...request, headers: { ...request.headers, cookie: `${PORTAL_SESSION_COOKIE}=${rawToken}` } }, { touch: false });
  auditPortal(employeeNumber, "portal.login.success", "portal_user", employeeNumber, `ip=${loginRateKey(request)}`);
  response.json({ ok: true, authenticated: true, user: publicPortalUser(session), status: getPortalStatus(session?.homeLocationId || "") });
});

app.post("/api/portal/v1/auth/logout", (request, response) => {
  const session = portalSessionFromRequest(request, { touch: false });
  if (session) {
    assertPortalCsrf(request);
    db.prepare("UPDATE portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);
    auditPortal(session.employeeNumber, "portal.logout", "portal_user", session.employeeNumber);
  }
  clearPortalCookies(request, response);
  response.json({ ok: true });
});

function rightsManagementPayload() {
  const roles = new Map(getPortalRoles().map((role) => [role.id, role]));
  const users = portalUsersForAdmin()
    .filter((user) => ["manager", "department_manager"].includes(user.role))
    .map((user) => {
      const rolePermissions = roles.get(user.role)?.permissions || [];
      return {
        ...user,
        rolePermissions,
        effectivePermissions: [...new Set([...rolePermissions, ...(user.grantedPermissions || [])])],
      };
    });
  return {
    catalog: delegablePortalPermissionCatalog,
    users,
  };
}

app.get("/api/portal/v1/rights", (request, response) => {
  requireAdminHrOrLocal(request, "rights:read");
  response.json(rightsManagementPayload());
});

app.put("/api/portal/v1/rights/:employeeNumber", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "rights:write");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  const target = db.prepare("SELECT role FROM portal_users WHERE employee_number = ? AND active = 1").get(employeeNumber);
  if (!target) throw httpError(404, "Der aktive Portal-Zugang wurde nicht gefunden.");
  if (!["manager", "department_manager"].includes(target.role)) {
    throw httpError(403, "Zusätzliche Rechte können nur Filial- oder Abteilungsleitungen erhalten.", "PORTAL_PERMISSION_DENIED");
  }
  if (!Array.isArray(request.body.permissions)) throw httpError(400, "Bitte eine gültige Rechteauswahl übermitteln.");
  const submitted = [...new Set(request.body.permissions.map((value) => String(value || "").trim()).filter(Boolean))];
  const invalid = submitted.filter((permission) => !delegablePortalPermissions.has(permission));
  if (invalid.length) {
    throw httpError(400, `Diese Rechte dürfen nicht delegiert werden: ${invalid.join(", ")}`, "PORTAL_PERMISSION_NOT_DELEGABLE");
  }
  const before = portalPermissionGrantsForEmployee(employeeNumber);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ?").run(employeeNumber);
    const insert = db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `);
    for (const permission of submitted) insert.run(employeeNumber, permission, actor.employeeNumber);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  auditPortal(actor.employeeNumber, "portal.rights.update", "portal_user", employeeNumber, JSON.stringify({ before, after: submitted }));
  response.json(rightsManagementPayload());
});

app.get("/api/portal/v1/users", (request, response) => {
  const actor = requirePortalAnyPermission(request, ["users:write", "scopes:write"]);
  response.json({ users: portalUsersForActor(actor), roles: getPortalRoles() });
});

app.put("/api/portal/v1/users/:employeeNumber/scopes", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "scopes:write");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  const target = db.prepare(`SELECT u.role, e.home_location_id FROM portal_users u JOIN employees e ON e.personnel_number = u.employee_number WHERE u.employee_number = ?`).get(employeeNumber);
  if (!target) throw httpError(404, "Der Zugang wurde nicht gefunden.");
  if (!["manager", "department_manager"].includes(target.role)) throw httpError(400, "Nur Filial- und Abteilungsleitungen benötigen eine Bereichszuweisung.");
  const submitted = Array.isArray(request.body.scopes) ? request.body.scopes : [];
  const scopes = submitted.map((scope) => ({
    locationId: normalizeLocationId(scope.locationId),
    departmentId: normalizeDepartmentId(scope.departmentId, true),
  }));
  if (!scopes.length) throw httpError(400, "Bitte mindestens einen Bereich zuweisen.");
  for (const scope of scopes) {
    validateLocationExists(scope.locationId);
    if (target.role === "department_manager") {
      if (!scope.departmentId) throw httpError(400, "Für eine Abteilungsleitung muss eine Abteilung ausgewählt werden.");
      validateDepartmentExists(scope.departmentId, scope.locationId);
    } else scope.departmentId = null;
    if (actor.role === "manager") assertSessionContextScope(actor, { locationId: scope.locationId });
    if (actor.role === "manager" && target.home_location_id !== scope.locationId) throw httpError(403, "Die Abteilungsleitung gehört nicht zum eigenen Standort.");
  }
  if (actor.role === "manager" && target.role !== "department_manager") throw httpError(403, "Eine Filialleitung darf nur Abteilungsleitungen ihres Standorts zuweisen.");
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(employeeNumber);
    const insert = db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES (?, ?, ?, ?)");
    for (const scope of scopes) insert.run(employeeNumber, scope.locationId, scope.departmentId || 0, actor.employeeNumber);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  auditPortal(actor.employeeNumber, "portal.scope.update", "portal_user", employeeNumber, JSON.stringify(scopes));
  response.json({ users: portalUsersForActor(actor), roles: getPortalRoles() });
});

app.put("/api/portal/v1/users/:employeeNumber", async (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "users:write");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  if (!db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(employeeNumber)) {
    throw httpError(404, "Das Teammitglied wurde nicht gefunden.");
  }
  const role = String(request.body.role || "employee");
  if (!db.prepare("SELECT 1 FROM portal_roles WHERE id = ?").get(role)) throw httpError(400, "Die ausgewählte Rolle ist ungültig.");
  if (actor.role === "hr" && !["employee", "manager", "department_manager"].includes(role)) {
    throw httpError(403, "Die Personalleitung darf keine Admin- oder Personalleitungsrollen vergeben.");
  }
  if (actor.role === "hr") {
    const existingRole = db.prepare("SELECT role FROM portal_users WHERE employee_number = ?").get(employeeNumber)?.role;
    if (["admin", "hr"].includes(existingRole)) throw httpError(403, "Dieser globale Zugang kann nur von einem Admin geändert werden.");
  }
  const password = String(request.body.password || "");
  const existing = db.prepare("SELECT password_hash FROM portal_users WHERE employee_number = ?").get(employeeNumber);
  const passwordHash = password ? await hashPortalPassword(password) : existing?.password_hash || "";
  const active = request.body.active !== false ? 1 : 0;
  if (role === "admin" && !active) {
    const otherAdmins = Number(db.prepare("SELECT COUNT(*) AS count FROM portal_users WHERE role = 'admin' AND active = 1 AND employee_number <> ?").get(employeeNumber).count);
    if (!otherAdmins) throw httpError(409, "Mindestens ein aktiver Admin-Zugang muss bestehen bleiben.");
  }
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? <> '' THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = excluded.password_hash, role = excluded.role, active = excluded.active,
      must_change_password = excluded.must_change_password,
      password_changed_at = CASE WHEN ? <> '' THEN CURRENT_TIMESTAMP ELSE portal_users.password_changed_at END,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, passwordHash, role, active, password ? 1 : Number(request.body.mustChangePassword !== false), password, password);
  if (!["manager", "department_manager"].includes(role)) {
    db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ?").run(employeeNumber);
  }
  if (!active || password) db.prepare("UPDATE portal_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE employee_number = ? AND revoked_at IS NULL").run(employeeNumber);
  auditPortal(actor.employeeNumber, "portal.user.update", "portal_user", employeeNumber, JSON.stringify({ role, active: Boolean(active), passwordReset: Boolean(password) }));
  response.json({ users: portalUsersForAdmin(), roles: getPortalRoles() });
});

app.post("/api/portal/v1/users/:employeeNumber/unlock", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "users:write");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  const result = db.prepare(`
    UPDATE portal_users SET failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(employeeNumber);
  if (!result.changes) throw httpError(404, "Der Zugang wurde nicht gefunden.");
  auditPortal(actor.employeeNumber, "portal.user.unlock", "portal_user", employeeNumber);
  response.json({ users: portalUsersForAdmin(), roles: getPortalRoles() });
});

app.get("/api/portal/v1/me", (request, response) => {
  const session = requirePortalSession(request);
  response.json({ user: publicPortalUser(session), branding: brandingForLocation(session.homeLocationId) });
});

app.put("/api/portal/v1/me/password", async (request, response) => {
  const session = requirePortalSession(request);
  assertPortalCsrf(request);
  const current = db.prepare("SELECT password_hash FROM portal_users WHERE employee_number = ?").get(session.employeeNumber);
  if (!await verifyPortalPassword(request.body.currentPassword, current?.password_hash)) {
    throw httpError(401, "Das bisherige Passwort ist nicht korrekt.");
  }
  const passwordHash = await hashPortalPassword(request.body.newPassword);
  db.prepare(`
    UPDATE portal_users SET password_hash = ?, must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(passwordHash, session.employeeNumber);
  auditPortal(session.employeeNumber, "portal.password.change", "portal_user", session.employeeNumber);
  response.json({ ok: true });
});

app.get("/api/portal/v1/me/schedule", (request, response) => {
  const session = requirePortalSession(request, "own_schedule:read");
  const weekStart = getMonday(isIsoDate(request.query.week) ? request.query.week : currentWeekStart());
  const weekEnd = addDays(weekStart, 6);
  const shifts = db.prepare(`
    SELECT s.id, s.shift_date, s.start_time, s.end_time, s.area, s.note,
           d.name AS department_name
    FROM shifts s LEFT JOIN departments d ON d.id = s.department_id
    WHERE s.employee_number = ? AND s.shift_date BETWEEN ? AND ?
    ORDER BY s.shift_date, s.start_time
  `).all(session.employeeNumber, weekStart, weekEnd);
  const options = db.prepare(`
    SELECT id, date_from, date_to, option_type, note, all_day, start_time, end_time
    FROM week_options
    WHERE employee_number = ? AND date_from <= ? AND date_to >= ?
    ORDER BY date_from, id
  `).all(session.employeeNumber, weekEnd, weekStart);
  response.json({ weekStart, weekEnd, calendarWeek: getIsoWeek(weekStart), shifts, options, user: publicPortalUser(session) });
});

app.get(["/api/portal/v1/me/absence-history", "/api/portal/v1/me/absence-requests"], (request, response) => {
  const session = requirePortalSession(request, "own_vacation:read");
  response.json({ items: absenceHistoryForEmployee(session.employeeNumber) });
});

app.get("/api/portal/v1/me/notifications", (request, response) => {
  const session = requirePortalSession(request);
  const notifications = db.prepare(`
    SELECT id, event_type, title, message, target, entity_type, entity_id, read_at, created_at
    FROM portal_notifications WHERE recipient_employee_number = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 100
  `).all(session.employeeNumber).map((item) => ({ ...item, link: item.target, request_id: item.entity_id || null }));
  const unreadCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications
    WHERE recipient_employee_number = ? AND read_at IS NULL
  `).get(session.employeeNumber).count || 0);
  response.json({ notifications, unreadCount });
});

app.put("/api/portal/v1/me/notifications/:id/read", (request, response) => {
  const session = requirePortalSession(request);
  assertPortalCsrf(request);
  const result = db.prepare(`
    UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND recipient_employee_number = ?
  `).run(String(request.params.id), session.employeeNumber);
  if (!result.changes) throw httpError(404, "Die Benachrichtigung wurde nicht gefunden.");
  response.json({ ok: true });
});

app.put("/api/portal/v1/me/notifications/read-all", (request, response) => {
  const session = requirePortalSession(request);
  assertPortalCsrf(request);
  const result = db.prepare(`
    UPDATE portal_notifications SET read_at = CURRENT_TIMESTAMP
    WHERE recipient_employee_number = ? AND read_at IS NULL
  `).run(session.employeeNumber);
  response.json({ ok: true, updated: Number(result.changes || 0) });
});

app.get("/api/portal/v1/amu-settings", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "own_amu:read");
  response.json({
    policy: getAmuPolicy(),
    canChange: session.employeeNumber === "local" || ["admin", "hr"].includes(session.role) || session.permissions?.includes("hr:settings"),
  });
});

app.put("/api/portal/v1/amu-settings", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "hr:settings");
  const policy = validateAmuPolicy(request.body || {});
  const entries = {
    amu_upload_max_mb: String(policy.uploadMaxMb),
    amu_stored_max_mb: String(policy.storedMaxMb),
    amu_convert_images_to_pdf: policy.convertImagesToPdf ? "1" : "0",
    amu_grayscale_images: policy.grayscaleImages ? "1" : "0",
    amu_manager_file_access: policy.managerFileAccess ? "1" : "0",
  };
  const upsert = db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(entries)) upsert.run(key, value);
    auditPortal(session.employeeNumber, "amu.settings.update", "portal_settings", "amu", JSON.stringify(policy));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  response.json({ policy, canChange: true });
});

app.get("/api/portal/v1/personnel-records/:employeeNumber", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:metadata:read");
  const employeeNumber = String(request.params.employeeNumber || "").trim();
  assertSessionEmployeeScope(session, employeeNumber);
  const employee = db.prepare(`
    SELECT e.personnel_number, e.full_name, e.nickname, e.color, e.home_location_id,
           e.preferred_department_id, l.name AS home_location_name, d.name AS preferred_department_name
    FROM employees e LEFT JOIN locations l ON l.id = e.home_location_id
    LEFT JOIN departments d ON d.id = e.preferred_department_id
    WHERE e.personnel_number = ?
  `).get(employeeNumber);
  if (!employee) throw httpError(404, "Das Teammitglied wurde nicht gefunden.", "EMPLOYEE_NOT_FOUND");
  let reports = db.prepare(`
    SELECT r.*, e.full_name, e.nickname, e.color, e.preferred_department_id,
           l.name AS location_name, d.name AS department_name
    FROM amu_reports r JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.employee_number = ? AND r.status <> 'purged'
    ORDER BY r.incapacity_from DESC, r.id DESC
  `).all(employeeNumber);
  if (session.role === "manager") {
    const allowedLocations = new Set((session.scopes || []).map((scope) => scope.locationId));
    reports = reports.filter((report) => allowedLocations.has(report.location_id));
  } else if (session.role === "department_manager") {
    const allowed = new Set((session.scopes || []).map((scope) => `${scope.locationId}:${Number(scope.departmentId || 0)}`));
    reports = reports.filter((report) => report.department_id != null
      && allowed.has(`${report.location_id}:${Number(report.department_id)}`));
  }
  const serialized = serializeAmuReports(reports);
  const canOpenFiles = actorCanReadAmuFiles(session);
  if (!canOpenFiles) {
    for (const report of serialized) {
      report.employee_note = "";
      report.review_note = "";
      report.documents = report.documents.map(({ id, detected_mime, size, byte_size, scan_status, status, created_at }, index) => ({
        id, original_name: `Dokument ${index + 1}`, original_filename: `Dokument ${index + 1}`, detected_mime, size, byte_size,
        scan_status, status, created_at, content_access: false,
      }));
    }
  }
  response.json({ employee, reports: serialized, canOpenFiles });
});

app.get("/api/portal/v1/me/amu-reports", (request, response) => {
  const session = requirePortalSession(request, "own_amu:read");
  response.json({ reports: ownAmuReports(session.employeeNumber) });
});

app.post("/api/portal/v1/me/amu-reports", async (request, response) => {
  const session = requirePortalSession(request, "own_amu:create");
  assertPortalCsrf(request);
  if (shutdownStarted) throw httpError(503, "Grabenplaner wird gerade sicher beendet. Bitte den Upload danach erneut versuchen.", "SERVER_SHUTTING_DOWN");
  const storage = requireAmuStorage();
  const policy = getAmuPolicy();
  const maxInputBytes = Math.round(policy.uploadMaxMb * 1024 * 1024);
  const maxStoredBytes = Math.round(policy.storedMaxMb * 1024 * 1024);
  const { fields, documents } = await parseAmuMultipart(request, {
    maxFileBytes: maxInputBytes,
    totalMaxBytes: (maxInputBytes * 3) + (1024 * 1024),
  });
  const incapacityFrom = String(fields.incapacityFrom || "");
  const incapacityTo = String(fields.incapacityTo || "");
  const employeeNote = stripEmoji(String(fields.employeeNote || "").trim()).slice(0, 500);
  if (!isIsoDate(incapacityFrom) || !isIsoDate(incapacityTo) || incapacityTo < incapacityFrom) {
    throw httpError(400, "Bitte einen gültigen Zeitraum der Arbeitsunfähigkeit eingeben.", "AMU_DATE_INVALID");
  }
  if (!documents.length || documents.length > 3) {
    throw httpError(400, "Bitte mindestens eine und höchstens drei PDF- oder Bilddateien auswählen.", "AMU_DOCUMENTS_REQUIRED");
  }
  const context = employeeRequestContext(session.employeeNumber, incapacityFrom);
  const retentionDays = Math.min(3650, Math.max(30, Number(getPortalSettings().amu_retention_days || 730)));
  const saved = [];
  let committed = false;
  amuMutationInProgress += 1;
  try {
    for (const document of documents) {
      const prepared = await prepareAmuDocument({
        buffer: document.buffer,
        originalName: document.originalName,
        convertImagesToPdf: policy.convertImagesToPdf,
        grayscale: policy.grayscaleImages,
        maxInputBytes,
        maxStoredBytes,
        scanOriginal: policy.convertImagesToPdf ? (input) => storage.scanBuffer(input) : null,
      });
      const stored = await storage.saveBuffer({
        buffer: prepared.buffer,
        originalName: prepared.originalFilename,
        maxBytes: maxStoredBytes,
      });
      saved.push({ ...stored, processing: prepared.processing, converted: prepared.converted, sourceMime: prepared.sourceMime });
    }
    db.exec("BEGIN");
    try {
      const reportResult = db.prepare(`
        INSERT INTO amu_reports
          (employee_number, location_id, department_id, incapacity_from, incapacity_to, employee_note, status, retention_until)
        VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)
      `).run(session.employeeNumber, context.locationId, context.departmentId, incapacityFrom, incapacityTo, storage.protectText(employeeNote), addDays(incapacityTo, retentionDays));
      const reportId = Number(reportResult.lastInsertRowid);
      const insertDocument = db.prepare(`
        INSERT INTO amu_documents
          (id, report_id, storage_key, original_filename, detected_mime, byte_size, sha256, scan_status,
           encryption_key_id, encryption_iv, encryption_tag, status, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 'active', ?)
      `);
      for (const item of saved) {
        const documentId = crypto.randomUUID();
        insertDocument.run(documentId, reportId, item.storageKey, storage.protectText(item.originalFilename), item.detectedMime,
          item.byteSize, item.sha256, item.scanStatus, item.encryptionKeyId, session.employeeNumber);
        auditPortal(session.employeeNumber, "amu.document.upload", "amu_document", documentId,
          JSON.stringify({ reportId, mime: item.detectedMime, sourceMime: item.sourceMime, converted: item.converted, size: item.byteSize, scan: item.scanStatus, processing: item.processing }));
      }
      auditPortal(session.employeeNumber, "amu.report.create", "amu_report", String(reportId), JSON.stringify({ locationId: context.locationId, documentCount: saved.length }));
      db.exec("COMMIT");
      committed = true;
      const report = amuReportMetadata(reportId);
      const recipients = new Set([
        ...requestReviewerRecipients(context.locationId, context.departmentId, "local", session.employeeNumber),
        ...requestReviewerRecipients(context.locationId, context.departmentId, "hr", session.employeeNumber),
      ]);
      for (const recipient of recipients) {
        createPortalNotification(recipient, "amu.submitted", "Neue Arbeitsunfähigkeitsmeldung", `${session.employeeNumber} hat eine AUM hochgeladen.`, {
          target: "/?view=requests&kind=amu",
          entityType: "amu_report",
          entityId: reportId,
          dedupeKey: `amu:${reportId}:submitted`,
        });
      }
      response.status(201).json({ report: serializeAmuReports([report])[0] });
    } catch (error) {
      if (!committed) db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (!committed) {
      for (const item of saved) {
        try { storage.deleteBlob(item.storageKey); } catch {}
      }
    }
    if (error.code?.startsWith?.("AMU_")) {
      const status = error.code.includes("TOO_LARGE") || error.code.includes("LIMIT")
        ? 413
        : error.code.includes("TYPE") || error.code.includes("HEIC") ? 415 : 400;
      throw httpError(status, error.message, error.code);
    }
    throw error;
  } finally {
    amuMutationInProgress = Math.max(0, amuMutationInProgress - 1);
  }
});

app.post("/api/portal/v1/me/amu-reports/:id/withdraw", (request, response) => {
  const session = requirePortalSession(request, "own_amu:withdraw");
  assertPortalCsrf(request);
  const report = db.prepare(`
    SELECT * FROM amu_reports WHERE id = ? AND employee_number = ? AND status IN ('submitted','returned')
  `).get(Number(request.params.id), session.employeeNumber);
  if (!report) throw httpError(404, "Die offene Arbeitsunfähigkeitsmeldung wurde nicht gefunden.", "AMU_REPORT_NOT_FOUND");
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE amu_reports SET status = 'withdrawn', withdrawn_at = CURRENT_TIMESTAMP,
        retention_until = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(addDays(viennaTodayIso(), 30), report.id);
    db.prepare("UPDATE amu_documents SET status = 'deleted', deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE report_id = ? AND status = 'active'")
      .run(session.employeeNumber, report.id);
    auditPortal(session.employeeNumber, "amu.report.withdraw", "amu_report", String(report.id));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  db.prepare("UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE entity_type = 'amu_report' AND entity_id = ?")
    .run(String(report.id));
  response.json({ ok: true });
});

app.get("/api/portal/v1/me/amu-reports/:reportId/documents/:documentId/content", (request, response) => {
  const session = requirePortalSession(request, "own_amu:read");
  const document = amuDocumentMetadata(request.params.reportId, request.params.documentId);
  if (!document || document.employee_number !== session.employeeNumber || document.report_status === "withdrawn") {
    auditPortal(session.employeeNumber, "amu.document.access.denied", "amu_document", String(request.params.documentId));
    throw httpError(404, "Das AUM-Dokument wurde nicht gefunden.", "AMU_DOCUMENT_NOT_FOUND");
  }
  auditPortal(session.employeeNumber, "amu.document.download", "amu_document", document.id);
  sendAmuDocument(response, document);
});

app.get("/api/portal/v1/amu-reports", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:metadata:read");
  const rows = db.prepare(`
    SELECT r.*, e.full_name, e.nickname, e.color, e.preferred_department_id, l.name AS location_name,
           d.name AS department_name
    FROM amu_reports r JOIN employees e ON e.personnel_number = r.employee_number
    JOIN locations l ON l.id = r.location_id LEFT JOIN departments d ON d.id = r.department_id
    ORDER BY r.submitted_at DESC, r.id DESC
  `).all();
  let scopedRows = rows;
  if (session.role === "manager") {
    const allowedLocations = new Set((session.scopes || []).map((scope) => scope.locationId));
    scopedRows = rows.filter((row) => allowedLocations.has(row.location_id));
  } else if (session.role === "department_manager") {
    const allowed = new Set((session.scopes || []).map((scope) => `${scope.locationId}:${Number(scope.departmentId || 0)}`));
    scopedRows = rows.filter((row) => row.department_id != null
      && allowed.has(`${row.location_id}:${Number(row.department_id)}`));
  }
  const reports = serializeAmuReports(scopedRows);
  const canOpenFiles = actorCanReadAmuFiles(session);
  if (!canOpenFiles) {
    for (const report of reports) {
      report.employee_note = "";
      report.review_note = "";
      report.documents = report.documents.map(({ id, detected_mime, size, byte_size, scan_status, status, created_at }, index) => ({
        id, original_name: `Dokument ${index + 1}`, original_filename: `Dokument ${index + 1}`, detected_mime, size, byte_size, scan_status, status, created_at, content_access: false,
      }));
    }
  }
  response.json({ reports, pendingCount: reports.filter((item) => item.status === "submitted").length, canOpenFiles });
});

app.put("/api/portal/v1/amu-reports/:id/review", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:review");
  const report = amuReportMetadata(request.params.id);
  assertAmuReportScope(session, report);
  if (!report || !["submitted", "returned"].includes(report.status)) throw httpError(409, "Diese Arbeitsunfähigkeitsmeldung ist bereits abgeschlossen.");
  const action = String(request.body.action || "reviewed");
  if (action !== "reviewed") throw httpError(400, "Bitte die Arbeitsunfähigkeitsmeldung als geprüft markieren.");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  db.prepare(`
    UPDATE amu_reports SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
      review_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(action, session.employeeNumber, requireAmuStorage().protectText(note), report.id);
  auditPortal(session.employeeNumber, `amu.report.${action}`, "amu_report", String(report.id));
  createPortalNotification(report.employee_number, "amu.review", "AUM wurde geprüft", note, {
    target: "/portal/?tab=amu",
    entityType: "amu_report",
    entityId: report.id,
    dedupeKey: `amu:${report.id}:${action}:${session.employeeNumber}`,
  });
  db.prepare("UPDATE portal_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE entity_type = 'amu_report' AND entity_id = ? AND event_type = 'amu.submitted'")
    .run(String(report.id));
  response.json({ report: serializeAmuReports([amuReportMetadata(report.id)])[0] });
});

app.get("/api/portal/v1/amu-reports/:reportId/documents/:documentId/content", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:metadata:read");
  if (!actorCanReadAmuFiles(session)) throw httpError(403, "AUM-Dateien dürfen von diesem Zugang nicht geöffnet werden.", "PORTAL_PERMISSION_DENIED");
  const document = amuDocumentMetadata(request.params.reportId, request.params.documentId);
  if (!document) throw httpError(404, "Das AUM-Dokument wurde nicht gefunden.", "AMU_DOCUMENT_NOT_FOUND");
  assertAmuReportScope(session, document);
  auditPortal(session.employeeNumber, "amu.document.download", "amu_document", document.id);
  sendAmuDocument(response, document);
});

app.delete("/api/portal/v1/amu-reports/:reportId/documents/:documentId", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "amu:delete");
  const document = amuDocumentMetadata(request.params.reportId, request.params.documentId);
  if (!document) throw httpError(404, "Das AUM-Dokument wurde nicht gefunden.", "AMU_DOCUMENT_NOT_FOUND");
  assertAmuReportScope(session, document);
  amuMutationInProgress += 1;
  try {
    db.prepare("UPDATE amu_documents SET status = 'deleted', deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(session.employeeNumber, document.id);
    try {
      requireAmuStorage().deleteBlob(document.storage_key);
    } catch (error) {
      db.prepare("UPDATE amu_documents SET status = 'active', deleted_by = NULL, deleted_at = NULL WHERE id = ?").run(document.id);
      throw error;
    }
    db.prepare("UPDATE amu_documents SET status = 'purged', original_filename = 'Dokument', purged_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(document.id);
    auditPortal(session.employeeNumber, "amu.document.delete", "amu_document", document.id);
  } finally {
    amuMutationInProgress = Math.max(0, amuMutationInProgress - 1);
  }
  response.status(204).end();
});

app.post("/api/portal/v1/me/vacation-check", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  response.json(evaluateVacationRequest(session.employeeNumber, request.body));
});

app.post("/api/portal/v1/me/time-off-check", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  response.json(evaluateTimeOffRequest(session.employeeNumber, request.body));
});

app.get("/api/portal/v1/me/time-off-slots", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  const date = String(request.query.date || "");
  if (!isIsoDate(date)) throw httpError(400, "Bitte zuerst ein gültiges Datum auswählen.");
  const context = employeeRequestContext(session.employeeNumber, date);
  const settings = settingsForLocation(context.locationId);
  const hours = operatingHours(date, settings);
  const block = getGlobalDayBlockForDate(date, context.locationId);
  if (!hours || block) {
    response.json({ date, closed: true, reason: block?.reason || block?.holiday_name || "An diesem Tag ist die Filiale geschlossen.", startTimes: [], endTimes: [] });
    return;
  }
  const values = [];
  for (let minute = timeToMinutes(hours.start); minute <= timeToMinutes(hours.end); minute += 15) values.push(minutesToTime(minute));
  response.json({ date, closed: false, start: hours.start, end: hours.end, startTimes: values.slice(0, -1), endTimes: values.slice(1) });
});

app.get("/api/portal/v1/me/time-off-requests", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  const requests = db.prepare(`
    SELECT id, request_date, COALESCE(date_from, request_date) AS date_from, COALESCE(date_to, request_date) AS date_to,
           all_day, start_time, end_time, note, status, approval_type, approval_stage,
           traffic_light, check_reason, decision_note, local_approved_by, local_approved_at,
           hr_approved_by, hr_approved_at, decided_by, decided_at, created_at, updated_at
    FROM time_off_requests WHERE employee_number = ?
      AND (status IN ('pending','pending_local','preliminary_local','pending_hr') OR COALESCE(date_to, request_date) >= ?)
    ORDER BY COALESCE(date_from, request_date) DESC, created_at DESC
  `).all(session.employeeNumber, addMonths(viennaTodayIso(), -6));
  response.json({ requests });
});

app.post("/api/portal/v1/me/time-off-requests", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const check = evaluateTimeOffRequest(session.employeeNumber, request.body);
  if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  const date = String(request.body.date || request.body.requestDate || request.body.dateFrom || "");
  const dateTo = String(request.body.dateTo || date);
  const allDay = request.body.allDay === true || dateTo !== date;
  const startTime = allDay ? "00:00" : String(request.body.startTime || "");
  const endTime = allDay ? "23:59" : String(request.body.endTime || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const approvalType = request.body.approvalType === "hr" ? "hr" : "local";
  const locationId = employeeRequestContext(session.employeeNumber, date).locationId;
  const result = db.prepare(`
    INSERT INTO time_off_requests
      (employee_number, location_id, request_date, date_from, date_to, all_day, start_time, end_time, note, approval_type, approval_stage, status, traffic_light, check_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', 'pending_local', ?, ?)
  `).run(session.employeeNumber, locationId, date, date, dateTo, allDay ? 1 : 0, startTime, endTime, note, approvalType, check.trafficLight, check.reason);
  auditPortal(session.employeeNumber, "time_off.request.create", "time_off_request", String(result.lastInsertRowid), JSON.stringify(check));
  notifyRequestReviewers({ id: Number(result.lastInsertRowid), employee_number: session.employeeNumber, location_id: locationId }, "time_off", "local", session.employeeNumber);
  response.status(201).json({ id: Number(result.lastInsertRowid), status: "pending", check });
});

app.put("/api/portal/v1/me/time-off-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  if (!entry) throw httpError(404, "Der offene ZA-Antrag wurde nicht gefunden.");
  const check = evaluateTimeOffRequest(session.employeeNumber, { ...request.body, excludeRequestId: entry.id });
  if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  const dateFrom = String(request.body.date || request.body.dateFrom || "");
  const dateTo = String(request.body.dateTo || dateFrom);
  const allDay = request.body.allDay === true || dateTo !== dateFrom;
  const startTime = allDay ? "00:00" : String(request.body.startTime || "");
  const endTime = allDay ? "23:59" : String(request.body.endTime || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const approvalType = request.body.approvalType === "hr" ? "hr" : "local";
  db.prepare(`UPDATE time_off_requests SET request_date = ?, date_from = ?, date_to = ?, all_day = ?, start_time = ?, end_time = ?, note = ?, approval_type = ?,
      status = 'pending_local', approval_stage = 'local', traffic_light = ?, check_reason = ?, decision_note = '', local_approved_by = NULL,
      local_approved_at = NULL, hr_approved_by = NULL, hr_approved_at = NULL, decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(dateFrom, dateFrom, dateTo, allDay ? 1 : 0, startTime, endTime, note, approvalType, check.trafficLight, check.reason, entry.id);
  recordRequestDecision("time_off", entry.id, "employee", "change", session.employeeNumber, note);
  resolveRequestReviewNotifications("time_off", entry.id);
  notifyRequestReviewers({ ...entry, location_id: entry.location_id }, "time_off", "local", session.employeeNumber);
  response.json({ id: entry.id, status: "pending", check });
});

app.delete("/api/portal/v1/me/time-off-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  if (!entry) throw httpError(404, "Der offene ZA-Antrag wurde nicht gefunden.");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE time_off_requests SET status = 'withdrawn', approval_stage = 'complete', decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(session.employeeNumber, entry.id);
    recordRequestDecision("time_off", entry.id, "employee", "withdraw", session.employeeNumber, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  resolveRequestReviewNotifications("time_off", entry.id);
  auditPortal(session.employeeNumber, "time_off.request.withdraw", "time_off_request", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/me/approved-time-off", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  const requests = db.prepare(`
    SELECT id, request_date, COALESCE(date_from, request_date) AS date_from,
           COALESCE(date_to, request_date) AS date_to, all_day, start_time, end_time,
           note, approval_type, local_approved_by, hr_approved_by, decided_by, decided_at
    FROM time_off_requests
    WHERE employee_number = ? AND status = 'approved' AND COALESCE(date_to, request_date) >= ?
    ORDER BY COALESCE(date_from, request_date), start_time, id
  `).all(session.employeeNumber, viennaTodayIso());
  const pendingChanges = db.prepare(`
    SELECT id, original_request_id, request_type, requested_date_from, requested_date_to,
           requested_all_day, requested_start_time, requested_end_time, note, status, created_at
    FROM time_off_change_requests
    WHERE employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')
    ORDER BY created_at DESC
  `).all(session.employeeNumber);
  response.json({ requests, pendingChanges });
});

app.post("/api/portal/v1/me/time-off-change-requests", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const originalRequestId = Number(request.body.requestId || request.body.originalRequestId || 0);
  const requestType = String(request.body.requestType || "");
  if (!Number.isInteger(originalRequestId) || !["change", "cancel"].includes(requestType)) {
    throw httpError(400, "Bitte eine gültige ZA-Änderung auswählen.");
  }
  const original = db.prepare(`SELECT * FROM time_off_requests
    WHERE id = ? AND employee_number = ? AND status = 'approved' AND COALESCE(date_to, request_date) >= ?`)
    .get(originalRequestId, session.employeeNumber, viennaTodayIso());
  if (!original) throw httpError(404, "Der genehmigte Zeitausgleich wurde nicht gefunden.");
  const pending = db.prepare(`SELECT id FROM time_off_change_requests
    WHERE original_request_id = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr') LIMIT 1`)
    .get(original.id);
  if (pending) throw httpError(409, "Für diesen Zeitausgleich besteht bereits ein offener Änderungs- oder Stornoantrag.");

  let dateFrom = null;
  let dateTo = null;
  let allDay = false;
  let startTime = null;
  let endTime = null;
  if (requestType === "change") {
    dateFrom = String(request.body.dateFrom || request.body.date || "");
    dateTo = String(request.body.dateTo || dateFrom);
    allDay = request.body.allDay === true || dateTo !== dateFrom;
    startTime = allDay ? "00:00" : String(request.body.startTime || "");
    endTime = allDay ? "23:59" : String(request.body.endTime || "");
    const check = evaluateTimeOffRequest(session.employeeNumber, {
      date: dateFrom, dateFrom, dateTo, allDay, startTime, endTime, excludeRequestId: original.id,
    });
    if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  }
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const result = db.prepare(`INSERT INTO time_off_change_requests
      (employee_number, location_id, original_request_id, request_type,
       requested_date_from, requested_date_to, requested_all_day, requested_start_time,
       requested_end_time, note, status, approval_type, approval_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_local', ?, 'local')`)
    .run(session.employeeNumber, original.location_id, original.id, requestType, dateFrom, dateTo,
      allDay ? 1 : 0, startTime, endTime, note, original.approval_type || "local");
  const id = Number(result.lastInsertRowid);
  recordRequestDecision("time_off_change", id, "employee", requestType, session.employeeNumber, note);
  auditPortal(session.employeeNumber, `time_off.${requestType}.request`, "time_off_change_request", String(id));
  notifyRequestReviewers({ id, employee_number: session.employeeNumber, location_id: original.location_id }, "time_off_change", "local", session.employeeNumber);
  response.status(201).json({ id, status: "pending" });
});

app.delete("/api/portal/v1/me/time-off-change-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  const entry = db.prepare(`SELECT * FROM time_off_change_requests
    WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')`)
    .get(Number(request.params.id), session.employeeNumber);
  if (!entry) throw httpError(404, "Der offene Änderungs- oder Stornoantrag wurde nicht gefunden.");
  db.prepare(`UPDATE time_off_change_requests SET status = 'withdrawn', approval_stage = 'complete',
    decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(session.employeeNumber, entry.id);
  recordRequestDecision("time_off_change", entry.id, "employee", "withdraw", session.employeeNumber, "");
  resolveRequestReviewNotifications("time_off_change", entry.id);
  auditPortal(session.employeeNumber, "time_off.change_request.withdraw", "time_off_change_request", String(entry.id));
  response.status(204).end();
});

app.get("/api/portal/v1/me/approved-vacations", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:read");
  const vacations = approvedVacationsForEmployee(session.employeeNumber, viennaTodayIso());
  const pendingChanges = db.prepare(`
    SELECT id, vacation_group_id, request_type, original_date_from, original_date_to,
           requested_date_from, requested_date_to, note, status, created_at
    FROM vacation_change_requests WHERE employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')
    ORDER BY created_at DESC
  `).all(session.employeeNumber);
  response.json({ vacations, pendingChanges });
});

app.post("/api/portal/v1/me/vacation-change-requests", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const groupId = String(request.body.groupId || "").trim();
  const requestType = String(request.body.requestType || "");
  if (!groupId || !["change", "cancel"].includes(requestType)) throw httpError(400, "Bitte eine gültige Urlaubsänderung auswählen.");
  const vacation = approvedVacationsForEmployee(session.employeeNumber, "1900-01-01").find((item) => item.groupId === groupId);
  if (!vacation) throw httpError(404, "Der genehmigte Urlaub wurde nicht gefunden.");
  const pending = db.prepare(`
    SELECT id FROM vacation_change_requests
    WHERE employee_number = ? AND vacation_group_id = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr') LIMIT 1
  `).get(session.employeeNumber, groupId);
  if (pending) throw httpError(409, "Für diesen Urlaub besteht bereits ein offener Änderungs- oder Stornoantrag.");
  let requestedFrom = null;
  let requestedTo = null;
  if (requestType === "change") {
    requestedFrom = String(request.body.dateFrom || "");
    requestedTo = String(request.body.dateTo || "");
    if (!isIsoDate(requestedFrom) || !isIsoDate(requestedTo) || requestedTo < requestedFrom) {
      throw httpError(400, "Bitte einen gültigen neuen Urlaubszeitraum eingeben.");
    }
    const availability = evaluateVacationRequest(session.employeeNumber, { dateFrom: requestedFrom, dateTo: requestedTo });
    if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
  }
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const result = db.prepare(`
    INSERT INTO vacation_change_requests
      (employee_number, vacation_group_id, request_type, original_date_from, original_date_to,
       requested_date_from, requested_date_to, note, status, approval_stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_local', 'local')
  `).run(session.employeeNumber, groupId, requestType, vacation.dateFrom, vacation.dateTo, requestedFrom, requestedTo, note);
  auditPortal(session.employeeNumber, `vacation.${requestType}.request`, "vacation_change_request", String(result.lastInsertRowid));
  notifyRequestReviewers({ id: Number(result.lastInsertRowid), employee_number: session.employeeNumber, location_id: employeeRequestContext(session.employeeNumber, vacation.dateFrom).locationId }, "vacation_change", "local", session.employeeNumber);
  response.status(201).json({ id: Number(result.lastInsertRowid), status: "pending" });
});

app.delete("/api/portal/v1/me/vacation-change-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM vacation_change_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  const result = { changes: entry ? 1 : 0 };
  if (!result.changes) throw httpError(404, "Der offene Änderungs- oder Stornoantrag wurde nicht gefunden.");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE vacation_change_requests SET status = 'withdrawn', approval_stage = 'complete', decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(session.employeeNumber, entry.id);
    recordRequestDecision("vacation_change", entry.id, "employee", "withdraw", session.employeeNumber, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  resolveRequestReviewNotifications("vacation_change", entry.id);
  auditPortal(session.employeeNumber, "vacation.change_request.withdraw", "vacation_change_request", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/me/vacation-requests", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:read");
  const requests = db.prepare(`
    SELECT id, date_from, date_to, note, status, approval_stage, decision_note,
           local_approved_by, local_approved_at, hr_approved_by, hr_approved_at,
           decided_by, decided_at, created_at, updated_at
    FROM vacation_requests WHERE employee_number = ?
      AND (status IN ('pending','pending_local','preliminary_local','pending_hr') OR date_to >= ?)
    ORDER BY created_at DESC, id DESC
  `).all(session.employeeNumber, addMonths(viennaTodayIso(), -6));
  response.json({ requests });
});

app.post("/api/portal/v1/me/vacation-requests", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const vacation = validateVacationRequestDates(session.employeeNumber, request.body);
  const locationId = employeeRequestContext(session.employeeNumber, vacation.dateFrom).locationId;
  const result = db.prepare(`
    INSERT INTO vacation_requests (employee_number, location_id, date_from, date_to, note, status, approval_stage)
    VALUES (?, ?, ?, ?, ?, 'pending_local', 'local')
  `).run(vacation.employeeNumber, locationId, vacation.dateFrom, vacation.dateTo, vacation.note);
  auditPortal(session.employeeNumber, "vacation.request.create", "vacation_request", String(result.lastInsertRowid));
  notifyRequestReviewers({ id: Number(result.lastInsertRowid), employee_number: session.employeeNumber, location_id: locationId }, "vacation", "local", session.employeeNumber);
  response.status(201).json({ id: Number(result.lastInsertRowid), status: "pending" });
});

app.put("/api/portal/v1/me/vacation-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM vacation_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  if (!entry) throw httpError(404, "Der offene Urlaubsantrag wurde nicht gefunden.");
  const dateFrom = String(request.body.dateFrom || "");
  const dateTo = String(request.body.dateTo || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) throw httpError(400, "Bitte einen gültigen Urlaubszeitraum eingeben.");
  const availability = evaluateVacationRequest(session.employeeNumber, { dateFrom, dateTo });
  if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
  const overlapping = db.prepare(`SELECT id FROM vacation_requests WHERE employee_number = ? AND id <> ?
    AND status IN ('pending','pending_local','preliminary_local','pending_hr','approved') AND date_from <= ? AND date_to >= ? LIMIT 1`)
    .get(session.employeeNumber, entry.id, dateTo, dateFrom);
  if (overlapping) throw httpError(409, "Für diesen Zeitraum besteht bereits ein Urlaubsantrag.");
  db.prepare(`UPDATE vacation_requests SET date_from = ?, date_to = ?, note = ?, status = 'pending_local', approval_stage = 'local',
    decision_note = '', local_approved_by = NULL, local_approved_at = NULL, hr_approved_by = NULL, hr_approved_at = NULL,
    decided_by = NULL, decided_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(dateFrom, dateTo, note, entry.id);
  recordRequestDecision("vacation", entry.id, "employee", "change", session.employeeNumber, note);
  resolveRequestReviewNotifications("vacation", entry.id);
  notifyRequestReviewers(entry, "vacation", "local", session.employeeNumber);
  response.json({ id: entry.id, status: "pending" });
});

app.delete("/api/portal/v1/me/vacation-requests/:id", (request, response) => {
  const session = requirePortalSession(request, "own_vacation:request");
  assertPortalCsrf(request);
  const entry = db.prepare("SELECT * FROM vacation_requests WHERE id = ? AND employee_number = ? AND status IN ('pending','pending_local','preliminary_local','pending_hr')")
    .get(Number(request.params.id), session.employeeNumber);
  const result = { changes: entry ? 1 : 0 };
  if (!result.changes) throw httpError(404, "Der offene Urlaubsantrag wurde nicht gefunden.");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE vacation_requests SET status = 'withdrawn', approval_stage = 'complete', decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(session.employeeNumber, entry.id);
    recordRequestDecision("vacation", entry.id, "employee", "withdraw", session.employeeNumber, "");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  resolveRequestReviewNotifications("vacation", entry.id);
  auditPortal(session.employeeNumber, "vacation.request.withdraw", "vacation_request", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/vacation-requests", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:read");
  const status = ["pending", "approved", "rejected"].includes(String(request.query.status)) ? String(request.query.status) : "pending";
  const requests = db.prepare(`
    SELECT v.id, v.employee_number, v.date_from, v.date_to, v.note, v.status,
           v.decided_by, v.decided_at, v.created_at, e.full_name, e.nickname, e.color,
           COALESCE(v.location_id, e.home_location_id) AS scoped_location_id, e.preferred_department_id
    FROM vacation_requests v JOIN employees e ON e.personnel_number = v.employee_number
    WHERE v.status = ? ORDER BY v.created_at, v.id
  `).all(status).filter((entry) => sessionHasGlobalScope(actor) || (actor.scopes || []).some((scope) => scope.locationId === entry.scoped_location_id
    && (actor.role !== "department_manager" || Number(scope.departmentId) === Number(entry.preferred_department_id || 0))));
  response.json({ requests, status });
});

app.put("/api/portal/v1/vacation-requests/:id/decision", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "vacation:approve");
  const decision = String(request.body.decision || "");
  if (!["approved", "rejected"].includes(decision)) throw httpError(400, "Bitte genehmigen oder ablehnen.");
  const entry = db.prepare("SELECT * FROM vacation_requests WHERE id = ? AND status IN ('pending','pending_local','preliminary_local')").get(Number(request.params.id));
  if (!entry) throw httpError(404, "Der offene Urlaubsantrag wurde nicht gefunden.");
  assertRequestScope(session, entry);
  if (session.role === "hr") throw httpError(403, "Die Personalleitung darf die vorgelagerte Filialfreigabe nicht ersetzen.");
  if (vacationHrApprovalRequired()) throw httpError(409, "Dieser Antrag muss über den zweistufigen Freigabeworkflow bearbeitet werden.");
  let groupId = null;
  if (decision === "approved") {
    const availability = evaluateVacationRequest(entry.employee_number, { dateFrom: entry.date_from, dateTo: entry.date_to });
    if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
    const vacation = validateVacationEntry({ employeeNumber: entry.employee_number, dateFrom: entry.date_from, dateTo: entry.date_to, note: entry.note });
    groupId = createVacationGroupId();
    db.exec("BEGIN");
    try {
      insertVacationEntries(vacation, groupId);
      db.prepare(`
        UPDATE vacation_requests SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
          vacation_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(session.employeeNumber, groupId, entry.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    db.prepare(`
      UPDATE vacation_requests SET status = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(session.employeeNumber, entry.id);
  }
  auditPortal(session.employeeNumber, `vacation.request.${decision}`, "vacation_request", String(entry.id));
  recordRequestDecision("vacation", entry.id, "local", decision === "approved" ? "approve" : "reject", session.employeeNumber, "");
  notifyRequestDecision(entry, "vacation", decision, session.employeeNumber);
  response.json({ ok: true, id: entry.id, status: decision, vacationGroupId: groupId });
});

app.get("/api/portal/v1/absence-requests", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "vacation:read");
  const scoped = !["admin", "hr"].includes(session.role) && session.employeeNumber !== "local";
  const scopeSql = scoped ? "AND COALESCE(v.location_id, e.home_location_id) = ?" : "";
  const scopeParams = scoped ? [session.scopes?.[0]?.locationId || session.homeLocationId] : [];
  const vacationRequests = db.prepare(`
    SELECT v.id, v.employee_number, v.location_id, v.date_from, v.date_to, v.note, v.status,
           v.approval_stage, v.decision_note, v.local_approved_by, v.local_approved_at,
           v.hr_approved_by, v.hr_approved_at, v.decided_by, v.decided_at, v.created_at,
           e.full_name, e.nickname, e.color, e.preferred_department_id
    FROM vacation_requests v JOIN employees e ON e.personnel_number = v.employee_number
    WHERE 1 = 1 ${scopeSql}
  `).all(...scopeParams).map((row) => ({ ...row, status: publicRequestStatus(row.status), kind: "vacation", decisions: requestDecisionHistory("vacation", row.id) }));
  const timeScopeSql = scoped ? "AND COALESCE(t.location_id, e.home_location_id) = ?" : "";
  const timeOffRequests = db.prepare(`
    SELECT t.id, t.employee_number, t.location_id, t.request_date,
           COALESCE(t.date_from, t.request_date) AS date_from, COALESCE(t.date_to, t.request_date) AS date_to, t.all_day,
           t.start_time, t.end_time, t.note,
           t.status, t.approval_type, t.approval_stage, t.traffic_light, t.check_reason,
           t.decision_note, t.local_approved_by, t.local_approved_at, t.hr_approved_by,
           t.hr_approved_at, t.decided_by, t.decided_at, t.created_at,
           e.full_name, e.nickname, e.color, e.preferred_department_id
    FROM time_off_requests t JOIN employees e ON e.personnel_number = t.employee_number
    WHERE 1 = 1 ${timeScopeSql}
  `).all(...scopeParams).map((row) => ({ ...row, status: publicRequestStatus(row.status), kind: "time_off", decisions: requestDecisionHistory("time_off", row.id) }));
  const changeScopeSql = scoped ? "AND e.home_location_id = ?" : "";
  const changeRequests = db.prepare(`
    SELECT c.id, c.employee_number, c.vacation_group_id, c.request_type,
           c.original_date_from, c.original_date_to, c.requested_date_from, c.requested_date_to,
           c.note, c.status, c.approval_stage, c.decision_note, c.local_approved_by,
           c.local_approved_at, c.hr_approved_by, c.hr_approved_at, c.decided_by, c.decided_at,
           c.created_at, e.full_name, e.nickname, e.color, e.home_location_id AS location_id, e.preferred_department_id
    FROM vacation_change_requests c JOIN employees e ON e.personnel_number = c.employee_number
    WHERE 1 = 1 ${changeScopeSql}
  `).all(...scopeParams).map((row) => ({ ...row, status: publicRequestStatus(row.status), kind: row.request_type === "cancel" ? "vacation_cancel" : "vacation_change", decisions: requestDecisionHistory("vacation_change", row.id) }));
  const timeOffChangeScopeSql = scoped ? "AND COALESCE(c.location_id, e.home_location_id) = ?" : "";
  const timeOffChangeRequests = db.prepare(`
    SELECT c.id, c.employee_number, c.location_id, c.original_request_id, c.request_type,
           c.requested_date_from, c.requested_date_to, c.requested_all_day,
           c.requested_start_time, c.requested_end_time, c.note, c.status,
           c.approval_type, c.approval_stage, c.decision_note, c.local_approved_by,
           c.local_approved_at, c.hr_approved_by, c.hr_approved_at, c.decided_by,
           c.decided_at, c.created_at, e.full_name, e.nickname, e.color,
           e.preferred_department_id, COALESCE(t.date_from, t.request_date) AS original_date_from,
           COALESCE(t.date_to, t.request_date) AS original_date_to, t.all_day AS original_all_day,
           t.start_time AS original_start_time, t.end_time AS original_end_time
    FROM time_off_change_requests c
    JOIN time_off_requests t ON t.id = c.original_request_id
    JOIN employees e ON e.personnel_number = c.employee_number
    WHERE 1 = 1 ${timeOffChangeScopeSql}
  `).all(...scopeParams).map((row) => ({
    ...row,
    status: publicRequestStatus(row.status),
    kind: row.request_type === "cancel" ? "time_off_cancel" : "time_off_change",
    decisions: requestDecisionHistory("time_off_change", row.id),
  }));
  let requests = [...vacationRequests, ...timeOffRequests, ...changeRequests, ...timeOffChangeRequests];
  if (session.role === "department_manager") {
    const departments = new Set((session.scopes || []).map((scope) => Number(scope.departmentId || 0)).filter(Boolean));
    requests = requests.filter((entry) => departments.has(Number(entry.preferred_department_id || 0)));
  }
  requests = requests
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
  const actionable = requests.filter((entry) => {
    if (!["pending_local", "preliminary_local", "pending_hr"].includes(entry.status)) return false;
    if (entry.approval_stage === "hr") return ["hr", "admin"].includes(session.role) || session.employeeNumber === "local";
    return session.role !== "hr" || session.role === "admin" || session.employeeNumber === "local";
  });
  response.json({
    requests,
    counts: {
      vacation: actionable.filter((entry) => !entry.kind.startsWith("time_off")).length,
      timeOff: actionable.filter((entry) => entry.kind.startsWith("time_off")).length,
      total: actionable.length,
    },
    vacationHrApprovalRequired: vacationHrApprovalRequired(),
  });
});

function finalizeVacationRequest(entry, actor, note) {
  const availability = evaluateVacationRequest(entry.employee_number, { dateFrom: entry.date_from, dateTo: entry.date_to });
  if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
  const vacation = validateVacationEntry({ employeeNumber: entry.employee_number, dateFrom: entry.date_from, dateTo: entry.date_to, note: entry.note });
  const groupId = entry.vacation_group_id || createVacationGroupId();
  insertVacationEntries(vacation, groupId);
  db.prepare(`
    UPDATE vacation_requests SET status = 'approved', approval_stage = 'complete', decision_note = ?,
      decided_by = ?, decided_at = CURRENT_TIMESTAMP, vacation_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(note, actor, groupId, entry.id);
  return { vacationGroupId: groupId };
}

function finalizeTimeOffRequest(entry, actor, note) {
  const check = evaluateTimeOffRequest(entry.employee_number, {
    date: entry.date_from || entry.request_date,
    dateFrom: entry.date_from || entry.request_date,
    dateTo: entry.date_to || entry.request_date,
    allDay: Boolean(entry.all_day),
    startTime: entry.start_time,
    endTime: entry.end_time,
    excludeRequestId: entry.id,
  });
  if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  const optionId = insertApprovedTimeOff(entry);
  db.prepare(`
    UPDATE time_off_requests SET status = 'approved', approval_stage = 'complete', option_id = ?,
      traffic_light = ?, check_reason = ?, decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(optionId, check.trafficLight, check.reason, note, actor, entry.id);
  return { optionId };
}

function finalizeTimeOffChangeRequest(entry, actor, note) {
  let original = db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND employee_number = ? AND status = 'approved'")
    .get(entry.original_request_id, entry.employee_number);
  if (!original) throw httpError(409, "Der ursprüngliche Zeitausgleich besteht nicht mehr.");
  let check = null;
  if (entry.request_type === "change") {
    check = evaluateTimeOffRequest(entry.employee_number, {
      date: entry.requested_date_from,
      dateFrom: entry.requested_date_from,
      dateTo: entry.requested_date_to,
      allDay: Boolean(entry.requested_all_day),
      startTime: entry.requested_start_time,
      endTime: entry.requested_end_time,
      excludeRequestId: original.id,
    });
    if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
  }

  restoreApprovedTimeOff(original);
  if (entry.request_type === "cancel") {
    db.prepare(`UPDATE time_off_requests SET status = 'cancelled', approval_stage = 'complete', option_id = NULL,
      original_shifts_json = '[]', decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(note, actor, original.id);
  } else {
    const allDay = Boolean(entry.requested_all_day) || entry.requested_date_to !== entry.requested_date_from;
    db.prepare(`UPDATE time_off_requests SET request_date = ?, date_from = ?, date_to = ?, all_day = ?,
      start_time = ?, end_time = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END,
      option_id = NULL, original_shifts_json = '[]', traffic_light = ?, check_reason = ?,
      decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(entry.requested_date_from, entry.requested_date_from, entry.requested_date_to,
      allDay ? 1 : 0, allDay ? "00:00" : entry.requested_start_time,
      allDay ? "23:59" : entry.requested_end_time, entry.note || "", entry.note || "",
      check.trafficLight, check.reason, note, actor, original.id);
    original = db.prepare("SELECT * FROM time_off_requests WHERE id = ?").get(original.id);
    const optionId = insertApprovedTimeOff(original);
    db.prepare("UPDATE time_off_requests SET option_id = ?, status = 'approved', approval_stage = 'complete', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(optionId, original.id);
  }
  db.prepare(`UPDATE time_off_change_requests SET status = 'approved', approval_stage = 'complete',
    decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(note, actor, entry.id);
  return { originalRequestId: original.id };
}

function finalizeVacationChangeRequest(entry, actor, note) {
  const current = approvedVacationsForEmployee(entry.employee_number, "1900-01-01").find((item) => item.groupId === entry.vacation_group_id);
  if (!current) throw httpError(409, "Der ursprüngliche Urlaub besteht nicht mehr.");
  let replacement = null;
  if (entry.request_type === "change") {
    const availability = evaluateVacationRequest(entry.employee_number, { dateFrom: entry.requested_date_from, dateTo: entry.requested_date_to });
    if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
    replacement = validateVacationEntry({
      employeeNumber: entry.employee_number,
      dateFrom: entry.requested_date_from,
      dateTo: entry.requested_date_to,
      note: entry.note || current.note,
    }, entry.vacation_group_id);
  }
  deleteVacationGroup(entry.vacation_group_id);
  if (replacement) insertVacationEntries(replacement, entry.vacation_group_id);
  db.prepare(`
    UPDATE vacation_change_requests SET status = 'approved', approval_stage = 'complete', decision_note = ?,
      decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(note, actor, entry.id);
  if (entry.request_type === "change") {
    db.prepare(`UPDATE vacation_requests SET date_from = ?, date_to = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE vacation_group_id = ?`)
      .run(entry.requested_date_from, entry.requested_date_to, entry.note || current.note, entry.vacation_group_id);
  } else {
    db.prepare(`UPDATE vacation_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE vacation_group_id = ?`)
      .run(entry.vacation_group_id);
  }
  return {};
}

app.put("/api/portal/v1/absence-requests/:kind/:id/action", (request, response) => {
  const kind = String(request.params.kind || "");
  const permission = kind.startsWith("time_off") ? "time:review" : "vacation:approve";
  const session = requirePortalAdminOrLocal(request, permission);
  const table = kind === "time_off" ? "time_off_requests"
    : kind === "time_off_change" ? "time_off_change_requests"
      : kind === "vacation_change" ? "vacation_change_requests"
        : kind === "vacation" ? "vacation_requests" : "";
  if (!table) throw httpError(400, "Die Antragsart ist ungültig.");
  let entry = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(request.params.id));
  if (!entry) throw httpError(404, "Der Antrag wurde nicht gefunden.");
  if (!entry.location_id) entry.location_id = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(entry.employee_number)?.home_location_id;
  assertRequestScope(session, entry);
  if (entry.approval_stage !== "hr" && session.role === "hr") {
    throw httpError(403, "Die Personalleitung darf die vorgelagerte Filialfreigabe nicht ersetzen.");
  }
  const action = String(request.body.action || "");
  const note = stripEmoji(String(request.body.note || "").trim()).slice(0, 500);
  const stage = actorStage(session, entry);
  if (entry.approval_stage === "hr" && stage !== "hr") throw httpError(403, "Dieser Antrag wartet auf die Personalleitung.");
  if (stage === "hr" && !["hr", "admin"].includes(session.role) && session.employeeNumber !== "local") throw httpError(403, "Nur die Personalleitung darf diese Freigabe abschließen.");
  if (entry.status === "approved" && entry.hr_approved_by && ["change", "cancel"].includes(action)
    && !["hr", "admin"].includes(session.role) && session.employeeNumber !== "local") {
    throw httpError(403, "Dieser verbindliche Antrag kann nur durch die Personalleitung geändert oder storniert werden.");
  }
  let result = {};
  db.exec("BEGIN");
  try {
    if (action === "preliminary") {
      if (!["pending", "pending_local", "preliminary_local"].includes(entry.status) || stage !== "local") throw httpError(409, "Dieser Antrag kann nicht vorläufig genehmigt werden.");
      db.prepare(`UPDATE ${table} SET status = 'preliminary_local', approval_stage = 'local', decision_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(note, entry.id);
    } else if (action === "reject") {
      if (!["pending", "pending_local", "preliminary_local", "pending_hr"].includes(entry.status)) throw httpError(409, "Dieser Antrag ist bereits abgeschlossen.");
      db.prepare(`UPDATE ${table} SET status = 'rejected', approval_stage = 'complete', decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(note, session.employeeNumber, entry.id);
    } else if (action === "approve") {
      if (!["pending", "pending_local", "preliminary_local", "pending_hr"].includes(entry.status)) throw httpError(409, "Dieser Antrag ist bereits abgeschlossen.");
      if (stage === "local") {
        db.prepare(`UPDATE ${table} SET local_approved_by = ?, local_approved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(session.employeeNumber, entry.id);
        const needsHr = kind.startsWith("time_off") ? entry.approval_type === "hr" : vacationHrApprovalRequired();
        if (needsHr) {
          db.prepare(`UPDATE ${table} SET status = 'pending_hr', approval_stage = 'hr', decision_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(note, entry.id);
        } else if (kind === "time_off") result = finalizeTimeOffRequest(entry, session.employeeNumber, note);
        else if (kind === "time_off_change") result = finalizeTimeOffChangeRequest(entry, session.employeeNumber, note);
        else if (kind === "vacation") result = finalizeVacationRequest(entry, session.employeeNumber, note);
        else result = finalizeVacationChangeRequest(entry, session.employeeNumber, note);
      } else {
        db.prepare(`UPDATE ${table} SET hr_approved_by = ?, hr_approved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(session.employeeNumber, entry.id);
        if (kind === "time_off") result = finalizeTimeOffRequest(entry, session.employeeNumber, note);
        else if (kind === "time_off_change") result = finalizeTimeOffChangeRequest(entry, session.employeeNumber, note);
        else if (kind === "vacation") result = finalizeVacationRequest(entry, session.employeeNumber, note);
        else result = finalizeVacationChangeRequest(entry, session.employeeNumber, note);
      }
    } else if (action === "change" && entry.status === "approved") {
      if (kind === "time_off") {
        const dateFrom = String(request.body.dateFrom || request.body.date || "");
        const dateTo = String(request.body.dateTo || dateFrom);
        const allDay = request.body.allDay === true || Boolean(entry.all_day) || dateTo !== dateFrom;
        const startTime = allDay ? "00:00" : String(request.body.startTime || "");
        const endTime = allDay ? "23:59" : String(request.body.endTime || "");
        if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom
          || (!allDay && (!isTime(startTime) || !isTime(endTime) || endTime <= startTime))) {
          throw httpError(400, "Bitte einen gültigen neuen ZA-Zeitraum eingeben.");
        }
        restoreApprovedTimeOff(entry);
        db.prepare(`UPDATE time_off_requests SET request_date = ?, date_from = ?, date_to = ?, all_day = ?, start_time = ?, end_time = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END, option_id = NULL, original_shifts_json = '[]', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(dateFrom, dateFrom, dateTo, allDay ? 1 : 0, startTime, endTime, note, note, entry.id);
        entry = db.prepare("SELECT * FROM time_off_requests WHERE id = ?").get(entry.id);
        result = finalizeTimeOffRequest(entry, session.employeeNumber, note);
      } else if (kind === "vacation") {
        const dateFrom = String(request.body.dateFrom || "");
        const dateTo = String(request.body.dateTo || "");
        if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) throw httpError(400, "Bitte einen gültigen neuen Urlaubszeitraum eingeben.");
        deleteVacationGroup(entry.vacation_group_id);
        db.prepare(`UPDATE vacation_requests SET date_from = ?, date_to = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(dateFrom, dateTo, note, note, entry.id);
        entry = db.prepare("SELECT * FROM vacation_requests WHERE id = ?").get(entry.id);
        result = finalizeVacationRequest(entry, session.employeeNumber, note);
      } else throw httpError(409, "Dieser Vorgang kann nicht direkt geändert werden.");
    } else if (action === "cancel" && entry.status === "approved") {
      if (kind === "time_off") restoreApprovedTimeOff(entry);
      else if (kind === "vacation") deleteVacationGroup(entry.vacation_group_id);
      else throw httpError(409, "Dieser Vorgang kann nicht direkt storniert werden.");
      db.prepare(`UPDATE ${table} SET status = 'cancelled', approval_stage = 'complete', decision_note = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(note, session.employeeNumber, entry.id);
    } else {
      throw httpError(400, "Bitte eine gültige Entscheidung auswählen.");
    }
    recordRequestDecision(kind, entry.id, stage, action, session.employeeNumber, note);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  auditPortal(session.employeeNumber, `${kind}.${action}`, `${kind}_request`, String(entry.id), note);
  const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entry.id);
  resolveRequestReviewNotifications(kind, entry.id);
  if (updated.status === "pending_hr") notifyRequestReviewers(updated, kind, "hr", session.employeeNumber);
  notifyRequestDecision(updated, kind, updated.status, session.employeeNumber);
  response.json({ ok: true, request: { ...updated, status: publicRequestStatus(updated.status) }, ...result });
});

app.put("/api/portal/v1/time-off-requests/:id/decision", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:review");
  const decision = String(request.body.decision || "");
  if (!["approved", "rejected"].includes(decision)) throw httpError(400, "Bitte genehmigen oder ablehnen.");
  const entry = db.prepare("SELECT * FROM time_off_requests WHERE id = ? AND status IN ('pending','pending_local','preliminary_local')").get(Number(request.params.id));
  if (!entry) throw httpError(404, "Der offene ZA-Antrag wurde nicht gefunden.");
  assertRequestScope(session, entry);
  if (session.role === "hr") throw httpError(403, "Die Personalleitung darf die vorgelagerte Filialfreigabe nicht ersetzen.");
  if (entry.approval_type === "hr") throw httpError(409, "Dieser ZA muss über den zweistufigen Freigabeworkflow bearbeitet werden.");
  let optionId = null;
  if (decision === "approved") {
    const check = evaluateTimeOffRequest(entry.employee_number, {
      date: entry.date_from || entry.request_date,
      dateFrom: entry.date_from || entry.request_date,
      dateTo: entry.date_to || entry.request_date,
      allDay: Boolean(entry.all_day),
      startTime: entry.start_time,
      endTime: entry.end_time,
      excludeRequestId: entry.id,
    });
    if (!check.allowed) throw httpError(409, check.reason, "TIME_OFF_NOT_POSSIBLE");
    db.exec("BEGIN");
    try {
      optionId = insertApprovedTimeOff(entry);
      db.prepare(`
        UPDATE time_off_requests SET status = 'approved', option_id = ?, traffic_light = ?, check_reason = ?,
          decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(optionId, check.trafficLight, check.reason, session.employeeNumber, entry.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    db.prepare(`
      UPDATE time_off_requests SET status = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(session.employeeNumber, entry.id);
  }
  auditPortal(session.employeeNumber, `time_off.request.${decision}`, "time_off_request", String(entry.id));
  recordRequestDecision("time_off", entry.id, "local", decision === "approved" ? "approve" : "reject", session.employeeNumber, "");
  notifyRequestDecision(entry, "time_off", decision, session.employeeNumber);
  response.json({ ok: true, id: entry.id, status: decision, optionId });
});

app.put("/api/portal/v1/vacation-change-requests/:id/decision", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "vacation:approve");
  const decision = String(request.body.decision || "");
  if (!["approved", "rejected"].includes(decision)) throw httpError(400, "Bitte genehmigen oder ablehnen.");
  const entry = db.prepare("SELECT * FROM vacation_change_requests WHERE id = ? AND status IN ('pending','pending_local','preliminary_local')").get(Number(request.params.id));
  if (!entry) throw httpError(404, "Der offene Änderungs- oder Stornoantrag wurde nicht gefunden.");
  entry.location_id = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(entry.employee_number)?.home_location_id;
  assertRequestScope(session, entry);
  if (session.role === "hr") throw httpError(403, "Die Personalleitung darf die vorgelagerte Filialfreigabe nicht ersetzen.");
  if (vacationHrApprovalRequired()) throw httpError(409, "Dieser Antrag muss über den zweistufigen Freigabeworkflow bearbeitet werden.");
  if (decision === "approved") {
    const current = approvedVacationsForEmployee(entry.employee_number, "1900-01-01").find((item) => item.groupId === entry.vacation_group_id);
    if (!current) throw httpError(409, "Der ursprüngliche Urlaub besteht nicht mehr.");
    let replacement = null;
    if (entry.request_type === "change") {
      const availability = evaluateVacationRequest(entry.employee_number, { dateFrom: entry.requested_date_from, dateTo: entry.requested_date_to });
      if (!availability.allowed) throw httpError(409, availability.reason, "REQUEST_BLACKOUT");
      replacement = validateVacationEntry({
        employeeNumber: entry.employee_number,
        dateFrom: entry.requested_date_from,
        dateTo: entry.requested_date_to,
        note: entry.note || current.note,
      }, entry.vacation_group_id);
    }
    db.exec("BEGIN");
    try {
      deleteVacationGroup(entry.vacation_group_id);
      if (replacement) insertVacationEntries(replacement, entry.vacation_group_id);
      db.prepare(`
        UPDATE vacation_change_requests SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(session.employeeNumber, entry.id);
      if (entry.request_type === "change") {
        db.prepare(`
          UPDATE vacation_requests SET date_from = ?, date_to = ?, note = ?, updated_at = CURRENT_TIMESTAMP
          WHERE vacation_group_id = ?
        `).run(entry.requested_date_from, entry.requested_date_to, entry.note || current.note, entry.vacation_group_id);
      } else {
        db.prepare(`
          UPDATE vacation_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE vacation_group_id = ?
        `).run(entry.vacation_group_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    db.prepare(`
      UPDATE vacation_change_requests SET status = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(session.employeeNumber, entry.id);
  }
  auditPortal(session.employeeNumber, `vacation.${entry.request_type}.${decision}`, "vacation_change_request", String(entry.id));
  recordRequestDecision("vacation_change", entry.id, "local", decision === "approved" ? "approve" : "reject", session.employeeNumber, "");
  notifyRequestDecision(entry, "vacation_change", decision, session.employeeNumber);
  response.json({ ok: true, id: entry.id, status: decision });
});

app.get("/api/portal/v1/request-blackouts", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:read");
  response.json({ blackouts: getRequestBlackoutsForSession(actor, false) });
});

app.post("/api/portal/v1/request-blackouts", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:approve");
  const blackout = validateRequestBlackout(request.body);
  assertSessionContextScope(actor, { locationId: blackout.locationId, departmentId: blackout.departmentId });
  const result = db.prepare(`
    INSERT INTO request_blackouts
      (location_id, department_id, date_from, date_to, block_vacation, block_time_off, reason, active, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(blackout.locationId, blackout.departmentId, blackout.dateFrom, blackout.dateTo,
    blackout.blockVacation ? 1 : 0, blackout.blockTimeOff ? 1 : 0, blackout.reason, blackout.active ? 1 : 0, actor.employeeNumber);
  auditPortal(actor.employeeNumber, "request_blackout.create", "request_blackout", String(result.lastInsertRowid));
  response.status(201).json({ blackouts: getRequestBlackoutsForSession(actor, false) });
});

app.put("/api/portal/v1/request-blackouts/:id", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:approve");
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT location_id, department_id FROM request_blackouts WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Antragssperre wurde nicht gefunden.");
  assertSessionContextScope(actor, { locationId: existing.location_id, departmentId: existing.department_id });
  const blackout = validateRequestBlackout(request.body, id);
  assertSessionContextScope(actor, { locationId: blackout.locationId, departmentId: blackout.departmentId });
  db.prepare(`
    UPDATE request_blackouts SET location_id = ?, department_id = ?, date_from = ?, date_to = ?,
      block_vacation = ?, block_time_off = ?, reason = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(blackout.locationId, blackout.departmentId, blackout.dateFrom, blackout.dateTo,
    blackout.blockVacation ? 1 : 0, blackout.blockTimeOff ? 1 : 0, blackout.reason, blackout.active ? 1 : 0, id);
  auditPortal(actor.employeeNumber, "request_blackout.update", "request_blackout", String(id));
  response.json({ blackouts: getRequestBlackoutsForSession(actor, false) });
});

app.delete("/api/portal/v1/request-blackouts/:id", (request, response) => {
  const actor = requirePortalAdminOrLocal(request, "vacation:approve");
  const existing = db.prepare("SELECT location_id, department_id FROM request_blackouts WHERE id = ?").get(Number(request.params.id));
  if (!existing) throw httpError(404, "Die Antragssperre wurde nicht gefunden.");
  assertSessionContextScope(actor, { locationId: existing.location_id, departmentId: existing.department_id });
  const result = db.prepare("DELETE FROM request_blackouts WHERE id = ?").run(Number(request.params.id));
  if (!result.changes) throw httpError(404, "Die Antragssperre wurde nicht gefunden.");
  auditPortal(actor.employeeNumber, "request_blackout.delete", "request_blackout", request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/me/time-entries", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  const date = isIsoDate(request.query.date) ? String(request.query.date) : viennaTodayIso();
  response.json({ status: timeTrackingDayStatus(session.employeeNumber, date) });
});

app.post("/api/portal/v1/me/time-entries", (request, response) => {
  const session = requirePortalSession(request, "own_time:write");
  assertPortalCsrf(request);
  response.status(201).json({ status: bookTimeEntry(session.employeeNumber, String(request.body?.type || "")) });
});

app.get("/api/portal/v1/me/time-summary", (request, response) => {
  const session = requirePortalSession(request, "own_time:read");
  response.json({ summary: ownTimeSummary(session.employeeNumber, String(request.query.period || "week"), String(request.query.anchor || "")) });
});

app.get("/api/portal/v1/me/time-corrections", (request, response) => {
  const session = requirePortalSession(request, "own_time:correction_request");
  response.json({ corrections: timeCorrectionRows("WHERE c.employee_number = ?", [session.employeeNumber]) });
});

app.post("/api/portal/v1/me/time-corrections", (request, response) => {
  const session = requirePortalSession(request, "own_time:correction_request");
  assertPortalCsrf(request);
  response.status(201).json({ correction: createOwnTimeCorrection(session, request.body || {}) });
});

app.put("/api/portal/v1/me/time-corrections/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:correction_request");
  assertPortalCsrf(request);
  response.json({ correction: updateOwnTimeCorrection(session, request.params.id, request.body || {}) });
});

app.delete("/api/portal/v1/me/time-corrections/:id", (request, response) => {
  const session = requirePortalSession(request, "own_time:correction_request");
  assertPortalCsrf(request);
  withdrawOwnTimeCorrection(session, request.params.id);
  response.status(204).end();
});

app.get("/api/portal/v1/time-summary", (request, response) => {
  const session = requirePortalReadOrLocal(request, "time:read");
  const context = resolvePlanningContext(request.query || {});
  assertSessionContextScope(session, context);
  const dateFrom = String(request.query.from || "");
  const dateTo = String(request.query.to || "");
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom || daysBetweenInclusive(dateFrom, dateTo) > 370) {
    throw httpError(400, "Bitte einen gültigen Auswertungszeitraum von höchstens 370 Tagen wählen.", "TIME_SUMMARY_RANGE_INVALID");
  }
  const departmentActivity = context.departmentId ? db.prepare(`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM shifts s
      WHERE s.employee_number = ? AND s.shift_date BETWEEN ? AND ? AND s.department_id = ?
    ) OR EXISTS (
      SELECT 1 FROM time_entries t
      WHERE t.employee_number = ? AND t.work_date BETWEEN ? AND ? AND t.department_id = ? AND t.voided_at IS NULL
    )
  `) : null;
  const employees = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, preferred_department_id
    FROM employees WHERE active = 1 AND home_location_id = ?
    ORDER BY CAST(personnel_number AS INTEGER), personnel_number
  `).all(context.locationId)
    .filter((employee) => !context.departmentId
      || Number(employee.preferred_department_id || 0) === Number(context.departmentId)
      || Boolean(departmentActivity.get(
        employee.personnel_number, dateFrom, dateTo, context.departmentId,
        employee.personnel_number, dateFrom, dateTo, context.departmentId,
      )))
    .map((employee) => {
      const summary = timeSummaryForEmployee(employee.personnel_number, dateFrom, dateTo, "range", new Date(), context.departmentId);
      return {
        employeeNumber: employee.personnel_number,
        fullName: employee.full_name,
        nickname: employee.nickname,
        color: employee.color,
        plannedMinutes: summary.plannedMinutes,
        actualMinutes: summary.actualMinutes,
        differenceMinutes: summary.differenceMinutes,
        incompleteDays: summary.incompleteDays,
      };
    });
  response.json({ summary: { period: "range", from: dateFrom, to: dateTo, dateFrom, dateTo, context, employees } });
});

app.get("/api/portal/v1/time-corrections", (request, response) => {
  const session = requirePortalReadOrLocal(request, "time:review");
  const context = resolvePlanningContext(request.query || {});
  assertSessionContextScope(session, context);
  const status = String(request.query.status || "pending").trim();
  const allowedStatuses = new Set(["pending", "approved", "rejected", "withdrawn", "all"]);
  if (!allowedStatuses.has(status)) throw httpError(400, "Dieser Korrekturstatus ist ungültig.");
  const where = [`c.location_id = ?`];
  const values = [context.locationId];
  if (context.departmentId) {
    where.push("c.department_id = ?");
    values.push(context.departmentId);
  }
  if (status !== "all") {
    where.push("c.status = ?");
    values.push(status);
  }
  const corrections = timeCorrectionRows(`WHERE ${where.join(" AND ")}`, values)
    .filter((correction) => {
      try {
        assertSessionContextScope(session, correction);
        return true;
      } catch {
        return false;
      }
    });
  response.json({ corrections });
});

app.put("/api/portal/v1/time-corrections/:id/decision", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:review");
  response.json({ correction: decideTimeCorrection(session, request.params.id, request.body || {}) });
});

app.get("/api/portal/v1/mobile-layout", (request, response) => {
  const session = requirePortalReadOrLocal(request, "own_time:read");
  response.json(mobileLayoutPayload(session));
});

app.put("/api/portal/v1/mobile-layout", (request, response) => {
  const session = requireAdminHrOrLocal(request, "rights:write");
  const layouts = validateMobileLeadershipLayouts(request.body?.layouts);
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES ('mobile_leadership_layouts', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify(layouts));
  auditPortal(session.employeeNumber, "mobile.layout.update", "portal_settings", "mobile_leadership_layouts", JSON.stringify(layouts));
  response.json(mobileLayoutPayload(session));
});

app.get("/api/portal/v1/leadership/overview", (request, response) => {
  const session = requirePortalReadOrLocal(request, "time:read");
  const context = resolvePlanningContext(request.query || {});
  assertSessionContextScope(session, context);
  response.json({ overview: leadershipOverviewForContext(session, context) });
});

app.post("/api/portal/v1/time-corrections/resolve-stale", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:review");
  const employeeNumber = String(request.body?.employeeNumber || "").trim();
  response.status(201).json({
    status: resolveStaleTimeEntry(
      session,
      employeeNumber,
      String(request.body?.workDate || ""),
      String(request.body?.clockOutTime || ""),
    ),
  });
});

app.get("/api/portal/v1/time-presence", (request, response) => {
  const session = requirePortalAdminOrLocal(request, "time:read");
  const context = resolvePlanningContext(request.query || {});
  const date = isIsoDate(request.query.date) ? String(request.query.date) : viennaTodayIso();
  response.json({ presence: timePresenceForContext(session, context, date) });
});

app.get("/api/settings", (request, response) => {
  if (getPortalStatus().portalEnabled && !request.portalSession?.permissions?.includes("settings:write")) {
    throw httpError(403, "Für die Grundeinstellungen fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  }
  const context = resolvePlanningContext(request.query || {});
  assertSessionContextScope(request.portalSession, context);
  response.json(settingsForLocation(context.locationId));
});

app.get("/api/branding/export", (request, response) => {
  requireAdminHrOrLocal(request, "branding:read");
  const kit = brandingKitForExport(request.query);
  response.setHeader("Content-Disposition", contentDispositionHeader("grabenplaner-branding-kit.json"));
  response.json(kit);
});

app.get("/api/branding/export.zip", (request, response) => {
  requireAdminHrOrLocal(request, "branding:read");
  const kit = brandingKitForExport(request.query);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branding-zip-"));
  const zipPath = path.join(tempRoot, "grabenplaner-branding-kit.zip");
  let exportRoot = null;
  try {
    exportRoot = writeBrandingKitZip(kit, zipPath);
  } catch (error) {
    if (exportRoot) fs.rmSync(exportRoot, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
  response.setHeader("Content-Disposition", contentDispositionHeader("grabenplaner-branding-kit.zip"));
  response.sendFile(zipPath, (error) => {
    if (exportRoot) fs.rmSync(exportRoot, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (error && !response.headersSent) response.status(500).json({ error: "Branding-Kit konnte nicht exportiert werden." });
  });
});

app.get("/api/branding/kits", (request, response) => {
  requireAdminHrOrLocal(request, "branding:read");
  const context = resolvePlanningContext(request.query || {});
  response.json(listBrandingKits(context.locationId));
});

app.get("/api/branding/assignments", (request, response) => {
  requireAdminHrOrLocal(request, "branding:read");
  response.json({ assignments: locationBrandingAssignments() });
});

app.put("/api/branding/assignments", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "branding:write");
  const locationId = normalizeLocationId(request.body.locationId || request.body.location);
  validateLocationExists(locationId);
  const submittedKitId = String(request.body.kitId ?? "").trim();
  if (!submittedKitId) {
    db.prepare("DELETE FROM location_branding WHERE location_id = ?").run(locationId);
    auditPortal(actor.employeeNumber, "branding.assignment.update", "location", locationId, JSON.stringify({ kitId: "default" }));
    response.json({
      ok: true,
      locationId,
      settings: settingsForLocation(locationId),
      branding: brandingForLocation(locationId),
      assignments: locationBrandingAssignments(),
      kits: listBrandingKits(locationId),
    });
    return;
  }
  const kitId = submittedKitId;
  let result;
  if (kitId !== "custom") {
    const kit = readBrandingKitManifest(kitId);
    result = applyBrandingKit(kit, { locationId }, actor.employeeNumber);
  } else {
    const branding = saveLocationBrandingSnapshot(locationId, "custom", request.body.branding || request.body, actor.employeeNumber);
    result = { ok: true, locationId, settings: settingsForLocation(locationId), branding };
  }
  auditPortal(actor.employeeNumber, "branding.assignment.update", "location", locationId, JSON.stringify({ kitId }));
  response.json({ ...result, assignments: locationBrandingAssignments(), kits: listBrandingKits(locationId) });
});

app.post("/api/branding/kits/:kitId/apply", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "branding:write");
  const kit = readBrandingKitManifest(request.params.kitId);
  const context = resolvePlanningContext(request.body || {});
  response.json({
    ...applyBrandingKit(kit, context, actor.employeeNumber),
    kits: listBrandingKits(context.locationId),
  });
});

app.put("/api/branding/import", (request, response) => {
  const actor = requireAdminHrOrLocal(request, "branding:write");
  const kit = request.body?.kit || request.body || {};
  const installedKit = installBrandingKit(kit, { fileName: request.get("X-Branding-Filename") || "branding-kit.json" });
  const context = resolvePlanningContext(request.body || {});
  response.json({
    ...applyBrandingKit(installedKit, context, actor.employeeNumber),
    kit: installedKit,
    kits: listBrandingKits(context.locationId),
  });
});

app.put("/api/branding/import.zip", express.raw({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: "25mb" }), (request, response) => {
  const actor = requireAdminHrOrLocal(request, "branding:write");
  if (!Buffer.isBuffer(request.body) || request.body.length < 128) {
    throw httpError(400, "Bitte eine gültige Branding-ZIP-Datei auswählen.");
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branding-import-"));
  const zipPath = path.join(tempRoot, "branding-kit.zip");
  const extractPath = path.join(tempRoot, "extract");
  try {
    fs.writeFileSync(zipPath, request.body);
    fs.mkdirSync(extractPath, { recursive: true });
    extractZipArchive(zipPath, extractPath);
    const jsonFile = findKitJsonFile(extractPath);
    if (!jsonFile) throw httpError(400, "In der ZIP-Datei wurde keine Branding-Kit-JSON gefunden.");
    const kit = JSON.parse(fs.readFileSync(jsonFile, "utf8").replace(/^\uFEFF/, ""));
    const installedKit = installBrandingKit(kit, {
      extractPath,
      fileName: decodeURIComponent(request.get("X-Branding-Filename") || "branding-kit.zip"),
    });
    const context = resolvePlanningContext(request.query || {});
    response.json({
      ...applyBrandingKit(installedKit, context, actor.employeeNumber),
      kit: installedKit,
      kits: listBrandingKits(context.locationId),
    });
  } catch (error) {
    if (error.status) throw error;
    if (error instanceof SyntaxError) throw httpError(400, "Die Branding-Kit-JSON in der ZIP-Datei ist ungültig.");
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function requestHasPermission(request, permission) {
  if (!getPortalStatus().portalEnabled && isLoopbackRequest(request)) return true;
  return Boolean(request.portalSession?.permissions?.includes(permission));
}

function assertRequestPermission(request, permission) {
  if (!requestHasPermission(request, permission)) {
    throw httpError(403, "Für diese Aktion fehlt die Berechtigung.", "PORTAL_PERMISSION_DENIED");
  }
}

function validateOperationModeRequest(requestedMode) {
  const mode = String(requestedMode || DEFAULT_OPERATION_MODE);
  if (!["local", "lan", "server"].includes(mode)) throw httpError(400, "Der ausgewählte Betriebsmodus ist ungültig.");
  if (mode === "server" && !serverModeActive) {
    throw httpError(409, "Der öffentliche Serverbetrieb wird ausschließlich über die geschützte Serverkonfiguration aktiviert.", "SERVER_CONFIGURATION_REQUIRED");
  }
  if (mode === "lan" && getPortalStatus().adminSetupState !== "configured") {
    throw httpError(409, "Bitte zuerst die Admin-Ersteinrichtung abschließen.", "PORTAL_ADMIN_SETUP_REQUIRED");
  }
  return mode;
}

app.put("/api/operation-mode", (request, response) => {
  assertRequestPermission(request, "operation_mode:write");
  const requestedOperationMode = validateOperationModeRequest(request.body.operationMode);
  const update = db.prepare("INSERT INTO settings (key, value) VALUES ('operation_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  update.run(requestedOperationMode);
  const currentRuntimeMode = configuredOperationMode;
  const restartRequired = !serverModeActive && currentRuntimeMode !== requestedOperationMode;
  if (restartRequired) writeRuntimeConfig({ operationMode: requestedOperationMode });
  auditPortal(request.portalSession?.employeeNumber || "local", "operation_mode.update", "settings", "operation_mode", requestedOperationMode);
  response.json({ operationMode: requestedOperationMode, restartRequired, networkUrls: requestedOperationMode === "lan" ? getLanUrls(PORT) : [] });
});

app.put("/api/settings", (request, response) => {
  const body = request.body;
  const currentSettings = getSettings();
  const requestedOperationMode = validateOperationModeRequest(body.operationMode || currentSettings.operation_mode);
  if (requestedOperationMode !== currentSettings.operation_mode) assertRequestPermission(request, "operation_mode:write");
  const scheduleContext = resolvePlanningContext(body);
  const vacationContext = resolvePlanningContext({ ...body, departmentId: null, department: null });
  const scheduleDefaults = defaultSchedulePdfSettings(scheduleContext);
  const vacationDefaults = defaultVacationPdfSettings(vacationContext);
  const pdfTitle = validatePdfText(body.pdfTitle || scheduleDefaults.pdf_title, "den Dienstplan-PDF-Titel");
  const pdfFilenamePrefix = validatePdfText(body.pdfFilenamePrefix || scheduleDefaults.pdf_filename_prefix, "der Dienstplan-PDF-Dateiname", { min: 5, max: 80 });
  const vacationPdfTitle = validatePdfText(body.vacationPdfTitle || vacationDefaults.vacation_pdf_title, "den Urlaubsplaner-PDF-Titel");
  const vacationPdfFilenamePrefix = validatePdfText(body.vacationPdfFilenamePrefix || vacationDefaults.vacation_pdf_filename_prefix, "der Urlaubsplaner-PDF-Dateiname", { min: 5, max: 80 });
  const externalBackupEnabled = body.externalBackupEnabled !== false;
  const backupDirectory = externalBackupEnabled
    ? validateBackupDirectory(body.backupDirectory || defaultBackupDirectorySetting)
    : { stored: String(body.backupDirectory || defaultBackupDirectorySetting).trim() || defaultBackupDirectorySetting };
  const backupIntervalHours = Number(body.backupIntervalHours || 2);
  const vacationPdfCalendarStyle = ["bars", "dots"].includes(String(body.vacationPdfCalendarStyle))
    ? String(body.vacationPdfCalendarStyle)
    : "bars";
  const breakAfterMinutes = Number(body.breakAfterMinutes);
  const breakDurationMinutes = Number(body.breakDurationMinutes);
  const saturdayBonusFrom = String(body.saturdayBonusFrom || "");
  const saturdayBonusFactor = Number(body.saturdayBonusFactor);
  const toastDuration = ["short", "medium", "long"].includes(String(body.toastDuration))
    ? String(body.toastDuration)
    : "medium";
  const brandingValues = brandingValuesFromBody(body.branding || body);
  const brandingSubmitted = Boolean(body.branding);
  if (brandingSubmitted && !(request.portalSession?.role === "admin" || request.portalSession?.role === "hr" || (!getPortalStatus().portalEnabled && isLoopbackRequest(request)))) {
    throw httpError(403, "Branding darf nur durch Admin oder Personalleitung geändert werden.", "PORTAL_PERMISSION_DENIED");
  }
  const currentWeekLockMode = body.currentWeekLockMode === "manual" ? "manual" : "closing";
  const currentWeekLockDay = ["friday", "saturday", "sunday"].includes(String(body.currentWeekLockDay)) ? String(body.currentWeekLockDay) : "saturday";
  const currentWeekLockTime = String(body.currentWeekLockTime || "17:00");

  if (!Number.isInteger(backupIntervalHours) || backupIntervalHours < 1 || backupIntervalHours > 6) {
    throw httpError(400, "Das Backup-Intervall muss zwischen 1 und 6 Stunden liegen.");
  }
  if (!Number.isInteger(breakAfterMinutes) || breakAfterMinutes < 0 || breakAfterMinutes > 1440) {
    throw httpError(400, "Die Pausengrenze ist ungültig.");
  }
  if (!Number.isInteger(breakDurationMinutes) || breakDurationMinutes < 0 || breakDurationMinutes > 240) {
    throw httpError(400, "Die Pausendauer ist ungültig.");
  }
  if (!isTime(saturdayBonusFrom)) throw httpError(400, "Die Startzeit für den Samstagsfaktor ist ungültig.");
  if (!Number.isFinite(saturdayBonusFactor) || saturdayBonusFactor < 1 || saturdayBonusFactor > 5) {
    throw httpError(400, "Der Samstagsfaktor muss zwischen 1 und 5 liegen.");
  }
  if (!isTime(currentWeekLockTime)) throw httpError(400, "Der Sperrzeitpunkt ist ungültig.");
  const lockOrder = { friday: 5, saturday: 6, sunday: 7 }[currentWeekLockDay] * 1440 + timeToMinutes(currentWeekLockTime);
  if (currentWeekLockMode === "manual" && (lockOrder < 5 * 1440 + 18 * 60 || lockOrder > 7 * 1440 + 23 * 60)) {
    throw httpError(400, "Der manuelle Sperrzeitpunkt muss zwischen Freitag 18:00 Uhr und Sonntag 23:00 Uhr liegen.");
  }
  const backupChanged = String(currentSettings.external_backup_enabled || "1") !== (externalBackupEnabled ? "1" : "0")
    || String(currentSettings.backup_directory || "") !== backupDirectory.stored
    || String(currentSettings.backup_interval_hours || "2") !== String(backupIntervalHours);
  if (backupChanged) assertRequestPermission(request, "backup:write");

  const values = {
    operation_mode: requestedOperationMode,
    toast_duration: toastDuration,
    show_inactive_personnel: body.showInactivePersonnel === true ? "1" : "0",
    show_saturday_service_stats: body.showSaturdayServiceStats === false ? "0" : "1",
    external_backup_enabled: externalBackupEnabled ? "1" : "0",
    backup_directory: backupDirectory.stored,
    backup_interval_hours: String(backupIntervalHours),
    vacation_count_saturday: body.vacationCountSaturday === true ? "1" : "0",
    vacation_pdf_size: "A4",
    allow_past_week_editing: body.allowPastWeekEditing === true ? "1" : "0",
    current_week_auto_lock: body.currentWeekAutoLock === false ? "0" : "1",
    current_week_lock_mode: currentWeekLockMode,
    current_week_lock_day: currentWeekLockDay,
    current_week_lock_time: currentWeekLockTime,
    break_rule_enabled: body.breakRuleEnabled === false ? "0" : "1",
    break_after_minutes: String(breakAfterMinutes),
    break_duration_minutes: String(breakDurationMinutes),
    saturday_bonus_enabled: body.saturdayBonusEnabled === false ? "0" : "1",
    saturday_bonus_from: saturdayBonusFrom,
    saturday_bonus_factor: String(saturdayBonusFactor),
    show_sunday: body.showSunday === true ? "1" : "0",
  };
  const update = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(values)) update.run(key, value);
    if (brandingSubmitted) saveLocationBrandingSnapshot(scheduleContext.locationId, "custom", brandingValues, request.portalSession?.employeeNumber || "local");
    saveScopedPdfSettings("schedule", scheduleContext, {
      pdf_title: pdfTitle,
      pdf_filename_prefix: pdfFilenamePrefix,
      pdf_filename_include_kw: body.pdfFilenameIncludeKw === false ? "0" : "1",
      pdf_filename_include_timestamp: body.pdfFilenameIncludeTimestamp === true ? "1" : "0",
    });
    saveScopedPdfSettings("vacation", vacationContext, {
      vacation_pdf_title: vacationPdfTitle,
      vacation_pdf_filename_prefix: vacationPdfFilenamePrefix,
      vacation_pdf_filename_include_period: body.vacationPdfFilenameIncludePeriod === false ? "0" : "1",
      vacation_pdf_filename_include_timestamp: body.vacationPdfFilenameIncludeTimestamp === true ? "1" : "0",
      vacation_pdf_show_balance: body.vacationPdfShowBalance === false ? "0" : "1",
      vacation_pdf_balance_show_entitlement: body.vacationPdfBalanceShowEntitlement === false ? "0" : "1",
      vacation_pdf_balance_show_planned: body.vacationPdfBalanceShowPlanned === false ? "0" : "1",
      vacation_pdf_balance_show_consumed: body.vacationPdfBalanceShowConsumed === true ? "1" : "0",
      vacation_pdf_calendar_style: vacationPdfCalendarStyle,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  scheduleAutomaticBackups();
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at) VALUES ('login_required', '1', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP
  `).run();
  const currentRuntimeMode = configuredOperationMode;
  const restartRequired = !serverModeActive && currentRuntimeMode !== requestedOperationMode;
  if (restartRequired) writeRuntimeConfig({ operationMode: requestedOperationMode });
  response.json({ ...settingsForLocation(scheduleContext.locationId), restartRequired, networkUrls: requestedOperationMode === "lan" ? getLanUrls(PORT) : [] });
});

app.post("/api/shifts", (request, response) => {
  const shift = validateShift(request.body);
  const locationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(shift.employeeNumber)?.home_location_id;
  assertSessionContextScope(request.portalSession, { locationId, departmentId: shift.departmentId });
  const result = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(shift.employeeNumber, shift.departmentId, shift.shiftDate, shift.startTime, shift.endTime, shift.area, shift.note);
  response.status(201).json({ id: Number(result.lastInsertRowid), ...shift });
});

app.put("/api/shifts/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT s.shift_date, s.department_id, e.home_location_id FROM shifts s JOIN employees e ON e.personnel_number = s.employee_number WHERE s.id = ?").get(id);
  if (!existing) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  assertSessionContextScope(request.portalSession, { locationId: existing.home_location_id, departmentId: existing.department_id });
  assertDateEditable(existing.shift_date, settingsForLocation(existing.home_location_id));
  const shift = validateShift(request.body);
  const nextLocationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(shift.employeeNumber)?.home_location_id;
  assertSessionContextScope(request.portalSession, { locationId: nextLocationId, departmentId: shift.departmentId });
  const result = db.prepare(`
    UPDATE shifts
    SET employee_number = ?, department_id = ?, shift_date = ?, start_time = ?, end_time = ?, area = ?, note = ?
    WHERE id = ?
  `).run(shift.employeeNumber, shift.departmentId, shift.shiftDate, shift.startTime, shift.endTime, shift.area, shift.note, id);
  if (!result.changes) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  response.json({ id, ...shift });
});

app.delete("/api/shifts/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT s.shift_date, s.department_id, e.home_location_id FROM shifts s JOIN employees e ON e.personnel_number = s.employee_number WHERE s.id = ?").get(id);
  if (!existing) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  assertSessionContextScope(request.portalSession, { locationId: existing.home_location_id, departmentId: existing.department_id });
  assertDateEditable(existing.shift_date, settingsForLocation(existing.home_location_id));
  const result = db.prepare("DELETE FROM shifts WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  response.status(204).end();
});

app.delete("/api/schedule", (request, response) => {
  const weekStart = getMonday(isIsoDate(request.query.week) ? request.query.week : undefined);
  const weekEnd = addDays(weekStart, 6);
  const context = resolvePlanningContext(request.query);
  assertSessionContextScope(request.portalSession, context);
  assertWeekEditable(weekStart, settingsForLocation(context.locationId));
  const departmentFilter = context.departmentId ? "AND department_id = ?" : "";
  const params = context.departmentId
    ? [weekStart, weekEnd, context.locationId, context.departmentId]
    : [weekStart, weekEnd, context.locationId];
  const result = db.prepare(`
    DELETE FROM shifts
    WHERE shift_date BETWEEN ? AND ?
      AND employee_number IN (SELECT personnel_number FROM employees WHERE home_location_id = ?)
      ${departmentFilter}
  `).run(...params);
  response.json({ deleted: Number(result.changes), weekStart, weekEnd });
});

app.post("/api/week-options", (request, response) => {
  const option = validateWeekOption(request.body);
  assertSessionEmployeeScope(request.portalSession, option.employeeNumber);
  const result = db.prepare(`
    INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type, note, credited_minutes_per_day, all_day, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    option.employeeNumber,
    option.groupId,
    option.weekStart,
    option.dateFrom,
    option.dateTo,
    option.optionType,
    option.note,
    option.creditedMinutesPerDay,
    option.allDay,
    option.startTime,
    option.endTime,
  );
  response.status(201).json({ id: Number(result.lastInsertRowid), ...option });
});

app.put("/api/week-options/:id", (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Die Planungsoption ist ungültig.");
  const existing = db.prepare("SELECT group_id, week_start, employee_number FROM week_options WHERE id = ?").get(id);
  if (!existing) {
    throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  }
  assertSessionEmployeeScope(request.portalSession, existing.employee_number);
  const existingLocation = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(existing.employee_number)?.home_location_id;
  assertWeekEditable(existing.week_start, settingsForLocation(existingLocation));
  const option = validateWeekOption({
    ...request.body,
    groupId: request.body.groupId === undefined ? existing.group_id : request.body.groupId,
  }, id);
  assertSessionEmployeeScope(request.portalSession, option.employeeNumber);
  db.prepare(`
    UPDATE week_options
    SET employee_number = ?, group_id = ?, week_start = ?, date_from = ?, date_to = ?,
        option_type = ?, note = ?, credited_minutes_per_day = ?, all_day = ?, start_time = ?, end_time = ?
    WHERE id = ?
  `).run(
    option.employeeNumber,
    option.groupId,
    option.weekStart,
    option.dateFrom,
    option.dateTo,
    option.optionType,
    option.note,
    option.creditedMinutesPerDay,
    option.allDay,
    option.startTime,
    option.endTime,
    id,
  );
  response.json({ id, ...option });
});

app.delete("/api/week-options/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT week_start, employee_number FROM week_options WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  assertSessionEmployeeScope(request.portalSession, existing.employee_number);
  const existingLocation = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = ?").get(existing.employee_number)?.home_location_id;
  assertWeekEditable(existing.week_start, settingsForLocation(existingLocation));
  const result = db.prepare("DELETE FROM week_options WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  response.status(204).end();
});

app.post("/api/global-day-blocks", (request, response) => {
  const block = validateGlobalDayBlock(request.body);
  assertSessionContextScope(request.portalSession, { locationId: block.locationId });
  const result = db.prepare(`
    INSERT INTO global_day_blocks (location_id, week_start, block_date, reason, is_public_holiday)
    VALUES (?, ?, ?, ?, ?)
  `).run(block.locationId, block.weekStart, block.blockDate, block.reason, block.isPublicHoliday);
  response.status(201).json({ id: Number(result.lastInsertRowid), ...block, schedule: getSchedule(block.weekStart, { locationId: block.locationId }, request.portalSession) });
});

app.put("/api/global-day-blocks/:id", (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Der Sperrtag ist ungültig.");
  const existing = db.prepare("SELECT week_start, location_id FROM global_day_blocks WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  assertSessionContextScope(request.portalSession, { locationId: existing.location_id });
  assertWeekEditable(existing.week_start, settingsForLocation(existing.location_id));
  const block = validateGlobalDayBlock(request.body, id);
  assertSessionContextScope(request.portalSession, { locationId: block.locationId });
  db.prepare(`
    UPDATE global_day_blocks
    SET location_id = ?, week_start = ?, block_date = ?, reason = ?, is_public_holiday = ?
    WHERE id = ?
  `).run(block.locationId, block.weekStart, block.blockDate, block.reason, block.isPublicHoliday, id);
  response.json({ id, ...block, schedule: getSchedule(block.weekStart, { locationId: block.locationId }, request.portalSession) });
});

app.delete("/api/global-day-blocks/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT week_start, location_id FROM global_day_blocks WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  assertSessionContextScope(request.portalSession, { locationId: existing.location_id });
  assertWeekEditable(existing.week_start, settingsForLocation(existing.location_id));
  const result = db.prepare("DELETE FROM global_day_blocks WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  response.status(204).end();
});

app.get("/api/vacations", (request, response) => {
  response.json(getVacationPlan(request.query.year, request.query, request.portalSession));
});

app.put("/api/vacation-entitlements", (request, response) => {
  const year = validateYear(request.body.year);
  const entries = Array.isArray(request.body.entries) ? request.body.entries : [];
  const employeeExists = db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?");
  const upsert = db.prepare(`
    INSERT INTO vacation_entitlements (employee_number, year, days, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, year)
    DO UPDATE SET days = excluded.days, updated_at = CURRENT_TIMESTAMP
  `);

  db.exec("BEGIN");
  try {
    for (const entry of entries) {
      const employeeNumber = String(entry.employeeNumber || "").trim();
      const days = Number(entry.days || 0);
      if (!employeeExists.get(employeeNumber)) {
        throw httpError(404, "Ein ausgewähltes Teammitglied wurde nicht gefunden.");
      }
      assertSessionEmployeeScope(request.portalSession, employeeNumber);
      if (!Number.isFinite(days) || days < 0 || days > 365) {
        throw httpError(400, "Der Jahresurlaub muss zwischen 0 und 365 Tagen liegen.");
      }
      upsert.run(employeeNumber, year, days);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  response.json(getVacationPlan(year, request.body, request.portalSession));
});

app.post("/api/vacations", (request, response) => {
  const vacation = validateVacationEntry(request.body);
  assertSessionEmployeeScope(request.portalSession, vacation.employeeNumber);
  const result = createVacationEntries(vacation);
  response.status(201).json({
    groupId: result.groupId,
    plan: getVacationPlan(new Date(`${vacation.dateFrom}T12:00:00Z`).getUTCFullYear(), request.body, request.portalSession),
  });
});

app.put("/api/vacations/:groupId", (request, response) => {
  const groupId = String(request.params.groupId || "").trim();
  if (!groupId || !vacationGroupExists(groupId)) {
    throw httpError(404, "Der Urlaubseintrag wurde nicht gefunden.");
  }
  const existingEmployee = db.prepare("SELECT employee_number FROM week_options WHERE group_id = ? LIMIT 1").get(groupId)?.employee_number;
  assertSessionEmployeeScope(request.portalSession, existingEmployee);
  const vacation = validateVacationEntry(request.body, groupId);
  assertSessionEmployeeScope(request.portalSession, vacation.employeeNumber);
  const result = replaceVacationGroup(groupId, vacation);
  response.json({
    groupId: result.groupId,
    plan: getVacationPlan(new Date(`${vacation.dateFrom}T12:00:00Z`).getUTCFullYear(), request.body, request.portalSession),
  });
});

app.delete("/api/vacations/:groupId", (request, response) => {
  const existingEmployee = db.prepare("SELECT employee_number FROM week_options WHERE group_id = ? LIMIT 1").get(request.params.groupId)?.employee_number;
  if (!existingEmployee) throw httpError(404, "Der Urlaubseintrag wurde nicht gefunden.");
  assertSessionEmployeeScope(request.portalSession, existingEmployee);
  const result = deleteVacationGroup(request.params.groupId);
  if (!result) throw httpError(404, "Der Urlaubseintrag wurde nicht gefunden.");
  response.status(204).end();
});

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function shiftCoversPeriod(shift, from, to) {
  return shift.start_time <= from && shift.end_time >= to;
}

function findBestAutomaticShift(employeeNumber, date, remainingMinutes, settings, requiredTo = null) {
  const hours = operatingHours(date, settings);
  if (!hours) return null;
  const start = timeToMinutes(hours.start);
  const end = timeToMinutes(hours.end);
  const minimumEnd = requiredTo ? Math.max(start + 60, timeToMinutes(requiredTo)) : start + 60;
  let best = null;

  for (let candidateEnd = minimumEnd; candidateEnd <= end; candidateEnd += 1) {
    const shift = {
      employee_number: employeeNumber,
      shift_date: date,
      start_time: minutesToTime(start),
      end_time: minutesToTime(candidateEnd),
    };
    const metrics = shiftMetrics(shift, settings);
    const difference = Math.abs(metrics.counted_minutes - remainingMinutes);
    if (!best || difference < best.difference) best = { shift, metrics, difference };
  }
  return best;
}

app.post("/api/schedule/auto", (request, response) => {
  const weekStart = getMonday(isIsoDate(request.body.weekStart) ? request.body.weekStart : undefined);
  const weekEnd = addDays(weekStart, 6);
  const replaceExisting = request.body.replaceExisting === true;
  const context = resolvePlanningContext(request.body);
  assertSessionContextScope(request.portalSession, context);
  const settings = settingsForLocation(context.locationId);
  const employeeFilter = employeeLocationFilterSql(context, "e");
  assertWeekEditable(weekStart, settings);
  const globalDayBlocks = getGlobalDayBlocksForRange(weekStart, weekEnd, context.locationId);
  const globalBlockDates = new Set(globalDayBlocks.map((block) => block.block_date));
  const employees = db.prepare(`
    SELECT e.personnel_number, e.contracted_hours, e.preferred_day_off, e.fixed_workdays, e.home_location_id, e.preferred_department_id
    FROM employees e
    WHERE e.active = 1 AND ${employeeFilter.sql}
    ORDER BY CAST(e.personnel_number AS INTEGER), e.personnel_number
  `).all(...employeeFilter.values);
  const insertShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    if (replaceExisting) {
      const departmentFilter = context.departmentId ? "AND department_id = ?" : "";
      const params = context.departmentId
        ? [weekStart, weekEnd, context.locationId, context.departmentId]
        : [weekStart, weekEnd, context.locationId];
      db.prepare(`
        DELETE FROM shifts
        WHERE shift_date BETWEEN ? AND ?
          AND employee_number IN (SELECT personnel_number FROM employees WHERE home_location_id = ?)
          ${departmentFilter}
      `).run(...params);
    }

    const shiftDepartmentFilter = context.departmentId ? "AND s.department_id = ?" : "";
    const existingShiftValues = context.departmentId
      ? [weekStart, weekEnd, context.locationId, context.departmentId]
      : [weekStart, weekEnd, context.locationId];
    const existingShifts = db.prepare(`
      SELECT s.employee_number, s.department_id, s.shift_date, s.start_time, s.end_time
      FROM shifts s
      JOIN employees e ON e.personnel_number = s.employee_number
      WHERE s.shift_date BETWEEN ? AND ?
        AND e.home_location_id = ?
        ${shiftDepartmentFilter}
    `).all(...existingShiftValues);
    const options = db.prepare(`
      SELECT o.employee_number, o.date_from, o.date_to, o.option_type,
             o.credited_minutes_per_day, o.all_day, o.start_time, o.end_time,
             e.contracted_hours
      FROM week_options o
      JOIN employees e ON e.personnel_number = o.employee_number
      WHERE o.week_start = ? AND ${employeeFilter.sql}
    `).all(weekStart, ...employeeFilter.values);
    const occupied = new Set(existingShifts.map((shift) => `${shift.employee_number}|${shift.shift_date}`));
    const unavailable = new Set();
    for (const option of options) {
      for (let date = option.date_from; date <= option.date_to; date = addDays(date, 1)) {
        unavailable.add(`${option.employee_number}|${date}`);
      }
    }

    const totals = Object.fromEntries(employees.map((employee) => [employee.personnel_number, 0]));
    const dayLoads = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [addDays(weekStart, index), 0]));
    for (const shift of existingShifts) {
      totals[shift.employee_number] =
        (totals[shift.employee_number] || 0) + shiftMetrics(shift, settings).counted_minutes;
      if (dayLoads[shift.shift_date] !== undefined) dayLoads[shift.shift_date] += 1;
    }
    for (const option of options) {
      totals[option.employee_number] =
        (totals[option.employee_number] || 0) +
        optionMinutesPerDay(option, option.contracted_hours) * countCreditedOptionDays(option, settings, context.locationId);
    }
    const creditedHolidayDates = new Set();
    for (const holiday of publicHolidaysForRange(weekStart, weekEnd)) {
      if ([0, 6].includes(new Date(`${holiday.date}T12:00:00Z`).getUTCDay())) continue;
      for (const employee of employees) {
        if (hasNonVacationCreditOnDate(options, employee.personnel_number, holiday.date)) continue;
        totals[employee.personnel_number] =
          (totals[employee.personnel_number] || 0) + holidayCreditMinutes(employee);
      }
      creditedHolidayDates.add(holiday.date);
    }
    for (const block of globalDayBlocks) {
      if (!block.is_public_holiday || creditedHolidayDates.has(block.block_date)) continue;
      if ([0, 6].includes(new Date(`${block.block_date}T12:00:00Z`).getUTCDay())) continue;
      for (const employee of employees) {
        if (hasNonVacationCreditOnDate(options, employee.personnel_number, block.block_date)) continue;
        totals[employee.personnel_number] =
          (totals[employee.personnel_number] || 0) + holidayCreditMinutes(employee);
      }
    }

    let created = 0;
    const warnings = [];
    const remainingByEmployee = Object.fromEntries(
      employees.map((employee) => [
        employee.personnel_number,
        Math.max(0, Number(employee.contracted_hours) * 60 - (totals[employee.personnel_number] || 0)),
      ]),
    );
    const automaticDepartmentId = (employee) => context.departmentId || employee.preferred_department_id || null;

    for (let dayIndex = 0; dayIndex < 6; dayIndex += 1) {
      const date = addDays(weekStart, dayIndex);
      if (globalBlockDates.has(date)) continue;
      const config = dayConfiguration(date, settings, context);
      let coverage = existingShifts.filter(
        (shift) => shift.shift_date === date && shiftCoversPeriod(shift, config.minFrom, config.minTo),
      ).length;

      while (coverage < config.minStaff) {
        const candidates = employees
          .filter((employee) => !occupied.has(`${employee.personnel_number}|${date}`))
          .filter((employee) => !unavailable.has(`${employee.personnel_number}|${date}`))
          .filter((employee) => employeeCanWorkOnDate(employee, date))
          .sort((a, b) => {
            const aPreferred = a.preferred_day_off === config.key ? 1 : 0;
            const bPreferred = b.preferred_day_off === config.key ? 1 : 0;
            if (aPreferred !== bPreferred) return aPreferred - bPreferred;
            return remainingByEmployee[b.personnel_number] - remainingByEmployee[a.personnel_number];
          });
        const employee = candidates[0];
        if (!employee) break;
        const candidate = findBestAutomaticShift(
          employee.personnel_number,
          date,
          remainingByEmployee[employee.personnel_number],
          settings,
          config.minTo,
        );
        if (!candidate) break;
        insertShift.run(
          employee.personnel_number,
          automaticDepartmentId(employee),
          date,
          candidate.shift.start_time,
          candidate.shift.end_time,
          "Mindestbesetzung",
          "Automatisch erstellt",
        );
        occupied.add(`${employee.personnel_number}|${date}`);
        existingShifts.push(candidate.shift);
        created += 1;
        coverage += 1;
        dayLoads[date] += 1;
        remainingByEmployee[employee.personnel_number] = Math.max(
          0,
          remainingByEmployee[employee.personnel_number] - candidate.metrics.counted_minutes,
        );
      }
      if (coverage < config.minStaff) {
        warnings.push(
          `${date}: Mindestbesetzung ${config.minStaff} von ${config.minFrom} bis ${config.minTo} nicht erreichbar.`,
        );
      }
    }

    employees.forEach((employee, employeeIndex) => {
      let remaining = remainingByEmployee[employee.personnel_number];
      const availableDates = Array.from({ length: 6 }, (_, index) => addDays(weekStart, index))
        .filter((date) => !globalBlockDates.has(date))
        .filter((date) => !occupied.has(`${employee.personnel_number}|${date}`))
        .filter((date) => !unavailable.has(`${employee.personnel_number}|${date}`))
        .filter((date) => employeeCanWorkOnDate(employee, date));

      while (remaining >= 30 && availableDates.length) {
        availableDates.sort((a, b) => {
          const preferredDifference =
            Number(dayKeyForDate(a) === employee.preferred_day_off) -
            Number(dayKeyForDate(b) === employee.preferred_day_off);
          if (preferredDifference) return preferredDifference;
          const loadDifference = dayLoads[a] - dayLoads[b];
          if (loadDifference) return loadDifference;
          const rotatedA = (Number(a.slice(-2)) + employeeIndex) % 6;
          const rotatedB = (Number(b.slice(-2)) + employeeIndex) % 6;
          return rotatedA - rotatedB;
        });
        const date = availableDates.shift();
        const candidate = findBestAutomaticShift(employee.personnel_number, date, remaining, settings);
        if (!candidate) continue;
        insertShift.run(
          employee.personnel_number,
          automaticDepartmentId(employee),
          date,
          candidate.shift.start_time,
          candidate.shift.end_time,
          "Automatisch geplant",
          "Automatisch erstellt",
        );
        created += 1;
        occupied.add(`${employee.personnel_number}|${date}`);
        dayLoads[date] += 1;
        remaining = Math.max(0, remaining - candidate.metrics.counted_minutes);
      }
      if (remaining >= 30) {
        warnings.push(`${employee.personnel_number}: ${formatHours(remaining)} konnten nicht eingeplant werden.`);
      }
    });

    db.exec("COMMIT");
    response.json({ created, warnings, schedule: getSchedule(weekStart, context, request.portalSession) });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
});

function formatDateGerman(isoDate, withYear = true) {
  return new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function formatHours(minutes) {
  return `${(minutes / 60).toLocaleString("de-AT", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} h`;
}

function formatPdfTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Vienna",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("day")}.${value("month")}.${value("year")}, ${value("hour")}:${value("minute")}`;
}

function formatFilenameTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Vienna",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}_${value("hour")}-${value("minute")}`;
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function buildPdfFilename(schedule, createdAt = new Date()) {
  const prefix = sanitizeFilenamePart(schedule.settings.pdf_filename_prefix || schedule.settings.pdf_title || "Dienstplan");
  const parts = [prefix || "Dienstplan"];
  if (settingEnabled(schedule.settings, "pdf_filename_include_kw")) parts.push(`KW${schedule.calendarWeek}`);
  if (settingEnabled(schedule.settings, "pdf_filename_include_timestamp")) parts.push(formatFilenameTimestamp(createdAt));
  return `${parts.join(" ")}.pdf`;
}

function contentDispositionHeader(filename) {
  const fallback = sanitizeFilenamePart(
    filename.normalize("NFKD").replace(/[^\x20-\x7E]/g, ""),
  ).replace(/"/g, "") || "Dienstplan.pdf";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function optionLabel(type) {
  return {
    vacation: "Urlaub",
    sick: "Krank",
    branch: "Andere Filiale",
    vocational_school: "Berufsschule",
    school: "Schulung",
    time_off: "Zeitausgleich",
    special_leave: "Sonderurlaub",
    external_appointment: "Außer-Haus-Termin",
    team_meeting: "Teamsitzung",
    other: "Sonstiges",
  }[type] || type;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function contrastColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 155 ? "#15202f" : "#ffffff";
}

function formatOptionDateRange(option) {
  return option.date_from === option.date_to
    ? formatDateGerman(option.date_from, false)
    : `${formatDateGerman(option.date_from, false)}–${formatDateGerman(option.date_to, false)}`;
}

function formatOptionTimeRange(option) {
  return optionIsAllDay(option) ? "ganztägig" : `${option.start_time}–${option.end_time}`;
}

function optionRemarkColumn(option) {
  if (["vacation", "time_off", "special_leave"].includes(option.option_type)) return "leave";
  if (["vocational_school", "school"].includes(option.option_type)) return "school";
  return "other";
}

function optionRemarkText(option) {
  if (option.global_day) {
    return `Alle: ${option.reason || option.holiday_name || "Tag gesperrt"} · ${formatDateGerman(option.block_date, false)}${
      option.is_public_holiday ? " · Feiertag" : ""
    }`;
  }
  return `${option.nickname}: ${optionLabel(option.option_type)} · ${formatOptionDateRange(option)} · ${formatOptionTimeRange(option)}${
    option.note ? ` · ${option.note}` : ""
  }`;
}

function monthName(monthNumber, format = "long") {
  return new Intl.DateTimeFormat("de-AT", { month: format, timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, monthNumber - 1, 1, 12)),
  );
}

function vacationSelectionFromQuery(query) {
  const year = validateYear(query.year);
  const view = ["year", "quarter", "month", "employees"].includes(String(query.view)) ? String(query.view) : "year";
  let start = `${year}-01-01`;
  let end = `${year}-12-31`;
  let title = `Jahresübersicht ${year}`;
  let months = Array.from({ length: 12 }, (_item, index) => index + 1);

  if (view === "employees") {
    title = `Teamübersicht ${year}`;
  }

  if (view === "quarter") {
    const quarter = Math.min(4, Math.max(1, Number.parseInt(query.quarter, 10) || 1));
    const startMonth = (quarter - 1) * 3 + 1;
    start = monthStart(year, startMonth - 1);
    end = monthEnd(year, startMonth + 1);
    title = `${quarter}. Quartal ${year}`;
    months = [startMonth, startMonth + 1, startMonth + 2];
  }

  if (view === "month") {
    const month = Math.min(12, Math.max(1, Number.parseInt(query.month, 10) || 1));
    start = monthStart(year, month - 1);
    end = monthEnd(year, month - 1);
    title = `${monthName(month)} ${year}`;
    months = [month];
  }

  return { year, view, start, end, title, months };
}

function buildVacationPdfFilename(settings, selection, createdAt = new Date()) {
  const prefix = sanitizeFilenamePart(settings.vacation_pdf_filename_prefix || settings.vacation_pdf_title || "Urlaubsplanung");
  const parts = [prefix || "Urlaubsplanung"];
  if (settingEnabled(settings, "vacation_pdf_filename_include_period")) {
    parts.push(selection.view === "year" ? `Jahr ${selection.year}` : selection.title);
  }
  if (settingEnabled(settings, "vacation_pdf_filename_include_timestamp")) {
    parts.push(formatFilenameTimestamp(createdAt));
  }
  return `${parts.join(" ")}.pdf`;
}

function filteredVacationsForSelection(plan, selection) {
  return plan.vacations
    .filter((vacation) => overlapDateRange(vacation.date_from, vacation.date_to, selection.start, selection.end))
    .map((vacation) => {
      const clippedFrom = vacation.date_from < selection.start ? selection.start : vacation.date_from;
      const clippedTo = vacation.date_to > selection.end ? selection.end : vacation.date_to;
      return {
        ...vacation,
        selection_days: vacationDayCount(clippedFrom, clippedTo, plan.settings, plan.context?.locationId),
        selection_from: clippedFrom,
        selection_to: clippedTo,
      };
    });
}

function vacationDateRangeText(from, to, withYear = false) {
  return from === to
    ? formatDateGerman(from, withYear)
    : `${formatDateGerman(from, withYear)}–${formatDateGerman(to, withYear)}`;
}

function formatVacationDays(days) {
  return `${Number(days || 0).toLocaleString("de-AT", { minimumFractionDigits: days % 1 ? 1 : 0, maximumFractionDigits: 1 })} T`;
}

function formatVacationDaysLong(days) {
  const value = Number(days || 0);
  const formatted = value.toLocaleString("de-AT", {
    minimumFractionDigits: value % 1 ? 1 : 0,
    maximumFractionDigits: 1,
  });
  return `${formatted} ${value === 1 ? "Tag" : "Tage"}`;
}

function formatShortDateGerman(date = new Date()) {
  return new Intl.DateTimeFormat("de-AT", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "Europe/Vienna",
  }).format(date);
}

function vacationWeeksText(days) {
  const value = Math.max(0, Number(days || 0));
  const weeks = Math.floor(value / 5);
  const remainder = value - weeks * 5;
  const dayText = formatVacationDaysLong(remainder);
  return `${weeks} ${weeks === 1 ? "Woche" : "Wochen"} ${dayText}`;
}

function formatVacationDaysWithWeeks(days) {
  return `${formatVacationDaysLong(days)} (${vacationWeeksText(days)})`;
}

function monthCalendarRange(year, monthNumber) {
  const first = monthStart(year, monthNumber - 1);
  const last = monthEnd(year, monthNumber - 1);
  const start = getMonday(first);
  const end = addDays(getMonday(last), 6);
  return { start, end };
}

function vacationsOnDate(vacations, date) {
  return vacations.filter((vacation) => date >= vacation.date_from && date <= vacation.date_to);
}

function drawVacationBars(doc, plan, vacations, monthFrom, monthTo, cells, compact) {
  const laneEmployees = compact
    ? [...new Set(vacations.map((vacation) => vacation.employee_number))]
    : plan.employees.map((employee) => employee.personnel_number);
  const employeeIndex = Object.fromEntries(laneEmployees.map((employeeNumber, index) => [employeeNumber, index]));
  const laneCount = Math.max(1, compact ? laneEmployees.length : Math.min(plan.employees.length, 8));
  const sampleCell = Object.values(cells)[0];
  const availableLaneHeight = Math.max(6, (sampleCell?.height || (compact ? 18 : 36)) - (compact ? 13 : 17));
  const barGap = compact ? 0.55 : 1.2;
  const barHeight = compact
    ? Math.max(1.15, Math.min(2.6, availableLaneHeight / laneCount - barGap))
    : Math.max(3.4, Math.min(6.2, availableLaneHeight / Math.max(1, laneCount) - barGap));
  const topOffset = compact ? 10.5 : 13.5;

  for (const vacation of vacations) {
    const clippedFrom = vacation.date_from < monthFrom ? monthFrom : vacation.date_from;
    const clippedTo = vacation.date_to > monthTo ? monthTo : vacation.date_to;
    if (clippedTo < clippedFrom) continue;
    const lane = (employeeIndex[vacation.employee_number] ?? 0) % laneCount;
    let segmentStart = clippedFrom;
    while (segmentStart <= clippedTo) {
      const segmentWeekEnd = addDays(getMonday(segmentStart), 6);
      const segmentEnd = segmentWeekEnd < clippedTo ? segmentWeekEnd : clippedTo;
      const startCell = cells[segmentStart];
      const endCell = cells[segmentEnd];
      if (startCell && endCell) {
        const barX = startCell.x + 2;
        const barY = startCell.y + topOffset + lane * (barHeight + barGap);
        const barWidth = endCell.x + endCell.width - startCell.x - 4;
        if (barWidth > 2 && barY + barHeight < startCell.y + startCell.height - 2) {
          doc.save();
          doc.fillOpacity(0.92).fillColor(vacation.color).roundedRect(barX, barY, barWidth, barHeight, barHeight / 2).fill();
          doc.fillOpacity(1);
          if (!compact && barWidth > 34) {
            doc.fillColor(contrastColor(vacation.color)).font("Helvetica-Bold").fontSize(4.7).text(vacation.nickname, barX + 3, barY + 0.65, {
              width: barWidth - 6,
              ellipsis: true,
              lineBreak: false,
            });
          }
          doc.restore();
        }
      }
      segmentStart = addDays(segmentEnd, 1);
    }
  }
}

function drawVacationPdfHeader(doc, title, selection, left, width, size) {
  doc.fillColor("#142033").font("Helvetica-Bold").fontSize(size === "A3" ? 19 : 15.5).text(
    `${title} · ${selection.title}`,
    left,
    20,
    { width },
  );
  doc
    .fillColor("#6b7684")
    .font("Helvetica")
    .fontSize(7.2)
    .text(`Zeitraum ${vacationDateRangeText(selection.start, selection.end, true)}`, left, 42, { width });
}

function drawVacationPdfFooter(doc, left, pageWidth, pageHeight, createdAt, settings = getSettings()) {
  doc
    .fillColor("#6b7684")
    .font("Helvetica-Bold")
    .fontSize(5.7)
    .text(`Urlaubsplanung erstellt mit: ${APP_NAME} ${APP_VERSION_LABEL}`, left, pageHeight - 24);
  doc
    .font("Helvetica")
    .text(
      pdfFooterContact(settings, createdAt),
      pageWidth - 310,
      pageHeight - 24,
      { width: 284, align: "right" },
    );
}

function vacationBalanceParts(settings, totals) {
  const parts = [`Rest ${formatVacationDays(totals.remaining)}`];
  if (settingEnabled(settings, "vacation_pdf_balance_show_entitlement")) {
    parts.push(`Jahr ${formatVacationDays(totals.entitlement)}`);
  }
  if (settingEnabled(settings, "vacation_pdf_balance_show_planned")) {
    parts.push(`geplant ${formatVacationDays(totals.planned ?? totals.used)}`);
  }
  if (settingEnabled(settings, "vacation_pdf_balance_show_consumed")) {
    parts.push(`konsumiert ${formatVacationDays(totals.consumed)}`);
  }
  return parts;
}

function drawVacationBalanceSummary(doc, plan, x, y, width, createdAt = new Date()) {
  if (!settingEnabled(plan.settings, "vacation_pdf_show_balance")) return y;
  const employees = plan.employees || [];
  if (!employees.length) return y;
  const columns = employees.length >= 8 ? 4 : Math.min(3, Math.max(1, employees.length));
  const gap = 7;
  const cardWidth = (width - gap * (columns - 1)) / columns;
  const cardHeight = 70;
  const rows = Math.ceil(employees.length / columns);
  const titleHeight = 15;
  const createdLabel = formatShortDateGerman(createdAt);
  const totalHeight = titleHeight + rows * cardHeight + gap * Math.max(0, rows - 1);

  doc.fillColor("#142033").font("Helvetica-Bold").fontSize(7.8).text("Resturlaub je Teammitglied", x, y, { width });

  employees.forEach((employee, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cardX = x + column * (cardWidth + gap);
    const cardY = y + titleHeight + row * (cardHeight + gap);
    const totals = plan.totals[employee.personnel_number] || { entitlement: 0, planned: 0, used: 0, consumed: 0, remaining: 0 };
    const planned = Number(totals.planned ?? totals.used ?? 0);
    const consumed = Number(totals.consumed || 0);
    const plannedOpen = Math.max(0, planned - consumed);
    const rowsToShow = [];
    if (settingEnabled(plan.settings, "vacation_pdf_balance_show_entitlement")) {
      rowsToShow.push([`Jahresurlaub mit 1.1.${plan.year}`, formatVacationDaysWithWeeks(totals.entitlement), false]);
    }
    rowsToShow.push([`Resturlaub mit ${createdLabel}`, formatVacationDaysWithWeeks(totals.remaining), true]);
    if (settingEnabled(plan.settings, "vacation_pdf_balance_show_planned")) {
      rowsToShow.push([`geplanter Urlaub ${plan.year}`, formatVacationDaysWithWeeks(planned), false]);
      rowsToShow.push([`geplant, noch nicht konsumiert mit ${createdLabel}`, formatVacationDaysWithWeeks(plannedOpen), false]);
    }
    if (settingEnabled(plan.settings, "vacation_pdf_balance_show_consumed")) {
      rowsToShow.push([`bereits konsumierter Urlaub mit ${createdLabel}`, formatVacationDaysWithWeeks(consumed), false]);
    }

    doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 7).fillAndStroke("#ffffff", "#dce2df");
    doc.fillColor(employee.color).roundedRect(cardX, cardY, cardWidth, 14, 7).fill();
    doc.fillColor(contrastColor(employee.color)).font("Helvetica-Bold").fontSize(6.2).text(`${employee.personnel_number} ${employee.nickname}`, cardX + 7, cardY + 4.1, {
      width: cardWidth - 14,
      ellipsis: true,
      lineBreak: false,
    });
    const rowHeight = Math.min(9.2, (cardHeight - 20) / Math.max(1, rowsToShow.length));
    let textY = cardY + 19;
    for (const [label, value, important] of rowsToShow) {
      doc.fillColor("#53615b").font(important ? "Helvetica-Bold" : "Helvetica").fontSize(4.6).text(label, cardX + 7, textY, {
        width: cardWidth * 0.49,
        ellipsis: true,
        lineBreak: false,
      });
      doc.fillColor("#25313d").font(important ? "Helvetica-Bold" : "Helvetica").fontSize(4.7).text(value, cardX + cardWidth * 0.54, textY, {
        width: cardWidth * 0.42,
        ellipsis: true,
        lineBreak: false,
      });
      textY += rowHeight;
    }
  });
  return y + totalHeight + 9;
}

function vacationHolidayPdfLabel(holiday, selection, compact) {
  if (!holiday) return "";
  if (selection.view === "year" || compact) return "FT";
  if (selection.view === "quarter") return "Feiertag";
  return holiday.name || "Feiertag";
}

function drawVacationMonthCalendar(doc, plan, vacations, selection, monthNumber, x, y, width, height, compact = false) {
  const monthFirst = monthStart(selection.year, monthNumber - 1);
  const monthLast = monthEnd(selection.year, monthNumber - 1);
  const monthFrom = monthFirst < selection.start ? selection.start : monthFirst;
  const monthTo = monthLast > selection.end ? selection.end : monthLast;
  const calendarRange = monthCalendarRange(selection.year, monthNumber);
  const weekdayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const titleHeight = compact ? 18 : 24;
  const gridTop = y + titleHeight;
  const weekRows = Math.floor((new Date(`${calendarRange.end}T12:00:00Z`) - new Date(`${calendarRange.start}T12:00:00Z`)) / 604800000) + 1;
  const rowCount = 1 + weekRows;
  const colWidth = width / 8;
  const rowHeight = (height - titleHeight) / rowCount;
  const useBars = String(plan.settings.vacation_pdf_calendar_style || "bars") !== "dots";
  const cells = {};

  doc.roundedRect(x, y, width, height, 7).fillAndStroke("#ffffff", "#dce2df");
  doc.fillColor("#e5edf4").roundedRect(x, y, width, titleHeight, 7).fill();
  doc.fillColor("#142033").font("Helvetica-Bold").fontSize(compact ? 7.4 : 9.5).text(monthName(monthNumber), x + 8, y + (compact ? 5.5 : 8), {
    width: width - 16,
  });

  doc.fillColor("#f7f8f5").rect(x, gridTop, width, rowHeight).fill();
  doc.fillColor("#65716c").font("Helvetica-Bold").fontSize(compact ? 4.8 : 6.3).text("KW", x, gridTop + rowHeight / 2 - 2.5, {
    width: colWidth,
    align: "center",
  });
  weekdayNames.forEach((day, index) => {
    doc.text(day, x + colWidth * (index + 1), gridTop + rowHeight / 2 - 2.5, {
      width: colWidth,
      align: "center",
    });
  });

  let weekStart = calendarRange.start;
  let row = 1;
  while (weekStart <= calendarRange.end) {
    const rowY = gridTop + row * rowHeight;
    doc.fillColor("#f7f8f5").rect(x, rowY, colWidth, rowHeight).fill();
    doc.fillColor("#72807a").font("Helvetica-Bold").fontSize(compact ? 4.8 : 6).text(String(getIsoWeek(weekStart)), x, rowY + rowHeight / 2 - 2.5, {
      width: colWidth,
      align: "center",
    });
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = addDays(weekStart, dayIndex);
      const cellX = x + colWidth * (dayIndex + 1);
      const inRange = date >= monthFrom && date <= monthTo;
      const dayVacations = inRange ? vacationsOnDate(vacations, date) : [];
      const holiday = inRange ? (plan.publicHolidays || []).find((item) => item.date === date) : null;
      if (inRange) cells[date] = { x: cellX, y: rowY, width: colWidth, height: rowHeight };
      doc.fillColor(inRange ? "#ffffff" : "#f7f8f5").rect(cellX, rowY, colWidth, rowHeight).fill();
      doc.fillColor(inRange ? "#293640" : "#a4afaa").font("Helvetica-Bold").fontSize(compact ? 4.9 : 6.2).text(String(Number(date.slice(-2))), cellX + 2, rowY + 2, {
        width: colWidth - 4,
      });
      if (holiday) {
        const holidayLabel = vacationHolidayPdfLabel(holiday, selection, compact);
        doc.fillColor("#fff1e2").roundedRect(cellX + colWidth * 0.32, rowY + 2, colWidth * 0.64 - 2, compact ? 6.4 : 8, 2).fill();
        doc.fillColor("#8b5537").font("Helvetica-Bold").fontSize(compact ? 3.8 : 4.7).text(holidayLabel, cellX + colWidth * 0.32 + 2, rowY + (compact ? 3.2 : 3.7), {
          width: colWidth * 0.64 - 6,
          ellipsis: true,
          lineBreak: false,
        });
      }
      if (useBars) continue;
      const visibleVacations = dayVacations.slice(0, compact ? 4 : 3);
      if (compact) {
        visibleVacations.forEach((vacation, index) => {
          doc.fillColor(vacation.color).circle(cellX + 5 + index * 5.2, rowY + rowHeight - 5, 2).fill();
        });
        if (dayVacations.length > visibleVacations.length) {
          doc.fillColor("#6f7b80").font("Helvetica-Bold").fontSize(4.5).text(`+${dayVacations.length - visibleVacations.length}`, cellX + 5 + visibleVacations.length * 5.2, rowY + rowHeight - 7, {
            width: colWidth - 4,
          });
        }
      } else {
        let tagY = rowY + 11;
        visibleVacations.forEach((vacation) => {
          const tagHeight = Math.min(8, Math.max(6, rowHeight / 5));
          if (tagY + tagHeight > rowY + rowHeight - 2) return;
          doc.fillColor(vacation.color).roundedRect(cellX + 2, tagY, colWidth - 4, tagHeight, 2).fill();
          doc.fillColor(contrastColor(vacation.color)).font("Helvetica-Bold").fontSize(Math.min(5.3, tagHeight - 1.5)).text(vacation.nickname, cellX + 4, tagY + 1.3, {
            width: colWidth - 8,
            ellipsis: true,
          });
          tagY += tagHeight + 1.5;
        });
        if (dayVacations.length > visibleVacations.length) {
          doc.fillColor("#6f7b80").font("Helvetica-Bold").fontSize(5).text(`+${dayVacations.length - visibleVacations.length}`, cellX + 3, tagY, {
            width: colWidth - 6,
          });
        }
      }
    }
    weekStart = addDays(weekStart, 7);
    row += 1;
  }

  if (useBars) {
    drawVacationBars(doc, plan, vacations, monthFrom, monthTo, cells, compact);
  }

  doc.strokeColor("#edf0ee").lineWidth(0.35);
  for (let col = 0; col <= 8; col += 1) {
    const lineX = x + col * colWidth;
    doc.moveTo(lineX, gridTop).lineTo(lineX, y + height).stroke();
  }
  for (let lineRow = 0; lineRow <= rowCount; lineRow += 1) {
    const lineY = gridTop + lineRow * rowHeight;
    doc.moveTo(x, lineY).lineTo(x + width, lineY).stroke();
  }
}

function drawVacationEmployeeOverviewPdf(doc, plan, selection, vacations, layout, createdAt) {
  const { left, availableWidth, pageHeight, pageWidth, title, size } = layout;
  const y = 62;
  const columnGap = 10;
  const columns = 2;
  const columnWidth = (availableWidth - columnGap) / columns;
  const rowGap = 9;
  let column = 0;
  let cardY = y;

  for (const employee of plan.employees) {
    const employeeVacations = vacations
      .filter((vacation) => vacation.employee_number === employee.personnel_number)
      .sort((a, b) => a.date_from.localeCompare(b.date_from));
    const cardHeight = 62 + Math.max(1, employeeVacations.length) * 11;
    if (cardY + cardHeight > pageHeight - 42) {
      if (column === 0) {
        column = 1;
        cardY = y;
      } else {
        drawVacationPdfFooter(doc, left, pageWidth, pageHeight, createdAt, plan.settings);
        doc.addPage({ size, layout: "landscape", margin: 0 });
        drawVacationPdfHeader(doc, title, selection, left, availableWidth, size);
        column = 0;
        cardY = 62;
      }
    }
    const x = left + column * (columnWidth + columnGap);
    doc.roundedRect(x, cardY, columnWidth, cardHeight, 8).fillAndStroke("#ffffff", "#dce2df");
    doc.fillColor(employee.color).roundedRect(x, cardY, columnWidth, 24, 8).fill();
    doc.fillColor(contrastColor(employee.color)).font("Helvetica-Bold").fontSize(8.8).text(`${employee.personnel_number} ${employee.nickname}`, x + 9, cardY + 7.5, {
      width: columnWidth - 18,
      ellipsis: true,
    });
    const totals = plan.totals[employee.personnel_number] || { entitlement: 0, planned: 0, consumed: 0, remaining: 0 };
    doc.fillColor("#25313d").font("Helvetica-Bold").fontSize(6.8).text(`Resturlaub: ${formatVacationDaysLong(totals.remaining)}`, x + 9, cardY + 30, {
      width: columnWidth - 18,
    });
    doc.fillColor("#53615b").font("Helvetica").fontSize(5.9).text(`Geplant: ${formatVacationDaysLong(totals.planned ?? totals.used)} · Konsumiert: ${formatVacationDaysLong(totals.consumed)}`, x + 9, cardY + 41, {
      width: columnWidth - 18,
      ellipsis: true,
    });
    let itemY = cardY + 54;
    if (!employeeVacations.length) {
      doc.fillColor("#98a29e").font("Helvetica").fontSize(6.5).text("Keine Urlaube eingetragen", x + 9, itemY, {
        width: columnWidth - 18,
      });
    } else {
      for (const vacation of employeeVacations) {
        const clippedFrom = vacation.selection_from || (vacation.date_from < selection.start ? selection.start : vacation.date_from);
        const clippedTo = vacation.selection_to || (vacation.date_to > selection.end ? selection.end : vacation.date_to);
        doc.fillColor(employee.color).roundedRect(x + 9, itemY + 1, 6, 6, 1.5).fill();
        doc.fillColor("#25313d").font("Helvetica").fontSize(6.2).text(
          `${vacationDateRangeText(clippedFrom, clippedTo, true)} · ${formatVacationDays(vacationDayCount(clippedFrom, clippedTo, plan.settings, plan.context?.locationId))}${vacation.note ? ` · ${vacation.note}` : ""}`,
          x + 19,
          itemY,
          { width: columnWidth - 28, ellipsis: true, lineBreak: false },
        );
        itemY += 12;
      }
    }
    cardY += cardHeight + rowGap;
  }
}

function drawVacationPdf(plan, selection, response, createdAt = new Date()) {
  const size = "A4";
  const title = plan.settings.vacation_pdf_title || "Urlaubsplanung";
  const doc = new PDFDocument({
    size,
    layout: "landscape",
    margin: 0,
    info: {
      Title: `${title} · ${selection.title}`,
      Subject: `${size} Querformat · ${APP_NAME} ${APP_VERSION_LABEL}`,
    },
  });
  doc.pipe(response);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const left = 26;
  const right = 26;
  const vacations = filteredVacationsForSelection(plan, selection);
  const availableWidth = pageWidth - left - right;

  drawVacationPdfHeader(doc, title, selection, left, availableWidth, size);

  if (selection.view === "employees") {
    drawVacationEmployeeOverviewPdf(doc, plan, selection, vacations, {
      left,
      availableWidth,
      pageWidth,
      pageHeight,
      title,
      size,
    }, createdAt);
    drawVacationPdfFooter(doc, left, pageWidth, pageHeight, createdAt, plan.settings);
    doc.end();
    return;
  }

  const calendarTop = drawVacationBalanceSummary(doc, plan, left, 58, availableWidth, createdAt);
  const top = calendarTop === 58 ? 62 : calendarTop;
  const bottom = pageHeight - 37;
  const monthCount = selection.months.length;
  const columns = monthCount === 1 ? 1 : monthCount <= 3 ? 3 : 4;
  const rows = Math.ceil(monthCount / columns);
  const gap = monthCount === 1 ? 0 : 8;
  const cardWidth = (availableWidth - gap * (columns - 1)) / columns;
  const cardHeight = (bottom - top - gap * (rows - 1)) / rows;
  const compact = selection.view === "year";

  selection.months.forEach((month, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = left + column * (cardWidth + gap);
    const y = top + row * (cardHeight + gap);
    drawVacationMonthCalendar(doc, plan, vacations, selection, month, x, y, cardWidth, cardHeight, compact);
  });

  drawVacationPdfFooter(doc, left, pageWidth, pageHeight, createdAt, plan.settings);

  doc.end();
}

function scheduleNoteFontName(note) {
  if (note.bold && note.italic) return "Helvetica-BoldOblique";
  if (note.bold) return "Helvetica-Bold";
  if (note.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

function scheduleNoteFontSize(note) {
  return { small: 5.7, medium: 6.4, large: 7.2 }[note.font_size] || 6.4;
}

function scheduleNoteStyleFont(style) {
  if (style.bold && style.italic) return "Helvetica-BoldOblique";
  if (style.bold) return "Helvetica-Bold";
  if (style.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

function scheduleNoteStyleSize(style) {
  return { small: 5.7, normal: 6.4, large: 7.2 }[style?.size || "normal"] || 6.4;
}

function parseScheduleNoteRichSegments(note) {
  const source = note.note_html ? sanitizeScheduleNoteHtml(note.note_html) : "";
  if (!source) {
    return [
      {
        text: stripEmoji(note.note_text || ""),
        bold: Boolean(note.bold),
        italic: Boolean(note.italic),
        underline: Boolean(note.underline),
        size: note.font_size === "large" ? "large" : note.font_size === "small" ? "small" : "normal",
      },
    ];
  }
  const segments = [];
  const style = { bold: false, italic: false, underline: false, size: "normal" };
  const stack = [];
  const parts = source.split(/(<[^>]+>)/g).filter((part) => part !== "");
  function pushText(text) {
    const decoded = stripEmoji(decodeBasicEntities(text).replace(/\u00a0/g, " "));
    if (!decoded) return;
    segments.push({ text: decoded, ...style });
  }
  function pushBreak() {
    if (segments.length && segments[segments.length - 1].text === "\n") return;
    segments.push({ text: "\n", ...style });
  }
  for (const part of parts) {
    if (!part.startsWith("<")) {
      pushText(part);
      continue;
    }
    const tag = part.toLowerCase();
    if (tag === "<br>" || tag === "</div>" || tag === "</p>") {
      pushBreak();
      continue;
    }
    if (tag === "<div>" || tag === "<p>") continue;
    if (tag === "<b>" || tag === "<strong>") { stack.push({ ...style }); style.bold = true; continue; }
    if (tag === "<i>" || tag === "<em>") { stack.push({ ...style }); style.italic = true; continue; }
    if (tag === "<u>") { stack.push({ ...style }); style.underline = true; continue; }
    if (tag.startsWith("<span")) {
      stack.push({ ...style });
      style.size = tag.match(/data-size="(small|normal|large)"/)?.[1] || style.size;
      continue;
    }
    if (["</b>", "</strong>", "</i>", "</em>", "</u>", "</span>"].includes(tag)) {
      const previous = stack.pop();
      if (previous) Object.assign(style, previous);
    }
  }
  return segments.filter((segment, index) =>
    segment.text !== "\n" || (index > 0 && index < segments.length - 1),
  );
}

function drawScheduleNoteRichText(doc, note, x, y, width, height) {
  const segments = parseScheduleNoteRichSegments(note);
  const maxY = y + height;
  let cursorX = x;
  let cursorY = y;
  const lineGap = 1.2;
  function lineHeightFor(size) {
    const lineHeight = scheduleNoteStyleSize({ size }) * 1.35 + lineGap;
    return Number.isFinite(lineHeight) ? lineHeight : 9.8;
  }
  function nextLine(size = "normal") {
    cursorX = x;
    cursorY += lineHeightFor(size);
    return cursorY <= maxY;
  }
  for (const segment of segments) {
    const tokens = segment.text === "\n" ? ["\n"] : segment.text.split(/(\s+)/).filter((token) => token !== "");
    for (const token of tokens) {
      const size = scheduleNoteStyleSize(segment);
      if (token === "\n") {
        if (!nextLine(segment.size)) return;
        continue;
      }
      doc.font(scheduleNoteStyleFont(segment)).fontSize(size);
      const measuredWidth = doc.widthOfString(token);
      const tokenWidth = Number.isFinite(measuredWidth) ? measuredWidth : 0;
      if (cursorX > x && cursorX + tokenWidth > x + width) {
        if (!nextLine(segment.size)) return;
      }
      if (cursorY + size > maxY) return;
      if (![cursorX, cursorY, size].every(Number.isFinite)) return;
      doc
        .fillColor("#1e252b")
        .font(scheduleNoteStyleFont(segment))
        .fontSize(size)
        .text(token, cursorX, cursorY, {
          width: Math.max(1, tokenWidth + 1),
          lineBreak: false,
          underline: Boolean(segment.underline),
        });
      cursorX += tokenWidth;
    }
  }
}

function drawSchedulePdf(schedule, response, createdAt = new Date()) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 0,
    info: {
      Title: `${schedule.settings.pdf_title} · KW ${schedule.calendarWeek}`,
      Subject: `A4 Querformat · ${APP_NAME} ${APP_VERSION_LABEL}`,
    },
  });
  doc.pipe(response);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const left = 22;
  const right = 22;
  const timeWidth = 35;
  const gridLeft = left + timeWidth;
  const gridWidth = pageWidth - gridLeft - right;
  const dayCount = settingEnabled(schedule.settings, "show_sunday") ? 7 : 6;
  const dayGap = 3;
  const dayWidth = (gridWidth - dayGap * (dayCount - 1)) / dayCount;
  const dayX = (dayIndex) => gridLeft + dayIndex * (dayWidth + dayGap);
  const titleY = 18;
  const dayHeaderY = 45;
  const dayHeaderHeight = 20;
  const employeeHeaderY = dayHeaderY + dayHeaderHeight;
  const employeeHeaderHeight = 28;
  const gridTop = employeeHeaderY + employeeHeaderHeight + 10;
  const gridBottom = 438;
  const gridHeight = gridBottom - gridTop;
  const timedOptionStarts = schedule.weekOptions
    .filter((option) => !optionIsAllDay(option) && isTime(option.start_time))
    .map((option) => timeToMinutes(option.start_time));
  const timedOptionEnds = schedule.weekOptions
    .filter((option) => !optionIsAllDay(option) && isTime(option.end_time))
    .map((option) => timeToMinutes(option.end_time));
  const startMinutes = Math.min(
    ...planningDays.map(([day]) => timeToMinutes(schedule.settings[`${day}_start_time`])),
    ...schedule.shifts.map((shift) => timeToMinutes(shift.start_time)),
    ...timedOptionStarts,
  );
  const endMinutes = Math.max(
    ...planningDays.map(([day]) => timeToMinutes(schedule.settings[`${day}_end_time`])),
    ...schedule.shifts.map((shift) => timeToMinutes(shift.end_time)),
    ...timedOptionEnds,
  );
  const rangeMinutes = endMinutes - startMinutes;
  const employees = schedule.employees;
  const employeeCount = Math.max(1, employees.length);
  const employeeWidth = dayWidth / employeeCount;

  doc
    .fillColor("#142033")
    .font("Helvetica-Bold")
    .fontSize(15)
    .text(
      `${schedule.settings.pdf_title} · Woche ab ${formatDateGerman(schedule.weekStart)} · KW ${schedule.calendarWeek}`,
      left,
      titleY,
      { width: pageWidth - left - right },
    );

  doc.fillColor("#142033").font("Helvetica-Bold").fontSize(7).text("Zeit", left, employeeHeaderY + 10, {
    width: timeWidth - 5,
    align: "center",
  });

  const weekdayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const date = addDays(schedule.weekStart, dayIndex);
    const x = dayX(dayIndex);
    doc
      .fillColor(dayIndex === 6 ? "#d6d6d6" : "#e5edf4")
      .rect(x, dayHeaderY, dayWidth, dayHeaderHeight)
      .fill();
    doc.strokeColor("#aab6c2").lineWidth(0.45).rect(x, dayHeaderY, dayWidth, dayHeaderHeight).stroke();
    doc
      .fillColor("#111820")
      .font("Helvetica-Bold")
      .fontSize(8)
      .text(`${weekdayNames[dayIndex]} ${formatDateGerman(date, false)}`, x, dayHeaderY + 6, {
        width: dayWidth,
        align: "center",
      });

    employees.forEach((employee, employeeIndex) => {
      const employeeX = x + employeeIndex * employeeWidth;
      doc.fillColor(employee.color).rect(employeeX, employeeHeaderY, employeeWidth, employeeHeaderHeight).fill();
      doc
        .fillColor(contrastColor(employee.color))
        .font("Helvetica-Bold")
        .fontSize(Math.max(4.2, Math.min(5.8, employeeWidth / 7)))
        .text(employee.nickname, employeeX + 1, employeeHeaderY + 11, {
          width: employeeWidth - 2,
          align: "center",
          ellipsis: true,
        });
    });
  }

  doc.fillColor("#ffffff").rect(gridLeft, gridTop, gridWidth, gridHeight).fill();
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const date = addDays(schedule.weekStart, dayIndex);
    const hours = operatingHours(date, schedule.settings);
    const x = dayX(dayIndex);
    if (!hours) {
      doc.fillColor("#eeeeee").rect(x, gridTop, dayWidth, gridHeight).fill();
      continue;
    }
    const dayStart = timeToMinutes(hours.start);
    const dayEnd = timeToMinutes(hours.end);
    if (dayStart > startMinutes) {
      const closedHeight = ((dayStart - startMinutes) / rangeMinutes) * gridHeight;
      doc.fillColor("#eeeeee").rect(x, gridTop, dayWidth, closedHeight).fill();
    }
    if (dayEnd < endMinutes) {
      const closedY = gridTop + ((dayEnd - startMinutes) / rangeMinutes) * gridHeight;
      doc.fillColor("#eeeeee").rect(x, closedY, dayWidth, gridBottom - closedY).fill();
    }
    const config = dayConfiguration(date, schedule.settings);
    if (config.lunchEnabled) {
      const lunchY = gridTop + ((timeToMinutes(config.lunchStart) - startMinutes) / rangeMinutes) * gridHeight;
      const lunchHeight =
        ((timeToMinutes(config.lunchEnd) - timeToMinutes(config.lunchStart)) / rangeMinutes) * gridHeight;
      doc.fillColor("#e6e6e6").rect(x, lunchY, dayWidth, lunchHeight).fill();
      doc
        .fillColor("#737a7d")
        .font("Helvetica-Bold")
        .fontSize(5)
        .text("Mittagspause", x, lunchY + lunchHeight / 2 - 3, { width: dayWidth, align: "center" });
    }
    const globalBlock = (schedule.globalDayBlocks || []).find((block) => block.block_date === date);
    if (globalBlock) {
      doc.save();
      doc.fillColor("#e1e4e4").rect(x, gridTop, dayWidth, gridHeight).fill();
      doc.rect(x, gridTop, dayWidth, gridHeight).clip();
      doc.strokeColor("#9aa2a4").lineWidth(0.5);
      for (let offset = -gridHeight; offset < dayWidth + gridHeight; offset += 8) {
        doc.moveTo(x + offset, gridBottom).lineTo(x + offset + gridHeight, gridTop).stroke();
      }
      doc.restore();
      doc.strokeColor("#7f8789").lineWidth(0.55).rect(x, gridTop, dayWidth, gridHeight).stroke();
      doc
        .fillColor("#41484b")
        .font("Helvetica-Bold")
        .fontSize(7)
        .text(globalBlock.reason || globalBlock.holiday_name || "Tag gesperrt", x + 4, gridTop + gridHeight / 2 - 5, {
          width: dayWidth - 8,
          align: "center",
          ellipsis: true,
        });
    }
  }

  for (let minute = startMinutes; minute <= endMinutes; minute += 60) {
    const y = gridTop + ((minute - startMinutes) / rangeMinutes) * gridHeight;
    const label = `${String(Math.floor(minute / 60)).padStart(2, "0")}:00`;
    doc
      .fillColor("#263240")
      .font("Helvetica")
      .fontSize(6.5)
      .text(label, left, y - 3, { width: timeWidth - 6, align: "center" });
    for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
      const x = dayX(dayIndex);
      doc.strokeColor("#bbc5ce").lineWidth(0.35).moveTo(x, y).lineTo(x + dayWidth, y).stroke();
    }
  }

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const dayStartX = dayX(dayIndex);
    doc.strokeColor("#aab6c2").lineWidth(0.45).rect(dayStartX, gridTop, dayWidth, gridHeight).stroke();
    for (let employeeIndex = 1; employeeIndex < employeeCount; employeeIndex += 1) {
      const x = dayStartX + employeeIndex * employeeWidth;
      doc.strokeColor("#c6ced5").lineWidth(0.3).moveTo(x, gridTop).lineTo(x, gridBottom).stroke();
    }
  }

  for (const option of schedule.weekOptions) {
    const employeeIndex = employees.findIndex(
      (employee) => employee.personnel_number === option.employee_number,
    );
    if (employeeIndex < 0) continue;

    for (let date = option.date_from; date <= option.date_to; date = addDays(date, 1)) {
      const dayIndex = Math.round(
        (new Date(`${date}T12:00:00Z`) - new Date(`${schedule.weekStart}T12:00:00Z`)) / 86400000,
      );
      if (dayIndex < 0 || dayIndex >= dayCount) continue;

      const x = dayX(dayIndex) + employeeIndex * employeeWidth + 0.5;
      const width = Math.max(2, employeeWidth - 1);
      const range = optionTimeRange(option);
      const optionStart = Math.max(startMinutes, timeToMinutes(range.start));
      const optionEnd = Math.min(endMinutes, timeToMinutes(range.end));
      if (optionEnd <= optionStart) continue;
      const y = gridTop + ((optionStart - startMinutes) / rangeMinutes) * gridHeight;
      const height = ((optionEnd - optionStart) / rangeMinutes) * gridHeight;
      doc.save();
      doc.fillColor("#e3e5e5").rect(x, y, width, height).fill();
      doc.rect(x, y, width, height).clip();
      doc.strokeColor("#9da3a5").lineWidth(0.45);
      for (let offset = -height; offset < width + height; offset += 6) {
        doc.moveTo(x + offset, y + height).lineTo(x + offset + height, y).stroke();
      }
      doc.restore();
      doc.strokeColor("#7e8588").lineWidth(0.4).rect(x, y, width, height).stroke();
      const label = optionLabel(option.option_type);
      const labelFontSize = Math.max(4.2, Math.min(5.2, height / 7));
      doc.save();
      doc
        .fillColor("#41484b")
        .font("Helvetica-Bold")
        .fontSize(labelFontSize)
        .rotate(-90, { origin: [x + width / 2, y + height / 2] })
        .text(
          label,
          x + width / 2 - height / 2,
          y + height / 2 - labelFontSize / 2,
          {
            width: height,
            align: "center",
            lineBreak: false,
          },
        );
      doc.restore();
    }
  }

  for (const shift of schedule.shifts) {
    const dayIndex = Math.round(
      (new Date(`${shift.shift_date}T12:00:00Z`) - new Date(`${schedule.weekStart}T12:00:00Z`)) / 86400000,
    );
    const employeeIndex = employees.findIndex(
      (employee) => employee.personnel_number === shift.employee_number,
    );
    if (dayIndex < 0 || dayIndex >= dayCount || employeeIndex < 0) continue;

    const shiftStart = Math.max(startMinutes, timeToMinutes(shift.start_time));
    const shiftEnd = Math.min(endMinutes, timeToMinutes(shift.end_time));
    if (shiftEnd <= shiftStart) continue;
    const x = dayX(dayIndex) + employeeIndex * employeeWidth + 1;
    const y = gridTop + ((shiftStart - startMinutes) / rangeMinutes) * gridHeight;
    const height = ((shiftEnd - shiftStart) / rangeMinutes) * gridHeight;
    const width = Math.max(2, employeeWidth - 2);
    const employee = employees[employeeIndex];
    doc.fillColor(employee.color).rect(x, y, width, height).fill();
    doc.strokeColor("#25313d").lineWidth(0.35).rect(x, y, width, height).stroke();
    if (!schedule.context.departmentId && shift.department_name && height > 14 && width > 8) {
      doc
        .fillColor(contrastColor(employee.color))
        .font("Helvetica-Bold")
        .fontSize(Math.max(3.6, Math.min(4.8, width / 5)))
        .text(shift.department_name, x + 1, y + 2, {
          width: width - 2,
          height: Math.min(10, height - 2),
          align: "center",
          ellipsis: true,
        });
    }
  }

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const date = addDays(schedule.weekStart, dayIndex);
    const config = dayConfiguration(date, schedule.settings);
    if (!config?.lunchEnabled) continue;
    const x = dayX(dayIndex);
    const lunchY = gridTop + ((timeToMinutes(config.lunchStart) - startMinutes) / rangeMinutes) * gridHeight;
    const lunchHeight =
      ((timeToMinutes(config.lunchEnd) - timeToMinutes(config.lunchStart)) / rangeMinutes) * gridHeight;
    doc.save();
    doc.fillOpacity(0.78).fillColor("#d8dada").rect(x, lunchY, dayWidth, lunchHeight).fill();
    doc.fillOpacity(1);
    doc
      .fillColor("#555e5b")
      .font("Helvetica-Bold")
      .fontSize(5.4)
      .text("Mittagspause · geschlossen", x, lunchY + lunchHeight / 2 - 3, {
        width: dayWidth,
        align: "center",
      });
    doc.restore();
  }

  const remarksY = 454;
  const remarkColumns = [
    { key: "leave", title: "Urlaube / Zeitausgleich" },
    { key: "school", title: "Schule / Schulungen" },
    { key: "other", title: "Bemerkungen / Sonderfälle" },
  ];
  const scheduleNote = schedule.scheduleNote?.note_text?.trim() ? schedule.scheduleNote : null;
  const remarkGap = 12;
  const remarkColumnCount = scheduleNote ? 4 : 3;
  const remarkColumnWidth = (pageWidth - left - right - remarkGap * (remarkColumnCount - 1)) / remarkColumnCount;
  const groupedOptions = Object.fromEntries(remarkColumns.map((column) => [column.key, []]));
  for (const option of schedule.weekOptions) groupedOptions[optionRemarkColumn(option)].push(option);
  for (const block of schedule.globalDayBlocks || []) {
    groupedOptions.other.push({ ...block, global_day: true, color: "#9aa2a4" });
  }

  remarkColumns.forEach((column, columnIndex) => {
    const x = left + columnIndex * (remarkColumnWidth + remarkGap);
    doc.fillColor("#142033").font("Helvetica-Bold").fontSize(8.3).text(column.title, x, remarksY, {
      width: remarkColumnWidth,
    });
    const options = groupedOptions[column.key];
    if (!options.length) {
      doc.fillColor("#9aa5a1").font("Helvetica").fontSize(6.2).text("—", x, remarksY + 15, {
        width: remarkColumnWidth,
      });
      return;
    }
    let y = remarksY + 15;
    for (const option of options) {
      if (y > 556) {
        doc.fillColor("#6f7b80").font("Helvetica").fontSize(5.8).text("…", x, y, { width: remarkColumnWidth });
        break;
      }
      doc.fillColor(option.color || "#9aa2a4").roundedRect(x, y + 1.2, 6, 6, 1.4).fill();
      doc
        .fillColor("#25313d")
        .font("Helvetica")
        .fontSize(5.95)
        .text(optionRemarkText(option), x + 9, y, {
          width: remarkColumnWidth - 9,
          height: 16,
          ellipsis: true,
        });
      y += 15;
    }
  });

  if (scheduleNote) {
    const x = left + 3 * (remarkColumnWidth + remarkGap);
    const boxY = remarksY;
    const boxHeight = 101;
    doc.roundedRect(x, boxY, remarkColumnWidth, boxHeight, 6).fillAndStroke("#fff6cf", "#111111");
    doc.fillColor("#142033").font("Helvetica-Bold").fontSize(8.1).text("Besondere Bemerkung", x + 8, boxY + 8, {
      width: remarkColumnWidth - 16,
    });
    drawScheduleNoteRichText(doc, scheduleNote, x + 8, boxY + 23, remarkColumnWidth - 16, boxHeight - 31);
  }

  doc
    .fillColor("#6b7684")
    .font("Helvetica-Bold")
    .fontSize(5.7)
    .text(`Dienstplan erstellt mit: ${APP_NAME} ${APP_VERSION_LABEL}`, left, pageHeight - 24);
  doc
    .font("Helvetica")
    .text(
      pdfFooterContact(schedule.settings, createdAt),
      pageWidth - 300,
      pageHeight - 24,
      { width: 278, align: "right" },
    );

  doc.end();
}

app.get("/api/schedule.pdf", (request, response) => {
  const schedule = getSchedule(request.query.week, request.query, request.portalSession);
  const createdAt = new Date();
  const filename = buildPdfFilename(schedule, createdAt);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", contentDispositionHeader(filename));
  drawSchedulePdf(schedule, response, createdAt);
});

app.get("/api/vacations.pdf", (request, response) => {
  const selection = vacationSelectionFromQuery(request.query);
  const plan = getVacationPlan(selection.year, request.query, request.portalSession);
  const createdAt = new Date();
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", contentDispositionHeader(buildVacationPdfFilename(plan.settings, selection, createdAt)));
  drawVacationPdf(plan, selection, response, createdAt);
});

app.get("/api/schedule-preview.pdf", (request, response) => {
  const schedule = getSchedule(request.query.week, request.query, request.portalSession);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", "inline");
  drawSchedulePdf(schedule, response, new Date());
});

app.get("/api/vacations-preview.pdf", (request, response) => {
  const selection = vacationSelectionFromQuery(request.query);
  const plan = getVacationPlan(selection.year, request.query, request.portalSession);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", "inline");
  drawVacationPdf(plan, selection, response, new Date());
});

app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error.status) && error.status >= 100 && error.status < 1000 ? error.status : 500;
  if (status >= 500) console.error(error);
  if (error.retryAfter) response.setHeader("Retry-After", String(error.retryAfter));
  const payload = {
    error: error.message || "Ein unerwarteter Fehler ist aufgetreten.",
  };
  if (error.code) payload.code = error.code;
  response.status(status).json(payload);
});

let shutdownStarted = false;
let databaseClosed = false;
let server = null;

function runningProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireInstanceLock() {
  if (!instanceLockPath || instanceLockHeld) return;
  fs.mkdirSync(path.dirname(instanceLockPath), { recursive: true });
  if (fs.existsSync(instanceLockPath)) {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(instanceLockPath, "utf8")); } catch {}
    if (existing?.pid !== process.pid && runningProcess(Number(existing?.pid))) {
      throw new Error(`Grabenplaner verwendet diese Datenbank bereits in Prozess ${existing.pid}. Eine zweite Serverinstanz wurde verhindert.`);
    }
    safeRemoveFile(instanceLockPath);
  }
  const descriptor = fs.openSync(instanceLockPath, "wx");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), appVersion: packageMetadata.version, database: path.resolve(databasePath) }, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  instanceLockHeld = true;
}

function releaseInstanceLock() {
  if (!instanceLockPath || !instanceLockHeld) return;
  try {
    const existing = JSON.parse(fs.readFileSync(instanceLockPath, "utf8"));
    if (Number(existing.pid) === process.pid) safeRemoveFile(instanceLockPath);
  } catch {
    safeRemoveFile(instanceLockPath);
  }
  instanceLockHeld = false;
}

function validateServerStartup(portalStatus) {
  if (serverModeActive) {
    let parsedPublicUrl = null;
    try { parsedPublicUrl = new URL(publicUrl); } catch {}
    if (!parsedPublicUrl || parsedPublicUrl.protocol !== "https:" || parsedPublicUrl.username || parsedPublicUrl.password || parsedPublicUrl.pathname !== "/" || parsedPublicUrl.search || parsedPublicUrl.hash) {
      throw new Error("Serverbetrieb abgebrochen: GRABENPLANER_PUBLIC_URL muss eine gültige öffentliche HTTPS-Adresse enthalten.");
    }
    if (portalStatus.adminSetupState !== "configured") {
      throw new Error("Serverbetrieb abgebrochen: Zuerst im Lokal- oder LAN-Betrieb einen Admin-Zugang einrichten.");
    }
    if (serviceControlToken.length < 32) {
      throw new Error("Serverbetrieb abgebrochen: GRABENPLANER_SERVICE_CONTROL_TOKEN muss als geheimer Dienststeuerungs-Token gesetzt sein.");
    }
    if (!amuStorage) {
      throw new Error(`Serverbetrieb abgebrochen: Der geschützte AUM-Speicher ist nicht verfügbar${amuStorageStartupError ? `: ${amuStorageStartupError}` : "."}`);
    }
    return;
  }
  if (!loopbackHosts.has(HOST.toLowerCase()) && (getSettings().operation_mode !== "lan" || !portalStatus.portalEnabled || portalStatus.adminSetupState !== "configured")) {
    throw new Error("LAN-Bindung abgebrochen: Der LAN-Modus und ein Admin-Zugang müssen aktiviert sein.");
  }
}

function startServer() {
  if (server) return server;
  const portalStatus = getPortalStatus();
  validateServerStartup(portalStatus);
  acquireInstanceLock();
  server = app.listen(PORT, HOST, () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : PORT;
    console.log(`${APP_NAME} läuft auf http://localhost:${listeningPort}`);
    if (serverModeActive) {
      console.log(`Öffentlicher Serverbetrieb über Reverse Proxy: ${publicUrl}`);
    } else if (portalStatus.portalEnabled) {
      for (const url of getLanUrls(listeningPort)) console.log(`LAN-Zugriff: ${url}`);
    }
    scheduleAutomaticBackups();
    try { reconcileOrphanAmuBlobs(); } catch (error) { console.error("AUM-Abgleich fehlgeschlagen:", error); }
    try { purgeExpiredAmuDocuments(); } catch (error) { console.error("AUM-Aufbewahrungsprüfung fehlgeschlagen:", error); }
    retentionInterval = setInterval(() => {
      try { purgeExpiredAmuDocuments(); } catch (error) { console.error("AUM-Aufbewahrungsprüfung fehlgeschlagen:", error); }
    }, 24 * 60 * 60 * 1000);
    retentionInterval.unref();
    if (serverModeActive && amuStorage) {
      scannerProbeInterval = setInterval(() => {
        amuScannerProbe = amuStorage.probeScanner().catch((error) => {
          console.error("AUM-Virenscanner ist nicht betriebsbereit:", error.message);
          return null;
        });
      }, 5 * 60 * 1000);
      scannerProbeInterval.unref();
    }
    setTimeout(() => {
      try {
        const backup = createDatabaseBackup("startup");
        if (backup) console.log(`Backup erstellt: ${backup.path}`);
      } catch (error) {
        console.error("Backup konnte nicht erstellt werden:", error);
      }
    }, 1500);
  });
  server.once("error", () => releaseInstanceLock());
  return server;
}

function shutdown({ reason = "signal", skipBackup = false, exitCode = 0 } = {}) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  let finished = false;
  let serverClosed = !server;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (!databaseClosed) {
      try {
        if (!skipBackup) createDatabaseBackup(`shutdown-${reason}`);
      } catch (error) {
        console.error("Backup beim Dienststopp konnte nicht erstellt werden:", error);
      }
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      try { db.close(); } finally { databaseClosed = true; }
    }
    releaseInstanceLock();
    process.exit(exitCode);
  };
  if (backupInterval) clearInterval(backupInterval);
  if (retentionInterval) clearInterval(retentionInterval);
  if (scannerProbeInterval) clearInterval(scannerProbeInterval);
  if (!server) {
    finish();
    return;
  }
  const tryFinish = () => {
    if (serverClosed && amuMutationInProgress === 0) finish();
  };
  const waitForUploads = setInterval(tryFinish, 100);
  waitForUploads.unref();
  const forceExit = setTimeout(() => {
    clearInterval(waitForUploads);
    if (amuMutationInProgress > 0) console.error("Dienststopp nach 45 Sekunden erzwungen; ein AUM-Vorgang war noch aktiv.");
    finish();
  }, 45000);
  forceExit.unref();
  server.close(() => {
    serverClosed = true;
    tryFinish();
  });
}

if (require.main === module) {
  process.on("exit", releaseInstanceLock);
  process.on("SIGINT", () => shutdown({ reason: "SIGINT" }));
  process.on("SIGTERM", () => shutdown({ reason: "SIGTERM" }));
  try { startServer(); } catch (error) { releaseInstanceLock(); throw error; }
}

module.exports = {
  app,
  db,
  startServer,
  get server() { return server; },
  getPortalStatus,
  getPortalRoles,
  hashPortalPassword,
  verifyPortalPassword,
  timeTrackingDayStatus,
  bookTimeEntry,
  resolveStaleTimeEntry,
  timePresenceForContext,
  serverDiagnostics,
};
