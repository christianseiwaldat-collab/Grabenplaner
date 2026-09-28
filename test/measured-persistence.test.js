'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { definePersistenceStatement, assertPersistenceAccess } = require('../lib/persistence/contract');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { measuredPersistence } = require('../test-support/measured-persistence');

test('performance instrumentation retains registered executors, rollback, readonly and borrowed ownership', async () => {
  const read = definePersistenceStatement({ id: 'measurement.read', operation: 'queryOne', parameters: {}, columns: { total: 'safe_integer' } });
  const write = definePersistenceStatement({ id: 'measurement.write', operation: 'execute', parameters: { value: 'safe_integer' } });
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: [
    { statement: read, sql: 'SELECT COUNT(*) AS total FROM measurement', returning: false },
    { statement: write, sql: 'INSERT INTO measurement VALUES ($value)', returning: false },
  ] });
  app.database.exec('CREATE TABLE measurement(value INTEGER)');
  const measured = measuredPersistence(app.provider);
  try {
    assert.equal(assertPersistenceAccess(measured.access), measured.access);
    let expired;
    await measured.access.transaction(async tx => { expired = tx; assert.equal(assertPersistenceAccess(tx), tx); await tx.execute(write, { value: 1 }); });
    assert.equal((await measured.access.queryOne(read)).total, 1);
    await assert.rejects(measured.access.transaction(async tx => { await tx.execute(write, { value: 2 }); throw new Error('cancel'); }), /cancel/);
    assert.equal((await measured.access.queryOne(read)).total, 1);
    await assert.rejects(measured.access.transaction(tx => tx.execute(write, { value: 3 }), { readOnly: true }), e => e.code === 'PERSISTENCE_TRANSACTION_STATE_INVALID');
    await assert.rejects(expired.queryOne(read), e => e.code === 'PERSISTENCE_TRANSACTION_STATE_INVALID');
    assert.equal(measured.counts.get(write.id), 2); assert.equal(measured.counts.get(read.id), 2);
    await measured.access.close(); assert.equal((await app.provider.queryOne(read)).total, 1);
  } finally { await measured.access.close(); await app.provider.close(); app.database.close(); }
});

test('a source closed before transaction opening rejects without leaving instrumentation waiting', async () => {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: [] });
  const measured = measuredPersistence(app.provider);
  await app.provider.close();
  try { await assert.rejects(measured.access.transaction(() => assert.fail('closed source must not start'))); }
  finally { await measured.access.close(); app.database.close(); }
});
