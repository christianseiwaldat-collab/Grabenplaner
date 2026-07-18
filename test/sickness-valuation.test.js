"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  calendarDaysInclusive,
  createAumAllowanceSnapshot,
  createSicknessValuationSnapshot,
  creditedMinutesForDate,
  extendSicknessValuationSnapshot,
  reconcileAumAllowanceSnapshot,
  valuationWorkday,
} = require("../lib/sickness-valuation");

test("AUM Block 4: nur freigeschaltete Vertrauensstufe A nutzt das Jahreskontingent", () => {
  const policy = { enabled: true, maxCasesPerYear: 3, maxCalendarDaysPerCase: 1 };
  const eligible = createAumAllowanceSnapshot({
    policy, employeeEnabled: true, trustLevel: "A", usedCases: 1,
    startDate: "2026-07-17", endDate: "2026-07-17", evaluatedAt: "2026-07-17T08:00:00.000Z",
  });
  assert.equal(eligible.required, false);
  assert.equal(eligible.consumesQuota, true);
  assert.equal(eligible.remainingCasesAfter, 1);

  for (const input of [
    { employeeEnabled: false, trustLevel: "A", reason: "employee_disabled" },
    { employeeEnabled: true, trustLevel: "B", reason: "trust_level" },
  ]) {
    const result = createAumAllowanceSnapshot({
      policy, ...input, startDate: "2026-07-17", endDate: "2026-07-17",
    });
    assert.equal(result.required, true);
    assert.equal(result.consumesQuota, false);
    assert.equal(result.reason, input.reason);
  }
});

test("AUM Block 4: ausgeschöpftes Kontingent und vorhandene AUM verbrauchen keinen weiteren Fall", () => {
  const policy = { enabled: true, maxCasesPerYear: 2, maxCalendarDaysPerCase: 1 };
  const exhausted = createAumAllowanceSnapshot({
    policy, employeeEnabled: true, trustLevel: "A", usedCases: 2,
    startDate: "2026-07-17", endDate: "2026-07-17",
  });
  assert.equal(exhausted.reason, "quota_exhausted");
  assert.equal(exhausted.required, true);
  assert.equal(exhausted.consumesQuota, false);

  const withAum = createAumAllowanceSnapshot({
    policy, employeeEnabled: true, trustLevel: "A", usedCases: 2, hasAum: true,
    startDate: "2026-07-17", endDate: "2026-07-17",
  });
  assert.equal(withAum.reason, "aum_received");
  assert.equal(withAum.required, false);
  assert.equal(withAum.consumesQuota, false);
});

test("AUM Block 4: Überschreitung macht die AUM rückwirkend erforderlich und gibt das Kontingent frei", () => {
  const snapshot = createAumAllowanceSnapshot({
    policy: { enabled: true, maxCasesPerYear: 3, maxCalendarDaysPerCase: 1 },
    employeeEnabled: true, trustLevel: "A", usedCases: 1,
    startDate: "2026-07-17", endDate: "2026-07-17", evaluatedAt: "2026-07-17T08:00:00.000Z",
  });
  const extended = reconcileAumAllowanceSnapshot(snapshot, {
    startDate: "2026-07-17", endDate: "2026-07-18", evaluatedAt: "2026-07-18T08:00:00.000Z",
  });
  assert.equal(calendarDaysInclusive("2026-07-17", "2026-07-18"), 2);
  assert.equal(extended.required, true);
  assert.equal(extended.reason, "duration_exceeded");
  assert.equal(extended.consumesQuota, false);
  assert.equal(extended.remainingCasesAfter, 2);

  const unchanged = reconcileAumAllowanceSnapshot(extended, {
    startDate: "2026-07-17", endDate: "2026-07-18", evaluatedAt: "2026-07-19T08:00:00.000Z",
  });
  assert.equal(unchanged.evaluatedAt, "2026-07-18T08:00:00.000Z");
});

test("AUM Block 4: fachlich geprüfte AUM gibt einen verbrauchten Fall frei", () => {
  const snapshot = createAumAllowanceSnapshot({
    policy: { enabled: true, maxCasesPerYear: 3, maxCalendarDaysPerCase: 1 },
    employeeEnabled: true, trustLevel: "A", usedCases: 1,
    startDate: "2026-07-17", endDate: "2026-07-17",
  });
  const reviewed = reconcileAumAllowanceSnapshot(snapshot, {
    startDate: "2026-07-17", endDate: "2026-07-17", aumReviewed: true,
    evaluatedAt: "2026-07-18T08:00:00.000Z",
  });
  assert.equal(reviewed.required, false);
  assert.equal(reviewed.consumesQuota, false);
  assert.equal(reviewed.releaseReason, "aum_reviewed");
  assert.equal(reviewed.remainingCasesAfter, 2);
});

test("AUM Block 4: 32 Wochenstunden auf fünf Soll-Arbeitstage ergeben 6,4 Krankenstandsstunden", () => {
  let snapshot = createSicknessValuationSnapshot({
    contractedHours: 32, targetWorkdays: 5, capturedAt: "2026-07-17T08:00:00.000Z",
  });
  snapshot = extendSicknessValuationSnapshot(snapshot, {
    startDate: "2026-07-17", endDate: "2026-07-18", dayContext: () => ({}),
  });
  assert.equal(snapshot.minutesPerWorkday, 384);
  assert.equal(creditedMinutesForDate(snapshot, "2026-07-17"), 384);
  assert.equal(creditedMinutesForDate(snapshot, "2026-07-18"), 0);
  assert.equal(snapshot.totalMinutes, 384);
});

test("AUM Block 4: fixe Arbeitstage und vorhandener Dienstplan bestimmen vorgesehene Arbeitstage", () => {
  const fixed = createSicknessValuationSnapshot({
    contractedHours: 20, targetWorkdays: 2, fixedWorkdays: ["tuesday", "saturday"],
  });
  assert.deepEqual(valuationWorkday(fixed, "2026-07-18"), { credited: true, reason: "fixed_workday" });
  assert.deepEqual(valuationWorkday(fixed, "2026-07-17"), { credited: false, reason: "contract_free_day" });

  const planned = createSicknessValuationSnapshot({ contractedHours: 32, targetWorkdays: 5 });
  assert.deepEqual(valuationWorkday(planned, "2026-07-17", { weekHasPlan: true, plannedShift: true }), { credited: true, reason: "planned_shift" });
  assert.deepEqual(valuationWorkday(planned, "2026-07-16", { weekHasPlan: true, plannedShift: false }), { credited: false, reason: "planned_free_day" });
});

test("AUM Block 4: Feiertage und Sonntage bleiben mit null Minuten bewertet", () => {
  const snapshot = createSicknessValuationSnapshot({ contractedHours: 38.5, targetWorkdays: 5 });
  assert.deepEqual(valuationWorkday(snapshot, "2026-07-17", { holiday: true }), { credited: false, reason: "holiday" });
  assert.deepEqual(valuationWorkday(snapshot, "2026-07-19"), { credited: false, reason: "sunday" });
});

test("AUM Block 4: eine Vertragsänderung überschreibt bereits gespeicherte Tageswerte nicht", () => {
  let snapshot = createSicknessValuationSnapshot({ contractedHours: 32, targetWorkdays: 5 });
  snapshot = extendSicknessValuationSnapshot(snapshot, {
    startDate: "2026-07-17", endDate: "2026-07-17", dayContext: () => ({}),
  });
  const extended = extendSicknessValuationSnapshot({ ...snapshot, minutesPerWorkday: 480 }, {
    startDate: "2026-07-17", endDate: "2026-07-18", dayContext: () => ({}),
  });
  assert.equal(creditedMinutesForDate(extended, "2026-07-17"), 384);
});
