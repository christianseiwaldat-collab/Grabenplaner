"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const T = require("../lib/personnel-learning-team");
const { createQualificationReader, eligible } = require("../lib/planning-qualifications");
const { assessPlanning } = require("../lib/planning-assistant");
function fixture(payload = {}) {
  const rule = { id: "kassa-rule", revision: 1, previousReceipt: "", changedBy: "lead", changedAt: "2030-01-01", payload: {
    title: "Kassa", type: "skill", moduleId: "kassa", moduleVersionNumber: 2, minLevel: 3, validMonths: 12,
    scope: { type: "organization" }, active: true, ...payload,
  } }; rule.receiptSha256 = T.receipt(rule);
  const evidence = { teamCompetencies: [{ id: "c1", employeeNumber: "one", skillModuleId: "kassa" }], teamCompetencyRevisions: [], teamAssignments: [], teamAssignmentRevisions: [], teamProgressRevisions: [] };
  const state = { active: true, current: { competencyLevel: 4, skillVersionNumber: 2, changedAt: "2030-04-08" } };
  const calls = [], access = { canWriteAssignments: true };
  const deps = { actor: async () => ({ access }), employeeAllowed: (_, e) => e.personnel_number === "one", bundles: async () => [],
    competencyState: () => state, roles: async () => [{ employee_number: "one", role: "employee" }],
    repository: { listRequirements: async () => [rule], teamData: async ids => { calls.push(ids); return evidence; } } };
  const schedule = { weekStart: "2031-04-07", weekEnd: "2031-04-13", context: { locationId: "A", departmentId: null },
    employees: [{ personnel_number: "one", position_id: "sales", preferred_department_id: 8 }] };
  return { rule, state, evidence, deps, schedule, access, calls, read: createQualificationReader(deps) };
}
test("existing skill validity is evaluated on the duty date including the last valid day", async () => {
  const f = fixture(), q = await f.read(f.schedule, {});
  assert.equal(q.checks.find(c => c.date === "2031-04-08").status, "dueSoon");
  assert.equal(q.checks.find(c => c.date === "2031-04-09").status, "expired");
  assert(eligible(q, "one", "2031-04-08")); assert(!eligible(q, "one", "2031-04-09"));
  for (const [patch, status] of [[{ skillVersionNumber: 1 }, "otherVersion"], [{ skillVersionNumber: 2, competencyLevel: 1 }, "lowerLevel"]]) {
    Object.assign(f.state.current, patch); assert.equal((await f.read(f.schedule, {})).checks[0].status, status);
  }
  f.state.active = false; assert.equal((await f.read(f.schedule, {})).checks[0].status, "missing");
});
test("department requirements follow the actual duty, not the employee's preferred department", async () => {
  const f = fixture({ scope: { type: "department", locationId: "A", departmentId: 7 }, positionId: "sales", roleId: "employee" });
  f.state.active = false;
  const q = await f.read(f.schedule, {}, { departmentIds: [null, 7, 8] });
  assert(q.checks.every(c => c.departmentId === 7));
  assert(!eligible(q, "one", "2031-04-07", 7)); assert(eligible(q, "one", "2031-04-07", 8));
  f.schedule.employees[0].position_id = "other"; assert.equal((await f.read(f.schedule, {}, { departmentIds: [7] })).checks.length, 0);
});
test("learning rights are mandatory and foreign employees' evidence is never loaded", async () => {
  const f = fixture(); f.access.canWriteAssignments = false;
  assert.equal((await f.read(f.schedule, {})).available, false); assert.equal(f.calls.length, 0);
  f.access.canWriteAssignments = true; f.schedule.employees.push({ personnel_number: "foreign" });
  const q = await f.read(f.schedule, {});
  assert.deepEqual(f.calls, [["one"]]); assert(!eligible(q, "foreign", "2031-04-07", 7));
  assert.equal(q.checks.filter(c => c.employeeId === "foreign").length, 7);
});
test("tampered requirement receipts fail closed and later evidence cannot certify a historical duty", async () => {
  const f = fixture(); f.state.current.changedAt = "2031-05-01";
  assert((await f.read(f.schedule, {})).checks.every(c => c.status === "unknown"));
  f.rule.payload.minLevel = 1; await assert.rejects(f.read(f.schedule, {}), /nicht vollständig überprüfbar/);
});
test("training checks use the same published version and finalized progress as the learning matrix", async () => {
  const f = fixture({ type: "training" });
  f.evidence.teamAssignments = [{ id: "a1", learnerEmployeeNumber: "one", processModuleId: "kassa" }];
  f.deps.bundles = async () => [{ module: { id: "kassa" }, versions: [{ versionNumber: 2, content: { steps: [{ stepId: "existing-step" }] } }] }];
  f.deps.assignmentState = () => ({ active: true, current: { processVersionNumber: 2, changedAt: "2030-04-08" } });
  f.deps.progressState = (_, steps) => { assert.equal(steps[0].stepId, "existing-step"); return { finalized: true, result: "passed", current: { changedAt: "2030-04-08" } }; };
  assert.equal((await f.read(f.schedule, {})).checks[0].status, "dueSoon");
  f.deps.bundles = async () => []; await assert.rejects(f.read(f.schedule, {}), /Schulungsfassung/);
});
test("missing optional configuration remains a review note; a configured missing key person remains hard", () => {
  const result = assessPlanning({ employees: [], shifts: [], unavailable: [], requirements: [{ date: "2031-04-07", startTime: "09:00", endTime: "10:00", kind: "key_person", label: "Aufsperren", employeeIds: ["one"], minimum: 1 }],
    period: {}, context: { locationId: "A" }, configuration: {}, gaps: [{ rule: "key_person", message: "Keine zusätzliche Einstellung" }], qualifications: { available: true, checks: [] } });
  assert.equal(result.findings.find(f => f.message === "Keine zusätzliche Einstellung").constraint, "review");
  assert.equal(result.findings.find(f => f.requirement === "Aufsperren").constraint, "hard");
});
