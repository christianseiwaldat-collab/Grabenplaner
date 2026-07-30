"use strict";

const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const {
  after,
  before,
  test,
} = require("node:test");

const { Pool } = require("pg");
const {
  PERSISTENCE_ERROR_CODES,
  definePersistenceStatement,
} = require("../lib/persistence/contract");
const {
  createPostgresqlPersistenceProvider,
} = require("../lib/persistence/postgresql/provider");
const {
  compilePostgresqlDialectEntry,
} = require("../lib/persistence/postgresql/dialect-compiler");
const {
  createPostgresqlPoolConfiguration,
  isLoopbackHostname,
} = require("../lib/persistence/postgresql/policy");

const DATABASE_URL = String(process.env.TEST_POSTGRESQL_URL || "").trim();

if (!DATABASE_URL) {
  test("v0.87 DB Block 5 Live: TEST_POSTGRESQL_URL ist für echte PostgreSQL-Integrationstests erforderlich", {
    skip: "TEST_POSTGRESQL_URL ist nicht gesetzt; der optionale PostgreSQL-Livetest bleibt lokal aus.",
  }, () => {});
} else {
  const schemaName = [
    "gp_db5",
    process.pid,
    Date.now(),
    randomBytes(6).toString("hex"),
  ].join("_");
  const schema = `"${schemaName}"`;
  const relation = (name) => `${schema}."${name}"`;
  const functionName = (name) => `${schema}."${name}"`;

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
  const STATEMENTS = Object.freeze({
    insertValue: definePersistenceStatement({
      id: "postgresql-live.values.insert",
      operation: "execute",
      parameters: VALUE_COLUMNS,
      columns: VALUE_COLUMNS,
    }),
    getValue: definePersistenceStatement({
      id: "postgresql-live.values.get",
      operation: "queryOne",
      parameters: { id: "safe_integer" },
      columns: VALUE_COLUMNS,
    }),
    insertConstraint: definePersistenceStatement({
      id: "postgresql-live.constraints.insert",
      operation: "execute",
      parameters: {
        id: "safe_integer",
        uniqueValue: "text",
        requiredValue: { kind: "text", nullable: true },
        checkedValue: "safe_integer",
        parentId: "safe_integer",
      },
    }),
    updateTransactionValue: definePersistenceStatement({
      id: "postgresql-live.transactions.update-value",
      operation: "execute",
      parameters: {
        delta: "safe_integer",
        id: "safe_integer",
      },
    }),
    getTransactionValue: definePersistenceStatement({
      id: "postgresql-live.transactions.get-value",
      operation: "queryOne",
      parameters: { id: "safe_integer" },
      columns: {
        id: "safe_integer",
        value: "safe_integer",
      },
    }),
    transactionContext: definePersistenceStatement({
      id: "postgresql-live.transactions.context",
      operation: "queryOne",
      columns: {
        backendPid: "safe_integer",
        isolation: "text",
        readOnly: "text",
      },
    }),
    readOnlyWriteProbe: definePersistenceStatement({
      id: "postgresql-live.transactions.read-only-write-probe",
      operation: "queryOne",
      columns: { value: "safe_integer" },
    }),
    statementTimeout: definePersistenceStatement({
      id: "postgresql-live.timeout.statement",
      operation: "queryOne",
      columns: { status: "text" },
    }),
    insertCompilerJsonValue: definePersistenceStatement({
      id: "postgresql-live.compiler-json.insert",
      operation: "execute",
      parameters: { payload: "json" },
      columns: { data: "json" },
    }),
    listCompilerJsonValues: definePersistenceStatement({
      id: "postgresql-live.compiler-json.list",
      operation: "queryAll",
      parameters: { payload: "json" },
      columns: { data: "json" },
    }),
  });

  function compiledCatalogEntry(statement, sql, returning) {
    const compiled = compilePostgresqlDialectEntry({
      statement,
      sql,
      returning,
    });
    assert.equal(compiled.strategy, "portable-generated");
    return Object.freeze({
      statement,
      sql: compiled.compiledSql,
      parameterOrder: compiled.parameterOrder,
      parameterBindings: compiled.parameterBindings,
      returning,
    });
  }

  const CATALOG = Object.freeze([
    Object.freeze({
      statement: STATEMENTS.insertValue,
      sql: `
        INSERT INTO ${relation("provider_values")} (
          id,
          enabled,
          large_value,
          amount,
          created_at,
          business_date,
          clock_time,
          metadata,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING
          id,
          enabled,
          large_value AS "largeValue",
          amount,
          created_at AS "createdAt",
          business_date AS "businessDate",
          clock_time AS "clockTime",
          metadata,
          payload
      `,
      parameterOrder: Object.freeze([
        "id",
        "enabled",
        "largeValue",
        "amount",
        "createdAt",
        "businessDate",
        "clockTime",
        "metadata",
        "payload",
      ]),
      returning: true,
    }),
    Object.freeze({
      statement: STATEMENTS.getValue,
      sql: `
        SELECT
          id,
          enabled,
          large_value AS "largeValue",
          amount,
          created_at AS "createdAt",
          business_date AS "businessDate",
          clock_time AS "clockTime",
          metadata,
          payload
        FROM ${relation("provider_values")}
        WHERE id = $1
      `,
      parameterOrder: Object.freeze(["id"]),
      returning: false,
    }),
    Object.freeze({
      statement: STATEMENTS.insertConstraint,
      sql: `
        INSERT INTO ${relation("constraint_values")} (
          id,
          unique_value,
          required_value,
          checked_value,
          parent_id
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      parameterOrder: Object.freeze([
        "id",
        "uniqueValue",
        "requiredValue",
        "checkedValue",
        "parentId",
      ]),
      returning: false,
    }),
    Object.freeze({
      statement: STATEMENTS.updateTransactionValue,
      sql: `
        UPDATE ${relation("transaction_values")}
        SET value = value + $1
        WHERE id = $2
      `,
      parameterOrder: Object.freeze(["delta", "id"]),
      returning: false,
    }),
    Object.freeze({
      statement: STATEMENTS.getTransactionValue,
      sql: `
        SELECT id, value
        FROM ${relation("transaction_values")}
        WHERE id = $1
      `,
      parameterOrder: Object.freeze(["id"]),
      returning: false,
    }),
    Object.freeze({
      statement: STATEMENTS.transactionContext,
      sql: `
        SELECT
          pg_backend_pid() AS "backendPid",
          current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS "readOnly"
      `,
      parameterOrder: Object.freeze([]),
      returning: false,
    }),
    Object.freeze({
      statement: STATEMENTS.readOnlyWriteProbe,
      sql: `SELECT ${functionName("read_only_write_probe")}() AS value`,
      parameterOrder: Object.freeze([]),
      returning: false,
    }),
    compiledCatalogEntry(
      STATEMENTS.insertCompilerJsonValue,
      `
        INSERT INTO ${relation("compiler_json_values")} (
          id,
          department_id,
          active,
          note
        )
        VALUES (
          json_extract($payload, '$.id'),
          json_extract($payload, '$.departmentId'),
          json_extract($payload, '$.active'),
          json_extract($payload, '$.note')
        )
        RETURNING json_object(
          'id', id,
          'department_id', department_id,
          'active', active,
          'note', note
        ) AS data
      `,
      true,
    ),
    compiledCatalogEntry(
      STATEMENTS.listCompilerJsonValues,
      `
        SELECT json_object(
          'id', id,
          'department_id', department_id,
          'active', active,
          'note', note
        ) AS data
        FROM ${relation("compiler_json_values")}
        WHERE (
          department_id = json_extract($payload, '$.departmentId')
          OR json_extract($payload, '$.departmentId') IS NULL
        )
        ORDER BY id
      `,
      false,
    ),
  ]);
  const TIMEOUT_CATALOG = Object.freeze([
    Object.freeze({
      statement: STATEMENTS.statementTimeout,
      sql: "SELECT 'completed'::text AS status FROM pg_sleep(2)",
      parameterOrder: Object.freeze([]),
      returning: false,
    }),
  ]);

  let adminPool;
  let provider;
  let timeoutProvider;
  let providerSqlstates;
  let timeoutSqlstates;

  function tlsModeFor(databaseUrl) {
    const parsed = new URL(databaseUrl);
    return isLoopbackHostname(parsed.hostname)
      ? "disable-local-only"
      : "verify-full";
  }

  function instrumentSqlstates(pool, target) {
    pool.on("connect", (client) => {
      const query = client.query.bind(client);
      client.query = async (...args) => {
        try {
          return await query(...args);
        } catch (error) {
          if (/^[0-9A-Z]{5}$/.test(String(error?.code || ""))) {
            target.push(error.code);
          }
          throw error;
        }
      };
    });
  }

  function openProvider({
    catalog,
    applicationName,
    policy,
    sqlstates,
  }) {
    const configuration = createPostgresqlPoolConfiguration({
      databaseUrl: DATABASE_URL,
      tlsMode: tlsModeFor(DATABASE_URL),
      applicationName,
      policy,
      allowExitOnIdle: true,
    });
    const pool = new Pool(configuration);
    instrumentSqlstates(pool, sqlstates);
    return createPostgresqlPersistenceProvider({
      pool,
      catalog,
      poolOwnership: "provider",
      acquireTimeoutMilliseconds: configuration.connectionTimeoutMillis,
    });
  }

  async function expectPersistenceFailure(work, {
    persistenceCode,
    sqlstate,
    observedSqlstates = providerSqlstates,
  }) {
    const offset = observedSqlstates.length;
    await assert.rejects(work, (error) => {
      assert.equal(error?.code, persistenceCode);
      assert.equal(JSON.stringify(error).includes(DATABASE_URL), false);
      return true;
    });
    assert.equal(
      observedSqlstates.slice(offset).includes(sqlstate),
      true,
      `Der PostgreSQL-Treiber muss SQLSTATE ${sqlstate} geliefert haben.`,
    );
  }

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, reject, resolve };
  }

  function rejectAfter(milliseconds, message) {
    return new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), milliseconds);
      timer.unref?.();
    });
  }

  before(async () => {
    assert.equal(require("pg/package.json").version, "8.22.0");

    const adminConfiguration = createPostgresqlPoolConfiguration({
      databaseUrl: DATABASE_URL,
      tlsMode: tlsModeFor(DATABASE_URL),
      applicationName: "grabenplaner-db5-live-admin",
      policy: {
        maximumConnections: 2,
        connectionTimeoutMilliseconds: 3_000,
        idleTimeoutMilliseconds: 1_000,
        statementTimeoutMilliseconds: 10_000,
        queryTimeoutMilliseconds: 12_000,
        transactionTimeoutMilliseconds: 15_000,
        maximumConnectionLifetimeSeconds: 60,
      },
      allowExitOnIdle: true,
    });
    adminPool = new Pool(adminConfiguration);
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    await adminPool.query(`
      CREATE TABLE ${relation("provider_values")} (
        id BIGINT PRIMARY KEY,
        enabled BOOLEAN NOT NULL,
        large_value BIGINT NOT NULL,
        amount NUMERIC(30, 6) NOT NULL,
        created_at TIMESTAMPTZ(3) NOT NULL,
        business_date DATE NOT NULL,
        clock_time TIME(0) WITHOUT TIME ZONE NOT NULL,
        metadata JSONB NOT NULL,
        payload BYTEA NOT NULL
      )
    `);
    await adminPool.query(`
      CREATE TABLE ${relation("constraint_parents")} (
        id INTEGER PRIMARY KEY
      )
    `);
    await adminPool.query(`
      CREATE TABLE ${relation("constraint_values")} (
        id INTEGER PRIMARY KEY,
        unique_value TEXT NOT NULL UNIQUE,
        required_value TEXT NOT NULL,
        checked_value INTEGER NOT NULL CHECK (checked_value > 0),
        parent_id INTEGER NOT NULL
          REFERENCES ${relation("constraint_parents")} (id)
      )
    `);
    await adminPool.query(`
      INSERT INTO ${relation("constraint_parents")} (id)
      VALUES (1)
    `);
    await adminPool.query(`
      CREATE TABLE ${relation("transaction_values")} (
        id INTEGER PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);
    await adminPool.query(`
      CREATE TABLE ${relation("compiler_json_values")} (
        id BIGINT PRIMARY KEY,
        department_id BIGINT,
        active SMALLINT NOT NULL CHECK (active IN (0, 1)),
        note TEXT
      )
    `);
    await adminPool.query(`
      INSERT INTO ${relation("transaction_values")} (id, value)
      VALUES (1, 0), (2, 0)
    `);
    await adminPool.query(`
      CREATE FUNCTION ${functionName("read_only_write_probe")}()
      RETURNS INTEGER
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        UPDATE ${relation("transaction_values")}
        SET value = value + 100
        WHERE id = 1;
        RETURN 1;
      END
      $function$
    `);

    providerSqlstates = [];
    timeoutSqlstates = [];
    provider = openProvider({
      catalog: CATALOG,
      applicationName: "grabenplaner-db5-live-provider",
      sqlstates: providerSqlstates,
      policy: {
        maximumConnections: 6,
        connectionTimeoutMilliseconds: 3_000,
        idleTimeoutMilliseconds: 1_000,
        statementTimeoutMilliseconds: 5_000,
        queryTimeoutMilliseconds: 6_000,
        transactionTimeoutMilliseconds: 10_000,
        maximumConnectionLifetimeSeconds: 60,
      },
    });
    timeoutProvider = openProvider({
      catalog: TIMEOUT_CATALOG,
      applicationName: "grabenplaner-db5-live-timeout",
      sqlstates: timeoutSqlstates,
      policy: {
        maximumConnections: 2,
        connectionTimeoutMilliseconds: 3_000,
        idleTimeoutMilliseconds: 1_000,
        statementTimeoutMilliseconds: 300,
        queryTimeoutMilliseconds: 600,
        transactionTimeoutMilliseconds: 2_000,
        maximumConnectionLifetimeSeconds: 60,
      },
    });
  });

  after(async () => {
    const closeResults = await Promise.allSettled([
      provider?.close(),
      timeoutProvider?.close(),
    ].filter(Boolean));
    let cleanupError;
    if (adminPool) {
      try {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } catch (error) {
        cleanupError = error;
      } finally {
        await adminPool.end();
      }
    }
    const closeFailure = closeResults.find((result) => result.status === "rejected");
    if (cleanupError) throw cleanupError;
    if (closeFailure) throw closeFailure.reason;
  });

  test("v0.87 DB Block 5 Live: echte PostgreSQL-Typen und RETURNING erfüllen den Providervertrag", async () => {
    const expected = {
      id: 101,
      enabled: true,
      largeValue: "9007199254740993",
      amount: "1234567890.012300",
      createdAt: "2026-07-29T12:34:56.789Z",
      businessDate: "2026-07-29",
      clockTime: "14:34:56",
      metadata: { nested: [true, null, 7], provider: "postgresql" },
      payload: Buffer.from([0, 1, 127, 128, 255]),
    };

    const inserted = await provider.execute(STATEMENTS.insertValue, {
      ...expected,
      largeValue: 9007199254740993n,
      createdAt: new Date(expected.createdAt),
    });
    assert.equal(inserted.rowsAffected, 1);
    assert.deepEqual(inserted.returnedRows, [expected]);
    assert.equal(Object.isFrozen(inserted.returnedRows[0]), true);
    assert.equal(Object.isFrozen(inserted.returnedRows[0].metadata), true);

    const loaded = await provider.queryOne(STATEMENTS.getValue, { id: expected.id });
    assert.deepEqual(loaded, expected);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.metadata), true);
    assert.notEqual(loaded.payload, expected.payload);
  });

  test("v0.87 DB Block 5 Live: Compiler-JSON-Bindings laufen typinferiert auf PostgreSQL", async () => {
    const inserted = await provider.execute(STATEMENTS.insertCompilerJsonValue, {
      payload: {
        active: true,
        departmentId: 12,
        id: 202,
        note: "gebunden",
      },
    });
    assert.deepEqual(inserted, {
      rowsAffected: 1,
      returnedRows: [{
        data: {
          active: 1,
          department_id: 12,
          id: 202,
          note: "gebunden",
        },
      }],
    });

    assert.deepEqual(await provider.queryAll(STATEMENTS.listCompilerJsonValues, {
      payload: { departmentId: null },
    }), [{
      data: {
        active: 1,
        department_id: 12,
        id: 202,
        note: "gebunden",
      },
    }]);
  });

  test("v0.87 DB Block 5 Live: echte SQLSTATE-Constraints werden stabil normalisiert", async () => {
    const valid = {
      id: 1,
      uniqueValue: "unique-a",
      requiredValue: "required",
      checkedValue: 1,
      parentId: 1,
    };
    assert.deepEqual(
      await provider.execute(STATEMENTS.insertConstraint, valid),
      { rowsAffected: 1, returnedRows: [] },
    );

    await expectPersistenceFailure(
      provider.execute(STATEMENTS.insertConstraint, {
        ...valid,
        id: 2,
      }),
      {
        persistenceCode: PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION,
        sqlstate: "23505",
      },
    );
    await expectPersistenceFailure(
      provider.execute(STATEMENTS.insertConstraint, {
        ...valid,
        id: 3,
        uniqueValue: "unique-b",
        parentId: 999,
      }),
      {
        persistenceCode: PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION,
        sqlstate: "23503",
      },
    );
    await expectPersistenceFailure(
      provider.execute(STATEMENTS.insertConstraint, {
        ...valid,
        id: 4,
        uniqueValue: "unique-c",
        requiredValue: null,
      }),
      {
        persistenceCode: PERSISTENCE_ERROR_CODES.NOT_NULL_VIOLATION,
        sqlstate: "23502",
      },
    );
    await expectPersistenceFailure(
      provider.execute(STATEMENTS.insertConstraint, {
        ...valid,
        id: 5,
        uniqueValue: "unique-d",
        checkedValue: 0,
      }),
      {
        persistenceCode: PERSISTENCE_ERROR_CODES.CHECK_VIOLATION,
        sqlstate: "23514",
      },
    );
  });

  test("v0.87 DB Block 5 Live: Rollback, serverseitiges READ ONLY und SERIALIZABLE sind wirksam", async () => {
    const primaryError = new Error("fachlicher Testabbruch");
    await assert.rejects(
      provider.transaction(async (transaction) => {
        await transaction.execute(STATEMENTS.updateTransactionValue, {
          delta: 50,
          id: 1,
        });
        throw primaryError;
      }),
      (error) => error === primaryError,
    );
    assert.equal(
      (await provider.queryOne(STATEMENTS.getTransactionValue, { id: 1 })).value,
      0,
    );

    await expectPersistenceFailure(
      provider.transaction(
        (transaction) => transaction.queryOne(STATEMENTS.readOnlyWriteProbe),
        { readOnly: true },
      ),
      {
        persistenceCode: PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
        sqlstate: "25006",
      },
    );
    assert.equal(
      (await provider.queryOne(STATEMENTS.getTransactionValue, { id: 1 })).value,
      0,
    );

    const context = await provider.transaction(
      (transaction) => transaction.queryOne(STATEMENTS.transactionContext),
      { isolation: "serializable" },
    );
    assert.equal(context.isolation, "serializable");
    assert.equal(context.readOnly, "off");
    assert.equal(Number.isSafeInteger(context.backendPid), true);
  });

  test("v0.87 DB Block 5 Live: zwei echte Transaktionen arbeiten gleichzeitig auf getrennten Zeilen", {
    timeout: 10_000,
  }, async () => {
    const bothLocked = deferred();
    const releaseTransactions = deferred();
    let lockedCount = 0;

    function transactionFor(id) {
      return provider.transaction(async (transaction) => {
        await transaction.execute(STATEMENTS.updateTransactionValue, {
          delta: 1,
          id,
        });
        const context = await transaction.queryOne(STATEMENTS.transactionContext);
        lockedCount += 1;
        if (lockedCount === 2) bothLocked.resolve();
        await releaseTransactions.promise;
        return context.backendPid;
      });
    }

    const first = transactionFor(1);
    const second = transactionFor(2);
    let overlapError;
    try {
      await Promise.race([
        bothLocked.promise,
        rejectAfter(3_000, "Die zwei PostgreSQL-Transaktionen überlappten nicht."),
      ]);
    } catch (error) {
      overlapError = error;
    } finally {
      releaseTransactions.resolve();
    }
    const backendPids = await Promise.all([first, second]);
    if (overlapError) throw overlapError;

    assert.equal(new Set(backendPids).size, 2);
    assert.equal(
      (await provider.queryOne(STATEMENTS.getTransactionValue, { id: 1 })).value,
      1,
    );
    assert.equal(
      (await provider.queryOne(STATEMENTS.getTransactionValue, { id: 2 })).value,
      1,
    );
  });

  test("v0.87 DB Block 5 Live: ein echter 40P01-Deadlock wird als RETRYABLE_TRANSACTION gemeldet", {
    timeout: 15_000,
  }, async () => {
    const bothFirstRowsLocked = deferred();
    let lockedCount = 0;
    const sqlstateOffset = providerSqlstates.length;

    function deadlockingTransaction(firstId, secondId) {
      return provider.transaction(async (transaction) => {
        await transaction.execute(STATEMENTS.updateTransactionValue, {
          delta: 1,
          id: firstId,
        });
        lockedCount += 1;
        if (lockedCount === 2) bothFirstRowsLocked.resolve();
        await Promise.race([
          bothFirstRowsLocked.promise,
          rejectAfter(3_000, "Die Deadlock-Ausgangssperren wurden nicht gleichzeitig aufgebaut."),
        ]);
        await transaction.execute(STATEMENTS.updateTransactionValue, {
          delta: 1,
          id: secondId,
        });
        return firstId;
      });
    }

    const outcomes = await Promise.allSettled([
      deadlockingTransaction(1, 2),
      deadlockingTransaction(2, 1),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      rejected[0].reason?.code,
      PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION,
    );
    assert.equal(rejected[0].reason?.retryable, true);
    assert.equal(
      providerSqlstates.slice(sqlstateOffset).includes("40P01"),
      true,
      "Der echte Serverfehler muss SQLSTATE 40P01 gewesen sein.",
    );
    assert.equal(
      (await provider.queryOne(STATEMENTS.getTransactionValue, { id: 1 })).value,
      2,
    );
    assert.equal(
      (await provider.queryOne(STATEMENTS.getTransactionValue, { id: 2 })).value,
      2,
    );
  });

  test("v0.87 DB Block 5 Live: serverseitiger statement_timeout 57014 wird als TIMEOUT gemeldet", {
    timeout: 5_000,
  }, async () => {
    await expectPersistenceFailure(
      timeoutProvider.queryOne(STATEMENTS.statementTimeout),
      {
        persistenceCode: PERSISTENCE_ERROR_CODES.TIMEOUT,
        sqlstate: "57014",
        observedSqlstates: timeoutSqlstates,
      },
    );
  });
}
