"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0921-staff-assignments-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_TODAY = "2031-04-01";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  app,
  db,
  releaseInstanceLockForTests,
  workRuleStoreRepository,
} = require("../server");

const HOME = "81";
const DESTINATION = "82";
const THIRD = "83";
const HOME_MANAGER = "v0921-manager-home";
const DESTINATION_MANAGER = "v0921-manager-destination";
const DEPARTMENT_MANAGER = "v0921-department-manager";
const FOREIGN_DEPARTMENT_MANAGER = "v0921-department-foreign";
const HR = "v0921-hr";
const IT_ADMIN = "v0921-it-admin";
const EMPLOYEE = "v0921-employee";
const SECOND_EMPLOYEE = "v0921-employee-second";

let homeDepartment;
let destinationDepartment;
let secondHomeDepartment;
let secondDestinationDepartment;
let httpServer;
let baseUrl;
let homeManager;
let destinationManager;
let departmentManager;
let hr;

function daySettings() {
  return JSON.stringify(Object.fromEntries([
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  ].map((day) => [day, {
    open: true,
    start: day === "saturday" ? "08:00" : "08:00",
    end: "20:00",
    lunchEnabled: false,
    lunchStart: "13:00",
    lunchEnd: "14:00",
    minStaff: 0,
    minFrom: "08:00",
    minTo: "20:00",
  }])));
}

function ensureLocation(id, name) {
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, ?, 0, ?, 1)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name,
      day_settings_json = excluded.day_settings_json, active = 1
  `).run(id, name, daySettings());
}

function ensureEmployee(employeeNumber, fullName, homeLocationId, departmentId, role) {
  const positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get()?.id;
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, position_id,
      home_location_id, preferred_department_id, active
    ) VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name, nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id, active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], positionId, homeLocationId, departmentId);
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, active = 1,
      must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(employeeNumber);
  if (["manager", "department_manager"].includes(role)) {
    db.prepare(`
      INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, ?, 'v0921-test')
    `).run(employeeNumber, homeLocationId, role === "department_manager" ? departmentId : 0);
  }
}

function createSession(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function requestJson(route, { method = "GET", session = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && session?.csrf) {
    headers["X-CSRF-Token"] = session.csrf;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

async function requestPdf(route, { session = null } = {}) {
  const headers = { Accept: "application/pdf" };
  if (session?.cookie) headers.Cookie = session.cookie;
  const response = await fetch(`${baseUrl}${route}`, { headers });
  return { response, payload: Buffer.from(await response.arrayBuffer()) };
}

async function pdfText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(buffer),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.filter((item) => typeof item.str === "string")
        .map((item) => item.str).join(" "));
      page.cleanup();
    }
    return pages.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}

function assignment(overrides = {}) {
  return {
    employeeNumber: EMPLOYEE,
    destinationLocationId: DESTINATION,
    destinationDepartmentId: destinationDepartment,
    dateFrom: "2031-04-10",
    dateTo: "2031-04-10",
    allDay: false,
    startTime: "12:00",
    endTime: "14:00",
    note: "Kassenunterstützung",
    ...overrides,
  };
}

function shift(overrides = {}) {
  return {
    employeeNumber: EMPLOYEE,
    locationId: DESTINATION,
    departmentId: destinationDepartment,
    date: "2031-04-10",
    startTime: "12:00",
    endTime: "14:00",
    area: "Verkauf",
    note: "",
    ...overrides,
  };
}

test.before(async () => {
  ensureLocation(HOME, "Stammfiliale");
  ensureLocation(DESTINATION, "Zielfiliale");
  ensureLocation(THIRD, "Dritte Filiale");
  homeDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Heimat-Abteilung', 0, 1, 1)
  `).run(HOME).lastInsertRowid);
  destinationDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Ziel-Abteilung', 0, 1, 1)
  `).run(DESTINATION).lastInsertRowid);
  secondHomeDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Zweite Heimat-Abteilung', 0, 1, 2)
  `).run(HOME).lastInsertRowid);
  secondDestinationDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Zweite Ziel-Abteilung', 0, 1, 2)
  `).run(DESTINATION).lastInsertRowid);

  ensureEmployee(HOME_MANAGER, "Hanna Filialleitung", HOME, homeDepartment, "manager");
  ensureEmployee(DESTINATION_MANAGER, "Dora Filialleitung", DESTINATION, destinationDepartment, "manager");
  ensureEmployee(DEPARTMENT_MANAGER, "Anton Abteilungsleitung", HOME, homeDepartment, "department_manager");
  ensureEmployee(FOREIGN_DEPARTMENT_MANAGER, "Franz Abteilungsleitung", DESTINATION, destinationDepartment, "department_manager");
  ensureEmployee(HR, "Paula Personalleitung", HOME, homeDepartment, "hr");
  ensureEmployee(IT_ADMIN, "Ines Technik", HOME, homeDepartment, "it_admin");
  ensureEmployee(EMPLOYEE, "Emilia Mitarbeiterin", HOME, homeDepartment, "employee");
  ensureEmployee(SECOND_EMPLOYEE, "Sophie Mitarbeiterin", HOME, secondHomeDepartment, "employee");

  homeManager = createSession(HOME_MANAGER);
  destinationManager = createSession(DESTINATION_MANAGER);
  departmentManager = createSession(DEPARTMENT_MANAGER);
  hr = createSession(HR);
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

test("temporäre Filialeinsätze sind eng berechtigt, konfliktgeprüft und revisionssicher", async (t) => {
  await t.test("Filialleitung und PL besitzen das Recht standardmäßig; Technik und MA nicht", async () => {
    const managerResult = await requestJson("/api/portal/v1/staff-assignments", { session: homeManager });
    assert.equal(managerResult.response.status, 200, managerResult.text);
    assert.ok(managerResult.payload.candidates.some((entry) => entry.employeeNumber === EMPLOYEE));

    const hrResult = await requestJson("/api/portal/v1/staff-assignments", { session: hr });
    assert.equal(hrResult.response.status, 200, hrResult.text);

    const itAdminResult = await requestJson("/api/portal/v1/staff-assignments", {
      session: createSession(IT_ADMIN),
    });
    assert.equal(itAdminResult.response.status, 403, itAdminResult.text);

    const employeeResult = await requestJson("/api/portal/v1/staff-assignments", {
      session: createSession(EMPLOYEE),
    });
    assert.equal(employeeResult.response.status, 403, employeeResult.text);
  });

  await t.test("Datenbank-Trigger schließen den Prüf-/Schreib-Zwischenraum", async () => {
    const triggerNames = new Set(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'shifts'
    `).all().map((row) => row.name));
    assert.ok(triggerNames.has("trg_shifts_staff_assignment_insert"));
    assert.ok(triggerNames.has("trg_shifts_staff_assignment_update"));
    const assignmentTriggerNames = new Set(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'employee_location_lendings'
    `).all().map((row) => row.name));
    assert.ok(assignmentTriggerNames.has("trg_staff_assignments_shift_coverage_insert"));
    assert.ok(assignmentTriggerNames.has("trg_staff_assignments_shift_coverage_update"));
    const weekOptionTriggerNames = new Set(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'week_options'
    `).all().map((row) => row.name));
    assert.ok(weekOptionTriggerNames.has("trg_week_options_staff_assignment_insert"));
    assert.ok(weekOptionTriggerNames.has("trg_week_options_staff_assignment_update"));

    db.prepare(`
      INSERT INTO employee_location_lendings (
        id, employee_number, home_location_id, destination_location_id,
        destination_department_id, date_from, date_to, all_day, start_time,
        end_time, note, status, revision, created_by, created_at, updated_by, updated_at
      ) VALUES ('v0921-trigger-assignment', ?, ?, ?, ?, '2031-04-06', '2031-04-06',
        0, '12:00', '14:00', '', 'active', 1, 'v0921-test', CURRENT_TIMESTAMP,
        'v0921-test', CURRENT_TIMESTAMP)
    `).run(EMPLOYEE, HOME, DESTINATION, destinationDepartment);

    assert.throws(() => db.prepare(`
      INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
      VALUES (?, ?, ?, '2031-04-06', '13:00', '13:30')
    `).run(EMPLOYEE, HOME, homeDepartment), /STAFF_ASSIGNMENT_HOME_SHIFT_CONFLICT/);
    assert.throws(() => db.prepare(`
      INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
      VALUES (?, ?, ?, '2031-04-06', '11:45', '12:15')
    `).run(EMPLOYEE, DESTINATION, destinationDepartment), /STAFF_ASSIGNMENT_COVERAGE_REQUIRED/);
    assert.throws(() => db.prepare(`
      INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
      VALUES (?, ?, NULL, '2031-04-06', '12:00', '14:00')
    `).run(EMPLOYEE, DESTINATION), /STAFF_ASSIGNMENT_COVERAGE_REQUIRED/);
    assert.throws(() => db.prepare(`
      INSERT INTO week_options (
        employee_number, week_start, date_from, date_to, option_type, note, all_day
      ) VALUES (?, '2031-03-31', '2031-04-06', '2031-04-06', 'vacation', '', 1)
    `).run(EMPLOYEE), /STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT/);
    assert.throws(() => db.prepare(`
      INSERT INTO week_options (
        employee_number, week_start, date_from, date_to, option_type, note,
        all_day, start_time, end_time
      ) VALUES (?, '2031-03-31', '2031-04-06', '2031-04-06', 'time_off', '',
        0, '12:15', '12:45')
    `).run(EMPLOYEE), /STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT/);

    const linkedRequest = db.prepare(`
      INSERT INTO time_off_requests (
        employee_number, location_id, origin_location_id, review_department_id, lending_id,
        request_date, date_from, date_to, all_day, start_time, end_time, note, status
      ) VALUES (?, ?, ?, ?, 'v0921-trigger-assignment', '2031-04-06', '2031-04-06',
        '2031-04-06', 0, '12:15', '12:45', '', ?)
    `);
    const linkedOption = db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to, option_type, note,
        all_day, start_time, end_time
      ) VALUES (?, ?, '2031-03-31', '2031-04-06', '2031-04-06', 'time_off', '',
        0, '12:15', '12:45')
    `);
    for (const status of ["pending_local", "rejected", "cancelled"]) {
      const request = linkedRequest.run(
        EMPLOYEE,
        DESTINATION,
        HOME,
        destinationDepartment,
        status,
      );
      assert.throws(
        () => linkedOption.run(EMPLOYEE, `za-request-${request.lastInsertRowid}`),
        /STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT/,
      );
      db.prepare("DELETE FROM time_off_requests WHERE id = ?").run(request.lastInsertRowid);
    }
    const approvedRequest = linkedRequest.run(
      EMPLOYEE,
      DESTINATION,
      HOME,
      destinationDepartment,
      "approved",
    );
    const approvedOption = linkedOption.run(EMPLOYEE, `za-request-${approvedRequest.lastInsertRowid}`);
    assert.ok(Number(approvedOption.lastInsertRowid) > 0);
    db.prepare("DELETE FROM week_options WHERE id = ?").run(approvedOption.lastInsertRowid);
    db.prepare("DELETE FROM time_off_requests WHERE id = ?").run(approvedRequest.lastInsertRowid);

    await assert.rejects(
      workRuleStoreRepository.insertPlanningShift({
        employeeNumber: EMPLOYEE,
        locationId: HOME,
        departmentId: homeDepartment,
        shiftDate: "2031-04-06",
        startTime: "13:00",
        endTime: "13:30",
        area: "",
        note: "",
      }),
      (error) => error?.code === "PERSISTENCE_CHECK_VIOLATION"
        && error?.messageKey === "staff-assignment-home-shift-conflict",
    );
    await assert.rejects(
      workRuleStoreRepository.insertTimeOffOption({
        employeeNumber: EMPLOYEE,
        groupId: "direct-provider-write",
        weekStart: "2031-03-31",
        dateFrom: "2031-04-06",
        dateTo: "2031-04-06",
        note: "",
        creditedMinutesPerDay: null,
        allDay: false,
        startTime: "12:15",
        endTime: "12:45",
      }),
      (error) => error?.code === "PERSISTENCE_CHECK_VIOLATION"
        && error?.messageKey === "staff-assignment-direct-absence-conflict",
    );

    const targetShift = db.prepare(`
      INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
      VALUES (?, ?, ?, '2031-04-06', '12:00', '14:00')
    `).run(EMPLOYEE, DESTINATION, destinationDepartment);
    const homeShift = db.prepare(`
      INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
      VALUES (?, ?, ?, '2031-04-06', '09:00', '11:00')
    `).run(EMPLOYEE, HOME, homeDepartment);
    assert.ok(Number(targetShift.lastInsertRowid) > 0);
    assert.ok(Number(homeShift.lastInsertRowid) > 0);

    db.prepare(`
      INSERT INTO employee_location_lendings (
        id, employee_number, home_location_id, destination_location_id,
        destination_department_id, date_from, date_to, all_day, start_time,
        end_time, note, status, revision, created_by, created_at, updated_by, updated_at
      ) VALUES ('v0921-wide-target-shift-setup', ?, ?, ?, ?, '2031-04-07', '2031-04-07',
        0, '09:00', '17:00', '', 'active', 1, 'v0921-test', CURRENT_TIMESTAMP,
        'v0921-test', CURRENT_TIMESTAMP)
    `).run(EMPLOYEE, HOME, DESTINATION, destinationDepartment);
    const wideTargetShift = db.prepare(`
      INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
      VALUES (?, ?, ?, '2031-04-07', '09:00', '17:00')
    `).run(EMPLOYEE, DESTINATION, destinationDepartment);
    db.prepare("DELETE FROM employee_location_lendings WHERE id = 'v0921-wide-target-shift-setup'").run();
    assert.throws(() => db.prepare(`
      INSERT INTO employee_location_lendings (
        id, employee_number, home_location_id, destination_location_id,
        destination_department_id, date_from, date_to, all_day, start_time,
        end_time, note, status, revision, created_by, created_at, updated_by, updated_at
      ) VALUES ('v0921-narrow-target-shift', ?, ?, ?, ?, '2031-04-07', '2031-04-07',
        0, '12:00', '13:00', '', 'active', 1, 'v0921-test', CURRENT_TIMESTAMP,
        'v0921-test', CURRENT_TIMESTAMP)
    `).run(EMPLOYEE, HOME, DESTINATION, destinationDepartment), /EMPLOYEE_LENDING_SHIFT_CONFLICT/);
    const narrowTargetAssignment = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: homeManager,
      body: assignment({
        dateFrom: "2031-04-07",
        dateTo: "2031-04-07",
        startTime: "12:00",
        endTime: "13:00",
      }),
    });
    assert.equal(narrowTargetAssignment.response.status, 409, narrowTargetAssignment.text);
    assert.equal(narrowTargetAssignment.payload.code, "EMPLOYEE_LENDING_SHIFT_CONFLICT");

    db.prepare("DELETE FROM shifts WHERE id IN (?, ?)")
      .run(targetShift.lastInsertRowid, homeShift.lastInsertRowid);
    db.prepare("DELETE FROM shifts WHERE id = ?").run(wideTargetShift.lastInsertRowid);
    db.prepare("DELETE FROM employee_location_lendings WHERE id = 'v0921-trigger-assignment'").run();
  });

  await t.test("Filialleitung delegiert ausschließlich dieses Recht an die eigene Abteilungsleitung", async () => {
    const before = await requestJson("/api/portal/v1/staff-assignments", { session: departmentManager });
    assert.equal(before.response.status, 403, before.text);

    const foreignDenied = await requestJson(
      `/api/portal/v1/staff-assignments/delegates/${FOREIGN_DEPARTMENT_MANAGER}`,
      { method: "PUT", session: homeManager, body: { enabled: true } },
    );
    assert.equal(foreignDenied.response.status, 403, foreignDenied.text);

    const granted = await requestJson(
      `/api/portal/v1/staff-assignments/delegates/${DEPARTMENT_MANAGER}`,
      { method: "PUT", session: homeManager, body: { enabled: true } },
    );
    assert.equal(granted.response.status, 200, granted.text);
    assert.equal(granted.payload.delegate.enabled, true);
    assert.deepEqual(
      db.prepare("SELECT permission FROM portal_permission_grants WHERE employee_number = ? ORDER BY permission")
        .all(DEPARTMENT_MANAGER).map((row) => row.permission),
      ["staff_assignments:manage"],
    );

    departmentManager = createSession(DEPARTMENT_MANAGER);
    const after = await requestJson("/api/portal/v1/staff-assignments", { session: departmentManager });
    assert.equal(after.response.status, 200, after.text);
    assert.ok(after.payload.candidates.some((entry) => entry.employeeNumber === EMPLOYEE));
  });

  await t.test("eine übergeordnete Rechtssperre kann lokal nicht umgangen werden", async () => {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, 'staff_assignments:manage', ?)
    `).run(FOREIGN_DEPARTMENT_MANAGER, HR);

    const delegates = await requestJson(
      `/api/portal/v1/staff-assignments/delegates?locationId=${DESTINATION}`,
      { session: destinationManager },
    );
    assert.equal(delegates.response.status, 200, delegates.text);
    const deniedDelegate = delegates.payload.delegates
      .find((entry) => entry.employeeNumber === FOREIGN_DEPARTMENT_MANAGER);
    assert.equal(deniedDelegate.enabled, false);
    assert.equal(deniedDelegate.denied, true);

    const blocked = await requestJson(
      `/api/portal/v1/staff-assignments/delegates/${FOREIGN_DEPARTMENT_MANAGER}`,
      { method: "PUT", session: destinationManager, body: { enabled: true, locationId: DESTINATION } },
    );
    assert.equal(blocked.response.status, 409, blocked.text);
    assert.equal(blocked.payload.code, "STAFF_ASSIGNMENT_PERMISSION_DENIED");
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ? AND permission = 'staff_assignments:manage'
    `).run(FOREIGN_DEPARTMENT_MANAGER);
  });

  await t.test("Abteilungsleitungen sehen Filialeinsätze nur in der eigenen Abteilung", async () => {
    const granted = await requestJson(
      `/api/portal/v1/staff-assignments/delegates/${FOREIGN_DEPARTMENT_MANAGER}`,
      { method: "PUT", session: destinationManager, body: { enabled: true, locationId: DESTINATION } },
    );
    assert.equal(granted.response.status, 200, granted.text);
    const destinationDepartmentManager = createSession(FOREIGN_DEPARTMENT_MANAGER);

    const hidden = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: hr,
      body: assignment({
        employeeNumber: SECOND_EMPLOYEE,
        destinationDepartmentId: secondDestinationDepartment,
        dateFrom: "2031-06-02",
        dateTo: "2031-06-02",
        allDay: true,
        note: "vertraulicher-abteilungsfremder-hinweis",
      }),
    });
    assert.equal(hidden.response.status, 201, hidden.text);
    const visible = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: hr,
      body: assignment({
        dateFrom: "2031-06-03",
        dateTo: "2031-06-03",
        allDay: true,
        note: "eigene-abteilung",
      }),
    });
    assert.equal(visible.response.status, 201, visible.text);

    const homeView = await requestJson(
      `/api/portal/v1/staff-assignments?locationId=${HOME}&from=2031-06-01&to=2031-06-04`,
      { session: departmentManager },
    );
    assert.equal(homeView.response.status, 200, homeView.text);
    assert.ok(homeView.payload.assignments.some((entry) => entry.id === visible.payload.assignment.id));
    assert.ok(!homeView.payload.assignments.some((entry) => entry.id === hidden.payload.assignment.id));
    assert.ok(!homeView.text.includes("vertraulicher-abteilungsfremder-hinweis"));
    assert.ok(homeView.payload.assignments.every((entry) => !("createdBy" in entry)
      && !("updatedBy" in entry) && !("cancelledBy" in entry)));

    const destinationView = await requestJson(
      `/api/portal/v1/staff-assignments?locationId=${DESTINATION}&from=2031-06-01&to=2031-06-04`,
      { session: destinationDepartmentManager },
    );
    assert.equal(destinationView.response.status, 200, destinationView.text);
    assert.ok(destinationView.payload.assignments.some((entry) => entry.id === visible.payload.assignment.id));
    assert.ok(!destinationView.payload.assignments.some((entry) => entry.id === hidden.payload.assignment.id));

    const globalView = await requestJson(
      "/api/portal/v1/staff-assignments?from=2031-06-01&to=2031-06-04",
      { session: hr },
    );
    assert.equal(globalView.response.status, 200, globalView.text);
    assert.ok(globalView.payload.assignments.some((entry) => entry.id === hidden.payload.assignment.id));
  });

  await t.test("genehmigter Urlaub, ZA und kollidierende Dienste haben Vorrang", async () => {
    const vacation = db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day
      ) VALUES (?, 'v0921-vacation', '2031-04-07', '2031-04-08', '2031-04-08',
        'vacation', 'genehmigt', 1)
    `).run(EMPLOYEE);
    const vacationConflict = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({ dateFrom: "2031-04-08", dateTo: "2031-04-08", allDay: true }),
    });
    assert.equal(vacationConflict.response.status, 409, vacationConflict.text);
    assert.equal(vacationConflict.payload.code, "EMPLOYEE_LENDING_APPROVED_ABSENCE_CONFLICT");
    db.prepare("DELETE FROM week_options WHERE id = ?").run(vacation.lastInsertRowid);

    const timeOff = db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day, start_time, end_time
      ) VALUES (?, 'v0921-time-off', '2031-04-07', '2031-04-09', '2031-04-09',
        'time_off', 'genehmigt', 0, '10:00', '12:00')
    `).run(EMPLOYEE);
    const timeOffConflict = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({ dateFrom: "2031-04-09", dateTo: "2031-04-09", startTime: "11:00", endTime: "13:00" }),
    });
    assert.equal(timeOffConflict.response.status, 409, timeOffConflict.text);
    assert.equal(timeOffConflict.payload.code, "EMPLOYEE_LENDING_APPROVED_ABSENCE_CONFLICT");
    db.prepare("DELETE FROM week_options WHERE id = ?").run(timeOff.lastInsertRowid);

    const pendingVacation = db.prepare(`
      INSERT INTO vacation_requests (employee_number, date_from, date_to, note, status)
      VALUES (?, '2031-04-11', '2031-04-11', 'offen', 'pending')
    `).run(EMPLOYEE);
    const pendingVacationConflict = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({ dateFrom: "2031-04-11", dateTo: "2031-04-11", allDay: true }),
    });
    assert.equal(pendingVacationConflict.response.status, 409, pendingVacationConflict.text);
    assert.equal(
      pendingVacationConflict.payload.code,
      "EMPLOYEE_LENDING_PENDING_ABSENCE_REQUEST_CONFLICT",
    );
    db.prepare("DELETE FROM vacation_requests WHERE id = ?").run(pendingVacation.lastInsertRowid);

    const pendingTimeOff = db.prepare(`
      INSERT INTO time_off_requests (
        employee_number, location_id, origin_location_id, request_date,
        date_from, date_to, all_day, start_time, end_time, note, status
      ) VALUES (?, ?, ?, '2031-04-12', '2031-04-12', '2031-04-12', 0,
        '10:00', '12:00', 'offen', 'pending_local')
    `).run(EMPLOYEE, HOME, HOME);
    const pendingTimeOffConflict = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({
        dateFrom: "2031-04-12",
        dateTo: "2031-04-12",
        startTime: "11:00",
        endTime: "13:00",
      }),
    });
    assert.equal(pendingTimeOffConflict.response.status, 409, pendingTimeOffConflict.text);
    assert.equal(
      pendingTimeOffConflict.payload.code,
      "EMPLOYEE_LENDING_PENDING_ABSENCE_REQUEST_CONFLICT",
    );
    db.prepare("DELETE FROM time_off_requests WHERE id = ?").run(pendingTimeOff.lastInsertRowid);

    const pendingVacationChange = db.prepare(`
      INSERT INTO vacation_change_requests (
        employee_number, vacation_group_id, request_type,
        original_date_from, original_date_to, requested_date_from, requested_date_to,
        note, status
      ) VALUES (?, 'v0921-open-vacation-change', 'change', '2031-04-01', '2031-04-01',
        '2031-04-20', '2031-04-20', 'offene Änderung', 'pending_local')
    `).run(EMPLOYEE);
    const pendingVacationChangeConflict = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({ dateFrom: "2031-04-20", dateTo: "2031-04-20", allDay: true }),
    });
    assert.equal(pendingVacationChangeConflict.response.status, 409, pendingVacationChangeConflict.text);
    assert.equal(
      pendingVacationChangeConflict.payload.code,
      "EMPLOYEE_LENDING_PENDING_ABSENCE_REQUEST_CONFLICT",
    );
    db.prepare("DELETE FROM vacation_change_requests WHERE id = ?")
      .run(pendingVacationChange.lastInsertRowid);

    const pendingVacationCancel = db.prepare(`
      INSERT INTO vacation_change_requests (
        employee_number, vacation_group_id, request_type,
        original_date_from, original_date_to, requested_date_from, requested_date_to,
        note, status
      ) VALUES (?, 'v0921-open-vacation-cancel', 'cancel', '2031-04-01', '2031-04-01',
        '2031-04-20', '2031-04-20', 'offenes Storno', 'pending_local')
    `).run(EMPLOYEE);
    const vacationCancelDoesNotBlock = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({ dateFrom: "2031-04-20", dateTo: "2031-04-20", allDay: true }),
    });
    assert.equal(vacationCancelDoesNotBlock.response.status, 201, vacationCancelDoesNotBlock.text);
    db.prepare("DELETE FROM employee_location_lendings WHERE id = ?")
      .run(vacationCancelDoesNotBlock.payload.assignment.id);
    db.prepare("DELETE FROM vacation_change_requests WHERE id = ?")
      .run(pendingVacationCancel.lastInsertRowid);

    const changeMove = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({
        dateFrom: "2031-04-21",
        dateTo: "2031-04-21",
        startTime: "10:00",
        endTime: "11:00",
      }),
    });
    assert.equal(changeMove.response.status, 201, changeMove.text);
    const originalTimeOff = db.prepare(`
      INSERT INTO time_off_requests (
        employee_number, location_id, origin_location_id, request_date,
        date_from, date_to, all_day, start_time, end_time, note, status
      ) VALUES (?, ?, ?, '2031-04-01', '2031-04-01', '2031-04-01', 0,
        '10:00', '11:00', 'ursprünglich', 'approved')
    `).run(EMPLOYEE, HOME, HOME);
    const pendingTimeOffChange = db.prepare(`
      INSERT INTO time_off_change_requests (
        employee_number, location_id, origin_location_id, original_request_id,
        request_type, requested_date_from, requested_date_to, requested_all_day,
        requested_start_time, requested_end_time, note, status
      ) VALUES (?, ?, ?, ?, 'change', '2031-04-22', '2031-04-22', 0,
        '10:00', '12:00', 'offene Änderung', 'pending_local')
    `).run(EMPLOYEE, HOME, HOME, originalTimeOff.lastInsertRowid);
    const pendingTimeOffChangeConflict = await requestJson(
      `/api/portal/v1/staff-assignments/${changeMove.payload.assignment.id}`,
      {
        method: "PUT",
        session: departmentManager,
        body: assignment({
          dateFrom: "2031-04-22",
          dateTo: "2031-04-22",
          startTime: "11:00",
          endTime: "13:00",
          revision: changeMove.payload.assignment.revision,
        }),
      },
    );
    assert.equal(pendingTimeOffChangeConflict.response.status, 409, pendingTimeOffChangeConflict.text);
    assert.equal(
      pendingTimeOffChangeConflict.payload.code,
      "EMPLOYEE_LENDING_PENDING_ABSENCE_REQUEST_CONFLICT",
    );
    db.prepare("DELETE FROM time_off_change_requests WHERE id = ?")
      .run(pendingTimeOffChange.lastInsertRowid);
    const pendingTimeOffCancel = db.prepare(`
      INSERT INTO time_off_change_requests (
        employee_number, location_id, origin_location_id, original_request_id,
        request_type, requested_date_from, requested_date_to, requested_all_day,
        requested_start_time, requested_end_time, note, status
      ) VALUES (?, ?, ?, ?, 'cancel', '2031-04-22', '2031-04-22', 0,
        '10:00', '12:00', 'offenes Storno', 'pending_local')
    `).run(EMPLOYEE, HOME, HOME, originalTimeOff.lastInsertRowid);
    const timeOffCancelDoesNotBlock = await requestJson(
      `/api/portal/v1/staff-assignments/${changeMove.payload.assignment.id}`,
      {
        method: "PUT",
        session: departmentManager,
        body: assignment({
          dateFrom: "2031-04-22",
          dateTo: "2031-04-22",
          startTime: "11:00",
          endTime: "13:00",
          revision: changeMove.payload.assignment.revision,
        }),
      },
    );
    assert.equal(timeOffCancelDoesNotBlock.response.status, 200, timeOffCancelDoesNotBlock.text);
    db.prepare("DELETE FROM employee_location_lendings WHERE id = ?")
      .run(changeMove.payload.assignment.id);
    db.prepare("DELETE FROM time_off_change_requests WHERE id = ?")
      .run(pendingTimeOffCancel.lastInsertRowid);
    db.prepare("DELETE FROM time_off_requests WHERE id = ?").run(originalTimeOff.lastInsertRowid);

    const movable = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({
        dateFrom: "2031-04-13",
        dateTo: "2031-04-13",
        startTime: "10:00",
        endTime: "11:00",
      }),
    });
    assert.equal(movable.response.status, 201, movable.text);
    const pendingMoveTarget = db.prepare(`
      INSERT INTO vacation_requests (employee_number, date_from, date_to, note, status)
      VALUES (?, '2031-04-14', '2031-04-14', 'offen', 'pending_local')
    `).run(EMPLOYEE);
    const blockedMove = await requestJson(
      `/api/portal/v1/staff-assignments/${movable.payload.assignment.id}`,
      {
        method: "PUT",
        session: departmentManager,
        body: assignment({
          dateFrom: "2031-04-14",
          dateTo: "2031-04-14",
          startTime: "10:00",
          endTime: "11:00",
          revision: movable.payload.assignment.revision,
        }),
      },
    );
    assert.equal(blockedMove.response.status, 409, blockedMove.text);
    assert.equal(blockedMove.payload.code, "EMPLOYEE_LENDING_PENDING_ABSENCE_REQUEST_CONFLICT");
    db.prepare("DELETE FROM vacation_requests WHERE id = ?").run(pendingMoveTarget.lastInsertRowid);
    db.prepare("DELETE FROM employee_location_lendings WHERE id = ?")
      .run(movable.payload.assignment.id);

    const shiftConflict = db.prepare(`
      INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
      VALUES (?, ?, ?, '2031-04-09', '09:00', '12:00')
    `).run(EMPLOYEE, HOME, homeDepartment);
    const blocked = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({ dateFrom: "2031-04-09", dateTo: "2031-04-09", startTime: "11:00", endTime: "13:00" }),
    });
    assert.equal(blocked.response.status, 409, blocked.text);
    assert.equal(blocked.payload.code, "EMPLOYEE_LENDING_SHIFT_CONFLICT");
    db.prepare("DELETE FROM shifts WHERE id = ?").run(shiftConflict.lastInsertRowid);
  });

  await t.test("genehmigter verknüpfter ZA erlaubt nur reine Notizänderungen", async () => {
    const created = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment({
        dateFrom: "2031-04-23",
        dateTo: "2031-04-23",
        startTime: "12:00",
        endTime: "14:00",
      }),
    });
    assert.equal(created.response.status, 201, created.text);
    const linkedRequest = db.prepare(`
      INSERT INTO time_off_requests (
        employee_number, location_id, origin_location_id, review_department_id, lending_id,
        request_date, date_from, date_to, all_day, start_time, end_time, note, status
      ) VALUES (?, ?, ?, ?, ?, '2031-04-23', '2031-04-23', '2031-04-23', 0,
        '12:15', '12:45', 'genehmigt', 'approved')
    `).run(
      EMPLOYEE,
      DESTINATION,
      HOME,
      destinationDepartment,
      created.payload.assignment.id,
    );
    const linkedOption = db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day, start_time, end_time
      ) VALUES (?, ?, '2031-04-21', '2031-04-23', '2031-04-23',
        'time_off', 'genehmigt', 0, '12:15', '12:45')
    `).run(EMPLOYEE, `za-request-${linkedRequest.lastInsertRowid}`);

    const noteOnly = await requestJson(
      `/api/portal/v1/staff-assignments/${created.payload.assignment.id}`,
      {
        method: "PUT",
        session: departmentManager,
        body: assignment({
          dateFrom: "2031-04-23",
          dateTo: "2031-04-23",
          startTime: "12:00",
          endTime: "14:00",
          revision: created.payload.assignment.revision,
          note: "nur Notiz geändert",
        }),
      },
    );
    assert.equal(noteOnly.response.status, 200, noteOnly.text);
    assert.equal(noteOnly.payload.assignment.revision, 2);

    const contextChange = await requestJson(
      `/api/portal/v1/staff-assignments/${created.payload.assignment.id}`,
      {
        method: "PUT",
        session: departmentManager,
        body: assignment({
          dateFrom: "2031-04-23",
          dateTo: "2031-04-23",
          startTime: "12:00",
          endTime: "14:15",
          revision: noteOnly.payload.assignment.revision,
        }),
      },
    );
    assert.equal(contextChange.response.status, 409, contextChange.text);
    const cancelled = await requestJson(
      `/api/portal/v1/staff-assignments/${created.payload.assignment.id}/cancel`,
      {
        method: "POST",
        session: departmentManager,
        body: { revision: noteOnly.payload.assignment.revision },
      },
    );
    assert.equal(cancelled.response.status, 409, cancelled.text);
    assert.equal(cancelled.payload.code, "EMPLOYEE_LENDING_TIME_OFF_REFERENCE_EXISTS");

    db.prepare("DELETE FROM week_options WHERE id = ?").run(linkedOption.lastInsertRowid);
    db.prepare("DELETE FROM time_off_requests WHERE id = ?").run(linkedRequest.lastInsertRowid);
    db.prepare("DELETE FROM employee_location_lendings WHERE id = ?")
      .run(created.payload.assignment.id);
  });

  let createdAssignment;
  let destinationShiftId;

  await t.test("Zielfiliale sieht bei stundenweisem Einsatz nur zeitlich ueberlappende Abwesenheiten", async (subtest) => {
    let focusedAssignmentId = null;
    let allDayAssignmentId = null;
    let focusedShiftId = null;
    let targetRequestId = null;
    let homeOptionId = null;
    let targetOptionId = null;
    let allDayAbsenceOptionId = null;
    let allDayAssignmentOptionId = null;
    subtest.after(() => {
      if (homeOptionId) db.prepare("DELETE FROM week_options WHERE id = ?").run(homeOptionId);
      if (targetOptionId) db.prepare("DELETE FROM week_options WHERE id = ?").run(targetOptionId);
      if (allDayAbsenceOptionId) {
        db.prepare("DELETE FROM week_options WHERE id = ?").run(allDayAbsenceOptionId);
      }
      if (allDayAssignmentOptionId) {
        db.prepare("DELETE FROM week_options WHERE id = ?").run(allDayAssignmentOptionId);
      }
      if (targetRequestId) db.prepare("DELETE FROM time_off_requests WHERE id = ?").run(targetRequestId);
      if (focusedShiftId) db.prepare("DELETE FROM shifts WHERE id = ?").run(focusedShiftId);
      if (focusedAssignmentId) {
        db.prepare("DELETE FROM employee_location_lendings WHERE id = ?").run(focusedAssignmentId);
      }
      if (allDayAssignmentId) {
        db.prepare("DELETE FROM employee_location_lendings WHERE id = ?").run(allDayAssignmentId);
      }
    });

    const created = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: hr,
      body: assignment({
        employeeNumber: SECOND_EMPLOYEE,
        destinationDepartmentId: secondDestinationDepartment,
        dateFrom: "2031-04-15",
        dateTo: "2031-04-15",
        startTime: "10:00",
        endTime: "12:00",
        note: "Fokussierter Projektions-Test",
      }),
    });
    assert.equal(created.response.status, 201, created.text);
    focusedAssignmentId = created.payload.assignment.id;

    const createdAllDay = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: hr,
      body: assignment({
        employeeNumber: SECOND_EMPLOYEE,
        destinationDepartmentId: secondDestinationDepartment,
        dateFrom: "2031-04-16",
        dateTo: "2031-04-16",
        allDay: true,
        startTime: null,
        endTime: null,
        note: "Ganztagssemantik-Test",
      }),
    });
    assert.equal(createdAllDay.response.status, 201, createdAllDay.text);
    allDayAssignmentId = createdAllDay.payload.assignment.id;

    const targetShift = await requestJson("/api/shifts", {
      method: "POST",
      session: destinationManager,
      body: shift({
        employeeNumber: SECOND_EMPLOYEE,
        departmentId: secondDestinationDepartment,
        date: "2031-04-15",
        startTime: "10:00",
        endTime: "12:00",
      }),
    });
    assert.equal(targetShift.response.status, 201, targetShift.text);
    focusedShiftId = targetShift.payload.id;

    homeOptionId = Number(db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day, start_time, end_time
      ) VALUES (?, 'v0921-home-za-after-assignment', '2031-04-14',
        '2031-04-15', '2031-04-15', 'time_off', 'Stamm-ZA 15 bis 16', 0, '15:00', '16:00')
    `).run(SECOND_EMPLOYEE).lastInsertRowid);

    targetRequestId = Number(db.prepare(`
      INSERT INTO time_off_requests (
        employee_number, location_id, origin_location_id, review_department_id, lending_id,
        request_date, date_from, date_to, all_day, start_time, end_time, note, status
      ) VALUES (?, ?, ?, ?, ?, '2031-04-15', '2031-04-15', '2031-04-15', 0,
        '11:00', '11:30', 'Ziel-ZA 11 bis 11:30', 'approved')
    `).run(
      SECOND_EMPLOYEE,
      DESTINATION,
      HOME,
      secondDestinationDepartment,
      focusedAssignmentId,
    ).lastInsertRowid);
    targetOptionId = Number(db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day, start_time, end_time
      ) VALUES (?, ?, '2031-04-14', '2031-04-15', '2031-04-15',
        'time_off', 'Ziel-ZA 11 bis 11:30', 0, '11:00', '11:30')
    `).run(SECOND_EMPLOYEE, `za-request-${targetRequestId}`).lastInsertRowid);
    allDayAbsenceOptionId = Number(db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day
      ) VALUES (?, 'v0921-all-day-sick-hourly-assignment', '2031-04-14',
        '2031-04-15', '2031-04-15', 'sick', 'Ganztägig im Stunden-Einsatz', 1)
    `).run(SECOND_EMPLOYEE).lastInsertRowid);
    allDayAssignmentOptionId = Number(db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day, start_time, end_time
      ) VALUES (?, 'v0921-timed-sick-all-day-assignment', '2031-04-14',
        '2031-04-16', '2031-04-16', 'sick', 'Stundenweise im Ganztags-Einsatz', 0, '15:00', '16:00')
    `).run(SECOND_EMPLOYEE).lastInsertRowid);

    const targetSchedule = await requestJson(
      `/api/schedule?week=2031-04-14&location=${DESTINATION}&department=${secondDestinationDepartment}`,
      { session: destinationManager },
    );
    assert.equal(targetSchedule.response.status, 200, targetSchedule.text);
    assert.ok(targetSchedule.payload.weekOptions
      .some((entry) => Number(entry.id) === targetOptionId));
    assert.ok(targetSchedule.payload.weekOptions
      .some((entry) => Number(entry.id) === allDayAbsenceOptionId));
    assert.ok(targetSchedule.payload.weekOptions
      .some((entry) => Number(entry.id) === allDayAssignmentOptionId));
    assert.ok(!targetSchedule.payload.weekOptions
      .some((entry) => Number(entry.id) === homeOptionId));

    const homeSchedule = await requestJson(
      `/api/schedule?week=2031-04-14&location=${HOME}&department=${secondHomeDepartment}`,
      { session: homeManager },
    );
    assert.equal(homeSchedule.response.status, 200, homeSchedule.text);
    assert.ok(homeSchedule.payload.weekOptions
      .some((entry) => Number(entry.id) === homeOptionId));
  });

  await t.test("stundenweiser Einsatz erlaubt Zielplanung und nicht überlappende Stammplanung", async () => {
    const created = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: departmentManager,
      body: assignment(),
    });
    assert.equal(created.response.status, 201, created.text);
    createdAssignment = created.payload.assignment;
    assert.equal(createdAssignment.revision, 1);
    assert.ok(!("createdBy" in createdAssignment)
      && !("updatedBy" in createdAssignment) && !("cancelledBy" in createdAssignment));

    const directTimeOff = await requestJson("/api/week-options", {
      method: "POST",
      session: homeManager,
      body: {
        employeeNumber: EMPLOYEE,
        weekStart: "2031-04-07",
        dateFrom: "2031-04-10",
        dateTo: "2031-04-10",
        optionType: "time_off",
        note: "Direkter ZA",
        allDay: false,
        startTime: "12:15",
        endTime: "12:45",
      },
    });
    assert.equal(directTimeOff.response.status, 409, directTimeOff.text);
    assert.equal(directTimeOff.payload.code, "STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT");

    const unlinkedPendingTimeOff = db.prepare(`
      INSERT INTO time_off_requests (
        employee_number, location_id, origin_location_id, request_date,
        date_from, date_to, all_day, start_time, end_time, note, status
      ) VALUES (?, ?, ?, '2031-04-10', '2031-04-10', '2031-04-10', 0,
        '12:15', '12:45', 'simulierter Parallelkonflikt', 'pending_local')
    `).run(EMPLOYEE, HOME, HOME);
    const finalizedConflict = await requestJson(
      `/api/portal/v1/absence-requests/time_off/${unlinkedPendingTimeOff.lastInsertRowid}/action`,
      {
        method: "PUT",
        session: homeManager,
        body: { action: "approve", note: "" },
      },
    );
    assert.equal(finalizedConflict.response.status, 409, finalizedConflict.text);
    assert.equal(finalizedConflict.payload.code, "STAFF_ASSIGNMENT_DIRECT_ABSENCE_CONFLICT");
    assert.equal(db.prepare("SELECT status FROM time_off_requests WHERE id = ?")
      .get(unlinkedPendingTimeOff.lastInsertRowid).status, "pending_local");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM week_options WHERE group_id = ?")
      .get(`za-request-${unlinkedPendingTimeOff.lastInsertRowid}`).count, 0);
    db.prepare("DELETE FROM time_off_requests WHERE id = ?")
      .run(unlinkedPendingTimeOff.lastInsertRowid);

    const targetRequest = db.prepare(`
      INSERT INTO time_off_requests (
        employee_number, location_id, origin_location_id, review_department_id, lending_id,
        request_date, date_from, date_to, all_day, start_time, end_time, note, status
      ) VALUES (?, ?, ?, ?, ?, '2031-04-10', '2031-04-10', '2031-04-10', 0,
        '12:15', '12:45', 'Ziel-ZA', 'approved')
    `).run(EMPLOYEE, DESTINATION, HOME, destinationDepartment, createdAssignment.id);
    const targetTimeOff = db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day, start_time, end_time
      ) VALUES (?, ?, '2031-04-07', '2031-04-10', '2031-04-10',
        'time_off', 'Ziel-ZA', 0, '12:15', '12:45')
    `).run(EMPLOYEE, `za-request-${targetRequest.lastInsertRowid}`);
    const targetScheduleWithoutShift = await requestJson(
      `/api/schedule?week=2031-04-07&location=${DESTINATION}&department=${destinationDepartment}`,
      { session: destinationManager },
    );
    assert.equal(targetScheduleWithoutShift.response.status, 200, targetScheduleWithoutShift.text);
    const scheduleAssignment = targetScheduleWithoutShift.payload.staffAssignments
      .find((entry) => entry.id === createdAssignment.id);
    assert.ok(scheduleAssignment);
    assert.ok(!("note" in scheduleAssignment) && !("revision" in scheduleAssignment)
      && !("created_at" in scheduleAssignment) && !("updated_at" in scheduleAssignment));
    assert.ok(targetScheduleWithoutShift.payload.weekOptions
      .some((entry) => Number(entry.id) === Number(targetTimeOff.lastInsertRowid)));
    db.prepare("DELETE FROM week_options WHERE id = ?").run(targetTimeOff.lastInsertRowid);
    db.prepare("DELETE FROM time_off_requests WHERE id = ?").run(targetRequest.lastInsertRowid);

    const incoming = await requestJson(
      `/api/portal/v1/staff-assignments?locationId=${DESTINATION}&from=2031-04-10&to=2031-04-10`,
      { session: destinationManager },
    );
    assert.equal(incoming.response.status, 200, incoming.text);
    assert.ok(incoming.payload.assignments.some((entry) => entry.id === createdAssignment.id));
    assert.equal(incoming.payload.assignments.find((entry) => entry.id === createdAssignment.id).canEdit, false);

    const destinationShift = await requestJson("/api/shifts", {
      method: "POST",
      session: destinationManager,
      body: shift(),
    });
    assert.equal(destinationShift.response.status, 201, destinationShift.text);
    destinationShiftId = destinationShift.payload.id;

    const uncoveredDestination = await requestJson("/api/shifts", {
      method: "POST",
      session: destinationManager,
      body: shift({ startTime: "14:00", endTime: "15:00" }),
    });
    assert.equal(uncoveredDestination.response.status, 403, uncoveredDestination.text);
    assert.equal(uncoveredDestination.payload.code, "SHIFT_FOREIGN_EMPLOYEE_SCOPE_DENIED");

    const nonOverlappingHome = await requestJson("/api/shifts", {
      method: "POST",
      session: homeManager,
      body: shift({ locationId: HOME, departmentId: homeDepartment, startTime: "09:00", endTime: "11:00" }),
    });
    assert.equal(nonOverlappingHome.response.status, 201, nonOverlappingHome.text);

    const homeScheduleWithExternalShift = await requestJson(
      `/api/schedule?week=2031-04-07&location=${HOME}&department=${homeDepartment}`,
      { session: homeManager },
    );
    assert.equal(homeScheduleWithExternalShift.response.status, 200, homeScheduleWithExternalShift.text);
    assert.equal(homeScheduleWithExternalShift.payload.plannedTotals[EMPLOYEE], 240);
    assert.equal(homeScheduleWithExternalShift.payload.totals[EMPLOYEE], 240);
    assert.equal(homeScheduleWithExternalShift.payload.inStoreTotals[EMPLOYEE], 120);
    assert.equal(
      homeScheduleWithExternalShift.payload.shifts.filter((entry) => entry.employee_number === EMPLOYEE).length,
      1,
      "Fremdfilialdienste dürfen nur in die Stundensumme einfließen, nicht als fremde Plandetails erscheinen.",
    );

    const destinationScheduleWithIncomingShift = await requestJson(
      `/api/schedule?week=2031-04-07&location=${DESTINATION}&department=${destinationDepartment}`,
      { session: destinationManager },
    );
    assert.equal(destinationScheduleWithIncomingShift.response.status, 200, destinationScheduleWithIncomingShift.text);
    assert.equal(destinationScheduleWithIncomingShift.payload.plannedTotals[EMPLOYEE], 120);
    assert.equal(destinationScheduleWithIncomingShift.payload.totals[EMPLOYEE], 120);
    assert.equal(destinationScheduleWithIncomingShift.payload.inStoreTotals[EMPLOYEE], 120);

    const overlappingHome = await requestJson("/api/shifts", {
      method: "POST",
      session: homeManager,
      body: shift({ locationId: HOME, departmentId: homeDepartment, startTime: "13:00", endTime: "13:30" }),
    });
    assert.equal(overlappingHome.response.status, 409, overlappingHome.text);
    assert.equal(overlappingHome.payload.code, "STAFF_ASSIGNMENT_HOME_SHIFT_CONFLICT");
  });

  await t.test("acht Stunden in der Zielfiliale zählen in der Einplanung der Stammfiliale", async () => {
    const assignmentId = "v0921-eight-hours-total";
    let shiftId = null;
    db.prepare(`
      INSERT INTO employee_location_lendings (
        id, employee_number, home_location_id, destination_location_id,
        destination_department_id, date_from, date_to, all_day, start_time,
        end_time, note, status, revision, created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, '2031-05-12', '2031-05-12', 1, NULL, NULL,
        '', 'active', 1, 'v0921-test', CURRENT_TIMESTAMP, 'v0921-test', CURRENT_TIMESTAMP)
    `).run(assignmentId, SECOND_EMPLOYEE, HOME, DESTINATION, secondDestinationDepartment);
    try {
      shiftId = Number(db.prepare(`
        INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time)
        VALUES (?, ?, ?, '2031-05-12', '09:00', '17:30')
      `).run(SECOND_EMPLOYEE, DESTINATION, secondDestinationDepartment).lastInsertRowid);

      const homeSchedule = await requestJson(
        `/api/schedule?week=2031-05-12&location=${HOME}&department=${secondHomeDepartment}`,
        { session: homeManager },
      );
      assert.equal(homeSchedule.response.status, 200, homeSchedule.text);
      assert.equal(homeSchedule.payload.plannedTotals[SECOND_EMPLOYEE], 480);
      assert.equal(homeSchedule.payload.totals[SECOND_EMPLOYEE], 480);
      assert.equal(homeSchedule.payload.inStoreTotals[SECOND_EMPLOYEE], 0);
      assert.equal(homeSchedule.payload.shifts.some((entry) => Number(entry.id) === shiftId), false);

      db.prepare(`
        INSERT OR IGNORE INTO portal_permission_grants (employee_number, permission, granted_by)
        VALUES (?, 'schedule:pdf:settings:write', 'v0921-test')
      `).run(HR);
      for (const [locationId, departmentId] of [
        [HOME, secondHomeDepartment],
        [DESTINATION, secondDestinationDepartment],
      ]) {
        const pdfSettings = await requestJson("/api/portal/v1/schedule-pdf-settings", {
          method: "PUT",
          session: hr,
          body: { locationId, departmentId, schedulePdfDesignIds: ["timeline", "matrix"] },
        });
        assert.equal(pdfSettings.response.status, 200, pdfSettings.text);
      }

      const homeTimelinePdf = await requestPdf(
        `/api/schedule.pdf?week=2031-05-12&locationId=${HOME}&departmentId=${secondHomeDepartment}&design=timeline`,
        { session: homeManager },
      );
      assert.equal(homeTimelinePdf.response.status, 200);
      const homeTimelineText = await pdfText(homeTimelinePdf.payload);
      assert.match(homeTimelineText, /Sophie: Andere Filiale/);
      assert.match(homeTimelineText, /Temporärer Filialeinsatz/);
      assert.match(homeTimelineText, /Zielfiliale/);
      assert.match(homeTimelineText, /Zweite Ziel-?\s*Abteilung/);

      const homeMatrixPdf = await requestPdf(
        `/api/schedule.pdf?week=2031-05-12&locationId=${HOME}&departmentId=${secondHomeDepartment}&design=matrix`,
        { session: homeManager },
      );
      assert.equal(homeMatrixPdf.response.status, 200);
      const homeMatrixText = await pdfText(homeMatrixPdf.payload);
      assert.match(homeMatrixText, /Andere Filiale · ganztägig/);
      assert.match(homeMatrixText, /1A/);
      assert.doesNotMatch(homeMatrixText, /09:00-17:30/);

      const destinationSchedule = await requestJson(
        `/api/schedule?week=2031-05-12&location=${DESTINATION}&department=${secondDestinationDepartment}`,
        { session: destinationManager },
      );
      assert.equal(destinationSchedule.response.status, 200, destinationSchedule.text);
      assert.equal(destinationSchedule.payload.plannedTotals[SECOND_EMPLOYEE], 480);
      assert.equal(destinationSchedule.payload.totals[SECOND_EMPLOYEE], 480);
      assert.equal(destinationSchedule.payload.inStoreTotals[SECOND_EMPLOYEE], 480);

      const destinationMatrixPdf = await requestPdf(
        `/api/schedule.pdf?week=2031-05-12&locationId=${DESTINATION}&departmentId=${secondDestinationDepartment}&design=matrix`,
        { session: destinationManager },
      );
      assert.equal(destinationMatrixPdf.response.status, 200);
      const destinationMatrixText = await pdfText(destinationMatrixPdf.payload);
      assert.match(destinationMatrixText, /09:00-17:30/);
      assert.doesNotMatch(destinationMatrixText, /Andere Filiale · ganztägig/);
    } finally {
      if (shiftId) db.prepare("DELETE FROM shifts WHERE id = ?").run(shiftId);
      db.prepare("DELETE FROM employee_location_lendings WHERE id = ?").run(assignmentId);
    }
  });

  await t.test("Zeitgrenze, Viertelstundenraster und Zielabteilung werden serverseitig erzwungen", async () => {
    const longRange = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: hr,
      body: assignment({
        dateFrom: "2031-05-01",
        dateTo: "2032-05-01",
        allDay: true,
      }),
    });
    assert.equal(longRange.response.status, 400, longRange.text);
    assert.equal(longRange.payload.code, "STAFF_ASSIGNMENT_DATE_RANGE_TOO_LONG");

    const invalidStep = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: hr,
      body: assignment({
        dateFrom: "2031-05-02",
        dateTo: "2031-05-02",
        startTime: "10:10",
        endTime: "11:10",
      }),
    });
    assert.equal(invalidStep.response.status, 400, invalidStep.text);
    assert.equal(invalidStep.payload.code, "STAFF_ASSIGNMENT_TIME_STEP_INVALID");

    const departmentBound = await requestJson("/api/portal/v1/staff-assignments", {
      method: "POST",
      session: hr,
      body: assignment({
        dateFrom: "2031-05-05",
        dateTo: "2031-05-05",
        startTime: "10:00",
        endTime: "12:00",
      }),
    });
    assert.equal(departmentBound.response.status, 201, departmentBound.text);

    const wrongDepartment = await requestJson("/api/shifts", {
      method: "POST",
      session: destinationManager,
      body: shift({
        date: "2031-05-05",
        departmentId: null,
        startTime: "10:00",
        endTime: "12:00",
      }),
    });
    assert.equal(wrongDepartment.response.status, 409, wrongDepartment.text);
    assert.equal(wrongDepartment.payload.code, "STAFF_ASSIGNMENT_DEPARTMENT_MISMATCH");
  });

  await t.test("Revision und Stornierung schützen konkurrierende Änderungen und Zieldienste", async () => {
    const blockedCancel = await requestJson(
      `/api/portal/v1/staff-assignments/${createdAssignment.id}/cancel`,
      { method: "POST", session: departmentManager, body: { revision: createdAssignment.revision } },
    );
    assert.equal(blockedCancel.response.status, 409, blockedCancel.text);
    assert.equal(blockedCancel.payload.code, "EMPLOYEE_LENDING_TARGET_SHIFT_EXISTS");

    const removedShift = await requestJson(`/api/shifts/${destinationShiftId}`, {
      method: "DELETE",
      session: destinationManager,
    });
    assert.equal(removedShift.response.status, 204, removedShift.text);

    const updated = await requestJson(`/api/portal/v1/staff-assignments/${createdAssignment.id}`, {
      method: "PUT",
      session: departmentManager,
      body: { ...assignment(), revision: createdAssignment.revision, note: "aktualisiert" },
    });
    assert.equal(updated.response.status, 200, updated.text);
    assert.equal(updated.payload.assignment.revision, 2);
    assert.ok(!("createdBy" in updated.payload.assignment)
      && !("updatedBy" in updated.payload.assignment) && !("cancelledBy" in updated.payload.assignment));

    const noteOnly = await requestJson(`/api/portal/v1/staff-assignments/${createdAssignment.id}`, {
      method: "PUT",
      session: departmentManager,
      body: { ...assignment(), revision: 2, note: "nur Notiz geändert" },
    });
    assert.equal(noteOnly.response.status, 200, noteOnly.text);
    assert.equal(noteOnly.payload.assignment.revision, 3);

    const linkedRequest = db.prepare(`
      INSERT INTO time_off_requests (
        employee_number, location_id, origin_location_id, review_department_id, lending_id,
        request_date, date_from, date_to, all_day, start_time, end_time, note, status
      ) VALUES (?, ?, ?, ?, ?, '2031-04-10', '2031-04-10', '2031-04-10', 0,
        '12:15', '12:45', '', 'pending_local')
    `).run(EMPLOYEE, DESTINATION, HOME, destinationDepartment, createdAssignment.id);
    const contextChange = await requestJson(`/api/portal/v1/staff-assignments/${createdAssignment.id}`, {
      method: "PUT",
      session: departmentManager,
      body: { ...assignment(), revision: 3, endTime: "13:45" },
    });
    assert.equal(contextChange.response.status, 409, contextChange.text);
    assert.equal(contextChange.payload.code, "EMPLOYEE_LENDING_TIME_OFF_REFERENCE_EXISTS");

    db.prepare("UPDATE time_off_requests SET status = 'withdrawn' WHERE id = ?")
      .run(linkedRequest.lastInsertRowid);
    const linkedChange = db.prepare(`
      INSERT INTO time_off_change_requests (
        employee_number, location_id, origin_location_id, review_department_id, lending_id,
        original_request_id, request_type, requested_date_from, requested_date_to,
        requested_all_day, requested_start_time, requested_end_time, note, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'change', '2031-04-10', '2031-04-10', 0,
        '12:15', '12:45', '', 'pending_local')
    `).run(
      EMPLOYEE,
      DESTINATION,
      HOME,
      destinationDepartment,
      createdAssignment.id,
      linkedRequest.lastInsertRowid,
    );
    const linkedCancel = await requestJson(
      `/api/portal/v1/staff-assignments/${createdAssignment.id}/cancel`,
      { method: "POST", session: departmentManager, body: { revision: 3 } },
    );
    assert.equal(linkedCancel.response.status, 409, linkedCancel.text);
    assert.equal(linkedCancel.payload.code, "EMPLOYEE_LENDING_TIME_OFF_REFERENCE_EXISTS");
    db.prepare("UPDATE time_off_change_requests SET status = 'approved' WHERE id = ?")
      .run(linkedChange.lastInsertRowid);
    db.prepare("UPDATE time_off_requests SET status = 'cancelled' WHERE id = ?")
      .run(linkedRequest.lastInsertRowid);
    const afterHistory = await requestJson(`/api/portal/v1/staff-assignments/${createdAssignment.id}`, {
      method: "PUT",
      session: departmentManager,
      body: { ...assignment(), revision: 3, endTime: "13:45", note: "abgeschlossene Historie" },
    });
    assert.equal(afterHistory.response.status, 200, afterHistory.text);
    assert.equal(afterHistory.payload.assignment.revision, 4);
    assert.equal(afterHistory.payload.assignment.endTime, "13:45");
    db.prepare("DELETE FROM time_off_change_requests WHERE id = ?").run(linkedChange.lastInsertRowid);
    db.prepare("DELETE FROM time_off_requests WHERE id = ?").run(linkedRequest.lastInsertRowid);

    const stale = await requestJson(`/api/portal/v1/staff-assignments/${createdAssignment.id}`, {
      method: "PUT",
      session: departmentManager,
      body: { ...assignment(), revision: 1, note: "veraltet" },
    });
    assert.equal(stale.response.status, 409, stale.text);
    assert.equal(stale.payload.code, "EMPLOYEE_LENDING_REVISION_CONFLICT");

    const cancelled = await requestJson(
      `/api/portal/v1/staff-assignments/${createdAssignment.id}/cancel`,
      { method: "POST", session: departmentManager, body: { revision: 4 } },
    );
    assert.equal(cancelled.response.status, 200, cancelled.text);
    assert.equal(cancelled.payload.assignment.status, "cancelled");
    assert.equal(cancelled.payload.assignment.revision, 5);
    assert.ok(!("createdBy" in cancelled.payload.assignment)
      && !("updatedBy" in cancelled.payload.assignment) && !("cancelledBy" in cancelled.payload.assignment));
  });

  await t.test("Rechteentzug beendet Sitzungen und ist auditiert", async () => {
    const revoked = await requestJson(
      `/api/portal/v1/staff-assignments/delegates/${DEPARTMENT_MANAGER}`,
      { method: "PUT", session: homeManager, body: { enabled: false } },
    );
    assert.equal(revoked.response.status, 200, revoked.text);
    assert.equal(revoked.payload.delegate.enabled, false);

    const deniedAgain = await requestJson("/api/portal/v1/staff-assignments", {
      session: createSession(DEPARTMENT_MANAGER),
    });
    assert.equal(deniedAgain.response.status, 403, deniedAgain.text);

    const actions = db.prepare(`
      SELECT action FROM audit_log
      WHERE entity_id IN (?, ?)
      ORDER BY id
    `).all(DEPARTMENT_MANAGER, createdAssignment.id).map((row) => row.action);
    assert.ok(actions.includes("staff-assignment.permission.grant"));
    assert.ok(actions.includes("staff-assignment.create"));
    assert.ok(actions.includes("staff-assignment.update"));
    assert.ok(actions.includes("staff-assignment.cancel"));
    assert.ok(actions.includes("staff-assignment.permission.revoke"));
  });
});
