"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v09220-manual-lock-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db } = subject;

const MANAGER = "99410";
const DEPARTMENT_MANAGER = "99411";
const AUDIT_MANAGER = "99412";
const WEEK = "2099-01-05";
const DATE = WEEK;

let httpServer;
let baseUrl;
let locationId;
let departmentId;
let managerSession;
let departmentSession;
let auditSession;

function ensureEmployee(employeeNumber, name, positionId, preferredDepartmentId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours,
       target_workdays_per_week, fixed_workdays, position_id,
       time_confirmation_level, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#2c7a68', 32, 5, '', ?, 'C', ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      full_name = excluded.full_name,
      nickname = excluded.nickname,
      position_id = excluded.position_id,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(
    employeeNumber,
    name,
    name.split(" ")[0],
    positionId,
    locationId,
    preferredDepartmentId,
  );
}

function ensurePortalUser(employeeNumber, role, scopeDepartmentId) {
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active,
       must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  for (const permission of ["schedule:read", "schedule:write"]) {
    db.prepare(`
      INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
      VALUES (?, ?, 'v09220-manual-lock-test')
    `).run(employeeNumber, permission);
  }
  db.prepare(`
    INSERT INTO portal_access_scopes
      (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, 'v09220-manual-lock-test')
  `).run(employeeNumber, locationId, scopeDepartmentId);
}

function createSession(employeeNumber) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(
    crypto.randomUUID(),
    employeeNumber,
    crypto.createHash("sha256").update(rawToken).digest("hex"),
  );
  return {
    cookie: `grabenplaner_session=${encodeURIComponent(rawToken)}; grabenplaner_csrf=${encodeURIComponent(csrf)}`,
    csrf,
  };
}

async function requestJson(route, { method = "GET", body, auth = managerSession, headers: extraHeaders = {} } = {}) {
  const headers = { Accept: "application/json", Cookie: auth.cookie, ...extraHeaders };
  if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, payload: text ? JSON.parse(text) : null };
}

test.before(async () => {
  locationId = db.prepare("SELECT id FROM locations WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  const existingDepartment = db.prepare(`
    SELECT id FROM departments
    WHERE location_id = ? AND active = 1
    ORDER BY sort_order, id LIMIT 1
  `).get(locationId);
  departmentId = Number(existingDepartment?.id || db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES (?, 'Sperrtest', 0, 1, 999)
  `).run(locationId).lastInsertRowid);
  const positionId = db.prepare(`
    SELECT id FROM positions WHERE active = 1
    ORDER BY is_default DESC, sort_order, id LIMIT 1
  `).get().id;
  ensureEmployee(MANAGER, "Manuelle Sperre Leitung", positionId, departmentId);
  ensureEmployee(DEPARTMENT_MANAGER, "Manuelle Sperre Abteilung", positionId, departmentId);
  ensureEmployee(AUDIT_MANAGER, "Aktionslog Reihenfolge", positionId, departmentId);
  ensurePortalUser(MANAGER, "manager", 0);
  ensurePortalUser(DEPARTMENT_MANAGER, "department_manager", departmentId);
  ensurePortalUser(AUDIT_MANAGER, "manager", 0);
  managerSession = createSession(MANAGER);
  departmentSession = createSession(DEPARTMENT_MANAGER);
  auditSession = createSession(AUDIT_MANAGER);
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.92.20 manuelle Dienstplansperre sperrt filialweit, revisionssicher und auditierbar", async () => {
  const initial = await requestJson(
    `/api/schedule?week=${WEEK}&locationId=${encodeURIComponent(locationId)}`,
  );
  assert.equal(initial.response.status, 200, initial.text);
  assert.deepEqual(initial.payload.manualScheduleLock, {
    locationId,
    weekStart: WEEK,
    locked: false,
    revision: 0,
    updatedBy: "",
    updatedAt: "",
    canManage: true,
  });

  const locked = await requestJson("/api/schedule/manual-lock", {
    method: "PUT",
    body: { locationId, weekStart: WEEK, locked: true, expectedRevision: 0 },
  });
  assert.equal(locked.response.status, 200, locked.text);
  assert.equal(locked.payload.manualScheduleLock.locked, true);
  assert.equal(locked.payload.manualScheduleLock.revision, 1);
  assert.equal(locked.payload.manualScheduleLock.updatedBy, MANAGER);
  assert.equal(
    db.prepare("SELECT locked FROM schedule_manual_locks WHERE location_id = ? AND week_start = ?")
      .get(locationId, WEEK).locked,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE actor = ? AND action = 'schedule.manual-lock.lock'")
      .get(MANAGER).count,
    1,
  );

  const departmentView = await requestJson(
    `/api/schedule?week=${WEEK}&locationId=${encodeURIComponent(locationId)}&departmentId=${departmentId}`,
    { auth: departmentSession },
  );
  assert.equal(departmentView.response.status, 200, departmentView.text);
  assert.equal(departmentView.payload.manualScheduleLock.locked, true);
  assert.equal(departmentView.payload.manualScheduleLock.canManage, false);

  const departmentToggle = await requestJson("/api/schedule/manual-lock", {
    method: "PUT",
    auth: departmentSession,
    body: {
      locationId,
      departmentId,
      weekStart: WEEK,
      locked: false,
      expectedRevision: 1,
    },
  });
  assert.equal(departmentToggle.response.status, 403, departmentToggle.text);
  assert.ok(["PORTAL_SCOPE_DENIED", "SCHEDULE_MANUAL_LOCK_SCOPE_DENIED"].includes(departmentToggle.payload.code));

  const blockedShift = await requestJson("/api/shifts", {
    method: "POST",
    body: {
      employeeNumber: MANAGER,
      locationId,
      departmentId,
      date: DATE,
      startTime: "09:00",
      endTime: "12:00",
      area: "Manuelle Sperre",
      note: "muss blockieren",
    },
  });
  assert.equal(blockedShift.response.status, 423, blockedShift.text);
  assert.equal(blockedShift.payload.code, "SCHEDULE_MANUAL_LOCKED");

  const blockedOption = await requestJson("/api/week-options", {
    method: "POST",
    body: {
      employeeNumber: MANAGER,
      locationId,
      departmentId,
      weekStart: WEEK,
      dateFrom: DATE,
      dateTo: DATE,
      optionType: "branch",
      allDay: true,
      note: "muss blockieren",
    },
  });
  assert.equal(blockedOption.response.status, 423, blockedOption.text);
  assert.equal(blockedOption.payload.code, "SCHEDULE_MANUAL_LOCKED");

  const blockedNote = await requestJson("/api/schedule-note", {
    method: "PUT",
    body: {
      locationId,
      departmentId,
      weekStart: WEEK,
      noteText: "muss blockieren",
      noteHtml: "muss blockieren",
    },
  });
  assert.equal(blockedNote.response.status, 423, blockedNote.text);
  assert.equal(blockedNote.payload.code, "SCHEDULE_MANUAL_LOCKED");

  const blockedReset = await requestJson(
    `/api/schedule?week=${WEEK}&locationId=${encodeURIComponent(locationId)}`,
    { method: "DELETE" },
  );
  assert.equal(blockedReset.response.status, 423, blockedReset.text);
  assert.equal(blockedReset.payload.code, "SCHEDULE_MANUAL_LOCKED");

  const staleUnlock = await requestJson("/api/schedule/manual-lock", {
    method: "PUT",
    body: { locationId, weekStart: WEEK, locked: false, expectedRevision: 0 },
  });
  assert.equal(staleUnlock.response.status, 409, staleUnlock.text);
  assert.equal(staleUnlock.payload.code, "SCHEDULE_MANUAL_LOCK_CONFLICT");

  const unlocked = await requestJson("/api/schedule/manual-lock", {
    method: "PUT",
    body: { locationId, weekStart: WEEK, locked: false, expectedRevision: 1 },
  });
  assert.equal(unlocked.response.status, 200, unlocked.text);
  assert.equal(unlocked.payload.manualScheduleLock.locked, false);
  assert.equal(unlocked.payload.manualScheduleLock.revision, 2);
  const unlockAudit = db.prepare(`
    SELECT id FROM audit_log
    WHERE actor = ? AND action = 'schedule.manual-lock.unlock'
    ORDER BY id DESC LIMIT 1
  `).get(MANAGER);
  assert.ok(unlockAudit?.id);
  const unlockReceipt = db.prepare(`
    SELECT source_audit_id FROM personal_action_receipts
    WHERE actor_id = ? AND action_type = 'schedule.manual-lock.unlock'
    ORDER BY created_at DESC LIMIT 1
  `).get(MANAGER);
  assert.equal(unlockReceipt?.source_audit_id, unlockAudit.id);

  const createdShift = await requestJson("/api/shifts", {
    method: "POST",
    body: {
      employeeNumber: MANAGER,
      locationId,
      departmentId,
      date: DATE,
      startTime: "09:00",
      endTime: "12:00",
      area: "Nach Freigabe",
      note: "zulässig",
    },
  });
  assert.equal(createdShift.response.status, 201, createdShift.text);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE employee_number = ? AND shift_date = ?")
      .get(MANAGER, DATE).count,
    1,
  );

  const actions = await requestJson("/api/portal/v1/me/actions?limit=25");
  assert.equal(actions.response.status, 200, actions.text);
  assert.match(actions.response.headers.get("cache-control"), /no-store/);
  assert.ok(Array.isArray(actions.payload.actions));
  assert.equal(actions.payload.actions.some((entry) => "detail" in entry), false);
  const reversibleUnlock = actions.payload.actions.find((entry) => (
    entry.actionType === "schedule.manual-lock.unlock" && entry.canUndo === true
  ));
  assert.ok(reversibleUnlock, actions.text);
  assert.match(reversibleUnlock.id, /^receipt:/);
  assert.equal(
    actions.payload.actions.filter((entry) => entry.actionType === "schedule.manual-lock.unlock").length,
    1,
    actions.text,
  );
  const staleLock = actions.payload.actions.find((entry) => entry.actionType === "schedule.manual-lock.lock");
  assert.ok(staleLock, actions.text);
  assert.equal(staleLock.canUndo, false);

  const foreignList = await requestJson("/api/portal/v1/me/actions?limit=25", { auth: departmentSession });
  assert.equal(foreignList.response.status, 200, foreignList.text);
  assert.equal(foreignList.payload.actions.some((entry) => entry.id === reversibleUnlock.id), false);

  const foreignUndo = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(reversibleUnlock.id)}/undo`,
    {
      method: "POST",
      auth: departmentSession,
      body: {},
    },
  );
  assert.equal(foreignUndo.response.status, 404, foreignUndo.text);

  db.prepare("UPDATE portal_users SET must_change_password = 1 WHERE employee_number = ?")
    .run(MANAGER);
  const passwordBlockedList = await requestJson("/api/portal/v1/me/actions?limit=25");
  assert.equal(passwordBlockedList.response.status, 428, passwordBlockedList.text);
  assert.equal(passwordBlockedList.payload.code, "PORTAL_PASSWORD_CHANGE_REQUIRED");
  const passwordBlockedUndo = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(reversibleUnlock.id)}/undo`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(passwordBlockedUndo.response.status, 428, passwordBlockedUndo.text);
  assert.equal(passwordBlockedUndo.payload.code, "PORTAL_PASSWORD_CHANGE_REQUIRED");
  db.prepare("UPDATE portal_users SET must_change_password = 0 WHERE employee_number = ?")
    .run(MANAGER);

  const undone = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(reversibleUnlock.id)}/undo`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(undone.response.status, 200, undone.text);
  assert.equal(undone.payload.undone, true);
  assert.equal(undone.payload.alreadyUndone, false);
  assert.equal(undone.payload.manualScheduleLock.locked, true);
  assert.equal(undone.payload.manualScheduleLock.revision, 3);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE actor = ? AND action = 'personal.action.undo'")
      .get(MANAGER).count,
    1,
  );

  const duplicateUndo = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(reversibleUnlock.id)}/undo`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(duplicateUndo.response.status, 200, duplicateUndo.text);
  assert.equal(duplicateUndo.payload.alreadyUndone, true);
  assert.equal(duplicateUndo.payload.manualScheduleLock.revision, 3);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM personal_action_receipts WHERE actor_id = ? AND compensates_action_id IS NOT NULL")
      .get(MANAGER).count,
    1,
  );

  const otherLocationId = "scope-replay-test";
  db.prepare(`
    INSERT INTO locations (id, name, min_staff, day_settings_json, active)
    VALUES (?, 'Andere Filiale für Scope-Test', 0, '{}', 1)
  `).run(otherLocationId);
  db.prepare(`
    UPDATE portal_access_scopes SET location_id = ?
    WHERE employee_number = ?
  `).run(otherLocationId, MANAGER);
  const scopeBlockedReplay = await requestJson(
    `/api/portal/v1/me/actions/${encodeURIComponent(reversibleUnlock.id)}/undo`,
    { method: "POST", body: {} },
  );
  assert.equal(scopeBlockedReplay.response.status, 403, scopeBlockedReplay.text);
  assert.equal(scopeBlockedReplay.payload.code, "PERSONAL_ACTION_UNDO_SCOPE_DENIED");
  db.prepare(`
    UPDATE portal_access_scopes SET location_id = ?
    WHERE employee_number = ?
  `).run(locationId, MANAGER);

  const firstActionPage = await requestJson("/api/portal/v1/me/actions?limit=1");
  assert.equal(firstActionPage.response.status, 200, firstActionPage.text);
  assert.equal(firstActionPage.payload.actions.length, 1);
  assert.equal(firstActionPage.payload.actions[0].actionType, "personal.action.undo");
  assert.ok(firstActionPage.payload.nextCursor);
  const secondActionPage = await requestJson(
    `/api/portal/v1/me/actions?limit=1&cursor=${encodeURIComponent(firstActionPage.payload.nextCursor)}`,
  );
  assert.equal(secondActionPage.response.status, 200, secondActionPage.text);
  assert.equal(
    secondActionPage.payload.actions.some((entry) => entry.actionType === "personal.action.undo"),
    false,
    secondActionPage.text,
  );

  const receiptId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO personal_action_receipts (
      id, actor_kind, actor_id, action_type, entity_type, entity_id, scope, summary,
      compensator_key, undo_payload, result_revision, result_fingerprint,
      undo_expires_at, compensates_action_id, created_at
    ) VALUES (?, 'employee', ?, 'schedule.past-week-preference.update',
      'ui_preference', 'history-visibility', 'Persönliche Dienstplanung',
      'Ältere protokollierte Einstellung', NULL, NULL, NULL, NULL, NULL, NULL, ?)
  `).run(receiptId, AUDIT_MANAGER, "2098-01-01T08:00:00.000Z");
  const visibleAuditId = Number(db.prepare(`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, created_at)
    VALUES (?, 'crm.customer.create', 'crm_customer', 'customer-history', '{}', ?)
  `).run(AUDIT_MANAGER, "2098-01-02T08:00:00.000Z").lastInsertRowid);
  const insertInvisibleAudit = db.prepare(`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, created_at)
    VALUES (?, 'crm.customer.read', 'crm_customer', ?, '{}', ?)
  `);
  for (let index = 0; index < 1_100; index += 1) {
    insertInvisibleAudit.run(
      AUDIT_MANAGER,
      `customer-read-${index}`,
      `2098-01-03T08:${String(index % 60).padStart(2, "0")}:00.000Z`,
    );
  }
  const filteredScanPage = await requestJson(
    "/api/portal/v1/me/actions?limit=1",
    { auth: auditSession },
  );
  assert.equal(filteredScanPage.response.status, 200, filteredScanPage.text);
  assert.deepEqual(filteredScanPage.payload.actions, []);
  assert.ok(filteredScanPage.payload.nextCursor);
  const filteredAuditPage = await requestJson(
    `/api/portal/v1/me/actions?limit=1&cursor=${encodeURIComponent(filteredScanPage.payload.nextCursor)}`,
    { auth: auditSession },
  );
  assert.equal(filteredAuditPage.response.status, 200, filteredAuditPage.text);
  assert.equal(filteredAuditPage.payload.actions[0].id, `audit:${visibleAuditId}`);
  assert.ok(filteredAuditPage.payload.nextCursor);
  const filteredReceiptPage = await requestJson(
    `/api/portal/v1/me/actions?limit=1&cursor=${encodeURIComponent(filteredAuditPage.payload.nextCursor)}`,
    { auth: auditSession },
  );
  assert.equal(filteredReceiptPage.response.status, 200, filteredReceiptPage.text);
  assert.equal(filteredReceiptPage.payload.actions[0].id, `receipt:${receiptId}`);
});
