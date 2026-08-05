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

test("O5-Profilzugang verlangt das eigene vertrauliche Leserecht", () => {
  const access = between(
    app,
    "function canReadEmployeeOnboardingPreview()",
    "function canReadCandidatePreboarding()",
  );
  assert.match(access, /personnel:lifecycle:offboarding:confidential:read/);
  assert.match(access, /canReadCentralPersonnel\(\)/);
  assert.match(access, /canOpenEmployeeProfileFoundation[\s\S]*?canReadEmployeeOffboardingConfidential/);
  assert.doesNotMatch(access, /role === "developer"|role === "it_admin"/);
});

test("O5-Registerkarte und Browserzustand werden bei Rechteverlust vollständig entfernt", () => {
  assert.match(app, /id: "offboarding",[\s\S]*?endpointTab: "offboarding"[\s\S]*?canReadOffboardingConfidential/);
  const reset = between(
    app,
    "function employeeProfileSensitiveAccessWasExposed",
    "function invalidateEmployeeProfileData",
  );
  assert.match(reset, /employeeProfileSensitiveAccessWasExposed\("offboarding"\)/);
  assert.match(reset, /access\.offboarding !== true/);
  assert.match(reset, /clearEmployeeOffboardingState\(\)/);
  assert.match(reset, /offboarding: null/);
  assert.match(reset, /offboarding: initialTab === "offboarding"/);
});

test("O5-Aufgabenprojektion kopiert ausschließlich projektionsabhängige Positivlisten", () => {
  const source = between(
    app,
    "function personnelWorkflowObject(value)",
    "function personnelWorkflowStepCount(value)",
  );
  const sandbox = {
    payload: {
      runId: "opaque-run-o5",
      stepId: "opaque-step-o5",
      orderId: "opaque-order-o5",
      projection: "it_security_task",
      title: "Zugriff prüfen",
      status: "active",
      businessIdentifier: "business-o5",
      targetSystem: "synthetic-system",
      action: "disable_at_reference_time",
      executeAt: "2026-08-28T16:00:00.000Z",
      employeeNumber: "must-not-pass",
      exitReason: "must-not-pass",
      hrNote: "must-not-pass",
      protectedPayload: "must-not-pass",
      receiptSha256: "must-not-pass",
    },
    capabilities: {
      canReadOffboardingTasks: true,
      canCompleteOffboardingTasks: true,
      confidentialCaseAccess: "must-not-pass",
    },
    result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}
    result = {
      task: normalizePersonnelLifecycleOffboardingTask(payload),
      capabilities: normalizePersonnelLifecycleOffboardingTaskCapabilities(capabilities),
    };`, sandbox);
  const result = JSON.parse(JSON.stringify(sandbox.result));
  assert.deepEqual(Object.keys(result.task), [
    "runId",
    "stepId",
    "orderId",
    "projection",
    "title",
    "status",
    "businessIdentifier",
    "targetSystem",
    "action",
    "executeAt",
  ]);
  assert.deepEqual(result.capabilities, { canRead: true, canComplete: true });
  assert.equal(JSON.stringify(result).includes("must-not-pass"), false);

  sandbox.payload.projection = "offboarding_confidential";
  assert.throws(
    () => vm.runInContext("normalizePersonnelLifecycleOffboardingTask(payload)", sandbox),
    /unvollständig/,
  );
});

test("O5-Oberfläche trennt Vorbereitung, Freigaben und ausführbare Aufgaben", () => {
  const profileUi = between(
    app,
    "const EMPLOYEE_OFFBOARDING_STATE_LABELS",
    "function renderEmployeeProfileContent()",
  );
  assert.match(profileUi, /data-employee-offboarding-prepare/);
  assert.match(profileUi, /PREPARE_OFFBOARDING/);
  assert.match(profileUi, /RELEASE_OFFBOARDING_COMMUNICATION/);
  assert.match(profileUi, /CONFIRM_OFFBOARDING_INFORMATION/);
  assert.match(profileUi, /ACTIVATE_OFFBOARDING/);
  assert.match(profileUi, /CANCEL_OFFBOARDING/);
  assert.match(profileUi, /CLOSE_OFFBOARDING/);
  assert.match(profileUi, /offboarding-preparations/);
  assert.match(profileUi, /time-critical-approvals/);
  assert.match(profileUi, /communication-releases/);
  assert.match(profileUi, /information-confirmations/);
  assert.doesNotMatch(profileUi, /action:\s*"skip"|notApplicable|evidenceReference/);

  const taskUi = between(
    app,
    "const PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_FIELD_LABELS",
    "function renderPersonnelWorkflowTasks()",
  );
  assert.match(taskUi, /task\.status === "active"/);
  assert.match(taskUi, /data-personnel-lifecycle-offboarding-task-complete/);
  assert.match(taskUi, /data-offboarding-task-confirm/);
  assert.match(taskUi, /Bis zur Aktivierung nur Lesen/);
});

test("O5-Aufgaben nutzen nur den geschützten Auftragsendpunkt und keine vertraulichen Fallparameter", () => {
  const flow = between(
    app,
    "function clearPersonnelLifecycleOffboardingTaskState",
    "function renderPersonnelAdministration()",
  );
  assert.match(flow, /api\("\/api\/portal\/v1\/personnel-lifecycle\/offboarding\/tasks"\)/);
  assert.match(flow, /offboarding\/tasks\/\$\{encodeURIComponent\(runId\)\}\/\$\{encodeURIComponent\(stepId\)\}\/completions/);
  assert.match(flow, /action: "complete"/);
  assert.match(flow, /evidenceReference: null/);
  assert.match(flow, /\[403, 404, 409\]\.includes\(error\.status\)/);
  assert.doesNotMatch(flow, /caseId|employeeNumber|exitReason|hrNote|action: "skip"/);
  assert.match(html, /M5 \/ O4 \/ O5 · kontrolliert/);
});

test("O5-Profil und Aufgaben bleiben bei 320 Pixel ohne feste Querachse", () => {
  assert.match(styles, /\.employee-offboarding-workspace[^}]*min-width:0[^}]*max-width:100%/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.employee-offboarding-package-list \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.employee-offboarding-action > button \{ justify-self:stretch; width:100%; \}/);
  assert.doesNotMatch(
    styles.slice(styles.indexOf(".employee-offboarding-workspace")),
    /\.employee-offboarding[^{}]*\{[^}]*overflow-x\s*:/,
  );
});
