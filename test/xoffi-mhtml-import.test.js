"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { inspectXoffiMhtmlBuffer, matchEmployee } = require("../lib/xoffi-mhtml-import");
const { fixtureHtml, holidayFixtureHtml, mhtml } = require("../test-support/xoffi-mhtml");
const { reconcileXoffiWeek, XoffiWeekReconciliationError } = require("../lib/xoffi-week-reconciliation");
const { staffAssignmentRequestPeriod } = require("../lib/cross-location-schedule-access");

for (const encoding of ["base64", "quoted-printable", "8bit"]) test(`MHTML ${encoding}: exact week, name, daily credits and independent balances`, () => {
  const result = inspectXoffiMhtmlBuffer(mhtml(fixtureHtml(), encoding), { employees: [{ personnel_number: "42", full_name: "Mara Filialleitung" }] });
  assert.equal(result.weekStart, "2026-09-07");
  assert.equal(result.weekEnd, "2026-09-13");
  assert.equal(result.weekResolution.confirmationRequired, false);
  const row = result.employees[0];
  assert.equal(row.employeeNumber, "42");
  assert.equal(row.weeklyActualMinutes, 1245);
  assert.equal(row.weeklyValuedMinutes, 1983);
  assert.equal(row.weeklySurchargeMinutes, 60);
  assert.equal(row.closingBalanceMinutes, null);
  assert.deepEqual(row.days.map(day => day.valuedMinutes), [510,384,384,525,0,180,0]);
  assert.equal(row.days[1].actualMinutes, 90);
  assert.equal(row.days[1].surchargeMinutes, 0);
  assert.equal(row.days[2].absence, "vacation");
  assert.deepEqual(row.days[5].intervals, ["13:00-15:00"]);
  assert.equal(row.days[5].actualMinutes, 120);
  assert.equal(row.snapshot.balanceDate, "2026-09-06");
  assert.equal(row.snapshot.remainingVacationDays, 37.5);
  assert.equal(row.snapshot.openingBalanceMinutes, 180);
  assert.equal(row.snapshot.weeklyBalanceDeltaMinutes, 63);
  assert.equal(row.snapshot.dailyTargetMinutes * row.snapshot.workdaysPerWeek, 1920);
  assert.equal(row.snapshot.weeklyHolidayMinutes, null);
  assert.equal(row.snapshot.sourceWeeklyValuedMinutes, 1983);
  assert.equal(row.snapshot.sourceWeeklySurchargeMinutes, 60);
  assert.deepEqual(row.snapshot.valuationReconciliation, {
    version: 1, status: "daily", dailyValuedMinutes: 1983,
    unallocatedHolidayMinutes: 0, roundingDifferenceMinutes: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /example.invalid|must never run/);
});

for (const encoding of ["base64", "quoted-printable", "8bit"]) test(`MHTML ${encoding}: weekly holiday credit explains the source without inventing a day`, () => {
  const result = inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml(), encoding), {
    employees: [{ personnel_number: "42", full_name: "Feiertag Beispiel" }],
  });
  const row = result.employees[0];
  assert.equal(row.employeeNumber, "42");
  assert.equal(row.weeklyActualMinutes, 1500);
  assert.equal(row.weeklyValuedMinutes, 2460);
  assert.equal(row.weeklySurchargeMinutes, 0);
  assert.deepEqual(row.days.map(day => day.valuedMinutes), [510,510,0,480,480,0,0]);
  assert.equal(row.days[3].absence, "vacation");
  assert.deepEqual(row.days[5], { workDate: "2026-09-12", intervals: [], actualMinutes: 0,
    valuedMinutes: 0, surchargeMinutes: 0, absence: "", confidence: 100 });
  assert.equal(row.snapshot.version, 1);
  assert.equal(row.snapshot.sourceAttendanceMinutes, 2460);
  assert.equal(row.snapshot.sourceWeeklyValuedMinutes, 2460);
  assert.equal(row.snapshot.sourceWeeklySurchargeMinutes, 0);
  assert.equal(row.snapshot.weeklyHolidayMinutes, 480);
  assert.deepEqual(row.snapshot.valuationReconciliation, {
    version: 1, status: "weekly_holiday", dailyValuedMinutes: 1980,
    unallocatedHolidayMinutes: 480, roundingDifferenceMinutes: 0,
  });
  assert.equal(row.warnings.length, 1);
  assert.match(row.warnings[0], /nur als Wochenposten.*keinem einzelnen Tag/);
  assert.equal(row.days.flatMap(day => day.intervals).length, 6);
});

test("MHTML: supported holiday labels and comma decimal hours retain the same separate source credit", () => {
  for (const holidayLabel of ["Feiertagstunden", "Feiertagsstunden", "Feiertag (Std)", "Feiertag (Std.):"]) {
    const row = inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({ holidayHours: "8,00", holidayLabel }))).employees[0];
    assert.equal(row.snapshot.weeklyHolidayMinutes, 480, holidayLabel);
    assert.equal(row.snapshot.valuationReconciliation.unallocatedHolidayMinutes, 480, holidayLabel);
  }
});

test("MHTML: holiday hours already in daily totals are not counted again", () => {
  const row = inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({ dailyHolidayHours: "8.00" }))).employees[0];
  assert.equal(row.weeklyValuedMinutes, 2460);
  assert.equal(row.days.reduce((sum, day) => sum + day.valuedMinutes, 0), 2460);
  assert.equal(row.snapshot.weeklyHolidayMinutes, 480);
  assert.equal(row.snapshot.valuationReconciliation.status, "daily");
  assert.equal(row.snapshot.valuationReconciliation.unallocatedHolidayMinutes, 0);
  assert.equal(row.weeklyActualMinutes, 1500);
  assert.deepEqual(row.days[5].intervals, []);
  assert.ok(!row.warnings.some(warning => /Wochenposten/.test(warning)));
});

test("MHTML: absent and explicit zero holiday credits remain distinct and cannot explain a missing eight hours", () => {
  for (const holidayHours of [null, "0.00"]) {
    assert.throws(() => inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({ holidayHours }))),
      { code: "XOFFI_MHTML_VALUES_INVALID" });
    const row = inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({ holidayHours, weeklyValuedHours: "33.00" }))).employees[0];
    assert.equal(row.snapshot.weeklyHolidayMinutes, holidayHours === null ? null : 0);
    assert.equal(row.snapshot.valuationReconciliation.unallocatedHolidayMinutes, 0);
  }
});

test("MHTML: unexplained, partially explained and duplicated holiday metrics still fail closed", () => {
  const invalid = [
    holidayFixtureHtml({ weeklyValuedHours: "42.00" }),
    holidayFixtureHtml({ weeklyValuedHours: "32.00" }),
    holidayFixtureHtml({ weeklyValuedHours: "37.00" }),
    holidayFixtureHtml({ dailyHolidayHours: "4.00" }),
    ...["-8.00", "169.00", "8.001", "NaN", ""].map(holidayHours => holidayFixtureHtml({ holidayHours })),
    holidayFixtureHtml().replace('<td>Feiertagstunden</td><td>8.00</td>',
      '<td>Feiertagstunden</td><td>8.00</td></tr><tr><td>Feiertagsstunden</td><td>8.00</td>'),
    holidayFixtureHtml({ weeklyValuedHours: "33.00", holidayHours: "40.00" }),
    holidayFixtureHtml().replace('<td>Mehrstunden</td><td>1.00</td>',
      '<td>Zuschläge</td><td>1.00</td></tr><tr><td>Mehrstunden</td><td>1.00</td>'),
  ];
  for (const html of invalid) assert.throws(() => inspectXoffiMhtmlBuffer(mhtml(html)),
    { code: "XOFFI_MHTML_VALUES_INVALID" });
});

test("MHTML: per-day rounding tolerance stays limited for both direct and holiday reconciliation", () => {
  for (const [weeklyValuedHours, holidayHours, difference] of [
    ["41.12", "8.00", 7], ["40.88", "8.00", -7], ["33.12", null, 7], ["32.88", null, -7],
  ]) {
    const row = inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({ weeklyValuedHours, holidayHours }))).employees[0];
    assert.equal(row.snapshot.valuationReconciliation.roundingDifferenceMinutes, difference);
  }
  for (const [weeklyValuedHours, holidayHours] of [
    ["41.13", "8.00"], ["40.87", "8.00"], ["33.13", null], ["32.87", null],
  ]) assert.throws(() => inspectXoffiMhtmlBuffer(mhtml(holidayFixtureHtml({ weeklyValuedHours, holidayHours }))),
    { code: "XOFFI_MHTML_VALUES_INVALID" });
});

test("week reconciliation requires seven dense days and strictly bounded numeric minutes", () => {
  const days = Array.from({ length: 7 }, () => ({ valuedMinutes: 0, surchargeMinutes: 0 }));
  const valid = { days, weeklyValuedMinutes: 0, weeklySurchargeMinutes: 0, weeklyHolidayMinutes: null };
  assert.equal(reconcileXoffiWeek(valid).status, "daily");
  const invalid = [null, [], {}, { ...valid, days: days.slice(1) }, { ...valid, days: Array(7) },
    ...["0", false, NaN, Infinity, -1, 20161, 0.5].map(weeklyValuedMinutes => ({ ...valid, weeklyValuedMinutes })),
    ...["0", false, NaN, Infinity, -1, 10081, 0.5].map(weeklyHolidayMinutes => ({ ...valid, weeklyHolidayMinutes })),
    { ...valid, days: [{ valuedMinutes: "0", surchargeMinutes: 0 }, ...days.slice(1)] },
    { ...valid, days: [{ valuedMinutes: 2881, surchargeMinutes: 0 }, ...days.slice(1)] },
    { ...valid, days: [{ valuedMinutes: 0, surchargeMinutes: 1441 }, ...days.slice(1)] },
    { ...valid, weeklySurchargeMinutes: "0" }, { ...valid, weeklySurchargeMinutes: 10081 },
  ];
  for (const value of invalid) assert.throws(() => reconcileXoffiWeek(value), XoffiWeekReconciliationError);
  assert.deepEqual(days, Array.from({ length: 7 }, () => ({ valuedMinutes: 0, surchargeMinutes: 0 })));
});

test("MHTML: ambiguous names stay unresolved, name order and umlauts match", () => {
  const employees = [{ personnel_number: "1", full_name: "Mara Müller" }, { personnel_number: "2", full_name: "Maria Müller" }];
  assert.equal(matchEmployee("Muller Mara", employees), "1");
  assert.equal(matchEmployee("Mara", employees), "");
  assert.equal(matchEmployee("Mara Muller", [...employees, { personnel_number: "3", full_name: "Mara Müller" }]), "");
});
test("MHTML: inconsistent or mixed dates and incomplete totals are rejected", () => {
  for (const html of [fixtureHtml({week:38}),fixtureHtml({balanceDate:"07.09.2026"}),fixtureHtml({balanceDate:"31.02.2026"}),
    fixtureHtml().replace('Gesamt: 8.50','Gesamt: 9.50'),fixtureHtml().replace('Gesamt: 0.00','missing'),
    fixtureHtml()+fixtureHtml({week:38,balanceDate:"13.09.2026",name:"Other Person"})]) {
    assert.throws(() => inspectXoffiMhtmlBuffer(mhtml(html)), /XOFFI_MHTML_/);
  }
});
test("MHTML: mixed sheets preserve every row and localize invalid day, week and source-summary values", () => {
  const invalid = [
    [fixtureHtml({ name: "Tag Beispiel" }).replace("Gesamt: 8.50", "missing"),
      { code: "XOFFI_MHTML_VALUES_INVALID", rowNumber: 2, reason: "day_values", dayIndex: 0, workDate: "2026-09-07" }],
    [holidayFixtureHtml({ name: "Woche Beispiel", weeklyValuedHours: "42.00" }),
      { code: "XOFFI_MHTML_VALUES_INVALID", rowNumber: 2, reason: "weekly_totals", dailyValuedMinutes: 1980,
        sourceWeeklyValuedMinutes: 2520, sourceWeeklyHolidayMinutes: 480, sourceWeeklySurchargeMinutes: 0, dailySurchargeMinutes: 0 }],
    [fixtureHtml({ name: "Stand Beispiel" }).replace("37.50", "missing"),
      { code: "XOFFI_MHTML_VALUES_INVALID", rowNumber: 2, reason: "source_summary" }],
  ];
  for (const [html, diagnostic] of invalid) {
    const result = inspectXoffiMhtmlBuffer(mhtml(fixtureHtml({ name: "Gültig Beispiel" }) + html));
    assert.deepEqual(result.reviewSummary, { totalRows: 2, validRows: 1, invalidRows: 1 });
    assert.equal(result.employees[0].reviewStatus, "valid");
    const row = result.employees[1];assert.equal(row.reviewStatus, "invalid");
    assert.deepEqual(row.days, []);assert.equal(row.snapshot, null);
    assert.equal(Object.hasOwn(row, "weeklyValuedMinutes"), false);
    assert.deepEqual(row.diagnostics, [diagnostic]);
    assert.doesNotMatch(JSON.stringify(result), /example.invalid|must never run/);
  }
});
test("MHTML: partial preview never bypasses invalid calendars, damaged row structure, duplicate people or all-invalid sheets", () => {
  const invalid = fixtureHtml({ name: "Andere Beispiel" }).replace("Gesamt: 8.50", "missing");
  for (const html of [
    invalid + invalid.replace("Andere Beispiel", "Zweite Beispiel"),
    fixtureHtml() + invalid.replace("Andere Beispiel", "Filialleitung Mara"),
    fixtureHtml() + fixtureHtml({ week: 38, balanceDate: "13.09.2026", name: "Andere Beispiel" }).replace("Gesamt: 8.50", "missing"),
    fixtureHtml() + invalid.replace("06.09.2026", "07.09.2026"),
    fixtureHtml() + invalid.replace("Wa: KW 37", "Wa: KW ??"),
    fixtureHtml() + invalid.replace("Vorgaben/Stand:", "missing"),
    fixtureHtml() + invalid.replace('<td><div>Gesamt: 0.00</div></td>', ''),
  ]) assert.throws(() => inspectXoffiMhtmlBuffer(mhtml(html)), /XOFFI_MHTML_/);
});
test("MHTML: nested archives decode, absent data and broken MIME fail closed", () => {
  const nested=Buffer.from('Content-Type: multipart/related; boundary=outer\r\n\r\n--outer\r\n'+mhtml().toString()+'\r\n--outer--\r\n');
  assert.equal(inspectXoffiMhtmlBuffer(nested).employees.length,1);
  assert.throws(()=>inspectXoffiMhtmlBuffer(mhtml('<html><iframe src="https://example.invalid"></iframe></html>')),{code:'XOFFI_MHTML_DATA_MISSING'});
  assert.throws(()=>inspectXoffiMhtmlBuffer(mhtml().subarray(0,-10)),{code:'XOFFI_MHTML_INVALID'});
  assert.throws(()=>inspectXoffiMhtmlBuffer(mhtml().subarray(0,20)),{code:'XOFFI_IMAGE_SIZE_INVALID'});
});
test("Request period: six calendar months, month-end clamp and leap-year", () => {
  assert.deepEqual(staffAssignmentRequestPeriod("2026-09-17"),{minimum:"2026-09-17",maximum:"2027-03-17"});
  assert.equal(staffAssignmentRequestPeriod("2026-08-31").maximum,"2027-02-28");
  assert.equal(staffAssignmentRequestPeriod("2023-08-31").maximum,"2024-02-29");
  assert.throws(()=>staffAssignmentRequestPeriod("2026-02-30"));
});

test("Xoffi deployment helper refuses execution outside the installed maintenance scope", async () => {
  await assert.rejects(require("../server-tools/linux/lib/xoffi-snapshots-migrate").main([]),
    /PG_XOFFI_MIGRATION_INSTALLED_SCOPE/);
});

test("Same-day requests close three hours before closing; the six-month horizon stays anchored to today", () => {
  const rule = localTime => staffAssignmentRequestPeriod("2026-09-17", { localTime, open:true, closingTime:"18:00" });
  assert.equal(rule("14:59:59").minimum, "2026-09-17");
  assert.equal(rule("15:00:00").sameDay.allowed, true);
  assert.equal(rule("15:00:01").minimum, "2026-09-18");
  assert.equal(rule("23:59:59").maximum, "2027-03-17");
  assert.equal(rule("20:00").sameDay.cutoffTime, "15:00");
  assert.equal(staffAssignmentRequestPeriod("2026-12-31", {localTime:"14:00",open:true,closingTime:"13:00"}).minimum,"2027-01-01");
  assert.equal(staffAssignmentRequestPeriod("2026-09-20", {localTime:"09:00",open:false}).sameDay.reason,"closed");
  assert.equal(staffAssignmentRequestPeriod("2026-09-17", {localTime:"00:00",open:true,closingTime:"02:00"}).sameDay.allowed,false);
});
