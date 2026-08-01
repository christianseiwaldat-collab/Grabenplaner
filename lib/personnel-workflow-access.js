"use strict";

const PERSONNEL_WORKFLOW_PERMISSIONS = Object.freeze({
  READ: "personnel:workflows:read",
  DRAFT_WRITE: "personnel:workflows:draft:write",
  REVIEW: "personnel:workflows:review",
  PUBLISH: "personnel:workflows:publish",
  LOCAL_SUPPLEMENT: "personnel:workflows:local:supplement",
  CONFIDENTIAL_READ: "personnel:workflows:confidential:read",
  CONFIDENTIAL_WRITE: "personnel:workflows:confidential:write",
  DELEGATE: "personnel:workflows:delegate",
});

const PERSONNEL_WORKFLOW_PERMISSION_IDS = Object.freeze(
  Object.values(PERSONNEL_WORKFLOW_PERMISSIONS),
);
const PERMISSION_SET = new Set(PERSONNEL_WORKFLOW_PERMISSION_IDS);
const SCOPED_PERMISSION_SET = new Set([
  PERSONNEL_WORKFLOW_PERMISSIONS.READ,
  PERSONNEL_WORKFLOW_PERMISSIONS.DRAFT_WRITE,
  PERSONNEL_WORKFLOW_PERMISSIONS.PUBLISH,
  PERSONNEL_WORKFLOW_PERMISSIONS.LOCAL_SUPPLEMENT,
]);
const GLOBAL_ROLE_SET = new Set(["hr", "admin", "developer"]);
const SCOPED_ROLE_SET = new Set(["manager", "department_manager"]);
const SNAPSHOT = Symbol("personnel-workflow-access");

function text(value) {
  return String(value ?? "").trim();
}

function isLocalSystemSession(session) {
  return session?.localSystem === true
    && text(session?.sessionKind).toLowerCase() === "local"
    && text(session?.employeeNumber ?? session?.employee_number).toLowerCase() === "local";
}

function roleFor(session) {
  if (isLocalSystemSession(session)) return "local";
  const role = text(session?.role).toLowerCase();
  return role === "local" ? "" : role;
}

function departmentId(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") {
    return null;
  }
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) return undefined;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function scopeFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.valid === false || value.active === false
    || value.locationActive === false || value.location_active === false
    || value.departmentActive === false || value.department_active === false) return null;
  const type = text(value.type ?? value.scopeType ?? value.scope_type);
  const locationId = text(value.locationId ?? value.location_id);
  const normalizedDepartmentId = departmentId(value.departmentId ?? value.department_id);
  if (type === "company") {
    return locationId || normalizedDepartmentId !== null ? null : Object.freeze({
      type: "company", locationId: null, departmentId: null,
    });
  }
  if (!locationId || locationId.length > 80 || locationId.includes("\0")
    || normalizedDepartmentId === undefined) return null;
  if (type === "location" || (!type && normalizedDepartmentId === null)) {
    return normalizedDepartmentId === null
      ? Object.freeze({ type: "location", locationId, departmentId: null })
      : null;
  }
  if (type === "department" || (!type && normalizedDepartmentId !== null)) {
    const departmentLocationId = text(
      value.departmentLocationId ?? value.department_location_id,
    );
    if (normalizedDepartmentId === null
      || (departmentLocationId && departmentLocationId !== locationId)) return null;
    return Object.freeze({
      type: "department", locationId, departmentId: normalizedDepartmentId,
    });
  }
  return null;
}

function scopeKey(scope) {
  return `${scope.locationId || ""}\0${scope.departmentId || 0}`;
}

function uniqueScopes(values) {
  const result = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const scope = scopeFrom(value);
    if (scope && scope.type !== "company") result.set(scopeKey(scope), scope);
  }
  return Object.freeze([...result.values()]);
}

function permissionScopes(session) {
  const grouped = new Map(PERSONNEL_WORKFLOW_PERMISSION_IDS.map((permission) => [permission, []]));
  const values = Array.isArray(session?.permissionScopes ?? session?.permission_scopes)
    ? (session.permissionScopes ?? session.permission_scopes)
    : [];
  for (const value of values) {
    const permission = text(value?.permission ?? value?.permissionId ?? value?.permission_id);
    const approvedBy = text(value?.approvedBy ?? value?.approved_by);
    const scope = scopeFrom(value);
    if (!SCOPED_PERMISSION_SET.has(permission) || !approvedBy
      || !scope || scope.type === "company") continue;
    grouped.get(permission).push(scope);
  }
  return Object.freeze(Object.fromEntries(
    [...grouped.entries()].map(([permission, scopes]) => [permission, uniqueScopes(scopes)]),
  ));
}

function explicitScopes(session) {
  return uniqueScopes(session?.explicitScopes ?? session?.explicit_scopes ?? []);
}

function normalizedPermissions(session) {
  return Object.freeze([...new Set((Array.isArray(session?.permissions) ? session.permissions : [])
    .map(text)
    .filter((permission) => PERMISSION_SET.has(permission)))].sort());
}

function scopedIntersection(role, generalScopes, approvedScopes) {
  if (role === "manager") {
    const locations = new Set(generalScopes
      .filter((scope) => scope.type === "location")
      .map((scope) => scope.locationId));
    return Object.freeze(approvedScopes.filter((scope) => (
      scope.type === "location" && locations.has(scope.locationId)
    )));
  }
  if (role === "department_manager") {
    const departments = new Set(generalScopes
      .filter((scope) => scope.type === "department")
      .map(scopeKey));
    return Object.freeze(approvedScopes.filter((scope) => (
      scope.type === "department" && departments.has(scopeKey(scope))
    )));
  }
  return Object.freeze([]);
}

function scopeMatches(role, allowed, value) {
  const scope = scopeFrom(value);
  if (!scope || scope.type === "company") return false;
  if (role === "manager") {
    return allowed.some((entry) => (
      entry.type === "location" && entry.locationId === scope.locationId
    ));
  }
  if (role === "department_manager") {
    return scope.type === "department" && allowed.some((entry) => (
      entry.type === "department"
      && entry.locationId === scope.locationId
      && entry.departmentId === scope.departmentId
    ));
  }
  return false;
}

function createPersonnelWorkflowAccessSnapshot(session = {}) {
  if (session?.[SNAPSHOT] === true) return session;
  const localSystem = isLocalSystemSession(session);
  const role = roleFor(session);
  const global = localSystem || GLOBAL_ROLE_SET.has(role);
  const scoped = SCOPED_ROLE_SET.has(role);
  const permissions = normalizedPermissions(session);
  const generalScopes = explicitScopes(session);
  const approvedByPermission = permissionScopes(session);
  const allowedScopesByPermission = Object.freeze(Object.fromEntries(
    PERSONNEL_WORKFLOW_PERMISSION_IDS.map((permission) => [
      permission,
      scoped && SCOPED_PERMISSION_SET.has(permission)
        ? scopedIntersection(role, generalScopes, approvedByPermission[permission] || [])
        : Object.freeze([]),
    ]),
  ));
  const has = (permission) => localSystem || (permissions.includes(permission)
    && (global || allowedScopesByPermission[permission]?.length > 0));
  const snapshot = {
    actorId: text(session?.actorId ?? session?.employeeNumber ?? session?.employee_number),
    role,
    localSystem,
    global,
    scoped,
    permissions,
    explicitScopes: generalScopes,
    allowedScopesByPermission,
  };
  const canRead = has(PERSONNEL_WORKFLOW_PERMISSIONS.READ);
  const canWriteDrafts = canRead && has(PERSONNEL_WORKFLOW_PERMISSIONS.DRAFT_WRITE);
  const canPublish = canWriteDrafts && has(PERSONNEL_WORKFLOW_PERMISSIONS.PUBLISH);
  const canWriteScope = (value) => {
    if (!canWriteDrafts) return false;
    if (global) return true;
    return scopeMatches(role, allowedScopesByPermission[PERSONNEL_WORKFLOW_PERMISSIONS.DRAFT_WRITE], value)
      && scopeMatches(role, allowedScopesByPermission[PERSONNEL_WORKFLOW_PERMISSIONS.LOCAL_SUPPLEMENT], value);
  };
  const canPublishScope = (value, requirementKind = "supplemental") => {
    if (!canPublish) return false;
    if (global) return true;
    return requirementKind === "supplemental"
      && canWriteScope(value)
      && scopeMatches(role, allowedScopesByPermission[PERSONNEL_WORKFLOW_PERMISSIONS.PUBLISH], value);
  };
  snapshot.capabilities = Object.freeze({
    canRead,
    canWriteDrafts,
    canReview: global && canRead && has(PERSONNEL_WORKFLOW_PERMISSIONS.REVIEW),
    canPublish,
    canManageLocalSupplements: canWriteDrafts
      && has(PERSONNEL_WORKFLOW_PERMISSIONS.LOCAL_SUPPLEMENT),
    canReadConfidential: (localSystem || role === "hr")
      && canRead && has(PERSONNEL_WORKFLOW_PERMISSIONS.CONFIDENTIAL_READ),
    canWriteConfidential: (localSystem || role === "hr")
      && canWriteDrafts
      && has(PERSONNEL_WORKFLOW_PERMISSIONS.CONFIDENTIAL_READ)
      && has(PERSONNEL_WORKFLOW_PERMISSIONS.CONFIDENTIAL_WRITE),
    canDelegate: global && has(PERSONNEL_WORKFLOW_PERMISSIONS.DELEGATE),
  });
  Object.assign(snapshot, snapshot.capabilities, {
    canReadScope(value) {
      if (!canRead) return false;
      if (global) return true;
      return scopeMatches(role, allowedScopesByPermission[PERSONNEL_WORKFLOW_PERMISSIONS.READ], value);
    },
    canWriteScope(value) {
      return canWriteScope(value);
    },
    canPublishScope(value, requirementKind = "supplemental") {
      return canPublishScope(value, requirementKind);
    },
    canArchivePublication(publication) {
      if (!publication || !canPublishScope(publication.scope, publication.requirementKind)) return false;
      return global || (
        publication.authorityLevel === "local"
        && publication.requirementKind === "supplemental"
      );
    },
  });
  Object.defineProperty(snapshot, SNAPSHOT, { enumerable: false, value: true });
  return Object.freeze(snapshot);
}

module.exports = {
  PERSONNEL_WORKFLOW_PERMISSIONS,
  PERSONNEL_WORKFLOW_PERMISSION_IDS,
  createPersonnelWorkflowAccessSnapshot,
  isLocalSystemSession,
};
