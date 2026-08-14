"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseXoffiRecognition } = require("../lib/xoffi-time-import");

function recognitionLine(text, x, y, width = 100, height = 12, confidence = 96) {
  return {
    bbox: { x0: x, y0: y, x1: x + width, y1: y + height },
    words: [{ text, confidence, bbox: { x0: x, y0: y, x1: x + width, y1: y + height } }],
  };
}

function recognitionBlocks(lines) {
  return [{ paragraphs: [{ lines }] }];
}

test("v0.92.5: xoffi-OCR erkennt KW, Standort, Teamzeilen, Wochenwerte und Tagesintervalle", () => {
  const centers = [150, 300, 450, 600, 750, 900, 1050];
  const lines = [
    recognitionLine("Kalenderwoche: 4? [32] &", 10, 20, 180),
    recognitionLine("2026", 300, 20, 50),
    recognitionLine("Abteilung: Kst. 18 Grabenweg MA:", 500, 20, 300),
    recognitionLine("1 Seiwald Christian", 10, 300, 150),
    recognitionLine("2 Usel Brigitte", 10, 600, 130),
  ];
  for (const center of centers) {
    lines.push(recognitionLine("Gesamt: 0.00", center - 35, 180, 70));
    lines.push(recognitionLine("Gesamt: 0.00", center - 35, 480, 70));
  }
  lines.push(
    recognitionLine("09:00-12:00", centers[0] - 40, 240, 80),
    recognitionLine("13:00-16:00", centers[0] - 40, 260, 80),
    recognitionLine("Stunden inklusive", 1300, 240, 75),
    recognitionLine("7.00", 1370, 240, 25),
    recognitionLine("Anwesend", 1300, 260, 60),
    recognitionLine("6.00", 1370, 260, 25),
    recognitionLine("Mehrstunden", 1300, 280, 65),
    recognitionLine("2.00", 1370, 280, 25),
    recognitionLine("08:00-13:00", centers[1] - 40, 540, 80),
    recognitionLine("Stunden inklusive", 1300, 540, 75),
    recognitionLine("5.00", 1370, 540, 25),
    recognitionLine("Anwesend", 1300, 560, 60),
    recognitionLine("5.00", 1370, 560, 25),
    recognitionLine("Mehrstunden", 1300, 580, 65),
    recognitionLine("-1.00", 1365, 580, 30),
  );

  const parsed = parseXoffiRecognition({
    text: "Stundenerfassung",
    blocks: recognitionBlocks(lines),
    width: 1400,
    height: 800,
    employees: [
      { personnel_number: "252", full_name: "Christian Seiwald", nickname: "Chris" },
      { personnel_number: "5", full_name: "Brigitte Usel", nickname: "Brigitte" },
    ],
  });

  assert.equal(parsed.weekStart, "2026-08-03");
  assert.equal(parsed.weekEnd, "2026-08-09");
  assert.deepEqual({ code: parsed.locationCode, name: parsed.locationName }, { code: "18", name: "Grabenweg" });
  assert.equal(parsed.employees.length, 2);
  assert.equal(parsed.employees[0].employeeNumber, "252");
  assert.equal(parsed.employees[0].weeklyActualMinutes, 360);
  assert.equal(parsed.employees[0].weeklyValuedMinutes, 420);
  assert.equal(parsed.employees[0].weeklySurchargeMinutes, 60);
  assert.equal(parsed.employees[0].closingBalanceMinutes, 120);
  assert.deepEqual(parsed.employees[0].days[0].intervals, ["09:00-12:00", "13:00-16:00"]);
  assert.equal(parsed.employees[1].employeeNumber, "5");
  assert.equal(parsed.employees[1].closingBalanceMinutes, -60);
});

test("v0.92.5: sieben Spaltendaten bestimmen die KW auch bei einer abweichenden OCR-KW", () => {
  const centers = [150, 300, 450, 600, 750, 900, 1050];
  const dates = ["03.08.2026", "04.08.2026", "05.08.2026", "06.08.2026", "07.08.2026", "08.08.2026", "09.08.2026"];
  const lines = [
    recognitionLine("Kalenderwoche: [33]", 10, 20, 190),
    recognitionLine("2026", 300, 20, 50),
    recognitionLine("Abteilung: Kst. 18 Grabenweg MA:", 500, 20, 300),
    recognitionLine("1 Seiwald Christian", 10, 300, 150),
    recognitionLine("2 Usel Brigitte", 10, 600, 130),
  ];
  for (const center of centers) {
    lines.push(recognitionLine("Gesamt: 0.00", center - 35, 180, 70));
    lines.push(recognitionLine("Gesamt: 0.00", center - 35, 480, 70));
  }

  const parsed = parseXoffiRecognition({
    text: "Stundenerfassung",
    blocks: recognitionBlocks(lines),
    width: 1400,
    height: 800,
    headerDates: dates.map((date) => {
      const [day, month, year] = date.split(".");
      return `${year}-${month}-${day}`;
    }),
    employees: [
      { personnel_number: "252", full_name: "Christian Seiwald", nickname: "Chris" },
      { personnel_number: "5", full_name: "Brigitte Usel", nickname: "Brigitte" },
    ],
  });

  assert.equal(parsed.weekStart, "2026-08-03");
  assert.equal(parsed.weekEnd, "2026-08-09");
});

test("v0.92.5: Urlaubstage und Urlaubsguthaben werden vollständig ignoriert", () => {
  const centers = [150, 300, 450, 600, 750, 900, 1050];
  const lines = [
    recognitionLine("Kalenderwoche: [32]", 10, 20, 180),
    recognitionLine("2026", 300, 20, 50),
    recognitionLine("Abteilung: Kst. 18 Grabenweg MA:", 500, 20, 300),
    recognitionLine("1 Usel Brigitte", 10, 300, 150),
    recognitionLine("2 Testperson Zwei", 10, 600, 150),
  ];
  for (const [index, center] of centers.entries()) {
    lines.push(recognitionLine(index === 0 ? "Gesamt: 7.70" : "Gesamt: 0.00", center - 35, 180, 70));
    lines.push(recognitionLine("Gesamt: 0.00", center - 35, 480, 70));
  }
  lines.push(
    // Die grüne Urlaub-Zeile ist im echten Screenshot für OCR nicht zuverlässig lesbar.
    // Positiver Tageswert ohne echte Anwesenheitszeit wird deshalb ebenfalls ignoriert.
    recognitionLine("Stunden inklusive", 1300, 220, 75),
    recognitionLine("38.70", 1370, 220, 30),
    recognitionLine("Anwesend", 1300, 240, 60),
    recognitionLine("38.70", 1370, 240, 30),
    recognitionLine("Urlaub (Std)", 1300, 260, 70),
    recognitionLine("7.70", 1370, 260, 25),
    recognitionLine("Rest Url. (Tage)", 1300, 280, 90),
    recognitionLine("37.00", 1370, 280, 30),
    recognitionLine("Mehrstunden", 1300, 300, 65),
    recognitionLine("0.20", 1370, 300, 25),
  );

  const parsed = parseXoffiRecognition({
    text: "Stundenerfassung",
    blocks: recognitionBlocks(lines),
    width: 1400,
    height: 800,
    employees: [
      { personnel_number: "5", full_name: "Brigitte Usel", nickname: "Brigitte" },
      { personnel_number: "6", full_name: "Testperson Zwei", nickname: "Testperson" },
    ],
  });

  assert.equal(parsed.employees[0].weeklyActualMinutes, 2322);
  assert.equal(parsed.employees[0].weeklyValuedMinutes, 2322);
  assert.equal(parsed.employees[0].closingBalanceMinutes, 12);
  assert.deepEqual(parsed.employees[0].days[0].intervals, []);
  assert.equal(parsed.employees[0].days[0].actualMinutes, 0);
  assert.equal(parsed.employees[0].days[0].valuedMinutes, 0);
  assert.equal(parsed.employees[0].days[0].surchargeMinutes, 0);
  assert.equal(parsed.employees[0].days[0].absence, "");
  assert.equal(parsed.employees[0].days[0].vacationIgnored, true);
  assert.match(parsed.employees[0].warnings.join(" "), /Urlaubstage und Urlaubsguthaben werden nicht importiert/);
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0925-xoffi-"));
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
const { app, db, effectivePortalPermissionState } = subject;

const LOCATION = "93";
const MANAGER = "99251";
const DEPARTMENT_MANAGER = "99252";
const PERMISSION = "xoffi_time_import:manage";
let httpServer;
let baseUrl;
let departmentId;

function ensurePortalUser(employeeNumber, fullName, role) {
  const positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       position_id, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#276e55', 38.5, 5, ?, ?, ?, 1)
  `).run(employeeNumber, fullName, fullName.split(" ")[0], positionId, LOCATION, departmentId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
}

function createSession(employeeNumber) {
  const token = `v0925-xoffi-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

function currentMonday() {
  const now = new Date();
  const value = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value.toISOString().slice(0, 10);
}

test.before(async () => {
  const template = db.prepare("SELECT day_settings_json FROM locations ORDER BY id LIMIT 1").get();
  db.prepare(`
    INSERT INTO locations
      (id, name, min_staff, day_settings_json, time_tracking_enabled, time_tracking_access_mode,
       time_tracking_allowed_networks, time_tracking_variance_minutes, active)
    VALUES (?, 'xoffi Testfiliale', 1, ?, 0, 'anywhere', '', 15, 1)
  `).run(LOCATION, template?.day_settings_json || "{}");
  db.prepare("INSERT INTO departments (location_id, name, active, sort_order) VALUES (?, 'Verkauf', 1, 1)")
    .run(LOCATION);
  departmentId = db.prepare("SELECT id FROM departments WHERE location_id = ? AND name = 'Verkauf'").get(LOCATION).id;
  ensurePortalUser(MANAGER, "Mara Filialleitung", "manager");
  ensurePortalUser(DEPARTMENT_MANAGER, "Alina Abteilungsleitung", "department_manager");
  db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES (?, ?, 0, 'test')")
    .run(MANAGER, LOCATION);
  db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES (?, ?, ?, 'test')")
    .run(DEPARTMENT_MANAGER, LOCATION, departmentId);
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

test("v0.92.5: FL besitzt das entziehbare Grundrecht, AL erhält es nur durch Freigabe", async () => {
  const rolePermissions = (role) => JSON.parse(db.prepare("SELECT permissions FROM portal_roles WHERE id = ?").get(role).permissions);
  assert.equal(effectivePortalPermissionState(MANAGER, "manager", rolePermissions("manager")).effectivePermissions.includes(PERMISSION), true);
  assert.equal(effectivePortalPermissionState(DEPARTMENT_MANAGER, "department_manager", rolePermissions("department_manager")).effectivePermissions.includes(PERMISSION), false);
  db.prepare("INSERT INTO portal_permission_grants (employee_number, permission, granted_by) VALUES (?, ?, 'test')")
    .run(DEPARTMENT_MANAGER, PERMISSION);
  assert.equal(effectivePortalPermissionState(
    DEPARTMENT_MANAGER,
    "department_manager",
    rolePermissions("department_manager"),
    [PERMISSION],
  ).effectivePermissions.includes(PERMISSION), true);
  db.prepare("INSERT INTO portal_permission_denials (employee_number, permission, denied_by) VALUES (?, ?, 'test')")
    .run(MANAGER, PERMISSION);
  assert.equal(effectivePortalPermissionState(
    MANAGER,
    "manager",
    rolePermissions("manager"),
    [],
    [PERMISSION],
  ).effectivePermissions.includes(PERMISSION), false);
});

test("v0.92.5: der Server lehnt aktuelle und künftige KW vor jeder Bilderkennung ab", async () => {
  db.prepare("DELETE FROM portal_permission_denials WHERE employee_number = ? AND permission = ?").run(MANAGER, PERMISSION);
  const auth = createSession(MANAGER);
  const response = await fetch(
    `${baseUrl}/api/portal/v1/xoffi-time-import/inspect?weekStart=${currentMonday()}&locationId=${LOCATION}&departmentId=${departmentId}`,
    {
      method: "POST",
      headers: {
        Cookie: auth.cookie,
        "X-CSRF-Token": auth.csrf,
        "Content-Type": "image/png",
        "X-Import-Filename": "xoffi.png",
      },
      body: Buffer.alloc(64, 1),
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.code, "XOFFI_WEEK_NOT_PAST");
});

test("v0.92.5: xoffi-Rohdaten bleiben revisionssicher und funktionieren auch bei deaktivierter Live-Zeiterfassung", async () => {
  for (const table of ["xoffi_time_imports", "xoffi_time_employee_rows", "xoffi_time_days"]) {
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.type, "table");
  }
  const importId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO xoffi_time_imports
      (id, location_id, department_id, department_key, week_start, week_end, source_sha256,
       source_file_name, ocr_engine_version, use_as_actual, imported_by)
    VALUES (?, ?, ?, ?, '2026-08-03', '2026-08-09', ?, 'xoffi.png', 'test', 1, ?)
  `).run(importId, LOCATION, departmentId, departmentId, "a".repeat(64), MANAGER);
  const row = db.prepare(`
    INSERT INTO xoffi_time_employee_rows
      (import_id, employee_number, source_name, match_confidence, weekly_actual_minutes,
       weekly_valued_minutes, weekly_surcharge_minutes, closing_balance_minutes)
    VALUES (?, ?, 'Mara Filialleitung', 100, 420, 480, 60, 120)
    RETURNING id
  `).get(importId, MANAGER);
  db.prepare(`
    INSERT INTO xoffi_time_days
      (employee_row_id, work_date, actual_minutes, valued_minutes, surcharge_minutes,
       intervals_json, absence_code, ocr_confidence)
    VALUES (?, '2026-08-03', 420, 480, 60, '["09:00-12:00","13:00-17:00"]', '', 96)
  `).run(row.id);
  db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time, area)
    VALUES (?, ?, ?, '2026-08-03', '09:00', '17:00', 'xoffi-Test')
  `).run(MANAGER, LOCATION, departmentId);
  const evaluation = await subject.evaluateTimeDay(
    MANAGER,
    "2026-08-03",
    new Date("2026-08-10T12:00:00Z"),
    departmentId,
    null,
    { locationId: LOCATION, filterLocation: true },
  );
  assert.equal(evaluation.actual.source, "xoffi");
  assert.equal(evaluation.actualMinutes, 420);
  assert.equal(evaluation.actualValuedMinutes, 480);
  assert.equal(evaluation.comparison.workedDifferenceMinutes, evaluation.actualMinutes - evaluation.plannedMinutes);
  assert.equal(evaluation.issues.some((issue) => issue.code === "missing_entries"), false);
  const auth = createSession(MANAGER);
  const nextWeekResponse = await fetch(
    `${baseUrl}/api/schedule?week=2026-08-10&locationId=${LOCATION}&departmentId=${departmentId}`,
    { headers: { Cookie: auth.cookie } },
  );
  const nextWeekSchedule = await nextWeekResponse.json();
  assert.equal(nextWeekResponse.status, 200, JSON.stringify(nextWeekSchedule));
  assert.deepEqual(nextWeekSchedule.xoffiTime.balanceByEmployee[MANAGER], {
    minutes: 120,
    weekStart: "2026-08-03",
  });
  assert.throws(() => db.prepare("UPDATE xoffi_time_days SET actual_minutes = 1 WHERE employee_row_id = ?").run(row.id), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM xoffi_time_imports WHERE id = ?").run(importId), /immutable/);
});
