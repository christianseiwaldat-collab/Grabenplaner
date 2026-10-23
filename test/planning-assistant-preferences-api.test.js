"use strict";
const { sessionCsrf } = require("../test-support/portal-session-fixture");
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-planning-preferences-"));
Object.assign(process.env, { DB_PATH: path.join(root, "test.db"), BACKUP_DIR: path.join(root, "backups"),
  GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1",
  GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_TEST_TODAY: "2031-04-01", NODE_ENV: "test", TZ: "Europe/Vienna", DB_PROVIDER: "sqlite", DATABASE_URL: "" });
const { app, db, releaseInstanceLockForTests } = require("../server");
const LOCATION = "96", WEEK = "2031-04-07", DEV = "preferences-dev", STAFF = "preferences-staff";
const sessions = new Map(); let server, origin;
async function api(route, { actor = DEV, method = "GET", body, csrf = true } = {}) {
  const s = sessions.get(actor), response = await fetch(origin + route, { method, headers: {
    "Content-Type": "application/json", ...(s ? { Cookie: s.cookie } : {}), ...(csrf && s ? { "X-CSRF-Token": s.csrf } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
function payload(planningAssistant) {
  return { locationId: LOCATION, departmentId: null, breakAfterMinutes: 360, breakDurationMinutes: 30,
    ...(planningAssistant === undefined ? {} : { planningAssistant }) };
}
const enabled = { enabled: true, autoCheck: true, showInformational: true };
const assistantRoute = `/api/schedule/assistant?week=${WEEK}&locationId=${LOCATION}`;

test.before(async () => {
  db.prepare("INSERT INTO cost_centers(id,code,name,type,cost_center_type_id,active) VALUES(?,?,'BEISPIEL Einstellungen','branch','branch',1)").run(LOCATION, LOCATION);
  db.prepare("INSERT INTO locations(id,name,cost_center_id,min_staff,active) VALUES(?,'BEISPIEL Einstellungen',?,0,1)").run(LOCATION, LOCATION);
  for (const [id, role] of [[DEV, "developer"], [STAFF, "employee"]]) {
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,cost_center_id,position_id,contracted_hours,active) VALUES(?,?,?,?,?,'verkaufsmitarbeiter',4,1)").run(id, "BEISPIEL " + id, "BEISPIEL " + id, LOCATION, LOCATION);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,role_locked,active,must_change_password,password_changed_at) VALUES(?,'test',?,1,1,0,CURRENT_TIMESTAMP)").run(id, role);
    const token = crypto.randomBytes(24).toString("hex"), csrf = sessionCsrf(token);
    db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at,authenticated_at,absolute_expires_at) VALUES(?,?,?,'2099-01-01T00:00:00Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+8 hours'))").run(crypto.randomUUID(), id, crypto.createHash("sha256").update(token).digest("hex"));
    sessions.set(id, { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf });
  }
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close(); releaseInstanceLockForTests();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith("gp-planning-preferences-"));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("settings and planning responses supply backward-compatible enabled defaults", async () => {
  const result = await api(`/api/settings?locationId=${LOCATION}`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  for (const key of ["planning_assistant_enabled", "planning_assistant_auto_check", "planning_assistant_show_informational"]) assert.equal(result.data[key], "1");
  assert.equal((await api(assistantRoute)).status, 200);
});

test("saving planning switches requires authentication, settings rights, CSRF and strict booleans", async () => {
  const request = { method: "PUT", body: payload(enabled) };
  assert.equal((await api("/api/settings", { ...request, actor: "anonymous" })).status, 401);
  assert.equal((await api("/api/settings", { ...request, actor: STAFF })).status, 403);
  assert.equal((await api("/api/settings", { ...request, csrf: false })).status, 403);
  for (const invalid of [{ ...enabled, enabled: "false" }, { enabled: false }, { ...enabled, apiKey: "forbidden" }]) {
    const result = await api("/api/settings", { method: "PUT", body: payload(invalid) });
    assert.equal(result.status, 400, JSON.stringify(result.data)); assert.equal(result.data.code, "PLANNING_ASSISTANT_PREFERENCES_INVALID");
  }
  assert.equal(db.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'planning_assistant_%'").get().n, 0);
});

test("disabled assistant blocks direct assessments, proposals and apply without touching stored duties", async () => {
  const before = db.prepare("SELECT * FROM shifts ORDER BY id").all();
  const saved = await api("/api/settings", { method: "PUT", body: payload({ enabled: false, autoCheck: false, showInformational: false }) });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.planning_assistant_enabled, "0");
  for (const [route, options] of [[assistantRoute, {}], ["/api/schedule/assistant/proposals", { method: "POST", body: { week: WEEK, locationId: LOCATION, mode: "optimize" } }],
    ["/api/schedule/assistant/apply", { method: "POST", body: { proposalId: "stale", confirmed: true } }]]) {
    const result = await api(route, options); assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.code, "PLANNING_ASSISTANT_DISABLED");
  }
  assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), before);
  const audit = db.prepare("SELECT * FROM audit_log WHERE action='planning.assistant.preferences.update'").all();
  assert.equal(audit.length, 1);
  assert.equal((await api(`/api/settings?locationId=${LOCATION}`)).status, 200);
});

test("older settings saves preserve assistant switches and enabling manual checks keeps all findings", async () => {
  const legacy = await api("/api/settings", { method: "PUT", body: payload() });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.data)); assert.equal(legacy.data.planning_assistant_enabled, "0");
  const saved = await api("/api/settings", { method: "PUT", body: payload({ enabled: true, autoCheck: false, showInformational: false }) });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.planning_assistant_auto_check, "0"); assert.equal(saved.data.planning_assistant_show_informational, "0");
  const result = await api(assistantRoute); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert(result.data.assessment.findings.some(item => item.severity === "unknown"), "display preference must not remove unverified checks");
  const scopeKey = require("../lib/planning-assistant-settings").key({ locationId: LOCATION });
  const scoped = require("../lib/planning-assistant-settings");
  const initial = scoped.read({}, { locationId: LOCATION });
  const updated = await api("/api/settings/planning-assistant", { method: "PUT", body: {
    week: WEEK, locationId: LOCATION, departmentId: null, revision: initial.revision, configuration: structuredClone(scoped.DEFAULTS),
  } });
  assert.equal(updated.status, 200, JSON.stringify(updated.data)); assert(db.prepare("SELECT value FROM settings WHERE key=?").get(scopeKey));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='planning_assistant_auto_check'").get().value, "0");
});
