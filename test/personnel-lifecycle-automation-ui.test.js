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

const runtimeGates = Object.freeze({
  policyPersistence: false,
  deadlinePersistence: false,
  referenceDateMutation: false,
  assignmentMutation: false,
  scheduler: false,
  internalNotification: false,
  externalNotification: false,
  calendarMutation: false,
  automaticSubstitution: false,
  automaticEscalation: false,
  outboxDispatch: false,
  externalMutation: false,
});

const modes = Object.freeze({
  deadlineCalculation: "explicit_versioned_policy_only",
  representation: "manual_hr_clarification",
  reminders: "preview_only",
  escalations: "preview_only",
});

const emptyRegistry = () => ({
  recordCount: 0,
  activeRecordCount: 0,
  customerConfigured: false,
});

const domainContracts = Object.freeze({
  deadlines: {
    label: "Fristen und Kalenderregeln",
    registry: "deadlinePolicies",
    blockerCodes: [
      "policy_registry_empty", "calendar_rule_missing", "effects_activation_not_approved",
    ],
  },
  substitutions: {
    label: "Vertretung und Verantwortlichkeit",
    registry: "substitutionRules",
    blockerCodes: ["policy_registry_empty", "effects_activation_not_approved"],
  },
  reminders: {
    label: "Erinnerungen",
    registry: "reminderRules",
    blockerCodes: [
      "policy_registry_empty", "notification_channel_not_approved",
      "effects_activation_not_approved",
    ],
  },
  escalations: {
    label: "Eskalationen",
    registry: "escalationRules",
    blockerCodes: [
      "policy_registry_empty", "notification_channel_not_approved",
      "effects_activation_not_approved",
    ],
  },
});

function catalogPayload(domainIds = ["deadlines", "substitutions", "reminders", "escalations"]) {
  return {
    contractVersion: "o7-v0.1",
    registries: {
      deadlinePolicies: emptyRegistry(),
      calendarRules: emptyRegistry(),
      substitutionRules: emptyRegistry(),
      reminderRules: emptyRegistry(),
      escalationRules: emptyRegistry(),
      notificationChannels: emptyRegistry(),
    },
    runtimeGates: { ...runtimeGates },
    modes: { ...modes },
    blockerCodes: [
      "policy_registry_empty", "calendar_rule_missing",
      "notification_channel_not_approved", "effects_activation_not_approved",
    ],
    domains: domainIds.map((id) => ({
      id,
      label: domainContracts[id].label,
      status: "blocked",
      registry: domainContracts[id].registry,
      configurationCount: 0,
      externalEffectsEnabled: false,
      blockerCodes: [...domainContracts[id].blockerCodes],
    })),
  };
}

function configuredPreviewItem(title = "Zugang kontrollieren") {
  return {
    source: "offboarding",
    runId: "run-o7-ui",
    processVersionId: "offboarding-o5-v1",
    stepId: "access-revoke",
    title,
    status: "active",
    referenceKind: "access_block_at",
    referenceDate: "2026-08-03",
    dueAt: "2026-08-02",
    dueState: "overdue",
    responsibilityState: "assigned",
    representationState: "manual_only",
    reminderState: "preview_due",
    escalationState: "preview_due",
    blockerCodes: [],
  };
}

function previewPayload(items = [configuredPreviewItem()]) {
  return {
    contractVersion: "o7-v0.1",
    generatedAt: "2026-08-03T12:34:56.000Z",
    policyRegistry: { policyCount: 1, activePolicyCount: 1, customerConfigured: true },
    runtimeGates: { ...runtimeGates },
    modes: { ...modes },
    summary: {
      visibleTasks: items.length,
      configuredDeadlines: items.filter(({ dueState }) => dueState !== "not_configured").length,
      dueSoon: items.filter(({ dueState }) => dueState === "due_soon").length,
      dueToday: items.filter(({ dueState }) => dueState === "due_today").length,
      overdue: items.filter(({ dueState }) => dueState === "overdue").length,
      clarificationRequired: items.filter(({ blockerCodes, representationState }) => (
        blockerCodes.length > 0 || representationState === "clarification_required"
      )).length,
      notConfigured: items.filter(({ dueState }) => dueState === "not_configured").length,
    },
    items,
  };
}

test("O7 trennt Teilkatalog und persönliche Vorschau ohne Rollenheuristik", () => {
  const access = between(
    app,
    "const PERSONNEL_LIFECYCLE_AUTOMATION_READ_PERMISSIONS",
    "function canReadPersonnelTasks()",
  );
  const readPermissions = [
    "personnel:lifecycle:automation:deadlines:read",
    "personnel:lifecycle:automation:substitutions:read",
    "personnel:lifecycle:automation:reminders:read",
    "personnel:lifecycle:automation:escalations:read",
  ];
  for (const permission of readPermissions) assert.match(access, new RegExp(permission));
  assert.match(access, /PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS/);
  assert.match(access, /personnel:lifecycle:operational:read/);
  assert.match(access, /personnel:lifecycle:onboarding:read/);
  assert.match(access, /personnel:lifecycle:offboarding:confidential:read/);
  assert.match(access, /personnelLifecyclePermissionScopes/);
  assert.doesNotMatch(access, /role|developer|it_admin|admin|hr/);

  const sandbox = {
    featureEnabled: true,
    permissions: [],
    state: {
      portalStatus: { portalEnabled: true },
      portalSession: {
        user: { employeeNumber: "O7-UI", isEmployee: true, scopes: [{ locationId: "L1" }] },
      },
    },
    result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    function personnelLifecycleFoundationEnabled() { return featureEnabled; }
    function hasGovernancePermission(permission) { return permissions.includes(permission); }
    ${access}
  `, sandbox);
  vm.runInContext("result = canReadLifecycleAutomationCatalog();", sandbox);
  assert.equal(sandbox.result, false);
  sandbox.permissions = [readPermissions[0]];
  vm.runInContext("result = canReadLifecycleAutomationCatalog();", sandbox);
  assert.equal(sandbox.result, true);
  vm.runInContext("result = canReadLifecycleAutomationPreview();", sandbox);
  assert.equal(sandbox.result, false);
  sandbox.permissions = [
    ...readPermissions,
    "personnel:lifecycle:operational:read",
    "personnel:lifecycle:onboarding:read",
  ];
  vm.runInContext("result = canReadLifecycleAutomationPreview();", sandbox);
  assert.equal(sandbox.result, true);
  vm.runInContext("result = personnelLifecycleAutomationActorAccessKey();", sandbox);
  const firstFingerprint = sandbox.result;
  sandbox.permissions.push("personnel:lifecycle:automation:deadlines:manage");
  vm.runInContext("result = personnelLifecycleAutomationActorAccessKey();", sandbox);
  assert.notEqual(sandbox.result, firstFingerprint);
  const rightsFingerprint = sandbox.result;
  sandbox.state.portalSession.user.scopes = [{ locationId: "L2" }];
  vm.runInContext("result = personnelLifecycleAutomationActorAccessKey();", sandbox);
  assert.notEqual(sandbox.result, rightsFingerprint);
});

test("O7 normalisiert Katalog und Vorschau exakt und fail-closed", () => {
  const normalization = between(
    app,
    "const PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION",
    "function personnelWorkflowStepCount",
  );
  const sandbox = {
    catalog: catalogPayload(["reminders"]),
    preview: previewPayload(),
    result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(normalization, sandbox);
  vm.runInContext("result = normalizePersonnelLifecycleAutomationCatalog(catalog);", sandbox);
  let result = JSON.parse(JSON.stringify(sandbox.result));
  assert.deepEqual(result.domains.map(({ id }) => id), ["reminders"]);
  assert.equal(Object.keys(result.registries).length, 6);
  assert.equal(Object.values(result.runtimeGates).length, 12);
  assert.equal(Object.values(result.runtimeGates).some(Boolean), false);
  vm.runInContext("result = normalizePersonnelLifecycleAutomationPreview(preview);", sandbox);
  result = JSON.parse(JSON.stringify(sandbox.result));
  assert.deepEqual(Object.keys(result.items[0]), [
    "source", "runId", "processVersionId", "stepId", "title", "status", "referenceKind",
    "referenceDate", "dueAt", "dueState", "responsibilityState", "representationState",
    "reminderState", "escalationState", "blockerCodes",
  ]);

  sandbox.catalog = catalogPayload(["deadlines"]);
  sandbox.catalog.runtimeGates.scheduler = true;
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleAutomationCatalog(catalog)", sandbox),
    /nicht fail-closed/,
  );
  sandbox.catalog = catalogPayload(["deadlines"]);
  sandbox.catalog.domains[0].extra = "must-not-pass";
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleAutomationCatalog(catalog)", sandbox),
    /Domänenprojektion ist ungültig/,
  );
  sandbox.preview = previewPayload();
  sandbox.preview.items[0].employeeNumber = "must-not-pass";
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleAutomationPreview(preview)", sandbox),
    /Aufgabenprojektion ist ungültig/,
  );
  sandbox.preview = previewPayload();
  sandbox.preview.summary.overdue = 0;
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleAutomationPreview(preview)", sandbox),
    /stimmt nicht mit der sichtbaren Projektion überein/,
  );
  sandbox.preview = previewPayload();
  sandbox.preview.generatedAt = "2026-08-03T25:00:00.000Z";
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleAutomationPreview(preview)", sandbox),
    /Erzeugungszeitpunkt.*ungültig/,
  );
  const blocked = {
    ...configuredPreviewItem(),
    processVersionId: null,
    referenceKind: null,
    referenceDate: null,
    dueAt: null,
    dueState: "not_configured",
    reminderState: "blocked",
    escalationState: "blocked",
    blockerCodes: ["policy_binding_missing"],
  };
  sandbox.preview = previewPayload([blocked]);
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleAutomationPreview(preview)", sandbox),
    /nicht fail-closed/,
  );
});

test("O7 rendert serverprojizierte Daten XSS-sicher und ohne technische Bindungsfelder", () => {
  const normalization = between(
    app,
    "const PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION",
    "function personnelWorkflowStepCount",
  );
  const ui = between(
    app,
    "function personnelLifecycleAutomationDateLabel",
    "function renderPersonnelWorkflowTasks()",
  );
  const classNames = new Set(["hidden"]);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const sandbox = {
    state: {
      personnelLifecycleAutomationCatalog: null,
      personnelLifecycleAutomationPreview: null,
      personnelLifecycleAutomationCatalogLoaded: true,
      personnelLifecycleAutomationPreviewLoaded: true,
      personnelLifecycleAutomationLoading: false,
      personnelLifecycleAutomationError: "",
      personnelLifecycleAutomationActorAccessKey: "O7-UI",
      personnelLifecycleAutomationRequestToken: null,
    },
    elements: {
      personnelLifecycleAutomationSection: {
        classList: { toggle: (name, enabled) => (enabled ? classNames.add(name) : classNames.delete(name)) },
      },
      personnelLifecycleAutomationStatus: {
        textContent: "",
        classList: { add: (name) => classNames.add(name), remove: (name) => classNames.delete(name) },
      },
      personnelLifecycleAutomationCatalog: { innerHTML: "" },
      personnelLifecycleAutomationSummary: { innerHTML: "" },
      personnelLifecycleAutomationList: { innerHTML: "" },
    },
    canReadLifecycleAutomationCatalog: () => true,
    canReadLifecycleAutomationPreview: () => true,
    canReadLifecycleAutomationDomain: () => true,
    personnelLifecycleAutomationActorAccessKey: () => "O7-UI",
    personnelWorkflowTimestamp: (value) => value,
    renderPersonnelWorkflowInstanceOverview: () => {},
    applyRoleVisibility: () => {},
    api: async () => null,
    escapeHtml,
    escapeHtmlAttribute: escapeHtml,
  };
  vm.createContext(sandbox);
  vm.runInContext(normalization, sandbox);
  vm.runInContext(ui, sandbox);
  sandbox.state.personnelLifecycleAutomationCatalog = vm.runInContext(
    `normalizePersonnelLifecycleAutomationCatalog(${JSON.stringify(catalogPayload(["deadlines"]))})`,
    sandbox,
  );
  sandbox.state.personnelLifecycleAutomationPreview = vm.runInContext(
    `normalizePersonnelLifecycleAutomationPreview(${JSON.stringify(previewPayload([
      configuredPreviewItem('<img src=x onerror="alert(1)">'),
    ]))})`,
    sandbox,
  );
  vm.runInContext("renderPersonnelLifecycleAutomation();", sandbox);
  const rendered = sandbox.elements.personnelLifecycleAutomationList.innerHTML;
  assert.match(rendered, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(rendered, /<img\b|<script\b/i);
  assert.match(rendered, /Server-Fälligkeit/);
  assert.match(rendered, /Überfällig/);
  assert.doesNotMatch(rendered, /offboarding-o5-v1|access_block_at|run-o7-ui|access-revoke/);
  assert.doesNotMatch(rendered, /<button\b|<form\b|<input\b/i);
});

test("O7 lädt lazy ausschließlich über GET und berechnet keine Frist im Client", () => {
  const loading = between(
    app,
    "async function loadPersonnelLifecycleAutomation",
    "function renderPersonnelWorkflowTasks()",
  );
  assert.match(loading, /api\("\/api\/portal\/v1\/personnel-lifecycle\/automation\/catalog"\)/);
  assert.match(loading, /api\("\/api\/portal\/v1\/personnel-lifecycle\/automation\/preview"\)/);
  assert.match(loading, /previewReadable[\s\S]*?Promise\.resolve\(null\)/);
  assert.match(loading, /normalizePersonnelLifecycleAutomationCatalog/);
  assert.match(loading, /normalizePersonnelLifecycleAutomationPreview/);
  assert.doesNotMatch(loading, /method:\s*"(?:POST|PUT|PATCH|DELETE)"|\/dispatch|\/apply|\/trigger|\/recalculate/);

  const navigation = between(app, "function setPersonnelAdministrationTab(tab)", "function populateCostCenterTypeSelect");
  assert.match(navigation, /normalized === "tasks" && canReadLifecycleAutomationCatalog\(\)/);
  assert.match(navigation, /loadPersonnelLifecycleAutomation\(\)/);
  const refresh = between(
    app,
    "elements.refreshPersonnelWorkflowTasksButton?.addEventListener",
    "elements.personnelWorkflowTaskList?.addEventListener",
  );
  assert.match(refresh, /loadPersonnelLifecycleAutomation\(\{ force: true \}\)/);

  const o7Source = between(
    app,
    "const PERSONNEL_LIFECYCLE_AUTOMATION_CONTRACT_VERSION",
    "function renderPersonnelWorkflowTasks()",
  );
  assert.doesNotMatch(o7Source, /Date\.now\(|calculateDue|daysBetween|new Date\([^)]*dueAt/);
  assert.match(o7Source, /preview\.summary\.overdue/);
  assert.match(o7Source, /item\.dueState/);
});

test("O7 entfernt Zustand und DOM bei Fehler, Rechteverlust, Logout und Bereichswechsel", async () => {
  const ui = between(
    app,
    "function personnelLifecycleAutomationDateLabel",
    "function renderPersonnelWorkflowTasks()",
  );
  let readable = true;
  const classNames = new Set();
  const sandbox = {
    state: {
      personnelLifecycleAutomationCatalog: { secret: true },
      personnelLifecycleAutomationPreview: { secret: true },
      personnelLifecycleAutomationCatalogLoaded: true,
      personnelLifecycleAutomationPreviewLoaded: true,
      personnelLifecycleAutomationLoading: false,
      personnelLifecycleAutomationError: "",
      personnelLifecycleAutomationActorAccessKey: "O7-UI",
      personnelLifecycleAutomationRequestToken: null,
    },
    elements: {
      personnelLifecycleAutomationSection: {
        classList: { toggle: (name, enabled) => (enabled ? classNames.add(name) : classNames.delete(name)) },
      },
      personnelLifecycleAutomationStatus: {
        textContent: "",
        classList: { add: (name) => classNames.add(name), remove: (name) => classNames.delete(name) },
      },
      personnelLifecycleAutomationCatalog: { innerHTML: "SECRET-CATALOG" },
      personnelLifecycleAutomationSummary: { innerHTML: "SECRET-SUMMARY" },
      personnelLifecycleAutomationList: { innerHTML: "SECRET-LIST" },
    },
    canReadLifecycleAutomationCatalog: () => readable,
    canReadLifecycleAutomationPreview: () => false,
    canReadLifecycleAutomationDomain: () => true,
    personnelLifecycleAutomationActorAccessKey: () => "O7-UI",
    personnelWorkflowTimestamp: (value) => value,
    renderPersonnelWorkflowInstanceOverview: () => {},
    applyRoleVisibility: () => {},
    api: async () => { const error = new Error("synthetic failure"); error.status = 500; throw error; },
    escapeHtml: (value) => String(value),
    escapeHtmlAttribute: (value) => String(value),
  };
  vm.createContext(sandbox);
  vm.runInContext(ui, sandbox);
  vm.runInContext("clearPersonnelLifecycleAutomationState('Zugriff entfernt.');", sandbox);
  assert.equal(sandbox.state.personnelLifecycleAutomationCatalog, null);
  assert.equal(sandbox.state.personnelLifecycleAutomationPreview, null);
  assert.equal(sandbox.state.personnelLifecycleAutomationActorAccessKey, "");
  assert.equal(sandbox.elements.personnelLifecycleAutomationCatalog.innerHTML, "");
  assert.equal(sandbox.elements.personnelLifecycleAutomationSummary.innerHTML, "");
  assert.equal(sandbox.elements.personnelLifecycleAutomationList.innerHTML, "");

  sandbox.state.personnelLifecycleAutomationActorAccessKey = "O7-UI";
  await vm.runInContext("loadPersonnelLifecycleAutomation();", sandbox);
  assert.equal(sandbox.state.personnelLifecycleAutomationCatalog, null);
  assert.equal(sandbox.state.personnelLifecycleAutomationPreview, null);
  assert.match(sandbox.state.personnelLifecycleAutomationError, /nicht sicher geladen/);
  assert.equal(sandbox.elements.personnelLifecycleAutomationList.innerHTML, "");

  readable = false;
  sandbox.elements.personnelLifecycleAutomationCatalog.innerHTML = "SECRET";
  sandbox.elements.personnelLifecycleAutomationSummary.innerHTML = "SECRET";
  sandbox.elements.personnelLifecycleAutomationList.innerHTML = "SECRET";
  vm.runInContext("renderPersonnelLifecycleAutomation();", sandbox);
  assert.equal(sandbox.elements.personnelLifecycleAutomationCatalog.innerHTML, "");
  assert.equal(sandbox.elements.personnelLifecycleAutomationSummary.innerHTML, "");
  assert.equal(sandbox.elements.personnelLifecycleAutomationList.innerHTML, "");

  const visibility = between(app, "function applyRoleVisibility()", "async function bootstrapApplication()");
  assert.match(visibility, /lifecycleAutomationActorAccessChanged/);
  assert.match(visibility, /clearPersonnelLifecycleAutomationState/);
  const logout = between(app, "async function logoutPortal()", "function openAdminSetup()");
  assert.match(logout, /clearPersonnelLifecycleAutomationState\(\)/);
  const navigation = between(app, "function setPersonnelAdministrationTab(tab)", "function populateCostCenterTypeSelect");
  assert.match(navigation, /normalized !== "tasks"[\s\S]*?clearPersonnelLifecycleAutomationState\(\)/);
  const view = between(app, "function setView(view)", "function applyRequestedView(");
  assert.match(view, /view !== "personnelAdministration"[\s\S]*?clearPersonnelLifecycleAutomationState\(\)/);
});

test("O7-Karten bleiben bei 320 Pixel einspaltig und aktionsfrei", () => {
  const section = between(
    html,
    '<section class="personnel-lifecycle-automation',
    "</section>",
  );
  assert.match(section, /Nur Vorschau/);
  assert.match(section, /Keine Erinnerung versendet/);
  assert.match(section, /Keine automatische Vertretung\/Eskalation/);
  assert.doesNotMatch(section, /<button\b|<form\b|<input\b|<select\b/i);
  assert.match(html, /M5 \/ O4 \/ O5 \/ O6 \/ O7 · kontrolliert/);
  assert.match(styles, /\.personnel-lifecycle-automation \{[^}]*min-width:0[^}]*max-width:100%[^}]*box-sizing:border-box/);
  assert.match(styles, /\.personnel-lifecycle-automation-task-card \{[^}]*min-width:0[^}]*max-width:100%/);
  assert.match(styles, /\.personnel-lifecycle-automation-domain-card dd,[^{]*\{[^}]*overflow-wrap:anywhere/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-lifecycle-automation \{ width:100%; min-width:0; max-width:100%;/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-lifecycle-automation-catalog,[^{]*\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.doesNotMatch(
    styles.slice(styles.indexOf(".personnel-lifecycle-automation")),
    /\.personnel-lifecycle-automation[^{}]*\{[^}]*overflow-x\s*:/,
  );
});

test("O7-Folgerechte hängen in der Rechte-UI jeweils vom Domänenleserecht ab", () => {
  const dependencies = between(
    app,
    "function lifecycleRightsDependency",
    "async function loadPortalUsers()",
  );
  const actions = {
    deadlines: ["manage", "recalculate", "reconcile"],
    substitutions: ["manage", "apply", "reconcile"],
    reminders: ["manage", "dispatch", "reconcile"],
    escalations: ["manage", "trigger", "reconcile"],
  };
  for (const [domain, domainActions] of Object.entries(actions)) {
    for (const action of domainActions) {
      assert.match(
        dependencies,
        new RegExp(`personnel:lifecycle:automation:${domain}:${action}[\\s\\S]*?personnel:lifecycle:automation:${domain}:read`),
      );
    }
  }
});
