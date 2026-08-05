"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES: B,
  PERSONNEL_LIFECYCLE_O2_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES,
  PERSONNEL_LIFECYCLE_O2_RUNTIME_GATES,
  createPersonnelLifecycleCaseFoundationService,
  createPersonnelLifecycleStartPreview,
} = require("../lib/personnel-lifecycle-case-foundation");
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

const LOCATION_A = "o2-location-a";
const LOCATION_B = "o2-location-b";
const DEPARTMENT_A = 9101;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function subject(overrides = {}) {
  return {
    subject_type: "employee",
    employee_number: "EMP-O2-1",
    employee_active: 1,
    location_id: LOCATION_A,
    department_id: DEPARTMENT_A,
    location_active: 1,
    department_active: 1,
    department_location_id: LOCATION_A,
    ...overrides,
  };
}

function publication({
  id,
  processId = id,
  versionNumber = 1,
  sourceRevision = versionNumber,
  workflowCode = `onboarding.${processId}`,
  workflowType = "onboarding",
  title = processId,
  requirementKind = "supplemental",
  scopeType = "company",
  locationId = null,
  departmentId = null,
  archivedAt = null,
} = {}) {
  const snapshotJson = JSON.stringify({
    id: processId,
    revision: sourceRevision,
    title,
    scope: {
      type: scopeType,
      locationId,
      departmentId,
    },
    steps: [{ id: `${processId}-step-${sourceRevision}`, title: "Interne Aufgabe" }],
  });
  const row = {
    id,
    process_id: processId,
    source_revision: sourceRevision,
    version_number: versionNumber,
    workflow_code: workflowCode,
    workflow_type: workflowType,
    authority_level: scopeType === "company" ? "central" : "local",
    requirement_kind: requirementKind,
    data_classification: "standard",
    scope_type: scopeType,
    location_id: locationId,
    department_id: departmentId,
    snapshot_json: snapshotJson,
    snapshot_sha256: sha256(snapshotJson),
    published_by: "PL-O2",
    published_at: `2026-08-0${Math.min(versionNumber, 9)}T10:00:00.000Z`,
    archived_at: archivedAt,
  };
  row.receipt_sha256 = sha256(JSON.stringify(
    personnelWorkflowPublicationReceiptBody(row),
  ));
  return row;
}

function blockerCodes(preview) {
  return preview.blockers.map(({ code }) => code);
}

test("O2 oeffnet nur Migration und read-only Vorschau, niemals einen Start", () => {
  assert.equal(PERSONNEL_LIFECYCLE_O2_CONTRACT_VERSION, "o2-v0.1");
  assert.deepEqual(
    Object.entries(PERSONNEL_LIFECYCLE_O2_RUNTIME_GATES)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name),
    [
      "schemaMigration",
      "persistenceFoundation",
      "readOnlyPackageResolution",
      "readOnlyStartPreview",
    ],
  );
  for (const gate of [
    "productiveActivation",
    "apiRoutes",
    "caseCreation",
    "caseMutation",
    "workflowInstantiation",
    "taskCreation",
    "assignmentResolution",
    "profileProjection",
    "notifications",
    "externalActions",
  ]) assert.equal(PERSONNEL_LIFECYCLE_O2_RUNTIME_GATES[gate], false, gate);
  assert.deepEqual(PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES, [
    "personnel_administration",
    "base_security_privacy",
  ]);
});

test("O2 loest nur passende neueste Onboarding-Publikationen datensparsam auf", () => {
  const rows = [
    publication({
      id: "pub-admin-1",
      processId: "process-admin",
      workflowCode: "onboarding.personnel-admin",
      title: "Personal und Administration",
      requirementKind: "mandatory",
    }),
    publication({
      id: "pub-security-1",
      processId: "process-security",
      workflowCode: "onboarding.base-security",
      title: "Basissicherheit",
      requirementKind: "mandatory",
    }),
    publication({
      id: "pub-security-2",
      processId: "process-security",
      versionNumber: 2,
      workflowCode: "onboarding.base-security",
      title: "Basissicherheit v2",
      requirementKind: "mandatory",
    }),
    publication({
      id: "pub-location",
      processId: "process-location",
      workflowCode: "onboarding.personnel-admin",
      title: "Lokale Administration",
      scopeType: "location",
      locationId: LOCATION_A,
    }),
    publication({
      id: "pub-department",
      processId: "process-department",
      workflowCode: "onboarding.department-training",
      title: "Einschulung Abteilung",
      scopeType: "department",
      locationId: LOCATION_A,
      departmentId: DEPARTMENT_A,
    }),
    publication({
      id: "pub-foreign-location",
      processId: "process-foreign-location",
      scopeType: "location",
      locationId: LOCATION_B,
    }),
    publication({
      id: "pub-training",
      processId: "process-training",
      workflowType: "training",
    }),
    publication({
      id: "pub-archived",
      processId: "process-archived",
      archivedAt: "2026-08-03T10:00:00.000Z",
    }),
  ];
  const preview = createPersonnelLifecycleStartPreview({
    caseType: "onboarding",
    subject: subject(),
    publications: rows,
  });

  assert.deepEqual(preview.scope, {
    type: "department",
    locationId: LOCATION_A,
    departmentId: DEPARTMENT_A,
  });
  assert.deepEqual(
    preview.packageResolution.applicableCandidates.map(({ publicationId }) => publicationId),
    ["pub-security-2", "pub-admin-1", "pub-location", "pub-department"],
  );
  assert.equal(
    preview.packageResolution.applicableCandidates.every((candidate) => (
      candidate.reviewStatus === "requires_new_lifecycle_review"
      && !("snapshot" in candidate)
      && !("steps" in candidate)
      && !("receiptSha256" in candidate)
    )),
    true,
  );
  assert.deepEqual(preview.packageResolution.selectedBindings, []);
  assert.deepEqual(preview.packageResolution.conflicts, [{
    kind: "workflow_code",
    value: "onboarding.personnel-admin",
    publicationIds: ["pub-admin-1", "pub-location"],
  }]);
  assert.equal(blockerCodes(preview).includes(B.M4_PUBLICATION_REVIEW_REQUIRED), true);
  assert.equal(blockerCodes(preview).includes(B.PACKAGE_CONFLICT), true);
  assert.equal(
    preview.blockers.filter(({ code }) => code === B.REQUIRED_PACKAGE_FAMILY_UNMAPPED).length,
    2,
  );
  assert.equal(preview.startAllowed, false);
  assert.equal(preview.casePersisted, false);
  assert.equal(preview.instanceCount, 0);
  assert.equal(preview.taskCount, 0);
  assert.equal(preview.assignmentCount, 0);
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.packageResolution.applicableCandidates), true);
  assert.throws(
    () => preview.packageResolution.applicableCandidates.push({}),
    TypeError,
  );
});

test("O2 bleibt bei fehlendem oder widerspruechlichem Mitarbeiter-Scope fail-closed", () => {
  const missing = createPersonnelLifecycleStartPreview({
    caseType: "onboarding",
    subject: null,
    publications: [],
  });
  assert.deepEqual(blockerCodes(missing), [
    B.STARTS_LOCKED,
    B.SUBJECT_NOT_FOUND,
    B.SCOPE_UNRESOLVED,
  ]);

  const inactive = createPersonnelLifecycleStartPreview({
    caseType: "onboarding",
    subject: subject({ employee_active: 0, location_active: 0 }),
    publications: [],
  });
  assert.equal(blockerCodes(inactive).includes(B.SUBJECT_INACTIVE), true);
  assert.equal(blockerCodes(inactive).includes(B.SCOPE_INACTIVE), true);

  const conflictingDepartment = createPersonnelLifecycleStartPreview({
    caseType: "onboarding",
    subject: subject({ department_location_id: LOCATION_B }),
    publications: [],
  });
  assert.equal(blockerCodes(conflictingDepartment).includes(B.SCOPE_RELATION_INVALID), true);
  assert.equal(conflictingDepartment.scope, null);
  assert.equal(conflictingDepartment.startAllowed, false);
});

test("O2 zeigt fuer Offboarding weder M4-Pakete noch eine Startmoeglichkeit", () => {
  const preview = createPersonnelLifecycleStartPreview({
    caseType: "offboarding",
    subject: subject(),
    publications: [publication({ id: "pub-onboarding" })],
  });
  assert.equal(preview.subject, null);
  assert.equal(preview.scope, null);
  assert.deepEqual(preview.packageResolution.requiredPackageFamilies, []);
  assert.deepEqual(preview.packageResolution.applicableCandidates, []);
  assert.deepEqual(preview.packageResolution.selectedBindings, []);
  assert.deepEqual(blockerCodes(preview), [B.STARTS_LOCKED, B.OFFBOARDING_DEFERRED]);
  assert.equal(preview.startAllowed, false);
});

test("O2 verwirft manipulierte M4-Publikationen statt sie aus der Vorschau auszublenden", () => {
  const tampered = publication({ id: "pub-tampered" });
  tampered.snapshot_json = `${tampered.snapshot_json} `;
  assert.throws(
    () => createPersonnelLifecycleStartPreview({
      caseType: "onboarding",
      subject: subject(),
      publications: [tampered],
    }),
    (error) => error?.code === "PERSONNEL_WORKFLOW_PUBLICATION_INTEGRITY_FAILED",
  );
});

test("der O2-Service liest nur Mitarbeiter und Publikationen und exponiert keine Mutation", async () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  try {
    ensureSqliteApplicationSchema(application.database);
    application.database.exec(`
      INSERT INTO locations (id, name, active)
        VALUES ('${LOCATION_A}', 'O2 Standort A', 1);
      INSERT INTO departments (id, location_id, name, active)
        VALUES (${DEPARTMENT_A}, '${LOCATION_A}', 'O2 Abteilung A', 1);
      INSERT INTO employees (
        personnel_number, full_name, nickname, home_location_id,
        preferred_department_id, active
      ) VALUES (
        'EMP-O2-1', 'O2 Mitarbeiter', 'O2', '${LOCATION_A}', ${DEPARTMENT_A}, 1
      );
    `);
    const repository = createCustomProcessManagementRepository(application.provider);
    await repository.insertProcess({
      id: "service-process",
      title: "O2 Servicepaket",
      symbol: "P",
      description: "Read-only Test",
      category: "other",
      scopeType: "company",
      locationId: null,
      departmentId: null,
      triggerType: "manual",
      triggerMinimumShortfall: 1,
      status: "active",
      actor: "PL-O2",
    });
    const row = publication({
      id: "service-publication",
      processId: "service-process",
      title: "O2 Servicepaket",
      requirementKind: "mandatory",
    });
    await repository.insertProcessRevision({
      processId: row.process_id,
      revision: row.source_revision,
      snapshotJson: row.snapshot_json,
      actor: "PL-O2",
    });
    application.database.prepare(`
      INSERT INTO custom_process_publications (
        id, process_id, source_revision, version_number, workflow_code,
        workflow_type, authority_level, requirement_kind, data_classification,
        scope_type, location_id, department_id, snapshot_json, snapshot_sha256,
        receipt_sha256, published_by, published_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
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

    const service = createPersonnelLifecycleCaseFoundationService(repository);
    assert.deepEqual(Object.keys(service), ["preview"]);
    const preview = await service.preview({
      caseType: "onboarding",
      employeeNumber: "EMP-O2-1",
    });
    assert.deepEqual(
      preview.packageResolution.applicableCandidates.map(({ publicationId }) => publicationId),
      ["service-publication"],
    );
    assert.equal(preview.startAllowed, false);
    for (const name of ["createCase", "start", "persist", "assign", "mutate"]) {
      assert.equal(name in service, false, name);
    }
    for (const table of [
      "personnel_employment_episodes",
      "personnel_lifecycle_cases",
      "personnel_lifecycle_case_package_bindings",
      "personnel_lifecycle_case_assignments",
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
