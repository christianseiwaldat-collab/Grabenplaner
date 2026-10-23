"use strict";
const { sessionCsrf } = require("../test-support/portal-session-fixture");
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-optimizer-"));
Object.assign(process.env, { DB_PATH: path.join(root, "test.db"), BACKUP_DIR: path.join(root, "backups"), GRABENPLANER_DATA_DIR: path.join(root, "data"),
  GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_TEST_TODAY: "2031-04-01", NODE_ENV: "test", TZ: "Europe/Vienna", DB_PROVIDER: "sqlite", DATABASE_URL: "" });
const { app, db, releaseInstanceLockForTests } = require("../server");
const ready = fs.existsSync(require("../lib/planning-optimizer-service").pythonPath());
if (process.env.GP_PLANNING_SOLVER_TEST === "1") assert(ready, "A real configured Python/OR-Tools runtime is required");
const WEEK = "2031-04-07", LOCATION = "97", DEV = "optimizer-dev", MANAGER = "optimizer-manager", STAFF = "optimizer-staff";
const sessions = new Map(); let server, origin, proposal;
async function api(route, { actor = DEV, method = "GET", body, csrf = true } = {}) {
  const s = sessions.get(actor), response = await fetch(origin + route, { method, headers: { "Content-Type": "application/json", ...(s ? { Cookie: s.cookie } : {}), ...(csrf && s ? { "X-CSRF-Token": s.csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
const options = { week: WEEK, locationId: LOCATION, departmentId: null, mode: "optimize" };
const endpoint = "/api/schedule/assistant/proposals", applyEndpoint = "/api/schedule/assistant/apply";
test.before(async () => {
  const days = JSON.stringify(Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map(day => [day, { open: day === "monday", start: "09:00", end: "13:00", minStaff: 1, minFrom: "09:00", minTo: "13:00", lunchEnabled: false }])));
  db.prepare("INSERT INTO cost_centers(id,code,name,type,cost_center_type_id,active) VALUES(?,?,'OPTIMIZER BEISPIEL','branch','branch',1)").run(LOCATION, LOCATION);
  db.prepare("INSERT INTO locations(id,name,cost_center_id,min_staff,day_settings_json,active) VALUES(?,'OPTIMIZER BEISPIEL',?,1,?,1)").run(LOCATION, LOCATION, days);
  for (const [id, role] of [[DEV, "developer"], [MANAGER, "manager"], [STAFF, "employee"]]) {
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,cost_center_id,position_id,contracted_hours,active) VALUES(?,?,?,?,?,'verkaufsmitarbeiter',4,1)").run(id, "BEISPIEL " + id, "BEISPIEL " + id, LOCATION, LOCATION);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,role_locked,active,must_change_password,password_changed_at) VALUES(?,'test',?,1,1,0,CURRENT_TIMESTAMP)").run(id, role);
    const token = crypto.randomBytes(24).toString("hex"), csrf = sessionCsrf(token);
    db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at, authenticated_at, absolute_expires_at) VALUES(?,?,?,'2099-01-01T00:00:00Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+8 hours'))").run(crypto.randomUUID(), id, crypto.createHash("sha256").update(token).digest("hex"));
    sessions.set(id, { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf });
  }
  db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,duty_code) VALUES(?,?,?,'09:00','13:00','general')").run(STAFF, LOCATION, WEEK);
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); db.close(); releaseInstanceLockForTests(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("gp-optimizer-")); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
test("optimizer requires current planning rights, own scope and CSRF before computation", async () => {
  assert.equal((await api(endpoint, { method: "POST", body: options, actor: "anonymous" })).status, 401);
  assert.equal((await api(endpoint, { method: "POST", body: options, actor: STAFF })).status, 403);
  assert.equal((await api(endpoint, { method: "POST", body: options, csrf: false })).status, 403);
  assert.equal((await api(endpoint, { method: "POST", body: { ...options, facts: {} } })).status, 400);
  assert.equal((await api(applyEndpoint, { method: "POST", body: { confirmed: false } })).status, 400);
});
test("real CP-SAT produces GP-validated proposals without changing stored duties", { skip: !ready }, async () => {
  const before = db.prepare("SELECT * FROM shifts ORDER BY id").all();
  const response = await api(endpoint, { method: "POST", body: options });
  assert.equal(response.status, 200, JSON.stringify(response.data)); proposal = response.data;
  assert(proposal.scenarios.length > 0, JSON.stringify(proposal));
  assert(proposal.scenarios.every(s => s.engine === "OR-Tools CP-SAT")); assert.equal(proposal.confirmationRequired, true);
  assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), before);
  assert(!JSON.stringify(proposal).includes("password"));
});
test("proposal confirmation is session-bound, explicit, atomic and idempotent", { skip: !ready }, async () => {
  assert(proposal); const scenario = proposal.scenarios.find(s => s.changes.length); assert(scenario, JSON.stringify(proposal));
  const body = { proposalId: proposal.id, scenarioId: scenario.id, confirmationToken: proposal.confirmationToken, confirmed: true };
  assert.equal((await api(applyEndpoint, { method: "POST", body: { ...body, confirmed: false } })).status, 400);
  assert.equal((await api(applyEndpoint, { method: "POST", body, actor: MANAGER })).status, 409);
  const response = await api(applyEndpoint, { method: "POST", body }); assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(response.data.applied, true);
  const after = db.prepare("SELECT * FROM shifts ORDER BY id").all();
  const repeated = await api(applyEndpoint, { method: "POST", body }); assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
  assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), after);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='planning.assistant.proposal.apply'").get().count, 1);
});
test("changes to availability invalidate a proposal before it can be applied", { skip: !ready }, async () => {
  const response = await api(endpoint, { method: "POST", body: options }); assert.equal(response.status, 200, JSON.stringify(response.data));
  const next = response.data; assert(next.scenarios.length);
  db.prepare("UPDATE employees SET contracted_hours=5 WHERE personnel_number=?").run(DEV);
  const before = db.prepare("SELECT * FROM shifts ORDER BY id").all();
  const result = await api(applyEndpoint, { method: "POST", body: { proposalId: next.id, scenarioId: next.scenarios[0].id, confirmationToken: next.confirmationToken, confirmed: true } });
  assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.code, "OPTIMIZER_PLAN_CHANGED");
  assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), before);
});
test("replacement proposals preserve unaffected shifts and never assign the absent person", { skip: !ready }, async () => {
  db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,cost_center_id,position_id,contracted_hours,active) VALUES('optimizer-reserve','BEISPIEL Reserve','BEISPIEL Reserve',?,?,'verkaufsmitarbeiter',4,1)").run(LOCATION, LOCATION);
  const before = db.prepare("SELECT * FROM shifts WHERE employee_number<>? ORDER BY id").all(STAFF);
  const response = await api(endpoint, { method: "POST", body: { ...options, mode: "replacement", absentEmployeeNumber: STAFF } });
  assert.equal(response.status, 200, JSON.stringify(response.data)); assert(response.data.scenarios.length, JSON.stringify(response.data));
  for (const s of response.data.scenarios) {
    assert(!s.shifts.some(shift => shift.employeeId === STAFF));
    assert(s.changes.some(c => c.kind === 'add' && c.employeeId === 'optimizer-reserve'));
    assert(s.changes.filter(c => c.kind === 'remove').every(c => c.employeeId === STAFF));
  }
  assert.deepEqual(db.prepare("SELECT * FROM shifts WHERE employee_number<>? ORDER BY id").all(STAFF), before);
});

test("a database failure rolls back every proposed change and audit, then the same confirmation can safely retry", { skip: !ready }, async () => {
  const response = await api(endpoint, { method: "POST", body: options }); assert.equal(response.status, 200, JSON.stringify(response.data));
  const next = response.data, scenario = next.scenarios.find(s => s.changes.length); assert(scenario, JSON.stringify(next));
  const before = db.prepare("SELECT * FROM shifts ORDER BY id").all(), audits = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
  const body = { proposalId: next.id, scenarioId: scenario.id, confirmationToken: next.confirmationToken, confirmed: true };
  db.exec("CREATE TRIGGER optimizer_synthetic_failure BEFORE INSERT ON shifts BEGIN SELECT RAISE(ABORT, 'SYNTHETIC rollback test'); END");
  try {
    const failed = await api(applyEndpoint, { method: 'POST', body }); assert(failed.status >= 400);
    assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n, audits);
  } finally { db.exec("DROP TRIGGER optimizer_synthetic_failure"); }
  const retried = await api(applyEndpoint, { method: 'POST', body }); assert.equal(retried.status, 200, JSON.stringify(retried.data)); assert.equal(retried.data.applied, true);
});

test("revoking the current user's planning rights invalidates outstanding confirmation", { skip: !ready }, async () => {
  const response = await api(endpoint, { method: "POST", body: options }); assert.equal(response.status, 200, JSON.stringify(response.data));
  const next = response.data; assert(next.scenarios.length);
  const before = db.prepare("SELECT * FROM shifts ORDER BY id").all();
  db.prepare("UPDATE portal_users SET role='employee' WHERE employee_number=?").run(DEV);
  try {
    const denied = await api(applyEndpoint, { method: 'POST', body: { proposalId: next.id, scenarioId: next.scenarios[0].id, confirmationToken: next.confirmationToken, confirmed: true } });
    assert.equal(denied.status, 403, JSON.stringify(denied.data)); assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), before);
  } finally { db.prepare("UPDATE portal_users SET role='developer' WHERE employee_number=?").run(DEV); }
});

test("an empty future week can be staffed by actual CP-SAT without writing before confirmation", { skip: !ready }, async () => {
  const week = '2031-04-28', before = db.prepare("SELECT * FROM shifts WHERE shift_date>=? ORDER BY id").all(week);
  assert.equal(before.length, 0);
  const response = await api(endpoint, { method: 'POST', body: { ...options, week } });
  assert.equal(response.status, 200, JSON.stringify(response.data)); assert(response.data.scenarios.length, JSON.stringify(response.data));
  assert(response.data.scenarios.every(s => s.shifts.length > 0 && s.changes.every(c => c.kind === 'add')));
  assert.deepEqual(db.prepare("SELECT * FROM shifts WHERE shift_date>=? ORDER BY id").all(week), before);
});

test("corrupted stored business constraints never fall back to an unrestricted optimization", { skip: !ready }, async () => {
  const key = require('../lib/planning-assistant-settings').key({ locationId: LOCATION, departmentId: null });
  db.prepare("INSERT INTO settings(key,value) VALUES(?,'broken') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key);
  try {
    const response = await api(endpoint, { method: 'POST', body: options });
    assert.equal(response.status, 409, JSON.stringify(response.data)); assert.equal(response.data.code, 'OPTIMIZER_CONFIGURATION_INVALID');
  } finally { db.prepare("DELETE FROM settings WHERE key=?").run(key); }
});

test("disabling the assistant invalidates an outstanding real proposal without changing duties", { skip: !ready }, async () => {
  const response = await api(endpoint, { method: "POST", body: options });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const next = response.data, scenario = next.scenarios.find(item => item.changes.length);
  assert(scenario, JSON.stringify(next));
  const before = db.prepare("SELECT * FROM shifts ORDER BY id").all();
  const audits = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='planning.assistant.proposal.apply'").get().n;
  const savePreferences = enabled => api("/api/settings", { method: "PUT", body: {
    locationId: LOCATION, departmentId: null, breakAfterMinutes: 360, breakDurationMinutes: 30,
    planningAssistant: { enabled, autoCheck: true, showInformational: true },
  } });
  try {
    const disabled = await savePreferences(false);
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
    const denied = await api(applyEndpoint, { method: "POST", body: {
      proposalId: next.id, scenarioId: scenario.id, confirmationToken: next.confirmationToken, confirmed: true,
    } });
    assert.equal(denied.status, 409, JSON.stringify(denied.data));
    assert.equal(denied.data.code, "PLANNING_ASSISTANT_DISABLED");
    assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='planning.assistant.proposal.apply'").get().n, audits);
  } finally {
    const restored = await savePreferences(true);
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
  }
});
