"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { inspectXoffiMhtmlBuffer, matchEmployee } = require("../lib/xoffi-mhtml-import");
const { fixtureHtml, mhtml } = require("../test-support/xoffi-mhtml");
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
  assert.doesNotMatch(JSON.stringify(result), /example.invalid|must never run/);
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
