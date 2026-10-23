const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAmuStorage } = require("../lib/amu-storage");
const {
  PERSONNEL_LIFECYCLE_INTERFACE_PERMISSION_IDS,
} = require("../lib/personnel-lifecycle-interfaces-contract");
const {
  PERSONNEL_LIFECYCLE_AUTOMATION_PERMISSION_IDS,
} = require("../lib/personnel-lifecycle-automation-contract");
const {
  PERMISSION_IDS: PERSONNEL_LIFECYCLE_EDITOR_PERMISSION_IDS,
} = require("../lib/personnel-lifecycle-editor-contract");
const {
  PERSONNEL_LEARNING_PERMISSION_IDS,
} = require("../lib/personnel-learning-access");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-portal-test-"));
const databasePath = path.join(testRoot, "legacy.db");
const backupPath = path.join(testRoot, "backups");

process.env.DB_PATH = databasePath;
process.env.BACKUP_DIR = backupPath;
process.env.GRABENPLANER_HOST = "127.0.0.1";
const { databaseForCurrentTest } = require("../test-support/postgresql-api/preload");
const preparedPostgresql = databaseForCurrentTest(databasePath);
preparedPostgresql.exec(`
  INSERT INTO portal_roles (id, name, builtin, permissions)
  VALUES ('employee', 'Alt', 1, '["legacy"]');
  INSERT INTO portal_roles (id, name, builtin, permissions)
  VALUES ('custom-auditor', 'Eigene Prüferrolle', 0, '["audit:read"]');
`);

const {
  app,
  db,
  getPortalRoles,
  getPortalStatus,
  hashPortalPassword,
  verifyPortalPassword,
  timeTrackingDayStatus,
  bookTimeEntry,
  resolveStaleTimeEntry,
  timePresenceForContext,
  releaseInstanceLockForTests,
} = require("../server");

let httpServer;
let baseUrl;

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
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Serverprozess wurde nach ${timeoutMs} ms nicht beendet.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await db.close();
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

// The former minimal SQLite schema upgrade is checked against immutable
// b2ba03c source in portal-foundation-legacy-migration.test.js, not a hidden current driver.
test("PostgreSQL-Portal-Fundament stellt Tabellen, Sicherheitsfelder und Idempotenzindex bereit", () => {
  const tables = new Set(db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'gp'").all().map(row => row.name));
  for (const name of ["portal_users", "portal_roles", "portal_sessions", "mobile_sessions", "mobile_refresh_token_history", "vacation_requests", "time_off_requests", "time_off_change_requests", "vacation_change_requests", "request_blackouts", "request_decisions", "approval_delegations", "time_entries", "time_corrections", "audit_log", "portal_permission_grants", "location_branding", "schema_migrations"]) assert.ok(tables.has(name), name);
  for (const [table, columns] of [["portal_users", ["password_changed_at", "failed_login_attempts", "locked_until", "role_locked"]], ["portal_roles", ["description", "sort_order", "updated_at"]], ["time_entries", ["client_request_id", "mobile_session_id"]]]) {
    const actual = new Set(db.prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = 'gp' AND table_name = ?").all(table).map(row => row.column_name));
    for (const name of columns) assert.ok(actual.has(name), table + "." + name);
  }
  assert.ok(db.prepare("SELECT 1 FROM pg_indexes WHERE schemaname='gp' AND indexname='idx_time_entries_mobile_request'").get());
});

test("Built-in-Rollen werden aktualisiert und eigene Rollen bleiben erhalten", async () => {
  const roles = await getPortalRoles();
  const employee = roles.find((role) => role.id === "employee");
  const custom = roles.find((role) => role.id === "custom-auditor");
  assert.equal(employee.name, "Mitarbeiter");
  assert.ok(employee.permissions.includes("own_schedule:read"));
  assert.ok(employee.permissions.includes("own_vacation:request"));
  assert.ok(roles.some((role) => role.id === "hr" && role.name === "Personalleitung" && role.permissions.includes("hr:approve")));
  assert.ok(roles.some((role) => role.id === "admin" && role.permissions.includes("rights:write")
    && role.permissions.includes("branding:write") && role.permissions.includes("system:diagnostics:read")
    && role.permissions.includes("system:diagnostics:technical")));
  assert.ok(roles.some((role) => role.id === "hr" && role.permissions.includes("rights:write")));
  assert.equal(roles.some((role) => role.permissions.includes("operation_mode:write")), false);
  assert.ok(roles.some((role) => role.id === "hr" && !role.permissions.includes("system:diagnostics:read") && !role.permissions.includes("system:diagnostics:technical")));
  assert.ok(roles.some((role) => role.id === "it_admin" && role.permissions.includes("rights:write")
    && role.permissions.includes("update:write") && role.permissions.includes("employees:write")
    && role.permissions.includes("system:diagnostics:read") && role.permissions.includes("system:diagnostics:technical")));
  const developer = roles.find((role) => role.id === "developer");
  assert.ok(developer?.protected && !developer.assignable);
  for (const permission of [
    "developer:system",
    "personnel:profiles:read",
    "personnel:profiles:master:read",
    "personnel:profiles:documents:read",
    "personnel:workflows:confidential:read",
    "personnel:workflows:confidential:write",
    "personnel:lifecycle:onboarding:read",
    "personnel:lifecycle:onboarding:execute",
    "personnel:lifecycle:offboarding:confidential:read",
    "personnel:lifecycle:offboarding:execute",
    "work_rules:draft",
    "work_rules:manage",
    "work_rules:review",
    "work_rules:publish",
    "work_rules:assign",
    "work_rules:exception",
    "work_rules:audit",
  ]) assert.ok(developer.permissions.includes(permission), permission);
  assert.equal(custom.name, "Eigene Prüferrolle");
  assert.deepEqual(custom.permissions, ["audit:read"]);
});

test("Status meldet eine sichere lokale Testlaufzeit", async () => {
  const directStatus = getPortalStatus();
  assert.equal(directStatus.operationMode, "local");
  assert.equal(directStatus.portalEnabled, false);
  assert.equal(directStatus.loginRequired, false);
  assert.equal(directStatus.localOnly, true);

  const response = await fetch(`${baseUrl}/api/portal/v1/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.apiVersion, 1);
  assert.equal(status.operationMode, "local");
  assert.equal(status.capabilities.timeOffRequests, false);
  assert.equal(status.capabilities.vacationChanges, false);
  assert.equal(status.capabilities.requestBlackouts, false);
  assert.equal(status.capabilities.timeTracking, false);
});

test("Session- und Rollen-Endpunkte haben einen stabilen v1-Vertrag", async () => {
  const sessionResponse = await fetch(`${baseUrl}/api/portal/v1/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, false);
  assert.equal(session.loginRequired, false);
  assert.equal(session.user, null);

  const rolesResponse = await fetch(`${baseUrl}/api/portal/v1/roles`);
  assert.equal(rolesResponse.status, 200);
  const roles = await rolesResponse.json();
  assert.equal(roles.apiVersion, 1);
  assert.ok(roles.roles.some((role) => role.id === "admin" && role.builtin));
});

test("Login und Mitarbeiterfunktionen bleiben bis zum Servermodus gesperrt", async () => {
  const response = await fetch(`${baseUrl}/api/portal/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personnelNumber: "07", password: "nicht-aktiv" }),
  });
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.code, "PORTAL_INACTIVE");
  assert.equal(result.status.operationMode, "local");
});

test("lokaler Einzelplatzmodus kann Filialen und Abteilungen deaktivieren und reaktivieren", async () => {
  const initialResponse = await fetch(`${baseUrl}/api/locations`);
  assert.equal(initialResponse.status, 200, await initialResponse.clone().text());
  const initialLocations = await initialResponse.json();
  const template = initialLocations.find((location) => location.active !== false) || initialLocations[0];
  assert.ok(template, "Für den lokalen Topologietest fehlt eine Ausgangsfiliale.");
  const usedIds = new Set(initialLocations.map((location) => String(location.id)));
  const locationId = Array.from({ length: 10 }, (_, index) => String(99 - index).padStart(2, "0"))
    .find((candidate) => !usedIds.has(candidate));
  assert.ok(locationId, "Für den lokalen Topologietest fehlt eine freie Filial-ID.");

  const locationBody = {
    id: locationId,
    name: "Lokale Topologieprüfung",
    minStaff: 1,
    daySettings: template.day_settings,
    timeTrackingEnabled: false,
    active: true,
  };
  const createdLocation = await fetch(`${baseUrl}/api/locations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(locationBody),
  });
  assert.equal(createdLocation.status, 201, await createdLocation.clone().text());

  const disabledLocation = await fetch(`${baseUrl}/api/locations/${locationId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...locationBody, active: false }),
  });
  assert.equal(disabledLocation.status, 200, await disabledLocation.clone().text());
  assert.equal((await disabledLocation.json()).find((location) => location.id === locationId)?.active, false);

  const restoredLocation = await fetch(`${baseUrl}/api/locations/${locationId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(locationBody),
  });
  assert.equal(restoredLocation.status, 200, await restoredLocation.clone().text());
  assert.equal((await restoredLocation.json()).find((location) => location.id === locationId)?.active, true);

  const departmentBody = {
    locationId,
    name: "Lokale Wissensprüfung",
    minStaff: 1,
    active: true,
  };
  const createdDepartment = await fetch(`${baseUrl}/api/departments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(departmentBody),
  });
  assert.equal(createdDepartment.status, 201, await createdDepartment.clone().text());
  const departmentId = (await createdDepartment.json())
    .find((location) => location.id === locationId)?.departments
    .find((department) => department.name === departmentBody.name)?.id;
  assert.ok(departmentId, "Die lokale Testabteilung wurde nicht angelegt.");

  const disabledDepartment = await fetch(`${baseUrl}/api/departments/${departmentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...departmentBody, active: false }),
  });
  assert.equal(disabledDepartment.status, 200, await disabledDepartment.clone().text());
  assert.equal(
    (await disabledDepartment.json()).find((location) => location.id === locationId)?.departments
      .find((department) => Number(department.id) === Number(departmentId))?.active,
    false,
  );

  const restoredDepartment = await fetch(`${baseUrl}/api/departments/${departmentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(departmentBody),
  });
  assert.equal(restoredDepartment.status, 200, await restoredDepartment.clone().text());
  assert.equal(
    (await restoredDepartment.json()).find((location) => location.id === locationId)?.departments
      .find((department) => Number(department.id) === Number(departmentId))?.active,
    true,
  );
});

test("Betriebsmodus kann nicht über eine Browser-API verändert werden", async () => {
  const response = await fetch(`${baseUrl}/api/operation-mode`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationMode: "server" }),
  });
  assert.equal(response.status, 404);
  assert.equal(getPortalStatus().operationMode, "local");
});

test("bestehende lokale Dienstplan-API bleibt erreichbar", async () => {
  const response = await fetch(`${baseUrl}/api/schedule?week=2026-07-13`);
  assert.equal(response.status, 200);
  const schedule = await response.json();
  assert.equal(schedule.weekStart, "2026-07-13");
  assert.equal(Object.hasOwn(schedule.settings, "operation_mode"), false);
  assert.equal(Object.hasOwn(schedule.settings, "server_mode_status"), false);
});

test("PDF-Vorschauen dürfen nur gleichursprünglich eingebettet werden", async () => {
  for (const previewPath of [
    "/api/schedule-preview.pdf?week=2026-07-13",
    "/api/vacations-preview.pdf?year=2026&view=year",
  ]) {
    const response = await fetch(`${baseUrl}${previewPath}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("content-type") || "", /^application\/pdf/i);
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(response.headers.get("content-security-policy") || "", /frame-ancestors 'self'/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("ascii"), "%PDF");
  }

  const protectedResponse = await fetch(`${baseUrl}/api/portal/v1/status`);
  assert.equal(protectedResponse.headers.get("x-frame-options"), "DENY");
  assert.match(protectedResponse.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
});

test("vorbereitete Passwort-Hashes verwenden scrypt, Salz und Versionskennung", async () => {
  const password = "EinSicheresTestpasswort!";
  const hashA = await hashPortalPassword(password);
  const hashB = await hashPortalPassword(password);
  assert.match(hashA, /^scrypt-v1\$/);
  assert.notEqual(hashA, hashB);
  assert.equal(hashA.includes(password), false);
  assert.equal(await verifyPortalPassword(password, hashA), true);
  assert.equal(await verifyPortalPassword("falsch", hashA), false);
  assert.equal(await verifyPortalPassword(password, "ungueltig"), false);
});

test("Zeiterfassung erzwingt die sichere Buchungsfolge und berechnet die Ist-Zeit", async () => {
  const location = db.prepare("SELECT id, name FROM locations ORDER BY id LIMIT 1").get();
  assert.ok(location);
  const employeeNumber = "991";
  db.prepare(`
    INSERT INTO employees (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
    VALUES (?, 'Zeit Test', 'Zeit', '#446688', 38.5, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET full_name=excluded.full_name, nickname=excluded.nickname, color=excluded.color, contracted_hours=excluded.contracted_hours, home_location_id=excluded.home_location_id, active=excluded.active
  `).run(employeeNumber, location.id);
  db.prepare("UPDATE locations SET time_tracking_enabled = 1 WHERE id = ?").run(location.id);
  const times = [
    new Date("2026-07-13T07:00:00.000Z"),
    new Date("2026-07-13T10:00:00.000Z"),
    new Date("2026-07-13T10:30:00.000Z"),
    new Date("2026-07-13T15:00:00.000Z"),
  ];
  try {
    assert.deepEqual((await timeTrackingDayStatus(employeeNumber, "2026-07-13", times[0])).allowedActions, ["clock_in"]);
    assert.equal((await bookTimeEntry(employeeNumber, "clock_in", times[0])).state, "working");
    await assert.rejects(
      () => bookTimeEntry(employeeNumber, "clock_in", times[0]),
      (error) => error.code === "TIME_ENTRY_STATE_CONFLICT",
    );
    assert.equal((await bookTimeEntry(employeeNumber, "break_start", times[1])).state, "paused");
    assert.equal((await bookTimeEntry(employeeNumber, "break_end", times[2])).state, "working");
    const completed = await bookTimeEntry(employeeNumber, "clock_out", times[3]);
    assert.equal(completed.state, "off");
    assert.equal(completed.actualMinutes, 450);
    assert.deepEqual(completed.allowedActions, ["clock_in"]);
    const presence = await timePresenceForContext({ employeeNumber: "local", role: "admin", permissions: ["time:read"] }, {
      locationId: location.id, locationName: location.name, departmentId: null, departmentName: "",
    }, "2026-07-13", times[3]);
    assert.equal(presence.employees.find((employee) => employee.employeeNumber === employeeNumber)?.actualMinutes, 450);

    db.prepare("DELETE FROM time_entries WHERE employee_number = ?").run(employeeNumber);
    await bookTimeEntry(employeeNumber, "clock_in", times[0]);
    const nextMorning = new Date("2026-07-14T08:00:00.000Z");
    const stale = await timeTrackingDayStatus(employeeNumber, "2026-07-14", nextMorning);
    assert.equal(stale.state, "attention");
    assert.equal(stale.allowedActions.length, 0);
    assert.equal(stale.staleEntry.date, "2026-07-13");
    const resolved = await resolveStaleTimeEntry(
      { employeeNumber: "local", role: "admin", permissions: ["time:review"] },
      employeeNumber,
      "2026-07-13",
      "17:00",
      nextMorning,
    );
    assert.equal(resolved.state, "off");
    assert.equal(resolved.staleEntry, null);
    assert.equal((await timeTrackingDayStatus(employeeNumber, "2026-07-13", nextMorning)).actualMinutes, 480);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM time_corrections WHERE employee_number = ?").get(employeeNumber).count, 1);
    const staleCorrection = db.prepare(`
      SELECT id, location_id, requested_by, decided_by, decision_note
      FROM time_corrections WHERE employee_number = ?
    `).get(employeeNumber);
    assert.equal(staleCorrection.location_id, location.id);
    assert.equal(staleCorrection.requested_by, "local");
    assert.equal(staleCorrection.decided_by, "local");
    assert.ok(staleCorrection.decision_note);
    assert.equal(db.prepare(`
      SELECT correction_id FROM time_entries
      WHERE employee_number = ? AND entry_type = 'clock_out' ORDER BY id DESC LIMIT 1
    `).get(employeeNumber).correction_id, staleCorrection.id);
  } finally {
    db.prepare("DELETE FROM time_entries WHERE employee_number = ?").run(employeeNumber);
    db.prepare("DELETE FROM time_corrections WHERE employee_number = ?").run(employeeNumber);
    db.prepare("DELETE FROM employees WHERE personnel_number = ?").run(employeeNumber);
    db.prepare("UPDATE locations SET time_tracking_enabled = 0 WHERE id = ?").run(location.id);
  }
});
