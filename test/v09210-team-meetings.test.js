"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v09210-team-meeting-"));
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

const LOCATION = "98";
const DEVELOPER = "9890";
const MEMBER_SICK_WITH_SHIFT = "9891";
const MEMBER_LATER_SICK = "9892";
const WEEK_START = "2035-03-12";
const MEETING_DATE = "2035-03-15";

let httpServer;
let baseUrl;
let departmentId;

function ensureEmployee(personnelNumber, positionId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, position_id, home_location_id,
       preferred_department_id, active)
    VALUES (?, ?, ?, '#3c806a', 38.5, 5, ?, ?, ?, 1)
  `).run(
    personnelNumber,
    `Teamsitzung ${personnelNumber}`,
    `TS${personnelNumber.slice(-1)}`,
    positionId,
    LOCATION,
    departmentId,
  );
}

function session(employeeNumber, role = "developer") {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, role_locked = 1,
      active = 1, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
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

async function request(route, { method = "GET", auth = null, body, binary = false } = {}) {
  const headers = { Accept: binary ? "application/pdf" : "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (binary) return { response, payload: Buffer.from(await response.arrayBuffer()) };
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text };
}

test.before(async () => {
  const positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  const daySettings = db.prepare("SELECT day_settings_json FROM locations ORDER BY id LIMIT 1").get()?.day_settings_json || "{}";
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Teamsitzungs-Testfiliale', 2, ?, 1)
  `).run(LOCATION, daySettings);
  departmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Testteam', 2, 1, 1)
  `).run(LOCATION).lastInsertRowid);
  ensureEmployee(DEVELOPER, positionId);
  ensureEmployee(MEMBER_SICK_WITH_SHIFT, positionId);
  ensureEmployee(MEMBER_LATER_SICK, positionId);
  db.prepare(`
    INSERT INTO week_options
      (employee_number, week_start, date_from, date_to, option_type, note, all_day)
    VALUES (?, ?, ?, ?, 'sick', 'Krank vor Teamsitzung', 1)
  `).run(MEMBER_SICK_WITH_SHIFT, WEEK_START, MEETING_DATE, MEETING_DATE);
  db.prepare(`
    INSERT INTO shifts
      (employee_number, location_id, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, '17:00', '20:00', 'Testteam', 'Bestehender Dienst trotz Krankmeldung')
  `).run(MEMBER_SICK_WITH_SHIFT, LOCATION, departmentId, MEETING_DATE);

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

test("v0.92.10: teamweite Teamsitzung ist atomar, krankheitsverträglich und bis 20 Uhr planbar", async () => {
  const auth = session(DEVELOPER);
  const body = {
    teamWide: true,
    locationId: LOCATION,
    departmentId,
    weekStart: WEEK_START,
    dateFrom: MEETING_DATE,
    dateTo: MEETING_DATE,
    optionType: "team_meeting",
    allDay: false,
    startTime: "18:00",
    endTime: "20:00",
    note: "Quartals-TS",
  };
  const created = await request("/api/week-options", { method: "POST", auth, body });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(created.payload.teamWide, true);
  assert.equal(created.payload.employeeCount, 3);
  assert.match(created.payload.groupId, /^team-meeting:/);

  const stored = db.prepare(`
    SELECT id, employee_number, start_time, end_time, note
    FROM week_options WHERE group_id = ? ORDER BY employee_number
  `).all(created.payload.groupId);
  assert.equal(stored.length, 3);
  assert.deepEqual(new Set(stored.map((row) => row.employee_number)), new Set([
    DEVELOPER,
    MEMBER_SICK_WITH_SHIFT,
    MEMBER_LATER_SICK,
  ]));
  assert.ok(stored.every((row) => row.start_time === "18:00" && row.end_time === "20:00"));

  const laterSickness = await request("/api/week-options", {
    method: "POST",
    auth,
    body: {
      employeeNumber: MEMBER_LATER_SICK,
      weekStart: WEEK_START,
      dateFrom: MEETING_DATE,
      dateTo: MEETING_DATE,
      optionType: "sick",
      allDay: true,
      note: "Krank nach Teamsitzungsplanung",
    },
  });
  assert.equal(laterSickness.response.status, 201, laterSickness.text);

  const schedule = await request(`/api/schedule?week=${WEEK_START}&locationId=${LOCATION}&departmentId=${departmentId}`, { auth });
  assert.equal(schedule.response.status, 200, schedule.text);
  const meetingRows = schedule.payload.weekOptions.filter((option) => option.group_id === created.payload.groupId);
  assert.equal(meetingRows.length, 3);
  assert.equal(meetingRows.find((option) => option.employee_number === DEVELOPER).credited_minutes, 120);
  assert.equal(meetingRows.find((option) => option.employee_number === MEMBER_SICK_WITH_SHIFT).credited_minutes, 0);
  assert.equal(meetingRows.find((option) => option.employee_number === MEMBER_LATER_SICK).credited_minutes, 0);

  const updated = await request(`/api/week-options/${created.payload.id}`, {
    method: "PUT",
    auth,
    body: { ...body, startTime: "18:30", endTime: "20:00", note: "Quartals-TS aktualisiert" },
  });
  assert.equal(updated.response.status, 200, updated.text);
  assert.equal(updated.payload.employeeCount, 3);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM week_options
    WHERE group_id = ? AND start_time = '18:30' AND end_time = '20:00'
      AND note = 'Quartals-TS aktualisiert'
  `).get(created.payload.groupId).count, 3);

  const pdf = await request(`/api/schedule.pdf?week=${WEEK_START}&locationId=${LOCATION}&departmentId=${departmentId}`, {
    auth,
    binary: true,
  });
  assert.equal(pdf.response.status, 200);
  assert.match(pdf.response.headers.get("content-type") || "", /application\/pdf/);
  assert.ok(pdf.payload.length > 3000);

  const deleted = await request(`/api/week-options/${created.payload.id}`, { method: "DELETE", auth });
  assert.equal(deleted.response.status, 204, deleted.text);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM week_options WHERE group_id = ?")
    .get(created.payload.groupId).count, 0);
  const actions = db.prepare(`
    SELECT action FROM audit_log
    WHERE entity_type = 'team_meeting' AND entity_id = ? ORDER BY id
  `).all(created.payload.groupId).map((row) => row.action);
  assert.deepEqual(actions, ["team-meeting.create", "team-meeting.update", "team-meeting.delete"]);
});

test("v0.92.10: UI kennzeichnet Teamsitzung und ordnet Kontakt sowie Darkmode kompakt an", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(html, /id="sidebarVersion"[\s\S]*class="sidebar-developer-text"/);
  assert.match(html, /<span class="sidebar-developer-text">Developer-Kontakt · christian\.seiwald\.at@gmail\.com<\/span>/);
  assert.doesNotMatch(html, /sidebar-developer-text[^>]+href=/);
  assert.doesNotMatch(html, /class="sidebar-developer-contact"/);
  assert.match(html, /id="sidebarSessionInfo"[\s\S]*id="sidebarDarkmodeToggle"[\s\S]*role="switch"/);
  assert.match(html, /id="optionTeamWide"[\s\S]*gesamtes Team/);
  assert.match(appSource, /teamMeetingBands[\s\S]*class="team-meeting-band"/);
  assert.match(appSource, /#optionStartTime"\)\.value = "18:00"[\s\S]*#optionEndTime"\)\.value = "20:00"/);
  assert.match(css, /\.team-meeting-band[\s\S]*border:2px solid #68448f/);
  assert.match(css, /\.sidebar-session[\s\S]*grid-template-columns:minmax\(0,1fr\) auto/);
});
