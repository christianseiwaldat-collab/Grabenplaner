"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PERSONNEL_LEARNING_PERMISSIONS: P,
  PERSONNEL_LEARNING_PERMISSION_IDS,
  PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS,
  PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES,
  PERSONNEL_LEARNING_ROLE_CONTRACT,
  PERSONNEL_LEARNING_DENIAL_AUTHORITIES,
  PERSONNEL_LEARNING_DELEGATION_CODES: C,
  personnelLearningDefaultPermissionsForRole,
  applyPersonnelLearningRoleDefaults,
  resolvePersonnelLearningPermissionDependencies,
  createPersonnelLearningAccessSnapshot,
  evaluatePersonnelLearningCrossLocationDelegation,
  projectPersonnelLearningCrossLocationDelegate,
  projectPersonnelLearningCrossLocationDelegates,
} = require("../lib/personnel-learning-access");

const LOCATION = "learning-location-01";
const FOREIGN_LOCATION = "learning-location-02";

function scope(role, locationId = LOCATION, departmentId = 11) {
  return role === "manager"
    ? { type: "location", locationId, departmentId: null, valid: true, active: true, locationActive: true }
    : {
        type: "department", locationId, departmentId, departmentLocationId: locationId,
        valid: true, active: true, locationActive: true, departmentActive: true,
      };
}

function principal(employeeNumber, role, locationId = LOCATION, overrides = {}) {
  return {
    employeeNumber,
    role,
    active: true,
    configured: true,
    sessionKind: "employee",
    isEmployee: true,
    homeLocationId: locationId,
    preferredDepartmentId: role === "department_manager" ? 11 : null,
    effectiveScopes: [scope(role, locationId)],
    rolePermissions: personnelLearningDefaultPermissionsForRole(role),
    ...overrides,
  };
}

function decision(actor, target, enabled) {
  return evaluatePersonnelLearningCrossLocationDelegation({ actor, target, enabled });
}

function denial(authorityLevel, locationId = "", revision = "r1") {
  return {
    permission: P.CROSS_LOCATION_ASSIGN,
    authorityLevel,
    scopeLocationId: locationId,
    revision,
  };
}

test("Block-1-Katalog und Hierarchievertrag sind exakt und tief eingefroren", () => {
  assert.deepEqual(P, {
    CATALOG_READ: "personnel:learning:catalog:read",
    CATALOG_MANAGE: "personnel:learning:catalog:manage",
    CATALOG_PUBLISH: "personnel:learning:catalog:publish",
    ASSIGNMENTS_WRITE: "personnel:learning:assignments:write",
    CROSS_LOCATION_ASSIGN: "personnel:learning:cross_location:assign",
    AUDIT_READ: "personnel:learning:audit:read",
    DELEGATE: "personnel:learning:delegate",
  });
  assert.equal(PERSONNEL_LEARNING_PERMISSION_IDS.length, 7);
  assert.deepEqual(PERSONNEL_LEARNING_ROLE_CONTRACT.operationalDefaultRoles,
    ["manager", "department_manager"]);
  assert.deepEqual(PERSONNEL_LEARNING_ROLE_CONTRACT.delegateDefaultRoles, ["hr", "admin"]);
  assert.deepEqual(PERSONNEL_LEARNING_ROLE_CONTRACT.localDelegatorRoles, ["manager"]);
  assert.deepEqual(PERSONNEL_LEARNING_ROLE_CONTRACT.localDelegationTargetRoles,
    ["department_manager"]);
  assert.deepEqual(PERSONNEL_LEARNING_ROLE_CONTRACT.plPlusRoles,
    ["hr", "admin", "developer"]);
  assert.deepEqual(PERSONNEL_LEARNING_ROLE_CONTRACT.excludedTechnicalRoles, ["it_admin"]);
  assert.equal(PERSONNEL_LEARNING_ROLE_CONTRACT.developerReceivesAllKnownPermissions, true);
  assert.equal(Object.isFrozen(P), true);
  assert.equal(Object.isFrozen(PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES), true);
  assert.equal(Object.isFrozen(PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[P.CATALOG_PUBLISH]), true);
});

test("Rollenstandards trennen operative Fachdaten, reine PL+-Delegation und Developer", () => {
  for (const role of ["manager", "department_manager"]) {
    assert.deepEqual(personnelLearningDefaultPermissionsForRole(role),
      PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS);
    assert.equal(personnelLearningDefaultPermissionsForRole(role).includes(P.DELEGATE), false);
  }
  for (const role of ["hr", "admin"]) {
    assert.deepEqual(personnelLearningDefaultPermissionsForRole(role), [P.DELEGATE]);
  }
  assert.deepEqual(personnelLearningDefaultPermissionsForRole("developer"),
    PERSONNEL_LEARNING_PERMISSION_IDS);
  for (const role of ["employee", "location_planner", "it_admin", ""]) {
    assert.deepEqual(personnelLearningDefaultPermissionsForRole(role), []);
  }
  const applied = applyPersonnelLearningRoleDefaults("manager", ["own_schedule:read"]);
  assert.equal(applied.includes("own_schedule:read"), true);
  assert.equal(applied.includes(P.DELEGATE), false);
  assert.equal(applied.length, PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS.length + 1);
});

test("Abhängigkeiten sind vollständig und werden transitiv fail-closed aufgelöst", () => {
  assert.deepEqual(PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[P.CATALOG_MANAGE],
    [P.CATALOG_READ]);
  assert.deepEqual(PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[P.CATALOG_PUBLISH],
    [P.CATALOG_MANAGE, P.CATALOG_READ]);
  assert.deepEqual(PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[P.ASSIGNMENTS_WRITE],
    [P.CATALOG_READ]);
  assert.deepEqual(PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[P.CROSS_LOCATION_ASSIGN],
    [P.ASSIGNMENTS_WRITE]);
  assert.deepEqual(PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[P.AUDIT_READ], [P.CATALOG_READ]);
  assert.deepEqual(PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[P.DELEGATE], []);

  for (const permission of [
    P.CATALOG_MANAGE, P.CATALOG_PUBLISH, P.ASSIGNMENTS_WRITE,
    P.CROSS_LOCATION_ASSIGN, P.AUDIT_READ,
  ]) {
    const projected = resolvePersonnelLearningPermissionDependencies([permission]);
    assert.equal(projected.valid, false, permission);
    assert.deepEqual(projected.effectivePermissions, [], permission);
  }
  const cross = resolvePersonnelLearningPermissionDependencies([
    P.CATALOG_READ, P.ASSIGNMENTS_WRITE, P.CROSS_LOCATION_ASSIGN,
  ]);
  assert.equal(cross.valid, true);
  assert.deepEqual(cross.effectivePermissions,
    [P.CATALOG_READ, P.ASSIGNMENTS_WRITE, P.CROSS_LOCATION_ASSIGN].sort());
});

test("Delegate allein vermittelt PL+ keine Fachdaten", () => {
  for (const role of ["hr", "admin"]) {
    const access = createPersonnelLearningAccessSnapshot(principal(`pl-${role}`, role));
    assert.equal(access.canDelegateLearningRights, true);
    assert.equal(access.canAdministerCrossLocationRight, true);
    assert.equal(access.canReadCatalog, false);
    assert.equal(access.canManageCatalog, false);
    assert.equal(access.canPublishCatalog, false);
    assert.equal(access.canWriteAssignments, false);
    assert.equal(access.canAssignCrossLocation, false);
    assert.equal(access.canReadAudit, false);
  }
});

test("Zusatzrecht bleibt sichtbar, wird ohne Basisrecht aber nicht wirksam", () => {
  const manager = principal("fl", "manager", LOCATION, {
    permissions: [P.CATALOG_READ, P.CROSS_LOCATION_ASSIGN],
  });
  const access = createPersonnelLearningAccessSnapshot(manager);
  assert.equal(access.hasCrossLocationAssignmentRight, true);
  assert.equal(access.canAssignCrossLocation, false);
  assert.equal(access.canDelegateCrossLocation, false);

  const target = principal("al", "department_manager", LOCATION, {
    permissions: [P.CATALOG_READ, P.CROSS_LOCATION_ASSIGN],
  });
  const projected = projectPersonnelLearningCrossLocationDelegate({
    actor: principal("pl", "hr"), target,
  });
  assert.equal(projected.enabled, true);
  assert.equal(projected.effective, false);
});

test("unvollständige Identitäten, Organisationskonten und unkanonische Scopes öffnen nichts", () => {
  const validManager = principal("fl", "manager");
  const validTarget = principal("al", "department_manager");
  for (const field of ["active", "configured", "sessionKind", "isEmployee"]) {
    const actor = { ...validManager };
    delete actor[field];
    assert.equal(decision(actor, validTarget, false).code, C.ACTOR_REQUIRED, field);
  }
  const organizationTarget = {
    ...validTarget, sessionKind: "organization", isEmployee: false,
  };
  assert.equal(decision(validManager, organizationTarget, false).code, C.TARGET_NOT_FOUND);

  for (const invalidScope of [
    [],
    [{ ...scope("manager"), departmentId: 0 }],
    [{ ...scope("manager"), departmentId: "0" }],
    [{ ...scope("manager"), type: "department", departmentId: 11 }],
    [{ ...scope("manager"), locationId: FOREIGN_LOCATION }],
  ]) {
    const actor = principal("fl-scope", "manager", LOCATION, { effectiveScopes: invalidScope });
    assert.equal(decision(actor, validTarget, false).code, C.ACTOR_PERMISSION_DENIED);
  }
});

test("FL darf nur aktive persönliche AL im eigenen kanonischen Standort bearbeiten", () => {
  const manager = principal("fl", "manager");
  const local = principal("al-local", "department_manager");
  const allowed = decision(manager, local, false);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.operation, "deny");
  assert.equal(allowed.authorityLevel, PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER);
  assert.equal(allowed.scopeLocationId, LOCATION);

  assert.equal(decision(manager,
    principal("al-foreign", "department_manager", FOREIGN_LOCATION), false).code,
  C.TARGET_SCOPE_DENIED);
  assert.equal(decision(manager, principal("other-fl", "manager"), false).code,
    C.TARGET_ROLE_DENIED);
  assert.equal(decision(manager, principal("ma", "employee"), false).code,
    C.TARGET_ROLE_DENIED);
});

test("FL ohne wirksames Cross-Recht und jede AL bleiben delegationsunfähig", () => {
  const target = principal("al", "department_manager");
  const deniedManager = principal("fl", "manager", LOCATION, {
    deniedPermissions: [P.CROSS_LOCATION_ASSIGN],
  });
  assert.equal(decision(deniedManager, target, false).code, C.ACTOR_PERMISSION_DENIED);
  assert.deepEqual(projectPersonnelLearningCrossLocationDelegates(deniedManager, [target]), []);

  const departmentManager = principal("al-actor", "department_manager", LOCATION, {
    permissions: PERSONNEL_LEARNING_PERMISSION_IDS,
  });
  assert.equal(decision(departmentManager, target, false).code,
    C.DEPARTMENT_MANAGER_CANNOT_DELEGATE);
  assert.equal(decision(principal("same", "manager"),
    principal("same", "department_manager"), true).code, C.SELF_DELEGATION_DENIED);
});

test("PL+ verwaltet FL und AL global nur mit Delegate; IT-Admin bleibt ausgeschlossen", () => {
  const targets = [
    principal("foreign-fl", "manager", FOREIGN_LOCATION),
    principal("foreign-al", "department_manager", FOREIGN_LOCATION),
  ];
  for (const role of ["hr", "admin", "developer"]) {
    const actor = principal(`pl-${role}`, role);
    for (const target of targets) {
      const result = decision(actor, target, false);
      assert.equal(result.allowed, true, role);
      assert.equal(result.authorityLevel, PERSONNEL_LEARNING_DENIAL_AUTHORITIES.PL_PLUS);
    }
  }
  const deniedDelegate = principal("pl-denied", "hr", LOCATION, {
    deniedPermissions: [P.DELEGATE],
  });
  assert.equal(decision(deniedDelegate, targets[0], false).code, C.ACTOR_PERMISSION_DENIED);
  const itAdmin = principal("it", "it_admin", LOCATION, {
    permissions: PERSONNEL_LEARNING_PERMISSION_IDS,
  });
  assert.equal(decision(itAdmin, targets[1], false).code, C.ACTOR_ROLE_DENIED);
});

test("PL+- und unbekannte Denials bleiben geschützt; lokales Restore ist revisionsgebunden", () => {
  const manager = principal("fl", "manager");
  const baseTarget = principal("al", "department_manager");
  for (const permissionDenials of [
    [denial(PERSONNEL_LEARNING_DENIAL_AUTHORITIES.PL_PLUS)],
    [{ permission: P.CROSS_LOCATION_ASSIGN, authorityLevel: "unknown" }],
    [denial(PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER, LOCATION, "")],
    [
      denial(PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER, LOCATION, "r1"),
      denial(PERSONNEL_LEARNING_DENIAL_AUTHORITIES.PL_PLUS, "", "r2"),
    ],
  ]) {
    const blocked = decision(manager, { ...baseTarget, permissionDenials }, true);
    assert.equal(blocked.code, C.PL_PLUS_DENIAL_PROTECTED);
    assert.equal(blocked.protectedByPlPlus, true);
  }

  const localTarget = {
    ...baseTarget,
    permissionDenials: [denial(
      PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER, LOCATION, "revision-7",
    )],
  };
  const restored = decision(manager, localTarget, true);
  assert.equal(restored.allowed, true);
  assert.equal(restored.operation, "restore_default");
  assert.deepEqual(restored.expectedDenial, {
    authorityLevel: PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER,
    scopeLocationId: LOCATION,
    revision: "revision-7",
  });
  assert.equal(Object.isFrozen(restored.expectedDenial), true);
});

test("Projektionen sind autorisiert, minimiert, scopekorrekt und unveränderlich", () => {
  const manager = principal("fl", "manager");
  const local = principal("al-local", "department_manager");
  const foreign = principal("al-foreign", "department_manager", FOREIGN_LOCATION);
  const inactive = principal("al-inactive", "department_manager", LOCATION, { active: false });
  const otherManager = principal("fl-foreign", "manager", FOREIGN_LOCATION);

  assert.equal(projectPersonnelLearningCrossLocationDelegate({
    actor: principal("ma", "employee"), target: local,
  }), null);
  assert.deepEqual(projectPersonnelLearningCrossLocationDelegates(manager,
    [local, foreign, inactive, otherManager]).map((entry) => entry.employeeNumber),
  ["al-local"]);

  const plPlusProjection = projectPersonnelLearningCrossLocationDelegates(
    principal("pl", "hr"), [local, foreign, inactive, otherManager],
  );
  assert.deepEqual(plPlusProjection.map((entry) => entry.employeeNumber),
    ["al-local", "al-foreign", "fl-foreign"]);
  assert.equal(Object.isFrozen(plPlusProjection), true);
  assert.equal(Object.isFrozen(plPlusProjection[0]), true);
  assert.deepEqual(Object.keys(plPlusProjection[0]).sort(), [
    "canDisable", "canEnable", "denialAuthority", "denied", "disableCode",
    "effective", "employeeNumber", "enableCode", "enabled", "homeLocationId",
    "manageable", "preferredDepartmentId", "protectedByPlPlus", "role",
  ].sort());
});
