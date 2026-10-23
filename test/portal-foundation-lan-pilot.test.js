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
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-portal-pg-lan-pilot-"));
process.env.DB_PATH = path.join(testRoot, "lan-pilot", "dienstplan.db");
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_DATA_DIR = path.join(path.dirname(process.env.DB_PATH), "app-data");
// Synthetic credential setup is independent of a parent application instance.
async function hashPortalPassword(password) {
  const salt = crypto.randomBytes(16);
  return ["scrypt-v1", salt.toString("base64url"), crypto.scryptSync(password, salt, 64).toString("base64url")].join("$");
}
test.after(() => { closeCurrentTestFixture(); fs.rmSync(testRoot, { recursive: true, force: true }); });

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

async function waitForJson(url, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastHttpStatus = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Serverprozess wurde vorzeitig mit Code ${child.exitCode} beendet.`);
    try {
      const response = await fetch(url);
      lastHttpStatus = response.status;
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server war nach ${timeoutMs} ms nicht erreichbar; letzter HTTP-Status: ${lastHttpStatus ?? "keine Antwort"}.`);
}

async function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Serverprozess wurde nach ${timeoutMs} ms nicht beendet.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("LAN-Pilot: Admin, Mitarbeiter-Login und Urlaubsfreigabe funktionieren durchgängig", async () => {
  const childRoot = path.join(testRoot, "lan-pilot");
  fs.mkdirSync(childRoot, { recursive: true });
  const childDatabase = path.join(childRoot, "dienstplan.db");
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
      GRABENPLANER_TEST_AMU_SCANNER: "clean",
      GRABENPLANER_TEST_TODAY: "2027-01-01",
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

  try {
    const status = await waitForJson(`${url}/api/portal/v1/status`, child);
    assert.equal(status.portalEnabled, true);

    const setup = await fetch(`${url}/api/portal/v1/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: "LanAdminFixture-987654!" }),
    });
    assert.equal(setup.status, 201, await setup.clone().text());

    const adminLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "101", password: "LanAdminFixture-987654!" }),
    });
    assert.equal(adminLogin.status, 200, await adminLogin.clone().text());
    const admin = sessionHeaders(adminLogin);

    // Branding-ZIP-Dateien werden in der portablen Windows-App bewusst mit
    // PowerShell gepackt. Codespaces prüft die plattformneutralen Portalabläufe;
    // der ZIP-Roundtrip bleibt Teil der vollständigen Windows-Testsuite.
    if (process.platform === "win32") {
      const brandingExport = await fetch(`${url}/api/branding/export.zip?locationId=01`, { headers: { Cookie: admin.cookie } });
      assert.equal(brandingExport.status, 200, await brandingExport.clone().text());
      const brandingImport = await fetch(`${url}/api/branding/import.zip?locationId=01`, {
        method: "PUT",
        headers: { "Content-Type": "application/zip", "X-Branding-Filename": "roundtrip.zip", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
        body: await brandingExport.arrayBuffer(),
      });
      assert.equal(brandingImport.status, 200, await brandingImport.clone().text());
      for (const fileName of ["fokus-und-licht-branding-kit.zip", "berg-und-ball-branding-kit.zip"]) {
        const kitPath = path.join(__dirname, "..", "demo", "branding-kits", fileName);
        const demoImport = await fetch(`${url}/api/branding/import.zip?locationId=01`, {
          method: "PUT",
          headers: { "Content-Type": "application/zip", "X-Branding-Filename": fileName, Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
          body: fs.readFileSync(kitPath),
        });
        assert.equal(demoImport.status, 200, `${fileName}: ${await demoImport.clone().text()}`);
      }
    }

    const createEmployeeAccess = await fetch(`${url}/api/portal/v1/users/102`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "employee", active: true, password: "LanStartFixture-654321!", mustChangePassword: true }),
    });
    assert.equal(createEmployeeAccess.status, 200, await createEmployeeAccess.clone().text());

    const employeeLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "102", password: "LanStartFixture-654321!" }),
    });
    assert.equal(employeeLogin.status, 200, await employeeLogin.clone().text());
    const employee = sessionHeaders(employeeLogin);

    const passwordChange = await fetch(`${url}/api/portal/v1/me/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ currentPassword: "LanStartFixture-654321!", newPassword: "LanChangedFixture-123456!" }),
    });
    assert.equal(passwordChange.status, 200, await passwordChange.clone().text());
    Object.assign(employee, sessionHeaders(passwordChange));

    const locationsResponse = await fetch(`${url}/api/locations`, { headers: { Cookie: admin.cookie } });
    assert.equal(locationsResponse.status, 200, await locationsResponse.clone().text());
    const location = (await locationsResponse.json()).find((item) => item.id === "01");
    const enableTimeTracking = await fetch(`${url}/api/locations/01`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        id: location.id, name: location.name, minStaff: location.min_staff, active: location.active,
        daySettings: location.day_settings, timeTrackingEnabled: true,
      }),
    });
    assert.equal(enableTimeTracking.status, 200, await enableTimeTracking.clone().text());
    const initialTimeStatus = await fetch(`${url}/api/portal/v1/me/time-entries`, { headers: { Cookie: employee.cookie } });
    assert.equal(initialTimeStatus.status, 200, await initialTimeStatus.clone().text());
    assert.equal((await initialTimeStatus.json()).status.trackingEnabled, true);
    const clockIn = await fetch(`${url}/api/portal/v1/me/time-entries`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ type: "clock_in" }),
    });
    assert.equal(clockIn.status, 201, await clockIn.clone().text());
    assert.equal((await clockIn.json()).status.state, "working");
    const duplicateClockIn = await fetch(`${url}/api/portal/v1/me/time-entries`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ type: "clock_in" }),
    });
    assert.equal(duplicateClockIn.status, 409, await duplicateClockIn.clone().text());
    const clockOut = await fetch(`${url}/api/portal/v1/me/time-entries`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ type: "clock_out" }),
    });
    assert.equal(clockOut.status, 201, await clockOut.clone().text());
    assert.equal((await clockOut.json()).status.state, "off");
    const presenceResponse = await fetch(`${url}/api/portal/v1/time-presence?locationId=01`, { headers: { Cookie: admin.cookie } });
    assert.equal(presenceResponse.status, 200, await presenceResponse.clone().text());
    assert.ok((await presenceResponse.json()).presence.employees.some((item) => item.employeeNumber === "102"));

    const createManagerAccess = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "manager", active: true, password: "LanLeadFixture-112233!", mustChangePassword: true }),
    });
    assert.equal(createManagerAccess.status, 200, await createManagerAccess.clone().text());
    const assignManagerScope = await fetch(`${url}/api/portal/v1/users/103/scopes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ scopes: [{ locationId: "01" }] }),
    });
    assert.equal(assignManagerScope.status, 200, await assignManagerScope.clone().text());
    const scopedUsers = await assignManagerScope.json();
    assert.deepEqual(scopedUsers.users.find((item) => item.employeeNumber === "103").scopes, [{ locationId: "01", departmentId: null }]);

    const createHrAccess = await fetch(`${url}/api/portal/v1/users/103`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ role: "hr", active: true, password: "LanLeadFixture-112233!", mustChangePassword: true }),
    });
    assert.equal(createHrAccess.status, 200, await createHrAccess.clone().text());
    const hrLogin = await fetch(`${url}/api/portal/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeNumber: "103", password: "LanLeadFixture-112233!" }),
    });
    assert.equal(hrLogin.status, 200, await hrLogin.clone().text());
    const hr = sessionHeaders(hrLogin);
    const hrPasswordChange = await fetch(`${url}/api/portal/v1/me/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ currentPassword: "LanLeadFixture-112233!", newPassword: "LanLeadChanged-332211!" }),
    });
    assert.equal(hrPasswordChange.status, 200, await hrPasswordChange.clone().text());
    Object.assign(hr, sessionHeaders(hrPasswordChange));
    const saturdaySlotsResponse = await fetch(`${url}/api/portal/v1/me/time-off-slots?date=2027-03-13`, { headers: { Cookie: employee.cookie } });
    assert.equal(saturdaySlotsResponse.status, 200, await saturdaySlotsResponse.clone().text());
    const saturdaySlots = await saturdaySlotsResponse.json();
    assert.equal(saturdaySlots.startTimes[0], "10:00");
    assert.equal(saturdaySlots.endTimes.at(-1), "17:00");

    const blackoutResponse = await fetch(`${url}/api/portal/v1/request-blackouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({
        locationId: "01",
        dateFrom: "2027-12-01",
        dateTo: "2027-12-24",
        blockVacation: true,
        blockTimeOff: false,
        reason: "Weihnachtsgeschäft",
      }),
    });
    assert.equal(blackoutResponse.status, 201, await blackoutResponse.clone().text());

    const blockedVacationCheck = await fetch(`${url}/api/portal/v1/me/vacation-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-12-06", dateTo: "2027-12-10" }),
    });
    assert.equal(blockedVacationCheck.status, 200, await blockedVacationCheck.clone().text());
    const blockedVacation = await blockedVacationCheck.json();
    assert.equal(blockedVacation.trafficLight, "red");
    assert.match(blockedVacation.reason, /Weihnachtsgeschäft/);

    const allowedTimeOffCheck = await fetch(`${url}/api/portal/v1/me/time-off-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ date: "2027-12-10", startTime: "11:00", endTime: "14:00" }),
    });
    assert.equal(allowedTimeOffCheck.status, 200, await allowedTimeOffCheck.clone().text());
    const allowedTimeOff = await allowedTimeOffCheck.json();
    assert.equal(allowedTimeOff.trafficLight, "yellow");
    assert.equal(allowedTimeOff.allowed, true);

    const multiDayTimeOffResponse = await fetch(`${url}/api/portal/v1/me/time-off-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-11-08", dateTo: "2027-11-09", allDay: true, note: "Zwei Tage ZA" }),
    });
    assert.equal(multiDayTimeOffResponse.status, 201, await multiDayTimeOffResponse.clone().text());
    const multiDayTimeOff = await multiDayTimeOffResponse.json();
    const editMultiDayTimeOff = await fetch(`${url}/api/portal/v1/me/time-off-requests/${multiDayTimeOff.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-11-10", dateTo: "2027-11-12", allDay: true, note: "Drei Tage ZA" }),
    });
    assert.equal(editMultiDayTimeOff.status, 200, await editMultiDayTimeOff.clone().text());
    const ownTimeOffResponse = await fetch(`${url}/api/portal/v1/me/time-off-requests`, { headers: { Cookie: employee.cookie } });
    const ownTimeOff = await ownTimeOffResponse.json();
    const editedMultiDay = ownTimeOff.requests.find((item) => item.id === multiDayTimeOff.id);
    assert.equal(editedMultiDay.date_from, "2027-11-10");
    assert.equal(editedMultiDay.date_to, "2027-11-12");
    assert.equal(Boolean(editedMultiDay.all_day), true);
    const approveMultiDayTimeOff = await fetch(`${url}/api/portal/v1/absence-requests/time_off/${multiDayTimeOff.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "approve", note: "Mehrtagestest" }),
    });
    assert.equal(approveMultiDayTimeOff.status, 200, await approveMultiDayTimeOff.clone().text());
    assert.equal((await approveMultiDayTimeOff.json()).request.status, "approved");
    const approvedMultiDayResponse = await fetch(`${url}/api/portal/v1/me/approved-time-off`, { headers: { Cookie: employee.cookie } });
    assert.equal(approvedMultiDayResponse.status, 200, await approvedMultiDayResponse.clone().text());
    const approvedMultiDay = (await approvedMultiDayResponse.json()).requests.find((item) => item.id === multiDayTimeOff.id);
    assert.equal(approvedMultiDay.date_from, "2027-11-10");
    assert.equal(approvedMultiDay.date_to, "2027-11-12");
    assert.equal(Boolean(approvedMultiDay.all_day), true);

    const multiDayChangeResponse = await fetch(`${url}/api/portal/v1/me/time-off-change-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ requestId: multiDayTimeOff.id, requestType: "change", dateFrom: "2027-11-15", dateTo: "2027-11-16", allDay: true, note: "Termin verschieben" }),
    });
    assert.equal(multiDayChangeResponse.status, 201, await multiDayChangeResponse.clone().text());
    const multiDayChange = await multiDayChangeResponse.json();
    const approveMultiDayChange = await fetch(`${url}/api/portal/v1/absence-requests/time_off_change/${multiDayChange.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "approve", note: "Verschiebung genehmigt" }),
    });
    assert.equal(approveMultiDayChange.status, 200, await approveMultiDayChange.clone().text());
    assert.equal((await approveMultiDayChange.json()).request.status, "approved");
    const changedApprovedResponse = await fetch(`${url}/api/portal/v1/me/approved-time-off`, { headers: { Cookie: employee.cookie } });
    const changedApproved = (await changedApprovedResponse.json()).requests.find((item) => item.id === multiDayTimeOff.id);
    assert.equal(changedApproved.date_from, "2027-11-15");
    assert.equal(changedApproved.date_to, "2027-11-16");

    const requestResponse = await fetch(`${url}/api/portal/v1/me/vacation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-02-08", dateTo: "2027-02-12", note: "Testurlaub" }),
    });
    assert.equal(requestResponse.status, 201, await requestResponse.clone().text());
    const vacationRequest = await requestResponse.json();

    const decisionResponse = await fetch(`${url}/api/portal/v1/vacation-requests/${vacationRequest.id}/decision`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(decisionResponse.status, 200, await decisionResponse.clone().text());
    const decision = await decisionResponse.json();
    assert.equal(decision.status, "approved");
    assert.match(decision.vacationGroupId, /^vac-/);

    const approvedVacationsResponse = await fetch(`${url}/api/portal/v1/me/approved-vacations`, {
      headers: { Cookie: employee.cookie },
    });
    assert.equal(approvedVacationsResponse.status, 200, await approvedVacationsResponse.clone().text());
    const approvedVacations = await approvedVacationsResponse.json();
    assert.ok(approvedVacations.vacations.some((item) => item.groupId === decision.vacationGroupId));

    const changeRequestResponse = await fetch(`${url}/api/portal/v1/me/vacation-change-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({
        groupId: decision.vacationGroupId,
        requestType: "change",
        dateFrom: "2027-02-15",
        dateTo: "2027-02-19",
        note: "Terminverschiebung",
      }),
    });
    assert.equal(changeRequestResponse.status, 201, await changeRequestResponse.clone().text());
    const changeRequest = await changeRequestResponse.json();

    const changeDecisionResponse = await fetch(`${url}/api/portal/v1/vacation-change-requests/${changeRequest.id}/decision`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(changeDecisionResponse.status, 200, await changeDecisionResponse.clone().text());

    for (const employeeNumber of ["101", "102", "103"]) {
      const shiftResponse = await fetch(`${url}/api/shifts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
        body: JSON.stringify({ employeeNumber, date: "2027-03-08", startTime: "09:00", endTime: "18:00" }),
      });
      assert.equal(shiftResponse.status, 201, await shiftResponse.clone().text());
    }

    const greenTimeOffCheckResponse = await fetch(`${url}/api/portal/v1/me/time-off-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ date: "2027-03-08", startTime: "11:00", endTime: "14:00" }),
    });
    assert.equal(greenTimeOffCheckResponse.status, 200, await greenTimeOffCheckResponse.clone().text());
    const greenTimeOffCheck = await greenTimeOffCheckResponse.json();
    assert.equal(greenTimeOffCheck.trafficLight, "green", greenTimeOffCheck.reason);

    const timeOffRequestResponse = await fetch(`${url}/api/portal/v1/me/time-off-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ date: "2027-03-08", startTime: "11:00", endTime: "14:00", note: "Privater Termin" }),
    });
    assert.equal(timeOffRequestResponse.status, 201, await timeOffRequestResponse.clone().text());
    const timeOffRequest = await timeOffRequestResponse.json();

    const openAbsencesResponse = await fetch(`${url}/api/portal/v1/absence-requests`, {
      headers: { Cookie: admin.cookie },
    });
    assert.equal(openAbsencesResponse.status, 200, await openAbsencesResponse.clone().text());
    const openAbsences = await openAbsencesResponse.json();
    assert.ok(openAbsences.requests.some((item) => item.kind === "time_off" && item.id === timeOffRequest.id));

    const timeOffDecisionResponse = await fetch(`${url}/api/portal/v1/time-off-requests/${timeOffRequest.id}/decision`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(timeOffDecisionResponse.status, 200, await timeOffDecisionResponse.clone().text());

    const workflowSettings = await fetch(`${url}/api/portal/v1/workflow-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ vacationHrApprovalRequired: true }),
    });
    assert.equal(workflowSettings.status, 200, await workflowSettings.clone().text());

    const twoStageVacationResponse = await fetch(`${url}/api/portal/v1/me/vacation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-05-03", dateTo: "2027-05-07", note: "Zweistufig" }),
    });
    assert.equal(twoStageVacationResponse.status, 201, await twoStageVacationResponse.clone().text());
    const twoStageVacation = await twoStageVacationResponse.json();
    const forbiddenHrFirstApproval = await fetch(`${url}/api/portal/v1/absence-requests/vacation/${twoStageVacation.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(forbiddenHrFirstApproval.status, 403, await forbiddenHrFirstApproval.clone().text());
    const localVacationApproval = await fetch(`${url}/api/portal/v1/absence-requests/vacation/${twoStageVacation.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "approve", note: "Filiale einverstanden" }),
    });
    assert.equal(localVacationApproval.status, 200, await localVacationApproval.clone().text());
    assert.equal((await localVacationApproval.json()).request.status, "pending_hr");
    const hrVacationApproval = await fetch(`${url}/api/portal/v1/absence-requests/vacation/${twoStageVacation.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ action: "approve", note: "PL genehmigt" }),
    });
    assert.equal(hrVacationApproval.status, 200, await hrVacationApproval.clone().text());
    assert.equal((await hrVacationApproval.json()).request.status, "approved");

    const plTimeOffResponse = await fetch(`${url}/api/portal/v1/me/time-off-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ date: "2027-03-10", startTime: "11:00", endTime: "14:00", approvalType: "hr", note: "Verbindlich" }),
    });
    assert.equal(plTimeOffResponse.status, 201, await plTimeOffResponse.clone().text());
    const plTimeOff = await plTimeOffResponse.json();
    const localPlTimeOffApproval = await fetch(`${url}/api/portal/v1/absence-requests/time_off/${plTimeOff.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(localPlTimeOffApproval.status, 200, await localPlTimeOffApproval.clone().text());
    assert.equal((await localPlTimeOffApproval.json()).request.status, "pending_hr");
    const hrPlTimeOffApproval = await fetch(`${url}/api/portal/v1/absence-requests/time_off/${plTimeOff.id}/action`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: hr.cookie, "X-CSRF-Token": hr.csrf },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(hrPlTimeOffApproval.status, 200, await hrPlTimeOffApproval.clone().text());
    assert.equal((await hrPlTimeOffApproval.json()).request.status, "approved");

    const withdrawnVacationResponse = await fetch(`${url}/api/portal/v1/me/vacation-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
      body: JSON.stringify({ dateFrom: "2027-06-07", dateTo: "2027-06-11", note: "Wird zurückgezogen" }),
    });
    assert.equal(withdrawnVacationResponse.status, 201, await withdrawnVacationResponse.clone().text());
    const withdrawnVacation = await withdrawnVacationResponse.json();
    const withdrawResponse = await fetch(`${url}/api/portal/v1/me/vacation-requests/${withdrawnVacation.id}`, {
      method: "DELETE", headers: { Cookie: employee.cookie, "X-CSRF-Token": employee.csrf },
    });
    assert.equal(withdrawResponse.status, 204, await withdrawResponse.clone().text());
    const historyResponse = await fetch(`${url}/api/portal/v1/me/absence-history`, { headers: { Cookie: employee.cookie } });
    assert.equal(historyResponse.status, 200, await historyResponse.clone().text());
    const history = await historyResponse.json();
    const withdrawnHistory = history.items.find((item) => item.kind === "vacation" && item.id === withdrawnVacation.id);
    assert.equal(withdrawnHistory.status, "withdrawn");
    assert.ok(withdrawnHistory.decisions.some((item) => item.action === "withdraw"));

    const amuForm = new FormData();
    amuForm.append("incapacityFrom", "2027-03-11");
    amuForm.append("incapacityTo", "2027-03-13");
    amuForm.append("employeeNote", "Arbeitsunfähig");
    const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    amuForm.append("documents", new Blob([onePixelPng], { type: "image/png" }), "amu-test.png");
    const amuUploadResponse = await fetch(`${url}/api/portal/v1/me/amu-reports`, {
      method: "POST", headers: { Cookie: employee.cookie, "X-CSRF-Token": employee.csrf }, body: amuForm,
    });
    assert.equal(amuUploadResponse.status, 201, await amuUploadResponse.clone().text());
    const amuUpload = await amuUploadResponse.json();
    assert.equal(amuUpload.report.status, "submitted");
    assert.equal(amuUpload.report.employee_note, "Arbeitsunfähig");
    assert.equal(amuUpload.report.documents.length, 1);
    const amuDocument = amuUpload.report.documents[0];

    const ownAmuContent = await fetch(`${url}/api/portal/v1/me/amu-reports/${amuUpload.report.id}/documents/${amuDocument.id}/content`, { headers: { Cookie: employee.cookie } });
    assert.equal(ownAmuContent.status, 200, await ownAmuContent.clone().text());
    assert.equal(amuDocument.detected_mime, "application/pdf");
    assert.match(amuDocument.original_filename, /\.pdf$/i);
    assert.equal(Buffer.from(await ownAmuContent.arrayBuffer()).subarray(0, 5).toString("ascii"), "%PDF-");

    const amuSettingsResponse = await fetch(`${url}/api/portal/v1/amu-settings`, { headers: { Cookie: admin.cookie } });
    assert.equal(amuSettingsResponse.status, 200, await amuSettingsResponse.clone().text());
    assert.equal((await amuSettingsResponse.json()).policy.convertImagesToPdf, true);
    const updateAmuSettings = await fetch(`${url}/api/portal/v1/amu-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ uploadMaxMb: 8, storedMaxMb: 2, convertImagesToPdf: true, grayscaleImages: true }),
    });
    assert.equal(updateAmuSettings.status, 200, await updateAmuSettings.clone().text());
    const personnelRecord = await fetch(`${url}/api/portal/v1/personnel-records/102`, { headers: { Cookie: admin.cookie } });
    assert.equal(personnelRecord.status, 200, await personnelRecord.clone().text());
    const personnelRecordData = await personnelRecord.json();
    assert.equal(personnelRecordData.canOpenFiles, true);
    assert.ok(personnelRecordData.reports.some((report) => report.id === amuUpload.report.id));
    const adminAmuContent = await fetch(`${url}/api/portal/v1/amu-reports/${amuUpload.report.id}/documents/${amuDocument.id}/content`, { headers: { Cookie: admin.cookie } });
    assert.equal(adminAmuContent.status, 200, await adminAmuContent.clone().text());
    const auditDatabase = databaseForCurrentTest(childDatabase);
    assert.ok(auditDatabase.prepare("SELECT 1 FROM audit_log WHERE actor = '101' AND action = 'amu.document.download' AND entity_id = ?").get(amuDocument.id));
    auditDatabase.close();

    const adminAmuResponse = await fetch(`${url}/api/portal/v1/amu-reports`, { headers: { Cookie: admin.cookie } });
    assert.equal(adminAmuResponse.status, 200, await adminAmuResponse.clone().text());
    assert.equal((await adminAmuResponse.json()).pendingCount, 1);
    const reviewAmuResponse = await fetch(`${url}/api/portal/v1/amu-reports/${amuUpload.report.id}/review`, {
      method: "PUT", headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: JSON.stringify({ action: "reviewed", note: "Geprüft" }),
    });
    assert.equal(reviewAmuResponse.status, 200, await reviewAmuResponse.clone().text());
    assert.equal((await reviewAmuResponse.json()).report.status, "reviewed");

    const employeeNotificationsResponse = await fetch(`${url}/api/portal/v1/me/notifications`, { headers: { Cookie: employee.cookie } });
    assert.equal(employeeNotificationsResponse.status, 200, await employeeNotificationsResponse.clone().text());
    const employeeNotifications = await employeeNotificationsResponse.json();
    const protectedUpdate = employeeNotifications.notifications.find((item) => item.event_type === "protected.update");
    assert.ok(protectedUpdate);
    assert.equal(protectedUpdate.title, "Geschützte Meldung aktualisiert");
    assert.equal(protectedUpdate.message, "Bitte im geschützten Portal anmelden.");
    assert.doesNotMatch(JSON.stringify(protectedUpdate), /Arbeitsunf|krank|AUM|Geprüft/i);

    const encryptedBlobs = fs.readdirSync(path.join(childRoot, "app-data", "private", "amu", "blobs"), { recursive: true })
      .filter((name) => String(name).endsWith(".amu"));
    assert.equal(encryptedBlobs.length, 1);
    const encryptedContent = fs.readFileSync(path.join(childRoot, "app-data", "private", "amu", "blobs", encryptedBlobs[0]));
    assert.equal(encryptedContent.includes(onePixelPng.subarray(0, 8)), false);

    const exitResponse = await fetch(`${url}/api/system/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf },
      body: "{}",
    });
    assert.equal(exitResponse.status, 200, await exitResponse.clone().text());
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, stderr);
    // PostgreSQL shutdown never emits a misleading standalone SQLite backup.
    // Native paired dump/restore integrity is exercised by the dedicated Linux
    // paired-backup and recovery suites; this test retains the application data
    // assertions against the actual PostgreSQL fixture after the child exits.
    assert.equal(fs.existsSync(childDatabase), false);
    const backupRoot = path.join(childRoot, "backups");
    const backups = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [];
    assert.equal(backups.some(name => /^dienstplan-.*\.db$/.test(name)), false);

    const verified = databaseForCurrentTest(childDatabase);
    const storedRequest = verified.prepare("SELECT status, vacation_group_id FROM vacation_requests WHERE id = ?").get(vacationRequest.id);
    assert.equal(storedRequest.status, "approved");
    assert.match(storedRequest.vacation_group_id, /^vac-/);
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM week_options WHERE group_id = ? AND option_type = 'vacation'").get(storedRequest.vacation_group_id).count, 1);
    const storedVacation = verified.prepare("SELECT date_from, date_to FROM week_options WHERE group_id = ? AND option_type = 'vacation'").get(storedRequest.vacation_group_id);
    assert.equal(storedVacation.date_from, "2027-02-15");
    assert.equal(storedVacation.date_to, "2027-02-19");
    const storedTimeOff = verified.prepare("SELECT status, option_id FROM time_off_requests WHERE id = ?").get(timeOffRequest.id);
    assert.equal(storedTimeOff.status, "approved");
    assert.ok(storedTimeOff.option_id);
    const storedAmu = verified.prepare("SELECT incapacity_from, incapacity_to, employee_note, review_note, protected_payload FROM amu_reports WHERE id = ?").get(amuUpload.report.id);
    const storedAmuDocument = verified.prepare("SELECT original_filename, detected_mime, byte_size, sha256, uploaded_by, protected_payload FROM amu_documents WHERE report_id = ?").get(amuUpload.report.id);
    assert.equal(storedAmu.incapacity_from, "");
    assert.equal(storedAmu.incapacity_to, "");
    assert.equal(storedAmu.employee_note, "");
    assert.equal(storedAmu.review_note, "");
    assert.match(storedAmu.protected_payload, /^enc:v2:/);
    assert.equal(storedAmuDocument.original_filename, "");
    assert.equal(storedAmuDocument.detected_mime, "application/octet-stream");
    assert.equal(storedAmuDocument.byte_size, 0);
    assert.equal(storedAmuDocument.sha256, "");
    assert.equal(storedAmuDocument.uploaded_by, "");
    assert.match(storedAmuDocument.protected_payload, /^enc:v2:/);
    const storedPlTimeOff = verified.prepare("SELECT status, approval_type, local_approved_by, hr_approved_by FROM time_off_requests WHERE id = ?").get(plTimeOff.id);
    assert.equal(storedPlTimeOff.status, "approved");
    assert.equal(storedPlTimeOff.approval_type, "hr");
    assert.equal(storedPlTimeOff.local_approved_by, "101");
    assert.equal(storedPlTimeOff.hr_approved_by, "103");
    assert.ok(verified.prepare("SELECT COUNT(*) AS count FROM request_decisions WHERE request_kind = 'vacation' AND request_id = ?").get(twoStageVacation.id).count >= 2);
    assert.deepEqual(verified.prepare("SELECT start_time, end_time FROM shifts WHERE employee_number = '102' AND shift_date = '2027-03-08' ORDER BY start_time").all().map((row) => ({ ...row })), [
      { start_time: "09:00", end_time: "11:00" },
      { start_time: "14:00", end_time: "18:00" },
    ]);
    verified.close();
  } finally {
    if (child.exitCode === null) { child.kill(); await waitForExit(child); }
  }
});
