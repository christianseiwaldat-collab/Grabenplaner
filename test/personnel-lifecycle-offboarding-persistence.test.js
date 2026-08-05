"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS,
} = require("../lib/personnel-lifecycle-offboarding-contract");
const {
  canonicalSha256,
  deterministicUuidV4,
  personnelLifecycleOffboardingAssignmentBindingReceiptSha256,
  personnelLifecycleOffboardingAssignmentReceiptSha256,
  personnelLifecycleOffboardingCaseEventReceiptSha256,
  personnelLifecycleOffboardingOperationReceiptSha256,
  personnelLifecycleOffboardingPackageBindingReceiptSha256,
  personnelLifecycleOffboardingPackageRunReceiptSha256,
  personnelLifecycleOffboardingPackageVersionReceiptSha256,
  personnelLifecycleOffboardingReferenceDatesReceiptSha256,
  personnelLifecycleOffboardingRunTerminationReceiptSha256,
  personnelLifecycleOffboardingRuntimeStepReceiptSha256,
  sha256,
} = require("../lib/personnel-lifecycle-offboarding-receipt");
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
  PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS,
  inspectSqlitePersonnelLifecycleOffboardingRows,
  inspectSqlitePersonnelLifecycleOffboardingSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-offboarding-schema");
const {
  inspectSqlitePersonnelLifecycleOnboardingRows,
  inspectSqlitePersonnelLifecycleOnboardingSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-onboarding-schema");
const {
  inspectSqlitePersonnelWorkflowInstanceRows,
} = require("../lib/persistence/sqlite/operations/personnel-workflow-instance-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

const LOCATION = "o5-location";
const DEPARTMENT = 9501;
const EMPLOYEE = "EMP-O5";
const ACTOR = "HR-O5";
const EPISODE_ID = "episode-o5";
const CASE_ID = "case-o5";
const T0 = "2026-08-03T12:00:00.000Z";
const PLAN_RECEIPT = sha256("o5-protected-plan");
const SCOPE_RECEIPT = canonicalSha256({
  type: "department",
  locationId: LOCATION,
  departmentId: DEPARTMENT,
});
const EVENT_TYPE_BY_OPERATION = Object.freeze({
  prepare: "offboarding_internally_prepared",
  time_critical_approval: "offboarding_time_critical_approved",
  communication_release: "offboarding_communication_released",
  information_confirmation: "offboarding_employee_informed",
  activation: "offboarding_activated",
  task_complete: "offboarding_task_completed",
  cancellation: "offboarding_cancelled",
  close: "offboarding_completed",
});

function instant(offset) {
  return new Date(Date.parse(T0) + offset * 1000).toISOString();
}

function id(kind, ...parts) {
  return deterministicUuidV4("o5-persistence-test", kind, ...parts);
}

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active)
      VALUES ('${LOCATION}', 'O5 Standort', 1);
    INSERT INTO departments (id, location_id, name, active)
      VALUES (${DEPARTMENT}, '${LOCATION}', 'O5 Abteilung', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (
      '${EMPLOYEE}', 'O5 Zielperson', 'O5', '${LOCATION}', ${DEPARTMENT}, 1
    );
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (
      '${ACTOR}', 'O5 Personalstelle', 'HR', '${LOCATION}', ${DEPARTMENT}, 1
    );
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password
    ) VALUES ('${ACTOR}', 'test-only', 'developer', 1, 0);
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES ('${ACTOR}', 'personnel:lifecycle:operational:read', '${ACTOR}');
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES ('${ACTOR}', 'personnel:lifecycle:operational:update', '${ACTOR}');
  `);
  return {
    ...application,
    repository: createCustomProcessManagementRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

async function insertOperation(repository, {
  operationId,
  caseId = CASE_ID,
  operationType,
  subjectKey,
  requestSha256 = sha256(`${operationType}:${operationId}`),
  occurredAt,
}) {
  const previousEvent = await repository.offboardingCaseLastEvent({ caseId });
  const eventType = EVENT_TYPE_BY_OPERATION[operationType];
  const event = {
    id: deterministicUuidV4(
      "personnel-lifecycle-offboarding-event",
      eventType,
      operationId,
    ),
    case_id: caseId,
    sequence_number: previousEvent ? Number(previousEvent.sequence_number) + 1 : 1,
    event_type: eventType,
    data_classification: "offboarding_strict_confidential",
    protected_payload: `enc:v2:o5-event-${operationType}-${operationId}`,
    previous_receipt_sha256: previousEvent?.receipt_sha256 || "",
    actor_id: ACTOR,
    occurred_at: occurredAt,
  };
  event.receipt_sha256 = personnelLifecycleOffboardingCaseEventReceiptSha256(event);
  await repository.insertOffboardingLifecycleCaseEvent({
    id: event.id,
    caseId: event.case_id,
    sequenceNumber: event.sequence_number,
    eventType: event.event_type,
    protectedPayload: event.protected_payload,
    previousReceiptSha256: event.previous_receipt_sha256,
    receiptSha256: event.receipt_sha256,
    actor: event.actor_id,
    occurredAt: event.occurred_at,
  });
  const row = {
    operation_id: operationId,
    case_id: caseId,
    operation_type: operationType,
    subject_key: subjectKey ?? (operationType === "prepare" ? EMPLOYEE : caseId),
    request_sha256: requestSha256,
    plan_receipt_sha256: PLAN_RECEIPT,
    protected_result_payload: `enc:v2:o5-result-${operationType}-${operationId}`,
    actor_id: ACTOR,
    occurred_at: occurredAt,
  };
  row.result_receipt_sha256 = personnelLifecycleOffboardingOperationReceiptSha256(row);
  return repository.insertOffboardingOperation({
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
  });
}

async function prepareCase(repository) {
  await repository.insertEmploymentEpisode({
    id: EPISODE_ID,
    employeeNumber: EMPLOYEE,
    sequenceNumber: 1,
    predecessorEpisodeId: null,
    protectedPayload: "enc:v2:o5-episode",
    actor: ACTOR,
    occurredAt: instant(1),
  });
  await repository.insertOffboardingLifecycleCase({
    id: CASE_ID,
    employmentEpisodeId: EPISODE_ID,
    predecessorCaseId: null,
    responsibleActorId: ACTOR,
    scopeType: "department",
    locationId: LOCATION,
    departmentId: DEPARTMENT,
    scopeSnapshotSha256: SCOPE_RECEIPT,
    protectedPayload: "enc:v2:o5-protected-plan",
    actor: ACTOR,
    occurredAt: instant(2),
  });
  const referenceDates = {
    id: "reference-o5-1",
    caseId: CASE_ID,
    revision: 1,
    previousRevisionId: null,
    protectedPayload: "enc:v2:o5-reference-times",
    changedBy: ACTOR,
    changedAt: instant(3),
  };
  referenceDates.receiptSha256 = personnelLifecycleOffboardingReferenceDatesReceiptSha256(
    referenceDates,
  );
  await repository.insertOffboardingReferenceDates(referenceDates);
  await insertOperation(repository, {
    operationId: id("operation", "prepare"),
    operationType: "prepare",
    occurredAt: instant(4),
  });
}

async function releaseCase(repository) {
  await repository.transitionOffboardingLifecycleCase({
    caseId: CASE_ID,
    fromState: "internally_prepared",
    toState: "communication_released",
    expectedRevision: 1,
    actor: ACTOR,
    occurredAt: instant(5),
  });
  await repository.transitionOffboardingEmploymentEpisode({
    episodeId: EPISODE_ID,
    fromState: "employment_active",
    toState: "exit_in_progress",
    expectedRevision: 1,
    actor: ACTOR,
    occurredAt: instant(6),
  });
  const runtime = [];
  for (let index = 0; index < PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.length;
    index += 1) {
    const family = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS[index];
    const runtimeProcessId = id("runtime-process", family.familyCode);
    const packageVersionId = id("package-version", family.familyCode);
    const packageBindingId = id("package-binding", family.familyCode);
    const runId = id("run", family.familyCode);
    const runOperationId = id("run-operation", family.familyCode);
    const assignmentId = `assignment-o5-${family.familyCode}`;
    const runtimeManifestSha256 = canonicalSha256({
      stepId: family.stepId,
      orderId: family.orderId,
    });
    await repository.insertOffboardingRuntimeProcessShell({
      runtimeProcessId,
      versionNumber: 1,
      actor: ACTOR,
    });
    const packageVersion = {
      id: packageVersionId,
      seriesId: id("package-series", family.familyCode),
      runtimeProcessId,
      versionNumber: 1,
      predecessorVersionId: null,
      familyCode: family.familyCode,
      pathKind: "both",
      requirementKind: "mandatory",
      scopeType: "company",
      locationId: null,
      departmentId: null,
      dataClassification: "offboarding_strict_confidential",
      protectedSnapshot: `enc:v2:o5-version-${family.familyCode}`,
      snapshotSha256: sha256(`o5-version-${family.familyCode}`),
      runtimeManifestSha256,
      publishedBy: ACTOR,
      publishedAt: instant(7 + index),
    };
    packageVersion.receiptSha256 = personnelLifecycleOffboardingPackageVersionReceiptSha256(
      packageVersion,
    );
    await repository.insertOffboardingPackageVersion(packageVersion);
    const packageBinding = {
      id: packageBindingId,
      caseId: CASE_ID,
      packageVersionId,
      versionNumber: 1,
      scopeSnapshotSha256: SCOPE_RECEIPT,
      boundBy: ACTOR,
      boundAt: instant(20 + index),
    };
    packageBinding.receiptSha256 = personnelLifecycleOffboardingPackageBindingReceiptSha256(
      packageBinding,
    );
    await repository.insertOffboardingPackageBinding(packageBinding);
    await repository.insertOffboardingRun({
      id: runId,
      runtimeProcessId,
      versionNumber: 1,
      runOperationId,
      locationId: LOCATION,
      departmentId: DEPARTMENT,
      triggeredBy: ACTOR,
    });
    const packageRun = {
      packageBindingId,
      runId,
      runOperationId,
      runtimeManifestSha256,
      scopeSnapshotSha256: SCOPE_RECEIPT,
      linkedBy: ACTOR,
      linkedAt: instant(30 + index),
    };
    packageRun.receiptSha256 = personnelLifecycleOffboardingPackageRunReceiptSha256(packageRun);
    await repository.insertOffboardingPackageRun(packageRun);
    const runtimeStep = {
      packageBindingId,
      runId,
      stepReference: family.stepId,
      orderReference: family.orderId,
      sortOrder: 1,
      recipientClass: family.recipientClass,
      releaseGate: "communication_released",
      dataClassification: "personal_restricted",
      protectedPayload: `enc:v2:o5-runtime-${family.familyCode}`,
      createdBy: ACTOR,
      createdAt: instant(40 + index),
    };
    runtimeStep.receiptSha256 = personnelLifecycleOffboardingRuntimeStepReceiptSha256(
      runtimeStep,
    );
    await repository.insertOffboardingRuntimeStep(runtimeStep);
    await repository.insertOffboardingRunStep({
      runId,
      stepId: family.stepId,
      sortOrder: 1,
    });
    const assignment = {
      id: assignmentId,
      caseId: CASE_ID,
      packageBindingId,
      runId,
      stepReference: family.stepId,
      assigneeActorId: ACTOR,
      predecessorAssignmentId: null,
      assignedBy: ACTOR,
      assignedAt: instant(50 + index),
    };
    assignment.receiptSha256 = personnelLifecycleOffboardingAssignmentReceiptSha256(assignment);
    await repository.insertOffboardingAssignment(assignment);
    const assignmentBinding = {
      assignmentId,
      packageBindingId,
      runId,
      stepReference: family.stepId,
      boundBy: ACTOR,
      boundAt: instant(60 + index),
    };
    assignmentBinding.receiptSha256 = (
      personnelLifecycleOffboardingAssignmentBindingReceiptSha256(assignmentBinding)
    );
    await repository.insertOffboardingAssignmentBinding(assignmentBinding);
    runtime.push({ ...family, runId, runtimeProcessId });
  }
  await insertOperation(repository, {
    operationId: id("operation", "release"),
    operationType: "communication_release",
    occurredAt: instant(70),
  });
  return runtime;
}

test("O5-Schema ist kanonisch, kombiniert O4 verlustfrei und besitzt acht eigene Tabellen", () => {
  const context = fixture();
  try {
    assert.equal(PERSONNEL_LIFECYCLE_OFFBOARDING_MIGRATION_ID,
      "v0.93-personnel-lifecycle-offboarding-execution");
    assert.equal(PERSONNEL_LIFECYCLE_OFFBOARDING_TABLE_NAMES.length, 8);
    const operationTableSql = context.database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'personnel_lifecycle_offboarding_operations'
    `).get().sql;
    for (const operationType of [
      "prepare", "time_critical_approval", "communication_release",
      "information_confirmation", "activation", "task_complete", "cancellation", "close",
    ]) {
      assert.match(operationTableSql, new RegExp(`'${operationType}'`));
    }
    assert.doesNotMatch(operationTableSql,
      /'time_critical_approve'|'information_confirm'|'activate'|'cancel'/);
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingSchema(context.database).valid, true);
    assert.deepEqual(inspectSqlitePersonnelLifecycleOffboardingRows(context.database), {
      valid: true,
      absent: false,
      issues: [],
    });
    assert.equal(inspectSqlitePersonnelLifecycleOnboardingSchema(context.database).valid, true);
    assert.equal(inspectSqlitePersonnelLifecycleOnboardingRows(context.database).valid, true);
    assert.equal(inspectSqlitePersonnelWorkflowInstanceRows(context.database).valid, true);
  } finally {
    context.provider.close();
    context.database.close();
  }
});

test("O5 findet die aktuelle aktive Episode auch bevor ein Offboarding-Fall existiert", async () => {
  const context = fixture();
  try {
    const emptyContext = await context.repository.offboardingEmploymentContextForEmployee({
      employeeNumber: EMPLOYEE,
    });
    assert.equal(emptyContext.employee_number, EMPLOYEE);
    assert.equal(emptyContext.employee_active, 1);
    assert.equal(emptyContext.episode_id, null);
    await context.repository.insertOffboardingEmploymentEpisode({
      id: EPISODE_ID,
      employeeNumber: EMPLOYEE,
      sequenceNumber: 1,
      predecessorEpisodeId: null,
      protectedPayload: "enc:v2:o5-episode-without-case",
      actor: ACTOR,
      occurredAt: instant(1),
    });
    const employmentContext = await context.repository.offboardingEmploymentContextForEmployee({
      employeeNumber: EMPLOYEE,
    });
    assert.equal(employmentContext.episode_id, EPISODE_ID);
    assert.equal(employmentContext.current_case_id, null);
    const row = await context.repository.currentEpisodeOffboardingCaseForEmployee({
      employeeNumber: EMPLOYEE,
    });
    assert.equal(row.id, null);
    assert.equal(row.episode_id, EPISODE_ID);
    assert.equal(row.employment_episode_id, EPISODE_ID);
    assert.equal(row.episode_state, "employment_active");
  } finally {
    await context.close();
  }
});

test("O5 bleibt bis Aktivierung pending, koppelt Task-Ledger und bleibt generisch unsichtbar", async () => {
  const context = fixture();
  try {
    const runtime = await context.repository.transaction(async (repository) => {
      await prepareCase(repository);
      return releaseCase(repository);
    });
    assert.equal((await context.repository.listActiveLifecycleOffboardingTasks({
      actorId: ACTOR,
    })).length, 6);
    assert.equal((await context.repository.listActiveLifecycleOffboardingTasks({
      actorId: ACTOR,
    })).every((row) => row.run_step_status === "pending"), true);
    assert.deepEqual(await context.repository.listProcesses({ includeArchived: 1 }), []);
    assert.equal(await context.repository.runById({ id: runtime[0].runId }), null);
    assert.equal(await context.repository.runStepById({
      runId: runtime[0].runId,
      stepId: runtime[0].stepId,
    }), null);
    await context.repository.transaction(async (repository) => {
      await repository.transitionOffboardingLifecycleCase({
        caseId: CASE_ID,
        fromState: "communication_released",
        toState: "employee_informed",
        expectedRevision: 2,
        actor: ACTOR,
        occurredAt: instant(80),
      });
      await insertOperation(repository, {
        operationId: id("operation", "information"),
        operationType: "information_confirmation",
        occurredAt: instant(81),
      });
      await repository.transitionOffboardingLifecycleCase({
        caseId: CASE_ID,
        fromState: "employee_informed",
        toState: "active",
        expectedRevision: 3,
        actor: ACTOR,
        occurredAt: instant(82),
      });
      for (const item of runtime) {
        assert.equal((await repository.activateNextOffboardingRunStep({
          runId: item.runId,
          stepId: item.stepId,
          activatedAt: instant(83),
        })).rowsAffected, 1);
      }
      await insertOperation(repository, {
        operationId: id("operation", "activate"),
        operationType: "activation",
        occurredAt: instant(84),
      });
    });
    assert.equal((await context.repository.listActiveLifecycleOffboardingTasks({
      actorId: ACTOR,
    })).every((row) => row.run_step_status === "active"), true);
    await context.repository.transaction(async (repository) => {
      for (let index = 0; index < runtime.length; index += 1) {
        const item = runtime[index];
        const taskRequestSha256 = sha256(`o5-task:${item.runId}:${item.stepId}`);
        assert.equal((await repository.completeOffboardingRunStep({
          runId: item.runId,
          stepId: item.stepId,
          actorId: ACTOR,
          completionRequestSha256: taskRequestSha256,
          completedAt: instant(90 + index),
        })).rowsAffected, 1);
        await insertOperation(repository, {
          operationId: id("operation", "task", item.familyCode),
          operationType: "task_complete",
          subjectKey: `${item.runId}:${item.stepId}`,
          requestSha256: taskRequestSha256,
          occurredAt: instant(90 + index),
        });
        assert.equal((await repository.resolveOffboardingRun({
          runId: item.runId,
          resolvedAt: instant(100 + index),
        })).rowsAffected, 1);
      }
      await repository.transitionOffboardingLifecycleCase({
        caseId: CASE_ID,
        fromState: "active",
        toState: "completed",
        expectedRevision: 4,
        actor: ACTOR,
        occurredAt: instant(110),
      });
      await repository.transitionOffboardingEmploymentEpisode({
        episodeId: EPISODE_ID,
        fromState: "exit_in_progress",
        toState: "employment_ended",
        expectedRevision: 2,
        actor: ACTOR,
        occurredAt: instant(111),
      });
      await insertOperation(repository, {
        operationId: id("operation", "close"),
        operationType: "close",
        occurredAt: instant(112),
      });
    });
    assert.equal((await context.repository.offboardingCaseById({ caseId: CASE_ID })).state,
      "completed");
    assert.equal((await context.repository.offboardingCaseProgress({ caseId: CASE_ID }))
      .completed_step_count, 6);
    assert.deepEqual(inspectSqlitePersonnelLifecycleOffboardingRows(context.database), {
      valid: true,
      absent: false,
      issues: [],
    });
  } finally {
    await context.close();
  }
});

test("O5-Abbruch terminiert offene Runs additiv ohne Skip und ohne generische Bindung", async () => {
  const context = fixture();
  try {
    const cancelOperationId = id("operation", "cancel");
    const runtime = await context.repository.transaction(async (repository) => {
      await prepareCase(repository);
      const rows = await releaseCase(repository);
      await repository.transitionOffboardingLifecycleCase({
        caseId: CASE_ID,
        fromState: "communication_released",
        toState: "cancelled",
        expectedRevision: 2,
        actor: ACTOR,
        occurredAt: instant(80),
      });
      await repository.transitionOffboardingEmploymentEpisode({
        episodeId: EPISODE_ID,
        fromState: "exit_in_progress",
        toState: "employment_active",
        expectedRevision: 2,
        actor: ACTOR,
        occurredAt: instant(81),
      });
      for (let index = 0; index < rows.length; index += 1) {
        const termination = {
          runId: rows[index].runId,
          caseId: CASE_ID,
          operationId: cancelOperationId,
          reasonCode: "cancelled_by_hr",
          protectedPayload: `enc:v2:o5-cancel-${index}`,
          terminatedBy: ACTOR,
          terminatedAt: instant(82 + index),
        };
        termination.receiptSha256 = personnelLifecycleOffboardingRunTerminationReceiptSha256(
          termination,
        );
        await repository.insertOffboardingRunTermination(termination);
        assert.equal((await repository.resolveOffboardingRun({
          runId: rows[index].runId,
          resolvedAt: instant(90 + index),
        })).rowsAffected, 1);
      }
      await insertOperation(repository, {
        operationId: cancelOperationId,
        operationType: "cancellation",
        occurredAt: instant(100),
      });
      return rows;
    });
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_run_steps
      WHERE status = 'skipped'
    `).get().count, 0);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_offboarding_run_terminations
    `).get().count, runtime.length);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_run_bindings
    `).get().count, 0);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_run_step_assignments
    `).get().count, 0);
    assert.deepEqual(inspectSqlitePersonnelLifecycleOffboardingRows(context.database), {
      valid: true,
      absent: false,
      issues: [],
    });
  } finally {
    await context.close();
  }
});

test("O5-Row-Inspector erkennt semantische Importdrift trotz neu berechneter Belege", async () => {
  const context = fixture();
  try {
    await context.repository.transaction(async (repository) => {
      await prepareCase(repository);
      await releaseCase(repository);
    });
    assert.equal(inspectSqlitePersonnelLifecycleOffboardingRows(context.database).valid, true);

    const dropForTamper = (triggerName, mutate) => {
      const trigger = PERSONNEL_LIFECYCLE_OFFBOARDING_TRIGGER_DEFINITIONS.find(
        ({ name }) => name === triggerName,
      );
      assert.ok(trigger, triggerName);
      context.database.exec(`DROP TRIGGER "${triggerName}"`);
      try {
        mutate();
      } finally {
        context.database.exec(trigger.sql);
      }
    };

    const releaseOperation = context.database.prepare(`
      SELECT * FROM personnel_lifecycle_offboarding_operations
      WHERE operation_type = 'communication_release'
    `).get();
    const changedOperation = {
      ...releaseOperation,
      subject_key: "abweichender-fallbezug",
    };
    changedOperation.result_receipt_sha256 = (
      personnelLifecycleOffboardingOperationReceiptSha256(changedOperation)
    );
    dropForTamper(
      "trg_personnel_lifecycle_offboarding_operations_o5_immutable_update",
      () => context.database.prepare(`
        UPDATE personnel_lifecycle_offboarding_operations
        SET subject_key = ?, result_receipt_sha256 = ?
        WHERE operation_id = ?
      `).run(
        changedOperation.subject_key,
        changedOperation.result_receipt_sha256,
        changedOperation.operation_id,
      ),
    );

    const releaseEvent = context.database.prepare(`
      SELECT * FROM personnel_lifecycle_case_events
      WHERE event_type = 'offboarding_communication_released'
    `).get();
    const changedEvent = {
      ...releaseEvent,
      data_classification: "personal_restricted",
    };
    changedEvent.receipt_sha256 = personnelLifecycleOffboardingCaseEventReceiptSha256(
      changedEvent,
    );
    dropForTamper(
      "trg_personnel_lifecycle_case_events_o4_immutable_update",
      () => context.database.prepare(`
        UPDATE personnel_lifecycle_case_events
        SET data_classification = ?, receipt_sha256 = ?
        WHERE id = ?
      `).run(
        changedEvent.data_classification,
        changedEvent.receipt_sha256,
        changedEvent.id,
      ),
    );

    const runtimeStep = context.database.prepare(`
      SELECT * FROM personnel_lifecycle_offboarding_runtime_steps
      ORDER BY run_id, sort_order
      LIMIT 1
    `).get();
    const changedRuntimeStep = {
      ...runtimeStep,
      data_classification: "hr_confidential",
    };
    changedRuntimeStep.receipt_sha256 = personnelLifecycleOffboardingRuntimeStepReceiptSha256(
      changedRuntimeStep,
    );
    dropForTamper(
      "trg_personnel_lifecycle_offboarding_runtime_steps_o5_immutable_update",
      () => context.database.prepare(`
        UPDATE personnel_lifecycle_offboarding_runtime_steps
        SET data_classification = ?, receipt_sha256 = ?
        WHERE run_id = ? AND step_reference = ?
      `).run(
        changedRuntimeStep.data_classification,
        changedRuntimeStep.receipt_sha256,
        changedRuntimeStep.run_id,
        changedRuntimeStep.step_reference,
      ),
    );

    assert.equal(inspectSqlitePersonnelLifecycleOffboardingSchema(context.database).valid, true);
    const inspection = inspectSqlitePersonnelLifecycleOffboardingRows(context.database);
    assert.equal(inspection.valid, false);
    assert.equal(inspection.issues.includes(
      `operation-subject:${changedOperation.operation_id}`,
    ), true);
    assert.equal(inspection.issues.includes(
      `operation-event:${changedOperation.operation_id}`,
    ), true);
    assert.equal(inspection.issues.includes("runtime-step-family-drift:1"), true);
    assert.equal(inspection.issues.some((issue) => issue.includes("-receipt:")), false);
  } finally {
    await context.close();
  }
});
