"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-shift-locations-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db, releaseInstanceLockForTests } = require("../server");

const TARGET_LOCATION = "91";
const EMPTY_LOCATION = "92";
const FOREIGN_EMPLOYEE = "v071-shift-701";
const TARGET_EMPLOYEE = "v071-shift-702";
const HOMELESS_EMPLOYEE = "v071-shift-703";
const ADMIN_EMPLOYEE = "v071-shift-704";
const MANAGER_EMPLOYEE = "v071-shift-705";

let httpServer;
let baseUrl;
let homeLocation;
let targetDepartment;
let secondaryTargetDepartment;
let positionId;
let adminAuth;
let managerAuth;
let foreignAuth;

function planningDays(minStaff = 1) {
  return Object.fromEntries([
    ["monday", "09:00", "18:00"],
    ["tuesday", "09:00", "18:00"],
    ["wednesday", "09:00", "18:00"],
    ["thursday", "09:00", "18:00"],
    ["friday", "09:00", "18:00"],
    ["saturday", "10:00", "17:00"],
  ].map(([day, start, end]) => [day, {
    open: true,
    start,
    end,
    lunchEnabled: false,
    lunchStart: "13:00",
    lunchEnd: "14:00",
    minStaff,
    minFrom: start,
    minTo: end,
  }]));
}

function insertEmployee(personnelNumber, homeLocationId, preferredDepartmentId = null, contractedHours = 8) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       fixed_workdays, position_id, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#247a68', ?, 5, '', ?, ?, ?, 1)
  `).run(
    personnelNumber,
    `Testperson ${personnelNumber}`,
    personnelNumber.slice(-3),
    contractedHours,
    positionId,
    homeLocationId,
    preferredDepartmentId,
  );
}

function insertStaffAssignment({
  id,
  dateFrom,
  dateTo = dateFrom,
  startTime = null,
  endTime = null,
  departmentId = targetDepartment,
}) {
  const allDay = startTime === null && endTime === null;
  db.prepare(`
    INSERT INTO employee_location_lendings (
      id, employee_number, home_location_id, destination_location_id,
      destination_department_id, date_from, date_to, all_day, start_time, end_time,
      note, status, revision, created_by, created_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'active', 1,
      'v071-test', CURRENT_TIMESTAMP, 'v071-test', CURRENT_TIMESTAMP)
  `).run(
    id,
    FOREIGN_EMPLOYEE,
    homeLocation,
    TARGET_LOCATION,
    departmentId,
    dateFrom,
    dateTo,
    allDay ? 1 : 0,
    startTime,
    endTime,
  );
}

function createSession(employeeNumber, role, locationId = null) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, active = 1,
      must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  if (locationId) {
    db.prepare(`
      INSERT OR REPLACE INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, ?)
    `).run(employeeNumber, locationId, ADMIN_EMPLOYEE);
  }
  db.prepare(`INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')`)
    .run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function request(route, { method = "GET", body, auth = adminAuth } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

function shiftBody(overrides = {}) {
  return {
    employeeNumber: FOREIGN_EMPLOYEE,
    date: "2031-03-03",
    startTime: "09:00",
    endTime: "17:00",
    area: "Test",
    note: "",
    ...overrides,
  };
}

test.before(async () => {
  homeLocation = db.prepare("SELECT id FROM locations ORDER BY active DESC, id LIMIT 1").get()?.id;
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get()?.id;
  assert.ok(homeLocation);
  assert.ok(positionId);

  const days = JSON.stringify(planningDays(1));
  db.prepare("INSERT INTO locations (id, name, min_staff, day_settings_json, active) VALUES (?, ?, 1, ?, 1)")
    .run(TARGET_LOCATION, "Ziel-Filiale", days);
  db.prepare("INSERT INTO locations (id, name, min_staff, day_settings_json, active) VALUES (?, ?, 0, ?, 1)")
    .run(EMPTY_LOCATION, "Leere Filiale", JSON.stringify(planningDays(0)));
  targetDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Ziel-Abteilung', 1, 1, 1)
  `).run(TARGET_LOCATION).lastInsertRowid);
  secondaryTargetDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Zweite Ziel-Abteilung', 0, 1, 2)
  `).run(TARGET_LOCATION).lastInsertRowid);

  insertEmployee(FOREIGN_EMPLOYEE, homeLocation, null, 8);
  insertEmployee(TARGET_EMPLOYEE, TARGET_LOCATION, targetDepartment, 8);
  insertEmployee(HOMELESS_EMPLOYEE, null, null, 8);
  insertEmployee(ADMIN_EMPLOYEE, homeLocation, null, 8);
  insertEmployee(MANAGER_EMPLOYEE, TARGET_LOCATION, targetDepartment, 8);
  adminAuth = createSession(ADMIN_EMPLOYEE, "admin");
  managerAuth = createSession(MANAGER_EMPLOYEE, "manager", TARGET_LOCATION);
  foreignAuth = createSession(FOREIGN_EMPLOYEE, "employee");

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

test("Einsatzfiliale ist migriert, indiziert und serverseitig abgesichert", () => {
  const columns = db.prepare("PRAGMA table_info(shifts)").all();
  assert.ok(columns.some((column) => column.name === "location_id"));

  const foreignKeys = db.prepare("PRAGMA foreign_key_list(shifts)").all();
  assert.ok(foreignKeys.some((foreignKey) => foreignKey.from === "location_id"
    && foreignKey.table === "locations" && foreignKey.to === "id"));

  const indexes = db.prepare("PRAGMA index_list(shifts)").all();
  assert.ok(indexes.some((index) => index.name === "idx_shifts_location_date"));
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.71-shift-locations'").get());

  const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'shifts'")
    .all().map((row) => row.name));
  assert.ok(triggers.has("trg_shifts_location_default"));
  assert.ok(triggers.has("trg_shifts_location_update"));
  assert.ok(triggers.has("trg_shifts_department_location_insert"));
});

test("fehlende Einsatzfiliale wird aus Abteilung oder Stammfiliale abgeleitet", () => {
  db.prepare(`
    INSERT INTO employee_location_lendings (
      id, employee_number, home_location_id, destination_location_id,
      destination_department_id, date_from, date_to, all_day, note,
      status, revision, created_by, created_at, updated_by, updated_at
    ) VALUES ('v071-derived-assignment', ?, ?, ?, ?, '2031-02-03', '2031-02-03',
      1, '', 'active', 1, 'v071-test', CURRENT_TIMESTAMP, 'v071-test', CURRENT_TIMESTAMP)
  `).run(FOREIGN_EMPLOYEE, homeLocation, TARGET_LOCATION, targetDepartment);
  const departmentShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time)
    VALUES (?, ?, '2031-02-03', '09:00', '17:00')
  `).run(FOREIGN_EMPLOYEE, targetDepartment);
  assert.equal(db.prepare("SELECT location_id FROM shifts WHERE id = ?").get(departmentShift.lastInsertRowid).location_id,
    TARGET_LOCATION);

  const homeShift = db.prepare(`
    INSERT INTO shifts (employee_number, shift_date, start_time, end_time)
    VALUES (?, '2031-02-04', '09:00', '17:00')
  `).run(FOREIGN_EMPLOYEE);
  assert.equal(db.prepare("SELECT location_id FROM shifts WHERE id = ?").get(homeShift.lastInsertRowid).location_id,
    homeLocation);

  assert.throws(() => db.prepare(`
    INSERT INTO shifts (employee_number, location_id, shift_date, start_time, end_time)
    VALUES (?, 'NICHT-DA', '2031-02-05', '09:00', '17:00')
  `).run(FOREIGN_EMPLOYEE), /SHIFT_LOCATION_INVALID|FOREIGN KEY/);
  assert.throws(() => db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
    VALUES (?, ?, ?, '2031-02-05', '09:00', '17:00')
  `).run(FOREIGN_EMPLOYEE, homeLocation, targetDepartment), /SHIFT_DEPARTMENT_LOCATION_CONFLICT/);
  assert.throws(() => db.prepare(`
    INSERT INTO shifts (employee_number, shift_date, start_time, end_time)
    VALUES (?, '2031-02-05', '09:00', '17:00')
  `).run(HOMELESS_EMPLOYEE), /SHIFT_LOCATION_REQUIRED/);
});

test("eine bestehende Datenbank wird deterministisch auf Einsatzfilialen migriert", () => {
  const legacyDatabase = path.join(testRoot, "legacy-shifts.db");
  db.exec(`VACUUM INTO '${legacyDatabase.replaceAll("'", "''")}'`);

  const downgrade = spawnSync(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(process.env.LEGACY_DB);
    database.exec(\`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER IF EXISTS trg_shifts_location_supplied;
      DROP TRIGGER IF EXISTS trg_shifts_location_default;
      DROP TRIGGER IF EXISTS trg_shifts_location_update;
      DROP TRIGGER IF EXISTS trg_shifts_department_location_insert;
      DROP TRIGGER IF EXISTS trg_shifts_department_location_update;
      DROP TRIGGER IF EXISTS trg_staff_assignments_shift_coverage_insert;
      DROP TRIGGER IF EXISTS trg_staff_assignments_shift_coverage_update;
      CREATE TABLE shifts_v070 (
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
      INSERT INTO shifts_v070
        (id, employee_number, department_id, shift_date, start_time, end_time, area, note, created_at)
      SELECT id, employee_number, department_id, shift_date, start_time, end_time, area, note, created_at FROM shifts;
      DROP TABLE shifts;
      ALTER TABLE shifts_v070 RENAME TO shifts;
      DELETE FROM schema_migrations WHERE id = 'v0.71-shift-locations';
    \`);
    database.close();
  `], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, LEGACY_DB: legacyDatabase },
    encoding: "utf8",
  });
  assert.equal(downgrade.status, 0, downgrade.stderr || downgrade.stdout);

  const migrate = spawnSync(process.execPath, ["-e", `
    const subject = require("./server");
    const departmentShift = subject.db.prepare(
      "SELECT location_id FROM shifts WHERE employee_number = ? AND shift_date = '2031-02-03'"
    ).get(process.env.FOREIGN_EMPLOYEE);
    const homeShift = subject.db.prepare(
      "SELECT location_id FROM shifts WHERE employee_number = ? AND shift_date = '2031-02-04'"
    ).get(process.env.FOREIGN_EMPLOYEE);
    const foreignKey = subject.db.prepare("PRAGMA foreign_key_list(shifts)").all()
      .some((row) => row.from === "location_id" && row.table === "locations" && row.to === "id");
    if (departmentShift?.location_id !== process.env.TARGET_LOCATION) throw new Error("department migration failed");
    if (homeShift?.location_id !== process.env.HOME_LOCATION) throw new Error("home migration failed");
    if (!foreignKey) throw new Error("location foreign key missing");
    if (!subject.db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.71-shift-locations'").get()) {
      throw new Error("migration marker missing");
    }
    subject.db.close();
    subject.releaseInstanceLockForTests();
  `], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      DB_PATH: legacyDatabase,
      BACKUP_DIR: path.join(testRoot, "legacy-backups"),
      GRABENPLANER_DATA_DIR: path.join(testRoot, "legacy-data"),
      GRABENPLANER_SEED_DEMO: "0",
      FOREIGN_EMPLOYEE,
      TARGET_LOCATION,
      HOME_LOCATION: homeLocation,
    },
    encoding: "utf8",
  });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
});

test("Dienst-CRUD zeigt zugewiesene Mitarbeitende im Zielplan", async () => {
  const assignment = await request("/api/portal/v1/staff-assignments", {
    method: "POST",
    body: {
      employeeNumber: FOREIGN_EMPLOYEE,
      destinationLocationId: TARGET_LOCATION,
      destinationDepartmentId: targetDepartment,
      dateFrom: "2031-03-03",
      dateTo: "2031-03-03",
      allDay: true,
      note: "",
    },
  });
  assert.equal(assignment.response.status, 201, assignment.text);
  const created = await request("/api/shifts", {
    method: "POST",
    body: shiftBody({ departmentId: targetDepartment }),
  });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.payload.locationId, TARGET_LOCATION);

  const targetPlan = await request(`/api/schedule?week=2031-03-03&location=${TARGET_LOCATION}`);
  assert.equal(targetPlan.response.status, 200, targetPlan.text);
  assert.ok(targetPlan.payload.employees.some((employee) => employee.personnel_number === FOREIGN_EMPLOYEE));
  assert.ok(targetPlan.payload.shifts.some((shift) => shift.id === created.payload.id
    && shift.location_id === TARGET_LOCATION));

  const departmentPlan = await request(`/api/schedule?week=2031-03-03&location=${TARGET_LOCATION}&department=${targetDepartment}`);
  assert.equal(departmentPlan.response.status, 200, departmentPlan.text);
  assert.ok(departmentPlan.payload.employees.some((employee) => employee.personnel_number === FOREIGN_EMPLOYEE));

  const homePlan = await request(`/api/schedule?week=2031-03-03&location=${encodeURIComponent(homeLocation)}`);
  assert.equal(homePlan.response.status, 200, homePlan.text);
  assert.ok(!homePlan.payload.shifts.some((shift) => shift.id === created.payload.id));

  const moved = await request(`/api/shifts/${created.payload.id}`, {
    method: "PUT",
    body: shiftBody({ locationId: homeLocation, departmentId: null }),
  });
  assert.equal(moved.response.status, 409, moved.text);
  assert.equal(moved.payload.code, "STAFF_ASSIGNMENT_HOME_SHIFT_CONFLICT");
  assert.equal(db.prepare("SELECT location_id FROM shifts WHERE id = ?").get(created.payload.id).location_id, TARGET_LOCATION);

  const removed = await request(`/api/shifts/${created.payload.id}`, { method: "DELETE" });
  assert.equal(removed.response.status, 204, removed.text);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE id = ?").get(created.payload.id).count, 0);
});

test("Fremdeinsätze sind berechtigt, eindeutig und in der Ziel-Filialzeit sichtbar", async () => {
  const date = "2034-04-03";
  const ownEmployee = await request("/api/shifts", {
    method: "POST",
    auth: managerAuth,
    body: shiftBody({ employeeNumber: TARGET_EMPLOYEE, date, locationId: TARGET_LOCATION, departmentId: targetDepartment }),
  });
  assert.equal(ownEmployee.response.status, 201, ownEmployee.text);
  await request(`/api/shifts/${ownEmployee.payload.id}`, { method: "DELETE", auth: managerAuth });

  const forbidden = await request("/api/shifts", {
    method: "POST",
    auth: managerAuth,
    body: shiftBody({ date, locationId: TARGET_LOCATION, departmentId: null }),
  });
  assert.equal(forbidden.response.status, 403, forbidden.text);
  assert.equal(forbidden.payload.code, "SHIFT_FOREIGN_EMPLOYEE_SCOPE_DENIED");

  const assignment = await request("/api/portal/v1/staff-assignments", {
    method: "POST",
    body: {
      employeeNumber: FOREIGN_EMPLOYEE,
      destinationLocationId: TARGET_LOCATION,
      destinationDepartmentId: null,
      dateFrom: date,
      dateTo: date,
      allDay: false,
      startTime: "09:00",
      endTime: "17:30",
      note: "",
    },
  });
  assert.equal(assignment.response.status, 201, assignment.text);

  const created = await request("/api/shifts", {
    method: "POST",
    body: shiftBody({ date, locationId: TARGET_LOCATION, departmentId: null }),
  });
  assert.equal(created.response.status, 201, created.text);

  const maintained = await request(`/api/shifts/${created.payload.id}`, {
    method: "PUT",
    auth: managerAuth,
    body: shiftBody({ date, locationId: TARGET_LOCATION, departmentId: null, endTime: "17:30" }),
  });
  assert.equal(maintained.response.status, 200, maintained.text);

  const otherLocation = await request("/api/shifts", {
    method: "POST",
    body: shiftBody({ date, locationId: homeLocation, departmentId: null, startTime: "17:30", endTime: "18:00" }),
  });
  assert.equal(otherLocation.response.status, 201, otherLocation.text);

  const overlap = await request("/api/shifts", {
    method: "POST",
    body: shiftBody({ date, locationId: TARGET_LOCATION, departmentId: null, startTime: "10:00", endTime: "16:00" }),
  });
  assert.equal(overlap.response.status, 409, overlap.text);
  assert.equal(overlap.payload.code, "SHIFT_TIME_CONFLICT");

  const ownSchedule = await request(`/api/portal/v1/me/schedule?week=${date}`, { auth: foreignAuth });
  assert.equal(ownSchedule.response.status, 200, ownSchedule.text);
  const ownShift = ownSchedule.payload.shifts.find((shift) => Number(shift.id) === Number(created.payload.id));
  assert.equal(ownShift.location_id, TARGET_LOCATION);
  assert.equal(ownShift.location_name, "Ziel-Filiale");

  const summary = await request(`/api/portal/v1/time-summary?location=${TARGET_LOCATION}&from=${date}&to=${date}`);
  assert.equal(summary.response.status, 200, summary.text);
  const foreignSummary = summary.payload.summary.employees.find((employee) => employee.employeeNumber === FOREIGN_EMPLOYEE);
  assert.ok(foreignSummary);
  assert.ok(foreignSummary.plannedMinutes > 0);
});

test("Fremdeinsatz steuert mobile Freigabe, Zeitkorrektur und geteilten Tagesstatus", async () => {
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  db.prepare("UPDATE locations SET time_tracking_enabled = 0 WHERE id = ?").run(homeLocation);
  db.prepare("UPDATE locations SET time_tracking_enabled = 1, time_tracking_access_mode = 'anywhere' WHERE id = ?")
    .run(TARGET_LOCATION);
  insertStaffAssignment({ id: "v071-mobile-today", dateFrom: today });
  db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
    VALUES (?, ?, ?, ?, '09:00', '17:00')
  `).run(FOREIGN_EMPLOYEE, TARGET_LOCATION, targetDepartment, today);

  const home = await request("/api/portal/v1/me/home", { auth: foreignAuth });
  assert.equal(home.response.status, 200, home.text);
  assert.equal(home.payload.timeTracking.enabled, true, "Die Einsatzfiliale aktiviert die mobile Zeiterfassung");
  assert.equal(home.payload.timeTracking.accessAllowed, true);

  const correctionDate = "2026-07-17";
  insertStaffAssignment({ id: "v071-mobile-correction", dateFrom: correctionDate });
  db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
    VALUES (?, ?, ?, ?, '09:00', '17:00')
  `).run(FOREIGN_EMPLOYEE, TARGET_LOCATION, targetDepartment, correctionDate);
  const correction = await request("/api/portal/v1/me/time-corrections", {
    method: "POST",
    auth: foreignAuth,
    body: {
      correctionDate,
      requestedEntries: [
        { type: "clock_in", time: "09:00" },
        { type: "clock_out", time: "17:00" },
      ],
      reason: "Ziel-Filiale prüfen",
    },
  });
  assert.equal(correction.response.status, 201, correction.text);
  const correctionRow = db.prepare("SELECT location_id, department_id FROM time_corrections WHERE id = ?")
    .get(correction.payload.correction.id);
  assert.equal(correctionRow.location_id, TARGET_LOCATION);
  assert.equal(Number(correctionRow.department_id), targetDepartment);

  const splitDate = "2026-07-16";
  insertStaffAssignment({
    id: "v071-mobile-split-first",
    dateFrom: splitDate,
    startTime: "09:00",
    endTime: "12:00",
  });
  insertStaffAssignment({
    id: "v071-mobile-split-second",
    dateFrom: splitDate,
    startTime: "13:00",
    endTime: "17:00",
    departmentId: secondaryTargetDepartment,
  });
  db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
    VALUES (?, ?, ?, ?, '09:00', '12:00'), (?, ?, ?, ?, '13:00', '17:00')
  `).run(
    FOREIGN_EMPLOYEE, TARGET_LOCATION, targetDepartment, splitDate,
    FOREIGN_EMPLOYEE, TARGET_LOCATION, secondaryTargetDepartment, splitDate,
  );
  const insertEntry = db.prepare(`
    INSERT INTO time_entries
      (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'portal', ?)
  `);
  for (const [departmentId, type, timestamp] of [
    [targetDepartment, "clock_in", "2026-07-16T07:00:00.000Z"],
    [targetDepartment, "clock_out", "2026-07-16T10:00:00.000Z"],
    [secondaryTargetDepartment, "clock_in", "2026-07-16T11:00:00.000Z"],
    [secondaryTargetDepartment, "clock_out", "2026-07-16T15:00:00.000Z"],
  ]) {
    insertEntry.run(FOREIGN_EMPLOYEE, TARGET_LOCATION, departmentId, splitDate, type, timestamp, FOREIGN_EMPLOYEE);
  }
  const splitStatus = await request(`/api/portal/v1/me/time-entries?date=${splitDate}`, { auth: foreignAuth });
  assert.equal(splitStatus.response.status, 200, splitStatus.text);
  assert.equal(splitStatus.payload.status.entries.length, 4);
  assert.equal(splitStatus.payload.status.actualMinutes, 420);
});

test("Auto-Plan und Wochenreset werten ausschließlich die Ziel-Filiale", async () => {
  const week = "2032-03-01";
  insertStaffAssignment({ id: "v071-autoplan", dateFrom: week });
  const foreignTargetShift = db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time, area)
    VALUES (?, ?, ?, ?, '09:00', '18:00', 'Fremdeinsatz')
  `).run(FOREIGN_EMPLOYEE, TARGET_LOCATION, targetDepartment, week);
  const homeShift = db.prepare(`
    INSERT INTO shifts (employee_number, location_id, shift_date, start_time, end_time, area)
    VALUES (?, ?, date(?, '+1 day'), '09:00', '18:00', 'Heimdienst')
  `).run(FOREIGN_EMPLOYEE, homeLocation, week);

  const automatic = await request("/api/schedule/auto", {
    method: "POST",
    body: { weekStart: week, locationId: TARGET_LOCATION, replaceExisting: false },
  });
  assert.equal(automatic.response.status, 200, automatic.text);
  assert.ok(automatic.payload.created > 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM shifts
    WHERE location_id = ? AND shift_date = ?
  `).get(TARGET_LOCATION, week).count, 1, "Der Fremdeinsatz deckt die Mindestbesetzung am Montag bereits ab");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM shifts
    WHERE shift_date BETWEEN ? AND date(?, '+6 days') AND location_id <> ?
      AND area = 'Automatisch geplant'
  `).get(week, week, TARGET_LOCATION).count, 0);
  assert.equal(db.prepare("SELECT location_id FROM shifts WHERE id = ?").get(homeShift.lastInsertRowid).location_id,
    homeLocation);

  const reset = await request(`/api/schedule?week=${week}&location=${TARGET_LOCATION}`, { method: "DELETE" });
  assert.equal(reset.response.status, 200, reset.text);
  assert.ok(reset.payload.deleted >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE id = ?").get(foreignTargetShift.lastInsertRowid).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE id = ?").get(homeShift.lastInsertRowid).count, 1);
});

test("Abteilungen mit vorhandenen Diensten lassen sich nicht filialfremd verschieben", async () => {
  insertStaffAssignment({ id: "v071-department-move", dateFrom: "2033-03-07" });
  db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
    VALUES (?, ?, ?, '2033-03-07', '09:00', '17:00')
  `).run(FOREIGN_EMPLOYEE, TARGET_LOCATION, targetDepartment);

  const result = await request(`/api/departments/${targetDepartment}`, {
    method: "PUT",
    body: { locationId: EMPTY_LOCATION, name: "Ziel-Abteilung", minStaff: 1, active: true },
  });
  assert.equal(result.response.status, 409, result.text);
  assert.equal(result.payload.code, "SHIFT_DEPARTMENT_LOCATION_CONFLICT");
  assert.equal(db.prepare("SELECT location_id FROM departments WHERE id = ?").get(targetDepartment).location_id,
    TARGET_LOCATION);
});

test("Auto-Plan nutzt in der Stammfiliale nur das freie Stundenfenster", async () => {
  const week = "2035-03-05";
  db.prepare("UPDATE locations SET min_staff = 0, day_settings_json = ? WHERE id = ?")
    .run(JSON.stringify(planningDays(0)), homeLocation);
  db.prepare("UPDATE employees SET contracted_hours = 3, fixed_workdays = 'monday' WHERE personnel_number = ?")
    .run(FOREIGN_EMPLOYEE);
  insertStaffAssignment({
    id: "v071-autoplan-home-hourly",
    dateFrom: week,
    startTime: "12:00",
    endTime: "16:00",
  });

  const automatic = await request("/api/schedule/auto", {
    method: "POST",
    body: { weekStart: week, locationId: homeLocation, replaceExisting: false },
  });
  assert.equal(automatic.response.status, 200, automatic.text);
  const shift = db.prepare(`
    SELECT location_id, shift_date, start_time, end_time
    FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND location_id = ?
  `).get(FOREIGN_EMPLOYEE, week, homeLocation);
  assert.ok(shift, "Die freie Zeit in der Stammfiliale muss automatisch planbar bleiben");
  assert.ok(
    shift.end_time <= "12:00" || shift.start_time >= "16:00",
    `Der automatisch erstellte Dienst ${shift.start_time}-${shift.end_time} überlappt den Filialeinsatz`,
  );
});

test("Auto-Plan plant zugewiesene Mitarbeitende nur innerhalb des Zielfensters", async () => {
  const week = "2035-04-02";
  db.prepare("UPDATE employees SET contracted_hours = 4, fixed_workdays = 'monday' WHERE personnel_number = ?")
    .run(FOREIGN_EMPLOYEE);
  insertStaffAssignment({
    id: "v071-autoplan-destination-hourly",
    dateFrom: week,
    startTime: "11:00",
    endTime: "15:00",
  });
  db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, date(?, '+1 day'), '09:00', '11:00', 'Stammdienst', '')
  `).run(FOREIGN_EMPLOYEE, homeLocation, week);

  const automatic = await request("/api/schedule/auto", {
    method: "POST",
    body: { weekStart: week, locationId: TARGET_LOCATION, replaceExisting: false },
  });
  assert.equal(automatic.response.status, 200, automatic.text);
  const shift = db.prepare(`
    SELECT location_id, department_id, shift_date, start_time, end_time
    FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND location_id = ?
  `).get(FOREIGN_EMPLOYEE, week, TARGET_LOCATION);
  assert.ok(shift, "Die zugewiesene Person muss in der Zielfiliale automatisch planbar sein");
  assert.ok(shift.start_time >= "11:00" && shift.end_time <= "15:00");
  assert.equal(
    (Number(shift.end_time.slice(0, 2)) * 60 + Number(shift.end_time.slice(3)))
      - (Number(shift.start_time.slice(0, 2)) * 60 + Number(shift.start_time.slice(3))),
    120,
    "Stunden aus der Stammfiliale zählen gegen die vertragliche Wochenzeit",
  );
  assert.equal(Number(shift.department_id), targetDepartment);
});

test("Ganztägiger Filialeinsatz sperrt die automatische Planung der Stammfiliale", async () => {
  const week = "2035-05-07";
  db.prepare("UPDATE employees SET contracted_hours = 4, fixed_workdays = 'monday' WHERE personnel_number = ?")
    .run(FOREIGN_EMPLOYEE);
  insertStaffAssignment({ id: "v071-autoplan-home-all-day", dateFrom: week });

  const automatic = await request("/api/schedule/auto", {
    method: "POST",
    body: { weekStart: week, locationId: homeLocation, replaceExisting: false },
  });
  assert.equal(automatic.response.status, 200, automatic.text);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM shifts
    WHERE employee_number = ? AND shift_date = ? AND location_id = ?
  `).get(FOREIGN_EMPLOYEE, week, homeLocation).count, 0);
});
