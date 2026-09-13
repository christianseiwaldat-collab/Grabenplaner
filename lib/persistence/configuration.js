"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PERSISTENCE_MESSAGE_KEYS,
  PersistenceError,
} = require("./errors");

const PERSISTENCE_PROVIDER_IDS = Object.freeze(["sqlite", "postgresql"]);
const IMPLEMENTED_PERSISTENCE_PROVIDER_IDS = Object.freeze(["sqlite"]);

function configurationError(messageKey) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, {
    messageKey,
    operation: "configuration",
  });
}

function normalizedProviderId(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider || "sqlite";
}

function configuredSecret(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolvePersistenceConfiguration({
  environment = {},
  defaultSqlitePath = "",
} = {}) {
  const providerId = normalizedProviderId(environment.DB_PROVIDER);
  if (!PERSISTENCE_PROVIDER_IDS.includes(providerId)) {
    throw configurationError(PERSISTENCE_MESSAGE_KEYS.PROVIDER_ID_INVALID);
  }

  if (!IMPLEMENTED_PERSISTENCE_PROVIDER_IDS.includes(providerId)) {
    if (providerId === "postgresql" && environment.GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG) {
      return require("./postgresql/productive-configuration").configuration(environment);
    }
    if (providerId === 'postgresql' && ['application-11','activation-12','paired-restore'].includes(environment.GRABENPLANER_POSTGRESQL_REHEARSAL)) {
      return require('./postgresql/rehearsal-configuration').configuration(environment);
    }
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.PROVIDER_UNAVAILABLE, {
      messageKey: PERSISTENCE_MESSAGE_KEYS.POSTGRESQL_NOT_AVAILABLE,
      operation: "configuration",
    });
  }

  if (configuredSecret(environment.DATABASE_URL)) {
    throw configurationError(PERSISTENCE_MESSAGE_KEYS.SQLITE_DATABASE_URL_CONFLICT);
  }

  const configuredPath = environment.DB_PATH;
  const databasePath = configuredPath || defaultSqlitePath;
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw configurationError(PERSISTENCE_MESSAGE_KEYS.SQLITE_PATH_REQUIRED);
  }

  return Object.freeze({
    providerId,
    databasePath,
    databaseUrlConfigured: false,
  });
}

function redactPersistenceConfiguration(configuration = {}) {
  return Object.freeze({
    providerId: PERSISTENCE_PROVIDER_IDS.includes(configuration.providerId)
      ? configuration.providerId
      : "unknown",
    databasePath: configuration.providerId === "sqlite"
      ? String(configuration.databasePath || "")
      : "",
    databaseUrlConfigured: configuration.databaseUrlConfigured === true,
  });
}

module.exports = {
  IMPLEMENTED_PERSISTENCE_PROVIDER_IDS,
  PERSISTENCE_PROVIDER_IDS,
  redactPersistenceConfiguration,
  resolvePersistenceConfiguration,
};
