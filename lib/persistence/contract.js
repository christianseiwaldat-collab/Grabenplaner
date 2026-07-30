"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  normalizePersistenceError,
} = require("./errors");

const PERSISTENCE_CONTRACT_VERSION = 1;
const PERSISTENCE_VALUE_KINDS = Object.freeze([
  "text",
  "boolean",
  "safe_integer",
  "bigint_string",
  "decimal_string",
  "utc_timestamp",
  "date",
  "time",
  "json",
  "bytes",
]);
const TRANSACTION_ISOLATIONS = Object.freeze(["default", "serializable"]);
const PERSISTENCE_FEATURE_KEYS = Object.freeze([
  "atomicTransactions",
  "concurrentWrites",
  "multipleAppInstances",
  "databaseBackup",
  "restore",
  "integrityCheck",
  "recoveryAssurance",
  "systemCenterStatus",
  "pairedDocumentBackup",
  "pointInTimeRecovery",
]);

const VALUE_KIND_SET = new Set(PERSISTENCE_VALUE_KINDS);
const ISOLATION_SET = new Set(TRANSACTION_ISOLATIONS);
const STATEMENTS = new WeakSet();
const PROVIDERS = new WeakSet();
const EXECUTORS = new WeakSet();
const TRANSACTION_CONTEXT = new AsyncLocalStorage();

function contractError(_diagnostic, code = PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, operation = "") {
  return new PersistenceError(code, { operation });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowedKeys, label) {
  if (!isPlainRecord(value)) throw contractError(`${label} muss ein einfaches Objekt sein.`);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw contractError(`${label} enthält unbekannte Felder.`);
}

function normalizedFieldDefinition(value, label) {
  const definition = typeof value === "string" ? { kind: value } : value;
  exactKeys(definition, ["kind", "nullable", "optional"], label);
  if (!VALUE_KIND_SET.has(definition.kind)) throw contractError(`${label} verwendet einen unbekannten Werttyp.`);
  if (definition.nullable !== undefined && typeof definition.nullable !== "boolean") {
    throw contractError(`${label}.nullable muss boolesch sein.`);
  }
  if (definition.optional !== undefined && typeof definition.optional !== "boolean") {
    throw contractError(`${label}.optional muss boolesch sein.`);
  }
  return Object.freeze({
    kind: definition.kind,
    nullable: definition.nullable === true,
    optional: definition.optional === true,
  });
}

function normalizedFieldMap(value, label) {
  const fields = value === undefined ? {} : value;
  if (!isPlainRecord(fields)) throw contractError(`${label} muss ein einfaches Objekt sein.`);
  const normalized = {};
  for (const [name, definition] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw contractError(`${label} enthält einen ungültigen Feldnamen.`);
    }
    normalized[name] = normalizedFieldDefinition(definition, `${label}.${name}`);
  }
  return Object.freeze(normalized);
}

function definePersistenceStatement({
  id,
  operation,
  parameters = {},
  columns = {},
} = {}) {
  const normalizedId = String(id || "").trim();
  if (!/^[a-z][a-z0-9.-]{2,127}$/.test(normalizedId)) {
    throw contractError("Die Statement-ID ist ungültig.", PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "statement");
  }
  if (!["queryOne", "queryAll", "execute"].includes(operation)) {
    throw contractError("Die Statement-Operation ist ungültig.", PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "statement");
  }
  const statement = Object.freeze({
    id: normalizedId,
    operation,
    parameters: normalizedFieldMap(parameters, "parameters"),
    columns: normalizedFieldMap(columns, "columns"),
  });
  STATEMENTS.add(statement);
  return statement;
}

function assertPersistenceStatement(statement) {
  const expected = ["columns", "id", "operation", "parameters"];
  if (!STATEMENTS.has(statement)
    || !Object.isFrozen(statement)
    || JSON.stringify(Object.keys(statement).sort()) !== JSON.stringify(expected)) {
    throw contractError(
      "Das Objekt ist kein definierter Persistence-Statementvertrag.",
      PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
      "statement",
    );
  }
  return statement;
}

function assertStatement(statement, operation) {
  if (statement?.operation !== operation) {
    throw contractError(
      "Das Statement ist nicht für diese Operation freigegeben.",
      PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
      operation,
    );
  }
  assertPersistenceStatement(statement);
}

function normalizeJsonValue(value, seen = new Set(), invalidCode = PERSISTENCE_ERROR_CODES.RESULT_INVALID) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw contractError("Ein JSON-Zahlenwert ist nicht verlustfrei darstellbar.", invalidCode);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw contractError("Zyklische JSON-Werte sind nicht zulässig.", invalidCode);
    seen.add(value);
    const normalized = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || value[index] === undefined) {
        throw contractError("JSON-Listen dürfen keine Lücken oder undefined enthalten.", invalidCode);
      }
      normalized.push(normalizeJsonValue(value[index], seen, invalidCode));
    }
    seen.delete(value);
    return Object.freeze(normalized);
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) throw contractError("Zyklische JSON-Werte sind nicht zulässig.", invalidCode);
    seen.add(value);
    const normalized = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        throw contractError("JSON-Werte dürfen kein undefined enthalten.", invalidCode);
      }
      Object.defineProperty(normalized, key, {
        value: normalizeJsonValue(entry, seen, invalidCode),
        configurable: false,
        enumerable: true,
        writable: false,
      });
    }
    seen.delete(value);
    return Object.freeze(normalized);
  }
  throw contractError("Der JSON-Wert entspricht nicht dem Providervertrag.", invalidCode);
}

function validCalendarDate(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validTime(value) {
  const match = String(value).match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return false;
  const [, hour, minute, second] = match.map(Number);
  return hour <= 23 && minute <= 59 && second <= 59;
}

function normalizedUtcTimestamp(value) {
  try {
    const candidate = value instanceof Date ? value.toISOString() : value;
    if (typeof candidate !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)
      || new Date(candidate).toISOString() !== candidate) return "";
    return candidate;
  } catch {
    return "";
  }
}

function normalizePersistenceValue(value, definition, {
  invalidCode = PERSISTENCE_ERROR_CODES.RESULT_INVALID,
} = {}) {
  if (value === null) {
    if (definition.nullable) return null;
    throw contractError("Ein nicht-nullbarer Wert ist null.", invalidCode);
  }
  if (value === undefined) throw contractError("undefined ist kein Datenbankwert.", invalidCode);

  switch (definition.kind) {
    case "text":
      if (typeof value === "string") return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "safe_integer":
      if (Number.isSafeInteger(value)) return value;
      break;
    case "bigint_string": {
      const candidate = typeof value === "bigint" ? String(value) : value;
      if (typeof candidate === "string" && /^(?:0|-?[1-9]\d*)$/.test(candidate)) return candidate;
      break;
    }
    case "decimal_string":
      if (typeof value === "string" && /^(?:0|-?[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
      break;
    case "utc_timestamp": {
      const candidate = normalizedUtcTimestamp(value);
      if (candidate) return candidate;
      break;
    }
    case "date":
      if (typeof value === "string" && validCalendarDate(value)) return value;
      break;
    case "time":
      if (typeof value === "string" && validTime(value)) return value;
      break;
    case "json":
      return normalizeJsonValue(value, new Set(), invalidCode);
    case "bytes":
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
      break;
    default:
      break;
  }
  throw contractError(`Der Wert entspricht nicht dem Typ ${definition.kind}.`, invalidCode);
}

function normalizeParameters(statement, params) {
  const supplied = params === undefined ? {} : params;
  if (!isPlainRecord(supplied)) {
    throw contractError("Statement-Parameter müssen benannt sein.", PERSISTENCE_ERROR_CODES.STATEMENT_INVALID);
  }
  const expectedNames = Object.keys(statement.parameters);
  const unexpected = Object.keys(supplied).filter((name) => !Object.hasOwn(statement.parameters, name));
  if (unexpected.length) {
    throw contractError("Das Statement enthält unbekannte Parameter.", PERSISTENCE_ERROR_CODES.STATEMENT_INVALID);
  }
  const normalized = {};
  for (const name of expectedNames) {
    const definition = statement.parameters[name];
    if (!Object.hasOwn(supplied, name)) {
      if (definition.optional) continue;
      throw contractError("Ein erforderlicher Statement-Parameter fehlt.", PERSISTENCE_ERROR_CODES.STATEMENT_INVALID);
    }
    normalized[name] = normalizePersistenceValue(supplied[name], definition, {
      invalidCode: PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
    });
  }
  return Object.freeze(normalized);
}

function normalizeRow(statement, row) {
  if (!isPlainRecord(row)) {
    throw contractError("Eine Ergebniszeile ist kein einfacher Record.", PERSISTENCE_ERROR_CODES.RESULT_INVALID);
  }
  const unexpected = Object.keys(row).filter((name) => !Object.hasOwn(statement.columns, name));
  if (unexpected.length) {
    throw contractError("Eine Ergebniszeile enthält unbekannte Spalten.", PERSISTENCE_ERROR_CODES.RESULT_INVALID);
  }
  const normalized = {};
  for (const [name, definition] of Object.entries(statement.columns)) {
    if (!Object.hasOwn(row, name)) {
      if (definition.optional) continue;
      throw contractError("Eine erwartete Ergebnisspalte fehlt.", PERSISTENCE_ERROR_CODES.RESULT_INVALID);
    }
    normalized[name] = normalizePersistenceValue(row[name], definition);
  }
  return Object.freeze(normalized);
}

function normalizeRows(statement, rows) {
  if (!Array.isArray(rows)) {
    throw contractError("Das Abfrageergebnis ist keine Zeilenliste.", PERSISTENCE_ERROR_CODES.RESULT_INVALID);
  }
  return Object.freeze(rows.map((row) => normalizeRow(statement, row)));
}

function normalizeExecuteResult(statement, result) {
  if (!isPlainRecord(result)
    || !Number.isSafeInteger(result.rowsAffected)
    || result.rowsAffected < 0
    || !Array.isArray(result.returnedRows)) {
    throw contractError("Das Schreibergebnis ist ungültig.", PERSISTENCE_ERROR_CODES.RESULT_INVALID);
  }
  return Object.freeze({
    rowsAffected: result.rowsAffected,
    returnedRows: normalizeRows(statement, result.returnedRows),
  });
}

function normalizedCapabilities(providerId, capabilities) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(String(providerId || ""))) {
    throw contractError("Die Provider-ID ist ungültig.");
  }
  exactKeys(capabilities, ["transaction", "features"], "capabilities");
  exactKeys(capabilities.transaction, ["nested", "isolationLevels"], "capabilities.transaction");
  if (capabilities.transaction.nested !== "reject") {
    throw contractError("Verschachtelte Transaktionen müssen in Vertragsversion 1 eindeutig abgelehnt werden.");
  }
  if (!Array.isArray(capabilities.transaction.isolationLevels)
    || capabilities.transaction.isolationLevels.length === 0
    || capabilities.transaction.isolationLevels.some((value) => !ISOLATION_SET.has(value))
    || !capabilities.transaction.isolationLevels.includes("default")) {
    throw contractError("Die Transaktions-Isolationsstufen sind ungültig.");
  }
  exactKeys(capabilities.features, PERSISTENCE_FEATURE_KEYS, "capabilities.features");
  const features = {};
  for (const key of PERSISTENCE_FEATURE_KEYS) {
    if (typeof capabilities.features[key] !== "boolean") {
      throw contractError(`capabilities.features.${key} muss boolesch sein.`);
    }
    features[key] = capabilities.features[key];
  }
  if (!features.atomicTransactions) throw contractError("Der Providervertrag erfordert atomare Transaktionen.");
  return Object.freeze({
    contractVersion: PERSISTENCE_CONTRACT_VERSION,
    providerId,
    transaction: Object.freeze({
      nested: "reject",
      isolationLevels: Object.freeze([...new Set(capabilities.transaction.isolationLevels)]),
    }),
    features: Object.freeze(features),
  });
}

function normalizedTransactionOptions(options, capabilities) {
  const supplied = options === undefined ? {} : options;
  exactKeys(supplied, ["isolation", "readOnly"], "transaction options");
  const isolation = supplied.isolation === undefined ? "default" : supplied.isolation;
  const readOnly = supplied.readOnly === undefined ? false : supplied.readOnly;
  if (!capabilities.transaction.isolationLevels.includes(isolation)) {
    throw contractError(
      "Die gewünschte Transaktionsisolation wird nicht unterstützt.",
      PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
      "transaction",
    );
  }
  if (typeof readOnly !== "boolean") {
    throw contractError(
      "readOnly muss boolesch sein.",
      PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
      "transaction",
    );
  }
  return Object.freeze({ isolation, readOnly });
}

function assertInternalAdapter(adapter) {
  if (!isPlainRecord(adapter)) throw contractError("Der Provideradapter ist ungültig.");
  for (const method of ["query", "execute", "beginTransaction", "close"]) {
    if (typeof adapter[method] !== "function") throw contractError(`Der Provideradapter benötigt ${method}().`);
  }
}

function assertInternalTransactionAdapter(adapter) {
  if (!isPlainRecord(adapter)) throw contractError("Der Transaktionsadapter ist ungültig.");
  for (const method of ["query", "execute", "commit", "rollback"]) {
    if (typeof adapter[method] !== "function") throw contractError(`Der Transaktionsadapter benötigt ${method}().`);
  }
}

function createPersistenceProviderFacade(adapter) {
  assertInternalAdapter(adapter);
  const capabilities = normalizedCapabilities(adapter.providerId, adapter.capabilities);
  const providerToken = Object.freeze({});
  let state = "open";
  let activeOperations = 0;
  let closePromise = null;
  const drainWaiters = new Set();
  const operationLockQueue = [];
  let sharedLockCount = 0;
  let exclusiveLockActive = false;

  function drainOperationLockQueue() {
    if (exclusiveLockActive || operationLockQueue.length === 0) return;
    if (operationLockQueue[0].mode === "exclusive") {
      if (sharedLockCount > 0) return;
      exclusiveLockActive = true;
      operationLockQueue.shift().resolve();
      return;
    }
    while (operationLockQueue[0]?.mode === "shared" && !exclusiveLockActive) {
      sharedLockCount += 1;
      operationLockQueue.shift().resolve();
    }
  }

  function acquireOperationLock(mode) {
    if (mode === "shared" && !exclusiveLockActive && operationLockQueue.length === 0) {
      sharedLockCount += 1;
      return Promise.resolve();
    }
    if (mode === "exclusive" && !exclusiveLockActive && sharedLockCount === 0 && operationLockQueue.length === 0) {
      exclusiveLockActive = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      operationLockQueue.push({ mode, resolve });
      drainOperationLockQueue();
    });
  }

  function releaseOperationLock(mode) {
    if (mode === "exclusive") exclusiveLockActive = false;
    else sharedLockCount = Math.max(0, sharedLockCount - 1);
    drainOperationLockQueue();
  }

  function releaseOperation() {
    try {
      if (typeof adapter.operationFinished === "function") adapter.operationFinished();
    } finally {
      activeOperations = Math.max(0, activeOperations - 1);
      if (activeOperations === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    }
  }

  async function beginOperation(operation, mode = "shared") {
    if (TRANSACTION_CONTEXT.getStore() === providerToken) {
      throw contractError(
        "Innerhalb einer Transaktion darf nur ihr gebundener Executor verwendet werden.",
        PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
        operation,
      );
    }
    if (state === "closing") throw contractError("", PERSISTENCE_ERROR_CODES.PROVIDER_CLOSING, operation);
    if (state === "closed") throw contractError("", PERSISTENCE_ERROR_CODES.PROVIDER_CLOSED, operation);
    activeOperations += 1;
    try {
      if (typeof adapter.operationStarted === "function") adapter.operationStarted();
    } catch (error) {
      activeOperations = Math.max(0, activeOperations - 1);
      throw normalizePersistenceError(error, { operation });
    }
    await acquireOperationLock(mode);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseOperationLock(mode);
      releaseOperation();
    };
  }

  async function adapterQuery(executorAdapter, statement, params, operation) {
    try {
      const rows = await executorAdapter.query(statement, params);
      return normalizeRows(statement, rows);
    } catch (error) {
      throw normalizePersistenceError(error, { operation });
    }
  }

  async function adapterExecute(executorAdapter, statement, params) {
    try {
      const result = await executorAdapter.execute(statement, params);
      return normalizeExecuteResult(statement, result);
    } catch (error) {
      throw normalizePersistenceError(error, { operation: "execute" });
    }
  }

  function createBoundExecutor(transactionAdapter, activeState, transactionOptions) {
    async function trackedOperation(work) {
      const tracked = (async () => {
        try {
          return { ok: true, value: await work() };
        } catch (error) {
          activeState.failures.push(error);
          return { ok: false, error };
        }
      })();
      activeState.pending.add(tracked);
      try {
        const outcome = await tracked;
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      } finally {
        activeState.pending.delete(tracked);
      }
    }

    const executor = Object.freeze({
      async queryOne(statement, params) {
        if (!activeState.active) {
          throw contractError("", PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "queryOne");
        }
        assertStatement(statement, "queryOne");
        const normalizedParams = normalizeParameters(statement, params);
        return trackedOperation(async () => {
          const rows = await adapterQuery(transactionAdapter, statement, normalizedParams, "queryOne");
          if (rows.length > 1) {
            throw contractError("queryOne erhielt mehr als eine Zeile.", PERSISTENCE_ERROR_CODES.RESULT_INVALID, "queryOne");
          }
          return rows[0] || null;
        });
      },
      async queryAll(statement, params) {
        if (!activeState.active) {
          throw contractError("", PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "queryAll");
        }
        assertStatement(statement, "queryAll");
        const normalizedParams = normalizeParameters(statement, params);
        return trackedOperation(() => adapterQuery(
          transactionAdapter,
          statement,
          normalizedParams,
          "queryAll",
        ));
      },
      async execute(statement, params) {
        if (!activeState.active) {
          throw contractError("", PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "execute");
        }
        if (transactionOptions.readOnly) {
          throw contractError(
            "Eine Read-only-Transaktion darf keine Schreiboperation ausführen.",
            PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
            "execute",
          );
        }
        assertStatement(statement, "execute");
        const normalizedParams = normalizeParameters(statement, params);
        return trackedOperation(() => adapterExecute(transactionAdapter, statement, normalizedParams));
      },
    });
    EXECUTORS.add(executor);
    return executor;
  }

  const provider = Object.freeze({
    async queryOne(statement, params) {
      const release = await beginOperation("queryOne");
      try {
        assertStatement(statement, "queryOne");
        const rows = await adapterQuery(adapter, statement, normalizeParameters(statement, params), "queryOne");
        if (rows.length > 1) {
          throw contractError("queryOne erhielt mehr als eine Zeile.", PERSISTENCE_ERROR_CODES.RESULT_INVALID, "queryOne");
        }
        return rows[0] || null;
      } finally {
        release();
      }
    },
    async queryAll(statement, params) {
      const release = await beginOperation("queryAll");
      try {
        assertStatement(statement, "queryAll");
        return await adapterQuery(adapter, statement, normalizeParameters(statement, params), "queryAll");
      } finally {
        release();
      }
    },
    async execute(statement, params) {
      const release = await beginOperation("execute");
      try {
        assertStatement(statement, "execute");
        return await adapterExecute(adapter, statement, normalizeParameters(statement, params));
      } finally {
        release();
      }
    },
    async transaction(work, options) {
      const release = await beginOperation(
        "transaction",
        capabilities.features.concurrentWrites ? "shared" : "exclusive",
      );
      let activeState = null;
      try {
        if (typeof work !== "function") {
          throw contractError(
            "transaction benötigt einen Callback.",
            PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
            "transaction",
          );
        }
        const normalizedOptions = normalizedTransactionOptions(options, capabilities);
        let transactionAdapter;
        try {
          transactionAdapter = await adapter.beginTransaction(normalizedOptions);
          assertInternalTransactionAdapter(transactionAdapter);
        } catch (error) {
          throw normalizePersistenceError(error, { operation: "transaction" });
        }

        activeState = { active: true, failures: [], pending: new Set() };
        const executor = createBoundExecutor(transactionAdapter, activeState, normalizedOptions);
        let result;
        try {
          result = await TRANSACTION_CONTEXT.run(providerToken, () => work(executor));
        } catch (primaryError) {
          activeState.active = false;
          await Promise.all([...activeState.pending]);
          try {
            await transactionAdapter.rollback();
          } catch {
            // Der Primärfehler des Callbacks bleibt verbindlich erhalten.
          }
          throw primaryError;
        }

        activeState.active = false;
        await Promise.all([...activeState.pending]);
        if (activeState.failures.length) {
          const operationError = activeState.failures[0];
          try {
            await transactionAdapter.rollback();
          } catch {
            // Der normalisierte Operationsfehler bleibt der Primärfehler.
          }
          throw operationError;
        }
        try {
          await transactionAdapter.commit();
        } catch (error) {
          const commitError = normalizePersistenceError(error, { operation: "transaction" });
          try {
            await transactionAdapter.rollback();
          } catch {
            // Der normalisierte Commitfehler bleibt der Primärfehler.
          }
          throw commitError;
        }
        return result;
      } finally {
        if (activeState) activeState.active = false;
        release();
      }
    },
    async close() {
      if (TRANSACTION_CONTEXT.getStore() === providerToken) {
        throw contractError(
          "Der Provider kann nicht aus seiner laufenden Transaktion geschlossen werden.",
          PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
          "close",
        );
      }
      if (closePromise) return closePromise;
      state = "closing";
      closePromise = (async () => {
        if (activeOperations > 0) {
          await new Promise((resolve) => drainWaiters.add(resolve));
        }
        try {
          await adapter.close();
        } catch (error) {
          throw normalizePersistenceError(error, {
            fallbackCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE,
            operation: "close",
          });
        } finally {
          state = "closed";
        }
      })();
      return closePromise;
    },
    getCapabilities() {
      return capabilities;
    },
  });
  PROVIDERS.add(provider);
  return provider;
}

function assertPersistenceExecutor(executor) {
  const expected = ["execute", "queryAll", "queryOne"];
  if (!EXECUTORS.has(executor)
    || !Object.isFrozen(executor)
    || JSON.stringify(Object.keys(executor).sort()) !== JSON.stringify(expected)) {
    throw contractError("Das Objekt ist kein gebundener PersistenceExecutor.");
  }
  return executor;
}

function assertPersistenceProvider(provider) {
  const expected = ["close", "execute", "getCapabilities", "queryAll", "queryOne", "transaction"];
  if (!PROVIDERS.has(provider)
    || !Object.isFrozen(provider)
    || JSON.stringify(Object.keys(provider).sort()) !== JSON.stringify(expected)) {
    throw contractError("Das Objekt ist kein PersistenceProvider.");
  }
  return provider;
}

function assertPersistenceAccess(access) {
  if (PROVIDERS.has(access)) return assertPersistenceProvider(access);
  if (EXECUTORS.has(access)) return assertPersistenceExecutor(access);
  throw contractError("Das Objekt ist weder PersistenceProvider noch gebundener PersistenceExecutor.");
}

module.exports = {
  PERSISTENCE_CONTRACT_VERSION,
  PERSISTENCE_ERROR_CODES,
  PERSISTENCE_FEATURE_KEYS,
  PERSISTENCE_VALUE_KINDS,
  PersistenceError,
  TRANSACTION_ISOLATIONS,
  assertPersistenceAccess,
  assertPersistenceExecutor,
  assertPersistenceProvider,
  assertPersistenceStatement,
  createPersistenceProviderFacade,
  definePersistenceStatement,
  normalizePersistenceValue,
};
