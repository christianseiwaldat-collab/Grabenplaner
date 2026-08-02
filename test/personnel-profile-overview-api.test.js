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

const PROFILE_EMPLOYEE = "M6-PROFILE-001";
const PROFILE_ROUTE = `/api/portal/v1/personnel-lifecycle/employees/${PROFILE_EMPLOYEE}/profile`;
const ACTORS = Object.freeze({
  hr: Object.freeze({ employeeNumber: "M6-PROFILE-HR", role: "hr" }),
  admin: Object.freeze({ employeeNumber: "M6-PROFILE-ADMIN", role: "admin" }),
  it: Object.freeze({ employeeNumber: "M6-PROFILE-IT", role: "it_admin" }),
  developer: Object.freeze({ employeeNumber: "M6-PROFILE-DEV", role: "developer" }),
  branch: Object.freeze({ employeeNumber: "M6-PROFILE-FL", role: "manager" }),
  department: Object.freeze({ employeeNumber: "M6-PROFILE-AL", role: "department_manager" }),
  employee: Object.freeze({ employeeNumber: "M6-PROFILE-MA", role: "employee" }),
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
  return { cookie: `grabenplaner_session=${rawToken}; grabenplaner_csrf=${csrf}` };
}

function createOrganizationSession() {
  const accountId = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_organization_accounts (
      id, login_name, display_name, account_type, password_hash, active,
      must_change_password, created_by, updated_by
    ) VALUES (?, ?, 'M6 Organisationskonto', 'branch', 'test-only', 1, 0, 'test', 'test')
  `).run(accountId, `m6-profile-org-${accountId.slice(0, 8)}`);
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

async function request(route, { auth = null } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  const response = await fetch(`${baseUrl}${route}`, { headers });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

function createProfileFixture() {
  db.prepare(`
    INSERT INTO positions (id, name, builtin, sort_order)
    VALUES ('m6-profile-position', 'M6 Fachkraft', 0, 960)
  `).run();
  db.prepare(`
    INSERT INTO cost_center_type_positions (cost_center_type_id, position_id, sort_order)
    VALUES ('branch', 'm6-profile-position', 960)
  `).run();
  db.prepare(`
    INSERT INTO cost_centers (
      id, code, name, type, cost_center_type_id, description, active, sort_order,
      created_by, updated_by
    ) VALUES (
      'm6-profile-cost-center', 'M6-KST', 'M6 Kostenstelle', 'branch', 'branch', '', 1, 960,
      'test', 'test'
    )
  `).run();
  db.prepare(`
    INSERT INTO locations (id, name, cost_center_id, active)
    VALUES ('m6-profile-location', 'M6 Standort', 'm6-profile-cost-center', 1)
  `).run();
  const departmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, active, sort_order)
    VALUES ('m6-profile-location', 'M6 Abteilung', 1, 960)
    RETURNING id
  `).get().id);
  const insertEmployee = db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, position_id, home_location_id,
      preferred_department_id, cost_center_id, active
    ) VALUES (?, ?, ?, 'm6-profile-position', 'm6-profile-location', ?,
      'm6-profile-cost-center', 1)
  `);
  insertEmployee.run(PROFILE_EMPLOYEE, "Mara Profil", "Mara", departmentId);
  for (const actor of Object.values(ACTORS)) {
    insertEmployee.run(actor.employeeNumber, actor.employeeNumber, actor.employeeNumber, departmentId);
  }
  return departmentId;
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

test("M6 Mitarbeiterprofil: nur persönliche PL liest die positive Übersichtsprojektion", async () => {
  const departmentId = createProfileFixture();
  const sessions = Object.fromEntries(Object.entries(ACTORS).map(([key, actor]) => [
    key,
    createEmployeeSession(actor.employeeNumber, actor.role),
  ]));
  const organization = createOrganizationSession();

  const disabled = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: sessions.hr });
  assert.equal(disabled.response.status, 403);
  assert.equal(disabled.payload.code, "FEATURE_DISABLED");

  setPersonnelLifecycleEnabled(true);
  const unauthenticated = await request(`${PROFILE_ROUTE}?tab=overview`);
  assert.equal(unauthenticated.response.status, 401);

  const forgedGrant = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'personnel:central:read', 'm6-profile-test')
  `);
  forgedGrant.run(ACTORS.branch.employeeNumber);
  forgedGrant.run(ACTORS.department.employeeNumber);
  forgedGrant.run(ACTORS.employee.employeeNumber);

  for (const [label, deniedCase] of Object.entries({
    admin: { auth: sessions.admin, code: "PERSONNEL_PROFILE_ACCESS_DENIED" },
    it: { auth: sessions.it, code: "PERSONNEL_PROFILE_ACCESS_DENIED" },
    developer: { auth: sessions.developer, code: "PERSONNEL_PROFILE_ACCESS_DENIED" },
    branch: { auth: sessions.branch, code: "PORTAL_PERMISSION_DENIED" },
    department: { auth: sessions.department, code: "PORTAL_PERMISSION_DENIED" },
    employee: { auth: sessions.employee, code: "PORTAL_PERMISSION_DENIED" },
  })) {
    const denied = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: deniedCase.auth });
    assert.equal(denied.response.status, 403, `${label}: ${JSON.stringify(denied.payload)}`);
    assert.equal(denied.payload.code, deniedCase.code, label);
  }

  const organizationDenied = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: organization });
  assert.equal(organizationDenied.response.status, 403);
  assert.equal(organizationDenied.payload.code, "PORTAL_PERMISSION_DENIED");

  const unavailableTab = await request(`${PROFILE_ROUTE}?tab=documents`, { auth: sessions.hr });
  assert.equal(unavailableTab.response.status, 400);
  assert.equal(unavailableTab.payload.code, "PERSONNEL_PROFILE_TAB_NOT_AVAILABLE");

  const missing = await request(
    "/api/portal/v1/personnel-lifecycle/employees/M6-PROFILE-MISSING/profile?tab=overview",
    { auth: sessions.hr },
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.code, "EMPLOYEE_NOT_FOUND");
  assert.equal(JSON.stringify(missing.payload).includes("M6-PROFILE-MISSING"), false);

  const profile = await request(`${PROFILE_ROUTE}?tab=overview`, { auth: sessions.hr });
  assert.equal(profile.response.status, 200, JSON.stringify(profile.payload));
  assert.deepEqual(profile.payload, {
    profile: {
      employeeNumber: PROFILE_EMPLOYEE,
      displayName: "Mara Profil",
      active: true,
      organization: {
        positionName: "M6 Fachkraft",
        costCenter: { code: "M6-KST", name: "M6 Kostenstelle" },
        location: { id: "m6-profile-location", name: "M6 Standort" },
        department: { id: departmentId, name: "M6 Abteilung" },
      },
    },
    tabs: {
      overview: { available: true },
      masterData: { available: false },
      documents: { available: false },
      onboarding: { available: false },
      training: { available: false },
      offboarding: { available: false },
      history: { available: false },
    },
    capabilities: { canReadOverview: true },
  });
  assert.deepEqual(
    { ...db.prepare(`
      SELECT actor, action, entity_type, entity_id, detail
      FROM audit_log
      WHERE action = 'personnel-profile.overview.view'
      ORDER BY id DESC
      LIMIT 1
    `).get() },
    {
      actor: ACTORS.hr.employeeNumber,
      action: "personnel-profile.overview.view",
      entity_type: "employee",
      entity_id: PROFILE_EMPLOYEE,
      detail: "",
    },
  );
  for (const forbidden of [
    "address",
    "email",
    "phone",
    "socialSecurity",
    "salary",
    "contractedHours",
    "storageKey",
    "sha256",
  ]) {
    assert.equal(Object.hasOwn(profile.payload.profile, forbidden), false, forbidden);
    assert.equal(JSON.stringify(profile.payload).includes(forbidden), false, forbidden);
  }
});
