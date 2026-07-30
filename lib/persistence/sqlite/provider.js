"use strict";

const { DatabaseSync } = require("node:sqlite");
const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  createPersistenceProviderFacade,
} = require("../contract");
const { isPersistenceError } = require("../errors");

const LEGACY_DATABASES = new WeakMap();

const SQLITE_CAPABILITIES = Object.freeze({
  transaction: Object.freeze({
    nested: "reject",
    isolationLevels: Object.freeze(["default", "serializable"]),
  }),
  features: Object.freeze({
    atomicTransactions: true,
    concurrentWrites: false,
    multipleAppInstances: false,
    databaseBackup: false,
    restore: false,
    integrityCheck: false,
    recoveryAssurance: false,
    systemCenterStatus: false,
    pairedDocumentBackup: false,
    pointInTimeRecovery: false,
  }),
});

function persistenceError(code, operation, cause) {
  return new PersistenceError(code, { operation, cause });
}

function sqliteErrorCode(error) {
  return Number.isSafeInteger(error?.errcode) ? error.errcode : null;
}

function mapSqliteError(error, {
  operation = "",
  fallbackCode = PERSISTENCE_ERROR_CODES.UNKNOWN,
} = {}) {
  if (isPersistenceError(error)) return error;
  const extendedCode = sqliteErrorCode(error);
  const primaryCode = extendedCode === null ? null : extendedCode & 0xff;
  let code = fallbackCode;

  if ([1555, 2067, 2579].includes(extendedCode)) code = PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION;
  else if (extendedCode === 787) code = PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION;
  else if (extendedCode === 1299) code = PERSISTENCE_ERROR_CODES.NOT_NULL_VIOLATION;
  else if ([275, 1811, 3091].includes(extendedCode)) code = PERSISTENCE_ERROR_CODES.CHECK_VIOLATION;
  else if ([517, 769].includes(extendedCode)) code = PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION;
  else if ([5, 6].includes(primaryCode)) code = PERSISTENCE_ERROR_CODES.BUSY;
  else if ([4, 9, 516].includes(extendedCode) || [4, 9].includes(primaryCode)) {
    code = PERSISTENCE_ERROR_CODES.ABORTED;
  } else if ([3, 8, 10, 13, 14, 15].includes(primaryCode)) {
    code = PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE;
  } else if ([11, 17, 24, 26].includes(primaryCode)) {
    code = PERSISTENCE_ERROR_CODES.SCHEMA_INVALID;
  } else if ([18, 20, 25].includes(primaryCode)
    || ["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_OUT_OF_RANGE"].includes(error?.code)) {
    code = PERSISTENCE_ERROR_CODES.STATEMENT_INVALID;
  } else if (error?.code === "ERR_INVALID_STATE") {
    code = PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE;
  }
  return persistenceError(code, operation, error);
}

function assertDatabasePath(databasePath) {
  if (typeof databasePath !== "string" || !databasePath.trim()) {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
}

function initializeSqliteConnection(database) {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA wal_autocheckpoint = 1000");
}

function refreshLegacyTransactionState(state) {
  if (state.useNativeTransactionState
    && typeof state.database.isTransaction === "boolean") {
    state.legacyTransactionActive = state.database.isTransaction;
    if (!state.legacyTransactionActive) {
      state.legacyTransactionStartedBySavepoint = false;
      state.legacySavepointNames.length = 0;
    }
  }
}

function executableSqlSegments(sql) {
  if (typeof sql !== "string") return [];
  const segments = [];
  let segment = "";
  let state = "normal";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        state = "normal";
        segment += "\n";
      } else {
        segment += " ";
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "normal";
        segment += "  ";
        index += 1;
      } else {
        segment += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "single-quote") {
      segment += character;
      if (character === "'" && next === "'") {
        segment += next;
        index += 1;
      } else if (character === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "double-quote") {
      segment += character;
      if (character === "\"" && next === "\"") {
        segment += next;
        index += 1;
      } else if (character === "\"") {
        state = "normal";
      }
      continue;
    }
    if (state === "backtick") {
      segment += character;
      if (character === "`" && next === "`") {
        segment += next;
        index += 1;
      } else if (character === "`") {
        state = "normal";
      }
      continue;
    }
    if (state === "bracket") {
      segment += character;
      if (character === "]") state = "normal";
      continue;
    }
    if (character === "-" && next === "-") {
      state = "line-comment";
      segment += "  ";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      segment += "  ";
      index += 1;
      continue;
    }
    if (character === "'") {
      state = "single-quote";
      segment += character;
      continue;
    }
    if (character === "\"") {
      state = "double-quote";
      segment += character;
      continue;
    }
    if (character === "`") {
      state = "backtick";
      segment += character;
      continue;
    }
    if (character === "[") {
      state = "bracket";
      segment += character;
      continue;
    }
    if (character === ";") {
      if (segment.trim()) segments.push(segment.trim());
      segment = "";
      continue;
    }
    segment += character;
  }
  if (segment.trim()) segments.push(segment.trim());
  return segments;
}

function normalizedSavepointName(segment) {
  const match = segment.match(
    /(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|`(?:[^`]|``)*`|\[[^\]]*\]|[^\s]+)\s*$/u,
  );
  if (!match) return null;
  let name = match[0].trim();
  const quote = name[0];
  if (quote === "[" && name.endsWith("]")) {
    name = name.slice(1, -1);
  } else if (["\"", "'", "`"].includes(quote) && name.endsWith(quote)) {
    name = name.slice(1, -1).split(`${quote}${quote}`).join(quote);
  }
  return name.replace(/[a-z]/g, (character) => character.toUpperCase());
}

function lastSavepointIndex(savepointNames, name) {
  if (name === null) return -1;
  for (let index = savepointNames.length - 1; index >= 0; index -= 1) {
    if (savepointNames[index] === name) return index;
  }
  return -1;
}

function beginsCreateTrigger(segment) {
  return /^(?:EXPLAIN(?:\s+QUERY\s+PLAN)?\s+)?CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER(?:\s|$)/i
    .test(segment);
}

function legacyTransactionControls(sql) {
  const segments = executableSqlSegments(sql);
  const controls = [];
  let insideTrigger = false;
  for (const segment of segments) {
    if (!insideTrigger && beginsCreateTrigger(segment)) {
      insideTrigger = true;
      continue;
    }
    if (insideTrigger) {
      if (/^END$/i.test(segment)) insideTrigger = false;
      continue;
    }
    const words = segment.match(/[A-Za-z]+/g)?.map((word) => word.toUpperCase()) || [];
    const first = words[0] || "";
    if (first === "BEGIN") {
      controls.push({ kind: "begin" });
      continue;
    }
    if (first === "SAVEPOINT") {
      controls.push({ kind: "savepoint", name: normalizedSavepointName(segment) });
      continue;
    }
    if (first === "COMMIT") {
      controls.push({ kind: "finish" });
      continue;
    }
    if (first === "ROLLBACK") {
      const toIndex = words[1] === "TRANSACTION" ? 2 : 1;
      controls.push(words[toIndex] === "TO"
        ? { kind: "rollback-to", name: normalizedSavepointName(segment) }
        : { kind: "finish" });
      continue;
    }
    if (first === "RELEASE") {
      controls.push({ kind: "release", name: normalizedSavepointName(segment) });
      continue;
    }
    if (first === "END" && /^END(?:\s+TRANSACTION)?$/i.test(segment)) {
      controls.push({ kind: "finish" });
    }
  }
  return controls;
}

function recordLegacySqlSuccess(state, sql) {
  refreshLegacyTransactionState(state);
  if (state.useNativeTransactionState
    && typeof state.database.isTransaction === "boolean") return;
  for (const control of legacyTransactionControls(sql)) {
    if (control.kind === "begin") {
      state.legacyTransactionActive = true;
      state.legacyTransactionStartedBySavepoint = false;
      state.legacySavepointNames.length = 0;
    } else if (control.kind === "savepoint") {
      if (!state.legacyTransactionActive) {
        state.legacyTransactionActive = true;
        state.legacyTransactionStartedBySavepoint = true;
      }
      state.legacySavepointNames.push(control.name);
    } else if (control.kind === "rollback-to") {
      const index = lastSavepointIndex(state.legacySavepointNames, control.name);
      if (index >= 0) state.legacySavepointNames.length = index + 1;
    } else if (control.kind === "release") {
      const index = lastSavepointIndex(state.legacySavepointNames, control.name);
      if (index >= 0) state.legacySavepointNames.length = index;
      if (state.legacyTransactionStartedBySavepoint
        && state.legacySavepointNames.length === 0) {
        state.legacyTransactionActive = false;
        state.legacyTransactionStartedBySavepoint = false;
      }
    } else if (control.kind === "finish") {
      state.legacyTransactionActive = false;
      state.legacyTransactionStartedBySavepoint = false;
      state.legacySavepointNames.length = 0;
    }
  }
}

function recordLegacySqlFailure(state, sql) {
  refreshLegacyTransactionState(state);
  if (state.useNativeTransactionState
    && typeof state.database.isTransaction === "boolean") return;
  if (legacyTransactionControls(sql).some(({ kind }) => kind === "begin" || kind === "savepoint")) {
    state.legacyTransactionActive = true;
  }
}

function assertLegacyOperationAllowed(state, operation) {
  if (state.closed) {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE, operation);
  }
  if (state.providerTransactionActive) {
    throw persistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, operation);
  }
}

function createLegacyStatementFacade(statement, state, sql) {
  function run(operation, work) {
    assertLegacyOperationAllowed(state, operation);
    try {
      const result = work();
      recordLegacySqlSuccess(state, sql);
      return result;
    } catch (error) {
      recordLegacySqlFailure(state, sql);
      throw error;
    }
  }
  return Object.freeze({
    all(...parameters) {
      return run("legacy-query", () => statement.all(...parameters));
    },
    get(...parameters) {
      return run("legacy-query", () => statement.get(...parameters));
    },
    run(...parameters) {
      return run("legacy-execute", () => statement.run(...parameters));
    },
  });
}

function legacyDatabaseFacade(database, {
  ownsDatabase,
  useNativeTransactionState,
}) {
  const state = {
    database,
    ownsDatabase,
    closed: false,
    legacyTransactionActive: false,
    legacyTransactionStartedBySavepoint: false,
    legacySavepointNames: [],
    useNativeTransactionState,
    providerAttached: false,
    providerOperationCount: 0,
    providerTransactionActive: false,
  };
  const facade = Object.freeze({
    prepare(sql) {
      assertLegacyOperationAllowed(state, "legacy-prepare");
      return createLegacyStatementFacade(database.prepare(sql), state, sql);
    },
    exec(sql) {
      assertLegacyOperationAllowed(state, "legacy-execute");
      try {
        const result = database.exec(sql);
        recordLegacySqlSuccess(state, sql);
        return result;
      } catch (error) {
        recordLegacySqlFailure(state, sql);
        throw error;
      }
    },
    function(name, ...parameters) {
      assertLegacyOperationAllowed(state, "legacy-function");
      return database.function(name, ...parameters);
    },
    close() {
      if (state.closed) return;
      assertLegacyOperationAllowed(state, "legacy-close");
      if (state.providerOperationCount > 0) {
        throw persistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "legacy-close");
      }
      if (ownsDatabase) database.close();
      state.closed = true;
      state.legacyTransactionActive = false;
      state.legacyTransactionStartedBySavepoint = false;
      state.legacySavepointNames.length = 0;
    },
  });
  LEGACY_DATABASES.set(facade, state);
  return facade;
}

function openSqliteLegacyDatabase(databasePath, {
  readOnly = false,
  initializeConnection = false,
  useNativeTransactionState = true,
} = {}) {
  assertDatabasePath(databasePath);
  if (typeof readOnly !== "boolean"
    || typeof initializeConnection !== "boolean"
    || typeof useNativeTransactionState !== "boolean") {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly });
    if (initializeConnection) initializeSqliteConnection(database);
    return legacyDatabaseFacade(database, {
      ownsDatabase: true,
      useNativeTransactionState,
    });
  } catch (error) {
    try {
      database?.close();
    } catch {}
    throw mapSqliteError(error, {
      operation: "open",
      fallbackCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE,
    });
  }
}

function scanSqliteParameters(sql) {
  const parameters = new Set();
  let state = "normal";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      if (character === "\"" && next === "\"") index += 1;
      else if (character === "\"") state = "normal";
      continue;
    }
    if (state === "backtick") {
      if (character === "`" && next === "`") index += 1;
      else if (character === "`") state = "normal";
      continue;
    }
    if (state === "bracket") {
      if (character === "]") state = "normal";
      continue;
    }
    if (character === "-" && next === "-") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (character === "'") {
      state = "single-quote";
      continue;
    }
    if (character === "\"") {
      state = "double-quote";
      continue;
    }
    if (character === "`") {
      state = "backtick";
      continue;
    }
    if (character === "[") {
      state = "bracket";
      continue;
    }
    if (character === "?" || ((character === ":" || character === "@") && /[A-Za-z]/.test(next || ""))) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
    }
    if (character !== "$" || !/[A-Za-z]/.test(next || "")) continue;
    let end = index + 2;
    while (/[A-Za-z0-9_]/.test(sql[end] || "")) end += 1;
    parameters.add(sql.slice(index + 1, end));
    index = end - 1;
  }
  if (state !== "normal" && state !== "line-comment") {
    throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
  }
  return parameters;
}

function leadingSqlKeyword(sql) {
  let index = 0;
  while (index < sql.length) {
    while (/\s/.test(sql[index] || "")) index += 1;
    if (sql[index] === "-" && sql[index + 1] === "-") {
      index = sql.indexOf("\n", index + 2);
      if (index < 0) return "";
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      index = sql.indexOf("*/", index + 2);
      if (index < 0) return "";
      index += 2;
      continue;
    }
    break;
  }
  return /^[A-Za-z]+/.exec(sql.slice(index))?.[0]?.toUpperCase() || "";
}

function normalizedCatalog(catalog) {
  if (!Array.isArray(catalog)) {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "catalog");
  }
  const statementIds = new Set();
  const statements = new Set();
  const normalized = [];
  for (const entry of catalog) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["statement", "sql", "returning"].includes(key))
      || !entry.statement || typeof entry.statement !== "object"
      || typeof entry.statement.id !== "string"
      || !["queryOne", "queryAll", "execute"].includes(entry.statement.operation)
      || !entry.statement.parameters || typeof entry.statement.parameters !== "object"
      || !entry.statement.columns || typeof entry.statement.columns !== "object"
      || typeof entry.sql !== "string" || !entry.sql.trim()
      || typeof entry.returning !== "boolean"
      || statements.has(entry.statement) || statementIds.has(entry.statement.id)) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
    }
    const expectedParameters = Object.keys(entry.statement.parameters).sort();
    const actualParameters = [...scanSqliteParameters(entry.sql)].sort();
    const firstKeyword = leadingSqlKeyword(entry.sql);
    if (JSON.stringify(expectedParameters) !== JSON.stringify(actualParameters)
      || (entry.statement.operation !== "execute" && entry.returning)
      || (entry.statement.operation !== "execute" && firstKeyword !== "SELECT")
      || (entry.statement.operation === "execute"
        && entry.returning !== (Object.keys(entry.statement.columns).length > 0))) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
    }
    statements.add(entry.statement);
    statementIds.add(entry.statement.id);
    normalized.push(Object.freeze({
      statement: entry.statement,
      sql: entry.sql,
      returning: entry.returning,
    }));
  }
  return Object.freeze(normalized);
}

function databaseFromInput(database) {
  const legacyState = LEGACY_DATABASES.get(database);
  if (legacyState) {
    if (legacyState.closed || legacyState.providerAttached) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
    }
    legacyState.providerAttached = true;
    return {
      database: legacyState.database,
      legacyFacade: database,
      coordinationState: legacyState,
    };
  }
  throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
}

function sqliteParameter(value, definition) {
  if (value === null || value === undefined) return null;
  switch (definition.kind) {
    case "boolean":
      return value ? 1 : 0;
    case "json":
      return JSON.stringify(value);
    case "bytes":
      return Buffer.from(value);
    default:
      return value;
  }
}

function boundParameters(statement, parameters) {
  const bound = {};
  for (const [name, definition] of Object.entries(statement.parameters)) {
    bound[`$${name}`] = sqliteParameter(
      Object.hasOwn(parameters, name) ? parameters[name] : null,
      definition,
    );
  }
  return bound;
}

function invalidResult(cause) {
  return persistenceError(PERSISTENCE_ERROR_CODES.RESULT_INVALID, "result", cause);
}

function safeInteger(value) {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (Number.isSafeInteger(number) && BigInt(number) === value) return number;
  }
  if (Number.isSafeInteger(value)) return value;
  throw invalidResult();
}

function resultValue(value, definition) {
  if (value === null) {
    if (definition.nullable) return null;
    throw invalidResult();
  }
  switch (definition.kind) {
    case "text":
    case "decimal_string":
    case "utc_timestamp":
    case "date":
    case "time":
      if (typeof value === "string") return value;
      break;
    case "boolean":
      if (value === 0 || value === 0n) return false;
      if (value === 1 || value === 1n) return true;
      break;
    case "safe_integer":
      return safeInteger(value);
    case "bigint_string":
      if (typeof value === "bigint" || Number.isSafeInteger(value)) return String(value);
      if (typeof value === "string") return value;
      break;
    case "json":
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch (error) {
          throw invalidResult(error);
        }
      }
      break;
    case "bytes":
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
      break;
    default:
      break;
  }
  throw invalidResult();
}

function resultRows(statement, rows) {
  if (!Array.isArray(rows)) throw invalidResult();
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).some((name) => !Object.hasOwn(statement.columns, name))) {
      throw invalidResult();
    }
    const result = {};
    for (const [name, definition] of Object.entries(statement.columns)) {
      if (!Object.hasOwn(row, name)) {
        if (definition.optional) continue;
        throw invalidResult();
      }
      result[name] = resultValue(row[name], definition);
    }
    return result;
  });
}

function createSqlitePersistenceProvider({
  databasePath,
  database: suppliedDatabase,
  catalog = [],
  closeDatabase,
  initializeConnection = true,
} = {}) {
  const entries = normalizedCatalog(catalog);
  const hasPath = databasePath !== undefined;
  const hasDatabase = suppliedDatabase !== undefined;
  if (hasPath === hasDatabase || typeof initializeConnection !== "boolean") {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
  if (closeDatabase !== undefined && typeof closeDatabase !== "boolean") {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
  if (hasPath && closeDatabase === false) {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }

  let database;
  let legacyFacade = null;
  let coordinationState = null;
  let ownsDatabase = hasPath;
  try {
    if (hasPath) {
      assertDatabasePath(databasePath);
      database = new DatabaseSync(databasePath);
    } else {
      ({ database, legacyFacade, coordinationState } = databaseFromInput(suppliedDatabase));
      ownsDatabase = closeDatabase === true;
    }
    if (initializeConnection) initializeSqliteConnection(database);
  } catch (error) {
    if (coordinationState) coordinationState.providerAttached = false;
    if (hasPath) {
      try {
        database?.close();
      } catch {}
    }
    throw mapSqliteError(error, {
      operation: "open",
      fallbackCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE,
    });
  }

  const catalogByStatement = new Map(entries.map((entry) => [entry.statement, entry]));
  const preparedStatements = new Map();
  let changesStatement = null;
  let transactionActive = false;
  let transactionReadOnly = false;
  let transactionPreviousQueryOnly = null;
  let closed = false;
  let healthy = true;

  function readQueryOnlyState() {
    const value = database.prepare("PRAGMA query_only").get()?.query_only;
    if (value === 0 || value === 0n) return false;
    if (value === 1 || value === 1n) return true;
    throw persistenceError(PERSISTENCE_ERROR_CODES.RESULT_INVALID, "transaction");
  }

  function setQueryOnlyState(enabled) {
    database.exec(`PRAGMA query_only = ${enabled ? "ON" : "OFF"}`);
  }

  function restoreQueryOnlyState() {
    if (transactionPreviousQueryOnly === null) return;
    setQueryOnlyState(transactionPreviousQueryOnly);
    transactionPreviousQueryOnly = null;
  }

  function legacyTransactionActive() {
    if (!coordinationState) return false;
    refreshLegacyTransactionState(coordinationState);
    return coordinationState.legacyTransactionActive
      && !coordinationState.providerTransactionActive;
  }

  function assertUsable(operation) {
    if (closed || !healthy || coordinationState?.closed) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE, operation);
    }
    if (legacyTransactionActive()) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, operation);
    }
  }

  function preparedEntry(statement, operation) {
    assertUsable(operation);
    const entry = catalogByStatement.get(statement);
    if (!entry) throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, operation);
    if (!preparedStatements.has(statement)) {
      try {
        const prepared = database.prepare(entry.sql);
        prepared.setAllowBareNamedParameters(false);
        if (typeof prepared.setAllowUnknownNamedParameters === "function") {
          prepared.setAllowUnknownNamedParameters(false);
        }
        prepared.setReadBigInts(true);
        preparedStatements.set(statement, prepared);
      } catch (error) {
        throw mapSqliteError(error, {
          operation,
          fallbackCode: sqliteErrorCode(error) === 1
            ? PERSISTENCE_ERROR_CODES.SCHEMA_INVALID
            : PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
        });
      }
    }
    return { entry, prepared: preparedStatements.get(statement) };
  }

  function query(statement, parameters) {
    const { prepared } = preparedEntry(statement, "query");
    try {
      return resultRows(statement, prepared.all(boundParameters(statement, parameters)));
    } catch (error) {
      if (transactionReadOnly && (sqliteErrorCode(error) & 0xff) === 8) {
        throw persistenceError(
          PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
          "query",
          error,
        );
      }
      throw mapSqliteError(error, { operation: "query" });
    }
  }

  function execute(statement, parameters) {
    const { entry, prepared } = preparedEntry(statement, "execute");
    try {
      if (entry.returning) {
        const returnedRows = resultRows(
          statement,
          prepared.all(boundParameters(statement, parameters)),
        );
        if (!changesStatement) {
          changesStatement = database.prepare("SELECT changes() AS rowsAffected");
          changesStatement.setReadBigInts(true);
        }
        return {
          rowsAffected: safeInteger(changesStatement.get().rowsAffected),
          returnedRows,
        };
      }
      const result = prepared.run(boundParameters(statement, parameters));
      return {
        rowsAffected: safeInteger(result.changes),
        returnedRows: [],
      };
    } catch (error) {
      throw mapSqliteError(error, { operation: "execute" });
    }
  }

  const adapter = {
    providerId: "sqlite",
    capabilities: SQLITE_CAPABILITIES,
    operationStarted() {
      if (coordinationState) coordinationState.providerOperationCount += 1;
    },
    operationFinished() {
      if (coordinationState) {
        coordinationState.providerOperationCount = Math.max(
          0,
          coordinationState.providerOperationCount - 1,
        );
      }
    },
    query,
    execute,
    beginTransaction(options) {
      assertUsable("transaction");
      if (transactionActive) {
        throw persistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "transaction");
      }
      try {
        if (options.readOnly) {
          transactionPreviousQueryOnly = readQueryOnlyState();
          if (!transactionPreviousQueryOnly) setQueryOnlyState(true);
        }
        database.exec(options.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
        transactionActive = true;
        transactionReadOnly = options.readOnly;
        if (coordinationState) coordinationState.providerTransactionActive = true;
      } catch (error) {
        if (options.readOnly) {
          try {
            restoreQueryOnlyState();
          } catch {
            healthy = false;
          }
        }
        throw mapSqliteError(error, {
          operation: "transaction",
          fallbackCode: PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,
        });
      }
      let active = true;
      function assertActive() {
        if (!active || !transactionActive) {
          throw persistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "transaction");
        }
      }
      return {
        query(statement, parameters) {
          assertActive();
          return query(statement, parameters);
        },
        execute(statement, parameters) {
          assertActive();
          return execute(statement, parameters);
        },
        commit() {
          assertActive();
          let committed = false;
          try {
            database.exec("COMMIT");
            committed = true;
            if (options.readOnly) restoreQueryOnlyState();
            active = false;
            transactionActive = false;
            transactionReadOnly = false;
            if (coordinationState) coordinationState.providerTransactionActive = false;
          } catch (error) {
            if (committed) healthy = false;
            throw mapSqliteError(error, { operation: "transaction" });
          }
        },
        rollback() {
          assertActive();
          try {
            database.exec("ROLLBACK");
            if (options.readOnly) restoreQueryOnlyState();
            active = false;
            transactionActive = false;
            transactionReadOnly = false;
            if (coordinationState) coordinationState.providerTransactionActive = false;
          } catch (error) {
            healthy = false;
            throw mapSqliteError(error, { operation: "transaction" });
          }
        },
      };
    },
    close() {
      if (closed) return;
      closed = true;
      preparedStatements.clear();
      changesStatement = null;
      if (transactionActive) {
        try {
          database.exec("ROLLBACK");
        } catch {}
      }
      if (transactionReadOnly) {
        try {
          restoreQueryOnlyState();
        } catch {}
      }
      transactionActive = false;
      transactionReadOnly = false;
      if (coordinationState) {
        coordinationState.providerAttached = false;
        coordinationState.providerOperationCount = 0;
        coordinationState.providerTransactionActive = false;
      }
      if (!ownsDatabase) return;
      try {
        if (legacyFacade) legacyFacade.close();
        else database.close();
      } catch (error) {
        throw mapSqliteError(error, {
          operation: "close",
          fallbackCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE,
        });
      }
    },
  };

  return createPersistenceProviderFacade(adapter);
}

function openSqliteApplicationPersistence({
  databasePath,
  catalog = [],
} = {}) {
  const database = openSqliteLegacyDatabase(databasePath, {
    initializeConnection: true,
  });
  try {
    const provider = createSqlitePersistenceProvider({
      database,
      catalog,
      closeDatabase: false,
      initializeConnection: false,
    });
    return Object.freeze({ database, provider });
  } catch (error) {
    database.close();
    throw error;
  }
}

module.exports = {
  SQLITE_CAPABILITIES,
  createSqlitePersistenceProvider,
  openSqliteApplicationPersistence,
  openSqliteLegacyDatabase,
};
