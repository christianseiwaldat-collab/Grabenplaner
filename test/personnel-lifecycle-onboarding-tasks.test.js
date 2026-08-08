"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPersonnelLifecycleOnboardingTaskService,
} = require("../lib/personnel-lifecycle-onboarding-tasks");
const {
  completePersonnelLifecycleOnboardingTaskInTransaction,
} = require("../lib/personnel-workflow-instances");
const {
  canonicalSha256,
  personnelLifecycleAssignmentBindingReceiptBody,
  personnelLifecycleAssignmentReceiptBody,
  personnelLifecycleCaseEventReceiptBody,
  personnelLifecyclePackageBindingReceiptBody,
  personnelLifecyclePackageRunReceiptBody,
  sha256,
} = require("../lib/personnel-lifecycle-onboarding-receipt");
const {
  personnelWorkflowInstanceReceiptBody,
  personnelWorkflowTaskAssignmentReceiptBody,
} = require("../lib/personnel-workflow-instance-receipt");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("../lib/personnel-workflow-publication-receipt");
const {
  createCustomProcessManagementRepository,
} = require("../lib/persistence/repositories/custom-process-management");
const {
  SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
} = require("../lib/persistence/sqlite/custom-process-management-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  ensureSqlitePersonnelLifecycleOnboardingSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-onboarding-schema");
const {
  ensureSqlitePersonnelWorkflowInstanceSchema,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-instance-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

const LOCATION = "O4-TASK-LOC";
const DEPARTMENT = 9421;
const EMPLOYEE = "EMP-O4-TASK";
const ACTOR = "HR-O4-TASK";
const OTHER = "OTHER-O4-TASK";
const CASE_ID = "case-o4-task";
const EPISODE_ID = "episode-o4-task";
const PROCESS_ID = "process-o4-task";
const PUBLICATION_ID = "publication-o4-task";
const PACKAGE_ID = "package-o4-task";
const RUN_ID = "run-o4-task";
const STEP_ID = "step-o4-task";
const ASSIGNMENT_ID = "assignment-o4-task";
const RUN_OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CLOSE_OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const T1 = "2026-08-03T11:00:00.000Z";
const T2 = "2026-08-03T11:01:00.000Z";
const T3 = "2026-08-03T11:02:00.000Z";
const T4 = "2026-08-03T11:03:00.000Z";

function protectedValue(value, context) {
  return `enc:v2:${Buffer.from(JSON.stringify({ context, value }), "utf8").toString("base64url")}`;
}

function parsedProtectedValue(value, context) {
  const parsed = JSON.parse(Buffer.from(String(value).slice("enc:v2:".length), "base64url"));
  assert.deepEqual(parsed.context, context);
  return parsed.value;
}

function accessFixture(actorId = ACTOR, overrides = {}) {
  return {
    actorId,
    namedActor: true,
    personalEmployee: true,
    canReadOperational: true,
    canUpdateOperational: true,
    canCloseOnboarding: true,
    canReadOperationalScope: ({ scope }) => (
      scope.locationId === LOCATION && scope.departmentId === DEPARTMENT
    ),
    canUpdateOperationalScope: ({ scope }) => (
      scope.locationId === LOCATION && scope.departmentId === DEPARTMENT
    ),
    canAuthorizeTransition: (caseType, fromState, toState) => (
      caseType === "onboarding" && fromState === "active" && toState === "completed"
    ),
    ...overrides,
  };
}

function createService(context, overrides = {}) {
  return createPersonnelLifecycleOnboardingTaskService(context.repository, {
    completePersonnelLifecycleOnboardingTaskInTransaction,
    protectJson: protectedValue,
    parseProtectedJson: parsedProtectedValue,
    now: () => new Date(T4),
    ...overrides,
  });
}

async function createFixture({ conditionType = "always" } = {}) {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active)
      VALUES ('${LOCATION}', 'O4 Aufgabenstandort', 1);
    INSERT INTO departments (id, location_id, name, active)
      VALUES (${DEPARTMENT}, '${LOCATION}', 'O4 Aufgabenabteilung', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES
      ('${EMPLOYEE}', 'O4 Zielperson', 'Ziel', '${LOCATION}', ${DEPARTMENT}, 1),
      ('${ACTOR}', 'O4 Aufgabenperson', 'Aufgabe', '${LOCATION}', ${DEPARTMENT}, 1),
      ('${OTHER}', 'O4 Fremdperson', 'Fremd', '${LOCATION}', ${DEPARTMENT}, 1);
    INSERT INTO portal_roles (id, name, builtin, permissions)
      VALUES ('hr', 'Personalstelle', 1, '["personnel:workflows:read"]')
      ON CONFLICT(id) DO UPDATE SET permissions = excluded.permissions;
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password
    ) VALUES
      ('${ACTOR}', 'test-only', 'hr', 1, 0),
      ('${OTHER}', 'test-only', 'hr', 1, 0);
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES
        ('${ACTOR}', 'personnel:workflows:read', '${ACTOR}'),
        ('${OTHER}', 'personnel:workflows:read', '${ACTOR}');
  `);
  ensureSqlitePersonnelLifecycleOnboardingSchema(application.database);
  ensureSqlitePersonnelWorkflowInstanceSchema(application.database);
  const repository = createCustomProcessManagementRepository(application.provider);
  const context = {
    ...application,
    repository,
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
  await insertActiveTask(context, { conditionType });
  return context;
}

async function insertEvent(repository, {
  id,
  sequenceNumber,
  eventType,
  previousReceiptSha256,
  occurredAt,
}) {
  const protectedPayload = protectedValue({ schemaVersion: 1, eventType }, {
    namespace: "personnel-lifecycle-case-event",
    recordId: id,
    field: "payload",
    employeeNumber: EMPLOYEE,
  });
  const event = {
    id,
    case_id: CASE_ID,
    sequence_number: sequenceNumber,
    event_type: eventType,
    data_classification: "personal_restricted",
    protected_payload: protectedPayload,
    previous_receipt_sha256: previousReceiptSha256,
    actor_id: ACTOR,
    occurred_at: occurredAt,
  };
  event.receipt_sha256 = canonicalSha256(personnelLifecycleCaseEventReceiptBody(event));
  await repository.insertLifecycleCaseEvent({
    id,
    caseId: CASE_ID,
    sequenceNumber,
    eventType,
    dataClassification: event.data_classification,
    protectedPayload,
    previousReceiptSha256,
    receiptSha256: event.receipt_sha256,
    actor: ACTOR,
    occurredAt,
  });
  return event.receipt_sha256;
}

async function insertActiveTask(context, { conditionType }) {
  const { repository } = context;
  const snapshotJson = JSON.stringify({
    id: PROCESS_ID,
    revision: 1,
    title: "O4 Aufgabenpaket",
    scope: { type: "company", locationId: null, departmentId: null },
    steps: [{
      id: STEP_ID,
      type: "actor",
      title: "Personalunterlagen bestaetigen",
      description: "",
      responsibilityType: "employee",
      responsibilityReference: ACTOR,
      responsibilityLabel: "Personalstelle",
      conditionType,
      conditionText: "",
      notificationChannels: [],
    }],
  });
  await repository.insertProcess({
    id: PROCESS_ID,
    title: "O4 Aufgabenpaket",
    symbol: "O4",
    description: "O4 Aufgabentest",
    category: "other",
    scopeType: "company",
    locationId: null,
    departmentId: null,
    triggerType: "manual",
    triggerMinimumShortfall: 1,
    status: "active",
    actor: ACTOR,
  });
  await repository.insertProcessRevision({
    processId: PROCESS_ID,
    revision: 1,
    snapshotJson,
    actor: ACTOR,
  });
  const publication = {
    id: PUBLICATION_ID,
    process_id: PROCESS_ID,
    source_revision: 1,
    version_number: 1,
    workflow_code: "onboarding.o4.task",
    workflow_type: "onboarding",
    authority_level: "central",
    requirement_kind: "mandatory",
    data_classification: "standard",
    scope_type: "company",
    location_id: null,
    department_id: null,
    snapshot_json: snapshotJson,
    snapshot_sha256: sha256(snapshotJson),
    published_by: ACTOR,
    published_at: T1,
  };
  publication.receipt_sha256 = sha256(JSON.stringify(
    personnelWorkflowPublicationReceiptBody(publication),
  ));
  await repository.insertWorkflowPublication({
    id: publication.id,
    processId: publication.process_id,
    sourceRevision: publication.source_revision,
    versionNumber: publication.version_number,
    workflowCode: publication.workflow_code,
    workflowType: publication.workflow_type,
    authorityLevel: publication.authority_level,
    requirementKind: publication.requirement_kind,
    dataClassification: publication.data_classification,
    scopeType: publication.scope_type,
    locationId: publication.location_id,
    departmentId: publication.department_id,
    snapshotJson: publication.snapshot_json,
    snapshotSha256: publication.snapshot_sha256,
    receiptSha256: publication.receipt_sha256,
    publishedBy: publication.published_by,
    publishedAt: publication.published_at,
  });

  const scopeSnapshotSha256 = canonicalSha256({
    type: "department", locationId: LOCATION, departmentId: DEPARTMENT,
  });
  await repository.insertEmploymentEpisode({
    id: EPISODE_ID,
    employeeNumber: EMPLOYEE,
    sequenceNumber: 1,
    predecessorEpisodeId: null,
    protectedPayload: protectedValue({ schemaVersion: 1 }, {
      namespace: "personnel-employment-episode",
      recordId: EPISODE_ID,
      field: "payload",
      employeeNumber: EMPLOYEE,
    }),
    actor: ACTOR,
    occurredAt: T1,
  });
  await repository.insertLifecycleCase({
    id: CASE_ID,
    employmentEpisodeId: EPISODE_ID,
    predecessorCaseId: null,
    responsibleActorId: ACTOR,
    scopeType: "department",
    locationId: LOCATION,
    departmentId: DEPARTMENT,
    scopeSnapshotSha256,
    protectedPayload: protectedValue({ schemaVersion: 1 }, {
      namespace: "personnel-lifecycle-case",
      recordId: CASE_ID,
      field: "payload",
      employeeNumber: EMPLOYEE,
    }),
    actor: ACTOR,
    occurredAt: T1,
  });
  let previousReceipt = await insertEvent(repository, {
    id: "event-o4-task-prepared",
    sequenceNumber: 1,
    eventType: "onboarding_prepared",
    previousReceiptSha256: "",
    occurredAt: T1,
  });
  await repository.transitionLifecycleCase({
    caseId: CASE_ID,
    fromState: "prepared",
    toState: "approved",
    expectedRevision: 1,
    actor: ACTOR,
    occurredAt: T2,
  });
  const packageBinding = {
    id: PACKAGE_ID,
    case_id: CASE_ID,
    publication_id: PUBLICATION_ID,
    version_number: 1,
    scope_snapshot_sha256: scopeSnapshotSha256,
    bound_by: ACTOR,
    bound_at: T2,
  };
  await repository.insertLifecyclePackageBinding({
    id: PACKAGE_ID,
    caseId: CASE_ID,
    publicationId: PUBLICATION_ID,
    versionNumber: 1,
    scopeSnapshotSha256,
    receiptSha256: canonicalSha256(
      personnelLifecyclePackageBindingReceiptBody(packageBinding),
    ),
    actor: ACTOR,
    occurredAt: T2,
  });
  await repository.insertRun({
    id: RUN_ID,
    processId: PROCESS_ID,
    processRevision: 1,
    triggerType: "personnel_manual",
    triggerKey: `personnel:${RUN_OPERATION_ID}`,
    locationId: LOCATION,
    departmentId: DEPARTMENT,
    triggeredBy: ACTOR,
  });
  const packageRun = {
    package_binding_id: PACKAGE_ID,
    run_id: RUN_ID,
    run_operation_id: RUN_OPERATION_ID,
    family_codes_json: '["personnel_administration"]',
    lifecycle_review_sha256: sha256("o4-task-review"),
    scope_snapshot_sha256: scopeSnapshotSha256,
    linked_by: ACTOR,
    linked_at: T2,
  };
  await repository.insertLifecyclePackageRun({
    packageBindingId: PACKAGE_ID,
    runId: RUN_ID,
    runOperationId: RUN_OPERATION_ID,
    familyCodesJson: packageRun.family_codes_json,
    lifecycleReviewSha256: packageRun.lifecycle_review_sha256,
    scopeSnapshotSha256,
    receiptSha256: sha256(JSON.stringify(
      personnelLifecyclePackageRunReceiptBody(packageRun),
    )),
    actor: ACTOR,
    occurredAt: T2,
  });
  const workflowBinding = {
    run_id: RUN_ID,
    publication_id: PUBLICATION_ID,
    operation_id: RUN_OPERATION_ID,
    subject_type: "employee",
    candidate_id: null,
    application_id: null,
    candidate_revision: null,
    application_revision: null,
    employee_number: EMPLOYEE,
    location_id: LOCATION,
    department_id: DEPARTMENT,
    request_sha256: sha256("o4-task-request"),
    started_by: ACTOR,
    started_at: T2,
  };
  await repository.insertRunBinding({
    runId: RUN_ID,
    publicationId: PUBLICATION_ID,
    operationId: RUN_OPERATION_ID,
    subjectType: "employee",
    candidateId: null,
    applicationId: null,
    candidateRevision: null,
    applicationRevision: null,
    employeeNumber: EMPLOYEE,
    requestSha256: workflowBinding.request_sha256,
    receiptSha256: sha256(JSON.stringify(
      personnelWorkflowInstanceReceiptBody(workflowBinding),
    )),
    startedBy: ACTOR,
    startedAt: T2,
  });
  await repository.insertRunStep({ runId: RUN_ID, stepId: STEP_ID, sortOrder: 1 });
  const workflowAssignment = {
    run_id: RUN_ID,
    step_id: STEP_ID,
    employee_number: ACTOR,
    responsibility_type: "employee",
    responsibility_reference: ACTOR,
    assigned_by: ACTOR,
    assigned_at: T2,
  };
  await repository.insertRunStepAssignment({
    runId: RUN_ID,
    stepId: STEP_ID,
    employeeNumber: ACTOR,
    responsibilityType: "employee",
    responsibilityReference: ACTOR,
    assignedBy: ACTOR,
    assignedAt: T2,
    receiptSha256: sha256(JSON.stringify(
      personnelWorkflowTaskAssignmentReceiptBody(workflowAssignment),
    )),
  });
  const lifecycleAssignment = {
    id: ASSIGNMENT_ID,
    case_id: CASE_ID,
    package_binding_id: PACKAGE_ID,
    run_id: RUN_ID,
    step_reference: STEP_ID,
    assignee_actor_id: ACTOR,
    assigned_by: ACTOR,
    assigned_at: T2,
  };
  await repository.insertLifecycleAssignment({
    id: ASSIGNMENT_ID,
    caseId: CASE_ID,
    stepReference: STEP_ID,
    assigneeActorId: ACTOR,
    predecessorAssignmentId: null,
    receiptSha256: canonicalSha256(
      personnelLifecycleAssignmentReceiptBody(lifecycleAssignment),
    ),
    actor: ACTOR,
    occurredAt: T2,
  });
  const assignmentBinding = {
    assignment_id: ASSIGNMENT_ID,
    package_binding_id: PACKAGE_ID,
    run_id: RUN_ID,
    step_reference: STEP_ID,
    bound_by: ACTOR,
    bound_at: T2,
  };
  await repository.insertLifecycleAssignmentBinding({
    assignmentId: ASSIGNMENT_ID,
    packageBindingId: PACKAGE_ID,
    runId: RUN_ID,
    stepReference: STEP_ID,
    receiptSha256: sha256(JSON.stringify(
      personnelLifecycleAssignmentBindingReceiptBody(assignmentBinding),
    )),
    actor: ACTOR,
    occurredAt: T2,
  });
  await repository.activateRunStep({ runId: RUN_ID, stepId: STEP_ID });
  previousReceipt = await insertEvent(repository, {
    id: "event-o4-task-approved",
    sequenceNumber: 2,
    eventType: "onboarding_approved",
    previousReceiptSha256: previousReceipt,
    occurredAt: T2,
  });
  await repository.transitionLifecycleCase({
    caseId: CASE_ID,
    fromState: "approved",
    toState: "active",
    expectedRevision: 2,
    actor: ACTOR,
    occurredAt: T3,
  });
  await insertEvent(repository, {
    id: "event-o4-task-started",
    sequenceNumber: 3,
    eventType: "onboarding_started",
    previousReceiptSha256: previousReceipt,
    occurredAt: T3,
  });
}

async function completeFixtureTask(context) {
  return createService(context).completeTask(
    ACTOR,
    RUN_ID,
    STEP_ID,
    { operationId: TASK_OPERATION_ID, action: "complete", evidenceReference: null },
    { access: accessFixture() },
  );
}

test("O4-Aufgabenliste zeigt nur die exakt zugewiesene aktive Aufgabe und bleibt IDOR-sicher", async () => {
  const context = await createFixture();
  try {
    const service = createService(context);
    const listed = await service.listActiveTasks(ACTOR, { access: accessFixture() });
    assert.equal(listed.items.length, 1);
    assert.deepEqual(listed.items[0].scope, {
      type: "department", locationId: LOCATION, departmentId: DEPARTMENT,
    });
    assert.deepEqual(listed.items[0].subject, {
      employeeNumber: EMPLOYEE,
      displayName: "O4 Zielperson",
    });

    assert.deepEqual(
      await service.listActiveTasks(OTHER, { access: accessFixture(OTHER) }),
      { items: [] },
    );
    await assert.rejects(
      service.completeTask(
        OTHER,
        RUN_ID,
        STEP_ID,
        { operationId: TASK_OPERATION_ID, action: "complete" },
        { access: accessFixture(OTHER) },
      ),
      (error) => error.code === "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_NOT_FOUND"
        && error.kind === "not_found",
    );
  } finally {
    await context.close();
  }
});

test("O4-Aufgaben verlangen eine persönliche, exakt zugewiesene Sitzung statt operativer Fachrechte", async () => {
  const context = await createFixture();
  try {
    const service = createService(context);
    const withoutOperationalRights = await service.listActiveTasks(ACTOR, {
      access: accessFixture(ACTOR, {
        canReadOperational: false,
        canUpdateOperational: false,
        canReadOperationalScope: () => false,
        canUpdateOperationalScope: () => false,
      }),
    });
    assert.equal(withoutOperationalRights.items.length, 1);
    await assert.rejects(
      service.listActiveTasks(ACTOR, {
        access: accessFixture(ACTOR, { personalEmployee: false }),
      }),
      (error) => error.code === "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_PERMISSION_REQUIRED"
        && error.kind === "forbidden",
    );
  } finally {
    await context.close();
  }
});

test("O4-Aufgaben erkennen Drift zwischen Lifecycle- und M5-Zuweisung fail-closed", async () => {
  const context = await createFixture();
  try {
    context.database.exec(`
      DROP TRIGGER trg_custom_process_run_assignments_immutable_update;
      UPDATE custom_process_run_step_assignments
      SET employee_number = '${OTHER}'
      WHERE run_id = '${RUN_ID}' AND step_id = '${STEP_ID}';
    `);
    await assert.rejects(
      createService(context).listActiveTasks(ACTOR, { access: accessFixture() }),
      (error) => error.code === "PERSONNEL_LIFECYCLE_ONBOARDING_TASK_INTEGRITY_FAILED"
        && error.kind === "integrity",
    );
  } finally {
    await context.close();
  }
});

test("O4-Aufgabenabschluss schreibt Event und Audits atomar und spielt ohne Duplikate wieder ab", async () => {
  const context = await createFixture();
  try {
    const service = createService(context);
    const completed = await service.completeTask(
      ACTOR,
      RUN_ID,
      STEP_ID,
      { operationId: TASK_OPERATION_ID, action: "complete", evidenceReference: null },
      { access: accessFixture() },
    );
    assert.equal(completed.replayed, false);
    assert.equal(completed.status, "completed");
    assert.equal(completed.resolved, true);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_case_events
      WHERE event_type = 'onboarding_task_completed'
    `).get().count, 1);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action IN (
        'personnel-lifecycle.onboarding.task.complete',
        'personnel-workflow.task.complete'
      )
    `).get().count, 2);
    const event = context.database.prepare(`
      SELECT * FROM personnel_lifecycle_case_events
      WHERE event_type = 'onboarding_task_completed'
    `).get();
    assert.equal(parsedProtectedValue(event.protected_payload, {
      namespace: "personnel-lifecycle-case-event",
      recordId: event.id,
      field: "payload",
      employeeNumber: EMPLOYEE,
    }).evidenceReference, null);

    const replayed = await service.completeTask(
      ACTOR,
      RUN_ID,
      STEP_ID,
      { operationId: TASK_OPERATION_ID, action: "complete" },
      { access: accessFixture() },
    );
    assert.equal(replayed.replayed, true);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_case_events
      WHERE event_type = 'onboarding_task_completed'
    `).get().count, 1);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action IN (
        'personnel-lifecycle.onboarding.task.complete',
        'personnel-workflow.task.complete'
      )
    `).get().count, 2);
  } finally {
    await context.close();
  }
});

test("O4 sperrt skip, not_applicable, Ausnahmen und Evidence-Links explizit", async () => {
  const context = await createFixture();
  try {
    const service = createService(context);
    const cases = [
      [{ operationId: TASK_OPERATION_ID, action: "skip" }, "ACTION_DEFERRED"],
      [{ operationId: TASK_OPERATION_ID, action: "not_applicable" }, "NOT_APPLICABLE_DEFERRED"],
      [{ operationId: TASK_OPERATION_ID, action: "complete", exception: { reason: "x" } }, "EXCEPTION_DEFERRED"],
      [{ operationId: TASK_OPERATION_ID, action: "complete", evidenceReference: "doc-1" }, "EVIDENCE_DEFERRED"],
    ];
    for (const [input, suffix] of cases) {
      await assert.rejects(
        service.completeTask(ACTOR, RUN_ID, STEP_ID, input, { access: accessFixture() }),
        (error) => error.code.endsWith(suffix),
      );
    }
    assert.equal(context.database.prepare(`
      SELECT status FROM custom_process_run_steps
      WHERE run_id = ? AND step_id = ?
    `).get(RUN_ID, STEP_ID).status, "active");
  } finally {
    await context.close();
  }
});

test("O4-Fallabschluss akzeptiert auch keinen ausserhalb des O4-Vertrags uebersprungenen Schritt", async () => {
  const context = await createFixture({ conditionType: "optional" });
  try {
    assert.equal((await context.repository.completeRunStep({
      status: "skipped",
      actor: ACTOR,
      note: "",
      idempotencyKey: sha256("o4-deferred-skip"),
      runId: RUN_ID,
      stepId: STEP_ID,
    })).rowsAffected, 1);
    assert.equal((await context.repository.resolveRun({ runId: RUN_ID })).rowsAffected, 1);
    await assert.rejects(
      createService(context).closeCase(
        ACTOR,
        CASE_ID,
        { operationId: CLOSE_OPERATION_ID, confirmation: "CLOSE_ONBOARDING" },
        { access: accessFixture() },
      ),
      (error) => error.code === "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_INCOMPLETE",
    );
  } finally {
    await context.close();
  }
});

test("O4-Fallabschluss blockiert offene Runs, schliesst vollstaendig und spielt exakt wieder ab", async () => {
  const context = await createFixture();
  try {
    const service = createService(context);
    await assert.rejects(
      service.closeCase(
        ACTOR,
        CASE_ID,
        { operationId: CLOSE_OPERATION_ID, confirmation: "CLOSE_ONBOARDING" },
        { access: accessFixture() },
      ),
      (error) => error.code === "PERSONNEL_LIFECYCLE_ONBOARDING_CLOSE_INCOMPLETE",
    );

    await completeFixtureTask(context);
    const closed = await service.closeCase(
      ACTOR,
      CASE_ID,
      { operationId: CLOSE_OPERATION_ID, confirmation: "CLOSE_ONBOARDING" },
      { access: accessFixture() },
    );
    assert.equal(closed.replayed, false);
    assert.equal(closed.state, "completed");
    assert.equal(context.database.prepare(`
      SELECT state FROM personnel_lifecycle_cases WHERE id = ?
    `).get(CASE_ID).state, "completed");
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_case_events
      WHERE event_type = 'onboarding_completed'
    `).get().count, 1);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action = 'personnel-lifecycle.onboarding.close'
    `).get().count, 1);

    const replayed = await service.closeCase(
      ACTOR,
      CASE_ID,
      { operationId: CLOSE_OPERATION_ID, confirmation: "CLOSE_ONBOARDING" },
      { access: accessFixture() },
    );
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.eventId, closed.eventId);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_case_events
      WHERE event_type = 'onboarding_completed'
    `).get().count, 1);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action = 'personnel-lifecycle.onboarding.close'
    `).get().count, 1);
  } finally {
    await context.close();
  }
});

test("O4 rollt M5-Aufgabenstatus und Lifecycle-Event bei Callbackfehler gemeinsam zurueck", async () => {
  const context = await createFixture();
  try {
    const service = createService(context, {
      protectJson() {
        throw new Error("test protection failure");
      },
    });
    await assert.rejects(
      service.completeTask(
        ACTOR,
        RUN_ID,
        STEP_ID,
        { operationId: TASK_OPERATION_ID, action: "complete" },
        { access: accessFixture() },
      ),
      /test protection failure/,
    );
    assert.equal(context.database.prepare(`
      SELECT status FROM custom_process_run_steps
      WHERE run_id = ? AND step_id = ?
    `).get(RUN_ID, STEP_ID).status, "active");
    assert.equal(context.database.prepare(`
      SELECT status FROM custom_process_runs WHERE id = ?
    `).get(RUN_ID).status, "open");
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_case_events
      WHERE event_type = 'onboarding_task_completed'
    `).get().count, 0);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action IN (
        'personnel-lifecycle.onboarding.task.complete',
        'personnel-workflow.task.complete'
      )
    `).get().count, 0);
  } finally {
    await context.close();
  }
});
