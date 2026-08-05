"use strict";

const {
  PERSONNEL_LIFECYCLE_CASE_TYPES,
  PERSONNEL_LIFECYCLE_DATA_CLASSIFICATIONS: C,
  PERSONNEL_LIFECYCLE_CASE_PERMISSIONS: P,
  PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS,
  PERSONNEL_LIFECYCLE_PROJECTIONS: PROJECTION,
  PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES,
  PERSONNEL_LIFECYCLE_PROJECTION_CLASSIFICATIONS,
  PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES,
  personnelLifecyclePermissionsForTransition,
  personnelLifecyclePermissionsForEmploymentTransition,
  projectPersonnelLifecycleRecord,
} = require("./personnel-lifecycle-case-contract");

const PERSONNEL_LIFECYCLE_CASE_CENTRAL_ROLES = Object.freeze([
  "hr",
  "admin",
  "it_admin",
  "developer",
]);
const PERSONNEL_LIFECYCLE_CASE_SCOPED_ROLES = Object.freeze([
  "manager",
  "department_manager",
]);
const PERSONNEL_LIFECYCLE_CASE_SCOPED_PERMISSIONS = Object.freeze([
  P.OPERATIONAL_READ,
  P.OPERATIONAL_UPDATE,
]);

const CENTRAL_ROLE_SET = new Set(PERSONNEL_LIFECYCLE_CASE_CENTRAL_ROLES);
const SCOPED_ROLE_SET = new Set(PERSONNEL_LIFECYCLE_CASE_SCOPED_ROLES);
const PERMISSION_SET = new Set(PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS);
const SCOPED_PERMISSION_SET = new Set(PERSONNEL_LIFECYCLE_CASE_SCOPED_PERMISSIONS);
const INTERACTIVE_SESSION_KIND_SET = new Set(["employee", "organization"]);
const SNAPSHOT = Symbol("personnel-lifecycle-case-access");

const ASSIGNED_TASK_PROJECTIONS = new Set([
  PROJECTION.LEADERSHIP_TASK,
  PROJECTION.IT_SECURITY_TASK,
  PROJECTION.ASSET_TASK,
  PROJECTION.TRAINING_TASK,
  PROJECTION.PAYROLL_TASK,
]);

function text(value) {
  return String(value ?? "").trim();
}

function validActorId(value) {
  const actorId = text(value);
  return actorId && actorId.length <= 120 && !actorId.includes("\0") ? actorId : "";
}

function normalizedActorId(session) {
  return validActorId(
    session?.actorId
      ?? session?.employeeNumber
      ?? session?.employee_number
      ?? session?.accountId
      ?? session?.account_id,
  );
}

function normalizedRole(session) {
  const role = text(session?.role).toLowerCase();
  return role === "local" ? "" : role;
}

function namedInteractiveActor(session, actorId, role) {
  const sessionKind = text(session?.sessionKind ?? session?.session_kind).toLowerCase();
  return Boolean(
    actorId
      && role
      && INTERACTIVE_SESSION_KIND_SET.has(sessionKind)
      && session?.active !== false
      && session?.localSystem !== true
      && session?.serviceAccount !== true
      && session?.service_account !== true
      && session?.sharedAccount !== true
      && session?.shared_account !== true,
  );
}

function normalizedDepartmentId(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") {
    return null;
  }
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) return undefined;
  const departmentId = Number(value);
  return Number.isSafeInteger(departmentId) && departmentId > 0 ? departmentId : undefined;
}

function scopeFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.active === false || value.valid === false
    || value.locationActive === false || value.location_active === false
    || value.departmentActive === false || value.department_active === false) return null;
  const locationId = text(value.locationId ?? value.location_id);
  const departmentId = normalizedDepartmentId(value.departmentId ?? value.department_id);
  if (!locationId || locationId.length > 80 || locationId.includes("\0")
    || departmentId === undefined) return null;
  const departmentLocationId = text(
    value.departmentLocationId ?? value.department_location_id,
  );
  if (departmentLocationId && departmentLocationId !== locationId) return null;
  return Object.freeze({ locationId, departmentId });
}

function scopeKey(scope) {
  return `${scope.locationId}\0${scope.departmentId ?? 0}`;
}

function uniqueScopes(values) {
  const result = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const scope = scopeFrom(value);
    if (scope) result.set(scopeKey(scope), scope);
  }
  return Object.freeze([...result.values()]);
}

function normalizedPermissions(session) {
  return Object.freeze([...new Set((Array.isArray(session?.permissions) ? session.permissions : [])
    .map(text)
    .filter((permission) => PERMISSION_SET.has(permission)))].sort());
}

function permissionScopeEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.map((entry) => [null, entry]);
  return Object.entries(value);
}

function normalizedPermissionScopes(session) {
  const grouped = new Map(
    PERSONNEL_LIFECYCLE_CASE_SCOPED_PERMISSIONS.map((permission) => [permission, []]),
  );
  const source = session?.permissionScopes ?? session?.permission_scopes;
  for (const [permissionHint, submitted] of permissionScopeEntries(source)) {
    for (const entry of Array.isArray(submitted) ? submitted : [submitted]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const permission = text(entry.permission ?? entry.permissionId ?? entry.permission_id
        ?? permissionHint);
      if (!SCOPED_PERMISSION_SET.has(permission)) continue;
      const entries = Array.isArray(entry.scopes) ? entry.scopes : [entry];
      for (const candidate of entries) {
        const approvedBy = validActorId(
          candidate?.approvedBy ?? candidate?.approved_by
            ?? entry.approvedBy ?? entry.approved_by,
        );
        const scope = scopeFrom(candidate);
        if (approvedBy && scope) grouped.get(permission).push(scope);
      }
    }
  }
  return Object.freeze(Object.fromEntries(
    [...grouped.entries()].map(([permission, scopes]) => [permission, uniqueScopes(scopes)]),
  ));
}

function scopedIntersection(role, explicitScopes, approvedScopes) {
  if (role === "manager") {
    const locations = new Set(explicitScopes
      .filter((scope) => scope.departmentId === null)
      .map((scope) => scope.locationId));
    return Object.freeze(approvedScopes.filter((scope) => (
      scope.departmentId === null && locations.has(scope.locationId)
    )));
  }
  if (role === "department_manager") {
    const departments = new Set(explicitScopes
      .filter((scope) => scope.departmentId !== null)
      .map(scopeKey));
    return Object.freeze(approvedScopes.filter((scope) => (
      scope.departmentId !== null && departments.has(scopeKey(scope))
    )));
  }
  return Object.freeze([]);
}

function scopeMatches(snapshot, permission, value) {
  const scope = scopeFrom(value);
  if (!scope) return false;
  const allowed = snapshot.allowedScopesByPermission[permission] || [];
  if (snapshot.role === "manager") {
    return allowed.some((entry) => (
      entry.departmentId === null && entry.locationId === scope.locationId
    ));
  }
  if (snapshot.role === "department_manager") {
    return scope.departmentId !== null && allowed.some((entry) => (
      entry.locationId === scope.locationId && entry.departmentId === scope.departmentId
    ));
  }
  return false;
}

function baseCaseRead(snapshot, caseType) {
  if (caseType === "onboarding") return snapshot.capabilities.canReadOnboarding;
  if (caseType === "offboarding") return snapshot.capabilities.canReadOffboardingConfidential;
  return false;
}

function transitionCapability(snapshot, permission) {
  const capabilities = snapshot.capabilities;
  const mapping = {
    [P.ONBOARDING_PREPARE]: capabilities.canPrepareOnboarding,
    [P.ONBOARDING_APPROVE]: capabilities.canApproveOnboarding,
    [P.ONBOARDING_EXECUTE]: capabilities.canExecuteOnboarding,
    [P.ONBOARDING_CLOSE]: capabilities.canCloseOnboarding,
    [P.OFFBOARDING_PREPARE]: capabilities.canPrepareOffboarding,
    [P.OFFBOARDING_COMMUNICATION_RELEASE]: capabilities.canReleaseOffboardingCommunication,
    [P.OFFBOARDING_INFORMATION_CONFIRM]: capabilities.canConfirmOffboardingInformation,
    [P.OFFBOARDING_EXECUTE]: capabilities.canExecuteOffboarding,
    [P.OFFBOARDING_CLOSE]: capabilities.canCloseOffboarding,
  };
  return mapping[permission] === true;
}

function transitionCapabilities(snapshot, permissions) {
  return permissions.length > 0
    && permissions.every((permission) => transitionCapability(snapshot, permission));
}

function createPersonnelLifecycleCaseAccessSnapshot(session = {}) {
  if (session?.[SNAPSHOT] === true) return session;
  const actorId = normalizedActorId(session);
  const role = normalizedRole(session);
  const namedActor = namedInteractiveActor(session, actorId, role);
  const central = namedActor && CENTRAL_ROLE_SET.has(role);
  const scoped = namedActor && SCOPED_ROLE_SET.has(role);
  const personalEmployee = namedActor
    && text(session?.sessionKind ?? session?.session_kind).toLowerCase() === "employee"
    && session?.isEmployee === true;
  const permissions = normalizedPermissions(session);
  const explicitScopes = uniqueScopes(
    session?.explicitScopes ?? session?.explicit_scopes ?? [],
  );
  const approvedScopes = normalizedPermissionScopes(session);
  const allowedScopesByPermission = Object.freeze(Object.fromEntries(
    PERSONNEL_LIFECYCLE_CASE_SCOPED_PERMISSIONS.map((permission) => [
      permission,
      scoped
        ? scopedIntersection(role, explicitScopes, approvedScopes[permission] || [])
        : Object.freeze([]),
    ]),
  ));
  const effective = (permission) => {
    if (!namedActor || !permissions.includes(permission)) return false;
    if (central) return true;
    return scoped && SCOPED_PERMISSION_SET.has(permission)
      && (allowedScopesByPermission[permission] || []).length > 0;
  };

  const canReadOnboarding = effective(P.ONBOARDING_READ);
  const canReadOffboardingConfidential = effective(P.OFFBOARDING_CONFIDENTIAL_READ);
  const canReadPackages = effective(P.PACKAGES_READ);
  const canReadAudit = effective(P.AUDIT_READ);
  const capabilities = Object.freeze({
    canReadOnboarding,
    canPrepareOnboarding: canReadOnboarding && effective(P.ONBOARDING_PREPARE),
    canApproveOnboarding: canReadOnboarding && effective(P.ONBOARDING_APPROVE),
    canExecuteOnboarding: canReadOnboarding && effective(P.ONBOARDING_EXECUTE),
    canCloseOnboarding: canReadOnboarding && effective(P.ONBOARDING_CLOSE),
    canReadOffboardingConfidential,
    canPrepareOffboarding: canReadOffboardingConfidential && effective(P.OFFBOARDING_PREPARE),
    canReleaseOffboardingCommunication: canReadOffboardingConfidential
      && effective(P.OFFBOARDING_COMMUNICATION_RELEASE),
    canConfirmOffboardingInformation: canReadOffboardingConfidential
      && effective(P.OFFBOARDING_INFORMATION_CONFIRM),
    canExecuteOffboarding: canReadOffboardingConfidential
      && effective(P.OFFBOARDING_EXECUTE),
    canCloseOffboarding: canReadOffboardingConfidential && effective(P.OFFBOARDING_CLOSE),
    canReadPersonalRestricted: effective(P.PERSONAL_RESTRICTED_READ),
    canReadHrConfidential: effective(P.HR_CONFIDENTIAL_READ),
    canReadPackages,
    canWritePackages: canReadPackages && effective(P.PACKAGES_WRITE),
    canPublishPackages: canReadPackages
      && effective(P.PACKAGES_WRITE)
      && effective(P.PACKAGES_PUBLISH),
    canWriteAssignments: effective(P.ASSIGNMENTS_WRITE)
      && (canReadOnboarding || canReadOffboardingConfidential),
    canApproveExceptions: effective(P.EXCEPTIONS_APPROVE)
      && (canReadOnboarding || canReadOffboardingConfidential),
    canReadOperational: effective(P.OPERATIONAL_READ),
    canUpdateOperational: effective(P.OPERATIONAL_READ) && effective(P.OPERATIONAL_UPDATE),
    canReadAudit,
    canReadConfidentialAudit: canReadAudit && effective(P.CONFIDENTIAL_AUDIT_READ),
    canDelegate: central && effective(P.DELEGATE),
  });

  const snapshot = {
    actorId,
    role,
    namedActor,
    central,
    scoped,
    personalEmployee,
    permissions,
    explicitScopes,
    allowedScopesByPermission,
    capabilities,
    runtimeGates: PERSONNEL_LIFECYCLE_O1_RUNTIME_GATES,
  };

  Object.assign(snapshot, capabilities, {
    hasEffectivePermission(permission) {
      return PERMISSION_SET.has(permission) && effective(permission);
    },
    canAuthorizeTransition(caseType, fromState, toState) {
      const permissions = personnelLifecyclePermissionsForTransition(
        caseType,
        fromState,
        toState,
      );
      return transitionCapabilities(snapshot, permissions);
    },
    canAuthorizeEmploymentTransition(fromState, toState) {
      const permissions = personnelLifecyclePermissionsForEmploymentTransition(fromState, toState);
      return transitionCapabilities(snapshot, permissions);
    },
    canReadOperationalScope(context = {}) {
      if (!PERSONNEL_LIFECYCLE_CASE_TYPES.includes(context.caseType)
        || context.operationalReleased !== true) return false;
      if (central) return capabilities.canReadOperational;
      return capabilities.canReadOperational
        && scopeMatches(snapshot, P.OPERATIONAL_READ, context.scope);
    },
    canUpdateOperationalScope(context = {}) {
      if (!snapshot.canReadOperationalScope(context)) return false;
      if (central) return capabilities.canUpdateOperational;
      return capabilities.canUpdateOperational
        && scopeMatches(snapshot, P.OPERATIONAL_UPDATE, context.scope);
    },
    canReadClassification(classification, context = {}) {
      const caseType = context.caseType;
      if (!PERSONNEL_LIFECYCLE_CASE_TYPES.includes(caseType)) return false;
      const hasBaseRead = central && baseCaseRead(snapshot, caseType);
      if (classification === C.OPERATIONAL_STANDARD) {
        return hasBaseRead || snapshot.canReadOperationalScope(context);
      }
      if (classification === C.PERSONAL_RESTRICTED) {
        return hasBaseRead && capabilities.canReadPersonalRestricted;
      }
      if (classification === C.HR_CONFIDENTIAL) {
        return hasBaseRead && capabilities.canReadHrConfidential;
      }
      if (classification === C.OFFBOARDING_STRICT_CONFIDENTIAL) {
        return caseType === "offboarding" && capabilities.canReadOffboardingConfidential;
      }
      if (classification === C.EMPLOYEE_RELEASED) {
        if (hasBaseRead) return true;
        const subjectEmployeeNumber = validActorId(
          context.subjectEmployeeNumber ?? context.subject_employee_number,
        );
        return personalEmployee
          && context.portalActive === true
          && context.employeeReleased === true
          && subjectEmployeeNumber === actorId
          && (caseType !== "offboarding" || context.employeeInformed === true);
      }
      return false;
    },
    canProject(projectionValue, context = {}) {
      const projection = text(projectionValue);
      if (!Object.values(PROJECTION).includes(projection)) return false;
      const recipientClass = text(context.recipientClass ?? context.recipient_class);
      if (recipientClass !== PERSONNEL_LIFECYCLE_PROJECTION_RECIPIENT_CLASSES[projection]) {
        return false;
      }
      if (projection === PROJECTION.CONFIDENTIAL_AUDIT) {
        return capabilities.canReadConfidentialAudit;
      }
      if (projection === PROJECTION.EMPLOYEE_TASK) {
        return snapshot.canReadClassification(C.EMPLOYEE_RELEASED, context);
      }
      if (ASSIGNED_TASK_PROJECTIONS.has(projection)) {
        const assignedActorId = validActorId(
          context.assignedActorId ?? context.assigned_actor_id,
        );
        if (!namedActor || context.assignmentActive !== true
          || context.operationalReleased !== true || assignedActorId !== actorId) return false;
        if (scoped && !snapshot.canReadOperationalScope(context)) return false;
        return true;
      }
      if (projection === PROJECTION.HR_CASE && context.caseType === "offboarding") {
        return capabilities.canReadOffboardingConfidential;
      }
      const classification = PERSONNEL_LIFECYCLE_PROJECTION_CLASSIFICATIONS[projection];
      return snapshot.canReadClassification(classification, context);
    },
    project(source, projection, context = {}) {
      return snapshot.canProject(projection, context)
        ? projectPersonnelLifecycleRecord(source, projection)
        : null;
    },
  });

  Object.defineProperty(snapshot, SNAPSHOT, { enumerable: false, value: true });
  return Object.freeze(snapshot);
}

function personnelLifecycleCaseAccessForSession(session) {
  return createPersonnelLifecycleCaseAccessSnapshot(session);
}

module.exports = {
  PERSONNEL_LIFECYCLE_CASE_CENTRAL_ROLES,
  PERSONNEL_LIFECYCLE_CASE_SCOPED_ROLES,
  PERSONNEL_LIFECYCLE_CASE_SCOPED_PERMISSIONS,
  createPersonnelLifecycleCaseAccessSnapshot,
  personnelLifecycleCaseAccessForSession,
};
