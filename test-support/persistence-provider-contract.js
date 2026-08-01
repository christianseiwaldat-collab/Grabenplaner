"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PERSISTENCE_ERROR_CODES,
  assertPersistenceExecutor,
  assertPersistenceProvider,
} = require("../lib/persistence/contract");

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "client",
  "connection",
  "db",
  "driver",
  "handle",
  "pool",
  "prepare",
  "raw",
  "statement",
  "unwrap",
]);

function assertNoRawHandleSurface(value) {
  for (const key of Object.keys(value || {})) {
    assert.equal(FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase()), false, `verbotenes öffentliches Feld: ${key}`);
  }
}

function assertDeepFrozen(value, visited = new Set()) {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value) || visited.has(value)) return;
  visited.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, visited);
}

function isPersistenceCode(code) {
  return (error) => error?.code === code;
}

function definePersistenceProviderContractTests({ name, createSubject }) {
  test(`${name}: Oberfläche, Promises, Werte und Resultate sind providerneutral`, async () => {
    const subject = createSubject();
    const { provider, statements, inspection } = subject;
    assert.equal(assertPersistenceProvider(provider), provider);
    assert.deepEqual(Object.keys(provider).sort(), [
      "close",
      "execute",
      "getCapabilities",
      "queryAll",
      "queryOne",
      "transaction",
    ]);
    assertNoRawHandleSurface(provider);

    const pending = provider.queryOne(statements.one, { id: 1 });
    assert.equal(pending instanceof Promise, true);
    const row = await pending;
    assert.deepEqual(row, subject.expectedRow);
    assert.equal(Object.isFrozen(row), true);
    assert.equal(Buffer.isBuffer(row.payload), true);
    assert.notEqual(row.payload, subject.sourcePayload);
    assert.notEqual(row.payload, inspection.lastAdapterPayload);
    row.payload[0] = 99;
    assert.equal(inspection.lastAdapterPayload[0], 1);

    const rows = await provider.queryAll(statements.all);
    assert.equal(Object.isFrozen(rows), true);
    assert.equal(rows.length, 1);
    assertDeepFrozen(rows[0].metadata);

    const result = await provider.execute(statements.insert, { id: 2, label: "Zwei" });
    assert.deepEqual(result, {
      rowsAffected: 1,
      returnedRows: [{ id: 2, label: "Zwei" }],
    });
    assert.deepEqual(Object.keys(result).sort(), ["returnedRows", "rowsAffected"]);
    assert.equal(Object.hasOwn(result, "lastInsertRowid"), false);
    assertDeepFrozen(result);

    const capabilities = provider.getCapabilities();
    assertDeepFrozen(capabilities);
    assert.deepEqual(provider.getCapabilities(), capabilities);
    assert.equal(capabilities.contractVersion, 1);
    assert.equal(capabilities.features.atomicTransactions, true);
    assert.equal(JSON.stringify(capabilities).includes("connection"), false);
    await provider.close();
  });

  test(`${name}: Statement-, Parameter- und Kardinalitätsfehler scheitern geschlossen`, async () => {
    const { provider, statements } = createSubject();
    const missingParameter = provider.queryOne(statements.one, {});
    assert.equal(missingParameter instanceof Promise, true);
    await assert.rejects(missingParameter, isPersistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID));
    await assert.rejects(
      provider.queryOne(statements.one, { id: 1, extra: true }),
      isPersistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
    );
    await assert.rejects(
      provider.queryAll(statements.one, { id: 1 }),
      isPersistenceCode(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID),
    );
    await assert.rejects(
      provider.queryOne(statements.many),
      isPersistenceCode(PERSISTENCE_ERROR_CODES.RESULT_INVALID),
    );
    await assert.rejects(
      provider.queryOne(statements.invalidResult),
      isPersistenceCode(PERSISTENCE_ERROR_CODES.RESULT_INVALID),
    );
    await provider.close();
  });

  test(`${name}: Transaktionen verwenden ausschließlich ihren gebundenen Executor`, async () => {
    const subject = createSubject();
    const { provider, statements, inspection } = subject;
    let leakedExecutor;
    const result = await provider.transaction(async (tx) => {
      leakedExecutor = tx;
      assert.equal(assertPersistenceExecutor(tx), tx);
      assert.deepEqual(Object.keys(tx).sort(), ["execute", "queryAll", "queryOne"]);
      assertNoRawHandleSurface(tx);
      await tx.execute(statements.insert, { id: 3, label: "Drei" });
      const rows = await tx.queryAll(statements.all);
      assert.equal(rows.some((row) => row.id === 3), true);
      await assert.rejects(
        provider.queryAll(statements.all),
        isPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
      );
      await assert.rejects(
        provider.transaction(async () => null),
        isPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
      );
      return "committed";
    }, { isolation: "serializable", readOnly: false });

    assert.equal(result, "committed");
    assert.equal(inspection.commits, 1);
    assert.equal(inspection.rollbacks, 0);
    assert.equal(inspection.transactionTokens.size, 1);
    const beginEvent = inspection.events.find((entry) => entry.kind === "begin");
    assert.deepEqual(beginEvent?.options, { isolation: "serializable", readOnly: false });
    assert.equal(Object.isFrozen(beginEvent?.options), true);
    assert.equal((await provider.queryAll(statements.all)).some((row) => row.id === 3), true);
    await assert.rejects(
      leakedExecutor.queryAll(statements.all),
      isPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
    );
    await provider.close();
  });

  test(`${name}: Transaktionsoptionen werden vor dem Adapter strikt validiert`, async () => {
    const subject = createSubject();
    const { provider, inspection } = subject;
    let callbackCalled = false;

    for (const [options, expectedCode] of [
      [{ isolation: "unsupported" }, PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID],
      [{ readOnly: "yes" }, PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID],
      [{ readOnly: true, unexpected: true }, PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION],
    ]) {
      await assert.rejects(
        provider.transaction(async () => { callbackCalled = true; }, options),
        isPersistenceCode(expectedCode),
      );
    }

    assert.equal(callbackCalled, false);
    assert.equal(inspection.begins, 0);
    await provider.close();
  });

  test(`${name}: parallele Providerarbeit wartet außerhalb der exklusiven Transaktion`, async () => {
    const subject = createSubject();
    const { provider, statements, inspection } = subject;
    let startExternal;
    let externalSettled = false;
    const externalStart = new Promise((resolve) => { startExternal = resolve; });
    const externalQuery = externalStart
      .then(() => provider.queryAll(statements.all))
      .then((rows) => {
        externalSettled = true;
        return rows;
      });

    await provider.transaction(async (tx) => {
      await tx.queryAll(statements.all);
      startExternal();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(externalSettled, false);
      assert.equal(
        inspection.events.some((entry) => entry.kind === "query" && entry.token === "global"),
        false,
      );
    });

    assert.equal((await externalQuery).length, 1);
    const commitIndex = inspection.events.findIndex((entry) => entry.kind === "commit");
    const globalQueryIndex = inspection.events.findIndex(
      (entry) => entry.kind === "query" && entry.token === "global",
    );
    assert.ok(commitIndex >= 0 && globalQueryIndex > commitIndex);
    await provider.close();
  });

  test(`${name}: nicht abgewartete Executorarbeit wird vor Commit vollständig geleert`, async () => {
    const subject = createSubject();
    const { provider, statements, inspection, control } = subject;
    control.pauseNextQuery();
    let unawaitedQuery;
    let transactionSettled = false;
    const transaction = provider.transaction(async (tx) => {
      unawaitedQuery = tx.queryAll(statements.all);
    }).then((value) => {
      transactionSettled = true;
      return value;
    });

    await control.queryStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transactionSettled, false);
    assert.equal(inspection.commits, 0);
    control.releaseQuery();
    await transaction;
    assert.equal((await unawaitedQuery).length, 1);
    assert.equal(inspection.commits, 1);
    assert.equal(inspection.rollbacks, 0);
    await provider.close();
  });

  test(`${name}: Rollback erhält den Primärfehler auch bei zusätzlichem Rollbackfehler`, async () => {
    const subject = createSubject({ rollbackFailure: true });
    const { provider, statements, inspection } = subject;
    const primaryError = new Error("fachlicher Primärfehler");
    await assert.rejects(
      provider.transaction(async (tx) => {
        await tx.execute(statements.insert, { id: 4, label: "Vier" });
        throw primaryError;
      }),
      (error) => error === primaryError,
    );
    assert.equal(inspection.commits, 0);
    assert.equal(inspection.rollbacks, 1);
    assert.equal((await provider.queryAll(statements.all)).some((row) => row.id === 4), false);
    await provider.close();
  });

  test(`${name}: Commitfehler versucht Cleanup und bleibt der Primärfehler`, async () => {
    const subject = createSubject({ commitFailure: true, rollbackFailure: true });
    const { provider, statements, inspection } = subject;
    await assert.rejects(
      provider.transaction(async (tx) => {
        await tx.execute(statements.insert, { id: 5, label: "Fünf" });
      }),
      isPersistenceCode(PERSISTENCE_ERROR_CODES.UNKNOWN),
    );
    assert.equal(inspection.commits, 1);
    assert.equal(inspection.rollbacks, 1);
    assert.equal((await provider.queryAll(statements.all)).some((row) => row.id === 5), false);
    await provider.close();
  });

  test(`${name}: Read-only-Transaktionen lehnen Schreiboperationen ab`, async () => {
    const subject = createSubject();
    const { provider, statements, inspection } = subject;
    await provider.transaction(async (tx) => {
      assert.equal((await tx.queryAll(statements.all)).length, 1);
      await assert.rejects(
        tx.execute(statements.insert, { id: 6, label: "Sechs" }),
        isPersistenceCode(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID),
      );
    }, { readOnly: true });
    assert.equal(inspection.commits, 1);
    assert.equal(inspection.rollbacks, 0);
    assert.equal((await provider.queryAll(statements.all)).some((row) => row.id === 6), false);
    await provider.close();
  });

  test(`${name}: Treiberfehler werden ohne Geheimnisse normalisiert`, async () => {
    const { provider, statements } = createSubject();
    const secret = "postgresql://admin:SEHR-GEHEIM@database.example/app";
    await assert.rejects(provider.queryOne(statements.driverError, { secret }), (error) => {
      assert.equal(error.code, PERSISTENCE_ERROR_CODES.UNKNOWN);
      assert.equal(error.retryable, false);
      assert.equal(error.code.startsWith("SQLITE_"), false);
      assert.equal(JSON.stringify(error).includes("SEHR-GEHEIM"), false);
      assert.equal(String(error.message).includes("SEHR-GEHEIM"), false);
      assert.equal(JSON.stringify(error.cause || {}).includes("SEHR-GEHEIM"), false);
      return true;
    });
    await assert.rejects(provider.queryOne(statements.normalizedDriverError, { secret }), (error) => {
      assert.equal(error.code, PERSISTENCE_ERROR_CODES.UNKNOWN);
      assert.equal(JSON.stringify(error).includes("SEHR-GEHEIM"), false);
      assert.equal(String(error.message).includes("SEHR-GEHEIM"), false);
      assert.equal(JSON.stringify(error.cause || {}).includes("SEHR-GEHEIM"), false);
      return true;
    });
    await provider.close();
  });

  test(`${name}: close wartet auf laufende Arbeit, ist idempotent und sperrt neue Arbeit`, async () => {
    const subject = createSubject();
    const { provider, statements, control, inspection } = subject;
    control.pauseNextQuery();
    const pendingQuery = provider.queryAll(statements.all);
    await control.queryStarted;

    const firstClose = provider.close();
    const secondClose = provider.close();
    await assert.rejects(
      provider.queryAll(statements.all),
      isPersistenceCode(PERSISTENCE_ERROR_CODES.PROVIDER_CLOSING),
    );
    assert.equal(inspection.closes, 0);
    control.releaseQuery();
    await pendingQuery;
    await Promise.all([firstClose, secondClose]);
    assert.equal(inspection.closes, 1);
    assertDeepFrozen(provider.getCapabilities());
    await assert.rejects(
      provider.queryAll(statements.all),
      isPersistenceCode(PERSISTENCE_ERROR_CODES.PROVIDER_CLOSED),
    );
    await provider.close();
    assert.equal(inspection.closes, 1);
  });
}

module.exports = {
  definePersistenceProviderContractTests,
};
