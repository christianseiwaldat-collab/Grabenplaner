"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { createPlanningDerivedRefresh } = require("../lib/planning-derived-refresh");
const source = fs.readFileSync(require.resolve("../server"), "utf8").replace(/\r\n/g, "\n");
const plain = value => JSON.parse(JSON.stringify(value));
const addDays = (date, days) => new Date(Date.parse(date + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
function extract(name, input = source) {
  const start = input.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  const end = input.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, name);
  return input.slice(start, end + 3);
}
function load(names, values, { historical = false } = {}) {
  const input = historical ? fs.readFileSync(require("../test-support/legacy-baseline").legacyPath("server.js"), "utf8").replace(/\r\n/g, "\n") : source;
  if (historical) values.sqliteEmployeeLocationLendingOperations = values.employeeLocationLendingOperations;
  const context = vm.createContext(values);
  vm.runInContext(names.map(name => extract(name, input)).join("\n"), context);
  return context;
}

function validationFixture({ postgres = true, revokeAt = 0, foreign = false } = {}) {
  const state = { inside: false, snapshots: 0, reauthorizations: 0, lending: 0, sick: false, trace: [] };
  const employee = { personnel_number: "E1", nickname: "One", home_location_id: foreign ? "19" : "18" };
  const catalog = (name, value) => async () => {
    assert.equal(state.inside, postgres, name + " must use the current read snapshot");
    state.trace.push(name);
    return typeof value === "function" ? value() : value;
  };
  const legacy = value => async () => {
    assert.equal(state.inside, false, "legacy lending must stay outside the catalog snapshot");
    state.lending++; state.trace.push("lending"); return value;
  };
  const c = load(["readPlanningMutation", ...(postgres ? ["assertPlanningEmployment"] : []), "validateShift"], {
    postgresqlActive: postgres, Set,
    require: id => { assert.equal(id, './lib/schedule-employment'); return require('../lib/schedule-employment'); },
    organizationPersonnelRepository: {},
    personnelSensitiveProfile: catalog('employment', { employment: { startDate: '' } }),
    applicationPersistence: { async readSnapshot(work) {
      assert.equal(state.inside, false); const phase = ++state.snapshots;
      state.inside = true; state.trace.push("begin:" + phase);
      try {
        const result = await work(); state.reauthorizations++;
        if (phase === revokeAt) throw new Error("AUTHORITY_REVOKED");
        state.trace.push("authorized:" + phase); return result;
      } finally { state.inside = false; }
    } },
    planningSettingsRepository: {
      getPlanningEmployee: catalog("employee", employee), getOverlappingShift: catalog("overlap", null),
    },
    normalizeDepartmentId: value => Number(value || 0) || null,
    normalizeLocationId: value => String(value),
    isIsoDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value), isTime: value => /^\d{2}:\d{2}$/.test(value),
    defaultScheduleDutyCode: () => "general",
    validateLocationExists: catalog("location", { id: "18" }),
    validateDepartmentExists: catalog("department", { id: 7, location_id: "18" }),
    employeeLocationLendingOperations: { overlapForShift: legacy(null), coverageForShift: legacy({ destinationDepartmentId: 7 }) },
    employeeCanWorkOnDate: () => true, settingsForLocation: catalog("settings", {}),
    assertDateEditable: catalog("manual-lock", undefined), getGlobalDayBlockForDate: () => null,
    manualPlanningHours: () => ({ start: "07:00", end: "21:00" }), dayConfiguration: async () => ({}),
    overlappingWeekOption: catalog("week-options", null),
    activeSicknessEmployeeNumbers: catalog("sickness", () => new Set(state.sick ? ["E1"] : [])),
    sessionHasGlobalScope: () => false,
    httpError: (status, message, code) => Object.assign(new Error(message), { status, code }),
  }, { historical: !postgres });
  const input = { employeeNumber: "E1", locationId: "18", departmentId: 7,
    date: "2032-07-05", startTime: "09:00", endTime: "17:00", area: "Area", note: "Note" };
  return { c, state, input };
}

test("current PostgreSQL validation brackets lending with authorized snapshots; historical SQLite behavior remains separately bound", async () => {
  for (const postgres of [true, false]) for (const foreign of [true, false]) {
    const { c, state, input } = validationFixture({ postgres, foreign });
    assert.deepEqual(plain(await c.validateShift(input, {}, { employeeNumber: "actor" })), {
      employeeNumber: "E1", locationId: "18", departmentId: 7, dutyCode: "department",
      shiftDate: input.date, startTime: "09:00", endTime: "17:00", area: "Area", note: "Note",
    });
    assert.equal(state.lending, 1);
    assert.equal(state.snapshots, postgres ? 2 : 0);
    assert.equal(state.reauthorizations, postgres ? 2 : 0);
    if (postgres) assert.deepEqual(state.trace.filter(value => /^(begin|authorized|lending)/.test(value)),
      ["begin:1", "authorized:1", "lending", "begin:2", "authorized:2"]);
  }
});

test("shift validation rejects authority loss in either read phase and never caches a later sickness change", async () => {
  for (const revokeAt of [1, 2]) {
    const { c, state, input } = validationFixture({ revokeAt });
    await assert.rejects(c.validateShift(input), /AUTHORITY_REVOKED/);
    assert.equal(state.snapshots, revokeAt);
    assert.equal(state.lending, revokeAt === 1 ? 0 : 1);
    assert.equal(state.inside, false);
  }
  const { c, state, input } = validationFixture();
  await c.validateShift(input);
  state.sick = true;
  await assert.rejects(c.validateShift(input), error => error.code === "SICKNESS_SHIFT_CONFLICT");
  assert.equal(state.snapshots, 4);
  assert.equal(state.lending, 2);
});

test("planning context uses one fresh locations list while preserving fallback, missing and department checks", async () => {
  let reads = 0, rows = [{ id: "17", name: "Inactive", active: false }, { id: "18", name: "Active", active: true }];
  const c = load(["resolvePlanningContext"], {
    postgresqlActive: true,
    organizationPersonnelRepository: { async listLocations(includeInactive) { assert.equal(includeInactive, true); reads++; return rows; } },
    normalizeLocationId: value => String(value), normalizeDepartmentId: value => Number(value || 0) || null,
    async validateDepartmentExists(id, locationId) {
      if (id && locationId !== "18") throw new Error("DEPARTMENT_LOCATION_MISMATCH");
      return id ? { id, name: "Department" } : null;
    },
    httpError: (status, message) => Object.assign(new Error(message), { status }),
  });
  assert.equal((await c.resolvePlanningContext({})).locationId, "18");
  assert.equal(reads, 1);
  assert.equal((await c.resolvePlanningContext({ locationId: "17" })).locationName, "Inactive");
  await assert.rejects(c.resolvePlanningContext({ locationId: "missing" }), error => error.status === 404);
  await assert.rejects(c.resolvePlanningContext({ locationId: "17", departmentId: 7 }), /DEPARTMENT_LOCATION_MISMATCH/);
  rows = [];
  await assert.rejects(c.resolvePlanningContext({}), /PG_APPLICATION_LOCATION_REQUIRED/);
  assert.equal(reads, 5, "one current locations read per invocation, no cross-request cache");
});

test("mutation employees retain the exact weekly scope and serialization without loading the schedule", async () => {
  const reads = [], rows = [{ personnel_number: "lent" }, { personnel_number: "home" }];
  const c = load(["planningMutationEmployees"], { addDays,
    assertSessionContextScope(session, context) { assert.equal(context.locationId, session.allowed); },
    planningSettingsRepository: { async listScheduleEmployees(query) { reads.push(plain(query)); return rows; } },
    serializeEmployee: row => ({ ...row, active: true }),
  });
  assert.deepEqual(plain(await c.planningMutationEmployees("2032-07-05", { locationId: "18", departmentId: 7 }, { allowed: "18" })),
    rows.map(row => ({ ...row, active: true })));
  assert.deepEqual(reads, [{ locationId: "18", departmentId: 7, weekStart: "2032-07-05", weekEnd: "2032-07-11" }]);
  await assert.rejects(c.planningMutationEmployees("2032-07-05", { locationId: "19" }, { allowed: "18" }));
  assert.equal(reads.length, 1, "scope rejection precedes the data read");
});

test("branch supervision projects before and after from one fresh snapshot, including candidate employees", async () => {
  const calls = [], employees = [{ personnel_number: "E1" }], shifts = [{ id: 1, start_time: "09:00" }];
  const c = load(["branchSupervisionAssessmentForSchedule", "evaluateBranchSupervisionMutation"], { addDays,
    settingsForLocation: async id => { calls.push("settings:" + id); return { minimum: 1 }; },
    planningSettingsRepository: {
      async listScheduleEmployees() { calls.push("employees"); return employees; },
      async listScheduleShifts() { calls.push("shifts"); return shifts; },
      async getActivePlanningEmployee({ employeeNumber }) { calls.push("candidate"); return { personnel_number: employeeNumber }; },
    },
    projectBranchSupervisionShifts: (rows, change) => change ? [...rows, { id: 2 }] : rows,
    getGlobalDayBlocksForRange: () => [], publicHolidaysForRange: () => [],
    assessBranchSupervision: input => ({ employees: input.employees, shifts: input.shifts, dates: input.dates }),
  });
  const result = await c.evaluateBranchSupervisionMutation("2032-07-05", "18", { employeeNumber: "E2" }, ["2032-07-05"]);
  assert.deepEqual(calls, ["settings:18", "employees", "shifts", "candidate"]);
  assert.equal(result.before.employees.length, 1);
  assert.equal(result.after.employees.length, 2);
  assert.equal(result.before.shifts.length, 1);
  assert.equal(result.after.shifts.length, 2);
  assert.equal(employees.length, 1);
  assert.equal(shifts.length, 1);
  await c.evaluateBranchSupervisionMutation("2032-07-05", "18", null, ["2032-07-05"]);
  assert.equal(calls.filter(x => x === "shifts").length, 2, "no cross-mutation cache");
});

test("work-rule reuse binds employee, context, week and candidate; team and individual receipts stay distinct", async () => {
  const calls = [], base = { personnel_number: "E1", nickname: "One", position_id: "sales" };
  const c = load(["workRuleEvaluationEmployees", "createPlanningWorkRuleEvaluator"], {
    portalScopeProjectionSnapshot: { employees: [{ personnel_number: "E2", active: true }] },
    workRuleSha256: value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    evaluateScheduleWorkRules: async (...args) => { calls.push(plain(args)); return { index: calls.length }; },
  });
  const evaluate = c.createPlanningWorkRuleEvaluator(), context = { locationId: "18", departmentId: null };
  const change = { id: 1, employeeNumber: "E1", startTime: "09:00" };
  const first = await evaluate("2032-07-05", context, [base], change);
  assert.equal(await evaluate("2032-07-05", { ...context }, [{ ...base, unusedDisplayColor: "blue" }], { ...change }), first);
  for (const args of [
    ["2032-07-12", context, [base], change],
    ["2032-07-05", { ...context, departmentId: 2 }, [base], change],
    ["2032-07-05", context, [{ ...base, position_id: "manager" }], change],
    ["2032-07-05", context, [{ ...base, position_employment_classification: "apprentice" }], change],
    ["2032-07-05", context, [base, { personnel_number: "E2" }], change],
    ["2032-07-05", context, [base], { ...change, startTime: "10:00" }],
  ]) assert.notEqual(await evaluate(...args), first);
  assert.equal(calls.length, 7);
  await c.createPlanningWorkRuleEvaluator()("2032-07-05", context, [base], change);
  assert.equal(calls.length, 8, "each mutation checks fresh data");
});

test("changed old/new targets remain complete and only identical effective evaluations are reused", async () => {
  const calls = [], employees = { E1: { personnel_number: "E1" }, E2: { personnel_number: "E2", active: true } };
  const c = load(["workRuleEvaluationEmployees", "createPlanningWorkRuleEvaluator", "evaluateWorkRuleChanges"], {
    portalScopeProjectionSnapshot: { employees: Object.values(employees) },
    workRuleSha256: value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    evaluateScheduleWorkRules: async (...args) => { calls.push(plain(args)); return { assessment: { outcome: "pass" } }; },
    absenceManagementRepository: { workRuleEvaluationEmployee: async id => employees[id] },
    isIsoDate: date => /^\d{4}-\d{2}-\d{2}$/.test(date), getMonday: date => date,
    resolvePlanningContext: async input => input,
    assertWorkRuleAssessmentAllowsMutation: assessment => assert.equal(assessment.outcome, "pass"),
  });
  const old = { employee_number: "E1", location_id: "18", shift_date: "2032-07-05" };
  const same = { employeeNumber: "E1", locationId: "18", shiftDate: "2032-07-05" };
  const evaluator = c.createPlanningWorkRuleEvaluator();
  await evaluator("2032-07-05", { locationId: "18", departmentId: null }, [employees.E1], same);
  const unchanged = await c.evaluateWorkRuleChanges([old, same], same, c.absenceManagementRepository, evaluator);
  assert.equal(unchanged.length, 1);
  assert.equal(calls.length, 1);
  const moved = { ...same, employeeNumber: "E2", locationId: "19", shiftDate: "2032-07-12" };
  const changed = await c.evaluateWorkRuleChanges([old, moved], moved, c.absenceManagementRepository, evaluator);
  assert.deepEqual(plain(changed.map(x => [x.weekStart, x.locationId, x.employeeNumber])),
    [["2032-07-05", "18", "E1"], ["2032-07-12", "19", "E2"]]);
  assert.equal(calls.length, 3);
});

function routeFixture({ rejectAuthority = false } = {}) {
  const state = { inside: false, writes: 0, reads: 0, refreshes: 0, snapshots: 0 }, routes = {};
  const shift = { employeeNumber: "E1", locationId: "18", departmentId: null, shiftDate: "2032-07-05" };
  const existing = { id: 1, employee_number: "E1", location_id: "18", department_id: null, shift_date: shift.shiftDate };
  const context = { locationId: "18", departmentId: null };
  const evaluated = { assessment: { outcome: "pass" } };
  const values = { postgresqlActive: true,
    require: id => { assert.equal(id, './lib/schedule-employment'); return require('../lib/schedule-employment'); },
    organizationPersonnelRepository: {},
    personnelSensitiveProfile: async () => ({ employment: { startDate: '' } }),
    app: Object.fromEntries(["post", "put", "delete"].map(method => [method, (path, handler) => { routes[method] = handler; }])),
    applicationPersistence: { async readSnapshot(work) {
      state.snapshots++; state.inside = true;
      try { const result = await work(); if (rejectAuthority) throw new Error("AUTHORITY_REVOKED"); return result; }
      finally { state.inside = false; }
    } },
    validateShift: async () => { assert.equal(state.inside, false); return shift; },
    assertShiftEmployeeAssignmentScope: async () => { assert.equal(state.inside, false); },
    planningMutationEmployees: async () => { assert.equal(state.inside, true); state.reads++; return [{ personnel_number: "E1" }]; },
    planningSettingsRepository: { getShiftById: async () => existing },
    resolvePlanningContext: async () => context, getMonday: date => date,
    assertSessionContextScope: () => {}, assertDateEditable: async () => {}, settingsForLocation: async () => ({}),
    evaluateScheduleWorkRules: async () => { assert.equal(state.inside, true); return evaluated; },
    createPlanningWorkRuleEvaluator: () => values.evaluateScheduleWorkRules,
    evaluateWorkRuleChanges: async () => { assert.equal(state.inside, true); return [{ ...shift, weekStart: shift.shiftDate, context, evaluated }]; },
    absenceManagementRepository: {},
    evaluateBranchSupervisionMutation: async () => { assert.equal(state.inside, true); return { after: { outcome: "pass" } }; },
    evaluateBranchSupervisionShiftUpdate: async () => { assert.equal(state.inside, true); return { outcome: "pass" }; },
    assertWorkRuleAssessmentAllowsMutation: () => {}, assertBranchSupervisionAllowsMutation: () => {},
    async runWorkRuleMutationTransaction(work) {
      assert.equal(state.inside, false, "write must be outside the finalized read snapshot"); state.writes++;
      const result = { rowsAffected: 1, returnedRows: [{ id: 1 }] };
      return work({ insertPlanningShift: async () => result, updatePlanningShift: async () => result,
        deletePlanningShift: async () => result, invalidatePlanningDayReview: async () => {} });
    },
    recordEvaluatedWorkRuleEvaluation: async () => evaluated.assessment,
    refreshPlanningDerivedStateAfterCommit: async () => { assert.equal(state.inside, false); assert.equal(state.writes, 1); state.refreshes++; },
    sessionCanReadWorkRules: () => true, staffAssignmentShiftConstraintError: error => error,
    httpError: (_, message) => new Error(message),
  };
  const c = load(["readPlanningMutation", "assertPlanningEmployment"], values);
  const start = source.indexOf('app.post("/api/shifts",');
  vm.runInContext(source.slice(start, source.indexOf('app.delete("/api/schedule",', start)), c);
  return { state, routes };
}

for (const method of ["post", "put", "delete"]) test(`${method} keeps read authority completion before commit and refresh; revocation cannot write`, async () => {
  const response = { status() { return this; }, json() {}, end() {} };
  for (const rejectAuthority of [false, true]) {
    const { state, routes } = routeFixture({ rejectAuthority });
    const request = { body: {}, params: { id: "1" }, portalSession: { employeeNumber: "actor" } };
    if (rejectAuthority) await assert.rejects(routes[method](request, response), /AUTHORITY_REVOKED/);
    else await routes[method](request, response);
    assert.equal(state.snapshots, 1);
    assert.equal(state.reads, 1);
    assert.equal(state.writes, rejectAuthority ? 0 : 1);
    assert.equal(state.refreshes, rejectAuthority ? 0 : 1);
  }
});

test("preview validates lending outside the snapshot and reauthorizes its narrow read before responding", async () => {
  for (const rejectAuthority of [false, true]) {
    let handler, inside = false, reads = 0, evaluations = 0, responses = 0;
    const c = load(["readPlanningMutation", "planningMutationEmployees"], {
      postgresqlActive: true, addDays, getMonday: date => date, isIsoDate: date => Boolean(date),
      app: { post(path, callback) { assert.equal(path, "/api/work-rules/evaluate"); handler = callback; } },
      applicationPersistence: { async readSnapshot(read) {
        inside = true;
        try { const result = await read(); if (rejectAuthority) throw new Error("AUTHORITY_REVOKED"); return result; }
        finally { inside = false; }
      } },
      resolvePlanningContext: async () => ({ locationId: "18", departmentId: null }),
      assertSessionContextScope: () => {}, serializeEmployee: row => row,
      planningSettingsRepository: { async listScheduleEmployees() {
        assert.equal(inside, true); reads++; return [{ personnel_number: "E1" }];
      } },
      async validateShift(shift) {
        assert.equal(inside, false);
        return { ...shift, shiftDate: shift.date };
      },
      assertShiftEmployeeAssignmentScope: async () => assert.equal(inside, false),
      async evaluateScheduleWorkRules(week, context, employees, candidate) {
        assert.equal(inside, true); evaluations++;
        assert.equal(week, "2032-07-05"); assert.equal(context.locationId, "18");
        assert.equal(employees[0].personnel_number, "E1"); assert.equal(candidate.employeeNumber, "E1");
        return { assessment: { outcome: "manual_review" } };
      },
      httpError: (_, message) => new Error(message),
    });
    const start = source.indexOf('app.post("/api/work-rules/evaluate",');
    vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), c);
    const request = { body: { weekStart: "2032-07-05", shift: { employeeNumber: "E1", date: "2032-07-05",
      startTime: "09:00", endTime: "17:00" } }, portalSession: {} };
    const response = { json(value) {
      assert.equal(inside, false); responses++;
      assert.equal(value.outcome, "manual_review"); assert.equal(value.candidate.date, "2032-07-05");
    } };
    if (rejectAuthority) await assert.rejects(handler(request, response), /AUTHORITY_REVOKED/);
    else await handler(request, response);
    assert.equal(reads, 1); assert.equal(evaluations, 1);
    assert.equal(responses, rejectAuthority ? 0 : 1);
  }
});

test("derived refresh coalesces bursts, runs again for mid-flight changes and never overlaps", async () => {
  let entered, release, calls = 0, concurrent = 0, maximum = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const queue = createPlanningDerivedRefresh({ work: async () => {
    calls++; concurrent++; maximum = Math.max(maximum, concurrent);
    if (calls === 1) { entered(); await gate; }
    concurrent--;
  } });
  for (let i = 0; i < 20; i++) queue.request();
  await started;
  for (let i = 0; i < 20; i++) queue.request();
  release(); await queue.close();
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  assert.equal(queue.request(), false);
});

test("derived refresh failure is observed and a later periodic run retries durable state", async () => {
  const errors = []; let calls = 0;
  const queue = createPlanningDerivedRefresh({ work: async () => { if (++calls === 1) throw new Error("synthetic"); },
    onError: error => errors.push(error.message) });
  await queue.run();
  assert.deepEqual(errors, ["synthetic"]);
  await queue.run(); await queue.close();
  assert.equal(calls, 2);
});

test("shutdown drains a queued refresh once, and workers reread durable input after restart", async () => {
  const persisted = { version: 1 }, seen = [];
  const work = async () => seen.push(persisted.version);
  const first = createPlanningDerivedRefresh({ work });
  first.request(); persisted.version = 2;
  await first.close();
  const restarted = createPlanningDerivedRefresh({ work });
  await restarted.run(); await restarted.close();
  assert.deepEqual(seen, [2, 2]);
});

test("post-commit refresh detaches request authority only with the server's periodic recovery path", async () => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  const requestContext = new AsyncLocalStorage(), observations = [];
  const c = load(["refreshPlanningDerivedStateAfterCommit"], {
    sicknessSweepInterval: null, persistenceRequestContext: requestContext,
    refreshSicknessStaffingAfterPlanningChange: async () => { observations.push(["synchronous", requestContext.getStore()]); },
    planningDerivedRefresh: { request() { observations.push(["queued", requestContext.getStore()]); } },
  });
  await requestContext.run("actor", () => c.refreshPlanningDerivedStateAfterCommit());
  c.sicknessSweepInterval = {};
  await requestContext.run("actor", () => c.refreshPlanningDerivedStateAfterCommit());
  assert.deepEqual(observations, [["synchronous", "actor"], ["queued", undefined]]);
});
