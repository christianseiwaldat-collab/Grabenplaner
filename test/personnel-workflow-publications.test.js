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
    canReadInstances: false,
    canStartInstances: false,
    canWriteDrafts: false,
    canReview: false,
    canPublish: false,
    canManageLocalSupplements: false,
    canReadConfidential: false,
    canWriteConfidential: false,
    canDelegate: false,
  });
  assert.equal(forgedItAdmin.canReadScope(scope("location", LOCATION_A)), false);
  assert.equal(forgedItAdmin.canStartScope(scope("location", LOCATION_A)), false);
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
  assert.equal(fl.canStartInstances, true);
  assert.equal(fl.canStartScope(scope("location", LOCATION_A)), true);
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
