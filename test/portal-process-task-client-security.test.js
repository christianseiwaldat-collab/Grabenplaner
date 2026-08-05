const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const portalSource = fs.readFileSync(path.join(__dirname, "..", "public", "portal.js"), "utf8");

function between(startMarker, endMarker) {
  const start = portalSource.indexOf(startMarker);
  const end = portalSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Startmarker fehlt: ${startMarker}`);
  assert.notEqual(end, -1, `Endmarker fehlt: ${endMarker}`);
  return portalSource.slice(start, end);
}

const taskHelpers = between("function processTaskValue(", "function processTaskDateTime(");
const taskLoader = between("async function loadProcessTasks(", "async function completeProcessTask(");
const taskCompletion = between("async function completeProcessTask(", "function formatBytes(");

function processTaskState(user) {
  return {
    session: user ? { user } : null,
    activeTab: "processTasks",
    processTasks: [],
    processTaskSummary: null,
    processTasksLoading: false,
    processTasksLoadPromise: null,
    processTasksRequestGeneration: 0,
    processTasksOwnerFingerprint: "",
    processTasksAvailable: true,
    processTasksError: "",
    processTaskCompletionPending: new Set(),
    processTaskCompletionKeys: new Map(),
    processTaskCompletionPayloads: new Map(),
    processTaskNotes: new Map(),
    processTaskMessages: new Map(),
    processTaskRequestedRunId: "",
    processTaskRequestedStepId: "",
    processTaskFlash: "",
  };
}

function employee(employeeNumber, overrides = {}) {
  return {
    employeeNumber,
    accountType: "employee",
    isEmployee: true,
    role: "employee",
    homeLocationId: "L1",
    positionId: "P1",
    permissions: ["own_schedule:read"],
    scopes: [{ locationId: "L1", departmentId: "D1" }],
    ...overrides,
  };
}

test("M5-Task-Normalisierung behält nur die explizite UI-Allowlist", () => {
  const context = vm.createContext({
    input: {
      run_id: "run-1",
      activation_count: 2,
      process: { id: "process-1", title: "Inventur", symbol: "IV" },
      step: {
        id: "step-1",
        title: "Bestand prüfen",
        description: "Regal zählen",
        position: 2,
        condition: { text: "Nur bei Abweichung" },
      },
      progress: { total: 4 },
      scope: { label: "Filiale 1" },
      status: "open",
      created_at: "2026-08-03T08:00:00.000Z",
      due_at: "2026-08-04T08:00:00.000Z",
      can_complete: true,
      completion_note_required: true,
      personnelWorkflow: true,
      blocked: false,
      current: true,
      protectedPayload: { exitReason: "darf nie in den Client-State" },
      confidentialReceipt: "receipt-secret",
      employee: { privateEmail: "secret@example.invalid" },
    },
    summaryInput: { openCount: 3, activeRuns: 2, confidential: "must-not-survive" },
  });
  vm.runInContext(`${taskHelpers}\nresult = normalizeProcessTask(input); summaryResult = normalizeProcessTaskSummary(summaryInput);`, context);
  const result = JSON.parse(JSON.stringify(context.result));

  assert.deepEqual(Object.keys(result).sort(), [
    "activationCount",
    "assignedAt",
    "canComplete",
    "completionNoteRequired",
    "conditionText",
    "dueAt",
    "key",
    "personnelWorkflow",
    "position",
    "processId",
    "processSymbol",
    "processTitle",
    "runId",
    "scopeLabel",
    "status",
    "stepCount",
    "stepDescription",
    "stepId",
    "stepTitle",
  ]);
  assert.deepEqual(result, {
    runId: "run-1",
    stepId: "step-1",
    activationCount: 2,
    key: "run-1:2:step-1",
    processId: "process-1",
    processTitle: "Inventur",
    processSymbol: "IV",
    stepTitle: "Bestand prüfen",
    stepDescription: "Regal zählen",
    conditionText: "Nur bei Abweichung",
    scopeLabel: "Filiale 1",
    position: 2,
    stepCount: 4,
    status: "open",
    assignedAt: "2026-08-03T08:00:00.000Z",
    dueAt: "2026-08-04T08:00:00.000Z",
    canComplete: true,
    completionNoteRequired: true,
    personnelWorkflow: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.summaryResult)), { openCount: 3, activeRuns: 2 });
  assert.doesNotMatch(taskHelpers, /\.\.\.task\b/);
});

test("M5-Task-State wird vollständig bereinigt und invalidiert laufende Requests", () => {
  const user = employee("E-1");
  const state = processTaskState(user);
  Object.assign(state, {
    processTasks: [{ runId: "secret-run" }],
    processTaskSummary: { open: 1 },
    processTasksLoading: true,
    processTasksLoadPromise: Promise.resolve(),
    processTasksError: "secret-error",
    processTaskFlash: "secret-flash",
    processTaskRequestedRunId: "secret-run",
    processTaskRequestedStepId: "secret-step",
  });
  state.processTaskCompletionPending.add("secret-key");
  state.processTaskCompletionKeys.set("secret-key", "secret-operation");
  state.processTaskCompletionPayloads.set("secret-key", { note: "secret-note" });
  state.processTaskNotes.set("secret-key", "secret-note");
  state.processTaskMessages.set("secret-key", "secret-message");
  let requestClears = 0;
  let renders = 0;
  const context = vm.createContext({
    portalState: state,
    portalUser: () => state.session?.user || null,
    el: { refreshProcessTasks: { disabled: true } },
    clearProcessTaskRequest: () => { requestClears += 1; },
    renderProcessTasks: () => { renders += 1; },
  });
  vm.runInContext(taskHelpers, context);
  vm.runInContext("clearProcessTaskState({ resetAvailability: true, clearRequest: true });", context);

  assert.equal(state.processTasksRequestGeneration, 1);
  assert.equal(state.processTasks.length, 0);
  assert.equal(state.processTaskSummary, null);
  assert.equal(state.processTasksLoading, false);
  assert.equal(state.processTasksLoadPromise, null);
  assert.equal(state.processTasksError, "");
  assert.equal(state.processTaskFlash, "");
  assert.equal(state.processTaskRequestedRunId, "");
  assert.equal(state.processTaskRequestedStepId, "");
  assert.equal(state.processTaskCompletionPending.size, 0);
  assert.equal(state.processTaskCompletionKeys.size, 0);
  assert.equal(state.processTaskCompletionPayloads.size, 0);
  assert.equal(state.processTaskNotes.size, 0);
  assert.equal(state.processTaskMessages.size, 0);
  assert.equal(state.processTasksAvailable, true);
  assert.equal(context.el.refreshProcessTasks.disabled, false);
  assert.equal(requestClears, 1);
  assert.equal(renders, 1);
});

test("M5-Actor-Fingerprint ist reihenfolgestabil und erkennt Rechte- sowie Profilwechsel", () => {
  const state = processTaskState(null);
  const context = vm.createContext({
    portalState: state,
    portalUser: () => state.session?.user || null,
    clearProcessTaskRequest() {},
    renderProcessTasks() {},
  });
  vm.runInContext(taskHelpers, context);
  context.first = employee("E-1", {
    permissions: ["own_time:read", "own_schedule:read"],
    scopes: [
      { locationId: "L2", departmentId: "D2" },
      { locationId: "L1", departmentId: "D1" },
    ],
  });
  context.same = employee("E-1", {
    permissions: ["own_schedule:read", "own_time:read"],
    scopes: [
      { locationId: "L1", departmentId: "D1" },
      { locationId: "L2", departmentId: "D2" },
    ],
  });
  context.rightsLost = employee("E-1", { permissions: ["own_schedule:read"] });
  context.profileChanged = employee("E-1", {
    permissions: ["own_time:read", "own_schedule:read"],
    positionId: "P2",
  });

  const first = vm.runInContext("processTaskActorFingerprint(first)", context);
  assert.equal(vm.runInContext("processTaskActorFingerprint(same)", context), first);
  assert.notEqual(vm.runInContext("processTaskActorFingerprint(rightsLost)", context), first);
  assert.notEqual(vm.runInContext("processTaskActorFingerprint(profileChanged)", context), first);
});

test("verspätete M5-Task-Response kann nach Actorwechsel keinen State zurückschreiben", async () => {
  const firstUser = employee("E-1");
  const secondUser = employee("E-2", { homeLocationId: "L2", positionId: "P2" });
  const state = processTaskState(firstUser);
  let resolveResponse;
  const response = new Promise((resolve) => { resolveResponse = resolve; });
  let renders = 0;
  let requestClears = 0;
  const context = vm.createContext({
    portalState: state,
    portalUser: () => state.session?.user || null,
    portalTabAllowed: () => true,
    api: () => response,
    normalizeProcessTask: undefined,
    el: {
      refreshProcessTasks: { disabled: false },
      processTaskList: { setAttribute() {} },
      processTasksTab: { classList: { add() {}, toggle() {} } },
    },
    setTab() {},
    clearProcessTaskRequest: () => { requestClears += 1; },
    renderProcessTasks: () => { renders += 1; },
  });
  vm.runInContext(`${taskHelpers}\n${taskLoader}`, context);
  vm.runInContext("portalState.processTasksOwnerFingerprint = processTaskActorFingerprint(portalUser());", context);
  const pendingLoad = vm.runInContext("loadProcessTasks()", context);
  assert.equal(state.processTasksLoading, true);

  state.session = { user: secondUser };
  vm.runInContext(`
    clearProcessTaskState({ resetAvailability: true, clearRequest: true });
    portalState.processTasksOwnerFingerprint = processTaskActorFingerprint(portalUser());
  `, context);
  const rendersAfterSwitch = renders;
  resolveResponse({
    available: true,
    summary: { confidential: "must-not-survive" },
    tasks: [{
      runId: "stale-run",
      stepId: "stale-step",
      title: "Vertraulicher Alt-Task",
      protectedPayload: { exitReason: "secret" },
    }],
  });
  await pendingLoad;

  assert.equal(state.processTasks.length, 0);
  assert.equal(state.processTaskSummary, null);
  assert.equal(state.processTasksLoading, false);
  assert.equal(state.processTasksLoadPromise, null);
  assert.equal(state.processTasksOwnerFingerprint, vm.runInContext("processTaskActorFingerprint(portalUser())", context));
  assert.equal(renders, rendersAfterSwitch);
  assert.equal(requestClears, 1);
});

test("Auth-Rückfall, Actorwechsel, Rechteverlust und Completion nutzen dieselbe Invalidierungsgrenze", () => {
  const showLogin = between("function showLogin(", "function applySelfServiceVisibility(");
  const visibility = between("function applySelfServiceVisibility(", "function populateVacationAccountYears(");
  const showPortal = between("function showPortal(", "async function login(");
  const logout = between("async function logout(", "function setTab(");

  assert.match(showLogin, /portalState\.session = null/);
  assert.match(showLogin, /clearProcessTaskState\(\{ resetAvailability: true, clearRequest: hadProcessTaskOwner \}\)/);
  assert.match(showPortal, /previousProcessTaskOwner !== nextProcessTaskOwner/);
  assert.match(showPortal, /clearProcessTaskState\(\{/);
  assert.match(visibility, /if \(!portalTabAllowed\("processTasks"\)\) \{\s*clearProcessTaskState\(\{ clearRequest: true \}\)/);
  assert.match(logout, /portalState\.session = null/);
  assert.match(logout, /clearProcessTaskState\(\{ resetAvailability: true, clearRequest: hadProcessTaskOwner \}\)/);
  assert.ok((taskCompletion.match(/processTaskRequestContextCurrent\(requestGeneration, actorFingerprint\)/g) || []).length >= 4);
});
