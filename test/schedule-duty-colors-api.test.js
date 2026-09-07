"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-duty-colors-"));
Object.assign(process.env, {
  DB_PATH: path.join(fixtureRoot, "fixture.db"), BACKUP_DIR: path.join(fixtureRoot, "backups"),
  GRABENPLANER_DATA_DIR: path.join(fixtureRoot, "app-data"), GRABENPLANER_HOST: "127.0.0.1",
  GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test", TZ: "Europe/Vienna",
});
const subject = require("../server");
const { DEFAULT_DUTY_COLORS } = require("../public/schedule-duty");
const { app, db } = subject;
const accounts = {};
let httpServer, baseUrl;
async function request(role, method, payload, suffix = "/schedule-duty-colors", badCsrf = false) {
  const account = accounts[role];
  const headers = { Cookie: account.cookie, Accept: "application/json", "Content-Type": "application/json" };
  if (method !== "GET") headers["X-CSRF-Token"] = badCsrf ? "invalid" : account.csrf;
  const result = await fetch(`${baseUrl}/api/settings${suffix}`, { method, headers,
    body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: result.status, body: await result.json() };
}
test.before(async () => {
  db.prepare("INSERT INTO locations(id,name,active) VALUES('95','Palette Nord',1),('96','Palette Süd',1)").run();
  let number = 99810;
  for (const role of ["hr", "developer", "manager", "admin", "it_admin"]) {
    const employeeNumber = String(number++);
    db.prepare(`INSERT INTO employees(personnel_number,full_name,nickname,color,contracted_hours,home_location_id,active)
      VALUES(?,?,?,'#276353',38.5,'95',1)`).run(employeeNumber, `Synthetic ${role}`, role);
    db.prepare(`INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at)
      VALUES(?,'test-only',?,1,0,CURRENT_TIMESTAMP)`).run(employeeNumber, role);
    db.prepare("INSERT OR IGNORE INTO portal_permission_grants(employee_number,permission,granted_by) VALUES(?,'settings:write','synthetic')").run(employeeNumber);
    db.prepare("INSERT INTO portal_access_scopes(employee_number,location_id,department_id,assigned_by) VALUES(?,'95',0,'synthetic')").run(employeeNumber);
    const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
    db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,?,?,'2099-12-31T23:59:59.000Z')")
      .run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
    accounts[role] = { employeeNumber, csrf, cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}` };
  }
  await new Promise(resolve => { httpServer = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});
test.after(async () => {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  // Only the exact test-owned temporary fixture is removed.
  assert.ok(path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Only PL and developer can persist audited company-wide RGB duty colors", async () => {
  const colors = { ...DEFAULT_DUTY_COLORS, FL: "#8040cc", HW: "#FFFF00", FO: "#123456" };
  for (const role of ["manager", "admin", "it_admin"]) {
    const denied = await request(role, "PUT", { colors });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
  }
  const saved = await request("hr", "PUT", { colors });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.colors.FL, "#8040CC");
  for (const location of ["95", "96"]) {
    const settings = await request("developer", "GET", undefined, `?locationId=${location}`);
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    assert.deepEqual(JSON.parse(settings.body.schedule_duty_colors), saved.body.colors);
  }
  const event = db.prepare("SELECT actor,detail FROM audit_log WHERE action='schedule.duty-colors.update' ORDER BY id DESC LIMIT 1").get();
  assert.equal(event.actor, accounts.hr.employeeNumber);
  assert.equal(JSON.parse(event.detail).scope, "company");
  assert.equal((await request("developer", "PUT", { colors: DEFAULT_DUTY_COLORS })).status, 200);
});

test("RGB schema, CSRF and revoked live role fail closed without changing colors", async () => {
  const current = () => db.prepare("SELECT value FROM settings WHERE key='schedule_duty_colors'").get().value;
  const before = current();
  const anonymous = await fetch(`${baseUrl}/api/settings/schedule-duty-colors`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ colors: DEFAULT_DUTY_COLORS }),
  });
  assert.equal(anonymous.status, 401);
  for (const colors of [{ FL: "#ffffff" }, { ...DEFAULT_DUTY_COLORS, FO: "red" }, { ...DEFAULT_DUTY_COLORS, extra: "#000000" }]) {
    assert.equal((await request("hr", "PUT", { colors })).status, 400);
  }
  assert.equal((await request("hr", "PUT", { colors: DEFAULT_DUTY_COLORS }, "/schedule-duty-colors", true)).status, 403);
  db.prepare("UPDATE portal_users SET role='manager' WHERE employee_number=?").run(accounts.hr.employeeNumber);
  assert.equal((await request("hr", "PUT", { colors: { ...DEFAULT_DUTY_COLORS, FL: "#AABBCC" } })).status, 403);
  assert.equal(current(), before);
});
