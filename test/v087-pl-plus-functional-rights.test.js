"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v087-pl-rights-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db, releaseInstanceLockForTests } = require("../server");

const PLANNER = "275";
const HR = "v087-pl-hr";
const LOCAL_TARGET = "v087-pl-local";
const REMOTE_TARGET = "v087-pl-remote";
const FUNCTIONAL_GRANTS = Object.freeze([
  "amu:local:manage",
  "personnel:sensitive:read",
  "personnel:sensitive:write",
  "sickness:read",
  "work_rules:read",
]);
const PROTECTED_GRANTS = Object.freeze([
  "amu:metadata:read",
  "amu:file:read",
  "amu:review",
  "amu:delete",
  "amu:audit",
  "rights:write",
  "roles:write",
  "users:write",
  "system:diagnostics:technical",
  "system:offsite:configure",
  "backup:write",
  "update:write",
  "system:write",
  "developer:system",
]);

let httpServer;
let baseUrl;
let localFixture;
let remoteFixture;

function fixtureForLocation(row) {
  const position = db.prepare(`
    SELECT mapping.position_id AS id
    FROM cost_centers center
    JOIN cost_center_type_positions mapping
      ON mapping.cost_center_type_id = center.cost_center_type_id
    JOIN positions position ON position.id = mapping.position_id
    WHERE center.id = ?
    ORDER BY position.sort_order, position.id
    LIMIT 1
  `).get(row.cost_center_id);
  assert.ok(position?.id, `Keine zulässige Position für Kostenstelle ${row.cost_center_id}`);
  let department = db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1
    ORDER BY sort_order, id
    LIMIT 1
  `).get(row.id);
  if (!department) {
    department = db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, ?, 0, 1, 9087)
      RETURNING id
    `).get(row.id, `Block 3/8 ${row.id}`);
  }
  return {
    locationId: String(row.id),
    costCenterId: String(row.cost_center_id),
    departmentId: Number(department.id),
    positionId: String(position.id),
  };
}

function ensureEmployee(personnelNumber, fullName, fixture, level = "C") {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, position_id, time_confirmation_level,
       cost_center_id, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#2c7a68', 38.5, 5, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      position_id = excluded.position_id,
      time_confirmation_level = excluded.time_confirmation_level,
      cost_center_id = excluded.cost_center_id,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(
    personnelNumber,
    fullName,
    fullName.split(/\s+/)[0],
    fixture.positionId,
    level,
    fixture.costCenterId,
    fixture.locationId,
    fixture.departmentId,
  );
}

function ensurePortalUser(employeeNumber, role) {
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active,
       must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only',
      role = excluded.role,
      role_locked = 0,
      active = 1,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
}

function createSession(employeeNumber, role) {
  ensurePortalUser(employeeNumber, role);
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(id, employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    id,
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
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
  return { response, payload, text };
}

async function uploadAum(auth, date) {
  const form = new FormData();
  form.append("incapacityFrom", date);
  form.append("incapacityTo", "");
  form.append("ocrAssisted", "0");
  form.append("ocrConfirmed", "0");
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  form.append("documents", new Blob([onePixelPng], { type: "image/png" }), "aum-block-3.png");
  const response = await fetch(`${baseUrl}/api/portal/v1/me/amu-reports`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "X-CSRF-Token": auth.csrf,
      Accept: "application/json",
    },
    body: form,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

function rightsBody(grantedPermissions) {
  return {
    grantedPermissions,
    deniedPermissions: [],
    scopes: [{ locationId: localFixture.locationId, departmentId: null }],
  };
}

function storedPlannerGrants() {
  return db.prepare(`
    SELECT permission FROM portal_permission_grants
    WHERE employee_number = ?
    ORDER BY permission
  `).all(PLANNER).map((row) => row.permission);
}

function ensureSecondBranchLocation(firstLocation) {
  const existing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM locations location
    JOIN cost_centers center ON center.id = location.cost_center_id
    JOIN cost_center_types type ON type.id = center.cost_center_type_id
    WHERE location.active = 1 AND center.active = 1 AND type.is_branch = 1
  `).get().count;
  if (Number(existing) >= 2) return;

  let locationId = "";
  for (let value = 98; value >= 10; value -= 1) {
    const candidate = String(value);
    if (!db.prepare("SELECT 1 FROM locations WHERE id = ?").get(candidate)) {
      locationId = candidate;
      break;
    }
  }
  assert.ok(locationId, "Keine freie Test-Filialnummer");
  const costCenterId = "cc-v087-block3-remote";
  db.prepare(`
    INSERT INTO cost_centers
      (id, code, name, type, cost_center_type_id, description, active,
       sort_order, created_by, updated_by)
    VALUES (?, 'V087-B3-REMOTE', 'Block 3/8 Fremdfiliale', 'branch', 'branch',
      '', 1, 9087, 'block3-test', 'block3-test')
  `).run(costCenterId);
  db.prepare(`
    INSERT INTO locations
      (id, name, cost_center_id, min_staff, day_settings_json, active)
    VALUES (?, 'Block 3/8 Fremdfiliale', ?, 1, ?, 1)
  `).run(locationId, costCenterId, firstLocation.day_settings_json || "");
}

async function grantFunctionalRights(hr) {
  const result = await request(`/api/portal/v1/rights/${PLANNER}`, {
    method: "PUT",
    auth: hr,
    body: rightsBody(FUNCTIONAL_GRANTS),
  });
  assert.equal(result.response.status, 200, result.text);
  return result;
}

test.before(async () => {
  const firstLocation = db.prepare(`
    SELECT location.id, location.cost_center_id, location.day_settings_json
    FROM locations location
    JOIN cost_centers center ON center.id = location.cost_center_id
    JOIN cost_center_types type ON type.id = center.cost_center_type_id
    WHERE location.active = 1 AND center.active = 1 AND type.is_branch = 1
    ORDER BY location.id
    LIMIT 1
  `).get();
  assert.ok(firstLocation, "Der Integrationstest benötigt eine aktive Filialkostenstelle.");
  ensureSecondBranchLocation(firstLocation);
  const locations = db.prepare(`
    SELECT location.id, location.cost_center_id
    FROM locations location
    JOIN cost_centers center ON center.id = location.cost_center_id
    JOIN cost_center_types type ON type.id = center.cost_center_type_id
    WHERE location.active = 1 AND center.active = 1 AND type.is_branch = 1
    ORDER BY location.id
    LIMIT 2
  `).all();
  assert.equal(locations.length, 2, "Der Integrationstest benötigt zwei aktive Filialkostenstellen.");
  localFixture = fixtureForLocation(locations[0]);
  remoteFixture = fixtureForLocation(locations[1]);

  ensureEmployee(PLANNER, "Marie-Theres Schmidt", localFixture, "A");
  ensureEmployee(HR, "Helena Personalleitung", localFixture, "A");
  ensureEmployee(LOCAL_TARGET, "Lokale Testperson", localFixture);
  ensureEmployee(REMOTE_TARGET, "Fremde Testperson", remoteFixture);
  ensurePortalUser(PLANNER, "location_planner");
  ensurePortalUser(HR, "hr");
  ensurePortalUser(LOCAL_TARGET, "employee");
  ensurePortalUser(REMOTE_TARGET, "employee");

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(() => {
  db.prepare("DELETE FROM portal_sessions WHERE employee_number IN (?, ?, ?, ?)")
    .run(PLANNER, HR, LOCAL_TARGET, REMOTE_TARGET);
  db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ?").run(PLANNER);
  db.prepare("DELETE FROM portal_permission_denials WHERE employee_number = ?").run(PLANNER);
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(PLANNER);
  db.prepare(`
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(PLANNER, localFixture.locationId, HR);
  db.prepare("DELETE FROM amu_local_access_overrides WHERE employee_number = ?").run(PLANNER);
  db.prepare("DELETE FROM personnel_sensitive_records WHERE employee_number IN (?, ?)")
    .run(LOCAL_TARGET, REMOTE_TARGET);
  db.prepare(`
    DELETE FROM audit_log
    WHERE (actor = ? AND action = 'portal.rights.update')
       OR (entity_id = ? AND action = 'portal.rights.update')
  `).run(HR, PLANNER);
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.87 Block 3: 275 bleibt als Planungsverantwortung ohne neue Grundrechte", async () => {
  const role = db.prepare("SELECT permissions FROM portal_roles WHERE id = 'location_planner'").get();
  assert.ok(role);
  const basePermissions = JSON.parse(role.permissions);
  for (const permission of [...FUNCTIONAL_GRANTS, "rights:write"]) {
    assert.equal(basePermissions.includes(permission), false, `Unerwartetes Grundrecht: ${permission}`);
  }

  const planner = createSession(PLANNER, "location_planner");
  const session = await request("/api/portal/v1/session", { auth: planner });
  assert.equal(session.response.status, 200, session.text);
  assert.equal(session.payload.user.employeeNumber, PLANNER);
  assert.equal(session.payload.user.role, "location_planner");
  for (const permission of [...FUNCTIONAL_GRANTS, "rights:write"]) {
    assert.equal(session.payload.user.permissions.includes(permission), false, permission);
  }

  const hr = createSession(HR, "hr");
  const rights = await request("/api/portal/v1/rights", { auth: hr });
  assert.equal(rights.response.status, 200, rights.text);
  const target = rights.payload.users.find((user) => user.employeeNumber === PLANNER);
  assert.equal(target.role, "location_planner");
  assert.equal(target.manageable, true);
  for (const permissionId of FUNCTIONAL_GRANTS) {
    const permission = rights.payload.catalog.find((entry) => entry.id === permissionId);
    assert.ok(permission, permissionId);
    assert.equal(permission.editable, true, permissionId);
    if (Array.isArray(permission.eligibleRoles)) {
      assert.equal(permission.eligibleRoles.includes("location_planner"), true, permissionId);
    }
  }
  for (const permissionId of ["amu:metadata:read", "amu:file:read", "amu:review", "system:diagnostics:technical"]) {
    const permission = rights.payload.catalog.find((entry) => entry.id === permissionId);
    assert.ok(permission, permissionId);
    assert.equal(permission.editable, false, permissionId);
    assert.equal(permission.eligibleRoles.includes("location_planner"), false, permissionId);
  }
  assert.equal(rights.payload.catalog.some((entry) => entry.id === "developer:system"), false);
  assert.equal(rights.payload.catalog.some((entry) => entry.id === "rights:write"), false);
});

test("v0.87 Block 3: AUM-Fachrecht ohne Krankmeldungs-Leserecht wird atomar abgelehnt", async () => {
  const hr = createSession(HR, "hr");
  const planner = createSession(PLANNER, "location_planner");
  const withoutSicknessRead = FUNCTIONAL_GRANTS.filter((permission) => permission !== "sickness:read");
  const denied = await request(`/api/portal/v1/rights/${PLANNER}`, {
    method: "PUT",
    auth: hr,
    body: rightsBody(withoutSicknessRead),
  });
  assert.equal(denied.response.status, 400, denied.text);
  assert.equal(denied.payload.code, "PORTAL_PERMISSION_DEPENDENCY");
  assert.deepEqual(storedPlannerGrants(), []);
  assert.equal(
    db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?").get(planner.id).revoked_at,
    null,
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'portal.rights.update' AND entity_id = ?
  `).get(PLANNER).count, 0);
  assert.deepEqual(db.prepare(`
    SELECT location_id, department_id FROM portal_access_scopes
    WHERE employee_number = ?
  `).all(PLANNER).map((row) => ({
    locationId: String(row.location_id),
    departmentId: Number(row.department_id || 0) || null,
  })), [{ locationId: localFixture.locationId, departmentId: null }]);
});

test("v0.87 Block 3: PL vergibt 275 fachliche Rechte atomar und strikt im Standortscope", async () => {
  const hr = createSession(HR, "hr");
  for (const [employeeNumber, marker] of [
    [LOCAL_TARGET, "LOCAL-PERSONNEL-SECRET"],
    [REMOTE_TARGET, "REMOTE-PERSONNEL-SECRET"],
  ]) {
    const saved = await request(`/api/portal/v1/personnel-records/${employeeNumber}`, {
      method: "PUT",
      auth: hr,
      body: {
        sensitive: {
          identity: { firstName: marker },
          employment: { notes: `${marker}-NOTES` },
        },
      },
    });
    assert.equal(saved.response.status, 200, saved.text);
  }

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const localAum = await uploadAum(createSession(LOCAL_TARGET, "employee"), today);
  assert.equal(localAum.response.status, 201, localAum.text);
  const remoteAum = await uploadAum(createSession(REMOTE_TARGET, "employee"), today);
  assert.equal(remoteAum.response.status, 201, remoteAum.text);

  const oldPlannerSession = createSession(PLANNER, "location_planner");
  const granted = await grantFunctionalRights(hr);
  const target = granted.payload.users.find((user) => user.employeeNumber === PLANNER);
  assert.deepEqual(target.grantedPermissions, [...FUNCTIONAL_GRANTS].sort());
  for (const permission of FUNCTIONAL_GRANTS) {
    assert.equal(target.effectivePermissions.includes(permission), true, permission);
  }
  assert.deepEqual(storedPlannerGrants(), [...FUNCTIONAL_GRANTS].sort());
  assert.ok(db.prepare("SELECT revoked_at FROM portal_sessions WHERE id = ?").get(oldPlannerSession.id).revoked_at);

  const audit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE actor = ? AND action = 'portal.rights.update' AND entity_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(HR, PLANNER);
  assert.ok(audit);
  const auditDetail = JSON.parse(audit.detail);
  assert.deepEqual(auditDetail.before.grantedPermissions, []);
  assert.deepEqual(auditDetail.after.grantedPermissions, [...FUNCTIONAL_GRANTS].sort());
  assert.deepEqual(auditDetail.after.scopes, [{
    locationId: localFixture.locationId,
    departmentId: null,
  }]);

  const planner = createSession(PLANNER, "location_planner");
  const session = await request("/api/portal/v1/session", { auth: planner });
  assert.equal(session.response.status, 200, session.text);
  for (const permission of FUNCTIONAL_GRANTS) {
    assert.equal(session.payload.user.permissions.includes(permission), true, permission);
  }
  for (const permission of ["rights:write", "users:write", "roles:write", "system:diagnostics:technical"]) {
    assert.equal(session.payload.user.permissions.includes(permission), false, permission);
  }

  const dashboard = await request("/api/work-rules/dashboard", { auth: planner });
  assert.equal(dashboard.response.status, 200, dashboard.text);
  assert.equal(dashboard.payload.locations.some((location) => String(location.id) === localFixture.locationId), true);
  assert.equal(dashboard.payload.locations.some((location) => String(location.id) === remoteFixture.locationId), false);
  const foreignSimulation = await request("/api/work-rules/evaluate", {
    method: "POST",
    auth: planner,
    body: {
      targetType: "planned_schedule",
      preview: true,
      weekStart: "2034-07-03",
      locationId: remoteFixture.locationId,
    },
  });
  assert.equal(foreignSimulation.response.status, 403, foreignSimulation.text);

  const localRecord = await request(`/api/portal/v1/personnel-records/${LOCAL_TARGET}`, { auth: planner });
  assert.equal(localRecord.response.status, 200, localRecord.text);
  assert.equal(localRecord.payload.profile.sensitive.identity.firstName, "LOCAL-PERSONNEL-SECRET");
  assert.equal(localRecord.payload.access.canWriteSensitive, true);
  const localRecordWrite = await request(`/api/portal/v1/personnel-records/${LOCAL_TARGET}`, {
    method: "PUT",
    auth: planner,
    body: { sensitive: { employment: { notes: "LOCAL-UPDATED-BY-275" } } },
  });
  assert.equal(localRecordWrite.response.status, 200, localRecordWrite.text);
  const remoteRecord = await request(`/api/portal/v1/personnel-records/${REMOTE_TARGET}`, { auth: planner });
  assert.equal(remoteRecord.response.status, 403, remoteRecord.text);
  assert.equal(remoteRecord.payload.code, "PORTAL_SCOPE_DENIED");
  const remoteRecordWrite = await request(`/api/portal/v1/personnel-records/${REMOTE_TARGET}`, {
    method: "PUT",
    auth: planner,
    body: { sensitive: { employment: { notes: "REMOTE-BYPASS" } } },
  });
  assert.equal(remoteRecordWrite.response.status, 403, remoteRecordWrite.text);
  assert.equal(remoteRecordWrite.payload.code, "PORTAL_SCOPE_DENIED");

  const aumOverview = await request("/api/portal/v1/amu-reports", { auth: planner });
  assert.equal(aumOverview.response.status, 200, aumOverview.text);
  const localAumId = Number(localAum.payload.report.id);
  const remoteAumId = Number(remoteAum.payload.report.id);
  assert.equal(aumOverview.payload.reports.some((report) => Number(report.id) === localAumId), true);
  assert.equal(aumOverview.payload.reports.some((report) => Number(report.id) === remoteAumId), false);
  assert.equal(aumOverview.payload.canOpenFiles, true);
  assert.equal(aumOverview.payload.canReview, true);
  const localAumDetail = await request(`/api/portal/v1/amu-reports/${localAumId}`, { auth: planner });
  assert.equal(localAumDetail.response.status, 200, localAumDetail.text);
  const remoteAumDetail = await request(`/api/portal/v1/amu-reports/${remoteAumId}`, { auth: planner });
  assert.equal(remoteAumDetail.response.status, 404, remoteAumDetail.text);
  assert.equal(remoteAumDetail.payload.code, "AMU_REPORT_NOT_FOUND");

  const rightsRead = await request("/api/portal/v1/rights", { auth: planner });
  assert.equal(rightsRead.response.status, 403, rightsRead.text);
  const rightsWrite = await request(`/api/portal/v1/rights/${LOCAL_TARGET}`, {
    method: "PUT",
    auth: planner,
    body: { grantedPermissions: ["work_rules:read"], deniedPermissions: [], scopes: [] },
  });
  assert.equal(rightsWrite.response.status, 403, rightsWrite.text);
  assert.deepEqual(
    db.prepare("SELECT permission FROM portal_permission_grants WHERE employee_number = ?").all(LOCAL_TARGET),
    [],
  );
});

test("v0.87 Block 3: geschützte AUM- und technische Rechte bleiben für PL nicht delegierbar", async () => {
  const hr = createSession(HR, "hr");
  await grantFunctionalRights(hr);
  const before = storedPlannerGrants();
  const successfulAuditsBefore = db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'portal.rights.update' AND entity_id = ?
  `).get(PLANNER).count;

  const denied = await request(`/api/portal/v1/rights/${PLANNER}`, {
    method: "PUT",
    auth: hr,
    body: rightsBody([...FUNCTIONAL_GRANTS, ...PROTECTED_GRANTS]),
  });
  assert.equal(denied.response.status, 403, denied.text);
  assert.equal(denied.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");
  assert.deepEqual(storedPlannerGrants(), before);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'portal.rights.update' AND entity_id = ?
  `).get(PLANNER).count, successfulAuditsBefore);

  const planner = createSession(PLANNER, "location_planner");
  const session = await request("/api/portal/v1/session", { auth: planner });
  assert.equal(session.response.status, 200, session.text);
  for (const permission of PROTECTED_GRANTS) {
    assert.equal(session.payload.user.permissions.includes(permission), false, permission);
  }
});
