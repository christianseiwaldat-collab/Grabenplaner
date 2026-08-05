"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAmuStorage } = require("../lib/amu-storage");
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
  inspectSqlitePersonnelLifecycleOnboardingRows,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-onboarding-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  createPersonnelLifecycleOnboardingExecutionService,
} = require("../lib/personnel-lifecycle-onboarding-execution");
const {
  createPersonnelLifecycleOnboardingProfilePreview,
} = require("../lib/personnel-lifecycle-onboarding-preview");
const {
  previewSha256,
} = require("../lib/personnel-lifecycle-onboarding-receipt");
const {
  completePersonnelLifecycleOnboardingTaskInTransaction,
  instantiatePersonnelLifecycleOnboardingInTransaction,
} = require("../lib/personnel-workflow-instances");
const {
  createPersonnelLifecycleOnboardingTaskService,
} = require("../lib/personnel-lifecycle-onboarding-tasks");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("../lib/personnel-workflow-publication-receipt");

const LOCATION = "o4-execution-location";
const DEPARTMENT = 9411;
const EMPLOYEE = "EMP-O4-EXEC";
const ACTOR = "HR-O4-EXEC";
const MANAGER = "FL-O4-EXEC";
const BASE_PUBLICATION = "publication-o4-base";
const PERSONNEL_PUBLICATION = "publication-o4-personnel";
const FIXED_STEP = "base-fixed-hr";
const ROLE_STEP = "personnel-manager-choice";
const STARTED_AT = "2026-08-03T12:00:00.000Z";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

const RUNTIME_TABLES = Object.freeze([
  "personnel_employment_episodes",
  "personnel_lifecycle_cases",
  "personnel_lifecycle_case_reference_dates",
  "personnel_lifecycle_case_package_bindings",
  "personnel_lifecycle_case_package_runs",
  "personnel_lifecycle_case_assignments",
  "personnel_lifecycle_case_assignment_bindings",
  "personnel_lifecycle_case_events",
  "personnel_lifecycle_onboarding_operations",
  "custom_process_runs",
  "custom_process_run_bindings",
  "custom_process_run_steps",
  "custom_process_run_step_assignments",
  "audit_log",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runtimeCounts(database) {
  return Object.fromEntries(RUNTIME_TABLES.map((tableName) => [
    tableName,
    database.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count,
  ]));
}

function nextOperationId(index) {
  return `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`;
}

function fullAccess(overrides = {}) {
  return {
    actorId: ACTOR,
    namedActor: true,
    central: true,
    canReadOnboarding: true,
    canPrepareOnboarding: true,
    canApproveOnboarding: true,
    canExecuteOnboarding: true,
    canReadPackages: true,
    canWritePackages: true,
    canPublishPackages: true,
    canWriteAssignments: true,
    ...overrides,
  };
}

function taskAccess(actorId, overrides = {}) {
  return {
    actorId,
    namedActor: true,
    canReadOperational: true,
    canUpdateOperational: true,
    canCloseOnboarding: true,
    canReadOperationalScope: ({ operationalReleased }) => operationalReleased === true,
    canUpdateOperationalScope: ({ operationalReleased }) => operationalReleased === true,
    canAuthorizeTransition: (caseType, fromState, toState) => (
      caseType === "onboarding" && fromState === "active" && toState === "completed"
    ),
    ...overrides,
  };
}

function startStep({
  id,
  title,
  responsibilityType,
  responsibilityReference,
  notificationChannels = [],
}) {
  return {
    id,
    type: "actor",
    title,
    description: "Synthetischer O4-Ausfuehrungstest.",
    responsibilityType,
    responsibilityReference,
    responsibilityLabel: responsibilityType === "employee"
      ? "Personalstelle"
      : "Filialleitung",
    conditionType: "always",
    conditionText: "",
    notificationChannels,
  };
}

async function insertPublication(repository, {
  publicationId,
  processId,
  workflowCode,
  title,
  step,
}) {
  const snapshotJson = JSON.stringify({
    id: processId,
    revision: 1,
    title,
    scope: { type: "company", locationId: null, departmentId: null },
    steps: [step],
  });
  await repository.insertProcess({
    id: processId,
    title,
    symbol: "O4",
    description: "Synthetisches O4-Pflichtpaket",
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
    processId,
    revision: 1,
    snapshotJson,
    actor: ACTOR,
  });
  const publication = {
    id: publicationId,
    process_id: processId,
    source_revision: 1,
    version_number: 1,
    workflow_code: workflowCode,
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
    published_at: STARTED_AT,
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
}

async function previewFor(repository, canAssignRecipient) {
  const [subject, publications, recipients] = await Promise.all([
    repository.personnelWorkflowEmployeeSubject({ employeeNumber: EMPLOYEE }),
    repository.listWorkflowPublications({ includeArchived: 1 }),
    repository.listRecipientCandidates(),
  ]);
  return createPersonnelLifecycleOnboardingProfilePreview({
    subject,
    publications,
    recipients,
    canPreviewRecipient: canAssignRecipient,
  });
}

function inputFor(preview, operationId = OPERATION_ID) {
  const familyByPublication = {
    [BASE_PUBLICATION]: "base_security_privacy",
    [PERSONNEL_PUBLICATION]: "personnel_administration",
  };
  const assigneeByStep = {
    [FIXED_STEP]: ACTOR,
    [ROLE_STEP]: MANAGER,
  };
  return {
    operationId,
    employeeNumber: EMPLOYEE,
    expectedPreviewSha256: previewSha256(preview),
    responsibleActorId: ACTOR,
    confirmation: "START_ONBOARDING",
    confirmations: {
      responsibility: true,
      packages: true,
      lifecycleReviews: true,
      assignments: true,
      atomicStart: true,
    },
    referenceDates: {
      contractualEntryDate: "2026-08-10",
      firstWorkingDay: "2026-08-11",
      onboardingTargetDate: "2026-08-31",
    },
    packageBindings: preview.packageResolution.packages.map((entry) => ({
      publicationId: entry.publicationId,
      versionNumber: entry.versionNumber,
      familyCodes: [familyByPublication[entry.publicationId]],
      reviewConfirmed: true,
      assignments: entry.assignments.map(({ stepReference }) => ({
        stepReference,
        assigneeActorId: assigneeByStep[stepReference],
      })),
    })),
  };
}

function protectionContext(namespace, recordId) {
  return { namespace, recordId, field: "payload", employeeNumber: EMPLOYEE };
}

async function rejectCode(promise, code, kind) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    if (kind) assert.equal(error?.kind, kind);
    return true;
  });
}

async function fixture({ notificationChannels = [] } = {}) {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active)
      VALUES ('${LOCATION}', 'O4 Ausfuehrungsstandort', 1);
    INSERT INTO departments (id, location_id, name, active)
      VALUES (${DEPARTMENT}, '${LOCATION}', 'O4 Ausfuehrungsabteilung', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, active
    ) VALUES
      ('${EMPLOYEE}', 'O4 Zielperson', 'Ziel', '${LOCATION}', ${DEPARTMENT}, 1),
      ('${ACTOR}', 'O4 Personalstelle', 'HR', '${LOCATION}', ${DEPARTMENT}, 1),
      ('${MANAGER}', 'O4 Filialleitung', 'FL', '${LOCATION}', ${DEPARTMENT}, 1);
    INSERT INTO portal_roles (
      id, name, description, builtin, permissions, sort_order
    ) VALUES
      ('hr', 'Personalstelle', 'O4 Testrolle', 1,
        '["personnel:workflows:read"]', 30),
      ('manager', 'Filialleitung', 'O4 Testrolle', 1,
        '["personnel:workflows:read"]', 20);
    INSERT INTO portal_users (
      employee_number, password_hash, role, active, must_change_password
    ) VALUES
      ('${ACTOR}', 'test-only', 'hr', 1, 0),
      ('${MANAGER}', 'test-only', 'manager', 1, 0);
    INSERT INTO portal_permission_grants (
      employee_number, permission, granted_by
    ) VALUES
      ('${ACTOR}', 'personnel:workflows:read', '${ACTOR}'),
      ('${MANAGER}', 'personnel:workflows:read', '${ACTOR}');
    INSERT INTO portal_access_scopes (
      employee_number, location_id, department_id, assigned_by
    ) VALUES ('${MANAGER}', '${LOCATION}', 0, '${ACTOR}');
    INSERT INTO portal_permission_scope_grants (
      employee_number, permission, location_id, department_id, approved_by
    ) VALUES (
      '${MANAGER}', 'personnel:workflows:read', '${LOCATION}', 0, '${ACTOR}'
    );
  `);

  const repository = createCustomProcessManagementRepository(application.provider);
  await insertPublication(repository, {
    publicationId: BASE_PUBLICATION,
    processId: "process-o4-base",
    workflowCode: "onboarding.o4.base",
    title: "O4 Basis und Datenschutz",
    step: startStep({
      id: FIXED_STEP,
      title: "Grundunterlagen pruefen",
      responsibilityType: "employee",
      responsibilityReference: ACTOR,
      notificationChannels,
    }),
  });
  await insertPublication(repository, {
    publicationId: PERSONNEL_PUBLICATION,
    processId: "process-o4-personnel",
    workflowCode: "onboarding.o4.personnel",
    title: "O4 Personaladministration",
    step: startStep({
      id: ROLE_STEP,
      title: "Ersten Arbeitstag vorbereiten",
      responsibilityType: "role",
      responsibilityReference: "manager",
    }),
  });

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-o4-execution-"));
  const storage = createAmuStorage({
    rootDirectory: storageRoot,
    encryptionKeys: {
      test: crypto.createHash("sha256").update("o4-execution-test-key").digest(),
    },
    activeKeyId: "test",
    scanner: async () => true,
  });
  let uuidCounter = 1;
  const randomUUID = () => (
    `00000000-0000-4000-8000-${(uuidCounter++).toString(16).padStart(12, "0")}`
  );
  const canAssignRecipient = async ({ recipient }) => (
    recipient?.employee_number === ACTOR || recipient?.employee_number === MANAGER
  );
  const serviceFor = (primitive = instantiatePersonnelLifecycleOnboardingInTransaction) => (
    createPersonnelLifecycleOnboardingExecutionService(repository, {
      instantiatePersonnelLifecycleOnboardingInTransaction: primitive,
      canAssignRecipient,
      protectJson: (value, context) => storage.protectRecord(JSON.stringify(value), context),
      parseProtectedJson: (value, context) => JSON.parse(storage.unprotectRecord(value, context)),
      now: () => new Date(STARTED_AT),
      randomUUID,
    })
  );
  const preview = await previewFor(repository, canAssignRecipient);
  return {
    ...application,
    repository,
    storage,
    preview,
    serviceFor,
    input: inputFor(preview),
    async close() {
      try {
        await application.provider.close();
      } finally {
        application.database.close();
        fs.rmSync(storageRoot, { recursive: true, force: true });
      }
    },
  };
}

test("O4 startet zwei Pflichtpakete atomar mit expliziter Fest- und Rollenzuweisung", async () => {
  const context = await fixture();
  try {
    const before = runtimeCounts(context.database);
    const result = await context.serviceFor().start(context.input, {
      actorId: ACTOR,
      access: fullAccess(),
    });

    assert.equal(result.replayed, false);
    assert.equal(result.state, "active");
    assert.equal(result.packageCount, 2);
    assert.equal(result.assignmentCount, 2);
    assert.equal(new Set(result.packages.map(({ runId }) => runId)).size, 2);
    assert.deepEqual(
      result.packages.map(({ publicationId }) => publicationId).sort(),
      [BASE_PUBLICATION, PERSONNEL_PUBLICATION],
    );

    const episode = context.database.prepare(`
      SELECT * FROM personnel_employment_episodes WHERE id = ?
    `).get(result.employmentEpisodeId);
    const lifecycleCase = context.database.prepare(`
      SELECT * FROM personnel_lifecycle_cases WHERE id = ?
    `).get(result.caseId);
    const referenceDates = context.database.prepare(`
      SELECT * FROM personnel_lifecycle_case_reference_dates WHERE case_id = ?
    `).get(result.caseId);
    const events = context.database.prepare(`
      SELECT * FROM personnel_lifecycle_case_events
      WHERE case_id = ? ORDER BY sequence_number
    `).all(result.caseId);

    for (const row of [episode, lifecycleCase, referenceDates, ...events]) {
      assert.match(row.protected_payload, /^enc:v2:/);
    }
    assert.deepEqual(JSON.parse(context.storage.unprotectRecord(
      episode.protected_payload,
      protectionContext("personnel-employment-episode", episode.id),
    )), {
      schemaVersion: 1,
      source: "controlled_onboarding_start",
      employeeNumber: EMPLOYEE,
    });
    const decryptedCase = JSON.parse(context.storage.unprotectRecord(
      lifecycleCase.protected_payload,
      protectionContext("personnel-lifecycle-case", lifecycleCase.id),
    ));
    assert.equal(decryptedCase.operationId, OPERATION_ID);
    assert.deepEqual(decryptedCase.familyMapping, {
      base_security_privacy: BASE_PUBLICATION,
      personnel_administration: PERSONNEL_PUBLICATION,
    });
    assert.deepEqual(JSON.parse(context.storage.unprotectRecord(
      referenceDates.protected_payload,
      protectionContext("personnel-lifecycle-reference-dates", referenceDates.id),
    )), {
      schemaVersion: 1,
      contractualEntryDate: "2026-08-10",
      firstWorkingDay: "2026-08-11",
      onboardingTargetDate: "2026-08-31",
    });
    assert.deepEqual(events.map(({ event_type }) => event_type), [
      "onboarding_prepared",
      "onboarding_approved",
      "onboarding_started",
    ]);
    for (const event of events) {
      const payload = JSON.parse(context.storage.unprotectRecord(
        event.protected_payload,
        protectionContext("personnel-lifecycle-case-event", event.id),
      ));
      assert.equal(payload.schemaVersion, 1);
      assert.equal(payload.operationId, OPERATION_ID);
    }

    const packageLinks = context.database.prepare(`
      SELECT
        lifecycle_run.package_binding_id,
        lifecycle_run.run_id,
        lifecycle_run.run_operation_id,
        lifecycle_run.family_codes_json,
        package_binding.publication_id,
        package_binding.version_number,
        run.trigger_type,
        run.trigger_key,
        run_binding.publication_id AS instantiated_publication_id,
        run_binding.employee_number AS subject_employee_number
      FROM personnel_lifecycle_case_package_runs lifecycle_run
      JOIN personnel_lifecycle_case_package_bindings package_binding
        ON package_binding.id = lifecycle_run.package_binding_id
      JOIN custom_process_runs run ON run.id = lifecycle_run.run_id
      JOIN custom_process_run_bindings run_binding
        ON run_binding.run_id = lifecycle_run.run_id
      WHERE package_binding.case_id = ?
      ORDER BY package_binding.publication_id
    `).all(result.caseId);
    assert.equal(packageLinks.length, 2);
    for (const link of packageLinks) {
      assert.equal(link.version_number, 1);
      assert.equal(link.trigger_type, "personnel_manual");
      assert.equal(link.trigger_key, `personnel:${link.run_operation_id}`);
      assert.equal(link.instantiated_publication_id, link.publication_id);
      assert.equal(link.subject_employee_number, EMPLOYEE);
      assert.equal(
        result.packages.some((entry) => (
          entry.packageBindingId === link.package_binding_id
          && entry.runId === link.run_id
          && entry.publicationId === link.publication_id
        )),
        true,
      );
    }
    assert.deepEqual(
      Object.fromEntries(packageLinks.map((row) => [
        row.publication_id,
        JSON.parse(row.family_codes_json),
      ])),
      {
        [BASE_PUBLICATION]: ["base_security_privacy"],
        [PERSONNEL_PUBLICATION]: ["personnel_administration"],
      },
    );

    const assignmentLinks = context.database.prepare(`
      SELECT
        package_binding.publication_id,
        lifecycle_assignment.step_reference,
        lifecycle_assignment.assignee_actor_id,
        lifecycle_binding.run_id,
        run_assignment.employee_number,
        run_assignment.responsibility_type,
        run_assignment.responsibility_reference
      FROM personnel_lifecycle_case_assignment_bindings lifecycle_binding
      JOIN personnel_lifecycle_case_assignments lifecycle_assignment
        ON lifecycle_assignment.id = lifecycle_binding.assignment_id
      JOIN personnel_lifecycle_case_package_bindings package_binding
        ON package_binding.id = lifecycle_binding.package_binding_id
      JOIN custom_process_run_step_assignments run_assignment
        ON run_assignment.run_id = lifecycle_binding.run_id
        AND run_assignment.step_id = lifecycle_binding.step_reference
      WHERE package_binding.case_id = ?
      ORDER BY package_binding.publication_id
    `).all(result.caseId);
    assert.deepEqual(assignmentLinks.map((row) => ({
      publicationId: row.publication_id,
      stepReference: row.step_reference,
      assigneeActorId: row.assignee_actor_id,
      m5Assignee: row.employee_number,
      responsibilityType: row.responsibility_type,
      responsibilityReference: row.responsibility_reference,
    })), [
      {
        publicationId: BASE_PUBLICATION,
        stepReference: FIXED_STEP,
        assigneeActorId: ACTOR,
        m5Assignee: ACTOR,
        responsibilityType: "employee",
        responsibilityReference: ACTOR,
      },
      {
        publicationId: PERSONNEL_PUBLICATION,
        stepReference: ROLE_STEP,
        assigneeActorId: MANAGER,
        m5Assignee: MANAGER,
        responsibilityType: "role",
        responsibilityReference: "manager",
      },
    ]);
    assert.deepEqual(inspectSqlitePersonnelLifecycleOnboardingRows(context.database), {
      valid: true,
      issues: [],
    });
    const after = runtimeCounts(context.database);
    assert.equal(after.personnel_lifecycle_onboarding_operations - before.personnel_lifecycle_onboarding_operations, 1);
    assert.equal(after.custom_process_runs - before.custom_process_runs, 2);
    assert.equal(after.custom_process_run_step_assignments - before.custom_process_run_step_assignments, 2);
    assert.equal(after.audit_log - before.audit_log, 3);
  } finally {
    await context.close();
  }
});

test("O4 spielt denselben Auftrag ohne neue Zeile oder Audit wieder ab und sperrt geaenderten Inhalt", async () => {
  const context = await fixture();
  try {
    const service = context.serviceFor();
    const first = await service.start(context.input, { actorId: ACTOR, access: fullAccess() });
    const afterFirst = runtimeCounts(context.database);
    const replayed = await service.start(clone(context.input), {
      actorId: ACTOR,
      access: fullAccess(),
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.caseId, first.caseId);
    assert.deepEqual(runtimeCounts(context.database), afterFirst);

    const changed = clone(context.input);
    changed.referenceDates.onboardingTargetDate = "2026-09-01";
    await rejectCode(
      service.start(changed, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_OPERATION_CONFLICT",
      "conflict",
    );
    assert.deepEqual(runtimeCounts(context.database), afterFirst);
  } finally {
    await context.close();
  }
});

test("O4 sperrt fehlendes Einzelrecht, Bestaetigung, Vorschau- und Aufloesungsmanipulationen vor jedem Write", async () => {
  const context = await fixture();
  try {
    const service = context.serviceFor();
    const baseline = runtimeCounts(context.database);

    await rejectCode(
      service.start(context.input, {
        actorId: ACTOR,
        access: fullAccess({ canExecuteOnboarding: false }),
      }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_PERMISSION_REQUIRED",
      "forbidden",
    );

    const withoutConfirmation = clone(context.input);
    withoutConfirmation.operationId = nextOperationId(1);
    withoutConfirmation.confirmations.assignments = false;
    await rejectCode(
      service.start(withoutConfirmation, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_CONFIRMATION_REQUIRED",
      "input",
    );

    const stalePreview = clone(context.input);
    stalePreview.operationId = nextOperationId(2);
    stalePreview.expectedPreviewSha256 = "0".repeat(64);
    await rejectCode(
      service.start(stalePreview, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_PREVIEW_STALE",
      "conflict",
    );

    const familyManipulation = clone(context.input);
    familyManipulation.operationId = nextOperationId(3);
    for (const binding of familyManipulation.packageBindings) {
      binding.familyCodes = ["base_security_privacy"];
    }
    await rejectCode(
      service.start(familyManipulation, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_FAMILY_MAPPING_INVALID",
      "input",
    );

    const packageManipulation = clone(context.input);
    packageManipulation.operationId = nextOperationId(4);
    packageManipulation.packageBindings[0].versionNumber = 2;
    await rejectCode(
      service.start(packageManipulation, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_PREVIEW_STALE",
      "conflict",
    );

    const assignmentManipulation = clone(context.input);
    assignmentManipulation.operationId = nextOperationId(5);
    const roleBinding = assignmentManipulation.packageBindings.find(({ publicationId }) => (
      publicationId === PERSONNEL_PUBLICATION
    ));
    roleBinding.assignments[0].assigneeActorId = ACTOR;
    await rejectCode(
      service.start(assignmentManipulation, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_ASSIGNMENT_STALE",
      "conflict",
    );

    assert.deepEqual(runtimeCounts(context.database), baseline);
  } finally {
    await context.close();
  }
});

test("O4 rollt Episode, Fall, erste M5-Instanz und Audits bei injiziertem Fehler vollstaendig zurueck", async () => {
  const context = await fixture();
  try {
    const baseline = runtimeCounts(context.database);
    const injectedPrimitive = async (...args) => {
      await instantiatePersonnelLifecycleOnboardingInTransaction(...args);
      throw new Error("o4-fault-after-m5-package");
    };
    await assert.rejects(
      context.serviceFor(injectedPrimitive).start(context.input, {
        actorId: ACTOR,
        access: fullAccess(),
      }),
      /o4-fault-after-m5-package/,
    );
    assert.deepEqual(runtimeCounts(context.database), baseline);
    assert.deepEqual(inspectSqlitePersonnelLifecycleOnboardingRows(context.database), {
      valid: true,
      issues: [],
    });
  } finally {
    await context.close();
  }
});

test("O4 sperrt Publikations-Benachrichtigungen vor jedem Laufzeit-Write", async () => {
  const context = await fixture({ notificationChannels: ["email"] });
  try {
    const baseline = runtimeCounts(context.database);
    assert.equal(context.preview.blockers.some(({ code }) => (
      code === "onboarding_notifications_deferred"
    )), true);
    await rejectCode(
      context.serviceFor().start(context.input, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_NOTIFICATIONS_DEFERRED",
      "conflict",
    );
    assert.deepEqual(runtimeCounts(context.database), baseline);
  } finally {
    await context.close();
  }
});

test("O4 verweigert einen zweiten Start mit neuer Operations-ID fuer denselben offenen Fall", async () => {
  const context = await fixture();
  try {
    const service = context.serviceFor();
    const first = await service.start(context.input, { actorId: ACTOR, access: fullAccess() });
    const afterFirst = runtimeCounts(context.database);
    const duplicate = clone(context.input);
    duplicate.operationId = nextOperationId(6);
    await rejectCode(
      service.start(duplicate, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_CASE_EXISTS",
      "conflict",
    );
    assert.deepEqual(runtimeCounts(context.database), afterFirst);
    assert.equal((await context.repository.currentEpisodeOnboardingCaseForEmployee({
      employeeNumber: EMPLOYEE,
    })).id, first.caseId);
  } finally {
    await context.close();
  }
});

test("O4 fuehrt den echten Start ueber eigene Aufgaben bis zum idempotenten Fallabschluss", async () => {
  const context = await fixture();
  try {
    const started = await context.serviceFor().start(context.input, {
      actorId: ACTOR,
      access: fullAccess(),
    });
    const taskService = createPersonnelLifecycleOnboardingTaskService(context.repository, {
      completePersonnelLifecycleOnboardingTaskInTransaction,
      protectJson: (value, protection) => (
        context.storage.protectRecord(JSON.stringify(value), protection)
      ),
      parseProtectedJson: (value, protection) => (
        JSON.parse(context.storage.unprotectRecord(value, protection))
      ),
      now: () => new Date("2026-08-03T12:30:00.000Z"),
    });

    const hrTasks = await taskService.listActiveTasks(ACTOR, {
      access: taskAccess(ACTOR),
    });
    const managerTasks = await taskService.listActiveTasks(MANAGER, {
      access: taskAccess(MANAGER),
    });
    assert.equal(hrTasks.items.length, 1);
    assert.equal(managerTasks.items.length, 1);
    assert.equal(hrTasks.items[0].caseId, started.caseId);
    assert.equal(managerTasks.items[0].caseId, started.caseId);

    await taskService.completeTask(
      ACTOR,
      hrTasks.items[0].runId,
      hrTasks.items[0].stepId,
      { operationId: nextOperationId(101), action: "complete" },
      { access: taskAccess(ACTOR) },
    );
    await taskService.completeTask(
      MANAGER,
      managerTasks.items[0].runId,
      managerTasks.items[0].stepId,
      { operationId: nextOperationId(102), action: "complete" },
      { access: taskAccess(MANAGER) },
    );

    const closed = await taskService.closeCase(
      ACTOR,
      started.caseId,
      { operationId: nextOperationId(103), confirmation: "CLOSE_ONBOARDING" },
      { access: taskAccess(ACTOR) },
    );
    assert.equal(closed.state, "completed");
    assert.equal(closed.replayed, false);
    const replayed = await taskService.closeCase(
      ACTOR,
      started.caseId,
      { operationId: nextOperationId(103), confirmation: "CLOSE_ONBOARDING" },
      { access: taskAccess(ACTOR) },
    );
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.eventId, closed.eventId);
    const afterClose = runtimeCounts(context.database);
    const restart = clone(context.input);
    restart.operationId = nextOperationId(104);
    await rejectCode(
      context.serviceFor().start(restart, { actorId: ACTOR, access: fullAccess() }),
      "PERSONNEL_LIFECYCLE_ONBOARDING_CASE_EXISTS",
      "conflict",
    );
    assert.deepEqual(runtimeCounts(context.database), afterClose);
    assert.equal(context.database.prepare(`
      SELECT state FROM personnel_lifecycle_cases WHERE id = ?
    `).get(started.caseId).state, "completed");
    assert.deepEqual(context.database.prepare(`
      SELECT event_type FROM personnel_lifecycle_case_events
      WHERE case_id = ? ORDER BY sequence_number
    `).all(started.caseId).map(({ event_type: eventType }) => eventType), [
      "onboarding_prepared",
      "onboarding_approved",
      "onboarding_started",
      "onboarding_task_completed",
      "onboarding_task_completed",
      "onboarding_completed",
    ]);
    assert.deepEqual(
      await taskService.listActiveTasks(ACTOR, { access: taskAccess(ACTOR) }),
      { items: [] },
    );
    assert.deepEqual(inspectSqlitePersonnelLifecycleOnboardingRows(context.database), {
      valid: true,
      issues: [],
    });
  } finally {
    await context.close();
  }
});
