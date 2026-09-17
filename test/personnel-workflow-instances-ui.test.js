"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const styles = read("public/styles.css");
const architecture = read("docs/PERSONALMODUL-ZIELARCHITEKTUR-v0.1.md");
const persistenceAudit = read("scripts/audit-persistence-coupling.js");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("M5-UI zeigt Workflow-Instanzen und Aufgaben ausschließlich read-only", () => {
  const workflow = between(
    html,
    '<section class="personnel-administration-section personnel-lifecycle-foundation personnel-workflow-instances"',
    '<section class="personnel-administration-section personnel-learning-catalog"',
  );
  const tasks = between(
    html,
    '<section class="personnel-administration-section personnel-lifecycle-foundation personnel-workflow-tasks"',
    '<section class="personnel-administration-section position-management-section"',
  );
  for (const id of [
    "personnelWorkflowInstanceStatusFilter",
    "refreshPersonnelWorkflowInstancesButton",
    "personnelWorkflowInstanceStatus",
    "personnelWorkflowInstanceSummary",
    "personnelWorkflowInstanceList",
    "personnelWorkflowTaskStatus",
    "refreshPersonnelWorkflowTasksButton",
    "personnelWorkflowTaskList",
  ]) assert.match(`${workflow}\n${tasks}`, new RegExp(`id="${id}"`));
  assert.doesNotMatch(`${workflow}\n${tasks}`, /<form\b|type="submit"|Prozess starten|Workflow starten|Aufgabe abschließen/i);
  assert.match(workflow, /übernimmt keine bestehenden Läufe automatisch/);
  assert.match(tasks, /Fristen und Eskalationen werden nicht automatisiert/);
});

test("M5-Aufgabenzugang nutzt nur Workflow-Leserecht und Server-Capability", () => {
  const access = between(
    app,
    "function canReadPersonnelWorkflowInstances()",
    "function canReadLifecycleOnboardingTasks()",
  );
  assert.match(access, /hasGovernancePermission\("personnel:workflows:read"\)/);
  assert.match(access, /personnelWorkflowInstanceCapabilities\.canRead !== false/);
  assert.match(access, /return canReadPersonnelWorkflowInstances\(\) \|\| canReadPersonnelLifecycleEditorCatalog\(\)/);
  assert.doesNotMatch(access, /processes:write|personnel:central:read|canReadCentralPersonnel/);

  const taskAccess = between(
    app,
    "function canReadPersonnelTasks()",
    "const PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS",
  );
  assert.match(taskAccess, /return canReadPersonnelWorkflowInstances\(\)/);
  assert.doesNotMatch(taskAccess, /canOpenWorkflowCenter|canReadPersonnelLifecycleEditorCatalog/);

  const capabilities = between(
    app,
    "function defaultPersonnelWorkflowInstanceCapabilities()",
    "function personnelWorkflowObject(",
  );
  assert.match(capabilities, /canRead: submitted\.canReadInstances === true/);
  assert.doesNotMatch(capabilities, /submitted\.canRead === true/);
  assert.match(app, /if \(!capabilities\.canRead\) \{[\s\S]*?clearPersonnelWorkflowInstanceState/);
  assert.match(
    architecture,
    /zentrale Personal-Leseberechtigung[\s\S]{0,120}nicht als zusätzliche M5-Lesefreigabe verlangt/,
  );
});

test("M5-Liste lädt ausschließlich den geschützten GET-Endpunkt", () => {
  const loader = between(
    app,
    "async function loadPersonnelWorkflowInstances(",
    "function personnelLearningModuleTypeLabel(",
  );
  assert.match(loader, /api\("\/api\/portal\/v1\/personnel-lifecycle\/workflow-instances"\)/);
  assert.doesNotMatch(loader, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(loader, /result\?\.items/);
  assert.match(loader, /if \(!personnelLifecycleFoundationEnabled\(\)[\s\S]*?!hasGovernancePermission\("personnel:workflows:read"\)\) \{[\s\S]*?während des Ladens entzogen/);
  assert.match(
    app,
    /normalized === "workflows" \|\| normalized === "tasks"[\s\S]{0,100}canReadPersonnelWorkflowInstances\(\)/,
  );
});

test("M5-Renderer verwendet eine Positivliste ohne Fachobjekt- oder Belegdaten", () => {
  const normalization = between(
    app,
    "function defaultPersonnelWorkflowInstanceCapabilities()",
    "function normalizePersonnelLifecycleOnboardingTaskCapabilities(",
  );
  const rendering = `${normalization}\n${between(
    app,
    "function personnelWorkflowStepCount(",
    "function renderPersonnelLifecycleOnboardingTasksMarkup(",
  )}\n${between(
    app,
    "function renderPersonnelWorkflowInstanceOverview(",
    "function clearPersonnelWorkflowInstanceState(",
  )}`;
  for (const forbidden of [
    "candidateId",
    "applicationId",
    "employeeNumber",
    "operationId",
    "requestSha256",
    "receiptSha256",
    "startedBy",
    "assignedBy",
    "completionNote",
  ]) assert.doesNotMatch(rendering, new RegExp(forbidden));
  for (const nonContractFallback of [
    "instance.workflowTitle",
    "instance.processTitle",
    "instance.createdAt",
    "instance.completedAt",
    "instance.id",
    "publication.id",
    "publication.scope",
    "activeStep.id",
    "activeStep.description",
    "scope.locationId",
    "scope.departmentId",
    "scope.locationName",
    "scope.departmentName",
  ]) assert.doesNotMatch(rendering, new RegExp(nonContractFallback.replace(".", "\\.")));
  for (const allowed of [
    "workflowTitle",
    "workflowType",
    "versionNumber",
    "subjectType",
    "scopeLabel",
    "startedAt",
    "resolvedAt",
  ]) assert.match(rendering, new RegExp(allowed));
  assert.match(rendering, /Fachobjekt-Schlüssel und Belegdaten bleiben ausgeblendet/);
});

test("M5-Karten bleiben auf schmalen Ansichten ohne Tabellenachse lesbar", () => {
  const workflowStyles = between(
    styles,
    ".personnel-workflow-instances,",
    ".personnel-dashboard-heading {",
  );
  assert.match(workflowStyles, /min-width:0/);
  assert.doesNotMatch(workflowStyles, /overflow-x\s*:/);
  assert.match(styles, /@media \(max-width:900px\) \{[\s\S]*?\.personnel-workflow-instance-meta \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-workflow-summary,\.personnel-workflow-instance-meta \{ grid-template-columns:1fr; \}/);
});

test("M5-Architektur dokumentiert additive Bindung, API und Automatisierungsgrenze", () => {
  assert.match(architecture, /v0\.89-personnel-workflow-instances/);
  assert.match(architecture, /custom_process_run_bindings/);
  assert.match(architecture, /custom_process_run_step_assignments/);
  assert.match(architecture, /GET `?\/workflow-instances`?/);
  assert.match(architecture, /POST `?\/workflow-instances`?/);
  assert.match(architecture, /\{ operationId, publicationId, subject, assignments \}/);
  assert.match(architecture, /Idempotency-Replayed: true/);
  assert.match(architecture, /\{ instance, replayed, capabilities \}/);
  assert.match(architecture, /keine (?:neue )?(?:Prozess-?)?automatik/i);
});

test("M5-Audit-Inventar klassifiziert das neue SQLite-Schema und den erweiterten Dialektplan", () => {
  assert.match(
    persistenceAudit,
    /"lib\/persistence\/sqlite\/operations\/personnel-workflow-instance-schema\.js"/,
  );
  for (const expected of [
    "PHASE_4_EXPECTED_STATEMENT_COUNT = 1405",
    "PHASE_4_EXPECTED_DIALECT_VARIANT_COUNT = 1361",
    "PHASE_4_EXPECTED_NAMED_DOLLAR_PARAMETER_STATEMENT_COUNT = 1288",
    "PHASE_5_EXPECTED_PORTABLE_DIALECT_COUNT = 1280",
    "PHASE_5_EXPECTED_OVERRIDE_DIALECT_COUNT = 125",
  ]) assert.match(persistenceAudit, new RegExp(expected));
});
