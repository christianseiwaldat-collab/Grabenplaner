"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-schedule-duty-"));
Object.assign(process.env, {
  DB_PATH: path.join(fixtureRoot, "fixture.db"), BACKUP_DIR: path.join(fixtureRoot, "backups"),
  GRABENPLANER_DATA_DIR: path.join(fixtureRoot, "app-data"), GRABENPLANER_HOST: "127.0.0.1",
  GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_TEST_AMU_SCANNER: "clean",
  GRABENPLANER_AMU_KEY_ID: "schedule-duty-test-v1", GRABENPLANER_AMU_KEY: Buffer.alloc(32, 0x42).toString("base64"),
  NODE_ENV: "test", TZ: "Europe/Vienna",
});
const subject = require("../server");
const { app, db } = subject;
const { assessBranchSupervision } = require("../lib/branch-supervision");
const { createAmuStorage } = require("../lib/amu-storage");
const protectedFixture = createAmuStorage({
  rootDirectory: path.join(fixtureRoot, "protected-fixture"), activeKeyId: process.env.GRABENPLANER_AMU_KEY_ID,
  encryptionKeys: { [process.env.GRABENPLANER_AMU_KEY_ID]: process.env.GRABENPLANER_AMU_KEY },
});
const ACTOR = "98970", FL = "98971", AL = "98972", GENERAL = "98973";
const LOCATION = "97", OTHER = "98", DATE = "2099-01-05";
let httpServer, baseUrl, cookie, csrf, departmentId, otherDepartmentId;
const body = (changes = {}) => ({ employeeNumber: FL, locationId: LOCATION, departmentId: "", date: DATE,
  startTime: "09:00", endTime: "17:00", area: "Unveränderter Freitext", note: "synthetic", ...changes });
async function request(route, method = "GET", payload) {
  const headers = { Cookie: cookie, Accept: "application/json" };
  if (method !== "GET") headers["X-CSRF-Token"] = csrf;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(baseUrl + route, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const text = await response.text();
  return { status: response.status, text, data: text ? JSON.parse(text) : null };
}
function assertStatus(result, status) { assert.equal(result.status, status, result.text); return result.data; }
const schedule = () => request(`/api/schedule?week=${DATE}&locationId=${LOCATION}`);
async function storeBirthDate(employeeNumber, birthDate) {
  await subject.organizationPersonnelRepository.upsertPersonnelSensitiveRecord({
    employeeNumber, socialSecurityLookup: "", actor: ACTOR,
    protectedPayload: protectedFixture.protectRecord(JSON.stringify({ identity: { birthDate } }), {
      namespace: "personnel-sensitive-record", recordId: employeeNumber, field: "payload", employeeNumber,
    }),
  });
}

test.before(async () => {
  const daySettings = Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    .map(day => [day, { open: day === "monday", start: "09:00", end: "18:00", lunchEnabled: false,
      lunchStart: "13:00", lunchEnd: "14:00", minStaff: 0, minFrom: "09:00", minTo: "18:00" }]));
  for (const location of [LOCATION, OTHER]) db.prepare("INSERT INTO locations(id,name,day_settings_json,active) VALUES(?,?,?,1)")
    .run(location, location === LOCATION ? "Prüffiliale" : "Zielfiliale", JSON.stringify(daySettings));
  departmentId = Number(db.prepare("INSERT INTO departments(location_id,name,active) VALUES(?,'Hardware',1)").run(LOCATION).lastInsertRowid);
  otherDepartmentId = Number(db.prepare("INSERT INTO departments(location_id,name,active) VALUES(?,'Fotowelt',1)").run(OTHER).lastInsertRowid);
  for (const [number, position] of [[ACTOR, "verkaufsmitarbeiter"], [FL, "teamleitung"], [AL, "abteilungsleitung"], [GENERAL, "verkaufsmitarbeiter"]]) {
    db.prepare(`INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,
      position_id,home_location_id,preferred_department_id,time_confirmation_level,active)
      VALUES(?,?,?,'#276353',8,1,?,?,?,'C',1)`).run(number, `Synthetic ${number}`, number, position, LOCATION, departmentId);
  }
  db.prepare(`INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at)
    VALUES(?,'test-only','manager',1,0,CURRENT_TIMESTAMP)`).run(ACTOR);
  for (const permission of ["schedule:read", "schedule:write", "work_rules:read", "settings:write", "time:review", "requests:read", "requests:decide"])
    db.prepare("INSERT OR IGNORE INTO portal_permission_grants(employee_number,permission,granted_by) VALUES(?,?,'synthetic')").run(ACTOR, permission);
  for (const location of [LOCATION, OTHER]) db.prepare(`INSERT INTO portal_access_scopes(employee_number,location_id,department_id,assigned_by)
    VALUES(?,?,0,'synthetic')`).run(ACTOR, location);
  const token = crypto.randomBytes(32).toString("hex"); csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,?,?,'2099-12-31T23:59:59.000Z')")
    .run(crypto.randomUUID(), ACTOR, crypto.createHash("sha256").update(token).digest("hex"));
  cookie = `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`;
  await new Promise(resolve => { httpServer = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});
test.beforeEach(() => {
  db.prepare("DELETE FROM shifts WHERE employee_number IN (?,?,?,?)").run(ACTOR, FL, AL, GENERAL);
  db.prepare("DELETE FROM employee_location_lendings WHERE employee_number IN (?,?,?,?)").run(ACTOR, FL, AL, GENERAL);
  db.prepare("DELETE FROM work_rule_assignments WHERE id LIKE 'schedule-window-test-%'").run();
  db.prepare("UPDATE employees SET fixed_workdays='' WHERE personnel_number IN (?,?,?,?)").run(ACTOR, FL, AL, GENERAL);
});
test.after(async () => {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Schnellansicht liefert Raster und Stunden vor den Hintergrundprüfungen", async () => {
  assertStatus(await request("/api/shifts", "POST", body()), 201);
  const fast = assertStatus(await request(`/api/schedule?week=${DATE}&locationId=${LOCATION}&fast=1`), 200);
  assert.equal(fast.enrichmentPending, true);
  assert.equal(fast.workRuleAssessment, null);
  assert.equal(fast.branchSupervisionAssessment, null);
  assert.equal(fast.saturdayStats.pending, true);
  assert.equal(fast.shifts.length, 1);
  assert.ok(fast.totals[FL] > 0);

  const enrichment = assertStatus(await request(`/api/schedule/enrichment?week=${DATE}&locationId=${LOCATION}`), 200);
  assert.equal(enrichment.enrichmentPending, false);
  assert.ok(enrichment.workRuleAssessment);
  assert.ok(enrichment.branchSupervisionAssessment);
  assert.equal(Object.hasOwn(enrichment, "totals"), false);

  const full = assertStatus(await schedule(), 200);
  assert.equal(full.enrichmentPending, false);
  assert.deepEqual(fast.shifts, full.shifts);
  assert.deepEqual(fast.totals, full.totals);
  assert.deepEqual(enrichment.workRuleAssessment, full.workRuleAssessment);
  assert.deepEqual(enrichment.branchSupervisionAssessment, full.branchSupervisionAssessment);
});

test("Dienst wird getrennt gespeichert, gelesen und bei alten PUT-Clients bewahrt", async () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='schedule-duty-v1'").get());
  const created = assertStatus(await request("/api/shifts", "POST", body()), 201);
  assert.equal(created.dutyCode, "branch_supervision");
  const row = db.prepare("SELECT duty_code,department_id,area FROM shifts WHERE id=?").get(created.id);
  assert.equal(row.duty_code, "branch_supervision"); assert.equal(row.department_id, null);
  assert.equal(row.area, "Unveränderter Freitext");
  assert.equal(assertStatus(await schedule(), 200).shifts.find(shift => shift.id === created.id).duty_code, "branch_supervision");
  const general = assertStatus(await request(`/api/shifts/${created.id}`, "PUT", body({ dutyCode: "general" })), 200);
  assert.equal(general.dutyCode, "general");
  assert.equal(assertStatus(await request(`/api/shifts/${created.id}`, "PUT", body()), 200).dutyCode, "general");
  assert.equal(assertStatus(await request(`/api/shifts/${created.id}`, "PUT", body({ departmentId })), 200).dutyCode, "department");
  const omittedDepartment = body(); delete omittedDepartment.departmentId;
  assert.equal(assertStatus(await request(`/api/shifts/${created.id}`, "PUT", omittedDepartment), 200).departmentId, departmentId);
  assert.equal(assertStatus(await request(`/api/shifts/${created.id}`, "PUT", body()), 200).dutyCode, "branch_supervision");
  db.prepare("UPDATE shifts SET duty_code='' WHERE id=?").run(created.id);
  assert.equal(assertStatus(await request(`/api/shifts/${created.id}`, "PUT", body()), 200).dutyCode, "");
  assert.throws(() => db.prepare("UPDATE shifts SET duty_code='invalid' WHERE id=?").run(created.id), /CHECK/);
  assert.throws(() => db.prepare("UPDATE shifts SET duty_code='department',department_id=NULL WHERE id=?").run(created.id), /CHECK/);
  assert.throws(() => db.prepare("UPDATE shifts SET duty_code='branch_supervision',department_id=? WHERE id=?").run(departmentId, created.id), /CHECK/);
  assert.throws(() => db.prepare("UPDATE shifts SET duty_code='general',department_id=? WHERE id=?").run(departmentId, created.id), /CHECK/);
});

test("Duty-Validierung verhindert vermischte Abteilungen, verleiht aber keine Qualifikation", async () => {
  for (const override of [{ dutyCode: "invalid" }, { dutyCode: null }, { dutyCode: "department" },
    { dutyCode: "general", departmentId }, { dutyCode: "branch_supervision", departmentId }]) {
    assertStatus(await request("/api/shifts", "POST", body(override)), 400);
  }
  assert.equal(assertStatus(await request("/api/shifts", "POST", body({ departmentId })), 201).dutyCode, "department");
  const unqualified = assertStatus(await request("/api/shifts", "POST", body({ employeeNumber: GENERAL, dutyCode: "branch_supervision" })), 201);
  assert.equal(unqualified.dutyCode, "branch_supervision");
  const settings = { branch_supervision_mode: "red", monday_open: "1", monday_start_time: "09:00", monday_end_time: "18:00" };
  const input = { weekStart: DATE, weekEnd: DATE, locationId: LOCATION, settings,
    employees: [{ personnel_number: GENERAL, position_id: "verkaufsmitarbeiter" }],
    shifts: [{ employee_number: GENERAL, location_id: LOCATION, shift_date: DATE, start_time: "09:00", end_time: "18:00", duty_code: "branch_supervision" }] };
  assert.equal(assessBranchSupervision(input).days[0].primaryCoveragePercent, 0);
  input.employees[0].position_id = "teamleitung";
  assert.equal(assessBranchSupervision(input).days[0].primaryCoveragePercent, 100);
  for (const code of ["general", "department"]) {
    input.shifts[0].duty_code = code;
    assert.equal(assessBranchSupervision(input).days[0].primaryCoveragePercent, 0);
  }
  input.shifts[0].duty_code = ""; input.shifts[0].department_id = departmentId;
  assert.equal(assessBranchSupervision(input).days[0].primaryCoveragePercent, 100);
});

test("Automatik setzt FL filialweit, respektiert aber einen ausdrücklich gebundenen Abteilungsfilter", async () => {
  const all = assertStatus(await request("/api/schedule/auto", "POST", { weekStart: DATE, locationId: LOCATION, replaceExisting: true }), 200);
  const fl = all.schedule.shifts.find(shift => shift.employee_number === FL);
  assert.ok(fl); assert.equal(fl.duty_code, "branch_supervision"); assert.equal(fl.department_id, null);
  const scoped = assertStatus(await request("/api/schedule/auto", "POST", { weekStart: DATE, locationId: LOCATION, departmentId, replaceExisting: true }), 200);
  // An existing unbound FL shift outside the replacement filter must not be rewritten.
  assert.equal(db.prepare("SELECT duty_code FROM shifts WHERE id=?").get(fl.id).duty_code, "branch_supervision");
  db.prepare("DELETE FROM shifts WHERE employee_number IN (?,?,?,?)").run(ACTOR, FL, AL, GENERAL);
  assertStatus(await request("/api/schedule/auto", "POST", { weekStart: DATE, locationId: LOCATION, departmentId, replaceExisting: true }), 200);
  const bound = db.prepare("SELECT duty_code,department_id FROM shifts WHERE employee_number=?").get(FL);
  assert.equal(bound.duty_code, "department"); assert.equal(bound.department_id, departmentId);
  assert.ok(scoped.schedule);
});

test("ZA-Aufteilung, Originalsnapshot und Rücknahme behalten die ausdrücklich gewählte Dienstzuordnung", async () => {
  assertStatus(await request("/api/shifts", "POST", body({ dutyCode: "general" })), 201);
  const id = Number(db.prepare(`INSERT INTO time_off_requests(employee_number,location_id,request_date,date_from,date_to,all_day,
    start_time,end_time,note,status,approval_type,approval_stage)
    VALUES(?,?,?,?,?,0,'12:00','14:00','synthetic','pending','local','local')`).run(FL, LOCATION, DATE, DATE, DATE).lastInsertRowid);
  assertStatus(await request(`/api/portal/v1/time-off-requests/${id}/decision`, "PUT", { decision: "approved" }), 200);
  const original = JSON.parse(db.prepare("SELECT original_shifts_json FROM time_off_requests WHERE id=?").get(id).original_shifts_json);
  assert.equal(original[0].duty_code, "general");
  assert.deepEqual(db.prepare("SELECT duty_code FROM shifts WHERE employee_number=? ORDER BY start_time").all(FL).map(row => row.duty_code), ["general", "general"]);
  assertStatus(await request(`/api/portal/v1/absence-requests/time_off/${id}/action`, "PUT", { action: "cancel", note: "synthetic restore" }), 200);
  const restored = db.prepare("SELECT duty_code,start_time,end_time FROM shifts WHERE employee_number=?").get(FL);
  assert.equal(restored.duty_code, "general"); assert.equal(restored.start_time, "09:00"); assert.equal(restored.end_time, "17:00");
});

test("PDF-Einsatzprojektion enthält nur gedeckte Fremddienste und eine datensparsame Feldliste", async () => {
  db.prepare(`INSERT INTO employee_location_lendings(id,employee_number,home_location_id,destination_location_id,destination_department_id,
    date_from,date_to,all_day,start_time,end_time,created_by,created_at,updated_by,updated_at)
    VALUES('duty-assignment',?,?,?,?,?,?,0,'10:00','16:00','synthetic',CURRENT_TIMESTAMP,'synthetic',CURRENT_TIMESTAMP)`)
    .run(FL, LOCATION, OTHER, otherDepartmentId, DATE, DATE);
  assertStatus(await request("/api/shifts", "POST", body({ locationId: OTHER, departmentId: otherDepartmentId, dutyCode: "department", startTime: "10:00", endTime: "16:00" })), 201);
  const result = assertStatus(await schedule(), 200).pdfStaffAssignmentShifts;
  assert.equal(result.length, 1); assert.equal(result[0].duty_code, "department");
  assert.equal(result[0].department_name, "Fotowelt"); assert.equal(result[0].location_name, "Zielfiliale");
  assert.deepEqual(Object.keys(result[0]).sort(), ["employee_number", "shift_date", "start_time", "end_time", "department_id", "department_name", "duty_code", "location_id", "location_name"].sort());
  const target = assertStatus(await request(`/api/schedule?week=${DATE}&locationId=${OTHER}`), 200);
  assert.deepEqual(target.pdfStaffAssignmentShifts, []);
});

test("Manuelle Dienste und Vorschau verwenden 07–23 Uhr auch bei geschlossener Filiale und am Sonntag", async () => {
  const saturday = body({ date: "2099-01-10", startTime: "19:00", endTime: "21:00", dutyCode: "general" });
  const preview = assertStatus(await request("/api/work-rules/evaluate", "POST", {
    weekStart: DATE, locationId: LOCATION, shift: saturday,
  }), 200);
  assert.equal(preview.candidate.endTime, "21:00");
  const created = assertStatus(await request("/api/shifts", "POST", saturday), 201);
  assert.equal(created.endTime, "21:00");
  const updated = assertStatus(await request(`/api/shifts/${created.id}`, "PUT", { ...saturday, endTime: "23:00" }), 200);
  assert.equal(updated.endTime, "23:00");
  const sunday = body({ date: "2099-01-11", startTime: "07:00", endTime: "08:00" });
  assertStatus(await request("/api/shifts", "POST", sunday), 201);
  assertStatus(await request("/api/shifts", "POST", body({ date: "2099-01-07", startTime: "07:00", endTime: "08:00" })), 201);
  for (const times of [{ startTime: "06:59", endTime: "08:00" },
    { startTime: "22:00", endTime: "23:01" }, { startTime: "23:00", endTime: "07:00" }]) {
    const invalid = assertStatus(await request("/api/shifts", "POST", { ...sunday, ...times }), 400);
    assert.equal(invalid.code, "SHIFT_PLANNING_WINDOW_INVALID");
    assertStatus(await request(`/api/shifts/${created.id}`, "PUT", { ...saturday, ...times }), 400);
    assertStatus(await request("/api/work-rules/evaluate", "POST", {
      weekStart: DATE, locationId: LOCATION, shift: { ...sunday, ...times },
    }), 400);
  }
  assert.equal(db.prepare("SELECT end_time FROM shifts WHERE id=?").get(created.id).end_time, "23:00");
});

test("Erweiterte Dienstzeiten bewahren Überschneidungen und feste vertragliche Wochentage", async () => {
  const saturday = body({ date: "2099-01-10", startTime: "19:00", endTime: "21:00" });
  assertStatus(await request("/api/shifts", "POST", saturday), 201);
  const conflict = assertStatus(await request("/api/shifts", "POST", { ...saturday, startTime: "20:00", endTime: "22:00" }), 409);
  assert.equal(conflict.code, "SHIFT_TIME_CONFLICT");
  db.prepare("UPDATE employees SET fixed_workdays='monday' WHERE personnel_number=?").run(FL);
  const denied = assertStatus(await request("/api/shifts", "POST", body({ date: "2099-01-11", startTime: "07:00", endTime: "08:00" })), 409);
  assert.match(denied.error, /fix vereinbarten Arbeitstag/);
});

test("07–23 bewahrt Sonn-/Feiertags- und Ruhezeithinweise sowie harte Höchstgrenzen", async () => {
  await storeBirthDate(FL, "1990-01-01");
  db.prepare(`INSERT INTO work_rule_assignments
    (id,profile_version_id,scope_type,scope_key,valid_from,valid_to,enforcement_mode,
     applicability_confirmed,confirmed_by,confirmed_at,active,created_by)
    VALUES('schedule-window-test-enforced','at-retail-adult-monitor@2026.1','employee',?,'2099-01-01',NULL,
      'enforced',1,?,CURRENT_TIMESTAMP,1,?)`).run(FL, ACTOR, ACTOR);
  const sunday = body({ date: "2099-01-11", startTime: "10:00", endTime: "11:00" });
  const preview = assertStatus(await request("/api/work-rules/evaluate", "POST", {
    weekStart: DATE, locationId: LOCATION, shift: sunday,
  }), 200);
  assert.match(JSON.stringify(preview), /at\.arg\.sunday-work/);
  const sundayResult = assertStatus(await request("/api/shifts", "POST", sunday), 201);
  assert.equal(sundayResult.workRuleAssessment.outcome, "manual_review");
  const sundayFinding = sundayResult.workRuleAssessment.findings.find(finding => finding.ruleId === "at.arg.sunday-work");
  assert.equal(sundayFinding.effectiveEnforcement, "exception_required");
  const holiday = body({ date: "2099-01-06", startTime: "10:00", endTime: "11:00" });
  const holidayResult = assertStatus(await request("/api/shifts", "POST", holiday), 201);
  assert.ok(holidayResult.workRuleAssessment.findings.some(finding => finding.ruleId === "at.arg.holiday-work"));
  db.prepare("DELETE FROM shifts WHERE employee_number=?").run(FL);
  assertStatus(await request("/api/shifts", "POST", body({ startTime: "19:00", endTime: "23:00" })), 201);
  const tooSoon = body({ date: "2099-01-06", startTime: "07:00", endTime: "09:00" });
  const restPreview = assertStatus(await request("/api/work-rules/evaluate", "POST", {
    weekStart: DATE, locationId: LOCATION, shift: tooSoon,
  }), 200);
  assert.match(JSON.stringify(restPreview), /at\.azg\.daily-rest/);
  const restResult = assertStatus(await request("/api/shifts", "POST", tooSoon), 201);
  assert.ok(restResult.workRuleAssessment.findings.some(finding => finding.ruleId === "at.azg.daily-rest"));
  const tooLong = body({ date: "2099-01-07", startTime: "07:00", endTime: "23:00" });
  assert.equal(assertStatus(await request("/api/shifts", "POST", tooLong), 409).code, "WORK_RULE_PLAN_BLOCKED");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE employee_number=?").get(FL).count, 2);
});

test("Jugendschutz verbietet Abend- und Sonntagsdienst auch innerhalb des erweiterten Planungsfensters", async () => {
  await storeBirthDate(GENERAL, "2082-01-01");
  db.prepare(`INSERT INTO work_rule_assignments
    (id,profile_version_id,scope_type,scope_key,valid_from,valid_to,enforcement_mode,
     applicability_confirmed,confirmed_by,confirmed_at,active,created_by)
    VALUES('schedule-window-test-youth','at-retail-adult-monitor@2026.1','employee',?,'2099-01-01',NULL,
      'enforced',1,?,CURRENT_TIMESTAMP,1,?)`).run(GENERAL, ACTOR, ACTOR);
  for (const shift of [body({ employeeNumber: GENERAL, startTime: "19:00", endTime: "21:00" }),
    body({ employeeNumber: GENERAL, date: "2099-01-11", startTime: "10:00", endTime: "11:00" })]) {
    const result = assertStatus(await request("/api/shifts", "POST", shift), 409);
    assert.equal(result.code, "WORK_RULE_PLAN_BLOCKED");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE employee_number=?").get(GENERAL).count, 0);
});

test("Explizite Tagessperren und Abwesenheiten gelten auch bei geschlossener Filiale", async () => {
  const globalId = assertStatus(await request("/api/global-day-blocks", "POST", {
    locationId: LOCATION, weekStart: DATE, blockDate: "2099-01-11", reason: "Synthetic explicit block",
  }), 201).id;
  const optionId = db.prepare(`INSERT INTO week_options(employee_number,week_start,date_from,date_to,option_type,all_day)
    VALUES(?,?,'2099-01-07','2099-01-07','vacation',1)`).run(AL, DATE).lastInsertRowid;
  try {
    const blocked = assertStatus(await request("/api/shifts", "POST", body({ employeeNumber: AL,
      date: "2099-01-11", startTime: "10:00", endTime: "11:00" })), 409);
    assert.match(blocked.error, /für alle gesperrt/);
    const absent = assertStatus(await request("/api/shifts", "POST", body({ employeeNumber: AL,
      date: "2099-01-07", startTime: "19:00", endTime: "21:00" })), 409);
    assert.match(absent.error, /Urlaub/);
  } finally {
    assertStatus(await request(`/api/global-day-blocks/${globalId}`, "DELETE"), 204);
    db.prepare("DELETE FROM week_options WHERE id=?").run(optionId);
  }
});

test("Einstellungen lassen sich ohne freie Samstagswerte speichern und überschreiben keine Legacy-Werte", async () => {
  const settings = assertStatus(await request(`/api/settings?locationId=${LOCATION}`), 200);
  const readLegacy = () => db.prepare("SELECT key,value FROM settings WHERE key IN ('saturday_bonus_enabled','saturday_bonus_from','saturday_bonus_factor') ORDER BY key").all();
  const before = readLegacy();
  const payload = { locationId: LOCATION, breakAfterMinutes: Number(settings.break_after_minutes),
    breakDurationMinutes: Number(settings.break_duration_minutes),
    externalBackupEnabled: settings.external_backup_enabled !== "0", backupDirectory: settings.backup_directory,
    backupIntervalHours: Number(settings.backup_interval_hours || 2) };
  assertStatus(await request("/api/settings", "PUT", payload), 200);
  assert.deepEqual(readLegacy(), before);
  assertStatus(await request("/api/settings", "PUT", { ...payload,
    saturdayBonusEnabled: false, saturdayBonusFrom: "not-a-time", saturdayBonusFactor: 999 }), 200);
  assert.deepEqual(readLegacy(), before);
});

test("Verschachtelte Dienstvorschau darf keinen erlaubten Abteilungsfilter verlassen", async () => {
  const forbiddenDepartmentId = Number(db.prepare("INSERT INTO departments(location_id,name,active) VALUES(?,'Geschützter Prüfbereich',1)")
    .run(LOCATION).lastInsertRowid);
  db.prepare("UPDATE portal_access_scopes SET department_id=? WHERE employee_number=? AND location_id=?")
    .run(departmentId, ACTOR, LOCATION);
  try {
    const payload = { weekStart: DATE, locationId: LOCATION, departmentId,
      shift: body({ departmentId, dutyCode: "department" }) };
    assertStatus(await request("/api/work-rules/evaluate", "POST", payload), 200);
    assertStatus(await request("/api/work-rules/evaluate", "POST", { ...payload,
      shift: { ...payload.shift, departmentId: forbiddenDepartmentId } }), 403);
    assertStatus(await request("/api/work-rules/evaluate", "POST", { ...payload,
      shift: { ...payload.shift, departmentId: "", dutyCode: "general" } }), 403);
  } finally {
    db.prepare("UPDATE portal_access_scopes SET department_id=0 WHERE employee_number=? AND location_id=?").run(ACTOR, LOCATION);
    db.prepare("DELETE FROM departments WHERE id=?").run(forbiddenDepartmentId);
  }
});
