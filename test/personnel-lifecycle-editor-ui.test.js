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
  persistence: false,
  draftPersistence: false,
  publication: false,
  archive: false,
  instantiation: false,
  runtimeExecution: false,
  taskMutation: false,
  notification: false,
  scheduler: false,
  externalMutation: false,
  legacyBridge: false,
});

const limits = Object.freeze({
  minimumSteps: 2,
  maximumSteps: 30,
  draftIdMaximumLength: 128,
  workflowCodeMaximumLength: 80,
  titleMaximumLength: 120,
  descriptionMaximumLength: 600,
  stepIdMaximumLength: 80,
  stepTitleMaximumLength: 120,
  stepDescriptionMaximumLength: 600,
});

const responsibilities = Object.freeze({
  onboarding: [
    "hr_case", "payroll", "leadership", "it_security", "asset_custodian", "trainer", "employee",
  ],
  offboarding: [
    "offboarding_confidential", "hr_confidential", "payroll", "leadership", "it_security",
    "asset_custodian", "employee",
  ],
});

function catalogPayload(workflowTypes = ["onboarding", "offboarding"]) {
  return {
    contractVersion: "o8-v0.1",
    model: "linear-v1",
    mode: "memory_only",
    source: "memory",
    workflowTypes,
    enums: {
      workflowTypes,
      stepTypes: ["task", "approval", "finish"],
      scopeTypes: ["company", "location", "department"],
      requirementKinds: ["mandatory", "optional"],
      responsibilityClassesByWorkflowType: Object.fromEntries(
        workflowTypes.map((workflowType) => [workflowType, responsibilities[workflowType]]),
      ),
    },
    limits: { ...limits },
    runtimeGates: { ...runtimeGates },
  };
}

function validDraft() {
  return {
    draftId: "draft-ui-1",
    workflowType: "onboarding",
    workflowCode: "onboarding.base",
    title: "Onboarding Basis",
    description: "Nur ein flüchtiger Testentwurf.",
    scopeType: "company",
    requirementKind: "mandatory",
    steps: [
      {
        id: "step-1",
        type: "task",
        title: "Unterlagen prüfen",
        description: "",
        responsibilityClass: "hr_case",
        required: true,
      },
      {
        id: "step-2",
        type: "finish",
        title: "Onboarding abschließen",
        description: "",
        responsibilityClass: "hr_case",
        required: true,
      },
    ],
  };
}

test("O8 ist ein eigenständiger, klar flüchtiger Dialog ohne Wirkungsaktionen", () => {
  const dialog = between(
    html,
    '<dialog class="modal personnel-lifecycle-editor-dialog"',
    '<dialog class="modal request-action-modal"',
  );
  assert.match(dialog, /Arbeitsentwurf – nicht gespeichert/);
  assert.match(dialog, /Nur flüchtige Arbeitskopie/);
  assert.match(dialog, /speichert, veröffentlicht, aktiviert oder startet diesen Entwurf nicht/);
  assert.match(dialog, /<ol class="personnel-lifecycle-editor-flow"/);
  assert.match(dialog, /Schritt hinzufügen/);
  assert.match(dialog, /Nach oben/);
  assert.match(dialog, /Nach unten/);
  assert.match(dialog, /Entfernen/);
  assert.match(dialog, /Serverprüfung starten/);
  const buttonLabels = [...dialog.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)]
    .map((match) => match[1]).join(" ");
  assert.doesNotMatch(dialog, /customProcess/);
  assert.doesNotMatch(buttonLabels, /Speichern|Veröffentlichen|Archivieren|Aktivieren|Ausführen|Trigger|Kanal/);
  assert.ok(html.indexOf('id="customProcessModal"') < html.indexOf('id="personnelLifecycleEditorDialog"'));
  assert.match(html, /M5 \/ O8 · kontrolliert/);
});

test("O8-Zugriff ist persönlich, fachrechtlich und nach Quelle fail-closed", () => {
  const access = between(
    app,
    "const PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS",
    "function canOpenPersonnelAdministrationView()",
  );
  assert.doesNotMatch(access, /\brole\b|developer|it_admin|admin|hr_manager/);
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(`
    let permissions = [];
    let featureEnabled = true;
    const state = {
      portalStatus: { portalEnabled: true },
      portalSession: {
        user: {
          isEmployee: true,
          employeeNumber: "O8-UI",
          scopes: [{ locationId: "L1" }],
          permissionScopes: [],
          personnelLifecyclePermissionScopes: [],
        },
      },
    };
    function personnelLifecycleFoundationEnabled() { return featureEnabled; }
    function hasGovernancePermission(permission) { return permissions.includes(permission); }
    ${access}
  `, sandbox);

  vm.runInContext("result = canReadPersonnelLifecycleEditorCatalog();", sandbox);
  assert.equal(sandbox.result, false);
  vm.runInContext(`permissions = [
    "personnel:lifecycle:editor:read",
    "personnel:lifecycle:onboarding:read"
  ]; result = canReadPersonnelLifecycleEditorCatalog();`, sandbox);
  assert.equal(sandbox.result, true);
  vm.runInContext("result = canReadPersonnelLifecycleEditorWorkflowType('offboarding');", sandbox);
  assert.equal(sandbox.result, false);
  vm.runInContext(`permissions = [
    "personnel:lifecycle:editor:read",
    "personnel:lifecycle:offboarding:confidential:read",
    "personnel:lifecycle:hr-confidential:read"
  ]; result = canReadPersonnelLifecycleEditorWorkflowType("offboarding");`, sandbox);
  assert.equal(sandbox.result, true);
  vm.runInContext("state.portalSession.user.isEmployee = undefined; result = canReadPersonnelLifecycleEditorCatalog();", sandbox);
  assert.equal(sandbox.result, false);
  vm.runInContext(`state.portalSession.user.isEmployee = true;
    permissions.push("personnel:lifecycle:editor:draft:write", "personnel:lifecycle:editor:validate");
    result = canValidatePersonnelLifecycleEditorDraft();`, sandbox);
  assert.equal(sandbox.result, true);
  vm.runInContext("result = personnelLifecycleEditorActorAccessKey();", sandbox);
  const actorKey = sandbox.result;
  vm.runInContext("state.portalSession.user.scopes = [{ locationId: 'L2' }]; result = personnelLifecycleEditorActorAccessKey();", sandbox);
  assert.notEqual(sandbox.result, actorKey);
});

test("O8 normalisiert den gefilterten Katalog exakt und weist fremde Strukturen ab", () => {
  const normalization = between(
    app,
    'const PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION = "o8-v0.1";',
    "function clonePersonnelLifecycleEditorDraft",
  );
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(`
    function canReadPersonnelLifecycleEditorWorkflowType() { return true; }
    ${normalization}
    let catalog = ${JSON.stringify(catalogPayload(["onboarding"]))};
  `, sandbox);
  vm.runInContext("result = normalizePersonnelLifecycleEditorCatalog(catalog);", sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result.workflowTypes)), ["onboarding"]);
  assert.deepEqual(
    Object.keys(JSON.parse(JSON.stringify(sandbox.result.enums.responsibilityClassesByWorkflowType))),
    ["onboarding"],
  );

  vm.runInContext(`catalog = ${JSON.stringify(catalogPayload(["onboarding"]))}; catalog.extra = true;`, sandbox);
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleEditorCatalog(catalog)", sandbox),
    /ungültig/,
  );
  vm.runInContext(`catalog = ${JSON.stringify(catalogPayload(["onboarding"]))}; catalog.runtimeGates.publication = true;`, sandbox);
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleEditorCatalog(catalog)", sandbox),
    /fail-closed/,
  );
  vm.runInContext(`catalog = ${JSON.stringify(catalogPayload(["onboarding"]))}; Object.setPrototypeOf(catalog.workflowTypes, {});`, sandbox);
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleEditorCatalog(catalog)", sandbox),
    /ungültig/,
  );
  vm.runInContext(`catalog = ${JSON.stringify(catalogPayload(["offboarding", "onboarding"]))};`, sandbox);
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleEditorCatalog(catalog)", sandbox),
    /nicht freigegebene Prozessart/,
  );
  assert.match(normalization, /personnelLifecycleEditorIsDenseArray\(value\.blockers, 150\)/);
});

test("O8 erzeugt ausschließlich Client-Schrittkennungen und normalisiert NFC sowie Leerraum", () => {
  const normalization = between(
    app,
    'const PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION = "o8-v0.1";',
    "function clonePersonnelLifecycleEditorDraft",
  );
  const generator = between(
    app,
    "function clonePersonnelLifecycleEditorDraft",
    "function selectedPersonnelLifecycleEditorStep",
  );
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(`
    function canReadPersonnelLifecycleEditorWorkflowType() { return true; }
    ${normalization}
    ${generator}
    const generated = createPersonnelLifecycleEditorDraft("onboarding");
    generated.workflowCode = "  onboarding.base  ";
    generated.title = "  Cafe\u0301  ";
    generated.steps[0].title = "  Unterlagen  ";
    generated.steps[0].responsibilityClass = "hr_case";
    generated.steps[1].title = "  Abschluss  ";
    generated.steps[1].responsibilityClass = "hr_case";
    result = normalizePersonnelLifecycleEditorDraft(generated);
  `, sandbox);
  const result = JSON.parse(JSON.stringify(sandbox.result));
  assert.equal(result.workflowCode, "onboarding.base");
  assert.equal(result.title, "Café");
  assert.deepEqual(result.steps.map(({ id }) => id), ["step-1", "step-2"]);
  assert.doesNotMatch(JSON.stringify(result.steps), /memory-(?:node|edge)-/);
  vm.runInContext("result = nextPersonnelLifecycleEditorStepId([{ id: 'step-1' }, { id: 'step-2' }]);", sandbox);
  assert.equal(sandbox.result, "step-3");
  vm.runInContext(`result = ${JSON.stringify(validDraft())}; result.workflowCode = "Nicht erlaubt";`, sandbox);
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleEditorDraft(result)", sandbox),
    /keine zulässige O8-Kennung/,
  );
  vm.runInContext(`result = ${JSON.stringify(validDraft())}; result.steps[0].id = "memory-node-client";`, sandbox);
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleEditorDraft(result)", sandbox),
    /keine zulässige O8-Kennung/,
  );
});

test("O8 sendet nur die normalisierte flüchtige Kopie und behält echte Race-Prüfung", async () => {
  const normalization = between(
    app,
    'const PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION = "o8-v0.1";',
    "function clonePersonnelLifecycleEditorDraft",
  );
  const clone = between(
    app,
    "function clonePersonnelLifecycleEditorDraft",
    "function personnelLifecycleEditorDraftId",
  );
  const validate = between(
    app,
    "async function validatePersonnelLifecycleEditorDraft",
    "function renderPersonnelWorkflowTasksImpl()",
  );
  const draft = validDraft();
  draft.workflowCode = "  onboarding.base  ";
  draft.title = "  Cafe\u0301  ";
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(`
    function canReadPersonnelLifecycleEditorWorkflowType() { return true; }
    ${normalization}
    ${clone}
    const state = {
      personnelLifecycleEditorDraft: ${JSON.stringify(draft)},
      personnelLifecycleEditorActorAccessKey: "O8-ACTOR",
      personnelLifecycleEditorRequestToken: null,
      personnelLifecycleEditorValidating: false,
      personnelLifecycleEditorValidation: null,
    };
    const elements = { personnelLifecycleEditorDialog: { open: true } };
    let capturedBody = "";
    let lastStatus = "";
    function canValidatePersonnelLifecycleEditorDraft() { return true; }
    function personnelLifecycleEditorActorAccessKey() { return "O8-ACTOR"; }
    function renderPersonnelLifecycleEditor() {}
    function renderPersonnelLifecycleEditorValidation() {}
    function clearPersonnelLifecycleEditorState() { throw new Error("unexpected purge"); }
    function applyRoleVisibility() {}
    function setPersonnelLifecycleEditorStatus(message) { lastStatus = message; }
    async function api(path, options) {
      if (path !== "/api/portal/v1/personnel-lifecycle/editor/validate" || options.method !== "POST") {
        throw new Error("unexpected endpoint");
      }
      capturedBody = options.body;
      const sent = JSON.parse(options.body);
      const nodes = sent.steps.map((step, index) => ({ ...step, position: index + 1 }));
      const edges = nodes.slice(0, -1).map((node, index) => ({
        id: "memory-edge-" + (index + 1),
        from: node.id,
        to: nodes[index + 1].id,
        type: "sequence",
      }));
      return {
        contractVersion: "o8-v0.1",
        model: "linear-v1",
        mode: "memory_only",
        source: "memory",
        status: "ready",
        valid: true,
        fingerprint: "a".repeat(64),
        draft: sent,
        nodes,
        edges,
        blockers: [],
        runtimeGates: ${JSON.stringify(runtimeGates)},
      };
    }
    ${validate}
  `, sandbox);
  await vm.runInContext("validatePersonnelLifecycleEditorDraft();", sandbox);
  const sent = JSON.parse(vm.runInContext("capturedBody", sandbox));
  assert.equal(sent.workflowCode, "onboarding.base");
  assert.equal(sent.title, "Café");
  assert.doesNotMatch(JSON.stringify(sent.steps), /memory-(?:node|edge)-/);
  assert.equal(vm.runInContext("state.personnelLifecycleEditorValidation.valid", sandbox), true);

  vm.runInContext(`state.personnelLifecycleEditorDraft.workflowCode = "Nicht erlaubt";
    capturedBody = ""; lastStatus = "";`, sandbox);
  await vm.runInContext("validatePersonnelLifecycleEditorDraft();", sandbox);
  assert.equal(vm.runInContext("capturedBody", sandbox), "");
  assert.match(vm.runInContext("lastStatus", sandbox), /Serverprüfung nicht gestartet/);
  assert.match(validate, /currentBody = JSON\.stringify\(normalizePersonnelLifecycleEditorDraft/);
});

test("O8 rendert Schrittinhalte XSS-sicher und hält alle Änderungen lokal", () => {
  const normalization = between(
    app,
    'const PERSONNEL_LIFECYCLE_EDITOR_CONTRACT_VERSION = "o8-v0.1";',
    "function clonePersonnelLifecycleEditorDraft",
  );
  const flowRenderer = between(
    app,
    "function renderPersonnelLifecycleEditorFlow()",
    "function renderPersonnelLifecycleEditorInspector()",
  );
  const draft = validDraft();
  draft.steps[0].title = '<img src=x onerror="alert(1)">';
  const sandbox = {
    state: { personnelLifecycleEditorDraft: draft, personnelLifecycleEditorSelectedStepId: "step-1" },
    elements: { personnelLifecycleEditorFlow: { innerHTML: "" } },
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]),
    escapeHtmlAttribute: (value) => String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]),
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    function canReadPersonnelLifecycleEditorWorkflowType() { return true; }
    ${normalization}
    ${flowRenderer}
    renderPersonnelLifecycleEditorFlow();
  `, sandbox);
  assert.match(sandbox.elements.personnelLifecycleEditorFlow.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(sandbox.elements.personnelLifecycleEditorFlow.innerHTML, /<img\b|<script\b/i);

  const requests = between(
    app,
    "async function loadPersonnelLifecycleEditorCatalog()",
    "function renderPersonnelWorkflowTasksImpl()",
  );
  const endpoints = [...requests.matchAll(/api\("([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(endpoints, [
    "/api/portal/v1/personnel-lifecycle/editor/catalog",
    "/api/portal/v1/personnel-lifecycle/editor/validate",
  ]);
  assert.match(requests, /editor\/validate", \{[\s\S]*?method: "POST",[\s\S]*?body,/);
  assert.doesNotMatch(requests, /localStorage|sessionStorage|indexedDB|customProcess|\/publish|\/archive|\/activate|\/run|\/trigger/);
});

test("O8 verdrahtet Auswahl, Reihenfolge, Quellwechsel und Verwerfbestätigung", () => {
  const handlers = between(
    app,
    'elements.openPersonnelLifecycleEditorButton?.addEventListener("click"',
    "elements.refreshServerDiagnosticsButton?.addEventListener",
  );
  assert.match(handlers, /requestClosePersonnelLifecycleEditor/);
  assert.match(handlers, /Den lokalen O8-Arbeitsentwurf verwerfen/);
  assert.match(handlers, /allowedResponsibilities[\s\S]*?step\.responsibilityClass = ""/);
  assert.match(handlers, /data-personnel-lifecycle-editor-step/);
  assert.match(handlers, /setPersonnelLifecycleEditorStepField\("type"/);
  assert.match(handlers, /setPersonnelLifecycleEditorStepField\("required"/);
  assert.match(handlers, /addPersonnelLifecycleEditorStep/);
  assert.match(handlers, /movePersonnelLifecycleEditorStep\(-1\)/);
  assert.match(handlers, /movePersonnelLifecycleEditorStep\(1\)/);
  assert.match(handlers, /removePersonnelLifecycleEditorStep/);
  assert.match(handlers, /resetPersonnelLifecycleEditorDraft/);
  assert.match(handlers, /validatePersonnelLifecycleEditorDraft/);

  const mutations = between(
    app,
    "function setPersonnelLifecycleEditorDraftField",
    "async function validatePersonnelLifecycleEditorDraft",
  );
  assert.match(mutations, /draft\.steps\.splice\(insertAt, 0, step\)/);
  assert.match(mutations, /\[draft\.steps\[index\], draft\.steps\[target\]\] =/);
  assert.match(mutations, /minimumSteps/);
  assert.match(mutations, /maximumSteps/);
});

test("O8 entfernt Entwurf und DOM bei Navigation, Logout sowie Identitäts- oder Rechtewechsel", () => {
  const visibility = between(app, "function applyRoleVisibility()", "async function bootstrapApplication()");
  assert.match(visibility, /lifecycleEditorActorAccessChanged/);
  assert.match(visibility, /personnelLifecycleEditorActorAccessKey\(\)/);
  assert.match(visibility, /clearPersonnelLifecycleEditorState/);
  const login = between(app, "function showLoginGate", "function hideLoginGate");
  assert.match(login, /clearPersonnelLifecycleEditorState/);
  const logout = between(app, "async function logoutPortal()", "function openAdminSetup()");
  assert.match(logout, /clearPersonnelLifecycleEditorState/);
  const navigation = between(app, "function setPersonnelAdministrationTab(tab)", "function populateCostCenterTypeSelect");
  assert.match(navigation, /normalized !== "workflows"[\s\S]*?clearPersonnelLifecycleEditorState/);
  const view = between(app, "function setView(view)", "function applyRequestedView(");
  assert.match(view, /view !== "personnelAdministration"[\s\S]*?clearPersonnelLifecycleEditorState/);
  const purge = between(
    app,
    "function purgePersonnelLifecycleEditorDom",
    "function markPersonnelLifecycleEditorDirty",
  );
  assert.match(purge, /personnelLifecycleEditorDraft = null/);
  assert.match(purge, /personnelLifecycleEditorValidation = null/);
  assert.match(purge, /personnelLifecycleEditorFlow\.innerHTML = ""/);
  assert.match(purge, /personnelLifecycleEditorRequestToken = null/);
  assert.match(purge, /personnelLifecycleEditorDialog\.close\(\)/);
});

test("O8-only öffnet den Editorbereich, aber weder Legacy-Instanzen noch Personalaufgaben", () => {
  const workflowAccess = between(
    app,
    "function canReadPersonnelWorkflowInstances()",
    "function canReadLifecycleOnboardingTasks()",
  );
  const taskAccess = between(
    app,
    "function canReadPersonnelTasks()",
    "const PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS",
  );
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(`
    const state = { personnelWorkflowInstanceCapabilities: { canRead: null } };
    function personnelLifecycleFoundationEnabled() { return true; }
    function hasGovernancePermission() { return false; }
    function canReadPersonnelLifecycleEditorCatalog() { return true; }
    function canReadLifecycleOnboardingTasks() { return false; }
    function canReadLifecycleOffboardingTasks() { return false; }
    function canReadLifecycleInterfaces() { return false; }
    function canReadLifecycleAutomationCatalog() { return false; }
    ${workflowAccess}
    ${taskAccess}
    result = {
      center: canOpenWorkflowCenter(),
      instances: canReadPersonnelWorkflowInstances(),
      tasks: canReadPersonnelTasks(),
    };
  `, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), {
    center: true,
    instances: false,
    tasks: false,
  });
  const workflowSection = between(
    html,
    '<section class="personnel-administration-section personnel-lifecycle-foundation personnel-workflow-instances"',
    '<section class="personnel-administration-section personnel-lifecycle-foundation personnel-workflow-tasks"',
  );
  assert.match(workflowSection, /class="hidden" id="personnelWorkflowInstanceWorkspace"/);
  const visibility = between(app, "function applyRoleVisibility()", "async function bootstrapApplication()");
  assert.match(visibility, /personnelWorkflowInstanceWorkspace[^\n]*!workflowInstanceAccess/);
  assert.match(visibility, /!workflowInstanceAccess[\s\S]*?clearPersonnelWorkflowInstanceState/);
  const navigation = between(app, "function setPersonnelAdministrationTab(tab)", "function populateCostCenterTypeSelect");
  assert.match(navigation, /normalized === "workflows" \|\| normalized === "tasks"[\s\S]*?canReadPersonnelWorkflowInstances/);
  assert.doesNotMatch(navigation, /normalized === "tasks" && canOpenWorkflowCenter\(\)/);
  const refresh = between(
    app,
    "elements.refreshPersonnelWorkflowTasksButton?.addEventListener",
    "elements.personnelWorkflowTaskList?.addEventListener",
  );
  assert.match(refresh, /if \(canReadPersonnelWorkflowInstances\(\)\)/);
  assert.doesNotMatch(refresh, /if \(canOpenWorkflowCenter\(\)\)/);
});

test("O8 bleibt auf 320 Pixel einspaltig, tastaturfähig und ohne horizontale Arbeitsfläche", () => {
  const o8Styles = between(styles, "/* O8:", "/* Ende O8-Editor. */");
  assert.match(o8Styles, /grid-template-columns:minmax\(230px,\.78fr\) minmax\(360px,1\.35fr\) minmax\(260px,\.9fr\)/);
  assert.match(o8Styles, /\.personnel-lifecycle-editor-flow button \{[\s\S]*?min-height:76px/);
  assert.match(o8Styles, /\.personnel-lifecycle-editor-step-actions button \{[\s\S]*?min-height:44px/);
  assert.match(o8Styles, /:focus-visible/);
  assert.match(o8Styles, /@media \(max-width:700px\) \{[\s\S]*?width:100vw;[\s\S]*?grid-template-columns:minmax\(0,1fr\)/);
  assert.match(o8Styles, /@media \(max-width:360px\) \{[\s\S]*?padding:12px/);
  assert.match(o8Styles, /@media \(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(o8Styles, /overflow-x\s*:\s*(?:auto|scroll)/);
});
