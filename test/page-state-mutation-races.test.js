"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Run the production handlers, with deferred requests and the small DOM surface
// they actually consume. No server, real accounts or production data are used.
function functionSource(name) {
  const candidates = [`function ${name}(`, `async function ${name}(`];
  const start = candidates.map((marker) => appSource.indexOf(marker)).filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), Infinity);
  assert.ok(Number.isFinite(start), `Production handler missing: ${name}`);
  const end = appSource.indexOf("\n}", start);
  assert.ok(end > start, `Production handler ending missing: ${name}`);
  return appSource.slice(start, end + 2);
}

function expose(context, names) {
  vm.runInNewContext(`${names.map(functionSource).join("\n")}\nglobalThis.handlers = {${names.join(",")}};`, context);
  return context.handlers;
}

function requestsFixture() {
  const requests = [];
  function api(url, options = {}) {
    return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  }
  function next(urlPart, method = "GET") {
    const request = requests.find((entry) => !entry.taken && entry.url.includes(urlPart)
      && (entry.options.method || "GET") === method);
    assert.ok(request, `Expected ${method} request containing ${urlPart}`);
    request.taken = true;
    return request;
  }
  return { api, requests, next };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
const token = (value) => value.repeat(64);

function configuration(title) {
  return {
    recipients: [{ id: "recipient", email: "synthetic@example.test", ccEmail: "", primaryDeliveryMode: "message",
      ccDeliveryMode: "message", replyToEmail: "", subjectTemplate: "", bodyTemplate: "" }],
    units: [{ id: "piece", title: "Stück" }],
    items: [{ id: "item", title, unitId: "piece", recipientId: "recipient" }],
    groups: [{ id: "group", title: "Synthetic group", hint: "", itemIds: ["item"] }],
  };
}

function settings(title, version = token("a")) {
  return { configuration: configuration(title), configurationVersion: version, emailDelivery: { attachmentsAvailable: true } };
}

function branchFixture() {
  const apiFixture = requestsFixture();
  let actor = "account-A";
  let permission = true;
  let field = null;
  const messages = [], toasts = [];
  let renders = 0;
  const state = {
    branchOrdersManagementLocationId: "A", branchOrdersManagementDraftLocationId: "A",
    branchOrdersManagement: null, branchOrdersManagementDraft: null, branchOrdersManagementBaseline: "",
    branchOrdersManagementHistory: [], branchOrdersManagementRequestId: 0, branchOrdersManagementLoading: false,
    branchOrdersManagementSaving: false, branchOrdersManagementSaveContext: null,
    branchOrdersManagementError: "", branchOrdersManagementCatalogEditingId: "item",
    branchOrdersManagementCatalogSearch: "Synthetic", branchOrdersManagementUnitEditingId: "piece",
    branchOrdersManagementCatalogSort: { key: "title", direction: "desc" },
    branchOrdersManagementUnitSort: { key: "title", direction: "asc" },
  };
  const context = {
    state, api: apiFixture.api, branchOrderViewStates: new Map(), branchOrderViewActor: actor,
    elements: { branchOrdersManagementWorkspace: { querySelectorAll: () => field ? [field] : [] } },
    window: { confirm: () => true },
    startDashboardWorkspaceActorKey: () => actor,
    canManageBranchOrders: () => permission,
    selectedBranchOrdersManagementLocationId: () => state.branchOrdersManagementLocationId,
    branchOrdersManagementClientId: () => "synthetic-unit",
    setBranchOrdersManagementMessage: (...args) => messages.push(args),
    showToast: (...args) => toasts.push(args),
    renderBranchOrdersManagement() {
      renders += 1;
      field = state.branchOrdersManagementDraft ? {
        value: state.branchOrdersManagementDraft.items[0]?.title || "",
        dataset: { branchOrdersManagementField: "catalog-item-title" },
        closest: (selector) => selector === "[data-branch-orders-management-catalog-item]"
          ? { dataset: { branchOrdersManagementCatalogItem: "item" } } : null,
      } : null;
    },
  };
  const handlers = expose(context, ["clonedBranchOrdersManagementConfiguration", "updateBranchOrdersManagementDraftFromField",
    "captureBranchOrdersManagementDraft", "rememberBranchOrderView", "loadBranchOrdersManagement", "saveBranchOrdersManagement"]);
  function seed(location, title, version = token("a")) {
    state.branchOrdersManagementLocationId = location;
    state.branchOrdersManagementDraftLocationId = location;
    state.branchOrdersManagement = settings(title, version);
    state.branchOrdersManagementDraft = handlers.clonedBranchOrdersManagementConfiguration(state.branchOrdersManagement.configuration);
    state.branchOrdersManagementBaseline = JSON.stringify(state.branchOrdersManagementDraft);
    context.renderBranchOrdersManagement();
  }
  function edit(title) {
    assert.ok(field, "A visible catalog editor must exist");
    field.value = title;
    handlers.updateBranchOrdersManagementDraftFromField(field);
  }
  function actorChange(nextActor, nextPermission = true) {
    // This is the invalidation performed by syncGpWindows on an actor/rights
    // change. Also start another operation to expose stale finally handlers.
    actor = nextActor;
    permission = nextPermission;
    context.branchOrderViewActor = actor;
    context.branchOrderViewStates.clear();
    state.branchOrdersManagementRequestId += 1;
    state.branchOrdersManagement = null;
    state.branchOrdersManagementDraft = null;
    state.branchOrdersManagementDraftLocationId = "";
    state.branchOrdersManagementBaseline = "";
    state.branchOrdersManagementHistory = [];
    state.branchOrdersManagementLoading = false;
    state.branchOrdersManagementSaving = false;
    state.branchOrdersManagementSaveContext = null;
    field = null;
  }
  function resolveLoad(location, result, orders = []) {
    apiFixture.next(`/settings?locationId=${location}`).resolve(result);
    apiFixture.next(`/history?locationId=${location}`).resolve({ orders });
  }
  seed("A", "A0");
  return { ...apiFixture, handlers, state, context, messages, toasts, seed, edit, actorChange, resolveLoad,
    renders: () => renders, revoke: () => { permission = false; } };
}

test("branch save keeps A2 entered after submitting A1, across an A→B→A navigation", async () => {
  const fixture = branchFixture();
  fixture.edit("A1");
  const saving = fixture.handlers.saveBranchOrdersManagement();
  const request = fixture.next("/branch-orders/settings", "PUT");
  assert.equal(JSON.parse(request.options.body).configuration.items[0].title, "A1");
  fixture.edit("A2");
  const loadingB = fixture.handlers.loadBranchOrdersManagement("B");
  fixture.resolveLoad("B", settings("B0", token("b")), [{ id: "history-B" }]);
  await loadingB;
  request.resolve(settings("A1", token("c")));
  await saving;
  assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "B0");
  assert.equal(fixture.state.branchOrdersManagementHistory[0].id, "history-B");
  const cachedA = fixture.context.branchOrderViewStates.get("A");
  assert.equal(cachedA.draft.items[0].title, "A2");
  assert.equal(JSON.parse(cachedA.baseline).items[0].title, "A1");
  assert.equal(cachedA.settings.configurationVersion, token("c"));
  assert.equal(cachedA.editing, "item");
  const loadingA = fixture.handlers.loadBranchOrdersManagement("A");
  assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "A2");
  fixture.resolveLoad("A", settings("A1", token("c")));
  await loadingA;
  assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "A2");
  const nextSave = fixture.handlers.saveBranchOrdersManagement();
  const nextRequest = fixture.next("/branch-orders/settings", "PUT");
  const body = JSON.parse(nextRequest.options.body);
  assert.equal(body.configuration.items[0].title, "A2");
  assert.equal(body.expectedVersion, token("c"));
  nextRequest.resolve(settings("A2", token("d")));
  await turn();
  fixture.next("/history?locationId=A").resolve({ orders: [] });
  await nextSave;
});

test("dirty branch refresh keeps the original CAS token and preserves the draft on conflict", async () => {
  const fixture = branchFixture();
  fixture.edit("A2");
  const loading = fixture.handlers.loadBranchOrdersManagement("A");
  fixture.resolveLoad("A", settings("Parallel edit", token("b")));
  await loading;
  assert.equal(fixture.state.branchOrdersManagement.configurationVersion, token("a"));
  assert.equal(fixture.state.branchOrdersManagement.configuration.items[0].title, "A0");
  assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "A2");
  assert.ok(fixture.messages.some(([message, error]) => error && /parallel/.test(message)));
  const saving = fixture.handlers.saveBranchOrdersManagement();
  const request = fixture.next("/branch-orders/settings", "PUT");
  assert.equal(JSON.parse(request.options.body).expectedVersion, token("a"));
  request.reject(Object.assign(new Error("Konfiguration parallel geändert"), { status: 409 }));
  await saving;
  assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "A2");
  assert.equal(fixture.state.branchOrdersManagement.configurationVersion, token("a"));
  assert.equal(fixture.state.branchOrdersManagementSaving, false);
  assert.equal(fixture.state.branchOrdersManagementSaveContext, null);
});

test("branch save retains later edits on the same branch while acknowledging only the submitted baseline", async () => {
  const fixture = branchFixture();
  fixture.edit("A1");
  const saving = fixture.handlers.saveBranchOrdersManagement();
  const request = fixture.next("/branch-orders/settings", "PUT");
  fixture.edit("A2");
  request.resolve(settings("A1", token("b")));
  await turn();
  fixture.next("/history?locationId=A").resolve({ orders: [] });
  await saving;
  assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "A2");
  assert.equal(JSON.parse(fixture.state.branchOrdersManagementBaseline).items[0].title, "A1");
  assert.equal(fixture.state.branchOrdersManagement.configurationVersion, token("b"));
  assert.ok(fixture.messages.some(([message]) => /Neuere Eingaben/.test(message)));
});

for (const outcome of ["success", "failure"]) {
  test(`old branch ${outcome} response after account change cannot disturb the new account's pending save`, async () => {
    const fixture = branchFixture();
    fixture.edit("A1");
    const oldSave = fixture.handlers.saveBranchOrdersManagement();
    const oldRequest = fixture.next("/branch-orders/settings", "PUT");
    fixture.actorChange("account-B");
    fixture.seed("B", "B0", token("b"));
    fixture.edit("B1");
    const newSave = fixture.handlers.saveBranchOrdersManagement();
    const newRequest = fixture.next("/branch-orders/settings", "PUT");
    const newContext = fixture.state.branchOrdersManagementSaveContext;
    const before = { messages: fixture.messages.length, toasts: fixture.toasts.length, renders: fixture.renders() };
    if (outcome === "success") oldRequest.resolve(settings("Old A", token("c")));
    else oldRequest.reject(Object.assign(new Error("Old account denied"), { status: 403 }));
    await oldSave;
    assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "B1");
    assert.equal(fixture.state.branchOrdersManagementSaveContext, newContext);
    assert.equal(fixture.state.branchOrdersManagementSaving, true);
    assert.equal(fixture.messages.length, before.messages);
    assert.equal(fixture.toasts.length, before.toasts);
    assert.equal(fixture.renders(), before.renders);
    assert.equal(fixture.context.branchOrderViewStates.has("A"), false);
    newRequest.resolve(settings("B1", token("d")));
    await turn();
    fixture.next("/history?locationId=B").resolve({ orders: [] });
    await newSave;
    assert.equal(fixture.state.branchOrdersManagementSaving, false);
  });

  test(`old branch load ${outcome} after rights change cannot clear the current account's draft or loading state`, async () => {
    const fixture = branchFixture();
    const oldLoad = fixture.handlers.loadBranchOrdersManagement("A");
    const oldSettings = fixture.next("/settings?locationId=A");
    const oldHistory = fixture.next("/history?locationId=A");
    fixture.actorChange("account-B:changed-rights");
    fixture.seed("B", "B0", token("b"));
    fixture.edit("B2");
    const newLoad = fixture.handlers.loadBranchOrdersManagement("B");
    const before = { renders: fixture.renders(), messages: fixture.messages.length };
    if (outcome === "success") oldSettings.resolve(settings("Old A", token("c")));
    else oldSettings.reject(Object.assign(new Error("Old forbidden request"), { status: 403 }));
    oldHistory.resolve({ orders: [{ id: "old-history" }] });
    await oldLoad;
    assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "B2");
    assert.equal(fixture.state.branchOrdersManagementLoading, true);
    assert.equal(fixture.state.branchOrdersManagementError, "");
    assert.equal(fixture.renders(), before.renders);
    assert.equal(fixture.messages.length, before.messages);
    fixture.resolveLoad("B", settings("B0", token("b")));
    await newLoad;
    assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "B2");
    assert.equal(fixture.state.branchOrdersManagementLoading, false);
  });
}

test("out-of-order branch loads cannot replace the selected branch's settings and history", async () => {
  const fixture = branchFixture();
  const loadA = fixture.handlers.loadBranchOrdersManagement("A");
  const loadB = fixture.handlers.loadBranchOrdersManagement("B");
  fixture.resolveLoad("B", settings("B0", token("b")), [{ id: "history-B" }]);
  await loadB;
  fixture.resolveLoad("A", settings("Old A", token("c")), [{ id: "history-A" }]);
  await loadA;
  assert.equal(fixture.state.branchOrdersManagementDraftLocationId, "B");
  assert.equal(fixture.state.branchOrdersManagementDraft.items[0].title, "B0");
  assert.equal(fixture.state.branchOrdersManagementHistory[0].id, "history-B");
});

function loanFixture() {
  const apiFixture = requestsFixture();
  let actor = "account-A";
  let permission = true;
  const toasts = [];
  let closed = 0, shown = 0, loads = 0;
  const state = { loanManagement: { loans: [] }, loanManagementReturnLoanId: "", loanManagementReturnContext: null,
    loanManagementReturnSaving: false, loanManagementReturnSavingContext: null };
  const condition = { value: "good" }, itemNote = { value: "Synthetic inspection" };
  const row = { dataset: { loanReturnPosition: "0" }, querySelector: (selector) => selector === "[data-loan-return-condition]" ? condition : itemNote };
  const elements = {
    loanManagementReturnTitle: { textContent: "" }, loanManagementReturnSubtitle: { textContent: "" },
    loanManagementReturnItems: { innerHTML: "", querySelectorAll: () => [row] },
    loanManagementReturnNote: { value: "" }, loanManagementReturnConfirmed: { checked: false, focus() {} },
    loanManagementReturnStatus: { textContent: "" }, loanManagementReturnSubmit: { disabled: false },
    loanManagementReturnDialog: { close: () => { closed += 1; }, showModal: () => { shown += 1; } },
  };
  const context = {
    state, elements, api: apiFixture.api,
    startDashboardWorkspaceActorKey: () => actor,
    canDirectlyReturnManagedLoan: () => permission,
    escapeHtml: (value) => String(value), loanConditionLabel: (value) => String(value),
    showToast: (...args) => toasts.push(args), loadLoanManagement: async () => { loads += 1; },
  };
  const handlers = expose(context, ["openLoanManagementReturn", "submitLoanManagementReturn"]);
  function open(id, revision) {
    state.loanManagement.loans = [{ id, revision, status: "issued", borrower: { employeeNumber: "SYNTHETIC" },
      location: { id: "TEST" }, items: [{ position: 0, articleNumber: "000000", description: "Synthetic item", conditionOut: "good" }] }];
    handlers.openLoanManagementReturn(id);
    elements.loanManagementReturnConfirmed.checked = true;
    elements.loanManagementReturnNote.value = "Synthetic return";
  }
  function actorChange(nextActor, nextPermission = true) {
    actor = nextActor;
    permission = nextPermission;
    state.loanManagementReturnContext = null;
    state.loanManagementReturnLoanId = "";
    state.loanManagementReturnSaving = false;
    state.loanManagementReturnSavingContext = null;
  }
  open("loan-A", 7);
  return { ...apiFixture, handlers, state, elements, toasts, open, actorChange,
    counts: () => ({ closed, shown, loads }), submit: () => handlers.submitLoanManagementReturn({ preventDefault() {} }) };
}

test("loan return submits the revision captured when the dialog opened, despite overview refresh", async () => {
  const fixture = loanFixture();
  fixture.state.loanManagement.loans[0].revision = 9;
  const submission = fixture.submit();
  const request = fixture.next("/loans/loan-A/return", "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    expectedRevision: 7, items: [{ position: 0, conditionReturn: "good", note: "Synthetic inspection" }], note: "Synthetic return",
  });
  request.reject(Object.assign(new Error("Leihe parallel geändert"), { status: 409 }));
  await submission;
  assert.equal(fixture.state.loanManagementReturnContext.revision, 7);
  assert.equal(fixture.state.loanManagementReturnLoanId, "loan-A");
  assert.equal(fixture.elements.loanManagementReturnNote.value, "Synthetic return");
  assert.equal(fixture.elements.loanManagementReturnSubmit.disabled, false);
  assert.equal(fixture.counts().closed, 0);
  assert.equal(fixture.elements.loanManagementReturnStatus.textContent, "Leihe parallel geändert");
});

for (const outcome of ["success", "failure"]) {
  test(`old loan return ${outcome} after account change cannot close or enable a new pending return`, async () => {
    const fixture = loanFixture();
    const oldSubmission = fixture.submit();
    const oldRequest = fixture.next("/loans/loan-A/return", "POST");
    fixture.actorChange("account-B");
    fixture.open("loan-B", 12);
    const newSubmission = fixture.submit();
    const newRequest = fixture.next("/loans/loan-B/return", "POST");
    const newContext = fixture.state.loanManagementReturnContext;
    const before = { counts: fixture.counts(), toasts: fixture.toasts.length, status: fixture.elements.loanManagementReturnStatus.textContent };
    if (outcome === "success") oldRequest.resolve({ direct: true, loan: { status: "returned" } });
    else oldRequest.reject(Object.assign(new Error("Old account forbidden"), { status: 403 }));
    await oldSubmission;
    assert.equal(fixture.state.loanManagementReturnLoanId, "loan-B");
    assert.equal(fixture.state.loanManagementReturnContext, newContext);
    assert.equal(fixture.state.loanManagementReturnSavingContext, newContext);
    assert.equal(fixture.state.loanManagementReturnSaving, true);
    assert.equal(fixture.elements.loanManagementReturnSubmit.disabled, true);
    assert.equal(fixture.elements.loanManagementReturnStatus.textContent, before.status);
    assert.equal(fixture.toasts.length, before.toasts);
    assert.deepEqual(fixture.counts(), before.counts);
    newRequest.resolve({ direct: true, loan: { status: "returned" } });
    await newSubmission;
    assert.equal(fixture.state.loanManagementReturnSaving, false);
    assert.deepEqual(fixture.counts(), { closed: 1, shown: 2, loads: 1 });
  });
}

test("loan return refuses a previously opened dialog after rights/account invalidation", async () => {
  const fixture = loanFixture();
  const oldContext = fixture.state.loanManagementReturnContext;
  fixture.actorChange("account-A:reduced-rights", false);
  // A stale form event can still arrive after the UI/session invalidation.
  fixture.state.loanManagementReturnContext = oldContext;
  fixture.state.loanManagementReturnLoanId = "loan-A";
  await fixture.submit();
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.counts().closed, 0);
});
