"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  indexedWeekFromHeaderDates,
  parseXoffiRecognition,
  resolveXoffiScreenshotWeek,
} = require("../lib/xoffi-time-import");

const KW_32_DATES = [
  "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09",
];

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
    headerDates: KW_32_DATES,
    selectedWeekStart: "2026-08-03",
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
    selectedWeekStart: "2026-08-03",
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
    headerDates: KW_32_DATES,
    selectedWeekStart: "2026-08-03",
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

test("xoffi: sechs positionsrichtige Datumsspalten liefern trotz OCR-Ausreißer nur einen bestätigungspflichtigen Vorschlag", () => {
  const dates = [...KW_32_DATES];
  dates[5] = "2025-08-08";
  assert.deepEqual(indexedWeekFromHeaderDates(dates), {
    weekStart: "2026-08-03",
    weekEnd: "2026-08-09",
    matchedDateColumns: 6,
  });
  const resolution = resolveXoffiScreenshotWeek({ headerDates: dates, selectedWeekStart: "2026-08-03" });
  assert.equal(resolution.resolution.status, "uncertain");
  assert.equal(resolution.resolution.confirmationRequired, true);
});

test("xoffi: KSt- und Eintrittszahlen sind niemals Wochenbelege", () => {
  const centers = [150, 300, 450, 600, 750, 900, 1050];
  const lines = [
    recognitionLine("Kalenderwoche: Kst. (18)", 10, 20, 180),
    recognitionLine("Abteilung: Kst. 18 Grabenweg MA:", 500, 20, 300),
    recognitionLine("1 Testperson Eins", 10, 300, 150),
    recognitionLine("Eintritt: 03.06.2019", 10, 320, 150),
  ];
  for (const center of centers) {
    lines.push(recognitionLine("Gesamt: 0.00", center - 35, 180, 70));
    lines.push(recognitionLine("Gesamt: 0.00", center - 35, 480, 70));
  }
  const parsed = parseXoffiRecognition({
    text: "Kalenderwoche: 18 Kst. 18 Eintritt: 03.06.2019",
    blocks: recognitionBlocks(lines),
    width: 1400,
    height: 800,
    headerDates: ["", "", "", "", "", "", ""],
    selectedWeekStart: "2026-08-03",
    employees: [{ personnel_number: "1", full_name: "Testperson Eins", nickname: "Testperson" }],
  });
  assert.equal(parsed.weekStart, "2026-08-03");
  assert.equal(parsed.weekResolution.status, "unrecognized");
  assert.equal(parsed.weekResolution.detectedWeekStart, "");
  assert.equal(parsed.weekResolution.confirmationRequired, true);
  assert.deepEqual(parsed.employees[0].days.map((day) => day.workDate), KW_32_DATES);
});

test("xoffi: widersprüchliche Spaltendaten bleiben als Konflikt sichtbar und binden die GP-Woche", () => {
  const resolution = resolveXoffiScreenshotWeek({
    headerDates: KW_32_DATES.map((date) => {
      const value = new Date(`${date}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + 7);
      return value.toISOString().slice(0, 10);
    }),
    selectedWeekStart: "2026-08-03",
  });
  assert.equal(resolution.weekStart, "2026-08-03");
  assert.equal(resolution.resolution.detectedWeekStart, "2026-08-10");
  assert.equal(resolution.resolution.status, "conflict");
  assert.equal(resolution.resolution.confirmationRequired, true);
});

test("xoffi: ohne sichere Datumsspalten und ohne serverseitige GP-Auswahl wird abgebrochen", () => {
  assert.throws(
    () => resolveXoffiScreenshotWeek({ headerDates: ["", "", "", "", "", "", ""] }),
    { code: "XOFFI_WEEK_NOT_DETECTED" },
  );
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
  const [year, month, dayOfMonth] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()).split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, dayOfMonth, 12));
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

test("v0.92.5: eine aktuelle KW ohne belegtes Dienstende bleibt vor der Bilderkennung gesperrt", async () => {
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

test("xoffi: eine unsichere oder widersprüchliche Screenshot-Woche braucht serverseitig eine eigene Bestätigung", () => {
  const preview = (status, confirmationRequired, detectedWeekStart = "") => ({
    weekStart: "2026-08-03",
    weekEnd: "2026-08-09",
    weekResolution: {
      status,
      source: detectedWeekStart ? "header_date_columns" : "none",
      selectedWeekStart: "2026-08-03",
      selectedWeekEnd: "2026-08-09",
      detectedWeekStart,
      detectedWeekEnd: detectedWeekStart === "2026-08-03" ? "2026-08-09"
        : detectedWeekStart === "2026-08-10" ? "2026-08-16" : "",
      matchedDateColumns: detectedWeekStart ? (status === "uncertain" ? 6 : 7) : 0,
      confirmationRequired,
    },
  });

  assert.equal(
    subject.assertXoffiScreenshotWeekConfirmation(preview("matched", false, "2026-08-03"), {}).status,
    "matched",
  );
  assert.throws(
    () => subject.assertXoffiScreenshotWeekConfirmation(preview("unrecognized", true), {}),
    { code: "XOFFI_SCREENSHOT_WEEK_CONFIRMATION_REQUIRED" },
  );
  assert.throws(
    () => subject.assertXoffiScreenshotWeekConfirmation(preview("uncertain", true, "2026-08-03"), {}),
    { code: "XOFFI_SCREENSHOT_WEEK_CONFIRMATION_REQUIRED" },
  );
  assert.equal(
    subject.assertXoffiScreenshotWeekConfirmation(
      preview("uncertain", true, "2026-08-03"),
      { screenshotWeekConfirmed: true },
    ).status,
    "uncertain",
  );
  assert.throws(
    () => subject.assertXoffiScreenshotWeekConfirmation(preview("conflict", true, "2026-08-10"), { screenshotWeekConfirmed: false }),
    { code: "XOFFI_SCREENSHOT_WEEK_CONFIRMATION_REQUIRED" },
  );
  assert.equal(
    subject.assertXoffiScreenshotWeekConfirmation(
      preview("conflict", true, "2026-08-10"),
      { screenshotWeekConfirmed: true },
    ).status,
    "conflict",
  );
  const manipulated = preview("unrecognized", true);
  manipulated.weekResolution.selectedWeekStart = "2026-07-27";
  assert.throws(
    () => subject.assertXoffiScreenshotWeekConfirmation(manipulated, { screenshotWeekConfirmed: true }),
    { code: "XOFFI_WEEK_PREVIEW_INVALID" },
  );
  const inconsistentDetection = preview("matched", false, "2026-08-03");
  inconsistentDetection.weekResolution.detectedWeekEnd = "2026-08-16";
  assert.throws(
    () => subject.assertXoffiScreenshotWeekConfirmation(inconsistentDetection, {}),
    { code: "XOFFI_WEEK_PREVIEW_INVALID" },
  );
  assert.throws(
    () => subject.assertXoffiScreenshotWeekConfirmation(preview("detected", false, "2026-08-03"), {}),
    { code: "XOFFI_WEEK_PREVIEW_INVALID" },
  );
});

test("xoffi: Import und Wochenbestätigungs-Audit rollen bei einem Auditfehler gemeinsam zurück", async () => {
  const sourceSha256 = "b".repeat(64);
  db.exec(`
    CREATE TEMP TRIGGER xoffi_audit_rollback_test
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'xoffi-time.import.apply'
    BEGIN
      SELECT RAISE(ABORT, 'xoffi-audit-rollback-test');
    END
  `);
  try {
    await assert.rejects(
      () => subject.storeXoffiTimeImport(
        { employeeNumber: MANAGER },
        {
          context: { locationId: LOCATION, departmentId },
          weekStart: "2026-08-03",
          weekEnd: "2026-08-09",
          weekResolution: {
            status: "unrecognized",
            source: "none",
            selectedWeekStart: "2026-08-03",
            selectedWeekEnd: "2026-08-09",
            detectedWeekStart: "",
            detectedWeekEnd: "",
            matchedDateColumns: 0,
            confirmationRequired: true,
          },
          sourceSha256,
          sourceFileName: "xoffi-test.png",
          engineVersion: "test",
        },
        [],
        true,
        true,
      ),
      { code: "PERSISTENCE_CHECK_VIOLATION" },
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS xoffi_audit_rollback_test");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM xoffi_time_imports WHERE source_sha256 = ?").get(sourceSha256).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'xoffi-time.import.apply' AND detail LIKE ?").get(`%${sourceSha256}%`).count, 0);
});

test("MHTML API: automatic week and employee, persistent snapshots, unchanged vacation and no duplicate credits", async () => {
  const { fixtureHtml, mhtml } = require("../test-support/xoffi-mhtml");
  const auth = createSession(MANAGER);
  const employeeBefore = db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(MANAGER);
  const vacationsBefore = db.prepare("SELECT * FROM week_options WHERE employee_number=?").all(MANAGER);
  async function inspect(body, session = auth) {
    const response = await fetch(`${baseUrl}/api/portal/v1/xoffi-time-import/inspect?locationId=${LOCATION}&departmentId=${departmentId}`, {
      method: "POST", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/octet-stream", "X-Import-Filename": "test.mhtml" }, body,
    });
    return { status: response.status, body: await response.json() };
  }
  const preview = await inspect(mhtml(fixtureHtml()));
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.weekStart, "2026-09-07");
  assert.equal(preview.body.employees[0].employeeNumber, MANAGER);
  const applyBody = { previewId: preview.body.previewId, confirmed: true, useAsActual: true, employees: preview.body.employees };
  // A client cannot overwrite the source snapshot or mislabel it as a closing balance.
  applyBody.employees[0].snapshot.remainingVacationDays = 999;
  applyBody.employees[0].closingBalanceMinutes = 999;
  const response = await fetch(`${baseUrl}/api/portal/v1/xoffi-time-import/apply`, { method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" }, body: JSON.stringify(applyBody) });
  const applied = await response.json();
  assert.equal(response.status, 201, JSON.stringify(applied));
  const imported = applied.schedule.xoffiTime.weekByEmployee[MANAGER];
  assert.equal(imported.days.length, 7);
  assert.equal(imported.useAsActual, true);
  assert.equal(imported.snapshot.remainingVacationDays, 37.5);
  assert.equal(imported.snapshot.openingBalanceMinutes, 180);
  assert.equal(imported.closingBalanceMinutes, null);
  const vacationPlan = await fetch(`${baseUrl}/api/vacations?year=2026&locationId=${LOCATION}&departmentId=${departmentId}`, {headers:{Cookie:auth.cookie}});
  assert.equal(vacationPlan.status,200);
  assert.deepEqual((await vacationPlan.json()).xoffiVacationByEmployee, {
    [MANAGER]: {balanceDate:"2026-09-06",remainingVacationDays:37.5},
  });
  const previousYear = await fetch(`${baseUrl}/api/vacations?year=2025&locationId=${LOCATION}`, {headers:{Cookie:auth.cookie}});
  assert.deepEqual((await previousYear.json()).xoffiVacationByEmployee,{});
  assert.deepEqual(db.prepare("SELECT * FROM employees WHERE personnel_number=?").get(MANAGER), employeeBefore);
  assert.deepEqual(db.prepare("SELECT * FROM week_options WHERE employee_number=?").all(MANAGER), vacationsBefore);
  const evaluation = await subject.evaluateTimeDay(MANAGER, "2026-09-08", new Date("2026-09-14T12:00:00Z"), departmentId, null, { locationId: LOCATION, filterLocation: true });
  assert.equal(evaluation.actualMinutes, 90);
  assert.equal(evaluation.actualValuedMinutes, 384);
  const vacation = await subject.evaluateTimeDay(MANAGER, "2026-09-09", new Date("2026-09-14T12:00:00Z"), departmentId, null, { locationId: LOCATION, filterLocation: true });
  assert.equal(vacation.actualMinutes, 0);
  assert.equal(vacation.actualValuedMinutes, 384);
  const saturday = await subject.evaluateTimeDay(MANAGER, "2026-09-12", new Date("2026-09-14T12:00:00Z"), departmentId, null, { locationId: LOCATION, filterLocation: true });
  assert.equal(saturday.actualValuedMinutes, 180);
  assert.throws(() => db.prepare("UPDATE xoffi_time_snapshots SET snapshot_json='{}'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM xoffi_time_snapshots").run(), /immutable/);
  const current = currentMonday(), previous = new Date(current + 'T12:00:00Z');previous.setUTCDate(previous.getUTCDate()-1);
  const weekDate = new Date(current + 'T12:00:00Z');weekDate.setUTCDate(weekDate.getUTCDate()+3);
  const kw = Math.ceil((((weekDate - Date.UTC(weekDate.getUTCFullYear(),0,1,12))/86400000)+1)/7);
  const date = previous.toISOString().slice(0,10).split('-').reverse().join('.');
  const rejected = await inspect(mhtml(fixtureHtml({ week: kw, balanceDate: date })));
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "XOFFI_WEEK_NOT_PAST");
  async function apply(previewBody, employees = previewBody.employees) {
    const result = await fetch(`${baseUrl}/api/portal/v1/xoffi-time-import/apply`, { method: "POST",
      headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ previewId: previewBody.previewId, confirmed: true, useAsActual: true, employees }) });
    return { status: result.status, body: await result.json() };
  }
  const reviewed = await inspect(mhtml());
  for (const alter of [rows => { rows[0].days[0].actualMinutes = ""; },
    rows => { rows[0].days[0].intervals = ["09:99-12:30"]; },
    rows => { rows[0].weeklyValuedMinutes += 60; }]) {
    const rows = structuredClone(reviewed.body.employees); alter(rows);
    const invalid = await apply(reviewed.body, rows);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "XOFFI_REVIEW_INVALID");
  }
  const fullInput = mhtml(fixtureHtml() + fixtureHtml({ name: "Alina Abteilungsleitung" }));
  for (let repeat = 0; repeat < 2; repeat++) {
    const full = await inspect(fullInput);
    const result = await apply(full.body);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(Object.keys(result.body.schedule.xoffiTime.weekByEmployee).length, 2);
  }
  const partial = await inspect(mhtml());
  const incomplete = await apply(partial.body);
  assert.equal(incomplete.status, 409);
  assert.equal(incomplete.body.code, "XOFFI_REIMPORT_INCOMPLETE");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM xoffi_time_employee_rows r JOIN xoffi_time_imports i ON i.id=r.import_id
    WHERE i.location_id=? AND i.week_start='2026-09-07' AND i.status='active'`).get(LOCATION).n, 2);
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

test("xoffi MHTML: current week imports after the last shift and apply rejects a newly added later shift", async () => {
  const { fixtureHtml, mhtml } = require('../test-support/xoffi-mhtml');
  const savedDay=process.env.GRABENPLANER_TEST_TODAY;
  process.env.GRABENPLANER_TEST_TODAY='2026-09-19';
  const inserted=[];
  const insert=(date)=>{const row=db.prepare("INSERT INTO shifts(employee_number,location_id,department_id,shift_date,start_time,end_time,area) VALUES(?,?,?,?,'09:00','17:00','Verkauf')").run(MANAGER,LOCATION,departmentId,date);inserted.push(Number(row.lastInsertRowid));return inserted.at(-1);};
  try {
    insert('2026-09-18');
    const auth=createSession(MANAGER);
    const input=mhtml(fixtureHtml({week:38,balanceDate:'13.09.2026'}));
    const inspect=await fetch(`${baseUrl}/api/portal/v1/xoffi-time-import/inspect?locationId=${LOCATION}&departmentId=${departmentId}`,{method:'POST',headers:{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,'Content-Type':'application/octet-stream','X-Import-Filename':'current.mhtml'},body:input});
    const preview=await inspect.json();assert.equal(inspect.status,200,JSON.stringify(preview));
    const later=insert('2026-09-20');
    const apply=()=>fetch(`${baseUrl}/api/portal/v1/xoffi-time-import/apply`,{method:'POST',headers:{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify({previewId:preview.previewId,confirmed:true,useAsActual:true,employees:preview.employees})});
    const denied=await apply();assert.equal(denied.status,409);assert.equal((await denied.json()).code,'XOFFI_WEEK_NOT_PAST');
    db.prepare('DELETE FROM shifts WHERE id=?').run(later);
    const accepted=await apply(),body=await accepted.json();assert.equal(accepted.status,201,JSON.stringify(body));
    assert.equal(body.schedule.isPastWeek,false);
    assert.equal(body.schedule.xoffiTime.weekByEmployee[MANAGER].days.length,7);
  } finally {
    for(const id of inserted)db.prepare('DELETE FROM shifts WHERE id=?').run(id);
    if(savedDay===undefined)delete process.env.GRABENPLANER_TEST_TODAY;else process.env.GRABENPLANER_TEST_TODAY=savedDay;
  }
});


test("xoffi comparison: scoped weekly import data, missing persons and persisted configurable limits", async () => {
  const auth=createSession(MANAGER);
  db.prepare("INSERT INTO shifts(employee_number,location_id,department_id,shift_date,start_time,end_time,area) VALUES(?,?,?,'2026-09-14','09:00','10:40','Test')").run(MANAGER,LOCATION,departmentId);
  const url=`${baseUrl}/api/portal/v1/xoffi-plan-comparison?weekStart=2026-09-14&locationId=${LOCATION}&departmentId=${departmentId}`;
  let response=await fetch(url,{headers:{Cookie:auth.cookie}}),body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  const row=body.employees.find(entry=>entry.employeeNumber===MANAGER);
  assert.equal(row.importState,'complete');assert.equal(row.actualMinutes,1245);
  assert.equal(row.days.length,7);assert.equal(row.days[0].actualMinutes,510);
  assert.equal(row.plannedMinutes,100);assert.equal(row.severity,'red');assert.equal(row.percent,1145);
  assert.equal(row.valuedComparison.actualMinutes, row.valuedMinutes);
  const schoolId=db.prepare("INSERT INTO week_options(employee_number,week_start,date_from,date_to,option_type,all_day,credited_minutes_per_day) VALUES(?,'2026-09-14','2026-09-15','2026-09-15','school',1,600)").run(MANAGER).lastInsertRowid;
  try {
    const withSchool=await fetch(url,{headers:{Cookie:auth.cookie}});
    const schoolBody=await withSchool.json();
    assert.equal(withSchool.status,200,JSON.stringify(schoolBody));
    const comparison=schoolBody.employees.find(entry=>entry.employeeNumber===MANAGER);
    assert.equal(comparison.plannedMinutes,700);
    assert.equal(comparison.days[1].plannedMinutes,600);
    assert.deepEqual(comparison.days[1].planCredits,[{label:'Schulung',minutes:600}]);
    assert.equal(comparison.actualMinutes,1245);
  } finally { db.prepare('DELETE FROM week_options WHERE id=?').run(schoolId); }
  assert.equal(body.employees.find(entry=>entry.employeeNumber===DEPARTMENT_MANAGER).importState,'missing');
  const otherLocation=db.prepare('SELECT id FROM locations WHERE id != ? LIMIT 1').get(LOCATION).id;
  const foreign=await fetch(url.replace(`locationId=${LOCATION}`,`locationId=${otherLocation}`).replace(`&departmentId=${departmentId}`,''),{headers:{Cookie:auth.cookie}});
  assert.equal(foreign.status,403);
  const save=(limits,csrf=auth.csrf)=>fetch(`${baseUrl}/api/portal/v1/xoffi-plan-comparison/settings`,{method:'PUT',headers:{Cookie:auth.cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({locationId:LOCATION,departmentId,limits})});
  const denied=await save({greenMax:5,yellowMax:15},'invalid');assert.equal(denied.status,403);
  db.prepare("INSERT OR IGNORE INTO portal_permission_grants(employee_number,permission,granted_by) VALUES(?, 'time:settings', 'test')").run(MANAGER);
  const invalidCsrf=await save({greenMax:5,yellowMax:15},'invalid');assert.equal(invalidCsrf.status,403);
  const invalid=await save({greenMax:15,yellowMax:5});assert.equal(invalid.status,400);
  const saved=await save({greenMax:8,yellowMax:20});assert.equal(saved.status,200,JSON.stringify(await saved.json()));
  response=await fetch(url,{headers:{Cookie:auth.cookie}});body=await response.json();
  assert.deepEqual(body.limits,{greenMax:8,yellowMax:20});
  const branch=await fetch(url.replace(`&departmentId=${departmentId}`,''),{headers:{Cookie:auth.cookie}});
  assert.deepEqual((await branch.json()).limits,{greenMax:5,yellowMax:15});
});

test("xoffi comparison: date ranges clip weekly imports, flag gaps and keep the scope boundary", async () => {
  const auth = createSession(MANAGER);
  const get = (from, to, location = LOCATION) => fetch(`${baseUrl}/api/portal/v1/xoffi-plan-comparison?from=${from}&to=${to}&locationId=${location}${location === LOCATION ? `&departmentId=${departmentId}` : ''}`, { headers: { Cookie: auth.cookie } });
  let response = await get('2026-09-14', '2026-09-14'), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  let row = body.employees.find(person => person.employeeNumber === MANAGER);
  assert.equal(row.days.length, 1);
  assert.equal(row.actualMinutes, 510);
  assert.equal(row.importState, 'complete');
  response = await get('2026-09-01', '2026-09-30'); body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  row = body.employees.find(person => person.employeeNumber === MANAGER);
  assert.equal(row.days.length, 30);
  assert.equal(row.coveredDays, 14);
  assert.equal(row.imports.length, 2);
  assert.equal(row.valuedComparison.actualMinutes, null);
  assert.equal(row.valuedComparison.severity, 'missing');
  assert.equal(row.days[13].actualMinutes, 510);
  for (const [from, to] of [['bad', '2026-09-30'], ['2026-09-30', '2026-09-01'], ['2025-01-01', '2026-09-30'], ['2026-02-30', '2026-03-01'], ['2026-09-01', '']]) {
    assert.equal((await get(from, to)).status, 400, `${from}–${to}`);
  }
  const otherLocation = db.prepare('SELECT id FROM locations WHERE id != ? LIMIT 1').get(LOCATION).id;
  assert.equal((await get('2026-09-01', '2026-09-30', otherLocation)).status, 403);
});
