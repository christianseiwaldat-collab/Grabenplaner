'use strict';
const { definePersistenceStatement } = require('../contract');
const { CASH_SNAPSHOT_TABLES } = require('./cash-snapshots');
const nullable = kind => ({ kind, nullable: true });
const def = (id, operation, parameters, columns = {}) => definePersistenceStatement({ id: 'cash-publications.' + id, operation, parameters, columns });
const STATE = { scopeId: 'text', revision: 'safe_integer', payload: 'text' };
const PUBLICATION = { id: 'text', scopeId: 'text', datasetId: 'text', ownerId: 'text', createdAt: 'utc_timestamp', payload: 'text' };
const BINDING = { publicationId: 'text', kind: 'text', sourceKey: 'bytes', targetId: 'text', historical: 'boolean', payload: 'text' };
const search = assigned => Object.freeze(Object.fromEntries(['Umsatz_Kasse_Details', 'Tagesbericht', 'KassenJournal_Details', 'Umsatz_KASSE'].map(name => [name,
    def((assigned ? 'search-assigned.' : 'search.') + CASH_SNAPSHOT_TABLES.findIndex(t => t.name === name), 'queryAll', {
      publicationId: 'text', datasetSlot: 'safe_integer', dateFrom: 'date', dateTo: 'date', afterDate: 'date', afterRow: 'safe_integer',
      locationId: nullable('text'), unassigned: 'boolean', sellerId: nullable('text'), sellerMode: 'text', sellerRole: 'text', customerId: nullable('text'), limit: 'safe_integer',
    }, { sourceRow: 'safe_integer', businessDate: 'date' })])));
const S = Object.freeze({
  state: def('state', 'queryOne', { scopeId: 'text' }, STATE),
  insertState: def('state.insert', 'execute', STATE),
  updateState: def('state.update', 'execute', STATE),
  publication: def('get', 'queryOne', { id: 'text', scopeId: 'text' }, PUBLICATION),
  insertPublication: def('insert', 'execute', PUBLICATION),
  insertBinding: def('binding.insert', 'execute', BINDING),
  binding: def('binding.get', 'queryOne', { publicationId: 'text', kind: 'text', sourceKey: 'bytes' }, BINDING),
  bindings: def('bindings', 'queryAll', { publicationId: 'text', kind: 'text', limit: 'safe_integer' }, BINDING),
  bindingCount: def('binding.count', 'queryOne', { publicationId: 'text' }, { count: 'safe_integer' }),
  bindingInventory: def('binding.inventory', 'queryOne', { publicationId: 'text' }, { rowCount: 'safe_integer', generation: 'safe_integer' }),
  search: search(false),
  searchAssigned: search(true),
  references: Object.freeze(Object.fromEntries(['FILIALEN', 'MITARBEITER', 'ARTIKEL_STAMM', 'KUNDEN'].map(kind => [kind,
    def('references.' + kind.toLowerCase().replace(/_/g, '-'), 'queryAll', { datasetSlot: 'safe_integer', after: 'bytes', limit: 'safe_integer' },
      { sourceKey: 'bytes', tableIndex: 'safe_integer', sourceRow: 'safe_integer' })]))),
});
module.exports = { CASH_PUBLICATION_STATEMENTS: S, CASH_PUBLICATION_COLUMNS: { STATE, PUBLICATION, BINDING } };
