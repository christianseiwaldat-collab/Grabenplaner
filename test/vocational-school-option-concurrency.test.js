"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { canonicalSha256 } = require("../lib/work-rules/receipt");
const { addDays } = require("../lib/work-rules/calendar");
const source = fs.readFileSync(require.resolve("../server"), "utf8").replace(/\r\n/g, "\n");
function extract(name) {
  const from = source.search(new RegExp(`^async function ${name}\\(`, "m"));
  const to = source.indexOf("\n}\n", from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to + 3);
}
function fixture(changeDuringEvaluation = false) {
  const state = { basis: "original", captures: [], writes: 0, receipts: 0, rollbacks: 0, discovery: [] };
  const repositories = { planningSettings: { insertWeekOption: async () => { state.writes++; return { rows: [{ id: 1 }] }; } }, workRules: {} };
  const context = vm.createContext({
    addDays, getMonday: date => addDays(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7)),
    applicationRepositories: repositories,
    captureVocationalSchoolMutationGuard: async (_repos, targets) => {
      state.captures.push(JSON.parse(JSON.stringify(targets)));
      return canonicalSha256({ basis: state.basis, targets });
    },
    planningSettingsRepository: {
      getPlanningEmployee: async () => ({ home_location_id: "18", preferred_department_id: null }),
      listWorkRuleShiftsForRange: async input => { state.discovery.push(input); return []; },
    },
    absenceManagementRepository: { workRuleEvaluationEmployee: async () => ({ personnel_number: "synthetic" }) },
    resolvePlanningContext: async target => target,
    evaluateScheduleWorkRules: async () => {
      if (changeDuringEvaluation) state.basis = "new later-week shift or protected status";
      return { assessment: { outcome: "manual_review" }, profileVersionIds: ["synthetic-profile"] };
    },
    recordEvaluatedWorkRuleEvaluation: async () => { state.receipts++; return {}; },
    createApplicationRepositories: () => repositories,
    persistenceProvider: { transaction: async (callback, options) => {
      assert.equal(options.isolation, "serializable");
      try { return await callback({}); } catch (error) { state.rollbacks++; throw error; }
    } },
    httpError: (status, message, code) => Object.assign(new Error(message), { status, code }),
  });
  vm.runInContext(["prepareVocationalSchoolOptionEvaluations", "mutateVocationalSchoolOption"].map(extract).join("\n"), context);
  return { state, context };
}
const school = { employeeNumber: "synthetic", optionType: "vocational_school", dateFrom: "2032-07-06", dateTo: "2032-07-06" };

test("school change guards all 16 later weeks before discovery and commits its evaluated receipt with stable facts", async () => {
  const { state, context } = fixture();
  const prepared = await context.prepareVocationalSchoolOptionEvaluations(school);
  assert.equal(state.captures[0][0].weekStart, "2032-07-05");
  assert.equal(state.captures[0][0].throughWeekStart, "2032-10-25");
  assert.equal(state.discovery[0].dateTo, "2032-10-31");
  const saved = await context.mutateVocationalSchoolOption(prepared, repository => repository.insertWeekOption(), "synthetic");
  assert.equal(saved.result.rows[0].id, 1);
  assert.equal(state.captures.length, 2);
  assert.equal(state.writes, 1); assert.equal(state.receipts, 1); assert.equal(state.rollbacks, 0);
});

test("concurrent plan or protected personnel changes reject a stale school mutation before any option or receipt is written", async () => {
  const { state, context } = fixture(true);
  const prepared = await context.prepareVocationalSchoolOptionEvaluations(school);
  await assert.rejects(context.mutateVocationalSchoolOption(prepared, repository => repository.insertWeekOption(), "synthetic"), {
    status: 409, code: "VOCATIONAL_SCHOOL_CONCURRENT_CHANGE",
  });
  assert.equal(state.writes, 0); assert.equal(state.receipts, 0); assert.equal(state.rollbacks, 1);
});

test("school deletion guards both the previous employee and range; a missing preparation guard fails closed", async () => {
  const { state, context } = fixture();
  const prepared = await context.prepareVocationalSchoolOptionEvaluations(null, { id: 8, employee_number: "synthetic", option_type: "vocational_school", date_from: "2032-07-06", date_to: "2032-07-06" });
  assert.equal(prepared.length, 1);
  assert.equal(state.captures[0][0].employeeNumber, "synthetic");
  await assert.rejects(context.mutateVocationalSchoolOption([], repository => repository.insertWeekOption(), "synthetic"), { code: "VOCATIONAL_SCHOOL_CONCURRENT_CHANGE" });
  assert.equal(state.writes, 0); assert.equal(state.receipts, 0);
});
