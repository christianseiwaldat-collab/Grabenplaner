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

test("O4-Aufgabenzugang bleibt vom allgemeinen Workflow-Center getrennt", () => {
  const access = between(
    app,
    "function canOpenWorkflowCenter()",
    "function canOpenPersonnelAdministrationView()",
  );
  assert.match(access, /function canAccessAssignedPersonnelLifecycleTasks\(\)/);
  assert.match(access, /user\?\.isEmployee === true/);
  assert.match(access, /user\?\.mustChangePassword !== true/);
  assert.match(access, /personnelLifecycleOnboardingTaskCapabilities\.canRead !== false/);
  assert.match(access, /return canReadPersonnelWorkflowInstances\(\)[\s\S]*?canReadLifecycleOnboardingTasks\(\)/);
  assert.doesNotMatch(
    between(app, "function canReadPersonnelTasks()", "const PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS"),
    /canOpenWorkflowCenter|canReadPersonnelLifecycleEditorCatalog/,
  );
  assert.doesNotMatch(access, /personnel:central:read|personnel:lifecycle:onboarding:close/);
});

test("O4-Aufgabenprojektion kopiert nur die feste Positivliste und sperrt ungültige Scopes", () => {
  const source = between(
    app,
    "function personnelWorkflowObject(value)",
    "function personnelWorkflowStepCount(value)",
  );
  const sandbox = {
    payload: {
      caseId: "case-o4-ui",
      runId: "run-o4-ui",
      stepId: "step-o4-ui",
      workflowCode: "onboarding.o4.ui",
      workflowTitle: "Synthetisches Onboarding",
      step: {
        title: "Unterlagen prüfen",
        position: 1,
        activatedAt: "2026-08-03T09:00:00.000Z",
        description: "must-not-pass",
      },
      subject: {
        displayName: "Synthetische Zielperson",
        employeeNumber: "O4-SUBJECT",
      },
      scope: { type: "department", locationId: "L-O4", departmentId: 91 },
      employeeNumber: "must-not-pass",
      protectedPayload: "must-not-pass",
      receiptSha256: "must-not-pass",
    },
    capabilities: {
      canReadOnboardingTasks: true,
      canCompleteOnboardingTasks: true,
      technicalAdmin: "must-not-pass",
    },
    result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}
    result = {
      task: normalizePersonnelLifecycleOnboardingTask(payload),
      capabilities: normalizePersonnelLifecycleOnboardingTaskCapabilities(capabilities),
    };`, sandbox);
  const result = JSON.parse(JSON.stringify(sandbox.result));
  assert.deepEqual(Object.keys(result.task), [
    "caseId", "runId", "stepId", "workflowCode", "workflowTitle",
    "title", "subject", "position", "activatedAt", "scope",
  ]);
  assert.deepEqual(result.task.subject, {
    displayName: "Synthetische Zielperson",
    employeeNumber: "O4-SUBJECT",
  });
  assert.deepEqual(result.capabilities, { canRead: true, canComplete: true });
  assert.equal(JSON.stringify(result).includes("must-not-pass"), false);

  sandbox.payload.scope = { type: "department", locationId: "L-O4", departmentId: null };
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleOnboardingTask(payload)", sandbox),
    /unvollständig/,
  );
});

test("O4-Aufgaben-UI verlangt eine ausdrückliche Erledigungsbestätigung", () => {
  const taskUi = between(
    app,
    "function renderPersonnelLifecycleOnboardingTasksMarkup()",
    "const PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_FIELD_LABELS",
  );
  assert.match(taskUi, /data-personnel-lifecycle-onboarding-task-complete/);
  assert.match(taskUi, /data-onboarding-task-confirm/);
  assert.match(taskUi, /task\.subject\.displayName/);
  assert.match(taskUi, /task\.subject\.employeeNumber/);
  assert.match(taskUi, /type="checkbox" required/);
  assert.match(taskUi, /Erledigung bestätigen/);
  assert.match(taskUi, /canComplete === true/);
  assert.doesNotMatch(taskUi, /<textarea\b|<select\b|data-(?:skip|not-applicable|exception|evidence)/i);
  assert.match(html, /M5 \/ O4 \/ O5 · kontrolliert/);
});

test("O4-Aufgaben laden und schreiben ausschließlich über die geschützten Endpunkte", () => {
  const flow = between(
    app,
    "function clearPersonnelLifecycleOnboardingTaskState",
    "function renderPersonnelAdministration()",
  );
  assert.match(flow, /api\("\/api\/portal\/v1\/personnel-lifecycle\/onboarding\/tasks"\)/);
  assert.match(flow, /normalizePersonnelLifecycleOnboardingTaskCapabilities/);
  assert.match(flow, /capabilities\.canRead/);
  assert.match(flow, /TaskCapabilities\.canComplete !== true/);
  assert.match(flow, /encodeURIComponent\(runId\).*encodeURIComponent\(stepId\).*\/complete/s);
  assert.match(flow, /method: "POST"/);
  assert.match(flow, /action: "complete"/);
  assert.match(flow, /evidenceReference: null/);
  assert.match(flow, /personnelLifecycleOnboardingTaskOperations\[key\]/);
  assert.match(flow, /\[403, 404, 409\]\.includes\(error\.status\)/);
  assert.doesNotMatch(flow, /action: "skip"|notApplicable:|exception:/);
});

test("O4-Aufgaben und Profilabschluss bleiben auf schmalen Ansichten ohne Mindestbreiten-Überlauf", () => {
  assert.match(styles, /@media \(max-width:900px\) \{[\s\S]*?\.personnel-lifecycle-onboarding-task-card form \{ flex-basis:100%; width:100%; min-width:0; \}/);
  assert.match(styles, /@media \(max-width:420px\) \{[\s\S]*?\.personnel-lifecycle-onboarding-task-card form \{ width:100%; min-width:0; \}/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.employee-onboarding-close-form \{ width:100%; max-width:100%;/);
});
