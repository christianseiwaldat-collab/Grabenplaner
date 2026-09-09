'use strict';
const C = require('../../data-import-contract');
const M = require('../../tradefoto-master-profiles');
const { IMPORT_MASTER_STATEMENTS: S } = require('../statements/import-master-data');
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
  return {
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
  };
}
module.exports = { createSalesMasterReader };
