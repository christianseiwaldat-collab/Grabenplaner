"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceStatement,
  createPersistenceProviderFacade,
} = require("../contract");
const {
  isPersistenceError,
} = require("../errors");
const {
  DEFAULT_POSTGRESQL_POOL_POLICY,
} = require("./policy");

const POSTGRESQL_CAPABILITIES = Object.freeze({
  transaction: Object.freeze({
    nested: "reject",
    isolationLevels: Object.freeze(["default", "serializable"]),
  }),
  features: Object.freeze({
    atomicTransactions: true,
    concurrentWrites: true,
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

const CONNECTION_SQLSTATES = new Set([
  "25P03",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);
const CONNECTION_DRIVER_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
]);
const SCHEMA_SQLSTATES = new Set([
  "42501",
  "42703",
  "42704",
  "42804",
  "42830",
  "42883",
  "42P01",
  "42P02",
  "3D000",
  "3F000",
]);

function persistenceError(code, operation, cause) {
  return new PersistenceError(code, { operation, cause });
}

function mapPostgresqlError(error, {
  operation = "",
  fallbackCode = PERSISTENCE_ERROR_CODES.UNKNOWN,
} = {}) {
  if (isPersistenceError(error)) return error;
  const driverCode = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  let code = fallbackCode;
  if (driverCode === "23505" || driverCode === "23P01") {
    code = PERSISTENCE_ERROR_CODES.UNIQUE_VIOLATION;
  } else if (driverCode === "23503") {
    code = PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION;
  } else if (driverCode === "23502") {
    code = PERSISTENCE_ERROR_CODES.NOT_NULL_VIOLATION;
  } else if (driverCode === "23514") {
    code = PERSISTENCE_ERROR_CODES.CHECK_VIOLATION;
  } else if (driverCode === "40001" || driverCode === "40P01") {
    code = PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION;
  } else if (driverCode === "55P03" || driverCode === "55006") {
    code = PERSISTENCE_ERROR_CODES.BUSY;
  } else if (driverCode === "57014"
    || driverCode === "QUERY_TIMEOUT"
    || driverCode === "ETIMEDOUT") {
    code = PERSISTENCE_ERROR_CODES.TIMEOUT;
  } else if (driverCode === "ABORT_ERR" || error?.name === "AbortError") {
    code = PERSISTENCE_ERROR_CODES.ABORTED;
  } else if (driverCode.startsWith("08")
    || CONNECTION_SQLSTATES.has(driverCode)
    || CONNECTION_DRIVER_CODES.has(driverCode)) {
    code = PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE;
  } else if (["25006", "25P01", "25P02"].includes(driverCode)) {
    code = PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID;
  } else if (["26000", "42601", "42P02"].includes(driverCode)) {
    code = PERSISTENCE_ERROR_CODES.STATEMENT_INVALID;
  } else if (SCHEMA_SQLSTATES.has(driverCode)
    || (driverCode.startsWith("42") && driverCode.length === 5)) {
    code = PERSISTENCE_ERROR_CODES.SCHEMA_INVALID;
  }
  return persistenceError(code, operation, error);
}

function sqlTokens(sql) {
  const tokens = [];
  let index = 0;
  let state = "normal";
  let blockDepth = 0;
  let dollarTag = "";
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "normal";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "/" && next === "*") {
        blockDepth += 1;
        index += 2;
      } else if (character === "*" && next === "/") {
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) state = "normal";
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (character === "'" && next === "'") index += 2;
      else {
        if (character === "'") state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "double-quote") {
      if (character === "\"" && next === "\"") index += 2;
      else {
        if (character === "\"") state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        state = "normal";
      } else {
        index += 1;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      state = "line-comment";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      blockDepth = 1;
      index += 2;
      continue;
    }
    if (character === "'") {
      state = "single-quote";
      index += 1;
      continue;
    }
    if (character === "\"") {
      state = "double-quote";
      index += 1;
      continue;
    }
    if (character === "$") {
      const quoted = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
      if (quoted) {
        dollarTag = quoted;
        state = "dollar-quote";
        index += quoted.length;
        continue;
      }
      const positional = /^\$(\d+)/.exec(sql.slice(index));
      if (positional) {
        tokens.push(positional[0]);
        index += positional[0].length;
        continue;
      }
      if (/[A-Za-z_]/.test(next || "")) {
        throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
      }
    }
    if (character === "?" || (character === ":"
      && sql[index - 1] !== ":"
      && next !== ":"
      && /[A-Za-z_]/.test(next || ""))) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index))?.[0];
    if (word) {
      tokens.push(word.toUpperCase());
      index += word.length;
      continue;
    }
    if (character === ";") {
      tokens.push(";");
      index += 1;
      continue;
    }
    index += 1;
  }
  if (!["normal", "line-comment"].includes(state)) {
    throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
  }
  return tokens;
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
      || Object.keys(entry).some((key) => ![
        "statement",
        "sql",
        "parameterOrder",
        "parameterBindings",
        "returning",
      ].includes(key))
      || typeof entry.sql !== "string" || !entry.sql.trim()
      || !Array.isArray(entry.parameterOrder)
      || (entry.parameterBindings !== undefined && !Array.isArray(entry.parameterBindings))
      || typeof entry.returning !== "boolean") {
      throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
    }
    let statement;
    try {
      statement = assertPersistenceStatement(entry.statement);
    } catch (error) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog", error);
    }
    if (statements.has(statement) || statementIds.has(statement.id)) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
    }
    const tokens = sqlTokens(entry.sql);
    const semicolonIndexes = tokens
      .map((token, index) => token === ";" ? index : -1)
      .filter((index) => index >= 0);
    const executableTokens = tokens.filter((token) => token !== ";");
    const hasReturningClause = executableTokens.includes("RETURNING");
    const parameterNumbers = [...new Set(tokens
      .filter((token) => /^\$\d+$/.test(token))
      .map((token) => Number(token.slice(1))))]
      .sort((left, right) => left - right);
    const parameterNames = Object.keys(statement.parameters);
    const rawParameterBindings = entry.parameterBindings === undefined
      ? entry.parameterOrder.map((parameter) => ({
        parameter,
        source: "value",
        path: [],
      }))
      : entry.parameterBindings;
    const parameterBindings = rawParameterBindings.map((binding) => {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)
        || JSON.stringify(Object.keys(binding).sort())
          !== JSON.stringify(["parameter", "path", "source"])
        || typeof binding.parameter !== "string"
        || !Object.hasOwn(statement.parameters, binding.parameter)
        || !["value", "json-extract", "json-type"].includes(binding.source)
        || !Array.isArray(binding.path)
        || binding.path.some((segment) => (
          !(typeof segment === "string"
            && /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
            && !["__proto__", "constructor", "prototype"].includes(segment))
          && !(Number.isSafeInteger(segment) && segment >= 0)
        ))
        || (binding.source === "value" && binding.path.length > 0)
        || (binding.source !== "value"
          && statement.parameters[binding.parameter].kind !== "json")) {
        throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
      }
      return Object.freeze({
        parameter: binding.parameter,
        source: binding.source,
        path: Object.freeze([...binding.path]),
      });
    });
    const expectedParameters = parameterBindings.map((_, index) => index + 1);
    const firstKeyword = executableTokens.find((token) => /^[A-Z_]/.test(token)) || "";
    const forbiddenQueryKeywords = new Set([
      "ALTER",
      "CALL",
      "COPY",
      "CREATE",
      "DELETE",
      "DO",
      "DROP",
      "GRANT",
      "INSERT",
      "LOCK",
      "MERGE",
      "REFRESH",
      "REVOKE",
      "TRUNCATE",
      "UPDATE",
      "VACUUM",
    ]);
    if (JSON.stringify(parameterNumbers) !== JSON.stringify(expectedParameters)
      || entry.parameterOrder.length !== parameterNames.length
      || new Set(entry.parameterOrder).size !== entry.parameterOrder.length
      || entry.parameterOrder.some((name) => typeof name !== "string")
      || JSON.stringify([...entry.parameterOrder].sort()) !== JSON.stringify([...parameterNames].sort())
      || JSON.stringify(
        [...new Set(parameterBindings.map((binding) => binding.parameter))].sort(),
      ) !== JSON.stringify([...parameterNames].sort())
      || semicolonIndexes.length > 1
      || (semicolonIndexes.length === 1 && semicolonIndexes[0] !== tokens.length - 1)
      || (statement.operation !== "execute"
        && !["SELECT", "WITH"].includes(firstKeyword))
      || (statement.operation !== "execute"
        && executableTokens.some((token) => forbiddenQueryKeywords.has(token)))
      || (statement.operation === "execute"
        && !["DELETE", "INSERT", "UPDATE", "WITH"].includes(firstKeyword))
      || (statement.operation !== "execute" && entry.returning)
      || (statement.operation === "execute"
        && entry.returning !== (Object.keys(statement.columns).length > 0))
      || entry.returning !== hasReturningClause) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, "catalog");
    }
    statements.add(statement);
    statementIds.add(statement.id);
    normalized.push(Object.freeze({
      statement,
      sql: entry.sql,
      parameterOrder: Object.freeze([...entry.parameterOrder]),
      parameterBindings: Object.freeze(parameterBindings),
      returning: entry.returning,
    }));
  }
  return Object.freeze(normalized);
}

function postgresqlParameter(value, definition) {
  if (value === null || value === undefined) return null;
  if (definition.kind === "json") return JSON.stringify(value);
  if (definition.kind === "bytes") return Buffer.from(value);
  return value;
}

function jsonPathValue(value, path) {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return undefined;
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)
      || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function sqliteCompatibleJsonExtract(value, path) {
  const extracted = jsonPathValue(value, path);
  if (extracted === undefined || extracted === null) return null;
  if (typeof extracted === "boolean") return extracted ? 1 : 0;
  if (Array.isArray(extracted)
    || (typeof extracted === "object" && extracted !== null)) {
    return JSON.stringify(extracted);
  }
  return extracted;
}

function sqliteCompatibleJsonType(value, path) {
  const extracted = jsonPathValue(value, path);
  if (extracted === undefined) return null;
  if (extracted === null) return "null";
  if (Array.isArray(extracted)) return "array";
  if (typeof extracted === "object") return "object";
  if (typeof extracted === "string") return "text";
  if (typeof extracted === "boolean") return extracted ? "true" : "false";
  if (typeof extracted === "number") {
    return Number.isInteger(extracted) ? "integer" : "real";
  }
  return null;
}

function boundParameters(entry, parameters) {
  return entry.parameterBindings.map((binding) => {
    const value = Object.hasOwn(parameters, binding.parameter)
      ? parameters[binding.parameter]
      : null;
    if (binding.source === "json-extract") {
      return sqliteCompatibleJsonExtract(value, binding.path);
    }
    if (binding.source === "json-type") {
      return sqliteCompatibleJsonType(value, binding.path);
    }
    return postgresqlParameter(
      value,
      entry.statement.parameters[binding.parameter],
    );
  });
}

function invalidResult(cause) {
  return persistenceError(PERSISTENCE_ERROR_CODES.RESULT_INVALID, "result", cause);
}

function safeInteger(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    if (Number.isSafeInteger(converted) && BigInt(converted) === value) return converted;
  }
  if (typeof value === "string" && /^(?:0|-?[1-9]\d*)$/.test(value)) {
    const converted = Number(value);
    if (Number.isSafeInteger(converted) && String(converted) === value) return converted;
  }
  throw invalidResult();
}

function calendarDateFromDriverDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalidResult();
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resultValue(value, definition) {
  if (value === null) {
    if (definition.nullable) return null;
    throw invalidResult();
  }
  switch (definition.kind) {
    case "text":
    case "decimal_string":
    case "date":
    case "time":
      if (typeof value === "string") return value;
      if (definition.kind === "date" && value instanceof Date) {
        return calendarDateFromDriverDate(value);
      }
      break;
    case "utc_timestamp":
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
      if (typeof value === "string") return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
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
      if (value && typeof value === "object" && !Buffer.isBuffer(value)) return value;
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
  const columns = Object.entries(statement.columns);
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw invalidResult();
    const result = {};
    columns.forEach(([name, definition], index) => {
      result[name] = resultValue(row[index], definition);
    });
    return result;
  });
}

function normalizedQueryResult(statement, rawResult) {
  const expectedFieldNames = Object.keys(statement.columns);
  if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)
    || !Array.isArray(rawResult.rows)
    || (!Number.isSafeInteger(rawResult.rowCount) && rawResult.rowCount !== null)
    || !Array.isArray(rawResult.fields)
    || rawResult.fields.some((field) => (
      !field || typeof field !== "object" || typeof field.name !== "string"
    ))
    || JSON.stringify(rawResult.fields.map((field) => field.name))
      !== JSON.stringify(expectedFieldNames)) {
    throw invalidResult();
  }
  return {
    rows: resultRows(statement, rawResult.rows),
    rowsAffected: rawResult.rowCount === null ? 0 : rawResult.rowCount,
  };
}

function assertPool(pool) {
  if (!pool || typeof pool !== "object" || Array.isArray(pool)
    || typeof pool.connect !== "function"
    || typeof pool.end !== "function") {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
}

function createPostgresqlPersistenceProvider({
  pool,
  catalog = [],
  poolOwnership = "external",
  acquireTimeoutMilliseconds = DEFAULT_POSTGRESQL_POOL_POLICY.connectionTimeoutMilliseconds,
  onPoolError,
} = {}) {
  assertPool(pool);
  if (!["external", "provider"].includes(poolOwnership)
    || !Number.isSafeInteger(acquireTimeoutMilliseconds)
    || acquireTimeoutMilliseconds < 100
    || acquireTimeoutMilliseconds > 60_000
    || (onPoolError !== undefined && typeof onPoolError !== "function")) {
    throw persistenceError(PERSISTENCE_ERROR_CODES.CONFIGURATION_INVALID, "configuration");
  }
  const entries = normalizedCatalog(catalog);
  const catalogByStatement = new Map(entries.map((entry) => [entry.statement, entry]));
  let closed = false;
  const observedClients = new WeakSet();
  const failedClients = new WeakMap();

  function idlePoolError(error) {
    if (!onPoolError) return;
    try {
      onPoolError(mapPostgresqlError(error, {
        operation: "pool",
        fallbackCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE,
      }));
    } catch {
      // Diagnose-Callbacks dürfen den Providerzustand nicht verändern.
    }
  }
  if (typeof pool.on === "function") pool.on("error", idlePoolError);

  function entryFor(statement, operation) {
    if (closed) {
      throw persistenceError(PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE, operation);
    }
    const entry = catalogByStatement.get(statement);
    if (!entry) throw persistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, operation);
    return entry;
  }

  function queryConfiguration(entry, statement, parameters) {
    return {
      text: entry.sql,
      values: boundParameters(entry, parameters),
      rowMode: "array",
    };
  }

  async function run(executor, statement, parameters, operation) {
    const entry = entryFor(statement, operation);
    try {
      if (failedClients.has(executor)) throw failedClients.get(executor);
      const result = normalizedQueryResult(
        statement,
        await executor.query(queryConfiguration(entry, statement, parameters)),
      );
      return { entry, result };
    } catch (error) {
      throw mapPostgresqlError(error, { operation });
    }
  }

  async function queryWith(executor, statement, parameters) {
    return (await run(executor, statement, parameters, "query")).result.rows;
  }

  async function executeWith(executor, statement, parameters) {
    const { entry, result } = await run(executor, statement, parameters, "execute");
    return {
      rowsAffected: result.rowsAffected,
      returnedRows: entry.returning ? result.rows : [],
    };
  }

  async function acquireClient(operation) {
    let timedOut = false;
    let timer;
    const pending = Promise.resolve()
      .then(() => pool.connect())
      .then((client) => {
        if (typeof client?.on === "function" && !observedClients.has(client)) {
          // A server timeout or network failure can arrive between statements
          // while the client is checked out. pg emits on the client, not Pool.
          // Keep that event from crashing the process; the next query/COMMIT
          // still rejects and the normal rollback path discards the client.
          client.on("error", error => { if (!failedClients.has(client)) failedClients.set(client, error); idlePoolError(error); });
          observedClients.add(client);
        }
        if (timedOut) {
          try {
            client.release(true);
          } catch {}
          return null;
        }
        return client;
      });
    try {
      const client = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(persistenceError(PERSISTENCE_ERROR_CODES.TIMEOUT, operation));
          }, acquireTimeoutMilliseconds);
        }),
      ]);
      if (!client) throw persistenceError(PERSISTENCE_ERROR_CODES.TIMEOUT, operation);
      return client;
    } catch (error) {
      throw mapPostgresqlError(error, {
        operation,
        fallbackCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function rollbackAndRelease(client, primaryError) {
    let connectionDamaged = false;
    try {
      await client.query("ROLLBACK");
    } catch {
      connectionDamaged = true;
    }
    try {
      client.release(connectionDamaged || undefined);
    } catch {}
    throw primaryError;
  }

  async function singleStatement(statement, parameters, operation) {
    const client = await acquireClient(operation);
    const readOnly = statement.operation !== "execute";
    try {
      await client.query(
        `BEGIN ISOLATION LEVEL READ COMMITTED ${readOnly ? "READ ONLY" : "READ WRITE"}`,
      );
      const value = readOnly
        ? await queryWith(client, statement, parameters)
        : await executeWith(client, statement, parameters);
      await client.query("COMMIT");
      client.release();
      return value;
    } catch (error) {
      return rollbackAndRelease(
        client,
        mapPostgresqlError(failedClients.get(client) || error, { operation }),
      );
    }
  }

  const adapter = {
    providerId: "postgresql",
    capabilities: POSTGRESQL_CAPABILITIES,
    operationStarted() {
      if (closed) {
        throw persistenceError(PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE, "operation");
      }
    },
    query(statement, parameters) {
      return singleStatement(statement, parameters, "query");
    },
    execute(statement, parameters) {
      return singleStatement(statement, parameters, "execute");
    },
    async beginTransaction(options) {
      let client;
      let active = false;
      let released = false;
      function releaseClient(error) {
        if (released || !client) return;
        released = true;
        client.release(error);
      }
      try {
        client = await acquireClient("transaction");
        const isolation = options.isolation === "serializable"
          ? "SERIALIZABLE"
          : "READ COMMITTED";
        await client.query(
          `BEGIN ISOLATION LEVEL ${isolation} ${options.readOnly ? "READ ONLY" : "READ WRITE"}`,
        );
        active = true;
      } catch (error) {
        releaseClient(error);
        throw mapPostgresqlError(error, {
          operation: "transaction",
          fallbackCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE,
        });
      }
      return {
        query(statement, parameters) {
          if (!active) {
            throw persistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "query");
          }
          return queryWith(client, statement, parameters);
        },
        execute(statement, parameters) {
          if (!active) {
            throw persistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "execute");
          }
          return executeWith(client, statement, parameters);
        },
        async commit() {
          if (!active) {
            throw persistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID, "transaction");
          }
          try {
            if (failedClients.has(client)) throw failedClients.get(client);
            await client.query("COMMIT");
            active = false;
            releaseClient();
          } catch (error) {
            throw mapPostgresqlError(failedClients.get(client) || error, { operation: "transaction" });
          }
        },
        async rollback() {
          if (!active) return;
          let rollbackError = null;
          try {
            await client.query("ROLLBACK");
          } catch (error) {
            rollbackError = error;
            throw mapPostgresqlError(error, { operation: "transaction" });
          } finally {
            active = false;
            releaseClient(rollbackError || undefined);
          }
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (typeof pool.off === "function") pool.off("error", idlePoolError);
      else if (typeof pool.removeListener === "function") pool.removeListener("error", idlePoolError);
      if (poolOwnership !== "provider") return;
      try {
        await pool.end();
      } catch (error) {
        throw mapPostgresqlError(error, {
          operation: "close",
          fallbackCode: PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE,
        });
      }
    },
  };
  return createPersistenceProviderFacade(adapter);
}

module.exports = {
  POSTGRESQL_CAPABILITIES,
  createPostgresqlPersistenceProvider,
  mapPostgresqlError,
};
