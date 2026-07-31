"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v0885-weekly-hours-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "0";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  app,
  db,
  releaseInstanceLockForTests,
  scheduleShiftMinuteBasis,
  shiftMetrics,
  countCreditedOptionDaysInRange,
  claimCreditedOptionDaysInRange,
  claimEmployeeDate,
} = require("../server");

let httpServer;
let baseUrl;

async function requestJson(route, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined
      ? { Accept: "application/json" }
      : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null, text };
}

const baseSettings = Object.freeze({
  break_rule_enabled: "1",
  break_after_minutes: "360",
  break_duration_minutes: "30",
  saturday_bonus_enabled: "1",
  saturday_bonus_from: "13:00",
  saturday_bonus_factor: "1.5",
});

const weeklyShifts = Object.freeze([
  { employee_number: "419", shift_date: "2026-07-29", start_time: "09:00", end_time: "18:00" },
  { employee_number: "419", shift_date: "2026-07-30", start_time: "09:00", end_time: "15:00" },
  { employee_number: "419", shift_date: "2026-07-31", start_time: "11:30", end_time: "18:00" },
  { employee_number: "419", shift_date: "2026-08-01", start_time: "10:00", end_time: "17:00" },
]);

test.before(async () => {
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

test("v0.88.5: 27 Planstunden mit Samstagsdienst ergeben eine finite Bewertung von 29 Stunden", async () => {
  const metrics = await Promise.all(weeklyShifts.map((shift) => shiftMetrics(shift, baseSettings)));
  const totals = metrics.reduce((result, metric) => {
    const basis = scheduleShiftMinuteBasis(metric);
    result.planned += basis.plannedMinutes;
    result.bonus += basis.bonusMinutes;
    result.counted += basis.countedMinutes;
    return result;
  }, { planned: 0, bonus: 0, counted: 0 });

  assert.deepEqual(totals, {
    planned: 27 * 60,
    bonus: 2 * 60,
    counted: 29 * 60,
  });
  assert.ok(Object.values(totals).every(Number.isFinite));
});

test("v0.88.5: API und JSON liefern für den 27-Stunden-Fall vollständig 29 gewertete Stunden", async () => {
  const locations = await requestJson("/api/locations");
  assert.equal(locations.response.status, 200, locations.text);
  const location = locations.payload.find((entry) => entry.active !== false && entry.cost_center_id);
  assert.ok(location, "Aktive Testfiliale mit Kostenstelle fehlt");
  const settings = await requestJson(`/api/settings?locationId=${encodeURIComponent(location.id)}`);
  assert.equal(settings.response.status, 200, settings.text);
  assert.equal(Object.hasOwn(settings.payload, "vacation_count_saturday"), false);

  const employeeNumber = "v0885-hours";
  const employee = await requestJson("/api/employees", {
    method: "POST",
    body: {
      personnelNumber: employeeNumber,
      fullName: "API Wochenstunden",
      nickname: "API-Woche",
      color: "#3657a7",
      contractedHours: 32,
      targetWorkdaysPerWeek: 5,
      preferredDayOff: "",
      fixedWorkdays: [],
      positionId: "verkaufsmitarbeiter",
      timeConfirmationLevel: "C",
      costCenterId: location.cost_center_id,
      preferredDepartmentId: "",
      active: true,
    },
  });
  assert.equal(employee.response.status, 201, employee.text);

  const apiShifts = [
    { date: "2099-02-04", startTime: "09:00", endTime: "18:00" },
    { date: "2099-02-05", startTime: "09:00", endTime: "15:00" },
    { date: "2099-02-06", startTime: "11:30", endTime: "18:00" },
    { date: "2099-02-07", startTime: "10:00", endTime: "17:00" },
  ];
  for (const shift of apiShifts) {
    const created = await requestJson("/api/shifts", {
      method: "POST",
      body: {
        employeeNumber,
        locationId: location.id,
        departmentId: "",
        ...shift,
        area: "API-Regressionsprüfung",
        note: "27 Stunden plus Samstagsfaktor",
      },
    });
    assert.equal(created.response.status, 201, created.text);
  }

  const schedule = await requestJson(
    `/api/schedule?week=2099-02-02&location=${encodeURIComponent(location.id)}`,
  );
  assert.equal(schedule.response.status, 200, schedule.text);
  assert.equal(schedule.payload.plannedTotals[employeeNumber], 27 * 60);
  assert.equal(schedule.payload.bonusTotals[employeeNumber], 2 * 60);
  assert.equal(schedule.payload.totals[employeeNumber], 29 * 60);
  assert.ok([
    schedule.payload.plannedTotals[employeeNumber],
    schedule.payload.bonusTotals[employeeNumber],
    schedule.payload.totals[employeeNumber],
  ].every(Number.isFinite));

  const vacation = await requestJson("/api/vacations", {
    method: "POST",
    body: {
      employeeNumber,
      dateFrom: "2099-02-02",
      dateTo: "2099-02-02",
      note: "Regressionsprüfung Urlaubswertung",
      locationId: location.id,
    },
  });
  assert.equal(vacation.response.status, 201, vacation.text);

  const scheduleWithVacation = await requestJson(
    `/api/schedule?week=2099-02-02&location=${encodeURIComponent(location.id)}`,
  );
  assert.equal(scheduleWithVacation.response.status, 200, scheduleWithVacation.text);
  assert.equal(scheduleWithVacation.payload.plannedTotals[employeeNumber], 27 * 60);
  assert.equal(scheduleWithVacation.payload.bonusTotals[employeeNumber], 2 * 60);
  assert.equal(scheduleWithVacation.payload.optionCreditTotals[employeeNumber], 384);
  assert.equal(scheduleWithVacation.payload.totals[employeeNumber], (29 * 60) + 384);
});

test("v0.88.5: wochenübergreifender Urlaub wird in jeder betroffenen Woche gewertet", async () => {
  const locations = await requestJson("/api/locations");
  assert.equal(locations.response.status, 200, locations.text);
  const location = locations.payload.find((entry) => entry.active !== false && entry.cost_center_id);
  assert.ok(location, "Aktive Testfiliale mit Kostenstelle fehlt");

  const employeeNumber = "v0885-vacation";
  const employee = await requestJson("/api/employees", {
    method: "POST",
    body: {
      personnelNumber: employeeNumber,
      fullName: "API Urlaubswertung",
      nickname: "Urlaub-Woche",
      color: "#287a58",
      contractedHours: 32,
      targetWorkdaysPerWeek: 5,
      preferredDayOff: "",
      fixedWorkdays: [],
      positionId: "verkaufsmitarbeiter",
      timeConfirmationLevel: "C",
      costCenterId: location.cost_center_id,
      preferredDepartmentId: "",
      active: true,
    },
  });
  assert.equal(employee.response.status, 201, employee.text);

  const vacation = await requestJson("/api/vacations", {
    method: "POST",
    body: {
      employeeNumber,
      dateFrom: "2099-02-05",
      dateTo: "2099-02-12",
      note: "Urlaub über zwei Kalenderwochen",
      locationId: location.id,
    },
  });
  assert.equal(vacation.response.status, 201, vacation.text);

  db.prepare(`
    UPDATE week_options
    SET week_start = '2099-02-02'
    WHERE employee_number = ? AND date_from = '2099-02-09'
  `).run(employeeNumber);

  const schedule = await requestJson(
    `/api/schedule?week=2099-02-09&location=${encodeURIComponent(location.id)}`,
  );
  assert.equal(schedule.response.status, 200, schedule.text);
  assert.ok(schedule.payload.weekOptions.some((option) => (
    option.employee_number === employeeNumber && option.option_type === "vacation"
  )));
  assert.equal(schedule.payload.plannedTotals[employeeNumber], 0);
  assert.equal(
    schedule.payload.optionCreditTotals[employeeNumber],
    4 * 384,
    JSON.stringify(schedule.payload.weekOptions.filter((option) => option.employee_number === employeeNumber)),
  );
  assert.equal(schedule.payload.totals[employeeNumber], 4 * 384);

  const automatic = await requestJson("/api/schedule/auto", {
    method: "POST",
    body: {
      weekStart: "2099-02-09",
      locationId: location.id,
      replaceExisting: false,
    },
  });
  assert.equal(automatic.response.status, 200, automatic.text);
  const scheduleAfterAutoPlanning = await requestJson(
    `/api/schedule?week=2099-02-09&location=${encodeURIComponent(location.id)}`,
  );
  assert.equal(scheduleAfterAutoPlanning.response.status, 200, scheduleAfterAutoPlanning.text);
  assert.equal(scheduleAfterAutoPlanning.payload.shifts.some((shift) => (
    shift.employee_number === employeeNumber
      && shift.shift_date >= "2099-02-09"
      && shift.shift_date <= "2099-02-12"
  )), false, "Urlaub muss auch den Auto-Planer sperren");
});

test("v0.88.5: Feiertage werden neben Dienst oder Urlaub genau einmal gewertet", async () => {
  const locations = await requestJson("/api/locations");
  assert.equal(locations.response.status, 200, locations.text);
  const location = locations.payload.find((entry) => entry.active !== false && entry.cost_center_id);
  assert.ok(location, "Aktive Testfiliale mit Kostenstelle fehlt");

  const employeeNumber = "v0885-holiday";
  const employee = await requestJson("/api/employees", {
    method: "POST",
    body: {
      personnelNumber: employeeNumber,
      fullName: "API Feiertagswertung",
      nickname: "Feiertag",
      color: "#8a4f23",
      contractedHours: 32,
      targetWorkdaysPerWeek: 5,
      preferredDayOff: "",
      fixedWorkdays: [],
      positionId: "verkaufsmitarbeiter",
      timeConfirmationLevel: "C",
      costCenterId: location.cost_center_id,
      preferredDepartmentId: "",
      active: true,
    },
  });
  assert.equal(employee.response.status, 201, employee.text);

  const shift = await requestJson("/api/shifts", {
    method: "POST",
    body: {
      employeeNumber,
      locationId: location.id,
      departmentId: "",
      date: "2099-05-01",
      startTime: "09:00",
      endTime: "17:00",
      area: "Feiertagsregression",
      note: "Dienst statt zusätzlicher Feiertagsgutschrift",
    },
  });
  assert.equal(shift.response.status, 201, shift.text);
  const shiftWeek = await requestJson(
    `/api/schedule?week=2099-04-27&location=${encodeURIComponent(location.id)}`,
  );
  assert.equal(shiftWeek.response.status, 200, shiftWeek.text);
  assert.equal(shiftWeek.payload.plannedTotals[employeeNumber], 450);
  assert.equal(shiftWeek.payload.optionCreditTotals[employeeNumber], 0);
  assert.equal(shiftWeek.payload.totals[employeeNumber], 450);

  const vacation = await requestJson("/api/vacations", {
    method: "POST",
    body: {
      employeeNumber,
      dateFrom: "2099-01-06",
      dateTo: "2099-01-06",
      note: "Urlaub am Feiertag",
      locationId: location.id,
    },
  });
  assert.equal(vacation.response.status, 201, vacation.text);
  const vacationWeek = await requestJson(
    `/api/schedule?week=2099-01-05&location=${encodeURIComponent(location.id)}`,
  );
  assert.equal(vacationWeek.response.status, 200, vacationWeek.text);
  assert.equal(vacationWeek.payload.plannedTotals[employeeNumber], 0);
  assert.equal(vacationWeek.payload.optionCreditTotals[employeeNumber], 384);
  assert.equal(vacationWeek.payload.totals[employeeNumber], 384);
});

test("v0.88.5: fehlende oder ungültige Samstagswerte fallen sicher auf 13:00 und Faktor 1,5 zurück", async () => {
  const saturdayShift = weeklyShifts.at(-1);
  const invalidSettings = [
    { ...baseSettings, saturday_bonus_from: undefined },
    { ...baseSettings, saturday_bonus_from: "ungültig" },
    { ...baseSettings, saturday_bonus_factor: undefined },
    { ...baseSettings, saturday_bonus_factor: "NaN" },
    { ...baseSettings, saturday_bonus_factor: "Infinity" },
    { ...baseSettings, saturday_bonus_factor: "0.5" },
  ];

  for (const settings of invalidSettings) {
    const metrics = await shiftMetrics(saturdayShift, settings);
    assert.deepEqual(
      {
        raw: metrics.raw_minutes,
        breaks: metrics.break_minutes,
        bonus: metrics.bonus_minutes,
        counted: metrics.counted_minutes,
      },
      { raw: 420, breaks: 30, bonus: 120, counted: 510 },
    );
    assert.ok(Object.values(metrics).every(Number.isFinite));
  }
});

test("v0.88.5: die Wochenaggregation verwendet bei ungültiger Bewertung die finite Netto-Planzeit", () => {
  const basis = scheduleShiftMinuteBasis({
    raw_minutes: 420,
    break_minutes: 30,
    bonus_minutes: Number.NaN,
    counted_minutes: Number.NaN,
  });

  assert.deepEqual(basis, {
    plannedMinutes: 390,
    bonusMinutes: 0,
    countedMinutes: 390,
  });
  assert.ok(Object.values(basis).every(Number.isFinite));
});

test("v0.88.5: Urlaubstage werden nur Montag bis Freitag und pro Woche höchstens einmal gewertet", () => {
  const option = {
    employee_number: "419",
    option_type: "vacation",
    date_from: "2099-02-02",
    date_to: "2099-02-07",
    all_day: 1,
  };
  assert.equal(
    countCreditedOptionDaysInRange(option, "2099-02-02", "2099-02-08", null),
    5,
    "Samstag und Sonntag dürfen keine Urlaubsgutschrift erzeugen",
  );
  assert.equal(
    countCreditedOptionDaysInRange({
      ...option,
      date_from: "2099-02-07",
      date_to: "2099-02-07",
    }, "2099-02-02", "2099-02-08", null),
    0,
  );

  const blocked = new Set(["419|2099-02-03"]);
  const claimed = new Set();
  assert.equal(
    claimCreditedOptionDaysInRange(
      option,
      "2099-02-02",
      "2099-02-08",
      null,
      blocked,
      claimed,
    ),
    4,
  );
  assert.equal(
    claimCreditedOptionDaysInRange(
      option,
      "2099-02-02",
      "2099-02-08",
      null,
      blocked,
      claimed,
    ),
    0,
    "Ein doppelter Altbestand darf dieselben Urlaubstage nicht erneut gutschreiben",
  );
});

test("v0.88.5: berechneter Krankenstand wird nicht neben Dienst, Urlaub oder erneut am selben Tag gewertet", () => {
  const blockedByShift = new Set(["419|2099-02-02"]);
  const blockedByVacation = new Set(["419|2099-02-03"]);
  const claimedSicknessDates = new Set();

  assert.equal(claimEmployeeDate("419", "2099-02-02", blockedByShift, claimedSicknessDates), false);
  assert.equal(claimEmployeeDate("419", "2099-02-03", blockedByVacation, claimedSicknessDates), false);
  assert.equal(claimEmployeeDate("419", "2099-02-04", new Set(), claimedSicknessDates), true);
  assert.equal(claimEmployeeDate("419", "2099-02-04", new Set(), claimedSicknessDates), false);
  assert.deepEqual([...claimedSicknessDates], ["419|2099-02-04"]);
});

test("v0.88.5: die Wochenstunden-UI stellt ungültige API-Werte nicht als null Stunden dar", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const start = appSource.indexOf("function renderHoursOverview()");
  const end = appSource.indexOf("function formatVacationDateRange", start);
  const renderSource = appSource.slice(start, end);

  assert.match(appSource, /function hoursOverviewMinutes[\s\S]*Number\.isFinite/);
  assert.match(renderSource, /Berechnungsfehler/);
  assert.doesNotMatch(renderSource, /state\.data\.(?:plannedTotals|optionCreditTotals|totals)\[[^\]]+\] \|\| 0/);
});
