"use strict";

const CROSS_LOCATION_SCHEDULE_PERMISSIONS = Object.freeze({
  READ: "schedule:cross_location:read",
  REQUEST_CREATE: "staff_assignment_requests:create",
  REQUEST_REVIEW: "staff_assignment_requests:review",
  SETTINGS_WRITE: "schedule:cross_location:settings:write",
});

const CROSS_LOCATION_SCHEDULE_PERMISSION_IDS = Object.freeze(
  Object.values(CROSS_LOCATION_SCHEDULE_PERMISSIONS),
);

const CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS = Object.freeze([
  CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ,
  CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_CREATE,
  CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_REVIEW,
]);

const CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES = Object.freeze({
  [CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ]: Object.freeze(["schedule:read"]),
  [CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_CREATE]: Object.freeze([
    CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ,
  ]),
  [CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_REVIEW]: Object.freeze([
    "schedule:read",
  ]),
  [CROSS_LOCATION_SCHEDULE_PERMISSIONS.SETTINGS_WRITE]: Object.freeze([]),
});

const CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT = Object.freeze({
  operationalDefaultRoles: Object.freeze(["manager"]),
  explicitlyDelegableOperationalRoles: Object.freeze([
    "department_manager",
    "manager",
    "hr",
    "admin",
    "developer",
  ]),
  settingsDefaultRoles: Object.freeze(["hr", "admin"]),
  settingsRoles: Object.freeze(["hr", "admin", "developer"]),
  plPlusRoles: Object.freeze(["hr", "admin", "developer"]),
  excludedTechnicalRoles: Object.freeze(["it_admin"]),
  developerReceivesAllKnownPermissions: true,
  personalEmployeeAccountRequired: true,
});

const CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT = Object.freeze({
  horizon: "current_and_next_week",
  readOnly: true,
  workRuleChecksIncluded: false,
  weeklyHoursIncluded: false,
  timeBalancesIncluded: false,
  absenceReasonsIncluded: false,
  sensitivePersonnelFieldsIncluded: false,
  teamMemberFields: Object.freeze([
    "employeeNumber",
    "displayName",
    "departmentId",
    "departmentName",
    "color",
    "requestEligible",
  ]),
  shiftFields: Object.freeze([
    "employeeNumber",
    "date",
    "startTime",
    "endTime",
    "departmentId",
    "departmentName",
  ]),
  unavailabilityFields: Object.freeze([
    "employeeNumber",
    "dateFrom",
    "dateTo",
    "allDay",
    "startTime",
    "endTime",
    "unavailable",
  ]),
});

const CROSS_LOCATION_SCHEDULE_SETTING_KEYS = Object.freeze({
  ENABLED: "cross_location_schedule_enabled",
  HORIZON_WEEKS: "cross_location_schedule_horizon_weeks",
  MANAGER_REQUEST_CREATE: "staff_assignment_requests_manager_create_enabled",
  DEPARTMENT_MANAGER_REQUEST_CREATE: "staff_assignment_requests_department_manager_create_enabled",
  DEPARTMENT_MANAGER_REQUEST_REVIEW: "staff_assignment_requests_department_manager_review_enabled",
  EMAIL_SUBMITTED: "staff_assignment_request_email_submitted_enabled",
  EMAIL_DECISION: "staff_assignment_request_email_decision_enabled",
  CHANGE_POLICY: "staff_assignment_request_change_policy",
  CANCELLATION_POLICY: "staff_assignment_request_cancellation_policy",
});

const CROSS_LOCATION_SCHEDULE_CHANGE_POLICIES = Object.freeze([
  "withdraw_and_resubmit",
  "locked",
]);

const CROSS_LOCATION_SCHEDULE_CANCELLATION_POLICIES = Object.freeze([
  "source_review",
  "pl_plus_only",
  "disabled",
]);

const CROSS_LOCATION_SCHEDULE_DEFAULT_SETTINGS = Object.freeze({
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.ENABLED]: "1",
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.HORIZON_WEEKS]: "2",
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.MANAGER_REQUEST_CREATE]: "1",
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.DEPARTMENT_MANAGER_REQUEST_CREATE]: "0",
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.DEPARTMENT_MANAGER_REQUEST_REVIEW]: "0",
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.EMAIL_SUBMITTED]: "1",
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.EMAIL_DECISION]: "1",
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.CHANGE_POLICY]: "withdraw_and_resubmit",
  [CROSS_LOCATION_SCHEDULE_SETTING_KEYS.CANCELLATION_POLICY]: "source_review",
});

const FEATURE_PERMISSION_SET = new Set(CROSS_LOCATION_SCHEDULE_PERMISSION_IDS);
const GLOBAL_ROLE_SET = new Set(["hr", "admin", "developer"]);
const PL_PLUS_ROLE_SET = new Set(CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT.plPlusRoles);
const SNAPSHOT = Symbol("cross-location-schedule-access");
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function text(value, maximum = 200) {
  const normalized = String(value ?? "").trim();
  return normalized && normalized.length <= maximum && !normalized.includes("\0")
    ? normalized
    : "";
}

function settingEnabled(values, key) {
  return String(values?.[key] ?? CROSS_LOCATION_SCHEDULE_DEFAULT_SETTINGS[key]) !== "0";
}

function normalizeCrossLocationScheduleSettings(values = {}) {
  const horizonCandidate = Number(
    values?.[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.HORIZON_WEEKS]
      ?? CROSS_LOCATION_SCHEDULE_DEFAULT_SETTINGS[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.HORIZON_WEEKS],
  );
  const horizonWeeks = [1, 2].includes(horizonCandidate) ? horizonCandidate : 2;
  const changeCandidate = text(
    values?.[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.CHANGE_POLICY]
      ?? CROSS_LOCATION_SCHEDULE_DEFAULT_SETTINGS[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.CHANGE_POLICY],
    80,
  );
  const cancellationCandidate = text(
    values?.[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.CANCELLATION_POLICY]
      ?? CROSS_LOCATION_SCHEDULE_DEFAULT_SETTINGS[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.CANCELLATION_POLICY],
    80,
  );
  return Object.freeze({
    enabled: settingEnabled(values, CROSS_LOCATION_SCHEDULE_SETTING_KEYS.ENABLED),
    horizonWeeks,
    managerRequestCreateEnabled: settingEnabled(
      values,
      CROSS_LOCATION_SCHEDULE_SETTING_KEYS.MANAGER_REQUEST_CREATE,
    ),
    departmentManagerRequestCreateEnabled: settingEnabled(
      values,
      CROSS_LOCATION_SCHEDULE_SETTING_KEYS.DEPARTMENT_MANAGER_REQUEST_CREATE,
    ),
    departmentManagerRequestReviewEnabled: settingEnabled(
      values,
      CROSS_LOCATION_SCHEDULE_SETTING_KEYS.DEPARTMENT_MANAGER_REQUEST_REVIEW,
    ),
    emailSubmittedEnabled: settingEnabled(
      values,
      CROSS_LOCATION_SCHEDULE_SETTING_KEYS.EMAIL_SUBMITTED,
    ),
    emailDecisionEnabled: settingEnabled(
      values,
      CROSS_LOCATION_SCHEDULE_SETTING_KEYS.EMAIL_DECISION,
    ),
    changePolicy: CROSS_LOCATION_SCHEDULE_CHANGE_POLICIES.includes(changeCandidate)
      ? changeCandidate
      : "withdraw_and_resubmit",
    cancellationPolicy: CROSS_LOCATION_SCHEDULE_CANCELLATION_POLICIES.includes(cancellationCandidate)
      ? cancellationCandidate
      : "source_review",
  });
}

function crossLocationScheduleSettingsValuesFromInput(input = {}) {
  const booleanFields = Object.freeze({
    enabled: CROSS_LOCATION_SCHEDULE_SETTING_KEYS.ENABLED,
    managerRequestCreateEnabled: CROSS_LOCATION_SCHEDULE_SETTING_KEYS.MANAGER_REQUEST_CREATE,
    departmentManagerRequestCreateEnabled: CROSS_LOCATION_SCHEDULE_SETTING_KEYS.DEPARTMENT_MANAGER_REQUEST_CREATE,
    departmentManagerRequestReviewEnabled: CROSS_LOCATION_SCHEDULE_SETTING_KEYS.DEPARTMENT_MANAGER_REQUEST_REVIEW,
    emailSubmittedEnabled: CROSS_LOCATION_SCHEDULE_SETTING_KEYS.EMAIL_SUBMITTED,
    emailDecisionEnabled: CROSS_LOCATION_SCHEDULE_SETTING_KEYS.EMAIL_DECISION,
  });
  const values = {};
  for (const [field, key] of Object.entries(booleanFields)) {
    if (typeof input?.[field] !== "boolean") {
      throw new TypeError(`Die Dienstplan-Einstellung ${field} muss wahr oder falsch sein.`);
    }
    values[key] = input[field] ? "1" : "0";
  }
  const horizonWeeks = Number(input?.horizonWeeks);
  if (![1, 2].includes(horizonWeeks)) {
    throw new TypeError("Der Anzeigezeitraum muss eine oder zwei Kalenderwochen umfassen.");
  }
  const changePolicy = text(input?.changePolicy, 80);
  if (!CROSS_LOCATION_SCHEDULE_CHANGE_POLICIES.includes(changePolicy)) {
    throw new TypeError("Die Änderungsregel für Einsatzanfragen ist ungültig.");
  }
  const cancellationPolicy = text(input?.cancellationPolicy, 80);
  if (!CROSS_LOCATION_SCHEDULE_CANCELLATION_POLICIES.includes(cancellationPolicy)) {
    throw new TypeError("Die Stornierungsregel für bestätigte Einsätze ist ungültig.");
  }
  values[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.HORIZON_WEEKS] = String(horizonWeeks);
  values[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.CHANGE_POLICY] = changePolicy;
  values[CROSS_LOCATION_SCHEDULE_SETTING_KEYS.CANCELLATION_POLICY] = cancellationPolicy;
  return Object.freeze(values);
}

function crossLocationScheduleOperationAllowed(accessValue, settingsValue, operation) {
  const access = createCrossLocationScheduleAccessSnapshot(accessValue || {});
  const settings = settingsValue?.horizonWeeks && typeof settingsValue?.enabled === "boolean"
    ? settingsValue
    : normalizeCrossLocationScheduleSettings(settingsValue);
  if (operation === "read") return settings.enabled && access.canReadForeignSchedules;
  if (operation === "create") {
    if (!settings.enabled || !access.canCreateRequests) return false;
    if (access.role === "manager") return settings.managerRequestCreateEnabled;
    if (access.role === "department_manager") {
      return settings.departmentManagerRequestCreateEnabled;
    }
    return true;
  }
  if (operation === "review") {
    return access.canReviewRequests
      && (access.role !== "department_manager" || settings.departmentManagerRequestReviewEnabled);
  }
  if (operation === "email_submitted") return settings.emailSubmittedEnabled;
  if (operation === "email_decision") return settings.emailDecisionEnabled;
  return false;
}

function roleFor(value) {
  return text(value?.role ?? value, 80).toLowerCase();
}

function principalId(value) {
  return text(value?.actorId ?? value?.employeeNumber ?? value?.employee_number, 120);
}

function isActivePersonalEmployeePrincipal(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && principalId(value)
    && value.localSystem !== true
    && text(value.sessionKind, 40).toLowerCase() === "employee"
    && value.isEmployee === true
    && value.active === true
    && value.configured === true);
}

function normalizedPermissionSet(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((permission) => text(permission, 160))
    .filter(Boolean));
}

function assignedPermissionSet(principal) {
  const assigned = Array.isArray(principal?.permissions)
    ? normalizedPermissionSet(principal.permissions)
    : new Set([
        ...normalizedPermissionSet(principal?.rolePermissions ?? principal?.role_permissions),
        ...normalizedPermissionSet(principal?.grantedPermissions ?? principal?.granted_permissions),
      ]);
  for (const permission of normalizedPermissionSet(
    principal?.deniedPermissions ?? principal?.denied_permissions,
  )) assigned.delete(permission);
  return assigned;
}

function resolveCrossLocationSchedulePermissionDependencies(values = []) {
  const assigned = normalizedPermissionSet(values);
  const assignedFeaturePermissions = new Set(
    [...assigned].filter((permission) => FEATURE_PERMISSION_SET.has(permission)),
  );
  const effective = new Set(assignedFeaturePermissions);
  const dependencySatisfied = (dependency) => FEATURE_PERMISSION_SET.has(dependency)
    ? effective.has(dependency)
    : assigned.has(dependency);
  let changed = true;
  while (changed) {
    changed = false;
    for (const permission of [...effective]) {
      const dependencies = CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES[permission] || [];
      if (dependencies.every(dependencySatisfied)) continue;
      effective.delete(permission);
      changed = true;
    }
  }
  const missingDependencies = Object.freeze([...assignedFeaturePermissions]
    .map((permission) => Object.freeze({
      permission,
      missing: Object.freeze((CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES[permission] || [])
        .filter((dependency) => !dependencySatisfied(dependency))),
    }))
    .filter((entry) => entry.missing.length > 0));
  return Object.freeze({
    valid: missingDependencies.length === 0,
    assignedPermissions: Object.freeze([...assignedFeaturePermissions].sort()),
    effectivePermissions: Object.freeze([...effective].sort()),
    missingDependencies,
  });
}

function crossLocationScheduleDefaultPermissionsForRole(roleValue) {
  const role = roleFor(roleValue);
  if (role === "developer") {
    return Object.freeze([...CROSS_LOCATION_SCHEDULE_PERMISSION_IDS]);
  }
  if (role === "manager") {
    return Object.freeze([...CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS]);
  }
  if (["hr", "admin"].includes(role)) {
    return Object.freeze([CROSS_LOCATION_SCHEDULE_PERMISSIONS.SETTINGS_WRITE]);
  }
  return Object.freeze([]);
}

function applyCrossLocationScheduleRoleDefaults(roleValue, permissions = []) {
  return Object.freeze([...new Set([
    ...(Array.isArray(permissions) ? permissions.map((permission) => text(permission, 160)).filter(Boolean) : []),
    ...crossLocationScheduleDefaultPermissionsForRole(roleValue),
  ])].sort());
}

function positiveDepartmentId(value) {
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) return null;
  const departmentId = Number(value);
  return Number.isSafeInteger(departmentId) && departmentId > 0 ? departmentId : null;
}

function normalizeEffectiveScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.valid !== true || value.active !== true || value.locationActive !== true) return null;
  const locationId = text(value.locationId ?? value.location_id, 80);
  if (!locationId) return null;
  const type = text(value.type ?? value.scopeType ?? value.scope_type, 40).toLowerCase();
  const departmentId = positiveDepartmentId(value.departmentId ?? value.department_id);
  if (type === "location" && departmentId === null) {
    return Object.freeze({ type, locationId, departmentId: null });
  }
  if (type !== "department" || value.departmentActive !== true || !departmentId) return null;
  const departmentLocationId = text(
    value.departmentLocationId ?? value.department_location_id ?? locationId,
    80,
  );
  if (departmentLocationId !== locationId) return null;
  return Object.freeze({ type, locationId, departmentId });
}

function effectiveScopes(value) {
  const source = value?.effectiveScopes ?? value?.effective_scopes;
  if (!Array.isArray(source)) return Object.freeze([]);
  const scopes = new Map();
  for (const candidate of source) {
    const scope = normalizeEffectiveScope(candidate);
    if (scope) scopes.set(`${scope.type}\0${scope.locationId}\0${scope.departmentId ?? 0}`, scope);
  }
  return Object.freeze([...scopes.values()]);
}

function principalOrganizationScope(principal, role) {
  const homeLocationId = text(
    principal?.homeLocationId ?? principal?.home_location_id,
    80,
  );
  if (GLOBAL_ROLE_SET.has(role)) {
    return Object.freeze({ global: true, locationId: homeLocationId, departmentId: null });
  }
  if (!homeLocationId) return null;
  const scopes = effectiveScopes(principal);
  if (role === "manager") {
    return scopes.some((scope) => scope.type === "location"
      && scope.locationId === homeLocationId)
      ? Object.freeze({ global: false, locationId: homeLocationId, departmentId: null })
      : null;
  }
  if (role === "department_manager") {
    const preferredDepartmentId = positiveDepartmentId(
      principal?.preferredDepartmentId ?? principal?.preferred_department_id,
    );
    return preferredDepartmentId && scopes.some((scope) => scope.type === "department"
      && scope.locationId === homeLocationId
      && scope.departmentId === preferredDepartmentId)
      ? Object.freeze({
          global: false,
          locationId: homeLocationId,
          departmentId: preferredDepartmentId,
        })
      : null;
  }
  return null;
}

function createCrossLocationScheduleAccessSnapshot(principal = {}) {
  if (principal?.[SNAPSHOT] === true) return principal;
  const role = roleFor(principal);
  const activePersonalEmployee = isActivePersonalEmployeePrincipal(principal);
  const assigned = assignedPermissionSet(principal);
  const dependencyProjection = resolveCrossLocationSchedulePermissionDependencies([...assigned]);
  const permissions = dependencyProjection.effectivePermissions;
  const organizationScope = activePersonalEmployee
    ? principalOrganizationScope(principal, role)
    : null;
  const has = (permission) => permissions.includes(permission);
  const plPlus = activePersonalEmployee && PL_PLUS_ROLE_SET.has(role);
  const canReadForeignSchedules = activePersonalEmployee
    && has(CROSS_LOCATION_SCHEDULE_PERMISSIONS.READ)
    && Boolean(organizationScope);
  const canCreateRequests = canReadForeignSchedules
    && has(CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_CREATE)
    && Boolean(organizationScope?.locationId);
  const canReviewRequests = activePersonalEmployee
    && has(CROSS_LOCATION_SCHEDULE_PERMISSIONS.REQUEST_REVIEW)
    && Boolean(organizationScope);
  const canManageSettings = plPlus
    && has(CROSS_LOCATION_SCHEDULE_PERMISSIONS.SETTINGS_WRITE);
  const snapshot = {
    actorId: principalId(principal),
    role,
    activePersonalEmployee,
    plPlus,
    organizationScope,
    assignedPermissions: Object.freeze([...assigned]
      .filter((permission) => FEATURE_PERMISSION_SET.has(permission)).sort()),
    permissions,
    dependencyProjection,
    capabilities: Object.freeze({
      canReadForeignSchedules,
      canCreateRequests,
      canReviewRequests,
      canManageSettings,
    }),
  };
  Object.assign(snapshot, snapshot.capabilities);
  Object.defineProperty(snapshot, SNAPSHOT, { enumerable: false, value: true });
  return Object.freeze(snapshot);
}

function foreignLocationAllowed(access, sourceLocationId) {
  const source = text(sourceLocationId, 80);
  if (!source || !access.canReadForeignSchedules) return false;
  const ownLocation = text(access.organizationScope?.locationId, 80);
  return !ownLocation || source !== ownLocation;
}

function canReadCrossLocationSchedule({ actor, sourceLocationId } = {}) {
  return foreignLocationAllowed(
    createCrossLocationScheduleAccessSnapshot(actor),
    sourceLocationId,
  );
}

function canCreateStaffAssignmentRequest({
  actor,
  sourceLocationId,
  destinationLocationId,
  destinationDepartmentId = null,
} = {}) {
  const access = createCrossLocationScheduleAccessSnapshot(actor);
  if (!access.canCreateRequests || !foreignLocationAllowed(access, sourceLocationId)) return false;
  const destination = text(destinationLocationId, 80);
  if (!destination || destination !== access.organizationScope.locationId) return false;
  if (access.role !== "department_manager") return true;
  return positiveDepartmentId(destinationDepartmentId)
    === access.organizationScope.departmentId;
}

function canReviewStaffAssignmentRequest({
  actor,
  sourceLocationId,
  sourceDepartmentId = null,
} = {}) {
  const access = createCrossLocationScheduleAccessSnapshot(actor);
  if (!access.canReviewRequests) return false;
  if (access.organizationScope.global) return true;
  if (text(sourceLocationId, 80) !== access.organizationScope.locationId) return false;
  return access.role !== "department_manager"
    || positiveDepartmentId(sourceDepartmentId) === access.organizationScope.departmentId;
}

function validIsoDate(value) {
  const date = text(value, 10);
  if (!ISO_DATE_PATTERN.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? "" : date;
}

function addIsoDays(value, days) {
  const date = validIsoDate(value);
  if (!date) return "";
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function isoWeekMonday(value) {
  const date = validIsoDate(value);
  if (!date) return "";
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - day + 1);
  return parsed.toISOString().slice(0, 10);
}

function allowedCrossLocationScheduleWeek(weekStart, today, horizonWeeks = 2) {
  const requested = validIsoDate(weekStart);
  const current = isoWeekMonday(today);
  const horizon = Number(horizonWeeks);
  return Boolean(requested && current && [1, 2].includes(horizon)
    && Array.from({ length: horizon }, (_, index) => addIsoDays(current, index * 7))
      .includes(requested));
}

function color(value) {
  const normalized = text(value, 20);
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : "";
}

function optionalTime(value) {
  const normalized = text(value, 5);
  return TIME_PATTERN.test(normalized) ? normalized : null;
}

function projectDepartment(value) {
  const id = positiveDepartmentId(value?.id ?? value?.departmentId ?? value?.department_id);
  const name = text(value?.name ?? value?.departmentName ?? value?.department_name, 160);
  return id && name ? Object.freeze({ id, name }) : null;
}

function projectTeamMember(value) {
  const employeeNumber = text(
    value?.employeeNumber ?? value?.employee_number ?? value?.personnelNumber ?? value?.personnel_number,
    120,
  );
  const displayName = text(value?.displayName ?? value?.display_name, 180);
  if (!employeeNumber || !displayName) return null;
  return Object.freeze({
    employeeNumber,
    displayName,
    departmentId: positiveDepartmentId(value?.departmentId ?? value?.department_id),
    departmentName: text(value?.departmentName ?? value?.department_name, 160),
    color: color(value?.color),
    requestEligible: value?.requestEligible === true || value?.request_eligible === true,
  });
}

function projectShift(value, weekStart, weekEnd) {
  const employeeNumber = text(
    value?.employeeNumber ?? value?.employee_number ?? value?.personnelNumber ?? value?.personnel_number,
    120,
  );
  const date = validIsoDate(value?.date ?? value?.shiftDate ?? value?.shift_date);
  const startTime = optionalTime(value?.startTime ?? value?.start_time);
  const endTime = optionalTime(value?.endTime ?? value?.end_time);
  if (!employeeNumber || !date || date < weekStart || date > weekEnd || !startTime || !endTime) return null;
  return Object.freeze({
    employeeNumber,
    date,
    startTime,
    endTime,
    departmentId: positiveDepartmentId(value?.departmentId ?? value?.department_id),
    departmentName: text(value?.departmentName ?? value?.department_name, 160),
  });
}

function projectUnavailability(value, weekStart, weekEnd) {
  const employeeNumber = text(
    value?.employeeNumber ?? value?.employee_number ?? value?.personnelNumber ?? value?.personnel_number,
    120,
  );
  const dateFrom = validIsoDate(value?.dateFrom ?? value?.date_from);
  const dateTo = validIsoDate(value?.dateTo ?? value?.date_to);
  if (!employeeNumber || !dateFrom || !dateTo || dateTo < dateFrom
    || dateTo < weekStart || dateFrom > weekEnd) return null;
  const allDay = value?.allDay === true || value?.all_day === 1 || value?.all_day === true;
  const startTime = allDay ? null : optionalTime(value?.startTime ?? value?.start_time);
  const endTime = allDay ? null : optionalTime(value?.endTime ?? value?.end_time);
  if (!allDay && (!startTime || !endTime)) return null;
  return Object.freeze({
    employeeNumber,
    dateFrom: dateFrom < weekStart ? weekStart : dateFrom,
    dateTo: dateTo > weekEnd ? weekEnd : dateTo,
    allDay,
    startTime,
    endTime,
    unavailable: true,
  });
}

function compactProjection(values, projector) {
  return Object.freeze((Array.isArray(values) ? values : [])
    .map(projector)
    .filter(Boolean));
}

function projectCrossLocationScheduleView({
  actor,
  sourceLocationId,
  weekStart,
  today,
  settings = CROSS_LOCATION_SCHEDULE_DEFAULT_SETTINGS,
  schedule = {},
} = {}) {
  const access = createCrossLocationScheduleAccessSnapshot(actor);
  const configuration = normalizeCrossLocationScheduleSettings(settings);
  const source = text(sourceLocationId, 80);
  const start = validIsoDate(weekStart);
  if (!crossLocationScheduleOperationAllowed(access, configuration, "read")
    || !foreignLocationAllowed(access, source)
    || !allowedCrossLocationScheduleWeek(start, today, configuration.horizonWeeks)) return null;
  const location = schedule?.location || {};
  const projectedLocationId = text(location.id ?? location.locationId ?? location.location_id, 80);
  const projectedLocationName = text(location.name, 180);
  if (location.active !== true || projectedLocationId !== source || !projectedLocationName) return null;
  const end = addIsoDays(start, 6);
  const teamMembers = compactProjection(
    schedule.teamMembers ?? schedule.employees,
    projectTeamMember,
  );
  const visibleEmployeeNumbers = new Set(
    teamMembers.map((teamMember) => teamMember.employeeNumber),
  );
  const projection = {
    location: Object.freeze({
      id: source,
      name: projectedLocationName,
    }),
    weekStart: start,
    weekEnd: end,
    mode: "foreign_read_only",
    privacy: CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT,
    requestContext: Object.freeze({
      sourceLocationId: source,
      destinationLocationId: text(access.organizationScope?.locationId, 80) || null,
      destinationDepartmentId: access.role === "department_manager"
        ? access.organizationScope?.departmentId ?? null
        : null,
      canCreateRequest: crossLocationScheduleOperationAllowed(access, configuration, "create"),
    }),
    departments: compactProjection(schedule.departments, projectDepartment),
    teamMembers,
    shifts: compactProjection(schedule.shifts, (value) => {
      const projected = projectShift(value, start, end);
      return projected && visibleEmployeeNumbers.has(projected.employeeNumber)
        ? projected
        : null;
    }),
    unavailability: compactProjection(
      schedule.unavailability,
      (value) => {
        const projected = projectUnavailability(value, start, end);
        return projected && visibleEmployeeNumbers.has(projected.employeeNumber)
          ? projected
          : null;
      },
    ),
  };
  return Object.freeze(projection);
}

module.exports = {
  CROSS_LOCATION_SCHEDULE_PERMISSIONS,
  CROSS_LOCATION_SCHEDULE_PERMISSION_IDS,
  CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS,
  CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES,
  CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT,
  CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT,
  CROSS_LOCATION_SCHEDULE_SETTING_KEYS,
  CROSS_LOCATION_SCHEDULE_CHANGE_POLICIES,
  CROSS_LOCATION_SCHEDULE_CANCELLATION_POLICIES,
  CROSS_LOCATION_SCHEDULE_DEFAULT_SETTINGS,
  crossLocationScheduleDefaultPermissionsForRole,
  applyCrossLocationScheduleRoleDefaults,
  resolveCrossLocationSchedulePermissionDependencies,
  createCrossLocationScheduleAccessSnapshot,
  canReadCrossLocationSchedule,
  canCreateStaffAssignmentRequest,
  canReviewStaffAssignmentRequest,
  normalizeCrossLocationScheduleSettings,
  crossLocationScheduleSettingsValuesFromInput,
  crossLocationScheduleOperationAllowed,
  allowedCrossLocationScheduleWeek,
  projectCrossLocationScheduleView,
};
