"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname, "..");

const {
  PERSISTENCE_ERROR_CODES,
  assertPersistenceAccess,
  definePersistenceStatement,
} = require("../lib/persistence/contract");
const {
  createApplicationRepositories,
} = require("../lib/persistence/application-repositories");
const {
  createUiPreferencesRepository,
} = require("../lib/persistence/repositories/ui-preferences");
const {
  SQLITE_APPLICATION_CATALOG,
  createSqliteApplicationCatalog,
} = require("../lib/persistence/sqlite/application-catalog");
const {
  createSqlitePersistenceProvider,
  openSqliteApplicationPersistence,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const {
  SQLITE_UI_PREFERENCES_CATALOG,
} = require("../lib/persistence/sqlite/ui-preferences-catalog");
const {
  UI_PREFERENCES_STATEMENTS,
} = require("../lib/persistence/statements/ui-preferences");
const {
  createSqliteApplicationFixture,
} = require("../test-support/sqlite-application-fixture");

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
const VALUE_PARAMETERS = Object.freeze({
  ...VALUE_COLUMNS,
});
const VALUE_STATEMENTS = Object.freeze({
  insert: definePersistenceStatement({
    id: "sqlite-provider-values.insert",
    operation: "execute",
    parameters: VALUE_PARAMETERS,
    columns: VALUE_COLUMNS,
  }),
  get: definePersistenceStatement({
    id: "sqlite-provider-values.get",
    operation: "queryOne",
    parameters: { id: "safe_integer" },
    columns: VALUE_COLUMNS,
  }),
  all: definePersistenceStatement({
    id: "sqlite-provider-values.all",
    operation: "queryAll",
    columns: VALUE_COLUMNS,
  }),
  queryOnly: definePersistenceStatement({
    id: "sqlite-provider.query-only",
    operation: "queryOne",
    columns: { enabled: "boolean" },
  }),
  insertRequired: definePersistenceStatement({
    id: "sqlite-provider-required.insert",
    operation: "execute",
    parameters: {
      id: "safe_integer",
      value: { kind: "text", nullable: true },
    },
  }),
});
const VALUE_SELECTION = `
  id,
  enabled,
  large_value AS largeValue,
  amount,
  created_at AS createdAt,
  business_date AS businessDate,
  clock_time AS clockTime,
  metadata,
  payload
`;
const VALUE_CATALOG = Object.freeze([
  Object.freeze({
    statement: VALUE_STATEMENTS.insert,
    sql: `
      INSERT INTO provider_values (
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
      VALUES (
        $id,
        $enabled,
        $largeValue,
        $amount,
        $createdAt,
        $businessDate,
        $clockTime,
        $metadata,
        $payload
      )
      RETURNING ${VALUE_SELECTION}
    `,
    returning: true,
  }),
  Object.freeze({
    statement: VALUE_STATEMENTS.get,
    sql: `
      SELECT ${VALUE_SELECTION}
      FROM provider_values
      WHERE id = $id
    `,
    returning: false,
  }),
  Object.freeze({
    statement: VALUE_STATEMENTS.all,
    sql: `SELECT ${VALUE_SELECTION} FROM provider_values ORDER BY id`,
    returning: false,
  }),
  Object.freeze({
    statement: VALUE_STATEMENTS.queryOnly,
    sql: "SELECT query_only AS enabled FROM pragma_query_only",
    returning: false,
  }),
  Object.freeze({
    statement: VALUE_STATEMENTS.insertRequired,
    sql: "INSERT INTO provider_required (id, value) VALUES ($id, $value)",
    returning: false,
  }),
]);

function hasPersistenceCode(code) {
  return (error) => error?.code === code;
}

test("v0.87 SQLite-Provider: Anwendungskatalog ist tief eingefroren und eindeutig", () => {
  assert.equal(Object.isFrozen(createSqliteApplicationCatalog), true);
  assert.equal(Object.isFrozen(SQLITE_APPLICATION_CATALOG), true);
  assert.ok(SQLITE_APPLICATION_CATALOG.length >= SQLITE_UI_PREFERENCES_CATALOG.length);
  const applicationStatements = new Set(
    SQLITE_APPLICATION_CATALOG.map((entry) => entry.statement),
  );
  for (const entry of SQLITE_UI_PREFERENCES_CATALOG) {
    assert.equal(applicationStatements.has(entry.statement), true);
  }
  assert.equal(
    new Set(SQLITE_APPLICATION_CATALOG.map((entry) => entry.statement)).size,
    SQLITE_APPLICATION_CATALOG.length,
  );
  assert.equal(
    new Set(SQLITE_APPLICATION_CATALOG.map((entry) => entry.statement.id)).size,
    SQLITE_APPLICATION_CATALOG.length,
  );
  for (const entry of SQLITE_APPLICATION_CATALOG) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.statement), true);
    assert.equal(Object.isFrozen(entry.statement.parameters), true);
    assert.equal(Object.isFrozen(entry.statement.columns), true);
  }

  assert.throws(
    () => createSqliteApplicationCatalog(
      SQLITE_UI_PREFERENCES_CATALOG,
      SQLITE_UI_PREFERENCES_CATALOG,
    ),
    TypeError,
  );

  const duplicateId = definePersistenceStatement({
    id: UI_PREFERENCES_STATEMENTS.list.id,
    operation: "queryAll",
    parameters: { employeeNumber: "text" },
    columns: {
      preferenceKey: "text",
      value: "text",
    },
  });
  assert.notEqual(duplicateId, UI_PREFERENCES_STATEMENTS.list);
  assert.throws(
    () => createSqliteApplicationCatalog(
      Object.freeze([SQLITE_UI_PREFERENCES_CATALOG[0]]),
      Object.freeze([Object.freeze({
        statement: duplicateId,
        sql: "SELECT preference_key AS preferenceKey, value FROM portal_user_preferences",
        returning: false,
      })]),
    ),
    TypeError,
  );
});

test("v0.87 SQLite-Provider: Application-Repositories akzeptieren nur echte Provider und Executor", async () => {
  const fixture = await createSqliteApplicationFixture({
    employeeNumbers: ["E1", "E'2"],
  });
  let transactionRepositories;
  try {
    assert.equal(Object.isFrozen(createApplicationRepositories), true);
    assert.equal(Object.isFrozen(fixture), true);
    assert.deepEqual(
      Object.keys(fixture).sort(),
      ["close", "provider", "repositories", "transaction"],
    );
    assert.equal(
      Object.keys(fixture).some((key) => /(?:connection|database|db|driver|handle|raw)/i.test(key)),
      false,
    );
    assert.equal(assertPersistenceAccess(fixture.provider), fixture.provider);
    assert.deepEqual(
      Object.keys(fixture.provider).sort(),
      ["close", "execute", "getCapabilities", "queryAll", "queryOne", "transaction"],
    );
    assert.equal(Object.isFrozen(fixture.repositories), true);
    assert.deepEqual(
      Object.keys(fixture.repositories).sort(),
      [
        "absenceManagement",
        "brandingSnapshot",
        "collectiveAgreements",
        "customProcessManagement",
        "customWorkRules",
        "governanceStore",
        "integrationRuntime",
        "loanModule",
        "mobileAuth",
        "organizationPersonnel",
        "personalNotificationContacts",
        "personnelLifecycle",
        "planningSettings",
        "portalAccess",
        "runtimeRecovery",
        "sicknessAmuManagement",
        "systemCenterMetrics",
        "timeTracking",
        "uiPreferences",
        "wifiAutomation",
        "workRuleGovernance",
        "workRules",
      ],
    );
    assert.equal(Object.isFrozen(fixture.repositories.uiPreferences), true);

    assert.deepEqual(
      await fixture.repositories.uiPreferences.saveChanges("E1", {
        upserts: [{ preferenceKey: "theme", value: "dark" }],
      }),
      { upserted: 1, deleted: 0 },
    );
    await fixture.repositories.uiPreferences.upsert("E'2", "theme", "light");

    const transactionResult = await fixture.transaction(async (repositories) => {
      transactionRepositories = repositories;
      assert.equal(Object.isFrozen(repositories), true);
      assert.deepEqual(
        Object.keys(repositories).sort(),
        [
          "absenceManagement",
          "brandingSnapshot",
          "collectiveAgreements",
          "customProcessManagement",
          "customWorkRules",
          "governanceStore",
          "integrationRuntime",
          "loanModule",
          "mobileAuth",
          "organizationPersonnel",
          "personalNotificationContacts",
          "personnelLifecycle",
          "planningSettings",
          "portalAccess",
          "runtimeRecovery",
          "sicknessAmuManagement",
          "systemCenterMetrics",
          "timeTracking",
          "uiPreferences",
          "wifiAutomation",
          "workRuleGovernance",
          "workRules",
        ],
      );
      assert.deepEqual(
        await repositories.uiPreferences.saveChanges("E1", {
          deleteKeys: ["theme"],
          upserts: [{ preferenceKey: "density", value: "compact" }],
        }),
        { upserted: 1, deleted: 1 },
      );
      return repositories.uiPreferences.list("E1");
    });
    assert.deepEqual(transactionResult, [
      { preferenceKey: "density", value: "compact" },
    ]);
    await assert.rejects(
      transactionRepositories.uiPreferences.get("E1", "density"),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
    );

    await assert.rejects(
      fixture.transaction(async (repositories) => {
        await repositories.uiPreferences.saveChanges("E1", {
          upserts: [
            { preferenceKey: "rolled_back", value: "no" },
            { preferenceKey: "reject", value: "constraint" },
          ],
        });
      }),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.CHECK_VIOLATION),
    );
    assert.equal(
      await fixture.repositories.uiPreferences.get("E1", "rolled_back"),
      null,
    );

    const lookalike = Object.freeze({
      execute() {},
      queryAll() {},
      queryOne() {},
    });
    assert.throws(
      () => assertPersistenceAccess(lookalike),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION),
    );
    assert.throws(
      () => createApplicationRepositories(lookalike),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION),
    );
  } finally {
    await fixture.close();
  }
});

test("v0.87 SQLite-Provider: App-Komposition teilt exakt eine In-Memory-Datenbank", async () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_UI_PREFERENCES_CATALOG,
  });
  const { database, provider } = application;
  try {
    assert.equal(Object.isFrozen(application), true);
    assert.equal(Object.isFrozen(database), true);
    assert.equal(Object.isFrozen(provider), true);
    assert.deepEqual(Object.keys(database).sort(), ["close", "exec", "function", "prepare"]);
    assert.equal(Object.keys(database).some((key) => /(?:raw|handle|driver|connection)/i.test(key)), false);
    const probe = database.prepare("SELECT 1 AS value");
    assert.equal(Object.isFrozen(probe), true);
    assert.deepEqual(Object.keys(probe).sort(), ["all", "get", "run"]);

    database.exec(`
      CREATE TABLE portal_users (
        employee_number TEXT PRIMARY KEY
      );
      CREATE TABLE portal_user_preferences (
        employee_number TEXT NOT NULL,
        preference_key TEXT NOT NULL CHECK(preference_key <> 'reject'),
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (employee_number, preference_key),
        FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
      INSERT INTO portal_users (employee_number) VALUES ('E1');
    `);

    const repository = createUiPreferencesRepository(provider);
    assert.equal(Object.isFrozen(repository), true);
    assert.deepEqual(
      await repository.saveChanges("E1", {
        upserts: [
          { preferenceKey: "theme", value: "dark" },
          { preferenceKey: "columns", value: "[\"name\"]" },
        ],
      }),
      { upserted: 2, deleted: 0 },
    );
    assert.deepEqual(await repository.list("E1"), [
      { preferenceKey: "columns", value: "[\"name\"]" },
      { preferenceKey: "theme", value: "dark" },
    ]);
    assert.deepEqual(await repository.get("E1", "theme"), {
      preferenceKey: "theme",
      value: "dark",
    });

    assert.deepEqual(
      await repository.saveChanges("E1", {
        deleteKeys: ["columns"],
        upserts: [{ preferenceKey: "font", value: "110" }],
      }),
      { upserted: 1, deleted: 1 },
    );
    await assert.rejects(
      repository.saveChanges("E1", {
        deleteKeys: ["theme"],
        upserts: [
          { preferenceKey: "rolled_back", value: "no" },
          { preferenceKey: "reject", value: "constraint" },
        ],
      }),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.CHECK_VIOLATION),
    );
    assert.equal(await repository.get("E1", "rolled_back"), null);
    assert.equal((await repository.get("E1", "theme")).value, "dark");
    await assert.rejects(
      repository.upsert("UNKNOWN", "theme", "light"),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION),
    );
    await assert.rejects(
      repository.saveChanges("E1", {
        upserts: [{ preferenceKey: "theme", value: "light" }],
        deleteKeys: ["theme"],
      }),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
    );

    await provider.transaction(async () => {
      assert.throws(
        () => database.prepare(`
          INSERT INTO portal_user_preferences (employee_number, preference_key, value)
          VALUES ('E1', 'cross_facade', 'forbidden')
        `).run(),
        hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
      );
    });
    assert.equal(await repository.get("E1", "cross_facade"), null);

    database.exec("BEGIN IMMEDIATE");
    try {
      await assert.rejects(
        repository.get("E1", "theme"),
        hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
      );
    } finally {
      database.exec("ROLLBACK");
    }

    database.prepare("/* legacy */ BEGIN IMMEDIATE").run();
    try {
      await assert.rejects(
        repository.get("E1", "theme"),
        hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
      );
    } finally {
      database.prepare("ROLLBACK").run();
    }

    database.exec("BEGIN IMMEDIATE");
    database.exec("SAVEPOINT outer");
    database.exec("ROLLBACK TRANSACTION TO SAVEPOINT outer");
    try {
      await assert.rejects(
        repository.get("E1", "theme"),
        hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
      );
    } finally {
      database.exec("ROLLBACK");
    }

    database.exec("PRAGMA query_only = ON");
    await provider.transaction(async (transaction) => {
      assert.deepEqual(
        await transaction.queryAll(UI_PREFERENCES_STATEMENTS.list, { employeeNumber: "E1" }),
        [
          { preferenceKey: "font", value: "110" },
          { preferenceKey: "theme", value: "dark" },
        ],
      );
    }, { readOnly: true });
    assert.equal(database.prepare("PRAGMA query_only").get().query_only, 1);
    database.exec("PRAGMA query_only = OFF");

    const pendingRead = repository.get("E1", "theme");
    assert.throws(
      () => database.close(),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
    );
    assert.equal((await pendingRead).value, "dark");

    await provider.close();
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM portal_user_preferences").get().count,
      2,
    );
  } finally {
    await provider.close();
    database.close();
  }
});

test("v0.87 SQLite-Provider: Node-22-Fallback verfolgt benannte Savepoints und END-Segmente", async () => {
  const probe = definePersistenceStatement({
    id: "sqlite-provider.node-22-fallback-probe",
    operation: "queryOne",
    columns: { value: "safe_integer" },
  });
  const database = openSqliteLegacyDatabase(":memory:", {
    useNativeTransactionState: false,
  });
  const provider = createSqlitePersistenceProvider({
    database,
    catalog: [{
      statement: probe,
      sql: "SELECT 1 AS value",
      returning: false,
    }],
  });

  async function assertProviderBlocked() {
    await assert.rejects(
      provider.queryOne(probe),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
    );
  }

  async function assertProviderAvailable() {
    assert.deepEqual(await provider.queryOne(probe), { value: 1 });
  }

  try {
    database.exec("BEGIN EXCLUSIVE TRANSACTION");
    await assertProviderBlocked();
    database.exec("ROLLBACK TRANSACTION");
    await assertProviderAvailable();

    database.exec("SAVEPOINT outer");
    database.exec("SAVEPOINT inner");
    database.exec("ROLLBACK TRANSACTION TO SAVEPOINT outer");
    await assertProviderBlocked();
    database.exec("RELEASE SAVEPOINT outer");
    await assertProviderAvailable();

    database.exec("SAVEPOINT [Outer Name]");
    database.exec('SAVEPOINT "Inner Name"');
    database.exec("RELEASE SAVEPOINT [Outer Name]");
    await assertProviderAvailable();

    database.exec("BEGIN; END;");
    await assertProviderAvailable();
    database.exec("BEGIN IMMEDIATE TRANSACTION; END TRANSACTION;");
    await assertProviderAvailable();

    database.exec([
      "BEGIN;",
      "CREATE TABLE trigger_source(id INTEGER);",
      "CREATE TABLE trigger_log(id INTEGER);",
      "CREATE TRIGGER trigger_probe AFTER INSERT ON trigger_source BEGIN",
      "  INSERT INTO trigger_log(id) VALUES (NEW.id);",
      "END;",
    ].join("\n"));
    await assertProviderBlocked();
    database.exec("ROLLBACK");
    await assertProviderAvailable();
  } finally {
    await provider.close();
    database.close();
  }
});

test("v0.87 SQLite-Provider: Vertragstypen, RETURNING, Fehler und Rollback sind echt", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-sqlite-provider-"));
  const databasePath = path.join(directory, "provider.db");
  let provider;
  context.after(async () => {
    if (provider) await provider.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const schemaDatabase = openSqliteLegacyDatabase(databasePath);
  schemaDatabase.exec(`
    CREATE TABLE provider_values (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      large_value TEXT NOT NULL,
      amount TEXT NOT NULL,
      created_at TEXT NOT NULL,
      business_date TEXT NOT NULL,
      clock_time TEXT NOT NULL,
      metadata TEXT NOT NULL,
      payload BLOB NOT NULL
    );
    CREATE TABLE provider_required (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  schemaDatabase.close();

  provider = createSqlitePersistenceProvider({
    databasePath,
    catalog: VALUE_CATALOG,
  });
  const sourcePayload = Buffer.from([1, 2, 3, 4]);
  const input = {
    id: 1,
    enabled: true,
    largeValue: 9007199254740993n,
    amount: "1234567890.012300",
    createdAt: new Date("2026-07-29T12:34:56.789Z"),
    businessDate: "2026-07-29",
    clockTime: "14:34:56",
    metadata: { nested: [true, null, 7] },
    payload: sourcePayload,
  };
  const inserted = await provider.execute(VALUE_STATEMENTS.insert, input);
  assert.equal(inserted.rowsAffected, 1);
  assert.deepEqual(inserted.returnedRows, [{
    id: 1,
    enabled: true,
    largeValue: "9007199254740993",
    amount: "1234567890.012300",
    createdAt: "2026-07-29T12:34:56.789Z",
    businessDate: "2026-07-29",
    clockTime: "14:34:56",
    metadata: { nested: [true, null, 7] },
    payload: sourcePayload,
  }]);
  assert.notEqual(inserted.returnedRows[0].payload, sourcePayload);
  assert.equal(Object.isFrozen(inserted.returnedRows[0]), true);
  assert.equal(Object.isFrozen(inserted.returnedRows[0].metadata), true);
  assert.deepEqual(await provider.queryOne(VALUE_STATEMENTS.get, { id: 1 }), inserted.returnedRows[0]);

  const corruptor = openSqliteLegacyDatabase(databasePath);
  corruptor.prepare("UPDATE provider_values SET metadata = '{' WHERE id = 1").run();
  await assert.rejects(
    provider.queryOne(VALUE_STATEMENTS.get, { id: 1 }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.RESULT_INVALID),
  );
  corruptor.exec("PRAGMA ignore_check_constraints = ON");
  corruptor.prepare("UPDATE provider_values SET metadata = '{}', enabled = 2 WHERE id = 1").run();
  await assert.rejects(
    provider.queryOne(VALUE_STATEMENTS.get, { id: 1 }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.RESULT_INVALID),
  );
  corruptor.prepare("UPDATE provider_values SET enabled = 1, id = ? WHERE id = 1")
    .run(9007199254740992n);
  await assert.rejects(
    provider.queryAll(VALUE_STATEMENTS.all),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.RESULT_INVALID),
  );
  corruptor.prepare("UPDATE provider_values SET id = 1 WHERE id = ?").run(9007199254740992n);
  corruptor.close();

  await assert.rejects(provider.execute(VALUE_STATEMENTS.insert, {
    ...input,
    metadata: { secret: "SEHR-GEHEIM" },
  }), (error) => {
    assert.equal(error?.code, PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION);
    assert.equal(JSON.stringify(error).includes("SEHR-GEHEIM"), false);
    assert.equal(String(error.message).includes("SEHR-GEHEIM"), false);
    return true;
  });
  await assert.rejects(
    provider.execute(VALUE_STATEMENTS.insertRequired, { id: 1, value: null }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.NOT_NULL_VIOLATION),
  );
  const primaryError = new Error("fachlicher Rollback");
  await assert.rejects(
    provider.transaction(async (transaction) => {
      await transaction.execute(VALUE_STATEMENTS.insert, { ...input, id: 2 });
      throw primaryError;
    }),
    (error) => error === primaryError,
  );
  assert.equal(await provider.queryOne(VALUE_STATEMENTS.get, { id: 2 }), null);
  await provider.transaction(async (transaction) => {
    assert.deepEqual(
      await transaction.queryOne(VALUE_STATEMENTS.queryOnly),
      { enabled: true },
    );
    await assert.rejects(
      transaction.execute(VALUE_STATEMENTS.insertRequired, { id: 2, value: "no" }),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
    );
  }, { readOnly: true });
  assert.deepEqual(await provider.queryOne(VALUE_STATEMENTS.queryOnly), { enabled: false });

  const capabilities = provider.getCapabilities();
  assert.equal(capabilities.providerId, "sqlite");
  assert.equal(capabilities.features.atomicTransactions, true);
  assert.equal(capabilities.features.concurrentWrites, false);
  assert.equal(Object.isFrozen(capabilities), true);
});

test("v0.87 SQLite-Provider: konkurrierende Datei-Verbindung liefert BUSY und erholt sich", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-sqlite-busy-"));
  const databasePath = path.join(directory, "busy.db");
  const first = openSqliteApplicationPersistence({
    databasePath,
    catalog: VALUE_CATALOG,
  });
  first.database.exec(`
    CREATE TABLE provider_values (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      large_value TEXT NOT NULL,
      amount TEXT NOT NULL,
      created_at TEXT NOT NULL,
      business_date TEXT NOT NULL,
      clock_time TEXT NOT NULL,
      metadata TEXT NOT NULL,
      payload BLOB NOT NULL
    );
    CREATE TABLE provider_required (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const second = openSqliteApplicationPersistence({
    databasePath,
    catalog: VALUE_CATALOG,
  });
  second.database.exec("PRAGMA busy_timeout = 1");
  context.after(async () => {
    await Promise.allSettled([first.provider.close(), second.provider.close()]);
    first.database.close();
    second.database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  await first.provider.transaction(async (transaction) => {
    await transaction.execute(VALUE_STATEMENTS.insertRequired, { id: 1, value: "first" });
    await assert.rejects(
      second.provider.execute(VALUE_STATEMENTS.insertRequired, { id: 2, value: "second" }),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.BUSY),
    );
  });
  assert.deepEqual(
    await second.provider.execute(VALUE_STATEMENTS.insertRequired, { id: 2, value: "second" }),
    { rowsAffected: 1, returnedRows: [] },
  );
});

test("v0.87 SQLite-Provider: Katalogparameter und read-only Legacy-Öffnung scheitern geschlossen", (context) => {
  const invalidStatement = definePersistenceStatement({
    id: "sqlite-provider.invalid-placeholder",
    operation: "queryOne",
    parameters: { expected: "text" },
    columns: { value: "text" },
  });
  assert.throws(
    () => createSqlitePersistenceProvider({
      databasePath: ":memory:",
      catalog: [{
        statement: invalidStatement,
        sql: "SELECT $other AS value",
        returning: false,
      }],
    }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
  );
  const disguisedWrite = definePersistenceStatement({
    id: "sqlite-provider.disguised-write",
    operation: "queryOne",
    parameters: { value: "text" },
    columns: { value: "text" },
  });
  assert.throws(
    () => createSqlitePersistenceProvider({
      databasePath: ":memory:",
      catalog: [{
        statement: disguisedWrite,
        sql: "INSERT INTO values_table(value) VALUES ($value) RETURNING value",
        returning: false,
      }],
    }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-sqlite-readonly-"));
  const databasePath = path.join(directory, "readonly.db");
  let writable;
  let readOnly;
  context.after(() => {
    writable?.close();
    readOnly?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  writable = openSqliteLegacyDatabase(databasePath);
  writable.exec("CREATE TABLE values_table(value TEXT NOT NULL); INSERT INTO values_table VALUES ('ok')");
  writable.close();
  assert.throws(
    () => createSqlitePersistenceProvider({
      databasePath,
      catalog: [],
      closeDatabase: false,
    }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID),
  );
  readOnly = openSqliteLegacyDatabase(databasePath, { readOnly: true });
  assert.equal(readOnly.prepare("SELECT value FROM values_table").get().value, "ok");
  assert.throws(() => readOnly.prepare("INSERT INTO values_table VALUES ('no')").run());
});

test("v0.87 SQLite-Provider: Server-Testabschluss schließt Provider vor Datei und Lock", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-sqlite-lifecycle-"));
  context.after(() => fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  }));
  const databasePath = path.join(directory, "dienstplan.db");
  const script = `
    (async () => {
      const fs = require("node:fs");
      const { closePersistenceForTests } = require("./server");
      await closePersistenceForTests();
      fs.rmSync(process.env.GRABENPLANER_DATA_DIR, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = childProcess.spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BACKUP_DIR: path.join(directory, "backups"),
      DB_PATH: databasePath,
      GRABENPLANER_DATA_DIR: directory,
      GRABENPLANER_FORCE_PORTAL: "1",
      GRABENPLANER_HOST: "127.0.0.1",
      GRABENPLANER_SEED_DEMO: "0",
      NODE_ENV: "test",
      TZ: "Europe/Vienna",
    },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(directory), false);
});
