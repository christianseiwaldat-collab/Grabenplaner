"use strict";

const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const {
  test,
} = require("node:test");

const { Pool } = require("pg");
const {
  definePersistenceStatement,
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  createUiPreferencesRepository,
} = require("../lib/persistence/repositories/ui-preferences");
const {
  createPostgresqlPersistenceProvider,
} = require("../lib/persistence/postgresql/provider");
const {
  createPostgresqlPoolConfiguration,
  isLoopbackHostname,
} = require("../lib/persistence/postgresql/policy");
const {
  createPostgresqlUiPreferencesSlice,
} = require("../lib/persistence/postgresql/ui-preferences-catalog");
const {
  UI_PREFERENCES_STATEMENTS,
} = require("../lib/persistence/statements/ui-preferences");
const {
  createSqliteApplicationFixture,
} = require("../test-support/sqlite-application-fixture");

const DATABASE_URL = String(process.env.TEST_POSTGRESQL_URL || "").trim();

function assertUiSourceContractDriftRejected(statementKey, alteredStatement) {
  const manifestPath = require.resolve(
    "../lib/persistence/dialects/application-manifest",
  );
  const statementsPath = require.resolve(
    "../lib/persistence/statements/ui-preferences",
  );
  const catalogPath = require.resolve(
    "../lib/persistence/postgresql/ui-preferences-catalog",
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
    originalStatementsExports.UI_PREFERENCES_STATEMENTS[statementKey];
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
      UI_PREFERENCES_STATEMENTS: Object.freeze({
        ...originalStatementsExports.UI_PREFERENCES_STATEMENTS,
        [statementKey]: alteredStatement,
      }),
    });
    delete require.cache[catalogPath];
    const alteredCatalog = require(catalogPath);
    assert.throws(
      () => alteredCatalog.createPostgresqlUiPreferencesSlice({
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

function hasPersistenceCode(code) {
  return (error) => error?.code === code;
}

function appendSettledFailures(errors, results) {
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
}

function schemaName() {
  return [
    "gp_ui_preferences",
    process.pid,
    Date.now(),
    randomBytes(5).toString("hex"),
  ].join("_");
}

async function exerciseUiPreferences({
  repository,
  transaction,
}) {
  assert.deepEqual(await repository.saveChanges("E1", {
    upserts: [
      { preferenceKey: "theme", value: "dark" },
      { preferenceKey: "beta", value: "2" },
      { preferenceKey: "Alpha", value: "1" },
      { preferenceKey: "Zeta", value: "4" },
      { preferenceKey: "Äpfel", value: "5" },
    ],
  }), {
    upserted: 5,
    deleted: 0,
  });
  assert.deepEqual(await repository.upsert("E'2", "theme", "light"), {
    rowsAffected: 1,
    returnedRows: [],
  });
  assert.deepEqual(await repository.list("E1"), [
    { preferenceKey: "Alpha", value: "1" },
    { preferenceKey: "beta", value: "2" },
    { preferenceKey: "theme", value: "dark" },
    { preferenceKey: "Zeta", value: "4" },
    { preferenceKey: "Äpfel", value: "5" },
  ]);
  assert.deepEqual(await repository.get("E1", "theme"), {
    preferenceKey: "theme",
    value: "dark",
  });

  const transactionResult = await transaction(async (transactionRepository) => {
    assert.deepEqual(await transactionRepository.saveChanges("E1", {
      deleteKeys: ["theme"],
      upserts: [{ preferenceKey: "density", value: "compact" }],
    }), {
      upserted: 1,
      deleted: 1,
    });
    return transactionRepository.list("E1");
  });
  assert.deepEqual(transactionResult, [
    { preferenceKey: "Alpha", value: "1" },
    { preferenceKey: "beta", value: "2" },
    { preferenceKey: "density", value: "compact" },
    { preferenceKey: "Zeta", value: "4" },
    { preferenceKey: "Äpfel", value: "5" },
  ]);

  await assert.rejects(
    transaction(async (transactionRepository) => {
      await transactionRepository.saveChanges("E1", {
        upserts: [
          { preferenceKey: "rolled_back", value: "no" },
          { preferenceKey: "reject", value: "constraint" },
        ],
      });
    }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.CHECK_VIOLATION),
  );
  assert.equal(await repository.get("E1", "rolled_back"), null);
  await assert.rejects(
    repository.upsert("UNKNOWN", "theme", "dark"),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION),
  );

  return Object.freeze({
    employeeWithQuote: await repository.list("E'2"),
    final: await repository.list("E1"),
  });
}

test("v0.87 DB Block 5: UI-Präferenzslice ist vollständig, reproduzierbar und nicht der Vollkatalog", () => {
  const first = createPostgresqlUiPreferencesSlice({
    schemaName: "grabenplaner_contract",
  });
  const second = createPostgresqlUiPreferencesSlice({
    schemaName: "grabenplaner_contract",
  });

  assert.equal(first.sliceId, "ui-preferences");
  assert.equal(first.status, "development-contract");
  assert.equal(first.developmentExecutable, true);
  assert.equal(first.executable, true);
  assert.equal(first.applicationExecutable, false);
  assert.equal(first.fullApplicationCatalog, false);
  assert.equal(first.productActivation, false);
  assert.equal(first.entries.length, 4);
  assert.equal(first.provenance.length, 4);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.provenance, first.provenance);
  assert.deepEqual(first.provenance.map(({ sourceSqlFingerprint }) => (
    sourceSqlFingerprint
  )), [
    "a5e754218fc6112ca2ca90fa0da9b57993e5a9629ee15a15d9187df171ffe80b",
    "1dbcefff30d9dabbafa3500811b6c943dc668e9efdf33ac3cae14aacf8df5398",
    "54ee217d1a766611187fc5d1abf4f1e7f95d4f573067e02f8bde4722b32f265a",
    "80891b5a2cfb6e0e5cd8e47f43d58c2bf9e2b4815f8752c15bdba40e9ee242a2",
  ]);
  assert.deepEqual(first.provenance.map(({ sourceContractFingerprint }) => (
    sourceContractFingerprint
  )), [
    "26d43be6ba111caa6f80e450a62c14c810e8f7dc8070466d81f965352e744d6a",
    "4f5196ccf0716128e513c6be4e84351f9b4804e83f106bd6387ed9c044ab0b95",
    "14323490141f806cc70a23bb4d256258dee3fc9e334383f4a8bd3f041909c126",
    "207005efe439461f52780ece0ba94c4ac434e44d4fa86faa7b44f80ddf9a7720",
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entries), true);
  assert.equal(Object.isFrozen(first.provenance), true);
  assert.deepEqual(first.provenance[0].resolvedFeatures, [
    "sqlite.collate-nocase",
  ]);
  assert.equal(
    first.entries.every((entry) => (
      entry.sql.includes('"grabenplaner_contract"."portal_user_preferences"')
    )),
    true,
  );

  for (const invalid of [
    "",
    "Public",
    "public;drop schema public",
    "has-dash",
    "a".repeat(64),
  ]) {
    assert.throws(
      () => createPostgresqlUiPreferencesSlice({ schemaName: invalid }),
      TypeError,
    );
  }
});

test("v0.87 DB Block 5: UI-Praeferenzpins verwerfen Vertragsdrift bei identischem Quell-SQL", () => {
  const list = UI_PREFERENCES_STATEMENTS.list;
  assertUiSourceContractDriftRejected("list", definePersistenceStatement({
    id: list.id,
    operation: list.operation,
    parameters: {
      ...list.parameters,
      employeeNumber: {
        ...list.parameters.employeeNumber,
        nullable: true,
        optional: true,
      },
    },
    columns: list.columns,
  }));
  assertUiSourceContractDriftRejected("list", definePersistenceStatement({
    id: list.id,
    operation: list.operation,
    parameters: list.parameters,
    columns: Object.fromEntries(Object.entries(list.columns).reverse()),
  }));
});

if (!DATABASE_URL) {
  test("v0.87 DB Block 5: UI-Präferenzparität benötigt TEST_POSTGRESQL_URL", {
    skip: "TEST_POSTGRESQL_URL ist nicht gesetzt; die reale Dual-Provider-Fixture bleibt lokal aus.",
  }, () => {});
} else {
  test("v0.87 DB Block 5: UI-Präferenzen sind auf SQLite und PostgreSQL fachlich gleich", async () => {
    const schema = schemaName();
    const quotedSchema = `"${schema}"`;
    const configuration = createPostgresqlPoolConfiguration({
      databaseUrl: DATABASE_URL,
      tlsMode: tlsModeFor(DATABASE_URL),
      applicationName: "grabenplaner-db5-ui-preferences",
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
    let sqliteFixture;
    try {
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      await adminPool.query(`
        CREATE TABLE ${quotedSchema}."portal_users" (
          employee_number TEXT PRIMARY KEY
        )
      `);
      await adminPool.query(`
        CREATE TABLE ${quotedSchema}."portal_user_preferences" (
          employee_number TEXT NOT NULL,
          preference_key TEXT NOT NULL CHECK (preference_key <> 'reject'),
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (employee_number, preference_key),
          FOREIGN KEY (employee_number)
            REFERENCES ${quotedSchema}."portal_users" (employee_number)
            ON UPDATE CASCADE
            ON DELETE CASCADE
        )
      `);
      await adminPool.query(`
        INSERT INTO ${quotedSchema}."portal_users" (employee_number)
        VALUES ('E1'), ('E''2')
      `);

      applicationPool = new Pool(configuration);
      const slice = createPostgresqlUiPreferencesSlice({ schemaName: schema });
      postgresqlProvider = createPostgresqlPersistenceProvider({
        pool: applicationPool,
        catalog: slice.entries,
        poolOwnership: "provider",
        acquireTimeoutMilliseconds: configuration.connectionTimeoutMillis,
      });
      const postgresqlRepository = createUiPreferencesRepository(postgresqlProvider);
      sqliteFixture = await createSqliteApplicationFixture({
        employeeNumbers: ["E1", "E'2"],
      });

      const sqliteResult = await exerciseUiPreferences({
        repository: sqliteFixture.repositories.uiPreferences,
        transaction: (work) => sqliteFixture.transaction((repositories) => (
          work(repositories.uiPreferences)
        )),
      });
      const postgresqlResult = await exerciseUiPreferences({
        repository: postgresqlRepository,
        transaction: (work) => postgresqlProvider.transaction((executor) => (
          work(createUiPreferencesRepository(executor))
        )),
      });
      assert.deepEqual(postgresqlResult, sqliteResult);
    } finally {
      const cleanupErrors = [];
      appendSettledFailures(cleanupErrors, await Promise.allSettled([
        postgresqlProvider?.close(),
        !postgresqlProvider && applicationPool
          ? applicationPool.end()
          : null,
        sqliteFixture?.close(),
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
        throw new AggregateError(cleanupErrors, "UI-Präferenz-Fixture-Cleanup fehlgeschlagen.");
      }
    }
  });
}
