"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createAmuStorage } = require("../lib/amu-storage");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v058-personnel-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { app, db, migrateProtectedPersonnelRecords, parseProtectedJson, releaseInstanceLockForTests } = require("../server");

let httpServer;
let baseUrl;
let locationId;
let positionId;
let departmentId;

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, role_locked, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, role_locked = excluded.role_locked,
      active = 1, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role, role === "developer" ? 1 : 0);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare("INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at) VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')")
    .run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
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

async function requestRaw(route, { auth = null, body }) {
  const headers = { Accept: "application/json", "Content-Type": "application/octet-stream" };
  if (auth) {
    headers.Cookie = auth.cookie;
    headers["X-CSRF-Token"] = auth.csrf;
  }
  const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers, body });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function employeePayload(personnelNumber, extras = {}) {
  return {
    personnelNumber,
    fullName: `Testperson ${personnelNumber}`,
    nickname: `T${personnelNumber}`,
    contractedHours: 38.5,
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

function reset() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM portal_sessions").run();
    db.prepare("DELETE FROM portal_permission_grants").run();
    db.prepare("DELETE FROM portal_access_scopes").run();
    db.prepare("DELETE FROM portal_users").run();
    db.prepare("DELETE FROM amu_documents").run();
    db.prepare("DELETE FROM amu_reports").run();
    db.prepare("DELETE FROM personnel_sensitive_records").run();
    db.prepare("DELETE FROM audit_log WHERE action LIKE 'personnel-record.%'").run();
    db.prepare("UPDATE employees SET time_confirmation_level = 'C' WHERE personnel_number IN ('104','105')").run();
    db.prepare("UPDATE portal_settings SET value = '1' WHERE key = 'trust_levels_enabled'").run();
    db.prepare("DELETE FROM employees WHERE personnel_number LIKE '88%' OR personnel_number LIKE '89%'").run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

test.before(async () => {
  locationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = '101'").get().home_location_id;
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  departmentId = db.prepare("SELECT id FROM departments WHERE location_id = ? ORDER BY id LIMIT 1").get(locationId)?.id || null;
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.beforeEach(reset);

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.58: IT-Admin legt Personalstammdaten, PL-Rolle und Zusatzrechte atomar an", async () => {
  const itAdmin = session("106", "it_admin");
  const result = await request("/api/employees", {
    method: "POST",
    auth: itAdmin,
    body: employeePayload("880", {
      accessProfile: { role: "hr", permissions: ["employees:write", "backup:write"] },
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.portal_access.role, "hr");
  assert.deepEqual(result.payload.portal_access.grantedPermissions, ["backup:write"]);
  assert.equal(db.prepare("SELECT role FROM portal_users WHERE employee_number = '880'").get().role, "hr");
  assert.deepEqual(db.prepare("SELECT permission FROM portal_permission_grants WHERE employee_number = '880' ORDER BY permission").all().map((row) => row.permission), ["backup:write"]);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'employee.access-profile.update' AND entity_id = '880'").get());
});

test("v0.58: ungültiges Rechteprofil rollt die komplette Neuanlage zurück", async () => {
  const itAdmin = session("106", "it_admin");
  const result = await request("/api/employees", {
    method: "POST",
    auth: itAdmin,
    body: employeePayload("881", {
      accessProfile: { role: "hr", permissions: ["developer:system"] },
    }),
  });
  assert.equal(result.response.status, 403, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "PORTAL_PERMISSION_NOT_DELEGABLE");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '881'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = '881'").get(), undefined);
});

test("v0.58: PL darf Stammdaten anlegen, aber das geschützte Rechteprofil nicht ändern", async () => {
  const hr = session("103", "hr");
  const regular = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload("882"),
  });
  assert.equal(regular.response.status, 201, JSON.stringify(regular.payload));
  assert.equal(regular.payload.portal_access.configured, false);

  const denied = await request("/api/employees", {
    method: "POST",
    auth: hr,
    body: employeePayload("883", { accessProfile: { role: "employee", permissions: [] } }),
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PERSONNEL_ACCESS_PROFILE_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '883'").get(), undefined);
});

test("v0.58: auch ein Admin darf das ausschließlich technische Rechteprofil nicht ändern", async () => {
  const admin = session("101", "admin");
  const denied = await request("/api/employees", {
    method: "POST",
    auth: admin,
    body: employeePayload("885", { accessProfile: { role: "hr", permissions: [] } }),
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PERSONNEL_ACCESS_PROFILE_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = '885'").get(), undefined);
});

test("v0.58: Admin kann sich auch über die alte Zugangsverwaltung nicht zum IT-Admin hochstufen", async () => {
  const admin = session("101", "admin");
  const denied = await request("/api/portal/v1/users/102", {
    method: "PUT",
    auth: admin,
    body: { role: "it_admin", password: "987654", active: true, mustChangePassword: false },
  });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "PORTAL_ROLE_HIERARCHY_DENIED");
  assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = '102'").get(), undefined);
});

test("v0.58: Developer-Ziel bleibt auch für den Developer selbst unveränderlich", async () => {
  const developer = session("101", "developer");
  const current = db.prepare("SELECT * FROM employees WHERE personnel_number = '101'").get();
  const result = await request("/api/employees/101", {
    method: "PUT",
    auth: developer,
    body: employeePayload("101", {
      fullName: current.full_name,
      nickname: current.nickname,
      contractedHours: current.contracted_hours,
      positionId: current.position_id,
      homeLocationId: current.home_location_id,
      preferredDepartmentId: current.preferred_department_id || "",
      color: current.color,
      accessProfile: { role: "employee", permissions: [] },
    }),
  });
  assert.equal(result.response.status, 403, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "PORTAL_DEVELOPER_PROTECTED");
  assert.equal(db.prepare("SELECT role FROM portal_users WHERE employee_number = '101'").get().role, "developer");
});

test("v0.58: Leitungsrolle erhält beim Speichern automatisch den passenden Bereich", async () => {
  if (!departmentId) return;
  const itAdmin = session("106", "it_admin");
  const result = await request("/api/employees", {
    method: "POST",
    auth: itAdmin,
    body: employeePayload("884", {
      preferredDepartmentId: departmentId,
      accessProfile: { role: "department_manager", permissions: [] },
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.payload));
  assert.deepEqual(db.prepare("SELECT location_id, department_id FROM portal_access_scopes WHERE employee_number = '884'").all().map((row) => ({ ...row })), [
    { location_id: locationId, department_id: departmentId },
  ]);
});

test("v0.58: bestehende Klartext-Personalaktfelder werden einmalig verschlüsselt und geleert", () => {
  const reportId = Number(db.prepare(`
    INSERT INTO amu_reports
      (employee_number, location_id, department_id, incapacity_from, incapacity_to, employee_note, review_note,
       reviewed_by, reviewed_at, retention_until, status, protected_payload)
    VALUES ('102', ?, NULL, '2027-09-01', '2027-09-03', 'Klartextnotiz', 'Geprüft', '101',
      '2027-09-04T10:00:00.000Z', '2029-09-03', 'reviewed', '')
  `).run(locationId).lastInsertRowid);
  const documentId = crypto.randomUUID();
  const storageKey = `${documentId.slice(0, 2)}/${documentId}.amu`;
  db.prepare(`
    INSERT INTO amu_documents
      (id, report_id, storage_key, original_filename, detected_mime, byte_size, sha256, scan_status,
       encryption_key_id, encryption_iv, encryption_tag, status, uploaded_by, protected_payload)
    VALUES (?, ?, ?, 'Befund.pdf', 'application/pdf', 1234, ?, 'clean', 'local-v1', '', '', 'active', '102', '')
  `).run(documentId, reportId, storageKey, "a".repeat(64));

  const migrated = migrateProtectedPersonnelRecords();
  assert.deepEqual(migrated, { reports: 1, documents: 1 });
  const report = db.prepare("SELECT * FROM amu_reports WHERE id = ?").get(reportId);
  const document = db.prepare("SELECT * FROM amu_documents WHERE id = ?").get(documentId);
  assert.equal(report.incapacity_from, "");
  assert.equal(report.employee_note, "");
  assert.equal(report.review_note, "");
  assert.match(report.protected_payload, /^enc:v2:/);
  assert.equal(document.original_filename, "");
  assert.equal(document.byte_size, 0);
  assert.match(document.protected_payload, /^enc:v2:/);
  const reportPayload = parseProtectedJson(report.protected_payload, {
    namespace: "personnel-record", recordId: String(reportId), field: "payload", employeeNumber: "102",
  });
  assert.equal(reportPayload.incapacityFrom, "2027-09-01");
  assert.equal(reportPayload.employeeNote, "Klartextnotiz");
  assert.equal(reportPayload.reviewNote, "Geprüft");
  assert.deepEqual(migrateProtectedPersonnelRecords(), { reports: 0, documents: 0 });
});

test("v0.58: Admin darf keine Datenbank über die geschützte API importieren", async () => {
  const admin = session("101", "admin");
  const denied = await requestRaw("/api/backup/import", { auth: admin, body: Buffer.alloc(2048) });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "BACKUP_IMPORT_ROLE_DENIED");
});

test("v0.58: DB-Import lehnt auch bereinigte Personalakten mit fremdem Schlüssel ab", async () => {
  const foreignRoot = fs.mkdtempSync(path.join(testRoot, "foreign-personnel-key-"));
  const foreignStorage = createAmuStorage({
    rootDirectory: path.join(foreignRoot, "amu"),
    encryptionKeys: { foreign: Buffer.alloc(32, 0x5a) },
    activeKeyId: "foreign",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const importedPath = path.join(foreignRoot, "foreign.db");
  const imported = new DatabaseSync(importedPath);
  imported.exec(`
    CREATE TABLE amu_reports (
      id INTEGER PRIMARY KEY,
      employee_number TEXT NOT NULL,
      status TEXT NOT NULL,
      protected_payload TEXT NOT NULL DEFAULT ''
    );
  `);
  const context = { namespace: "personnel-record", recordId: "1", field: "payload", employeeNumber: "102" };
  imported.prepare("INSERT INTO amu_reports (id, employee_number, status, protected_payload) VALUES (1, '102', 'purged', ?)")
    .run(foreignStorage.protectRecord(JSON.stringify({ retentionUntil: "" }), context));
  imported.close();

  const itAdmin = session("106", "it_admin");
  const denied = await requestRaw("/api/backup/import", { auth: itAdmin, body: fs.readFileSync(importedPath) });
  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "AMU_FULL_RESTORE_REQUIRED");
});

test("v0.58: DB-Import prüft auch alte enc:v1-Personalaktfelder mit dem lokalen Schlüssel", async () => {
  const foreignRoot = fs.mkdtempSync(path.join(testRoot, "foreign-legacy-key-"));
  const foreignStorage = createAmuStorage({
    rootDirectory: path.join(foreignRoot, "amu"),
    encryptionKeys: { foreign: Buffer.alloc(32, 0x6b) },
    activeKeyId: "foreign",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const importedPath = path.join(foreignRoot, "foreign-v057.db");
  const imported = new DatabaseSync(importedPath);
  imported.exec(`
    CREATE TABLE amu_reports (
      id INTEGER PRIMARY KEY,
      employee_number TEXT NOT NULL,
      status TEXT NOT NULL,
      employee_note TEXT NOT NULL DEFAULT '',
      review_note TEXT NOT NULL DEFAULT ''
    );
  `);
  imported.prepare("INSERT INTO amu_reports (id, employee_number, status, employee_note) VALUES (1, '102', 'purged', ?)")
    .run(foreignStorage.protectText("Alte verschlüsselte Notiz"));
  imported.close();

  const itAdmin = session("106", "it_admin");
  const denied = await requestRaw("/api/backup/import", { auth: itAdmin, body: fs.readFileSync(importedPath) });
  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "AMU_FULL_RESTORE_REQUIRED");
});

test("v0.70 Block 2: sensible Personalaktfelder werden verschlüsselt gespeichert und feldgenau ausgegeben", async () => {
  const hr = session("103", "hr");
  const saved = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT",
    auth: hr,
    body: {
      phone: "+43 664 1234567",
      sensitive: {
        socialSecurityNumber: "1238010190",
        iban: "AT611904300234573201",
        bic: "BKAUATWW",
        accountHolder: "Demo Person",
        address: { street: "Musterweg 12", postalCode: "6020", city: "Innsbruck", country: "Österreich" },
      },
    },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.deepEqual(saved.payload.changedFields.sort(), [
    "accountHolder", "address.city", "address.postalCode", "address.street", "bic", "iban", "phone",
    "socialSecurityNumber",
  ]);

  const stored = db.prepare("SELECT * FROM personnel_sensitive_records WHERE employee_number = '102'").get();
  assert.match(stored.protected_payload, /^enc:v2:/);
  assert.notEqual(stored.social_security_lookup, "1238010190");
  assert.equal(stored.protected_payload.includes("1238010190"), false);
  assert.equal(stored.protected_payload.includes("AT611904300234573201"), false);
  assert.equal(stored.protected_payload.includes("Musterweg"), false);

  const loaded = await request("/api/portal/v1/personnel-records/102", { auth: hr });
  assert.equal(loaded.response.status, 200, JSON.stringify(loaded.payload));
  assert.equal(loaded.payload.profile.phone, "+43 664 1234567");
  assert.equal(loaded.payload.profile.sensitive.socialSecurityNumber, "1238010190");
  assert.equal(loaded.payload.profile.sensitive.iban, "AT611904300234573201");
  assert.equal(loaded.payload.profile.sensitive.address.city, "Innsbruck");
  assert.equal(loaded.payload.access.canWriteSensitive, true);

  const audit = db.prepare(`
    SELECT detail FROM audit_log
    WHERE action = 'personnel-record.update' AND entity_id = '102'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.ok(audit);
  assert.equal(audit.detail.includes("1238010190"), false);
  assert.equal(audit.detail.includes("AT611904300234573201"), false);
  assert.equal(audit.detail.includes("+43 664"), false);
  assert.match(audit.detail, /socialSecurityNumber/);
});

test("v0.70 Block 2: Leitungen sehen nur Telefon und benötigen Schreibrecht plus eigene Vertrauensstufe A", async () => {
  const hr = session("103", "hr");
  await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: hr,
    body: { phone: "+43 512 555111", sensitive: { socialSecurityNumber: "1238010190" } },
  });
  const manager = session("104", "manager");
  db.prepare(`
    INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by)
    VALUES ('104', ?, 0, 'test')
  `).run(locationId);
  const visible = await request("/api/portal/v1/personnel-records/102", { auth: manager });
  assert.equal(visible.response.status, 200, JSON.stringify(visible.payload));
  assert.equal(visible.payload.profile.phone, "+43 512 555111");
  assert.equal(visible.payload.profile.sensitive, null);
  assert.deepEqual(visible.payload.reports, []);
  assert.equal(visible.payload.access.canWritePhone, false);

  const withoutGrant = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: manager, body: { phone: "+43 512 555222" },
  });
  assert.equal(withoutGrant.response.status, 403, JSON.stringify(withoutGrant.payload));
  assert.equal(withoutGrant.payload.code, "PERSONNEL_PHONE_WRITE_DENIED");

  const delegated = await request("/api/portal/v1/rights/104", {
    method: "PUT", auth: hr, body: { permissions: ["personnel:phone:write"] },
  });
  assert.equal(delegated.response.status, 200, JSON.stringify(delegated.payload));
  const withoutTrustA = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: manager, body: { phone: "+43 512 555222" },
  });
  assert.equal(withoutTrustA.response.status, 403, JSON.stringify(withoutTrustA.payload));
  assert.equal(withoutTrustA.payload.code, "PERSONNEL_PHONE_WRITE_DENIED");

  db.prepare("UPDATE employees SET time_confirmation_level = 'A' WHERE personnel_number = '104'").run();
  const changed = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: manager, body: { phone: "+43 512 555222" },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
  assert.deepEqual(changed.payload.changedFields, ["phone"]);

  db.prepare("UPDATE portal_settings SET value = '0' WHERE key = 'trust_levels_enabled'").run();
  const disabledPolicy = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: manager, body: { phone: "+43 512 555333" },
  });
  assert.equal(disabledPolicy.response.status, 403, JSON.stringify(disabledPolicy.payload));
  assert.equal(db.prepare("SELECT time_confirmation_level FROM employees WHERE personnel_number = '104'").get().time_confirmation_level, "A");
});

test("v0.70 Block 2: IT-Admin hat sensible Personaldaten nicht automatisch und doppelte SV-Nummern werden verhindert", async () => {
  const hr = session("103", "hr");
  const first = await request("/api/portal/v1/personnel-records/102", {
    method: "PUT", auth: hr, body: { sensitive: { socialSecurityNumber: "1238010190" } },
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));

  const itAdmin = session("106", "it_admin");
  const denied = await request("/api/portal/v1/personnel-records/102", { auth: itAdmin });
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));

  db.prepare(`
    INSERT INTO portal_permission_grants (employee_number, permission, granted_by)
    VALUES ('106', 'personnel:sensitive:read', '101')
  `).run();
  const explicitlyAllowed = await request("/api/portal/v1/personnel-records/102", { auth: itAdmin });
  assert.equal(explicitlyAllowed.response.status, 200, JSON.stringify(explicitlyAllowed.payload));
  assert.equal(explicitlyAllowed.payload.profile.sensitive.socialSecurityNumber, "1238010190");
  assert.equal(explicitlyAllowed.payload.access.canWriteSensitive, false);

  const duplicate = await request("/api/portal/v1/personnel-records/105", {
    method: "PUT", auth: hr, body: { sensitive: { socialSecurityNumber: "1238010190" } },
  });
  assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.payload));
  assert.equal(duplicate.payload.code, "PERSONNEL_SOCIAL_SECURITY_DUPLICATE");

  const invalid = await request("/api/portal/v1/personnel-records/105", {
    method: "PUT", auth: hr, body: { sensitive: { socialSecurityNumber: "1230010190" } },
  });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.payload));
  assert.equal(invalid.payload.code, "PERSONNEL_SOCIAL_SECURITY_INVALID");
});

test("v0.70 Block 2: DB-Import lehnt sensible Personalakten mit fremdem Schlüssel ab", async () => {
  const foreignRoot = fs.mkdtempSync(path.join(testRoot, "foreign-sensitive-profile-"));
  const foreignStorage = createAmuStorage({
    rootDirectory: path.join(foreignRoot, "amu"),
    encryptionKeys: { foreign: Buffer.alloc(32, 0x7c) },
    activeKeyId: "foreign",
    scanner: async () => ({ available: true, clean: true, engine: "test" }),
  });
  const importedPath = path.join(foreignRoot, "foreign-sensitive.db");
  const imported = new DatabaseSync(importedPath);
  imported.exec(`
    CREATE TABLE personnel_sensitive_records (
      employee_number TEXT PRIMARY KEY,
      protected_payload TEXT NOT NULL
    );
  `);
  const context = { namespace: "personnel-sensitive-record", recordId: "102", field: "payload", employeeNumber: "102" };
  imported.prepare("INSERT INTO personnel_sensitive_records (employee_number, protected_payload) VALUES ('102', ?)")
    .run(foreignStorage.protectRecord(JSON.stringify({ socialSecurityNumber: "1238010190" }), context));
  imported.close();

  const itAdmin = session("106", "it_admin");
  const denied = await requestRaw("/api/backup/import", { auth: itAdmin, body: fs.readFileSync(importedPath) });
  assert.equal(denied.response.status, 409, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "AMU_FULL_RESTORE_REQUIRED");
});

test("v0.70 Block 2: Personalakt-Oberfläche trennt Kontakt, sensible Daten und AUM-Verlauf kompakt", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(html, /id="personnelRecordForm"/);
  assert.match(html, /id="savePersonnelRecordButton"/);
  assert.match(script, /personnelRecordField\("socialSecurityNumber"/);
  assert.match(script, /personnel:sensitive:read/);
  assert.match(script, /phoneWriteRequiresTrustA/);
  assert.match(styles, /\.personnel-record-field-grid/);
  assert.match(styles, /\.sensitive-personnel-section/);
});
