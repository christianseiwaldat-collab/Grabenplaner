"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const styles = read("public/styles.css");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

function o4OnboardingPayload({ activeCase = null, formAvailable = true } = {}) {
  const packageEntry = ({ publicationId, processId, workflowCode, title, stepReference, actorId }) => ({
    publicationId,
    processId,
    sourceRevision: 1,
    versionNumber: 1,
    workflowCode,
    title,
    authorityLevel: "central",
    requirementKind: "mandatory",
    scope: { type: "company", locationId: null, departmentId: null },
    publishedAt: "2026-08-03T08:00:00.000Z",
    reviewStatus: "requires_new_lifecycle_review",
    assignments: [{
      stepReference,
      title: `${title} Schritt`,
      sortOrder: 1,
      state: "selection_required",
      responsibility: { type: "role", reference: "hr", label: "PL" },
      eligibleRecipients: [{ actorId, displayName: `Person ${actorId}`, privateEmail: "must-not-pass@example.invalid" }],
      selectedAssignee: null,
      protectedPayload: "must-not-pass",
    }],
  });
  return {
    profile: {
      employeeNumber: "O4-001",
      displayName: "Mara Muster",
      active: true,
      organization: {},
    },
    tabs: { onboarding: { available: true } },
    capabilities: {
      canReadOnboardingPreview: true,
      canStartOnboarding: true,
      canCloseOnboarding: activeCase?.closeAvailable === true,
    },
    onboardingPreview: {
      contractVersion: "o3-v0.1",
      mode: "read_only_onboarding_profile_preview",
      caseType: "onboarding",
      subject: { employeeNumber: "O4-001" },
      scope: { type: "company", locationId: null, departmentId: null },
      packageResolution: {
        requiredPackageFamilies: ["personnel_administration", "base_security_privacy"],
        selectedBindings: [],
        conflicts: [],
        packages: [
          packageEntry({
            publicationId: "publication-personnel",
            processId: "process-personnel",
            workflowCode: "ONBOARD-PERSONNEL",
            title: "Personaladministration Basis",
            stepReference: "personnel-step",
            actorId: "HR-ONE",
          }),
          packageEntry({
            publicationId: "publication-security",
            processId: "process-security",
            workflowCode: "ONBOARD-SECURITY",
            title: "Sicherheit Basis",
            stepReference: "security-step",
            actorId: "SEC-ONE",
          }),
        ],
      },
      assignmentPreview: {
        packageCount: 2,
        stepCount: 2,
        fixedRecipientCount: 0,
        selectionRequiredCount: 2,
        unresolvedCount: 0,
        systemStepCount: 0,
        selectedAssignmentCount: 0,
      },
      blockers: [{ code: "assignment_selection_required" }],
      startAllowed: false,
      casePersisted: false,
      instanceCount: 0,
      taskCount: 0,
      assignmentCount: 0,
    },
    onboardingExecution: {
      contractVersion: "o4-v0.1",
      mode: "controlled_onboarding_start",
      previewSha256: "a".repeat(64),
      formAvailable,
      requiredConfirmation: "START_ONBOARDING",
      activeCase,
      protectedPayload: "must-not-pass",
    },
  };
}

test("M7-Profilregister verwenden eine feste GET-Positivliste und laden ausschließlich lazy", () => {
  const contract = between(app, "const EMPLOYEE_PROFILE_TABS", "const EMPLOYEE_PROFILE_MASTER_DATA_FIELDS");
  assert.match(contract, /id: "overview", endpointTab: "overview", capability: "canReadOverview"/);
  assert.match(contract, /id: "masterData", endpointTab: "master_org", capability: "canReadMasterOrg"/);
  assert.match(contract, /id: "documents", endpointTab: "documents", capability: "canReadDocuments"/);
  assert.match(contract, /id: "onboarding", endpointTab: "onboarding", capability: "canReadOnboardingPreview"/);
  assert.match(contract, /id: "offboarding",[\s\S]*?endpointTab: "offboarding",[\s\S]*?capability: "canReadOffboardingConfidential"/);
  for (const locked of ["training", "history"]) {
    assert.match(contract, new RegExp(`id: "${locked}", label:`));
    assert.doesNotMatch(contract, new RegExp(`id: "${locked}", endpointTab:`));
  }

  const loader = between(app, "async function loadEmployeeProfileTab", "function loadEmployeeProfileOverview");
  assert.match(loader, /profile\?tab=\$\{definition\.endpointTab\}/);
  assert.match(loader, /!definition\?\.endpointTab/);
  assert.match(loader, /state\.employeeProfileTabAvailability\[tabId\] !== true/);
  assert.match(loader, /employeeProfileTabHasData\(tabId\)/);
  assert.doesNotMatch(loader, /method\s*:|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b/);

  const opener = between(app, "function openEmployeeProfile", "function closeEmployeeProfile");
  assert.match(opener, /canOpenStandardEmployeeProfileFoundation\(\)[\s\S]*?"overview"[\s\S]*?canReadEmployeeOnboardingPreview\(\)[\s\S]*?"onboarding"/);
  assert.match(opener, /loadEmployeeProfileTab\(initialTab, normalizedEmployeeNumber\)/);
  assert.doesNotMatch(opener, /master_org|tab=documents/);
});

test("M7-Stammdaten- und Dokumentnormalisierung kopiert nur harte Positivlisten", () => {
  const normalizers = between(app, "function normalizeEmployeeProfileHeader", "function employeeProfileInitials");
  assert.match(normalizers, /EMPLOYEE_PROFILE_MASTER_DATA_FIELDS\.flatMap/);
  assert.match(normalizers, /employeeProfileProjectedPath\(source, definition\.key\)/);
  assert.doesNotMatch(normalizers, /Object\.entries\(source\)|\.\.\.source/);
  assert.match(normalizers, /visibility !== "hr_confidential"/);
  for (const allowed of [
    "id", "status", "category", "visibility", "title", "documentDate", "description",
    "originalFilename", "detectedMime", "byteSize", "currentVersion", "revision",
    "archivedAt", "createdAt", "updatedAt",
  ]) assert.match(normalizers, new RegExp(`\\b${allowed}\\b`), allowed);
  for (const forbidden of ["storageKey", "storage_key", "sha256", "receiptSha256", "actorEmployeeNumber", "protectedPayload", "protected_payload", "content"]) {
    assert.doesNotMatch(normalizers, new RegExp(`\\b${forbidden}\\b`, "i"), forbidden);
  }
});

test("O3-Onboarding-Normalisierung ist fail-closed und kopiert nur die Leseprojektion", () => {
  const normalizerSource = [
    between(app, "const EMPLOYEE_PROFILE_TABS", "const EMPLOYEE_PROFILE_MASTER_DATA_FIELDS"),
    between(app, "function normalizeEmployeeProfileHeader", "function normalizeEmployeeProfileOverview"),
    between(app, "const EMPLOYEE_ONBOARDING_ASSIGNMENT_STATES", "function employeeProfileInitials"),
  ].join("\n");
  const payload = {
    profile: {
      employeeNumber: "O3-001",
      displayName: "Mara Muster",
      active: true,
      organization: {},
      protectedPayload: "must-not-pass",
    },
    tabs: { onboarding: { available: true } },
    capabilities: { canReadOnboardingPreview: true },
    onboardingPreview: {
      contractVersion: "o3-v0.1",
      mode: "read_only_onboarding_profile_preview",
      caseType: "onboarding",
      subject: { employeeNumber: "O3-001", internalState: "must-not-pass" },
      scope: { type: "company", locationId: null, departmentId: null },
      packageResolution: {
        requiredPackageFamilies: ["personnel_administration"],
        selectedBindings: [],
        conflicts: [],
        packages: [{
          publicationId: "publication-1",
          processId: "process-1",
          sourceRevision: 1,
          versionNumber: 1,
          workflowCode: "ONBOARD-BASE",
          title: "Basispaket",
          authorityLevel: "central",
          requirementKind: "mandatory",
          scope: { type: "company", locationId: null, departmentId: null },
          publishedAt: "2026-08-03T08:00:00.000Z",
          reviewStatus: "requires_new_lifecycle_review",
          protectedPayload: "must-not-pass",
          assignments: [{
            stepReference: "welcome",
            title: "Willkommen",
            sortOrder: 1,
            state: "selection_required",
            responsibility: { type: "role", reference: "hr", label: "PL" },
            eligibleRecipients: [{
              actorId: "HR-001",
              displayName: "Hanna Personal",
              privateEmail: "must-not-pass@example.invalid",
            }],
            selectedAssignee: null,
            description: "must-not-pass",
          }],
        }],
      },
      assignmentPreview: {
        packageCount: 1,
        stepCount: 1,
        fixedRecipientCount: 0,
        selectionRequiredCount: 1,
        unresolvedCount: 0,
        systemStepCount: 0,
        selectedAssignmentCount: 0,
      },
      blockers: [{ code: "assignment_selection_required", internalNote: "must-not-pass" }],
      startAllowed: false,
      casePersisted: false,
      instanceCount: 0,
      taskCount: 0,
      assignmentCount: 0,
      receiptSha256: "must-not-pass",
    },
  };
  const sandbox = { payload, result: null };
  vm.createContext(sandbox);
  vm.runInContext(`${normalizerSource}\nresult = normalizeEmployeeProfileOnboarding(payload, "O3-001");`, sandbox);
  const projected = JSON.parse(JSON.stringify(sandbox.result));
  const serialized = JSON.stringify(projected);
  assert.equal(projected.onboardingPreview.contractVersion, "o3-v0.1");
  assert.equal(projected.onboardingPreview.startAllowed, false);
  assert.equal(projected.onboardingPreview.assignmentPreview.selectedAssignmentCount, 0);
  assert.equal(projected.onboardingPreview.packageResolution.packages[0]
    .assignments[0].selectedAssignee, null);
  for (const forbidden of ["must-not-pass", "protectedPayload", "privateEmail", "description", "receiptSha256", "internalNote"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const invalid = JSON.parse(JSON.stringify(payload));
  invalid.onboardingPreview.packageResolution.packages[0]
    .assignments[0].selectedAssignee = { actorId: "HR-001" };
  sandbox.payload = invalid;
  assert.throws(
    () => vm.runInContext('normalizeEmployeeProfileOnboarding(payload, "O3-001")', sandbox),
    /Zuweisungsvorschau|Empfängerauflösung/,
  );
});

test("O4-Onboarding-Ausführung wird optional, fail-closed und strikt allowlisted normalisiert", () => {
  const normalizerSource = [
    between(app, "const EMPLOYEE_PROFILE_TABS", "const EMPLOYEE_PROFILE_MASTER_DATA_FIELDS"),
    between(app, "function normalizeEmployeeProfileHeader", "function normalizeEmployeeProfileOverview"),
    between(app, "const EMPLOYEE_ONBOARDING_ASSIGNMENT_STATES", "function employeeProfileInitials"),
  ].join("\n");
  const payload = o4OnboardingPayload();
  const sandbox = { payload, result: null };
  vm.createContext(sandbox);
  vm.runInContext(`${normalizerSource}\nresult = normalizeEmployeeProfileOnboarding(payload, "O4-001");`, sandbox);
  const projected = JSON.parse(JSON.stringify(sandbox.result));
  assert.equal(projected.capabilities.canStartOnboarding, true);
  assert.deepEqual(projected.onboardingExecution, {
    contractVersion: "o4-v0.1",
    mode: "controlled_onboarding_start",
    previewSha256: "a".repeat(64),
    formAvailable: true,
    requiredConfirmation: "START_ONBOARDING",
    activeCase: null,
  });
  assert.equal(JSON.stringify(projected).includes("must-not-pass"), false);

  payload.onboardingExecution.previewSha256 = "not-a-receipt";
  assert.throws(
    () => vm.runInContext('normalizeEmployeeProfileOnboarding(payload, "O4-001")', sandbox),
    /Ausführungsprojektion/,
  );

  sandbox.payload = o4OnboardingPayload({
    formAvailable: false,
    activeCase: {
      caseId: "case-001",
      state: "active",
      createdAt: null,
      startedAt: "2026-08-03T08:05:00.000Z",
      completedAt: null,
      packageCount: 2,
      taskCount: 4,
      completedTaskCount: 1,
      closeAvailable: false,
      employeeName: "must-not-pass",
      protectedPayload: "must-not-pass",
    },
  });
  vm.runInContext('result = normalizeEmployeeProfileOnboarding(payload, "O4-001")', sandbox);
  const activeProjection = JSON.parse(JSON.stringify(sandbox.result.onboardingExecution.activeCase));
  assert.deepEqual(Object.keys(activeProjection), [
    "caseId", "state", "createdAt", "startedAt", "completedAt",
    "packageCount", "taskCount", "completedTaskCount", "closeAvailable",
  ]);
  assert.equal(JSON.stringify(activeProjection).includes("must-not-pass"), false);

  sandbox.payload = o4OnboardingPayload({
    formAvailable: false,
    activeCase: {
      caseId: "case-close",
      state: "active",
      createdAt: "2026-08-03T08:00:00.000Z",
      startedAt: "2026-08-03T08:05:00.000Z",
      completedAt: null,
      packageCount: 2,
      taskCount: 4,
      completedTaskCount: 4,
      closeAvailable: true,
    },
  });
  vm.runInContext('result = normalizeEmployeeProfileOnboarding(payload, "O4-001")', sandbox);
  assert.equal(sandbox.result.onboardingExecution.activeCase.closeAvailable, true);
  sandbox.payload.capabilities.canCloseOnboarding = false;
  assert.throws(
    () => vm.runInContext('normalizeEmployeeProfileOnboarding(payload, "O4-001")', sandbox),
    /Abschlussfreigabe/,
  );
});

test("M7-Lese-Renderer bleiben ohne Mutation und technische Nachweise", () => {
  const documentRenderers = between(app, "function renderEmployeeProfileMasterData", "const EMPLOYEE_ONBOARDING_BLOCKER_LABELS");
  const previewRenderer = between(app, "function renderEmployeeProfileOnboardingPreview", "const EMPLOYEE_ONBOARDING_START_FAMILY_LABELS");
  assert.match(documentRenderers, /renderEmployeeProfileDocuments/);
  assert.match(previewRenderer, /Geschützte Lesevorschau/);
  assert.match(previewRenderer, /keinen Startknopf, keine automatische Verantwortlichenwahl/);
  assert.match(documentRenderers, /ausschließlich freigegebene Metadaten und Versionsstände/);
  assert.match(documentRenderers, /Dateiinhalte, Speicherpfade und technische Prüfnachweise werden nicht geladen/);
  assert.doesNotMatch(`${documentRenderers}\n${previewRenderer}`, /<form\b|<input\b|<textarea\b|<select\b|<a\b|href=|type="submit"|data-(?:save|delete|archive|upload)-/i);
  assert.doesNotMatch(`${documentRenderers}\n${previewRenderer}`, /storageKey|storage_key|sha256|receipt|protectedPayload|protected_payload/i);
});

test("O4-Startformular bleibt leer und erzeugt nur den expliziten POST-Vertrag", () => {
  const normalizerSource = [
    between(app, "const EMPLOYEE_PROFILE_TABS", "const EMPLOYEE_PROFILE_MASTER_DATA_FIELDS"),
    between(app, "function normalizeEmployeeProfileHeader", "function normalizeEmployeeProfileOverview"),
    between(app, "const EMPLOYEE_ONBOARDING_ASSIGNMENT_STATES", "function employeeProfileInitials"),
  ].join("\n");
  const startSource = between(
    app,
    "const EMPLOYEE_ONBOARDING_START_FAMILY_LABELS",
    "function renderEmployeeProfileContent",
  );
  let uuidCounter = 0;
  const sandbox = {
    payload: o4OnboardingPayload(),
    state: {
      employeeProfileEmployeeNumber: "O4-001",
      employeeOnboardingStartDraft: null,
      portalSession: { user: { employeeNumber: "HR-001", fullName: "Hanna Personal" } },
    },
    crypto: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    },
    escapeHtml: (value) => String(value ?? ""),
    escapeHtmlAttribute: (value) => String(value ?? ""),
    employeeProfileFormatTimestamp: (value) => String(value ?? ""),
    result: null,
    preview: null,
    markup: "",
    request: null,
    replay: null,
    changed: null,
    supplemental: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${normalizerSource}\n${startSource}
    result = normalizeEmployeeProfileOnboarding(payload, "O4-001");
    preview = { ...result.onboardingPreview, onboardingExecution: result.onboardingExecution, canStartOnboarding: result.capabilities.canStartOnboarding };
    markup = renderEmployeeOnboardingStartForm(preview);`, sandbox);
  assert.equal((sandbox.markup.match(/type="date"/g) || []).length, 3);
  assert.equal((sandbox.markup.match(/data-onboarding-family-code=/g) || []).length, 2);
  assert.equal((sandbox.markup.match(/value=""/g) || []).length >= 5, true);
  assert.equal((sandbox.markup.match(/data-onboarding-assignment-step=/g) || []).length, 2);
  assert.equal(sandbox.markup.includes("a".repeat(64)), false, "Vorschaubeleg bleibt aus dem DOM");

  vm.runInContext(`
    const draft = employeeOnboardingStartDraftFor(preview);
    draft.packageSelections.personnel_administration = "publication-personnel";
    draft.packageSelections.base_security_privacy = "publication-security";
    draft.referenceDates = {
      contractualEntryDate: "2026-09-01",
      firstWorkingDay: "2026-09-02",
      onboardingTargetDate: "2026-09-30",
    };
    draft.packageReviews = { "publication-personnel": true, "publication-security": true };
    markup = renderEmployeeOnboardingStartForm(preview);
  `, sandbox);
  assert.equal((sandbox.markup.match(/data-onboarding-assignment-step=/g) || []).length, 2);
  assert.doesNotMatch(sandbox.markup, /<option value="(?:HR-ONE|SEC-ONE)" selected/);
  assert.throws(
    () => vm.runInContext("buildEmployeeOnboardingStartRequest(preview, employeeOnboardingStartDraftFor(preview))", sandbox),
    /ausdrücklich eine geeignete Person auswählen/,
  );

  vm.runInContext(`
    const readyDraft = employeeOnboardingStartDraftFor(preview);
    readyDraft.referenceDates = {
      contractualEntryDate: "2026-09-01",
      firstWorkingDay: "2026-09-02",
      onboardingTargetDate: "2026-09-30",
    };
    readyDraft.packageReviews = { "publication-personnel": true, "publication-security": true };
    readyDraft.assignments[employeeOnboardingAssignmentDraftKey("publication-personnel", "personnel-step")] = "HR-ONE";
    readyDraft.assignments[employeeOnboardingAssignmentDraftKey("publication-security", "security-step")] = "SEC-ONE";
    for (const field of EMPLOYEE_ONBOARDING_CONFIRMATION_FIELDS) readyDraft.confirmations[field] = true;
    readyDraft.finalConfirmation = true;
    const body = buildEmployeeOnboardingStartRequest(preview, readyDraft);
    request = employeeOnboardingStartRequestWithOperation(readyDraft, body);
    replay = employeeOnboardingStartRequestWithOperation(readyDraft, body);
    readyDraft.referenceDates.onboardingTargetDate = "2026-10-01";
    changed = employeeOnboardingStartRequestWithOperation(
      readyDraft,
      buildEmployeeOnboardingStartRequest(preview, readyDraft),
    );
  `, sandbox);
  const request = JSON.parse(JSON.stringify(sandbox.request));
  const replay = JSON.parse(JSON.stringify(sandbox.replay));
  const changed = JSON.parse(JSON.stringify(sandbox.changed));
  assert.deepEqual(Object.keys(request), [
    "operationId", "expectedPreviewSha256", "responsibleActorId", "confirmation",
    "confirmations", "referenceDates", "packageBindings",
  ]);
  assert.equal(request.expectedPreviewSha256, "a".repeat(64));
  assert.equal(request.responsibleActorId, "HR-001");
  assert.equal(request.confirmation, "START_ONBOARDING");
  assert.deepEqual(request.confirmations, {
    responsibility: true,
    packages: true,
    lifecycleReviews: true,
    assignments: true,
    atomicStart: true,
  });
  assert.deepEqual(request.packageBindings.map(({ publicationId, familyCodes, reviewConfirmed, assignments }) => ({
    publicationId, familyCodes, reviewConfirmed, assignments,
  })), [
    {
      publicationId: "publication-personnel",
      familyCodes: ["personnel_administration"],
      reviewConfirmed: true,
      assignments: [{ stepReference: "personnel-step", assigneeActorId: "HR-ONE" }],
    },
    {
      publicationId: "publication-security",
      familyCodes: ["base_security_privacy"],
      reviewConfirmed: true,
      assignments: [{ stepReference: "security-step", assigneeActorId: "SEC-ONE" }],
    },
  ]);
  assert.equal(replay.operationId, request.operationId, "identischer Netzretry behält die Operation-ID");
  assert.notEqual(changed.operationId, request.operationId, "geänderter Request erhält eine neue Operation-ID");
  assert.doesNotMatch(JSON.stringify(request), /offboarding|notification|protectedPayload/i);

  vm.runInContext(`
    preview.packageResolution.packages.push({
      publicationId: "publication-supplemental",
      processId: "process-supplemental",
      sourceRevision: 1,
      versionNumber: 2,
      workflowCode: "ONBOARD-LOCAL",
      title: "Standort-Ergänzung",
      authorityLevel: "local",
      requirementKind: "supplemental",
      scope: { type: "location", locationId: "L1", departmentId: null },
      publishedAt: "2026-08-03T08:00:00.000Z",
      reviewStatus: "requires_new_lifecycle_review",
      assignments: [{
        stepReference: "local-step",
        title: "Lokale Einführung",
        sortOrder: 1,
        state: "selection_required",
        responsibility: { type: "role", reference: "manager", label: "Filialleitung" },
        eligibleRecipients: [{ actorId: "LOCAL-ONE", displayName: "Lokale Person" }],
        selectedAssignee: null,
      }],
    });
    const supplementalDraft = employeeOnboardingStartDraftFor(preview);
    supplementalDraft.packageReviews["publication-supplemental"] = true;
    supplementalDraft.assignments[employeeOnboardingAssignmentDraftKey("publication-supplemental", "local-step")] = "LOCAL-ONE";
    supplemental = buildEmployeeOnboardingStartRequest(preview, supplementalDraft);
  `, sandbox);
  const supplemental = JSON.parse(JSON.stringify(sandbox.supplemental));
  assert.equal(supplemental.packageBindings.length, 3);
  assert.deepEqual(
    supplemental.packageBindings.find(({ publicationId }) => publicationId === "publication-supplemental"),
    {
      publicationId: "publication-supplemental",
      versionNumber: 2,
      familyCodes: [],
      reviewConfirmed: true,
      assignments: [{ stepReference: "local-step", assigneeActorId: "LOCAL-ONE" }],
    },
  );

  vm.runInContext(`
    const duplicateDraft = employeeOnboardingStartDraftFor(preview);
    duplicateDraft.packageSelections.base_security_privacy = "publication-personnel";
  `, sandbox);
  assert.throws(
    () => vm.runInContext("buildEmployeeOnboardingStartRequest(preview, employeeOnboardingStartDraftFor(preview))", sandbox),
    /anderes unternehmensweites Pflichtpaket/,
  );
});

test("O4-Submit sperrt Doppelclicks und leert bei Drift oder Rechteverlust", () => {
  const mutation = between(app, "async function submitEmployeeOnboardingStart", "function renderEmployeeProfileContent");
  assert.match(mutation, /if \(!draft \|\| draft\.pending\) return/);
  assert.match(mutation, /draft\.pending = true/);
  assert.match(mutation, /\/onboarding-starts/);
  assert.match(mutation, /method: "POST"/);
  assert.match(mutation, /\[403, 409\]\.includes\(error\.status\)/);
  assert.match(mutation, /clearEmployeeOnboardingStartState\(\)/);
  assert.match(mutation, /reloadEmployeeOnboardingProjection\(employeeNumber\)/);
  assert.match(mutation, /employeeOnboardingStartContextIsCurrent/);
  assert.match(mutation, /data-employee-onboarding-close-form/);
  assert.match(mutation, /\/onboarding\/cases\/\$\{encodeURIComponent\(caseId\)\}\/close/);
  assert.match(mutation, /confirmation: "CLOSE_ONBOARDING"/);
  assert.match(mutation, /evidenceReference: null/);
  assert.match(mutation, /employeeOnboardingCloseContextIsCurrent/);

  const lifecycle = between(app, "function syncEmployeeProfileWorkspace", "function renderCostCenterTypes");
  assert.match(lifecycle, /tabId === "onboarding"\) clearEmployeeOnboardingStartState\(\)/);
  assert.match(lifecycle, /function resetEmployeeProfileData[\s\S]*?clearEmployeeOnboardingStartState\(\)/);
  const logout = between(app, "async function logoutPortal", "function openAdminSetup");
  assert.match(logout, /clearEmployeeOnboardingStartState\(\)/);
});

test("O4 zeigt minimierten Fallstatus und den Abschluss nur nach Serverfreigabe", () => {
  const activeCaseRenderer = between(
    app,
    "function renderEmployeeOnboardingActiveCase",
    "function renderEmployeeOnboardingStartForm",
  );
  for (const allowed of [
    "caseId", "state", "createdAt", "startedAt", "completedAt",
    "packageCount", "taskCount", "completedTaskCount",
  ]) assert.match(activeCaseRenderer, new RegExp(`\\b${allowed}\\b`));
  assert.match(activeCaseRenderer, /employeeOnboardingCloseDraftFor\(activeCase\)/);
  assert.match(activeCaseRenderer, /activeCase\.closeAvailable/);
  assert.match(activeCaseRenderer, /data-employee-onboarding-close-form/);
  assert.match(activeCaseRenderer, /data-onboarding-close-confirmation/);
  assert.match(activeCaseRenderer, /CLOSE_ONBOARDING/);
  assert.doesNotMatch(activeCaseRenderer, /<select\b|<textarea\b|data-onboarding-(?:skip|exception|evidence)/i);
  assert.doesNotMatch(activeCaseRenderer, /employeeName|displayName|receipt|sha256|protectedPayload|notification|offboarding/i);
  const route = between(app, "function renderEmployeeProfileOnboarding(preview)", "function captureEmployeeOnboardingStartForm");
  assert.match(route, /execution\.activeCase[\s\S]*renderEmployeeOnboardingActiveCase\(execution\.activeCase\)/);
});

test("M7 löscht vertrauliche Tabdaten bei Wechsel, Zugriffsfehler, Profilwechsel und Verlassen", () => {
  const lifecycle = between(app, "function syncEmployeeProfileWorkspace", "function renderCostCenterTypes");
  assert.match(lifecycle, /function clearEmployeeProfileSensitiveTabs/);
  assert.match(lifecycle, /state\.employeeProfileTabData\[tabId\] = null/);
  assert.match(lifecycle, /if \(state\.employeeProfileTab !== definition\.id\) clearEmployeeProfileSensitiveTabs/);
  assert.match(lifecycle, /\[401, 403, 404\]\.includes\(error\.status\)/);
  assert.match(lifecycle, /invalidateEmployeeProfileData/);
  assert.match(lifecycle, /resetEmployeeProfileData\(\{ accessPending: true, initialTab \}\)/);
  assert.match(lifecycle, /resetEmployeeProfileData\(\)/);
  assert.match(lifecycle, /renderEmployeeProfile\(\);[\s\S]*syncEmployeeProfileWorkspace\(\)/);

  const viewSwitch = between(app, "function setView(view)", "function applyRequestedView");
  assert.match(viewSwitch, /employeeProfileIsOpen\(\) && view !== profileView/);
  assert.match(viewSwitch, /closeEmployeeProfile\(\{ restoreFocus: false \}\)/);
  const loginGate = between(app, "function showLoginGate", "function hideLoginGate");
  assert.match(loginGate, /employeeProfileIsOpen\(\).*closeEmployeeProfile/);
});

test("M7 berechnet Profilzugriff bei Feature-, Rechte- und Bereichswechsel neu", () => {
  const accessFunctions = [
    between(app, "const EMPLOYEE_PROFILE_MASTER_DATA_FIELDS", "const EMPLOYEE_PROFILE_DOCUMENT_STATUSES"),
    between(app, "function employeeProfileMasterDataFieldFingerprint", "function employeeProfileIsOpen"),
    between(app, "function canOpenStandardEmployeeProfileFoundation", "function canReadCandidatePreboarding"),
  ].join("\n");
  const feature = { enabled: true };
  const state = {
    portalStatus: { portalEnabled: true },
    employeeProfileHost: "administration",
    employeeProfileEmployeeNumber: "M7-001",
    allEmployees: [{
      personnel_number: "M7-001",
      personnel_profile_access: { available: true },
    }],
    portalSession: {
      user: {
        role: "hr",
        permissions: [
          "personnel:central:read",
          "personnel:profiles:read",
          "personnel:profiles:master:read",
          "personnel:profiles:documents:read",
          "personnel:sensitive:read",
          "personnel:lifecycle:onboarding:read",
          "personnel:lifecycle:packages:read",
        ],
        personnelRecordAccess: {
          fieldAccess: { "identity.firstName": "read", phone: "read", documents: "read" },
          canReadDocuments: true,
        },
      },
    },
  };
  const sandbox = {
    state,
    personnelLifecycleFoundationEnabled: () => feature.enabled,
    canReadCentralPersonnel: () => (
      state.portalSession.user.permissions.includes("personnel:central:read")
    ),
    hasGovernancePermission: (permission) => (
      state.portalSession.user.permissions.includes(permission)
    ),
    result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(accessFunctions, sandbox);
  const calculate = () => {
    vm.runInContext("result = currentEmployeeProfileAccess();", sandbox);
    return sandbox.result;
  };

  let result = calculate();
  assert.equal(result.read, true);
  assert.equal(result.masterData, true);
  assert.equal(result.documents, true);
  assert.equal(result.onboarding, true);
  const completeFieldFingerprint = result.masterDataFieldFingerprint;

  delete state.portalSession.user.personnelRecordAccess.fieldAccess.phone;
  result = calculate();
  assert.equal(result.masterData, true);
  assert.notEqual(result.masterDataFieldFingerprint, completeFieldFingerprint);
  state.portalSession.user.personnelRecordAccess.fieldAccess.phone = "read";

  state.portalSession.user.permissions = state.portalSession.user.permissions
    .filter((permission) => permission !== "personnel:sensitive:read");
  result = calculate();
  assert.equal(result.read, true);
  assert.equal(result.masterData, false);
  assert.equal(result.documents, false);
  assert.equal(result.onboarding, true);

  state.portalSession.user.permissions = state.portalSession.user.permissions
    .filter((permission) => permission !== "personnel:profiles:read");
  result = calculate();
  assert.equal(result.read, false);
  assert.equal(result.masterData, false);
  assert.equal(result.documents, false);
  assert.equal(result.onboarding, true);

  state.portalSession.user.permissions = state.portalSession.user.permissions
    .filter((permission) => permission !== "personnel:lifecycle:packages:read");
  result = calculate();
  assert.equal(result.read, false);
  assert.equal(result.onboarding, false);
  state.portalSession.user.permissions.push("personnel:lifecycle:packages:read");

  feature.enabled = false;
  result = calculate();
  assert.equal(result.read, false);
  assert.equal(result.onboarding, false);
  feature.enabled = true;

  state.employeeProfileHost = "team";
  state.portalSession.user.role = "manager";
  state.portalSession.user.permissions = [
    "personnel:profiles:read",
    "personnel:profiles:master:read",
  ];
  result = calculate();
  assert.equal(result.read, true);
  assert.equal(result.masterData, true);
  assert.equal(result.documents, false);
  assert.equal(result.onboarding, false);

  state.allEmployees[0].personnel_profile_access.available = false;
  result = calculate();
  assert.equal(result.read, false);
  assert.equal(result.masterData, false);
});

test("M7 verwirft geladene vertrauliche Daten und laufende Antworten bei Rechteentzug", () => {
  const lifecycle = between(
    app,
    "function employeeProfileSensitiveAccessWasExposed",
    "function renderCostCenterTypes",
  );
  const createState = ({ documentsExposed = true } = {}) => ({
    employeeProfile: { employeeNumber: "M7-001" },
    employeeProfileOpen: true,
    employeeProfileEmployeeNumber: "M7-001",
    employeeProfileTab: documentsExposed ? "documents" : "overview",
    employeeProfileHost: "administration",
    employeeProfileTabData: {
      masterData: { fields: [
        { key: "identity.firstName", value: "Mara" },
        { key: "phone", value: "+43 512 555" },
      ] },
      documents: documentsExposed ? [{ id: "doc-sensitive" }] : null,
      onboarding: null,
      offboarding: null,
    },
    employeeProfileTabAvailability: {
      overview: true,
      masterData: true,
      documents: documentsExposed,
      onboarding: false,
      offboarding: false,
    },
    employeeProfileLoadingTabs: new Set(documentsExposed ? ["documents"] : []),
    employeeProfileTabErrors: {},
    employeeProfileTabRequestTokens: documentsExposed ? { documents: Symbol("old-document-request") } : {},
    employeeProfileTabAccessFingerprints: {
      masterData: "identity.firstName\0phone",
    },
    employeeProfileLoading: documentsExposed,
    employeeProfileLoadError: "",
    employeeProfileRequestToken: Symbol("old-profile-request"),
    employeeProfileReturnFocus: null,
  });
  const runReconciliation = (state, access) => {
    const oldProfileToken = state.employeeProfileRequestToken;
    let renderedWithSensitiveData = null;
    let workspaceSyncs = 0;
    const sandbox = {
      state,
      access,
      clearEmployeeOnboardingStartState: () => { state.employeeOnboardingStartDraft = null; },
      clearEmployeeOffboardingState: () => { state.employeeOffboardingDraft = null; },
      employeeProfileIsOpen: () => state.employeeProfileOpen === true,
      renderEmployeeProfile: () => {
        renderedWithSensitiveData = Boolean(
          state.employeeProfileTabData.masterData
            || state.employeeProfileTabData.documents
            || state.employeeProfileTabData.onboarding
            || state.employeeProfileTabData.offboarding,
        );
      },
      syncEmployeeProfileWorkspace: () => { workspaceSyncs += 1; },
      result: null,
    };
    vm.runInNewContext(`${lifecycle}\nresult = reconcileOpenEmployeeProfileAccess(access);`, sandbox);
    return { ...sandbox, oldProfileToken, renderedWithSensitiveData, workspaceSyncs };
  };

  const revokedState = createState();
  const revoked = runReconciliation(revokedState, {
    read: true,
    masterData: true,
    documents: false,
    onboarding: false,
    offboarding: false,
    masterDataFieldFingerprint: "identity.firstName\0phone",
  });
  assert.equal(revoked.result, false);
  assert.equal(revokedState.employeeProfileOpen, false);
  assert.equal(revokedState.employeeProfileEmployeeNumber, "");
  assert.equal(JSON.stringify(revokedState.employeeProfileTabData), JSON.stringify({
    masterData: null,
    documents: null,
    onboarding: null,
    offboarding: null,
  }));
  assert.equal(Object.keys(revokedState.employeeProfileTabRequestTokens).length, 0);
  assert.equal(Object.keys(revokedState.employeeProfileTabAccessFingerprints).length, 0);
  assert.equal(revokedState.employeeProfileLoadingTabs.size, 0);
  assert.notEqual(revokedState.employeeProfileRequestToken, revoked.oldProfileToken);
  assert.equal(revoked.renderedWithSensitiveData, false);
  assert.equal(revoked.workspaceSyncs, 1);

  const unavailableByDesignState = createState({ documentsExposed: false });
  const unchanged = runReconciliation(unavailableByDesignState, {
    read: true,
    masterData: true,
    documents: false,
    onboarding: false,
    offboarding: false,
    masterDataFieldFingerprint: "identity.firstName\0phone",
  });
  assert.equal(unchanged.result, true);
  assert.equal(unavailableByDesignState.employeeProfileOpen, true);
  assert.equal(unchanged.workspaceSyncs, 0);

  const fieldRevokedState = createState({ documentsExposed: false });
  const fieldRevoked = runReconciliation(fieldRevokedState, {
    read: true,
    masterData: true,
    documents: false,
    onboarding: false,
    offboarding: false,
    masterDataFieldFingerprint: "identity.firstName",
  });
  assert.equal(fieldRevoked.result, false);
  assert.equal(fieldRevokedState.employeeProfileOpen, false);
  assert.equal(fieldRevoked.renderedWithSensitiveData, false);

  const readRevokedState = createState({ documentsExposed: false });
  const readRevoked = runReconciliation(readRevokedState, {
    read: false,
    masterData: false,
    documents: false,
    onboarding: false,
    offboarding: false,
    masterDataFieldFingerprint: "",
  });
  assert.equal(readRevoked.result, false);
  assert.equal(readRevokedState.employeeProfileOpen, false);
  assert.equal(readRevoked.renderedWithSensitiveData, false);
});

test("M7-Teamzugang hängt fail-closed an der serverseitigen Subject-Capability", () => {
  const renderer = between(app, "function renderEmployees()", "function renderLocations()");
  assert.match(renderer, /employee\.personnel_profile_access\?\.available === true/);
  assert.match(renderer, /data-team-employee-profile-access="true"/);
  const capabilityGate = between(renderer, "const canOpenProfile", "return `<tr>");
  assert.doesNotMatch(capabilityGate, /manager|department_manager|role|permissions|scope/i);

  const eventHandler = between(
    app,
    'elements.employeeTableBody.addEventListener("click"',
    "elements.locationList.addEventListener",
  );
  assert.match(eventHandler, /data-team-employee-profile-access=\\"true\\"/);
  assert.match(eventHandler, /openEmployeeProfile\(profileButton\.dataset\.teamEmployeeProfile, profileButton\)/);
  assert.match(html, /id="employeeProfileAdministrationMount"/);
  assert.match(html, /id="employeeProfileTeamMount"/);
  assert.equal((html.match(/id="employeeProfileWorkspace"/g) || []).length, 1);
});

test("M7-Tabs sind tastaturbedienbar und bleiben mobil ohne Seitenüberlauf", () => {
  const handlers = between(
    app,
    "elements.employeeProfileBackButton?.addEventListener",
    "elements.costCenterList?.addEventListener",
  );
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.match(handlers, new RegExp(key));
  assert.match(handlers, /event\.preventDefault\(\)/);
  assert.match(handlers, /setEmployeeProfileTab\([\s\S]*\{ focus: true \}/);
  assert.match(html, /role="tablist"[^>]*aria-orientation="horizontal"/);
  assert.match(html, /id="employeeProfileContent"[^>]*role="tabpanel"[^>]*tabindex="0"/);
  assert.match(styles, /\.employee-profile-tab:focus-visible/);
  assert.match(styles, /\.employee-profile-content \{[^}]*min-width:0;[^}]*overflow-x:hidden;/);
  assert.match(styles, /\.employee-profile-data-grid \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.employee-profile-document-meta \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.employee-profile-data-grid,\.employee-profile-document-meta \{ grid-template-columns:1fr; \}/);
  assert.match(styles, /\.employee-onboarding-start-form \{[^}]*min-width:0;[^}]*max-width:100%/);
  assert.match(styles, /\.employee-onboarding-start-field input,\.employee-onboarding-start-field select,\.employee-onboarding-start-assignment select \{[^}]*width:100%;[^}]*min-width:0;[^}]*max-width:100%/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.employee-onboarding-date-grid,\.employee-onboarding-family-grid,\.employee-onboarding-active-case dl,\.employee-onboarding-start-assignment \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(styles, /\.employee-onboarding-start-actions \.primary-button \{[^}]*min-height:44px/);
});

test("M7-Profilrechte behalten die clientseitigen Leserechts-Abhängigkeiten", () => {
  const dependencies = between(app, "const permissionDependencyRules", "async function loadPortalUsers");
  for (const permissionId of [
    "personnel:profiles:master:read",
    "personnel:profiles:documents:read",
    "personnel:profiles:delegate",
  ]) {
    const offset = dependencies.indexOf(`permissionId: "${permissionId}"`);
    assert.notEqual(offset, -1, permissionId);
    assert.match(dependencies.slice(offset, offset + 180), /requiredPermissionId: "personnel:profiles:read"/);
  }
  const scopeDecision = between(app, "function rightsEditorPermissionIsOrganizational", "function rightsEditorAnnounce");
  assert.match(scopeDecision, /permission\?\.scopeBehavior === "organizational"/);
  assert.doesNotMatch(scopeDecision, /personnel:profiles:/);
});
