"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), crypto = require("node:crypto"), net = require("node:net"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { createAmuStorage } = require("../lib/amu-storage");
const { PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS } = require("../lib/personnel-lifecycle-interfaces-contract");
const { PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS } = require("../lib/personnel-lifecycle-automation-contract");
const { PERMISSION_IDS: PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS } = require("../lib/personnel-lifecycle-editor-contract");
const { PERSONNEL_LEARNING_PERMISSION_IDS } = require("../lib/personnel-learning-access");
const { databaseForCurrentTest, closeCurrentTestFixture } = require("../test-support/postgresql-api/preload");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-portal-pg-scope-"));
process.env.DB_PATH = path.join(testRoot, "lan-scope-isolation", "dienstplan.db");
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_DATA_DIR = path.join(path.dirname(process.env.DB_PATH), "app-data");
// Synthetic credential setup is independent of a parent application instance.
async function hashPortalPassword(password) {
  const salt = crypto.randomBytes(16);
  return ["scrypt-v1", salt.toString("base64url"), crypto.scryptSync(password, salt, 64).toString("base64url")].join("$");
}
test.after(async () => { await closeCurrentTestFixture(); fs.rmSync(testRoot, { recursive: true, force: true }); });

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForJson(url, child, timeoutMs = 30000, diagnostics = () => "") {
  const deadline = Date.now() + timeoutMs;
  let lastHttpStatus = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Serverprozess wurde vorzeitig mit Code ${child.exitCode} beendet. ${diagnostics().slice(-16384)}`);
    try {
      const response = await fetch(url);
      lastHttpStatus = response.status;
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server war nach ${timeoutMs} ms nicht erreichbar; letzter HTTP-Status: ${lastHttpStatus ?? "keine Antwort"}. ${diagnostics().slice(-16384)}`);
}

async function waitForExit(child, timeoutMs = 8000, diagnostics = () => "") {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Serverprozess wurde nach ${timeoutMs} ms nicht beendet. ${diagnostics().slice(-16384)}`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("LAN-Bereichsrechte trennen Filial- und Abteilungsdaten zuverlässig", async () => {
  const childRoot = path.join(testRoot, "lan-scope-isolation");
  fs.mkdirSync(childRoot, { recursive: true, mode: 0o700 });
  const childDatabase = path.join(childRoot, "dienstplan.db");
  const databasePath = childDatabase, backupPath = path.join(childRoot, "backups");
  const port = await getFreePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: childDatabase,
      BACKUP_DIR: path.join(childRoot, "backups"),
      GRABENPLANER_DATA_DIR: path.join(childRoot, "app-data"),
      GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_FORCE_PORTAL: "1",
      GRABENPLANER_SEED_DEMO: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;

  function sessionHeaders(response) {
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrfCookie = setCookies.map((value) => value.split(";", 1)[0]).find((value) => value.startsWith("grabenplaner_csrf="));
    return { cookie, csrf: decodeURIComponent(csrfCookie.split("=").slice(1).join("=")) };
  }

  async function login(employeeNumber, password) {
    const response = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber, password }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return sessionHeaders(response);
  }

  async function changePassword(session, currentPassword, newPassword) {
    const response = await fetch(`${url}/api/portal/v1/me/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: session.cookie, "X-CSRF-Token": session.csrf },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    Object.assign(session, sessionHeaders(response));
  }

  try {
    await waitForJson(`${url}/api/portal/v1/status`, child, 30000, () => stderr);
    const setup = await fetch(`${url}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: "LanAdminFixture-987654!" }),
    });
    assert.equal(setup.status, 201, await setup.clone().text());
    const admin = await login("101", "LanAdminFixture-987654!");

    const initialLocationsResponse = await fetch(`${url}/api/locations`, { headers: { Cookie: admin.cookie } });
    assert.equal(initialLocationsResponse.status, 200, await initialLocationsResponse.clone().text());
    const initialLocations = await initialLocationsResponse.json();
    const daySettings = initialLocations.find((location) => location.id === "01").day_settings;

    const secondLocationResponse = await fetch(`${url}/api/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ id: "02", name: "Zweiter Standort", minStaff: 1, daySettings, active: true }),
    });
    assert.equal(secondLocationResponse.status, 201, await secondLocationResponse.clone().text());

    const firstDepartmentResponse = await fetch(`${url}/api/departments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ locationId: "01", name: "Abteilung Eins", minStaff: 1, active: true }),
    });
    assert.equal(firstDepartmentResponse.status, 201, await firstDepartmentResponse.clone().text());
    const afterFirstDepartment = await firstDepartmentResponse.json();
    const firstDepartment = afterFirstDepartment.find((location) => location.id === "01").departments.find((department) => department.name === "Abteilung Eins");
    const secondDepartmentResponse = await fetch(`${url}/api/departments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ locationId: "01", name: "Abteilung Zwei", minStaff: 1, active: true }),
    });
    assert.equal(secondDepartmentResponse.status, 201, await secondDepartmentResponse.clone().text());
    const afterSecondDepartment = await secondDepartmentResponse.json();
    const secondDepartment = afterSecondDepartment.find((location) => location.id === "01").departments.find((department) => department.name === "Abteilung Zwei");
    assert.ok(firstDepartment?.id);
    assert.ok(secondDepartment?.id);

    for (const [employeeNumber, role, password] of [
      ["102", "employee", "ScopeEmployee-223344!"],
      ["103", "hr", "ScopePersonnel-334455!"],
      ["104", "manager", "ScopeManager-445566!"],
      ["105", "department_manager", "ScopeDepartment-556677!"],
    ]) {
      const accessResponse = await fetch(`${url}/api/portal/v1/users/${employeeNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
        body: JSON.stringify({ role, active: true, password, mustChangePassword: true }),
      });
      assert.equal(accessResponse.status, 200, await accessResponse.clone().text());
    }
    const fixtureDatabase = databaseForCurrentTest(childDatabase);
    try {
      fixtureDatabase.prepare(`
        INSERT INTO portal_users
          (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
        VALUES ('106', ?, 'it_admin', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(employee_number) DO UPDATE SET
          password_hash = excluded.password_hash, role = 'it_admin', active = 1,
          must_change_password = 1, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      `).run((() => {
        // Preserve a real pre-policy six-character hash to exercise legacy login/currentPassword.
        const salt = crypto.randomBytes(16);
        return ["scrypt-v1", salt.toString("base64url"), crypto.scryptSync("667788", salt, 64).toString("base64url")].join("$");
      })());
    } finally {
      fixtureDatabase.close();
    }

    const managerScopeResponse = await fetch(`${url}/api/portal/v1/users/104/scopes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ scopes: [{ locationId: "01" }] }),
    });
    assert.equal(managerScopeResponse.status, 200, await managerScopeResponse.clone().text());
    const departmentManagerScopeResponse = await fetch(`${url}/api/portal/v1/users/105/scopes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ scopes: [{ locationId: "01", departmentId: firstDepartment.id }] }),
    });
    assert.equal(departmentManagerScopeResponse.status, 200, await departmentManagerScopeResponse.clone().text());

    let manager = await login("104", "ScopeManager-445566!");
    await changePassword(manager, "ScopeManager-445566!", "ScopeManagerNew-665544!");
    const departmentManager = await login("105", "ScopeDepartment-556677!");
    await changePassword(departmentManager, "ScopeDepartment-556677!", "ScopeDepartmentNew-776655!");
    let employee = await login("102", "ScopeEmployee-223344!");
    await changePassword(employee, "ScopeEmployee-223344!", "ScopeEmployeeNew-554433!");
    let hr = await login("103", "ScopePersonnel-334455!");
    await changePassword(hr, "ScopePersonnel-334455!", "ScopePersonnelNew-887766!");
    const itAdmin = await login("106", "667788");
    await changePassword(itAdmin, "667788", "ScopeTechnicalNew-998877!");

    const managerRightsResponse = await fetch(`${url}/api/portal/v1/rights`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerRightsResponse.status, 200, await managerRightsResponse.clone().text());
    const managerRightsPayload = await managerRightsResponse.json();
    assert.ok(managerRightsPayload.users.some((user) => user.employeeNumber === "105" && user.manageable));
    assert.ok(managerRightsPayload.users.every((user) => (
      ["department_manager", "employee"].includes(user.role) && user.homeLocationId === "01"
    )));
    assert.ok(managerRightsPayload.catalog.length > 0);
    assert.ok(managerRightsPayload.catalog.every((permission) => permission.editable));
    assert.equal(managerRightsPayload.catalog.some((permission) => permission.scopeBehavior === "global"), false);
    assert.equal(managerRightsPayload.catalog.some((permission) => permission.id.startsWith("personnel:learning:")), false);
    const hrRightsResponse = await fetch(`${url}/api/portal/v1/rights`, { headers: { Cookie: hr.cookie } });
    assert.equal(hrRightsResponse.status, 200, await hrRightsResponse.clone().text());
    const rightsPayload = await hrRightsResponse.json();
    assert.equal(rightsPayload.catalog.some((permission) => permission.id === "operation_mode:write"), false);
    assert.ok(rightsPayload.catalog.some((permission) => permission.id === "employees:display:write" && permission.editable));
    assert.ok(rightsPayload.catalog.some((permission) => permission.id === "employees:write" && !permission.editable));
    assert.ok(rightsPayload.catalog.some((permission) => permission.id === "backup:write" && !permission.editable));
    assert.equal(rightsPayload.catalog.some((permission) => permission.id === "developer:system"), false);
    assert.ok(rightsPayload.users.some((user) => user.employeeNumber === "102" && user.role === "employee" && user.manageable));
    assert.ok(rightsPayload.users.some((user) => user.employeeNumber === "104" && user.role === "manager" && user.manageable));
    const managerRightsProfile = rightsPayload.users.find((user) => user.employeeNumber === "104");
    assert.equal(managerRightsProfile.rolePermissions.includes("amu:metadata:read"), false);
    assert.deepEqual(rightsPayload.catalog.find((permission) => permission.id === "amu:file:read").eligibleRoles,
      ["hr", "admin", "it_admin", "developer"]);
    assert.ok(rightsPayload.users.some((user) => user.employeeNumber === "103" && !user.manageable));
    const itAdminRights = await fetch(`${url}/api/portal/v1/rights`, { headers: { Cookie: itAdmin.cookie } });
    assert.equal(itAdminRights.status, 200, await itAdminRights.clone().text());
    const itAdminRightsPayload = await itAdminRights.json();
    const personnelLifecyclePermissionIds = new Set([
      "personnel:candidates:read",
      "personnel:applications:write",
      "personnel:candidates:create",
      "personnel:candidates:write",
      "personnel:candidates:confidential:read",
      "personnel:candidates:confidential:write",
      "personnel:candidates:convert",
      "personnel:candidates:delegate",
      "personnel:workflows:read",
      "personnel:workflows:draft:write",
      "personnel:workflows:review",
      "personnel:workflows:publish",
      "personnel:workflows:local:supplement",
      "personnel:workflows:confidential:read",
      "personnel:workflows:confidential:write",
      "personnel:workflows:delegate",
      "personnel:profiles:read",
      "personnel:profiles:master:read",
      "personnel:profiles:documents:read",
      "personnel:profiles:delegate",
      "personnel:lifecycle:onboarding:read",
      "personnel:lifecycle:onboarding:prepare",
      "personnel:lifecycle:onboarding:approve",
      "personnel:lifecycle:onboarding:execute",
      "personnel:lifecycle:onboarding:close",
      "personnel:lifecycle:offboarding:confidential:read",
      "personnel:lifecycle:offboarding:prepare",
      "personnel:lifecycle:offboarding:communication:release",
      "personnel:lifecycle:offboarding:information:confirm",
      "personnel:lifecycle:offboarding:execute",
      "personnel:lifecycle:offboarding:close",
      "personnel:lifecycle:personal:read",
      "personnel:lifecycle:hr-confidential:read",
      "personnel:lifecycle:packages:read",
      "personnel:lifecycle:packages:write",
      "personnel:lifecycle:packages:publish",
      "personnel:lifecycle:assignments:write",
      "personnel:lifecycle:exceptions:approve",
      "personnel:lifecycle:operational:read",
      "personnel:lifecycle:operational:update",
      "personnel:lifecycle:audit:read",
      "personnel:lifecycle:audit:confidential:read",
      "personnel:lifecycle:delegate",
      ...PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS,
      ...PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS,
      ...PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS,
      ...PERSONNEL_LEARNING_PERMISSION_IDS,
    ]);
    assert.ok(itAdminRightsPayload.catalog
      .filter((permission) => !personnelLifecyclePermissionIds.has(permission.id))
      .every((permission) => permission.editable));
    assert.ok(itAdminRightsPayload.catalog
      .filter((permission) => personnelLifecyclePermissionIds.has(permission.id))
      .every((permission) => !permission.editable));
    assert.deepEqual(
      new Set(itAdminRightsPayload.catalog
        .filter((permission) => !permission.editable)
        .map((permission) => permission.id)),
      new Set([...personnelLifecyclePermissionIds].filter(
        (permission) => !PERSONNEL_LEARNING_PERMISSION_IDS.includes(permission),
      )),
    );
    for (const permissionId of [
      "personnel:lifecycle:onboarding:read",
      "personnel:lifecycle:packages:read",
    ]) {
      const permission = rightsPayload.catalog.find((entry) => entry.id === permissionId);
      assert.deepEqual(permission.eligibleRoles, ["hr", "admin", "it_admin", "developer"]);
      assert.equal(permission.editable, false);
    }
    assert.ok(itAdminRightsPayload.users.some((user) => user.employeeNumber === "102" && user.manageable));
    const diagnosticsReadPermission = itAdminRightsPayload.catalog.find((permission) => permission.id === "system:diagnostics:read");
    const diagnosticsTechnicalPermission = itAdminRightsPayload.catalog.find((permission) => permission.id === "system:diagnostics:technical");
    assert.deepEqual(diagnosticsReadPermission.eligibleRoles, ["hr", "admin", "it_admin", "developer"]);
    assert.deepEqual(diagnosticsTechnicalPermission.eligibleRoles, ["hr", "admin", "it_admin", "developer"]);
    assert.equal(rightsPayload.catalog.find((permission) => permission.id === "system:diagnostics:read").editable, false);

    const hrStatusDenied = await fetch(`${url}/api/server-status`, { headers: { Cookie: hr.cookie } });
    assert.equal(hrStatusDenied.status, 403, await hrStatusDenied.clone().text());
    const hrDiagnosticsDenied = await fetch(`${url}/api/server-diagnostics`, { headers: { Cookie: hr.cookie } });
    assert.equal(hrDiagnosticsDenied.status, 403, await hrDiagnosticsDenied.clone().text());

    const grantHrStatusReadAsItAdmin = await fetch(`${url}/api/portal/v1/rights/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({ permissions: ["system:diagnostics:read"] }),
    });
    assert.equal(grantHrStatusReadAsItAdmin.status, 403, await grantHrStatusReadAsItAdmin.clone().text());
    assert.equal((await grantHrStatusReadAsItAdmin.json()).code, "PORTAL_ROLE_HIERARCHY_DENIED");
    const hrStatusStillDenied = await fetch(`${url}/api/server-status`, { headers: { Cookie: hr.cookie } });
    assert.equal(hrStatusStillDenied.status, 403, await hrStatusStillDenied.clone().text());

    const grantHrStatusRead = await fetch(`${url}/api/portal/v1/rights/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ permissions: ["system:diagnostics:read"] }),
    });
    assert.equal(grantHrStatusRead.status, 200, await grantHrStatusRead.clone().text());
    hr = await login("103", "ScopePersonnelNew-887766!");
    const delegatedHrStatus = await fetch(`${url}/api/server-status`, { headers: { Cookie: hr.cookie } });
    assert.equal(delegatedHrStatus.status, 200, await delegatedHrStatus.clone().text());
    const delegatedHrTechnicalDenied = await fetch(`${url}/api/server-diagnostics`, { headers: { Cookie: hr.cookie } });
    assert.equal(delegatedHrTechnicalDenied.status, 403, await delegatedHrTechnicalDenied.clone().text());
    const clearHrStatusRead = await fetch(`${url}/api/portal/v1/rights/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ permissions: [] }),
    });
    assert.equal(clearHrStatusRead.status, 200, await clearHrStatusRead.clone().text());
    hr = await login("103", "ScopePersonnelNew-887766!");

    const itAdminStatusResponse = await fetch(`${url}/api/server-status`, { headers: { Cookie: itAdmin.cookie } });
    assert.equal(itAdminStatusResponse.status, 200, await itAdminStatusResponse.clone().text());
    const itAdminStatus = await itAdminStatusResponse.json();
    assert.deepEqual(Object.keys(itAdminStatus.live), ["ok"]);
    assert.deepEqual(Object.keys(itAdminStatus.ready), ["ok"]);
    assert.ok(Array.isArray(itAdminStatus.alerts));
    const redactedStatusJson = JSON.stringify(itAdminStatus);
    for (const forbidden of [testRoot, databasePath, backupPath, "dataRoot", "appDirectory", "externalDirectory", "rootDirectory", "keyId", "pid"]) {
      assert.equal(redactedStatusJson.includes(forbidden), false, forbidden);
    }
    const itAdminDiagnosticsResponse = await fetch(`${url}/api/server-diagnostics`, { headers: { Cookie: itAdmin.cookie } });
    assert.equal(itAdminDiagnosticsResponse.status, 200, await itAdminDiagnosticsResponse.clone().text());
    assert.equal(typeof (await itAdminDiagnosticsResponse.json()).process.pid, "number");
    const itAdminBackupSettings = await fetch(`${url}/api/backup/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({ externalBackupEnabled: true, backupDirectory: backupPath, backupIntervalHours: 2 }),
    });
    assert.equal(itAdminBackupSettings.status, 409, await itAdminBackupSettings.clone().text());
    assert.equal((await itAdminBackupSettings.json()).code, "SERVER_MANAGED_BACKUP");
    const hrBackupSettingsDenied = await fetch(`${url}/api/backup/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ externalBackupEnabled: true, backupDirectory: backupPath, backupIntervalHours: 2 }),
    });
    assert.equal(hrBackupSettingsDenied.status, 403, await hrBackupSettingsDenied.clone().text());

    const grantEmployeeTechnicalRights = await fetch(`${url}/api/portal/v1/rights/102`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({
        grantedPermissions: ["schedule:read", "branding:read", "branding:write", "employees:write", "hr:approve", "backup:write", "update:write", "system:write"],
        deniedPermissions: [],
        scopes: [{ locationId: "01", departmentId: firstDepartment.id }],
      }),
    });
    assert.equal(grantEmployeeTechnicalRights.status, 200, await grantEmployeeTechnicalRights.clone().text());
    const employeeWithTechnicalRights = (await grantEmployeeTechnicalRights.json()).users.find((user) => user.employeeNumber === "102");
    assert.deepEqual(employeeWithTechnicalRights.grantedPermissions, ["backup:write", "branding:read", "branding:write", "employees:write", "hr:approve", "schedule:read", "system:write", "update:write"]);
    employee = await login("102", "ScopeEmployeeNew-554433!");
    const employeeSessionWithGrants = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: employee.cookie } });
    assert.equal(employeeSessionWithGrants.status, 200, await employeeSessionWithGrants.clone().text());
    const employeeEffectivePermissions = (await employeeSessionWithGrants.json()).user.permissions;
    for (const permission of ["employees:write", "hr:approve", "backup:write", "update:write", "system:write"]) {
      assert.ok(employeeEffectivePermissions.includes(permission), `${permission} fehlt in ${employeeEffectivePermissions.join(", ")}`);
    }
    const employeeSystemInfo = await fetch(`${url}/api/system-info`, { headers: { Cookie: employee.cookie } });
    assert.equal(employeeSystemInfo.status, 200, await employeeSystemInfo.clone().text());
    const employeeSystemInfoData = await employeeSystemInfo.json();
    assert.equal(employeeSystemInfoData.runtimeDrive, null);
    assert.equal(employeeSystemInfoData.serverStatus, null);
    assert.equal(employeeSystemInfoData.serverDiagnostics, null);
    const employeeStatusDenied = await fetch(`${url}/api/server-status`, { headers: { Cookie: employee.cookie } });
    assert.equal(employeeStatusDenied.status, 403, await employeeStatusDenied.clone().text());
    const employeeDiagnosticsDenied = await fetch(`${url}/api/server-diagnostics`, { headers: { Cookie: employee.cookie } });
    assert.equal(employeeDiagnosticsDenied.status, 403, await employeeDiagnosticsDenied.clone().text());
    const employeeBrandingAccess = await fetch(`${url}/api/branding/assignments`, { headers: { Cookie: employee.cookie, "X-CSRF-Token": employee.csrf } });
    assert.equal(employeeBrandingAccess.status, 200, await employeeBrandingAccess.clone().text());

    const itAdminCannotTakeOverHr = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({ role: "employee", active: true }),
    });
    assert.equal(itAdminCannotTakeOverHr.status, 403, await itAdminCannotTakeOverHr.clone().text());
    assert.equal((await itAdminCannotTakeOverHr.json()).code, "PERSONNEL_LIFECYCLE_ACCOUNT_TAKEOVER_DENIED");
    const hrStillActiveAfterDeniedTakeover = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: hr.cookie } });
    assert.equal(hrStillActiveAfterDeniedTakeover.status, 200, await hrStillActiveAfterDeniedTakeover.clone().text());
    assert.equal((await hrStillActiveAfterDeniedTakeover.json()).user.role, "hr");

    const adminCanManageHr = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "employee", active: true }),
    });
    assert.equal(adminCanManageHr.status, 200, await adminCanManageHr.clone().text());
    assert.equal((await adminCanManageHr.json()).users.find((user) => user.employeeNumber === "103").role, "employee");
    const restoreHrByAdmin = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "hr", active: true }),
    });
    assert.equal(restoreHrByAdmin.status, 200, await restoreHrByAdmin.clone().text());
    hr = await login("103", "ScopePersonnelNew-887766!");
    const developerRoleCannotBeAssigned = await fetch(`${url}/api/portal/v1/users/106`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "developer", active: true }),
    });
    assert.equal(developerRoleCannotBeAssigned.status, 403, await developerRoleCannotBeAssigned.clone().text());
    assert.equal((await developerRoleCannotBeAssigned.json()).code, "PORTAL_DEVELOPER_PROTECTED");
    const hrCannotTargetItself = await fetch(`${url}/api/portal/v1/rights/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ permissions: [] }),
    });
    assert.equal(hrCannotTargetItself.status, 403, await hrCannotTargetItself.clone().text());

    const invalidGrant = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ permissions: ["branding:write"] }),
    });
    assert.equal(invalidGrant.status, 403, await invalidGrant.clone().text());
    assert.equal((await invalidGrant.json()).code, "PORTAL_PERMISSION_NOT_DELEGABLE");

    const grantManagerRights = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ permissions: ["employees:display:write", "departments:write"] }),
    });
    assert.equal(grantManagerRights.status, 200, await grantManagerRights.clone().text());
    const managerWithHrRights = (await grantManagerRights.json()).users.find((user) => user.employeeNumber === "104");
    assert.deepEqual(managerWithHrRights.grantedPermissions, ["departments:write", "employees:display:write"]);

    const grantManagerTechnicalRights = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: itAdmin.cookie, "X-CSRF-Token": itAdmin.csrf },
      body: JSON.stringify({ permissions: ["employees:display:write", "locations:write", "departments:write"] }),
    });
    assert.equal(grantManagerTechnicalRights.status, 200, await grantManagerTechnicalRights.clone().text());
    const grantedManager = (await grantManagerTechnicalRights.json()).users.find((user) => user.employeeNumber === "104");
    assert.deepEqual(grantedManager.grantedPermissions, ["departments:write", "employees:display:write", "locations:write"]);

    manager = await login("104", "ScopeManagerNew-665544!");
    const managerSessionWithGrant = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerSessionWithGrant.status, 200, await managerSessionWithGrant.clone().text());
    const managerSessionPermissions = (await managerSessionWithGrant.json()).user.permissions;
    assert.ok(managerSessionPermissions.includes("employees:display:write"));
    assert.equal(managerSessionPermissions.includes("operation_mode:write"), false);

    const scopedEmployeesResponse = await fetch(`${url}/api/employees`, { headers: { Cookie: manager.cookie } });
    assert.equal(scopedEmployeesResponse.status, 200, await scopedEmployeesResponse.clone().text());
    const scopedEmployees = await scopedEmployeesResponse.json();
    const ownEmployee = scopedEmployees.find((employee) => employee.personnel_number === "104");
    const ownEmployeeUpdatePayload = {
      fullName: ownEmployee.full_name,
      nickname: "Dana R",
      color: ownEmployee.color,
      contractedHours: ownEmployee.contracted_hours,
      preferredDayOff: ownEmployee.preferred_day_off || "",
      fixedWorkdays: ownEmployee.fixed_workdays || "",
      positionId: ownEmployee.position_id,
      homeLocationId: ownEmployee.home_location_id,
      preferredDepartmentId: ownEmployee.preferred_department_id || "",
      active: ownEmployee.active,
    };
    const ownEmployeeUpdate = await fetch(`${url}/api/employees/104/display`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ color: "#123abc", fullName: "Manipulationsversuch", contractedHours: 0 }),
    });
    assert.equal(ownEmployeeUpdate.status, 200, await ownEmployeeUpdate.clone().text());
    const afterDisplayUpdate = await fetch(`${url}/api/employees`, { headers: { Cookie: manager.cookie } }).then((response) => response.json());
    const protectedEmployee = afterDisplayUpdate.find((employee) => employee.personnel_number === "104");
    assert.equal(protectedEmployee.color, "#123abc");
    assert.equal(protectedEmployee.full_name, ownEmployee.full_name);
    assert.equal(protectedEmployee.contracted_hours, ownEmployee.contracted_hours);
    const fullEmployeeUpdateDenied = await fetch(`${url}/api/employees/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify(ownEmployeeUpdatePayload),
    });
    assert.equal(fullEmployeeUpdateDenied.status, 403, await fullEmployeeUpdateDenied.clone().text());

    const moveOutsideScope = await fetch(`${url}/api/employees/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ ...ownEmployeeUpdatePayload, homeLocationId: "02", preferredDepartmentId: "" }),
    });
    assert.equal(moveOutsideScope.status, 403, await moveOutsideScope.clone().text());
    const createRemoteEmployee = await fetch(`${url}/api/employees`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        personnelNumber: "107", fullName: "Gina Remote", nickname: "Gina", color: "#225588",
        contractedHours: 20, preferredDayOff: "", fixedWorkdays: "", positionId: "verkaufsmitarbeiter",
        homeLocationId: "02", preferredDepartmentId: "", active: true,
      }),
    });
    assert.equal(createRemoteEmployee.status, 201, await createRemoteEmployee.clone().text());
    const remoteEmployeeUpdate = await fetch(`${url}/api/employees/107`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({
        fullName: "Gina Remote", nickname: "Unzulässig", color: "#225588", contractedHours: 20,
        preferredDayOff: "", fixedWorkdays: "", positionId: "verkaufsmitarbeiter",
        homeLocationId: "02", preferredDepartmentId: "", active: true,
      }),
    });
    assert.equal(remoteEmployeeUpdate.status, 403, await remoteEmployeeUpdate.clone().text());

    const updateOwnLocation = await fetch(`${url}/api/locations/01`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({
        id: "01", name: "Hauptstandort intern", minStaff: initialLocations.find((location) => location.id === "01").min_staff,
        daySettings, timeTrackingEnabled: false, active: true,
      }),
    });
    assert.equal(updateOwnLocation.status, 200, await updateOwnLocation.clone().text());
    const updateRemoteLocation = await fetch(`${url}/api/locations/02`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ id: "02", name: "Unzulässige Änderung", minStaff: 1, daySettings, timeTrackingEnabled: false, active: true }),
    });
    assert.equal(updateRemoteLocation.status, 403, await updateRemoteLocation.clone().text());
    const createDelegatedLocation = await fetch(`${url}/api/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ id: "03", name: "Delegiert angelegt", minStaff: 1, daySettings, timeTrackingEnabled: false, active: true }),
    });
    assert.equal(createDelegatedLocation.status, 403, await createDelegatedLocation.clone().text());
    assert.equal((await createDelegatedLocation.json()).code, "PORTAL_PERMISSION_DENIED");
    const createLocationAsAdmin = await fetch(`${url}/api/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ id: "03", name: "Administrativ angelegt", minStaff: 1, daySettings, timeTrackingEnabled: false, active: true }),
    });
    assert.equal(createLocationAsAdmin.status, 201, await createLocationAsAdmin.clone().text());
    const createdLocation = (await createLocationAsAdmin.json()).find((location) => location.id === "03");
    assert.ok(createdLocation);
    assert.ok(createdLocation.cost_center_id);
    const updateDelegatedLocation = await fetch(`${url}/api/locations/03`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ id: "03", name: "Delegiert gespeichert", minStaff: 2, daySettings, timeTrackingEnabled: false, active: true }),
    });
    assert.equal(updateDelegatedLocation.status, 403, await updateDelegatedLocation.clone().text());

    const remoteDepartmentResponse = await fetch(`${url}/api/departments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ locationId: "02", name: "Remote-Abteilung", minStaff: 1, active: true }),
    });
    assert.equal(remoteDepartmentResponse.status, 201, await remoteDepartmentResponse.clone().text());
    const remoteDepartment = (await remoteDepartmentResponse.json()).find((location) => location.id === "02").departments[0];
    const updateOwnDepartment = await fetch(`${url}/api/departments/${firstDepartment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ locationId: "01", name: "Abteilung Eins intern", minStaff: 1, active: true }),
    });
    assert.equal(updateOwnDepartment.status, 200, await updateOwnDepartment.clone().text());
    const updateRemoteDepartment = await fetch(`${url}/api/departments/${remoteDepartment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ locationId: "02", name: "Remote manipuliert", minStaff: 1, active: true }),
    });
    assert.equal(updateRemoteDepartment.status, 403, await updateRemoteDepartment.clone().text());

    const revokeManagerRights = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ permissions: [] }),
    });
    assert.equal(revokeManagerRights.status, 200, await revokeManagerRights.clone().text());
    manager = await login("104", "ScopeManagerNew-665544!");
    const updateAfterRevoke = await fetch(`${url}/api/employees/104/display`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ color: "#654321" }),
    });
    assert.equal(updateAfterRevoke.status, 403, await updateAfterRevoke.clone().text());
    const managerSessionAfterRevoke = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerSessionAfterRevoke.status, 200, await managerSessionAfterRevoke.clone().text());
    const permissionsAfterHrRevoke = (await managerSessionAfterRevoke.json()).user.permissions;
    assert.equal(permissionsAfterHrRevoke.includes("employees:display:write"), false);
    assert.ok(permissionsAfterHrRevoke.includes("locations:write"));
    assert.equal(permissionsAfterHrRevoke.includes("operation_mode:write"), false);

    const managerBrandingDenied = await fetch(`${url}/api/branding/assignments`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerBrandingDenied.status, 403, await managerBrandingDenied.clone().text());
    const managerSystemInfo = await fetch(`${url}/api/system-info`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerSystemInfo.status, 200, await managerSystemInfo.clone().text());
    const managerSystemInfoData = await managerSystemInfo.json();
    assert.equal(managerSystemInfoData.serverDiagnostics, null);
    assert.equal(managerSystemInfoData.runtimeDrive, null);
    assert.equal(managerSystemInfoData.appBackupDirectory, "");
    const assignFirstBranding = await fetch(`${url}/api/branding/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        locationId: "01", kitId: "custom",
        branding: { companyName: "Filiale Eins", logoUrl: "/assets/one.svg", iconUrl: "/assets/one-icon.svg", logoAlt: "Eins", adminEmail: "eins@example.test" },
      }),
    });
    assert.equal(assignFirstBranding.status, 200, await assignFirstBranding.clone().text());
    const assignSecondBranding = await fetch(`${url}/api/branding/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({
        locationId: "02", kitId: "custom",
        branding: { companyName: "Filiale Zwei", logoUrl: "/assets/two.svg", iconUrl: "/assets/two-icon.svg", logoAlt: "Zwei", adminEmail: "zwei@example.test" },
      }),
    });
    assert.equal(assignSecondBranding.status, 200, await assignSecondBranding.clone().text());
    const brandingAssignmentsResponse = await fetch(`${url}/api/branding/assignments`, { headers: { Cookie: hr.cookie } });
    assert.equal(brandingAssignmentsResponse.status, 200, await brandingAssignmentsResponse.clone().text());
    const brandingAssignments = (await brandingAssignmentsResponse.json()).assignments;
    assert.equal(brandingAssignments.find((assignment) => assignment.locationId === "01").branding.companyName, "Filiale Eins");
    assert.equal(brandingAssignments.find((assignment) => assignment.locationId === "02").branding.companyName, "Filiale Zwei");
    const firstBrandSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=01`, { headers: { Cookie: admin.cookie } });
    const secondBrandSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=02`, { headers: { Cookie: admin.cookie } });
    assert.equal(firstBrandSchedule.status, 200, await firstBrandSchedule.clone().text());
    assert.equal(secondBrandSchedule.status, 200, await secondBrandSchedule.clone().text());
    assert.equal((await firstBrandSchedule.json()).settings.branding_company_name, "Filiale Eins");
    assert.equal((await secondBrandSchedule.json()).settings.branding_company_name, "Filiale Zwei");
    const brandedManagerSession = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: manager.cookie } });
    assert.equal(brandedManagerSession.status, 200, await brandedManagerSession.clone().text());
    assert.equal((await brandedManagerSession.json()).status.branding.companyName, "Filiale Eins");

    const managementPreferenceResponse = await fetch(`${url}/api/branding/preference`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({
        kitId: "custom",
        branding: { companyName: "Zentrale Leitung", logoUrl: "/assets/central.svg", iconUrl: "/assets/central-icon.svg", logoAlt: "Zentrale", adminEmail: "leitung@example.test" },
      }),
    });
    assert.equal(managementPreferenceResponse.status, 200, await managementPreferenceResponse.clone().text());
    assert.equal((await managementPreferenceResponse.json()).branding.companyName, "Zentrale Leitung");
    const hrBrandedSession = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: hr.cookie } });
    assert.equal(hrBrandedSession.status, 200, await hrBrandedSession.clone().text());
    assert.equal((await hrBrandedSession.json()).status.branding.companyName, "Zentrale Leitung");
    const managerSessionAfterPreference = await fetch(`${url}/api/portal/v1/session`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerSessionAfterPreference.status, 200, await managerSessionAfterPreference.clone().text());
    assert.equal((await managerSessionAfterPreference.json()).status.branding.companyName, "Filiale Eins");
    const unassignedLocationSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=03`, { headers: { Cookie: admin.cookie } });
    assert.equal(unassignedLocationSchedule.status, 200, await unassignedLocationSchedule.clone().text());
    assert.equal((await unassignedLocationSchedule.json()).settings.branding_company_name, "");

    for (const [employeeNumber, expectedCompany] of [["104", "Filiale Eins"], ["103", "Zentrale Leitung"], ["999999", "Zentrale Leitung"]]) {
      const loginBranding = await fetch(`${url}/api/portal/v1/auth/branding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeNumber }),
      });
      assert.equal(loginBranding.status, 200, await loginBranding.clone().text());
      assert.equal((await loginBranding.json()).branding.companyName, expectedCompany);
    }

    const disposableKitImport = await fetch(`${url}/api/branding/import`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf, "X-Branding-Filename": "disposable.json" },
      body: JSON.stringify({
        locationId: "02",
        kit: {
          name: "Loeschbares Test-Branding",
          branding: { companyName: "Test Kit", logoUrl: "/assets/test.svg", iconUrl: "/assets/test-icon.svg", logoAlt: "Test", adminEmail: "test@example.test" },
        },
      }),
    });
    assert.equal(disposableKitImport.status, 200, await disposableKitImport.clone().text());
    const disposableKit = (await disposableKitImport.json()).kit;
    assert.ok(disposableKit.id);
    const selectDisposablePreference = await fetch(`${url}/api/branding/preference`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ kitId: disposableKit.id }),
    });
    assert.equal(selectDisposablePreference.status, 200, await selectDisposablePreference.clone().text());
    const deleteUsedKit = await fetch(`${url}/api/branding/kits/${encodeURIComponent(disposableKit.id)}`, {
      method: "DELETE",
      headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
    });
    assert.equal(deleteUsedKit.status, 409, await deleteUsedKit.clone().text());
    assert.equal((await deleteUsedKit.json()).code, "BRANDING_KIT_IN_USE");

    const batchAssignments = await fetch(`${url}/api/branding/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ assignments: [
        { locationId: "01", kitId: "custom", branding: { companyName: "Stapel Eins", logoUrl: "/assets/batch-one.svg", iconUrl: "/assets/batch-one-icon.svg", logoAlt: "Eins", adminEmail: "eins@example.test" } },
        { locationId: "02", kitId: "custom", branding: { companyName: "Stapel Zwei", logoUrl: "/assets/batch-two.svg", iconUrl: "/assets/batch-two-icon.svg", logoAlt: "Zwei", adminEmail: "zwei@example.test" } },
      ] }),
    });
    assert.equal(batchAssignments.status, 200, await batchAssignments.clone().text());
    const batchAssignmentData = await batchAssignments.json();
    assert.equal(batchAssignmentData.assignments.find((assignment) => assignment.locationId === "01").branding.companyName, "Stapel Eins");
    assert.equal(batchAssignmentData.assignments.find((assignment) => assignment.locationId === "02").branding.companyName, "Stapel Zwei");
    const restoreManagementPreference = await fetch(`${url}/api/branding/preference`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        kitId: "custom",
        branding: { companyName: "Zentrale Leitung", logoUrl: "/assets/central.svg", iconUrl: "/assets/central-icon.svg", logoAlt: "Zentrale", adminEmail: "leitung@example.test" },
      }),
    });
    assert.equal(restoreManagementPreference.status, 200, await restoreManagementPreference.clone().text());
    const deleteUnusedKit = await fetch(`${url}/api/branding/kits/${encodeURIComponent(disposableKit.id)}`, {
      method: "DELETE",
      headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
    });
    assert.equal(deleteUnusedKit.status, 200, await deleteUnusedKit.clone().text());
    assert.equal((await deleteUnusedKit.json()).deleted.id, disposableKit.id);

    const resetFirstBranding = await fetch(`${url}/api/branding/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ locationId: "01", kitId: "" }),
    });
    assert.equal(resetFirstBranding.status, 200, await resetFirstBranding.clone().text());
    const resetFirstBrandingData = await resetFirstBranding.json();
    const resetFirstAssignment = resetFirstBrandingData.assignments.find((assignment) => assignment.locationId === "01");
    assert.equal(resetFirstAssignment.assigned, false);
    assert.notEqual(resetFirstAssignment.branding.companyName, "Filiale Eins");

    const scopedAmuDatabase = databaseForCurrentTest(childDatabase);
    scopedAmuDatabase.prepare("UPDATE employees SET preferred_department_id = ? WHERE personnel_number = '104'").run(firstDepartment.id);
    const scopedAmuStorage = createAmuStorage({
      rootDirectory: path.join(childRoot, "app-data", "private", "amu"),
      encryptionKeys: { "local-v1": fs.readFileSync(path.join(childRoot, "app-data", "private", "amu-local.key"), "utf8").trim() },
      activeKeyId: "local-v1",
      scanner: async () => true,
    });
    const insertScopedAmu = scopedAmuDatabase.prepare(`
      INSERT INTO amu_reports
        (employee_number, location_id, department_id, incapacity_from, incapacity_to, employee_note, review_note, status, protected_payload)
      VALUES (?, ?, ?, '', '', '', '', 'submitted', '')
    `);
    const updateScopedAmu = scopedAmuDatabase.prepare("UPDATE amu_reports SET protected_payload = ? WHERE id = ?");
    function insertProtectedScopedAmu(locationId, from, to) {
      const id = Number(insertScopedAmu.run("104", locationId, null).lastInsertRowid);
      const protectedPayload = scopedAmuStorage.protectRecord(JSON.stringify({
        incapacityFrom: from, incapacityTo: to, employeeNote: "Interne Notiz", reviewedBy: "101",
        reviewedAt: "2027-06-30T10:00:00.000Z", reviewNote: "Leitungsnotiz", retentionUntil: "2029-07-04", withdrawnAt: "",
      }), { namespace: "personnel-record", recordId: String(id), field: "payload", employeeNumber: "104" });
      updateScopedAmu.run(protectedPayload, id);
      return id;
    }
    const localAmuId = insertProtectedScopedAmu("01", "2027-07-01", "2027-07-02");
    const remoteAmuId = insertProtectedScopedAmu("02", "2027-07-03", "2027-07-04");
    scopedAmuDatabase.close();

    const managerPersonnelRecord = await fetch(`${url}/api/portal/v1/personnel-records/104`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerPersonnelRecord.status, 200, await managerPersonnelRecord.clone().text());
    const managerPersonnelPayload = await managerPersonnelRecord.json();
    assert.equal(managerPersonnelPayload.profile.phone, "");
    assert.deepEqual(managerPersonnelPayload.profile.sensitive, { privateEmail: "" });
    assert.deepEqual(managerPersonnelPayload.reports.map((report) => Number(report.id)), [localAmuId]);
    assert.equal(managerPersonnelPayload.reports.some((report) => Number(report.id) === remoteAmuId), false);
    assert.equal(Object.hasOwn(managerPersonnelPayload.reports[0], "identity_check"), false);
    assert.equal(Object.hasOwn(managerPersonnelPayload.reports[0], "automatic_review"), false);
    assert.equal(managerPersonnelPayload.access.canReadPhone, true);
    assert.equal(managerPersonnelPayload.access.canReadAmu, true);
    assert.equal(managerPersonnelPayload.access.canOpenFiles, true);

    const managerAmuOverview = await fetch(`${url}/api/portal/v1/amu-reports`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerAmuOverview.status, 200, await managerAmuOverview.clone().text());
    const managerAmuOverviewPayload = await managerAmuOverview.json();
    assert.deepEqual(managerAmuOverviewPayload.reports.map((report) => Number(report.id)), [localAmuId]);
    assert.equal(managerAmuOverviewPayload.access.mode, "local_manager");

    const departmentManagerLegacyAmu = await fetch(`${url}/api/portal/v1/amu-reports`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(departmentManagerLegacyAmu.status, 200, await departmentManagerLegacyAmu.clone().text());
    assert.deepEqual((await departmentManagerLegacyAmu.json()).reports, []);
    const departmentManagerLegacyRecord = await fetch(`${url}/api/portal/v1/personnel-records/104`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(departmentManagerLegacyRecord.status, 200, await departmentManagerLegacyRecord.clone().text());
    const departmentManagerLegacyPayload = await departmentManagerLegacyRecord.json();
    assert.equal(departmentManagerLegacyPayload.profile.phone, null);
    assert.deepEqual(departmentManagerLegacyPayload.profile.sensitive, { privateEmail: "" });
    assert.deepEqual(departmentManagerLegacyPayload.documents, []);
    assert.deepEqual(departmentManagerLegacyPayload.reports, []);
    assert.equal(departmentManagerLegacyPayload.access.canReadPhone, false);
    assert.equal(departmentManagerLegacyPayload.access.canReadAmu, false);
    assert.equal(departmentManagerLegacyPayload.access.canOpenFiles, false);

    const obsoleteManagerAmuSetting = await fetch(`${url}/api/portal/v1/amu-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ uploadMaxMb: 10, storedMaxMb: 2, convertImagesToPdf: true, grayscaleImages: true, managerFileAccess: true }),
    });
    assert.equal(obsoleteManagerAmuSetting.status, 200, await obsoleteManagerAmuSetting.clone().text());
    assert.equal(Object.hasOwn((await obsoleteManagerAmuSetting.json()).policy, "managerFileAccess"), false);
    const managerAmuStillScoped = await fetch(`${url}/api/portal/v1/amu-reports`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerAmuStillScoped.status, 200, await managerAmuStillScoped.clone().text());
    assert.deepEqual((await managerAmuStillScoped.json()).reports.map((report) => Number(report.id)), [localAmuId]);

    const protectedRightCannotBeDelegated = await fetch(`${url}/api/portal/v1/rights/104`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ permissions: ["amu:file:read"] }),
    });
    assert.equal(protectedRightCannotBeDelegated.status, 403, await protectedRightCannotBeDelegated.clone().text());
    assert.equal((await protectedRightCannotBeDelegated.json()).code, "AMU_PERMISSION_ROLE_RESTRICTED");

    const remoteBlackoutResponse = await fetch(`${url}/api/portal/v1/request-blackouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        locationId: "02", dateFrom: "2027-12-01", dateTo: "2027-12-24",
        blockVacation: true, blockTimeOff: true, reason: "Nur Standort Zwei", active: true,
      }),
    });
    assert.equal(remoteBlackoutResponse.status, 201, await remoteBlackoutResponse.clone().text());
    const remoteBlackout = (await remoteBlackoutResponse.json()).blackouts.find((item) => item.reason === "Nur Standort Zwei");
    assert.ok(remoteBlackout?.id);

    const managerRemoteSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=02`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerRemoteSchedule.status, 403, await managerRemoteSchedule.clone().text());
    const managerRemoteScheduleDelete = await fetch(`${url}/api/schedule?week=2027-08-02&location=02`, {
      method: "DELETE", headers: { Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
    });
    assert.equal(managerRemoteScheduleDelete.status, 403, await managerRemoteScheduleDelete.clone().text());

    const managerBlackoutsResponse = await fetch(`${url}/api/portal/v1/request-blackouts`, { headers: { Cookie: manager.cookie } });
    assert.equal(managerBlackoutsResponse.status, 200, await managerBlackoutsResponse.clone().text());
    assert.equal((await managerBlackoutsResponse.json()).blackouts.some((item) => item.locationId === "02"), false);
    const managerRemoteBlackoutCreate = await fetch(`${url}/api/portal/v1/request-blackouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ locationId: "02", dateFrom: "2028-01-02", dateTo: "2028-01-03", blockVacation: true, reason: "Verbotener Eintrag" }),
    });
    assert.equal(managerRemoteBlackoutCreate.status, 403, await managerRemoteBlackoutCreate.clone().text());
    const managerRemoteBlackoutUpdate = await fetch(`${url}/api/portal/v1/request-blackouts/${remoteBlackout.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
      body: JSON.stringify({ locationId: "02", dateFrom: "2027-12-01", dateTo: "2027-12-24", blockVacation: true, blockTimeOff: true, reason: "Manipuliert" }),
    });
    assert.equal(managerRemoteBlackoutUpdate.status, 403, await managerRemoteBlackoutUpdate.clone().text());
    const managerRemoteBlackoutDelete = await fetch(`${url}/api/portal/v1/request-blackouts/${remoteBlackout.id}`, {
      method: "DELETE", headers: { Cookie: manager.cookie, "X-CSRF-Token": manager.csrf },
    });
    assert.equal(managerRemoteBlackoutDelete.status, 403, await managerRemoteBlackoutDelete.clone().text());

    const departmentSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=01&department=${firstDepartment.id}`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(departmentSchedule.status, 200, await departmentSchedule.clone().text());
    const broadDepartmentSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=01`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(broadDepartmentSchedule.status, 403, await broadDepartmentSchedule.clone().text());
    const otherDepartmentSchedule = await fetch(`${url}/api/schedule?week=2027-08-02&location=01&department=${secondDepartment.id}`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(otherDepartmentSchedule.status, 403, await otherDepartmentSchedule.clone().text());

    const departmentVacations = await fetch(`${url}/api/vacations?year=2027&location=01&department=${firstDepartment.id}`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(departmentVacations.status, 200, await departmentVacations.clone().text());
    const broadDepartmentVacations = await fetch(`${url}/api/vacations?year=2027&location=01`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(broadDepartmentVacations.status, 403, await broadDepartmentVacations.clone().text());
    const otherDepartmentVacations = await fetch(`${url}/api/vacations?year=2027&location=01&department=${secondDepartment.id}`, { headers: { Cookie: departmentManager.cookie } });
    assert.equal(otherDepartmentVacations.status, 403, await otherDepartmentVacations.clone().text());

    const remoteBlackoutStillExists = await fetch(`${url}/api/portal/v1/request-blackouts`, { headers: { Cookie: admin.cookie } });
    assert.equal(remoteBlackoutStillExists.status, 200, await remoteBlackoutStillExists.clone().text());
    assert.ok((await remoteBlackoutStillExists.json()).blackouts.some((item) => item.id === remoteBlackout.id && item.reason === "Nur Standort Zwei"));

    const exitResponse = await fetch(`${url}/api/system/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: "{}",
    });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    assert.equal((await waitForExit(child, 8000, () => stderr)).code, 0, stderr);
  } finally {
    if (child.exitCode === null) { child.kill(); await waitForExit(child, 8000, () => stderr); }
  }
});
