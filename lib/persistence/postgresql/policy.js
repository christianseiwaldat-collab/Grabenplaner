"use strict";

const POSTGRESQL_EXPERIMENTAL_PROFILE = "development-contract";
const POSTGRESQL_TLS_MODES = Object.freeze([
  "verify-full",
  "disable-local-only",
]);
const POSTGRESQL_ROLE_PURPOSES = Object.freeze([
  "application",
  "backup",
  "migration",
  "operations",
]);
const DEFAULT_POSTGRESQL_POOL_POLICY = Object.freeze({
  minimumConnections: 0,
  maximumConnections: 5,
  connectionTimeoutMilliseconds: 5_000,
  idleTimeoutMilliseconds: 30_000,
  statementTimeoutMilliseconds: 30_000,
  queryTimeoutMilliseconds: 32_000,
  transactionTimeoutMilliseconds: 60_000,
  maximumConnectionLifetimeSeconds: 3_600,
});

function policyError() {
  return new TypeError("Die PostgreSQL-Poolrichtlinie ist ungültig.");
}

function safeIntegerInRange(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function normalizePostgresqlPoolPolicy(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw policyError();
  }
  const allowed = new Set(Object.keys(DEFAULT_POSTGRESQL_POOL_POLICY));
  if (Object.keys(overrides).some((key) => !allowed.has(key))) throw policyError();
  const policy = {
    ...DEFAULT_POSTGRESQL_POOL_POLICY,
    ...overrides,
  };
  if (!safeIntegerInRange(policy.minimumConnections, 0, 20)
    || !safeIntegerInRange(policy.maximumConnections, 1, 50)
    || policy.minimumConnections > policy.maximumConnections
    || !safeIntegerInRange(policy.connectionTimeoutMilliseconds, 100, 60_000)
    || !safeIntegerInRange(policy.idleTimeoutMilliseconds, 1_000, 600_000)
    || !safeIntegerInRange(policy.statementTimeoutMilliseconds, 100, 300_000)
    || !safeIntegerInRange(policy.queryTimeoutMilliseconds, 100, 300_000)
    || policy.queryTimeoutMilliseconds < policy.statementTimeoutMilliseconds
    || !safeIntegerInRange(policy.transactionTimeoutMilliseconds, 100, 600_000)
    || policy.transactionTimeoutMilliseconds < policy.statementTimeoutMilliseconds
    || !safeIntegerInRange(policy.maximumConnectionLifetimeSeconds, 60, 86_400)) {
    throw policyError();
  }
  return Object.freeze(policy);
}

function assertDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) throw policyError();
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw policyError();
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
    || !parsed.hostname
    || !parsed.pathname
    || parsed.pathname === "/"
    || [...parsed.searchParams.keys()].some((key) => /^ssl/i.test(key))) {
    throw policyError();
  }
  return parsed;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

function createPostgresqlPoolConfiguration({
  databaseUrl,
  tlsMode = "verify-full",
  policy,
  applicationName = "grabenplaner-development-contract",
  allowExitOnIdle = false,
} = {}) {
  const parsed = assertDatabaseUrl(databaseUrl);
  if (!POSTGRESQL_TLS_MODES.includes(tlsMode)
    || (tlsMode === "disable-local-only" && !isLoopbackHostname(parsed.hostname))
    || typeof applicationName !== "string"
    || !/^[a-zA-Z][a-zA-Z0-9._-]{2,62}$/.test(applicationName)
    || typeof allowExitOnIdle !== "boolean") {
    throw policyError();
  }
  const normalizedPolicy = normalizePostgresqlPoolPolicy(policy);
  return Object.freeze({
    connectionString: databaseUrl,
    application_name: applicationName,
    min: normalizedPolicy.minimumConnections,
    max: normalizedPolicy.maximumConnections,
    connectionTimeoutMillis: normalizedPolicy.connectionTimeoutMilliseconds,
    idleTimeoutMillis: normalizedPolicy.idleTimeoutMilliseconds,
    statement_timeout: normalizedPolicy.statementTimeoutMilliseconds,
    query_timeout: normalizedPolicy.queryTimeoutMilliseconds,
    idle_in_transaction_session_timeout: normalizedPolicy.transactionTimeoutMilliseconds,
    maxLifetimeSeconds: normalizedPolicy.maximumConnectionLifetimeSeconds,
    allowExitOnIdle,
    ssl: tlsMode === "verify-full"
      ? Object.freeze({ rejectUnauthorized: true })
      : false,
  });
}

module.exports = {
  DEFAULT_POSTGRESQL_POOL_POLICY,
  POSTGRESQL_EXPERIMENTAL_PROFILE,
  POSTGRESQL_ROLE_PURPOSES,
  POSTGRESQL_TLS_MODES,
  createPostgresqlPoolConfiguration,
  isLoopbackHostname,
  normalizePostgresqlPoolPolicy,
};
