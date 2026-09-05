"use strict";
const { definePersistenceStatement } = require('../contract');
const nullable = kind => ({ kind, nullable: true });
const define = (id, operation, parameters, columns) => definePersistenceStatement({ id: 'import-history.' + id, operation, parameters, ...(columns ? { columns } : {}) });
const one = (id, parameters, columns) => define(id, 'queryOne', parameters, columns);
const all = (id, parameters, columns) => define(id, 'queryAll', parameters, columns);
const write = (id, parameters) => define(id, 'execute', parameters);
const RECORD = { id: 'text', scopeId: 'text', sourceInstance: 'text', source: 'text', sourceTable: 'text', profileHash: 'text', identityHash: 'text', revision: 'safe_integer' };
const VERSION = { recordId: 'text', revision: 'safe_integer', fileSha256: 'text', snapshotAt: 'utc_timestamp', importedBy: 'text', importedAt: 'utc_timestamp',
  runId: 'text', masterSourceInstance: 'text', businessDate: nullable('date'), parentId: nullable('text'), parentRevision: nullable('safe_integer'), payload: 'text' };
const SEGMENT = { recordId: 'text', revision: 'safe_integer', dataClass: 'text', payload: 'text' };
const REFERENCE = { recordId: 'text', revision: 'safe_integer', role: 'text', dataClass: 'text', masterRecordId: nullable('text'), lookupHash: nullable('text') };
const ID = { id: 'text', scopeId: 'text' }, REV = { recordId: 'text', revision: 'safe_integer' }, CAS = { ...ID, expectedRevision: 'safe_integer' };
const IMPORT_HISTORY_STATEMENTS = Object.freeze({
  search: all('search', { scopeId: 'text', sourceInstance: 'text', sourceTable: 'text', dateFrom: 'date', dateTo: 'date',
    locationRole: 'text', locationHash: nullable('text'), unassigned: 'boolean', sellerMode: 'text', sellerRole: 'text', sellerHash: nullable('text'),
    customerHash: nullable('text'), snapshot: nullable('text'), afterDate: 'date', afterId: 'text', limit: 'safe_integer' }, { ...RECORD, businessDate: 'date' }),
  get: one('get', ID, RECORD), find: one('find', { identityHash: 'text', scopeId: 'text' }, RECORD),
  insert: write('insert', RECORD), advance: write('advance', CAS), remove: write('remove', CAS),
  version: one('version', REV, VERSION), insertVersion: write('version.insert', VERSION),
  versions: all('versions', { recordId: 'text' }, VERSION), clearVersions: write('version.clear', { recordId: 'text' }),
  segments: all('segments', REV, SEGMENT), insertSegment: write('segment.insert', SEGMENT), clearSegments: write('segment.clear', { recordId: 'text' }),
  references: all('references', REV, REFERENCE), insertReference: write('reference.insert', REFERENCE), clearReferences: write('reference.clear', { recordId: 'text' }),
  dependencies: one('dependencies', { id: 'text' }, { count: 'safe_integer' }),
  children: all('children', { parentId: 'text', scopeId: 'text', after: 'text', limit: 'safe_integer' }, RECORD),
  list: all('list', { scopeId: 'text', sourceInstance: 'text', source: 'text', sourceTable: 'text', after: 'text', limit: 'safe_integer', snapshot: nullable('text') }, RECORD),
  insertHold: write('hold.insert', { recordId: 'text', consumerId: 'text' }),
  removeHold: write('hold.remove', { recordId: 'text', consumerId: 'text' }),
});
module.exports = { IMPORT_HISTORY_STATEMENTS, IMPORT_HISTORY_COLUMNS: { RECORD, VERSION, SEGMENT, REFERENCE } };
