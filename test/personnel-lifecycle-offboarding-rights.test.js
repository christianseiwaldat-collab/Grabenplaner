"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8").replace(/\r\n/g, "\n");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8").replace(/\r\n/g, "\n");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Startmarker fehlt: ${start}`);
  assert.notEqual(endIndex, -1, `Endmarker fehlt: ${end}`);
  return source.slice(startIndex, endIndex);
}

const offboardingPermissions = Object.freeze([
  "OFFBOARDING_CONFIDENTIAL_READ",
  "OFFBOARDING_PREPARE",
  "OFFBOARDING_COMMUNICATION_RELEASE",
  "OFFBOARDING_INFORMATION_CONFIRM",
  "OFFBOARDING_EXECUTE",
  "OFFBOARDING_CLOSE",
]);

test("O5 registriert alle vertraulichen Fachrechte ohne automatische Rollenvergabe", () => {
  const catalog = between(
    server,
    "const delegablePortalPermissionCatalog",
    "const delegablePortalPermissions",
  );
  for (const permission of [
    ...offboardingPermissions,
    "PERSONAL_RESTRICTED_READ",
    "HR_CONFIDENTIAL_READ",
    "AUDIT_READ",
    "CONFIDENTIAL_AUDIT_READ",
    "DELEGATE",
  ]) {
    assert.match(catalog, new RegExp(`PERSONNEL_LIFECYCLE_CASE_PERMISSIONS\\.${permission}`));
  }
  const lifecycleSet = between(
    server,
    "const personnelLifecyclePermissionIds",
    "const protectedAmuPermissionIds",
  );
  assert.match(lifecycleSet, /\.\.\.PERSONNEL_LIFECYCLE_CASE_PERMISSION_IDS/);
  const builtins = between(server, "const builtinPortalRoles", "function addBuiltinRolePermissions");
  assert.doesNotMatch(builtins, /personnel:lifecycle:offboarding:/);
});

test("O5-Rechteabhängigkeiten bleiben in Server und Rechteeditor fail-closed", () => {
  const serverDependencies = between(
    server,
    "function assertPortalPermissionDependencies",
    "const portalDashboardPermissionDetails",
  );
  for (const permission of offboardingPermissions.slice(1)) {
    assert.match(serverDependencies, new RegExp(`PERSONNEL_LIFECYCLE_CASE_PERMISSIONS\\.${permission}`));
  }
  assert.match(serverDependencies, /OFFBOARDING_CONFIDENTIAL_READ/);
  assert.match(serverDependencies, /PACKAGES_WRITE[\s\S]*PACKAGES_READ/);
  assert.match(serverDependencies, /PACKAGES_PUBLISH[\s\S]*PACKAGES_WRITE/);
  assert.match(serverDependencies, /OPERATIONAL_UPDATE[\s\S]*OPERATIONAL_READ/);
  assert.match(serverDependencies, /CONFIDENTIAL_AUDIT_READ[\s\S]*AUDIT_READ/);

  const uiDependencies = between(
    app,
    "const permissionDependencyRules",
    "async function loadPortalUsers",
  );
  for (const permission of [
    "personnel:lifecycle:offboarding:prepare",
    "personnel:lifecycle:offboarding:communication:release",
    "personnel:lifecycle:offboarding:information:confirm",
    "personnel:lifecycle:offboarding:execute",
    "personnel:lifecycle:offboarding:close",
  ]) assert.match(uiDependencies, new RegExp(permission.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Nur operative Lifecycle-Rechte sind organisatorisch delegierbar", () => {
  const serverScoped = between(
    server,
    "const PERSONNEL_LIFECYCLE_SCOPED_DELEGABLE_PERMISSIONS",
    "function publicPortalPermissionScopeGrant",
  );
  assert.match(serverScoped, /PERSONNEL_LIFECYCLE_CASE_PERMISSIONS\.OPERATIONAL_READ/);
  assert.match(serverScoped, /PERSONNEL_LIFECYCLE_CASE_PERMISSIONS\.OPERATIONAL_UPDATE/);
  assert.doesNotMatch(serverScoped, /OFFBOARDING_/);

  const uiScoped = between(
    app,
    "const rightsEditorOrganizationalPermissionIds",
    "function selectedRightsEditorUser",
  );
  assert.match(uiScoped, /personnel:lifecycle:operational:read/);
  assert.match(uiScoped, /personnel:lifecycle:operational:update/);
  assert.doesNotMatch(uiScoped, /personnel:lifecycle:offboarding:/);
});
