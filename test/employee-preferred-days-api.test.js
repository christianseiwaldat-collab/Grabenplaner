"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-ranked-days-"));
Object.assign(process.env, { DB_PATH: path.join(directory, "test.db"), BACKUP_DIR: path.join(directory, "backups"), GRABENPLANER_DATA_DIR: path.join(directory, "data"),
  GRABENPLANER_FORCE_PORTAL: "1", GRABENPLANER_SEED_DEMO: "1", NODE_ENV: "test", TZ: "Europe/Vienna" });
const { app, db, releaseInstanceLockForTests } = require("../server");
let server, base, auth, costCenter, target;
function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex"), csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO portal_users (employee_number,password_hash,role,role_locked,active,must_change_password) VALUES (?, 'test', ?, 0, 1, 0) ON CONFLICT(employee_number) DO UPDATE SET role=excluded.role, active=1, must_change_password=0").run(employeeNumber, role);
  db.prepare("INSERT INTO portal_sessions (id,employee_number,token_hash,expires_at) VALUES (?,?,?,'2099-01-01T00:00:00Z')").run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}
async function request(route, method = "GET", body, actor = auth) {
  const response = await fetch(base + route, { method, headers: { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); return { status: response.status, data };
}
function payload(extra = {}) {
  return { personnelNumber: target, fullName: "Test Person", nickname: "Dienstplan-Spitzname", contractedHours: 32, targetWorkdaysPerWeek: 4,
    positionId: "verkaufsmitarbeiter", costCenterId: costCenter, preferredDepartmentId: "", color: "#2469aa", active: true, fixedWorkdays: ["monday"], ...extra };
}
test.before(async () => {
  costCenter = db.prepare("SELECT cost_center_id FROM locations WHERE active=1 AND cost_center_id IS NOT NULL LIMIT 1").get().cost_center_id;
  target = "ranked-420";
  auth = session(db.prepare("SELECT personnel_number FROM employees WHERE active=1 LIMIT 1").get().personnel_number, "developer");
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); db.close(); releaseInstanceLockForTests();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

test("four ranked wishes persist, project the legacy first day, and survive older-client unrelated changes", async () => {
  const days = ["wednesday", "saturday", "monday", "friday"];
  const created = await request("/api/employees", "POST", payload({ preferredDaysOff: days }));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.preferredDayOff, "wednesday"); assert.deepEqual(created.data.preferredDaysOff, days);
  assert.equal(db.prepare("SELECT preferred_day_off FROM employees WHERE personnel_number=?").get(target).preferred_day_off, days.join(","));
  const listed = await request("/api/employees");
  const item = (Array.isArray(listed.data) ? listed.data : listed.data.employees).find(item => item.personnel_number === target);
  assert.equal(item.preferred_day_off, "wednesday"); assert.deepEqual(item.preferred_days_off, days);
  const updated = await request(`/api/employees/${target}`, "PUT", payload({ preferredDayOff: "wednesday", color: "#ff9900" }));
  assert.equal(updated.status, 200, JSON.stringify(updated.data)); assert.deepEqual(updated.data.preferredDaysOff, days);
  const invalid = await request(`/api/employees/${target}`, "PUT", payload({ preferredDaysOff: [...days, "tuesday"] }));
  assert.equal(invalid.status, 400); assert.equal(invalid.data.code, "EMPLOYEE_PREFERRED_DAYS_INVALID");
  assert.equal(db.prepare("SELECT preferred_day_off FROM employees WHERE personnel_number=?").get(target).preferred_day_off, days.join(","));
  const moved = await request(`/api/employees/${target}`, "PUT", payload({ preferredDaysOff: ["saturday", "wednesday"] }));
  assert.equal(moved.status, 200); assert.equal(moved.data.preferredDayOff, "saturday");
  const cleared = await request(`/api/employees/${target}`, "PUT", payload({ preferredDaysOff: [] }));
  assert.equal(cleared.status, 200); assert.deepEqual(cleared.data.preferredDaysOff, []);
});

test("protected name changes update only the public name; unrelated edits cannot replace it or reveal private fields", async () => {
  const saved = await request(`/api/portal/v1/personnel-records/${target}`, "PUT", {
    sensitive: { identity: { firstName: "Anna", lastName: "Beispiel", birthPlace: "Private birthplace" }, iban: "AT611904300234573201" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const employee = db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(target);
  assert.equal(employee.full_name, "Anna Beispiel"); assert.equal(employee.nickname, "Dienstplan-Spitzname"); assert.equal(employee.fixed_workdays, "monday");
  const updated = await request(`/api/employees/${target}`, "PUT", payload({ fullName: "Veralteter Name", preferredDaysOff: ["tuesday"] }));
  assert.equal(updated.status, 200, JSON.stringify(updated.data)); assert.equal(updated.data.fullName, "Anna Beispiel");
  assert(!JSON.stringify(updated.data).includes("Private birthplace")); assert(!JSON.stringify(updated.data).includes("AT611904300234573201"));
  const rename = await request(`/api/portal/v1/personnel-records/${target}`, "PUT", { sensitive: { identity: { lastName: "Neu" } } });
  assert.equal(rename.status, 200, JSON.stringify(rename.data));
  assert.equal(db.prepare("SELECT full_name FROM employees WHERE personnel_number=?").get(target).full_name, "Anna Neu");
  const restricted = session(target, "employee");
  const denied = await request(`/api/employees/${target}`, "PUT", payload({ preferredDaysOff: ["friday"] }), restricted);
  assert.equal(denied.status, 403);
  assert.equal(db.prepare("SELECT preferred_day_off FROM employees WHERE personnel_number=?").get(target).preferred_day_off, "tuesday");
});

test("reviewed imports preserve unmapped priorities and apply mapped ordered days through the integration repository", async () => {
  async function importDays(csv, mapping) {
    const inspected = await fetch(base + "/api/integrations/personnel-import/inspect", { method: "POST",
      headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "text/csv", "X-Import-Filename": "ranked-test.csv" }, body: csv });
    const inspection = await inspected.json();
    assert.equal(inspected.status, 201, JSON.stringify(inspection));
    const preview = await request("/api/integrations/personnel-import/preview", "POST", {
      inspectionId: inspection.inspectionId, sheetName: "CSV", headerRow: 1, duplicateStrategy: "update", mapping, defaults: {},
    });
    assert.equal(preview.status, 201, JSON.stringify(preview.data));
    assert.equal(preview.data.summary.errors, 0, JSON.stringify(preview.data));
    const applied = await request("/api/integrations/personnel-import/apply", "POST", { previewId: preview.data.previewId });
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
  }
  await importDays(`Personalnummer;Name;Wunschfrei\r\n${target};Alter Name;Mi|Sa|Mo|Fr\r\n`, {
    personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, preferredDaysOff: { columnIndex: 2 },
  });
  assert.equal(db.prepare("SELECT preferred_day_off FROM employees WHERE personnel_number=?").get(target).preferred_day_off, "wednesday,saturday,monday,friday");
  await importDays(`Personalnummer;Name;Planname\r\n${target};Alter Name;Neuer Spitzname\r\n`, {
    personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, nickname: { columnIndex: 2 },
  });
  const employee = db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(target);
  assert.equal(employee.preferred_day_off, "wednesday,saturday,monday,friday");
  assert.equal(employee.nickname, "Neuer Spitzname");
  assert.equal(employee.full_name, "Anna Neu");
});
