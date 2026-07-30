"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OPERATIONAL_CAPABILITY_KEYS,
  createOperationalCapabilityReport,
} = require("../lib/persistence/operations/contract");
const {
  POSTGRESQL_LOGICAL_BACKUP_METHOD,
  POSTGRESQL_LOGICAL_RESTORE_METHOD,
  POSTGRESQL_OPERATIONAL_PROFILE,
} = require("../lib/persistence/postgresql/operations/tools");
const {
  POSTGRESQL_MONITOR_ERROR_CODES,
  POSTGRESQL_MONITOR_REASON_CODES,
  POSTGRESQL_OPERATIONAL_ARTIFACT_FORMAT,
  REQUIRED_ACCESS_POLICY,
  createPostgresqlOperationsMonitor,
} = require("../lib/persistence/postgresql/operations/monitor");

const NOW = "2026-07-30T12:00:00.000Z";
const REQUIRED_EVIDENCE = new Set([
  "databaseBackup",
  "restore",
  "integrityCheck",
  "recoveryAssurance",
  "systemCenterStatus",
  "pairedDocumentBackup",
]);

function capability(overrides = {}) {
  return {
    implemented: false,
    configured: false,
    verified: false,
    reasonCode: "NOT_IMPLEMENTED",
    lastVerifiedAt: null,
    maximumAgeHours: null,
    ...overrides,
  };
}

function capabilityMap({
  verifiedAt = "2026-07-30T11:30:00.000Z",
  maximumAgeHours = 24,
} = {}) {
  return Object.fromEntries(OPERATIONAL_CAPABILITY_KEYS.map((key) => [
    key,
    REQUIRED_EVIDENCE.has(key)
      ? capability({
        implemented: true,
        configured: true,
        verified: true,
        reasonCode: null,
        lastVerifiedAt: verifiedAt,
        maximumAgeHours,
      })
      : capability(),
  ]));
}

function capabilityReport(overrides = {}) {
  return createOperationalCapabilityReport({
    providerId: "postgresql",
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    backupMethod: POSTGRESQL_LOGICAL_BACKUP_METHOD,
    restoreMethod: POSTGRESQL_LOGICAL_RESTORE_METHOD,
    artifactFormat: POSTGRESQL_OPERATIONAL_ARTIFACT_FORMAT,
    generatedAt: NOW,
    capabilities: capabilityMap(),
    ...overrides,
  });
}

function monitoringRow(overrides = {}) {
  return {
    server_version_num: "180001",
    in_recovery: false,
    transaction_read_only: true,
    database_bytes: "987654321012345",
    connections_total: "7",
    connections_active: "2",
    connections_idle_in_transaction: "1",
    connections_waiting: "1",
    commits: "9007199254740993",
    rollbacks: "42",
    deadlocks: "3",
    identity_matches_session: true,
    role_superuser: false,
    role_createdb: false,
    role_createrole: false,
    role_replication: false,
    role_bypassrls: false,
    role_monitor_membership: true,
    role_unexpected_memberships: "0",
    ...overrides,
  };
}

function monitorWithQuery(operationsQuery, options = {}) {
  return createPostgresqlOperationsMonitor({
    operationsQuery,
    accessPolicy: { ...REQUIRED_ACCESS_POLICY },
    now: () => NOW,
    ...options,
  });
}

test("DB Block 6 PostgreSQL-Monitor: Happy Path bleibt redigiert und nichtproduktiv", async () => {
  let observedText = "";
  let observedParameters;
  const monitor = monitorWithQuery(async (text, parameters) => {
    observedText = text;
    observedParameters = parameters;
    return {
      command: "SELECT",
      rowCount: 1,
      rows: [monitoringRow()],
    };
  });
  const result = await monitor.read({ capabilityReport: capabilityReport() });

  assert.equal(result.state, "development");
  assert.equal(result.productActivation, false);
  assert.equal(result.capabilityBinding.evidenceState, "verified");
  assert.deepEqual(result.reasonCodes, [
    POSTGRESQL_MONITOR_REASON_CODES.DEVELOPMENT_ONLY,
  ]);
  assert.deepEqual(result.metrics, {
    serverMajor: 18,
    inRecovery: false,
    transactionReadOnly: true,
    databaseBytes: "987654321012345",
    connections: {
      total: 7,
      active: 2,
      idleInTransaction: 1,
      waiting: 1,
    },
    transactions: {
      commits: "9007199254740993",
      rollbacks: "42",
      deadlocks: "3",
    },
    roleBoundary: {
      currentSessionIdentity: true,
      privilegedFlags: false,
      monitorMembership: true,
      unexpectedMemberships: 0,
      leastPrivilege: true,
    },
  });
  assert.deepEqual(result.accessPolicy, {
    dedicatedOperationsIdentity: true,
    transactionReadOnlyRequired: true,
    dmlAllowed: false,
    ddlAllowed: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.metrics.connections), true);
  assert.deepEqual(observedParameters, []);
  assert.match(observedText, /^\s*WITH\b/i);
  assert.doesNotMatch(observedText, /\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "database_name",
    "schema_name",
    "db.example",
    "operations_user",
    "monitoring_role",
    "postgresql://",
    "SELECT pg_",
    "C:\\",
    "/var/lib/",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(serialized, /"state":"(?:ok|green|healthy)"/i);
});

test("DB Block 6 PostgreSQL-Monitor: fehlende Evidence bleibt unknown, alte und zukünftige werden warning", async () => {
  const monitor = monitorWithQuery(async () => ({ rows: [monitoringRow()] }));

  const missingReport = await monitor.read();
  assert.equal(missingReport.state, "unknown");
  assert.equal(missingReport.capabilityBinding.evidenceState, "missing");
  assert.ok(missingReport.reasonCodes.includes(
    POSTGRESQL_MONITOR_REASON_CODES.EVIDENCE_MISSING,
  ));

  const missingCapabilityValues = capabilityMap();
  missingCapabilityValues.restore = capability({
    implemented: true,
    configured: true,
    verified: false,
    reasonCode: "RESTORE_NOT_VERIFIED",
  });
  const missingCapability = await monitor.read({
    capabilityReport: capabilityReport({ capabilities: missingCapabilityValues }),
  });
  assert.equal(missingCapability.state, "unknown");
  assert.equal(missingCapability.capabilityBinding.evidenceState, "missing");

  const unboundedCapabilityValues = capabilityMap();
  unboundedCapabilityValues.recoveryAssurance = capability({
    implemented: true,
    configured: true,
    verified: true,
    reasonCode: null,
    lastVerifiedAt: "2026-07-30T11:30:00.000Z",
    maximumAgeHours: null,
  });
  const unboundedCapability = await monitor.read({
    capabilityReport: capabilityReport({ capabilities: unboundedCapabilityValues }),
  });
  assert.equal(unboundedCapability.state, "unknown");
  assert.equal(unboundedCapability.capabilityBinding.evidenceState, "missing");

  const stale = await monitor.read({
    capabilityReport: capabilityReport({
      capabilities: capabilityMap({
        verifiedAt: "2026-07-28T11:00:00.000Z",
        maximumAgeHours: 24,
      }),
    }),
  });
  assert.equal(stale.state, "warning");
  assert.equal(stale.capabilityBinding.evidenceState, "stale");
  assert.ok(stale.reasonCodes.includes(
    POSTGRESQL_MONITOR_REASON_CODES.EVIDENCE_STALE,
  ));

  const future = await monitor.read({
    capabilityReport: capabilityReport({
      generatedAt: "2026-07-30T12:30:00.000Z",
      capabilities: capabilityMap({
        verifiedAt: "2026-07-30T12:20:00.000Z",
      }),
    }),
  });
  assert.equal(future.state, "warning");
  assert.equal(future.capabilityBinding.evidenceState, "future");
  assert.ok(future.reasonCodes.includes(
    POSTGRESQL_MONITOR_REASON_CODES.EVIDENCE_FUTURE,
  ));

  for (const result of [
    missingReport,
    missingCapability,
    unboundedCapability,
    stale,
    future,
  ]) {
    assert.equal(result.productActivation, false);
    assert.notEqual(result.state, "ok");
  }
});

test("DB Block 6 PostgreSQL-Monitor: Provider- und Methodenmismatch stoppen vor der Abfrage", async () => {
  let queryCalls = 0;
  const monitor = monitorWithQuery(async () => {
    queryCalls += 1;
    return { rows: [monitoringRow()] };
  });

  const wrongProvider = await monitor.read({
    capabilityReport: capabilityReport({
      providerId: "sqlite",
    }),
  });
  assert.equal(wrongProvider.state, "error");
  assert.equal(wrongProvider.metrics, null);
  assert.ok(wrongProvider.reasonCodes.includes(
    POSTGRESQL_MONITOR_REASON_CODES.PROVIDER_MISMATCH,
  ));

  const wrongMethod = await monitor.read({
    capabilityReport: capabilityReport({
      backupMethod: "sqlite-vacuum-into-v1",
    }),
  });
  assert.equal(wrongMethod.state, "error");
  assert.equal(wrongMethod.metrics, null);
  assert.ok(wrongMethod.reasonCodes.includes(
    POSTGRESQL_MONITOR_REASON_CODES.METHOD_MISMATCH,
  ));
  assert.equal(queryCalls, 0);
});

test("DB Block 6 PostgreSQL-Monitor: Treiberfehler werden auf einen festen Code redigiert", async () => {
  const secret = "postgresql://monitor:SEHR-GEHEIM@db.example/internal";
  const monitor = monitorWithQuery(async () => {
    const error = new Error(`connection failed for ${secret}`);
    error.detail = `role=monitoring_role path=/var/lib/private ${secret}`;
    throw error;
  });

  await assert.rejects(
    monitor.read({ capabilityReport: capabilityReport() }),
    (error) => {
      assert.equal(error?.code, POSTGRESQL_MONITOR_ERROR_CODES.QUERY_FAILED);
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.equal(`${error.message}\n${JSON.stringify(error)}`.includes("SEHR-GEHEIM"), false);
      assert.equal(`${error.message}\n${JSON.stringify(error)}`.includes("db.example"), false);
      return true;
    },
  );
});

test("DB Block 6 PostgreSQL-Monitor: unzulässige Resultatfelder und Werte scheitern geschlossen", async () => {
  for (const result of [
    {
      rows: [{
        ...monitoringRow(),
        database_name: "internal-secret",
      }],
    },
    {
      rows: [monitoringRow({ connections_active: "8" })],
    },
    {
      rows: [monitoringRow({ commits: "01" })],
    },
    {
      rows: [monitoringRow()],
      databaseUrl: "postgresql://secret",
    },
  ]) {
    const monitor = monitorWithQuery(async () => result);
    await assert.rejects(
      monitor.read({ capabilityReport: capabilityReport() }),
      (error) => error?.code === POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID,
    );
  }
});

test("DB Block 6 PostgreSQL-Monitor: Operationsidentität erzwingt DML-Verbot und READ ONLY", async () => {
  assert.throws(
    () => createPostgresqlOperationsMonitor({
      operationsQuery: async () => ({ rows: [monitoringRow()] }),
      accessPolicy: {
        ...REQUIRED_ACCESS_POLICY,
        dmlAllowed: true,
      },
    }),
    (error) => error?.code === POSTGRESQL_MONITOR_ERROR_CODES.CONFIGURATION_INVALID,
  );

  const monitor = monitorWithQuery(async () => ({
    rows: [monitoringRow({ transaction_read_only: false })],
  }));
  const result = await monitor.read({ capabilityReport: capabilityReport() });
  assert.equal(result.state, "error");
  assert.equal(result.productActivation, false);
  assert.equal(result.accessPolicy.dmlAllowed, false);
  assert.ok(result.reasonCodes.includes(
    POSTGRESQL_MONITOR_REASON_CODES.TRANSACTION_NOT_READ_ONLY,
  ));

  const privilegedMonitor = monitorWithQuery(async () => ({
    rows: [monitoringRow({
      role_superuser: true,
      role_unexpected_memberships: "1",
    })],
  }));
  const privilegedResult = await privilegedMonitor.read({
    capabilityReport: capabilityReport(),
  });
  assert.equal(privilegedResult.state, "error");
  assert.equal(privilegedResult.metrics.roleBoundary.leastPrivilege, false);
  assert.ok(privilegedResult.reasonCodes.includes(
    POSTGRESQL_MONITOR_REASON_CODES.ROLE_BOUNDARY_INVALID,
  ));
});

test("DB Block 6 PostgreSQL-Monitor: enges Client-Interface wird ohne Handle-Leak genutzt", async () => {
  let calls = 0;
  const client = {
    async query(text, parameters) {
      calls += 1;
      assert.equal(typeof text, "string");
      assert.deepEqual(parameters, []);
      return { rows: [monitoringRow()] };
    },
  };
  const monitor = createPostgresqlOperationsMonitor({
    client,
    accessPolicy: { ...REQUIRED_ACCESS_POLICY },
    now: () => NOW,
  });
  const result = await monitor.read({ capabilityReport: capabilityReport() });
  assert.equal(calls, 1);
  assert.equal(result.state, "development");
  assert.equal("client" in result, false);
});
