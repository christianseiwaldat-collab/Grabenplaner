'use strict';
const { assertPersistenceProvider, createPersistenceProviderFacade } = require('../lib/persistence/contract');

// Instrument the public contract without substituting unregistered objects for
// providers/executors. Parameters and row values are deliberately not recorded.
// The source provider is borrowed; closing this facade never closes its owner.
function measuredPersistence(base) {
  assertPersistenceProvider(base);
  const capabilities = base.getCapabilities(), counts = new Map();
  function record(statement) { counts.set(statement.id, (counts.get(statement.id) || 0) + 1); }
  async function query(target, statement, parameters) {
    record(statement);
    if (statement.operation === 'queryOne') {
      const row = await target.queryOne(statement, parameters); return row ? [row] : [];
    }
    return target.queryAll(statement, parameters);
  }
  function execute(target, statement, parameters) { record(statement); return target.execute(statement, parameters); }
  const access = createPersistenceProviderFacade({
    providerId: capabilities.providerId,
    capabilities: { transaction: capabilities.transaction, features: capabilities.features },
    query: (statement, parameters) => query(base, statement, parameters),
    execute: (statement, parameters) => execute(base, statement, parameters),
    close: async () => {},
    async beginTransaction(options) {
      const opened = Promise.withResolvers(), ending = Promise.withResolvers();
      ending.promise.catch(() => {});
      const finished = base.transaction(async tx => { opened.resolve(tx); await ending.promise; }, options);
      // A connection/begin failure must reject the opening promise as well.
      finished.catch(opened.reject);
      const tx = await opened.promise;
      return {
        query: (statement, parameters) => query(tx, statement, parameters),
        execute: (statement, parameters) => execute(tx, statement, parameters),
        async commit() { ending.resolve(); await finished; },
        async rollback() { ending.reject(new Error('Measured transaction rollback')); try { await finished; } catch {} },
      };
    },
  });
  return { access, counts };
}
module.exports = { measuredPersistence };
