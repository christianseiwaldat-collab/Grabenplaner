"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-birthday-claim-api-"));
const protectedKeyId = "birthday-claim-api-v1";
const protectedKey = Buffer.alloc(32, 0x63).toString("base64");

process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_AMU_KEY_ID = protectedKeyId;
process.env.GRABENPLANER_AMU_KEY = protectedKey;
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "UTC";

const { createAmuStorage } = require("../lib/amu-storage");
const {
  viennaCalendarDate,
} = require("../lib/portal-birthday-presentation-claim");
const subject = require("../server");
const { app, db, organizationPersonnelRepository } = subject;

const EMPLOYEES = Object.freeze({
  first: "birthday-claim-first",
  concurrent: "birthday-claim-concurrent",
  noBirthday: "birthday-claim-no-birthday",
  policyOff: "birthday-claim-policy-off",
  missingAssignment: "birthday-claim-missing-assignment",
  assignmentOff: "birthday-claim-assignment-off",
  futureBirthDate: "birthday-claim-future-birth-date",
  inactive: "birthday-claim-inactive",
  historical: "birthday-claim-historical",
  tampered: "birthday-claim-tampered",
});

let httpServer;
let baseUrl;
let locationId;
let departmentId;
let positionId;

function isoBirthDateForToday() {
  const today = viennaCalendarDate(new Date());
  const year = today.month === 2 && today.day === 29 ? 1992 : 1990;
  return `${year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
}

function isoNonBirthday() {
  const today = viennaCalendarDate(new Date());
  return today.month === 1 && today.day === 1 ? "1990-01-02" : "1990-01-01";
}

function insertEmployee(employeeNumber) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, position_id, active
    ) VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, ?, 1)
  `).run(employeeNumber, employeeNumber, employeeNumber, locationId, departmentId, positionId);
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', 'employee', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber);
}

async function storeProtectedBirthDate(employeeNumber, birthDate) {
  const storage = createAmuStorage({
    rootDirectory: path.join(testRoot, "protected-test-data"),
    encryptionKeys: { [protectedKeyId]: protectedKey },
    activeKeyId: protectedKeyId,
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const protectedPayload = storage.protectRecord(JSON.stringify({
    identity: { birthDate },
  }), {
    namespace: "personnel-sensitive-record",
    recordId: employeeNumber,
    field: "payload",
    employeeNumber,
  });
  await organizationPersonnelRepository.upsertPersonnelSensitiveRecord({
    employeeNumber,
    socialSecurityLookup: "",
    protectedPayload,
    actor: "birthday-claim-test",
  });
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

async function requestClaim(auth, { body = {}, includeCsrf = true, includeBody = true } = {}) {
  const headers = {
    Accept: "application/json",
    ...(auth ? { Cookie: auth.cookie } : {}),
    ...(includeBody ? { "Content-Type": "application/json" } : {}),
    ...(auth && includeCsrf ? { "X-CSRF-Token": auth.csrf } : {}),
  };
  const response = await fetch(`${baseUrl}/api/portal/v1/me/birthday-presentation/claim`, {
    method: "POST",
    headers,
    ...(includeBody ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { response, payload };
}

test.before(async () => {
  locationId = String(db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id);
  departmentId = Number(db.prepare(`
    SELECT id FROM departments WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 1
  `).get(locationId)?.id || 0);
  if (!departmentId) {
    departmentId = Number(db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Birthday Claim API', 1, 1, 990)
    `).run(locationId).lastInsertRowid);
  }
  positionId = String(db.prepare("SELECT id FROM positions ORDER BY id LIMIT 1").get().id);
  for (const employeeNumber of Object.values(EMPLOYEES)) insertEmployee(employeeNumber);
  await storeProtectedBirthDate(EMPLOYEES.first, isoBirthDateForToday());
  await storeProtectedBirthDate(EMPLOYEES.concurrent, isoBirthDateForToday());
  await storeProtectedBirthDate(EMPLOYEES.noBirthday, isoNonBirthday());
  for (const employeeNumber of [
    EMPLOYEES.policyOff,
    EMPLOYEES.missingAssignment,
    EMPLOYEES.assignmentOff,
    EMPLOYEES.inactive,
    EMPLOYEES.historical,
    EMPLOYEES.tampered,
  ]) await storeProtectedBirthDate(employeeNumber, isoBirthDateForToday());
  const today = viennaCalendarDate(new Date());
  const futureYear = today.month === 2 && today.day === 29 ? 2096 : 2099;
  await storeProtectedBirthDate(
    EMPLOYEES.futureBirthDate,
    `${futureYear}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`,
  );

  db.prepare(`
    UPDATE portal_birthday_presentation_policy
    SET enabled = 1, revision = revision + 1, updated_at = ?
    WHERE singleton_id = 1
  `).run(new Date().toISOString());
  const insertAssignment = db.prepare(`
    INSERT INTO portal_birthday_presentation_assignments (
      employee_number, presentation_id, revision, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?)
  `);
  for (const [employeeNumber, presentationId] of [
    [EMPLOYEES.first, "elegant"],
    [EMPLOYEES.concurrent, "technik"],
    [EMPLOYEES.noBirthday, "farbenfroh"],
    [EMPLOYEES.policyOff, "standard"],
    [EMPLOYEES.assignmentOff, "off"],
    [EMPLOYEES.futureBirthDate, "fotowelt"],
    [EMPLOYEES.inactive, "standard"],
    [EMPLOYEES.historical, "farbenfroh"],
    [EMPLOYEES.tampered, "technik"],
  ]) {
    const now = new Date().toISOString();
    insertAssignment.run(employeeNumber, presentationId, now, now);
  }

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Block 10 API: persönlicher Claim verlangt CSRF und exakt ein leeres Objekt", async () => {
  const anonymous = await requestClaim(null);
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.payload.code, "PORTAL_LOGIN_REQUIRED");

  const auth = createSession(EMPLOYEES.first);
  const noCsrf = await requestClaim(auth, { includeCsrf: false });
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.payload.code, "PORTAL_CSRF_INVALID");

  const noBody = await requestClaim(auth, { includeBody: false });
  assert.equal(noBody.response.status, 400);
  assert.equal(noBody.payload.code, "PORTAL_BIRTHDAY_PRESENTATION_CLAIM_INPUT_INVALID");

  const extra = await requestClaim(auth, { body: { year: 2026 } });
  assert.equal(extra.response.status, 400);
  assert.equal(extra.payload.code, "PORTAL_BIRTHDAY_PRESENTATION_CLAIM_INPUT_INVALID");

  db.prepare("UPDATE portal_users SET must_change_password = 1 WHERE employee_number = ?")
    .run(EMPLOYEES.policyOff);
  const passwordRequired = await requestClaim(createSession(EMPLOYEES.policyOff));
  assert.equal(passwordRequired.response.status, 428);
  assert.equal(passwordRequired.payload.code, "PORTAL_PASSWORD_CHANGE_REQUIRED");
  db.prepare("UPDATE portal_users SET must_change_password = 0 WHERE employee_number = ?")
    .run(EMPLOYEES.policyOff);
});

test("Block 10 API: globale Sperre, fehlende/ausgeschaltete Zuordnung und ungültige Daten bleiben uniform null", async () => {
  db.prepare(`
    UPDATE portal_birthday_presentation_policy
    SET enabled = 0, revision = revision + 1, updated_at = '2099-01-01T00:00:00.000Z'
    WHERE singleton_id = 1
  `).run();
  const policyOff = await requestClaim(createSession(EMPLOYEES.policyOff));
  assert.equal(policyOff.response.status, 200);
  assert.deepEqual(policyOff.payload, { presentation: null });
  db.prepare(`
    UPDATE portal_birthday_presentation_policy
    SET enabled = 1, revision = revision + 1, updated_at = '2099-01-01T00:00:01.000Z'
    WHERE singleton_id = 1
  `).run();

  for (const employeeNumber of [
    EMPLOYEES.missingAssignment,
    EMPLOYEES.assignmentOff,
    EMPLOYEES.futureBirthDate,
  ]) {
    const result = await requestClaim(createSession(employeeNumber));
    assert.equal(result.response.status, 200, `${employeeNumber}: ${JSON.stringify(result.payload)}`);
    assert.deepEqual(result.payload, { presentation: null });
  }
});

test("Block 10 API: live deaktivierter Zugang wird trotz bestehender Sitzung nicht zugelassen", async () => {
  const auth = createSession(EMPLOYEES.inactive);
  db.prepare("UPDATE portal_users SET active = 0 WHERE employee_number = ?").run(EMPLOYEES.inactive);
  const inactive = await requestClaim(auth);
  assert.equal(inactive.response.status, 401);
  assert.equal(inactive.payload.code, "PORTAL_LOGIN_REQUIRED");

  db.prepare("UPDATE portal_users SET active = 1 WHERE employee_number = ?").run(EMPLOYEES.inactive);
  const employeeSession = createSession(EMPLOYEES.inactive);
  db.prepare("UPDATE employees SET active = 0 WHERE personnel_number = ?").run(EMPLOYEES.inactive);
  const inactiveEmployee = await requestClaim(employeeSession);
  assert.equal(inactiveEmployee.response.status, 401);
  assert.equal(inactiveEmployee.payload.code, "PORTAL_LOGIN_REQUIRED");
});

test("Block 10 API: erster Geburtstag-Claim liefert nur die Darstellung, danach uniform null", async () => {
  const auditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  const auth = createSession(EMPLOYEES.first);
  const first = await requestClaim(auth);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(first.payload, {
    presentation: {
      id: "elegant",
      label: "Elegant",
      previewUrl: "/assets/birthday-presentations/elegant.svg",
    },
  });
  const second = await requestClaim(createSession(EMPLOYEES.first));
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.payload, { presentation: null });
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), auditBefore);
  assert.equal(JSON.stringify(first.payload).includes(String(viennaCalendarDate(new Date()).year)), false);
  const keys = [];
  const collectKeys = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      collectKeys(nested);
    }
  };
  collectKeys(first.payload);
  assert.equal(keys.some((key) => /reason|birthdate|dateofbirth|age|alter|year|revision/i.test(key)), false);

  db.prepare(`
    UPDATE portal_birthday_presentation_assignments
    SET presentation_id = 'technik', revision = revision + 1,
        updated_at = '2099-01-01T00:00:02.000Z'
    WHERE employee_number = ?
  `).run(EMPLOYEES.first);
  const changedAfterClaim = await requestClaim(createSession(EMPLOYEES.first));
  assert.deepEqual(changedAfterClaim.payload, { presentation: null });
  assert.deepEqual({ ...db.prepare(`
    SELECT presentation_id AS presentationId, assignment_revision AS assignmentRevision
    FROM portal_birthday_presentation_claims WHERE employee_number = ?
  `).get(EMPLOYEES.first) }, { presentationId: "elegant", assignmentRevision: 1 });
});

test("Block 10 API: parallele Sitzungen gewinnen exakt einmal und Nichtgeburtstag bleibt null", async () => {
  const [left, right] = await Promise.all([
    requestClaim(createSession(EMPLOYEES.concurrent)),
    requestClaim(createSession(EMPLOYEES.concurrent)),
  ]);
  assert.equal(left.response.status, 200, JSON.stringify(left.payload));
  assert.equal(right.response.status, 200, JSON.stringify(right.payload));
  assert.equal([left, right].filter(({ payload }) => payload.presentation !== null).length, 1);
  assert.equal([left, right].filter(({ payload }) => payload.presentation === null).length, 1);

  const noBirthday = await requestClaim(createSession(EMPLOYEES.noBirthday));
  assert.equal(noBirthday.response.status, 200);
  assert.deepEqual(noBirthday.payload, { presentation: null });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_birthday_presentation_claims
    WHERE employee_number = ?
  `).get(EMPLOYEES.noBirthday).count, 0);
});

test("Block 10 API: Vorjahresnachweis blockiert das aktuelle Ereignis nicht, manipulierte aktuelle PK schon", async () => {
  const currentYear = viennaCalendarDate(new Date()).year;
  db.prepare(`
    INSERT INTO portal_birthday_presentation_claims (
      employee_number, event_year, presentation_id, policy_revision,
      assignment_revision, receipt_sha256, revision
    ) VALUES (?, ?, 'standard', 1, 1, ?, 1)
  `).run(EMPLOYEES.historical, currentYear - 1, "a".repeat(64));
  const historical = await requestClaim(createSession(EMPLOYEES.historical));
  assert.equal(historical.response.status, 200);
  assert.equal(historical.payload.presentation?.id, "farbenfroh");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_birthday_presentation_claims
    WHERE employee_number = ?
  `).get(EMPLOYEES.historical).count, 2);

  db.prepare(`
    INSERT INTO portal_birthday_presentation_claims (
      employee_number, event_year, presentation_id, policy_revision,
      assignment_revision, receipt_sha256, revision
    ) VALUES (?, ?, 'technik', 1, 1, ?, 1)
  `).run(EMPLOYEES.tampered, currentYear, "f".repeat(64));
  const tampered = await requestClaim(createSession(EMPLOYEES.tampered));
  assert.equal(tampered.response.status, 200);
  assert.deepEqual(tampered.payload, { presentation: null });
  assert.equal(Object.keys(tampered.payload).length, 1);
  assert.equal(tampered.response.headers.get("pragma"), "no-cache");
});
