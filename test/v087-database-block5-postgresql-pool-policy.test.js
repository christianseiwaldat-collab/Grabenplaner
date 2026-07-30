"use strict";

const assert = require("node:assert/strict");
const { inspect } = require("node:util");
const test = require("node:test");

const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/errors");
const {
  openPostgresqlDevelopmentPersistence,
} = require("../lib/persistence/postgresql/pool");
const {
  DEFAULT_POSTGRESQL_POOL_POLICY,
  POSTGRESQL_EXPERIMENTAL_PROFILE,
  POSTGRESQL_ROLE_PURPOSES,
  POSTGRESQL_TLS_MODES,
  createPostgresqlPoolConfiguration,
  isLoopbackHostname,
  normalizePostgresqlPoolPolicy,
} = require("../lib/persistence/postgresql/policy");

const EXPECTED_DEFAULT_POLICY = Object.freeze({
  minimumConnections: 0,
  maximumConnections: 5,
  connectionTimeoutMilliseconds: 5_000,
  idleTimeoutMilliseconds: 30_000,
  statementTimeoutMilliseconds: 30_000,
  queryTimeoutMilliseconds: 32_000,
  transactionTimeoutMilliseconds: 60_000,
  maximumConnectionLifetimeSeconds: 3_600,
});

function hasPersistenceCode(code) {
  return (error) => error?.code === code;
}

function assertPolicyRejected(overrides) {
  assert.throws(
    () => normalizePostgresqlPoolPolicy(overrides),
    (error) => {
      assert.equal(error?.name, "TypeError");
      assert.doesNotMatch(error?.message || "", /password|secret|postgres(?:ql)?:\/\//i);
      return true;
    },
  );
}

test("v0.87 DB Block 5: PostgreSQL-Policy legt die unveränderlichen Defaults exakt fest", () => {
  assert.deepEqual(DEFAULT_POSTGRESQL_POOL_POLICY, EXPECTED_DEFAULT_POLICY);
  assert.equal(Object.isFrozen(DEFAULT_POSTGRESQL_POOL_POLICY), true);
  assert.equal(POSTGRESQL_EXPERIMENTAL_PROFILE, "development-contract");
  assert.deepEqual(POSTGRESQL_TLS_MODES, [
    "verify-full",
    "disable-local-only",
  ]);
  assert.deepEqual(POSTGRESQL_ROLE_PURPOSES, [
    "application",
    "backup",
    "migration",
    "operations",
  ]);
  assert.equal(Object.isFrozen(POSTGRESQL_TLS_MODES), true);
  assert.equal(Object.isFrozen(POSTGRESQL_ROLE_PURPOSES), true);

  const normalized = normalizePostgresqlPoolPolicy();
  assert.deepEqual(normalized, EXPECTED_DEFAULT_POLICY);
  assert.equal(Object.isFrozen(normalized), true);
  assert.notEqual(normalized, DEFAULT_POSTGRESQL_POOL_POLICY);
});

test("v0.87 DB Block 5: Standardkonfiguration erzwingt verify-full TLS", () => {
  const databaseUrl = "postgresql://grabenplaner:geheim@db.internal.example:5432/grabenplaner";
  const configuration = createPostgresqlPoolConfiguration({ databaseUrl });

  assert.deepEqual(configuration, {
    connectionString: databaseUrl,
    application_name: "grabenplaner-development-contract",
    min: 0,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    query_timeout: 32_000,
    idle_in_transaction_session_timeout: 60_000,
    maxLifetimeSeconds: 3_600,
    allowExitOnIdle: false,
    ssl: { rejectUnauthorized: true },
  });
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.ssl), true);
});

test("v0.87 DB Block 5: TLS darf nur explizit und nur für Loopback deaktiviert werden", () => {
  const loopbackUrls = [
    "postgresql://app:secret@localhost/grabenplaner",
    "postgresql://app:secret@127.0.0.1/grabenplaner",
    "postgresql://app:secret@[::1]:5432/grabenplaner",
  ];
  for (const databaseUrl of loopbackUrls) {
    const defaultConfiguration = createPostgresqlPoolConfiguration({ databaseUrl });
    assert.deepEqual(defaultConfiguration.ssl, { rejectUnauthorized: true });

    const localConfiguration = createPostgresqlPoolConfiguration({
      databaseUrl,
      tlsMode: "disable-local-only",
    });
    assert.equal(localConfiguration.ssl, false);
  }

  for (const databaseUrl of [
    "postgresql://app:secret@db.internal.example/grabenplaner",
    "postgresql://app:secret@localhost.example/grabenplaner",
    "postgresql://app:secret@127.0.0.2/grabenplaner",
    "postgresql://app:secret@0.0.0.0/grabenplaner",
  ]) {
    assert.throws(
      () => createPostgresqlPoolConfiguration({
        databaseUrl,
        tlsMode: "disable-local-only",
      }),
      { name: "TypeError" },
    );
  }

  assert.equal(isLoopbackHostname("LOCALHOST"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("localhost.example"), false);
  assert.throws(
    () => createPostgresqlPoolConfiguration({
      databaseUrl: loopbackUrls[0],
      tlsMode: "disable",
    }),
    { name: "TypeError" },
  );
});

test("v0.87 DB Block 5: ssl-URL-Parameter werden unabhängig von Schreibweise fail-closed abgewiesen", () => {
  const urls = [
    "postgresql://app:secret@localhost/grabenplaner?sslmode=disable",
    "postgresql://app:secret@localhost/grabenplaner?SSLMode=require",
    "postgresql://app:secret@localhost/grabenplaner?ssl=true",
    "postgresql://app:secret@localhost/grabenplaner?sslcert=client.pem",
    "postgresql://app:secret@localhost/grabenplaner?s%73lkey=client.key",
  ];

  for (const databaseUrl of urls) {
    assert.throws(
      () => createPostgresqlPoolConfiguration({
        databaseUrl,
        tlsMode: "disable-local-only",
      }),
      { name: "TypeError" },
    );
  }

  const unrelatedParameter = createPostgresqlPoolConfiguration({
    databaseUrl: "postgresql://app:secret@localhost/grabenplaner?connect_timeout=5",
    tlsMode: "disable-local-only",
  });
  assert.equal(unrelatedParameter.ssl, false);
});

test("v0.87 DB Block 5: Policy akzeptiert ihre exakten Unter- und Obergrenzen", () => {
  assert.deepEqual(normalizePostgresqlPoolPolicy({
    minimumConnections: 0,
    maximumConnections: 1,
    connectionTimeoutMilliseconds: 100,
    idleTimeoutMilliseconds: 1_000,
    statementTimeoutMilliseconds: 100,
    queryTimeoutMilliseconds: 100,
    transactionTimeoutMilliseconds: 100,
    maximumConnectionLifetimeSeconds: 60,
  }), {
    minimumConnections: 0,
    maximumConnections: 1,
    connectionTimeoutMilliseconds: 100,
    idleTimeoutMilliseconds: 1_000,
    statementTimeoutMilliseconds: 100,
    queryTimeoutMilliseconds: 100,
    transactionTimeoutMilliseconds: 100,
    maximumConnectionLifetimeSeconds: 60,
  });

  assert.deepEqual(normalizePostgresqlPoolPolicy({
    minimumConnections: 20,
    maximumConnections: 50,
    connectionTimeoutMilliseconds: 60_000,
    idleTimeoutMilliseconds: 600_000,
    statementTimeoutMilliseconds: 300_000,
    queryTimeoutMilliseconds: 300_000,
    transactionTimeoutMilliseconds: 600_000,
    maximumConnectionLifetimeSeconds: 86_400,
  }), {
    minimumConnections: 20,
    maximumConnections: 50,
    connectionTimeoutMilliseconds: 60_000,
    idleTimeoutMilliseconds: 600_000,
    statementTimeoutMilliseconds: 300_000,
    queryTimeoutMilliseconds: 300_000,
    transactionTimeoutMilliseconds: 600_000,
    maximumConnectionLifetimeSeconds: 86_400,
  });
});

test("v0.87 DB Block 5: Policy weist Grenzverletzungen und unbekannte Felder zurück", () => {
  for (const overrides of [
    null,
    [],
    "invalid",
    { unknownPolicyField: 1 },
    { minimumConnections: -1 },
    { minimumConnections: 21 },
    { maximumConnections: 0 },
    { maximumConnections: 51 },
    { minimumConnections: 6, maximumConnections: 5 },
    { connectionTimeoutMilliseconds: 99 },
    { connectionTimeoutMilliseconds: 60_001 },
    { idleTimeoutMilliseconds: 999 },
    { idleTimeoutMilliseconds: 600_001 },
    { statementTimeoutMilliseconds: 99 },
    { statementTimeoutMilliseconds: 300_001 },
    { queryTimeoutMilliseconds: 99 },
    { queryTimeoutMilliseconds: 300_001 },
    {
      statementTimeoutMilliseconds: 10_001,
      queryTimeoutMilliseconds: 10_000,
    },
    { transactionTimeoutMilliseconds: 99 },
    { transactionTimeoutMilliseconds: 600_001 },
    {
      statementTimeoutMilliseconds: 30_001,
      transactionTimeoutMilliseconds: 30_000,
    },
    { maximumConnectionLifetimeSeconds: 59 },
    { maximumConnectionLifetimeSeconds: 86_401 },
    { maximumConnections: 1.5 },
    { queryTimeoutMilliseconds: "32000" },
  ]) {
    assertPolicyRejected(overrides);
  }
});

test("v0.87 DB Block 5: Konfigurationsfehler geben keine URL-Zugangsdaten preis", () => {
  const username = "secret-user";
  const password = "S3hr-Geheim-987";
  const databaseUrl = `postgresql://${username}:${password}@db.internal.example/grabenplaner?sslmode=require`;

  assert.throws(
    () => createPostgresqlPoolConfiguration({ databaseUrl }),
    (error) => {
      const rendered = [
        error?.message,
        error?.stack,
        JSON.stringify(error),
        inspect(error, { showHidden: true }),
      ].join("\n");
      assert.doesNotMatch(rendered, new RegExp(username, "i"));
      assert.doesNotMatch(rendered, new RegExp(password, "i"));
      assert.doesNotMatch(rendered, /sslmode=require/i);
      return true;
    },
  );

  const constructorSecret = "POOL-CONSTRUCTOR-SECRET-2468";
  class FailingPool {
    constructor() {
      throw new Error(constructorSecret);
    }
  }
  assert.throws(
    () => openPostgresqlDevelopmentPersistence({
      profile: POSTGRESQL_EXPERIMENTAL_PROFILE,
      databaseUrl: "postgresql://app:another-secret@localhost/grabenplaner",
      tlsMode: "disable-local-only",
      Pool: FailingPool,
    }),
    (error) => {
      assert.equal(error?.code, PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID);
      const rendered = [
        error?.message,
        error?.stack,
        JSON.stringify(error),
        inspect(error, { showHidden: true }),
        inspect(error?.cause, { showHidden: true }),
      ].join("\n");
      assert.doesNotMatch(rendered, new RegExp(constructorSecret, "i"));
      assert.doesNotMatch(rendered, /another-secret/i);
      assert.deepEqual(error?.cause, { name: "Error" });
      return true;
    },
  );
});

test("v0.87 DB Block 5: PostgreSQL-Pool lässt sich ausschließlich im Entwicklungsprofil öffnen", () => {
  let constructorCalls = 0;
  class UnexpectedPool {
    constructor() {
      constructorCalls += 1;
    }
  }

  for (const profile of [
    undefined,
    "",
    "development",
    "test",
    "production",
    "development-contract ",
  ]) {
    assert.throws(
      () => openPostgresqlDevelopmentPersistence({
        profile,
        databaseUrl: "postgresql://app:secret@localhost/grabenplaner",
        Pool: UnexpectedPool,
      }),
      hasPersistenceCode(PERSISTENCE_ERROR_CODES.PROVIDER_UNAVAILABLE),
    );
  }
  assert.equal(constructorCalls, 0);
});

test("v0.87 DB Block 5: injizierter Pool erhält die Policy und wird genau einmal geschlossen", async () => {
  let instance;
  let receivedConfiguration;
  class FakePool {
    constructor(configuration) {
      receivedConfiguration = configuration;
      this.endCalls = 0;
      instance = this;
    }

    connect() {
      throw new Error("Für diesen Lebenszyklustest darf keine Verbindung geöffnet werden.");
    }

    async end() {
      this.endCalls += 1;
    }
  }

  const databaseUrl = "postgresql://app:secret@127.0.0.1:5432/grabenplaner";
  const provider = openPostgresqlDevelopmentPersistence({
    profile: POSTGRESQL_EXPERIMENTAL_PROFILE,
    databaseUrl,
    catalog: [],
    tlsMode: "disable-local-only",
    applicationName: "grabenplaner-db5-contract-test",
    allowExitOnIdle: true,
    policy: {
      minimumConnections: 1,
      maximumConnections: 7,
      connectionTimeoutMilliseconds: 1_200,
      idleTimeoutMilliseconds: 45_000,
      statementTimeoutMilliseconds: 12_000,
      queryTimeoutMilliseconds: 12_500,
      transactionTimeoutMilliseconds: 45_000,
      maximumConnectionLifetimeSeconds: 1_800,
    },
    Pool: FakePool,
  });

  assert.deepEqual(receivedConfiguration, {
    connectionString: databaseUrl,
    application_name: "grabenplaner-db5-contract-test",
    min: 1,
    max: 7,
    connectionTimeoutMillis: 1_200,
    idleTimeoutMillis: 45_000,
    statement_timeout: 12_000,
    query_timeout: 12_500,
    idle_in_transaction_session_timeout: 45_000,
    maxLifetimeSeconds: 1_800,
    allowExitOnIdle: true,
    ssl: false,
  });
  assert.equal(Object.isFrozen(receivedConfiguration), true);
  assert.equal(instance.endCalls, 0);

  await Promise.all([provider.close(), provider.close(), provider.close()]);
  assert.equal(instance.endCalls, 1);
});
