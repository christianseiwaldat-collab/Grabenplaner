const express = require("express");
const PDFDocument = require("pdfkit");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const packageMetadata = require("./package.json");
const APP_NAME = "Grabenplaner";
const PORTAL_API_VERSION = 1;
const DEFAULT_OPERATION_MODE = "local";
const SERVER_MODE_STATUS = "prepared";
const PORTAL_PASSWORD_MIN_LENGTH = 10;
const scryptAsync = promisify(crypto.scrypt);

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
      "employees:read",
      "schedule:read",
      "schedule:write",
      "time:read",
      "time:review",
      "vacation:read",
      "vacation:approve",
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
      "employees:read",
      "schedule:read",
      "schedule:write",
      "time:read",
      "time:review",
      "vacation:read",
      "vacation:approve",
      "settings:write",
      "users:write",
      "roles:read",
      "roles:write",
      "audit:read",
    ],
  },
];

const defaultPortalSettings = {
  login_required: "0",
  password_min_length: String(PORTAL_PASSWORD_MIN_LENGTH),
  session_timeout_minutes: "480",
  max_failed_login_attempts: "5",
  account_lock_minutes: "15",
  secure_cookies_required: "1",
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

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.GRABENPLANER_HOST || "127.0.0.1").trim() || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (SERVER_MODE_STATUS !== "active" && !loopbackHosts.has(HOST.toLowerCase())) {
  throw new Error("Eine externe Netzwerkbindung ist erst mit aktivem, abgesichertem Servermodus erlaubt.");
}
const dataDirectory = path.join(__dirname, "data");
const databasePath = process.env.DB_PATH || path.join(dataDirectory, "dienstplan.db");
const appBackupDirectory = path.join(__dirname, "backups");
const brandingKitsDirectory = path.join(dataDirectory, "branding-kits");
const defaultBackupDirectorySetting = "%USERPROFILE%\\Documents\\grabenplaner-backups";
const defaultBackupDirectory = process.env.BACKUP_DIR || path.join(os.homedir(), "Documents", "grabenplaner-backups");

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(appBackupDirectory, { recursive: true });
fs.mkdirSync(brandingKitsDirectory, { recursive: true });

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

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");
let lastBackup = null;
let backupInterval = null;

function backupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function pruneDatabaseBackups(backupDirectory, keep = 30) {
  const backups = fs
    .readdirSync(backupDirectory)
    .filter((name) => /^dienstplan-.*\.db$/.test(name))
    .map((name) => ({ name, path: path.join(backupDirectory, name), time: fs.statSync(path.join(backupDirectory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const oldBackup of backups.slice(keep)) fs.rmSync(oldBackup.path, { force: true });
}

function createDatabaseBackupToDirectory(backupDirectory, reason = "automatic", kind = "external") {
  if (databasePath === ":memory:" || !fs.existsSync(databasePath)) return null;
  fs.mkdirSync(backupDirectory, { recursive: true });
  const target = path.join(backupDirectory, `dienstplan-${backupTimestamp()}.db`);
  const escapedTarget = target.replaceAll("\\", "/").replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escapedTarget}'`);
  pruneDatabaseBackups(backupDirectory, 30);
  return { path: target, createdAt: new Date().toISOString(), reason, kind };
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
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      entry_timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'portal',
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE CASCADE ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      correction_date TEXT NOT NULL,
      requested_change TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
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

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vacation_requests_employee ON vacation_requests(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_time_entries_employee_date ON time_entries(employee_number, entry_timestamp);
    CREATE INDEX IF NOT EXISTS idx_time_corrections_employee ON time_corrections(employee_number, status);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_portal_users_role_active ON portal_users(role, active);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_employee ON portal_sessions(employee_number, expires_at);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry ON portal_sessions(expires_at, revoked_at);
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

function ensureDefaultLocation() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM locations").get().count;
  if (count === 0) {
    db.prepare("INSERT INTO locations (id, name, active) VALUES ('01', 'Hauptstandort', 1)").run();
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

app.use(express.json({ limit: "1mb" }));
app.use("/branding-kits", express.static(brandingKitsDirectory));
app.use("/vendor/quill", express.static(path.join(__dirname, "node_modules", "quill", "dist")));
app.use(express.static(path.join(__dirname, "public")));

function httpError(status, message, code = "") {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

async function hashPortalPassword(password) {
  const value = String(password || "");
  if (value.length < PORTAL_PASSWORD_MIN_LENGTH) {
    throw httpError(400, `Das Passwort muss mindestens ${PORTAL_PASSWORD_MIN_LENGTH} Zeichen lang sein.`, "PORTAL_PASSWORD_TOO_SHORT");
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

function assertWeekEditable(weekStart, settings = getSettings()) {
  if (isPastWeekStart(weekStart) && !settingEnabled(settings, "allow_past_week_editing")) {
    throw httpError(423, "Vergangene Kalenderwochen sind standardmäßig gesperrt. Das kann in den Grundeinstellungen aktiviert werden.");
  }
}

function assertDateEditable(isoDate, settings = getSettings()) {
  assertWeekEditable(getMonday(isoDate), settings);
}

function getSettings() {
  const stored = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  const requestedMode = stored.operation_mode === "server" ? "server" : DEFAULT_OPERATION_MODE;
  const effectiveMode = requestedMode === "server" && SERVER_MODE_STATUS === "active" ? "server" : DEFAULT_OPERATION_MODE;
  return {
    ...stored,
    operation_mode: effectiveMode,
    server_mode_status: SERVER_MODE_STATUS,
  };
}

function getPortalSettings() {
  if (!tableExists("portal_settings")) return { ...defaultPortalSettings };
  return {
    ...defaultPortalSettings,
    ...Object.fromEntries(db.prepare("SELECT key, value FROM portal_settings").all().map((row) => [row.key, row.value])),
  };
}

function parsePortalPermissions(value) {
  try {
    const permissions = JSON.parse(value || "[]");
    return Array.isArray(permissions) ? permissions.filter((permission) => typeof permission === "string") : [];
  } catch {
    return [];
  }
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

function getPortalStatus() {
  const settings = getSettings();
  const portalSettings = getPortalSettings();
  const portalEnabled = settings.operation_mode === "server" && SERVER_MODE_STATUS === "active";
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
    loginRequired: portalEnabled && portalSettings.login_required === "1",
    adminSetupState: configuredAdmin ? "configured" : "not-configured",
    adminSetupAvailable: portalEnabled,
    localOnly: loopbackHosts.has(HOST.toLowerCase()),
    capabilities: {
      login: portalEnabled,
      ownSchedule: portalEnabled,
      vacationRequests: portalEnabled,
      timeTracking: portalEnabled,
    },
  };
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
      SELECT id, name, min_staff, active, created_at
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
  const location = db.prepare("SELECT id, name, min_staff, active FROM locations WHERE id = ?").get(locationId);
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
  return { id, name, minStaff, active: body.active === false ? 0 : 1 };
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

function applyBrandingKit(kit, contextInput = {}) {
  const brandingSource = kit.branding || kit;
  const pdfSource = kit.pdf || {};
  const brandingValues = brandingValuesFromBody(brandingSource);
  const scheduleContext = resolvePlanningContext(contextInput);
  const vacationContext = resolvePlanningContext({ ...contextInput, departmentId: null, department: null });
  const scheduleTitle = pdfSource.scheduleTitle ? validatePdfText(pdfSource.scheduleTitle, "den Dienstplan-PDF-Titel") : null;
  const schedulePrefix = pdfSource.scheduleFilenamePrefix ? validatePdfText(pdfSource.scheduleFilenamePrefix, "der Dienstplan-PDF-Dateiname", { min: 5, max: 80 }) : null;
  const vacationTitle = pdfSource.vacationTitle ? validatePdfText(pdfSource.vacationTitle, "den Urlaubsplaner-PDF-Titel") : null;
  const vacationPrefix = pdfSource.vacationFilenamePrefix ? validatePdfText(pdfSource.vacationFilenamePrefix, "der Urlaubsplaner-PDF-Dateiname", { min: 5, max: 80 }) : null;
  const update = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(brandingValues)) update.run(key, value);
    const scheduleValues = {};
    if (scheduleTitle) {
      update.run("pdf_title", scheduleTitle);
      scheduleValues.pdf_title = scheduleTitle;
    }
    if (schedulePrefix) {
      update.run("pdf_filename_prefix", schedulePrefix);
      scheduleValues.pdf_filename_prefix = schedulePrefix;
    }
    const vacationValues = {};
    if (vacationTitle) {
      update.run("vacation_pdf_title", vacationTitle);
      vacationValues.vacation_pdf_title = vacationTitle;
    }
    if (vacationPrefix) {
      update.run("vacation_pdf_filename_prefix", vacationPrefix);
      vacationValues.vacation_pdf_filename_prefix = vacationPrefix;
    }
    if (Object.keys(scheduleValues).length) saveScopedPdfSettings("schedule", scheduleContext, scheduleValues);
    if (Object.keys(vacationValues).length) saveScopedPdfSettings("vacation", vacationContext, vacationValues);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ok: true, settings: getSettings(), branding: brandingFromSettings(getSettings()) };
}

function brandingKitForExport(requestQuery) {
  const scheduleContext = resolvePlanningContext(requestQuery);
  const vacationContext = resolvePlanningContext({ ...requestQuery, departmentId: null, department: null });
  const baseSettings = getSettings();
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

function listBrandingKits() {
  const current = brandingFromSettings(getSettings());
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
      active: branding.logoUrl === current.logoUrl
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
  return config ? { start: config.start, end: config.end } : null;
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
  const settings = getSettings();
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

  if (!db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(employeeNumber)) {
    throw httpError(404, "Die ausgewählte Person wurde nicht gefunden.");
  }
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateTo < dateFrom) {
    throw httpError(400, "Bitte einen gültigen Zeitraum eingeben.");
  }
  if (dateFrom < weekStart || dateTo > addDays(weekStart, 6)) {
    throw httpError(400, "Der Zeitraum muss innerhalb der ausgewählten Woche liegen.");
  }
  assertWeekEditable(weekStart);
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

function getSchedule(weekValue, contextInput = {}) {
  const weekStart = getMonday(isIsoDate(weekValue) ? weekValue : undefined);
  const weekEnd = addDays(weekStart, 6);
  const context = resolvePlanningContext(contextInput);
  const settings = applyScopedPdfSettings(getSettings(), context, "schedule");
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
    locations: getLocations(true),
    settings,
    currentWeekStart: currentWeekStart(),
    isPastWeek: isPastWeekStart(weekStart),
    isPastWeekLocked: isPastWeekStart(weekStart) && !settingEnabled(settings, "allow_past_week_editing"),
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

function getVacationPlan(yearValue, contextInput = {}) {
  const year = validateYear(yearValue);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const today = new Date().toISOString().slice(0, 10);
  const consumedEnd = today < yearStart ? null : today > yearEnd ? yearEnd : today;
  const context = resolvePlanningContext({ ...contextInput, departmentId: null, department: null });
  const settings = applyScopedPdfSettings(getSettings(), context, "vacation");
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
    locations: getLocations(true),
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
  assertWeekEditable(weekStart);

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
  assertWeekEditable(weekStart);
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

app.get("/api/health", (_request, response) => response.json({ ok: true }));

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
    canAutoUpdate: Boolean(asset),
  };
}

app.get("/api/system-info", (_request, response) => {
  const settings = getSettings();
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
    appBackupDirectory,
    backupDirectory: backupDirectoryFromSettings(settings),
    externalBackupEnabled: settingEnabled(settings, "external_backup_enabled"),
    backupIntervalHours: Number(settings.backup_interval_hours || 2),
    lastBackup,
    adminContact: brandingFromSettings(settings).adminEmail,
    appName: brandingFromSettings(settings).appName,
    branding: brandingFromSettings(settings),
    appVersion: packageMetadata.version,
    appVersionLabel: APP_VERSION_LABEL,
    portal: getPortalStatus(),
    runtimeDrive: runtimeDriveInfo(),
  });
});

app.get("/api/update-status", async (_request, response) => {
  response.json(await buildUpdateStatus());
});

app.post("/api/update-apply", async (_request, response) => {
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
$robocopyOutput = & robocopy $source $appDir /E /XD (Join-Path $source '.git') (Join-Path $source 'data') (Join-Path $source 'backups') (Join-Path $source 'release') /XF '*.db' '*.db-shm' '*.db-wal' '*.log' /NFL /NDL /NJH /NJS /NP 2>&1
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

app.post("/api/system/exit", (_request, response) => {
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
  response.on("finish", () => setTimeout(shutdown, 350));
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
  Write-ImportLog "Datenbank ersetzt."
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
    `);
    const updateSetting = imported.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const updatePdfSetting = imported.prepare(`
      INSERT INTO pdf_settings (scope_type, location_id, department_key, key, value, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scope_type, location_id, department_key, key)
      DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    imported.exec("BEGIN");
    try {
      for (const row of snapshot.settings || []) updateSetting.run(row.key, row.value);
      for (const row of snapshot.pdfSettings || []) {
        updatePdfSetting.run(row.scope_type, row.location_id, row.department_key || "", row.key, row.value);
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
  if (!Buffer.isBuffer(request.body) || request.body.length < 1024) {
    throw httpError(400, "Bitte eine gültige Backup-Datei auswählen.");
  }
  fs.mkdirSync(dataDirectory, { recursive: true });
  const importPath = path.join(dataDirectory, `pending-import-${backupTimestamp()}.db`);
  fs.writeFileSync(importPath, request.body);
  let importedDatabase;
  try {
    importedDatabase = new DatabaseSync(importPath, { readOnly: true });
    importedDatabase.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
  } catch {
    fs.rmSync(importPath, { force: true });
    throw httpError(400, "Die ausgewählte Datei ist keine lesbare SQLite-Backup-Datei.");
  } finally {
    if (importedDatabase) importedDatabase.close();
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
  response.json(getSchedule(request.query.week, request.query));
});

app.put("/api/schedule-note", (request, response) => {
  const note = validateScheduleNote(request.body);
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
  assertWeekEditable(weekStart);
  db.prepare("DELETE FROM schedule_notes WHERE location_id = ? AND department_key = ? AND week_start = ?")
    .run(context.locationId, pdfDepartmentKey(context), weekStart);
  response.status(204).end();
});

app.get("/api/locations", (_request, response) => {
  response.json(getLocations(true));
});

app.post("/api/locations", (request, response) => {
  const location = validateLocationPayload(request.body, true);
  try {
    db.prepare("INSERT INTO locations (id, name, min_staff, active) VALUES (?, ?, ?, ?)")
      .run(location.id, location.name, location.minStaff, location.active);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Filial-ID ist bereits vergeben.");
    throw error;
  }
  response.status(201).json(getLocations(true));
});

app.put("/api/locations/:id", (request, response) => {
  const id = normalizeLocationId(request.params.id);
  const location = validateLocationPayload({ ...request.body, id }, false);
  const result = db.prepare("UPDATE locations SET name = ?, min_staff = ?, active = ? WHERE id = ?")
    .run(location.name, location.minStaff, location.active, id);
  if (!result.changes) throw httpError(404, "Die Filiale wurde nicht gefunden.");
  response.json(getLocations(true));
});

app.post("/api/departments", (request, response) => {
  const department = validateDepartmentPayload(request.body);
  try {
    const sortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM departments WHERE location_id = ?")
      .get(department.locationId).next;
    db.prepare("INSERT INTO departments (location_id, name, min_staff, active, sort_order) VALUES (?, ?, ?, ?, ?)")
      .run(department.locationId, department.name, department.minStaff, department.active, sortOrder);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Abteilung gibt es in der Filiale bereits.");
    throw error;
  }
  response.status(201).json(getLocations(true));
});

app.put("/api/departments/:id", (request, response) => {
  const id = normalizeDepartmentId(request.params.id, false);
  validateDepartmentExists(id);
  const department = validateDepartmentPayload(request.body, id);
  try {
    const result = db.prepare("UPDATE departments SET location_id = ?, name = ?, min_staff = ?, active = ? WHERE id = ?")
      .run(department.locationId, department.name, department.minStaff, department.active, id);
    if (!result.changes) throw httpError(404, "Die Abteilung wurde nicht gefunden.");
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Diese Abteilung gibt es in der Filiale bereits.");
    throw error;
  }
  response.json(getLocations(true));
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

app.get("/api/employees", (_request, response) => {
  response.json(
    db
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
      .all()
      .map(serializeEmployee),
  );
});

app.post("/api/employees", (request, response) => {
  const employee = validateEmployee(request.body, true);
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
  const employee = validateEmployee({ ...request.body, personnelNumber }, false);
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

app.get("/api/portal/v1/session", (_request, response) => {
  const status = getPortalStatus();
  response.json({
    apiVersion: PORTAL_API_VERSION,
    authenticated: false,
    loginRequired: status.loginRequired,
    user: null,
    status,
  });
});

app.all([
  "/api/portal/v1/auth/login",
  "/api/portal/v1/auth/logout",
  "/api/portal/v1/setup/admin",
  "/api/portal/v1/me",
  "/api/portal/v1/me/schedule",
  "/api/portal/v1/me/vacation-requests",
  "/api/portal/v1/me/time-entries",
], sendPortalInactive);

app.get("/api/settings", (_request, response) => response.json(getSettings()));

app.get("/api/branding/export", (request, response) => {
  const kit = brandingKitForExport(request.query);
  response.setHeader("Content-Disposition", contentDispositionHeader("grabenplaner-branding-kit.json"));
  response.json(kit);
});

app.get("/api/branding/export.zip", (request, response) => {
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

app.get("/api/branding/kits", (_request, response) => {
  response.json(listBrandingKits());
});

app.post("/api/branding/kits/:kitId/apply", (request, response) => {
  const kit = readBrandingKitManifest(request.params.kitId);
  response.json({
    ...applyBrandingKit(kit, request.body || {}),
    kits: listBrandingKits(),
  });
});

app.put("/api/branding/import", (request, response) => {
  const kit = request.body?.kit || request.body || {};
  const installedKit = installBrandingKit(kit, { fileName: request.get("X-Branding-Filename") || "branding-kit.json" });
  response.json({
    ...applyBrandingKit(installedKit, request.body || {}),
    kit: installedKit,
    kits: listBrandingKits(),
  });
});

app.put("/api/branding/import.zip", express.raw({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: "25mb" }), (request, response) => {
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
    response.json({
      ...applyBrandingKit(installedKit, request.query || {}),
      kit: installedKit,
      kits: listBrandingKits(),
    });
  } catch (error) {
    if (error.status) throw error;
    if (error instanceof SyntaxError) throw httpError(400, "Die Branding-Kit-JSON in der ZIP-Datei ist ungültig.");
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

app.put("/api/settings", (request, response) => {
  const body = request.body;
  const requestedOperationMode = String(body.operationMode || DEFAULT_OPERATION_MODE);
  if (requestedOperationMode !== DEFAULT_OPERATION_MODE) {
    throw httpError(409, "Der Serverbetrieb ist technisch vorbereitet, aber in dieser Version noch nicht aktiv.", "SERVER_MODE_NOT_READY");
  }
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
  const submittedDays = body.daySettings || {};
  const toastDuration = ["short", "medium", "long"].includes(String(body.toastDuration))
    ? String(body.toastDuration)
    : "medium";
  const brandingValues = brandingValuesFromBody(body.branding || body);

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

  const values = {
    ...brandingValues,
    operation_mode: DEFAULT_OPERATION_MODE,
    toast_duration: toastDuration,
    show_inactive_personnel: body.showInactivePersonnel === true ? "1" : "0",
    show_saturday_service_stats: body.showSaturdayServiceStats === false ? "0" : "1",
    external_backup_enabled: externalBackupEnabled ? "1" : "0",
    backup_directory: backupDirectory.stored,
    backup_interval_hours: String(backupIntervalHours),
    vacation_count_saturday: body.vacationCountSaturday === true ? "1" : "0",
    vacation_pdf_size: "A4",
    allow_past_week_editing: body.allowPastWeekEditing === true ? "1" : "0",
    break_rule_enabled: body.breakRuleEnabled === false ? "0" : "1",
    break_after_minutes: String(breakAfterMinutes),
    break_duration_minutes: String(breakDurationMinutes),
    saturday_bonus_enabled: body.saturdayBonusEnabled === false ? "0" : "1",
    saturday_bonus_from: saturdayBonusFrom,
    saturday_bonus_factor: String(saturdayBonusFactor),
    show_sunday: body.showSunday === true ? "1" : "0",
  };
  for (const [day] of planningDays) {
    const submitted = submittedDays[day] || {};
    const start = String(submitted.start || "");
    const end = String(submitted.end || "");
    const lunchEnabled = submitted.lunchEnabled === true;
    const lunchStart = String(submitted.lunchStart || "");
    const lunchEnd = String(submitted.lunchEnd || "");
    const minStaff = Number(submitted.minStaff || 0);
    const minFrom = String(submitted.minFrom || "");
    const minTo = String(submitted.minTo || "");

    if (![start, end, lunchStart, lunchEnd, minFrom, minTo].every(isTime)) {
      throw httpError(400, `Bitte gültige Zeiten für ${day} eingeben.`);
    }
    if (end <= start) throw httpError(400, `Das Dienstende für ${day} muss nach dem Beginn liegen.`);
    if (lunchEnabled && (lunchEnd <= lunchStart || lunchStart < start || lunchEnd > end)) {
      throw httpError(400, `Die Mittagspause für ${day} muss innerhalb der Dienstzeit liegen.`);
    }
    if (!Number.isInteger(minStaff) || minStaff < 0 || minStaff > 99) {
      throw httpError(400, `Die Mindestbesetzung für ${day} ist ungültig.`);
    }
    if (minTo <= minFrom || minFrom < start || minTo > end) {
      throw httpError(400, `Der Zeitraum der Mindestbesetzung für ${day} muss innerhalb der Dienstzeit liegen.`);
    }

    values[`${day}_start_time`] = start;
    values[`${day}_end_time`] = end;
    values[`${day}_lunch_enabled`] = lunchEnabled ? "1" : "0";
    values[`${day}_lunch_start`] = lunchStart;
    values[`${day}_lunch_end`] = lunchEnd;
    values[`${day}_min_staff`] = String(minStaff);
    values[`${day}_min_from`] = minFrom;
    values[`${day}_min_to`] = minTo;
  }
  const update = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(values)) update.run(key, value);
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
  response.json(getSettings());
});

app.post("/api/shifts", (request, response) => {
  const shift = validateShift(request.body);
  const result = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(shift.employeeNumber, shift.departmentId, shift.shiftDate, shift.startTime, shift.endTime, shift.area, shift.note);
  response.status(201).json({ id: Number(result.lastInsertRowid), ...shift });
});

app.put("/api/shifts/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT shift_date FROM shifts WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  assertDateEditable(existing.shift_date);
  const shift = validateShift(request.body);
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
  const existing = db.prepare("SELECT shift_date FROM shifts WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  assertDateEditable(existing.shift_date);
  const result = db.prepare("DELETE FROM shifts WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Der Dienst wurde nicht gefunden.");
  response.status(204).end();
});

app.delete("/api/schedule", (request, response) => {
  const weekStart = getMonday(isIsoDate(request.query.week) ? request.query.week : undefined);
  const weekEnd = addDays(weekStart, 6);
  const context = resolvePlanningContext(request.query);
  assertWeekEditable(weekStart);
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
  const existing = db.prepare("SELECT group_id, week_start FROM week_options WHERE id = ?").get(id);
  if (!existing) {
    throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  }
  assertWeekEditable(existing.week_start);
  const option = validateWeekOption({
    ...request.body,
    groupId: request.body.groupId === undefined ? existing.group_id : request.body.groupId,
  }, id);
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
  const existing = db.prepare("SELECT week_start FROM week_options WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  assertWeekEditable(existing.week_start);
  const result = db.prepare("DELETE FROM week_options WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Die Planungsoption wurde nicht gefunden.");
  response.status(204).end();
});

app.post("/api/global-day-blocks", (request, response) => {
  const block = validateGlobalDayBlock(request.body);
  const result = db.prepare(`
    INSERT INTO global_day_blocks (location_id, week_start, block_date, reason, is_public_holiday)
    VALUES (?, ?, ?, ?, ?)
  `).run(block.locationId, block.weekStart, block.blockDate, block.reason, block.isPublicHoliday);
  response.status(201).json({ id: Number(result.lastInsertRowid), ...block, schedule: getSchedule(block.weekStart, { locationId: block.locationId }) });
});

app.put("/api/global-day-blocks/:id", (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Der Sperrtag ist ungültig.");
  const existing = db.prepare("SELECT week_start FROM global_day_blocks WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  assertWeekEditable(existing.week_start);
  const block = validateGlobalDayBlock(request.body, id);
  db.prepare(`
    UPDATE global_day_blocks
    SET location_id = ?, week_start = ?, block_date = ?, reason = ?, is_public_holiday = ?
    WHERE id = ?
  `).run(block.locationId, block.weekStart, block.blockDate, block.reason, block.isPublicHoliday, id);
  response.json({ id, ...block, schedule: getSchedule(block.weekStart, { locationId: block.locationId }) });
});

app.delete("/api/global-day-blocks/:id", (request, response) => {
  const id = Number(request.params.id);
  const existing = db.prepare("SELECT week_start FROM global_day_blocks WHERE id = ?").get(id);
  if (!existing) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  assertWeekEditable(existing.week_start);
  const result = db.prepare("DELETE FROM global_day_blocks WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "Der Sperrtag wurde nicht gefunden.");
  response.status(204).end();
});

app.get("/api/vacations", (request, response) => {
  response.json(getVacationPlan(request.query.year, request.query));
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

  response.json(getVacationPlan(year, request.body));
});

app.post("/api/vacations", (request, response) => {
  const vacation = validateVacationEntry(request.body);
  const result = createVacationEntries(vacation);
  response.status(201).json({
    groupId: result.groupId,
    plan: getVacationPlan(new Date(`${vacation.dateFrom}T12:00:00Z`).getUTCFullYear(), request.body),
  });
});

app.put("/api/vacations/:groupId", (request, response) => {
  const groupId = String(request.params.groupId || "").trim();
  if (!groupId || !vacationGroupExists(groupId)) {
    throw httpError(404, "Der Urlaubseintrag wurde nicht gefunden.");
  }
  const vacation = validateVacationEntry(request.body, groupId);
  const result = replaceVacationGroup(groupId, vacation);
  response.json({
    groupId: result.groupId,
    plan: getVacationPlan(new Date(`${vacation.dateFrom}T12:00:00Z`).getUTCFullYear(), request.body),
  });
});

app.delete("/api/vacations/:groupId", (request, response) => {
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
  const settings = getSettings();
  const context = resolvePlanningContext(request.body);
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
    response.json({ created, warnings, schedule: getSchedule(weekStart, context) });
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
  const schedule = getSchedule(request.query.week, request.query);
  const createdAt = new Date();
  const filename = buildPdfFilename(schedule, createdAt);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", contentDispositionHeader(filename));
  drawSchedulePdf(schedule, response, createdAt);
});

app.get("/api/vacations.pdf", (request, response) => {
  const selection = vacationSelectionFromQuery(request.query);
  const plan = getVacationPlan(selection.year, request.query);
  const createdAt = new Date();
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", contentDispositionHeader(buildVacationPdfFilename(plan.settings, selection, createdAt)));
  drawVacationPdf(plan, selection, response, createdAt);
});

app.get("/api/schedule-preview.pdf", (request, response) => {
  const schedule = getSchedule(request.query.week, request.query);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", "inline");
  drawSchedulePdf(schedule, response, new Date());
});

app.get("/api/vacations-preview.pdf", (request, response) => {
  const selection = vacationSelectionFromQuery(request.query);
  const plan = getVacationPlan(selection.year, request.query);
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", "inline");
  drawVacationPdf(plan, selection, response, new Date());
});

app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error.status) && error.status >= 100 && error.status < 1000 ? error.status : 500;
  if (status >= 500) console.error(error);
  const payload = {
    error: error.message || "Ein unerwarteter Fehler ist aufgetreten.",
  };
  if (error.code) payload.code = error.code;
  response.status(status).json(payload);
});

let shutdownStarted = false;
let databaseClosed = false;
let server = null;

function startServer() {
  if (server) return server;
  server = app.listen(PORT, HOST, () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : PORT;
    console.log(`${APP_NAME} läuft auf http://localhost:${listeningPort}`);
    scheduleAutomaticBackups();
    setTimeout(() => {
      try {
        const backup = createDatabaseBackup("startup");
        if (backup) console.log(`Backup erstellt: ${backup.path}`);
      } catch (error) {
        console.error("Backup konnte nicht erstellt werden:", error);
      }
    }, 1500);
  });
  return server;
}

function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const finish = () => {
    if (!databaseClosed) {
      databaseClosed = true;
      db.close();
    }
    process.exit(0);
  };
  if (backupInterval) clearInterval(backupInterval);
  if (!server) {
    finish();
    return;
  }
  const forceExit = setTimeout(finish, 4000);
  forceExit.unref();
  server.close(finish);
}

if (require.main === module) {
  startServer();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
};
