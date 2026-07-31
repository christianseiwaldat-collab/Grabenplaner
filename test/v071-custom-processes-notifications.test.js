"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-custom-processes-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.GRABENPLANER_SMS_WEBHOOK_URL = "https://notifications.invalid/grabenplaner/process";
process.env.GRABENPLANER_SMS_WEBHOOK_TOKEN = "test-sms-token";
process.env.GRABENPLANER_SMS_SENDER = "test-approved-sender";
process.env.GRABENPLANER_SMS_SENDER_APPROVED = "1";
process.env.GRABENPLANER_SMS_DISPATCH_ENABLED = "1";
process.env.GRABENPLANER_SMS_ALLOWED_EVENTS = "destination_verification,process_notification";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const nativeFetch = globalThis.fetch;
let deliveredVerificationCode = "";
const deliveredProcessPayloads = [];
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://notifications.invalid/")) {
    const payload = JSON.parse(String(options?.body || "{}"));
    if (payload.event === "destination_verification") deliveredVerificationCode = String(payload.code || "");
    if (payload.event === "process_notification") deliveredProcessPayloads.push(payload);
    return { ok: true };
  }
  return nativeFetch(url, options);
};

const { app, db, processOutboundNotificationJobs, reconcileCustomProcessTriggers, releaseInstanceLockForTests } = require("../server");

let httpServer;
let baseUrl;
let locationId;
let departmentId;
let auth;

function upsertEmployee(personnelNumber, fullName, role) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, position_id,
       home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#287a67', 38.5, 'verkaufsmitarbeiter', ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name, nickname = excluded.nickname,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id, active = 1
  `).run(personnelNumber, fullName, fullName.split(" ")[0], locationId, departmentId);
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      password_hash = 'test-only', role = excluded.role, role_locked = 0, active = 1,
      must_change_password = 0, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run(personnelNumber, role);
}

function createSession(personnelNumber) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(personnelNumber);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), personnelNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(token)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function api(route, { method = "GET", auth: requestAuth = null, body, includeCsrf = true } = {}) {
  const headers = { Accept: "application/json" };
  if (requestAuth) headers.Cookie = requestAuth.cookie;
  if (requestAuth && includeCsrf && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = requestAuth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function processPayload(overrides = {}) {
  const base = {
    title: `Notbesetzung ${crypto.randomBytes(4).toString("hex")}`,
    symbol: "NB",
    description: "Eine lokale Notbesetzung wird kontrolliert und nachvollziehbar eskaliert.",
    category: "personnel_absence",
    status: "draft",
    scope: { type: "location", locationId },
    trigger: { type: "manual", minimumShortfall: 1 },
    steps: [
      {
        type: "actor",
        title: "Besetzung prüfen",
        description: "Die verantwortliche Leitung prüft die aktuelle Besetzung.",
        responsibilityType: "role",
        responsibilityReference: "manager",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["internal"],
      },
      {
        type: "finish",
        title: "Vorgehen dokumentieren",
        description: "Die getroffene Entscheidung wird nachvollziehbar abgeschlossen.",
        responsibilityType: "system",
        responsibilityReference: "",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...(overrides.scope || {}) },
    trigger: { ...base.trigger, ...(overrides.trigger || {}) },
    steps: overrides.steps || base.steps,
  };
}

async function createProcess(payload = processPayload(), requestAuth = auth.hr) {
  const result = await api("/api/portal/v1/custom-processes", {
    method: "POST", auth: requestAuth, body: payload,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.ok(result.payload?.id, JSON.stringify(result.payload));
  assert.equal(result.payload.source, "custom");
  assert.equal(result.payload.category, payload.category);
  assert.equal(Number(result.payload.revision), 1);
  return { process: result.payload, payload };
}

async function configureManagerSmsProcessNotifications(processEnabled) {
  void processEnabled;
  const masterPhone = await api("/api/portal/v1/personnel-records/8713", {
    method: "PUT",
    auth: auth.hr,
    body: { phone: "+436601234567" },
  });
  assert.equal(masterPhone.response.status, 200, JSON.stringify(masterPhone.payload));
  const settings = await api("/api/portal/v1/me/email-settings", { auth: auth.manager });
  if (settings.payload.targets.phone.status !== "verified") {
    deliveredVerificationCode = "";
    const verification = await api("/api/portal/v1/me/email-settings/verification", {
      method: "POST",
      auth: auth.manager,
      body: { channel: "sms" },
    });
    assert.equal(verification.response.status, 200, JSON.stringify(verification.payload));
    assert.match(deliveredVerificationCode, /^\d{6}$/);
    const confirmed = await api("/api/portal/v1/me/email-settings/verification/confirm", {
      method: "POST",
      auth: auth.manager,
      body: { channel: "sms", code: deliveredVerificationCode },
    });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.payload));
  }
  const saved = await api("/api/portal/v1/me/email-settings/categories", {
    method: "PUT",
    auth: auth.manager,
    body: { channels: { sms: true }, earliestTime: "08:00" },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.channels.sms.enabled, true);
  assert.equal(saved.payload.categories.deliveryActive, false);
  return saved.payload;
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  departmentId = Number(db.prepare("SELECT id FROM departments WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 1").get(locationId)?.id || 0);
  if (!departmentId) {
    departmentId = Number(db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Prozesstest', 1, 1, 99)
    `).run(locationId).lastInsertRowid);
  }

  upsertEmployee("8711", "Petra Personal", "hr");
  upsertEmployee("8712", "Anton Admin", "admin");
  upsertEmployee("8713", "Mara Markt", "manager");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES ('8713', ?, 0, 'v071-test')
    ON CONFLICT(employee_number, location_id, department_id) DO NOTHING
  `).run(locationId);

  // Ein direkt eingetragener Grant darf die feste PL+-Grenze nicht umgehen.
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by, updated_at)
    VALUES ('8713', 'processes:write', 'v071-test', CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number, permission) DO UPDATE SET granted_by = excluded.granted_by
  `).run();

  auth = {
    hr: createSession("8711"),
    admin: createSession("8712"),
    manager: createSession("8713"),
  };

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  globalThis.fetch = nativeFetch;
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.71: persistentes Prozessmodell und Migration sind vorhanden", () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.71-custom-processes-notifications'").get());
  for (const table of ["custom_processes", "custom_process_steps", "custom_process_runs"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  const columns = db.prepare("PRAGMA table_info(custom_processes)").all().map((column) => column.name);
  assert.ok(columns.includes("category"));
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const marker of ["addCustomProcessButton", "customProcessModal", "customProcessCategory", "customProcessSteps", "rightsCustomProcessActions"]) assert.ok(html.includes(marker), marker);
  for (const marker of ["populateCustomProcessCategories", "openCustomProcessEditor", "saveCustomProcess", "changeCustomProcessStatus", "triggerCustomProcess"]) assert.ok(script.includes(marker), marker);
  assert.ok(styles.includes(".custom-process-step-card"));
});

test("v0.71: nur PL+ darf Prozesse verwalten und jede Mutation bleibt CSRF-geschützt", async () => {
  const anonymous = await api("/api/portal/v1/custom-processes", {
    method: "POST", body: processPayload(),
  });
  assert.equal(anonymous.response.status, 401, JSON.stringify(anonymous.payload));

  const missingCsrf = await api("/api/portal/v1/custom-processes", {
    method: "POST", auth: auth.hr, includeCsrf: false, body: processPayload(),
  });
  assert.equal(missingCsrf.response.status, 403, JSON.stringify(missingCsrf.payload));

  const managerWithInjectedGrant = await api("/api/portal/v1/custom-processes", {
    method: "POST", auth: auth.manager, body: processPayload(),
  });
  assert.equal(managerWithInjectedGrant.response.status, 403, JSON.stringify(managerWithInjectedGrant.payload));

  const created = await createProcess(processPayload(), auth.hr);
  assert.equal(created.process.status, "draft");
  const adminCreated = await createProcess(processPayload({ scope: { type: "company", locationId: undefined } }), auth.admin);
  assert.equal(adminCreated.process.scope.type, "company");
});

test("v0.71: Rechte-Dashboard verbindet Standard- und eigene Prozesse mit eindeutiger Fähigkeit", async () => {
  const { process } = await createProcess(processPayload({ category: "customer_service" }));
  const hrDashboard = await api("/api/portal/v1/rights-dashboard", { auth: auth.hr });
  assert.equal(hrDashboard.response.status, 200, JSON.stringify(hrDashboard.payload));
  assert.equal(hrDashboard.payload.processDashboard.capabilities.canManageCustomProcesses, true);
  assert.ok(hrDashboard.payload.processDashboard.capabilities.categories.some((category) => category.id === "customer_service"));
  assert.ok(hrDashboard.payload.processDashboard.processes.some((entry) => entry.id === "vacation"));
  assert.ok(hrDashboard.payload.processDashboard.processes.some((entry) => entry.id === process.id
    && entry.source === "custom" && entry.category === "customer_service"));

});

test("v0.71: Scope, Bedingungsfelder und unbekannte Ausdrücke werden strikt validiert", async () => {
  const unknownField = await api("/api/portal/v1/custom-processes", {
    method: "POST", auth: auth.hr, body: { ...processPayload(), untrustedPayload: "nicht erlaubt" },
  });
  assert.equal(unknownField.response.status, 400, JSON.stringify(unknownField.payload));

  const invalidCategory = await api("/api/portal/v1/custom-processes", {
    method: "POST", auth: auth.hr, body: processPayload({ category: "beliebig" }),
  });
  assert.equal(invalidCategory.response.status, 400, JSON.stringify(invalidCategory.payload));
  assert.equal(invalidCategory.payload.code, "CUSTOM_PROCESS_CATEGORY_INVALID");

  const invalidScope = await api("/api/portal/v1/custom-processes", {
    method: "POST",
    auth: auth.hr,
    body: processPayload({ scope: { type: "location", locationId: "v071-location-does-not-exist" } }),
  });
  assert.equal(invalidScope.response.status, 400, JSON.stringify(invalidScope.payload));

  const invalidConditionPayload = processPayload();
  invalidConditionPayload.steps[0] = {
    ...invalidConditionPayload.steps[0],
    conditionType: "when",
    conditionText: "Mindestbesetzung ist unterschritten",
    expression: "staffing.shortfall >= 1; DROP TABLE employees",
  };
  const invalidCondition = await api("/api/portal/v1/custom-processes", {
    method: "POST", auth: auth.hr, body: invalidConditionPayload,
  });
  assert.equal(invalidCondition.response.status, 400, JSON.stringify(invalidCondition.payload));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'employees'").get());

  const unknownStepFieldPayload = processPayload();
  unknownStepFieldPayload.steps[0] = { ...unknownStepFieldPayload.steps[0], destination: "+436601234567" };
  const unknownStepField = await api("/api/portal/v1/custom-processes", {
    method: "POST", auth: auth.hr, body: unknownStepFieldPayload,
  });
  assert.equal(unknownStepField.response.status, 400, JSON.stringify(unknownStepField.payload));

  const conditionalNotificationPayload = processPayload();
  conditionalNotificationPayload.steps[0] = {
    ...conditionalNotificationPayload.steps[0],
    conditionType: "when",
    conditionText: "Nur nach einer ausdrücklich bestätigten Entscheidung",
    notificationChannels: ["internal"],
  };
  const conditionalNotification = await api("/api/portal/v1/custom-processes", {
    method: "POST", auth: auth.hr, body: conditionalNotificationPayload,
  });
  assert.equal(conditionalNotification.response.status, 400, JSON.stringify(conditionalNotification.payload));
});

test("v0.71: technische Schritt-IDs dürfen nicht prozessübergreifend kollidieren", async () => {
  const sharedStepId = `v071-shared-${crypto.randomBytes(6).toString("hex")}`;
  const firstPayload = processPayload();
  firstPayload.steps[0] = { ...firstPayload.steps[0], id: sharedStepId };
  await createProcess(firstPayload);

  const conflictingPayload = processPayload();
  conflictingPayload.steps[0] = { ...conflictingPayload.steps[0], id: sharedStepId };
  const conflicting = await api("/api/portal/v1/custom-processes", {
    method: "POST",
    auth: auth.hr,
    body: conflictingPayload,
  });
  assert.equal(conflicting.response.status, 409, JSON.stringify(conflicting.payload));
  assert.doesNotMatch(JSON.stringify(conflicting.payload), /SQLITE|UNIQUE constraint/i);
});

test("v0.71: Änderungen sind revisionssicher und Archivierung löscht weder Prozess noch Schritte", async () => {
  const { process, payload } = await createProcess();
  const updateBody = {
    ...payload,
    title: `${payload.title} – geprüft`,
    category: "administration_it",
    status: "active",
    revision: process.revision,
  };
  const updated = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}`, {
    method: "PUT", auth: auth.hr, body: updateBody,
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.title, updateBody.title);
  assert.equal(updated.payload.category, "administration_it");
  assert.equal(updated.payload.status, "active");
  assert.equal(Number(updated.payload.revision), Number(process.revision) + 1);

  const stale = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}`, {
    method: "PUT", auth: auth.hr, body: { ...updateBody, title: "Veraltete Änderung" },
  });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));

  const archived = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/status`, {
    method: "PUT",
    auth: auth.hr,
    body: { status: "archived", revision: updated.payload.revision },
  });
  assert.equal(archived.response.status, 200, JSON.stringify(archived.payload));
  assert.equal(archived.payload.status, "archived");
  const stored = db.prepare("SELECT status, category FROM custom_processes WHERE id = ?").get(process.id);
  assert.equal(stored.status, "archived");
  assert.equal(stored.category, "administration_it");
  assert.ok(Number(db.prepare("SELECT COUNT(*) AS count FROM custom_process_steps WHERE process_id = ?").get(process.id).count) >= 1);

  const archivedTrigger = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST", auth: auth.hr, body: { idempotencyKey: "v071-archived" },
  });
  assert.ok([404, 409].includes(archivedTrigger.response.status), JSON.stringify(archivedTrigger.payload));
});

test("v0.71: manueller Start ist idempotent und interne Hinweise werden dedupliziert", async () => {
  const { process } = await createProcess(processPayload({
    status: "active",
    steps: [
      {
        type: "actor",
        title: "Leitung verständigen",
        description: "Die zuständige Filialleitung erhält einen neutralen internen Hinweis.",
        responsibilityType: "role",
        responsibilityReference: "manager",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["internal"],
      },
      {
        type: "finish",
        title: "Hinweis dokumentieren",
        description: "Der ausgelöste Hinweis bleibt nachvollziehbar dokumentiert.",
        responsibilityType: "system",
        responsibilityReference: "",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  }));
  const before = Number(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '8713'").get().count);
  const missingIdempotency = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST", auth: auth.hr, body: {},
  });
  assert.equal(missingIdempotency.response.status, 400, JSON.stringify(missingIdempotency.payload));
  const idempotencyKey = `v071-manual-${crypto.randomUUID()}`;
  const first = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST", auth: auth.hr, body: { idempotencyKey },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.ok(first.payload.run?.id, JSON.stringify(first.payload));
  assert.ok(first.payload.notifications, JSON.stringify(first.payload));

  const repeated = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST", auth: auth.hr, body: { idempotencyKey },
  });
  assert.ok([200, 201].includes(repeated.response.status), JSON.stringify(repeated.payload));
  assert.equal(repeated.payload.run.id, first.payload.run.id);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM custom_process_runs WHERE process_id = ?").get(process.id).count), 1);
  const after = Number(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '8713'").get().count);
  assert.equal(after - before, 1);

  const storedNotifications = db.prepare(`
    SELECT title, message, target, entity_type, entity_id, dedupe_key
    FROM portal_notifications WHERE recipient_employee_number = '8713'
    ORDER BY created_at, id
  `).all();
  assert.equal(JSON.stringify(storedNotifications).includes("1234 010180"), false);

  const sensitiveTrigger = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST",
    auth: auth.hr,
    body: { idempotencyKey: `v071-sensitive-${crypto.randomUUID()}`, socialSecurityNumber: "1234 010180" },
  });
  assert.equal(sensitiveTrigger.response.status, 400, JSON.stringify(sensitiveTrigger.payload));
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM custom_process_runs WHERE process_id = ?").all(process.id)).includes("1234 010180"), false);
});

test("v0.71: ein wiederholter manueller Start öffnet einen erledigten Lauf nicht erneut", async () => {
  const { process } = await createProcess(processPayload({ status: "active" }));
  const idempotencyKey = `v071-finished-manual-${crypto.randomUUID()}`;
  const first = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST",
    auth: auth.hr,
    body: { idempotencyKey },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  const runId = first.payload.run.id;
  const tasks = await api("/api/portal/v1/me/process-tasks", { auth: auth.manager });
  const task = tasks.payload.tasks.find((entry) => entry.runId === runId);
  assert.ok(task, JSON.stringify(tasks.payload));
  const completed = await api(`/api/portal/v1/me/process-tasks/${encodeURIComponent(runId)}/${encodeURIComponent(task.stepId)}/complete`, {
    method: "POST",
    auth: auth.manager,
    body: {
      activationCount: task.activationCount,
      idempotencyKey: `v071-finished-task-${crypto.randomUUID()}`,
      note: "Erledigt",
    },
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
  const beforeRetry = db.prepare("SELECT status, activation_count FROM custom_process_runs WHERE id = ?").get(runId);
  assert.equal(beforeRetry.status, "resolved");

  const repeated = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST",
    auth: auth.hr,
    body: { idempotencyKey },
  });
  assert.equal(repeated.response.status, 200, JSON.stringify(repeated.payload));
  assert.equal(repeated.payload.duplicate, true);
  assert.equal(repeated.payload.run.id, runId);
  const afterRetry = db.prepare("SELECT status, activation_count FROM custom_process_runs WHERE id = ?").get(runId);
  assert.equal(afterRetry.status, "resolved");
  assert.equal(Number(afterRetry.activation_count), Number(beforeRetry.activation_count));
  const remaining = await api("/api/portal/v1/me/process-tasks", { auth: auth.manager });
  assert.equal(remaining.payload.tasks.some((entry) => entry.runId === runId), false);
});

test("v0.71: manuelle Prozesse mit deaktiviertem Standort- oder Abteilungsscope werden abgewiesen", async () => {
  const locationProcess = await createProcess(processPayload({ status: "active" }));
  db.prepare("UPDATE locations SET active = 0 WHERE id = ?").run(locationId);
  try {
    const inactiveLocation = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(locationProcess.process.id)}/trigger`, {
      method: "POST",
      auth: auth.hr,
      body: { idempotencyKey: `v071-inactive-location-${crypto.randomUUID()}` },
    });
    assert.equal(inactiveLocation.response.status, 409, JSON.stringify(inactiveLocation.payload));
  } finally {
    db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(locationId);
  }

  const departmentProcess = await createProcess(processPayload({
    status: "active",
    scope: { type: "department", locationId, departmentId },
  }));
  db.prepare("UPDATE departments SET active = 0 WHERE id = ?").run(departmentId);
  try {
    const inactiveDepartment = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(departmentProcess.process.id)}/trigger`, {
      method: "POST",
      auth: auth.hr,
      body: { idempotencyKey: `v071-inactive-department-${crypto.randomUUID()}` },
    });
    assert.equal(inactiveDepartment.response.status, 409, JSON.stringify(inactiveDepartment.payload));
  } finally {
    db.prepare("UPDATE departments SET active = 1 WHERE id = ?").run(departmentId);
  }
});

test("v0.71: abteilungsgebundene Mitarbeiteraufgaben bleiben in der eigenen Abteilung", async () => {
  let otherDepartmentId = Number(db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND id <> ? AND active = 1
    ORDER BY id LIMIT 1
  `).get(locationId, departmentId)?.id || 0);
  if (!otherDepartmentId) {
    otherDepartmentId = Number(db.prepare(`
      INSERT INTO departments (location_id, name, min_staff, active, sort_order)
      VALUES (?, 'Fremde Prozessabteilung', 1, 1, 100)
    `).run(locationId).lastInsertRowid);
  }
  upsertEmployee("8721", "Eva Eigene Abteilung", "employee");
  upsertEmployee("8722", "Fritz Fremde Abteilung", "employee");
  db.prepare("UPDATE employees SET preferred_department_id = ? WHERE personnel_number = '8722'")
    .run(otherDepartmentId);
  const ownDepartmentSession = createSession("8721");
  const foreignDepartmentSession = createSession("8722");
  const { process } = await createProcess(processPayload({
    status: "active",
    scope: { type: "department", locationId, departmentId },
    steps: [
      {
        type: "actor",
        title: "Abteilungsaufgabe erledigen",
        description: "Nur Mitarbeitende der ausgewählten Abteilung dürfen diese Aufgabe sehen.",
        responsibilityType: "role",
        responsibilityReference: "employee",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["internal"],
      },
      {
        type: "finish",
        title: "Abteilungsablauf abschließen",
        description: "Der technische Abschluss folgt auf die geschützte Mitarbeiteraufgabe.",
        responsibilityType: "system",
        responsibilityReference: "",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  }));
  const triggered = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST",
    auth: auth.hr,
    body: { idempotencyKey: `v071-department-task-${crypto.randomUUID()}` },
  });
  assert.equal(triggered.response.status, 200, JSON.stringify(triggered.payload));
  const runId = triggered.payload.run.id;

  const ownTasks = await api("/api/portal/v1/me/process-tasks", { auth: ownDepartmentSession });
  const ownTask = ownTasks.payload.tasks.find((entry) => entry.runId === runId);
  assert.ok(ownTask, JSON.stringify(ownTasks.payload));
  const foreignTasks = await api("/api/portal/v1/me/process-tasks", { auth: foreignDepartmentSession });
  assert.equal(foreignTasks.payload.tasks.some((entry) => entry.runId === runId), false);
  const forbiddenCompletion = await api(
    `/api/portal/v1/me/process-tasks/${encodeURIComponent(runId)}/${encodeURIComponent(ownTask.stepId)}/complete`,
    {
      method: "POST",
      auth: foreignDepartmentSession,
      body: {
        activationCount: ownTask.activationCount,
        idempotencyKey: `v071-foreign-task-${crypto.randomUUID()}`,
      },
    },
  );
  assert.equal(forbiddenCompletion.response.status, 404, JSON.stringify(forbiddenCompletion.payload));

  const ownCompletion = await api(
    `/api/portal/v1/me/process-tasks/${encodeURIComponent(runId)}/${encodeURIComponent(ownTask.stepId)}/complete`,
    {
      method: "POST",
      auth: ownDepartmentSession,
      body: {
        activationCount: ownTask.activationCount,
        idempotencyKey: `v071-own-task-${crypto.randomUUID()}`,
      },
    },
  );
  assert.equal(ownCompletion.response.status, 200, JSON.stringify(ownCompletion.payload));
  assert.equal(db.prepare("SELECT status FROM custom_process_runs WHERE id = ?").get(runId).status, "resolved");
});

test("v0.71: historische Revision und schrittweise Aufgaben bleiben auch nach Änderungen stabil", async () => {
  const originalPayload = processPayload({
    status: "active",
    steps: [
      {
        type: "actor",
        title: "Erste Aufgabe prüfen",
        description: "Die erste Aufgabe wird einzeln zugewiesen.",
        responsibilityType: "role",
        responsibilityReference: "manager",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["internal"],
      },
      {
        type: "approval",
        title: "Zweite Aufgabe freigeben",
        description: "Erst nach Abschluss der ersten Aufgabe wird dieser Schritt aktiv.",
        responsibilityType: "role",
        responsibilityReference: "manager",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["internal"],
      },
      {
        type: "finish",
        title: "Ablauf abschließen",
        description: "Der technische Abschluss erfolgt ohne weitere Benachrichtigung.",
        responsibilityType: "system",
        responsibilityReference: "",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  });
  const { process } = await createProcess(originalPayload);
  const triggerKey = `v071-sequence-${crypto.randomUUID()}`;
  const triggered = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST", auth: auth.hr, body: { idempotencyKey: triggerKey },
  });
  assert.equal(triggered.response.status, 200, JSON.stringify(triggered.payload));
  const runId = triggered.payload.run.id;

  const updated = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}`, {
    method: "PUT",
    auth: auth.hr,
    body: { ...originalPayload, title: `${originalPayload.title} neu`, revision: process.revision },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  const revisions = db.prepare("SELECT revision, snapshot_json FROM custom_process_revisions WHERE process_id = ? ORDER BY revision").all(process.id);
  assert.deepEqual(revisions.map((entry) => Number(entry.revision)), [1, 2]);
  assert.equal(JSON.parse(revisions[0].snapshot_json).title, originalPayload.title);
  assert.equal(JSON.parse(revisions[1].snapshot_json).title, `${originalPayload.title} neu`);

  const firstTasks = await api("/api/portal/v1/me/process-tasks", { auth: auth.manager });
  assert.equal(firstTasks.response.status, 200, JSON.stringify(firstTasks.payload));
  const first = firstTasks.payload.tasks.find((task) => task.runId === runId);
  assert.equal(first.stepTitle, "Erste Aufgabe prüfen");
  assert.equal(first.processTitle, originalPayload.title);

  const firstCompletionKey = `v071-task-${crypto.randomUUID()}`;
  const firstCompleted = await api(`/api/portal/v1/me/process-tasks/${encodeURIComponent(runId)}/${encodeURIComponent(first.stepId)}/complete`, {
    method: "POST", auth: auth.manager, body: {
      activationCount: first.activationCount,
      idempotencyKey: firstCompletionKey,
      note: "Geprüft",
    },
  });
  assert.equal(firstCompleted.response.status, 200, JSON.stringify(firstCompleted.payload));
  const secondTasks = await api("/api/portal/v1/me/process-tasks", { auth: auth.manager });
  const second = secondTasks.payload.tasks.find((task) => task.runId === runId);
  assert.equal(second.stepTitle, "Zweite Aufgabe freigeben");

  const secondCompletionKey = `v071-task-${crypto.randomUUID()}`;
  const secondCompleted = await api(`/api/portal/v1/me/process-tasks/${encodeURIComponent(runId)}/${encodeURIComponent(second.stepId)}/complete`, {
    method: "POST", auth: auth.manager, body: {
      activationCount: second.activationCount,
      idempotencyKey: secondCompletionKey,
      note: "Freigegeben",
    },
  });
  assert.equal(secondCompleted.response.status, 200, JSON.stringify(secondCompleted.payload));
  assert.equal(db.prepare("SELECT status FROM custom_process_runs WHERE id = ?").get(runId).status, "resolved");
  const repeated = await api(`/api/portal/v1/me/process-tasks/${encodeURIComponent(runId)}/${encodeURIComponent(second.stepId)}/complete`, {
    method: "POST", auth: auth.manager, body: {
      activationCount: second.activationCount,
      idempotencyKey: secondCompletionKey,
      note: "Freigegeben",
    },
  });
  assert.equal(repeated.response.status, 200, JSON.stringify(repeated.payload));
  assert.equal(repeated.payload.duplicate, true);
});

test("v0.71: externe Prozesshinweise bleiben trotz bestätigtem persönlichem Ziel deaktiviert", async () => {
  const { process } = await createProcess(processPayload({
    status: "active",
    steps: [
      {
        type: "actor",
        title: "Externe Bereitschaft informieren",
        description: "Der Hinweis enthält ausschließlich neutrale betriebliche Informationen.",
        responsibilityType: "role",
        responsibilityReference: "manager",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["sms"],
      },
      {
        type: "finish",
        title: "Versand dokumentieren",
        description: "Der kontrollierte Versand wird ohne fachliche Nutzdaten protokolliert.",
        responsibilityType: "system",
        responsibilityReference: "",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  }));

  db.prepare("DELETE FROM personal_notification_contacts WHERE employee_number = '8713'").run();
  db.prepare("DELETE FROM personnel_sensitive_records WHERE employee_number = '8713'").run();
  deliveredProcessPayloads.length = 0;
  const jobsBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM outbound_notification_jobs").get().count);
  const withoutVerifiedTarget = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST", auth: auth.hr, body: { idempotencyKey: `v071-unverified-${crypto.randomUUID()}` },
  });
  assert.equal(withoutVerifiedTarget.response.status, 200, JSON.stringify(withoutVerifiedTarget.payload));
  assert.equal(withoutVerifiedTarget.payload.notifications.blocked, 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM outbound_notification_jobs").get().count), jobsBefore);

  const personalSettings = await configureManagerSmsProcessNotifications(true);
  assert.equal(personalSettings.targets.phone.status, "verified");

  const withVerifiedTarget = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST", auth: auth.hr, body: { idempotencyKey: `v071-verified-${crypto.randomUUID()}` },
  });
  assert.equal(withVerifiedTarget.response.status, 200, JSON.stringify(withVerifiedTarget.payload));
  assert.equal(withVerifiedTarget.payload.notifications.blocked, 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM outbound_notification_jobs").get().count), jobsBefore);
  const dispatched = await processOutboundNotificationJobs(new Date("2099-12-31T23:00:00.000Z"));
  assert.equal(dispatched.sent, 0);
  assert.equal(deliveredProcessPayloads.length, 0);
});

test("v0.71: ein blockierter externer Prozesshinweis wird auch später nicht nachgereicht", async () => {
  await configureManagerSmsProcessNotifications(false);
  const { process } = await createProcess(processPayload({
    status: "active",
    steps: [
      {
        type: "actor",
        title: "Bereitschaft neutral informieren",
        description: "Die externe Prozessmeldung wird erst nach ausdrücklicher Freigabe des Kanals eingereiht.",
        responsibilityType: "role",
        responsibilityReference: "manager",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["sms"],
      },
      {
        type: "finish",
        title: "Versand abschließen",
        description: "Der Ablauf endet nach der zuständigen Bearbeitung.",
        responsibilityType: "system",
        responsibilityReference: "",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  }));
  const triggered = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST",
    auth: auth.hr,
    body: { idempotencyKey: `v071-blocked-retry-${crypto.randomUUID()}` },
  });
  assert.equal(triggered.response.status, 200, JSON.stringify(triggered.payload));
  assert.equal(triggered.payload.notifications.blocked, 1);
  const entityLookup = crypto.createHash("sha256")
    .update(`grabenplaner-custom-process-v1\0run\0${triggered.payload.run.id}`)
    .digest("hex");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM outbound_notification_jobs WHERE entity_lookup = ?").get(entityLookup).count), 0);

  await configureManagerSmsProcessNotifications(true);
  await reconcileCustomProcessTriggers(new Date("2099-06-15T10:00:00.000Z"));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM outbound_notification_jobs WHERE entity_lookup = ?").get(entityLookup).count), 0);
  assert.equal(deliveredProcessPayloads.length, 0);

  const tasks = await api("/api/portal/v1/me/process-tasks", { auth: auth.manager });
  const task = tasks.payload.tasks.find((entry) => entry.runId === triggered.payload.run.id);
  assert.ok(task, JSON.stringify(tasks.payload));
  const completed = await api(`/api/portal/v1/me/process-tasks/${encodeURIComponent(task.runId)}/${encodeURIComponent(task.stepId)}/complete`, {
    method: "POST",
    auth: auth.manager,
    body: {
      activationCount: task.activationCount,
      idempotencyKey: `v071-blocked-complete-${crypto.randomUUID()}`,
      note: "Bearbeitet",
    },
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
});

test("v0.71: fester Notbesetzungs-Auslöser öffnet und löst Prozessläufe automatisch", async () => {
  const date = "2099-05-04";
  db.prepare("UPDATE departments SET min_staff = 2 WHERE id = ?").run(departmentId);
  db.prepare("DELETE FROM shifts WHERE shift_date = ? AND department_id = ?").run(date, departmentId);
  const { process } = await createProcess(processPayload({
    status: "active",
    scope: { type: "department", locationId, departmentId },
    trigger: { type: "staffing_shortfall", minimumShortfall: 1 },
    steps: [
      {
        type: "actor",
        title: "Notbesetzung prüfen",
        description: "Die zuständige Leitung prüft den fest erkannten Fehlbestand.",
        responsibilityType: "role",
        responsibilityReference: "manager",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["internal"],
      },
      {
        type: "finish",
        title: "Besetzung sichern",
        description: "Der Prozess endet nach Wiederherstellung der Mindestbesetzung.",
        responsibilityType: "system",
        responsibilityReference: "",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  }));
  const triggered = await reconcileCustomProcessTriggers(new Date(`${date}T10:00:00.000Z`));
  assert.equal(triggered.triggered, 1);
  const run = db.prepare("SELECT * FROM custom_process_runs WHERE process_id = ?").get(process.id);
  assert.equal(run.status, "open");
  assert.ok(db.prepare(`
    SELECT 1 FROM portal_notifications
    WHERE recipient_employee_number = '8713' AND entity_type = 'custom_process_run' AND entity_id = ?
  `).get(run.id));

  const insertShift = db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, '09:00', '18:00', 'Test', '')
  `);
  insertShift.run("8711", locationId, departmentId, date);
  insertShift.run("8713", locationId, departmentId, date);
  const resolved = await reconcileCustomProcessTriggers(new Date(`${date}T10:05:00.000Z`));
  assert.equal(resolved.resolved, 1);
  assert.equal(db.prepare("SELECT status FROM custom_process_runs WHERE id = ?").get(run.id).status, "resolved");
  assert.ok(db.prepare("SELECT read_at FROM portal_notifications WHERE entity_type = 'custom_process_run' AND entity_id = ?").get(run.id).read_at);
});

test("v0.71: Notbesetzung wird je 15-Minuten-Slot und ohne abwesende oder inaktive MA bewertet", async () => {
  const sunday = "2099-05-10";
  const monday = "2099-05-11";
  db.prepare("UPDATE departments SET min_staff = 2 WHERE id = ?").run(departmentId);
  upsertEmployee("8714", "Tina Teilzeit", "employee");
  upsertEmployee("8715", "Ingo Inaktiv", "employee");
  db.prepare("UPDATE employees SET active = 0 WHERE personnel_number = '8715'").run();
  for (const date of [sunday, monday]) {
    db.prepare("DELETE FROM shifts WHERE shift_date = ?").run(date);
    db.prepare("DELETE FROM week_options WHERE ? BETWEEN date_from AND date_to").run(date);
  }
  const { process } = await createProcess(processPayload({
    status: "active",
    scope: { type: "department", locationId, departmentId },
    trigger: { type: "staffing_shortfall", minimumShortfall: 1 },
  }));
  db.prepare(`
    DELETE FROM portal_notifications WHERE entity_type = 'custom_process_run'
      AND entity_id IN (SELECT id FROM custom_process_runs WHERE process_id = ?)
  `).run(process.id);
  db.prepare("DELETE FROM custom_process_runs WHERE process_id = ?").run(process.id);
  await reconcileCustomProcessTriggers(new Date(`${sunday}T10:00:00.000Z`));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM custom_process_runs WHERE process_id = ?").get(process.id).count), 0);

  const insertShift = db.prepare(`
    INSERT INTO shifts (employee_number, location_id, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, ?, 'Test', '')
  `);
  insertShift.run("8713", locationId, departmentId, monday, "09:00", "12:00");
  insertShift.run("8714", locationId, departmentId, monday, "12:00", "18:00");
  insertShift.run("8715", locationId, departmentId, monday, "09:00", "18:00");
  const partial = await reconcileCustomProcessTriggers(new Date(`${monday}T10:00:00.000Z`));
  assert.ok(partial.triggered >= 1);
  const run = db.prepare("SELECT * FROM custom_process_runs WHERE process_id = ?").get(process.id);
  assert.equal(run.status, "open");

  db.prepare("UPDATE shifts SET start_time = '09:00', end_time = '18:00' WHERE shift_date = ? AND employee_number IN ('8713','8714')").run(monday);
  db.prepare(`
    INSERT INTO week_options (week_start, group_id, employee_number, date_from, date_to, option_type, note, all_day)
    VALUES (?, 'v071-absence', '8714', ?, ?, 'training', 'Test', 1)
  `).run(monday, monday, monday);
  const absent = await reconcileCustomProcessTriggers(new Date(`${monday}T10:05:00.000Z`));
  assert.equal(absent.resolved, 0);
  assert.equal(db.prepare("SELECT status FROM custom_process_runs WHERE id = ?").get(run.id).status, "open");

  db.prepare("DELETE FROM week_options WHERE group_id = 'v071-absence'").run();
  const covered = await reconcileCustomProcessTriggers(new Date(`${monday}T10:10:00.000Z`));
  assert.ok(covered.resolved >= 1);
  assert.equal(db.prepare("SELECT status FROM custom_process_runs WHERE id = ?").get(run.id).status, "resolved");
});

test("v0.71: Aufgabenabschluss ist an die aktuelle Laufaktivierung gebunden", async () => {
  const date = "2099-08-03";
  const isolatedDepartmentId = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, ?, 1, 1, 991)
  `).run(locationId, `Aktivierungstest ${crypto.randomBytes(3).toString("hex")}`).lastInsertRowid);
  const { process } = await createProcess(processPayload({
    status: "active",
    scope: { type: "department", locationId, departmentId: isolatedDepartmentId },
    trigger: { type: "staffing_shortfall", minimumShortfall: 1 },
  }));
  try {
    db.prepare(`
      DELETE FROM portal_notifications WHERE entity_type = 'custom_process_run'
        AND entity_id IN (SELECT id FROM custom_process_runs WHERE process_id = ?)
    `).run(process.id);
    db.prepare(`
      DELETE FROM custom_process_run_steps
      WHERE run_id IN (SELECT id FROM custom_process_runs WHERE process_id = ?)
    `).run(process.id);
    db.prepare("DELETE FROM custom_process_runs WHERE process_id = ?").run(process.id);
    db.prepare("DELETE FROM shifts WHERE shift_date = ? AND department_id = ?").run(date, isolatedDepartmentId);

    const firstSweep = await reconcileCustomProcessTriggers(new Date(`${date}T10:00:00.000Z`));
    assert.ok(firstSweep.triggered >= 1, JSON.stringify(firstSweep));
    const run = db.prepare("SELECT * FROM custom_process_runs WHERE process_id = ?").get(process.id);
    assert.ok(run);
    const firstTasks = await api("/api/portal/v1/me/process-tasks", { auth: auth.manager });
    const firstTask = firstTasks.payload.tasks.find((entry) => entry.runId === run.id);
    assert.ok(firstTask, JSON.stringify(firstTasks.payload));
    const oldRequestId = `v071-old-activation-${crypto.randomUUID()}`;
    const firstCompleted = await api(`/api/portal/v1/me/process-tasks/${encodeURIComponent(run.id)}/${encodeURIComponent(firstTask.stepId)}/complete`, {
      method: "POST",
      auth: auth.manager,
      body: {
        activationCount: firstTask.activationCount,
        idempotencyKey: oldRequestId,
        note: "Erste Aktivierung erledigt",
      },
    });
    assert.equal(firstCompleted.response.status, 200, JSON.stringify(firstCompleted.payload));
    assert.equal(db.prepare("SELECT status FROM custom_process_runs WHERE id = ?").get(run.id).status, "resolved");

    const secondSweep = await reconcileCustomProcessTriggers(new Date(`${date}T10:05:00.000Z`));
    assert.ok(secondSweep.triggered >= 1, JSON.stringify(secondSweep));
    const reopened = db.prepare("SELECT * FROM custom_process_runs WHERE id = ?").get(run.id);
    assert.equal(reopened.status, "open");
    assert.equal(Number(reopened.activation_count), Number(firstTask.activationCount) + 1);
    const secondTasks = await api("/api/portal/v1/me/process-tasks", { auth: auth.manager });
    const secondTask = secondTasks.payload.tasks.find((entry) => entry.runId === run.id);
    assert.ok(secondTask, JSON.stringify(secondTasks.payload));
    assert.equal(Number(secondTask.activationCount), Number(reopened.activation_count));

    const staleCompletion = await api(`/api/portal/v1/me/process-tasks/${encodeURIComponent(run.id)}/${encodeURIComponent(secondTask.stepId)}/complete`, {
      method: "POST",
      auth: auth.manager,
      body: {
        activationCount: firstTask.activationCount,
        idempotencyKey: oldRequestId,
        note: "Veralteter Wiederholungsversuch",
      },
    });
    assert.equal(staleCompletion.response.status, 409, JSON.stringify(staleCompletion.payload));
    assert.equal(db.prepare("SELECT status FROM custom_process_run_steps WHERE run_id = ? AND step_id = ?").get(run.id, secondTask.stepId).status, "active");

    const currentCompletion = await api(`/api/portal/v1/me/process-tasks/${encodeURIComponent(run.id)}/${encodeURIComponent(secondTask.stepId)}/complete`, {
      method: "POST",
      auth: auth.manager,
      body: {
        activationCount: secondTask.activationCount,
        idempotencyKey: `v071-current-activation-${crypto.randomUUID()}`,
        note: "Aktuelle Aktivierung erledigt",
      },
    });
    assert.equal(currentCompletion.response.status, 200, JSON.stringify(currentCompletion.payload));
    assert.equal(db.prepare("SELECT status FROM custom_process_runs WHERE id = ?").get(run.id).status, "resolved");
  } finally {
    db.prepare("UPDATE custom_processes SET status = 'archived', archived_at = CURRENT_TIMESTAMP WHERE id = ?").run(process.id);
    db.prepare("UPDATE departments SET active = 0 WHERE id = ?").run(isolatedDepartmentId);
    db.prepare("DELETE FROM shifts WHERE shift_date = ? AND department_id = ?").run(date, isolatedDepartmentId);
  }
});

test("v0.71: Mitarbeiter ohne bevorzugte Abteilung erhalten Standortaufgaben am Heimatstandort", async () => {
  upsertEmployee("8723", "Lina Heimatstandort", "employee");
  db.prepare(`
    UPDATE employees
    SET preferred_department_id = NULL
    WHERE personnel_number = '8723'
  `).run();
  assert.equal(
    db.prepare("SELECT preferred_department_id FROM employees WHERE personnel_number = '8723'").get()
      .preferred_department_id,
    null,
  );
  const employeeSession = createSession("8723");
  const { process } = await createProcess(processPayload({
    status: "active",
    scope: { type: "location", locationId },
    steps: [
      {
        type: "actor",
        title: "Standortaufgabe erledigen",
        description: "Alle Mitarbeitenden dieses Heimatstandorts sollen die Aufgabe sehen.",
        responsibilityType: "role",
        responsibilityReference: "employee",
        conditionType: "always",
        conditionText: "",
        notificationChannels: ["internal"],
      },
      {
        type: "finish",
        title: "Standortablauf abschließen",
        description: "Der technische Abschluss folgt nach der Standortaufgabe.",
        responsibilityType: "system",
        responsibilityReference: "",
        conditionType: "always",
        conditionText: "",
        notificationChannels: [],
      },
    ],
  }));
  const triggered = await api(`/api/portal/v1/custom-processes/${encodeURIComponent(process.id)}/trigger`, {
    method: "POST",
    auth: auth.hr,
    body: { idempotencyKey: `v071-location-home-fallback-${crypto.randomUUID()}` },
  });
  assert.equal(triggered.response.status, 200, JSON.stringify(triggered.payload));

  const tasks = await api("/api/portal/v1/me/process-tasks", { auth: employeeSession });
  assert.equal(tasks.response.status, 200, JSON.stringify(tasks.payload));
  assert.ok(
    tasks.payload.tasks.some((entry) => entry.runId === triggered.payload.run.id),
    JSON.stringify(tasks.payload),
  );
});
