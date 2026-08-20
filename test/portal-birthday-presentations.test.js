"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS,
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
  portalBirthdayPresentationDefaultPermissionsForRole,
  validatePortalBirthdayPresentationAssignmentInput,
  validatePortalBirthdayPresentationPolicyInput,
} = require("../lib/portal-birthday-presentations");

function principal(role, overrides = {}) {
  return {
    sessionKind: "employee",
    isEmployee: true,
    active: true,
    configured: true,
    portalActive: true,
    employeeNumber: "252",
    role,
    effectiveScopes: [],
    ...overrides,
  };
}

function subject(employeeNumber, locationId, departmentId, overrides = {}) {
  return {
    employeeNumber,
    displayName: `Mitarbeiter ${employeeNumber}`,
    locationId,
    departmentId,
    active: true,
    presentationId: null,
    revision: 0,
    birthDate: "1990-01-01",
    ...overrides,
  };
}

test("Geburtstagsdarstellungen veröffentlichen nur die feste, neutrale Allowlist", () => {
  assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_IDS, [
    "portal:birthday:team:write",
    "portal:birthday:settings:write",
  ]);
  assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_IDS, ["standard"]);
  assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATIONS, [
    { id: "standard", label: "Standarddarstellung" },
  ]);
  assert.equal(PORTAL_BIRTHDAY_PRESENTATION_OFF, "off");
  assert.equal(Object.isFrozen(PORTAL_BIRTHDAY_PRESENTATIONS[0]), true);
  assert.equal(normalizePortalBirthdayPresentationId("standard"), "standard");
  assert.equal(normalizePortalBirthdayPresentationId("off"), "off");
  assert.equal(normalizePortalBirthdayPresentationId(null), "off");
  for (const invalid of [undefined, "", "Standard", "confetti", 1, false]) {
    assert.throws(
      () => normalizePortalBirthdayPresentationId(invalid),
      PortalBirthdayPresentationError,
    );
  }
});

test("Standardrollen trennen globale PL+-Konfiguration von Teamzuweisungen", () => {
  const P = PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS;
  assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS.manager, [P.TEAM_WRITE]);
  assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS.hr, [P.SETTINGS_WRITE]);
  assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS.admin, [P.SETTINGS_WRITE]);
  assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS.developer, [
    P.TEAM_WRITE,
    P.SETTINGS_WRITE,
  ]);
  assert.deepEqual(PORTAL_BIRTHDAY_PRESENTATION_DEFAULT_PERMISSIONS.it_admin, []);
  assert.deepEqual(portalBirthdayPresentationDefaultPermissionsForRole("unknown"), []);

  const hr = createPortalBirthdayPresentationAccessSnapshot(principal("hr"));
  assert.equal(hr.canManageGlobal, true);
  assert.equal(hr.canManageTeam, false);
  assert.equal(hr.canDelegateTeam, true);
  assert.equal(hr.canManageSubject(subject("100", "18", 2)), false);
  assert.equal(hr.canDelegateSubject(subject("100", "18", 2)), true);

  const admin = createPortalBirthdayPresentationAccessSnapshot(principal("admin"));
  assert.equal(admin.canManageGlobal, true);
  assert.equal(admin.canManageTeam, false);
  assert.equal(admin.canDelegateTeam, true);

  const developer = createPortalBirthdayPresentationAccessSnapshot(principal("developer"));
  assert.equal(developer.canManageGlobal, true);
  assert.equal(developer.canManageTeam, true);
  assert.equal(developer.canDelegateTeam, true);
  assert.equal(developer.canManageSubject(subject("100", "99", 7)), true);
  assert.equal(developer.canDelegateSubject(subject("100", "99", 7)), true);

  const it = createPortalBirthdayPresentationAccessSnapshot(principal("it_admin", {
    permissions: PORTAL_BIRTHDAY_PRESENTATION_PERMISSION_IDS,
  }));
  assert.equal(it.canManageGlobal, false);
  assert.equal(it.canManageTeam, false);
  assert.equal(it.canDelegateTeam, false);
  assert.equal(it.canManageSubject(subject("100", "18", 2)), false);
  assert.equal(createPortalBirthdayPresentationAccess, createPortalBirthdayPresentationAccessSnapshot);
});

test("FL verwaltet nur eigene Filialen und kann Teamrecht an AL delegieren", () => {
  const access = createPortalBirthdayPresentationAccessSnapshot(principal("manager", {
    effectiveScopes: [
      {
        type: "location", locationId: "18", departmentId: null,
        valid: true, active: true, locationActive: true,
      },
      {
        type: "department", locationId: "05", departmentId: 4,
        valid: true, active: true, locationActive: true, departmentActive: true,
      },
      {
        type: "location", locationId: "", departmentId: null,
        valid: true, active: true, locationActive: true,
      },
    ],
  }));
  assert.equal(access.canManageGlobal, false);
  assert.equal(access.canManageTeam, true);
  assert.equal(access.canDelegateTeam, true);
  assert.deepEqual(access.scopes, [{ type: "location", locationId: "18", departmentId: null }]);
  assert.equal(access.canManageSubject(subject("100", "18", 2)), true);
  assert.equal(access.canDelegateSubject(subject("100", "18", 2)), true);
  assert.equal(access.canManageSubject(subject("101", "05", 4)), false);
  assert.equal(access.canDelegateSubject(subject("101", "05", 4)), false);
  assert.equal(access.canManageSubject(subject("102", "18", 2, { active: false })), false);

  const rawClientScope = createPortalBirthdayPresentationAccessSnapshot(principal("manager", {
    scopes: [{ locationId: "18", departmentId: null }],
  }));
  assert.equal(rawClientScope.canManageTeam, false);
  assert.equal(rawClientScope.canDelegateTeam, false);

  const revoked = createPortalBirthdayPresentationAccessSnapshot(principal("manager", {
    effectiveScopes: [{
      type: "location", locationId: "18", departmentId: null,
      valid: true, active: true, locationActive: true,
    }],
    deniedPermissions: [PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE],
  }));
  assert.equal(revoked.canManageTeam, false);
  assert.equal(revoked.canDelegateTeam, false);
});

test("AL erhält Teamzugriff nur explizit delegiert und nur für eigene Abteilung", () => {
  const withoutDelegation = createPortalBirthdayPresentationAccessSnapshot(
    principal("department_manager", { effectiveScopes: [{
      type: "department", locationId: "18", departmentId: 2,
      valid: true, active: true, locationActive: true, departmentActive: true,
    }], homeLocationId: "18", preferredDepartmentId: 2 }),
  );
  assert.equal(withoutDelegation.canManageTeam, false);

  const delegated = createPortalBirthdayPresentationAccessSnapshot(principal(
    "department_manager",
    {
      permissions: [PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE],
      homeLocationId: "18",
      preferredDepartmentId: 2,
      effectiveScopes: [
        {
          type: "department", locationId: "18", departmentId: 2,
          valid: true, active: true, locationActive: true, departmentActive: true,
        },
        {
          type: "location", locationId: "18", departmentId: null,
          valid: true, active: true, locationActive: true,
        },
      ],
    },
  ));
  assert.equal(delegated.canManageTeam, true);
  assert.equal(delegated.canDelegateTeam, false);
  assert.deepEqual(delegated.scopes, [{
    type: "department", locationId: "18", departmentId: 2,
  }]);
  assert.equal(delegated.canManageSubject(subject("100", "18", 2)), true);
  assert.equal(delegated.canManageSubject(subject("101", "18", 3)), false);
  assert.equal(delegated.canManageSubject(subject("102", "05", 2)), false);

  const mismatchedScope = createPortalBirthdayPresentationAccessSnapshot(principal(
    "department_manager",
    {
      permissions: [PORTAL_BIRTHDAY_PRESENTATION_PERMISSIONS.TEAM_WRITE],
      homeLocationId: "18",
      preferredDepartmentId: 2,
      effectiveScopes: [{
        type: "department", locationId: "18", departmentId: 3,
        valid: true, active: true, locationActive: true, departmentActive: true,
      }],
    },
  ));
  assert.equal(mismatchedScope.canManageTeam, false);
  assert.deepEqual(mismatchedScope.scopes, []);
});

test("Teamprojektion ist serverseitig bereichsbegrenzt und enthält keine Geburtsdaten", () => {
  const access = createPortalBirthdayPresentationAccessSnapshot(principal("manager", {
    effectiveScopes: [{
      type: "location", locationId: "18", departmentId: null,
      valid: true, active: true, locationActive: true,
    }],
  }));
  const projected = access.projectSubjects([
    subject("100", "18", 2),
    subject("101", "05", 4),
    { invalid: true },
  ]);
  assert.deepEqual(projected, [{
    employeeNumber: "100",
    displayName: "Mitarbeiter 100",
    locationId: "18",
    departmentId: 2,
    active: true,
    presentationId: "off",
    revision: 0,
  }]);
  assert.deepEqual(Object.keys(projected[0]).sort(), [
    "active",
    "departmentId",
    "displayName",
    "employeeNumber",
    "locationId",
    "presentationId",
    "revision",
  ]);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected[0]), true);
});

test("Nur aktive persönliche Portal-Principals erhalten einen Zugriffssnapshot", () => {
  assert.equal(isActivePersonalPortalPrincipal(principal("manager")), true);
  for (const invalid of [
    principal("manager", { active: false }),
    principal("manager", { configured: false }),
    principal("manager", { localSystem: true }),
    principal("manager", { portalActive: false }),
    principal("manager", { employeeNumber: "local" }),
    principal("manager", { sessionKind: "location" }),
    principal("manager", { isEmployee: false }),
    principal("unknown"),
  ]) {
    const access = createPortalBirthdayPresentationAccessSnapshot(invalid);
    assert.equal(access.personal, false);
    assert.equal(access.canManageGlobal, false);
    assert.equal(access.canManageTeam, false);
  }
});

test("Schreibinputs sind vollständig, revisionsgebunden und ohne unbekannte Felder", () => {
  assert.deepEqual(validatePortalBirthdayPresentationPolicyInput({
    enabled: true,
    expectedRevision: 1,
  }), { enabled: true, expectedRevision: 1 });
  assert.deepEqual(validatePortalBirthdayPresentationAssignmentInput({
    employeeNumber: "252",
    presentationId: null,
    expectedRevision: 0,
  }), { employeeNumber: "252", presentationId: "off", expectedRevision: 0 });

  assert.throws(() => validatePortalBirthdayPresentationPolicyInput({
    enabled: true,
    expectedRevision: 1,
    employeeNumber: "252",
  }), PortalBirthdayPresentationError);
  assert.throws(() => validatePortalBirthdayPresentationPolicyInput({
    enabled: "true",
    expectedRevision: 1,
  }), PortalBirthdayPresentationError);
  assert.throws(() => validatePortalBirthdayPresentationAssignmentInput({
    employeeNumber: " 252",
    presentationId: "standard",
    expectedRevision: 0,
  }), PortalBirthdayPresentationError);
  for (const employeeNumber of ["252\n", "25\u00012", "252\u007f"]) {
    assert.throws(() => validatePortalBirthdayPresentationAssignmentInput({
      employeeNumber,
      presentationId: "standard",
      expectedRevision: 0,
    }), PortalBirthdayPresentationError);
  }
  assert.throws(() => validatePortalBirthdayPresentationAssignmentInput({
    employeeNumber: "252",
    presentationId: "confetti",
    expectedRevision: 0,
  }), PortalBirthdayPresentationError);
});
