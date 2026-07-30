"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
} = require("../errors");
const {
  createPostgresqlPersistenceProvider,
} = require("./provider");
const {
  POSTGRESQL_EXPERIMENTAL_PROFILE,
  createPostgresqlPoolConfiguration,
} = require("./policy");

function providerUnavailable(cause) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.PROVIDER_UNAVAILABLE, {
    operation: "configuration",
    cause,
  });
}

function poolConstructor(Pool) {
  if (Pool !== undefined) return Pool;
  try {
    return require("pg").Pool;
  } catch (error) {
    throw providerUnavailable(error);
  }
}

function openPostgresqlDevelopmentPersistence({
  profile,
  databaseUrl,
  catalog = [],
  tlsMode,
  policy,
  applicationName,
  allowExitOnIdle,
  onPoolError,
  Pool,
} = {}) {
  if (profile !== POSTGRESQL_EXPERIMENTAL_PROFILE) {
    throw providerUnavailable();
  }
  let pool;
  try {
    const PoolConstructor = poolConstructor(Pool);
    const configuration = createPostgresqlPoolConfiguration({
      databaseUrl,
      tlsMode,
      policy,
      applicationName,
      allowExitOnIdle,
    });
    pool = new PoolConstructor(configuration);
    return createPostgresqlPersistenceProvider({
      pool,
      catalog,
      poolOwnership: "provider",
      acquireTimeoutMilliseconds: configuration.connectionTimeoutMillis,
      onPoolError,
    });
  } catch (error) {
    try {
      pool?.end();
    } catch {}
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, {
      operation: "configuration",
      cause: error,
    });
  }
}

module.exports = {
  openPostgresqlDevelopmentPersistence,
};
