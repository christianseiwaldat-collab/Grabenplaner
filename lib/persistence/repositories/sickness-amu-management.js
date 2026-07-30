"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  SICKNESS_AMU_MANAGEMENT_STATEMENTS,
} = require("../statements/sickness-amu-management");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function normalizedPayload(value, operation) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(operation);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw invalidInput(operation);
  }
}

function methodsFor(access) {
  const methods = {};
  for (const [name, statement] of Object.entries(SICKNESS_AMU_MANAGEMENT_STATEMENTS)) {
    const parameters = (value) => ({ payload: normalizedPayload(value, name) });
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

const createSicknessAmuManagementRepository = Object.freeze(
  function createSicknessAmuManagementRepository(access) {
    assertPersistenceAccess(access);
    const repository = Object.freeze({
      ...methodsFor(access),
      ...(typeof access.transaction === "function" ? {
        transaction(work) {
          if (typeof work !== "function") throw invalidInput("transaction");
          return access.transaction((executor) => (
            work(createSicknessAmuManagementRepository(executor))
          ));
        },
      } : {}),
    });
    REPOSITORIES.add(repository);
    return repository;
  },
);

function assertSicknessAmuManagementRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, {
      operation: "sickness-amu-management-repository",
    });
  }
  return repository;
}

module.exports = {
  assertSicknessAmuManagementRepository,
  createSicknessAmuManagementRepository,
};
