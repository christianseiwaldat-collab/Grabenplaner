"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_O3_ASSIGNMENT_STATES: A,
  PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES: B,
  PERSONNEL_LIFECYCLE_O3_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_O3_RUNTIME_GATES,
  createPersonnelLifecycleOnboardingPreviewService,
  createPersonnelLifecycleOnboardingProfilePreview,
} = require("../lib/personnel-lifecycle-onboarding-preview");
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
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

const LOCATION = "o3-location";
const DEPARTMENT = 9301;
const EMPLOYEE = "EMP-O3-SUBJECT";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function subject(overrides = {}) {
  return {
    subject_type: "employee",
    employee_number: EMPLOYEE,
    employee_active: 1,
    location_id: LOCATION,
    department_id: DEPARTMENT,
    location_active: 1,
    department_active: 1,
    department_location_id: LOCATION,
    ...overrides,
  };
}

function step({
  id,
  title,
  responsibilityType,
  responsibilityReference = "",
  responsibilityLabel,
} = {}) {
  return {
    id,
    type: responsibilityType === "system" ? "system" : "actor",
    title,
    description: `Nicht ausgeben: ${title}`,
    responsibilityType,
    responsibilityReference,
    responsibilityLabel,
    conditionType: "always",
    conditionText: "",
    notificationChannels: [],
  };
}

function publication({
  id = "o3-publication",
  processId = "o3-process",
  workflowCode = "onboarding.o3",
  title = "O3 Onboarding-Paket",
  steps = [],
} = {}) {
  const snapshotJson = JSON.stringify({
    id: processId,
    revision: 1,
    title,
    scope: { type: "company", locationId: null, departmentId: null },
    steps,
  });
  const row = {
    id,
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
    published_by: "PL-O3",
    published_at: "2026-08-03T09:00:00.000Z",
    archived_at: null,
  };
  row.receipt_sha256 = sha256(JSON.stringify(personnelWorkflowPublicationReceiptBody(row)));
  return row;
}

function recipient(employeeNumber, fullName, role) {
  return {
    employee_number: employeeNumber,
    full_name: fullName,
    role,
    role_permissions: "[]",
    granted_permissions: "[]",
    denied_permissions: "[]",
    permission_scopes: "[]",
    access_scopes: "[]",
    home_location_id: LOCATION,
    preferred_department_id: DEPARTMENT,
  };
}

test("O3 oeffnet nur API, Zuweisungsvorschau und Profilprojektion read-only", () => {
  assert.equal(PERSONNEL_LIFECYCLE_O3_CONTRACT_VERSION, "o3-v0.1");
  assert.deepEqual(
    Object.entries(PERSONNEL_LIFECYCLE_O3_RUNTIME_GATES)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name),
    [
      "schemaMigration",
      "persistenceFoundation",
      "readOnlyPackageResolution",
      "readOnlyStartPreview",
      "apiRoutes",
      "assignmentPreview",
      "profileProjection",
    ],
  );
  for (const gate of [
    "productiveActivation",
    "caseCreation",
    "caseMutation",
    "workflowInstantiation",
    "taskCreation",
    "assignmentSelection",
    "assignmentMutation",
    "automaticProgression",
    "notifications",
    "externalActions",
    "offboardingProjection",
  ]) assert.equal(PERSONNEL_LIFECYCLE_O3_RUNTIME_GATES[gate], false, gate);
});

test("O3 zeigt feste, auszuwaehlende, ungeklaerte und gesperrte Verantwortungen ohne Auswahl", async () => {
  const rows = [publication({
    steps: [
      step({
        id: "fixed-hr",
        title: "Personalunterlagen pruefen",
        responsibilityType: "employee",
        responsibilityReference: "HR-O3",
        responsibilityLabel: "Feste PL-Person",
      }),
      step({
        id: "branch-choice",
        title: "Begruessung vorbereiten",
        responsibilityType: "role",
        responsibilityReference: "manager",
        responsibilityLabel: "Filialleitung",
      }),
      step({
        id: "trainer-missing",
        title: "Einschulung planen",
        responsibilityType: "role",
        responsibilityReference: "trainer",
        responsibilityLabel: "Trainer",
      }),
      step({
        id: "system-locked",
        title: "Systemzugang vormerken",
        responsibilityType: "system",
        responsibilityLabel: "Grabenplaner",
      }),
    ],
  })];
  const preview = await createPersonnelLifecycleOnboardingProfilePreview({
    subject: subject(),
    publications: rows,
    recipients: [
      recipient("HR-O3", "Hanna Personal", "hr"),
      recipient("FL-O3-1", "Fiona Leitung", "manager"),
      recipient("FL-O3-2", "Felix Leitung", "manager"),
      recipient("DEV-O3", "Technik Nicht Empfaenger", "developer"),
    ],
    canPreviewRecipient: async ({ recipient: value }) => value.role !== "developer",
  });

  assert.equal(preview.startAllowed, false);
  assert.equal(preview.casePersisted, false);
  assert.deepEqual(
    preview.packageResolution.packages[0].assignments.map(({ state }) => state),
    [
      A.FIXED_RECIPIENT_ELIGIBLE,
      A.SELECTION_REQUIRED,
      A.UNRESOLVED,
      A.SYSTEM_DEFERRED,
    ],
  );
  assert.deepEqual(
    preview.packageResolution.packages[0].assignments[1].eligibleRecipients,
    [
      { actorId: "FL-O3-2", displayName: "Felix Leitung" },
      { actorId: "FL-O3-1", displayName: "Fiona Leitung" },
    ],
  );
  assert.equal(
    preview.packageResolution.packages[0].assignments
      .every(({ selectedAssignee }) => selectedAssignee === null),
    true,
  );
  assert.deepEqual(preview.assignmentPreview, {
    packageCount: 1,
    stepCount: 4,
    fixedRecipientCount: 1,
    selectionRequiredCount: 1,
    unresolvedCount: 1,
    systemStepCount: 1,
    selectedAssignmentCount: 0,
  });
  const blockerCodes = preview.blockers.map(({ code }) => code);
  assert.equal(blockerCodes.includes(B.EXECUTION_DEFERRED), true);
  assert.equal(blockerCodes.includes(B.ASSIGNMENT_SELECTION_REQUIRED), true);
  assert.equal(blockerCodes.includes(B.ASSIGNMENT_UNRESOLVED), true);
  assert.equal(preview.blockers.every((entry) => Object.keys(entry).length === 1), true);
  assert.equal(preview.packageResolution.selectedBindings.length, 0);
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.packageResolution.packages[0].assignments), true);
  assert.equal(JSON.stringify(preview).includes("Nicht ausgeben"), false);
  assert.equal(JSON.stringify(preview).includes("role_permissions"), false);
  assert.equal(JSON.stringify(preview).includes("notificationChannels"), false);
});

test("O3 lehnt ein veroeffentlichtes Paket ohne Schritt fail-closed ab", async () => {
  await assert.rejects(
    createPersonnelLifecycleOnboardingProfilePreview({
      subject: subject(),
      publications: [publication({ steps: [] })],
      recipients: [],
    }),
    (error) => (
      error?.name === "PersonnelLifecycleOnboardingPreviewError"
        && error?.code === "PERSONNEL_LIFECYCLE_O3_INTEGRITY_FAILED"
    ),
  );
});

test("O3 waehlt auch die einzige geeignete Rollenperson niemals automatisch aus", async () => {
  const preview = await createPersonnelLifecycleOnboardingProfilePreview({
    subject: subject(),
    publications: [publication({
      steps: [step({
        id: "single-role-candidate",
        title: "Begruessung vorbereiten",
        responsibilityType: "role",
        responsibilityReference: "manager",
        responsibilityLabel: "Filialleitung",
      })],
    })],
    recipients: [recipient("FL-O3-ONLY", "Fiona Leitung", "manager")],
    canPreviewRecipient: async () => true,
  });
  const assignment = preview.packageResolution.packages[0].assignments[0];
  assert.equal(assignment.state, A.SELECTION_REQUIRED);
  assert.deepEqual(assignment.eligibleRecipients, [
    { actorId: "FL-O3-ONLY", displayName: "Fiona Leitung" },
  ]);
  assert.equal(assignment.selectedAssignee, null);
  assert.equal(preview.assignmentPreview.selectedAssignmentCount, 0);
});

test("der O3-Service liest nur Vorschauquellen und erzeugt keine Lifecycle-Zeile", async () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  try {
    ensureSqliteApplicationSchema(application.database);
    application.database.exec(`
      INSERT INTO locations (id, name, active)
        VALUES ('${LOCATION}', 'O3 Standort', 1);
      INSERT INTO departments (id, location_id, name, active)
        VALUES (${DEPARTMENT}, '${LOCATION}', 'O3 Abteilung', 1);
      INSERT INTO employees (
        personnel_number, full_name, nickname, home_location_id,
        preferred_department_id, active
      ) VALUES (
        '${EMPLOYEE}', 'O3 Zielperson', 'O3', '${LOCATION}', ${DEPARTMENT}, 1
      );
      INSERT INTO employees (
        personnel_number, full_name, nickname, home_location_id,
        preferred_department_id, active
      ) VALUES (
        'HR-O3', 'Hanna Personal', 'Hanna', '${LOCATION}', ${DEPARTMENT}, 1
      );
      INSERT INTO portal_users (
        employee_number, password_hash, role, active, must_change_password
      ) VALUES ('HR-O3', 'test-only', 'hr', 1, 0);
    `);
    const repository = createCustomProcessManagementRepository(application.provider);
    await repository.insertProcess({
      id: "o3-process",
      title: "O3 Onboarding-Paket",
      symbol: "O3",
      description: "Read-only O3-Test",
      category: "other",
      scopeType: "company",
      locationId: null,
      departmentId: null,
      triggerType: "manual",
      triggerMinimumShortfall: 1,
      status: "active",
      actor: "PL-O3",
    });
    const row = publication({
      steps: [step({
        id: "fixed-hr",
        title: "Personalunterlagen pruefen",
        responsibilityType: "employee",
        responsibilityReference: "HR-O3",
        responsibilityLabel: "Feste PL-Person",
      })],
    });
    await repository.insertProcessRevision({
      processId: row.process_id,
      revision: row.source_revision,
      snapshotJson: row.snapshot_json,
      actor: "PL-O3",
    });
    application.database.prepare(`
      INSERT INTO custom_process_publications (
        id, process_id, source_revision, version_number, workflow_code,
        workflow_type, authority_level, requirement_kind, data_classification,
        scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
        receipt_sha256, published_by, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.process_id,
      row.source_revision,
      row.version_number,
      row.workflow_code,
      row.workflow_type,
      row.authority_level,
      row.requirement_kind,
      row.data_classification,
      row.scope_type,
      row.location_id,
      row.department_id,
      row.snapshot_json,
      row.snapshot_sha256,
      row.receipt_sha256,
      row.published_by,
      row.published_at,
    );
    const service = createPersonnelLifecycleOnboardingPreviewService(repository, {
      canPreviewRecipient: async ({ recipient: value }) => value.employee_number === "HR-O3",
    });
    assert.deepEqual(Object.keys(service), ["preview"]);
    const preview = await service.preview({ employeeNumber: EMPLOYEE });
    assert.equal(preview.assignmentPreview.fixedRecipientCount, 1);
    assert.equal(preview.startAllowed, false);
    for (const name of ["createCase", "start", "persist", "select", "assign", "mutate"]) {
      assert.equal(name in service, false, name);
    }
    for (const table of [
      "personnel_employment_episodes",
      "personnel_lifecycle_cases",
      "personnel_lifecycle_case_reference_dates",
      "personnel_lifecycle_case_package_bindings",
      "personnel_lifecycle_case_assignments",
      "personnel_lifecycle_case_events",
      "personnel_lifecycle_confidential_access_events",
    ]) {
      assert.equal(application.database.prepare(
        `SELECT COUNT(*) AS count FROM "${table}"`,
      ).get().count, 0, table);
    }
  } finally {
    await application.provider.close();
    application.database.close();
  }
});
