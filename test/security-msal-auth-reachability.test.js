"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { integrationConnectionCatalog, normalizeIntegrationConnection } = require("../lib/integration-connections");
const { normalizeSqlConnectorConfiguration, createSqlServerProvider } = require("../lib/sql-view-source");

function sqlInput() {
  return {
    kind: "personnel_sql_source", provider: "mssql", name: "Synthetic read-only source",
    configuration: { host: "sql.example.test", database: "Personnel", objectName: "PersonnelView", allowedColumns: ["PersonnelNumber"] },
    credentials: { username: "fixture_reader", password: "synthetic-password" },
  };
}

test("MSAL reachability: SQL integration exposes only username/password and drops Azure routing fields", () => {
  const source = sqlInput();
  source.configuration.authenticationType = "azure-active-directory-auth-code";
  source.configuration.authentication = { type: "azure-active-directory-default" };
  source.configuration.cloud_instance_host_name = "attacker.example.test";
  source.configuration.authority = "https://attacker.example.test";
  const normalized = normalizeIntegrationConnection(source);
  const kind = integrationConnectionCatalog().kinds.find((entry) => entry.id === "personnel_sql_source");
  assert.deepEqual(kind.authenticationTypes, ["username_password"]);
  for (const key of ["authenticationType", "authentication", "cloud_instance_host_name", "authority"]) {
    assert.equal(Object.hasOwn(normalized.configuration, key), false);
  }
  assert.deepEqual(normalized.credentials, { username: "fixture_reader", password: "synthetic-password" });
});

test("MSAL reachability: authorization codes and tokens are rejected as SQL credentials", () => {
  for (const key of ["code", "auth_code", "accessToken", "clientSecret", "cloud_instance_host_name"]) {
    const source = sqlInput();
    source.credentials[key] = "synthetic-untrusted-value";
    assert.throws(() => normalizeIntegrationConnection(source), (error) => error.code === "INTEGRATION_CONNECTION_CREDENTIALS_UNEXPECTED");
  }
});

test("MSAL reachability: the actual Tedious adapter always constructs default SQL authentication", async () => {
  const captured = [];
  class Connection extends EventEmitter {
    constructor(configuration) { super(); captured.push(configuration); }
    connect() { queueMicrotask(() => this.emit("connect")); }
    close() { this.closed = true; }
  }
  const provider = createSqlServerProvider({ loadTedious: () => ({ Connection, Request: class Request {}, TYPES: { NVarChar: {} } }) });
  const configuration = { ...normalizeSqlConnectorConfiguration({ provider: "sqlserver", server: "sql.example.test", database: "Personnel" }) };
  // Even a caller bypassing the public DTO cannot forward Azure/MSAL options.
  configuration.authentication = { type: "azure-active-directory-auth-code", options: { code: "synthetic" } };
  configuration.cloud_instance_host_name = "attacker.example.test";
  const connection = await provider.open(configuration, {
    username: "fixture_reader", password: "synthetic-password", authenticationType: "azure-active-directory-default", code: "synthetic",
  });
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].authentication, { type: "default", options: { userName: "fixture_reader", password: "synthetic-password" } });
  assert.equal(Object.hasOwn(captured[0], "cloud_instance_host_name"), false);
  assert.equal(Object.hasOwn(captured[0].options, "authority"), false);
  await provider.close(connection);
  assert.equal(connection.closed, true);
});
