"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v087-cost-center-types-"));
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
let positionId;

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

async function createType(auth, code, extras = {}) {
  const result = await request("/api/cost-center-types", {
    method: "POST",
    auth,
    body: {
      code,
      name: `Typ ${code}`,
      description: `Testtyp ${code}`,
      isBranch: false,
      active: true,
      positionIds: [positionId],
      ...extras,
    },
  });
  assert.equal(result.response.status, 201, result.text);
  assert.ok(result.payload?.type?.id);
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

function freeLocationIds(count = 1) {
  const result = [];
  for (let id = 99; id >= 10 && result.length < count; id -= 1) {
    const value = String(id);
    if (!db.prepare("SELECT 1 FROM locations WHERE id = ?").get(value)) result.push(value);
  }
  assert.equal(result.length, count, "Nicht genügend freie Test-Filialnummern");
  return result;
}

test.before(async () => {
  positionId = String(db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id);
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

test("v0.87 Kostenstellentypen: Katalog, Migration und Positionssets sind vollständig", async () => {
  const hr = session("103", "hr");
  const listed = await request("/api/cost-center-types?includeInactive=1", { auth: hr });
  assert.equal(listed.response.status, 200, listed.text);
  assert.deepEqual(
    listed.payload.types.filter((type) => type.builtin).map((type) => type.code),
    ["branch", "administration", "production", "other"],
  );
  assert.ok(listed.payload.types.every((type) => Array.isArray(type.positionIds) && Array.isArray(type.positions)));
  assert.ok(listed.payload.types.find((type) => type.code === "branch")?.isBranch);
  assert.equal(listed.payload.positions.length, db.prepare("SELECT COUNT(*) AS count FROM positions").get().count);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.87-cost-center-types'").get());
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("v0.87 Kostenstellentypen: PL+ verwaltet eigene Typen atomar und der Code bleibt stabil", async () => {
  const hr = session("103", "hr");
  const type = await createType(hr, "lager-logistik");
  assert.deepEqual(type.positionIds, [positionId]);
  assert.equal(type.builtin, false);
  assert.ok(type.sortOrder > 0);

  const updated = await request(`/api/cost-center-types/${encodeURIComponent(type.id)}`, {
    method: "PUT",
    auth: hr,
    body: {
      name: "Lager und Logistik",
      description: "Zentrale Lager- und Logistikbereiche",
      positionIds: [],
    },
  });
  assert.equal(updated.response.status, 200, updated.text);
  assert.equal(updated.payload.type.name, "Lager und Logistik");
  assert.deepEqual(updated.payload.type.positionIds, []);

  const immutable = await request(`/api/cost-center-types/${encodeURIComponent(type.id)}`, {
    method: "PUT",
    auth: hr,
    body: { code: "anderer-code" },
  });
  assert.equal(immutable.response.status, 409, immutable.text);
  assert.equal(immutable.payload.code, "COST_CENTER_TYPE_CODE_IMMUTABLE");

  const duplicate = await request("/api/cost-center-types", {
    method: "POST",
    auth: hr,
    body: { code: "lager-logistik", name: "Duplikat", positionIds: [] },
  });
  assert.equal(duplicate.response.status, 409, duplicate.text);
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_log
    WHERE action = 'cost-center-type.update' AND entity_id = ?
  `).get(type.id));
});

test("v0.87 Kostenstellentypen: Filialstatus steuert Standortzuordnung und bleibt bei Nutzung geschützt", async () => {
  const hr = session("103", "hr");
  const branchType = await createType(hr, "service-filiale", { name: "Servicefiliale", isBranch: true });
  const branchCenter = await createCostCenter(hr, "T87-BR", branchType.id);
  const nonBranchType = await createType(hr, "backoffice", { name: "Backoffice" });
  const nonBranchCenter = await createCostCenter(hr, "T87-BO", nonBranchType.id);
  const [firstLocationId, secondLocationId] = freeLocationIds(2);

  const invalidLocation = await request("/api/locations", {
    method: "POST",
    auth: hr,
    body: { id: firstLocationId, name: "Ungültige Typzuordnung", costCenterId: nonBranchCenter.id },
  });
  assert.equal(invalidLocation.response.status, 409, invalidLocation.text);
  assert.equal(invalidLocation.payload.code, "LOCATION_COST_CENTER_TYPE_REQUIRED");

  const createdLocation = await request("/api/locations", {
    method: "POST",
    auth: hr,
    body: { id: firstLocationId, name: "Service-Testfiliale", costCenterId: branchCenter.id },
  });
  assert.equal(createdLocation.response.status, 201, createdLocation.text);
  assert.equal(db.prepare("SELECT cost_center_id FROM locations WHERE id = ?").get(firstLocationId).cost_center_id, branchCenter.id);

  const customBranchEmployee = "9876";
  db.prepare("UPDATE locations SET min_staff = 2 WHERE id = ?").run(firstLocationId);
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       position_id, home_location_id, cost_center_id, active)
    VALUES (?, 'Custom Branch Test', 'Branchtest', '#2c7a68', 38.5, 5, ?, ?, ?, 1)
  `).run(customBranchEmployee, positionId, firstLocationId, branchCenter.id);
  const employee = session(customBranchEmployee, "employee");
  const governedRequest = await request("/api/portal/v1/me/vacation-requests", {
    method: "POST",
    auth: employee,
    body: { dateFrom: "2035-03-12", dateTo: "2035-03-12", note: "Filialtypprüfung" },
  });
  assert.equal(governedRequest.response.status, 409, governedRequest.text);
  assert.equal(governedRequest.payload.code, "VACATION_STAFFING_INSUFFICIENT");

  const reusedCenter = await request("/api/locations", {
    method: "POST",
    auth: hr,
    body: { id: secondLocationId, name: "Doppelte Zuordnung", costCenterId: branchCenter.id },
  });
  assert.equal(reusedCenter.response.status, 409, reusedCenter.text);
  assert.equal(reusedCenter.payload.code, "LOCATION_COST_CENTER_IN_USE");

  const removeBranchFlag = await request(`/api/cost-center-types/${encodeURIComponent(branchType.id)}`, {
    method: "PUT",
    auth: hr,
    body: { isBranch: false },
  });
  assert.equal(removeBranchFlag.response.status, 409, removeBranchFlag.text);
  assert.equal(removeBranchFlag.payload.code, "COST_CENTER_TYPE_BRANCH_IN_USE");

  const archiveUsedType = await request(`/api/cost-center-types/${encodeURIComponent(branchType.id)}`, {
    method: "DELETE",
    auth: hr,
  });
  assert.equal(archiveUsedType.response.status, 409, archiveUsedType.text);
  assert.equal(archiveUsedType.payload.code, "COST_CENTER_TYPE_IN_USE");

  assert.throws(
    () => db.prepare("UPDATE cost_center_types SET is_branch = 0 WHERE id = ?").run(branchType.id),
    /COST_CENTER_TYPE_BRANCH_IN_USE/,
  );
});

test("v0.87 Kostenstellentypen: Eigene Typen erscheinen an Kostenstellen ohne Legacy-Semantik zu brechen", async () => {
  const hr = session("103", "hr");
  const type = await createType(hr, "it-betrieb", { name: "IT-Betrieb" });
  const center = await createCostCenter(hr, "T87-IT", type.id);
  assert.equal(center.typeId, type.id);
  assert.equal(center.typeCode, "it-betrieb");
  assert.equal(center.typeName, "IT-Betrieb");
  assert.equal(center.isBranch, false);
  assert.equal(
    db.prepare("SELECT type FROM cost_centers WHERE id = ?").get(center.id).type,
    "other",
    "Die alte Typspalte muss für ältere Leser kompatibel bleiben",
  );

  const listed = await request("/api/cost-centers?includeInactive=1", { auth: hr });
  assert.equal(listed.response.status, 200, listed.text);
  assert.ok(listed.payload.types.some((entry) => entry.id === type.id));
  assert.ok(listed.payload.costCenters.some((entry) =>
    entry.id === center.id && entry.typeId === type.id && entry.typeName === "IT-Betrieb"));
});

test("v0.87 Kostenstellentypen: Archivierung ist weich und ungenutzte Typen bleiben historisch lesbar", async () => {
  const hr = session("103", "hr");
  const type = await createType(hr, "archiv-test", { positionIds: [] });
  const center = await createCostCenter(hr, "T87-ARC", type.id);
  const archivedCenter = await request(`/api/cost-centers/${encodeURIComponent(center.id)}`, {
    method: "DELETE",
    auth: hr,
  });
  assert.equal(archivedCenter.response.status, 204, archivedCenter.text);
  const archived = await request(`/api/cost-center-types/${encodeURIComponent(type.id)}`, {
    method: "DELETE",
    auth: hr,
  });
  assert.equal(archived.response.status, 204, archived.text);
  const row = db.prepare("SELECT active FROM cost_center_types WHERE id = ?").get(type.id);
  assert.ok(row);
  assert.equal(row.active, 0);

  const listed = await request("/api/cost-center-types?includeInactive=1", { auth: hr });
  assert.ok(listed.payload.types.some((entry) => entry.id === type.id && entry.active === false));
  const activeOnly = await request("/api/cost-center-types?includeInactive=0", { auth: hr });
  assert.equal(activeOnly.payload.types.some((entry) => entry.id === type.id), false);

  const historicalEdit = await request(`/api/cost-centers/${encodeURIComponent(center.id)}`, {
    method: "PUT",
    auth: hr,
    body: { name: "Historische Kostenstelle", active: false },
  });
  assert.equal(historicalEdit.response.status, 200, historicalEdit.text);
  assert.equal(historicalEdit.payload.costCenter.name, "Historische Kostenstelle");
  assert.equal(historicalEdit.payload.costCenter.typeId, type.id);
  assert.equal(historicalEdit.payload.costCenter.active, false);
});

test("v0.87 Kostenstellentypen: Positionszuordnungen verhindern versehentliches Löschen", async () => {
  const hr = session("103", "hr");
  const positionName = "Testposition Typbindung";
  const positionResult = await request("/api/positions", {
    method: "POST",
    auth: hr,
    body: { name: positionName },
  });
  assert.equal(positionResult.response.status, 201, positionResult.text);
  const position = positionResult.payload.find((entry) => entry.name === positionName);
  assert.ok(position?.id);
  const type = await createType(hr, "positionsschutz", { positionIds: [position.id] });

  const blocked = await request(`/api/positions/${encodeURIComponent(position.id)}`, {
    method: "DELETE",
    auth: hr,
  });
  assert.equal(blocked.response.status, 409, blocked.text);
  assert.equal(blocked.payload.code, "POSITION_COST_CENTER_TYPE_IN_USE");

  const unlinked = await request(`/api/cost-center-types/${encodeURIComponent(type.id)}`, {
    method: "PUT",
    auth: hr,
    body: { positionIds: [] },
  });
  assert.equal(unlinked.response.status, 200, unlinked.text);
  const deleted = await request(`/api/positions/${encodeURIComponent(position.id)}`, {
    method: "DELETE",
    auth: hr,
  });
  assert.equal(deleted.response.status, 204, deleted.text);
});

test("v0.87 Kostenstellentypen: Filialleitung erhält keinen globalen Schreibzugriff", async () => {
  const manager = session("104", "manager");
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by, updated_at)
    VALUES ('104', 'cost_centers:write', 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, permission) DO UPDATE SET
      granted_by = 'test', updated_at = CURRENT_TIMESTAMP
  `).run();
  const denied = await request("/api/cost-center-types", {
    method: "POST",
    auth: manager,
    body: { code: "nicht-erlaubt", name: "Nicht erlaubt", positionIds: [] },
  });
  assert.equal(denied.response.status, 403, denied.text);
  assert.equal(db.prepare("SELECT 1 FROM cost_center_types WHERE code = 'nicht-erlaubt'").get(), undefined);
});
