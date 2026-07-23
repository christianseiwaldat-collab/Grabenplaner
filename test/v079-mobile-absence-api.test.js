"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v079-mobile-"));
const dataRoot = path.join(testRoot, "server-data");
process.env.DB_PATH = path.join(dataRoot, "data", "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = dataRoot;
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_OPERATION_MODE = "server";
process.env.GRABENPLANER_PUBLIC_URL = "https://plan.example.test";
process.env.GRABENPLANER_TRUST_PROXY = "loopback";
process.env.GRABENPLANER_DEPLOYMENT_KIND = "codespaces-test";
process.env.GRABENPLANER_AMU_KEY_ID = "test-v1";
process.env.GRABENPLANER_AMU_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db, hashPortalPassword, releaseInstanceLockForTests } = require("../server");

const employeeNumber = "979";
const otherEmployeeNumber = "980";
const password = "SicheresMobile079Passwort!";
const mobileVersion = "0.3.0-alpha.1";
let baseUrl;
let httpServer;
let locationId;

function dateInVienna(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const base = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

async function api(route, { method = "GET", accessToken = "", body, idempotencyKey, headers = {} } = {}) {
  const requestHeaders = { Accept: "application/json", "X-Forwarded-Proto": "https", ...headers };
  if (accessToken) requestHeaders.Authorization = `Bearer ${accessToken}`;
  if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;
  let requestBody;
  if (body instanceof FormData) {
    requestBody = body;
  } else if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${route}`, { method, headers: requestHeaders, ...(requestBody === undefined ? {} : { body: requestBody }) });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

async function login(employee, installationId = `install-${crypto.randomUUID()}`) {
  return api("/api/mobile/v1/auth/login", {
    method: "POST",
    body: {
      employeeNumber: employee,
      password,
      device: { installationId, platform: "android", label: "v079 Test", appVersion: mobileVersion },
    },
  });
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations ORDER BY id LIMIT 1").get().id;
  for (const [number, name] of [[employeeNumber, "Mira Mobile"], [otherEmployeeNumber, "Otto Other"]]) {
    db.prepare(`INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, home_location_id, active)
      VALUES (?, ?, ?, '#287a67', 38.5, ?, 1)`).run(number, name, name.split(" ")[0], locationId);
    db.prepare(`INSERT INTO portal_users
      (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
      VALUES (?, ?, 'employee', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(number, await hashPortalPassword(password));
  }
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.79: App-Abwesenheiten verlangen Bearer-Authentifizierung und liefern no-store", async () => {
  const denied = await api("/api/mobile/v1/me/absence-requests");
  assert.equal(denied.response.status, 401, JSON.stringify(denied.payload));
  const session = await login(employeeNumber);
  assert.equal(session.response.status, 201, JSON.stringify(session.payload));
  const result = await api("/api/mobile/v1/me/absence-requests", { accessToken: session.payload.tokenSet.accessToken });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.match(result.response.headers.get("cache-control") || "", /private/);
  assert.match(result.response.headers.get("cache-control") || "", /no-store/);
  assert.ok(Array.isArray(result.payload.items));
  assert.deepEqual(result.payload.access, {
    vacationRead: true,
    vacationWrite: true,
    timeOffRead: true,
    timeOffWrite: true,
  });
  assert.ok(session.payload.bootstrap.navigation.items.some((item) => item.id === "notifications"));
});

test("v0.79: Urlaubsanlage ist UUID-idempotent und erkennt Payload-Konflikte", async () => {
  const session = await login(employeeNumber);
  const accessToken = session.payload.tokenSet.accessToken;
  const key = crypto.randomUUID();
  const body = { dateFrom: dateInVienna(30), dateTo: dateInVienna(31), note: "Mobile Test" };
  const created = await api("/api/mobile/v1/me/vacation-requests", { method: "POST", accessToken, idempotencyKey: key, body });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const replay = await api("/api/mobile/v1/me/vacation-requests", { method: "POST", accessToken, idempotencyKey: key, body });
  assert.equal(replay.response.status, 201, JSON.stringify(replay.payload));
  assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.payload.request.id, created.payload.request.id);
  assert.equal(replay.payload.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number = ?").get(employeeNumber).count, 1);

  const conflict = await api("/api/mobile/v1/me/vacation-requests", {
    method: "POST", accessToken, idempotencyKey: key,
    body: { ...body, dateTo: dateInVienna(32) },
  });
  assert.equal(conflict.response.status, 409, JSON.stringify(conflict.payload));
  assert.equal(conflict.payload.error.code, "MOBILE_IDEMPOTENCY_CONFLICT");

  const missing = await api("/api/mobile/v1/me/vacation-requests", {
    method: "POST", accessToken, body: { dateFrom: dateInVienna(40), dateTo: dateInVienna(40) },
  });
  assert.equal(missing.response.status, 400, JSON.stringify(missing.payload));
  assert.equal(missing.payload.error.code, "MOBILE_IDEMPOTENCY_KEY_REQUIRED");
  const receipt = db.prepare("SELECT request_sha256, response_json FROM mobile_mutation_receipts WHERE employee_number = ? AND idempotency_key = ?")
    .get(employeeNumber, key);
  assert.match(receipt.request_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(JSON.parse(receipt.response_json)), ["id"]);
});

test("v0.79: Urlaubsänderung und Storno akzeptieren vacationGroupId aus dem App-Vertrag", async () => {
  const session = await login(employeeNumber);
  const accessToken = session.payload.tokenSet.accessToken;
  const groups = [
    { id: `mobile-change-${crypto.randomUUID()}`, from: dateInVienna(90), to: dateInVienna(91) },
    { id: `mobile-cancel-${crypto.randomUUID()}`, from: dateInVienna(100), to: dateInVienna(101) },
  ];
  for (const group of groups) {
    db.prepare(`INSERT INTO week_options
      (employee_number, group_id, week_start, date_from, date_to, option_type, note, all_day)
      VALUES (?, ?, ?, ?, ?, 'vacation', 'Genehmigt', 1)`)
      .run(employeeNumber, group.id, group.from, group.from, group.to);
    db.prepare(`INSERT INTO vacation_requests
      (employee_number, location_id, vacation_group_id, date_from, date_to, note, status, approval_stage)
      VALUES (?, ?, ?, ?, ?, 'Genehmigt', 'approved', 'complete')`)
      .run(employeeNumber, locationId, group.id, group.from, group.to);
  }

  const changed = await api("/api/mobile/v1/me/vacation-change-requests", {
    method: "POST", accessToken, idempotencyKey: crypto.randomUUID(),
    body: {
      vacationGroupId: groups[0].id,
      requestType: "change",
      dateFrom: dateInVienna(110),
      dateTo: dateInVienna(111),
      note: "Termin verschieben",
    },
  });
  assert.equal(changed.response.status, 201, JSON.stringify(changed.payload));
  assert.equal(changed.payload.request.kind, "vacation_change");
  assert.equal(changed.payload.request.vacation_group_id, groups[0].id);

  const cancelled = await api("/api/mobile/v1/me/vacation-change-requests", {
    method: "POST", accessToken, idempotencyKey: crypto.randomUUID(),
    body: { vacationGroupId: groups[1].id, requestType: "cancel", note: "Nicht mehr benötigt" },
  });
  assert.equal(cancelled.response.status, 201, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.request.kind, "vacation_cancel");
  assert.equal(cancelled.payload.request.vacation_group_id, groups[1].id);

  const combined = await api("/api/mobile/v1/me/absence-requests", { accessToken });
  assert.equal(combined.response.status, 200, JSON.stringify(combined.payload));
  assert.ok(combined.payload.items.some((item) => item.kind === "vacation"
    && item.vacation_group_id === groups[0].id));
});

test("v0.79: Kombinierte Abwesenheiten filtern Urlaub und ZA nach wirksamen Leserechten", async () => {
  const vacationDate = dateInVienna(140);
  const timeOffDate = dateInVienna(141);
  db.prepare(`INSERT INTO vacation_requests
    (employee_number, location_id, date_from, date_to, note, status, approval_stage)
    VALUES (?, ?, ?, ?, 'Nur Urlaub', 'approved', 'complete')`)
    .run(employeeNumber, locationId, vacationDate, vacationDate);
  db.prepare(`INSERT INTO time_off_requests
    (employee_number, location_id, request_date, date_from, date_to, all_day, start_time, end_time,
     note, status, approval_type, approval_stage, traffic_light, check_reason)
    VALUES (?, ?, ?, ?, ?, 1, '00:00', '23:59', 'Nur ZA', 'approved', 'local', 'complete', 'green', '')`)
    .run(employeeNumber, locationId, timeOffDate, timeOffDate, timeOffDate);
  for (const [id, permissions] of [
    ["mobile-v079-vacation-read", ["own_vacation:read"]],
    ["mobile-v079-time-read", ["own_time:read"]],
    ["mobile-v079-no-absence-read", []],
  ]) {
    db.prepare(`INSERT OR REPLACE INTO portal_roles
      (id, name, description, builtin, permissions, sort_order, updated_at)
      VALUES (?, ?, '', 0, ?, 199, CURRENT_TIMESTAMP)`)
      .run(id, id, JSON.stringify(permissions));
  }
  const session = await login(employeeNumber);
  const accessToken = session.payload.tokenSet.accessToken;
  try {
    db.prepare("UPDATE portal_users SET role = 'mobile-v079-time-read' WHERE employee_number = ?").run(employeeNumber);
    const timeOnly = await api("/api/mobile/v1/me/absence-requests", { accessToken });
    assert.equal(timeOnly.response.status, 200, JSON.stringify(timeOnly.payload));
    assert.equal(timeOnly.payload.access.vacationRead, false);
    assert.equal(timeOnly.payload.access.timeOffRead, true);
    assert.ok(timeOnly.payload.items.some((item) => String(item.kind).startsWith("time_off")));
    assert.ok(timeOnly.payload.items.every((item) => !String(item.kind).startsWith("vacation")));
    const timeNavigation = await api("/api/mobile/v1/bootstrap", { accessToken });
    assert.ok(timeNavigation.payload.navigation.items.some((item) => item.id === "requests"));
    assert.ok(timeNavigation.payload.navigation.items.some((item) => item.id === "notifications"));

    db.prepare("UPDATE portal_users SET role = 'mobile-v079-vacation-read' WHERE employee_number = ?").run(employeeNumber);
    const vacationOnly = await api("/api/mobile/v1/me/absence-requests", { accessToken });
    assert.equal(vacationOnly.response.status, 200, JSON.stringify(vacationOnly.payload));
    assert.equal(vacationOnly.payload.access.vacationRead, true);
    assert.equal(vacationOnly.payload.access.timeOffRead, false);
    assert.ok(vacationOnly.payload.items.some((item) => String(item.kind).startsWith("vacation")));
    assert.ok(vacationOnly.payload.items.every((item) => !String(item.kind).startsWith("time_off")));

    db.prepare("UPDATE portal_users SET role = 'mobile-v079-no-absence-read' WHERE employee_number = ?").run(employeeNumber);
    const denied = await api("/api/mobile/v1/me/absence-requests", { accessToken });
    assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
    assert.equal(denied.payload.error.code, "MOBILE_PERMISSION_DENIED");
    const navigation = await api("/api/mobile/v1/bootstrap", { accessToken });
    assert.equal(navigation.response.status, 200, JSON.stringify(navigation.payload));
    assert.equal(navigation.payload.navigation.items.some((item) => item.id === "requests"), false);
    assert.ok(navigation.payload.navigation.items.some((item) => item.id === "notifications"));
  } finally {
    db.prepare("UPDATE portal_users SET role = 'employee' WHERE employee_number = ?").run(employeeNumber);
  }
});

test("v0.79: Idempotenz sperrt laufende und unklare Zustände ohne Doppelanlage", async () => {
  const session = await login(employeeNumber);
  const accessToken = session.payload.tokenSet.accessToken;
  const key = crypto.randomUUID();
  const body = { dateFrom: dateInVienna(160), dateTo: dateInVienna(160), note: "Idempotenzstatus" };
  const created = await api("/api/mobile/v1/me/vacation-requests", {
    method: "POST", accessToken, idempotencyKey: key, body,
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const requestId = created.payload.request.id;
  const countBefore = db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number = ?")
    .get(employeeNumber).count;

  db.prepare(`UPDATE mobile_mutation_receipts
    SET status = 'in_progress', entity_type = '', entity_id = '', action_completed_at = NULL,
        response_json = '', updated_at = CURRENT_TIMESTAMP
    WHERE employee_number = ? AND idempotency_key = ?`).run(employeeNumber, key);
  const concurrent = await api("/api/mobile/v1/me/vacation-requests", {
    method: "POST", accessToken, idempotencyKey: key, body,
  });
  assert.equal(concurrent.response.status, 409, JSON.stringify(concurrent.payload));
  assert.equal(concurrent.payload.error.code, "MOBILE_IDEMPOTENCY_IN_PROGRESS");
  assert.equal(concurrent.response.headers.get("retry-after"), "2");

  db.prepare(`UPDATE mobile_mutation_receipts
    SET created_at = '2000-01-01 00:00:00', updated_at = '2000-01-01 00:00:00'
    WHERE employee_number = ? AND idempotency_key = ?`).run(employeeNumber, key);
  const stale = await api("/api/mobile/v1/me/vacation-requests", {
    method: "POST", accessToken, idempotencyKey: key, body,
  });
  assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
  assert.equal(stale.payload.error.code, "MOBILE_IDEMPOTENCY_RECOVERY_REQUIRED");
  assert.equal(stale.response.headers.get("retry-after"), "30");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number = ?")
    .get(employeeNumber).count, countBefore);
  assert.equal(db.prepare("SELECT id FROM vacation_requests WHERE id = ?").get(requestId).id, requestId);
});

test("v0.79: Fehlende Receipt-Finalisierung wird ohne doppelte Fachaktion wiederaufgenommen", async () => {
  const session = await login(employeeNumber);
  const accessToken = session.payload.tokenSet.accessToken;
  const key = crypto.randomUUID();
  const body = { dateFrom: dateInVienna(170), dateTo: dateInVienna(170), note: "Finalisierung" };
  db.exec(`
    CREATE TRIGGER v079_fail_receipt_finalize
    BEFORE UPDATE OF status ON mobile_mutation_receipts
    WHEN NEW.employee_number = '${employeeNumber}'
      AND NEW.idempotency_key = '${key}'
      AND NEW.status = 'completed'
    BEGIN
      SELECT RAISE(ABORT, 'simulated receipt finalization failure');
    END
  `);
  try {
    const failed = await api("/api/mobile/v1/me/vacation-requests", {
      method: "POST", accessToken, idempotencyKey: key, body,
    });
    assert.equal(failed.response.status, 503, JSON.stringify(failed.payload));
    assert.equal(failed.payload.error.code, "INTERNAL_ERROR");
    const pendingReceipt = db.prepare(`SELECT status, entity_id, action_completed_at, response_json
      FROM mobile_mutation_receipts WHERE employee_number = ? AND idempotency_key = ?`).get(employeeNumber, key);
    assert.equal(pendingReceipt.status, "in_progress");
    assert.ok(pendingReceipt.entity_id);
    assert.ok(pendingReceipt.action_completed_at);
    assert.equal(JSON.parse(pendingReceipt.response_json).id, Number(pendingReceipt.entity_id));
  } finally {
    db.exec("DROP TRIGGER IF EXISTS v079_fail_receipt_finalize");
  }
  const countBeforeReplay = db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number = ?")
    .get(employeeNumber).count;
  const recovered = await api("/api/mobile/v1/me/vacation-requests", {
    method: "POST", accessToken, idempotencyKey: key, body,
  });
  assert.equal(recovered.response.status, 201, JSON.stringify(recovered.payload));
  assert.equal(recovered.response.headers.get("idempotency-replayed"), "true");
  assert.equal(recovered.payload.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vacation_requests WHERE employee_number = ?")
    .get(employeeNumber).count, countBeforeReplay);
  assert.equal(db.prepare(`SELECT status FROM mobile_mutation_receipts
    WHERE employee_number = ? AND idempotency_key = ?`).get(employeeNumber, key).status, "completed");
});

test("v0.79: Rücknahme und Entscheidungsverlauf bleiben bei Fehlern atomar", async () => {
  const session = await login(employeeNumber);
  const accessToken = session.payload.tokenSet.accessToken;
  const date = dateInVienna(180);
  const inserted = db.prepare(`INSERT INTO vacation_requests
    (employee_number, location_id, date_from, date_to, note, status, approval_stage)
    VALUES (?, ?, ?, ?, 'Transaktion', 'pending_local', 'local')`)
    .run(employeeNumber, locationId, date, date);
  const requestId = Number(inserted.lastInsertRowid);
  const key = crypto.randomUUID();
  db.exec(`
    CREATE TRIGGER v079_fail_withdraw_decision
    BEFORE INSERT ON request_decisions
    WHEN NEW.request_kind = 'vacation' AND NEW.request_id = ${requestId}
    BEGIN
      SELECT RAISE(ABORT, 'simulated decision failure');
    END
  `);
  try {
    const failed = await api(`/api/mobile/v1/me/vacation-requests/${requestId}/withdraw`, {
      method: "POST", accessToken, idempotencyKey: key, body: {},
    });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.equal(db.prepare("SELECT status FROM vacation_requests WHERE id = ?").get(requestId).status, "pending_local");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM request_decisions WHERE request_kind = 'vacation' AND request_id = ?")
      .get(requestId).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mobile_mutation_receipts WHERE employee_number = ? AND idempotency_key = ?")
      .get(employeeNumber, key).count, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS v079_fail_withdraw_decision");
  }
  const withdrawn = await api(`/api/mobile/v1/me/vacation-requests/${requestId}/withdraw`, {
    method: "POST", accessToken, idempotencyKey: key, body: {},
  });
  assert.equal(withdrawn.response.status, 200, JSON.stringify(withdrawn.payload));
  assert.equal(withdrawn.payload.request.status, "withdrawn");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM request_decisions WHERE request_kind = 'vacation' AND request_id = ?")
    .get(requestId).count, 1);
});

test("v0.79: Krankmeldungen validieren Zeitgrenzen und bleiben im eigenen Bereich", async () => {
  const ownSession = await login(employeeNumber);
  const otherSession = await login(otherEmployeeNumber);
  const future = await api("/api/mobile/v1/me/sickness-cases", {
    method: "POST", accessToken: ownSession.payload.tokenSet.accessToken, idempotencyKey: crypto.randomUUID(),
    body: { startDate: dateInVienna(1) },
  });
  assert.equal(future.response.status, 400, JSON.stringify(future.payload));
  assert.equal(future.payload.error.code, "SICKNESS_DATE_INVALID");

  const own = await api("/api/mobile/v1/me/sickness-cases", {
    method: "POST", accessToken: ownSession.payload.tokenSet.accessToken, idempotencyKey: crypto.randomUUID(),
    body: { startDate: dateInVienna(), note: "Nicht in Receipt speichern" },
  });
  assert.equal(own.response.status, 201, JSON.stringify(own.payload));
  const other = await api("/api/mobile/v1/me/sickness-cases", {
    method: "POST", accessToken: otherSession.payload.tokenSet.accessToken, idempotencyKey: crypto.randomUUID(),
    body: { startDate: dateInVienna(-1) },
  });
  assert.equal(other.response.status, 201, JSON.stringify(other.payload));

  const ownList = await api("/api/mobile/v1/me/sickness-cases", { accessToken: ownSession.payload.tokenSet.accessToken });
  assert.equal(ownList.response.status, 200, JSON.stringify(ownList.payload));
  assert.ok(ownList.payload.cases.length >= 1);
  assert.ok(ownList.payload.cases.every((entry) => entry.employee_number === employeeNumber));
  const receipts = db.prepare("SELECT response_json FROM mobile_mutation_receipts WHERE employee_number = ? AND operation = 'sickness.create'").all(employeeNumber);
  assert.ok(receipts.every((row) => !row.response_json.includes("Nicht in Receipt")));
});

test("v0.79: Benachrichtigungen sind paginiert, eigentuemergebunden und enthalten keine Portalziele", async () => {
  const session = await login(employeeNumber);
  const accessToken = session.payload.tokenSet.accessToken;
  const ownId = crypto.randomUUID();
  const foreignId = crypto.randomUUID();
  db.prepare(`INSERT INTO portal_notifications
    (id, recipient_employee_number, event_type, title, message, target, entity_type, entity_id)
    VALUES (?, ?, 'test', 'Eigene Meldung', 'Text', '/portal.html?secret=1', 'vacation', '1')`).run(ownId, employeeNumber);
  db.prepare(`INSERT INTO portal_notifications
    (id, recipient_employee_number, event_type, title, message, target, entity_type, entity_id)
    VALUES (?, ?, 'test', 'Fremde Meldung', 'Text', '/portal.html?secret=2', 'vacation', '2')`).run(foreignId, otherEmployeeNumber);
  const list = await api("/api/mobile/v1/me/notifications?limit=1", { accessToken });
  assert.equal(list.response.status, 200, JSON.stringify(list.payload));
  assert.equal(list.payload.notifications.length, 1);
  assert.equal(Object.hasOwn(list.payload.notifications[0], "target"), false);
  assert.equal(Object.hasOwn(list.payload.notifications[0], "link"), false);
  assert.equal(JSON.stringify(list.payload).includes("secret=1"), false);
  const denied = await api(`/api/mobile/v1/me/notifications/${foreignId}/read`, {
    method: "POST", accessToken, idempotencyKey: crypto.randomUUID(), body: {},
  });
  assert.equal(denied.response.status, 404, JSON.stringify(denied.payload));
  const marked = await api(`/api/mobile/v1/me/notifications/${ownId}/read`, {
    method: "POST", accessToken, idempotencyKey: crypto.randomUUID(), body: {},
  });
  assert.equal(marked.response.status, 200, JSON.stringify(marked.payload));
});

test("v0.79: AUM-App-Liste gibt weder Speicherpfade noch Download-Endpunkte aus", async () => {
  const session = await login(employeeNumber);
  const accessToken = session.payload.tokenSet.accessToken;
  const form = new FormData();
  form.append("incapacityFrom", dateInVienna());
  form.append("ocrAssisted", "0");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  form.append("documents", new Blob([png], { type: "image/png" }), "aum-test.png");
  const uploaded = await api("/api/mobile/v1/me/amu-reports", {
    method: "POST", accessToken, idempotencyKey: crypto.randomUUID(), body: form,
  });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.payload));
  assert.equal(uploaded.payload.report.incapacity_from, dateInVienna());
  assert.ok(uploaded.payload.report.submitted_at);
  assert.ok(Array.isArray(uploaded.payload.report.documents));

  const list = await api("/api/mobile/v1/me/amu-reports", { accessToken });
  assert.equal(list.response.status, 200, JSON.stringify(list.payload));
  assert.equal(list.payload.documentDownloadAvailable, false);
  const serialized = JSON.stringify(list.payload);
  for (const forbidden of ["storage_key", "protected_payload", "encryption_key", "encryption_iv", "encryption_tag", "/content"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
