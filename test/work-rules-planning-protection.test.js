"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BUILTIN_WORK_RULE_PROFILES, CATALOG_VERSION, canonicalSha256, evaluatePlannedSchedule,
  PLANNING_PROTECTION_PROFILE_ID, projectPlanningProtection, normalizePlanningProtection } = require("../lib/work-rules");
const { versionSnapshot } = require("../lib/work-rules/store");

const employee = { id: "synthetic-person" };
const period = (overrides = {}) => ({ id: "opaque-period-1", phase: "pregnancy", confirmed: true,
  validFrom: "2026-11-02", validTo: "2026-11-08", referenceId: "opaque-hr-1", normalDailyMinutes: 480, ...overrides });
const project = (periods = [period()], extra = {}, scope = { scopeFrom: "2026-11-02", scopeTo: "2026-11-08" }) =>
  projectPlanningProtection({ version: 1, planningEnabled: true, periods, ...extra }, scope);
const shift = (date, startTime, endTime, extra = {}) => ({ id: `synthetic-${date}-${startTime}`, employeeId: employee.id,
  date, startTime, endTime, breakMinutes: 0, breakIntervals: [], ...extra });
const evaluate = (overrides = {}) => evaluatePlannedSchedule({ profileId: PLANNING_PROTECTION_PROFILE_ID,
  employee, planningProtection: project(), rangeStart: "2026-11-02", rangeEnd: "2026-11-08", shifts: [], ...overrides });
const find = (result, suffix, predicate = () => true) => result.findings.find(finding => finding.ruleId === `at.protection.${suffix}` && predicate(finding));

test("Planungsauflagen: bisherige Profile behalten ihre vollständigen originalen Snapshots", () => {
  assert.equal(CATALOG_VERSION, "at-work-rules-2026.3");
  const expected = {
    "at-general-adult": "2d0b128182fe737940f3d855ee2eee9b92f06a2be25df0c557d2080a885b121c",
    "at-retail-adult-monitor": "26372bbd513f1eb81771441acd2f20a8aab3fa942c2b656ea6d38017d100db04",
    "at-retail-youth-monitor": "e4eb8e762964924a70c32468a31988d64341de84ad760926700dcfccefc18251",
    "at-retail-kv-2026-draft": "0bc5875a8d18cdb3ea6f04b54bbb59e24cc689dd33eb810e8308b77615cb7474",
  };
  for (const [id, hash] of Object.entries(expected)) {
    const bundle = BUILTIN_WORK_RULE_PROFILES[id];
    assert.equal(canonicalSha256(versionSnapshot(bundle.profile, bundle.rules, bundle.sources)), hash, id);
  }
  assert.equal(BUILTIN_WORK_RULE_PROFILES[PLANNING_PROTECTION_PROFILE_ID].version, "2026.4");
  assert.equal(BUILTIN_WORK_RULE_PROFILES[PLANNING_PROTECTION_PROFILE_ID].assignable, false);
});

test("Planungsauflagen: Projektion enthält weder privaten Status noch Quellenkennung oder medizinische Angaben", () => {
  const projection = project();
  const serialized = JSON.stringify(projection);
  for (const privateTerm of ["pregnancy", "phase", "opaque-period", "opaque-hr", "referenceId", "validFrom"]) assert.ok(!serialized.includes(privateTerm));
  assert.equal(projection.periods[0].maxDailyMinutes, 540);
  assert.equal(projection.periods[0].nightStart, "20:00");
  const result = evaluate({ shifts: [shift("2026-11-02", "08:00", "16:00")] });
  for (const finding of result.findings) assert.deepEqual(finding.sourceRefs, []);
  assert.ok(!/MSchG|Mutterschutz|pregnancy|postpartum|breastfeeding|opaque-hr|referenceId|ris\.mschg/i.test(JSON.stringify(result)));
});

test("Planungsauflagen: fehlende, unbestätigte und lückenhafte Zuordnung bleibt unknown", () => {
  for (const projection of [null, project([], {}), project([period({ confirmed: false })]),
    project([period({ phase: "unknown", confirmed: false })]), project([period({ validTo: "2026-11-07" })])]) {
    const result = evaluate({ planningProtection: projection });
    assert.equal(find(result, "applicability").state, "unknown");
    assert.equal(result.summary.requiresManualReview, true);
  }
  const bounded = project(); bounded.scopeTo = "2026-11-07";
  const boundedResult = evaluate({ planningProtection: bounded });
  assert.equal(find(boundedResult, "applicability").state, "unknown");
  assert.equal(find(boundedResult, "weekly-max").state, "unknown");
});

test("Planungsauflagen: ausgeschaltet und bestätigter nicht anwendbarer Zeitraum aktivieren keine Auflagen", () => {
  assert.deepEqual(evaluate({ planningProtection: project([], { planningEnabled: false }) }).findings, []);
  const result = evaluate({ planningProtection: project([period({ phase: "not_applicable" })]),
    shifts: [shift("2026-11-08", "20:00", "23:00")] });
  assert.equal(result.summary.state, "pass");
  assert.equal(result.findings.length, 1);
});

test("Planungsauflagen: Typen, echte ISO-Daten, Feldgrenzen und private Einschleusung werden validiert", () => {
  const base = project();
  for (const invalid of [{ ...base, enabled: "true" }, { ...base, phase: "pregnancy" }, { ...base, scopeFrom: false },
    { ...base, scopeTo: "2026-02-30" }, { ...base, periods: new Array(33).fill(base.periods[0]) }]) {
    assert.throws(() => normalizePlanningProtection(invalid), TypeError);
  }
  for (const changes of [{ dateFrom: "2026-02-30" }, { dateTo: false }, { maxDailyMinutes: "540" }, { maxDailyMinutes: 541 },
    { maxWeeklyMinutes: 2401 }, { normalDailyMinutes: 0 }, { confirmed: "yes" }, { phase: "pregnancy" },
    { sundayAllowed: true }, { nightStart: "22:00" }, { breastfeedingBreakReview: false }]) {
    assert.throws(() => normalizePlanningProtection({ ...base, periods: [{ ...base.periods[0], ...changes }] }), TypeError);
  }
});

test("Planungsauflagen: Tagesgrenze und Normalzeit werden getrennt und an der Grenze geprüft", () => {
  const nine = evaluate({ shifts: [shift("2026-11-02", "08:00", "17:00")] });
  assert.equal(find(nine, "daily-max").state, "pass");
  assert.equal(find(nine, "normal-daily").state, "fail");
  assert.equal(find(evaluate({ shifts: [shift("2026-11-02", "08:00", "17:01")] }), "daily-max").state, "fail");
  assert.equal(find(evaluate({ planningProtection: project([period({ normalDailyMinutes: null })]),
    shifts: [shift("2026-11-02", "08:00", "16:00")] }), "normal-daily").state, "unknown");
});

test("Planungsauflagen: kalenderübergreifender Tagesbezug bleibt fachlich offen statt falschem pass oder Rechts-fail", () => {
  const projection = project([period({ normalDailyMinutes: 540 })]);
  const result = evaluate({ planningProtection: projection,
    shifts: [shift("2026-11-02", "16:00", "20:00"), shift("2026-11-03", "07:00", "13:00")] });
  for (const suffix of ["daily-max", "normal-daily"]) {
    for (const item of result.findings.filter(row => row.ruleId === `at.protection.${suffix}`)) {
      assert.equal(item.state, "unknown");
      assert.equal(item.evidence.dayReferenceReviewRequired, true);
      assert.equal(item.evidence.crossDateWindowMinutes, 600);
      assert.equal(item.effectiveEnforcement, "advisory");
      assert.deepEqual(item.sourceRefs, []);
    }
  }
  assert.equal(find(result, "weekly-max").state, "pass");
  assert.ok(!result.findings.some(row => ["at.protection.daily-max", "at.protection.normal-daily"].includes(row.ruleId) && row.state === "fail"));
});

test("Planungsauflagen: Tagesbezugsprüfung respektiert Nettozeit, Grenze und sichere Kalenderfehler", () => {
  const projection = project([period({ normalDailyMinutes: 540 })]);
  for (const secondShift of [shift("2026-11-03", "07:00", "12:00"),
    shift("2026-11-03", "07:00", "13:00", { breakMinutes: 60, breakIntervals: [{ startTime: "10:00", endTime: "11:00" }] }),
    shift("2026-11-03", "07:00", "13:00", { breakMinutes: 60, breakIntervals: undefined }),
    shift("2026-11-03", "16:00", "22:00")]) {
    const result = evaluate({ planningProtection: projection, shifts: [shift("2026-11-02", "16:00", "20:00"), secondShift] });
    assert.ok(result.findings.filter(row => row.ruleId === "at.protection.daily-max").every(row => row.state === "pass"));
  }
  const normalOnly = evaluate({ shifts: [shift("2026-11-02", "16:00", "20:00"), shift("2026-11-03", "07:00", "11:01")] });
  assert.equal(find(normalOnly, "daily-max").state, "pass");
  assert.equal(find(normalOnly, "normal-daily").state, "unknown");
  const calendarFail = evaluate({ planningProtection: projection,
    shifts: [shift("2026-11-02", "08:00", "17:01"), shift("2026-11-03", "07:00", "13:00")] });
  assert.equal(find(calendarFail, "daily-max", item => item.scope.date === "2026-11-02").state, "fail");
  const unknownPause = evaluate({ planningProtection: projection,
    shifts: [shift("2026-11-02", "16:00", "20:00"), shift("2026-11-03", "07:00", "13:00", { breakMinutes: 60, breakSource: "configured_assumption" })] });
  assert.equal(find(unknownPause, "daily-max", item => item.scope.date === "2026-11-03").state, "unknown");
  assert.ok(!find(unknownPause, "daily-max", item => item.scope.date === "2026-11-03").evidence.dayReferenceReviewRequired);
});

test("Planungsauflagen: geteilte Dienste werden zusammengezählt, Überlappung und Pausenannahmen bleiben unbekannt", () => {
  const split = evaluate({ shifts: [shift("2026-11-02", "06:00", "11:00"), shift("2026-11-02", "12:00", "17:00")] });
  assert.equal(find(split, "daily-max").state, "fail");
  const overlap = evaluate({ shifts: [shift("2026-11-02", "06:00", "11:00"), shift("2026-11-02", "10:00", "15:00")] });
  assert.equal(find(overlap, "daily-max").state, "unknown");
  for (const extra of [{ breakMinutes: null }, { breakMinutes: 0, breakSource: "configured_assumption" },
    { breakMinutes: 60, breakSource: "configured_assumption", breakIntervals: undefined },
    { breakMinutes: 600, breakIntervals: undefined }]) {
    assert.equal(find(evaluate({ shifts: [shift("2026-11-02", "08:00", "17:00", extra)] }), "daily-max").state, "unknown");
  }
});

test("Planungsauflagen: vollständige 40-Stunden-Woche, Mehrminute und unvollständige Woche", () => {
  const shifts = [2, 3, 4, 5, 6].map(day => shift(`2026-11-0${day}`, "08:00", "16:00"));
  assert.equal(find(evaluate({ shifts }), "weekly-max").state, "pass");
  assert.equal(find(evaluate({ shifts: [...shifts.slice(0, 4), shift("2026-11-06", "08:00", "16:01")] }), "weekly-max").state, "fail");
  assert.equal(find(evaluate({ shifts, rangeEnd: "2026-11-06" }), "weekly-max").state, "unknown");
  assert.equal(find(evaluate({ shifts, planningProtection: project([period({ validFrom: "2026-11-03" })]) }), "weekly-max").state, "unknown");
});

test("Planungsauflagen: Fenster 06–20 Uhr ist inklusiv, Übertritt und Nachtdienst werden erkannt", () => {
  for (const [start, end, state] of [["06:00", "07:00", "pass"], ["19:00", "20:00", "pass"],
    ["05:59", "07:00", "fail"], ["19:00", "20:01", "fail"], ["23:00", "01:00", "fail"]]) {
    assert.equal(find(evaluate({ shifts: [shift("2026-11-02", start, end)] }), "time-window").state, state);
  }
});

test("Planungsauflagen: Sonntag, gesetzlicher Feiertag und Dienst über Mitternacht", () => {
  assert.equal(find(evaluate({ shifts: [shift("2026-11-08", "08:00", "09:00")] }), "rest-days").state, "fail");
  assert.equal(find(evaluate({ rangeStart: "2026-12-07", rangeEnd: "2026-12-13",
    planningProtection: project([period({ validFrom: "2026-12-07", validTo: "2026-12-13" })], {}, { scopeFrom: "2026-12-07", scopeTo: "2026-12-13" }),
    shifts: [shift("2026-12-08", "08:00", "09:00")] }), "rest-days").state, "fail");
  assert.equal(find(evaluate({ shifts: [shift("2026-11-07", "23:00", "01:00")] }), "rest-days").scope.date, "2026-11-08");
  assert.equal(find(evaluate({ shifts: [shift("2026-11-07", "23:00", "00:00")] }), "rest-days"), undefined);
});

test("Planungsauflagen: bestätigte endliche Sperre beachtet beide Grenztage, offene Sperre bleibt unknown", () => {
  const projection = project([period({ phase: "employment_prohibition", validFrom: "2026-11-03", validTo: "2026-11-05" }),
    period({ id: "opaque-2", phase: "not_applicable", validFrom: "2026-11-02", validTo: "2026-11-02" }),
    period({ id: "opaque-3", phase: "not_applicable", validFrom: "2026-11-06", validTo: "2026-11-08" })]);
  for (const date of ["2026-11-03", "2026-11-05"]) assert.equal(find(evaluate({ planningProtection: projection,
    shifts: [shift(date, "08:00", "09:00")] }), "no-employment").state, "fail");
  assert.equal(find(evaluate({ planningProtection: projection, shifts: [shift("2026-11-06", "08:00", "09:00")] }), "no-employment"), undefined);
  const open = evaluate({ planningProtection: project([period({ phase: "employment_prohibition", validTo: "" })]), shifts: [shift("2026-11-02", "08:00", "09:00")] });
  assert.equal(find(open, "applicability").state, "unknown");
  assert.equal(find(open, "no-employment"), undefined);
});

test("Planungsauflagen: Zeitraum nach Entbindung ist von Stillzeit und Schwangerschaft getrennt", () => {
  const result = evaluate({ planningProtection: project([period({ phase: "postpartum" })]), shifts: [shift("2026-11-08", "20:00", "22:00")] });
  assert.equal(find(result, "workplace-review").state, "unknown");
  for (const suffix of ["daily-max", "weekly-max", "normal-daily", "time-window", "rest-days", "break-review"]) assert.equal(find(result, suffix), undefined);
  const both = evaluate({ planningProtection: project([period(), period({ id: "opaque-2", phase: "breastfeeding" })]),
    shifts: [shift("2026-11-02", "08:00", "16:00")] });
  assert.equal(both.findings.filter(finding => finding.ruleId === "at.protection.daily-max").length, 1);
  assert.equal(find(both, "break-review").state, "unknown");
});

test("Planungsauflagen: Arbeitsplatz und gesonderte Freistellung werden niemals aus regulären Pausen freigegeben", () => {
  const result = evaluate({ planningProtection: project([period({ phase: "breastfeeding" })]),
    shifts: [shift("2026-11-02", "08:00", "16:00", { breakMinutes: 90, breakIntervals: [{ startTime: "12:00", endTime: "13:30" }] })] });
  assert.equal(find(result, "workplace-review").state, "unknown");
  assert.equal(find(result, "break-review").state, "unknown");
  assert.equal(result.summary.requiresManualReview, true);
});

test("Planungsauflagen: bekannte Schule wird nicht doppelt als Betrieb gezählt oder als vollständig grün bezeichnet", () => {
  const result = evaluate({ shifts: [shift("2026-11-03", "08:00", "16:00")], schoolAttendance: [{
    employeeId: employee.id, date: "2026-11-02", details: { confirmed: true, startTime: "08:00", endTime: "16:00" } }] });
  assert.equal(find(result, "weekly-max").evidence.actualMinutes, 480);
  assert.equal(find(result, "school-combination", finding => finding.scope.type === "week").state, "unknown");
  const sameDay = evaluate({ shifts: [shift("2026-11-02", "16:00", "18:00")], schoolAttendance: [{ employeeId: employee.id, date: "2026-11-02" }] });
  assert.equal(find(sameDay, "school-combination", finding => finding.scope.type === "day").state, "unknown");
});

test("Planungsauflagen: Wochenfindings besitzen den vollständigen Zeitraum für den öffentlichen Präsentationsfilter", () => {
  const result = evaluate({ shifts: [2, 3, 4, 5, 6, 7].map(day => shift(`2026-11-0${day}`, "08:00", "16:00")),
    schoolAttendance: [{ employeeId: employee.id, date: "2026-11-02" }] });
  assert.equal(find(result, "weekly-max").state, "fail");
  assert.equal(find(result, "weekly-max").evidence.actualMinutes, 2880);
  for (const suffix of ["weekly-max", "school-combination"]) {
    const finding = find(result, suffix, item => item.scope.type === "week");
    assert.deepEqual(finding.scope, { type: "week", weekStart: "2026-11-02", weekEnd: "2026-11-08" });
  }
  const incomplete = evaluate({ rangeEnd: "2026-11-06" });
  assert.equal(find(incomplete, "weekly-max").state, "unknown");
  assert.equal(find(incomplete, "weekly-max").scope.weekEnd, "2026-11-08");
});

test("Planungsauflagen: alle neuen Hinweise bleiben advisory, auch bei enforced und ohne Altersangabe", () => {
  const result = evaluate({ enforcementMode: "enforced", shifts: [shift("2026-11-08", "19:00", "21:00")] });
  assert.equal(result.enforcementMode, "monitor");
  assert.equal(find(result, "time-window").state, "fail");
  assert.ok(result.findings.every(finding => finding.effectiveEnforcement === "advisory"));
  assert.ok(result.findings.every(finding => finding.evidence.enforcementBasis === "controlled_protection_monitor"));
  assert.ok(!result.findings.some(finding => finding.ruleId.startsWith("at.applicability.")));
});

test("Planungsauflagen: unmöglicher Diensttag wird nicht still als echter Kalendertag bewertet", () => {
  const result = evaluate({ shifts: [shift("2026-02-30", "08:00", "16:00")] });
  assert.equal(result.findings.find(finding => finding.ruleId === "at.input.shift").state, "unknown");
  assert.ok(result.findings.every(finding => finding.evidence.enforcementBasis === "controlled_protection_monitor"));
});

test("Planungsauflagen: widersprüchliche bestätigte Nichtanwendbarkeit und aktive Auflagen bleiben unknown", () => {
  for (const phase of ["pregnancy", "breastfeeding", "postpartum", "employment_prohibition"]) {
    const projection = project([period({ phase }), period({ id: "opaque-2", phase: "not_applicable" })]);
    assert.ok(projection.periods.every(item => item.confirmed === false));
    const result = evaluate({ planningProtection: projection, shifts: [shift("2026-11-02", "08:00", "09:00")] });
    assert.equal(find(result, "applicability").state, "unknown");
    assert.equal(result.summary.state, "unknown");
  }
  const disjoint = project([period({ validTo: "2026-11-04" }), period({ id: "opaque-2", phase: "not_applicable", validFrom: "2026-11-05" })]);
  assert.ok(disjoint.periods.every(item => item.confirmed));
});

test("Planungsauflagen: Vorwochen-Carryover zählt am Montag, erzeugt aber keine Findings außerhalb der Prüfwoche", () => {
  const result = evaluate({ shifts: [shift("2026-11-01", "23:00", "07:00")] });
  assert.equal(find(result, "daily-max").evidence.actualMinutes, 420);
  assert.equal(find(result, "time-window").state, "fail");
  assert.ok(result.findings.every(finding => !finding.scope.date || finding.scope.date >= "2026-11-02"));
  assert.equal(find(result, "rest-days"), undefined);
});
