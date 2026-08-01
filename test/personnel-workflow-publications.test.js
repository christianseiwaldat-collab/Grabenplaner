"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_WORKFLOW_PERMISSION_IDS,
  PERSONNEL_WORKFLOW_PERMISSIONS: P,
  createPersonnelWorkflowAccessSnapshot,
} = require("../lib/personnel-workflow-access");
const {
  PersonnelWorkflowError,
  createPersonnelWorkflowPublicationService,
} = require("../lib/personnel-workflow-publications");
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

const LOCATION_A = "workflow-location-a";
const LOCATION_B = "workflow-location-b";
const DEPARTMENT_A = 501;
const DEPARTMENT_B = 502;
const PUBLISHED_AT = "2026-08-01T10:00:00.000Z";

function permissionScope(permission, locationId, departmentId = null, approvedBy = "pl-plus") {
  return { permission, locationId, departmentId, approvedBy };
}

function managerAccess({
  role = "manager",
  locationId = LOCATION_A,
  departmentId = null,
  explicitScopes,
  permissionScopes,
} = {}) {
  const permissions = [P.READ, P.DRAFT_WRITE, P.PUBLISH, P.LOCAL_SUPPLEMENT];
  return createPersonnelWorkflowAccessSnapshot({
    employeeNumber: role === "manager" ? "fl-1" : "al-1",
    role,
    permissions,
    explicitScopes: explicitScopes ?? [{ locationId, departmentId }],
    permissionScopes: permissionScopes ?? permissions.map((permission) => (
      permissionScope(permission, locationId, departmentId)
    )),
  });
}

function hrAccess(extraPermissions = []) {
  return createPersonnelWorkflowAccessSnapshot({
    employeeNumber: "pl-plus-1",
    role: "hr",
    permissions: [P.READ, P.DRAFT_WRITE, P.PUBLISH, ...extraPermissions],
  });
}

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active) VALUES
      ('${LOCATION_A}', 'Workflow Standort A', 1),
      ('${LOCATION_B}', 'Workflow Standort B', 1);
    INSERT INTO departments (id, location_id, name, active) VALUES
      (${DEPARTMENT_A}, '${LOCATION_A}', 'Workflow Abteilung A', 1),
      (${DEPARTMENT_B}, '${LOCATION_B}', 'Workflow Abteilung B', 1);
  `);
  const repository = createCustomProcessManagementRepository(application.provider);
  let id = 0;
  const service = createPersonnelWorkflowPublicationService(repository, {
    clock: () => new Date(PUBLISHED_AT),
    createId: () => `test-${++id}`,
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

function scope(type, locationId = null, departmentId = null) {
  return { type, locationId, departmentId };
}

async function insertDefinition(repository, {
  id,
  title,
  workflowScope = scope("company"),
  revision = 1,
  status = "draft",
} = {}) {
  await repository.insertProcess({
    id,
    title,
    symbol: "P",
    description: "M4-Testprozess",
    category: "other",
    scopeType: workflowScope.type,
    locationId: workflowScope.locationId,
    departmentId: workflowScope.departmentId,
    triggerType: "manual",
    triggerMinimumShortfall: 1,
    status,
    actor: "test-author",
  });
  await repository.insertProcessRevision({
    processId: id,
    revision,
    snapshotJson: JSON.stringify({
      id,
      revision,
      title,
      scope: workflowScope,
      steps: [{ id: `${id}-step-${revision}`, title: "Aufgabe" }],
    }),
    actor: "test-author",
  });
}

async function updateDefinition(repository, {
  id,
  title,
  workflowScope = scope("company"),
  revision,
  status = "draft",
} = {}) {
  await repository.updateProcess({
    id,
    revision: revision - 1,
    title,
    symbol: "P",
    description: "M4-Testprozess, neue Revision",
    category: "other",
    scopeType: workflowScope.type,
    locationId: workflowScope.locationId,
    departmentId: workflowScope.departmentId,
    triggerType: "manual",
    triggerMinimumShortfall: 1,
    status,
    actor: "test-author",
  });
  await repository.insertProcessRevision({
    processId: id,
    revision,
    snapshotJson: JSON.stringify({
      id,
      revision,
      title,
      scope: workflowScope,
      steps: [{ id: `${id}-step-${revision}`, title: "Neue Aufgabe" }],
    }),
    actor: "test-author",
  });
}

function publicationInput(overrides = {}) {
  return {
    workflowCode: "standard.onboarding",
    workflowType: "onboarding",
    requirementKind: "supplemental",
    dataClassification: "standard",
    containsConfidentialSteps: false,
    ...overrides,
  };
}

test("M4-Rechte bleiben rollen- und bereichsbezogen; IT-Admin bleibt fail-closed", () => {
  assert.equal(Object.isFrozen(P), true);
  assert.deepEqual(PERSONNEL_WORKFLOW_PERMISSION_IDS, Object.values(P));

  const forgedItAdmin = createPersonnelWorkflowAccessSnapshot({
    employeeNumber: "it-1",
    role: "it_admin",
    permissions: [...PERSONNEL_WORKFLOW_PERMISSION_IDS],
    explicitScopes: [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: PERSONNEL_WORKFLOW_PERMISSION_IDS.map((permission) => (
      permissionScope(permission, LOCATION_A)
    )),
  });
  assert.deepEqual(forgedItAdmin.capabilities, {
    canRead: false,
    canWriteDrafts: false,
    canReview: false,
    canPublish: false,
    canManageLocalSupplements: false,
    canReadConfidential: false,
    canWriteConfidential: false,
    canDelegate: false,
  });
  assert.equal(forgedItAdmin.canReadScope(scope("location", LOCATION_A)), false);
  assert.equal(forgedItAdmin.canPublishScope(scope("location", LOCATION_A)), false);

  const forgedAdmin = createPersonnelWorkflowAccessSnapshot({
    employeeNumber: "technical-admin",
    role: "admin",
    permissions: [...PERSONNEL_WORKFLOW_PERMISSION_IDS],
  });
  assert.equal(forgedAdmin.canRead, true);
  assert.equal(forgedAdmin.canReadConfidential, false);
  assert.equal(forgedAdmin.canWriteConfidential, false);
});

test("FL und AL wirken nur in der Schnittmenge aus Portal- und PL+-Fachscope", () => {
  const fl = managerAccess({
    explicitScopes: [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: [
      ...[P.READ, P.DRAFT_WRITE, P.PUBLISH, P.LOCAL_SUPPLEMENT].map((permission) => (
        permissionScope(permission, LOCATION_A)
      )),
      ...[P.READ, P.DRAFT_WRITE, P.PUBLISH, P.LOCAL_SUPPLEMENT].map((permission) => (
        permissionScope(permission, LOCATION_B)
      )),
    ],
  });
  assert.equal(fl.canPublishScope(scope("location", LOCATION_A), "supplemental"), true);
  assert.equal(fl.canPublishScope(scope("department", LOCATION_A, DEPARTMENT_A), "supplemental"), true);
  assert.equal(fl.canPublishScope(scope("location", LOCATION_B), "supplemental"), false);
  assert.equal(fl.canPublishScope(scope("location", LOCATION_A), "mandatory"), false);
  assert.equal(fl.canPublishScope(scope("company"), "supplemental"), false);

  const al = managerAccess({
    role: "department_manager",
    locationId: LOCATION_A,
    departmentId: DEPARTMENT_A,
    permissionScopes: [
      ...[P.READ, P.DRAFT_WRITE, P.PUBLISH, P.LOCAL_SUPPLEMENT].map((permission) => (
        permissionScope(permission, LOCATION_A, DEPARTMENT_A)
      )),
      ...[P.READ, P.DRAFT_WRITE, P.PUBLISH, P.LOCAL_SUPPLEMENT].map((permission) => (
        permissionScope(permission, LOCATION_B, DEPARTMENT_B)
      )),
    ],
  });
  assert.equal(al.canPublishScope(scope("department", LOCATION_A, DEPARTMENT_A)), true);
  assert.equal(al.canPublishScope(scope("location", LOCATION_A)), false);
  assert.equal(al.canPublishScope(scope("department", LOCATION_B, DEPARTMENT_B)), false);

  const unapproved = managerAccess({ permissionScopes: [] });
  assert.equal(unapproved.canRead, false);
  assert.equal(unapproved.canPublish, false);
});

test("veroeffentlichte Revisionen bleiben unveraendert und lueckenlos versioniert", async () => {
  const context = fixture();
  try {
    await insertDefinition(context.repository, {
      id: "immutable-process",
      title: "Onboarding Version 1",
    });
    const first = await context.service.publish(
      "immutable-process",
      publicationInput({ requirementKind: "mandatory" }),
      { access: hrAccess(), actorId: "pl-plus-1" },
    );
    assert.equal(first.versionNumber, 1);
    assert.equal(first.title, "Onboarding Version 1");
    assert.equal(first.requirementKind, "mandatory");

    await assert.rejects(
      context.service.publish(
        "immutable-process",
        publicationInput({ requirementKind: "mandatory" }),
        { access: hrAccess(), actorId: "pl-plus-1" },
      ),
      (error) => error instanceof PersonnelWorkflowError
        && error.code === "PERSONNEL_WORKFLOW_REVISION_ALREADY_PUBLISHED",
    );

    await updateDefinition(context.repository, {
      id: "immutable-process",
      title: "Onboarding Version 2",
      revision: 2,
    });
    await assert.rejects(
      context.service.publish(
        "immutable-process",
        publicationInput({
          workflowCode: "anderer.code",
          requirementKind: "mandatory",
        }),
        { access: hrAccess(), actorId: "pl-plus-1" },
      ),
      (error) => error instanceof PersonnelWorkflowError
        && error.code === "PERSONNEL_WORKFLOW_CODE_CONFLICT",
    );

    const second = await context.service.publish(
      "immutable-process",
      publicationInput({ requirementKind: "mandatory" }),
      { access: hrAccess(), actorId: "pl-plus-1" },
    );
    assert.equal(second.versionNumber, 2);
    assert.equal(second.title, "Onboarding Version 2");

    const listed = await context.service.list({ includeArchived: true, access: hrAccess() });
    assert.deepEqual(
      listed.publications.map(({ versionNumber, title }) => ({ versionNumber, title })),
      [
        { versionNumber: 1, title: "Onboarding Version 1" },
        { versionNumber: 2, title: "Onboarding Version 2" },
      ],
    );
    assert.equal(
      context.database.prepare(`
        SELECT COUNT(*) AS count FROM custom_process_publications
        WHERE process_id = 'immutable-process'
      `).get().count,
      2,
    );
  } finally {
    await context.close();
  }
});

test("vertrauliche und Offboarding-Schritte bleiben im M4-Fundament fail-closed", async () => {
  const context = fixture();
  try {
    await insertDefinition(context.repository, {
      id: "deferred-process",
      title: "Geschuetzter Prozess",
    });
    for (const input of [
      publicationInput({ containsConfidentialSteps: true }),
      publicationInput({ dataClassification: "confidential" }),
      publicationInput({ workflowType: "offboarding" }),
    ]) {
      await assert.rejects(
        context.service.publish(
          "deferred-process",
          input,
          { access: hrAccess([P.CONFIDENTIAL_READ, P.CONFIDENTIAL_WRITE]), actorId: "pl-plus-1" },
        ),
        (error) => error instanceof PersonnelWorkflowError
          && error.code === "PERSONNEL_WORKFLOW_CONFIDENTIAL_DEFERRED",
      );
    }
    assert.equal(
      context.database.prepare("SELECT COUNT(*) AS count FROM custom_process_publications").get().count,
      0,
    );
  } finally {
    await context.close();
  }
});

test("lokale Prozesse ergaenzen zentrale Pflichtprozesse und ueberschreiben sie nicht", async () => {
  const context = fixture();
  try {
    await insertDefinition(context.repository, {
      id: "central-onboarding",
      title: "Zentrales Onboarding",
    });
    await insertDefinition(context.repository, {
      id: "local-onboarding",
      title: "Lokale Onboarding-Ergaenzung",
      workflowScope: scope("location", LOCATION_A),
    });
    await context.service.publish(
      "central-onboarding",
      publicationInput({ requirementKind: "mandatory" }),
      { access: hrAccess(), actorId: "pl-plus-1" },
    );
    await context.service.publish(
      "local-onboarding",
      publicationInput(),
      { access: managerAccess(), actorId: "fl-1" },
    );

    const resolved = await context.service.resolve(
      scope("location", LOCATION_A),
      { access: managerAccess() },
    );
    assert.deepEqual(
      resolved.publications.map(({ processId, authorityLevel, requirementKind }) => ({
        processId, authorityLevel, requirementKind,
      })),
      [
        {
          processId: "central-onboarding",
          authorityLevel: "central",
          requirementKind: "mandatory",
        },
        {
          processId: "local-onboarding",
          authorityLevel: "local",
          requirementKind: "supplemental",
        },
      ],
    );
    assert.equal(resolved.conflicts.some(({ kind, value }) => (
      kind === "code" && value === "standard.onboarding"
    )), true);

    const outside = await context.service.resolve(
      scope("location", LOCATION_B),
      { access: hrAccess() },
    );
    assert.deepEqual(outside.publications.map(({ processId }) => processId), ["central-onboarding"]);
  } finally {
    await context.close();
  }
});

test("Archivierung ist append-only, idempotent und mutiert keinen laufenden Prozess", async () => {
  const context = fixture();
  try {
    await insertDefinition(context.repository, {
      id: "running-process",
      title: "Laufender Prozess",
      status: "active",
    });
    const publication = await context.service.publish(
      "running-process",
      publicationInput({ requirementKind: "mandatory" }),
      { access: hrAccess(), actorId: "pl-plus-1" },
    );
    await context.repository.insertRun({
      id: "existing-run",
      processId: "running-process",
      processRevision: 1,
      triggerType: "manual",
      triggerKey: "manual:existing-run",
      locationId: null,
      departmentId: null,
      triggeredBy: "test-author",
    });
    const before = context.database.prepare(
      "SELECT * FROM custom_process_runs WHERE id = 'existing-run'",
    ).get();

    const archived = await context.service.archive(
      publication.id,
      { reason: "Durch eine neuere Version ersetzt" },
      { access: hrAccess(), actorId: "pl-plus-1" },
    );
    assert.equal(archived.archived, true);
    assert.equal(archived.archivedAt, PUBLISHED_AT);
    assert.deepEqual(
      context.database.prepare("SELECT * FROM custom_process_runs WHERE id = 'existing-run'").get(),
      before,
    );
    assert.equal(
      context.database.prepare("SELECT COUNT(*) AS count FROM custom_process_publications").get().count,
      1,
    );
    assert.equal(
      context.database.prepare("SELECT COUNT(*) AS count FROM custom_process_publication_archives").get().count,
      1,
    );

    const repeated = await context.service.archive(
      publication.id,
      { reason: "Erneute idempotente Anfrage" },
      { access: hrAccess(), actorId: "pl-plus-1" },
    );
    assert.equal(repeated.archived, true);
    assert.equal(
      context.database.prepare("SELECT COUNT(*) AS count FROM custom_process_publication_archives").get().count,
      1,
    );

    const resolved = await context.service.resolve(
      scope("location", LOCATION_A),
      { access: hrAccess() },
    );
    assert.deepEqual(resolved.publications, []);
    const listed = await context.service.list({ includeArchived: true, access: hrAccess() });
    assert.equal(listed.publications[0].archived, true);
  } finally {
    await context.close();
  }
});
