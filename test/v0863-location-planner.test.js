"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0863-location-planner-"));
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

const PLANNER = "9750";
const TARGET_A = "9751";
const TARGET_B = "9752";
const TARGET_REMOTE = "9753";
const LOCATION = "93";
const REMOTE_LOCATION = "94";

let httpServer;
let baseUrl;
let positionId;
let departmentA;
let departmentB;
let remoteDepartment;
let originalDaySettings;

function ensureEmployee(personnelNumber, locationId, departmentId, level = "C") {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       position_id, time_confirmation_level, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#2c7a68', 38.5, 5, ?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      color = excluded.color,
      contracted_hours = excluded.contracted_hours,
      target_workdays_per_week = excluded.target_workdays_per_week,
      position_id = excluded.position_id,
      time_confirmation_level = excluded.time_confirmation_level,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(
    personnelNumber,
    `Testperson ${personnelNumber}`,
    `T${personnelNumber}`,
    positionId,
    level,
    locationId,
    departmentId,
  );
}

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only',
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
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
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

test.before(async () => {
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  const template = db.prepare("SELECT day_settings_json FROM locations ORDER BY id LIMIT 1").get();
  originalDaySettings = JSON.parse(template?.day_settings_json || "{}");
  db.prepare(`
    INSERT OR REPLACE INTO locations
      (id, name, min_staff, day_settings_json, time_tracking_enabled, time_tracking_access_mode,
       time_tracking_allowed_networks, time_tracking_variance_minutes, active)
    VALUES (?, ?, 2, ?, 0, 'anywhere', '', 15, 1)
  `).run(LOCATION, "Eigener Teststandort", JSON.stringify(originalDaySettings));
  db.prepare(`
    INSERT OR REPLACE INTO locations
      (id, name, min_staff, day_settings_json, time_tracking_enabled, time_tracking_access_mode,
       time_tracking_allowed_networks, time_tracking_variance_minutes, active)
    VALUES (?, ?, 1, ?, 0, 'anywhere', '', 15, 1)
  `).run(REMOTE_LOCATION, "Fremder Teststandort", JSON.stringify(originalDaySettings));

  const insertDepartment = db.prepare(`
    INSERT OR IGNORE INTO departments (location_id, name, active, sort_order)
    VALUES (?, ?, 1, ?)
  `);
  insertDepartment.run(LOCATION, "Fotowelt", 1);
  insertDepartment.run(LOCATION, "Hardware", 2);
  insertDepartment.run(REMOTE_LOCATION, "Fremde Abteilung", 1);
  departmentA = db.prepare("SELECT id FROM departments WHERE location_id = ? AND name = 'Fotowelt'").get(LOCATION).id;
  departmentB = db.prepare("SELECT id FROM departments WHERE location_id = ? AND name = 'Hardware'").get(LOCATION).id;
  remoteDepartment = db.prepare("SELECT id FROM departments WHERE location_id = ? AND name = 'Fremde Abteilung'").get(REMOTE_LOCATION).id;

  ensureEmployee(PLANNER, LOCATION, departmentA, "A");
  ensureEmployee(TARGET_A, LOCATION, departmentA);
  ensureEmployee(TARGET_B, LOCATION, departmentB);
  ensureEmployee(TARGET_REMOTE, REMOTE_LOCATION, remoteDepartment);
  session(PLANNER, "location_planner");
  session(TARGET_A, "employee");
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(PLANNER);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, 'test')
  `).run(PLANNER, LOCATION);
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at)
    VALUES ('trust_levels_enabled', '1', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP
  `).run();
  db.prepare(`
    INSERT INTO vacation_entitlements (employee_number, year, days)
    VALUES (?, 2035, 25)
    ON CONFLICT(employee_number, year) DO UPDATE SET days = 25
  `).run(TARGET_A);

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

test("v0.86.3: Planungsverantwortung besitzt nur den vorgesehenen Planungsumfang", () => {
  const role = db.prepare("SELECT name, permissions FROM portal_roles WHERE id = 'location_planner'").get();
  assert.equal(role.name, "Planungsverantwortung");
  const permissions = new Set(JSON.parse(role.permissions));
  for (const required of [
    "employees:read",
    "employees:display:write",
    "employees:nickname:write",
    "schedule:read",
    "schedule:write",
    "absence_entries:write",
    "work_rules:planning:read",
    "personnel:phone:read",
    "personnel:phone:write",
    "locations:operational:write",
  ]) assert.ok(permissions.has(required), `Grundrecht fehlt: ${required}`);
  for (const forbidden of [
    "rights:read",
    "rights:write",
    "users:write",
    "settings:write",
    "locations:write",
    "employees:write",
    "work_rules:read",
    "system:diagnostics:read",
    "system:diagnostics:technical",
    "payroll:export",
    "sickness:read",
    "amu:local:manage",
    "own_vacation:read",
    "own_vacation:request",
    "vacation:read",
    "vacation:approve",
    "own_time:read",
    "own_time:write",
    "own_time:correction_request",
  ]) assert.equal(permissions.has(forbidden), false, `Unzulässiges Grundrecht: ${forbidden}`);
  assert.equal([...permissions].some((permission) => permission.startsWith("loans:")), false);
});

test("v0.86.3: Team- und Standortdaten bleiben auf die eigene Filiale begrenzt", async () => {
  const planner = session(PLANNER, "location_planner");
  const locations = await request("/api/locations", { auth: planner });
  assert.equal(locations.response.status, 200, locations.text);
  assert.deepEqual(locations.payload.map((location) => location.id), [LOCATION]);
  assert.deepEqual(
    locations.payload[0].departments.map((department) => department.name).sort(),
    ["Fotowelt", "Hardware"],
  );

  const employees = await request("/api/employees", { auth: planner });
  assert.equal(employees.response.status, 200, employees.text);
  const visible = new Set(employees.payload.map((employee) => employee.personnel_number));
  assert.ok(visible.has(PLANNER));
  assert.ok(visible.has(TARGET_A));
  assert.ok(visible.has(TARGET_B));
  assert.equal(visible.has(TARGET_REMOTE), false);
});

test("v0.86.3: Teamfarbe und Dienstplan-Spitzname sind schreibbar, Stammdaten nicht", async () => {
  const planner = session(PLANNER, "location_planner");
  const updated = await request(`/api/employees/${TARGET_A}/display`, {
    method: "PATCH",
    auth: planner,
    body: { color: "#336699", nickname: "Foto Test" },
  });
  assert.equal(updated.response.status, 200, updated.text);
  assert.equal(updated.payload.color, "#336699");
  assert.equal(updated.payload.nickname, "Foto Test");

  const stored = db.prepare("SELECT full_name, nickname, color FROM employees WHERE personnel_number = ?").get(TARGET_A);
  assert.equal(stored.full_name, `Testperson ${TARGET_A}`);
  assert.equal(stored.nickname, "Foto Test");
  assert.equal(stored.color, "#336699");

  const injected = await request(`/api/employees/${TARGET_A}/display`, {
    method: "PATCH",
    auth: planner,
    body: { color: "#112233", fullName: "Nicht erlaubt" },
  });
  assert.equal(injected.response.status, 200, injected.text);
  assert.equal(
    db.prepare("SELECT full_name FROM employees WHERE personnel_number = ?").get(TARGET_A).full_name,
    `Testperson ${TARGET_A}`,
  );

  const remote = await request(`/api/employees/${TARGET_REMOTE}/display`, {
    method: "PATCH",
    auth: planner,
    body: { nickname: "Nicht sichtbar" },
  });
  assert.equal(remote.response.status, 403, remote.text);
  assert.equal(remote.payload.code, "PORTAL_SCOPE_DENIED");
});

test("v0.86.3: Im Personalakt ist ausschließlich die Telefonnummer der eigenen Filiale verfügbar", async () => {
  const planner = session(PLANNER, "location_planner");
  const written = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT",
    auth: planner,
    body: { phone: "+43 512 555 9751" },
  });
  assert.equal(written.response.status, 200, written.text);
  assert.deepEqual(written.payload.changedFields, ["phone"]);

  const record = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: planner });
  assert.equal(record.response.status, 200, record.text);
  assert.equal(record.payload.profile.phone, "+43 512 555 9751");
  assert.equal(record.payload.profile.sensitive, null);
  assert.equal(record.payload.documents.length, 0);
  assert.equal(record.payload.reports.length, 0);
  assert.equal(record.payload.access.fieldAccess.phone, "write");
  for (const [field, access] of Object.entries(record.payload.access.fieldAccess)) {
    if (field !== "phone") assert.equal(access, "hidden", `${field} darf nicht sichtbar sein`);
  }

  const sensitive = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT",
    auth: planner,
    body: { sensitive: { identity: { birthDate: "1990-01-01" } } },
  });
  assert.equal(sensitive.response.status, 403, sensitive.text);
  assert.equal(sensitive.payload.code, "PERSONNEL_FIELD_WRITE_DENIED");

  const remote = await request(`/api/portal/v1/personnel-records/${TARGET_REMOTE}`, { auth: planner });
  assert.equal(remote.response.status, 403, remote.text);
  assert.equal(remote.payload.code, "PORTAL_SCOPE_DENIED");
});

test("v0.86.3: Eigene Öffnungszeiten und Mindestbesetzung sind editierbar, Verwaltungsfelder nicht", async () => {
  const planner = session(PLANNER, "location_planner");
  const daySettings = structuredClone(originalDaySettings);
  const firstDay = Object.keys(daySettings)[0];
  daySettings[firstDay] = { ...daySettings[firstDay], minStaff: Math.min(99, Number(daySettings[firstDay].minStaff || 0) + 1) };
  const before = db.prepare(`
    SELECT name, cost_center_id, time_tracking_enabled, active FROM locations WHERE id = ?
  `).get(LOCATION);

  const updated = await request(`/api/locations/${LOCATION}`, {
    method: "PUT",
    auth: planner,
    body: {
      id: LOCATION,
      name: "Manipulierter Name",
      minStaff: 7,
      daySettings,
      active: false,
      timeTrackingEnabled: true,
      timeTrackingAccessMode: "trusted_network",
      timeTrackingAllowedNetworks: "10.0.0.0/8",
      timeTrackingVarianceMinutes: 99,
      costCenterId: "nicht-freigegeben",
    },
  });
  assert.equal(updated.response.status, 200, updated.text);
  const stored = db.prepare(`
    SELECT name, min_staff, day_settings_json, cost_center_id, time_tracking_enabled,
           time_tracking_access_mode, time_tracking_allowed_networks, time_tracking_variance_minutes, active
    FROM locations WHERE id = ?
  `).get(LOCATION);
  assert.equal(stored.name, before.name);
  assert.equal(stored.min_staff, 7);
  assert.deepEqual(JSON.parse(stored.day_settings_json), daySettings);
  assert.equal(stored.cost_center_id, before.cost_center_id);
  assert.equal(stored.time_tracking_enabled, before.time_tracking_enabled);
  assert.equal(stored.time_tracking_access_mode, "anywhere");
  assert.equal(stored.time_tracking_allowed_networks, "");
  assert.equal(stored.time_tracking_variance_minutes, 15);
  assert.equal(stored.active, before.active);

  const remote = await request(`/api/locations/${REMOTE_LOCATION}`, {
    method: "PUT",
    auth: planner,
    body: { minStaff: 8, daySettings },
  });
  assert.equal(remote.response.status, 403, remote.text);
  assert.equal(remote.payload.code, "PORTAL_SCOPE_DENIED");

  const create = await request("/api/locations", {
    method: "POST",
    auth: planner,
    body: { id: "95", name: "Nicht erlaubt", minStaff: 1, daySettings, active: true },
  });
  assert.equal(create.response.status, 403, create.text);
  assert.equal(create.payload.code, "PORTAL_PERMISSION_DENIED");
});

test("v0.86.3: Arbeitszeitwarnungen sind im Plan sichtbar, Regel- und System-Dashboards bleiben gesperrt", async () => {
  const planner = session(PLANNER, "location_planner");
  const schedule = await request(`/api/schedule?week=2026-07-27&location=${LOCATION}`, { auth: planner });
  assert.equal(schedule.response.status, 200, schedule.text);
  assert.ok(schedule.payload.workRuleAssessment);

  const preview = await request("/api/work-rules/evaluate", {
    method: "POST",
    auth: planner,
    body: {
      targetType: "planned_schedule",
      preview: true,
      weekStart: "2026-07-27",
      locationId: LOCATION,
      departmentId: "",
    },
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.ok(Array.isArray(preview.payload.findings));

  for (const route of [
    "/api/work-rules/dashboard",
    "/api/portal/v1/rights-dashboard",
    "/api/server-diagnostics",
  ]) {
    const denied = await request(route, { auth: planner });
    assert.equal(denied.response.status, 403, `${route}: ${denied.text}`);
  }
});

test("v0.86.3: Bereits genehmigte Urlaube und ZA sind direkt planbar, Anträge bleiben vollständig gesperrt", async () => {
  const planner = session(PLANNER, "location_planner");
  const vacation = await request("/api/vacations", {
    method: "POST",
    auth: planner,
    body: {
      employeeNumber: TARGET_A,
      dateFrom: "2035-03-12",
      dateTo: "2035-03-13",
      note: "Bereits betrieblich genehmigt",
      locationId: LOCATION,
    },
  });
  assert.equal(vacation.response.status, 201, vacation.text);
  assert.ok(vacation.payload.groupId);

  const updatedVacation = await request(`/api/vacations/${encodeURIComponent(vacation.payload.groupId)}`, {
    method: "PUT",
    auth: planner,
    body: {
      employeeNumber: TARGET_A,
      dateFrom: "2035-03-12",
      dateTo: "2035-03-13",
      note: "Bereits genehmigt und korrigiert",
      locationId: LOCATION,
    },
  });
  assert.equal(updatedVacation.response.status, 200, updatedVacation.text);

  const timeOff = await request("/api/week-options", {
    method: "POST",
    auth: planner,
    body: {
      employeeNumber: TARGET_A,
      weekStart: "2035-03-12",
      dateFrom: "2035-03-14",
      dateTo: "2035-03-14",
      optionType: "time_off",
      allDay: true,
      note: "Vereinbarter ZA",
    },
  });
  assert.equal(timeOff.response.status, 201, timeOff.text);

  const updatedTimeOff = await request(`/api/week-options/${timeOff.payload.id}`, {
    method: "PUT",
    auth: planner,
    body: {
      employeeNumber: TARGET_A,
      weekStart: "2035-03-12",
      dateFrom: "2035-03-15",
      dateTo: "2035-03-15",
      optionType: "time_off",
      allDay: true,
      note: "Vereinbarter ZA verschoben",
    },
  });
  assert.equal(updatedTimeOff.response.status, 200, updatedTimeOff.text);

  const forbiddenType = await request("/api/week-options", {
    method: "POST",
    auth: planner,
    body: {
      employeeNumber: TARGET_A,
      weekStart: "2035-03-12",
      dateFrom: "2035-03-16",
      dateTo: "2035-03-16",
      optionType: "sick",
      allDay: true,
      note: "Nicht zulässig",
    },
  });
  assert.equal(forbiddenType.response.status, 403, forbiddenType.text);
  assert.equal(forbiddenType.payload.code, "APPROVED_ABSENCE_TYPE_DENIED");

  const remote = await request("/api/week-options", {
    method: "POST",
    auth: planner,
    body: {
      employeeNumber: TARGET_REMOTE,
      weekStart: "2035-03-12",
      dateFrom: "2035-03-16",
      dateTo: "2035-03-16",
      optionType: "time_off",
      allDay: true,
    },
  });
  assert.equal(remote.response.status, 403, remote.text);
  assert.equal(remote.payload.code, "PORTAL_SCOPE_DENIED");

  for (const deniedRequest of [
    await request("/api/portal/v1/absence-requests", { auth: planner }),
    await request("/api/portal/v1/me/vacation-requests", {
      method: "POST",
      auth: planner,
      body: { dateFrom: "2035-04-02", dateTo: "2035-04-03", note: "Nicht zulässig" },
    }),
  ]) {
    assert.equal(deniedRequest.response.status, 403, deniedRequest.text);
    assert.equal(deniedRequest.payload.code, "PORTAL_PERMISSION_DENIED");
  }

  const mobileLayout = await request("/api/portal/v1/mobile-layout", { auth: planner });
  assert.equal(mobileLayout.response.status, 200, mobileLayout.text);
  assert.deepEqual(mobileLayout.payload.modules, ["schedule", "more"]);

  const deletedTimeOff = await request(`/api/week-options/${timeOff.payload.id}`, {
    method: "DELETE",
    auth: planner,
  });
  assert.equal(deletedTimeOff.response.status, 204, deletedTimeOff.text);
  const deletedVacation = await request(`/api/vacations/${encodeURIComponent(vacation.payload.groupId)}`, {
    method: "DELETE",
    auth: planner,
  });
  assert.equal(deletedVacation.response.status, 204, deletedVacation.text);

  const auditActions = new Set(db.prepare(`
    SELECT action FROM audit_log
    WHERE actor = ? AND action LIKE 'approved-absence.%'
  `).all(PLANNER).map((row) => row.action));
  assert.deepEqual(
    [...auditActions].sort(),
    ["approved-absence.create", "approved-absence.delete", "approved-absence.update"],
  );
});

test("v0.86.3: Planungsverantwortung wird nicht als Empfängerin für Urlaubsanträge behandelt", async () => {
  const employee = session(TARGET_A, "employee");
  db.prepare("DELETE FROM portal_notifications WHERE recipient_employee_number = ?").run(PLANNER);
  const created = await request("/api/portal/v1/me/vacation-requests", {
    method: "POST",
    auth: employee,
    body: { dateFrom: "2035-04-09", dateTo: "2035-04-10", note: "Antragstest" },
  });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications
    WHERE recipient_employee_number = ? AND event_type = 'request.review'
  `).get(PLANNER).count, 0);
});

test("v0.86.3: Mobile Portal blendet Antragswege aus und öffnet die Filialplanung", () => {
  const portalHtml = fs.readFileSync(path.join(__dirname, "..", "public", "portal.html"), "utf8");
  const portalJs = fs.readFileSync(path.join(__dirname, "..", "public", "portal.js"), "utf8");
  assert.match(portalHtml, /id="timeOffTab"/);
  assert.match(portalHtml, /id="vacationTab"/);
  assert.match(portalJs, /session\.user\.role === "location_planner"/);
  assert.match(portalJs, /Filialplanung öffnen/);
  assert.match(portalJs, /Vollständige Planung auch am Smartphone/);
  assert.match(portalJs, /!portalTabAllowed\("timeOff"\)/);
  assert.match(portalJs, /!portalTabAllowed\("vacation"\)/);
});
