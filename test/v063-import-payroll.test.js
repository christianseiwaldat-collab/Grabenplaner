"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v063-integrations-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const preMigrationDb = new DatabaseSync(process.env.DB_PATH);
preMigrationDb.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY,
    app_version TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
preMigrationDb.prepare("INSERT INTO settings (key, value) VALUES ('installation_features', ?)")
  .run(JSON.stringify(["schedule", "vacation", "requests", "employeePortal", "timeTracking", "sicknessAmu", "wifiSuggestions"]));
preMigrationDb.close();

const subject = require("../server");
const { app, db, evaluateTimeDay, installationFeaturesForApiPath, releaseInstanceLockForTests } = subject;
const { inspectTabularBuffer, createCsvBuffer, createXlsxBuffer, spreadsheetSafeText } = require("../lib/tabular-data");
const { IntegrationCache } = require("../lib/integration-cache");
const { mappedPersonnelRow } = require("../lib/personnel-import");

let server;
let baseUrl;
let locationId;
let positionId;

test("v0.63: vollständig freigeschaltete Altinstallationen erhalten das neue Integrationsmodul", () => {
  const configured = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get().value);
  assert.ok(configured.includes("integrations"));
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.63-import-payroll-integrations'").get());
});

function session(employeeNumber, role) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  db.prepare(`
    INSERT INTO portal_users (employee_number, password_hash, role, active, must_change_password, password_changed_at, updated_at)
    VALUES (?, 'test-only', ?, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(employee_number) DO UPDATE SET role = excluded.role, active = 1, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
  `).run(employeeNumber, role);
  db.prepare("DELETE FROM portal_sessions WHERE employee_number = ?").run(employeeNumber);
  db.prepare("INSERT INTO portal_sessions (id, employee_number, token_hash, expires_at) VALUES (?, ?, ?, '2099-12-31T23:59:59.000Z')")
    .run(crypto.randomUUID(), employeeNumber, crypto.createHash("sha256").update(token).digest("hex"));
  return { cookie: `grabenplaner_session=${token}; grabenplaner_csrf=${csrf}`, csrf };
}

async function request(route, { method = "GET", auth = null, body, raw = false, contentType = "application/json", fileName = "" } = {}) {
  const headers = { Accept: raw ? "*/*" : "application/json" };
  if (auth) headers.Cookie = auth.cookie;
  if (auth && !["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = auth.csrf;
  if (body !== undefined) headers["Content-Type"] = contentType;
  if (fileName) headers["X-Import-Filename"] = encodeURIComponent(fileName);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body) }),
  });
  if (raw && response.ok) return { response, payload: Buffer.from(await response.arrayBuffer()) };
  const text = response.status === 204 ? "" : await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

function resetFixture() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM integration_runs").run();
    db.prepare("DELETE FROM integration_profiles").run();
    db.prepare("DELETE FROM time_day_reviews").run();
    db.prepare("DELETE FROM time_corrections").run();
    db.prepare("DELETE FROM time_entries").run();
    db.prepare("DELETE FROM shifts").run();
    db.prepare("DELETE FROM employee_location_lendings").run();
    db.prepare("DELETE FROM week_options").run();
    db.prepare("DELETE FROM portal_sessions").run();
    db.prepare("DELETE FROM portal_permission_grants").run();
    db.prepare("DELETE FROM portal_users WHERE employee_number LIKE '99%' OR employee_number LIKE '00%'").run();
    db.prepare("DELETE FROM employees WHERE personnel_number LIKE '99%' OR personnel_number LIKE '00%'").run();
    db.prepare("UPDATE employees SET active = 1 WHERE personnel_number IN ('101', '102', '103')").run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

test.before(async () => {
  locationId = db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = '101'").get().home_location_id;
  positionId = db.prepare("SELECT id FROM positions ORDER BY sort_order, id LIMIT 1").get().id;
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(resetFixture);

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.63: CSV- und XLSX-Verarbeitung bewahrt Text-IDs und neutralisiert Tabellenformeln", async () => {
  const csv = Buffer.from("Personalnummer;Name\r\n007;Ada Beispiel\r\n", "utf8");
  const inspected = await inspectTabularBuffer(csv, { fileName: "team.csv" });
  assert.equal(inspected.format, "csv");
  assert.equal(inspected.delimiter, ";");
  assert.equal(inspected.sheets[0].rows[1][0].text, "007");

  const columns = [{ id: "personnelNumber", label: "Personalnummer", type: "identifier" }, { id: "name", label: "Name", type: "text" }];
  const xlsx = await createXlsxBuffer(columns, [{ personnelNumber: "007", name: "=HYPERLINK(\"x\")" }]);
  const xlsxInspected = await inspectTabularBuffer(xlsx, { fileName: "team.xlsx" });
  assert.equal(xlsxInspected.sheets[0].rows[1][0].text, "007");
  assert.equal(xlsxInspected.sheets[0].rows[1][1].formula, false);
  assert.equal(xlsxInspected.sheets[0].rows[1][1].text.startsWith("'="), true);
  assert.equal(spreadsheetSafeText("+1+1"), "'+1+1");
  assert.match(createCsvBuffer(columns, [{ personnelNumber: "007", name: "@danger" }]).toString("utf8"), /'@danger/);
});

test("v0.63: Namensspalten für Position und Standort werden nicht von Standard-IDs überschrieben", () => {
  const cells = ["990", "Test Person", "Teamleitung", "Grabenweg"].map((text) => ({ text, formula: false, error: false }));
  const mapped = mappedPersonnelRow(cells, {
    personnelNumber: { columnIndex: 0 },
    fullName: { columnIndex: 1 },
    positionName: { columnIndex: 2 },
    homeLocationName: { columnIndex: 3 },
  }, { positionId: "verkaufsmitarbeiter", homeLocationId: "99", contractedHours: 38.5 });
  assert.equal(mapped.positionId, "");
  assert.equal(mapped.positionName, "Teamleitung");
  assert.equal(mapped.homeLocationId, "");
  assert.equal(mapped.homeLocationName, "Grabenweg");
});

test("v0.63: temporäre Importvorschauen sind zeitlich und an den Akteur gebunden", () => {
  const cache = new IntegrationCache({ ttlMs: 60_000, maxEntries: 2, maxEntriesPerActor: 1 });
  const created = cache.create("101", "inspection", { safe: true });
  assert.deepEqual(cache.get(created.id, "101", "inspection").value, { safe: true });
  assert.throws(() => cache.get(created.id, "102", "inspection"), /abgelaufen/i);
  assert.throws(() => cache.create("101", "inspection", {}), /bestehenden Import/i);
  assert.deepEqual(cache.consume(created.id, "101", "inspection"), { safe: true });
  assert.throws(() => cache.get(created.id, "101", "inspection"), /abgelaufen/i);
});

test("v0.64: temporäre Importvorschauen begrenzen Einzel- und Gesamtspeicher", () => {
  const cache = new IntegrationCache({
    ttlMs: 60_000,
    maxEntries: 10,
    maxEntriesPerActor: 10,
    maxEntryBytes: 1100,
    maxBytes: 1500,
  });
  cache.create("101", "inspection", { value: "a".repeat(900) });
  assert.throws(
    () => cache.create("102", "inspection", { value: "b".repeat(900) }),
    (error) => error.code === "INTEGRATION_SESSION_SIZE_LIMIT" && error.status === 413,
  );
  assert.throws(
    () => new IntegrationCache({ maxEntryBytes: 1024, maxBytes: 2048 }).create("101", "inspection", { value: "c".repeat(1500) }),
    (error) => error.code === "INTEGRATION_SESSION_SIZE_LIMIT" && error.status === 413,
  );
  cache.clear();
});

test("v0.63: Personalimport benötigt eigenes Recht und übernimmt Vorschau atomar ohne Portalrechte", async () => {
  const manager = session("102", "manager");
  const denied = await request("/api/integrations/personnel-import/catalog", { auth: manager });
  assert.equal(denied.response.status, 403);

  const hr = session("103", "hr");
  const csv = Buffer.from("Personalnummer;Name;Spitzname;Sollzeit\r\n00991;Nova Beispiel;Nova;32,5\r\n", "utf8");
  const inspect = await request("/api/integrations/personnel-import/inspect", {
    method: "POST", auth: hr, body: csv, raw: false, contentType: "text/csv", fileName: "team.csv",
  });
  assert.equal(inspect.response.status, 201, JSON.stringify(inspect.payload));
  const preview = await request("/api/integrations/personnel-import/preview", {
    method: "POST", auth: hr, body: {
      inspectionId: inspect.payload.inspectionId,
      sheetName: "CSV",
      headerRow: 1,
      mapping: { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, nickname: { columnIndex: 2 }, contractedHours: { columnIndex: 3 } },
      defaults: { homeLocationId: locationId, positionId, contractedHours: 38.5, active: true },
      duplicateStrategy: "skip",
    },
  });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.payload));
  assert.deepEqual(preview.payload.summary, { total: 1, create: 1, update: 0, skip: 0, errors: 0, warnings: 0 });

  const applied = await request("/api/integrations/personnel-import/apply", {
    method: "POST", auth: hr, body: { previewId: preview.payload.previewId },
  });
  assert.equal(applied.response.status, 201, JSON.stringify(applied.payload));
  const employee = db.prepare("SELECT * FROM employees WHERE personnel_number = '00991'").get();
  assert.equal(employee.full_name, "Nova Beispiel");
  assert.equal(employee.contracted_hours, 32.5);
  assert.equal(db.prepare("SELECT 1 FROM portal_users WHERE employee_number = '00991'").get(), undefined);
  const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'integration.personnel.import.applied' ORDER BY id DESC LIMIT 1").get();
  assert.ok(audit);
  assert.doesNotMatch(audit.detail, /Nova|Beispiel|00991/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM integration_runs WHERE direction = 'import'").get().count, 1);
});

test("Personalmodul R1: konkurrierender Unique-Insert macht die Importvorschau kontrolliert veraltet", async () => {
  const hr = session("103", "hr");
  const employeeNumber = "00992";
  const csv = Buffer.from(`Personalnummer;Name;Spitzname;Sollzeit\r\n${employeeNumber};Race Beispiel;Race;32,5\r\n`, "utf8");
  const inspect = await request("/api/integrations/personnel-import/inspect", {
    method: "POST", auth: hr, body: csv, contentType: "text/csv", fileName: "race.csv",
  });
  assert.equal(inspect.response.status, 201, JSON.stringify(inspect.payload));
  const preview = await request("/api/integrations/personnel-import/preview", {
    method: "POST",
    auth: hr,
    body: {
      inspectionId: inspect.payload.inspectionId,
      sheetName: "CSV",
      headerRow: 1,
      mapping: {
        personnelNumber: { columnIndex: 0 },
        fullName: { columnIndex: 1 },
        nickname: { columnIndex: 2 },
        contractedHours: { columnIndex: 3 },
      },
      defaults: { homeLocationId: locationId, positionId, contractedHours: 38.5, active: true },
      duplicateStrategy: "skip",
    },
  });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.payload));
  const auditCountBefore = db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'integration.personnel.import.applied'
  `).get().count;
  db.exec(`
    CREATE TRIGGER test_personnel_import_unique_race
    BEFORE INSERT ON employees
    WHEN NEW.personnel_number = '${employeeNumber}'
    BEGIN
      INSERT INTO employees (personnel_number, full_name, nickname, active)
      VALUES ('${employeeNumber}', 'Race Konkurrent', 'Race', 1);
    END;
  `);
  try {
    const stale = await request("/api/integrations/personnel-import/apply", {
      method: "POST",
      auth: hr,
      body: { previewId: preview.payload.previewId },
    });
    assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
    assert.equal(stale.payload.code, "IMPORT_PREVIEW_STALE");
    assert.equal(db.prepare("SELECT 1 FROM employees WHERE personnel_number = ?").get(employeeNumber), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM integration_runs WHERE direction = 'import'")
      .get().count, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action = 'integration.personnel.import.applied'
    `).get().count, auditCountBefore);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS test_personnel_import_unique_race");
  }

  const retried = await request("/api/integrations/personnel-import/apply", {
    method: "POST",
    auth: hr,
    body: { previewId: preview.payload.previewId },
  });
  assert.equal(retried.response.status, 201, JSON.stringify(retried.payload));
  assert.equal(db.prepare("SELECT full_name FROM employees WHERE personnel_number = ?")
    .get(employeeNumber).full_name, "Race Beispiel");
});

test("Personalmodul R1: Import darf unveränderte archivierte Altzuordnungen beibehalten", async () => {
  const hr = session("103", "hr");
  const employeeNumber = "00993";
  const costCenterId = String(db.prepare("SELECT cost_center_id FROM locations WHERE id = ?")
    .get(locationId)?.cost_center_id || "");
  assert.ok(costCenterId);
  let departmentId = Number(db.prepare(`
    SELECT id FROM departments WHERE location_id = ? ORDER BY id LIMIT 1
  `).get(locationId)?.id || 0);
  if (!departmentId) {
    departmentId = Number(db.prepare(`
      INSERT INTO departments (location_id, name, active)
      VALUES (?, 'R1 Import Altzuordnung', 1)
    `).run(locationId).lastInsertRowid);
  }
  assert.ok(departmentId);
  const compatiblePositionId = String(db.prepare(`
    SELECT cctp.position_id
    FROM cost_centers cc
    JOIN cost_center_type_positions cctp
      ON cctp.cost_center_type_id = cc.cost_center_type_id
    WHERE cc.id = ?
    ORDER BY cctp.sort_order, cctp.position_id
    LIMIT 1
  `).get(costCenterId)?.position_id || "");
  assert.ok(compatiblePositionId);
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, position_id, time_confirmation_level,
      home_location_id, preferred_department_id, cost_center_id, active
    ) VALUES (?, 'Altzuordnung Bestand', 'Altbestand', '#2c7a68', 38.5, 5, ?, 'C', ?, ?, ?, 1)
  `).run(employeeNumber, compatiblePositionId, locationId, departmentId, costCenterId);

  const inspect = await request("/api/integrations/personnel-import/inspect", {
    method: "POST",
    auth: hr,
    body: Buffer.from(`Personalnummer;Name\r\n${employeeNumber};Altzuordnung Aktualisiert\r\n`, "utf8"),
    contentType: "text/csv",
    fileName: "altzuordnung.csv",
  });
  assert.equal(inspect.response.status, 201, JSON.stringify(inspect.payload));
  const preview = await request("/api/integrations/personnel-import/preview", {
    method: "POST",
    auth: hr,
    body: {
      inspectionId: inspect.payload.inspectionId,
      sheetName: "CSV",
      headerRow: 1,
      mapping: {
        personnelNumber: { columnIndex: 0 },
        fullName: { columnIndex: 1 },
      },
      defaults: { homeLocationId: locationId, positionId: compatiblePositionId, contractedHours: 38.5, active: true },
      duplicateStrategy: "update",
    },
  });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.payload));
  assert.equal(preview.payload.summary.update, 1);

  try {
    db.prepare("UPDATE locations SET active = 0 WHERE id = ?").run(locationId);
    db.prepare("UPDATE departments SET active = 0 WHERE id = ?").run(departmentId);
    const applied = await request("/api/integrations/personnel-import/apply", {
      method: "POST",
      auth: hr,
      body: { previewId: preview.payload.previewId },
    });
    assert.equal(applied.response.status, 201, JSON.stringify(applied.payload));
    assert.deepEqual({ ...db.prepare(`
      SELECT full_name, home_location_id, preferred_department_id, cost_center_id
      FROM employees WHERE personnel_number = ?
    `).get(employeeNumber) }, {
      full_name: "Altzuordnung Aktualisiert",
      home_location_id: locationId,
      preferred_department_id: departmentId,
      cost_center_id: costCenterId,
    });
  } finally {
    db.prepare("UPDATE locations SET active = 1 WHERE id = ?").run(locationId);
    db.prepare("UPDATE departments SET active = 1 WHERE id = ?").run(departmentId);
  }
});

test("Personalmodul R1: Import darf eine unveränderte archivierte Verwaltungskostenstelle beibehalten", async () => {
  const hr = session("103", "hr");
  const employeeNumber = "00994";
  const assignment = db.prepare(`
    SELECT cc.id AS cost_center_id, cctp.position_id
    FROM cost_centers cc
    JOIN cost_center_types type ON type.id = cc.cost_center_type_id
    JOIN cost_center_type_positions cctp
      ON cctp.cost_center_type_id = cc.cost_center_type_id
    WHERE cc.active = 1
      AND type.active = 1
      AND type.is_branch = 0
      AND NOT EXISTS (SELECT 1 FROM locations WHERE cost_center_id = cc.id)
    ORDER BY cc.sort_order, cctp.sort_order, cc.id, cctp.position_id
    LIMIT 1
  `).get();
  assert.ok(assignment?.cost_center_id);
  assert.ok(assignment?.position_id);
  db.prepare(`
    INSERT INTO employees (
      personnel_number, full_name, nickname, color, contracted_hours,
      target_workdays_per_week, position_id, time_confirmation_level,
      home_location_id, preferred_department_id, cost_center_id, active
    ) VALUES (?, 'Verwaltung Bestand', 'Verwaltung', '#2c7a68', 38.5, 5, ?, 'C', NULL, NULL, ?, 1)
  `).run(employeeNumber, assignment.position_id, assignment.cost_center_id);

  const inspect = await request("/api/integrations/personnel-import/inspect", {
    method: "POST",
    auth: hr,
    body: Buffer.from(`Personalnummer;Name\r\n${employeeNumber};Verwaltung Aktualisiert\r\n`, "utf8"),
    contentType: "text/csv",
    fileName: "verwaltung-altzuordnung.csv",
  });
  assert.equal(inspect.response.status, 201, JSON.stringify(inspect.payload));
  const preview = await request("/api/integrations/personnel-import/preview", {
    method: "POST",
    auth: hr,
    body: {
      inspectionId: inspect.payload.inspectionId,
      sheetName: "CSV",
      headerRow: 1,
      mapping: {
        personnelNumber: { columnIndex: 0 },
        fullName: { columnIndex: 1 },
      },
      defaults: {
        positionId: assignment.position_id,
        contractedHours: 38.5,
        active: true,
      },
      duplicateStrategy: "update",
    },
  });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.payload));
  assert.equal(preview.payload.summary.update, 1);
  try {
    db.prepare("UPDATE cost_centers SET active = 0 WHERE id = ?").run(assignment.cost_center_id);
    const applied = await request("/api/integrations/personnel-import/apply", {
      method: "POST",
      auth: hr,
      body: { previewId: preview.payload.previewId },
    });
    assert.equal(applied.response.status, 201, JSON.stringify(applied.payload));
    assert.deepEqual({ ...db.prepare(`
      SELECT full_name, home_location_id, preferred_department_id, cost_center_id
      FROM employees WHERE personnel_number = ?
    `).get(employeeNumber) }, {
      full_name: "Verwaltung Aktualisiert",
      home_location_id: null,
      preferred_department_id: null,
      cost_center_id: assignment.cost_center_id,
    });
  } finally {
    db.prepare("UPDATE cost_centers SET active = 1 WHERE id = ?").run(assignment.cost_center_id);
  }
});

test("v0.63: Personalimport behandelt Groß-/Kleinschreibung als dieselbe Personalnummer und lehnt leere Daten ab", async () => {
  const hr = session("103", "hr");
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, position_id, time_confirmation_level, home_location_id, active)
    VALUES ('99Case', 'Case Bestand', 'Case', '#146c5a', 38.5, ?, 'C', ?, 1)
  `).run(positionId, locationId);

  const duplicateFile = Buffer.from("Personalnummer;Name\r\n99case;Andere Schreibweise\r\n", "utf8");
  const inspected = await request("/api/integrations/personnel-import/inspect", {
    method: "POST", auth: hr, body: duplicateFile, contentType: "text/csv", fileName: "case.csv",
  });
  const preview = await request("/api/integrations/personnel-import/preview", {
    method: "POST", auth: hr, body: {
      inspectionId: inspected.payload.inspectionId,
      sheetName: "CSV",
      headerRow: 1,
      mapping: { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 } },
      defaults: { homeLocationId: locationId, positionId, contractedHours: 38.5, active: true },
      duplicateStrategy: "skip",
    },
  });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.payload));
  assert.equal(preview.payload.summary.skip, 1);
  assert.equal(preview.payload.summary.create, 0);
  assert.ok(preview.payload.rows[0].warnings.some((warning) => warning.code === "PERSONNEL_NUMBER_CASE_MATCH"));

  const headerOnly = await request("/api/integrations/personnel-import/inspect", {
    method: "POST", auth: hr, body: Buffer.from("Personalnummer;Name\r\n", "utf8"), contentType: "text/csv", fileName: "leer.csv",
  });
  const emptyPreview = await request("/api/integrations/personnel-import/preview", {
    method: "POST", auth: hr, body: {
      inspectionId: headerOnly.payload.inspectionId,
      sheetName: "CSV",
      headerRow: 1,
      mapping: { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 } },
      defaults: { homeLocationId: locationId, positionId, contractedHours: 38.5, active: true },
    },
  });
  assert.equal(emptyPreview.response.status, 400);
  assert.equal(emptyPreview.payload.code, "IMPORT_DATA_ROWS_REQUIRED");
});

test("v0.63: delegierter Personalimport sieht nur zugewiesene Standorte", async () => {
  const manager = session("102", "manager");
  db.prepare("INSERT INTO portal_permission_grants (employee_number, permission, granted_by) VALUES ('102', 'employees:import', '101')").run();
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = '102'").run();
  db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES ('102', ?, 0, '101')").run(locationId);
  const catalog = await request("/api/integrations/personnel-import/catalog", { auth: manager });
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.payload));
  assert.deepEqual(catalog.payload.references.locations.map((location) => location.id), [locationId]);
});

test("v0.63: delegierter Import darf keine Person aus einem fremden Standort in den eigenen Bereich verschieben", async () => {
  const manager = session("102", "manager");
  const otherLocationId = "97";
  db.prepare("INSERT OR IGNORE INTO locations (id, name, active) VALUES (?, 'Fremdfiliale', 1)").run(otherLocationId);
  db.prepare(`
    INSERT INTO employees
      (personnel_number, full_name, nickname, color, contracted_hours, position_id, time_confirmation_level, home_location_id, active)
    VALUES ('99Remote', 'Remote Bestand', 'Remote', '#146c5a', 38.5, ?, 'C', ?, 1)
  `).run(positionId, otherLocationId);
  db.prepare("INSERT INTO portal_permission_grants (employee_number, permission, granted_by) VALUES ('102', 'employees:import', '101')").run();
  db.prepare("DELETE FROM portal_access_scopes WHERE employee_number = '102'").run();
  db.prepare("INSERT INTO portal_access_scopes (employee_number, location_id, department_id, assigned_by) VALUES ('102', ?, 0, '101')").run(locationId);
  const csv = Buffer.from(`Personalnummer;Name;Standort-ID\r\n99remote;Verschoben;${locationId}\r\n`, "utf8");
  const inspected = await request("/api/integrations/personnel-import/inspect", {
    method: "POST", auth: manager, body: csv, contentType: "text/csv", fileName: "scope.csv",
  });
  const preview = await request("/api/integrations/personnel-import/preview", {
    method: "POST", auth: manager, body: {
      inspectionId: inspected.payload.inspectionId, sheetName: "CSV", headerRow: 1,
      mapping: { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 }, homeLocationId: { columnIndex: 2 } },
      defaults: { homeLocationId: locationId, positionId, contractedHours: 38.5, active: true }, duplicateStrategy: "update",
    },
  });
  assert.equal(preview.response.status, 201, JSON.stringify(preview.payload));
  assert.equal(preview.payload.summary.errors, 1);
  assert.equal(db.prepare("SELECT home_location_id FROM employees WHERE personnel_number = '99Remote'").get().home_location_id, otherLocationId);
});

test("v0.63: Importprofile speichern nur Zuordnung und keine Quelldatei", async () => {
  const admin = session("101", "admin");
  const created = await request("/api/integrations/profiles", {
    method: "POST", auth: admin, body: {
      direction: "import", kind: "personnel", name: "Standard CSV",
      configuration: {
        format: "csv", headerRow: 1, delimiter: ";", mapping: { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 } },
        defaults: { homeLocationId: locationId, positionId }, duplicateStrategy: "skip",
      },
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const stored = db.prepare("SELECT configuration_json FROM integration_profiles WHERE id = ?").get(created.payload.profile.id);
  assert.doesNotMatch(stored.configuration_json, /Standard CSV|Quelldatei|Beispielperson/);
  const list = await request("/api/integrations/profiles", { auth: admin });
  assert.equal(list.payload.profiles.length, 1);

  const changedKind = await request(`/api/integrations/profiles/${created.payload.profile.id}`, {
    method: "PUT", auth: admin, body: {
      direction: "export", kind: "payroll", name: "Standard CSV",
      configuration: { format: "csv", layout: "daily_journal" },
    },
  });
  assert.equal(changedKind.response.status, 400);
  assert.equal(changedKind.payload.code, "INTEGRATION_PROFILE_KIND_LOCKED");
});

test("v0.63: finaler Ist-Lohnexport verlangt aktuelle Tagesprüfung und liefert CSV mit Audit-Hash", async () => {
  const admin = session("101", "admin");
  const date = "2026-07-13";
  db.prepare("UPDATE locations SET time_tracking_enabled = 1 WHERE id = ?").run(locationId);
  db.prepare("INSERT INTO shifts (employee_number, shift_date, start_time, end_time, area) VALUES ('101', ?, '09:00', '17:00', 'Test')").run(date);
  const insertEntry = db.prepare(`
    INSERT INTO time_entries (employee_number, location_id, work_date, entry_type, entry_timestamp, source, created_by)
    VALUES ('101', ?, ?, ?, ?, 'test', '101')
  `);
  for (const [type, time] of [["clock_in", "09:00"], ["break_start", "12:00"], ["break_end", "12:30"], ["clock_out", "17:00"]]) {
    insertEntry.run(locationId, date, type, new Date(`${date}T${time}:00+02:00`).toISOString());
  }
  const body = {
    dateFrom: date, dateTo: date, locationId, departmentId: null,
    configuration: { layout: "daily_journal", sourceMode: "actual_reviewed", format: "csv", delimiter: ";" },
  };
  const blocked = await request("/api/integrations/payroll-export/preflight", { method: "POST", auth: admin, body });
  assert.equal(blocked.response.status, 200, JSON.stringify(blocked.payload));
  assert.ok(blocked.payload.blockers.some((item) => item.code === "MISSING_REVIEW"));
  const draft = await request("/api/integrations/payroll-export/file", {
    method: "POST", auth: admin, raw: true, body: { ...body, fingerprint: blocked.payload.fingerprint, allowDraft: true },
  });
  assert.equal(draft.response.status, 200);
  assert.equal(draft.response.headers.get("x-grabenplaner-export-status"), "draft");
  assert.match(draft.response.headers.get("content-disposition"), /ENTWURF-/i);
  assert.match(draft.payload.toString("utf8"), /# ENTWURF/);

  const evaluation = await evaluateTimeDay("101", date, new Date("2026-07-14T12:00:00Z"));
  db.prepare(`
    INSERT INTO time_day_reviews
      (employee_number, location_id, department_id, department_key, work_date, note, reviewed_by, evaluation_version, snapshot_json)
    VALUES ('101', ?, NULL, 0, ?, '', '101', ?, ?)
  `).run(locationId, date, evaluation.evaluationVersion, JSON.stringify({ evaluationHash: evaluation.evaluationHash }));

  const ready = await request("/api/integrations/payroll-export/preflight", { method: "POST", auth: admin, body });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
  assert.equal(ready.payload.blockers.length, 0, JSON.stringify(ready.payload.blockers));
  assert.equal(ready.payload.rowCount, 1);
  const exported = await request("/api/integrations/payroll-export/file", {
    method: "POST", auth: admin, raw: true, body: { ...body, fingerprint: ready.payload.fingerprint },
  });
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get("content-type"), /text\/csv/);
  assert.match(exported.payload.toString("utf8"), /Personalnummer/);
  const run = db.prepare("SELECT content_sha256, options_json, result_json FROM integration_runs WHERE direction = 'export' ORDER BY started_at DESC, id DESC LIMIT 1").get();
  assert.match(run.content_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(`${run.options_json}${run.result_json}`, /Ada|Nova|Beispiel/);
});

test("v0.63: geplanter Lohnartenexport zählt Urlaub über ein Wochenende nur an fünf Arbeitstagen und liefert XLSX", async () => {
  const admin = session("101", "admin");
  db.prepare(`
    INSERT INTO week_options (employee_number, week_start, date_from, date_to, option_type, all_day)
    VALUES ('101', '2026-07-13', '2026-07-13', '2026-07-19', 'vacation', 1)
  `).run();
  const body = {
    dateFrom: "2026-07-13", dateTo: "2026-07-19", locationId, departmentId: null,
    configuration: { layout: "movement_lines", sourceMode: "planned", format: "xlsx" },
  };
  const preflight = await request("/api/integrations/payroll-export/preflight", { method: "POST", auth: admin, body });
  assert.equal(preflight.response.status, 200, JSON.stringify(preflight.payload));
  assert.equal(preflight.payload.blockers.length, 0, JSON.stringify(preflight.payload.blockers));
  assert.equal(preflight.payload.rowCount, 5);
  assert.ok(preflight.payload.sampleRows.every((row) => row.internalCode === "vacation"));

  const exported = await request("/api/integrations/payroll-export/file", {
    method: "POST", auth: admin, raw: true, body: { ...body, fingerprint: preflight.payload.fingerprint },
  });
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get("content-type"), /spreadsheetml/);
  const inspected = await inspectTabularBuffer(exported.payload, { fileName: "lohnarten.xlsx" });
  assert.equal(inspected.sheets[0].rows.length, 6);
  const codeColumn = inspected.sheets[0].rows[0].findIndex((cell) => cell.text === "Interner Code");
  assert.ok(codeColumn >= 0);
  assert.ok(inspected.sheets[0].rows.slice(1).every((row) => row[codeColumn].text === "vacation"));
});

test("v0.63: zeitlich getrennte Teilabwesenheit blockiert geplante Arbeit nicht", async () => {
  const admin = session("101", "admin");
  const date = "2026-07-14";
  db.prepare("INSERT INTO shifts (employee_number, shift_date, start_time, end_time, area) VALUES ('101', ?, '09:00', '12:00', 'Test')").run(date);
  db.prepare(`
    INSERT INTO week_options (employee_number, week_start, date_from, date_to, option_type, all_day, start_time, end_time)
    VALUES ('101', '2026-07-13', ?, ?, 'time_off', 0, '13:00', '15:00')
  `).run(date, date);
  const body = {
    dateFrom: date, dateTo: date, locationId, departmentId: null,
    configuration: { layout: "daily_journal", sourceMode: "planned", format: "csv" },
  };
  const preflight = await request("/api/integrations/payroll-export/preflight", { method: "POST", auth: admin, body });
  assert.equal(preflight.response.status, 200, JSON.stringify(preflight.payload));
  assert.equal(preflight.payload.blockers.some((item) => item.code === "WORK_ABSENCE_OVERLAP"), false);

  db.prepare("UPDATE week_options SET start_time = '11:00', end_time = '14:00'").run();
  const overlap = await request("/api/integrations/payroll-export/preflight", { method: "POST", auth: admin, body });
  assert.ok(overlap.payload.blockers.some((item) => item.code === "WORK_ABSENCE_OVERLAP"));
});

test("v0.63: Abteilungsfilter blendet Urlaub nicht aus der Konfliktprüfung aus", async () => {
  const admin = session("101", "admin");
  const preferredDepartmentId = db.prepare("SELECT preferred_department_id FROM employees WHERE personnel_number = '101'").get().preferred_department_id;
  db.prepare("INSERT OR IGNORE INTO departments (location_id, name, active) VALUES (?, 'Zweitabteilung Exporttest', 1)").run(locationId);
  const secondDepartmentId = db.prepare("SELECT id FROM departments WHERE location_id = ? AND name = 'Zweitabteilung Exporttest'").get(locationId).id;
  assert.notEqual(Number(secondDepartmentId), Number(preferredDepartmentId || 0));
  const date = "2026-07-14";
  db.prepare("INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area) VALUES ('101', ?, ?, '09:00', '17:00', 'Test')")
    .run(secondDepartmentId, date);
  db.prepare(`
    INSERT INTO week_options (employee_number, week_start, date_from, date_to, option_type, all_day)
    VALUES ('101', '2026-07-13', ?, ?, 'vacation', 1)
  `).run(date, date);
  const result = await request("/api/integrations/payroll-export/preflight", {
    method: "POST", auth: admin, body: {
      dateFrom: date, dateTo: date, locationId, departmentId: secondDepartmentId,
      configuration: { layout: "daily_journal", sourceMode: "planned", format: "csv" },
    },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.ok(result.payload.blockers.some((blocker) => blocker.code === "WORK_ABSENCE_OVERLAP"));
});

test("v0.63: Standortexport ordnet fremde Abteilungsdienste nur dem tatsächlichen Standort zu", async () => {
  const admin = session("101", "admin");
  const otherLocationId = "98";
  db.prepare("INSERT OR IGNORE INTO locations (id, name, active) VALUES (?, 'Testfiliale', 1)").run(otherLocationId);
  db.prepare("INSERT OR IGNORE INTO departments (location_id, name, active) VALUES (?, 'Testabteilung', 1)").run(otherLocationId);
  const otherDepartmentId = db.prepare("SELECT id FROM departments WHERE location_id = ? AND active = 1 ORDER BY id LIMIT 1").get(otherLocationId)?.id;
  assert.ok(otherDepartmentId);
  const date = "2026-07-15";
  db.prepare(`
    INSERT INTO employee_location_lendings (
      id, employee_number, home_location_id, destination_location_id,
      destination_department_id, date_from, date_to, all_day, note,
      status, revision, created_by, created_at, updated_by, updated_at
    ) VALUES ('v063-payroll-location-assignment', '101', ?, ?, ?, ?, ?, 1, '',
      'active', 1, 'v063-test', CURRENT_TIMESTAMP, 'v063-test', CURRENT_TIMESTAMP)
  `).run(locationId, otherLocationId, otherDepartmentId, date, date);
  db.prepare("INSERT INTO shifts (employee_number, department_id, shift_date, start_time, end_time, area) VALUES ('101', ?, ?, '09:00', '17:00', 'Aushilfe')")
    .run(otherDepartmentId, date);
  const configuration = { layout: "daily_journal", sourceMode: "planned", format: "csv" };
  const other = await request("/api/integrations/payroll-export/preflight", {
    method: "POST", auth: admin, body: { dateFrom: date, dateTo: date, locationId: otherLocationId, departmentId: null, configuration },
  });
  assert.equal(other.response.status, 200, JSON.stringify(other.payload));
  assert.equal(other.payload.rowCount, 1);
  assert.equal(other.payload.sampleRows[0].personnelNumber, "101");
  assert.equal(other.payload.sampleRows[0].locationId, otherLocationId);

  const home = await request("/api/integrations/payroll-export/preflight", {
    method: "POST", auth: admin, body: { dateFrom: date, dateTo: date, locationId, departmentId: null, configuration },
  });
  assert.equal(home.response.status, 200, JSON.stringify(home.payload));
  assert.equal(home.payload.rowCount, 0);
});

test("v0.63: historische Bewegungen inaktiver Teammitglieder brechen den Export nicht ab", async () => {
  const admin = session("101", "admin");
  const date = "2026-07-16";
  db.prepare("INSERT INTO shifts (employee_number, shift_date, start_time, end_time, area) VALUES ('102', ?, '09:00', '17:00', 'Historisch')").run(date);
  db.prepare("UPDATE employees SET active = 0 WHERE personnel_number = '102'").run();
  const result = await request("/api/integrations/payroll-export/preflight", {
    method: "POST", auth: admin, body: {
      dateFrom: date, dateTo: date, locationId, departmentId: null,
      configuration: { layout: "daily_journal", sourceMode: "planned", format: "csv" },
    },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.rowCount, 1);
  assert.ok(result.payload.warnings.some((warning) => warning.code === "INACTIVE_EMPLOYEE_INCLUDED"));
  assert.ok(result.payload.blockers.some((blocker) => blocker.code === "INACTIVE_EMPLOYMENT_HISTORY_REQUIRED"));
});

test("v0.63: deaktiviertes Integrationsmodul sperrt Personalimport und Lohnexport auch serverseitig", async () => {
  const admin = session("101", "admin");
  const previous = db.prepare("SELECT value FROM settings WHERE key = 'installation_features'").get()?.value || "[]";
  const configured = JSON.parse(previous);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'")
    .run(JSON.stringify(configured.filter((feature) => feature !== "integrations")));

  try {
    assert.deepEqual(installationFeaturesForApiPath("/integrations/personnel-import/catalog"), ["integrations"]);
    assert.deepEqual(installationFeaturesForApiPath("/integrations/payroll-export/catalog"), ["integrations"]);
    assert.deepEqual(installationFeaturesForApiPath("/integrations/profiles"), ["integrations"]);

    for (const route of [
      "/api/integrations/personnel-import/catalog",
      "/api/integrations/payroll-export/catalog",
      "/api/integrations/profiles",
    ]) {
      const result = await request(route, { auth: admin });
      assert.equal(result.response.status, 403, `${route}: ${JSON.stringify(result.payload)}`);
      assert.equal(result.payload.code, "FEATURE_DISABLED");
    }
  } finally {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'installation_features'").run(previous);
  }
});
