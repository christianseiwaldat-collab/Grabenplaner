"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  PORTAL_ACCESS_STATEMENTS,
} = require("../statements/portal-access");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function parameters(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(operation);
  try {
    return { payload: JSON.parse(JSON.stringify(value)) };
  } catch {
    throw invalidInput(operation);
  }
}

function methodsFor(access) {
  const methods = {};
  for (const [name, statement] of Object.entries(PORTAL_ACCESS_STATEMENTS)) {
    if (statement.operation === "queryOne") {
      methods[name] = async (value = {}) => (
        await access.queryOne(statement, parameters(value, name))
      )?.data ?? null;
    } else if (statement.operation === "queryAll") {
      methods[name] = async (value = {}) => (
        await access.queryAll(statement, parameters(value, name))
      ).map((row) => row.data);
    } else {
      methods[name] = (value = {}) => access.execute(statement, parameters(value, name));
    }
  }
  return methods;
}

const createPortalAccessRepository = Object.freeze(function createPortalAccessRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => work(createPortalAccessRepository(executor)));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
});

function assertPortalAccessRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, {
      operation: "portal-access-repository",
    });
  }
  return repository;
}

module.exports = {
  assertPortalAccessRepository,
  createPortalAccessRepository,
};
