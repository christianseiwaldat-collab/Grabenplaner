const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-schedule-search-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_TODAY = "2032-08-20";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db } = subject;

const TARGET_LOCATION = "search-18";
const HOME_LOCATION = "search-05";
const ADMIN = "schedule-search-admin";
const MANAGER = "schedule-search-manager";
const DEPARTMENT_MANAGER = "schedule-search-department-manager";
const ALICE = "schedule-search-412";
const BOB = "schedule-search-252";
let targetDepartment;
let homeDepartment;
let httpServer;
let baseUrl;

function createSession(employeeNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return `grabenplaner_session=${encodeURIComponent(token)}`;
}

async function requestJson(route, cookie = "") {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

function insertEmployee(employeeNumber, fullName, nickname, locationId, departmentId) {
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, fixed_workdays, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, '#26785f', 38.5, 5, '', ?, ?, 1)
  `).run(employeeNumber, fullName, nickname, locationId, departmentId);
}

function insertPortalUser(employeeNumber, role) {
  db.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password,
      password_changed_at, updated_at
    ) VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
}

function insertAssignment(id, date, startTime = null, endTime = null) {
  const allDay = startTime === null;
  db.prepare(`
    INSERT INTO employee_location_lendings (
      id, employee_number, home_location_id, destination_location_id,
      destination_department_id, date_from, date_to, all_day, start_time,
      end_time, note, status, revision, created_by, created_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'active', 1,
      'schedule-search-test', CURRENT_TIMESTAMP, 'schedule-search-test', CURRENT_TIMESTAMP)
  `).run(
    id,
    ALICE,
    HOME_LOCATION,
    TARGET_LOCATION,
    targetDepartment,
    date,
    date,
    allDay ? 1 : 0,
    startTime,
    endTime,
  );
}

test.before(async () => {
  db.prepare("UPDATE locations SET active = 0").run();
  db.prepare("INSERT INTO locations (id, name, min_staff, active) VALUES (?, 'Grabenweg Suche', 2, 1)").run(TARGET_LOCATION);
  db.prepare("INSERT INTO locations (id, name, min_staff, active) VALUES (?, 'Mitterweg Suche', 2, 1)").run(HOME_LOCATION);
  targetDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Fotowelt Ziel', 1, 1, 1)
  `).run(TARGET_LOCATION).lastInsertRowid);
  homeDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Fotowelt Quelle', 1, 1, 1)
  `).run(HOME_LOCATION).lastInsertRowid);

  insertEmployee(ADMIN, "Ada Administration", "Ada", TARGET_LOCATION, targetDepartment);
  insertEmployee(MANAGER, "Franz Filialleitung", "Franz", TARGET_LOCATION, targetDepartment);
  insertEmployee(DEPARTMENT_MANAGER, "Dora Abteilungsleitung", "Dora", TARGET_LOCATION, targetDepartment);
  insertEmployee(ALICE, "Älice Beispiel", "Alice", HOME_LOCATION, homeDepartment);
  insertEmployee(BOB, "Bob Beispiel", "Bob", TARGET_LOCATION, targetDepartment);
  insertPortalUser(ADMIN, "admin");
  insertPortalUser(MANAGER, "manager");
  insertPortalUser(DEPARTMENT_MANAGER, "department_manager");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, 0, ?)
  `).run(MANAGER, TARGET_LOCATION, ADMIN);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, ?)
  `).run(DEPARTMENT_MANAGER, TARGET_LOCATION, targetDepartment, ADMIN);

  insertAssignment("schedule-search-future", "2032-08-27");
  insertAssignment("schedule-search-history", "2031-05-04", "10:00", "14:00");
  const insertShift = db.prepare(`
    INSERT INTO shifts (
      employee_number, location_id, department_id, shift_date,
      start_time, end_time, area, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertShift.run(ALICE, TARGET_LOCATION, targetDepartment, "2032-08-27", "09:00", "18:00", "Fotowelt", "GEHEIME DIENSTNOTIZ ZIEL");
  insertShift.run(ALICE, HOME_LOCATION, homeDepartment, "2032-08-28", "08:30", "17:00", "Kassa", "GEHEIME DIENSTNOTIZ QUELLE");
  insertShift.run(BOB, TARGET_LOCATION, targetDepartment, "2032-08-27", "08:00", "12:00", "Hardware", "GEHEIME DIENSTNOTIZ BOB");
  insertShift.run(ALICE, TARGET_LOCATION, targetDepartment, "2031-05-04", "10:00", "14:00", "Fotowelt", "GEHEIME HISTORIE");

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

test("Block 5: Dienstsuche findet einen standortübergreifenden Zukunftsdienst ohne Notizen", async () => {
  const admin = createSession(ADMIN);
  const parameters = new URLSearchParams({
    employee: "alice",
    dateFrom: "2032-08-01",
    dateTo: "2032-09-30",
    locationId: TARGET_LOCATION,
    homeLocationId: HOME_LOCATION,
    assignment: "cross_location",
  });
  const result = await requestJson(`/api/schedule/search?${parameters}`, admin);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.match(result.response.headers.get("cache-control") || "", /private/);
  assert.equal(result.payload.paging.total, 1);
  assert.equal(result.payload.results.length, 1);
  assert.deepEqual(result.payload.results[0], {
    shiftId: result.payload.results[0].shiftId,
    personnelNumber: ALICE,
    employeeName: "Älice Beispiel",
    employeeNickname: "Alice",
    homeLocationId: HOME_LOCATION,
    homeLocationName: "Mitterweg Suche",
    locationId: TARGET_LOCATION,
    locationName: "Grabenweg Suche",
    departmentId: targetDepartment,
    departmentName: "Fotowelt Ziel",
    shiftDate: "2032-08-27",
    startTime: "09:00",
    endTime: "18:00",
    durationMinutes: 540,
    area: "Fotowelt",
    crossLocation: true,
    weekStart: "2032-08-23",
    calendarWeek: 35,
  });
  assert.deepEqual(result.payload.filters.locations, [{ id: TARGET_LOCATION, name: "Grabenweg Suche" }]);
  assert.equal(result.payload.filters.homeLocations.some((location) => location.id === HOME_LOCATION), true);
  assert.equal(JSON.stringify(result.payload).includes("GEHEIME"), false);
  assert.equal(Object.hasOwn(result.payload.results[0], "note"), false);
});

test("Block 5: Vergangenheit, Bereiche, Sortierung und Seitennavigation sind serverseitig verfügbar", async () => {
  const admin = createSession(ADMIN);
  const historical = await requestJson(
    `/api/schedule/search?dateFrom=2031-05-01&dateTo=2031-05-31&employee=%C3%A4lice&area=fotowelt`,
    admin,
  );
  assert.equal(historical.response.status, 200, JSON.stringify(historical.payload));
  assert.equal(historical.payload.paging.total, 1);
  assert.equal(historical.payload.results[0].shiftDate, "2031-05-04");

  const paged = await requestJson(
    "/api/schedule/search?dateFrom=2032-08-01&dateTo=2032-09-30&sort=employee&direction=desc&limit=1&offset=1",
    admin,
  );
  assert.equal(paged.response.status, 200, JSON.stringify(paged.payload));
  assert.equal(paged.payload.paging.total, 3);
  assert.equal(paged.payload.paging.returned, 1);
  assert.equal(paged.payload.paging.hasMore, true);
  assert.equal(paged.payload.results[0].personnelNumber, ALICE);
  assert.deepEqual(paged.payload.filters.locations.map((location) => location.id).sort(), [HOME_LOCATION, TARGET_LOCATION].sort());
});

test("Block 6: sämtliche sichtbaren Tabellenspalten akzeptieren die serverseitige Sortierung", async () => {
  const admin = createSession(ADMIN);
  for (const sort of [
    "date", "employee", "personnelNumber", "homeLocation", "location",
    "department", "startTime", "duration", "area", "assignment",
  ]) {
    const result = await requestJson(
      `/api/schedule/search?dateFrom=2032-08-01&dateTo=2032-09-30&sort=${sort}&direction=asc`,
      admin,
    );
    assert.equal(result.response.status, 200, `${sort}: ${JSON.stringify(result.payload)}`);
    assert.equal(result.payload.query.sort, sort);
    assert.equal(result.payload.results.length, 3);
  }
  const descendingHomeLocation = await requestJson(
    "/api/schedule/search?dateFrom=2032-08-01&dateTo=2032-09-30&sort=homeLocation&direction=desc",
    admin,
  );
  assert.equal(descendingHomeLocation.payload.results[0].homeLocationName, "Mitterweg Suche");
});

test("Block 5: Filialleitung sieht bei der Gesamtsuche ausschließlich den freigegebenen Zielbereich", async () => {
  const manager = createSession(MANAGER);
  const allowed = await requestJson(
    "/api/schedule/search?dateFrom=2032-08-01&dateTo=2032-09-30&locationId=all",
    manager,
  );
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
  assert.equal(allowed.payload.paging.total, 2);
  assert.deepEqual(allowed.payload.filters.locations, [{ id: TARGET_LOCATION, name: "Grabenweg Suche" }]);
  assert.equal(allowed.payload.results.every((entry) => entry.locationId === TARGET_LOCATION), true);

  const departmentManager = createSession(DEPARTMENT_MANAGER);
  const departmentAllowed = await requestJson(
    "/api/schedule/search?dateFrom=2032-08-01&dateTo=2032-09-30&locationId=all",
    departmentManager,
  );
  assert.equal(departmentAllowed.response.status, 200, JSON.stringify(departmentAllowed.payload));
  assert.equal(departmentAllowed.payload.paging.total, 2);
  assert.equal(departmentAllowed.payload.results.every((entry) => entry.departmentId === targetDepartment), true);

  const denied = await requestJson(
    `/api/schedule/search?dateFrom=2032-08-01&dateTo=2032-09-30&locationId=${HOME_LOCATION}`,
    manager,
  );
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "SCHEDULE_SEARCH_SCOPE_DENIED");

  const anonymous = await requestJson("/api/schedule/search?dateFrom=2032-08-01&dateTo=2032-09-30");
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));
});

test("Block 5: ungültige oder überbreite Suchparameter werden abgewiesen", async () => {
  const admin = createSession(ADMIN);
  for (const route of [
    "/api/schedule/search?dateFrom=2032-09-01&dateTo=2032-08-01",
    "/api/schedule/search?dateFrom=2030-01-01&dateTo=2032-01-02",
    "/api/schedule/search?sort=private",
    "/api/schedule/search?direction=sideways",
    "/api/schedule/search?assignment=remote",
    "/api/schedule/search?limit=101",
    "/api/schedule/search?offset=5001",
    "/api/schedule/search?departmentId=0",
    "/api/schedule/search?locationId=search%2F18",
    "/api/schedule/search?employee=Alice&employee=Bob",
    "/api/schedule/search?employee=Alice%0ABob",
  ]) {
    const result = await requestJson(route, admin);
    assert.equal(result.response.status, 400, `${route}: ${JSON.stringify(result.payload)}`);
  }
  const unavailableDepartment = await requestJson(
    "/api/schedule/search?dateFrom=2032-08-01&dateTo=2032-09-30&departmentId=999999",
    admin,
  );
  assert.equal(unavailableDepartment.response.status, 403, JSON.stringify(unavailableDepartment.payload));
  assert.equal(unavailableDepartment.payload.code, "SCHEDULE_SEARCH_SCOPE_DENIED");
});
