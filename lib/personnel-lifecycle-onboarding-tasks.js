"use strict";

const {
  assertCustomProcessManagementRepository,
} = require("./persistence/repositories/custom-process-management");
const {
  personnelWorkflowInstanceReceiptBody,
  personnelWorkflowTaskAssignmentReceiptBody,
} = require("./personnel-workflow-instance-receipt");
const {
  verifyPersonnelWorkflowPublication,
} = require("./personnel-workflow-publications");
const {
  canonicalSha256,
  deterministicUuidV4,
  personnelLifecycleAssignmentBindingReceiptBody,
  personnelLifecycleAssignmentReceiptBody,
  personnelLifecycleCaseEventReceiptBody,
  personnelLifecyclePackageBindingReceiptBody,
  personnelLifecyclePackageRunReceiptBody,
  sha256,
} = require("./personnel-lifecycle-onboarding-receipt");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ERROR_KINDS = Object.freeze({
  INPUT: "input",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INTEGRITY: "integrity",
});
const REQUIRED_REPOSITORY_METHODS = Object.freeze([
  "insertAudit",
  "insertLifecycleCaseEvent",
  "lifecycleCaseEventById",
  "lifecycleCaseLastEvent",
  "lifecycleCaseProgress",
  "lifecycleOnboardingTaskContext",
  "listActiveLifecycleOnboardingTasks",
  "onboardingCaseById",
  "transitionLifecycleCase",
  "transaction",
]);
const CONCURRENT_CODES = new Set([
  "PERSISTENCE_UNIQUE_VIOLATION",
  "PERSISTENCE_BUSY",
  "PERSISTENCE_RETRYABLE_TRANSACTION",
]);

class PersonnelLifecycleOnboardingTaskError extends Error {
  constructor(message, code, kind = ERROR_KINDS.INPUT) {
    super(message);
    this.name = "PersonnelLifecycleOnboardingTaskError";
    this.code = code;
    this.kind = kind;
  }
}

function taskError(message, code, kind) {
  return new PersonnelLifecycleOnboardingTaskError(message, code, kind);
}

function inputError(message, code = "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_INPUT_INVALID") {
  return taskError(message, code, ERROR_KINDS.INPUT);
}

function conflictError(message, code) {
  return taskError(message, code, ERROR_KINDS.CONFLICT);
}

function integrityError(message = "Die Lifecycle-Onboarding-Aufgabe ist widerspruechlich verknuepft.") {
  return taskError(
    message,
    "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_INTEGRITY_FAILED",
    ERROR_KINDS.INTEGRITY,
  );
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

function operationId(value, label = "Die Operations-ID") {
  const normalized = text(value, label, 36).toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw inputError(
      `${label} muss eine UUIDv4 sein.`,
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_OPERATION_ID_INVALID",
    );
  }
  return normalized;
}

function normalizedNow(now) {
  const value = now();
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError("Die O4-Aufgaben-Zeitquelle ist ungueltig.");
  }
  return instant.toISOString();
}

function assertWrite(result, label) {
  if (Number(result?.rowsAffected || 0) !== 1) {
    throw integrityError(`${label} wurde nicht eindeutig gespeichert.`);
  }
}

function normalizedActor(actorIdValue, access) {
  const actorId = text(actorIdValue, "Die handelnde Person", 120);
  if (!access || String(access.actorId || "").trim() !== actorId
    || access.namedActor !== true || access.personalEmployee !== true) {
    throw taskError(
      "Fuer Lifecycle-Onboarding-Aufgaben fehlt eine gueltige persoenliche Sitzung.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_PERMISSION_REQUIRED",
      ERROR_KINDS.FORBIDDEN,
    );
  }
  return actorId;
}

function normalizedDeferredControls(value, label) {
  if (value.notApplicable === true || value.action === "not_applicable") {
    throw conflictError(
      "Nicht-anwendbar-Entscheidungen bleiben bis zum freigegebenen Templatevertrag gesperrt.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_NOT_APPLICABLE_DEFERRED",
    );
  }
  if (value.exception !== undefined && value.exception !== null) {
    throw conflictError(
      "Lifecycle-Ausnahmen bleiben bis zum freigegebenen Ausnahmevertrag gesperrt.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_EXCEPTION_DEFERRED",
    );
  }
  if (value.evidenceReference !== undefined && value.evidenceReference !== null) {
    throw conflictError(
      "Evidence-Verknuepfungen bleiben bis zum freigegebenen M6-Vertrag gesperrt.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_EVIDENCE_DEFERRED",
    );
  }
  if (value.action !== undefined && value.action !== "complete") {
    throw conflictError(
      `${label} erlaubt derzeit ausschliesslich complete.`,
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_ACTION_DEFERRED",
    );
  }
}

function normalizedCompletionInput(value) {
  const input = plainObject(value, "Der Lifecycle-Aufgabenabschluss");
  exactKeys(input, new Set([
    "operationId", "action", "evidenceReference", "exception", "notApplicable",
  ]), "Der Lifecycle-Aufgabenabschluss");
  normalizedDeferredControls(input, "Der Lifecycle-Aufgabenabschluss");
  if (input.action !== "complete") {
    throw inputError(
      "Der Lifecycle-Aufgabenabschluss muss complete explizit angeben.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_COMPLETE_REQUIRED",
    );
  }
  return Object.freeze({
    operationId: operationId(input.operationId),
    action: "complete",
    evidenceReference: null,
  });
}

function normalizedCloseInput(value) {
  const input = plainObject(value, "Der Onboarding-Fallabschluss");
  exactKeys(input, new Set([
    "operationId", "confirmation", "evidenceReference", "exception", "notApplicable",
  ]), "Der Onboarding-Fallabschluss");
  normalizedDeferredControls(input, "Der Onboarding-Fallabschluss");
  if (input.confirmation !== "CLOSE_ONBOARDING") {
    throw inputError(
      "Der Onboarding-Fallabschluss wurde nicht eindeutig bestaetigt.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_CONFIRMATION_REQUIRED",
    );
  }
  return Object.freeze({
    operationId: operationId(input.operationId),
    confirmation: "CLOSE_ONBOARDING",
    evidenceReference: null,
  });
}

function scopeFromTask(row) {
  const locationId = typeof row.case_location_id === "string"
    ? row.case_location_id.trim()
    : "";
  const departmentId = row.case_department_id === null
    || row.case_department_id === undefined
    || row.case_department_id === ""
    ? null
    : Number(row.case_department_id);
  const expectedType = departmentId === null ? "location" : "department";
  if (!locationId || row.case_scope_type !== expectedType
    || (departmentId !== null
      && (!Number.isSafeInteger(departmentId) || departmentId < 1))) {
    throw integrityError("Der Lifecycle-Aufgaben-Scope ist ungueltig.");
  }
  return deepFreeze({ type: expectedType, locationId, departmentId });
}

function scopeFromCase(row) {
  return scopeFromTask({
    case_scope_type: row.scope_type,
    case_location_id: row.location_id,
    case_department_id: row.department_id,
  });
}

function subjectFromTask(row) {
  const employeeNumber = String(row.subject_employee_number || "").trim();
  const displayName = String(row.subject_display_name || "").trim();
  if (!employeeNumber || employeeNumber.length > 120 || employeeNumber.includes("\0")
    || !displayName || displayName.length > 200 || /[\0\r\n]/.test(displayName)) {
    throw integrityError("Die zugeordnete Person der Lifecycle-Aufgabe ist ungueltig.");
  }
  return deepFreeze({ employeeNumber, displayName });
}

function operationalContext(row, scope) {
  const state = row.case_state || row.state;
  return deepFreeze({
    caseId: row.case_id || row.id,
    caseType: "onboarding",
    operationalReleased: ["active", "completed"].includes(state),
    scope,
  });
}

async function requireOperationalRead(access, row, scope) {
  if (access.canReadOperational !== true
    || typeof access.canReadOperationalScope !== "function"
    || await access.canReadOperationalScope(operationalContext(row, scope)) !== true) {
    throw taskError(
      "Die Lifecycle-Onboarding-Aufgabe wurde nicht gefunden.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_NOT_FOUND",
      ERROR_KINDS.NOT_FOUND,
    );
  }
}

async function requireOperationalUpdate(access, row, scope) {
  await requireOperationalRead(access, row, scope);
  if (access.canUpdateOperational !== true
    || typeof access.canUpdateOperationalScope !== "function"
    || await access.canUpdateOperationalScope(operationalContext(row, scope)) !== true) {
    throw taskError(
      "Fuer den Lifecycle-Aufgabenabschluss fehlt operational:update im exakten Scope.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_PERMISSION_REQUIRED",
      ERROR_KINDS.FORBIDDEN,
    );
  }
}

function publicationRowFromTask(row) {
  return {
    id: row.publication_id,
    process_id: row.publication_process_id,
    source_revision: row.publication_source_revision,
    version_number: row.publication_version_number,
    workflow_code: row.publication_workflow_code,
    workflow_type: row.publication_workflow_type,
    authority_level: row.publication_authority_level,
    requirement_kind: row.publication_requirement_kind,
    data_classification: row.publication_data_classification,
    scope_type: row.publication_scope_type,
    location_id: row.publication_location_id,
    department_id: row.publication_department_id,
    snapshot_json: row.publication_snapshot_json,
    snapshot_sha256: row.publication_snapshot_sha256,
    receipt_sha256: row.publication_receipt_sha256,
    published_by: row.publication_published_by,
    published_at: row.publication_published_at,
    archived_at: row.publication_archived_at || null,
  };
}

function verifySha256(value) {
  return SHA256.test(String(value || ""));
}

function receiptMatches(receipt, body, { canonical = false } = {}) {
  return verifySha256(receipt)
    && receipt === (canonical ? canonicalSha256(body) : sha256(JSON.stringify(body)));
}

function verifyTaskRelation(row, actorId) {
  if (!row || typeof row !== "object") throw integrityError();
  let publication;
  try {
    publication = verifyPersonnelWorkflowPublication(publicationRowFromTask(row));
  } catch {
    throw integrityError("Die Lifecycle-Aufgabe verweist auf keine gueltige Publikation.");
  }
  const scope = scopeFromTask(row);
  const subject = subjectFromTask(row);
  const stepIndex = publication.snapshot.steps.findIndex(({ id }) => (
    id === row.lifecycle_step_reference
  ));
  const snapshotStep = publication.snapshot.steps[stepIndex];
  const publicationScopeValid = publication.scope.type === "company"
    || (publication.scope.type === "location"
      && publication.scope.locationId === scope.locationId)
    || (publication.scope.type === "department"
      && publication.scope.locationId === scope.locationId
      && publication.scope.departmentId === scope.departmentId);
  const notificationChannelsValid = publication.snapshot.steps.every((step) => (
    step.notificationChannels === undefined
    || (Array.isArray(step.notificationChannels) && step.notificationChannels.length === 0)
  ));
  const instanceReceiptRow = {
    run_id: row.run_id,
    publication_id: row.workflow_binding_publication_id,
    operation_id: row.workflow_operation_id,
    subject_type: row.workflow_subject_type,
    candidate_id: row.workflow_candidate_id,
    application_id: row.workflow_application_id,
    candidate_revision: row.workflow_candidate_revision,
    application_revision: row.workflow_application_revision,
    employee_number: row.workflow_employee_number,
    location_id: row.run_location_id,
    department_id: row.run_department_id,
    request_sha256: row.workflow_request_sha256,
    started_by: row.workflow_started_by,
    started_at: row.workflow_started_at,
  };
  const workflowAssignmentRow = {
    run_id: row.workflow_assignment_run_id,
    step_id: row.workflow_assignment_step_id,
    employee_number: row.workflow_assigned_employee_number,
    responsibility_type: row.workflow_responsibility_type,
    responsibility_reference: row.workflow_responsibility_reference,
    assigned_by: row.workflow_assignment_assigned_by,
    assigned_at: row.workflow_assignment_assigned_at,
  };
  const packageBindingRow = {
    id: row.package_binding_id,
    case_id: row.package_case_id,
    publication_id: row.package_publication_id,
    version_number: row.package_version_number,
    scope_snapshot_sha256: row.package_scope_snapshot_sha256,
    bound_by: row.package_bound_by,
    bound_at: row.package_bound_at,
  };
  const packageRunRow = {
    package_binding_id: row.package_run_binding_id,
    run_id: row.run_id,
    run_operation_id: row.run_operation_id,
    family_codes_json: row.family_codes_json,
    lifecycle_review_sha256: row.lifecycle_review_sha256,
    scope_snapshot_sha256: row.package_run_scope_snapshot_sha256,
    linked_by: row.run_linked_by,
    linked_at: row.run_linked_at,
  };
  const lifecycleAssignmentRow = {
    id: row.lifecycle_assignment_id,
    case_id: row.lifecycle_assignment_case_id,
    package_binding_id: row.assignment_binding_package_id,
    run_id: row.assignment_binding_run_id,
    step_reference: row.lifecycle_step_reference,
    assignee_actor_id: row.lifecycle_assignee_actor_id,
    assigned_by: row.lifecycle_assigned_by,
    assigned_at: row.lifecycle_assigned_at,
  };
  const assignmentBindingRow = {
    assignment_id: row.assignment_binding_assignment_id,
    package_binding_id: row.assignment_binding_package_id,
    run_id: row.assignment_binding_run_id,
    step_reference: row.assignment_binding_step_reference,
    bound_by: row.assignment_bound_by,
    bound_at: row.assignment_bound_at,
  };
  const exact = row.case_type === "onboarding"
    && row.case_state === "active"
    && Number.isSafeInteger(Number(row.case_revision))
    && row.episode_state === "employment_active"
    && row.lifecycle_assignment_case_id === row.case_id
    && row.lifecycle_assignee_actor_id === actorId
    && row.assignment_binding_assignment_id === row.lifecycle_assignment_id
    && row.assignment_binding_step_reference === row.lifecycle_step_reference
    && row.package_binding_id === row.assignment_binding_package_id
    && row.package_case_id === row.case_id
    && row.package_publication_id === row.publication_id
    && Number(row.package_version_number) === Number(row.publication_version_number)
    && row.package_run_binding_id === row.package_binding_id
    && row.run_id === row.assignment_binding_run_id
    && row.workflow_binding_run_id === row.run_id
    && row.workflow_binding_publication_id === row.publication_id
    && row.workflow_operation_id === row.run_operation_id
    && row.workflow_subject_type === "employee"
    && row.workflow_candidate_id === null
    && row.workflow_application_id === null
    && row.workflow_candidate_revision === null
    && row.workflow_application_revision === null
    && row.workflow_employee_number === row.employee_number
    && subject.employeeNumber === row.employee_number
    && row.run_process_id === row.publication_process_id
    && Number(row.run_process_revision) === Number(row.publication_source_revision)
    && row.run_trigger_type === "personnel_manual"
    && row.run_trigger_key === `personnel:${row.run_operation_id}`
    && ["open", "resolved"].includes(row.run_status)
    && row.run_location_id === scope.locationId
    && Number(row.run_department_id || 0) === Number(scope.departmentId || 0)
    && row.run_triggered_by === row.workflow_started_by
    && Number(row.run_activation_count) === 1
    && row.publication_workflow_type === "onboarding"
    && row.publication_data_classification === "standard"
    && publicationScopeValid
    && notificationChannelsValid
    && snapshotStep
    && snapshotStep.responsibilityType !== "system"
    && row.run_step_run_id === row.run_id
    && row.run_step_id === row.lifecycle_step_reference
    && Number(row.run_step_sort_order) === stepIndex + 1
    && ["pending", "active", "completed", "skipped"].includes(row.run_step_status)
    && row.workflow_assignment_run_id === row.run_id
    && row.workflow_assignment_step_id === row.lifecycle_step_reference
    && row.workflow_assigned_employee_number === actorId
    && row.workflow_responsibility_type === snapshotStep.responsibilityType
    && row.workflow_responsibility_reference === snapshotStep.responsibilityReference
    && row.workflow_assignment_assigned_by === row.workflow_started_by
    && row.workflow_assignment_assigned_at === row.workflow_started_at
    && row.case_scope_snapshot_sha256 === row.package_scope_snapshot_sha256
    && row.case_scope_snapshot_sha256 === row.package_run_scope_snapshot_sha256
    && verifySha256(row.case_scope_snapshot_sha256)
    && verifySha256(row.lifecycle_review_sha256)
    && verifySha256(row.workflow_request_sha256);
  if (!exact
    || !receiptMatches(
      row.workflow_binding_receipt_sha256,
      personnelWorkflowInstanceReceiptBody(instanceReceiptRow),
    )
    || !receiptMatches(
      row.workflow_assignment_receipt_sha256,
      personnelWorkflowTaskAssignmentReceiptBody(workflowAssignmentRow),
    )
    || !receiptMatches(
      row.package_binding_receipt_sha256,
      personnelLifecyclePackageBindingReceiptBody(packageBindingRow),
      { canonical: true },
    )
    || !receiptMatches(
      row.package_run_receipt_sha256,
      personnelLifecyclePackageRunReceiptBody(packageRunRow),
    )
    || !receiptMatches(
      row.lifecycle_assignment_receipt_sha256,
      personnelLifecycleAssignmentReceiptBody(lifecycleAssignmentRow),
      { canonical: true },
    )
    || !receiptMatches(
      row.assignment_binding_receipt_sha256,
      personnelLifecycleAssignmentBindingReceiptBody(assignmentBindingRow),
    )) {
    throw integrityError();
  }
  return deepFreeze({ publication, scope, snapshotStep, subject });
}

function normalizedEventRow(row) {
  if (!row || typeof row !== "object") throw integrityError("Der Lifecycle-Ereignisbeleg fehlt.");
  const normalized = {
    id: row.id,
    case_id: row.case_id,
    sequence_number: Number(row.sequence_number),
    event_type: row.event_type,
    data_classification: row.data_classification,
    protected_payload: row.protected_payload,
    previous_receipt_sha256: row.previous_receipt_sha256,
    receipt_sha256: row.receipt_sha256,
    actor_id: row.actor_id,
    occurred_at: row.occurred_at,
  };
  if (!normalized.id || !normalized.case_id
    || !Number.isSafeInteger(normalized.sequence_number)
    || normalized.sequence_number < 1
    || typeof normalized.protected_payload !== "string"
    || !normalized.protected_payload.startsWith("enc:v2:")
    || !receiptMatches(
      normalized.receipt_sha256,
      personnelLifecycleCaseEventReceiptBody(normalized),
      { canonical: true },
    )) {
    throw integrityError("Der Lifecycle-Ereignisbeleg ist ungueltig.");
  }
  return Object.freeze(normalized);
}

function createPersonnelLifecycleOnboardingTaskService(repositoryValue, {
  completePersonnelLifecycleOnboardingTaskInTransaction,
  protectJson,
  parseProtectedJson,
  now = () => new Date(),
} = {}) {
  const repository = assertCustomProcessManagementRepository(repositoryValue);
  const missing = REQUIRED_REPOSITORY_METHODS
    .filter((name) => typeof repository[name] !== "function");
  if (missing.length) {
    throw new TypeError(`Dem O4-Aufgaben-Repository fehlen Methoden: ${missing.join(", ")}.`);
  }
  if (typeof completePersonnelLifecycleOnboardingTaskInTransaction !== "function"
    || typeof protectJson !== "function" || typeof parseProtectedJson !== "function"
    || typeof now !== "function") {
    throw new TypeError("Fuer O4-Aufgaben fehlen sichere Laufzeitfunktionen.");
  }

  function protect(payload, eventId, employeeNumber) {
    const protectedPayload = protectJson(payload, {
      namespace: "personnel-lifecycle-case-event",
      recordId: eventId,
      field: "payload",
      employeeNumber,
    });
    if (typeof protectedPayload !== "string" || !protectedPayload.startsWith("enc:v2:")) {
      throw integrityError("Der Lifecycle-Ereignisbeleg konnte nicht sicher geschuetzt werden.");
    }
    return protectedPayload;
  }

  function parse(event, employeeNumber) {
    try {
      return plainObject(parseProtectedJson(event.protected_payload, {
        namespace: "personnel-lifecycle-case-event",
        recordId: event.id,
        field: "payload",
        employeeNumber,
      }), "Der geschuetzte Lifecycle-Ereignisbeleg");
    } catch (error) {
      if (error instanceof PersonnelLifecycleOnboardingTaskError) throw error;
      throw integrityError("Der geschuetzte Lifecycle-Ereignisbeleg ist unlesbar.");
    }
  }

  async function appendEvent(currentRepository, {
    actorId,
    caseId,
    employeeNumber,
    eventId,
    eventType,
    dataClassification,
    occurredAt,
    payload,
  }) {
    const existing = await currentRepository.lifecycleCaseEventById({ eventId });
    if (existing) {
      throw conflictError(
        "Die Operations-ID wurde bereits fuer ein Lifecycle-Ereignis verwendet.",
        "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_OPERATION_CONFLICT",
      );
    }
    const last = normalizedEventRow(await currentRepository.lifecycleCaseLastEvent({ caseId }));
    if (last.case_id !== caseId) throw integrityError();
    const protectedPayload = protect(payload, eventId, employeeNumber);
    const event = {
      id: eventId,
      case_id: caseId,
      sequence_number: last.sequence_number + 1,
      event_type: eventType,
      data_classification: dataClassification,
      protected_payload: protectedPayload,
      previous_receipt_sha256: last.receipt_sha256,
      actor_id: actorId,
      occurred_at: occurredAt,
    };
    event.receipt_sha256 = canonicalSha256(
      personnelLifecycleCaseEventReceiptBody(event),
    );
    assertWrite(await currentRepository.insertLifecycleCaseEvent({
      id: event.id,
      caseId: event.case_id,
      sequenceNumber: event.sequence_number,
      eventType: event.event_type,
      dataClassification: event.data_classification,
      protectedPayload: event.protected_payload,
      previousReceiptSha256: event.previous_receipt_sha256,
      receiptSha256: event.receipt_sha256,
      actor: event.actor_id,
      occurredAt: event.occurred_at,
    }), "Das Lifecycle-Ereignis");
    return normalizedEventRow({ ...event });
  }

  function verifyTaskEvent(eventValue, expected, employeeNumber) {
    const event = normalizedEventRow(eventValue);
    const payload = parse(event, employeeNumber);
    if (event.id !== expected.eventId
      || event.case_id !== expected.caseId
      || event.event_type !== "onboarding_task_completed"
      || event.actor_id !== expected.actorId
      || payload.schemaVersion !== 1
      || payload.operationId !== expected.operationId
      || payload.runId !== expected.runId
      || payload.stepId !== expected.stepId
      || payload.action !== "complete"
      || payload.evidenceReference !== null) {
      throw conflictError(
        "Die Aufgaben-Operations-ID wurde bereits abweichend verwendet.",
        "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_OPERATION_CONFLICT",
      );
    }
    return event;
  }

  function verifyCloseEvent(eventValue, expected, employeeNumber) {
    const event = normalizedEventRow(eventValue);
    if (event.case_id !== expected.caseId) {
      throw conflictError(
        "Die Abschluss-Operations-ID wurde bereits fuer einen anderen Fall verwendet.",
        "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_OPERATION_CONFLICT",
      );
    }
    const payload = parse(event, employeeNumber);
    if (event.id !== expected.eventId
      || event.event_type !== "onboarding_completed"
      || event.actor_id !== expected.actorId
      || payload.schemaVersion !== 1
      || payload.operationId !== expected.operationId
      || payload.caseId !== expected.caseId
      || payload.state !== "completed"
      || payload.evidenceReference !== null) {
      throw conflictError(
        "Die Abschluss-Operations-ID wurde bereits abweichend verwendet.",
        "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_OPERATION_CONFLICT",
      );
    }
    return event;
  }

  async function listActiveTasks(actorIdValue, { access } = {}) {
    const actorId = normalizedActor(actorIdValue, access);
    const rows = await repository.listActiveLifecycleOnboardingTasks({ actorId });
    const items = [];
    const seen = new Set();
    for (const row of rows) {
      const verified = verifyTaskRelation(row, actorId);
      const key = `${row.run_id}\0${row.lifecycle_step_reference}`;
      if (seen.has(key)) throw integrityError("Die Lifecycle-Aufgabenliste ist nicht eindeutig.");
      seen.add(key);
      if (row.run_step_status !== "active") continue;
      if (row.run_status !== "open") throw integrityError();
      items.push(deepFreeze({
        caseId: row.case_id,
        runId: row.run_id,
        stepId: row.lifecycle_step_reference,
        workflowCode: row.publication_workflow_code,
        workflowTitle: String(verified.publication.snapshot.title || ""),
        step: {
          title: String(verified.snapshotStep.title || ""),
          position: Number(row.run_step_sort_order),
          activatedAt: row.run_step_activated_at,
        },
        subject: verified.subject,
        scope: verified.scope,
      }));
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
    const actorId = normalizedActor(actorIdValue, access);
    const runId = text(runIdValue, "Die Workflow-Instanz-ID");
    const stepId = text(stepIdValue, "Die Workflow-Schritt-ID");
    const input = normalizedCompletionInput(inputValue);
    const eventId = deterministicUuidV4(
      "personnel-lifecycle-onboarding-task-complete",
      input.operationId,
    );
    try {
      return await repository.transaction(async (currentRepository) => {
        const row = await currentRepository.lifecycleOnboardingTaskContext({
          actorId,
          runId,
          stepId,
        });
        if (!row) {
          throw taskError(
            "Die Lifecycle-Onboarding-Aufgabe wurde nicht gefunden.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_NOT_FOUND",
            ERROR_KINDS.NOT_FOUND,
          );
        }
        const verified = verifyTaskRelation(row, actorId);
        if (!["active", "completed"].includes(row.run_step_status)) {
          throw conflictError(
            "Die Lifecycle-Onboarding-Aufgabe ist nicht aktiv.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_STATE_CONFLICT",
          );
        }
        let writtenEvent = null;
        const result = await completePersonnelLifecycleOnboardingTaskInTransaction(
          currentRepository,
          actorId,
          runId,
          stepId,
          { action: "complete", operationId: input.operationId },
          {
            access: {
              actorId,
              canCompletePersonnelWorkflowTask: async () => true,
            },
            recordLifecycleTaskOutcome: async (outcome) => {
              if (outcome.runId !== runId || outcome.stepId !== stepId
                || outcome.taskOperationId !== input.operationId
                || outcome.employeeNumber !== row.employee_number
                || outcome.completedStatus !== "completed") {
                throw integrityError("Der M5-Aufgabenabschluss passt nicht zum Lifecycle-Bezug.");
              }
              writtenEvent = await appendEvent(currentRepository, {
                actorId,
                caseId: row.case_id,
                employeeNumber: row.employee_number,
                eventId,
                eventType: "onboarding_task_completed",
                dataClassification: "operational_standard",
                occurredAt: outcome.completedAt,
                payload: {
                  schemaVersion: 1,
                  operationId: input.operationId,
                  runId,
                  stepId,
                  action: "complete",
                  completionRequestSha256: outcome.completionRequestSha256,
                  evidenceReference: null,
                },
              });
              assertWrite(await currentRepository.insertAudit({
                actor: actorId,
                action: "personnel-lifecycle.onboarding.task.complete",
                entityType: "personnel_lifecycle_case",
                entityId: row.case_id,
                detail: JSON.stringify({ operationId: input.operationId, runId, stepId }),
              }), "Der Lifecycle-Aufgabenaudit");
            },
          },
        );
        const event = writtenEvent || verifyTaskEvent(
          await currentRepository.lifecycleCaseEventById({ eventId }),
          { eventId, caseId: row.case_id, actorId, operationId: input.operationId, runId, stepId },
          row.employee_number,
        );
        return deepFreeze({
          caseId: row.case_id,
          runId,
          stepId,
          status: result.status,
          resolved: result.resolved,
          progress: result.progress,
          eventId: event.id,
          replayed: result.replayed,
        });
      }, { isolation: "serializable" });
    } catch (error) {
      if (error instanceof PersonnelLifecycleOnboardingTaskError) throw error;
      if (CONCURRENT_CODES.has(error?.code)) {
        throw conflictError(
          "Die Lifecycle-Aufgabe wurde parallel geaendert. Bitte neu laden.",
          "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_CONCURRENT_CHANGE",
        );
      }
      throw error;
    }
  }

  async function closeCase(
    actorIdValue,
    caseIdValue,
    inputValue,
    { access } = {},
  ) {
    const actorId = normalizedActor(actorIdValue, access);
    const caseId = text(caseIdValue, "Die Onboarding-Fall-ID");
    const input = normalizedCloseInput(inputValue);
    const eventId = deterministicUuidV4(
      "personnel-lifecycle-onboarding-close",
      input.operationId,
    );
    try {
      return await repository.transaction(async (currentRepository) => {
        const caseRow = await currentRepository.onboardingCaseById({ caseId });
        if (!caseRow) {
          throw taskError(
            "Der Onboarding-Fall wurde nicht gefunden.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_CASE_NOT_FOUND",
            ERROR_KINDS.NOT_FOUND,
          );
        }
        const scope = scopeFromCase(caseRow);
        const accessRow = { ...caseRow, case_id: caseId, case_state: caseRow.state };
        await requireOperationalUpdate(access, accessRow, scope);
        if (access.canCloseOnboarding !== true
          || typeof access.canAuthorizeTransition !== "function"
          || await access.canAuthorizeTransition("onboarding", "active", "completed") !== true) {
          throw taskError(
            "Fuer den Fallabschluss fehlt onboarding:close.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_PERMISSION_REQUIRED",
            ERROR_KINDS.FORBIDDEN,
          );
        }
        const existing = await currentRepository.lifecycleCaseEventById({ eventId });
        if (existing) {
          const event = verifyCloseEvent(existing, {
            eventId, caseId, actorId, operationId: input.operationId,
          }, caseRow.employee_number);
          if (caseRow.state !== "completed") throw integrityError();
          return deepFreeze({
            caseId,
            state: "completed",
            closedAt: event.occurred_at,
            eventId,
            replayed: true,
          });
        }
        if (caseRow.state !== "active") {
          throw conflictError(
            "Der Onboarding-Fall ist nicht aktiv oder wurde anders abgeschlossen.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_STATE_CONFLICT",
          );
        }
        const progress = await currentRepository.lifecycleCaseProgress({ caseId });
        const packageCount = Number(progress?.package_count || 0);
        const linkedRunCount = Number(progress?.linked_run_count || 0);
        const resolvedRunCount = Number(progress?.resolved_run_count || 0);
        const assignmentCount = Number(progress?.assignment_count || 0);
        const linkedAssignmentCount = Number(progress?.linked_assignment_count || 0);
        const totalStepCount = Number(progress?.total_step_count || 0);
        const completedStepCount = Number(progress?.completed_step_count || 0);
        const skippedStepCount = Number(progress?.skipped_step_count || 0);
        const finishedStepCount = Number(progress?.finished_step_count || 0);
        if (progress?.case_id !== caseId || progress.state !== "active"
          || packageCount < 1 || packageCount !== linkedRunCount
          || linkedRunCount !== resolvedRunCount
          || assignmentCount !== linkedAssignmentCount
          || totalStepCount < 1 || totalStepCount !== finishedStepCount
          || totalStepCount !== completedStepCount || skippedStepCount !== 0) {
          throw conflictError(
            "Der Onboarding-Fall besitzt noch offene oder unvollstaendig verknuepfte Aufgaben.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_INCOMPLETE",
          );
        }
        const closedAt = normalizedNow(now);
        assertWrite(await currentRepository.transitionLifecycleCase({
          caseId,
          caseType: "onboarding",
          fromState: "active",
          toState: "completed",
          expectedRevision: Number(caseRow.revision),
          actor: actorId,
          occurredAt: closedAt,
        }), "Der Onboarding-Fallabschluss");
        const event = await appendEvent(currentRepository, {
          actorId,
          caseId,
          employeeNumber: caseRow.employee_number,
          eventId,
          eventType: "onboarding_completed",
          dataClassification: "personal_restricted",
          occurredAt: closedAt,
          payload: {
            schemaVersion: 1,
            operationId: input.operationId,
            caseId,
            state: "completed",
            packageCount,
            totalStepCount,
            evidenceReference: null,
          },
        });
        assertWrite(await currentRepository.insertAudit({
          actor: actorId,
          action: "personnel-lifecycle.onboarding.close",
          entityType: "personnel_lifecycle_case",
          entityId: caseId,
          detail: JSON.stringify({
            operationId: input.operationId,
            packageCount,
            totalStepCount,
            scopeType: scope.type,
          }),
        }), "Der Onboarding-Abschlussaudit");
        const storedCase = await currentRepository.onboardingCaseById({ caseId });
        if (!storedCase || storedCase.state !== "completed") throw integrityError();
        verifyCloseEvent(event, {
          eventId, caseId, actorId, operationId: input.operationId,
        }, caseRow.employee_number);
        return deepFreeze({
          caseId,
          state: "completed",
          closedAt,
          eventId,
          replayed: false,
        });
      }, { isolation: "serializable" });
    } catch (error) {
      if (error instanceof PersonnelLifecycleOnboardingTaskError) throw error;
      if (CONCURRENT_CODES.has(error?.code)) {
        throw conflictError(
          "Der Onboarding-Fall wurde parallel geaendert. Bitte neu laden.",
          "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_CONCURRENT_CHANGE",
        );
      }
      throw error;
    }
  }

  return Object.freeze({ closeCase, completeTask, listActiveTasks });
}

module.exports = {
  PERSONNEL_LIFECYCLE_ONBOARDING_TASK_ERROR_KINDS: ERROR_KINDS,
  PersonnelLifecycleOnboardingTaskError,
  createPersonnelLifecycleOnboardingTaskService,
  normalizedCloseInput,
  normalizedCompletionInput,
};
