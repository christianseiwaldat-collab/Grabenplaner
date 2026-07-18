"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-cost-centers-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, releaseInstanceLockForTests } = subject;

const HR = "103";
const MANAGER = "104";
const BRANCHLESS = "v071-cc-900";
const REVOKED = "v071-cc-901";

let httpServer;
let baseUrl;
let locationId;
let positionId;
let defaultCostCenterId;

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnNames(table) {
  if (!tableExists(table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      role_locked = 0,
      active = 1,
      must_change_password = 0,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function request(route, { method = "GET", auth = null, body, contentType = "application/json", fileName = "" } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = contentType;
  if (fileName) headers["X-Import-Filename"] = encodeURIComponent(fileName);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

async function personnelImportPreview(auth, csv, mapping, defaults = {}, duplicateStrategy = "update") {
  const inspected = await request("/api/integrations/personnel-import/inspect", {
    method: "POST",
    auth,
    body: Buffer.from(csv, "utf8"),
    contentType: "text/csv",
    fileName: "block6-security.csv",
  });
  assert.equal(inspected.response.status, 201, inspected.text);
  const preview = await request("/api/integrations/personnel-import/preview", {
    method: "POST",
    auth,
    body: {
      inspectionId: inspected.payload.inspectionId,
      sheetName: "CSV",
      headerRow: 1,
      mapping,
      defaults: {
        homeLocationId: locationId,
        positionId,
        contractedHours: 38.5,
        active: true,
        ...defaults,
      },
      duplicateStrategy,
    },
  });
  assert.equal(preview.response.status, 201, preview.text);
  return preview;
}

function payloadRows(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function costCenterKey(row) {
  return String(row?.id ?? row?.cost_center_id ?? row?.code ?? "");
}

function employeeInsert(personnelNumber, {
  homeLocationId = locationId,
  costCenterId = defaultCostCenterId,
  active = true,
} = {}) {
  const hasCostCenter = columnNames("employees").has("cost_center_id");
  if (hasCostCenter) {
    db.prepare(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
         position_id, home_location_id, cost_center_id, active)
      VALUES (?, ?, ?, '#2c7a68', 38.5, 5, ?, ?, ?, ?)
      ON CONFLICT(personnel_number) DO UPDATE SET
        home_location_id = excluded.home_location_id,
        cost_center_id = excluded.cost_center_id,
        active = excluded.active
    `).run(personnelNumber, `Testperson ${personnelNumber}`, `T${personnelNumber}`, positionId,
      homeLocationId || null, costCenterId || null, active ? 1 : 0);
    return;
  }
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       position_id, home_location_id, active)
    VALUES (?, ?, ?, '#2c7a68', 38.5, 5, ?, ?, ?)
    ON CONFLICT(personnel_number) DO UPDATE SET
      home_location_id = excluded.home_location_id,
      active = excluded.active
  `).run(personnelNumber, `Testperson ${personnelNumber}`, `T${personnelNumber}`, positionId,
    homeLocationId || null, active ? 1 : 0);
}

function employeePayload(personnelNumber, {
  homeLocationId = locationId,
  costCenterId = defaultCostCenterId,
  active = true,
  nickname = `T${personnelNumber}`,
} = {}) {
  return {
    personnelNumber,
    fullName: `Testperson ${personnelNumber}`,
    nickname,
    color: "#2c7a68",
    contractedHours: 38.5,
    targetWorkdaysPerWeek: 5,
    preferredDayOff: "",
    fixedWorkdays: [],
    positionId,
    timeConfirmationLevel: "C",
    homeLocationId: homeLocationId || "",
    preferredDepartmentId: "",
    costCenterId,
    active,
  };
}

async function createCostCenter(auth, suffix, extras = {}) {
  const code = `V071-${suffix}`.toUpperCase();
  const result = await request("/api/cost-centers", {
    method: "POST",
    auth,
    body: {
      code,
      name: `Kostenstelle ${suffix}`,
      type: "administration",
      active: true,
      ...extras,
    },
  });
  assert.equal(result.response.status, 201, result.text);
  const row = db.prepare("SELECT * FROM cost_centers WHERE code = ? COLLATE NOCASE").get(code);
  assert.ok(row, `Kostenstelle ${code} wurde nicht gespeichert`);
  return { ...result, row, key: costCenterKey(row) };
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations ORDER BY active DESC, id LIMIT 1").get()?.id || "01";
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get()?.id || "verkaufsmitarbeiter";
  if (tableExists("cost_centers")) {
    const first = db.prepare("SELECT * FROM cost_centers ORDER BY active DESC, code LIMIT 1").get();
    defaultCostCenterId = costCenterKey(first);
  }
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.71 Block 6: Schema, Migration und bestehende Zuordnungen sind vollstaendig", () => {
  assert.ok(tableExists("cost_centers"), "Tabelle cost_centers fehlt");
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.71-cost-centers-personnel'").get(),
    "Kostenstellenmigration fehlt");
  for (const column of ["id", "code", "name", "type", "active", "created_at", "updated_at"]) {
    assert.ok(columnNames("cost_centers").has(column), `cost_centers.${column} fehlt`);
  }
  assert.ok(columnNames("employees").has("cost_center_id"), "employees.cost_center_id fehlt");
  assert.ok(columnNames("locations").has("cost_center_id"), "locations.cost_center_id fehlt");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM employees e
    LEFT JOIN cost_centers c ON c.id = e.cost_center_id
    WHERE e.cost_center_id IS NULL OR TRIM(e.cost_center_id) = '' OR c.id IS NULL
  `).get().count, 0, "Mindestens ein bestehendes Teammitglied hat keine gueltige Kostenstelle");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM locations l
    LEFT JOIN cost_centers c ON c.id = l.cost_center_id
    WHERE l.cost_center_id IS NULL OR TRIM(l.cost_center_id) = '' OR c.id IS NULL
  `).get().count, 0, "Mindestens ein bestehender Standort hat keine gueltige Kostenstelle");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'v0.71-cost-centers-personnel'").get().count, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("v0.71 Block 6: Eine echte Alt-Datenbank wird deterministisch und ohne Waisen migriert", () => {
  const legacyRoot = fs.mkdtempSync(path.join(testRoot, "legacy-"));
  const legacyDb = path.join(legacyRoot, "legacy.db");
  const serverPath = path.join(__dirname, "..", "server.js");
  const legacySchema = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE locations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, min_staff INTEGER NOT NULL DEFAULT 0,
      day_settings_json TEXT NOT NULL DEFAULT '', time_tracking_enabled INTEGER NOT NULL DEFAULT 0,
      time_tracking_access_mode TEXT NOT NULL DEFAULT 'anywhere',
      time_tracking_allowed_networks TEXT NOT NULL DEFAULT '', time_tracking_variance_minutes INTEGER NOT NULL DEFAULT 15,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, location_id TEXT NOT NULL, name TEXT NOT NULL,
      min_staff INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location_id, name)
    );
    CREATE TABLE employees (
      personnel_number TEXT PRIMARY KEY, full_name TEXT NOT NULL, nickname TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#0b84c6', contracted_hours REAL NOT NULL DEFAULT 38.5,
      target_workdays_per_week INTEGER NOT NULL DEFAULT 5, preferred_day_off TEXT,
      fixed_workdays TEXT NOT NULL DEFAULT '', position_id TEXT NOT NULL DEFAULT 'verkaufsmitarbeiter',
      time_confirmation_level TEXT NOT NULL DEFAULT 'C', sickness_without_aum_enabled INTEGER NOT NULL DEFAULT 0,
      home_location_id TEXT, preferred_department_id INTEGER, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO locations (id, name, active) VALUES ('L1', 'Legacy Nord', 1), ('L2', 'Legacy Sued', 1);
    INSERT INTO employees (personnel_number, full_name, nickname, home_location_id)
      VALUES ('LEG-1', 'Legacy Eins', 'Eins', 'L1'), ('LEG-2', 'Legacy Zwei', 'Zwei', NULL);
  `;
  const employeeQuery = `
    SELECT e.personnel_number, e.home_location_id, e.cost_center_id, c.code
    FROM employees e LEFT JOIN cost_centers c ON c.id = e.cost_center_id
    WHERE e.personnel_number LIKE 'LEG-%' ORDER BY e.personnel_number
  `;
  const locationQuery = `
    SELECT l.id, l.cost_center_id, c.code FROM locations l
    LEFT JOIN cost_centers c ON c.id = l.cost_center_id ORDER BY l.id
  `;
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(process.env.DB_PATH);
    database.exec(${JSON.stringify(legacySchema)});
    database.close();
    const subject = require(${JSON.stringify(serverPath)});
    const rows = subject.db.prepare(${JSON.stringify(employeeQuery)}).all();
    const locations = subject.db.prepare(${JSON.stringify(locationQuery)}).all();
    const migrationCount = subject.db.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'v0.71-cost-centers-personnel'"
    ).get().count;
    process.stdout.write(JSON.stringify({ rows, locations, migrationCount,
      foreignKeys: subject.db.prepare('PRAGMA foreign_key_check').all() }));
    subject.db.close();
    subject.releaseInstanceLockForTests();
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      DB_PATH: legacyDb,
      BACKUP_DIR: path.join(legacyRoot, "backups"),
      GRABENPLANER_DATA_DIR: path.join(legacyRoot, "app-data"),
      GRABENPLANER_SEED_DEMO: "0",
      GRABENPLANER_FORCE_PORTAL: "0",
      GRABENPLANER_TEST_AMU_SCANNER: "clean",
      NODE_ENV: "test",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.migrationCount, 1);
  assert.equal(migrated.rows.length, 2);
  assert.ok(migrated.rows.every((row) => row.cost_center_id && row.code));
  assert.ok(migrated.locations.every((row) => row.cost_center_id && row.code));
  assert.deepEqual(migrated.foreignKeys, []);
});

test("v0.71 Block 6: Rollen erhalten nur die vorgesehenen globalen Personalrechte", () => {
  const roles = new Map(db.prepare("SELECT id, permissions FROM portal_roles").all()
    .map((row) => [row.id, new Set(JSON.parse(row.permissions || "[]"))]));
  const expected = ["personnel:central:read", "personnel:central:write", "cost_centers:read", "cost_centers:write"];
  for (const role of ["hr", "admin", "it_admin", "developer"]) {
    for (const permission of expected) assert.ok(roles.get(role)?.has(permission), `${role}: ${permission} fehlt`);
  }
  for (const role of ["employee", "department_manager", "manager"]) {
    for (const permission of expected) assert.equal(roles.get(role)?.has(permission), false, `${role}: ${permission} darf nicht Standard sein`);
  }
});

test("v0.71 Block 6: PL verwaltet Kostenstellen und Loeschen archiviert statt hart zu loeschen", async () => {
  const hr = session(HR, "hr");
  const listed = await request("/api/cost-centers", { auth: hr });
  assert.equal(listed.response.status, 200, listed.text);
  assert.ok(payloadRows(listed.payload, "costCenters", "cost_centers").length >= 1);

  const created = await createCostCenter(hr, "ARCHIV");
  const changed = await request(`/api/cost-centers/${encodeURIComponent(created.key)}`, {
    method: "PUT",
    auth: hr,
    body: { code: "V071-ARCHIV", name: "Verwaltung Archivtest", type: "administration", active: true },
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.equal(db.prepare("SELECT name FROM cost_centers WHERE id = ?").get(created.key).name, "Verwaltung Archivtest");

  const archived = await request(`/api/cost-centers/${encodeURIComponent(created.key)}`, { method: "DELETE", auth: hr });
  assert.ok([200, 204].includes(archived.response.status), archived.text);
  const stillStored = db.prepare("SELECT active FROM cost_centers WHERE id = ?").get(created.key);
  assert.ok(stillStored, "DELETE darf die Kostenstelle nicht physisch entfernen");
  assert.equal(Boolean(stillStored.active), false);
});

test("v0.71 Block 6: Filialleitung bleibt trotz employees:write von globalen Daten ausgeschlossen", async () => {
  const manager = session(MANAGER, "manager");
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by, updated_at)
    VALUES (?, 'employees:write', 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, permission) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run(MANAGER);
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by, updated_at)
    VALUES (?, 'locations:write', 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, permission) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run(MANAGER);
  const directory = await request("/api/personnel-directory", { auth: manager });
  assert.equal(directory.response.status, 403, directory.text);
  const centers = await request("/api/cost-centers", { auth: manager });
  assert.equal(centers.response.status, 403, centers.text);
  const create = await request("/api/cost-centers", {
    method: "POST",
    auth: manager,
    body: { code: "V071-DENIED", name: "Nicht erlaubt", type: "other", active: true },
  });
  assert.equal(create.response.status, 403, create.text);
  assert.equal(db.prepare("SELECT 1 FROM cost_centers WHERE code = 'V071-DENIED'").get(), undefined);

  const locationCreate = await request("/api/locations", {
    method: "POST",
    auth: manager,
    body: { id: "98", name: "Nicht erlaubte Filiale", minStaff: 1, active: true },
  });
  assert.equal(locationCreate.response.status, 403, locationCreate.text);
  assert.equal(db.prepare("SELECT 1 FROM locations WHERE id = '98'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM cost_centers WHERE code = 'FIL98'").get(), undefined);
});

test("v0.71 Block 6: Zentrale Liste ist global, additiv und enthaelt keine sensiblen Personalaktdaten", async () => {
  const hr = session(HR, "hr");
  const directory = await request("/api/personnel-directory?includeInactive=1", { auth: hr });
  assert.equal(directory.response.status, 200, directory.text);
  const employees = payloadRows(directory.payload, "employees", "personnel");
  assert.ok(employees.length >= 1);
  assert.ok(employees.some((employee) => employee.cost_center_id || employee.costCenterId));
  const serialized = JSON.stringify(directory.payload).toLowerCase();
  for (const forbidden of ["protected_payload", "social_security", "socialsecurity", "iban", "personnelrecord", "documents"]) {
    assert.equal(serialized.includes(forbidden), false, `Zentrale Liste enthaelt sensibles Feld ${forbidden}`);
  }

  const locations = await request("/api/locations", { auth: hr });
  assert.equal(locations.response.status, 200, locations.text);
  assert.ok(payloadRows(locations.payload, "locations").every((location) => (
    (location.cost_center_id || location.costCenterId)
    && (location.cost_center_code || location.costCenterCode)
    && (location.cost_center_name || location.costCenterName)
  )));

  const roster = await request("/api/employees", { auth: hr });
  assert.equal(roster.response.status, 200, roster.text);
  assert.ok(payloadRows(roster.payload, "employees").every((employee) => (
    (employee.cost_center_id || employee.costCenterId)
    && (employee.cost_center_code || employee.costCenterCode)
    && (employee.cost_center_name || employee.costCenterName)
  )));
});

test("v0.71 Block 6: PL kann filiallose Personen mit Verwaltungskostenstelle anlegen", async () => {
  const hr = session(HR, "hr");
  const administration = await createCostCenter(hr, "VERWALTUNG");
  const created = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload(BRANCHLESS, { homeLocationId: "", costCenterId: administration.key }),
  });
  assert.equal(created.response.status, 201, created.text);
  const stored = db.prepare("SELECT home_location_id, preferred_department_id, cost_center_id FROM employees WHERE personnel_number = ?")
    .get(BRANCHLESS);
  assert.equal(stored.home_location_id, null);
  assert.equal(stored.preferred_department_id, null);
  assert.equal(String(stored.cost_center_id), administration.key);
});

test("v0.71 Block 6: Kostenstellenwechsel veraendert den Standort nicht", async () => {
  const hr = session(HR, "hr");
  const first = await createCostCenter(hr, "WECHSEL-A");
  const second = await createCostCenter(hr, "WECHSEL-B");
  const personnelNumber = "v071-cc-902";
  const created = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload(personnelNumber, { homeLocationId: locationId, costCenterId: first.key }),
  });
  assert.equal(created.response.status, 201, created.text);
  const changed = await request(`/api/employees/${encodeURIComponent(personnelNumber)}`, {
    method: "PUT",
    auth: hr,
    body: employeePayload(personnelNumber, { homeLocationId: locationId, costCenterId: second.key, nickname: "Wechsel" }),
  });
  assert.equal(changed.response.status, 200, changed.text);
  const stored = db.prepare("SELECT home_location_id, cost_center_id FROM employees WHERE personnel_number = ?").get(personnelNumber);
  assert.equal(stored.home_location_id, locationId);
  assert.equal(String(stored.cost_center_id), second.key);
});

test("v0.71 Block 6: Belegte Kostenstellen koennen nicht archiviert werden", async () => {
  const hr = session(HR, "hr");
  const occupied = await createCostCenter(hr, "BELEGT");
  const employeeNumber = "v071-cc-903";
  const created = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload(employeeNumber, { homeLocationId: "", costCenterId: occupied.key }),
  });
  assert.equal(created.response.status, 201, created.text);
  const denied = await request(`/api/cost-centers/${encodeURIComponent(occupied.key)}`, { method: "DELETE", auth: hr });
  assert.equal(denied.response.status, 409, denied.text);
  assert.equal(Boolean(db.prepare("SELECT active FROM cost_centers WHERE id = ?").get(occupied.key).active), true);

  const migratedLocationCenter = db.prepare("SELECT cost_center_id FROM locations WHERE id = ?").get(locationId).cost_center_id;
  const locationDenied = await request(`/api/cost-centers/${encodeURIComponent(migratedLocationCenter)}`, { method: "DELETE", auth: hr });
  assert.equal(locationDenied.response.status, 409, locationDenied.text);
});

test("v0.71 Block 6: Filiallose Anlage bleibt PL+ vorbehalten", async () => {
  const manager = session(MANAGER, "manager");
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by, updated_at)
    VALUES (?, 'employees:write', 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, permission) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run(MANAGER);
  const result = await request("/api/employees", {
    method: "POST",
    auth: manager,
    body: employeePayload("v071-cc-manager-orphan", { homeLocationId: "", costCenterId: defaultCostCenterId }),
  });
  assert.equal(result.response.status, 403, result.text);
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = 'v071-cc-manager-orphan'").get(), undefined);
});

test("v0.71 Block 6: Mitarbeiterdeaktivierung widerruft Web- und App-Zugang sofort", async () => {
  const hr = session(HR, "hr");
  const center = await createCostCenter(hr, "REVOKE");
  const created = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload(REVOKED, { homeLocationId: "", costCenterId: center.key }),
  });
  assert.equal(created.response.status, 201, created.text);
  const employeeSession = session(REVOKED, "employee");
  const before = await request("/api/portal/v1/session", { auth: employeeSession });
  assert.equal(before.response.status, 200, before.text);

  const deactivated = await request(`/api/employees/${encodeURIComponent(REVOKED)}`, {
    method: "PUT",
    auth: hr,
    body: employeePayload(REVOKED, { homeLocationId: "", costCenterId: center.key, active: false }),
  });
  assert.equal(deactivated.response.status, 200, deactivated.text);
  const portalUser = db.prepare("SELECT active FROM portal_users WHERE employee_number = ?").get(REVOKED);
  assert.equal(Boolean(portalUser.active), false);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_sessions WHERE employee_number = ? AND revoked_at IS NULL
  `).get(REVOKED).count, 0);
  if (tableExists("mobile_sessions")) {
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM mobile_sessions WHERE employee_number = ? AND revoked_at IS NULL
    `).get(REVOKED).count, 0);
  }
  const after = await request("/api/portal/v1/session", { auth: employeeSession });
  assert.equal(after.response.status, 200, after.text);
  assert.equal(after.payload?.authenticated, false);
  assert.equal(after.payload?.user, null);
});

test("v0.71 Block 6: PL darf geschützte oder höherrangige Zugänge weder deaktivieren noch löschen", async () => {
  const hr = session(HR, "hr");
  const targets = [
    { number: "v071-cc-protected-dev", role: "developer", roleLocked: 1, code: "PORTAL_DEVELOPER_PROTECTED" },
    { number: "v071-cc-protected-it", role: "it_admin", roleLocked: 0, code: "PORTAL_ROLE_HIERARCHY_DENIED" },
    { number: "v071-cc-protected-admin", role: "admin", roleLocked: 0, code: "PORTAL_ROLE_HIERARCHY_DENIED" },
    { number: "v071-cc-protected-locked", role: "employee", roleLocked: 1, code: "PORTAL_ROLE_LOCKED" },
  ];
  for (const target of targets) {
    employeeInsert(target.number);
    db.prepare(`
      INSERT INTO portal_users
        (employee_number, password_hash, role, role_locked, active, must_change_password, updated_at)
      VALUES (?, 'test-only', ?, ?, 1, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(employee_number) DO UPDATE SET
        role = excluded.role, role_locked = excluded.role_locked, active = 1, updated_at = CURRENT_TIMESTAMP
    `).run(target.number, target.role, target.roleLocked);

    const disabled = await request(`/api/employees/${encodeURIComponent(target.number)}`, {
      method: "PUT",
      auth: hr,
      body: employeePayload(target.number, { active: false }),
    });
    assert.equal(disabled.response.status, 403, `${target.role}: ${disabled.text}`);
    assert.equal(disabled.payload?.code, target.code);

    const deleted = await request(`/api/employees/${encodeURIComponent(target.number)}`, { method: "DELETE", auth: hr });
    assert.equal(deleted.response.status, 403, `${target.role}: ${deleted.text}`);
    assert.equal(deleted.payload?.code, target.code);
    assert.equal(Boolean(db.prepare("SELECT active FROM employees WHERE personnel_number = ?").get(target.number)?.active), true);
    assert.equal(Boolean(db.prepare("SELECT active FROM portal_users WHERE employee_number = ?").get(target.number)?.active), true);
  }
});

test("v0.71 Block 6: Importdeaktivierung widerruft alle Zugänge und Reaktivierung schaltet sie nicht frei", async () => {
  const hr = session(HR, "hr");
  const employeeNumber = "v071-cc-import-access";
  employeeInsert(employeeNumber);
  session(employeeNumber, "employee");
  db.prepare(`
    INSERT INTO mobile_sessions
      (id, employee_number, access_token_hash, access_expires_at, refresh_token_hash,
       refresh_expires_at, installation_id_hash, platform, device_label, app_version)
    VALUES (?, ?, 'access-hash', '2099-12-31T23:59:59.000Z', 'refresh-hash',
      '2099-12-31T23:59:59.000Z', 'installation-hash', 'android', 'Testgerät', 'test')
  `).run(crypto.randomUUID(), employeeNumber);

  const deactivatePreview = await personnelImportPreview(hr,
    `Personalnummer;Name;Aktiv\r\n${employeeNumber};Import Zugang;nein\r\n`,
    { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, active: { columnIndex: 2 } });
  assert.equal(deactivatePreview.payload.summary.errors, 0, deactivatePreview.text);
  const deactivated = await request("/api/integrations/personnel-import/apply", {
    method: "POST", auth: hr, body: { previewId: deactivatePreview.payload.previewId },
  });
  assert.equal(deactivated.response.status, 201, deactivated.text);
  assert.equal(Boolean(db.prepare("SELECT active FROM employees WHERE personnel_number = ?").get(employeeNumber).active), false);
  assert.equal(Boolean(db.prepare("SELECT active FROM portal_users WHERE employee_number = ?").get(employeeNumber).active), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_sessions WHERE employee_number = ? AND revoked_at IS NULL").get(employeeNumber).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mobile_sessions WHERE employee_number = ? AND revoked_at IS NULL").get(employeeNumber).count, 0);

  const reactivatePreview = await personnelImportPreview(hr,
    `Personalnummer;Name;Aktiv\r\n${employeeNumber};Import Zugang;ja\r\n`,
    { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, active: { columnIndex: 2 } });
  const reactivated = await request("/api/integrations/personnel-import/apply", {
    method: "POST", auth: hr, body: { previewId: reactivatePreview.payload.previewId },
  });
  assert.equal(reactivated.response.status, 201, reactivated.text);
  assert.equal(Boolean(db.prepare("SELECT active FROM employees WHERE personnel_number = ?").get(employeeNumber).active), true);
  assert.equal(Boolean(db.prepare("SELECT active FROM portal_users WHERE employee_number = ?").get(employeeNumber).active), false,
    "Der Import darf einen deaktivierten Portalzugang nicht automatisch reaktivieren");
});

test("v0.71 Block 6: Zentraler Import unterstützt filiallose Beschäftigte und Kostenstellen-ID", async () => {
  const hr = session(HR, "hr");
  const center = await createCostCenter(hr, "IMPORT-ZENTRAL");
  const employeeNumber = "v071-cc-import-central";
  const preview = await personnelImportPreview(hr,
    `Personalnummer;Name;Kostenstellen-ID\r\n${employeeNumber};Zentrale Person;${center.key}\r\n`,
    { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, costCenterId: { columnIndex: 2 } },
    { homeLocationId: "" }, "skip");
  assert.deepEqual(preview.payload.summary, { total: 1, create: 1, update: 0, skip: 0, errors: 0, warnings: 1 });
  const applied = await request("/api/integrations/personnel-import/apply", {
    method: "POST", auth: hr, body: { previewId: preview.payload.previewId },
  });
  assert.equal(applied.response.status, 201, applied.text);
  const stored = db.prepare("SELECT home_location_id, preferred_department_id, cost_center_id FROM employees WHERE personnel_number = ?")
    .get(employeeNumber);
  assert.equal(stored.home_location_id, null);
  assert.equal(stored.preferred_department_id, null);
  assert.equal(String(stored.cost_center_id), center.key);
});

test("v0.71 Block 6: Import darf höherrangige Zugänge nicht über den Aktivstatus deaktivieren", async () => {
  const hr = session(HR, "hr");
  const employeeNumber = "v071-cc-import-admin";
  employeeInsert(employeeNumber);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password, updated_at)
    VALUES (?, 'test-only', 'admin', 0, 1, 0, CURRENT_TIMESTAMP)
  `).run(employeeNumber);
  const preview = await personnelImportPreview(hr,
    `Personalnummer;Name;Aktiv\r\n${employeeNumber};Import Admin;nein\r\n`,
    { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, active: { columnIndex: 2 } });
  assert.equal(preview.payload.summary.errors, 1, preview.text);
  assert.equal(preview.payload.rows[0].errors[0].code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.equal(Boolean(db.prepare("SELECT active FROM employees WHERE personnel_number = ?").get(employeeNumber).active), true);
  assert.equal(Boolean(db.prepare("SELECT active FROM portal_users WHERE employee_number = ?").get(employeeNumber).active), true);
});
