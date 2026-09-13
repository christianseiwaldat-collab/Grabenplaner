"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-personnel-workflow-api-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  app,
  db,
  releaseInstanceLockForTests,
} = require("../server");
const {
  PERSONNEL_WORKFLOW_PERMISSIONS: P,
} = require("../lib/personnel-workflow-access");

const LOCATION_A = "93";
const LOCATION_B = "94";
const EMPLOYEES = Object.freeze({
  pl: "M4-PL",
  fl: "M4-FL",
  al: "M4-AL",
  it: "M4-IT",
});
const SCOPED_WORKFLOW_PERMISSIONS = Object.freeze([
  P.READ,
  P.DRAFT_WRITE,
  P.PUBLISH,
  P.LOCAL_SUPPLEMENT,
]);

let httpServer;
let baseUrl;

function configuredInstallationFeatures() {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get();
  try {
    const parsed = JSON.parse(String(stored?.value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function enablePersonnelLifecycle() {
  const features = configuredInstallationFeatures()
    .filter((feature) => feature !== "personnelLifecycle");
  features.push("personnelLifecycle");
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
    .run(JSON.stringify(features));
}

function createOrganizationFixture() {
  db.prepare("INSERT OR REPLACE INTO locations (id, name, active) VALUES (?, ?, 1)")
    .run(LOCATION_A, "M4 API Standort A");
  db.prepare("INSERT OR REPLACE INTO locations (id, name, active) VALUES (?, ?, 1)")
    .run(LOCATION_B, "M4 API Standort B");
  for (const [locationId, name] of [
    [LOCATION_A, "M4 API Abteilung A"],
    [LOCATION_A, "M4 API Abteilung B"],
    [LOCATION_B, "M4 API Abteilung C"],
  ]) {
    db.prepare("INSERT OR IGNORE INTO departments (location_id, name, active) VALUES (?, ?, 1)")
      .run(locationId, name);
  }
  const departmentId = (locationId, name) => Number(db.prepare(`
    SELECT id FROM departments WHERE location_id = ? AND name = ?
  `).get(locationId, name).id);
  return Object.freeze({
    departmentA: departmentId(LOCATION_A, "M4 API Abteilung A"),
    departmentB: departmentId(LOCATION_A, "M4 API Abteilung B"),
    departmentC: departmentId(LOCATION_B, "M4 API Abteilung C"),
  });
}

function ensureEmployee(employeeNumber, label, locationId, departmentId) {
  db.prepare(`
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
  `).run(employeeNumber, `M4 API ${label}`, label, locationId, departmentId);
}

function createSession(employeeNumber, role) {
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

function grantScopedWorkflowRights(employeeNumber, locationId, departmentId = null) {
  const normalizedDepartmentId = Number(departmentId || 0);
  db.prepare(`
    INSERT INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES (?, ?, ?, 'M4-PL')
  `).run(employeeNumber, locationId, normalizedDepartmentId);
  const grant = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, 'M4-PL')
  `);
  const grantScope = db.prepare(`
    INSERT INTO portal_permission_scope_grants (
      employee_number, permission, location_id, department_id, approved_by
    ) VALUES (?, ?, ?, ?, 'M4-PL')
  `);
  for (const permission of SCOPED_WORKFLOW_PERMISSIONS) {
    grant.run(employeeNumber, permission);
    grantScope.run(employeeNumber, permission, locationId, normalizedDepartmentId);
  }
}

function injectWorkflowRightsWithoutBusinessAuthority(employeeNumber) {
  const grant = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, 'synthetic-forged-grant')
  `);
  for (const permission of SCOPED_WORKFLOW_PERMISSIONS) grant.run(employeeNumber, permission);
}

function insertWorkflowDefinition({
  id,
  title,
  scopeType,
  locationId = null,
  departmentId = null,
} = {}) {
  db.prepare(`
    INSERT INTO custom_processes (
      id, title, symbol, description, category, scope_type, location_id,
      department_id, trigger_type, trigger_minimum_shortfall, status,
      created_by, updated_by
    ) VALUES (?, ?, 'P', 'M4 API Test', 'other', ?, ?, ?, 'manual', 1, 'draft',
      'synthetic-definition-author', 'synthetic-definition-author')
  `).run(id, title, scopeType, locationId, departmentId);
  db.prepare(`
    INSERT INTO custom_process_revisions (
      process_id, revision, snapshot_json, created_by
    ) VALUES (?, 1, ?, 'synthetic-definition-author')
  `).run(id, JSON.stringify({
    id,
    revision: 1,
    title,
    scope: { type: scopeType, locationId, departmentId },
    steps: [{ id: `${id}-step`, title: "Synthetischer Schritt" }],
  }));
}

function publicationBody(requirementKind = "supplemental") {
  return {
    workflowCode: "standard.onboarding",
    workflowType: "onboarding",
    requirementKind,
    dataClassification: "standard",
    containsConfidentialSteps: false,
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
  const responseText = await response.text();
  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = { raw: responseText };
  }
  return { response, payload };
}

function assertWorkflowResponseIsDataMinimal(value) {
  const forbiddenKeys = new Set([
    "snapshot",
    "snapshotJson",
    "snapshot_json",
    "snapshotSha256",
    "snapshot_sha256",
    "receiptSha256",
    "receipt_sha256",
    "publishedBy",
    "published_by",
    "archivedBy",
    "archived_by",
    "createdBy",
    "created_by",
    "updatedBy",
    "updated_by",
    "actor",
    "actorId",
  ]);
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbiddenKeys.has(key), false, `Internes Workflow-Feld gefunden: ${key}`);
      visit(child);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  for (const internalValue of [
    "synthetic-definition-author",
    "synthetic-forged-grant",
  ]) {
    assert.equal(serialized.includes(internalValue), false, `Interner Akteur gefunden: ${internalValue}`);
  }
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
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Personalmodul M4: HTTP-Vertrag trennt zentrale Freigabe, lokale Scopes und interne Daten", async () => {
  enablePersonnelLifecycle();
  const organization = createOrganizationFixture();
  ensureEmployee(EMPLOYEES.pl, "PL", LOCATION_A, organization.departmentA);
  ensureEmployee(EMPLOYEES.fl, "FL", LOCATION_A, organization.departmentA);
  ensureEmployee(EMPLOYEES.al, "AL", LOCATION_A, organization.departmentA);
  ensureEmployee(EMPLOYEES.it, "IT", LOCATION_A, organization.departmentA);

  const pl = createSession(EMPLOYEES.pl, "hr");
  const fl = createSession(EMPLOYEES.fl, "manager");
  const al = createSession(EMPLOYEES.al, "department_manager");
  const it = createSession(EMPLOYEES.it, "it_admin");
  grantScopedWorkflowRights(EMPLOYEES.fl, LOCATION_A);
  grantScopedWorkflowRights(EMPLOYEES.al, LOCATION_A, organization.departmentA);
  injectWorkflowRightsWithoutBusinessAuthority(EMPLOYEES.it);

  for (const definition of [
    {
      id: "m4-api-central",
      title: "Zentrales Onboarding",
      scopeType: "company",
    },
    {
      id: "m4-api-location-a",
      title: "Standort-A-Ergaenzung",
      scopeType: "location",
      locationId: LOCATION_A,
    },
    {
      id: "m4-api-location-b",
      title: "Standort-B-Ergaenzung",
      scopeType: "location",
      locationId: LOCATION_B,
    },
    {
      id: "m4-api-department-a",
      title: "Abteilung-A-Ergaenzung",
      scopeType: "department",
      locationId: LOCATION_A,
      departmentId: organization.departmentA,
    },
    {
      id: "m4-api-department-b",
      title: "Abteilung-B-Ergaenzung",
      scopeType: "department",
      locationId: LOCATION_A,
      departmentId: organization.departmentB,
    },
  ]) insertWorkflowDefinition(definition);

  const unauthenticated = await request("/api/portal/v1/personnel-lifecycle/workflows");
  assert.equal(unauthenticated.response.status, 401);

  const unsupportedCollectionMethod = await request(
    "/api/portal/v1/personnel-lifecycle/workflows",
    { method: "PUT", auth: pl, body: {} },
  );
  assert.equal(unsupportedCollectionMethod.response.status, 404);
  const unsupportedPublishMethod = await request(
    "/api/portal/v1/personnel-lifecycle/workflows/m4-api-central/publish",
    { method: "GET", auth: pl },
  );
  assert.equal(unsupportedPublishMethod.response.status, 404);

  const itRead = await request("/api/portal/v1/personnel-lifecycle/workflows", { auth: it });
  assert.equal(itRead.response.status, 403);
  assert.equal(itRead.payload.code, "PERSONNEL_WORKFLOW_PERMISSION_REQUIRED");
  const itPublish = await request(
    "/api/portal/v1/personnel-lifecycle/workflows/m4-api-central/publish",
    { method: "POST", auth: it, body: publicationBody("mandatory") },
  );
  assert.equal(itPublish.response.status, 403);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM custom_process_publications").get().count,
    0,
  );

  const readableWithoutCsrf = await request(
    "/api/portal/v1/personnel-lifecycle/workflows",
    { auth: pl, includeCsrf: false },
  );
  assert.equal(readableWithoutCsrf.response.status, 200, JSON.stringify(readableWithoutCsrf.payload));

  const publishWithoutCsrf = await request(
    "/api/portal/v1/personnel-lifecycle/workflows/m4-api-central/publish",
    {
      method: "POST",
      auth: pl,
      includeCsrf: false,
      body: publicationBody("mandatory"),
    },
  );
  assert.equal(publishWithoutCsrf.response.status, 403);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM custom_process_publications").get().count,
    0,
  );

  const central = await request(
    "/api/portal/v1/personnel-lifecycle/workflows/m4-api-central/publish",
    { method: "POST", auth: pl, body: publicationBody("mandatory") },
  );
  assert.equal(central.response.status, 201, JSON.stringify(central.payload));
  assert.equal(central.payload.publication.authorityLevel, "central");
  assert.equal(central.payload.publication.requirementKind, "mandatory");

  const flAllowed = await request(
    "/api/portal/v1/personnel-lifecycle/workflows/m4-api-location-a/publish",
    { method: "POST", auth: fl, body: publicationBody() },
  );
  assert.equal(flAllowed.response.status, 201, JSON.stringify(flAllowed.payload));
  assert.equal(flAllowed.payload.publication.authorityLevel, "local");
  const flOutside = await request(
    "/api/portal/v1/personnel-lifecycle/workflows/m4-api-location-b/publish",
    { method: "POST", auth: fl, body: publicationBody() },
  );
  assert.equal(flOutside.response.status, 404, JSON.stringify(flOutside.payload));
  assert.equal(flOutside.payload.code, "PERSONNEL_WORKFLOW_DEFINITION_NOT_FOUND");

  const alAllowed = await request(
    "/api/portal/v1/personnel-lifecycle/workflows/m4-api-department-a/publish",
    { method: "POST", auth: al, body: publicationBody() },
  );
  assert.equal(alAllowed.response.status, 201, JSON.stringify(alAllowed.payload));
  assert.equal(alAllowed.payload.publication.scope.departmentId, organization.departmentA);
  const alOutside = await request(
    "/api/portal/v1/personnel-lifecycle/workflows/m4-api-department-b/publish",
    { method: "POST", auth: al, body: publicationBody() },
  );
  assert.equal(alOutside.response.status, 404, JSON.stringify(alOutside.payload));
  assert.equal(alOutside.payload.code, "PERSONNEL_WORKFLOW_DEFINITION_NOT_FOUND");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM custom_process_publications").get().count,
    3,
  );

  const resolvedForAl = await request(
    `/api/portal/v1/personnel-lifecycle/workflow-publications/resolve?locationId=${LOCATION_A}`
      + `&departmentId=${organization.departmentA}`,
    { auth: al },
  );
  assert.equal(resolvedForAl.response.status, 200, JSON.stringify(resolvedForAl.payload));
  assert.deepEqual(
    resolvedForAl.payload.publications.map(({ processId }) => processId),
    ["m4-api-central", "m4-api-department-a", "m4-api-location-a"],
  );
  assert.equal(resolvedForAl.payload.capabilities.scope.type, "department");

  const archiveWithoutCsrf = await request(
    `/api/portal/v1/personnel-lifecycle/workflow-publications/${central.payload.publication.id}/archive`,
    {
      method: "POST",
      auth: pl,
      includeCsrf: false,
      body: { reason: "Synthetische Archivierungsprobe" },
    },
  );
  assert.equal(archiveWithoutCsrf.response.status, 403);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM custom_process_publication_archives").get().count,
    0,
  );
  const foreignArchive = await request(
    `/api/portal/v1/personnel-lifecycle/workflow-publications/${central.payload.publication.id}/archive`,
    {
      method: "POST",
      auth: fl,
      body: { reason: "Synthetische Fremdbereichsprobe" },
    },
  );
  assert.equal(foreignArchive.response.status, 404, JSON.stringify(foreignArchive.payload));
  assert.equal(foreignArchive.payload.code, "PERSONNEL_WORKFLOW_PUBLICATION_NOT_FOUND");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM custom_process_publication_archives").get().count,
    0,
  );
  const archived = await request(
    `/api/portal/v1/personnel-lifecycle/workflow-publications/${central.payload.publication.id}/archive`,
    {
      method: "POST",
      auth: pl,
      body: { reason: "Synthetische Archivierungsprobe" },
    },
  );
  assert.equal(archived.response.status, 200, JSON.stringify(archived.payload));
  assert.equal(archived.payload.publication.archived, true);

  const listed = await request(
    "/api/portal/v1/personnel-lifecycle/workflows?includeArchived=1",
    { auth: pl },
  );
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  assert.equal(listed.payload.publications.length, 3);
  assert.equal(
    listed.payload.publications.find(({ id }) => id === central.payload.publication.id).archived,
    true,
  );
  for (const payload of [
    readableWithoutCsrf.payload,
    central.payload,
    flAllowed.payload,
    alAllowed.payload,
    resolvedForAl.payload,
    archived.payload,
    listed.payload,
  ]) assertWorkflowResponseIsDataMinimal(payload);
});
