"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TIME_ZONE,
  aggregateStaffingRisk,
  calculateNotificationNotBefore,
  calculateSicknessEscalation,
  externalAlertNotBefore,
  sicknessDeadlineState,
  validateSicknessDeadlines,
} = require("../lib/sickness-workflow");

test("AUM-Fristen verlangen eine kleinere lokale als globale Frist", () => {
  assert.deepEqual(validateSicknessDeadlines({ localDays: "2", hrDays: 5 }), { localDays: 2, hrDays: 5 });
  assert.throws(
    () => validateSicknessDeadlines({ localDays: 5, hrDays: 5 }),
    { code: "SICKNESS_DEADLINE_ORDER_INVALID" },
  );
  assert.throws(
    () => validateSicknessDeadlines({ localDays: 6, hrDays: 5 }),
    { code: "SICKNESS_DEADLINE_ORDER_INVALID" },
  );
  assert.throws(
    () => validateSicknessDeadlines({ localDays: 1.5, hrDays: 5 }),
    { code: "SICKNESS_LOCAL_DEADLINE_INVALID" },
  );
});

test("Eskalationen wechseln nach abgelaufenen Wiener Kalendertagen von gelb auf rot", () => {
  const onTime = calculateSicknessEscalation({ startAt: "2026-07-10", asOf: "2026-07-12", localDays: 2, hrDays: 5 });
  assert.equal(onTime.timeZone, TIME_ZONE);
  assert.equal(onTime.calendarDaysElapsed, 2);
  assert.equal(onTime.severity, "none");
  assert.equal(onTime.localDeadlineDate, "2026-07-12");
  assert.equal(onTime.hrDeadlineDate, "2026-07-15");

  const yellow = calculateSicknessEscalation({ startAt: "2026-07-10", asOf: "2026-07-13", localDays: 2, hrDays: 5 });
  assert.equal(yellow.severity, "yellow");
  assert.equal(yellow.localOverdueDays, 1);
  assert.equal(yellow.hrOverdueDays, 0);

  const stillYellow = calculateSicknessEscalation({ startAt: "2026-07-10", asOf: "2026-07-15", localDays: 2, hrDays: 5 });
  assert.equal(stillYellow.severity, "yellow");

  const red = calculateSicknessEscalation({ startAt: "2026-07-10", asOf: "2026-07-16", localDays: 2, hrDays: 5 });
  assert.equal(red.severity, "red");
  assert.equal(red.hrOverdueDays, 1);
});

test("Kalendertage bleiben über die Wiener Sommerzeitumstellung stabil", () => {
  const result = sicknessDeadlineState({
    startAt: "2026-03-28T23:30:00Z",
    asOf: "2026-03-29T22:30:00Z",
    localDays: 0,
    hrDays: 2,
  });
  assert.equal(result.startDate, "2026-03-29");
  assert.equal(result.asOfDate, "2026-03-30");
  assert.equal(result.calendarDaysElapsed, 1);
  assert.equal(result.severity, "yellow");
});

test("Meldungen vor der Versandzeit warten bis zur Wiener Uhrzeit, spätere gehen sofort", () => {
  const delayed = calculateNotificationNotBefore({ reportAt: "2026-07-14T04:30:00Z", sendAfter: "08:00" });
  assert.deepEqual(delayed, {
    timeZone: TIME_ZONE,
    reportLocalDate: "2026-07-14",
    configuredTime: "08:00",
    delayed: true,
    notBefore: "2026-07-14T06:00:00.000Z",
  });

  const immediate = calculateNotificationNotBefore({ reportAt: "2026-07-14T06:00:30Z", sendAfter: "08:00" });
  assert.equal(immediate.delayed, false);
  assert.equal(immediate.notBefore, "2026-07-14T06:00:30.000Z");

  const sqliteUtc = calculateNotificationNotBefore({ reportAt: "2026-07-14 05:30:00", sendAfter: "08:00" });
  assert.equal(sqliteUtc.notBefore, "2026-07-14T06:00:00.000Z");
});

test("Nicht vorhandene und doppelte Wiener DST-Uhrzeiten werden eindeutig aufgelöst", () => {
  const springGap = externalAlertNotBefore({ reportAt: "2026-03-29T00:15:00Z", sendAfter: "02:30" });
  assert.equal(springGap.notBefore, "2026-03-29T01:00:00.000Z");

  const autumnOverlap = calculateNotificationNotBefore({ reportAt: "2026-10-24T23:30:00Z", sendAfter: "02:30" });
  assert.equal(autumnOverlap.notBefore, "2026-10-25T00:30:00.000Z");

  assert.throws(
    () => calculateNotificationNotBefore({ reportAt: "2026-07-14T05:30:00", sendAfter: "08:00" }),
    { code: "SICKNESS_TIMESTAMP_INVALID" },
  );
});

test("Besetzungsrisiko berücksichtigt zeitabhängige Mindestwerte und fasst Fenster zusammen", () => {
  const result = aggregateStaffingRisk({
    slots: [
      { start: "09:00", end: "11:00", staffed: 2 },
      { start: "11:00", end: "14:00", staffed: 2 },
      { start: "14:00", end: "18:00", staffed: 2 },
    ],
    minimums: [
      { start: "09:00", end: "18:00", required: 2 },
      { start: "11:00", end: "14:00", required: 3 },
    ],
  });
  assert.equal(result.belowMinimum, true);
  assert.equal(result.peakShortfall, 1);
  assert.equal(result.affectedMinutes, 180);
  assert.equal(result.staffMinutesShortfall, 180);
  assert.deepEqual(result.riskWindows, [
    { start: "11:00", end: "14:00", staffed: 2, required: 3, shortfall: 1, minutes: 180 },
  ]);
});

test("Besetzungsrisiko teilt Slots an Mindestgrenzen und erkennt echte Lücken", () => {
  const split = aggregateStaffingRisk({
    slots: [{ start: "10:00", end: "12:00", staffed: 2 }],
    minimums: [
      { start: "10:00", end: "12:00", minimum: 2 },
      { start: "11:00", end: "12:00", minimum: 3 },
    ],
  });
  assert.deepEqual(split.riskWindows, [
    { start: "11:00", end: "12:00", staffed: 2, required: 3, shortfall: 1, minutes: 60 },
  ]);

  const gap = aggregateStaffingRisk({
    slots: [
      { start: "09:00", end: "10:00", staffed: 2 },
      { start: "11:00", end: "12:00", staffed: 2 },
    ],
    minimums: [{ start: "09:00", end: "12:00", required: 2 }],
  });
  assert.deepEqual(gap.riskWindows, [
    { start: "10:00", end: "11:00", staffed: 0, required: 2, shortfall: 2, minutes: 60 },
  ]);
});

test("Workflow-Ergebnisse enthalten keine Namen oder Gesundheitsdetails", () => {
  const result = aggregateStaffingRisk({
    slots: [{ start: "09:00", end: "10:00", staffed: 1, employeeNumbers: ["007"], diagnosis: "nicht übernehmen" }],
    minimums: [{ start: "09:00", end: "10:00", required: 2, note: "vertraulich" }],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("007"), false);
  assert.equal(serialized.includes("nicht übernehmen"), false);
  assert.equal(serialized.includes("vertraulich"), false);

  const notification = calculateNotificationNotBefore({
    reportAt: "2026-07-14T04:30:00Z",
    sendAfter: "08:00",
    employeeName: "Nicht übernehmen",
    healthDetails: "Nicht übernehmen",
  });
  assert.equal(JSON.stringify(notification).includes("Nicht übernehmen"), false);
});
