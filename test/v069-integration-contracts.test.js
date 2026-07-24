"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-v069-integrations-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.GRABENPLANER_FORCE_PORTAL = "1";
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const { CONTRACT_IDS, contractById, contractSha256, contractSummaries } = require("../lib/integration-contracts");
const { normalizeIntegrationConnection } = require("../lib/integration-connections");
const { normalizeProfileConfiguration } = require("../lib/personnel-import");
const subject = require("../server");
const {
  app,
  db,
  assertPersonnelImportProfileSource,
  installationFeaturesForApiPath,
  releaseInstanceLockForTests,
} = subject;

let server;
let baseUrl;

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
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch {}
  releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("v0.69: Verträge sind versioniert, stabil gehasht und auf notwendige Daten begrenzt", () => {
  const summaries = contractSummaries();
  assert.deepEqual(summaries.map((entry) => entry.id), [
    CONTRACT_IDS.personnelSqlView,
    CONTRACT_IDS.payrollHttpsJson,
    CONTRACT_IDS.payrollPeriodHandoff,
  ]);
  for (const summary of summaries) {
    const contract = contractById(summary.id);
    assert.equal(summary.sha256, contractSha256(contract));
    assert.match(summary.sha256, /^[a-f0-9]{64}$/);
  }
  const personnel = contractById(CONTRACT_IDS.personnelSqlView);
  assert.equal(personnel.sourceRequirements.directWrites, false);
  assert.equal(personnel.sourceRequirements.humanConfirmationRequired, true);
  assert.deepEqual(personnel.fields.filter((field) => field.required).map((field) => field.id), ["personnelNumber", "fullName"]);
  const allowedPersonnelFields = new Set(personnel.fields.map((field) => field.id));
  for (const sensitive of ["bankAccount", "socialSecurityNumber", "address", "phone", "password", "role", "amu"]) {
    assert.equal(allowedPersonnelFields.has(sensitive), false);
  }
  const payroll = contractById(CONTRACT_IDS.payrollHttpsJson);
  assert.equal(payroll.jsonSchema.properties.schema.const, CONTRACT_IDS.payrollHttpsJson);
  assert.equal(payroll.deliveryRequirements.finalReviewedValuesOnly, true);
  assert.equal(payroll.deliveryRequirements.redirects, false);
});

test("v0.69: Verbindungen sind fest an den passenden Vertrag gebunden", () => {
  const sql = normalizeIntegrationConnection({
    kind: "personnel_sql_source",
    provider: "mssql",
    name: "Personal-View",
    configuration: {
      host: "sql.example.org",
      database: "Personnel",
      schemaName: "integration",
      objectName: "grabenplaner_personnel",
      allowedColumns: ["personnel_number", "full_name"],
    },
    credentials: { username: "reader", password: "secret" },
  });
  assert.equal(sql.configuration.contractId, CONTRACT_IDS.personnelSqlView);
  assert.throws(() => normalizeIntegrationConnection({
    kind: "payroll_https_target",
    provider: "generic_https_json",
    name: "Lohn-API",
    configuration: { endpoint: "https://payroll.example.org/v1/import", contractId: CONTRACT_IDS.personnelSqlView },
    credentials: {},
  }), { code: "INTEGRATION_CONNECTION_CONTRACT_INVALID" });
});

test("v0.69: SQL-Importprofile bewahren Quellenart, Verbindung und Vertrag", () => {
  const profile = normalizeProfileConfiguration({
    sourceType: "sql",
    connectionId: "connection-17",
    format: "csv",
    mapping: { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 } },
  });
  assert.equal(profile.version, 2);
  assert.equal(profile.sourceType, "sql");
  assert.equal(profile.connectionId, "connection-17");
  assert.equal(profile.contractId, CONTRACT_IDS.personnelSqlView);
  assert.throws(() => normalizeProfileConfiguration({ sourceType: "sql", connectionId: "" }), { message: "IMPORT_PROFILE_SQL_CONNECTION_REQUIRED" });
  assert.throws(() => assertPersonnelImportProfileSource({ configuration: profile }, {
    sourceTransport: "sql_view",
    connectionId: "connection-18",
  }), { code: "INTEGRATION_PROFILE_CONNECTION_MISMATCH" });
});

test("v0.69: Vertrags-API ist geschützt und liefert prüfbare JSON-Dokumente", async () => {
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v0.69-integration-contracts'").get());
  assert.deepEqual(installationFeaturesForApiPath("/integrations/contracts"), ["integrations"]);
  const employee = session("102", "employee");
  const denied = await request("/api/integrations/contracts", { auth: employee });
  assert.equal(denied.response.status, 403);

  const itAdmin = session("101", "it_admin");
  const list = await request("/api/integrations/contracts", { auth: itAdmin });
  assert.equal(list.response.status, 200);
  assert.equal(list.payload.contracts.length, 3);
  assert.ok(list.payload.contracts.every((contract) => contract.documentUrl.endsWith("?download=1")));

  const downloaded = await request(`/api/integrations/contracts/${encodeURIComponent(CONTRACT_IDS.payrollHttpsJson)}?download=1`, { auth: itAdmin });
  assert.equal(downloaded.response.status, 200);
  assert.match(downloaded.response.headers.get("content-disposition"), /attachment/);
  assert.equal(downloaded.payload.contract.id, CONTRACT_IDS.payrollHttpsJson);
  assert.equal(downloaded.payload.documentSha256, contractSha256(downloaded.payload.contract));
});

test("v0.69: Server und Oberfläche bieten wiederverwendbare SQL-Profile", async () => {
  const itAdmin = session("101", "it_admin");
  const created = await request("/api/integrations/profiles", {
    method: "POST",
    auth: itAdmin,
    body: {
      direction: "import",
      kind: "personnel",
      name: "Personal-View Zentrale",
      configuration: {
        sourceType: "sql",
        connectionId: "connection-17",
        format: "csv",
        headerRow: 1,
        mapping: { personnelNumber: { columnIndex: 0 }, fullName: { columnIndex: 1 } },
      },
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.profile.configuration.sourceType, "sql");
  assert.equal(created.payload.profile.configuration.connectionId, "connection-17");
  assert.equal(created.payload.profile.configuration.contractId, CONTRACT_IDS.personnelSqlView);

  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(html, /Schnittstellenverträge/);
  assert.match(client, /data-use-integration-profile/);
  assert.match(client, /data-download-integration-contract/);
});
