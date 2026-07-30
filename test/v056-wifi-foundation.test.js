const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v056-wifi-"));
const databasePath = path.join(testRoot, "dienstplan.db");
const repositoryRoot = path.resolve(__dirname, "..");

process.env.DB_PATH = databasePath;
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, getPortalRoles } = subject;

let httpServer;
let baseUrl;

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM wifi_time_suggestions").run();
    db.prepare("DELETE FROM wifi_event_inbox").run();
    db.prepare("DELETE FROM wifi_presence_sessions").run();
    db.prepare("DELETE FROM wifi_automation_preferences").run();
    db.prepare("DELETE FROM portal_sessions").run();
    db.prepare("DELETE FROM portal_permission_grants").run();
    db.prepare("DELETE FROM portal_access_scopes").run();
    db.prepare("DELETE FROM audit_log").run();
    db.prepare("DELETE FROM employees WHERE personnel_number LIKE 'v056-%'").run();
    db.prepare("UPDATE employees SET time_confirmation_level = 'C'").run();
    const upsert = db.prepare(`
      INSERT INTO portal_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    upsert.run("wifi_minimum_presence_minutes", "5");
    upsert.run("wifi_absence_grace_minutes", "30");
    upsert.run("trust_levels_enabled", "1");
    upsert.run("trust_levels_visible_to_managers", "0");
    upsert.run("trust_levels_visible_to_department_managers", "0");
    upsert.run("trust_levels_visible_to_employees", "1");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function createPortalSession(employeeNumber, role, permissions = []) {
  const token = `v056-${employeeNumber}-${crypto.randomBytes(24).toString("hex")}`;
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ?").run(employeeNumber);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      active = 1,
      must_change_password = 0,
      password_changed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  const grant = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, ?, 'v056-test')
  `);
  for (const permission of permissions) grant.run(employeeNumber, permission);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function requestJson(route, { method = "GET", session = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (session) headers.Cookie = session.cookie;
  if (session && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = response.status === 204 ? "" : await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function settingsUpdateBody(settings, locationId, overrides = {}) {
  return {
    locationId,
    pdfTitle: settings.pdf_title || "Dienstplan",
    pdfFilenamePrefix: settings.pdf_filename_prefix || "Dienstplan",
    vacationPdfTitle: settings.vacation_pdf_title || "Urlaubsplanung",
    vacationPdfFilenamePrefix: settings.vacation_pdf_filename_prefix || "Urlaubsplanung",
    vacationPdfCalendarStyle: settings.vacation_pdf_calendar_style || "bars",
    externalBackupEnabled: false,
    backupDirectory: settings.backup_directory || "",
    backupIntervalHours: Number(settings.backup_interval_hours || 2),
    breakAfterMinutes: Number(settings.break_after_minutes || 360),
    breakDurationMinutes: Number(settings.break_duration_minutes || 30),
    saturdayBonusFrom: settings.saturday_bonus_from || "13:00",
    saturdayBonusFactor: Number(settings.saturday_bonus_factor || 1.5),
    currentWeekLockMode: settings.current_week_lock_mode || "closing",
    currentWeekLockDay: settings.current_week_lock_day || "saturday",
    currentWeekLockTime: settings.current_week_lock_time || "17:00",
    rememberLastScheduleOverallPlan: settings.remember_last_schedule_overall_plan !== "0",
    rememberLastVacationOverallPlan: settings.remember_last_vacation_overall_plan !== "0",
    ...overrides,
  };
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(resetFixture);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.56: Migration legt das WLAN-Fundament datensparsam mit Vertrauensstufe C an", () => {
  const wifiTables = [
    "wifi_automation_preferences",
    "wifi_presence_sessions",
    "wifi_event_inbox",
    "wifi_time_suggestions",
  ];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const table of wifiTables) assert.ok(tables.has(table), `${table} fehlt.`);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.56-wifi-automation-foundation'").get());

  const employeeColumns = db.prepare("PRAGMA table_info(employees)").all();
  const levelColumn = employeeColumns.find((column) => column.name === "time_confirmation_level");
  assert.ok(levelColumn);
  assert.equal(levelColumn.notnull, 1);
  assert.equal(String(levelColumn.dflt_value).replaceAll("'", ""), "C");

  db.prepare("INSERT INTO employees (personnel_number, full_name, nickname) VALUES ('v056-default', 'Default C', 'Default')").run();
  assert.equal(db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = 'v056-default'").get().time_confirmation_level, "C");

  const allWifiColumns = wifiTables.flatMap((table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name.toLowerCase()));
  for (const forbidden of ["external_event_id", "mac", "mac_address", "ssid", "bssid"]) {
    assert.equal(allWifiColumns.includes(forbidden), false, `${forbidden} darf nicht gespeichert werden.`);
  }
  assert.ok(db.prepare("PRAGMA table_info(wifi_event_inbox)").all().some((column) => column.name === "external_event_hash"));
});

test("v0.56: wifi:settings ist nur in den vorgesehenen Built-in-Rollen und nicht delegierbar", async () => {
  const roles = new Map((await getPortalRoles()).map((role) => [role.id, role]));
  for (const role of ["hr", "admin", "it_admin", "developer"]) {
    assert.ok(roles.get(role)?.permissions.includes("wifi:settings"), `${role} benötigt wifi:settings.`);
  }
  for (const role of ["employee", "manager", "department_manager"]) {
    assert.equal(roles.get(role)?.permissions.includes("wifi:settings"), false, `${role} darf wifi:settings nicht besitzen.`);
  }

  const hr = createPortalSession("101", "hr");
  createPortalSession("105", "manager");
  const rights = await requestJson("/api/portal/v1/rights", { session: hr });
  assert.equal(rights.response.status, 200, JSON.stringify(rights.payload));
  assert.equal(rights.payload.catalog.some((permission) => permission.id === "wifi:settings"), false);

  const grantAttempt = await requestJson("/api/portal/v1/rights/105", {
    method: "PUT",
    session: hr,
    body: { permissions: ["wifi:settings"] },
  });
  assert.equal(grantAttempt.response.status, 403, JSON.stringify(grantAttempt.payload));
  assert.equal(grantAttempt.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");
});

test("v0.56: geschuetzte WLAN-Einstellungen liefern Defaults und erzwingen Grenzen", async () => {
  const admin = createPortalSession("101", "admin");
  const initial = await requestJson("/api/portal/v1/wifi-automation/settings", { session: admin });
  assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
  assert.deepEqual({
    minimumPresenceMinutes: initial.payload.minimumPresenceMinutes,
    absenceGraceMinutes: initial.payload.absenceGraceMinutes,
    endTimestampMode: initial.payload.endTimestampMode,
    connectorStatus: initial.payload.connectorStatus,
    phase: initial.payload.phase,
    automationActive: initial.payload.automationActive,
  }, {
    minimumPresenceMinutes: 5,
    absenceGraceMinutes: 30,
    endTimestampMode: "first_disconnect",
    connectorStatus: "configured",
    phase: "suggestions",
    automationActive: true,
  });

  for (const policy of [
    { minimumPresenceMinutes: 0, absenceGraceMinutes: 30 },
    { minimumPresenceMinutes: 121, absenceGraceMinutes: 30 },
    { minimumPresenceMinutes: 5.5, absenceGraceMinutes: 30 },
    { minimumPresenceMinutes: 5, absenceGraceMinutes: 0 },
    { minimumPresenceMinutes: 5, absenceGraceMinutes: 241 },
    { minimumPresenceMinutes: 5, absenceGraceMinutes: 30.5 },
  ]) {
    const invalid = await requestJson("/api/portal/v1/wifi-automation/settings", { method: "PUT", session: admin, body: policy });
    assert.equal(invalid.response.status, 400, `${JSON.stringify(policy)}: ${JSON.stringify(invalid.payload)}`);
    assert.equal(invalid.payload.code, "WIFI_POLICY_INVALID");
  }

  for (const policy of [
    { minimumPresenceMinutes: 1, absenceGraceMinutes: 1 },
    { minimumPresenceMinutes: 120, absenceGraceMinutes: 240 },
  ]) {
    const valid = await requestJson("/api/portal/v1/wifi-automation/settings", { method: "PUT", session: admin, body: policy });
    assert.equal(valid.response.status, 200, JSON.stringify(valid.payload));
    assert.equal(valid.payload.minimumPresenceMinutes, policy.minimumPresenceMinutes);
    assert.equal(valid.payload.absenceGraceMinutes, policy.absenceGraceMinutes);
  }
});

test("v0.56: Personalleitung, Admin, IT-Admin und Developer duerfen WLAN-Regeln verwalten", async () => {
  const sessions = [
    ["101", "hr"],
    ["102", "admin"],
    ["103", "it_admin"],
    ["104", "developer"],
    ["105", "manager"],
    ["106", "employee"],
  ].map(([employeeNumber, role]) => ({ employeeNumber, role, session: createPortalSession(employeeNumber, role) }));

  for (const [index, actor] of sessions.slice(0, 4).entries()) {
    const read = await requestJson("/api/portal/v1/wifi-automation/settings", { session: actor.session });
    assert.equal(read.response.status, 200, `${actor.role}: ${JSON.stringify(read.payload)}`);
    const write = await requestJson("/api/portal/v1/wifi-automation/settings", {
      method: "PUT",
      session: actor.session,
      body: { minimumPresenceMinutes: 10 + index, absenceGraceMinutes: 40 + index },
    });
    assert.equal(write.response.status, 200, `${actor.role}: ${JSON.stringify(write.payload)}`);
  }

  for (const actor of sessions.slice(4)) {
    const read = await requestJson("/api/portal/v1/wifi-automation/settings", { session: actor.session });
    assert.equal(read.response.status, 403, `${actor.role} darf die Regeln nicht lesen.`);
    const write = await requestJson("/api/portal/v1/wifi-automation/settings", {
      method: "PUT",
      session: actor.session,
      body: { minimumPresenceMinutes: 5, absenceGraceMinutes: 30 },
    });
    assert.equal(write.response.status, 403, `${actor.role} darf die Regeln nicht aendern.`);
  }
});

test("v0.56: Bulk-Aenderungen A/B/C sind atomar und werden einzeln protokolliert", async () => {
  const admin = createPortalSession("104", "admin");
  const invalid = await requestJson("/api/portal/v1/wifi-automation/confirmation-levels", {
    method: "PUT",
    session: admin,
    body: { levels: [{ employeeNumber: "101", level: "A" }, { employeeNumber: "nicht-da", level: "B" }] },
  });
  assert.equal(invalid.response.status, 404, JSON.stringify(invalid.payload));
  assert.equal(db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = '101'").get().time_confirmation_level, "C");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'employee.time_confirmation_level.update'").get().count, 0);

  const changed = await requestJson("/api/portal/v1/wifi-automation/confirmation-levels", {
    method: "PUT",
    session: admin,
    body: { levels: [
      { employeeNumber: "101", level: "A" },
      { employeeNumber: "102", level: "B" },
      { employeeNumber: "103", level: "C" },
    ] },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.changed, 2);
  assert.equal(changed.payload.employees.find((employee) => employee.employeeNumber === "101").level, "A");
  assert.equal(changed.payload.employees.find((employee) => employee.employeeNumber === "102").level, "B");

  const auditRows = db.prepare(`
    SELECT actor, entity_id, detail FROM audit_log
    WHERE action = 'employee.time_confirmation_level.update'
    ORDER BY entity_id
  `).all();
  assert.deepEqual(auditRows.map((row) => ({ actor: row.actor, entityId: row.entity_id, detail: JSON.parse(row.detail) })), [
    { actor: "104", entityId: "101", detail: { before: "C", after: "A" } },
    { actor: "104", entityId: "102", detail: { before: "C", after: "B" } },
  ]);
});

test("v0.56: employees:write allein gibt keinen Lese- oder Schreibzugriff auf Vertrauensstufen", async () => {
  const manager = createPortalSession("105", "manager", ["employees:write"]);
  const sessionInfo = await requestJson("/api/portal/v1/session", { session: manager });
  assert.equal(sessionInfo.response.status, 200, JSON.stringify(sessionInfo.payload));
  assert.ok(sessionInfo.payload.user.permissions.includes("employees:write"));
  assert.equal(sessionInfo.payload.user.permissions.includes("wifi:settings"), false);

  const list = await requestJson("/api/employees", { session: manager });
  assert.equal(list.response.status, 200, JSON.stringify(list.payload));
  assert.ok(list.payload.length > 0);
  assert.ok(list.payload.every((employee) => !("time_confirmation_level" in employee)));

  const target = db.prepare(`
    SELECT personnel_number, full_name, nickname, color, contracted_hours, preferred_day_off,
           fixed_workdays, position_id, home_location_id, preferred_department_id, active
    FROM employees WHERE personnel_number = '106'
  `).get();
  const update = await requestJson("/api/employees/106", {
    method: "PUT",
    session: manager,
    body: {
      fullName: target.full_name,
      nickname: target.nickname,
      color: target.color,
      contractedHours: target.contracted_hours,
      preferredDayOff: target.preferred_day_off || "",
      fixedWorkdays: target.fixed_workdays,
      positionId: target.position_id,
      timeConfirmationLevel: "A",
      homeLocationId: target.home_location_id,
      preferredDepartmentId: target.preferred_department_id,
      active: Boolean(target.active),
    },
  });
  assert.equal(update.response.status, 200, JSON.stringify(update.payload));
  assert.equal("timeConfirmationLevel" in update.payload, false);
  assert.equal(db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = '106'").get().time_confirmation_level, "C");
});

test("v0.56: WLAN-Regeln bleiben nach einem frischen App-Start erhalten", async () => {
  const admin = createPortalSession("101", "admin");
  const saved = await requestJson("/api/portal/v1/wifi-automation/settings", {
    method: "PUT",
    session: admin,
    body: { minimumPresenceMinutes: 17, absenceGraceMinutes: 73 },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));

  const restartDatabasePath = path.join(testRoot, "restart-dienstplan.db");
  const escapedRestartDatabasePath = restartDatabasePath.replaceAll("\\", "/").replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escapedRestartDatabasePath}'`);

  const script = `
    process.env.DB_PATH = ${JSON.stringify(restartDatabasePath)};
    process.env.BACKUP_DIR = ${JSON.stringify(path.join(testRoot, "restart-backups"))};
    process.env.GRABENPLANER_DATA_DIR = ${JSON.stringify(path.join(testRoot, "restart-data"))};
    process.env.GRABENPLANER_FORCE_PORTAL = "1";
    process.env.GRABENPLANER_SEED_DEMO = "1";
    process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
    process.env.NODE_ENV = "test";
    void (async () => {
      const { db, closePersistenceForTests } = require("./server");
      const rows = db.prepare("SELECT key, value FROM portal_settings WHERE key IN ('wifi_minimum_presence_minutes','wifi_absence_grace_minutes') ORDER BY key").all();
      process.stdout.write(JSON.stringify(rows));
      await closePersistenceForTests();
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const restarted = spawnSync(process.execPath, ["-e", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15000,
  });
  assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout);
  assert.deepEqual(JSON.parse(restarted.stdout), [
    { key: "wifi_absence_grace_minutes", value: "73" },
    { key: "wifi_minimum_presence_minutes", value: "17" },
  ]);
});

test("v0.65: Vertrauensstufen bleiben gespeichert, sind abschaltbar und rollenabhängig sichtbar", async () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.65-settings-dashboard-foundation'").get());
  const admin = createPortalSession("101", "admin");
  const saved = await requestJson("/api/portal/v1/trust-level-settings", {
    method: "PUT",
    session: admin,
    body: {
      enabled: true,
      visibleToManagers: true,
      visibleToDepartmentManagers: false,
      visibleToEmployees: false,
      levels: [{ employeeNumber: "102", level: "A" }],
    },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.changed, 1);
  assert.equal(saved.payload.visibleToManagers, true);

  const manager = createPortalSession("105", "manager", ["employees:write"]);
  const managerEmployees = await requestJson("/api/employees", { session: manager });
  assert.equal(managerEmployees.response.status, 200, JSON.stringify(managerEmployees.payload));
  assert.ok(managerEmployees.payload.some((employee) => "time_confirmation_level" in employee));

  const employee = createPortalSession("102", "employee");
  const ownWifi = await requestJson("/api/portal/v1/me/wifi-automation", { session: employee });
  assert.equal(ownWifi.response.status, 200, JSON.stringify(ownWifi.payload));
  assert.equal(ownWifi.payload.confirmationLevelVisible, false);
  assert.equal(ownWifi.payload.confirmationLevel, null);

  const adminAgain = createPortalSession("101", "admin");
  const disabled = await requestJson("/api/portal/v1/trust-level-settings", {
    method: "PUT",
    session: adminAgain,
    body: {
      enabled: false,
      visibleToManagers: true,
      visibleToDepartmentManagers: true,
      visibleToEmployees: true,
      levels: [{ employeeNumber: "102", level: "A" }],
    },
  });
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
  assert.equal(disabled.payload.enabled, false);
  assert.equal(db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = '102'").get().time_confirmation_level, "A");

  const employeeAgain = createPortalSession("102", "employee");
  const weekClose = await requestJson("/api/portal/v1/me/wifi-suggestions/confirm-week", {
    method: "POST",
    session: employeeAgain,
    body: { weekStart: "2026-07-13", suggestions: [] },
  });
  assert.equal(weekClose.response.status, 403, JSON.stringify(weekClose.payload));
  assert.equal(weekClose.payload.code, "WIFI_WEEK_CONFIRMATION_NOT_ALLOWED");
});

test("v0.65: Startverhalten ist standardmäßig aktiv und nur durch Personalleitung oder höher änderbar", async () => {
  const locationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = '105'").get().home_location_id;
  const manager = createPortalSession("105", "manager", ["settings:write"]);
  const current = await requestJson(`/api/settings?location=${encodeURIComponent(locationId)}`, { session: manager });
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  assert.equal(current.payload.remember_last_schedule_overall_plan, "1");
  assert.equal(current.payload.remember_last_vacation_overall_plan, "1");

  const denied = await requestJson("/api/settings", {
    method: "PUT",
    session: manager,
    body: settingsUpdateBody(current.payload, locationId, {
      rememberLastScheduleOverallPlan: false,
      rememberLastVacationOverallPlan: true,
    }),
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'remember_last_schedule_overall_plan'").get().value, "1");

  const admin = createPortalSession("101", "admin");
  const changed = await requestJson("/api/settings", {
    method: "PUT",
    session: admin,
    body: settingsUpdateBody(current.payload, locationId, {
      rememberLastScheduleOverallPlan: false,
      rememberLastVacationOverallPlan: true,
    }),
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.remember_last_schedule_overall_plan, "0");
  assert.equal(changed.payload.remember_last_vacation_overall_plan, "1");
});

test("v0.56: Event-Inbox ist gehasht und idempotent, eine Session darf zwei Arbeitstage vorschlagen", () => {
  const providerId = "radius-test";
  const rawExternalEventId = "raw-event-4711";
  const externalEventHash = crypto.createHash("sha256").update(rawExternalEventId).digest("hex");
  const subjectHash = crypto.createHash("sha256").update("employee-101@example.test").digest("hex");
  const locationHash = crypto.createHash("sha256").update("access-point-filiale-01").digest("hex");
  const payloadFingerprint = crypto.createHash("sha256").update("minimal-normalized-event").digest("hex");
  const insertEvent = db.prepare(`
    INSERT INTO wifi_event_inbox
      (id, provider_id, external_event_hash, event_type, external_subject_hash,
       location_reference_hash, occurred_at, payload_fingerprint)
    VALUES (?, ?, ?, 'connected', ?, ?, ?, ?)
  `);
  insertEvent.run("event-1", providerId, externalEventHash, subjectHash, locationHash, "2026-07-14T21:55:00.000Z", payloadFingerprint);
  assert.throws(
    () => insertEvent.run("event-2", providerId, externalEventHash, subjectHash, locationHash, "2026-07-14T21:55:01.000Z", payloadFingerprint),
    /UNIQUE constraint failed: wifi_event_inbox\.provider_id, wifi_event_inbox\.external_event_hash/,
  );
  const storedEvent = db.prepare("SELECT * FROM wifi_event_inbox WHERE id = 'event-1'").get();
  assert.match(storedEvent.external_event_hash, /^[a-f0-9]{64}$/);
  assert.equal(storedEvent.external_event_hash, externalEventHash);
  assert.notEqual(storedEvent.external_event_hash, rawExternalEventId);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM wifi_event_inbox").get().count, 1);

  db.prepare(`
    INSERT INTO wifi_presence_sessions
      (id, employee_number, location_id, provider_id, correlation_hash, observed_start_at,
       last_seen_at, disconnect_observed_at, observed_end_at, state)
    VALUES ('session-midnight', '101', '01', ?, ?, '2026-07-14T21:55:00.000Z',
      '2026-07-15T00:30:00.000Z', '2026-07-15T00:30:00.000Z', '2026-07-15T00:30:00.000Z', 'closed')
  `).run(providerId, crypto.createHash("sha256").update("correlation-1").digest("hex"));
  const insertSuggestion = db.prepare(`
    INSERT INTO wifi_time_suggestions
      (id, presence_session_id, employee_number, location_id, work_date,
       suggested_start_at, suggested_end_at, confirmation_level_snapshot,
       minimum_presence_minutes_snapshot, absence_grace_minutes_snapshot)
    VALUES (?, 'session-midnight', '101', '01', ?, ?, ?, 'C', 5, 30)
  `);
  insertSuggestion.run("suggestion-day-1", "2026-07-14", "2026-07-14T21:55:00.000Z", "2026-07-14T21:59:59.999Z");
  insertSuggestion.run("suggestion-day-2", "2026-07-15", "2026-07-15T00:00:00.000Z", "2026-07-15T00:30:00.000Z");
  assert.deepEqual(
    db.prepare("SELECT work_date FROM wifi_time_suggestions WHERE presence_session_id = 'session-midnight' ORDER BY work_date").all().map((row) => row.work_date),
    ["2026-07-14", "2026-07-15"],
  );
  assert.throws(
    () => insertSuggestion.run("suggestion-day-2-duplicate", "2026-07-15", "2026-07-15T00:01:00.000Z", "2026-07-15T00:29:00.000Z"),
    /UNIQUE constraint failed: wifi_time_suggestions\.presence_session_id, wifi_time_suggestions\.work_date/,
  );
});
