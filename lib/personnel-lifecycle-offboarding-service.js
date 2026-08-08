"use strict";

const {
  PERSONNEL_LIFECYCLE_DATA_CLASSIFICATIONS: CLASSIFICATION,
  PERSONNEL_LIFECYCLE_PROJECTIONS: PROJECTION,
  PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES: RECIPIENT,
} = require("./personnel-lifecycle-case-contract");
const {
  PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST,
  normalizePersonnelLifecycleOffboardingActivation,
  normalizePersonnelLifecycleOffboardingCancellation,
  normalizePersonnelLifecycleOffboardingClose,
  normalizePersonnelLifecycleOffboardingCommunicationRelease,
  normalizePersonnelLifecycleOffboardingInformationConfirmation,
  normalizePersonnelLifecycleOffboardingPreparation,
  normalizePersonnelLifecycleOffboardingTimeCriticalApproval,
  personnelLifecycleOffboardingMutationRequestSha256,
  personnelLifecycleOffboardingPreparationRequestSha256,
} = require("./personnel-lifecycle-offboarding-contract");
const {
  canonicalSha256,
  deterministicUuidV4,
  personnelLifecycleOffboardingAssignmentBindingReceiptSha256,
  personnelLifecycleOffboardingAssignmentReceiptSha256,
  personnelLifecycleOffboardingCaseEventReceiptSha256,
  personnelLifecycleOffboardingConfidentialAccessReceiptSha256,
  personnelLifecycleOffboardingOperationReceiptSha256,
  personnelLifecycleOffboardingPackageBindingReceiptSha256,
  personnelLifecycleOffboardingPackageRunReceiptSha256,
  personnelLifecycleOffboardingPackageVersionReceiptSha256,
  personnelLifecycleOffboardingProtectedPlanReceiptSha256,
  personnelLifecycleOffboardingReferenceDatesReceiptSha256,
  personnelLifecycleOffboardingRunTerminationReceiptSha256,
  personnelLifecycleOffboardingRuntimeStepReceiptSha256,
  personnelLifecycleOffboardingScopeSnapshotSha256,
} = require("./personnel-lifecycle-offboarding-receipt");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONCURRENT_CODES = new Set([
  "PERSISTENCE_UNIQUE_VIOLATION",
  "PERSISTENCE_BUSY",
  "PERSISTENCE_RETRYABLE_TRANSACTION",
]);
/*
 * Fachliches DI-Repository fuer O5. Alle Schreibmethoden liefern
 * `{ rowsAffected: 1 }`; `transaction` muss serializable respektieren.
 * Case-/Task-Lesezeilen verwenden die bestehenden snake_case DB-Felder.
 * `offboardingEmploymentContextForEmployee` liefert den aktiven
 * Mitarbeiterkontext auch ohne bereits vorhandene Beschaeftigungsepisode.
 */
const PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_REPOSITORY_METHODS = Object.freeze([
  "transaction",
  "offboardingOperationById",
  "insertOffboardingOperation",
  "offboardingCaseById",
  "offboardingEmploymentContextForEmployee",
  "insertOffboardingEmploymentEpisode",
  "insertOffboardingLifecycleCase",
  "transitionOffboardingLifecycleCase",
  "transitionOffboardingEmploymentEpisode",
  "insertOffboardingReferenceDates",
  "offboardingCaseEventById",
  "offboardingCaseLastEvent",
  "insertOffboardingLifecycleCaseEvent",
  "offboardingCaseProjection",
  "offboardingConfidentialAccessLastEvent",
  "insertOffboardingConfidentialAccessEvent",
  "offboardingTimeCriticalApprovalStatus",
  "listRecipientCandidates",
  "offboardingPackageVersionById",
  "insertOffboardingPackageVersion",
  "offboardingRuntimeProcessShellById",
  "insertOffboardingRuntimeProcessShell",
  "insertOffboardingPackageBinding",
  "insertOffboardingRun",
  "insertOffboardingPackageRun",
  "insertOffboardingRuntimeStep",
  "insertOffboardingRunStep",
  "insertOffboardingAssignment",
  "insertOffboardingAssignmentBinding",
  "listOffboardingPackageRuns",
  "listOffboardingAssignments",
  "listActiveLifecycleOffboardingTasks",
  "lifecycleOffboardingTaskContext",
  "completeOffboardingRunStep",
  "activateNextOffboardingRunStep",
  "resolveOffboardingRun",
  "insertOffboardingRunTermination",
  "offboardingCaseProgress",
]);

const PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_ERROR_KINDS = Object.freeze({
  INPUT: "input",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INTEGRITY: "integrity",
});

class PersonnelLifecycleOffboardingServiceError extends Error {
  constructor(message, code, kind = PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_ERROR_KINDS.INPUT) {
    super(message);
    this.name = "PersonnelLifecycleOffboardingServiceError";
    this.code = code;
    this.kind = kind;
  }
}

function serviceError(message, code, kind) {
  return new PersonnelLifecycleOffboardingServiceError(message, code, kind);
}

function forbidden(message = "Fuer diese Offboarding-Aktion fehlen die Fachrechte.") {
  return serviceError(
    message,
    "PERSONNEL_LIFECYCLE_OFFBOARDING_PERMISSION_REQUIRED",
    PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_ERROR_KINDS.FORBIDDEN,
  );
}

function notFound(message = "Der Offboarding-Fall wurde nicht gefunden.") {
  return serviceError(
    message,
    "PERSONNEL_LIFECYCLE_OFFBOARDING_NOT_FOUND",
    PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_ERROR_KINDS.NOT_FOUND,
  );
}

function conflict(message, code = "PERSONNEL_LIFECYCLE_OFFBOARDING_CONFLICT") {
  return serviceError(
    message,
    code,
    PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_ERROR_KINDS.CONFLICT,
  );
}

function integrity(message = "Der geschuetzte Offboarding-Fachbeleg ist widerspruechlich.") {
  return serviceError(
    message,
    "PERSONNEL_LIFECYCLE_OFFBOARDING_INTEGRITY_FAILED",
    PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_ERROR_KINDS.INTEGRITY,
  );
}

function inputError(message, code = "PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_INPUT_INVALID") {
  return serviceError(
    message,
    code,
    PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_ERROR_KINDS.INPUT,
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value, label, maximum = 120) {
  if (typeof value !== "string") throw inputError(`${label} ist ungueltig.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return normalized;
}

function uuid(value, label) {
  const normalized = text(value, label, 36).toLowerCase();
  if (!UUID_V4.test(normalized)) throw inputError(`${label} muss eine UUIDv4 sein.`);
  return normalized;
}

function normalizedNow(now) {
  const value = now();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("Die O5-Zeitquelle ist ungueltig.");
  return parsed.toISOString();
}

function assertWrite(result, label) {
  if (Number(result?.rowsAffected || 0) !== 1) {
    throw integrity(`${label} wurde nicht eindeutig gespeichert.`);
  }
}

function field(row, snakeName, camelName = snakeName) {
  if (row && Object.prototype.hasOwnProperty.call(row, snakeName)) return row[snakeName];
  return row?.[camelName];
}

function normalizedActor(actorIdValue, access) {
  const actorId = text(actorIdValue, "Die handelnde Person", 120);
  if (!access || access.namedActor !== true || access.personalEmployee !== true
    || String(access.actorId || "").trim() !== actorId) {
    throw forbidden("Fuer O5 ist eine gueltige persoenliche Sitzung erforderlich.");
  }
  return actorId;
}

function requireCapability(access, capability) {
  if (access?.[capability] !== true) throw forbidden();
}

async function requireTransition(access, fromState, toState) {
  if (typeof access?.canAuthorizeTransition !== "function"
    || await access.canAuthorizeTransition("offboarding", fromState, toState) !== true) {
    throw forbidden();
  }
}

function scopeFromRow(row) {
  const type = String(field(row, "scope_type", "scopeType")
    || field(row, "case_scope_type", "caseScopeType") || "company");
  const locationId = field(row, "location_id", "locationId")
    ?? field(row, "case_location_id", "caseLocationId") ?? null;
  const rawDepartmentId = field(row, "department_id", "departmentId")
    ?? field(row, "case_department_id", "caseDepartmentId");
  const departmentId = rawDepartmentId === null || rawDepartmentId === undefined
    ? null
    : Number(rawDepartmentId);
  if (!["company", "location", "department"].includes(type)
    || (type === "company" && (locationId !== null || departmentId !== null))
    || (type === "location" && (!locationId || departmentId !== null))
    || (type === "department" && (!locationId
      || !Number.isSafeInteger(departmentId) || departmentId < 1))) {
    throw integrity("Der Offboarding-Scope ist ungueltig.");
  }
  return deepFreeze({ type, locationId, departmentId });
}

function flag(value) {
  return value === true || value === 1 || value === "1";
}

function employmentScopeFromContext(row) {
  const locationId = field(row, "location_id", "locationId") ?? null;
  const rawDepartmentId = field(row, "department_id", "departmentId");
  const departmentId = rawDepartmentId === null || rawDepartmentId === undefined
    ? null
    : Number(rawDepartmentId);
  if (departmentId !== null) {
    if (!locationId || !flag(field(row, "location_active", "locationActive"))
      || !flag(field(row, "department_active", "departmentActive"))
      || field(row, "department_location_id", "departmentLocationId") !== locationId
      || !Number.isSafeInteger(departmentId) || departmentId < 1) {
      throw conflict(
        "Der aktive Mitarbeiter besitzt keinen gueltigen Abteilungs-Scope.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_EMPLOYMENT_SCOPE_CONFLICT",
      );
    }
    return deepFreeze({ type: "department", locationId, departmentId });
  }
  if (locationId !== null) {
    if (!locationId || !flag(field(row, "location_active", "locationActive"))) {
      throw conflict(
        "Der aktive Mitarbeiter besitzt keinen gueltigen Standort-Scope.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_EMPLOYMENT_SCOPE_CONFLICT",
      );
    }
    return deepFreeze({ type: "location", locationId, departmentId: null });
  }
  throw conflict(
    "Der aktive Mitarbeiter besitzt keinen gueltigen Standort-Scope.",
    "PERSONNEL_LIFECYCLE_OFFBOARDING_EMPLOYMENT_SCOPE_CONFLICT",
  );
}

function verifiedCase(row, expectedCaseId) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw notFound();
  const caseId = field(row, "id", "caseId") || field(row, "case_id", "caseId");
  const caseType = field(row, "case_type", "caseType");
  const employeeNumber = field(row, "employee_number", "employeeNumber");
  const episodeId = field(row, "employment_episode_id", "employmentEpisodeId");
  const state = field(row, "state", "state") || field(row, "case_state", "caseState");
  const revision = Number(field(row, "revision", "revision")
    ?? field(row, "case_revision", "caseRevision"));
  if (!caseId || (expectedCaseId && caseId !== expectedCaseId)
    || caseType !== "offboarding" || !employeeNumber || !episodeId
    || !["internally_prepared", "communication_released", "employee_informed", "active", "completed", "cancelled"].includes(state)
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw integrity("Der Offboarding-Fall ist ungueltig.");
  }
  return deepFreeze({
    row,
    caseId,
    employeeNumber,
    episodeId,
    episodeState: field(row, "episode_state", "episodeState"),
    episodeRevision: Number(field(row, "episode_revision", "episodeRevision") || 0),
    state,
    revision,
    scope: scopeFromRow(row),
  });
}

function exactTaskCompletion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 2
    || !Object.prototype.hasOwnProperty.call(value, "operationId")
    || !Object.prototype.hasOwnProperty.call(value, "action")) {
    throw inputError("Der Offboarding-Aufgabenabschluss ist ungueltig.");
  }
  if (value.action !== "complete") {
    throw conflict(
      "O5 erlaubt ausschliesslich den expliziten Abschluss complete.",
      "PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_COMPLETE_ONLY",
    );
  }
  return deepFreeze({
    operationId: uuid(value.operationId, "Die Operations-ID"),
    action: "complete",
  });
}

function operationRow(value) {
  return {
    operation_id: field(value, "operation_id", "operationId"),
    case_id: field(value, "case_id", "caseId"),
    operation_type: field(value, "operation_type", "operationType"),
    subject_key: field(value, "subject_key", "subjectKey"),
    request_sha256: field(value, "request_sha256", "requestSha256"),
    plan_receipt_sha256: field(value, "plan_receipt_sha256", "planReceiptSha256") ?? null,
    protected_result_payload: field(
      value,
      "protected_result_payload",
      "protectedResultPayload",
    ),
    result_receipt_sha256: field(value, "result_receipt_sha256", "resultReceiptSha256"),
    actor_id: field(value, "actor_id", "actorId"),
    occurred_at: field(value, "occurred_at", "occurredAt"),
    employee_number: field(value, "employee_number", "employeeNumber"),
  };
}

const FAMILY_BY_CODE = new Map(
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map((definition) => [
    definition.familyCode,
    definition,
  ]),
);
const FAMILY_BY_STEP_ID = new Map(
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map((definition) => [
    definition.stepId,
    definition,
  ]),
);

function createPersonnelLifecycleOffboardingService(repositoryValue, {
  protectJson,
  parseProtectedJson,
  canAssignRecipient = async () => false,
  now = () => new Date(),
} = {}) {
  if (!repositoryValue || typeof repositoryValue !== "object") {
    throw new TypeError("Das O5-Repository fehlt.");
  }
  const missing = PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_REPOSITORY_METHODS.filter((name) => (
    typeof repositoryValue[name] !== "function"
  ));
  if (missing.length) {
    throw new TypeError(`Dem O5-Repository fehlen Methoden: ${missing.join(", ")}.`);
  }
  if (typeof protectJson !== "function" || typeof parseProtectedJson !== "function"
    || typeof canAssignRecipient !== "function" || typeof now !== "function") {
    throw new TypeError("Fuer O5 fehlen sichere Laufzeitfunktionen.");
  }
  const repository = repositoryValue;

  function protectionContext(namespace, recordId, fieldName, employeeNumber = null) {
    return {
      namespace,
      recordId,
      field: fieldName,
      employeeNumber,
    };
  }

  function protect(value, namespace, recordId, fieldName, employeeNumber) {
    if (typeof employeeNumber !== "string" || !employeeNumber.trim()) {
      throw integrity("Fuer den O5-Schutzbeleg fehlt der stabile Datensatzkontext.");
    }
    const protectedPayload = protectJson(
      value,
      protectionContext(namespace, recordId, fieldName, employeeNumber),
    );
    if (typeof protectedPayload !== "string" || !protectedPayload.startsWith("enc:v2:")) {
      throw integrity("Ein O5-Fachbeleg konnte nicht mit enc:v2 geschuetzt werden.");
    }
    return protectedPayload;
  }

  function parse(value, namespace, recordId, fieldName, employeeNumber) {
    if (typeof employeeNumber !== "string" || !employeeNumber.trim()) {
      throw integrity("Fuer den O5-Schutzbeleg fehlt der stabile Datensatzkontext.");
    }
    if (typeof value !== "string" || !value.startsWith("enc:v2:")) {
      throw integrity("Ein O5-Fachbeleg ist nicht mit enc:v2 geschuetzt.");
    }
    try {
      const result = parseProtectedJson(
        value,
        protectionContext(namespace, recordId, fieldName, employeeNumber),
      );
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
      return result;
    } catch (error) {
      if (error instanceof PersonnelLifecycleOffboardingServiceError) throw error;
      throw integrity("Ein O5-Fachbeleg konnte nicht entschluesselt werden.");
    }
  }

  function verifyProtectedPlan(value, caseValue) {
    if (value?.schemaVersion !== 1
      || value?.contractVersion !== PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION
      || value?.employeeNumber !== caseValue.employeeNumber
      || !Array.isArray(value?.assignments)
      || value.assignments.length !== 6) {
      throw integrity("Der geschuetzte O5-Plan ist ungueltig.");
    }
    const codes = new Set();
    for (const assignment of value.assignments) {
      const definition = FAMILY_BY_CODE.get(assignment?.familyCode);
      if (!definition || codes.has(definition.familyCode)
        || assignment.stepId !== definition.stepId
        || assignment.orderId !== definition.orderId
        || assignment.recipientClass !== definition.recipientClass
        || assignment.projection !== definition.projection
        || assignment.assigneeActorId === value.employeeNumber
        || typeof assignment.title !== "string" || !assignment.title
        || typeof assignment.instructions !== "string" || !assignment.instructions) {
        throw integrity("Der geschuetzte O5-Plan enthaelt eine ungueltige Einzelzuweisung.");
      }
      codes.add(definition.familyCode);
    }
    if (codes.size !== 6) throw integrity("Der geschuetzte O5-Plan ist unvollstaendig.");
    return deepFreeze(value);
  }

  function casePlanDocument(caseValue) {
    const protectedPayload = field(caseValue.row, "protected_payload", "protectedPayload")
      || field(caseValue.row, "protected_plan_payload", "protectedPlanPayload");
    const document = parse(
      protectedPayload,
      "personnel-lifecycle-offboarding-case",
      caseValue.caseId,
      "plan",
      caseValue.employeeNumber,
    );
    if (document?.schemaVersion !== 1
      || document?.contractVersion !== PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION
      || !UUID_V4.test(String(document.preparationOperationId || ""))
      || !/^[0-9a-f]{64}$/.test(String(document.planReceiptSha256 || ""))) {
      throw integrity("Der geschuetzte O5-Planbeleg ist ungueltig.");
    }
    const plan = verifyProtectedPlan(document.protectedPlan, caseValue);
    const expected = personnelLifecycleOffboardingProtectedPlanReceiptSha256({
      operationId: document.preparationOperationId,
      employeeNumber: caseValue.employeeNumber,
      protectedPlan: plan,
      runtimeManifest: PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST,
    });
    if (expected !== document.planReceiptSha256) {
      throw integrity("Der geschuetzte O5-Planbeleg stimmt nicht mit dem Plan ueberein.");
    }
    return deepFreeze({ ...document, protectedPlan: plan });
  }

  function planFromCase(caseValue) {
    return casePlanDocument(caseValue).protectedPlan;
  }

  function casePlanReceiptSha256(caseValue) {
    const value = field(caseValue.row, "plan_receipt_sha256", "planReceiptSha256")
      || casePlanDocument(caseValue).planReceiptSha256;
    if (!/^[0-9a-f]{64}$/.test(String(value || ""))) {
      throw integrity("Der O5-Planbeleg fehlt oder ist ungueltig.");
    }
    return value;
  }

  async function appendEvent(currentRepository, {
    actorId,
    caseValue,
    operationId,
    eventType,
    occurredAt,
    payload,
  }) {
    const eventId = deterministicUuidV4(
      "personnel-lifecycle-offboarding-event",
      eventType,
      operationId,
    );
    if (await currentRepository.offboardingCaseEventById({ eventId })) {
      throw conflict(
        "Die O5-Ereignis-ID wurde bereits verwendet.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_EVENT_CONFLICT",
      );
    }
    const last = await currentRepository.offboardingCaseLastEvent({
      caseId: caseValue.caseId,
    });
    const sequenceNumber = last ? Number(field(last, "sequence_number", "sequenceNumber")) + 1 : 1;
    const previousReceiptSha256 = last
      ? field(last, "receipt_sha256", "receiptSha256")
      : "";
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1
      || (last && !/^[0-9a-f]{64}$/.test(String(previousReceiptSha256 || "")))) {
      throw integrity("Die O5-Ereigniskette ist ungueltig.");
    }
    const protectedPayload = protect(
      payload,
      "personnel-lifecycle-offboarding-event",
      eventId,
      "payload",
      caseValue.employeeNumber,
    );
    const row = {
      id: eventId,
      case_id: caseValue.caseId,
      sequence_number: sequenceNumber,
      event_type: eventType,
      data_classification: CLASSIFICATION.OFFBOARDING_STRICT_CONFIDENTIAL,
      protected_payload: protectedPayload,
      previous_receipt_sha256: previousReceiptSha256,
      actor_id: actorId,
      occurred_at: occurredAt,
    };
    row.receipt_sha256 = personnelLifecycleOffboardingCaseEventReceiptSha256(row);
    assertWrite(await currentRepository.insertOffboardingLifecycleCaseEvent({
      id: row.id,
      caseId: row.case_id,
      sequenceNumber: row.sequence_number,
      eventType: row.event_type,
      dataClassification: row.data_classification,
      protectedPayload: row.protected_payload,
      previousReceiptSha256: row.previous_receipt_sha256,
      receiptSha256: row.receipt_sha256,
      actor: row.actor_id,
      occurredAt: row.occurred_at,
    }), "Das O5-Ereignis");
    return row;
  }

  async function replayOperation(currentRepository, existingValue, expected) {
    const row = operationRow(existingValue);
    if (!row.operation_id || !row.protected_result_payload
      || !row.employee_number
      || row.result_receipt_sha256 !== personnelLifecycleOffboardingOperationReceiptSha256(row)) {
      throw integrity("Der O5-Operationsbeleg ist ungueltig.");
    }
    if (row.operation_type !== expected.operationType
      || row.subject_key !== expected.subjectKey
      || row.request_sha256 !== expected.requestSha256
      || row.actor_id !== expected.actorId) {
      throw conflict(
        "Die Operations-ID wurde bereits fuer einen anderen O5-Auftrag verwendet.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_OPERATION_CONFLICT",
      );
    }
    const result = parse(
      row.protected_result_payload,
      "personnel-lifecycle-offboarding-operation",
      row.operation_id,
      "result",
      row.employee_number,
    );
    if (result.operationId !== row.operation_id || result.caseId !== row.case_id) {
      throw integrity("Der O5-Operationsergebnisbeleg passt nicht zum Fall.");
    }
    return deepFreeze({ ...result, replayed: true });
  }

  async function storeOperation(currentRepository, {
    actorId,
    caseId,
    employeeNumber,
    operationId,
    operationType,
    subjectKey,
    requestSha256,
    planReceiptSha256 = null,
    occurredAt,
    result,
  }) {
    const protectedResultPayload = protect(
      result,
      "personnel-lifecycle-offboarding-operation",
      operationId,
      "result",
      employeeNumber,
    );
    const row = {
      operation_id: operationId,
      case_id: caseId,
      operation_type: operationType,
      subject_key: subjectKey,
      request_sha256: requestSha256,
      plan_receipt_sha256: planReceiptSha256,
      protected_result_payload: protectedResultPayload,
      actor_id: actorId,
      occurred_at: occurredAt,
    };
    row.result_receipt_sha256 = personnelLifecycleOffboardingOperationReceiptSha256(row);
    assertWrite(await currentRepository.insertOffboardingOperation({
      operationId: row.operation_id,
      caseId: row.case_id,
      operationType: row.operation_type,
      subjectKey: row.subject_key,
      requestSha256: row.request_sha256,
      planReceiptSha256: row.plan_receipt_sha256,
      protectedResultPayload: row.protected_result_payload,
      resultReceiptSha256: row.result_receipt_sha256,
      actorId: row.actor_id,
      occurredAt: row.occurred_at,
    }), "Der O5-Operationsbeleg");
  }

  async function runSerializable(work) {
    try {
      return await repository.transaction(work, { isolation: "serializable" });
    } catch (error) {
      if (error instanceof PersonnelLifecycleOffboardingServiceError
        || error?.name === "PersonnelLifecycleOffboardingContractError") throw error;
      if (CONCURRENT_CODES.has(error?.code)) {
        throw conflict(
          "Der Offboarding-Fall wurde parallel geaendert. Bitte neu laden.",
          "PERSONNEL_LIFECYCLE_OFFBOARDING_CONCURRENT_CHANGE",
        );
      }
      throw error;
    }
  }

  function candidatePublic(row) {
    const actorId = text(
      field(row, "employee_number", "actorId") || field(row, "actor_id", "actorId"),
      "Die Empfaengeridentitaet",
      120,
    );
    return deepFreeze({
      actorId,
      displayName: text(
        field(row, "full_name", "displayName") || actorId,
        "Der Empfaengername",
        160,
      ),
      roleLabel: text(
        field(row, "role_label", "roleLabel") || field(row, "role", "role"),
        "Die Empfaengerrolle",
        120,
      ),
    });
  }

  async function eligibleRecipientMatrix(currentRepository, plan, scope) {
    const rows = await currentRepository.listRecipientCandidates();
    if (!Array.isArray(rows)) throw integrity("Die O5-Empfaengerliste ist ungueltig.");
    const seen = new Set();
    const normalizedRows = [];
    for (const row of rows) {
      const publicValue = candidatePublic(row);
      if (seen.has(publicValue.actorId)) throw integrity("Die O5-Empfaengerliste ist mehrdeutig.");
      seen.add(publicValue.actorId);
      normalizedRows.push({ row, publicValue });
    }
    const result = new Map();
    for (const definition of PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS) {
      const eligible = [];
      for (const candidate of normalizedRows) {
        if (candidate.publicValue.actorId === plan.employeeNumber) continue;
        if (await canAssignRecipient({
          recipient: candidate.row,
          scope,
          subjectEmployeeNumber: plan.employeeNumber,
          familyCode: definition.familyCode,
          recipientClass: definition.recipientClass,
          projection: definition.projection,
        }) === true) {
          eligible.push(candidate.publicValue);
        }
      }
      eligible.sort((left, right) => left.displayName.localeCompare(
        right.displayName,
        "de-AT",
        { sensitivity: "base" },
      ) || left.actorId.localeCompare(right.actorId));
      result.set(definition.familyCode, deepFreeze(eligible));
    }
    return result;
  }

  async function validateAssignments(currentRepository, plan, scope) {
    const matrix = await eligibleRecipientMatrix(currentRepository, plan, scope);
    for (const assignment of plan.assignments) {
      if (!matrix.get(assignment.familyCode).some(({ actorId }) => (
        actorId === assignment.assigneeActorId
      ))) {
        throw conflict(
          "Eine Offboarding-Einzelzuweisung ist nicht mehr zulaessig.",
          "PERSONNEL_LIFECYCLE_OFFBOARDING_ASSIGNMENT_STALE",
        );
      }
    }
    return matrix;
  }

  async function prepare(actorIdValue, inputValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    requireCapability(access, "canReadOffboardingConfidential");
    requireCapability(access, "canPrepareOffboarding");
    requireCapability(access, "canWriteAssignments");
    const input = normalizePersonnelLifecycleOffboardingPreparation(inputValue);
    if (input.protectedPlan.responsibleActorId !== actorId) throw forbidden();
    await requireTransition(access, null, "internally_prepared");
    const requestSha256 = personnelLifecycleOffboardingPreparationRequestSha256(inputValue);
    const operationType = "prepare";

    return runSerializable(async (currentRepository) => {
      const existing = await currentRepository.offboardingOperationById({
        operationId: input.operationId,
      });
      if (existing) return replayOperation(currentRepository, existing, {
        actorId,
        operationType,
        subjectKey: input.protectedPlan.employeeNumber,
        requestSha256,
      });
      const employment = await currentRepository.offboardingEmploymentContextForEmployee({
        employeeNumber: input.protectedPlan.employeeNumber,
      });
      if (!employment
        || field(employment, "employee_number", "employeeNumber")
          !== input.protectedPlan.employeeNumber) {
        throw notFound("Die aktive Mitarbeiteridentitaet wurde nicht gefunden.");
      }
      if (!flag(field(employment, "employee_active", "employeeActive"))) {
        throw conflict(
          "Die Mitarbeiteridentitaet ist nicht aktiv.",
          "PERSONNEL_LIFECYCLE_OFFBOARDING_EPISODE_STATE_CONFLICT",
        );
      }
      if (field(employment, "current_case_id", "currentCaseId")) {
        throw conflict(
          "Fuer diese Beschaeftigungsepisode besteht bereits ein Offboarding-Fall.",
          "PERSONNEL_LIFECYCLE_OFFBOARDING_CASE_EXISTS",
        );
      }
      const scope = employmentScopeFromContext(employment);
      const occurredAt = normalizedNow(now);
      let episodeId = field(employment, "episode_id", "episodeId")
        || field(employment, "employment_episode_id", "employmentEpisodeId")
        || null;
      let episodeRevision;
      const episodeState = field(employment, "episode_state", "episodeState") ?? null;
      const terminalState = field(
        employment,
        "latest_terminal_case_state",
        "latestTerminalCaseState",
      ) ?? null;
      if (episodeId) {
        if (episodeState !== "employment_active"
          || !Number.isSafeInteger(Number(field(
            employment,
            "episode_revision",
            "episodeRevision",
          )))
          || Number(field(employment, "episode_revision", "episodeRevision")) < 1
          || (terminalState !== null && terminalState !== "cancelled")) {
          throw conflict(
            "Die Beschaeftigungsepisode ist nicht fuer ein neues Offboarding verfuegbar.",
            "PERSONNEL_LIFECYCLE_OFFBOARDING_EPISODE_STATE_CONFLICT",
          );
        }
        episodeRevision = Number(field(employment, "episode_revision", "episodeRevision"));
      } else {
        if (episodeState !== null || terminalState !== null) {
          throw integrity("Der Beschaeftigungskontext ist widerspruechlich.");
        }
        episodeId = deterministicUuidV4(
          "personnel-lifecycle-offboarding-initial-employment-episode",
          input.protectedPlan.employeeNumber,
        );
        assertWrite(await currentRepository.insertOffboardingEmploymentEpisode({
          id: episodeId,
          employeeNumber: input.protectedPlan.employeeNumber,
          sequenceNumber: 1,
          predecessorEpisodeId: null,
          protectedPayload: protect(
            {
              schemaVersion: 1,
              source: "offboarding_initial_episode",
              employeeNumber: input.protectedPlan.employeeNumber,
            },
            "personnel-lifecycle-offboarding-employment-episode",
            episodeId,
            "payload",
            input.protectedPlan.employeeNumber,
          ),
          actor: actorId,
          occurredAt,
        }), "Die initiale Beschaeftigungsepisode");
        episodeRevision = 1;
      }
      await validateAssignments(currentRepository, input.protectedPlan, scope);

      const caseId = deterministicUuidV4("personnel-lifecycle-offboarding-case", input.operationId);
      const planReceiptSha256 = personnelLifecycleOffboardingProtectedPlanReceiptSha256({
        operationId: input.operationId,
        employeeNumber: input.protectedPlan.employeeNumber,
        protectedPlan: input.protectedPlan,
        runtimeManifest: PERSONNEL_LIFECYCLE_OFFBOARDING_RUNTIME_SHELL_MANIFEST,
      });
      const protectedPlanPayload = protect(
        {
          schemaVersion: 1,
          contractVersion: PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
          preparationOperationId: input.operationId,
          planReceiptSha256,
          protectedPlan: input.protectedPlan,
        },
        "personnel-lifecycle-offboarding-case",
        caseId,
        "plan",
        input.protectedPlan.employeeNumber,
      );
      const scopeSnapshotSha256 = personnelLifecycleOffboardingScopeSnapshotSha256(scope);
      const predecessorCaseId = terminalState === "cancelled"
        ? field(employment, "latest_terminal_case_id", "latestTerminalCaseId")
        : null;
      if (terminalState === "cancelled" && !predecessorCaseId) {
        throw integrity("Der abgebrochene Vorgaengerfall fehlt.");
      }
      assertWrite(await currentRepository.insertOffboardingLifecycleCase({
        id: caseId,
        employmentEpisodeId: episodeId,
        predecessorCaseId,
        responsibleActorId: actorId,
        scopeType: scope.type,
        locationId: scope.locationId,
        departmentId: scope.departmentId,
        scopeSnapshotSha256,
        protectedPayload: protectedPlanPayload,
        actor: actorId,
        occurredAt,
      }), "Der O5-Fall");
      const referenceId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-reference-times",
        caseId,
        "1",
      );
      const referenceProtectedPayload = protect(
        {
          schemaVersion: 1,
          referenceTimes: input.protectedPlan.referenceTimes,
          changeReason: input.protectedPlan.exitReason,
        },
        "personnel-lifecycle-offboarding-reference-times",
        referenceId,
        "payload",
        input.protectedPlan.employeeNumber,
      );
      const referenceReceiptSha256 = personnelLifecycleOffboardingReferenceDatesReceiptSha256({
        id: referenceId,
        caseId,
        revision: 1,
        previousRevisionId: null,
        protectedPayload: referenceProtectedPayload,
        changedBy: actorId,
        changedAt: occurredAt,
      });
      assertWrite(await currentRepository.insertOffboardingReferenceDates({
        id: referenceId,
        caseId,
        revision: 1,
        previousRevisionId: null,
        protectedPayload: referenceProtectedPayload,
        receiptSha256: referenceReceiptSha256,
        changedBy: actorId,
        changedAt: occurredAt,
      }), "Die O5-Referenztermine");
      const caseValue = verifiedCase({
        id: caseId,
        case_type: "offboarding",
        employment_episode_id: episodeId,
        employee_number: input.protectedPlan.employeeNumber,
        episode_state: "employment_active",
        episode_revision: episodeRevision,
        state: "internally_prepared",
        revision: 1,
        scope_type: scope.type,
        location_id: scope.locationId,
        department_id: scope.departmentId,
        protected_payload: protectedPlanPayload,
        scope_snapshot_sha256: scopeSnapshotSha256,
      }, caseId);
      const event = await appendEvent(currentRepository, {
        actorId,
        caseValue,
        operationId: input.operationId,
        eventType: "offboarding_internally_prepared",
        occurredAt,
        payload: {
          schemaVersion: 1,
          operationId: input.operationId,
          state: "internally_prepared",
          planReceiptSha256,
        },
      });
      const result = deepFreeze({
        schemaVersion: 1,
        operationId: input.operationId,
        caseId,
        employeeNumber: input.protectedPlan.employeeNumber,
        state: "internally_prepared",
        revision: 1,
        eventId: event.id,
        runtimeCount: 0,
        replayed: false,
      });
      await storeOperation(currentRepository, {
        actorId,
        caseId,
        employeeNumber: input.protectedPlan.employeeNumber,
        operationId: input.operationId,
        operationType,
        subjectKey: input.protectedPlan.employeeNumber,
        requestSha256,
        planReceiptSha256,
        occurredAt,
        result,
      });
      return result;
    });
  }

  async function appendConfidentialAccess(currentRepository, actorId, caseId, occurredAt) {
    const last = await currentRepository.offboardingConfidentialAccessLastEvent({ caseId });
    const sequenceNumber = last
      ? Number(field(last, "sequence_number", "sequenceNumber")) + 1
      : 1;
    const previousReceiptSha256 = last
      ? field(last, "receipt_sha256", "receiptSha256")
      : "";
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1
      || (last && !/^[0-9a-f]{64}$/.test(String(previousReceiptSha256 || "")))) {
      throw integrity("Die vertrauliche O5-Zugriffsbelegkette ist ungueltig.");
    }
    const id = deterministicUuidV4(
      "personnel-lifecycle-offboarding-confidential-access",
      caseId,
      actorId,
      occurredAt,
      sequenceNumber,
      previousReceiptSha256,
    );
    const row = {
      id,
      case_id: caseId,
      sequence_number: sequenceNumber,
      previous_receipt_sha256: previousReceiptSha256,
      actor_id: actorId,
      action: "read_projection",
      result: "allowed",
      purpose_code: "offboarding_case_read",
      occurred_at: occurredAt,
    };
    row.receipt_sha256 = personnelLifecycleOffboardingConfidentialAccessReceiptSha256(row);
    assertWrite(await currentRepository.insertOffboardingConfidentialAccessEvent({
      id: row.id,
      caseId: row.case_id,
      sequenceNumber: row.sequence_number,
      previousReceiptSha256: row.previous_receipt_sha256,
      actor: row.actor_id,
      action: row.action,
      result: row.result,
      purposeCode: row.purpose_code,
      occurredAt: row.occurred_at,
      receiptSha256: row.receipt_sha256,
    }), "Der vertrauliche O5-Zugriffsbeleg");
    return row;
  }

  function runtimeStatusByFamily(caseValue, rows) {
    if (caseValue.state === "internally_prepared") return new Map();
    if (caseValue.state === "cancelled" && Array.isArray(rows) && rows.length === 0) {
      return new Map(PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map((definition) => [
        definition.familyCode,
        "terminated",
      ]));
    }
    if (!Array.isArray(rows) || rows.length !== 6) {
      throw integrity("Die sechs O5-Laufzeitstaende sind unvollstaendig.");
    }
    const result = new Map();
    for (const row of rows) {
      const stepId = field(row, "runtime_step_reference", "runtimeStepReference")
        || field(row, "step_reference", "stepReference")
        || field(row, "step_id", "stepId");
      const definition = FAMILY_BY_STEP_ID.get(stepId);
      if (!definition || field(row, "family_code", "familyCode") !== definition.familyCode
        || result.has(definition.familyCode)) {
        throw integrity("Ein O5-Laufzeitstand ist nicht eindeutig zuordenbar.");
      }
      const terminated = Boolean(
        field(row, "termination_operation_id", "terminationOperationId")
          || field(row, "termination_id", "terminationId")
          || field(row, "terminated_at", "terminatedAt"),
      );
      const stepStatus = field(row, "run_step_status", "runStepStatus")
        || field(row, "step_status", "stepStatus");
      const runStatus = field(row, "run_status", "runStatus")
        || field(row, "status", "status")
        || field(row, "run_status", "runStatus");
      const status = terminated
        ? "terminated"
        : stepStatus === "completed" && runStatus === "resolved"
          ? "complete"
          : stepStatus === "active" && runStatus === "open"
            ? "active"
            : stepStatus === "pending" && runStatus === "open"
              ? "pending"
              : null;
      if (!status) throw integrity("Ein O5-Laufzeitstand besitzt einen ungueltigen Status.");
      result.set(definition.familyCode, status);
    }
    return result;
  }

  async function readProjection(actorIdValue, caseIdValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    requireCapability(access, "canReadOffboardingConfidential");
    if (typeof access.project !== "function") throw forbidden();
    const caseId = uuid(caseIdValue, "Die Offboarding-Fall-ID");
    return runSerializable(async (currentRepository) => {
      const caseValue = verifiedCase(
        await currentRepository.offboardingCaseProjection({ caseId }),
        caseId,
      );
      const plan = planFromCase(caseValue);
      const source = {
        caseId,
        employeeNumber: caseValue.employeeNumber,
        plannedExitAt: plan.referenceTimes.plannedExitAt,
        lastWorkingDay: plan.referenceTimes.lastWorkingDay,
        legalExitDate: plan.referenceTimes.legalExitDate,
        accessBlockAt: plan.referenceTimes.accessBlockAt,
        exitReasonCode: plan.exitReason.code,
        exitReasonNote: plan.exitReason.note,
        communicationReleaseAt: field(
          caseValue.row,
          "communication_release_at",
          "communicationReleaseAt",
        ) ?? null,
        employeeInformedAt: field(
          caseValue.row,
          "employee_informed_at",
          "employeeInformedAt",
        ) ?? null,
        hrNote: plan.hrNote,
        documentReferenceIds: plan.documentReferenceIds,
      };
      const projected = await access.project(source, PROJECTION.OFFBOARDING_CONFIDENTIAL, {
        caseType: "offboarding",
        recipientClass: RECIPIENT.OFFBOARDING_CONFIDENTIAL,
        subjectEmployeeNumber: caseValue.employeeNumber,
        scope: caseValue.scope,
      });
      if (!projected) throw notFound();
      const matrix = await eligibleRecipientMatrix(currentRepository, plan, caseValue.scope);
      const runtimeRows = caseValue.state === "internally_prepared"
        ? []
        : await currentRepository.listOffboardingAssignments({ caseId });
      const statusByFamily = runtimeStatusByFamily(caseValue, runtimeRows);
      const urgencyApproved = plan.urgency.mode === "standard"
        ? true
        : flag((await currentRepository.offboardingTimeCriticalApprovalStatus({ caseId }))?.approved);
      const assignmentByFamily = new Map(
        plan.assignments.map((entry) => [entry.familyCode, entry]),
      );
      const families = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map((definition) => {
        const assignment = assignmentByFamily.get(definition.familyCode);
        return deepFreeze({
          familyCode: definition.familyCode,
          stepId: definition.stepId,
          orderId: definition.orderId,
          recipientClass: definition.recipientClass,
          projection: definition.projection,
          assigneeActorId: assignment.assigneeActorId,
          title: assignment.title,
          instructions: assignment.instructions,
          runtimeStatus: caseValue.state === "internally_prepared"
            ? "confidential_preparation"
            : statusByFamily.get(definition.familyCode),
          candidates: matrix.get(definition.familyCode),
        });
      });
      const accessEvent = await appendConfidentialAccess(
        currentRepository,
        actorId,
        caseId,
        normalizedNow(now),
      );
      const createdAt = field(caseValue.row, "created_at", "createdAt");
      const updatedAt = field(caseValue.row, "updated_at", "updatedAt");
      if (typeof createdAt !== "string" || typeof updatedAt !== "string"
        || !plan.responsibleActorId) {
        throw integrity("Die geschuetzten O5-Steuerungsmetadaten fehlen.");
      }
      return deepFreeze({
        case: projected,
        state: caseValue.state,
        revision: caseValue.revision,
        responsibleActorId: plan.responsibleActorId,
        createdAt,
        updatedAt,
        urgency: deepFreeze({ ...plan.urgency, approved: urgencyApproved }),
        families,
        requestedBy: actorId,
        accessEventId: accessEvent.id,
      });
    });
  }

  async function loadMutationCase(currentRepository, caseId, expectedRevision) {
    const caseValue = verifiedCase(await currentRepository.offboardingCaseById({ caseId }), caseId);
    if (caseValue.revision !== expectedRevision) {
      throw conflict(
        "Die Offboarding-Fallrevision hat sich geaendert.",
        "PERSONNEL_LIFECYCLE_OFFBOARDING_REVISION_CONFLICT",
      );
    }
    return caseValue;
  }

  async function timeCriticalApprove(actorIdValue, inputValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    requireCapability(access, "canReadOffboardingConfidential");
    requireCapability(access, "canApproveExceptions");
    const input = normalizePersonnelLifecycleOffboardingTimeCriticalApproval(inputValue);
    const operationType = PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.TIME_CRITICAL_APPROVAL;
    const requestSha256 = personnelLifecycleOffboardingMutationRequestSha256(
      operationType,
      inputValue,
    );
    return runSerializable(async (currentRepository) => {
      const existing = await currentRepository.offboardingOperationById({
        operationId: input.operationId,
      });
      if (existing) return replayOperation(currentRepository, existing, {
        actorId, operationType, subjectKey: input.caseId, requestSha256,
      });
      const caseValue = await loadMutationCase(
        currentRepository,
        input.caseId,
        input.expectedRevision,
      );
      if (caseValue.state !== "internally_prepared") {
        throw conflict(
          "Die zeitkritische Ausnahme kann nur intern vorbereitet freigegeben werden.",
          "PERSONNEL_LIFECYCLE_OFFBOARDING_STATE_CONFLICT",
        );
      }
      const plan = planFromCase(caseValue);
      const planReceiptSha256 = casePlanReceiptSha256(caseValue);
      if (plan.urgency.mode !== "time_critical") {
        throw conflict(
          "Dieser Offboarding-Fall ist nicht zeitkritisch.",
          "PERSONNEL_LIFECYCLE_OFFBOARDING_NOT_TIME_CRITICAL",
        );
      }
      if (flag((await currentRepository.offboardingTimeCriticalApprovalStatus({
        caseId: caseValue.caseId,
      }))?.approved)) {
        throw conflict(
          "Der zeitkritische Ausnahmeweg wurde bereits freigegeben.",
          "PERSONNEL_LIFECYCLE_OFFBOARDING_TIME_CRITICAL_ALREADY_APPROVED",
        );
      }
      const occurredAt = normalizedNow(now);
      const event = await appendEvent(currentRepository, {
        actorId,
        caseValue,
        operationId: input.operationId,
        eventType: "offboarding_time_critical_approved",
        occurredAt,
        payload: {
          schemaVersion: 1,
          operationId: input.operationId,
          confirmation: input.confirmation,
          reason: input.reason,
          approved: true,
        },
      });
      const result = deepFreeze({
        schemaVersion: 1,
        operationId: input.operationId,
        caseId: caseValue.caseId,
        state: caseValue.state,
        revision: caseValue.revision,
        approved: true,
        eventId: event.id,
        replayed: false,
      });
      await storeOperation(currentRepository, {
        actorId,
        caseId: caseValue.caseId,
        employeeNumber: caseValue.employeeNumber,
        operationId: input.operationId,
        operationType,
        subjectKey: caseValue.caseId,
        requestSha256,
        planReceiptSha256,
        occurredAt,
        result,
      });
      return result;
    });
  }

  async function createReleasedRuntime(currentRepository, caseValue, plan, actorId, occurredAt) {
    const assignmentByFamily = new Map(plan.assignments.map((entry) => [entry.familyCode, entry]));
    const scopeSnapshotSha256 = personnelLifecycleOffboardingScopeSnapshotSha256(caseValue.scope);
    const runtime = [];
    for (const definition of PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS) {
      const assignment = assignmentByFamily.get(definition.familyCode);
      const runtimeManifestSha256 = canonicalSha256({
        stepId: definition.stepId,
        orderId: definition.orderId,
      });
      const packageVersionId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-package-version",
        PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
        definition.familyCode,
      );
      const shellId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-shell",
        PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
        definition.stepId,
      );
      const bindingId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-package-binding",
        caseValue.caseId,
        packageVersionId,
      );
      const runId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-run",
        caseValue.caseId,
        definition.stepId,
      );
      const runOperationId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-run-operation",
        caseValue.caseId,
        definition.stepId,
      );
      const assignmentId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-assignment",
        caseValue.caseId,
        definition.orderId,
      );
      const protectedTaskPayload = protect({
        schemaVersion: 1,
        contractVersion: PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
        familyCode: definition.familyCode,
        stepId: definition.stepId,
        orderId: definition.orderId,
        recipientClass: definition.recipientClass,
        projection: definition.projection,
        title: assignment.title,
        instructions: assignment.instructions,
        referenceTimes: plan.referenceTimes,
      }, "personnel-lifecycle-offboarding-task", assignmentId, "payload", caseValue.employeeNumber);
      const packageVersionBody = {
        schemaVersion: 1,
        contractVersion: PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
        familyCode: definition.familyCode,
        stepId: definition.stepId,
        orderId: definition.orderId,
        recipientClass: definition.recipientClass,
        projection: definition.projection,
      };
      const packageVersionSha256 = canonicalSha256(packageVersionBody);
      const packageProtectionSubject = `O5-PACKAGE:${definition.familyCode}`;
      const protectedPackageVersionPayload = protect(
        packageVersionBody,
        "personnel-lifecycle-offboarding-package-version",
        packageVersionId,
        "payload",
        packageProtectionSubject,
      );
      const packageSeriesId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-package-series",
        PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
        definition.familyCode,
      );
      const packageVersionReceiptRow = {
        id: packageVersionId,
        series_id: packageSeriesId,
        runtime_process_id: shellId,
        version_number: 1,
        predecessor_version_id: null,
        family_code: definition.familyCode,
        path_kind: "both",
        requirement_kind: "mandatory",
        scope_type: "company",
        location_id: null,
        department_id: null,
        data_classification: CLASSIFICATION.OFFBOARDING_STRICT_CONFIDENTIAL,
        protected_snapshot: protectedPackageVersionPayload,
        snapshot_sha256: packageVersionSha256,
        runtime_manifest_sha256: runtimeManifestSha256,
        published_by: actorId,
        published_at: occurredAt,
      };
      const packageVersionReceiptSha256 = (
        personnelLifecycleOffboardingPackageVersionReceiptSha256(packageVersionReceiptRow)
      );
      const shellInsert = await currentRepository.insertOffboardingRuntimeProcessShell({
        runtimeProcessId: shellId,
        versionNumber: 1,
        actor: actorId,
      });
      if (![0, 1].includes(Number(shellInsert?.rowsAffected))) {
        throw integrity("Die neutrale O5-Laufzeithuelle wurde nicht eindeutig sichergestellt.");
      }
      const storedShell = await currentRepository.offboardingRuntimeProcessShellById({
        runtimeProcessId: shellId,
      });
      if (!storedShell
        || field(storedShell, "id", "id") !== shellId
        || field(storedShell, "title", "title") !== "Geschützter Personalprozess"
        || field(storedShell, "symbol", "symbol") !== "P"
        || field(storedShell, "description", "description") !== ""
        || field(storedShell, "category", "category") !== "other"
        || field(storedShell, "scope_type", "scopeType") !== "company"
        || field(storedShell, "location_id", "locationId") !== null
        || field(storedShell, "department_id", "departmentId") !== null
        || field(storedShell, "trigger_type", "triggerType") !== "manual"
        || Number(field(storedShell, "trigger_minimum_shortfall", "triggerMinimumShortfall")) !== 1
        || field(storedShell, "status", "status") !== "active"
        || Number(field(storedShell, "revision", "revision")) !== 1
        || field(storedShell, "archived_at", "archivedAt") !== null) {
        throw integrity("Die neutrale O5-Laufzeithuelle ist ungueltig.");
      }
      const versionInsert = await currentRepository.insertOffboardingPackageVersion({
        id: packageVersionId,
        seriesId: packageSeriesId,
        runtimeProcessId: shellId,
        versionNumber: 1,
        predecessorVersionId: null,
        familyCode: definition.familyCode,
        pathKind: "both",
        requirementKind: "mandatory",
        scopeType: "company",
        locationId: null,
        departmentId: null,
        protectedSnapshot: protectedPackageVersionPayload,
        snapshotSha256: packageVersionSha256,
        runtimeManifestSha256,
        receiptSha256: packageVersionReceiptSha256,
        publishedBy: actorId,
        publishedAt: occurredAt,
      });
      if (![0, 1].includes(Number(versionInsert?.rowsAffected))) {
        throw integrity("Die geschuetzte O5-Paketversion wurde nicht eindeutig sichergestellt.");
      }
      const storedVersion = await currentRepository.offboardingPackageVersionById({
        packageVersionId,
      });
      if (!storedVersion
        || field(storedVersion, "id", "id") !== packageVersionId
        || field(storedVersion, "series_id", "seriesId") !== packageSeriesId
        || field(storedVersion, "runtime_process_id", "runtimeProcessId") !== shellId
        || field(storedVersion, "family_code", "familyCode") !== definition.familyCode
        || Number(field(storedVersion, "version_number", "versionNumber")) !== 1
        || field(storedVersion, "predecessor_version_id", "predecessorVersionId") !== null
        || field(storedVersion, "path_kind", "pathKind") !== "both"
        || field(storedVersion, "requirement_kind", "requirementKind") !== "mandatory"
        || field(storedVersion, "scope_type", "scopeType") !== "company"
        || field(storedVersion, "location_id", "locationId") !== null
        || field(storedVersion, "department_id", "departmentId") !== null
        || field(storedVersion, "data_classification", "dataClassification")
          !== CLASSIFICATION.OFFBOARDING_STRICT_CONFIDENTIAL
        || field(storedVersion, "snapshot_sha256", "snapshotSha256") !== packageVersionSha256
        || field(storedVersion, "runtime_manifest_sha256", "runtimeManifestSha256")
          !== runtimeManifestSha256
        || field(storedVersion, "receipt_sha256", "receiptSha256")
          !== personnelLifecycleOffboardingPackageVersionReceiptSha256(storedVersion)) {
        throw integrity("Die geschuetzte O5-Paketversion ist ungueltig.");
      }
      const storedVersionBody = parse(
        field(storedVersion, "protected_snapshot", "protectedSnapshot"),
        "personnel-lifecycle-offboarding-package-version",
        packageVersionId,
        "payload",
        packageProtectionSubject,
      );
      if (canonicalSha256(storedVersionBody) !== packageVersionSha256) {
        throw integrity("Die geschuetzte O5-Paketversion besitzt einen abweichenden Inhalt.");
      }
      assertWrite(await currentRepository.insertOffboardingPackageBinding({
        id: bindingId,
        caseId: caseValue.caseId,
        packageVersionId,
        versionNumber: 1,
        scopeSnapshotSha256,
        receiptSha256: personnelLifecycleOffboardingPackageBindingReceiptSha256({
          id: bindingId,
          caseId: caseValue.caseId,
          packageVersionId,
          versionNumber: 1,
          scopeSnapshotSha256,
          boundBy: actorId,
          boundAt: occurredAt,
        }),
        boundBy: actorId,
        boundAt: occurredAt,
      }), "Die O5-Paketbindung");
      assertWrite(await currentRepository.insertOffboardingRun({
        id: runId,
        runtimeProcessId: shellId,
        versionNumber: 1,
        runOperationId,
        locationId: caseValue.scope.locationId,
        departmentId: caseValue.scope.departmentId,
        triggeredBy: actorId,
      }), "Die opake O5-Instanz");
      assertWrite(await currentRepository.insertOffboardingPackageRun({
        packageBindingId: bindingId,
        runId,
        runOperationId,
        runtimeManifestSha256,
        scopeSnapshotSha256,
        receiptSha256: personnelLifecycleOffboardingPackageRunReceiptSha256({
          packageBindingId: bindingId,
          runId,
          runOperationId,
          runtimeManifestSha256,
          scopeSnapshotSha256,
          linkedBy: actorId,
          linkedAt: occurredAt,
        }),
        linkedBy: actorId,
        linkedAt: occurredAt,
      }), "Der O5-Paketinstanzbezug");
      assertWrite(await currentRepository.insertOffboardingRuntimeStep({
        packageBindingId: bindingId,
        runId,
        stepReference: definition.stepId,
        orderReference: definition.orderId,
        sortOrder: 1,
        recipientClass: definition.recipientClass,
        releaseGate: "communication_released",
        dataClassification: CLASSIFICATION.PERSONAL_RESTRICTED,
        protectedPayload: protectedTaskPayload,
        receiptSha256: personnelLifecycleOffboardingRuntimeStepReceiptSha256({
          packageBindingId: bindingId,
          runId,
          stepReference: definition.stepId,
          orderReference: definition.orderId,
          sortOrder: 1,
          recipientClass: definition.recipientClass,
          releaseGate: "communication_released",
          dataClassification: CLASSIFICATION.PERSONAL_RESTRICTED,
          protectedPayload: protectedTaskPayload,
          createdBy: actorId,
          createdAt: occurredAt,
        }),
        createdBy: actorId,
        createdAt: occurredAt,
      }), "Der opake O5-Laufzeitschritt");
      assertWrite(await currentRepository.insertOffboardingRunStep({
        runId,
        stepId: definition.stepId,
        sortOrder: 1,
      }), "Der pending O5-Laufzeitschritt");
      assertWrite(await currentRepository.insertOffboardingAssignment({
        id: assignmentId,
        caseId: caseValue.caseId,
        stepReference: definition.stepId,
        assigneeActorId: assignment.assigneeActorId,
        predecessorAssignmentId: null,
        receiptSha256: personnelLifecycleOffboardingAssignmentReceiptSha256({
          id: assignmentId,
          caseId: caseValue.caseId,
          packageBindingId: bindingId,
          runId,
          stepReference: definition.stepId,
          assigneeActorId: assignment.assigneeActorId,
          predecessorAssignmentId: null,
          assignedBy: actorId,
          assignedAt: occurredAt,
        }),
        assignedBy: actorId,
        assignedAt: occurredAt,
      }), "Die O5-Einzelzuweisung");
      assertWrite(await currentRepository.insertOffboardingAssignmentBinding({
        assignmentId,
        packageBindingId: bindingId,
        runId,
        stepReference: definition.stepId,
        receiptSha256: personnelLifecycleOffboardingAssignmentBindingReceiptSha256({
          assignmentId,
          packageBindingId: bindingId,
          runId,
          stepReference: definition.stepId,
          boundBy: actorId,
          boundAt: occurredAt,
        }),
        boundBy: actorId,
        boundAt: occurredAt,
      }), "Der O5-Zuweisungsbezug");
      runtime.push(deepFreeze({
        runId,
        runOperationId,
        stepId: definition.stepId,
        orderId: definition.orderId,
        assignmentId,
      }));
    }
    return deepFreeze(runtime);
  }

  async function releaseCommunication(actorIdValue, inputValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    requireCapability(access, "canReadOffboardingConfidential");
    requireCapability(access, "canReleaseOffboardingCommunication");
    requireCapability(access, "canWriteAssignments");
    await requireTransition(access, "internally_prepared", "communication_released");
    const input = normalizePersonnelLifecycleOffboardingCommunicationRelease(inputValue);
    const operationType = PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.COMMUNICATION_RELEASE;
    const requestSha256 = personnelLifecycleOffboardingMutationRequestSha256(
      operationType,
      inputValue,
    );
    return runSerializable(async (currentRepository) => {
      const existing = await currentRepository.offboardingOperationById({ operationId: input.operationId });
      if (existing) return replayOperation(currentRepository, existing, {
        actorId, operationType, subjectKey: input.caseId, requestSha256,
      });
      const caseValue = await loadMutationCase(currentRepository, input.caseId, input.expectedRevision);
      if (caseValue.state !== "internally_prepared" || caseValue.episodeState !== "employment_active") {
        throw conflict("Der Offboarding-Fall ist nicht intern vorbereitet.", "PERSONNEL_LIFECYCLE_OFFBOARDING_STATE_CONFLICT");
      }
      const plan = planFromCase(caseValue);
      const planReceiptSha256 = casePlanReceiptSha256(caseValue);
      await validateAssignments(currentRepository, plan, caseValue.scope);
      if (plan.urgency.mode === "time_critical") {
        const approval = await currentRepository.offboardingTimeCriticalApprovalStatus({
          caseId: caseValue.caseId,
        });
        if (!flag(approval?.approved)) {
          throw conflict(
            "Der zeitkritische Ausnahmeweg braucht exceptions:approve und einen eigenen Freigabebeleg.",
            "PERSONNEL_LIFECYCLE_OFFBOARDING_TIME_CRITICAL_APPROVAL_REQUIRED",
          );
        }
      }
      const occurredAt = normalizedNow(now);
      assertWrite(await currentRepository.transitionOffboardingLifecycleCase({
        caseId: caseValue.caseId,
        fromState: "internally_prepared",
        toState: "communication_released",
        expectedRevision: caseValue.revision,
        actor: actorId,
        occurredAt,
        communicationReleaseAt: occurredAt,
      }), "Die O5-Kommunikationsfreigabe");
      assertWrite(await currentRepository.transitionOffboardingEmploymentEpisode({
        episodeId: caseValue.episodeId,
        fromState: "employment_active",
        toState: "exit_in_progress",
        expectedRevision: caseValue.episodeRevision,
        actor: actorId,
        occurredAt,
      }), "Der Zustand der Beschaeftigungsepisode");
      const runtime = await createReleasedRuntime(
        currentRepository,
        caseValue,
        plan,
        actorId,
        occurredAt,
      );
      const event = await appendEvent(currentRepository, {
        actorId,
        caseValue,
        operationId: input.operationId,
        eventType: "offboarding_communication_released",
        occurredAt,
        payload: {
          schemaVersion: 1,
          operationId: input.operationId,
          confirmation: input.confirmation,
          reason: input.reason,
          runtimeCount: runtime.length,
        },
      });
      const result = deepFreeze({
        schemaVersion: 1,
        operationId: input.operationId,
        caseId: caseValue.caseId,
        state: "communication_released",
        revision: caseValue.revision + 1,
        runtimeCount: runtime.length,
        eventId: event.id,
        replayed: false,
      });
      await storeOperation(currentRepository, {
        actorId,
        caseId: caseValue.caseId,
        employeeNumber: caseValue.employeeNumber,
        operationId: input.operationId,
        operationType,
        subjectKey: caseValue.caseId,
        requestSha256,
        planReceiptSha256,
        occurredAt,
        result,
      });
      return result;
    });
  }

  async function confirmInformation(actorIdValue, inputValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    requireCapability(access, "canReadOffboardingConfidential");
    requireCapability(access, "canConfirmOffboardingInformation");
    await requireTransition(access, "communication_released", "employee_informed");
    const input = normalizePersonnelLifecycleOffboardingInformationConfirmation(inputValue);
    const operationType = PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.INFORMATION_CONFIRMATION;
    const requestSha256 = personnelLifecycleOffboardingMutationRequestSha256(operationType, inputValue);
    return runSerializable(async (currentRepository) => {
      const existing = await currentRepository.offboardingOperationById({ operationId: input.operationId });
      if (existing) return replayOperation(currentRepository, existing, {
        actorId, operationType, subjectKey: input.caseId, requestSha256,
      });
      const caseValue = await loadMutationCase(currentRepository, input.caseId, input.expectedRevision);
      const planReceiptSha256 = casePlanReceiptSha256(caseValue);
      if (caseValue.state !== "communication_released") {
        throw conflict("Der Offboarding-Fall ist nicht zur Kommunikation freigegeben.", "PERSONNEL_LIFECYCLE_OFFBOARDING_STATE_CONFLICT");
      }
      const occurredAt = normalizedNow(now);
      assertWrite(await currentRepository.transitionOffboardingLifecycleCase({
        caseId: caseValue.caseId,
        fromState: "communication_released",
        toState: "employee_informed",
        expectedRevision: caseValue.revision,
        actor: actorId,
        occurredAt,
        employeeInformedAt: input.employeeInformedAt,
      }), "Die dokumentierte Mitarbeiterinformation");
      const event = await appendEvent(currentRepository, {
        actorId,
        caseValue,
        operationId: input.operationId,
        eventType: "offboarding_employee_informed",
        occurredAt,
        payload: {
          schemaVersion: 1,
          operationId: input.operationId,
          confirmation: input.confirmation,
          employeeInformedAt: input.employeeInformedAt,
        },
      });
      const result = deepFreeze({
        schemaVersion: 1,
        operationId: input.operationId,
        caseId: caseValue.caseId,
        state: "employee_informed",
        revision: caseValue.revision + 1,
        employeeInformedAt: input.employeeInformedAt,
        eventId: event.id,
        replayed: false,
      });
      await storeOperation(currentRepository, {
        actorId, caseId: caseValue.caseId, employeeNumber: caseValue.employeeNumber,
        operationId: input.operationId,
        operationType, subjectKey: caseValue.caseId, requestSha256,
        planReceiptSha256, occurredAt, result,
      });
      return result;
    });
  }

  async function activate(actorIdValue, inputValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    requireCapability(access, "canReadOffboardingConfidential");
    requireCapability(access, "canExecuteOffboarding");
    await requireTransition(access, "employee_informed", "active");
    const input = normalizePersonnelLifecycleOffboardingActivation(inputValue);
    const operationType = PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.ACTIVATION;
    const requestSha256 = personnelLifecycleOffboardingMutationRequestSha256(operationType, inputValue);
    return runSerializable(async (currentRepository) => {
      const existing = await currentRepository.offboardingOperationById({ operationId: input.operationId });
      if (existing) return replayOperation(currentRepository, existing, {
        actorId, operationType, subjectKey: input.caseId, requestSha256,
      });
      const caseValue = await loadMutationCase(currentRepository, input.caseId, input.expectedRevision);
      const planReceiptSha256 = casePlanReceiptSha256(caseValue);
      if (caseValue.state !== "employee_informed") {
        throw conflict("Der Offboarding-Fall ist nicht als Mitarbeiter informiert dokumentiert.", "PERSONNEL_LIFECYCLE_OFFBOARDING_STATE_CONFLICT");
      }
      const runs = await currentRepository.listOffboardingPackageRuns({ caseId: caseValue.caseId });
      if (!Array.isArray(runs) || runs.length !== 6
        || new Set(runs.map((row) => field(row, "family_code", "familyCode"))).size !== 6
        || runs.some((row) => (
          !FAMILY_BY_CODE.has(field(row, "family_code", "familyCode"))
          || field(row, "run_status", "runStatus") !== "open"
          || field(row, "termination_operation_id", "terminationOperationId")
        ))) {
        throw integrity("Die sechs freigegebenen O5-Instanzen fehlen oder sind nicht pending.");
      }
      const occurredAt = normalizedNow(now);
      assertWrite(await currentRepository.transitionOffboardingLifecycleCase({
        caseId: caseValue.caseId,
        fromState: "employee_informed",
        toState: "active",
        expectedRevision: caseValue.revision,
        actor: actorId,
        occurredAt,
      }), "Die O5-Aktivierung");
      for (const row of runs) {
        const definition = FAMILY_BY_CODE.get(field(row, "family_code", "familyCode"));
        assertWrite(await currentRepository.activateNextOffboardingRunStep({
          runId: field(row, "run_id", "runId"),
          stepId: definition.stepId,
          activatedAt: occurredAt,
        }), "Der aktive O5-Schritt");
      }
      const event = await appendEvent(currentRepository, {
        actorId, caseValue, operationId: input.operationId,
        eventType: "offboarding_activated",
        occurredAt,
        payload: { schemaVersion: 1, operationId: input.operationId, activeRunCount: 6 },
      });
      const result = deepFreeze({
        schemaVersion: 1, operationId: input.operationId, caseId: caseValue.caseId,
        state: "active", revision: caseValue.revision + 1, activeRunCount: 6,
        eventId: event.id, replayed: false,
      });
      await storeOperation(currentRepository, {
        actorId, caseId: caseValue.caseId, employeeNumber: caseValue.employeeNumber,
        operationId: input.operationId,
        operationType, subjectKey: caseValue.caseId, requestSha256,
        planReceiptSha256, occurredAt, result,
      });
      return result;
    });
  }

  function taskSource(definition, payload, row) {
    const stepStatus = field(row, "run_step_status", "runStepStatus")
      || field(row, "step_status", "stepStatus");
    const common = {
      orderId: payload.orderId,
      displayName: field(row, "display_name", "displayName")
        || field(row, "employee_number", "employeeNumber"),
      locationId: field(row, "case_location_id", "caseLocationId")
        ?? field(row, "location_id", "locationId") ?? null,
      departmentId: field(row, "case_department_id", "caseDepartmentId")
        ?? field(row, "department_id", "departmentId") ?? null,
      status: stepStatus,
    };
    if (definition.projection === PROJECTION.LEADERSHIP_TASK) {
      return { ...common, title: payload.title, dueAt: payload.referenceTimes.lastWorkingDay };
    }
    if (definition.projection === PROJECTION.IT_SECURITY_TASK) {
      return {
        ...common,
        businessIdentifier: field(row, "employee_number", "employeeNumber"),
        targetSystem: "managed_accesses",
        action: payload.title,
        executeAt: payload.referenceTimes.accessBlockAt,
      };
    }
    if (definition.projection === PROJECTION.ASSET_TASK) {
      return { ...common, assetIdentifier: null, action: payload.title, dueAt: payload.referenceTimes.lastWorkingDay };
    }
    if (definition.projection === PROJECTION.PAYROLL_TASK) {
      return {
        ...common,
        employeeNumber: field(row, "employee_number", "employeeNumber"),
        payrollAction: payload.title,
        effectiveDate: payload.referenceTimes.legalExitDate,
        dueAt: payload.referenceTimes.legalExitDate,
      };
    }
    throw integrity("Die O5-Aufgabenprojektion ist ungueltig.");
  }

  async function projectTask(access, row, actorId, { allowCompletedReplay = false } = {}) {
    const runId = field(row, "run_id", "runId");
    const stepId = field(row, "runtime_step_reference", "runtimeStepReference")
      || field(row, "step_id", "stepId");
    const assignmentId = field(row, "assignment_id", "assignmentId");
    const definition = FAMILY_BY_STEP_ID.get(stepId);
    const caseState = field(row, "case_state", "caseState");
    const runStatus = field(row, "run_status", "runStatus");
    const stepStatus = field(row, "run_step_status", "runStepStatus")
      || field(row, "step_status", "stepStatus");
    const pendingVisible = ["communication_released", "employee_informed"].includes(caseState)
      && runStatus === "open" && stepStatus === "pending";
    const activeVisible = caseState === "active"
      && runStatus === "open" && stepStatus === "active";
    const completedReplayVisible = allowCompletedReplay
      && ["active", "completed"].includes(caseState)
      && runStatus === "resolved" && stepStatus === "completed";
    if (!runId || !assignmentId || !definition
      || field(row, "case_type", "caseType") !== "offboarding"
      || (!pendingVisible && !activeVisible && !completedReplayVisible)
      || field(row, "assignee_actor_id", "assigneeActorId") !== actorId) {
      throw integrity("Der O5-Aufgabenbezug ist ungueltig.");
    }
    const payload = parse(
      field(row, "protected_payload", "protectedPayload"),
      "personnel-lifecycle-offboarding-task",
      assignmentId,
      "payload",
      field(row, "employee_number", "employeeNumber"),
    );
    if (payload.contractVersion !== PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION
      || payload.stepId !== stepId || payload.recipientClass !== definition.recipientClass
      || payload.projection !== definition.projection
      || field(row, "recipient_class", "recipientClass") !== definition.recipientClass
      || field(row, "release_gate", "releaseGate") !== "communication_released"
      || field(row, "data_classification", "dataClassification")
        !== CLASSIFICATION.PERSONAL_RESTRICTED) {
      throw integrity("Der geschuetzte O5-Aufgabenbezug ist ungueltig.");
    }
    const scope = scopeFromRow(row);
    const context = {
      caseType: "offboarding",
      recipientClass: definition.recipientClass,
      assignedActorId: actorId,
      assignmentActive: true,
      operationalReleased: true,
      scope,
    };
    if (typeof access.project !== "function") return null;
    const projected = await access.project(taskSource(definition, payload, row), definition.projection, context);
    if (!projected) return null;
    return deepFreeze({ runId, stepId, canComplete: activeVisible, task: projected });
  }

  async function listTasks(actorIdValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    if (typeof access.project !== "function") throw forbidden();
    const rows = await repository.listActiveLifecycleOffboardingTasks({ actorId });
    if (!Array.isArray(rows)) throw integrity("Die O5-Aufgabenliste ist ungueltig.");
    const items = [];
    const seen = new Set();
    for (const row of rows) {
      const key = `${field(row, "run_id", "runId")}\0${field(
        row,
        "runtime_step_reference",
        "runtimeStepReference",
      ) || field(row, "step_id", "stepId")}`;
      if (seen.has(key)) throw integrity("Die O5-Aufgabenliste ist nicht eindeutig.");
      seen.add(key);
      const projected = await projectTask(access, row, actorId);
      if (projected) items.push(projected);
    }
    return deepFreeze({ items });
  }

  async function completeTask(actorIdValue, runIdValue, stepIdValue, inputValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    const runId = uuid(runIdValue, "Die O5-Instanz-ID");
    const stepId = uuid(stepIdValue, "Die O5-Schritt-ID");
    const input = exactTaskCompletion(inputValue);
    const operationType = "task_complete";
    const subjectKey = `${runId}:${stepId}`;
    const requestSha256 = canonicalSha256({
      schemaVersion: 1,
      contractVersion: PERSONNEL_LIFECYCLE_O5_CONTRACT_VERSION,
      operationType,
      runId,
      stepId,
      input,
    });
    return runSerializable(async (currentRepository) => {
      const row = await currentRepository.lifecycleOffboardingTaskContext({ actorId, runId, stepId });
      if (!row) throw notFound("Die Offboarding-Aufgabe wurde nicht gefunden.");
      const projected = await projectTask(access, row, actorId, { allowCompletedReplay: true });
      if (!projected) throw forbidden();
      const existing = await currentRepository.offboardingOperationById({ operationId: input.operationId });
      if (existing) return replayOperation(currentRepository, existing, {
        actorId, operationType, subjectKey, requestSha256,
      });
      const caseValue = verifiedCase(row, field(row, "case_id", "caseId"));
      const planReceiptSha256 = casePlanReceiptSha256(caseValue);
      if (caseValue.state !== "active"
        || field(row, "run_status", "runStatus") !== "open"
        || (field(row, "run_step_status", "runStepStatus")
          || field(row, "step_status", "stepStatus")) !== "active"
        || field(row, "assignee_actor_id", "assigneeActorId") !== actorId) {
        throw conflict("Die Offboarding-Aufgabe ist nicht aktiv.", "PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_STATE_CONFLICT");
      }
      const occurredAt = normalizedNow(now);
      assertWrite(await currentRepository.completeOffboardingRunStep({
        runId,
        stepId,
        actorId,
        completedAt: occurredAt,
        completionRequestSha256: requestSha256,
      }), "Der O5-Aufgabenabschluss");
      const eventId = deterministicUuidV4(
        "personnel-lifecycle-offboarding-event",
        "offboarding_task_completed",
        input.operationId,
      );
      const result = deepFreeze({
        schemaVersion: 1, operationId: input.operationId, caseId: caseValue.caseId,
        runId, stepId, status: "completed", eventId, replayed: false,
      });
      await storeOperation(currentRepository, {
        actorId, caseId: caseValue.caseId, employeeNumber: caseValue.employeeNumber,
        operationId: input.operationId,
        operationType, subjectKey, requestSha256, planReceiptSha256, occurredAt, result,
      });
      assertWrite(await currentRepository.resolveOffboardingRun({
        runId,
        resolvedAt: occurredAt,
      }), "Die abgeschlossene O5-Instanz");
      const event = await appendEvent(currentRepository, {
        actorId, caseValue, operationId: input.operationId,
        eventType: "offboarding_task_completed",
        occurredAt,
        payload: { schemaVersion: 1, operationId: input.operationId, runId, stepId, action: "complete" },
      });
      if (event.id !== eventId) throw integrity("Der O5-Aufgabenereignisbeleg ist abweichend.");
      return result;
    });
  }

  async function cancel(actorIdValue, inputValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    requireCapability(access, "canReadOffboardingConfidential");
    requireCapability(access, "canCloseOffboarding");
    const input = normalizePersonnelLifecycleOffboardingCancellation(inputValue);
    const operationType = PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.CANCELLATION;
    const requestSha256 = personnelLifecycleOffboardingMutationRequestSha256(operationType, inputValue);
    return runSerializable(async (currentRepository) => {
      const existing = await currentRepository.offboardingOperationById({ operationId: input.operationId });
      if (existing) return replayOperation(currentRepository, existing, {
        actorId, operationType, subjectKey: input.caseId, requestSha256,
      });
      const caseValue = await loadMutationCase(currentRepository, input.caseId, input.expectedRevision);
      const planReceiptSha256 = casePlanReceiptSha256(caseValue);
      if (!["internally_prepared", "communication_released", "employee_informed", "active"].includes(caseValue.state)) {
        throw conflict("Der Offboarding-Fall kann nicht mehr abgebrochen werden.", "PERSONNEL_LIFECYCLE_OFFBOARDING_STATE_CONFLICT");
      }
      await requireTransition(access, caseValue.state, "cancelled");
      const occurredAt = normalizedNow(now);
      const taskRows = caseValue.state === "internally_prepared"
        ? []
        : await currentRepository.listOffboardingAssignments({ caseId: caseValue.caseId });
      if (!Array.isArray(taskRows)
        || (caseValue.state !== "internally_prepared" && taskRows.length !== 6)
        || new Set(taskRows.map((row) => field(row, "run_id", "runId"))).size
          !== taskRows.length) {
        throw integrity("Die O5-Instanzen fuer den additiven Abbruch sind unvollstaendig.");
      }
      const unfinishedRows = taskRows.filter((row) => {
        const runStatus = field(row, "run_status", "runStatus");
        const stepStatus = field(row, "run_step_status", "runStepStatus");
        const terminated = field(row, "termination_operation_id", "terminationOperationId");
        if (terminated) throw integrity("Eine O5-Instanz ist bereits terminiert.");
        if (runStatus === "resolved" && stepStatus === "completed") return false;
        if (runStatus === "open" && ["pending", "active"].includes(stepStatus)) return true;
        throw integrity("Eine O5-Instanz besitzt einen ungueltigen Abbruchstatus.");
      });
      assertWrite(await currentRepository.transitionOffboardingLifecycleCase({
        caseId: caseValue.caseId,
        fromState: caseValue.state,
        toState: "cancelled",
        expectedRevision: caseValue.revision,
        actor: actorId,
        occurredAt,
      }), "Der O5-Abbruch");
      for (const row of unfinishedRows) {
        const runId = field(row, "run_id", "runId");
        const protectedPayload = protect(
          { schemaVersion: 1, reason: input.reason },
          "personnel-lifecycle-offboarding-run-termination",
          runId,
          "reason",
          caseValue.employeeNumber,
        );
        const terminationFields = {
          runId,
          caseId: caseValue.caseId,
          operationId: input.operationId,
          reasonCode: input.reason.code,
          protectedPayload,
          terminatedBy: actorId,
          terminatedAt: occurredAt,
        };
        assertWrite(await currentRepository.insertOffboardingRunTermination({
          ...terminationFields,
          receiptSha256: personnelLifecycleOffboardingRunTerminationReceiptSha256(
            terminationFields,
          ),
        }), "Die additive O5-Instanzterminierung");
        assertWrite(await currentRepository.resolveOffboardingRun({
          runId,
          resolvedAt: occurredAt,
        }), "Die terminierte O5-Instanz");
      }
      if (caseValue.state !== "internally_prepared") {
        assertWrite(await currentRepository.transitionOffboardingEmploymentEpisode({
          episodeId: caseValue.episodeId,
          fromState: "exit_in_progress",
          toState: "employment_active",
          expectedRevision: caseValue.episodeRevision,
          actor: actorId,
          occurredAt,
        }), "Die Ruecknahme des Episodenzustands");
      }
      const event = await appendEvent(currentRepository, {
        actorId, caseValue, operationId: input.operationId,
        eventType: "offboarding_cancelled",
        occurredAt,
        payload: {
          schemaVersion: 1, operationId: input.operationId, reason: input.reason,
          terminatedRunCount: unfinishedRows.length,
        },
      });
      const result = deepFreeze({
        schemaVersion: 1, operationId: input.operationId, caseId: caseValue.caseId,
        state: "cancelled", revision: caseValue.revision + 1,
        terminatedRunCount: unfinishedRows.length, eventId: event.id, replayed: false,
      });
      await storeOperation(currentRepository, {
        actorId, caseId: caseValue.caseId, employeeNumber: caseValue.employeeNumber,
        operationId: input.operationId,
        operationType, subjectKey: caseValue.caseId, requestSha256,
        planReceiptSha256, occurredAt, result,
      });
      return result;
    });
  }

  async function close(actorIdValue, inputValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    requireCapability(access, "canReadOffboardingConfidential");
    requireCapability(access, "canCloseOffboarding");
    await requireTransition(access, "active", "completed");
    const input = normalizePersonnelLifecycleOffboardingClose(inputValue);
    const operationType = PERSONNEL_LIFECYCLE_OFFBOARDING_MUTATION_TYPES.CLOSE;
    const requestSha256 = personnelLifecycleOffboardingMutationRequestSha256(operationType, inputValue);
    return runSerializable(async (currentRepository) => {
      const existing = await currentRepository.offboardingOperationById({ operationId: input.operationId });
      if (existing) return replayOperation(currentRepository, existing, {
        actorId, operationType, subjectKey: input.caseId, requestSha256,
      });
      const caseValue = await loadMutationCase(currentRepository, input.caseId, input.expectedRevision);
      const planReceiptSha256 = casePlanReceiptSha256(caseValue);
      if (caseValue.state !== "active" || caseValue.episodeState !== "exit_in_progress") {
        throw conflict("Der Offboarding-Fall ist nicht aktiv.", "PERSONNEL_LIFECYCLE_OFFBOARDING_STATE_CONFLICT");
      }
      const progress = await currentRepository.offboardingCaseProgress({ caseId: caseValue.caseId });
      const exact = progress
        && field(progress, "case_id", "caseId") === caseValue.caseId
        && Number(field(progress, "package_count", "packageCount")) === 6
        && Number(field(progress, "linked_run_count", "linkedRunCount")) === 6
        && Number(field(progress, "resolved_run_count", "resolvedRunCount")) === 6
        && Number(field(progress, "assignment_count", "assignmentCount")) === 6
        && Number(field(progress, "linked_assignment_count", "linkedAssignmentCount")) === 6
        && Number(field(progress, "total_step_count", "totalStepCount")) === 6
        && Number(field(progress, "pending_step_count", "pendingStepCount") || 0) === 0
        && Number(field(progress, "active_step_count", "activeStepCount") || 0) === 0
        && Number(field(progress, "completed_step_count", "completedStepCount")) === 6
        && Number(field(progress, "skipped_step_count", "skippedStepCount") || 0) === 0
        && Number(field(progress, "termination_count", "terminationCount") || 0) === 0;
      if (!exact) {
        throw conflict(
          "Der Offboarding-Fall besitzt noch offene, ausgelassene oder terminierte Pflichtaufgaben.",
          "PERSONNEL_LIFECYCLE_OFFBOARDING_CLOSE_INCOMPLETE",
        );
      }
      const occurredAt = normalizedNow(now);
      assertWrite(await currentRepository.transitionOffboardingLifecycleCase({
        caseId: caseValue.caseId,
        fromState: "active",
        toState: "completed",
        expectedRevision: caseValue.revision,
        actor: actorId,
        occurredAt,
      }), "Der O5-Abschluss");
      assertWrite(await currentRepository.transitionOffboardingEmploymentEpisode({
        episodeId: caseValue.episodeId,
        fromState: "exit_in_progress",
        toState: "employment_ended",
        expectedRevision: caseValue.episodeRevision,
        actor: actorId,
        occurredAt,
      }), "Der abgeschlossene Episodenzustand");
      const event = await appendEvent(currentRepository, {
        actorId, caseValue, operationId: input.operationId,
        eventType: "offboarding_completed",
        occurredAt,
        payload: { schemaVersion: 1, operationId: input.operationId, completedRunCount: 6 },
      });
      const result = deepFreeze({
        schemaVersion: 1, operationId: input.operationId, caseId: caseValue.caseId,
        state: "completed", revision: caseValue.revision + 1,
        completedRunCount: 6, eventId: event.id, replayed: false,
      });
      await storeOperation(currentRepository, {
        actorId, caseId: caseValue.caseId, employeeNumber: caseValue.employeeNumber,
        operationId: input.operationId,
        operationType, subjectKey: caseValue.caseId, requestSha256,
        planReceiptSha256, occurredAt, result,
      });
      return result;
    });
  }

  return Object.freeze({
    prepare,
    readProjection,
    timeCriticalApprove,
    releaseCommunication,
    confirmInformation,
    activate,
    listTasks,
    completeTask,
    cancel,
    close,
  });
}

module.exports = {
  PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_ERROR_KINDS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_REPOSITORY_METHODS,
  PersonnelLifecycleOffboardingServiceError,
  createPersonnelLifecycleOffboardingService,
};
