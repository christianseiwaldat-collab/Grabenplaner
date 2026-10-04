"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-maternity-mvp-"));
Object.assign(process.env, { DB_PATH: path.join(root, "synthetic.db"), BACKUP_DIR: path.join(root, "backups"),
  GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1",
  GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_TEST_AMU_SCANNER: "clean", NODE_ENV: "test", TZ: "Europe/Vienna" });
const { app, db, initializeApplicationPersistence, releaseInstanceLockForTests } = require("../server");
const SUBJECT = "00981", WEEK = "2032-07-05", FIELD = "employment.protectionStatus";
let server, baseUrl, locationId;
const users = {};
function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'synthetic',?,1,0,CURRENT_TIMESTAMP)").run(employeeNumber, role);
  db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-12-31T23:59:59.000Z')")
    .run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}
async function request(route, { method = "GET", body, auth = users.admin, skipPlanningBasis = false } = {}) {
  if (method === "PUT" && body && !skipPlanningBasis) {
    const standalone = /^\/api\/portal\/v1\/personnel-records\/[^/]+$/.test(route);
    const embedded = /^\/api\/employees\/[^/]+$/.test(route);
    const record = standalone ? body : embedded ? body.personnelRecord : null;
    const source = record?.sensitive || record || {};
    const employment = source.employment || {};
    const protects = ["protectionStatus", "retailKv"].some(key => Object.hasOwn(employment,key) || Object.hasOwn(source,key));
    if (record && protects && !Object.hasOwn(record,"planningStatusBasis")) {
      const target = route.split("/").at(-1);
      const loaded = await request("/api/portal/v1/personnel-records/" + target, {auth});
      if (loaded.status === 200) record.planningStatusBasis = loaded.payload.planningStatusBasis;
    }
  }
  const headers = { Accept: "application/json", Cookie: auth.cookie };
  if (method !== "GET") headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(baseUrl + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let payload; try { payload = JSON.parse(text); } catch { payload = { text }; }
  return { status: response.status, payload };
}
const period = (patch = {}) => ({ id: "private-period-synthetic", phase: "pregnancy", confirmed: true,
  validFrom: "2032-07-01", validTo: "2032-07-31", referenceId: "PRIVATE-EVIDENCE-SYNTHETIC", normalDailyMinutes: 480, ...patch });
const status = (patch = {}) => ({ version: 1, planningEnabled: true, periods: [period()], ...patch });
const save = (value, auth = users.admin, planningStatusBasis = undefined) => request(`/api/portal/v1/personnel-records/${SUBJECT}`, {
  method: "PUT", body: { sensitive: { employment: { protectionStatus: value } },
    ...(planningStatusBasis === undefined ? {} : { planningStatusBasis }) }, auth,
});
function employeeBody(employeeNumber = SUBJECT, nickname = "Synthetic Changed") {
  const original = db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(SUBJECT);
  return { personnelNumber: employeeNumber, fullName: "Synthetic Subject", nickname,
    contractedHours: 38.5, targetWorkdaysPerWeek: 5, positionId: original.position_id,
    homeLocationId: locationId, costCenterId: original.cost_center_id,
    preferredDepartmentId: original.preferred_department_id, preferredDayOff: "", fixedWorkdays: [],
    color: "#25705d", active: true,
    personnelRecord: { sensitive: { employment: { protectionStatus: status() } } } };
}
async function schedule(week = WEEK, auth = users.manager) {
  const value = await request(`/api/schedule?week=${week}&location=${encodeURIComponent(locationId)}`, { auth });
  assert.equal(value.status, 200, JSON.stringify(value.payload)); return value.payload;
}
function assertNeutral(value, { staticCatalog = false } = {}) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["PRIVATE-EVIDENCE-SYNTHETIC", "private-period-synthetic", "pregnancy", "postpartum", "breastfeeding", "employment_prohibition", "MSchG", "ris.mschg", "normalDailyMinutes", "referenceId"]) {
    // Existing adult/youth catalog limits legitimately contain this static
    // key. It stays forbidden in every person-associated plan and receipt.
    if (staticCatalog && forbidden === "normalDailyMinutes") continue;
    assert.ok(!serialized.includes(forbidden), `Protected marker leaked: ${forbidden}`);
  }
}
test.before(async () => {
  await initializeApplicationPersistence();
  const location = db.prepare("SELECT id,cost_center_id FROM locations WHERE active=1 ORDER BY id LIMIT 1").get();
  locationId = location.id;
  for (const role of ["admin", "hr", "developer", "it_admin", "manager", "location_planner"]) {
    const id = `maternity-synthetic-${role}`;
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,home_location_id,cost_center_id,time_confirmation_level,active) VALUES (?,?,?,'#25705d',38.5,5,?,?,'A',1)")
      .run(id, `Synthetic ${role}`, `Synthetic ${role}`, locationId, location.cost_center_id);
    users[role] = session(id, role);
    db.prepare("INSERT INTO portal_access_scopes(employee_number,location_id,assigned_by) VALUES (?,?,'test')").run(id, locationId);
    db.prepare("INSERT OR IGNORE INTO portal_permission_grants(employee_number,permission,granted_by) VALUES (?,'work_rules:read','synthetic')").run(id);
  }
  db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,target_workdays_per_week,home_location_id,cost_center_id,time_confirmation_level,active) VALUES (?,'Synthetic Subject','Synthetic Subject','#25705d',38.5,5,?,?,'A',1)")
    .run(SUBJECT, locationId, location.cost_center_id);
  db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,area,note) VALUES (?,?,'2032-07-06','19:00','21:00','synthetic','')").run(SUBJECT, locationId);
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("HR stores the atomic protected status encrypted and receives neutral planning receipts", async () => {
  const result = await save(status(), users.hr);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.ok(result.payload.changedFields.includes(FIELD));
  assert.ok(result.payload.workRuleAssessments.length > 0); assertNeutral(result.payload.workRuleAssessments);
  const record = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { auth: users.hr });
  assert.deepEqual(record.payload.profile.sensitive.employment.protectionStatus, status());
  const row = db.prepare("SELECT protected_payload FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT);
  assert.match(row.protected_payload, /^enc:v2:/); assertNeutral(row);
});
test("planners and IT-admin roles see restrictions but cannot read or change the private status", async () => {
  for (const role of ["manager", "location_planner", "it_admin"]) {
    const record = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { auth: users[role] });
    if (record.status === 200) {
      assert.equal(record.payload.access.fieldAccess[FIELD], "hidden");
      assert.ok(!Object.hasOwn(record.payload.profile.sensitive?.employment || {}, "protectionStatus"));
    } else assert.equal(record.status, 403);
    const denied = await save(status(), users[role]); assert.equal(denied.status, 403, JSON.stringify(denied.payload));
  }
  const plan = await schedule(); assertNeutral(plan.workRuleAssessment);
  const finding = plan.workRuleAssessment.findings.find(f => f.employeeNumber === SUBJECT && f.ruleId === "at.protection.time-window");
  assert.ok(finding, "Unconfirmed adult applicability must not hide protection findings");
  assert.equal(finding.effectiveEnforcement, "advisory"); assert.equal(finding.state, "attention");
  const receipts = db.prepare("SELECT result_json FROM work_rule_evaluation_runs").all();
  for (const receipt of receipts) assertNeutral(JSON.parse(receipt.result_json));
});

test("personal developer can read and edit protected status with a current opaque planning basis", async () => {
  const record = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { auth: users.developer });
  assert.equal(record.status, 200, JSON.stringify(record.payload));
  assert.equal(record.payload.access.fieldAccess[FIELD], "write");
  assert.deepEqual(record.payload.profile.sensitive.employment.protectionStatus, status());
  assert.match(record.payload.planningStatusBasis[FIELD], /^[0-9a-f]{64}$/);
  const changed = await save(status({ periods: [period({ normalDailyMinutes: 450 })] }), users.developer);
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  assert.ok(changed.payload.changedFields.includes(FIELD));
  assertNeutral(changed.payload.workRuleAssessments);
  const stale = await save(status(), users.developer, record.payload.planningStatusBasis);
  assert.equal(stale.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.code, "PERSONNEL_PLANNING_STATUS_CONCURRENT_CHANGE");
  const current = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { auth: users.developer });
  assert.equal(current.payload.profile.sensitive.employment.protectionStatus.periods[0].normalDailyMinutes, 450);
  assert.equal((await save(status(), users.developer)).status, 200);
});

test("public catalog, profiles and dashboard cannot join neutral restrictions to the private legal source", async () => {
  for (const role of ["manager", "location_planner", "it_admin"]) {
    for (const route of ["/api/work-rules/catalog", "/api/work-rules/profiles", "/api/work-rules/dashboard"]) {
      const value = await request(route, { auth: users[role] });
      assert.equal(value.status, 200, JSON.stringify(value.payload)); assertNeutral(value.payload, { staticCatalog: true });
      if (route.endsWith("catalog")) {
        assert.deepEqual(value.payload.profiles["at-planning-protection-monitor"].sourceRefs, []);
        assert.ok(value.payload.sources["ris.azg.3"], "Unrelated legal provenance remains available");
      }
    }
  }
  for (const role of ["hr", "developer"]) {
    for (const route of ["/api/work-rules/catalog", "/api/work-rules/profiles", "/api/work-rules/dashboard"]) {
      const privileged = await request(route, { auth: users[role] });
      assert.equal(privileged.status, 200, JSON.stringify(privileged.payload));
      assert.ok(JSON.stringify(privileged.payload).includes("ris.mschg.8"));
    }
  }
});
test("field matrix and direct aliases cannot bypass the new status boundary", async () => {
  const rights = await request("/api/portal/v1/personnel-field-rights");
  const deniedMatrix = await request("/api/portal/v1/personnel-field-rights/manager", { method: "PUT", body: { fields: { ...rights.payload.matrix.manager, [FIELD]: "write" } } });
  assert.equal(deniedMatrix.status, 400);
  db.prepare("INSERT INTO personnel_field_permissions(role_id,field_key,access_level,updated_by) VALUES ('manager',?,'write','synthetic')").run(FIELD);
  db.prepare("INSERT INTO portal_permission_grants(employee_number,permission,granted_by) VALUES (?,'personnel:sensitive:write','synthetic')").run("maternity-synthetic-manager");
  const deniedAlias = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { method: "PUT", auth: users.manager, body: { sensitive: { protectionStatus: status() } } });
  assert.equal(deniedAlias.status, 403, JSON.stringify(deniedAlias.payload));
});
test("local administrative sessions keep the new status hidden", () => {
  const code = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = code.indexOf("function applyPersonnelFieldAccessDependencies(");
  const end = code.indexOf("\nfunction personnelFieldEffectiveAccess", start);
  const context = vm.createContext({ personnelEmploymentDateFieldKeys: [], isLocalSystemSession: actor => actor?.localSystem === true || actor?.sessionKind === "local" });
  vm.runInContext(code.slice(start, end), context);
  const result = context.applyPersonnelFieldAccessDependencies({ [FIELD]: "write" }, { role: "admin", sessionKind: "local", localSystem: true });
  assert.equal(result[FIELD], "hidden");
  assert.equal(context.applyPersonnelFieldAccessDependencies({ [FIELD]: "write" }, { role: "hr", sessionKind: "employee" })[FIELD], "write");
});
test("activation is explicit and a changed basis requires renewed confirmation", async () => {
  assert.equal((await save(status({ planningEnabled: false }))).status, 200);
  assert.ok(!(await schedule()).workRuleAssessment.findings.some(f => f.employeeNumber === SUBJECT && f.ruleId.startsWith("at.protection.")));
  assert.equal((await save(status())).status, 200);
  const edited = period({ normalDailyMinutes: 450 }); delete edited.confirmed;
  assert.equal((await save(status({ periods: [edited] }))).status, 200);
  const record = await request(`/api/portal/v1/personnel-records/${SUBJECT}`);
  assert.equal(record.payload.profile.sensitive.employment.protectionStatus.periods[0].confirmed, false);
  assert.ok((await schedule()).workRuleAssessment.findings.some(f => f.employeeNumber === SUBJECT && f.ruleId === "at.protection.applicability" && f.resultState === "unknown"));
});
test("private malformed fields are rejected without changing status, audits or receipts", async () => {
  const before = db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT);
  const count = db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n;
  const result = await save({ ...status(), expectedBirthDate: "2032-09-01", diagnosis: "FORBIDDEN-MEDICAL-TEXT" });
  assert.equal(result.status, 400); assert.ok(!JSON.stringify(result.payload).includes("FORBIDDEN"));
  assert.deepEqual(db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT), before);
  assert.equal(db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n, count);
});
test("failed receipt insertion rolls the standalone status change back atomically", async () => {
  const failureBasis = (await request(`/api/portal/v1/personnel-records/${SUBJECT}`)).payload.planningStatusBasis;
  const before = db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT);
  const receiptCount = db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n;
  const auditCount = db.prepare("SELECT count(*) n FROM audit_log").get().n;
  db.exec("CREATE TRIGGER maternity_receipt_failure BEFORE INSERT ON work_rule_evaluation_runs BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  try {
    const result = await save(status({ periods: [period({ phase: "employment_prohibition" })] }), users.admin, failureBasis);
    assert.ok(result.status >= 500, JSON.stringify(result.payload));
    assert.deepEqual(db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT), before);
    assert.equal(db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n, receiptCount);
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log").get().n, auditCount);
  } finally { db.exec("DROP TRIGGER maternity_receipt_failure"); }
});

test("embedded employee update uses the same private transaction and rolls the whole change back", async () => {
  const good = await request(`/api/employees/${SUBJECT}`, { method: "PUT", auth: users.hr, body: employeeBody() });
  assert.equal(good.status, 200, JSON.stringify(good.payload)); assertNeutral(good.payload);
  const read = await request(`/api/portal/v1/personnel-records/${SUBJECT}`, { auth: users.hr });
  assert.deepEqual(read.payload.profile.sensitive.employment.protectionStatus, status());
  const before = db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT);
  const employeeBefore = db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(SUBJECT);
  const receiptCount = db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n;
  const auditCount = db.prepare("SELECT count(*) n FROM audit_log").get().n;
  db.exec("CREATE TRIGGER maternity_embedded_failure BEFORE INSERT ON work_rule_evaluation_runs BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  try {
    const body = employeeBody(SUBJECT, "Must Roll Back");
    body.personnelRecord.planningStatusBasis = read.payload.planningStatusBasis;
    body.personnelRecord.sensitive.employment.protectionStatus = status({ periods: [period({ phase: "employment_prohibition" })] });
    const failed = await request(`/api/employees/${SUBJECT}`, { method: "PUT", auth: users.hr, body });
    assert.ok(failed.status >= 500, JSON.stringify(failed.payload));
    assert.deepEqual(db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(SUBJECT), employeeBefore);
    assert.deepEqual(db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(SUBJECT), before);
    assert.equal(db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n, receiptCount);
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log").get().n, auditCount);
  } finally { db.exec("DROP TRIGGER maternity_embedded_failure"); }
});

test("embedded employee creation cannot leave a person behind when its protected receipt fails", async () => {
  const employeeNumber = "00982";
  const auditCount = db.prepare("SELECT count(*) n FROM audit_log").get().n;
  db.exec("CREATE TRIGGER maternity_creation_failure BEFORE INSERT ON work_rule_evaluation_runs BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  try {
    const failed = await request("/api/employees", { method: "POST", auth: users.hr, body: employeeBody(employeeNumber) });
    assert.ok(failed.status >= 500, JSON.stringify(failed.payload));
    assert.equal(db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(employeeNumber), undefined);
    assert.equal(db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(employeeNumber), undefined);
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log").get().n, auditCount);
  } finally { db.exec("DROP TRIGGER maternity_creation_failure"); }
  const good = await request("/api/employees", { method: "POST", auth: users.hr, body: employeeBody(employeeNumber) });
  assert.equal(good.status, 201, JSON.stringify(good.payload)); assertNeutral(good.payload);
  const read = await request(`/api/portal/v1/personnel-records/${employeeNumber}`, { auth: users.hr });
  assert.deepEqual(read.payload.profile.sensitive.employment.protectionStatus, status());
});

test("the public plan retains the full-week 40-hour monitor finding", async () => {
  const daySettings = Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map(day => [day, {
    open: true, start: "08:00", end: "17:00", lunchEnabled: true,
    lunchStart: "13:00", lunchEnd: "14:00", minStaff: 0, minFrom: "08:00", minTo: "17:00",
  }]));
  db.prepare("UPDATE locations SET day_settings_json=? WHERE id=?").run(JSON.stringify(daySettings), locationId);
  db.prepare("DELETE FROM shifts WHERE employee_number=?").run(SUBJECT);
  for (const date of ["2032-07-05", "2032-07-06", "2032-07-07", "2032-07-08", "2032-07-09", "2032-07-10"]) {
    db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,area,note) VALUES (?, ?, ?, '08:00','17:00','synthetic','')")
      .run(SUBJECT, locationId, date);
  }
  const result = await save(status()); assert.equal(result.status, 200, JSON.stringify(result.payload));
  const plan = (await schedule()).workRuleAssessment; assertNeutral(plan);
  const finding = plan.findings.find(row => row.employeeNumber === SUBJECT && row.ruleId === "at.protection.weekly-max");
  assert.ok(finding, "Week-scoped findings must survive the public period filter");
  assert.equal(finding.state, "attention", JSON.stringify(finding)); assert.equal(finding.effectiveEnforcement, "advisory");
  assert.equal(finding.evidence.actualMinutes, 2880); assert.equal(finding.evidence.maximumMinutes, 2400);
  assert.deepEqual(finding.scope, { type: "week", weekStart: WEEK, weekEnd: "2032-07-11" });
});

test("calendar-day totals do not falsely clear an unresolved cross-day working period", async () => {
  db.prepare("DELETE FROM shifts WHERE employee_number=?").run(SUBJECT);
  for (const [date, start, end] of [["2032-07-05", "16:00", "20:00"], ["2032-07-06", "07:00", "13:00"]]) {
    db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,area,note) VALUES (?,?,?,?,?,'synthetic','')")
      .run(SUBJECT, locationId, date, start, end);
  }
  const plan = (await schedule()).workRuleAssessment; assertNeutral(plan);
  const findings = plan.findings.filter(row => row.employeeNumber === SUBJECT && row.ruleId === "at.protection.daily-max");
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.equal(finding.resultState, "unknown", JSON.stringify(finding));
    assert.equal(finding.state, "manual_review"); assert.equal(finding.effectiveEnforcement, "advisory");
  }
});


function privateMutationSnapshot(employeeNumber = SUBJECT) {
  return {
    protected: db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number=?").get(employeeNumber),
    employee: db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(employeeNumber),
    receipts: db.prepare("SELECT count(*) n FROM work_rule_evaluation_runs").get().n,
    audits: db.prepare("SELECT count(*) n FROM audit_log").get().n,
  };
}
test("stale standalone HR draft cannot remove a concurrently added protection period", async () => {
  assert.equal((await save(status())).status,200);
  const loaded = await request("/api/portal/v1/personnel-records/" + SUBJECT,{auth:users.hr});
  const olderDraft = JSON.parse(JSON.stringify(loaded.payload.profile.sensitive.employment.protectionStatus));
  const firstDraft = JSON.parse(JSON.stringify(olderDraft));
  firstDraft.periods.push(period({id:"new-prohibition-synthetic",phase:"employment_prohibition",validFrom:"2032-08-01",validTo:"2032-08-31"}));
  assert.equal((await save(firstDraft,users.hr)).status,200);
  const before = privateMutationSnapshot();
  olderDraft.periods[0].normalDailyMinutes = 450;
  const stale = await request("/api/portal/v1/personnel-records/"+SUBJECT,{method:"PUT",auth:users.admin,
    body:{sensitive:{employment:{protectionStatus:olderDraft}},planningStatusBasis:loaded.payload.planningStatusBasis}});
  assert.equal(stale.status,409,JSON.stringify(stale.payload));
  assert.equal(stale.payload.code,"PERSONNEL_PLANNING_STATUS_CONCURRENT_CHANGE");
  assert.deepEqual(privateMutationSnapshot(),before);
  const after = await request("/api/portal/v1/personnel-records/"+SUBJECT,{auth:users.hr});
  assert.equal(after.payload.profile.sensitive.employment.protectionStatus.periods.length,2);
});
test("stale embedded employee draft rolls back employee, audit and protection receipts", async () => {
  assert.equal((await save(status())).status,200);
  const loaded = await request("/api/portal/v1/personnel-records/"+SUBJECT,{auth:users.hr});
  const body = employeeBody(SUBJECT,"Must Not Replace Employee");
  body.personnelRecord.planningStatusBasis = loaded.payload.planningStatusBasis;
  assert.equal((await save(status({periods:[period({normalDailyMinutes:450})]}),users.admin)).status,200);
  const before = privateMutationSnapshot();
  const stale = await request("/api/employees/"+SUBJECT,{method:"PUT",auth:users.hr,body});
  assert.equal(stale.status,409,JSON.stringify(stale.payload));
  assert.equal(stale.payload.code,"PERSONNEL_PLANNING_STATUS_CONCURRENT_CHANGE");
  assert.deepEqual(privateMutationSnapshot(),before);
});
test("existing protected structure requires a basis and another person's opaque token cannot authorize it", async () => {
  const before = privateMutationSnapshot();
  const missing = await request("/api/portal/v1/personnel-records/"+SUBJECT,{method:"PUT",skipPlanningBasis:true,
    body:{sensitive:{employment:{protectionStatus:status()}}}});
  assert.equal(missing.status,409); assert.deepEqual(privateMutationSnapshot(),before);
  const other = await request("/api/portal/v1/personnel-records/00982",{auth:users.hr});
  const wrong = await request("/api/portal/v1/personnel-records/"+SUBJECT,{method:"PUT",
    body:{sensitive:{employment:{protectionStatus:status()}},planningStatusBasis:other.payload.planningStatusBasis}});
  assert.equal(wrong.status,409);
});
test("confirmation changes invalidate the old structure basis and opaque tokens stay hidden from technical roles", async () => {
  assert.equal((await save(status())).status,200);
  const old = await request("/api/portal/v1/personnel-records/"+SUBJECT);
  assert.match(old.payload.planningStatusBasis[FIELD],/^[0-9a-f]{64}$/);
  assert.equal((await save(status({periods:[period({confirmed:false})]}),users.hr)).status,200);
  const fresh = await request("/api/portal/v1/personnel-records/"+SUBJECT);
  assert.notEqual(fresh.payload.planningStatusBasis[FIELD],old.payload.planningStatusBasis[FIELD]);
  const before = privateMutationSnapshot();
  const stale = await request("/api/portal/v1/personnel-records/"+SUBJECT,{method:"PUT",
    body:{sensitive:{employment:{protectionStatus:status()}},planningStatusBasis:old.payload.planningStatusBasis}});
  assert.equal(stale.status,409); assert.deepEqual(privateMutationSnapshot(),before);
  for (const role of ["manager","it_admin","location_planner"]) {
    const read = await request("/api/portal/v1/personnel-records/"+SUBJECT,{auth:users[role]});
    if (read.status === 200) assert.deepEqual(read.payload.planningStatusBasis,{});
  }
});
test("ordinary notes updates preserve the latest protection status and need no status basis", async () => {
  assert.equal((await save(status({periods:[period({phase:"employment_prohibition"})]}),users.hr)).status,200);
  const result = await request("/api/portal/v1/personnel-records/"+SUBJECT,{method:"PUT",skipPlanningBasis:true,
    body:{sensitive:{employment:{notes:"Synthetic unrelated note"}}}});
  assert.equal(result.status,200,JSON.stringify(result.payload));
  const after = await request("/api/portal/v1/personnel-records/"+SUBJECT,{auth:users.hr});
  assert.equal(after.payload.profile.sensitive.employment.protectionStatus.periods[0].phase,"employment_prohibition");
  assert.equal(after.payload.profile.sensitive.employment.notes,"Synthetic unrelated note");
});

test("two simultaneous HR editors with one opaque basis yield exactly one atomic commit", async () => {
  assert.equal((await save(status())).status,200);
  const loaded = await request("/api/portal/v1/personnel-records/"+SUBJECT,{auth:users.hr});
  const before = privateMutationSnapshot();
  const replies = await Promise.all([450,420].map((minutes,index) => request("/api/portal/v1/personnel-records/"+SUBJECT,{
    method:"PUT",auth:index ? users.admin : users.hr,
    body:{sensitive:{employment:{protectionStatus:status({periods:[period({normalDailyMinutes:minutes})]})}},
      planningStatusBasis:loaded.payload.planningStatusBasis}})));
  assert.deepEqual(replies.map(reply => reply.status).sort(),[200,409]);
  const winner = replies.find(reply => reply.status === 200);
  const after = privateMutationSnapshot();
  assert.equal(after.audits,before.audits+1);
  assert.equal(after.receipts,before.receipts+winner.payload.workRuleAssessments.length);
});
