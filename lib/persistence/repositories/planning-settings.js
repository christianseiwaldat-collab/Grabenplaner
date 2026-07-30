"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  PLANNING_SETTINGS_STATEMENTS,
} = require("../statements/planning-settings");

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

function parametersFor(statement, value, operation) {
  if (!Object.keys(statement.parameters).length) return {};
  const payload = normalizedJson(value, operation);
  if (operation === "upsertSetting"
    && (typeof payload.key !== "string"
      || typeof payload.value !== "string"
      || payload.key.includes("\0")
      || payload.value.includes("\0"))) {
    throw invalidInput(operation);
  }
  return { payload };
}

function methodsFor(access) {
  const methods = {};
  for (const [name, statement] of Object.entries(PLANNING_SETTINGS_STATEMENTS)) {
    if (statement.operation === "queryOne") {
      methods[name] = async (value) => (
        (await access.queryOne(statement, parametersFor(statement, value, name)))?.data ?? null
      );
    } else if (statement.operation === "queryAll") {
      methods[name] = async (value) => (
        await access.queryAll(statement, parametersFor(statement, value, name))
      ).map((row) => row.data);
    } else {
      methods[name] = async (value) => {
        const result = await access.execute(
          statement,
          parametersFor(statement, value, name),
        );
        return Object.freeze({
          rowsAffected: result.rowsAffected,
          rows: Object.freeze(result.returnedRows.map((row) => row.data)),
        });
      };
    }
  }
  return methods;
}

const createPlanningSettingsRepository = Object.freeze(function createPlanningSettingsRepository(
  access,
) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work) {
        if (typeof work !== "function") throw invalidInput("transaction");
        return access.transaction((executor) => (
          work(createPlanningSettingsRepository(executor))
        ));
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
});

function assertPlanningSettingsRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, {
      operation: "planning-settings-repository",
    });
  }
  return repository;
}

module.exports = {
  assertPlanningSettingsRepository,
  createPlanningSettingsRepository,
};
