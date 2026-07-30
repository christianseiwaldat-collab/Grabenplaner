"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  INTEGRATION_RUNTIME_STATEMENTS,
} = require("../statements/integration-runtime");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function normalizedJson(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(operation);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw invalidInput(operation);
  }
}

function methodsFor(access) {
  const methods = {};
  for (const [name, statement] of Object.entries(INTEGRATION_RUNTIME_STATEMENTS)) {
    const parameters = Object.keys(statement.parameters).length
      ? (value) => ({ payload: normalizedJson(value, name) })
      : () => ({});
    if (statement.operation === "queryOne") {
      methods[name] = async (value) => (await access.queryOne(statement, parameters(value)))?.data ?? null;
    } else if (statement.operation === "queryAll") {
      methods[name] = async (value) => (
        await access.queryAll(statement, parameters(value))
      ).map((row) => row.data);
    } else {
      methods[name] = (value) => access.execute(statement, parameters(value));
    }
  }
  return methods;
}

const createIntegrationRuntimeRepository = Object.freeze(function createIntegrationRuntimeRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => work(createIntegrationRuntimeRepository(executor)));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
});

function assertIntegrationRuntimeRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, {
      operation: "integration-runtime-repository",
    });
  }
  return repository;
}

module.exports = {
  assertIntegrationRuntimeRepository,
  createIntegrationRuntimeRepository,
};
