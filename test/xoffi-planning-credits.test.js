"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { buildComparison } = require("../lib/xoffi-plan-comparison");
const source = fs.readFileSync(require.resolve("../server.js"), "utf8").replace(/\r\n/g, "\n");
const dates = Array.from({ length: 7 }, (_, i) => `2026-09-${14 + i}`);
const query = { locationId: "18", weekStart: dates[0], weekEnd: dates[6] };
function extract(name) {
  const point = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}\n", point);
  assert.ok(point >= 0 && end > point, name);
  return source.slice(source.slice(point - 6, point) === "async " ? point - 6 : point, end + 3);
}
function subject(sicknessCredits = []) {
  const context = vm.createContext({
    alwaysFullDayOptionTypes: new Set(["vacation", "sick", "branch", "vocational_school", "special_leave"]),
    TEAM_MEETING_GROUP_PREFIX: "team-meeting:",
    isVacationHoliday: () => false,
    sicknessCreditsForEmployeesInRange: async () => sicknessCredits,
  });
  vm.runInContext([
    "isIsoDate", "isTime", "addDays", "timeToMinutes", "finiteScheduleMinutes", "optionIsAllDay",
    "optionMinutesPerDay", "vacationDayCount", "creditedOptionDatesInRange", "claimEmployeeDate", "isTeamMeetingGroupId",
    "isTeamWideMeetingOption", "employeeDateHasSickness", "optionLabel", "xoffiPlannedOptionCredits",
  ].map(extract).join("\n"), context);
  return context.xoffiPlannedOptionCredits;
}
const school = (overrides = {}) => ({ employee_number: "419", date_from: dates[1], date_to: dates[1],
  option_type: "school", all_day: "1", credited_minutes_per_day: "600", contracted_hours: 30, ...overrides });

test("ten-hour school option corrects the daily comparison and the 23.5-hour week", async () => {
  const shifts = [0, 3, 4].map(i => ({ employee_number: "419", shift_date: dates[i],
    raw_minutes: i === 0 ? 420 : 540, break_minutes: 30 }));
  const planCredits = await subject()([school()], shifts, query);
  const row = buildComparison({ dates, shifts, planCredits,
    employees: [{ personnel_number: "419", full_name: "Testperson Schulung" }],
    imports: [{ employee_number: "419", import_id: "synthetic", use_as_actual: 1 }],
    importDays: dates.map((date, i) => ({ employee_number: "419", import_id: "synthetic", work_date: date,
      actual_minutes: [520, 600, 0, 525, 520, 0, 0][i], valued_minutes: [520, 600, 0, 525, 520, 0, 0][i] })),
  })[0];
  assert.equal(row.days[1].plannedMinutes, 600);
  assert.equal(row.days[1].differenceMinutes, 0);
  assert.equal(row.days[1].severity, "green");
  assert.deepEqual(row.days[1].planCredits, [{ label: "Schulung", minutes: 600 }]);
  assert.equal(row.plannedMinutes, 2010);
  assert.equal(row.actualMinutes, 2165);
  assert.equal(row.differenceMinutes, 155);
  assert.equal(row.severity, "yellow");
});

test("timed work options add to duties, full-day credits cannot duplicate a duty or one another", async () => {
  const timed = school({ all_day: 0, start_time: "18:00", end_time: "19:30" });
  const shifts = [{ employee_number: "419", shift_date: dates[1] }];
  const credits = await subject()([school(), timed], shifts, query);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].minutes, 90);
  assert.equal((await subject()([school(), school()], [], query)).length, 1);
});

test("range and weekday rules match planning, including vocational-school five-day cap", async () => {
  const credits = await subject()([school({ date_from: "2026-09-01", date_to: "2026-10-01" })], [], query);
  assert.deepEqual(Array.from(credits, credit => credit.date), dates.slice(0, 6));
  const vocational = await subject()([school({ option_type: "vocational_school", date_from: dates[0], date_to: dates[6] })], [], query);
  assert.equal(vocational.length, 5);
  assert.equal(vocational[0].minutes, 360);
});

test("paid absence contributes to valued plan only, time off has no credit", async () => {
  for (const option_type of ["vacation", "sick", "special_leave"]) {
    const planCredits = await subject()([school({ option_type })], [], query);
    assert.equal(planCredits[0].minutes, 360);
    const row = buildComparison({ dates, employees: [{ personnel_number: '419' }], shifts: [], planCredits, imports: [], importDays: [] })[0];
    assert.equal(row.valuedComparison.plannedMinutes, 360);
    assert.equal(row.presenceComparison.plannedMinutes, 0);
  }
  assert.equal((await subject()([school({ option_type: 'time_off' })], [], query)).length, 0);
  assert.equal((await subject()([school({ credited_minutes_per_day: 0 })], [], query)).length, 0);
});

test("team-wide meeting stays additive but is suppressed by recorded sickness", async () => {
  const meeting = school({ option_type: "team_meeting", group_id: "team-meeting:synthetic", all_day: 0,
    start_time: "18:00", end_time: "19:00" });
  const shifts = [{ employee_number: "419", shift_date: dates[1] }];
  assert.equal((await subject()([meeting], shifts, query))[0].minutes, 60);
  assert.equal((await subject()([meeting, school({ option_type: "sick" })], shifts, query)).length, 0);
  const withCase = subject([{ employee_number: "419", date: dates[1], minutes: 360 }]);
  assert.equal((await withCase([meeting], shifts, query, [{ employee_number: "419", date: dates[1], minutes: 360 }])).length, 0);
});

test("recorded sickness credits do not double count a shift or a planning option", async () => {
  const credit = [{ employee_number: '419', date: dates[1], minutes: 384 }];
  assert.equal((await subject()([], [], query, credit))[0].minutes, 384);
  assert.equal((await subject()([], [{ employee_number: '419', shift_date: dates[1] }], query, credit)).length, 0);
  const options = [school({ option_type: 'sick', contracted_hours: 32 })];
  const result = await subject()(options, [], query, credit);
  assert.equal(result.length, 1);
  assert.equal(result[0].minutes, 384);
});

test("out-of-scope and out-of-week credits never create people or add to totals", () => {
  const rows = buildComparison({ dates, employees: [{ personnel_number: "419", full_name: "Testperson" }], shifts: [],
    planCredits: [{ employeeNumber: "other", date: dates[0], minutes: 600, label: "Hidden" },
      { employeeNumber: "419", date: "2026-09-21", minutes: 600, label: "Next week" }], imports: [], importDays: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].plannedMinutes, 0);
  assert.equal(rows[0].actualMinutes, null);
});
