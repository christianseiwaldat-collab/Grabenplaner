"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-youth-completion-"));
Object.assign(process.env, {
  DB_PATH: path.join(root, "synthetic.db"), BACKUP_DIR: path.join(root, "backups"),
  GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1",
  GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1",
  GRABENPLANER_TEST_AMU_SCANNER: "clean", NODE_ENV: "test", TZ: "Europe/Vienna",
});
const { app, db, evaluateTimeDay, countCreditedOptionDaysInRange, initializeApplicationPersistence, releaseInstanceLockForTests } = require("../server");
const YOUTH = "youth-completion-synthetic";
const ADMIN = "youth-completion-admin";
const MANAGER = "youth-completion-manager";
const WEEK = "2032-07-05";
let server, baseUrl, admin, manager, locationId, schoolId;
function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT INTO portal_users (employee_number,password_hash,role,active,must_change_password,password_changed_at)
    VALUES (?,'test-only',?,1,0,CURRENT_TIMESTAMP)`).run(employeeNumber, role);
  db.prepare(`INSERT INTO portal_sessions (id,employee_number,token_hash,expires_at)
    VALUES (?,?,?,'2099-12-31T23:59:59.000Z')`).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}
async function request(route, { method = "GET", body, auth = admin } = {}) {
  const headers = { Accept: "application/json", Cookie: auth.cookie };
  if (method !== "GET") headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(baseUrl + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let payload; try { payload = text ? JSON.parse(text) : null; } catch { payload = { text }; }
  return { status: response.status, payload };
}
const details = (patch = {}) => ({ version: 1, kind: "regular", startTime: "08:00", endTime: "17:00",
  lunchMinutes: 60, travelMinutes: null, confirmed: true, sourceReference: "Synthetic school timetable", specialCase: "none", ...patch });
const option = (patch = {}) => ({ employeeNumber: YOUTH, weekStart: WEEK, dateFrom: "2032-07-06", dateTo: "2032-07-06",
  optionType: "vocational_school", allDay: false, startTime: "08:00", endTime: "17:00", note: "synthetic", vocationalSchool: details(), ...patch });
const employment = { apprenticeshipStatus: "active", apprenticeshipConfirmed: true, apprenticeshipValidFrom: "2030-07-01",
  apprenticeshipValidTo: "", apprenticeshipSourceReference: "PRIVATE synthetic training contract" };
async function saveEmployment(patch, auth = admin) {
  return request(`/api/portal/v1/personnel-records/${YOUTH}`, { method: "PUT", body: { sensitive: { employment: patch } }, auth });
}
async function schedule(week = WEEK) {
  const result = await request(`/api/schedule?week=${week}&location=${encodeURIComponent(locationId)}`);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  return result.payload;
}
test.before(async () => {
  await initializeApplicationPersistence();
  const location = db.prepare("SELECT id,cost_center_id FROM locations WHERE active=1 ORDER BY id LIMIT 1").get();
  locationId = location.id;
  for (const [id, name] of [[ADMIN, "Synthetic Admin"], [MANAGER, "Synthetic Manager"], [YOUTH, "Synthetic Youth"]]) {
    db.prepare(`INSERT INTO employees (personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,
      home_location_id,cost_center_id,position_id,time_confirmation_level,active)
      VALUES (?,?,?,'#26785f',38.5,5,?,?,'lehrling','A',1)`).run(id, name, name, locationId, location.cost_center_id);
  }
  admin = session(ADMIN, "admin"); manager = session(MANAGER, "manager");
  db.prepare("INSERT INTO portal_access_scopes (employee_number,location_id,assigned_by) VALUES (?,?,'test')").run(MANAGER, locationId);
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("personal status persists protected, requires explicit confirmation, and remains private in plan findings", async () => {
  const saved = await request(`/api/portal/v1/personnel-records/${YOUTH}`, { method: "PUT", body: {
    sensitive: { identity: { birthDate: "2016-07-22" }, employment },
  } });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.ok(saved.payload.changedFields.includes("employment.apprenticeshipConfirmed"));
  const record = await request(`/api/portal/v1/personnel-records/${YOUTH}`);
  assert.deepEqual(Object.fromEntries(Object.keys(employment).map(key => [key, record.payload.profile.sensitive.employment[key]])), employment);
  const changed = await saveEmployment({ apprenticeshipSourceReference: "PRIVATE synthetic replacement" });
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  const unconfirmed = await request(`/api/portal/v1/personnel-records/${YOUTH}`);
  assert.equal(unconfirmed.payload.profile.sensitive.employment.apprenticeshipConfirmed, false);
  assert.equal((await saveEmployment(employment)).status, 200);
  assert.ok(!JSON.stringify((await schedule()).workRuleAssessment).includes("PRIVATE synthetic"));
});

test("field rights prevent a status editor from affirming private apprenticeship evidence", async () => {
  const rights = await request("/api/portal/v1/personnel-field-rights");
  assert.equal(rights.status, 200, JSON.stringify(rights.payload));
  const fields = { ...rights.payload.matrix.manager, "employment.apprenticeshipStatus": "write" };
  assert.equal((await request("/api/portal/v1/personnel-field-rights/manager", { method: "PUT", body: { fields } })).status, 200);
  const denied = await saveEmployment({ apprenticeshipStatus: "not_apprentice", apprenticeshipConfirmed: true }, manager);
  assert.equal(denied.status, 403, JSON.stringify(denied.payload));
  const changed = await saveEmployment({ apprenticeshipStatus: "not_apprentice" }, manager);
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  const actual = await request(`/api/portal/v1/personnel-records/${YOUTH}`);
  assert.equal(actual.payload.profile.sensitive.employment.apprenticeshipConfirmed, false);
  assert.equal(actual.payload.profile.sensitive.employment.apprenticeshipStatus, "not_apprentice");
  assert.equal((await saveEmployment(employment)).status, 200);
});

test("new school API rejects malformed evidence and an absence window omitting instruction", async () => {
  for (const vocationalSchool of [details({ travelMinutes: "0" }), details({ lunchMinutes: 540 }), details({ confirmed: "true" }), details({ sourceReference: "" })]) {
    const invalid = await request("/api/week-options", { method: "POST", body: option({ vocationalSchool }) });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.payload));
  }
  const window = await request("/api/week-options", { method: "POST", body: option({ endTime: "16:00" }) });
  assert.equal(window.status, 400, JSON.stringify(window.payload));
  assert.equal(db.prepare("SELECT count(*) n FROM week_options WHERE employee_number=?").get(YOUTH).n, 0);
});

test("school evidence survives SQLite CRUD; empty travel remains unknown; mutations produce monitor receipts", async () => {
  const before = db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n;
  const created = await request("/api/week-options", { method: "POST", body: option() });
  assert.equal(created.status, 201, JSON.stringify(created.payload)); schoolId = created.payload.id;
  assert.equal(created.payload.vocationalSchool.travelMinutes, null);
  assert.ok(created.payload.workRuleAssessments.length > 0);
  assert.ok(created.payload.workRuleAssessments.every(entry => entry.mode === "monitor"));
  assert.ok(db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n > before);
  const stored = JSON.parse(db.prepare("SELECT school_details_json FROM week_options WHERE id=?").get(schoolId).school_details_json);
  assert.deepEqual(stored, details());
  const plan = await schedule();
  assert.equal(JSON.parse(plan.weekOptions.find(entry => entry.id === schoolId).school_details_json).travelMinutes, null);
  const shift = await request("/api/shifts", { method: "POST", body: {
    employeeNumber: YOUTH, locationId, departmentId: "", date: "2032-07-06", startTime: "17:30", endTime: "19:00", area: "synthetic", note: "",
  } });
  assert.equal(shift.status, 201, JSON.stringify(shift.payload));
  const warning = shift.payload.workRuleAssessment.findings.find(entry => entry.employeeNumber === YOUTH && entry.ruleId === "at.kjbg.school.eight-hours");
  assert.equal(warning.resultState, "fail"); assert.equal(warning.effectiveEnforcement, "advisory");
  assert.equal(warning.snoozable, false);
  const day = await evaluateTimeDay(YOUTH, "2032-07-06", new Date("2032-07-07T12:00:00Z"));
  assert.equal(day.absenceCreditedMinutes, 480);
  assert.ok(day.issues.some(entry => entry.code === "missing_entries"), "Partial school must not excuse unbooked business work");
  const preflight = await request("/api/integrations/payroll-export/preflight", { method: "POST", body: {
    dateFrom: "2032-07-06", dateTo: "2032-07-06", locationId, departmentId: null,
    configuration: { layout: "movement_lines", sourceMode: "planned", format: "csv" },
  } });
  assert.equal(preflight.status, 200, JSON.stringify(preflight.payload));
  const schoolRow = preflight.payload.sampleRows.find(entry => entry.personnelNumber === YOUTH && entry.internalCode === "vocational_school");
  assert.equal(schoolRow.quantityMinutes, 480, JSON.stringify(preflight.payload));
});

test("editing school facts recalculates the present and future plan and preserves an immutable prior receipt", async () => {
  const future = await request("/api/shifts", { method: "POST", body: {
    employeeNumber: YOUTH, locationId, departmentId: "", date: "2032-07-12", startTime: "09:00", endTime: "12:00", area: "synthetic", note: "",
  } });
  assert.equal(future.status, 201, JSON.stringify(future.payload));
  const previous = db.prepare("SELECT id,input_sha256,result_json FROM work_rule_evaluation_runs ORDER BY rowid DESC LIMIT 1").get();
  const updated = await request(`/api/week-options/${schoolId}`, { method: "PUT", body: option({
    vocationalSchool: details({ endTime: "12:00", lunchMinutes: 0, travelMinutes: 30 }), endTime: "12:00",
  }) });
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.ok(updated.payload.workRuleAssessments.some(entry => entry.periodFrom === "2032-07-12"));
  assert.deepEqual(db.prepare("SELECT id,input_sha256,result_json FROM work_rule_evaluation_runs WHERE id=?").get(previous.id), previous);
  const findings = (await schedule()).workRuleAssessment.findings;
  assert.ok(!findings.some(entry => entry.employeeNumber === YOUTH && entry.ruleId === "at.kjbg.school.eight-hours"));
  const receipt = JSON.parse(db.prepare("SELECT result_json FROM work_rule_evaluation_runs WHERE period_from=? ORDER BY rowid DESC LIMIT 1").get(WEEK).result_json);
  const daily = receipt.employeeResults.find(entry => entry.employeeNumber === YOUTH).result.findings
    .find(entry => entry.ruleId === "at.kjbg.school.daily-combination" && entry.scope.date === "2032-07-06");
  assert.equal(daily.state, "pass");
});

test("receipt failure rolls back school creates, edits, and deletion atomically", async () => {
  const original = db.prepare("SELECT * FROM week_options WHERE id=?").get(schoolId);
  db.exec(`CREATE TRIGGER youth_receipt_failure BEFORE INSERT ON work_rule_evaluation_runs BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
  try {
    const created = await request("/api/week-options", { method: "POST", body: option({ dateFrom: "2032-07-07", dateTo: "2032-07-07" }) });
    assert.ok(created.status >= 500, JSON.stringify(created.payload));
    assert.equal(db.prepare("SELECT count(*) n FROM week_options WHERE employee_number=? AND date_from='2032-07-07'").get(YOUTH).n, 0);
    const edited = await request(`/api/week-options/${schoolId}`, { method: "PUT", body: option({ vocationalSchool: details({ endTime: "12:00", lunchMinutes: 0, travelMinutes: 90 }), endTime: "12:00" }) });
    assert.ok(edited.status >= 500, JSON.stringify(edited.payload));
    assert.deepEqual(db.prepare("SELECT * FROM week_options WHERE id=?").get(schoolId), original);
    const deleted = await request(`/api/week-options/${schoolId}`, { method: "DELETE" });
    assert.ok(deleted.status >= 500, JSON.stringify(deleted.payload));
    assert.deepEqual(db.prepare("SELECT * FROM week_options WHERE id=?").get(schoolId), original);
  } finally { db.exec("DROP TRIGGER youth_receipt_failure"); }
});

test("Legacy BS stays all-day/null and block courses force all-day; deletion removes current school facts", async () => {
  const legacy = await request("/api/week-options", { method: "POST", body: option({ dateFrom: "2032-07-08", dateTo: "2032-07-08", vocationalSchool: null, allDay: undefined }) });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.payload));
  assert.equal(legacy.payload.allDay, 1);
  assert.equal(db.prepare("SELECT school_details_json FROM week_options WHERE id=?").get(legacy.payload.id).school_details_json, null);
  const block = await request("/api/week-options", { method: "POST", body: option({ dateFrom: "2032-07-09", dateTo: "2032-07-11", vocationalSchool: details({ kind: "block" }) }) });
  assert.equal(block.status, 201, JSON.stringify(block.payload)); assert.equal(block.payload.allDay, 1);
  assert.equal((await request(`/api/week-options/${schoolId}`, { method: "DELETE" })).status, 204);
  assert.equal(db.prepare("SELECT id FROM week_options WHERE id=?").get(schoolId), undefined);
  assert.ok(!(await schedule()).workRuleAssessment.findings.some(entry => entry.employeeNumber === YOUTH
    && entry.ruleId === "at.kjbg.school.daily-combination" && entry.scope?.date === "2032-07-06"));
});

test("an existing enforced adult assignment retains original youth protection alongside the new monitor profile", async () => {
  db.prepare(`INSERT INTO work_rule_assignments (id,profile_version_id,scope_type,scope_key,valid_from,
    enforcement_mode,applicability_confirmed,confirmed_by,confirmed_at,active,created_by)
    VALUES ('synthetic-enforced-youth-base','at-retail-adult-monitor@2026.1','employee',?,'2032-01-01',
      'enforced',1,?,CURRENT_TIMESTAMP,1,?)`).run(YOUTH, ADMIN, ADMIN);
  try {
    const plan = await schedule();
    assert.ok(plan.workRuleAssessment.profiles.some(entry => entry.versionId === "at-retail-youth-monitor@2026.2"));
    assert.ok(plan.workRuleAssessment.profiles.some(entry => entry.versionId === "at-retail-youth-monitor@2026.3"));
    const shift = await request("/api/shifts", { method: "POST", body: {
      employeeNumber: YOUTH, locationId, departmentId: "", date: "2032-07-07", startTime: "19:00", endTime: "21:00", area: "synthetic", note: "",
    } });
    assert.equal(shift.status, 409, JSON.stringify(shift.payload));
    assert.equal(shift.payload.code, "WORK_RULE_PLAN_BLOCKED");
    assert.equal(db.prepare("SELECT count(*) n FROM shifts WHERE employee_number=? AND shift_date='2032-07-07'").get(YOUTH).n, 0);
  } finally { db.prepare("UPDATE work_rule_assignments SET active=0 WHERE id='synthetic-enforced-youth-base'").run(); }
});

test("school monitor remains visible for an adult apprentice with an unconfirmed general adult profile", async () => {
  const changed = await request(`/api/portal/v1/personnel-records/${YOUTH}`, { method: "PUT", body: {
    sensitive: { identity: { birthDate: "2013-07-22" } },
  } });
  assert.equal(changed.status, 200);
  db.prepare(`INSERT INTO work_rule_assignments (id,profile_version_id,scope_type,scope_key,valid_from,
    enforcement_mode,applicability_confirmed,active,created_by)
    VALUES ('synthetic-unconfirmed-adult','at-retail-adult-monitor@2026.1','employee',?,'2032-01-01',
      'enforced',0,1,?)`).run(YOUTH, ADMIN);
  const school = await request("/api/week-options", { method: "POST", body: option({ dateFrom: WEEK, dateTo: WEEK }) });
  assert.equal(school.status, 201, JSON.stringify(school.payload));
  const shift = await request("/api/shifts", { method: "POST", body: {
    employeeNumber: YOUTH, locationId, departmentId: "", date: WEEK, startTime: "17:30", endTime: "19:00", area: "synthetic", note: "",
  } });
  assert.equal(shift.status, 201, JSON.stringify(shift.payload));
  const adult = shift.payload.workRuleAssessment.findings.find(entry => entry.employeeNumber === YOUTH && entry.ruleId === "at.applicability.adult");
  assert.equal(adult.evidence.reason, "profile_not_confirmed");
  const eight = shift.payload.workRuleAssessment.findings.find(entry => entry.employeeNumber === YOUTH && entry.ruleId === "at.kjbg.school.eight-hours");
  assert.equal(eight.resultState, "fail");
  assert.equal(eight.effectiveEnforcement, "advisory");
});

test("explicit timed Sunday school has one consistent credit in plan, day account, and payroll while its special case stays open", async () => {
  const week = "2032-07-12", date = "2032-07-18";
  const created = await request("/api/week-options", { method: "POST", body: option({ weekStart: week, dateFrom: date, dateTo: date,
    vocationalSchool: details({ specialCase: "school_event" }),
  }) });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const row = db.prepare("SELECT * FROM week_options WHERE id=?").get(created.payload.id);
  assert.equal(countCreditedOptionDaysInRange(row, date, date, locationId), 1);
  assert.equal((await evaluateTimeDay(YOUTH, date, new Date("2032-07-19T12:00:00Z"))).absenceCreditedMinutes, 480);
  const payroll = await request("/api/integrations/payroll-export/preflight", { method: "POST", body: {
    dateFrom: date, dateTo: date, locationId, departmentId: null,
    configuration: { layout: "movement_lines", sourceMode: "planned", format: "csv" },
  } });
  assert.equal(payroll.status, 200, JSON.stringify(payroll.payload));
  assert.equal(payroll.payload.sampleRows.find(entry => entry.personnelNumber === YOUTH && entry.internalCode === "vocational_school").quantityMinutes, 480);
  const plan = await schedule(week);
  assert.ok(plan.workRuleAssessment.findings.some(entry => entry.employeeNumber === YOUTH && entry.ruleId === "at.kjbg.school.data" && entry.resultState === "unknown"));
});
