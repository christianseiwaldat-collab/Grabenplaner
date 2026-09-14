"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-branch-time-off-"));
Object.assign(process.env, {
  DB_PATH: path.join(testRoot, "dienstplan.db"), BACKUP_DIR: path.join(testRoot, "backups"),
  GRABENPLANER_DATA_DIR: path.join(testRoot, "app-data"), GRABENPLANER_HOST: "127.0.0.1",
  GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test",
});
const { app, db, releaseInstanceLockForTests, installationFeaturesForApiPath } = require("../server");
const permission = "branch_time_off:submit";
let baseUrl, server, hr, branch, accountId, manager;
const input = (permissions = []) => ({
  loginName: "za-filiale", displayName: "ZA Testfiliale", accountType: "branch", active: true,
  password: "Lokales-Testpasswort-2031!", permissions, scopes: [{ locationId: "93" }],
});

function employee(number, name, location, active = 1, role = "employee") {
  db.prepare(`INSERT INTO employees (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
    VALUES (?, ?, ?, '#287a67', 38.5, ?, ?)`).run(number, name, name.split(" ")[0], location, active);
  db.prepare(`INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password)
    VALUES (?, 'test-only', ?, 1, 0)`).run(number, role);
  if (role === "manager") db.prepare(`INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES (?, ?, 0, 'za-test')`).run(number, location);
}

function employeeSession(number) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at) VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')`)
    .run(crypto.randomUUID(), number, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function request(route, { method = "GET", session = branch, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (session?.csrf) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}/api/portal/v1/${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  return { status: response.status, data, headers: response.headers };
}

async function login() {
  const result = await request("auth/login", { method: "POST", session: null,
    body: { loginName: input().loginName, password: input().password } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const cookies = result.headers.getSetCookie().map(value => value.split(";", 1)[0]);
  return { cookie: cookies.join("; "), csrf: decodeURIComponent(cookies.find(value => value.startsWith("grabenplaner_csrf=")).split("=")[1]) };
}

async function enable(enabled = true) {
  const result = await request(`organization-accounts/${accountId}`, { method: "PUT", session: hr,
    body: { ...input(enabled ? [permission] : []), password: "" } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.account.permissions.includes(permission), enabled);
  branch = await login();
}

const allDay = (date, employeeNumber = "za-a", extra = {}) => ({ employeeNumber, dateFrom: date, dateTo: date, allDay: true, ...extra });
const post = (suffix, body, options = {}) => request(`branch-time-off/${suffix}`, { method: "POST", body, ...options });

test.before(async () => {
  const hours = JSON.stringify(Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map(day => [day,
    { open: true, start: "08:00", end: "20:00", lunchEnabled: false, minStaff: 0, minFrom: "08:00", minTo: "20:00" }])));
  for (const id of ["93", "94"]) db.prepare(`INSERT INTO locations (id, name, min_staff, day_settings_json, active) VALUES (?, ?, 0, ?, 1)`)
    .run(id, `Testfiliale ${id}`, hours);
  employee("za-a", "Anna Beispiel", "93");
  employee("za-b", "Ben Beispiel", "93");
  employee("za-inactive", "Inaktive Person", "93", 0);
  employee("za-other", "Fremde Person", "94");
  employee("za-hr", "Test Personalleitung", "94", 1, "hr");
  employee("za-manager", "Mira Leitung", "93", 1, "manager");
  db.prepare(`INSERT INTO employee_location_lendings (id, employee_number, home_location_id, destination_location_id,
    date_from, date_to, all_day, note, status, revision, created_by, updated_by, created_at, updated_at)
    VALUES ('za-fixture-lending', 'za-a', '93', '94', '2031-09-06', '2031-09-06', 1, 'PRIVATE-LENDING', 'active', 1, 'test', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run();
  for (const date of ["2031-09-01", "2031-09-05", "2031-09-09", "2031-09-30", "2031-10-01"]) {
    db.prepare(`INSERT INTO shifts (employee_number, location_id, shift_date, start_time, end_time, area, note)
      VALUES ('za-a', '93', ?, '09:00', '17:00', 'Verkauf', 'PRIVATE-SHIFT-NOTE')`).run(date);
  }
  db.prepare(`INSERT INTO shifts (employee_number, location_id, shift_date, start_time, end_time, note)
    VALUES ('za-a', '94', '2031-09-06', '08:00', '14:00', 'FOREIGN-NOTE'),
      ('za-other', '94', '2031-09-05', '08:00', '16:00', 'FOREIGN-NOTE'),
      ('za-b', '93', '2031-09-05', '10:00', '18:00', 'PRIVATE-SHIFT-NOTE')`).run();
  hr = employeeSession("za-hr");
  manager = employeeSession("za-manager");
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await request("organization-accounts", { method: "POST", session: hr, body: input() });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  accountId = created.data.account.id;
  branch = await login();
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  assert.equal(path.dirname(path.resolve(testRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(testRoot).startsWith("grabenplaner-branch-time-off-"));
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Filialkonto-ZA: opt-in, Filialgrenzen und bestehender Genehmigungsablauf", async t => {
  await t.test("ohne Freischaltung und ohne Sitzung sind alle neuen Routen gesperrt", async () => {
    for (const suffix of ["employees", "schedule?date=2031-09-05&employeeNumber=za-a", "slots?date=2031-09-05&employeeNumber=za-a"]) {
      assert.equal((await request(`branch-time-off/${suffix}`)).status, 403);
      assert.equal((await request(`branch-time-off/${suffix}`, { session: null })).status, 401);
    }
    for (const suffix of ["check", "requests"]) assert.equal((await post(suffix, allDay("2031-09-05"))).status, 403);
    await enable();
  });

  await t.test("nur aktive Teammitglieder der zugewiesenen Filiale werden angeboten", async () => {
    const result = await request("branch-time-off/employees?locationId=94");
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.location.id, "93");
    assert.deepEqual(result.data.employees.map(person => person.employeeNumber), ["za-a", "za-b", "za-manager"]);
    assert.ok(result.data.employees.every(person => Object.keys(person).sort().join() === "employeeNumber,fullName"));
  });

  await t.test("fremde, inaktive, fehlende und manipulierte Personen werden serverseitig abgewiesen", async () => {
    for (const employeeNumber of ["za-other", "za-inactive", "unbekannt", "", ["za-a"]]) {
      for (const suffix of ["check", "requests"]) {
        const result = await post(suffix, allDay("2031-09-10", employeeNumber));
        assert.ok([400, 403].includes(result.status), JSON.stringify(result));
      }
    }
    for (const suffix of ["schedule", "slots"]) assert.equal((await request(`branch-time-off/${suffix}?date=2031-09-05&employeeNumber=za-other`)).status, 403);
    assert.equal((await post("requests", allDay("2031-09-10"), { session: { cookie: branch.cookie } })).status, 403);
    assert.equal((await post("requests", allDay("2031-09-10"), { session: employeeSession("za-a") })).status, 403);
  });

  await t.test("Woche und Monat liefern nur bestehende Filialdienste ohne interne Notizen", async () => {
    const week = await request("branch-time-off/schedule?date=2031-09-05&employeeNumber=za-a&view=week&locationId=94");
    assert.equal(week.status, 200, JSON.stringify(week.data));
    assert.equal(week.data.from, "2031-09-01");
    assert.equal(week.data.to, "2031-09-07");
    assert.equal(week.data.shifts.length, 3);
    assert.equal(week.data.employeeShifts.length, 2);
    assert.ok(week.data.employeeShifts.every(shift => shift.startTime === "09:00"));
    assert.doesNotMatch(JSON.stringify(week.data), /PRIVATE|FOREIGN|Fremde|note|duty_code/);
    const month = await request("branch-time-off/schedule?date=2031-09-05&employeeNumber=za-a&view=month");
    assert.equal(month.data.from, "2031-09-01");
    assert.equal(month.data.to, "2031-09-30");
    assert.equal(month.data.employeeShifts.length, 4);
    const empty = await request("branch-time-off/schedule?date=2032-02-15&employeeNumber=za-b&view=month");
    assert.equal(empty.data.to, "2032-02-29");
    assert.deepEqual(empty.data.shifts, []);
    for (const query of ["date=2031-02-30&view=week", "date=invalid&view=month", "date=2031-09-05&view=year"]) {
      assert.equal((await request(`branch-time-off/schedule?${query}&employeeNumber=za-a`)).status, 400);
    }
  });

  await t.test("Stunden, ganze Tage und mehrere Tage verwenden die vorhandene Prüfung und bleiben Anträge", async () => {
    const slots = await request("branch-time-off/slots?date=2031-09-05&employeeNumber=za-a");
    assert.equal(slots.status, 200, JSON.stringify(slots.data));
    assert.equal(slots.data.closed, false);
    assert.ok(slots.data.startTimes.includes("09:00"));
    const requests = [
      { employeeNumber: "za-a", date: "2031-09-05", startTime: "09:00", endTime: "10:00", approvalType: "local" },
      allDay("2031-09-08", "za-a", { approvalType: "hr" }),
      allDay("2031-09-10", "za-b", { dateTo: "2031-09-12" }),
    ];
    const shiftsBefore = db.prepare("SELECT * FROM shifts ORDER BY id").all();
    for (const body of requests) {
      const check = await post("check", body);
      assert.equal(check.status, 200, JSON.stringify(check.data));
      assert.equal(check.data.allowed, true, JSON.stringify(check.data));
      const result = await post("requests", { ...body, note: "Lokal durch Filialkonto", locationId: "94", status: "approved" });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      const row = db.prepare("SELECT * FROM time_off_requests WHERE id = ?").get(result.data.id);
      assert.equal(row.employee_number, body.employeeNumber);
      assert.equal(row.location_id, "93");
      assert.equal(row.status, "pending_local");
      assert.equal(row.all_day, body.allDay ? 1 : 0);
      assert.equal(row.approval_type, body.approvalType || "local");
      const decision = db.prepare("SELECT * FROM request_decisions WHERE request_kind='time_off' AND request_id=? AND action='submit'").get(row.id);
      assert.equal(decision.actor_employee_number, `account:${accountId}`);
      assert.equal(decision.note, "Über Filialkonto erfasst");
      const audit = db.prepare("SELECT * FROM audit_log WHERE action='time_off.request.create' AND entity_id=?").get(String(row.id));
      assert.equal(audit.actor, `account:${accountId}`);
      assert.ok(db.prepare("SELECT 1 FROM portal_notifications WHERE recipient_employee_number='za-manager' AND entity_type='time_off' AND entity_id=?").get(String(row.id)));
      const duplicate = await post("requests", { ...body, excludeRequestId: row.id });
      assert.equal(duplicate.status, 409, JSON.stringify(duplicate.data));
    }
    assert.deepEqual(db.prepare("SELECT * FROM shifts ORDER BY id").all(), shiftsBefore);
    const manual = await post("check", allDay("2031-09-20", "za-b"));
    assert.equal(manual.data.allowed, true);
    assert.equal(manual.data.trafficLight, "yellow");
    assert.match(manual.data.reason, /Planung|Dienstplan|manuell/i);
  });

  await t.test("die Filialleitung erhält den Antrag im vorhandenen Genehmigungsablauf", async () => {
    const row = db.prepare("SELECT id FROM time_off_requests WHERE employee_number='za-b' ORDER BY id DESC LIMIT 1").get();
    const result = await request(`absence-requests/time_off/${row.id}/action`, { method: "PUT", session: manager, body: { action: "approve", note: "Geprüft" } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const stored = db.prepare("SELECT status, local_approved_by FROM time_off_requests WHERE id=?").get(row.id);
    assert.ok(["approved", "preliminary_local"].includes(stored.status), JSON.stringify(stored));
    assert.equal(stored.local_approved_by, "za-manager");
  });

  await t.test("Sperren und unzulässige Zeiträume können auch ohne Vorprüfung nicht umgangen werden", async () => {
    db.prepare(`INSERT INTO request_blackouts (location_id, date_from, date_to, block_time_off, reason) VALUES ('93', '2031-09-22', '2031-09-23', 1, 'Test-Antragssperre')`).run();
    const blocked = await post("requests", allDay("2031-09-22"));
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
    assert.match(blocked.data.error || blocked.data.message, /Test-Antragssperre|Sperr/i);
    for (const body of [allDay("2031-02-30"), allDay("2031-10-10", "za-a", { dateTo: "2031-10-09" }),
      allDay("2031-01-01", "za-a", { dateTo: "2032-01-02" }),
      { employeeNumber: "za-a", date: "2031-09-25", startTime: "10:00", endTime: "09:00" }]) {
      assert.ok([400, 409].includes((await post("requests", body)).status));
    }
  });

  await t.test("temporäre Fremdfilialzuständigkeit bleibt geschützt und liefert keine fremden Slots", async () => {
    db.prepare(`INSERT INTO employee_location_lendings (id, employee_number, home_location_id, destination_location_id,
      date_from, date_to, all_day, note, status, revision, created_by, updated_by, created_at, updated_at)
      VALUES ('za-lending', 'za-a', '93', '94', '2031-09-26', '2031-09-26', 1, 'PRIVATE-LENDING', 'active', 1, 'test', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run();
    const result = await post("requests", allDay("2031-09-26"));
    assert.equal(result.status, 403, JSON.stringify(result.data));
    assert.equal(result.data.code, "BRANCH_TIME_OFF_RESPONSIBILITY_SCOPE");
    const slots = await request("branch-time-off/slots?date=2031-09-26&employeeNumber=za-a");
    assert.equal(slots.status, 200);
    assert.equal(slots.data.closed, true);
    assert.deepEqual(slots.data.slots, []);
    assert.doesNotMatch(JSON.stringify(slots.data), /94|PRIVATE|lending|assignmentId/);
    const mixed = await post("requests", allDay("2031-09-25", "za-a", { dateTo: "2031-09-26" }));
    assert.equal(mixed.status, 409);
    assert.equal(mixed.data.code, "TIME_OFF_MIXED_RESPONSIBILITY");
  });

  await t.test("persönliche Historien, Bearbeiten und Genehmigen bleiben für das Filialkonto gesperrt", async () => {
    for (const route of ["me/time-off-requests", "me/approved-time-off", "me/absence-requests"]) assert.equal((await request(route)).status, 403);
    for (const method of ["PUT", "DELETE"]) assert.equal((await request("me/time-off-requests/1", { method, body: allDay("2031-09-29") })).status, 403);
    assert.equal((await request("absence-requests/time_off/1/action", { method: "PUT", body: { action: "approve" } })).status, 403);
    const terminal = await request("organization-accounts", { method: "POST", session: hr,
      body: { ...input([permission]), loginName: "za-terminal", accountType: "terminal" } });
    assert.equal(terminal.status, 403);
    assert.deepEqual(new Set(installationFeaturesForApiPath("/portal/v1/branch-time-off/schedule")), new Set(["employeePortal", "requests", "schedule"]));
  });

  await t.test("ein nach der Prüfung entzogener Zugriff oder geändertes Team verhindert das Absenden", async () => {
    const body = allDay("2031-09-29");
    assert.equal((await post("check", body)).data.allowed, true);
    db.prepare("UPDATE employees SET active=0 WHERE personnel_number='za-a'").run();
    assert.equal((await post("requests", body)).status, 403);
    db.prepare("UPDATE employees SET active=1 WHERE personnel_number='za-a'").run();
    db.prepare("DELETE FROM portal_organization_account_permissions WHERE account_id=? AND permission=?").run(accountId, permission);
    assert.equal((await post("requests", body)).status, 403);
    await enable(false);
    assert.equal((await request("branch-time-off/employees")).status, 403);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM time_off_requests WHERE date_from='2031-09-29'").get().n, 0);
  });
});
