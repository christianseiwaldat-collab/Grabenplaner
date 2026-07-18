"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-field-rights-"));
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

const MANAGER = "9510";
const DEPARTMENT_MANAGER = "9511";
const NO_SCOPE_MANAGER = "9512";
const TARGET_A = "9520";
const TARGET_B = "9521";
const TARGET_REMOTE = "9522";
const TARGET_UNASSIGNED = "9523";

let httpServer;
let baseUrl;
let positionId;
let departmentA;
let departmentB;
let departmentRemote;

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      role_locked = 0,
      active = 1,
      must_change_password = 0,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
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
  return { response, payload, text };
}

async function uploadDocument(employeeNumber, auth, marker = "Feldrecht") {
  const content = Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nendobj\n% ${marker}\n%%EOF`, "utf8");
  const form = new FormData();
  form.append("category", "contract");
  form.append("title", `Vertrag ${marker}`);
  form.append("documentDate", "2026-03-01");
  form.append("description", `Geschützt ${marker}`);
  form.append("document", new Blob([content], { type: "application/pdf" }), `${marker}.pdf`);
  const response = await fetch(`${baseUrl}/api/portal/v1/personnel-records/${encodeURIComponent(employeeNumber)}/documents`, {
    method: "POST",
    headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf, Accept: "application/json" },
    body: form,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload, text, content };
}

function ensureEmployee(personnelNumber, locationId, departmentId, level = "C") {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       position_id, time_confirmation_level, home_location_id, preferred_department_id, active)
    VALUES (?, ?, ?, '#2c7a68', 38.5, 5, ?, ?, ?, ?, 1)
    ON CONFLICT(personnel_number) DO UPDATE SET
      position_id = excluded.position_id,
      time_confirmation_level = excluded.time_confirmation_level,
      home_location_id = excluded.home_location_id,
      preferred_department_id = excluded.preferred_department_id,
      active = 1
  `).run(personnelNumber, `Testperson ${personnelNumber}`, `T${personnelNumber}`, positionId, level, locationId, departmentId);
}

function protectedProfile(marker) {
  return {
    phone: "+43 512 5559100",
    sensitive: {
      identity: {
        firstName: `Vorname-${marker}`,
        lastName: `Nachname-${marker}`,
        previousName: `Alt-${marker}`,
        salutation: "Frau",
        title: "Mag.",
        birthDate: "1991-04-18",
        birthPlace: `Ort-${marker}`,
        nationality: "Österreich",
      },
      accountHolder: `Kontoinhaber ${marker}`,
      alternatePhone: "+43 664 5559101",
      privateEmail: `${marker.toLowerCase()}@example.test`,
      emergencyContact: {
        name: `Notfall-${marker}`,
        relationship: "Schwester",
        phone: "+43 650 5559102",
      },
      address: {
        street: `Geheimweg ${marker} 7`,
        supplement: "Stiege B",
        postalCode: "6020",
        city: `Stadt-${marker}`,
        state: "Tirol",
        country: "Österreich",
      },
      employment: {
        startDate: "2024-02-01",
        endDate: "",
        fixedTermEnd: "2028-01-31",
        probationEnd: "2024-03-31",
        employmentType: "Angestellt",
        contractType: "Befristet",
        employmentStatus: "Aktiv",
        collectiveAgreement: `Handel-${marker}`,
        classification: `Stufe-${marker}`,
        payrollGroup: `Gruppe-${marker}`,
        notes: `Vertraulich-${marker}`,
      },
    },
  };
}

function employeeMutationBody(personnelNumber, {
  locationId = "91",
  departmentId = departmentA,
  nickname = `T${personnelNumber}`,
  personnelRecord,
} = {}) {
  return {
    personnelNumber,
    fullName: `Testperson ${personnelNumber}`,
    nickname,
    contractedHours: 38.5,
    targetWorkdaysPerWeek: 5,
    positionId,
    homeLocationId: locationId,
    preferredDepartmentId: departmentId,
    preferredDayOff: "",
    fixedWorkdays: [],
    color: "#2c7a68",
    active: true,
    ...(personnelRecord === undefined ? {} : { personnelRecord }),
  };
}

async function saveProfile(employeeNumber, auth, marker) {
  const profile = protectedProfile(marker);
  const saved = await request(`/api/portal/v1/personnel-records/${employeeNumber}`, {
    method: "PUT", auth, body: profile,
  });
  assert.equal(saved.response.status, 200, saved.text);
  return profile;
}

async function rightsPayload(auth) {
  const result = await request("/api/portal/v1/personnel-field-rights", { auth });
  assert.equal(result.response.status, 200, result.text);
  return result.payload;
}

function completeMatrix(payload, role, overrides = {}) {
  return Object.fromEntries(payload.fields.map((field) => [
    field.key,
    Object.hasOwn(overrides, field.key) ? overrides[field.key] : payload.matrix[role][field.key],
  ]));
}

async function saveMatrix(auth, role, fields) {
  return request(`/api/portal/v1/personnel-field-rights/${role}`, {
    method: "PUT", auth, body: { fields },
  });
}

function blobPath(storageKey) {
  return path.join(testRoot, "app-data", "private", "amu", "blobs", ...String(storageKey).split("/"));
}

function latestDeniedAudit(actor, employeeNumber) {
  const row = db.prepare(`
    SELECT detail FROM audit_log
    WHERE actor = ? AND action = 'personnel-record.access.denied' AND entity_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(actor, employeeNumber);
  assert.ok(row, `Fehlendes Denied-Audit für ${actor}/${employeeNumber}`);
  return { raw: row.detail, detail: JSON.parse(row.detail) };
}

test.before(async () => {
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  db.prepare("INSERT OR IGNORE INTO locations (id, name, active) VALUES ('91', 'Testfiliale A', 1)").run();
  db.prepare("INSERT OR IGNORE INTO locations (id, name, active) VALUES ('92', 'Testfiliale B', 1)").run();
  const insertDepartment = db.prepare(`
    INSERT OR IGNORE INTO departments (location_id, name, active, sort_order)
    VALUES (?, ?, 1, ?)
  `);
  insertDepartment.run("91", "Abteilung A", 1);
  insertDepartment.run("91", "Abteilung B", 2);
  insertDepartment.run("92", "Abteilung C", 1);
  departmentA = db.prepare("SELECT id FROM departments WHERE location_id = '91' AND name = 'Abteilung A'").get().id;
  departmentB = db.prepare("SELECT id FROM departments WHERE location_id = '91' AND name = 'Abteilung B'").get().id;
  departmentRemote = db.prepare("SELECT id FROM departments WHERE location_id = '92' AND name = 'Abteilung C'").get().id;

  ensureEmployee(MANAGER, "91", departmentA, "A");
  ensureEmployee(DEPARTMENT_MANAGER, "91", departmentA, "A");
  ensureEmployee(NO_SCOPE_MANAGER, null, null, "A");
  ensureEmployee(TARGET_A, "91", departmentA);
  ensureEmployee(TARGET_B, "91", departmentB);
  ensureEmployee(TARGET_REMOTE, "92", departmentRemote);
  ensureEmployee(TARGET_UNASSIGNED, null, null);
  // portal_access_scopes references portal_users. Create the three test
  // identities before assigning their explicit location/department scopes.
  session(MANAGER, "manager");
  session(DEPARTMENT_MANAGER, "department_manager");
  session(NO_SCOPE_MANAGER, "manager");
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number IN (?, ?, ?)")
    .run(MANAGER, DEPARTMENT_MANAGER, NO_SCOPE_MANAGER);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, assigned_by)
    VALUES (?, '91', 'test')
  `).run(MANAGER);
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES (?, '91', ?, 'test')
  `).run(DEPARTMENT_MANAGER, departmentA);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(() => {
  const documentRows = db.prepare(`
    SELECT storage_key FROM personnel_record_documents
    WHERE employee_number IN (?, ?, ?, ?)
  `).all(TARGET_A, TARGET_B, TARGET_REMOTE, TARGET_UNASSIGNED);
  for (const row of documentRows) fs.rmSync(blobPath(row.storage_key), { force: true });
  db.prepare("DELETE FROM personnel_record_documents WHERE employee_number IN (?, ?, ?, ?)")
    .run(TARGET_A, TARGET_B, TARGET_REMOTE, TARGET_UNASSIGNED);
  db.prepare("DELETE FROM personnel_sensitive_records WHERE employee_number IN (?, ?, ?, ?)")
    .run(TARGET_A, TARGET_B, TARGET_REMOTE, TARGET_UNASSIGNED);
  db.prepare("DELETE FROM personnel_field_permissions").run();
  db.prepare("DELETE FROM portal_permission_grants WHERE employee_number IN (?, ?, ?)")
    .run(MANAGER, DEPARTMENT_MANAGER, NO_SCOPE_MANAGER);
  db.prepare("UPDATE employees SET time_confirmation_level = 'A' WHERE personnel_number IN (?, ?, ?)")
    .run(MANAGER, DEPARTMENT_MANAGER, NO_SCOPE_MANAGER);
  db.prepare(`
    UPDATE employees SET home_location_id = NULL, preferred_department_id = NULL
    WHERE personnel_number = ?
  `).run(NO_SCOPE_MANAGER);
  db.prepare(`
    INSERT INTO portal_settings (key, value, updated_at)
    VALUES ('trust_levels_enabled', '1', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP
  `).run();
  db.prepare(`
    DELETE FROM audit_log
    WHERE action LIKE 'personnel-field-rights.%'
       OR (action LIKE 'personnel-record.%' AND (actor IN (?, ?, '103', '106') OR entity_id IN (?, ?, ?, ?)))
  `).run(MANAGER, DEPARTMENT_MANAGER, TARGET_A, TARGET_B, TARGET_REMOTE, TARGET_UNASSIGNED);
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.71 Block 5: Migration und sichere Leitungsstandards sind vollständig", async () => {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'personnel_field_permissions'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.71-personnel-field-rights'").get());
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM personnel_field_permissions").get().count, 0);

  const hr = session("103", "hr");
  const rights = await rightsPayload(hr);
  assert.deepEqual(rights.accessLevels.map((entry) => entry.id), ["hidden", "read", "write"]);
  assert.deepEqual(rights.roles.map((entry) => entry.id), ["manager", "department_manager"]);
  assert.ok(rights.fields.length >= 30);
  assert.equal(rights.matrix.manager.phone, "read");
  assert.equal(rights.matrix.manager.documents, "hidden");
  assert.ok(Object.entries(rights.matrix.manager).every(([key, level]) => key === "phone" ? level === "read" : level === "hidden"));
  assert.ok(Object.values(rights.matrix.department_manager).every((level) => level === "hidden"));

  const profile = await saveProfile(TARGET_A, hr, "DEFAULT");
  const manager = session(MANAGER, "manager");
  const managerView = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: manager });
  assert.equal(managerView.response.status, 200, managerView.text);
  assert.equal(managerView.payload.profile.phone, profile.phone);
  assert.equal(managerView.payload.profile.sensitive, null);
  assert.deepEqual(managerView.payload.documents, []);
  assert.equal(managerView.payload.access.fieldAccess.phone, "read");
  assert.equal(managerView.payload.access.fieldAccess.privateEmail, "hidden");
  const defaultWriteDenied = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT", auth: manager, body: { phone: "+43 512 5559999" },
  });
  assert.equal(defaultWriteDenied.response.status, 403, defaultWriteDenied.text);
  assert.equal(defaultWriteDenied.payload.code, "PERSONNEL_PHONE_WRITE_DENIED");

  const departmentManager = session(DEPARTMENT_MANAGER, "department_manager");
  const departmentDefault = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: departmentManager });
  assert.equal(departmentDefault.response.status, 403, departmentDefault.text);
});

test("v0.71 Block 5: PL+ verwaltet nur vollständige und gültige Rollenmatrizen atomar", async () => {
  const hr = session("103", "hr");
  const rights = await rightsPayload(hr);
  assert.equal(rights.canChange, true);

  const manager = session(MANAGER, "manager");
  const managerDenied = await request("/api/portal/v1/personnel-field-rights", { auth: manager });
  assert.equal(managerDenied.response.status, 403, managerDenied.text);

  const itAdmin = session("106", "it_admin");
  const technicalManagement = await rightsPayload(itAdmin);
  assert.equal(technicalManagement.canChange, true);
  const technicalPersonnelDenied = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: itAdmin });
  assert.equal(technicalPersonnelDenied.response.status, 403, technicalPersonnelDenied.text);

  const partial = await saveMatrix(hr, "manager", { phone: "write" });
  assert.equal(partial.response.status, 400, partial.text);
  assert.equal(partial.payload.code, "PERSONNEL_FIELD_RIGHTS_INVALID");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM personnel_field_permissions").get().count, 0);

  const invalid = completeMatrix(rights, "manager", { privateEmail: "owner" });
  const invalidResult = await saveMatrix(hr, "manager", invalid);
  assert.equal(invalidResult.response.status, 400, invalidResult.text);
  assert.equal(invalidResult.payload.code, "PERSONNEL_FIELD_RIGHTS_INVALID");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM personnel_field_permissions").get().count, 0);

  const wrongRole = await saveMatrix(hr, "employee", completeMatrix(rights, "manager"));
  assert.equal(wrongRole.response.status, 400, wrongRole.text);
  assert.equal(wrongRole.payload.code, "PERSONNEL_FIELD_RIGHTS_ROLE_INVALID");

  const matrix = completeMatrix(rights, "manager", {
    "identity.firstName": "read",
    "employment.notes": "write",
    documents: "read",
  });
  const saved = await saveMatrix(hr, "manager", matrix);
  assert.equal(saved.response.status, 200, saved.text);
  assert.deepEqual(saved.payload.matrix.manager, matrix);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM personnel_field_permissions WHERE role_id = 'manager'").get().count,
    rights.fields.length);
  const audit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE action = 'personnel-field-rights.update' AND entity_id = 'manager'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.ok(audit);
  assert.doesNotMatch(audit.detail, /Testperson|Geheimweg|example\.test/i);
});

test("v0.71 Block 5: Filialleitung erhält exakt read/write, ohne partielle Rechteausweitung", async () => {
  const hr = session("103", "hr");
  const profile = await saveProfile(TARGET_A, hr, "MANAGER");
  const originalDocument = await uploadDocument(TARGET_A, hr, "ManagerRead");
  assert.equal(originalDocument.response.status, 201, originalDocument.text);
  const rights = await rightsPayload(hr);
  const matrix = completeMatrix(rights, "manager", {
    phone: "write",
    "identity.firstName": "read",
    "identity.lastName": "hidden",
    "address.city": "read",
    privateEmail: "hidden",
    "employment.notes": "write",
    documents: "read",
  });
  const policySaved = await saveMatrix(hr, "manager", matrix);
  assert.equal(policySaved.response.status, 200, policySaved.text);

  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'employees:write', '103')
  `).run(MANAGER);
  const manager = session(MANAGER, "manager");
  const view = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: manager });
  assert.equal(view.response.status, 200, view.text);
  assert.equal(view.payload.access.fieldAccess.phone, "write");
  assert.equal(view.payload.access.fieldAccess["identity.firstName"], "read");
  assert.equal(view.payload.access.fieldAccess["identity.lastName"], "hidden");
  assert.equal(view.payload.profile.phone, profile.phone);
  assert.equal(view.payload.profile.sensitive.identity.firstName, profile.sensitive.identity.firstName);
  assert.equal(Object.hasOwn(view.payload.profile.sensitive.identity, "lastName"), false);
  assert.equal(view.payload.profile.sensitive.address.city, profile.sensitive.address.city);
  assert.equal(Object.hasOwn(view.payload.profile.sensitive, "privateEmail"), false);
  assert.equal(view.payload.profile.sensitive.employment.notes, profile.sensitive.employment.notes);
  assert.equal(view.payload.documents.length, 1);

  const content = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/${TARGET_A}/documents/${encodeURIComponent(originalDocument.payload.document.id)}/content`,
    { headers: { Cookie: manager.cookie } },
  );
  assert.equal(content.status, 200, await content.clone().text());
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), originalDocument.content);

  const mixed = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT",
    auth: manager,
    body: {
      sensitive: {
        identity: { firstName: "Nicht erlaubt" },
        employment: { notes: "Darf nicht teilweise gespeichert werden" },
      },
    },
  });
  assert.equal(mixed.response.status, 403, mixed.text);
  assert.equal(mixed.payload.code, "PERSONNEL_FIELD_WRITE_DENIED");
  const afterDenied = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: hr });
  assert.equal(afterDenied.payload.profile.sensitive.identity.firstName, profile.sensitive.identity.firstName);
  assert.equal(afterDenied.payload.profile.sensitive.employment.notes, profile.sensitive.employment.notes);

  const employeeEndpointBypass = await request(`/api/employees/${TARGET_A}`, {
    method: "PUT",
    auth: manager,
    body: {
      personnelNumber: TARGET_A,
      fullName: `Testperson ${TARGET_A}`,
      nickname: "DarfNichtGespeichertWerden",
      contractedHours: 38.5,
      targetWorkdaysPerWeek: 5,
      positionId,
      homeLocationId: "91",
      preferredDepartmentId: departmentA,
      preferredDayOff: "",
      fixedWorkdays: [],
      color: "#2c7a68",
      active: true,
      personnelRecord: {
        sensitive: {
          identity: { firstName: "Bypass verboten" },
          employment: { notes: "Auch erlaubter Teil muss zurückrollen" },
        },
      },
    },
  });
  assert.equal(employeeEndpointBypass.response.status, 403, employeeEndpointBypass.text);
  assert.equal(employeeEndpointBypass.payload.code, "PERSONNEL_FIELD_WRITE_DENIED");
  assert.equal(db.prepare("SELECT nickname FROM employees WHERE personnel_number = ?").get(TARGET_A).nickname, `T${TARGET_A}`);
  const afterEmployeeBypass = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: hr });
  assert.equal(afterEmployeeBypass.payload.profile.sensitive.identity.firstName, profile.sensitive.identity.firstName);
  assert.equal(afterEmployeeBypass.payload.profile.sensitive.employment.notes, profile.sensitive.employment.notes);

  const secret = "Nur-Manager-Schreibfeld-4711";
  const allowed = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT",
    auth: manager,
    body: { phone: "+43 512 5559199", sensitive: { employment: { notes: secret } } },
  });
  assert.equal(allowed.response.status, 200, allowed.text);
  assert.deepEqual(allowed.payload.changedFields.sort(), ["employment.notes", "phone"]);
  const afterAllowed = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: hr });
  assert.equal(afterAllowed.payload.profile.phone, "+43 512 5559199");
  assert.equal(afterAllowed.payload.profile.sensitive.employment.notes, secret);
  assert.equal(afterAllowed.payload.profile.sensitive.privateEmail, profile.sensitive.privateEmail);
  const audit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE actor = ? AND action = 'personnel-record.update' AND entity_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(MANAGER, TARGET_A);
  assert.ok(audit);
  assert.match(audit.detail, /employment\.notes/);
  assert.equal(audit.detail.includes(secret), false);

  const readOnlyUpload = await uploadDocument(TARGET_A, manager, "ManagerDenied");
  assert.equal(readOnlyUpload.response.status, 403, readOnlyUpload.text);
  assert.equal(readOnlyUpload.payload.code, "PERSONNEL_DOCUMENT_WRITE_DENIED");

  const writeDocuments = { ...matrix, documents: "write" };
  const documentPolicy = await saveMatrix(hr, "manager", writeDocuments);
  assert.equal(documentPolicy.response.status, 200, documentPolicy.text);
  const managerDocument = await uploadDocument(TARGET_A, manager, "ManagerWrite");
  assert.equal(managerDocument.response.status, 201, managerDocument.text);
  const deleted = await request(
    `/api/portal/v1/personnel-records/${TARGET_A}/documents/${encodeURIComponent(managerDocument.payload.document.id)}`,
    { method: "DELETE", auth: manager },
  );
  assert.equal(deleted.response.status, 204, deleted.text);
});

test("v0.71 Block 5: Abteilungsleitung bleibt im Abteilungs-Scope und Dokumentrecht funktioniert eigenständig", async () => {
  const hr = session("103", "hr");
  await saveProfile(TARGET_A, hr, "DEPARTMENT-A");
  await saveProfile(TARGET_B, hr, "DEPARTMENT-B");
  const documentA = await uploadDocument(TARGET_A, hr, "DepartmentA");
  const documentB = await uploadDocument(TARGET_B, hr, "DepartmentB");
  assert.equal(documentA.response.status, 201, documentA.text);
  assert.equal(documentB.response.status, 201, documentB.text);

  const rights = await rightsPayload(hr);
  const documentsOnly = completeMatrix(rights, "department_manager", { documents: "read" });
  const saved = await saveMatrix(hr, "department_manager", documentsOnly);
  assert.equal(saved.response.status, 200, saved.text);

  const departmentManager = session(DEPARTMENT_MANAGER, "department_manager");
  const allowed = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: departmentManager });
  assert.equal(allowed.response.status, 200, allowed.text);
  assert.equal(allowed.payload.profile.phone, null);
  assert.equal(allowed.payload.profile.sensitive, null);
  assert.equal(allowed.payload.access.fieldAccess.documents, "read");
  assert.deepEqual(allowed.payload.documents.map((entry) => entry.id), [documentA.payload.document.id]);

  const allowedContent = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/${TARGET_A}/documents/${encodeURIComponent(documentA.payload.document.id)}/content`,
    { headers: { Cookie: departmentManager.cookie } },
  );
  assert.equal(allowedContent.status, 200, await allowedContent.clone().text());

  const crossDepartment = await request(`/api/portal/v1/personnel-records/${TARGET_B}`, { auth: departmentManager });
  assert.equal(crossDepartment.response.status, 403, crossDepartment.text);
  const crossDocument = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/${TARGET_B}/documents/${encodeURIComponent(documentB.payload.document.id)}/content`,
    { headers: { Cookie: departmentManager.cookie, Accept: "application/json" } },
  );
  assert.equal(crossDocument.status, 403, await crossDocument.clone().text());
  const remote = await request(`/api/portal/v1/personnel-records/${TARGET_REMOTE}`, { auth: departmentManager });
  assert.equal(remote.response.status, 403, remote.text);

  const noScopeManager = session(NO_SCOPE_MANAGER, "manager");
  const withoutScope = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: noScopeManager });
  assert.equal(withoutScope.response.status, 403, withoutScope.text);
  const withoutScopeDocument = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/${TARGET_A}/documents/${encodeURIComponent(documentA.payload.document.id)}/content`,
    { headers: { Cookie: noScopeManager.cookie, Accept: "application/json" } },
  );
  assert.equal(withoutScopeDocument.status, 403, await withoutScopeDocument.clone().text());

  const readUpload = await uploadDocument(TARGET_A, departmentManager, "DepartmentDenied");
  assert.equal(readUpload.response.status, 403, readUpload.text);
  const documentsWrite = { ...documentsOnly, documents: "write" };
  const writeSaved = await saveMatrix(hr, "department_manager", documentsWrite);
  assert.equal(writeSaved.response.status, 200, writeSaved.text);
  const written = await uploadDocument(TARGET_A, departmentManager, "DepartmentWrite");
  assert.equal(written.response.status, 201, written.text);
  const removed = await request(
    `/api/portal/v1/personnel-records/${TARGET_A}/documents/${encodeURIComponent(written.payload.document.id)}`,
    { method: "DELETE", auth: departmentManager },
  );
  assert.equal(removed.response.status, 204, removed.text);
});

test("v0.71 Block 5: Personalakte ohne Standort bleibt für Leitungen auf allen Schreib- und Dokumentwegen gesperrt", async () => {
  const hr = session("103", "hr");
  const original = await saveProfile(TARGET_UNASSIGNED, hr, "UNASSIGNED");
  const document = await uploadDocument(TARGET_UNASSIGNED, hr, "Unassigned");
  assert.equal(document.response.status, 201, document.text);

  const rights = await rightsPayload(hr);
  const managerMatrix = completeMatrix(rights, "manager", {
    phone: "write",
    "identity.firstName": "write",
    "employment.notes": "write",
    documents: "write",
  });
  const saved = await saveMatrix(hr, "manager", managerMatrix);
  assert.equal(saved.response.status, 200, saved.text);

  const grantEmployeeWrite = db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'employees:write', '103')
  `);
  grantEmployeeWrite.run(MANAGER);
  grantEmployeeWrite.run(NO_SCOPE_MANAGER);
  const manager = session(MANAGER, "manager");
  db.prepare(`
    UPDATE employees SET home_location_id = NULL, preferred_department_id = NULL
    WHERE personnel_number = ?
  `).run(NO_SCOPE_MANAGER);
  const noScopeManager = session(NO_SCOPE_MANAGER, "manager");
  for (const auth of [manager, noScopeManager]) {
    const readDenied = await request(`/api/portal/v1/personnel-records/${TARGET_UNASSIGNED}`, { auth });
    assert.equal(readDenied.response.status, 403, readDenied.text);
    assert.equal(readDenied.payload.code, "PORTAL_SCOPE_DENIED");

    const writeDenied = await request(`/api/portal/v1/personnel-records/${TARGET_UNASSIGNED}`, {
      method: "PUT",
      auth,
      body: { phone: "+43 512 5559777", sensitive: { employment: { notes: "Scope-Bypass" } } },
    });
    assert.equal(writeDenied.response.status, 403, writeDenied.text);
    assert.equal(writeDenied.payload.code, "PORTAL_SCOPE_DENIED");

    const contentDenied = await fetch(
      `${baseUrl}/api/portal/v1/personnel-records/${TARGET_UNASSIGNED}/documents/${encodeURIComponent(document.payload.document.id)}/content`,
      { headers: { Cookie: auth.cookie, Accept: "application/json" } },
    );
    assert.equal(contentDenied.status, 403, await contentDenied.clone().text());

    const employeeBypass = await request(`/api/employees/${TARGET_UNASSIGNED}`, {
      method: "PUT",
      auth,
      body: {
        personnelNumber: TARGET_UNASSIGNED,
        fullName: `Testperson ${TARGET_UNASSIGNED}`,
        nickname: "ScopeBypassVerboten",
        contractedHours: 38.5,
        targetWorkdaysPerWeek: 5,
        positionId,
        homeLocationId: "91",
        preferredDepartmentId: departmentA,
        preferredDayOff: "",
        fixedWorkdays: [],
        color: "#2c7a68",
        active: true,
        personnelRecord: {
          phone: "+43 512 5559888",
          sensitive: { identity: { firstName: "Scope-Bypass verboten" } },
        },
      },
    });
    assert.equal(employeeBypass.response.status, 403, employeeBypass.text);
    assert.equal(employeeBypass.payload.code, "PORTAL_SCOPE_DENIED");
  }

  const employeeAfter = db.prepare(`
    SELECT nickname, home_location_id, preferred_department_id
    FROM employees WHERE personnel_number = ?
  `).get(TARGET_UNASSIGNED);
  assert.equal(employeeAfter.nickname, `T${TARGET_UNASSIGNED}`);
  assert.equal(employeeAfter.home_location_id, null);
  assert.equal(employeeAfter.preferred_department_id, null);
  const profileAfter = await request(`/api/portal/v1/personnel-records/${TARGET_UNASSIGNED}`, { auth: hr });
  assert.equal(profileAfter.response.status, 200, profileAfter.text);
  assert.equal(profileAfter.payload.profile.phone, original.phone);
  assert.equal(profileAfter.payload.profile.sensitive.identity.firstName, original.sensitive.identity.firstName);
  assert.equal(profileAfter.payload.profile.sensitive.employment.notes, original.sensitive.employment.notes);
});

test("v0.71 Block 5: Telefon-Schreibrecht wird ohne aktive eigene Vertrauensstufe A serverseitig zu Nur-lesen", async () => {
  const hr = session("103", "hr");
  await saveProfile(TARGET_A, hr, "PHONE-TRUST");
  const rights = await rightsPayload(hr);
  const phoneWrite = completeMatrix(rights, "manager", { phone: "write" });
  const saved = await saveMatrix(hr, "manager", phoneWrite);
  assert.equal(saved.response.status, 200, saved.text);

  const verifyReadOnly = async (label) => {
    const manager = session(MANAGER, "manager");
    const view = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: manager });
    assert.equal(view.response.status, 200, `${label}: ${view.text}`);
    assert.equal(view.payload.access.fieldAccess.phone, "read", label);
    const denied = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
      method: "PUT", auth: manager, body: { phone: "+43 512 5559666" },
    });
    assert.equal(denied.response.status, 403, `${label}: ${denied.text}`);
    assert.equal(denied.payload.code, "PERSONNEL_PHONE_WRITE_DENIED", label);
  };

  db.prepare("UPDATE employees SET time_confirmation_level = 'B' WHERE personnel_number = ?").run(MANAGER);
  await verifyReadOnly("Vertrauensstufe B");
  db.prepare("UPDATE employees SET time_confirmation_level = 'C' WHERE personnel_number = ?").run(MANAGER);
  await verifyReadOnly("Vertrauensstufe C");
  db.prepare("UPDATE employees SET time_confirmation_level = 'A' WHERE personnel_number = ?").run(MANAGER);
  db.prepare("UPDATE portal_settings SET value = '0', updated_at = CURRENT_TIMESTAMP WHERE key = 'trust_levels_enabled'").run();
  await verifyReadOnly("deaktivierte Vertrauensstufen");

  db.prepare("UPDATE portal_settings SET value = '1', updated_at = CURRENT_TIMESTAMP WHERE key = 'trust_levels_enabled'").run();
  const managerA = session(MANAGER, "manager");
  const writable = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: managerA });
  assert.equal(writable.response.status, 200, writable.text);
  assert.equal(writable.payload.access.fieldAccess.phone, "write");
});

test("v0.71 Block 5: Legacy-Telefonrecht gilt nur bis eine ausdrückliche Rollenmatrix gespeichert wird", async () => {
  const hr = session("103", "hr");
  await saveProfile(TARGET_A, hr, "LEGACY");
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'personnel:phone:write', '103')
  `).run(MANAGER);
  const manager = session(MANAGER, "manager");
  const legacy = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: manager });
  assert.equal(legacy.response.status, 200, legacy.text);
  assert.equal(legacy.payload.access.fieldAccess.phone, "write");
  const legacyWrite = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT", auth: manager, body: { phone: "+43 512 5559222" },
  });
  assert.equal(legacyWrite.response.status, 200, legacyWrite.text);

  const rights = await rightsPayload(hr);
  const explicitRead = completeMatrix(rights, "manager", { phone: "read" });
  const saved = await saveMatrix(hr, "manager", explicitRead);
  assert.equal(saved.response.status, 200, saved.text);
  const explicit = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: manager });
  assert.equal(explicit.response.status, 200, explicit.text);
  assert.equal(explicit.payload.access.fieldAccess.phone, "read");
  const denied = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT", auth: manager, body: { phone: "+43 512 5559333" },
  });
  assert.equal(denied.response.status, 403, denied.text);
  assert.equal(denied.payload.code, "PERSONNEL_PHONE_WRITE_DENIED");
  const final = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: hr });
  assert.equal(final.payload.profile.phone, "+43 512 5559222");
});

test("v0.71 Block 5: Abhängige Beschäftigungsdaten verhindern Validierungsorakel und zeigen das effektive Recht", async () => {
  const hr = session("103", "hr");
  await saveProfile(TARGET_A, hr, "DATE-DEPENDENCY");
  const rights = await rightsPayload(hr);
  const incompleteDateAccess = completeMatrix(rights, "manager", {
    "employment.startDate": "write",
    "employment.endDate": "hidden",
    "employment.fixedTermEnd": "hidden",
    "employment.probationEnd": "hidden",
  });
  const saved = await saveMatrix(hr, "manager", incompleteDateAccess);
  assert.equal(saved.response.status, 200, saved.text);

  const manager = session(MANAGER, "manager");
  const view = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: manager });
  assert.equal(view.response.status, 200, view.text);
  assert.equal(view.payload.access.fieldAccess["employment.startDate"], "read");
  assert.equal(view.payload.profile.sensitive.employment.startDate, "2024-02-01");
  assert.equal(Object.hasOwn(view.payload.profile.sensitive.employment, "fixedTermEnd"), false);

  const probedValue = "2023-01-17";
  const denied = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT",
    auth: manager,
    body: { sensitive: { employment: { startDate: probedValue } } },
  });
  assert.equal(denied.response.status, 403, denied.text);
  assert.equal(denied.payload.code, "PERSONNEL_FIELD_WRITE_DENIED");
  const deniedAudit = latestDeniedAudit(MANAGER, TARGET_A);
  assert.equal(deniedAudit.detail.reason, "PERSONNEL_FIELD_WRITE_DENIED");
  assert.equal(deniedAudit.detail.route, "PUT /api/portal/v1/personnel-records/:employeeNumber");
  assert.deepEqual(deniedAudit.detail.fieldKeys, ["employment.startDate"]);
  assert.equal(deniedAudit.raw.includes(probedValue), false);

  const completeDateAccess = {
    ...incompleteDateAccess,
    "employment.endDate": "read",
    "employment.fixedTermEnd": "read",
    "employment.probationEnd": "read",
  };
  const completed = await saveMatrix(hr, "manager", completeDateAccess);
  assert.equal(completed.response.status, 200, completed.text);
  const writableView = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: manager });
  assert.equal(writableView.response.status, 200, writableView.text);
  assert.equal(writableView.payload.access.fieldAccess["employment.startDate"], "write");
  const allowed = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT",
    auth: manager,
    body: { sensitive: { employment: { startDate: "2024-01-15" } } },
  });
  assert.equal(allowed.response.status, 200, allowed.text);
  assert.deepEqual(allowed.payload.changedFields, ["employment.startDate"]);

  const address = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
    method: "PUT",
    auth: hr,
    body: { sensitive: { address: { street: "Prüfweg 71" } } },
  });
  assert.equal(address.response.status, 200, address.text);
  assert.deepEqual(address.payload.changedFields, ["address.street"]);
});

test("v0.71 Block 5: Bereichs- und Dokument-IDOR-Ablehnungen werden wertfrei und dauerhaft protokolliert", async () => {
  const hr = session("103", "hr");
  await saveProfile(TARGET_B, hr, "AUDIT-REMOTE");
  const document = await uploadDocument(TARGET_B, hr, "AuditRemoteSecret");
  assert.equal(document.response.status, 201, document.text);
  const rights = await rightsPayload(hr);
  const documentsOnly = completeMatrix(rights, "department_manager", { documents: "read" });
  const saved = await saveMatrix(hr, "department_manager", documentsOnly);
  assert.equal(saved.response.status, 200, saved.text);

  const departmentManager = session(DEPARTMENT_MANAGER, "department_manager");
  const crossScope = await request(`/api/portal/v1/personnel-records/${TARGET_B}`, { auth: departmentManager });
  assert.equal(crossScope.response.status, 403, crossScope.text);
  const scopeAudit = latestDeniedAudit(DEPARTMENT_MANAGER, TARGET_B);
  assert.equal(scopeAudit.detail.reason, "PORTAL_SCOPE_DENIED");
  assert.equal(scopeAudit.detail.route, "GET /api/portal/v1/personnel-records/:employeeNumber");
  assert.deepEqual(scopeAudit.detail.fieldKeys, []);

  const crossDocument = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/${TARGET_B}/documents/${encodeURIComponent(document.payload.document.id)}/content`,
    { headers: { Cookie: departmentManager.cookie, Accept: "application/json" } },
  );
  assert.equal(crossDocument.status, 403, await crossDocument.clone().text());
  const documentAudit = latestDeniedAudit(DEPARTMENT_MANAGER, TARGET_B);
  assert.equal(documentAudit.detail.reason, "PORTAL_SCOPE_DENIED");
  assert.equal(documentAudit.detail.route,
    "GET /api/portal/v1/personnel-records/:employeeNumber/documents/:documentId/content");
  assert.deepEqual(documentAudit.detail.fieldKeys, ["documents"]);
  assert.equal(documentAudit.raw.includes(document.payload.document.id), false);
  assert.equal(documentAudit.raw.includes("AuditRemoteSecret"), false);
  assert.equal(documentAudit.raw.includes("AUDIT-REMOTE"), false);
});

test("v0.71 Block 5: Fremde Abteilungen bleiben auch für Profil-PUT sowie Dokument-POST und -DELETE gesperrt", async () => {
  const hr = session("103", "hr");
  const remoteProfile = await saveProfile(TARGET_B, hr, "CROSS-MUTATION");
  const remoteDocument = await uploadDocument(TARGET_B, hr, "CrossDeleteSecret");
  assert.equal(remoteDocument.response.status, 201, remoteDocument.text);

  const rights = await rightsPayload(hr);
  const writeMatrix = completeMatrix(rights, "department_manager", {
    "employment.notes": "write",
    documents: "write",
  });
  const saved = await saveMatrix(hr, "department_manager", writeMatrix);
  assert.equal(saved.response.status, 200, saved.text);
  const departmentManager = session(DEPARTMENT_MANAGER, "department_manager");

  const profileMarker = "CrossScopeProfileWrite-771";
  const profileDenied = await request(`/api/portal/v1/personnel-records/${TARGET_B}`, {
    method: "PUT",
    auth: departmentManager,
    body: { sensitive: { employment: { notes: profileMarker } } },
  });
  assert.equal(profileDenied.response.status, 403, profileDenied.text);
  assert.equal(profileDenied.payload.code, "PORTAL_SCOPE_DENIED");

  const uploadMarker = "CrossScopeUpload-772";
  const uploadDenied = await uploadDocument(TARGET_B, departmentManager, uploadMarker);
  assert.equal(uploadDenied.response.status, 403, uploadDenied.text);
  assert.equal(uploadDenied.payload.code, "PORTAL_SCOPE_DENIED");

  const deleteDenied = await request(
    `/api/portal/v1/personnel-records/${TARGET_B}/documents/${encodeURIComponent(remoteDocument.payload.document.id)}`,
    { method: "DELETE", auth: departmentManager },
  );
  assert.equal(deleteDenied.response.status, 403, deleteDenied.text);
  assert.equal(deleteDenied.payload.code, "PORTAL_SCOPE_DENIED");

  const unchanged = await request(`/api/portal/v1/personnel-records/${TARGET_B}`, { auth: hr });
  assert.equal(unchanged.response.status, 200, unchanged.text);
  assert.equal(unchanged.payload.profile.sensitive.employment.notes, remoteProfile.sensitive.employment.notes);
  assert.deepEqual(unchanged.payload.documents.map((entry) => entry.id), [remoteDocument.payload.document.id]);
  assert.equal(db.prepare("SELECT status FROM personnel_record_documents WHERE id = ?")
    .get(remoteDocument.payload.document.id).status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM personnel_record_documents WHERE employee_number = ?")
    .get(TARGET_B).count, 1);
});

test("v0.71 Block 5: Alter Mitarbeiter-POST respektiert Feldrechte und Scope mit vollständigem Rollback", async () => {
  const hr = session("103", "hr");
  const rights = await rightsPayload(hr);
  const managerMatrix = completeMatrix(rights, "manager", { "employment.notes": "write" });
  const saved = await saveMatrix(hr, "manager", managerMatrix);
  assert.equal(saved.response.status, 200, saved.text);
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'employees:write', '103')
  `).run(MANAGER);
  const manager = session(MANAGER, "manager");

  const forbiddenNumber = "9530";
  const forbiddenMarker = "AltPostForbiddenField-781";
  const allowedMarker = "AltPostAllowedField-782";
  const fieldDenied = await request("/api/employees", {
    method: "POST",
    auth: manager,
    body: employeeMutationBody(forbiddenNumber, {
      personnelRecord: {
        sensitive: {
          identity: { firstName: forbiddenMarker },
          employment: { notes: allowedMarker },
        },
      },
    }),
  });
  assert.equal(fieldDenied.response.status, 403, fieldDenied.text);
  assert.equal(fieldDenied.payload.code, "PERSONNEL_FIELD_WRITE_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(forbiddenNumber), undefined);
  assert.equal(db.prepare("SELECT 1 FROM personnel_sensitive_records WHERE employee_number = ?").get(forbiddenNumber), undefined);
  assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = ?").get(forbiddenNumber), undefined);
  const fieldAudit = latestDeniedAudit(MANAGER, forbiddenNumber);
  assert.equal(fieldAudit.detail.reason, "PERSONNEL_FIELD_WRITE_DENIED");
  assert.equal(fieldAudit.detail.route, "POST /api/employees");
  assert.deepEqual(fieldAudit.detail.fieldKeys, ["identity.firstName"]);
  assert.equal(fieldAudit.raw.includes(forbiddenMarker), false);
  assert.equal(fieldAudit.raw.includes(allowedMarker), false);

  const remoteNumber = "9531";
  const remoteMarker = "AltPostCrossScope-783";
  const scopeDenied = await request("/api/employees", {
    method: "POST",
    auth: manager,
    body: employeeMutationBody(remoteNumber, {
      locationId: "92",
      departmentId: departmentRemote,
      personnelRecord: { sensitive: { employment: { notes: remoteMarker } } },
    }),
  });
  assert.equal(scopeDenied.response.status, 403, scopeDenied.text);
  assert.equal(scopeDenied.payload.code, "PORTAL_SCOPE_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(remoteNumber), undefined);
  assert.equal(db.prepare("SELECT 1 FROM personnel_sensitive_records WHERE employee_number = ?").get(remoteNumber), undefined);
  assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = ?").get(remoteNumber), undefined);
  assert.equal(db.prepare("SELECT 1 FROM portal_access_scopes WHERE employee_number = ?").get(remoteNumber), undefined);
  const scopeAudit = latestDeniedAudit(MANAGER, remoteNumber);
  assert.equal(scopeAudit.detail.reason, "PORTAL_SCOPE_DENIED");
  assert.equal(scopeAudit.detail.route, "POST /api/employees");
  assert.deepEqual(scopeAudit.detail.fieldKeys, ["employment.notes"]);
  assert.equal(scopeAudit.raw.includes(remoteMarker), false);
});

test("v0.71 Block 5: Alle vier Beschäftigungsdaten sind symmetrisch gekoppelt, auch über den Altpfad", async () => {
  const hr = session("103", "hr");
  const original = await saveProfile(TARGET_A, hr, "DATE-SYMMETRY");
  const rights = await rightsPayload(hr);
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'employees:write', '103')
  `).run(MANAGER);
  const manager = session(MANAGER, "manager");
  const dateFields = [
    ["employment.startDate", "startDate", "2031-01-17"],
    ["employment.endDate", "endDate", "2023-01-17"],
    ["employment.fixedTermEnd", "fixedTermEnd", "2023-01-17"],
    ["employment.probationEnd", "probationEnd", "2023-01-17"],
  ];

  for (const [fieldKey, property, probe] of dateFields) {
    const incomplete = completeMatrix(rights, "manager", { [fieldKey]: "write" });
    const matrixSaved = await saveMatrix(hr, "manager", incomplete);
    assert.equal(matrixSaved.response.status, 200, `${fieldKey}: ${matrixSaved.text}`);
    const view = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: manager });
    assert.equal(view.response.status, 200, `${fieldKey}: ${view.text}`);
    assert.equal(view.payload.access.fieldAccess[fieldKey], "read", fieldKey);

    const personnelRecord = { sensitive: { employment: { [property]: probe } } };
    const directDenied = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, {
      method: "PUT", auth: manager, body: personnelRecord,
    });
    assert.equal(directDenied.response.status, 403, `${fieldKey}: ${directDenied.text}`);
    assert.equal(directDenied.payload.code, "PERSONNEL_FIELD_WRITE_DENIED", fieldKey);

    const altDenied = await request(`/api/employees/${TARGET_A}`, {
      method: "PUT",
      auth: manager,
      body: employeeMutationBody(TARGET_A, {
        nickname: `AltDate-${property}-verboten`,
        personnelRecord,
      }),
    });
    assert.equal(altDenied.response.status, 403, `${fieldKey}: ${altDenied.text}`);
    assert.equal(altDenied.payload.code, "PERSONNEL_FIELD_WRITE_DENIED", fieldKey);
    const audit = latestDeniedAudit(MANAGER, TARGET_A);
    assert.equal(audit.detail.route, "PUT /api/employees/:personnelNumber", fieldKey);
    assert.deepEqual(audit.detail.fieldKeys, [fieldKey]);
    assert.equal(audit.raw.includes(probe), false, fieldKey);
  }

  assert.equal(db.prepare("SELECT nickname FROM employees WHERE personnel_number = ?").get(TARGET_A).nickname, `T${TARGET_A}`);
  const unchanged = await request(`/api/portal/v1/personnel-records/${TARGET_A}`, { auth: hr });
  assert.deepEqual(unchanged.payload.profile.sensitive.employment, original.sensitive.employment);
});

test("v0.71 Block 5: Alt-PUT sowie Multipart- und Lösch-Ablehnungen protokollieren keine Nutzwerte", async () => {
  const hr = session("103", "hr");
  await saveProfile(TARGET_A, hr, "AUDIT-MUTATION");
  const document = await uploadDocument(TARGET_A, hr, "AuditDeleteSecret");
  assert.equal(document.response.status, 201, document.text);
  const rights = await rightsPayload(hr);
  const readOnly = completeMatrix(rights, "manager", { documents: "read" });
  const saved = await saveMatrix(hr, "manager", readOnly);
  assert.equal(saved.response.status, 200, saved.text);
  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES (?, 'employees:write', '103')
  `).run(MANAGER);
  const manager = session(MANAGER, "manager");

  const altMarker = "AltPutAuditSecret-791";
  const nicknameMarker = "AltPutNicknameSecret-792";
  const altDenied = await request(`/api/employees/${TARGET_A}`, {
    method: "PUT",
    auth: manager,
    body: employeeMutationBody(TARGET_A, {
      nickname: nicknameMarker,
      personnelRecord: { sensitive: { employment: { notes: altMarker } } },
    }),
  });
  assert.equal(altDenied.response.status, 403, altDenied.text);
  assert.equal(altDenied.payload.code, "PERSONNEL_FIELD_WRITE_DENIED");
  const altAudit = latestDeniedAudit(MANAGER, TARGET_A);
  assert.equal(altAudit.detail.reason, "PERSONNEL_FIELD_WRITE_DENIED");
  assert.equal(altAudit.detail.route, "PUT /api/employees/:personnelNumber");
  assert.deepEqual(altAudit.detail.fieldKeys, ["employment.notes"]);
  assert.equal(altAudit.raw.includes(altMarker), false);
  assert.equal(altAudit.raw.includes(nicknameMarker), false);
  assert.equal(db.prepare("SELECT nickname FROM employees WHERE personnel_number = ?").get(TARGET_A).nickname, `T${TARGET_A}`);

  const uploadMarker = "MultipartAuditSecret-793";
  const uploadDenied = await uploadDocument(TARGET_A, manager, uploadMarker);
  assert.equal(uploadDenied.response.status, 403, uploadDenied.text);
  assert.equal(uploadDenied.payload.code, "PERSONNEL_DOCUMENT_WRITE_DENIED");
  const uploadAudit = latestDeniedAudit(MANAGER, TARGET_A);
  assert.equal(uploadAudit.detail.reason, "PERSONNEL_DOCUMENT_WRITE_DENIED");
  assert.equal(uploadAudit.detail.route, "POST /api/portal/v1/personnel-records/:employeeNumber/documents");
  assert.deepEqual(uploadAudit.detail.fieldKeys, ["documents"]);
  assert.equal(uploadAudit.raw.includes(uploadMarker), false);

  const deleteDenied = await request(
    `/api/portal/v1/personnel-records/${TARGET_A}/documents/${encodeURIComponent(document.payload.document.id)}`,
    { method: "DELETE", auth: manager },
  );
  assert.equal(deleteDenied.response.status, 403, deleteDenied.text);
  assert.equal(deleteDenied.payload.code, "PERSONNEL_DOCUMENT_WRITE_DENIED");
  const deleteAudit = latestDeniedAudit(MANAGER, TARGET_A);
  assert.equal(deleteAudit.detail.reason, "PERSONNEL_DOCUMENT_WRITE_DENIED");
  assert.equal(deleteAudit.detail.route,
    "DELETE /api/portal/v1/personnel-records/:employeeNumber/documents/:documentId");
  assert.deepEqual(deleteAudit.detail.fieldKeys, ["documents"]);
  assert.equal(deleteAudit.raw.includes(document.payload.document.id), false);
  assert.equal(deleteAudit.raw.includes("AuditDeleteSecret"), false);
  assert.equal(db.prepare("SELECT status FROM personnel_record_documents WHERE id = ?")
    .get(document.payload.document.id).status, "active");
});

test("v0.71 Block 5: UI nutzt Feldrechte, Capability und ausschließlich dirty Schreibfelder", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(source, /api\("\/api\/portal\/v1\/personnel-field-rights"\)/);
  assert.match(source, /api\(`\/api\/portal\/v1\/personnel-field-rights\/\$\{encodeURIComponent\(role\)\}`/);
  assert.match(source, /\{ id: "hidden", label: "Verborgen" \}.*\{ id: "read", label: "Nur lesen" \}.*\{ id: "write", label: "Bearbeiten" \}/s);
  assert.match(source, /state\.portalSession\?\.user\?\.personnelRecordAccess\?\.available/);
  assert.match(source, /personnelRecordDirtyFields:\s*new Set\(\)/);
  assert.match(source, /function escapeHtmlAttribute\(value\)/);
  assert.ok(source.includes('"&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;"'), "Attribut-Escaping muss beide Anführungszeichen kodieren");
  assert.match(source, /data-personnel-field-key="\$\{escapeHtmlAttribute\(fieldKey\)\}"/);
  assert.match(source, /value="\$\{escapeHtmlAttribute\(value \|\| ""\)\}"/);
  assert.match(source, /data-personnel-field-right="\$\{escapeHtmlAttribute\(field\.key\)\}"/);
  assert.match(source, /aria-label="\$\{escapeHtmlAttribute\(`/);
  assert.match(source, /state\.personnelRecordDirtyFields\.has\("phone"\)\s*&&\s*mode\("phone"\)\s*===\s*"write"\s*&&\s*fields\.namedItem\("personnelPhone"\)/);
  assert.match(source, /state\.personnelRecordDirtyFields\.has\(fieldKey\)\s*&&\s*mode\(fieldKey\)\s*===\s*"write"\s*&&\s*fields\.namedItem\(inputName\)/);
  assert.match(source, /personnelRecordContent\?\.addEventListener\("input"[\s\S]*!event\.target\.disabled[\s\S]*personnelRecordDirtyFields\.add\(field\.dataset\.personnelFieldKey\)/);
  assert.match(source, /function rightsDashboardVisiblePersonnelFields\(user\)/);
  assert.match(source, /if \(origin === "delegated"\) return \[\]/);
  assert.match(source, /const visiblePersonnelFields = rightsDashboardVisiblePersonnelFields\(user\)/);
  assert.match(source, /const fields = rightsDashboardVisiblePersonnelFields\(user\)/);
  assert.match(source, /const personnelFieldMatrix = renderPersonnelFieldRightsDashboard\(user\)/);
  assert.match(source, /: personnelFieldMatrix \? "" : "<p class=/);
  assert.match(source, /const matrix = user\.personnelFieldAccess[\s\S]*return matrix \? \{ payload: state\.personnelFieldRights, matrix \} : null/);
  assert.match(styles, /\.personnel-field-right-name small \{[^}]*font-size:8px;[^}]*line-height:1\.35;/);
  assert.match(styles, /data-active-page-theme="dark"[^\n]*\.personnel-field-right-name small \{ color:#f0d582; \}/);
});
