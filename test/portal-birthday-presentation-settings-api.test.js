"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-birthday-settings-api-"));
const protectedKeyId = "birthday-api-test-v1";
const protectedKey = Buffer.alloc(32, 0x52).toString("base64");

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
process.env.TZ = "Europe/Vienna";

const { createAmuStorage } = require("../lib/amu-storage");
const {
  PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS,
  PORTAL_BIRTHDAY_PRESENTATIONS,
} = require("../lib/portal-birthday-presentations");
const subject = require("../server");
const { app, db, organizationPersonnelRepository } = subject;

const PREFIX = "birthday-api-";
const FOREIGN_LOCATION = "birthday-api-foreign-location";
const SECRET_BIRTH_DATE = "1987-11-23";
const ACTORS = Object.freeze({
  hr: `${PREFIX}hr`,
  admin: `${PREFIX}admin`,
  itAdmin: `${PREFIX}it-admin`,
  developer: `${PREFIX}developer`,
  manager: `${PREFIX}manager`,
  foreignManager: `${PREFIX}foreign-manager`,
  departmentManager: `${PREFIX}department-manager`,
  departmentManagerTwo: `${PREFIX}department-manager-two`,
  foreignDepartmentManager: `${PREFIX}foreign-department-manager`,
  employee: `${PREFIX}employee`,
});
const TARGETS = Object.freeze({
  withBirthDate: `${PREFIX}team-with-birth-date`,
  withoutBirthDate: `${PREFIX}team-without-birth-date`,
  secondDepartment: `${PREFIX}team-second-department`,
  foreign: `${PREFIX}team-foreign`,
  inactive: `${PREFIX}team-inactive`,
});

let httpServer;
let baseUrl;
let homeLocation;
let homeDepartment;
let secondDepartment;
let foreignDepartment;
let positionId;

function insertEmployee(employeeNumber, {
  locationId = homeLocation,
  departmentId = homeDepartment,
  active = true,
  displayName = `Testperson ${employeeNumber}`,
} = {}) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, position_id, active
    ) VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, ?, ?)
  `).run(
    employeeNumber,
    displayName,
    displayName,
    locationId,
    departmentId,
    positionId,
    active ? 1 : 0,
  );
}

function insertPortalUser(employeeNumber, role) {
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
}

function insertScope(employeeNumber, locationId, departmentId) {
  db.prepare(`
    INSERT INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES (?, ?, ?, ?)
  `).run(employeeNumber, locationId, departmentId ?? 0, ACTORS.developer);
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

async function request(route, {
  method = "GET",
  auth = null,
  body,
  includeCsrf = true,
} = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && includeCsrf && !["GET", "HEAD"].includes(method)) {
    headers["X-CSRF-Token"] = auth.csrf;
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
  return { response, payload, text };
}

function employeeProjection(payload, employeeNumber) {
  return (Array.isArray(payload?.employees) ? payload.employees : [])
    .find((employee) => employee?.employeeNumber === employeeNumber);
}

function delegateProjection(payload, employeeNumber) {
  return (Array.isArray(payload?.delegates) ? payload.delegates : [])
    .find((delegate) => delegate?.employeeNumber === employeeNumber);
}

function assertPrivacyProjection(payload) {
  const forbiddenKey = /^(?:birth(?:date|day|year)|birthday(?:date|day|year)?|dateofbirth|hasbirthdate|nextbirthday|age|alter|geburtsdatum|geburtsjahr|geburtstag)$/i;
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.doesNotMatch(key, forbiddenKey, `Verbotenes Geburtstags-/Altersfeld: ${key}`);
      visit(nested);
    }
  };
  visit(payload);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(SECRET_BIRTH_DATE), false, "Geburtsdatum darf nicht projiziert werden");
  assert.equal(serialized.includes("1987"), false, "Geburtsjahr darf nicht projiziert werden");
}

function assertCapabilities(payload, expected) {
  assert.deepEqual(payload?.capabilities, {
    canManageGlobal: expected.canManageGlobal,
    canManageTeam: expected.canManageTeam,
    canDelegateTeam: expected.canDelegateTeam,
  });
}

async function settings(auth) {
  const result = await request("/api/portal/v1/birthday-presentation-settings", { auth });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload;
}

async function storeProtectedBirthDate(employeeNumber) {
  const storage = createAmuStorage({
    rootDirectory: path.join(testRoot, "protected-test-data"),
    encryptionKeys: { [protectedKeyId]: protectedKey },
    activeKeyId: protectedKeyId,
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const protectedPayload = storage.protectRecord(JSON.stringify({
    identity: { birthDate: SECRET_BIRTH_DATE },
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
    actor: ACTORS.developer,
  });
}

test.before(async () => {
  homeLocation = String(db.prepare(`
    SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1
  `).get().id);
  positionId = String(db.prepare("SELECT id FROM positions ORDER BY id LIMIT 1").get().id);
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Geburtstags-API Fremdfiliale', 1, '{}', 1)
  `).run(FOREIGN_LOCATION);
  homeDepartment = Number(db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1
    ORDER BY id LIMIT 1
  `).get(homeLocation)?.id || 0);
  if (!homeDepartment) {
    homeDepartment = Number(db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Geburtstags-API Stammabteilung', 1, 1, 991)
    `).run(homeLocation).lastInsertRowid);
  }
  secondDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Geburtstags-API Zweitabteilung', 1, 1, 992)
  `).run(homeLocation).lastInsertRowid);
  foreignDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Geburtstags-API Fremdabteilung', 1, 1, 993)
  `).run(FOREIGN_LOCATION).lastInsertRowid);

  const actorRows = [
    [ACTORS.hr, "hr", homeLocation, homeDepartment],
    [ACTORS.admin, "admin", homeLocation, homeDepartment],
    [ACTORS.itAdmin, "it_admin", homeLocation, homeDepartment],
    [ACTORS.developer, "developer", homeLocation, homeDepartment],
    [ACTORS.manager, "manager", homeLocation, null],
    [ACTORS.foreignManager, "manager", FOREIGN_LOCATION, null],
    [ACTORS.departmentManager, "department_manager", homeLocation, homeDepartment],
    [ACTORS.departmentManagerTwo, "department_manager", homeLocation, secondDepartment],
    [ACTORS.foreignDepartmentManager, "department_manager", FOREIGN_LOCATION, foreignDepartment],
    [ACTORS.employee, "employee", homeLocation, homeDepartment],
  ];
  for (const [employeeNumber, role, locationId, departmentId] of actorRows) {
    insertEmployee(employeeNumber, { locationId, departmentId });
    insertPortalUser(employeeNumber, role);
  }
  insertScope(ACTORS.manager, homeLocation, null);
  insertScope(ACTORS.foreignManager, FOREIGN_LOCATION, null);
  insertScope(ACTORS.departmentManager, homeLocation, homeDepartment);
  insertScope(ACTORS.departmentManagerTwo, homeLocation, secondDepartment);
  insertScope(ACTORS.foreignDepartmentManager, FOREIGN_LOCATION, foreignDepartment);

  insertEmployee(TARGETS.withBirthDate, { departmentId: homeDepartment });
  insertEmployee(TARGETS.withoutBirthDate, { departmentId: homeDepartment });
  insertEmployee(TARGETS.secondDepartment, { departmentId: secondDepartment });
  insertEmployee(TARGETS.foreign, {
    locationId: FOREIGN_LOCATION,
    departmentId: foreignDepartment,
  });
  insertEmployee(TARGETS.inactive, { departmentId: homeDepartment, active: false });
  await storeProtectedBirthDate(TARGETS.withBirthDate);

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

test("Block 8 API: GET trennt PL+, FL, delegierte AL, technische Rollen und lokale Anonymität", async () => {
  const anonymous = await request("/api/portal/v1/birthday-presentation-settings");
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));
  assert.equal(anonymous.payload?.code, "PORTAL_LOGIN_REQUIRED");

  for (const employeeNumber of [ACTORS.employee, ACTORS.itAdmin, ACTORS.departmentManager]) {
    const denied = await request("/api/portal/v1/birthday-presentation-settings", {
      auth: createSession(employeeNumber),
    });
    assert.equal(denied.response.status, 403, `${employeeNumber}: ${JSON.stringify(denied.payload)}`);
    assert.equal(denied.payload?.code, "PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_DENIED");
  }

  for (const employeeNumber of [ACTORS.hr, ACTORS.admin]) {
    const payload = await settings(createSession(employeeNumber));
    assertCapabilities(payload, {
      canManageGlobal: true,
      canManageTeam: false,
      canDelegateTeam: true,
    });
    assert.deepEqual(payload.employees, []);
    assert.equal(payload.delegates.some(
      (delegate) => delegate.employeeNumber === ACTORS.departmentManager,
    ), true);
    assert.equal(payload.delegates.some(
      (delegate) => delegate.employeeNumber === ACTORS.foreignDepartmentManager,
    ), true);
    assertPrivacyProjection(payload);
  }

  const manager = await settings(createSession(ACTORS.manager));
  assertCapabilities(manager, {
    canManageGlobal: false,
    canManageTeam: true,
    canDelegateTeam: true,
  });

  const developer = await settings(createSession(ACTORS.developer));
  assertCapabilities(developer, {
    canManageGlobal: true,
    canManageTeam: true,
    canDelegateTeam: true,
  });
});

test("Block 8 API: GET projiziert nur das aktive eigene Team und erzeugt keinen Geburtsdaten- oder Listen-Leak", async () => {
  const payload = await settings(createSession(ACTORS.manager));
  assert.deepEqual(payload.presentations, PORTAL_BIRTHDAY_PRESENTATIONS);
  assert.equal(typeof payload.policy?.enabled, "boolean");
  assert.equal(Number.isSafeInteger(payload.policy?.revision), true);

  const employeeNumbers = payload.employees.map((employee) => employee.employeeNumber);
  assert.equal(employeeNumbers.includes(TARGETS.withBirthDate), true);
  assert.equal(employeeNumbers.includes(TARGETS.withoutBirthDate), true);
  assert.equal(employeeNumbers.includes(TARGETS.secondDepartment), true);
  assert.equal(employeeNumbers.includes(TARGETS.foreign), false);
  assert.equal(employeeNumbers.includes(TARGETS.inactive), false);
  assert.equal(new Set(employeeNumbers).size, employeeNumbers.length);

  const delegateNumbers = payload.delegates.map((delegate) => delegate.employeeNumber);
  assert.equal(delegateNumbers.includes(ACTORS.departmentManager), true);
  assert.equal(delegateNumbers.includes(ACTORS.departmentManagerTwo), true);
  assert.equal(delegateNumbers.includes(ACTORS.foreignDepartmentManager), false);
  assertPrivacyProjection(payload);
});

test("Block 8 API: globale Aktivierung ist PL+- und CSRF-gebunden sowie revisionssicher", async () => {
  const hr = createSession(ACTORS.hr);
  const manager = createSession(ACTORS.manager);
  const before = await settings(hr);
  const nextEnabled = before.policy.enabled !== true;

  const missingCsrf = await request(
    "/api/portal/v1/birthday-presentation-settings/global",
    {
      method: "PUT",
      auth: hr,
      includeCsrf: false,
      body: { enabled: nextEnabled, expectedRevision: before.policy.revision },
    },
  );
  assert.equal(missingCsrf.response.status, 403, JSON.stringify(missingCsrf.payload));
  assert.equal(missingCsrf.payload?.code, "PORTAL_CSRF_INVALID");

  const localDenied = await request(
    "/api/portal/v1/birthday-presentation-settings/global",
    {
      method: "PUT",
      auth: manager,
      body: { enabled: nextEnabled, expectedRevision: before.policy.revision },
    },
  );
  assert.equal(localDenied.response.status, 403, JSON.stringify(localDenied.payload));
  assert.equal(
    localDenied.payload?.code,
    "PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_DENIED",
  );

  const unknownField = await request(
    "/api/portal/v1/birthday-presentation-settings/global",
    {
      method: "PUT",
      auth: hr,
      body: {
        enabled: nextEnabled,
        expectedRevision: before.policy.revision,
        birthYear: 1987,
      },
    },
  );
  assert.equal(unknownField.response.status, 400, JSON.stringify(unknownField.payload));

  const changed = await request(
    "/api/portal/v1/birthday-presentation-settings/global",
    {
      method: "PUT",
      auth: hr,
      body: { enabled: nextEnabled, expectedRevision: before.policy.revision },
    },
  );
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));

  const after = await settings(hr);
  assert.equal(after.policy.enabled, nextEnabled);
  assert.equal(after.policy.revision, before.policy.revision + 1);
  assertPrivacyProjection(after);

  const stale = await request(
    "/api/portal/v1/birthday-presentation-settings/global",
    {
      method: "PUT",
      auth: hr,
      body: { enabled: !nextEnabled, expectedRevision: before.policy.revision },
    },
  );
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
});

test("Block 8 API: FL setzt nur freigegebene Darstellungen im eigenen aktiven Team", async () => {
  const manager = createSession(ACTORS.manager);
  const before = await settings(manager);
  const targetBefore = employeeProjection(before, TARGETS.withBirthDate);
  assert.ok(targetBefore);

  const missingCsrf = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.withBirthDate)}`,
    {
      method: "PUT",
      auth: manager,
      includeCsrf: false,
      body: { presentationId: "fotowelt", expectedRevision: targetBefore.revision },
    },
  );
  assert.equal(missingCsrf.response.status, 403, JSON.stringify(missingCsrf.payload));
  assert.equal(missingCsrf.payload?.code, "PORTAL_CSRF_INVALID");

  const invalidPresentation = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.withBirthDate)}`,
    {
      method: "PUT",
      auth: manager,
      body: { presentationId: "confetti-from-url", expectedRevision: targetBefore.revision },
    },
  );
  assert.equal(invalidPresentation.response.status, 400, JSON.stringify(invalidPresentation.payload));

  const unknownField = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.withBirthDate)}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        presentationId: "standard",
        expectedRevision: targetBefore.revision,
        age: 39,
      },
    },
  );
  assert.equal(unknownField.response.status, 400, JSON.stringify(unknownField.payload));

  const changed = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.withBirthDate)}`,
    {
      method: "PUT",
      auth: manager,
      body: { presentationId: "fotowelt", expectedRevision: targetBefore.revision },
    },
  );
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));

  const after = await settings(manager);
  const targetAfter = employeeProjection(after, TARGETS.withBirthDate);
  assert.equal(targetAfter.presentationId, "fotowelt");
  assert.equal(targetAfter.revision, targetBefore.revision + 1);
  assertPrivacyProjection(after);

  const stale = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.withBirthDate)}`,
    {
      method: "PUT",
      auth: manager,
      body: { presentationId: null, expectedRevision: targetBefore.revision },
    },
  );
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));

  for (const employeeNumber of [TARGETS.foreign, TARGETS.inactive, "birthday-api-unknown"]) {
    const hidden = await request(
      `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(employeeNumber)}`,
      {
        method: "PUT",
        auth: manager,
        body: { presentationId: "standard", expectedRevision: 0 },
      },
    );
    assert.equal(hidden.response.status, 404, `${employeeNumber}: ${JSON.stringify(hidden.payload)}`);
  }

  const disabled = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.withBirthDate)}`,
    {
      method: "PUT",
      auth: manager,
      body: { presentationId: null, expectedRevision: targetAfter.revision },
    },
  );
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  const disabledProjection = employeeProjection(await settings(manager), TARGETS.withBirthDate);
  assert.equal(disabledProjection.presentationId, null);
});

test("Block 8 API: FL delegiert AL nur im eigenen Bereich und der Entzug wirkt live", async () => {
  const manager = createSession(ACTORS.manager);
  const before = await settings(manager);
  const delegateBefore = delegateProjection(before, ACTORS.departmentManager);
  assert.ok(delegateBefore);
  assert.equal(delegateBefore.enabled, false);

  const missingCsrf = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManager)}`,
    {
      method: "PUT",
      auth: manager,
      includeCsrf: false,
      body: { enabled: true },
    },
  );
  assert.equal(missingCsrf.response.status, 403, JSON.stringify(missingCsrf.payload));
  assert.equal(missingCsrf.payload?.code, "PORTAL_CSRF_INVALID");

  const invalid = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManager)}`,
    { method: "PUT", auth: manager, body: { enabled: "yes" } },
  );
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));

  for (const invalidEmployeeNumber of ["ungültig\nAL", "ungültig\u0001AL", "ungültig\u007fAL"]) {
    const invalidTarget = await request(
      `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(invalidEmployeeNumber)}`,
      { method: "PUT", auth: manager, body: { enabled: true } },
    );
    assert.equal(invalidTarget.response.status, 400, JSON.stringify(invalidTarget.payload));
  }

  const foreign = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.foreignDepartmentManager)}`,
    { method: "PUT", auth: manager, body: { enabled: true } },
  );
  assert.equal(foreign.response.status, 404, JSON.stringify(foreign.payload));

  const enabled = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManager)}`,
    { method: "PUT", auth: manager, body: { enabled: true } },
  );
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.payload));
  assert.equal(delegateProjection(await settings(manager), ACTORS.departmentManager)?.enabled, true);

  const departmentManager = createSession(ACTORS.departmentManager);
  const delegated = await settings(departmentManager);
  assertCapabilities(delegated, {
    canManageGlobal: false,
    canManageTeam: true,
    canDelegateTeam: false,
  });
  const employeeNumbers = delegated.employees.map((employee) => employee.employeeNumber);
  assert.equal(employeeNumbers.includes(TARGETS.withBirthDate), true);
  assert.equal(employeeNumbers.includes(TARGETS.withoutBirthDate), true);
  assert.equal(employeeNumbers.includes(TARGETS.secondDepartment), false);
  assert.equal(employeeNumbers.includes(TARGETS.foreign), false);
  assert.deepEqual(delegated.delegates, []);
  assertPrivacyProjection(delegated);

  const ownTarget = employeeProjection(delegated, TARGETS.withoutBirthDate);
  assert.ok(ownTarget);
  const ownChange = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.withoutBirthDate)}`,
    {
      method: "PUT",
      auth: departmentManager,
      body: {
        presentationId: ownTarget.presentationId === "standard" ? null : "standard",
        expectedRevision: ownTarget.revision,
      },
    },
  );
  assert.equal(ownChange.response.status, 200, JSON.stringify(ownChange.payload));

  const otherDepartment = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.secondDepartment)}`,
    {
      method: "PUT",
      auth: departmentManager,
      body: { presentationId: "standard", expectedRevision: 0 },
    },
  );
  assert.equal(otherDepartment.response.status, 404, JSON.stringify(otherDepartment.payload));

  const forbiddenGlobal = await request(
    "/api/portal/v1/birthday-presentation-settings/global",
    {
      method: "PUT",
      auth: departmentManager,
      body: { enabled: true, expectedRevision: delegated.policy.revision },
    },
  );
  assert.equal(forbiddenGlobal.response.status, 403, JSON.stringify(forbiddenGlobal.payload));

  const forbiddenDelegation = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManagerTwo)}`,
    { method: "PUT", auth: departmentManager, body: { enabled: true } },
  );
  assert.equal(forbiddenDelegation.response.status, 403, JSON.stringify(forbiddenDelegation.payload));

  const disabled = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManager)}`,
    { method: "PUT", auth: manager, body: { enabled: false } },
  );
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  const revokedSession = await request("/api/portal/v1/birthday-presentation-settings", {
    auth: departmentManager,
  });
  assert.equal(revokedSession.response.status, 401, JSON.stringify(revokedSession.payload));
  const revokedRight = await request("/api/portal/v1/birthday-presentation-settings", {
    auth: createSession(ACTORS.departmentManager),
  });
  assert.equal(revokedRight.response.status, 403, JSON.stringify(revokedRight.payload));
  assert.equal(
    revokedRight.payload?.code,
    "PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_DENIED",
  );
});

test("Block 8 API: AL-Bereich bleibt an die eigene Stammabteilung gebunden", async () => {
  const manager = createSession(ACTORS.manager);
  db.prepare(`
    UPDATE portal_access_scopes SET department_id = ?
    WHERE employee_number = ? AND location_id = ?
  `).run(homeDepartment, ACTORS.departmentManagerTwo, homeLocation);
  try {
    const projected = await settings(manager);
    assert.equal(delegateProjection(projected, ACTORS.departmentManagerTwo), undefined);
    const blocked = await request(
      `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManagerTwo)}`,
      { method: "PUT", auth: manager, body: { enabled: true } },
    );
    assert.equal(blocked.response.status, 404, JSON.stringify(blocked.payload));
  } finally {
    db.prepare(`
      UPDATE portal_access_scopes SET department_id = ?
      WHERE employee_number = ? AND location_id = ?
    `).run(secondDepartment, ACTORS.departmentManagerTwo, homeLocation);
  }
});

test("Block 8 API: ein deaktivierter AL-Portalzugang erhält keine latente Delegation", async () => {
  const manager = createSession(ACTORS.manager);
  const hr = createSession(ACTORS.hr);
  db.prepare("UPDATE portal_users SET active = 0 WHERE employee_number = ?")
    .run(ACTORS.departmentManagerTwo);
  try {
    for (const auth of [manager, hr]) {
      const blocked = await request(
        `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManagerTwo)}`,
        { method: "PUT", auth, body: { enabled: true } },
      );
      assert.equal(blocked.response.status, 404, JSON.stringify(blocked.payload));
    }
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM portal_permission_grants
      WHERE employee_number = ? AND permission = ?
    `).get(
      ACTORS.departmentManagerTwo,
      PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE,
    ).count, 0);
  } finally {
    db.prepare("UPDATE portal_users SET active = 1 WHERE employee_number = ?")
      .run(ACTORS.departmentManagerTwo);
  }
});

test("Block 8 API: PL+ kann eine AL-Delegation sperren und wiederherstellen; FL kann die Sperre nicht umgehen", async () => {
  const manager = createSession(ACTORS.manager);
  const hr = createSession(ACTORS.hr);
  const deniedByPlPlus = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManager)}`,
    { method: "PUT", auth: hr, body: { enabled: false } },
  );
  assert.equal(deniedByPlPlus.response.status, 200, JSON.stringify(deniedByPlPlus.payload));
  const projected = await settings(manager);
  const delegate = delegateProjection(projected, ACTORS.departmentManager);
  assert.ok(delegate);
  assert.equal(delegate.denied, true);
  assert.equal(delegate.enabled, false);
  const blocked = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManager)}`,
    { method: "PUT", auth: manager, body: { enabled: true } },
  );
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload?.code, "PORTAL_BIRTHDAY_PRESENTATION_DELEGATION_LOCKED");

  const restoredByPlPlus = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManager)}`,
    { method: "PUT", auth: hr, body: { enabled: true } },
  );
  assert.equal(restoredByPlPlus.response.status, 200, JSON.stringify(restoredByPlPlus.payload));
  const restored = delegateProjection(await settings(manager), ACTORS.departmentManager);
  assert.equal(restored.denied, false);
  assert.equal(restored.enabled, true);

  const cleanedUp = await request(
    `/api/portal/v1/birthday-presentation-settings/delegates/${encodeURIComponent(ACTORS.departmentManager)}`,
    { method: "PUT", auth: manager, body: { enabled: false } },
  );
  assert.equal(cleanedUp.response.status, 200, JSON.stringify(cleanedUp.payload));

  const auditRows = db.prepare(`
    SELECT action, detail FROM audit_log
    WHERE entity_type = 'portal_user' AND entity_id = ?
      AND action LIKE 'portal.birthday-presentation.permission.%'
    ORDER BY id DESC LIMIT 3
  `).all(ACTORS.departmentManager);
  assert.equal(auditRows.some((row) => row.action.endsWith(".deny")), true);
  assert.equal(auditRows.some((row) => row.action.endsWith(".restore")), true);
  assert.equal(auditRows.every((row) => !JSON.stringify(row).includes(SECRET_BIRTH_DATE)), true);

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(
    ACTORS.manager,
    PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE,
    ACTORS.hr,
  );
  try {
    const denied = await request("/api/portal/v1/birthday-presentation-settings", { auth: manager });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(
      denied.payload?.code,
      "PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_DENIED",
    );
  } finally {
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ? AND permission = ?
    `).run(
      ACTORS.manager,
      PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE,
    );
  }
});

test("Block 8 API: jede Mutation wird PII-arm auditiert und ein Auditfehler rollt die Fachänderung zurück", async () => {
  const manager = createSession(ACTORS.manager);
  const before = await settings(manager);
  const first = employeeProjection(before, TARGETS.withoutBirthDate);
  const nextPresentationId = first.presentationId === "standard" ? null : "standard";
  const auditStart = Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_log").get().id);

  const changed = await request(
    `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.withoutBirthDate)}`,
    {
      method: "PUT",
      auth: manager,
      body: { presentationId: nextPresentationId, expectedRevision: first.revision },
    },
  );
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  const auditRows = db.prepare(`
    SELECT actor, action, entity_type, entity_id, detail
    FROM audit_log WHERE id > ? AND actor = ? ORDER BY id
  `).all(auditStart, ACTORS.manager);
  assert.equal(auditRows.length, 1, JSON.stringify(auditRows));
  assert.equal(auditRows[0].entity_id, TARGETS.withoutBirthDate);
  assertPrivacyProjection(auditRows);

  const stable = employeeProjection(await settings(manager), TARGETS.secondDepartment);
  db.exec(`
    CREATE TEMP TRIGGER birthday_api_test_fail_audit
    BEFORE INSERT ON audit_log
    WHEN NEW.actor = '${ACTORS.manager.replaceAll("'", "''")}'
    BEGIN
      SELECT RAISE(ABORT, 'birthday api audit failure');
    END;
  `);
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    const failed = await request(
      `/api/portal/v1/birthday-presentation-settings/employees/${encodeURIComponent(TARGETS.secondDepartment)}`,
      {
        method: "PUT",
        auth: manager,
        body: { presentationId: "standard", expectedRevision: stable.revision },
      },
    );
    assert.equal(failed.response.status >= 400, true, JSON.stringify(failed.payload));
  } finally {
    console.error = originalConsoleError;
    db.exec("DROP TRIGGER IF EXISTS birthday_api_test_fail_audit");
  }
  const afterFailure = employeeProjection(await settings(manager), TARGETS.secondDepartment);
  assert.equal(afterFailure.presentationId, stable.presentationId);
  assert.equal(afterFailure.revision, stable.revision);
});
