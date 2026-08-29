"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v09220-manual-lock-"));
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
const { app, db } = subject;

const MANAGER = "99410";
const DEPARTMENT_MANAGER = "99411";
const WEEK = "2099-01-05";
const DATE = WEEK;

let httpServer;
let baseUrl;
let locationId;
let departmentId;
let managerSession;
let departmentSession;

function ensureEmployee(employeeNumber, name, positionId, preferredDepartmentId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, position_id,
       time_confirmation_level, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#2c7a68', 32, 5, '', ?, 'C', ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      position_id = excluded.position_id,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(
    employeeNumber,
    name,
    name.split(" ")[0],
    positionId,
    locationId,
    preferredDepartmentId,
  );
}

function ensurePortalUser(employeeNumber, role, scopeDepartmentId) {
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active,
       must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  for (const permission of ["schedule:read", "schedule:write"]) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, ?, 'v09220-manual-lock-test')
    `).run(employeeNumber, permission);
  }
  db.prepare(`
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, 'v09220-manual-lock-test')
  `).run(employeeNumber, locationId, scopeDepartmentId);
}

function createSession(employeeNumber) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(rawToken)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function requestJson(route, { method = "GET", body, auth = managerSession } = {}) {
  const headers = { Accept: "application/json", Cookie: auth.cookie };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, payload: text ? JSON.parse(text) : null };
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  const existingDepartment = db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1
    ORDER BY sort_order, id LIMIT 1
  `).get(locationId);
  departmentId = Number(existingDepartment?.id || db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Sperrtest', 0, 1, 999)
  `).run(locationId).lastInsertRowid);
  const positionId = db.prepare(`
    SELECT id FROM positions WHERE active = 1
    ORDER BY is_default DESC, sort_order, id LIMIT 1
  `).get().id;
  ensureEmployee(MANAGER, "Manuelle Sperre Leitung", positionId, departmentId);
  ensureEmployee(DEPARTMENT_MANAGER, "Manuelle Sperre Abteilung", positionId, departmentId);
  ensurePortalUser(MANAGER, "manager", 0);
  ensurePortalUser(DEPARTMENT_MANAGER, "department_manager", departmentId);
  managerSession = createSession(MANAGER);
  departmentSession = createSession(DEPARTMENT_MANAGER);
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

test("v0.92.20 manuelle Dienstplansperre sperrt filialweit, revisionssicher und auditierbar", async () => {
  const initial = await requestJson(
    `/api/schedule?week=${WEEK}&locationId=${encodeURIComponent(locationId)}`,
  );
  assert.equal(initial.response.status, 200, initial.text);
  assert.deepEqual(initial.payload.manualScheduleLock, {
    locationId,
    weekStart: WEEK,
    locked: false,
    revision: 0,
    updatedBy: "",
    updatedAt: "",
    canManage: true,
  });

  const locked = await requestJson("/api/schedule/manual-lock", {
    method: "PUT",
    body: { locationId, weekStart: WEEK, locked: true, expectedRevision: 0 },
  });
  assert.equal(locked.response.status, 200, locked.text);
  assert.equal(locked.payload.manualScheduleLock.locked, true);
  assert.equal(locked.payload.manualScheduleLock.revision, 1);
  assert.equal(locked.payload.manualScheduleLock.updatedBy, MANAGER);
  assert.equal(
    db.prepare("SELECT locked FROM schedule_manual_locks WHERE location_id = ? AND week_start = ?")
      .get(locationId, WEEK).locked,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE actor = ? AND action = 'schedule.manual-lock.lock'")
      .get(MANAGER).count,
    1,
  );

  const departmentView = await requestJson(
    `/api/schedule?week=${WEEK}&locationId=${encodeURIComponent(locationId)}&departmentId=${departmentId}`,
    { auth: departmentSession },
  );
  assert.equal(departmentView.response.status, 200, departmentView.text);
  assert.equal(departmentView.payload.manualScheduleLock.locked, true);
  assert.equal(departmentView.payload.manualScheduleLock.canManage, false);

  const departmentToggle = await requestJson("/api/schedule/manual-lock", {
    method: "PUT",
    auth: departmentSession,
    body: {
      locationId,
      departmentId,
      weekStart: WEEK,
      locked: false,
      expectedRevision: 1,
    },
  });
  assert.equal(departmentToggle.response.status, 403, departmentToggle.text);
  assert.ok(["PORTAL_SCOPE_DENIED", "SCHEDULE_MANUAL_LOCK_SCOPE_DENIED"].includes(departmentToggle.payload.code));

  const blockedShift = await requestJson("/api/shifts", {
    method: "POST",
    body: {
      employeeNumber: MANAGER,
      locationId,
      departmentId,
      date: DATE,
      startTime: "09:00",
      endTime: "12:00",
      area: "Manuelle Sperre",
      note: "muss blockieren",
    },
  });
  assert.equal(blockedShift.response.status, 423, blockedShift.text);
  assert.equal(blockedShift.payload.code, "SCHEDULE_MANUAL_LOCKED");

  const blockedOption = await requestJson("/api/week-options", {
    method: "POST",
    body: {
      employeeNumber: MANAGER,
      locationId,
      departmentId,
      weekStart: WEEK,
      dateFrom: DATE,
      dateTo: DATE,
      optionType: "branch",
      allDay: true,
      note: "muss blockieren",
    },
  });
  assert.equal(blockedOption.response.status, 423, blockedOption.text);
  assert.equal(blockedOption.payload.code, "SCHEDULE_MANUAL_LOCKED");

  const blockedNote = await requestJson("/api/schedule-note", {
    method: "PUT",
    body: {
      locationId,
      departmentId,
      weekStart: WEEK,
      noteText: "muss blockieren",
      noteHtml: "muss blockieren",
    },
  });
  assert.equal(blockedNote.response.status, 423, blockedNote.text);
  assert.equal(blockedNote.payload.code, "SCHEDULE_MANUAL_LOCKED");

  const blockedReset = await requestJson(
    `/api/schedule?week=${WEEK}&locationId=${encodeURIComponent(locationId)}`,
    { method: "DELETE" },
  );
  assert.equal(blockedReset.response.status, 423, blockedReset.text);
  assert.equal(blockedReset.payload.code, "SCHEDULE_MANUAL_LOCKED");

  const staleUnlock = await requestJson("/api/schedule/manual-lock", {
    method: "PUT",
    body: { locationId, weekStart: WEEK, locked: false, expectedRevision: 0 },
  });
  assert.equal(staleUnlock.response.status, 409, staleUnlock.text);
  assert.equal(staleUnlock.payload.code, "SCHEDULE_MANUAL_LOCK_CONFLICT");

  const unlocked = await requestJson("/api/schedule/manual-lock", {
    method: "PUT",
    body: { locationId, weekStart: WEEK, locked: false, expectedRevision: 1 },
  });
  assert.equal(unlocked.response.status, 200, unlocked.text);
  assert.equal(unlocked.payload.manualScheduleLock.locked, false);
  assert.equal(unlocked.payload.manualScheduleLock.revision, 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE actor = ? AND action = 'schedule.manual-lock.unlock'")
      .get(MANAGER).count,
    1,
  );

  const createdShift = await requestJson("/api/shifts", {
    method: "POST",
    body: {
      employeeNumber: MANAGER,
      locationId,
      departmentId,
      date: DATE,
      startTime: "09:00",
      endTime: "12:00",
      area: "Nach Freigabe",
      note: "zulässig",
    },
  });
  assert.equal(createdShift.response.status, 201, createdShift.text);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE employee_number = ? AND shift_date = ?")
      .get(MANAGER, DATE).count,
    1,
  );
});
