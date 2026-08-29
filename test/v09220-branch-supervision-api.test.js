"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v09220-branch-supervision-"));
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

const ACTOR = "99220";
const FL = "99221";
const AL = "99222";
const DATE = "2099-01-05";
const WEEK = "2099-01-05";
const TEST_EMPLOYEES = [ACTOR, FL, AL];

let httpServer;
let baseUrl;
let locationId;
let session;

function ensureEmployee(employeeNumber, name, positionId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, position_id, time_confirmation_level,
       home_location_id, active)
    VALUES (?, ?, ?, '#2c7a68', 32, 5, ?, 'C', ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      position_id = excluded.position_id,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, name, name.split(" ")[0], positionId, locationId);
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

async function requestJson(route, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json", Cookie: session.cookie };
  if (!['GET', 'HEAD'].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, payload: text ? JSON.parse(text) : null };
}

function settingsBody(settings, branchSupervision) {
  return {
    locationId,
    pdfTitle: settings.pdf_title,
    pdfFilenamePrefix: settings.pdf_filename_prefix,
    pdfFilenameIncludeKw: settings.pdf_filename_include_kw !== "0",
    pdfFilenameIncludeTimestamp: settings.pdf_filename_include_timestamp === "1",
    vacationPdfTitle: settings.vacation_pdf_title,
    vacationPdfFilenamePrefix: settings.vacation_pdf_filename_prefix,
    vacationPdfFilenameIncludePeriod: settings.vacation_pdf_filename_include_period !== "0",
    vacationPdfFilenameIncludeTimestamp: settings.vacation_pdf_filename_include_timestamp === "1",
    vacationPdfShowBalance: settings.vacation_pdf_show_balance !== "0",
    vacationPdfBalanceShowEntitlement: settings.vacation_pdf_balance_show_entitlement !== "0",
    vacationPdfBalanceShowPlanned: settings.vacation_pdf_balance_show_planned !== "0",
    vacationPdfBalanceShowConsumed: settings.vacation_pdf_balance_show_consumed === "1",
    vacationPdfCalendarStyle: settings.vacation_pdf_calendar_style,
    toastDuration: settings.toast_duration,
    showInactivePersonnel: settings.show_inactive_personnel === "1",
    showSaturdayServiceStats: settings.show_saturday_service_stats !== "0",
    externalBackupEnabled: settings.external_backup_enabled !== "0",
    backupDirectory: settings.backup_directory,
    backupIntervalHours: Number(settings.backup_interval_hours || 2),
    currentWeekAutoLock: settings.current_week_auto_lock !== "0",
    currentWeekLockMode: settings.current_week_lock_mode,
    currentWeekLockDay: settings.current_week_lock_day,
    currentWeekLockTime: settings.current_week_lock_time,
    breakRuleEnabled: settings.break_rule_enabled !== "0",
    breakAfterMinutes: Number(settings.break_after_minutes),
    breakDurationMinutes: Number(settings.break_duration_minutes),
    saturdayBonusEnabled: settings.saturday_bonus_enabled !== "0",
    saturdayBonusFrom: settings.saturday_bonus_from,
    saturdayBonusFactor: Number(settings.saturday_bonus_factor),
    showSunday: settings.show_sunday === "1",
    rememberLastScheduleOverallPlan: settings.remember_last_schedule_overall_plan !== "0",
    rememberLastVacationOverallPlan: settings.remember_last_vacation_overall_plan !== "0",
    branchSupervision,
  };
}

async function createShift(employeeNumber, startTime, endTime) {
  return requestJson("/api/shifts", {
    method: "POST",
    body: {
      employeeNumber,
      locationId,
      departmentId: "",
      date: DATE,
      startTime,
      endTime,
      area: "Filialaufsicht Test",
      note: "v0.92.20",
    },
  });
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  const daySettings = Object.fromEntries([
    ["monday", true],
    ["tuesday", false],
    ["wednesday", false],
    ["thursday", false],
    ["friday", false],
    ["saturday", false],
  ].map(([day, open]) => [day, {
    open,
    start: "09:00",
    end: "18:00",
    lunchEnabled: false,
    lunchStart: "13:00",
    lunchEnd: "14:00",
    minStaff: 0,
    minFrom: "09:00",
    minTo: "18:00",
  }]));
  db.prepare("UPDATE locations SET day_settings_json = ? WHERE id = ?")
    .run(JSON.stringify(daySettings), locationId);
  ensureEmployee(ACTOR, "Block Drei Leitung", "verkaufsmitarbeiter");
  ensureEmployee(FL, "Filial Leitung", "teamleitung");
  ensureEmployee(AL, "Abteilungs Leitung", "abteilungsleitung");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', 'manager', 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(ACTOR);
  for (const permission of ["schedule:read", "schedule:write", "settings:write"]) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, ?, 'v09220-test')
    `).run(ACTOR, permission);
  }
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'v09220-test')
  `).run(ACTOR, locationId);
  session = createSession(ACTOR);
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

test("v0.92.20 Sperrmodus blockiert verschlechternde Schichtänderungen und erlaubt schrittweisen Planaufbau", async () => {
  const loadedSettings = await requestJson(`/api/settings?locationId=${encodeURIComponent(locationId)}`);
  assert.equal(loadedSettings.response.status, 200, loadedSettings.text);
  const savedSettings = await requestJson("/api/settings", {
    method: "PUT",
    body: settingsBody(loadedSettings.payload, {
      mode: "block",
      intensity: "custom",
      minimumPrimaryCoveragePercent: 60,
      maximumDepartmentGapMinutes: 180,
    }),
  });
  assert.equal(savedSettings.response.status, 200, savedSettings.text);
  assert.equal(savedSettings.payload.branch_supervision_mode, "block");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE actor = ? AND action = 'schedule.branch-supervision.settings.update'
  `).get(ACTOR).count, 1);

  const primary = await createShift(FL, "10:00", "16:00");
  assert.equal(primary.response.status, 201, primary.text);
  assert.equal(primary.payload.branchSupervisionAssessment.outcome, "blocked");
  const morning = await createShift(AL, "09:00", "10:00");
  assert.equal(morning.response.status, 201, morning.text);
  const evening = await createShift(AL, "16:00", "18:00");
  assert.equal(evening.response.status, 201, evening.text);
  assert.equal(evening.payload.branchSupervisionAssessment.outcome, "pass");

  const schedule = await requestJson(`/api/schedule?week=${WEEK}&locationId=${encodeURIComponent(locationId)}`);
  assert.equal(schedule.response.status, 200, schedule.text);
  assert.equal(schedule.payload.branchSupervisionAssessment.outcome, "pass");
  assert.equal(schedule.payload.branchSupervisionAssessment.days[0].primaryCoveragePercent, 66.7);

  const timeOffRequestId = Number(db.prepare(`
    INSERT INTO time_off_requests
      (employee_number, location_id, request_date, date_from, date_to, all_day,
       start_time, end_time, note, status, approval_type, approval_stage)
    VALUES (?, ?, ?, ?, ?, 1, '00:00', '23:59',
      'Filialaufsicht Block 3', 'pending', 'local', 'local')
  `).run(FL, locationId, DATE, DATE, DATE).lastInsertRowid);
  const blockedTimeOff = await requestJson(
    `/api/portal/v1/time-off-requests/${timeOffRequestId}/decision`,
    { method: "PUT", body: { decision: "approved" } },
  );
  assert.equal(blockedTimeOff.response.status, 409, blockedTimeOff.text);
  assert.equal(blockedTimeOff.payload.code, "BRANCH_SUPERVISION_BLOCKED");
  assert.equal(
    db.prepare("SELECT status FROM time_off_requests WHERE id = ?").get(timeOffRequestId).status,
    "pending",
  );
  assert.ok(db.prepare("SELECT 1 FROM shifts WHERE id = ?").get(primary.payload.id));

  const shortened = await requestJson(`/api/shifts/${primary.payload.id}`, {
    method: "PUT",
    body: {
      employeeNumber: FL,
      locationId,
      departmentId: "",
      date: DATE,
      startTime: "12:00",
      endTime: "16:00",
      area: "Filialaufsicht verschlechtern",
      note: "muss blockieren",
    },
  });
  assert.equal(shortened.response.status, 409, shortened.text);
  assert.equal(shortened.payload.code, "BRANCH_SUPERVISION_BLOCKED");
  assert.equal(shortened.payload.details.branchSupervisionAssessment.outcome, "blocked");

  const removedFallback = await requestJson(`/api/shifts/${evening.payload.id}`, { method: "DELETE" });
  assert.equal(removedFallback.response.status, 409, removedFallback.text);
  assert.equal(removedFallback.payload.code, "BRANCH_SUPERVISION_BLOCKED");

  const redSettings = await requestJson("/api/settings", {
    method: "PUT",
    body: settingsBody(savedSettings.payload, {
      mode: "red",
      intensity: "standard",
      minimumPrimaryCoveragePercent: 60,
      maximumDepartmentGapMinutes: 180,
    }),
  });
  assert.equal(redSettings.response.status, 200, redSettings.text);
  const allowedRemoval = await requestJson(`/api/shifts/${evening.payload.id}`, { method: "DELETE" });
  assert.equal(allowedRemoval.response.status, 204, allowedRemoval.text);
  const redSchedule = await requestJson(`/api/schedule?week=${WEEK}&locationId=${encodeURIComponent(locationId)}`);
  assert.equal(redSchedule.payload.branchSupervisionAssessment.outcome, "red");
  assert.equal(redSchedule.payload.branchSupervisionAssessment.issueCount, 1);

  db.prepare("DELETE FROM shifts WHERE employee_number IN (?, ?, ?)").run(...TEST_EMPLOYEES);
  db.prepare("UPDATE employees SET position_id = 'verkaufsmitarbeiter' WHERE personnel_number IN (?, ?)")
    .run(FL, AL);
  const blockingSettings = await requestJson("/api/settings", {
    method: "PUT",
    body: settingsBody(redSettings.payload, {
      mode: "block",
      intensity: "standard",
      minimumPrimaryCoveragePercent: 60,
      maximumDepartmentGapMinutes: 180,
    }),
  });
  assert.equal(blockingSettings.response.status, 200, blockingSettings.text);
  const blockedAutomaticPlan = await requestJson("/api/schedule/auto", {
    method: "POST",
    body: {
      weekStart: WEEK,
      replaceExisting: true,
      locationId,
      departmentId: "",
    },
  });
  assert.equal(blockedAutomaticPlan.response.status, 409, blockedAutomaticPlan.text);
  assert.equal(blockedAutomaticPlan.payload.code, "BRANCH_SUPERVISION_BLOCKED");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE shift_date = ? AND location_id = ?")
      .get(DATE, locationId).count,
    0,
  );
});
