"use strict";

const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { test } = require("node:test");

const { Pool } = require("pg");
const {
  definePersistenceStatement,
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  createPlanningSettingsRepository,
} = require("../lib/persistence/repositories/planning-settings");
const {
  createPostgresqlPersistenceProvider,
} = require("../lib/persistence/postgresql/provider");
const {
  createPostgresqlPoolConfiguration,
  isLoopbackHostname,
} = require("../lib/persistence/postgresql/policy");
const {
  createPostgresqlPlanningSettingsSlice,
} = require("../lib/persistence/postgresql/planning-settings-catalog");
const {
  PLANNING_SETTINGS_STATEMENTS,
} = require("../lib/persistence/statements/planning-settings");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../lib/persistence/sqlite/application-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

const DATABASE_URL = String(process.env.TEST_POSTGRESQL_URL || "").trim();

function assertPlanningSourceContractDriftRejected(
  statementKey,
  alteredStatement,
) {
  const manifestPath = require.resolve(
    "../lib/persistence/dialects/application-manifest",
  );
  const statementsPath = require.resolve(
    "../lib/persistence/statements/planning-settings",
  );
  const catalogPath = require.resolve(
    "../lib/persistence/postgresql/planning-settings-catalog",
  );
  const manifestModule = require.cache[manifestPath];
  const statementsModule = require.cache[statementsPath];
  const originalCatalogModule = require.cache[catalogPath];
  assert.ok(manifestModule);
  assert.ok(statementsModule);
  assert.ok(originalCatalogModule);

  const originalManifestExports = manifestModule.exports;
  const originalStatementsExports = statementsModule.exports;
  const sourceManifest =
    originalManifestExports.SQLITE_APPLICATION_DIALECT_MANIFEST;
  const originalStatement =
    originalStatementsExports.PLANNING_SETTINGS_STATEMENTS[statementKey];
  const sourceEntry = sourceManifest.entries.find(
    (entry) => entry.statement === originalStatement,
  );
  assert.ok(sourceEntry);
  assert.equal(alteredStatement.id, originalStatement.id);

  const alteredEntries = Object.freeze(sourceManifest.entries.map((entry) => (
    entry === sourceEntry
      ? Object.freeze({ ...entry, statement: alteredStatement })
      : entry
  )));
  const alteredSourceEntry = alteredEntries.find(
    (entry) => entry.statement === alteredStatement,
  );
  assert.equal(alteredSourceEntry.sql, sourceEntry.sql);

  try {
    manifestModule.exports = Object.freeze({
      ...originalManifestExports,
      SQLITE_APPLICATION_DIALECT_MANIFEST: Object.freeze({
        ...sourceManifest,
        entries: alteredEntries,
      }),
    });
    statementsModule.exports = Object.freeze({
      ...originalStatementsExports,
      PLANNING_SETTINGS_STATEMENTS: Object.freeze({
        ...originalStatementsExports.PLANNING_SETTINGS_STATEMENTS,
        [statementKey]: alteredStatement,
      }),
    });
    delete require.cache[catalogPath];
    const alteredCatalog = require(catalogPath);
    assert.throws(
      () => alteredCatalog.createPostgresqlPlanningSettingsSlice({
        schemaName: "grabenplaner_contract",
      }),
      TypeError,
    );
  } finally {
    delete require.cache[catalogPath];
    require.cache[catalogPath] = originalCatalogModule;
    statementsModule.exports = originalStatementsExports;
    manifestModule.exports = originalManifestExports;
  }
}

function tlsModeFor(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return isLoopbackHostname(parsed.hostname)
    ? "disable-local-only"
    : "verify-full";
}

function schemaName() {
  return [
    "gp_planning_settings",
    process.pid,
    Date.now(),
    randomBytes(5).toString("hex"),
  ].join("_");
}

function hasPersistenceCode(code) {
  return (error) => error?.code === code;
}

function appendSettledFailures(errors, results) {
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
}

async function closeSqliteApplication(application) {
  const errors = [];
  try {
    await application.provider.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    application.database.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "SQLite-Planning-Fixture-Cleanup fehlgeschlagen.");
  }
}

async function exerciseSettings({ repository, transaction }) {
  assert.deepEqual(await repository.upsertSetting({
    key: "z-last",
    value: "{\"enabled\":true}",
  }), {
    rowsAffected: 1,
    rows: [],
  });
  await repository.upsertSetting({ key: "beta", value: "null" });
  await repository.upsertSetting({ key: "Alpha", value: "1" });
  assert.deepEqual(await repository.upsertSetting({
    key: "Alpha",
    value: "0",
  }), {
    rowsAffected: 1,
    rows: [],
  });

  await assert.rejects(
    transaction(async (transactionRepository) => {
      await transactionRepository.upsertSetting({
        key: "rolled_back",
        value: "no",
      });
      await transactionRepository.upsertSetting({
        key: null,
        value: "constraint",
      });
    }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
  );

  const rows = await repository.listSettings();
  assert.equal(rows.some(({ key }) => key === "rolled_back"), false);
  await assert.rejects(
    repository.upsertSetting({ key: null, value: "x" }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
  );
  return rows;
}

test("v0.87 DB Block 5: Planning-Settings-Slice ist reproduzierbar und bleibt ein Teilkatalog", () => {
  const first = createPostgresqlPlanningSettingsSlice({
    schemaName: "grabenplaner_contract",
  });
  const second = createPostgresqlPlanningSettingsSlice({
    schemaName: "grabenplaner_contract",
  });

  assert.equal(first.sliceId, "planning-settings.settings");
  assert.equal(first.status, "development-contract");
  assert.equal(first.developmentExecutable, true);
  assert.equal(first.executable, true);
  assert.equal(first.applicationExecutable, false);
  assert.equal(first.fullApplicationCatalog, false);
  assert.equal(first.productActivation, false);
  assert.equal(first.entries.length, 2);
  assert.equal(first.provenance.length, 2);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.provenance, first.provenance);
  assert.deepEqual(first.provenance.map(({ sourceSqlFingerprint }) => (
    sourceSqlFingerprint
  )), [
    "dee79ab93bdd749fc2a39ce867a5b8bd1c43deaf317d1aa7f9f96f94a1bce5ee",
    "3f9eed42456b70ba4dae8ebbd3083cc0a69d81f7c025c91c7e9a62cf9120e429",
  ]);
  assert.deepEqual(first.provenance.map(({ sourceContractFingerprint }) => (
    sourceContractFingerprint
  )), [
    "8c74e79c9abfcb1440c5d4609f0d6932849b8f921408a221f082a93b1ca6e57e",
    "3fc7914e883a9f0a2fa4ca88fec001953acc9a5da6bfc4703de362607a0a52f3",
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entries), true);
  assert.equal(Object.isFrozen(first.provenance), true);
  assert.match(first.entries[0].sql, /jsonb_build_object/);
  assert.match(first.entries[0].sql, /COLLATE "C" NULLS FIRST/);
  assert.deepEqual(first.provenance[0].semanticResolutions, [
    "postgresql.sqlite-binary-collation",
  ]);
  assert.match(first.entries[1].sql, /VALUES \(\s*\$1,\s*\$2\s*\)/);
  assert.deepEqual(
    first.entries[1].parameterBindings.map(({ parameter, source, path }) => ({
      parameter,
      source,
      path,
    })),
    [
      { parameter: "payload", source: "json-extract", path: ["key"] },
      { parameter: "payload", source: "json-extract", path: ["value"] },
    ],
  );

  for (const invalid of [
    "",
    "Public",
    "public;drop schema public",
    "has-dash",
    "a".repeat(64),
  ]) {
    assert.throws(
      () => createPostgresqlPlanningSettingsSlice({ schemaName: invalid }),
      TypeError,
    );
  }
});

test("v0.87 DB Block 5: Planning-Settings-Pins verwerfen Vertragsdrift bei identischem Quell-SQL", () => {
  const upsert = PLANNING_SETTINGS_STATEMENTS.upsertSetting;
  assertPlanningSourceContractDriftRejected(
    "upsertSetting",
    definePersistenceStatement({
      id: upsert.id,
      operation: upsert.operation,
      parameters: {
        payload: {
          ...upsert.parameters.payload,
          nullable: true,
          optional: true,
        },
      },
      columns: upsert.columns,
    }),
  );

  const list = PLANNING_SETTINGS_STATEMENTS.listSettings;
  assertPlanningSourceContractDriftRejected(
    "listSettings",
    definePersistenceStatement({
      id: list.id,
      operation: list.operation,
      parameters: list.parameters,
      columns: {
        data: {
          ...list.columns.data,
          kind: "text",
        },
      },
    }),
  );
});

if (!DATABASE_URL) {
  test("v0.87 DB Block 5: Planning-Settings-Parität benötigt TEST_POSTGRESQL_URL", {
    skip: "TEST_POSTGRESQL_URL ist nicht gesetzt; die reale Dual-Provider-Fixture bleibt lokal aus.",
  }, () => {});
} else {
  test("v0.87 DB Block 5: Planning-Settings sind auf SQLite und PostgreSQL fachlich gleich", async () => {
    const schema = schemaName();
    const quotedSchema = `"${schema}"`;
    const configuration = createPostgresqlPoolConfiguration({
      databaseUrl: DATABASE_URL,
      tlsMode: tlsModeFor(DATABASE_URL),
      applicationName: "grabenplaner-db5-planning-settings",
      policy: {
        maximumConnections: 4,
        connectionTimeoutMilliseconds: 3_000,
        idleTimeoutMilliseconds: 1_000,
        statementTimeoutMilliseconds: 5_000,
        queryTimeoutMilliseconds: 6_000,
        transactionTimeoutMilliseconds: 10_000,
        maximumConnectionLifetimeSeconds: 60,
      },
      allowExitOnIdle: true,
    });
    const adminPool = new Pool(configuration);
    let postgresqlProvider;
    let applicationPool;
    let sqliteApplication;
    try {
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      await adminPool.query(`
        CREATE TABLE ${quotedSchema}."settings" (
          "key" TEXT PRIMARY KEY,
          "value" TEXT NOT NULL
        )
      `);

      applicationPool = new Pool(configuration);
      const slice = createPostgresqlPlanningSettingsSlice({ schemaName: schema });
      postgresqlProvider = createPostgresqlPersistenceProvider({
        pool: applicationPool,
        catalog: slice.entries,
        poolOwnership: "provider",
        acquireTimeoutMilliseconds: configuration.connectionTimeoutMillis,
      });
      const postgresqlRepository = createPlanningSettingsRepository(
        postgresqlProvider,
      );

      sqliteApplication = openSqliteApplicationPersistence({
        databasePath: ":memory:",
        catalog: SQLITE_APPLICATION_CATALOG,
      });
      ensureSqliteApplicationSchema(sqliteApplication.database);
      const sqliteRepository = createPlanningSettingsRepository(
        sqliteApplication.provider,
      );

      const sqliteResult = await exerciseSettings({
        repository: sqliteRepository,
        transaction: (work) => sqliteApplication.provider.transaction(
          (executor) => work(createPlanningSettingsRepository(executor)),
        ),
      });
      const postgresqlResult = await exerciseSettings({
        repository: postgresqlRepository,
        transaction: (work) => postgresqlProvider.transaction(
          (executor) => work(createPlanningSettingsRepository(executor)),
        ),
      });
      assert.deepEqual(postgresqlResult, sqliteResult);
      assert.deepEqual(postgresqlResult, [
        { key: "Alpha", value: "0" },
        { key: "beta", value: "null" },
        { key: "z-last", value: "{\"enabled\":true}" },
      ]);
    } finally {
      const cleanupErrors = [];
      appendSettledFailures(cleanupErrors, await Promise.allSettled([
        postgresqlProvider?.close(),
        !postgresqlProvider && applicationPool
          ? applicationPool.end()
          : null,
        sqliteApplication
          ? closeSqliteApplication(sqliteApplication)
          : null,
      ].filter(Boolean)));
      try {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        try {
          await adminPool.end();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Planning-Fixture-Cleanup fehlgeschlagen.");
      }
    }
  });
}
