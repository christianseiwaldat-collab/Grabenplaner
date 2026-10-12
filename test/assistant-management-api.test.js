"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-assistant-management-"));
Object.assign(process.env, { DB_PATH: path.join(root, "test.db"), BACKUP_DIR: path.join(root, "backups"), GRABENPLANER_DATA_DIR: path.join(root, "data"),
  GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_TEST_TODAY: "2031-04-01", NODE_ENV: "test", TZ: "Europe/Vienna",
  DB_PROVIDER: "sqlite", DATABASE_URL: "", GRABENPLANER_VOICE_ASSISTANT_ENABLED: "", GRABENPLANER_OPENAI_API_KEY: "SYNTHETIC-SECRET-NOT-FOR-CLIENTS" });
const { app, db, releaseInstanceLockForTests } = require("../server");
const LOCATION = "97", OTHER = "98", DEV = "assistant-developer", MANAGER = "assistant-manager", STAFF = "assistant-staff", FOREIGN = "assistant-foreign", ADMIN = "assistant-admin";
const VOICE = "/api/portal/v1/developer/voice-assistants", WEEK = "2031-04-07";
const sessions = new Map(); let server, origin, department;
function auth(id) {
  const token = crypto.randomBytes(24).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,?,?,'2099-01-01T00:00:00Z')").run(crypto.randomUUID(), id, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}
async function api(route, { actor = DEV, method = "GET", body, csrf = true } = {}) {
  const entry = sessions.get(actor), response = await fetch(origin + route, { method, headers: { "Content-Type": "application/json", ...(entry ? { Cookie: entry.cookie } : {}), ...(entry && csrf ? { "X-CSRF-Token": entry.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}
const route = (location = LOCATION, extra = "") => `/api/schedule/assistant?week=${WEEK}&locationId=${location}${extra}`;
test.before(async () => {
  const days = JSON.stringify(Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map(day => [day, { open: day === "monday", start: "09:00", end: "18:00", minStaff: 2, minFrom: "09:00", minTo: "18:00", lunchEnabled: false }])));
  for (const id of [LOCATION, OTHER]) {
    db.prepare("INSERT INTO cost_centers(id,code,name,type,cost_center_type_id,active) VALUES(?,?,?,'branch','branch',1)").run(id, id, "BEISPIEL " + id);
    db.prepare("INSERT INTO locations(id,name,cost_center_id,min_staff,day_settings_json,active) VALUES(?,?,?,2,?,1)").run(id, "BEISPIEL " + id, id, days);
  }
  department = Number(db.prepare("INSERT INTO departments(location_id,name,min_staff,active) VALUES(?,'BEISPIEL Abteilung',1,1) RETURNING id").get(LOCATION).id);
  for (const [id, role, location] of [[DEV, "developer", LOCATION], [MANAGER, "manager", LOCATION], [STAFF, "employee", LOCATION], [FOREIGN, "manager", OTHER], [ADMIN, "admin", LOCATION]]) {
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,cost_center_id,position_id,preferred_department_id,contracted_hours,active) VALUES(?,?,?,?,?,'verkaufsmitarbeiter',?,8,1)")
      .run(id, "BEISPIEL " + id, "BEISPIEL " + id, location, location, location === LOCATION ? department : null);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,role_locked,active,must_change_password,password_changed_at) VALUES(?,'test',?,1,1,0,CURRENT_TIMESTAMP)").run(id, role);
    sessions.set(id, auth(id));
  }
  db.prepare("INSERT INTO shifts(employee_number,location_id,department_id,shift_date,start_time,end_time) VALUES(?,?,?,?,'09:00','18:00')").run(STAFF, LOCATION, department, WEEK);
  db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,note) VALUES(?,?,?,'10:07','10:11','PRIVATE-OTHER-SHIFT')").run(STAFF, LOCATION, WEEK);
  db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time) VALUES(?,?,?,'09:00','18:00')").run(MANAGER, LOCATION, WEEK);
  db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time,note) VALUES(?,?,?,'09:00','18:00','PRIVATE-FOREIGN')").run(FOREIGN, OTHER, WEEK);
  db.prepare("INSERT INTO week_options(employee_number,week_start,date_from,date_to,option_type,all_day,start_time,end_time,note) VALUES(?,?,?,?,'time_off',0,'12:00','13:00','PRIVATE-ABSENCE-NOTE')").run(MANAGER, WEEK, WEEK, WEEK);
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); db.close(); releaseInstanceLockForTests();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("gp-assistant-management-")); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

test("voice.assistants requires a personal Developer session, not an admin or local bypass", async () => {
  assert.equal((await api(VOICE, { actor: "anonymous" })).status, 401);
  for (const actor of [MANAGER, STAFF, ADMIN]) assert.equal((await api(VOICE, { actor })).status, 403);
  const response = await api(VOICE); assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.settings.enabled, false); assert.equal(response.data.settings.portal.adminOnly, true);
  assert.equal(response.data.runtime.apiKeyConfigured, true); assert(!JSON.stringify(response.data).includes("SYNTHETIC-SECRET"));
});
test("voice settings enforce CSRF, optimistic revision, strict schema and audited persistent state", async () => {
  const before = (await api(VOICE)).data, body = { revision: before.revision, settings: { ...before.settings, enabled: true, maxSessionSeconds: 180 } };
  assert.equal((await api(VOICE, { method: "PUT", body, csrf: false })).status, 403);
  assert.equal((await api(VOICE, { method: "PUT", body: { ...body, apiKey: "NO" } })).status, 400);
  assert.equal((await api(VOICE, { method: "PUT", body: { ...body, settings: { ...body.settings, apiKey: "NO" } } })).status, 400);
  const saved = await api(VOICE, { method: "PUT", body }); assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.runtime.enabled, true);
  assert.notEqual(saved.data.revision, before.revision); assert.equal((await api(VOICE, { method: "PUT", body })).status, 409);
  const record = db.prepare("SELECT value FROM settings WHERE key='voice_assistants'").get(); assert.equal(JSON.parse(record.value).maxSessionSeconds, 180);
  const audit = db.prepare("SELECT detail FROM audit_log WHERE action='voice.assistants.settings.update' ORDER BY id DESC LIMIT 1").get(); assert(audit); assert(!audit.detail.includes("SYNTHETIC-SECRET"));
  db.prepare("UPDATE portal_users SET must_change_password=1 WHERE employee_number=?").run(DEV);
  assert.equal((await api(VOICE)).status, 428);
  db.prepare("UPDATE portal_users SET must_change_password=0 WHERE employee_number=?").run(DEV);
  const staff = await api("/api/portal/v1/me/assistant/status", { actor: STAFF }); assert.equal(staff.status, 200); assert.equal(staff.data.enabled, false);
  const admin = await api("/api/portal/v1/me/assistant/status", { actor: ADMIN }); assert.equal(admin.data.enabled, true); assert.equal(admin.data.maxSessionSeconds, 180);
  const disabled = await api(VOICE, { method: "PUT", body: { revision: saved.data.revision, settings: { ...saved.data.settings, portal: { ...saved.data.settings.portal, enabled: false } } } });
  assert.equal(disabled.status, 200); assert.equal((await api("/api/portal/v1/me/assistant/status")).data.enabled, false);
});
test("read-only planning route detects real stored collisions, absence, staffing, legal results and hides unrelated personnel", async () => {
  const before = db.prepare("SELECT id,employee_number,shift_date,start_time,end_time FROM shifts ORDER BY id").all();
  const response = await api(route(), { actor: MANAGER }); assert.equal(response.status, 200, JSON.stringify(response.data));
  const result = response.data.assessment, findings = result.findings;
  assert.equal(result.mode, "read_only"); assert(findings.some(item => item.ruleId === "gp.planning.overlap"));
  assert(findings.some(item => item.ruleId === "gp.planning.unavailable")); assert(findings.some(item => item.ruleId === "gp.planning.staffing" && item.startTime === "10:07"));
  assert(findings.some(item => item.ruleId === "gp.planning.work_rules"));
  assert(!JSON.stringify(response.data).includes(FOREIGN)); assert(!JSON.stringify(response.data).includes("PRIVATE-"));
  assert.equal(result.optimization.available, false); assert.deepEqual(db.prepare("SELECT id,employee_number,shift_date,start_time,end_time FROM shifts ORDER BY id").all(), before);
  const normal = await api(`/api/schedule?week=${WEEK}&locationId=${LOCATION}`, { actor: MANAGER }); assert.equal(normal.status, 200); assert.equal(normal.data.shifts.length, 3);
});
test("planning scope, own-only staff, query injection and session gates are enforced", async () => {
  assert.equal((await api(route(), { actor: "anonymous" })).status, 401);
  assert.equal((await api(route(), { actor: STAFF })).status, 403);
  assert.equal((await api(route(), { actor: FOREIGN })).status, 403);
  assert.equal((await api(route(OTHER), { actor: MANAGER })).status, 403);
  assert.equal((await api(route(LOCATION, "&employeeNumber=" + FOREIGN))).status, 400);
});
test("business requirements save in existing scoped settings with rights, validation, audit and stale-write protection", async () => {
  const before = await api(route()); assert.equal(before.status, 200, JSON.stringify(before.data));
  const body = { locationId: LOCATION, departmentId: null, week: WEEK, revision: before.data.configuration.revision,
    configuration: { weeklyToleranceMinutes: 15, requiredPositions: [{ positionId: "verkaufsmitarbeiter", count: 2 }], keyPersonNumbers: [MANAGER] } };
  const endpoint = "/api/settings/planning-assistant";
  assert.equal((await api(endpoint, { method: "PUT", body, csrf: false })).status, 403);
  assert.equal((await api(endpoint, { method: "PUT", body, actor: STAFF })).status, 403);
  assert.equal((await api(endpoint, { method: "PUT", body: { ...body, configuration: { ...body.configuration, keyPersonNumbers: [FOREIGN] } } })).status, 400);
  const saved = await api(endpoint, { method: "PUT", body }); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await api(endpoint, { method: "PUT", body })).status, 409);
  const fresh = await api(route()); assert.equal(fresh.status, 200); assert.equal(fresh.data.configuration.configuration.weeklyToleranceMinutes, 15);
  assert(fresh.data.assessment.findings.some(item => item.ruleId === "gp.planning.key_person" && item.startTime === "12:00"));
  assert(fresh.data.assessment.findings.some(item => item.ruleId === "gp.planning.position"));
  assert(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='planning.assistant.settings.update'").get().count > 0);
  for (const endpoint of [`/api/schedule?week=${WEEK}&locationId=${OTHER}`, `/api/settings?locationId=${OTHER}`]) {
    const ordinary = await api(endpoint, { actor: endpoint.startsWith("/api/settings") ? ADMIN : FOREIGN }); assert.equal(ordinary.status, 200, JSON.stringify(ordinary.data));
    const values = ordinary.data.settings || ordinary.data;
    assert(!Object.keys(values).some(key => key === "voice_assistants" || key.startsWith("planning_assistant:")));
  }
});
test("department settings and report do not assert whole-branch staffing or incomplete weekly totals", async () => {
  const response = await api(route(LOCATION, "&departmentId=" + department), { actor: MANAGER });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.configuration.configuration.weeklyToleranceMinutes, 0);
  assert(response.data.assessment.findings.some(item => item.severity === "unknown" && item.message.includes("filialweite Mindestbesetzung")));
  assert(response.data.assessment.findings.filter(item => item.ruleId === "gp.planning.weekly_target").every(item => item.severity === "unknown"));
});
test("revoked work-rule permission removes legal findings and stale Developer session cannot change settings", async () => {
  for (const permission of ["work_rules:read", "work_rules:planning:read"]) db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES(?,?,?)").run(MANAGER, permission, DEV);
  const denied = await api(route(), { actor: MANAGER }); assert.equal(denied.status, 200, JSON.stringify(denied.data));
  const legal = denied.data.assessment.findings.filter(item => item.ruleId === "gp.planning.work_rules"); assert.equal(legal.length, 1); assert.equal(legal[0].severity, "unknown"); assert(!legal[0].sourceRuleId);
  const before = await api(VOICE); db.prepare("DELETE FROM portal_sessions WHERE employee_number=?").run(DEV);
  assert.equal((await api(VOICE, { method: "PUT", body: { revision: before.data.revision, settings: before.data.settings } })).status, 401);
});
