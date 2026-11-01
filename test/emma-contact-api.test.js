"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), test = require("node:test");
const { sessionCsrf } = require("../test-support/portal-session-fixture");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-emma-contact-test-"));
Object.assign(process.env, { DB_PATH: path.join(root, "fixture.db"), BACKUP_DIR: path.join(root, "backups"), GRABENPLANER_DATA_DIR: path.join(root, "data"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test" });
const subject = require("../server"), { db, app } = subject;
let server, base, developer, employee;
function session(id, role) {
  const location = db.prepare("SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1").get().id;
  db.prepare("INSERT INTO employees (personnel_number,full_name,nickname,home_location_id,active) VALUES (?,?,?,?,1)").run(id, "Synthetic Emma Contact", "Example", location);
  db.prepare("INSERT INTO portal_users (employee_number,password_hash,role,active,must_change_password,password_changed_at,updated_at) VALUES (?,'test-only',?,1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run(id, role);
  const token = crypto.randomBytes(32).toString("hex"), csrf = sessionCsrf(token);
  db.prepare("INSERT INTO portal_sessions (id,employee_number,token_hash,expires_at,authenticated_at,absolute_expires_at) VALUES (?,?,?, '2099-12-31T23:59:59.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+8 hours'))").run(crypto.randomUUID(), id, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}
async function request(route, who, body, csrf = true) {
  const headers = { Accept: "application/json" };
  if (who) headers.Cookie = who.cookie;
  if (body) { headers["Content-Type"] = "application/json"; if (csrf && who) headers["X-CSRF-Token"] = who.csrf; }
  const response = await fetch(base + (route.startsWith("/api/") ? route : "/api/portal/v1/emma-contact" + route), { method: body ? "PUT" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
test.before(async () => {
  developer = session("emma-contact-dev", "developer"); employee = session("emma-contact-staff", "employee");
  session("Emma", "employee");
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { await db.close(); } catch {} subject.releaseInstanceLockForTests();
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
test("Native PostgreSQL Emma contact: authentication, developer-only update, CSRF, persistence, CAS and disabling", async () => {
  assert.equal((await request("")).status, 401);
  assert.equal((await request("/settings", employee)).status, 403);
  const initial = await request("/settings", developer); assert.equal(initial.status, 200, JSON.stringify(initial.data));
  assert.deepEqual((await request("", employee)).data, { contact: null });
  const payload = { revision: initial.data.revision, settings: { enabled: true, avatar: "" } };
  const absent = await request("/settings", developer, payload);
  assert.equal(absent.status, 400); assert.equal(absent.data.code, "EMMA_CONTACT_PHONE_REQUIRED");
  const personnel = await request("/api/portal/v1/personnel-records/Emma", developer, { phone: "+43 660 1234567", sensitive: { notes: "Synthetic private note must never be published" } });
  assert.equal(personnel.status, 200, JSON.stringify(personnel.data));
  assert.equal((await request("/settings", developer)).data.phone, "436601234567");
  assert.equal((await request("/settings", employee, payload)).status, 403);
  assert.equal((await request("/settings", developer, payload, false)).status, 403);
  assert.equal((await request("/settings", developer, { ...payload, settings: { ...payload.settings, phone: "436607654321" } })).status, 400);
  const saved = await request("/settings", developer, payload); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const publicValue = await request("", employee);
  assert.equal(publicValue.status, 200); assert.equal(publicValue.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(publicValue.data, { contact: { href: "https://wa.me/436601234567", avatar: "/assets/emma-whatsapp.png" } });
  assert.equal((await request("/settings", developer, payload)).status, 409);
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM portal_settings WHERE key=?").get("emma_whatsapp_contact_v1").value), { enabled: true, avatar: "" });
  const updatedPhone = await request("/api/portal/v1/personnel-records/Emma", developer, { phone: "+43 660 7654321" });
  assert.equal(updatedPhone.status, 200, JSON.stringify(updatedPhone.data));
  assert.deepEqual((await request("", employee)).data, { contact: { href: "https://wa.me/436607654321", avatar: "/assets/emma-whatsapp.png" } });
  assert.equal((await request("?employeeNumber=emma-contact-dev", employee)).data.contact.href, "https://wa.me/436607654321");
  db.prepare("UPDATE employees SET active=0 WHERE personnel_number='Emma'").run();
  assert.equal((await request("", employee)).data.contact, null);
  db.prepare("UPDATE employees SET active=1 WHERE personnel_number='Emma'").run();
  assert.equal((await request("", employee)).data.contact.href, "https://wa.me/436607654321");
  const audits = db.prepare("SELECT detail FROM audit_log WHERE action=?").all("emma.contact.update");
  assert.equal(audits.length, 1); assert.doesNotMatch(audits[0].detail, /436601234567|base64/);
  const disabled = await request("/settings", developer, { revision: saved.data.revision, settings: { enabled: false, avatar: "" } });
  assert.equal(disabled.status, 200); assert.equal((await request("", employee)).data.contact, null);
  db.prepare("UPDATE portal_users SET must_change_password=1 WHERE employee_number=?").run("emma-contact-dev");
  assert.equal((await request("/settings", developer)).status, 428);
  assert.equal((await request("/settings", developer, { revision: disabled.data.revision, settings: payload.settings })).status, 428);
  db.prepare("UPDATE portal_users SET must_change_password=0 WHERE employee_number=?").run("emma-contact-dev");
  db.prepare("UPDATE portal_users SET must_change_password=1 WHERE employee_number=?").run("emma-contact-staff");
  assert.equal((await request("", employee)).status, 428);
  db.prepare("UPDATE portal_users SET role='employee' WHERE employee_number=?").run("emma-contact-dev");
  assert.equal((await request("/settings", developer, { revision: disabled.data.revision, settings: payload.settings })).status, 403);
});
