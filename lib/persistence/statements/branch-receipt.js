'use strict';
const { definePersistenceStatement } = require('../contract');
const { CASH_SNAPSHOT_TABLES } = require('./cash-snapshots');
const head = CASH_SNAPSHOT_TABLES.find(t => t.name === 'Umsatz_KASSE');
const sourceSearch = definePersistenceStatement({ id: 'branch-receipt.source-search', operation: 'queryAll',
  parameters: { datasetSlot: 'safe_integer', locationKey: { kind: 'bytes', nullable: true }, dateFrom: 'date', dateTo: 'date', afterDate: 'date', afterRow: 'safe_integer', limit: 'safe_integer' },
  columns: head.statements.row.columns });
module.exports = { sourceSearch };
