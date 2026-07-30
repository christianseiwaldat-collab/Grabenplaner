"use strict";

const assert = require("node:assert/strict");
const {
  randomBytes,
} = require("node:crypto");
const test = require("node:test");

const { Pool } = require("pg");
const {
  MIGRATION_ERROR_CODES,
  defineMigrationManifest,
} = require("../lib/persistence/migrations/contract");
const {
  runMigrationManifest,
} = require("../lib/persistence/migrations/runner");
const {
  createPostgresqlMigrationAdapter,
} = require("../lib/persistence/postgresql/migrations/adapter");
const {
  createPostgresqlPoolConfiguration,
  isLoopbackHostname,
} = require("../lib/persistence/postgresql/policy");

const DATABASE_URL = String(process.env.TEST_POSTGRESQL_URL || "").trim();
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const STATIC_ROLE = "static_migration_role";
const STATIC_LEDGER_COLUMNS = Object.freeze([
  {
    name: "manifest_id",
    type: "text",
    notNull: true,
    hasDefault: false,
  },
  {
    name: "position",
    type: "integer",
    notNull: true,
    hasDefault: false,
  },
  {
    name: "migration_id",
    type: "text",
    notNull: true,
    hasDefault: false,
  },
  {
    name: "fingerprint",
    type: "text",
    notNull: true,
    hasDefault: false,
  },
  {
    name: "implementation_fingerprint",
    type: "text",
    notNull: true,
    hasDefault: false,
  },
  {
    name: "implementation_contract_json",
    type: "jsonb",
    notNull: true,
    hasDefault: false,
  },
  {
    name: "contract_version",
    type: "integer",
    notNull: true,
    hasDefault: false,
  },
  {
    name: "applied_at",
    type: "timestamp with time zone",
    notNull: true,
    hasDefault: false,
  },
]);
const STATIC_LEDGER_CONSTRAINTS = Object.freeze([
  {
    name: "persistence_migration_history_contract_version_check",
    type: "c",
    columns: ["contract_version"],
    expression: "(contract_version = 1)",
  },
  {
    name: "persistence_migration_history_fingerprint_check",
    type: "c",
    columns: ["fingerprint"],
    expression: "(fingerprint ~ '^[a-f0-9]{64}$'::text)",
  },
  {
    name: "persistence_migration_history_impl_fingerprint_check",
    type: "c",
    columns: ["implementation_fingerprint"],
    expression: "(implementation_fingerprint ~ '^[a-f0-9]{64}$'::text)",
  },
  {
    name: "persistence_migration_history_manifest_position_key",
    type: "u",
    columns: ["manifest_id", "position"],
    expression: null,
  },
  {
    name: "persistence_migration_history_pkey",
    type: "p",
    columns: ["manifest_id", "migration_id"],
    expression: null,
  },
  {
    name: "persistence_migration_history_position_check",
    type: "c",
    columns: ["position"],
    expression: "(position >= 0)",
  },
]);

function artifactOperation(operationVersion, statements) {
  return {
    artifact: {
      formatVersion: 1,
      operationVersion,
      statements: statements.map(({ sql, parameters = [] }) => ({
        sql,
        parameters,
      })),
    },
  };
}

function statement(sql, parameters = []) {
  return { sql, parameters };
}

function hasMigrationCode(code) {
  return (error) => error?.code === code;
}

function normalizedSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function staticBoundary(overrides = {}) {
  return {
    currentUser: STATIC_ROLE,
    sessionUser: STATIC_ROLE,
    schemaOwner: STATIC_ROLE,
    superuser: false,
    createRole: false,
    createDatabase: false,
    bypassRowSecurity: false,
    replication: false,
    membershipCount: 0,
    ...overrides,
  };
}

function createStaticPool({
  boundary = staticBoundary(),
} = {}) {
  const clients = [];
  const history = [];
  const pool = {
    async connect() {
      const queries = [];
      const releases = [];
      const client = {
        queries,
        releases,
        async query(sql, parameters = []) {
          const normalized = normalizedSql(sql);
          queries.push({ sql: normalized, parameters });
          if (normalized ===
            "SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked") {
            return {
              rowCount: 1,
              rows: [{ unlocked: true }],
            };
          }
          if (normalized.includes(
            "current_user::text AS \"currentUser\"",
          )) {
            return {
              rowCount: 1,
              rows: [{ ...boundary }],
            };
          }
          if (normalized.includes("AS user_trigger_count")) {
            return {
              rowCount: 1,
              rows: [{
                relkind: "r",
                relpersistence: "p",
                relrowsecurity: false,
                relforcerowsecurity: false,
                user_trigger_count: 0,
              }],
            };
          }
          if (normalized.includes("pg_catalog.format_type(")) {
            return {
              rowCount: STATIC_LEDGER_COLUMNS.length,
              rows: STATIC_LEDGER_COLUMNS.map((entry) => ({ ...entry })),
            };
          }
          if (normalized.includes("FROM pg_catalog.pg_constraint")) {
            return {
              rowCount: STATIC_LEDGER_CONSTRAINTS.length,
              rows: STATIC_LEDGER_CONSTRAINTS.map((entry) => ({
                ...entry,
                columns: [...entry.columns],
              })),
            };
          }
          if (normalized.startsWith("SELECT \"position\",")) {
            const manifestId = parameters[0];
            const rows = history
              .filter((entry) => entry.manifest_id === manifestId)
              .sort((left, right) => left.position - right.position)
              .map((entry) => ({
                position: entry.position,
                migration_id: entry.migration_id,
                fingerprint: entry.fingerprint,
                implementation_fingerprint:
                  entry.implementation_fingerprint,
                implementation_contract_json:
                  entry.implementation_contract_json,
                contract_version: entry.contract_version,
              }));
            return {
              rowCount: rows.length,
              rows,
            };
          }
          if (normalized.startsWith(
            "INSERT INTO \"static_schema\".\"persistence_migration_history\"",
          )) {
            history.push({
              manifest_id: parameters[0],
              position: parameters[1],
              migration_id: parameters[2],
              fingerprint: parameters[3],
              implementation_fingerprint: parameters[4],
              implementation_contract_json: JSON.parse(parameters[5]),
              contract_version: parameters[6],
            });
            return { rowCount: 1, rows: [] };
          }
          if (normalized.startsWith(
            "DELETE FROM \"static_schema\".\"persistence_migration_history\"",
          )) {
            const index = history.findIndex((entry) => (
              entry.manifest_id === parameters[0]
              && entry.position === parameters[1]
              && entry.migration_id === parameters[2]
              && entry.fingerprint === parameters[3]
              && entry.implementation_fingerprint === parameters[4]
            ));
            if (index < 0) return { rowCount: 0, rows: [] };
            history.splice(index, 1);
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
        release(error) {
          releases.push(error);
        },
      };
      clients.push(client);
      return client;
    },
  };
  return {
    clients,
    history,
    pool,
  };
}

function staticAdapter(pool, operations = {}) {
  return createPostgresqlMigrationAdapter({
    expectedRole: STATIC_ROLE,
    pool,
    schemaName: "static_schema",
    operations,
  });
}

test("DB Block 5: PostgreSQL-Migrationsadapter bleibt ein deaktivierter Development-Vertrag", () => {
  const externalPool = {
    connect() {
      throw new Error("not used by constructor");
    },
  };
  const adapter = staticAdapter(externalPool);

  assert.deepEqual(
    Object.keys(adapter).sort(),
    [
      "applicationMigrationsImplemented",
      "concurrencyContract",
      "expectedRole",
      "productActivation",
      "providerId",
      "runExclusive",
      "schemaName",
      "securityBoundary",
      "status",
    ],
  );
  assert.equal(adapter.providerId, "postgresql");
  assert.equal(adapter.status, "development-contract");
  assert.equal(adapter.expectedRole, STATIC_ROLE);
  assert.equal(adapter.schemaName, "static_schema");
  assert.equal(adapter.applicationMigrationsImplemented, 0);
  assert.equal(adapter.productActivation, false);
  assert.deepEqual(adapter.concurrencyContract, {
    lockFunction: "pg_advisory_lock",
    lockScope: "session-before-transaction",
    rationale: "fresh-serializable-snapshot-after-lock-wait",
    retry: false,
  });
  assert.deepEqual(adapter.securityBoundary, {
    artifactExecution: "adapter-owned-versioned-sql-bundle",
    artifactFingerprint: "sha256-canonical-json-v1",
    explicitSchemaQualification: "rejected",
    inheritedRoles: "rejected",
    ledgerAccessFromArtifacts: "rejected",
    roleRequirement: "dedicated-least-privilege-schema-role",
    superuserRequired: false,
  });
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.hasOwn(adapter, "pool"), false);
  assert.equal(Object.hasOwn(adapter, "close"), false);

  for (const schemaName of [
    "",
    "Public",
    "public;drop schema public",
    "has-dash",
    "a".repeat(64),
  ]) {
    assert.throws(
      () => createPostgresqlMigrationAdapter({
        expectedRole: STATIC_ROLE,
        pool: externalPool,
        schemaName,
        operations: {},
      }),
      hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
    );
  }
  for (const operations of [
    [],
    {
      "fixture.invalid": () => {},
    },
    {
      "fixture.invalid": {
        handler() {},
      },
    },
    {
      "fixture.invalid": {
        artifact: {
          formatVersion: 2,
          operationVersion: 1,
          statements: [statement("SELECT 1")],
        },
      },
    },
    {
      "fixture.invalid": {
        artifact: {
          formatVersion: 1,
          operationVersion: 1,
          statements: [],
        },
      },
    },
  ]) {
    assert.throws(
      () => createPostgresqlMigrationAdapter({
        expectedRole: STATIC_ROLE,
        pool: externalPool,
        schemaName: "static_schema",
        operations,
      }),
      hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
    );
  }
  assert.throws(
    () => createPostgresqlMigrationAdapter({
      expectedRole: STATIC_ROLE,
      pool: { query() {} },
      schemaName: "static_schema",
      operations: {},
    }),
    hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
  );
  for (const expectedRole of [
    "",
    "Static",
    "has-dash",
    "a".repeat(64),
  ]) {
    assert.throws(
      () => createPostgresqlMigrationAdapter({
        expectedRole,
        pool: externalPool,
        schemaName: "static_schema",
        operations: {},
      }),
      hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
    );
  }

  assert.throws(
    () => createPostgresqlMigrationAdapter({
      expectedRole: STATIC_ROLE,
      pool: externalPool,
      schemaName: "static_schema",
      operations: {
        "fixture.legacy-handler": {
          artifact: artifactOperation(1, [
            statement("CREATE TABLE legacy_probe (id integer)"),
          ]).artifact,
          handler() {
            throw new Error("changed handler");
          },
          implementationFingerprint: "a".repeat(64),
        },
      },
    }),
    hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
    "A changed legacy handler cannot preserve a freely declared old hash.",
  );
});

test("DB Block 5: Session-Lock liegt vor genau einer SERIALIZABLE-Transaktion und wird immer gelöst", async () => {
  const successFixture = createStaticPool();
  const successAdapter = staticAdapter(successFixture.pool);
  const result = await successAdapter.runExclusive(async (session) => {
    assert.deepEqual(
      Object.keys(session).sort(),
      ["executeMigrationStep", "readAppliedMigrations"],
    );
    assert.equal(Object.hasOwn(session, "client"), false);
    assert.equal(Object.hasOwn(session, "pool"), false);
    assert.equal(Object.hasOwn(session, "close"), false);
    return "complete";
  });

  assert.equal(result, "complete");
  assert.equal(successFixture.clients.length, 1);
  const successClient = successFixture.clients[0];
  assert.equal(
    successClient.queries.filter(
      ({ sql }) => sql === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
    ).length,
    1,
  );
  assert.equal(
    successClient.queries.some(
      ({ sql }) => sql ===
        "SET LOCAL search_path TO \"static_schema\", pg_catalog",
    ),
    true,
  );
  const advisory = successClient.queries.find(
    ({ sql }) => sql ===
      "SELECT pg_catalog.pg_advisory_lock($1::bigint)",
  );
  assert.match(advisory.parameters[0], /^-?[0-9]+$/);
  const beginIndex = successClient.queries.findIndex(
    ({ sql }) => sql === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
  );
  const lockIndex = successClient.queries.indexOf(advisory);
  const unlockIndex = successClient.queries.findIndex(
    ({ sql }) => sql ===
      "SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked",
  );
  assert.equal(lockIndex < beginIndex, true);
  assert.equal(unlockIndex > beginIndex, true);
  assert.equal(
    successClient.queries.filter(({ sql }) => sql === "COMMIT").length,
    1,
  );
  assert.equal(
    successClient.queries.filter(({ sql }) => sql === "ROLLBACK").length,
    0,
  );
  assert.equal(unlockIndex > successClient.queries.findIndex(
    ({ sql }) => sql === "COMMIT",
  ), true);
  assert.equal(successClient.releases.length, 1);

  const failureFixture = createStaticPool();
  const failureAdapter = staticAdapter(failureFixture.pool);
  await assert.rejects(
    failureAdapter.runExclusive(async () => {
      throw new Error("controlled runner failure");
    }),
    /controlled runner failure/,
  );
  const failureClient = failureFixture.clients[0];
  assert.equal(
    failureClient.queries.filter(({ sql }) => sql === "COMMIT").length,
    0,
  );
  assert.equal(
    failureClient.queries.filter(({ sql }) => sql === "ROLLBACK").length,
    1,
  );
  assert.equal(
    failureClient.queries.filter(
      ({ sql }) => sql ===
        "SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked",
    ).length,
    1,
  );
  assert.equal(failureClient.releases.length, 1);
});

test("DB Block 5: Rollenidentität, Schemaeigentum, Privilegflags und Mitgliedschaften sind fail-closed", async () => {
  const unsafeBoundaries = [
    staticBoundary({ currentUser: "unexpected_role" }),
    staticBoundary({ sessionUser: "unexpected_role" }),
    staticBoundary({ schemaOwner: "unexpected_role" }),
    staticBoundary({ superuser: true }),
    staticBoundary({ createRole: true }),
    staticBoundary({ createDatabase: true }),
    staticBoundary({ bypassRowSecurity: true }),
    staticBoundary({ replication: true }),
    staticBoundary({ membershipCount: 1 }),
  ];
  for (const boundary of unsafeBoundaries) {
    const fixture = createStaticPool({ boundary });
    await assert.rejects(
      staticAdapter(fixture.pool).runExclusive(async () => "unreachable"),
      hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
    );
    assert.equal(
      fixture.clients[0].queries.some(({ sql }) => (
        sql.startsWith("CREATE TABLE IF NOT EXISTS")
      )),
      false,
    );
    assert.equal(
      fixture.clients[0].queries.filter(({ sql }) => sql === "ROLLBACK").length,
      1,
    );
    assert.equal(fixture.clients[0].releases.length, 1);
  }
});

test("DB Block 5: nur kanonische, versionierte SQL-Artefakte werden reproduzierbar ausgeführt", async () => {
  const manifest = defineMigrationManifest({
    id: "fixture.pg-capability",
    migrations: [{
      id: "v1.pg-capability",
      operations: ["fixture.pg-capability.apply"],
      rollbackOperations: ["fixture.pg-capability.rollback"],
    }],
  });
  const fixture = createStaticPool();
  const context = Object.freeze({
    marker: "provider-neutral-fixture-context",
  });
  const operations = {
    "fixture.pg-capability.apply": artifactOperation(1, [
      statement("CREATE TABLE capability_probe (id integer PRIMARY KEY)"),
    ]),
    "fixture.pg-capability.rollback": artifactOperation(1, [
      statement("DROP TABLE capability_probe"),
    ]),
  };
  const adapter = staticAdapter(fixture.pool, operations);
  const result = await runMigrationManifest({
    manifest,
    adapter,
    context,
  });

  assert.equal(result.kind, "rebuild");
  assert.equal(fixture.history.length, 1);
  assert.match(
    fixture.history[0].implementation_fingerprint,
    FINGERPRINT_PATTERN,
  );
  assert.deepEqual(
    Object.keys(fixture.history[0].implementation_contract_json).sort(),
    ["apply", "rollback"],
  );
  assert.equal(
    fixture.clients[0].queries.some(
      ({ sql }) => sql ===
        "CREATE TABLE capability_probe (id integer PRIMARY KEY)",
    ),
    true,
  );

  const forbiddenStatements = [
    "COMMIT",
    "SET LOCAL search_path TO public",
    "SELECT pg_catalog.\"pg_terminate_backend\"(1)",
    "ALTER TABLE capability_probe SET SCHEMA public",
    "CREATE TABLE \"public\".\"foreign_probe\" (id integer)",
    "SELECT \"probe\".\"id\" FROM capability_probe AS probe",
    "SELECT pg_terminate_backend(1)",
    "CREATE FUNCTION dangerous_wrapper() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$",
    "CREATE OR REPLACE FUNCTION dangerous_wrapper() RETURNS void SECURITY DEFINER LANGUAGE sql AS $$ SELECT 1 $$",
    "CREATE PROCEDURE dangerous_wrapper() LANGUAGE sql AS $$ SELECT 1 $$",
    "CREATE TEMP TABLE session_probe (id integer)",
    "CREATE UNLOGGED TABLE session_probe (id integer)",
    "SELECT 1 INTO bypass_probe",
    "SELECT 1 INTO UNLOGGED bypass_probe",
    "SELECT * FROM persistence_migration_history",
    "INSERT INTO persistence_migration_history DEFAULT VALUES",
    "UPDATE persistence_migration_history SET position = 0",
    "DELETE FROM persistence_migration_history",
    "ALTER TABLE persistence_migration_history ADD COLUMN damage integer",
    "DROP TABLE persistence_migration_history",
  ];
  for (let index = 0; index < forbiddenStatements.length; index += 1) {
    const operationId = `fixture.pg-forbidden-${index}.apply`;
    const forbiddenFixture = createStaticPool();
    assert.throws(
      () => staticAdapter(forbiddenFixture.pool, {
        [operationId]: artifactOperation(1, [
          statement(forbiddenStatements[index]),
        ]),
      }),
      hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
    );
    assert.equal(forbiddenFixture.history.length, 0);
    assert.equal(forbiddenFixture.clients.length, 0);
  }

  const repeatFixture = createStaticPool();
  await runMigrationManifest({
    manifest,
    adapter: staticAdapter(repeatFixture.pool, operations),
    context,
  });
  assert.equal(
    repeatFixture.history[0].implementation_fingerprint,
    fixture.history[0].implementation_fingerprint,
  );
});

function liveConfiguration(applicationName) {
  const parsed = new URL(DATABASE_URL);
  return createPostgresqlPoolConfiguration({
    databaseUrl: DATABASE_URL,
    tlsMode: isLoopbackHostname(parsed.hostname)
      ? "disable-local-only"
      : "verify-full",
    applicationName,
    policy: {
      maximumConnections: 6,
      connectionTimeoutMilliseconds: 3_000,
      idleTimeoutMilliseconds: 1_000,
      statementTimeoutMilliseconds: 8_000,
      queryTimeoutMilliseconds: 9_000,
      transactionTimeoutMilliseconds: 20_000,
      maximumConnectionLifetimeSeconds: 60,
    },
    allowExitOnIdle: true,
  });
}

function liveSchemaName(label) {
  return [
    "gp_migration",
    label,
    process.pid,
    Date.now(),
    randomBytes(4).toString("hex"),
  ].join("_");
}

function liveRoleName() {
  return [
    "gp_migrator",
    process.pid,
    Date.now(),
    randomBytes(4).toString("hex"),
  ].join("_");
}

async function withLiveSchema(label, work) {
  const configuration = liveConfiguration(
    `grabenplaner-db5-migration-${label}`,
  );
  const adminPool = new Pool(configuration);
  let applicationPool = null;
  const schemaName = liveSchemaName(label);
  const expectedRole = liveRoleName();
  const rolePassword = randomBytes(24).toString("hex");
  const quotedSchema = `"${schemaName}"`;
  const quotedRole = `"${expectedRole}"`;
  let roleCreated = false;
  let primaryError = null;
  try {
    await adminPool.query(`
      CREATE ROLE ${quotedRole}
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      PASSWORD '${rolePassword}'
    `);
    roleCreated = true;
    await adminPool.query(
      `CREATE SCHEMA ${quotedSchema} AUTHORIZATION ${quotedRole}`,
    );
    const roleDatabaseUrl = new URL(DATABASE_URL);
    roleDatabaseUrl.username = expectedRole;
    roleDatabaseUrl.password = rolePassword;
    applicationPool = new Pool({
      ...configuration,
      connectionString: roleDatabaseUrl.toString(),
    });
    await work({
      adminPool,
      applicationPool,
      expectedRole,
      quotedRole,
      quotedSchema,
      schemaName,
    });
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  for (const cleanup of [
    () => applicationPool?.end(),
    () => roleCreated
      ? adminPool.query(`
          ALTER ROLE ${quotedRole}
          NOSUPERUSER
          NOCREATEDB
          NOCREATEROLE
          NOREPLICATION
          NOBYPASSRLS
        `)
      : Promise.resolve(),
    () => adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`),
    () => roleCreated
      ? adminPool.query(`DROP ROLE IF EXISTS ${quotedRole}`)
      : Promise.resolve(),
    () => adminPool.end(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "PostgreSQL migration test and cleanup both failed.",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "PostgreSQL migration test cleanup failed.",
    );
  }
}

function liveAdapter({
  applicationPool,
  expectedRole,
  schemaName,
  operations,
}) {
  return createPostgresqlMigrationAdapter({
    expectedRole,
    pool: applicationPool,
    schemaName,
    operations,
  });
}

if (!DATABASE_URL) {
  test("DB Block 5: PostgreSQL-Migrationsadapter-Livetests benötigen TEST_POSTGRESQL_URL", {
    skip: "TEST_POSTGRESQL_URL ist nicht gesetzt; statische Sicherheitsverträge wurden geprüft.",
  }, () => {});
} else {
  test("DB Block 5 Live: reale Migrationsrolle, Schemaowner und Privilegflags bleiben fail-closed", async () => {
    await withLiveSchema("role_boundary", async ({
      adminPool,
      applicationPool,
      expectedRole,
      quotedRole,
      quotedSchema,
      schemaName,
    }) => {
      const identity = (await applicationPool.query(`
        SELECT current_user::text AS current_user,
               session_user::text AS session_user
      `)).rows[0];
      assert.deepEqual(identity, {
        current_user: expectedRole,
        session_user: expectedRole,
      });

      const safeAdapter = liveAdapter({
        applicationPool,
        expectedRole,
        schemaName,
        operations: {},
      });
      assert.equal(
        await safeAdapter.runExclusive(async () => "safe"),
        "safe",
      );

      const unexpectedRoleAdapter = liveAdapter({
        applicationPool,
        expectedRole: `${expectedRole}_other`,
        schemaName,
        operations: {},
      });
      await assert.rejects(
        unexpectedRoleAdapter.runExclusive(async () => "unreachable"),
        hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
      );

      await adminPool.query(
        `ALTER SCHEMA ${quotedSchema} OWNER TO CURRENT_USER`,
      );
      try {
        await assert.rejects(
          safeAdapter.runExclusive(async () => "unreachable"),
          hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
        );
      } finally {
        await adminPool.query(
          `ALTER SCHEMA ${quotedSchema} OWNER TO ${quotedRole}`,
        );
      }

      const privilegeCases = [
        ["SUPERUSER", "NOSUPERUSER"],
        ["CREATEROLE", "NOCREATEROLE"],
        ["CREATEDB", "NOCREATEDB"],
        ["BYPASSRLS", "NOBYPASSRLS"],
        ["REPLICATION", "NOREPLICATION"],
      ];
      for (const [enable, disable] of privilegeCases) {
        await adminPool.query(`ALTER ROLE ${quotedRole} ${enable}`);
        try {
          await assert.rejects(
            safeAdapter.runExclusive(async () => "unreachable"),
            hasMigrationCode(MIGRATION_ERROR_CODES.ADAPTER_INVALID),
          );
        } finally {
          await adminPool.query(`ALTER ROLE ${quotedRole} ${disable}`);
        }
      }
    });
  });

  test("DB Block 5 Live: Rebuild, Präfix-Upgrade, Noop und echter Rollback bleiben lückenlos", async () => {
    await withLiveSchema("chain", async ({
      adminPool,
      applicationPool,
      expectedRole,
      quotedSchema,
      schemaName,
    }) => {
      const manifest = defineMigrationManifest({
        id: "fixture.pg-chain",
        migrations: [
          {
            id: "v1.pg-chain-base",
            operations: ["fixture.pg-chain.create"],
            rollbackOperations: ["fixture.pg-chain.drop"],
          },
          {
            id: "v2.pg-chain-seed",
            operations: ["fixture.pg-chain.seed"],
            rollbackOperations: ["fixture.pg-chain.unseed"],
          },
        ],
      });
      const operations = {
        "fixture.pg-chain.create": artifactOperation(1, [
          statement(`
            CREATE TABLE migration_items (
              id integer PRIMARY KEY,
              value text NOT NULL
            )
          `),
          statement(`
            CREATE TABLE migration_state (
              isolation text NOT NULL,
              read_only text NOT NULL,
              paths text[] NOT NULL
            )
          `),
          statement(`
            INSERT INTO migration_state (isolation, read_only, paths)
              SELECT
                current_setting('transaction_isolation'),
                current_setting('transaction_read_only'),
                current_schemas(false)::text[]
          `),
        ]),
        "fixture.pg-chain.drop": artifactOperation(1, [
          statement("DROP TABLE migration_state"),
          statement("DROP TABLE migration_items"),
        ]),
        "fixture.pg-chain.seed": artifactOperation(1, [
          statement(
            "INSERT INTO migration_items (id, value) VALUES ($1, $2)",
            [1, "seed"],
          ),
        ]),
        "fixture.pg-chain.unseed": artifactOperation(1, [
          statement("DELETE FROM migration_items WHERE id = $1", [1]),
        ]),
      };
      const adapter = liveAdapter({
        applicationPool,
        expectedRole,
        schemaName,
        operations,
      });

      const prefix = await runMigrationManifest({
        manifest,
        adapter,
        targetId: "v1.pg-chain-base",
      });
      assert.equal(prefix.kind, "rebuild");
      assert.deepEqual(prefix.applied, ["v1.pg-chain-base"]);
      const transactionState = (await adminPool.query(
        `SELECT isolation, read_only, paths FROM ${quotedSchema}.migration_state`,
      )).rows[0];
      assert.equal(transactionState.isolation, "serializable");
      assert.equal(transactionState.read_only, "off");
      assert.deepEqual(transactionState.paths, [schemaName, "pg_catalog"]);

      const upgrade = await runMigrationManifest({ manifest, adapter });
      assert.equal(upgrade.kind, "upgrade");
      assert.deepEqual(upgrade.applied, ["v2.pg-chain-seed"]);
      assert.equal(
        (await adminPool.query(
          `SELECT count(*)::integer AS count FROM ${quotedSchema}.migration_items`,
        )).rows[0].count,
        1,
      );

      const noop = await runMigrationManifest({ manifest, adapter });
      assert.equal(noop.kind, "noop");
      assert.deepEqual(noop.applied, []);

      const rollbackOne = await runMigrationManifest({
        manifest,
        adapter,
        targetId: "v1.pg-chain-base",
      });
      assert.equal(rollbackOne.kind, "rollback");
      assert.deepEqual(rollbackOne.rolledBack, ["v2.pg-chain-seed"]);
      assert.equal(
        (await adminPool.query(
          `SELECT count(*)::integer AS count FROM ${quotedSchema}.migration_items`,
        )).rows[0].count,
        0,
      );

      const rollbackAll = await runMigrationManifest({
        manifest,
        adapter,
        targetId: null,
      });
      assert.equal(rollbackAll.kind, "rollback");
      assert.deepEqual(rollbackAll.rolledBack, ["v1.pg-chain-base"]);
      assert.equal(
        (await adminPool.query(
          "SELECT to_regclass($1) AS relation",
          [`${schemaName}.migration_items`],
        )).rows[0].relation,
        null,
      );
      assert.equal(
        (await adminPool.query(`
          SELECT count(*)::integer AS count
          FROM ${quotedSchema}.persistence_migration_history
          WHERE manifest_id = $1
        `, [manifest.id])).rows[0].count,
        0,
      );
      assert.equal((await applicationPool.query("SELECT 1")).rowCount, 1);
    });
  });

  test("DB Block 5 Live: ein Fehler rollt Schemaarbeit und Ledger des gesamten Runs atomar zurück", async () => {
    await withLiveSchema("atomic", async ({
      adminPool,
      applicationPool,
      expectedRole,
      schemaName,
    }) => {
      const manifest = defineMigrationManifest({
        id: "fixture.pg-atomic",
        migrations: [
          {
            id: "v1.pg-atomic-base",
            operations: ["fixture.pg-atomic.base"],
            rollbackOperations: null,
          },
          {
            id: "v2.pg-atomic-fail",
            operations: [
              "fixture.pg-atomic.audit",
              "fixture.pg-atomic.fail",
            ],
            rollbackOperations: null,
          },
        ],
      });
      const adapter = liveAdapter({
        applicationPool,
        expectedRole,
        schemaName,
        operations: {
          "fixture.pg-atomic.base": artifactOperation(1, [
            statement("CREATE TABLE atomic_base (id integer PRIMARY KEY)"),
          ]),
          "fixture.pg-atomic.audit": artifactOperation(1, [
            statement("CREATE TABLE atomic_audit (id integer PRIMARY KEY)"),
          ]),
          "fixture.pg-atomic.fail": artifactOperation(1, [
            statement("INSERT INTO atomic_base (id) VALUES ($1)", [1]),
            statement("INSERT INTO atomic_base (id) VALUES ($1)", [1]),
          ]),
        },
      });

      await assert.rejects(
        runMigrationManifest({ manifest, adapter }),
        (error) => error?.code === "23505",
      );
      const relations = await adminPool.query(
        "SELECT to_regclass($1) AS base, to_regclass($2) AS audit, to_regclass($3) AS ledger",
        [
          `${schemaName}.atomic_base`,
          `${schemaName}.atomic_audit`,
          `${schemaName}.persistence_migration_history`,
        ],
      );
      assert.deepEqual(relations.rows[0], {
        base: null,
        audit: null,
        ledger: null,
      });
      assert.equal((await applicationPool.query("SELECT 1")).rowCount, 1);
    });
  });

  test("DB Block 5 Live: Session-Advisory-Lock serialisiert parallele Runner vor ihrem Snapshot", async () => {
    await withLiveSchema("parallel", async ({
      adminPool,
      applicationPool,
      expectedRole,
      quotedSchema,
      schemaName,
    }) => {
      const manifest = defineMigrationManifest({
        id: "fixture.pg-parallel",
        migrations: [{
          id: "v1.pg-parallel",
          operations: ["fixture.pg-parallel.apply"],
          rollbackOperations: null,
        }],
      });
      const operations = {
        "fixture.pg-parallel.apply": artifactOperation(1, [
          statement(`
            CREATE TABLE parallel_probe (
              id integer PRIMARY KEY
            )
          `),
          statement("SELECT pg_sleep(0.1)"),
          statement("INSERT INTO parallel_probe (id) VALUES ($1)", [1]),
        ]),
      };
      const firstAdapter = liveAdapter({
        applicationPool,
        expectedRole,
        schemaName,
        operations,
      });
      const secondAdapter = liveAdapter({
        applicationPool,
        expectedRole,
        schemaName,
        operations,
      });
      const results = await Promise.all([
        runMigrationManifest({ manifest, adapter: firstAdapter }),
        runMigrationManifest({ manifest, adapter: secondAdapter }),
      ]);

      assert.deepEqual(
        results.map((result) => result.kind).sort(),
        ["noop", "rebuild"],
      );
      assert.equal(
        (await adminPool.query(
          `SELECT count(*)::integer AS count FROM ${quotedSchema}.parallel_probe`,
        )).rows[0].count,
        1,
      );
      assert.equal(
        (await adminPool.query(`
          SELECT count(*)::integer AS count
          FROM ${quotedSchema}.persistence_migration_history
          WHERE manifest_id = $1
        `, [manifest.id])).rows[0].count,
        1,
      );
    });
  });

  test("DB Block 5 Live: Implementierungs-, Manifest- und Historien-Drift scheitern geschlossen", async () => {
    await withLiveSchema("drift", async ({
      adminPool,
      applicationPool,
      expectedRole,
      quotedSchema,
      schemaName,
    }) => {
      const manifest = defineMigrationManifest({
        id: "fixture.pg-drift",
        migrations: [{
          id: "v1.pg-drift",
          description: "initial contract",
          operations: ["fixture.pg-drift.apply"],
          rollbackOperations: null,
        }],
      });
      const initialOperation = artifactOperation(1, [
        statement("CREATE TABLE drift_probe (id integer PRIMARY KEY)"),
      ]);
      const initialAdapter = liveAdapter({
        applicationPool,
        expectedRole,
        schemaName,
        operations: {
          "fixture.pg-drift.apply": initialOperation,
        },
      });
      await runMigrationManifest({ manifest, adapter: initialAdapter });

      const implementationDriftAdapter = liveAdapter({
        applicationPool,
        expectedRole,
        schemaName,
        operations: {
          "fixture.pg-drift.apply": artifactOperation(2, [
            statement("CREATE TABLE drift_probe (id integer PRIMARY KEY)"),
          ]),
        },
      });
      await assert.rejects(
        runMigrationManifest({
          manifest,
          adapter: implementationDriftAdapter,
        }),
        hasMigrationCode(MIGRATION_ERROR_CODES.HISTORY_INVALID),
      );

      const changedManifest = defineMigrationManifest({
        id: manifest.id,
        migrations: [{
          id: "v1.pg-drift",
          description: "changed contract",
          operations: ["fixture.pg-drift.apply"],
          rollbackOperations: null,
        }],
      });
      await assert.rejects(
        runMigrationManifest({
          manifest: changedManifest,
          adapter: initialAdapter,
        }),
        hasMigrationCode(MIGRATION_ERROR_CODES.HISTORY_INVALID),
      );

      await adminPool.query(`
        UPDATE ${quotedSchema}.persistence_migration_history
        SET position = 3
        WHERE manifest_id = $1
      `, [manifest.id]);
      await assert.rejects(
        runMigrationManifest({ manifest, adapter: initialAdapter }),
        hasMigrationCode(MIGRATION_ERROR_CODES.HISTORY_INVALID),
      );
      assert.equal(
        (await adminPool.query(`
          SELECT position
          FROM ${quotedSchema}.persistence_migration_history
          WHERE manifest_id = $1
        `, [manifest.id])).rows[0].position,
        3,
      );
    });
  });
}
