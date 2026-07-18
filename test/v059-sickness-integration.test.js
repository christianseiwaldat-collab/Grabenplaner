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

function offsetDate(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function protectedBlobCount() {
  const directory = path.join(process.env.GRABENPLANER_DATA_DIR, "amu");
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".amu")).length;
}

async function uploadAum(auth, fields = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(name, String(value));
  }
  const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  form.append("documents", new Blob([onePixelPng], { type: "image/png" }), "aum-open-end.png");
  const response = await fetch(`${baseUrl}/api/portal/v1/me/amu-reports`, {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf },
    body: form,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
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
  insertEmployee("600", "Direkter Upload", "91", departmentA);
  insertEmployee("601", "Korrigierte Rückkehr", "91", departmentA);
  insertEmployee("602", "Neuer Krankenstand", "91", departmentA);
  insertEmployee("603", "Paralleler Upload", "91", departmentA);
  insertEmployee("604", "Erneute Warnung", "91", departmentA);
  insertEmployee("605", "Direkt Filialfremd", "91", departmentA);
  insertEmployee("606", "Getrennter Krankenstand", "91", departmentA);
  insertEmployee("607", "Neue Krankmeldung", "91", departmentA);
  insertEmployee("608", "Zeitprüfung Krank", "91", departmentA);
  insertEmployee("609", "Identität Treffer", "91", departmentA);
  insertEmployee("610", "Identität Manuell", "91", departmentA);
  insertEmployee("611", "Identität Ohne Stammdaten", "91", departmentA);

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
  db.prepare("INSERT INTO portal_permission_grants (employee_number, permission, granted_by) VALUES ('599', 'amu:metadata:read', 'test')").run();

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
  const pdfModule = await fetch(`${baseUrl}/vendor/pdfjs-v6.1.200/build/pdf.min.mjs`);
  assert.equal(pdfModule.status, 200);
  assert.match(pdfModule.headers.get("content-type") || "", /javascript/);
  assert.match(pdfModule.headers.get("cache-control") || "", /immutable/);
  const pdfWorker = await fetch(`${baseUrl}/vendor/pdfjs-v6.1.200/build/pdf.worker.min.mjs`);
  assert.equal(pdfWorker.status, 200);
  const pdfWasm = await fetch(`${baseUrl}/vendor/pdfjs-v6.1.200/wasm/qcms_bg.wasm`);
  assert.equal(pdfWasm.status, 200);
  assert.match(pdfWasm.headers.get("content-type") || "", /application\/wasm/);
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
  assert.equal(managerList.payload.cases[0].employee_note, "");
  assert.equal(managerList.payload.cases[0].amu_status, "required");

  const foreignList = await request("/api/portal/v1/sickness-cases", { auth: foreignManagerAuth });
  assert.equal(foreignList.response.status, 200, JSON.stringify(foreignList.payload));
  assert.deepEqual(foreignList.payload.cases, []);

  const hrList = await request("/api/portal/v1/sickness-cases", { auth: hrAuth });
  assert.equal(hrList.response.status, 200, JSON.stringify(hrList.payload));
  assert.deepEqual(hrList.payload.cases.map((entry) => entry.id), [caseId]);
  assert.equal(hrList.payload.cases[0].employee_note, confidentialNote);

  const employeeLeadershipList = await request("/api/portal/v1/sickness-cases", { auth: employeeAuth });
  assert.equal(employeeLeadershipList.response.status, 403);

  const ownList = await request("/api/portal/v1/me/sickness-cases", { auth: employeeAuth });
  assert.equal(ownList.response.status, 200, JSON.stringify(ownList.payload));
  assert.deepEqual(ownList.payload.cases.map((entry) => entry.id), [caseId]);
  assert.equal(ownList.payload.cases[0].employee_note, confidentialNote);

  // app.listen() statt startServer(): Der Queue-Dispatcher wird in diesem Test nie gestartet.
  const finalJob = db.prepare("SELECT status, attempts, sent_at FROM outbound_notification_jobs WHERE id = ?").get(queued[0].id);
  assert.deepEqual({ ...finalJob }, { status: "pending", attempts: 0, sent_at: null });

  db.prepare("UPDATE sickness_cases SET purge_after = '2000-01-01' WHERE id = ?").run(caseId);
  db.prepare("UPDATE outbound_notification_jobs SET purge_after = '2000-01-01' WHERE id = ?").run(queued[0].id);
  const activePurge = purgeExpiredSicknessData("2026-07-14");
  assert.equal(activePurge.cases, 0);
  assert.equal(activePurge.jobs, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sickness_cases WHERE id = ?").get(caseId).count, 1);
  const withdrawn = await request(`/api/portal/v1/me/sickness-cases/${caseId}/withdraw`, {
    method: "POST", auth: employeeAuth, body: {},
  });
  assert.equal(withdrawn.response.status, 200, JSON.stringify(withdrawn.payload));
  db.prepare("UPDATE sickness_cases SET purge_after = '2000-01-01' WHERE id = ?").run(caseId);
  const purged = purgeExpiredSicknessData("2026-07-14");
  assert.equal(purged.cases, 1);
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

  const deploymentAum = await uploadAum(crossLocationEmployeeAuth, {
    incapacityFrom: shiftDate,
    sicknessCaseId: caseId,
  });
  assert.equal(deploymentAum.response.status, 201, JSON.stringify(deploymentAum.payload));
  assert.equal(deploymentAum.payload.report.location_id, "92");
  assert.equal(deploymentAum.payload.report.department_id, departmentB);
  const homeAumList = await request("/api/portal/v1/amu-reports", { auth: managerAuth });
  assert.equal(homeAumList.response.status, 403, JSON.stringify(homeAumList.payload));
  const deploymentAumList = await request("/api/portal/v1/amu-reports", { auth: foreignManagerAuth });
  assert.equal(deploymentAumList.response.status, 403, JSON.stringify(deploymentAumList.payload));
  const deploymentDocumentId = deploymentAum.payload.report.documents[0].id;
  const deniedDocument = await request(`/api/portal/v1/amu-reports/${deploymentAum.payload.report.id}/documents/${deploymentDocumentId}/content`, { auth: foreignManagerAuth });
  assert.equal(deniedDocument.response.status, 403, JSON.stringify(deniedDocument.payload));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE actor = '594' AND action = 'amu.document.access.denied' AND entity_id = ?").get(deploymentDocumentId));
  const deploymentStatusView = await request("/api/portal/v1/sickness-cases", { auth: foreignManagerAuth });
  const deploymentCaseSummary = deploymentStatusView.payload.cases.find((entry) => entry.id === caseId);
  assert.equal(deploymentCaseSummary.employee_note, "");
  assert.equal(deploymentCaseSummary.amu_status, "received");
  assert.ok(Object.hasOwn(deploymentCaseSummary, "staffing_risk"));

  const directCrossEmployee = session("605", "employee");
  insertShift.run("605", departmentB, shiftDate, shiftStart, shiftEnd);
  const homeNotificationCount = db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '593'
  `).get().count;
  const directCrossAum = await uploadAum(directCrossEmployee, { incapacityFrom: shiftDate });
  assert.equal(directCrossAum.response.status, 201, JSON.stringify(directCrossAum.payload));
  assert.equal(directCrossAum.payload.report.location_id, "92");
  assert.equal(directCrossAum.payload.report.department_id, departmentB);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications WHERE recipient_employee_number = '593'
  `).get().count, homeNotificationCount);
  const directCrossCases = await request("/api/portal/v1/me/sickness-cases", { auth: directCrossEmployee });
  assert.equal(directCrossCases.payload.cases.length, 1);
  assert.equal(directCrossCases.payload.cases[0].location_id, "92");
  assert.equal(directCrossCases.payload.cases[0].department_id, departmentB);
  const directCrossReports = await request("/api/portal/v1/amu-reports", { auth: foreignManagerAuth });
  assert.equal(directCrossReports.response.status, 403, JSON.stringify(directCrossReports.payload));
});

test("v0.59: AUM ohne Enddatum bleibt verschlüsselt und eine Rückkehrmeldung beendet die Verfügbarkeit eindeutig", async () => {
  const { employeeAuth, managerAuth, departmentA } = auth;
  const startDate = mostRecentPlanningDate();
  const returnDate = offsetDate(startDate, 1);
  const saturday = new Date(`${startDate}T12:00:00Z`).getUTCDay() === 6;
  const startTime = saturday ? "10:00" : "09:00";
  const endTime = saturday ? "17:00" : "18:00";

  const created = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employeeAuth, body: { startDate, note: "" },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.case.expected_end, "");
  assert.equal(created.payload.case.status, "reported");
  const caseId = Number(created.payload.case.id);

  const blockedWhileOpen = await request("/api/shifts", {
    method: "POST",
    auth: managerAuth,
    body: { employeeNumber: "591", date: startDate, startTime, endTime, area: "Test", note: "" },
  });
  assert.equal(blockedWhileOpen.response.status, 409, JSON.stringify(blockedWhileOpen.payload));
  assert.equal(blockedWhileOpen.payload.code, "SICKNESS_SHIFT_CONFLICT");

  const missingOcrConfirmation = await uploadAum(employeeAuth, {
    incapacityFrom: startDate,
    sicknessCaseId: caseId,
    ocrAssisted: "1",
    ocrConfirmed: "0",
  });
  assert.equal(missingOcrConfirmation.response.status, 400, JSON.stringify(missingOcrConfirmation.payload));
  assert.equal(missingOcrConfirmation.payload.code, "AMU_OCR_CONFIRMATION_REQUIRED");

  const openAum = await uploadAum(employeeAuth, {
    incapacityFrom: startDate,
    incapacityTo: "",
    sicknessCaseId: caseId,
    ocrAssisted: "1",
    ocrConfirmed: "1",
  });
  assert.equal(openAum.response.status, 201, JSON.stringify(openAum.payload));
  assert.equal(openAum.payload.report.sickness_case_id, caseId);
  assert.equal(openAum.payload.report.incapacity_to, "");
  let caseAfterAum = (await request("/api/portal/v1/me/sickness-cases", { auth: employeeAuth })).payload.cases
    .find((entry) => entry.id === caseId);
  assert.equal(caseAfterAum.status, "aum_received");
  assert.equal(caseAfterAum.expected_end, "");

  const noCsrf = await fetch(`${baseUrl}/api/portal/v1/me/sickness-cases/${caseId}/return-to-work`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: employeeAuth.cookie },
    body: JSON.stringify({ returnDate }),
  });
  assert.equal(noCsrf.status, 403);

  const recovered = await request(`/api/portal/v1/me/sickness-cases/${caseId}/return-to-work`, {
    method: "POST", auth: employeeAuth, body: { returnDate },
  });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.payload));
  assert.equal(recovered.payload.case.status, "recovered");
  assert.equal(recovered.payload.case.return_to_work_date, returnDate);

  const protectedCaseRow = db.prepare("SELECT * FROM sickness_cases WHERE id = ?").get(caseId);
  assert.match(protectedCaseRow.protected_payload, /^enc:v2:/);
  assert.equal(protectedCaseRow.protected_payload.includes(returnDate), false);
  const alertPayloads = () => db.prepare("SELECT * FROM sickness_alerts WHERE sickness_case_id = ?").all(caseId)
    .map((row) => parseProtectedJson(row.protected_payload, {
      namespace: "sickness-alert", recordId: row.id, field: "payload", employeeNumber: String(caseId),
    }));
  assert.equal(alertPayloads().some((entry) => entry.kind === "staffing_risk" && entry.status === "open"), true);
  const caseJobs = () => db.prepare("SELECT * FROM outbound_notification_jobs ORDER BY created_at, id").all()
    .filter((row) => parseProtectedJson(row.protected_payload, {
      namespace: "outbound-notification-job", recordId: row.id, field: "payload", employeeNumber: row.recipient_lookup,
    }).sicknessCaseId === caseId);
  assert.equal(caseJobs().every((row) => row.status === "pending"), true);

  const balancingShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES ('593', ?, ?, ?, ?, 'Rückkehrprüfung', '')
  `).run(departmentA, startDate, startTime, endTime);
  const postReturnDate = offsetDate(returnDate, 1);
  const postReturnConfig = daySettings()[["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    [new Date(`${postReturnDate}T12:00:00Z`).getUTCDay()]];
  const postReturnShift = db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES ('591', ?, ?, ?, ?, 'Nach Rückkehr', '')
  `).run(departmentA, postReturnDate, postReturnConfig.start, postReturnConfig.end);
  runSicknessEscalationSweep(new Date(`${startDate}T12:00:00+02:00`));
  assert.equal(alertPayloads().filter((entry) => entry.kind === "staffing_risk")
    .every((entry) => entry.status === "resolved"), true);
  db.prepare("DELETE FROM shifts WHERE id = ?").run(Number(postReturnShift.lastInsertRowid));
  db.prepare("DELETE FROM shifts WHERE id = ?").run(Number(balancingShift.lastInsertRowid));
  runSicknessEscalationSweep(new Date(`${startDate}T12:00:00+02:00`));
  assert.equal(alertPayloads().some((entry) => entry.kind === "staffing_risk" && entry.status === "open"), true);
  assert.equal(caseJobs().every((row) => row.status === "pending"), true);

  const stillBlockedBeforeReturn = await request("/api/shifts", {
    method: "POST",
    auth: managerAuth,
    body: { employeeNumber: "591", date: startDate, startTime, endTime, area: "Test", note: "" },
  });
  assert.equal(stillBlockedBeforeReturn.response.status, 409, JSON.stringify(stillBlockedBeforeReturn.payload));
  assert.equal(stillBlockedBeforeReturn.payload.code, "SICKNESS_SHIFT_CONFLICT");

  const returnDayConfig = daySettings()[["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    [new Date(`${returnDate}T12:00:00Z`).getUTCDay()]];
  if (returnDayConfig.open && new Date(`${returnDate}T12:00:00Z`).getUTCDay() !== 0) {
    const allowedFromReturn = await request("/api/shifts", {
      method: "POST",
      auth: managerAuth,
      body: {
        employeeNumber: "591", departmentId: departmentA, date: returnDate, startTime: returnDayConfig.start,
        endTime: returnDayConfig.end, area: "Rückkehr", note: "",
      },
    });
    assert.equal(allowedFromReturn.response.status, 201, JSON.stringify(allowedFromReturn.payload));
  }

  runSicknessEscalationSweep(new Date(`${returnDate}T12:00:00+02:00`));
  assert.equal(alertPayloads().filter((entry) => entry.kind === "staffing_risk")
    .every((entry) => entry.status === "resolved"), true);
  assert.equal(caseJobs().every((row) => row.status === "cancelled"), true);

  const laterAum = await uploadAum(employeeAuth, {
    incapacityFrom: startDate,
    sicknessCaseId: caseId,
    ocrAssisted: "0",
    ocrConfirmed: "0",
  });
  assert.equal(laterAum.response.status, 201, JSON.stringify(laterAum.payload));
  assert.equal(laterAum.payload.report.sickness_case_id, caseId);
  assert.equal(laterAum.payload.report.incapacity_to, "");
  caseAfterAum = (await request("/api/portal/v1/me/sickness-cases", { auth: employeeAuth })).payload.cases
    .find((entry) => entry.id === caseId);
  assert.equal(caseAfterAum.status, "recovered");
  assert.equal(caseAfterAum.return_to_work_date, returnDate);

  const storedReport = db.prepare("SELECT * FROM amu_reports WHERE id = ?").get(laterAum.payload.report.id);
  assert.equal(storedReport.incapacity_from, "");
  assert.equal(storedReport.incapacity_to, "");
  assert.match(storedReport.protected_payload, /^enc:v2:/);
  assert.equal(storedReport.protected_payload.includes(startDate), false);

  const withdrawLater = await request(`/api/portal/v1/me/amu-reports/${laterAum.payload.report.id}/withdraw`, {
    method: "POST", auth: employeeAuth, body: {},
  });
  assert.equal(withdrawLater.response.status, 200, JSON.stringify(withdrawLater.payload));
  const withdrawFirst = await request(`/api/portal/v1/me/amu-reports/${openAum.payload.report.id}/withdraw`, {
    method: "POST", auth: employeeAuth, body: {},
  });
  assert.equal(withdrawFirst.response.status, 200, JSON.stringify(withdrawFirst.payload));
  const caseWithoutAum = (await request("/api/portal/v1/me/sickness-cases", { auth: employeeAuth })).payload.cases
    .find((entry) => entry.id === caseId);
  assert.equal(caseWithoutAum.status, "recovered");
  assert.equal(caseWithoutAum.aum_received_at || "", "");
});

test("v0.59: ein gemeldetes AUM-Ende begrenzt die Nichtverfügbarkeit ohne zusätzliche Rückkehrmeldung", async () => {
  const employee = session("592", "employee");
  const { managerAuth, departmentA } = auth;
  const startDate = mostRecentPlanningDate();
  const firstFollowingDate = offsetDate(startDate, 1);
  const nextDate = new Date(`${firstFollowingDate}T12:00:00Z`).getUTCDay() === 0
    ? offsetDate(firstFollowingDate, 1) : firstFollowingDate;
  const created = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employee, body: { startDate, note: "" },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const caseId = Number(created.payload.case.id);
  const aum = await uploadAum(employee, {
    incapacityFrom: startDate,
    incapacityTo: startDate,
    sicknessCaseId: caseId,
  });
  assert.equal(aum.response.status, 201, JSON.stringify(aum.payload));
  const nextConfig = daySettings()[["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    [new Date(`${nextDate}T12:00:00Z`).getUTCDay()]];
  const allowed = await request("/api/shifts", {
    method: "POST",
    auth: managerAuth,
    body: {
      employeeNumber: "592", departmentId: departmentA, date: nextDate,
      startTime: nextConfig.start, endTime: nextConfig.end, area: "Nach AUM-Ende", note: "",
    },
  });
  assert.equal(allowed.response.status, 201, JSON.stringify(allowed.payload));
});

test("v0.59: direkter AUM-Upload legt einen geschuetzten Krankenstandsfall an und bleibt im Bereichsscope", async () => {
  const employee = session("600", "employee");
  const { managerAuth, delegatedReaderAuth, hrAuth, departmentA } = auth;
  const startDate = mostRecentPlanningDate();

  const invalidDate = await uploadAum(employee, { incapacityFrom: "2026-02-30" });
  assert.equal(invalidDate.response.status, 400, JSON.stringify(invalidDate.payload));
  assert.equal(invalidDate.payload.code, "AMU_DATE_INVALID");

  const direct = await uploadAum(employee, { incapacityFrom: startDate, incapacityTo: "" });
  assert.equal(direct.response.status, 201, JSON.stringify(direct.payload));
  assert.ok(Number(direct.payload.report.sickness_case_id) > 0);
  const caseId = Number(direct.payload.report.sickness_case_id);
  const ownCases = await request("/api/portal/v1/me/sickness-cases", { auth: employee });
  const directCase = ownCases.payload.cases.find((entry) => entry.id === caseId);
  assert.equal(directCase.status, "aum_received");
  assert.equal(directCase.amu_status, "received");
  assert.equal(directCase.start_date, startDate);
  assert.equal(directCase.expected_end, "");

  const day = daySettings()[["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    [new Date(`${startDate}T12:00:00Z`).getUTCDay()]];
  const blocked = await request("/api/shifts", {
    method: "POST",
    auth: managerAuth,
    body: {
      employeeNumber: "600", departmentId: departmentA, date: startDate,
      startTime: day.start, endTime: day.end, area: "Direkter Upload", note: "",
    },
  });
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, "SICKNESS_SHIFT_CONFLICT");

  const delegated = await request("/api/portal/v1/amu-reports", { auth: delegatedReaderAuth });
  assert.equal(delegated.response.status, 403, JSON.stringify(delegated.payload));
  const hr = await request("/api/portal/v1/amu-reports", { auth: hrAuth });
  assert.equal(hr.response.status, 200, JSON.stringify(hr.payload));
  assert.equal(hr.payload.reports.some((entry) => Number(entry.id) === Number(direct.payload.report.id)), true);
  const reviewed = await request(`/api/portal/v1/amu-reports/${direct.payload.report.id}/review`, {
    method: "PUT", auth: hrAuth, body: { action: "reviewed", note: "Geprüft" },
  });
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.payload));
  const managerSummary = await request("/api/portal/v1/sickness-cases", { auth: managerAuth });
  const reviewedCase = managerSummary.payload.cases.find((entry) => entry.id === caseId);
  assert.equal(reviewedCase.employee_note, "");
  assert.equal(reviewedCase.amu_status, "reviewed");
  assert.ok(Object.hasOwn(reviewedCase, "staffing_risk"));
});

test("v0.59: ein nachgereichtes AUM korrigiert eine zu frueh gemeldete Arbeitsfaehigkeit", async () => {
  const employee = session("601", "employee");
  const { managerAuth, departmentA } = auth;
  const startDate = mostRecentPlanningDate();
  const returnDate = offsetDate(startDate, 1);
  const created = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employee, body: { startDate, note: "" },
  });
  const caseId = Number(created.payload.case.id);
  const returned = await request(`/api/portal/v1/me/sickness-cases/${caseId}/return-to-work`, {
    method: "POST", auth: employee, body: { returnDate },
  });
  assert.equal(returned.response.status, 200, JSON.stringify(returned.payload));
  assert.equal(returned.payload.case.status, "recovered");

  const correction = await uploadAum(employee, {
    incapacityFrom: startDate,
    incapacityTo: returnDate,
    sicknessCaseId: caseId,
  });
  assert.equal(correction.response.status, 201, JSON.stringify(correction.payload));
  assert.equal(Number(correction.payload.report.sickness_case_id), caseId);
  const correctedCases = await request("/api/portal/v1/me/sickness-cases", { auth: employee });
  const corrected = correctedCases.payload.cases.find((entry) => entry.id === caseId);
  assert.equal(corrected.status, "aum_received");
  assert.equal(corrected.return_to_work_date, "");
  assert.equal(corrected.expected_end, returnDate);

  const blockedDate = new Date(`${returnDate}T12:00:00Z`).getUTCDay() === 0 ? startDate : returnDate;
  const day = daySettings()[["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    [new Date(`${blockedDate}T12:00:00Z`).getUTCDay()]];
  const blocked = await request("/api/shifts", {
    method: "POST",
    auth: managerAuth,
    body: {
      employeeNumber: "601", departmentId: departmentA, date: blockedDate,
      startTime: day.start, endTime: day.end, area: "Korrigierte Rückkehr", note: "",
    },
  });
  assert.equal(blocked.response.status, 409, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, "SICKNESS_SHIFT_CONFLICT");
});

test("v0.59: ein AUM ab dem Rueckkehrtag wird trotz alter Auswahl als neuer Fall gefuehrt", async () => {
  const employee = session("602", "employee");
  const startDate = mostRecentPlanningDate();
  const returnDate = offsetDate(startDate, 1);
  const created = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employee, body: { startDate, note: "" },
  });
  const oldCaseId = Number(created.payload.case.id);
  const returned = await request(`/api/portal/v1/me/sickness-cases/${oldCaseId}/return-to-work`, {
    method: "POST", auth: employee, body: { returnDate },
  });
  assert.equal(returned.response.status, 200, JSON.stringify(returned.payload));

  const nextAum = await uploadAum(employee, {
    incapacityFrom: returnDate,
    incapacityTo: returnDate,
    sicknessCaseId: oldCaseId,
  });
  assert.equal(nextAum.response.status, 201, JSON.stringify(nextAum.payload));
  assert.notEqual(Number(nextAum.payload.report.sickness_case_id), oldCaseId);
  const ownCases = await request("/api/portal/v1/me/sickness-cases", { auth: employee });
  const newCase = ownCases.payload.cases.find((entry) => Number(entry.id) === Number(nextAum.payload.report.sickness_case_id));
  assert.equal(newCase.status, "aum_received");
  assert.equal(newCase.start_date, returnDate);
});

test("v0.59: parallele direkte AUM-Uploads teilen sich genau einen Krankenstandsfall", async () => {
  const employee = session("603", "employee");
  const startDate = mostRecentPlanningDate();
  const [first, second] = await Promise.all([
    uploadAum(employee, { incapacityFrom: startDate }),
    uploadAum(employee, { incapacityFrom: startDate }),
  ]);
  assert.equal(first.response.status, 201, JSON.stringify(first.payload));
  assert.equal(second.response.status, 201, JSON.stringify(second.payload));
  assert.notEqual(Number(first.payload.report.id), Number(second.payload.report.id));
  assert.equal(Number(first.payload.report.sickness_case_id), Number(second.payload.report.sickness_case_id));
  const ownCases = await request("/api/portal/v1/me/sickness-cases", { auth: employee });
  assert.equal(ownCases.response.status, 200, JSON.stringify(ownCases.payload));
  assert.equal(ownCases.payload.cases.length, 1);
});

test("v0.59: ein erneut überfälliger AUM-Hinweis wird für die Leitung wieder ungelesen", async () => {
  const employee = session("604", "employee");
  const { managerAuth } = auth;
  const startDate = mostRecentPlanningDate();
  const existingIds = new Set(db.prepare(`
    SELECT id FROM portal_notifications WHERE recipient_employee_number = '593'
  `).all().map((row) => row.id));
  const created = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employee, body: { startDate, note: "" },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const caseId = Number(created.payload.case.id);
  const caseNotification = db.prepare(`
    SELECT id, entity_id FROM portal_notifications
    WHERE recipient_employee_number = '593'
    ORDER BY rowid DESC
  `).all().find((row) => !existingIds.has(row.id));
  assert.ok(caseNotification?.entity_id);
  db.prepare(`
    UPDATE portal_notifications SET read_at = CURRENT_TIMESTAMP
    WHERE recipient_employee_number = '593' AND entity_id = ?
  `).run(caseNotification.entity_id);
  const overdueAt = new Date(`${offsetDate(startDate, 10)}T12:00:00+02:00`);
  runSicknessEscalationSweep(overdueAt);
  const unreadCaseNotifications = () => db.prepare(`
    SELECT COUNT(*) AS count FROM portal_notifications
    WHERE recipient_employee_number = '593' AND entity_id = ? AND read_at IS NULL
  `).get(caseNotification.entity_id).count;
  assert.equal(unreadCaseNotifications(), 1);

  const aum = await uploadAum(employee, { incapacityFrom: startDate, sicknessCaseId: caseId });
  assert.equal(aum.response.status, 201, JSON.stringify(aum.payload));
  assert.equal(unreadCaseNotifications(), 0);
  const withdrawn = await request(`/api/portal/v1/me/amu-reports/${aum.payload.report.id}/withdraw`, {
    method: "POST", auth: employee, body: {},
  });
  assert.equal(withdrawn.response.status, 200, JSON.stringify(withdrawn.payload));
  runSicknessEscalationSweep(overdueAt);
  assert.equal(unreadCaseNotifications(), 1);

  const managerView = await request("/api/portal/v1/sickness-cases", { auth: managerAuth });
  assert.equal(managerView.response.status, 200, JSON.stringify(managerView.payload));
  assert.equal(managerView.payload.cases.some((entry) => Number(entry.id) === caseId), true);
});

test("v0.59: ein späterer getrennter AUM-Zeitraum erzeugt einen neuen Krankenstandsfall", async () => {
  const employee = session("606", "employee");
  const firstDate = offsetDate(mostRecentPlanningDate(), -20);
  const laterDate = offsetDate(firstDate, 10);
  const first = await uploadAum(employee, { incapacityFrom: firstDate, incapacityTo: firstDate });
  assert.equal(first.response.status, 201, JSON.stringify(first.payload));
  const later = await uploadAum(employee, { incapacityFrom: laterDate, incapacityTo: laterDate });
  assert.equal(later.response.status, 201, JSON.stringify(later.payload));
  assert.notEqual(Number(later.payload.report.sickness_case_id), Number(first.payload.report.sickness_case_id));
  const ownCases = await request("/api/portal/v1/me/sickness-cases", { auth: employee });
  assert.equal(ownCases.response.status, 200, JSON.stringify(ownCases.payload));
  assert.equal(ownCases.payload.cases.length, 2);
});

test("v0.59: eine neue Krankmeldung nach einem begrenzten früheren Zeitraum ist zulässig", async () => {
  const employee = session("607", "employee");
  const firstDate = offsetDate(mostRecentPlanningDate(), -4);
  const laterDate = offsetDate(firstDate, 2);
  const first = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employee, body: { startDate: firstDate, expectedEnd: firstDate, note: "" },
  });
  assert.equal(first.response.status, 201, JSON.stringify(first.payload));
  const later = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employee, body: { startDate: laterDate, expectedEnd: laterDate, note: "" },
  });
  assert.equal(later.response.status, 201, JSON.stringify(later.payload));
  assert.notEqual(Number(later.payload.case.id), Number(first.payload.case.id));
  const duplicate = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employee, body: { startDate: laterDate, expectedEnd: laterDate, note: "" },
  });
  assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.payload));
  assert.equal(duplicate.payload.code, "SICKNESS_CASE_OVERLAP");
});

test("v0.59: eine nachträgliche Krankmeldung macht eine bestehende Zeitprüfung veraltet", async () => {
  const employee = session("608", "employee");
  const { managerAuth, departmentA } = auth;
  const date = offsetDate(mostRecentPlanningDate(), -1);
  const day = daySettings()[["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    [new Date(`${date}T12:00:00Z`).getUTCDay()]];
  db.prepare(`
    INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area, note)
    VALUES ('608', ?, ?, ?, ?, 'Zeitprüfung', '')
  `).run(departmentA, date, day.start, day.end);
  const review = await request(`/api/portal/v1/time-day-reviews/608/${date}`, {
    method: "PUT",
    auth: managerAuth,
    body: { locationId: "91", departmentId: departmentA, reviewed: true, note: "Vor Krankmeldung geprüft" },
  });
  assert.equal(review.response.status, 200, JSON.stringify(review.payload));
  assert.equal(review.payload.evaluation.review.stale, false);

  const sickness = await request("/api/portal/v1/me/sickness-cases", {
    method: "POST", auth: employee, body: { startDate: date, expectedEnd: date, note: "" },
  });
  assert.equal(sickness.response.status, 201, JSON.stringify(sickness.payload));
  const evaluation = await request(`/api/portal/v1/time-day-evaluations?locationId=91&departmentId=${departmentA}&date=${date}`, {
    auth: managerAuth,
  });
  assert.equal(evaluation.response.status, 200, JSON.stringify(evaluation.payload));
  const employeeDay = evaluation.payload.dayReview.evaluations.find((entry) => entry.employeeNumber === "608");
  assert.ok(employeeDay);
  assert.equal(employeeDay.review.stale, true);
  assert.equal(employeeDay.code, "excused_absence");
});

test("AUM Block 3: direkter Anhang prüft die tatsächliche Datei gegen den geschützten Personalakt", async () => {
  const { hrAuth } = auth;
  const matchingEmployee = session("609", "employee");
  const manualEmployee = session("610", "employee");
  const noProfileEmployee = session("611", "employee");
  const socialSecurityNumber = "1238010190";
  const manualSocialSecurityNumber = "1009311299";
  const foreignSocialSecurityNumber = "1000000005";
  const today = mostRecentPlanningDate();

  for (const [employeeNumber, number] of [["609", socialSecurityNumber], ["610", manualSocialSecurityNumber]]) {
    const profile = await request(`/api/portal/v1/personnel-records/${employeeNumber}`, {
      method: "PUT",
      auth: hrAuth,
      body: { sensitive: { socialSecurityNumber: number } },
    });
    assert.equal(profile.response.status, 200, JSON.stringify(profile.payload));
  }

  try {
    process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT = `Versicherungsnummer: ${socialSecurityNumber}`;
    const matched = await uploadAum(matchingEmployee, {
      incapacityFrom: today,
      incapacityTo: today,
      sicknessNote: "Direkt mit AUM gemeldet",
      directSicknessReport: "1",
    });
    assert.equal(matched.response.status, 201, JSON.stringify(matched.payload));
    assert.equal(Object.hasOwn(matched.payload.report, "identity_check"), false);
    assert.equal(JSON.stringify(matched.payload).includes(socialSecurityNumber), false);
    const ownCases = await request("/api/portal/v1/me/sickness-cases", { auth: matchingEmployee });
    assert.equal(ownCases.payload.cases.length, 1);
    assert.equal(ownCases.payload.cases[0].status, "aum_received");

    const protectedList = await request("/api/portal/v1/amu-reports", { auth: hrAuth });
    assert.equal(protectedList.response.status, 200, JSON.stringify(protectedList.payload));
    const matchedForHr = protectedList.payload.reports.find((entry) => Number(entry.id) === Number(matched.payload.report.id));
    assert.deepEqual(matchedForHr.identity_check.status, "matched");
    assert.equal(JSON.stringify(matchedForHr).includes(socialSecurityNumber), false);

    db.prepare(`
      INSERT INTO portal_settings (key, value, updated_at) VALUES ('amu_ocr_enabled', '0', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run();
    const matchedWithoutLocalDateOcr = await uploadAum(matchingEmployee, {
      incapacityFrom: offsetDate(today, -1),
    });
    assert.equal(matchedWithoutLocalDateOcr.response.status, 201, JSON.stringify(matchedWithoutLocalDateOcr.payload));
    const protectedListWithoutLocalDateOcr = await request("/api/portal/v1/amu-reports", { auth: hrAuth });
    assert.equal(
      protectedListWithoutLocalDateOcr.payload.reports.find(
        (entry) => Number(entry.id) === Number(matchedWithoutLocalDateOcr.payload.report.id),
      ).identity_check.status,
      "matched",
    );
    db.prepare("UPDATE portal_settings SET value = '1', updated_at = CURRENT_TIMESTAMP WHERE key = 'amu_ocr_enabled'").run();

    process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT = "Keine eindeutig beschriftete SV-Nummer";
    const manual = await uploadAum(manualEmployee, { incapacityFrom: today });
    assert.equal(manual.response.status, 201, JSON.stringify(manual.payload));
    const manualList = await request("/api/portal/v1/amu-reports", { auth: hrAuth });
    assert.equal(manualList.payload.reports.find((entry) => Number(entry.id) === Number(manual.payload.report.id)).identity_check.status, "not_detected");

    process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT = `SV-Nummer ${socialSecurityNumber}`;
    const missingProfile = await uploadAum(noProfileEmployee, { incapacityFrom: today });
    assert.equal(missingProfile.response.status, 201, JSON.stringify(missingProfile.payload));
    const profileList = await request("/api/portal/v1/amu-reports", { auth: hrAuth });
    assert.equal(profileList.payload.reports.find((entry) => Number(entry.id) === Number(missingProfile.payload.report.id)).identity_check.status, "profile_missing");

    const reportsBeforeMismatch = db.prepare("SELECT COUNT(*) AS count FROM amu_reports").get().count;
    const documentsBeforeMismatch = db.prepare("SELECT COUNT(*) AS count FROM amu_documents").get().count;
    const blobsBeforeMismatch = protectedBlobCount();
    process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT = `Sozialversicherungsnummer ${foreignSocialSecurityNumber}`;
    const mismatch = await uploadAum(manualEmployee, { incapacityFrom: offsetDate(today, -1) });
    assert.equal(mismatch.response.status, 422, JSON.stringify(mismatch.payload));
    assert.equal(mismatch.payload.code, "AMU_SOCIAL_SECURITY_MISMATCH");
    assert.equal(JSON.stringify(mismatch.payload).includes(foreignSocialSecurityNumber), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM amu_reports").get().count, reportsBeforeMismatch);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM amu_documents").get().count, documentsBeforeMismatch);
    assert.equal(protectedBlobCount(), blobsBeforeMismatch);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE detail LIKE ? OR detail LIKE ?").get(
      `%${socialSecurityNumber}%`, `%${foreignSocialSecurityNumber}%`,
    ).count, 0);
  } finally {
    db.prepare("UPDATE portal_settings SET value = '1', updated_at = CURRENT_TIMESTAMP WHERE key = 'amu_ocr_enabled'").run();
    delete process.env.GRABENPLANER_TEST_AMU_IDENTITY_TEXT;
  }
});
