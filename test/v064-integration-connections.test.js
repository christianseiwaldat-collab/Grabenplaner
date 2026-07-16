"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONNECTION_KINDS,
  CONNECTION_PROVIDERS,
  CONNECTION_LIMITS,
  normalizeIntegrationConnection,
  toPublicIntegrationConnection,
  integrationConnectionCatalog,
} = require("../lib/integration-connections");

function assertCode(action, code) {
  assert.throws(action, (error) => error?.code === code);
}

function sqlInput(overrides = {}) {
  return {
    kind: "personnel_sql_source",
    provider: "mssql",
    name: "Zentrale Personaldaten",
    configuration: {
      host: "SQL01.example.test",
      database: "Personal",
      schemaName: "dbo",
      objectName: "GrabenplanerTeam",
      allowedColumns: ["Personalnummer", "Vorname", "Nachname", "Sollstunden"],
      ...overrides.configuration,
    },
    credentials: { username: "readonly_user", password: "correct horse battery staple" },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "configuration")),
  };
}

function apiInput(overrides = {}) {
  return {
    kind: "payroll_https_target",
    provider: "generic_https_json",
    name: "Lohnverrechnung API",
    configuration: {
      endpoint: "https://payroll.example.test/v1/import",
      authenticationType: "bearer",
      ...overrides.configuration,
    },
    credentials: { token: "secret-bearer-token" },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "configuration")),
  };
}

test("v0.64: Verbindungskatalog definiert ausschließlich freigegebene Kinds, Provider, Auth-Arten und Grenzen", () => {
  const catalog = integrationConnectionCatalog();
  assert.deepEqual(catalog.kinds.map((entry) => entry.id), ["personnel_sql_source", "payroll_https_target"]);
  assert.deepEqual(catalog.providers.map((entry) => entry.id), ["mssql", "generic_https_json"]);
  assert.deepEqual(catalog.kinds[0].authenticationTypes, ["username_password"]);
  assert.deepEqual(catalog.kinds[1].authenticationTypes, ["none", "bearer", "api_key", "basic"]);
  assert.equal(catalog.limits.timeoutMsMin, 1000);
  assert.equal(catalog.limits.timeoutMsMax, 30000);
  assert.equal(catalog.limits.rowLimitMax, 5000);
  assert.equal(CONNECTION_KINDS.personnel_sql_source.direction, "import");
  assert.equal(CONNECTION_PROVIDERS.mssql.defaultPort, 1433);
  assert.ok(Object.isFrozen(CONNECTION_LIMITS));
});

test("v0.64: SQL-Personalquelle normalisiert öffentliche Konfiguration und Credentials strikt getrennt", () => {
  const submitted = sqlInput({
    name: "  Zentrale   Personaldaten  ",
    configuration: {
      host: "SQL01.EXAMPLE.TEST.",
      database: "Personal",
      schemaName: "dbo",
      objectName: "GrabenplanerTeam",
      allowedColumns: ["Personalnummer", "Vorname", "personalnummer", "Sollstunden"],
      objectType: "view",
      tlsMode: "verify_full",
      scope: { locationIds: ["18", "18", "05"], departmentIds: ["hardware"] },
    },
  });
  const normalized = normalizeIntegrationConnection(submitted);

  assert.equal(normalized.name, "Zentrale Personaldaten");
  assert.equal(normalized.direction, "import");
  assert.equal(normalized.purpose, "personnel");
  assert.equal(normalized.configuration.host, "sql01.example.test");
  assert.equal(normalized.configuration.port, 1433);
  assert.equal(normalized.configuration.objectType, "view");
  assert.deepEqual(normalized.configuration.allowedColumns, ["personalnummer", "Vorname", "Sollstunden"]);
  assert.equal(normalized.configuration.tlsMode, "verify_full");
  assert.equal(normalized.configuration.timeoutMs, 10000);
  assert.equal(normalized.configuration.rowLimit, 1000);
  assert.deepEqual(normalized.configuration.scope.locationIds, ["18", "05"]);
  assert.deepEqual(normalized.credentials, submitted.credentials);
  assert.equal(normalized.credentialsConfigured, true);
  assert.doesNotMatch(JSON.stringify(normalized.configuration), /readonly_user|correct horse|password/i);
});

test("v0.64: Geheimnisse außerhalb des Credentials-Objekts werden abgelehnt", () => {
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", database: "Personal", objectName: "Team", password: "leak",
  } })), "INTEGRATION_CONNECTION_PUBLIC_SECRET_FORBIDDEN");
  assertCode(() => normalizeIntegrationConnection({ ...apiInput(), token: "leak" }), "INTEGRATION_CONNECTION_PUBLIC_SECRET_FORBIDDEN");
  assertCode(() => normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/import", authenticationType: "basic", nested: { authorization: "leak" },
  } })), "INTEGRATION_CONNECTION_PUBLIC_SECRET_FORBIDDEN");
});

test("v0.64: SQL-Validierung lehnt unbekannte Provider und unsichere oder übergroße Angaben ab", () => {
  assertCode(() => normalizeIntegrationConnection(sqlInput({ provider: "mysql" })), "INTEGRATION_CONNECTION_PROVIDER_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql/test", database: "Personal", objectName: "Team",
  } })), "INTEGRATION_CONNECTION_SQL_HOST_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", port: 70000, database: "Personal", objectName: "Team",
  } })), "INTEGRATION_CONNECTION_SQL_PORT_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", database: "Personal", objectName: "Team; DROP TABLE users",
  } })), "INTEGRATION_CONNECTION_SQL_OBJECT_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", database: "Personal", objectName: "Team", objectType: "table",
  } })), "INTEGRATION_CONNECTION_SQL_OBJECT_TYPE_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", database: "Personal", objectName: "Team", tlsMode: "disabled",
  } })), "INTEGRATION_CONNECTION_SQL_TLS_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", database: "Personal", objectName: "Team", tlsMode: "encrypted",
  } })), "INTEGRATION_CONNECTION_SQL_TLS_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", database: "Personal", objectName: "Team", timeoutMs: 999,
  } })), "INTEGRATION_CONNECTION_TIMEOUT_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", database: "Personal", objectName: "Team", rowLimit: 5001,
  } })), "INTEGRATION_CONNECTION_ROW_LIMIT_INVALID");
  assertCode(() => normalizeIntegrationConnection(sqlInput({ configuration: {
    host: "sql.example.test", database: "Personal", objectName: "Team", allowedColumns: [],
  } })), "INTEGRATION_CONNECTION_SQL_COLUMNS_INVALID");
});

test("v0.64: bestehende Credentials können bei einer Bearbeitung unverändert geschützt bleiben", () => {
  const input = sqlInput();
  delete input.credentials;
  const normalized = normalizeIntegrationConnection(input, { existingCredentialsConfigured: true });
  assert.equal(normalized.credentials, null);
  assert.equal(normalized.credentialsConfigured, true);

  assertCode(() => normalizeIntegrationConnection(input), "INTEGRATION_CONNECTION_USERNAME_INVALID");
});

test("v0.64: HTTPS-Lohnziel setzt sichere JSON-, Zeit-, Größen- und Idempotenzvorgaben", () => {
  const normalized = normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/v1/import",
    method: "post",
    authenticationType: "bearer",
    timeoutMs: 15000,
    requestLimitBytes: 2 * 1024 * 1024,
    responseLimitBytes: 128 * 1024,
    idempotencyHeader: "X-Import-Id",
    scope: { locationIds: ["18"] },
  } }));
  assert.equal(normalized.direction, "export");
  assert.equal(normalized.purpose, "payroll");
  assert.equal(normalized.configuration.endpoint, "https://payroll.example.test/v1/import");
  assert.equal(normalized.configuration.method, "POST");
  assert.equal(normalized.configuration.payloadFormat, "json");
  assert.equal(normalized.configuration.idempotencyHeader, "Idempotency-Key");
  assert.equal(normalized.configuration.timeoutMs, 15000);
  assert.deepEqual(normalized.credentials, { token: "secret-bearer-token" });
});

test("v0.64: HTTPS-Ziele verbieten unsichere URLs, URL-Secrets, Redirect-Methoden und gefährliche Header", () => {
  for (const endpoint of [
    "http://payroll.example.test/import",
    "https://user:password@payroll.example.test/import",
    "https://payroll.example.test/import?token=secret",
    "https://payroll.example.test/import#secret",
  ]) {
    assertCode(() => normalizeIntegrationConnection(apiInput({ configuration: { endpoint, authenticationType: "bearer" } })),
      "INTEGRATION_CONNECTION_API_ENDPOINT_INVALID");
  }
  assertCode(() => normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/import", method: "PUT", authenticationType: "bearer",
  } })), "INTEGRATION_CONNECTION_API_METHOD_INVALID");
  assertCode(() => normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/import", authenticationType: "oauth2",
  } })), "INTEGRATION_CONNECTION_AUTHENTICATION_INVALID");
  assertCode(() => normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/import", authenticationType: "api_key", apiKeyHeader: "Authorization",
  }, credentials: { apiKey: "a-secure-api-key" } })), "INTEGRATION_CONNECTION_API_KEY_HEADER_INVALID");
  assertCode(() => normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/import", authenticationType: "bearer", requestLimitBytes: 100,
  } })), "INTEGRATION_CONNECTION_REQUEST_LIMIT_INVALID");
});

test("v0.64: alle freigegebenen API-Authentifizierungsarten validieren ihren eigenen Credential-Satz", () => {
  const noAuth = normalizeIntegrationConnection(apiInput({
    configuration: { endpoint: "https://payroll.example.test/import", authenticationType: "none" }, credentials: {},
  }));
  assert.equal(noAuth.credentialsConfigured, false);
  assert.deepEqual(noAuth.credentials, {});

  const apiKey = normalizeIntegrationConnection(apiInput({
    configuration: { endpoint: "https://payroll.example.test/import", authenticationType: "api_key", apiKeyHeader: "X-Partner-Key" },
    credentials: { apiKey: "a-secure-api-key" },
  }));
  assert.equal(apiKey.configuration.apiKeyHeader, "X-Partner-Key");
  assert.equal(apiKey.credentialsConfigured, true);

  const basic = normalizeIntegrationConnection(apiInput({
    configuration: { endpoint: "https://payroll.example.test/import", authenticationType: "basic" },
    credentials: { username: " api-user ", password: "not-a-real-password" },
  }));
  assert.deepEqual(basic.credentials, { username: "api-user", password: "not-a-real-password" });

  assertCode(() => normalizeIntegrationConnection(apiInput({
    configuration: { endpoint: "https://payroll.example.test/import", authenticationType: "none" },
    credentials: { token: "should-not-exist" },
  })), "INTEGRATION_CONNECTION_CREDENTIALS_UNEXPECTED");
  assertCode(() => normalizeIntegrationConnection(apiInput({
    configuration: { endpoint: "https://payroll.example.test/import", authenticationType: "bearer" }, credentials: { token: "short" },
  })), "INTEGRATION_CONNECTION_TOKEN_INVALID");
  assertCode(() => normalizeIntegrationConnection(apiInput({
    configuration: { endpoint: "https://payroll.example.test/import", authenticationType: "bearer" },
    credentials: { token: "valid-bearer-token", password: "unexpected" },
  })), "INTEGRATION_CONNECTION_CREDENTIALS_UNEXPECTED");
});

test("v0.64: Scope-Listen werden dedupliziert und streng begrenzt", () => {
  const normalized = normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/import",
    authenticationType: "bearer",
    scope: { locationIds: ["18", "18", "fil-05"], departmentIds: ["hardware", "foto_welt"] },
  } }));
  assert.deepEqual(normalized.configuration.scope.locationIds, ["18", "fil-05"]);
  assert.deepEqual(normalized.configuration.scope.departmentIds, ["hardware", "foto_welt"]);

  assertCode(() => normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/import", authenticationType: "bearer", scope: { locationIds: ["18/../../"] },
  } })), "INTEGRATION_CONNECTION_SCOPE_INVALID");
  assertCode(() => normalizeIntegrationConnection(apiInput({ configuration: {
    endpoint: "https://payroll.example.test/import", authenticationType: "bearer",
    scope: { locationIds: Array.from({ length: 101 }, (_, index) => String(index)) },
  } })), "INTEGRATION_CONNECTION_SCOPE_INVALID");
});

test("v0.64: API-Response enthält nur redigierte Konfiguration und credentialsConfigured", () => {
  const normalized = normalizeIntegrationConnection(apiInput());
  const response = toPublicIntegrationConnection({
    ...normalized,
    id: "connection-1",
    status: "ready",
    credentials: { token: "must-never-leak" },
    password: "must-never-leak-either",
    configuration: { ...normalized.configuration, password: "hidden-config-secret" },
    lastTestedAt: "2026-07-16T10:00:00.000Z",
  });
  const serialized = JSON.stringify(response);
  assert.equal(response.id, "connection-1");
  assert.equal(response.credentialsConfigured, true);
  assert.equal(response.status, "ready");
  assert.equal("credentials" in response, false);
  assert.doesNotMatch(serialized, /must-never|hidden-config-secret|"password"|"token"/i);
  assert.deepEqual(response.configuration.scope, { locationIds: [], departmentIds: [] });
});

test("v0.64: öffentliche Serialisierung scheitert geschlossen bei manipulierten Endpunkten", () => {
  const normalized = normalizeIntegrationConnection(apiInput());
  assertCode(() => toPublicIntegrationConnection({
    ...normalized,
    configuration: { ...normalized.configuration, endpoint: "https://user:secret@example.test/import" },
  }), "INTEGRATION_CONNECTION_API_ENDPOINT_INVALID");
});

test("v0.64: Normalisierung verändert die übergebenen Objekte nicht", () => {
  const input = sqlInput();
  const snapshot = structuredClone(input);
  normalizeIntegrationConnection(input);
  assert.deepEqual(input, snapshot);
});
