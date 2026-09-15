"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  PERSISTENCE_ERROR_CODES,
  definePersistenceStatement,
} = require("../lib/persistence/contract");
const {
  POSTGRESQL_CAPABILITIES,
  createPostgresqlPersistenceProvider,
  mapPostgresqlError,
} = require("../lib/persistence/postgresql/provider");

function hasPersistenceCode(code) {
  return (error) => error?.code === code;
}

test('pg client read timeout without SQLSTATE stays retryable for import recovery, unknown errors stay closed',()=>{
  assert.equal(mapPostgresqlError(new Error('Query read timeout')).code,PERSISTENCE_ERROR_CODES.TIMEOUT);
  assert.equal(mapPostgresqlError(new Error('some query timeout in application code')).code,PERSISTENCE_ERROR_CODES.UNKNOWN);
  const sourceError=Object.assign(new Error('Query read timeout'),{code:'23514'});
  assert.equal(mapPostgresqlError(sourceError).code,PERSISTENCE_ERROR_CODES.CHECK_VIOLATION);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function timeoutAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
  });
}

function createFakeClient(queryHandler = () => ({ rowCount: null, rows: [] })) {
  const queries = [];
  const releases = [];
  return {
    client: {
      async query(configuration) {
        queries.push(configuration);
        return queryHandler(configuration, queries.length - 1);
      },
      release(...argumentsList) {
        releases.push(argumentsList);
      },
    },
    queries,
    releases,
  };
}

function createFakePool({
  connect,
  end,
  queryHandler,
} = {}) {
  const events = new EventEmitter();
  const state = {
    clients: [],
    connectCalls: 0,
    endCalls: 0,
  };
  const pool = {
    async connect() {
      state.connectCalls += 1;
      if (connect) return connect(state.connectCalls);
      const fixture = createFakeClient(queryHandler);
      state.clients.push(fixture);
      return fixture.client;
    },
    async end() {
      state.endCalls += 1;
      if (end) return end(state.endCalls);
      return undefined;
    },
    on: events.on.bind(events),
    off: events.off.bind(events),
  };
  return {
    emit: events.emit.bind(events),
    listenerCount: events.listenerCount.bind(events),
    pool,
    state,
  };
}

function resultFields(...names) {
  return names.map((name) => ({ name }));
}

const VALUE_COLUMNS = Object.freeze({
  id: "safe_integer",
  enabled: "boolean",
  largeValue: "bigint_string",
  amount: "decimal_string",
  createdAt: "utc_timestamp",
  businessDate: "date",
  clockTime: "time",
  metadata: "json",
  payload: "bytes",
});
const VALUE_STATEMENTS = Object.freeze({
  insert: definePersistenceStatement({
    id: "postgresql-provider-values.insert",
    operation: "execute",
    parameters: {
      ...VALUE_COLUMNS,
    },
    columns: VALUE_COLUMNS,
  }),
  get: definePersistenceStatement({
    id: "postgresql-provider-values.get",
    operation: "queryOne",
    parameters: {
      id: "safe_integer",
      note: { kind: "text", optional: true },
    },
    columns: VALUE_COLUMNS,
  }),
  update: definePersistenceStatement({
    id: "postgresql-provider-values.update",
    operation: "execute",
    parameters: { id: "safe_integer" },
  }),
});
const INSERT_PARAMETER_ORDER = Object.freeze([
  "metadata",
  "payload",
  "id",
  "enabled",
  "largeValue",
  "amount",
  "createdAt",
  "businessDate",
  "clockTime",
]);
const VALUE_RESULT_FIELDS = Object.freeze(resultFields(...Object.keys(VALUE_COLUMNS)));
const VALUE_CATALOG = Object.freeze([
  Object.freeze({
    statement: VALUE_STATEMENTS.insert,
    sql: `
      INSERT INTO provider_values (
        metadata,
        payload,
        id,
        enabled,
        large_value,
        amount,
        created_at,
        business_date,
        clock_time
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id,
        enabled,
        large_value,
        amount,
        created_at,
        business_date,
        clock_time,
        metadata,
        payload
    `,
    parameterOrder: INSERT_PARAMETER_ORDER,
    returning: true,
  }),
  Object.freeze({
    statement: VALUE_STATEMENTS.get,
    sql: `
      SELECT
        id,
        enabled,
        large_value,
        amount,
        created_at,
        business_date,
        clock_time,
        metadata,
        payload
      FROM provider_values
      WHERE id = $1 AND ($2::text IS NULL OR note = $2)
    `,
    parameterOrder: Object.freeze(["id", "note"]),
    returning: false,
  }),
  Object.freeze({
    statement: VALUE_STATEMENTS.update,
    sql: "UPDATE provider_values SET enabled = TRUE WHERE id = $1",
    parameterOrder: Object.freeze(["id"]),
    returning: false,
  }),
]);

function rawValueRow({
  id = "7",
  metadata = JSON.stringify({ nested: [true, null, 7] }),
  payload = Uint8Array.from([1, 2, 3, 4]),
} = {}) {
  return [
    id,
    true,
    9007199254740993n,
    "1234567890.012300",
    new Date("2026-07-29T12:34:56.789Z"),
    new Date("2026-07-29T00:00:00.000Z"),
    "14:34:56",
    metadata,
    payload,
  ];
}

test("v0.87 DB Block 5: PostgreSQL bindet Vertragstypen positionsgenau und normalisiert Array-Zeilen", async () => {
  let statementConfiguration;
  const fixture = createFakePool({
    queryHandler(configuration) {
      if (typeof configuration === "string") return { rowCount: null, rows: [] };
      statementConfiguration = configuration;
      return {
        rowCount: 1,
        rows: [rawValueRow()],
        fields: VALUE_RESULT_FIELDS,
      };
    },
  });
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: VALUE_CATALOG,
  });
  const sourcePayload = Buffer.from([1, 2, 3, 4]);
  const metadata = { nested: [true, null, 7] };

  try {
    const result = await provider.execute(VALUE_STATEMENTS.insert, {
      id: 7,
      enabled: true,
      largeValue: 9007199254740993n,
      amount: "1234567890.012300",
      createdAt: new Date("2026-07-29T12:34:56.789Z"),
      businessDate: "2026-07-29",
      clockTime: "14:34:56",
      metadata,
      payload: sourcePayload,
    });

    assert.equal(statementConfiguration.rowMode, "array");
    assert.match(statementConfiguration.text, /VALUES\s*\(\$1, \$2, \$3/);
    assert.deepEqual(statementConfiguration.values, [
      JSON.stringify(metadata),
      sourcePayload,
      7,
      true,
      "9007199254740993",
      "1234567890.012300",
      "2026-07-29T12:34:56.789Z",
      "2026-07-29",
      "14:34:56",
    ]);
    assert.notEqual(statementConfiguration.values[1], sourcePayload);
    assert.deepEqual(result, {
      rowsAffected: 1,
      returnedRows: [{
        id: 7,
        enabled: true,
        largeValue: "9007199254740993",
        amount: "1234567890.012300",
        createdAt: "2026-07-29T12:34:56.789Z",
        businessDate: "2026-07-29",
        clockTime: "14:34:56",
        metadata,
        payload: sourcePayload,
      }],
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.returnedRows), true);
    assert.equal(Object.isFrozen(result.returnedRows[0]), true);
    assert.equal(Object.isFrozen(result.returnedRows[0].metadata), true);
    assert.notEqual(result.returnedRows[0].payload, sourcePayload);
    assert.deepEqual(fixture.state.clients[0].queries, [
      "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
      statementConfiguration,
      "COMMIT",
    ]);
    assert.deepEqual(fixture.state.clients[0].releases, [[]]);
  } finally {
    await provider.close();
  }
});

test("v0.87 DB Block 5: optionale Parameter werden als NULL gebunden und Leseoperationen bleiben READ ONLY", async () => {
  let statementConfiguration;
  const fixture = createFakePool({
    queryHandler(configuration) {
      if (typeof configuration === "string") return { rowCount: null, rows: [] };
      statementConfiguration = configuration;
      return {
        rowCount: 1,
        rows: [rawValueRow()],
        fields: VALUE_RESULT_FIELDS,
      };
    },
  });
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: VALUE_CATALOG,
  });

  try {
    assert.equal((await provider.queryOne(VALUE_STATEMENTS.get, { id: 7 })).id, 7);
    assert.deepEqual(statementConfiguration.values, [7, null]);
    assert.equal(statementConfiguration.rowMode, "array");
    assert.deepEqual(fixture.state.clients[0].queries, [
      "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
      statementConfiguration,
      "COMMIT",
    ]);
    assert.deepEqual(fixture.state.clients[0].releases, [[]]);
  } finally {
    await provider.close();
  }
});

test("v0.87 DB Block 5: JSON-Pfadbindungen vervielfachen Parameter ohne Raw-JSON-Zugriff der Fachlogik", async () => {
  const jsonStatement = definePersistenceStatement({
    id: "postgresql-provider-json-bindings.get",
    operation: "queryOne",
    parameters: {
      direct: "text",
      payload: "json",
    },
    columns: { data: "json" },
  });
  let statementConfiguration;
  const fixture = createFakePool({
    queryHandler(configuration) {
      if (typeof configuration === "string") return { rowCount: null, rows: [] };
      statementConfiguration = configuration;
      return {
        rowCount: 1,
        rows: [[{ accepted: true }]],
        fields: resultFields("data"),
      };
    },
  });
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: [{
      statement: jsonStatement,
      sql: `
        SELECT jsonb_build_object('accepted', TRUE) AS data
        WHERE $1::bigint = 7
          AND $2::bigint = 1
          AND $3::text IS NULL
          AND $4::jsonb IS NOT NULL
          AND $5::text = 'object'
          AND $6::jsonb = '[1,true]'::jsonb
          AND $7::text = 'direct'
      `,
      parameterOrder: ["direct", "payload"],
      parameterBindings: [
        { parameter: "payload", source: "json-extract", path: ["nested", "value"] },
        { parameter: "payload", source: "json-extract", path: ["active"] },
        { parameter: "payload", source: "json-extract", path: ["missing"] },
        { parameter: "payload", source: "json-extract", path: [] },
        { parameter: "payload", source: "json-type", path: [] },
        { parameter: "payload", source: "json-extract", path: ["items"] },
        { parameter: "direct", source: "value", path: [] },
      ],
      returning: false,
    }],
  });
  const payload = {
    active: true,
    items: [1, true],
    nested: { value: 7 },
  };

  try {
    assert.deepEqual(await provider.queryOne(jsonStatement, {
      direct: "direct",
      payload,
    }), { data: { accepted: true } });
    assert.deepEqual(statementConfiguration.values, [
      7,
      1,
      null,
      JSON.stringify(payload),
      "object",
      JSON.stringify([1, true]),
      "direct",
    ]);
    assert.equal(statementConfiguration.values.includes(payload), false);
  } finally {
    await provider.close();
  }
});

test("v0.87 DB Block 5: SQLSTATE- und Treiberfehler werden stabil und ohne Secrets normalisiert", () => {
  const mappings = [
    ["23505", PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION, false],
    ["23P01", PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION, false],
    ["23503", PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION, false],
    ["23502", PERSISTENCE_ERROR_CODES.NOT_NULL_VIOLATION, false],
    ["23514", PERSISTENCE_ERROR_CODES.CHECK_VIOLATION, false],
    ["40001", PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION, true],
    ["40P01", PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION, true],
    ["55P03", PERSISTENCE_ERROR_CODES.BUSY, true],
    ["57014", PERSISTENCE_ERROR_CODES.TIMEOUT, false],
    ["ABORT_ERR", PERSISTENCE_ERROR_CODES.ABORTED, false],
    ["08006", PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE, false],
    ["ECONNREFUSED", PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE, false],
    ["25006", PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, false],
    ["42601", PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, false],
    ["42P01", PERSISTENCE_ERROR_CODES.SCHEMA_INVALID, false],
    ["XX999", PERSISTENCE_ERROR_CODES.UNKNOWN, false],
  ];

  for (const [driverCode, expectedCode, retryable] of mappings) {
    const source = Object.assign(new Error("postgres://admin:SEHR-GEHEIM@db/private"), {
      code: driverCode,
      detail: "token=SEHR-GEHEIM",
      query: "SELECT 'SEHR-GEHEIM'",
    });
    const mapped = mapPostgresqlError(source, { operation: "query" });
    const visible = [
      String(mapped),
      JSON.stringify(mapped),
      JSON.stringify(mapped.cause),
      mapped.stack,
    ].join("\n");
    assert.equal(mapped.code, expectedCode, driverCode);
    assert.equal(mapped.retryable, retryable, driverCode);
    assert.equal(mapped.operation, "query", driverCode);
    assert.deepEqual(mapped.cause, { name: "Error" }, driverCode);
    assert.equal(visible.includes("SEHR-GEHEIM"), false, driverCode);
    assert.equal(visible.includes("postgres://"), false, driverCode);
    assert.equal(Object.isFrozen(mapped), true, driverCode);
  }

  const abort = mapPostgresqlError(
    Object.assign(new Error("SEHR-GEHEIM"), { name: "AbortError" }),
    { operation: "execute" },
  );
  assert.equal(abort.code, PERSISTENCE_ERROR_CODES.ABORTED);
  assert.deepEqual(abort.cause, { name: "AbortError" });
});

test("v0.87 DB Block 5: Poolfehler werden beobachtet, sanitisiert und beim Schließen abgemeldet", async () => {
  const observed = [];
  const fixture = createFakePool();
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: [],
    onPoolError(error) {
      observed.push(error);
      throw new Error("Diagnose darf den Provider nicht beschädigen");
    },
  });

  assert.equal(fixture.listenerCount("error"), 1);
  fixture.emit("error", Object.assign(new Error("Passwort SEHR-GEHEIM"), {
    code: "57P01",
  }));
  assert.equal(observed.length, 1);
  assert.equal(observed[0].code, PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE);
  assert.equal(JSON.stringify(observed[0]).includes("SEHR-GEHEIM"), false);

  await provider.close();
  assert.equal(fixture.listenerCount("error"), 0);
  assert.equal(fixture.state.endCalls, 0);
});

test("v0.87 DB Block 5: BEGIN-Modi, COMMIT, fachlicher ROLLBACK und Release sind deterministisch", async () => {
  const fixture = createFakePool({
    queryHandler(configuration) {
      if (typeof configuration === "string") return { rowCount: null, rows: [] };
      if (/^SELECT\b/.test(configuration.text.trim())) {
        return {
          rowCount: 1,
          rows: [rawValueRow()],
          fields: VALUE_RESULT_FIELDS,
        };
      }
      return { rowCount: 1, rows: [], fields: [] };
    },
  });
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: VALUE_CATALOG,
  });

  try {
    const committed = await provider.transaction(async (transaction) => {
      const row = await transaction.queryOne(VALUE_STATEMENTS.get, { id: 7 });
      await assert.rejects(
        transaction.execute(VALUE_STATEMENTS.update, { id: 7 }),
        hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
      );
      return row.id;
    }, {
      isolation: "serializable",
      readOnly: true,
    });
    assert.equal(committed, 7);
    assert.deepEqual(fixture.state.clients[0].queries.map((entry) => (
      typeof entry === "string" ? entry : entry.text.trim().split(/\s+/).slice(0, 2).join(" ")
    )), [
      "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY",
      "SELECT id,",
      "COMMIT",
    ]);
    assert.deepEqual(fixture.state.clients[0].releases, [[undefined]]);

    const primaryError = new Error("fachlicher Abbruch");
    await assert.rejects(
      provider.transaction(async (transaction) => {
        await transaction.execute(VALUE_STATEMENTS.update, { id: 7 });
        throw primaryError;
      }),
      (error) => error === primaryError,
    );
    assert.deepEqual(fixture.state.clients[1].queries.map((entry) => (
      typeof entry === "string" ? entry : entry.text
    )), [
      "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
      VALUE_CATALOG[2].sql,
      "ROLLBACK",
    ]);
    assert.deepEqual(fixture.state.clients[1].releases, [[undefined]]);
  } finally {
    await provider.close();
  }
});

test("v0.87 DB Block 5: Commitfehler wird normalisiert, danach zurückgerollt und freigegeben", async () => {
  const commitError = Object.assign(new Error("SEHR-GEHEIM"), { code: "40001" });
  const fixture = createFakePool({
    queryHandler(configuration) {
      if (configuration === "COMMIT") throw commitError;
      return { rowCount: null, rows: [] };
    },
  });
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: [],
  });

  try {
    await assert.rejects(
      provider.transaction(async () => "done"),
      (error) => {
        assert.equal(error?.code, PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION);
        assert.equal(JSON.stringify(error).includes("SEHR-GEHEIM"), false);
        return true;
      },
    );
    assert.deepEqual(fixture.state.clients[0].queries, [
      "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
      "COMMIT",
      "ROLLBACK",
    ]);
    assert.deepEqual(fixture.state.clients[0].releases, [[undefined]]);
  } finally {
    await provider.close();
  }
});

test("v0.87 DB Block 5: concurrentWrites erlaubt zwei gleichzeitig aktive Transaktionen", async () => {
  const fixture = createFakePool();
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: [],
  });
  const bothEntered = deferred();
  const releaseWork = deferred();
  let entered = 0;

  function transaction(identifier) {
    return provider.transaction(async () => {
      entered += 1;
      if (entered === 2) bothEntered.resolve();
      await releaseWork.promise;
      return identifier;
    });
  }

  const first = transaction("first");
  const second = transaction("second");
  let concurrencyError;
  try {
    await Promise.race([
      bothEntered.promise,
      timeoutAfter(500, "PostgreSQL-Transaktionen wurden unerwartet serialisiert."),
    ]);
    assert.equal(provider.getCapabilities().features.concurrentWrites, true);
    assert.equal(fixture.state.connectCalls, 2);
    assert.equal(fixture.state.clients.length, 2);
  } catch (error) {
    concurrencyError = error;
  } finally {
    releaseWork.resolve();
  }
  const results = await Promise.all([first, second]);
  if (concurrencyError) throw concurrencyError;

  assert.deepEqual(results, ["first", "second"]);
  for (const client of fixture.state.clients) {
    assert.deepEqual(client.queries, [
      "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
      "COMMIT",
    ]);
    assert.deepEqual(client.releases, [[undefined]]);
  }
  await provider.close();
});

test("v0.87 DB Block 5: Pool-Lebenszyklus respektiert externe und Provider-Eigentümerschaft", async () => {
  const external = createFakePool();
  const externalProvider = createPostgresqlPersistenceProvider({
    pool: external.pool,
    catalog: [],
    poolOwnership: "external",
  });
  await externalProvider.close();
  await externalProvider.close();
  assert.equal(external.state.endCalls, 0);

  const owned = createFakePool();
  const ownedProvider = createPostgresqlPersistenceProvider({
    pool: owned.pool,
    catalog: [],
    poolOwnership: "provider",
  });
  await Promise.all([ownedProvider.close(), ownedProvider.close()]);
  assert.equal(owned.state.endCalls, 1);
  await assert.rejects(
    ownedProvider.queryAll(VALUE_STATEMENTS.get, { id: 7 }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.PROVIDER_CLOSED),
  );

  const closeFailure = createFakePool({
    end() {
      throw Object.assign(new Error("SEHR-GEHEIM"), { code: "ECONNRESET" });
    },
  });
  const failingProvider = createPostgresqlPersistenceProvider({
    pool: closeFailure.pool,
    catalog: [],
    poolOwnership: "provider",
  });
  await assert.rejects(
    failingProvider.close(),
    (error) => {
      assert.equal(error?.code, PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE);
      assert.equal(JSON.stringify(error).includes("SEHR-GEHEIM"), false);
      return true;
    },
  );
  assert.equal(closeFailure.state.endCalls, 1);
});

test("v0.87 DB Block 5: Acquire-Timeout zerstört einen verspätet eintreffenden Client", async () => {
  const pendingClient = deferred();
  const lateClient = createFakeClient();
  const fixture = createFakePool({
    connect() {
      return pendingClient.promise;
    },
  });
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: VALUE_CATALOG,
    acquireTimeoutMilliseconds: 100,
  });

  const query = provider.queryOne(VALUE_STATEMENTS.get, { id: 7 });
  await assert.rejects(
    query,
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.TIMEOUT),
  );
  assert.deepEqual(lateClient.releases, []);

  pendingClient.resolve(lateClient.client);
  await Promise.race([
    new Promise((resolve) => setImmediate(resolve)),
    timeoutAfter(250, "Der verspätete Client wurde nicht verarbeitet."),
  ]);
  assert.deepEqual(lateClient.releases, [[true]]);
  assert.deepEqual(lateClient.queries, []);
  await provider.close();
});

test("v0.87 DB Block 5: PostgreSQL-Feldnamen und -reihenfolge werden vor der Zuordnung geprüft", async () => {
  const orderedStatement = definePersistenceStatement({
    id: "postgresql-provider.field-order",
    operation: "queryOne",
    columns: {
      id: "text",
      note: "text",
    },
  });
  const fixture = createFakePool({
    queryHandler(configuration) {
      if (typeof configuration === "string") return { rowCount: null, rows: [] };
      return {
        rowCount: 1,
        rows: [["note-value", "id-value"]],
        fields: resultFields("note", "id"),
      };
    },
  });
  const provider = createPostgresqlPersistenceProvider({
    pool: fixture.pool,
    catalog: [{
      statement: orderedStatement,
      sql: "SELECT note, id FROM records",
      parameterOrder: [],
      returning: false,
    }],
  });

  try {
    await assert.rejects(
      provider.queryOne(orderedStatement),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.RESULT_INVALID),
    );
    assert.deepEqual(fixture.state.clients[0].queries.map((entry) => (
      typeof entry === "string" ? entry : entry.text
    )), [
      "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
      "SELECT note, id FROM records",
      "ROLLBACK",
    ]);
  } finally {
    await provider.close();
  }
});

test("v0.87 DB Block 5: ungültige PostgreSQL-Kataloge scheitern vor der ersten Verbindung", () => {
  const fixture = createFakePool();
  const query = definePersistenceStatement({
    id: "postgresql-provider.invalid-query",
    operation: "queryOne",
    parameters: { id: "safe_integer" },
    columns: { value: "text" },
  });
  const execute = definePersistenceStatement({
    id: "postgresql-provider.invalid-execute",
    operation: "execute",
    parameters: { id: "safe_integer" },
  });
  const returningExecute = definePersistenceStatement({
    id: "postgresql-provider.invalid-returning-execute",
    operation: "execute",
    parameters: { id: "safe_integer" },
    columns: { id: "safe_integer" },
  });
  const validQuery = {
    statement: query,
    sql: "SELECT value FROM records WHERE id = $1",
    parameterOrder: ["id"],
    returning: false,
  };
  const invalidCatalogs = [
    [PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, null],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{}]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{
      ...validQuery,
      sql: "SELECT value FROM records WHERE id = $2",
    }]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{
      ...validQuery,
      sql: "SELECT value FROM records WHERE id = :id",
    }]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{
      ...validQuery,
      parameterOrder: ["unknown"],
    }]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{
      ...validQuery,
      returning: true,
    }]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{
      ...validQuery,
      sql: "SELECT value FROM records; SELECT value FROM records",
    }]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{
      ...validQuery,
      sql: "WITH removed AS (DELETE FROM records RETURNING value) SELECT value FROM removed",
    }]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{
      statement: execute,
      sql: "SELECT $1",
      parameterOrder: ["id"],
      returning: false,
    }]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [{
      statement: returningExecute,
      sql: "INSERT INTO records (id) VALUES ($1)",
      parameterOrder: ["id"],
      returning: true,
    }]],
    [PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, [validQuery, validQuery]],
  ];

  for (const [code, catalog] of invalidCatalogs) {
    assert.throws(
      () => createPostgresqlPersistenceProvider({
        pool: fixture.pool,
        catalog,
      }),
      hasPersistenceCode(code),
    );
  }
  assert.equal(fixture.state.connectCalls, 0);
  assert.equal(fixture.listenerCount("error"), 0);
});

test("v0.87 DB Block 5: PostgreSQL-Fähigkeiten bleiben tief eingefroren und nicht produktiv überdehnt", () => {
  assert.equal(Object.isFrozen(POSTGRESQL_CAPABILITIES), true);
  assert.equal(Object.isFrozen(POSTGRESQL_CAPABILITIES.transaction), true);
  assert.equal(Object.isFrozen(POSTGRESQL_CAPABILITIES.transaction.isolationLevels), true);
  assert.equal(Object.isFrozen(POSTGRESQL_CAPABILITIES.features), true);
  assert.deepEqual(POSTGRESQL_CAPABILITIES.transaction, {
    nested: "reject",
    isolationLevels: ["default", "serializable"],
  });
  assert.equal(POSTGRESQL_CAPABILITIES.features.atomicTransactions, true);
  assert.equal(POSTGRESQL_CAPABILITIES.features.concurrentWrites, true);
  assert.equal(POSTGRESQL_CAPABILITIES.features.multipleAppInstances, false);
  assert.equal(POSTGRESQL_CAPABILITIES.features.databaseBackup, false);
  assert.equal(POSTGRESQL_CAPABILITIES.features.restore, false);
  assert.equal(POSTGRESQL_CAPABILITIES.features.pointInTimeRecovery, false);
});

test('PostgreSQL connection failure between transaction statements rejects the commit without an unhandled client error', async () => {
  const client=new EventEmitter(),releases=[],diagnostics=[];let terminated=false;
  const failure=Object.assign(new Error('synthetic idle transaction timeout'),{code:'25P03'});
  client.query=async()=>{if(terminated)throw failure;return {rowCount:0,rows:[],fields:[]};};client.release=value=>releases.push(value);
  const provider=createPostgresqlPersistenceProvider({pool:{connect:async()=>client,end:async()=>{}},catalog:[],onPoolError:e=>diagnostics.push(e.code)});
  await assert.rejects(provider.transaction(async()=>{
    terminated=true;assert.doesNotThrow(()=>client.emit('error',failure));
  }),hasPersistenceCode(PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE));
  assert.deepEqual(diagnostics,[PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE]);assert.ok(releases[0]);await provider.close();
});
