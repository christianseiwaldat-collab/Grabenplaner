"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-personnel-profile-api-"));
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

const PROFILE_EMPLOYEE = "M7-PROFILE-001";
const REMOTE_EMPLOYEE = "M7-PROFILE-REMOTE";
const PROFILE_ROUTE = `/api/portal/v1/personnel-lifecycle/employees/${PROFILE_EMPLOYEE}/profile`;
const EMPLOYMENT_NOTES_MARKER = "M7 vertrauliche Vertragsnotiz – nicht fürs Profil";
const FUTURE_PERSONNEL_FIELD_MARKER = "M7 zukünftiges vertrauliches Katalogfeld";
const M7_MASTER_FIELD_ALLOWLIST = Object.freeze([
  "identity.firstName",
  "identity.lastName",
  "identity.previousName",
  "identity.salutation",
  "identity.title",
  "identity.birthDate",
  "identity.birthPlace",
  "identity.nationality",
  "socialSecurityNumber",
  "iban",
  "bic",
  "accountHolder",
  "address.street",
  "address.supplement",
  "address.postalCode",
  "address.city",
  "address.state",
  "address.country",
  "phone",
  "alternatePhone",
  "privateEmail",
  "emergencyContact.name",
  "emergencyContact.relationship",
  "emergencyContact.phone",
  "employment.startDate",
  "employment.endDate",
  "employment.fixedTermEnd",
  "employment.probationEnd",
  "employment.employmentType",
  "employment.contractType",
  "employment.employmentStatus",
  "employment.collectiveAgreement",
  "employment.classification",
  "employment.payrollGroup",
]);
const ACTORS = Object.freeze({
  hr: Object.freeze({ employeeNumber: "M7-PROFILE-HR", role: "hr" }),
  admin: Object.freeze({ employeeNumber: "M7-PROFILE-ADMIN", role: "admin" }),
  it: Object.freeze({ employeeNumber: "M7-PROFILE-IT", role: "it_admin" }),
  developer: Object.freeze({ employeeNumber: "M7-PROFILE-DEV", role: "developer" }),
  branch: Object.freeze({ employeeNumber: "M7-PROFILE-FL", role: "manager" }),
  ungrantedBranch: Object.freeze({ employeeNumber: "M7-PROFILE-FL-NO-RIGHT", role: "manager" }),
  department: Object.freeze({ employeeNumber: "M7-PROFILE-AL", role: "department_manager" }),
  planner: Object.freeze({ employeeNumber: "M7-PROFILE-PV", role: "location_planner" }),
  employee: Object.freeze({ employeeNumber: "M7-PROFILE-MA", role: "employee" }),
});

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

function setPersonnelLifecycleEnabled(enabled) {
  const features = configuredInstallationFeatures()
    .filter((feature) => feature !== "personnelLifecycle");
  if (enabled) features.push("personnelLifecycle");
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
    .run(JSON.stringify(features));
}

function createEmployeeSession(employeeNumber, role) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, role_locked, active,
      must_change_password, password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}`,
    csrf,
  };
}

function createOrganizationSession() {
  const accountId = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_organization_accounts (
      id, login_name, display_name, account_type, password_hash, active,
      must_change_password, created_by, updated_by
    ) VALUES (?, ?, 'M7 Organisationskonto', 'branch', 'test-only', 1, 0, 'test', 'test')
  `).run(accountId, `m7-profile-org-${accountId.slice(0, 8)}`);
  db.prepare(`
    INSERT INTO portal_organization_sessions (id, account_id, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    accountId,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return { cookie: `grabenplaner_session=${rawToken}` };
}

async function request(route, { method = "GET", auth = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
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
  return { response, payload, text };
}

async function uploadDocument(employeeNumber, auth) {
  const content = Buffer.from("%PDF-1.7\n% M7 vertraulicher Vertrag\n%%EOF", "utf8");
  const form = new FormData();
  form.append("category", "contract");
  form.append("title", "M7 Dienstvertrag");
  form.append("documentDate", "2026-08-01");
  form.append("description", "M7 geschützte Dokumentmetadaten");
  form.append("document", new Blob([content], { type: "application/pdf" }), "m7-vertrag.pdf");
  const response = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/${encodeURIComponent(employeeNumber)}/documents`,
    {
      method: "POST",
      headers: {
        Cookie: auth.cookie,
        "X-CSRF-Token": auth.csrf,
        Accept: "application/json",
      },
      body: form,
    },
  );
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

function createProfileFixture() {
  db.prepare(`
    INSERT INTO positions (id, name, builtin, sort_order)
    VALUES ('m7-profile-position', 'M7 Fachkraft', 0, 970)
  `).run();
  db.prepare(`
    INSERT INTO cost_center_type_positions (cost_center_type_id, position_id, sort_order)
    VALUES ('branch', 'm7-profile-position', 970)
  `).run();
  db.prepare(`
    INSERT INTO cost_centers (
      id, code, name, type, cost_center_type_id, description, active, sort_order,
      created_by, updated_by
    ) VALUES (
      'm7-profile-cost-center', 'M7-KST', 'M7 Kostenstelle', 'branch', 'branch', '', 1, 970,
      'test', 'test'
    )
  `).run();
  db.prepare(`
    INSERT INTO cost_centers (
      id, code, name, type, cost_center_type_id, description, active, sort_order,
      created_by, updated_by
    ) VALUES (
      'm7-profile-remote-cost-center', 'M7-REMOTE', 'M7 Fremdkostenstelle',
      'branch', 'branch', '', 1, 971, 'test', 'test'
    )
  `).run();
  db.prepare(`
    INSERT INTO locations (id, name, cost_center_id, active)
    VALUES ('m7-profile-location', 'M7 Standort', 'm7-profile-cost-center', 1)
  `).run();
  db.prepare(`
    INSERT INTO locations (id, name, cost_center_id, active)
    VALUES ('m7-profile-remote', 'M7 Fremdstandort', 'm7-profile-remote-cost-center', 1)
  `).run();
  const departmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, active, sort_order)
    VALUES ('m7-profile-location', 'M7 Abteilung', 1, 970)
    RETURNING id
  `).get().id);
  const remoteDepartmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, active, sort_order)
    VALUES ('m7-profile-remote', 'M7 Fremdabteilung', 1, 971)
    RETURNING id
  `).get().id);
  const insertEmployee = db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, position_id, home_location_id,
      preferred_department_id, cost_center_id, active
    ) VALUES (?, ?, ?, 'm7-profile-position', ?, ?, ?, 1)
  `);
  insertEmployee.run(
    PROFILE_EMPLOYEE,
    "Mara Profil",
    "Mara",
    "m7-profile-location",
    departmentId,
    "m7-profile-cost-center",
  );
  insertEmployee.run(
    REMOTE_EMPLOYEE,
    "Ronja Fremdbereich",
    "Ronja",
    "m7-profile-remote",
    remoteDepartmentId,
    "m7-profile-remote-cost-center",
  );
  for (const actor of Object.values(ACTORS)) {
    insertEmployee.run(
      actor.employeeNumber,
      actor.employeeNumber,
      actor.employeeNumber,
      "m7-profile-location",
      departmentId,
      "m7-profile-cost-center",
    );
  }
  return Object.freeze({ departmentId, remoteDepartmentId });
}

function expectedProfile(departmentId) {
  return {
    employeeNumber: PROFILE_EMPLOYEE,
    displayName: "Mara Profil",
    active: true,
    organization: {
      positionName: "M7 Fachkraft",
      costCenter: { code: "M7-KST", name: "M7 Kostenstelle" },
      location: { id: "m7-profile-location", name: "M7 Standort" },
      department: { id: departmentId, name: "M7 Abteilung" },
    },
  };
}

function expectedTabs(masterDataAvailable, documentsAvailable) {
  return {
    overview: { available: true },
    masterData: { available: masterDataAvailable },
    documents: { available: documentsAvailable },
    onboarding: { available: false },
    training: { available: false },
    offboarding: { available: false },
    history: { available: false },
  };
}

function expectedCapabilities(masterDataAvailable, documentsAvailable) {
  return {
    canReadOverview: true,
    canReadMasterOrg: masterDataAvailable,
    canReadDocuments: documentsAvailable,
  };
}

function leafPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, entry]) => (
    leafPaths(entry, prefix ? `${prefix}.${key}` : key)
  ));
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

test("M7 Mitarbeiterprofil: tabweise positive Projektionen und bestehende Objektgrenzen", async () => {
  const { departmentId } = createProfileFixture();
  const sessions = Object.fromEntries(Object.entries(ACTORS).map(([key, actor]) => [
    key,
    createEmployeeSession(actor.employeeNumber, actor.role),
  ]));
  const organization = createOrganizationSession();
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, assigned_by)
    VALUES (?, 'm7-profile-location', 'm7-profile-test')
  `).run(ACTORS.branch.employeeNumber);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, assigned_by)
    VALUES (?, 'm7-profile-location', 'm7-profile-test')
  `).run(ACTORS.ungrantedBranch.employeeNumber);
  db.prepare(`
    INSERT INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES (?, 'm7-profile-location', ?, 'm7-profile-test')
  `).run(ACTORS.department.employeeNumber, departmentId);

  const disabled = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: sessions.hr });
  assert.equal(disabled.response.status, 403);
  assert.equal(disabled.payload.code, "FEATURE_DISABLED");
  const disabledRoster = await request("/api/employees", { auth: sessions.hr });
  assert.equal(disabledRoster.response.status, 200, disabledRoster.text);
  assert.deepEqual(
    disabledRoster.payload.find((employee) => employee.personnel_number === PROFILE_EMPLOYEE)
      ?.personnel_profile_access,
    { available: false },
  );

  setPersonnelLifecycleEnabled(true);
  const unauthenticated = await request(`${PROFILE_ROUTE}?tab=overview`);
  assert.equal(unauthenticated.response.status, 401);

  const ungrantedLeadership = await request(`${PROFILE_ROUTE}?tab=overview`, {
    auth: sessions.ungrantedBranch,
  });
  assert.equal(ungrantedLeadership.response.status, 403);

  for (const [label, deniedCase] of Object.entries({
    admin: { auth: sessions.admin, code: "PERSONNEL_PROFILE_ACCESS_DENIED" },
    it: { auth: sessions.it, code: "PORTAL_PERMISSION_DENIED" },
    developer: { auth: sessions.developer, code: "PERSONNEL_PROFILE_ACCESS_DENIED" },
    planner: { auth: sessions.planner, code: "PORTAL_PERMISSION_DENIED" },
    employee: { auth: sessions.employee, code: "PORTAL_PERMISSION_DENIED" },
  })) {
    const denied = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: deniedCase.auth });
    assert.equal(denied.response.status, 403, `${label}: ${JSON.stringify(denied.payload)}`);
    assert.equal(denied.payload.code, deniedCase.code, label);
  }

  const organizationDenied = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: organization });
  assert.equal(organizationDenied.response.status, 403);
  assert.equal(organizationDenied.payload.code, "PORTAL_PERMISSION_DENIED");

  const unknownTab = await request(`${PROFILE_ROUTE}?tab=history`, { auth: sessions.hr });
  assert.equal(unknownTab.response.status, 400);
  assert.equal(unknownTab.payload.code, "PERSONNEL_PROFILE_TAB_NOT_AVAILABLE");

  const insertGrant = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, ?)
  `);
  const insertScope = db.prepare(`
    INSERT INTO portal_permission_scope_grants (
      employee_number, permission, location_id, department_id, approved_by
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const permission of ["personnel:profiles:read", "personnel:profiles:master:read"]) {
    insertGrant.run(ACTORS.branch.employeeNumber, permission, ACTORS.hr.employeeNumber);
    insertScope.run(
      ACTORS.branch.employeeNumber,
      permission,
      "m7-profile-location",
      0,
      ACTORS.hr.employeeNumber,
    );
    insertGrant.run(ACTORS.department.employeeNumber, permission, ACTORS.hr.employeeNumber);
    insertScope.run(
      ACTORS.department.employeeNumber,
      permission,
      "m7-profile-location",
      departmentId,
      ACTORS.hr.employeeNumber,
    );
  }
  // Ein manipuliertes Dokumentrecht darf für FL nie wirksam werden.
  insertGrant.run(
    ACTORS.branch.employeeNumber,
    "personnel:profiles:documents:read",
    ACTORS.hr.employeeNumber,
  );

  for (const [label, auth, expectedAvailable] of [
    ["hr", sessions.hr, true],
    ["branch", sessions.branch, true],
    ["ungrantedBranch", sessions.ungrantedBranch, false],
    ["admin", sessions.admin, false],
  ]) {
    const roster = await request("/api/employees", { auth });
    assert.equal(roster.response.status, 200, `${label}: ${roster.text}`);
    const target = roster.payload.find((employee) => employee.personnel_number === PROFILE_EMPLOYEE);
    assert.ok(target, `${label}: Ziel fehlt im freigegebenen Team`);
    assert.deepEqual(target.personnel_profile_access, { available: expectedAvailable }, label);
    assert.deepEqual(Object.keys(target.personnel_profile_access), ["available"], label);
  }

  const saved = await request(`/api/portal/v1/personnel-records/${PROFILE_EMPLOYEE}`, {
    method: "PUT",
    auth: sessions.hr,
    body: {
      phone: "+43 512 5557001",
      sensitive: {
        identity: { firstName: "Mara", lastName: "Profil", birthDate: "1990-04-18" },
        address: { street: "Vertraulicher Weg 7", postalCode: "6020", city: "Innsbruck" },
        privateEmail: "mara.profil@example.test",
        employment: {
          startDate: "2024-02-01",
          employmentStatus: "Aktiv",
          notes: EMPLOYMENT_NOTES_MARKER,
          futureConfidentialField: FUTURE_PERSONNEL_FIELD_MARKER,
        },
      },
    },
  });
  assert.equal(saved.response.status, 200, saved.text);
  assert.equal(saved.payload.changedFields.includes("employment.notes"), true);
  assert.equal(saved.payload.changedFields.includes("employment.futureConfidentialField"), false);
  const uploaded = await uploadDocument(PROFILE_EMPLOYEE, sessions.hr);
  assert.equal(uploaded.response.status, 201, uploaded.text);

  for (const permission of ["personnel:phone:read", "personnel:phone:write"]) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, ?, 'm7-profile-test')
    `).run(ACTORS.hr.employeeNumber, permission);
  }

  const overview = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: sessions.hr });
  assert.equal(overview.response.status, 200, JSON.stringify(overview.payload));
  assert.deepEqual(overview.payload, {
    profile: expectedProfile(departmentId),
    tabs: expectedTabs(true, true),
    capabilities: expectedCapabilities(true, true),
  });
  assert.equal(Object.hasOwn(overview.payload, "masterData"), false);
  assert.equal(Object.hasOwn(overview.payload, "documents"), false);
  for (const forbidden of [
    "address",
    "privateEmail",
    "phone",
    "socialSecurity",
    "salary",
    "contractedHours",
    "storageKey",
    "sha256",
  ]) {
    assert.equal(Object.hasOwn(overview.payload.profile, forbidden), false, forbidden);
    assert.equal(JSON.stringify(overview.payload).includes(forbidden), false, forbidden);
  }

  for (const actor of [sessions.branch, sessions.department]) {
    const scopedOverview = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: actor });
    assert.equal(scopedOverview.response.status, 200, JSON.stringify(scopedOverview.payload));
    assert.deepEqual(scopedOverview.payload, {
      profile: expectedProfile(departmentId),
      tabs: expectedTabs(true, false),
      capabilities: expectedCapabilities(true, false),
    });
    const scopedMaster = await request(`${PROFILE_ROUTE}?tab=master_org`, { auth: actor });
    assert.equal(scopedMaster.response.status, 200, JSON.stringify(scopedMaster.payload));
    assert.deepEqual(scopedMaster.payload.masterData, {});
    assert.deepEqual(scopedMaster.payload.profile, expectedProfile(departmentId));
  }

  const managerMissing = await request(
    "/api/portal/v1/personnel-lifecycle/employees/M7-PROFILE-MISSING/profile?tab=overview",
    { auth: sessions.branch },
  );
  const managerOutOfScope = await request(
    `/api/portal/v1/personnel-lifecycle/employees/${REMOTE_EMPLOYEE}/profile?tab=overview`,
    { auth: sessions.branch },
  );
  assert.equal(managerMissing.response.status, 404);
  assert.equal(managerOutOfScope.response.status, 404);
  assert.deepEqual(
    { error: managerOutOfScope.payload.error, code: managerOutOfScope.payload.code },
    { error: managerMissing.payload.error, code: managerMissing.payload.code },
  );
  assert.equal(managerMissing.payload.code, "EMPLOYEE_NOT_FOUND");
  assert.equal(JSON.stringify(managerMissing.payload).includes("M7-PROFILE-MISSING"), false);
  assert.equal(JSON.stringify(managerOutOfScope.payload).includes(REMOTE_EMPLOYEE), false);

  const managerDocuments = await request(`${PROFILE_ROUTE}?tab=documents`, {
    auth: sessions.branch,
  });
  assert.equal(managerDocuments.response.status, 403);
  assert.equal(managerDocuments.payload.code, "PERSONNEL_PROFILE_TAB_ACCESS_DENIED");

  const master = await request(`${PROFILE_ROUTE}?tab=master_org`, { auth: sessions.hr });
  assert.equal(master.response.status, 200, JSON.stringify(master.payload));
  assert.deepEqual(master.payload.profile, expectedProfile(departmentId));
  assert.deepEqual(master.payload.tabs, expectedTabs(true, true));
  assert.deepEqual(master.payload.capabilities, expectedCapabilities(true, true));
  assert.equal(master.payload.masterData.identity.firstName, "Mara");
  assert.equal(master.payload.masterData.identity.lastName, "Profil");
  assert.equal(master.payload.masterData.address.street, "Vertraulicher Weg 7");
  assert.equal(master.payload.masterData.privateEmail, "mara.profil@example.test");
  assert.equal(master.payload.masterData.employment.startDate, "2024-02-01");
  assert.deepEqual(
    leafPaths(master.payload.masterData).sort(),
    M7_MASTER_FIELD_ALLOWLIST.filter((fieldKey) => fieldKey !== "phone").sort(),
  );
  assert.equal(Object.hasOwn(master.payload.masterData, "phone"), false);
  assert.equal(Object.hasOwn(master.payload.masterData, "documents"), false);
  assert.equal(Object.hasOwn(master.payload.masterData.employment, "notes"), false);
  assert.equal(Object.hasOwn(master.payload.masterData.employment, "futureConfidentialField"), false);
  assert.equal(JSON.stringify(master.payload).includes(EMPLOYMENT_NOTES_MARKER), false);
  assert.equal(JSON.stringify(master.payload).includes(FUTURE_PERSONNEL_FIELD_MARKER), false);
  for (const forbidden of ["protected_payload", "protectedPayload", "storageKey", "sha256"] ) {
    assert.equal(JSON.stringify(master.payload).includes(forbidden), false, forbidden);
  }

  const documents = await request(`${PROFILE_ROUTE}?tab=documents`, { auth: sessions.hr });
  assert.equal(documents.response.status, 200, JSON.stringify(documents.payload));
  assert.deepEqual(documents.payload.profile, expectedProfile(departmentId));
  assert.deepEqual(documents.payload.tabs, expectedTabs(true, true));
  assert.deepEqual(documents.payload.capabilities, expectedCapabilities(true, true));
  assert.equal(documents.payload.documents.length, 1);
  assert.deepEqual(Object.keys(documents.payload.documents[0]).sort(), [
    "archivedAt",
    "byteSize",
    "category",
    "createdAt",
    "description",
    "detectedMime",
    "documentDate",
    "id",
    "originalFilename",
    "revision",
    "status",
    "title",
    "updatedAt",
    "visibility",
    "currentVersion",
  ].sort());
  assert.equal(documents.payload.documents[0].title, "M7 Dienstvertrag");
  assert.equal(documents.payload.documents[0].originalFilename, "m7-vertrag.pdf");
  for (const forbidden of [
    "protected_payload",
    "protectedPayload",
    "storageKey",
    "storage_key",
    "sha256",
    "receiptSha256",
    "actorEmployeeNumber",
    "content",
  ]) {
    assert.equal(JSON.stringify(documents.payload).includes(forbidden), false, forbidden);
  }

  const documentsMissing = await request(
    "/api/portal/v1/personnel-lifecycle/employees/M7-PROFILE-MISSING/profile?tab=documents",
    { auth: sessions.hr },
  );
  assert.equal(documentsMissing.response.status, 404);
  assert.equal(documentsMissing.payload.code, "EMPLOYEE_NOT_FOUND");

  for (const permission of ["personnel:sensitive:read", "personnel:sensitive:write"]) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, ?, 'm7-profile-test')
    `).run(ACTORS.hr.employeeNumber, permission);
  }
  const restrictedOverview = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: sessions.hr });
  assert.equal(restrictedOverview.response.status, 200);
  assert.deepEqual(restrictedOverview.payload.tabs, expectedTabs(false, false));
  assert.deepEqual(restrictedOverview.payload.capabilities, expectedCapabilities(false, false));
  const restrictedMaster = await request(`${PROFILE_ROUTE}?tab=master_org`, { auth: sessions.hr });
  assert.equal(restrictedMaster.response.status, 403);
  assert.equal(restrictedMaster.payload.code, "PERSONNEL_PROFILE_TAB_ACCESS_DENIED");
  const restrictedDocuments = await request(`${PROFILE_ROUTE}?tab=documents`, { auth: sessions.hr });
  assert.equal(restrictedDocuments.response.status, 403);
  assert.equal(restrictedDocuments.payload.code, "PERSONNEL_PROFILE_TAB_ACCESS_DENIED");

  assert.deepEqual(
    { ...db.prepare(`
      SELECT actor, action, entity_type, entity_id, detail
      FROM audit_log
      WHERE action = 'personnel-profile.overview.view'
        AND actor = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(ACTORS.hr.employeeNumber) },
    {
      actor: ACTORS.hr.employeeNumber,
      action: "personnel-profile.overview.view",
      entity_type: "employee",
      entity_id: PROFILE_EMPLOYEE,
      detail: "",
    },
  );
});
