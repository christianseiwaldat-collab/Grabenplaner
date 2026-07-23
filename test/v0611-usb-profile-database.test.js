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
    CREATE TABLE cost_centers (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT, description TEXT, active INTEGER, sort_order INTEGER, created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT, cost_center_id TEXT, min_staff INTEGER, day_settings_json TEXT, time_tracking_enabled INTEGER, time_tracking_access_mode TEXT, time_tracking_allowed_networks TEXT, time_tracking_variance_minutes INTEGER, active INTEGER, created_at TEXT);
    CREATE TABLE departments (id INTEGER PRIMARY KEY, location_id TEXT, name TEXT, min_staff INTEGER, active INTEGER, sort_order INTEGER, created_at TEXT);
    CREATE TABLE location_branding (location_id TEXT PRIMARY KEY, kit_id TEXT, company_name TEXT, logo_url TEXT, icon_url TEXT, logo_alt TEXT, admin_email TEXT, updated_by TEXT, updated_at TEXT);
    CREATE TABLE pdf_settings (scope_type TEXT, location_id TEXT, department_key TEXT, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY(scope_type, location_id, department_key, key));
    CREATE TABLE employees (personnel_number TEXT PRIMARY KEY, full_name TEXT, nickname TEXT, color TEXT, contracted_hours REAL, preferred_day_off TEXT, fixed_workdays TEXT, position_id TEXT, time_confirmation_level TEXT, home_location_id TEXT, preferred_department_id INTEGER, cost_center_id TEXT, active INTEGER, created_at TEXT);
    CREATE TABLE portal_users (employee_number TEXT PRIMARY KEY, password_hash TEXT, role TEXT, role_locked INTEGER, active INTEGER, must_change_password INTEGER, last_login_at TEXT, password_changed_at TEXT, failed_login_attempts INTEGER, locked_until TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE portal_permission_grants (employee_number TEXT, permission TEXT, granted_by TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(employee_number, permission));
    CREATE TABLE portal_permission_denials (employee_number TEXT, permission TEXT, denied_by TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(employee_number, permission));
    CREATE TABLE portal_access_scopes (employee_number TEXT, location_id TEXT, department_id INTEGER, assigned_by TEXT, created_at TEXT, PRIMARY KEY(employee_number, location_id, department_id));
    CREATE TABLE custom_processes (id TEXT PRIMARY KEY, title TEXT, symbol TEXT, description TEXT, scope_type TEXT, location_id TEXT, department_id INTEGER, trigger_type TEXT, trigger_minimum_shortfall INTEGER, status TEXT, revision INTEGER, created_by TEXT, updated_by TEXT, archived_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE custom_process_steps (id TEXT PRIMARY KEY, process_id TEXT, sort_order INTEGER, step_type TEXT, title TEXT, description TEXT, responsibility_type TEXT, responsibility_reference TEXT, responsibility_label TEXT, condition_type TEXT, condition_text TEXT, notification_channels TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE custom_process_revisions (process_id TEXT, revision INTEGER, snapshot_json TEXT, created_by TEXT, created_at TEXT, PRIMARY KEY(process_id, revision));
    CREATE TABLE custom_process_runs (id TEXT PRIMARY KEY, process_id TEXT, process_revision INTEGER, trigger_type TEXT, trigger_key TEXT, status TEXT, location_id TEXT, department_id INTEGER, triggered_by TEXT, resolved_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE custom_process_run_steps (run_id TEXT, step_id TEXT, sort_order INTEGER, status TEXT, completed_by TEXT, completion_note TEXT, PRIMARY KEY(run_id, step_id));
    CREATE TABLE outbound_notification_jobs (id TEXT PRIMARY KEY, notification_kind TEXT, payload TEXT);
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
    INSERT INTO portal_roles (id,name,builtin,permissions,sort_order) VALUES
      ('admin','Admin',1,'[]',30),
      ('department_manager','Abteilungsleitung',1,'[]',20),
      ('employee','Mitarbeiter',1,'[]',10);
    INSERT INTO shifts VALUES (1,'999','2026-01-01');
    INSERT INTO portal_sessions VALUES ('secret','999');
  `);
  source.exec(`
    INSERT INTO settings VALUES ('pdf_title','Dienstplan Muster'),('branding_company_name','Alt'),('operation_mode','server');
    INSERT INTO positions (id,name,builtin,sort_order) VALUES ('verkaufsmitarbeiter','Verkaufsmitarbeiter',1,10);
    INSERT INTO cost_centers (id,code,name,type,description,active,sort_order) VALUES ('cc18','FIL18','Musterfiliale','branch','',1,118),('cc99','FIL99','Nicht dabei','branch','',1,199);
    INSERT INTO locations (id,name,cost_center_id,min_staff,day_settings_json,time_tracking_enabled,time_tracking_access_mode,time_tracking_allowed_networks,time_tracking_variance_minutes,active) VALUES ('18','Musterfiliale','cc18',2,'{}',0,'anywhere','',15,1),('99','Nicht dabei','cc99',1,'{}',0,'anywhere','',15,1);
    INSERT INTO departments (id,location_id,name,min_staff,active,sort_order) VALUES (1,'18','Hardware',1,1,1),(2,'99','Andere',1,1,1);
    INSERT INTO employees (personnel_number,full_name,nickname,color,contracted_hours,fixed_workdays,position_id,time_confirmation_level,home_location_id,preferred_department_id,cost_center_id,active) VALUES
      ('101','Alex Beispiel','Alex','#123456',40,'','verkaufsmitarbeiter','A','18',1,'cc18',1),
      ('500','Demo Person','Demo','#654321',30,'','verkaufsmitarbeiter','C','18',1,'cc18',1),
      ('999','Nicht Ausgewählt','Extern','#111111',20,'','verkaufsmitarbeiter','C','18',1,'cc18',1);
    INSERT INTO custom_processes (id,title,scope_type,location_id,department_id,status,revision,created_by,updated_by) VALUES
      ('company-active','Unternehmensprozess','company',NULL,NULL,'active',3,'999','101'),
      ('location-active','Filialprozess','location','18',NULL,'active',4,'101','999'),
      ('department-active','Abteilungsprozess','department','18',1,'active',5,'999','999'),
      ('personal-unselected','Personenprozess','company',NULL,NULL,'active',2,'999','999'),
      ('location-other','Fremde Filiale','location','99',NULL,'active',1,'999','999'),
      ('department-other','Fremde Abteilung','department','99',2,'active',1,'999','999'),
      ('company-draft','Entwurf','company',NULL,NULL,'draft',1,'999','999'),
      ('company-archived','Archiv','company',NULL,NULL,'archived',1,'999','999');
    INSERT INTO custom_process_steps
      (id,process_id,sort_order,step_type,title,responsibility_type,responsibility_reference,responsibility_label)
    VALUES
      ('step-company','company-active',1,'actor','Unternehmensschritt','employee','500','Veralteter Personenname'),
      ('step-location','location-active',1,'system','Filialschritt','system','999','Nicht ausgewählte Person'),
      ('step-department','department-active',1,'finish','Abteilungsschritt','role','department_manager','Personenname statt Rollenname'),
      ('step-personal-unselected','personal-unselected',1,'actor','Nicht auflösbar','employee','999','Nicht ausgewählte Person'),
      ('step-other','location-other',1,'actor','Nicht kopieren','employee','999','Nicht ausgewählte Person'),
      ('step-draft','company-draft',1,'actor','Entwurfsschritt','system','','Grabenplaner');
    INSERT INTO custom_process_revisions (process_id,revision,snapshot_json,created_by) VALUES
      ('company-active',3,'{"leak":"Nicht ausgewählte Person","responsibilityReference":"999"}','999');
    INSERT INTO custom_process_runs (id,process_id,process_revision,trigger_type,trigger_key,status) VALUES ('run-1','company-active',1,'manual','usb-test','open');
    INSERT INTO custom_process_run_steps (run_id,step_id,sort_order,status,completed_by,completion_note) VALUES
      ('run-1','step-company',1,'completed','999','Personenbezogene Laufnotiz');
    INSERT INTO outbound_notification_jobs (id,notification_kind,payload) VALUES ('job-1','custom_process','{}');
    INSERT INTO shifts VALUES (7,'101','2026-07-01');
    INSERT INTO vacation_requests VALUES (8,'101');
    INSERT INTO amu_reports VALUES (9,'101');
    INSERT INTO time_entries VALUES (10,'101');
  `);
  source.close();
  target.close();

  const employeeInput = {
    personnelNumber: "500",
    fullName: "Demo Person",
    nickname: "Demo",
    color: "#654321",
    contractedHours: 30,
    positionId: "verkaufsmitarbeiter",
    homeLocationId: "18",
    preferredDepartmentId: 1,
    costCenterId: "cc18",
    role: "department_manager",
    passwordHash: "scrypt-v1$demo$hash",
    additionalPermissions: ["schedule:read"],
    deniedPermissions: ["schedule:write"],
  };
  const creatorInput = {
    personnelNumber: "101",
    passwordHash: "scrypt-v1$creator$hash",
    employee: {
      personnel_number: "101",
      full_name: "Alex Beispiel",
      nickname: "Alex",
      color: "#123456",
      contracted_hours: 40,
      fixed_workdays: "",
      position_id: "verkaufsmitarbeiter",
      time_confirmation_level: "A",
      home_location_id: "18",
      preferred_department_id: 1,
      cost_center_id: "cc18",
      active: 1,
    },
  };
  const readSource = new DatabaseSync(sourcePath);
  const invalidTargetPath = path.join(directory, "invalid-target.db");
  const invalidTarget = new DatabaseSync(invalidTargetPath);
  schema(invalidTarget);
  invalidTarget.close();
  assert.throws(() => populateUsbProfileDatabase({
    sourceDatabase: readSource,
    targetDatabasePath: invalidTargetPath,
    selectedLocationIds: ["18"],
    employees: [{ ...employeeInput, scopes: [{ locationId: "99", departmentId: 2 }] }],
    creator: creatorInput,
    primaryBranding: { kitId: "muster", companyName: "Muster GmbH" },
    enabledFeatures: ["schedule"],
    permissionCatalog: ["schedule:read", "schedule:write"],
  }), /Bereichsrechte.*Stammfiliale/);

  const result = populateUsbProfileDatabase({
    sourceDatabase: readSource,
    targetDatabasePath: targetPath,
    selectedLocationIds: ["18"],
    employees: [employeeInput],
    creator: creatorInput,
    primaryBranding: { kitId: "muster", companyName: "Muster GmbH", logoUrl: "/branding-kits/muster/assets/logo.svg", iconUrl: "/assets/webicon.svg", logoAlt: "Muster", adminEmail: "admin@example.test" },
    enabledFeatures: ["schedule", "vacation"],
    permissionCatalog: ["schedule:read", "schedule:write"],
  });
  readSource.close();

  const check = new DatabaseSync(targetPath, { readOnly: true });
  assert.equal(result.creator, "101");
  assert.deepEqual(check.prepare("SELECT id FROM locations ORDER BY id").all().map((row) => ({ ...row })), [{ id: "18" }]);
  assert.deepEqual(check.prepare("SELECT id, code FROM cost_centers ORDER BY id").all().map((row) => ({ ...row })), [{ id: "cc18", code: "FIL18" }]);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM employees WHERE cost_center_id = 'cc18'").get().count, 2);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM employees").get().count, 2);
  assert.deepEqual(check.prepare("SELECT employee_number, role, password_hash, active FROM portal_users ORDER BY employee_number").all().map((row) => ({ ...row })), [
    { employee_number: "101", role: "admin", password_hash: "scrypt-v1$creator$hash", active: 1 },
    { employee_number: "500", role: "department_manager", password_hash: "scrypt-v1$demo$hash", active: 1 },
  ]);
  assert.deepEqual(check.prepare("SELECT employee_number, location_id, department_id FROM portal_access_scopes").all().map((row) => ({ ...row })), [
    { employee_number: "500", location_id: "18", department_id: 1 },
  ]);
  assert.deepEqual(check.prepare("SELECT employee_number, permission FROM portal_permission_denials").all().map((row) => ({ ...row })), [
    { employee_number: "500", permission: "schedule:write" },
  ]);
  assert.equal(check.prepare("SELECT value FROM settings WHERE key='operation_mode'").get().value, "local");
  assert.equal(check.prepare("SELECT value FROM settings WHERE key='backup_directory'").get().value, "%GRABENPLANER_ROOT%\\Backups");
  assert.equal(check.prepare("SELECT value FROM settings WHERE key='branding_company_name'").get().value, "Muster GmbH");
  assert.deepEqual(check.prepare("SELECT id FROM custom_processes ORDER BY id").all().map((row) => row.id), [
    "company-active",
    "department-active",
    "location-active",
  ]);
  assert.deepEqual(check.prepare("SELECT id, process_id FROM custom_process_steps ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "step-company", process_id: "company-active" },
    { id: "step-department", process_id: "department-active" },
    { id: "step-location", process_id: "location-active" },
  ]);
  assert.deepEqual(check.prepare("SELECT id, created_by, updated_by FROM custom_processes ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "company-active", created_by: "", updated_by: "101" },
    { id: "department-active", created_by: "", updated_by: "" },
    { id: "location-active", created_by: "101", updated_by: "" },
  ]);
  assert.deepEqual(check.prepare(`
    SELECT id, responsibility_type, responsibility_reference, responsibility_label
    FROM custom_process_steps ORDER BY id
  `).all().map((row) => ({ ...row })), [
    { id: "step-company", responsibility_type: "employee", responsibility_reference: "500", responsibility_label: "Demo Person" },
    { id: "step-department", responsibility_type: "role", responsibility_reference: "department_manager", responsibility_label: "Abteilungsleitung" },
    { id: "step-location", responsibility_type: "system", responsibility_reference: "", responsibility_label: "Grabenplaner" },
  ]);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM custom_processes WHERE id = 'personal-unselected'").get().count, 0);
  assert.deepEqual(check.prepare("SELECT process_id, revision, created_by FROM custom_process_revisions ORDER BY process_id").all().map((row) => ({ ...row })), [
    { process_id: "company-active", revision: 3, created_by: "101" },
    { process_id: "department-active", revision: 5, created_by: "" },
    { process_id: "location-active", revision: 4, created_by: "101" },
  ]);
  const companySnapshot = JSON.parse(check.prepare("SELECT snapshot_json FROM custom_process_revisions WHERE process_id = 'company-active'").get().snapshot_json);
  assert.equal(companySnapshot.id, "company-active");
  assert.equal(companySnapshot.source, "custom");
  assert.equal(companySnapshot.revision, 3);
  assert.equal(companySnapshot.scope.label, "Gesamtes Unternehmen");
  assert.equal(companySnapshot.steps[0].responsibilityReference, "500");
  assert.equal(companySnapshot.steps[0].responsibilityLabel, "Demo Person");
  const revisionPayload = check.prepare("SELECT GROUP_CONCAT(snapshot_json, '') AS payload FROM custom_process_revisions").get().payload;
  assert.equal(revisionPayload.includes("Nicht ausgewählte Person"), false);
  assert.equal(revisionPayload.includes('"responsibilityReference":"999"'), false);
  for (const table of ["custom_process_runs", "custom_process_run_steps", "outbound_notification_jobs", "shifts", "vacation_requests", "amu_reports", "time_entries", "portal_sessions", "audit_log"]) {
    assert.equal(check.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} muss leer sein`);
  }
  check.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
