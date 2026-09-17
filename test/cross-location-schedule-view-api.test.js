"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openSqliteLegacyDatabase } = require("../lib/persistence/sqlite/provider");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-cross-schedule-view-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_TODAY = "2026-08-19";
process.env.GRABENPLANER_TEST_REQUEST_TIME = "10:00:00";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db } = subject;
const {
  staffAssignmentRequestAssignmentId,
} = require("../lib/staff-assignment-request-fulfillment");

const MANAGER = "cross-view-manager";
const HR = "cross-view-hr";
const EMPLOYEE = "cross-view-employee";
const FOREIGN_EMPLOYEE = "cross-view-foreign";
const FOREIGN_LOCATION = "95";
const INACTIVE_LOCATION = "96";
const CURRENT_WEEK = "2026-08-17";
const NEXT_WEEK = "2026-08-24";

let httpServer;
let baseUrl;
let homeLocation;
let homeDepartment;
let foreignDepartment;
let positionId;
let block12LoadRequestIds = [];

function insertEmployee(employeeNumber, nickname, locationId, departmentId = null) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, position_id, active
    ) VALUES (?, ?, ?, '#aabbcc', 38.5, 5, '', ?, ?, ?, 1)
  `).run(employeeNumber, `Vertraulicher Vollname ${employeeNumber}`, nickname,
    locationId, departmentId, positionId);
}

function insertPortalUser(employeeNumber, role) {
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
}

function session(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return `grabenplaner_session=${token}`;
}

async function request(route, cookie = "") {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

async function mutate(route, cookie, body) {
  const csrf = crypto.randomBytes(24).toString("hex");
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      Cookie: `${cookie}; grabenplaner_csrf=${csrf}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

async function mutateWithMethod(route, cookie, body, method = "PUT") {
  const csrf = crypto.randomBytes(24).toString("hex");
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      Cookie: `${cookie}; grabenplaner_csrf=${csrf}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

async function mutateWithoutCsrf(route, cookie, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

test.before(async () => {
  homeLocation = String(db.prepare(`
    SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1
  `).get().id);
  positionId = String(db.prepare("SELECT id FROM positions ORDER BY id LIMIT 1").get().id);
  const daySettings = JSON.stringify({});
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Filiale 95 Privat', 1, ?, 1)
  `).run(FOREIGN_LOCATION, daySettings);
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Inaktive Filiale', 1, ?, 0)
  `).run(INACTIVE_LOCATION, daySettings);
  foreignDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Fotowelt', 1, 1, 1)
  `).run(FOREIGN_LOCATION).lastInsertRowid);
  homeDepartment = Number(db.prepare(`
    SELECT id FROM departments WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 1
  `).get(homeLocation)?.id || 0);
  if (!homeDepartment) {
    homeDepartment = Number(db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Fotowelt Ziel', 1, 1, 1)
    `).run(homeLocation).lastInsertRowid);
  }
  insertEmployee(MANAGER, "Leitung 18", homeLocation);
  insertEmployee(HR, "Personalleitung", homeLocation);
  insertEmployee(EMPLOYEE, "Ohne Fremdrecht", homeLocation);
  insertEmployee(FOREIGN_EMPLOYEE, "Nicolai", FOREIGN_LOCATION, foreignDepartment);
  insertPortalUser(MANAGER, "manager");
  insertPortalUser(HR, "hr");
  insertPortalUser(EMPLOYEE, "employee");
  insertPortalUser(FOREIGN_EMPLOYEE, "manager");
  db.prepare(`
    INSERT INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES (?, ?, 0, ?)
  `).run(MANAGER, homeLocation, MANAGER);
  db.prepare(`
    INSERT INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES (?, ?, 0, ?)
  `).run(FOREIGN_EMPLOYEE, FOREIGN_LOCATION, FOREIGN_EMPLOYEE);
  db.prepare(`
    INSERT INTO shifts (
      employee_number, location_id, department_id, shift_date,
      start_time, end_time, area, note
    ) VALUES (?, ?, ?, '2026-08-27', '09:00', '18:00', 'Fotowelt', 'Geheime Dienstnotiz')
  `).run(FOREIGN_EMPLOYEE, FOREIGN_LOCATION, foreignDepartment);
  db.prepare(`
    INSERT INTO week_options (
      employee_number, week_start, date_from, date_to, option_type,
      note, credited_minutes_per_day, all_day
    ) VALUES (?, ?, '2026-08-28', '2026-08-28', 'vacation',
      'Vertraulicher Abwesenheitsgrund', 462, 1)
  `).run(FOREIGN_EMPLOYEE, NEXT_WEEK);
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Block 2 API: fremde Filialen und Wochenhorizont sind strikt begrenzt", async () => {
  const auth = session(MANAGER);
  const result = await request(
    `/api/portal/v1/cross-location-schedules?locationId=${FOREIGN_LOCATION}&week=${NEXT_WEEK}`,
    auth,
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.mode, "foreign_read_only");
  assert.deepEqual(result.payload.weeks, [
    { weekStart: CURRENT_WEEK, weekEnd: "2026-08-23", calendarWeek: 34 },
    { weekStart: NEXT_WEEK, weekEnd: "2026-08-30", calendarWeek: 35 },
  ]);
  assert.equal(result.payload.locations.some((location) => location.id === homeLocation), false);
  assert.equal(result.payload.locations.some((location) => location.id === INACTIVE_LOCATION), false);
  assert.deepEqual(
    result.payload.locations.find((location) => location.id === FOREIGN_LOCATION),
    {
      id: FOREIGN_LOCATION,
      name: "Filiale 95 Privat",
      departments: [{ id: foreignDepartment, name: "Fotowelt" }],
    },
  );
  assert.equal(result.payload.requestDestination.id, homeLocation);
  assert.equal(result.payload.requestDestination.departments.some(
    (department) => department.id === homeDepartment,
  ), true);
});

test("Block 7 API: nur PL+ mit Einstellungsrecht kann den Dienstplanvertrag revisionssicher ändern", async () => {
  const managerRead = await request(
    "/api/portal/v1/cross-location-schedule-settings",
    session(MANAGER),
  );
  assert.equal(managerRead.response.status, 403, JSON.stringify(managerRead.payload));

  const initial = await request(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
  );
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  assert.deepEqual(initial.payload, {
    enabled: true,
    horizonWeeks: 2,
    managerRequestCreateEnabled: true,
    departmentManagerRequestCreateEnabled: false,
    departmentManagerRequestReviewEnabled: false,
    emailSubmittedEnabled: true,
    emailDecisionEnabled: true,
    changePolicy: "withdraw_and_resubmit",
    cancellationPolicy: "source_review",
  });

  const missingCsrf = await fetch(`${baseUrl}/api/portal/v1/cross-location-schedule-settings`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: session(HR),
    },
    body: JSON.stringify(initial.payload),
  });
  assert.equal(missingCsrf.status, 403);

  const changed = await mutateWithMethod(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
    {
      ...initial.payload,
      horizonWeeks: 1,
      managerRequestCreateEnabled: false,
      emailSubmittedEnabled: false,
      emailDecisionEnabled: false,
      changePolicy: "locked",
      cancellationPolicy: "pl_plus_only",
    },
  );
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.horizonWeeks, 1);
  assert.equal(changed.payload.managerRequestCreateEnabled, false);
  assert.equal(changed.payload.changePolicy, "locked");
  assert.equal(db.prepare(`
    SELECT value FROM settings WHERE key = 'cross_location_schedule_horizon_weeks'
  `).get().value, "1");
  const audit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE actor = ? AND action = 'schedule.cross-location.settings.update'
    ORDER BY rowid DESC LIMIT 1
  `).get(HR);
  assert.ok(audit);
  const detail = JSON.parse(audit.detail);
  assert.equal(detail.before.horizonWeeks, 2);
  assert.equal(detail.after.horizonWeeks, 1);
  assert.ok(detail.changedKeys.includes("cross_location_schedule_horizon_weeks"));

  const horizonDenied = await request(
    `/api/portal/v1/cross-location-schedules?locationId=${FOREIGN_LOCATION}&week=${NEXT_WEEK}`,
    session(MANAGER),
  );
  assert.equal(horizonDenied.response.status, 400, JSON.stringify(horizonDenied.payload));
  assert.equal(horizonDenied.payload.code, "CROSS_LOCATION_SCHEDULE_WEEK_DENIED");
  const requestDenied = await mutate(
    "/api/portal/v1/staff-assignment-requests",
    session(MANAGER),
    {
      sourceLocationId: FOREIGN_LOCATION,
      destinationDepartmentId: homeDepartment,
      periodStartDate: "2026-08-20",
      periodEndDate: "2026-08-20",
      timeKind: "full_day",
      preferredEmployeeNumber: FOREIGN_EMPLOYEE,
      requestReason: "Die deaktivierte FL-Regel muss serverseitig greifen",
    },
  );
  assert.equal(requestDenied.response.status, 403, JSON.stringify(requestDenied.payload));
  assert.equal(requestDenied.payload.code, "STAFF_ASSIGNMENT_REQUEST_SCOPE_DENIED");

  const restored = await mutateWithMethod(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
    initial.payload,
  );
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.deepEqual(restored.payload, initial.payload);
});

test("Block 7 API: ungültige Richtlinien werden ohne Teiländerung abgewiesen", async () => {
  const before = db.prepare(`
    SELECT value FROM settings WHERE key = 'staff_assignment_request_cancellation_policy'
  `).get().value;
  const result = await mutateWithMethod(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
    {
      enabled: true,
      horizonWeeks: 2,
      managerRequestCreateEnabled: true,
      departmentManagerRequestCreateEnabled: false,
      departmentManagerRequestReviewEnabled: false,
      emailSubmittedEnabled: true,
      emailDecisionEnabled: true,
      changePolicy: "still_überschreiben",
      cancellationPolicy: "beliebig",
    },
  );
  assert.equal(result.response.status, 400, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "CROSS_LOCATION_SCHEDULE_SETTINGS_INVALID");
  assert.equal(db.prepare(`
    SELECT value FROM settings WHERE key = 'staff_assignment_request_cancellation_policy'
  `).get().value, before);
});

test("Block 7 API: Auditfehler rollt die Dienstplan-Einstellungen vollständig zurück", async () => {
  const initial = (await request(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
  )).payload;
  const before = db.prepare(`
    SELECT value FROM settings WHERE key = 'staff_assignment_request_change_policy'
  `).get().value;
  db.exec(`
    CREATE TRIGGER test_cross_location_schedule_settings_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'schedule.cross-location.settings.update'
    BEGIN
      SELECT RAISE(ABORT, 'test cross-location schedule settings audit failure');
    END
  `);
  try {
    const result = await mutateWithMethod(
      "/api/portal/v1/cross-location-schedule-settings",
      session(HR),
      {
        ...initial,
        changePolicy: initial.changePolicy === "locked" ? "withdraw_and_resubmit" : "locked",
      },
    );
    assert.equal(result.response.status, 500, JSON.stringify(result.payload));
    assert.equal(db.prepare(`
      SELECT value FROM settings WHERE key = 'staff_assignment_request_change_policy'
    `).get().value, before);
  } finally {
    db.exec("DROP TRIGGER test_cross_location_schedule_settings_audit_abort");
  }
});

test("Block 7 API: deaktivierte Eingangs-E-Mail wird nicht versendet und neutral auditiert", async () => {
  const initial = (await request(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
  )).payload;
  const disabled = await mutateWithMethod(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
    { ...initial, emailSubmittedEnabled: false },
  );
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  try {
    const submitted = await mutate(
      "/api/portal/v1/staff-assignment-requests",
      session(MANAGER),
      {
        sourceLocationId: FOREIGN_LOCATION,
        destinationDepartmentId: homeDepartment,
        periodStartDate: "2026-08-21",
        periodEndDate: "2026-08-21",
        timeKind: "full_day",
        preferredEmployeeNumber: FOREIGN_EMPLOYEE,
        requestReason: "Benachrichtigungsschalter serverseitig prüfen",
      },
    );
    assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
    const emailAudit = db.prepare(`
      SELECT detail FROM audit_log
      WHERE action = 'staff-assignment-request.email' AND entity_id = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(submitted.payload.request.id);
    assert.ok(emailAudit);
    const detail = JSON.parse(emailAudit.detail);
    assert.equal(detail.kind, "submitted");
    assert.deepEqual(detail.failureCodes, ["disabled_by_schedule_settings"]);
    assert.equal(detail.delivered, 0);
    assert.equal(detail.failed, 0);
  } finally {
    const restored = await mutateWithMethod(
      "/api/portal/v1/cross-location-schedule-settings",
      session(HR),
      initial,
    );
    assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  }
});

test("Block 7 API: deaktivierte Entscheidungs-E-Mail wird nicht versendet und neutral auditiert", async () => {
  const initial = (await request(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
  )).payload;
  const disabled = await mutateWithMethod(
    "/api/portal/v1/cross-location-schedule-settings",
    session(HR),
    { ...initial, emailDecisionEnabled: false },
  );
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  try {
    const submitted = await mutate(
      "/api/portal/v1/staff-assignment-requests",
      session(MANAGER),
      {
        sourceLocationId: FOREIGN_LOCATION,
        destinationDepartmentId: homeDepartment,
        periodStartDate: "2026-08-23",
        periodEndDate: "2026-08-23",
        timeKind: "full_day",
        preferredEmployeeNumber: FOREIGN_EMPLOYEE,
        requestReason: "Entscheidungsbenachrichtigung serverseitig prüfen",
      },
    );
    assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
    const requestId = submitted.payload.request.id;
    const rejected = await mutateWithMethod(
      `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
      session(FOREIGN_EMPLOYEE),
      {
        decision: "rejected",
        expectedRevision: 2,
        decisionReason: "Nur für den Benachrichtigungstest",
      },
    );
    assert.equal(rejected.response.status, 200, JSON.stringify(rejected.payload));
    const emailAudit = db.prepare(`
      SELECT detail FROM audit_log
      WHERE action = 'staff-assignment-request.email' AND entity_id = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(requestId);
    assert.ok(emailAudit);
    const detail = JSON.parse(emailAudit.detail);
    assert.equal(detail.kind, "rejected");
    assert.deepEqual(detail.failureCodes, ["disabled_by_schedule_settings"]);
    assert.equal(detail.delivered, 0);
    assert.equal(detail.failed, 0);
  } finally {
    const restored = await mutateWithMethod(
      "/api/portal/v1/cross-location-schedule-settings",
      session(HR),
      initial,
    );
    assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  }
});

test("Block 2 API: Antwort enthält nur Planungs-Minimaldaten und neutrale Nichtverfügbarkeit", async () => {
  const result = await request(
    `/api/portal/v1/cross-location-schedules?locationId=${FOREIGN_LOCATION}&week=${NEXT_WEEK}`,
    session(MANAGER),
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const schedule = result.payload.schedule;
  assert.deepEqual(Object.keys(schedule).sort(), [
    "departments", "location", "mode", "privacy", "requestContext", "shifts",
    "teamMembers", "unavailability", "weekEnd", "weekStart",
  ].sort());
  assert.deepEqual(schedule.teamMembers, [{
    employeeNumber: FOREIGN_EMPLOYEE,
    displayName: "Nicolai",
    departmentId: foreignDepartment,
    departmentName: "Fotowelt",
    color: "#aabbcc",
    requestEligible: true,
  }]);
  assert.deepEqual(schedule.shifts, [{
    employeeNumber: FOREIGN_EMPLOYEE,
    date: "2026-08-27",
    startTime: "09:00",
    endTime: "18:00",
    departmentId: foreignDepartment,
    departmentName: "Fotowelt",
  }]);
  assert.deepEqual(schedule.unavailability, [{
    employeeNumber: FOREIGN_EMPLOYEE,
    dateFrom: "2026-08-28",
    dateTo: "2026-08-28",
    allDay: true,
    startTime: null,
    endTime: null,
    unavailable: true,
  }]);
  const serialized = JSON.stringify(result.payload);
  for (const forbidden of [
    "Vertraulicher Vollname", "Geheime Dienstnotiz", "Vertraulicher Abwesenheitsgrund",
    '"weeklyHours":', '"workRuleChecks":', '"timeBalances":', '"contractedHours":',
    "option_type", "credited_minutes_per_day",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_log
    WHERE actor = ? AND action = 'schedule.cross-location.view'
      AND entity_id = ?
  `).get(MANAGER, FOREIGN_LOCATION));
});

test("Block 4 API: Dialogeinreichung bindet Zielscope und erzeugt atomar zwei Revisionen", async () => {
  const result = await mutate(
    "/api/portal/v1/staff-assignment-requests",
    session(MANAGER),
    {
      sourceLocationId: FOREIGN_LOCATION,
      destinationLocationId: FOREIGN_LOCATION,
      destinationDepartmentId: homeDepartment,
      periodStartDate: "2026-08-27",
      periodEndDate: "2026-08-27",
      timeKind: "full_day",
      preferredEmployeeNumber: FOREIGN_EMPLOYEE,
      requestReason: "Unterstützung für Fotowelt am Donnerstag",
    },
  );
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.deepEqual(result.payload.request, {
    id: result.payload.request.id,
    status: "submitted",
    revisionNumber: 2,
    sourceLocationId: FOREIGN_LOCATION,
    destinationLocationId: homeLocation,
    destinationDepartmentId: homeDepartment,
    periodStartDate: "2026-08-27",
    periodEndDate: "2026-08-27",
    timeKind: "full_day",
    startTime: null,
    endTime: null,
    preferredEmployeeNumber: FOREIGN_EMPLOYEE,
  });
  assert.deepEqual(db.prepare(`
    SELECT status, destination_location_id, destination_department_id
    FROM staff_assignment_request_revisions
    WHERE request_id = ? ORDER BY revision_number
  `).all(result.payload.request.id).map((row) => ({ ...row })), [
    { status: "draft", destination_location_id: homeLocation, destination_department_id: homeDepartment },
    { status: "submitted", destination_location_id: homeLocation, destination_department_id: homeDepartment },
  ]);
  assert.deepEqual(db.prepare(`
    SELECT event_type FROM staff_assignment_request_events
    WHERE request_id = ? ORDER BY sequence_number
  `).all(result.payload.request.id).map((row) => row.event_type), ["created", "submitted"]);
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_log
    WHERE actor = ? AND action = 'staff-assignment-request.submit'
      AND entity_id = ?
  `).get(MANAGER, result.payload.request.id));
});

test("Block 4 API: stundenweise und mehrtägige Zeitraumvarianten bleiben revisionsgebunden", async () => {
  for (const variant of [
    {
      periodStartDate: "2026-08-27",
      periodEndDate: "2026-08-27",
      timeKind: "hourly",
      startTime: "13:00",
      endTime: "17:30",
    },
    {
      periodStartDate: "2026-08-27",
      periodEndDate: "2026-08-29",
      timeKind: "multi_day",
      startTime: null,
      endTime: null,
    },
  ]) {
    const result = await mutate(
      "/api/portal/v1/staff-assignment-requests",
      session(MANAGER),
      {
        sourceLocationId: FOREIGN_LOCATION,
        destinationDepartmentId: homeDepartment,
        preferredEmployeeNumber: FOREIGN_EMPLOYEE,
        requestReason: "Zeitlich begrenzte Unterstützung in der Fotowelt",
        ...variant,
      },
    );
    assert.equal(result.response.status, 201, JSON.stringify(result.payload));
    assert.equal(result.payload.request.status, "submitted");
    assert.equal(result.payload.request.timeKind, variant.timeKind);
    assert.equal(result.payload.request.periodStartDate, variant.periodStartDate);
    assert.equal(result.payload.request.periodEndDate, variant.periodEndDate);
    assert.equal(result.payload.request.startTime, variant.startTime);
    assert.equal(result.payload.request.endTime, variant.endTime);
    const persisted = db.prepare(`
      SELECT time_kind, period_start_date, period_end_date, start_time, end_time
      FROM staff_assignment_request_revisions
      WHERE request_id = ? AND revision_number = 2
    `).get(result.payload.request.id);
    assert.deepEqual({ ...persisted }, {
      time_kind: variant.timeKind,
      period_start_date: variant.periodStartDate,
      period_end_date: variant.periodEndDate,
      start_time: variant.startTime,
      end_time: variant.endTime,
    });
  }
});

test("Block 4 API: Einreichung verlangt persönliche Berechtigung und gültiges CSRF", async () => {
  const body = {
    sourceLocationId: FOREIGN_LOCATION,
    destinationDepartmentId: homeDepartment,
    periodStartDate: "2026-08-27",
    periodEndDate: "2026-08-27",
    timeKind: "full_day",
    preferredEmployeeNumber: FOREIGN_EMPLOYEE,
    requestReason: "Unterstützung für Fotowelt am Donnerstag",
  };
  const before = db.prepare("SELECT COUNT(*) AS count FROM staff_assignment_requests").get().count;
  const anonymous = await mutateWithoutCsrf(
    "/api/portal/v1/staff-assignment-requests",
    "",
    body,
  );
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));

  const employee = await mutate(
    "/api/portal/v1/staff-assignment-requests",
    session(EMPLOYEE),
    body,
  );
  assert.equal(employee.response.status, 403, JSON.stringify(employee.payload));
  assert.equal(employee.payload.code, "PORTAL_PERMISSION_DENIED");

  const missingCsrf = await mutateWithoutCsrf(
    "/api/portal/v1/staff-assignment-requests",
    session(MANAGER),
    body,
  );
  assert.equal(missingCsrf.response.status, 403, JSON.stringify(missingCsrf.payload));
  assert.equal(missingCsrf.payload.code, "PORTAL_CSRF_INVALID");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_assignment_requests").get().count, before);
});

test("Block 4 API: fremde Zielabteilung, fremdes Wunsch-Teammitglied und ferner Zeitraum scheitern geschlossen", async () => {
  const before = db.prepare("SELECT COUNT(*) AS count FROM staff_assignment_requests").get().count;
  for (const [patch, expectedStatus, expectedCode] of [
    [{ destinationDepartmentId: foreignDepartment }, 409, "STAFF_ASSIGNMENT_REQUEST_TOPOLOGY_CHANGED"],
    [{ preferredEmployeeNumber: MANAGER }, 409, "STAFF_ASSIGNMENT_REQUEST_PREFERRED_EMPLOYEE_INVALID"],
    [{ periodStartDate: "2027-02-20", periodEndDate: "2027-02-20" }, 400, "STAFF_ASSIGNMENT_REQUEST_PERIOD_OUT_OF_RANGE"],
  ]) {
    const result = await mutate(
      "/api/portal/v1/staff-assignment-requests",
      session(MANAGER),
      {
        sourceLocationId: FOREIGN_LOCATION,
        destinationDepartmentId: homeDepartment,
        periodStartDate: "2026-08-27",
        periodEndDate: "2026-08-27",
        timeKind: "full_day",
        preferredEmployeeNumber: FOREIGN_EMPLOYEE,
        requestReason: "Unterstützung für Fotowelt am Donnerstag",
        ...patch,
      },
    );
    assert.equal(result.response.status, expectedStatus, JSON.stringify(result.payload));
    assert.equal(result.payload.code, expectedCode);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_assignment_requests").get().count, before);
});

test("Einsatzanfragen: sechs Monate einschließlich Grenztag, unabhängig vom Anzeigehorizont", async () => {
  const auth = session(MANAGER);
  const view = await request(`/api/portal/v1/cross-location-schedules?locationId=${FOREIGN_LOCATION}`, auth);
  assert.equal(view.response.status,200,JSON.stringify(view.payload));
  assert.equal(view.payload.requestPeriod.minimum,"2026-08-19");
  assert.equal(view.payload.requestPeriod.maximum,"2027-02-19");
  for (const [from,to] of [["2026-08-31","2026-08-31"],["2027-02-19","2027-02-19"],["2026-11-01","2026-12-10"]]) {
    const result=await mutate('/api/portal/v1/staff-assignment-requests',auth,{
      sourceLocationId:FOREIGN_LOCATION,destinationDepartmentId:homeDepartment,periodStartDate:from,periodEndDate:to,
      timeKind:from===to?'full_day':'multi_day',preferredEmployeeNumber:FOREIGN_EMPLOYEE,requestReason:'Synthetische langfristige Anfrage',
    });
    assert.equal(result.response.status,201,JSON.stringify(result.payload));
  }
});

test("Block 6 API: Genehmigung bindet Anfrage und temporären Filialeinsatz atomar", async () => {
  const submitted = await mutate(
    "/api/portal/v1/staff-assignment-requests",
    session(MANAGER),
    {
      sourceLocationId: FOREIGN_LOCATION,
      destinationDepartmentId: homeDepartment,
      periodStartDate: "2026-08-26",
      periodEndDate: "2026-08-26",
      timeKind: "full_day",
      preferredEmployeeNumber: FOREIGN_EMPLOYEE,
      requestReason: "Unterstützung für Fotowelt am Donnerstag",
    },
  );
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
  const requestId = submitted.payload.request.id;

  const review = await request(
    "/api/portal/v1/staff-assignment-requests",
    session(FOREIGN_EMPLOYEE),
  );
  assert.equal(review.response.status, 200, JSON.stringify(review.payload));
  const item = review.payload.requests.find((entry) => entry.id === requestId);
  assert.ok(item);
  assert.equal(item.sourceLocation.id, FOREIGN_LOCATION);
  assert.equal(item.destinationLocation.id, homeLocation);
  assert.equal(item.destinationDepartment.id, homeDepartment);
  assert.equal(item.requestedBy.employeeNumber, MANAGER);
  assert.equal(item.requestReason, "Unterstützung für Fotowelt am Donnerstag");
  assert.deepEqual(item.preferredEmployee, {
    employeeNumber: FOREIGN_EMPLOYEE,
    displayName: "Nicolai",
    departmentId: foreignDepartment,
  });
  assert.deepEqual(item.candidates, [{
    employeeNumber: FOREIGN_EMPLOYEE,
    displayName: "Nicolai",
    departmentId: foreignDepartment,
    departmentName: "Fotowelt",
  }]);
  assert.doesNotMatch(JSON.stringify(item), /Vertraulicher Vollname|Geheime Dienstnotiz|Abwesenheitsgrund/);

  const lendingCount = db.prepare("SELECT COUNT(*) AS count FROM employee_location_lendings").get().count;
  const assignmentId = staffAssignmentRequestAssignmentId(requestId);
  const accepted = await mutateWithMethod(
    `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
    session(FOREIGN_EMPLOYEE),
    {
      decision: "accepted",
      expectedRevision: item.revisionNumber,
      confirmedEmployeeNumber: FOREIGN_EMPLOYEE,
      decisionReason: "Einsatz organisatorisch geprüft",
    },
  );
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.payload));
  assert.deepEqual(accepted.payload.request, {
    id: requestId,
    status: "accepted",
    revisionNumber: 3,
    confirmedEmployeeNumber: FOREIGN_EMPLOYEE,
    decisionReason: "Einsatz organisatorisch geprüft",
    assignmentId,
  });
  assert.deepEqual({ ...db.prepare(`
    SELECT status, confirmed_employee_number, decision_reason
    FROM staff_assignment_request_revisions
    WHERE request_id = ? AND revision_number = 3
  `).get(requestId) }, {
    status: "accepted",
    confirmed_employee_number: FOREIGN_EMPLOYEE,
    decision_reason: "Einsatz organisatorisch geprüft",
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM employee_location_lendings").get().count, lendingCount + 1);
  assert.deepEqual({ ...db.prepare(`
    SELECT id, employee_number, home_location_id, destination_location_id,
      destination_department_id, date_from, date_to, all_day, start_time,
      end_time, status, revision
    FROM employee_location_lendings WHERE id = ?
  `).get(assignmentId) }, {
    id: assignmentId,
    employee_number: FOREIGN_EMPLOYEE,
    home_location_id: FOREIGN_LOCATION,
    destination_location_id: homeLocation,
    destination_department_id: homeDepartment,
    date_from: "2026-08-26",
    date_to: "2026-08-26",
    all_day: 1,
    start_time: null,
    end_time: null,
    status: "active",
    revision: 1,
  });
  const destinationSchedule = await request(
    `/api/schedule?week=${NEXT_WEEK}&location=${homeLocation}&department=${homeDepartment}`,
    session(MANAGER),
  );
  assert.equal(destinationSchedule.response.status, 200, JSON.stringify(destinationSchedule.payload));
  assert.ok(destinationSchedule.payload.employees.some(
    (employee) => employee.personnel_number === FOREIGN_EMPLOYEE,
  ));
  assert.ok(destinationSchedule.payload.staffAssignments.some(
    (assignment) => assignment.id === assignmentId,
  ));
  const assignmentManagement = await request(
    "/api/portal/v1/staff-assignments?from=2026-08-26&to=2026-08-26",
    session(FOREIGN_EMPLOYEE),
  );
  assert.equal(assignmentManagement.response.status, 200, JSON.stringify(assignmentManagement.payload));
  assert.deepEqual(
    assignmentManagement.payload.assignments.find((assignment) => assignment.id === assignmentId),
    {
      ...assignmentManagement.payload.assignments.find((assignment) => assignment.id === assignmentId),
      requestBound: true,
      canEdit: false,
    },
  );
  const forbiddenChange = await mutateWithMethod(
    `/api/portal/v1/staff-assignments/${encodeURIComponent(assignmentId)}`,
    session(FOREIGN_EMPLOYEE),
    { revision: 1 },
  );
  assert.equal(forbiddenChange.response.status, 409, JSON.stringify(forbiddenChange.payload));
  assert.equal(forbiddenChange.payload.code, "STAFF_ASSIGNMENT_REQUEST_BOUND");
  const forbiddenCancellation = await mutate(
    `/api/portal/v1/staff-assignments/${encodeURIComponent(assignmentId)}/cancel`,
    session(FOREIGN_EMPLOYEE),
    { revision: 1 },
  );
  assert.equal(
    forbiddenCancellation.response.status,
    409,
    JSON.stringify(forbiddenCancellation.payload),
  );
  assert.equal(forbiddenCancellation.payload.code, "STAFF_ASSIGNMENT_REQUEST_BOUND");
  const acceptedAudit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE actor = ? AND action = 'staff-assignment-request.accepted'
      AND entity_id = ?
  `).get(FOREIGN_EMPLOYEE, requestId);
  assert.ok(acceptedAudit);
  assert.deepEqual(JSON.parse(acceptedAudit.detail), {
    revisionNumber: 3,
    sourceLocationId: FOREIGN_LOCATION,
    destinationLocationId: homeLocation,
    confirmedEmployeeSelected: true,
    decisionReasonRecorded: true,
    assignmentCreated: true,
    assignmentId,
  });
  const emailAudits = db.prepare(`
    SELECT detail FROM audit_log
    WHERE action = 'staff-assignment-request.email' AND entity_id = ?
    ORDER BY rowid
  `).all(requestId).map((row) => JSON.parse(row.detail));
  assert.deepEqual(emailAudits.map((entry) => entry.kind), ["submitted", "accepted"]);
  assert.doesNotMatch(JSON.stringify(emailAudits), /Nicolai|Fotowelt|cross-view-manager/);
});

test("Block 6 API: bestehende Dienste und genehmigte Abwesenheiten verhindern die Einsatzbindung", async () => {
  const pendingVacation = db.prepare(`
    INSERT INTO vacation_requests (employee_number, date_from, date_to, note, status)
    VALUES (?, '2026-08-30', '2026-08-30', 'offen', 'pending')
  `).run(FOREIGN_EMPLOYEE);
  try {
    for (const [date, expectedCode] of [
      ["2026-08-26", "EMPLOYEE_LENDING_OVERLAP"],
      ["2026-08-27", "EMPLOYEE_LENDING_SHIFT_CONFLICT"],
      ["2026-08-28", "EMPLOYEE_LENDING_APPROVED_ABSENCE_CONFLICT"],
      ["2026-08-30", "EMPLOYEE_LENDING_PENDING_ABSENCE_REQUEST_CONFLICT"],
    ]) {
      const submitted = await mutate(
        "/api/portal/v1/staff-assignment-requests",
        session(MANAGER),
        {
          sourceLocationId: FOREIGN_LOCATION,
          destinationDepartmentId: homeDepartment,
          periodStartDate: date,
          periodEndDate: date,
          timeKind: "full_day",
          preferredEmployeeNumber: FOREIGN_EMPLOYEE,
          requestReason: "Konflikt muss vor der Genehmigung gemeldet werden",
        },
      );
      assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
      const requestId = submitted.payload.request.id;
      const before = db.prepare("SELECT COUNT(*) AS count FROM employee_location_lendings").get().count;
      const result = await mutateWithMethod(
        `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
        session(FOREIGN_EMPLOYEE),
        {
          decision: "accepted",
          expectedRevision: 2,
          confirmedEmployeeNumber: FOREIGN_EMPLOYEE,
          decisionReason: "Konfliktprüfung",
        },
      );
      assert.equal(result.response.status, 409, JSON.stringify(result.payload));
      assert.equal(result.payload.code, expectedCode);
      assert.equal(db.prepare(`
        SELECT MAX(revision_number) AS revision
        FROM staff_assignment_request_revisions WHERE request_id = ?
      `).get(requestId).revision, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM employee_location_lendings").get().count, before);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM employee_location_lendings WHERE id = ?
      `).get(staffAssignmentRequestAssignmentId(requestId)).count, 0);
    }
  } finally {
    db.prepare("DELETE FROM vacation_requests WHERE id = ?").run(pendingVacation.lastInsertRowid);
  }
});

test("Block 5 API: Ablehnung verlangt Grund und konkurrierende Entscheidungen bleiben geschlossen", async () => {
  const submitted = await mutate(
    "/api/portal/v1/staff-assignment-requests",
    session(MANAGER),
    {
      sourceLocationId: FOREIGN_LOCATION,
      destinationDepartmentId: homeDepartment,
      periodStartDate: "2026-08-27",
      periodEndDate: "2026-08-27",
      timeKind: "full_day",
      preferredEmployeeNumber: FOREIGN_EMPLOYEE,
      requestReason: "Zweite revisionsgebundene Prüfanfrage",
    },
  );
  const requestId = submitted.payload.request.id;
  const missingReason = await mutateWithMethod(
    `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
    session(FOREIGN_EMPLOYEE),
    { decision: "rejected", expectedRevision: 2, decisionReason: "" },
  );
  assert.equal(missingReason.response.status, 400, JSON.stringify(missingReason.payload));
  assert.equal(missingReason.payload.code, "STAFF_ASSIGNMENT_REQUEST_INVALID");
  assert.equal(db.prepare(`
    SELECT MAX(revision_number) AS revision FROM staff_assignment_request_revisions
    WHERE request_id = ?
  `).get(requestId).revision, 2);

  const rejected = await mutateWithMethod(
    `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
    session(FOREIGN_EMPLOYEE),
    { decision: "rejected", expectedRevision: 2, decisionReason: "Mindestbesetzung nicht gesichert" },
  );
  assert.equal(rejected.response.status, 200, JSON.stringify(rejected.payload));
  assert.equal(rejected.payload.request.status, "rejected");
  assert.equal(rejected.payload.request.confirmedEmployeeNumber, null);
  assert.equal(rejected.payload.request.assignmentId, null);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM employee_location_lendings WHERE id = ?
  `).get(staffAssignmentRequestAssignmentId(requestId)).count, 0);

  const stale = await mutateWithMethod(
    `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
    session(FOREIGN_EMPLOYEE),
    {
      decision: "accepted",
      expectedRevision: 2,
      confirmedEmployeeNumber: FOREIGN_EMPLOYEE,
      decisionReason: "veraltet",
    },
  );
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "STAFF_ASSIGNMENT_REQUEST_REVISION_CONFLICT");
});

test("Block 5 API: Antragsteller und unberechtigte Zugänge erhalten keine Prüfdaten", async () => {
  const requester = await request(
    "/api/portal/v1/staff-assignment-requests",
    session(MANAGER),
  );
  assert.equal(requester.response.status, 200, JSON.stringify(requester.payload));
  assert.deepEqual(requester.payload.requests, []);
  const employee = await request(
    "/api/portal/v1/staff-assignment-requests",
    session(EMPLOYEE),
  );
  assert.equal(employee.response.status, 403, JSON.stringify(employee.payload));
  assert.equal(employee.payload.code, "PORTAL_PERMISSION_DENIED");
});

test("Block 6 API: ein Auditfehler rollt Entscheidung, Fachereignis und Filialeinsatz gemeinsam zurück", async () => {
  const submitted = await mutate(
    "/api/portal/v1/staff-assignment-requests",
    session(MANAGER),
    {
      sourceLocationId: FOREIGN_LOCATION,
      destinationDepartmentId: homeDepartment,
      periodStartDate: "2026-08-29",
      periodEndDate: "2026-08-29",
      timeKind: "full_day",
      preferredEmployeeNumber: FOREIGN_EMPLOYEE,
      requestReason: "Atomar zu prüfende Einsatzanfrage",
    },
  );
  const requestId = submitted.payload.request.id;
  const assignmentId = staffAssignmentRequestAssignmentId(requestId);
  db.exec(`
    CREATE TRIGGER test_staff_assignment_decision_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'staff-assignment-request.accepted'
    BEGIN
      SELECT RAISE(ABORT, 'test staff assignment decision audit failure');
    END
  `);
  try {
    const result = await mutateWithMethod(
      `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
      session(FOREIGN_EMPLOYEE),
      {
        decision: "accepted",
        expectedRevision: 2,
        confirmedEmployeeNumber: FOREIGN_EMPLOYEE,
        decisionReason: "Darf nicht teilweise gespeichert werden",
      },
    );
    assert.equal(result.response.status, 500, JSON.stringify(result.payload));
    assert.equal(db.prepare(`
      SELECT MAX(revision_number) AS revision
      FROM staff_assignment_request_revisions WHERE request_id = ?
    `).get(requestId).revision, 2);
    assert.equal(db.prepare(`
      SELECT MAX(sequence_number) AS sequence
      FROM staff_assignment_request_events WHERE request_id = ?
    `).get(requestId).sequence, 2);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM employee_location_lendings WHERE id = ?
    `).get(assignmentId).count, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action = 'staff-assignment-request.email' AND entity_id = ?
    `).get(requestId).count, 1);
  } finally {
    db.exec("DROP TRIGGER test_staff_assignment_decision_audit_abort");
  }
});

test("Block 2 API: eigene, vergangene und übernächste Woche bleiben gesperrt", async () => {
  const auth = session(MANAGER);
  for (const [route, status, code] of [
    [`?locationId=${homeLocation}&week=${CURRENT_WEEK}`, 403, "CROSS_LOCATION_SCHEDULE_LOCATION_DENIED"],
    [`?locationId=${FOREIGN_LOCATION}&week=2026-08-10`, 400, "CROSS_LOCATION_SCHEDULE_WEEK_DENIED"],
    [`?locationId=${FOREIGN_LOCATION}&week=2026-08-31`, 400, "CROSS_LOCATION_SCHEDULE_WEEK_DENIED"],
    [`?locationId=${FOREIGN_LOCATION}&week=2026-08-18`, 400, "CROSS_LOCATION_SCHEDULE_WEEK_DENIED"],
  ]) {
    const result = await request(`/api/portal/v1/cross-location-schedules${route}`, auth);
    assert.equal(result.response.status, status, JSON.stringify(result.payload));
    assert.equal(result.payload.code, code);
  }
});

test("Block 2 API: anonyme, technische und fachlich unberechtigte Zugänge erhalten keine Daten", async () => {
  const anonymous = await request(
    `/api/portal/v1/cross-location-schedules?locationId=${FOREIGN_LOCATION}&week=${CURRENT_WEEK}`,
  );
  assert.equal(anonymous.response.status, 401);
  const employee = await request(
    `/api/portal/v1/cross-location-schedules?locationId=${FOREIGN_LOCATION}&week=${CURRENT_WEEK}`,
    session(EMPLOYEE),
  );
  assert.equal(employee.response.status, 403, JSON.stringify(employee.payload));
  assert.equal(employee.payload.code, "PORTAL_PERMISSION_DENIED");
});

test("Block 12: zwei parallele Entscheidungen erzeugen genau einen verbindlichen Filialeinsatz", async () => {
  const submitted = await mutate(
    "/api/portal/v1/staff-assignment-requests",
    session(MANAGER),
    {
      sourceLocationId: FOREIGN_LOCATION,
      destinationDepartmentId: homeDepartment,
      periodStartDate: "2026-08-25",
      periodEndDate: "2026-08-25",
      timeKind: "full_day",
      preferredEmployeeNumber: FOREIGN_EMPLOYEE,
      requestReason: "Parallele revisionsgebundene Entscheidung prüfen",
    },
  );
  assert.equal(submitted.response.status, 201, JSON.stringify(submitted.payload));
  const requestId = submitted.payload.request.id;
  const assignmentId = staffAssignmentRequestAssignmentId(requestId);
  const decision = {
    decision: "accepted",
    expectedRevision: 2,
    confirmedEmployeeNumber: FOREIGN_EMPLOYEE,
    decisionReason: "Parallelentscheidung fachlich geprüft",
  };

  const outcomes = await Promise.all([
    mutateWithMethod(
      `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
      session(FOREIGN_EMPLOYEE),
      decision,
    ),
    mutateWithMethod(
      `/api/portal/v1/staff-assignment-requests/${encodeURIComponent(requestId)}/decision`,
      session(FOREIGN_EMPLOYEE),
      decision,
    ),
  ]);
  assert.deepEqual(outcomes.map(({ response }) => response.status).sort(), [200, 409]);
  const conflict = outcomes.find(({ response }) => response.status === 409);
  assert.equal(conflict.payload.code, "STAFF_ASSIGNMENT_REQUEST_REVISION_CONFLICT");
  assert.equal(db.prepare(`
    SELECT MAX(revision_number) AS revision
    FROM staff_assignment_request_revisions WHERE request_id = ?
  `).get(requestId).revision, 3);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM employee_location_lendings WHERE id = ?
  `).get(assignmentId).count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'staff-assignment-request.accepted' AND entity_id = ?
  `).get(requestId).count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'staff-assignment-request.email' AND entity_id = ?
      AND json_extract(detail, '$.kind') = 'accepted'
  `).get(requestId).count, 1);
});

test("Einsatzanfragen: heutige Frist nutzt die Zielfiliale, wird frisch geprüft und erlaubt morgen", async () => {
  const previousTime = process.env.GRABENPLANER_TEST_REQUEST_TIME;
  const previousToday = process.env.GRABENPLANER_TEST_TODAY;
  const ownDays = db.prepare("SELECT day_settings_json FROM locations WHERE id=?").get(homeLocation).day_settings_json;
  const foreignDays = db.prepare("SELECT day_settings_json FROM locations WHERE id=?").get(FOREIGN_LOCATION).day_settings_json;
  const auth = session(MANAGER);
  const input = { sourceLocationId:FOREIGN_LOCATION, destinationDepartmentId:homeDepartment,
    periodStartDate:"2026-08-19",periodEndDate:"2026-08-19",timeKind:"full_day",requestReason:"Synthetische Prüfung der Tagesfrist" };
  try {
    db.prepare("UPDATE locations SET day_settings_json=? WHERE id=?").run(JSON.stringify({wednesday:{open:true,start:"09:00",end:"18:00"}}),homeLocation);
    db.prepare("UPDATE locations SET day_settings_json=? WHERE id=?").run(JSON.stringify({wednesday:{open:true,start:"09:00",end:"22:00"}}),FOREIGN_LOCATION);
    process.env.GRABENPLANER_TEST_REQUEST_TIME="14:59:59";
    const before = await request("/api/portal/v1/staff-assignment-requests/period",auth);
    assert.equal(before.payload.requestPeriod.sameDay.cutoffTime,"15:00");
    assert.equal(before.payload.requestPeriod.minimum,"2026-08-19");
    const submitted = await mutate("/api/portal/v1/staff-assignment-requests",auth,input);
    assert.equal(submitted.response.status,201,JSON.stringify(submitted.payload));
    process.env.GRABENPLANER_TEST_REQUEST_TIME="15:00:00";
    assert.equal((await request("/api/portal/v1/staff-assignment-requests/period",auth)).payload.requestPeriod.sameDay.allowed,true);
    process.env.GRABENPLANER_TEST_REQUEST_TIME="15:00:01";
    const after = await request("/api/portal/v1/staff-assignment-requests/period?locationId="+FOREIGN_LOCATION,auth);
    assert.equal(after.payload.requestPeriod.minimum,"2026-08-20");
    assert.equal(after.payload.requestPeriod.maximum,"2027-02-19");
    const count = db.prepare("SELECT COUNT(*) n FROM staff_assignment_requests").get().n;
    const denied = await mutate("/api/portal/v1/staff-assignment-requests",auth,{...input, requestPeriod:before.payload.requestPeriod});
    assert.equal(denied.response.status,409);
    assert.equal(denied.payload.code,"STAFF_ASSIGNMENT_REQUEST_SAME_DAY_CLOSED");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM staff_assignment_requests").get().n,count);
    const tomorrow = await mutate("/api/portal/v1/staff-assignment-requests",auth,{...input,periodStartDate:"2026-08-20",periodEndDate:"2026-08-20"});
    assert.equal(tomorrow.response.status,201,JSON.stringify(tomorrow.payload));
    process.env.GRABENPLANER_TEST_REQUEST_TIME="12:00:00";
    db.prepare("UPDATE locations SET day_settings_json=? WHERE id=?").run(JSON.stringify({wednesday:{open:true,start:"08:00",end:"14:00"}}),homeLocation);
    assert.equal((await request("/api/portal/v1/staff-assignment-requests/period",auth)).payload.requestPeriod.sameDay.cutoffTime,"11:00");
    db.prepare("UPDATE locations SET day_settings_json=? WHERE id=?").run(JSON.stringify({wednesday:{open:false,start:"09:00",end:"18:00"}}),homeLocation);
    assert.equal((await request("/api/portal/v1/staff-assignment-requests/period",auth)).payload.requestPeriod.sameDay.reason,"closed");
    process.env.GRABENPLANER_TEST_TODAY="2026-10-26";
    assert.equal((await request("/api/portal/v1/staff-assignment-requests/period",auth)).payload.requestPeriod.minimum,"2026-10-27");
    assert.equal((await request("/api/portal/v1/staff-assignment-requests/period",session(EMPLOYEE))).response.status,403);
    assert.equal((await request("/api/portal/v1/staff-assignment-requests/period")).response.status,401);
  } finally {
    process.env.GRABENPLANER_TEST_REQUEST_TIME=previousTime;
    process.env.GRABENPLANER_TEST_TODAY=previousToday;
    db.prepare("UPDATE locations SET day_settings_json=? WHERE id=?").run(ownDays,homeLocation);
    db.prepare("UPDATE locations SET day_settings_json=? WHERE id=?").run(foreignDays,FOREIGN_LOCATION);
  }
});

test("Block 12: fünf gleichzeitige persönliche Benutzeraktionen bleiben SQLite-stabil", async () => {
  const actors = Array.from({ length: 5 }, (_, index) => `block12-load-${index + 1}`);
  for (const [index, employeeNumber] of actors.entries()) {
    insertEmployee(employeeNumber, `Lastprofil ${index + 1}`, homeLocation, homeDepartment);
    insertPortalUser(employeeNumber, "manager");
    db.prepare(`
      INSERT INTO portal_access_scopes (
        employee_number, location_id, department_id, assigned_by
      ) VALUES (?, ?, 0, ?)
    `).run(employeeNumber, homeLocation, employeeNumber);
  }

  const startedAt = Date.now();
  const results = await Promise.all(actors.map((employeeNumber, index) => mutate(
    "/api/portal/v1/staff-assignment-requests",
    session(employeeNumber),
    {
      sourceLocationId: FOREIGN_LOCATION,
      destinationDepartmentId: homeDepartment,
      periodStartDate: "2026-08-30",
      periodEndDate: "2026-08-30",
      timeKind: "full_day",
      requestReason: `Block-12-Lastprüfung ${index + 1}`,
    },
  )));
  assert.deepEqual(results.map(({ response }) => response.status), [201, 201, 201, 201, 201]);
  assert.ok(Date.now() - startedAt < 20_000, "Fünf Portalaktionen benötigen unerwartet lange.");
  block12LoadRequestIds = results.map(({ payload }) => payload.request.id);
  assert.equal(new Set(block12LoadRequestIds).size, 5);
  for (const requestId of block12LoadRequestIds) {
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM staff_assignment_request_revisions WHERE request_id = ?
    `).get(requestId).count, 2);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM staff_assignment_request_events WHERE request_id = ?
    `).get(requestId).count, 2);
  }
  assert.deepEqual(db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check), ["ok"]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Block 12: verifizierter Sicherungspunkt erhält Anfragehistorie und Geburtstagsnachweise", () => {
  assert.equal(block12LoadRequestIds.length, 5);
  const employeeNumber = "block12-load-1";
  db.prepare(`
    INSERT INTO portal_birthday_presentation_assignments (
      employee_number, presentation_id, revision
    ) VALUES (?, 'elegant', 1)
  `).run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_birthday_presentation_claims (
      employee_number, event_year, presentation_id, policy_revision,
      assignment_revision, receipt_sha256, revision
    ) VALUES (?, 2026, 'elegant', 1, 1, ?, 1)
  `).run(employeeNumber, "a".repeat(64));

  const backupDirectory = path.join(testRoot, "block12-release-backup");
  const backup = subject.createDatabaseBackupToDirectory(
    backupDirectory,
    "block12-release-readiness",
    "test",
  );
  assert.equal(backup?.verified, true);
  assert.equal(backup?.committed, true);
  assert.equal(fs.existsSync(backup.path), true);
  assert.equal(fs.existsSync(backup.marker), true);

  const restoredPath = path.join(testRoot, "block12-restored.db");
  fs.copyFileSync(backup.path, restoredPath);
  const restored = openSqliteLegacyDatabase(restoredPath, { readOnly: true });
  try {
    assert.deepEqual(restored.prepare("PRAGMA quick_check").all().map((row) => row.quick_check), ["ok"]);
    assert.deepEqual(restored.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check), ["ok"]);
    assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
    const requestId = block12LoadRequestIds[0];
    assert.equal(restored.prepare(`
      SELECT COUNT(*) AS count FROM staff_assignment_requests WHERE id = ?
    `).get(requestId).count, 1);
    assert.equal(restored.prepare(`
      SELECT COUNT(*) AS count FROM staff_assignment_request_revisions WHERE request_id = ?
    `).get(requestId).count, 2);
    assert.equal(restored.prepare(`
      SELECT COUNT(*) AS count FROM staff_assignment_request_events WHERE request_id = ?
    `).get(requestId).count, 2);
    assert.deepEqual({ ...restored.prepare(`
      SELECT presentation_id, revision
      FROM portal_birthday_presentation_assignments WHERE employee_number = ?
    `).get(employeeNumber) }, { presentation_id: "elegant", revision: 1 });
    assert.deepEqual({ ...restored.prepare(`
      SELECT event_year, presentation_id, revision
      FROM portal_birthday_presentation_claims WHERE employee_number = ?
    `).get(employeeNumber) }, { event_year: 2026, presentation_id: "elegant", revision: 1 });
  } finally {
    restored.close();
  }
});
