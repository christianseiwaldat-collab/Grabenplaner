"use strict";
const { definePersistenceStatement } = require('../contract');
const KEY = Object.freeze({ id: 'text', payload: 'text', createdAt: 'utc_timestamp' });
const SOURCE = Object.freeze({ id: 'text', scopeId: 'text', ownerId: 'text', revision: 'safe_integer', createdAt: 'utc_timestamp', updatedAt: 'utc_timestamp', payload: 'text' });
const def = (id, operation, parameters, columns = {}) => definePersistenceStatement({ id: `data-import-runtime.${id}`, operation, parameters, columns });
const DATA_IMPORT_RUNTIME_STATEMENTS = Object.freeze({
  key: def('key.get', 'queryOne', { id: 'text' }, KEY),
  insertKey: def('key.insert', 'execute', KEY),
  source: def('source.get', 'queryOne', { id: 'text', scopeId: 'text', ownerId: 'text' }, SOURCE),
  sources: def('source.list', 'queryAll', { scopeId: 'text', ownerId: 'text', beforeAt: 'utc_timestamp', beforeId: 'text', limit: 'safe_integer' }, SOURCE),
  insertSource: def('source.insert', 'execute', SOURCE),
  updateSource: def('source.update', 'execute', { id: 'text', scopeId: 'text', ownerId: 'text', revision: 'safe_integer', updatedAt: 'utc_timestamp', payload: 'text' }),
});
module.exports = { DATA_IMPORT_RUNTIME_STATEMENTS, DATA_IMPORT_RUNTIME_COLUMNS: { KEY, SOURCE } };
