"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function functionSource(name) {
  const start = [`function ${name}(`, `async function ${name}(`]
    .map(marker => source.indexOf(marker)).filter(index => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), Infinity);
  assert.ok(Number.isFinite(start), `Production handler missing: ${name}`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `Production handler ending missing: ${name}`);
  return source.slice(start, end + 2);
}

function constantSource(name) {
  const start = source.indexOf(`const ${name} =`);
  const end = source.indexOf("\n]);", start);
  assert.ok(start >= 0 && end > start, `Production catalog missing: ${name}`);
  return source.slice(start, end + 4);
}

function classList() {
  const values = new Set();
  return {
    contains: value => values.has(value),
    toggle(value, force = !values.has(value)) {
      if (force) values.add(value); else values.delete(value);
      return force;
    },
  };
}

class FakeElement {
  constructor() {
    this.classList = classList();
    this.textContent = "";
    this.disabled = false;
    this.isConnected = true;
    this.focusCount = 0;
  }
  focus() { this.focusCount += 1; }
  replaceChildren() { this.innerHTML = ""; this.textContent = ""; }
}

function permissionContainer() {
  const element = new FakeElement();
  element.inputs = [];
  let markup = "";
  Object.defineProperty(element, "innerHTML", {
    get: () => markup,
    set(value) {
      markup = value;
      element.inputs = [...value.matchAll(/<input type="checkbox" ([^>]+)>/g)].map(([, attrs]) => {
        const label = { classList: classList(), querySelector: () => ({ textContent: "" }) };
        return {
          value: attrs.match(/value="([^"]+)"/)?.[1] || "",
          dataset: { rolePermission: attrs.match(/data-role-permission="([^"]+)"/)?.[1] || "false" },
          checked: /(?:^|\s)checked(?:\s|$)/.test(attrs),
          disabled: /(?:^|\s)disabled(?:\s|$)/.test(attrs),
          closest: () => label,
        };
      });
    },
  });
  element.querySelectorAll = selector => element.inputs.filter(input =>
    (!selector.includes(":not(:disabled)") || !input.disabled)
    && (!selector.includes(":checked") || input.checked));
  element.querySelector = selector => {
    const value = selector.match(/\[value="([^"]+)"\]/)?.[1];
    return element.querySelectorAll(selector).find(input => !value || input.value === value) || null;
  };
  element.replaceChildren = () => { element.innerHTML = ""; };
  return element;
}

function catalogEntry(id, options = {}) {
  return { id, label: id, group: "Synthetic rights", editable: true,
    eligibleRoles: ["employee", "department_manager"], ...options };
}

function user(number = "SYN-17", options = {}) {
  return {
    employeeNumber: number, fullName: `Synthetic ${number}`, nickname: `Example ${number}`,
    role: "employee", roleName: "Mitarbeiter", manageable: true, configured: true,
    homeLocationId: "branch-A", preferredDepartmentId: 7,
    rolePermissions: ["loans:self:use"], grantedPermissions: [], deniedPermissions: [],
    scopes: [{ locationId: "branch-A", departmentId: 7 }], ...options,
  };
}

// Execute the actual app functions and close listener. Only the consumed DOM
// surface and transport are synthetic; deferred ACKs expose lifecycle races.
function fixture(options = {}) {
  const requests = [], toasts = [];
  const state = {
    portalStatus: { portalEnabled: true },
    portalSession: { authenticated: true, user: { employeeNumber: "SYN-admin", accountId: "synthetic-A",
      role: options.actorRole || "admin", sessionKind: "employee", isEmployee: true,
      active: true, mustChangePassword: false, permissions: ["rights:read"], scopes: [] } },
    locations: [{ id: "branch-A", name: "Example branch", departments: [{ id: 7, name: "Example team" }] }],
    rightsManagement: {
      users: options.users || [user(), user("SYN-18")],
      catalog: options.catalog || [catalogEntry("loans:self:use"), catalogEntry("extra:synthetic", { scopeBehavior: "global" })],
    },
    selectedRightsEmployeeNumber: null,
    personnelFieldRightsDirtyRoles: new Set(), personnelFieldRightsDrafts: {},
  };
  const scopeInputs = ["department", "location"].map(value => ({ value, checked: false, disabled: false }));
  const modal = new FakeElement();
  modal.open = false;
  modal.closeCount = 0;
  const listeners = new Map();
  modal.addEventListener = (type, listener) => listeners.set(type, listener);
  modal.close = () => {
    modal.open = false;
    modal.closeCount += 1;
    listeners.get("close")?.();
  };
  const elements = Object.fromEntries([
    "rightsSettings", "rightsEditorTitle", "rightsEditorSummary", "rightsEditorScope", "rightsEditorScopeHint",
    "rightsEditorDepartmentScopeLabel", "rightsEditorLocationScopeLabel", "rightsEditorAnnouncement",
    "rightsEditorHint", "saveRightsEditorButton", "rightsManagementHint", "rightsUserList",
    "mobileLeadershipModuleSettings", "personnelFieldRightsMatrix", "personnelFieldRightsSettingsAccess", "mobileLeadershipSettingsCard",
  ].map(name => [name, new FakeElement()]));
  elements.rightsEditorModal = modal;
  elements.rightsEditorPermissions = permissionContainer();
  // The table belongs to RightsManagementWorkspace. A failed load may change
  // its rows through render(), but must never destroy the table DOM outright.
  const tableSurface = { header: {}, body: {}, rows: [] };
  elements.rightsUserList.tableSurface = tableSurface;
  let listHtmlWrites = 0, listMarkup = "synthetic owned table";
  Object.defineProperty(elements.rightsUserList, "innerHTML", {
    get: () => listMarkup,
    set(value) { listHtmlWrites += 1; listMarkup = value; elements.rightsUserList.tableSurface = null; },
  });
  elements.rightsEditorForm = {
    querySelectorAll: () => scopeInputs,
    querySelector(selector) {
      const value = selector.match(/\[value="([^"]+)"\]/)?.[1];
      return scopeInputs.find(input => (!value || value === input.value)
        && (!selector.includes(":checked") || input.checked)) || null;
    },
  };
  const opener = new FakeElement();
  let rosterRenders = 0, mobileRenders = 0, fieldRenders = 0;
  const workspacePayloads = [];
  const context = {
    state, elements, AbortController, HTMLElement: FakeElement,
    document: { activeElement: opener, getElementById: id => elements[id] || null },
    window: { requestAnimationFrame: callback => callback() },
    gpWindowManager: null,
    rightsWorkspace: {
      showProfile: async () => { modal.open = true; },
      render(payload) {
        rosterRenders += 1;
        workspacePayloads.push(payload);
        tableSurface.rows = payload.users;
      },
    },
    rightsWorkspaceActor: "", rightsLoadController: null, rightsLoadGeneration: 0,
    rightsEditorGeneration: 0, rightsEditorSaveContext: null, rightsEditorSnapshot: null,
    rightsSettingsWindows: null, mobileLeadershipSettingsTable: null, personnelFieldRightsTable: null,
    mobileLeadershipSettingsTableActor: "", personnelFieldRightsTableActor: "", mobileLeadershipSettingsTableShape: "",
    escapeHtml: value => String(value),
    showToast: (...args) => toasts.push(args),
    renderMobileLeadershipSettings: () => { mobileRenders += 1; },
    renderPersonnelFieldRights: () => { fieldRenders += 1; },
    permissionDefaultsUI: { load: async () => {} },
    api(url, requestOptions = {}) {
      return new Promise((resolve, reject) => requests.push({ url, options: requestOptions, resolve, reject }));
    },
  };
  context.syncGpWindows = () => context.handlers.syncRightsWorkspace();
  const names = ["isLocalStartDashboardWorkspace", "startDashboardWorkspaceActorKey", "canUseRightsWorkspace",
    "rightsWorkspaceActorKey", "syncRightsWorkspace", "resetRightsSettingsCardState", "renderRightsManagement", "selectedRightsEditorUser", "rightsEditorEffectivePermissionSet",
    "rightsEditorPermissionIsOrganizational", "rightsEditorAnnounce", "updateRightsEditorPermissionStatus",
    "rightsEditorDependencyApplies", "rightsEditorScopeContext", "rightsEditorHasOrganizationalPermissions",
    "rightsEditorSelectedScope", "refreshRightsEditorSaveState", "refreshRightsEditorScope",
    "enforceRightsEditorPermissionDependencies", "permissionEligibleForRole", "lifecycleRightsDependency",
    "openRightsEditor", "loadRightsManagement", "rightsEditorDraftSignature", "saveUserRights"];
  const closeStart = source.indexOf('elements.rightsEditorModal?.addEventListener("close",');
  const closeEnd = source.indexOf('\nelements.rightsEditorForm?.addEventListener("submit"', closeStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart, "Production close listener missing");
  vm.runInNewContext(`${names.map(functionSource).join("\n")}\n${constantSource("permissionDependencyRules")}
    ${constantSource("rightsEditorOrganizationalPermissionIds")}
    ${source.slice(closeStart, closeEnd)}\nglobalThis.handlers = {${names.join(",")}};`, context);
  context.handlers.syncRightsWorkspace();
  const input = id => {
    const result = elements.rightsEditorPermissions.inputs.find(entry => entry.value === id);
    assert.ok(result, `Expected visible permission ${id}`);
    return result;
  };
  function next(urlPart, method = "GET") {
    const request = requests.find(entry => !entry.taken && entry.url.includes(urlPart)
      && (entry.options.method || "GET") === method);
    assert.ok(request, `Expected ${method} ${urlPart}`);
    request.taken = true;
    return request;
  }
  function actorChange(overrides = {}) {
    state.portalSession.user = { ...state.portalSession.user, accountId: "synthetic-B", ...overrides };
    context.handlers.syncRightsWorkspace();
  }
  function resolveLoad(result) {
    next("/api/portal/v1/rights").resolve(result);
    if (state.portalSession.user.role !== "manager") {
      next("/mobile-layout").resolve({ availableModules: [], layouts: {}, canChange: true });
      next("/personnel-field-rights").resolve({ roles: [], fields: [], canChange: true });
    }
  }
  function rejectLoad(error) {
    next("/api/portal/v1/rights").reject(error);
    if (state.portalSession.user.role !== "manager") {
      next("/mobile-layout").resolve({ availableModules: [], layouts: {}, canChange: true });
      next("/personnel-field-rights").resolve({ roles: [], fields: [], canChange: true });
    }
  }
  const event = { preventDefault() {} };
  return { state, context, elements, requests, next, input, scopeInputs, toasts, actorChange, resolveLoad, rejectLoad,
    handlers: context.handlers, open: number => context.handlers.openRightsEditor(number || "SYN-17"),
    save: () => context.handlers.saveUserRights(event),
    renders: () => ({ roster: rosterRenders, mobile: mobileRenders, fields: fieldRenders }),
    tableSurface, workspacePayloads, listHtmlWrites: () => listHtmlWrites,
  };
}

const copy = value => JSON.parse(JSON.stringify(value));

test("rights pending double submit sends one PUT and unchanged ACK closes exactly once", async () => {
  const f = fixture(); f.open();
  const saving = f.save();
  const request = f.next("/rights/SYN-17", "PUT");
  await f.save();
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.saveRightsEditorButton.disabled, true);
  request.resolve(copy(f.state.rightsManagement));
  await saving;
  assert.equal(f.elements.rightsEditorModal.closeCount, 1);
  assert.equal(f.context.rightsEditorSaveContext, null);
  assert.equal(f.context.rightsEditorSnapshot, null);
  assert.equal(f.toasts.length, 1);
});

test("rights checkbox edits made during save remain in the open editor after ACK", async () => {
  const f = fixture(); f.open();
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  assert.deepEqual(JSON.parse(request.options.body).grantedPermissions, []);
  f.input("extra:synthetic").checked = true;
  request.resolve(copy(f.state.rightsManagement)); await saving;
  assert.equal(f.input("extra:synthetic").checked, true);
  assert.equal(f.elements.rightsEditorModal.open, true);
  assert.equal(f.elements.rightsEditorModal.closeCount, 0);
  assert.equal(f.elements.saveRightsEditorButton.disabled, false);
  assert.match(f.toasts[0][0], /Nachträgliche Eingaben/);
  const second = f.save(), secondRequest = f.next("/rights/SYN-17", "PUT");
  assert.deepEqual(JSON.parse(secondRequest.options.body).grantedPermissions, ["extra:synthetic"]);
  secondRequest.resolve(copy(f.state.rightsManagement)); await second;
  assert.equal(f.elements.rightsEditorModal.open, false);
});

test("rights scope edits made during save retain the later branch choice", async () => {
  const f = fixture({ catalog: [catalogEntry("schedule:read", { scopeBehavior: "organizational" })],
    users: [user("SYN-17", { rolePermissions: ["schedule:read"] })] });
  f.open();
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  assert.deepEqual(JSON.parse(request.options.body).scopes, [{ locationId: "branch-A", departmentId: 7 }]);
  f.scopeInputs[0].checked = false; f.scopeInputs[1].checked = true;
  request.resolve(copy(f.state.rightsManagement)); await saving;
  assert.equal(f.elements.rightsEditorModal.open, true);
  assert.equal(f.scopeInputs[1].checked, true);
  assert.deepEqual(copy(f.handlers.rightsEditorSelectedScope()), [{ locationId: "branch-A", departmentId: null }]);
});

test("rights late ACK after closing does not reopen or replace the roster", async () => {
  const f = fixture(); f.open();
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  const before = f.state.rightsManagement;
  f.elements.rightsEditorModal.close();
  request.resolve({ users: [user("SYN-stale")], catalog: [] }); await saving;
  assert.strictEqual(f.state.rightsManagement, before);
  assert.equal(f.elements.rightsEditorModal.open, false);
  assert.equal(f.elements.rightsEditorModal.closeCount, 1);
  assert.equal(f.renders().roster, 0);
  assert.equal(f.toasts.length, 0);
});

test("rights previous profile ACK leaves another reopened profile and its edits untouched", async () => {
  const f = fixture(); f.open();
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  f.elements.rightsEditorModal.close(); f.open("SYN-18");
  f.input("extra:synthetic").checked = true;
  const signature = f.handlers.rightsEditorDraftSignature(), roster = f.state.rightsManagement;
  request.resolve({ users: [user("SYN-stale")], catalog: [] }); await saving;
  assert.equal(f.state.selectedRightsEmployeeNumber, "SYN-18");
  assert.equal(f.handlers.selectedRightsEditorUser().employeeNumber, "SYN-18");
  assert.equal(f.handlers.rightsEditorDraftSignature(), signature);
  assert.strictEqual(f.state.rightsManagement, roster);
  assert.equal(f.elements.rightsEditorModal.open, true);
  assert.equal(f.elements.rightsEditorModal.closeCount, 1);
  assert.equal(f.elements.saveRightsEditorButton.disabled, false);
  assert.equal(f.toasts.length, 0);
});

test("rights reopening the same profile invalidates the earlier save generation", async () => {
  const f = fixture(); f.open();
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  f.elements.rightsEditorModal.close(); f.open();
  const generation = f.context.rightsEditorGeneration;
  request.resolve({ users: [user("SYN-stale")], catalog: [] }); await saving;
  assert.equal(f.context.rightsEditorGeneration, generation);
  assert.equal(f.elements.rightsEditorModal.open, true);
  assert.equal(f.toasts.length, 0);
});

test("rights old actor PUT ACK cannot replace a new actor roster or unlock its pending save", async () => {
  const f = fixture(); f.open();
  const firstSaving = f.save(), first = f.next("/rights/SYN-17", "PUT");
  f.actorChange();
  assert.equal(first.options.signal.aborted, true);
  assert.equal(f.context.rightsEditorSnapshot, null);
  assert.equal(f.state.rightsManagement, null);
  f.state.rightsManagement = { users: [user("SYN-18")], catalog: [catalogEntry("loans:self:use")] };
  f.open("SYN-18");
  const secondSaving = f.save(), second = f.next("/rights/SYN-18", "PUT");
  const secondContext = f.context.rightsEditorSaveContext, newRoster = f.state.rightsManagement;
  first.resolve({ users: [user("SYN-stale")], catalog: [] }); await firstSaving;
  assert.strictEqual(f.context.rightsEditorSaveContext, secondContext);
  assert.strictEqual(f.state.rightsManagement, newRoster);
  assert.equal(f.elements.rightsEditorModal.open, true);
  assert.equal(f.elements.saveRightsEditorButton.disabled, true);
  assert.equal(f.toasts.length, 0);
  second.resolve(copy(newRoster)); await secondSaving;
  assert.equal(f.elements.rightsEditorModal.open, false);
});

test("rights old actor errors are silent and do not change a new actor profile", async () => {
  const f = fixture(); f.open();
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  f.actorChange();
  f.state.rightsManagement = { users: [user("SYN-18")], catalog: [catalogEntry("loans:self:use")] };
  f.open("SYN-18");
  request.reject(Object.assign(new Error("Old actor denied"), { status: 403 })); await saving;
  assert.equal(f.handlers.selectedRightsEditorUser().employeeNumber, "SYN-18");
  assert.equal(f.elements.rightsEditorModal.open, true);
  assert.equal(f.toasts.length, 0);
});

test("rights opening snapshots target user and catalog across a successful roster refresh", async () => {
  const originalUser = user("SYN-17", { deniedPermissions: ["old:explicit"] });
  const f = fixture({ users: [originalUser], catalog: [catalogEntry("loans:self:use"),
    catalogEntry("extra:synthetic"), catalogEntry("old:explicit")] });
  f.open();
  originalUser.manageable = false;
  f.state.rightsManagement.catalog[1].eligibleRoles = ["developer"];
  const loading = f.handlers.loadRightsManagement();
  f.resolveLoad({ users: [user("SYN-17", { manageable: false, role: "developer" })], catalog: [] });
  await loading;
  assert.equal(f.handlers.selectedRightsEditorUser().manageable, true);
  assert.equal(f.handlers.selectedRightsEditorUser().role, "employee");
  assert.equal(f.context.rightsEditorSnapshot.catalog[1].eligibleRoles[0], "employee");
  f.input("extra:synthetic").checked = true;
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.grantedPermissions, ["extra:synthetic"]);
  assert.deepEqual(body.deniedPermissions, ["old:explicit"]);
  request.resolve(copy(f.state.rightsManagement)); await saving;
});

test("rights late roster load cannot overwrite a successful personal rights save", async () => {
  const f = fixture(), earlierRoster = copy(f.state.rightsManagement);
  const loading = f.handlers.loadRightsManagement();
  f.open(); f.input("extra:synthetic").checked = true;
  const saving = f.save(), savedRoster = copy(earlierRoster);
  savedRoster.users[0].grantedPermissions = ["extra:synthetic"];
  f.next("/rights/SYN-17", "PUT").resolve(savedRoster); await saving;
  f.resolveLoad(earlierRoster); await loading;
  assert.strictEqual(f.state.rightsManagement, savedRoster);
  assert.strictEqual(f.tableSurface.rows, savedRoster.users);
  f.open();
  assert.equal(f.input("extra:synthetic").checked, true);
});

test("rights serialize added rights, base denials, retained explicit denials and original scope separately", async () => {
  const f = fixture({ catalog: [catalogEntry("base:keep"), catalogEntry("base:deny"), catalogEntry("extra:grant"),
    catalogEntry("old:deny"), catalogEntry("locked:extra", { editable: false }),
    catalogEntry("foreign:role", { eligibleRoles: ["hr"] })],
    users: [user("SYN-17", { rolePermissions: ["base:keep", "base:deny"], deniedPermissions: ["old:deny"] })] });
  f.open();
  f.input("base:deny").checked = false;
  f.input("extra:grant").checked = true;
  f.input("locked:extra").checked = true;
  f.input("foreign:role").checked = true;
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  assert.deepEqual(JSON.parse(request.options.body), {
    grantedPermissions: ["extra:grant"], deniedPermissions: ["base:deny", "old:deny"],
    scopes: [{ locationId: "branch-A", departmentId: 7 }],
  });
  request.resolve(copy(f.state.rightsManagement)); await saving;
});

test("rights checking a historical explicit denial intentionally restores that right", async () => {
  const f = fixture({ catalog: [catalogEntry("old:deny")],
    users: [user("SYN-17", { rolePermissions: [], deniedPermissions: ["old:deny"] })] });
  f.open(); f.input("old:deny").checked = true;
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  assert.deepEqual(JSON.parse(request.options.body).grantedPermissions, ["old:deny"]);
  assert.deepEqual(JSON.parse(request.options.body).deniedPermissions, []);
  request.resolve(copy(f.state.rightsManagement)); await saving;
});

test("rights manager denial-only save does not send scopes or broaden other employee rights", async () => {
  const f = fixture({ actorRole: "manager", catalog: [catalogEntry("loans:self:use"), catalogEntry("extra:synthetic")],
    users: [user("SYN-17", { grantedPermissions: ["extra:synthetic"] })] });
  f.open();
  assert.deepEqual(f.elements.rightsEditorPermissions.inputs.map(entry => entry.value), ["loans:self:use"]);
  assert.equal(f.elements.rightsEditorScope.classList.contains("hidden"), true);
  f.input("loans:self:use").checked = false;
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  assert.deepEqual(JSON.parse(request.options.body), { grantedPermissions: [], deniedPermissions: ["loans:self:use"] });
  request.resolve(copy(f.state.rightsManagement)); await saving;
});

test("rights protected or unmanageable target cannot send PUT, even from programmatic submit", async () => {
  const f = fixture({ users: [user("SYN-17", { role: "developer", manageable: false })] });
  f.open();
  assert.ok(f.elements.rightsEditorPermissions.inputs.every(entry => entry.disabled));
  assert.equal(f.elements.saveRightsEditorButton.disabled, true);
  await f.save();
  assert.equal(f.requests.length, 0);
});

test("rights invalid organizational scope prevents PUT and announces the missing scope", async () => {
  const f = fixture({ catalog: [catalogEntry("schedule:read", { scopeBehavior: "organizational" })],
    users: [user("SYN-17", { homeLocationId: "", scopes: [], preferredDepartmentId: null,
      rolePermissions: ["schedule:read"] })] });
  f.open();
  assert.equal(f.elements.saveRightsEditorButton.disabled, true);
  await f.save();
  assert.equal(f.requests.length, 0);
  assert.match(f.elements.rightsEditorAnnouncement.textContent, /gültigen Verantwortungsbereich/);
});

test("rights active-profile request failure retains edited inputs and permits retry", async () => {
  const f = fixture(); f.open(); f.input("extra:synthetic").checked = true;
  const signature = f.handlers.rightsEditorDraftSignature();
  const saving = f.save(), request = f.next("/rights/SYN-17", "PUT");
  request.reject(new Error("Synthetic connection interrupted")); await saving;
  assert.equal(f.handlers.rightsEditorDraftSignature(), signature);
  assert.equal(f.elements.rightsEditorModal.open, true);
  assert.equal(f.elements.saveRightsEditorButton.disabled, false);
  assert.deepEqual(f.toasts, [["Synthetic connection interrupted", true]]);
});

test("rights overlapping loads retain only the latest response and cancel the old transport", async () => {
  const f = fixture();
  const firstLoading = f.handlers.loadRightsManagement();
  const first = [f.next("/api/portal/v1/rights"), f.next("/mobile-layout"), f.next("/personnel-field-rights")];
  const secondLoading = f.handlers.loadRightsManagement();
  assert.ok(first.every(request => request.options.signal.aborted));
  const latest = { users: [user("SYN-new")], catalog: [] };
  f.resolveLoad(latest); await secondLoading;
  first[0].resolve({ users: [user("SYN-old")], catalog: [] });
  first[1].resolve({ old: true }); first[2].resolve({ old: true }); await firstLoading;
  assert.strictEqual(f.state.rightsManagement, latest);
  assert.deepEqual(f.renders(), { roster: 1, mobile: 1, fields: 1 });
});

test("rights old actor roster responses cannot repopulate protected UI", async () => {
  const f = fixture();
  const loading = f.handlers.loadRightsManagement();
  const requests = [f.next("/api/portal/v1/rights"), f.next("/mobile-layout"), f.next("/personnel-field-rights")];
  f.actorChange();
  assert.ok(requests.every(request => request.options.signal.aborted));
  requests[0].resolve({ users: [user("SYN-old")], catalog: [] });
  requests[1].resolve({}); requests[2].resolve({}); await loading;
  assert.equal(f.state.rightsManagement, null);
  assert.equal(f.renders().roster, 0);
});

test("rights temporary load failure and subsequent success preserve the workspace-owned table", async () => {
  const f = fixture(); f.open();
  const originalTable = f.elements.rightsUserList.tableSurface;
  const originalHeader = originalTable.header, originalBody = originalTable.body;
  const originalSnapshot = f.context.rightsEditorSnapshot;
  const failedLoad = f.handlers.loadRightsManagement();
  f.rejectLoad(Object.assign(new Error("Synthetic network unavailable"), { status: 503 }));
  await failedLoad;
  assert.strictEqual(f.elements.rightsUserList.tableSurface, originalTable);
  assert.strictEqual(f.tableSurface.header, originalHeader);
  assert.strictEqual(f.tableSurface.body, originalBody);
  assert.equal(f.listHtmlWrites(), 0);
  assert.equal(f.workspacePayloads.length, 1);
  assert.deepEqual(copy(f.workspacePayloads[0].users), []);
  assert.match(f.elements.rightsManagementHint.textContent, /Synthetic network unavailable/);
  assert.strictEqual(f.context.rightsEditorSnapshot, originalSnapshot);
  assert.equal(f.elements.rightsEditorModal.open, true);

  const retry = f.handlers.loadRightsManagement();
  const currentRoster = { users: [user("SYN-retry")], catalog: [] };
  f.resolveLoad(currentRoster); await retry;
  assert.strictEqual(f.elements.rightsUserList.tableSurface, originalTable);
  assert.strictEqual(f.tableSurface.header, originalHeader);
  assert.strictEqual(f.tableSurface.body, originalBody);
  assert.equal(f.listHtmlWrites(), 0);
  assert.equal(f.workspacePayloads.length, 2);
  assert.strictEqual(f.tableSurface.rows, currentRoster.users);
  assert.strictEqual(f.context.rightsEditorSnapshot, originalSnapshot);
  assert.equal(f.elements.rightsEditorModal.open, true);
});

for (const status of [401, 403]) {
  test(`rights ${status} load response purges profile content, closes it and prevents saving`, async () => {
    const f = fixture(); f.open();
    assert.ok(f.context.rightsEditorSnapshot);
    assert.ok(f.elements.rightsEditorPermissions.inputs.length);
    const loading = f.handlers.loadRightsManagement();
    f.rejectLoad(Object.assign(new Error(`Synthetic ${status}`), { status }));
    await loading;
    assert.equal(f.state.rightsManagement, null);
    assert.equal(f.context.rightsEditorSnapshot, null);
    assert.equal(f.state.selectedRightsEmployeeNumber, null);
    assert.equal(f.elements.rightsEditorModal.open, false);
    assert.equal(f.elements.rightsEditorModal.closeCount, 1);
    assert.equal(f.elements.rightsEditorPermissions.inputs.length, 0);
    assert.equal(f.elements.rightsEditorPermissions.innerHTML, "");
    assert.equal(f.elements.rightsEditorTitle.textContent, "Rechte bearbeiten");
    assert.equal(f.elements.rightsEditorSummary.textContent, "");
    assert.equal(f.elements.saveRightsEditorButton.disabled, true);
    assert.equal(f.listHtmlWrites(), 0);
    assert.deepEqual(copy(f.workspacePayloads.at(-1).users), []);
    const requestCount = f.requests.length;
    await f.save();
    assert.equal(f.requests.length, requestCount);
    if (status === 403) assert.match(f.elements.rightsManagementHint.textContent, /nicht verfügbar/);
  });
}

test("rights stale forbidden response cannot purge the new actor profile or table", async () => {
  const f = fixture(); f.open();
  const loading = f.handlers.loadRightsManagement();
  const stale = [f.next("/api/portal/v1/rights"), f.next("/mobile-layout"), f.next("/personnel-field-rights")];
  f.actorChange();
  f.state.rightsManagement = { users: [user("SYN-18")], catalog: [catalogEntry("loans:self:use"), catalogEntry("extra:synthetic")] };
  f.open("SYN-18");
  f.input("extra:synthetic").checked = true;
  const signature = f.handlers.rightsEditorDraftSignature(), snapshot = f.context.rightsEditorSnapshot;
  const roster = f.state.rightsManagement, title = f.elements.rightsEditorTitle.textContent;
  const summary = f.elements.rightsEditorSummary.textContent;
  stale[0].reject(Object.assign(new Error("Old actor forbidden"), { status: 403 }));
  stale[1].resolve({}); stale[2].resolve({}); await loading;
  assert.strictEqual(f.state.rightsManagement, roster);
  assert.strictEqual(f.context.rightsEditorSnapshot, snapshot);
  assert.equal(f.state.selectedRightsEmployeeNumber, "SYN-18");
  assert.equal(f.handlers.rightsEditorDraftSignature(), signature);
  assert.equal(f.elements.rightsEditorTitle.textContent, title);
  assert.equal(f.elements.rightsEditorSummary.textContent, summary);
  assert.equal(f.elements.rightsEditorModal.open, true);
  assert.equal(f.elements.rightsEditorModal.closeCount, 0);
  assert.equal(f.elements.saveRightsEditorButton.disabled, false);
  assert.equal(f.renders().roster, 0);
  assert.equal(f.listHtmlWrites(), 0);
  assert.equal(f.toasts.length, 0);
});

test("rights workspace requires an active personal eligible session with rights:read", async () => {
  for (const patch of [{ active: false }, { mustChangePassword: true }, { isEmployee: false },
    { role: "employee" }, { permissions: [] }]) {
    const f = fixture(); Object.assign(f.state.portalSession.user, patch);
    assert.equal(f.handlers.canUseRightsWorkspace(), false);
    f.open(); await f.save(); await f.handlers.loadRightsManagement();
    assert.equal(f.requests.length, 0);
    assert.equal(f.elements.rightsEditorModal.open, false);
  }
  const f = fixture(); f.state.portalSession.authenticated = false;
  assert.equal(f.handlers.canUseRightsWorkspace(), false);
  f.state.portalStatus = { portalEnabled: false, localOnly: true };
  assert.equal(f.handlers.canUseRightsWorkspace(), true);
  assert.equal(f.handlers.rightsWorkspaceActorKey(), "local");
});
