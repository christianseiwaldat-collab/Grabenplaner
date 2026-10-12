"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { assessPlanning, optimizationProblem } = require("../lib/planning-assistant");
const settings = require("../lib/planning-assistant-settings");
const voice = require("../lib/voice-assistant-settings");
const { createPlanningAssistantReader } = require("../lib/planning-assistant-gp");
function fixture() {
  return { period: { from: "2031-04-07", to: "2031-04-13" }, context: { locationId: "A", departmentId: null },
    employees: [{ id: "one", label: "BEISPIEL Eins", positionId: "sales", targetMinutes: 480, creditedMinutes: 480, hoursComplete: true },
      { id: "two", label: "BEISPIEL Zwei", positionId: "manager", targetMinutes: 480, creditedMinutes: 480, hoursComplete: true }],
    shifts: [{ id: "s1", employeeId: "one", date: "2031-04-07", startTime: "09:00", endTime: "17:00", locationId: "A", departmentId: null, visible: true, breaks: [], unlocatedBreakMinutes: 0 },
      { id: "s2", employeeId: "two", date: "2031-04-07", startTime: "09:00", endTime: "17:00", locationId: "A", departmentId: null, visible: true, breaks: [], unlocatedBreakMinutes: 0 }],
    unavailable: [], requirements: [{ date: "2031-04-07", startTime: "09:00", endTime: "17:00", kind: "staffing", label: "BEISPIEL Filiale", minimum: 2 }],
    configuration: structuredClone(settings.DEFAULTS), workRuleAssessment: { findings: [] }, supervision: { mode: "yellow", issues: [] }, gaps: [] };
}
const byRule = (result, id) => result.findings.filter(item => item.ruleId === `gp.planning.${id}`);
test("consistent input remains immutable and missing certificates are never reported as verified", () => {
  const facts = fixture(), before = structuredClone(facts), result = assessPlanning(facts);
  assert.deepEqual(facts, before); assert.equal(result.mode, "read_only"); assert.equal(result.outcome, "incomplete");
  assert.equal(byRule(result, "qualifications")[0].severity, "unknown"); assert.equal(byRule(result, "staffing").length, 0);
  assert.equal(result.inputRevision, assessPlanning(facts).inputRevision);
});
test("overlapping nested and duplicate shifts are detected, touching boundaries are allowed", () => {
  const f = fixture(); f.shifts.push({ ...f.shifts[0], id: "duplicate", startTime: "10:00", endTime: "11:00" });
  let r = assessPlanning(f); assert.equal(byRule(r, "overlap").length, 1); assert.equal(byRule(r, "staffing").length, 0);
  f.shifts[2].startTime = "17:00"; f.shifts[2].endTime = "18:00"; assert.equal(byRule(assessPlanning(f), "overlap").length, 0);
});
test("foreign assignments reduce availability without leaking foreign shift ids or locations", () => {
  const f = fixture(); f.shifts.push({ ...f.shifts[0], id: "PRIVATE-SHIFT", visible: false, locationId: "PRIVATE-BRANCH", startTime: "10:00", endTime: "11:00" });
  const r = assessPlanning(f), overlap = byRule(r, "overlap")[0]; assert.equal(overlap.otherAssignment, true); assert.deepEqual(overlap.shiftIds, ["s1"]);
  assert.equal(byRule(r, "staffing")[0].available, 1); assert(!JSON.stringify(r).includes("PRIVATE"));
});
test("ambiguous departments still count one person in the branch but cannot prove department coverage", () => {
  const f = fixture(); f.shifts[0].departmentId = 1;
  f.shifts.push({ ...f.shifts[0], id: "other-department", departmentId: 2, startTime: "10:00", endTime: "11:00" });
  f.requirements.push({ ...f.requirements[0], departmentId: 1, minimum: 1, label: "Abteilung 1" });
  const entries = byRule(assessPlanning(f), "staffing"); assert.equal(entries.length, 1); assert.equal(entries[0].requirement, "Abteilung 1");
});
for (const label of ["Urlaub", "ZA", "Nicht verfügbar", "Kein vereinbarter Arbeitstag", "Gesperrter Planungstag"]) test(`existing ${label} facts block only their actual time interval`, () => {
  const f = fixture(); f.unavailable.push({ employeeId: "one", date: "2031-04-07", startTime: "10:07", endTime: "10:11", label });
  const r = assessPlanning(f); assert.equal(byRule(r, "unavailable").length, 1);
  const entry = byRule(r, "staffing")[0]; assert.equal(entry.startTime, "10:07"); assert.equal(entry.endTime, "10:11"); assert.equal(entry.required, 2); assert.equal(entry.available, 1);
});
test("known breaks reduce staff; a floating break reports uncertainty instead of fabricated timing", () => {
  const f = fixture(); f.shifts[0].breaks = [{ startTime: "12:00", endTime: "12:30" }];
  assert.equal(byRule(assessPlanning(f), "staffing")[0].startTime, "12:00");
  f.shifts[0].breaks = []; f.shifts[0].unlocatedBreakMinutes = 30;
  const r = assessPlanning(f); assert.equal(byRule(r, "staffing").length, 0); assert.equal(byRule(r, "break_coverage")[0].severity, "unknown");
});
test("key-person alternatives and required positions count unique available employees", () => {
  const f = fixture(), common = f.requirements[0];
  f.requirements.push({ ...common, kind: "key_person", employeeIds: ["one", "two"], minimum: 1 }, { ...common, kind: "position", positionId: "manager", minimum: 1 });
  f.unavailable.push({ employeeId: "two", date: common.date, startTime: "12:00", endTime: "13:00", label: "ZA" });
  const r = assessPlanning(f); assert.equal(byRule(r, "position").length, 1); assert.equal(byRule(r, "key_person").length, 0);
  f.requirements[1].employeeIds = ["two"]; assert.equal(byRule(assessPlanning(f), "key_person").length, 1);
});
test("GP-valued hours and configured tolerance distinguish preference from legal overtime", () => {
  const f = fixture(); f.employees[0].creditedMinutes = 510; f.employees[1].creditedMinutes = 450;
  let entries = byRule(assessPlanning(f), "weekly_target"); assert.equal(entries.length, 2); assert(entries.every(item => item.constraint === "preference"));
  f.configuration.weeklyToleranceMinutes = 30; assert.equal(byRule(assessPlanning(f), "weekly_target").length, 0);
  f.employees[0].hoursComplete = false; assert.equal(byRule(assessPlanning(f), "weekly_target")[0].severity, "unknown");
});
test("existing legal profile results preserve provenance, monitor and enforced decisions", () => {
  const f = fixture(); f.workRuleAssessment.findings = [
    { ruleId: "rest", title: "Ruhezeit", message: "Ruhezeit unterschritten", state: "attention", resultState: "fail", employeeNumber: "one" },
    { ruleId: "daily", title: "Tagesgrenze", message: "Gesperrt", state: "blocked", effectiveEnforcement: "block", resultState: "fail", employeeNumber: "two" },
    { ruleId: "age", message: "Geltungsbereich ungeklärt", state: "manual_review", resultState: "unknown", employeeNumber: "one" },
    { ruleId: "irrelevant", message: "FOREIGN", state: "blocked", employeeNumber: "outside" },
  ];
  const entries = byRule(assessPlanning(f), "work_rules"); assert.equal(entries.length, 3);
  assert.equal(entries.find(item => item.sourceRuleId === "daily").constraint, "hard"); assert.equal(entries.find(item => item.sourceRuleId === "rest").constraint, "review");
  assert.equal(entries.find(item => item.sourceRuleId === "age").severity, "unknown"); assert(!JSON.stringify(entries).includes("FOREIGN"));
});
test("unparseable or overnight legacy rows cannot yield a verified weekly total", () => {
  const f = fixture(); f.shifts[0].startTime = "22:00"; f.shifts[0].endTime = "06:00";
  const r = assessPlanning(f); assert.equal(byRule(r, "input").length, 1); assert.equal(byRule(r, "weekly_target")[0].severity, "unknown");
});
test("read-only v1 fact export has integer minutes, hard constraints and no write capability or personnel labels", () => {
  const f = fixture(), problem = optimizationProblem(f);
  assert.equal(problem.status, "not_solved"); assert.equal(problem.applyAllowed, false); assert.equal(problem.shifts[0].startMinute, 540);
  assert.equal(problem.legalRules.revalidationRequired, true); assert.equal(problem.constraints[0].constraint, "hard"); assert(!JSON.stringify(problem).includes("BEISPIEL Eins"));
  f.shifts[0].endTime = "16:00"; assert.notEqual(problem.inputRevision, optimizationProblem(f).inputRevision);
});
test("planning settings reject unknown fields, invalid counts and duplicate identities", () => {
  assert.throws(() => settings.validateSettings({ ...settings.DEFAULTS, apiKey: "secret" }));
  assert.throws(() => settings.validateSettings({ ...settings.DEFAULTS, weeklyToleranceMinutes: -1 }));
  assert.throws(() => settings.validateSettings({ ...settings.DEFAULTS, requiredPositions: [{ positionId: "sales", count: 0 }] }));
  assert.throws(() => settings.validateSettings({ ...settings.DEFAULTS, keyPersonNumbers: ["one", "one"] }));
  assert.equal(settings.read({ [settings.key({ locationId: "A" })]: "BROKEN" }, { locationId: "A" }).valid, false);
  assert.notEqual(settings.key({ locationId: "A", departmentId: 1 }), settings.key({ locationId: "A", departmentId: 2 }));
});
test("voice configuration is secret-free, opt-in, fail-closed and respects server disable", () => {
  const env = { GRABENPLANER_OPENAI_API_KEY: "SECRET" };
  assert.equal(voice.runtimeConfig({}, env).enabled, false);
  const configuration = { enabled: true, maxSessionSeconds: 120, maxConversations: 2, portal: { enabled: true, adminOnly: true } };
  const stored = { [voice.SETTINGS_KEY]: JSON.stringify(configuration) };
  assert.equal(voice.runtimeConfig(stored, env).enabled, true);
  assert.equal(voice.runtimeConfig(stored, { ...env, GRABENPLANER_VOICE_ASSISTANT_ENABLED: "0" }).enabled, false);
  assert(!JSON.stringify(voice.settingsPayload(stored, env)).includes("SECRET"));
  assert.equal(voice.runtimeConfig({ [voice.SETTINGS_KEY]: "broken" }, { ...env, GRABENPLANER_VOICE_ASSISTANT_ENABLED: "1" }).enabled, false);
  assert.throws(() => voice.validateSettings({ ...configuration, apiKey: "secret" }));
  assert.throws(() => voice.validateSettings({ ...configuration, portal: { ...configuration.portal, adminOnly: "false" } }));
});
test("GP adapter reuses source credits, excludes pending wishes and redacts sickness case data", async () => {
  const schedule = { weekStart: "2031-04-07", weekEnd: "2031-04-13", context: { locationId: "A", locationName: "A", departmentId: null },
    settings: {}, employees: [{ personnel_number: "one", nickname: "BEISPIEL", position_id: "sales", contracted_hours: 8, home_location_id: "A" }],
    totals: { one: 480 }, globalBlockDates: [], workRuleAssessment: { findings: [] }, branchSupervisionAssessment: { mode: "off" },
    sicknessCredits: [{ employee_number: "one", date: "2031-04-08", caseId: "PRIVATE-CASE", minutes: 0 }] };
  const read = createPlanningAssistantReader({ getSchedule: async () => schedule, settings: () => ({}),
    loadShifts: async () => [{ id: 1, employee_number: "one", shift_date: "2031-04-08", start_time: "09:00", end_time: "12:00", location_id: "A" }],
    loadOptions: async () => [{ soft_pending: true, employee_number: "one", date_from: "2031-04-07", date_to: "2031-04-08", option_type: "vacation" }],
    loadPositions: async () => [], loadDepartments: async () => [], settingsForLocation: async () => ({}),
    plannedShiftBreaks: async () => ({ start: 540, end: 720, breakMinutes: 0, lunchBreakMinutes: 0 }),
    dayConfiguration: async () => ({ open: true, minFrom: "09:00", minTo: "12:00", minStaff: 1 }), optionIsAllDay: () => true,
    optionLabel: () => "Urlaub", employeeCanWorkOnDate: () => true });
  const result = await read("2031-04-07", {}, {});
  assert.equal(byRule(result.assessment, "unavailable").length, 1); assert.match(byRule(result.assessment, "unavailable")[0].message, /Nicht verfügbar/);
  assert.equal(byRule(result.assessment, "weekly_target").length, 0); assert(!JSON.stringify(result).includes("PRIVATE-CASE"));
  assert(byRule(result.assessment, "staffing").some(item => item.date === "2031-04-09"));
  schedule.publicHolidays = [{ date: "2031-04-09", name: "Synthetischer GP-Feiertag" }];
  const holidayReport = await read("2031-04-07", {}, {});
  assert(!byRule(holidayReport.assessment, "staffing").some(item => item.date === "2031-04-09"));
  assert(byRule(holidayReport.assessment, "staffing").some(item => item.date === "2031-04-10"));
});
