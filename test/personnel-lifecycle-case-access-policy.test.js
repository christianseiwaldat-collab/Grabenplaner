"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_LIFECYCLE_DATA_CLASSIFICATIONS: C,
  PERSONNEL_LIFECYCLE_CASE_PERMISSIONS: P,
  PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_PROJECTIONS: PROJECTION,
  PERSONNEL_LIFECYCLE_RECIPIENT_CLASSES: RECIPIENT,
  PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES,
} = require("../lib/personnel-lifecycle-case-contract");
const {
  PERSONNEL_LIFECYCLE_CASE_CENTRAL_ROLES,
  PERSONNEL_LIFECYCLE_CASE_SCOPED_ROLES,
  PERSONNEL_LIFECYCLE_CASE_SCOPED_PERMISSIONS,
  createPersonnelLifecycleCaseAccessSnapshot,
  personnelLifecycleCaseAccessForSession,
} = require("../lib/personnel-lifecycle-case-access");

const LOCATION_A = "innsbruck";
const LOCATION_B = "hall";
const DEPARTMENT_A = 17;
const DEPARTMENT_B = 18;

function personalSession(role, permissions = [], overrides = {}) {
  return {
    sessionKind: "employee",
    isEmployee: true,
    employeeNumber: `${role}-actor`,
    role,
    active: true,
    permissions,
    ...overrides,
  };
}

function organizationSession(role, permissions = [], overrides = {}) {
  return {
    sessionKind: "organization",
    isEmployee: false,
    accountId: `${role}-account`,
    role,
    active: true,
    permissions,
    ...overrides,
  };
}

function approvedScope(permission, locationId, departmentId = null, approvedBy = "pl-plus") {
  return { permission, locationId, departmentId, approvedBy };
}

function operationalContext(overrides = {}) {
  return {
    caseType: "onboarding",
    operationalReleased: true,
    scope: { locationId: LOCATION_A, departmentId: DEPARTMENT_A },
    ...overrides,
  };
}

const ONBOARDING_ACTION_RIGHTS = Object.freeze([
  P.ONBOARDING_READ,
  P.ONBOARDING_PREPARE,
  P.ONBOARDING_APPROVE,
  P.ONBOARDING_EXECUTE,
  P.ONBOARDING_CLOSE,
]);

const OFFBOARDING_ACTION_RIGHTS = Object.freeze([
  P.OFFBOARDING_CONFIDENTIAL_READ,
  P.OFFBOARDING_PREPARE,
  P.OFFBOARDING_COMMUNICATION_RELEASE,
  P.OFFBOARDING_INFORMATION_CONFIRM,
  P.OFFBOARDING_EXECUTE,
  P.OFFBOARDING_CLOSE,
]);

test("O1-Rollenvertrag umfasst PL, Admin, IT-Admin und Developer nur als berechtigbare Ebene", () => {
  assert.deepEqual(PERSONNEL_LIFECYCLE_CASE_CENTRAL_ROLES, [
    "hr",
    "admin",
    "it_admin",
    "developer",
  ]);
  assert.deepEqual(PERSONNEL_LIFECYCLE_CASE_SCOPED_ROLES, [
    "manager",
    "department_manager",
  ]);
  assert.deepEqual(PERSONNEL_LIFECYCLE_CASE_SCOPED_PERMISSIONS, [
    P.OPERATIONAL_READ,
    P.OPERATIONAL_UPDATE,
  ]);
  for (const role of PERSONNEL_LIFECYCLE_CASE_CENTRAL_ROLES) {
    const access = createPersonnelLifecycleCaseAccessSnapshot(personalSession(role));
    assert.equal(access.namedActor, true, role);
    assert.equal(access.central, true, role);
    assert.equal(Object.values(access.capabilities).every((value) => value === false), true, role);
  }
});

test("der ausdrücklich berechtigte Developer darf dieselben zentralen Fachaktionen ausüben", () => {
  const developer = createPersonnelLifecycleCaseAccessSnapshot(organizationSession("developer", [
    ...ONBOARDING_ACTION_RIGHTS,
    ...OFFBOARDING_ACTION_RIGHTS,
    P.PERSONAL_RESTRICTED_READ,
    P.HR_CONFIDENTIAL_READ,
    P.PACKAGES_READ,
    P.PACKAGES_WRITE,
    P.PACKAGES_PUBLISH,
    P.ASSIGNMENTS_WRITE,
    P.EXCEPTIONS_APPROVE,
    P.AUDIT_READ,
    P.CONFIDENTIAL_AUDIT_READ,
    P.DELEGATE,
  ]));
  assert.equal(developer.actorId, "developer-account");
  assert.equal(developer.canPrepareOnboarding, true);
  assert.equal(developer.canApproveOnboarding, true);
  assert.equal(developer.canExecuteOnboarding, true);
  assert.equal(developer.canCloseOnboarding, true);
  assert.equal(developer.canPrepareOffboarding, true);
  assert.equal(developer.canReleaseOffboardingCommunication, true);
  assert.equal(developer.canConfirmOffboardingInformation, true);
  assert.equal(developer.canExecuteOffboarding, true);
  assert.equal(developer.canCloseOffboarding, true);
  assert.equal(developer.canPublishPackages, true);
  assert.equal(developer.canWriteAssignments, true);
  assert.equal(developer.canApproveExceptions, true);
  assert.equal(developer.canReadConfidentialAudit, true);
  assert.equal(developer.canDelegate, true);

  assert.equal(developer.canAuthorizeTransition("onboarding", null, "prepared"), true);
  assert.equal(developer.canAuthorizeTransition("onboarding", "prepared", "approved"), true);
  assert.equal(developer.canAuthorizeTransition("offboarding", null, "internally_prepared"), true);
  assert.equal(developer.canAuthorizeTransition(
    "offboarding",
    "internally_prepared",
    "communication_released",
  ), true);
  assert.equal(developer.canAuthorizeTransition(
    "offboarding",
    "communication_released",
    "employee_informed",
  ), true);
  assert.equal(developer.canAuthorizeTransition("offboarding", "completed", "active"), false);
  assert.equal(developer.canAuthorizeEmploymentTransition(
    "employment_active",
    "exit_in_progress",
  ), true);
  assert.equal(developer.canAuthorizeEmploymentTransition(
    "exit_in_progress",
    "employment_active",
  ), true);
  assert.equal(developer.canAuthorizeEmploymentTransition(
    "employment_ended",
    "employment_active",
  ), false);
});

test("dieselbe fachberechtigte Person darf Offboarding vorbereiten und freigeben", () => {
  for (const role of ["hr", "admin", "it_admin", "developer"]) {
    const access = createPersonnelLifecycleCaseAccessSnapshot(personalSession(role, [
      P.OFFBOARDING_CONFIDENTIAL_READ,
      P.OFFBOARDING_PREPARE,
      P.OFFBOARDING_COMMUNICATION_RELEASE,
    ]));
    assert.equal(access.canPrepareOffboarding, true, role);
    assert.equal(access.canReleaseOffboardingCommunication, true, role);
    assert.equal(access.canAuthorizeTransition(
      "offboarding",
      null,
      "internally_prepared",
    ), true, role);
    assert.equal(access.canAuthorizeTransition(
      "offboarding",
      "internally_prepared",
      "communication_released",
    ), true, role);
  }
});

test("Aktionsrechte ohne das jeweilige Leserecht bleiben unwirksam", () => {
  for (const permission of ONBOARDING_ACTION_RIGHTS.slice(1)) {
    const access = createPersonnelLifecycleCaseAccessSnapshot(personalSession("developer", [
      permission,
    ]));
    assert.equal(access.canReadOnboarding, false, permission);
    assert.equal(access.canPrepareOnboarding, false, permission);
    assert.equal(access.canApproveOnboarding, false, permission);
    assert.equal(access.canExecuteOnboarding, false, permission);
    assert.equal(access.canCloseOnboarding, false, permission);
  }
  for (const permission of OFFBOARDING_ACTION_RIGHTS.slice(1)) {
    const access = createPersonnelLifecycleCaseAccessSnapshot(personalSession("developer", [
      permission,
    ]));
    assert.equal(access.canReadOffboardingConfidential, false, permission);
    assert.equal(access.canPrepareOffboarding, false, permission);
    assert.equal(access.canReleaseOffboardingCommunication, false, permission);
    assert.equal(access.canConfirmOffboardingInformation, false, permission);
    assert.equal(access.canExecuteOffboarding, false, permission);
    assert.equal(access.canCloseOffboarding, false, permission);
  }
});

test("Abbruch nach Kommunikationsfreigabe verlangt Freigabe- und Abschlussrecht gemeinsam", () => {
  const closeOnly = createPersonnelLifecycleCaseAccessSnapshot(personalSession("hr", [
    P.OFFBOARDING_CONFIDENTIAL_READ,
    P.OFFBOARDING_CLOSE,
  ]));
  assert.equal(closeOnly.canAuthorizeTransition(
    "offboarding",
    "communication_released",
    "cancelled",
  ), false);
  assert.equal(closeOnly.canAuthorizeTransition("offboarding", "active", "completed"), true);
  assert.equal(closeOnly.canAuthorizeEmploymentTransition(
    "exit_in_progress",
    "employment_active",
  ), false);

  const releasedClose = createPersonnelLifecycleCaseAccessSnapshot(personalSession("hr", [
    P.OFFBOARDING_CONFIDENTIAL_READ,
    P.OFFBOARDING_COMMUNICATION_RELEASE,
    P.OFFBOARDING_CLOSE,
  ]));
  assert.equal(releasedClose.canAuthorizeTransition(
    "offboarding",
    "communication_released",
    "cancelled",
  ), true);
  assert.equal(releasedClose.canAuthorizeEmploymentTransition(
    "exit_in_progress",
    "employment_active",
  ), true);

  const preparedClose = createPersonnelLifecycleCaseAccessSnapshot(personalSession("hr", [
    P.OFFBOARDING_CONFIDENTIAL_READ,
    P.OFFBOARDING_PREPARE,
    P.OFFBOARDING_CLOSE,
  ]));
  assert.equal(preparedClose.canAuthorizeTransition(
    "offboarding",
    "internally_prepared",
    "cancelled",
  ), true);
});

test("lokale, geteilte und technische Dienstidentitäten treffen keine Fachentscheidung", () => {
  const forgedPermissions = [...PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS];
  for (const session of [
    {
      localSystem: true,
      sessionKind: "local",
      employeeNumber: "local",
      role: "local",
      permissions: forgedPermissions,
    },
    personalSession("developer", forgedPermissions, { serviceAccount: true }),
    personalSession("developer", forgedPermissions, { sharedAccount: true }),
    personalSession("developer", forgedPermissions, { active: false }),
    { role: "developer", employeeNumber: "missing-session-kind", permissions: forgedPermissions },
  ]) {
    const access = createPersonnelLifecycleCaseAccessSnapshot(session);
    assert.equal(access.namedActor, false);
    assert.equal(access.central, false);
    assert.equal(Object.values(access.capabilities).every((value) => value === false), true);
  }
});

test("vertrauliche Schutzklassen benötigen jeweils ihr eigenes Fachrecht", () => {
  const base = createPersonnelLifecycleCaseAccessSnapshot(personalSession("developer", [
    P.ONBOARDING_READ,
    P.OFFBOARDING_CONFIDENTIAL_READ,
  ]));
  assert.equal(base.canReadClassification(C.OPERATIONAL_STANDARD, {
    caseType: "onboarding",
  }), true);
  assert.equal(base.canReadClassification(C.PERSONAL_RESTRICTED, {
    caseType: "onboarding",
  }), false);
  assert.equal(base.canReadClassification(C.HR_CONFIDENTIAL, {
    caseType: "onboarding",
  }), false);
  assert.equal(base.canReadClassification(C.OFFBOARDING_STRICT_CONFIDENTIAL, {
    caseType: "offboarding",
  }), true);

  const protectedAccess = createPersonnelLifecycleCaseAccessSnapshot(personalSession("developer", [
    P.ONBOARDING_READ,
    P.OFFBOARDING_CONFIDENTIAL_READ,
    P.PERSONAL_RESTRICTED_READ,
    P.HR_CONFIDENTIAL_READ,
  ]));
  assert.equal(protectedAccess.canReadClassification(C.PERSONAL_RESTRICTED, {
    caseType: "onboarding",
  }), true);
  assert.equal(protectedAccess.canReadClassification(C.HR_CONFIDENTIAL, {
    caseType: "offboarding",
  }), true);
  assert.equal(protectedAccess.canReadClassification("unknown", {
    caseType: "onboarding",
  }), false);
});

test("Delegation und Auditrechte erzeugen keinen Fallzugriff", () => {
  const delegated = createPersonnelLifecycleCaseAccessSnapshot(personalSession("developer", [
    P.DELEGATE,
    P.AUDIT_READ,
    P.CONFIDENTIAL_AUDIT_READ,
  ]));
  assert.equal(delegated.canDelegate, true);
  assert.equal(delegated.canReadAudit, true);
  assert.equal(delegated.canReadConfidentialAudit, true);
  assert.equal(delegated.canReadOnboarding, false);
  assert.equal(delegated.canReadOffboardingConfidential, false);
  assert.equal(delegated.canReadClassification(C.OPERATIONAL_STANDARD, {
    caseType: "onboarding",
  }), false);
});

test("FL wirkt nur am ganzen freigegebenen Standort und erst nach operativer Freigabe", () => {
  const manager = createPersonnelLifecycleCaseAccessSnapshot(personalSession("manager", [
    P.OPERATIONAL_READ,
    P.OPERATIONAL_UPDATE,
    P.OFFBOARDING_CONFIDENTIAL_READ,
  ], {
    explicitScopes: [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: [
      approvedScope(P.OPERATIONAL_READ, LOCATION_A),
      approvedScope(P.OPERATIONAL_UPDATE, LOCATION_A),
      approvedScope(P.OPERATIONAL_READ, LOCATION_B),
    ],
  }));
  assert.equal(manager.central, false);
  assert.equal(manager.scoped, true);
  assert.equal(manager.canReadOperational, true);
  assert.equal(manager.canUpdateOperational, true);
  assert.equal(manager.canReadOffboardingConfidential, false);
  assert.equal(manager.canReadOperationalScope(operationalContext()), true);
  assert.equal(manager.canUpdateOperationalScope(operationalContext()), true);
  assert.equal(manager.canReadOperationalScope(operationalContext({
    operationalReleased: false,
  })), false);
  assert.equal(manager.canReadOperationalScope(operationalContext({
    caseType: "offboarding",
    operationalReleased: false,
  })), false);
  assert.equal(manager.canReadOperationalScope(operationalContext({
    caseType: "offboarding",
    operationalReleased: true,
  })), true);
  assert.equal(manager.canReadOperationalScope(operationalContext({
    scope: { locationId: LOCATION_B, departmentId: DEPARTMENT_B },
  })), false);
});

test("AL benötigt die exakte Schnittmenge aus Standort und Abteilung", () => {
  const departmentManager = createPersonnelLifecycleCaseAccessSnapshot(
    personalSession("department_manager", [P.OPERATIONAL_READ], {
      explicitScopes: [{ locationId: LOCATION_A, departmentId: DEPARTMENT_A }],
      permissionScopes: [
        approvedScope(P.OPERATIONAL_READ, LOCATION_A, DEPARTMENT_A),
        approvedScope(P.OPERATIONAL_READ, LOCATION_A, DEPARTMENT_B),
        approvedScope(P.OPERATIONAL_READ, LOCATION_B, DEPARTMENT_A),
      ],
    }),
  );
  assert.equal(departmentManager.canReadOperationalScope(operationalContext()), true);
  assert.equal(departmentManager.canReadOperationalScope(operationalContext({
    scope: { locationId: LOCATION_A, departmentId: DEPARTMENT_B },
  })), false);
  assert.equal(departmentManager.canReadOperationalScope(operationalContext({
    scope: { locationId: LOCATION_A, departmentId: null },
  })), false);
  assert.equal(departmentManager.canReadOperationalScope(operationalContext({
    scope: { locationId: LOCATION_B, departmentId: DEPARTMENT_A },
  })), false);
});

test("fehlende Genehmigungsidentität oder allgemeiner Portalbereich öffnet keinen Scope", () => {
  const withoutApproval = createPersonnelLifecycleCaseAccessSnapshot(personalSession("manager", [
    P.OPERATIONAL_READ,
  ], {
    explicitScopes: [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: [approvedScope(P.OPERATIONAL_READ, LOCATION_A, null, "")],
  }));
  assert.equal(withoutApproval.canReadOperational, false);

  const withoutGeneralScope = createPersonnelLifecycleCaseAccessSnapshot(personalSession("manager", [
    P.OPERATIONAL_READ,
  ], {
    explicitScopes: [],
    permissionScopes: [approvedScope(P.OPERATIONAL_READ, LOCATION_A)],
  }));
  assert.equal(withoutGeneralScope.canReadOperational, false);
});

test("genehmigte Fachscopes akzeptieren beide kanonischen Eingabeformen und bleiben eingefroren", () => {
  const objectForm = createPersonnelLifecycleCaseAccessSnapshot(personalSession("manager", [
    P.OPERATIONAL_READ,
  ], {
    explicitScopes: [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: {
      [P.OPERATIONAL_READ]: [{
        locationId: LOCATION_A,
        departmentId: null,
        approvedBy: "pl-plus",
      }],
    },
  }));
  assert.equal(objectForm.canReadOperationalScope(operationalContext()), true);
  assert.equal(Object.isFrozen(objectForm.allowedScopesByPermission[P.OPERATIONAL_READ]), true);

  const central = createPersonnelLifecycleCaseAccessSnapshot(personalSession("developer", [
    P.ONBOARDING_READ,
  ]));
  assert.equal(Object.isFrozen(central.allowedScopesByPermission[P.OPERATIONAL_READ]), true);
  assert.throws(
    () => central.allowedScopesByPermission[P.OPERATIONAL_READ].push({ locationId: LOCATION_A }),
    TypeError,
  );
});

test("Mitarbeiter sieht nur ausdrücklich freigegebene eigene Inhalte", () => {
  const employee = createPersonnelLifecycleCaseAccessSnapshot(personalSession("employee", [], {
    employeeNumber: "EMP-1",
  }));
  const ownOnboarding = {
    caseType: "onboarding",
    subjectEmployeeNumber: "EMP-1",
    portalActive: true,
    employeeReleased: true,
  };
  assert.equal(employee.canReadClassification(C.EMPLOYEE_RELEASED, ownOnboarding), true);
  assert.deepEqual(employee.project({
    orderId: "employee-order-1",
    title: "Eigene Unterlage prüfen",
    instructions: "Nur freigegebener Inhalt",
    dueAt: "2026-09-01T08:00:00.000Z",
    status: "pending",
    evidenceStatus: "missing",
    hrNote: "darf nicht erscheinen",
  }, PROJECTION.EMPLOYEE_TASK, {
    ...ownOnboarding,
    recipientClass: RECIPIENT.EMPLOYEE,
  }), {
    orderId: "employee-order-1",
    title: "Eigene Unterlage prüfen",
    instructions: "Nur freigegebener Inhalt",
    dueAt: "2026-09-01T08:00:00.000Z",
    status: "pending",
    evidenceStatus: "missing",
  });
  assert.equal(employee.project({}, PROJECTION.EMPLOYEE_TASK, ownOnboarding), null);
  assert.equal(employee.canReadClassification(C.OPERATIONAL_STANDARD, ownOnboarding), false);
  assert.equal(employee.canReadClassification(C.HR_CONFIDENTIAL, ownOnboarding), false);
  assert.equal(employee.canReadClassification(C.OFFBOARDING_STRICT_CONFIDENTIAL, {
    ...ownOnboarding,
    caseType: "offboarding",
    employeeInformed: true,
  }), false);
  assert.equal(employee.canReadClassification(C.EMPLOYEE_RELEASED, {
    ...ownOnboarding,
    subjectEmployeeNumber: "EMP-2",
  }), false);
  assert.equal(employee.canReadClassification(C.EMPLOYEE_RELEASED, {
    ...ownOnboarding,
    portalActive: false,
  }), false);
  assert.equal(employee.canReadClassification(C.EMPLOYEE_RELEASED, {
    ...ownOnboarding,
    caseType: "offboarding",
    employeeInformed: false,
  }), false);
  assert.equal(employee.canReadClassification(C.EMPLOYEE_RELEASED, {
    ...ownOnboarding,
    caseType: "offboarding",
    employeeInformed: true,
  }), true);
});

test("zugewiesene Fachstellen erhalten nur ihre minimale operative Projektion", () => {
  const assignee = createPersonnelLifecycleCaseAccessSnapshot(personalSession("employee", [], {
    employeeNumber: "IT-ASSIGNEE",
  }));
  const source = {
    orderId: "order-1",
    displayName: "Erika Beispiel",
    businessIdentifier: "e.beispiel",
    targetSystem: "directory",
    action: "disable",
    executeAt: "2026-09-30T16:00:00.000Z",
    status: "pending",
    exitReason: "streng vertraulich",
    hrNotes: "streng vertraulich",
  };
  const context = {
    caseType: "offboarding",
    recipientClass: RECIPIENT.IT_SECURITY,
    assignedActorId: "IT-ASSIGNEE",
    assignmentActive: true,
    operationalReleased: true,
  };
  assert.deepEqual(assignee.project(source, PROJECTION.IT_SECURITY_TASK, context), {
    orderId: "order-1",
    displayName: "Erika Beispiel",
    businessIdentifier: "e.beispiel",
    targetSystem: "directory",
    action: "disable",
    executeAt: "2026-09-30T16:00:00.000Z",
    status: "pending",
  });
  assert.equal(assignee.project(source, PROJECTION.IT_SECURITY_TASK, {
    ...context,
    operationalReleased: false,
  }), null);
  assert.equal(assignee.project(source, PROJECTION.IT_SECURITY_TASK, {
    ...context,
    assignedActorId: "OTHER",
  }), null);
  assert.equal(assignee.project(source, PROJECTION.PAYROLL_TASK, context), null);
  assert.equal(assignee.project(source, PROJECTION.OFFBOARDING_CONFIDENTIAL, context), null);
});

test("zentrale Fachstellen brauchen fuer freigegebene Aufgaben kein vertrauliches Fallrecht", () => {
  const operational = createPersonnelLifecycleCaseAccessSnapshot(personalSession("it_admin", [
    P.OPERATIONAL_READ,
    P.OPERATIONAL_UPDATE,
  ], { employeeNumber: "IT-ASSIGNEE" }));
  const context = {
    caseType: "offboarding",
    recipientClass: RECIPIENT.IT_SECURITY,
    assignedActorId: "IT-ASSIGNEE",
    assignmentActive: true,
    operationalReleased: true,
    scope: { locationId: "loc-1", departmentId: null },
  };
  assert.equal(operational.canReadOffboardingConfidential, false);
  assert.equal(operational.canReadOperationalScope(context), true);
  assert.equal(operational.canUpdateOperationalScope(context), true);
  assert.deepEqual(operational.project({
    orderId: "order-1",
    displayName: "Erika Beispiel",
    businessIdentifier: "EMP-1",
    targetSystem: "managed_accesses",
    action: "Konten sperren",
    executeAt: "2026-09-30T16:00:00.000Z",
    status: "pending",
    exitReason: "darf nicht erscheinen",
  }, PROJECTION.IT_SECURITY_TASK, context), {
    orderId: "order-1",
    displayName: "Erika Beispiel",
    businessIdentifier: "EMP-1",
    targetSystem: "managed_accesses",
    action: "Konten sperren",
    executeAt: "2026-09-30T16:00:00.000Z",
    status: "pending",
  });
  assert.equal(operational.project({}, PROJECTION.OFFBOARDING_CONFIDENTIAL, context), null);
});

test("geschützte Auditprojektion verlangt beide Audit-Fachrechte und bleibt datensparsam", () => {
  const event = {
    accessEventId: "access-1",
    caseId: "case-1",
    actorId: "auditor-1",
    action: "detail_read",
    occurredAt: "2026-08-02T18:00:00.000Z",
    result: "allowed",
    purposeCode: "hr_case_review",
    exitReason: "darf nicht ins Audit",
    protectedPayload: { note: "darf nicht ins Audit" },
  };
  const onlyGeneral = createPersonnelLifecycleCaseAccessSnapshot(personalSession("hr", [
    P.AUDIT_READ,
  ]));
  const context = { recipientClass: RECIPIENT.CONFIDENTIAL_AUDIT };
  assert.equal(onlyGeneral.project(event, PROJECTION.CONFIDENTIAL_AUDIT, context), null);

  const onlyConfidential = createPersonnelLifecycleCaseAccessSnapshot(personalSession("hr", [
    P.CONFIDENTIAL_AUDIT_READ,
  ]));
  assert.equal(onlyConfidential.project(event, PROJECTION.CONFIDENTIAL_AUDIT, context), null);

  const auditor = createPersonnelLifecycleCaseAccessSnapshot(personalSession("developer", [
    P.AUDIT_READ,
    P.CONFIDENTIAL_AUDIT_READ,
  ]));
  assert.deepEqual(auditor.project(event, PROJECTION.CONFIDENTIAL_AUDIT, context), {
    accessEventId: "access-1",
    caseId: "case-1",
    actorId: "auditor-1",
    action: "detail_read",
    occurredAt: "2026-08-02T18:00:00.000Z",
    result: "allowed",
    purposeCode: "hr_case_review",
  });
});

test("O1 bleibt auch für einen vollständig berechtigten Akteur technisch geschlossen", () => {
  const access = createPersonnelLifecycleCaseAccessSnapshot(personalSession("developer", [
    ...PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS,
  ]));
  assert.equal(access.runtimeGates, PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES);
  assert.equal(Object.values(access.runtimeGates).every((value) => value === false), true);
  assert.equal("createCase" in access, false);
  assert.equal("startOnboarding" in access, false);
  assert.equal("startOffboarding" in access, false);
  assert.equal("persist" in access, false);
  assert.equal(personnelLifecycleCaseAccessForSession(access), access);
  assert.equal(Object.isFrozen(access), true);
  assert.equal(Object.isFrozen(access.capabilities), true);
});
