'use strict';
const C = require('../../data-import-contract');
const M = require('../../tradefoto-master-profiles');
const { IMPORT_MASTER_STATEMENTS: S } = require('../statements/import-master-data');
const { DATA_IMPORT_STATEMENTS: D } = require('../statements/data-import');
const { createDataImportPayloadStore } = require('../../data-import-payload-store');
// Trusted, narrowly projected read of existing master segments. The caller must
// authorize its business view; this helper is never exposed as a raw HTTP route.
function createSalesMasterReader({ protection, scopeId, sourceInstance = 'tradefoto-trade' }) {
  async function fields(tx, record, names) {
    if (!record) return null;
    const profile = M.profileFor(record.sourceTable);
    if (record.scopeId !== scopeId || record.sourceInstance !== sourceInstance || record.profileHash !== profile.fingerprint) C.fail('IMPORT_MASTER_INTEGRITY');
    const allowed = new Map(profile.fields.filter(f => names.includes(f.source)).map(f => [f.target, f.source]));
    const result = {};
    const segments = await tx.queryAll(S.segments, { recordId: record.id });
    const expected = M.masterSegments(record.sourceTable, {});
    if (!C.equal(expected.map(s => [s.kind, s.dataClass]).sort(), segments.map(s => [s.kind, s.dataClass]).sort())) C.fail('IMPORT_MASTER_INTEGRITY');
    for (const segment of segments) {
      // Only decrypt classes actually needed for the explicit field projection.
      const columns = M.tableFor(record.sourceTable).columns;
      if (!columns.some(c => names.includes(c.name) && c.dataClass === segment.dataClass)) continue;
      const data = protection.open(segment.payload, ['master-segment', record.scopeId, record.sourceInstance, record.sourceTable,
        record.identityHash, record.id, record.profileHash, record.revision, segment.kind, segment.dataClass]);
      const keys = Object.keys(expected.find(s => s.kind === segment.kind && s.dataClass === segment.dataClass).data);
      if (!C.equal(Object.keys(data).sort(), keys.sort())) C.fail('IMPORT_MASTER_INTEGRITY');
      for (const [key, name] of allowed) if (Object.hasOwn(data, key)) result[name] = data[key];
    }
    return result;
  }
  const reader = {
    async byKey(tx, table, key, names) {
      const record = await tx.queryOne(S.find, { scopeId, identityHash: M.masterIdentity(protection, { scopeId, sourceInstance }, table, key) });
      return fields(tx, record, names);
    },
    async list(tx, table, names, max = 2000) {
      const result = []; let after = '';
      while (true) {
        const records = await tx.queryAll(S.listMappings, { scopeId, sourceInstance, sourceTable: table, after, status: 'all', limit: 200 });
        for (const record of records) result.push(await fields(tx, record, names));
        if (result.length > max) C.fail('IMPORT_REPORT_METADATA_LIMIT', 413);
        if (records.length < 200) return result;
        after = records.at(-1).id;
      }
    },
    async dictionary(tx, table, names, max = 2000) {
      // Only non-personal dictionary labels, including a completely reviewed
      // archived source. This read never applies a prepared master-data import.
      const allowed = { ARTIKEL_Sortimente: ['Sortiment', 'Bezeichnung', 'Warengruppe'], Marken: ['Marke'] };
      if (!allowed[table] || names.some(n => !allowed[table].includes(n))) C.fail('IMPORT_FORBIDDEN', 403);
      const applied = await reader.list(tx, table, names, max);
      if (applied.length) return applied;
      const profile = M.profileFor(table);
      const runs = await tx.queryAll(S.reportDictionaryRuns, { scopeId, profileHash: profile.fingerprint, limit: 32 });
      const run = runs.find(r => r.manifest.sourceInstance === sourceInstance);
      if (!run && runs.length === 32) C.fail('IMPORT_REPORT_METADATA_LIMIT', 413);
      if (!run) return [];
      const id = protection.digest(['run', C.VERSION, { scopeId: run.scopeId, ownerId: run.ownerId }, profile.fingerprint, run.manifest, run.attemptId]);
      if (run.id !== id || !C.equal(run.profile, profile) || run.receivedCount !== run.manifest.expectedRows) C.fail('IMPORT_MASTER_INTEGRITY');
      if (run.receivedCount > max) C.fail('IMPORT_REPORT_METADATA_LIMIT', 413);
      const records = await tx.queryAll(D.listRows, { runId: run.id, after: 0, limit: max + 1 });
      if (records.length !== run.receivedCount) C.fail('IMPORT_MASTER_INTEGRITY');
      const payloads = createDataImportPayloadStore({ protection }), executor = {};
      for (const [name, statement] of Object.entries(D)) if (statement.operation.startsWith('query')) executor[name] = p => tx[statement.operation](statement, p);
      const result = [];
      for (const row of records) {
        if (!['create', 'update', 'refresh', 'unchanged', 'duplicate', 'applied'].includes(row.state) || row.issue) C.fail('IMPORT_MASTER_INTEGRITY');
        const value = await payloads.decode(executor, { run, profile, row, kind: 'row' });
        if (!value.record || protection.digest({ record: value.record }) !== row.contentHash
          || !C.equal(C.normalizeDataImportRow(profile, value.record.source), value.record)) C.fail('IMPORT_MASTER_INTEGRITY');
        if (row.state !== 'duplicate') result.push(Object.fromEntries(names.map(n => [n, value.record.source[n]])));
      }
      return result;
    },
  };
  return reader;
}
module.exports = { createSalesMasterReader };
