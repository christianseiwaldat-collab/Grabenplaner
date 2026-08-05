"use strict";

const {
  PERSONNEL_LIFECYCLE_PROJECTIONS: PROJECTION,
  PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES,
  PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES: RECIPIENT,
} = require("./personnel-lifecycle-case-contract");
const {
  deterministicUuidV4,
  personnelLifecycleOffboardingRequestReceiptBody,
  personnelLifecycleOffboardingRequestSha256,
} = require("./personnel-lifecycle-offboarding-receipt");

const PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION = "o5-v0.1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{1,79}$/;

const PERSONNEL_LIFECYCLE_OFFBOARDING_URGENCY_MODES = Object.freeze({
  STANDARD: "standard",
  TIME_CRITICAL: "time_critical",
});

const PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS = Object.freeze({
  PREPARATION: "PREPARE_OFFBOARDING",
  TIME_CRITICAL: "CONFIRM_TIME_CRITICAL_OFFBOARDING",
  COMMUNICATION_RELEASE: "RELEASE_OFFBOARDING_COMMUNICATION",
  INFORMATION_CONFIRMATION: "CONFIRM_OFFBOARDING_INFORMATION",
  ACTIVATION: "ACTIVATE_OFFBOARDING",
  CANCELLATION: "CANCEL_OFFBOARDING",
  CLOSE: "CLOSE_OFFBOARDING",
});

const PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES = Object.freeze({
  TIME_CRITICAL_APPROVAL: "time_critical_approval",
  COMMUNICATION_RELEASE: "communication_release",
  INFORMATION_CONFIRMATION: "information_confirmation",
  ACTIVATION: "activation",
  CANCELLATION: "cancellation",
  CLOSE: "close",
});

const PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_CONFIRMATIONS = Object.freeze({
  time_critical_approval: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL,
  communication_release: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.COMMUNICATION_RELEASE,
  information_confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.INFORMATION_CONFIRMATION,
  activation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.ACTIVATION,
  cancellation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CANCELLATION,
  close: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CLOSE,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function opaqueStepId(familyCode) {
  return deterministicUuidV4(
    "grabenplaner",
    PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
    "offboarding-step",
    familyCode,
  );
}

function opaqueOrderId(familyCode) {
  return deterministicUuidV4(
    "grabenplaner",
    PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
    "offboarding-order",
    familyCode,
  );
}

const PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS = deepFreeze([
  {
    familyCode: "hr_contract_end",
    recipientClass: RECIPIENT.PAYROLL,
    projection: PROJECTION.PAYROLL_TASK,
  },
  {
    familyCode: "communication_release_information",
    recipientClass: RECIPIENT.LEADERSHIP,
    projection: PROJECTION.LEADERSHIP_TASK,
  },
  {
    familyCode: "accounts_permissions",
    recipientClass: RECIPIENT.IT_SECURITY,
    projection: PROJECTION.IT_SECURITY_TASK,
  },
  {
    familyCode: "work_access_assets",
    recipientClass: RECIPIENT.ASSET_CUSTODIAN,
    projection: PROJECTION.ASSET_TASK,
  },
  {
    familyCode: "handover_open_responsibilities",
    recipientClass: RECIPIENT.LEADERSHIP,
    projection: PROJECTION.LEADERSHIP_TASK,
  },
  {
    familyCode: "closing_documents_follow_up",
    recipientClass: RECIPIENT.PAYROLL,
    projection: PROJECTION.PAYROLL_TASK,
  },
].map((definition) => ({
  ...definition,
  stepId: opaqueStepId(definition.familyCode),
  orderId: opaqueOrderId(definition.familyCode),
})));

const PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES = Object.freeze(
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map(({ familyCode }) => familyCode),
);

const PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST = deepFreeze(
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map(({ stepId, orderId }) => ({
    stepId,
    orderId,
  })),
);

const FAMILY_BY_CODE = new Map(
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map((definition) => [
    definition.familyCode,
    definition,
  ]),
);

class PersonnelLifecycleOffboardingContractError extends Error {
  constructor(message, code = "PERSONNEL_LIFECYCLE_OFFBOARDING_INPUT_INVALID") {
    super(message);
    this.name = "PersonnelLifecycleOffboardingContractError";
    this.code = code;
    this.kind = "input";
  }
}

function inputError(message, code) {
  return new PersonnelLifecycleOffboardingContractError(message, code);
}

function exactDataObject(value, requiredKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(`${label} ist ungueltig.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw inputError(`${label} ist ungueltig.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set(requiredKeys);
  if (ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
    || ownKeys.length !== requiredKeys.length) {
    throw inputError(`${label} enthaelt unbekannte oder fehlende Felder.`);
  }
  const result = {};
  for (const key of requiredKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw inputError(`${label} enthaelt kein gueltiges Datenfeld.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function singleLine(value, label, maximum = 120) {
  if (typeof value !== "string") throw inputError(`${label} ist ungueltig.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return normalized;
}

function narrative(value, label, maximum = 4000, allowEmpty = false) {
  if (typeof value !== "string") throw inputError(`${label} ist ungueltig.`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximum || /\0/.test(normalized)) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return normalized;
}

function uuidV4(value, label, code = "PERSONNEL_LIFECYCLE_OFFBOARDING_OPERATION_ID_INVALID") {
  const normalized = singleLine(value, label, 36).toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw inputError(`${label} muss eine UUIDv4 sein.`, code);
  }
  return normalized;
}

function isoDate(value, label) {
  const normalized = singleLine(value, label, 10);
  if (!ISO_DATE.test(normalized)) {
    throw inputError(
      `${label} ist ungueltig.`,
      "PERSONNEL_LIFECYCLE_OFFBOARDING_REFERENCE_TIMES_INVALID",
    );
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw inputError(
      `${label} ist ungueltig.`,
      "PERSONNEL_LIFECYCLE_OFFBOARDING_REFERENCE_TIMES_INVALID",
    );
  }
  return normalized;
}

function isoTimestamp(value, label, code = "PERSONNEL_LIFECYCLE_OFFBOARDING_REFERENCE_TIMES_INVALID") {
  const normalized = singleLine(value, label, 40);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw inputError(`${label} ist ungueltig.`, code);
  }
  return normalized;
}

function positiveRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw inputError(
      "Die erwartete Fallrevision ist ungueltig.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_EXPECTED_REVISION_INVALID",
    );
  }
  return value;
}

function normalizedReason(value, label = "Der Offboarding-Grund", includeDocuments = true) {
  const requiredKeys = includeDocuments ? ["code", "note", "documentReferenceIds"] : ["code", "note"];
  const reason = exactDataObject(value, requiredKeys, label);
  const code = singleLine(reason.code, `${label}: Code`, 80).toLowerCase();
  if (!REASON_CODE.test(code)) {
    throw inputError(`${label} ist ungueltig.`, "PERSONNEL_LIFECYCLE_OFFBOARDING_REASON_INVALID");
  }
  const normalized = {
    code,
    note: narrative(reason.note, `${label}: Notiz`, 2000),
  };
  if (!includeDocuments) return deepFreeze(normalized);
  if (!Array.isArray(reason.documentReferenceIds) || reason.documentReferenceIds.length > 50) {
    throw inputError(`${label} ist ungueltig.`, "PERSONNEL_LIFECYCLE_OFFBOARDING_REASON_INVALID");
  }
  const documentReferenceIds = reason.documentReferenceIds.map((entry) => (
    singleLine(entry, "Die Dokumentreferenz", 160)
  ));
  if (new Set(documentReferenceIds).size !== documentReferenceIds.length) {
    throw inputError(
      "Eine Dokumentreferenz darf nur einmal vorkommen.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_REASON_INVALID",
    );
  }
  return deepFreeze({ ...normalized, documentReferenceIds: documentReferenceIds.sort() });
}

function normalizedExceptionReason(value) {
  const reason = exactDataObject(value, ["code", "note"], "Der Ausnahmegrund");
  const code = singleLine(reason.code, "Der Ausnahmegrund-Code", 80).toLowerCase();
  if (!REASON_CODE.test(code)) {
    throw inputError(
      "Der Ausnahmegrund ist ungueltig.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_TIME_CRITICAL_DETAILS_REQUIRED",
    );
  }
  return deepFreeze({
    code,
    note: narrative(reason.note, "Die Ausnahmebegruendung", 2000),
  });
}

function normalizedReferenceTimes(value) {
  const times = exactDataObject(value, [
    "plannedExitAt",
    "lastWorkingDay",
    "legalExitDate",
    "accessBlockAt",
  ], "Die Offboarding-Referenztermine");
  return deepFreeze({
    plannedExitAt: isoTimestamp(times.plannedExitAt, "Der geplante Austrittszeitpunkt"),
    lastWorkingDay: isoDate(times.lastWorkingDay, "Der letzte Arbeitstag"),
    legalExitDate: isoDate(times.legalExitDate, "Das rechtliche Austrittsdatum"),
    accessBlockAt: isoTimestamp(times.accessBlockAt, "Der Zugriffssperrzeitpunkt"),
  });
}

function normalizedUrgency(value) {
  const urgency = exactDataObject(value, [
    "mode",
    "confirmation",
    "exceptionReason",
    "followUpDueAt",
  ], "Die Offboarding-Dringlichkeit");
  const mode = singleLine(urgency.mode, "Die Offboarding-Dringlichkeit", 40);
  if (!Object.values(PERSONNEL_LIFECYCLE_OFFBOARDING_URGENCY_MODES).includes(mode)) {
    throw inputError(
      "Die Offboarding-Dringlichkeit ist ungueltig.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_URGENCY_INVALID",
    );
  }
  if (mode === PERSONNEL_LIFECYCLE_OFFBOARDING_URGENCY_MODES.STANDARD) {
    if (urgency.confirmation !== null
      || urgency.exceptionReason !== null
      || urgency.followUpDueAt !== null) {
      throw inputError(
        "Ein Standard-Offboarding darf keine zeitkritische Ausnahme enthalten.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_URGENCY_INVALID",
      );
    }
    return deepFreeze({
      mode,
      confirmation: null,
      exceptionReason: null,
      followUpDueAt: null,
    });
  }
  if (urgency.confirmation !== PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL
    || urgency.exceptionReason === null
    || urgency.followUpDueAt === null) {
    throw inputError(
      "Ein zeitkritisches Offboarding braucht Bestaetigung, Ausnahmegrund und Nacharbeitstermin.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_TIME_CRITICAL_DETAILS_REQUIRED",
    );
  }
  return deepFreeze({
    mode,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL,
    exceptionReason: normalizedExceptionReason(urgency.exceptionReason),
    followUpDueAt: isoTimestamp(
      urgency.followUpDueAt,
      "Der Nacharbeitstermin",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_TIME_CRITICAL_DETAILS_REQUIRED",
    ),
  });
}

function normalizedAssignments(value, employeeNumber) {
  if (!Array.isArray(value)) {
    throw inputError(
      "Die Offboarding-Einzelzuweisungen sind ungueltig.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNMENTS_INVALID",
    );
  }
  const byFamily = new Map();
  value.forEach((entry, index) => {
    const assignment = exactDataObject(entry, [
      "familyCode",
      "assigneeActorId",
      "title",
      "instructions",
    ], `Die Offboarding-Einzelzuweisung ${index + 1}`);
    const familyCode = singleLine(assignment.familyCode, "Die Pflichtfamilie", 80);
    const definition = FAMILY_BY_CODE.get(familyCode);
    if (!definition) {
      throw inputError(
        "Die Offboarding-Einzelzuweisung enthaelt keine gueltige Pflichtfamilie.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_FAMILY_INVALID",
      );
    }
    if (byFamily.has(familyCode)) {
      throw inputError(
        "Jede Offboarding-Pflichtfamilie darf nur einmal zugewiesen werden.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_ASSIGNMENT_DUPLICATE",
      );
    }
    const assigneeActorId = singleLine(
      assignment.assigneeActorId,
      "Die zugewiesene Person",
      120,
    );
    if (assigneeActorId === employeeNumber) {
      throw inputError(
        "Die austretende Person darf im O5-Pflichtkern keine eigene Zuweisung erhalten.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_EMPLOYEE_RECIPIENT_FORBIDDEN",
      );
    }
    byFamily.set(familyCode, deepFreeze({
      familyCode,
      stepId: definition.stepId,
      orderId: definition.orderId,
      assigneeActorId,
      recipientClass: definition.recipientClass,
      projection: definition.projection,
      title: singleLine(assignment.title, "Der geschuetzte Auftragstitel", 160),
      instructions: narrative(
        assignment.instructions,
        "Die geschuetzte Auftragsanweisung",
        4000,
      ),
    }));
  });
  if (value.length !== PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.length
    || PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.some((familyCode) => (
      !byFamily.has(familyCode)
    ))) {
    throw inputError(
      "Jede der sechs Offboarding-Pflichtfamilien braucht genau eine Einzelzuweisung.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_FAMILY_MISSING",
    );
  }
  return deepFreeze(PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES.map(
    (familyCode) => byFamily.get(familyCode),
  ));
}

function cloneRuntimeManifest() {
  return PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST.map((entry) => ({
    stepId: entry.stepId,
    orderId: entry.orderId,
  }));
}

function normalizePersonnelLifecycleOffboardingPreparation(value) {
  const input = exactDataObject(value, [
    "operationId",
    "employeeNumber",
    "responsibleActorId",
    "confirmation",
    "referenceTimes",
    "urgency",
    "exitReason",
    "hrNote",
    "documentReferenceIds",
    "assignments",
  ], "Die Offboarding-Vorbereitung");
  if (input.confirmation !== PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.PREPARATION) {
    throw inputError(
      "Die Offboarding-Vorbereitung wurde nicht eindeutig bestaetigt.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATION_REQUIRED",
    );
  }
  const employeeNumber = singleLine(input.employeeNumber, "Die Personalnummer", 80);
  const operationId = uuidV4(input.operationId, "Die Operations-ID");
  const responsibleActorId = singleLine(
    input.responsibleActorId,
    "Die fallverantwortliche Person",
    120,
  );
  if (!Array.isArray(input.documentReferenceIds) || input.documentReferenceIds.length > 50) {
    throw inputError(
      "Die geschuetzten Dokumentreferenzen sind ungueltig.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_DOCUMENT_REFERENCES_INVALID",
    );
  }
  const documentReferenceIds = input.documentReferenceIds.map((entry) => (
    singleLine(entry, "Die geschuetzte Dokumentreferenz", 160)
  ));
  if (new Set(documentReferenceIds).size !== documentReferenceIds.length) {
    throw inputError(
      "Eine geschuetzte Dokumentreferenz darf nur einmal vorkommen.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_DOCUMENT_REFERENCES_INVALID",
    );
  }
  const protectedPlan = deepFreeze({
    schemaVersion: 1,
    contractVersion: PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
    employeeNumber,
    responsibleActorId,
    referenceTimes: normalizedReferenceTimes(input.referenceTimes),
    urgency: normalizedUrgency(input.urgency),
    exitReason: normalizedReason(input.exitReason, "Der Austrittsgrund", false),
    hrNote: narrative(input.hrNote, "Der geschuetzte PL-Vermerk", 4000, true),
    documentReferenceIds: documentReferenceIds.sort(),
    assignments: normalizedAssignments(input.assignments, employeeNumber),
  });
  return deepFreeze({
    contractVersion: PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
    operationId,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.PREPARATION,
    protectedPlan,
    runtimeManifest: cloneRuntimeManifest(),
  });
}

function mutationBase(value, expectedKeys, confirmation, label) {
  const input = exactDataObject(value, expectedKeys, label);
  if (input.confirmation !== confirmation) {
    throw inputError(
      `${label} wurde nicht eindeutig bestaetigt.`,
      "PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATION_REQUIRED",
    );
  }
  return {
    input,
    base: {
      operationId: uuidV4(input.operationId, "Die Operations-ID"),
      caseId: uuidV4(
        input.caseId,
        "Die Offboarding-Fall-ID",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_CASE_ID_INVALID",
      ),
      expectedRevision: positiveRevision(input.expectedRevision),
      confirmation,
    },
  };
}

function normalizePersonnelLifecycleOffboardingCommunicationRelease(value) {
  const { input, base } = mutationBase(value, [
    "operationId",
    "caseId",
    "expectedRevision",
    "confirmation",
    "reason",
  ], PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.COMMUNICATION_RELEASE,
  "Die Offboarding-Kommunikationsfreigabe");
  return deepFreeze({ ...base, reason: normalizedReason(input.reason, "Der Freigabegrund") });
}

function normalizePersonnelLifecycleOffboardingTimeCriticalApproval(value) {
  const { input, base } = mutationBase(value, [
    "operationId",
    "caseId",
    "expectedRevision",
    "confirmation",
    "reason",
  ], PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL,
  "Die zeitkritische Offboarding-Freigabe");
  return deepFreeze({ ...base, reason: normalizedReason(input.reason, "Der Ausnahmefreigabegrund") });
}

function normalizePersonnelLifecycleOffboardingInformationConfirmation(value) {
  const { input, base } = mutationBase(value, [
    "operationId",
    "caseId",
    "expectedRevision",
    "confirmation",
    "employeeInformedAt",
  ], PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.INFORMATION_CONFIRMATION,
  "Die Offboarding-Mitarbeiterinformation");
  return deepFreeze({
    ...base,
    employeeInformedAt: isoTimestamp(
      input.employeeInformedAt,
      "Der Zeitpunkt der Mitarbeiterinformation",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_INFORMATION_TIME_INVALID",
    ),
  });
}

function normalizePersonnelLifecycleOffboardingActivation(value) {
  const { base } = mutationBase(value, [
    "operationId",
    "caseId",
    "expectedRevision",
    "confirmation",
  ], PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.ACTIVATION,
  "Die Offboarding-Aktivierung");
  return deepFreeze(base);
}

function normalizePersonnelLifecycleOffboardingCancellation(value) {
  const { input, base } = mutationBase(value, [
    "operationId",
    "caseId",
    "expectedRevision",
    "confirmation",
    "reason",
  ], PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CANCELLATION,
  "Der Offboarding-Abbruch");
  return deepFreeze({ ...base, reason: normalizedReason(input.reason, "Der Abbruchgrund") });
}

function normalizePersonnelLifecycleOffboardingClose(value) {
  const { base } = mutationBase(value, [
    "operationId",
    "caseId",
    "expectedRevision",
    "confirmation",
  ], PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CLOSE,
  "Der Offboarding-Abschluss");
  return deepFreeze(base);
}

const MUTATION_NORMALIZERS = Object.freeze({
  [PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.TIME_CRITICAL_APPROVAL]: (
    normalizePersonnelLifecycleOffboardingTimeCriticalApproval
  ),
  [PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.COMMUNICATION_RELEASE]: (
    normalizePersonnelLifecycleOffboardingCommunicationRelease
  ),
  [PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.INFORMATION_CONFIRMATION]: (
    normalizePersonnelLifecycleOffboardingInformationConfirmation
  ),
  [PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.ACTIVATION]: (
    normalizePersonnelLifecycleOffboardingActivation
  ),
  [PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.CANCELLATION]: (
    normalizePersonnelLifecycleOffboardingCancellation
  ),
  [PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.CLOSE]: (
    normalizePersonnelLifecycleOffboardingClose
  ),
});

function normalizePersonnelLifecycleOffboardingMutation(operationType, value) {
  const normalizer = MUTATION_NORMALIZERS[operationType];
  if (!normalizer) {
    throw inputError(
      "Die Offboarding-Aktion ist ungueltig.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_INVALID",
    );
  }
  return normalizer(value);
}

function personnelLifecycleOffboardingPreparationRequestBody(value) {
  return personnelLifecycleOffboardingRequestReceiptBody(
    "prepare",
    normalizePersonnelLifecycleOffboardingPreparation(value),
  );
}

function personnelLifecycleOffboardingPreparationRequestSha256(value) {
  return personnelLifecycleOffboardingRequestSha256(
    "prepare",
    normalizePersonnelLifecycleOffboardingPreparation(value),
  );
}

function personnelLifecycleOffboardingMutationRequestBody(operationType, value) {
  return personnelLifecycleOffboardingRequestReceiptBody(
    operationType,
    normalizePersonnelLifecycleOffboardingMutation(operationType, value),
  );
}

function personnelLifecycleOffboardingMutationRequestSha256(operationType, value) {
  return personnelLifecycleOffboardingRequestSha256(
    operationType,
    normalizePersonnelLifecycleOffboardingMutation(operationType, value),
  );
}

function personnelLifecycleOffboardingTimeCriticalApprovalRequestSha256(value) {
  return personnelLifecycleOffboardingMutationRequestSha256(
    PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.TIME_CRITICAL_APPROVAL,
    value,
  );
}

function personnelLifecycleOffboardingStepId(familyCode) {
  const definition = FAMILY_BY_CODE.get(String(familyCode ?? ""));
  return definition?.stepId || null;
}

function personnelLifecycleOffboardingOrderId(familyCode) {
  const definition = FAMILY_BY_CODE.get(String(familyCode ?? ""));
  return definition?.orderId || null;
}

function assertPersonnelLifecycleOffboardingContract() {
  const definitions = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS;
  if (definitions.length !== 6
    || new Set(definitions.map(({ familyCode }) => familyCode)).size !== 6) {
    throw new Error("O5 muss genau sechs eindeutige Pflichtfamilien enthalten.");
  }
  const opaqueIds = definitions.flatMap(({ stepId, orderId }) => [stepId, orderId]);
  if (opaqueIds.some((value) => !UUID_V4.test(value))
    || new Set(opaqueIds).size !== opaqueIds.length) {
    throw new Error("O5 braucht eindeutige opake UUIDv4-Schritt- und Auftrags-IDs.");
  }
  for (const definition of definitions) {
    if (definition.recipientClass === RECIPIENT.EMPLOYEE
      || PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES[definition.projection]
        !== definition.recipientClass) {
      throw new Error("O5 enthaelt eine unzulaessige Empfaengerprojektion.");
    }
  }
  if (PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST.some((entry) => (
    Reflect.ownKeys(entry).length !== 2
    || !UUID_V4.test(entry.stepId)
    || !UUID_V4.test(entry.orderId)
  ))) {
    throw new Error("Die O5-Laufzeithuelle darf nur opake Schritt- und Auftrags-IDs enthalten.");
  }
  const runtimeJson = JSON.stringify(PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST);
  if (definitions.some(({ familyCode }) => runtimeJson.includes(familyCode))) {
    throw new Error("Die O5-Laufzeithuelle darf keine fachlichen Klartexte enthalten.");
  }
  return true;
}

assertPersonnelLifecycleOffboardingContract();

module.exports = {
  PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_CONFIRMATIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_REQUIRED_PACKAGE_FAMILIES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST,
  PERSONNEL_LIFECYCLE_OFFBOARDING_URGENCY_MODES,
  PersonnelLifecycleOffboardingContractError,
  assertPersonnelLifecycleOffboardingContract,
  normalizePersonnelLifecycleOffboardingActivation,
  normalizePersonnelLifecycleOffboardingCancellation,
  normalizePersonnelLifecycleOffboardingClose,
  normalizePersonnelLifecycleOffboardingCommunicationRelease,
  normalizePersonnelLifecycleOffboardingInformationConfirmation,
  normalizePersonnelLifecycleOffboardingMutation,
  normalizePersonnelLifecycleOffboardingPreparation,
  normalizePersonnelLifecycleOffboardingTimeCriticalApproval,
  personnelLifecycleOffboardingMutationRequestBody,
  personnelLifecycleOffboardingMutationRequestSha256,
  personnelLifecycleOffboardingOrderId,
  personnelLifecycleOffboardingPreparationRequestBody,
  personnelLifecycleOffboardingPreparationRequestSha256,
  personnelLifecycleOffboardingStepId,
  personnelLifecycleOffboardingTimeCriticalApprovalRequestSha256,
};
