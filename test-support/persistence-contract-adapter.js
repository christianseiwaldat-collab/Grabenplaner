"use strict";

const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  createPersistenceProviderFacade,
  definePersistenceStatement,
} = require("../lib/persistence/contract");

const ROW_COLUMNS = Object.freeze({
  id: "safe_integer",
  label: "text",
  active: "boolean",
  largeNumber: "bigint_string",
  amount: "decimal_string",
  occurredAt: "utc_timestamp",
  day: "date",
  time: "time",
  metadata: "json",
  payload: "bytes",
  optionalNote: Object.freeze({ kind: "text", nullable: true, optional: true }),
});

function contractStatements() {
  return Object.freeze({
    one: definePersistenceStatement({
      id: "contract.row.one",
      operation: "queryOne",
      parameters: { id: "safe_integer" },
      columns: ROW_COLUMNS,
    }),
    all: definePersistenceStatement({
      id: "contract.row.all",
      operation: "queryAll",
      columns: ROW_COLUMNS,
    }),
    many: definePersistenceStatement({
      id: "contract.row.many",
      operation: "queryOne",
      columns: ROW_COLUMNS,
    }),
    invalidResult: definePersistenceStatement({
      id: "contract.row.invalid",
      operation: "queryOne",
      columns: ROW_COLUMNS,
    }),
    driverError: definePersistenceStatement({
      id: "contract.driver.error",
      operation: "queryOne",
      parameters: { secret: "text" },
      columns: ROW_COLUMNS,
    }),
    normalizedDriverError: definePersistenceStatement({
      id: "contract.driver.normalized-error",
      operation: "queryOne",
      parameters: { secret: "text" },
      columns: ROW_COLUMNS,
    }),
    jsonParameter: definePersistenceStatement({
      id: "contract.json.parameter",
      operation: "queryOne",
      parameters: { value: "json" },
      columns: {},
    }),
    insert: definePersistenceStatement({
      id: "contract.row.insert",
      operation: "execute",
      parameters: {
        id: "safe_integer",
        label: "text",
      },
      columns: {
        id: "safe_integer",
        label: "text",
      },
    }),
  });
}

function clonedRow(row) {
  return {
    ...row,
    metadata: JSON.parse(JSON.stringify(row.metadata)),
    payload: Buffer.from(row.payload),
  };
}

function createContractTestSubject({
  commitFailure = false,
  rollbackFailure = false,
} = {}) {
  const sourcePayload = Buffer.from([1, 2, 3, 4]);
  const expectedRow = {
    id: 1,
    label: "Eins",
    active: true,
    largeNumber: "9007199254740993",
    amount: "1234.50",
    occurredAt: "2026-07-29T08:15:30.000Z",
    day: "2026-07-29",
    time: "10:15:30",
    metadata: { tags: ["vertrag", "neutral"], count: 2 },
    payload: Buffer.from(sourcePayload),
  };
  let rows = [clonedRow(expectedRow)];
  let pauseGate = null;
  let queryStartedResolve = null;
  const inspection = {
    begins: 0,
    commits: 0,
    rollbacks: 0,
    closes: 0,
    transactionTokens: new Set(),
    events: [],
    lastAdapterPayload: null,
  };

  const control = {
    queryStarted: Promise.resolve(),
    pauseNextQuery() {
      let release;
      pauseGate = new Promise((resolve) => { release = resolve; });
      this.releaseQuery = release;
      this.queryStarted = new Promise((resolve) => { queryStartedResolve = resolve; });
    },
    releaseQuery() {},
  };

  async function waitForGate() {
    if (!pauseGate) return;
    const gate = pauseGate;
    pauseGate = null;
    queryStartedResolve?.();
    queryStartedResolve = null;
    await gate;
  }

  function queryFor(store, token) {
    return async (statement, params) => {
      inspection.events.push({ kind: "query", statementId: statement.id, token });
      if (token !== "global") inspection.transactionTokens.add(token);
      await waitForGate();
      if (statement.id === "contract.row.one") {
        const result = store.filter((row) => row.id === params.id).map(clonedRow);
        inspection.lastAdapterPayload = result[0]?.payload || null;
        return result;
      }
      if (statement.id === "contract.row.all") {
        const result = store.map(clonedRow);
        inspection.lastAdapterPayload = result[0]?.payload || null;
        return result;
      }
      if (statement.id === "contract.row.many") return [clonedRow(expectedRow), clonedRow(expectedRow)];
      if (statement.id === "contract.row.invalid") {
        return [{ ...clonedRow(expectedRow), rawClient: { connected: true } }];
      }
      if (statement.id === "contract.driver.error") {
        const error = new Error(`driver failed for ${params.secret}`);
        error.name = "DriverFailure";
        error.code = "SQLITE_PRIVATE_DRIVER_CODE";
        throw error;
      }
      if (statement.id === "contract.driver.normalized-error") {
        throw new PersistenceError(PERSISTENCE_ERROR_CODES.UNKNOWN, {
          publicMessage: params.secret,
          cause: new Error(params.secret),
        });
      }
      return [];
    };
  }

  function executeFor(store, token) {
    return async (statement, params) => {
      inspection.events.push({ kind: "execute", statementId: statement.id, token });
      if (token !== "global") inspection.transactionTokens.add(token);
      if (statement.id !== "contract.row.insert") return { rowsAffected: 0, returnedRows: [] };
      store.push({
        ...clonedRow(expectedRow),
        id: params.id,
        label: params.label,
      });
      return {
        rowsAffected: 1,
        returnedRows: [{ id: params.id, label: params.label }],
        lastInsertRowid: BigInt(params.id),
        rawStatement: { id: "hidden" },
      };
    };
  }

  const adapter = {
    providerId: "contract-test",
    capabilities: {
      transaction: {
        nested: "reject",
        isolationLevels: ["default", "serializable"],
      },
      features: {
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
      },
    },
    query: queryFor(rows, "global"),
    execute: executeFor(rows, "global"),
    async beginTransaction(options) {
      inspection.begins += 1;
      const transactionToken = Object.freeze({ sequence: inspection.begins });
      const transactionRows = rows.map(clonedRow);
      inspection.events.push({ kind: "begin", options, token: transactionToken });
      return {
        query: queryFor(transactionRows, transactionToken),
        execute: executeFor(transactionRows, transactionToken),
        async commit() {
          inspection.commits += 1;
          inspection.events.push({ kind: "commit", token: transactionToken });
          if (commitFailure) throw new Error("commit diagnostic");
          rows = transactionRows.map(clonedRow);
          adapter.query = queryFor(rows, "global");
          adapter.execute = executeFor(rows, "global");
        },
        async rollback() {
          inspection.rollbacks += 1;
          inspection.events.push({ kind: "rollback", token: transactionToken });
          if (rollbackFailure) throw new Error("rollback diagnostic");
        },
        rawClient: { token: transactionToken },
      };
    },
    async close() {
      inspection.closes += 1;
    },
    rawPool: { hidden: true },
  };

  return {
    provider: createPersistenceProviderFacade(adapter),
    statements: contractStatements(),
    inspection,
    control,
    expectedRow,
    sourcePayload,
  };
}

module.exports = {
  createContractTestSubject,
};
