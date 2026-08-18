"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-learning-rights-"));
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
  PERSONNEL_LEARNING_PERMISSIONS,
  PERSONNEL_LEARNING_PERMISSION_IDS,
  PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS,
} = require("../lib/personnel-learning-access");
const {
  moduleReceiptSha256,
  moduleVersionReceiptSha256,
  sha256Text,
} = require("../lib/persistence/sqlite/operations/personnel-learning-schema");
const {
  app,
  db,
  releaseInstanceLockForTests,
} = require("../server");

const HR = "learning-hr";
const ADMIN = "learning-admin";
const IT_ADMIN = "learning-it";
const DEVELOPER = "learning-developer";
const EMPLOYEE = "learning-employee";
const UNCONFIGURED = "learning-unconfigured";
const MANAGER = "learning-fl";
const LOCAL_AL = "learning-al-local";
const LOCAL_AL_TWO = "learning-al-local-2";
const FOREIGN_AL = "learning-al-foreign";
const CROSS_PERMISSION = PERSONNEL_LEARNING_PERMISSIONS.CROSS_LOCATION_ASSIGN;

let httpServer;
let baseUrl;
let local;
let foreign;
let localAlternateDepartmentId;

function employee(personnelNumber, fullName, role, locationId, departmentId = null) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, home_location_id,
       preferred_department_id, active)
    VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(personnelNumber, fullName, fullName.split(/\s+/)[0], locationId, departmentId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(personnelNumber, role);
  if (role === "manager") {
    db.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, ?)
    `).run(personnelNumber, locationId, HR);
  } else if (role === "department_manager") {
    db.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, ?, ?)
    `).run(personnelNumber, locationId, departmentId, HR);
  }
}

function session(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  const id = crypto.randomUUID();
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

function mobileSession(employeeNumber) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mobile_sessions (
      id, employee_number, access_token_hash, access_expires_at,
      refresh_token_hash, refresh_expires_at, installation_id_hash,
      platform, device_label, app_version
    ) VALUES (
      ?, ?, ?, '2099-12-31T23:59:59.000Z',
      ?, '2099-12-31T23:59:59.000Z', ?, 'android', 'Learning Test', 'test'
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
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function resetLearningDenials() {
  db.prepare("DELETE FROM personnel_learning_permission_denial_authorities").run();
  db.prepare("DELETE FROM portal_permission_denials WHERE permission LIKE 'personnel:learning:%'").run();
  db.prepare("DELETE FROM portal_permission_grants WHERE permission LIKE 'personnel:learning:%'").run();
}

function accountSecuritySnapshot(employeeNumber) {
  const row = db.prepare(`
    SELECT role, password_hash, active
    FROM portal_users
    WHERE employee_number = ?
  `).get(employeeNumber);
  return { role: row.role, passwordHash: row.password_hash, active: Number(row.active) };
}

function optionalAccountSecuritySnapshot(employeeNumber) {
  const row = db.prepare(`
    SELECT role, password_hash, active
    FROM portal_users
    WHERE employee_number = ?
  `).get(employeeNumber);
  return row
    ? { role: row.role, passwordHash: row.password_hash, active: Number(row.active) }
    : null;
}

function portalScopeSnapshot(employeeNumber) {
  return db.prepare(`
    SELECT location_id, department_id
    FROM portal_access_scopes
    WHERE employee_number = ?
    ORDER BY location_id, department_id
  `).all(employeeNumber).map((row) => ({
    locationId: String(row.location_id),
    departmentId: Number(row.department_id || 0) || null,
  }));
}

function replacePortalScopes(employeeNumber, scopes) {
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(employeeNumber);
  const insert = db.prepare(`
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, ?)
  `);
  for (const scope of scopes) {
    insert.run(
      employeeNumber,
      scope.locationId,
      Number(scope.departmentId || 0),
      HR,
    );
  }
}

function auditRowCount() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
}

function grantPortalPermission(employeeNumber, permission) {
  db.prepare(`
    INSERT OR IGNORE INTO portal_permission_grants
      (employee_number, permission, granted_by)
    VALUES (?, ?, ?)
  `).run(employeeNumber, permission, HR);
}

function revokePortalPermissionGrant(employeeNumber, permission) {
  db.prepare(`
    DELETE FROM portal_permission_grants
    WHERE employee_number = ? AND permission = ?
  `).run(employeeNumber, permission);
}

function locationUpdateBody(locationId, overrides = {}) {
  const row = db.prepare(`
    SELECT id, name, cost_center_id, min_staff, day_settings_json,
           time_tracking_enabled, time_tracking_access_mode,
           time_tracking_allowed_networks, time_tracking_variance_minutes, active
    FROM locations
    WHERE id = ?
  `).get(locationId);
  assert.ok(row, `Location ${locationId} fehlt`);
  return {
    id: String(row.id),
    name: String(row.name),
    costCenterId: String(row.cost_center_id || ""),
    minStaff: Number(row.min_staff || 0),
    daySettings: JSON.parse(row.day_settings_json || "{}"),
    timeTrackingEnabled: Boolean(row.time_tracking_enabled),
    timeTrackingAccessMode: String(row.time_tracking_access_mode || "anywhere"),
    timeTrackingAllowedNetworks: String(row.time_tracking_allowed_networks || ""),
    timeTrackingVarianceMinutes: Number(row.time_tracking_variance_minutes ?? 15),
    active: Boolean(row.active),
    ...overrides,
  };
}

function departmentUpdateBody(departmentId, overrides = {}) {
  const row = db.prepare(`
    SELECT id, location_id, name, min_staff, active
    FROM departments
    WHERE id = ?
  `).get(departmentId);
  assert.ok(row, `Department ${departmentId} fehlt`);
  return {
    locationId: String(row.location_id),
    name: String(row.name),
    minStaff: Number(row.min_staff || 0),
    active: Boolean(row.active),
    ...overrides,
  };
}

function insertDepartmentScopedLearningVersion(departmentId, locationId) {
  const suffix = crypto.randomUUID();
  const moduleRow = {
    id: `learning-move-module-${suffix}`,
    module_code: `MOVE-${suffix}`,
    module_type: "training",
    created_by: HR,
    created_at: "2026-08-18T10:00:00.000Z",
  };
  moduleRow.receipt_sha256 = moduleReceiptSha256(moduleRow);
  db.prepare(`
    INSERT INTO personnel_learning_modules (
      id, module_code, module_type, receipt_sha256, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    moduleRow.id,
    moduleRow.module_code,
    moduleRow.module_type,
    moduleRow.receipt_sha256,
    moduleRow.created_by,
    moduleRow.created_at,
  );
  const contentJson = JSON.stringify({ blocks: [{ type: "text", text: "Move-Schutz" }] });
  const scopeSnapshotJson = JSON.stringify({
    type: "department",
    locationId,
    departmentId,
  });
  const version = {
    module_id: moduleRow.id,
    version_number: 1,
    title: "Unveraenderlicher Abteilungsscope",
    content_json: contentJson,
    content_sha256: sha256Text(contentJson),
    scope_type: "department",
    scope_location_id: locationId,
    scope_department_id: departmentId,
    scope_snapshot_json: scopeSnapshotJson,
    scope_snapshot_sha256: sha256Text(scopeSnapshotJson),
    previous_receipt_sha256: "",
    created_by: HR,
    created_at: "2026-08-18T10:01:00.000Z",
  };
  version.receipt_sha256 = moduleVersionReceiptSha256(version);
  db.prepare(`
    INSERT INTO personnel_learning_module_versions (
      module_id, version_number, title, content_json, content_sha256,
      scope_type, scope_location_id, scope_department_id, scope_snapshot_json,
      scope_snapshot_sha256, previous_receipt_sha256, receipt_sha256,
      created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.module_id,
    version.version_number,
    version.title,
    version.content_json,
    version.content_sha256,
    version.scope_type,
    version.scope_location_id,
    version.scope_department_id,
    version.scope_snapshot_json,
    version.scope_snapshot_sha256,
    version.previous_receipt_sha256,
    version.receipt_sha256,
    version.created_by,
    version.created_at,
  );
  return moduleRow.id;
}

function assertSessionNotRevoked(portal, mobile) {
  assert.equal(db.prepare(
    "SELECT revoked_at FROM portal_sessions WHERE id = ?",
  ).get(portal.id).revoked_at, null);
  const mobileRow = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
  `).get(mobile);
  assert.equal(mobileRow.revoked_at, null);
  assert.equal(mobileRow.revoked_reason, "");
}

function assertSessionRevoked(portal, mobile) {
  assert.ok(db.prepare(
    "SELECT revoked_at FROM portal_sessions WHERE id = ?",
  ).get(portal.id).revoked_at);
  const mobileRow = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
  `).get(mobile);
  assert.ok(mobileRow.revoked_at);
  assert.equal(mobileRow.revoked_reason, "learning_organization_scope_changed");
}

function assertLearningRightsHiddenInPortalUsers(payload, employeeNumber = LOCAL_AL) {
  assertNoLearningRoleOrCatalogPermissions(payload);
  const target = payload?.users?.find((user) => user.employeeNumber === employeeNumber);
  assert.ok(target, JSON.stringify(payload));
  for (const field of [
    "rolePermissions",
    "grantedPermissions",
    "deniedPermissions",
    "effectivePermissions",
  ]) {
    assert.equal((target[field] || []).some(
      (permission) => PERSONNEL_LEARNING_PERMISSION_IDS.includes(permission),
    ), false, field);
  }
  assert.equal((target.personnelLifecyclePermissionScopes || []).some(
    (scope) => PERSONNEL_LEARNING_PERMISSION_IDS.includes(scope.permission),
  ), false, "personnelLifecyclePermissionScopes");
  assert.equal(JSON.stringify(target).includes("personnelLearningDenialAuthority"), false);
}

function assertNoLearningRoleOrCatalogPermissions(payload) {
  for (const role of payload?.roles || []) {
    assert.equal((role.permissions || []).some(
      (permission) => String(permission).startsWith("personnel:learning:"),
    ), false, `role:${role.id}`);
  }
  assert.equal((payload?.catalog || []).some(
    (permission) => String(permission?.id || "").startsWith("personnel:learning:"),
  ), false, "catalog");
}

function assertLearningRoleOrCatalogPermissionsVisible(payload) {
  const rolePermissions = (payload?.roles || []).flatMap((role) => role.permissions || []);
  const catalogPermissions = (payload?.catalog || []).map((permission) => permission?.id);
  assert.equal([...rolePermissions, ...catalogPermissions].some(
    (permission) => String(permission || "").startsWith("personnel:learning:"),
  ), true, JSON.stringify(payload));
}

async function withPermissionRevokedAtNextPersonnelTransaction(
  auth,
  employeeNumber,
  permission,
  operation,
) {
  const dropTrigger = installSessionTouchRaceMutation(auth, `
    INSERT OR IGNORE INTO portal_permission_denials
      (employee_number, permission, denied_by)
    VALUES (${sqliteText(employeeNumber)}, ${sqliteText(permission)}, 'learning-race-test');
  `);
  try {
    return await operation();
  } finally {
    dropTrigger();
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ? AND permission = ?
    `).run(employeeNumber, permission);
  }
}

async function withPortalRoleChangedAtNextRequest(
  auth,
  employeeNumber,
  role,
  operation,
) {
  const previousRole = db.prepare(`
    SELECT role FROM portal_users WHERE employee_number = ?
  `).get(employeeNumber)?.role;
  const dropTrigger = installSessionTouchRaceMutation(auth, `
    UPDATE portal_users
    SET role = ${sqliteText(role)}, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ${sqliteText(employeeNumber)};
  `);
  try {
    return await operation();
  } finally {
    dropTrigger();
    if (previousRole) {
      db.prepare(`
        UPDATE portal_users SET role = ?, updated_at = CURRENT_TIMESTAMP
        WHERE employee_number = ?
      `).run(previousRole, employeeNumber);
    }
  }
}

function sqliteText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function installSessionTouchRaceMutation(auth, statements) {
  const triggerName = `test_learning_actor_race_${crypto.randomBytes(8).toString("hex")}`;
  db.exec(`
    CREATE TRIGGER ${triggerName}
    AFTER UPDATE OF expires_at ON portal_sessions
    WHEN NEW.id = ${sqliteText(auth.id)}
    BEGIN
      ${statements}
    END
  `);
  return () => db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
}

async function assertScopeMutationDenied({
  auth,
  route,
  body,
  employeeNumber = LOCAL_AL,
  expectedCode = "PORTAL_ROLE_HIERARCHY_DENIED",
  expectedAuditDelta = 0,
}) {
  const beforeScopes = portalScopeSnapshot(employeeNumber);
  const targetPortalSession = session(employeeNumber);
  const targetMobileSession = mobileSession(employeeNumber);
  const auditBefore = auditRowCount();
  const result = await request(route, { method: "PUT", auth, body });
  assert.equal(result.response.status, 403, JSON.stringify(result.payload));
  assert.equal(result.payload.code, expectedCode);
  assert.deepEqual(portalScopeSnapshot(employeeNumber), beforeScopes);
  assert.equal(auditRowCount(), auditBefore + expectedAuditDelta);
  assert.equal(db.prepare(
    "SELECT revoked_at FROM portal_sessions WHERE id = ?",
  ).get(targetPortalSession.id).revoked_at, null);
  const mobile = db.prepare(`
    SELECT revoked_at, revoked_reason
    FROM mobile_sessions
    WHERE id = ?
  `).get(targetMobileSession);
  assert.equal(mobile.revoked_at, null);
  assert.equal(mobile.revoked_reason, "");
}

function rightsBody(target, deniedPermissions) {
  const scopes = target.role === "manager"
    ? [{ locationId: target.locationId, departmentId: null }]
    : [{ locationId: target.locationId, departmentId: target.departmentId }];
  return { grantedPermissions: [], deniedPermissions, scopes };
}

async function plPlusLearningDenial(auth, target, denied) {
  return request(`/api/portal/v1/rights/${encodeURIComponent(target.employeeNumber)}`, {
    method: "PUT",
    auth,
    body: rightsBody(target, denied ? [CROSS_PERMISSION] : []),
  });
}

test.before(async () => {
  let locations = db.prepare(`
    SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 2
  `).all();
  if (locations.length < 2) {
    db.prepare(`
      INSERT INTO locations (id, name, min_staff, active)
      VALUES ('learning-foreign-location', 'Learning Fremdfiliale', 0, 1)
    `).run();
    locations = db.prepare(`
      SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 2
    `).all();
  }
  assert.equal(locations.length, 2);
  const fixture = (locationId, suffix) => {
    let department = db.prepare(`
      SELECT id FROM departments
      WHERE location_id = ? AND active = 1
      ORDER BY id LIMIT 1
    `).get(locationId);
    if (!department) {
      department = db.prepare(`
        INSERT INTO departments (location_id, name, min_staff, active, sort_order)
        VALUES (?, ?, 0, 1, 9280)
        RETURNING id
      `).get(locationId, `Learning ${suffix}`);
    }
    return { locationId: String(locationId), departmentId: Number(department.id) };
  };
  local = fixture(locations[0].id, "lokal");
  foreign = fixture(locations[1].id, "fremd");
  let alternateDepartment = db.prepare(`
    SELECT id
    FROM departments
    WHERE location_id = ? AND active = 1 AND id <> ?
    ORDER BY id LIMIT 1
  `).get(local.locationId, local.departmentId);
  if (!alternateDepartment) {
    alternateDepartment = db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Learning Scope Alternative', 0, 1, 9281)
      RETURNING id
    `).get(local.locationId);
  }
  localAlternateDepartmentId = Number(alternateDepartment.id);
  employee(DEVELOPER, "Dora Developer", "developer", local.locationId);
  employee(HR, "Helena Personalleitung", "hr", local.locationId);
  employee(ADMIN, "Anton Administration", "admin", local.locationId);
  employee(IT_ADMIN, "Ina Technik", "it_admin", local.locationId);
  employee(EMPLOYEE, "Emil Mitarbeiter", "employee", local.locationId);
  employee(UNCONFIGURED, "Ute Ohne Zugang", "employee", local.locationId);
  db.prepare("DELETE FROM portal_users WHERE employee_number = ?").run(UNCONFIGURED);
  employee(MANAGER, "Florian Filialleitung", "manager", local.locationId);
  employee(LOCAL_AL, "Alina Abteilungsleitung", "department_manager", local.locationId, local.departmentId);
  employee(LOCAL_AL_TWO, "Amir Abteilungsleitung", "department_manager", local.locationId, local.departmentId);
  employee(FOREIGN_AL, "Fiona Abteilungsleitung", "department_manager", foreign.locationId, foreign.departmentId);
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

test("Learning-Rollenstandards trennen Fachzugriff, Delegation und Technik", () => {
  const roles = new Map(db.prepare("SELECT id, permissions FROM portal_roles").all()
    .map((row) => [row.id, JSON.parse(row.permissions)]));
  for (const role of ["manager", "department_manager"]) {
    assert.deepEqual(
      PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS.filter(
        (permission) => !roles.get(role).includes(permission),
      ),
      [],
    );
    assert.equal(roles.get(role).includes(PERSONNEL_LEARNING_PERMISSIONS.DELEGATE), false);
  }
  for (const role of ["hr", "admin"]) {
    assert.equal(roles.get(role).includes(PERSONNEL_LEARNING_PERMISSIONS.DELEGATE), true);
    assert.equal(PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS.some(
      (permission) => roles.get(role).includes(permission)), false);
  }
  assert.equal(PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS.every(
    (permission) => roles.get("developer").includes(permission)), true);
  assert.equal(roles.get("developer").includes(PERSONNEL_LEARNING_PERMISSIONS.DELEGATE), true);
  assert.equal(PERSONNEL_LEARNING_PERMISSION_IDS.some(
    (permission) => roles.get("it_admin").includes(permission)), false);
});

test("Rollen- und Katalog-DTOs minimieren Learning-Rechte nach aktueller Einsichtsautorität", async () => {
  resetLearningDenials();

  const anonymousRoles = await request("/api/portal/v1/roles");
  assert.equal(anonymousRoles.response.status, 401, JSON.stringify(anonymousRoles.payload));
  for (const employeeNumber of [EMPLOYEE, LOCAL_AL]) {
    const denied = await request("/api/portal/v1/roles", { auth: session(employeeNumber) });
    assert.equal(denied.response.status, 403, `${employeeNumber}: ${JSON.stringify(denied.payload)}`);
    assert.equal(JSON.stringify(denied.payload).includes("personnel:learning:"), false);
  }

  const scopedManagerRoles = await request("/api/portal/v1/roles", { auth: session(MANAGER) });
  assert.equal(scopedManagerRoles.response.status, 200, JSON.stringify(scopedManagerRoles.payload));
  assertNoLearningRoleOrCatalogPermissions(scopedManagerRoles.payload);
  assert.equal(scopedManagerRoles.payload.roles.some((role) => role.id === "manager"), true);
  assert.equal(scopedManagerRoles.payload.catalog.length > 0, true);

  const developerRoles = await request("/api/portal/v1/roles", { auth: session(DEVELOPER) });
  assert.equal(developerRoles.response.status, 200, JSON.stringify(developerRoles.payload));
  assertLearningRoleOrCatalogPermissionsVisible(developerRoles.payload);

  const delegatedAdminPayloads = await Promise.all([
    request("/api/portal/v1/roles", { auth: session(ADMIN) }),
    request("/api/portal/v1/roles", { auth: session(HR) }),
    request("/api/portal/v1/users", { auth: session(ADMIN) }),
    request("/api/portal/v1/rights", { auth: session(HR) }),
    request("/api/portal/v1/rights-dashboard", { auth: session(HR) }),
  ]);
  for (const result of delegatedAdminPayloads) {
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assertLearningRoleOrCatalogPermissionsVisible(result.payload);
  }
  const standardHrRoles = delegatedAdminPayloads[1].payload;
  assert.equal(standardHrRoles.roles.find(
    (role) => role.id === "hr",
  )?.permissions.includes("users:write"), true);
  assert.equal(standardHrRoles.catalog.length > 0, true);

  const technicalPayloads = await Promise.all([
    request("/api/portal/v1/roles", { auth: session(IT_ADMIN) }),
    request("/api/portal/v1/users", { auth: session(IT_ADMIN) }),
    request("/api/portal/v1/rights", { auth: session(IT_ADMIN) }),
    request("/api/portal/v1/rights-dashboard", { auth: session(IT_ADMIN) }),
  ]);
  for (const result of technicalPayloads) {
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assertNoLearningRoleOrCatalogPermissions(result.payload);
    if (Array.isArray(result.payload.catalog)) {
      assert.equal(result.payload.catalog.length > 0, true);
    }
  }

  for (const employeeNumber of [ADMIN, HR]) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, ?, ?)
    `).run(employeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE, "learning-dto-test");
    try {
      const auth = session(employeeNumber);
      const routes = [
        "/api/portal/v1/users",
        "/api/portal/v1/rights",
        "/api/portal/v1/rights-dashboard",
        "/api/portal/v1/roles",
      ];
      for (const route of routes) {
        const result = await request(route, { auth });
        assert.equal(result.response.status, 200, `${route}: ${JSON.stringify(result.payload)}`);
        assertNoLearningRoleOrCatalogPermissions(result.payload);
        if (Array.isArray(result.payload.catalog)) {
          assert.equal(result.payload.catalog.length > 0, true);
        }
        if (route === "/api/portal/v1/roles") {
          const currentRole = employeeNumber === ADMIN ? "admin" : "hr";
          assert.equal(result.payload.roles.find(
            (role) => role.id === currentRole,
          )?.permissions.includes("users:write"), true);
          assert.equal(result.payload.catalog.length > 0, true);
        }
      }
    } finally {
      db.prepare(`
        DELETE FROM portal_permission_denials
        WHERE employee_number = ? AND permission = ?
      `).run(employeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
    }
  }
});

test("FL entzieht und restauriert das Recht ausschließlich für AL der eigenen Filiale", async () => {
  resetLearningDenials();
  const manager = session(MANAGER);
  const targetSession = session(LOCAL_AL);
  const listed = await request(
    "/api/portal/v1/personnel-learning/cross-location-delegates",
    { auth: manager },
  );
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  assert.deepEqual(listed.payload.delegates.map((entry) => entry.employeeNumber).sort(),
    [LOCAL_AL, LOCAL_AL_TWO].sort());
  assert.equal(listed.payload.delegates.every((entry) => entry.effective), true);

  const denied = await request(
    `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL}`,
    { method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" } },
  );
  assert.equal(denied.response.status, 200, JSON.stringify(denied.payload));
  assert.equal(denied.payload.delegate.effective, false);
  assert.equal(denied.payload.delegate.denialAuthority, "manager");
  assert.match(denied.payload.delegate.revision, /^[0-9a-f]{32}:1$/);
  const firstRevision = denied.payload.delegate.revision;
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?").get(targetSession.id).revoked_at);
  const storedAuthority = db.prepare(`
    SELECT authority_level, scope_location_id, generation_id, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION);
  assert.equal(storedAuthority.authority_level, "manager");
  assert.equal(storedAuthority.scope_location_id, local.locationId);
  assert.match(storedAuthority.generation_id, /^[0-9a-f]{32}$/);
  assert.equal(storedAuthority.revision, 1);

  const restored = await request(
    `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL}`,
    { method: "PUT", auth: manager, body: { enabled: true, expectedRevision: firstRevision } },
  );
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.delegate.effective, true);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_permission_denials
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION).count, 0);

  const foreignAttempt = await request(
    `/api/portal/v1/personnel-learning/cross-location-delegates/${FOREIGN_AL}`,
    { method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" } },
  );
  assert.equal(foreignAttempt.response.status, 403, JSON.stringify(foreignAttempt.payload));
  assert.equal(foreignAttempt.payload.code, "PERSONNEL_LEARNING_DELEGATION_SCOPE_DENIED");
});

test("PL+ übernimmt einen lokalen FL-Entzug über die dedizierte Route mit geschützter Provenienz", async () => {
  resetLearningDenials();
  const route = `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL}`;
  const managerDenial = await request(route, {
    method: "PUT",
    auth: session(MANAGER),
    body: { enabled: false, expectedRevision: "" },
  });
  assert.equal(managerDenial.response.status, 200, JSON.stringify(managerDenial.payload));
  const managerRevision = managerDenial.payload.delegate.revision;
  const managerAuthority = db.prepare(`
    SELECT authority_level, scope_location_id, generation_id, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION);
  assert.equal(managerAuthority.authority_level, "manager");

  const hr = session(HR);
  const plPlusList = await request(
    "/api/portal/v1/personnel-learning/cross-location-delegates",
    { auth: hr },
  );
  assert.equal(plPlusList.response.status, 200, JSON.stringify(plPlusList.payload));
  const visibleEmployeeNumbers = new Set(
    plPlusList.payload.delegates.map((entry) => entry.employeeNumber),
  );
  for (const employeeNumber of [MANAGER, LOCAL_AL, LOCAL_AL_TWO, FOREIGN_AL]) {
    assert.equal(visibleEmployeeNumbers.has(employeeNumber), true);
  }
  assert.equal(
    plPlusList.payload.delegates.find((entry) => entry.employeeNumber === LOCAL_AL).revision,
    managerRevision,
  );
  for (const plPlus of [session(ADMIN), session(DEVELOPER)]) {
    const list = await request(
      "/api/portal/v1/personnel-learning/cross-location-delegates",
      { auth: plPlus },
    );
    assert.equal(list.response.status, 200, JSON.stringify(list.payload));
  }
  const protectedDenial = await request(route, {
    method: "PUT",
    auth: hr,
    body: { enabled: false, expectedRevision: managerRevision },
  });
  assert.equal(protectedDenial.response.status, 200, JSON.stringify(protectedDenial.payload));
  assert.equal(protectedDenial.payload.delegate.effective, false);
  assert.equal(protectedDenial.payload.delegate.denialAuthority, "pl_plus");
  const protectedRevision = protectedDenial.payload.delegate.revision;
  const protectedAuthority = db.prepare(`
    SELECT authority_level, scope_location_id, generation_id, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION);
  assert.equal(protectedAuthority.authority_level, "pl_plus");
  assert.equal(protectedAuthority.scope_location_id, "");
  assert.equal(protectedAuthority.generation_id, managerAuthority.generation_id);
  assert.equal(protectedAuthority.revision, managerAuthority.revision + 1);
  const audit = db.prepare(`
    SELECT actor, detail
    FROM audit_log
    WHERE action = 'personnel.learning.cross-location-right.update'
      AND entity_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(LOCAL_AL);
  assert.equal(audit.actor, HR);
  assert.deepEqual(JSON.parse(audit.detail), {
    schemaVersion: 1,
    permission: CROSS_PERMISSION,
    enabledBefore: false,
    enabledAfter: false,
    authorityBefore: "manager",
    authorityAfter: "pl_plus",
    scopeLocationId: "",
    reasonCode: "PL_PLUS_RIGHTS_MANAGEMENT",
  });

  const restored = await request(route, {
    method: "PUT",
    auth: session(HR),
    body: { enabled: true, expectedRevision: protectedRevision },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.delegate.effective, true);

  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(HR, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE, DEVELOPER);
  try {
    const blocked = await request(
      "/api/portal/v1/personnel-learning/cross-location-delegates",
      { auth: session(HR) },
    );
    assert.equal(blocked.response.status, 403, JSON.stringify(blocked.payload));
    assert.equal(blocked.payload.code, "PERSONNEL_LEARNING_DELEGATION_ACTOR_PERMISSION_DENIED");
  } finally {
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ? AND permission = ?
    `).run(HR, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
  }
});

test("Learning-Delegation bleibt ohne expliziten wirksamen Portal-Scope geschlossen", async () => {
  resetLearningDenials();
  const manager = session(MANAGER);
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(MANAGER);
  try {
    const actorWithoutScope = await request(
      "/api/portal/v1/personnel-learning/cross-location-delegates",
      { auth: manager },
    );
    assert.equal(actorWithoutScope.response.status, 403, JSON.stringify(actorWithoutScope.payload));
    assert.equal(actorWithoutScope.payload.code, "PERSONNEL_LEARNING_DELEGATION_ACTOR_PERMISSION_DENIED");
  } finally {
    db.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, ?)
    `).run(MANAGER, local.locationId, HR);
  }

  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(LOCAL_AL_TWO);
  try {
    const targetWithoutScope = await request(
      `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL_TWO}`,
      { method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" } },
    );
    assert.equal(targetWithoutScope.response.status, 403, JSON.stringify(targetWithoutScope.payload));
    assert.equal(targetWithoutScope.payload.code, "PERSONNEL_LEARNING_DELEGATION_SCOPE_DENIED");
  } finally {
    db.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, ?, ?)
    `).run(LOCAL_AL_TWO, local.locationId, local.departmentId, HR);
  }
});

test("ein neu gesetzter Entzug erhält eine neue Generation und blockiert ABA-Restores", async () => {
  resetLearningDenials();
  const manager = session(MANAGER);
  const route = `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL_TWO}`;
  const first = await request(route, {
    method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  const firstRevision = first.payload.delegate.revision;
  assert.match(firstRevision, /^[0-9a-f]{32}:1$/);
  assert.equal((await request(route, {
    method: "PUT", auth: manager, body: { enabled: true, expectedRevision: firstRevision },
  })).response.status, 200);

  const second = await request(route, {
    method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" },
  });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  const secondRevision = second.payload.delegate.revision;
  assert.match(secondRevision, /^[0-9a-f]{32}:1$/);
  assert.notEqual(secondRevision, firstRevision);

  const staleRestore = await request(route, {
    method: "PUT", auth: manager,
    body: { enabled: true, expectedRevision: firstRevision },
  });
  assert.equal(staleRestore.response.status, 409, JSON.stringify(staleRestore.payload));
  assert.equal(staleRestore.payload.code, "PERSONNEL_LEARNING_DELEGATION_CONCURRENT_CHANGE");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_permission_denials
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL_TWO, CROSS_PERMISSION).count, 1);
  assert.equal((await request(route, {
    method: "PUT", auth: manager, body: { enabled: true, expectedRevision: secondRevision },
  })).response.status, 200);
});

test("PL+-Entzug ist geschützt und kann nur durch PL+ aufgehoben werden", async () => {
  resetLearningDenials();
  const hr = session(HR);
  const target = {
    employeeNumber: LOCAL_AL,
    role: "department_manager",
    ...local,
  };
  const denied = await plPlusLearningDenial(hr, target, true);
  assert.equal(denied.response.status, 200, JSON.stringify(denied.payload));
  const authority = db.prepare(`
    SELECT authority_level, scope_location_id, generation_id, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION);
  assert.equal(authority.authority_level, "pl_plus");
  assert.equal(authority.scope_location_id, "");

  const admin = session(ADMIN);
  const blockedRoleChange = await request(`/api/portal/v1/users/${LOCAL_AL}`, {
    method: "PUT",
    auth: admin,
    body: { role: "employee", active: true },
  });
  assert.equal(blockedRoleChange.response.status, 409, JSON.stringify(blockedRoleChange.payload));
  assert.equal(blockedRoleChange.payload.code, "PERSONNEL_LIFECYCLE_RIGHTS_PROFILE_PROTECTED");
  assert.equal(db.prepare(`
    SELECT role FROM portal_users WHERE employee_number = ?
  `).get(LOCAL_AL).role, "department_manager");
  assert.equal(db.prepare(`
    SELECT generation_id FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION).generation_id, authority.generation_id);

  const manager = session(MANAGER);
  const blocked = await request(
    `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL}`,
    {
      method: "PUT",
      auth: manager,
      body: {
        enabled: true,
        expectedRevision: `${authority.generation_id}:${authority.revision}`,
      },
    },
  );
  assert.equal(blocked.response.status, 403, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, "PERSONNEL_LEARNING_PL_PLUS_DENIAL_PROTECTED");

  const restored = await plPlusLearningDenial(hr, target, false);
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ?
  `).get(LOCAL_AL).count, 0);
});

test("unverändertes PL+-Speichern übernimmt keinen lokalen FL-Entzug", async () => {
  resetLearningDenials();
  const manager = session(MANAGER);
  const denied = await request(
    `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL}`,
    { method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" } },
  );
  assert.equal(denied.response.status, 200, JSON.stringify(denied.payload));
  const before = db.prepare(`
    SELECT authority_level, scope_location_id, generation_id, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION);

  const hr = session(HR);
  const unchanged = await plPlusLearningDenial(hr, {
    employeeNumber: LOCAL_AL,
    role: "department_manager",
    ...local,
  }, true);
  assert.equal(unchanged.response.status, 200, JSON.stringify(unchanged.payload));
  const after = db.prepare(`
    SELECT authority_level, scope_location_id, generation_id, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION);
  assert.deepEqual({ ...after }, { ...before });

  const restored = await plPlusLearningDenial(hr, {
    employeeNumber: LOCAL_AL,
    role: "department_manager",
    ...local,
  }, false);
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
});

test("FL ohne eigenes Recht kann ein weiterhin berechtigtes AL-Recht nicht verändern", async () => {
  resetLearningDenials();
  const hr = session(HR);
  const managerTarget = {
    employeeNumber: MANAGER,
    role: "manager",
    locationId: local.locationId,
    departmentId: null,
  };
  const denied = await plPlusLearningDenial(hr, managerTarget, true);
  assert.equal(denied.response.status, 200, JSON.stringify(denied.payload));
  const manager = session(MANAGER);
  const blocked = await request(
    `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL}`,
    { method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" } },
  );
  assert.equal(blocked.response.status, 403, JSON.stringify(blocked.payload));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_permission_denials
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION).count, 0);
  const restored = await plPlusLearningDenial(hr, managerTarget, false);
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
});

test("AL delegiert nie und IT-Admin kann Learning-Rechte nicht technisch übernehmen", async () => {
  resetLearningDenials();
  const departmentManager = session(LOCAL_AL);
  const alAttempt = await request(
    `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL_TWO}`,
    { method: "PUT", auth: departmentManager, body: { enabled: false, expectedRevision: "" } },
  );
  assert.equal(alAttempt.response.status, 403, JSON.stringify(alAttempt.payload));
  assert.equal(alAttempt.payload.code,
    "PERSONNEL_LEARNING_DEPARTMENT_MANAGER_CANNOT_DELEGATE");

  const itAdmin = session(IT_ADMIN);
  for (const employeeNumber of [EMPLOYEE, UNCONFIGURED]) {
    for (const role of ["manager", "department_manager"]) {
      const before = db.prepare(`
        SELECT role, password_hash, active
        FROM portal_users
        WHERE employee_number = ?
      `).get(employeeNumber);
      const promotion = await request(`/api/portal/v1/users/${employeeNumber}`, {
        method: "PUT",
        auth: itAdmin,
        body: {
          role,
          active: true,
          password: "Nicht-Uebernehmen-2026!",
          mustChangePassword: false,
        },
      });
      assert.equal(promotion.response.status, 403, JSON.stringify(promotion.payload));
      assert.equal(promotion.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
      const after = db.prepare(`
        SELECT role, password_hash, active
        FROM portal_users
        WHERE employee_number = ?
      `).get(employeeNumber);
      assert.deepEqual(after ? { ...after } : null, before ? { ...before } : null);
    }
  }
  db.prepare(`
    INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
    VALUES (?, ?, ?)
  `).run(ADMIN, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE, HR);
  try {
    const admin = session(ADMIN);
    const adminRights = await request("/api/portal/v1/rights", { auth: admin });
    assert.equal(adminRights.response.status, 200, JSON.stringify(adminRights.payload));
    assertNoLearningRoleOrCatalogPermissions(adminRights.payload);
    const adminDashboard = await request("/api/portal/v1/rights-dashboard", { auth: admin });
    assert.equal(adminDashboard.response.status, 200, JSON.stringify(adminDashboard.payload));
    assert.equal(adminDashboard.payload.users.find(
      (user) => user.employeeNumber === LOCAL_AL,
    ).permissions.some(
      (permission) => PERSONNEL_LEARNING_PERMISSION_IDS.includes(permission.id),
    ), false);
    const revokedDelegateAttempt = await request(`/api/portal/v1/rights/${LOCAL_AL}`, {
      method: "PUT",
      auth: admin,
      body: rightsBody({
        employeeNumber: LOCAL_AL,
        role: "department_manager",
        ...local,
      }, [CROSS_PERMISSION]),
    });
    assert.equal(revokedDelegateAttempt.response.status, 403,
      JSON.stringify(revokedDelegateAttempt.payload));
    assert.equal(revokedDelegateAttempt.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");
  } finally {
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ? AND permission = ?
    `).run(ADMIN, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
  }
  for (const [employeeNumber, role] of [
    [MANAGER, "manager"],
    [LOCAL_AL, "department_manager"],
  ]) {
    for (const update of [
      { role, active: true, password: "Nicht-Uebernehmen-2026!", mustChangePassword: false },
      { role, active: false },
      { role: "employee", active: true },
    ]) {
      const before = accountSecuritySnapshot(employeeNumber);
      const takeover = await request(`/api/portal/v1/users/${employeeNumber}`, {
        method: "PUT",
        auth: itAdmin,
        body: update,
      });
      assert.equal(takeover.response.status, 403, JSON.stringify(takeover.payload));
      assert.equal(takeover.payload.code, "PERSONNEL_LIFECYCLE_ACCOUNT_TAKEOVER_DENIED");
      assert.deepEqual(accountSecuritySnapshot(employeeNumber), before);
    }
  }
  const technicalAttempt = await request(`/api/portal/v1/rights/${LOCAL_AL}`, {
    method: "PUT",
    auth: itAdmin,
    body: rightsBody({
      employeeNumber: LOCAL_AL,
      role: "department_manager",
      ...local,
    }, [CROSS_PERMISSION]),
  });
  assert.equal(technicalAttempt.response.status, 403, JSON.stringify(technicalAttempt.payload));
  assert.equal(technicalAttempt.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");

  const manager = session(MANAGER);
  const localDenial = await request(
    `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL}`,
    { method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" } },
  );
  assert.equal(localDenial.response.status, 200, JSON.stringify(localDenial.payload));
  const unchangedTechnicalSave = await request(`/api/portal/v1/rights/${LOCAL_AL}`, {
    method: "PUT",
    auth: itAdmin,
    body: rightsBody({
      employeeNumber: LOCAL_AL,
      role: "department_manager",
      ...local,
    }, [CROSS_PERMISSION]),
  });
  assert.equal(unchangedTechnicalSave.response.status, 200,
    JSON.stringify(unchangedTechnicalSave.payload));
  const protectedAuthority = db.prepare(`
    SELECT authority_level, revision
    FROM personnel_learning_permission_denial_authorities
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION);
  assert.deepEqual({ ...protectedAuthority }, { authority_level: "manager", revision: 1 });

  const rawUsers = await request("/api/portal/v1/users", { auth: itAdmin });
  assert.equal(rawUsers.response.status, 200, JSON.stringify(rawUsers.payload));
  const rawRights = await request("/api/portal/v1/rights", { auth: itAdmin });
  assert.equal(rawRights.response.status, 200, JSON.stringify(rawRights.payload));
  const rawDashboard = await request("/api/portal/v1/rights-dashboard", { auth: itAdmin });
  assert.equal(rawDashboard.response.status, 200, JSON.stringify(rawDashboard.payload));
  for (const payload of [rawUsers.payload, rawRights.payload]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes("personnelLearningDenialAuthority"), false);
    assert.equal(serialized.includes("generation_id"), false);
    assert.equal(serialized.includes("denied_by"), false);
  }
  for (const itAdminTarget of [
    rawUsers.payload.users.find((user) => user.employeeNumber === LOCAL_AL),
    rawRights.payload.users.find((user) => user.employeeNumber === LOCAL_AL),
  ]) {
    for (const field of ["rolePermissions", "grantedPermissions", "deniedPermissions"]) {
      assert.equal(itAdminTarget[field].some(
        (permission) => PERSONNEL_LEARNING_PERMISSION_IDS.includes(permission),
      ), false, field);
    }
    if (Array.isArray(itAdminTarget.effectivePermissions)) {
      assert.equal(itAdminTarget.effectivePermissions.some(
        (permission) => PERSONNEL_LEARNING_PERMISSION_IDS.includes(permission),
      ), false, "effectivePermissions");
    }
  }
  assert.equal(rawDashboard.payload.users.find(
    (user) => user.employeeNumber === LOCAL_AL,
  ).permissions.some(
    (permission) => PERSONNEL_LEARNING_PERMISSION_IDS.includes(permission.id),
  ), false);
});

test("entzogenes Learning-Delegate kann weder selbst wiederhergestellt noch über Rollenvergabe umgangen werden", async () => {
  resetLearningDenials();
  for (const actorEmployeeNumber of [ADMIN, HR]) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, ?, ?)
    `).run(actorEmployeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE, "learning-security-test");
    try {
      let auth = session(actorEmployeeNumber);
      const rights = await request("/api/portal/v1/rights", { auth });
      assert.equal(rights.response.status, 200, JSON.stringify(rights.payload));
      assertNoLearningRoleOrCatalogPermissions(rights.payload);

      if (actorEmployeeNumber === ADMIN) {
        const selfRestore = await request(`/api/portal/v1/rights/${ADMIN}`, {
          method: "PUT",
          auth,
          body: { grantedPermissions: [], deniedPermissions: [], scopes: [] },
        });
        assert.equal(selfRestore.response.status, 200, JSON.stringify(selfRestore.payload));
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count
          FROM portal_permission_denials
          WHERE employee_number = ? AND permission = ?
        `).get(ADMIN, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE).count, 1);
        auth = session(actorEmployeeNumber);
      }

      for (const employeeNumber of [EMPLOYEE, UNCONFIGURED]) {
        for (const role of ["manager", "department_manager", "hr", "admin"]) {
          const before = optionalAccountSecuritySnapshot(employeeNumber);
          const promotion = await request(`/api/portal/v1/users/${employeeNumber}`, {
            method: "PUT",
            auth,
            body: {
              role,
              active: true,
              password: "Keine-Learning-Uebernahme-2026!",
              mustChangePassword: false,
            },
          });
          assert.equal(promotion.response.status, 403, JSON.stringify(promotion.payload));
          assert.equal(promotion.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
          assert.deepEqual(optionalAccountSecuritySnapshot(employeeNumber), before);
        }
      }

      for (const [employeeNumber, role] of [
        [MANAGER, "manager"],
        [LOCAL_AL, "department_manager"],
        [HR, "hr"],
        [ADMIN, "admin"],
      ]) {
        for (const update of [
          { role, active: true, password: "Keine-Learning-Uebernahme-2026!" },
          { role: "employee", active: true },
        ]) {
          const before = accountSecuritySnapshot(employeeNumber);
          const mutation = await request(`/api/portal/v1/users/${employeeNumber}`, {
            method: "PUT",
            auth,
            body: update,
          });
          assert.equal(mutation.response.status, 403, JSON.stringify(mutation.payload));
          assert.equal(mutation.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
          assert.deepEqual(accountSecuritySnapshot(employeeNumber), before);
        }
      }
    } finally {
      db.prepare(`
        DELETE FROM portal_permission_denials
        WHERE employee_number = ? AND permission = ?
      `).run(actorEmployeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
    }
  }

  const admin = session(ADMIN);
  const adminRights = await request("/api/portal/v1/rights", { auth: admin });
  assert.equal(adminRights.response.status, 200, JSON.stringify(adminRights.payload));
  assert.equal(adminRights.payload.catalog.find(
    (permission) => permission.id === PERSONNEL_LEARNING_PERMISSIONS.DELEGATE,
  ).editable, false);
  assert.equal(adminRights.payload.catalog.find(
    (permission) => permission.id === CROSS_PERMISSION,
  ).editable, true);
  const beforeSelfPromotion = accountSecuritySnapshot(ADMIN);
  const selfPromotion = await request(`/api/portal/v1/users/${ADMIN}`, {
    method: "PUT",
    auth: admin,
    body: {
      role: "manager",
      active: true,
      password: "Keine-Eigene-Learning-Rolle-2026!",
      mustChangePassword: false,
    },
  });
  assert.equal(selfPromotion.response.status, 403, JSON.stringify(selfPromotion.payload));
  assert.equal(selfPromotion.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.deepEqual(accountSecuritySnapshot(ADMIN), beforeSelfPromotion);
});

test("Live-Entzug von Learning-Delegate stoppt Rechte- und Rollenmutation atomar", async () => {
  resetLearningDenials();
  const hr = session(HR);

  const rightsTargetPortalSession = session(LOCAL_AL);
  const rightsTargetMobileSession = mobileSession(LOCAL_AL);
  const rightsAuditBefore = auditRowCount();
  const deniedRights = await withPermissionRevokedAtNextPersonnelTransaction(
    hr,
    HR,
    PERSONNEL_LEARNING_PERMISSIONS.DELEGATE,
    () => request(`/api/portal/v1/rights/${LOCAL_AL}`, {
      method: "PUT",
      auth: hr,
      body: rightsBody({
        employeeNumber: LOCAL_AL,
        role: "department_manager",
        ...local,
      }, [CROSS_PERMISSION]),
    }),
  );
  assert.equal(deniedRights.response.status, 403, JSON.stringify(deniedRights.payload));
  assert.equal(deniedRights.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_permission_denials
    WHERE employee_number = ? AND permission = ?
  `).get(LOCAL_AL, CROSS_PERMISSION).count, 0);
  assert.equal(auditRowCount(), rightsAuditBefore);
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(rightsTargetPortalSession.id).revoked_at, null);
  const rightsMobile = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
  `).get(rightsTargetMobileSession);
  assert.equal(rightsMobile.revoked_at, null);
  assert.equal(rightsMobile.revoked_reason, "");

  const roleBefore = accountSecuritySnapshot(EMPLOYEE);
  const roleTargetPortalSession = session(EMPLOYEE);
  const roleTargetMobileSession = mobileSession(EMPLOYEE);
  const roleAuditBefore = auditRowCount();
  const deniedRole = await withPermissionRevokedAtNextPersonnelTransaction(
    hr,
    HR,
    PERSONNEL_LEARNING_PERMISSIONS.DELEGATE,
    () => request(`/api/portal/v1/users/${EMPLOYEE}`, {
      method: "PUT",
      auth: hr,
      body: { role: "manager", active: true },
    }),
  );
  assert.equal(deniedRole.response.status, 403, JSON.stringify(deniedRole.payload));
  assert.equal(deniedRole.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.deepEqual(accountSecuritySnapshot(EMPLOYEE), roleBefore);
  assert.equal(auditRowCount(), roleAuditBefore);
  assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
    .get(roleTargetPortalSession.id).revoked_at, null);
  const roleMobile = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
  `).get(roleTargetMobileSession);
  assert.equal(roleMobile.revoked_at, null);
  assert.equal(roleMobile.revoked_reason, "");

  for (const routeRace of [
    {
      permission: "rights:write",
      route: `/api/portal/v1/rights/${LOCAL_AL}`,
      body: rightsBody({
        employeeNumber: LOCAL_AL,
        role: "department_manager",
        ...local,
      }, [CROSS_PERMISSION]),
      target: LOCAL_AL,
    },
    {
      permission: "scopes:write",
      route: `/api/portal/v1/users/${LOCAL_AL}/scopes`,
      body: {
        scopes: [
          ...portalScopeSnapshot(LOCAL_AL),
          { locationId: local.locationId, departmentId: localAlternateDepartmentId },
        ],
      },
      target: LOCAL_AL,
    },
    {
      permission: "users:write",
      route: `/api/portal/v1/users/${EMPLOYEE}`,
      body: { role: "employee", active: true, password: "Live-Rechteentzug-2026!" },
      target: EMPLOYEE,
    },
  ]) {
    const beforeScopes = portalScopeSnapshot(routeRace.target);
    const beforeAccount = optionalAccountSecuritySnapshot(routeRace.target);
    const targetPortalSession = session(routeRace.target);
    const targetMobileSession = mobileSession(routeRace.target);
    const auditBefore = auditRowCount();
    const denied = await withPortalRoleChangedAtNextRequest(
      hr,
      HR,
      "employee",
      () => request(routeRace.route, {
        method: "PUT",
        auth: hr,
        body: routeRace.body,
      }),
    );
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_PERMISSION_DENIED");
    assert.deepEqual(portalScopeSnapshot(routeRace.target), beforeScopes);
    assert.deepEqual(optionalAccountSecuritySnapshot(routeRace.target), beforeAccount);
    assert.equal(auditRowCount(), auditBefore);
    assert.equal(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?")
      .get(targetPortalSession.id).revoked_at, null);
    const mobile = db.prepare(`
      SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
    `).get(targetMobileSession);
    assert.equal(mobile.revoked_at, null);
    assert.equal(mobile.revoked_reason, "");
  }
});

test("Zugang entsperren prüft Learning-Hierarchie live, bleibt bei No-op nebenwirkungsfrei und ist atomar", async () => {
  resetLearningDenials();
  const route = `/api/portal/v1/users/${LOCAL_AL}/unlock`;
  const lockTarget = (attempts = 4) => {
    const lockedUntil = attempts ? "2099-12-31T23:59:59.000Z" : null;
    db.prepare(`
      UPDATE portal_users
      SET failed_login_attempts = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP
      WHERE employee_number = ?
    `).run(attempts, lockedUntil, LOCAL_AL);
    return { attempts, lockedUntil };
  };
  const lockSnapshot = () => {
    const row = db.prepare(`
      SELECT failed_login_attempts, locked_until
      FROM portal_users WHERE employee_number = ?
    `).get(LOCAL_AL);
    return {
      attempts: Number(row.failed_login_attempts || 0),
      lockedUntil: row.locked_until || null,
    };
  };

  const locked = lockTarget();
  const deniedTargetPortal = session(LOCAL_AL);
  const deniedTargetMobile = mobileSession(LOCAL_AL);
  const deniedAuditBefore = auditRowCount();
  const hr = session(HR);
  const denied = await withPermissionRevokedAtNextPersonnelTransaction(
    hr,
    HR,
    PERSONNEL_LEARNING_PERMISSIONS.DELEGATE,
    () => request(route, { method: "POST", auth: hr }),
  );
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.deepEqual(lockSnapshot(), locked);
  assert.equal(auditRowCount(), deniedAuditBefore);
  assertSessionNotRevoked(deniedTargetPortal, deniedTargetMobile);

  lockTarget(0);
  const noOpTargetPortal = session(LOCAL_AL);
  const noOpTargetMobile = mobileSession(LOCAL_AL);
  const noOpAuditBefore = auditRowCount();
  const noOp = await request(route, { method: "POST", auth: session(IT_ADMIN) });
  assert.equal(noOp.response.status, 200, JSON.stringify(noOp.payload));
  assert.deepEqual(lockSnapshot(), { attempts: 0, lockedUntil: null });
  assert.equal(auditRowCount(), noOpAuditBefore);
  assertSessionNotRevoked(noOpTargetPortal, noOpTargetMobile);

  const rollbackLocked = lockTarget(3);
  const rollbackTargetPortal = session(LOCAL_AL);
  const rollbackTargetMobile = mobileSession(LOCAL_AL);
  const rollbackAuditBefore = auditRowCount();
  db.exec(`
    CREATE TRIGGER test_learning_unlock_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'portal.user.unlock'
    BEGIN
      SELECT RAISE(ABORT, 'test learning unlock audit abort');
    END;
  `);
  try {
    const failed = await request(route, { method: "POST", auth: session(DEVELOPER) });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.deepEqual(lockSnapshot(), rollbackLocked);
    assert.equal(auditRowCount(), rollbackAuditBefore);
    assertSessionNotRevoked(rollbackTargetPortal, rollbackTargetMobile);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_learning_unlock_audit_abort");
  }

  for (const actorEmployeeNumber of [DEVELOPER, HR]) {
    lockTarget(2);
    const targetPortal = session(LOCAL_AL);
    const targetMobile = mobileSession(LOCAL_AL);
    const auditBefore = auditRowCount();
    const allowed = await request(route, {
      method: "POST",
      auth: session(actorEmployeeNumber),
    });
    assert.equal(
      allowed.response.status,
      200,
      `${actorEmployeeNumber}: ${JSON.stringify(allowed.payload)}`,
    );
    assert.deepEqual(lockSnapshot(), { attempts: 0, lockedUntil: null });
    assert.equal(auditRowCount(), auditBefore + 1);
    assertSessionNotRevoked(targetPortal, targetMobile);
  }
  lockTarget(0);
});

test("No-op-Antworten aller Zugangswege nutzen den live eingeschränkten Akteur", async () => {
  resetLearningDenials();
  const originalScopes = [{
    locationId: local.locationId,
    departmentId: local.departmentId,
  }];
  replacePortalScopes(LOCAL_AL, originalScopes);
  db.prepare(`
    UPDATE portal_users
    SET role = 'department_manager', active = 1, must_change_password = 0,
        failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(LOCAL_AL);

  const noOpRoutes = [
    {
      method: "PUT",
      route: `/api/portal/v1/rights/${LOCAL_AL}`,
      body: {
        grantedPermissions: [],
        deniedPermissions: [],
        scopes: originalScopes,
      },
    },
    {
      method: "PUT",
      route: `/api/portal/v1/users/${LOCAL_AL}/scopes`,
      body: { scopes: originalScopes },
    },
    {
      method: "PUT",
      route: `/api/portal/v1/users/${LOCAL_AL}`,
      body: { role: "department_manager", active: true, mustChangePassword: false },
    },
    {
      method: "POST",
      route: `/api/portal/v1/users/${LOCAL_AL}/unlock`,
    },
  ];

  for (const route of noOpRoutes) {
    const hr = session(HR);
    const targetPortal = session(LOCAL_AL);
    const targetMobile = mobileSession(LOCAL_AL);
    const accountBefore = accountSecuritySnapshot(LOCAL_AL);
    const scopesBefore = portalScopeSnapshot(LOCAL_AL);
    const auditBefore = auditRowCount();
    const result = await withPermissionRevokedAtNextPersonnelTransaction(
      hr,
      HR,
      PERSONNEL_LEARNING_PERMISSIONS.DELEGATE,
      () => request(route.route, {
        method: route.method,
        auth: hr,
        ...(route.body === undefined ? {} : { body: route.body }),
      }),
    );
    assert.equal(result.response.status, 200, `${route.route}: ${JSON.stringify(result.payload)}`);
    assertLearningRightsHiddenInPortalUsers(result.payload);
    assert.deepEqual(accountSecuritySnapshot(LOCAL_AL), accountBefore);
    assert.deepEqual(portalScopeSnapshot(LOCAL_AL), scopesBefore);
    assert.equal(auditRowCount(), auditBefore);
    assertSessionNotRevoked(targetPortal, targetMobile);
  }
});

test("eigene Demotion oder Deaktivierung projiziert die Zugangsantwort sofort fail-closed", async () => {
  resetLearningDenials();
  const restoreAdmin = () => db.prepare(`
    UPDATE portal_users
    SET role = 'admin', active = 1, must_change_password = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ?
  `).run(ADMIN);

  for (const body of [
    { role: "employee", active: true, mustChangePassword: false },
    { role: "admin", active: false, mustChangePassword: false },
  ]) {
    restoreAdmin();
    const auditBefore = auditRowCount();
    const result = await request(`/api/portal/v1/users/${ADMIN}`, {
      method: "PUT",
      auth: session(ADMIN),
      body,
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.deepEqual(result.payload.users, []);
    assert.deepEqual(result.payload.roles, []);
    assert.equal(db.prepare(`
      SELECT role FROM portal_users WHERE employee_number = ?
    `).get(ADMIN).role, body.role);
    assert.equal(Number(db.prepare(`
      SELECT active FROM portal_users WHERE employee_number = ?
    `).get(ADMIN).active), Number(body.active));
    assert.equal(auditRowCount(), auditBefore + 1);
  }
  restoreAdmin();
});

test("Learning-Scope-Deltas sind auf beiden Routen fachlich gegatet und atomar", async () => {
  resetLearningDenials();
  const originalScopes = portalScopeSnapshot(LOCAL_AL);
  const changedScopes = [
    ...originalScopes,
    { locationId: local.locationId, departmentId: localAlternateDepartmentId },
  ];
  const dedicatedRoute = `/api/portal/v1/users/${LOCAL_AL}/scopes`;
  const rightsRoute = `/api/portal/v1/rights/${LOCAL_AL}`;
  const dedicatedBody = { scopes: changedScopes };
  const rightsMutationBody = {
    grantedPermissions: [],
    deniedPermissions: [],
    scopes: changedScopes,
  };

  const itAdmin = session(IT_ADMIN);
  await assertScopeMutationDenied({
    auth: itAdmin,
    route: dedicatedRoute,
    body: dedicatedBody,
    expectedCode: "PERSONNEL_LIFECYCLE_ACCOUNT_TAKEOVER_DENIED",
    expectedAuditDelta: 1,
  });
  await assertScopeMutationDenied({
    auth: itAdmin,
    route: rightsRoute,
    body: rightsMutationBody,
  });

  for (const actorEmployeeNumber of [ADMIN, HR]) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, ?, ?)
    `).run(actorEmployeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE, "learning-scope-test");
    try {
      const auth = session(actorEmployeeNumber);
      await assertScopeMutationDenied({
        auth,
        route: dedicatedRoute,
        body: dedicatedBody,
      });
      await assertScopeMutationDenied({
        auth,
        route: rightsRoute,
        body: rightsMutationBody,
      });
    } finally {
      db.prepare(`
        DELETE FROM portal_permission_denials
        WHERE employee_number = ? AND permission = ?
      `).run(actorEmployeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
    }
  }

  const managerTarget = {
    employeeNumber: MANAGER,
    role: "manager",
    locationId: local.locationId,
    departmentId: null,
  };
  const hr = session(HR);
  const managerDenial = await plPlusLearningDenial(hr, managerTarget, true);
  assert.equal(managerDenial.response.status, 200, JSON.stringify(managerDenial.payload));
  await assertScopeMutationDenied({
    auth: session(MANAGER),
    route: dedicatedRoute,
    body: dedicatedBody,
  });
  resetLearningDenials();

  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(MANAGER);
  try {
    await assertScopeMutationDenied({
      auth: session(MANAGER),
      route: dedicatedRoute,
      body: dedicatedBody,
    });
  } finally {
    db.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, 0, ?)
    `).run(MANAGER, local.locationId, HR);
  }

  const dedicatedNoOpPortalSession = session(LOCAL_AL);
  const dedicatedNoOpMobileSession = mobileSession(LOCAL_AL);
  const dedicatedNoOpAuditBefore = auditRowCount();
  const unchangedTechnicalSave = await request(dedicatedRoute, {
    method: "PUT",
    auth: itAdmin,
    body: { scopes: originalScopes },
  });
  assert.equal(unchangedTechnicalSave.response.status, 200,
    JSON.stringify(unchangedTechnicalSave.payload));
  assert.deepEqual(portalScopeSnapshot(LOCAL_AL), originalScopes);
  assert.equal(auditRowCount(), dedicatedNoOpAuditBefore);
  assert.equal(db.prepare(
    "SELECT revoked_at FROM portal_sessions WHERE id = ?",
  ).get(dedicatedNoOpPortalSession.id).revoked_at, null);
  const dedicatedNoOpMobile = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
  `).get(dedicatedNoOpMobileSession);
  assert.equal(dedicatedNoOpMobile.revoked_at, null);
  assert.equal(dedicatedNoOpMobile.revoked_reason, "");

  const rightsNoOpPortalSession = session(LOCAL_AL);
  const rightsNoOpMobileSession = mobileSession(LOCAL_AL);
  const rightsNoOpAuditBefore = auditRowCount();
  const unchangedRightsSave = await request(rightsRoute, {
    method: "PUT",
    auth: itAdmin,
    body: {
      grantedPermissions: [],
      deniedPermissions: [],
      scopes: originalScopes,
    },
  });
  assert.equal(unchangedRightsSave.response.status, 200,
    JSON.stringify(unchangedRightsSave.payload));
  assert.deepEqual(portalScopeSnapshot(LOCAL_AL), originalScopes);
  assert.equal(auditRowCount(), rightsNoOpAuditBefore);
  assert.equal(db.prepare(
    "SELECT revoked_at FROM portal_sessions WHERE id = ?",
  ).get(rightsNoOpPortalSession.id).revoked_at, null);
  const rightsNoOpMobile = db.prepare(`
    SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
  `).get(rightsNoOpMobileSession);
  assert.equal(rightsNoOpMobile.revoked_at, null);
  assert.equal(rightsNoOpMobile.revoked_reason, "");

  for (const positive of [
    { auth: session(DEVELOPER), route: rightsRoute, body: rightsMutationBody },
    { auth: session(HR), route: rightsRoute, body: rightsMutationBody },
    { auth: session(DEVELOPER), route: dedicatedRoute, body: dedicatedBody },
    { auth: session(HR), route: dedicatedRoute, body: dedicatedBody },
    { auth: session(MANAGER), route: dedicatedRoute, body: dedicatedBody },
  ]) {
    replacePortalScopes(LOCAL_AL, originalScopes);
    const allowed = await request(positive.route, {
      method: "PUT",
      auth: positive.auth,
      body: positive.body,
    });
    assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
    assert.deepEqual(portalScopeSnapshot(LOCAL_AL), changedScopes);
  }
  replacePortalScopes(LOCAL_AL, originalScopes);
});

test("Learning-Scope-Deltas prüfen Akteursrechte und explizite FL-Scopes live erneut", async () => {
  resetLearningDenials();
  const originalScopes = portalScopeSnapshot(LOCAL_AL);
  const changedScopes = [
    ...originalScopes,
    { locationId: local.locationId, departmentId: localAlternateDepartmentId },
  ];
  const mutations = [
    {
      route: `/api/portal/v1/users/${LOCAL_AL}/scopes`,
      body: { scopes: changedScopes },
    },
    {
      route: `/api/portal/v1/rights/${LOCAL_AL}`,
      body: {
        grantedPermissions: [],
        deniedPermissions: [],
        scopes: changedScopes,
      },
    },
  ];

  for (const actorEmployeeNumber of [ADMIN, HR]) {
    for (const mutation of mutations) {
      replacePortalScopes(LOCAL_AL, originalScopes);
      const auth = session(actorEmployeeNumber);
      const dropTrigger = installSessionTouchRaceMutation(auth, `
        INSERT OR IGNORE INTO portal_permission_denials
          (employee_number, permission, denied_by)
        VALUES (
          ${sqliteText(actorEmployeeNumber)},
          ${sqliteText(PERSONNEL_LEARNING_PERMISSIONS.DELEGATE)},
          'learning-live-race-test'
        );
      `);
      try {
        await assertScopeMutationDenied({ auth, ...mutation });
      } finally {
        dropTrigger();
        db.prepare(`
          DELETE FROM portal_permission_denials
          WHERE employee_number = ? AND permission = ?
        `).run(actorEmployeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
      }
    }
  }

  replacePortalScopes(LOCAL_AL, originalScopes);
  let manager = session(MANAGER);
  let dropTrigger = installSessionTouchRaceMutation(manager, `
    INSERT OR IGNORE INTO portal_permission_denials
      (employee_number, permission, denied_by)
    VALUES (${sqliteText(MANAGER)}, ${sqliteText(CROSS_PERMISSION)}, 'learning-live-race-test');
  `);
  try {
    await assertScopeMutationDenied({
      auth: manager,
      route: mutations[0].route,
      body: mutations[0].body,
    });
  } finally {
    dropTrigger();
    db.prepare(`
      DELETE FROM portal_permission_denials
      WHERE employee_number = ? AND permission = ?
    `).run(MANAGER, CROSS_PERMISSION);
  }

  replacePortalScopes(LOCAL_AL, originalScopes);
  manager = session(MANAGER);
  dropTrigger = installSessionTouchRaceMutation(manager, `
    DELETE FROM portal_access_scopes
    WHERE employee_number = ${sqliteText(MANAGER)};
  `);
  try {
    await assertScopeMutationDenied({
      auth: manager,
      route: mutations[0].route,
      body: mutations[0].body,
    });
  } finally {
    dropTrigger();
    replacePortalScopes(MANAGER, [{ locationId: local.locationId, departmentId: null }]);
  }

  replacePortalScopes(LOCAL_AL, originalScopes);
});

test("AL kann den Learning-Scope nicht ueber Abteilungsanlage automatisch erweitern", async () => {
  resetLearningDenials();
  replacePortalScopes(LOCAL_AL, [{
    locationId: local.locationId,
    departmentId: null,
  }]);
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'departments:write', ?)
  `).run(LOCAL_AL, HR);
  const scopesBefore = portalScopeSnapshot(LOCAL_AL);
  assert.deepEqual(scopesBefore, [{
    locationId: local.locationId,
    departmentId: null,
  }]);
  const departmentsBefore = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM departments WHERE location_id = ?
  `).get(local.locationId).count);
  const auditBefore = auditRowCount();
  try {
    const auth = session(LOCAL_AL);
    const sessionProjection = await request("/api/portal/v1/session", { auth });
    assert.equal(sessionProjection.response.status, 200, JSON.stringify(sessionProjection.payload));
    assert.equal(sessionProjection.payload.user.role, "department_manager");
    assert.deepEqual(sessionProjection.payload.user.scopes, scopesBefore);
    const denied = await request("/api/departments", {
      method: "POST",
      auth,
      body: {
        locationId: local.locationId,
        name: `Learning Auto-Scope ${crypto.randomUUID()}`,
        minStaff: 0,
        active: true,
      },
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED",
      JSON.stringify(denied.payload));
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) AS count FROM departments WHERE location_id = ?
    `).get(local.locationId).count), departmentsBefore);
    assert.deepEqual(portalScopeSnapshot(LOCAL_AL), scopesBefore);
    assert.equal(auditRowCount(), auditBefore);
  } finally {
    db.prepare(`
      DELETE FROM portal_permission_grants
      WHERE employee_number = ? AND permission = 'departments:write'
    `).run(LOCAL_AL);
  }
});

test("Filialaktivierung ändert alle tatsächlichen Learning-Scope-Ziele atomar", async () => {
  resetLearningDenials();
  db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(local.locationId);
  db.prepare("UPDATE departments SET active = 1 WHERE id = ?")
    .run(local.departmentId);
  replacePortalScopes(MANAGER, [{ locationId: local.locationId, departmentId: null }]);
  replacePortalScopes(LOCAL_AL, [{
    locationId: local.locationId,
    departmentId: local.departmentId,
  }]);
  replacePortalScopes(LOCAL_AL_TWO, [{
    locationId: local.locationId,
    departmentId: local.departmentId,
  }]);
  replacePortalScopes(FOREIGN_AL, [{
    locationId: foreign.locationId,
    departmentId: foreign.departmentId,
  }]);

  const targetSessions = new Map([
    [MANAGER, { portal: session(MANAGER), mobile: mobileSession(MANAGER) }],
    [LOCAL_AL, { portal: session(LOCAL_AL), mobile: mobileSession(LOCAL_AL) }],
    [LOCAL_AL_TWO, { portal: session(LOCAL_AL_TWO), mobile: mobileSession(LOCAL_AL_TWO) }],
    [FOREIGN_AL, { portal: session(FOREIGN_AL), mobile: mobileSession(FOREIGN_AL) }],
  ]);
  const auditBefore = Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_log").get().id);
  const result = await request(`/api/locations/${local.locationId}`, {
    method: "PUT",
    auth: session(HR),
    body: locationUpdateBody(local.locationId, { active: false }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(Number(db.prepare("SELECT active FROM locations WHERE id = ?")
    .get(local.locationId).active), 0);
  for (const employeeNumber of [MANAGER, LOCAL_AL, LOCAL_AL_TWO]) {
    const target = targetSessions.get(employeeNumber);
    assertSessionRevoked(target.portal, target.mobile);
  }
  assertSessionNotRevoked(
    targetSessions.get(FOREIGN_AL).portal,
    targetSessions.get(FOREIGN_AL).mobile,
  );
  const topologyAudits = db.prepare(`
    SELECT entity_id, detail
    FROM audit_log
    WHERE id > ?
      AND action = 'personnel.learning.organization-scope.update'
      AND entity_type = 'portal_user'
    ORDER BY entity_id
  `).all(auditBefore);
  const auditedTargets = new Set(topologyAudits.map((row) => String(row.entity_id)));
  for (const employeeNumber of [MANAGER, LOCAL_AL, LOCAL_AL_TWO]) {
    assert.equal(auditedTargets.has(employeeNumber), true, employeeNumber);
  }
  assert.equal(auditedTargets.has(FOREIGN_AL), false);
  for (const row of topologyAudits) {
    const detail = JSON.parse(row.detail);
    assert.equal(detail.sourceType, "location");
    assert.equal(detail.sourceId, local.locationId);
    assert.ok(detail.scopeBefore);
    assert.equal(detail.scopeAfter, null);
  }

  const restored = await request(`/api/locations/${local.locationId}`, {
    method: "PUT",
    auth: session(HR),
    body: locationUpdateBody(local.locationId, { active: true }),
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
  assert.equal(Number(db.prepare("SELECT active FROM locations WHERE id = ?")
    .get(local.locationId).active), 1);
});

test("Location-Topologiedeltas beachten Rollenmatrix und lassen No-ops nebenwirkungsfrei", async () => {
  resetLearningDenials();
  db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(local.locationId);
  const assertDenied = async (employeeNumber) => {
    const targetPortalSession = session(LOCAL_AL);
    const targetMobileSession = mobileSession(LOCAL_AL);
    const auditBefore = auditRowCount();
    const denied = await request(`/api/locations/${local.locationId}`, {
      method: "PUT",
      auth: session(employeeNumber),
      body: locationUpdateBody(local.locationId, { active: false }),
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED", JSON.stringify(denied.payload));
    assert.equal(Number(db.prepare("SELECT active FROM locations WHERE id = ?")
      .get(local.locationId).active), 1);
    assert.equal(auditRowCount(), auditBefore);
    assertSessionNotRevoked(targetPortalSession, targetMobileSession);
  };

  for (const employeeNumber of [ADMIN, HR]) {
    db.prepare(`
      INSERT INTO portal_permission_denials (employee_number, permission, denied_by)
      VALUES (?, ?, 'learning-topology-test')
    `).run(employeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
    try {
      await assertDenied(employeeNumber);
    } finally {
      db.prepare(`
        DELETE FROM portal_permission_denials
        WHERE employee_number = ? AND permission = ?
      `).run(employeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
    }
  }

  for (const employeeNumber of [IT_ADMIN, MANAGER, LOCAL_AL]) {
    grantPortalPermission(employeeNumber, "locations:write");
    try {
      await assertDenied(employeeNumber);
    } finally {
      revokePortalPermissionGrant(employeeNumber, "locations:write");
    }
  }

  grantPortalPermission(IT_ADMIN, "locations:write");
  try {
    const targetPortalSession = session(LOCAL_AL);
    const targetMobileSession = mobileSession(LOCAL_AL);
    const auditBefore = auditRowCount();
    const unchanged = await request(`/api/locations/${local.locationId}`, {
      method: "PUT",
      auth: session(IT_ADMIN),
      body: locationUpdateBody(local.locationId),
    });
    assert.equal(unchanged.response.status, 200, JSON.stringify(unchanged.payload));
    assert.equal(auditRowCount(), auditBefore);
    assertSessionNotRevoked(targetPortalSession, targetMobileSession);
  } finally {
    revokePortalPermissionGrant(IT_ADMIN, "locations:write");
  }
});

test("Abteilungsaktivierung widerruft nur betroffene AL-Sitzungen und erlaubt die eigene FL", async () => {
  resetLearningDenials();
  db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(local.locationId);
  db.prepare("UPDATE departments SET active = 1 WHERE id = ?").run(local.departmentId);
  replacePortalScopes(MANAGER, [{ locationId: local.locationId, departmentId: null }]);
  replacePortalScopes(LOCAL_AL, [{
    locationId: local.locationId,
    departmentId: local.departmentId,
  }]);
  replacePortalScopes(LOCAL_AL_TWO, [{
    locationId: local.locationId,
    departmentId: local.departmentId,
  }]);
  const localTargets = new Map([
    [LOCAL_AL, { portal: session(LOCAL_AL), mobile: mobileSession(LOCAL_AL) }],
    [LOCAL_AL_TWO, { portal: session(LOCAL_AL_TWO), mobile: mobileSession(LOCAL_AL_TWO) }],
  ]);
  const managerTarget = { portal: session(MANAGER), mobile: mobileSession(MANAGER) };
  const foreignTarget = { portal: session(FOREIGN_AL), mobile: mobileSession(FOREIGN_AL) };
  const result = await request(`/api/departments/${local.departmentId}`, {
    method: "PUT",
    auth: session(HR),
    body: departmentUpdateBody(local.departmentId, { active: false }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(Number(db.prepare("SELECT active FROM departments WHERE id = ?")
    .get(local.departmentId).active), 0);
  for (const target of localTargets.values()) assertSessionRevoked(target.portal, target.mobile);
  assertSessionNotRevoked(managerTarget.portal, managerTarget.mobile);
  assertSessionNotRevoked(foreignTarget.portal, foreignTarget.mobile);

  grantPortalPermission(MANAGER, "departments:write");
  try {
    const restoredTargets = [
      { portal: session(LOCAL_AL), mobile: mobileSession(LOCAL_AL) },
      { portal: session(LOCAL_AL_TWO), mobile: mobileSession(LOCAL_AL_TWO) },
    ];
    const restored = await request(`/api/departments/${local.departmentId}`, {
      method: "PUT",
      auth: session(MANAGER),
      body: departmentUpdateBody(local.departmentId, { active: true }),
    });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.payload));
    assert.equal(Number(db.prepare("SELECT active FROM departments WHERE id = ?")
      .get(local.departmentId).active), 1);
    for (const target of restoredTargets) assertSessionRevoked(target.portal, target.mobile);
  } finally {
    revokePortalPermissionGrant(MANAGER, "departments:write");
  }
});

test("Abteilungs-Topologiedeltas prüfen Live-Rechte und No-ops fail-closed", async () => {
  resetLearningDenials();
  db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(local.locationId);
  db.prepare("UPDATE departments SET active = 1 WHERE id = ?").run(local.departmentId);

  grantPortalPermission(IT_ADMIN, "departments:write");
  try {
    const targetPortalSession = session(LOCAL_AL);
    const targetMobileSession = mobileSession(LOCAL_AL);
    const auditBefore = auditRowCount();
    const denied = await request(`/api/departments/${local.departmentId}`, {
      method: "PUT",
      auth: session(IT_ADMIN),
      body: departmentUpdateBody(local.departmentId, { active: false }),
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
    assert.equal(auditRowCount(), auditBefore);
    assertSessionNotRevoked(targetPortalSession, targetMobileSession);

    const noOpAuditBefore = auditRowCount();
    const unchanged = await request(`/api/departments/${local.departmentId}`, {
      method: "PUT",
      auth: session(IT_ADMIN),
      body: departmentUpdateBody(local.departmentId),
    });
    assert.equal(unchanged.response.status, 200, JSON.stringify(unchanged.payload));
    assert.equal(auditRowCount(), noOpAuditBefore);
    assertSessionNotRevoked(targetPortalSession, targetMobileSession);
  } finally {
    revokePortalPermissionGrant(IT_ADMIN, "departments:write");
  }

  replacePortalScopes(LOCAL_AL, [{
    locationId: local.locationId,
    departmentId: local.departmentId,
  }]);
  grantPortalPermission(LOCAL_AL, "departments:write");
  try {
    const denied = await request(`/api/departments/${local.departmentId}`, {
      method: "PUT",
      auth: session(LOCAL_AL),
      body: departmentUpdateBody(local.departmentId, {
        departmentId: local.departmentId,
        active: false,
      }),
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED", JSON.stringify(denied.payload));
  } finally {
    revokePortalPermissionGrant(LOCAL_AL, "departments:write");
  }

  for (const actorEmployeeNumber of [ADMIN, HR]) {
    const auth = session(actorEmployeeNumber);
    const targetPortalSession = session(LOCAL_AL);
    const targetMobileSession = mobileSession(LOCAL_AL);
    const auditBefore = auditRowCount();
    const dropTrigger = installSessionTouchRaceMutation(auth, `
      INSERT OR IGNORE INTO portal_permission_denials
        (employee_number, permission, denied_by)
      VALUES (
        ${sqliteText(actorEmployeeNumber)},
        ${sqliteText(PERSONNEL_LEARNING_PERMISSIONS.DELEGATE)},
        'learning-topology-race-test'
      );
    `);
    try {
      const denied = await request(`/api/departments/${local.departmentId}`, {
        method: "PUT",
        auth,
        body: departmentUpdateBody(local.departmentId, { active: false }),
      });
      assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
      assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
      assert.equal(Number(db.prepare("SELECT active FROM departments WHERE id = ?")
        .get(local.departmentId).active), 1);
      assert.equal(auditRowCount(), auditBefore);
      assertSessionNotRevoked(targetPortalSession, targetMobileSession);
    } finally {
      dropTrigger();
      db.prepare(`
        DELETE FROM portal_permission_denials
        WHERE employee_number = ? AND permission = ?
      `).run(actorEmployeeNumber, PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
    }
  }

  grantPortalPermission(MANAGER, "departments:write");
  try {
    for (const raceStatement of [
      `INSERT OR IGNORE INTO portal_permission_denials
        (employee_number, permission, denied_by)
       VALUES (${sqliteText(MANAGER)}, ${sqliteText(CROSS_PERMISSION)}, 'learning-topology-race-test');`,
      `DELETE FROM portal_access_scopes
       WHERE employee_number = ${sqliteText(MANAGER)};`,
    ]) {
      replacePortalScopes(MANAGER, [{ locationId: local.locationId, departmentId: null }]);
      const auth = session(MANAGER);
      const targetPortalSession = session(LOCAL_AL);
      const targetMobileSession = mobileSession(LOCAL_AL);
      const auditBefore = auditRowCount();
      const dropTrigger = installSessionTouchRaceMutation(auth, raceStatement);
      try {
        const denied = await request(`/api/departments/${local.departmentId}`, {
          method: "PUT",
          auth,
          body: departmentUpdateBody(local.departmentId, { active: false }),
        });
        assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
        assert.equal(Number(db.prepare("SELECT active FROM departments WHERE id = ?")
          .get(local.departmentId).active), 1);
        assert.equal(auditRowCount(), auditBefore);
        assertSessionNotRevoked(targetPortalSession, targetMobileSession);
      } finally {
        dropTrigger();
        db.prepare(`
          DELETE FROM portal_permission_denials
          WHERE employee_number = ? AND permission = ?
        `).run(MANAGER, CROSS_PERMISSION);
        replacePortalScopes(MANAGER, [{ locationId: local.locationId, departmentId: null }]);
      }
    }
  } finally {
    revokePortalPermissionGrant(MANAGER, "departments:write");
  }
});

test("Learning-Topologiemutation rollt Ressource, Sitzungen und Audits gemeinsam zurück", async () => {
  resetLearningDenials();
  db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(local.locationId);
  db.prepare("UPDATE departments SET active = 1 WHERE id = ?").run(local.departmentId);
  const targetPortalSession = session(LOCAL_AL);
  const targetMobileSession = mobileSession(LOCAL_AL);
  const auditBefore = auditRowCount();
  db.exec(`
    CREATE TRIGGER test_personnel_learning_topology_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'personnel.learning.organization-scope.update'
    BEGIN
      SELECT RAISE(ABORT, 'test learning topology audit abort');
    END;
  `);
  try {
    const failed = await request(`/api/departments/${local.departmentId}`, {
      method: "PUT",
      auth: session(DEVELOPER),
      body: departmentUpdateBody(local.departmentId, { active: false }),
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.equal(Number(db.prepare("SELECT active FROM departments WHERE id = ?")
      .get(local.departmentId).active), 1);
    assert.equal(auditRowCount(), auditBefore);
    assertSessionNotRevoked(targetPortalSession, targetMobileSession);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_personnel_learning_topology_audit_abort");
  }
});

test("Abteilungsverschiebung meldet Mitarbeiter- und Scope-Referenzen fachlich", async () => {
  resetLearningDenials();
  db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(local.locationId);
  let destinationLocationId = "";
  for (let candidate = 99; candidate >= 10; candidate -= 1) {
    const id = String(candidate).padStart(2, "0");
    if (!db.prepare("SELECT 1 FROM locations WHERE id = ?").get(id)) {
      destinationLocationId = id;
      break;
    }
  }
  assert.ok(destinationLocationId, "Kein freier zweistelliger Teststandort");
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, active)
    VALUES (?, ?, 0, 1)
  `).run(destinationLocationId, `Learning Move ${destinationLocationId}`);
  const temporaryDepartmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, ?, 0, 1, 9299)
    RETURNING id
  `).get(local.locationId, `Learning Move ${crypto.randomUUID()}`).id);
  const referencedDepartmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, ?, 0, 1, 9298)
    RETURNING id
  `).get(local.locationId, `Learning Referenced ${crypto.randomUUID()}`).id);
  insertDepartmentScopedLearningVersion(referencedDepartmentId, local.locationId);
  const route = `/api/departments/${temporaryDepartmentId}`;
  const auth = session(HR);
  const unaffectedPortalSession = session(LOCAL_AL);
  const unaffectedMobileSession = mobileSession(LOCAL_AL);
  try {
    const learningReferenceAuditBefore = auditRowCount();
    const learningReferenceConflict = await request(
      `/api/departments/${referencedDepartmentId}`,
      {
        method: "PUT",
        auth,
        body: departmentUpdateBody(referencedDepartmentId, {
          locationId: destinationLocationId,
        }),
      },
    );
    assert.equal(
      learningReferenceConflict.response.status,
      409,
      JSON.stringify(learningReferenceConflict.payload),
    );
    assert.equal(
      learningReferenceConflict.payload.code,
      "DEPARTMENT_LEARNING_SCOPE_REFERENCE_CONFLICT",
    );
    assert.equal(
      db.prepare("SELECT location_id FROM departments WHERE id = ?")
        .get(referencedDepartmentId).location_id,
      local.locationId,
    );
    assertSessionNotRevoked(unaffectedPortalSession, unaffectedMobileSession);
    assert.equal(auditRowCount(), learningReferenceAuditBefore);

    db.prepare(`
      UPDATE employees SET preferred_department_id = ?
      WHERE personnel_number = ?
    `).run(temporaryDepartmentId, UNCONFIGURED);
    const employeeConflict = await request(route, {
      method: "PUT",
      auth,
      body: departmentUpdateBody(temporaryDepartmentId, {
        locationId: destinationLocationId,
      }),
    });
    assert.equal(employeeConflict.response.status, 409, JSON.stringify(employeeConflict.payload));
    assert.equal(employeeConflict.payload.code, "DEPARTMENT_EMPLOYEE_REFERENCE_CONFLICT");
    assert.equal(db.prepare("SELECT location_id FROM departments WHERE id = ?")
      .get(temporaryDepartmentId).location_id, local.locationId);

    db.prepare(`
      UPDATE employees SET preferred_department_id = NULL
      WHERE personnel_number = ?
    `).run(UNCONFIGURED);
    db.prepare(`
      INSERT INTO portal_access_scopes
        (employee_number, location_id, department_id, assigned_by)
      VALUES (?, ?, ?, ?)
    `).run(EMPLOYEE, local.locationId, temporaryDepartmentId, HR);
    const scopeConflict = await request(route, {
      method: "PUT",
      auth,
      body: departmentUpdateBody(temporaryDepartmentId, {
        locationId: destinationLocationId,
      }),
    });
    assert.equal(scopeConflict.response.status, 409, JSON.stringify(scopeConflict.payload));
    assert.equal(scopeConflict.payload.code, "DEPARTMENT_SCOPE_REFERENCE_CONFLICT");
    assert.equal(db.prepare("SELECT location_id FROM departments WHERE id = ?")
      .get(temporaryDepartmentId).location_id, local.locationId);

    db.prepare(`
      DELETE FROM portal_access_scopes
      WHERE employee_number = ? AND department_id = ?
    `).run(EMPLOYEE, temporaryDepartmentId);
    const moved = await request(route, {
      method: "PUT",
      auth,
      body: departmentUpdateBody(temporaryDepartmentId, {
        locationId: destinationLocationId,
      }),
    });
    assert.equal(moved.response.status, 200, JSON.stringify(moved.payload));
    assert.equal(db.prepare("SELECT location_id FROM departments WHERE id = ?")
      .get(temporaryDepartmentId).location_id, destinationLocationId);
    assertSessionNotRevoked(unaffectedPortalSession, unaffectedMobileSession);
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM audit_log
      WHERE action = 'personnel.learning.organization-scope.update'
        AND json_extract(detail, '$.sourceType') = 'department'
        AND json_extract(detail, '$.sourceId') = ?
    `).get(String(temporaryDepartmentId)).count), 0);
  } finally {
    db.prepare(`
      UPDATE employees SET preferred_department_id = NULL
      WHERE personnel_number = ?
    `).run(UNCONFIGURED);
    db.prepare(`
      DELETE FROM portal_access_scopes
      WHERE employee_number = ? AND department_id = ?
    `).run(EMPLOYEE, temporaryDepartmentId);
    db.prepare("DELETE FROM departments WHERE id = ?").run(temporaryDepartmentId);
  }
});

test("Denial, Provenienz, Sitzungswiderruf und Audit rollen bei Auditfehler gemeinsam zurück", async () => {
  resetLearningDenials();
  const manager = session(MANAGER);
  const targetPortalSession = session(LOCAL_AL_TWO);
  const targetMobileSession = mobileSession(LOCAL_AL_TWO);
  db.exec(`
    CREATE TRIGGER test_personnel_learning_audit_abort
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'personnel.learning.cross-location-right.update'
    BEGIN
      SELECT RAISE(ABORT, 'test learning audit abort');
    END;
  `);
  try {
    const failed = await request(
      `/api/portal/v1/personnel-learning/cross-location-delegates/${LOCAL_AL_TWO}`,
      { method: "PUT", auth: manager, body: { enabled: false, expectedRevision: "" } },
    );
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM portal_permission_denials
      WHERE employee_number = ? AND permission = ?
    `).get(LOCAL_AL_TWO, CROSS_PERMISSION).count, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM personnel_learning_permission_denial_authorities
      WHERE employee_number = ? AND permission = ?
    `).get(LOCAL_AL_TWO, CROSS_PERMISSION).count, 0);
    assert.equal(db.prepare(
      "SELECT revoked_at FROM portal_sessions WHERE id = ?",
    ).get(targetPortalSession.id).revoked_at, null);
    const mobile = db.prepare(`
      SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE id = ?
    `).get(targetMobileSession);
    assert.equal(mobile.revoked_at, null);
    assert.equal(mobile.revoked_reason, "");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_personnel_learning_audit_abort");
  }
});

test("jede wirksame Hierarchieänderung ist atomar und datensparsam auditiert", () => {
  const rows = db.prepare(`
    SELECT actor, action, entity_type, entity_id, detail
    FROM audit_log
    WHERE action = 'personnel.learning.cross-location-right.update'
    ORDER BY id
  `).all();
  assert.ok(rows.length >= 4);
  for (const row of rows) {
    assert.equal(row.entity_type, "portal_user");
    const detail = JSON.parse(row.detail);
    assert.equal(detail.permission, CROSS_PERMISSION);
    assert.equal(typeof detail.enabledBefore, "boolean");
    assert.equal(typeof detail.enabledAfter, "boolean");
    assert.equal(Object.hasOwn(detail, "title"), false);
    assert.equal(Object.hasOwn(detail, "fullName"), false);
  }
});
