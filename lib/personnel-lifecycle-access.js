"use strict";

const PERSONNEL_LIFECYCLE_ACCESS_RIGHTS = Object.freeze({
  CANDIDATES_READ: "personnel:candidates:read",
  CANDIDATES_CREATE: "personnel:candidates:create",
  CANDIDATES_WRITE: "personnel:candidates:write",
  APPLICATIONS_WRITE: "personnel:applications:write",
  CONFIDENTIAL_READ: "personnel:candidates:confidential:read",
  CONFIDENTIAL_WRITE: "personnel:candidates:confidential:write",
  CANDIDATES_CONVERT: "personnel:candidates:convert",
  CANDIDATES_DELEGATE: "personnel:candidates:delegate",
});

const PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS = Object.freeze(
  Object.values(PERSONNEL_LIFECYCLE_ACCESS_RIGHTS),
);
const PERSONNEL_LIFECYCLE_ACCESS_RIGHT_ID_SET = new Set(
  PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS,
);

const PERSONNEL_LIFECYCLE_GLOBAL_ROLES = Object.freeze([
  "local",
  "hr",
  "admin",
  "developer",
]);
const PERSONNEL_LIFECYCLE_GLOBAL_ROLE_SET = new Set(
  PERSONNEL_LIFECYCLE_GLOBAL_ROLES,
);
const PERSONNEL_LIFECYCLE_SCOPED_ROLES = Object.freeze([
  "manager",
  "department_manager",
]);
const PERSONNEL_LIFECYCLE_SCOPED_ROLE_SET = new Set(
  PERSONNEL_LIFECYCLE_SCOPED_ROLES,
);

const PERSONNEL_LIFECYCLE_SCOPED_RIGHTS = Object.freeze([
  PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_READ,
  PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.APPLICATIONS_WRITE,
]);
const PERSONNEL_LIFECYCLE_SCOPED_RIGHT_SET = new Set(
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS,
);
const PERSONNEL_LIFECYCLE_MANAGER_RIGHT_SET = new Set([
  ...PERSONNEL_LIFECYCLE_SCOPED_RIGHTS,
  PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_CREATE,
]);

const ACCESS_SNAPSHOT = Symbol("personnel-lifecycle-access-snapshot");

function text(value) {
  return String(value ?? "").trim();
}

function isLocalSystemSession(session) {
  return session?.localSystem === true
    && text(session?.sessionKind).toLowerCase() === "local"
    && text(session?.employeeNumber ?? session?.employee_number).toLowerCase() === "local";
}

function normalizedRole(session) {
  if (isLocalSystemSession(session)) return "local";
  const role = text(session?.role).toLowerCase();
  return role === "local" ? "" : role;
}

function validLocationId(value) {
  const locationId = text(value);
  return locationId && locationId.length <= 80 && !locationId.includes("\0")
    ? locationId
    : "";
}

function normalizedDepartmentId(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") {
    return null;
  }
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) return undefined;
  const departmentId = Number(value);
  return Number.isSafeInteger(departmentId) && departmentId > 0
    ? departmentId
    : undefined;
}

function normalizeScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.valid === false || value.active === false || value.locationActive === false
    || value.location_active === false || value.departmentActive === false
    || value.department_active === false) return null;
  const locationId = validLocationId(
    value.locationId ?? value.location_id ?? value.desiredLocationId ?? value.desired_location_id,
  );
  const departmentId = normalizedDepartmentId(
    value.departmentId ?? value.department_id ?? value.desiredDepartmentId ?? value.desired_department_id,
  );
  if (!locationId || departmentId === undefined) return null;
  const departmentLocationId = validLocationId(
    value.departmentLocationId ?? value.department_location_id,
  );
  if (departmentLocationId && departmentLocationId !== locationId) return null;
  return Object.freeze({ locationId, departmentId });
}

function scopeKey(scope) {
  return `${scope.locationId}\0${scope.departmentId ?? "*"}`;
}

function uniqueScopes(values) {
  const scopes = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const scope = normalizeScope(value);
    if (scope) scopes.set(scopeKey(scope), scope);
  }
  return Object.freeze([...scopes.values()]);
}

function permissionScopeApproval(value) {
  const approvedBy = text(value?.approvedBy ?? value?.approved_by);
  return approvedBy && approvedBy.length <= 120 && !approvedBy.includes("\0")
    ? approvedBy
    : "";
}

function uniquePermissionScopes(values) {
  const scopes = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const scope = normalizeScope(value);
    const approvedBy = permissionScopeApproval(value);
    if (!scope || !approvedBy) continue;
    scopes.set(scopeKey(scope), Object.freeze({ ...scope, approvedBy }));
  }
  return Object.freeze([...scopes.values()]);
}

function normalizedPermissions(session) {
  const permissions = new Set();
  for (const value of Array.isArray(session?.permissions) ? session.permissions : []) {
    const permission = text(value);
    if (PERSONNEL_LIFECYCLE_ACCESS_RIGHT_ID_SET.has(permission)) permissions.add(permission);
  }
  return Object.freeze([...permissions].sort());
}

function permissionScopeEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value);
}

function normalizedPermissionScopes(session) {
  const grouped = new Map(PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS.map((permission) => [permission, []]));
  const source = session?.permissionScopes ?? session?.permission_scopes;
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const permission = text(entry.permission ?? entry.permissionId ?? entry.permission_id);
      if (!PERSONNEL_LIFECYCLE_ACCESS_RIGHT_ID_SET.has(permission)) continue;
      const scopes = Array.isArray(entry.scopes)
        ? entry.scopes.map((scope) => ({
            ...scope,
            approvedBy: scope?.approvedBy ?? scope?.approved_by
              ?? entry.approvedBy ?? entry.approved_by,
          }))
        : [entry];
      grouped.get(permission).push(...scopes);
    }
  } else {
    for (const [permissionValue, scopes] of permissionScopeEntries(source)) {
      const permission = text(permissionValue);
      if (!PERSONNEL_LIFECYCLE_ACCESS_RIGHT_ID_SET.has(permission)) continue;
      grouped.get(permission).push(...(Array.isArray(scopes) ? scopes : [scopes]));
    }
  }
  return Object.freeze(Object.fromEntries(
    PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS.map((permission) => [
      permission,
      uniquePermissionScopes(grouped.get(permission)),
    ]),
  ));
}

function scopedIntersection(role, explicitScopes, permissionScopes) {
  if (role === "manager") {
    const explicitlyAssignedLocations = new Set(explicitScopes
      .filter((scope) => scope.departmentId === null)
      .map((scope) => scope.locationId));
    return Object.freeze(permissionScopes
      .filter((scope) => scope.departmentId === null
        && explicitlyAssignedLocations.has(scope.locationId))
      .map((scope) => Object.freeze({ locationId: scope.locationId, departmentId: null })));
  }
  if (role === "department_manager") {
    const explicitlyAssignedDepartments = new Set(explicitScopes
      .filter((scope) => scope.departmentId !== null)
      .map(scopeKey));
    return Object.freeze(permissionScopes
      .filter((scope) => scope.departmentId !== null
        && explicitlyAssignedDepartments.has(scopeKey(scope)))
      .map((scope) => Object.freeze({
        locationId: scope.locationId,
        departmentId: scope.departmentId,
      })));
  }
  return Object.freeze([]);
}

function isLocalSystemRole(role) {
  return role === "local";
}

function permissionAllowedForRole(role, permission) {
  if (!PERSONNEL_LIFECYCLE_ACCESS_RIGHT_ID_SET.has(permission)) return false;
  if (isLocalSystemRole(role)) return true;
  if (PERSONNEL_LIFECYCLE_GLOBAL_ROLE_SET.has(role)) return role !== "local";
  if (role === "manager") return PERSONNEL_LIFECYCLE_MANAGER_RIGHT_SET.has(permission);
  return role === "department_manager"
    && PERSONNEL_LIFECYCLE_SCOPED_RIGHT_SET.has(permission);
}

function permissionEffective(snapshot, permission) {
  if (!permissionAllowedForRole(snapshot.role, permission)) return false;
  if (snapshot.localSystem) return true;
  if (!snapshot.permissions.includes(permission)) return false;
  if (snapshot.global) return true;
  return (snapshot.allowedScopesByPermission[permission] || []).length > 0;
}

function createPersonnelLifecycleAccessSnapshot(session = {}) {
  if (session?.[ACCESS_SNAPSHOT] === true) return session;
  const role = normalizedRole(session);
  const localSystem = isLocalSystemSession(session);
  const global = localSystem
    || (PERSONNEL_LIFECYCLE_GLOBAL_ROLE_SET.has(role) && role !== "local");
  const scoped = PERSONNEL_LIFECYCLE_SCOPED_ROLE_SET.has(role);
  const permissions = normalizedPermissions(session);
  const explicitScopes = uniqueScopes(
    session?.explicitScopes ?? session?.explicit_scopes ?? [],
  );
  const permissionScopes = normalizedPermissionScopes(session);
  const allowedScopesByPermissionValue = Object.fromEntries(
    PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS.map((permission) => [
      permission,
      scoped && PERSONNEL_LIFECYCLE_SCOPED_RIGHT_SET.has(permission)
        ? scopedIntersection(role, explicitScopes, permissionScopes[permission])
        : Object.freeze([]),
    ]),
  );
  if (role === "manager") {
    const readableScopeKeys = new Set(
      allowedScopesByPermissionValue[PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_READ]
        .map(scopeKey),
    );
    allowedScopesByPermissionValue[PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_CREATE]
      = Object.freeze(
        allowedScopesByPermissionValue[PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.APPLICATIONS_WRITE]
          .filter((scope) => scope.departmentId === null && readableScopeKeys.has(scopeKey(scope)))
          .map((scope) => Object.freeze({
            locationId: scope.locationId,
            departmentId: null,
          })),
      );
  }
  const allowedScopesByPermission = Object.freeze(allowedScopesByPermissionValue);
  const snapshot = {
    actorId: text(session?.actorId ?? session?.employeeNumber ?? session?.employee_number),
    role,
    localSystem,
    global,
    scoped,
    permissions,
    explicitScopes,
    permissionScopes,
    allowedScopesByPermission,
  };
  const canReadCandidates = permissionEffective(
    snapshot,
    PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_READ,
  );
  const canWriteCandidates = canReadCandidates && permissionEffective(
    snapshot,
    PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_WRITE,
  );
  const canWriteApplications = canReadCandidates && permissionEffective(
    snapshot,
    PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.APPLICATIONS_WRITE,
  );
  const canCreateCandidates = canReadCandidates
    && canWriteApplications
    && permissionEffective(
      snapshot,
      PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_CREATE,
    )
    && (!global || canWriteCandidates);
  const canReadConfidential = global && canReadCandidates && permissionEffective(
    snapshot,
    PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CONFIDENTIAL_READ,
  );
  const canWriteConfidential = canReadConfidential && canWriteApplications
    && permissionEffective(
      snapshot,
      PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CONFIDENTIAL_WRITE,
    );
  snapshot.capabilities = Object.freeze({
    canReadCandidates,
    canCreateCandidates,
    canWriteCandidates,
    canWriteApplications,
    canReadConfidential,
    canWriteConfidential,
    canConvertCandidates: global && canWriteCandidates && canWriteConfidential
      && permissionEffective(
        snapshot,
        PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_CONVERT,
      ),
    canDelegateCandidates: global && permissionEffective(
      snapshot,
      PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_DELEGATE,
    ),
  });
  Object.assign(snapshot, snapshot.capabilities, {
    canReadApplication(application) {
      return personnelLifecycleScopeMatches(
        snapshot,
        PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_READ,
        application,
      );
    },
    canWriteApplication(application) {
      return personnelLifecycleScopeMatches(
        snapshot,
        PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.APPLICATIONS_WRITE,
        application,
      );
    },
    canWriteCandidate(application) {
      return personnelLifecycleScopeMatches(
        snapshot,
        PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_WRITE,
        application,
      );
    },
    canCreateCandidate(application) {
      return personnelLifecycleScopeMatches(
        snapshot,
        PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_CREATE,
        application,
      );
    },
  });
  Object.defineProperty(snapshot, ACCESS_SNAPSHOT, {
    enumerable: false,
    value: true,
  });
  return Object.freeze(snapshot);
}

function personnelLifecycleAccessCapabilities(sessionOrSnapshot) {
  return createPersonnelLifecycleAccessSnapshot(sessionOrSnapshot).capabilities;
}

function personnelLifecycleAccessForSession(session) {
  return createPersonnelLifecycleAccessSnapshot(session);
}

function personnelLifecycleCapabilities(sessionOrSnapshot) {
  return personnelLifecycleAccessCapabilities(sessionOrSnapshot);
}

function personnelLifecycleScopeMatches(sessionOrSnapshot, permissionValue, applicationOrScope) {
  const snapshot = createPersonnelLifecycleAccessSnapshot(sessionOrSnapshot);
  const permission = text(permissionValue);
  if (!permissionEffective(snapshot, permission)) return false;
  if (snapshot.global) return true;
  const applicationScope = normalizeScope(applicationOrScope);
  if (!applicationScope) return false;
  const allowed = snapshot.allowedScopesByPermission[permission] || [];
  if (snapshot.role === "manager") {
    return allowed.some((scope) => scope.departmentId === null
      && scope.locationId === applicationScope.locationId);
  }
  if (snapshot.role === "department_manager") {
    return applicationScope.departmentId !== null
      && allowed.some((scope) => scope.locationId === applicationScope.locationId
        && scope.departmentId === applicationScope.departmentId);
  }
  return false;
}

function visiblePersonnelLifecycleApplications(
  candidateOrApplications,
  sessionOrSnapshot,
  permission = PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_READ,
) {
  const snapshot = createPersonnelLifecycleAccessSnapshot(sessionOrSnapshot);
  const applications = Array.isArray(candidateOrApplications)
    ? candidateOrApplications
    : Array.isArray(candidateOrApplications?.applications)
      ? candidateOrApplications.applications
      : [];
  return applications.filter((application) => (
    personnelLifecycleScopeMatches(snapshot, permission, application)
  ));
}

function cloneData(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("Zyklische Bewerberprojektionen sind nicht zulaessig.");
  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  if (Array.isArray(value)) {
    for (const entry of value) clone.push(cloneData(entry, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) clone[key] = cloneData(entry, seen);
  }
  seen.delete(value);
  return clone;
}

function assignKnown(target, source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) {
      target[key] = cloneData(source[key]);
    }
  }
  return target;
}

const CANDIDATE_PROJECTION_KEYS = Object.freeze([
  "id",
  "state",
  "revision",
  "archivedAt",
  "createdAt",
  "updatedAt",
]);
const APPLICATION_PROJECTION_KEYS = Object.freeze([
  "id",
  "candidateId",
  "status",
  "desiredPositionId",
  "desiredLocationId",
  "desiredDepartmentId",
  "desiredWeeklyMinutes",
  "availableFrom",
  "desiredRoleTitle",
  "employmentType",
  "revision",
  "statusChangedAt",
  "createdAt",
  "updatedAt",
]);

function structuredApplicationProjection(application) {
  return assignKnown({}, application || {}, APPLICATION_PROJECTION_KEYS);
}

function minimalProfileProjection(profile, { includeContact = false } = {}) {
  const projected = assignKnown({}, profile || {}, ["firstName", "lastName"]);
  if (includeContact) assignKnown(projected, profile || {}, ["email", "phone"]);
  return projected;
}

function projectedCandidate(candidate, snapshot, { detail = false } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (!snapshot.capabilities.canReadCandidates) return null;
  const visibleApplications = visiblePersonnelLifecycleApplications(candidate, snapshot);
  if (!snapshot.global && !visibleApplications.length) return null;
  if (snapshot.global && snapshot.capabilities.canReadConfidential) return cloneData(candidate);
  const projection = assignKnown({}, candidate, CANDIDATE_PROJECTION_KEYS);
  projection.profile = minimalProfileProjection(candidate.profile, { includeContact: detail });
  projection.applications = visibleApplications.map(structuredApplicationProjection);
  return projection;
}

function projectPersonnelLifecycleCandidateList(candidate, sessionOrSnapshot) {
  return projectedCandidate(
    candidate,
    createPersonnelLifecycleAccessSnapshot(sessionOrSnapshot),
    { detail: false },
  );
}

function projectPersonnelLifecycleCandidateDetail(candidate, sessionOrSnapshot) {
  return projectedCandidate(
    candidate,
    createPersonnelLifecycleAccessSnapshot(sessionOrSnapshot),
    { detail: true },
  );
}

function projectPersonnelLifecycleCandidate(
  candidate,
  sessionOrSnapshot,
  { detail = false } = {},
) {
  return projectedCandidate(
    candidate,
    createPersonnelLifecycleAccessSnapshot(sessionOrSnapshot),
    { detail: detail === true },
  );
}

function projectPersonnelLifecycleApplication(application, sessionOrSnapshot) {
  const snapshot = createPersonnelLifecycleAccessSnapshot(sessionOrSnapshot);
  if (!personnelLifecycleScopeMatches(
    snapshot,
    PERSONNEL_LIFECYCLE_ACCESS_RIGHTS.CANDIDATES_READ,
    application,
  )) return null;
  if (snapshot.global && snapshot.capabilities.canReadConfidential) {
    return cloneData(application);
  }
  return structuredApplicationProjection(application);
}

function projectPersonnelLifecycleCandidateListItems(candidates, sessionOrSnapshot) {
  const snapshot = createPersonnelLifecycleAccessSnapshot(sessionOrSnapshot);
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => projectedCandidate(candidate, snapshot, { detail: false }))
    .filter(Boolean);
}

module.exports = {
  PERSONNEL_LIFECYCLE_PERMISSIONS: PERSONNEL_LIFECYCLE_ACCESS_RIGHTS,
  PERSONNEL_LIFECYCLE_ACCESS_RIGHTS,
  PERSONNEL_LIFECYCLE_ACCESS_RIGHT_IDS,
  PERSONNEL_LIFECYCLE_GLOBAL_ROLES,
  PERSONNEL_LIFECYCLE_SCOPED_ROLES,
  PERSONNEL_LIFECYCLE_SCOPED_RIGHTS,
  isLocalSystemSession,
  createPersonnelLifecycleAccessSnapshot,
  personnelLifecycleAccessForSession,
  personnelLifecycleAccessCapabilities,
  personnelLifecycleCapabilities,
  personnelLifecycleScopeMatches,
  visiblePersonnelLifecycleApplications,
  projectPersonnelLifecycleCandidateList,
  projectPersonnelLifecycleCandidateDetail,
  projectPersonnelLifecycleCandidate,
  projectPersonnelLifecycleApplication,
  projectPersonnelLifecycleCandidateListItems,
};
