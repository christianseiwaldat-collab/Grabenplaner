const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const repositoryRoot = path.resolve(__dirname, "..");

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

async function waitForJson(url, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Serverprozess wurde vorzeitig mit Code ${child.exitCode} beendet.`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server war nach ${timeoutMs} ms nicht erreichbar.`);
}

async function waitForExit(child, timeoutMs = 8_000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Serverprozess wurde nach ${timeoutMs} ms nicht beendet.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function sessionHeaders(response) {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrfCookie = setCookies
    .map((value) => value.split(";", 1)[0])
    .find((value) => value.startsWith("grabenplaner_csrf="));
  assert.ok(cookie, "Anmeldung muss ein Session-Cookie setzen.");
  assert.ok(csrfCookie, "Anmeldung muss ein CSRF-Cookie setzen.");
  return { cookie, csrf: decodeURIComponent(csrfCookie.split("=").slice(1).join("=")) };
}

async function requestJson(baseUrl, route, { method = "GET", session = null, body, csrf = true } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && csrf && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  if (response.status !== 204) {
    const text = await response.text();
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  }
  return { response, payload };
}

function correctionFrom(payload) {
  return payload?.correction || payload;
}

function correctionsFrom(payload) {
  return payload?.corrections || [];
}

function summaryFrom(payload) {
  return payload?.summary || payload;
}

test("v0.53: Zeitübersichten und Korrekturen bleiben authentifiziert, bereichssicher und revisionsfähig", async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v053-time-"));
  const databasePath = path.join(testRoot, "dienstplan.db");
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(repositoryRoot, "server.js")], {
    cwd: repositoryRoot,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      BACKUP_DIR: path.join(testRoot, "backups"),
      GRABENPLANER_DATA_DIR: path.join(testRoot, "app-data"),
      GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_FORCE_PORTAL: "1",
      GRABENPLANER_SEED_DEMO: "1",
      GRABENPLANER_TEST_AMU_SCANNER: "clean",
      NODE_ENV: "test",
      TZ: "Europe/Vienna",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let admin = null;
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  async function login(employeeNumber, password) {
    const { response, payload } = await requestJson(baseUrl, "/api/portal/v1/auth/login", {
      method: "POST",
      body: { employeeNumber, password },
    });
    assert.equal(response.status, 200, JSON.stringify(payload));
    return sessionHeaders(response);
  }

  async function changePassword(session, currentPassword, newPassword) {
    const { response, payload } = await requestJson(baseUrl, "/api/portal/v1/me/password", {
      method: "PUT",
      session,
      body: { currentPassword, newPassword },
    });
    assert.equal(response.status, 200, JSON.stringify(payload));
  }

  async function configureUser(employeeNumber, role, password) {
    const { response, payload } = await requestJson(baseUrl, `/api/portal/v1/users/${employeeNumber}`, {
      method: "PUT",
      session: admin,
      body: { role, active: true, password, mustChangePassword: true },
    });
    assert.equal(response.status, 200, JSON.stringify(payload));
  }

  try {
    const status = await waitForJson(`${baseUrl}/api/portal/v1/status`, child);
    assert.equal(status.portalEnabled, true);

    const setup = await requestJson(baseUrl, "/api/portal/v1/setup/admin", {
      method: "POST",
      body: { employeeNumber: "101", password: "987654" },
    });
    assert.equal(setup.response.status, 201, JSON.stringify(setup.payload));
    admin = await login("101", "987654");

    const locations = await requestJson(baseUrl, "/api/locations", { session: admin });
    assert.equal(locations.response.status, 200, JSON.stringify(locations.payload));
    const primaryLocation = locations.payload.find((location) => location.id === "01");
    assert.ok(primaryLocation);
    const createSecondLocation = await requestJson(baseUrl, "/api/locations", {
      method: "POST",
      session: admin,
      body: {
        id: "02",
        name: "Zeit-Testfiliale",
        minStaff: 1,
        daySettings: primaryLocation.day_settings,
        timeTrackingEnabled: true,
        active: true,
      },
    });
    assert.equal(createSecondLocation.response.status, 201, JSON.stringify(createSecondLocation.payload));

    const fixtureDb = new DatabaseSync(databasePath);
    fixtureDb.exec("PRAGMA busy_timeout = 5000");
    try {
      fixtureDb.prepare("UPDATE locations SET time_tracking_enabled = 1 WHERE id IN ('01','02')").run();
      fixtureDb.prepare(`
        UPDATE employees
        SET cost_center_id = (SELECT cost_center_id FROM locations WHERE id = '02'),
            home_location_id = '02',
            preferred_department_id = NULL
        WHERE personnel_number = '105'
      `).run();
    } finally {
      fixtureDb.close();
    }

    await configureUser("102", "employee", "654321");
    await configureUser("104", "manager", "445566");
    await configureUser("105", "employee", "556677");
    const managerScope = await requestJson(baseUrl, "/api/portal/v1/users/104/scopes", {
      method: "PUT",
      session: admin,
      body: { scopes: [{ locationId: "01" }] },
    });
    assert.equal(managerScope.response.status, 200, JSON.stringify(managerScope.payload));

    const employee = await login("102", "654321");
    await changePassword(employee, "654321", "123456");
    const manager = await login("104", "445566");
    await changePassword(manager, "445566", "665544");
    const remoteEmployee = await login("105", "556677");
    await changePassword(remoteEmployee, "556677", "776655");

    const dataDb = new DatabaseSync(databasePath);
    dataDb.exec("PRAGMA busy_timeout = 5000");
    let originalCorrectionDayIds;
    let departmentAId;
    let departmentBId;
    try {
      dataDb.exec("BEGIN IMMEDIATE");
      dataDb.prepare("DELETE FROM time_corrections WHERE employee_number IN ('102','105')").run();
      dataDb.prepare("DELETE FROM time_entries WHERE employee_number IN ('102','105')").run();
      dataDb.prepare("DELETE FROM shifts WHERE employee_number IN ('102','105')").run();
      departmentAId = Number(dataDb.prepare(`
        INSERT INTO departments (location_id, name, min_staff, active, sort_order)
        VALUES ('01', 'Zeit-Abteilung A', 1, 1, 91)
      `).run().lastInsertRowid);
      departmentBId = Number(dataDb.prepare(`
        INSERT INTO departments (location_id, name, min_staff, active, sort_order)
        VALUES ('01', 'Zeit-Abteilung B', 1, 1, 92)
      `).run().lastInsertRowid);
      dataDb.prepare("UPDATE employees SET preferred_department_id = ? WHERE personnel_number = '102'").run(departmentAId);
      const insertShift = dataDb.prepare(`
        INSERT INTO shifts (employee_number, shift_date, start_time, end_time, area, department_id)
        VALUES (?, ?, ?, ?, 'Zeit-Test', ?)
      `);
      insertShift.run("102", "2026-07-06", "09:00", "17:00", departmentAId);
      insertShift.run("102", "2026-07-07", "10:00", "14:00", departmentBId);
      insertShift.run("102", "2026-07-08", "09:00", "17:00", departmentAId);
      insertShift.run("105", "2026-07-09", "09:00", "17:00", null);

      const insertEntry = dataDb.prepare(`
        INSERT INTO time_entries
          (employee_number, location_id, department_id, work_date, entry_type, entry_timestamp, source, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 'portal', ?)
      `);
      insertEntry.run("102", "01", departmentAId, "2026-07-06", "clock_in", "2026-07-06T07:00:00.000Z", "102");
      insertEntry.run("102", "01", departmentAId, "2026-07-06", "break_start", "2026-07-06T10:00:00.000Z", "102");
      insertEntry.run("102", "01", departmentAId, "2026-07-06", "break_end", "2026-07-06T10:30:00.000Z", "102");
      insertEntry.run("102", "01", departmentAId, "2026-07-06", "clock_out", "2026-07-06T15:00:00.000Z", "102");
      insertEntry.run("102", "01", departmentBId, "2026-07-07", "clock_in", "2026-07-07T08:00:00.000Z", "102");
      insertEntry.run("102", "01", departmentBId, "2026-07-07", "clock_out", "2026-07-07T12:00:00.000Z", "102");
      const correctionClockIn = Number(insertEntry.run("102", "01", departmentAId, "2026-07-08", "clock_in", "2026-07-08T07:00:00.000Z", "102").lastInsertRowid);
      const correctionClockOut = Number(insertEntry.run("102", "01", departmentAId, "2026-07-08", "clock_out", "2026-07-08T15:30:00.000Z", "102").lastInsertRowid);
      originalCorrectionDayIds = [correctionClockIn, correctionClockOut];
      insertEntry.run("105", "02", null, "2026-07-09", "clock_in", "2026-07-09T07:00:00.000Z", "105");
      insertEntry.run("105", "02", null, "2026-07-09", "clock_out", "2026-07-09T15:00:00.000Z", "105");
      dataDb.exec("COMMIT");
    } catch (error) {
      try { dataDb.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      dataDb.close();
    }

    const weekly = await requestJson(baseUrl, "/api/portal/v1/me/time-summary?period=week&anchor=2026-07-08", { session: employee });
    assert.equal(weekly.response.status, 200, JSON.stringify(weekly.payload));
    const weeklySummary = summaryFrom(weekly.payload);
    assert.equal(weeklySummary.period, "week");
    assert.equal(weeklySummary.dateFrom, "2026-07-06");
    assert.equal(weeklySummary.dateTo, "2026-07-12");
    assert.equal(weeklySummary.plannedMinutes, 1140);
    assert.equal(weeklySummary.actualMinutes, 1200);
    assert.equal(weeklySummary.differenceMinutes, 60);
    assert.ok(Array.isArray(weeklySummary.days));

    const monthly = await requestJson(baseUrl, "/api/portal/v1/me/time-summary?period=month&anchor=2026-07-15", { session: employee });
    assert.equal(monthly.response.status, 200, JSON.stringify(monthly.payload));
    const monthlySummary = summaryFrom(monthly.payload);
    assert.equal(monthlySummary.period, "month");
    assert.equal(monthlySummary.dateFrom, "2026-07-01");
    assert.equal(monthlySummary.dateTo, "2026-07-31");
    assert.equal(monthlySummary.plannedMinutes, 1140);
    assert.equal(monthlySummary.actualMinutes, 1200);

    const csrfRejected = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", {
      method: "POST",
      session: employee,
      csrf: false,
      body: {
        correctionDate: "2026-07-08",
        requestedEntries: [{ type: "clock_in", time: "09:00" }, { type: "clock_out", time: "17:00" }],
        reason: "CSRF-Test",
      },
    });
    assert.equal(csrfRejected.response.status, 403, JSON.stringify(csrfRejected.payload));

    const throwawayCreate = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", {
      method: "POST",
      session: employee,
      body: {
        correctionDate: "2026-07-07",
        requestedEntries: [{ type: "clock_in", time: "10:00" }, { type: "clock_out", time: "14:00" }],
        reason: "Vorläufige Angabe",
      },
    });
    assert.equal(throwawayCreate.response.status, 201, JSON.stringify(throwawayCreate.payload));
    const throwaway = correctionFrom(throwawayCreate.payload);
    assert.ok(throwaway.id);
    assert.equal(throwaway.status, "pending");

    const throwawayUpdate = await requestJson(baseUrl, `/api/portal/v1/me/time-corrections/${throwaway.id}`, {
      method: "PUT",
      session: employee,
      body: {
        correctionDate: "2026-07-07",
        requestedEntries: [{ type: "clock_in", time: "10:05" }, { type: "clock_out", time: "14:00" }],
        reason: "Korrigierte Angabe",
      },
    });
    assert.equal(throwawayUpdate.response.status, 200, JSON.stringify(throwawayUpdate.payload));
    assert.equal(correctionFrom(throwawayUpdate.payload).reason, "Korrigierte Angabe");

    const throwawayDelete = await requestJson(baseUrl, `/api/portal/v1/me/time-corrections/${throwaway.id}`, {
      method: "DELETE",
      session: employee,
    });
    assert.equal(throwawayDelete.response.status, 204, JSON.stringify(throwawayDelete.payload));

    const ownAfterDelete = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", { session: employee });
    assert.equal(ownAfterDelete.response.status, 200, JSON.stringify(ownAfterDelete.payload));
    const deletedEntry = correctionsFrom(ownAfterDelete.payload).find((item) => Number(item.id) === Number(throwaway.id));
    assert.ok(!deletedEntry || ["withdrawn", "cancelled"].includes(deletedEntry.status));

    const correctedEntries = [
      { type: "clock_in", time: "09:00" },
      { type: "break_start", time: "12:00" },
      { type: "break_end", time: "12:30" },
      { type: "clock_out", time: "17:00" },
    ];
    const correctionCreate = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", {
      method: "POST",
      session: employee,
      body: { correctionDate: "2026-07-08", requestedEntries: correctedEntries, reason: "Gehen zu spät gebucht" },
    });
    assert.equal(correctionCreate.response.status, 201, JSON.stringify(correctionCreate.payload));
    const correction = correctionFrom(correctionCreate.payload);
    assert.ok(correction.id);
    assert.equal(correction.employeeNumber, "102");
    assert.equal(correction.status, "pending");

    const remoteCorrectionCreate = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", {
      method: "POST",
      session: remoteEmployee,
      body: {
        correctionDate: "2026-07-09",
        requestedEntries: [{ type: "clock_in", time: "09:00" }, { type: "clock_out", time: "16:45" }],
        reason: "Remote-Test",
      },
    });
    assert.equal(remoteCorrectionCreate.response.status, 201, JSON.stringify(remoteCorrectionCreate.payload));
    const remoteCorrection = correctionFrom(remoteCorrectionCreate.payload);

    const emptySnapshotCreate = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", {
      method: "POST",
      session: employee,
      body: {
        correctionDate: "2026-06-30",
        requestedEntries: [{ type: "clock_in", time: "09:00" }, { type: "clock_out", time: "17:00" }],
        reason: "Antrag ohne ursprüngliche Buchungen",
      },
    });
    assert.equal(emptySnapshotCreate.response.status, 201, JSON.stringify(emptySnapshotCreate.payload));
    const emptySnapshotCorrection = correctionFrom(emptySnapshotCreate.payload);
    const changedSourceDb = new DatabaseSync(databasePath);
    changedSourceDb.exec("PRAGMA busy_timeout = 5000");
    try {
      const insertChangedSource = changedSourceDb.prepare(`
        INSERT INTO time_entries
          (employee_number, location_id, work_date, entry_type, entry_timestamp, source, created_by)
        VALUES ('102', '01', '2026-06-30', ?, ?, 'portal', '102')
      `);
      insertChangedSource.run("clock_in", "2026-06-30T07:00:00.000Z");
      insertChangedSource.run("clock_out", "2026-06-30T15:00:00.000Z");
    } finally {
      changedSourceDb.close();
    }
    const changedSourceDecision = await requestJson(baseUrl, `/api/portal/v1/time-corrections/${emptySnapshotCorrection.id}/decision`, {
      method: "PUT",
      session: manager,
      body: {
        action: "approve",
        entries: [{ type: "clock_in", time: "09:00" }, { type: "clock_out", time: "17:00" }],
        decisionNote: "Darf neue Livebuchungen nicht ersetzen",
      },
    });
    assert.equal(changedSourceDecision.response.status, 409, JSON.stringify(changedSourceDecision.payload));
    assert.equal(changedSourceDecision.payload.code, "TIME_CORRECTION_SOURCE_CHANGED");

    const managerPending = await requestJson(baseUrl, "/api/portal/v1/time-corrections?status=pending&locationId=01", { session: manager });
    assert.equal(managerPending.response.status, 200, JSON.stringify(managerPending.payload));
    const visiblePending = correctionsFrom(managerPending.payload);
    assert.ok(visiblePending.some((item) => Number(item.id) === Number(correction.id)));
    assert.equal(visiblePending.some((item) => Number(item.id) === Number(remoteCorrection.id)), false);

    const managerRemoteSummary = await requestJson(baseUrl, "/api/portal/v1/time-summary?from=2026-07-06&to=2026-07-12&locationId=02", { session: manager });
    assert.equal(managerRemoteSummary.response.status, 403, JSON.stringify(managerRemoteSummary.payload));

    const managerRemoteDecision = await requestJson(baseUrl, `/api/portal/v1/time-corrections/${remoteCorrection.id}/decision`, {
      method: "PUT",
      session: manager,
      body: { action: "approve", entries: [{ type: "clock_in", time: "09:00" }, { type: "clock_out", time: "16:45" }], decisionNote: "Nicht eigener Standort" },
    });
    assert.equal(managerRemoteDecision.response.status, 403, JSON.stringify(managerRemoteDecision.payload));

    const decisionWithoutCsrf = await requestJson(baseUrl, `/api/portal/v1/time-corrections/${correction.id}/decision`, {
      method: "PUT",
      session: manager,
      csrf: false,
      body: { action: "approve", entries: correctedEntries, decisionNote: "CSRF muss greifen" },
    });
    assert.equal(decisionWithoutCsrf.response.status, 403, JSON.stringify(decisionWithoutCsrf.payload));

    const decision = await requestJson(baseUrl, `/api/portal/v1/time-corrections/${correction.id}/decision`, {
      method: "PUT",
      session: manager,
      body: { action: "approve", entries: correctedEntries, decisionNote: "Zeiten anhand Rücksprache bestätigt" },
    });
    assert.equal(decision.response.status, 200, JSON.stringify(decision.payload));
    assert.equal(correctionFrom(decision.payload).status, "approved");
    assert.equal(correctionFrom(decision.payload).decidedBy, "104");

    const duplicateDecision = await requestJson(baseUrl, `/api/portal/v1/time-corrections/${correction.id}/decision`, {
      method: "PUT",
      session: manager,
      body: { action: "approve", entries: correctedEntries, decisionNote: "Darf nicht doppelt wirken" },
    });
    assert.equal(duplicateDecision.response.status, 409, JSON.stringify(duplicateDecision.payload));

    const verifiedDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const correctionRow = verifiedDb.prepare(`
        SELECT status, decided_by, decision_note FROM time_corrections WHERE id = ?
      `).get(correction.id);
      assert.equal(correctionRow.status, "approved");
      assert.equal(correctionRow.decided_by, "104");
      assert.equal(correctionRow.decision_note, "Zeiten anhand Rücksprache bestätigt");

      const originalRows = verifiedDb.prepare(`
        SELECT id, source, voided_at, void_reason, correction_id
        FROM time_entries WHERE id IN (?, ?) ORDER BY id
      `).all(...originalCorrectionDayIds);
      assert.equal(originalRows.length, 2, "Originalbuchungen müssen physisch erhalten bleiben.");
      assert.ok(originalRows.every((row) => row.source === "portal"));
      assert.ok(originalRows.every((row) => row.voided_at));
      assert.ok(originalRows.every((row) => row.void_reason));
      assert.ok(originalRows.every((row) => Number(row.correction_id) === Number(correction.id)));

      const replacements = verifiedDb.prepare(`
        SELECT entry_type, source, voided_at, correction_id
        FROM time_entries
        WHERE employee_number = '102' AND work_date = '2026-07-08' AND source = 'manager_correction'
        ORDER BY entry_timestamp, id
      `).all();
      assert.deepEqual(replacements.map((row) => row.entry_type), ["clock_in", "break_start", "break_end", "clock_out"]);
      assert.ok(replacements.every((row) => !row.voided_at));
      assert.ok(replacements.every((row) => Number(row.correction_id) === Number(correction.id)));
      assert.equal(verifiedDb.prepare("SELECT COUNT(*) AS count FROM time_entries WHERE employee_number = '102' AND work_date = '2026-07-08'").get().count, 6);
      assert.equal(verifiedDb.prepare(`
        SELECT COUNT(*) AS count FROM time_entries
        WHERE employee_number = '102' AND work_date = '2026-06-30' AND voided_at IS NULL
      `).get().count, 2, "Nachträglich hinzugekommene Livebuchungen dürfen nicht entwertet werden.");
    } finally {
      verifiedDb.close();
    }

    const correctedWeekly = await requestJson(baseUrl, "/api/portal/v1/me/time-summary?period=week&anchor=2026-07-08", { session: employee });
    assert.equal(correctedWeekly.response.status, 200, JSON.stringify(correctedWeekly.payload));
    const correctedWeeklySummary = summaryFrom(correctedWeekly.payload);
    assert.equal(correctedWeeklySummary.plannedMinutes, 1140);
    assert.equal(correctedWeeklySummary.actualMinutes, 1140);
    assert.equal(correctedWeeklySummary.differenceMinutes, 0);

    const managerSummary = await requestJson(baseUrl, "/api/portal/v1/time-summary?from=2026-07-06&to=2026-07-12&locationId=01", { session: manager });
    assert.equal(managerSummary.response.status, 200, JSON.stringify(managerSummary.payload));
    const managerSummaryPayload = summaryFrom(managerSummary.payload);
    assert.ok(Array.isArray(managerSummaryPayload.employees));
    const employeeSummary = managerSummaryPayload.employees.find((item) => item.employeeNumber === "102");
    assert.ok(employeeSummary);
    assert.equal(employeeSummary.actualMinutes, 1140);
    assert.equal(employeeSummary.plannedMinutes, 1140);
    const departmentASummaryResponse = await requestJson(baseUrl, `/api/portal/v1/time-summary?from=2026-07-06&to=2026-07-12&locationId=01&departmentId=${departmentAId}`, { session: manager });
    assert.equal(departmentASummaryResponse.response.status, 200, JSON.stringify(departmentASummaryResponse.payload));
    const departmentAEmployee = summaryFrom(departmentASummaryResponse.payload).employees.find((item) => item.employeeNumber === "102");
    assert.ok(departmentAEmployee);
    assert.equal(departmentAEmployee.actualMinutes, 900);
    assert.equal(departmentAEmployee.plannedMinutes, 900);
    const departmentBSummaryResponse = await requestJson(baseUrl, `/api/portal/v1/time-summary?from=2026-07-06&to=2026-07-12&locationId=01&departmentId=${departmentBId}`, { session: manager });
    assert.equal(departmentBSummaryResponse.response.status, 200, JSON.stringify(departmentBSummaryResponse.payload));
    const departmentBEmployee = summaryFrom(departmentBSummaryResponse.payload).employees.find((item) => item.employeeNumber === "102");
    assert.ok(departmentBEmployee, "Auch abteilungsweise eingesetzte Teammitglieder müssen in der Abteilungsübersicht erscheinen.");
    assert.equal(departmentBEmployee.actualMinutes, 240);
    assert.equal(departmentBEmployee.plannedMinutes, 240);

    const ownCorrections = await requestJson(baseUrl, "/api/portal/v1/me/time-corrections", { session: employee });
    assert.equal(ownCorrections.response.status, 200, JSON.stringify(ownCorrections.payload));
    const decidedCorrection = correctionsFrom(ownCorrections.payload).find((item) => Number(item.id) === Number(correction.id));
    assert.equal(decidedCorrection.status, "approved");
    assert.equal(decidedCorrection.decidedBy, "104");
    assert.equal(decidedCorrection.decisionNote, "Zeiten anhand Rücksprache bestätigt");

    const exit = await requestJson(baseUrl, "/api/system/exit", { method: "POST", session: admin, body: {} });
    assert.equal(exit.response.status, 200, JSON.stringify(exit.payload));
    assert.equal((await waitForExit(child)).code, 0, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      try {
        await waitForExit(child, 8_000);
      } catch {
        child.kill("SIGKILL");
        try { await waitForExit(child, 3_000); } catch {}
      }
    }
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});
