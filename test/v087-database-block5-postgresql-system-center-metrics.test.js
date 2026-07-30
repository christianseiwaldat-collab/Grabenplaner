"use strict";

const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { test } = require("node:test");

const { Pool } = require("pg");
const {
  definePersistenceStatement,
} = require("../lib/persistence/contract");
const {
  createSystemCenterMetricsRepository,
} = require("../lib/persistence/repositories/system-center-metrics");
const {
  createPostgresqlPersistenceProvider,
} = require("../lib/persistence/postgresql/provider");
const {
  createPostgresqlPoolConfiguration,
  isLoopbackHostname,
} = require("../lib/persistence/postgresql/policy");
const {
  createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice,
} = require("../lib/persistence/postgresql/system-center-metrics-catalog");
const {
  SYSTEM_CENTER_METRICS_STATEMENTS,
} = require("../lib/persistence/statements/system-center-metrics");
const {
  SQLITE_SYSTEM_CENTER_METRICS_CATALOG,
} = require("../lib/persistence/sqlite/system-center-metrics-catalog");
const {
  ensureSqliteSystemCenterMetricsSchema,
} = require("../lib/persistence/sqlite/operations/system-center-metrics-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

const DATABASE_URL = String(process.env.TEST_POSTGRESQL_URL || "").trim();
const FIXTURE_ROWS = Object.freeze([
  Object.freeze({
    intervalKey: "a",
    recordedAt: "2026-07-29T00:00:00.000Z",
    sampleHash: "2".repeat(64),
  }),
  Object.freeze({
    intervalKey: "A",
    recordedAt: "2026-07-29T00:00:00.000Z",
    sampleHash: "1".repeat(64),
  }),
  Object.freeze({
    intervalKey: "later-1",
    recordedAt: "2026-07-29T06:00:00.000Z",
    sampleHash: "3".repeat(64),
  }),
  Object.freeze({
    intervalKey: "later-2",
    recordedAt: "2026-07-29T12:00:00.000Z",
    sampleHash: "4".repeat(64),
  }),
]);

function assertMetricsSourceContractDriftRejected(alteredStatement) {
  const manifestPath = require.resolve(
    "../lib/persistence/dialects/application-manifest",
  );
  const statementsPath = require.resolve(
    "../lib/persistence/statements/system-center-metrics",
  );
  const catalogPath = require.resolve(
    "../lib/persistence/postgresql/system-center-metrics-catalog",
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
    originalStatementsExports.SYSTEM_CENTER_METRICS_STATEMENTS
      .oldestIntervalKeys;
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
      SYSTEM_CENTER_METRICS_STATEMENTS: Object.freeze({
        ...originalStatementsExports.SYSTEM_CENTER_METRICS_STATEMENTS,
        oldestIntervalKeys: alteredStatement,
      }),
    });
    delete require.cache[catalogPath];
    const alteredCatalog = require(catalogPath);
    assert.throws(
      () => (
        alteredCatalog
          .createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice({
            schemaName: "grabenplaner_contract",
          })
      ),
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
    "gp_system_center_metrics",
    process.pid,
    Date.now(),
    randomBytes(5).toString("hex"),
  ].join("_");
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
    throw new AggregateError(errors, "SQLite-System-Center-Fixture-Cleanup fehlgeschlagen.");
  }
}

function seedSqlite(database) {
  const insert = database.prepare(`
    INSERT INTO system_center_trust_metrics (
      interval_key,
      recorded_at,
      trust_score,
      coverage,
      trust_state,
      database_bytes,
      storage_free_bytes,
      automation_state,
      previous_hash,
      sample_hash
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [index, row] of FIXTURE_ROWS.entries()) {
    insert.run(
      row.intervalKey,
      row.recordedAt,
      90 + index,
      100,
      "healthy",
      4_294_967_296 + index,
      8_589_934_592 - index,
      "healthy",
      null,
      row.sampleHash,
    );
  }
}

async function seedPostgresql(pool, relation) {
  for (const [index, row] of FIXTURE_ROWS.entries()) {
    await pool.query(`
      INSERT INTO ${relation} (
        interval_key,
        recorded_at,
        trust_score,
        coverage,
        trust_state,
        database_bytes,
        storage_free_bytes,
        automation_state,
        previous_hash,
        sample_hash
      )
      VALUES (
        $1,
        $2::timestamptz,
        $3,
        $4,
        $5,
        $6::bigint,
        $7::bigint,
        $8,
        $9,
        $10
      )
    `, [
      row.intervalKey,
      row.recordedAt,
      90 + index,
      100,
      "healthy",
      4_294_967_296 + index,
      8_589_934_592 - index,
      "healthy",
      null,
      row.sampleHash,
    ]);
  }
}

test("v0.87 DB Block 5: System-Center-Intervallschlüssel bleiben ein reproduzierbarer 1/1-Teilslice", () => {
  const first = createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice({
    schemaName: "grabenplaner_contract",
  });
  const second = createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice({
    schemaName: "grabenplaner_contract",
  });

  assert.equal(first.sliceId, "system-center-metrics.oldest-interval-keys");
  assert.equal(first.status, "development-contract");
  assert.equal(first.developmentExecutable, true);
  assert.equal(first.executable, true);
  assert.equal(first.applicationExecutable, false);
  assert.equal(first.fullApplicationCatalog, false);
  assert.equal(first.productActivation, false);
  assert.equal(first.entries.length, 1);
  assert.equal(first.provenance.length, 1);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.provenance, first.provenance);
  assert.equal(
    first.provenance[0].sourceSqlFingerprint,
    "42efae0da6207fcdce1ec7307922162d7edfdc741efa4f7c5a5c48b26d7a09e1",
  );
  assert.equal(
    first.provenance[0].sourceContractFingerprint,
    "a45dc726dd8bee65f063bc4493502041bb95e07b070d57d9e67610b9c13b686b",
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entries), true);
  assert.equal(Object.isFrozen(first.provenance), true);

  const [entry] = first.entries;
  assert.equal(
    entry.statement.id,
    "system-center-metrics.oldest-interval-keys",
  );
  assert.equal(entry.returning, false);
  assert.deepEqual(entry.parameterOrder, ["limit"]);
  assert.deepEqual(
    entry.parameterBindings.map(({ parameter, source, path }) => ({
      parameter,
      source,
      path,
    })),
    [{ parameter: "limit", source: "value", path: [] }],
  );
  assert.match(
    entry.sql,
    /FROM "grabenplaner_contract"\."system_center_trust_metrics"/,
  );
  assert.match(entry.sql, /SELECT interval_key AS "intervalKey"/);
  assert.match(
    entry.sql,
    /recorded_at ASC NULLS FIRST,\s+interval_key COLLATE "C" ASC NULLS FIRST/,
  );
  assert.match(entry.sql, /LIMIT \$1::bigint/);
  assert.deepEqual(first.provenance[0].semanticResolutions, [
    "postgresql.sqlite-binary-collation",
  ]);
  assert.equal(first.provenance[0].sourceStrategy, "portable-generated");

  for (const invalid of [
    "",
    "Public",
    "public;drop schema public",
    "has-dash",
    "a".repeat(64),
  ]) {
    assert.throws(
      () => createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice({
        schemaName: invalid,
      }),
      TypeError,
    );
  }
});

test("v0.87 DB Block 5: System-Center-Pins verwerfen Vertragsdrift bei identischem Quell-SQL", () => {
  const statement = SYSTEM_CENTER_METRICS_STATEMENTS.oldestIntervalKeys;
  assertMetricsSourceContractDriftRejected(definePersistenceStatement({
    id: statement.id,
    operation: statement.operation,
    parameters: {
      limit: {
        ...statement.parameters.limit,
        nullable: true,
        optional: true,
      },
    },
    columns: statement.columns,
  }));
  assertMetricsSourceContractDriftRejected(definePersistenceStatement({
    id: statement.id,
    operation: statement.operation,
    parameters: statement.parameters,
    columns: {
      intervalKey: {
        ...statement.columns.intervalKey,
        kind: "date",
      },
    },
  }));
});

if (!DATABASE_URL) {
  test("v0.87 DB Block 5: System-Center-Intervallschlüsselparität benötigt TEST_POSTGRESQL_URL", {
    skip: "TEST_POSTGRESQL_URL ist nicht gesetzt; die reale Dual-Provider-Fixture bleibt lokal aus.",
  }, () => {});
} else {
  test("v0.87 DB Block 5: älteste Intervallschlüssel sind auf SQLite und PostgreSQL gleich", async () => {
    const schema = schemaName();
    const quotedSchema = `"${schema}"`;
    const relation = `${quotedSchema}."system_center_trust_metrics"`;
    const configuration = createPostgresqlPoolConfiguration({
      databaseUrl: DATABASE_URL,
      tlsMode: tlsModeFor(DATABASE_URL),
      applicationName: "grabenplaner-db5-system-center-metrics",
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
        CREATE TABLE ${relation} (
          interval_key TEXT NOT NULL PRIMARY KEY,
          recorded_at TIMESTAMPTZ(3) NOT NULL,
          trust_score INTEGER NOT NULL,
          coverage INTEGER NOT NULL,
          trust_state TEXT NOT NULL,
          database_bytes BIGINT,
          storage_free_bytes BIGINT,
          automation_state TEXT NOT NULL,
          previous_hash TEXT,
          sample_hash TEXT NOT NULL UNIQUE
        )
      `);
      await seedPostgresql(adminPool, relation);

      applicationPool = new Pool(configuration);
      const slice =
        createPostgresqlSystemCenterMetricsOldestIntervalKeysSlice({
          schemaName: schema,
        });
      postgresqlProvider = createPostgresqlPersistenceProvider({
        pool: applicationPool,
        catalog: slice.entries,
        poolOwnership: "provider",
        acquireTimeoutMilliseconds: configuration.connectionTimeoutMillis,
      });
      const postgresqlRepository = createSystemCenterMetricsRepository(
        postgresqlProvider,
      );

      sqliteApplication = openSqliteApplicationPersistence({
        databasePath: ":memory:",
        catalog: SQLITE_SYSTEM_CENTER_METRICS_CATALOG,
      });
      ensureSqliteSystemCenterMetricsSchema(sqliteApplication.database);
      seedSqlite(sqliteApplication.database);
      const sqliteRepository = createSystemCenterMetricsRepository(
        sqliteApplication.provider,
      );

      const sqliteResult = await sqliteRepository.oldestIntervalKeys(2);
      const postgresqlResult =
        await postgresqlRepository.oldestIntervalKeys(2);
      assert.deepEqual(postgresqlResult, sqliteResult);
      assert.deepEqual(postgresqlResult, [
        { intervalKey: "A" },
        { intervalKey: "a" },
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
        throw new AggregateError(
          cleanupErrors,
          "System-Center-Fixture-Cleanup fehlgeschlagen.",
        );
      }
    }
  });
}
