"use strict";

const PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS = Object.freeze({
  TEAM_WRITE: "portal:birthday:team:write",
  SETTINGS_WRITE: "portal:birthday:settings:write",
});

const PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_IDS = Object.freeze(
  Object.values(PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS),
);
const PORTAL_BIRTHDAY_PRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "elegant",
    label: "Elegant",
    description: "Ruhige Festlichkeit mit feinen Formen und zurückhaltendem Glanz.",
    previewUrl: "/assets/birthday-presentations/elegant.svg",
  }),
  Object.freeze({
    id: "farbenfroh",
    label: "Farbenfroh",
    description: "Lebendige, ausgewogene Farbflächen für einen fröhlichen Auftritt.",
    previewUrl: "/assets/birthday-presentations/farbenfroh.svg",
  }),
  Object.freeze({
    id: "fotowelt",
    label: "Fotowelt",
    description: "Fotografisch inspirierte Formen mit Kamera- und Lichtakzenten.",
    previewUrl: "/assets/birthday-presentations/fotowelt.svg",
  }),
  Object.freeze({
    id: "technik",
    label: "Technik",
    description: "Präzise geometrische Linien mit modernen digitalen Akzenten.",
    previewUrl: "/assets/birthday-presentations/technik.svg",
  }),
  Object.freeze({
    id: "standard",
    label: "Dezent",
    description: "Warme, besonders zurückhaltende Gestaltung ohne starke Effekte.",
    previewUrl: "/assets/birthday-presentations/dezent.svg",
  }),
]);
const PORTAL_BIRTHDAY_PRESENTATION_IDS = Object.freeze(
  PORTAL_BIRTHDAY_PRESENTATIONS.map(({ id }) => id),
);
const PORTAL_BIRTHDAY_PRESENTATION_OFF = "off";
const PRESENTATION_ID_SET = new Set([
  ...PORTAL_BIRTHDAY_PRESENTATION_IDS,
  PORTAL_BIRTHDAY_PRESENTATION_OFF,
]);
const PERSONAL_ROLE_SET = new Set([
  "employee",
  "location_planner",
  "department_manager",
  "manager",
  "hr",
  "admin",
  "it_admin",
  "developer",
]);
const TEAM_WRITE_ROLE_SET = new Set(["department_manager", "manager", "developer"]);
const SETTINGS_WRITE_ROLE_SET = new Set(["hr", "admin", "developer"]);

const PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS = Object.freeze({
  employee: Object.freeze([]),
  location_planner: Object.freeze([]),
  department_manager: Object.freeze([]),
  manager: Object.freeze([PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE]),
  hr: Object.freeze([PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.SETTINGS_WRITE]),
  admin: Object.freeze([PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.SETTINGS_WRITE]),
  it_admin: Object.freeze([]),
  developer: Object.freeze([
    PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE,
    PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.SETTINGS_WRITE,
  ]),
});

const PORTAL_BIRTHDAY_PRESENTATION_ERROR_CODES = Object.freeze({
  INPUT_INVALID: "PORTAL_BIRTHDAY_PRESENTATION_INPUT_INVALID",
  PRESENTATION_INVALID: "PORTAL_BIRTHDAY_PRESENTATION_ID_INVALID",
  PRINCIPAL_INVALID: "PORTAL_BIRTHDAY_PRESENTATION_PRINCIPAL_INVALID",
  SUBJECT_INVALID: "PORTAL_BIRTHDAY_PRESENTATION_SUBJECT_INVALID",
});

class PortalBirthdayPresentationError extends Error {
  constructor(message, code = PORTAL_BIRTHDAY_PRESENTATION_ERROR_CODES.INPUT_INVALID) {
    super(message);
    this.name = "PortalBirthdayPresentationError";
    this.code = code;
  }
}

function error(message, code) {
  return new PortalBirthdayPresentationError(message, code);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function strictRecord(value, allowedKeys, label) {
  if (!isPlainRecord(value)) {
    throw error(`${label} muss als Objekt angegeben werden.`);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw error(`${label} enthält unbekannte Felder.`);
  }
  return value;
}

function requiredText(value, label, maximum = 120) {
  if (typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw error(`${label} ist ungültig.`);
  }
  return value;
}

function safeRevision(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw error(`${label} ist ungültig.`);
  }
  return value;
}

function normalizePortalBirthdayPresentationId(value) {
  const normalized = value === null ? PORTAL_BIRTHDAY_PRESENTATION_OFF : value;
  if (typeof normalized !== "string" || !PRESENTATION_ID_SET.has(normalized)) {
    throw error(
      "Die Geburtstagsdarstellung ist nicht freigegeben.",
      PORTAL_BIRTHDAY_PRESENTATION_ERROR_CODES.PRESENTATION_INVALID,
    );
  }
  return normalized;
}

function validatePortalBirthdayPresentationAssignmentInput(value) {
  const input = strictRecord(
    value,
    ["employeeNumber", "presentationId", "expectedRevision"],
    "Die Geburtstagsdarstellung",
  );
  if (!Object.hasOwn(input, "employeeNumber")
    || !Object.hasOwn(input, "presentationId")
    || !Object.hasOwn(input, "expectedRevision")) {
    throw error("Die Geburtstagsdarstellung ist unvollständig.");
  }
  return Object.freeze({
    employeeNumber: requiredText(input.employeeNumber, "Die Personalnummer"),
    presentationId: normalizePortalBirthdayPresentationId(input.presentationId),
    expectedRevision: safeRevision(input.expectedRevision, "Die erwartete Revision", 0),
  });
}

function validatePortalBirthdayPresentationPolicyInput(value) {
  const input = strictRecord(
    value,
    ["enabled", "expectedRevision"],
    "Die Geburtstagsrichtlinie",
  );
  if (typeof input.enabled !== "boolean"
    || !Object.hasOwn(input, "expectedRevision")) {
    throw error("Die Geburtstagsrichtlinie ist unvollständig oder ungültig.");
  }
  return Object.freeze({
    enabled: input.enabled,
    expectedRevision: safeRevision(input.expectedRevision, "Die erwartete Revision", 1),
  });
}

function portalBirthdayPresentationDefaultPermissionsForRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS[role] || Object.freeze([]);
}

function normalizedPermissions(principal, role) {
  const supplied = Array.isArray(principal.permissions)
    ? principal.permissions
    : [
        ...portalBirthdayPresentationDefaultPermissionsForRole(role),
        ...(Array.isArray(principal.rolePermissions) ? principal.rolePermissions : []),
        ...(Array.isArray(principal.role_permissions) ? principal.role_permissions : []),
        ...(Array.isArray(principal.grantedPermissions) ? principal.grantedPermissions : []),
        ...(Array.isArray(principal.granted_permissions) ? principal.granted_permissions : []),
      ];
  const effective = new Set(supplied
    .filter((permission) => typeof permission === "string")
    .filter((permission) => PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_IDS
      .includes(permission)));
  for (const permission of [
    ...(Array.isArray(principal.deniedPermissions) ? principal.deniedPermissions : []),
    ...(Array.isArray(principal.denied_permissions) ? principal.denied_permissions : []),
  ]) effective.delete(permission);
  return Object.freeze([...effective].sort());
}

function normalizedDepartmentId(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function normalizedScope(value) {
  if (!isPlainRecord(value)) return null;
  if (value.valid !== true || value.active !== true || value.locationActive !== true) return null;
  const locationId = String(value.locationId ?? value.location_id ?? "").trim();
  const departmentId = normalizedDepartmentId(value.departmentId ?? value.department_id);
  if (!locationId || locationId.length > 80 || locationId.includes("\0")
    || departmentId === undefined) return null;
  const type = String(value.type ?? value.scopeType ?? value.scope_type ?? "").trim().toLowerCase();
  if (type === "location" && departmentId === null) {
    return Object.freeze({ type, locationId, departmentId: null });
  }
  if (type !== "department" || departmentId === null || value.departmentActive !== true) {
    return null;
  }
  const departmentLocationId = String(
    value.departmentLocationId ?? value.department_location_id ?? locationId,
  ).trim();
  if (departmentLocationId !== locationId) return null;
  return Object.freeze({ type, locationId, departmentId });
}

function normalizedScopes(principal, role) {
  if (!["manager", "department_manager"].includes(role)) return Object.freeze([]);
  const homeLocationId = String(
    principal.homeLocationId ?? principal.home_location_id ?? "",
  ).trim();
  const preferredDepartmentId = normalizedDepartmentId(
    principal.preferredDepartmentId ?? principal.preferred_department_id,
  );
  if (role === "department_manager"
    && (!homeLocationId || preferredDepartmentId === null || preferredDepartmentId === undefined)) {
    return Object.freeze([]);
  }
  const byKey = new Map();
  const source = principal.effectiveScopes ?? principal.effective_scopes;
  for (const value of Array.isArray(source) ? source : []) {
    const scope = normalizedScope(value);
    if (!scope) continue;
    if (role === "manager" && scope.type !== "location") continue;
    if (role === "department_manager"
      && (scope.type !== "department"
        || scope.locationId !== homeLocationId
        || scope.departmentId !== preferredDepartmentId)) continue;
    byKey.set(`${scope.type}\0${scope.locationId}\0${scope.departmentId ?? 0}`, scope);
  }
  return Object.freeze([...byKey.values()]);
}

function isActivePersonalPortalPrincipal(principal) {
  if (!isPlainRecord(principal)) return false;
  const employeeNumber = String(principal.employeeNumber ?? principal.employee_number ?? "").trim();
  const role = String(principal.role || "").trim().toLowerCase();
  return principal.sessionKind === "employee"
    && principal.isEmployee === true
    && principal.localSystem !== true
    && principal.active === true
    && principal.configured === true
    && principal.portalActive !== false
    && employeeNumber !== ""
    && employeeNumber.toLowerCase() !== "local"
    && PERSONAL_ROLE_SET.has(role);
}

function normalizePortalBirthdayPresentationSubject(value) {
  if (!isPlainRecord(value)) {
    throw error(
      "Die serverseitige Teamprojektion ist ungültig.",
      PORTAL_BIRTHDAY_PRESENTATION_ERROR_CODES.SUBJECT_INVALID,
    );
  }
  const employeeNumber = requiredText(
    value.employeeNumber ?? value.employee_number,
    "Die Personalnummer der Teamprojektion",
  );
  const locationId = String(value.locationId ?? value.location_id ?? value.homeLocationId
    ?? value.home_location_id ?? "").trim();
  const departmentId = normalizedDepartmentId(value.departmentId ?? value.department_id
    ?? value.preferredDepartmentId ?? value.preferred_department_id);
  if (!locationId || locationId.length > 80 || locationId.includes("\0")
    || departmentId === undefined) {
    throw error(
      "Die serverseitige Bereichsprojektion ist ungültig.",
      PORTAL_BIRTHDAY_PRESENTATION_ERROR_CODES.SUBJECT_INVALID,
    );
  }
  const active = value.active === true || value.active === 1;
  const revisionValue = value.revision == null ? 0 : Number(value.revision);
  if (!Number.isSafeInteger(revisionValue) || revisionValue < 0) {
    throw error(
      "Die Revision der Teamprojektion ist ungültig.",
      PORTAL_BIRTHDAY_PRESENTATION_ERROR_CODES.SUBJECT_INVALID,
    );
  }
  return Object.freeze({
    employeeNumber,
    displayName: String(value.displayName ?? value.display_name ?? value.fullName
      ?? value.full_name ?? employeeNumber).replace(/\s+/g, " ").trim().slice(0, 160),
    locationId,
    departmentId,
    active,
    presentationId: normalizePortalBirthdayPresentationId(
      value.presentationId ?? value.presentation_id ?? null,
    ),
    revision: revisionValue,
  });
}

function createPortalBirthdayPresentationAccessSnapshot(principal = {}) {
  const personal = isActivePersonalPortalPrincipal(principal);
  const role = personal ? String(principal.role).trim().toLowerCase() : "";
  const permissions = personal ? normalizedPermissions(principal, role) : Object.freeze([]);
  const scopes = personal ? normalizedScopes(principal, role) : Object.freeze([]);
  const hasTeamWrite = personal
    && TEAM_WRITE_ROLE_SET.has(role)
    && permissions.includes(PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE);
  const hasSettingsWrite = personal
    && SETTINGS_WRITE_ROLE_SET.has(role)
    && permissions.includes(PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.SETTINGS_WRITE);
  const canManageGlobal = hasSettingsWrite;
  const canManageTeam = hasTeamWrite
    && (role === "developer" || scopes.length > 0);
  const canAdministerGlobalDelegation = hasSettingsWrite
    && ["hr", "admin", "developer"].includes(role);
  const canDelegateTeam = canAdministerGlobalDelegation
    || (canManageTeam && role === "manager");

  function canManageSubject(subjectValue) {
    let subject;
    try {
      subject = normalizePortalBirthdayPresentationSubject(subjectValue);
    } catch {
      return false;
    }
    if (!subject.active || !canManageTeam) return false;
    if (role === "developer") return true;
    if (role === "manager") {
      return scopes.some((scope) => scope.type === "location"
        && scope.locationId === subject.locationId);
    }
    if (role === "department_manager" && subject.departmentId !== null) {
      return scopes.some((scope) => scope.type === "department"
        && scope.locationId === subject.locationId
        && scope.departmentId === subject.departmentId);
    }
    return false;
  }

  function canDelegateSubject(subjectValue) {
    let subject;
    try {
      subject = normalizePortalBirthdayPresentationSubject(subjectValue);
    } catch {
      return false;
    }
    if (!subject.active || subject.departmentId === null || !canDelegateTeam) return false;
    if (canAdministerGlobalDelegation) return true;
    return role === "manager" && scopes.some((scope) => scope.type === "location"
      && scope.locationId === subject.locationId);
  }

  function projectSubjects(values) {
    const projected = [];
    for (const value of Array.isArray(values) ? values : []) {
      let subject;
      try { subject = normalizePortalBirthdayPresentationSubject(value); } catch { continue; }
      if (canManageSubject(subject)) projected.push(subject);
    }
    return Object.freeze(projected);
  }

  return Object.freeze({
    actorEmployeeNumber: personal
      ? String(principal.employeeNumber ?? principal.employee_number).trim()
      : "",
    role,
    personal,
    permissions,
    scopes,
    hasTeamWrite,
    hasSettingsWrite,
    canManageGlobal,
    canManageTeam,
    canDelegateTeam,
    canManageSubject,
    canDelegateSubject,
    projectSubjects,
  });
}

const createPortalBirthdayPresentationAccess =
  createPortalBirthdayPresentationAccessSnapshot;

module.exports = {
  PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS,
  PORTAL_BIRTHDAY_PRESENTATION_ERROR_CODES,
  PORTAL_BIRTHDAY_PRESENTATION_IDS,
  PORTAL_BIRTHDAY_PRESENTATION_OFF,
  PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_IDS,
  PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS,
  PORTAL_BIRTHDAY_PRESENTATIONS,
  PortalBirthdayPresentationError,
  createPortalBirthdayPresentationAccess,
  createPortalBirthdayPresentationAccessSnapshot,
  isActivePersonalPortalPrincipal,
  normalizePortalBirthdayPresentationId,
  normalizePortalBirthdayPresentationSubject,
  portalBirthdayPresentationDefaultPermissionsForRole,
  validatePortalBirthdayPresentationAssignmentInput,
  validatePortalBirthdayPresentationPolicyInput,
};
