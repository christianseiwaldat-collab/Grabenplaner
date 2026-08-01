"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-scoped-rights-api-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_OPERATION_MODE = "server";
process.env.GRABENPLANER_PUBLIC_URL = "https://plan.example.test";
process.env.GRABENPLANER_TRUST_PROXY = "loopback";
process.env.GRABENPLANER_DEPLOYMENT_KIND = "codespaces-test";
process.env.GRABENPLANER_AMU_KEY_ID = "test-v1";
process.env.GRABENPLANER_AMU_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GRABENPLANER_WIFI_WEBHOOK_SECRET = "test-wifi-webhook-secret-0123456789abcdef";
process.env.GRABENPLANER_SERVICE_CONTROL_TOKEN = "test-service-control-token-0123456789abcdef";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  app,
  db,
  hashPortalPassword,
  releaseInstanceLockForTests,
} = require("../server");
const {
  PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-schema");
const {
  PERSONNEL_LIFECYCLE_PERMISSIONS: P,
} = require("../lib/personnel-lifecycle-access");

const EMPLOYEES = Object.freeze({
  plPlus: "R1-PLP",
  pl: "R1-PL",
  fl: "R1-FL",
  al: "R1-AL",
  it: "R1-IT",
});
const LOCATION_A = "91";
const LOCATION_B = "92";

let httpServer;
let baseUrl;
let organization;

function configuredInstallationFeatures() {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get();
  try {
    const parsed = JSON.parse(String(stored?.value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setPersonnelLifecycleEnabled(enabled) {
  const features = configuredInstallationFeatures()
    .filter((feature) => feature !== "personnelLifecycle");
  if (enabled) features.push("personnelLifecycle");
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
    .run(JSON.stringify(features));
}

function ensureOrganizationFixture() {
  db.prepare("INSERT OR IGNORE INTO locations (id, name) VALUES (?, ?)")
    .run(LOCATION_A, "R1 API Standort A");
  db.prepare("INSERT OR IGNORE INTO locations (id, name) VALUES (?, ?)")
    .run(LOCATION_B, "R1 API Standort B");
  db.prepare("UPDATE locations SET active = 1 WHERE id IN (?, ?)")
    .run(LOCATION_A, LOCATION_B);
  for (const [locationId, name] of [
    [LOCATION_A, "R1 API Abteilung A"],
    [LOCATION_A, "R1 API Abteilung B"],
    [LOCATION_B, "R1 API Abteilung C"],
  ]) {
    db.prepare("INSERT OR IGNORE INTO departments (location_id, name) VALUES (?, ?)")
      .run(locationId, name);
  }
  const department = (locationId, name) => Number(db.prepare(`
    SELECT id FROM departments WHERE location_id = ? AND name = ?
  `).get(locationId, name).id);
  const fixture = {
    locationA: LOCATION_A,
    locationB: LOCATION_B,
    departmentA: department(LOCATION_A, "R1 API Abteilung A"),
    departmentB: department(LOCATION_A, "R1 API Abteilung B"),
    departmentC: department(LOCATION_B, "R1 API Abteilung C"),
  };
  const upsertEmployee = db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `);
  for (const [employeeNumber, label, departmentId] of [
    [EMPLOYEES.plPlus, "PL Plus", fixture.departmentA],
    [EMPLOYEES.pl, "PL", fixture.departmentA],
    [EMPLOYEES.fl, "Filialleitung", fixture.departmentA],
    [EMPLOYEES.al, "Abteilungsleitung", fixture.departmentA],
    [EMPLOYEES.it, "IT Admin", fixture.departmentA],
  ]) {
    upsertEmployee.run(employeeNumber, `R1 API ${label}`, label, LOCATION_A, departmentId);
  }
  return Object.freeze(fixture);
}

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TRIGGER IF EXISTS test_portal_permission_scope_failure");
    for (const definition of [
      ...PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
      ...PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS "${definition.name}"`);
    }
    db.prepare("DELETE FROM candidate_conversions").run();
    db.prepare("DELETE FROM candidate_events").run();
    db.prepare("DELETE FROM candidate_document_versions").run();
    db.prepare("DELETE FROM candidate_documents").run();
    db.prepare("DELETE FROM candidate_applications").run();
    db.prepare("DELETE FROM candidates").run();
    db.prepare("DELETE FROM portal_sessions").run();
    db.prepare("DELETE FROM mobile_sessions").run();
    db.prepare("DELETE FROM portal_permission_scope_grants").run();
    db.prepare("DELETE FROM portal_permission_grants").run();
    db.prepare("DELETE FROM portal_permission_denials").run();
    db.prepare("DELETE FROM portal_access_scopes").run();
    db.prepare("DELETE FROM portal_users").run();
    db.prepare(`
      DELETE FROM audit_log
      WHERE action LIKE 'personnel-lifecycle.%'
         OR action LIKE 'portal.rights.%'
         OR action LIKE 'portal.scope.%'
    `).run();
    organization = ensureOrganizationFixture();
    for (const definition of [
      ...PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
      ...PERSONNEL_LIFECYCLE_CONVERSION_TRIGGER_DEFINITIONS,
    ]) {
      db.exec(definition.sql);
    }
    setPersonnelLifecycleEnabled(true);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function createSession(employeeNumber, role) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, role_locked, active,
      must_change_password, password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      role_locked = 0,
      active = 1,
      must_change_password = 0,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(id, employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    id,
    cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function createMobileSession(employeeNumber) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mobile_sessions (
      id, employee_number, access_token_hash, access_expires_at,
      refresh_token_hash, refresh_expires_at, installation_id_hash,
      platform, device_label, app_version
    ) VALUES (
      ?, ?, ?, '2099-12-31T23:59:59.000Z',
      ?, '2099-12-31T23:59:59.000Z', ?, 'android', 'R1 API Test', 'test'
    )
  `).run(
    id,
    employeeNumber,
    crypto.createHash("sha256").update(`access-${id}`).digest("hex"),
    crypto.createHash("sha256").update(`refresh-${id}`).digest("hex"),
    crypto.createHash("sha256").update(`installation-${id}`).digest("hex"),
  );
  return id;
}

async function request(route, {
  method = "GET",
  auth = null,
  body,
  includeCsrf = true,
} = {}) {
  const headers = { Accept: "application/json", "X-Forwarded-Proto": "https" };
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
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

function rightsBody(grantedPermissions, scopes) {
  return {
    grantedPermissions,
    deniedPermissions: [],
    ...(scopes === undefined ? {} : { scopes }),
  };
}

function updateRights(auth, employeeNumber, grantedPermissions, scopes) {
  return request(`/api/portal/v1/rights/${employeeNumber}`, {
    method: "PUT",
    auth,
    body: rightsBody(grantedPermissions, scopes),
  });
}

async function createCandidate(auth, marker, locationId, departmentId) {
  const emailPart = marker.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const created = await request("/api/portal/v1/personnel-lifecycle/candidates", {
    method: "POST",
    auth,
    body: {
      profile: {
        firstName: marker,
        lastName: "Synthetic",
        email: `${emailPart}@example.invalid`,
        phone: "+43 660 5550101",
        address: { street: `CONFIDENTIAL-${marker}`, city: "Testort" },
        preferredLanguage: "de",
      },
      application: {
        desiredLocationId: locationId,
        desiredDepartmentId: departmentId,
        desiredRoleTitle: `Role ${marker}`,
        source: `CONFIDENTIAL-SOURCE-${marker}`,
        internalRating: 4,
        internalNotes: `CONFIDENTIAL-NOTES-${marker}`,
        communicationNotes: `CONFIDENTIAL-COMMUNICATION-${marker}`,
        tags: ["confidential", marker],
      },
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  return created.payload.candidate;
}

async function addApplication(auth, candidateId, marker, locationId, departmentId) {
  const created = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidateId}/applications`,
    {
      method: "POST",
      auth,
      body: {
        desiredLocationId: locationId,
        desiredDepartmentId: departmentId,
        desiredRoleTitle: `Role ${marker}`,
        source: `CONFIDENTIAL-SOURCE-${marker}`,
        internalRating: 5,
        internalNotes: `CONFIDENTIAL-NOTES-${marker}`,
        communicationNotes: `CONFIDENTIAL-COMMUNICATION-${marker}`,
        tags: ["confidential", marker],
      },
    },
  );
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  return created.payload.application;
}

function assertConfidentialKeysAbsent(value) {
  const forbidden = new Set([
    "address",
    "preferredLanguage",
    "source",
    "internalRating",
    "internalNotes",
    "communicationNotes",
    "tags",
    "documents",
    "history",
    "conversion",
    "ownerEmployeeNumber",
    "retentionDueAt",
    "createdBy",
    "updatedBy",
    "actorEmployeeNumber",
    "protectedPayload",
    "receiptSha256",
    "previousReceiptSha256",
  ]);
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbidden.has(key), false, `Vertrauliches Feld gefunden: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

function permissionScopeRows(employeeNumber) {
  return db.prepare(`
    SELECT permission, location_id AS locationId, department_id AS departmentId,
           approved_by AS approvedBy
    FROM portal_permission_scope_grants
    WHERE employee_number = ?
    ORDER BY permission, location_id, department_id
  `).all(employeeNumber).map((row) => ({ ...row }));
}

function permissionScopeTimestampRows(employeeNumber) {
  return db.prepare(`
    SELECT permission, location_id AS locationId, department_id AS departmentId,
           approved_by AS approvedBy, created_at AS createdAt, updated_at AS updatedAt
    FROM portal_permission_scope_grants
    WHERE employee_number = ?
    ORDER BY permission, location_id, department_id
  `).all(employeeNumber).map((row) => ({ ...row }));
}

function portalScopeRows(employeeNumber) {
  return db.prepare(`
    SELECT location_id AS locationId, department_id AS departmentId
    FROM portal_access_scopes
    WHERE employee_number = ?
    ORDER BY location_id, department_id
  `).all(employeeNumber).map((row) => ({ ...row }));
}

function portalUserSecuritySnapshot(employeeNumber) {
  const row = db.prepare(`
    SELECT role, password_hash AS passwordHash, active
    FROM portal_users WHERE employee_number = ?
  `).get(employeeNumber);
  return row ? { ...row } : null;
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(resetFixture);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Personalmodul R1 HTTP: PL+ bindet Rechte atomar an Bereiche und PL delegiert nur mit Freigabe", async () => {
  const plPlus = createSession(EMPLOYEES.plPlus, "admin");
  const flSession = createSession(EMPLOYEES.fl, "manager");
  const flMobileSessionId = createMobileSession(EMPLOYEES.fl);
  const permissions = [P.CANDIDATES_READ, P.APPLICATIONS_WRITE];
  const locationScope = [{ locationId: organization.locationA, departmentId: null }];

  db.exec(`
    CREATE TRIGGER test_portal_permission_scope_failure
    BEFORE INSERT ON portal_permission_scope_grants
    BEGIN
      SELECT RAISE(ABORT, 'forced R1 scope failure');
    END;
  `);
  let failed;
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    failed = await updateRights(plPlus, EMPLOYEES.fl, permissions, locationScope);
  } finally {
    console.error = originalConsoleError;
    db.exec("DROP TRIGGER IF EXISTS test_portal_permission_scope_failure");
  }
  assert.ok(failed.response.status >= 400, JSON.stringify(failed.payload));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_permission_grants WHERE employee_number = ?
  `).get(EMPLOYEES.fl).count, 0);
  assert.equal(permissionScopeRows(EMPLOYEES.fl).length, 0);
  assert.equal(portalScopeRows(EMPLOYEES.fl).length, 0);
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(flSession.id).revoked_at, null);
  assert.equal(db.prepare("SELECT revoked_at FROM mobile_sessions WHERE id = ?")
    .get(flMobileSessionId).revoked_at, null);

  db.exec(`
    CREATE TRIGGER test_portal_permission_scope_failure
    BEFORE INSERT ON portal_permission_scope_grants
    WHEN NEW.employee_number = '${EMPLOYEES.fl}'
    BEGIN
      INSERT INTO portal_permission_scope_grants (
        employee_number, permission, location_id, department_id, approved_by
      ) VALUES (
        NEW.employee_number, NEW.permission, NEW.location_id,
        NEW.department_id, NEW.approved_by
      );
    END;
  `);
  let concurrent;
  try {
    concurrent = await updateRights(plPlus, EMPLOYEES.fl, permissions, locationScope);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_portal_permission_scope_failure");
  }
  assert.equal(concurrent.response.status, 409, JSON.stringify(concurrent.payload));
  assert.equal(concurrent.payload.code, "PERSONNEL_LIFECYCLE_SCOPE_CONCURRENT_CHANGE");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_permission_grants WHERE employee_number = ?
  `).get(EMPLOYEES.fl).count, 0);
  assert.equal(permissionScopeRows(EMPLOYEES.fl).length, 0);
  assert.equal(portalScopeRows(EMPLOYEES.fl).length, 0);

  const granted = await updateRights(plPlus, EMPLOYEES.fl, permissions, locationScope);
  assert.equal(granted.response.status, 200, JSON.stringify(granted.payload));
  assert.deepEqual(db.prepare(`
    SELECT permission FROM portal_permission_grants
    WHERE employee_number = ? ORDER BY permission
  `).all(EMPLOYEES.fl).map(({ permission }) => permission), [...permissions].sort());
  assert.deepEqual(portalScopeRows(EMPLOYEES.fl), [{
    locationId: organization.locationA,
    departmentId: 0,
  }]);
  assert.deepEqual(permissionScopeRows(EMPLOYEES.fl), permissions.sort().map((permission) => ({
    permission,
    locationId: organization.locationA,
    departmentId: 0,
    approvedBy: EMPLOYEES.plPlus,
  })));
  const publicTarget = granted.payload.users.find(
    ({ employeeNumber }) => employeeNumber === EMPLOYEES.fl,
  );
  assert.deepEqual(publicTarget.personnelLifecyclePermissionScopes,
    permissionScopeRows(EMPLOYEES.fl).map((scope) => ({
      ...scope,
      departmentId: null,
    })));
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(flSession.id).revoked_at);
  const revokedMobileSession = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
  `).get(flMobileSessionId);
  assert.ok(revokedMobileSession.revoked_at);
  assert.equal(revokedMobileSession.revoked_reason, "rights_changed");

  const plWithoutDelegate = createSession(EMPLOYEES.pl, "hr");
  createSession(EMPLOYEES.al, "department_manager");
  const denied = await updateRights(
    plWithoutDelegate,
    EMPLOYEES.al,
    [P.CANDIDATES_READ, P.APPLICATIONS_WRITE],
    [{ locationId: organization.locationA, departmentId: organization.departmentA }],
  );
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");
  assert.equal(permissionScopeRows(EMPLOYEES.al).length, 0);

  const elevatedPl = await updateRights(
    plPlus,
    EMPLOYEES.pl,
    [P.CANDIDATES_DELEGATE],
    undefined,
  );
  assert.equal(elevatedPl.response.status, 200, JSON.stringify(elevatedPl.payload));
  const plWithDelegate = createSession(EMPLOYEES.pl, "hr");
  const delegated = await updateRights(
    plWithDelegate,
    EMPLOYEES.al,
    [P.CANDIDATES_READ, P.APPLICATIONS_WRITE],
    [{ locationId: organization.locationA, departmentId: organization.departmentA }],
  );
  assert.equal(delegated.response.status, 200, JSON.stringify(delegated.payload));
  assert.deepEqual(permissionScopeRows(EMPLOYEES.al),
    [P.APPLICATIONS_WRITE, P.CANDIDATES_READ].sort().map((permission) => ({
      permission,
      locationId: organization.locationA,
      departmentId: organization.departmentA,
      approvedBy: EMPLOYEES.pl,
    })));
});

test("Personalmodul R1 HTTP: FL und AL sehen nur ihren Bereich vor der Pagination", async () => {
  const plPlus = createSession(EMPLOYEES.plPlus, "admin");
  createSession(EMPLOYEES.fl, "manager");
  createSession(EMPLOYEES.al, "department_manager");
  const permissions = [P.CANDIDATES_READ, P.APPLICATIONS_WRITE];
  assert.equal((await updateRights(
    plPlus,
    EMPLOYEES.fl,
    permissions,
    [{ locationId: organization.locationA, departmentId: null }],
  )).response.status, 200);
  assert.equal((await updateRights(
    plPlus,
    EMPLOYEES.al,
    permissions,
    [{ locationId: organization.locationA, departmentId: organization.departmentA }],
  )).response.status, 200);
  const fl = createSession(EMPLOYEES.fl, "manager");
  const al = createSession(EMPLOYEES.al, "department_manager");

  const visibleOld = await createCandidate(
    plPlus,
    "VISIBLE-OLD",
    organization.locationA,
    organization.departmentA,
  );
  const hidden = await createCandidate(
    plPlus,
    "FOREIGN-PII-MARKER",
    organization.locationB,
    organization.departmentC,
  );
  const visibleNew = await createCandidate(
    plPlus,
    "VISIBLE-NEW",
    organization.locationA,
    organization.departmentA,
  );
  const sameLocationApplication = await addApplication(
    plPlus,
    visibleOld.id,
    "SAME-LOCATION",
    organization.locationA,
    organization.departmentB,
  );
  const foreignApplication = await addApplication(
    plPlus,
    visibleOld.id,
    "FOREIGN-APPLICATION",
    organization.locationB,
    organization.departmentC,
  );
  db.prepare("UPDATE candidates SET updated_at = ? WHERE id = ?")
    .run("2026-08-01T10:00:01.000Z", visibleOld.id);
  db.prepare("UPDATE candidates SET updated_at = ? WHERE id = ?")
    .run("2026-08-01T10:00:02.000Z", hidden.id);
  db.prepare("UPDATE candidates SET updated_at = ? WHERE id = ?")
    .run("2026-08-01T10:00:03.000Z", visibleNew.id);

  const firstPage = await request(
    "/api/portal/v1/personnel-lifecycle/candidates?limit=1&offset=0",
    { auth: fl },
  );
  const secondPage = await request(
    "/api/portal/v1/personnel-lifecycle/candidates?limit=1&offset=1",
    { auth: fl },
  );
  assert.equal(firstPage.response.status, 200, JSON.stringify(firstPage.payload));
  assert.equal(secondPage.response.status, 200, JSON.stringify(secondPage.payload));
  assert.deepEqual(
    new Set([
      firstPage.payload.candidates[0]?.id,
      secondPage.payload.candidates[0]?.id,
    ]),
    new Set([visibleOld.id, visibleNew.id]),
  );
  assert.equal(firstPage.payload.pagination.hasMore, true);
  assert.equal(secondPage.payload.pagination.hasMore, false);
  assert.deepEqual(firstPage.payload.capabilities.scope, {
    type: "location",
    locationIds: [organization.locationA],
  });
  assertConfidentialKeysAbsent(firstPage.payload.candidates);
  assertConfidentialKeysAbsent(secondPage.payload.candidates);

  const flDetail = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${visibleOld.id}`,
    { auth: fl },
  );
  assert.equal(flDetail.response.status, 200, JSON.stringify(flDetail.payload));
  assert.deepEqual(
    new Set(flDetail.payload.candidate.applications.map(({ id }) => id)),
    new Set([visibleOld.applications[0].id, sameLocationApplication.id]),
  );
  assert.equal(JSON.stringify(flDetail.payload).includes(foreignApplication.id), false);
  assertConfidentialKeysAbsent(flDetail.payload.candidate);

  const alDetail = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${visibleOld.id}`,
    { auth: al },
  );
  assert.equal(alDetail.response.status, 200, JSON.stringify(alDetail.payload));
  assert.deepEqual(alDetail.payload.capabilities.scope, {
    type: "department",
    locationIds: [organization.locationA],
    departmentIds: [organization.departmentA],
  });
  assert.deepEqual(
    alDetail.payload.candidate.applications.map(({ id }) => id),
    [visibleOld.applications[0].id],
  );
  assertConfidentialKeysAbsent(alDetail.payload.candidate);

  db.prepare(`
    DELETE FROM audit_log
    WHERE actor = ? AND action = 'personnel-lifecycle.access.denied'
  `).run(EMPLOYEES.al);
  const missingId = "00000000-0000-4000-8000-000000000000";
  const foreignRead = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${hidden.id}`,
    { auth: al },
  );
  const missingRead = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${missingId}`,
    { auth: al },
  );
  assert.equal(foreignRead.response.status, 404);
  assert.equal(missingRead.response.status, 404);
  const publicNotFound = ({ requestId: _requestId, ...payload }) => payload;
  assert.deepEqual(publicNotFound(foreignRead.payload), publicNotFound(missingRead.payload));
  assert.match(foreignRead.payload.requestId, /^[0-9a-f-]{36}$/);
  assert.match(missingRead.payload.requestId, /^[0-9a-f-]{36}$/);
  const denials = db.prepare(`
    SELECT entity_id, detail
    FROM audit_log
    WHERE actor = ? AND action = 'personnel-lifecycle.access.denied'
    ORDER BY id
  `).all(EMPLOYEES.al).map((row) => ({
    entityId: row.entity_id,
    detail: JSON.parse(row.detail),
  }));
  assert.equal(denials.length, 2);
  for (const denial of denials) {
    assert.equal(denial.entityId, "access");
    assert.equal(denial.detail.reason, "PERSONNEL_LIFECYCLE_SCOPED_NOT_FOUND");
    assert.equal(denial.detail.requiredPermission, P.CANDIDATES_READ);
  }
  const denialText = JSON.stringify(denials);
  for (const privateValue of [
    hidden.id,
    missingId,
    "FOREIGN-PII-MARKER",
    "foreign-pii-marker@example.invalid",
    "CONFIDENTIAL-FOREIGN-PII-MARKER",
  ]) {
    assert.equal(denialText.includes(privateValue), false, `Denied-Audit enthält ${privateValue}`);
  }
});

test("Personalmodul R1 HTTP: lokale Mutationen und Scope-Verwaltung bleiben eng begrenzt", async () => {
  const plPlus = createSession(EMPLOYEES.plPlus, "admin");
  createSession(EMPLOYEES.fl, "manager");
  const permissions = [P.CANDIDATES_READ, P.APPLICATIONS_WRITE];
  const flGranted = await updateRights(
    plPlus,
    EMPLOYEES.fl,
    permissions,
    [{ locationId: organization.locationA, departmentId: null }],
  );
  assert.equal(flGranted.response.status, 200, JSON.stringify(flGranted.payload));
  const fl = createSession(EMPLOYEES.fl, "manager");
  const candidate = await createCandidate(
    plPlus,
    "LOCAL-MUTATION",
    organization.locationA,
    organization.departmentA,
  );
  const application = candidate.applications[0];

  const missingCsrf = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}`,
    {
      method: "PUT",
      auth: fl,
      includeCsrf: false,
      body: { revision: application.revision, desiredRoleTitle: "Ohne CSRF" },
    },
  );
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.payload.code, "PORTAL_CSRF_INVALID");
  assert.equal(db.prepare("SELECT revision FROM candidate_applications WHERE id = ?")
    .get(application.id).revision, application.revision);

  const structured = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}`,
    {
      method: "PUT",
      auth: fl,
      body: { revision: application.revision, desiredRoleTitle: "Strukturiert lokal" },
    },
  );
  assert.equal(structured.response.status, 200, JSON.stringify(structured.payload));
  const transitioned = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}/status`,
    {
      method: "POST",
      auth: fl,
      body: { revision: structured.payload.application.revision, status: "screening" },
    },
  );
  assert.equal(transitioned.response.status, 200, JSON.stringify(transitioned.payload));
  const currentRevision = transitioned.payload.application.revision;

  const deniedRequests = [
    request("/api/portal/v1/personnel-lifecycle/candidates", {
      method: "POST",
      auth: fl,
      body: { profile: { firstName: "Nicht", lastName: "Erlaubt" } },
    }),
    request(`/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}`, {
      method: "PUT",
      auth: fl,
      body: { revision: candidate.revision, profile: { firstName: "Nicht erlaubt" } },
    }),
    request(`/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications`, {
      method: "POST",
      auth: fl,
      body: {
        desiredLocationId: organization.locationA,
        desiredDepartmentId: organization.departmentA,
      },
    }),
    request(
      `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}/convert`,
      { method: "POST", auth: fl, body: {} },
    ),
    request("/api/portal/v1/personnel-lifecycle/document-categories", { auth: fl }),
  ];
  for (const deniedPromise of deniedRequests) {
    const denied = await deniedPromise;
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  }
  for (const body of [
    { revision: currentRevision, internalNotes: "Vertraulich lokal" },
    {
      revision: currentRevision,
      desiredLocationId: organization.locationB,
      desiredDepartmentId: organization.departmentC,
    },
  ]) {
    const denied = await request(
      `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}`,
      { method: "PUT", auth: fl, body },
    );
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PERSONNEL_LIFECYCLE_LOCAL_FIELD_FORBIDDEN");
  }
  assert.deepEqual(
    { ...db.prepare(`
      SELECT revision, desired_location_id, desired_department_id
      FROM candidate_applications WHERE id = ?
    `).get(application.id) },
    {
      revision: currentRevision,
      desired_location_id: organization.locationA,
      desired_department_id: organization.departmentA,
    },
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidates").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_applications").get().count, 1);

  const itAdmin = createSession(EMPLOYEES.it, "it_admin");
  const itConvert = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}/convert`,
    { method: "POST", auth: itAdmin, body: {} },
  );
  assert.equal(itConvert.response.status, 403, JSON.stringify(itConvert.payload));

  const inject = db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, 'direct-test-injection')
  `);
  for (const permission of [
    P.CANDIDATES_WRITE,
    P.CONFIDENTIAL_READ,
    P.CONFIDENTIAL_WRITE,
    P.CANDIDATES_CONVERT,
    "personnel:central:read",
    "personnel:central:write",
    "personnel:sensitive:read",
    "personnel:sensitive:write",
    "employees:write",
  ]) inject.run(EMPLOYEES.fl, permission);
  const injectedManagerConvert = await request(
    `/api/portal/v1/personnel-lifecycle/candidates/${candidate.id}/applications/${application.id}/convert`,
    { method: "POST", auth: fl, body: {} },
  );
  assert.equal(injectedManagerConvert.response.status, 403,
    JSON.stringify(injectedManagerConvert.payload));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidate_conversions").get().count, 0);

  createSession(EMPLOYEES.al, "department_manager");
  const alGranted = await updateRights(
    plPlus,
    EMPLOYEES.al,
    permissions,
    [{ locationId: organization.locationA, departmentId: organization.departmentA }],
  );
  assert.equal(alGranted.response.status, 200, JSON.stringify(alGranted.payload));
  const protectedScopeTimestamps = permissionScopeTimestampRows(EMPLOYEES.al);

  const extended = await request(`/api/portal/v1/users/${EMPLOYEES.al}/scopes`, {
    method: "PUT",
    auth: fl,
    body: {
      scopes: [
        { locationId: organization.locationA, departmentId: organization.departmentA },
        { locationId: organization.locationA, departmentId: organization.departmentB },
      ],
    },
  });
  assert.equal(extended.response.status, 200, JSON.stringify(extended.payload));
  assert.deepEqual(portalScopeRows(EMPLOYEES.al), [
    { locationId: organization.locationA, departmentId: organization.departmentA },
    { locationId: organization.locationA, departmentId: organization.departmentB },
  ]);
  assert.deepEqual(permissionScopeRows(EMPLOYEES.al),
    [P.APPLICATIONS_WRITE, P.CANDIDATES_READ].sort().map((permission) => ({
      permission,
      locationId: organization.locationA,
      departmentId: organization.departmentA,
      approvedBy: EMPLOYEES.plPlus,
    })));
  assert.deepEqual(permissionScopeTimestampRows(EMPLOYEES.al), protectedScopeTimestamps);

  const flRemoval = await request(`/api/portal/v1/users/${EMPLOYEES.al}/scopes`, {
    method: "PUT",
    auth: fl,
    body: {
      scopes: [{ locationId: organization.locationA, departmentId: organization.departmentB }],
    },
  });
  assert.equal(flRemoval.response.status, 403, JSON.stringify(flRemoval.payload));
  assert.equal(flRemoval.payload.code, "PERSONNEL_LIFECYCLE_PERMISSION_SCOPE_PROTECTED");
  assert.equal(portalScopeRows(EMPLOYEES.al).length, 2);
  assert.ok(permissionScopeRows(EMPLOYEES.al)
    .every(({ departmentId }) => departmentId === organization.departmentA));

  const plWithoutDelegate = createSession(EMPLOYEES.pl, "hr");
  const centralRemoval = await updateRights(
    plWithoutDelegate,
    EMPLOYEES.al,
    permissions,
    [{ locationId: organization.locationA, departmentId: organization.departmentB }],
  );
  assert.equal(centralRemoval.response.status, 403, JSON.stringify(centralRemoval.payload));
  assert.equal(centralRemoval.payload.code, "PERSONNEL_LIFECYCLE_PERMISSION_SCOPE_PROTECTED");
  assert.ok(permissionScopeRows(EMPLOYEES.al)
    .every(({ departmentId }) => departmentId === organization.departmentA));

  const plPlusChange = await updateRights(
    plPlus,
    EMPLOYEES.al,
    permissions,
    [{ locationId: organization.locationA, departmentId: organization.departmentB }],
  );
  assert.equal(plPlusChange.response.status, 200, JSON.stringify(plPlusChange.payload));
  assert.deepEqual(portalScopeRows(EMPLOYEES.al), [{
    locationId: organization.locationA,
    departmentId: organization.departmentB,
  }]);
  assert.ok(permissionScopeRows(EMPLOYEES.al).every((scope) => (
    scope.departmentId === organization.departmentB
      && scope.approvedBy === EMPLOYEES.plPlus
  )));
});

test("Personalmodul R1 HTTP: Scope-Verwaltung respektiert Sperre, Aktivstatus und IT-Grenze", async () => {
  const plPlus = createSession(EMPLOYEES.plPlus, "admin");
  createSession(EMPLOYEES.fl, "manager");
  const granted = await updateRights(
    plPlus,
    EMPLOYEES.fl,
    [P.CANDIDATES_READ, P.APPLICATIONS_WRITE],
    [{ locationId: organization.locationA, departmentId: null }],
  );
  assert.equal(granted.response.status, 200, JSON.stringify(granted.payload));
  const portalScopesBefore = portalScopeRows(EMPLOYEES.fl);
  const permissionScopesBefore = permissionScopeRows(EMPLOYEES.fl);
  const proposedScopes = [{ locationId: organization.locationB, departmentId: null }];

  db.prepare("UPDATE portal_users SET role_locked = 1 WHERE employee_number = ?")
    .run(EMPLOYEES.fl);
  const locked = await request(`/api/portal/v1/users/${EMPLOYEES.fl}/scopes`, {
    method: "PUT",
    auth: plPlus,
    body: { scopes: proposedScopes },
  });
  assert.equal(locked.response.status, 403, JSON.stringify(locked.payload));
  assert.equal(locked.payload.code, "PORTAL_ROLE_LOCKED");
  assert.deepEqual(portalScopeRows(EMPLOYEES.fl), portalScopesBefore);
  assert.deepEqual(permissionScopeRows(EMPLOYEES.fl), permissionScopesBefore);

  db.prepare("UPDATE portal_users SET role_locked = 0, active = 0 WHERE employee_number = ?")
    .run(EMPLOYEES.fl);
  const inactive = await request(`/api/portal/v1/users/${EMPLOYEES.fl}/scopes`, {
    method: "PUT",
    auth: plPlus,
    body: { scopes: proposedScopes },
  });
  assert.equal(inactive.response.status, 404, JSON.stringify(inactive.payload));
  assert.deepEqual(portalScopeRows(EMPLOYEES.fl), portalScopesBefore);
  assert.deepEqual(permissionScopeRows(EMPLOYEES.fl), permissionScopesBefore);

  db.prepare("UPDATE portal_users SET active = 1 WHERE employee_number = ?").run(EMPLOYEES.fl);
  const itAdmin = createSession(EMPLOYEES.it, "it_admin");
  const takeover = await request(`/api/portal/v1/users/${EMPLOYEES.fl}/scopes`, {
    method: "PUT",
    auth: itAdmin,
    body: { scopes: proposedScopes },
  });
  assert.equal(takeover.response.status, 403, JSON.stringify(takeover.payload));
  assert.equal(takeover.payload.code, "PERSONNEL_LIFECYCLE_ACCOUNT_TAKEOVER_DENIED");
  assert.deepEqual(portalScopeRows(EMPLOYEES.fl), portalScopesBefore);
  assert.deepEqual(permissionScopeRows(EMPLOYEES.fl), permissionScopesBefore);
});

test("Personalmodul R1 HTTP: Audit bleibt parsebar und inaktive Bereiche wirken sofort fail-closed", async () => {
  const plPlus = createSession(EMPLOYEES.plPlus, "admin");
  createSession(EMPLOYEES.al, "department_manager");
  const departmentIds = [];
  for (let index = 0; index < 30; index += 1) {
    const name = `R1 Audit Abteilung ${String(index + 1).padStart(2, "0")}`;
    db.prepare("INSERT OR IGNORE INTO departments (location_id, name, active) VALUES (?, ?, 1)")
      .run(organization.locationA, name);
    departmentIds.push(Number(db.prepare(`
      SELECT id FROM departments WHERE location_id = ? AND name = ?
    `).get(organization.locationA, name).id));
  }
  const granted = await updateRights(
    plPlus,
    EMPLOYEES.al,
    [P.CANDIDATES_READ, P.APPLICATIONS_WRITE],
    departmentIds.map((departmentId) => ({
      locationId: organization.locationA,
      departmentId,
    })),
  );
  assert.equal(granted.response.status, 200, JSON.stringify(granted.payload));
  const audit = db.prepare(`
    SELECT detail
    FROM audit_log
    WHERE actor = ? AND action = 'portal.rights.update' AND entity_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(EMPLOYEES.plPlus, EMPLOYEES.al);
  assert.ok(audit);
  assert.ok(audit.detail.length <= 2000);
  const auditDetail = JSON.parse(audit.detail);
  assert.equal(auditDetail.schemaVersion, 2);

  const roleChanged = await request(`/api/portal/v1/users/${EMPLOYEES.al}`, {
    method: "PUT",
    auth: plPlus,
    body: { role: "employee", active: true },
  });
  assert.equal(roleChanged.response.status, 200, JSON.stringify(roleChanged.payload));
  const roleAudit = db.prepare(`
    SELECT detail
    FROM audit_log
    WHERE actor = ? AND action = 'portal.user.update' AND entity_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(EMPLOYEES.plPlus, EMPLOYEES.al);
  assert.ok(roleAudit);
  assert.ok(roleAudit.detail.length <= 2000);
  const roleAuditDetail = JSON.parse(roleAudit.detail);
  assert.equal(roleAuditDetail.schemaVersion, 2);
  assert.equal(roleAuditDetail.personnelLifecyclePermissionScopes.before.count, 60);
  assert.equal(roleAuditDetail.personnelLifecyclePermissionScopes.after.count, 0);
  assert.equal(roleAuditDetail.personnelLifecyclePermissionScopes.removed.count, 60);

  const longRoleId = `custom-${"x".repeat(2100)}`;
  db.prepare(`
    INSERT INTO portal_roles (id, name, description, builtin, permissions, sort_order)
    VALUES (?, 'R1 langer Importtest', '', 0, '[]', 999)
  `).run(longRoleId);
  try {
    createSession(EMPLOYEES.pl, "employee");
    db.prepare("UPDATE portal_users SET role = ? WHERE employee_number = ?")
      .run(longRoleId, EMPLOYEES.pl);
    const compactedRoleChange = await request(`/api/portal/v1/users/${EMPLOYEES.pl}`, {
      method: "PUT",
      auth: plPlus,
      body: { role: "employee", active: true },
    });
    assert.equal(compactedRoleChange.response.status, 200, JSON.stringify(compactedRoleChange.payload));
    const compactedAudit = db.prepare(`
      SELECT detail
      FROM audit_log
      WHERE actor = ? AND action = 'portal.user.update' AND entity_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(EMPLOYEES.plPlus, EMPLOYEES.pl);
    assert.ok(compactedAudit.detail.length <= 2000);
    const compactedDetail = JSON.parse(compactedAudit.detail);
    assert.equal(compactedDetail.schemaVersion, 2);
    assert.equal(compactedDetail.compacted, true);
    assert.equal(compactedDetail.roleBefore.length, longRoleId.length);
    assert.equal(compactedDetail.roleBefore.sha256,
      crypto.createHash("sha256").update(longRoleId).digest("hex"));
  } finally {
    db.prepare("UPDATE portal_users SET role = 'employee' WHERE role = ?").run(longRoleId);
    db.prepare("DELETE FROM portal_roles WHERE id = ?").run(longRoleId);
  }

  createSession(EMPLOYEES.fl, "manager");
  const flGrant = await updateRights(
    plPlus,
    EMPLOYEES.fl,
    [P.CANDIDATES_READ, P.APPLICATIONS_WRITE],
    [{ locationId: organization.locationA, departmentId: null }],
  );
  assert.equal(flGrant.response.status, 200, JSON.stringify(flGrant.payload));
  const fl = createSession(EMPLOYEES.fl, "manager");
  db.prepare("UPDATE locations SET active = 0 WHERE id = ?").run(organization.locationA);
  const deniedRead = await request(
    "/api/portal/v1/personnel-lifecycle/candidates?limit=1&offset=0",
    { auth: fl },
  );
  assert.equal(deniedRead.response.status, 403, JSON.stringify(deniedRead.payload));
  assert.equal(deniedRead.payload.code, "PERSONNEL_LIFECYCLE_PERMISSION_REQUIRED");
  const deniedGrant = await updateRights(
    plPlus,
    EMPLOYEES.fl,
    [P.CANDIDATES_READ, P.APPLICATIONS_WRITE],
    [{ locationId: organization.locationA, departmentId: null }],
  );
  assert.equal(deniedGrant.response.status, 409, JSON.stringify(deniedGrant.payload));
  assert.equal(deniedGrant.payload.code, "PORTAL_SCOPE_LOCATION_INACTIVE");
});

test("Personalmodul R1 HTTP: IT-Admin kann weder PL noch lokal freigegebene Leitungskonten uebernehmen", async () => {
  const itAdmin = createSession(EMPLOYEES.it, "it_admin");

  createSession(EMPLOYEES.pl, "employee");
  const promotionDenied = await request(`/api/portal/v1/users/${EMPLOYEES.pl}`, {
    method: "PUT",
    auth: itAdmin,
    body: {
      role: "hr",
      active: true,
      password: "Nicht-Uebernehmen-2026!",
      mustChangePassword: false,
    },
  });
  assert.equal(promotionDenied.response.status, 403, JSON.stringify(promotionDenied.payload));
  assert.equal(promotionDenied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.deepEqual(
    portalUserSecuritySnapshot(EMPLOYEES.pl),
    { role: "employee", passwordHash: "test-only", active: 1 },
  );

  createSession(EMPLOYEES.pl, "hr");
  const hrPasswordDenied = await request(`/api/portal/v1/users/${EMPLOYEES.pl}`, {
    method: "PUT",
    auth: itAdmin,
    body: {
      role: "hr",
      active: true,
      password: "Nicht-Uebernehmen-2026!",
      mustChangePassword: false,
    },
  });
  assert.equal(hrPasswordDenied.response.status, 403, JSON.stringify(hrPasswordDenied.payload));
  assert.equal(hrPasswordDenied.payload.code, "PERSONNEL_LIFECYCLE_ACCOUNT_TAKEOVER_DENIED");
  assert.deepEqual(
    portalUserSecuritySnapshot(EMPLOYEES.pl),
    { role: "hr", passwordHash: "test-only", active: 1 },
  );

  const plPlus = createSession(EMPLOYEES.plPlus, "admin");
  createSession(EMPLOYEES.fl, "manager");
  createSession(EMPLOYEES.al, "department_manager");
  const permissions = [P.CANDIDATES_READ, P.APPLICATIONS_WRITE];
  assert.equal((await updateRights(
    plPlus,
    EMPLOYEES.fl,
    permissions,
    [{ locationId: organization.locationA, departmentId: null }],
  )).response.status, 200);
  assert.equal((await updateRights(
    plPlus,
    EMPLOYEES.al,
    permissions,
    [{ locationId: organization.locationA, departmentId: organization.departmentA }],
  )).response.status, 200);

  for (const [employeeNumber, role, update] of [
    [EMPLOYEES.fl, "manager", {
      active: true,
      password: "Nicht-Uebernehmen-2026!",
      mustChangePassword: false,
    }],
    [EMPLOYEES.al, "department_manager", { active: false }],
  ]) {
    const before = portalUserSecuritySnapshot(employeeNumber);
    const denied = await request(`/api/portal/v1/users/${employeeNumber}`, {
      method: "PUT",
      auth: itAdmin,
      body: { role, ...update },
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PERSONNEL_LIFECYCLE_ACCOUNT_TAKEOVER_DENIED");
    assert.deepEqual(portalUserSecuritySnapshot(employeeNumber), before);
    assert.ok(permissionScopeRows(employeeNumber).length > 0);
  }

  const deniedDeactivation = await request(`/api/employees/${EMPLOYEES.fl}`, {
    method: "DELETE",
    auth: itAdmin,
  });
  assert.equal(deniedDeactivation.response.status, 403, JSON.stringify(deniedDeactivation.payload));
  assert.equal(deniedDeactivation.payload.code, "PERSONNEL_LIFECYCLE_ACCOUNT_TAKEOVER_DENIED");
  assert.equal(db.prepare(`
    SELECT active FROM employees WHERE personnel_number = ?
  `).get(EMPLOYEES.fl).active, 1);
  assert.ok(permissionScopeRows(EMPLOYEES.fl).length > 0);
});

test("Personalmodul R1 HTTP: ein injizierter Legacy-Prinzipal local kann sich nie anmelden", async () => {
  const password = "Reserved-Local-Test-2026!";
  const passwordHash = await hashPortalPassword(password);
  db.exec(`
    DROP TRIGGER IF EXISTS trg_employees_reserved_principal_insert;
    DROP TRIGGER IF EXISTS trg_employees_reserved_principal_update;
  `);
  try {
    db.prepare(`
      INSERT INTO employees (personnel_number, full_name, nickname, active)
      VALUES ('LoCaL', 'Reservierter Test', 'Reserviert', 1)
    `).run();
    db.prepare(`
      INSERT INTO portal_users (
        employee_number, password_hash, role, active, must_change_password
      ) VALUES ('LoCaL', ?, 'admin', 1, 0)
    `).run(passwordHash);

    const portalLogin = await request("/api/portal/v1/auth/login", {
      method: "POST",
      body: { loginName: "LoCaL", password },
    });
    assert.equal(portalLogin.response.status, 401, JSON.stringify(portalLogin.payload));
    assert.equal(portalLogin.payload.code, "PORTAL_LOGIN_FAILED");

    const mobileLogin = await request("/api/mobile/v1/auth/login", {
      method: "POST",
      body: {
        employeeNumber: "LoCaL",
        password,
        device: {
          installationId: `reserved-${crypto.randomUUID()}`,
          platform: "android",
          label: "Reserved principal test",
          appVersion: "0.3.0-alpha.1",
        },
      },
    });
    assert.equal(mobileLogin.response.status, 401, JSON.stringify(mobileLogin.payload));
    assert.equal(mobileLogin.payload.error?.code, "MOBILE_LOGIN_FAILED");
  } finally {
    db.prepare("DELETE FROM employees WHERE LOWER(TRIM(personnel_number)) = 'local'").run();
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_employees_reserved_principal_insert
      BEFORE INSERT ON employees
      WHEN LOWER(TRIM(
        NEW.personnel_number,
        CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13) || CHAR(32)
      )) = 'local'
      BEGIN
        SELECT RAISE(ABORT, 'employee principal local is reserved');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_employees_reserved_principal_update
      BEFORE UPDATE OF personnel_number ON employees
      WHEN LOWER(TRIM(
        NEW.personnel_number,
        CHAR(9) || CHAR(10) || CHAR(11) || CHAR(12) || CHAR(13) || CHAR(32)
      )) = 'local'
      BEGIN
        SELECT RAISE(ABORT, 'employee principal local is reserved');
      END;
    `);
  }
});
