"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  CUSTOM_PROCESS_MANAGEMENT_STATEMENTS,
} = require("../statements/custom-process-management");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function normalizedJson(value, operation) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(operation);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw invalidInput(operation);
  }
}

function parametersFor(statement, value, operation) {
  if (!Object.keys(statement.parameters).length) return {};
  return { payload: normalizedJson(value, operation) };
}

function methodsFor(access) {
  const methods = {};
  for (const [name, statement] of Object.entries(CUSTOM_PROCESS_MANAGEMENT_STATEMENTS)) {
    if (statement.operation === "queryOne") {
      methods[name] = async (value) => (
        await access.queryOne(statement, parametersFor(statement, value, name))
      )?.data ?? null;
    } else if (statement.operation === "queryAll") {
      methods[name] = async (value) => (
        await access.queryAll(statement, parametersFor(statement, value, name))
      ).map((row) => row.data);
    } else {
      methods[name] = (value) => access.execute(
        statement,
        parametersFor(statement, value, name),
      );
    }
  }
  return methods;
}

const createCustomProcessManagementRepository = Object.freeze(
  function createCustomProcessManagementRepository(access) {
    assertPersistenceAccess(access);
    const repository = Object.freeze({
      ...methodsFor(access),
      ...(typeof access.transaction === "function" ? {
        transaction(work, options) {
          if (typeof work !== "function") throw invalidInput("transaction");
          return access.transaction((executor) => (
            work(createCustomProcessManagementRepository(executor))
          ), options);
        },
      } : {}),
    });
    REPOSITORIES.add(repository);
    return repository;
  },
);

function assertCustomProcessManagementRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, {
      operation: "custom-process-management-repository",
    });
  }
  return repository;
}

module.exports = {
  assertCustomProcessManagementRepository,
  createCustomProcessManagementRepository,
};
