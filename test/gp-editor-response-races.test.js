"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { functionSource } = require("../test-support/xoffi-import-ui");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function element(value = "") {
  const classes = new Set();
  return {
    value, checked: false, disabled: false, textContent: "", innerHTML: "", children: [],
    isConnected: true,
    classList: {
      add(...values) { values.forEach(item => classes.add(item)); },
      remove(...values) { values.forEach(item => classes.delete(item)); },
      contains(item) { return classes.has(item); },
      toggle(item, force = !classes.has(item)) {
        if (force) classes.add(item); else classes.delete(item);
        return force;
      },
    },
    focus() {}, setAttribute() {}, reset() {}, reportValidity: () => true,
    querySelectorAll: () => [],
    replaceChildren(...values) { this.children = values; },
    append(value) { this.children.push(value); },
  };
}

// Only the transport and the consumed DOM are synthetic. Production handlers
// and their capture/current helpers are evaluated directly from app.js.
function fixture(names) {
  let epoch = 1;
  const requests = [], calls = [], toasts = [], protectedFills = [];
  const controls = new Map();
  const control = id => {
    if (!controls.has(id)) controls.set(id, element());
    return controls.get(id);
  };
  const elements = new Proxy({}, {
    get(target, key) { return target[key] ||= control(String(key)); },
  });
  const rights = { cost: true, employee: true, sensitive: true, draft: true };
  const state = {
    portalStatus: { portalEnabled: true },
    portalSession: { authenticated: true, user: {
      employeeNumber: "SYN-A", accountId: "synthetic-account-A", sessionKind: "employee",
      isEmployee: true, role: "admin", active: true, mustChangePassword: false,
      permissions: ["employees:write", "personnel:sensitive:write"], scopes: [],
    } },
    currentView: "personnelAdministration", locations: [],
    editingCostCenterId: "SYN-COST-A", personnelAdministrationLoaded: true,
    customWorkRuleSimulationValid: false,
  };
  const document = {
    querySelector(selector) { assert.ok(selector.startsWith("#")); return control(selector.slice(1)); },
    querySelectorAll: () => [], createElement: () => element(),
  };
  const window = { GpWindow: {
    capture(dialog) { return { dialog, intent: dialog.intent, epoch }; },
    current(ticket, { allowClosed = false } = {}) {
      return ticket.epoch === epoch && ticket.intent === ticket.dialog.intent
        && (allowClosed || ticket.dialog.open);
    },
    captureContext() { return { epoch }; },
    currentContext(ticket) { return ticket.epoch === epoch; },
  } };
  let payload = { code: "SYN-RULE-A", title: "Synthetic draft A", threshold: 4 };
  const context = vm.createContext({
    state, elements, document, window,
    isLocalStartDashboardWorkspace: () => false,
    canWriteCostCenters: () => rights.cost,
    canEditEmployeeWindow: () => rights.employee,
    canWriteSensitivePersonnelRecord: () => rights.sensitive,
    canDraftCustomWorkRules: () => rights.draft,
    api(url, options) {
      const response = deferred();
      requests.push({ url, options, response });
      return response.promise;
    },
    loadPersonnelAdministration: async () => { calls.push("personnel reload"); },
    loadCustomWorkRuleRegistry: async () => { calls.push("rule reload"); },
    showToast: (message, error = false) => toasts.push({ message, error }),
    customWorkRulePayload: () => structuredClone(payload),
    normalizeProtectedPersonnelRecord: value => ({
      ...value, sensitive: { employment: { protectionStatus: null } },
    }),
    fillEmployeeProtectedRecord: value => protectedFills.push(value),
    fillEmployeeProtectionEditor: () => calls.push("protection editor filled"),
    setEmployeeProtectedRecordDisabled: value => { control("protectedDisabled").disabled = value; },
    toIsoDate: () => "2026-10-11", formatDate: value => value,
  });
  const helpers = ["startDashboardWorkspaceActorKey", "captureGpEditor", "gpEditorCurrent",
    "captureGpContext", "gpContextCurrent"];
  vm.runInContext([...new Set([...helpers, ...names])].map(functionSource).join("\n"), context);
  function dialog(id) {
    const node = control(id);
    node.intent = 0; node.open = false; node.closeCount = 0;
    node.showModal = () => { node.intent += 1; node.open = true; calls.push(`open:${id}`); };
    node.close = () => { node.open = false; node.closeCount += 1; };
    node.showModal();
    return node;
  }
  return {
    context, state, elements, rights, requests, calls, toasts, protectedFills, control, dialog,
    setPayload(value) { payload = structuredClone(value); },
    payload: () => structuredClone(payload),
    actor(value) { state.portalSession.user.accountId = value; },
    synchronize() { epoch += 1; },
    event: () => ({ preventDefault() {} }),
  };
}

function costFixture() {
  const h = fixture(["saveCostCenter"]);
  h.modal = h.dialog("costCenterModal");
  h.elements.costCenterCode.value = "SYN-A";
  h.elements.costCenterName.value = "Synthetic cost center A";
  h.elements.costCenterType.value = "SYN-TYPE";
  h.elements.costCenterDescription.value = "Synthetic description";
  h.elements.costCenterActive.checked = true;
  return h;
}

test("cost-center save closes its unchanged editor and reports success", async () => {
  const h = costFixture();
  const saving = h.context.saveCostCenter(h.event());
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/cost-centers/SYN-COST-A");
  assert.equal(JSON.parse(h.requests[0].options.body).name, "Synthetic cost center A");
  assert.equal(h.elements.costCenterSubmitButton.disabled, true);
  h.requests[0].response.resolve({});
  await saving;
  assert.equal(h.modal.closeCount, 1);
  assert.equal(h.state.personnelAdministrationLoaded, false);
  assert.equal(h.calls.filter(item => item === "personnel reload").length, 1);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.elements.costCenterSubmitButton.disabled, false);
});

for (const scenario of ["another cost center", "same cost center reopened", "another actor", "actor ABA"]) {
  test(`cost-center response cannot change ${scenario}`, async () => {
    const h = costFixture();
    const saving = h.context.saveCostCenter(h.event());
    if (scenario === "another cost center") {
      h.state.editingCostCenterId = "SYN-COST-B";
      h.elements.costCenterName.value = "Newer B draft";
      h.modal.showModal();
    } else if (scenario === "same cost center reopened") {
      h.modal.close(); h.modal.showModal();
      h.elements.costCenterName.value = "Newer A draft";
    } else if (scenario === "another actor") {
      h.actor("synthetic-account-B");
    } else {
      h.actor("synthetic-account-B"); h.synchronize(); h.actor("synthetic-account-A");
    }
    const closeCount = h.modal.closeCount;
    h.elements.costCenterSubmitButton.disabled = true;
    h.requests[0].response.resolve({});
    await saving;
    assert.equal(h.modal.open, true);
    assert.equal(h.modal.closeCount, closeCount);
    assert.equal(h.state.personnelAdministrationLoaded, true);
    assert.equal(h.calls.includes("personnel reload"), false);
    assert.equal(h.toasts.length, 0);
    assert.equal(h.elements.costCenterSubmitButton.disabled, true, "old finally must not enable newer editor");
  });
}

test("cost-center late failure does not publish an error into the reopened editor", async () => {
  const h = costFixture();
  const saving = h.context.saveCostCenter(h.event());
  h.modal.showModal();
  h.requests[0].response.reject(new Error("Synthetic old request failure"));
  await saving;
  assert.equal(h.toasts.length, 0);
  assert.equal(h.modal.open, true);
  assert.equal(h.elements.costCenterSubmitButton.disabled, true);
});

function protectedFixture() {
  const h = fixture(["loadEmployeeProtectedRecord"]);
  h.modal = h.dialog("employeeModal");
  h.control("employeeNumber").value = "SYN-17";
  return h;
}

test("protected employee load fills the current authorized employee", async () => {
  const h = protectedFixture();
  const loading = h.context.loadEmployeeProtectedRecord("SYN-17");
  assert.equal(h.control("protectedDisabled").disabled, true);
  h.requests[0].response.resolve({ profile: { phone: "SYN-PHONE" }, access: { phone: "write" } });
  await loading;
  assert.equal(h.state.employeePersonnelRecord.loaded, true);
  assert.equal(h.state.employeePersonnelRecord.employeeNumber, "SYN-17");
  assert.equal(h.protectedFills.length, 1);
  assert.equal(h.protectedFills[0].phone, "SYN-PHONE");
  assert.equal(h.control("protectedDisabled").disabled, false);
});

for (const scenario of ["same employee reopened", "actor changed", "sensitive right revoked"]) {
  test(`protected response is discarded after ${scenario}`, async () => {
    const h = protectedFixture();
    const loading = h.context.loadEmployeeProtectedRecord("SYN-17");
    if (scenario === "same employee reopened") { h.modal.close(); h.modal.showModal(); }
    if (scenario === "actor changed") h.actor("synthetic-account-B");
    if (scenario === "sensitive right revoked") h.rights.sensitive = false;
    const newer = { employeeNumber: "SYN-17", loaded: false, marker: "newer open" };
    h.state.employeePersonnelRecord = newer;
    h.elements.employeeProtectedRecordHint.textContent = "Newer loading state";
    h.requests[0].response.resolve({ profile: { phone: "OLD-SYN-PHONE" }, access: {} });
    await loading;
    assert.equal(h.state.employeePersonnelRecord, newer);
    assert.equal(h.protectedFills.length, 0);
    assert.equal(h.elements.employeeProtectedRecordHint.textContent, "Newer loading state");
    assert.equal(h.control("protectedDisabled").disabled, true);
  });
}

function saturdayFixture() {
  const h = fixture(["loadEmployeeSaturdayCredit"]);
  h.modal = h.dialog("employeeModal");
  h.control("employeeNumber").value = "SYN-17";
  return h;
}

const saturdayResult = () => ({
  cutoverDate: "2026-10-01", canAssign: true, canConfigure: true,
  assignment: { activity: "retail_sales" },
  history: [{ effectiveDate: "2026-10-01", activity: "retail_sales", reason: "Synthetic basis" }],
});

test("Saturday-credit load enables authorized controls and renders its history", async () => {
  const h = saturdayFixture();
  const loading = h.context.loadEmployeeSaturdayCredit({ personnel_number: "SYN-17" }, true);
  assert.equal(h.control("employeeSalesSave").disabled, true);
  h.requests[0].response.resolve(saturdayResult());
  await loading;
  assert.equal(h.state.employeeSaturdayCredit.employeeNumber, "SYN-17");
  assert.equal(h.control("employeeSalesActivity").value, "retail_sales");
  assert.equal(h.control("employeeSalesSave").disabled, false);
  assert.equal(h.control("employeeSalesHistory").children.length, 1);
});

test("Saturday-credit response cannot overwrite a newer opening of the same employee", async () => {
  const h = saturdayFixture();
  const loading = h.context.loadEmployeeSaturdayCredit({ personnel_number: "SYN-17" }, true);
  h.modal.close(); h.modal.showModal();
  const newer = { employeeNumber: "SYN-17", marker: "newer opening" };
  h.state.employeeSaturdayCredit = newer;
  h.control("employeeSalesReason").value = "Newer draft";
  h.control("employeeSaturdayCreditStatus").textContent = "Newer loading state";
  h.requests[0].response.resolve(saturdayResult());
  await loading;
  assert.equal(h.state.employeeSaturdayCredit, newer);
  assert.equal(h.control("employeeSalesReason").value, "Newer draft");
  assert.equal(h.control("employeeSaturdayCreditStatus").textContent, "Newer loading state");
  assert.equal(h.control("employeeSalesSave").disabled, true);
});

test("Saturday-credit late error from another actor is ignored", async () => {
  const h = saturdayFixture();
  const loading = h.context.loadEmployeeSaturdayCredit({ personnel_number: "SYN-17" }, true);
  h.actor("synthetic-account-B");
  h.control("employeeSaturdayCreditStatus").textContent = "Actor B state";
  h.requests[0].response.reject(new Error("Synthetic actor A failure"));
  await loading;
  assert.equal(h.control("employeeSaturdayCreditStatus").textContent, "Actor B state");
  assert.equal(h.state.employeeSaturdayCredit, null);
});

function ruleFixture() {
  const h = fixture(["simulateCustomWorkRuleDraft", "saveCustomWorkRule"]);
  h.modal = h.dialog("customWorkRuleModal");
  h.elements.customWorkRuleId.value = "SYN-RULE-A";
  return h;
}

test("a current simulation allows the submitted rule draft to be saved", async () => {
  const h = ruleFixture();
  const saving = h.context.saveCustomWorkRule(h.event());
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/work-rules/drafts/simulate");
  const submitted = JSON.parse(h.requests[0].options.body);
  h.requests[0].response.resolve({ simulation: { valid: true } });
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, "/api/work-rules/drafts/SYN-RULE-A/revisions");
  assert.deepEqual(JSON.parse(h.requests[1].options.body), submitted);
  h.requests[1].response.resolve({ draft: { id: "SYN-RULE-A" } });
  await saving;
  assert.equal(h.modal.closeCount, 1);
  assert.equal(h.state.selectedCustomWorkRuleId, "SYN-RULE-A");
  assert.equal(h.calls.filter(item => item === "rule reload").length, 1);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.elements.customWorkRuleSubmitButton.disabled, false);
});

for (const scenario of ["payload edited", "another draft opened", "actor changed"]) {
  test(`stale rule simulation cannot trigger a save after ${scenario}`, async () => {
    const h = ruleFixture();
    const saving = h.context.saveCustomWorkRule(h.event());
    if (scenario === "payload edited") h.setPayload({ ...h.payload(), threshold: 9 });
    if (scenario === "another draft opened") {
      h.elements.customWorkRuleId.value = "SYN-RULE-B";
      h.modal.showModal();
      h.setPayload({ ...h.payload(), title: "Synthetic draft B" });
    }
    if (scenario === "actor changed") h.actor("synthetic-account-B");
    h.requests[0].response.resolve({ simulation: { valid: true } });
    await saving;
    assert.equal(h.requests.length, 1, "old simulation must never authorize a follow-up POST");
    assert.equal(h.state.customWorkRuleSimulationValid, false);
    assert.equal(h.modal.open, true);
    assert.equal(h.toasts.length, 0);
  });
}

test("direct simulation result is discarded when its payload changes in flight", async () => {
  const h = ruleFixture();
  const simulation = h.context.simulateCustomWorkRuleDraft();
  h.setPayload({ ...h.payload(), title: "A newer unsimulated title" });
  h.requests[0].response.resolve({ simulation: { valid: true } });
  assert.equal(await simulation, false);
  assert.equal(h.state.customWorkRuleSimulationValid, false);
  assert.equal(h.toasts.length, 0);
});

test("GP context captures reject changed scope, rights, actor, session and ABA epoch", () => {
  for (const scenario of ["scope", "rights", "actor", "session", "epoch"]) {
    const h = fixture([]);
    let scope = "SYN-SCOPE-A";
    const ticket = h.context.captureGpContext(() => h.rights.cost, () => scope);
    assert.equal(h.context.gpContextCurrent(ticket), true);
    if (scenario === "scope") scope = "SYN-SCOPE-B";
    if (scenario === "rights") h.rights.cost = false;
    if (scenario === "actor") h.actor("synthetic-account-B");
    if (scenario === "session") h.state.portalSession = { ...h.state.portalSession };
    if (scenario === "epoch") { h.actor("synthetic-account-B"); h.synchronize(); h.actor("synthetic-account-A"); }
    assert.equal(h.context.gpContextCurrent(ticket), false, scenario);
  }
});

test("employee loaders start only after its new dialog intent and fields are installed", () => {
  const source = functionSource("openEmployeeModal");
  const opened = source.indexOf("elements.employeeModal.showModal()");
  assert.ok(opened >= 0);
  assert.ok(source.indexOf("loadEmployeeSaturdayCredit(") > opened);
  assert.ok(source.indexOf("loadEmployeeProtectedRecord(") > opened);
  const h = fixture(["openEmployeeModal"]);
  h.modal = h.dialog("employeeModal");
  h.context.canWriteCentralPersonnel = () => true;
  h.context.employeeCostCenterOptions = () => [];
  h.context.canManageWifiAutomationSettings = () => false;
  h.context.updateEmployeeAssignmentOptions = () => {};
  h.context.fixedWorkdays = () => [];
  h.context.renderEmployeeAccessProfile = () => {};
  h.context.updateColorPicker = () => {};
  h.context.syncEmployeeSicknessAllowanceField = () => {};
  const observed = [];
  const observe = name => {
    observed.push({ name, open: h.modal.open, intent: h.modal.intent,
      employeeNumber: h.control("employeeNumber").value });
  };
  h.context.loadEmployeeSaturdayCredit = () => observe("Saturday");
  h.context.loadEmployeeProtectedRecord = () => observe("Protected");
  const oldIntent = h.modal.intent;
  h.context.openEmployeeModal({ personnel_number: "SYN-NEW", full_name: "Synthetic person", nickname: "Synthetic" });
  assert.deepEqual(observed.map(item => item.name), ["Saturday", "Protected"]);
  for (const item of observed) {
    assert.equal(item.open, true);
    assert.equal(item.intent, oldIntent + 1);
    assert.equal(item.employeeNumber, "SYN-NEW");
  }
});

function lendingFixture() {
  const h=fixture(["loadEmployeeLendings","openEmployeeLendingModal"]);
  h.modal=h.dialog("employeeLendingModal");h.modal.close();
  h.state.locationId="SYN-L1";h.state.weekStart="2026-10-05";
  h.state.employeeLendingCandidates=[];h.state.employeeLendingLocations=[];
  h.context.URLSearchParams=URLSearchParams;
  h.context.canManageEmployeeLendings=()=>true;
  h.context.employeeLendingWeekEnd=()=>"2026-10-11";
  h.context.escapeHtml=value=>value;
  h.context.renderEmployeeLendingList=()=>h.calls.push("lending list");
  h.context.renderEmployeeLendingDelegates=()=>h.calls.push("lending delegates");
  const field=h.control("employeeLendingEmployee");field.name="employee";
  h.elements.employeeLendingForm.querySelectorAll=()=>[field];
  h.context.resetEmployeeLendingEditor=()=>{
    h.calls.push("lending reset");
    field.value=h.state.employeeLendingCandidates[0]?.employeeNumber || "";
    h.elements.employeeLendingDestination.value=h.state.employeeLendingLocations[0]?.id || "";
  };
  h.resolve=(offset=0)=>{
    h.requests[offset].response.resolve({assignments:[],candidates:[{employeeNumber:"SYN-GET-EMPLOYEE"}],locations:[{id:"SYN-GET-DESTINATION"}],departments:[]});
    h.requests[offset+1].response.resolve({delegates:[]});
  };
  return h;
}

test("initial lending opening refreshes candidates and destinations obtained only by GET",async()=>{
  const h=lendingFixture(),opening=h.context.openEmployeeLendingModal();
  assert.equal(h.calls.filter(item=>item==="lending reset").length,1);
  h.resolve();await opening;
  assert.equal(h.control("employeeLendingEmployee").value,"SYN-GET-EMPLOYEE");
  assert.equal(h.elements.employeeLendingDestination.value,"SYN-GET-DESTINATION");
  assert.equal(h.calls.filter(item=>item==="lending reset").length,2);
});

test("lending options load preserves a draft written after opening",async()=>{
  const h=lendingFixture(),opening=h.context.openEmployeeLendingModal();
  h.control("employeeLendingEmployee").value="SYN-NEW-DRAFT";
  h.resolve();await opening;
  assert.equal(h.control("employeeLendingEmployee").value,"SYN-NEW-DRAFT");
  assert.equal(h.calls.filter(item=>item==="lending reset").length,1);
});

for(const change of ["actor","week"])
test(`lending response cannot publish old options after ${change} changes`,async()=>{
  const h=lendingFixture(),opening=h.context.openEmployeeLendingModal();
  if(change==="actor")h.actor("synthetic-account-B");else h.state.weekStart="2026-10-12";
  h.resolve();await opening;
  assert.equal(h.state.employeeLendingCandidates.length,0);
  assert.equal(h.calls.filter(item=>item==="lending reset").length,1);
  assert.equal(h.calls.includes("lending list"),false);
});

test("older lending completion does not clear the latest request loading state",async()=>{
  const h=lendingFixture();h.modal.showModal();
  const first=h.context.loadEmployeeLendings(),second=h.context.loadEmployeeLendings();
  h.resolve();await first;
  assert.equal(h.state.employeeLendingLoading,true);
  assert.equal(h.elements.employeeLendingRefresh.disabled,true);
  h.resolve(2);await second;
  assert.equal(h.state.employeeLendingLoading,false);
  assert.equal(h.elements.employeeLendingRefresh.disabled,false);
});
