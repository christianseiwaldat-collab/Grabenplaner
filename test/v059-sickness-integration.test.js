"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v059-sickness-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.GRABENPLANER_SMS_WEBHOOK_URL = "https://notifications.invalid/grabenplaner/staffing";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const nativeFetch = globalThis.fetch;
let deliveredVerificationCode = "";
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://notifications.invalid/")) {
    const payload = JSON.parse(String(options?.body || "{}"));
    if (payload.event === "destination_verification") deliveredVerificationCode = String(payload.code || "");
    return { ok: true };
  }
  return nativeFetch(url, options);
};

const {
  app,
  db,
  parseProtectedJson,
  purgeExpiredSicknessData,
  runSicknessEscalationSweep,
  releaseInstanceLockForTests,
} = require("../server");

let httpServer;
let baseUrl;
let auth;

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function request(route, { method = "GET", auth = null, body } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
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

function viennaDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function mostRecentPlanningDate() {
  return viennaDateKey();
}

function daySettings() {
  return Object.fromEntries([
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ].map((day) => [day, {
    open: true,
    start: day === "saturday" ? "10:00" : "09:00",
    end: day === "saturday" ? "17:00" : "18:00",
    lunchEnabled: false,
    lunchStart: "13:00",
    lunchEnd: "14:00",
    minStaff: 2,
    minFrom: day === "saturday" ? "10:00" : "09:00",
    minTo: day === "saturday" ? "17:00" : "18:00",
  }]));
}

function insertEmployee(personnelNumber, fullName, locationId, departmentId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, position_id,
       home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#287a67', 38.5, 'verkaufsmitarbeiter', ?, ?, 1)
  `).run(personnelNumber, fullName, fullName.split(" ")[0], locationId, departmentId);
}

test.before(async () => {
  const settings = JSON.stringify(daySettings());
  db.prepare("INSERT INTO locations (id, name, min_staff, day_settings_json, active) VALUES ('91', 'V59 Standort A', 2, ?, 1)")
    .run(settings);
  db.prepare("INSERT INTO locations (id, name, min_staff, day_settings_json, active) VALUES ('92', 'V59 Standort B', 2, ?, 1)")
    .run(settings);
  const departmentA = Number(db.prepare("INSERT INTO departments (location_id, name, min_staff, active, sort_order) VALUES ('91', 'Verkauf A', 0, 1, 1)").run().lastInsertRowid);
  const departmentB = Number(db.prepare("INSERT INTO departments (location_id, name, min_staff, active, sort_order) VALUES ('92', 'Verkauf B', 0, 1, 1)").run().lastInsertRowid);

  insertEmployee("591", "Mila Krank", "91", departmentA);
  insertEmployee("592", "Kora Dienst", "91", departmentA);
  insertEmployee("593", "Lokal Leitung", "91", departmentA);
  insertEmployee("594", "Fremd Leitung", "92", departmentB);
  insertEmployee("595", "Global Personal", "92", departmentB);
  insertEmployee("596", "Filialwechsel Krank", "91", departmentA);
  insertEmployee("597", "Dienst B Eins", "92", departmentB);
  insertEmployee("598", "Dienst B Zwei", "92", departmentB);
  insertEmployee("599", "Delegierte Leserin", "92", departmentB);

  const employeeAuth = session("591", "employee");
  const managerAuth = session("593", "manager");
  const foreignManagerAuth = session("594", "manager");
  const hrAuth = session("595", "hr");
  const crossLocationEmployeeAuth = session("596", "employee");
  const delegatedReaderAuth = session("599", "employee");
  db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES ('593', '91', ?, 'test')").run(departmentA);
  db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES ('594', '92', ?, 'test')").run(departmentB);
  db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES ('599', '92', ?, 'test')").run(departmentB);
  db.prepare("INSERT INTO portal_permission_grants (employee_number, permission, granted_by) VALUES ('599', 'sickness:read', 'test')").run();

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  auth = {
    employeeAuth, managerAuth, foreignManagerAuth, hrAuth, crossLocationEmployeeAuth, delegatedReaderAuth,
    departmentA, departmentB,
  };
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  db.close();
  releaseInstanceLockForTests();
  globalThis.fetch = nativeFetch;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("v0.59: Krankmeldung bleibt verschlüsselt, warnt bei Unterbesetzung, respektiert Scopes und queued extern ohne Versand", async () => {
  const { employeeAuth, managerAuth, foreignManagerAuth, hrAuth, departmentA } = auth;
  const portalPage = await fetch(`${baseUrl}/portal.html`);
  assert.equal(portalPage.status, 200);
  assert.match(portalPage.headers.get("content-security-policy") || "", /script-src 'self' 'wasm-unsafe-eval'/);
  const shiftDate = mostRecentPlanningDate();
  const saturday = new Date(`${shiftDate}T12:00:00Z`).getUTCDay() === 6;
  const shiftStart = saturday ? "10:00" : "09:00";
  const shiftEnd = saturday ? "17:00" : "18:00";
  const insertShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, 'Verkauf', '')
  `);
  insertShift.run("591", departmentA, shiftDate, shiftStart, shiftEnd);
  insertShift.run("592", departmentA, shiftDate, shiftStart, shiftEnd);

  const verification = await request("/api/portal/v1/me/sickness-notification-preferences/verification", {
    method: "POST",
    auth: managerAuth,
    body: {
      channel: "sms",
      destination: "+436601234567",
      earliestTime: "23:59",
    },
  });
  assert.equal(verification.response.status, 200, JSON.stringify(verification.payload));
  assert.match(deliveredVerificationCode, /^\d{6}$/);
  const pendingPreference = db.prepare("SELECT * FROM sickness_notification_preferences WHERE employee_number = '593' AND channel = 'sms'").get();
  assert.equal(pendingPreference.enabled, 0);
  assert.equal(pendingPreference.verified_at, null);
  assert.notEqual(pendingPreference.verification_hash, deliveredVerificationCode);
  assert.equal(pendingPreference.protected_destination.includes("+436601234567"), false);
  const confirmed = await request("/api/portal/v1/me/sickness-notification-preferences/verification/confirm", {
    method: "POST", auth: managerAuth, body: { channel: "sms", code: deliveredVerificationCode },
  });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.payload));
  assert.equal(confirmed.payload.channels.sms.enabled, true);
  assert.ok(confirmed.payload.channels.sms.verifiedAt);

  const confidentialNote = "V059 vertrauliche Gesundheitsnotiz";
  const created = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST",
    auth: employeeAuth,
    body: { startDate: shiftDate, expectedEnd: shiftDate, note: confidentialNote },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.case.status, "reported");
  assert.equal(created.payload.case.staffing_risk.atRisk, true);
  assert.equal(created.payload.case.staffing_risk.worstShortfall, 1);
  const caseId = Number(created.payload.case.id);

  const storedCase = db.prepare("SELECT * FROM sickness_cases WHERE id = ?").get(caseId);
  assert.match(storedCase.protected_payload, /^enc:v2:/);
  assert.equal(storedCase.protected_payload.includes(confidentialNote), false);
  assert.equal(storedCase.protected_payload.includes(shiftDate), false);
  assert.equal(Object.hasOwn(storedCase, "employee_number"), false);
  assert.equal(Object.hasOwn(storedCase, "location_id"), false);
  assert.equal(Object.hasOwn(storedCase, "status"), false);
  assert.equal(Object.hasOwn(storedCase, "note"), false);
  assert.equal(Object.hasOwn(storedCase, "start_date"), false);
  const protectedCase = parseProtectedJson(storedCase.protected_payload, {
    namespace: "sickness-case",
    recordId: String(caseId),
    field: "payload",
    employeeNumber: storedCase.employee_lookup,
  });
  assert.equal(protectedCase.startDate, shiftDate);
  assert.equal(protectedCase.expectedEnd, shiftDate);
  assert.equal(protectedCase.note, confidentialNote);
  assert.equal(protectedCase.staffingRisk.atRisk, true);

  const staffingAlert = db.prepare("SELECT * FROM sickness_alerts WHERE sickness_case_id = ?").get(caseId);
  assert.equal(Object.hasOwn(staffingAlert, "kind"), false);
  assert.equal(Object.hasOwn(staffingAlert, "severity"), false);
  const protectedAlert = parseProtectedJson(staffingAlert.protected_payload, {
    namespace: "sickness-alert", recordId: staffingAlert.id, field: "payload", employeeNumber: String(caseId),
  });
  assert.deepEqual({ kind: protectedAlert.kind, severity: protectedAlert.severity, audience: protectedAlert.audience, status: protectedAlert.status },
    { kind: "staffing_risk", severity: "warning", audience: "local", status: "open" });

  const managerNotifications = db.prepare(`
    SELECT event_type, title, message, target, entity_type FROM portal_notifications
    WHERE recipient_employee_number = '593' AND entity_type = 'protected_record'
    ORDER BY event_type
  `).all();
  assert.deepEqual(managerNotifications.map((row) => row.event_type), ["protected.update", "protected.update"]);
  assert.equal(managerNotifications.every((row) => row.target === "/portal.html?tab=leadershipApprovals"), true);
  assert.equal(managerNotifications.every((row) => !/krank|AUM|591/i.test(`${row.title} ${row.message}`)), true);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications
    WHERE recipient_employee_number = '594' AND entity_type = 'protected_record'
  `).get().count, 0);

  const queued = db.prepare("SELECT * FROM outbound_notification_jobs").all();
  assert.equal(queued.length, 1);
  assert.equal(Object.hasOwn(queued[0], "recipient_employee_number"), false);
  assert.equal(queued[0].channel, "sms");
  assert.equal(queued[0].status, "pending");
  assert.equal(queued[0].attempts, 0);
  assert.match(queued[0].protected_payload, /^enc:v2:/);
  assert.equal(queued[0].protected_payload.includes("+436601234567"), false);
  assert.equal(queued[0].protected_payload.includes(confidentialNote), false);
  const queuedPayload = parseProtectedJson(queued[0].protected_payload, {
    namespace: "outbound-notification-job",
    recordId: queued[0].id,
    field: "payload",
    employeeNumber: queued[0].recipient_lookup,
  });
  assert.deepEqual(queuedPayload, {
    destination: "+436601234567",
    recipientEmployeeNumber: "593",
    sicknessCaseId: caseId,
  });

  const managerList = await request("/api/portal/v1/sickness-cases", { auth: managerAuth });
  assert.equal(managerList.response.status, 200, JSON.stringify(managerList.payload));
  assert.deepEqual(managerList.payload.cases.map((entry) => entry.id), [caseId]);

  const foreignList = await request("/api/portal/v1/sickness-cases", { auth: foreignManagerAuth });
  assert.equal(foreignList.response.status, 200, JSON.stringify(foreignList.payload));
  assert.deepEqual(foreignList.payload.cases, []);

  const hrList = await request("/api/portal/v1/sickness-cases", { auth: hrAuth });
  assert.equal(hrList.response.status, 200, JSON.stringify(hrList.payload));
  assert.deepEqual(hrList.payload.cases.map((entry) => entry.id), [caseId]);

  const employeeLeadershipList = await request("/api/portal/v1/sickness-cases", { auth: employeeAuth });
  assert.equal(employeeLeadershipList.response.status, 403);

  const ownList = await request("/api/portal/v1/me/sickness-cases", { auth: employeeAuth });
  assert.equal(ownList.response.status, 200, JSON.stringify(ownList.payload));
  assert.deepEqual(ownList.payload.cases.map((entry) => entry.id), [caseId]);

  // app.listen() statt startServer(): Der Queue-Dispatcher wird in diesem Test nie gestartet.
  const finalJob = db.prepare("SELECT status, attempts, sent_at FROM outbound_notification_jobs WHERE id = ?").get(queued[0].id);
  assert.deepEqual({ ...finalJob }, { status: "pending", attempts: 0, sent_at: null });

  db.prepare("UPDATE sickness_cases SET purge_after = '2000-01-01' WHERE id = ?").run(caseId);
  db.prepare("UPDATE outbound_notification_jobs SET purge_after = '2000-01-01' WHERE id = ?").run(queued[0].id);
  const purged = purgeExpiredSicknessData("2026-07-14");
  assert.equal(purged.cases, 1);
  assert.equal(purged.jobs, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sickness_cases WHERE id = ?").get(caseId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sickness_alerts WHERE sickness_case_id = ?").get(caseId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM outbound_notification_jobs WHERE id = ?").get(queued[0].id).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '593'").get().count, 0);
});

test("v0.59: filialfremder Einsatz steuert Besetzungsrisiko, effektive Leserechte und erneute Bewertung", async () => {
  const {
    managerAuth,
    foreignManagerAuth,
    crossLocationEmployeeAuth,
    delegatedReaderAuth,
    departmentB,
  } = auth;
  const shiftDate = mostRecentPlanningDate();
  const saturday = new Date(`${shiftDate}T12:00:00Z`).getUTCDay() === 6;
  const shiftStart = saturday ? "10:00" : "09:00";
  const shiftEnd = saturday ? "17:00" : "18:00";
  const insertShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES (?, ?, ?, ?, ?, 'Filialwechsel', '')
  `);
  insertShift.run("596", departmentB, shiftDate, shiftStart, shiftEnd);
  insertShift.run("597", departmentB, shiftDate, shiftStart, shiftEnd);

  const created = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST",
    auth: crossLocationEmployeeAuth,
    body: { startDate: shiftDate, expectedEnd: shiftDate, note: "" },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.case.location_id, "92");
  assert.equal(created.payload.case.department_id, departmentB);
  assert.equal(created.payload.case.staffing_risk.atRisk, true);
  assert.deepEqual(created.payload.case.staffing_risk.contexts, [{ locationId: "92", departmentId: departmentB }]);
  assert.equal(created.payload.case.staffing_risk.slots.every((slot) => slot.locationId === "92"), true);
  const caseId = Number(created.payload.case.id);

  const homeManagerList = await request("/api/portal/v1/sickness-cases", { auth: managerAuth });
  assert.equal(homeManagerList.response.status, 200, JSON.stringify(homeManagerList.payload));
  assert.equal(homeManagerList.payload.cases.some((entry) => entry.id === caseId), false);

  const deploymentManagerList = await request("/api/portal/v1/sickness-cases", { auth: foreignManagerAuth });
  assert.equal(deploymentManagerList.response.status, 200, JSON.stringify(deploymentManagerList.payload));
  assert.equal(deploymentManagerList.payload.cases.some((entry) => entry.id === caseId), true);

  const delegatedList = await request("/api/portal/v1/sickness-cases", { auth: delegatedReaderAuth });
  assert.equal(delegatedList.response.status, 200, JSON.stringify(delegatedList.payload));
  assert.equal(delegatedList.payload.cases.some((entry) => entry.id === caseId), true);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications
    WHERE recipient_employee_number = '593' AND entity_id = (
      SELECT entity_id FROM portal_notifications WHERE recipient_employee_number = '594' ORDER BY rowid DESC LIMIT 1
    )
  `).get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '594'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '599'").get().count, 2);

  const balancingShift = insertShift.run("598", departmentB, shiftDate, shiftStart, shiftEnd);
  const sweepAtShiftDate = new Date(`${shiftDate}T12:00:00+02:00`);
  runSicknessEscalationSweep(sweepAtShiftDate);

  const safeCaseRow = db.prepare("SELECT * FROM sickness_cases WHERE id = ?").get(caseId);
  const safePayload = parseProtectedJson(safeCaseRow.protected_payload, {
    namespace: "sickness-case", recordId: String(caseId), field: "payload", employeeNumber: safeCaseRow.employee_lookup,
  });
  assert.equal(safePayload.staffingRisk.atRisk, false);
  const resolvedAlertRow = db.prepare("SELECT * FROM sickness_alerts WHERE sickness_case_id = ?").get(caseId);
  const resolvedAlert = parseProtectedJson(resolvedAlertRow.protected_payload, {
    namespace: "sickness-alert", recordId: resolvedAlertRow.id, field: "payload", employeeNumber: String(caseId),
  });
  assert.equal(resolvedAlert.status, "resolved");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '594' AND read_at IS NULL").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '599' AND read_at IS NULL").get().count, 1);

  db.prepare("DELETE FROM shifts WHERE id = ?").run(Number(balancingShift.lastInsertRowid));
  runSicknessEscalationSweep(sweepAtShiftDate);
  const reopenedAlertRow = db.prepare("SELECT * FROM sickness_alerts WHERE sickness_case_id = ?").get(caseId);
  const reopenedAlert = parseProtectedJson(reopenedAlertRow.protected_payload, {
    namespace: "sickness-alert", recordId: reopenedAlertRow.id, field: "payload", employeeNumber: String(caseId),
  });
  assert.equal(reopenedAlert.status, "open");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '594' AND read_at IS NULL").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '599' AND read_at IS NULL").get().count, 2);
});
