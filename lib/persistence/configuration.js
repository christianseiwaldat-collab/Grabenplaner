"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PERSISTENCE_MESSAGE_KEYS,
  PersistenceError,
} = require("./errors");

const PERSISTENCE_PROVIDER_IDS = Object.freeze(["postgresql"]);
const IMPLEMENTED_PERSISTENCE_PROVIDER_IDS = PERSISTENCE_PROVIDER_IDS;

function configurationError(messageKey) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, {
    messageKey,
    operation: "configuration",
  });
}

function normalizedProviderId(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider || "postgresql";
}

function resolvePersistenceConfiguration({
  environment = {},
} = {}) {
  const providerId = normalizedProviderId(environment.DB_PROVIDER);
  if (!PERSISTENCE_PROVIDER_IDS.includes(providerId)) {
    throw configurationError(PERSISTENCE_MESSAGE_KEYS.PROVIDER_ID_INVALID);
  }

  if (environment.GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG) {
    return require("./postgresql/productive-configuration").configuration(environment);
  }
  if (environment.NODE_ENV === "test"
      && ['application-11', 'activation-12', 'paired-restore'].includes(environment.GRABENPLANER_POSTGRESQL_REHEARSAL)) {
    return require('./postgresql/rehearsal-configuration').configuration(environment);
  }
  // A generic URL or a former DB_PATH must never create a new empty database or
  // bypass the protected binding of the productive core/sales pair.
  throw configurationError(PERSISTENCE_MESSAGE_KEYS.POSTGRESQL_CONFIGURATION_REQUIRED);
}

function redactPersistenceConfiguration(configuration = {}) {
  return Object.freeze({
    providerId: PERSISTENCE_PROVIDER_IDS.includes(configuration.providerId)
      ? configuration.providerId
      : "unknown",
    databasePath: "",
    databaseUrlConfigured: configuration.databaseUrlConfigured === true,
  });
}

module.exports = {
  IMPLEMENTED_PERSISTENCE_PROVIDER_IDS,
  PERSISTENCE_PROVIDER_IDS,
  redactPersistenceConfiguration,
  resolvePersistenceConfiguration,
};
