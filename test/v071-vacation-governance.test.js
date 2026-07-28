"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-vacation-governance-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, releaseInstanceLockForTests } = subject;

const DATE = "2032-08-16";
const LOCATION = "71";
const OTHER_LOCATION = "72";
const PREFIX = "v071-vac-";
let httpServer;
let baseUrl;
let departmentId;
let otherDepartmentId;
let positionId;

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function createSession(employeeNumber, role) {
  const token = `${PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, active = 1,
      must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')`)
    .run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function request(route, { method = "GET", auth = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

function addEmployee(suffix, { locationId = LOCATION, department = departmentId, costCenterId = "cc-v071-vac-71" } = {}) {
  const employeeNumber = `${PREFIX}${suffix}`;
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       fixed_workdays, position_id, home_location_id, preferred_department_id, cost_center_id, active)
    VALUES (?, ?, ?, '#25745f', 38.5, 5, '', ?, ?, ?, ?, 1)
  `).run(employeeNumber, `Testperson ${suffix}`, suffix, positionId, locationId || null, department || null, costCenterId);
  return employeeNumber;
}

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`DELETE FROM request_decisions WHERE actor_employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM portal_notifications WHERE recipient_employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM portal_sessions WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM portal_access_scopes WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM portal_permission_grants WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM portal_users WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM vacation_change_requests WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM vacation_requests WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM vacation_entitlements WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM request_blackouts WHERE location_id IN (?, ?)`).run(LOCATION, OTHER_LOCATION);
    db.prepare(`DELETE FROM week_options WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM shifts WHERE employee_number LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM employees WHERE personnel_number LIKE '${PREFIX}%'`).run();
    db.prepare("DELETE FROM departments WHERE location_id IN (?, ?)").run(LOCATION, OTHER_LOCATION);
    db.prepare("DELETE FROM locations WHERE id IN (?, ?)").run(LOCATION, OTHER_LOCATION);
    db.prepare("DELETE FROM cost_centers WHERE id IN ('cc-v071-vac-71','cc-v071-vac-72','cc-v071-vac-admin')").run();
    db.prepare(`INSERT INTO cost_centers (id, code, name, type, cost_center_type_id, active)
      VALUES ('cc-v071-vac-71','V071-71','Filiale 71','branch','branch',1),
             ('cc-v071-vac-72','V071-72','Filiale 72','branch','branch',1),
             ('cc-v071-vac-admin','V071-ADM','Verwaltung','administration','administration',1)`).run();
    db.prepare(`INSERT INTO locations (id, name, cost_center_id, min_staff, active)
      VALUES (?, 'Governance Nord', 'cc-v071-vac-71', 2, 1),
             (?, 'Governance Süd', 'cc-v071-vac-72', 1, 1)`).run(LOCATION, OTHER_LOCATION);
    departmentId = Number(db.prepare(`INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Verkauf', 1, 1, 1)`).run(LOCATION).lastInsertRowid);
    otherDepartmentId = Number(db.prepare(`INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Verkauf Süd', 1, 1, 1)`).run(OTHER_LOCATION).lastInsertRowid);
    addEmployee("target");
    addEmployee("support");
    addEmployee("hr", { locationId: null, department: null, costCenterId: "cc-v071-vac-admin" });
    addEmployee("manager", { locationId: null, department: null, costCenterId: "cc-v071-vac-admin" });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

test.before(async () => {
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get()?.id || "verkaufsmitarbeiter";
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(resetFixture);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.71 Block 7: zentrale Urlaubsübersicht ist global, kostenstellenbezogen und datensparsam", async () => {
  db.prepare(`INSERT INTO week_options
    (employee_number, group_id, week_start, date_from, date_to, option_type, note, all_day)
    VALUES (?, 'vac-governance-overview', '2032-08-16', ?, ?, 'vacation', 'Privater Urlaubsgrund', 1)`)
    .run(`${PREFIX}target`, DATE, DATE);
  db.prepare("INSERT INTO vacation_entitlements (employee_number, year, days) VALUES (?, 2032, 25)")
    .run(`${PREFIX}target`);
  db.prepare(`INSERT INTO vacation_requests
    (employee_number, location_id, date_from, date_to, note, status, approval_stage, vacation_group_id)
    VALUES (?, ?, ?, ?, '', 'approved', 'complete', 'vac-governance-overview')`)
    .run(`${PREFIX}target`, LOCATION, DATE, DATE);
  db.prepare("UPDATE employees SET active = 0 WHERE personnel_number = ?").run(`${PREFIX}target`);
  const hr = createSession(`${PREFIX}hr`, "hr");
  const manager = createSession(`${PREFIX}manager`, "manager");
  const overview = await request("/api/personnel-vacations?year=2032", { auth: hr });
  assert.equal(overview.response.status, 200, overview.text);
  assert.equal(overview.payload.scope, "global");
  assert.ok(overview.payload.employees.some((employee) => employee.personnel_number === `${PREFIX}hr`
    && employee.cost_center_code === "V071-ADM"));
  const vacation = overview.payload.vacations.find((entry) => entry.group_id === "vac-governance-overview");
  assert.equal(vacation.cost_center_code, "V071-71");
  assert.equal(vacation.has_note, true);
  assert.equal(Object.hasOwn(vacation, "note"), false);
  assert.equal(vacation.source, "approved_request");
  assert.equal(overview.payload.totals[`${PREFIX}target`].remaining, 24);
  const activeOnly = await request("/api/personnel-vacations?year=2032&includeInactive=0", { auth: hr });
  assert.ok(!activeOnly.payload.vacations.some((entry) => entry.group_id === "vac-governance-overview"));
  const forbidden = await request("/api/personnel-vacations?year=2032", { auth: manager });
  assert.equal(forbidden.response.status, 403, forbidden.text);
});

test("v0.71 Block 7: direkte Urlaubsanlage kann Mindestbesetzung nicht umgehen und kennzeichnet unvollständige Planung gelb", async () => {
  const hr = createSession(`${PREFIX}hr`, "hr");
  const blocked = await request("/api/vacations", {
    method: "POST", auth: hr,
    body: { employeeNumber: `${PREFIX}target`, dateFrom: DATE, dateTo: DATE, locationId: LOCATION },
  });
  assert.equal(blocked.response.status, 409, blocked.text);
  assert.equal(blocked.payload.code, "VACATION_STAFFING_INSUFFICIENT");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM week_options WHERE employee_number = ? AND option_type = 'vacation'")
    .get(`${PREFIX}target`).count, 0);

  addEmployee("second-support");
  const allowed = await request("/api/vacations", {
    method: "POST", auth: hr,
    body: { employeeNumber: `${PREFIX}target`, dateFrom: DATE, dateTo: DATE, locationId: LOCATION },
  });
  assert.equal(allowed.response.status, 201, allowed.text);
  assert.equal(allowed.payload.assessment.trafficLight, "yellow");
  assert.equal(allowed.payload.assessment.manualReview, true);
  const history = db.prepare(`
    SELECT snapshot_json FROM vacation_history_events
    WHERE group_id = ? AND action = 'created'
  `).get(allowed.payload.groupId);
  assert.match(history.snapshot_json, /^enc:v2:/);
});

test("v0.71 Block 7: Antragssperre gilt auch für Direktanlage und fehlgeschlagene Freigabe rollt zurück", async () => {
  const admin = createSession(`${PREFIX}hr`, "admin");
  db.prepare(`INSERT INTO request_blackouts
    (location_id, date_from, date_to, block_vacation, block_time_off, reason, active, created_by)
    VALUES (?, ?, ?, 1, 0, 'Inventur', 1, ?)`)
    .run(LOCATION, DATE, DATE, `${PREFIX}hr`);
  const blackout = await request("/api/vacations", {
    method: "POST", auth: admin,
    body: { employeeNumber: `${PREFIX}target`, dateFrom: DATE, dateTo: DATE, locationId: LOCATION },
  });
  assert.equal(blackout.response.status, 409, blackout.text);
  assert.equal(blackout.payload.code, "REQUEST_BLACKOUT");
  db.prepare("DELETE FROM request_blackouts WHERE location_id = ?").run(LOCATION);

  const requestId = Number(db.prepare(`INSERT INTO vacation_requests
    (employee_number, location_id, date_from, date_to, note, status, approval_stage)
    VALUES (?, ?, ?, ?, '', 'pending_local', 'local')`).run(`${PREFIX}target`, LOCATION, DATE, DATE).lastInsertRowid);
  const decision = await request(`/api/portal/v1/absence-requests/vacation/${requestId}/action`, {
    method: "PUT", auth: admin, body: { action: "approve", note: "Prüfung" },
  });
  assert.equal(decision.response.status, 409, decision.text);
  assert.equal(decision.payload.code, "VACATION_STAFFING_INSUFFICIENT");
  const stored = db.prepare("SELECT status, vacation_group_id FROM vacation_requests WHERE id = ?").get(requestId);
  assert.equal(stored.status, "pending_local");
  assert.equal(stored.vacation_group_id, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM week_options WHERE employee_number = ? AND option_type = 'vacation'")
    .get(`${PREFIX}target`).count, 0);
});

test("v0.71 Block 7: Abteilungsminimum und bestätigte filialfremde Ersatzschicht werden berücksichtigt", async () => {
  assert.equal(hasColumn("shifts", "location_id"), true, "Block 7 benötigt shifts.location_id für belastbare Ersatzkräfte");
  const hr = createSession(`${PREFIX}hr`, "hr");
  db.prepare("UPDATE departments SET min_staff = 2 WHERE id = ?").run(departmentId);
  addEmployee("other-department", { department: null });
  const departmentBlocked = await request("/api/vacations", {
    method: "POST", auth: hr,
    body: { employeeNumber: `${PREFIX}target`, dateFrom: DATE, dateTo: DATE, locationId: LOCATION },
  });
  assert.equal(departmentBlocked.response.status, 409, departmentBlocked.text);
  assert.equal(departmentBlocked.payload.code, "VACATION_STAFFING_INSUFFICIENT");

  db.prepare("UPDATE departments SET min_staff = 1 WHERE id = ?").run(departmentId);
  const foreign = addEmployee("foreign", {
    locationId: OTHER_LOCATION, department: otherDepartmentId, costCenterId: "cc-v071-vac-72",
  });
  const insertShift = db.prepare(`INSERT INTO shifts
    (employee_number, location_id, department_id, shift_date, start_time, end_time)
    VALUES (?, ?, ?, ?, '09:00', '18:00')`);
  insertShift.run(`${PREFIX}support`, LOCATION, departmentId, DATE);
  insertShift.run(foreign, LOCATION, departmentId, DATE);
  const replacementAllowed = await request("/api/vacations", {
    method: "POST", auth: hr,
    body: { employeeNumber: `${PREFIX}target`, dateFrom: DATE, dateTo: DATE, locationId: LOCATION },
  });
  assert.equal(replacementAllowed.response.status, 201, replacementAllowed.text);
  assert.equal(replacementAllowed.payload.assessment.trafficLight, "green");
});
