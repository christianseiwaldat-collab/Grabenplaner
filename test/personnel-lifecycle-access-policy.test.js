"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PERSONNEL_LIFECYCLE_PERMISSIONS: P,
  PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS,
  PERSONNEL_LIFECYCLE_GLOBAL_ROLES,
  PERSONNEL_LIFECYCLE_SCOPED_ROLES,
  personnelLifecycleAccessForSession,
  personnelLifecycleCapabilities,
  personnelLifecycleScopeMatches,
  visiblePersonnelLifecycleApplications,
  projectPersonnelLifecycleCandidate,
  projectPersonnelLifecycleCandidateList,
  projectPersonnelLifecycleCandidateDetail,
  projectPersonnelLifecycleCandidateListItems,
  projectPersonnelLifecycleApplication,
} = require("../lib/personnel-lifecycle-access");

const LOCATION_A = "location-a";
const LOCATION_B = "location-b";
const DEPARTMENT_A = 11;
const DEPARTMENT_B = 22;

function permissionScope(permission, locationId, departmentId = null, approvedBy = "pl-plus") {
  return { permission, locationId, departmentId, approvedBy };
}

function application(id, locationId, departmentId, overrides = {}) {
  return {
    id,
    candidateId: "candidate-1",
    status: "screening",
    desiredPositionId: "sales",
    desiredLocationId: locationId,
    desiredDepartmentId: departmentId,
    desiredWeeklyMinutes: 2280,
    availableFrom: "2026-09-01",
    desiredRoleTitle: "Verkauf",
    employmentType: "full_time",
    ownerEmployeeNumber: "internal-owner",
    retentionDueAt: "2027-09-01",
    source: "confidential-source",
    internalRating: 5,
    internalNotes: "confidential-notes",
    communicationNotes: "confidential-communication",
    tags: ["confidential-tag"],
    revision: 3,
    statusChangedAt: "2026-08-01T09:00:00.000Z",
    createdBy: "internal-creator",
    updatedBy: "internal-updater",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    requestSha256: "a".repeat(64),
    ...overrides,
  };
}

function candidate() {
  return {
    id: "candidate-1",
    state: "active",
    profile: {
      firstName: "Nora",
      lastName: "Beispiel",
      email: "nora@example.test",
      phone: "+43 512 555123",
      address: {
        street: "Vertraulichkeitsweg 1",
        postalCode: "6020",
        city: "Innsbruck",
      },
      preferredLanguage: "de",
    },
    applications: [
      application("application-local", LOCATION_A, DEPARTMENT_A),
      application("application-foreign", LOCATION_B, DEPARTMENT_B),
    ],
    documents: [{
      id: "document-1",
      visibility: "hr_confidential",
      title: "Vertrauliches Dokument",
    }],
    history: [{
      id: "event-1",
      actorEmployeeNumber: "internal-actor",
      receiptSha256: "b".repeat(64),
      detail: { internalNotes: "history-secret" },
    }],
    conversion: {
      id: "conversion-1",
      employeeNumber: "secret-personnel-number",
      receiptSha256: "c".repeat(64),
    },
    revision: 4,
    createdBy: "internal-creator",
    updatedBy: "internal-updater",
    archivedAt: null,
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

function keysDeep(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value)) {
    result.add(key);
    keysDeep(entry, result);
  }
  return result;
}

function managerSession({ permissions = [P.CANDIDATES_READ], explicitScopes, permissionScopes } = {}) {
  return {
    employeeNumber: "manager-1",
    role: "manager",
    permissions,
    explicitScopes: explicitScopes ?? [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: permissionScopes ?? [
      permissionScope(P.CANDIDATES_READ, LOCATION_A),
    ],
  };
}

function departmentManagerSession({
  permissions = [P.CANDIDATES_READ],
  explicitScopes,
  permissionScopes,
} = {}) {
  return {
    employeeNumber: "department-manager-1",
    role: "department_manager",
    permissions,
    explicitScopes: explicitScopes ?? [{
      locationId: LOCATION_A,
      departmentId: DEPARTMENT_A,
    }],
    permissionScopes: permissionScopes ?? [
      permissionScope(P.CANDIDATES_READ, LOCATION_A, DEPARTMENT_A),
    ],
  };
}

test("Personal-Lifecycle-Rechte und Rollenvertrag bleiben exakt und klein", () => {
  assert.deepEqual(P, {
    CANDIDATES_READ: "personnel:candidates:read",
    CANDIDATES_CREATE: "personnel:candidates:create",
    CANDIDATES_WRITE: "personnel:candidates:write",
    APPLICATIONS_WRITE: "personnel:applications:write",
    CONFIDENTIAL_READ: "personnel:candidates:confidential:read",
    CONFIDENTIAL_WRITE: "personnel:candidates:confidential:write",
    CANDIDATES_CONVERT: "personnel:candidates:convert",
    CANDIDATES_DELEGATE: "personnel:candidates:delegate",
  });
  assert.deepEqual(PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS, Object.values(P));
  assert.deepEqual(PERSONNEL_LIFECYCLE_GLOBAL_ROLES, ["local", "hr", "admin", "developer"]);
  assert.deepEqual(PERSONNEL_LIFECYCLE_SCOPED_ROLES, ["manager", "department_manager"]);
  assert.equal(Object.isFrozen(P), true);
});

test("globale PL liest mit Fachrechten vollständig; PL+ bleibt eine Zusatz-Capability", () => {
  const basePermissions = [
    P.CANDIDATES_READ,
    P.CANDIDATES_CREATE,
    P.CANDIDATES_WRITE,
    P.APPLICATIONS_WRITE,
    P.CONFIDENTIAL_READ,
    P.CONFIDENTIAL_WRITE,
    P.CANDIDATES_CONVERT,
  ];
  const pl = personnelLifecycleAccessForSession({
    employeeNumber: "pl-1",
    role: "hr",
    permissions: basePermissions,
    explicitScopes: [],
    permissionScopes: [],
  });
  assert.equal(pl.global, true);
  assert.equal(pl.canReadCandidates, true);
  assert.equal(pl.canCreateCandidates, true);
  assert.equal(pl.canReadConfidential, true);
  assert.equal(pl.canConvertCandidates, true);
  assert.equal(pl.canDelegateCandidates, false);
  assert.equal(pl.canReadApplication(application("unscoped", null, null)), true);

  const centralWriteDenied = personnelLifecycleAccessForSession({
    employeeNumber: "pl-write-denied",
    role: "hr",
    permissions: basePermissions.filter((permission) => permission !== P.CANDIDATES_WRITE),
    explicitScopes: [],
    permissionScopes: [],
  });
  assert.equal(centralWriteDenied.canReadCandidates, true);
  assert.equal(centralWriteDenied.canCreateCandidates, false);

  const source = candidate();
  const projection = projectPersonnelLifecycleCandidate(source, pl, { detail: true });
  assert.deepEqual(projection, source);
  assert.notEqual(projection, source);
  assert.notEqual(projection.profile, source.profile);

  const plPlus = personnelLifecycleAccessForSession({
    employeeNumber: "pl-plus-1",
    role: "hr",
    permissions: [...basePermissions, P.CANDIDATES_DELEGATE],
  });
  assert.equal(plPlus.canDelegateCandidates, true);
  assert.equal(personnelLifecycleCapabilities(plPlus).canDelegateCandidates, true);
});

test("Umwandlungsrecht allein umgeht die vollständige globale Rechtekette nicht", () => {
  const required = [
    P.CANDIDATES_READ,
    P.CANDIDATES_WRITE,
    P.APPLICATIONS_WRITE,
    P.CONFIDENTIAL_READ,
    P.CONFIDENTIAL_WRITE,
    P.CANDIDATES_CONVERT,
  ];
  for (const missing of required) {
    const access = personnelLifecycleAccessForSession({
      employeeNumber: "pl-incomplete",
      role: "hr",
      permissions: required.filter((permission) => permission !== missing),
    });
    assert.equal(access.canConvertCandidates, false, `Umwandlung trotz fehlendem Recht: ${missing}`);
  }
});

test("IT-Admin bleibt auch mit manipuliert eingetragenen Fachrechten vollständig geschlossen", () => {
  const access = personnelLifecycleAccessForSession({
    employeeNumber: "it-1",
    role: "it_admin",
    permissions: [...PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS],
    explicitScopes: [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS.map((permission) => (
      permissionScope(permission, LOCATION_A)
    )),
  });
  assert.deepEqual(personnelLifecycleCapabilities(access), {
    canReadCandidates: false,
    canCreateCandidates: false,
    canWriteCandidates: false,
    canWriteApplications: false,
    canReadConfidential: false,
    canWriteConfidential: false,
    canConvertCandidates: false,
    canDelegateCandidates: false,
  });
  assert.equal(access.canReadApplication(application("local", LOCATION_A, DEPARTMENT_A)), false);
  assert.equal(projectPersonnelLifecycleCandidateDetail(candidate(), access), null);
});

test("wirksames Recht ohne PL+-Fachscope bleibt für FL geschlossen", () => {
  const access = personnelLifecycleAccessForSession(managerSession({ permissionScopes: [] }));
  assert.equal(access.canReadCandidates, false);
  assert.equal(personnelLifecycleScopeMatches(
    access,
    P.CANDIDATES_READ,
    application("local", LOCATION_A, DEPARTMENT_A),
  ), false);
  assert.deepEqual(visiblePersonnelLifecycleApplications(candidate(), access), []);
});

test("PL+-Fachscope ohne allgemeinen Portalbereich bleibt für FL geschlossen", () => {
  const access = personnelLifecycleAccessForSession(managerSession({ explicitScopes: [] }));
  assert.equal(access.canReadCandidates, false);
  assert.equal(access.canReadApplication(application("local", LOCATION_A, DEPARTMENT_A)), false);
});

test("FL wirkt nur standortweit und nur in der Schnittmenge beider Scope-Quellen", () => {
  const access = personnelLifecycleAccessForSession(managerSession({
    permissions: [
      P.CANDIDATES_READ,
      P.CANDIDATES_CREATE,
      P.APPLICATIONS_WRITE,
      P.CANDIDATES_DELEGATE,
    ],
    explicitScopes: [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: [
      permissionScope(P.CANDIDATES_READ, LOCATION_A),
      permissionScope(P.CANDIDATES_READ, LOCATION_B),
      permissionScope(P.APPLICATIONS_WRITE, LOCATION_A),
      permissionScope(P.CANDIDATES_DELEGATE, LOCATION_A),
    ],
  }));
  assert.equal(access.canReadCandidates, true);
  assert.equal(access.canCreateCandidates, true);
  assert.equal(access.canWriteApplications, true);
  assert.equal(access.canDelegateCandidates, false);
  assert.equal(access.canReadApplication(application("a-1", LOCATION_A, DEPARTMENT_A)), true);
  assert.equal(access.canReadApplication(application("a-2", LOCATION_A, DEPARTMENT_B)), true);
  assert.equal(access.canReadApplication(application("b", LOCATION_B, DEPARTMENT_B)), false);
  assert.equal(access.canWriteApplication(application("a-write", LOCATION_A, DEPARTMENT_A)), true);
  assert.equal(access.canCreateCandidate(application("a-create", LOCATION_A, DEPARTMENT_A)), true);
  assert.equal(access.canCreateCandidate(application("b-create", LOCATION_B, DEPARTMENT_B)), false);

  const createDenied = personnelLifecycleAccessForSession(managerSession({
    permissions: [P.CANDIDATES_READ, P.APPLICATIONS_WRITE],
    permissionScopes: [
      permissionScope(P.CANDIDATES_READ, LOCATION_A),
      permissionScope(P.APPLICATIONS_WRITE, LOCATION_A),
    ],
  }));
  assert.equal(createDenied.canCreateCandidates, false);

  const departmentOnly = personnelLifecycleAccessForSession(managerSession({
    explicitScopes: [{ locationId: LOCATION_A, departmentId: DEPARTMENT_A }],
    permissionScopes: [permissionScope(P.CANDIDATES_READ, LOCATION_A, DEPARTMENT_A)],
  }));
  assert.equal(departmentOnly.canReadCandidates, false);
});

test("lokale Leitungen erhalten auch bei manipuliertem Kandidaten-Schreibrecht keinen Profilzugriff", () => {
  const access = personnelLifecycleAccessForSession(managerSession({
    permissions: [P.CANDIDATES_READ, P.CANDIDATES_WRITE],
    permissionScopes: [
      permissionScope(P.CANDIDATES_READ, LOCATION_A),
      permissionScope(P.CANDIDATES_WRITE, LOCATION_A),
    ],
  }));
  assert.equal(access.canReadCandidates, true);
  assert.equal(access.canWriteCandidates, false);
  assert.equal(access.canWriteCandidate(application("local", LOCATION_A, DEPARTMENT_A)), false);
});

test("AL benötigt auf beiden Seiten dieselbe konkrete Abteilung", () => {
  const access = personnelLifecycleAccessForSession(departmentManagerSession({
    permissionScopes: [
      permissionScope(P.CANDIDATES_READ, LOCATION_A, DEPARTMENT_A),
      permissionScope(P.CANDIDATES_READ, LOCATION_A, DEPARTMENT_B),
      permissionScope(P.CANDIDATES_READ, LOCATION_B, DEPARTMENT_A),
    ],
  }));
  assert.equal(access.canReadCandidates, true);
  assert.equal(access.canCreateCandidates, false);
  assert.equal(access.canReadApplication(application("matching", LOCATION_A, DEPARTMENT_A)), true);
  assert.equal(access.canReadApplication(application("other-department", LOCATION_A, DEPARTMENT_B)), false);
  assert.equal(access.canReadApplication(application("whole-location", LOCATION_A, null)), false);
  assert.equal(access.canReadApplication(application("other-location", LOCATION_B, DEPARTMENT_A)), false);

  const wholeLocation = personnelLifecycleAccessForSession(departmentManagerSession({
    explicitScopes: [{ locationId: LOCATION_A, departmentId: null }],
    permissionScopes: [permissionScope(P.CANDIDATES_READ, LOCATION_A)],
  }));
  assert.equal(wholeLocation.canReadCandidates, false);
});

test("fehlende Genehmigungsidentität und strukturell ungültige Fachscopes öffnen nichts", () => {
  const access = personnelLifecycleAccessForSession(managerSession({
    permissionScopes: [
      permissionScope(P.CANDIDATES_READ, LOCATION_A, null, ""),
      permissionScope(P.CANDIDATES_READ, "", null),
      permissionScope(P.CANDIDATES_READ, LOCATION_A, -1),
    ],
  }));
  assert.equal(access.canReadCandidates, false);
  assert.equal(projectPersonnelLifecycleCandidateList(candidate(), access), null);
});

test("lokale Liste und Detail filtern Mehrfachbewerbungen und vertrauliche Schlüssel", () => {
  const access = personnelLifecycleAccessForSession(managerSession());
  const source = candidate();
  Object.assign(source.applications[0], {
    competencyRatings: [{ id: "fachlich", label: "Fachlich", rating: 4, note: "Detailnotiz" }],
    targetAreas: [{ locationId: LOCATION_A, departmentId: DEPARTMENT_A, preferred: true }],
    teamFeedback: [{
      id: "feedback-1",
      trialAppointmentId: "trial-1",
      employeeNumber: "252",
      rating: 5,
      comment: "Vertrauliche Teamrückmeldung",
      recordedByEmployeeNumber: "101",
      recordedAt: "2026-08-24T10:00:00.000Z",
    }],
    trialAppointments: [{
      id: "trial-1",
      dateFrom: "2026-09-03",
      dateTo: "2026-09-03",
      startTime: "09:00",
      endTime: "12:00",
      locationId: LOCATION_A,
      departmentId: DEPARTMENT_A,
      status: "planned",
      note: "Vertrauliche Terminnotiz",
    }],
  });
  const listProjection = projectPersonnelLifecycleCandidateList(source, access);
  const detailProjection = projectPersonnelLifecycleCandidateDetail(source, access);

  assert.deepEqual(listProjection.profile, { firstName: "Nora", lastName: "Beispiel" });
  assert.deepEqual(detailProjection.profile, {
    firstName: "Nora",
    lastName: "Beispiel",
    email: "nora@example.test",
    phone: "+43 512 555123",
    residence: {
      postalCode: "6020",
      city: "Innsbruck",
    },
  });
  assert.deepEqual(listProjection.applications.map(({ id }) => id), ["application-local"]);
  assert.deepEqual(detailProjection.applications.map(({ id }) => id), ["application-local"]);
  assert.equal(listProjection.applications[0].desiredRoleTitle, "Verkauf");
  assert.deepEqual(Object.keys(listProjection.applications[0]).sort(), [
    "candidateId",
    "createdAt",
    "desiredDepartmentId",
    "desiredLocationId",
    "desiredRoleTitle",
    "id",
    "status",
    "statusChangedAt",
    "updatedAt",
  ]);
  assert.deepEqual(detailProjection.applications[0].competencyRatings, source.applications[0].competencyRatings);
  assert.deepEqual(detailProjection.applications[0].targetAreas, source.applications[0].targetAreas);
  assert.deepEqual(detailProjection.applications[0].teamFeedback, source.applications[0].teamFeedback);
  assert.deepEqual(detailProjection.applications[0].trialAppointments, source.applications[0].trialAppointments);
  assert.equal(detailProjection.applications[0].canWrite, false);

  const forbiddenKeys = new Set([
    "address",
    "preferredLanguage",
    "source",
    "internalRating",
    "internalNotes",
    "communicationNotes",
    "tags",
    "documents",
    "history",
    "conversion",
    "ownerEmployeeNumber",
    "retentionDueAt",
    "createdBy",
    "updatedBy",
    "actorEmployeeNumber",
    "receiptSha256",
    "previousReceiptSha256",
    "requestSha256",
  ]);
  for (const projection of [listProjection, detailProjection]) {
    const projectedKeys = keysDeep(projection);
    for (const key of forbiddenKeys) assert.equal(projectedKeys.has(key), false, key);
    assert.equal(JSON.stringify(projection).includes("application-foreign"), false);
    assert.equal(JSON.stringify(projection).includes("confidential"), false);
  }

  const projectedApplication = projectPersonnelLifecycleApplication(
    source.applications[0],
    access,
  );
  assert.equal(projectedApplication.id, "application-local");
  assert.equal(Object.hasOwn(projectedApplication, "internalNotes"), false);
  assert.equal(projectPersonnelLifecycleApplication(source.applications[1], access), null);
});

test("globale Leseberechtigung ohne vertrauliches Zusatzrecht bleibt datensparsam", () => {
  const access = personnelLifecycleAccessForSession({
    employeeNumber: "pl-readonly",
    role: "hr",
    permissions: [P.CANDIDATES_READ],
  });
  const projected = projectPersonnelLifecycleCandidateDetail(candidate(), access);
  assert.deepEqual(projected.applications.map(({ id }) => id), [
    "application-local",
    "application-foreign",
  ]);
  assert.equal(Object.hasOwn(projected, "documents"), false);
  assert.equal(Object.hasOwn(projected.applications[0], "source"), false);
});

test("lokale Projektion kennzeichnet Schreibbarkeit je sichtbarer Bewerbung", () => {
  const access = personnelLifecycleAccessForSession(managerSession({
    permissions: [P.CANDIDATES_READ, P.APPLICATIONS_WRITE],
    explicitScopes: [
      { locationId: LOCATION_A, departmentId: null },
      { locationId: LOCATION_B, departmentId: null },
    ],
    permissionScopes: [
      permissionScope(P.CANDIDATES_READ, LOCATION_A),
      permissionScope(P.CANDIDATES_READ, LOCATION_B),
      permissionScope(P.APPLICATIONS_WRITE, LOCATION_A),
    ],
  }));
  const projected = projectPersonnelLifecycleCandidateDetail(candidate(), access);
  assert.deepEqual(
    projected.applications.map(({ id, canWrite }) => ({ id, canWrite })),
    [
      { id: "application-local", canWrite: true },
      { id: "application-foreign", canWrite: false },
    ],
  );
});

test("Listenprojektion entfernt vollständig unsichtbare Bewerber", () => {
  const access = personnelLifecycleAccessForSession(managerSession());
  const visible = candidate();
  const hidden = {
    ...candidate(),
    id: "candidate-hidden",
    applications: [application("only-foreign", LOCATION_B, DEPARTMENT_B)],
  };
  assert.deepEqual(
    projectPersonnelLifecycleCandidateListItems([visible, hidden], access).map(({ id }) => id),
    ["candidate-1"],
  );
});

test("lokaler Systemzugriff bleibt vollständig, ohne IT-Admin zu privilegieren", () => {
  const source = candidate();
  const local = personnelLifecycleAccessForSession({
    employeeNumber: "local",
    role: "admin",
    permissions: [],
    sessionKind: "local",
    localSystem: true,
  });
  assert.equal(local.localSystem, true);
  assert.equal(local.canDelegateCandidates, true);
  const localList = projectPersonnelLifecycleCandidateList(source, local);
  assert.deepEqual(localList.profile, { firstName: "Nora", lastName: "Beispiel" });
  assert.equal(Object.hasOwn(localList.applications[0], "internalNotes"), false);
  assert.equal(Object.hasOwn(localList.applications[0], "canWrite"), false);
  assert.deepEqual(projectPersonnelLifecycleCandidate(source, local, { detail: true }), source);

  for (const forged of [
    { employeeNumber: "local", role: "manager", permissions: PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS },
    { employeeNumber: "anything", role: "local", permissions: PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS },
    { employeeNumber: "local", role: "employee", permissions: PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS, localSystem: true },
  ]) {
    const access = personnelLifecycleAccessForSession(forged);
    assert.equal(access.localSystem, false);
    assert.equal(access.canDelegateCandidates, false);
  }
});
