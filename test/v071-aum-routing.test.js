"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-aum-routing-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db, releaseInstanceLockForTests } = require("../server");

let httpServer;
let baseUrl;
let auth;

function daySettings() {
  return Object.fromEntries([
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ].map((day) => [day, {
    open: day !== "sunday",
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

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(employeeNumber, role);
  db.prepare(`
    INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at)
    VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')
  `).run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function api(route, { method = "GET", auth = null, body } = {}) {
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

async function uploadAum(auth, date) {
  const form = new FormData();
  form.append("incapacityFrom", date);
  form.append("incapacityTo", "");
  form.append("ocrAssisted", "0");
  form.append("ocrConfirmed", "0");
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  form.append("documents", new Blob([onePixelPng], { type: "image/png" }), "aum-test.png");
  const response = await fetch(`${baseUrl}/api/portal/v1/me/amu-reports`, {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf },
    body: form,
  });
  const payload = await response.json();
  return { response, payload };
}

function reportFrom(payload, reportId) {
  return payload.reports.find((report) => Number(report.id) === Number(reportId));
}

test.before(async () => {
  const settings = JSON.stringify(daySettings());
  db.prepare("INSERT INTO locations (id, name, min_staff, day_settings_json, active) VALUES ('171', 'Routing Nord', 2, ?, 1)")
    .run(settings);
  db.prepare("INSERT INTO locations (id, name, min_staff, day_settings_json, active) VALUES ('172', 'Routing Sued', 2, ?, 1)")
    .run(settings);
  const northDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES ('171', 'Nord Team', 0, 1, 1)
  `).run().lastInsertRowid);
  const southDepartment = Number(db.prepare(`
    INSERT INTO departments (location_id, name, min_staff, active, sort_order)
    VALUES ('172', 'Sued Team', 0, 1, 1)
  `).run().lastInsertRowid);

  insertEmployee("7101", "AUM Nord Eins", "171", northDepartment);
  insertEmployee("7102", "AUM Nord Zwei", "171", northDepartment);
  insertEmployee("7103", "AUM Sued Eins", "172", southDepartment);
  insertEmployee("7191", "Leitung Nord", "171", northDepartment);
  insertEmployee("7192", "Leitung Sued", "172", southDepartment);
  insertEmployee("7193", "Abteilung Nord", "171", northDepartment);
  insertEmployee("7194", "Personal Leitung", "172", southDepartment);

  const employeeNorthOne = session("7101", "employee");
  const employeeNorthTwo = session("7102", "employee");
  const employeeSouth = session("7103", "employee");
  const managerNorth = session("7191", "manager");
  const managerSouth = session("7192", "manager");
  const departmentManager = session("7193", "department_manager");
  const hr = session("7194", "hr");

  const assignScope = db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, ?, ?, 'test')
  `);
  assignScope.run("7191", "171", northDepartment);
  assignScope.run("7192", "172", southDepartment);
  assignScope.run("7193", "171", northDepartment);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  auth = {
    employeeNorthOne,
    employeeNorthTwo,
    employeeSouth,
    managerNorth,
    managerSouth,
    departmentManager,
    hr,
  };
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  db.close();
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("v0.71: AUM-Zugriff folgt Filialscope, PL-Routing und persönlichen Ausnahmen", async () => {
  const {
    employeeNorthOne,
    employeeNorthTwo,
    employeeSouth,
    managerNorth,
    managerSouth,
    departmentManager,
    hr,
  } = auth;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const firstNorth = await uploadAum(employeeNorthOne, today);
  assert.equal(firstNorth.response.status, 201, JSON.stringify(firstNorth.payload));
  const secondNorth = await uploadAum(employeeNorthTwo, today);
  assert.equal(secondNorth.response.status, 201, JSON.stringify(secondNorth.payload));
  const south = await uploadAum(employeeSouth, today);
  assert.equal(south.response.status, 201, JSON.stringify(south.payload));

  const firstNorthId = Number(firstNorth.payload.report.id);
  const secondNorthId = Number(secondNorth.payload.report.id);
  const southId = Number(south.payload.report.id);
  const firstNorthDocumentId = firstNorth.payload.report.documents[0].id;

  const northDefault = await api("/api/portal/v1/amu-reports", { auth: managerNorth });
  assert.equal(northDefault.response.status, 200, JSON.stringify(northDefault.payload));
  assert.equal(northDefault.payload.access.mode, "local_manager");
  assert.equal(northDefault.payload.canOpenFiles, true);
  assert.equal(northDefault.payload.canReview, true);
  assert.deepEqual(northDefault.payload.reports.map((report) => Number(report.id)).sort((a, b) => a - b),
    [firstNorthId, secondNorthId].sort((a, b) => a - b));
  const northReport = reportFrom(northDefault.payload, firstNorthId);
  assert.equal(northReport.responsibility.stage, "local");
  assert.equal(northReport.responsibility.assigned_to_me, true);
  assert.equal(northReport.responsibility.can_review, true);
  assert.equal(Object.hasOwn(northReport, "identity_check"), false);
  assert.equal(Object.hasOwn(northReport, "automatic_review"), false);
  assert.equal(Object.hasOwn(northReport, "protected_payload"), false);

  const hrDefault = await api("/api/portal/v1/amu-reports", { auth: hr });
  assert.equal(hrDefault.response.status, 200, JSON.stringify(hrDefault.payload));
  const hrNorthReport = reportFrom(hrDefault.payload, firstNorthId);
  assert.equal(Object.hasOwn(hrNorthReport, "identity_check"), true);
  assert.equal(Object.hasOwn(hrNorthReport, "automatic_review"), true);
  assert.equal(hrNorthReport.responsibility.stage, "local");
  assert.equal(hrNorthReport.responsibility.assigned_to_me, false);

  const sameLocationDocument = await fetch(
    `${baseUrl}/api/portal/v1/amu-reports/${firstNorthId}/documents/${firstNorthDocumentId}/content`,
    { headers: { Cookie: managerNorth.cookie } },
  );
  assert.equal(sameLocationDocument.status, 200);
  const crossLocationDocument = await fetch(
    `${baseUrl}/api/portal/v1/amu-reports/${firstNorthId}/documents/${firstNorthDocumentId}/content`,
    { headers: { Cookie: managerSouth.cookie } },
  );
  assert.equal(crossLocationDocument.status, 403);

  const departmentOverview = await api("/api/portal/v1/amu-reports", { auth: departmentManager });
  assert.equal(departmentOverview.response.status, 200, JSON.stringify(departmentOverview.payload));
  assert.deepEqual(departmentOverview.payload.reports, []);
  assert.equal(departmentOverview.payload.access.available, false);
  const departmentDocument = await fetch(
    `${baseUrl}/api/portal/v1/amu-reports/${firstNorthId}/documents/${firstNorthDocumentId}/content`,
    { headers: { Cookie: departmentManager.cookie } },
  );
  assert.equal(departmentDocument.status, 403);

  const managerCannotChangePolicy = await api("/api/portal/v1/amu-access-policy", {
    method: "PUT", auth: managerNorth, body: { managerDefault: false, overrides: [] },
  });
  assert.equal(managerCannotChangePolicy.response.status, 403);

  const roleWideRevoke = await api("/api/portal/v1/amu-access-policy", {
    method: "PUT", auth: hr, body: { managerDefault: false, overrides: [] },
  });
  assert.equal(roleWideRevoke.response.status, 200, JSON.stringify(roleWideRevoke.payload));
  assert.equal(roleWideRevoke.payload.policy.managerDefault, false);

  const northRevoked = await api("/api/portal/v1/amu-reports", { auth: managerNorth });
  assert.equal(northRevoked.response.status, 200, JSON.stringify(northRevoked.payload));
  assert.deepEqual(northRevoked.payload.reports, []);
  assert.equal(northRevoked.payload.canOpenFiles, false);
  assert.equal(northRevoked.payload.canReview, false);

  const hrFallback = await api("/api/portal/v1/amu-reports", { auth: hr });
  const fallbackNorth = reportFrom(hrFallback.payload, secondNorthId);
  const fallbackSouth = reportFrom(hrFallback.payload, southId);
  assert.equal(fallbackNorth.responsibility.stage, "hr");
  assert.equal(fallbackNorth.responsibility.assigned_to_me, true);
  assert.equal(fallbackNorth.responsibility.can_review, true);
  assert.equal(fallbackSouth.responsibility.stage, "hr");
  assert.equal(fallbackSouth.responsibility.assigned_to_me, true);

  const allowNorthOnly = await api("/api/portal/v1/amu-access-policy", {
    method: "PUT",
    auth: hr,
    body: { managerDefault: false, overrides: [{ employeeNumber: "7191", accessMode: "allow" }] },
  });
  assert.equal(allowNorthOnly.response.status, 200, JSON.stringify(allowNorthOnly.payload));
  const northPolicy = allowNorthOnly.payload.policy.managers.find((manager) => manager.employeeNumber === "7191");
  const southPolicy = allowNorthOnly.payload.policy.managers.find((manager) => manager.employeeNumber === "7192");
  assert.equal(northPolicy.effectiveAccess, true);
  assert.equal(northPolicy.accessMode, "allow");
  assert.equal(southPolicy.effectiveAccess, false);
  assert.equal(southPolicy.accessMode, "inherit");

  const northAllowed = await api("/api/portal/v1/amu-reports", { auth: managerNorth });
  assert.equal(northAllowed.payload.reports.some((report) => Number(report.id) === secondNorthId), true);
  const southStillRevoked = await api("/api/portal/v1/amu-reports", { auth: managerSouth });
  assert.deepEqual(southStillRevoked.payload.reports, []);

  const denyNorthAgainstDefault = await api("/api/portal/v1/amu-access-policy", {
    method: "PUT",
    auth: hr,
    body: { managerDefault: true, overrides: [{ employeeNumber: "7191", accessMode: "deny" }] },
  });
  assert.equal(denyNorthAgainstDefault.response.status, 200, JSON.stringify(denyNorthAgainstDefault.payload));
  assert.equal(denyNorthAgainstDefault.payload.policy.managerDefault, true);
  assert.equal(denyNorthAgainstDefault.payload.policy.managers.find((manager) => manager.employeeNumber === "7191").effectiveAccess, false);
  assert.equal(denyNorthAgainstDefault.payload.policy.managers.find((manager) => manager.employeeNumber === "7192").effectiveAccess, true);

  const northDenied = await api("/api/portal/v1/amu-reports", { auth: managerNorth });
  assert.deepEqual(northDenied.payload.reports, []);
  const southAllowed = await api("/api/portal/v1/amu-reports", { auth: managerSouth });
  assert.equal(southAllowed.payload.reports.some((report) => Number(report.id) === southId), true);

  const restoreDefaults = await api("/api/portal/v1/amu-access-policy", {
    method: "PUT", auth: hr, body: { managerDefault: true, overrides: [] },
  });
  assert.equal(restoreDefaults.response.status, 200, JSON.stringify(restoreDefaults.payload));

  const review = await api(`/api/portal/v1/amu-reports/${firstNorthId}/review`, {
    method: "PUT", auth: managerNorth, body: { action: "reviewed", note: "Lokal geprüft" },
  });
  assert.equal(review.response.status, 200, JSON.stringify(review.payload));
  assert.equal(review.payload.report.status, "reviewed");
  assert.equal(review.payload.report.reviewed_by, "7191");
  assert.equal(Object.hasOwn(review.payload.report, "identity_check"), false);

  const withdrawnDocumentId = secondNorth.payload.report.documents[0].id;
  const withdrawn = await api(`/api/portal/v1/me/amu-reports/${secondNorthId}/withdraw`, {
    method: "POST", auth: employeeNorthTwo, body: {},
  });
  assert.equal(withdrawn.response.status, 200, JSON.stringify(withdrawn.payload));
  const managerAfterWithdrawal = await api("/api/portal/v1/amu-reports", { auth: managerNorth });
  assert.equal(managerAfterWithdrawal.payload.reports.some((report) => Number(report.id) === secondNorthId), false);
  const withdrawnManagerDocument = await fetch(
    `${baseUrl}/api/portal/v1/amu-reports/${secondNorthId}/documents/${withdrawnDocumentId}/content`,
    { headers: { Cookie: managerNorth.cookie } },
  );
  assert.equal(withdrawnManagerDocument.status, 404);
  const hrAfterWithdrawal = await api("/api/portal/v1/amu-reports", { auth: hr });
  assert.equal(hrAfterWithdrawal.payload.reports.some((report) => Number(report.id) === secondNorthId), true);
});
