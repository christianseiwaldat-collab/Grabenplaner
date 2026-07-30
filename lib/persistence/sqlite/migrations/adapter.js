"use strict";

const { createHash } = require("node:crypto");
const {
  MIGRATION_CONTRACT_VERSION,
  MIGRATION_ERROR_CODES,
  MigrationContractError,
} = require("../../migrations/contract");

const HISTORY_TABLE = "persistence_migration_history";
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_CONTROL_COMMANDS = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
]);

function migrationError(code, message) {
  return new MigrationContractError(code, message);
}

function assertDatabase(database) {
  if (!database || typeof database !== "object"
    || typeof database.exec !== "function"
    || typeof database.prepare !== "function") {
    throw migrationError(
      MIGRATION_ERROR_CODES.ADAPTER_INVALID,
      "A SQLite operations database is required.",
    );
  }
}

function normalizedOperations(operations) {
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.ADAPTER_INVALID,
      "SQLite migration operations must be a plain registry.",
    );
  }
  const registry = new Map();
  for (const [id, operation] of Object.entries(operations)) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)
      || JSON.stringify(Object.keys(operation).sort())
        !== JSON.stringify(["handler", "implementationFingerprint"])) {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "SQLite migration operations require explicit implementation descriptors.",
      );
    }
    const { handler, implementationFingerprint } = operation;
    if (!OPERATION_ID_PATTERN.test(id)
      || typeof handler !== "function"
      || typeof implementationFingerprint !== "string"
      || !FINGERPRINT_PATTERN.test(implementationFingerprint)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "SQLite migration registry contains an invalid operation.",
      );
    }
    registry.set(id, Object.freeze({
      handler,
      implementationFingerprint,
    }));
  }
  return registry;
}

function implementationContract(registry, migration) {
  function entries(operationIds, label) {
    if (!Array.isArray(operationIds)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        `SQLite migration ${label} operations are invalid.`,
      );
    }
    return operationIds.map((operationId) => {
      const operation = registry.get(operationId);
      if (!operation) {
        throw migrationError(
          MIGRATION_ERROR_CODES.OPERATION_UNAVAILABLE,
          `SQLite migration operation ${operationId} is unavailable.`,
        );
      }
      return Object.freeze({
        operationId,
        implementationFingerprint: operation.implementationFingerprint,
      });
    });
  }

  return Object.freeze({
    apply: Object.freeze(entries(migration.operations, "apply")),
    rollback: Object.freeze(entries(migration.rollbackOperations || [], "rollback")),
  });
}

function implementationContractFingerprint(contract) {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function assertStoredImplementationContract(registry, row) {
  let contract;
  try {
    contract = JSON.parse(row.implementation_contract_json);
  } catch {
    contract = null;
  }
  if (!contract
    || typeof contract !== "object"
    || Array.isArray(contract)
    || JSON.stringify(Object.keys(contract).sort()) !== JSON.stringify(["apply", "rollback"])
    || !Array.isArray(contract.apply)
    || !Array.isArray(contract.rollback)
    || contract.apply.length === 0
    || !FINGERPRINT_PATTERN.test(String(row.implementation_fingerprint || ""))
    || implementationContractFingerprint(contract) !== row.implementation_fingerprint) {
    throw migrationError(
      MIGRATION_ERROR_CODES.HISTORY_INVALID,
      "SQLite migration history has an invalid implementation contract.",
    );
  }
  for (const entries of [contract.apply, contract.rollback]) {
    const seen = new Set();
    for (const entry of entries) {
      if (!entry
        || typeof entry !== "object"
        || Array.isArray(entry)
        || JSON.stringify(Object.keys(entry).sort())
          !== JSON.stringify(["implementationFingerprint", "operationId"])
        || !OPERATION_ID_PATTERN.test(String(entry.operationId || ""))
        || !FINGERPRINT_PATTERN.test(String(entry.implementationFingerprint || ""))
        || seen.has(entry.operationId)) {
        throw migrationError(
          MIGRATION_ERROR_CODES.HISTORY_INVALID,
          "SQLite migration history contains invalid implementation bindings.",
        );
      }
      seen.add(entry.operationId);
      const current = registry.get(entry.operationId);
      if (!current
        || current.implementationFingerprint !== entry.implementationFingerprint) {
        throw migrationError(
          MIGRATION_ERROR_CODES.HISTORY_INVALID,
          `SQLite migration operation ${entry.operationId} changed after it was applied.`,
        );
      }
    }
  }
  return contract;
}

// Inspect top-level statement heads without mistaking trigger-body BEGIN/END
// or keywords inside strings, quoted identifiers and comments for commands.
function transactionControlCommand(sql) {
  if (typeof sql !== "string") return null;
  let position = 0;
  let statementStart = true;
  let statementPrefix = [];
  let triggerDefinition = false;
  let triggerBody = false;
  let triggerStatementStart = false;
  let triggerCaseDepth = 0;
  let triggerEnd = false;

  while (position < sql.length) {
    const character = sql[position];
    const next = sql[position + 1];

    if (/\s/.test(character)) {
      position += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      position += 2;
      while (position < sql.length && !["\r", "\n"].includes(sql[position])) {
        position += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      position += 2;
      while (position < sql.length
        && !(sql[position] === "*" && sql[position + 1] === "/")) {
        position += 1;
      }
      position = Math.min(position + 2, sql.length);
      continue;
    }
    if (["'", "\"", "`", "["].includes(character)) {
      const closing = character === "[" ? "]" : character;
      position += 1;
      while (position < sql.length) {
        if (sql[position] !== closing) {
          position += 1;
          continue;
        }
        if (closing !== "]" && sql[position + 1] === closing) {
          position += 2;
          continue;
        }
        position += 1;
        break;
      }
      continue;
    }
    if (character === ";") {
      if (triggerDefinition) {
        if (triggerEnd) {
          triggerDefinition = false;
          triggerBody = false;
          triggerStatementStart = false;
          triggerCaseDepth = 0;
          triggerEnd = false;
          statementStart = true;
          statementPrefix = [];
        } else if (triggerBody) {
          triggerStatementStart = true;
        }
      } else {
        statementStart = true;
        statementPrefix = [];
      }
      position += 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(character)) {
      position += 1;
      continue;
    }

    const start = position;
    position += 1;
    while (position < sql.length && /[A-Za-z0-9_$]/.test(sql[position])) {
      position += 1;
    }
    const token = sql.slice(start, position).toUpperCase();

    if (triggerDefinition) {
      if (!triggerBody && token === "BEGIN") {
        triggerBody = true;
        triggerStatementStart = true;
        continue;
      }
      if (triggerBody) {
        if (token === "CASE") {
          triggerCaseDepth += 1;
        } else if (token === "END") {
          if (triggerCaseDepth > 0) triggerCaseDepth -= 1;
          else if (triggerStatementStart) triggerEnd = true;
        }
        triggerStatementStart = false;
      }
      continue;
    }

    if (statementStart) {
      if (TRANSACTION_CONTROL_COMMANDS.has(token)) return token;
      statementStart = false;
    }
    if (statementPrefix.length < 3) {
      statementPrefix.push(token);
      triggerDefinition = (
        statementPrefix.length === 2
        && statementPrefix[0] === "CREATE"
        && statementPrefix[1] === "TRIGGER"
      ) || (
        statementPrefix.length === 3
        && statementPrefix[0] === "CREATE"
        && ["TEMP", "TEMPORARY"].includes(statementPrefix[1])
        && statementPrefix[2] === "TRIGGER"
      );
    }
  }

  return null;
}

function createOperationDatabase(database, operationId) {
  let active = true;

  function assertActive() {
    if (!active) {
      throw migrationError(
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        `SQLite migration operation ${operationId} used its database outside its synchronous execution.`,
      );
    }
  }

  function assertSqlAllowed(sql) {
    const command = transactionControlCommand(sql);
    if (command) {
      throw migrationError(
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        `SQLite migration operation ${operationId} cannot execute transaction command ${command}.`,
      );
    }
  }

  function wrapStatement(statement) {
    const methods = new Map();
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (!methods.has(property)) {
          methods.set(property, (...args) => {
            assertActive();
            return Reflect.apply(value, target, args);
          });
        }
        return methods.get(property);
      },
    });
  }

  const capability = Object.freeze({
    exec(sql) {
      assertActive();
      assertSqlAllowed(sql);
      return database.exec(sql);
    },
    prepare(sql) {
      assertActive();
      assertSqlAllowed(sql);
      return wrapStatement(database.prepare(sql));
    },
    close() {
      assertActive();
      throw migrationError(
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        `SQLite migration operation ${operationId} cannot close its database.`,
      );
    },
  });

  return Object.freeze({
    database: capability,
    deactivate() {
      active = false;
    },
  });
}

function createSqliteMigrationAdapter({
  database,
  operations,
} = {}) {
  assertDatabase(database);
  const registry = normalizedOperations(operations);
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
      manifest_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position >= 0),
      migration_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
      implementation_fingerprint TEXT NOT NULL CHECK(length(implementation_fingerprint) = 64),
      implementation_contract_json TEXT NOT NULL CHECK(length(implementation_contract_json) > 0),
      contract_version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (manifest_id, migration_id),
      UNIQUE (manifest_id, position)
    )
  `);
  const expectedColumns = [
    "manifest_id",
    "position",
    "migration_id",
    "fingerprint",
    "implementation_fingerprint",
    "implementation_contract_json",
    "contract_version",
    "applied_at",
  ];
  const actualColumns = database.prepare(
    `PRAGMA table_info(${HISTORY_TABLE})`,
  ).all().map((column) => column.name);
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    throw migrationError(
      MIGRATION_ERROR_CODES.HISTORY_INVALID,
      "SQLite migration history has an incompatible schema.",
    );
  }

  const selectHistory = database.prepare(`
    SELECT position, migration_id, fingerprint,
           implementation_fingerprint, implementation_contract_json,
           contract_version
    FROM ${HISTORY_TABLE}
    WHERE manifest_id = ?
    ORDER BY position
  `);
  const insertHistory = database.prepare(`
    INSERT INTO ${HISTORY_TABLE}
      (manifest_id, position, migration_id, fingerprint,
       implementation_fingerprint, implementation_contract_json,
       contract_version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteHistory = database.prepare(`
    DELETE FROM ${HISTORY_TABLE}
    WHERE manifest_id = ? AND position = ? AND migration_id = ?
      AND fingerprint = ? AND implementation_fingerprint = ?
  `);

  function internalHistory(manifestId) {
    const rows = selectHistory.all(manifestId);
    for (let position = 0; position < rows.length; position += 1) {
      const row = rows[position];
      if (row.position !== position
        || row.contract_version !== MIGRATION_CONTRACT_VERSION) {
        throw migrationError(
          MIGRATION_ERROR_CODES.HISTORY_INVALID,
          "SQLite migration history is not a contiguous supported chain.",
        );
      }
      assertStoredImplementationContract(registry, row);
    }
    return rows;
  }

  function readAppliedMigrations(manifestId) {
    if (typeof manifestId !== "string" || !OPERATION_ID_PATTERN.test(manifestId)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "SQLite migration manifest id is invalid.",
      );
    }
    return Object.freeze(internalHistory(manifestId).map((row) => Object.freeze({
      id: row.migration_id,
      fingerprint: row.fingerprint,
    })));
  }

  function executeMigrationStep({
    contractVersion,
    manifestId,
    migration,
    direction,
    operationIds,
    context,
  } = {}) {
    if (contractVersion !== MIGRATION_CONTRACT_VERSION
      || typeof manifestId !== "string"
      || !migration || typeof migration !== "object"
      || !Number.isSafeInteger(migration.position)
      || typeof migration.id !== "string"
      || typeof migration.fingerprint !== "string"
      || !Array.isArray(migration.operations)
      || !(migration.rollbackOperations === null || Array.isArray(migration.rollbackOperations))
      || !["apply", "rollback"].includes(direction)
      || !Array.isArray(operationIds)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        "SQLite migration step is invalid.",
      );
    }
    const expectedOperationIds = direction === "apply"
      ? migration.operations
      : migration.rollbackOperations;
    if (!Array.isArray(expectedOperationIds)
      || JSON.stringify(operationIds) !== JSON.stringify(expectedOperationIds)) {
      throw migrationError(
        MIGRATION_ERROR_CODES.EXECUTION_INVALID,
        "SQLite migration operations do not match the migration manifest.",
      );
    }
    const currentImplementationContract = implementationContract(registry, migration);
    const currentImplementationFingerprint = implementationContractFingerprint(
      currentImplementationContract,
    );
    const currentImplementationContractJson = JSON.stringify(currentImplementationContract);
    const handlers = operationIds.map((operationId) => {
      const operation = registry.get(operationId);
      if (!operation) {
        throw migrationError(
          MIGRATION_ERROR_CODES.OPERATION_UNAVAILABLE,
          `SQLite migration operation ${operationId} is unavailable.`,
        );
      }
      return { operationId, handler: operation.handler };
    });

    database.exec("BEGIN IMMEDIATE");
    try {
      const history = internalHistory(manifestId);
      if (direction === "apply") {
        if (history.length !== migration.position) {
          throw migrationError(
            MIGRATION_ERROR_CODES.HISTORY_INVALID,
            "SQLite migration apply position does not follow current history.",
          );
        }
      } else {
        const current = history.at(-1);
        if (!current
          || current.position !== migration.position
          || current.migration_id !== migration.id
          || current.fingerprint !== migration.fingerprint) {
          throw migrationError(
            MIGRATION_ERROR_CODES.HISTORY_INVALID,
            "SQLite migration rollback does not match current history.",
          );
        }
      }

      for (const { handler, operationId } of handlers) {
        const operationDatabase = createOperationDatabase(database, operationId);
        let result;
        try {
          result = handler(Object.freeze({
            database: operationDatabase.database,
            context,
            direction,
            manifestId,
            migrationId: migration.id,
          }));
        } finally {
          operationDatabase.deactivate();
        }
        if (result && typeof result.then === "function") {
          void Promise.resolve(result).catch(() => {});
          throw migrationError(
            MIGRATION_ERROR_CODES.EXECUTION_INVALID,
            `SQLite migration operation ${operationId} must be synchronous.`,
          );
        }
      }

      if (direction === "apply") {
        insertHistory.run(
          manifestId,
          migration.position,
          migration.id,
          migration.fingerprint,
          currentImplementationFingerprint,
          currentImplementationContractJson,
          contractVersion,
        );
      } else {
        const result = deleteHistory.run(
          manifestId,
          migration.position,
          migration.id,
          migration.fingerprint,
          currentImplementationFingerprint,
        );
        if (result.changes !== 1 && result.changes !== 1n) {
          throw migrationError(
            MIGRATION_ERROR_CODES.HISTORY_INVALID,
            "SQLite migration rollback could not remove its history entry.",
          );
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  let exclusiveTail = Promise.resolve();
  function runExclusive(work) {
    if (typeof work !== "function") {
      throw migrationError(
        MIGRATION_ERROR_CODES.ADAPTER_INVALID,
        "SQLite migration session callback is required.",
      );
    }
    const previous = exclusiveTail;
    let release;
    exclusiveTail = new Promise((resolve) => {
      release = resolve;
    });
    return previous.then(
      () => work(Object.freeze({
        executeMigrationStep,
        readAppliedMigrations,
      })),
    ).finally(release);
  }

  return Object.freeze({
    providerId: "sqlite",
    runExclusive,
  });
}

module.exports = {
  createSqliteMigrationAdapter,
};
