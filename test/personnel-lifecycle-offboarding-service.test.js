"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES,
  projectPersonnelLifecycleRecord,
} = require("../lib/personnel-lifecycle-case-contract");
const {
  PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS,
} = require("../lib/personnel-lifecycle-offboarding-contract");
const {
  PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_REPOSITORY_METHODS,
  PersonnelLifecycleOffboardingServiceError,
  createPersonnelLifecycleOffboardingService,
} = require("../lib/personnel-lifecycle-offboarding-service");

const HR = "HR-O5-SERVICE";
const EMPLOYEE = "EMP-O5-SERVICE";
const EPISODE = "episode-o5-service";
const OCCURRED_AT = "2026-08-03T12:00:00.000Z";

function operationId(index) {
  return `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function clone(value) {
  return structuredClone(value);
}

function protectionFunctions() {
  return {
    protectJson(value, context) {
      assert.equal(typeof context.employeeNumber, "string");
      assert.notEqual(context.employeeNumber.trim(), "");
      return `enc:v2:${Buffer.from(JSON.stringify({ context, value }), "utf8").toString("base64")}`;
    },
    parseProtectedJson(payload, expectedContext) {
      assert.equal(typeof expectedContext.employeeNumber, "string");
      assert.notEqual(expectedContext.employeeNumber.trim(), "");
      const decoded = JSON.parse(Buffer.from(payload.slice("enc:v2:".length), "base64").toString("utf8"));
      assert.deepEqual(decoded.context, expectedContext);
      return decoded.value;
    },
  };
}

function writeResult(rowsAffected = 1) {
  return { rowsAffected };
}

class FakeOffboardingRepository {
  constructor() {
    this.data = {
      employees: new Map([[
        EMPLOYEE,
        {
          employee_number: EMPLOYEE,
          employee_active: 1,
          location_id: "LOC-O5-SERVICE",
          location_active: 1,
          department_id: null,
          department_active: null,
          department_location_id: null,
        },
      ]]),
      episodes: new Map([[
        EMPLOYEE,
        {
          episode_id: EPISODE,
          employee_number: EMPLOYEE,
          episode_sequence_number: 1,
          predecessor_episode_id: null,
          episode_state: "employment_active",
          episode_revision: 1,
          location_id: "LOC-O5-SERVICE",
          location_active: 1,
          department_id: null,
          department_active: null,
          department_location_id: null,
        },
      ]]),
      cases: new Map(),
      operations: new Map(),
      events: new Map(),
      accessEvents: new Map(),
      references: new Map(),
      packageVersions: new Map(),
      shells: new Map(),
      bindings: new Map(),
      runs: new Map(),
      packageRuns: new Map(),
      steps: new Map(),
      assignments: new Map(),
      assignmentBindings: new Map(),
      terminations: new Map(),
      candidates: PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map((definition, index) => ({
        employee_number: `O5-RECIPIENT-${index + 1}`,
        full_name: `Empfaenger ${index + 1}`,
        role: `Fachrolle ${index + 1}`,
        operational_read: true,
        operational_update: true,
        allowed_recipient_classes: [definition.recipientClass],
      })).concat([{
        employee_number: EMPLOYEE,
        full_name: "Austretende Person",
        role: "employee",
        operational_read: true,
        operational_update: true,
        allowed_recipient_classes: PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map(
          ({ recipientClass }) => recipientClass,
        ),
      }]),
    };
    this.calls = [];
    this.fail = null;
    this.lastTransactionOptions = null;
  }

  _record(name, payload = null) {
    this.calls.push({ name, payload: clone(payload) });
    if (this.fail?.name === name) {
      this.fail.count += 1;
      if (this.fail.count === this.fail.at) {
        const error = new Error(`synthetic failure: ${name}`);
        error.code = this.fail.code || "SYNTHETIC_FAILURE";
        throw error;
      }
    }
  }

  failOn(name, at = 1) {
    this.fail = { name, at, count: 0 };
  }

  async transaction(work, options) {
    this._record("transaction", options);
    this.lastTransactionOptions = clone(options);
    const snapshot = structuredClone(this.data);
    try {
      return await work(this);
    } catch (error) {
      this.data = snapshot;
      throw error;
    }
  }

  _joinedCase(caseRow) {
    if (!caseRow) return null;
    const episode = this.data.episodes.get(caseRow.employee_number);
    const preparation = [...this.data.operations.values()].find((operation) => (
      operation.case_id === caseRow.id && operation.operation_type === "prepare"
    ));
    return clone({
      ...caseRow,
      episode_state: episode?.episode_state,
      episode_revision: episode?.episode_revision,
      plan_receipt_sha256: preparation?.plan_receipt_sha256 || null,
    });
  }

  async offboardingOperationById({ operationId: id }) {
    this._record("offboardingOperationById", { operationId: id });
    const operation = this.data.operations.get(id);
    if (!operation) return null;
    const caseRow = this.data.cases.get(operation.case_id);
    return clone({ ...operation, employee_number: caseRow?.employee_number || null });
  }

  async insertOffboardingOperation(value) {
    this._record("insertOffboardingOperation", value);
    if (this.data.operations.has(value.operationId)) return writeResult(0);
    this.data.operations.set(value.operationId, {
      operation_id: value.operationId,
      case_id: value.caseId,
      operation_type: value.operationType,
      subject_key: value.subjectKey,
      request_sha256: value.requestSha256,
      plan_receipt_sha256: value.planReceiptSha256,
      protected_result_payload: value.protectedResultPayload,
      result_receipt_sha256: value.resultReceiptSha256,
      actor_id: value.actorId,
      occurred_at: value.occurredAt,
    });
    return writeResult();
  }

  async offboardingCaseById({ caseId }) {
    this._record("offboardingCaseById", { caseId });
    return this._joinedCase(this.data.cases.get(caseId));
  }

  async offboardingEmploymentContextForEmployee({ employeeNumber }) {
    this._record("offboardingEmploymentContextForEmployee", { employeeNumber });
    const employee = this.data.employees.get(employeeNumber);
    if (!employee) return null;
    const episode = this.data.episodes.get(employeeNumber);
    const episodeCases = [...this.data.cases.values()].filter((row) => (
      row.employee_number === employeeNumber
        && (!episode || row.employment_episode_id === episode.episode_id)
    ));
    const current = episodeCases.find((row) => (
      !["completed", "cancelled"].includes(row.state)
    ));
    const terminal = episodeCases.filter((row) => ["completed", "cancelled"].includes(row.state))
      .at(-1);
    return clone({
      ...employee,
      employment_episode_id: episode?.episode_id || null,
      episode_id: episode?.episode_id || null,
      episode_sequence_number: episode?.episode_sequence_number || null,
      predecessor_episode_id: episode?.predecessor_episode_id || null,
      episode_state: episode?.episode_state || null,
      episode_revision: episode?.episode_revision || null,
      current_case_id: current?.id || null,
      current_case_state: current?.state || null,
      current_case_revision: current?.revision || null,
      latest_terminal_case_id: terminal?.id || null,
      latest_terminal_case_state: terminal?.state || null,
      latest_terminal_case_created_at: terminal?.created_at || null,
    });
  }

  async insertOffboardingEmploymentEpisode(value) {
    this._record("insertOffboardingEmploymentEpisode", value);
    if (this.data.episodes.has(value.employeeNumber)) return writeResult(0);
    const employee = this.data.employees.get(value.employeeNumber);
    if (!employee) return writeResult(0);
    this.data.episodes.set(value.employeeNumber, {
      episode_id: value.id,
      employee_number: value.employeeNumber,
      episode_sequence_number: value.sequenceNumber,
      predecessor_episode_id: value.predecessorEpisodeId,
      episode_state: "employment_active",
      episode_revision: 1,
      ...employee,
      protected_payload: value.protectedPayload,
    });
    return writeResult();
  }

  async insertOffboardingLifecycleCase(value) {
    this._record("insertOffboardingLifecycleCase", value);
    if (this.data.cases.has(value.id)) return writeResult(0);
    const episode = [...this.data.episodes.values()].find((row) => (
      row.episode_id === value.employmentEpisodeId
    ));
    if (!episode) return writeResult(0);
    this.data.cases.set(value.id, {
      id: value.id,
      case_type: "offboarding",
      employment_episode_id: value.employmentEpisodeId,
      predecessor_case_id: value.predecessorCaseId,
      employee_number: episode.employee_number,
      responsible_actor_id: value.responsibleActorId,
      state: "internally_prepared",
      revision: 1,
      scope_type: value.scopeType,
      location_id: value.locationId,
      department_id: value.departmentId,
      scope_snapshot_sha256: value.scopeSnapshotSha256,
      protected_payload: value.protectedPayload,
      protected_plan_payload: value.protectedPayload,
      communication_release_at: null,
      employee_informed_at: null,
      created_at: value.occurredAt,
      updated_at: value.occurredAt,
    });
    return writeResult();
  }

  async transitionOffboardingLifecycleCase(value) {
    this._record("transitionOffboardingLifecycleCase", value);
    const row = this.data.cases.get(value.caseId);
    if (!row || row.state !== value.fromState || row.revision !== value.expectedRevision) {
      return writeResult(0);
    }
    row.state = value.toState;
    row.revision += 1;
    row.updated_at = value.occurredAt;
    if (value.communicationReleaseAt) row.communication_release_at = value.communicationReleaseAt;
    if (value.employeeInformedAt) row.employee_informed_at = value.employeeInformedAt;
    return writeResult();
  }

  async transitionOffboardingEmploymentEpisode(value) {
    this._record("transitionOffboardingEmploymentEpisode", value);
    const row = [...this.data.episodes.values()].find(({ episode_id: id }) => id === value.episodeId);
    if (!row || row.episode_state !== value.fromState
      || row.episode_revision !== value.expectedRevision) return writeResult(0);
    row.episode_state = value.toState;
    row.episode_revision += 1;
    return writeResult();
  }

  async insertOffboardingReferenceDates(value) {
    this._record("insertOffboardingReferenceDates", value);
    this.data.references.set(value.id, clone(value));
    return writeResult();
  }

  async offboardingCaseEventById({ eventId }) {
    this._record("offboardingCaseEventById", { eventId });
    return clone(this.data.events.get(eventId) || null);
  }

  async offboardingCaseLastEvent({ caseId }) {
    this._record("offboardingCaseLastEvent", { caseId });
    return clone([...this.data.events.values()]
      .filter((row) => row.case_id === caseId)
      .sort((left, right) => right.sequence_number - left.sequence_number)[0] || null);
  }

  async insertOffboardingLifecycleCaseEvent(value) {
    this._record("insertOffboardingLifecycleCaseEvent", value);
    this.data.events.set(value.id, {
      id: value.id,
      case_id: value.caseId,
      sequence_number: value.sequenceNumber,
      event_type: value.eventType,
      data_classification: value.dataClassification,
      protected_payload: value.protectedPayload,
      previous_receipt_sha256: value.previousReceiptSha256,
      receipt_sha256: value.receiptSha256,
      actor_id: value.actor,
      occurred_at: value.occurredAt,
    });
    return writeResult();
  }

  async offboardingCaseProjection({ caseId }) {
    this._record("offboardingCaseProjection", { caseId });
    return this._joinedCase(this.data.cases.get(caseId));
  }

  async offboardingConfidentialAccessLastEvent({ caseId }) {
    this._record("offboardingConfidentialAccessLastEvent", { caseId });
    return clone([...this.data.accessEvents.values()]
      .filter((row) => row.case_id === caseId)
      .sort((left, right) => right.sequence_number - left.sequence_number)[0] || null);
  }

  async insertOffboardingConfidentialAccessEvent(value) {
    this._record("insertOffboardingConfidentialAccessEvent", value);
    this.data.accessEvents.set(value.id, {
      id: value.id,
      case_id: value.caseId,
      sequence_number: value.sequenceNumber,
      previous_receipt_sha256: value.previousReceiptSha256,
      actor_id: value.actor,
      action: value.action,
      result: value.result,
      purpose_code: value.purposeCode,
      occurred_at: value.occurredAt,
      receipt_sha256: value.receiptSha256,
    });
    return writeResult();
  }

  async offboardingTimeCriticalApprovalStatus({ caseId }) {
    this._record("offboardingTimeCriticalApprovalStatus", { caseId });
    const event = [...this.data.events.values()].find((row) => (
      row.case_id === caseId && row.event_type === "offboarding_time_critical_approved"
    ));
    return event ? { approved: true, event_id: event.id } : { approved: false };
  }

  async listRecipientCandidates() {
    this._record("listRecipientCandidates");
    return clone(this.data.candidates);
  }

  async offboardingPackageVersionById({ packageVersionId }) {
    this._record("offboardingPackageVersionById", { packageVersionId });
    return clone(this.data.packageVersions.get(packageVersionId) || null);
  }

  async insertOffboardingPackageVersion(value) {
    this._record("insertOffboardingPackageVersion", value);
    if (this.data.packageVersions.has(value.id)) return writeResult(0);
    this.data.packageVersions.set(value.id, {
      id: value.id,
      series_id: value.seriesId,
      runtime_process_id: value.runtimeProcessId,
      version_number: value.versionNumber,
      predecessor_version_id: value.predecessorVersionId,
      family_code: value.familyCode,
      path_kind: value.pathKind,
      requirement_kind: value.requirementKind,
      scope_type: value.scopeType,
      location_id: value.locationId,
      department_id: value.departmentId,
      data_classification: "offboarding_strict_confidential",
      protected_snapshot: value.protectedSnapshot,
      snapshot_sha256: value.snapshotSha256,
      runtime_manifest_sha256: value.runtimeManifestSha256,
      receipt_sha256: value.receiptSha256,
      published_by: value.publishedBy,
      published_at: value.publishedAt,
      archived_at: null,
      archive_reason_code: null,
    });
    return writeResult();
  }

  async offboardingRuntimeProcessShellById({ runtimeProcessId }) {
    this._record("offboardingRuntimeProcessShellById", { runtimeProcessId });
    return clone(this.data.shells.get(runtimeProcessId) || null);
  }

  async insertOffboardingRuntimeProcessShell(value) {
    this._record("insertOffboardingRuntimeProcessShell", value);
    if (this.data.shells.has(value.runtimeProcessId)) return writeResult(0);
    this.data.shells.set(value.runtimeProcessId, {
      id: value.runtimeProcessId,
      title: "Geschützter Personalprozess",
      symbol: "P",
      description: "",
      category: "other",
      scope_type: "company",
      location_id: null,
      department_id: null,
      trigger_type: "manual",
      trigger_minimum_shortfall: 1,
      status: "active",
      revision: value.versionNumber,
      created_by: value.actor,
      updated_by: value.actor,
      archived_at: null,
    });
    return writeResult();
  }

  async insertOffboardingPackageBinding(value) {
    this._record("insertOffboardingPackageBinding", value);
    this.data.bindings.set(value.id, clone(value));
    return writeResult();
  }

  async insertOffboardingRun(value) {
    this._record("insertOffboardingRun", value);
    this.data.runs.set(value.id, {
      run_id: value.id,
      runtime_process_id: value.runtimeProcessId,
      run_operation_id: value.runOperationId,
      location_id: value.locationId,
      department_id: value.departmentId,
      status: "open",
    });
    return writeResult();
  }

  async insertOffboardingPackageRun(value) {
    this._record("insertOffboardingPackageRun", value);
    this.data.packageRuns.set(value.runId, clone(value));
    return writeResult();
  }

  async insertOffboardingRuntimeStep(value) {
    this._record("insertOffboardingRuntimeStep", value);
    this.data.steps.set(`${value.runId}:${value.stepReference}`, {
      run_id: value.runId,
      step_id: value.stepReference,
      order_reference: value.orderReference,
      sort_order: value.sortOrder,
      package_binding_id: value.packageBindingId,
      recipient_class: value.recipientClass,
      release_gate: value.releaseGate,
      data_classification: value.dataClassification,
      protected_payload: value.protectedPayload,
      status: null,
      completion_request_id: null,
    });
    return writeResult();
  }

  async insertOffboardingRunStep(value) {
    this._record("insertOffboardingRunStep", value);
    const step = this.data.steps.get(`${value.runId}:${value.stepId}`);
    if (!step || step.sort_order !== value.sortOrder || step.status !== null) return writeResult(0);
    step.status = "pending";
    return writeResult();
  }

  async insertOffboardingAssignment(value) {
    this._record("insertOffboardingAssignment", value);
    this.data.assignments.set(value.id, {
      assignment_id: value.id,
      case_id: value.caseId,
      step_id: value.stepReference,
      assignee_actor_id: value.assigneeActorId,
      assignment_receipt_sha256: value.receiptSha256,
    });
    return writeResult();
  }

  async insertOffboardingAssignmentBinding(value) {
    this._record("insertOffboardingAssignmentBinding", value);
    this.data.assignmentBindings.set(value.assignmentId, clone(value));
    const assignment = this.data.assignments.get(value.assignmentId);
    if (!assignment) return writeResult(0);
    assignment.run_id = value.runId;
    assignment.step_id = value.stepReference;
    return writeResult();
  }

  _runRows(caseId) {
    return [...this.data.packageRuns.values()]
      .filter((packageRun) => {
        const binding = this.data.bindings.get(packageRun.packageBindingId);
        return binding?.caseId === caseId;
      })
      .map((packageRun) => {
        const run = this.data.runs.get(packageRun.runId);
        const binding = this.data.bindings.get(packageRun.packageBindingId);
        const version = this.data.packageVersions.get(binding.packageVersionId);
        const step = [...this.data.steps.values()].find(({ run_id: id }) => id === run.run_id);
        const termination = this.data.terminations.get(run.run_id);
        return {
          ...run,
          package_binding_id: packageRun.packageBindingId,
          family_code: version.family_code,
          run_status: run.status,
          termination_operation_id: termination?.operationId || null,
        };
      });
  }

  async listOffboardingPackageRuns({ caseId }) {
    this._record("listOffboardingPackageRuns", { caseId });
    return clone(this._runRows(caseId));
  }

  async listOffboardingAssignments({ caseId }) {
    this._record("listOffboardingAssignments", { caseId });
    return [...this.data.assignments.values()]
      .filter((assignment) => assignment.case_id === caseId)
      .map((assignment) => this._taskRow(assignment));
  }

  _taskRow(assignment) {
    const run = this.data.runs.get(assignment.run_id);
    const step = this.data.steps.get(`${assignment.run_id}:${assignment.step_id}`);
    const caseRow = this.data.cases.get(assignment.case_id);
    const episode = this.data.episodes.get(caseRow.employee_number);
    const binding = this.data.assignmentBindings.get(assignment.assignment_id);
    const packageBinding = this.data.bindings.get(binding.packageBindingId);
    const version = this.data.packageVersions.get(packageBinding.packageVersionId);
    const termination = this.data.terminations.get(run.run_id);
    const preparation = [...this.data.operations.values()].find((operation) => (
      operation.case_id === caseRow.id && operation.operation_type === "prepare"
    ));
    return clone({
      case_id: caseRow.id,
      case_type: caseRow.case_type,
      case_state: caseRow.state,
      case_revision: caseRow.revision,
      employment_episode_id: caseRow.employment_episode_id,
      employee_number: caseRow.employee_number,
      episode_state: episode.episode_state,
      episode_revision: episode.episode_revision,
      plan_receipt_sha256: preparation?.plan_receipt_sha256 || null,
      protected_plan_payload: caseRow.protected_payload,
      case_scope_type: caseRow.scope_type,
      case_location_id: caseRow.location_id,
      case_department_id: caseRow.department_id,
      display_name: "Synthetische Person",
      run_id: run.run_id,
      run_status: run.status,
      family_code: version.family_code,
      runtime_step_reference: step.step_id,
      runtime_order_reference: step.order_reference,
      run_step_status: step.status,
      assignment_id: assignment.assignment_id,
      assignee_actor_id: assignment.assignee_actor_id,
      recipient_class: step.recipient_class,
      release_gate: step.release_gate,
      data_classification: step.data_classification,
      protected_payload: step.protected_payload,
      termination_operation_id: termination?.operationId || null,
    });
  }

  async listActiveLifecycleOffboardingTasks({ actorId }) {
    this._record("listActiveLifecycleOffboardingTasks", { actorId });
    return [...this.data.assignments.values()]
      .filter(({ assignee_actor_id: assigned }) => assigned === actorId)
      .map((assignment) => this._taskRow(assignment))
      .filter((row) => ["communication_released", "employee_informed", "active"].includes(
        row.case_state,
      ) && row.run_status === "open"
        && ["pending", "active"].includes(row.run_step_status)
        && !row.termination_operation_id);
  }

  async lifecycleOffboardingTaskContext({ actorId, runId, stepId }) {
    this._record("lifecycleOffboardingTaskContext", { actorId, runId, stepId });
    const assignment = [...this.data.assignments.values()].find((row) => (
      row.assignee_actor_id === actorId && row.run_id === runId && row.step_id === stepId
    ));
    return assignment ? this._taskRow(assignment) : null;
  }

  async completeOffboardingRunStep(value) {
    this._record("completeOffboardingRunStep", value);
    const step = this.data.steps.get(`${value.runId}:${value.stepId}`);
    const assignment = [...this.data.assignments.values()].find((row) => (
      row.run_id === value.runId && row.step_id === value.stepId
    ));
    if (!step || !assignment || step.status !== "active"
      || assignment.assignee_actor_id !== value.actorId) return writeResult(0);
    step.status = "completed";
    step.completion_request_id = value.completionRequestSha256;
    step.completed_by = value.actorId;
    return writeResult();
  }

  async activateNextOffboardingRunStep(value) {
    this._record("activateNextOffboardingRunStep", value);
    const run = this.data.runs.get(value.runId);
    const step = this.data.steps.get(`${value.runId}:${value.stepId}`);
    if (!run || !step || run.status !== "open" || step.status !== "pending") {
      return writeResult(0);
    }
    step.status = "active";
    return writeResult();
  }

  async resolveOffboardingRun(value) {
    this._record("resolveOffboardingRun", value);
    const run = this.data.runs.get(value.runId);
    const step = [...this.data.steps.values()].find(({ run_id: id }) => id === value.runId);
    if (!run || run.status !== "open"
      || (step?.status !== "completed" && !this.data.terminations.has(value.runId))) {
      return writeResult(0);
    }
    run.status = "resolved";
    return writeResult();
  }

  async insertOffboardingRunTermination(value) {
    this._record("insertOffboardingRunTermination", value);
    this.data.terminations.set(value.runId, clone(value));
    return writeResult();
  }

  async offboardingCaseProgress({ caseId }) {
    this._record("offboardingCaseProgress", { caseId });
    const runs = this._runRows(caseId);
    const assignments = [...this.data.assignments.values()].filter((row) => row.case_id === caseId);
    return {
      case_id: caseId,
      package_count: this.data.bindings.size,
      linked_run_count: runs.length,
      resolved_run_count: runs.filter(({ run_status: status }) => status === "resolved").length,
      assignment_count: assignments.length,
      linked_assignment_count: this.data.assignmentBindings.size,
      total_step_count: assignments.length,
      pending_step_count: assignments.filter((assignment) => (
        this.data.steps.get(`${assignment.run_id}:${assignment.step_id}`)?.status === "pending"
      )).length,
      active_step_count: assignments.filter((assignment) => (
        this.data.steps.get(`${assignment.run_id}:${assignment.step_id}`)?.status === "active"
      )).length,
      completed_step_count: assignments.filter((assignment) => (
        this.data.steps.get(`${assignment.run_id}:${assignment.step_id}`)?.status === "completed"
      )).length,
      skipped_step_count: assignments.filter((assignment) => (
        this.data.steps.get(`${assignment.run_id}:${assignment.step_id}`)?.status === "skipped"
      )).length,
      termination_count: [...this.data.terminations.values()].filter(({ caseId: id }) => (
        id === caseId
      )).length,
    };
  }
}

for (const method of PERSONNEL_LIFECYCLE_OFFBOARDING_SERVICE_REPOSITORY_METHODS) {
  assert.equal(typeof FakeOffboardingRepository.prototype[method], "function", method);
}

function accessFor(actorId, overrides = {}) {
  return {
    actorId,
    namedActor: true,
    central: true,
    canReadOffboardingConfidential: true,
    canPrepareOffboarding: true,
    canReleaseOffboardingCommunication: true,
    canConfirmOffboardingInformation: true,
    canExecuteOffboarding: true,
    canCloseOffboarding: true,
    canWriteAssignments: true,
    canApproveExceptions: true,
    canReadOperational: true,
    canUpdateOperational: true,
    canAuthorizeTransition: async () => true,
    canReadOperationalScope: async () => true,
    canUpdateOperationalScope: async () => true,
    project: async (source, projection, context) => {
      if (context.recipientClass !== PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES[projection]) {
        return null;
      }
      return projectPersonnelLifecycleRecord(source, projection);
    },
    ...overrides,
  };
}

function preparationInput(index = 1, { timeCritical = false } = {}) {
  return {
    operationId: operationId(index),
    employeeNumber: EMPLOYEE,
    responsibleActorId: HR,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.PREPARATION,
    referenceTimes: {
      plannedExitAt: "2026-08-03T10:00:00.000Z",
      lastWorkingDay: "2026-08-28",
      legalExitDate: "2026-08-31",
      accessBlockAt: "2026-08-28T16:00:00.000Z",
    },
    urgency: timeCritical ? {
      mode: "time_critical",
      confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL,
      exceptionReason: {
        code: "immediate_exit",
        note: "Synthetischer zeitkritischer Ausnahmefall.",
      },
      followUpDueAt: "2026-09-02T12:00:00.000Z",
    } : {
      mode: "standard",
      confirmation: null,
      exceptionReason: null,
      followUpDueAt: null,
    },
    exitReason: {
      code: "employee_notice",
      note: "Synthetischer geschuetzter Austrittsgrund.",
    },
    hrNote: "Synthetischer PL-Vermerk.",
    documentReferenceIds: ["DOC-O5-001"],
    assignments: PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map(
      (definition, familyIndex) => ({
        familyCode: definition.familyCode,
        assigneeActorId: `O5-RECIPIENT-${familyIndex + 1}`,
        title: `Geschuetzter O5-Titel ${familyIndex + 1}`,
        instructions: `Geschuetzte O5-Anweisung ${familyIndex + 1}.`,
      }),
    ),
  };
}

function mutationReason(code) {
  return {
    code,
    note: "Synthetische geschuetzte Begruendung.",
    documentReferenceIds: ["DOC-O5-MUTATION"],
  };
}

function releaseInput(caseId, revision, index) {
  return {
    operationId: operationId(index),
    caseId,
    expectedRevision: revision,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.COMMUNICATION_RELEASE,
    reason: mutationReason("communication_approved"),
  };
}

function harness() {
  const repository = new FakeOffboardingRepository();
  const protection = protectionFunctions();
  const eligibilityCalls = [];
  const service = createPersonnelLifecycleOffboardingService(repository, {
    ...protection,
    now: () => new Date(OCCURRED_AT),
    canAssignRecipient: async (context) => {
      eligibilityCalls.push(clone({
        actorId: context.recipient.employee_number,
        familyCode: context.familyCode,
        recipientClass: context.recipientClass,
        projection: context.projection,
      }));
      return context.recipient.employee_number !== context.subjectEmployeeNumber
        && context.recipient.operational_read === true
        && context.recipient.operational_update === true
        && context.recipient.allowed_recipient_classes.includes(context.recipientClass);
    },
  });
  return { repository, service, eligibilityCalls };
}

async function prepared(h, { timeCritical = false, operationIndex = 1 } = {}) {
  const input = preparationInput(operationIndex, { timeCritical });
  const result = await h.service.prepare(HR, input, { access: accessFor(HR) });
  return { input, result, caseId: result.caseId };
}

test("O5-Factory verlangt das vollstaendige fachliche Repositoryinterface", () => {
  const protection = protectionFunctions();
  assert.throws(
    () => createPersonnelLifecycleOffboardingService({}, {
      ...protection,
      canAssignRecipient: async () => true,
    }),
    /Dem O5-Repository fehlen Methoden/,
  );
});

test("prepare bleibt vor Kommunikationsfreigabe runtime-null und ist kanonisch idempotent", async () => {
  const h = harness();
  const { input, result } = await prepared(h);

  assert.equal(result.state, "internally_prepared");
  assert.equal(result.runtimeCount, 0);
  assert.equal(h.repository.data.runs.size, 0);
  assert.equal(h.repository.data.steps.size, 0);
  assert.equal(h.repository.data.assignments.size, 0);
  assert.equal(h.repository.data.bindings.size, 0);
  assert.deepEqual(h.repository.lastTransactionOptions, { isolation: "serializable" });
  const storedCase = h.repository.data.cases.get(result.caseId);
  assert.match(storedCase.protected_plan_payload, /^enc:v2:/);
  assert.equal(storedCase.protected_plan_payload.includes("Geschuetzter O5-Titel"), false);
  assert.equal([...h.repository.data.events.values()].every(({ protected_payload: payload }) => (
    payload.startsWith("enc:v2:")
  )), true);

  const replay = await h.service.prepare(HR, clone(input), { access: accessFor(HR) });
  assert.equal(replay.caseId, result.caseId);
  assert.equal(replay.replayed, true);
  assert.equal(h.repository.data.cases.size, 1);

  const drift = clone(input);
  drift.assignments[0].instructions = "Abweichender geschuetzter Inhalt.";
  await assert.rejects(
    h.service.prepare(HR, drift, { access: accessFor(HR) }),
    (error) => error.code === "PERSONNEL_LIFECYCLE_OFFBOARDING_OPERATION_CONFLICT",
  );
});

test("prepare legt fuer einen aktiven Bestandsmitarbeiter ohne Episode atomar genau eine Initialepisode an", async () => {
  const h = harness();
  h.repository.data.episodes.delete(EMPLOYEE);
  const input = preparationInput(101);
  const first = await h.service.prepare(HR, input, { access: accessFor(HR) });
  const episode = h.repository.data.episodes.get(EMPLOYEE);
  assert.ok(episode);
  assert.equal(episode.episode_state, "employment_active");
  assert.equal(episode.episode_sequence_number, 1);
  assert.equal(episode.predecessor_episode_id, null);
  assert.match(episode.protected_payload, /^enc:v2:/);
  assert.equal(h.repository.calls.filter(({ name }) => (
    name === "insertOffboardingEmploymentEpisode"
  )).length, 1);

  const replay = await h.service.prepare(HR, clone(input), { access: accessFor(HR) });
  assert.equal(replay.caseId, first.caseId);
  assert.equal(replay.replayed, true);
  assert.equal(h.repository.calls.filter(({ name }) => (
    name === "insertOffboardingEmploymentEpisode"
  )).length, 1);
});

test("prepare blockiert exit_in_progress und employment_ended ohne neue Episode oder neuen Fall", async () => {
  for (const [state, index] of [["exit_in_progress", 102], ["employment_ended", 103]]) {
    const h = harness();
    h.repository.data.episodes.get(EMPLOYEE).episode_state = state;
    await assert.rejects(
      h.service.prepare(HR, preparationInput(index), { access: accessFor(HR) }),
      (error) => error.code === "PERSONNEL_LIFECYCLE_OFFBOARDING_EPISODE_STATE_CONFLICT",
    );
    assert.equal(h.repository.data.cases.size, 0);
    assert.equal(h.repository.calls.some(({ name }) => (
      name === "insertOffboardingEmploymentEpisode"
    )), false);
  }
});

test("nach cancelled beginnt prepare einen neuen Fall mit predecessor_case_id", async () => {
  const h = harness();
  const first = await h.service.prepare(HR, preparationInput(104), { access: accessFor(HR) });
  await h.service.cancel(HR, {
    operationId: operationId(105),
    caseId: first.caseId,
    expectedRevision: 1,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CANCELLATION,
    reason: mutationReason("exit_withdrawn"),
  }, { access: accessFor(HR) });

  const second = await h.service.prepare(HR, preparationInput(106), { access: accessFor(HR) });
  assert.notEqual(second.caseId, first.caseId);
  assert.equal(h.repository.data.cases.get(first.caseId).state, "cancelled");
  assert.equal(h.repository.data.cases.get(second.caseId).predecessor_case_id, first.caseId);
  assert.equal(h.repository.data.cases.size, 2);
  assert.equal(h.repository.calls.filter(({ name }) => (
    name === "insertOffboardingEmploymentEpisode"
  )).length, 0);
});

test("Fachrechte werden vor Replay-Lookup geprueft", async () => {
  const h = harness();
  const { input } = await prepared(h);
  const before = h.repository.calls.filter(({ name }) => name === "offboardingOperationById").length;
  await assert.rejects(
    h.service.prepare(HR, clone(input), {
      access: accessFor(HR, { canReadOffboardingConfidential: false }),
    }),
    (error) => error.kind === "forbidden",
  );
  const after = h.repository.calls.filter(({ name }) => name === "offboardingOperationById").length;
  assert.equal(after, before);
});

test("readProjection ist O1-begrenzt, familienbezogen und verkettet jeden vertraulichen Zugriff", async () => {
  const h = harness();
  const { caseId } = await prepared(h);
  const first = await h.service.readProjection(HR, caseId, { access: accessFor(HR) });
  const second = await h.service.readProjection(HR, caseId, { access: accessFor(HR) });

  assert.equal(first.families.length, 6);
  assert.equal(first.responsibleActorId, HR);
  assert.equal(first.createdAt, OCCURRED_AT);
  assert.equal(first.updatedAt, OCCURRED_AT);
  assert.equal(first.urgency.approved, true);
  assert.equal(first.families.every(({ runtimeStatus }) => (
    runtimeStatus === "confidential_preparation"
  )), true);
  for (const family of first.families) {
    assert.equal(family.candidates.some(({ actorId }) => actorId === EMPLOYEE), false);
    assert.equal(family.candidates.some(({ actorId }) => (
      actorId === family.assigneeActorId
    )), true);
    for (const candidate of family.candidates) {
      assert.deepEqual(Object.keys(candidate).sort(), ["actorId", "displayName", "roleLabel"]);
    }
  }
  const accessRows = [...h.repository.data.accessEvents.values()]
    .sort((left, right) => left.sequence_number - right.sequence_number);
  assert.equal(accessRows.length, 2);
  assert.equal(accessRows[0].previous_receipt_sha256, "");
  assert.equal(accessRows[1].previous_receipt_sha256, accessRows[0].receipt_sha256);
  assert.equal(first.accessEventId, accessRows[0].id);
  assert.equal(second.accessEventId, accessRows[1].id);
  assert.equal(new Set(h.eligibilityCalls.map(({ recipientClass }) => recipientClass)).size, 4);
  assert.equal(h.eligibilityCalls.every(({ familyCode, recipientClass, projection }) => {
    const definition = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.find(
      (entry) => entry.familyCode === familyCode,
    );
    return definition.recipientClass === recipientClass && definition.projection === projection;
  }), true);
});

test("Release erzeugt atomar sechs pending O5-Runs und oeffnet nur read-only Minimalprojektionen", async () => {
  const h = harness();
  const { caseId } = await prepared(h);
  const release = await h.service.releaseCommunication(
    HR,
    releaseInput(caseId, 1, 2),
    { access: accessFor(HR) },
  );
  assert.equal(release.runtimeCount, 6);
  assert.equal(h.repository.data.runs.size, 6);
  assert.equal(h.repository.data.steps.size, 6);
  assert.equal(h.repository.data.assignments.size, 6);
  assert.equal(h.repository.data.packageVersions.size, 6);
  assert.equal(h.repository.data.shells.size, 6);
  assert.equal([...h.repository.data.runs.values()].every(({ status }) => status === "open"), true);
  assert.equal([...h.repository.data.steps.values()].every(({ status }) => status === "pending"), true);
  assert.equal(h.repository.data.episodes.get(EMPLOYEE).episode_state, "exit_in_progress");

  const firstAssignment = [...h.repository.data.assignments.values()][0];
  const list = await h.service.listTasks(firstAssignment.assignee_actor_id, {
    access: accessFor(firstAssignment.assignee_actor_id, {
      canReadOffboardingConfidential: false,
    }),
  });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].canComplete, false);
  assert.equal(list.items[0].task.status, "pending");
  const definition = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.find(({ stepId }) => (
    stepId === list.items[0].stepId
  ));
  assert.deepEqual(
    Object.keys(list.items[0].task).sort(),
    Object.keys(projectPersonnelLifecycleRecord({
      orderId: "x", displayName: "x", employeeNumber: "x", locationId: null,
      departmentId: null, title: "x", businessIdentifier: "x", targetSystem: "x",
      action: "x", executeAt: "x", assetIdentifier: null, payrollAction: "x",
      effectiveDate: "x", dueAt: "x", status: "pending",
    }, definition.projection)).sort(),
  );
  await assert.rejects(
    h.service.completeTask(
      firstAssignment.assignee_actor_id,
      firstAssignment.run_id,
      firstAssignment.step_id,
      { operationId: operationId(3), action: "complete" },
      { access: accessFor(firstAssignment.assignee_actor_id) },
    ),
    (error) => error.code === "PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_STATE_CONFLICT",
  );
  assert.equal(h.repository.data.steps.get(
    `${firstAssignment.run_id}:${firstAssignment.step_id}`,
  ).status, "pending");
});

test("zeitkritische Erfassung ersetzt weder exceptions:approve noch eigenen Freigabebeleg", async () => {
  const h = harness();
  const { caseId } = await prepared(h, { timeCritical: true });
  const before = await h.service.readProjection(HR, caseId, { access: accessFor(HR) });
  assert.equal(before.urgency.approved, false);

  await assert.rejects(
    h.service.releaseCommunication(HR, releaseInput(caseId, 1, 10), {
      access: accessFor(HR),
    }),
    (error) => error.code === "PERSONNEL_LIFECYCLE_OFFBOARDING_TIME_CRITICAL_APPROVAL_REQUIRED",
  );
  assert.equal(h.repository.data.runs.size, 0);

  const approvalInput = {
    operationId: operationId(11),
    caseId,
    expectedRevision: 1,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.TIME_CRITICAL,
    reason: mutationReason("urgent_path_approved"),
  };
  await assert.rejects(
    h.service.timeCriticalApprove(HR, approvalInput, {
      access: accessFor(HR, { canApproveExceptions: false }),
    }),
    (error) => error.kind === "forbidden",
  );
  await h.service.timeCriticalApprove(HR, approvalInput, { access: accessFor(HR) });
  const after = await h.service.readProjection(HR, caseId, { access: accessFor(HR) });
  assert.equal(after.urgency.approved, true);
  await h.service.releaseCommunication(HR, releaseInput(caseId, 1, 12), {
    access: accessFor(HR),
  });
  assert.equal(h.repository.data.runs.size, 6);
});

test("serialisierbarer Release-Rollback hinterlaesst weder Teil-Runs noch Zustandswechsel", async () => {
  const h = harness();
  const { caseId } = await prepared(h);
  h.repository.failOn("insertOffboardingRun", 3);
  await assert.rejects(
    h.service.releaseCommunication(HR, releaseInput(caseId, 1, 20), {
      access: accessFor(HR),
    }),
    /synthetic failure/,
  );
  assert.equal(h.repository.data.cases.get(caseId).state, "internally_prepared");
  assert.equal(h.repository.data.episodes.get(EMPLOYEE).episode_state, "employment_active");
  for (const name of [
    "runs", "steps", "assignments", "bindings", "packageRuns", "packageVersions", "shells",
  ]) assert.equal(h.repository.data[name].size, 0, name);
  assert.equal(h.repository.data.operations.has(operationId(20)), false);
});

async function activatedHarness() {
  const h = harness();
  const { caseId } = await prepared(h);
  await h.service.releaseCommunication(HR, releaseInput(caseId, 1, 30), {
    access: accessFor(HR),
  });
  await h.service.confirmInformation(HR, {
    operationId: operationId(31),
    caseId,
    expectedRevision: 2,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.INFORMATION_CONFIRMATION,
    employeeInformedAt: "2026-08-03T11:30:00.000Z",
  }, { access: accessFor(HR) });
  await h.service.activate(HR, {
    operationId: operationId(32),
    caseId,
    expectedRevision: 3,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.ACTIVATION,
  }, { access: accessFor(HR) });
  return { h, caseId };
}

test("complete ist active-, Assignee- und complete-only-gebunden; Close braucht sechs completions", async () => {
  const { h, caseId } = await activatedHarness();
  const first = [...h.repository.data.assignments.values()][0];
  await assert.rejects(
    h.service.completeTask(
      "OTHER-ACTOR",
      first.run_id,
      first.step_id,
      { operationId: operationId(40), action: "complete" },
      { access: accessFor("OTHER-ACTOR") },
    ),
    (error) => error.kind === "not_found",
  );
  await assert.rejects(
    h.service.completeTask(
      first.assignee_actor_id,
      first.run_id,
      first.step_id,
      { operationId: operationId(41), action: "skip" },
      { access: accessFor(first.assignee_actor_id) },
    ),
    (error) => error.code === "PERSONNEL_LIFECYCLE_OFFBOARDING_TASK_COMPLETE_ONLY",
  );
  await assert.rejects(
    h.service.close(HR, {
      operationId: operationId(42),
      caseId,
      expectedRevision: 4,
      confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CLOSE,
    }, { access: accessFor(HR) }),
    (error) => error.code === "PERSONNEL_LIFECYCLE_OFFBOARDING_CLOSE_INCOMPLETE",
  );

  let index = 50;
  for (const assignment of h.repository.data.assignments.values()) {
    const result = await h.service.completeTask(
      assignment.assignee_actor_id,
      assignment.run_id,
      assignment.step_id,
      { operationId: operationId(index), action: "complete" },
      { access: accessFor(assignment.assignee_actor_id) },
    );
    const operation = h.repository.data.operations.get(operationId(index));
    const step = h.repository.data.steps.get(`${assignment.run_id}:${assignment.step_id}`);
    assert.equal(operation.subject_key, `${assignment.run_id}:${assignment.step_id}`);
    assert.equal(operation.request_sha256, step.completion_request_id);
    assert.equal(operation.actor_id, assignment.assignee_actor_id);
    assert.equal(result.status, "completed");
    index += 1;
  }

  const closed = await h.service.close(HR, {
    operationId: operationId(60),
    caseId,
    expectedRevision: 4,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CLOSE,
  }, { access: accessFor(HR) });
  assert.equal(closed.state, "completed");
  assert.equal(h.repository.data.cases.get(caseId).state, "completed");
  assert.equal(h.repository.data.episodes.get(EMPLOYEE).episode_state, "employment_ended");
  const planReceipts = new Set([...h.repository.data.operations.values()].map((row) => (
    row.plan_receipt_sha256
  )));
  assert.equal(planReceipts.size, 1);
  const operationTypes = new Set([...h.repository.data.operations.values()].map((row) => (
    row.operation_type
  )));
  assert.deepEqual([...operationTypes].sort(), [
    "activation",
    "close",
    "communication_release",
    "information_confirmation",
    "prepare",
    "task_complete",
  ]);
});

test("Cancel terminiert nach Release additiv und erzeugt niemals skipped-Schritte", async () => {
  const h = harness();
  const { caseId } = await prepared(h);
  await h.service.releaseCommunication(HR, releaseInput(caseId, 1, 70), {
    access: accessFor(HR),
  });
  const cancelled = await h.service.cancel(HR, {
    operationId: operationId(71),
    caseId,
    expectedRevision: 2,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CANCELLATION,
    reason: mutationReason("exit_withdrawn"),
  }, { access: accessFor(HR) });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.terminatedRunCount, 6);
  assert.equal(h.repository.data.terminations.size, 6);
  assert.equal([...h.repository.data.steps.values()].some(({ status }) => status === "skipped"), false);
  assert.equal(h.repository.data.episodes.get(EMPLOYEE).episode_state, "employment_active");
});

test("Cancel terminiert nur unfinished Runs und bewahrt bereits abgeschlossene Aufgaben", async () => {
  const { h, caseId } = await activatedHarness();
  const first = [...h.repository.data.assignments.values()][0];
  await h.service.completeTask(
    first.assignee_actor_id,
    first.run_id,
    first.step_id,
    { operationId: operationId(80), action: "complete" },
    { access: accessFor(first.assignee_actor_id) },
  );
  const cancelled = await h.service.cancel(HR, {
    operationId: operationId(81),
    caseId,
    expectedRevision: 4,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CANCELLATION,
    reason: mutationReason("exit_withdrawn"),
  }, { access: accessFor(HR) });
  assert.equal(cancelled.terminatedRunCount, 5);
  assert.equal(h.repository.data.terminations.size, 5);
  assert.equal(h.repository.data.terminations.has(first.run_id), false);
  assert.equal(h.repository.data.steps.get(`${first.run_id}:${first.step_id}`).status, "completed");
  assert.equal([...h.repository.data.runs.values()].every(({ status }) => status === "resolved"), true);
  assert.equal([...h.repository.data.steps.values()].some(({ status }) => status === "skipped"), false);
});
