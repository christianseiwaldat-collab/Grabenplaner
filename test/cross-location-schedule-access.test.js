"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CROSS_LOCATION_SCHEDULE_PERMISSIONS: P,
  CROSS_LOCATION_SCHEDULE_PERMISSION_IDS,
  CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS,
  CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES,
  CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT,
  CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT,
  CROSS_LOCATION_SCHEDULE_SETTING_KEYS,
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
} = require("../lib/cross-location-schedule-access");

const HOME = "18";
const FOREIGN = "05";
const OTHER = "07";
const DEPARTMENT = 181;

function scope(role, locationId = HOME, departmentId = DEPARTMENT) {
  return role === "manager"
    ? {
        type: "location",
        locationId,
        departmentId: null,
        valid: true,
        active: true,
        locationActive: true,
      }
    : {
        type: "department",
        locationId,
        departmentId,
        departmentLocationId: locationId,
        valid: true,
        active: true,
        locationActive: true,
        departmentActive: true,
      };
}

function principal(role, overrides = {}) {
  const defaults = crossLocationScheduleDefaultPermissionsForRole(role);
  return {
    employeeNumber: `actor-${role}`,
    role,
    active: true,
    configured: true,
    sessionKind: "employee",
    isEmployee: true,
    homeLocationId: HOME,
    preferredDepartmentId: role === "department_manager" ? DEPARTMENT : null,
    effectiveScopes: [scope(role === "department_manager" ? role : "manager")],
    permissions: ["schedule:read", ...defaults],
    ...overrides,
  };
}

function foreignSchedule() {
  return {
    location: {
      id: FOREIGN,
      name: "Filiale 05",
      active: true,
      internalCostCenter: "KST-05",
    },
    departments: [
      { id: 501, name: "Fotowelt", active: true, internalNote: "nicht ausgeben" },
    ],
    teamMembers: [
      {
        employeeNumber: "275",
        displayName: "Marie",
        fullName: "Nicht ausgeben",
        privateEmail: "nicht@example.invalid",
        contractedHours: 38.5,
        weeklyHours: 40,
        timeBalance: 19.25,
        departmentId: 501,
        departmentName: "Fotowelt",
        color: "#AABBCC",
      },
    ],
    shifts: [
      {
        id: 987,
        employeeNumber: "275",
        date: "2026-08-27",
        startTime: "09:00",
        endTime: "18:00",
        departmentId: 501,
        departmentName: "Fotowelt",
        workRuleChecks: [{ state: "failed", reason: "nicht ausgeben" }],
        weeklyHours: 40,
        note: "nicht ausgeben",
      },
      {
        employeeNumber: "geheime-person",
        date: "2026-08-27",
        startTime: "09:00",
        endTime: "18:00",
        privateEmail: "nicht@example.invalid",
      },
    ],
    unavailability: [
      {
        employeeNumber: "275",
        dateFrom: "2026-08-28",
        dateTo: "2026-08-28",
        allDay: true,
        type: "sick",
        reason: "nicht ausgeben",
        note: "nicht ausgeben",
      },
      {
        employeeNumber: "geheime-person",
        dateFrom: "2026-08-28",
        dateTo: "2026-08-28",
        allDay: true,
        reason: "nicht ausgeben",
      },
    ],
    weeklyHours: [{ employeeNumber: "275", hours: 40 }],
    workRuleChecks: [{ employeeNumber: "275", state: "failed" }],
    timeBalances: [{ employeeNumber: "275", balance: 19.25 }],
  };
}

test("Block 1: Rechte-, Rollen- und Datenschutzvertrag ist exakt und tief eingefroren", () => {
  assert.deepEqual(P, {
    READ: "schedule:cross_location:read",
    REQUEST_CREATE: "staff_assignment_requests:create",
    REQUEST_REVIEW: "staff_assignment_requests:review",
    SETTINGS_WRITE: "schedule:cross_location:settings:write",
  });
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_PERMISSION_IDS, Object.values(P));
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS, [
    P.READ,
    P.REQUEST_CREATE,
    P.REQUEST_REVIEW,
  ]);
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT.operationalDefaultRoles, ["manager"]);
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT.settingsDefaultRoles, ["hr", "admin"]);
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT.excludedTechnicalRoles, ["it_admin"]);
  assert.equal(CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT.developerReceivesAllKnownPermissions, true);
  assert.equal(CROSS_LOCATION_SCHEDULE_ROLE_CONTRACT.personalEmployeeAccountRequired, true);
  assert.equal(CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.horizon, "current_and_next_week");
  assert.equal(CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.readOnly, true);
  assert.equal(CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.workRuleChecksIncluded, false);
  assert.equal(CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.weeklyHoursIncluded, false);
  assert.equal(CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.timeBalancesIncluded, false);
  assert.equal(CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.absenceReasonsIncluded, false);
  assert.equal(Object.isFrozen(P), true);
  assert.equal(Object.isFrozen(CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES), true);
  assert.equal(Object.isFrozen(CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.teamMemberFields), true);
});

test("Block 1: FL erhält operative Grundrechte, PL+ nur das Metarecht und Developer alles", () => {
  assert.deepEqual(crossLocationScheduleDefaultPermissionsForRole("manager"),
    CROSS_LOCATION_SCHEDULE_OPERATIONAL_PERMISSION_IDS);
  for (const role of ["hr", "admin"]) {
    assert.deepEqual(crossLocationScheduleDefaultPermissionsForRole(role), [P.SETTINGS_WRITE]);
  }
  assert.deepEqual(crossLocationScheduleDefaultPermissionsForRole("developer"),
    CROSS_LOCATION_SCHEDULE_PERMISSION_IDS);
  for (const role of ["department_manager", "location_planner", "employee", "it_admin", ""]) {
    assert.deepEqual(crossLocationScheduleDefaultPermissionsForRole(role), [], role);
  }
  const applied = applyCrossLocationScheduleRoleDefaults("manager", ["own_schedule:read"]);
  assert.equal(applied.includes("own_schedule:read"), true);
  assert.equal(applied.includes(P.SETTINGS_WRITE), false);
  assert.equal(new Set(applied).size, applied.length);
});

test("Block 1: Abhängigkeiten verhindern isolierte oder unvollständige Zusatzrechte", () => {
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES[P.READ], ["schedule:read"]);
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES[P.REQUEST_CREATE], [P.READ]);
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES[P.REQUEST_REVIEW], ["schedule:read"]);
  assert.deepEqual(CROSS_LOCATION_SCHEDULE_PERMISSION_DEPENDENCIES[P.SETTINGS_WRITE], []);

  for (const permissions of [
    [P.READ],
    [P.REQUEST_CREATE],
    [P.READ, P.REQUEST_CREATE],
    [P.REQUEST_REVIEW],
  ]) {
    const result = resolveCrossLocationSchedulePermissionDependencies(permissions);
    assert.equal(result.valid, false, permissions.join(","));
  }
  const valid = resolveCrossLocationSchedulePermissionDependencies([
    "schedule:read",
    P.READ,
    P.REQUEST_CREATE,
    P.REQUEST_REVIEW,
  ]);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.effectivePermissions,
    [P.READ, P.REQUEST_CREATE, P.REQUEST_REVIEW].sort());
  assert.equal(resolveCrossLocationSchedulePermissionDependencies([P.SETTINGS_WRITE]).valid, true);
});

test("Block 1: nur aktive persönliche Konten mit kanonischem Scope erhalten operative Fähigkeiten", () => {
  const manager = principal("manager");
  const access = createCrossLocationScheduleAccessSnapshot(manager);
  assert.equal(access.activePersonalEmployee, true);
  assert.equal(access.canReadForeignSchedules, true);
  assert.equal(access.canCreateRequests, true);
  assert.equal(access.canReviewRequests, true);
  assert.equal(access.canManageSettings, false);
  assert.deepEqual(access.organizationScope, {
    global: false,
    locationId: HOME,
    departmentId: null,
  });

  for (const override of [
    { active: false },
    { configured: false },
    { sessionKind: "organization", isEmployee: false },
    { sessionKind: "local", localSystem: true },
    { effectiveScopes: [] },
    { effectiveScopes: [{ ...scope("manager"), locationActive: false }] },
  ]) {
    const denied = createCrossLocationScheduleAccessSnapshot(principal("manager", override));
    assert.equal(denied.canReadForeignSchedules, false, JSON.stringify(override));
    assert.equal(denied.canCreateRequests, false, JSON.stringify(override));
    assert.equal(denied.canReviewRequests, false, JSON.stringify(override));
  }
});

test("Block 1: fremde Planlektüre ist auf aktuelle und nächste Woche begrenzt", () => {
  const manager = principal("manager");
  assert.equal(canReadCrossLocationSchedule({ actor: manager, sourceLocationId: FOREIGN }), true);
  assert.equal(canReadCrossLocationSchedule({ actor: manager, sourceLocationId: HOME }), false);
  assert.equal(canReadCrossLocationSchedule({ actor: principal("employee"), sourceLocationId: FOREIGN }), false);
  assert.equal(allowedCrossLocationScheduleWeek("2026-08-17", "2026-08-19"), true);
  assert.equal(allowedCrossLocationScheduleWeek("2026-08-24", "2026-08-19"), true);
  assert.equal(allowedCrossLocationScheduleWeek("2026-08-10", "2026-08-19"), false);
  assert.equal(allowedCrossLocationScheduleWeek("2026-08-31", "2026-08-19"), false);
  assert.equal(allowedCrossLocationScheduleWeek("2026-08-18", "2026-08-19"), false);
  assert.equal(allowedCrossLocationScheduleWeek("ungültig", "2026-08-19"), false);
});

test("Block 7: Dienstplan-Einstellungen sind vollständig, streng und auf maximal zwei Wochen begrenzt", () => {
  assert.deepEqual(Object.keys(CROSS_LOCATION_SCHEDULE_DEFAULT_SETTINGS).sort(),
    Object.values(CROSS_LOCATION_SCHEDULE_SETTING_KEYS).sort());
  const defaults = normalizeCrossLocationScheduleSettings({});
  assert.deepEqual(defaults, {
    enabled: true,
    horizonWeeks: 2,
    managerRequestCreateEnabled: true,
    departmentManagerRequestCreateEnabled: false,
    departmentManagerRequestReviewEnabled: false,
    emailSubmittedEnabled: true,
    emailDecisionEnabled: true,
    changePolicy: "withdraw_and_resubmit",
    cancellationPolicy: "source_review",
  });
  const values = crossLocationScheduleSettingsValuesFromInput({
    enabled: false,
    horizonWeeks: 1,
    managerRequestCreateEnabled: false,
    departmentManagerRequestCreateEnabled: true,
    departmentManagerRequestReviewEnabled: true,
    emailSubmittedEnabled: false,
    emailDecisionEnabled: false,
    changePolicy: "locked",
    cancellationPolicy: "pl_plus_only",
  });
  assert.equal(values.cross_location_schedule_enabled, "0");
  assert.equal(values.cross_location_schedule_horizon_weeks, "1");
  assert.equal(values.staff_assignment_request_change_policy, "locked");
  assert.equal(values.staff_assignment_request_cancellation_policy, "pl_plus_only");
  assert.throws(() => crossLocationScheduleSettingsValuesFromInput({}), TypeError);
  assert.throws(() => crossLocationScheduleSettingsValuesFromInput({
    enabled: true,
    horizonWeeks: 3,
    managerRequestCreateEnabled: true,
    departmentManagerRequestCreateEnabled: false,
    departmentManagerRequestReviewEnabled: false,
    emailSubmittedEnabled: true,
    emailDecisionEnabled: true,
    changePolicy: "withdraw_and_resubmit",
    cancellationPolicy: "source_review",
  }), TypeError);
  assert.equal(allowedCrossLocationScheduleWeek("2026-08-17", "2026-08-19", 1), true);
  assert.equal(allowedCrossLocationScheduleWeek("2026-08-24", "2026-08-19", 1), false);
});

test("Block 7: globale und rollenspezifische Schalter begrenzen Lesen, Stellen und Entscheiden", () => {
  const manager = principal("manager");
  const departmentManager = principal("department_manager", {
    permissions: ["schedule:read", P.READ, P.REQUEST_CREATE, P.REQUEST_REVIEW],
  });
  assert.equal(crossLocationScheduleOperationAllowed(manager, {}, "read"), true);
  assert.equal(crossLocationScheduleOperationAllowed(manager, {
    cross_location_schedule_enabled: "0",
  }, "read"), false);
  assert.equal(crossLocationScheduleOperationAllowed(manager, {
    staff_assignment_requests_manager_create_enabled: "0",
  }, "create"), false);
  assert.equal(crossLocationScheduleOperationAllowed(departmentManager, {}, "create"), false);
  assert.equal(crossLocationScheduleOperationAllowed(departmentManager, {
    staff_assignment_requests_department_manager_create_enabled: "1",
  }, "create"), true);
  assert.equal(crossLocationScheduleOperationAllowed(departmentManager, {}, "review"), false);
  assert.equal(crossLocationScheduleOperationAllowed(departmentManager, {
    staff_assignment_requests_department_manager_review_enabled: "1",
  }, "review"), true);
});

test("Block 1: Anfragen bleiben an die eigene Filiale und bei AL an die eigene Abteilung gebunden", () => {
  const manager = principal("manager");
  assert.equal(canCreateStaffAssignmentRequest({
    actor: manager,
    sourceLocationId: FOREIGN,
    destinationLocationId: HOME,
    destinationDepartmentId: DEPARTMENT,
  }), true);
  assert.equal(canCreateStaffAssignmentRequest({
    actor: manager,
    sourceLocationId: FOREIGN,
    destinationLocationId: OTHER,
    destinationDepartmentId: 701,
  }), false);
  assert.equal(canCreateStaffAssignmentRequest({
    actor: manager,
    sourceLocationId: HOME,
    destinationLocationId: HOME,
  }), false);

  const departmentManager = principal("department_manager", {
    permissions: ["schedule:read", P.READ, P.REQUEST_CREATE],
  });
  assert.equal(canCreateStaffAssignmentRequest({
    actor: departmentManager,
    sourceLocationId: FOREIGN,
    destinationLocationId: HOME,
    destinationDepartmentId: DEPARTMENT,
  }), true);
  assert.equal(canCreateStaffAssignmentRequest({
    actor: departmentManager,
    sourceLocationId: FOREIGN,
    destinationLocationId: HOME,
    destinationDepartmentId: DEPARTMENT + 1,
  }), false);
});

test("Block 1: Entscheidungen bleiben bei Stammfiliale und Abteilungsleitung zusätzlich im Fachbereich", () => {
  const manager = principal("manager");
  assert.equal(canReviewStaffAssignmentRequest({
    actor: manager,
    sourceLocationId: HOME,
    sourceDepartmentId: DEPARTMENT,
  }), true);
  assert.equal(canReviewStaffAssignmentRequest({
    actor: manager,
    sourceLocationId: FOREIGN,
    sourceDepartmentId: 501,
  }), false);

  const departmentManager = principal("department_manager", {
    permissions: ["schedule:read", P.REQUEST_REVIEW],
  });
  assert.equal(canReviewStaffAssignmentRequest({
    actor: departmentManager,
    sourceLocationId: HOME,
    sourceDepartmentId: DEPARTMENT,
  }), true);
  assert.equal(canReviewStaffAssignmentRequest({
    actor: departmentManager,
    sourceLocationId: HOME,
    sourceDepartmentId: DEPARTMENT + 1,
  }), false);
});

test("Block 1: PL+-Metarecht vermittelt allein weder Planlektüre noch Antragsdaten", () => {
  for (const role of ["hr", "admin"]) {
    const access = createCrossLocationScheduleAccessSnapshot(principal(role));
    assert.equal(access.plPlus, true);
    assert.equal(access.canManageSettings, true);
    assert.equal(access.canReadForeignSchedules, false);
    assert.equal(access.canCreateRequests, false);
    assert.equal(access.canReviewRequests, false);
  }
  const denied = createCrossLocationScheduleAccessSnapshot(principal("hr", {
    deniedPermissions: [P.SETTINGS_WRITE],
  }));
  assert.equal(denied.canManageSettings, false);
  const itAdmin = createCrossLocationScheduleAccessSnapshot(principal("it_admin", {
    permissions: ["schedule:read", ...CROSS_LOCATION_SCHEDULE_PERMISSION_IDS],
  }));
  assert.equal(itAdmin.plPlus, false);
  assert.equal(itAdmin.canReadForeignSchedules, false);
  assert.equal(itAdmin.canManageSettings, false);
});

test("Block 1: Fremdansicht liefert ausschließlich die festgelegte Datenminimalprojektion", () => {
  const projected = projectCrossLocationScheduleView({
    actor: principal("manager"),
    sourceLocationId: FOREIGN,
    weekStart: "2026-08-24",
    today: "2026-08-19",
    schedule: foreignSchedule(),
  });
  assert.ok(projected);
  assert.equal(projected.mode, "foreign_read_only");
  assert.deepEqual(Object.keys(projected).sort(), [
    "departments",
    "location",
    "mode",
    "privacy",
    "requestContext",
    "shifts",
    "teamMembers",
    "unavailability",
    "weekEnd",
    "weekStart",
  ].sort());
  assert.deepEqual(Object.keys(projected.location).sort(), ["id", "name"]);
  assert.deepEqual(Object.keys(projected.departments[0]).sort(), ["id", "name"]);
  assert.deepEqual(Object.keys(projected.teamMembers[0]).sort(),
    [...CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.teamMemberFields].sort());
  assert.deepEqual(Object.keys(projected.shifts[0]).sort(),
    [...CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.shiftFields].sort());
  assert.deepEqual(Object.keys(projected.unavailability[0]).sort(),
    [...CROSS_LOCATION_SCHEDULE_PRIVACY_CONTRACT.unavailabilityFields].sort());
  assert.equal(projected.shifts.length, 1);
  assert.equal(projected.unavailability.length, 1);
  assert.deepEqual(projected.unavailability[0], {
    employeeNumber: "275",
    dateFrom: "2026-08-28",
    dateTo: "2026-08-28",
    allDay: true,
    startTime: null,
    endTime: null,
    unavailable: true,
  });
  const serialized = JSON.stringify({
    location: projected.location,
    departments: projected.departments,
    teamMembers: projected.teamMembers,
    shifts: projected.shifts,
    unavailability: projected.unavailability,
  });
  for (const forbidden of [
    "fullName",
    "privateEmail",
    "contractedHours",
    "weeklyHours",
    "timeBalance",
    "workRuleChecks",
    "reason",
    "sick",
    "nicht ausgeben",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(projected.requestContext.sourceLocationId, FOREIGN);
  assert.equal(projected.requestContext.destinationLocationId, HOME);
  assert.equal(projected.requestContext.canCreateRequest, true);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.teamMembers), true);
  assert.equal(Object.isFrozen(projected.teamMembers[0]), true);
});

test("Block 1: Projektion scheitert bei falschem Scope, Zeitraum oder inkonsistenter Quelle geschlossen", () => {
  const valid = {
    actor: principal("manager"),
    sourceLocationId: FOREIGN,
    weekStart: "2026-08-24",
    today: "2026-08-19",
    schedule: foreignSchedule(),
  };
  for (const override of [
    { sourceLocationId: HOME },
    { weekStart: "2026-08-31" },
    { today: "" },
    { actor: principal("manager", { effectiveScopes: [] }) },
    { actor: principal("department_manager") },
    { schedule: { ...foreignSchedule(), location: { id: OTHER, name: "Falsch", active: true } } },
    { schedule: { ...foreignSchedule(), location: { id: FOREIGN, name: "Inaktiv", active: false } } },
  ]) {
    assert.equal(projectCrossLocationScheduleView({ ...valid, ...override }), null,
      JSON.stringify(override));
  }
});
