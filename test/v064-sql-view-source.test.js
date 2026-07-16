"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  MAX_SQL_VIEW_ROWS,
  MAX_SQL_VIEW_COLUMNS,
  MAX_SQL_VIEW_BYTES,
  SqlViewSourceError,
  normalizeSqlConnectorConfiguration,
  quoteSqlServerIdentifier,
  buildSqlServerViewSelect,
  createSqlServerProvider,
  createSqlViewSource,
} = require("../lib/sql-view-source");

function connector(overrides = {}) {
  return {
    provider: "sqlserver",
    server: "sql.internal.example",
    port: 1433,
    database: "Personnel",
    username: "grabenplaner_reader",
    connectionTimeoutMs: 100,
    queryTimeoutMs: 100,
    ...overrides,
  };
}

const credential = Object.freeze({ password: "read-only-secret" });

function fakeProvider(overrides = {}) {
  const calls = { open: 0, close: 0, listViews: 0, listColumns: 0, readRows: 0 };
  const provider = {
    async open(configuration, credentials) {
      calls.open += 1;
      assert.equal(configuration.providerId, "sqlserver");
      assert.equal(credentials.password, credential.password);
      return { id: calls.open };
    },
    async close() { calls.close += 1; },
    async listViews() {
      calls.listViews += 1;
      return [{ schema: "hr", name: "PersonnelView" }];
    },
    async listColumns() {
      calls.listColumns += 1;
      return [
        { name: "PersonnelNumber", ordinal: 1, dataType: "nvarchar", nullable: false },
        { name: "FullName", ordinal: 2, dataType: "nvarchar", nullable: false },
      ];
    },
    async readRows() {
      calls.readRows += 1;
      return [["007", "Ada Beispiel"]];
    },
    ...overrides,
  };
  return { provider, calls };
}

test("v0.64: SQL-Server-Konfiguration ist eng begrenzt und standardm\u00e4\u00dfig verschl\u00fcsselt", () => {
  const normalized = normalizeSqlConnectorConfiguration(connector({ encrypt: undefined }));
  assert.equal(normalized.encrypt, true);
  assert.equal(normalized.trustServerCertificate, false);
  assert.equal(normalized.port, 1433);
  assert.throws(
    () => normalizeSqlConnectorConfiguration(connector({ server: "https://sql.example" })),
    (error) => error instanceof SqlViewSourceError && error.code === "SQL_CONNECTOR_CONFIGURATION_INVALID",
  );
  assert.throws(
    () => normalizeSqlConnectorConfiguration(connector({ port: 0 })),
    (error) => error.code === "SQL_CONNECTOR_CONFIGURATION_INVALID",
  );
});

test("v0.64: neutraler Connectorvertrag mssql wird ohne Server-Sonderlogik verstanden", async () => {
  let selected;
  const mssql = fakeProvider({
    async open(configuration, credentials) {
      mssql.calls.open += 1;
      assert.equal(configuration.providerId, "mssql");
      assert.equal(credentials.username, "reader");
      return { id: 1 };
    },
    async readRows(_connection, options) {
      mssql.calls.readRows += 1;
      selected = options;
      return [["007"]];
    },
  });
  const source = createSqlViewSource({ providers: { mssql: mssql.provider } });
  const result = await source.readView({
    provider: "mssql",
    host: "sql.internal.example",
    database: "Personnel",
    schemaName: "hr",
    objectName: "PersonnelView",
    tlsMode: "verify_full",
    timeoutMs: 100,
    rowLimit: 25,
  }, { username: "reader", password: credential.password }, { columns: ["PersonnelNumber"] });
  assert.equal(selected.schema, "hr");
  assert.equal(selected.name, "PersonnelView");
  assert.equal(selected.maxRows, 25);
  assert.equal(result.rowCount, 1);
  assert.equal(mssql.calls.close, 1);
});

test("v0.64: SQL-Server-Identifier werden als einzelner Bezeichner sicher geklammert", () => {
  assert.equal(quoteSqlServerIdentifier("Personnel]Archive"), "[Personnel]]Archive]");
  const sql = buildSqlServerViewSelect(
    "hr]; DROP TABLE employees;--",
    "Personnel View",
    ["Personnel]Number", "Full Name"],
    10,
  );
  assert.equal(
    sql,
    "SELECT TOP (11) [Personnel]]Number], [Full Name] FROM [hr]]; DROP TABLE employees;--].[Personnel View]",
  );
  assert.ok(sql.startsWith("SELECT TOP"));
});

test("v0.64: Provider-Interface listet nur bekannte Views und schlie\u00dft jede Verbindung", async () => {
  const { provider, calls } = fakeProvider({
    async listViews() {
      calls.listViews += 1;
      return [
        { schema: "hr", name: "Zulu" },
        { schema: "hr", name: "Alpha" },
        { schema: "HR", name: "alpha" },
      ];
    },
  });
  const source = createSqlViewSource({ providers: { sqlserver: provider } });
  const result = await source.listViews(connector(), credential);
  assert.deepEqual(result.views, [{ schema: "hr", name: "Alpha" }, { schema: "hr", name: "Zulu" }]);
  assert.equal(calls.open, 1);
  assert.equal(calls.close, 1);
});

test("v0.64: nicht gelistete beziehungsweise eingeschleuste Views werden nie gelesen", async () => {
  const { provider, calls } = fakeProvider();
  const source = createSqlViewSource({ providers: { sqlserver: provider } });
  await assert.rejects(
    source.readView(connector(), credential, {
      schema: "hr",
      view: "PersonnelView]; DELETE FROM employees;--",
      columns: ["PersonnelNumber"],
    }),
    (error) => error.code === "SQL_VIEW_NOT_FOUND",
  );
  assert.equal(calls.readRows, 0);
  assert.equal(calls.close, 1);
});

test("v0.64: View-Lesen verwendet nur freigegebene Spalten und normalisiert Textwerte", async () => {
  let readOptions;
  const { provider, calls } = fakeProvider({
    async readRows(_connection, options) {
      calls.readRows += 1;
      readOptions = options;
      return [[" 007 ", " Ada Beispiel \u0001"], [8n, null]];
    },
  });
  const source = createSqlViewSource({ providers: { sqlserver: provider } });
  const result = await source.readView(connector(), credential, {
    schema: "HR",
    view: "personnelview",
    columns: ["personnelNUMBER", "FullName"],
    maxRows: 50,
  });
  assert.deepEqual(readOptions.columns, ["PersonnelNumber", "FullName"]);
  assert.equal(readOptions.maxRows, 50);
  assert.deepEqual(result.rows, [["007", "Ada Beispiel"], ["8", ""]]);
  assert.equal(result.rowCount, 2);
  assert.equal(calls.close, 1);
});

test("v0.64: Spalten- und Zeilenlimits werden vor einer \u00dcbernahme hart abgewiesen", async () => {
  const tooManyColumns = Array.from({ length: MAX_SQL_VIEW_COLUMNS + 1 }, (_, index) => ({
    name: `Column${index + 1}`, ordinal: index + 1, dataType: "nvarchar", nullable: true,
  }));
  const first = fakeProvider({ async listColumns() { first.calls.listColumns += 1; return tooManyColumns; } });
  const firstSource = createSqlViewSource({ providers: { sqlserver: first.provider } });
  await assert.rejects(
    firstSource.listColumns(connector(), credential, { schema: "hr", view: "PersonnelView" }),
    (error) => error.code === "SQL_VIEW_COLUMN_LIMIT" && error.status === 413,
  );
  assert.equal(first.calls.readRows, 0);
  assert.equal(first.calls.close, 1);

  const second = fakeProvider({
    async readRows() {
      second.calls.readRows += 1;
      return Array.from({ length: MAX_SQL_VIEW_ROWS + 1 }, () => ["007"]);
    },
  });
  const secondSource = createSqlViewSource({ providers: { sqlserver: second.provider } });
  await assert.rejects(
    secondSource.readView(connector(), credential, {
      schema: "hr", view: "PersonnelView", columns: ["PersonnelNumber"], maxRows: MAX_SQL_VIEW_ROWS,
    }),
    (error) => error.code === "SQL_VIEW_ROW_LIMIT" && error.status === 413,
  );
  assert.equal(second.calls.close, 1);
});

test("v0.64: SQL-Snapshots werden auch bei alternativen Providern auf 5 MiB begrenzt", async () => {
  const oversized = fakeProvider({
    async listColumns() {
      oversized.calls.listColumns += 1;
      return [{ name: "PersonnelNumber", ordinal: 1, dataType: "nvarchar", nullable: false }];
    },
    async readRows() {
      oversized.calls.readRows += 1;
      return Array.from({ length: Math.ceil(MAX_SQL_VIEW_BYTES / 2_000) + 10 }, () => ["x".repeat(2_000)]);
    },
  });
  const source = createSqlViewSource({ providers: { sqlserver: oversized.provider } });
  await assert.rejects(
    source.readView(connector(), credential, {
      schema: "hr", view: "PersonnelView", columns: ["PersonnelNumber"], maxRows: MAX_SQL_VIEW_ROWS,
    }),
    (error) => error.code === "SQL_VIEW_BYTE_LIMIT" && error.status === 413,
  );
  assert.equal(oversized.calls.close, 1);
});

test("v0.64: SQL-Server bricht einen zu gro\u00dfen Snapshot bereits w\u00e4hrend des row-Events ab", async () => {
  const counters = { emitted: 0, cancelled: 0, closed: 0 };
  class Request extends EventEmitter {
    constructor(sql, callback) {
      super();
      this.sql = sql;
      this.callback = callback;
      this.cancelled = false;
    }
    addParameter() {}
    cancel() {
      this.cancelled = true;
      counters.cancelled += 1;
    }
  }
  class Connection extends EventEmitter {
    connect() { queueMicrotask(() => this.emit("connect", null)); }
    close() { counters.closed += 1; }
    execSql(request) {
      if (request.sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
        request.emit("row", [{ value: "PersonnelNumber" }, { value: 1 }, { value: "nvarchar" }, { value: "NO" }]);
        request.callback(null);
        return;
      }
      if (request.sql.includes("INFORMATION_SCHEMA.VIEWS")) {
        request.emit("row", [{ value: "hr" }, { value: "PersonnelView" }]);
        request.callback(null);
        return;
      }
      request.emit("columnMetadata", [{ colName: "PersonnelNumber", type: { name: "nvarchar" }, nullable: false }]);
      const maximumRows = Math.ceil(MAX_SQL_VIEW_BYTES / 2_000) + 100;
      for (let index = 0; index < maximumRows && !request.cancelled; index += 1) {
        counters.emitted += 1;
        request.emit("row", [{ value: "x".repeat(2_000) }]);
      }
      if (!request.cancelled) request.callback(null);
    }
  }
  const tedious = { Connection, Request, TYPES: { NVarChar: Symbol("NVarChar") } };
  const source = createSqlViewSource({ loadTedious: () => tedious });
  await assert.rejects(
    source.readView(connector({ provider: "mssql", username: undefined }),
      { username: "reader", password: credential.password }, {
        schema: "hr", view: "PersonnelView", columns: ["PersonnelNumber"], maxRows: MAX_SQL_VIEW_ROWS,
      }),
    (error) => error.code === "SQL_VIEW_BYTE_LIMIT" && error.status === 413,
  );
  assert.equal(counters.cancelled, 1);
  assert.ok(counters.emitted < Math.ceil(MAX_SQL_VIEW_BYTES / 2_000) + 100);
  assert.equal(counters.closed, 1);
});

test("v0.64: Abfragezeitlimit bricht den Provider ab und schlie\u00dft die Verbindung", async () => {
  let aborted = false;
  const timed = fakeProvider({
    async readRows(_connection, { signal }) {
      timed.calls.readRows += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  });
  const source = createSqlViewSource({ providers: { sqlserver: timed.provider } });
  await assert.rejects(
    source.readView(connector({ queryTimeoutMs: 20 }), credential, {
      schema: "hr", view: "PersonnelView", columns: ["PersonnelNumber"],
    }),
    (error) => error.code === "SQL_QUERY_TIMEOUT" && error.status === 504,
  );
  assert.equal(aborted, true);
  assert.equal(timed.calls.close, 1);
});

test("v0.64: Providerfehler geben keine Treiber- oder Zugangsdaten nach au\u00dfen und schlie\u00dfen trotzdem", async () => {
  const broken = fakeProvider({
    async listViews() {
      broken.calls.listViews += 1;
      throw new Error(`Login failed for ${credential.password}`);
    },
  });
  const source = createSqlViewSource({ providers: { sqlserver: broken.provider } });
  await assert.rejects(
    source.listViews(connector(), credential),
    (error) => error.code === "SQL_QUERY_FAILED" && !error.message.includes(credential.password),
  );
  assert.equal(broken.calls.close, 1);
});

test("v0.64: SQL-Server-Treiber wird erst bei Verwendung dynamisch geladen", async () => {
  let loads = 0;
  const provider = createSqlServerProvider({
    loadTedious() {
      loads += 1;
      throw new Error("not installed in unit test");
    },
  });
  assert.equal(loads, 0);
  assert.deepEqual(Object.keys(provider).sort(), ["close", "listColumns", "listViews", "open", "readRows"]);
  await assert.rejects(
    provider.open(normalizeSqlConnectorConfiguration(connector()), { username: "reader", password: "secret" }),
    (error) => error.code === "SQL_DRIVER_UNAVAILABLE" && error.status === 503,
  );
  assert.equal(loads, 1);
});
