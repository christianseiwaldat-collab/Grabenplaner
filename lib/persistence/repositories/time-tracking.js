"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  TIME_TRACKING_STATEMENTS: S,
} = require("../statements/time-tracking");

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
  for (const [name, statement] of Object.entries(S)) {
    if (statement.operation === "queryOne") {
      methods[name] = async (value) => (
        await access.queryOne(statement, parameters(value, name))
      )?.data ?? null;
    } else if (statement.operation === "queryAll") {
      methods[name] = async (value) => (
        await access.queryAll(statement, parameters(value, name))
      ).map((row) => row.data);
    } else {
      methods[name] = (value) => access.execute(statement, parameters(value, name));
    }
  }
  return methods;
}

const createTimeTrackingRepository = Object.freeze(function createTimeTrackingRepository(access) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    async insertTimeEntry(value) {
      const result = await access.execute(S.insertTimeEntry, parameters(value, "insertTimeEntry"));
      return {
        ...result,
        inserted: result.returnedRows[0]?.data ?? null,
      };
    },
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => work(createTimeTrackingRepository(executor)));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
});

function assertTimeTrackingRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, {
      operation: "time-tracking-repository",
    });
  }
  return repository;
}

module.exports = {
  assertTimeTrackingRepository,
  createTimeTrackingRepository,
};
