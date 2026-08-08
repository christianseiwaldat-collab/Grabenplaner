"use strict";

const PERSONNEL_PROFILE_PERMISSIONS = Object.freeze({
  READ: "personnel:profiles:read",
  MASTER_READ: "personnel:profiles:master:read",
  DOCUMENTS_READ: "personnel:profiles:documents:read",
  DELEGATE: "personnel:profiles:delegate",
});

const PERSONNEL_PROFILE_PERMISSION_IDS = Object.freeze(
  Object.values(PERSONNEL_PROFILE_PERMISSIONS),
);
const PERSONNEL_PROFILE_PERMISSION_SET = new Set(PERSONNEL_PROFILE_PERMISSION_IDS);
const PERSONNEL_PROFILE_SCOPED_PERMISSIONS = Object.freeze([
  PERSONNEL_PROFILE_PERMISSIONS.READ,
  PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ,
]);
const PERSONNEL_PROFILE_SCOPED_PERMISSION_SET = new Set(
  PERSONNEL_PROFILE_SCOPED_PERMISSIONS,
);
const PERSONNEL_PROFILE_SCOPED_ROLES = new Set(["manager", "department_manager"]);
const PERSONNEL_PROFILE_DELEGATE_ROLES = new Set(["hr", "admin", "developer"]);
const SNAPSHOT = Symbol("personnel-profile-access");

function text(value) {
  return String(value ?? "").trim();
}

function isLocalSystemSession(session) {
  return session?.localSystem === true
    && text(session?.sessionKind).toLowerCase() === "local"
    && text(session?.employeeNumber ?? session?.employee_number).toLowerCase() === "local";
}

function isPersonalEmployeeSession(session) {
  return session?.sessionKind === "employee"
    && session?.isEmployee === true
    && text(session?.employeeNumber ?? session?.employee_number) !== "";
}

function roleFor(session) {
  if (isLocalSystemSession(session)) return "local";
  const role = text(session?.role).toLowerCase();
  return role === "local" ? "" : role;
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
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.valid === false || value.active === false
    || value.locationActive === false || value.location_active === false
    || value.departmentActive === false || value.department_active === false) return null;
  const locationId = text(
    value.locationId ?? value.location_id
      ?? value.homeLocationId ?? value.home_location_id,
  );
  const departmentId = normalizedDepartmentId(
    value.departmentId ?? value.department_id
      ?? value.preferredDepartmentId ?? value.preferred_department_id,
  );
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
    const scope = normalizeScope(value);
    if (scope) result.set(scopeKey(scope), scope);
  }
  return Object.freeze([...result.values()]);
}

function permissionScopeEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value);
}

function normalizedPermissionScopes(session) {
  const grouped = new Map(PERSONNEL_PROFILE_PERMISSION_IDS.map((permission) => [permission, []]));
  const source = session?.permissionScopes ?? session?.permission_scopes;
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const permission = text(entry.permission ?? entry.permissionId ?? entry.permission_id);
      if (!PERSONNEL_PROFILE_SCOPED_PERMISSION_SET.has(permission)) continue;
      const entries = Array.isArray(entry.scopes)
        ? entry.scopes.map((scope) => ({
            ...scope,
            approvedBy: scope?.approvedBy ?? scope?.approved_by
              ?? entry.approvedBy ?? entry.approved_by,
          }))
        : [entry];
      grouped.get(permission).push(...entries);
    }
  } else {
    for (const [permissionValue, entries] of permissionScopeEntries(source)) {
      const permission = text(permissionValue);
      if (!PERSONNEL_PROFILE_SCOPED_PERMISSION_SET.has(permission)) continue;
      grouped.get(permission).push(...(Array.isArray(entries) ? entries : [entries]));
    }
  }
  return Object.freeze(Object.fromEntries(PERSONNEL_PROFILE_PERMISSION_IDS.map((permission) => {
    const approved = new Map();
    for (const value of grouped.get(permission)) {
      const approvedBy = text(value?.approvedBy ?? value?.approved_by);
      const scope = normalizeScope(value);
      if (!approvedBy || approvedBy.length > 120 || approvedBy.includes("\0") || !scope) continue;
      approved.set(scopeKey(scope), Object.freeze({ ...scope, approvedBy }));
    }
    return [permission, Object.freeze([...approved.values()])];
  })));
}

function normalizedPermissions(session) {
  return Object.freeze([...new Set((Array.isArray(session?.permissions) ? session.permissions : [])
    .map(text)
    .filter((permission) => PERSONNEL_PROFILE_PERMISSION_SET.has(permission)))].sort());
}

function scopedIntersection(role, explicitScopes, approvedScopes) {
  if (role === "manager") {
    const locations = new Set(explicitScopes
      .filter((scope) => scope.departmentId === null)
      .map((scope) => scope.locationId));
    return Object.freeze(approvedScopes
      .filter((scope) => scope.departmentId === null && locations.has(scope.locationId))
      .map((scope) => Object.freeze({ locationId: scope.locationId, departmentId: null })));
  }
  if (role === "department_manager") {
    const departments = new Set(explicitScopes
      .filter((scope) => scope.departmentId !== null)
      .map(scopeKey));
    return Object.freeze(approvedScopes
      .filter((scope) => scope.departmentId !== null && departments.has(scopeKey(scope)))
      .map((scope) => Object.freeze({
        locationId: scope.locationId,
        departmentId: scope.departmentId,
      })));
  }
  return Object.freeze([]);
}

function scopeMatches(snapshot, permission, value) {
  const scope = normalizeScope(value);
  if (!scope) return false;
  const allowed = snapshot.allowedScopesByPermission[permission] || [];
  if (snapshot.role === "manager") {
    return allowed.some((entry) => entry.departmentId === null
      && entry.locationId === scope.locationId);
  }
  if (snapshot.role === "department_manager") {
    return scope.departmentId !== null && allowed.some((entry) => (
      entry.locationId === scope.locationId && entry.departmentId === scope.departmentId
    ));
  }
  return false;
}

function createPersonnelProfileAccessSnapshot(session = {}) {
  if (session?.[SNAPSHOT] === true) return session;
  const localSystem = isLocalSystemSession(session);
  const personalEmployee = isPersonalEmployeeSession(session);
  const role = roleFor(session);
  const personalHr = personalEmployee && role === "hr";
  const personalDeveloper = personalEmployee && role === "developer";
  const global = localSystem || personalHr || personalDeveloper;
  const scoped = personalEmployee && PERSONNEL_PROFILE_SCOPED_ROLES.has(role);
  const permissions = normalizedPermissions(session);
  const explicitScopes = uniqueScopes(
    session?.explicitScopes ?? session?.explicit_scopes ?? [],
  );
  const permissionScopes = normalizedPermissionScopes(session);
  const allowedScopesByPermission = Object.freeze(Object.fromEntries(
    PERSONNEL_PROFILE_PERMISSION_IDS.map((permission) => [
      permission,
      scoped && PERSONNEL_PROFILE_SCOPED_PERMISSION_SET.has(permission)
        ? scopedIntersection(role, explicitScopes, permissionScopes[permission] || [])
        : Object.freeze([]),
    ]),
  ));
  const has = (permission) => localSystem || permissions.includes(permission);
  const hasScoped = (permission) => scoped && has(permission)
    && (allowedScopesByPermission[permission] || []).length > 0;
  const canReadProfiles = localSystem
    || ((personalHr || personalDeveloper) && has(PERSONNEL_PROFILE_PERMISSIONS.READ))
    || hasScoped(PERSONNEL_PROFILE_PERMISSIONS.READ);
  const canReadMaster = canReadProfiles && (
    localSystem
    || ((personalHr || personalDeveloper) && has(PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ))
    || hasScoped(PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ)
  );
  const canReadDocuments = canReadProfiles
    && (localSystem || ((personalHr || personalDeveloper)
      && has(PERSONNEL_PROFILE_PERMISSIONS.DOCUMENTS_READ)));
  const canDelegateProfiles = localSystem || (
    personalEmployee
    && PERSONNEL_PROFILE_DELEGATE_ROLES.has(role)
    && has(PERSONNEL_PROFILE_PERMISSIONS.DELEGATE)
  );
  const snapshot = {
    actorId: text(session?.actorId ?? session?.employeeNumber ?? session?.employee_number),
    role,
    localSystem,
    personalEmployee,
    personalHr,
    personalDeveloper,
    global,
    scoped,
    permissions,
    explicitScopes,
    permissionScopes,
    allowedScopesByPermission,
    capabilities: Object.freeze({
      canReadProfiles,
      canReadMaster,
      canReadDocuments,
      canDelegateProfiles,
    }),
  };
  Object.assign(snapshot, snapshot.capabilities, {
    canReadSubject(value) {
      if (!canReadProfiles) return false;
      if (global) return true;
      return scopeMatches(snapshot, PERSONNEL_PROFILE_PERMISSIONS.READ, value);
    },
    canReadMasterSubject(value) {
      if (!canReadMaster) return false;
      if (global) return true;
      return scopeMatches(snapshot, PERSONNEL_PROFILE_PERMISSIONS.READ, value)
        && scopeMatches(snapshot, PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ, value);
    },
    canReadDocumentsSubject(value) {
      void value;
      return canReadDocuments && global;
    },
  });
  Object.defineProperty(snapshot, SNAPSHOT, { enumerable: false, value: true });
  return Object.freeze(snapshot);
}

function personnelProfileScopeMatches(sessionOrSnapshot, permissionValue, value) {
  const snapshot = createPersonnelProfileAccessSnapshot(sessionOrSnapshot);
  const permission = text(permissionValue);
  if (!PERSONNEL_PROFILE_SCOPED_PERMISSION_SET.has(permission)) return false;
  const capability = permission === PERSONNEL_PROFILE_PERMISSIONS.READ
    ? snapshot.capabilities.canReadProfiles
    : snapshot.capabilities.canReadMaster;
  if (!capability) return false;
  if (snapshot.global) return true;
  if (permission === PERSONNEL_PROFILE_PERMISSIONS.MASTER_READ
    && !scopeMatches(snapshot, PERSONNEL_PROFILE_PERMISSIONS.READ, value)) return false;
  return scopeMatches(snapshot, permission, value);
}

function personnelProfileAccessForSession(session) {
  return createPersonnelProfileAccessSnapshot(session);
}

module.exports = {
  PERSONNEL_PROFILE_PERMISSIONS,
  PERSONNEL_PROFILE_PERMISSION_IDS,
  PERSONNEL_PROFILE_SCOPED_PERMISSIONS,
  createPersonnelProfileAccessSnapshot,
  personnelProfileAccessForSession,
  personnelProfileScopeMatches,
};
