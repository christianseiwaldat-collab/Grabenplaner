const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v055-time-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { db } = subject;

function viennaTimestamp(date, time) {
  return new Date(`${date}T${time}:00+02:00`).toISOString();
}

function entry(id, date, type, time) {
  return {
    id,
    work_date: date,
    entry_type: type,
    entry_timestamp: viennaTimestamp(date, time),
  };
}

function issueCodes(evaluation) {
  return (evaluation.issues || []).map((issue) => issue.code);
}

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM time_day_reviews").run();
    db.prepare("DELETE FROM time_corrections").run();
    db.prepare("DELETE FROM time_entries").run();
    db.prepare("DELETE FROM shifts").run();
    db.prepare("DELETE FROM week_options").run();
    db.prepare(`
      UPDATE locations
      SET time_tracking_enabled = 1,
          time_tracking_access_mode = 'anywhere',
          time_tracking_allowed_networks = '',
          time_tracking_variance_minutes = 15
      WHERE id = '01'
    `).run();
    const setting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    setting.run("break_rule_enabled", "1");
    setting.run("break_after_minutes", "360");
    setting.run("break_duration_minutes", "30");
    setting.run("saturday_bonus_enabled", "1");
    setting.run("saturday_bonus_from", "13:00");
    setting.run("saturday_bonus_factor", "1.5");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function insertShift(employeeNumber, date, startTime, endTime) {
  db.prepare(`
    INSERT INTO shifts (employee_number, shift_date, start_time, end_time, area)
    VALUES (?, ?, ?, ?, 'v0.55 Test')
  `).run(employeeNumber, date, startTime, endTime);
}

function insertEntries(employeeNumber, date, values) {
  const insert = db.prepare(`
    INSERT INTO time_entries
      (employee_number, location_id, work_date, entry_type, entry_timestamp, source, created_by)
    VALUES (?, '01', ?, ?, ?, 'test', ?)
  `);
  for (const value of values) {
    insert.run(employeeNumber, date, value.type, viennaTimestamp(date, value.time), employeeNumber);
  }
}

function createPortalSession(employeeNumber, role, permissions = [], scopes = []) {
  const token = `v055-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role, active = 1, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  const grant = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, 'v055-test')
  `);
  for (const permission of permissions) grant.run(employeeNumber, permission);
  const assignScope = db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, 'v055-test')
  `);
  for (const scope of scopes) assignScope.run(employeeNumber, scope.locationId, Number(scope.departmentId || 0));
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function requestJson(baseUrl, route, { method = "GET", session = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = response.status === 204 ? "" : await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

test.beforeEach(resetFixture);

test.after(() => {
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.55: CIDR-Helfer unterscheiden private, konfigurierte und fremde Netze", () => {
  const { ipMatchesNetwork, isPrivateNetworkIp } = subject;

  assert.equal(ipMatchesNetwork("192.168.18.42", "192.168.18.0/24"), true);
  assert.equal(ipMatchesNetwork("192.168.19.42", "192.168.18.0/24"), false);
  assert.equal(ipMatchesNetwork("::ffff:192.168.18.42", "192.168.18.0/24"), true);
  assert.equal(ipMatchesNetwork("fd12:3456::20", "fd12:3456::/48"), true);
  assert.equal(ipMatchesNetwork("fd12:3457::20", "fd12:3456::/48"), false);
  assert.equal(ipMatchesNetwork("203.0.113.7", "203.0.113.7"), true);
  assert.equal(ipMatchesNetwork("203.0.113.7", "203.0.113.0/99"), false);
  assert.equal(ipMatchesNetwork("keine-ip", "192.168.0.0/16"), false);

  for (const privateIp of ["127.0.0.1", "10.24.1.8", "172.16.0.1", "172.31.255.254", "192.168.1.10", "fc00::10", "fe80::20"]) {
    assert.equal(isPrivateNetworkIp(privateIp), true, `${privateIp} muss als privat gelten.`);
  }
  for (const publicIp of ["172.32.0.1", "8.8.8.8", "203.0.113.10", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateNetworkIp(publicIp), false, `${publicIp} darf nicht als privat gelten.`);
  }
});

test("v0.55: Buchungszugriff erlaubt überall, private Netze und explizite CIDRs", () => {
  const request = (ip) => ({ ip, socket: { remoteAddress: ip } });
  const anywhere = { time_tracking_access_mode: "anywhere", time_tracking_allowed_networks: "" };
  const restricted = { time_tracking_access_mode: "trusted_network", time_tracking_allowed_networks: "203.0.113.0/24, fd12:3456::/48" };

  assert.equal(subject.timeTrackingRequestAccess(request("8.8.8.8"), anywhere).allowed, true);
  assert.equal(subject.timeTrackingRequestAccess(request("192.168.18.24"), restricted).allowed, true);
  assert.equal(subject.timeTrackingRequestAccess(request("203.0.113.42"), restricted).allowed, true);
  assert.equal(subject.timeTrackingRequestAccess(request("fd12:3456::42"), restricted).allowed, true);
  const denied = subject.timeTrackingRequestAccess(request("198.51.100.42"), restricted);
  assert.equal(denied.allowed, false);
  assert.equal(denied.mode, "trusted_network");
  assert.match(denied.reason, /Firmennetz/i);
});

test("v0.88.5: nur explizite Pausen zählen, eine echte Split-Dienstlücke nicht", () => {
  const date = "2026-07-11";
  const entries = [
    entry(1, date, "clock_in", "09:00"),
    entry(2, date, "break_start", "12:00"),
    entry(3, date, "break_end", "12:15"),
    entry(4, date, "clock_out", "14:00"),
    entry(5, date, "clock_in", "15:00"),
    entry(6, date, "break_start", "16:00"),
    entry(7, date, "break_end", "16:15"),
    entry(8, date, "clock_out", "17:00"),
  ];

  const result = subject.parseTimeEntrySequence(entries, date, new Date("2026-07-12T12:00:00Z"));
  assert.equal(result.state, "off");
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.segments.length, 4);
  assert.equal(result.workedMinutes, 390);
  assert.equal(result.breakMinutes, 30, "Nur break_start bis break_end zählt als Pause; die Stunde zwischen zwei Diensten nicht.");
});

test("v0.88.5: Gehen aus einer laufenden Pause schließt die explizite Pause korrekt", () => {
  const date = "2026-07-10";
  const result = subject.parseTimeEntrySequence([
    entry(1, date, "clock_in", "09:00"),
    entry(2, date, "break_start", "12:00"),
    entry(3, date, "clock_out", "12:30"),
  ], date, new Date("2026-07-11T12:00:00Z"));

  assert.equal(result.state, "off");
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.workedMinutes, 180);
  assert.equal(result.breakMinutes, 30);
});

test("v0.55: Samstagsfaktor wird nur auf tatsächlich gearbeitete Minuten ab 13 Uhr angewendet", () => {
  const date = "2026-07-11";
  const entries = [
    entry(1, date, "clock_in", "09:00"),
    entry(2, date, "break_start", "12:00"),
    entry(3, date, "break_end", "12:15"),
    entry(4, date, "clock_out", "14:00"),
    entry(5, date, "clock_in", "15:00"),
    entry(6, date, "break_start", "16:00"),
    entry(7, date, "break_end", "16:15"),
    entry(8, date, "clock_out", "17:00"),
  ];
  const settings = {
    saturday_bonus_enabled: "1",
    saturday_bonus_from: "13:00",
    saturday_bonus_factor: "1.5",
  };

  const result = subject.actualDayMetrics(entries, date, settings, new Date("2026-07-12T12:00:00Z"));
  assert.equal(result.workedMinutes, 390);
  assert.equal(result.saturdayEligibleMinutes, 165);
  assert.equal(result.saturdayBonusMinutes, 83);
  assert.equal(result.valuedMinutes, 473);
});

test("v0.88.5: ungültige Samstagswerte verwenden auch bei Ist-Zeiten den sicheren Standard", () => {
  const date = "2026-07-11";
  const entries = [
    entry(1, date, "clock_in", "09:00"),
    entry(2, date, "break_start", "12:00"),
    entry(3, date, "break_end", "12:15"),
    entry(4, date, "clock_out", "14:00"),
    entry(5, date, "clock_in", "15:00"),
    entry(6, date, "break_start", "16:00"),
    entry(7, date, "break_end", "16:15"),
    entry(8, date, "clock_out", "17:00"),
  ];
  const result = subject.actualDayMetrics(entries, date, {
    saturday_bonus_enabled: "1",
    saturday_bonus_from: "ungültig",
    saturday_bonus_factor: "NaN",
  }, new Date("2026-07-12T12:00:00Z"));

  assert.equal(result.workedMinutes, 390);
  assert.equal(result.saturdayEligibleMinutes, 165);
  assert.equal(result.saturdayBonusMinutes, 83);
  assert.equal(result.valuedMinutes, 473);
  assert.ok(Number.isFinite(result.valuedMinutes));
});

test("v0.55: Tagesbewertung erkennt fehlende Buchungen, offenen Abschluss und zu kurze Pause", async () => {
  const now = new Date("2026-07-20T10:00:00Z");

  insertShift("103", "2026-07-10", "09:00", "17:00");
  const missing = await subject.evaluateTimeDay("103", "2026-07-10", now);
  assert.equal(missing.code, "missing_entries");
  assert.ok(issueCodes(missing).includes("missing_entries"));

  insertShift("104", "2026-07-09", "09:00", "17:00");
  insertEntries("104", "2026-07-09", [{ type: "clock_in", time: "09:00" }]);
  const incomplete = await subject.evaluateTimeDay("104", "2026-07-09", now);
  assert.equal(incomplete.incomplete, true);
  assert.ok(issueCodes(incomplete).includes("incomplete"));

  insertShift("105", "2026-07-08", "09:00", "16:01");
  insertEntries("105", "2026-07-08", [
    { type: "clock_in", time: "09:00" },
    { type: "break_start", time: "12:00" },
    { type: "break_end", time: "12:10" },
    { type: "clock_out", time: "16:01" },
  ]);
  const shortBreak = await subject.evaluateTimeDay("105", "2026-07-08", now);
  assert.equal(shortBreak.actualMinutes, 411);
  assert.equal(shortBreak.breakMinutes, 10);
  assert.equal(shortBreak.requiredBreakMinutes, 30);
  assert.ok(issueCodes(shortBreak).includes("break_short"));
});

test("v0.88.5: Portal-Zeitwerte trennen Ist-Zeit und Abwesenheitsgutschrift", async () => {
  db.prepare(`
    UPDATE employees
    SET contracted_hours = 32, home_location_id = '01', active = 1
    WHERE personnel_number = '102'
  `).run();
  insertShift("102", "2026-07-06", "09:00", "17:00");
  const insertOption = db.prepare(`
    INSERT INTO week_options
      (employee_number, week_start, date_from, date_to, option_type, note, credited_minutes_per_day, all_day)
    VALUES ('102', '2026-07-06', ?, ?, ?, 'v0.88.5 Zeitwert', ?, 1)
  `);
  insertOption.run("2026-07-06", "2026-07-06", "vacation", null);
  insertOption.run("2026-07-07", "2026-07-07", "other", 120);

  const holiday = await subject.evaluateTimeDay("102", "2026-05-01", new Date("2026-07-20T12:00:00Z"));
  assert.equal(holiday.excused.label, "Feiertag");
  assert.equal(holiday.actualMinutes, 0);
  assert.equal(holiday.actualValuedMinutes, 0);
  assert.equal(holiday.absenceCreditedMinutes, 384);
  assert.equal(holiday.valuedMinutes, 384);
  assert.equal(holiday.valuedDifferenceMinutes, 384);
  assert.equal(holiday.evaluationVersion, "v2");

  const weekendHoliday = await subject.evaluateTimeDay("102", "2026-08-15", new Date("2026-08-20T12:00:00Z"));
  assert.equal(weekendHoliday.excused.label, "Feiertag");
  assert.equal(weekendHoliday.absenceCreditedMinutes, 0);
  assert.equal(weekendHoliday.valuedMinutes, 0);

  const employee = createPortalSession("102", "employee");
  const manager = createPortalSession("105", "manager", ["time:read"], [{ locationId: "01" }]);
  const httpServer = subject.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  try {
    const result = await requestJson(
      baseUrl,
      "/api/portal/v1/me/time-summary?period=week&anchor=2026-07-06",
      { session: employee },
    );
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    const summary = result.payload.summary;
    const vacation = summary.days.find((day) => day.date === "2026-07-06");
    const other = summary.days.find((day) => day.date === "2026-07-07");

    assert.equal(vacation.plannedMinutes, 450);
    assert.equal(vacation.actualMinutes, 0);
    assert.equal(vacation.actualValuedMinutes, 0);
    assert.equal(vacation.absenceCreditedMinutes, 384);
    assert.equal(vacation.valuedMinutes, 384);
    assert.equal(vacation.differenceMinutes, -450);
    assert.equal(vacation.valuedDifferenceMinutes, -66);
    assert.equal(other.absenceCreditedMinutes, 120);
    assert.equal(other.valuedMinutes, 120);
    assert.equal(other.valuedDifferenceMinutes, 120);
    assert.equal(summary.totals.actualMinutes, 0);
    assert.equal(summary.totals.actualValuedMinutes, 0);
    assert.equal(summary.totals.absenceCreditedMinutes, 504);
    assert.equal(summary.totals.valuedMinutes, 504);
    assert.equal(summary.totals.differenceMinutes, -450);
    assert.equal(summary.totals.valuedDifferenceMinutes, 54);

    const managementResult = await requestJson(
      baseUrl,
      "/api/portal/v1/time-summary?locationId=01&from=2026-07-06&to=2026-07-12",
      { session: manager },
    );
    assert.equal(managementResult.response.status, 200, JSON.stringify(managementResult.payload));
    const managementEmployee = managementResult.payload.summary.employees
      .find((entryValue) => entryValue.employeeNumber === "102");
    assert.equal(managementEmployee.actualValuedMinutes, 0);
    assert.equal(managementEmployee.absenceCreditedMinutes, 504);
    assert.equal(managementEmployee.valuedMinutes, 504);
    assert.equal(managementEmployee.valuedDifferenceMinutes, 54);
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("v0.88.5: Portal zeigt Gewertet und Differenz aus Gesamtwertung statt nur aus Ist-Zeit", () => {
  const portalSource = fs.readFileSync(path.join(__dirname, "..", "public", "portal.js"), "utf8");
  const managementSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(portalSource, /timeWeighted\.textContent = durationText\(data\.valuedMinutes/);
  assert.match(portalSource, /const valuedDifferenceMinutes = data\.valuedDifferenceMinutes/);
  assert.match(portalSource, /\["Gewertet", totals\.valuedMinutes/);
  assert.match(portalSource, /\["Differenz", totals\.valuedDifferenceMinutes/);
  assert.match(portalSource, /durationText\(day\.valuedMinutes\)/);
  assert.match(portalSource, /const difference = Number\(day\.valuedDifferenceMinutes/);
  assert.match(managementSource, /formatHours\(employee\.valuedMinutes \?\? employee\.actualValuedMinutes\)/);
  assert.match(managementSource, /formatTimeDifference\(employee\.valuedDifferenceMinutes \?\? employee\.differenceMinutes\)/);
  assert.match(managementSource, /formatHours\(entry\.valuedMinutes \?\? entry\.actualValuedMinutes\)/);
  assert.match(managementSource, /formatTimeDifference\(entry\.valuedDifferenceMinutes \?\? entry\.differenceMinutes\)/);
});

test("v0.55: Korrekturen akzeptieren mehrere Pausen und einen zweiten Dienst", () => {
  const entries = [
    { type: "clock_in", time: "09:00" },
    { type: "break_start", time: "11:00" },
    { type: "break_end", time: "11:15" },
    { type: "clock_out", time: "13:00" },
    { type: "clock_in", time: "14:00" },
    { type: "break_start", time: "16:00" },
    { type: "break_end", time: "16:15" },
    { type: "clock_out", time: "17:00" },
  ];

  assert.deepEqual(
    subject.validateProposedTimeEntries("2026-07-07", entries, new Date("2026-07-20T10:00:00Z")),
    entries,
  );
  assert.throws(
    () => subject.validateProposedTimeEntries("2026-07-07", entries.slice(0, -1), new Date("2026-07-20T10:00:00Z")),
    (error) => error?.code === "TIME_CORRECTION_INVALID",
  );
});

test("v0.55: Tagesreview-API wahrt delegierte Abteilungsscopes und wird durch Korrekturen invalidiert", async () => {
  const date = "2026-07-07";
  const departmentA = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES ('01', 'v0.55 Bereich A', 1, 1, 551)
  `).run().lastInsertRowid);
  const departmentB = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES ('01', 'v0.55 Bereich B', 1, 1, 552)
  `).run().lastInsertRowid);
  db.prepare("UPDATE employees SET preferred_department_id = ? WHERE personnel_number = '102'").run(departmentA);
  db.prepare("UPDATE employees SET preferred_department_id = ? WHERE personnel_number = '103'").run(departmentB);
  db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area)
    VALUES ('102', ?, ?, '09:00', '17:00', 'v0.55 Test')
  `).run(departmentA, date);
  db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area)
    VALUES ('103', ?, ?, '09:00', '17:00', 'v0.55 Test')
  `).run(departmentB, date);

  const reviewer = createPortalSession("106", "employee", ["time:read", "time:review"], [
    { locationId: "01", departmentId: departmentA },
  ]);
  const employee = createPortalSession("102", "employee");
  const httpServer = subject.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  try {
    const allowed = await requestJson(baseUrl, `/api/portal/v1/time-day-evaluations?locationId=01&departmentId=${departmentA}&date=${date}`, { session: reviewer });
    assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
    assert.ok(allowed.payload.dayReview.evaluations.some((value) => value.employeeNumber === "102"));
    assert.equal(allowed.payload.dayReview.evaluations.some((value) => value.employeeNumber === "103"), false);

    const wholeLocation = await requestJson(baseUrl, `/api/portal/v1/time-day-evaluations?locationId=01&date=${date}`, { session: reviewer });
    assert.equal(wholeLocation.response.status, 403, JSON.stringify(wholeLocation.payload));
    assert.equal(wholeLocation.payload.code, "PORTAL_SCOPE_DENIED");

    const foreignDepartment = await requestJson(baseUrl, `/api/portal/v1/time-day-evaluations?locationId=01&departmentId=${departmentB}&date=${date}`, { session: reviewer });
    assert.equal(foreignDepartment.response.status, 403, JSON.stringify(foreignDepartment.payload));
    assert.equal(foreignDepartment.payload.code, "PORTAL_SCOPE_DENIED");

    const review = await requestJson(baseUrl, `/api/portal/v1/time-day-reviews/102/${date}`, {
      method: "PUT",
      session: reviewer,
      body: { locationId: "01", departmentId: departmentA, reviewed: true, note: "Tagesprüfung abgeschlossen" },
    });
    assert.equal(review.response.status, 200, JSON.stringify(review.payload));
    assert.equal(review.payload.evaluation.review.reviewedBy, "106");
    assert.equal(review.payload.evaluation.review.note, "Tagesprüfung abgeschlossen");
    assert.equal(review.payload.evaluation.review.snapshot.actualValuedMinutes, 0);
    assert.equal(review.payload.evaluation.review.snapshot.absenceCreditedMinutes, 0);
    assert.equal(review.payload.evaluation.review.snapshot.valuedMinutes, 0);
    assert.equal(review.payload.evaluation.review.snapshot.valuedDifferenceMinutes, -450);

    const correctedEntries = [
      { type: "clock_in", time: "09:00" },
      { type: "break_start", time: "11:00" },
      { type: "break_end", time: "11:15" },
      { type: "clock_out", time: "13:00" },
      { type: "clock_in", time: "14:00" },
      { type: "break_start", time: "16:00" },
      { type: "break_end", time: "16:15" },
      { type: "clock_out", time: "17:00" },
    ];
    const correction = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", {
      method: "POST",
      session: employee,
      body: { correctionDate: date, requestedEntries: correctedEntries, reason: "Geteilter Dienst" },
    });
    assert.equal(correction.response.status, 201, JSON.stringify(correction.payload));
    assert.equal(correction.payload.correction.proposedEntries.length, 8);

    const afterCorrection = await requestJson(baseUrl, `/api/portal/v1/time-day-evaluations?locationId=01&departmentId=${departmentA}&date=${date}`, { session: reviewer });
    assert.equal(afterCorrection.response.status, 200, JSON.stringify(afterCorrection.payload));
    const changedDay = afterCorrection.payload.dayReview.evaluations.find((value) => value.employeeNumber === "102");
    assert.equal(changedDay.review, null, "Ein neuer Korrekturantrag muss eine frühere Tagesprüfung aufheben.");
    assert.ok(issueCodes(changedDay).includes("pending_correction"));
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("v0.55: Abteilungsleitungen dürfen bereichsübergreifende Zeitkorrekturen nicht freigeben", async () => {
  const date = "2026-07-08";
  const departmentA = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES ('01', 'v0.55 Korrektur A', 1, 1, 561)
  `).run().lastInsertRowid);
  const departmentB = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES ('01', 'v0.55 Korrektur B', 1, 1, 562)
  `).run().lastInsertRowid);
  db.prepare("UPDATE employees SET preferred_department_id = ? WHERE personnel_number = '102'").run(departmentA);
  const shift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area)
    VALUES ('102', ?, ?, ?, ?, 'v0.55 Korrektur')
  `);
  shift.run(departmentA, date, "09:00", "12:00");
  shift.run(departmentB, date, "13:00", "17:00");
  const insertEntry = db.prepare(`
    INSERT INTO time_entries
      (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, created_by)
    VALUES ('102', '01', ?, ?, ?, ?, 'test', '102')
  `);
  for (const value of [
    { departmentId: departmentA, type: "clock_in", time: "09:00" },
    { departmentId: departmentA, type: "clock_out", time: "12:00" },
    { departmentId: departmentB, type: "clock_in", time: "13:00" },
    { departmentId: departmentB, type: "clock_out", time: "17:00" },
  ]) {
    insertEntry.run(value.departmentId, date, value.type, viennaTimestamp(date, value.time));
  }

  const employee = createPortalSession("102", "employee");
  const departmentReviewer = createPortalSession("106", "department_manager", ["time:review"], [
    { locationId: "01", departmentId: departmentA },
  ]);
  const locationReviewer = createPortalSession("105", "manager", ["time:review"], [
    { locationId: "01" },
  ]);
  const httpServer = subject.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  try {
    const proposedEntries = [
      { type: "clock_in", time: "09:00" },
      { type: "clock_out", time: "12:00" },
      { type: "clock_in", time: "13:00" },
      { type: "clock_out", time: "17:00" },
    ];
    const request = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", {
      method: "POST",
      session: employee,
      body: { correctionDate: date, requestedEntries: proposedEntries, reason: "Zwei Abteilungen" },
    });
    assert.equal(request.response.status, 201, JSON.stringify(request.payload));
    assert.equal(request.payload.correction.departmentId, null);
    assert.equal(request.payload.correction.requestedChange.crossDepartment, true);
    const correctionId = request.payload.correction.id;

    const denied = await requestJson(baseUrl, `/api/portal/v1/time-corrections/${correctionId}/decision`, {
      method: "PUT",
      session: departmentReviewer,
      body: { action: "approve", entries: proposedEntries },
    });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.code, "PORTAL_SCOPE_DENIED");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM time_entries WHERE employee_number = '102' AND work_date = ? AND voided_at IS NULL").get(date).count, 4);

    const approved = await requestJson(baseUrl, `/api/portal/v1/time-corrections/${correctionId}/decision`, {
      method: "PUT",
      session: locationReviewer,
      body: { action: "approve", entries: proposedEntries },
    });
    assert.equal(approved.response.status, 200, JSON.stringify(approved.payload));
    const activeDepartments = db.prepare(`
      SELECT department_id FROM time_entries
      WHERE employee_number = '102' AND work_date = ? AND voided_at IS NULL
      ORDER BY entry_timestamp, id
    `).all(date).map((row) => Number(row.department_id));
    assert.deepEqual(activeDepartments, [departmentA, departmentA, departmentB, departmentB]);

    const activeIds = db.prepare(`
      SELECT id FROM time_entries
      WHERE employee_number = '102' AND work_date = ? AND voided_at IS NULL
      ORDER BY entry_timestamp, id
    `).all(date).map((row) => Number(row.id));
    const legacyCorrectionId = Number(db.prepare(`
      INSERT INTO time_corrections
        (employee_number, location_id, department_id, correction_date, requested_change, request_note, status, requested_by)
      VALUES ('102', '01', ?, ?, ?, 'Altantrag ohne Bereichsmetadaten', 'pending', '102')
    `).run(departmentA, date, JSON.stringify({
      proposedEntries,
      entries: proposedEntries,
      originalEntryIds: activeIds,
    })).lastInsertRowid);
    const deniedLegacy = await requestJson(baseUrl, `/api/portal/v1/time-corrections/${legacyCorrectionId}/decision`, {
      method: "PUT",
      session: departmentReviewer,
      body: { action: "reject", decisionNote: "Nicht mein Gesamtbereich" },
    });
    assert.equal(deniedLegacy.response.status, 403, JSON.stringify(deniedLegacy.payload));
    assert.equal(deniedLegacy.payload.code, "PORTAL_SCOPE_DENIED");
  } finally {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});
