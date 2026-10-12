"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-voice-api-"));
Object.assign(process.env, { DB_PATH: path.join(testRoot, "test.db"), BACKUP_DIR: path.join(testRoot, "backups"),
  GRABENPLANER_DATA_DIR: path.join(testRoot, "data"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1",
  GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_TEST_TODAY: "2031-04-01", NODE_ENV: "test", TZ: "Europe/Vienna",
  DB_PROVIDER: "sqlite", DATABASE_URL: "", GRABENPLANER_VOICE_ASSISTANT_ENABLED: "1", GRABENPLANER_VOICE_ASSISTANT_ADMIN_ONLY: "1",
  GRABENPLANER_VOICE_MAX_SECONDS: "600", GRABENPLANER_VOICE_MAX_CONVERSATIONS: "8", GRABENPLANER_OPENAI_API_KEY: "SYNTHETIC-VOICE-KEY" });
const originalFetch = global.fetch, providerCalls = [];
let intent = { action: "help", kind: "both", dateText: "", startTime: "", endTime: "", question: "" }, providerFailure = false, onInterpret;
global.fetch = async (url, options) => {
  if (!String(url).startsWith("https://api.openai.com/")) return originalFetch(url, options);
  providerCalls.push({ url, body: JSON.parse(options.body) });
  if (providerFailure) return new Response("{}", { status: 503 });
  if (String(url).endsWith("live/sessions")) return Response.json({ session: { id: "live-example" }, transport: { type: "webrtc", sdp: "v=0\r\nBEISPIEL-answer" } });
  if (onInterpret) { const run = onInterpret; onInterpret = null; await run(); }
  return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(intent) }] }] });
};
const subject = require("../server"), { app, db, releaseInstanceLockForTests } = subject;
const A = "voice-example-A", B = "voice-example-B", E = "voice-example-employee", LOCATION = "voice-example-branch", BASE = "/api/portal/v1/me/assistant";
const sessions = new Map(); let server, origin;
function authentication(number) {
  const token = crypto.randomBytes(24).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,?,?,'2099-01-01T00:00:00Z')")
    .run(crypto.randomUUID(), number, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}
async function api(route, { actor = A, method = "GET", body, csrf = true } = {}) {
  const auth = sessions.get(actor);
  const response = await originalFetch(origin + route, { method, headers: { ...(auth ? { Cookie: auth.cookie } : {}),
    ...(csrf && auth ? { "X-CSRF-Token": auth.csrf } : {}), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
}
async function start(actor = A, body = {}) {
  const result = await api(BASE + "/conversations", { actor, method: "POST", body });
  assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.conversationId;
}
async function message(id, text, { actor = A, ...extra } = {}) {
  return api(`${BASE}/conversations/${id}/messages`, { actor, method: "POST", body: { text, operationId: crypto.randomUUID(), ...extra } });
}
async function confirm(id, draft, actor = A) {
  return api(`${BASE}/conversations/${id}/confirm`, { actor, method: "POST", body: { draftId: draft.id, confirmationToken: draft.confirmationToken, confirmation: "submit" } });
}

test.before(async () => {
  db.prepare("INSERT INTO cost_centers(id,code,name,type,cost_center_type_id,active) VALUES('voice-example-cc','VOICE','BEISPIEL Sprachpilot','branch','branch',1)").run();
  const days = JSON.stringify(Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    .map(day => [day, { open: true, start: "09:00", end: "18:00", minStaff: 0, minFrom: "09:00", minTo: "18:00", lunchEnabled: false }])));
  db.prepare("INSERT INTO locations(id,name,cost_center_id,min_staff,day_settings_json,active) VALUES(?,'BEISPIEL Sprachpilot','voice-example-cc',0,?,1)").run(LOCATION, days);
  for (const [number, role] of [[A, "admin"], [B, "admin"], [E, "employee"]]) {
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,cost_center_id,position_id,active) VALUES(?,?,?,?,'voice-example-cc','verkaufsmitarbeiter',1)")
      .run(number, `BEISPIEL ${number}`, number, LOCATION);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES(?,'test',?,1,0,CURRENT_TIMESTAMP)").run(number, role);
    sessions.set(number, authentication(number));
  }
  db.prepare("INSERT INTO portal_organization_accounts(id,login_name,display_name,account_type,password_hash,active,must_change_password,created_by,updated_by) VALUES('voice-org','voice-org','BEISPIEL Filialkonto','branch','test',1,0,?,?)").run(A, A);
  db.prepare("INSERT INTO portal_organization_account_scopes(account_id,location_id,department_id,assigned_by) VALUES('voice-org',?,0,?)").run(LOCATION, A);
  const organizationToken = crypto.randomBytes(24).toString("hex"), organizationCsrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_organization_sessions(id,account_id,token_hash,expires_at) VALUES(?,'voice-org',?,'2099-01-01T00:00:00Z')")
    .run(crypto.randomUUID(), crypto.createHash("sha256").update(organizationToken).digest("hex"));
  sessions.set("voice-org", { cookie: `grabenplaner_session=${organizationToken}; grabenplaner_csrf=${organizationCsrf}`, csrf: organizationCsrf });
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); origin = `http://127.0.0.1:${server.address().port}`;
  const accounts = await api("/api/vacation-entitlements", { method: "PUT", body: { year: 2031, entries: [{ employeeNumber: A, days: 25 }, { employeeNumber: B, days: 7 }] } });
  assert.equal(accounts.status, 200, JSON.stringify(accounts.data));
  for (const [number, day] of [[A, "2031-04-04"], [B, "2031-04-04"], [A, "2031-04-11"]]) db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time) VALUES(?,?,?,'09:00','17:00')").run(number, LOCATION, day);
  db.prepare("INSERT INTO xoffi_time_imports(id,location_id,week_start,week_end,source_sha256,ocr_engine_version,imported_by) VALUES('voice-balance',?,'2031-03-24','2031-03-30',?,'test',?)").run(LOCATION, "a".repeat(64), A);
  for (const [number, minutes] of [[A, 720], [B, 60]]) db.prepare("INSERT INTO xoffi_time_employee_rows(import_id,employee_number,source_name,closing_balance_minutes) VALUES('voice-balance',?,'BEISPIEL',?)").run(number, minutes);
});
test.after(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise(resolve => server.close(resolve));
  db.close(); releaseInstanceLockForTests();
  assert.equal(path.dirname(testRoot), path.resolve(os.tmpdir())); assert(path.basename(testRoot).startsWith("gp-voice-api-"));
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("authenticated, admin-only pilot and CSRF restrictions are enforced by the real GP routes", async () => {
  assert.equal((await api(BASE + "/status", { actor: "anonymous" })).status, 401);
  const regular = await api(BASE + "/status", { actor: E }); assert.equal(regular.status, 200); assert.equal(regular.data.enabled, false);
  assert.equal((await api(BASE + "/conversations", { actor: E, method: "POST", body: {} })).status, 403);
  assert.equal((await api(BASE + "/conversations", { method: "POST", body: {}, csrf: false })).status, 403);
  const admin = await api(BASE + "/status"); assert.equal(admin.data.enabled, true); assert.equal(admin.data.configured, true);
  assert(!JSON.stringify(admin.data).includes("SYNTHETIC-VOICE-KEY")); assert.match(admin.headers.get("cache-control"), /no-store/);
});
test("personal balances and schedule come from real synthetic GP records with no other employee information", async () => {
  const id = await start(); intent = { ...intent, action: "balances", kind: "both" };
  const balance = await message(id, "Wie viele Urlaubstage und ZA-Stunden habe ich noch?");
  assert.equal(balance.status, 200, JSON.stringify(balance.data)); assert.equal(balance.data.data.vacation.remainingDays, 25);
  assert.equal(balance.data.data.timeOff.minutes, 720); assert.match(balance.data.text, /importierter Stand/);
  assert(!JSON.stringify(balance.data).includes(B)); assert(!JSON.stringify(balance.data).includes("employeeNumber"));
  intent = { ...intent, action: "schedule", dateText: "diese Woche" };
  const own = await message(id, "Wie arbeite ich diese Woche?");
  assert.equal(own.status, 200, JSON.stringify(own.data)); assert.equal(own.data.data.shifts.length, 1); assert.equal(own.data.data.shifts[0].date, "2031-04-04");
  const baseline = await api("/api/portal/v1/me/schedule?week=2031-03-31"); assert.equal(baseline.data.shifts.length, 1);
  assert.equal((await message(id, "Fremde Daten", { actor: B })).status, 404);
  assert.equal((await message(id, "Fremde Daten", { employeeNumber: B })).status, 400);
});
test("an authenticated organization account cannot enter the personal assistant", async () => {
  const result = await api(BASE + "/status", { actor: "voice-org" });
  assert.equal(result.status, 403, JSON.stringify(result.data)); assert.equal(result.data.code, "PORTAL_EMPLOYEE_ACCOUNT_REQUIRED");
  assert.equal((await api(BASE + "/conversations", { actor: "voice-org", method: "POST", body: {} })).status, 403);
});
test("vacation draft cannot submit itself; explicit confirmation uses existing pending workflow and decision/audit records", async () => {
  const id = await start(); intent = { ...intent, action: "draft", kind: "vacation", dateText: "14. bis 18. April" };
  const before = db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number=?").get(A).count;
  const prepared = await message(id, "Ich möchte vom 14. bis 18. April Urlaub nehmen.");
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data)); const draft = prepared.data.draft;
  // Easter Monday is deducted by the existing GP vacation rules in this range.
  assert.equal(draft.days, 4); assert.equal(draft.balancesByYear[0].remainingDays, 25);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number=?").get(A).count, before);
  assert.equal((await confirm(id, draft, B)).status, 404);
  const sent = await confirm(id, draft); assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(sent.data.request.status, "pending");
  const replay = await confirm(id, draft); assert.equal(replay.data.request.id, sent.data.request.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number=?").get(A).count, before + 1);
  assert.equal((await api("/api/portal/v1/me/vacation-requests")).data.requests.find(item => item.id === sent.data.request.id).status, "pending_local");
  assert(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='vacation.request.create' AND actor=?").get(A).count > 0);
  intent = { ...intent, action: "requests", kind: "vacation", dateText: "" };
  const listed = await message(id, "Welche meiner Anträge sind offen?"); assert.equal(listed.status, 200); assert(listed.data.data.some(item => item.id === sent.data.request.id));
  intent = { ...intent, action: "draft", dateText: "14. bis 18. April" };
  const overlap = await message(id, "Ich möchte vom 14. bis 18. April Urlaub nehmen.");
  assert.equal(overlap.status, 200, JSON.stringify(overlap.data)); assert.equal(overlap.data.draft.check.submissionAllowed, false);
  assert.equal((await confirm(id, overlap.data.draft)).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number=?").get(A).count, before + 1);
});
test("all-day ZA uses existing GP planned-day metrics and submission workflow", async () => {
  const id = await start(); intent = { ...intent, action: "draft", kind: "time_off", dateText: "11. April 2031", startTime: "", endTime: "" };
  const prepared = await message(id, "Beantrage bitte am 11. April 2031 einen ZA-Tag.");
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data)); assert(prepared.data.draft.minutes > 0);
  const sent = await confirm(id, prepared.data.draft); assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(sent.data.request.status, "pending");
  const row = db.prepare("SELECT * FROM time_off_requests WHERE id=?").get(sent.data.request.id);
  assert.equal(row.employee_number, A); assert.equal(row.all_day, 1);
});
test("real GP blackouts, feature gates and changed eligibility still prevent submission", async () => {
  const id = await start(); intent = { ...intent, action: "draft", kind: "vacation", dateText: "21. April 2031" };
  const prepared = await message(id, "Ich möchte am 21. April 2031 Urlaub nehmen."); assert.equal(prepared.status, 200);
  db.prepare("INSERT INTO request_blackouts(location_id,date_from,date_to,block_vacation,block_time_off,reason,active,created_by) VALUES(?,'2031-04-21','2031-04-21',1,1,'BEISPIEL Sperre',1,?)").run(LOCATION, A);
  const changed = await confirm(id, prepared.data.draft); assert.equal(changed.status, 409); assert.equal(changed.data.code, "ASSISTANT_PREVIEW_CHANGED"); assert.equal(changed.data.draft.check.submissionAllowed, false);
  assert.equal((await confirm(id, changed.data.draft)).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number=? AND date_from='2031-04-21'").get(A).count, 0);
});
test("speech handshake remains server-configured and microphone permission is restricted to the enabled portal", async () => {
  const id = await start(A, { sdp: "v=0\r\nBEISPIEL-offer" }); assert(id);
  const call = providerCalls.find(item => item.url.endsWith("live/sessions")); assert.equal(call.body.session.model, "gpt-live-1"); assert.equal(call.body.session.store, false);
  for (const route of ["/portal.html", "/"]) {
    const result = await originalFetch(origin + route); assert.equal(result.headers.get("permissions-policy").includes("microphone=(self)"), route === "/portal.html");
    assert(!result.headers.get("content-security-policy").includes("api.openai.com"));
  }
  assert.equal((await api(`${BASE}/conversations/${id}`, { method: "DELETE", body: {} })).status, 204);
});
test("assistant calls cannot bypass disabled GP vacation/request installation modules", async () => {
  const id = await start(), previous = db.prepare("SELECT value FROM settings WHERE key='installation_features'").get().value;
  try {
    db.prepare("UPDATE settings SET value=? WHERE key='installation_features'").run(JSON.stringify(JSON.parse(previous).filter(feature => !["vacation", "requests"].includes(feature))));
    intent = { ...intent, action: "balances", kind: "vacation", dateText: "" };
    let result = await message(id, "Wie viele Urlaubstage habe ich?"); assert.equal(result.status, 403, JSON.stringify(result.data)); assert.equal(result.data.code, "FEATURE_DISABLED");
    intent = { ...intent, action: "draft", kind: "vacation", dateText: "28. April 2031" };
    result = await message(id, "Ich möchte am 28. April 2031 Urlaub nehmen."); assert.equal(result.status, 403, JSON.stringify(result.data)); assert.equal(result.data.code, "FEATURE_DISABLED");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number=? AND date_from='2031-04-28'").get(A).count, 0);
  } finally { db.prepare("UPDATE settings SET value=? WHERE key='installation_features'").run(previous); }
});
test("API outage and a revoked real GP session during model processing cannot submit or return personal data", async () => {
  let id = await start(); providerFailure = true;
  const failure = await message(id, "Wie arbeite ich?"); assert.equal(failure.status, 503); assert.equal(failure.data.code, "ASSISTANT_PROVIDER_UNAVAILABLE"); providerFailure = false;
  intent = { ...intent, action: "schedule", dateText: "diese Woche" };
  onInterpret = async () => db.prepare("DELETE FROM portal_sessions WHERE employee_number=?").run(A);
  const denied = await message(id, "Wie arbeite ich diese Woche?"); assert.equal(denied.status, 401); assert(!JSON.stringify(denied.data).includes("2031-04-04"));
  sessions.set(A, authentication(A)); id = await start();
  db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES(?,'own_schedule:read',?)").run(A, B);
  assert.equal((await message(id, "Wie arbeite ich diese Woche?")).status, 403);
});
