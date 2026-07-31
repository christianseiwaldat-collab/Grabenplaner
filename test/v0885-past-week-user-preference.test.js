"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "grabenplaner-v0885-past-week-preference-"),
);
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

const USER_A = "9275";
const USER_B = "9252";
const USER_WITHOUT_WRITE = "9276";
const USER_SCHEDULE_ONLY = "9277";
const PAST_WEEK = "2020-01-06";
const PAST_SHIFT_DATE = "2020-01-07";
const LEGACY_REFRESH_WEEK = "2099-01-05";
const LEGACY_REFRESH_DATE = "2099-01-06";
const LEGACY_REFRESH_REASON = "v0885 Legacy-Setting-Refresh";
const TEST_USERS = [USER_A, USER_B, USER_WITHOUT_WRITE, USER_SCHEDULE_ONLY];

let httpServer;
let baseUrl;
let locationId;

function ensureEmployee(employeeNumber, fullName) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, time_confirmation_level, home_location_id, active)
    VALUES (?, ?, ?, '#2c7a68', 32, 5, 'C', ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      color = excluded.color,
      contracted_hours = excluded.contracted_hours,
      target_workdays_per_week = excluded.target_workdays_per_week,
      time_confirmation_level = excluded.time_confirmation_level,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, fullName, fullName.split(" ")[0], locationId);
}

function ensurePortalUser(employeeNumber) {
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', 'employee', 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only',
      role = 'employee',
      role_locked = 0,
      active = 1,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber);
}

function grantPlanningScope(employeeNumber, { write, settings = false }) {
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'schedule:read', 'v0885-test')
  `).run(employeeNumber);
  if (write) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, 'schedule:write', 'v0885-test')
    `).run(employeeNumber);
  }
  if (settings) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, 'settings:write', 'v0885-test')
    `).run(employeeNumber);
  }
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'v0885-test')
  `).run(employeeNumber, locationId);
}

function createPortalSession(employeeNumber) {
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

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    const placeholders = TEST_USERS.map(() => "?").join(", ");
    db.prepare("DELETE FROM global_day_blocks WHERE reason = ?").run(LEGACY_REFRESH_REASON);
    db.prepare(`DELETE FROM shifts WHERE employee_number IN (${placeholders})`).run(...TEST_USERS);
    db.prepare(`DELETE FROM portal_sessions WHERE employee_number IN (${placeholders})`).run(...TEST_USERS);
    db.prepare(`DELETE FROM portal_user_preferences WHERE employee_number IN (${placeholders})`).run(...TEST_USERS);
    db.prepare(`DELETE FROM portal_permission_denials WHERE employee_number IN (${placeholders})`).run(...TEST_USERS);
    db.prepare(`DELETE FROM portal_permission_grants WHERE employee_number IN (${placeholders})`).run(...TEST_USERS);
    db.prepare(`DELETE FROM portal_access_scopes WHERE employee_number IN (${placeholders})`).run(...TEST_USERS);
    db.prepare(`DELETE FROM portal_users WHERE employee_number IN (${placeholders})`).run(...TEST_USERS);
    db.prepare(`DELETE FROM employees WHERE personnel_number IN (${placeholders})`).run(...TEST_USERS);

    ensureEmployee(USER_A, "Anna Benutzerfreigabe");
    ensureEmployee(USER_B, "Berta Benutzerfreigabe");
    ensureEmployee(USER_WITHOUT_WRITE, "Carla Ohne Planungsrecht");
    ensureEmployee(USER_SCHEDULE_ONLY, "Dora Ohne Einstellungsrecht");
    for (const employeeNumber of TEST_USERS) ensurePortalUser(employeeNumber);
    grantPlanningScope(USER_A, { write: true, settings: true });
    grantPlanningScope(USER_B, { write: true, settings: true });
    grantPlanningScope(USER_WITHOUT_WRITE, { write: false, settings: true });
    grantPlanningScope(USER_SCHEDULE_ONLY, { write: true, settings: false });

    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

async function requestJson(
  route,
  {
    method = "GET",
    session = null,
    body,
  } = {},
) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) {
    headers["X-CSRF-Token"] = session.csrf;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    response,
    payload: text ? JSON.parse(text) : null,
    text,
  };
}

function preferenceRow(employeeNumber) {
  return db.prepare(`
    SELECT value
    FROM portal_user_preferences
    WHERE employee_number = ? AND preference_key = 'allow_past_week_editing'
  `).get(employeeNumber);
}

test.before(async () => {
  locationId = db.prepare(
    "SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1",
  ).get().id;
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
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
});

test("Vergangenheitsfreigabe bleibt je Planungsbenutzer isoliert und steuert den Schreibschutz", async () => {
  const userA = createPortalSession(USER_A);
  const userB = createPortalSession(USER_B);

  const defaultsA = await requestJson("/api/portal/v1/ui-preferences", { session: userA });
  const defaultsB = await requestJson("/api/portal/v1/ui-preferences", { session: userB });
  assert.equal(defaultsA.response.status, 200, defaultsA.text);
  assert.equal(defaultsB.response.status, 200, defaultsB.text);
  assert.equal(defaultsA.payload.allowPastWeekEditing, false);
  assert.equal(defaultsB.payload.allowPastWeekEditing, false);

  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('allow_past_week_editing', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
  const refreshLegacySnapshot = await requestJson("/api/global-day-blocks", {
    method: "POST",
    session: userA,
    body: {
      locationId,
      weekStart: LEGACY_REFRESH_WEEK,
      blockDate: LEGACY_REFRESH_DATE,
      reason: LEGACY_REFRESH_REASON,
      isPublicHoliday: false,
    },
  });
  assert.equal(refreshLegacySnapshot.response.status, 201, refreshLegacySnapshot.text);
  const legacyScheduleA = await requestJson(
    `/api/schedule?week=${PAST_WEEK}&location=${encodeURIComponent(locationId)}`,
    { session: userA },
  );
  const legacyScheduleB = await requestJson(
    `/api/schedule?week=${PAST_WEEK}&location=${encodeURIComponent(locationId)}`,
    { session: userB },
  );
  assert.equal(legacyScheduleA.payload.isPastWeekLocked, true);
  assert.equal(legacyScheduleA.payload.settings.allow_past_week_editing, "0");
  assert.equal(legacyScheduleB.payload.isPastWeekLocked, true);
  assert.equal(legacyScheduleB.payload.settings.allow_past_week_editing, "0");
  const removeRefreshBlock = await requestJson(
    `/api/global-day-blocks/${encodeURIComponent(refreshLegacySnapshot.payload.id)}`,
    { method: "DELETE", session: userA },
  );
  assert.equal(removeRefreshBlock.response.status, 204, removeRefreshBlock.text);

  const enabled = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: userA,
    body: { allowPastWeekEditing: true },
  });
  assert.equal(enabled.response.status, 200, enabled.text);
  assert.equal(enabled.payload.allowPastWeekEditing, true);
  assert.equal(preferenceRow(USER_A)?.value, "1");
  assert.equal(preferenceRow(USER_B), undefined);

  const scheduleA = await requestJson(
    `/api/schedule?week=${PAST_WEEK}&location=${encodeURIComponent(locationId)}`,
    { session: userA },
  );
  const scheduleB = await requestJson(
    `/api/schedule?week=${PAST_WEEK}&location=${encodeURIComponent(locationId)}`,
    { session: userB },
  );
  assert.equal(scheduleA.response.status, 200, scheduleA.text);
  assert.equal(scheduleB.response.status, 200, scheduleB.text);
  assert.equal(scheduleA.payload.isPastWeekLocked, false);
  assert.equal(scheduleA.payload.settings.allow_past_week_editing, "1");
  assert.equal(scheduleB.payload.isPastWeekLocked, true);
  assert.equal(scheduleB.payload.settings.allow_past_week_editing, "0");

  const createdByA = await requestJson("/api/shifts", {
    method: "POST",
    session: userA,
    body: {
      employeeNumber: USER_A,
      locationId,
      departmentId: "",
      date: PAST_SHIFT_DATE,
      startTime: "09:00",
      endTime: "17:00",
      area: "Persoenliche Vergangenheitsfreigabe",
      note: "Nur Benutzer A ist freigeschaltet",
    },
  });
  assert.equal(createdByA.response.status, 201, createdByA.text);

  const blockedForB = await requestJson("/api/shifts", {
    method: "POST",
    session: userB,
    body: {
      employeeNumber: USER_B,
      locationId,
      departmentId: "",
      date: PAST_SHIFT_DATE,
      startTime: "09:00",
      endTime: "17:00",
      area: "Keine fremde Freigabe",
      note: "Benutzer B bleibt gesperrt",
    },
  });
  assert.equal(blockedForB.response.status, 423, blockedForB.text);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE employee_number = ?").get(USER_B).count,
    0,
  );

  db.prepare(`
    DELETE FROM portal_permission_grants
    WHERE employee_number = ? AND permission = 'settings:write'
  `).run(USER_A);
  const lockedAfterPermissionRemoval = await requestJson(
    `/api/schedule?week=${PAST_WEEK}&location=${encodeURIComponent(locationId)}`,
    { session: userA },
  );
  assert.equal(lockedAfterPermissionRemoval.response.status, 200, lockedAfterPermissionRemoval.text);
  assert.equal(lockedAfterPermissionRemoval.payload.isPastWeekLocked, true);
  assert.equal(lockedAfterPermissionRemoval.payload.settings.allow_past_week_editing, "0");
});

test("Vergangenheitsfreigabe verlangt Boolean sowie schedule:write und settings:write", async () => {
  const userA = createPortalSession(USER_A);
  const userWithoutWrite = createPortalSession(USER_WITHOUT_WRITE);
  const userScheduleOnly = createPortalSession(USER_SCHEDULE_ONLY);

  const invalid = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: userA,
    body: { allowPastWeekEditing: "true" },
  });
  assert.equal(invalid.response.status, 400, invalid.text);
  assert.equal(invalid.payload.code, "UI_PREFERENCES_INVALID");
  assert.equal(preferenceRow(USER_A), undefined);

  const forbidden = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: userWithoutWrite,
    body: { allowPastWeekEditing: true },
  });
  assert.equal(forbidden.response.status, 403, forbidden.text);
  assert.equal(preferenceRow(USER_WITHOUT_WRITE), undefined);

  const forbiddenWithoutSettings = await requestJson("/api/portal/v1/ui-preferences", {
    method: "PUT",
    session: userScheduleOnly,
    body: { allowPastWeekEditing: true },
  });
  assert.equal(forbiddenWithoutSettings.response.status, 403, forbiddenWithoutSettings.text);
  assert.equal(preferenceRow(USER_SCHEDULE_ONLY), undefined);
});
