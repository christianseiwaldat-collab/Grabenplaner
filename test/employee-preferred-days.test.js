"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { preferredDaysOff, preferredDaysLimit, validatePreferredDays, preferredDayCost, protectedPersonnelName } = require("../lib/employee-preferences");
const { createSicknessValuationSnapshot } = require("../lib/sickness-valuation");
const { mappedPersonnelRow } = require("../lib/personnel-import");
const { buildProblem } = require("../lib/planning-optimizer");

test("ranked preferences retain legacy values, validate all four priorities and reject invalid or duplicated days", () => {
  assert.deepEqual(preferredDaysOff({ preferred_day_off: "monday" }), ["monday"]);
  const days = ["wednesday", "saturday", "monday", "friday"];
  assert.deepEqual(validatePreferredDays(days), days);
  assert.deepEqual(preferredDaysOff({ preferred_day_off: days.join(",") }), days);
  assert.deepEqual(preferredDaysOff({ preferred_day_off: "monday", preferred_days_off: days }), days);
  assert.equal(preferredDaysLimit({ isBranch: true, positionId: "teamleitung" }), 4);
  assert.equal(preferredDaysLimit({ isBranch: true, positionId: "verkaufsmitarbeiter" }), 4);
  assert.equal(preferredDaysLimit({ isBranch: false, positionId: "teamleitung" }), 1);
  for (const value of [[...days, "tuesday"], ["monday", "monday"], ["sunday"], ["monday", 2], {}, "not-a-day"]) {
    assert.throws(() => validatePreferredDays(value), { code: "EMPLOYEE_PREFERRED_DAYS_INVALID" });
  }
  assert.deepEqual(days.map(day => preferredDayCost({ preferred_days_off: days }, day)), [4, 3, 2, 1]);
  assert.equal(preferredDayCost({ preferred_days_off: days }, "thursday"), 0);
});

test("additional wishes do not change statutory or historical sickness valuation", () => {
  const options = { contractedHours: 32, targetWorkdays: 4, fixedWorkdays: ["monday", "tuesday", "thursday", "friday"], capturedAt: "2026-10-01T00:00:00Z" };
  const legacy = createSicknessValuationSnapshot({ ...options, preferredDayOff: "wednesday" });
  const original = JSON.stringify(legacy);
  assert.deepEqual(createSicknessValuationSnapshot({ ...options, preferredDayOff: "wednesday,saturday,monday,friday" }), legacy);
  assert.equal(JSON.stringify(legacy), original);
});

test("imports preserve priority order and retain legacy single-day mapping", () => {
  const mapping = { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, preferredDaysOff: { columnIndex: 2 } };
  const row = mappedPersonnelRow([{ text: "420" }, { text: "Test Person" }, { text: "Mi; Sa; Mo; Fr" }], mapping);
  assert.deepEqual(row.preferredDaysOff, ["wednesday", "saturday", "monday", "friday"]);
  const legacy = mappedPersonnelRow([{ text: "Montag" }], { preferredDayOff: { columnIndex: 0 } });
  assert.equal(legacy.preferredDayOff, "monday");
  assert.equal(legacy.preferredDaysOff, undefined);
  const invalid = mappedPersonnelRow([{ text: "Mo; unbekannt" }], { preferredDaysOff: { columnIndex: 0 } });
  assert.throws(() => validatePreferredDays(invalid.preferredDaysOff));
});

test("only complete current first and last name become the public employee name", () => {
  assert.equal(protectedPersonnelName({ identity: { firstName: " Anna ", lastName: " Beispiel ", title: "Dr.", previousName: "Private", birthDate: "1990-01-01" } }), "Anna Beispiel");
  assert.equal(protectedPersonnelName({ identity: { firstName: "Anna" } }), "");
  assert.equal(protectedPersonnelName({ sensitive: { identity: { firstName: "Anna", lastName: "Beispiel" } } }), "Anna Beispiel");
});

test("optimizer carries all ranked wishes to the solver while approved credits retain their independent effect", async () => {
  const snapshot = { schedule: { employees: [{ personnel_number: "one", contracted_hours: 4, preferred_days_off: ["monday", "wednesday", "friday", "saturday"] }], settings: {}, globalBlockDates: [] }, rawShifts: [],
    facts: { period: { from: "2031-04-07", to: "2031-04-12" }, context: { locationId: "A", departmentId: null },
      employees: [{ id: "one", hoursComplete: true, targetMinutes: 240, creditedMinutes: 120 }], shifts: [], qualifications: { available: true, checks: [] }, requirements: [] } };
  const built = await buildProblem(snapshot, { mode: "optimize" }, {
    day: async () => ({ open: true, start: "09:00", end: "13:00" }), history: async () => ({}),
    candidate: async shift => ({ shift, minutes: 120, coverage: [{ start: 540, end: 660 }] }),
  }, {});
  const costs = Object.fromEntries(built.candidates.map(candidate => [candidate.shift.shiftDate, candidate.preferenceCost]));
  assert.deepEqual(costs, { "2031-04-07": 4, "2031-04-08": 0, "2031-04-09": 3, "2031-04-10": 0, "2031-04-11": 2, "2031-04-12": 1 });
  assert.equal(built.problem.employees[0].targetMinutes, 240);
  assert.equal(built.problem.employees[0].creditMinutes, 120);
  assert.equal(built.problem.preferenceCostScale, 4);
  snapshot.schedule.weekOptions = [{ soft_pending: true, employee_number: "one", date_from: "2031-04-08", date_to: "2031-04-08" }];
  const pending = await buildProblem(snapshot, { mode: "optimize" }, {
    day: async () => ({ open: true, start: "09:00", end: "13:00" }), history: async () => ({}),
    candidate: async shift => ({ shift, minutes: 120, coverage: [{ start: 540, end: 660 }] }),
  }, {});
  assert.equal(pending.candidates.find(candidate => candidate.shift.shiftDate === "2031-04-08").preferenceCost, 4);
});
