"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BUILTIN_WORK_RULE_PROFILES, canonicalSha256, evaluatePlannedSchedule, getProfile } = require("../lib/work-rules");
const { apprenticeshipApplicabilityOnDate, normalizeSchoolAttendance, normalizeVocationalSchoolDetails } = require("../lib/work-rules/vocational-school");

const youth = {
  id: "synthetic-youth", birthDate: "2009-01-01", birthDateConfirmed: true,
  apprenticeshipStatus: "active", apprenticeshipConfirmed: true,
  apprenticeshipValidFrom: "2025-01-01", apprenticeshipValidTo: null,
  apprenticeshipSourceReference: "Synthetischer Lehrvertrag",
};
const adult = { ...youth, birthDate: "2000-01-01" };
const details = overrides => ({ version: 1, kind: "regular", startTime: "08:00", endTime: "12:00", lunchMinutes: 0,
  travelMinutes: 0, confirmed: true, sourceReference: "Synthetischer Stundenplan", specialCase: "none", ...overrides });
const school = (date, overrides = {}, extra = {}) => ({ id: `school-${date}`, employeeId: youth.id, date, allDay: false, details: details(overrides), ...extra });
const shift = (id, date, startTime, endTime, extra = {}) => ({ id, employeeId: youth.id, date, startTime, endTime, breakMinutes: 0, breakIntervals: [], ...extra });
const evaluate = overrides => evaluatePlannedSchedule({ profileId: "at-retail-youth-monitor", employee: youth,
  rangeStart: "2026-11-02", rangeEnd: "2026-11-15", shifts: [], schoolAttendance: [], ...overrides });
const find = (result, ruleId, predicate = () => true) => result.findings.find(finding => finding.ruleId === ruleId && predicate(finding));

test("Berufsschulvertrag: Legacy-Angaben bleiben null, fehlende Minuten bleiben unbekannt", () => {
  for (const input of [undefined, null, {}]) assert.equal(normalizeVocationalSchoolDetails(input), null);
  const draft = normalizeVocationalSchoolDetails({ version: 1, kind: "regular", confirmed: false });
  assert.equal(draft.lunchMinutes, null);
  assert.equal(draft.travelMinutes, null);
  assert.equal(draft.startTime, null);
  assert.equal(normalizeVocationalSchoolDetails(details()).travelMinutes, 0);
});

test("Berufsschulvertrag: falsche Typen, unbekannte Keys, ungültige Intervalle und unbelegte Bestätigung werden zurückgewiesen", () => {
  const invalid = [[], "school", { version: 2, kind: "regular" }, details({ surprise: true }), details({ kind: "holiday" }),
    details({ confirmed: "yes" }), details({ lunchMinutes: "0" }), details({ lunchMinutes: -1 }), details({ lunchMinutes: 1.5 }),
    details({ travelMinutes: false }), details({ travelMinutes: 1441 }), details({ startTime: "8:00" }), details({ startTime: "24:00" }),
    details({ endTime: "07:00" }), details({ lunchMinutes: 240 }), details({ sourceReference: "" }),
    details({ lunchMinutes: null }), details({ startTime: null }), details({ specialCase: "approved_exception" })];
  for (const input of invalid) assert.throws(() => normalizeVocationalSchoolDetails(input), TypeError);
});

test("Lehrlingsstatus: persönliche datierte Quelle ist maßgeblich, Position allein bestätigt keine Anwendbarkeit", () => {
  assert.equal(apprenticeshipApplicabilityOnDate(youth, "2026-11-03").state, "pass");
  assert.equal(apprenticeshipApplicabilityOnDate({ isApprentice: true, employmentClassification: "apprentice" }, "2026-11-03").state, "unknown");
  for (const status of ["completed", "not_apprentice"]) {
    assert.equal(apprenticeshipApplicabilityOnDate({ ...youth, apprenticeshipStatus: status, apprenticeshipValidTo: status === "completed" ? "2026-10-31" : null, isApprentice: true }, "2026-11-03").state, "not_applicable");
  }
  assert.equal(apprenticeshipApplicabilityOnDate({ ...youth, apprenticeshipConfirmed: false }, "2026-11-03").state, "unknown");
  assert.equal(apprenticeshipApplicabilityOnDate({ ...youth, apprenticeshipSourceReference: "" }, "2026-11-03").state, "unknown");
});

test("Lehrlingsstatus: abgeschlossene Lehre bleibt bis zum letzten Lehrtag einschließlich historisch aktiv", () => {
  const input = { ...youth, apprenticeshipStatus: "completed", apprenticeshipValidFrom: "2026-11-03", apprenticeshipValidTo: "2026-11-04" };
  assert.equal(apprenticeshipApplicabilityOnDate(input, "2026-11-02").state, "unknown");
  for (const date of ["2026-11-03", "2026-11-04"]) {
    const result = apprenticeshipApplicabilityOnDate(input, date);
    assert.equal(result.state, "pass");
    assert.equal(result.status, "active");
    assert.equal(result.recordedStatus, "completed");
  }
  assert.equal(apprenticeshipApplicabilityOnDate(input, "2026-11-05").state, "not_applicable");
  assert.equal(apprenticeshipApplicabilityOnDate({ ...input, apprenticeshipValidTo: null }, "2026-11-03").state, "unknown");
});

test("Lehrlingsstatus: abgeschlossener Status verdrängt Positionsindikation erst nach dem letzten Lehrtag", () => {
  const employee = { ...youth, apprenticeshipStatus: "completed", apprenticeshipValidTo: "2026-11-03", isApprentice: true };
  const activeDay = evaluate({ employee, schoolAttendance: [school("2026-11-03")] });
  assert.equal(find(activeDay, "at.kjbg.school.data").state, "pass");
  const completedDay = evaluate({ employee, schoolAttendance: [school("2026-11-04")] });
  assert.equal(find(completedDay, "at.kjbg.school.data").state, "unknown");
  assert.equal(find(completedDay, "at.kjbg.school.data").evidence.reason, "school_record_conflicts_with_personal_status");
});

test("Lehrlingsstatus: Gültigkeitsgrenzen und echte Kalenderdaten werden geprüft", () => {
  const input = { ...youth, apprenticeshipValidFrom: "2026-11-03", apprenticeshipValidTo: "2026-11-04" };
  assert.equal(apprenticeshipApplicabilityOnDate(input, "2026-11-02").state, "unknown");
  assert.equal(apprenticeshipApplicabilityOnDate(input, "2026-11-03").state, "pass");
  assert.equal(apprenticeshipApplicabilityOnDate(input, "2026-11-04").state, "pass");
  assert.equal(apprenticeshipApplicabilityOnDate(input, "2026-11-05").state, "unknown");
  assert.equal(apprenticeshipApplicabilityOnDate({ ...youth, apprenticeshipValidFrom: "2026-02-30" }, "2026-11-03").state, "unknown");
  const invalid = normalizeSchoolAttendance([school("2026-02-30")], youth.id, { start: "2026-02-23", end: "2026-03-01" });
  assert.equal(invalid[0].error, "invalid_school_dates");
});

test("Jugendprofil: ausdrücklich unbestätigtes Geburtsdatum ergibt keine Altersfreigabe", () => {
  const result = evaluate({ employee: { ...youth, birthDateConfirmed: false }, shifts: [shift("late", "2026-11-03", "18:00", "21:00")] });
  assert.equal(find(result, "at.applicability.youth").state, "unknown");
  const night = find(result, "at.kjbg.night-work");
  assert.equal(night.state, "unknown");
  assert.equal(night.evidence.conditionalResult, "fail");
});

test("Jugendprofil: unter 15 bleibt die besondere Beschäftigungsgrundlage ungeklärt", () => {
  const result = evaluate({ employee: { ...youth, birthDate: "2013-01-01" }, shifts: [shift("day", "2026-11-03", "09:00", "12:00")] });
  assert.equal(find(result, "at.applicability.youth").state, "unknown");
  assert.equal(find(result, "at.applicability.youth").evidence.reason, "under_fifteen_eligibility_requires_review");
});

test("Jugendprofil: Folgesamstag muss nach einem Dienst nach 13 Uhr auch vormittags frei sein", () => {
  const result = evaluate({ shifts: [shift("s1", "2026-11-07", "10:00", "14:00"), shift("s2", "2026-11-14", "09:00", "12:00")] });
  const finding = find(result, "at.kjbg.retail.consecutive-saturdays");
  assert.equal(finding.state, "fail");
  assert.equal(finding.scope.date, "2026-11-14");
  assert.equal(finding.effectiveEnforcement, "advisory");
});

test("Jugendprofil: Ende genau 13 Uhr löst keine Folge-Samstag-Sperre aus", () => {
  const result = evaluate({ shifts: [shift("s1", "2026-11-07", "10:00", "13:00"), shift("s2", "2026-11-14", "09:00", "12:00")] });
  assert.equal(find(result, "at.kjbg.retail.consecutive-saturdays"), undefined);
});

test("Jugendprofil: Vorweihnachtsausnahme folgt dem vorherigen Samstag; Feiertag bleibt eigener Befund", () => {
  const result = evaluate({ rangeStart: "2026-12-14", rangeEnd: "2026-12-27", shifts: [
    shift("last-advent", "2026-12-19", "10:00", "14:00"), shift("holiday", "2026-12-26", "09:00", "12:00"),
  ] });
  assert.equal(find(result, "at.kjbg.retail.consecutive-saturdays").state, "pass");
  assert.equal(find(result, "at.kjbg.sunday-holiday-work").state, "fail");
});

test("Jugendprofil: geteilter Arbeitstag nutzt die echte freie Unterbrechung und erzeugt keine tägliche Ruhezeit zwischen Segmenten", () => {
  const result = evaluate({ shifts: [shift("morning", "2026-11-03", "09:00", "12:00"), shift("afternoon", "2026-11-03", "13:00", "17:00")] });
  assert.equal(find(result, "at.kjbg.daily-rest"), undefined);
  assert.equal(find(result, "at.kjbg.break.after-four-half").state, "pass");
});

test("Jugendprofil: Tagesruhe beginnt nach dem letzten Tagessegment", () => {
  const result = evaluate({ shifts: [shift("morning", "2026-11-03", "09:00", "12:00"), shift("late", "2026-11-03", "13:00", "20:00"), shift("early", "2026-11-04", "07:00", "12:00")] });
  const rests = result.findings.filter(finding => finding.ruleId === "at.kjbg.daily-rest");
  assert.equal(rests.length, 1);
  assert.equal(rests[0].state, "fail");
  assert.equal(rests[0].evidence.actual, 660);
});

test("Jugendprofil: ein sehr weit geteilter Tag muss trotzdem die tägliche Ruhe innerhalb von 24 Stunden zulassen", () => {
  const result = evaluate({ shifts: [shift("early", "2026-11-03", "06:00", "09:00"), shift("late", "2026-11-03", "18:00", "20:00")] });
  const finding = find(result, "at.kjbg.daily-rest");
  assert.equal(finding.state, "fail");
  assert.equal(finding.evidence.metric, "youth_rest_within_twenty_four_hours");
  assert.equal(finding.evidence.actual, 600);
  assert.equal(finding.evidence.threshold, 720);
});

test("Jugendprofil: Pausensumme oder konfigurierte Annahme ohne Lage bleibt unknown", () => {
  const result = evaluate({ shifts: [shift("day", "2026-11-03", "09:00", "17:00", { breakMinutes: 30, breakIntervals: undefined, breakSource: "configured_assumption" })] });
  assert.equal(find(result, "at.kjbg.break.after-four-half").state, "unknown");
});

test("Jugendprofil: zwei Viertelstunden ersetzen keine ungeteilte halbe Stunde", () => {
  const result = evaluate({ shifts: [shift("day", "2026-11-03", "09:00", "17:00", { breakMinutes: 30,
    breakIntervals: [{ startTime: "11:00", endTime: "11:15" }, { startTime: "14:00", endTime: "14:15" }] })] });
  assert.equal(find(result, "at.kjbg.break.after-four-half").state, "fail");
});

for (const [name, startTime, endTime] of [["zu spät", "15:01", "15:31"], ["am Dienstbeginn", "09:00", "09:30"], ["am Dienstende", "16:30", "17:00"]]) {
  test(`Jugendprofil: Pause ${name} wird nicht freigegeben`, () => {
    const result = evaluate({ shifts: [shift("day", "2026-11-03", "09:00", "17:00", { breakMinutes: 30, breakIntervals: [{ startTime, endTime }] })] });
    assert.equal(find(result, "at.kjbg.break.after-four-half").state, "fail");
  });
}

test("Jugendprofil: belegte ungeteilte Pause genau nach sechs Stunden ist zulässig", () => {
  const result = evaluate({ shifts: [shift("day", "2026-11-03", "09:00", "17:00", { breakMinutes: 30, breakIntervals: [{ startTime: "15:00", endTime: "15:30" }] })] });
  assert.equal(find(result, "at.kjbg.break.after-four-half").state, "pass");
});

test("Jugendprofil: Widerspruch zwischen Pausensumme und Intervallen bleibt unbekannt", () => {
  const result = evaluate({ shifts: [shift("day", "2026-11-03", "09:00", "17:00", { breakMinutes: 30, breakIntervals: [{ startTime: "12:00", endTime: "12:15" }] })] });
  assert.equal(find(result, "at.kjbg.break.after-four-half").state, "unknown");
});

test("Berufsschule: genau acht Zeitstunden einschließlich Kurzpausen, ohne Mittag, verbieten jeden anschließenden Betriebsdienst", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", { startTime: "08:00", endTime: "17:00", lunchMinutes: 60 })],
    shifts: [shift("after", "2026-11-03", "17:30", "19:00")] });
  const finding = find(result, "at.kjbg.school.eight-hours");
  assert.equal(finding.evidence.instructionMinutes, 480);
  assert.equal(finding.state, "fail");
  assert.equal(finding.baseEnforcement, "block");
  assert.equal(finding.effectiveEnforcement, "advisory");
});

test("Berufsschule: 479 Zeitminuten werden nicht als acht Stunden ausgegeben", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", { startTime: "08:00", endTime: "16:59", lunchMinutes: 60 })] });
  assert.equal(find(result, "at.kjbg.school.eight-hours"), undefined);
});

test("Berufsschule: langer reiner Schultag ist keine tägliche Betriebsarbeitszeitüberschreitung", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", { startTime: "08:00", endTime: "18:00", lunchMinutes: 60 })] });
  assert.equal(find(result, "at.kjbg.normal.daily"), undefined);
  assert.equal(find(result, "at.kjbg.school.daily-combination"), undefined);
  assert.equal(find(result, "at.kjbg.school.eight-hours").state, "pass");
  assert.equal(find(result, "at.kjbg.school.weekly-credit").evidence.schoolMinutes, 540);
});

test("Berufsschule: Schule plus notwendiger Weg plus Betriebsdienst ist bei genau acht Stunden belegbar", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", { travelMinutes: 45 })], shifts: [shift("after", "2026-11-03", "12:45", "16:00")] });
  const finding = find(result, "at.kjbg.school.daily-combination");
  assert.equal(finding.evidence.actual, 480);
  assert.equal(finding.state, "pass");
});

test("Berufsschule: Schule und kurzer Betriebsdienst erhalten keine grüne kombinierte Pausenfreigabe", () => {
  const result = evaluate({ rangeEnd: "2026-11-08", schoolAttendance: [school("2026-11-03", { travelMinutes: 30 })],
    shifts: [shift("after", "2026-11-03", "12:30", "15:30")] });
  const finding = find(result, "at.kjbg.school.pause");
  assert.equal(find(result, "at.kjbg.school.daily-combination").state, "pass");
  assert.equal(find(result, "at.kjbg.break.after-four-half").state, "pass");
  assert.equal(finding.state, "unknown");
  assert.equal(finding.baseEnforcement, "manual_review");
  assert.equal(finding.effectiveEnforcement, "advisory");
  assert.equal(finding.evidence.combinedInstructionAndWork, 420);
  assert.equal(result.summary.state, "unknown");
  assert.equal(result.summary.requiresManualReview, true);
  assert.deepEqual(finding.sourceRefs.map(source => source.id), ["ris.kjbg.11", "ris.kjbg.15"]);
});

test("Berufsschule: kombinierter Pausenhinweis beginnt erst über viereinhalb Stunden", () => {
  const input = { schoolAttendance: [school("2026-11-03")] };
  assert.equal(find(evaluate({ ...input, shifts: [shift("after", "2026-11-03", "12:00", "12:30")] }), "at.kjbg.school.pause"), undefined);
  assert.equal(find(evaluate({ ...input, shifts: [shift("after", "2026-11-03", "12:00", "12:31")] }), "at.kjbg.school.pause").state, "unknown");
});

test("Berufsschule: Mittagspausenlänge und belegte Betriebspause beweisen keine Lage der Schulruhepause", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", { endTime: "12:30", lunchMinutes: 30 })],
    shifts: [shift("after", "2026-11-03", "12:30", "17:30", { breakMinutes: 30, breakIntervals: [{ startTime: "15:00", endTime: "15:30" }] })] });
  const finding = find(result, "at.kjbg.school.pause");
  assert.equal(finding.state, "unknown");
  assert.equal(finding.evidence.schoolLunchMinutes, 30);
  assert.equal(finding.evidence.schoolBreakPositionProven, false);
});

test("Berufsschule: früher Schulbeginn nach spätem Vortagesdienst bleibt in der kombinierten Ruheprüfung offen", () => {
  const result = evaluate({ rangeEnd: "2026-11-08", schoolAttendance: [school("2026-11-03", { startTime: "07:00", endTime: "11:00", travelMinutes: 60 })],
    shifts: [shift("late", "2026-11-02", "14:00", "20:00", { breakMinutes: 30, breakIntervals: [{ startTime: "17:00", endTime: "17:30" }] }),
      shift("after", "2026-11-03", "12:00", "15:00")] });
  const finding = find(result, "at.kjbg.school.rest");
  assert.equal(find(result, "at.kjbg.daily-rest").state, "pass");
  assert.equal(finding.state, "unknown");
  assert.equal(finding.baseEnforcement, "manual_review");
  assert.equal(finding.effectiveEnforcement, "advisory");
  assert.equal(finding.evidence.gapMinutes, 660);
  assert.equal(finding.evidence.requiredRestMinutes, 720);
  assert.equal(result.summary.state, "unknown");
  assert.deepEqual(finding.sourceRefs.map(source => source.id), ["ris.kjbg.11", "ris.kjbg.16"]);
});

test("Berufsschule: kurze Ruhechronologie wird auch in Richtung Schule zu Betriebsdienst erkannt", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-02", { startTime: "17:00", endTime: "19:00" })],
    shifts: [shift("early", "2026-11-03", "06:00", "09:00")] });
  const finding = find(result, "at.kjbg.school.rest");
  assert.equal(finding.state, "unknown");
  assert.equal(finding.evidence.businessBeforeSchool, false);
  assert.equal(finding.evidence.gapMinutes, 660);
});

test("Berufsschule: genau zwölf Stunden Abstand erzeugen keine zusätzliche unbewiesene Ruheentscheidung", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03")], shifts: [shift("previous", "2026-11-02", "16:00", "20:00")] });
  assert.equal(find(result, "at.kjbg.school.rest"), undefined);
});

test("Berufsschule: kurzer Unterricht und kurzer Spätdienst im selben langen Tag ergeben keine falsche Gesamtfreigabe", () => {
  const result = evaluate({ rangeEnd: "2026-11-08", schoolAttendance: [school("2026-11-03", { startTime: "07:00", endTime: "08:00" })],
    shifts: [shift("late", "2026-11-03", "19:00", "20:00")] });
  const finding = find(result, "at.kjbg.school.rest");
  assert.equal(find(result, "at.kjbg.school.pause"), undefined);
  assert.equal(finding.state, "unknown");
  assert.equal(finding.baseEnforcement, "manual_review");
  assert.equal(finding.effectiveEnforcement, "advisory");
  assert.equal(finding.evidence.combinedSpanMinutes, 780);
  assert.equal(finding.evidence.remainingRestMinutes, 660);
  assert.deepEqual(finding.sourceRefs.map(source => source.id), ["ris.kjbg.11", "ris.kjbg.16"]);
  assert.equal(result.summary.state, "unknown");
});

test("Berufsschule: kombinierter Tag mit genau zwölf Stunden Spannweite erhält keinen zusätzlichen Ruhehinweis", () => {
  const result = evaluate({ rangeEnd: "2026-11-08", schoolAttendance: [school("2026-11-03", { startTime: "07:00", endTime: "08:00" })],
    shifts: [shift("late", "2026-11-03", "18:00", "19:00")] });
  assert.equal(find(result, "at.kjbg.school.rest"), undefined);
  assert.equal(find(result, "at.kjbg.school.pause"), undefined);
  assert.equal(result.summary.state, "pass");
});

test("Berufsschule: unter 15 beginnt die kombinierte Tageshorizontprüfung erst über zehn Stunden", () => {
  const input = { employee: { ...youth, birthDate: "2013-01-01" },
    schoolAttendance: [school("2026-11-03", { startTime: "07:00", endTime: "08:00" })] };
  const boundary = evaluate({ ...input, shifts: [shift("late", "2026-11-03", "16:00", "17:00")] });
  assert.equal(find(boundary, "at.kjbg.school.rest"), undefined);
  const result = evaluate({ ...input, shifts: [shift("late", "2026-11-03", "16:01", "17:01")] });
  const finding = find(result, "at.kjbg.school.rest");
  assert.equal(finding.state, "unknown");
  assert.equal(finding.evidence.combinedSpanMinutes, 601);
  assert.equal(finding.evidence.maximumDaySpanMinutes, 600);
  assert.equal(finding.evidence.requiredRestMinutes, 840);
});

test("Berufsschule: unter 15 wird der Prüfhinweis mit vierzehn Stunden, ohne sichere Rechtsfreigabe, begründet", () => {
  const result = evaluate({ employee: { ...youth, birthDate: "2013-01-01" },
    schoolAttendance: [school("2026-11-02", { startTime: "17:00", endTime: "19:00" })],
    shifts: [shift("early", "2026-11-03", "08:59", "11:59")] });
  const finding = find(result, "at.kjbg.school.rest");
  assert.equal(finding.state, "unknown");
  assert.equal(finding.evidence.gapMinutes, 839);
  assert.equal(finding.evidence.requiredRestMinutes, 840);
  assert.equal(find(result, "at.applicability.youth").state, "unknown");
});

test("Berufsschule: unbestätigte Angaben erzeugen neben dem Datenhinweis keine zusätzlichen Pausen- und Ruhehinweise", () => {
  for (const confirmed of [false, true]) {
    const result = evaluate({ employee: { ...youth, birthDateConfirmed: confirmed },
      schoolAttendance: [school("2026-11-03", { startTime: "07:00", endTime: "11:00", confirmed: false })],
      shifts: [shift("previous", "2026-11-02", "17:00", "20:00"), shift("after", "2026-11-03", "12:00", "15:00")] });
    assert.equal(find(result, "at.kjbg.school.data").state, "unknown");
    assert.equal(find(result, "at.kjbg.school.pause"), undefined);
    assert.equal(find(result, "at.kjbg.school.rest"), undefined);
  }
});

test("Berufsschule: KJBG-Pausen- und Ruhehinweise werden volljährigen Lehrlingen nicht zugeordnet", () => {
  for (const birthDate of [adult.birthDate, "2008-11-03"]) {
    const result = evaluate({ profileId: "at-retail-adult-monitor", employee: { ...adult, birthDate },
      schoolAttendance: [school("2026-11-03", { startTime: "07:00", endTime: "11:00" })],
      shifts: [shift("previous", "2026-11-02", "17:00", "20:00"), shift("after", "2026-11-03", "12:00", "15:00")] });
    assert.equal(find(result, "at.kjbg.school.pause"), undefined);
    assert.equal(find(result, "at.kjbg.school.rest"), undefined);
  }
});

test("Berufsschule: neue Jugendhinweise erhalten aktuelle Quellen auch neben einem unveränderten Erwachsenen-Snapshot", () => {
  const bundle = BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"];
  const result = evaluate({ profile: bundle.profile, ruleDefinitions: bundle.rules, sourceCatalog: bundle.sources,
    enforcementMode: "enforced", applicabilityConfirmed: true,
    schoolAttendance: [school("2026-11-03", { startTime: "07:00", endTime: "11:00" })],
    shifts: [shift("previous", "2026-11-02", "17:00", "20:00"), shift("after", "2026-11-03", "12:00", "15:00")] });
  for (const [ruleId, sourceId] of [["at.kjbg.school.pause", "ris.kjbg.15"], ["at.kjbg.school.rest", "ris.kjbg.16"]]) {
    const finding = find(result, ruleId);
    assert.equal(finding.state, "unknown");
    assert.equal(finding.baseEnforcement, "manual_review");
    assert.equal(finding.effectiveEnforcement, "advisory");
    assert.equal(finding.evidence.schoolRuleVersion, "2026.3");
    assert.match(finding.sourceRefs.find(source => source.id === sourceId).url, /ris\.bka\.gv\.at/);
  }
  assert.equal(result.catalogVersion, "at-work-rules-2026.3");
});

test("Berufsschule: unbekannte Wegzeit wird bei Kombination nicht als null Minuten angenommen", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", { travelMinutes: null })], shifts: [shift("after", "2026-11-03", "13:00", "16:00")] });
  assert.equal(find(result, "at.kjbg.school.daily-combination").state, "unknown");
  assert.equal(find(result, "at.kjbg.school.daily-combination").evidence.actual, null);
  assert.equal(find(result, "at.kjbg.school.weekly-credit").state, "unknown");
});

test("Berufsschule: notwendige Wegzeit muss auch chronologisch zwischen Schule und Dienst passen", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", { travelMinutes: 45 })], shifts: [shift("after", "2026-11-03", "12:00", "14:00")] });
  const finding = find(result, "at.kjbg.school.daily-combination");
  assert.equal(finding.state, "fail");
  assert.equal(finding.evidence.inadequateTravelGap, true);
  assert.equal(finding.baseEnforcement, "block");
});

test("Berufsschule: Dienst während bestätigtem Unterricht bleibt konkreter Konflikt", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03")], shifts: [shift("overlap", "2026-11-03", "11:00", "13:00")] });
  assert.equal(find(result, "at.kjbg.school.daily-combination").state, "fail");
  assert.equal(find(result, "at.kjbg.school.daily-combination").evidence.overlapsInstruction, true);
});

test("Berufsschule: Wochenanrechnung umfasst Unterricht, Dienst und notwendige Wegzeit", () => {
  const result = evaluate({ rangeEnd: "2026-11-08", schoolAttendance: [school("2026-11-02", { travelMinutes: 60 })], shifts: [
    shift("after", "2026-11-02", "13:00", "16:15"),
    ...[3, 4, 5, 6].map(day => shift(`d-${day}`, `2026-11-0${day}`, "09:00", "17:30", { breakMinutes: 30, breakIntervals: [{ startTime: "12:00", endTime: "12:30" }] })),
  ] });
  const finding = find(result, "at.kjbg.school.weekly-credit");
  assert.equal(finding.evidence.schoolMinutes, 240);
  assert.equal(finding.evidence.necessaryTravelMinutes, 60);
  assert.equal(finding.evidence.workMinutes, 2115);
  assert.equal(finding.evidence.actual, 2415);
  assert.equal(finding.state, "fail");
});

for (const kind of ["block", "seasonal"]) {
  test(`Berufsschule: ${kind} sperrt Betriebsdienst an jedem Tag der BesuchRange einschließlich Samstag`, () => {
    const result = evaluate({ schoolAttendance: [school("2026-11-02", { kind }, { date: undefined, dateFrom: "2026-11-02", dateTo: "2026-11-08", allDay: true })],
      shifts: [shift("saturday", "2026-11-07", "09:00", "12:00")] });
    const finding = find(result, "at.kjbg.school.block-employment", entry => entry.scope.date === "2026-11-07");
    assert.equal(finding.state, "fail");
    assert.equal(finding.baseEnforcement, "block");
    assert.equal(finding.effectiveEnforcement, "advisory");
    assert.equal(find(result, "at.kjbg.school.weekly-credit").state, "unknown");
  });
}

test("Berufsschule: volljähriger Lehrling behält Erwachsenenprofil und erhält Schulschutz additiv im Monitor", () => {
  const result = evaluate({ profileId: "at-retail-adult-monitor", employee: adult, enforcementMode: "enforced", applicabilityConfirmed: true,
    schoolAttendance: [school("2026-11-03", { startTime: "08:00", endTime: "17:00", lunchMinutes: 60 })], shifts: [shift("after", "2026-11-03", "17:30", "19:00")] });
  assert.equal(result.profile.id, "at-retail-adult-monitor");
  assert.equal(find(result, "at.applicability.youth"), undefined);
  assert.equal(find(result, "at.kjbg.night-work"), undefined);
  assert.equal(find(result, "at.kjbg.school.eight-hours").state, "fail");
  assert.equal(find(result, "at.kjbg.school.eight-hours").effectiveEnforcement, "advisory");
});

test("Berufsschule: eingefrorener Erwachsenen-Snapshot erhält neue Schulregeln und Quellen additiv ohne alte Definitionen zu ändern", () => {
  const bundle = BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"];
  const result = evaluate({ profile: bundle.profile, employee: adult, enforcementMode: "enforced", applicabilityConfirmed: true,
    ruleDefinitions: bundle.rules, sourceCatalog: bundle.sources,
    schoolAttendance: [school("2026-11-03", { startTime: "08:00", endTime: "17:00", lunchMinutes: 60 })], shifts: [shift("after", "2026-11-03", "17:30", "19:00")] });
  const finding = find(result, "at.kjbg.school.eight-hours");
  assert.equal(finding.baseEnforcement, "block");
  assert.equal(finding.effectiveEnforcement, "advisory");
  assert.equal(finding.severity, "critical");
  assert.match(finding.sourceRefs.find(source => source.id === "ris.kjbg.11").url, /ris\.bka\.gv\.at/);
  assert.equal(finding.evidence.schoolRuleVersion, "2026.3");
  assert.equal(result.catalogVersion, "at-work-rules-2026.3");
});

for (const specialCase of ["cancelled_lessons", "elective", "school_event", "support_course"]) {
  test(`Berufsschule: Spezialfall ${specialCase} benötigt eigene fachliche Bewertung`, () => {
    for (const employee of [youth, adult]) {
      const result = evaluate({ employee, profileId: employee === adult ? "at-retail-adult-monitor" : "at-retail-youth-monitor", schoolAttendance: [school("2026-11-03", { specialCase })] });
      assert.equal(find(result, "at.kjbg.school.data").state, "unknown");
      assert.equal(find(result, "at.kjbg.school.weekly-credit").state, "unknown");
    }
  });
}

test("Berufsschule: historische Schuloption ohne Details erhält keine Sollstunden-Dauer", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", {}, { details: null, creditedMinutesPerDay: 600, allDay: true })] });
  assert.equal(find(result, "at.kjbg.school.data").state, "unknown");
  assert.equal(find(result, "at.kjbg.school.weekly-credit").evidence.schoolMinutes, null);
});

test("Berufsschule: Position allein und abgeschlossener persönlicher Lehrlingsstatus geben keinen Schulnachweis frei", () => {
  for (const employee of [{ id: youth.id, birthDate: youth.birthDate, isApprentice: true }, { ...youth, apprenticeshipStatus: "completed", isApprentice: true }]) {
    const result = evaluate({ employee, schoolAttendance: [school("2026-11-03")] });
    assert.equal(find(result, "at.kjbg.school.data").state, "unknown");
  }
});

test("Berufsschule: überlappende Schulrecords werden nicht doppelt oder stillschweigend angerechnet", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03"), school("2026-11-03", {}, { id: "duplicate" })] });
  assert.equal(find(result, "at.kjbg.school.data").state, "unknown");
  assert.equal(find(result, "at.kjbg.school.weekly-credit").evidence.schoolMinutes, null);
});

test("Berufsschule: Daten anderer Beschäftigter beeinflussen die Einzelprüfung nicht", () => {
  const result = evaluate({ schoolAttendance: [school("2026-11-03", {}, { employeeId: "another-person" })] });
  assert.equal(find(result, "at.kjbg.school.data"), undefined);
});

test("Berufsschule: Schulmontag nach Samstagsdienst erfordert freien Arbeitstag Dienstag bis Freitag", () => {
  const base = { schoolAttendance: [school("2026-11-09")], shifts: [shift("saturday", "2026-11-07", "09:00", "12:00"),
    ...[10, 11, 12, 13].map(day => shift(`day-${day}`, `2026-11-${day}`, "09:00", "12:00"))] };
  assert.equal(find(evaluate(base), "at.kjbg.retail.school-rest").state, "fail");
  const allowed = evaluate({ ...base, shifts: base.shifts.filter(shift => shift.id !== "day-11") });
  assert.equal(find(allowed, "at.kjbg.retail.school-rest").state, "pass");
  assert.equal(find(allowed, "at.kjbg.retail.school-rest").evidence.provenFreeDate, "2026-11-11");
});

test("Berufsschule: unbestätigter Schulmontag und fehlender Restplanungshorizont bleiben ungeklärt", () => {
  const shifts = [shift("saturday", "2026-11-07", "09:00", "12:00")];
  assert.equal(find(evaluate({ shifts, schoolAttendance: [school("2026-11-09", { confirmed: false })] }), "at.kjbg.retail.school-rest").state, "unknown");
  assert.equal(find(evaluate({ shifts, rangeEnd: "2026-11-09", schoolAttendance: [school("2026-11-09")] }), "at.kjbg.retail.school-rest").state, "unknown");
});

test("Berufsschule: nach voller Schulwoche wird Ersatzfreizeit vor oder nach dem Kursende geprüft", () => {
  const employment = [
    ...[2, 3, 4, 5, 6].map(day => shift(`prior-${day}`, `2026-11-0${day}`, "09:00", "12:00")),
    shift("saturday", "2026-11-07", "09:00", "12:00"),
    ...[16, 17, 18, 19, 20].map(day => shift(`later-${day}`, `2026-11-${day}`, "09:00", "12:00")),
  ];
  const base = { rangeEnd: "2026-11-22", shifts: employment, schoolAttendance: [school("2026-11-09", { kind: "block" },
    { date: undefined, dateFrom: "2026-11-09", dateTo: "2026-11-13", allDay: true })] };
  const missing = find(evaluate(base), "at.kjbg.retail.school-rest");
  assert.equal(missing.evidence.fullSchoolWeek, true);
  assert.equal(missing.state, "fail");
  const replacement = find(evaluate({ ...base, shifts: employment.filter(row => row.id !== "later-18") }), "at.kjbg.retail.school-rest");
  assert.equal(replacement.state, "pass");
  assert.equal(replacement.evidence.provenFreeDate, "2026-11-18");
});

test("Berufsschule: fehlende Zukunftswoche erlaubt bei voller Schulwoche keinen voreiligen Negativbefund", () => {
  const result = evaluate({ rangeEnd: "2026-11-15", schoolAttendance: [school("2026-11-09", { kind: "block" },
    { date: undefined, dateFrom: "2026-11-09", dateTo: "2026-11-20", allDay: true })],
  shifts: [shift("saturday", "2026-11-07", "09:00", "12:00")] });
  const finding = find(result, "at.kjbg.retail.school-rest");
  assert.equal(finding.evidence.fullSchoolWeek, true);
  assert.equal(finding.evidence.complete, false);
  assert.equal(finding.state, "unknown");
});

test("Berufsschule: unvollständige Kalenderwoche bleibt für die Wochenanrechnung offen", () => {
  const result = evaluate({ rangeStart: "2026-11-03", rangeEnd: "2026-11-03", schoolAttendance: [school("2026-11-03")] });
  assert.equal(find(result, "at.kjbg.school.weekly-credit").state, "unknown");
  assert.equal(find(result, "at.kjbg.school.weekly-credit").evidence.completeWeek, false);
});

test("Berufsschule: Schul- und Lehrvertragsprovenienz ist im Bewertungsfingerprint enthalten", () => {
  const baseline = { schoolAttendance: [school("2026-11-03")] };
  const first = evaluate(baseline);
  const changedSchool = evaluate({ schoolAttendance: [school("2026-11-03", { sourceReference: "Anderer bestätigter Stundenplan" })] });
  const changedApprenticeship = evaluate({ ...baseline, employee: { ...youth, apprenticeshipSourceReference: "Anderer bestätigter Lehrvertrag" } });
  assert.notEqual(first.fingerprint, changedSchool.fingerprint);
  assert.notEqual(first.fingerprint, changedApprenticeship.fingerprint);
  assert.equal(JSON.stringify(first.findings).includes(youth.apprenticeshipSourceReference), false);
  assert.match(find(first, "at.kjbg.school.data").evidence.apprenticeship.sourceReferenceSha256, /^[a-f0-9]{64}$/);
});

test("Versionierung: unveränderte Erwachsenen- und KV-Entwurfsbundles behalten ihren historischen Hash", () => {
  const historical = {
    "at-general-adult": "13309cb60be2158c49cc90d36fdd77ce7b94f2004b6a9f55eed10f75823a7f23",
    "at-retail-adult-monitor": "fb3fc435f2cef35053d4a3cbcf2fb79f04e63040770b06a46db613b15505c929",
    "at-retail-kv-2026-draft": "80b7c3bc58631a0cdf18b82cd74cb145f9b6e2d0190d2e90f97812ce8edb6fd1",
  };
  for (const [id, hash] of Object.entries(historical)) assert.equal(canonicalSha256(BUILTIN_WORK_RULE_PROFILES[id]), hash);
});

test("Versionierung: vorhandenes Jugendprofil 2026.2 wird durch neue Pausen-/Samstagssemantik nicht umgedeutet", () => {
  const legacy = getProfile("at-retail-youth-monitor");
  legacy.version = "2026.2";
  legacy.catalogVersion = "at-work-rules-2026.2";
  legacy.ruleIds = legacy.ruleIds.filter(id => !id.startsWith("at.kjbg.school.") && !["at.kjbg.apprenticeship", "at.kjbg.retail.school-rest"].includes(id));
  const result = evaluate({ profile: legacy, shifts: [shift("s1", "2026-11-07", "10:00", "14:00"), shift("s2", "2026-11-14", "09:00", "12:00")] });
  assert.equal(find(result, "at.kjbg.retail.consecutive-saturdays"), undefined);
});
