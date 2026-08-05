"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES,
  PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES,
} = require("../lib/personnel-lifecycle-case-contract");
const {
  PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_CONFIRMATIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST,
  PersonnelLifecycleOffboardingContractError,
  assertPersonnelLifecycleOffboardingContract,
  normalizePersonnelLifecycleOffboardingActivation,
  normalizePersonnelLifecycleOffboardingCancellation,
  normalizePersonnelLifecycleOffboardingClose,
  normalizePersonnelLifecycleOffboardingCommunicationRelease,
  normalizePersonnelLifecycleOffboardingInformationConfirmation,
  normalizePersonnelLifecycleOffboardingPreparation,
  normalizePersonnelLifecycleOffboardingTimeCriticalApproval,
  personnelLifecycleOffboardingMutationRequestSha256,
  personnelLifecycleOffboardingOrderId,
  personnelLifecycleOffboardingPreparationRequestSha256,
  personnelLifecycleOffboardingStepId,
  personnelLifecycleOffboardingTimeCriticalApprovalRequestSha256,
} = require("../lib/personnel-lifecycle-offboarding-contract");
const {
  canonicalSha256,
  deterministicUuidV4,
  personnelLifecycleOffboardingOperationReceiptBody,
  personnelLifecycleOffboardingOperationReceiptSha256,
  personnelLifecycleOffboardingProtectedPlanReceiptBody,
  personnelLifecycleOffboardingProtectedPlanReceiptSha256,
} = require("../lib/personnel-lifecycle-offboarding-receipt");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID = "22222222-2222-4222-8222-222222222222";
const EMPLOYEE = "EMP-O5-001";
const RESPONSIBLE_ACTOR = "HR-O5-001";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assignments() {
  return PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.map(
    (familyCode, index) => ({
      familyCode,
      assigneeActorId: `O5-ACTOR-${index + 1}`,
      title: `Geschuetzter Titel ${index + 1}`,
      instructions: `Geschuetzte Anweisung fuer Pflichtfamilie ${index + 1}.`,
    }),
  );
}

function standardPreparation() {
  return {
    operationId: OPERATION_ID,
    employeeNumber: EMPLOYEE,
    responsibleActorId: RESPONSIBLE_ACTOR,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.PREPARATION,
    referenceTimes: {
      plannedExitAt: "2026-08-03T10:00:00.000Z",
      lastWorkingDay: "2026-08-28",
      legalExitDate: "2026-08-31",
      accessBlockAt: "2026-08-28T16:00:00.000Z",
    },
    urgency: {
      mode: "standard",
      confirmation: null,
      exceptionReason: null,
      followUpDueAt: null,
    },
    exitReason: {
      code: "employee_notice",
      note: "Synthetischer, geschuetzter Vertragsbezug.",
    },
    hrNote: "Synthetischer PL-Vermerk.",
    documentReferenceIds: ["DOC-O5-002", "DOC-O5-001"],
    assignments: assignments(),
  };
}

function reason(code = "confirmed_decision") {
  return {
    code,
    note: "Synthetische, geschuetzte Begruendung.",
    documentReferenceIds: ["DOC-O5-MUTATION"],
  };
}

function mutationBase(confirmation) {
  return {
    operationId: "33333333-3333-4333-8333-333333333333",
    caseId: CASE_ID,
    expectedRevision: 2,
    confirmation,
  };
}

function assertContractError(action, code) {
  assert.throws(action, (error) => (
    error instanceof PersonnelLifecycleOffboardingContractError
    && (!code || error.code === code)
  ));
}

test("O5-Vertrag enthaelt genau die sechs unverzichtbaren Offboarding-Pflichtfamilien", () => {
  assert.equal(PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION, "o5-v0.1");
  assert.deepEqual(PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES, [
    "hr_contract_end",
    "communication_release_information",
    "accounts_permissions",
    "work_access_assets",
    "handover_open_responsibilities",
    "closing_documents_follow_up",
  ]);
  assert.equal(PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.length, 6);
  assert.equal(Object.isFrozen(PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS), true);
  assert.equal(assertPersonnelLifecycleOffboardingContract(), true);
});

test("jede Pflichtfamilie besitzt stabile opake IDs und eine passende minimale O1-Projektion", () => {
  const allIds = [];
  for (const definition of PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS) {
    assert.match(definition.stepId, UUID_V4);
    assert.match(definition.orderId, UUID_V4);
    assert.equal(personnelLifecycleOffboardingStepId(definition.familyCode), definition.stepId);
    assert.equal(personnelLifecycleOffboardingOrderId(definition.familyCode), definition.orderId);
    assert.equal(
      PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES[definition.projection],
      definition.recipientClass,
    );
    assert.notEqual(definition.recipientClass, PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES.EMPLOYEE);
    allIds.push(definition.stepId, definition.orderId);
  }
  assert.deepEqual(
    [...new Set(PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map(({ projection }) => (
      projection
    )))].sort(),
    ["asset_task", "it_security_task", "leadership_task", "payroll_task"],
  );
  assert.equal(new Set(allIds).size, 12);
  assert.equal(personnelLifecycleOffboardingStepId("unknown"), null);
  assert.equal(personnelLifecycleOffboardingOrderId("unknown"), null);
  assert.equal(
    deterministicUuidV4("o5", "stable"),
    deterministicUuidV4("o5", "stable"),
  );
  assert.notEqual(
    deterministicUuidV4("o5", "stable"),
    deterministicUuidV4("o5", "different"),
  );
});

test("Vorbereitung trennt geschuetzten Klartext strikt von der opaken Laufzeithuelle", () => {
  const input = standardPreparation();
  const normalized = normalizePersonnelLifecycleOffboardingPreparation(input);

  assert.equal(normalized.operationId, OPERATION_ID);
  assert.equal(normalized.protectedPlan.employeeNumber, EMPLOYEE);
  assert.equal(normalized.protectedPlan.responsibleActorId, RESPONSIBLE_ACTOR);
  assert.deepEqual(normalized.protectedPlan.documentReferenceIds, ["DOC-O5-001", "DOC-O5-002"]);
  assert.equal(normalized.protectedPlan.assignments.length, 6);
  assert.equal(normalized.runtimeManifest.length, 6);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.protectedPlan.assignments[0]), true);

  const protectedJson = JSON.stringify(normalized.protectedPlan);
  const runtimeJson = JSON.stringify(normalized.runtimeManifest);
  assert.match(protectedJson, /Geschuetzter Titel 1/);
  assert.match(protectedJson, /Geschuetzte Anweisung/);
  for (const forbidden of [
    EMPLOYEE,
    RESPONSIBLE_ACTOR,
    "Geschuetzter Titel",
    "Geschuetzte Anweisung",
    ...PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES,
  ]) {
    assert.equal(runtimeJson.includes(forbidden), false, forbidden);
  }
  for (const entry of normalized.runtimeManifest) {
    assert.deepEqual(Object.keys(entry).sort(), ["orderId", "stepId"]);
    assert.match(entry.stepId, UUID_V4);
    assert.match(entry.orderId, UUID_V4);
  }
});

test("die statische Laufzeithuelle bleibt klartextfrei und unveraenderlich", () => {
  assert.equal(Object.isFrozen(PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST), true);
  for (const entry of PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST) {
    assert.equal(Object.isFrozen(entry), true);
    assert.deepEqual(Object.keys(entry).sort(), ["orderId", "stepId"]);
    assert.match(entry.stepId, UUID_V4);
    assert.match(entry.orderId, UUID_V4);
  }
  const runtimeJson = JSON.stringify(PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST);
  assert.doesNotMatch(runtimeJson, /title|instruction|employee|family|recipient|projection/i);
});

test("unbekannte und fehlende Felder werden auf jeder Vertragsebene verworfen", () => {
  const rootDrift = standardPreparation();
  rootDrift.unexpected = true;
  assertContractError(() => normalizePersonnelLifecycleOffboardingPreparation(rootDrift));

  const nestedDrift = standardPreparation();
  nestedDrift.referenceTimes.unexpected = "2026-08-03";
  assertContractError(() => normalizePersonnelLifecycleOffboardingPreparation(nestedDrift));

  const assignmentDrift = standardPreparation();
  assignmentDrift.assignments[0].recipientClass = "employee";
  assertContractError(() => normalizePersonnelLifecycleOffboardingPreparation(assignmentDrift));

  const missingTime = standardPreparation();
  delete missingTime.referenceTimes.legalExitDate;
  assertContractError(() => normalizePersonnelLifecycleOffboardingPreparation(missingTime));
});

test("fehlende oder doppelte Pflichtfamilien verhindern die Vorbereitung", () => {
  const missing = standardPreparation();
  missing.assignments.pop();
  assertContractError(
    () => normalizePersonnelLifecycleOffboardingPreparation(missing),
    "PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_FAMILY_MISSING",
  );

  const duplicate = standardPreparation();
  duplicate.assignments[5].familyCode = duplicate.assignments[0].familyCode;
  assertContractError(
    () => normalizePersonnelLifecycleOffboardingPreparation(duplicate),
    "PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_ASSIGNMENT_DUPLICATE",
  );
});

test("die austretende Person ist keine O5-Empfaengerin und erhaelt keine Selbstzuweisung", () => {
  const input = standardPreparation();
  input.assignments[2].assigneeActorId = EMPLOYEE;
  assertContractError(
    () => normalizePersonnelLifecycleOffboardingPreparation(input),
    "PERSONNEL_LIFECYCLE_OFFBOARDING_EMPLOYEE_RECIPIENT_FORBIDDEN",
  );
});

test("mehrere Pflichtfamilien duerfen bewusst derselben berechtigten Fachperson zugewiesen werden", () => {
  const input = standardPreparation();
  for (const assignment of input.assignments) assignment.assigneeActorId = RESPONSIBLE_ACTOR;
  const normalized = normalizePersonnelLifecycleOffboardingPreparation(input);
  assert.equal(
    normalized.protectedPlan.assignments.every(({ assigneeActorId }) => (
      assigneeActorId === RESPONSIBLE_ACTOR
    )),
    true,
  );
});

test("zeitkritisch braucht explizite Bestaetigung, Ausnahmegrund und Nacharbeitstermin", () => {
  const input = standardPreparation();
  input.urgency = {
    mode: "time_critical",
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL,
    exceptionReason: {
      code: "immediate_exit",
      note: "Synthetischer zeitkritischer Ausnahmefall.",
    },
    followUpDueAt: "2026-08-05T12:00:00.000Z",
  };
  const normalized = normalizePersonnelLifecycleOffboardingPreparation(input);
  assert.equal(normalized.protectedPlan.urgency.mode, "time_critical");
  assert.equal(normalized.protectedPlan.assignments.length, 6);

  for (const missing of ["confirmation", "exceptionReason", "followUpDueAt"]) {
    const invalid = clone(input);
    invalid.urgency[missing] = null;
    assertContractError(
      () => normalizePersonnelLifecycleOffboardingPreparation(invalid),
      "PERSONNEL_LIFECYCLE_OFFBOARDING_TIME_CRITICAL_DETAILS_REQUIRED",
    );
  }

  const reduced = clone(input);
  reduced.assignments.pop();
  assertContractError(
    () => normalizePersonnelLifecycleOffboardingPreparation(reduced),
    "PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_FAMILY_MISSING",
  );
});

test("kanonische Vorbereitungshashes sind reihenfolgestabil und erkennen Body-Drift", () => {
  const original = standardPreparation();
  const reordered = standardPreparation();
  reordered.assignments.reverse();
  reordered.documentReferenceIds.reverse();

  const originalHash = personnelLifecycleOffboardingPreparationRequestSha256(original);
  assert.match(originalHash, /^[0-9a-f]{64}$/);
  assert.equal(
    personnelLifecycleOffboardingPreparationRequestSha256(reordered),
    originalHash,
  );

  const drifted = standardPreparation();
  drifted.assignments[0].instructions = "Inhaltlich veraenderte geschuetzte Anweisung.";
  assert.notEqual(
    personnelLifecycleOffboardingPreparationRequestSha256(drifted),
    originalHash,
  );
});

test("jede O5-Mutation besitzt eine eigene zwingende Bestaetigung", () => {
  assert.deepEqual(PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_CONFIRMATIONS, {
    time_critical_approval: "CONFIRM_TIME_CRITICAL_OFFBOARDING",
    communication_release: "RELEASE_OFFBOARDING_COMMUNICATION",
    information_confirmation: "CONFIRM_OFFBOARDING_INFORMATION",
    activation: "ACTIVATE_OFFBOARDING",
    cancellation: "CANCEL_OFFBOARDING",
    close: "CLOSE_OFFBOARDING",
  });

  const timeCriticalApproval = normalizePersonnelLifecycleOffboardingTimeCriticalApproval({
    ...mutationBase(PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL),
    reason: reason("urgent_path_approved"),
  });
  assert.equal(timeCriticalApproval.reason.code, "urgent_path_approved");
  assert.match(personnelLifecycleOffboardingTimeCriticalApprovalRequestSha256({
    ...mutationBase(PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL),
    reason: reason("urgent_path_approved"),
  }), /^[0-9a-f]{64}$/);

  const release = normalizePersonnelLifecycleOffboardingCommunicationRelease({
    ...mutationBase(PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.COMMUNICATION_RELEASE),
    reason: reason("communication_approved"),
  });
  assert.equal(release.caseId, CASE_ID);
  assert.equal(release.reason.code, "communication_approved");

  const information = normalizePersonnelLifecycleOffboardingInformationConfirmation({
    ...mutationBase(PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.INFORMATION_CONFIRMATION),
    employeeInformedAt: "2026-08-04T09:30:00.000Z",
  });
  assert.equal(information.employeeInformedAt, "2026-08-04T09:30:00.000Z");

  assert.equal(normalizePersonnelLifecycleOffboardingActivation({
    ...mutationBase(PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.ACTIVATION),
  }).confirmation, "ACTIVATE_OFFBOARDING");
  assert.equal(normalizePersonnelLifecycleOffboardingCancellation({
    ...mutationBase(PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CANCELLATION),
    reason: reason("exit_withdrawn"),
  }).confirmation, "CANCEL_OFFBOARDING");
  assert.equal(normalizePersonnelLifecycleOffboardingClose({
    ...mutationBase(PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CLOSE),
  }).confirmation, "CLOSE_OFFBOARDING");

  for (const [normalize, valid] of [
    [normalizePersonnelLifecycleOffboardingTimeCriticalApproval, {
      ...mutationBase("WRONG"), reason: reason(),
    }],
    [normalizePersonnelLifecycleOffboardingCommunicationRelease, {
      ...mutationBase("WRONG"), reason: reason(),
    }],
    [normalizePersonnelLifecycleOffboardingInformationConfirmation, {
      ...mutationBase("WRONG"), employeeInformedAt: "2026-08-04T09:30:00.000Z",
    }],
    [normalizePersonnelLifecycleOffboardingActivation, mutationBase("WRONG")],
    [normalizePersonnelLifecycleOffboardingCancellation, {
      ...mutationBase("WRONG"), reason: reason(),
    }],
    [normalizePersonnelLifecycleOffboardingClose, mutationBase("WRONG")],
  ]) {
    assertContractError(
      () => normalize(valid),
      "PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATION_REQUIRED",
    );
  }
});

test("kanonische Mutationshashes trennen Aktion und Inhalt", () => {
  const activation = mutationBase(
    PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.ACTIVATION,
  );
  const first = personnelLifecycleOffboardingMutationRequestSha256(
    PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.ACTIVATION,
    activation,
  );
  const replay = personnelLifecycleOffboardingMutationRequestSha256(
    PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.ACTIVATION,
    clone(activation),
  );
  assert.equal(first, replay);

  const drifted = clone(activation);
  drifted.expectedRevision += 1;
  assert.notEqual(
    personnelLifecycleOffboardingMutationRequestSha256(
      PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.ACTIVATION,
      drifted,
    ),
    first,
  );
});

test("Plan- und Operationsbelege speichern nur Hashes geschuetzter Nutzlasten", () => {
  const normalized = normalizePersonnelLifecycleOffboardingPreparation(standardPreparation());
  const planReceipt = personnelLifecycleOffboardingProtectedPlanReceiptBody({
    operationId: normalized.operationId,
    employeeNumber: normalized.protectedPlan.employeeNumber,
    protectedPlan: normalized.protectedPlan,
    runtimeManifest: normalized.runtimeManifest,
  });
  const planReceiptJson = JSON.stringify(planReceipt);
  assert.doesNotMatch(planReceiptJson, /EMP-O5-001|Geschuetzter Titel|Geschuetzte Anweisung/);
  assert.match(planReceipt.employeeNumberSha256, /^[0-9a-f]{64}$/);
  assert.match(planReceipt.protectedPlanSha256, /^[0-9a-f]{64}$/);
  assert.match(personnelLifecycleOffboardingProtectedPlanReceiptSha256({
    operationId: normalized.operationId,
    employeeNumber: normalized.protectedPlan.employeeNumber,
    protectedPlan: normalized.protectedPlan,
    runtimeManifest: normalized.runtimeManifest,
  }), /^[0-9a-f]{64}$/);

  const row = {
    operation_id: OPERATION_ID,
    operation_type: "prepare",
    case_id: CASE_ID,
    request_sha256: canonicalSha256({ request: "synthetic" }),
    plan_receipt_sha256: canonicalSha256(planReceipt),
    protected_result_payload: "enc:v2:SECRET-PROTECTED-RESULT",
    actor_id: RESPONSIBLE_ACTOR,
    occurred_at: "2026-08-03T10:00:00.000Z",
  };
  const operationReceipt = personnelLifecycleOffboardingOperationReceiptBody(row);
  assert.equal(JSON.stringify(operationReceipt).includes("SECRET-PROTECTED-RESULT"), false);
  assert.match(operationReceipt.protectedResultSha256, /^[0-9a-f]{64}$/);
  assert.match(personnelLifecycleOffboardingOperationReceiptSha256(row), /^[0-9a-f]{64}$/);
});
