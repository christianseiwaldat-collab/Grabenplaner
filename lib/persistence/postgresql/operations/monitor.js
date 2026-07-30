"use strict";

const { isDeepStrictEqual } = require("node:util");

const {
  OPERATIONAL_CAPABILITY_KEYS,
  OPERATIONAL_CONTRACT_VERSION,
  createOperationalCapabilityReport,
} = require("../../operations/contract");
const {
  POSTGRESQL_LOGICAL_BACKUP_METHOD,
  POSTGRESQL_LOGICAL_RESTORE_METHOD,
  POSTGRESQL_OPERATIONAL_PROFILE,
} = require("./tools");

const POSTGRESQL_MONITOR_FORMAT = "grabenplaner-postgresql-operational-monitor";
const POSTGRESQL_MONITOR_SCHEMA_VERSION = 1;
const POSTGRESQL_OPERATIONAL_ARTIFACT_FORMAT = "grabenplaner-backup-bundle-v2";
const MAXIMUM_FUTURE_TOLERANCE_MILLISECONDS = 5 * 60 * 1000;

const POSTGRESQL_MONITOR_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "POSTGRESQL_MONITOR_CONFIGURATION_INVALID",
  CAPABILITY_REPORT_INVALID: "POSTGRESQL_MONITOR_CAPABILITY_REPORT_INVALID",
  QUERY_FAILED: "POSTGRESQL_MONITOR_QUERY_FAILED",
  RESULT_INVALID: "POSTGRESQL_MONITOR_RESULT_INVALID",
});

const POSTGRESQL_MONITOR_REASON_CODES = Object.freeze({
  DEVELOPMENT_ONLY: "POSTGRESQL_MONITOR_DEVELOPMENT_ONLY",
  EVIDENCE_MISSING: "POSTGRESQL_MONITOR_EVIDENCE_MISSING",
  EVIDENCE_STALE: "POSTGRESQL_MONITOR_EVIDENCE_STALE",
  EVIDENCE_FUTURE: "POSTGRESQL_MONITOR_EVIDENCE_FUTURE",
  PROVIDER_MISMATCH: "POSTGRESQL_MONITOR_PROVIDER_MISMATCH",
  PROFILE_MISMATCH: "POSTGRESQL_MONITOR_PROFILE_MISMATCH",
  METHOD_MISMATCH: "POSTGRESQL_MONITOR_METHOD_MISMATCH",
  ARTIFACT_FORMAT_MISMATCH: "POSTGRESQL_MONITOR_ARTIFACT_FORMAT_MISMATCH",
  ACTIVATION_MISMATCH: "POSTGRESQL_MONITOR_ACTIVATION_MISMATCH",
  TRANSACTION_NOT_READ_ONLY: "POSTGRESQL_MONITOR_TRANSACTION_NOT_READ_ONLY",
  ROLE_BOUNDARY_INVALID: "POSTGRESQL_MONITOR_ROLE_BOUNDARY_INVALID",
});

const REQUIRED_EVIDENCE_CAPABILITIES = Object.freeze([
  "databaseBackup",
  "restore",
  "integrityCheck",
  "recoveryAssurance",
  "systemCenterStatus",
  "pairedDocumentBackup",
]);

const REQUIRED_ACCESS_POLICY = Object.freeze({
  dedicatedOperationsIdentity: true,
  transactionReadOnlyRequired: true,
  dmlAllowed: false,
  ddlAllowed: false,
});

const MONITOR_RESULT_KEYS = Object.freeze([
  "server_version_num",
  "in_recovery",
  "transaction_read_only",
  "database_bytes",
  "connections_total",
  "connections_active",
  "connections_idle_in_transaction",
  "connections_waiting",
  "commits",
  "rollbacks",
  "deadlocks",
  "identity_matches_session",
  "role_superuser",
  "role_createdb",
  "role_createrole",
  "role_replication",
  "role_bypassrls",
  "role_monitor_membership",
  "role_unexpected_memberships",
]);

const MONITOR_QUERY_RESULT_KEYS = Object.freeze([
  "command",
  "fields",
  "oid",
  "rowCount",
  "rows",
  "_parsers",
  "_types",
  "RowCtor",
  "rowAsArray",
  "_prebuiltEmptyResultObject",
]);

const POSTGRESQL_MONITOR_QUERY = `
WITH connection_totals AS (
  SELECT
    count(*)::text AS connections_total,
    count(*) FILTER (WHERE state = 'active')::text AS connections_active,
    count(*) FILTER (
      WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
    )::text AS connections_idle_in_transaction,
    count(*) FILTER (WHERE wait_event_type IS NOT NULL)::text AS connections_waiting
  FROM pg_stat_activity
  WHERE datid = (
    SELECT oid
    FROM pg_database
    WHERE datname = current_database()
  )
),
database_totals AS (
  SELECT
    xact_commit::text AS commits,
    xact_rollback::text AS rollbacks,
    deadlocks::text AS deadlocks
  FROM pg_stat_database
  WHERE datid = (
    SELECT oid
    FROM pg_database
    WHERE datname = current_database()
  )
),
role_boundary AS (
  SELECT
    (current_user = session_user) AS identity_matches_session,
    role.rolsuper AS role_superuser,
    role.rolcreatedb AS role_createdb,
    role.rolcreaterole AS role_createrole,
    role.rolreplication AS role_replication,
    role.rolbypassrls AS role_bypassrls,
    pg_has_role(role.oid, 'pg_monitor', 'MEMBER') AS role_monitor_membership,
    (
      SELECT count(*)::text
      FROM pg_auth_members AS membership
      JOIN pg_roles AS granted_role
        ON granted_role.oid = membership.roleid
      WHERE membership.member = role.oid
        AND granted_role.rolname <> 'pg_monitor'
    ) AS role_unexpected_memberships
  FROM pg_roles AS role
  WHERE role.rolname = current_user
)
SELECT
  current_setting('server_version_num') AS server_version_num,
  pg_is_in_recovery() AS in_recovery,
  (current_setting('transaction_read_only') = 'on') AS transaction_read_only,
  pg_database_size(current_database())::text AS database_bytes,
  connection_totals.connections_total,
  connection_totals.connections_active,
  connection_totals.connections_idle_in_transaction,
  connection_totals.connections_waiting,
  database_totals.commits,
  database_totals.rollbacks,
  database_totals.deadlocks,
  role_boundary.identity_matches_session,
  role_boundary.role_superuser,
  role_boundary.role_createdb,
  role_boundary.role_createrole,
  role_boundary.role_replication,
  role_boundary.role_bypassrls,
  role_boundary.role_monitor_membership,
  role_boundary.role_unexpected_memberships
FROM connection_totals
CROSS JOIN database_totals
CROSS JOIN role_boundary
`.trim();

class PostgresqlMonitoringError extends Error {
  constructor(code) {
    super("Der PostgreSQL-Betriebsstatus konnte nicht sicher ermittelt werden.");
    this.name = "PostgresqlMonitoringError";
    this.code = code;
  }
}

function monitoringError(code) {
  return new PostgresqlMonitoringError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, code = POSTGRESQL_MONITOR_ERROR_CODES.CONFIGURATION_INVALID) {
  if (!isPlainObject(value)
    || Object.keys(value).some((key) => !allowed.includes(key))
    || allowed.some((key) => !Object.hasOwn(value, key))) {
    throw monitoringError(code);
  }
}

function assertOnlyKeys(value, allowed, code = POSTGRESQL_MONITOR_ERROR_CODES.CONFIGURATION_INVALID) {
  if (!isPlainObject(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw monitoringError(code);
  }
}

function assertQueryResultKeys(value) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !MONITOR_QUERY_RESULT_KEYS.includes(key))) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function canonicalTimestamp(value, code = POSTGRESQL_MONITOR_ERROR_CODES.CONFIGURATION_INVALID) {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
    || !Number.isFinite(Date.parse(text))
    || new Date(Date.parse(text)).toISOString() !== text) {
    throw monitoringError(code);
  }
  return text;
}

function normalizeAccessPolicy(value) {
  assertExactKeys(value, Object.keys(REQUIRED_ACCESS_POLICY));
  if (!isDeepStrictEqual(value, REQUIRED_ACCESS_POLICY)) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.CONFIGURATION_INVALID);
  }
  return Object.freeze({ ...REQUIRED_ACCESS_POLICY });
}

function queryFunctionFromOptions(options) {
  const sources = [
    typeof options.operationsQuery === "function" ? options.operationsQuery : null,
    options.client,
    options.pool,
  ].filter(Boolean);
  if (sources.length !== 1) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.CONFIGURATION_INVALID);
  }
  if (typeof options.operationsQuery === "function") return options.operationsQuery;
  const source = options.client || options.pool;
  if (!source || typeof source !== "object" || typeof source.query !== "function") {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.CONFIGURATION_INVALID);
  }
  return source.query.bind(source);
}

function rawCapabilitiesFromReport(report) {
  assertExactKeys(report, [
    "contractVersion",
    "providerId",
    "profile",
    "productActivation",
    "backupMethod",
    "restoreMethod",
    "artifactFormat",
    "generatedAt",
    "capabilities",
  ], POSTGRESQL_MONITOR_ERROR_CODES.CAPABILITY_REPORT_INVALID);
  assertExactKeys(
    report.capabilities,
    OPERATIONAL_CAPABILITY_KEYS,
    POSTGRESQL_MONITOR_ERROR_CODES.CAPABILITY_REPORT_INVALID,
  );
  const raw = {};
  for (const key of OPERATIONAL_CAPABILITY_KEYS) {
    const capability = report.capabilities[key];
    assertExactKeys(capability, [
      "implemented",
      "configured",
      "verified",
      "effective",
      "state",
      "reasonCode",
      "lastVerifiedAt",
      "maximumAgeHours",
      "ageHours",
    ], POSTGRESQL_MONITOR_ERROR_CODES.CAPABILITY_REPORT_INVALID);
    raw[key] = {
      implemented: capability.implemented,
      configured: capability.configured,
      verified: capability.verified,
      reasonCode: capability.reasonCode,
      lastVerifiedAt: capability.lastVerifiedAt,
      maximumAgeHours: capability.maximumAgeHours,
    };
  }
  return raw;
}

function validateCapabilityReport(report, monitorGeneratedAt) {
  if (report === undefined || report === null) {
    return Object.freeze({
      report: null,
      refreshed: null,
      future: false,
    });
  }
  try {
    const rawCapabilities = rawCapabilitiesFromReport(report);
    const reconstructed = createOperationalCapabilityReport({
      providerId: report.providerId,
      profile: report.profile,
      backupMethod: report.backupMethod,
      restoreMethod: report.restoreMethod,
      artifactFormat: report.artifactFormat,
      generatedAt: report.generatedAt,
      capabilities: rawCapabilities,
    });
    if (report.contractVersion !== OPERATIONAL_CONTRACT_VERSION
      || !isDeepStrictEqual(reconstructed, report)) {
      throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.CAPABILITY_REPORT_INVALID);
    }
    const refreshed = createOperationalCapabilityReport({
      providerId: report.providerId,
      profile: report.profile,
      backupMethod: report.backupMethod,
      restoreMethod: report.restoreMethod,
      artifactFormat: report.artifactFormat,
      generatedAt: monitorGeneratedAt,
      capabilities: rawCapabilities,
    });
    const monitorTime = Date.parse(monitorGeneratedAt);
    const future = Date.parse(report.generatedAt) > monitorTime + MAXIMUM_FUTURE_TOLERANCE_MILLISECONDS
      || REQUIRED_EVIDENCE_CAPABILITIES.some((key) => {
        const verifiedAt = report.capabilities[key].lastVerifiedAt;
        return verifiedAt !== null
          && Date.parse(verifiedAt) > monitorTime + MAXIMUM_FUTURE_TOLERANCE_MILLISECONDS;
      });
    return Object.freeze({ report, refreshed, future });
  } catch (error) {
    if (error instanceof PostgresqlMonitoringError) throw error;
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.CAPABILITY_REPORT_INVALID);
  }
}

function assessCapabilityEvidence(validated) {
  const reasonCodes = [POSTGRESQL_MONITOR_REASON_CODES.DEVELOPMENT_ONLY];
  if (!validated.report) {
    reasonCodes.push(POSTGRESQL_MONITOR_REASON_CODES.EVIDENCE_MISSING);
    return {
      state: "unknown",
      evidenceState: "missing",
      reasonCodes,
      queryAllowed: true,
    };
  }
  const { report, refreshed } = validated;
  const mismatches = [];
  if (report.providerId !== "postgresql") {
    mismatches.push(POSTGRESQL_MONITOR_REASON_CODES.PROVIDER_MISMATCH);
  }
  if (report.profile !== POSTGRESQL_OPERATIONAL_PROFILE) {
    mismatches.push(POSTGRESQL_MONITOR_REASON_CODES.PROFILE_MISMATCH);
  }
  if (report.backupMethod !== POSTGRESQL_LOGICAL_BACKUP_METHOD
    || report.restoreMethod !== POSTGRESQL_LOGICAL_RESTORE_METHOD) {
    mismatches.push(POSTGRESQL_MONITOR_REASON_CODES.METHOD_MISMATCH);
  }
  if (report.artifactFormat !== POSTGRESQL_OPERATIONAL_ARTIFACT_FORMAT) {
    mismatches.push(POSTGRESQL_MONITOR_REASON_CODES.ARTIFACT_FORMAT_MISMATCH);
  }
  if (report.productActivation !== false) {
    mismatches.push(POSTGRESQL_MONITOR_REASON_CODES.ACTIVATION_MISMATCH);
  }
  if (mismatches.length) {
    return {
      state: "error",
      evidenceState: "mismatch",
      reasonCodes: [...reasonCodes, ...mismatches],
      queryAllowed: false,
    };
  }
  if (validated.future) {
    reasonCodes.push(POSTGRESQL_MONITOR_REASON_CODES.EVIDENCE_FUTURE);
    return {
      state: "warning",
      evidenceState: "future",
      reasonCodes,
      queryAllowed: true,
    };
  }
  const states = REQUIRED_EVIDENCE_CAPABILITIES.map(
    (key) => refreshed.capabilities[key].state,
  );
  if (states.includes("stale")) {
    reasonCodes.push(POSTGRESQL_MONITOR_REASON_CODES.EVIDENCE_STALE);
    return {
      state: "warning",
      evidenceState: "stale",
      reasonCodes,
      queryAllowed: true,
    };
  }
  if (states.some((state) => state !== "available")
    || REQUIRED_EVIDENCE_CAPABILITIES.some(
      (key) => refreshed.capabilities[key].maximumAgeHours === null,
    )) {
    reasonCodes.push(POSTGRESQL_MONITOR_REASON_CODES.EVIDENCE_MISSING);
    return {
      state: "unknown",
      evidenceState: "missing",
      reasonCodes,
      queryAllowed: true,
    };
  }
  return {
    state: "development",
    evidenceState: "verified",
    reasonCodes,
    queryAllowed: true,
  };
}

function canonicalUnsignedDecimal(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID);
  }
  return value;
}

function safeConnectionCount(value) {
  const decimal = canonicalUnsignedDecimal(value);
  const count = Number(decimal);
  if (!Number.isSafeInteger(count)) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID);
  }
  return count;
}

function normalizeMetricsResult(result) {
  // node-postgres returns a Result class instance rather than a plain object.
  // Its own fields remain strictly allowlisted and are never exposed.
  assertQueryResultKeys(result);
  if (!Object.hasOwn(result, "rows")
    || !Array.isArray(result.rows)
    || result.rows.length !== 1) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID);
  }
  const row = result.rows[0];
  assertExactKeys(
    row,
    MONITOR_RESULT_KEYS,
    POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID,
  );
  if (typeof row.in_recovery !== "boolean"
    || typeof row.transaction_read_only !== "boolean"
    || typeof row.identity_matches_session !== "boolean"
    || typeof row.role_superuser !== "boolean"
    || typeof row.role_createdb !== "boolean"
    || typeof row.role_createrole !== "boolean"
    || typeof row.role_replication !== "boolean"
    || typeof row.role_bypassrls !== "boolean"
    || typeof row.role_monitor_membership !== "boolean") {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID);
  }
  const versionNumberText = canonicalUnsignedDecimal(row.server_version_num);
  const versionNumber = Number(versionNumberText);
  const serverMajor = Math.floor(versionNumber / 10_000);
  if (!Number.isSafeInteger(versionNumber)
    || serverMajor < 14
    || serverMajor > 99) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID);
  }
  const connections = {
    total: safeConnectionCount(row.connections_total),
    active: safeConnectionCount(row.connections_active),
    idleInTransaction: safeConnectionCount(row.connections_idle_in_transaction),
    waiting: safeConnectionCount(row.connections_waiting),
  };
  if (connections.active > connections.total
    || connections.idleInTransaction > connections.total
    || connections.waiting > connections.total) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.RESULT_INVALID);
  }
  const unexpectedRoleMemberships = safeConnectionCount(
    row.role_unexpected_memberships,
  );
  const privilegedFlags = row.role_superuser
    || row.role_createdb
    || row.role_createrole
    || row.role_replication
    || row.role_bypassrls;
  return deepFreeze({
    serverMajor,
    inRecovery: row.in_recovery,
    transactionReadOnly: row.transaction_read_only,
    databaseBytes: canonicalUnsignedDecimal(row.database_bytes),
    connections,
    transactions: {
      commits: canonicalUnsignedDecimal(row.commits),
      rollbacks: canonicalUnsignedDecimal(row.rollbacks),
      deadlocks: canonicalUnsignedDecimal(row.deadlocks),
    },
    roleBoundary: {
      currentSessionIdentity: row.identity_matches_session,
      privilegedFlags,
      monitorMembership: row.role_monitor_membership,
      unexpectedMemberships: unexpectedRoleMemberships,
      leastPrivilege: row.identity_matches_session
        && !privilegedFlags
        && row.role_monitor_membership
        && unexpectedRoleMemberships === 0,
    },
  });
}

function emptyMonitoringResult({
  generatedAt,
  accessPolicy,
  assessment,
} = {}) {
  return deepFreeze({
    format: POSTGRESQL_MONITOR_FORMAT,
    schemaVersion: POSTGRESQL_MONITOR_SCHEMA_VERSION,
    generatedAt,
    providerId: "postgresql",
    profile: POSTGRESQL_OPERATIONAL_PROFILE,
    productActivation: false,
    state: assessment.state,
    reasonCodes: [...assessment.reasonCodes],
    capabilityBinding: {
      backupMethod: POSTGRESQL_LOGICAL_BACKUP_METHOD,
      restoreMethod: POSTGRESQL_LOGICAL_RESTORE_METHOD,
      artifactFormat: POSTGRESQL_OPERATIONAL_ARTIFACT_FORMAT,
      evidenceState: assessment.evidenceState,
    },
    accessPolicy: { ...accessPolicy },
    metrics: null,
  });
}

function createPostgresqlOperationsMonitor(options = {}) {
  assertOnlyKeys(options, [
    "operationsQuery",
    "client",
    "pool",
    "accessPolicy",
    "now",
  ]);
  if (!Object.hasOwn(options, "accessPolicy")
    || (options.now !== undefined && typeof options.now !== "function")) {
    throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.CONFIGURATION_INVALID);
  }
  const operationsQuery = queryFunctionFromOptions(options);
  const accessPolicy = normalizeAccessPolicy(options.accessPolicy);
  const now = options.now || (() => new Date());

  return Object.freeze({
    async read(input = {}) {
      assertOnlyKeys(input, ["capabilityReport"]);
      const generatedAt = canonicalTimestamp(now());
      const validated = validateCapabilityReport(input.capabilityReport, generatedAt);
      const assessment = assessCapabilityEvidence(validated);
      if (!assessment.queryAllowed) {
        return emptyMonitoringResult({ generatedAt, accessPolicy, assessment });
      }
      let queryResult;
      try {
        queryResult = await operationsQuery(POSTGRESQL_MONITOR_QUERY, Object.freeze([]));
      } catch {
        throw monitoringError(POSTGRESQL_MONITOR_ERROR_CODES.QUERY_FAILED);
      }
      const metrics = normalizeMetricsResult(queryResult);
      if (!metrics.transactionReadOnly) {
        assessment.state = "error";
        assessment.evidenceState = "mismatch";
        assessment.reasonCodes = [
          ...assessment.reasonCodes,
          POSTGRESQL_MONITOR_REASON_CODES.TRANSACTION_NOT_READ_ONLY,
        ];
      }
      if (!metrics.roleBoundary.leastPrivilege) {
        assessment.state = "error";
        assessment.evidenceState = "mismatch";
        assessment.reasonCodes = [
          ...assessment.reasonCodes,
          POSTGRESQL_MONITOR_REASON_CODES.ROLE_BOUNDARY_INVALID,
        ];
      }
      return deepFreeze({
        ...emptyMonitoringResult({ generatedAt, accessPolicy, assessment }),
        metrics,
      });
    },
  });
}

module.exports = {
  POSTGRESQL_MONITOR_ERROR_CODES,
  POSTGRESQL_MONITOR_FORMAT,
  POSTGRESQL_MONITOR_REASON_CODES,
  POSTGRESQL_MONITOR_SCHEMA_VERSION,
  POSTGRESQL_OPERATIONAL_ARTIFACT_FORMAT,
  PostgresqlMonitoringError,
  REQUIRED_ACCESS_POLICY,
  createPostgresqlOperationsMonitor,
};
