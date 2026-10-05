"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-receipt-api-"));
Object.assign(process.env, {
  DB_PATH: path.join(root, "synthetic.db"), BACKUP_DIR: path.join(root, "backups"), GRABENPLANER_DATA_DIR: path.join(root, "data"),
  GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test", TZ: "Europe/Vienna",
  GRABENPLANER_SMTP_HOST: "smtp.synthetic.invalid", GRABENPLANER_SMTP_PORT: "587", GRABENPLANER_SMTP_FROM: "sender@synthetic.invalid",
  GRABENPLANER_SMTP_USER: "SYNTHETIC-USER", GRABENPLANER_SMTP_PASSWORD: "SYNTHETIC-SECRET", GRABENPLANER_EMAIL_DISPATCH_ENABLED: "1",
  GRABENPLANER_EMAIL_SENDER_APPROVED: "1", GRABENPLANER_EMAIL_ALLOWED_EVENTS: "password_reset",
});
let sent = 0, replacementFingerprint = null;
const emailModule = require("../lib/external-notifications");
const originalFactory = emailModule.createExternalNotificationAdapter;
emailModule.createExternalNotificationAdapter = options => {
  const adapter = originalFactory({...options, smtpTransport: {sendMail: async () => {sent++; throw new Error("Unexpected dispatch in receipt-only test");}}});
  return {...adapter, getEmailConfigurationFingerprint: () => replacementFingerprint || adapter.getEmailConfigurationFingerprint()};
};
const originalFetch = global.fetch;
global.fetch = (url, options) => String(url).startsWith("https://api.github.com/")
  ? Promise.resolve(new Response(JSON.stringify([{tag_name: `v${require("../package.json").version}`, prerelease: true, html_url: "https://synthetic.invalid/release", assets: []}]), {status: 200}))
  : originalFetch(url, options);
const subject = require("../server");
const {KEY} = require("../lib/system-notification-receipt-settings");
const {app, db} = subject;
const users = {};
let server, baseUrl;
const CENTER = "/api/portal/v1/system-center", CONFIRM = `${CENTER}/notifications/email/confirm-receipt`;
async function request(route = CENTER, {method = "GET", body, auth = users.developer, csrf = true} = {}) {
  const headers = {Accept: "application/json"};
  if (auth) headers.Cookie = auth.cookie;
  if (auth && method !== "GET" && csrf) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await originalFetch(baseUrl + route, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {status: response.status, headers: response.headers, payload: await response.json()};
}
async function body(auth = users.developer) {
  const result = await request(CENTER, {auth});
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  return {confirmed: true, configurationToken: result.payload.notificationReceipt.configurationToken};
}
const auditCount = () => db.prepare("SELECT count(*) n FROM audit_log WHERE action='system.notifications.receipt.confirmed'").get().n;
test.before(async () => {
  await subject.initializeApplicationPersistence();
  const location = db.prepare("SELECT id FROM locations WHERE active=1 ORDER BY id LIMIT 1").get();
  for (const role of ["admin", "it_admin", "developer", "hr", "manager"]) {
    const id = `receipt-${role}`, token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,active) VALUES (?,?,?,?,1)").run(id,id,id,location.id);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES (?,'synthetic',?,1,0,CURRENT_TIMESTAMP)").run(id,role);
    db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-12-31T23:59:59.000Z')").run(crypto.randomUUID(),id,crypto.createHash("sha256").update(token).digest("hex"));
    users[role] = {id, cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf};
  }
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
  await subject.closePersistenceForTests(); subject.releaseInstanceLockForTests();
  global.fetch = originalFetch; emailModule.createExternalNotificationAdapter = originalFactory;
  fs.rmSync(root, {recursive: true, force: true, maxRetries: 8, retryDelay: 100});
});

test("real API confirms human receipt with an audit, refreshes the score, and never dispatches mail", async () => {
  const before = await request();
  assert.equal(before.status, 200, JSON.stringify(before.payload));
  assert.equal(before.payload.notificationReceipt.state, "unknown");
  assert.equal(before.payload.capabilities.canConfirmNotificationReceipt, true);
  assert.match(before.headers.get("cache-control"), /no-store/);
  const confirmation = await request(CONFIRM, {method: "POST", body: {confirmed: true, configurationToken: before.payload.notificationReceipt.configurationToken, reference: "SYNTHETIC-RECEIPT"}});
  assert.equal(confirmation.status, 201, JSON.stringify(confirmation.payload));
  const after = await request();
  assert.equal(after.payload.notificationReceipt.source, "human-receipt-confirmation");
  assert.equal(after.payload.notificationReceipt.state, "pass");
  const notification = after.payload.trustIndex.cards.find(factor => factor.id === "notifications");
  assert.equal(notification.checks.find(check => check.id === "notifications_delivery").state, "pass");
  assert.equal(auditCount(), 1); assert.equal(sent, 0);
  assert.match(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value, /^enc:v2:/);
  assert.doesNotMatch(JSON.stringify(after.payload), /SYNTHETIC-SECRET|SYNTHETIC-USER|SYNTHETIC-RECEIPT|configurationFingerprint|smtp\.synthetic/);
});

test("CSRF, individual administrative role, password-change and live revocation are enforced", async () => {
  const valid = await body(), before = auditCount();
  assert.equal((await request(CONFIRM, {method: "POST", body: valid, auth: null})).status, 401);
  assert.equal((await request(CONFIRM, {method: "POST", body: valid, csrf: false})).status, 403);
  for (const role of ["hr", "manager"]) assert.equal((await request(CONFIRM, {method: "POST", body: valid, auth: users[role]})).status, 403);
  db.prepare("UPDATE portal_users SET must_change_password=1 WHERE employee_number=?").run(users.developer.id);
  assert.equal((await request(CONFIRM, {method: "POST", body: valid})).status, 428);
  db.prepare("UPDATE portal_users SET must_change_password=0,active=0 WHERE employee_number=?").run(users.developer.id);
  assert.equal((await request(CONFIRM, {method: "POST", body: valid})).status, 401);
  db.prepare("UPDATE portal_users SET active=1 WHERE employee_number=?").run(users.developer.id);
  assert.equal(auditCount(), before); assert.equal(sent, 0);
});

test("admin and IT-admin can confirm, while a changed account cannot reuse another person's challenge", async () => {
  const adminBody = await body(users.admin);
  assert.equal((await request(CONFIRM, {method: "POST", body: adminBody, auth: users.it_admin})).status, 409);
  for (const role of ["admin", "it_admin"]) {
    const result = await request(CONFIRM, {method: "POST", body: await body(users[role]), auth: users[role]});
    assert.equal(result.status, 201, JSON.stringify(result.payload));
  }
  db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES (?,'system:readiness:review','synthetic')").run(users.admin.id);
  try {assert.equal((await request(CONFIRM, {method: "POST", body: adminBody, auth: users.admin})).status, 403);}
  finally {db.prepare("DELETE FROM portal_permission_denials WHERE employee_number=?").run(users.admin.id);}
  assert.equal(sent, 0);
});

test("configuration replacement invalidates both visible receipt and already issued confirmation token", async () => {
  const old = await body(), before = auditCount();
  replacementFingerprint = "f".repeat(64);
  const changed = await request();
  assert.equal(changed.payload.notificationReceipt.state, "unknown");
  assert.equal(changed.payload.notificationReceipt.reason, "configuration_changed");
  assert.equal((await request(CONFIRM, {method: "POST", body: old})).status, 409);
  assert.equal(auditCount(), before);
  assert.equal((await request(CONFIRM, {method: "POST", body: await body()})).status, 201);
  assert.equal(sent, 0);
});

test("ordinary settings cannot disclose or change protected receipt, and no personal free text is accepted", async () => {
  const stored = db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value;
  const general = await request("/api/settings");
  assert.equal(general.status, 200);
  assert.ok(!JSON.stringify(general.payload).includes(KEY));
  assert.ok(!JSON.stringify(general.payload).includes(stored));
  const result = await request("/api/settings", {method: "PUT", body: {[KEY]: "forged"}});
  assert.equal(result.status, 400);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(KEY).value, stored);
  const valid = await body();
  assert.equal((await request(CONFIRM, {method: "POST", body: {...valid, reference: "recipient@example.invalid"}})).status, 400);
  assert.equal((await request(CONFIRM, {method: "POST", body: {...valid, note: "Arbitrary personal text"}})).status, 400);
  assert.equal(sent, 0);
});
