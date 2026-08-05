"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const app = read("public/app.js");
const html = read("public/index.html");
const styles = read("public/styles.css");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

function catalogPayload(domains = ["training", "asset", "access"]) {
  const contracts = {
    training: {
      label: "Schulung",
      operations: ["training_assign", "training_status", "training_evidence"],
      maximumProjectionFields: [
        "orderId", "displayName", "locationId", "departmentId", "module", "dueAt",
        "evidenceStatus", "status",
      ],
      defaultPayloadFields: [
        "schemaVersion", "commandId", "orderId", "operation", "module", "dueAt",
        "evidenceStatus",
      ],
      optionalProviderFields: ["locationId", "departmentId", "displayName"],
    },
    asset: {
      label: "Arbeitsmittel",
      operations: ["asset_issue", "asset_return"],
      maximumProjectionFields: [
        "orderId", "displayName", "locationId", "assetIdentifier", "action", "dueAt", "status",
      ],
      defaultPayloadFields: [
        "schemaVersion", "commandId", "orderId", "operation", "assetIdentifier", "locationId",
        "effectiveAt",
      ],
      optionalProviderFields: ["displayName"],
    },
    access: {
      label: "Zugang",
      operations: ["access_grant", "access_change", "access_revoke"],
      maximumProjectionFields: [
        "orderId", "displayName", "businessIdentifier", "targetSystem", "action", "executeAt",
        "status",
      ],
      defaultPayloadFields: [
        "schemaVersion", "commandId", "orderId", "operation", "businessIdentifier", "targetSystem",
        "effectiveAt",
      ],
      optionalProviderFields: ["displayName"],
    },
  };
  return {
    contractVersion: "o6-v0.1",
    registry: { providerCount: 0, activeProviderCount: 0, customerConfigured: false },
    runtimeGates: {
      networkDispatch: false,
      persistence: false,
      outbox: false,
      externalMutation: false,
    },
    domains: domains.map((id) => ({
      id,
      label: contracts[id].label,
      status: "blocked",
      blockerCodes: ["allowlist_not_found"],
      operations: contracts[id].operations,
      maximumProjectionFields: contracts[id].maximumProjectionFields,
      defaultPayloadFields: contracts[id].defaultPayloadFields,
      optionalProviderFields: contracts[id].optionalProviderFields,
      providerCount: 0,
      externalEffectsEnabled: false,
    })),
  };
}

test("O6-Lesezugang verlangt ein eigenes Domänenrecht und keine Rollenheuristik", () => {
  const access = between(
    app,
    "const PERSONNEL_LIFECYCLE_INTERFACE_READ_PERMISSIONS",
    "function canReadPersonnelTasks()",
  );
  for (const domain of ["training", "asset", "access"]) {
    assert.match(access, new RegExp(`personnel:lifecycle:interfaces:${domain}:read`));
  }
  assert.match(access, /personnelLifecycleFoundationEnabled\(\)/);
  assert.match(access, /state\.portalStatus\?\.portalEnabled === true/);
  assert.match(access, /Boolean\(personnelLifecycleInterfacesIdentityKey\(\)\)/);
  assert.match(access, /\.some\(\(permission\) => hasGovernancePermission\(permission\)\)/);
  assert.doesNotMatch(access, /role|developer|it_admin|admin|hr/);

  const sandbox = {
    featureEnabled: true,
    portalEnabled: true,
    permissions: [],
    state: {
      portalStatus: { portalEnabled: true },
      portalSession: { user: { employeeNumber: "O6-PERSONAL" } },
    },
    result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    function personnelLifecycleFoundationEnabled() { return featureEnabled; }
    function hasGovernancePermission(permission) {
      return !portalEnabled || permissions.includes(permission);
    }
    ${access}
  `, sandbox);
  vm.runInContext("result = canReadLifecycleInterfaces();", sandbox);
  assert.equal(sandbox.result, false);
  sandbox.permissions = ["personnel:lifecycle:interfaces:training:read"];
  vm.runInContext("result = canReadLifecycleInterfaces();", sandbox);
  assert.equal(sandbox.result, true);
  vm.runInContext("result = personnelLifecycleInterfacesActorAccessKey();", sandbox);
  assert.equal(sandbox.result, "O6-PERSONAL\0training");
  sandbox.permissions.push("personnel:lifecycle:interfaces:asset:read");
  vm.runInContext("result = personnelLifecycleInterfacesActorAccessKey();", sandbox);
  assert.equal(sandbox.result, "O6-PERSONAL\0asset\0training");
  sandbox.featureEnabled = false;
  vm.runInContext("result = canReadLifecycleInterfaces();", sandbox);
  assert.equal(sandbox.result, false);
  sandbox.featureEnabled = true;
  sandbox.permissions = [];
  sandbox.portalEnabled = false;
  sandbox.state.portalStatus.portalEnabled = false;
  vm.runInContext("result = canReadLifecycleInterfaces();", sandbox);
  assert.equal(sandbox.result, false);
  sandbox.portalEnabled = true;
  sandbox.state.portalStatus.portalEnabled = true;
  sandbox.permissions = ["personnel:lifecycle:interfaces:asset:read"];
  sandbox.state.portalSession.user.employeeNumber = "";
  vm.runInContext("result = canReadLifecycleInterfaces();", sandbox);
  assert.equal(sandbox.result, false);
});

test("O6-Katalog normalisiert ausschließlich bekannte, vollständig gesperrte Strukturen", () => {
  const normalization = between(
    app,
    "const PERSONNEL_LIFECYCLE_INTERFACE_CATALOG_VERSION",
    "function personnelWorkflowStepCount(value)",
  );
  const sandbox = { payload: catalogPayload(["training", "access"]), result: null };
  vm.createContext(sandbox);
  vm.runInContext(normalization, sandbox);
  vm.runInContext("result = normalizePersonnelLifecycleInterfacesCatalog(payload);", sandbox);
  const result = JSON.parse(JSON.stringify(sandbox.result));
  assert.deepEqual(Object.keys(result), ["contractVersion", "registry", "runtimeGates", "domains"]);
  assert.deepEqual(result.registry, {
    providerCount: 0,
    activeProviderCount: 0,
    customerConfigured: false,
  });
  assert.deepEqual(result.domains.map(({ id }) => id), ["training", "access"]);
  assert.equal(Object.values(result.runtimeGates).some(Boolean), false);
  assert.equal(JSON.stringify(result).includes("must-not-pass"), false);

  sandbox.payload = catalogPayload(["access"]);
  sandbox.payload.domains[0].blockerCodes = ["target_system_not_allowed"];
  vm.runInContext("result = normalizePersonnelLifecycleInterfacesCatalog(payload);", sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result.domains[0].blockerCodes)), [
    "target_system_not_allowed",
  ]);

  sandbox.payload = catalogPayload(["training"]);
  sandbox.payload.domains[0].operations.push("training_autostart");
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleInterfacesCatalog(payload)", sandbox),
    /überschreitet den O6-Vertrag/,
  );
  sandbox.payload = catalogPayload(["asset"]);
  sandbox.payload.domains[0].maximumProjectionFields.push("employeeNumber");
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleInterfacesCatalog(payload)", sandbox),
    /überschreitet den O6-Vertrag/,
  );
  sandbox.payload = catalogPayload(["access"]);
  sandbox.payload.domains[0].blockerCodes = ["unknown_external_state"];
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleInterfacesCatalog(payload)", sandbox),
    /überschreitet den O6-Vertrag/,
  );
  sandbox.payload = catalogPayload(["training"]);
  sandbox.payload.runtimeGates.unexpectedDispatch = true;
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleInterfacesCatalog(payload)", sandbox),
    /nicht fail-closed/,
  );
  sandbox.payload = catalogPayload(["training"]);
  sandbox.payload.domains[0].protectedCase = "must-not-pass";
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleInterfacesCatalog(payload)", sandbox),
    /Domänenprojektion ist ungültig/,
  );
});

test("O6-Statuskarten bleiben rein lesend und werden aus Zustand und DOM entfernt", () => {
  const normalization = between(
    app,
    "const PERSONNEL_LIFECYCLE_INTERFACE_CATALOG_VERSION",
    "function personnelWorkflowStepCount(value)",
  );
  const ui = between(
    app,
    "function renderPersonnelLifecycleInterfacesCatalog()",
    "function renderPersonnelWorkflowTasks()",
  );
  const classNames = new Set();
  const sandbox = {
    readable: true,
    state: {
      personnelLifecycleInterfacesCatalog: null,
      personnelLifecycleInterfacesLoaded: false,
      personnelLifecycleInterfacesLoading: false,
      personnelLifecycleInterfacesError: "",
      personnelLifecycleInterfacesActorAccessKey: "O6-UI\0training",
      personnelLifecycleInterfacesRequestToken: {},
    },
    elements: {
      personnelLifecycleInterfacesSection: {
        classList: { toggle: (name, enabled) => (enabled ? classNames.add(name) : classNames.delete(name)) },
      },
      personnelLifecycleInterfacesStatus: {
        textContent: "",
        classList: { add: (name) => classNames.add(name), remove: (name) => classNames.delete(name) },
      },
      personnelLifecycleInterfacesList: { innerHTML: "VERTRAULICHE-ALT-DATEN" },
    },
    escapeHtml: (value) => String(value),
    escapeHtmlAttribute: (value) => String(value),
    canReadLifecycleInterfaces: () => sandbox.readable,
    canReadLifecycleInterfaceDomain: () => true,
    personnelLifecycleInterfacesIdentityKey: () => "O6-UI",
    personnelLifecycleInterfacesActorAccessKey: () => "O6-UI\0training",
    api: async () => catalogPayload(),
    applyRoleVisibility: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(normalization, sandbox);
  vm.runInContext(ui, sandbox);
  sandbox.state.personnelLifecycleInterfacesCatalog = vm.runInContext(
    `normalizePersonnelLifecycleInterfacesCatalog(${JSON.stringify(catalogPayload(["training"]))})`,
    sandbox,
  );
  sandbox.state.personnelLifecycleInterfacesLoaded = true;
  vm.runInContext("renderPersonnelLifecycleInterfacesCatalog();", sandbox);
  const rendered = sandbox.elements.personnelLifecycleInterfacesList.innerHTML;
  assert.match(rendered, /Keine Zielsysteme freigegeben/);
  assert.match(rendered, /Außenwirkung gesperrt/);
  assert.match(rendered, /O6 · Nur Lesen/);
  assert.doesNotMatch(rendered, /<button\b|<form\b|dispatch|preflight|aktivieren|versenden/i);

  vm.runInContext("clearPersonnelLifecycleInterfacesState('Zugriff entfernt.');", sandbox);
  assert.equal(sandbox.state.personnelLifecycleInterfacesCatalog, null);
  assert.equal(sandbox.state.personnelLifecycleInterfacesLoaded, false);
  assert.equal(sandbox.state.personnelLifecycleInterfacesActorAccessKey, "");
  assert.equal(sandbox.state.personnelLifecycleInterfacesRequestToken, null);
  assert.equal(sandbox.elements.personnelLifecycleInterfacesList.innerHTML, "");
  assert.equal(sandbox.elements.personnelLifecycleInterfacesStatus.textContent, "Zugriff entfernt.");

  sandbox.readable = false;
  sandbox.elements.personnelLifecycleInterfacesList.innerHTML = "DARF-NICHT-BLEIBEN";
  vm.runInContext("renderPersonnelLifecycleInterfacesCatalog();", sandbox);
  assert.equal(sandbox.elements.personnelLifecycleInterfacesList.innerHTML, "");
  assert.equal(sandbox.elements.personnelLifecycleInterfacesStatus.textContent, "");
});

test("O6 lädt lazy und beim Refresh nur den read-only Katalog", () => {
  const loading = between(
    app,
    "async function loadPersonnelLifecycleInterfacesCatalog",
    "function renderPersonnelWorkflowTasks()",
  );
  assert.match(loading, /api\("\/api\/portal\/v1\/personnel-lifecycle\/interfaces\/catalog"\)/);
  assert.doesNotMatch(loading, /method:\s*"(?:POST|PUT|PATCH|DELETE)"|\/dispatch|\/preflight|\/manage|\/reconcile/);
  assert.match(loading, /normalizePersonnelLifecycleInterfacesCatalog\(result\)/);
  assert.match(loading, /domains\.filter\(\(\{ id \}\) => canReadLifecycleInterfaceDomain\(id\)\)/);

  const navigation = between(app, "function setPersonnelAdministrationTab(tab)", "function populateCostCenterTypeSelect");
  assert.match(navigation, /normalized === "tasks" && canReadLifecycleInterfaces\(\)/);
  assert.match(navigation, /loadPersonnelLifecycleInterfacesCatalog\(\)/);
  const refresh = between(
    app,
    "elements.refreshPersonnelWorkflowTasksButton?.addEventListener",
    "elements.personnelWorkflowTaskList?.addEventListener",
  );
  assert.match(refresh, /loadPersonnelLifecycleInterfacesCatalog\(\{ force: true \}\)/);

  const visibility = between(app, "function applyRoleVisibility()", "async function bootstrapApplication()");
  assert.match(visibility, /lifecycleInterfacesActorAccessChanged/);
  assert.match(visibility, /clearPersonnelLifecycleInterfacesState/);
  const logout = between(app, "async function logoutPortal()", "function openAdminSetup()");
  assert.match(logout, /clearPersonnelLifecycleInterfacesState\(\)/);
});

test("O6-Rechteabhängigkeiten erzwingen je Domäne read vor manage, dispatch und reconcile", () => {
  const dependencies = between(
    app,
    "function lifecycleRightsDependency",
    "async function loadPortalUsers()",
  );
  for (const domain of ["training", "asset", "access"]) {
    for (const action of ["manage", "dispatch", "reconcile"]) {
      const pattern = new RegExp(
        `personnel:lifecycle:interfaces:${domain}:${action}[\\s\\S]*?personnel:lifecycle:interfaces:${domain}:read`,
      );
      assert.match(dependencies, pattern);
    }
  }
});

test("O6-Statussektion hat keine Aktionsschaltfläche und bleibt bei 320 Pixel ohne Querachse", () => {
  const section = between(
    html,
    '<section class="personnel-lifecycle-interface-catalog',
    "</section>",
  );
  assert.match(section, /Keine Zielsysteme freigegeben|Schnittstellenstatus/);
  assert.match(section, /Außenwirkung gesperrt/);
  assert.doesNotMatch(section, /<button\b|preflight|dispatch|versenden|aktivieren/i);
  assert.match(html, /M5 \/ O4 \/ O5 \/ O6 · kontrolliert/);
  assert.match(styles, /\.personnel-lifecycle-interface-catalog \{[^}]*min-width:0[^}]*max-width:100%[^}]*box-sizing:border-box/);
  assert.match(styles, /\.personnel-lifecycle-interface-card dd \{[^}]*overflow-wrap:anywhere/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-lifecycle-interface-catalog \{ width:100%; min-width:0; max-width:100%;/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-lifecycle-interface-card \{ width:100%; min-width:0; max-width:100%;/);
  assert.doesNotMatch(
    styles.slice(styles.indexOf(".personnel-lifecycle-interface-catalog")),
    /\.personnel-lifecycle-interface[^{}]*\{[^}]*overflow-x\s*:/,
  );
});
