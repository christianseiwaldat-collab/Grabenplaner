"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const {
  PersonnelWorkflowInstanceError,
  completePersonnelLifecycleOnboardingTaskInTransaction,
  createPersonnelWorkflowInstanceService,
  instantiatePersonnelLifecycleOnboardingInTransaction,
} = require("../lib/personnel-workflow-instances");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("../lib/personnel-workflow-publication-receipt");

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-9222-222222222222";
const COMPLETION_OPERATION_ID = "33333333-3333-4333-a333-333333333333";
const STARTED_AT = "2026-08-02T10:00:00.000Z";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function publicationFixture({
  workflowType = "preboarding",
  workflowCode = "standard.preboarding",
  snapshot,
  archivedAt = null,
} = {}) {
  const workflowSnapshot = snapshot || {
    id: "process-preboarding",
    revision: 3,
    title: "Sicheres Preboarding",
    scope: { type: "company", locationId: null, departmentId: null },
    steps: [
      {
        id: "system-prepare",
        title: "Instanz vorbereiten",
        responsibilityType: "system",
        responsibilityReference: "",
        notificationChannels: [],
      },
      {
        id: "hr-review",
        title: "Unterlagen pruefen",
        description: "Freigegebene Standardunterlagen pruefen.",
        responsibilityType: "role",
        responsibilityReference: "hr",
        notificationChannels: [],
      },
      {
        id: "employee-confirm",
        title: "Empfang bestaetigen",
        responsibilityType: "employee",
        responsibilityReference: "EMP-7",
        notificationChannels: [],
      },
    ],
  };
  const snapshotJson = JSON.stringify(workflowSnapshot);
  const row = {
    id: `publication-${workflowType}`,
    process_id: workflowSnapshot.id,
    source_revision: workflowSnapshot.revision,
    version_number: 2,
    workflow_code: workflowCode,
    workflow_type: workflowType,
    authority_level: "central",
    requirement_kind: "mandatory",
    data_classification: "standard",
    scope_type: workflowSnapshot.scope.type,
    location_id: workflowSnapshot.scope.locationId,
    department_id: workflowSnapshot.scope.departmentId,
    snapshot_json: snapshotJson,
    snapshot_sha256: sha256(snapshotJson),
    published_by: "PL-PLUS",
    published_at: "2026-08-01T09:00:00.000Z",
    archived_at: archivedAt,
  };
  row.receipt_sha256 = sha256(JSON.stringify(personnelWorkflowPublicationReceiptBody(row)));
  return row;
}

function candidateSubject(overrides = {}) {
  return {
    subject_type: "candidate",
    candidate_id: "candidate-1",
    candidate_revision: 4,
    candidate_state: "active",
    application_id: "application-1",
    application_revision: 6,
    application_status: "preboarding",
    location_id: null,
    department_id: null,
    location_active: null,
    department_active: null,
    department_location_id: null,
    ...overrides,
  };
}

function employeeSubject(overrides = {}) {
  return {
    subject_type: "employee",
    employee_number: "EMP-7",
    employee_active: 1,
    location_id: null,
    department_id: null,
    location_active: null,
    department_active: null,
    department_location_id: null,
    ...overrides,
  };
}

function startInput(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    publicationId: "publication-preboarding",
    subject: {
      type: "candidate",
      candidateId: "candidate-1",
      applicationId: "application-1",
      candidateRevision: 4,
      applicationRevision: 6,
    },
    assignments: [
      { stepId: "employee-confirm", employeeNumber: "EMP-7" },
      { stepId: "hr-review", employeeNumber: "HR-1" },
    ],
    ...overrides,
  };
}

function accessFixture(overrides = {}) {
  return {
    actorId: "PL-PLUS",
    canStartScope: () => true,
    canStartCandidateSubject: () => true,
    canStartEmployeeSubject: () => true,
    canAssignPersonnelWorkflowStep: () => true,
    canReadPersonnelWorkflowInstance: () => true,
    canCompletePersonnelWorkflowTask: () => true,
    ...overrides,
  };
}

function repositoryFixture({
  publication = publicationFixture(),
  candidate = candidateSubject(),
  employee = employeeSubject(),
} = {}) {
  const state = {
    publication,
    candidate,
    employee,
    recipients: new Map([
      ["HR-1", {
        employee_number: "HR-1",
        full_name: "Nicht im Response",
        role: "hr",
        home_location_id: null,
        preferred_department_id: null,
        access_scopes: [],
      }],
      ["EMP-7", {
        employee_number: "EMP-7",
        full_name: "Ebenfalls nicht im Response",
        role: "employee",
        home_location_id: null,
        preferred_department_id: null,
        access_scopes: [],
      }],
    ]),
    runs: new Map(),
    bindings: new Map(),
    steps: new Map(),
    assignments: new Map(),
    audits: [],
    writes: [],
    transactionOptions: null,
  };

  function joined(binding) {
    if (!binding) return null;
    const run = state.runs.get(binding.run_id);
    const row = {
      ...run,
      ...binding,
      binding_receipt_sha256: binding.receipt_sha256,
      workflow_code: publication.workflow_code,
      workflow_type: publication.workflow_type,
      version_number: publication.version_number,
      authority_level: publication.authority_level,
      requirement_kind: publication.requirement_kind,
      data_classification: publication.data_classification,
      publication_scope_type: publication.scope_type,
      publication_location_id: publication.location_id,
      publication_department_id: publication.department_id,
      snapshot_json: publication.snapshot_json,
      snapshot_sha256: publication.snapshot_sha256,
      publication_receipt_sha256: publication.receipt_sha256,
      published_by: publication.published_by,
      published_at: publication.published_at,
      publication_archived_at: publication.archived_at,
    };
    return row;
  }

  function stepsFor(runId) {
    return state.steps.get(runId) || [];
  }

  const repository = {
    async workflowPublicationById({ publicationId }) {
      return publicationId === publication.id ? publication : null;
    },
    async personnelWorkflowCandidateSubject() {
      return candidate;
    },
    async personnelWorkflowEmployeeSubject() {
      return employee;
    },
    async responsibilityCandidate({ employeeNumber }) {
      return state.recipients.get(employeeNumber) || null;
    },
    async runBindingByOperationId({ operationId }) {
      return joined([...state.bindings.values()]
        .find((binding) => binding.operation_id === operationId));
    },
    async personnelWorkflowInstanceById({ id }) {
      return joined(state.bindings.get(id));
    },
    async insertRun(value) {
      state.writes.push(`run:${value.id}`);
      state.runs.set(value.id, {
        id: value.id,
        process_id: value.processId,
        process_revision: value.processRevision,
        trigger_type: value.triggerType,
        trigger_key: value.triggerKey,
        status: "open",
        location_id: value.locationId,
        department_id: value.departmentId,
        triggered_by: value.triggeredBy,
        activation_count: 1,
        resolved_at: null,
        created_at: STARTED_AT,
        updated_at: STARTED_AT,
      });
      return { rowsAffected: 1 };
    },
    async insertRunBinding(value) {
      state.writes.push(`binding:${value.runId}`);
      state.bindings.set(value.runId, {
        run_id: value.runId,
        publication_id: value.publicationId,
        operation_id: value.operationId,
        subject_type: value.subjectType,
        candidate_id: value.candidateId,
        application_id: value.applicationId,
        candidate_revision: value.candidateRevision,
        application_revision: value.applicationRevision,
        employee_number: value.employeeNumber,
        request_sha256: value.requestSha256,
        receipt_sha256: value.receiptSha256,
        started_by: value.startedBy,
        started_at: value.startedAt,
      });
      return { rowsAffected: 1 };
    },
    async insertRunStep(value) {
      state.writes.push(`step:${value.stepId}`);
      const rows = stepsFor(value.runId);
      state.steps.set(value.runId, rows);
      rows.push({
        run_id: value.runId,
        step_id: value.stepId,
        sort_order: value.sortOrder,
        status: "pending",
        activated_at: null,
        completed_at: null,
        completed_by: "",
        completion_note: "",
        completion_request_id: "",
      });
      return { rowsAffected: 1 };
    },
    async insertRunStepAssignment(value) {
      state.writes.push(`assignment:${value.stepId}`);
      const rows = state.assignments.get(value.runId) || [];
      state.assignments.set(value.runId, rows);
      rows.push({
        run_id: value.runId,
        step_id: value.stepId,
        employee_number: value.employeeNumber,
        responsibility_type: value.responsibilityType,
        responsibility_reference: value.responsibilityReference,
        assigned_by: value.assignedBy,
        assigned_at: value.assignedAt,
        receipt_sha256: value.receiptSha256,
      });
      return { rowsAffected: 1 };
    },
    async activeRunStep({ runId }) {
      return stepsFor(runId).find(({ status }) => status === "active") || null;
    },
    async pendingRunStep({ runId }) {
      return stepsFor(runId).find(({ status }) => status === "pending") || null;
    },
    async completeSystemRunStep({ runId, stepId }) {
      state.writes.push(`complete:${stepId}`);
      const row = stepsFor(runId).find((step) => step.step_id === stepId);
      if (!row || row.status !== "pending") return { rowsAffected: 0 };
      Object.assign(row, {
        status: "completed",
        activated_at: STARTED_AT,
        completed_at: STARTED_AT,
        completed_by: "system",
      });
      return { rowsAffected: 1 };
    },
    async activateRunStep({ runId, stepId }) {
      state.writes.push(`activate:${stepId}`);
      const row = stepsFor(runId).find((step) => step.step_id === stepId);
      if (!row || row.status !== "pending") return { rowsAffected: 0 };
      Object.assign(row, { status: "active", activated_at: STARTED_AT });
      return { rowsAffected: 1 };
    },
    async resolveRun({ runId }) {
      state.writes.push(`resolve:${runId}`);
      const run = state.runs.get(runId);
      if (!run || run.status !== "open") return { rowsAffected: 0 };
      Object.assign(run, { status: "resolved", resolved_at: STARTED_AT });
      return { rowsAffected: 1 };
    },
    async listActivePersonnelWorkflowTaskRuns({ employeeNumber }) {
      const rows = [];
      for (const binding of state.bindings.values()) {
        const run = state.runs.get(binding.run_id);
        const active = stepsFor(binding.run_id).find(({ status }) => status === "active");
        if (!active || run?.status !== "open") continue;
        const assignment = (state.assignments.get(binding.run_id) || [])
          .find(({ step_id: assignmentStepId, employee_number: assigned }) => (
            assignmentStepId === active.step_id && assigned === employeeNumber
          ));
        if (!assignment) continue;
        rows.push({
          ...joined(binding),
          step_id: active.step_id,
          step_status: active.status,
          activated_at: active.activated_at,
          sort_order: active.sort_order,
          assigned_employee_number: assignment.employee_number,
          assignment_responsibility_type: assignment.responsibility_type,
          assignment_responsibility_reference: assignment.responsibility_reference,
          assignment_assigned_at: assignment.assigned_at,
        });
      }
      return rows;
    },
    async listPersonnelWorkflowInstances() {
      return [...state.bindings.values()].map((binding) => {
        const row = joined(binding);
        const runSteps = stepsFor(binding.run_id);
        const active = runSteps.find(({ status }) => status === "active");
        return {
          ...row,
          active_step_id: active?.step_id || null,
          active_step_status: active?.status || null,
          active_step_sort_order: active?.sort_order || null,
          active_step_activated_at: active?.activated_at || null,
          assigned_employee_number: (state.assignments.get(binding.run_id) || [])
            .find(({ step_id: stepId }) => stepId === active?.step_id)?.employee_number || null,
          finished_steps: runSteps.filter(({ status }) => (
            status === "completed" || status === "skipped"
          )).length,
          total_steps: runSteps.length,
        };
      });
    },
    async listRunStepAssignments({ runId, stepId }) {
      return (state.assignments.get(runId) || [])
        .filter((row) => stepId === null || stepId === undefined || row.step_id === stepId);
    },
    async runStepById({ runId, stepId }) {
      return stepsFor(runId).find((row) => row.step_id === stepId) || null;
    },
    async runStepCounts({ runId }) {
      const rows = stepsFor(runId);
      return {
        total: rows.length,
        finished: rows.filter(({ status }) => (
          status === "completed" || status === "skipped"
        )).length,
      };
    },
    async completeRunStep({ status, actor, note, idempotencyKey, runId, stepId }) {
      state.writes.push(`task-${status}:${stepId}`);
      const row = stepsFor(runId).find((step) => step.step_id === stepId);
      if (!row || row.status !== "active") return { rowsAffected: 0 };
      Object.assign(row, {
        status,
        completed_at: STARTED_AT,
        completed_by: actor,
        completion_note: note,
        completion_request_id: idempotencyKey,
      });
      return { rowsAffected: 1 };
    },
    async insertAudit(value) {
      state.writes.push(`audit:${value.entityId}`);
      state.audits.push(value);
      return { rowsAffected: 1 };
    },
    async transaction(work, options) {
      state.transactionOptions = options;
      return work(repository);
    },
  };
  return { repository, state };
}

function serviceFor(fixture) {
  return createPersonnelWorkflowInstanceService(fixture.repository, {
    now: () => new Date(STARTED_AT),
    randomUUID: () => RUN_ID,
  });
}

function transactionBoundRepository(fixture) {
  const { transaction: _transaction, ...repository } = fixture.repository;
  return repository;
}

function lifecycleOnboardingFixture() {
  return repositoryFixture({
    publication: publicationFixture({
      workflowType: "onboarding",
      workflowCode: "standard.onboarding",
    }),
  });
}

function lifecycleOnboardingInput(overrides = {}) {
  return startInput({
    publicationId: "publication-onboarding",
    subject: { type: "employee", employeeNumber: "EMP-7" },
    ...overrides,
  });
}

test("M5 startet atomar, friert exakte Zuordnungen ein und aktiviert den ersten Fachschritt", async () => {
  const fixture = repositoryFixture();
  let assignmentContext;
  const access = accessFixture({
    canAssignPersonnelWorkflowStep(context) {
      assignmentContext = context;
      return true;
    },
  });
  const result = await serviceFor(fixture).start(startInput(), { access });

  assert.equal(result.replayed, false);
  assert.deepEqual(fixture.state.transactionOptions, { isolation: "serializable" });
  assert.deepEqual(fixture.state.writes, [
    `run:${RUN_ID}`,
    `binding:${RUN_ID}`,
    "step:system-prepare",
    "step:hr-review",
    "step:employee-confirm",
    "assignment:hr-review",
    "assignment:employee-confirm",
    "complete:system-prepare",
    "activate:hr-review",
    `audit:${RUN_ID}`,
  ]);
  assert.equal(assignmentContext.recipient.employee_number, "EMP-7");
  assert.deepEqual(result.instance.progress, { completedSteps: 1, totalSteps: 3 });
  assert.equal(result.instance.activeStep.id, "hr-review");
  assert.equal(Object.isFrozen(result.instance), true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("candidate-1"), false);
  assert.equal(serialized.includes("application-1"), false);
  assert.equal(serialized.includes("HR-1"), false);
  assert.equal(serialized.includes("EMP-7"), false);

  const binding = fixture.state.bindings.get(RUN_ID);
  assert.equal(binding.candidate_revision, 4);
  assert.equal(binding.application_revision, 6);
  assert.match(binding.request_sha256, /^[0-9a-f]{64}$/);
  assert.match(binding.receipt_sha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.state.runs.get(RUN_ID).trigger_key, `personnel:${OPERATION_ID}`);
  assert.equal(fixture.state.audits[0].detail.includes("candidate-1"), false);
});

test("M5 stellt Lifecycle-Onboarding transaktionsgebunden zwischen Run und Binding bereit", async () => {
  const fixture = lifecycleOnboardingFixture();
  let lifecycleBinding;
  const result = await instantiatePersonnelLifecycleOnboardingInTransaction(
    transactionBoundRepository(fixture),
    lifecycleOnboardingInput(),
    {
      access: accessFixture(),
      now: () => new Date(STARTED_AT),
      randomUUID: () => RUN_ID,
      async bindLifecyclePackageRun(value) {
        lifecycleBinding = value;
        fixture.state.writes.push(`lifecycle:${value.runId}`);
      },
    },
  );

  assert.equal(result.replayed, false);
  assert.deepEqual(fixture.state.writes, [
    `run:${RUN_ID}`,
    `lifecycle:${RUN_ID}`,
    `binding:${RUN_ID}`,
    "step:system-prepare",
    "step:hr-review",
    "step:employee-confirm",
    "assignment:hr-review",
    "assignment:employee-confirm",
    "complete:system-prepare",
    "activate:hr-review",
    `audit:${RUN_ID}`,
  ]);
  assert.deepEqual(lifecycleBinding, {
    runId: RUN_ID,
    runOperationId: OPERATION_ID,
    publicationId: "publication-onboarding",
    employeeNumber: "EMP-7",
    requestSha256: fixture.state.bindings.get(RUN_ID).request_sha256,
    instanceReceiptSha256: fixture.state.bindings.get(RUN_ID).receipt_sha256,
    startedBy: "PL-PLUS",
    startedAt: STARTED_AT,
  });
  assert.equal(Object.isFrozen(lifecycleBinding), true);
  assert.equal(result.instance.publication.workflowType, "onboarding");
  assert.equal(result.instance.subject.type, "employee");
});

test("M5 Lifecycle-Onboarding spielt exakt wieder ab, ohne die Paketbindung erneut aufzurufen", async () => {
  const fixture = lifecycleOnboardingFixture();
  const repository = transactionBoundRepository(fixture);
  let bindingCalls = 0;
  const options = {
    access: accessFixture(),
    now: () => new Date(STARTED_AT),
    randomUUID: () => RUN_ID,
    bindLifecyclePackageRun() {
      bindingCalls += 1;
    },
  };
  await instantiatePersonnelLifecycleOnboardingInTransaction(
    repository,
    lifecycleOnboardingInput(),
    options,
  );
  const writesAfterStart = [...fixture.state.writes];

  const replayed = await instantiatePersonnelLifecycleOnboardingInTransaction(
    repository,
    lifecycleOnboardingInput({
      assignments: [
        { stepId: "hr-review", employeeNumber: "HR-1" },
        { stepId: "employee-confirm", employeeNumber: "EMP-7" },
      ],
    }),
    options,
  );

  assert.equal(replayed.replayed, true);
  assert.equal(bindingCalls, 1);
  assert.deepEqual(fixture.state.writes, writesAfterStart);
});

test("M5 schliesst Lifecycle-Onboarding-Aufgaben mit atomarem Ergebnisbeleg und exaktem Replay ab", async () => {
  const fixture = lifecycleOnboardingFixture();
  const repository = transactionBoundRepository(fixture);
  await instantiatePersonnelLifecycleOnboardingInTransaction(
    repository,
    lifecycleOnboardingInput(),
    {
      access: accessFixture(),
      now: () => new Date(STARTED_AT),
      randomUUID: () => RUN_ID,
      bindLifecyclePackageRun() {},
    },
  );
  fixture.state.writes.length = 0;
  let taskOutcome;
  let outcomeCalls = 0;
  const options = {
    access: accessFixture({ actorId: "HR-1" }),
    recordLifecycleTaskOutcome(value) {
      outcomeCalls += 1;
      taskOutcome = value;
      fixture.state.writes.push(`lifecycle-task:${value.stepId}`);
    },
  };

  const completed = await completePersonnelLifecycleOnboardingTaskInTransaction(
    repository,
    "HR-1",
    RUN_ID,
    "hr-review",
    { action: "complete", operationId: COMPLETION_OPERATION_ID },
    options,
  );

  assert.equal(completed.replayed, false);
  assert.deepEqual(fixture.state.writes, [
    "task-completed:hr-review",
    "lifecycle-task:hr-review",
    "activate:employee-confirm",
    `audit:${RUN_ID}`,
  ]);
  assert.deepEqual(taskOutcome, {
    runId: RUN_ID,
    taskOperationId: COMPLETION_OPERATION_ID,
    publicationId: "publication-onboarding",
    employeeNumber: "EMP-7",
    stepId: "hr-review",
    action: "complete",
    completedStatus: "completed",
    completionRequestSha256: fixture.state.steps.get(RUN_ID)[1].completion_request_id,
    completedBy: "HR-1",
    completedAt: STARTED_AT,
  });
  assert.equal(Object.isFrozen(taskOutcome), true);

  const writesAfterCompletion = [...fixture.state.writes];
  const replayed = await completePersonnelLifecycleOnboardingTaskInTransaction(
    repository,
    "HR-1",
    RUN_ID,
    "hr-review",
    { action: "complete", operationId: COMPLETION_OPERATION_ID },
    options,
  );
  assert.equal(replayed.replayed, true);
  assert.equal(outcomeCalls, 1);
  assert.deepEqual(fixture.state.writes, writesAfterCompletion);
});

test("M5 Lifecycle-Onboarding verlangt eine fremdgeführte Transaktion und Pflichtbindung", async () => {
  const fixture = lifecycleOnboardingFixture();
  const options = {
    access: accessFixture(),
    bindLifecyclePackageRun() {},
  };

  await assert.rejects(
    instantiatePersonnelLifecycleOnboardingInTransaction(
      fixture.repository,
      lifecycleOnboardingInput(),
      options,
    ),
    (error) => error instanceof TypeError
      && error.message.includes("bereits transaktionsgebundenes Repository"),
  );
  await assert.rejects(
    instantiatePersonnelLifecycleOnboardingInTransaction(
      transactionBoundRepository(fixture),
      lifecycleOnboardingInput(),
      { access: accessFixture() },
    ),
    (error) => error instanceof TypeError
      && error.message.includes("Paket-Run-Bindung"),
  );
  assert.deepEqual(fixture.state.writes, []);
});

test("M5 haelt Lifecycle-Onboarding ausserhalb der Primitive in allen generischen Wegen gesperrt", async () => {
  const genericStartFixture = lifecycleOnboardingFixture();
  await assert.rejects(
    serviceFor(genericStartFixture).start(lifecycleOnboardingInput(), {
      access: accessFixture(),
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_TYPE_DEFERRED",
  );

  const lifecycleFixture = lifecycleOnboardingFixture();
  await instantiatePersonnelLifecycleOnboardingInTransaction(
    transactionBoundRepository(lifecycleFixture),
    lifecycleOnboardingInput(),
    {
      access: accessFixture(),
      now: () => new Date(STARTED_AT),
      randomUUID: () => RUN_ID,
      bindLifecyclePackageRun() {},
    },
  );
  const genericService = serviceFor(lifecycleFixture);
  await assert.rejects(
    genericService.list({ access: accessFixture() }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_TYPE_DEFERRED",
  );
  await assert.rejects(
    genericService.tasksForEmployee("HR-1", {
      access: accessFixture({ actorId: "HR-1" }),
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_TYPE_DEFERRED",
  );
  await assert.rejects(
    genericService.completeTask(
      "HR-1",
      RUN_ID,
      "hr-review",
      { action: "complete", operationId: COMPLETION_OPERATION_ID },
      { access: accessFixture({ actorId: "HR-1" }) },
    ),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_TYPE_DEFERRED",
  );
});

test("M5 schliesst eine reine Systemschrittfolge vor dem Commit vollstaendig ab", async () => {
  const snapshot = {
    id: "process-system-only",
    revision: 1,
    title: "Systemfolge",
    scope: { type: "company", locationId: null, departmentId: null },
    steps: [
      {
        id: "system-one",
        title: "System eins",
        responsibilityType: "system",
        responsibilityReference: "",
        notificationChannels: [],
      },
      {
        id: "system-two",
        title: "System zwei",
        responsibilityType: "system",
        responsibilityReference: "",
        notificationChannels: [],
      },
    ],
  };
  const fixture = repositoryFixture({ publication: publicationFixture({ snapshot }) });
  const result = await serviceFor(fixture).start(startInput({
    publicationId: "publication-preboarding",
    assignments: [],
  }), { access: accessFixture() });

  assert.equal(result.instance.status, "resolved");
  assert.equal(result.instance.activeStep, null);
  assert.deepEqual(result.instance.progress, { completedSteps: 2, totalSteps: 2 });
  assert.deepEqual(fixture.state.writes.slice(-4), [
    "complete:system-one",
    "complete:system-two",
    `resolve:${RUN_ID}`,
    `audit:${RUN_ID}`,
  ]);
});

test("M5 startet freigegebene Mitarbeiterworkflows nur im aktiven exakten Fachscope", async () => {
  const snapshot = {
    id: "process-training",
    revision: 2,
    title: "Training",
    scope: { type: "department", locationId: "LOC-1", departmentId: 12 },
    steps: [{
      id: "training-review",
      title: "Training freigeben",
      responsibilityType: "role",
      responsibilityReference: "hr",
      notificationChannels: [],
    }],
  };
  const fixture = repositoryFixture({
    publication: publicationFixture({
      workflowType: "training",
      workflowCode: "standard.training",
      snapshot,
    }),
    employee: employeeSubject({
      location_id: "LOC-1",
      department_id: 12,
      location_active: 1,
      department_active: 1,
      department_location_id: "LOC-1",
    }),
  });
  let checkedSubject;
  const result = await serviceFor(fixture).start(startInput({
    publicationId: "publication-training",
    subject: { type: "employee", employeeNumber: "EMP-7" },
    assignments: [{ stepId: "training-review", employeeNumber: "HR-1" }],
  }), {
    access: accessFixture({
      canStartEmployeeSubject(subject, publication) {
        checkedSubject = { subject, publication };
        return subject.scope.departmentId === 12 && publication.workflowType === "training";
      },
    }),
  });

  assert.deepEqual(result.instance.scope, {
    type: "department",
    locationId: "LOC-1",
    departmentId: 12,
  });
  assert.equal(result.instance.subject.type, "employee");
  assert.equal(checkedSubject.subject.employeeNumber, "EMP-7");
  const binding = fixture.state.bindings.get(RUN_ID);
  assert.equal(binding.employee_number, "EMP-7");
  assert.equal(binding.candidate_revision, null);
  assert.equal(binding.application_revision, null);
});

test("M5 liefert bei semantisch identischem UUIDv4-Auftrag exaktes Replay und sperrt Abweichungen", async () => {
  const fixture = repositoryFixture();
  const service = serviceFor(fixture);
  let assignmentChecks = 0;
  const checkedSubjects = [];
  const access = accessFixture({
    canStartCandidateSubject(subject) {
      checkedSubjects.push(subject);
      return true;
    },
    canAssignPersonnelWorkflowStep() {
      assignmentChecks += 1;
      return true;
    },
  });
  await service.start(startInput(), { access });
  const writesAfterStart = fixture.state.writes.length;
  assert.equal(assignmentChecks, 2);

  Object.assign(fixture.state.candidate, {
    candidate_revision: 99,
    application_revision: 101,
    candidate_state: "archived",
    application_status: "converted",
    location_id: "DRIFTED",
    location_active: 0,
  });
  fixture.state.recipients.clear();
  fixture.state.publication.archived_at = "2026-08-03T10:00:00.000Z";

  const replayed = await service.start(startInput({
    assignments: [
      { stepId: "hr-review", employeeNumber: "HR-1" },
      { stepId: "employee-confirm", employeeNumber: "EMP-7" },
    ],
  }), { access });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.instance.id, RUN_ID);
  assert.equal(fixture.state.writes.length, writesAfterStart);
  assert.equal(assignmentChecks, 2);
  assert.equal(checkedSubjects.length, 2);
  assert.deepEqual(checkedSubjects[1], {
    type: "candidate",
    candidateId: "candidate-1",
    applicationId: "application-1",
    candidateRevision: 4,
    applicationRevision: 6,
    scope: { type: "company", locationId: null, departmentId: null },
  });

  await assert.rejects(
    service.start(startInput({
      assignments: [
        { stepId: "hr-review", employeeNumber: "EMP-7" },
        { stepId: "employee-confirm", employeeNumber: "EMP-7" },
      ],
    }), {
      access: accessFixture({ canStartScope: () => false }),
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND"
      && error.kind === "not_found",
  );

  await assert.rejects(
    service.start(startInput({
      assignments: [
        { stepId: "hr-review", employeeNumber: "EMP-7" },
        { stepId: "employee-confirm", employeeNumber: "EMP-7" },
      ],
    }), { access }),
    (error) => error instanceof PersonnelWorkflowInstanceError
      && error.code === "PERSONNEL_WORKFLOW_INSTANCE_OPERATION_CONFLICT"
      && error.kind === "conflict",
  );
});

test("M5 erzwingt Subject-Matrix, Revisionen und die aufgeschobenen Workflow-Grenzen", async () => {
  const stale = repositoryFixture({ candidate: candidateSubject({ candidate_revision: 5 }) });
  await assert.rejects(
    serviceFor(stale).start(startInput(), { access: accessFixture() }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_REVISION_CONFLICT",
  );

  const wrongMatrix = repositoryFixture({
    publication: publicationFixture({
      workflowType: "training",
      workflowCode: "standard.training",
    }),
  });
  await assert.rejects(
    serviceFor(wrongMatrix).start(startInput({ publicationId: "publication-training" }), {
      access: accessFixture(),
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_SUBJECT_TYPE_INVALID",
  );

  const custom = repositoryFixture({
    publication: publicationFixture({
      workflowType: "custom_personnel",
      workflowCode: "standard.custom-personnel",
    }),
  });
  await assert.rejects(
    serviceFor(custom).start(startInput({
      publicationId: "publication-custom_personnel",
      subject: { type: "employee", employeeNumber: "EMP-7" },
    }), { access: accessFixture() }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_TYPE_DEFERRED",
  );
});

test("M5 akzeptiert nur den booleschen Wert true und aktive persoenliche Empfaenger", async () => {
  const denied = repositoryFixture();
  await assert.rejects(
    serviceFor(denied).start(startInput(), {
      access: accessFixture({ canStartScope: () => 1 }),
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND"
      && error.kind === "not_found",
  );

  const missingRecipient = repositoryFixture();
  missingRecipient.state.recipients.delete("HR-1");
  await assert.rejects(
    serviceFor(missingRecipient).start(startInput(), { access: accessFixture() }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_ASSIGNMENT_NOT_FOUND"
      && error.kind === "not_found",
  );

  const unknownField = repositoryFixture();
  await assert.rejects(
    serviceFor(unknownField).start({ ...startInput(), startedBy: "forged" }, {
      access: accessFixture(),
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_INPUT_INVALID",
  );
  assert.equal(unknownField.state.transactionOptions, null);
});

test("M5 bindet den Starter an den Access-Actor und prueft den Startaudit fail-closed", async () => {
  const forged = repositoryFixture();
  await assert.rejects(
    serviceFor(forged).start(startInput(), {
      access: accessFixture(),
      actorId: "FORGED-ACTOR",
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_PERMISSION_REQUIRED"
      && error.kind === "forbidden",
  );
  assert.equal(forged.state.transactionOptions, null);
  assert.deepEqual(forged.state.writes, []);

  const missingAudit = repositoryFixture();
  missingAudit.repository.insertAudit = async () => ({ rowsAffected: 0 });
  await assert.rejects(
    serviceFor(missingAudit).start(startInput(), { access: accessFixture() }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_INTEGRITY_FAILED"
      && error.kind === "integrity",
  );
});

test("M5 prueft fremde Publication-/Subject-Scopes erst hinter der IDOR-Schranke", async () => {
  const scopedSnapshot = JSON.parse(publicationFixture().snapshot_json);
  scopedSnapshot.scope = { type: "location", locationId: "PUB-LOC", departmentId: null };
  const fixture = repositoryFixture({
    publication: publicationFixture({ snapshot: scopedSnapshot }),
    candidate: candidateSubject({
      location_id: "SUBJECT-LOC",
      location_active: 1,
    }),
  });
  const service = serviceFor(fixture);
  let scopeChecks = 0;
  await assert.rejects(
    service.start(startInput(), {
      access: accessFixture({
        canStartScope(scope, publication) {
          scopeChecks += 1;
          assert.equal(scope.locationId, "SUBJECT-LOC");
          assert.equal(publication.scope.locationId, "PUB-LOC");
          return false;
        },
      }),
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_NOT_FOUND"
      && error.kind === "not_found",
  );
  assert.equal(scopeChecks, 1);

  await assert.rejects(
    service.start(startInput(), { access: accessFixture() }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_SCOPE_MISMATCH"
      && error.kind === "conflict",
  );
  assert.equal(fixture.state.writes.length, 0);
});

test("M5 projiziert nur die eigene aktive Aufgabe ohne Fachobjekt- oder Assignmentdaten", async () => {
  const fixture = repositoryFixture();
  const service = serviceFor(fixture);
  await service.start(startInput(), { access: accessFixture() });
  let completionContext;
  const taskAccess = accessFixture({
    actorId: "HR-1",
    canCompletePersonnelWorkflowTask(context) {
      completionContext = context;
      return true;
    },
  });
  const result = await service.tasksForEmployee("HR-1", { access: taskAccess });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    runId: RUN_ID,
    subjectType: "candidate",
    workflowCode: "standard.preboarding",
    versionNumber: 2,
    workflowTitle: "Sicheres Preboarding",
    step: {
      id: "hr-review",
      title: "Unterlagen pruefen",
      position: 2,
      canSkip: false,
      activatedAt: STARTED_AT,
    },
    progress: { completedSteps: 1, totalSteps: 3 },
    scope: { type: "company", locationId: null, departmentId: null },
  });
  assert.equal(completionContext.assignment.employeeNumber, "HR-1");
  assert.equal(completionContext.instance.subjectType, "candidate");
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "candidate-1", "application-1", "HR-1", "EMP-7", "requestSha256",
    "receiptSha256", "snapshot", "assignedBy", "responsibilityReference",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);

  fixture.state.recipients.get("HR-1").role = "manager";
  assert.deepEqual(
    await service.tasksForEmployee("HR-1", { access: taskAccess }),
    { items: [] },
  );
  await assert.rejects(
    service.tasksForEmployee("HR-1", {
      access: accessFixture({ actorId: "EMP-7" }),
    }),
    (error) => error.code === "PERSONNEL_WORKFLOW_TASK_PERMISSION_REQUIRED",
  );
});

test("M5 schliesst Self-Tasks idempotent ab und setzt ohne Notifications fort", async () => {
  const fixture = repositoryFixture();
  const service = serviceFor(fixture);
  await service.start(startInput(), { access: accessFixture() });
  let authorizationChecks = 0;
  const taskAccess = accessFixture({
    actorId: "HR-1",
    canCompletePersonnelWorkflowTask() {
      authorizationChecks += 1;
      return true;
    },
  });
  const input = { action: "complete", operationId: COMPLETION_OPERATION_ID };
  const completed = await service.completeTask(
    "HR-1",
    RUN_ID,
    "hr-review",
    input,
    { access: taskAccess },
  );

  assert.deepEqual(completed, {
    runId: RUN_ID,
    stepId: "hr-review",
    status: "completed",
    resolved: false,
    progress: { completedSteps: 2, totalSteps: 3 },
    replayed: false,
  });
  assert.equal(authorizationChecks, 1);
  assert.equal(
    fixture.state.steps.get(RUN_ID).find(({ step_id: id }) => id === "employee-confirm").status,
    "active",
  );
  const completedState = fixture.state.steps.get(RUN_ID)
    .find(({ step_id: id }) => id === "hr-review");
  assert.match(completedState.completion_request_id, /^[0-9a-f]{64}$/);
  assert.equal(completedState.completion_request_id.includes(COMPLETION_OPERATION_ID), false);
  assert.equal(completedState.completion_note, "");
  assert.deepEqual(fixture.state.writes.slice(-3), [
    "task-completed:hr-review",
    "activate:employee-confirm",
    `audit:${RUN_ID}`,
  ]);
  const audit = fixture.state.audits.at(-1);
  for (const forbidden of ["candidate-1", "application-1", "HR-1", "EMP-7"]) {
    assert.equal(audit.detail.includes(forbidden), false);
  }

  const writesAfterCompletion = fixture.state.writes.length;
  fixture.state.recipients.get("HR-1").role = "manager";
  const replayed = await service.completeTask(
    "HR-1",
    RUN_ID,
    "hr-review",
    input,
    {
      access: accessFixture({
        actorId: "HR-1",
        canCompletePersonnelWorkflowTask() {
          throw new Error("Replay darf keine Live-Autorisierung ausfuehren.");
        },
      }),
    },
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.status, "completed");
  assert.equal(fixture.state.writes.length, writesAfterCompletion);
  assert.equal(authorizationChecks, 1);

  completedState.completion_note = "unerlaubter Altinhalt";
  await assert.rejects(
    service.completeTask(
      "HR-1",
      RUN_ID,
      "hr-review",
      input,
      { access: taskAccess },
    ),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_INTEGRITY_FAILED"
      && error.kind === "integrity",
  );
  completedState.completion_note = "";

  await assert.rejects(
    service.completeTask(
      "HR-1",
      RUN_ID,
      "hr-review",
      { action: "complete", operationId: "44444444-4444-4444-b444-444444444444" },
      { access: taskAccess },
    ),
    (error) => error.code === "PERSONNEL_WORKFLOW_TASK_OPERATION_CONFLICT"
      && error.kind === "conflict",
  );
});

test("M5 verarbeitet nach Self-Completion folgende Systemschritte und loest den Run auf", async () => {
  const snapshot = JSON.parse(publicationFixture().snapshot_json);
  snapshot.steps = [
    snapshot.steps[0],
    snapshot.steps[1],
    {
      id: "system-finish",
      title: "Systemabschluss",
      responsibilityType: "system",
      responsibilityReference: "",
      conditionType: "always",
      notificationChannels: [],
    },
  ];
  const fixture = repositoryFixture({
    publication: publicationFixture({ snapshot }),
  });
  const service = serviceFor(fixture);
  await service.start(startInput({
    assignments: [{ stepId: "hr-review", employeeNumber: "HR-1" }],
  }), { access: accessFixture() });
  const result = await service.completeTask(
    "HR-1",
    RUN_ID,
    "hr-review",
    { action: "complete", operationId: COMPLETION_OPERATION_ID },
    { access: accessFixture({ actorId: "HR-1" }) },
  );

  assert.equal(result.resolved, true);
  assert.deepEqual(result.progress, { completedSteps: 3, totalSteps: 3 });
  assert.deepEqual(fixture.state.writes.slice(-4), [
    "task-completed:hr-review",
    "complete:system-finish",
    `resolve:${RUN_ID}`,
    `audit:${RUN_ID}`,
  ]);
});

test("M5 prueft Live-Rolle, persoenlichen Zugang und Skip-Regel vor der Erstbearbeitung", async () => {
  const denied = repositoryFixture();
  const deniedService = serviceFor(denied);
  await deniedService.start(startInput(), { access: accessFixture() });
  await assert.rejects(
    deniedService.completeTask(
      "HR-1",
      RUN_ID,
      "hr-review",
      { action: "complete", operationId: "not-a-uuid" },
      { access: accessFixture({ actorId: "HR-1" }) },
    ),
    (error) => error.code === "PERSONNEL_WORKFLOW_TASK_OPERATION_ID_INVALID"
      && error.kind === "input",
  );
  denied.state.recipients.get("HR-1").role = "manager";
  await assert.rejects(
    deniedService.completeTask(
      "HR-1",
      RUN_ID,
      "hr-review",
      { action: "complete", operationId: COMPLETION_OPERATION_ID },
      { access: accessFixture({ actorId: "HR-1" }) },
    ),
    (error) => error.code === "PERSONNEL_WORKFLOW_TASK_PERMISSION_REQUIRED"
      && error.kind === "forbidden",
  );
  const activeRecipient = denied.state.recipients.get("HR-1");
  activeRecipient.role = "hr";
  await assert.rejects(
    deniedService.completeTask(
      "HR-1",
      RUN_ID,
      "hr-review",
      { action: "complete", operationId: COMPLETION_OPERATION_ID },
      {
        access: accessFixture({
          actorId: "HR-1",
          canCompletePersonnelWorkflowTask: () => 1,
        }),
      },
    ),
    (error) => error.code === "PERSONNEL_WORKFLOW_TASK_PERMISSION_REQUIRED",
  );
  denied.state.recipients.delete("HR-1");
  await assert.rejects(
    deniedService.completeTask(
      "HR-1",
      RUN_ID,
      "hr-review",
      { action: "complete", operationId: COMPLETION_OPERATION_ID },
      { access: accessFixture({ actorId: "HR-1" }) },
    ),
    (error) => error.code === "PERSONNEL_WORKFLOW_TASK_PERMISSION_REQUIRED",
  );
  denied.state.recipients.set("HR-1", activeRecipient);
  await assert.rejects(
    deniedService.completeTask(
      "HR-1",
      RUN_ID,
      "hr-review",
      { action: "skip", operationId: COMPLETION_OPERATION_ID },
      { access: accessFixture({ actorId: "HR-1" }) },
    ),
    (error) => error.code === "PERSONNEL_WORKFLOW_TASK_SKIP_FORBIDDEN"
      && error.kind === "input",
  );

  const optionalSnapshot = JSON.parse(publicationFixture().snapshot_json);
  optionalSnapshot.steps[1].conditionType = "optional";
  const optional = repositoryFixture({
    publication: publicationFixture({ snapshot: optionalSnapshot }),
  });
  const optionalService = serviceFor(optional);
  await optionalService.start(startInput(), { access: accessFixture() });
  const skipped = await optionalService.completeTask(
    "HR-1",
    RUN_ID,
    "hr-review",
    { action: "skip", operationId: COMPLETION_OPERATION_ID },
    { access: accessFixture({ actorId: "HR-1" }) },
  );
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.replayed, false);
});

test("M5 listet nur lesbare, belegte und datenminimierte Instanzen", async () => {
  const fixture = repositoryFixture();
  const service = serviceFor(fixture);
  await service.start(startInput(), { access: accessFixture() });

  const hidden = await service.list({
    access: accessFixture({ canReadPersonnelWorkflowInstance: () => false }),
  });
  assert.deepEqual(hidden, { instances: [] });

  const visible = await service.list({ access: accessFixture() });
  assert.equal(visible.instances.length, 1);
  assert.equal(visible.instances[0].subject.type, "candidate");
  assert.equal(JSON.stringify(visible).includes("candidate-1"), false);
  assert.equal(JSON.stringify(visible).includes("HR-1"), false);
  assert.equal(Object.isFrozen(visible.instances), true);

  fixture.state.assignments.get(RUN_ID)[0].receipt_sha256 = "0".repeat(64);
  await assert.rejects(
    service.list({ access: accessFixture() }),
    (error) => error.code === "PERSONNEL_WORKFLOW_INSTANCE_INTEGRITY_FAILED"
      && error.kind === "integrity",
  );
});
