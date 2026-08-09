"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_CASE_PERMISSIONS: P,
  PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES,
  projectPersonnelLifecycleRecord,
} = require("../lib/personnel-lifecycle-case-contract");
const {
  PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS,
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS,
} = require("../lib/personnel-lifecycle-offboarding-contract");
const {
  createPersonnelLifecycleOffboardingService,
} = require("../lib/personnel-lifecycle-offboarding-service");
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
  inspectSqlitePersonnelLifecycleOffboardingRows,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-offboarding-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

const LOCATION = "o5-integration-location";
const DEPARTMENT = 9751;
const EMPLOYEE = "EMP-O5-INTEGRATION";
const HR = "HR-O5-INTEGRATION";
const BASE_TIME = Date.parse("2026-08-03T12:00:00.000Z");
const RECIPIENTS = Object.freeze(
  PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map(
    (_definition, index) => `O5-INTEGRATION-RECIPIENT-${index + 1}`,
  ),
);
const RECIPIENT_ROLE_BY_CLASS = Object.freeze({
  leadership: "manager",
  it_security: "it_admin",
  asset_custodian: "manager",
  payroll: "hr",
});

function operationId(index) {
  return `a5000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function protectionFunctions() {
  return {
    protectJson(value, context) {
      assert.equal(typeof context.employeeNumber, "string");
      assert.notEqual(context.employeeNumber.trim(), "");
      return `enc:v2:${Buffer.from(JSON.stringify({ context, value }), "utf8").toString("base64")}`;
    },
    parseProtectedJson(payload, expectedContext) {
      assert.match(payload, /^enc:v2:/);
      const decoded = JSON.parse(
        Buffer.from(payload.slice("enc:v2:".length), "base64").toString("utf8"),
      );
      assert.deepEqual(decoded.context, expectedContext);
      return decoded.value;
    },
  };
}

function accessFor(actorId) {
  return {
    actorId,
    namedActor: true,
    personalEmployee: true,
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
      if (context.recipientClass
        !== PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES[projection]) return null;
      return projectPersonnelLifecycleRecord(source, projection);
    },
  };
}

function preparationInput(operationIndex) {
  return {
    operationId: operationId(operationIndex),
    employeeNumber: EMPLOYEE,
    responsibleActorId: HR,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.PREPARATION,
    referenceTimes: {
      plannedExitAt: "2026-08-03T10:00:00.000Z",
      lastWorkingDay: "2026-08-28",
      legalExitDate: "2026-08-31",
      accessBlockAt: "2026-08-28T16:00:00.000Z",
    },
    urgency: {
      mode: "standard",
      confirmation: null,
      exceptionReason: null,
      followUpDueAt: null,
    },
    exitReason: {
      code: "employee_notice",
      note: "Synthetischer geschuetzter Austrittsgrund.",
    },
    hrNote: "Synthetischer geschuetzter Integrationsvermerk.",
    documentReferenceIds: ["DOC-O5-INTEGRATION"],
    assignments: PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.map(
      (definition, index) => ({
        familyCode: definition.familyCode,
        assigneeActorId: RECIPIENTS[index],
        title: `Geschuetzter Integrationstitel ${index + 1}`,
        instructions: `Geschuetzte Integrationsanweisung ${index + 1}.`,
      }),
    ),
  };
}

function mutationReason(code) {
  return {
    code,
    note: "Synthetische geschuetzte Integrationsbegruendung.",
    documentReferenceIds: ["DOC-O5-INTEGRATION-MUTATION"],
  };
}

function parsedStringArray(value) {
  const parsed = Array.isArray(value) ? value : JSON.parse(String(value || "[]"));
  return parsed.map((entry) => String(entry));
}

function createContext() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active)
      VALUES ('${LOCATION}', 'O5 Integrationsstandort', 1);
    INSERT INTO departments (id, location_id, name, active)
      VALUES (${DEPARTMENT}, '${LOCATION}', 'O5 Integrationsabteilung', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (
      '${EMPLOYEE}', 'O5 Zielperson', 'Zielperson', '${LOCATION}', ${DEPARTMENT}, 1
    );
  `);
  const insertEmployee = application.database.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES (?, ?, ?, ?, ?, 1)
  `);
  const insertPortalUser = application.database.prepare(`
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password
    ) VALUES (?, 'synthetic-test-only', ?, 1, 0)
  `);
  const grantOperationalPermission = application.database.prepare(`
    INSERT INTO portal_permission_grants (
      employee_number, permission, granted_by
    ) VALUES (?, ?, ?)
  `);
  insertEmployee.run(HR, "O5 Personalstelle", "HR", LOCATION, DEPARTMENT);
  insertPortalUser.run(HR, "hr");
  RECIPIENTS.forEach((actorId, index) => {
    insertEmployee.run(
      actorId,
      `O5 Empfaenger ${index + 1}`,
      `Empfaenger ${index + 1}`,
      LOCATION,
      DEPARTMENT,
    );
    const recipientClass = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS[index]
      .recipientClass;
    insertPortalUser.run(actorId, RECIPIENT_ROLE_BY_CLASS[recipientClass]);
    grantOperationalPermission.run(actorId, P.OPERATIONAL_READ, HR);
    grantOperationalPermission.run(actorId, P.OPERATIONAL_UPDATE, HR);
  });

  const repository = createCustomProcessManagementRepository(application.provider);
  let clockTick = 0;
  const service = createPersonnelLifecycleOffboardingService(repository, {
    ...protectionFunctions(),
    now: () => new Date(BASE_TIME + clockTick++ * 1000),
    canAssignRecipient: async ({
      recipient,
      scope,
      subjectEmployeeNumber,
      familyCode,
      recipientClass,
    }) => {
      const familyIndex = PERSONNEL_LIFECYCLE_OFFBOARDING_FAMILY_DEFINITIONS.findIndex(
        (definition) => definition.familyCode === familyCode,
      );
      const grants = new Set(parsedStringArray(recipient.granted_permissions));
      const denials = new Set(parsedStringArray(recipient.denied_permissions));
      return familyIndex >= 0
        && recipient.employee_number === RECIPIENTS[familyIndex]
        && recipient.employee_number !== subjectEmployeeNumber
        && recipient.role === RECIPIENT_ROLE_BY_CLASS[recipientClass]
        && grants.has(P.OPERATIONAL_READ)
        && grants.has(P.OPERATIONAL_UPDATE)
        && !denials.has(P.OPERATIONAL_READ)
        && !denials.has(P.OPERATIONAL_UPDATE)
        && scope.type === "department"
        && scope.locationId === LOCATION
        && Number(scope.departmentId) === DEPARTMENT
        && recipient.home_location_id === LOCATION
        && Number(recipient.preferred_department_id) === DEPARTMENT;
    },
  });
  return {
    ...application,
    repository,
    service,
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

function assertProtectedRows(database, { includeTerminations = false } = {}) {
  const sources = [
    ["personnel_employment_episodes", "protected_payload"],
    ["personnel_lifecycle_cases", "protected_payload"],
    ["personnel_lifecycle_case_reference_dates", "protected_payload"],
    ["personnel_lifecycle_case_events", "protected_payload"],
    ["personnel_lifecycle_offboarding_package_versions", "protected_snapshot"],
    ["personnel_lifecycle_offboarding_runtime_steps", "protected_payload"],
    ["personnel_lifecycle_offboarding_operations", "protected_result_payload"],
  ];
  if (includeTerminations) {
    sources.push(["personnel_lifecycle_offboarding_run_terminations", "protected_payload"]);
  }
  for (const [tableName, columnName] of sources) {
    const values = database.prepare(
      `SELECT "${columnName}" AS value FROM "${tableName}"`,
    ).all();
    assert.notEqual(values.length, 0, tableName);
    assert.equal(values.every(({ value }) => /^enc:v2:/.test(value)), true, tableName);
  }
  assert.deepEqual(
    database.prepare("SELECT DISTINCT title FROM custom_processes ORDER BY title")
      .all().map((row) => ({ ...row })),
    [{ title: "Geschützter Personalprozess" }],
  );
}

async function prepareAndRelease(context, operationOffset) {
  const preparation = preparationInput(operationOffset);
  const prepared = await context.service.prepare(HR, preparation, { access: accessFor(HR) });
  assert.equal(prepared.state, "internally_prepared");
  assert.equal(prepared.runtimeCount, 0);
  assert.equal(context.database.prepare(
    "SELECT COUNT(*) AS count FROM personnel_employment_episodes",
  ).get().count, 1);
  assert.equal(context.database.prepare(
    "SELECT state FROM personnel_employment_episodes",
  ).get().state, "employment_active");

  const prepareReplay = await context.service.prepare(
    HR,
    structuredClone(preparation),
    { access: accessFor(HR) },
  );
  assert.equal(prepareReplay.replayed, true);
  assert.equal(prepareReplay.caseId, prepared.caseId);

  const releaseInput = {
    operationId: operationId(operationOffset + 1),
    caseId: prepared.caseId,
    expectedRevision: 1,
    confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.COMMUNICATION_RELEASE,
    reason: mutationReason("communication_approved"),
  };
  const released = await context.service.releaseCommunication(
    HR,
    releaseInput,
    { access: accessFor(HR) },
  );
  assert.equal(released.state, "communication_released");
  assert.equal(released.runtimeCount, 6);
  const releaseReplay = await context.service.releaseCommunication(
    HR,
    structuredClone(releaseInput),
    { access: accessFor(HR) },
  );
  assert.equal(releaseReplay.replayed, true);
  return prepared.caseId;
}

test("O5-Service durchlaeuft mit echtem SQLite-Repository den vollstaendigen Abschluss", async () => {
  const context = createContext();
  try {
    const caseId = await prepareAndRelease(context, 1);
    const informed = await context.service.confirmInformation(HR, {
      operationId: operationId(3),
      caseId,
      expectedRevision: 2,
      confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.INFORMATION_CONFIRMATION,
      employeeInformedAt: "2026-08-03T11:30:00.000Z",
    }, { access: accessFor(HR) });
    assert.equal(informed.state, "employee_informed");

    const activated = await context.service.activate(HR, {
      operationId: operationId(4),
      caseId,
      expectedRevision: 3,
      confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.ACTIVATION,
    }, { access: accessFor(HR) });
    assert.equal(activated.activeRunCount, 6);

    const assignments = await context.repository.listOffboardingAssignments({ caseId });
    assert.equal(assignments.length, 6);
    for (let index = 0; index < assignments.length; index += 1) {
      const assignment = assignments[index];
      const completionInput = {
        operationId: operationId(10 + index),
        action: "complete",
      };
      const completed = await context.service.completeTask(
        assignment.assignee_actor_id,
        assignment.run_id,
        assignment.runtime_step_reference,
        completionInput,
        { access: accessFor(assignment.assignee_actor_id) },
      );
      assert.equal(completed.status, "completed");
      if (index === 0) {
        const replay = await context.service.completeTask(
          assignment.assignee_actor_id,
          assignment.run_id,
          assignment.runtime_step_reference,
          structuredClone(completionInput),
          { access: accessFor(assignment.assignee_actor_id) },
        );
        assert.equal(replay.replayed, true);
      }
    }

    const closeInput = {
      operationId: operationId(20),
      caseId,
      expectedRevision: 4,
      confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CLOSE,
    };
    const closed = await context.service.close(HR, closeInput, { access: accessFor(HR) });
    assert.equal(closed.state, "completed");
    const closeReplay = await context.service.close(
      HR,
      structuredClone(closeInput),
      { access: accessFor(HR) },
    );
    assert.equal(closeReplay.replayed, true);

    assert.deepEqual({ ...context.database.prepare(`
      SELECT lifecycle_case.state AS case_state, episode.state AS episode_state
      FROM personnel_lifecycle_cases lifecycle_case
      JOIN personnel_employment_episodes episode
        ON episode.id = lifecycle_case.employment_episode_id
      WHERE lifecycle_case.id = ?
    `).get(caseId) }, {
      case_state: "completed",
      episode_state: "employment_ended",
    });
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_run_steps WHERE status = 'completed'
    `).get().count, 6);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_runs WHERE status = 'resolved'
    `).get().count, 6);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM personnel_lifecycle_case_events
    `).get().count, 11);
    assertProtectedRows(context.database);
    assert.deepEqual(inspectSqlitePersonnelLifecycleOffboardingRows(context.database), {
      valid: true,
      absent: false,
      issues: [],
    });
  } finally {
    await context.close();
  }
});

test("O5-Service bricht echte SQLite-Runs additiv ab und replayt den Abbruch", async () => {
  const context = createContext();
  try {
    const caseId = await prepareAndRelease(context, 101);
    const cancelInput = {
      operationId: operationId(103),
      caseId,
      expectedRevision: 2,
      confirmation: PERSONNEL_LIFECYCLE_OFFBOARDING_CONFIRMATIONS.CANCELLATION,
      reason: mutationReason("exit_withdrawn"),
    };
    const cancelled = await context.service.cancel(
      HR,
      cancelInput,
      { access: accessFor(HR) },
    );
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.terminatedRunCount, 6);
    const replay = await context.service.cancel(
      HR,
      structuredClone(cancelInput),
      { access: accessFor(HR) },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.terminatedRunCount, 6);

    assert.deepEqual({ ...context.database.prepare(`
      SELECT lifecycle_case.state AS case_state, episode.state AS episode_state
      FROM personnel_lifecycle_cases lifecycle_case
      JOIN personnel_employment_episodes episode
        ON episode.id = lifecycle_case.employment_episode_id
      WHERE lifecycle_case.id = ?
    `).get(caseId) }, {
      case_state: "cancelled",
      episode_state: "employment_active",
    });
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count
      FROM personnel_lifecycle_offboarding_run_terminations
    `).get().count, 6);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_runs WHERE status = 'resolved'
    `).get().count, 6);
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS count FROM custom_process_run_steps WHERE status = 'skipped'
    `).get().count, 0);
    assertProtectedRows(context.database, { includeTerminations: true });
    assert.deepEqual(inspectSqlitePersonnelLifecycleOffboardingRows(context.database), {
      valid: true,
      absent: false,
      issues: [],
    });
  } finally {
    await context.close();
  }
});
