"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
// Read function bodies without starting the application or touching a database.
const source = fs.readFileSync(require.resolve("../server"), "utf8").replace(/\r\n/g, "\n");
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 3);
}

function fixture(instant, vacationDate) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return Date.parse(instant); }
  }
  const employee = { personnel_number: "synthetic", nickname: "Synthetic", full_name: "Synthetic", home_location_id: "18" };
  const rows = [{ id: 1, group_id: "synthetic-vacation", employee_number: employee.personnel_number,
    nickname: employee.nickname, date_from: vacationDate, date_to: vacationDate }];
  // A synthetic day valuation isolates the cutoff date from branch/holiday rules.
  const countDays = (from, to) => Math.max(0, Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / 86400000) + 1);
  const sandbox = vm.createContext({ Date: FixedDate, Intl, process: { env: { NODE_ENV: "test" } },
    resolvePlanningContext: async () => ({ locationId: "18", departmentId: null }),
    assertSessionContextScope() {}, applyScopedPdfSettings: value => value, settingsForLocation: async () => ({}),
    publicHolidaysForRange: () => [], getGlobalDayBlocksForRange: () => [], serializeEmployee: value => ({ ...value }),
    planningSettingsRepository: {
      listVacationEmployees: async () => [employee], listCentralVacationEmployees: async () => [employee],
      listVacationEntitlements: async () => [{ employee_number: employee.personnel_number, days: 25 }],
      listVacationOptions: async () => rows, listCentralVacationOptions: async () => rows,
    },
    timeTrackingRepository: { listXoffiSnapshots: async () => [] },
    absenceManagementRepository: { vacationRequestSources: async () => [] },
    vacationDayCount: countDays, normalizeDepartmentId: () => null,
    getLocationsForSession: async () => [], getLocations: async () => [], getCostCenters: async () => [],
  });
  vm.runInContext(["isIsoDate", "viennaTodayIso", "validateYear", "daysBetweenInclusive", "vacationGroupKey",
    "getVacationPlan", "getCentralVacationPlan"].map(extract).join("\n"), sandbox);
  return sandbox;
}

const cases = [
  ["summer before Vienna midnight", "2026-07-13T21:59:59.000Z", "2026-07-14", "2026-07-13", 0],
  ["summer at Vienna midnight", "2026-07-13T22:00:00.000Z", "2026-07-14", "2026-07-14", 1],
  ["summer before UTC midnight", "2026-07-13T23:59:59.000Z", "2026-07-14", "2026-07-14", 1],
  ["winter before Vienna midnight", "2026-01-13T22:59:59.000Z", "2026-01-14", "2026-01-13", 0],
  ["winter at Vienna midnight", "2026-01-13T23:00:00.000Z", "2026-01-14", "2026-01-14", 1],
  ["winter after UTC midnight", "2026-01-14T00:00:00.000Z", "2026-01-14", "2026-01-14", 1],
  ["before Vienna year rollover", "2026-12-31T22:59:59.000Z", "2027-01-01", "2026-12-31", 0],
  ["at Vienna year rollover", "2026-12-31T23:00:00.000Z", "2027-01-01", "2027-01-01", 1],
  ["previous year remains consumed after rollover", "2026-12-31T23:00:00.000Z", "2026-12-31", "2027-01-01", 1],
];

for (const [label, instant, vacationDate, today, consumed] of cases) {
  test(`branch and central vacation consumption agree: ${label}`, async () => {
    const context = fixture(instant, vacationDate);
    assert.equal(context.viennaTodayIso(), today);
    const year = Number(vacationDate.slice(0, 4));
    const branch = await context.getVacationPlan(year, { locationId: "18" }, {});
    const central = await context.getCentralVacationPlan(year);
    for (const result of [branch, central]) {
      assert.equal(result.totals.synthetic.consumed, consumed);
      assert.equal(result.totals.synthetic.planned, 1);
      assert.equal(result.totals.synthetic.entitlement, 25);
      assert.equal(result.totals.synthetic.remaining, 24);
      assert.equal(result.vacations[0].date_from, vacationDate);
      assert.equal(result.vacations[0].date_to, vacationDate);
    }
    assert.equal(JSON.stringify(branch.totals), JSON.stringify(central.totals));
  });
}
