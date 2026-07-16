"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v064-connectors-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const originalHttpsRequest = https.request;
let integrationHttpsRequestCount = 0;
https.request = () => {
  integrationHttpsRequestCount += 1;
  throw new Error("Unerwarteter HTTPS-Transport im v0.64-Server-Test");
};

const subject = require("../server");
const {
  app,
  db,
  minimizedPayrollApiPayload,
  integrationConnectionConfigurationFingerprint,
  revalidateSqlPersonnelPreviewConnection,
  reconcileInterruptedIntegrationDeliveries,
  sqlInspectionFromResult,
  sqlSourceConfiguration,
  releaseInstanceLockForTests,
} = subject;

let server;
let baseUrl;
let sqlConnection;
let apiConnection;

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
  const text = response.status === 204 ? "" : await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  return { response, payload };
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  https.request = originalHttpsRequest;
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.64: Migration legt getrennte Verbindungs- und Zustelltabellen an", () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.64-sql-api-connectors'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_connections'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_deliveries'").get());
  assert.ok(db.prepare("PRAGMA table_info(integration_connections)").all().some((column) => column.name === "revision"));
  const deliveryColumns = new Set(db.prepare("PRAGMA table_info(integration_deliveries)").all().map((column) => column.name));
  assert.ok(deliveryColumns.has("connection_revision"));
  assert.ok(deliveryColumns.has("connection_fingerprint"));
});

test("v0.64: IT-Admin speichert SQL-Zugangsdaten nur verschlüsselt und öffentliche Antworten bleiben redigiert", async () => {
  const itAdmin = session("101", "it_admin");
  const created = await request("/api/integrations/connections", {
    method: "POST",
    auth: itAdmin,
    body: {
      kind: "personnel_sql_source",
      provider: "mssql",
      name: "Freigegebene Personal-View",
      configuration: {
        host: "sql.example.org",
        port: 1433,
        database: "Personal",
        schemaName: "integration",
        objectName: "grabenplaner_personnel",
        allowedColumns: ["personal_number", "first_name", "last_name", "contracted_hours"],
        tlsMode: "verify_full",
        rowLimit: 5000,
      },
      credentials: { username: "grabenplaner_reader", password: "Nur-Lese-Testpasswort!" },
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  sqlConnection = created.payload.connection;
  assert.equal(created.payload.connection.credentialsConfigured, true);
  assert.equal(JSON.stringify(created.payload).includes("Nur-Lese-Testpasswort"), false);
  assert.equal(JSON.stringify(created.payload).includes("grabenplaner_reader"), false);

  const stored = db.prepare("SELECT protected_credentials, configuration_json FROM integration_connections WHERE id = ?")
    .get(created.payload.connection.id);
  assert.match(stored.protected_credentials, /^gp-integration-secret:v1:/);
  assert.doesNotMatch(stored.protected_credentials, /Nur-Lese-Testpasswort|grabenplaner_reader/);
  assert.doesNotMatch(stored.configuration_json, /Nur-Lese-Testpasswort|grabenplaner_reader/);

  const protectedBefore = stored.protected_credentials;
  const updated = await request(`/api/integrations/connections/${created.payload.connection.id}`, {
    method: "PUT",
    auth: itAdmin,
    body: { name: "Personal-View produktiv" },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.ok(updated.payload.connection.revision > created.payload.connection.revision);
  assert.equal(db.prepare("SELECT protected_credentials FROM integration_connections WHERE id = ?").get(created.payload.connection.id).protected_credentials, protectedBefore);

  const admin = session("102", "admin");
  const listed = await request("/api/integrations/connections", { auth: admin });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.connections[0].credentialsConfigured, true);
  assert.equal(JSON.stringify(listed.payload).includes("Nur-Lese-Testpasswort"), false);
});

test("v0.64: unterbrochene API-Zustellungen werden kontrolliert auf unklar gesetzt", () => {
  const deliveryId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO integration_deliveries
      (id, connection_id, idempotency_key, date_from, date_to, location_id, payload_sha256,
       connection_revision, connection_fingerprint, status, actor_employee_number)
    VALUES (?, ?, ?, '2026-07-01', '2026-07-01', '18', ?, 1, ?, 'sending', '101')
  `).run(deliveryId, sqlConnection.id, `gp-test-${crypto.randomBytes(16).toString("hex")}`, "a".repeat(64), "b".repeat(64));
  assert.equal(reconcileInterruptedIntegrationDeliveries(), 1);
  const delivery = db.prepare("SELECT status, error_code, completed_at FROM integration_deliveries WHERE id = ?").get(deliveryId);
  assert.equal(delivery.status, "unknown");
  assert.equal(delivery.error_code, "PROCESS_INTERRUPTED");
  assert.ok(delivery.completed_at);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE entity_id = ? AND action = 'integration.payroll.delivery.recovered'").get(deliveryId));
  db.prepare("DELETE FROM integration_deliveries WHERE id = ?").run(deliveryId);
});

test("v0.64: SQL-Konfiguration reicht Instanznamen durch und zaehlt nur Datenzeilen", () => {
  const configuration = sqlSourceConfiguration({
    public: {
      provider: "mssql",
      configuration: {
        host: "sql.example.org", port: 1433, database: "Personal", instanceName: "HR",
        schemaName: "integration", objectName: "grabenplaner_personnel", tlsMode: "verify_full", timeoutMs: 5000,
      },
    },
  });
  assert.equal(configuration.instanceName, "HR");
  const parsed = sqlInspectionFromResult({
    public: { id: "sql-test", kind: "personnel_sql_source", provider: "mssql", configuration },
  }, {
    view: { schema: "integration", name: "grabenplaner_personnel" },
    columns: [{ name: "PersonnelNumber" }],
    rows: [["007"]],
    rowCount: 1,
    byteSize: 9,
  });
  assert.equal(parsed.summaries[0].rowCount, 1);
  assert.equal(parsed.connectionScopeContext.locationId, "");
  assert.match(parsed.connectionFingerprint, /^[a-f0-9]{64}$/);
});

test("v0.64: SQL-Inspect verlangt globalen Scope und vollstaendigen Connection-Kontext", async () => {
  assert.ok(sqlConnection?.id);
  const manager = session("102", "manager");
  db.prepare("INSERT OR IGNORE INTO portal_permission_grants (employee_number, permission) VALUES (?, ?)")
    .run("102", "employees:import");
  db.prepare("INSERT OR IGNORE INTO portal_permission_grants (employee_number, permission) VALUES (?, ?)")
    .run("102", "integrations:connections:read");
  const deniedScopedActor = await request(`/api/integrations/connections/${sqlConnection.id}/sql/inspect`, {
    method: "POST", auth: manager, body: { defaultLocationId: "18" },
  });
  assert.equal(deniedScopedActor.response.status, 403);
  assert.equal(deniedScopedActor.payload.code, "INTEGRATION_SQL_GLOBAL_SCOPE_REQUIRED");
  db.prepare("DELETE FROM portal_permission_grants WHERE employee_number = ? AND permission IN (?, ?)")
    .run("102", "employees:import", "integrations:connections:read");

  const stored = db.prepare("SELECT configuration_json, last_test_status, last_test_at, last_error_code FROM integration_connections WHERE id = ?").get(sqlConnection.id);
  const scopedConfiguration = JSON.parse(stored.configuration_json);
  scopedConfiguration.scope = { locationIds: ["18"], departmentIds: ["1"] };
  db.prepare("UPDATE integration_connections SET configuration_json = ?, last_test_status = 'ready', last_error_code = '' WHERE id = ?")
    .run(JSON.stringify(scopedConfiguration), sqlConnection.id);
  try {
    const itAdmin = session("101", "it_admin");
    const missingLocation = await request(`/api/integrations/connections/${sqlConnection.id}/sql/inspect`, {
      method: "POST", auth: itAdmin, body: {},
    });
    assert.equal(missingLocation.response.status, 403, JSON.stringify(missingLocation.payload));
    assert.equal(missingLocation.payload.code, "INTEGRATION_CONNECTION_SCOPE_DENIED");
    const missingDepartment = await request(`/api/integrations/connections/${sqlConnection.id}/sql/inspect`, {
      method: "POST", auth: itAdmin, body: { defaultLocationId: "18" },
    });
    assert.equal(missingDepartment.response.status, 403, JSON.stringify(missingDepartment.payload));
    assert.equal(missingDepartment.payload.code, "INTEGRATION_CONNECTION_SCOPE_DENIED");
  } finally {
    db.prepare("UPDATE integration_connections SET configuration_json = ?, last_test_status = ?, last_test_at = ?, last_error_code = ? WHERE id = ?")
      .run(stored.configuration_json, stored.last_test_status, stored.last_test_at, stored.last_error_code, sqlConnection.id);
  }
});

test("v0.64: SQL-Apply verwirft deaktivierte oder nachtraeglich geaenderte Verbindungen", () => {
  assert.ok(sqlConnection?.id);
  const actor = {
    employeeNumber: "101",
    role: "it_admin",
    permissions: ["employees:import", "integrations:connections:read"],
    scopes: [],
  };
  const preview = {
    sourceTransport: "sql_view",
    connectionId: sqlConnection.id,
    connectionFingerprint: integrationConnectionConfigurationFingerprint(sqlConnection),
    connectionScopeContext: { locationId: "", departmentId: "" },
  };
  const stored = db.prepare("SELECT configuration_json, last_test_status, last_test_at, last_error_code FROM integration_connections WHERE id = ?").get(sqlConnection.id);
  db.prepare("UPDATE integration_connections SET last_test_status = 'ready', last_error_code = '' WHERE id = ?").run(sqlConnection.id);
  assert.doesNotThrow(() => revalidateSqlPersonnelPreviewConnection(actor, preview));

  const changed = JSON.parse(stored.configuration_json);
  changed.rowLimit = Number(changed.rowLimit || 1000) === 4999 ? 4998 : 4999;
  db.prepare("UPDATE integration_connections SET configuration_json = ? WHERE id = ?")
    .run(JSON.stringify(changed), sqlConnection.id);
  assert.throws(
    () => revalidateSqlPersonnelPreviewConnection(actor, preview),
    (error) => error.status === 409 && error.code === "INTEGRATION_CONNECTION_CHANGED",
  );
  db.prepare("UPDATE integration_connections SET configuration_json = ? WHERE id = ?")
    .run(stored.configuration_json, sqlConnection.id);

  db.prepare("UPDATE integration_connections SET active = 0 WHERE id = ?").run(sqlConnection.id);
  assert.throws(
    () => revalidateSqlPersonnelPreviewConnection(actor, preview),
    (error) => error.status === 409 && error.code === "INTEGRATION_CONNECTION_CHANGED",
  );
  db.prepare("UPDATE integration_connections SET active = 1, last_test_status = ?, last_test_at = ?, last_error_code = ? WHERE id = ?")
    .run(stored.last_test_status, stored.last_test_at, stored.last_error_code, sqlConnection.id);
});

test("v0.64: Verbindungsverwaltung und sichere Lohnübergabe besitzen getrennte Rechte", async () => {
  const manager = session("102", "manager");
  const deniedCreate = await request("/api/integrations/connections", {
    method: "POST",
    auth: manager,
    body: { kind: "payroll_https_target" },
  });
  assert.equal(deniedCreate.response.status, 403);

  const itAdmin = session("101", "it_admin");
  const target = await request("/api/integrations/connections", {
    method: "POST",
    auth: itAdmin,
    body: {
      kind: "payroll_https_target",
      provider: "generic_https_json",
      name: "Dokumentierte Lohn-API",
      configuration: { endpoint: "https://payroll.example.org/v1/import", authenticationType: "none" },
    },
  });
  assert.equal(target.response.status, 201, JSON.stringify(target.payload));
  apiConnection = target.payload.connection;

  const hr = session("103", "hr");
  const invalidPreflight = await request("/api/integrations/payroll-export/deliver", {
    method: "POST",
    auth: hr,
    body: { connectionId: target.payload.connection.id, dateFrom: "ungültig", dateTo: "ungültig" },
  });
  assert.notEqual(invalidPreflight.response.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM integration_deliveries").get().count, 0);

  const deniedDelivery = await request("/api/integrations/payroll-export/deliver", {
    method: "POST",
    auth: manager,
    body: { connectionId: target.payload.connection.id },
  });
  assert.equal(deniedDelivery.response.status, 403);
});

test("v0.64: direkte API-Uebergabe verwirft Planwerte vor Delivery-Zeile und Transport", async () => {
  assert.ok(apiConnection?.id);
  const hr = session("103", "hr");
  const requestBody = {
    dateFrom: "2026-07-01",
    dateTo: "2026-07-01",
    configuration: {
      sourceMode: "planned",
      layout: "daily_journal",
    },
  };
  const preflight = await request("/api/integrations/payroll-export/preflight", {
    method: "POST",
    auth: hr,
    body: requestBody,
  });
  assert.equal(preflight.response.status, 200, JSON.stringify(preflight.payload));
  assert.equal(preflight.payload.configuration.sourceMode, "planned");
  assert.match(preflight.payload.fingerprint, /^[a-f0-9]{64}$/);

  const deliveriesBefore = db.prepare("SELECT COUNT(*) AS count FROM integration_deliveries").get().count;
  const transportCallsBefore = integrationHttpsRequestCount;
  const rejected = await request("/api/integrations/payroll-export/deliver", {
    method: "POST",
    auth: hr,
    body: {
      ...requestBody,
      connectionId: apiConnection.id,
      fingerprint: preflight.payload.fingerprint,
    },
  });

  assert.equal(rejected.response.status, 422, JSON.stringify(rejected.payload));
  assert.equal(rejected.payload.code, "PAYROLL_DELIVERY_FINAL_VALUES_REQUIRED");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM integration_deliveries").get().count, deliveriesBefore);
  assert.equal(integrationHttpsRequestCount, transportCallsBefore);
});

test("v0.64: API-Nutzdaten entfernen Namen und behalten ausschließlich fachliche Exportspalten", () => {
  const preflight = {
    dateFrom: "2026-07-01",
    dateTo: "2026-07-01",
    context: { locationId: "18", departmentId: null },
    configuration: { sourceMode: "actual_reviewed", layout: "daily_journal" },
    columns: [
      { id: "personnelNumber", label: "Personalnummer", type: "identifier" },
      { id: "fullName", label: "Name", type: "text" },
      { id: "actualMinutes", label: "Ist", type: "number" },
    ],
    rows: [{ personnelNumber: "007", fullName: "Nicht übertragen", actualMinutes: 480 }],
  };
  const payload = minimizedPayrollApiPayload(preflight, "delivery-1", "2026-07-16T10:00:00.000Z");
  assert.deepEqual(payload.columns.map((column) => column.id), ["personnelNumber", "actualMinutes"]);
  assert.deepEqual(payload.rows, [{ personnelNumber: "007", actualMinutes: 480 }]);
  assert.doesNotMatch(JSON.stringify(payload), /Nicht übertragen|fullName/);
});
