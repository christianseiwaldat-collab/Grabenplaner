"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  UI_PREFERENCES_STATEMENTS,
} = require("../statements/ui-preferences");

function invalidRepositoryInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function normalizedIdentifier(value, operation) {
  if (typeof value !== "string") throw invalidRepositoryInput(operation);
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || normalized.includes("\0")) {
    throw invalidRepositoryInput(operation);
  }
  return normalized;
}

function normalizedValue(value, operation) {
  if (typeof value !== "string") throw invalidRepositoryInput(operation);
  return value;
}

function normalizedChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw invalidRepositoryInput("saveChanges");
  }
  const unexpected = Object.keys(changes)
    .filter((key) => !["upserts", "deleteKeys"].includes(key));
  if (unexpected.length) throw invalidRepositoryInput("saveChanges");

  const upserts = changes.upserts === undefined ? [] : changes.upserts;
  const deleteKeys = changes.deleteKeys === undefined ? [] : changes.deleteKeys;
  if (!Array.isArray(upserts) || !Array.isArray(deleteKeys)) {
    throw invalidRepositoryInput("saveChanges");
  }

  const normalizedUpserts = upserts.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["preferenceKey", "value"].includes(key))
      || !Object.hasOwn(entry, "preferenceKey")
      || !Object.hasOwn(entry, "value")) {
      throw invalidRepositoryInput("saveChanges");
    }
    return Object.freeze({
      preferenceKey: normalizedIdentifier(entry.preferenceKey, "saveChanges"),
      value: normalizedValue(entry.value, "saveChanges"),
    });
  });
  const normalizedDeleteKeys = deleteKeys
    .map((key) => normalizedIdentifier(key, "saveChanges"));
  const upsertKeys = new Set(normalizedUpserts.map((entry) => entry.preferenceKey));
  const deletedKeys = new Set(normalizedDeleteKeys);
  if (upsertKeys.size !== normalizedUpserts.length
    || deletedKeys.size !== normalizedDeleteKeys.length
    || normalizedDeleteKeys.some((key) => upsertKeys.has(key))) {
    throw invalidRepositoryInput("saveChanges");
  }
  return Object.freeze({
    upserts: Object.freeze(normalizedUpserts),
    deleteKeys: Object.freeze(normalizedDeleteKeys),
  });
}

async function persistChanges(access, employeeNumber, changes) {
  let upserted = 0;
  let deleted = 0;
  for (const preferenceKey of changes.deleteKeys) {
    const result = await access.execute(UI_PREFERENCES_STATEMENTS.delete, {
      employeeNumber,
      preferenceKey,
    });
    deleted += result.rowsAffected;
  }
  for (const entry of changes.upserts) {
    const result = await access.execute(UI_PREFERENCES_STATEMENTS.upsert, {
      employeeNumber,
      preferenceKey: entry.preferenceKey,
      value: entry.value,
    });
    upserted += result.rowsAffected;
  }
  return Object.freeze({ upserted, deleted });
}

function createUiPreferencesRepository(access) {
  assertPersistenceAccess(access);

  return Object.freeze({
    list(employeeNumber) {
      return access.queryAll(UI_PREFERENCES_STATEMENTS.list, {
        employeeNumber: normalizedIdentifier(employeeNumber, "list"),
      });
    },
    get(employeeNumber, preferenceKey) {
      return access.queryOne(UI_PREFERENCES_STATEMENTS.get, {
        employeeNumber: normalizedIdentifier(employeeNumber, "get"),
        preferenceKey: normalizedIdentifier(preferenceKey, "get"),
      });
    },
    upsert(employeeNumber, preferenceKey, value) {
      return access.execute(UI_PREFERENCES_STATEMENTS.upsert, {
        employeeNumber: normalizedIdentifier(employeeNumber, "upsert"),
        preferenceKey: normalizedIdentifier(preferenceKey, "upsert"),
        value: normalizedValue(value, "upsert"),
      });
    },
    async saveChanges(employeeNumber, changes) {
      const normalizedEmployeeNumber = normalizedIdentifier(employeeNumber, "saveChanges");
      const normalized = normalizedChanges(changes);
      if (!normalized.upserts.length && !normalized.deleteKeys.length) {
        return Object.freeze({ upserted: 0, deleted: 0 });
      }
      if (Object.hasOwn(access, "transaction")) {
        return access.transaction((transaction) => (
          persistChanges(transaction, normalizedEmployeeNumber, normalized)
        ));
      }
      return persistChanges(access, normalizedEmployeeNumber, normalized);
    },
  });
}

module.exports = {
  createUiPreferencesRepository,
};
