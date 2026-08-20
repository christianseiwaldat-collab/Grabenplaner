"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-birthday-theme-api-"));
const protectedKeyId = "birthday-theme-api-v1";
const protectedKey = Buffer.alloc(32, 0x64).toString("base64");

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
const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const subject = require("../server");
const { app, db, organizationPersonnelRepository } = subject;

const EMPLOYEES = Object.freeze({
  today: "birthday-theme-today",
  followingDay: "birthday-theme-following-day",
  thirdDay: "birthday-theme-third-day",
  noBirthDate: "birthday-theme-no-birth-date",
  invalidBirthDate: "birthday-theme-invalid-birth-date",
  futureBirthDate: "birthday-theme-future-birth-date",
  policyOff: "birthday-theme-policy-off",
  assignmentOff: "birthday-theme-assignment-off",
  missingAssignment: "birthday-theme-missing-assignment",
  inactive: "birthday-theme-inactive",
  passwordChange: "birthday-theme-password-change",
});

let httpServer;
let baseUrl;
let locationId;
let departmentId;
let positionId;

function calendarDateAtOffset(dayOffset) {
  const today = viennaCalendarDate(new Date());
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
  return {
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function historicalBirthDateAtOffset(dayOffset) {
  const date = calendarDateAtOffset(dayOffset);
  const year = date.month === 2 && date.day === 29 ? 1992 : 1990;
  return `${year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function insertEmployee(employeeNumber, { mustChangePassword = false } = {}) {
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
    ) VALUES (?, 'test-only', 'employee', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, mustChangePassword ? 1 : 0);
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
    actor: "birthday-theme-test",
  });
}

function createEmployeeSession(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return { cookie: `grabenplaner_session=${token}` };
}

function createOrganizationSession() {
  const accountId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_organization_accounts (
      id, login_name, display_name, account_type, password_hash, active,
      must_change_password, created_by, updated_by
    ) VALUES (?, ?, 'Birthday Theme Organization', 'branch', 'test-only', 1, 0, 'test', 'test')
  `).run(accountId, `birthday-theme-${accountId.slice(0, 8)}`);
  db.prepare(`
    INSERT INTO portal_organization_sessions (id, account_id, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    accountId,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return { cookie: `grabenplaner_session=${token}` };
}

async function requestTheme(auth = null) {
  const response = await fetch(`${baseUrl}/api/portal/v1/me/birthday-presentation/theme`, {
    headers: {
      Accept: "application/json",
      ...(auth ? { Cookie: auth.cookie } : {}),
    },
  });
  return { response, payload: await response.json() };
}

test("Block 11 API: alle Eligibility-Daten werden in einem seriellen Read-only-Snapshot gelesen", () => {
  const start = serverSource.indexOf(
    'app.get("/api/portal/v1/me/birthday-presentation/theme"',
  );
  const end = serverSource.indexOf(
    'app.post("/api/portal/v1/me/birthday-presentation/claim"',
    start,
  );
  assert.ok(start >= 0 && end > start);
  const route = serverSource.slice(start, end);
  assert.match(route, /persistenceProvider\.transaction\(async \(executor\) => \{/);
  assert.match(route, /createApplicationRepositories\(executor\)/);
  assert.match(route, /portalBirthdayPresentationActor\([\s\S]*repositories\.organizationPersonnel/);
  assert.match(route, /personnelSensitiveProfile\([\s\S]*repositories\.organizationPersonnel/);
  assert.match(route, /\{ isolation: "serializable", readOnly: true \}\)/);
});

test.before(async () => {
  locationId = String(db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id);
  departmentId = Number(db.prepare(`
    SELECT id FROM departments WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 1
  `).get(locationId)?.id || 0);
  if (!departmentId) {
    departmentId = Number(db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Birthday Theme API', 1, 1, 991)
    `).run(locationId).lastInsertRowid);
  }
  positionId = String(db.prepare("SELECT id FROM positions ORDER BY id LIMIT 1").get().id);
  for (const employeeNumber of Object.values(EMPLOYEES)) {
    insertEmployee(employeeNumber, {
      mustChangePassword: employeeNumber === EMPLOYEES.passwordChange,
    });
  }

  for (const [employeeNumber, birthDate] of [
    [EMPLOYEES.today, historicalBirthDateAtOffset(0)],
    [EMPLOYEES.followingDay, historicalBirthDateAtOffset(-1)],
    [EMPLOYEES.thirdDay, historicalBirthDateAtOffset(-2)],
    [EMPLOYEES.invalidBirthDate, "1990-02-30"],
    [EMPLOYEES.futureBirthDate, "2099-12-31"],
    [EMPLOYEES.policyOff, historicalBirthDateAtOffset(0)],
    [EMPLOYEES.assignmentOff, historicalBirthDateAtOffset(0)],
    [EMPLOYEES.missingAssignment, historicalBirthDateAtOffset(0)],
    [EMPLOYEES.inactive, historicalBirthDateAtOffset(0)],
    [EMPLOYEES.passwordChange, historicalBirthDateAtOffset(0)],
  ]) await storeProtectedBirthDate(employeeNumber, birthDate);

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
    [EMPLOYEES.today, "elegant"],
    [EMPLOYEES.followingDay, "technik"],
    [EMPLOYEES.thirdDay, "farbenfroh"],
    [EMPLOYEES.noBirthDate, "standard"],
    [EMPLOYEES.invalidBirthDate, "standard"],
    [EMPLOYEES.futureBirthDate, "fotowelt"],
    [EMPLOYEES.policyOff, "standard"],
    [EMPLOYEES.assignmentOff, "off"],
    [EMPLOYEES.inactive, "standard"],
    [EMPLOYEES.passwordChange, "standard"],
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

test("Block 11 API: nur ein persönlicher Zugang ohne Passwortwechselpflicht ist zulässig", async () => {
  const anonymous = await requestTheme();
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.payload.code, "PORTAL_LOGIN_REQUIRED");
  assert.equal(anonymous.response.headers.get("cache-control"), "private, no-store, max-age=0");

  const organization = await requestTheme(createOrganizationSession());
  assert.equal(organization.response.status, 403);
  assert.equal(organization.payload.code, "PORTAL_EMPLOYEE_ACCOUNT_REQUIRED");

  const passwordChange = await requestTheme(createEmployeeSession(EMPLOYEES.passwordChange));
  assert.equal(passwordChange.response.status, 428);
  assert.equal(passwordChange.payload.code, "PORTAL_PASSWORD_CHANGE_REQUIRED");
});

test("Block 11 API: Geburtstag und Folgetag liefern ausschließlich die freigegebene Theme-ID", async () => {
  const auditBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
  const claimBefore = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_birthday_presentation_claims
  `).get().count);

  const today = await requestTheme(createEmployeeSession(EMPLOYEES.today));
  assert.equal(today.response.status, 200, JSON.stringify(today.payload));
  assert.equal(today.response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(today.response.headers.get("pragma"), "no-cache");
  assert.deepEqual(today.payload, { theme: { id: "elegant" } });

  const following = await requestTheme(createEmployeeSession(EMPLOYEES.followingDay));
  assert.equal(following.response.status, 200, JSON.stringify(following.payload));
  assert.deepEqual(following.payload, { theme: { id: "technik" } });

  for (const payload of [today.payload, following.payload]) {
    assert.deepEqual(Object.keys(payload), ["theme"]);
    assert.deepEqual(Object.keys(payload.theme), ["id"]);
    assert.doesNotMatch(
      JSON.stringify(payload),
      /birth|geburt|date|datum|age|alter|year|jahr|phase|reason|grund|revision|1990|2099/i,
    );
  }
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count), auditBefore);
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_birthday_presentation_claims
  `).get().count), claimBefore);
});

test("Block 11 API: dritter Tag und fehlende, ungültige oder zukünftige Daten bleiben uniform null", async () => {
  for (const employeeNumber of [
    EMPLOYEES.thirdDay,
    EMPLOYEES.noBirthDate,
    EMPLOYEES.invalidBirthDate,
    EMPLOYEES.futureBirthDate,
    EMPLOYEES.missingAssignment,
    EMPLOYEES.assignmentOff,
  ]) {
    const result = await requestTheme(createEmployeeSession(employeeNumber));
    assert.equal(result.response.status, 200, `${employeeNumber}: ${JSON.stringify(result.payload)}`);
    assert.deepEqual(result.payload, { theme: null });
  }
});

test("Block 11 API: globale Deaktivierung wird live und ohne Sitzungsneuanmeldung wirksam", async () => {
  const auth = createEmployeeSession(EMPLOYEES.policyOff);
  db.prepare(`
    UPDATE portal_birthday_presentation_policy
    SET enabled = 0, revision = revision + 1, updated_at = ?
    WHERE singleton_id = 1
  `).run(new Date().toISOString());
  const disabled = await requestTheme(auth);
  assert.equal(disabled.response.status, 200);
  assert.deepEqual(disabled.payload, { theme: null });
  db.prepare(`
    UPDATE portal_birthday_presentation_policy
    SET enabled = 1, revision = revision + 1, updated_at = ?
    WHERE singleton_id = 1
  `).run(new Date().toISOString());
  const enabled = await requestTheme(auth);
  assert.equal(enabled.response.status, 200);
  assert.deepEqual(enabled.payload, { theme: { id: "standard" } });
});

test("Block 11 API: live deaktivierter Zugang wird trotz bestehender Sitzung gesperrt", async () => {
  const auth = createEmployeeSession(EMPLOYEES.inactive);
  db.prepare("UPDATE portal_users SET active = 0 WHERE employee_number = ?").run(EMPLOYEES.inactive);
  const inactiveUser = await requestTheme(auth);
  assert.equal(inactiveUser.response.status, 401);
  assert.equal(inactiveUser.payload.code, "PORTAL_LOGIN_REQUIRED");

  db.prepare("UPDATE portal_users SET active = 1 WHERE employee_number = ?").run(EMPLOYEES.inactive);
  const employeeAuth = createEmployeeSession(EMPLOYEES.inactive);
  db.prepare("UPDATE employees SET active = 0 WHERE personnel_number = ?").run(EMPLOYEES.inactive);
  const inactiveEmployee = await requestTheme(employeeAuth);
  assert.equal(inactiveEmployee.response.status, 401);
  assert.equal(inactiveEmployee.payload.code, "PORTAL_LOGIN_REQUIRED");
});
