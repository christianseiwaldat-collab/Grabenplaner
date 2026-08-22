"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-loan-document-email-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";
process.env.GRABENPLANER_AMU_KEY_ID = "loan-document-email-test-v1";
process.env.GRABENPLANER_AMU_KEY = Buffer.alloc(32, 23).toString("base64");
process.env.GRABENPLANER_EMAIL_PROVIDER = "custom-smtp";
process.env.GRABENPLANER_SMTP_HOST = "smtp.example.test";
process.env.GRABENPLANER_SMTP_FROM = "Grabenplaner <app@example.test>";
process.env.GRABENPLANER_SMTP_USER = "test-user";
process.env.GRABENPLANER_SMTP_PASSWORD = "test-password";
process.env.GRABENPLANER_EMAIL_DISPATCH_ENABLED = "1";
process.env.GRABENPLANER_EMAIL_SENDER_APPROVED = "1";
process.env.GRABENPLANER_EMAIL_ALLOWED_EVENTS = "destination_verification,loan_document";

const deliveries = [];
const nodemailer = require("nodemailer");
const nativeCreateTransport = nodemailer.createTransport;
nodemailer.createTransport = () => ({
  async sendMail(message) {
    deliveries.push({
      recipient: String(message.to || "").toLowerCase(),
      subject: String(message.subject || ""),
      text: String(message.text || ""),
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
    });
    return { accepted: [message.to] };
  },
});

const { createAmuStorage } = require("../lib/amu-storage");
const {
  app,
  db,
  releaseInstanceLockForTests,
} = require("../server");

const INTERNAL_RECIPIENT = "loan-email-admin";
const BORROWER = "loan-email-borrower";
const INTERNAL_EMAIL = "chris.test@example.at";
const ADDITIONAL_EMAIL = "grabenweg.test@example.at";
let baseUrl;
let httpServer;
let locationId;
let internalSession;
let borrowerSession;

const profileStorage = createAmuStorage({
  rootDirectory: path.join(testRoot, "profile-cipher"),
  encryptionKeys: {
    [process.env.GRABENPLANER_AMU_KEY_ID]: process.env.GRABENPLANER_AMU_KEY,
  },
  activeKeyId: process.env.GRABENPLANER_AMU_KEY_ID,
});

function ensureEmployee(employeeNumber, name, role) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      active = 1
  `).run(employeeNumber, name, name.split(" ")[0], locationId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      role_locked = excluded.role_locked,
      active = 1,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role, Number(role === "developer"));
}

function createSession(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
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
  };
}

function setPrivateEmail(employeeNumber, privateEmail) {
  const protectedPayload = profileStorage.protectRecord(JSON.stringify({ privateEmail, phone: "" }), {
    namespace: "personnel-sensitive-record",
    recordId: employeeNumber,
    field: "payload",
    employeeNumber,
  });
  db.prepare(`
    INSERT INTO personnel_sensitive_records
      (employee_number, protected_payload, updated_by, updated_at)
    VALUES (?, ?, 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      protected_payload = excluded.protected_payload,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, protectedPayload);
}

async function request(route, { method = "GET", session = borrowerSession, body } = {}) {
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

async function verifyInternalEmail() {
  const sent = await request("/api/portal/v1/me/email-settings/verification", {
    method: "POST",
    session: internalSession,
    body: { channel: "email" },
  });
  assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
  const verification = deliveries.at(-1);
  assert.equal(verification.recipient, INTERNAL_EMAIL);
  const code = verification.text.match(/\b(\d{6})\b/)?.[1] || "";
  assert.match(code, /^\d{6}$/);
  const confirmed = await request("/api/portal/v1/me/email-settings/verification/confirm", {
    method: "POST",
    session: internalSession,
    body: { channel: "email", code },
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.payload));
  assert.equal(confirmed.payload.targets.email.status, "verified");
  deliveries.length = 0;
}

async function configureLoanEmails(additionalEmail) {
  const configured = await request(`/api/portal/v1/loans/settings/locations/${locationId}`, {
    method: "PUT",
    session: internalSession,
    body: {
      enabled: true,
      articleLookup: { enabled: false, provider: "none", baseUrl: "" },
      documentRecipientEmployeeNumber: INTERNAL_RECIPIENT,
      emailDelivery: { enabled: true, recipient: additionalEmail },
    },
  });
  assert.equal(configured.response.status, 200, JSON.stringify(configured.payload));
  assert.equal(configured.payload.location.emailDelivery.provider.loanDocumentAvailable, true);
  assert.deepEqual(configured.payload.location.documentRecipient.emailDelivery, {
    available: true,
    status: "verified",
  });
}

async function issueLoan(serialNumber) {
  const issued = await request("/api/portal/v1/loans", {
    method: "POST",
    body: {
      locationId,
      dueDate: "2027-01-15",
      notes: "E-Mail-Integrationstest",
      items: [{
        articleNumber: "089319",
        serialNumber,
        conditionOut: "good",
        note: "mit Akku",
      }],
    },
  });
  assert.equal(issued.response.status, 201, JSON.stringify(issued.payload));
  return issued.payload.loan;
}

test.before(async () => {
  locationId = String(db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id);
  ensureEmployee(INTERNAL_RECIPIENT, "Chris Belegempfang", "developer");
  ensureEmployee(BORROWER, "Berta Ausleihe", "employee");
  internalSession = createSession(INTERNAL_RECIPIENT);
  borrowerSession = createSession(BORROWER);
  setPrivateEmail(INTERNAL_RECIPIENT, INTERNAL_EMAIL);
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  await verifyInternalEmail();
  await configureLoanEmails(ADDITIONAL_EMAIL);
  const article = await request("/api/portal/v1/loans/articles/resolve", {
    method: "POST",
    body: {
      locationId,
      articleNumber: "089319",
      manualDescription: "Testkamera",
    },
  });
  assert.equal(article.response.status, 200, JSON.stringify(article.payload));
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  nodemailer.createTransport = nativeCreateTransport;
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Leihbeleg geht an bestätigte persönliche Adresse und zusätzliche Filialadresse", async () => {
  await configureLoanEmails(ADDITIONAL_EMAIL);
  deliveries.length = 0;
  const loan = await issueLoan("EMAIL-TEST-1");
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries.map((delivery) => delivery.recipient).sort(), [
    ADDITIONAL_EMAIL,
    INTERNAL_EMAIL,
  ].sort());
  for (const delivery of deliveries) {
    assert.match(delivery.subject, /Ausgabebeleg/);
    assert.equal(delivery.attachments.length, 1);
    assert.match(String(delivery.attachments[0].filename || ""), /\.pdf$/i);
    assert.equal(Buffer.isBuffer(delivery.attachments[0].content), true);
    assert.equal(delivery.attachments[0].content.subarray(0, 4).toString("ascii"), "%PDF");
  }
  const document = loan.documents[0];
  assert.equal(document.delivery.emailStatus, "sent");
  assert.equal(document.delivery.emailRecipients, 2);
  assert.equal(document.delivery.emailFailedRecipients, 0);
});

test("gleiche persönliche und zusätzliche Adresse wird nur einmal beliefert", async () => {
  await configureLoanEmails(INTERNAL_EMAIL.toUpperCase());
  deliveries.length = 0;
  const loan = await issueLoan("EMAIL-TEST-2");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].recipient, INTERNAL_EMAIL);
  assert.equal(loan.documents[0].delivery.emailStatus, "sent");
  assert.equal(loan.documents[0].delivery.emailRecipients, 1);
});
