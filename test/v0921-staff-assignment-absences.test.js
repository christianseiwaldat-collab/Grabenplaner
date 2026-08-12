"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0921-assignment-absences-"));
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
  runSicknessEscalationSweep,
} = require("../server");

const HOME = "84";
const DESTINATION = "85";
const EMPLOYEE = "v0921-absence-employee";
const OPEN_SICKNESS_EMPLOYEE = "v0921-open-sickness-employee";
const HOME_MANAGER = "v0921-absence-home-manager";
const DESTINATION_MANAGER = "v0921-absence-destination-manager";
const RETRY_DESTINATION_MANAGER = "v0921-absence-destination-manager-z";
let homeDepartment;
let destinationDepartment;
let httpServer;
let baseUrl;
let employeeSession;
let openSicknessEmployeeSession;
let homeManagerSession;
let destinationManagerSession;

function daySettings(start, end) {
  return JSON.stringify(Object.fromEntries([
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  ].map((day) => [day, {
    open: true,
    start,
    end,
    lunchEnabled: false,
    lunchStart: "13:00",
    lunchEnd: "14:00",
    minStaff: 0,
    minFrom: start,
    minTo: end,
  }])));
}

function ensureLocation(id, name, start, end) {
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, ?, 0, ?, 1)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name,
      day_settings_json = excluded.day_settings_json, active = 1
  `).run(id, name, daySettings(start, end));
}

function ensureEmployee(employeeNumber, name, locationId, departmentId, role) {
  const positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get()?.id;
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, position_id,
      home_location_id, preferred_department_id, active
    ) VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, ?, 1)
  `).run(employeeNumber, name, name.split(" ")[0], positionId, locationId, departmentId);
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  if (role === "manager") {
    db.prepare(`
      INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, 'v0921-absence-test')
    `).run(employeeNumber, locationId);
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
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && session?.csrf) {
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

function insertAssignment(id, {
  date,
  allDay = true,
  startTime = null,
  endTime = null,
} = {}) {
  db.prepare(`
    INSERT INTO employee_location_lendings (
      id, employee_number, home_location_id, destination_location_id,
      destination_department_id, date_from, date_to, all_day,
      start_time, end_time, note, status, revision,
      created_by, created_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'active', 1,
      'v0921-absence-test', CURRENT_TIMESTAMP, 'v0921-absence-test', CURRENT_TIMESTAMP)
  `).run(
    id,
    EMPLOYEE,
    HOME,
    DESTINATION,
    destinationDepartment,
    date,
    date,
    allDay ? 1 : 0,
    startTime,
    endTime,
  );
}

test.before(async () => {
  ensureLocation(HOME, "Stammfiliale Abwesenheit", "08:00", "20:00");
  ensureLocation(DESTINATION, "Zielfiliale Abwesenheit", "10:00", "16:00");
  homeDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Stamm-Abteilung', 0, 1, 1)
  `).run(HOME).lastInsertRowid);
  destinationDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Ziel-Abteilung', 0, 1, 1)
  `).run(DESTINATION).lastInsertRowid);
  ensureEmployee(EMPLOYEE, "Emilia Einsatz", HOME, homeDepartment, "employee");
  ensureEmployee(
    OPEN_SICKNESS_EMPLOYEE,
    "Olivia Offene Krankmeldung",
    HOME,
    homeDepartment,
    "employee",
  );
  ensureEmployee(HOME_MANAGER, "Hanna Stammleitung", HOME, homeDepartment, "manager");
  ensureEmployee(DESTINATION_MANAGER, "Dora Zielleitung", DESTINATION, destinationDepartment, "manager");
  ensureEmployee(
    RETRY_DESTINATION_MANAGER,
    "Rita Zielleitung",
    DESTINATION,
    destinationDepartment,
    "manager",
  );
  employeeSession = createSession(EMPLOYEE);
  openSicknessEmployeeSession = createSession(OPEN_SICKNESS_EMPLOYEE);
  homeManagerSession = createSession(HOME_MANAGER);
  destinationManagerSession = createSession(DESTINATION_MANAGER);
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

test("temporäre Filialeinsätze koppeln Urlaub, ZA-Slots, Zuständigkeit und Krankmeldung", async (t) => {
  await t.test("ein aktiver Einsatz blockiert einen neuen Urlaubsantrag", async () => {
    const date = "2031-04-14";
    insertAssignment("v0921-absence-vacation", { date });
    const created = await requestJson("/api/portal/v1/me/vacation-requests", {
      method: "POST",
      session: employeeSession,
      body: { dateFrom: date, dateTo: date, note: "" },
    });
    assert.equal(created.response.status, 409, created.text);
    assert.equal(created.payload.code, "VACATION_EMPLOYEE_LENDING_CONFLICT");
  });

  await t.test("ganztägiger Einsatz verwendet Zielzeiten; Stammleitung liest, Ziel entscheidet", async () => {
    const date = "2031-04-15";
    insertAssignment("v0921-absence-all-day", { date });
    const slotResult = await requestJson(`/api/portal/v1/me/time-off-slots?date=${date}`, {
      session: employeeSession,
    });
    assert.equal(slotResult.response.status, 200, slotResult.text);
    assert.equal(slotResult.payload.start, "10:00");
    assert.equal(slotResult.payload.end, "16:00");
    assert.ok(slotResult.payload.slots.length > 0);
    assert.ok(slotResult.payload.slots.every((slot) => (
      slot.locationId === DESTINATION && slot.temporaryLocationAssignment === true
    )));

    const created = await requestJson("/api/portal/v1/me/time-off-requests", {
      method: "POST",
      session: employeeSession,
      body: { dateFrom: date, dateTo: date, allDay: true, note: "" },
    });
    assert.equal(created.response.status, 201, created.text);
    const requestId = Number(created.payload.id);
    const stored = db.prepare(`
      SELECT location_id, origin_location_id, review_department_id, lending_id,
        traffic_light, check_reason
      FROM time_off_requests WHERE id = ?
    `).get(requestId);
    assert.equal(stored.location_id, DESTINATION);
    assert.equal(stored.origin_location_id, HOME);
    assert.equal(stored.review_department_id, destinationDepartment);
    assert.equal(stored.lending_id, "v0921-absence-all-day");
    assert.equal(stored.traffic_light, created.payload.check.trafficLight);
    assert.equal(stored.check_reason, created.payload.check.reason);
    assert.equal(created.payload.check.trafficLight, "yellow");
    assert.match(created.payload.check.reason, /Dienstplan/);

    const homeView = await requestJson("/api/portal/v1/absence-requests", {
      session: homeManagerSession,
    });
    const targetView = await requestJson("/api/portal/v1/absence-requests", {
      session: destinationManagerSession,
    });
    const homeEntry = homeView.payload.requests.find((entry) => Number(entry.id) === requestId
      && entry.kind === "time_off");
    const targetEntry = targetView.payload.requests.find((entry) => Number(entry.id) === requestId
      && entry.kind === "time_off");
    assert.ok(homeEntry, homeView.text);
    assert.ok(targetEntry, targetView.text);
    assert.equal(homeEntry.capabilities.decide, false);
    assert.equal(targetEntry.capabilities.decide, true);

    const forbidden = await requestJson(`/api/portal/v1/absence-requests/time_off/${requestId}/action`, {
      method: "PUT",
      session: homeManagerSession,
      body: { action: "approve", note: "" },
    });
    assert.equal(forbidden.response.status, 403, forbidden.text);
    const approved = await requestJson(`/api/portal/v1/absence-requests/time_off/${requestId}/action`, {
      method: "PUT",
      session: destinationManagerSession,
      body: { action: "approve", note: "" },
    });
    assert.equal(approved.response.status, 200, approved.text);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM portal_notifications
      WHERE recipient_employee_number = ? AND entity_type = 'time_off' AND entity_id = ?
    `).get(DESTINATION_MANAGER, String(requestId)).count, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM portal_notifications
      WHERE recipient_employee_number = ? AND entity_type = 'time_off' AND entity_id = ?
    `).get(HOME_MANAGER, String(requestId)).count, 0);

    const changed = await requestJson("/api/portal/v1/me/time-off-change-requests", {
      method: "POST",
      session: employeeSession,
      body: {
        requestId,
        requestType: "change",
        dateFrom: date,
        dateTo: date,
        allDay: true,
        note: "",
      },
    });
    assert.equal(changed.response.status, 201, changed.text);
    assert.equal(changed.payload.check.trafficLight, "yellow");
    const storedChange = db.prepare(`
      SELECT location_id, origin_location_id, review_department_id, lending_id
      FROM time_off_change_requests WHERE id = ?
    `).get(Number(changed.payload.id));
    assert.equal(storedChange.location_id, DESTINATION);
    assert.equal(storedChange.origin_location_id, HOME);
    assert.equal(storedChange.review_department_id, destinationDepartment);
    assert.equal(storedChange.lending_id, "v0921-absence-all-day");
    const changeAudit = db.prepare(`
      SELECT detail FROM audit_log
      WHERE action = 'time_off.change.request'
        AND entity_type = 'time_off_change_request'
        AND entity_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(String(changed.payload.id));
    assert.deepEqual(JSON.parse(changeAudit.detail), changed.payload.check);
  });

  await t.test("stundenweise Ziel-Slots werden markiert; gemischter ZA wird fail-closed abgewiesen", async () => {
    const date = "2031-04-16";
    insertAssignment("v0921-absence-hours", {
      date,
      allDay: false,
      startTime: "12:00",
      endTime: "14:00",
    });
    const slotResult = await requestJson(`/api/portal/v1/me/time-off-slots?date=${date}`, {
      session: employeeSession,
    });
    assert.equal(slotResult.response.status, 200, slotResult.text);
    const homeBefore = slotResult.payload.slots.find((slot) => slot.startTime === "11:45");
    const targetDuring = slotResult.payload.slots.find((slot) => slot.startTime === "12:00");
    const homeAfter = slotResult.payload.slots.find((slot) => slot.startTime === "14:00");
    assert.equal(homeBefore.locationId, HOME);
    assert.equal(homeBefore.temporaryLocationAssignment, false);
    assert.equal(targetDuring.locationId, DESTINATION);
    assert.equal(targetDuring.temporaryLocationAssignment, true);
    assert.equal(homeAfter.locationId, HOME);

    const mixed = await requestJson("/api/portal/v1/me/time-off-requests", {
      method: "POST",
      session: employeeSession,
      body: { dateFrom: date, dateTo: date, startTime: "11:00", endTime: "13:00", note: "" },
    });
    assert.equal(mixed.response.status, 409, mixed.text);
    assert.equal(mixed.payload.code, "TIME_OFF_MIXED_RESPONSIBILITY");

    const targetOnly = await requestJson("/api/portal/v1/me/time-off-requests", {
      method: "POST",
      session: employeeSession,
      body: { dateFrom: date, dateTo: date, startTime: "12:15", endTime: "13:00", note: "" },
    });
    assert.equal(targetOnly.response.status, 201, targetOnly.text);
    const stored = db.prepare(`
      SELECT location_id, origin_location_id, review_department_id, lending_id,
        traffic_light, check_reason
      FROM time_off_requests WHERE id = ?
    `).get(Number(targetOnly.payload.id));
    assert.equal(stored.location_id, DESTINATION);
    assert.equal(stored.origin_location_id, HOME);
    assert.equal(stored.review_department_id, destinationDepartment);
    assert.equal(stored.lending_id, "v0921-absence-hours");
    assert.equal(stored.traffic_light, targetOnly.payload.check.trafficLight);
    assert.equal(stored.check_reason, targetOnly.payload.check.reason);
  });

  await t.test("Urlaubsänderung revalidiert den Filialeinsatz im gebundenen Transaktions-Repository", async () => {
    const groupId = "v0921-vacation-change-race";
    const originalFrom = "2031-05-05";
    const originalTo = "2031-05-06";
    const requestedDate = "2031-05-12";
    db.prepare(`
      INSERT INTO week_options (
        employee_number, group_id, week_start, date_from, date_to,
        option_type, note, all_day
      ) VALUES (?, ?, ?, ?, ?, 'vacation', 'Genehmigt', 1)
    `).run(EMPLOYEE, groupId, originalFrom, originalFrom, originalTo);
    db.prepare(`
      INSERT INTO vacation_requests (
        employee_number, location_id, vacation_group_id,
        date_from, date_to, note, status, approval_stage
      ) VALUES (?, ?, ?, ?, ?, 'Genehmigt', 'approved', 'complete')
    `).run(EMPLOYEE, HOME, groupId, originalFrom, originalTo);

    insertAssignment("v0921-vacation-change-race-assignment", { date: requestedDate });

    const changed = await requestJson("/api/portal/v1/me/vacation-change-requests", {
      method: "POST",
      session: employeeSession,
      body: {
        groupId,
        requestType: "change",
        dateFrom: requestedDate,
        dateTo: requestedDate,
        note: "Race-Revalidierung",
      },
    });
    assert.equal(changed.response.status, 409, changed.text);
    assert.equal(changed.payload.code, "VACATION_EMPLOYEE_LENDING_CONFLICT");
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM vacation_change_requests
      WHERE employee_number = ? AND vacation_group_id = ?
    `).get(EMPLOYEE, groupId).count, 0);

    const serverSource = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    const functionStart = serverSource.indexOf("async function createOwnVacationChangeRequest");
    const functionEnd = serverSource.indexOf("async function withdrawOwnVacationChangeRequest", functionStart);
    const functionSource = serverSource.slice(functionStart, functionEnd);
    const transactionStart = functionSource.indexOf("absenceManagementRepository.transaction(async (repository)");
    const boundRevalidation = functionSource.indexOf("assertNoVacationLendingOverlap(", transactionStart);
    const boundRepository = functionSource.indexOf("repository,", boundRevalidation);
    const insert = functionSource.indexOf("repository.insertVacationChange", transactionStart);
    assert.ok(transactionStart >= 0, "Urlaubsänderung muss transaktional gespeichert werden");
    assert.ok(boundRevalidation > transactionStart, "Filialeinsatz muss in der Transaktion revalidiert werden");
    assert.ok(boundRepository > boundRevalidation, "Revalidierung muss das gebundene Repository verwenden");
    assert.ok(insert > boundRepository, "Revalidierung muss vor dem Insert erfolgen");
  });

  await t.test("eine ZA-Aenderung speichert Zuständigkeit und Prüfung aus derselben Transaktion", async () => {
    const date = "2031-04-17";
    const created = await requestJson("/api/portal/v1/me/time-off-requests", {
      method: "POST",
      session: employeeSession,
      body: { dateFrom: date, dateTo: date, allDay: true, note: "" },
    });
    assert.equal(created.response.status, 201, created.text);
    assert.equal(db.prepare("SELECT location_id FROM time_off_requests WHERE id = ?")
      .get(Number(created.payload.id)).location_id, HOME);

    // Simuliert eine nach der Erstanlage geänderte Filialzuständigkeit. Der PUT
    // muss Kontext und fachliche ZA-Prüfung innerhalb seiner Transaktion neu binden.
    insertAssignment("v0921-absence-update-context", { date });
    const updated = await requestJson(`/api/portal/v1/me/time-off-requests/${created.payload.id}`, {
      method: "PUT",
      session: employeeSession,
      body: { dateFrom: date, dateTo: date, allDay: true, note: "aktualisiert" },
    });
    assert.equal(updated.response.status, 200, updated.text);
    const stored = db.prepare(`
      SELECT location_id, origin_location_id, review_department_id, lending_id,
        traffic_light, check_reason
      FROM time_off_requests WHERE id = ?
    `).get(Number(created.payload.id));
    assert.equal(stored.location_id, DESTINATION);
    assert.equal(stored.origin_location_id, HOME);
    assert.equal(stored.review_department_id, destinationDepartment);
    assert.equal(stored.lending_id, "v0921-absence-update-context");
    assert.equal(stored.traffic_light, updated.payload.check.trafficLight);
    assert.equal(stored.check_reason, updated.payload.check.reason);
  });

  await t.test("Krankmeldung wird Stamm- und Zielverantwortung sichtbar gemeldet", async () => {
    const date = "2031-04-01";
    insertAssignment("v0921-absence-sickness", { date });
    const created = await requestJson("/api/portal/v1/me/sickness-cases", {
      method: "POST",
      session: employeeSession,
      body: { startDate: date, expectedEnd: date, note: "" },
    });
    assert.equal(created.response.status, 201, created.text);
    const caseId = Number(created.payload.case.id);
    const homeView = await requestJson("/api/portal/v1/sickness-cases", {
      session: homeManagerSession,
    });
    const targetView = await requestJson("/api/portal/v1/sickness-cases", {
      session: destinationManagerSession,
    });
    assert.ok(homeView.payload.cases.some((entry) => Number(entry.id) === caseId), homeView.text);
    assert.ok(targetView.payload.cases.some((entry) => Number(entry.id) === caseId), targetView.text);
    for (const recipient of [HOME_MANAGER, DESTINATION_MANAGER]) {
      assert.ok(db.prepare(`
        SELECT COUNT(*) AS count FROM portal_notifications
        WHERE recipient_employee_number = ? AND event_type = 'protected.update'
      `).get(recipient).count >= 1);
    }
  });

  await t.test("offene Krankmeldung meldet einen spaeter hinzukommenden Zielkontext genau einmal", async () => {
    const notificationCount = (recipient) => Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM portal_notifications
      WHERE recipient_employee_number = ? AND event_type = 'protected.update'
    `).get(recipient).count || 0);
    const homeBefore = notificationCount(HOME_MANAGER);
    const targetBefore = notificationCount(DESTINATION_MANAGER);
    const retryTargetBefore = notificationCount(RETRY_DESTINATION_MANAGER);
    const outboundBefore = Number(db.prepare(
      "SELECT COUNT(*) AS count FROM outbound_notification_jobs",
    ).get().count || 0);
    const created = await requestJson("/api/portal/v1/me/sickness-cases", {
      method: "POST",
      session: openSicknessEmployeeSession,
      body: { startDate: "2031-04-01", expectedEnd: "", note: "" },
    });
    assert.equal(created.response.status, 201, created.text);
    assert.equal(created.payload.case.staffing_risk.atRisk, false);
    const caseId = Number(created.payload.case.id);
    assert.equal(notificationCount(HOME_MANAGER), homeBefore + 1);
    assert.equal(notificationCount(DESTINATION_MANAGER), targetBefore);

    db.prepare(`
      INSERT INTO employee_location_lendings (
        id, employee_number, home_location_id, destination_location_id,
        destination_department_id, date_from, date_to, all_day,
        start_time, end_time, note, status, revision,
        created_by, created_at, updated_by, updated_at
      ) VALUES (
        'v0921-open-sickness-next-day', ?, ?, ?, ?, '2031-04-02', '2031-04-02', 1,
        NULL, NULL, '', 'active', 1,
        'v0921-absence-test', CURRENT_TIMESTAMP, 'v0921-absence-test', CURRENT_TIMESTAMP
      )
    `).run(OPEN_SICKNESS_EMPLOYEE, HOME, DESTINATION, destinationDepartment);

    const sweepAtTargetDay = new Date("2031-04-02T10:00:00+02:00");
    db.exec(`
      CREATE TRIGGER v0921_fail_second_context_notification
      BEFORE INSERT ON portal_notifications
      WHEN NEW.recipient_employee_number = '${RETRY_DESTINATION_MANAGER}'
        AND NEW.event_type = 'protected.update'
      BEGIN
        SELECT RAISE(ABORT, 'TEST_CONTEXT_NOTIFICATION_FAILURE');
      END
    `);
    try {
      await assert.rejects(runSicknessEscalationSweep(sweepAtTargetDay));
    } finally {
      db.exec("DROP TRIGGER IF EXISTS v0921_fail_second_context_notification");
    }
    assert.equal(notificationCount(HOME_MANAGER), homeBefore + 1);
    assert.equal(notificationCount(DESTINATION_MANAGER), targetBefore + 1);
    assert.equal(notificationCount(RETRY_DESTINATION_MANAGER), retryTargetBefore);

    await runSicknessEscalationSweep(sweepAtTargetDay);
    assert.equal(notificationCount(HOME_MANAGER), homeBefore + 1);
    assert.equal(notificationCount(DESTINATION_MANAGER), targetBefore + 1);
    assert.equal(notificationCount(RETRY_DESTINATION_MANAGER), retryTargetBefore + 1);
    const homeView = await requestJson("/api/portal/v1/sickness-cases", {
      session: homeManagerSession,
    });
    const targetView = await requestJson("/api/portal/v1/sickness-cases", {
      session: destinationManagerSession,
    });
    assert.ok(homeView.payload.cases.some((entry) => Number(entry.id) === caseId), homeView.text);
    assert.ok(targetView.payload.cases.some((entry) => Number(entry.id) === caseId), targetView.text);

    await runSicknessEscalationSweep(sweepAtTargetDay);
    assert.equal(notificationCount(HOME_MANAGER), homeBefore + 1);
    assert.equal(notificationCount(DESTINATION_MANAGER), targetBefore + 1);
    assert.equal(notificationCount(RETRY_DESTINATION_MANAGER), retryTargetBefore + 1);
    assert.equal(Number(db.prepare(
      "SELECT COUNT(*) AS count FROM outbound_notification_jobs",
    ).get().count || 0), outboundBefore);
  });
});
