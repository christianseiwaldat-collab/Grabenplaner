"use strict";

const PERSONNEL_LEARNING_PERMISSIONS = Object.freeze({
  CATALOG_READ: "personnel:learning:catalog:read",
  CATALOG_MANAGE: "personnel:learning:catalog:manage",
  CATALOG_PUBLISH: "personnel:learning:catalog:publish",
  ASSIGNMENTS_WRITE: "personnel:learning:assignments:write",
  CROSS_LOCATION_ASSIGN: "personnel:learning:cross_location:assign",
  AUDIT_READ: "personnel:learning:audit:read",
  DELEGATE: "personnel:learning:delegate",
});

const PERSONNEL_LEARNING_PERMISSION_IDS = Object.freeze(
  Object.values(PERSONNEL_LEARNING_PERMISSIONS),
);
const PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS = Object.freeze(
  PERSONNEL_LEARNING_PERMISSION_IDS.filter(
    (permission) => permission !== PERSONNEL_LEARNING_PERMISSIONS.DELEGATE,
  ),
);
const PERMISSION_SET = new Set(PERSONNEL_LEARNING_PERMISSION_IDS);

const PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES = Object.freeze({
  [PERSONNEL_LEARNING_PERMISSIONS.CATALOG_READ]: Object.freeze([]),
  [PERSONNEL_LEARNING_PERMISSIONS.CATALOG_MANAGE]: Object.freeze([
    PERSONNEL_LEARNING_PERMISSIONS.CATALOG_READ,
  ]),
  [PERSONNEL_LEARNING_PERMISSIONS.CATALOG_PUBLISH]: Object.freeze([
    PERSONNEL_LEARNING_PERMISSIONS.CATALOG_MANAGE,
    PERSONNEL_LEARNING_PERMISSIONS.CATALOG_READ,
  ]),
  [PERSONNEL_LEARNING_PERMISSIONS.ASSIGNMENTS_WRITE]: Object.freeze([
    PERSONNEL_LEARNING_PERMISSIONS.CATALOG_READ,
  ]),
  [PERSONNEL_LEARNING_PERMISSIONS.CROSS_LOCATION_ASSIGN]: Object.freeze([
    PERSONNEL_LEARNING_PERMISSIONS.ASSIGNMENTS_WRITE,
  ]),
  [PERSONNEL_LEARNING_PERMISSIONS.AUDIT_READ]: Object.freeze([
    PERSONNEL_LEARNING_PERMISSIONS.CATALOG_READ,
  ]),
  [PERSONNEL_LEARNING_PERMISSIONS.DELEGATE]: Object.freeze([]),
});

const PERSONNEL_LEARNING_ROLE_CONTRACT = Object.freeze({
  operationalDefaultRoles: Object.freeze(["manager", "department_manager"]),
  delegateDefaultRoles: Object.freeze(["hr", "admin"]),
  localDelegatorRoles: Object.freeze(["manager"]),
  localDelegationTargetRoles: Object.freeze(["department_manager"]),
  plPlusRoles: Object.freeze(["hr", "admin", "developer"]),
  plPlusDelegationTargetRoles: Object.freeze(["manager", "department_manager"]),
  excludedTechnicalRoles: Object.freeze(["it_admin"]),
  developerReceivesAllKnownPermissions: true,
});

const PERSONNEL_LEARNING_DENIAL_AUTHORITIES = Object.freeze({
  MANAGER: "manager",
  PL_PLUS: "pl_plus",
});

const PERSONNEL_LEARNING_DELEGATION_CODES = Object.freeze({
  ALLOWED: "PERSONNEL_LEARNING_DELEGATION_ALLOWED",
  INVALID_REQUEST: "PERSONNEL_LEARNING_DELEGATION_INVALID",
  ACTOR_REQUIRED: "PERSONNEL_LEARNING_DELEGATION_ACTOR_REQUIRED",
  ACTOR_ROLE_DENIED: "PERSONNEL_LEARNING_DELEGATION_ACTOR_ROLE_DENIED",
  ACTOR_PERMISSION_DENIED: "PERSONNEL_LEARNING_DELEGATION_ACTOR_PERMISSION_DENIED",
  DEPARTMENT_MANAGER_CANNOT_DELEGATE: "PERSONNEL_LEARNING_DEPARTMENT_MANAGER_CANNOT_DELEGATE",
  TARGET_NOT_FOUND: "PERSONNEL_LEARNING_DELEGATION_TARGET_NOT_FOUND",
  TARGET_ROLE_DENIED: "PERSONNEL_LEARNING_DELEGATION_TARGET_ROLE_DENIED",
  SELF_DELEGATION_DENIED: "PERSONNEL_LEARNING_SELF_DELEGATION_DENIED",
  TARGET_SCOPE_DENIED: "PERSONNEL_LEARNING_DELEGATION_SCOPE_DENIED",
  PL_PLUS_DENIAL_PROTECTED: "PERSONNEL_LEARNING_PL_PLUS_DENIAL_PROTECTED",
});

const OPERATIONAL_DEFAULT_ROLE_SET = new Set(
  PERSONNEL_LEARNING_ROLE_CONTRACT.operationalDefaultRoles,
);
const DELEGATE_DEFAULT_ROLE_SET = new Set(
  PERSONNEL_LEARNING_ROLE_CONTRACT.delegateDefaultRoles,
);
const PL_PLUS_ROLE_SET = new Set(PERSONNEL_LEARNING_ROLE_CONTRACT.plPlusRoles);
const LOCAL_TARGET_ROLE_SET = new Set(
  PERSONNEL_LEARNING_ROLE_CONTRACT.localDelegationTargetRoles,
);
const PL_PLUS_TARGET_ROLE_SET = new Set(
  PERSONNEL_LEARNING_ROLE_CONTRACT.plPlusDelegationTargetRoles,
);
const SNAPSHOT = Symbol("personnel-learning-access");

function own(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function text(value) {
  return String(value ?? "").trim();
}

function roleFor(value) {
  return text(value?.role ?? value).toLowerCase();
}

function principalId(value) {
  return text(value?.actorId ?? value?.employeeNumber ?? value?.employee_number);
}

function isActivePersonalEmployeePrincipal(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && principalId(value)
    && value.localSystem !== true
    && text(value.sessionKind).toLowerCase() === "employee"
    && value.isEmployee === true
    && value.active === true
    && value.configured === true);
}

function normalizedPermissionSet(values) {
  const permissions = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const permission = text(value);
    if (PERMISSION_SET.has(permission)) permissions.add(permission);
  }
  return permissions;
}

function structuredDenials(value) {
  const source = value?.permissionDenials ?? value?.permission_denials;
  return Array.isArray(source) ? source : [];
}

function deniedPermissionSet(value) {
  const denied = normalizedPermissionSet(
    value?.deniedPermissions ?? value?.denied_permissions,
  );
  for (const entry of structuredDenials(value)) {
    const permission = text(entry?.permission ?? entry?.permissionId ?? entry?.permission_id);
    if (PERMISSION_SET.has(permission) && entry?.denied !== false) denied.add(permission);
  }
  return denied;
}

function assignedPermissionSet(value) {
  const permissions = Array.isArray(value?.permissions)
    ? normalizedPermissionSet(value.permissions)
    : new Set([
        ...normalizedPermissionSet(value?.rolePermissions ?? value?.role_permissions),
        ...normalizedPermissionSet(value?.grantedPermissions ?? value?.granted_permissions),
      ]);
  for (const permission of deniedPermissionSet(value)) permissions.delete(permission);
  return permissions;
}

function resolvePersonnelLearningPermissionDependencies(values = []) {
  const assigned = normalizedPermissionSet(values);
  const effective = new Set(assigned);
  let changed = true;
  while (changed) {
    changed = false;
    for (const permission of [...effective]) {
      const dependencies = PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[permission] || [];
      if (dependencies.every((dependency) => effective.has(dependency))) continue;
      effective.delete(permission);
      changed = true;
    }
  }
  const missingDependencies = Object.freeze([...assigned]
    .map((permission) => Object.freeze({
      permission,
      missing: Object.freeze((PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES[permission] || [])
        .filter((dependency) => !effective.has(dependency))),
    }))
    .filter((entry) => entry.missing.length > 0));
  return Object.freeze({
    valid: missingDependencies.length === 0,
    assignedPermissions: Object.freeze([...assigned].sort()),
    effectivePermissions: Object.freeze([...effective].sort()),
    missingDependencies,
  });
}

function personnelLearningDefaultPermissionsForRole(roleValue) {
  const role = roleFor(roleValue);
  if (role === "developer") return Object.freeze([...PERSONNEL_LEARNING_PERMISSION_IDS]);
  if (OPERATIONAL_DEFAULT_ROLE_SET.has(role)) {
    return Object.freeze([...PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS]);
  }
  if (DELEGATE_DEFAULT_ROLE_SET.has(role)) {
    return Object.freeze([PERSONNEL_LEARNING_PERMISSIONS.DELEGATE]);
  }
  return Object.freeze([]);
}

function applyPersonnelLearningRoleDefaults(roleValue, permissions = []) {
  return Object.freeze([...new Set([
    ...(Array.isArray(permissions) ? permissions.map(text).filter(Boolean) : []),
    ...personnelLearningDefaultPermissionsForRole(roleValue),
  ])].sort());
}

function positiveDepartmentId(value) {
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) return null;
  const departmentId = Number(value);
  return Number.isSafeInteger(departmentId) && departmentId > 0 ? departmentId : null;
}

function normalizeEffectiveScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.valid !== true || value.active !== true
    || value.locationActive !== true) return null;
  const locationId = text(value.locationId ?? value.location_id);
  if (!locationId || locationId.length > 80 || locationId.includes("\0")) return null;
  const type = text(value.type ?? value.scopeType ?? value.scope_type).toLowerCase();
  const departmentKey = own(value, "departmentId") ? "departmentId" : "department_id";
  if (!own(value, departmentKey)) return null;
  if (type === "location" && value[departmentKey] === null) {
    return Object.freeze({ type, locationId, departmentId: null });
  }
  if (type !== "department" || value.departmentActive !== true) return null;
  const departmentId = positiveDepartmentId(value[departmentKey]);
  if (!departmentId) return null;
  const departmentLocationId = text(
    value.departmentLocationId ?? value.department_location_id ?? locationId,
  );
  if (departmentLocationId !== locationId) return null;
  return Object.freeze({ type, locationId, departmentId });
}

function effectiveScopes(value) {
  const source = value?.effectiveScopes ?? value?.effective_scopes;
  if (!Array.isArray(source)) return Object.freeze([]);
  const unique = new Map();
  for (const candidate of source) {
    const scope = normalizeEffectiveScope(candidate);
    if (scope) unique.set(`${scope.type}\0${scope.locationId}\0${scope.departmentId ?? 0}`, scope);
  }
  return Object.freeze([...unique.values()]);
}

function validLocationId(value) {
  const locationId = text(value);
  return locationId && locationId.length <= 80 && !locationId.includes("\0")
    ? locationId
    : "";
}

function principalOrganizationScope(value) {
  const role = roleFor(value);
  const homeLocationId = validLocationId(value?.homeLocationId ?? value?.home_location_id);
  if (!homeLocationId) return null;
  const scopes = effectiveScopes(value);
  if (role === "manager") {
    return scopes.some((scope) => scope.type === "location"
      && scope.locationId === homeLocationId)
      ? Object.freeze({ locationId: homeLocationId, departmentId: null })
      : null;
  }
  if (role === "department_manager") {
    const preferredDepartmentId = positiveDepartmentId(
      value?.preferredDepartmentId ?? value?.preferred_department_id,
    );
    if (!preferredDepartmentId) return null;
    return scopes.some((scope) => scope.type === "department"
      && scope.locationId === homeLocationId
      && scope.departmentId === preferredDepartmentId)
      ? Object.freeze({ locationId: homeLocationId, departmentId: preferredDepartmentId })
      : null;
  }
  return Object.freeze({ locationId: homeLocationId, departmentId: null });
}

function denialRevision(value) {
  const revision = text(value?.revision ?? value?.updatedAt ?? value?.updated_at);
  return revision && revision.length <= 120 && !revision.includes("\0") ? revision : "";
}

function normalizeDenialAuthority(value) {
  const authority = text(
    value?.authorityLevel ?? value?.authority_level ?? value?.authority,
  ).toLowerCase();
  if (["manager", "filialleitung"].includes(authority)) {
    const scopeLocationId = validLocationId(
      value?.scopeLocationId ?? value?.scope_location_id,
    );
    const revision = denialRevision(value);
    if (scopeLocationId && revision) {
      return Object.freeze({
        authorityLevel: PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER,
        scopeLocationId,
        revision,
      });
    }
  }
  return Object.freeze({
    authorityLevel: PERSONNEL_LEARNING_DENIAL_AUTHORITIES.PL_PLUS,
    scopeLocationId: "",
    revision: denialRevision(value),
  });
}

function crossLocationDenial(value) {
  const structured = structuredDenials(value).filter((entry) => (
    text(entry?.permission ?? entry?.permissionId ?? entry?.permission_id)
      === PERSONNEL_LEARNING_PERMISSIONS.CROSS_LOCATION_ASSIGN
    && entry?.denied !== false
  ));
  if (!structured.length) {
    const legacyDenied = normalizedPermissionSet(
      value?.deniedPermissions ?? value?.denied_permissions,
    ).has(PERSONNEL_LEARNING_PERMISSIONS.CROSS_LOCATION_ASSIGN);
    return Object.freeze({
      denied: legacyDenied,
      authorityLevel: legacyDenied ? PERSONNEL_LEARNING_DENIAL_AUTHORITIES.PL_PLUS : null,
      scopeLocationId: "",
      revision: "",
      protectedByPlPlus: legacyDenied,
    });
  }
  const normalized = structured.map(normalizeDenialAuthority);
  const managerRows = normalized.filter(
    (entry) => entry.authorityLevel === PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER,
  );
  const plPlusProtected = managerRows.length !== normalized.length
    || new Set(managerRows.map((entry) => entry.scopeLocationId)).size !== 1
    || new Set(managerRows.map((entry) => entry.revision)).size !== 1;
  const selected = plPlusProtected ? normalized.find(
    (entry) => entry.authorityLevel === PERSONNEL_LEARNING_DENIAL_AUTHORITIES.PL_PLUS,
  ) || normalized[0] : managerRows[0];
  return Object.freeze({
    denied: true,
    authorityLevel: plPlusProtected
      ? PERSONNEL_LEARNING_DENIAL_AUTHORITIES.PL_PLUS
      : PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER,
    scopeLocationId: plPlusProtected ? "" : selected.scopeLocationId,
    revision: selected.revision,
    protectedByPlPlus: plPlusProtected,
  });
}

function createPersonnelLearningAccessSnapshot(principal = {}) {
  if (principal?.[SNAPSHOT] === true) return principal;
  const role = roleFor(principal);
  const assignedPermissions = Object.freeze([...assignedPermissionSet(principal)].sort());
  const dependencyProjection = resolvePersonnelLearningPermissionDependencies(
    assignedPermissions,
  );
  const permissions = dependencyProjection.effectivePermissions;
  const personalEmployee = isActivePersonalEmployeePrincipal(principal);
  const plPlus = personalEmployee && PL_PLUS_ROLE_SET.has(role);
  const has = (permission) => permissions.includes(permission);
  const hasCrossLocationAssignmentRight = assignedPermissions.includes(
    PERSONNEL_LEARNING_PERMISSIONS.CROSS_LOCATION_ASSIGN,
  );
  const canAssignCrossLocation = has(
    PERSONNEL_LEARNING_PERMISSIONS.CROSS_LOCATION_ASSIGN,
  );
  const canDelegateLearningRights = has(PERSONNEL_LEARNING_PERMISSIONS.DELEGATE);
  const organizationScope = principalOrganizationScope(principal);
  const snapshot = {
    actorId: principalId(principal),
    role,
    activePersonalEmployee: personalEmployee,
    plPlus,
    organizationScope,
    assignedPermissions,
    permissions,
    deniedPermissions: Object.freeze([...deniedPermissionSet(principal)].sort()),
    dependencyProjection,
    capabilities: Object.freeze({
      canReadCatalog: has(PERSONNEL_LEARNING_PERMISSIONS.CATALOG_READ),
      canManageCatalog: has(PERSONNEL_LEARNING_PERMISSIONS.CATALOG_MANAGE),
      canPublishCatalog: has(PERSONNEL_LEARNING_PERMISSIONS.CATALOG_PUBLISH),
      canWriteAssignments: has(PERSONNEL_LEARNING_PERMISSIONS.ASSIGNMENTS_WRITE),
      hasCrossLocationAssignmentRight,
      canAssignCrossLocation,
      canReadAudit: has(PERSONNEL_LEARNING_PERMISSIONS.AUDIT_READ),
      canDelegateLearningRights,
      canDelegateCrossLocation: personalEmployee && role === "manager"
        && canAssignCrossLocation && Boolean(organizationScope),
      canAdministerCrossLocationRight: plPlus && canDelegateLearningRights,
    }),
  };
  Object.assign(snapshot, snapshot.capabilities);
  Object.defineProperty(snapshot, SNAPSHOT, { enumerable: false, value: true });
  return Object.freeze(snapshot);
}

function frozenExpectedDenial(denial) {
  return denial.denied ? Object.freeze({
    authorityLevel: denial.authorityLevel,
    scopeLocationId: denial.scopeLocationId,
    revision: denial.revision,
  }) : null;
}

function deniedDecision(code, actor, target, denial, scopeLocationId = "") {
  return Object.freeze({
    allowed: false,
    code,
    operation: "none",
    authorityLevel: null,
    scopeLocationId,
    actorRole: actor.role,
    targetRole: target.role,
    protectedByPlPlus: denial.protectedByPlPlus,
    expectedDenial: frozenExpectedDenial(denial),
  });
}

function allowedDecision(actor, target, denial, enabled, authorityLevel, scopeLocationId) {
  let operation = "noop";
  if (enabled && denial.denied) operation = "restore_default";
  if (!enabled && (!denial.denied || denial.authorityLevel !== authorityLevel)) operation = "deny";
  return Object.freeze({
    allowed: true,
    code: PERSONNEL_LEARNING_DELEGATION_CODES.ALLOWED,
    operation,
    authorityLevel,
    scopeLocationId,
    actorRole: actor.role,
    targetRole: target.role,
    protectedByPlPlus: denial.protectedByPlPlus,
    expectedDenial: frozenExpectedDenial(denial),
  });
}

function evaluatePersonnelLearningCrossLocationDelegation({
  actor: actorValue,
  target: targetValue,
  enabled,
} = {}) {
  const actor = createPersonnelLearningAccessSnapshot(actorValue || {});
  const target = createPersonnelLearningAccessSnapshot(targetValue || {});
  const denial = crossLocationDenial(targetValue || {});
  const targetScope = principalOrganizationScope(targetValue || {});
  const targetLocationId = targetScope?.locationId || "";

  if (typeof enabled !== "boolean") {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.INVALID_REQUEST,
      actor, target, denial, targetLocationId);
  }
  if (!actor.activePersonalEmployee) {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.ACTOR_REQUIRED,
      actor, target, denial, targetLocationId);
  }
  if (!target.activePersonalEmployee || !target.actorId) {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.TARGET_NOT_FOUND,
      actor, target, denial, targetLocationId);
  }
  if (actor.actorId === target.actorId) {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.SELF_DELEGATION_DENIED,
      actor, target, denial, targetLocationId);
  }

  if (actor.plPlus) {
    if (!actor.canAdministerCrossLocationRight) {
      return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.ACTOR_PERMISSION_DENIED,
        actor, target, denial, targetLocationId);
    }
    if (!PL_PLUS_TARGET_ROLE_SET.has(target.role)) {
      return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.TARGET_ROLE_DENIED,
        actor, target, denial, targetLocationId);
    }
    if (!targetScope) {
      return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.TARGET_SCOPE_DENIED,
        actor, target, denial, targetLocationId);
    }
    return allowedDecision(actor, target, denial, enabled,
      PERSONNEL_LEARNING_DENIAL_AUTHORITIES.PL_PLUS, "");
  }

  if (actor.role === "department_manager") {
    return deniedDecision(
      PERSONNEL_LEARNING_DELEGATION_CODES.DEPARTMENT_MANAGER_CANNOT_DELEGATE,
      actor, target, denial, targetLocationId,
    );
  }
  if (actor.role !== "manager") {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.ACTOR_ROLE_DENIED,
      actor, target, denial, targetLocationId);
  }
  if (!actor.canDelegateCrossLocation) {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.ACTOR_PERMISSION_DENIED,
      actor, target, denial, targetLocationId);
  }
  if (!LOCAL_TARGET_ROLE_SET.has(target.role)) {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.TARGET_ROLE_DENIED,
      actor, target, denial, targetLocationId);
  }
  if (!actor.organizationScope || !targetScope
    || actor.organizationScope.locationId !== targetScope.locationId) {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.TARGET_SCOPE_DENIED,
      actor, target, denial, targetLocationId);
  }
  if (denial.protectedByPlPlus
    || (denial.denied && denial.scopeLocationId !== targetLocationId)) {
    return deniedDecision(PERSONNEL_LEARNING_DELEGATION_CODES.PL_PLUS_DENIAL_PROTECTED,
      actor, target, denial, targetLocationId);
  }
  return allowedDecision(actor, target, denial, enabled,
    PERSONNEL_LEARNING_DENIAL_AUTHORITIES.MANAGER, targetLocationId);
}

function actorCanSeeDelegationTarget(actorValue, targetValue) {
  const actor = createPersonnelLearningAccessSnapshot(actorValue || {});
  const target = createPersonnelLearningAccessSnapshot(targetValue || {});
  if (!actor.activePersonalEmployee || !target.activePersonalEmployee
    || actor.actorId === target.actorId) return false;
  const targetScope = principalOrganizationScope(targetValue || {});
  if (!targetScope) return false;
  if (actor.plPlus) {
    return actor.canAdministerCrossLocationRight && PL_PLUS_TARGET_ROLE_SET.has(target.role);
  }
  return actor.role === "manager" && actor.canDelegateCrossLocation
    && LOCAL_TARGET_ROLE_SET.has(target.role)
    && actor.organizationScope?.locationId === targetScope.locationId;
}

function projectPersonnelLearningCrossLocationDelegate({ actor, target } = {}) {
  if (!actorCanSeeDelegationTarget(actor, target)) return null;
  const targetAccess = createPersonnelLearningAccessSnapshot(target);
  const targetScope = principalOrganizationScope(target);
  const denial = crossLocationDenial(target);
  const enableDecision = evaluatePersonnelLearningCrossLocationDelegation({
    actor, target, enabled: true,
  });
  const disableDecision = evaluatePersonnelLearningCrossLocationDelegation({
    actor, target, enabled: false,
  });
  return Object.freeze({
    employeeNumber: targetAccess.actorId,
    role: targetAccess.role,
    homeLocationId: targetScope.locationId,
    preferredDepartmentId: targetScope.departmentId,
    enabled: targetAccess.hasCrossLocationAssignmentRight,
    effective: targetAccess.canAssignCrossLocation,
    denied: denial.denied,
    denialAuthority: denial.authorityLevel,
    protectedByPlPlus: denial.protectedByPlPlus,
    manageable: enableDecision.allowed || disableDecision.allowed,
    canEnable: enableDecision.allowed,
    canDisable: disableDecision.allowed,
    enableCode: enableDecision.code,
    disableCode: disableDecision.code,
  });
}

function projectPersonnelLearningCrossLocationDelegates(actor, targets = []) {
  if (!isActivePersonalEmployeePrincipal(actor)) return Object.freeze([]);
  return Object.freeze((Array.isArray(targets) ? targets : [])
    .map((target) => projectPersonnelLearningCrossLocationDelegate({ actor, target }))
    .filter(Boolean));
}

module.exports = {
  PERSONNEL_LEARNING_PERMISSIONS,
  PERSONNEL_LEARNING_PERMISSION_IDS,
  PERSONNEL_LEARNING_OPERATIONAL_PERMISSION_IDS,
  PERSONNEL_LEARNING_PERMISSION_DEPENDENCIES,
  PERSONNEL_LEARNING_ROLE_CONTRACT,
  PERSONNEL_LEARNING_DENIAL_AUTHORITIES,
  PERSONNEL_LEARNING_DELEGATION_CODES,
  personnelLearningDefaultPermissionsForRole,
  applyPersonnelLearningRoleDefaults,
  resolvePersonnelLearningPermissionDependencies,
  createPersonnelLearningAccessSnapshot,
  evaluatePersonnelLearningCrossLocationDelegation,
  projectPersonnelLearningCrossLocationDelegate,
  projectPersonnelLearningCrossLocationDelegates,
};
