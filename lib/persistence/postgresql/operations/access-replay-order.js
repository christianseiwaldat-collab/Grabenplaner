'use strict';
// Validate authenticated retired-source dependencies without reapplying their
// unprovable old rows. Retirement times describe deletion work, never Apply.
const C = require('../../../data-import-contract');
const { SOURCE_KINDS } = require('../../../data-import-source-catalog');
const LIMIT = 10000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const compare = (a, b) => (a.kind === 'trade' ? 0 : 1) - (b.kind === 'trade' ? 0 : 1)
  || (a.appliedAt ?? a.createdAt).localeCompare(b.appliedAt ?? b.createdAt) || a.sourceId.localeCompare(b.sourceId);
const profiles = tables => tables.map(table => [table.name, table.profileHash]);
function orderReplaySources(sources, { headers } = {}) {
  if (!Array.isArray(sources) || sources.length > LIMIT || !Array.isArray(headers) || headers.length !== sources.length) fail('PG_SOURCE_REPLAY_RETIREMENT_METADATA');
  const entries = new Map(), metadata = new Map(), dependencies = new Map();
  for (const source of sources) {
    if (!C.plain(source) || entries.has(source.sourceId) || !SOURCE_KINDS.includes(source.kind)
      || !Array.isArray(source.tables) || !source.tables.length) fail('PG_SOURCE_REPLAY_RETIREMENT_METADATA');
    C.sha(source.sourceId); C.id(source.scopeId); C.id(source.ownerId);
    if (source.strategy === 'skip-retired-obsolete') {
      if (source.appliedAt !== null || source.orderBasis !== 'retirement-successor') fail('PG_SOURCE_REPLAY_RETIREMENT_METADATA');
      C.utc(source.createdAt);
    } else { if (source.appliedAt === null) fail('PG_SOURCE_REPLAY_RETIREMENT_METADATA'); C.utc(source.appliedAt); }
    for (const table of source.tables) { C.text(table.name); C.sha(table.profileHash); }
    entries.set(source.sourceId, source); dependencies.set(source.sourceId, []);
  }
  for (const header of headers) {
    const source = entries.get(header?.sourceId), data = header?.data;
    if (!source || metadata.has(header.sourceId) || !C.plain(data) || data.complete !== true
      || header.scopeId !== source.scopeId || header.ownerId !== source.ownerId || data.kind !== source.kind
      || !['applied', 'ready', 'reverted', 'purged'].includes(data.status) || !C.equal(source.retirement, data.retirement ?? null) || !Array.isArray(data.tables)
      || !C.equal(profiles(data.tables), profiles(source.tables))) fail('PG_SOURCE_REPLAY_RETIREMENT_METADATA');
    metadata.set(source.sourceId, data);
  }
  for (const source of sources) {
    const data = metadata.get(source.sourceId), retirement = data.retirement;
    if (!retirement) {
      if (data.status === 'purged' || source.strategy === 'skip-retired-obsolete') fail('PG_SOURCE_REPLAY_RETIREMENT_UNCONFIRMED');
      continue;
    }
    const fields = ['successorId', 'startedAt', 'complete', 'completedAt'];
    if (!C.plain(retirement) || Object.keys(retirement).length !== fields.length || fields.some(field => !Object.hasOwn(retirement, field))
      || retirement.complete !== true || data.status !== 'purged' || source.strategy !== 'skip-retired-obsolete' || source.kind === 'cash') fail('PG_SOURCE_REPLAY_RETIREMENT_UNCONFIRMED');
    C.sha(retirement.successorId); C.utc(retirement.startedAt); C.utc(retirement.completedAt);
    if (retirement.completedAt < retirement.startedAt) fail('PG_SOURCE_REPLAY_RETIREMENT_UNCONFIRMED');
    const successor = entries.get(retirement.successorId), next = metadata.get(retirement.successorId);
    if (!successor) fail('PG_SOURCE_REPLAY_RETIREMENT_SUCCESSOR');
    if (successor.kind !== source.kind || successor.scopeId !== source.scopeId || successor.ownerId !== source.ownerId
      || !['normal-import', 'skip-retired-obsolete'].includes(successor.strategy) || !C.equal(profiles(successor.tables), profiles(source.tables))) fail('PG_SOURCE_REPLAY_RETIREMENT_SUCCESSOR');
    // The final successor must still be a complete confirmed business import.
    // An intermediate retired successor is checked through its own exact edge.
    if (!['applied', 'purged'].includes(next.status) || (next.status === 'purged') !== (successor.strategy === 'skip-retired-obsolete')
      || successor.tables.some(table => table.deferred || table.exceptionRanges?.length)
      || next.status === 'applied' && (next.retirement || next.kind === 'trade' && next.catalog?.complete !== true)) fail('PG_SOURCE_REPLAY_RETIREMENT_UNCONFIRMED');
    dependencies.get(successor.sourceId).push(source);
  }
  for (const list of dependencies.values()) list.sort(compare);
  // Visit in the existing order, pulling only required predecessors forward.
  // This retains the relative chronology of all nonretired sources and avoids
  // recursion limits for a long but valid chain of compact source headers.
  const result = [], state = new Map();
  for (const source of [...sources].sort(compare)) {
    if (state.get(source.sourceId) === 2) continue;
    const stack = [{ source, next: 0 }];
    while (stack.length) {
      const frame = stack.at(-1), id = frame.source.sourceId;
      state.set(id, 1);
      const parents = dependencies.get(id);
      if (frame.next < parents.length) {
        const parent = parents[frame.next++], seen = state.get(parent.sourceId);
        if (seen === 1) fail('PG_SOURCE_REPLAY_RETIREMENT_CYCLE');
        if (seen !== 2) stack.push({ source: parent, next: 0 });
      } else { state.set(id, 2); result.push(frame.source); stack.pop(); }
    }
  }
  return result;
}
module.exports = { orderReplaySources };
