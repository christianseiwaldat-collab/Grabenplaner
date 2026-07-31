"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createAmuStorage } = require("../lib/amu-storage");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v071-personnel-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const {
  app,
  db,
  createDatabaseBackupToDirectory,
  finalizeDeletedPersonnelRecordDocuments,
  latestDatabaseBackup,
  pruneDatabaseBackups,
  releaseInstanceLockForTests,
} = require("../server");

let httpServer;
let baseUrl;
let locationId;
let positionId;

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users
      (employee_number, password_hash, role, role_locked, active, must_change_password,
       password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET
      role = excluded.role,
      role_locked = excluded.role_locked,
      active = 1,
      must_change_password = 0,
      updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role, role === "developer" ? 1 : 0);
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

async function uploadDocument(employeeNumber, auth, {
  filename = "Dienstvertrag.pdf",
  content = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n% vertraulicher Personalakt\n%%EOF", "utf8"),
  category = "contract",
  title = "Dienstvertrag",
  documentDate = "2026-02-01",
  description = "Unterzeichnete Vertragsfassung",
} = {}) {
  const form = new FormData();
  form.append("category", category);
  form.append("title", title);
  form.append("documentDate", documentDate);
  form.append("description", description);
  form.append("document", new Blob([content], { type: "application/pdf" }), filename);
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

function employeePayload(personnelNumber, extras = {}) {
  return {
    personnelNumber,
    fullName: `Testperson ${personnelNumber}`,
    nickname: `T${personnelNumber}`,
    contractedHours: 38.5,
    targetWorkdaysPerWeek: 5,
    positionId,
    homeLocationId: locationId,
    preferredDepartmentId: "",
    preferredDayOff: "",
    fixedWorkdays: [],
    color: "#2c7a68",
    active: true,
    ...extras,
  };
}

function insertEmployee(personnelNumber, homeLocationId = locationId) {
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, target_workdays_per_week,
       position_id, home_location_id, active)
    VALUES (?, ?, ?, '#2c7a68', 38.5, 5, ?, ?, 1)
  `).run(personnelNumber, `Testperson ${personnelNumber}`, `T${personnelNumber}`, positionId, homeLocationId);
}

function fullPersonnelRecord(marker) {
  return {
    phone: "+43 512 5557711",
    sensitive: {
      identity: {
        firstName: `Elena-${marker}`,
        lastName: `Muster-${marker}`,
        previousName: `Altname-${marker}`,
        salutation: "Frau",
        title: "Mag.",
        birthDate: "1991-04-18",
        birthPlace: `Hall-${marker}`,
        nationality: "Österreich",
      },
      socialSecurityNumber: "1238010190",
      iban: "AT611904300234573201",
      bic: "BKAUATWW",
      accountHolder: `Elena Muster ${marker}`,
      alternatePhone: "+43 664 5557722",
      privateEmail: `elena.${marker.toLowerCase()}@example.test`,
      emergencyContact: {
        name: `Notfall ${marker}`,
        relationship: "Schwester",
        phone: "+43 650 5557733",
      },
      address: {
        street: `Geheimweg ${marker} 17`,
        supplement: `Stiege ${marker}`,
        postalCode: "6020",
        city: `Innsbruck-${marker}`,
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
        payrollGroup: `Lohn-${marker}`,
        notes: `Vertraulicher Hinweis ${marker}`,
      },
    },
  };
}

function protectedRecordStorage() {
  const keyPath = path.join(testRoot, "app-data", "private", "amu-local.key");
  return createAmuStorage({
    rootDirectory: path.join(testRoot, "legacy-personnel-protector"),
    encryptionKeys: { "local-v1": fs.readFileSync(keyPath, "utf8").trim() },
    activeKeyId: "local-v1",
    scanner: async () => true,
  });
}

function assertSecretsAbsent(value, secrets, label) {
  const serialized = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  for (const secret of secrets) {
    assert.equal(serialized.includes(Buffer.from(secret, "utf8")), false, `${label}: Klartext ${secret}`);
    assert.equal(serialized.includes(Buffer.from(secret, "utf16le")), false, `${label}: UTF-16-Klartext ${secret}`);
  }
}

test.before(async () => {
  const locations = db.prepare("SELECT id FROM locations ORDER BY id").all();
  locationId = locations[0].id;
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
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

test("v0.71 Block 4: Schema, Migration und alte verschlüsselte Personalakte bleiben kompatibel", async () => {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'personnel_record_documents'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.71-extended-personnel-records'").get());
  const columns = new Set(db.prepare("PRAGMA table_info(personnel_record_documents)").all().map((column) => column.name));
  for (const column of ["id", "employee_number", "storage_key", "status", "protected_payload", "created_at", "deleted_by", "deleted_at"]) {
    assert.ok(columns.has(column), `Spalte ${column} fehlt`);
  }

  insertEmployee("8710");
  const legacy = {
    socialSecurityNumber: "",
    iban: "",
    bic: "",
    accountHolder: "",
    address: { street: "Altweg 7", postalCode: "6020", city: "Innsbruck", country: "Österreich" },
    phone: "+43 512 5557000",
  };
  const context = {
    namespace: "personnel-sensitive-record",
    recordId: "8710",
    field: "payload",
    employeeNumber: "8710",
  };
  const protectedPayload = protectedRecordStorage().protectRecord(JSON.stringify(legacy), context);
  db.prepare(`
    INSERT INTO personnel_sensitive_records (employee_number, protected_payload, updated_by)
    VALUES ('8710', ?, 'test')
  `).run(protectedPayload);

  const hr = session("103", "hr");
  const loaded = await request("/api/portal/v1/personnel-records/8710", { auth: hr });
  assert.equal(loaded.response.status, 200, loaded.text);
  const sensitive = loaded.payload.profile.sensitive;
  assert.equal(loaded.payload.profile.phone, legacy.phone);
  assert.equal(sensitive.address.street, "Altweg 7");
  assert.deepEqual(sensitive.identity, {
    firstName: "", lastName: "", previousName: "", salutation: "", title: "",
    birthDate: "", birthPlace: "", nationality: "",
  });
  assert.equal(sensitive.privateEmail, "");
  assert.deepEqual(sensitive.emergencyContact, { name: "", relationship: "", phone: "" });
  assert.equal(sensitive.employment.startDate, "");
  assert.deepEqual(loaded.payload.documents, []);
});

test("v0.71 Block 4: Personalakt wird vollständig, partiell und ohne Klartext-Leck verarbeitet", async () => {
  const hr = session("103", "hr");
  const marker = `V071${crypto.randomBytes(5).toString("hex")}`;
  const personnelRecord = fullPersonnelRecord(marker);
  const created = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload("8711", { personnelRecord }),
  });
  assert.equal(created.response.status, 201, created.text);
  assert.equal(Object.hasOwn(created.payload, "personnelRecord"), false);
  assert.doesNotMatch(JSON.stringify(created.payload), new RegExp(marker, "i"));

  const loaded = await request("/api/portal/v1/personnel-records/8711", { auth: hr });
  assert.equal(loaded.response.status, 200, loaded.text);
  assert.equal(loaded.payload.profile.phone, personnelRecord.phone);
  assert.deepEqual(loaded.payload.profile.sensitive, personnelRecord.sensitive);
  assert.deepEqual(loaded.payload.documents, []);

  const partial = await request("/api/portal/v1/personnel-records/8711", {
    method: "PUT",
    auth: hr,
    body: { sensitive: { identity: { title: "Dr." }, employment: { notes: `Neu-${marker}` } } },
  });
  assert.equal(partial.response.status, 200, partial.text);
  assert.deepEqual(partial.payload.changedFields.sort(), ["employment.notes", "identity.title"]);
  const afterPartial = await request("/api/portal/v1/personnel-records/8711", { auth: hr });
  assert.equal(afterPartial.payload.profile.sensitive.identity.title, "Dr.");
  assert.equal(afterPartial.payload.profile.sensitive.identity.firstName, personnelRecord.sensitive.identity.firstName);
  assert.equal(afterPartial.payload.profile.sensitive.privateEmail, personnelRecord.sensitive.privateEmail);
  assert.equal(afterPartial.payload.profile.sensitive.employment.notes, `Neu-${marker}`);

  const employeeList = await request("/api/employees", { auth: hr });
  assert.equal(employeeList.response.status, 200, employeeList.text);
  const listedEmployee = employeeList.payload.find((employee) => employee.personnel_number === "8711");
  assert.equal(listedEmployee.personnel_display.privateEmail, personnelRecord.sensitive.privateEmail);
  assert.equal(Object.hasOwn(listedEmployee.personnel_display, "socialSecurityNumber"), false);
  assert.equal(Object.hasOwn(listedEmployee.personnel_display, "iban"), false);
  assert.equal(Object.hasOwn(listedEmployee.personnel_display, "address"), false);
  assert.equal(Object.hasOwn(listedEmployee.personnel_display, "emergencyContact"), false);
  assertSecretsAbsent(JSON.stringify(employeeList.payload), [
    personnelRecord.sensitive.socialSecurityNumber,
    personnelRecord.sensitive.iban,
    personnelRecord.sensitive.address.street,
    `Neu-${marker}`,
  ], "Mitarbeiterliste");

  const stored = db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number = '8711'").get();
  assert.match(stored.protected_payload, /^enc:v2:/);
  assert.match(stored.social_security_lookup, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.social_security_lookup, personnelRecord.sensitive.socialSecurityNumber);
  const audit = db.prepare("SELECT detail FROM audit_log WHERE entity_id = '8711' ORDER BY id").all().map((row) => row.detail).join("\n");
  const secrets = [
    personnelRecord.sensitive.socialSecurityNumber,
    personnelRecord.sensitive.iban,
    personnelRecord.sensitive.privateEmail,
    personnelRecord.sensitive.address.street,
    personnelRecord.sensitive.emergencyContact.name,
    `Neu-${marker}`,
  ];
  assertSecretsAbsent(stored.protected_payload, secrets, "geschützter Datensatz");
  assertSecretsAbsent(audit, secrets, "Audit-Protokoll");

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  for (const suffix of ["", "-wal"]) {
    const file = `${process.env.DB_PATH}${suffix}`;
    if (fs.existsSync(file)) assertSecretsAbsent(fs.readFileSync(file), secrets, path.basename(file));
  }
});

test("v0.71 Block 4: Mitarbeiteranlage und -änderung rollen ungültige Personalaktdaten atomar zurück", async () => {
  const hr = session("103", "hr");
  const invalid = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload("8712", { personnelRecord: { sensitive: { iban: "AT00NICHTGUELTIG" } } }),
  });
  assert.equal(invalid.response.status, 400, invalid.text);
  assert.equal(invalid.payload.code, "PERSONNEL_IBAN_INVALID");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '8712'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM personnel_sensitive_records WHERE employee_number = '8712'").get(), undefined);

  const source = fullPersonnelRecord("DUPLIKAT");
  source.sensitive.socialSecurityNumber = "1000010190";
  const first = await request("/api/employees", {
    method: "POST", auth: hr, body: employeePayload("8713", { personnelRecord: source }),
  });
  assert.equal(first.response.status, 201, first.text);
  const duplicate = await request("/api/employees", {
    method: "POST", auth: hr, body: employeePayload("8714", { personnelRecord: source }),
  });
  assert.equal(duplicate.response.status, 409, duplicate.text);
  assert.equal(duplicate.payload.code, "PERSONNEL_SOCIAL_SECURITY_DUPLICATE");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '8714'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = '8714'").get(), undefined);

  const before = db.prepare("SELECT nickname FROM employees WHERE personnel_number = '8713'").get().nickname;
  const update = await request("/api/employees/8713", {
    method: "PUT",
    auth: hr,
    body: employeePayload("8713", {
      nickname: "DarfNichtBleiben",
      personnelRecord: { sensitive: { iban: "AT00AUCHNICHT" } },
    }),
  });
  assert.equal(update.response.status, 400, update.text);
  assert.equal(db.prepare("SELECT nickname FROM employees WHERE personnel_number = '8713'").get().nickname, before);
});

test("v0.71 Block 4: nur freigegebene Personalaktfelder erreichen FL, Dokumente bleiben auf PL+ begrenzt", async () => {
  insertEmployee("8715");
  const hr = session("103", "hr");
  const rightsRecord = fullPersonnelRecord("RECHTE");
  rightsRecord.sensitive.socialSecurityNumber = "";
  const saved = await request("/api/portal/v1/personnel-records/8715", {
    method: "PUT", auth: hr, body: rightsRecord,
  });
  assert.equal(saved.response.status, 200, saved.text);

  const itAdmin = session("106", "it_admin");
  const itDenied = await request("/api/portal/v1/personnel-records/8715", { auth: itAdmin });
  assert.equal(itDenied.response.status, 403, itDenied.text);

  const manager = session("104", "manager");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES ('104', ?, 0, 'test')
  `).run(locationId);
  const managerView = await request("/api/portal/v1/personnel-records/8715", { auth: manager });
  assert.equal(managerView.response.status, 200, managerView.text);
  assert.deepEqual(managerView.payload.profile.sensitive, {
    privateEmail: rightsRecord.sensitive.privateEmail,
  });
  assert.deepEqual(managerView.payload.documents, []);

  const hrDocument = await uploadDocument("8715", hr, { title: "Nur für die Personalleitung" });
  assert.equal(hrDocument.response.status, 201, hrDocument.text);
  const managerContent = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/8715/documents/${encodeURIComponent(hrDocument.payload.document.id)}/content`,
    { headers: { Cookie: manager.cookie, Accept: "application/json" } },
  );
  assert.equal(managerContent.status, 403, await managerContent.clone().text());

  const managerUpload = await uploadDocument("8715", manager);
  assert.equal(managerUpload.response.status, 403, managerUpload.text);
  const itUpload = await uploadDocument("8715", itAdmin);
  assert.equal(itUpload.response.status, 403, itUpload.text);
});

test("v0.71 Block 4: Personalakt-Dokumente sind verschlüsselt, revisionsfähig und manipulationssicher", async () => {
  insertEmployee("8717");
  insertEmployee("8718");
  const hr = session("103", "hr");
  const marker = `DOC-${crypto.randomBytes(8).toString("hex")}`;
  const source = Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nendobj\n% ${marker}\n%%EOF`, "utf8");
  const uploaded = await uploadDocument("8717", hr, {
    content: source,
    filename: `${marker}.pdf`,
    title: `Vertrag ${marker}`,
    description: `Nur Personalabteilung ${marker}`,
  });
  assert.equal(uploaded.response.status, 201, uploaded.text);
  const document = uploaded.payload.document;
  assert.ok(document.id);
  assert.equal(document.category, "contract");
  assert.equal(document.title, `Vertrag ${marker}`);
  assert.equal(document.documentDate, "2026-02-01");

  const stored = db.prepare("SELECT * FROM personnel_record_documents WHERE id = ?").get(document.id);
  assert.ok(stored);
  assert.match(stored.protected_payload, /^enc:v2:/);
  assertSecretsAbsent(stored.protected_payload, [marker, `${marker}.pdf`, `Vertrag ${marker}`], "Dokumentmetadaten");
  const blobPath = path.join(testRoot, "app-data", "private", "amu", "blobs", ...stored.storage_key.split("/"));
  assert.equal(fs.existsSync(blobPath), true);
  const encryptedBlob = fs.readFileSync(blobPath);
  assert.equal(encryptedBlob.subarray(0, 8).toString("ascii"), "GPAMU002");
  assert.equal(encryptedBlob.includes(source), false);
  assertSecretsAbsent(encryptedBlob, [marker], "Dokumentblob");

  const record = await request("/api/portal/v1/personnel-records/8717", { auth: hr });
  assert.equal(record.response.status, 200, record.text);
  assert.equal(record.payload.documents[0].id, document.id);
  const contentResponse = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/8717/documents/${encodeURIComponent(document.id)}/content`,
    { headers: { Cookie: hr.cookie } },
  );
  assert.equal(contentResponse.status, 200, await contentResponse.clone().text());
  assert.deepEqual(Buffer.from(await contentResponse.arrayBuffer()), source);
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_log
    WHERE actor = '103' AND action = 'personnel-record.document.download' AND entity_id = ?
  `).get(document.id));

  const crossPerson = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/8718/documents/${encodeURIComponent(document.id)}/content`,
    { headers: { Cookie: hr.cookie } },
  );
  assert.equal(crossPerson.status, 404, await crossPerson.clone().text());

  const second = await uploadDocument("8718", hr, { title: "Zweites Dokument" });
  assert.equal(second.response.status, 201, second.text);
  const secondStored = db.prepare("SELECT protected_payload FROM personnel_record_documents WHERE id = ?")
    .get(second.payload.document.id);
  db.prepare("UPDATE personnel_record_documents SET protected_payload = ? WHERE id = ?")
    .run(secondStored.protected_payload, document.id);
  const tampered = await fetch(
    `${baseUrl}/api/portal/v1/personnel-records/8717/documents/${encodeURIComponent(document.id)}/content`,
    { headers: { Cookie: hr.cookie, Accept: "application/json" } },
  );
  assert.equal(tampered.status, 503);
  await tampered.arrayBuffer();
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_log
    WHERE actor = '103' AND action = 'personnel-record.document.integrity-failed' AND entity_id = ?
  `).get(document.id));
  db.prepare("UPDATE personnel_record_documents SET protected_payload = ? WHERE id = ?")
    .run(stored.protected_payload, document.id);

  const removed = await request(
    `/api/portal/v1/personnel-records/8717/documents/${encodeURIComponent(document.id)}`,
    { method: "DELETE", auth: hr },
  );
  assert.equal(removed.response.status, 204, removed.text);
  assert.equal(fs.existsSync(blobPath), false);
  assert.equal(db.prepare("SELECT status FROM personnel_record_documents WHERE id = ?").get(document.id).status, "purged");
  assert.ok(db.prepare(`
    SELECT 1 FROM audit_log
    WHERE actor = '103' AND action = 'personnel-record.document.delete' AND entity_id = ?
  `).get(document.id));
});

test("v0.71 Block 4: unterbrochene Dokumentlöschungen werden sicher abgeschlossen", async () => {
  insertEmployee("8719");
  const hr = session("103", "hr");
  const uploaded = await uploadDocument("8719", hr, { title: "Löschwiederholung" });
  assert.equal(uploaded.response.status, 201, uploaded.text);
  const stored = db.prepare("SELECT * FROM personnel_record_documents WHERE id = ?").get(uploaded.payload.document.id);
  const blobPath = path.join(testRoot, "app-data", "private", "amu", "blobs", ...stored.storage_key.split("/"));
  assert.equal(fs.existsSync(blobPath), true);

  db.prepare("UPDATE personnel_record_documents SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(stored.id);
  const finalized = await finalizeDeletedPersonnelRecordDocuments();
  assert.equal(finalized.purged, 1);
  assert.equal(finalized.failed, 0);
  assert.equal(fs.existsSync(blobPath), false);
  const purged = db.prepare("SELECT status, protected_payload FROM personnel_record_documents WHERE id = ?").get(stored.id);
  assert.equal(purged.status, "purged");
  assert.match(purged.protected_payload, /^enc:v2:/);
  assertSecretsAbsent(purged.protected_payload, ["Löschwiederholung"], "bereinigte Dokumentmetadaten");

  const deletedEmployee = await request("/api/employees/8719", { method: "DELETE", auth: hr });
  assert.equal(deletedEmployee.response.status, 204, deletedEmployee.text);
});

test("v0.71 Block 4: Sicherungspunkte enthalten alle aktiven geschützten Dokumente", async () => {
  insertEmployee("8720");
  const hr = session("103", "hr");
  const uploaded = await uploadDocument("8720", hr, { title: "Backup-Dokument" });
  assert.equal(uploaded.response.status, 201, uploaded.text);
  const stored = db.prepare("SELECT * FROM personnel_record_documents WHERE id = ?").get(uploaded.payload.document.id);
  const blobPath = path.join(testRoot, "app-data", "private", "amu", "blobs", ...stored.storage_key.split("/"));

  const backupDirectory = path.join(testRoot, "verified-backup");
  const backup = createDatabaseBackupToDirectory(backupDirectory, "test", "test");
  assert.equal(backup.verified, true);
  assert.equal(backup.committed, true);
  assert.equal(fs.existsSync(backup.path), true);
  assert.equal(fs.existsSync(backup.marker), true);
  assert.equal(latestDatabaseBackup(backupDirectory).committed, true);
  const verifierPath = path.join(__dirname, "..", "server-tools", "linux", "lib", "verify-backup.js");
  const amuModulePath = path.join(__dirname, "..", "lib", "amu-storage.js");
  const malformedMarker = path.join(backupDirectory, "malformed-marker.json");
  const malformedPayload = JSON.parse(fs.readFileSync(backup.marker, "utf8"));
  malformedPayload.protectedDocuments.files = -1;
  fs.writeFileSync(malformedMarker, `${JSON.stringify(malformedPayload)}\n`);
  const malformedVerification = spawnSync(process.execPath, [
    verifierPath,
    backup.path,
    path.join(backupDirectory, `${path.basename(backup.path, ".db")}.amu`),
    amuModulePath,
    malformedMarker,
  ], { encoding: "utf8" });
  assert.notEqual(malformedVerification.status, 0);
  fs.writeFileSync(malformedMarker, `${JSON.stringify(malformedPayload)}${" ".repeat(65 * 1024)}`);
  const oversizedVerification = spawnSync(process.execPath, [
    verifierPath,
    backup.path,
    path.join(backupDirectory, `${path.basename(backup.path, ".db")}.amu`),
    amuModulePath,
    malformedMarker,
  ], { encoding: "utf8" });
  assert.notEqual(oversizedVerification.status, 0);
  fs.rmSync(malformedMarker, { force: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(
    backupDirectory,
    `${path.basename(backup.path, ".db")}.amu`,
    "manifest.json",
  ), "utf8"));
  assert.ok(manifest.files.some((entry) => entry.storageKey === stored.storage_key));

  const invalidNew = createDatabaseBackupToDirectory(backupDirectory, "test-invalid-new", "test");
  fs.appendFileSync(invalidNew.path, "tampered");
  const pruneResult = spawnSync(process.execPath, [
    path.join(__dirname, "..", "server-tools", "linux", "lib", "prune-backups.js"),
    backupDirectory,
    "1",
    verifierPath,
    amuModulePath,
  ], { encoding: "utf8" });
  assert.equal(pruneResult.status, 0, pruneResult.stderr);
  assert.equal(JSON.parse(pruneResult.stdout).valid, 1);
  assert.equal(fs.existsSync(backup.marker), true);
  assert.equal(fs.existsSync(invalidNew.marker), true);
  assert.equal(latestDatabaseBackup(backupDirectory).marker, backup.marker);

  const legacyDirectory = path.join(testRoot, "legacy-backup");
  fs.mkdirSync(legacyDirectory);
  const legacyDatabase = path.join(legacyDirectory, path.basename(backup.path));
  const legacyDocuments = path.join(legacyDirectory, `${path.basename(backup.path, ".db")}.amu`);
  fs.copyFileSync(backup.path, legacyDatabase);
  fs.cpSync(path.join(backupDirectory, `${path.basename(backup.path, ".db")}.amu`), legacyDocuments, { recursive: true });
  const legacy = latestDatabaseBackup(legacyDirectory);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.committed, false);
  pruneDatabaseBackups(legacyDirectory, 0);
  assert.equal(fs.existsSync(legacyDatabase), true);
  assert.equal(fs.existsSync(legacyDocuments), true);

  const encrypted = fs.readFileSync(blobPath);
  fs.rmSync(blobPath);
  const brokenBackupDirectory = path.join(testRoot, "broken-backup");
  assert.throws(
    () => createDatabaseBackupToDirectory(brokenBackupDirectory, "test-missing-blob", "test"),
    /nicht gefunden|Integrität|Dokument/i,
  );
  assert.equal(fs.existsSync(brokenBackupDirectory), false);
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, encrypted);
});

test("v0.71 Block 4: geschützte Formulare vermeiden Autofill und senden nur Feldänderungen", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const protectedForm = html.match(/<details class="employee-protected-record[\s\S]*?<\/details>/)?.[0] || "";
  assert.ok(protectedForm);
  assert.doesNotMatch(protectedForm, /autocomplete="(?:given-name|family-name|tel|email|street-address|postal-code|address-level|country-name|bday|honorific-prefix)"/);
  assert.match(appSource, /function personnelRecordPatch\(/);
  assert.match(appSource, /body\.personnelRecord = isEdit \? recordPatch : currentPersonnelRecord/);
  assert.match(appSource, /elements\.employeeModal\?\.addEventListener\("close", clearEmployeeProtectedRecord\)/);
});
