"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v087-employee-assignment-"));
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

let httpServer;
let baseUrl;
let allowedPositionId;
let disallowedPositionId;

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
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

async function createType(auth, code, { isBranch = false, positionIds = [allowedPositionId] } = {}) {
  const result = await request("/api/cost-center-types", {
    method: "POST",
    auth,
    body: {
      code,
      name: `Typ ${code}`,
      isBranch,
      active: true,
      positionIds,
    },
  });
  assert.equal(result.response.status, 201, result.text);
  return result.payload.type;
}

async function createCostCenter(auth, code, typeId) {
  const result = await request("/api/cost-centers", {
    method: "POST",
    auth,
    body: {
      code,
      name: `Kostenstelle ${code}`,
      costCenterTypeId: typeId,
      active: true,
    },
  });
  assert.equal(result.response.status, 201, result.text);
  return result.payload.costCenter;
}

function employeeBody(personnelNumber, costCenterId, positionId = allowedPositionId, extras = {}) {
  return {
    personnelNumber,
    fullName: `Testperson ${personnelNumber}`,
    nickname: `T${personnelNumber}`,
    color: "#2c7a68",
    contractedHours: 38.5,
    targetWorkdaysPerWeek: 5,
    preferredDayOff: "",
    fixedWorkdays: [],
    costCenterId,
    positionId,
    preferredDepartmentId: "",
    active: true,
    ...extras,
  };
}

function freeLocationId() {
  for (let value = 99; value >= 10; value -= 1) {
    const id = String(value);
    if (!db.prepare("SELECT 1 FROM locations WHERE id = ?").get(id)) return id;
  }
  throw new Error("Keine freie Test-Filialnummer");
}

test.before(async () => {
  const positions = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 2").all();
  assert.equal(positions.length, 2);
  [allowedPositionId, disallowedPositionId] = positions.map((position) => String(position.id));
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

test("v0.87 Block 2: Migration und Datenbank sichern die führende Kostenstelle ab", () => {
  assert.ok(db.prepare(`
    SELECT 1 FROM schema_migrations
    WHERE id = 'v0.87-employee-cost-center-assignment'
  `).get());
  const inconsistent = db.prepare(`
    SELECT e.personnel_number
    FROM employees e
    JOIN cost_centers c ON c.id = e.cost_center_id
    JOIN cost_center_types cct ON cct.id = c.cost_center_type_id
    WHERE NOT EXISTS (
      SELECT 1 FROM cost_center_type_positions cctp
      WHERE cctp.cost_center_type_id = c.cost_center_type_id
        AND cctp.position_id = e.position_id
    )
      OR COALESCE(e.home_location_id, '') <> COALESCE(
        CASE WHEN cct.is_branch = 1
          THEN (SELECT l.id FROM locations l WHERE l.cost_center_id = c.id LIMIT 1)
          ELSE NULL END,
        ''
      )
      OR (
        e.preferred_department_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM departments d
          WHERE d.id = e.preferred_department_id
            AND d.location_id = e.home_location_id
        )
      )
  `).all();
  assert.deepEqual(inconsistent, []);
});

test("v0.87 Block 2: Kostenstellentyp begrenzt Positionen in API und Datenbank", async () => {
  const hr = session("103", "hr");
  const type = await createType(hr, "block2-verwaltung");
  const center = await createCostCenter(hr, "T87-B2V", type.id);

  const created = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeeBody("v087-b2-admin", center.id),
  });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.payload.homeLocationId, null);
  assert.equal(created.payload.costCenterId, center.id);

  const disallowed = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeeBody("v087-b2-invalid-position", center.id, disallowedPositionId),
  });
  assert.equal(disallowed.response.status, 409, disallowed.text);
  assert.equal(disallowed.payload.code, "EMPLOYEE_POSITION_NOT_ALLOWED_FOR_COST_CENTER");

  assert.throws(
    () => db.prepare(`
      INSERT INTO employees
        (personnel_number, full_name, nickname, color, contracted_hours,
         target_workdays_per_week, position_id, cost_center_id, active)
      VALUES ('v087-b2-trigger-position', 'Trigger', 'Trigger', '#2c7a68', 38.5, 5, ?, ?, 1)
    `).run(disallowedPositionId, center.id),
    /EMPLOYEE_POSITION_NOT_ALLOWED_FOR_COST_CENTER/,
  );

  const removeUsedPosition = await request(`/api/cost-center-types/${encodeURIComponent(type.id)}`, {
    method: "PUT",
    auth: hr,
    body: { positionIds: [] },
  });
  assert.equal(removeUsedPosition.response.status, 409, removeUsedPosition.text);
  assert.equal(removeUsedPosition.payload.code, "COST_CENTER_TYPE_POSITION_IN_USE");

  const otherType = await createType(hr, "block2-anderer-typ");
  const changeOccupiedType = await request(`/api/cost-centers/${encodeURIComponent(center.id)}`, {
    method: "PUT",
    auth: hr,
    body: { costCenterTypeId: otherType.id },
  });
  assert.equal(changeOccupiedType.response.status, 409, changeOccupiedType.text);
  assert.equal(changeOccupiedType.payload.code, "COST_CENTER_TYPE_EMPLOYEE_ASSIGNMENTS");
});

test("v0.87 Block 2: Filialkostenstelle leitet Standort ab und lässt Einsatzorte unabhängig", async () => {
  const hr = session("103", "hr");
  const type = await createType(hr, "block2-filiale", { isBranch: true });
  const center = await createCostCenter(hr, "T87-B2F", type.id);
  const locationId = freeLocationId();
  const location = await request("/api/locations", {
    method: "POST",
    auth: hr,
    body: { id: locationId, name: "Block-2-Testfiliale", costCenterId: center.id },
  });
  assert.equal(location.response.status, 201, location.text);

  const created = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeeBody("v087-b2-branch", center.id),
  });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.payload.homeLocationId, locationId);

  const otherLocation = db.prepare(`
    SELECT id FROM locations WHERE id <> ? ORDER BY id LIMIT 1
  `).get(locationId);
  assert.ok(otherLocation);
  const conflictingLocationId = String(otherLocation.id);
  const conflict = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeeBody("v087-b2-location-conflict", center.id, allowedPositionId, {
      homeLocationId: conflictingLocationId,
    }),
  });
  assert.equal(conflict.response.status, 409, conflict.text);
  assert.equal(conflict.payload.code, "EMPLOYEE_HOME_LOCATION_DERIVED");

  assert.throws(
    () => db.prepare("UPDATE employees SET home_location_id = ? WHERE personnel_number = ?")
      .run(conflictingLocationId, "v087-b2-branch"),
    /EMPLOYEE_LOCATION_MUST_FOLLOW_COST_CENTER/,
  );

  const shiftLocationId = conflictingLocationId;
  db.prepare(`
    INSERT INTO employee_location_lendings (
      id, employee_number, home_location_id, destination_location_id,
      destination_department_id, date_from, date_to, all_day, note,
      status, revision, created_by, created_at, updated_by, updated_at
    ) VALUES ('v087-b2-branch-assignment', ?, ?, ?, NULL, '2035-03-12', '2035-03-12',
      1, '', 'active', 1, 'v087-test', CURRENT_TIMESTAMP, 'v087-test', CURRENT_TIMESTAMP)
  `).run("v087-b2-branch", locationId, shiftLocationId);
  db.prepare(`
    INSERT INTO shifts
      (employee_number, shift_date, start_time, end_time, location_id)
    VALUES (?, '2035-03-12', '09:00', '17:00', ?)
  `).run("v087-b2-branch", shiftLocationId);
  const storedShift = db.prepare(`
    SELECT location_id FROM shifts
    WHERE employee_number = 'v087-b2-branch' AND shift_date = '2035-03-12'
  `).get();
  assert.equal(storedShift.location_id, shiftLocationId);
});

test("v0.87 Block 2: Personalimport veröffentlicht Kostenstelle statt eigener Standortzuordnung", async () => {
  const hr = session("103", "hr");
  const catalog = await request("/api/integrations/personnel-import/catalog", { auth: hr });
  assert.equal(catalog.response.status, 200, catalog.text);
  const fieldIds = catalog.payload.fields.map((field) => field.id);
  assert.ok(fieldIds.includes("costCenterId"));
  assert.equal(fieldIds.includes("homeLocationId"), false);
  assert.equal(fieldIds.includes("homeLocationName"), false);
  assert.ok(catalog.payload.references.positions.every((position) =>
    Array.isArray(position.costCenterTypeIds)));
  assert.ok(catalog.payload.references.locations.every((location) =>
    Object.hasOwn(location, "costCenterId")));
});
