"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0925-password-reset-"));
const amuKey = Buffer.alloc(32, 29).toString("base64");
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.GRABENPLANER_PUBLIC_URL = "https://beta.grabenplaner.eu";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";
process.env.GRABENPLANER_AMU_KEY_ID = "password-reset-test-v1";
process.env.GRABENPLANER_AMU_KEY = amuKey;
process.env.GRABENPLANER_EMAIL_PROVIDER = "custom-smtp";
process.env.GRABENPLANER_SMTP_HOST = "smtp.example.test";
process.env.GRABENPLANER_SMTP_FROM = "Grabenplaner <noreply@grabenplaner.eu>";
process.env.GRABENPLANER_SMTP_USER = "test-user";
process.env.GRABENPLANER_SMTP_PASSWORD = "test-password";
process.env.GRABENPLANER_EMAIL_DISPATCH_ENABLED = "1";
process.env.GRABENPLANER_EMAIL_SENDER_APPROVED = "1";
process.env.GRABENPLANER_EMAIL_ALLOWED_EVENTS = "password_reset";

const deliveries = [];
let deliveryGate = null;
const nodemailer = require("nodemailer");
const nativeCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = () => ({
  async sendMail(message) {
    deliveries.push({
      recipient: String(message.to || ""),
      subject: String(message.subject || ""),
      text: String(message.text || ""),
    });
    if (deliveryGate) await deliveryGate;
    return { accepted: [message.to] };
  },
});

const { createAmuStorage } = require("../lib/amu-storage");
const {
  app,
  db,
  hashPortalPassword,
  releaseInstanceLockForTests,
  verifyPortalPassword,
} = require("../server");

const profileStorage = createAmuStorage({
  rootDirectory: path.join(testRoot, "profile-cipher"),
  encryptionKeys: { [process.env.GRABENPLANER_AMU_KEY_ID]: amuKey },
  activeKeyId: process.env.GRABENPLANER_AMU_KEY_ID,
});

let httpServer;
let baseUrl;

function targetFingerprint(email) {
  return crypto.createHmac("sha256", amuKey)
    .update(`grabenplaner-personnel-index-v1\0personal-notification-target:email\0${email}`)
    .digest("hex");
}

function protectedProfile(employeeNumber, email) {
  return profileStorage.protectRecord(JSON.stringify({ privateEmail: email }), {
    namespace: "personnel-sensitive-record",
    recordId: employeeNumber,
    field: "payload",
    employeeNumber,
  });
}

async function configurePersonalAccount(employeeNumber, email, options = {}) {
  const passwordHash = await hashPortalPassword(options.password || "AltesSicheresPasswort!2026");
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, active)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      active = excluded.active
  `).run(employeeNumber, `Testperson ${employeeNumber}`, `Test ${employeeNumber}`, options.active === false ? 0 : 1);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, ?, 'employee', 0, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = excluded.role,
      active = excluded.active,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, passwordHash, options.active === false ? 0 : 1);
  db.prepare(`
    INSERT INTO personnel_sensitive_records
      (employee_number, protected_payload, updated_by, updated_at)
    VALUES (?, ?, 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      protected_payload = excluded.protected_payload,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, protectedProfile(employeeNumber, email));
  db.prepare(`
    INSERT INTO personal_notification_contacts
      (employee_number, email_target_fingerprint, email_verified_at, email_enabled, updated_at)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      email_target_fingerprint = excluded.email_target_fingerprint,
      email_verified_at = excluded.email_verified_at,
      email_enabled = 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, targetFingerprint(email), options.verified === false ? null : new Date().toISOString());
  return passwordHash;
}

function createActiveSessions(employeeNumber) {
  const portalSessionId = crypto.randomUUID();
  const portalToken = crypto.randomBytes(32).toString("base64url");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(
    portalSessionId,
    employeeNumber,
    crypto.createHash("sha256").update(portalToken).digest("hex"),
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  );
  const mobileSessionId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mobile_sessions
      (id, employee_number, access_token_hash, access_expires_at, refresh_token_hash,
       refresh_expires_at, installation_id_hash, platform, device_label, app_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'android', 'Testgeraet', 'test')
  `).run(
    mobileSessionId,
    employeeNumber,
    crypto.randomBytes(32).toString("hex"),
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    crypto.randomBytes(32).toString("hex"),
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    crypto.randomBytes(32).toString("hex"),
  );
  return { portalSessionId, portalToken, mobileSessionId };
}

function configureOrganizationAccount(accountType, loginName) {
  db.prepare(`
    INSERT INTO portal_organization_accounts
      (id, login_name, display_name, account_type, password_hash, active,
       must_change_password, created_by, updated_by)
    VALUES (?, ?, ?, ?, 'organization-test-only', 1, 0, 'test', 'test')
  `).run(crypto.randomUUID(), loginName, `Test ${accountType}`, accountType);
}

async function request(route, body, options = {}) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (options.cookie) headers.Cookie = options.cookie;
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function waitForDeliveryCount(count, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (deliveries.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(deliveries.length >= count, `Erwartete mindestens ${count} E-Mail-Zustellungen`);
}

async function within(promise, timeoutMs = 750) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("RESET_RESPONSE_TIMING_LEAK")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function deliveredToken(delivery = deliveries.at(-1)) {
  const match = String(delivery?.text || "").match(
    /https:\/\/beta\.grabenplaner\.eu\/portal\.html#password-reset=([A-Za-z0-9_-]{43})/,
  );
  assert.ok(match, "Reset-E-Mail muss einen gueltigen Fragmentlink enthalten");
  return match[1];
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  db.close();
  releaseInstanceLockForTests();
  nodemailer.createTransport = nativeCreateTransport;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("v0.92.5: Passwortreset bleibt generisch und gilt nur fuer verifizierte persoenliche Konten", async () => {
  const employeeNumber = "92501";
  const email = "verified.reset@example.at";
  await configurePersonalAccount(employeeNumber, email);
  await configurePersonalAccount("92502", "unverified.reset@example.at", { verified: false });
  await configurePersonalAccount("92503", "inactive.reset@example.at", { active: false });
  configureOrganizationAccount("branch", "branch.reset@example.at");
  configureOrganizationAccount("terminal", "terminal.reset@example.at");

  const genericResponses = [];
  for (const candidate of [
    "unverified.reset@example.at",
    "inactive.reset@example.at",
    "branch.reset@example.at",
    "terminal.reset@example.at",
  ]) {
    const result = await request("/api/portal/v1/auth/password-reset/request", { email: candidate });
    assert.equal(result.response.status, 202);
    genericResponses.push(result.payload);
  }
  assert.equal(deliveries.length, 0);

  let releaseDelivery;
  deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  const issued = await within(request("/api/portal/v1/auth/password-reset/request", {
    email: email.toUpperCase(),
  }));
  assert.equal(issued.response.status, 202);
  for (const payload of genericResponses) assert.deepEqual(payload, issued.payload);
  await waitForDeliveryCount(1);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].recipient, email);
  releaseDelivery();
  deliveryGate = null;

  const rawToken = deliveredToken();
  const tokenRow = db.prepare("SELECT * FROM portal_password_reset_tokens WHERE employee_number = ?")
    .get(employeeNumber);
  assert.match(tokenRow.token_hash, /^[0-9a-f]{64}$/);
  assert.equal(tokenRow.token_hash, crypto.createHash("sha256").update(rawToken).digest("hex"));
  assert.equal(JSON.stringify(tokenRow).includes(rawToken), false);
  assert.equal(Object.keys(tokenRow).some((key) => /email_address|raw_token|recipient/i.test(key)), false);
  const createdAtUtc = `${String(tokenRow.created_at).replace(" ", "T")}Z`;
  const ttlMs = Date.parse(tokenRow.expires_at) - Date.parse(createdAtUtc);
  assert.ok(ttlMs > 29 * 60 * 1000 && ttlMs <= 30 * 60 * 1000 + 1_000, ttlMs);
});

test("v0.92.5: Reset ist atomar, einmalig und widerruft Portal-, Mobile- und Geschwistertokens", async () => {
  const employeeNumber = "92501";
  const delivery = deliveries.find((entry) => entry.recipient === "verified.reset@example.at");
  const rawToken = deliveredToken(delivery);
  const { portalSessionId, mobileSessionId } = createActiveSessions(employeeNumber);
  await configurePersonalAccount("92505", "foreign.session@example.at");
  const foreignSessions = createActiveSessions("92505");
  const siblingId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO portal_password_reset_tokens
      (id, employee_number, token_hash, email_fingerprint, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    siblingId,
    employeeNumber,
    crypto.createHash("sha256").update("sibling-token").digest("hex"),
    targetFingerprint("verified.reset@example.at"),
    new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  );

  const mismatch = await request("/api/portal/v1/auth/password-reset/confirm", {
    token: rawToken,
    newPassword: "NeuesSehrSicheresPasswort!2026",
    repeatPassword: "stimmt-nicht-ueberein",
  });
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.payload.code, "PORTAL_PASSWORD_REPEAT_MISMATCH");
  assert.equal(db.prepare("SELECT used_at FROM portal_password_reset_tokens WHERE token_hash = ?")
    .get(crypto.createHash("sha256").update(rawToken).digest("hex")).used_at, null);

  const completed = await request("/api/portal/v1/auth/password-reset/confirm", {
    token: rawToken,
    newPassword: "NeuesSehrSicheresPasswort!2026",
    repeatPassword: "NeuesSehrSicheresPasswort!2026",
  }, { cookie: `grabenplaner_session=${foreignSessions.portalToken}` });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
  assert.deepEqual(completed.payload, { ok: true });
  assert.ok(completed.response.headers.getSetCookie().some((value) =>
    value.startsWith("grabenplaner_session=") && value.includes("Max-Age=0")));

  const user = db.prepare(`
    SELECT password_hash, must_change_password, failed_login_attempts, locked_until
    FROM portal_users WHERE employee_number = ?
  `).get(employeeNumber);
  assert.equal(await verifyPortalPassword("NeuesSehrSicheresPasswort!2026", user.password_hash), true);
  assert.equal(user.must_change_password, 0);
  assert.equal(user.failed_login_attempts, 0);
  assert.equal(user.locked_until, null);
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?").get(portalSessionId).revoked_at);
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(foreignSessions.portalSessionId).revoked_at);
  assert.equal(db.prepare("SELECT revoked_at FROM mobile_sessions WHERE id = ?")
    .get(foreignSessions.mobileSessionId).revoked_at, null);
  const mobile = db.prepare("SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?").get(mobileSessionId);
  assert.ok(mobile.revoked_at);
  assert.equal(mobile.revoked_reason, "password_reset");
  assert.ok(db.prepare("SELECT revoked_at FROM portal_password_reset_tokens WHERE id = ?").get(siblingId).revoked_at);

  const reused = await request("/api/portal/v1/auth/password-reset/confirm", {
    token: rawToken,
    newPassword: "NochEinSehrSicheresPasswort!2026",
    repeatPassword: "NochEinSehrSicheresPasswort!2026",
  });
  assert.equal(reused.response.status, 410);
  assert.equal(reused.payload.code, "PORTAL_PASSWORD_RESET_INVALID");

  const auditRows = db.prepare(`
    SELECT actor, action, entity_id, detail
    FROM audit_log WHERE entity_id = ? AND action LIKE 'portal.password-reset.%'
  `).all(employeeNumber);
  assert.deepEqual(auditRows.map((row) => row.action).sort(), [
    "portal.password-reset.completed",
    "portal.password-reset.requested",
  ]);
  assert.equal(
    auditRows.find((row) => row.action === "portal.password-reset.requested")?.actor,
    "password-reset-public",
  );
  assert.equal(auditRows.find((row) => row.action === "portal.password-reset.requested").actor,
    "password-reset-public");
  assert.equal(auditRows.find((row) => row.action === "portal.password-reset.completed").actor,
    employeeNumber);
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_log
    WHERE actor = '92505' AND action = 'portal.password-reset.browser-session-revoked'
  `).get());
  assert.doesNotMatch(JSON.stringify(auditRows), /verified\.reset@example\.at/i);
  assert.equal(JSON.stringify(auditRows).includes(rawToken), false);
});

test("v0.92.5: geaenderte Verifikation entwertet alte Links und Anforderungen sind begrenzt", async () => {
  const employeeNumber = "92504";
  const oldEmail = "old.verified@example.at";
  const newEmail = "new.verified@example.at";
  await configurePersonalAccount(employeeNumber, oldEmail);
  const expectedOldEmailDeliveryCount = deliveries.length + 1;
  await request("/api/portal/v1/auth/password-reset/request", { email: oldEmail });
  await waitForDeliveryCount(expectedOldEmailDeliveryCount);
  const rawToken = deliveredToken();

  db.prepare(`
    UPDATE personnel_sensitive_records
    SET protected_payload = ?, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(protectedProfile(employeeNumber, newEmail), employeeNumber);
  db.prepare(`
    UPDATE personal_notification_contacts
    SET email_target_fingerprint = ?, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(targetFingerprint(newEmail), employeeNumber);

  const stale = await request("/api/portal/v1/auth/password-reset/confirm", {
    token: rawToken,
    newPassword: "NeuesSehrSicheresPasswort!2026",
    repeatPassword: "NeuesSehrSicheresPasswort!2026",
  });
  assert.equal(stale.response.status, 410);
  assert.equal(stale.payload.code, "PORTAL_PASSWORD_RESET_INVALID");

  const beforeRateCheck = deliveries.length;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await request("/api/portal/v1/auth/password-reset/request", {
      email: "verified.reset@example.at",
    });
    assert.equal(result.response.status, 202);
  }
  await waitForDeliveryCount(beforeRateCheck + 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(deliveries.length, beforeRateCheck + 2);
});
