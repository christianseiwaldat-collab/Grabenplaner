"use strict";

const { createHash, randomUUID: cryptoRandomUUID } = require("node:crypto");
const {
  personnelWorkflowInstanceReceiptBody,
  personnelWorkflowTaskAssignmentReceiptBody,
} = require("./personnel-workflow-instance-receipt");
const {
  verifyPersonnelWorkflowPublication,
} = require("./personnel-workflow-publications");

const PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS = Object.freeze({
  INPUT: "input",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INTEGRITY: "integrity",
});

const CANDIDATE_WORKFLOW_TYPES = new Set(["application", "preboarding"]);
const EMPLOYEE_WORKFLOW_TYPES = new Set([
  "training",
  "position_change",
  "department_change",
  "location_change",
  "return_from_absence",
]);
const DEFERRED_WORKFLOW_TYPES = new Set([
  "onboarding",
  "offboarding",
  "custom_personnel",
]);
const TERMINAL_APPLICATION_STATUSES = new Set([
  "converted",
  "rejected",
  "withdrawn",
  "archived",
]);
const CONCURRENT_PERSISTENCE_ERROR_CODES = new Set([
  "PERSISTENCE_UNIQUE_VIOLATION",
  "PERSISTENCE_BUSY",
  "PERSISTENCE_RETRYABLE_TRANSACTION",
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_STEPS = 30;

const REQUIRED_REPOSITORY_METHODS = Object.freeze([
  "workflowPublicationById",
  "personnelWorkflowCandidateSubject",
  "personnelWorkflowEmployeeSubject",
  "responsibilityCandidate",
  "runBindingByOperationId",
  "personnelWorkflowInstanceById",
  "insertRun",
  "insertRunBinding",
  "insertRunStep",
  "insertRunStepAssignment",
  "activeRunStep",
  "pendingRunStep",
  "completeSystemRunStep",
  "activateRunStep",
  "resolveRun",
  "listPersonnelWorkflowInstances",
  "listActivePersonnelWorkflowTaskRuns",
  "listRunStepAssignments",
  "runStepById",
  "runStepCounts",
  "completeRunStep",
  "insertAudit",
  "transaction",
]);
const TRANSACTION_BOUND_REQUIRED_REPOSITORY_METHODS = Object.freeze(
  REQUIRED_REPOSITORY_METHODS.filter((name) => name !== "transaction"),
);

class PersonnelWorkflowInstanceError extends Error {
  constructor(message, code, kind = PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.INPUT) {
    super(message);
    this.name = "PersonnelWorkflowInstanceError";
    this.code = code;
    this.kind = kind;
  }
}

function instanceError(message, code, kind) {
  return new PersonnelWorkflowInstanceError(message, code, kind);
}

function inputError(message, code = "PERSONNEL_WORKFLOW_INSTANCE_INPUT_INVALID") {
  return instanceError(message, code, PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.INPUT);
}

function integrityError(message = "Die Workflow-Instanz besitzt keinen gueltigen Integritaetsbeleg.") {
  return instanceError(
    message,
    "PERSONNEL_WORKFLOW_INSTANCE_INTEGRITY_FAILED",
    PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.INTEGRITY,
  );
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw inputError(`${label} enthaelt unbekannte Felder.`);
  }
}

function text(value, label, maximum = 120) {
  if (typeof value !== "string") throw inputError(`${label} ist ungueltig.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return normalized;
}

function positiveRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return value;
}

function normalizedOperationId(value) {
  const operationId = text(value, "Die Operations-ID", 36).toLowerCase();
  if (!UUID_V4.test(operationId)) {
    throw inputError(
      "Die Operations-ID muss eine UUIDv4 sein.",
      "PERSONNEL_WORKFLOW_INSTANCE_OPERATION_ID_INVALID",
    );
  }
  return operationId;
}

function normalizedTaskOperationId(value) {
  try {
    return normalizedOperationId(value);
  } catch (error) {
    if (!(error instanceof PersonnelWorkflowInstanceError)) throw error;
    throw inputError(
      "Die Aufgaben-Operations-ID muss eine UUIDv4 sein.",
      "PERSONNEL_WORKFLOW_TASK_OPERATION_ID_INVALID",
    );
  }
}

function normalizedSubject(value) {
  const subject = plainObject(value, "Der Workflow-Bezug");
  const type = text(subject.type, "Der Bezugstyp", 20);
  if (type === "candidate") {
    exactKeys(subject, new Set([
      "type", "candidateId", "applicationId", "candidateRevision", "applicationRevision",
    ]), "Der Bewerbungsbezug");
    return Object.freeze({
      type,
      candidateId: text(subject.candidateId, "Die Bewerber-ID"),
      applicationId: text(subject.applicationId, "Die Bewerbungs-ID"),
      candidateRevision: positiveRevision(subject.candidateRevision, "Die Bewerber-Revision"),
      applicationRevision: positiveRevision(
        subject.applicationRevision,
        "Die Bewerbungs-Revision",
      ),
    });
  }
  if (type === "employee") {
    exactKeys(subject, new Set(["type", "employeeNumber"]), "Der Mitarbeiterbezug");
    return Object.freeze({
      type,
      employeeNumber: text(subject.employeeNumber, "Die Personalnummer", 80),
    });
  }
  throw inputError("Der Workflow-Bezug muss candidate oder employee sein.");
}

function normalizedAssignments(value) {
  if (!Array.isArray(value) || value.length > MAX_STEPS) {
    throw inputError("Die Aufgabenzuordnungen sind ungueltig.");
  }
  const seen = new Set();
  const assignments = value.map((entry, index) => {
    const assignment = plainObject(entry, `Die Aufgabenzuordnung ${index + 1}`);
    exactKeys(
      assignment,
      new Set(["stepId", "employeeNumber"]),
      `Die Aufgabenzuordnung ${index + 1}`,
    );
    const normalized = Object.freeze({
      stepId: text(assignment.stepId, "Die Schritt-ID"),
      employeeNumber: text(assignment.employeeNumber, "Die Personalnummer", 80),
    });
    if (seen.has(normalized.stepId)) {
      throw inputError("Jeder Workflow-Schritt darf nur einmal zugeordnet werden.");
    }
    seen.add(normalized.stepId);
    return normalized;
  });
  return Object.freeze(assignments);
}

function normalizedStartInput(value) {
  const input = plainObject(value, "Der Workflow-Start");
  exactKeys(
    input,
    new Set(["operationId", "publicationId", "subject", "assignments"]),
    "Der Workflow-Start",
  );
  return Object.freeze({
    operationId: normalizedOperationId(input.operationId),
    publicationId: text(input.publicationId, "Die Workflow-Versions-ID"),
    subject: normalizedSubject(input.subject),
    assignments: normalizedAssignments(input.assignments),
  });
}

function normalizedTaskCompletionInput(value) {
  const input = plainObject(value, "Der Aufgabenabschluss");
  exactKeys(input, new Set(["action", "operationId"]), "Der Aufgabenabschluss");
  const action = text(input.action, "Die Aufgabenaktion", 20);
  if (!new Set(["complete", "skip"]).has(action)) {
    throw inputError(
      "Die Aufgabenaktion muss complete oder skip sein.",
      "PERSONNEL_WORKFLOW_TASK_ACTION_INVALID",
    );
  }
  return Object.freeze({
    action,
    operationId: normalizedTaskOperationId(input.operationId),
  });
}

function requestSha256(input) {
  const assignments = [...input.assignments]
    .sort((left, right) => (left.stepId < right.stepId ? -1 : (left.stepId > right.stepId ? 1 : 0)))
    .map(({ stepId, employeeNumber }) => ({ stepId, employeeNumber }));
  return sha256(JSON.stringify({
    schemaVersion: 1,
    operationId: input.operationId,
    publicationId: input.publicationId,
    subject: input.subject,
    assignments,
  }));
}

function taskCompletionSha256({ actorId, runId, stepId, action, operationId }) {
  return sha256(JSON.stringify({
    schemaVersion: 1,
    operationId,
    runId,
    stepId,
    action,
    actorId,
    activationCount: 1,
  }));
}

function normalizedNow(now) {
  const value = now();
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError("Die M5-Zeitquelle lieferte keinen gueltigen Zeitpunkt.");
  }
  return instant.toISOString();
}

function assertRepository(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Ein M5-Workflow-Repository wird benoetigt.");
  }
  const missing = REQUIRED_REPOSITORY_METHODS
    .filter((name) => typeof value[name] !== "function");
  if (missing.length) {
    throw new TypeError(`Dem M5-Workflow-Repository fehlen Methoden: ${missing.join(", ")}.`);
  }
  return value;
}

function assertTransactionBoundRepository(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Ein transaktionsgebundenes M5-Workflow-Repository wird benoetigt.");
  }
  const missing = TRANSACTION_BOUND_REQUIRED_REPOSITORY_METHODS
    .filter((name) => typeof value[name] !== "function");
  if (missing.length) {
    throw new TypeError(
      `Dem transaktionsgebundenen M5-Workflow-Repository fehlen Methoden: ${missing.join(", ")}.`,
    );
  }
  if (typeof value.transaction === "function") {
    throw new TypeError(
      "Die Lifecycle-Onboarding-Primitive verlangt ein bereits transaktionsgebundenes Repository ohne eigene Transaktionsmethode.",
    );
  }
  return value;
}

function verifiedPublication(row) {
  try {
    return verifyPersonnelWorkflowPublication(row);
  } catch (error) {
    if (error?.kind === "integrity") {
      throw integrityError("Die Workflow-Version besitzt keinen gueltigen Integritaetsbeleg.");
    }
    throw error;
  }
}

function publicPublication(value) {
  const { row, snapshot, scope } = value;
  return deepFreeze({
    id: row.id,
    processId: row.process_id,
    sourceRevision: Number(row.source_revision),
    versionNumber: Number(row.version_number),
    workflowCode: row.workflow_code,
    workflowType: row.workflow_type,
    authorityLevel: row.authority_level,
    requirementKind: row.requirement_kind,
    dataClassification: row.data_classification,
    scope,
    title: String(snapshot.title || ""),
    archived: Boolean(row.archived_at),
    publishedAt: row.published_at,
    archivedAt: row.archived_at || null,
  });
}

function publicationFromInstanceRow(row) {
  return {
    id: row.publication_id,
    process_id: row.process_id,
    source_revision: row.process_revision,
    version_number: row.version_number,
    workflow_code: row.workflow_code,
    workflow_type: row.workflow_type,
    authority_level: row.authority_level,
    requirement_kind: row.requirement_kind,
    data_classification: row.data_classification,
    scope_type: row.publication_scope_type,
    location_id: row.publication_location_id,
    department_id: row.publication_department_id,
    snapshot_json: row.snapshot_json,
    snapshot_sha256: row.snapshot_sha256,
    receipt_sha256: row.publication_receipt_sha256,
    published_by: row.published_by,
    published_at: row.published_at,
    archived_at: row.publication_archived_at || null,
  };
}

function normalizedSnapshotSteps(publicationValue) {
  const { snapshot } = publicationValue;
  if (!Array.isArray(snapshot.steps)
    || snapshot.steps.length < 1
    || snapshot.steps.length > MAX_STEPS) {
    throw integrityError("Die Workflow-Version besitzt keine gueltige Schrittliste.");
  }
  const seen = new Set();
  return Object.freeze(snapshot.steps.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw integrityError("Die Workflow-Version besitzt einen ungueltigen Schritt.");
    }
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const responsibilityType = typeof value.responsibilityType === "string"
      ? value.responsibilityType.trim()
      : "";
    const reference = typeof value.responsibilityReference === "string"
      ? value.responsibilityReference.trim()
      : "";
    const conditionType = typeof value.conditionType === "string"
      ? value.conditionType.trim()
      : "always";
    if (!id || id.length > 120 || /[\0\r\n]/.test(id) || seen.has(id)
      || !["system", "role", "employee"].includes(responsibilityType)
      || !["always", "when", "optional"].includes(conditionType)
      || (responsibilityType === "system" ? Boolean(reference) : !reference)) {
      throw integrityError("Die Workflow-Version besitzt einen ungueltigen Schritt.");
    }
    const channels = value.notificationChannels;
    if (channels !== undefined && (!Array.isArray(channels) || channels.length > 0)) {
      throw instanceError(
        "Workflow-Benachrichtigungen bleiben bis zum eigenen Schutzvertrag gesperrt.",
        "PERSONNEL_WORKFLOW_INSTANCE_NOTIFICATIONS_DEFERRED",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
      );
    }
    seen.add(id);
    return deepFreeze({
      id,
      sortOrder: index + 1,
      title: String(value.title || "").trim(),
      description: String(value.description || "").trim(),
      responsibilityType,
      responsibilityReference: reference || null,
      conditionType,
    });
  }));
}

function ensureWorkflowMatrix(subjectType, workflowType, { lifecycleOnboarding = false } = {}) {
  if (lifecycleOnboarding) {
    if (subjectType === "employee" && workflowType === "onboarding") return;
    throw instanceError(
      "Die transaktionsgebundene Lifecycle-Primitive ist ausschliesslich fuer Mitarbeiter-Onboarding zulaessig.",
      "PERSONNEL_WORKFLOW_LIFECYCLE_ONBOARDING_TYPE_REQUIRED",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  if (DEFERRED_WORKFLOW_TYPES.has(workflowType)) {
    throw instanceError(
      "Dieser Personalworkflow bleibt bis zum eigenen Fach- und Schutzvertrag gesperrt.",
      "PERSONNEL_WORKFLOW_INSTANCE_TYPE_DEFERRED",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  const allowed = subjectType === "candidate"
    ? CANDIDATE_WORKFLOW_TYPES
    : EMPLOYEE_WORKFLOW_TYPES;
  if (!allowed.has(workflowType)) {
    throw inputError(
      "Workflow-Typ und Bezugstyp passen nicht zusammen.",
      "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_TYPE_INVALID",
    );
  }
}

function activeFlag(value) {
  return value === true || Number(value) === 1;
}

function scopeForSubject(row, { requireActive = true } = {}) {
  const locationId = row.location_id === null || row.location_id === undefined
    ? null
    : String(row.location_id).trim() || null;
  const departmentId = row.department_id === null || row.department_id === undefined
    || row.department_id === ""
    ? null
    : Number(row.department_id);
  if (departmentId !== null && (!Number.isSafeInteger(departmentId) || departmentId < 1)) {
    throw instanceError(
      "Der fachliche Bezug besitzt einen ungueltigen Geltungsbereich.",
      "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_SCOPE_INVALID",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  if (!locationId && departmentId !== null) {
    throw instanceError(
      "Der fachliche Bezug besitzt einen ungueltigen Geltungsbereich.",
      "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_SCOPE_INVALID",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  if (requireActive && locationId && !activeFlag(row.location_active)) {
    throw instanceError(
      "Der fachliche Standort ist nicht aktiv.",
      "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_SCOPE_INACTIVE",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  if (requireActive && departmentId !== null && (!activeFlag(row.department_active)
    || String(row.department_location_id || "") !== locationId)) {
    throw instanceError(
      "Die fachliche Abteilung ist nicht aktiv oder dem Standort nicht eindeutig zugeordnet.",
      "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_SCOPE_INACTIVE",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  return deepFreeze({
    type: departmentId !== null ? "department" : (locationId ? "location" : "company"),
    locationId,
    departmentId,
  });
}

function publicationAppliesTo(publicationScope, subjectScope) {
  if (publicationScope.type === "company") return true;
  if (publicationScope.locationId !== subjectScope.locationId) return false;
  return publicationScope.type === "location"
    || publicationScope.departmentId === subjectScope.departmentId;
}

function publicSubject(input, scope) {
  if (input.type === "candidate") {
    return deepFreeze({
      type: "candidate",
      candidateId: input.candidateId,
      applicationId: input.applicationId,
      candidateRevision: input.candidateRevision,
      applicationRevision: input.applicationRevision,
      scope,
    });
  }
  return deepFreeze({
    type: "employee",
    employeeNumber: input.employeeNumber,
    scope,
  });
}

async function loadSubject(repository, input, publication) {
  let row;
  if (input.type === "candidate") {
    row = await repository.personnelWorkflowCandidateSubject({
      candidateId: input.candidateId,
      applicationId: input.applicationId,
    });
    if (!row) {
      throw instanceError(
        "Die Workflow-Version oder der fachliche Bezug wurde nicht gefunden.",
        "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.NOT_FOUND,
      );
    }
    if (row.subject_type !== "candidate"
      || row.candidate_id !== input.candidateId
      || row.application_id !== input.applicationId) {
      throw integrityError("Das Repository lieferte einen widerspruechlichen Bewerbungsbezug.");
    }
  } else {
    row = await repository.personnelWorkflowEmployeeSubject({
      employeeNumber: input.employeeNumber,
    });
    if (!row) {
      throw instanceError(
        "Die Workflow-Version oder der fachliche Bezug wurde nicht gefunden.",
        "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.NOT_FOUND,
      );
    }
    if (row.subject_type !== "employee" || row.employee_number !== input.employeeNumber) {
      throw integrityError("Das Repository lieferte einen widerspruechlichen Mitarbeiterbezug.");
    }
  }
  const scope = scopeForSubject(row, { requireActive: false });
  return Object.freeze({ row, scope, subject: publicSubject(input, scope) });
}

function validateLoadedSubject(input, publication, subjectValue) {
  const { row } = subjectValue;
  if (input.type === "candidate") {
    if (Number(row.candidate_revision) !== input.candidateRevision
      || Number(row.application_revision) !== input.applicationRevision) {
      throw instanceError(
        "Der Bewerbungsbezug wurde zwischenzeitlich geaendert.",
        "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_REVISION_CONFLICT",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
      );
    }
    if (row.candidate_state !== "active"
      || TERMINAL_APPLICATION_STATUSES.has(row.application_status)
      || (publication.row.workflow_type === "preboarding"
        && !["accepted", "preboarding"].includes(row.application_status))) {
      throw instanceError(
        "Der Bewerbungsbezug befindet sich nicht in einem startbaren Status.",
        "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_STATE_INVALID",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
      );
    }
  } else if (!activeFlag(row.employee_active)) {
    throw instanceError(
      "Der Mitarbeiterbezug ist nicht aktiv.",
      "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_STATE_INVALID",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  const activeScope = scopeForSubject(row);
  if (activeScope.type !== subjectValue.scope.type
    || activeScope.locationId !== subjectValue.scope.locationId
    || activeScope.departmentId !== subjectValue.scope.departmentId) {
    throw integrityError("Der fachliche Subject-Scope ist widerspruechlich.");
  }
  if (!publicationAppliesTo(publication.scope, activeScope)) {
    throw instanceError(
      "Die Workflow-Version gilt nicht fuer den fachlichen Bezug.",
      "PERSONNEL_WORKFLOW_INSTANCE_SCOPE_MISMATCH",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
}

async function requireStartAccess(access, publication, subjectValue) {
  const publicValue = publicPublication(publication);
  const subjectCallback = subjectValue.subject.type === "candidate"
    ? access?.canStartCandidateSubject
    : access?.canStartEmployeeSubject;
  if (typeof access?.canStartScope !== "function"
    || typeof subjectCallback !== "function"
    || await access.canStartScope(subjectValue.scope, publicValue) !== true
    || await subjectCallback.call(access, subjectValue.subject, publicValue) !== true) {
    throw instanceError(
      "Die Workflow-Version oder der fachliche Bezug wurde nicht gefunden.",
      "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.NOT_FOUND,
    );
  }
  return publicValue;
}

async function verifiedAssignments(repository, requested, steps, context) {
  const nonSystem = steps.filter(({ responsibilityType }) => responsibilityType !== "system");
  const requestedByStep = new Map(requested.map((assignment) => [assignment.stepId, assignment]));
  if (requested.length !== nonSystem.length
    || nonSystem.some(({ id }) => !requestedByStep.has(id))) {
    throw inputError(
      "Alle fachlichen Schritte muessen exakt einmal zugeordnet werden; Systemschritte duerfen keine Zuordnung erhalten.",
      "PERSONNEL_WORKFLOW_INSTANCE_ASSIGNMENTS_INVALID",
    );
  }
  const result = [];
  for (const step of nonSystem) {
    const assignment = requestedByStep.get(step.id);
    const recipient = await repository.responsibilityCandidate({
      employeeNumber: assignment.employeeNumber,
    });
    const responsibilityMatches = recipient
      && !((step.responsibilityType === "employee"
      && assignment.employeeNumber !== step.responsibilityReference)
      || (step.responsibilityType === "role"
        && recipient.role !== step.responsibilityReference));
    const assignmentAllowed = responsibilityMatches
      && typeof context.access?.canAssignPersonnelWorkflowStep === "function"
      && await context.access.canAssignPersonnelWorkflowStep({
        publication: context.publication,
        subject: context.subject,
        scope: context.scope,
        step,
        assignment,
        recipient,
      }) === true;
    if (!assignmentAllowed) {
      throw instanceError(
        "Eine Aufgabenzuordnung wurde im freigegebenen Bereich nicht gefunden.",
        "PERSONNEL_WORKFLOW_INSTANCE_ASSIGNMENT_NOT_FOUND",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.NOT_FOUND,
      );
    }
    result.push(Object.freeze({ ...assignment, step, recipient }));
  }
  return Object.freeze(result);
}

function bindingReceiptRow(row) {
  return {
    run_id: row.id || row.run_id,
    publication_id: row.publication_id,
    operation_id: row.operation_id,
    subject_type: row.subject_type,
    candidate_id: row.candidate_id || null,
    application_id: row.application_id || null,
    candidate_revision: Number(row.candidate_revision || 0) || null,
    application_revision: Number(row.application_revision || 0) || null,
    employee_number: row.employee_number || null,
    location_id: row.location_id || null,
    department_id: Number(row.department_id || 0) || null,
    request_sha256: row.request_sha256,
    started_by: row.started_by,
    started_at: row.started_at,
  };
}

function verifyBindingReceipt(row) {
  const receipt = sha256(JSON.stringify(personnelWorkflowInstanceReceiptBody(
    bindingReceiptRow(row),
  )));
  if (!UUID_V4.test(String(row.operation_id || ""))
    || !SHA256.test(String(row.request_sha256 || ""))
    || receipt !== String(row.binding_receipt_sha256 || row.receipt_sha256 || "")) {
    throw integrityError();
  }
}

function scopeFromInstanceRow(row) {
  const locationId = row.location_id === null || row.location_id === undefined
    ? null
    : String(row.location_id).trim() || null;
  const departmentId = row.department_id === null || row.department_id === undefined
    ? null
    : Number(row.department_id);
  if ((!locationId && departmentId !== null)
    || (departmentId !== null
      && (!Number.isSafeInteger(departmentId) || departmentId < 1))) {
    throw integrityError("Die Workflow-Instanz besitzt einen ungueltigen Geltungsbereich.");
  }
  return deepFreeze({
    type: departmentId !== null ? "department" : (locationId ? "location" : "company"),
    locationId,
    departmentId,
  });
}

function verifyInstanceRelation(row, publication, { lifecycleOnboarding = false } = {}) {
  verifyBindingReceipt(row);
  const scope = scopeFromInstanceRow(row);
  if (row.trigger_type !== "personnel_manual"
    || row.trigger_key !== `personnel:${row.operation_id}`
    || row.process_id !== publication.row.process_id
    || Number(row.process_revision) !== Number(publication.row.source_revision)
    || row.publication_id !== publication.row.id
    || row.triggered_by !== row.started_by
    || Number(row.activation_count) !== 1
    || !["open", "resolved"].includes(row.status)
    || !publicationAppliesTo(publication.scope, scope)) {
    throw integrityError("Die Workflow-Instanz ist widerspruechlich verknuepft.");
  }
  ensureWorkflowMatrix(
    row.subject_type,
    publication.row.workflow_type,
    { lifecycleOnboarding },
  );
  const candidateBinding = row.subject_type === "candidate"
    && typeof row.candidate_id === "string" && Boolean(row.candidate_id.trim())
    && typeof row.application_id === "string" && Boolean(row.application_id.trim())
    && Number.isSafeInteger(Number(row.candidate_revision))
    && Number(row.candidate_revision) >= 1
    && Number.isSafeInteger(Number(row.application_revision))
    && Number(row.application_revision) >= 1
    && !row.employee_number;
  const employeeBinding = row.subject_type === "employee"
    && typeof row.employee_number === "string" && Boolean(row.employee_number.trim())
    && !row.candidate_id && !row.application_id
    && !row.candidate_revision && !row.application_revision;
  if (!candidateBinding && !employeeBinding) throw integrityError();
}

function verifyStoredAssignments(rows, steps, instanceRow, requested = null) {
  const nonSystem = steps.filter(({ responsibilityType }) => responsibilityType !== "system");
  if (!Array.isArray(rows) || rows.length !== nonSystem.length) throw integrityError();
  const runId = instanceRow.id || instanceRow.run_id;
  const requestedByStep = requested === null
    ? null
    : new Map(requested.map((assignment) => [assignment.stepId, assignment]));
  if (requestedByStep && requestedByStep.size !== nonSystem.length) throw integrityError();
  const byStep = new Map();
  for (const row of rows) {
    if (byStep.has(row.step_id)
      || row.run_id !== runId
      || row.assigned_by !== instanceRow.started_by
      || row.assigned_at !== instanceRow.started_at
      || typeof row.employee_number !== "string"
      || !row.employee_number.trim()) {
      throw integrityError();
    }
    byStep.set(row.step_id, row);
  }
  for (const step of nonSystem) {
    const row = byStep.get(step.id);
    if (!row
      || row.responsibility_type !== step.responsibilityType
      || row.responsibility_reference !== step.responsibilityReference
      || (step.responsibilityType === "employee"
        && row.employee_number !== step.responsibilityReference)
      || (requestedByStep
        && requestedByStep.get(step.id)?.employeeNumber !== row.employee_number)) {
      throw integrityError();
    }
    const receipt = sha256(JSON.stringify(personnelWorkflowTaskAssignmentReceiptBody(row)));
    if (receipt !== String(row.receipt_sha256 || "")) throw integrityError();
  }
}

function stepProjection(step, activeRow) {
  if (!activeRow) return null;
  const snapshotStep = step.find(({ id }) => id === activeRow.step_id);
  if (!snapshotStep || activeRow.status !== "active"
    || Number(activeRow.sort_order) !== snapshotStep.sortOrder) {
    throw integrityError("Der aktive Workflow-Schritt ist widerspruechlich.");
  }
  return {
    id: snapshotStep.id,
    title: snapshotStep.title,
    position: snapshotStep.sortOrder,
    activatedAt: activeRow.activated_at || null,
  };
}

function projectInstance(row, publication, steps, activeRow = null) {
  const activeStep = stepProjection(steps, activeRow || (row.active_step_id ? {
    step_id: row.active_step_id,
    status: row.active_step_status,
    sort_order: row.active_step_sort_order,
    activated_at: row.active_step_activated_at,
  } : null));
  const hasStoredTotal = row.total_steps !== undefined && row.total_steps !== null;
  const totalSteps = hasStoredTotal ? Number(row.total_steps) : steps.length;
  const completedSteps = row.finished_steps !== undefined && row.finished_steps !== null
    ? Number(row.finished_steps)
    : (activeStep ? activeStep.position - 1 : (row.status === "resolved" ? totalSteps : 0));
  if (!Number.isSafeInteger(totalSteps) || totalSteps !== steps.length
    || !Number.isSafeInteger(completedSteps)
    || completedSteps < 0 || completedSteps > totalSteps
    || (row.status === "open" && !activeStep)
    || (row.status === "resolved" && (activeStep || completedSteps !== totalSteps))) {
    throw integrityError("Der Fortschritt der Workflow-Instanz ist widerspruechlich.");
  }
  const scope = scopeFromInstanceRow(row);
  return deepFreeze({
    id: row.id || row.run_id,
    publication: {
      id: publication.row.id,
      workflowCode: publication.row.workflow_code,
      workflowType: publication.row.workflow_type,
      versionNumber: Number(publication.row.version_number),
      title: String(publication.snapshot.title || ""),
    },
    subject: { type: row.subject_type },
    scope,
    status: row.status,
    progress: { completedSteps, totalSteps },
    activeStep,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at || null,
  });
}

function storedAssignmentForStep(rows, stepId) {
  return rows.find((row) => row.step_id === stepId) || null;
}

function assignmentAccessValue(row) {
  if (!row) return null;
  return deepFreeze({
    stepId: row.step_id,
    employeeNumber: row.employee_number,
    responsibilityType: row.responsibility_type,
    responsibilityReference: row.responsibility_reference,
    assignedAt: row.assigned_at,
  });
}

function instanceAccessValue(row, publication) {
  return deepFreeze({
    id: row.id || row.run_id,
    status: row.status,
    activationCount: Number(row.activation_count),
    subjectType: row.subject_type,
    workflowCode: publication.row.workflow_code,
    workflowType: publication.row.workflow_type,
    versionNumber: Number(publication.row.version_number),
  });
}

async function taskProgress(repository, runId, steps) {
  const counts = await repository.runStepCounts({ runId });
  const totalSteps = Number(counts?.total);
  const completedSteps = Number(counts?.finished || 0);
  if (!Number.isSafeInteger(totalSteps) || totalSteps !== steps.length
    || !Number.isSafeInteger(completedSteps)
    || completedSteps < 0 || completedSteps > totalSteps) {
    throw integrityError("Der Aufgabenfortschritt ist widerspruechlich.");
  }
  return deepFreeze({ completedSteps, totalSteps });
}

async function currentTaskAccessAllowed(
  repository,
  actorId,
  row,
  publication,
  step,
  assignmentRow,
  access,
  recipientValue = undefined,
) {
  const recipient = recipientValue === undefined
    ? await repository.responsibilityCandidate({ employeeNumber: actorId })
    : recipientValue;
  if (!recipient
    || recipient.employee_number !== actorId
    || assignmentRow.employee_number !== actorId
    || (step.responsibilityType === "employee"
      && step.responsibilityReference !== actorId)
    || (step.responsibilityType === "role"
      && recipient.role !== step.responsibilityReference)
    || typeof access?.canCompletePersonnelWorkflowTask !== "function") {
    return false;
  }
  return await access.canCompletePersonnelWorkflowTask({
    instance: instanceAccessValue(row, publication),
    scope: scopeFromInstanceRow(row),
    step,
    assignment: assignmentAccessValue(assignmentRow),
    recipient: deepFreeze({ ...recipient }),
  }) === true;
}

function taskProjection(row, publication, step, progress) {
  return deepFreeze({
    runId: row.id || row.run_id,
    subjectType: row.subject_type,
    workflowCode: publication.row.workflow_code,
    versionNumber: Number(publication.row.version_number),
    workflowTitle: String(publication.snapshot.title || ""),
    step: {
      id: step.id,
      title: step.title,
      position: step.sortOrder,
      canSkip: step.conditionType !== "always",
      activatedAt: row.activated_at || null,
    },
    progress,
    scope: scopeFromInstanceRow(row),
  });
}

function taskCompletionProjection(row, stepState, progress, replayed) {
  return deepFreeze({
    runId: row.id || row.run_id,
    stepId: stepState.step_id,
    status: stepState.status,
    resolved: row.status === "resolved",
    progress,
    replayed,
  });
}

function startSubjectFromBinding(row) {
  if (row.subject_type === "candidate") {
    return Object.freeze({
      type: "candidate",
      candidateId: row.candidate_id,
      applicationId: row.application_id,
      candidateRevision: Number(row.candidate_revision),
      applicationRevision: Number(row.application_revision),
    });
  }
  if (row.subject_type === "employee") {
    return Object.freeze({ type: "employee", employeeNumber: row.employee_number });
  }
  throw integrityError();
}

function assertWriteResult(result, label) {
  if (result?.rowsAffected !== 1) {
    throw integrityError(`${label} konnte nicht eindeutig fortgeschrieben werden.`);
  }
}

async function advanceNewRun(repository, runId, steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (let guard = 0; guard <= steps.length; guard += 1) {
    const active = await repository.activeRunStep({ runId });
    if (active) return active;
    const pending = await repository.pendingRunStep({ runId });
    if (!pending) {
      assertWriteResult(await repository.resolveRun({ runId }), "Die Workflow-Instanz");
      return null;
    }
    const step = byId.get(pending.step_id);
    if (!step || Number(pending.sort_order) !== step.sortOrder || pending.status !== "pending") {
      throw integrityError("Die Workflow-Schrittreihenfolge ist widerspruechlich.");
    }
    if (step.responsibilityType === "system") {
      assertWriteResult(
        await repository.completeSystemRunStep({ runId, stepId: step.id }),
        "Der Systemschritt",
      );
      continue;
    }
    assertWriteResult(
      await repository.activateRunStep({ runId, stepId: step.id }),
      "Der Workflow-Schritt",
    );
    const activated = await repository.activeRunStep({ runId });
    if (!activated || activated.step_id !== step.id) {
      throw integrityError("Der Workflow-Schritt wurde nicht eindeutig aktiviert.");
    }
    return activated;
  }
  throw integrityError("Die Workflow-Fortschaltung wurde nicht terminiert.");
}

function normalizedStartActor(access, actorId) {
  const accessActor = String(access?.actorId || "").trim();
  const actor = String(actorId || accessActor).trim();
  if (!actor || !accessActor || actor !== accessActor
    || actor.length > 120 || /[\0\r\n]/.test(actor)) {
    throw instanceError(
      "Fuer den Workflow-Start fehlt eine gueltige handelnde Person.",
      "PERSONNEL_WORKFLOW_INSTANCE_PERMISSION_REQUIRED",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.FORBIDDEN,
    );
  }
  return actor;
}

async function authorizeStartInTransaction(
  repository,
  input,
  publication,
  access,
  { lifecycleOnboarding = false } = {},
) {
  const subjectValue = await loadSubject(repository, input.subject, publication);
  const publicValue = await requireStartAccess(access, publication, subjectValue);
  if (publication.row.archived_at) {
    throw instanceError(
      "Die Workflow-Version wurde archiviert.",
      "PERSONNEL_WORKFLOW_INSTANCE_PUBLICATION_ARCHIVED",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  ensureWorkflowMatrix(
    input.subject.type,
    publication.row.workflow_type,
    { lifecycleOnboarding },
  );
  const steps = normalizedSnapshotSteps(publication);
  validateLoadedSubject(input.subject, publication, subjectValue);
  const assignments = await verifiedAssignments(
    repository,
    input.assignments,
    steps,
    {
      access,
      publication: publicValue,
      subject: subjectValue.subject,
      scope: subjectValue.scope,
    },
  );
  return Object.freeze({
    ...subjectValue,
    assignments,
    publication: publicValue,
    steps,
  });
}

async function replayStartInTransaction(
  repository,
  existing,
  input,
  hash,
  access,
  actor,
  { lifecycleOnboarding = false } = {},
) {
  verifyBindingReceipt(existing);
  const publicationRow = await repository.workflowPublicationById({
    publicationId: existing.publication_id,
  });
  if (!publicationRow) throw integrityError();
  const publication = verifiedPublication(publicationRow);
  const steps = normalizedSnapshotSteps(publication);
  verifyInstanceRelation(existing, publication, { lifecycleOnboarding });
  const storedSubject = startSubjectFromBinding(existing);
  const frozenScope = scopeFromInstanceRow(existing);
  await requireStartAccess(access, publication, Object.freeze({
    scope: frozenScope,
    subject: publicSubject(storedSubject, frozenScope),
  }));
  if (existing.started_by !== actor) {
    throw instanceError(
      "Die Workflow-Version oder der fachliche Bezug wurde nicht gefunden.",
      "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.NOT_FOUND,
    );
  }
  if (existing.request_sha256 !== hash
    || existing.publication_id !== input.publicationId) {
    throw instanceError(
      "Die Operations-ID wurde bereits mit einem anderen Startauftrag verwendet.",
      "PERSONNEL_WORKFLOW_INSTANCE_OPERATION_CONFLICT",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  if (JSON.stringify(storedSubject) !== JSON.stringify(input.subject)) throw integrityError();
  const assignmentRows = await repository.listRunStepAssignments({
    runId: existing.id,
    stepId: null,
  });
  verifyStoredAssignments(assignmentRows, steps, existing, input.assignments);
  const active = await repository.activeRunStep({ runId: existing.id });
  return deepFreeze({
    instance: projectInstance(existing, publication, steps, active),
    replayed: true,
  });
}

async function createRunInTransaction(repository, input, hash, access, actor, {
  now,
  randomUUID,
  lifecycleOnboarding = false,
  bindLifecyclePackageRun = null,
} = {}) {
  const publicationRow = await repository.workflowPublicationById({
    publicationId: input.publicationId,
  });
  if (!publicationRow) {
    throw instanceError(
      "Die Workflow-Version oder der fachliche Bezug wurde nicht gefunden.",
      "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.NOT_FOUND,
    );
  }
  const publication = verifiedPublication(publicationRow);
  const authorized = await authorizeStartInTransaction(
    repository,
    input,
    publication,
    access,
    { lifecycleOnboarding },
  );
  const { steps } = authorized;
  const runId = String(randomUUID() || "").trim().toLowerCase();
  if (!UUID_V4.test(runId)) {
    throw new TypeError("Die M5-UUID-Quelle lieferte keine UUIDv4.");
  }
  const startedAt = normalizedNow(now);
  await repository.insertRun({
    id: runId,
    processId: publication.row.process_id,
    processRevision: Number(publication.row.source_revision),
    triggerType: "personnel_manual",
    triggerKey: `personnel:${input.operationId}`,
    locationId: authorized.scope.locationId,
    departmentId: authorized.scope.departmentId,
    triggeredBy: actor,
  });
  const binding = {
    run_id: runId,
    publication_id: publication.row.id,
    operation_id: input.operationId,
    subject_type: input.subject.type,
    candidate_id: input.subject.candidateId || null,
    application_id: input.subject.applicationId || null,
    candidate_revision: input.subject.candidateRevision || null,
    application_revision: input.subject.applicationRevision || null,
    employee_number: input.subject.employeeNumber || null,
    location_id: authorized.scope.locationId,
    department_id: authorized.scope.departmentId,
    request_sha256: hash,
    started_by: actor,
    started_at: startedAt,
  };
  binding.receipt_sha256 = sha256(JSON.stringify(
    personnelWorkflowInstanceReceiptBody(binding),
  ));
  if (lifecycleOnboarding) {
    await bindLifecyclePackageRun(deepFreeze({
      runId,
      runOperationId: input.operationId,
      publicationId: binding.publication_id,
      employeeNumber: binding.employee_number,
      requestSha256: binding.request_sha256,
      instanceReceiptSha256: binding.receipt_sha256,
      startedBy: actor,
      startedAt,
    }));
  }
  await repository.insertRunBinding({
    runId,
    publicationId: binding.publication_id,
    operationId: binding.operation_id,
    subjectType: binding.subject_type,
    candidateId: binding.candidate_id,
    applicationId: binding.application_id,
    candidateRevision: binding.candidate_revision,
    applicationRevision: binding.application_revision,
    employeeNumber: binding.employee_number,
    requestSha256: binding.request_sha256,
    receiptSha256: binding.receipt_sha256,
    startedBy: actor,
    startedAt,
  });
  for (const step of steps) {
    await repository.insertRunStep({
      runId,
      stepId: step.id,
      sortOrder: step.sortOrder,
    });
  }
  for (const assignment of authorized.assignments) {
    const assignmentRow = {
      run_id: runId,
      step_id: assignment.step.id,
      employee_number: assignment.employeeNumber,
      responsibility_type: assignment.step.responsibilityType,
      responsibility_reference: assignment.step.responsibilityReference,
      assigned_by: actor,
      assigned_at: startedAt,
    };
    assignmentRow.receipt_sha256 = sha256(JSON.stringify(
      personnelWorkflowTaskAssignmentReceiptBody(assignmentRow),
    ));
    await repository.insertRunStepAssignment({
      runId,
      stepId: assignmentRow.step_id,
      employeeNumber: assignmentRow.employee_number,
      responsibilityType: assignmentRow.responsibility_type,
      responsibilityReference: assignmentRow.responsibility_reference,
      assignedBy: actor,
      assignedAt: startedAt,
      receiptSha256: assignmentRow.receipt_sha256,
    });
  }
  const active = await advanceNewRun(repository, runId, steps);
  assertWriteResult(
    await repository.insertAudit({
      actor,
      action: "personnel-workflow.instance.start",
      entityType: "custom_process_run",
      entityId: runId,
      detail: JSON.stringify({
        publicationId: publication.row.id,
        workflowCode: publication.row.workflow_code,
        versionNumber: Number(publication.row.version_number),
        workflowType: publication.row.workflow_type,
        subjectType: input.subject.type,
        scopeType: authorized.scope.type,
        stepCount: steps.length,
        assignmentCount: authorized.assignments.length,
      }),
    }),
    "Der Workflow-Startaudit",
  );
  const row = await repository.personnelWorkflowInstanceById({ id: runId });
  if (!row) throw integrityError("Die neue Workflow-Instanz konnte nicht gelesen werden.");
  verifyInstanceRelation(row, publication, { lifecycleOnboarding });
  const assignmentRows = await repository.listRunStepAssignments({
    runId,
    stepId: null,
  });
  verifyStoredAssignments(assignmentRows, steps, row, input.assignments);
  return deepFreeze({
    instance: projectInstance(row, publication, steps, active),
    replayed: false,
  });
}

async function instantiatePersonnelLifecycleOnboardingInTransaction(
  repositoryValue,
  inputValue,
  {
    access,
    actorId,
    now = () => new Date(),
    randomUUID = cryptoRandomUUID,
    bindLifecyclePackageRun,
  } = {},
) {
  const repository = assertTransactionBoundRepository(repositoryValue);
  if (typeof now !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("M5-Zeitquelle und UUIDv4-Quelle muessen Funktionen sein.");
  }
  if (typeof bindLifecyclePackageRun !== "function") {
    throw new TypeError(
      "Die Lifecycle-Onboarding-Primitive benoetigt eine transaktionsgebundene Paket-Run-Bindung.",
    );
  }
  const input = normalizedStartInput(inputValue);
  if (input.subject.type !== "employee") {
    throw inputError(
      "Die Lifecycle-Onboarding-Primitive verlangt einen Mitarbeiterbezug.",
      "PERSONNEL_WORKFLOW_LIFECYCLE_ONBOARDING_SUBJECT_REQUIRED",
    );
  }
  const hash = requestSha256(input);
  const actor = normalizedStartActor(access, actorId);
  try {
    const existing = await repository.runBindingByOperationId({
      operationId: input.operationId,
    });
    if (existing) {
      return replayStartInTransaction(
        repository,
        existing,
        input,
        hash,
        access,
        actor,
        { lifecycleOnboarding: true },
      );
    }
    return createRunInTransaction(repository, input, hash, access, actor, {
      now,
      randomUUID,
      lifecycleOnboarding: true,
      bindLifecyclePackageRun,
    });
  } catch (error) {
    if (error instanceof PersonnelWorkflowInstanceError) throw error;
    if (CONCURRENT_PERSISTENCE_ERROR_CODES.has(error?.code)) {
      throw instanceError(
        "Die Workflow-Instanz wurde parallel geaendert. Bitte neu laden.",
        "PERSONNEL_WORKFLOW_INSTANCE_CONCURRENT_CHANGE",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
      );
    }
    throw error;
  }
}

function normalizedTaskActor(actorIdValue, access) {
  const actorId = text(actorIdValue, "Die handelnde Personalnummer", 80);
  if (String(access?.actorId || "").trim() !== actorId) {
    throw instanceError(
      "Fuer diesen Aufgabenabschluss fehlt die persoenliche Freigabe.",
      "PERSONNEL_WORKFLOW_TASK_PERMISSION_REQUIRED",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.FORBIDDEN,
    );
  }
  return actorId;
}

async function completeTaskInTransaction(
  repository,
  actorId,
  runId,
  stepId,
  inputValue,
  access,
  {
    lifecycleOnboarding = false,
    recordLifecycleTaskOutcome = null,
  } = {},
) {
  const row = await repository.personnelWorkflowInstanceById({ id: runId });
  if (!row) {
    throw instanceError(
      "Die persoenliche Workflow-Aufgabe wurde nicht gefunden.",
      "PERSONNEL_WORKFLOW_TASK_NOT_FOUND",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.NOT_FOUND,
    );
  }
  const publication = verifiedPublication(publicationFromInstanceRow(row));
  const steps = normalizedSnapshotSteps(publication);
  verifyInstanceRelation(row, publication, { lifecycleOnboarding });
  if (Number(row.activation_count) !== 1) throw integrityError();
  const step = steps.find(({ id }) => id === stepId);
  const state = await repository.runStepById({ runId, stepId });
  const assignmentRows = await repository.listRunStepAssignments({
    runId,
    stepId: null,
  });
  verifyStoredAssignments(assignmentRows, steps, row);
  const assignment = storedAssignmentForStep(assignmentRows, stepId);
  if (!step || step.responsibilityType === "system"
    || !state || Number(state.sort_order) !== step.sortOrder
    || !assignment || assignment.employee_number !== actorId) {
    throw instanceError(
      "Die persoenliche Workflow-Aufgabe wurde nicht gefunden.",
      "PERSONNEL_WORKFLOW_TASK_NOT_FOUND",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.NOT_FOUND,
    );
  }
  if (["completed", "skipped"].includes(state.status)) {
    const input = normalizedTaskCompletionInput(inputValue);
    const completionHash = taskCompletionSha256({
      actorId,
      runId,
      stepId,
      action: input.action,
      operationId: input.operationId,
    });
    const completedStatus = input.action === "skip" ? "skipped" : "completed";
    if (state.completion_note !== "") {
      throw integrityError("Der gespeicherte Aufgabenabschluss enthaelt unerlaubte Fachdaten.");
    }
    if (state.status !== completedStatus
      || state.completed_by !== actorId
      || state.completion_request_id !== completionHash) {
      throw instanceError(
        "Die Workflow-Aufgabe wurde bereits mit einem anderen Auftrag bearbeitet.",
        "PERSONNEL_WORKFLOW_TASK_OPERATION_CONFLICT",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
      );
    }
    return taskCompletionProjection(
      row,
      state,
      await taskProgress(repository, runId, steps),
      true,
    );
  }
  if (row.status !== "open" || state.status !== "active") {
    throw instanceError(
      "Die Workflow-Aufgabe ist nicht mehr aktiv.",
      "PERSONNEL_WORKFLOW_TASK_STATE_CONFLICT",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  if (!await currentTaskAccessAllowed(
    repository,
    actorId,
    row,
    publication,
    step,
    assignment,
    access,
  )) {
    throw instanceError(
      "Fuer diesen Aufgabenabschluss fehlt die aktuelle fachliche Freigabe.",
      "PERSONNEL_WORKFLOW_TASK_PERMISSION_REQUIRED",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.FORBIDDEN,
    );
  }
  const input = normalizedTaskCompletionInput(inputValue);
  const completionHash = taskCompletionSha256({
    actorId,
    runId,
    stepId,
    action: input.action,
    operationId: input.operationId,
  });
  const completedStatus = input.action === "skip" ? "skipped" : "completed";
  if (input.action === "skip" && step.conditionType === "always") {
    throw inputError(
      "Ein verpflichtender Workflow-Schritt darf nicht uebersprungen werden.",
      "PERSONNEL_WORKFLOW_TASK_SKIP_FORBIDDEN",
    );
  }
  const updated = await repository.completeRunStep({
    status: completedStatus,
    actor: actorId,
    note: "",
    idempotencyKey: completionHash,
    runId,
    stepId,
  });
  if (updated?.rowsAffected !== 1) {
    throw instanceError(
      "Die Workflow-Aufgabe wurde parallel bearbeitet.",
      "PERSONNEL_WORKFLOW_TASK_STATE_CONFLICT",
      PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
    );
  }
  const completedStep = await repository.runStepById({ runId, stepId });
  if (!completedStep
    || completedStep.status !== completedStatus
    || completedStep.completed_by !== actorId
    || completedStep.completion_request_id !== completionHash
    || completedStep.completion_note !== "") {
    throw integrityError("Der Aufgabenabschluss wurde nicht eindeutig gespeichert.");
  }
  if (lifecycleOnboarding) {
    await recordLifecycleTaskOutcome(deepFreeze({
      runId,
      taskOperationId: input.operationId,
      publicationId: row.publication_id,
      employeeNumber: row.employee_number,
      stepId,
      action: input.action,
      completedStatus,
      completionRequestSha256: completionHash,
      completedBy: actorId,
      completedAt: completedStep.completed_at,
    }));
  }
  await advanceNewRun(repository, runId, steps);
  const currentRow = await repository.personnelWorkflowInstanceById({ id: runId });
  if (!currentRow) throw integrityError();
  verifyInstanceRelation(currentRow, publication, { lifecycleOnboarding });
  const progress = await taskProgress(repository, runId, steps);
  assertWriteResult(
    await repository.insertAudit({
      actor: actorId,
      action: input.action === "skip"
        ? "personnel-workflow.task.skip"
        : "personnel-workflow.task.complete",
      entityType: "custom_process_run",
      entityId: runId,
      detail: JSON.stringify({
        workflowCode: publication.row.workflow_code,
        versionNumber: Number(publication.row.version_number),
        stepId,
        action: input.action,
        scopeType: scopeFromInstanceRow(row).type,
        resolved: currentRow.status === "resolved",
      }),
    }),
    "Der Workflow-Aufgabenaudit",
  );
  return taskCompletionProjection(currentRow, completedStep, progress, false);
}

async function completePersonnelLifecycleOnboardingTaskInTransaction(
  repositoryValue,
  actorIdValue,
  runIdValue,
  stepIdValue,
  inputValue,
  {
    access,
    recordLifecycleTaskOutcome,
  } = {},
) {
  const repository = assertTransactionBoundRepository(repositoryValue);
  if (typeof recordLifecycleTaskOutcome !== "function") {
    throw new TypeError(
      "Die Lifecycle-Onboarding-Aufgabenprimitive benoetigt einen transaktionsgebundenen Ergebnisbeleg.",
    );
  }
  const actorId = normalizedTaskActor(actorIdValue, access);
  const runId = text(runIdValue, "Die Workflow-Instanz-ID");
  const stepId = text(stepIdValue, "Die Workflow-Schritt-ID");
  try {
    return await completeTaskInTransaction(
      repository,
      actorId,
      runId,
      stepId,
      inputValue,
      access,
      { lifecycleOnboarding: true, recordLifecycleTaskOutcome },
    );
  } catch (error) {
    if (error instanceof PersonnelWorkflowInstanceError) throw error;
    if (CONCURRENT_PERSISTENCE_ERROR_CODES.has(error?.code)) {
      throw instanceError(
        "Die Workflow-Aufgabe wurde parallel geaendert. Bitte neu laden.",
        "PERSONNEL_WORKFLOW_TASK_CONCURRENT_CHANGE",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
      );
    }
    throw error;
  }
}

function createPersonnelWorkflowInstanceService(repositoryValue, {
  now = () => new Date(),
  randomUUID = cryptoRandomUUID,
} = {}) {
  const repository = assertRepository(repositoryValue);
  if (typeof now !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("M5-Zeitquelle und UUIDv4-Quelle muessen Funktionen sein.");
  }

  async function start(inputValue, { access, actorId } = {}) {
    const input = normalizedStartInput(inputValue);
    const hash = requestSha256(input);
    const actor = normalizedStartActor(access, actorId);
    try {
      return await repository.transaction(async (currentRepository) => {
        const existing = await currentRepository.runBindingByOperationId({
          operationId: input.operationId,
        });
        if (existing) {
          return replayStartInTransaction(
            currentRepository,
            existing,
            input,
            hash,
            access,
            actor,
          );
        }
        return createRunInTransaction(currentRepository, input, hash, access, actor, {
          now,
          randomUUID,
        });
      }, { isolation: "serializable" });
    } catch (error) {
      if (error instanceof PersonnelWorkflowInstanceError) throw error;
      if (CONCURRENT_PERSISTENCE_ERROR_CODES.has(error?.code)) {
        throw instanceError(
          "Die Workflow-Instanz wurde parallel geaendert. Bitte neu laden.",
          "PERSONNEL_WORKFLOW_INSTANCE_CONCURRENT_CHANGE",
          PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
        );
      }
      throw error;
    }
  }

  async function tasksForEmployee(employeeNumberValue, { access } = {}) {
    const employeeNumber = text(employeeNumberValue, "Die Personalnummer", 80);
    if (String(access?.actorId || "").trim() !== employeeNumber
      || typeof access?.canCompletePersonnelWorkflowTask !== "function") {
      throw instanceError(
        "Fuer die persoenlichen Workflow-Aufgaben fehlt die fachliche Freigabe.",
        "PERSONNEL_WORKFLOW_TASK_PERMISSION_REQUIRED",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.FORBIDDEN,
      );
    }
    const recipient = await repository.responsibilityCandidate({ employeeNumber });
    if (!recipient || recipient.employee_number !== employeeNumber) {
      return deepFreeze({ items: [] });
    }
    const rows = await repository.listActivePersonnelWorkflowTaskRuns({ employeeNumber });
    const items = [];
    const seen = new Set();
    for (const row of rows) {
      const key = `${row.id}\0${row.step_id}`;
      if (!row.id || !row.step_id || seen.has(key)
        || row.status !== "open"
        || row.step_status !== "active"
        || row.assigned_employee_number !== employeeNumber) {
        throw integrityError("Die persoenliche Aufgabenliste ist widerspruechlich.");
      }
      seen.add(key);
      const publication = verifiedPublication(publicationFromInstanceRow(row));
      const steps = normalizedSnapshotSteps(publication);
      verifyInstanceRelation(row, publication);
      const step = steps.find(({ id }) => id === row.step_id);
      if (!step || step.responsibilityType === "system"
        || Number(row.sort_order) !== step.sortOrder) {
        throw integrityError("Der persoenliche Aufgabenschritt ist widerspruechlich.");
      }
      const state = await repository.runStepById({
        runId: row.id,
        stepId: row.step_id,
      });
      if (!state || state.status !== "active") continue;
      if (Number(state.sort_order) !== step.sortOrder) throw integrityError();
      const assignmentRows = await repository.listRunStepAssignments({
        runId: row.id,
        stepId: null,
      });
      verifyStoredAssignments(assignmentRows, steps, row);
      const assignment = storedAssignmentForStep(assignmentRows, step.id);
      if (!assignment
        || assignment.employee_number !== employeeNumber
        || row.assignment_responsibility_type !== assignment.responsibility_type
        || row.assignment_responsibility_reference !== assignment.responsibility_reference
        || row.assignment_assigned_at !== assignment.assigned_at) {
        throw integrityError("Die persoenliche Aufgabenzuordnung ist widerspruechlich.");
      }
      if (!await currentTaskAccessAllowed(
        repository,
        employeeNumber,
        row,
        publication,
        step,
        assignment,
        access,
        recipient,
      )) continue;
      const progress = await taskProgress(repository, row.id, steps);
      items.push(taskProjection({ ...row, activated_at: state.activated_at }, publication, step, progress));
    }
    return deepFreeze({ items });
  }

  async function completeTask(
    actorIdValue,
    runIdValue,
    stepIdValue,
    inputValue,
    { access } = {},
  ) {
    const actorId = normalizedTaskActor(actorIdValue, access);
    const runId = text(runIdValue, "Die Workflow-Instanz-ID");
    const stepId = text(stepIdValue, "Die Workflow-Schritt-ID");
    try {
      return await repository.transaction(
        (currentRepository) => completeTaskInTransaction(
          currentRepository,
          actorId,
          runId,
          stepId,
          inputValue,
          access,
        ),
        { isolation: "serializable" },
      );
    } catch (error) {
      if (error instanceof PersonnelWorkflowInstanceError) throw error;
      if (CONCURRENT_PERSISTENCE_ERROR_CODES.has(error?.code)) {
        throw instanceError(
          "Die Workflow-Aufgabe wurde parallel geaendert. Bitte neu laden.",
          "PERSONNEL_WORKFLOW_TASK_CONCURRENT_CHANGE",
          PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.CONFLICT,
        );
      }
      throw error;
    }
  }

  async function list({ access } = {}) {
    if (typeof access?.canReadPersonnelWorkflowInstance !== "function") {
      throw instanceError(
        "Fuer Workflow-Instanzen fehlt das Leserecht.",
        "PERSONNEL_WORKFLOW_INSTANCE_PERMISSION_REQUIRED",
        PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS.FORBIDDEN,
      );
    }
    const rows = await repository.listPersonnelWorkflowInstances();
    const instances = [];
    const visibleRunIds = new Set();
    for (const row of rows) {
      if (await access.canReadPersonnelWorkflowInstance(row) !== true) continue;
      if (!row.id || visibleRunIds.has(row.id)) {
        throw integrityError("Die Workflow-Instanzliste ist nicht eindeutig.");
      }
      visibleRunIds.add(row.id);
      const publication = verifiedPublication(publicationFromInstanceRow(row));
      const steps = normalizedSnapshotSteps(publication);
      verifyInstanceRelation(row, publication);
      const assignments = await repository.listRunStepAssignments({
        runId: row.id,
        stepId: null,
      });
      verifyStoredAssignments(assignments, steps, row);
      instances.push(projectInstance(row, publication, steps));
    }
    return deepFreeze({ instances });
  }

  return Object.freeze({ completeTask, list, start, tasksForEmployee });
}

module.exports = {
  PERSONNEL_WORKFLOW_INSTANCE_ERROR_KINDS,
  PersonnelWorkflowInstanceError,
  completePersonnelLifecycleOnboardingTaskInTransaction,
  createPersonnelWorkflowInstanceService,
  instantiatePersonnelLifecycleOnboardingInTransaction,
};
