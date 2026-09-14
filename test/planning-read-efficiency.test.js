"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../server"), "utf8").replace(/\r\n/g, "\n");
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 3);
}
const plain = value => JSON.parse(JSON.stringify(value));
const addDays = (date, days) => new Date(Date.parse(date + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
function breaksFixture() {
  const state = { reads: [], shifts: [], settings: { break_rule_enabled: "1", break_after_minutes: "360", break_duration_minutes: "30" } };
  const context = vm.createContext({
    defaultSettings: { break_after_minutes: "360", break_duration_minutes: "30" },
    dayKeyForDate: date => ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(date + "T12:00:00Z").getUTCDay()],
    settingEnabled: (settings, key) => settings[key] === "1",
    timeToMinutes: value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)),
    isTime: value => /^\d{2}:\d{2}$/.test(value || ""),
    overlapMinutes: (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c)),
    workRuleEvaluationRange: week => ({ start: addDays(week, -112), end: addDays(week, 6) }),
    getGlobalDayBlocksForRange: () => [{ block_date: "2032-07-08", is_public_holiday: true }],
    settingsForLocation: async id => { state.reads.push(id); return { ...state.settings }; },
    shiftMetrics: () => { throw new Error("Payroll valuation is unnecessary for rule facts"); },
    planningSettingsRepository: { listWorkRuleShiftsForRange: async () => state.shifts },
  });
  vm.runInContext(["finiteNumberInRange", "dayConfiguration", "plannedShiftBreaks", "scheduleWorkRuleFacts"].map(extract).join("\n"), context);
  return { state, context };
}

test("rule facts use the same breaks for daytime, overnight, lunch and invalid fallback settings", async () => {
  const { context: c, state } = breaksFixture();
  const daytime = { shift_date: "2032-07-05", start_time: "09:00", end_time: "18:00" };
  assert.equal((await c.plannedShiftBreaks(daytime, state.settings)).breakMinutes, 30);
  const lunch = { ...state.settings, monday_lunch_enabled: "1", monday_lunch_start: "12:00", monday_lunch_end: "13:00" };
  assert.equal((await c.plannedShiftBreaks(daytime, lunch)).breakMinutes, 60);
  assert.equal((await c.plannedShiftBreaks({ ...daytime, start_time: "22:00", end_time: "06:00" }, lunch)).rawMinutes, 480);
  assert.equal((await c.plannedShiftBreaks({ ...daytime, end_time: "15:00" }, state.settings)).breakMinutes, 0);
  assert.equal((await c.plannedShiftBreaks(daytime, { ...state.settings, break_after_minutes: "NaN", break_duration_minutes: "Infinity" })).breakMinutes, 30);
});

test("hundreds of historical rule shifts share location reads without retaining settings between evaluations", async () => {
  const { context: c, state } = breaksFixture();
  state.shifts = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, employee_number: "E1", shift_date: addDays("2032-03-15", i % 100),
    location_id: i % 2 ? "18" : "05", department_id: i % 2 ? 1 : null, duty_code: "general", start_time: "09:00", end_time: "18:00" }));
  const args = ["2032-07-05", { locationId: "18" }, [{ personnel_number: "E1" }]];
  const facts = await c.scheduleWorkRuleFacts(...args);
  assert.equal(facts.shifts.length, 500);
  assert.deepEqual(state.reads.sort(), ["05", "18"]);
  assert.equal(facts.shifts.every(row => row.breakMinutes === 30 && row.breakSource === "configured_assumption"), true);
  assert.deepEqual(plain(facts.shifts[0]), { id: "1", employeeId: "E1", date: "2032-03-15", startTime: "09:00", endTime: "18:00", breakMinutes: 30,
    breakSource: "configured_assumption", locationId: "05", departmentId: null, dutyCode: "general" });
  assert.deepEqual(plain(facts.holidays), ["2032-07-08"]);
  state.reads.length = 0;
  state.settings.break_duration_minutes = "45";
  const fresh = await c.scheduleWorkRuleFacts(...args);
  assert.deepEqual(state.reads.sort(), ["05", "18"]);
  assert.equal(fresh.shifts.every(row => row.breakMinutes === 45), true);
});

test("rule facts retain deletions, replacement scopes, added shifts and foreign-employee exclusion", async () => {
  const { context: c, state } = breaksFixture();
  const base = { employee_number: "E1", location_id: "18", shift_date: "2032-07-05", start_time: "09:00", end_time: "18:00" };
  state.shifts = [{ ...base, id: 1 }, { ...base, id: 2, location_id: "05" }, { ...base, id: 3, employee_number: "foreign" }];
  const facts = await c.scheduleWorkRuleFacts("2032-07-05", { locationId: "18" }, [{ personnel_number: "E1" }], {
    replaceRange: { locationId: "18", dateFrom: "2032-07-05", dateTo: "2032-07-05" },
    addedShifts: [{ employeeNumber: "E1", locationId: "18", shiftDate: "2032-07-05", startTime: "10:00", endTime: "16:00" }],
  });
  assert.deepEqual(plain(facts.shifts.map(row => [row.id, row.locationId, row.breakMinutes])), [["2", "05", 30], ["candidate-new-0", "18", 0]]);
  const deleted = await c.scheduleWorkRuleFacts("2032-07-05", { locationId: "18" }, [{ personnel_number: "E1" }], { deleted: true, id: 2 });
  assert.deepEqual(plain(deleted.shifts.map(row => row.id)), ["1"]);
});

function sicknessFixture() {
  const state = { reads: 0, rows: [] };
  const context = vm.createContext({ addDays, isIsoDate: date => /^\d{4}-\d{2}-\d{2}$/.test(date || ""),
    sicknessStatusLookup: value => value,
    sicknessCasePayload: row => JSON.parse(row.protected_payload),
    creditedMinutesForDate: (valuation, date) => Number(valuation?.minutes?.[date] || 0),
    sicknessAmuManagementRepository: { listSicknessCasesForCredit: async () => { state.reads++; return state.rows; } },
  });
  vm.runInContext(["sicknessCreditForEmployeeDate", "sicknessCreditsForRange", "sicknessCreditsForEmployeesInRange", "sicknessCaseCoversDate", "sicknessPayloadCoversDate"].map(extract).join("\n"), context);
  return { state, context };
}

test("one weekly sickness read retains single-day results, newest-case priority, zero credits and recovery boundaries", async () => {
  const { state, context: c } = sicknessFixture();
  const row = (id, payload) => ({ id, protected_payload: JSON.stringify(payload) });
  state.rows = [
    { id: 99, protected_payload: "invalid" },
    row(4, { employeeNumber: "E1", status: "recovered", startDate: "2032-07-07", returnToWorkDate: "2032-07-09", timeValuation: { version: "new", minutes: { "2032-07-07": 0, "2032-07-08": 240 } } }),
    row(3, { employeeNumber: "E1", status: "reported", startDate: "2032-07-05", expectedEnd: "2032-07-07", timeValuation: { version: "old", minutes: { "2032-07-05": 480, "2032-07-06": 480, "2032-07-07": 480 } } }),
    row(2, { employeeNumber: "E2", status: "aum_received", startDate: "2032-07-06", expectedEnd: "", timeValuation: { version: "open", minutes: { "2032-07-06": 420 } } }),
    row(1, { employeeNumber: "foreign", status: "reported", startDate: "2032-07-01" }),
  ];
  const expected = [];
  for (const employee of ["E1", "E2", "none"]) for (let date = "2032-07-05"; date <= "2032-07-11"; date = addDays(date, 1)) {
    const credit = await c.sicknessCreditForEmployeeDate(employee, date);
    if (credit.caseId != null) expected.push({ employee_number: employee, date, ...credit });
  }
  state.reads = 0;
  const credits = await c.sicknessCreditsForEmployeesInRange(["E1", "E2", "none"], "2032-07-05", "2032-07-11");
  assert.deepEqual(plain(credits), plain(expected));
  assert.equal(state.reads, 1);
  assert.equal(credits.find(row => row.employee_number === "E1" && row.date === "2032-07-07").minutes, 0);
  assert.equal(credits.some(row => row.employee_number === "E1" && row.date >= "2032-07-09"), false);
  state.rows = [];
  assert.deepEqual(plain(await c.sicknessCreditsForRange("E1", "2032-07-05", "2032-07-11")), []);
  state.reads = 0;
  assert.deepEqual(plain(await c.sicknessCreditsForEmployeesInRange([], "2032-07-05", "2032-07-11")), []);
  assert.equal(state.reads, 0);
});
