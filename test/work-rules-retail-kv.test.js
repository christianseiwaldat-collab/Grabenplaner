"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { addDays, daysBetween } = require("../lib/work-rules/calendar");
const { canonicalSha256 } = require("../lib/work-rules/receipt");
const { versionSnapshot } = require("../lib/work-rules/store");
const { BUILTIN_WORK_RULE_PROFILES } = require("../lib/work-rules/catalog");
const { RETAIL_KV_PROFILE, RETAIL_KV_RULES, RETAIL_KV_SOURCES, evaluateRetailKvPlanning } = require("../lib/work-rules/retail-kv");

const employee = { id: "synthetic-person", birthDate: "1990-01-01", birthDateConfirmed: true,
  apprenticeshipStatus: "not_apprentice", apprenticeshipConfirmed: true,
  apprenticeshipValidFrom: "2020-01-01", apprenticeshipSourceReference: "synthetic-register" };
const schoolEmployee = { ...employee, apprenticeshipStatus: "active", apprenticeshipValidFrom: "2025-01-01" };
const youngEmployee = { ...schoolEmployee, birthDate: "2010-01-01" };
const week = { start: "2026-11-02", end: "2026-11-08" };
const coverage = { start: "2026-10-26", end: "2026-11-15", complete: true };
const dates = (start, end) => Array.from({ length: daysBetween(start, end) + 1 }, (_, i) => addDays(start, i));
const fact = (date, overrides = {}) => ({ date, enabled: true, state: "confirmed", employeeGroup: "salaried",
  sourceVerified: true, contractWeeklyMinutes: 2310, normalWorkModel: "standard", agreementStatus: "none_confirmed",
  agreementApplicable: true, workplaceFacts: { kind: "retail_sales", confirmed: true, exceptionModel: "none_confirmed" },
  averagingPeriod: null, ...overrides });
const shift = (date, startTime, endTime, overrides = {}) => ({ id: `${date}-${startTime}`, employeeId: employee.id,
  date, startTime, endTime, breakMinutes: 0, breakSource: "planned_explicit", ...overrides });
const options = overrides => ({ employee, calendarScope: week, planningCoverage: coverage,
  applicability: dates(coverage.start, coverage.end).map(date => fact(date)), shifts: [], ...overrides });
const evaluate = overrides => evaluateRetailKvPlanning(options(overrides));
const findings = (result, suffix) => result.findings.filter(row => row.ruleId === `at.retail-kv.${suffix}`);
const finding = (result, suffix, date) => findings(result, suffix).find(row => !date || row.scope.date === date);
const changedFacts = overrides => dates(coverage.start, coverage.end).map(date => fact(date, overrides));
const normalWeek = extra => [shift("2026-11-02", "08:00", "16:00"), shift("2026-11-03", "08:00", "16:00"),
  shift("2026-11-04", "08:00", "16:00"), shift("2026-11-05", "08:00", "16:00"),
  shift("2026-11-06", "08:00", extra || "14:30")];

test("new source-bound KV profile is governed, unassignable and independent", () => {
  assert.equal(RETAIL_KV_PROFILE.assignable, false);
  assert.equal(RETAIL_KV_PROFILE.applicability.governedBindingRequired, true);
  assert.equal(RETAIL_KV_PROFILE.version, "2026.5");
  assert.equal(Object.keys(RETAIL_KV_RULES).length, 15);
  assert.equal(Object.values(RETAIL_KV_SOURCES)[0].sha256, "ea214b34db934d18a4c0b25c0ae6dd3b62dceb5255851e91ac25908cee876e90");
  assert.equal(canonicalSha256(versionSnapshot(RETAIL_KV_PROFILE, Object.values(RETAIL_KV_RULES), Object.values(RETAIL_KV_SOURCES))),
    "7114c6a831e1dd58d650324a3684d4ab7b8ca38659f893157bf8167e8fa21bab");
});

test("existing adult, youth, protection and draft snapshots retain original canonical content", () => {
  const originals = {
    "at-general-adult@2026.1": "2d0b128182fe737940f3d855ee2eee9b92f06a2be25df0c557d2080a885b121c",
    "at-retail-adult-monitor@2026.1": "26372bbd513f1eb81771441acd2f20a8aab3fa942c2b656ea6d38017d100db04",
    "at-retail-youth-monitor@2026.3": "e4eb8e762964924a70c32468a31988d64341de84ad760926700dcfccefc18251",
    "at-planning-protection-monitor@2026.4": "94d0f506ff4858459c3d6ef65e4b0e57083843a9eeb15581e554b06e7226204a",
    "at-retail-kv-2026-draft@2026.1-draft": "0bc5875a8d18cdb3ea6f04b54bbb59e24cc689dd33eb810e8308b77615cb7474",
  };
  for (const [id, expected] of Object.entries(originals)) {
    const bundle = Object.values(BUILTIN_WORK_RULE_PROFILES).find(item => `${item.profile.id}@${item.profile.version}` === id);
    assert.ok(bundle, id);
    assert.equal(canonicalSha256(versionSnapshot(bundle.profile, bundle.rules, bundle.sources)), expected, id);
  }
  const historical = require("../lib/work-rules/historical/at-retail-youth-monitor-2026.2.json");
  assert.equal(canonicalSha256(versionSnapshot(historical.profile, historical.rules, historical.sources)),
    "50019077b97f4050e65c24bbdd4481317aad09bfea3035b5a6fb5f60125fc4aa");
});

test("38.5-hour normal week passes classification; one minute more is advisory additional time", () => {
  assert.equal(finding(evaluate({ shifts: normalWeek() }), "normal.weekly").state, "pass");
  const excess = finding(evaluate({ shifts: normalWeek("14:31") }), "normal.weekly");
  assert.equal(excess.state, "fail");
  assert.equal(excess.evidence.actualMinutes, 2311);
  assert.equal(excess.evidence.normalTimeClassificationOnly, true);
  assert.equal(excess.baseEnforcement, "advisory");
  assert.equal(excess.effectiveEnforcement, "advisory");
});

test("all location services contribute to personal KV totals", () => {
  const result = evaluate({ shifts: [shift(week.start, "06:00", "12:00", { locationId: "A" }),
    shift(week.start, "13:00", "19:00", { locationId: "B" }), shift(week.start, "06:00", "23:00", { employeeId: "other" })] });
  assert.equal(finding(result, "normal.daily").evidence.actualMinutes, 720);
  assert.equal(finding(result, "normal.daily").state, "fail");
  assert.equal(finding(result, "normal.weekly").evidence.actualMinutes, 720);
});

test("contract hours classify additional work without inventing overtime prohibition", () => {
  const result = evaluate({ shifts: [shift(week.start, "08:00", "13:01")], applicability: changedFacts({ contractWeeklyMinutes: 300 }) });
  const row = finding(result, "contract.weekly");
  assert.equal(row.state, "fail");
  assert.equal(row.evidence.actualMinutes, 301);
  assert.equal(row.effectiveEnforcement, "advisory");
  assert.equal(row.evidence.normalTimeClassificationOnly, true);
});

test("documented redistribution supports nine hours but does not support nine hours and one minute", () => {
  const good = finding(evaluate({ shifts: [shift(week.start, "08:00", "17:00")] }), "normal.daily");
  assert.equal(good.state, "pass");
  assert.equal(good.evidence.redistributionProved, true);
  assert.equal(good.evidence.maximumMinutes, 540);
  assert.equal(finding(evaluate({ shifts: [shift(week.start, "08:00", "17:01")] }), "normal.daily").state, "fail");
});

test("missing weekly coverage never proves redistributed nine-hour normal time", () => {
  const result = evaluate({ shifts: [shift(week.start, "08:00", "17:00")], planningCoverage: { start: week.start, end: week.start, complete: true } });
  assert.equal(finding(result, "normal.daily").state, "unknown");
  assert.equal(finding(result, "normal.weekly").state, "unknown");
  assert.equal(finding(result, "normal.weekly").evidence.actualMinutes, null);
});

test("unknown remaining-week facts cannot replace nine-hour redistribution evidence", () => {
  const applicability = changedFacts({});
  applicability.find(row => row.date === "2026-11-04").state = "unknown";
  const result = evaluate({ shifts: [shift(week.start, "08:00", "17:00")], applicability });
  assert.equal(finding(result, "normal.daily").state, "unknown");
});

test("expired or future no-exception evidence does not establish the standard work-time model", () => {
  const result = evaluate({ shifts: [shift("2026-11-07", "12:00", "14:00"), shift("2026-11-14", "08:00", "09:00")],
    applicability: changedFacts({ agreementStatus: "none_confirmed", agreementApplicable: false }) });
  assert.equal(finding(result, "model").state, "unknown");
  assert.equal(finding(result, "normal.daily").state, "unknown");
  assert.equal(finding(result, "normal.weekly").state, "unknown");
  assert.equal(finding(result, "saturday-free").state, "unknown");
});

test("configured or oversized pauses do not turn service into known zero time", () => {
  for (const overrides of [{ breakMinutes: 600 }, { breakMinutes: 60, breakSource: "configured_assumption" }, { breakMinutes: null }]) {
    const result = evaluate({ shifts: [shift(week.start, "08:00", "17:00", overrides)] });
    assert.equal(finding(result, "normal.daily").state, "unknown");
    assert.equal(finding(result, "normal.weekly").evidence.actualMinutes, null);
  }
});

test("positive overnight pause needs positions to allocate duration across days", () => {
  const unknown = evaluate({ shifts: [shift("2026-11-01", "23:00", "07:00", { breakMinutes: 30 })] });
  assert.equal(finding(unknown, "normal.daily", week.start).state, "unknown");
  const known = evaluate({ shifts: [shift("2026-11-01", "23:00", "07:00", { breakMinutes: 30,
    breakIntervals: [{ startTime: "23:30", endTime: "00:00" }] })] });
  assert.equal(finding(known, "normal.daily", week.start).evidence.actualMinutes, 420);
  assert.equal(finding(known, "normal.weekly").evidence.actualMinutes, 420);
});

test("overnight Sunday carryover is credited to Monday without creating a rest between same-shift portions", () => {
  const result = evaluate({ shifts: [shift("2026-11-01", "23:00", "07:00")] });
  assert.equal(finding(result, "normal.daily", week.start).evidence.actualMinutes, 420);
  assert.equal(finding(result, "normal.weekly").evidence.actualMinutes, 420);
  assert.equal(findings(result, "daily-rest").length, 0);
});

test("cross-date 24-hour excess withdraws calendar-only normal-time passes without rolling legal fail", () => {
  const result = evaluate({ shifts: [shift(week.start, "16:00", "20:00"), shift("2026-11-03", "07:00", "13:00")] });
  for (const row of findings(result, "normal.daily")) {
    assert.equal(row.state, "unknown");
    assert.equal(row.evidence.workingDayBoundaryReview, true);
  }
  assert.equal(finding(result, "daily-rest").state, "pass");
});

test("cross-date nine-hour boundary does not create a speculative normal-time warning", () => {
  const result = evaluate({ shifts: [shift(week.start, "16:00", "20:00"), shift("2026-11-03", "07:00", "12:00")] });
  assert.ok(findings(result, "normal.daily").every(row => row.state === "pass"));
});

test("calendar-proved excess remains a failure even with ambiguous cross-date boundary", () => {
  const result = evaluate({ shifts: [shift(week.start, "07:00", "17:00"), shift("2026-11-03", "07:00", "13:00")] });
  assert.equal(finding(result, "normal.daily", week.start).state, "fail");
});

test("split shifts are not mistaken for separate daily-rest periods", () => {
  const result = evaluate({ shifts: [shift(week.start, "08:00", "12:00"), shift(week.start, "13:00", "17:00"), shift("2026-11-03", "08:00", "12:00")] });
  const rest = findings(result, "daily-rest");
  assert.equal(rest.length, 1);
  assert.equal(rest[0].evidence.actualMinutes, 900);
  assert.equal(rest[0].state, "pass");
});

test("shorter daily rest stays manual without evidenced complete compensation", () => {
  const row = finding(evaluate({ shifts: [shift(week.start, "14:00", "22:00"), shift("2026-11-03", "07:00", "12:00")] }), "daily-rest");
  assert.equal(row.state, "unknown");
  assert.equal(row.evidence.actualMinutes, 540);
  assert.equal(row.evidence.compensationReviewRequired, true);
});

test("ancient known plan history does not reject a current KV assessment or status-change receipt", () => {
  const result = evaluate({ planningCoverage: { start: "2024-01-01", end: coverage.end, complete: true },
    shifts: [shift("2024-01-01", "08:00", "12:00"), shift(week.start, "08:00", "12:00")] });
  assert.equal(finding(result, "daily-rest").state, "unknown");
  assert.equal(finding(result, "daily-rest").evidence.restWindowBounded, false);
});

test("Saturday ending at thirteen does not imply an afternoon; thirteen-oh-one requires entire following Saturday off", () => {
  assert.equal(findings(evaluate({ shifts: [shift("2026-11-07", "08:00", "13:00")] }), "saturday-free").length, 0);
  const result = evaluate({ shifts: [shift("2026-11-07", "08:00", "13:01"), shift("2026-11-14", "08:00", "09:00")] });
  const row = finding(result, "saturday-free");
  assert.equal(row.state, "fail");
  assert.equal(row.evidence.nextSaturdayShiftCount, 1);
  assert.deepEqual(row.scope.dates, ["2026-11-07", "2026-11-14"]);
});

test("mutating following Saturday also evaluates supplied preceding afternoon", () => {
  const result = evaluate({ calendarScope: { start: "2026-11-09", end: "2026-11-15" },
    shifts: [shift("2026-11-07", "12:00", "14:00"), shift("2026-11-14", "08:00", "09:00")] });
  const row = finding(result, "saturday-free", "2026-11-14");
  assert.equal(row.state, "fail");
  assert.equal(row.evidence.precedingSaturday, "2026-11-07");
});

test("missing preceding or following coverage and unsupported Saturday exceptions remain unknown", () => {
  const rows = [shift("2026-11-07", "12:00", "14:00"), shift("2026-11-14", "08:00", "09:00")];
  assert.equal(finding(evaluate({ shifts: rows, planningCoverage: { ...coverage, end: week.end } }), "saturday-free").state, "unknown");
  assert.equal(finding(evaluate({ shifts: rows, applicability: changedFacts({ workplaceFacts: { kind: "retail_sales", confirmed: true, exceptionModel: "unsupported" } }) }), "saturday-free").state, "unknown");
  assert.equal(finding(evaluate({ shifts: [shift("2026-11-07", "08:00", "09:00")], planningCoverage: { ...coverage, start: week.start } }), "saturday-free").state, "unknown");
});

test("Christmas Saturday exception is not misclassified as confirmed standard-model breach", () => {
  const range = { start: "2026-11-23", end: "2026-12-06" };
  const row = findings(evaluate({ calendarScope: { start: "2026-11-23", end: "2026-11-29" }, planningCoverage: { ...range, complete: true },
    applicability: dates(range.start, range.end).map(date => fact(date)),
    shifts: [shift("2026-11-28", "12:00", "14:00"), shift("2026-12-05", "08:00", "09:00")] }), "saturday-free").find(row => row.evidence.precedingSaturday === "2026-11-28");
  assert.equal(row.state, "unknown");
  assert.equal(row.evidence.christmasExceptionReview, true);
});

test("a school record on following Saturday cannot be described as completely free", () => {
  const result = evaluate({ employee: schoolEmployee, applicability: changedFacts({ employeeGroup: "apprentice" }),
    shifts: [shift("2026-11-07", "12:00", "14:00")], schoolAttendance: [{ employeeId: employee.id, date: "2026-11-14" }] });
  const row = finding(result, "saturday-free");
  assert.equal(row.state, "unknown");
  assert.equal(row.evidence.schoolReview, true);
});

test("18-plus confirmed apprentice stays apprentice without blanket youth profile", () => {
  const result = evaluate({ employee: schoolEmployee, applicability: changedFacts({ employeeGroup: "apprentice" }),
    shifts: [shift(week.start, "08:00", "12:00")] });
  assert.ok(findings(result, "applicability").every(row => row.state === "pass"));
  assert.equal(findings(result, "youth-free-time").length, 0);
});

test("conflicting or unconfirmed apprentice classification never silently passes applicability", () => {
  const conflict = evaluate({ employee: schoolEmployee });
  assert.ok(findings(conflict, "applicability").every(row => row.state === "unknown"));
  const unconfirmed = evaluate({ employee: { ...schoolEmployee, apprenticeshipConfirmed: false }, applicability: changedFacts({ employeeGroup: "apprentice" }) });
  assert.ok(findings(unconfirmed, "applicability").every(row => row.state === "unknown"));
});

test("school and business remain additive facts without fabricated duration or normal-time credit", () => {
  const result = evaluate({ employee: schoolEmployee, applicability: changedFacts({ employeeGroup: "apprentice" }),
    shifts: [shift(week.start, "13:00", "17:00")], schoolAttendance: [{ employeeId: employee.id, date: week.start }] });
  assert.equal(finding(result, "normal.daily").state, "unknown");
  assert.equal(finding(result, "normal.weekly").state, "unknown");
  assert.ok(findings(result, "school-combination").every(row => row.state === "unknown"));
});

test("under-eighteen KV weekly leisure preserves Sunday, another whole day and Saturday18-to-Monday07", () => {
  const result = evaluate({ employee: youngEmployee, applicability: changedFacts({ employeeGroup: "apprentice" }), shifts: normalWeek() });
  assert.equal(finding(result, "youth-free-time").state, "pass");
  const blocked = evaluate({ employee: youngEmployee, applicability: changedFacts({ employeeGroup: "apprentice" }),
    shifts: [...normalWeek(), shift("2026-11-07", "17:00", "19:00")] });
  assert.equal(finding(blocked, "youth-free-time").state, "fail");
  assert.equal(finding(blocked, "youth-free-time").effectiveEnforcement, "advisory");
});

test("unknown youth exception model cannot manufacture KV weekly-rest approval", () => {
  const result = evaluate({ employee: youngEmployee, applicability: changedFacts({ employeeGroup: "apprentice", workplaceFacts: { kind: "retail_sales", confirmed: true, exceptionModel: "unknown" } }), shifts: normalWeek() });
  assert.equal(finding(result, "youth-free-time").state, "unknown");
});

test("explicitly unconfirmed age cannot prove youth/adult daily-rest applicability", () => {
  const result = evaluate({ employee: { ...employee, birthDateConfirmed: false }, shifts: [shift(week.start, "08:00", "12:00"), shift("2026-11-03", "08:00", "12:00")] });
  assert.equal(finding(result, "daily-rest").state, "unknown");
});

test("Sunday, December8 and unknown closing-work exceptions are manual rather than automatic legal approval", () => {
  const sunday = evaluate({ shifts: [shift(week.end, "08:00", "10:00")] });
  assert.equal(finding(sunday, "rest-day").state, "unknown");
  const range = { start: "2026-12-21", end: "2026-12-27" };
  for (const workplaceFacts of [{ kind: "retail_sales", confirmed: true, exceptionModel: "none_confirmed" }, {}]) {
    const special = evaluate({ calendarScope: range, planningCoverage: { ...range, complete: true },
      applicability: dates(range.start, range.end).map(date => fact(date, { workplaceFacts })), shifts: [shift("2026-12-24", "12:00", "14:00")] });
    assert.equal(finding(special, "special-date").state, "unknown");
  }
  const decWeek = { start: "2026-12-07", end: "2026-12-13" };
  assert.equal(finding(evaluate({ calendarScope: decWeek, planningCoverage: { ...decWeek, complete: true },
    applicability: dates(decWeek.start, decWeek.end).map(date => fact(date)), shifts: [shift("2026-12-08", "10:00", "18:00")] }), "rest-day").state, "unknown");
});

test("2026 source expiry cannot be extended by a declared sourceVerified fact", () => {
  const scope = { start: "2027-01-04", end: "2027-01-10" };
  const result = evaluate({ calendarScope: scope, planningCoverage: { ...scope, complete: true }, applicability: dates(scope.start, scope.end).map(date => fact(date)) });
  assert.ok(result.findings.every(row => row.state === "unknown"));
  assert.equal(findings(result, "normal.weekly").length, 0);
});

test("explicit disable clears monitor assessment even outside source year", () => {
  const scope = { start: "2032-01-05", end: "2032-01-11" };
  const result = evaluate({ calendarScope: scope, applicability: dates(scope.start, scope.end).map(date => fact(date, { enabled: false, state: "unrecorded" })) });
  assert.deepEqual(result.findings, []);
});

test("missing trusted binding and duplicate day projections stay unknown", () => {
  const missing = evaluate({ applicability: changedFacts({ state: "unknown" }) });
  assert.ok(findings(missing, "applicability").every(row => row.state === "unknown"));
  const duplicate = evaluate({ applicability: [...changedFacts({}), fact(week.start)] });
  assert.equal(finding(duplicate, "applicability", week.start).state, "unknown");
});

test("invalid real calendar dates or anonymous service produce explicit data review", () => {
  assert.throws(() => evaluate({ calendarScope: { start: "2026-02-30", end: "2026-03-01" } }), TypeError);
  const result = evaluate({ shifts: [shift("2026-02-30", "08:00", "10:00"), shift(week.start, "08:00", "10:00", { employeeId: "" })] });
  assert.equal(findings(result, "input").length, 2);
  assert.ok(findings(result, "input").every(row => row.state === "unknown"));
  assert.equal(finding(result, "normal.weekly").state, "unknown");
});

test("a malformed following-Saturday service cannot prove an empty Saturday", () => {
  const result = evaluate({ shifts: [shift("2026-11-07", "12:00", "14:00"), shift("2026-11-14", "bad", "09:00")] });
  assert.equal(finding(result, "saturday-free").state, "unknown");
});

test("an unquantified weekday cannot prove redistribution from a short/free day", () => {
  const result = evaluate({ shifts: [shift(week.start, "08:00", "17:00")],
    additionalWorkEvents: [{ employeeId: employee.id, dateFrom: "2026-11-03", dateTo: "2026-11-03", type: "other" }] });
  assert.equal(finding(result, "normal.daily", week.start).state, "unknown");
  assert.equal(finding(result, "normal.daily", week.start).evidence.redistributionProved, false);
});

test("schedule publication does not invent agreement; dated timely agreement can be evaluated", () => {
  assert.equal(finding(evaluate({ shifts: normalWeek() }), "schedule-agreement").state, "unknown");
  const facts = { confirmed: true, weekStart: week.start, variable: true, agreedOn: "2026-10-19", changedAfterAgreement: false };
  assert.equal(finding(evaluate({ shifts: normalWeek(), scheduleAgreement: facts }), "schedule-agreement").state, "pass");
  assert.equal(finding(evaluate({ shifts: normalWeek(), scheduleAgreement: { ...facts, agreedOn: "2026-10-20" } }), "schedule-agreement").state, "unknown");
});

const averagingOptions = (overrides = {}) => {
  const period = { start: "2026-01-05", end: "2026-07-05", confirmed: true, carryMinutes: 0 };
  return options({ calendarScope: { start: "2026-06-29", end: "2026-07-05" },
    planningCoverage: { start: period.start, end: period.end, complete: true },
    applicability: dates(period.start, period.end).map(date => fact(date, { normalWorkModel: "durchrechnung26Weeks", agreementStatus: "documented", agreementApplicable: true, averagingPeriod: period })),
    ...overrides });
};

test("44-hour evidenced averaging week is classified separately from 38.5-hour standard week", () => {
  const input = averagingOptions({ shifts: [shift("2026-06-29", "08:00", "17:00"), shift("2026-06-30", "08:00", "17:00"),
    shift("2026-07-01", "08:00", "17:00"), shift("2026-07-02", "08:00", "17:00"), shift("2026-07-03", "08:00", "16:00")] });
  const result = evaluateRetailKvPlanning(input);
  assert.equal(finding(result, "normal.weekly").evidence.maximumMinutes, 2640);
  assert.equal(finding(result, "normal.weekly").state, "pass");
  input.shifts[input.shifts.length - 1].endTime = "16:01";
  assert.equal(finding(evaluateRetailKvPlanning(input), "normal.weekly").state, "fail");
});

test("13-week and 13-week-plus-one-day period boundaries do not infer a typed advance agreement", () => {
  const target = { start: "2026-03-30", end: "2026-04-05" };
  for (const end of ["2026-04-05", "2026-04-06", "2026-07-05"]) {
    const period = { start: "2026-01-05", end, confirmed: true, carryMinutes: 0 };
    const input = options({ calendarScope: target, planningCoverage: { start: period.start, end: period.end, complete: true },
      applicability: dates(period.start, period.end).map(date => fact(date, { normalWorkModel: "durchrechnung26Weeks",
        agreementStatus: "documented", agreementApplicable: true, averagingPeriod: period })),
      shifts: [shift(target.start, "08:00", "12:00")],
      scheduleAgreement: { confirmed: true, weekStart: target.start, variable: true,
        agreedOn: addDays(target.start, -91), changedAfterAgreement: false } });
    const row = finding(evaluateRetailKvPlanning(input), "schedule-agreement");
    assert.equal(row.state, "unknown", `${daysBetween(period.start, period.end) + 1} days`);
    assert.equal(row.evidence.agreementConfirmed, false);
  }
});

test("complete 26-week planned averaging is reproducible; incomplete window or absent carry is never zero", () => {
  const input = averagingOptions();
  const result = evaluateRetailKvPlanning(input);
  assert.equal(finding(result, "averaging").state, "pass");
  assert.equal(finding(result, "averaging").evidence.actualMinutesPerWeek, 0);
  const partial = evaluateRetailKvPlanning({ ...input, planningCoverage: { ...input.planningCoverage, start: "2026-01-06" } });
  assert.equal(finding(partial, "averaging").state, "unknown");
  const absent = evaluateRetailKvPlanning({ ...input, applicability: input.applicability.map(row => ({ ...row, averagingPeriod: { ...row.averagingPeriod, carryMinutes: null } })) });
  assert.equal(finding(absent, "averaging").state, "unknown");
});

test("full-period average boundary is evaluated with all branch services and explicit legal carry bounds", () => {
  const input = averagingOptions();
  input.shifts = input.applicability.filter(row => [1, 2, 3, 4, 5].includes(new Date(`${row.date}T12:00Z`).getUTCDay()))
    .map(row => shift(row.date, "08:00", new Date(`${row.date}T12:00Z`).getUTCDay() === 5 ? "14:30" : "16:00"));
  assert.equal(finding(evaluateRetailKvPlanning(input), "averaging").state, "pass");
  input.shifts.push(shift("2026-01-05", "17:00", "17:01", { locationId: "B" }));
  assert.equal(finding(evaluateRetailKvPlanning(input), "averaging").state, "fail");
  const hugeCarry = evaluateRetailKvPlanning({ ...input, applicability: input.applicability.map(row => ({ ...row, averagingPeriod: { ...row.averagingPeriod, carryMinutes: -50000 } })) });
  assert.equal(finding(hugeCarry, "averaging").state, "unknown");
});

test("changed carry or averaging period within the source window cannot prove a uniform period", () => {
  const input = averagingOptions();
  input.applicability[1].averagingPeriod = { ...input.applicability[1].averagingPeriod, carryMinutes: 1 };
  assert.equal(finding(evaluateRetailKvPlanning(input), "averaging").state, "unknown");
});

test("unquantified external work cannot certify a free following Saturday", () => {
  const result = evaluate({ shifts: [shift("2026-11-07", "12:00", "14:00")],
    additionalWorkEvents: [{ employeeId: employee.id, dateFrom: "2026-11-14", dateTo: "2026-11-14", type: "external_appointment", notes: "private-note" }] });
  const row = finding(result, "saturday-free");
  assert.equal(row.state, "unknown");
  assert.equal(row.evidence.additionalWorkReview, true);
  assert.equal(JSON.stringify(result).includes("private-note"), false);
});

test("unquantified branch, meeting, training and other work withdraw normal-time and rest passes", () => {
  for (const type of ["branch", "team_meeting", "training", "other"]) {
    const result = evaluate({ shifts: [shift(week.start, "08:00", "12:00"), shift("2026-11-04", "08:00", "12:00")],
      additionalWorkEvents: [{ employeeId: employee.id, dateFrom: "2026-11-03", dateTo: "2026-11-03", type }] });
    assert.equal(finding(result, "normal.daily", "2026-11-03").state, "unknown");
    assert.equal(finding(result, "normal.weekly").state, "unknown");
    assert.equal(finding(result, "contract.weekly").state, "unknown");
    assert.equal(finding(result, "daily-rest").state, "unknown");
  }
});

test("an unquantified event anywhere in the averaging period withdraws the planned average pass", () => {
  const input = averagingOptions({ additionalWorkEvents: [{ employeeId: employee.id, dateFrom: "2026-02-02", dateTo: "2026-02-02", type: "other" }] });
  assert.equal(finding(evaluateRetailKvPlanning(input), "averaging").state, "unknown");
});

test("findings use neutral public facts, source version and explicit monitor basis", () => {
  const input = options({ calendarScope: { ...week, privateMedicalSecret: "do-not-expose" },
    shifts: normalWeek(), applicability: changedFacts({ sourceReference: "opaque-private-ref", approvedAssignmentId: "private-assignment", pregnancy: "private-phase" }) });
  const result = evaluateRetailKvPlanning(input), json = JSON.stringify(result);
  for (const secret of ["do-not-expose", "opaque-private-ref", "private-assignment", "private-phase"]) assert.equal(json.includes(secret), false);
  assert.ok(result.findings.every(row => row.evidence.enforcementBasis === "controlled_retail_kv_monitor" && row.effectiveEnforcement === "advisory"));
  assert.ok(result.findings.filter(row => row.scope.type === "week").every(row => row.scope.weekStart && row.scope.weekEnd));
  assert.equal(result.fingerprint, evaluateRetailKvPlanning(input).fingerprint);
});
