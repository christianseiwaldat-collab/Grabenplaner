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
  createOrganizationPersonnelRepository,
} = require("../lib/persistence/repositories/organization-personnel");
const {
  createPostgresqlOrganizationDepartmentsSlice,
} = require("../lib/persistence/postgresql/organization-departments-catalog");
const {
  ORGANIZATION_PERSONNEL_STATEMENTS,
} = require("../lib/persistence/statements/organization-personnel");
const {
  createPostgresqlPersistenceProvider,
} = require("../lib/persistence/postgresql/provider");
const {
  createPostgresqlPoolConfiguration,
  isLoopbackHostname,
} = require("../lib/persistence/postgresql/policy");
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
const FIXED_TIMESTAMP = "2026-07-29 12:34:56";

function assertDepartmentSourceContractDriftRejected(
  statementKey,
  alteredStatement,
) {
  const manifestPath = require.resolve(
    "../lib/persistence/dialects/application-manifest",
  );
  const statementsPath = require.resolve(
    "../lib/persistence/statements/organization-personnel",
  );
  const catalogPath = require.resolve(
    "../lib/persistence/postgresql/organization-departments-catalog",
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
    originalStatementsExports.ORGANIZATION_PERSONNEL_STATEMENTS[statementKey];
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
      ORGANIZATION_PERSONNEL_STATEMENTS: Object.freeze({
        ...originalStatementsExports.ORGANIZATION_PERSONNEL_STATEMENTS,
        [statementKey]: alteredStatement,
      }),
    });
    delete require.cache[catalogPath];
    const alteredCatalog = require(catalogPath);
    assert.throws(
      () => alteredCatalog.createPostgresqlOrganizationDepartmentsSlice({
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
    "gp_organization_departments",
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
    throw new AggregateError(errors, "SQLite-Abteilungs-Fixture-Cleanup fehlgeschlagen.");
  }
}

async function exerciseDepartments({ repository, setFixedTimestamps }) {
  assert.equal(await repository.insertDepartment({
    locationId: "18",
    name: "Active",
    minStaff: 2,
    active: true,
  }, 1), 1);
  assert.equal(await repository.insertDepartment({
    locationId: "18",
    name: "Inactive",
    minStaff: 0,
    active: false,
  }, 2), 2);
  await setFixedTimestamps();

  assert.deepEqual(
    (await repository.listDepartments(false)).map(({ name }) => name),
    ["Active"],
  );
  await assert.rejects(
    repository.transaction(async (transactionRepository) => {
      await transactionRepository.insertDepartment({
        locationId: "18",
        name: "rolled_back",
        minStaff: 1,
        active: true,
      }, 3);
      await transactionRepository.insertDepartment({
        locationId: "18",
        name: "Active",
        minStaff: 1,
        active: true,
      }, 4);
    }),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION),
  );
  assert.equal(
    (await repository.listDepartments(true)).some(
      ({ name }) => name === "rolled_back",
    ),
    false,
  );
  await assert.rejects(
    repository.insertDepartment({
      locationId: "UNKNOWN",
      name: "No location",
      minStaff: 1,
      active: true,
    }, 5),
    hasPersistenceCode(PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION),
  );
  return repository.listDepartments(true);
}

test("v0.87 DB Block 5: Abteilungsslice löst Boolean-, Zeit- und Sortiersemantik explizit", () => {
  const first = createPostgresqlOrganizationDepartmentsSlice({
    schemaName: "grabenplaner_contract",
  });
  const second = createPostgresqlOrganizationDepartmentsSlice({
    schemaName: "grabenplaner_contract",
  });

  assert.equal(first.sliceId, "organization-personnel.departments");
  assert.equal(first.status, "development-contract");
  assert.equal(first.developmentExecutable, true);
  assert.equal(first.executable, true);
  assert.equal(first.applicationExecutable, false);
  assert.equal(first.fullApplicationCatalog, false);
  assert.equal(first.productActivation, false);
  assert.equal(first.entries.length, 2);
  assert.equal(first.provenance.length, 2);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(first.provenance.map(({ sourceSqlFingerprint }) => (
    sourceSqlFingerprint
  )), [
    "3eb06062c167dfa3e8471eb959588c0acca41ad21187b4118bd287a0d55e31a9",
    "1ad3873e0d8e9c3c655528646a6f802331f2da475dd72f0b4884e8fe26efbe6a",
  ]);
  assert.deepEqual(first.provenance.map(({ sourceContractFingerprint }) => (
    sourceContractFingerprint
  )), [
    "a5ec6577da503df2838d0a62df6848e2180fb98c289b9f23d13a635caa3cf7ca",
    "d38671fdf3da24ce2337b47b8955d775260e0f66adfdd7c10c844bce185a2b12",
  ]);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(first.entries[0].sql, /WHERE \$1 OR active/);
  assert.match(first.entries[0].sql, /AT TIME ZONE 'UTC'/);
  assert.match(first.entries[0].sql, /COLLATE "C"/);
  assert.match(first.entries[1].sql, /RETURNING id/);
  assert.deepEqual(first.provenance[0].semanticResolutions, [
    "postgresql.boolean-predicate",
    "postgresql.sqlite-binary-collation",
    "postgresql.sqlite-utc-timestamp-text",
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entries), true);
  assert.equal(Object.isFrozen(first.provenance), true);

  for (const invalid of [
    "",
    "Public",
    "public;drop schema public",
    "has-dash",
    "a".repeat(64),
  ]) {
    assert.throws(
      () => createPostgresqlOrganizationDepartmentsSlice({
        schemaName: invalid,
      }),
      TypeError,
    );
  }
});

test("v0.87 DB Block 5: Abteilungspins verwerfen Vertragsdrift bei identischem Quell-SQL", () => {
  const list = ORGANIZATION_PERSONNEL_STATEMENTS.listDepartments;
  assertDepartmentSourceContractDriftRejected(
    "listDepartments",
    definePersistenceStatement({
      id: list.id,
      operation: list.operation,
      parameters: {
        includeInactive: {
          ...list.parameters.includeInactive,
          nullable: true,
          optional: true,
        },
      },
      columns: list.columns,
    }),
  );
  assertDepartmentSourceContractDriftRejected(
    "listDepartments",
    definePersistenceStatement({
      id: list.id,
      operation: list.operation,
      parameters: list.parameters,
      columns: Object.fromEntries(Object.entries(list.columns).reverse()),
    }),
  );
});

if (!DATABASE_URL) {
  test("v0.87 DB Block 5: Abteilungsparität benötigt TEST_POSTGRESQL_URL", {
    skip: "TEST_POSTGRESQL_URL ist nicht gesetzt; die reale Dual-Provider-Fixture bleibt lokal aus.",
  }, () => {});
} else {
  test("v0.87 DB Block 5: Abteilungen sind auf SQLite und PostgreSQL fachlich gleich", async () => {
    const schema = schemaName();
    const quotedSchema = `"${schema}"`;
    const configuration = createPostgresqlPoolConfiguration({
      databaseUrl: DATABASE_URL,
      tlsMode: tlsModeFor(DATABASE_URL),
      applicationName: "grabenplaner-db5-organization-departments",
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
        CREATE TABLE ${quotedSchema}."locations" (
          id TEXT PRIMARY KEY
        )
      `);
      await adminPool.query(`
        CREATE TABLE ${quotedSchema}."departments" (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          location_id TEXT NOT NULL,
          name TEXT NOT NULL,
          min_staff INTEGER NOT NULL DEFAULT 0,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (location_id, name),
          FOREIGN KEY (location_id)
            REFERENCES ${quotedSchema}."locations" (id)
            ON UPDATE CASCADE
            ON DELETE CASCADE
        )
      `);
      await adminPool.query(`
        INSERT INTO ${quotedSchema}."locations" (id) VALUES ('18')
      `);

      applicationPool = new Pool(configuration);
      const slice = createPostgresqlOrganizationDepartmentsSlice({
        schemaName: schema,
      });
      postgresqlProvider = createPostgresqlPersistenceProvider({
        pool: applicationPool,
        catalog: slice.entries,
        poolOwnership: "provider",
        acquireTimeoutMilliseconds: configuration.connectionTimeoutMillis,
      });
      const postgresqlRepository = createOrganizationPersonnelRepository(
        postgresqlProvider,
      );

      sqliteApplication = openSqliteApplicationPersistence({
        databasePath: ":memory:",
        catalog: SQLITE_APPLICATION_CATALOG,
      });
      ensureSqliteApplicationSchema(sqliteApplication.database);
      sqliteApplication.database.prepare(`
        INSERT INTO locations (id, name, min_staff, active)
        VALUES ('18', 'Filiale 18', 0, 1)
      `).run();
      const sqliteRepository = createOrganizationPersonnelRepository(
        sqliteApplication.provider,
      );

      const sqliteResult = await exerciseDepartments({
        repository: sqliteRepository,
        setFixedTimestamps: async () => {
          sqliteApplication.database.prepare(`
            UPDATE departments SET created_at = ?
          `).run(FIXED_TIMESTAMP);
        },
      });
      const postgresqlResult = await exerciseDepartments({
        repository: postgresqlRepository,
        setFixedTimestamps: () => adminPool.query(`
          UPDATE ${quotedSchema}."departments"
          SET created_at = $1::timestamp AT TIME ZONE 'UTC'
        `, [FIXED_TIMESTAMP]),
      });

      assert.deepEqual(postgresqlResult, sqliteResult);
      assert.deepEqual(postgresqlResult, [
        {
          id: 1,
          location_id: "18",
          name: "Active",
          min_staff: 2,
          active: true,
          sort_order: 1,
          created_at: FIXED_TIMESTAMP,
        },
        {
          id: 2,
          location_id: "18",
          name: "Inactive",
          min_staff: 0,
          active: false,
          sort_order: 2,
          created_at: FIXED_TIMESTAMP,
        },
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
        throw new AggregateError(cleanupErrors, "Abteilungs-Fixture-Cleanup fehlgeschlagen.");
      }
    }
  });
}
