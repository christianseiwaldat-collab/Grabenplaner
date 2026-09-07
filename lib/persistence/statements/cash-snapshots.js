'use strict';
const { definePersistenceStatement } = require('../contract');
const { definitions } = require('../../tradefoto-full-import-source');
const optional = kind => Object.freeze({ kind, nullable: true });
const DATASET = Object.freeze({ slot: 'safe_integer', id: 'text', scopeId: 'text', ownerId: 'text',
  revision: 'safe_integer', createdAt: 'utc_timestamp', payload: 'text' });
const ROW = Object.freeze({ datasetSlot: 'safe_integer', sourceRow: 'safe_integer', sourceKey: 'bytes',
  businessDate: optional('date'), parentRow: optional('safe_integer'), locationKey: optional('bytes'),
  sellerKey: optional('bytes'), customerKey: optional('bytes'), articleKey: optional('bytes'), payload: 'text' });
const def = (id, operation, parameters, columns = {}) => definePersistenceStatement({ id: 'cash-snapshots.' + id, operation, parameters, columns });
const TABLES = Object.freeze(definitions('cash').map((table, index) => Object.freeze({ ...table, sqlName: 'cash_snapshot_' + index,
  statements: Object.freeze({
    insert: def(index + '.insert', 'execute', ROW),
    row: def(index + '.row', 'queryOne', { datasetSlot: 'safe_integer', sourceRow: 'safe_integer' }, ROW),
    key: def(index + '.key', 'queryOne', { datasetSlot: 'safe_integer', sourceKey: 'bytes' }, ROW),
    page: def(index + '.page', 'queryAll', { datasetSlot: 'safe_integer', after: 'safe_integer', limit: 'safe_integer' }, ROW),
    count: def(index + '.count', 'queryOne', { datasetSlot: 'safe_integer' }, { count: 'safe_integer' }),
    children: def(index + '.children', 'queryAll', { datasetSlot: 'safe_integer', parentRow: 'safe_integer', limit: 'safe_integer' }, ROW),
  }),
})));
const S = Object.freeze({
  nextSlot: def('dataset.next-slot', 'queryOne', {}, { slot: 'safe_integer' }),
  get: def('dataset.get', 'queryOne', { id: 'text', scopeId: 'text', ownerId: 'text' }, DATASET),
  insert: def('dataset.insert', 'execute', DATASET),
  update: def('dataset.update', 'execute', { slot: 'safe_integer', revision: 'safe_integer', payload: 'text' }),
});
module.exports = { CASH_SNAPSHOT_STATEMENTS: S, CASH_SNAPSHOT_COLUMNS: { DATASET, ROW }, CASH_SNAPSHOT_TABLES: TABLES };
