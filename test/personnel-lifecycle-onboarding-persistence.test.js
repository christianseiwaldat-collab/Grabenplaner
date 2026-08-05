"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const {
  personnelLifecycleAssignmentBindingReceiptBody,
  personnelLifecycleOnboardingOperationReceiptBody,
  personnelLifecyclePackageRunReceiptBody,
} = require("../lib/personnel-lifecycle-onboarding-receipt");
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
  PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-case-schema");
const {
  O5_REPLACED_O4_TRIGGER_NAMES,
  inspectSqlitePersonnelLifecycleOffboardingSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-offboarding-schema");
const {
  PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS,
  ensureSqlitePersonnelLifecycleOnboardingSchema,
  inspectSqlitePersonnelLifecycleOnboardingRows,
  inspectSqlitePersonnelLifecycleOnboardingSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-onboarding-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("../lib/personnel-workflow-publication-receipt");

const LOCATION = "o4-location";
const DEPARTMENT = 9401;
const EMPLOYEE = "EMP-O4";
const ACTOR = "HR-O4";
const EPISODE_ID = "episode-o4";
const CASE_ID = "case-o4";
const PROCESS_ID = "process-o4";
const PUBLICATION_ID = "publication-o4";
const PACKAGE_BINDING_ID = "package-binding-o4";
const RUN_ID = "run-o4";
const STEP_ID = "step-o4";
const ASSIGNMENT_ID = "assignment-o4";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const T1 = "2026-08-03T10:00:00.000Z";
const T2 = "2026-08-03T10:01:00.000Z";
const T3 = "2026-08-03T10:02:00.000Z";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function receipt(body) {
  return sha256(JSON.stringify(body));
}

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active)
      VALUES ('${LOCATION}', 'O4 Standort', 1);
    INSERT INTO departments (id, location_id, name, active)
      VALUES (${DEPARTMENT}, '${LOCATION}', 'O4 Abteilung', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (
      '${EMPLOYEE}', 'O4 Zielperson', 'O4', '${LOCATION}', ${DEPARTMENT}, 1
    );
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (
      '${ACTOR}', 'O4 Personalstelle', 'HR', '${LOCATION}', ${DEPARTMENT}, 1
    );
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password
    ) VALUES ('${ACTOR}', 'test-only', 'hr', 1, 0);
  `);
  ensureSqlitePersonnelLifecycleOnboardingSchema(application.database);
  return {
    ...application,
    repository: createCustomProcessManagementRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

async function insertPublication(repository) {
  const snapshotJson = JSON.stringify({
    id: PROCESS_ID,
    revision: 1,
    title: "O4 Pflichtpaket",
    scope: { type: "company", locationId: null, departmentId: null },
    steps: [{
      id: STEP_ID,
      type: "actor",
      title: "Personalunterlagen pruefen",
      description: "",
      responsibilityType: "employee",
      responsibilityReference: ACTOR,
      responsibilityLabel: "Personalstelle",
      conditionType: "always",
      conditionText: "",
      notificationChannels: [],
    }],
  });
  await repository.insertProcess({
    id: PROCESS_ID,
    title: "O4 Pflichtpaket",
    symbol: "O4",
    description: "O4 Persistenztest",
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
    workflow_code: "onboarding.o4.required",
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
  publication.receipt_sha256 = receipt(
    personnelWorkflowPublicationReceiptBody(publication),
  );
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
}

async function insertActiveOnboarding(repository) {
  const scopeSha256 = sha256("o4-scope");
  const reviewSha256 = sha256("o4-lifecycle-review");
  await insertPublication(repository);
  await repository.insertEmploymentEpisode({
    id: EPISODE_ID,
    employeeNumber: EMPLOYEE,
    sequenceNumber: 1,
    predecessorEpisodeId: null,
    protectedPayload: "enc:v2:o4-test-employment-episode",
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
    scopeSnapshotSha256: scopeSha256,
    protectedPayload: "enc:v2:o4-test-case",
    actor: ACTOR,
    occurredAt: T1,
  });
  await repository.insertLifecycleReferenceDates({
    id: "reference-dates-o4",
    caseId: CASE_ID,
    revision: 1,
    previousRevisionId: null,
    protectedPayload: "enc:v2:o4-test-reference-dates",
    receiptSha256: sha256("reference-dates-o4"),
    actor: ACTOR,
    occurredAt: T1,
  });
  await repository.insertLifecycleCaseEvent({
    id: "event-o4-prepared",
    caseId: CASE_ID,
    sequenceNumber: 1,
    eventType: "onboarding.prepared",
    dataClassification: "hr_confidential",
    protectedPayload: "enc:v2:o4-test-event-prepared",
    previousReceiptSha256: "",
    receiptSha256: sha256("event-o4-prepared"),
    actor: ACTOR,
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
  await repository.insertLifecyclePackageBinding({
    id: PACKAGE_BINDING_ID,
    caseId: CASE_ID,
    publicationId: PUBLICATION_ID,
    versionNumber: 1,
    scopeSnapshotSha256: scopeSha256,
    receiptSha256: sha256("package-binding-o4"),
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
  await repository.insertRunStep({ runId: RUN_ID, stepId: STEP_ID, sortOrder: 1 });
  const packageRun = {
    package_binding_id: PACKAGE_BINDING_ID,
    run_id: RUN_ID,
    run_operation_id: RUN_OPERATION_ID,
    family_codes_json: '["personnel_administration"]',
    lifecycle_review_sha256: reviewSha256,
    scope_snapshot_sha256: scopeSha256,
    linked_by: ACTOR,
    linked_at: T2,
  };
  packageRun.receipt_sha256 = receipt(
    personnelLifecyclePackageRunReceiptBody(packageRun),
  );
  await repository.insertLifecyclePackageRun({
    packageBindingId: packageRun.package_binding_id,
    runId: packageRun.run_id,
    runOperationId: packageRun.run_operation_id,
    familyCodesJson: packageRun.family_codes_json,
    lifecycleReviewSha256: packageRun.lifecycle_review_sha256,
    scopeSnapshotSha256: packageRun.scope_snapshot_sha256,
    receiptSha256: packageRun.receipt_sha256,
    actor: packageRun.linked_by,
    occurredAt: packageRun.linked_at,
  });
  await repository.insertLifecycleAssignment({
    id: ASSIGNMENT_ID,
    caseId: CASE_ID,
    stepReference: STEP_ID,
    assigneeActorId: ACTOR,
    predecessorAssignmentId: null,
    receiptSha256: sha256("assignment-o4"),
    actor: ACTOR,
    occurredAt: T2,
  });
  const assignmentBinding = {
    assignment_id: ASSIGNMENT_ID,
    package_binding_id: PACKAGE_BINDING_ID,
    run_id: RUN_ID,
    step_reference: STEP_ID,
    bound_by: ACTOR,
    bound_at: T2,
  };
  assignmentBinding.receipt_sha256 = receipt(
    personnelLifecycleAssignmentBindingReceiptBody(assignmentBinding),
  );
  await repository.insertLifecycleAssignmentBinding({
    assignmentId: assignmentBinding.assignment_id,
    packageBindingId: assignmentBinding.package_binding_id,
    runId: assignmentBinding.run_id,
    stepReference: assignmentBinding.step_reference,
    receiptSha256: assignmentBinding.receipt_sha256,
    actor: assignmentBinding.bound_by,
    occurredAt: assignmentBinding.bound_at,
  });
  await repository.insertLifecycleCaseEvent({
    id: "event-o4-approved",
    caseId: CASE_ID,
    sequenceNumber: 2,
    eventType: "onboarding.approved",
    dataClassification: "hr_confidential",
    protectedPayload: "enc:v2:o4-test-event-approved",
    previousReceiptSha256: sha256("event-o4-prepared"),
    receiptSha256: sha256("event-o4-approved"),
    actor: ACTOR,
    occurredAt: T2,
  });
  await repository.insertLifecycleCaseEvent({
    id: "event-o4-started",
    caseId: CASE_ID,
    sequenceNumber: 3,
    eventType: "onboarding.started",
    dataClassification: "hr_confidential",
    protectedPayload: "enc:v2:o4-test-event-started",
    previousReceiptSha256: sha256("event-o4-approved"),
    receiptSha256: sha256("event-o4-started"),
    actor: ACTOR,
    occurredAt: T3,
  });
  await repository.transitionLifecycleCase({
    caseId: CASE_ID,
    fromState: "approved",
    toState: "active",
    expectedRevision: 2,
    actor: ACTOR,
    occurredAt: T3,
  });
  const resultPayload = JSON.stringify({
    operationId: OPERATION_ID,
    caseId: CASE_ID,
    packageRunIds: [RUN_ID],
  });
  const operation = {
    operation_id: OPERATION_ID,
    case_id: CASE_ID,
    request_sha256: sha256("o4-request"),
    preview_sha256: sha256("o4-preview"),
    result_payload: resultPayload,
    actor_id: ACTOR,
    occurred_at: T3,
  };
  operation.result_receipt_sha256 = receipt(
    personnelLifecycleOnboardingOperationReceiptBody(operation),
  );
  await repository.insertOnboardingOperation({
    operationId: operation.operation_id,
    caseId: operation.case_id,
    requestSha256: operation.request_sha256,
    previewSha256: operation.preview_sha256,
    resultPayload: operation.result_payload,
    resultReceiptSha256: operation.result_receipt_sha256,
    actor: operation.actor_id,
    occurredAt: operation.occurred_at,
  });
}

test("O4-Schema bleibt im kombinierten O5-Vertrag kanonisch erhalten", () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  try {
    ensureSqliteApplicationSchema(application.database);
    assert.equal(PERSONNEL_LIFECYCLE_ONBOARDING_MIGRATION_ID,
      "v0.92-personnel-lifecycle-onboarding-execution");
    const initial = inspectSqlitePersonnelLifecycleOnboardingSchema(application.database);
    assert.equal(initial.absent || initial.valid, true);
    const result = ensureSqlitePersonnelLifecycleOnboardingSchema(application.database);
    assert.equal(result.valid, true);
    assert.deepEqual(PERSONNEL_LIFECYCLE_ONBOARDING_TABLE_NAMES, [
      "personnel_lifecycle_onboarding_operations",
      "personnel_lifecycle_case_package_runs",
      "personnel_lifecycle_case_assignment_bindings",
    ]);
    assert.equal(PERSONNEL_LIFECYCLE_CASE_TRIGGER_DEFINITIONS.every(({ name }) => (
      !application.database.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?
      `).get(name)
    )), true);
    assert.equal(PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS.every(({ name }) => (
      O5_REPLACED_O4_TRIGGER_NAMES.includes(name)
      || Boolean(application.database.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?
      `).get(name))
    )), true);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingSchema(application.database).valid,
      true);
    assert.equal(ensureSqlitePersonnelLifecycleOnboardingSchema(application.database).valid,
      true);
  } finally {
    application.provider.close();
    application.database.close();
  }
});

test("O4-Repository schreibt einen vollstaendig verknuepften Start atomar", async () => {
  const context = fixture();
  try {
    await context.repository.transaction(insertActiveOnboarding);
    assert.equal((await context.repository.onboardingCaseById({ caseId: CASE_ID })).state,
      "active");
    assert.equal((await context.repository.currentEpisodeOnboardingCaseForEmployee({
      employeeNumber: EMPLOYEE,
    })).id, CASE_ID);
    assert.equal((await context.repository.employmentEpisodeForEmployee({
      employeeNumber: EMPLOYEE,
    })).id, EPISODE_ID);
    const operation = await context.repository.onboardingOperationById({
      operationId: OPERATION_ID,
    });
    assert.equal(operation.case_id, CASE_ID);
    assert.deepEqual(operation.result_payload.packageRunIds, [RUN_ID]);
    const packageRuns = await context.repository.listLifecyclePackageRuns({ caseId: CASE_ID });
    assert.deepEqual(packageRuns[0].family_codes, ["personnel_administration"]);
    assert.equal(packageRuns[0].lifecycle_review_sha256,
      sha256("o4-lifecycle-review"));
    assert.equal((await context.repository.listLifecycleAssignments({ caseId: CASE_ID }))[0]
      .assignee_actor_id, ACTOR);
    assert.equal((await context.repository.lifecycleCaseLastEvent({ caseId: CASE_ID }))
      .event_type, "onboarding.started");
    assert.deepEqual(await context.repository.lifecycleCaseProgress({ caseId: CASE_ID }), {
      case_id: CASE_ID,
      state: "active",
      package_count: 1,
      linked_run_count: 1,
      resolved_run_count: 0,
      assignment_count: 1,
      linked_assignment_count: 1,
      total_step_count: 1,
      completed_step_count: 0,
      skipped_step_count: 0,
      finished_step_count: 0,
    });
    assert.deepEqual(inspectSqlitePersonnelLifecycleOnboardingRows(context.database), {
      valid: true,
      issues: [],
    });
  } finally {
    await context.close();
  }
});

test("O4-Transaktion rollt Episode und Fall bei einem Fehler vollstaendig zurueck", async () => {
  const context = fixture();
  try {
    await assert.rejects(context.repository.transaction(async (repository) => {
      await repository.insertEmploymentEpisode({
        id: "episode-rollback-o4",
        employeeNumber: EMPLOYEE,
        sequenceNumber: 1,
        predecessorEpisodeId: null,
        protectedPayload: "enc:v2:o4-test-rollback-episode",
        actor: ACTOR,
        occurredAt: T1,
      });
      await repository.insertLifecycleCase({
        id: "case-rollback-o4",
        employmentEpisodeId: "episode-rollback-o4",
        predecessorCaseId: null,
        responsibleActorId: ACTOR,
        scopeType: "department",
        locationId: LOCATION,
        departmentId: DEPARTMENT,
        scopeSnapshotSha256: sha256("rollback-scope"),
        protectedPayload: "enc:v2:o4-test-rollback-case",
        actor: ACTOR,
        occurredAt: T1,
      });
      throw new Error("o4-rollback");
    }), /o4-rollback/);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_employment_episodes
    `).get().count, 0);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_cases
    `).get().count, 0);
  } finally {
    await context.close();
  }
});

test("O4 blockiert unter O5 unvollstaendige Starts, Drift und jede Belegmutation", async () => {
  const context = fixture();
  try {
    await context.repository.transaction(insertActiveOnboarding);
    assert.throws(() => context.database.prepare(`
      INSERT INTO personnel_lifecycle_confidential_access_events (
        id, case_id, sequence_number, actor_id, action, occurred_at,
        result, purpose_code, previous_receipt_sha256, receipt_sha256
      ) VALUES (?, ?, 1, ?, 'read', ?, 'allowed', 'test', '', ?)
    `).run("confidential-o4", CASE_ID, ACTOR, T3, sha256("confidential")),
    /O5 confidential access event is invalid/);
    assert.throws(() => context.database.prepare(`
      UPDATE personnel_lifecycle_case_package_runs
      SET family_codes_json = '["base_security_privacy"]'
      WHERE package_binding_id = ?
    `).run(PACKAGE_BINDING_ID), /package run linkages are immutable/);
    assert.throws(() => context.database.prepare(`
      DELETE FROM personnel_lifecycle_onboarding_operations WHERE operation_id = ?
    `).run(OPERATION_ID), /operation ledger entries are immutable/);
    assert.throws(() => context.database.prepare(`
      INSERT INTO personnel_lifecycle_cases (
        id, case_type, employment_episode_id, state, responsible_actor_id,
        scope_type, location_id, department_id, scope_snapshot_sha256,
        protected_payload, created_by, created_at, updated_by, updated_at
      ) VALUES (?, 'onboarding', ?, 'prepared', ?, 'department', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "parallel-onboarding-o4", EPISODE_ID, ACTOR, LOCATION, DEPARTMENT,
      sha256("parallel"), "enc:v2:o4-parallel", ACTOR, T3, ACTOR, T3,
    ), /UNIQUE constraint failed/);

    const trigger = PERSONNEL_LIFECYCLE_ONBOARDING_TRIGGER_DEFINITIONS.find(({ name }) => (
      name === "trg_personnel_lifecycle_onboarding_operations_o4_immutable_delete"
    ));
    context.database.exec(`DROP TRIGGER "${trigger.name}"`);
    assert.throws(
      () => ensureSqlitePersonnelLifecycleOnboardingSchema(context.database),
      (error) => error?.code === "PERSONNEL_LIFECYCLE_ONBOARDING_SCHEMA_DRIFT_WITH_DATA",
    );
  } finally {
    await context.close();
  }
});
