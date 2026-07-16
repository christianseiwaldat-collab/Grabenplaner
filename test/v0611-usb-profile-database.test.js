"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { populateUsbProfileDatabase } = require("../lib/usb-profile-database");

function schema(database) {
  database.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, app_version TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE portal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE portal_roles (id TEXT PRIMARY KEY, name TEXT, description TEXT, builtin INTEGER, permissions TEXT, sort_order INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE positions (id TEXT PRIMARY KEY, name TEXT, builtin INTEGER, sort_order INTEGER, created_at TEXT);
    CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT, min_staff INTEGER, day_settings_json TEXT, time_tracking_enabled INTEGER, time_tracking_access_mode TEXT, time_tracking_allowed_networks TEXT, time_tracking_variance_minutes INTEGER, active INTEGER, created_at TEXT);
    CREATE TABLE departments (id INTEGER PRIMARY KEY, location_id TEXT, name TEXT, min_staff INTEGER, active INTEGER, sort_order INTEGER, created_at TEXT);
    CREATE TABLE location_branding (location_id TEXT PRIMARY KEY, kit_id TEXT, company_name TEXT, logo_url TEXT, icon_url TEXT, logo_alt TEXT, admin_email TEXT, updated_by TEXT, updated_at TEXT);
    CREATE TABLE pdf_settings (scope_type TEXT, location_id TEXT, department_key TEXT, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY(scope_type, location_id, department_key, key));
    CREATE TABLE employees (personnel_number TEXT PRIMARY KEY, full_name TEXT, nickname TEXT, color TEXT, contracted_hours REAL, preferred_day_off TEXT, fixed_workdays TEXT, position_id TEXT, time_confirmation_level TEXT, home_location_id TEXT, preferred_department_id INTEGER, active INTEGER, created_at TEXT);
    CREATE TABLE portal_users (employee_number TEXT PRIMARY KEY, password_hash TEXT, role TEXT, role_locked INTEGER, active INTEGER, must_change_password INTEGER, last_login_at TEXT, password_changed_at TEXT, failed_login_attempts INTEGER, locked_until TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE portal_permission_grants (employee_number TEXT, permission TEXT, granted_by TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(employee_number, permission));
    CREATE TABLE portal_access_scopes (employee_number TEXT, location_id TEXT, department_id INTEGER, assigned_by TEXT, created_at TEXT, PRIMARY KEY(employee_number, location_id, department_id));
    CREATE TABLE shifts (id INTEGER PRIMARY KEY, employee_number TEXT, shift_date TEXT);
    CREATE TABLE vacation_requests (id INTEGER PRIMARY KEY, employee_number TEXT);
    CREATE TABLE amu_reports (id INTEGER PRIMARY KEY, employee_number TEXT);
    CREATE TABLE time_entries (id INTEGER PRIMARY KEY, employee_number TEXT);
    CREATE TABLE portal_sessions (id TEXT PRIMARY KEY, employee_number TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor TEXT);
  `);
}

test("USB-Profil erzeugt nur Stammdaten und setzt den Ersteller als Admin", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-usb-db-test-"));
  const sourcePath = path.join(directory, "source.db");
  const targetPath = path.join(directory, "target.db");
  const source = new DatabaseSync(sourcePath);
  const target = new DatabaseSync(targetPath);
  schema(source);
  schema(target);
  target.exec(`
    INSERT INTO schema_migrations VALUES ('current', '0.61.1-beta');
    INSERT INTO settings VALUES ('operation_mode', 'local');
    INSERT INTO portal_settings VALUES ('login_required', '1');
    INSERT INTO portal_roles (id,name,builtin,permissions,sort_order) VALUES ('admin','Admin',1,'[]',30),('employee','Mitarbeiter',1,'[]',10);
    INSERT INTO shifts VALUES (1,'999','2026-01-01');
    INSERT INTO portal_sessions VALUES ('secret','999');
  `);
  source.exec(`
    INSERT INTO settings VALUES ('pdf_title','Dienstplan Muster'),('branding_company_name','Alt'),('operation_mode','server');
    INSERT INTO positions (id,name,builtin,sort_order) VALUES ('verkaufsmitarbeiter','Verkaufsmitarbeiter',1,10);
    INSERT INTO locations (id,name,min_staff,day_settings_json,time_tracking_enabled,time_tracking_access_mode,time_tracking_allowed_networks,time_tracking_variance_minutes,active) VALUES ('18','Musterfiliale',2,'{}',0,'anywhere','',15,1),('99','Nicht dabei',1,'{}',0,'anywhere','',15,1);
    INSERT INTO departments (id,location_id,name,min_staff,active,sort_order) VALUES (1,'18','Hardware',1,1,1),(2,'99','Andere',1,1,1);
    INSERT INTO employees (personnel_number,full_name,nickname,color,contracted_hours,fixed_workdays,position_id,time_confirmation_level,home_location_id,preferred_department_id,active) VALUES ('101','Alex Beispiel','Alex','#123456',40,'','verkaufsmitarbeiter','A','18',1,1),('500','Demo Person','Demo','#654321',30,'','verkaufsmitarbeiter','C','18',1,1);
    INSERT INTO shifts VALUES (7,'101','2026-07-01');
    INSERT INTO vacation_requests VALUES (8,'101');
    INSERT INTO amu_reports VALUES (9,'101');
    INSERT INTO time_entries VALUES (10,'101');
  `);
  source.close();
  target.close();

  const readSource = new DatabaseSync(sourcePath);
  const result = populateUsbProfileDatabase({
    sourceDatabase: readSource,
    targetDatabasePath: targetPath,
    selectedLocationIds: ["18"],
    employees: [{ personnelNumber: "500", fullName: "Demo Person", nickname: "Demo", color: "#654321", contractedHours: 30, positionId: "verkaufsmitarbeiter", homeLocationId: "18", preferredDepartmentId: 1, role: "department_manager", passwordHash: "scrypt-v1$demo$hash", additionalPermissions: ["schedule:read"] }],
    creator: { personnelNumber: "101", passwordHash: "scrypt-v1$creator$hash", employee: { personnel_number: "101", full_name: "Alex Beispiel", nickname: "Alex", color: "#123456", contracted_hours: 40, fixed_workdays: "", position_id: "verkaufsmitarbeiter", time_confirmation_level: "A", home_location_id: "18", preferred_department_id: 1, active: 1 } },
    primaryBranding: { kitId: "muster", companyName: "Muster GmbH", logoUrl: "/branding-kits/muster/assets/logo.svg", iconUrl: "/assets/webicon.svg", logoAlt: "Muster", adminEmail: "admin@example.test" },
    enabledFeatures: ["schedule", "vacation"],
    permissionCatalog: ["schedule:read"],
  });
  readSource.close();

  const check = new DatabaseSync(targetPath, { readOnly: true });
  assert.equal(result.creator, "101");
  assert.deepEqual(check.prepare("SELECT id FROM locations ORDER BY id").all().map((row) => ({ ...row })), [{ id: "18" }]);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM employees").get().count, 2);
  assert.deepEqual(check.prepare("SELECT employee_number, role, password_hash, active FROM portal_users ORDER BY employee_number").all().map((row) => ({ ...row })), [
    { employee_number: "101", role: "admin", password_hash: "scrypt-v1$creator$hash", active: 1 },
    { employee_number: "500", role: "department_manager", password_hash: "scrypt-v1$demo$hash", active: 1 },
  ]);
  assert.deepEqual(check.prepare("SELECT employee_number, location_id, department_id FROM portal_access_scopes").all().map((row) => ({ ...row })), [
    { employee_number: "500", location_id: "18", department_id: 1 },
  ]);
  assert.equal(check.prepare("SELECT value FROM settings WHERE key='operation_mode'").get().value, "local");
  assert.equal(check.prepare("SELECT value FROM settings WHERE key='backup_directory'").get().value, "%GRABENPLANER_ROOT%\\Backups");
  assert.equal(check.prepare("SELECT value FROM settings WHERE key='branding_company_name'").get().value, "Muster GmbH");
  for (const table of ["shifts", "vacation_requests", "amu_reports", "time_entries", "portal_sessions", "audit_log"]) {
    assert.equal(check.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} muss leer sein`);
  }
  check.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
