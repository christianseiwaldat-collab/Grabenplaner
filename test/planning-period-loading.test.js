"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8").replace(/\r\n/g, "\n");
function extract(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`), end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 3);
}
function fixture() {
  const calls = [], errors = [], renders = [];
  const state = { data: {}, vacationData: { year: 2032 }, locations: [{ id: "18" }], weekStart: "2032-07-05", vacationYear: 2032,
    locationId: "18", departmentId: "", portalSession: { user: { role: "developer" } }, allEmployees: ["kept"], brandingKits: ["kept"] };
  const f = vm.createContext({ state, AbortController,
    api(url, options = {}) { return new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })); },
    contextQuery: department => `&location=${state.locationId}${department && state.departmentId ? `&departmentId=${state.departmentId}` : ""}`,
    showToast: message => errors.push(message), render: () => renders.push({ week: state.data.weekStart, year: state.vacationData.year }),
    setDefaultContext() {}, restoreRememberedOverallContext() {}, canReadManagerRequests: () => false, canReadLoanManagement: () => false, canManageBranchOrders: () => false,
  });
  vm.runInContext("let loadAllGeneration=0; let planningPeriodController=null;\n" + ["loadAll", "loadPlanningPeriod", "planningContextNeedsReload", "loadPlanningView"].map(extract).join("\n"), f);
  return { f, state, calls, errors, renders };
}
const schedule = (week = "2032-07-05") => ({ weekStart: week, settings: { allow_past_week_editing: "0" }, context: { locationId: "18", departmentId: null } });

test("week navigation requests only the selected schedule and preserves unrelated loaded data", async () => {
  const { f, state, calls, renders } = fixture();
  const vacations = state.vacationData, employees = state.allEmployees, kits = state.brandingKits;
  const task = f.loadPlanningPeriod();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/schedule?week=2032-07-05&location=18");
  calls[0].resolve(schedule()); await task;
  assert.equal(state.vacationData, vacations); assert.equal(state.allEmployees, employees); assert.equal(state.brandingKits, kits);
  assert.equal(state.allowPastWeekEditing, false); assert.equal(renders.length, 1);
});

test("a vacation year reloads vacations alone and retains department-manager scope", async () => {
  const { f, state, calls } = fixture();
  state.departmentId = "42"; state.portalSession.user.role = "department_manager";
  const previousSchedule = state.data;
  const task = f.loadPlanningPeriod("vacation");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/vacations?year=2032&location=18&departmentId=42");
  calls[0].resolve({ year: 2032, vacations: [] }); await task;
  assert.equal(state.data, previousSchedule);
});

test("rapid week changes cancel superseded requests and ignore out-of-order results", async () => {
  const { f, state, calls, renders, errors } = fixture();
  const first = f.loadPlanningPeriod();
  state.weekStart = "2032-07-12";
  const second = f.loadPlanningPeriod();
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve(schedule("2032-07-12")); await second;
  calls[0].resolve(schedule()); await first;
  assert.equal(state.data.weekStart, "2032-07-12"); assert.equal(renders.length, 1); assert.equal(errors.length, 0);
});

test("vacation branch switches request only the selected branch and discard the previous branch response", async () => {
  const { f, state, calls, renders } = fixture();
  state.data = schedule(); state.vacationData.context = { locationId: "18" };
  assert.equal(f.planningContextNeedsReload("vacations"), false);
  state.locationId = "05";
  assert.equal(f.planningContextNeedsReload("vacations"), true);
  const first = f.loadPlanningView("vacations");
  assert.equal(calls[0].url, "/api/vacations?year=2032&location=05");
  state.locationId = "20";
  const second = f.loadPlanningView("vacations");
  assert.equal(calls.length, 2); assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve({year:2032,context:{locationId:"20"},vacations:["current"]});await second;
  calls[0].resolve({year:2032,context:{locationId:"05"},vacations:["old"]});await first;
  assert.deepEqual(state.vacationData.vacations,["current"]);assert.equal(renders.length,1);
  assert.equal(f.planningContextNeedsReload("vacations"),false);
  assert.equal(f.planningContextNeedsReload("planning"),true,"Returning to planning must load its new branch");
});

test("changed session or location discards an outstanding planning response", async () => {
  for (const change of [state => { state.portalSession = { user: { role: "employee" } }; }, state => { state.locationId = "05"; }]) {
    const { f, state, calls, renders } = fixture();
    const previous = state.data, task = f.loadPlanningPeriod(); change(state);
    calls[0].resolve(schedule()); await task;
    assert.equal(state.data, previous); assert.equal(renders.length, 0);
  }
});

test("a full refresh supersedes a period request, while a current failure remains visible", async () => {
  const { f, calls, errors, renders } = fixture();
  const period = f.loadPlanningPeriod();
  const all = f.loadAll();
  assert.equal(calls[0].options.signal.aborted, true);
  calls[0].reject(new Error("cancelled")); await period;
  calls.slice(1).forEach(call => call.reject(new Error("full refresh unavailable"))); await all;
  assert.deepEqual(errors, ["full refresh unavailable"]); assert.equal(renders.length, 0);
  const retry = f.loadPlanningPeriod();
  calls.at(-1).reject(new Error("schedule unavailable")); await retry;
  assert.equal(errors.at(-1), "schedule unavailable");
});
