"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createOptimizerService, pythonPath } = require("../lib/planning-optimizer-service");
const { input, buildProblem, createPlanningOptimizer } = require("../lib/planning-optimizer");
const ready = fs.existsSync(pythonPath()), service = createOptimizerService();
if (process.env.GP_PLANNING_SOLVER_TEST === "1") assert(ready, "Python/OR-Tools must be installed");
const problem = () => ({ schemaVersion: 2, employees: [{ id: "one", targetMinutes: 240, saturdayHistory: 4 }, { id: "two", targetMinutes: 240, saturdayHistory: 0 }],
  candidates: [{ employeeId: "one", minutes: 240, preferenceCost: 0, saturday: 1 }, { employeeId: "two", minutes: 240, preferenceCost: 0, saturday: 1 }],
  groups: [{ indices: [0, 1], minimum: 1, maximum: 1 }], baselineIndices: [], forbidden: [], profile: "balanced" });
test("optimizer accepts real calendar dates and rejects injected inputs", () => {
  const value = { week: "2031-04-07", locationId: "A", mode: "optimize" };
  assert.equal(input(value).week, value.week);
  for (const patch of [{ week: "2031-02-29" }, { week: "2031-13-01" }, { week: 2031 }, { locationId: "" }, { facts: {} }, { departmentId: "1" }]) assert.throws(() => input({ ...value, ...patch }));
});
test("real CP-SAT favors a fair Saturday distribution and returns the installed engine", { skip: !ready }, async () => {
  const result = await service.run(problem());
  assert.equal(result.engine, "OR-Tools CP-SAT"); assert.equal(result.status, "OPTIMAL"); assert.deepEqual(result.selected, [1]); assert.equal(result.metrics.saturdaySpread, 3);
  assert.equal((await service.health()).available, true);
});
test("change minimization, employee wishes and alternative scenarios affect the actual optimum", { skip: !ready }, async () => {
  const p = problem(); p.employees.forEach(e => { e.saturdayHistory = 0; }); p.baselineIndices = [0];
  p.candidates[0].preferenceCost = 1; p.profile = "stable";
  assert.deepEqual((await service.run(p)).selected, [0]);
  p.profile = "wishes"; assert.deepEqual((await service.run(p)).selected, [1]);
  p.forbidden = [[1]]; assert.deepEqual((await service.run(p)).selected, [0]);
});
test("impossible coverage reports infeasible with the responsible requirement instead of inventing a plan", { skip: !ready }, async () => {
  const p = problem(); p.groups.push({ indices: [], minimum: 1, maximum: 1 });
  const result = await service.run(p); assert.equal(result.status, "INFEASIBLE"); assert.deepEqual(result.selected, []); assert(result.conflictingGroups.includes(1));
});

test("ranked wishes preserve the single-wish weight and do not delete a required 240-minute shift without approved credit", { skip: !ready }, async () => {
  const legacy = { schemaVersion: 2, employees: [{ id: "one", targetMinutes: 240, creditMinutes: 0, saturdayHistory: 0 }],
    candidates: [{ employeeId: "one", minutes: 240, preferenceCost: 1, saturday: 0 }],
    groups: [], baselineIndices: [0], forbidden: [], profile: "wishes" };
  const prior = await service.run(legacy);
  assert.deepEqual(prior.selected, [0]);
  const ranked = { ...legacy, preferenceCostScale: 4, candidates: [{ ...legacy.candidates[0], preferenceCost: 4 }] };
  const current = await service.run(ranked);
  assert.deepEqual(current.selected, prior.selected);
  assert.deepEqual(current.metrics, prior.metrics);
  assert.equal(current.objective, prior.objective);
  assert.equal(current.metrics.preferencePenalty, 1);
  const credited = await service.run({ ...ranked, employees: [{ ...ranked.employees[0], creditMinutes: 240 }] });
  assert.deepEqual(credited.selected, []);
  assert.equal(credited.metrics.targetDeviationMinutes, 0);
  const ordered = { ...ranked, candidates: [4, 3, 2, 1].map(preferenceCost => ({ ...ranked.candidates[0], preferenceCost })),
    groups: [{ indices: [0, 1, 2, 3], minimum: 1, maximum: 1 }], baselineIndices: [] };
  const choice = await service.run(ordered);
  assert.deepEqual(choice.selected, [3]);
  assert.equal(choice.metrics.preferencePenalty, 0.25);
  for (const invalid of [0, -1, 5, 1.5, "4", true]) {
    await assert.rejects(service.run({ ...ranked, preferenceCostScale: invalid }), { code: "OPTIMIZER_UNAVAILABLE" });
  }
});
test("unavailable runtime, oversized input and cancellation return bounded safe errors", async () => {
  await assert.rejects(createOptimizerService({ python: path.join(os.tmpdir(), "missing-gp-python") }).run(problem()), { code: "OPTIMIZER_UNAVAILABLE" });
  if (!ready) return;
  await assert.rejects(service.run({ body: "x".repeat(2_000_000) }), { code: "OPTIMIZER_SCOPE_LIMIT" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.run(problem(), { signal: controller.signal }), { code: "OPTIMIZER_CANCELLED" });
});
test("the explicit server disable takes effect even when a successful health result is cached", async () => {
  const previous = process.env.GRABENPLANER_PLANNING_OPTIMIZER_ENABLED;
  try {
    process.env.GRABENPLANER_PLANNING_OPTIMIZER_ENABLED = '0';
    assert.equal((await service.health()).available, false);
    await assert.rejects(service.run(problem()), { code: 'OPTIMIZER_DISABLED' });
  } finally {
    if (previous === undefined) delete process.env.GRABENPLANER_PLANNING_OPTIMIZER_ENABLED; else process.env.GRABENPLANER_PLANNING_OPTIMIZER_ENABLED = previous;
  }
});
test("a cancelled proposal stops after authorization, before personnel data or the solver are loaded", async () => {
  const controller = new AbortController();
  const optimizer = createPlanningOptimizer({ refresh: async () => {}, authorize: async () => controller.abort(),
    read: () => assert.fail('cancelled read'), stamp: () => assert.fail('cancelled source load') });
  await assert.rejects(optimizer.prepare({}, { week: '2031-04-07', locationId: 'A', mode: 'optimize' }, { signal: controller.signal }), { code: 'OPTIMIZER_CANCELLED' });
});
test("the Python process is isolated from GP secrets, timed out and terminated on cancellation", { skip: !ready }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-solver-probe-")), script = path.join(directory, "probe.py");
  const previous = process.env.GP_SOLVER_SYNTHETIC_SECRET; process.env.GP_SOLVER_SYNTHETIC_SECRET = "must-not-reach-worker";
  try {
    fs.writeFileSync(script, 'import os,json\nprint(json.dumps({"schemaVersion":2,"secretPresent":"GP_SOLVER_SYNTHETIC_SECRET" in os.environ}))\n');
    assert.equal((await createOptimizerService({ script }).run({})).secretPresent, false);
    fs.writeFileSync(script, "import time\ntime.sleep(10)\n");
    await assert.rejects(createOptimizerService({ script, timeoutMs: 100 }).run({}), { code: "OPTIMIZER_TIMEOUT" });
    const worker = createOptimizerService({ script }), abort = new AbortController(), pending = worker.run({}, { signal: abort.signal });
    await assert.rejects(worker.run({}), { code: "OPTIMIZER_BUSY" }); abort.abort();
    await assert.rejects(pending, { code: "OPTIMIZER_CANCELLED" });
  } finally {
    if (previous === undefined) delete process.env.GP_SOLVER_SYNTHETIC_SECRET; else process.env.GP_SOLVER_SYNTHETIC_SECRET = previous;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
test("candidate generation keeps foreign assignments out and checks qualifications in the proposed department", async () => {
  const q = { available: true, checks: [{ employeeId: "one", date: "2031-04-07", departmentId: 7, status: "missing" }] };
  const snapshot = { schedule: { employees: [{ personnel_number: "one", contracted_hours: 4 }], settings: {}, globalBlockDates: [] }, rawShifts: [],
    facts: { period: { from: "2031-04-07", to: "2031-04-07" }, context: { locationId: "A", departmentId: 7 },
      employees: [{ id: "one", hoursComplete: true, targetMinutes: 240, creditedMinutes: 0 }], shifts: [], qualifications: q, requirements: [] } };
  const built = await buildProblem(snapshot, { mode: "optimize" }, { day: async () => ({ open: true, start: "09:00", end: "13:00" }), history: async () => ({}), candidate: () => { throw new Error("unqualified candidate must never be considered"); } }, {});
  assert.equal(built.candidates.length, 0);
  assert(!JSON.stringify(built.problem).includes("name"));
});
