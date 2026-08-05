"use strict";

const {
  assertCustomProcessManagementRepository,
} = require("./persistence/repositories/custom-process-management");
const {
  PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES,
  createPersonnelLifecycleStartPreview,
} = require("./personnel-lifecycle-case-foundation");
const {
  verifyPersonnelWorkflowPublication,
} = require("./personnel-workflow-publications");

const PERSONNEL_LIFECYCLE_O3_CONTRACT_VERSION = "o3-v0.1";

const PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES = Object.freeze({
  SYSTEM_DEFERRED: "system_deferred",
  FIXED_RECIPIENT_ELIGIBLE: "fixed_recipient_eligible",
  SELECTION_REQUIRED: "selection_required",
  UNRESOLVED: "unresolved",
});

const PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES = Object.freeze({
  EXECUTION_DEFERRED: "onboarding_execution_deferred_until_o4",
  ASSIGNMENT_SELECTION_REQUIRED: "assignment_selection_required",
  ASSIGNMENT_UNRESOLVED: "assignment_unresolved",
  NOTIFICATIONS_DEFERRED: "onboarding_notifications_deferred",
});

const PERSONNEL_LIFECYCLE_O3_RUNTIME_GATES = Object.freeze({
  schemaMigration: true,
  persistenceFoundation: true,
  readOnlyPackageResolution: true,
  readOnlyStartPreview: true,
  apiRoutes: true,
  assignmentPreview: true,
  profileProjection: true,
  productiveActivation: false,
  caseCreation: false,
  caseMutation: false,
  workflowInstantiation: false,
  taskCreation: false,
  assignmentSelection: false,
  assignmentMutation: false,
  automaticProgression: false,
  notifications: false,
  externalActions: false,
  offboardingProjection: false,
});

class PersonnelLifecycleOnboardingPreviewError extends Error {
  constructor(message, code = "PERSONNEL_LIFECYCLE_O3_INTEGRITY_FAILED") {
    super(message);
    this.name = "PersonnelLifecycleOnboardingPreviewError";
    this.code = code;
  }
}

function previewError(message, code) {
  return new PersonnelLifecycleOnboardingPreviewError(message, code);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value, label, maximum = 160) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw previewError(`${label} ist in der O3-Vorschau ungueltig.`);
  }
  return normalized;
}

function normalizedStep(value, index, usedIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw previewError("Ein veroeffentlichter Onboarding-Schritt ist ungueltig.");
  }
  const stepReference = text(value.id, "Der Schrittbezug", 80);
  if (usedIds.has(stepReference)) {
    throw previewError("Ein veroeffentlichtes Onboarding-Paket enthaelt doppelte Schrittbezuege.");
  }
  usedIds.add(stepReference);
  const title = text(value.title, "Der Schritttitel", 120);
  const responsibilityType = String(value.responsibilityType || "").trim();
  if (!new Set(["system", "role", "employee"]).has(responsibilityType)) {
    throw previewError("Die Verantwortung eines Onboarding-Schritts ist ungueltig.");
  }
  const responsibilityReference = responsibilityType === "system"
    ? ""
    : text(value.responsibilityReference, "Die Verantwortungsreferenz", 80);
  const responsibilityLabel = String(value.responsibilityLabel || "").trim()
    || (responsibilityType === "system" ? "Grabenplaner" : responsibilityReference);
  if (responsibilityLabel.length > 160 || /[\0\r\n]/.test(responsibilityLabel)) {
    throw previewError("Die Verantwortungsbezeichnung eines Onboarding-Schritts ist ungueltig.");
  }
  return Object.freeze({
    stepReference,
    sortOrder: index + 1,
    title,
    responsibilityType,
    responsibilityReference,
    responsibilityLabel,
  });
}

function normalizedSteps(snapshot) {
  if (!Array.isArray(snapshot?.steps) || snapshot.steps.length < 1 || snapshot.steps.length > 30) {
    throw previewError("Die veroeffentlichte Onboarding-Schrittliste ist ungueltig.");
  }
  const usedIds = new Set();
  return Object.freeze(snapshot.steps.map((step, index) => normalizedStep(step, index, usedIds)));
}

function normalizedRecipients(rows) {
  if (!Array.isArray(rows)) {
    throw previewError("Die Empfaengerliste der O3-Vorschau ist ungueltig.");
  }
  const recipients = [];
  const actorIds = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw previewError("Ein Empfaenger der O3-Vorschau ist ungueltig.");
    }
    const actorId = text(row.employee_number, "Die Empfaengeridentitaet", 120);
    if (actorIds.has(actorId)) {
      throw previewError("Die Empfaengerliste der O3-Vorschau ist nicht eindeutig.");
    }
    actorIds.add(actorId);
    recipients.push(Object.freeze({
      actorId,
      displayName: text(row.full_name || actorId, "Der Empfaengername", 160),
      role: text(row.role, "Die Empfaengerrolle", 80),
      source: row,
    }));
  }
  return Object.freeze(recipients);
}

function publicRecipient(recipient) {
  return Object.freeze({
    actorId: recipient.actorId,
    displayName: recipient.displayName,
  });
}

function recipientSort(left, right) {
  return left.displayName.localeCompare(right.displayName, "de-AT", { sensitivity: "base" })
    || left.actorId.localeCompare(right.actorId, "de-AT", { sensitivity: "base" });
}

async function assignmentPreview(step, recipients, canPreviewRecipient, context) {
  if (step.responsibilityType === "system") {
    return deepFreeze({
      stepReference: step.stepReference,
      sortOrder: step.sortOrder,
      title: step.title,
      responsibility: {
        type: step.responsibilityType,
        reference: "",
        label: step.responsibilityLabel,
      },
      state: PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES.SYSTEM_DEFERRED,
      eligibleRecipients: [],
      selectedAssignee: null,
    });
  }

  const responsibilityMatches = recipients.filter((recipient) => (
    step.responsibilityType === "employee"
      ? recipient.actorId === step.responsibilityReference
      : recipient.role === step.responsibilityReference
  ));
  const eligible = [];
  for (const recipient of responsibilityMatches) {
    if (await canPreviewRecipient({ ...context, step, recipient: recipient.source }) === true) {
      eligible.push(publicRecipient(recipient));
    }
  }
  eligible.sort(recipientSort);
  const state = step.responsibilityType === "employee" && eligible.length === 1
    ? PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES.FIXED_RECIPIENT_ELIGIBLE
    : eligible.length
      ? PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES.SELECTION_REQUIRED
      : PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES.UNRESOLVED;
  return deepFreeze({
    stepReference: step.stepReference,
    sortOrder: step.sortOrder,
    title: step.title,
    responsibility: {
      type: step.responsibilityType,
      reference: step.responsibilityReference,
      label: step.responsibilityLabel,
    },
    state,
    eligibleRecipients: eligible,
    selectedAssignee: null,
  });
}

function publicPackage(candidate, assignments) {
  return deepFreeze({
    publicationId: candidate.publicationId,
    processId: candidate.processId,
    sourceRevision: candidate.sourceRevision,
    versionNumber: candidate.versionNumber,
    workflowCode: candidate.workflowCode,
    title: candidate.title,
    authorityLevel: candidate.authorityLevel,
    requirementKind: candidate.requirementKind,
    scope: candidate.scope,
    publishedAt: candidate.publishedAt,
    reviewStatus: candidate.reviewStatus,
    assignments,
  });
}

function projectedFoundationBlockers(blockers) {
  return blockers.map((entry) => deepFreeze({
    code: entry.code === PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.STARTS_LOCKED
      ? PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES.EXECUTION_DEFERRED
      : entry.code,
  }));
}

async function createPersonnelLifecycleOnboardingProfilePreview({
  subject,
  publications = [],
  recipients = [],
  canPreviewRecipient = async () => false,
} = {}) {
  if (typeof canPreviewRecipient !== "function") {
    throw previewError("Die serverseitige Empfaengerpruefung der O3-Vorschau fehlt.");
  }
  const foundation = createPersonnelLifecycleStartPreview({
    caseType: "onboarding",
    subject,
    publications,
  });
  const verifiedById = new Map();
  for (const row of publications) {
    const verified = verifyPersonnelWorkflowPublication(row);
    const publicationId = String(verified.row.id || "");
    if (verifiedById.has(publicationId)) {
      throw previewError("Die Publikationsliste der O3-Vorschau ist nicht eindeutig.");
    }
    verifiedById.set(publicationId, verified);
  }
  const normalizedRecipientValues = normalizedRecipients(recipients);
  const packages = [];
  let notificationsDeferred = false;
  for (const candidate of foundation.packageResolution.applicableCandidates) {
    const verified = verifiedById.get(candidate.publicationId);
    if (!verified || verified.row.workflow_type !== "onboarding") {
      throw previewError("Ein O3-Paketkandidat besitzt keine gueltige Onboarding-Publikation.");
    }
    if (verified.snapshot.steps.some((step) => (
      step.notificationChannels !== undefined
        && (!Array.isArray(step.notificationChannels) || step.notificationChannels.length > 0)
    ))) notificationsDeferred = true;
    const steps = normalizedSteps(verified.snapshot);
    const assignments = [];
    for (const step of steps) {
      assignments.push(await assignmentPreview(
        step,
        normalizedRecipientValues,
        canPreviewRecipient,
        {
          publication: candidate,
          scope: foundation.scope,
          subject: foundation.subject,
        },
      ));
    }
    packages.push(publicPackage(candidate, assignments));
  }

  const assignments = packages.flatMap((entry) => entry.assignments);
  const selectionRequired = assignments.filter((assignment) => (
    assignment.state === PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES.SELECTION_REQUIRED
  ));
  const unresolved = assignments.filter((assignment) => (
    assignment.state === PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES.UNRESOLVED
  ));
  const blockers = projectedFoundationBlockers(foundation.blockers);
  if (selectionRequired.length) {
    blockers.push(deepFreeze({
      code: PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES.ASSIGNMENT_SELECTION_REQUIRED,
    }));
  }
  if (unresolved.length) {
    blockers.push(deepFreeze({
      code: PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES.ASSIGNMENT_UNRESOLVED,
    }));
  }
  if (notificationsDeferred) {
    blockers.push(deepFreeze({
      code: PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES.NOTIFICATIONS_DEFERRED,
    }));
  }

  return deepFreeze({
    contractVersion: PERSONNEL_LIFECYCLE_O3_CONTRACT_VERSION,
    mode: "read_only_onboarding_profile_preview",
    caseType: "onboarding",
    subject: foundation.subject,
    scope: foundation.scope,
    packageResolution: {
      requiredPackageFamilies: foundation.packageResolution.requiredPackageFamilies,
      packages,
      selectedBindings: [],
      conflicts: foundation.packageResolution.conflicts,
    },
    assignmentPreview: {
      packageCount: packages.length,
      stepCount: assignments.length,
      fixedRecipientCount: assignments.filter((assignment) => (
        assignment.state === PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES.FIXED_RECIPIENT_ELIGIBLE
      )).length,
      selectionRequiredCount: selectionRequired.length,
      unresolvedCount: unresolved.length,
      systemStepCount: assignments.filter((assignment) => (
        assignment.state === PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES.SYSTEM_DEFERRED
      )).length,
      selectedAssignmentCount: 0,
    },
    blockers,
    startAllowed: false,
    casePersisted: false,
    instanceCount: 0,
    taskCount: 0,
    assignmentCount: 0,
  });
}

function createPersonnelLifecycleOnboardingPreviewService(repositoryValue, {
  canPreviewRecipient = async () => false,
} = {}) {
  const repository = assertCustomProcessManagementRepository(repositoryValue);
  if (typeof canPreviewRecipient !== "function") {
    throw previewError("Die serverseitige Empfaengerpruefung der O3-Vorschau fehlt.");
  }
  return Object.freeze({
    async preview({ employeeNumber } = {}) {
      const normalizedEmployeeNumber = text(employeeNumber, "Die Personalnummer", 100);
      const [subject, publications, recipients] = await Promise.all([
        repository.personnelWorkflowEmployeeSubject({
          employeeNumber: normalizedEmployeeNumber,
        }),
        repository.listWorkflowPublications({ includeArchived: 1 }),
        repository.listRecipientCandidates(),
      ]);
      return createPersonnelLifecycleOnboardingProfilePreview({
        subject,
        publications,
        recipients,
        canPreviewRecipient,
      });
    },
  });
}

function assertPersonnelLifecycleO3Contract() {
  const openReadOnlyGates = new Set([
    "schemaMigration",
    "persistenceFoundation",
    "readOnlyPackageResolution",
    "readOnlyStartPreview",
    "apiRoutes",
    "assignmentPreview",
    "profileProjection",
  ]);
  for (const [name, value] of Object.entries(PERSONNEL_LIFECYCLE_O3_RUNTIME_GATES)) {
    if (value !== openReadOnlyGates.has(name)) {
      throw new Error(`Das O3-Laufzeitgate ${name} verletzt den read-only Vertrag.`);
    }
  }
  return true;
}

assertPersonnelLifecycleO3Contract();

module.exports = {
  PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES,
  PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES,
  PERSONNEL_LIFECYCLE_O3_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_O3_RUNTIME_GATES,
  PersonnelLifecycleOnboardingPreviewError,
  assertPersonnelLifecycleO3Contract,
  createPersonnelLifecycleOnboardingPreviewService,
  createPersonnelLifecycleOnboardingProfilePreview,
};
