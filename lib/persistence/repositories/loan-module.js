"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  LOAN_MODULE_STATEMENTS,
} = require("../statements/loan-module");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function normalizedJson(value, operation) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(operation);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw invalidInput(operation);
  }
}

function parametersFor(statement, value, operation) {
  if (Object.keys(statement.parameters).length === 0) return {};
  return { payload: normalizedJson(value, operation) };
}

function executorMethods(access) {
  const methods = {};
  for (const [name, statement] of Object.entries(LOAN_MODULE_STATEMENTS)) {
    if (statement.operation === "queryOne") {
      methods[name] = (value) => access.queryOne(
        statement,
        parametersFor(statement, value, name),
      ).then((row) => row?.data ?? null);
    } else if (statement.operation === "queryAll") {
      methods[name] = (value) => access.queryAll(
        statement,
        parametersFor(statement, value, name),
      ).then((rows) => rows.map((row) => row.data));
    } else {
      methods[name] = (value) => access.execute(
        statement,
        parametersFor(statement, value, name),
      );
    }
  }
  return Object.freeze(methods);
}

const createLoanModuleRepository = Object.freeze(function createLoanModuleRepository(access) {
  assertPersistenceAccess(access);
  const repository = executorMethods(access);
  REPOSITORIES.add(repository);
  return repository;
});

function assertLoanModuleRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, {
      operation: "loan-module-repository",
    });
  }
  return repository;
}

module.exports = {
  assertLoanModuleRepository,
  createLoanModuleRepository,
};
