"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v088-personal-notifications-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";
process.env.GRABENPLANER_AMU_KEY_ID = "personal-notification-test-v1";
process.env.GRABENPLANER_AMU_KEY = Buffer.alloc(32, 13).toString("base64");

process.env.GRABENPLANER_EMAIL_PROVIDER = "custom-smtp";
process.env.GRABENPLANER_SMTP_HOST = "smtp.example.test";
process.env.GRABENPLANER_SMTP_FROM = "Grabenplaner <app@example.test>";
process.env.GRABENPLANER_SMTP_USER = "test-user";
process.env.GRABENPLANER_SMTP_PASSWORD = "test-password";
process.env.GRABENPLANER_EMAIL_DISPATCH_ENABLED = "1";
process.env.GRABENPLANER_EMAIL_SENDER_APPROVED = "1";
process.env.GRABENPLANER_EMAIL_ALLOWED_EVENTS = "destination_verification";
process.env.GRABENPLANER_SMS_WEBHOOK_URL = "https://notifications.invalid/grabenplaner/sms";
process.env.GRABENPLANER_SMS_WEBHOOK_TOKEN = "test-sms-token";
process.env.GRABENPLANER_SMS_SENDER = "Grabenplaner";
process.env.GRABENPLANER_SMS_DISPATCH_ENABLED = "1";
process.env.GRABENPLANER_SMS_SENDER_APPROVED = "1";
process.env.GRABENPLANER_SMS_ALLOWED_EVENTS = "destination_verification";
for (const key of [
  "GRABENPLANER_WHATSAPP_WEBHOOK_URL",
  "GRABENPLANER_WHATSAPP_WEBHOOK_TOKEN",
  "GRABENPLANER_WHATSAPP_SENDER",
  "GRABENPLANER_WHATSAPP_DISPATCH_ENABLED",
  "GRABENPLANER_WHATSAPP_SENDER_APPROVED",
  "GRABENPLANER_WHATSAPP_ALLOWED_EVENTS",
]) delete process.env[key];

const deliveries = [];
let deliveryHook = null;
const nodemailer = require("nodemailer");
const nativeCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = () => ({
  async sendMail(message) {
    const code = String(message.text || "").match(/\b(\d{6})\b/)?.[1] || "";
    const delivery = { channel: "email", recipient: String(message.to || ""), code };
    deliveries.push(delivery);
    if (deliveryHook) await deliveryHook(delivery);
    return { accepted: [message.to] };
  },
});

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://notifications.invalid/")) {
    const payload = JSON.parse(String(options?.body || "{}"));
    const delivery = {
      channel: String(payload.channel || ""),
      recipient: String(payload.recipient || ""),
      code: String(payload.code || ""),
    };
    deliveries.push(delivery);
    if (deliveryHook) await deliveryHook(delivery);
    return { ok: true };
  }
  return nativeFetch(url, options);
};

const { createAmuStorage } = require("../lib/amu-storage");
const {
  inspectSqlitePersonalNotificationContactRows,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  app,
  db,
  processOutboundNotificationJobs,
  releaseInstanceLockForTests,
  verifyImportedProtectedPersonnelPayloads,
} = require("../server");

const profileStorage = createAmuStorage({
  rootDirectory: path.join(testRoot, "profile-cipher"),
  encryptionKeys: {
    [process.env.GRABENPLANER_AMU_KEY_ID]: process.env.GRABENPLANER_AMU_KEY,
  },
  activeKeyId: process.env.GRABENPLANER_AMU_KEY_ID,
});

let httpServer;
let baseUrl;

function ensureEmployee(employeeNumber) {
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, active)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      active = 1
  `).run(employeeNumber, `Testperson ${employeeNumber}`, `Test ${employeeNumber}`);
}

function resetEmployee(employeeNumber) {
  ensureEmployee(employeeNumber);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM personal_notification_contacts WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM sickness_notification_preferences WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM personnel_sensitive_records WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM audit_log WHERE actor = ? OR entity_id = ?").run(employeeNumber, employeeNumber);
}

function profileCiphertext(employeeNumber, { privateEmail = "", phone = "" } = {}) {
  return profileStorage.protectRecord(JSON.stringify({ privateEmail, phone }), {
    namespace: "personnel-sensitive-record",
    recordId: employeeNumber,
    field: "payload",
    employeeNumber,
  });
}

function setMasterTargets(employeeNumber, targets = {}) {
  const protectedPayload = profileCiphertext(employeeNumber, targets);
  db.prepare(`
    INSERT INTO personnel_sensitive_records
      (employee_number, protected_payload, updated_by, updated_at)
    VALUES (?, ?, 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      protected_payload = excluded.protected_payload,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, protectedPayload);
  return protectedPayload;
}

function createSession(employeeNumber, { role = "employee", mustChangePassword = false } = {}) {
  ensureEmployee(employeeNumber);
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      role_locked = excluded.role_locked,
      active = 1,
      must_change_password = excluded.must_change_password,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role, Number(role === "developer"), Number(Boolean(mustChangePassword)));
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
    employeeNumber,
    role,
  };
}

function createOrganizationSession() {
  const accountId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_organization_accounts
      (id, login_name, display_name, account_type, password_hash, active,
       must_change_password, created_by, updated_by)
    VALUES (?, ?, 'Testfiliale', 'branch', 'test-only', 1, 0, 'test', 'test')
  `).run(accountId, `notification-org-${accountId}`);
  db.prepare(`
    INSERT INTO portal_organization_sessions (id, account_id, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), accountId, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

async function request(route, { method = "GET", session = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers["X-CSRF-Token"] = session.csrf;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function latestDelivery(channel) {
  return [...deliveries].reverse().find((delivery) => delivery.channel === channel);
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  deliveryHook = null;
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  db.close();
  releaseInstanceLockForTests();
  nodemailer.createTransport = nativeCreateTransport;
  globalThis.fetch = nativeFetch;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("v0.88: Stammdaten sind die einzige Zielquelle und Einstellungen bleiben PII-frei", async () => {
  const employeeNumber = "88001";
  const email = "master.target@example.at";
  const phone = "+436601234567";
  resetEmployee(employeeNumber);
  setMasterTargets(employeeNumber, { privateEmail: email, phone });
  const session = createSession(employeeNumber);

  assert.equal((await request("/api/portal/v1/me/email-settings")).response.status, 401);
  const initial = await request("/api/portal/v1/me/email-settings", { session });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  assert.equal(initial.payload.schemaVersion, 2);
  assert.equal(initial.payload.targets.email.status, "pending");
  assert.equal(initial.payload.targets.phone.status, "pending");
  assert.equal(initial.payload.channels.email.selectable, true);
  assert.equal(initial.payload.channels.sms.selectable, true);
  assert.equal(initial.payload.channels.whatsapp.selectable, true);
  assert.equal(initial.payload.channels.whatsapp.verificationAvailable, false);
  assert.equal(JSON.stringify(initial.payload).includes(email), false);
  assert.equal(JSON.stringify(initial.payload).includes(phone), false);

  for (const method of ["PUT", "DELETE"]) {
    const result = await request("/api/portal/v1/me/email-settings/address", {
      method,
      session,
      ...(method === "PUT" ? { body: { email: "other@example.at" } } : {}),
    });
    assert.equal(result.response.status, 405, JSON.stringify(result.payload));
    assert.equal(result.payload.code, "PERSONAL_NOTIFICATION_TARGET_READ_ONLY");
  }

  for (const field of ["destination", "address", "email", "phone"]) {
    const forbidden = await request("/api/portal/v1/me/email-settings/categories", {
      method: "PUT",
      session,
      body: { channels: { email: true }, [field]: "attacker-controlled" },
    });
    assert.equal(forbidden.response.status, 422, `${field}: ${JSON.stringify(forbidden.payload)}`);
    assert.equal(forbidden.payload.code, "PERSONAL_NOTIFICATION_TARGET_READ_ONLY");
  }

  const saved = await request("/api/portal/v1/me/email-settings/categories", {
    method: "PUT",
    session,
    body: { channels: { email: true, sms: true, whatsapp: true } },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  for (const channel of ["email", "sms", "whatsapp"]) {
    assert.equal(saved.payload.channels[channel].enabled, true);
    assert.equal(saved.payload.channels[channel].deliveryReady, false);
  }

  const deniedQuietHours = await request("/api/portal/v1/me/email-settings/categories", {
    method: "PUT",
    session,
    body: { channels: { email: true, sms: true, whatsapp: true }, earliestTime: "09:15" },
  });
  assert.equal(deniedQuietHours.response.status, 403, JSON.stringify(deniedQuietHours.payload));

  const stored = db.prepare("SELECT * FROM personal_notification_contacts WHERE employee_number = ?")
    .get(employeeNumber);
  assert.match(stored.email_target_fingerprint, /^[0-9a-f]{64}$/);
  assert.match(stored.phone_target_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(stored.earliest_time, "08:00");
  assert.equal(JSON.stringify(stored).includes(email), false);
  assert.equal(JSON.stringify(stored).includes(phone), false);
  assert.equal(Object.keys(stored).some((key) => /address|destination|protected/i.test(key)), false);
  const audit = db.prepare(`
    SELECT GROUP_CONCAT(action || ':' || detail, '|') AS value
    FROM audit_log WHERE actor = ? AND action LIKE 'personal-notifications.%'
  `).get(employeeNumber).value;
  assert.equal(String(audit).includes(email), false);
  assert.equal(String(audit).includes(phone), false);
});

test("v0.88: alle echten Mitarbeiterrollen duerfen Kanalwahl, Ruhezeit aber nur mit Recht", async () => {
  const roles = [
    "employee",
    "location_planner",
    "department_manager",
    "manager",
    "hr",
    "admin",
    "it_admin",
    "developer",
  ];
  let managerSession;
  for (const [index, role] of roles.entries()) {
    const employeeNumber = String(88100 + index);
    resetEmployee(employeeNumber);
    setMasterTargets(employeeNumber, { privateEmail: `${role}@example.at` });
    const session = createSession(employeeNumber, { role });
    if (role === "manager") managerSession = session;
    const saved = await request("/api/portal/v1/me/email-settings/categories", {
      method: "PUT",
      session,
      body: { channels: { email: true } },
    });
    assert.equal(saved.response.status, 200, `${role}: ${JSON.stringify(saved.payload)}`);
    assert.equal(saved.payload.channels.email.enabled, true);
    for (const method of ["PUT", "DELETE"]) {
      const readOnly = await request("/api/portal/v1/me/email-settings/address", {
        method,
        session,
        ...(method === "PUT" ? { body: { email: "not-allowed@example.at" } } : {}),
      });
      assert.equal(readOnly.response.status, 405, `${role}/${method}: ${JSON.stringify(readOnly.payload)}`);
    }
  }

  const quietHours = await request("/api/portal/v1/me/email-settings/categories", {
    method: "PUT",
    session: managerSession,
    body: { channels: { email: true }, earliestTime: "21:30" },
  });
  assert.equal(quietHours.response.status, 200, JSON.stringify(quietHours.payload));
  assert.equal(quietHours.payload.quietHours.earliestTime, "21:30");
  assert.equal(quietHours.payload.quietHours.editable, true);
  const invalidTime = await request("/api/portal/v1/me/email-settings/categories", {
    method: "PUT",
    session: managerSession,
    body: { channels: { email: true }, earliestTime: "24:01" },
  });
  assert.equal(invalidTime.response.status, 422, JSON.stringify(invalidTime.payload));

  const plannerNumber = "88101";
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'notifications:settings', 'test')
  `).run(plannerNumber);
  const plannerWithForbiddenGrant = createSession(plannerNumber, { role: "location_planner" });
  const plannerQuietHours = await request("/api/portal/v1/me/email-settings/categories", {
    method: "PUT",
    session: plannerWithForbiddenGrant,
    body: { channels: { email: true }, earliestTime: "20:45" },
  });
  assert.equal(plannerQuietHours.response.status, 403, JSON.stringify(plannerQuietHours.payload));

  const organization = createOrganizationSession();
  for (const endpoint of [
    { route: "/api/portal/v1/me/email-settings", method: "GET" },
    { route: "/api/portal/v1/me/email-settings/categories", method: "PUT", body: { channels: {} } },
  ]) {
    const denied = await request(endpoint.route, { ...endpoint, session: organization });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_EMPLOYEE_ACCOUNT_REQUIRED");
  }

  const lockedNumber = "88199";
  resetEmployee(lockedNumber);
  setMasterTargets(lockedNumber, { privateEmail: "locked@example.at" });
  const locked = createSession(lockedNumber, { mustChangePassword: true });
  for (const endpoint of [
    { route: "/api/portal/v1/me/email-settings", method: "GET" },
    { route: "/api/portal/v1/me/email-settings/categories", method: "PUT", body: { channels: { email: true } } },
    { route: "/api/portal/v1/me/email-settings/verification", method: "POST", body: { channel: "email" } },
  ]) {
    const denied = await request(endpoint.route, { ...endpoint, session: locked });
    assert.equal(denied.response.status, 428, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_PASSWORD_CHANGE_REQUIRED");
  }
});

test("v0.88: eine Stammdaten-Aenderung entwertet Codes, Bestaetigung bleibt single-use", async () => {
  const employeeNumber = "88201";
  const firstEmail = "first.master@example.at";
  const secondEmail = "second.master@example.at";
  resetEmployee(employeeNumber);
  setMasterTargets(employeeNumber, { privateEmail: firstEmail });
  const session = createSession(employeeNumber);

  let releaseDelivery;
  let deliveryReached;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  const intercepted = new Promise((resolve) => { deliveryReached = resolve; });
  deliveryHook = async (delivery) => {
    if (delivery.channel !== "email") return;
    deliveryReached(delivery);
    await deliveryGate;
  };
  const sending = request("/api/portal/v1/me/email-settings/verification", {
    method: "POST",
    session,
    body: { channel: "email" },
  });
  const firstDelivery = await intercepted;
  setMasterTargets(employeeNumber, { privateEmail: secondEmail });
  releaseDelivery();
  const sent = await sending;
  deliveryHook = null;
  assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
  assert.equal(firstDelivery.recipient, firstEmail);
  assert.equal(sent.payload.targets.email.status, "pending");
  assert.equal(sent.payload.verification.required, false);

  const stale = await request("/api/portal/v1/me/email-settings/verification/confirm", {
    method: "POST",
    session,
    body: { channel: "email", code: firstDelivery.code },
  });
  assert.equal(stale.response.status, 410, JSON.stringify(stale.payload));
  const afterChange = db.prepare("SELECT * FROM personal_notification_contacts WHERE employee_number = ?")
    .get(employeeNumber);
  assert.equal(afterChange.email_verified_at, null);
  assert.equal(afterChange.verification_generation, "");

  db.prepare(`
    UPDATE personal_notification_contacts SET verification_sent_at = '2000-01-01T00:00:00.000Z'
    WHERE employee_number = ?
  `).run(employeeNumber);
  const next = await request("/api/portal/v1/me/email-settings/verification", {
    method: "POST",
    session,
    body: { channel: "email" },
  });
  assert.equal(next.response.status, 200, JSON.stringify(next.payload));
  const currentDelivery = latestDelivery("email");
  assert.equal(currentDelivery.recipient, secondEmail);
  const confirmations = await Promise.all([1, 2].map(() => request(
    "/api/portal/v1/me/email-settings/verification/confirm",
    { method: "POST", session, body: { channel: "email", code: currentDelivery.code } },
  )));
  assert.deepEqual(confirmations.map((result) => result.response.status).sort(), [200, 410]);
  const verified = await request("/api/portal/v1/me/email-settings", { session });
  assert.equal(verified.payload.targets.email.status, "verified");
});

test("v0.88: SMS bestaetigt das gemeinsame Telefonziel ohne WhatsApp-Providerfreigabe", async () => {
  const employeeNumber = "88301";
  const phone = "+436609876543";
  resetEmployee(employeeNumber);
  setMasterTargets(employeeNumber, { phone });
  const session = createSession(employeeNumber);

  const selected = await request("/api/portal/v1/me/email-settings/categories", {
    method: "PUT",
    session,
    body: { channels: { sms: true, whatsapp: true } },
  });
  assert.equal(selected.response.status, 200, JSON.stringify(selected.payload));
  assert.equal(selected.payload.channels.sms.enabled, true);
  assert.equal(selected.payload.channels.whatsapp.enabled, true);
  assert.equal(selected.payload.channels.sms.deliveryReady, false);
  assert.equal(selected.payload.channels.whatsapp.deliveryReady, false);

  const sent = await request("/api/portal/v1/me/email-settings/verification", {
    method: "POST",
    session,
    body: { channel: "sms" },
  });
  assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
  const sms = latestDelivery("sms");
  assert.equal(sms.recipient, phone);
  assert.match(sms.code, /^\d{6}$/);
  const confirmed = await request("/api/portal/v1/me/email-settings/verification/confirm", {
    method: "POST",
    session,
    body: { channel: "sms", code: sms.code },
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.payload));
  assert.equal(confirmed.payload.targets.phone.status, "verified");
  assert.equal(confirmed.payload.channels.sms.deliveryReady, true);
  assert.equal(confirmed.payload.channels.whatsapp.enabled, true);
  assert.equal(confirmed.payload.channels.whatsapp.deliveryReady, false);
  assert.equal(confirmed.payload.channels.whatsapp.verificationAvailable, false);
});

test("v0.88: parallele Fehlversuche sperren den Code atomar nach exakt fuenf Versuchen", async () => {
  const employeeNumber = "88401";
  resetEmployee(employeeNumber);
  setMasterTargets(employeeNumber, { privateEmail: "attempt-race@example.at" });
  const session = createSession(employeeNumber);
  const sent = await request("/api/portal/v1/me/email-settings/verification", {
    method: "POST",
    session,
    body: { channel: "email" },
  });
  assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
  const validCode = latestDelivery("email").code;
  const wrongCode = validCode === "000000" ? "000001" : "000000";
  const attempts = await Promise.all(Array.from({ length: 5 }, () => request(
    "/api/portal/v1/me/email-settings/verification/confirm",
    { method: "POST", session, body: { channel: "email", code: wrongCode } },
  )));
  assert.ok(attempts.every((result) => [400, 410].includes(result.response.status)));
  assert.equal(db.prepare(`
    SELECT verification_attempts FROM personal_notification_contacts WHERE employee_number = ?
  `).get(employeeNumber).verification_attempts, 5);
  const locked = await request("/api/portal/v1/me/email-settings/verification/confirm", {
    method: "POST",
    session,
    body: { channel: "email", code: validCode },
  });
  assert.equal(locked.response.status, 410);
});

test("v0.88: der persistente Rate-Bucket ueberlebt Stammdatenwechsel", async () => {
  const employeeNumber = "88501";
  resetEmployee(employeeNumber);
  setMasterTargets(employeeNumber, { privateEmail: "rate-0@example.at" });
  const session = createSession(employeeNumber);
  const before = deliveries.length;
  for (let index = 0; index < 6; index += 1) {
    if (index > 0) {
      setMasterTargets(employeeNumber, { privateEmail: `rate-${index}@example.at` });
      const reconciled = await request("/api/portal/v1/me/email-settings", { session });
      assert.equal(reconciled.response.status, 200);
    }
    db.prepare(`
      UPDATE personal_notification_contacts SET verification_sent_at = '2000-01-01T00:00:00.000Z'
      WHERE employee_number = ?
    `).run(employeeNumber);
    const result = await request("/api/portal/v1/me/email-settings/verification", {
      method: "POST",
      session,
      body: { channel: "email" },
    });
    assert.equal(result.response.status, 200, `send ${index + 1}: ${JSON.stringify(result.payload)}`);
  }
  setMasterTargets(employeeNumber, { privateEmail: "rate-6@example.at" });
  await request("/api/portal/v1/me/email-settings", { session });
  db.prepare(`
    UPDATE personal_notification_contacts SET verification_sent_at = '2000-01-01T00:00:00.000Z'
    WHERE employee_number = ?
  `).run(employeeNumber);
  const limited = await request("/api/portal/v1/me/email-settings/verification", {
    method: "POST",
    session,
    body: { channel: "email" },
  });
  assert.equal(limited.response.status, 429, JSON.stringify(limited.payload));
  assert.equal(limited.payload.code, "PERSONAL_EMAIL_VERIFICATION_RATE_LIMITED");
  assert.equal(deliveries.length - before, 6);
  assert.equal(db.prepare(`
    SELECT verification_rate_count FROM personal_notification_contacts WHERE employee_number = ?
  `).get(employeeNumber).verification_rate_count, 6);
});

test("v0.88: Auditfehler rollen Praeferenz und Codebestaetigung vollstaendig zurueck", async () => {
  const employeeNumber = "88601";
  resetEmployee(employeeNumber);
  setMasterTargets(employeeNumber, { privateEmail: "audit-rollback@example.at" });
  const session = createSession(employeeNumber);
  await request("/api/portal/v1/me/email-settings", { session });
  const trigger = "trg_test_personal_notifications_audit_failure";
  const removeTrigger = () => db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  const installTrigger = (action) => db.exec(`
    CREATE TRIGGER ${trigger}
    BEFORE INSERT ON audit_log
    WHEN NEW.action = '${action}'
    BEGIN
      SELECT RAISE(ABORT, 'test personal notification audit failure');
    END;
  `);
  try {
    const beforePreference = db.prepare(`
      SELECT email_enabled, earliest_time FROM personal_notification_contacts WHERE employee_number = ?
    `).get(employeeNumber);
    installTrigger("personal-notifications.preferences.update");
    const failedPreference = await request("/api/portal/v1/me/email-settings/categories", {
      method: "PUT",
      session,
      body: { channels: { email: true } },
    });
    assert.equal(failedPreference.response.status, 500, JSON.stringify(failedPreference.payload));
    assert.deepEqual(db.prepare(`
      SELECT email_enabled, earliest_time FROM personal_notification_contacts WHERE employee_number = ?
    `).get(employeeNumber), beforePreference);
    removeTrigger();

    const sent = await request("/api/portal/v1/me/email-settings/verification", {
      method: "POST",
      session,
      body: { channel: "email" },
    });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
    const code = latestDelivery("email").code;
    const beforeConfirmation = db.prepare(`
      SELECT email_verified_at, verification_generation, verification_hash
      FROM personal_notification_contacts WHERE employee_number = ?
    `).get(employeeNumber);
    installTrigger("personal-notifications.verification.confirm");
    const failedConfirmation = await request("/api/portal/v1/me/email-settings/verification/confirm", {
      method: "POST",
      session,
      body: { channel: "email", code },
    });
    assert.equal(failedConfirmation.response.status, 500, JSON.stringify(failedConfirmation.payload));
    assert.deepEqual(db.prepare(`
      SELECT email_verified_at, verification_generation, verification_hash
      FROM personal_notification_contacts WHERE employee_number = ?
    `).get(employeeNumber), beforeConfirmation);
    removeTrigger();
    assert.equal((await request("/api/portal/v1/me/email-settings/verification/confirm", {
      method: "POST",
      session,
      body: { channel: "email", code },
    })).response.status, 200);
  } finally {
    removeTrigger();
  }
});

test("v0.88: Import, Fingerprintzustand und alte Business-Jobs bleiben fail-closed", async () => {
  const employeeNumber = "88701";
  resetEmployee(employeeNumber);
  const validPayload = setMasterTargets(employeeNumber, { privateEmail: "valid-import@example.at" });
  const session = createSession(employeeNumber, { role: "manager" });
  await request("/api/portal/v1/me/email-settings", { session });
  assert.equal(inspectSqlitePersonalNotificationContactRows(db).valid, true);
  db.prepare(`
    UPDATE personal_notification_contacts SET email_target_fingerprint = 'not-a-fingerprint'
    WHERE employee_number = ?
  `).run(employeeNumber);
  assert.equal(inspectSqlitePersonalNotificationContactRows(db).valid, false);
  db.prepare("DELETE FROM personal_notification_contacts WHERE employee_number = ?").run(employeeNumber);

  assert.equal(verifyImportedProtectedPersonnelPayloads({
    protected: { personnelProfiles: [{ employee_number: employeeNumber, protected_payload: validPayload }] },
  }), 1);
  const invalidPayload = profileCiphertext(employeeNumber, { privateEmail: "invalid-address" });
  assert.throws(() => verifyImportedProtectedPersonnelPayloads({
    protected: { personnelProfiles: [{ employee_number: employeeNumber, protected_payload: invalidPayload }] },
  }), /invalid protected personnel profile email address/i);

  const inactive = await request("/api/portal/v1/me/sickness-notification-preferences", {
    method: "PUT",
    session,
    body: { channels: { email: { enabled: true, destination: "forbidden@example.at" } } },
  });
  assert.equal(inactive.response.status, 409, JSON.stringify(inactive.payload));
  assert.equal(inactive.payload.code, "NOTIFICATION_EVENT_CATEGORIES_INACTIVE");
  assert.equal(db.prepare(`
    SELECT 1 FROM sickness_notification_preferences WHERE employee_number = ?
  `).get(employeeNumber), undefined);

  const jobId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO outbound_notification_jobs
      (id, recipient_lookup, channel, entity_lookup, protected_payload, not_before,
       purge_after, dedupe_lookup)
    VALUES (?, 'legacy-recipient', 'email', 'legacy-entity', 'legacy-payload',
            '2000-01-01T00:00:00.000Z', '2099-01-01', ?)
  `).run(jobId, crypto.randomUUID());
  const deliveriesBefore = deliveries.length;
  const processed = await processOutboundNotificationJobs(new Date("2099-01-01T00:00:00.000Z"));
  assert.deepEqual(processed, { checked: 1, sent: 0, failed: 0 });
  assert.equal(deliveries.length, deliveriesBefore);
  assert.equal(db.prepare("SELECT status FROM outbound_notification_jobs WHERE id = ?").get(jobId).status, "cancelled");
});
