"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("v0.87 Block 3 UI: Zielrolle steuert Zusatzrechte in beiden Editoren", () => {
  assert.match(app, /function permissionEligibleForRole\(permission, role\)/);
  const rightsEditor = between(app, "function openRightsEditor(", "function renderMobileLeadershipSettings(");
  assert.match(rightsEditor, /permissionEligibleForRole\(permission, user\.role\)/);
  assert.match(rightsEditor, /F.r diese Rolle nicht verf.gbar/);
  assert.match(rightsEditor, /\$\{editable \? "" : "disabled"\}/);

  const personnelAccess = between(app, "function normalizeEmployeeAccessDraftForRole(", "function syncEmployeeSicknessAllowanceField(");
  assert.match(personnelAccess, /permissionEligibleForRole\(permission, roleId\)/);
  assert.match(personnelAccess, /editable && roleEligible && !baseRight/);
  assert.match(personnelAccess, /state\.employeeAccessDraft = new Set/);
});

test("v0.87 Block 3 UI: AUM und Dienstplan erzwingen ihre Leserechte", () => {
  const dependencies = between(app, "const permissionDependencyRules", "async function loadPortalUsers(");
  assert.match(dependencies, /permissionId: "schedule:write"/);
  assert.match(dependencies, /requiredPermissionId: "schedule:read"/);
  assert.match(dependencies, /permissionId: "amu:local:manage"/);
  assert.match(dependencies, /requiredPermissionId: "sickness:read"/);
  assert.match(app, /function enforceRightsEditorPermissionDependencies/);
  assert.match(app, /normalizeEmployeeAccessDraftForRole\(role, input\.value, input\.checked\)/);
});

test("v0.87 Block 3 UI: fachliche Ansichten folgen den wirksamen Einzelrechten", () => {
  const requestAccess = between(app, "function managerRequestTabAvailability()", "function canWriteApprovedAbsenceEntries()");
  assert.match(requestAccess, /permissions\.includes\("vacation:read"\)/);
  assert.match(requestAccess, /permissions\.includes\("sickness:read"\)/);
  assert.match(requestAccess, /permissions\.includes\("amu:local:manage"\)/);
  assert.match(requestAccess, /ensureAccessibleManagerRequestTab/);

  const rulesAccess = between(app, "function canReadPersonnelRulesDashboard()", "function accessibleDashboardModes()");
  assert.match(rulesAccess, /permissions \|\| \[\]\)\.includes\("work_rules:read"\)/);
  assert.doesNotMatch(rulesAccess, /location_planner/);

  const mobileSettings = between(app, "function renderMobileLeadershipSettings()", "function personnelFieldLevelLabel(");
  assert.match(mobileSettings, /\["schedule", "approvals", "more"\]/);
  assert.match(mobileSettings, /Die Laufzeit pr.ft weiterhin die wirksamen Rechte/);
});

test("v0.87 Block 3 UI: Telefonansicht wird nur bei reinem Telefonzugriff bezeichnet", () => {
  const label = between(app, "function personnelRecordButtonLabel()", "const EMPLOYEE_DISPLAY_COLUMNS");
  assert.match(label, /fieldKey !== "phone"/);
  assert.match(label, /access\.canReadSensitive === true/);
  assert.match(label, /access\.canReadDocuments === true/);
  assert.match(label, /access\.canReadAmu === true/);
  assert.match(label, /return phoneVisible && !otherAreaVisible \? "Telefon" : "Personalakt"/);
});

test("v0.87 Block 3 UI: technische Verwaltungsgrenzen bleiben unverändert", () => {
  const accessProfile = between(app, "function canEditEmployeeAccessProfile(", "function appRoleAssignableInPersonnelModal(");
  assert.match(accessProfile, /\["developer", "it_admin"\]\.includes/);
  assert.match(accessProfile, /actorRole !== "it_admin" \|\| employee\?\.portal_access\?\.role !== "hr"/);
  const roleAssignment = between(app, "function appRoleAssignableInPersonnelModal(", "function permissionDisplayLabel(");
  assert.doesNotMatch(roleAssignment, /"hr"/);
  const governance = between(app, "function canReadGovernanceDashboards()", "function canReadSystemCenter()");
  assert.match(governance, /\["developer", "it_admin", "admin", "hr"\]\.includes/);
  assert.match(governance, /permissions\.includes\("rights:read"\)/);
});
