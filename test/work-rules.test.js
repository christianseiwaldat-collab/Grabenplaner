"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BUILTIN_WORK_RULE_PROFILES,
  CATALOG_VERSION,
  WORK_RULE_ENGINE_VERSION,
  canonicalSha256,
  evaluatePlannedSchedule,
  getRuleCatalog,
} = require("../lib/work-rules");

function shift(id, date, startTime, endTime, breakMinutes = 0) {
  return { id, employeeId: "252", date, startTime, endTime, breakMinutes };
}

function evaluate(overrides = {}) {
  return evaluatePlannedSchedule({
    profileId: "at-retail-adult-monitor",
    employee: { id: "252", isAdult: true },
    applicabilityConfirmed: true,
    rangeStart: "2026-07-13",
    rangeEnd: "2026-07-19",
    shifts: [shift("default", "2026-07-13", "09:00", "17:00", 30)],
    ...overrides,
  });
}

function findings(result, ruleId) {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

function finding(result, ruleId, predicate = () => true) {
  return findings(result, ruleId).find(predicate);
}

test("Arbeitszeitregeln: Katalog ist versioniert, quellenbelegt und trennt aktive Profile vom KV-Entwurf", () => {
  const catalog = getRuleCatalog();
  assert.equal(catalog.version, CATALOG_VERSION);
  assert.equal(catalog.timeBasis, "planned_schedule");
  assert.equal(catalog.timeZone, "Europe/Vienna");
  assert.match(catalog.legalNotice, /keine Rechtsberatung/i);
  assert.equal(BUILTIN_WORK_RULE_PROFILES["at-general-adult"].status, "active");
  assert.equal(BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"].defaultEnforcementMode, "monitor");
  assert.equal(BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"].profile.version, "2026.1");
  assert.ok(BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"].rules.some(({ id }) => id === "at.azg.maximum.daily"));
  assert.ok(BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"].sources.some(({ id }) => id === "ris.azg.9"));
  assert.equal(BUILTIN_WORK_RULE_PROFILES["at-retail-kv-2026-draft"].status, "draft");
  assert.equal(BUILTIN_WORK_RULE_PROFILES["at-retail-kv-2026-draft"].assignable, false);
  assert.equal(catalog.sources["ris.azg.11"].jurisdiction, "AT");
  assert.match(catalog.sources["ris.azg.11"].url, /ris\.bka\.gv\.at/i);
  assert.ok(catalog.profiles["at-retail-adult-monitor"].ruleIds.includes("at.trade.saturday-after-18"));
});

test("Arbeitszeitregeln: Fingerprints und gesamte Bewertung sind deterministisch", () => {
  assert.equal(
    canonicalSha256({ z: 1, a: { y: 2, x: 3 } }),
    canonicalSha256({ a: { x: 3, y: 2 }, z: 1 }),
  );
  const first = evaluate();
  const second = evaluate();
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.engineVersion, WORK_RULE_ENGINE_VERSION);
  assert.equal(first.basis, "planned_schedule");
  assert.ok(first.findings.every((entry) => /^[a-f0-9]{64}$/.test(entry.fingerprint)));
});

test("Arbeitszeitregeln: Monitorbetrieb setzt jede wirksame Durchsetzung auf advisory", () => {
  const result = evaluate({
    shifts: [shift("too-long", "2026-07-13", "06:00", "19:00", 0)],
  });
  const maximum = finding(result, "at.azg.maximum.daily");
  assert.equal(maximum.state, "fail");
  assert.equal(maximum.baseEnforcement, "block");
  assert.equal(maximum.effectiveEnforcement, "advisory");
  assert.equal(result.enforcementMode, "monitor");
});

test("Arbeitszeitregeln: Pause wird erst bei mehr als sechs Stunden ausgelöst", () => {
  const exactlySix = evaluate({
    shifts: [shift("six", "2026-07-13", "09:00", "15:00", 0)],
  });
  assert.equal(finding(exactlySix, "at.azg.break.after-six").state, "pass");

  const tooLittle = evaluate({
    shifts: [shift("six-one", "2026-07-13", "09:00", "15:01", 29)],
  });
  assert.equal(finding(tooLittle, "at.azg.break.after-six").state, "fail");
  assert.equal(finding(tooLittle, "at.azg.break.after-six").evidence.requiredBreakMinutes, 30);

  const enough = evaluate({
    shifts: [shift("long", "2026-07-13", "09:00", "18:00", 30)],
  });
  assert.equal(finding(enough, "at.azg.break.after-six").state, "pass");

  const missing = evaluate({
    shifts: [{ id: "missing", date: "2026-07-13", startTime: "09:00", endTime: "18:00" }],
  });
  assert.equal(finding(missing, "at.azg.break.after-six").state, "unknown");
});

test("Arbeitszeitregeln: allgemeines Profil prüft 8/40, Handelsprofil 9/44", () => {
  const general = evaluate({
    profileId: "at-general-adult",
    enforcementMode: "enforced",
    shifts: [shift("general", "2026-07-13", "09:00", "17:01", 0)],
  });
  const generalDaily = finding(general, "at.azg.normal.daily");
  assert.equal(generalDaily.state, "fail");
  assert.equal(generalDaily.evidence.threshold, 480);

  const tradeNine = evaluate({
    shifts: [shift("trade", "2026-07-13", "09:00", "18:00", 0)],
  });
  assert.equal(finding(tradeNine, "at.azg.normal.daily").state, "pass");
  assert.equal(finding(tradeNine, "at.azg.normal.daily").evidence.threshold, 540);

  const tradeOver = evaluate({
    shifts: [shift("trade-over", "2026-07-13", "09:00", "18:01", 0)],
  });
  assert.equal(finding(tradeOver, "at.azg.normal.daily").state, "fail");

  const weekly = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"]
    .map((date, index) => shift(`w${index}`, date, "09:00", index === 4 ? "17:01" : "18:00", 0));
  const tradeWeek = evaluate({ shifts: weekly });
  assert.equal(finding(tradeWeek, "at.azg.normal.weekly").state, "fail");
  assert.equal(finding(tradeWeek, "at.azg.normal.weekly").evidence.threshold, 2640);
});

test("Arbeitszeitregeln: 10/50 sind Zustimmungshinweise, 12/60 absolute Grenzen", () => {
  const ten = evaluate({ shifts: [shift("ten", "2026-07-13", "08:00", "18:00", 0)] });
  assert.equal(finding(ten, "at.azg.consent.daily").state, "pass");
  const tenOne = evaluate({ shifts: [shift("ten-one", "2026-07-13", "08:00", "18:01", 0)] });
  assert.equal(finding(tenOne, "at.azg.consent.daily").state, "fail");
  assert.equal(finding(tenOne, "at.azg.consent.daily").baseEnforcement, "acknowledge");

  const twelve = evaluate({ shifts: [shift("twelve", "2026-07-13", "06:00", "18:00", 0)] });
  assert.equal(finding(twelve, "at.azg.maximum.daily").state, "pass");
  const twelveOne = evaluate({ shifts: [shift("twelve-one", "2026-07-13", "06:00", "18:01", 0)] });
  assert.equal(finding(twelveOne, "at.azg.maximum.daily").state, "fail");

  const fiftyOneHours = ["13", "14", "15", "16", "17", "18"].map((day, index) => (
    shift(`fifty-${index}`, `2026-07-${day}`, "08:00", index < 5 ? "16:30" : "16:31", 0)
  ));
  const weekly = evaluate({ shifts: fiftyOneHours });
  assert.equal(finding(weekly, "at.azg.consent.weekly").state, "fail");
  assert.equal(finding(weekly, "at.azg.maximum.weekly").state, "pass");

  const overSixty = ["13", "14", "15", "16", "17", "18"].map((day, index) => (
    shift(`sixty-${index}`, `2026-07-${day}`, "08:00", index === 5 ? "18:01" : "18:00", 0)
  ));
  assert.equal(finding(evaluate({ shifts: overSixty }), "at.azg.maximum.weekly").state, "fail");
});

test("Arbeitszeitregeln: 4- und 17-Wochen-Schnitte benötigen vollständige Abdeckung", () => {
  const short = evaluate();
  assert.equal(finding(short, "at.azg.trade.average.4weeks").state, "unknown");
  assert.equal(finding(short, "at.azg.average.17weeks").state, "unknown");

  const fourWeekShifts = [];
  for (let week = 0; week < 4; week += 1) {
    for (let day = 0; day < 5; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 5 + week * 7 + day)).toISOString().slice(0, 10);
      fourWeekShifts.push(shift(`4w-${week}-${day}`, date, "09:00", day === 4 ? "18:00" : "17:00", 0));
    }
  }
  const fourWeeks = evaluate({
    rangeStart: "2026-01-05",
    rangeEnd: "2026-02-01",
    shifts: fourWeekShifts,
  });
  assert.equal(finding(fourWeeks, "at.azg.trade.average.4weeks").state, "fail");

  const seventeenWeekShifts = [];
  for (let week = 0; week < 17; week += 1) {
    for (let day = 0; day < 6; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 5 + week * 7 + day)).toISOString().slice(0, 10);
      seventeenWeekShifts.push(shift(`17w-${week}-${day}`, date, "09:00", day < 5 ? "17:15" : "16:45", 0));
    }
  }
  const seventeenWeeks = evaluate({
    rangeStart: "2026-01-05",
    rangeEnd: "2026-05-03",
    shifts: seventeenWeekShifts,
  });
  assert.equal(finding(seventeenWeeks, "at.azg.average.17weeks").state, "fail");
  assert.equal(finding(seventeenWeeks, "at.azg.average.17weeks").evidence.threshold, 2880);
});

test("Arbeitszeitregeln: tägliche Ruhezeit berücksichtigt Europe/Vienna und DST", () => {
  const exact = evaluate({
    rangeStart: "2026-07-13",
    rangeEnd: "2026-07-14",
    shifts: [
      shift("first", "2026-07-13", "09:00", "20:00", 30),
      shift("second", "2026-07-14", "07:00", "15:00", 30),
    ],
  });
  assert.equal(finding(exact, "at.azg.daily-rest").state, "pass");
  assert.equal(finding(exact, "at.azg.daily-rest").evidence.actual, 660);

  const short = evaluate({
    rangeStart: "2026-07-13",
    rangeEnd: "2026-07-14",
    shifts: [
      shift("first", "2026-07-13", "09:00", "20:01", 30),
      shift("second", "2026-07-14", "07:00", "15:00", 30),
    ],
  });
  assert.equal(finding(short, "at.azg.daily-rest").state, "fail");

  const springDst = evaluate({
    rangeStart: "2026-03-28",
    rangeEnd: "2026-03-29",
    shifts: [
      shift("dst-first", "2026-03-28", "12:00", "20:00", 30),
      shift("dst-second", "2026-03-29", "07:00", "15:00", 30),
    ],
  });
  const dstRest = finding(springDst, "at.azg.daily-rest");
  assert.equal(dstRest.evidence.actual, 600);
  assert.equal(dstRest.state, "fail");
});

test("Arbeitszeitregeln: wöchentliche Ruhe wird nur bei vollständiger Kalenderwoche bewertet", () => {
  const incomplete = evaluate({
    rangeStart: "2026-07-13",
    rangeEnd: "2026-07-17",
  });
  assert.equal(finding(incomplete, "at.arg.weekly-rest").state, "unknown");

  const withoutRest = ["13", "14", "15", "16", "17", "18", "19"].map((day, index) => (
    shift(`daily-${index}`, `2026-07-${day}`, "08:00", "20:00", 30)
  ));
  const failed = evaluate({ shifts: withoutRest });
  assert.equal(finding(failed, "at.arg.weekly-rest").state, "fail");

  const regular = ["13", "14", "15", "16", "17"].map((day, index) => (
    shift(`regular-${index}`, `2026-07-${day}`, "09:00", "18:00", 30)
  ));
  const passed = evaluate({ shifts: regular });
  assert.equal(finding(passed, "at.arg.weekly-rest").state, "pass");
});

test("Arbeitszeitregeln: Sonntag, Feiertag und Handelssamstag nach 18 Uhr verlangen Ausnahmen", () => {
  const result = evaluate({
    rangeStart: "2026-12-07",
    rangeEnd: "2026-12-13",
    shifts: [
      shift("holiday", "2026-12-08", "10:00", "17:00", 30),
      shift("late-saturday", "2026-12-12", "10:00", "18:01", 30),
      shift("sunday", "2026-12-13", "10:00", "14:00", 0),
    ],
  });
  assert.equal(finding(result, "at.arg.holiday-work", ({ scope }) => scope.shiftId === "holiday").state, "fail");
  assert.equal(finding(result, "at.trade.saturday-after-18").state, "fail");
  assert.equal(finding(result, "at.arg.sunday-work").state, "fail");
  assert.ok(findings(result, "at.arg.holiday-work")[0].sourceRefs.some(({ id }) => id === "ris.arg.7"));
});

test("Arbeitszeitregeln: unbekanntes Alter oder unbestätigte Profilanwendbarkeit bleibt manual_review", () => {
  const missingAge = evaluate({
    employee: { id: "252" },
    applicabilityConfirmed: true,
  });
  assert.equal(finding(missingAge, "at.applicability.adult").state, "unknown");
  assert.ok(missingAge.findings.filter(({ ruleId }) => ruleId !== "at.applicability.adult").every(({ state }) => state === "unknown"));
  assert.ok(missingAge.findings.filter(({ ruleId }) => ruleId !== "at.applicability.adult").every(({ baseEnforcement }) => baseEnforcement === "manual_review"));

  const unconfirmed = evaluate({
    applicabilityConfirmed: false,
    enforcementMode: "enforced",
  });
  assert.equal(finding(unconfirmed, "at.applicability.adult").evidence.reason, "profile_not_confirmed");
  assert.equal(finding(unconfirmed, "at.azg.maximum.daily").state, "unknown");
});

test("Arbeitszeitregeln: Geburtsdatum bestätigt Volljährigkeit im Monitorbetrieb", () => {
  const result = evaluate({
    employee: { id: "252", birthDate: "1984-07-22" },
    applicabilityConfirmed: false,
    enforcementMode: "monitor",
    rangeStart: "2026-07-27",
    rangeEnd: "2026-08-02",
    shifts: [shift("adult", "2026-07-27", "09:00", "18:00", 30)],
  });
  const applicability = finding(result, "at.applicability.adult");
  assert.equal(applicability.state, "pass");
  assert.equal(applicability.evidence.reason, "birth_date");
  assert.equal(applicability.evidence.ageAtRangeStart, 42);
  assert.equal(applicability.evidence.profileConfirmed, false);
  assert.match(applicability.message, /Volljährigkeit ist bestätigt/i);
});

test("Arbeitszeitregeln: Minderjährige benötigen ein eigenes KJBG-Profil", () => {
  const result = evaluate({
    employee: { id: "430", birthDate: "2010-01-01" },
    applicabilityConfirmed: true,
  });
  const applicability = finding(result, "at.applicability.adult");
  assert.equal(applicability.state, "unknown");
  assert.equal(applicability.evidence.reason, "minor_requires_kjbg_profile");
  assert.match(applicability.message, /KJBG/i);
});

test("Arbeitszeitregeln: KV-Handel-Entwurf ist nicht zuweisbar", () => {
  const result = evaluatePlannedSchedule({
    profileId: "at-retail-kv-2026-draft",
    employee: { id: "252", isAdult: true },
    applicabilityConfirmed: true,
    shifts: [shift("draft", "2026-07-13", "09:00", "17:00", 30)],
  });
  assert.equal(result.summary.state, "unknown");
  assert.equal(result.findings[0].baseEnforcement, "manual_review");
  assert.match(result.findings[0].message, /Entwurf/i);
});

test("Arbeitszeitregeln: Istzeit kann nicht versehentlich mit dem Planprüfer bewertet werden", () => {
  assert.throws(
    () => evaluatePlannedSchedule({
      basis: "actual",
      profileId: "at-retail-adult-monitor",
      employee: { id: "252", isAdult: true },
      applicabilityConfirmed: true,
      shifts: [shift("actual", "2026-07-13", "09:00", "17:00", 30)],
    }),
    /ausschließlich geplante Dienste/i,
  );
});

test("Arbeitszeitregeln: ungültige Dienste erzeugen unknown statt eines Scheinergebnisses", () => {
  const result = evaluate({
    shifts: [{ id: "invalid", date: "2026-07-13", startTime: "99:00", endTime: "17:00", breakMinutes: 30 }],
  });
  const invalid = finding(result, "at.input.shift");
  assert.equal(invalid.state, "unknown");
  assert.equal(invalid.baseEnforcement, "manual_review");
});

test("Arbeitszeitregeln: historische Regel- und Quellensnapshots bestimmen die Bewertung", () => {
  const profile = JSON.parse(JSON.stringify(
    BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"].profile,
  ));
  profile.version = "historical-test";
  profile.catalogVersion = "historical-catalog";
  const ruleDefinitions = JSON.parse(JSON.stringify(
    BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"].rules,
  ));
  const maximumDaily = ruleDefinitions.find(({ id }) => id === "at.azg.maximum.daily");
  maximumDaily.severity = "info";
  maximumDaily.enforcement = "acknowledge";
  maximumDaily.sourceRefs = ["historical.azg.9"];
  const sourceCatalog = [{
    id: "historical.azg.9",
    title: "Historische Fassung des AZG",
    url: "https://example.invalid/historical-azg-9",
  }];

  const result = evaluatePlannedSchedule({
    profile,
    ruleDefinitions,
    sourceCatalog,
    enforcementMode: "enforced",
    employee: { id: "252", isAdult: true },
    applicabilityConfirmed: true,
    rangeStart: "2026-07-13",
    rangeEnd: "2026-07-19",
    shifts: [shift("historical", "2026-07-13", "06:00", "19:00", 30)],
  });
  const historical = finding(result, "at.azg.maximum.daily");

  assert.equal(result.catalogVersion, "historical-catalog");
  assert.equal(historical.state, "fail");
  assert.equal(historical.severity, "info");
  assert.equal(historical.baseEnforcement, "acknowledge");
  assert.equal(historical.effectiveEnforcement, "acknowledge");
  assert.deepEqual(historical.sourceRefs, [{
    id: "historical.azg.9",
    title: "Historische Fassung des AZG",
    url: "https://example.invalid/historical-azg-9",
  }]);
});
