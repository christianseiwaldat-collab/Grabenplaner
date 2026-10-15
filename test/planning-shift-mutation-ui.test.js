"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { functionSource } = require("../test-support/learning-workspace-ui");
const turn = () => new Promise(setImmediate);
const event = { preventDefault() {} };

function fixture(id = "") {
  const fields = Object.fromEntries(Object.entries({ shiftId: id, shiftEmployee: "E1", shiftDate: "2032-07-05",
    shiftStart: "09:00", shiftEnd: "17:00", shiftArea: "Verkauf", shiftNote: "Entwurf" })
    .map(([key, value]) => ["#" + key, { value, disabled: false }]));
  const state = { portalSession: { user: { id: "actor-a" } }, currentView: "planning", locationId: "18", departmentId: "",
    weekStart: "2032-07-05", locations: [{ id: "18" }], data: { shifts: [] }, allEmployees: ["retained roster"], vacationData: { year: 2032 } };
  const calls = [], toasts = [], renders = [], timersCleared = [], formAttributes = new Map();
  const save = { disabled: false }, remove = { disabled: false }, alreadyDisabled = { disabled: true };
  let confirmations = 0, closed = 0, locked = false;
  const elements = {
    shiftModal: { open: true, close() { this.open = false; closed++; } },
    shiftForm: { querySelectorAll: () => [...Object.values(fields), save, remove, alreadyDisabled],
      setAttribute: (key, value) => formAttributes.set(key, value), removeAttribute: key => formAttributes.delete(key) },
  };
  const preview = new AbortController();
  const context = vm.createContext({ state, elements, window: {}, AbortController, preview,
    document: { querySelector: key => fields[key] },
    clearTimeout: id => timersCleared.push(id),
    startDashboardWorkspaceActorKey: () => state.portalSession?.user?.id || "",
    guardScheduleEditing: () => locked,
    currentShiftDuty: () => ({ departmentId: "", dutyCode: "general" }),
    getMonday: () => "2032-07-05", confirm: () => { confirmations++; return true; },
    api: (url, options = {}) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })),
    showToast: (message, error = false) => toasts.push({ message, error }),
    contextQuery: () => "&location=" + state.locationId,
    syncXoffiImport() {}, settingsConfirmationReadToken: () => ({ key: "current" }), settingsSaveKey: () => "current", acknowledgeSettingsRead() {},
    render: options => renders.push({ data: state.data, options }),
    loadAll: () => { throw Error("A shift mutation must not reload unrelated application data"); },
  });
  vm.runInContext("let shiftMutation=null, shiftEditorGeneration=0, shiftRulePreviewTimer=123, shiftRulePreviewRequest=preview; let loadAllGeneration=0, planningPeriodController=null;\n"
    + ["captureGpContext", "gpContextCurrent", "captureGpEditor", "gpEditorCurrent", "shiftMutationScope", "shiftMutationCurrent",
      "beginShiftMutation", "finishShiftMutation", "saveShift", "deleteShift", "applyLoadedSchedule", "enrichLoadedSchedule", "loadPlanningPeriod"]
      .map(name => functionSource(name)).join("\n"), context);
  const schedule = shifts => ({ weekStart: state.weekStart, context: { locationId: state.locationId }, settings: {}, shifts,
    totals: { E1: 450 }, enrichmentPending: true });
  return { context, state, fields, calls, toasts, renders, preview, timersCleared, elements, save, remove, alreadyDisabled, formAttributes,
    schedule, get closed() { return closed; }, get confirmations() { return confirmations; }, setLocked: value => { locked = value; } };
}

async function resolveRefresh(f, shifts) {
  assert.match(f.calls.at(-1).url, /^\/api\/schedule\?.*&fast=1$/);
  f.calls.at(-1).resolve(f.schedule(shifts)); await turn();
  assert.match(f.calls.at(-1).url, /^\/api\/schedule\/enrichment\?/);
  f.calls.at(-1).resolve({ ...f.schedule(shifts), enrichmentPending: false });
}

test("create/update wait for acknowledgement, suppress duplicate writes and paint the scoped canonical plan before enrichment", async () => {
  for (const id of ["", "7"]) {
    const f = fixture(id), roster = f.state.allEmployees, vacation = f.state.vacationData;
    const pending = f.context.saveShift(event);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.method, id ? "PUT" : "POST");
    assert.equal(f.toasts.length, 0); assert.equal(f.renders.length, 0); assert.equal(f.closed, 0);
    assert.equal(f.preview.signal.aborted, true); assert.deepEqual(f.timersCleared, [123]);
    assert.equal(f.save.disabled, true); assert.equal(f.remove.disabled, true); assert.equal(f.formAttributes.get("aria-busy"), "true");
    await f.context.saveShift(event); await f.context.deleteShift();
    assert.equal(f.calls.length, 1); assert.equal(f.confirmations, 0);
    f.calls[0].resolve({ id: 7, employeeNumber: "E1", startTime: "09:00" }); await turn();
    assert.equal(f.closed, 1); assert.equal(f.toasts.length, 1);
    assert.equal(f.save.disabled, false); assert.equal(f.alreadyDisabled.disabled, true); assert.equal(f.formAttributes.has("aria-busy"), false);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url, "/api/schedule?week=2032-07-05&location=18&fast=1");
    assert.equal(f.state.data.shifts.length, 0, "The incomplete write response cannot substitute a canonical schedule");
    const shift = { id: 7, employee_number: "E1", shift_date: "2032-07-05", start_time: "09:00", counted_minutes: 450 };
    f.calls[1].resolve(f.schedule([shift])); await turn();
    assert.equal(f.renders.length, 1); assert.equal(f.renders[0].data.shifts[0], shift);
    assert.equal(f.state.allEmployees, roster); assert.equal(f.state.vacationData, vacation);
    assert.equal(f.calls.length, 3); assert.match(f.calls[2].url, /^\/api\/schedule\/enrichment\?/);
    f.calls[2].resolve({ ...f.schedule([shift]), enrichmentPending: false }); await pending;
    assert.equal(f.calls.length, 3); assert.equal(f.renders.length, 2);
  }
});

test("deleting refreshes only the selected week after a confirmed DELETE", async () => {
  const f = fixture("7"); f.state.data.shifts = [{ id: 7 }];
  const pending = f.context.deleteShift();
  assert.equal(f.calls[0].url, "/api/shifts/7"); assert.equal(f.calls[0].options.method, "DELETE");
  assert.equal(f.closed, 0); assert.equal(f.toasts.length, 0); assert.equal(f.state.data.shifts.length, 1);
  await f.context.deleteShift(); await f.context.saveShift(event); assert.equal(f.calls.length, 1); assert.equal(f.confirmations, 1);
  f.calls[0].resolve(null); await turn(); await resolveRefresh(f, []); await pending;
  assert.equal(f.calls.length, 3); assert.equal(f.state.data.shifts.length, 0); assert.equal(f.toasts[0].message, "Dienst wurde gelöscht.");
});

test("failed writes preserve the editable draft and permit an explicit retry without a success message", async () => {
  for (const action of ["saveShift", "deleteShift"]) {
    const f = fixture("7"), pending = f.context[action](event);
    f.calls[0].reject(new Error("Dienst ist inzwischen gesperrt")); await pending;
    assert.equal(f.closed, 0); assert.equal(f.elements.shiftModal.open, true); assert.equal(f.fields["#shiftNote"].value, "Entwurf");
    assert.equal(f.save.disabled, false); assert.deepEqual(f.toasts, [{ message: "Dienst ist inzwischen gesperrt", error: true }]);
    assert.equal(f.calls.length, 1);
    const retry = f.context[action](event); assert.equal(f.calls.length, 2);
    f.calls[1].reject(new Error("Weiterhin gesperrt")); await retry;
  }
});

test("a failed refresh reports that the write succeeded and never repeats the mutation", async () => {
  for (const action of ["saveShift", "deleteShift"]) {
    const f = fixture("7"), pending = f.context[action](event);
    f.calls[0].resolve({ id: 7 }); await turn();
    f.calls[1].reject(new Error("Plan vorübergehend nicht erreichbar")); await pending;
    assert.equal(f.closed, 1); assert.equal(f.calls.length, 2); assert.equal(f.toasts.length, 2);
    assert.equal(f.toasts[0].error, false); assert.equal(f.toasts[1].error, true);
    assert.match(f.toasts[1].message, /^Dienst (gespeichert|gelöscht)\. Die Ansicht konnte nicht aktualisiert werden:/);
  }
});

test("late write responses cannot navigate, close another editor, or publish success in a changed context", async () => {
  for (const action of ["saveShift", "deleteShift"]) for (const change of [
    f => { f.state.portalSession = { user: { id: "actor-b" } }; },
    f => { f.state.portalSession.user.id = "actor-b"; },
    f => { f.state.locationId = "05"; }, f => { f.state.departmentId = "2"; },
    f => { f.state.weekStart = "2032-07-12"; }, f => { f.state.currentView = "vacations"; },
    f => vm.runInContext("shiftEditorGeneration++", f.context),
  ]) {
    const f = fixture("7"), pending = f.context[action](event); change(f);
    const week = f.state.weekStart;
    f.calls[0].resolve({ id: 7 }); await pending;
    assert.equal(f.closed, 0); assert.equal(f.calls.length, 1); assert.equal(f.toasts.length, 0);
    assert.equal(f.state.weekStart, week); assert.equal(f.save.disabled, false);
  }
});

test("a post-write refresh supersedes an older weekly response", async () => {
  const f = fixture(), old = f.context.loadPlanningPeriod(), pending = f.context.saveShift(event);
  const older = f.calls[0]; f.calls[1].resolve({ id: 7 }); await turn();
  assert.equal(older.options.signal.aborted, true);
  older.resolve(f.schedule([{ id: "stale" }])); await old;
  assert.equal(f.renders.length, 0);
  await resolveRefresh(f, [{ id: 7 }]); await pending;
  assert.equal(f.renders.some(render => render.data.shifts.some(shift => shift.id === "stale")), false);
});

test("a second acknowledged mutation need not wait for the previous enrichment", async () => {
  const f = fixture(), first = f.context.saveShift(event);
  f.calls[0].resolve({ id: 7 }); await turn(); f.calls[1].resolve(f.schedule([{ id: 7 }])); await turn();
  const oldEnrichment = f.calls[2];
  f.elements.shiftModal.open = true; vm.runInContext("shiftEditorGeneration++", f.context);
  const second = f.context.saveShift(event); assert.equal(f.calls[3].options.method, "POST");
  f.calls[3].resolve({ id: 8 }); await turn();
  assert.equal(oldEnrichment.options.signal.aborted, true);
  oldEnrichment.resolve({ ...f.schedule([{ id: 7 }]), enrichmentPending: false }); await first;
  await resolveRefresh(f, [{ id: 7 }, { id: 8 }]); await second;
  assert.deepEqual(Array.from(f.state.data.shifts, shift => shift.id), [7, 8]);
});

test("locked planning cannot send a save or deletion", async () => {
  const f = fixture("7"); f.setLocked(true);
  await f.context.saveShift(event); await f.context.deleteShift();
  assert.equal(f.calls.length, 0); assert.equal(f.confirmations, 0);
});
