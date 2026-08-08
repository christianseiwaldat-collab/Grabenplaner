"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PERSONNEL_PROFILE_PERMISSIONS,
  PERSONNEL_PROFILE_PERMISSION_IDS,
  PERSONNEL_PROFILE_SCOPED_PERMISSIONS,
  createPersonnelProfileAccessSnapshot,
  personnelProfileAccessForSession,
  personnelProfileScopeMatches,
} = require("../lib/personnel-profile-access");

const ALL_PERMISSIONS = Object.freeze([...PERSONNEL_PROFILE_PERMISSION_IDS]);

function personalSession(role, overrides = {}) {
  return {
    sessionKind: "employee",
    isEmployee: true,
    employeeNumber: `${role}-actor`,
    role,
    permissions: ALL_PERMISSIONS,
    ...overrides,
  };
}

function approvedScope(permission, locationId, departmentId = null, overrides = {}) {
  return {
    permission,
    locationId,
    departmentId,
    approvedBy: "pl-plus",
    ...overrides,
  };
}

test("M7 Profilrechte: IDs und lokal delegierbare Teilmenge sind stabil", () => {
  assert.deepEqual(PERSONNEL_PROFILE_PERMISSIONS, {
    READ: "personnel:profiles:read",
    MASTER_READ: "personnel:profiles:master:read",
    DOCUMENTS_READ: "personnel:profiles:documents:read",
    DELEGATE: "personnel:profiles:delegate",
  });
  assert.deepEqual(PERSONNEL_PROFILE_PERMISSION_IDS, [
    "personnel:profiles:read",
    "personnel:profiles:master:read",
    "personnel:profiles:documents:read",
    "personnel:profiles:delegate",
  ]);
  assert.deepEqual(PERSONNEL_PROFILE_SCOPED_PERMISSIONS, [
    "personnel:profiles:read",
    "personnel:profiles:master:read",
  ]);
  assert.equal(Object.isFrozen(PERSONNEL_PROFILE_PERMISSIONS), true);
  assert.equal(Object.isFrozen(PERSONNEL_PROFILE_PERMISSION_IDS), true);
  assert.equal(Object.isFrozen(PERSONNEL_PROFILE_SCOPED_PERMISSIONS), true);
});

test("M7 Profilrechte: nur der echte lokale Systemzugang umgeht fachliche Rechte", () => {
  const local = createPersonnelProfileAccessSnapshot({
    localSystem: true,
    sessionKind: "local",
    employeeNumber: "local",
    role: "local",
  });
  assert.deepEqual(local.capabilities, {
    canReadProfiles: true,
    canReadMaster: true,
    canReadDocuments: true,
    canDelegateProfiles: true,
  });
  assert.equal(local.canReadSubject({}), true);
  assert.equal(local.canReadMasterSubject({}), true);
  assert.equal(local.canReadDocumentsSubject({}), true);

  const forged = createPersonnelProfileAccessSnapshot({
    localSystem: false,
    sessionKind: "employee",
    isEmployee: true,
    employeeNumber: "forged-local",
    role: "local",
    permissions: ALL_PERMISSIONS,
  });
  assert.deepEqual(forged.capabilities, {
    canReadProfiles: false,
    canReadMaster: false,
    canReadDocuments: false,
    canDelegateProfiles: false,
  });
});

test("M7 Profilrechte: PL liest global, PL+ delegiert nur mit eigener Capability", () => {
  const pl = createPersonnelProfileAccessSnapshot(personalSession("hr", {
    permissions: [
      PERSONNEL_PROFILE_PERMISSIONS.READ,
      PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ,
      PERSONNEL_PROFILE_PERMISSIONS.DOCUMENTS_READ,
    ],
  }));
  assert.deepEqual(pl.capabilities, {
    canReadProfiles: true,
    canReadMaster: true,
    canReadDocuments: true,
    canDelegateProfiles: false,
  });
  assert.equal(pl.canReadSubject({ locationId: null }), true);
  assert.equal(pl.canReadMasterSubject({ locationId: null }), true);
  assert.equal(pl.canReadDocumentsSubject({ locationId: null }), true);

  const plPlus = personnelProfileAccessForSession(personalSession("hr"));
  assert.equal(plPlus.capabilities.canDelegateProfiles, true);
  assert.equal(personnelProfileAccessForSession(plPlus), plPlus);

  const withoutBase = createPersonnelProfileAccessSnapshot(personalSession("hr", {
    permissions: [
      PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ,
      PERSONNEL_PROFILE_PERMISSIONS.DOCUMENTS_READ,
      PERSONNEL_PROFILE_PERMISSIONS.DELEGATE,
    ],
  }));
  assert.equal(withoutBase.capabilities.canReadProfiles, false);
  assert.equal(withoutBase.capabilities.canReadMaster, false);
  assert.equal(withoutBase.capabilities.canReadDocuments, false);
  assert.equal(withoutBase.capabilities.canDelegateProfiles, true);
});

test("M7 Profilrechte: Developer hat globalen Vollzugriff, andere technische Rollen nicht", () => {
  const developer = createPersonnelProfileAccessSnapshot(personalSession("developer"));
  assert.equal(developer.personalEmployee, true);
  assert.equal(developer.personalDeveloper, true);
  assert.deepEqual(developer.capabilities, {
    canReadProfiles: true,
    canReadMaster: true,
    canReadDocuments: true,
    canDelegateProfiles: true,
  });
  assert.equal(developer.canReadSubject({ locationId: "vienna", departmentId: 17 }), true);
  assert.equal(developer.canReadMasterSubject({ locationId: "graz", departmentId: 99 }), true);
  assert.equal(developer.canReadDocumentsSubject({ locationId: "vienna" }), true);

  for (const role of ["admin"]) {
    const technical = createPersonnelProfileAccessSnapshot(personalSession(role));
    assert.equal(technical.capabilities.canReadProfiles, false, role);
    assert.equal(technical.capabilities.canReadMaster, false, role);
    assert.equal(technical.capabilities.canReadDocuments, false, role);
    assert.equal(technical.capabilities.canDelegateProfiles, true, role);
  }
  const itAdmin = createPersonnelProfileAccessSnapshot(personalSession("it_admin"));
  assert.deepEqual(itAdmin.capabilities, {
    canReadProfiles: false,
    canReadMaster: false,
    canReadDocuments: false,
    canDelegateProfiles: false,
  });
  for (const role of ["hr", "admin", "developer"]) {
    const organizationSession = createPersonnelProfileAccessSnapshot({
      sessionKind: "organization",
      isEmployee: false,
      employeeNumber: "",
      role,
      permissions: ALL_PERMISSIONS,
    });
    assert.equal(organizationSession.capabilities.canDelegateProfiles, false, role);
    assert.equal(organizationSession.capabilities.canReadProfiles, false, role);
  }
});

test("M7 Profilrechte: FL braucht die Schnittmenge aus allgemeinem und PL+-Freigabebereich", () => {
  const manager = createPersonnelProfileAccessSnapshot(personalSession("manager", {
    explicitScopes: [{ locationId: "vienna", departmentId: null }],
    permissionScopes: [
      approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "vienna"),
      approvedScope(PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ, "vienna"),
      approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "graz"),
      approvedScope(PERSONNEL_PROFILE_PERMISSIONS.DOCUMENTS_READ, "vienna"),
    ],
  }));
  assert.equal(manager.capabilities.canReadProfiles, true);
  assert.equal(manager.capabilities.canReadMaster, true);
  assert.equal(manager.capabilities.canReadDocuments, false);
  assert.equal(manager.capabilities.canDelegateProfiles, false);
  assert.equal(manager.canReadSubject({ home_location_id: "vienna", preferred_department_id: 17 }), true);
  assert.equal(manager.canReadMasterSubject({ locationId: "vienna", departmentId: 99 }), true);
  assert.equal(manager.canReadSubject({ locationId: "graz", departmentId: null }), false);
  assert.equal(manager.canReadDocumentsSubject({ locationId: "vienna" }), false);
  assert.equal(personnelProfileScopeMatches(
    manager,
    PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ,
    { locationId: "vienna", departmentId: 17 },
  ), true);

  const departmentOnlyGeneralScope = createPersonnelProfileAccessSnapshot(personalSession("manager", {
    explicitScopes: [{ locationId: "vienna", departmentId: 17 }],
    permissionScopes: [approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "vienna")],
  }));
  assert.equal(departmentOnlyGeneralScope.capabilities.canReadProfiles, false);
});

test("M7 Profilrechte: AL ist auf exakt freigegebene Abteilung begrenzt", () => {
  const departmentManager = createPersonnelProfileAccessSnapshot(personalSession("department_manager", {
    explicitScopes: [{ locationId: "vienna", departmentId: 17 }],
    permissionScopes: [
      approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "vienna", 17),
      approvedScope(PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ, "vienna", 17),
    ],
  }));
  assert.equal(departmentManager.canReadSubject({ locationId: "vienna", departmentId: 17 }), true);
  assert.equal(departmentManager.canReadMasterSubject({ locationId: "vienna", departmentId: 17 }), true);
  assert.equal(departmentManager.canReadSubject({ locationId: "vienna", departmentId: 18 }), false);
  assert.equal(departmentManager.canReadSubject({ locationId: "graz", departmentId: 17 }), false);
  assert.equal(departmentManager.canReadSubject({ locationId: "vienna", departmentId: null }), false);
});

test("M7 Profilrechte: ungültige, inaktive oder nicht genehmigte Scopes bleiben geschlossen", () => {
  for (const permissionScope of [
    approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "vienna", null, { approvedBy: "" }),
    approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "vienna", null, { active: false }),
    approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "vienna", 17, {
      departmentLocationId: "graz",
    }),
  ]) {
    const snapshot = createPersonnelProfileAccessSnapshot(personalSession("manager", {
      explicitScopes: [{ locationId: "vienna", departmentId: null }],
      permissionScopes: [permissionScope],
    }));
    assert.equal(snapshot.capabilities.canReadProfiles, false);
  }
  const missingGeneralScope = createPersonnelProfileAccessSnapshot(personalSession("manager", {
    permissionScopes: [approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "vienna")],
  }));
  assert.equal(missingGeneralScope.capabilities.canReadProfiles, false);
});

test("M7 Profilrechte: sonstige persönliche Rollen bleiben trotz injizierter Werte geschlossen", () => {
  for (const role of ["employee", "location_planner", "organization", "self"]) {
    const snapshot = createPersonnelProfileAccessSnapshot(personalSession(role, {
      explicitScopes: [{ locationId: "vienna", departmentId: null }],
      permissionScopes: [
        approvedScope(PERSONNEL_PROFILE_PERMISSIONS.READ, "vienna"),
        approvedScope(PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ, "vienna"),
      ],
    }));
    assert.deepEqual(snapshot.capabilities, {
      canReadProfiles: false,
      canReadMaster: false,
      canReadDocuments: false,
      canDelegateProfiles: false,
    }, role);
  }
});
