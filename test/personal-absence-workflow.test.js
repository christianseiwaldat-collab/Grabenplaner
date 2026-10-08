"use strict";

const assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), test = require("node:test");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-personal-absences-"));
Object.assign(process.env, { DB_PATH: path.join(testRoot, "data.db"), BACKUP_DIR: path.join(testRoot, "backups"),
  GRABENPLANER_DATA_DIR: path.join(testRoot, "data"), GRABENPLANER_HOST: "127.0.0.1", GRABENPLANER_FORCE_PORTAL: "1",
  GRABENPLANER_SEED_DEMO: "1", GRABENPLANER_TEST_TODAY: "2031-04-01", NODE_ENV: "test", TZ: "Europe/Vienna" });
const subject = require("../server"), { app, db, releaseInstanceLockForTests } = subject;
const LOCATION = "absence-branch", EMPLOYEE = "absence-sales", OTHER = "absence-other";
let server, url;
const sessions = new Map();

function auth(number) {
  const token = crypto.randomBytes(24).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_sessions(id,employee_number,token_hash,expires_at) VALUES(?,?,?,'2099-01-01T00:00:00Z')")
    .run(crypto.randomUUID(), number, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function api(route, number = EMPLOYEE, { method = "GET", body } = {}) {
  const actor = sessions.get(number);
  const response = await fetch(url + route, { method, headers: { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf,
    "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

test.before(async () => {
  db.prepare("INSERT INTO cost_centers(id,code,name,type,cost_center_type_id,active) VALUES('absence-cc','ABS','BEISPIEL Filiale','branch','branch',1)").run();
  const days = JSON.stringify(Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    .map(day => [day, { open: true, start: "09:00", end: "18:00", minStaff: 3, minFrom: "09:00", minTo: "18:00", lunchEnabled: false }])));
  db.prepare("INSERT INTO locations(id,name,cost_center_id,min_staff,day_settings_json,active) VALUES(?,'BEISPIEL Filiale','absence-cc',3,?,1)").run(LOCATION, days);
  for (const [number, role] of [[EMPLOYEE, "employee"], [OTHER, "employee"], ["absence-fl", "manager"],
    ["absence-al", "department_manager"], ["absence-pl", "location_planner"], ["absence-hr", "hr"], ["absence-it", "it_admin"], ["absence-admin", "admin"]]) {
    db.prepare("INSERT INTO employees(personnel_number,full_name,nickname,home_location_id,cost_center_id,position_id,active) VALUES(?,?,?,?,'absence-cc','verkaufsmitarbeiter',1)").run(number, `BEISPIEL ${number}`, number, LOCATION);
    db.prepare("INSERT INTO portal_users(employee_number,password_hash,role,active,must_change_password,password_changed_at) VALUES(?,'test',?,1,0,CURRENT_TIMESTAMP)").run(number, role);
    if (["manager", "department_manager"].includes(role)) db.prepare("INSERT INTO portal_access_scopes(employee_number,location_id,assigned_by) VALUES(?,?,?)").run(number, LOCATION, number);
    sessions.set(number, auth(number));
  }
  // Only these two employees have capacity on the warning test day.
  db.prepare("UPDATE employees SET fixed_workdays='monday' WHERE personnel_number LIKE 'absence-%' AND personnel_number NOT IN (?,?)").run(EMPLOYEE, OTHER);
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close(); releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("regular employee and leadership defaults have own request access; specialized planner stays restricted until granted", async () => {
  for (const number of sessions.keys()) {
    const actor = await subject.loadPortalSessionFromRequest({ headers: { cookie: sessions.get(number).cookie } }, { touch: false });
    for (const right of ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:write"]) {
      assert.equal(actor.permissions.includes(right), number !== "absence-pl", `${number}: ${right}`);
    }
  }
  const actor = await subject.loadPortalSessionFromRequest({ headers: { cookie: sessions.get(EMPLOYEE).cookie } }, { touch: false });
  assert(!actor.permissions.includes("vacation:approve"));
  for (const right of ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:write"]) {
    db.prepare("INSERT INTO portal_permission_grants(employee_number,permission,granted_by) VALUES('absence-pl',?,'absence-admin')").run(right);
  }
  for (const route of ["vacation", "time-off"]) {
    const response = await api(`/api/portal/v1/me/${route}-check`, "absence-pl", {
      method: "POST", body: { dateFrom: "2032-03-31", dateTo: "2032-03-31", allDay: true },
    });
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.notEqual(response.data.submissionAllowed, false);
  }
});

test("365th future day is accepted and a crossing/366th-day period cannot be submitted", async () => {
  for (const [kind, route, body] of [["VACATION", "vacation", { dateFrom: "2032-03-31", dateTo: "2032-03-31" }],
    ["TIME_OFF", "time-off", { dateFrom: "2032-03-31", dateTo: "2032-03-31", allDay: true }]]) {
    const check = await api(`/api/portal/v1/me/${route}-check`, EMPLOYEE, { method: "POST", body });
    assert.equal(check.status, 200, JSON.stringify(check));
    assert(!String(check.data.code).endsWith("REQUEST_HORIZON"));
    const created = await api(`/api/portal/v1/me/${route}-requests`, EMPLOYEE, { method: "POST", body });
    assert.equal(created.status, 201, JSON.stringify(created));
    await api(`/api/portal/v1/me/${route}-requests/${created.data.id}`, EMPLOYEE, { method: "DELETE", body: {} });
    for (const beyond of [{ ...body, dateTo: "2032-04-01" }, { ...body, dateFrom: "2032-04-01", dateTo: "2032-04-01" }]) {
      const invalid = await api(`/api/portal/v1/me/${route}-requests`, EMPLOYEE, { method: "POST", body: beyond });
      assert([400, 409].includes(invalid.status), JSON.stringify(invalid));
      assert.equal(invalid.data.code, `${kind}_REQUEST_HORIZON`);
    }
  }
});

test("red staffing permits pending vacation/ZA creation, editing and withdrawal; ownership and approval stay enforced", async () => {
  const day = "2031-04-08";
  for (const [route, body] of [["vacation", { dateFrom: day, dateTo: day }],
    ["time-off", { dateFrom: day, dateTo: day, startTime: "10:00", endTime: "11:00" }]]) {
    if (route === "time-off") db.prepare("INSERT INTO shifts(employee_number,location_id,shift_date,start_time,end_time) VALUES(?,?,?,'09:00','18:00')").run(EMPLOYEE, LOCATION, day);
    const check = await api(`/api/portal/v1/me/${route}-check`, EMPLOYEE, { method: "POST", body });
    assert.equal(check.status, 200, JSON.stringify(check));
    assert.equal(check.data.trafficLight, "red"); assert.equal(check.data.allowed, false);
    assert.equal(check.data.submissionAllowed, true);
    const created = await api(`/api/portal/v1/me/${route}-requests`, EMPLOYEE, { method: "POST", body });
    assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.data.id;
    const approval = await api(`/api/portal/v1/absence-requests/${route === "time-off" ? "time_off" : "vacation"}/${id}/action`,
      "absence-admin", { method: "PUT", body: { action: "approve", note: "BEISPIEL Prüfung" } });
    assert.equal(approval.status, 409, JSON.stringify(approval));
    assert.match(approval.data.code || approval.data.error, /STAFFING_INSUFFICIENT|Mindestbesetzung/, JSON.stringify(approval));
    assert.equal((await api(`/api/portal/v1/me/${route}-requests/${id}`, OTHER, { method: "PUT", body })).status, 404);
    assert.equal((await api(`/api/portal/v1/me/${route}-requests/${id}`, OTHER, { method: "DELETE", body: {} })).status, 404);
    const ownList = await api(`/api/portal/v1/me/${route}-requests`);
    assert(ownList.data.requests.some(item => Number(item.id) === id));
    assert(!(await api(`/api/portal/v1/me/${route}-requests`, OTHER)).data.requests.some(item => Number(item.id) === id));
    const edited = await api(`/api/portal/v1/me/${route}-requests/${id}`, EMPLOYEE, { method: "PUT", body: { ...body, note: "BEISPIEL geändert" } });
    assert.equal(edited.status, 200, JSON.stringify(edited));
    assert.equal((await api(`/api/portal/v1/me/${route}-requests/${id}`, EMPLOYEE, { method: "DELETE", body: {} })).status, 204);
    assert.equal((await api(`/api/portal/v1/me/${route}-requests/${id}`, EMPLOYEE, { method: "PUT", body })).status, 404);
  }
  const allDay = await api("/api/portal/v1/me/time-off-check", EMPLOYEE,
    { method: "POST", body: { dateFrom: day, dateTo: day, allDay: true } });
  assert.equal(allDay.data.trafficLight, "red"); assert.equal(allDay.data.submissionAllowed, true);
});

test("explicit blackouts and individual denial still block requests", async () => {
  const day = "2031-04-09";
  db.prepare("INSERT INTO request_blackouts(location_id,date_from,date_to,block_vacation,block_time_off,reason,active,created_by) VALUES(?,?,?,1,1,'BEISPIEL Sperre',1,'absence-fl')").run(LOCATION, day, day);
  for (const route of ["vacation", "time-off"]) {
    const body = { dateFrom: day, dateTo: day, allDay: true };
    const check = await api(`/api/portal/v1/me/${route}-check`, EMPLOYEE, { method: "POST", body });
    assert.equal(check.data.allowed, false); assert.notEqual(check.data.submissionAllowed, true);
    assert.equal((await api(`/api/portal/v1/me/${route}-requests`, EMPLOYEE, { method: "POST", body })).status, 409);
  }
  db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES(?,'own_vacation:request','absence-fl')").run(EMPLOYEE);
  assert.equal((await api("/api/portal/v1/me/vacation-requests", EMPLOYEE, { method: "POST", body: { dateFrom: "2031-04-10", dateTo: "2031-04-10" } })).status, 403);
  db.prepare("INSERT INTO portal_permission_denials(employee_number,permission,denied_by) VALUES(?,'own_time:write','absence-fl')").run(EMPLOYEE);
  assert.equal((await api("/api/portal/v1/me/time-off-requests", EMPLOYEE, { method: "POST", body: { dateFrom: "2031-04-10", dateTo: "2031-04-10", allDay: true } })).status, 403);
});
