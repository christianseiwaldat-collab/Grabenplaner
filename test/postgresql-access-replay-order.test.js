'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { orderReplaySources } = require('../lib/persistence/postgresql/operations/access-replay-order');
const id = value => crypto.createHash('sha256').update(value).digest('hex');
const at = day => '2026-11-' + String(day).padStart(2, '0') + 'T12:00:00.000Z';
function fixture() {
  const sources = ['old', 'middle', 'latest', 'unrelated', 'trade'].map((name, index) => ({ sourceId: id(name), scopeId: 'scope', ownerId: '00001',
    kind: name === 'trade' ? 'trade' : 'bestell', strategy: 'normal-import', appliedAt: at([15, 14, 10, 11, 16][index]), createdAt: at(9), orderBasis: 'apply-progress', retirement: null,
    tables: [{ name: 'source_table', profileHash: id('profile'), deferred: null, exceptionRanges: [] }] }));
  const headers = sources.map(source => ({ sourceId: source.sourceId, scopeId: source.scopeId, ownerId: source.ownerId,
    data: { kind: source.kind, complete: true, status: 'applied', tables: source.tables.map(({ name, profileHash }) => ({ name, profileHash })), catalog: { complete: true } } }));
  const retire = (from, to) => {
    sources[from].strategy = 'skip-retired-obsolete';
    sources[from].appliedAt = null; sources[from].orderBasis = 'retirement-successor';
    headers[from].data.status = 'purged';
    headers[from].data.retirement = { successorId: sources[to].sourceId, startedAt: at(15), completedAt: at(16), complete: true };
    sources[from].retirement = { ...headers[from].data.retirement };
  };
  retire(0, 1); retire(1, 2);
  return { sources, headers, retire };
}
test('authenticated retired skips precede their successors without inferring old Apply or changing ordinary chronology', () => {
  const f = fixture(), before = JSON.stringify(f), result = orderReplaySources(f.sources, { headers: f.headers });
  assert.deepEqual(result.map(source => source.sourceId), [4, 0, 1, 2, 3].map(index => f.sources[index].sourceId));
  assert.equal(JSON.stringify(f), before); assert.ok(result.every(source => f.sources.includes(source)));
  assert.equal(result[1].appliedAt, null, 'no invented old Apply timestamp');
});
test('missing, foreign, incompatible and nonconfirmed successors fail closed', () => {
  const mutations = [
    f => { f.headers[0].data.retirement.successorId = id('missing'); },
    f => { f.sources[1].scopeId = f.headers[1].scopeId = 'foreign'; },
    f => { f.sources[1].ownerId = f.headers[1].ownerId = '00002'; },
    f => { f.sources[1].kind = f.headers[1].data.kind = 'inventur'; },
    f => { f.sources[1].tables[0].profileHash = f.headers[1].data.tables[0].profileHash = id('other-profile'); },
    f => { f.headers[2].data.status = 'ready'; },
    f => { f.headers[2].data.complete = false; },
    f => { f.sources[2].tables[0].deferred = 'INCOMPLETE_STOCK_SNAPSHOT'; },
    f => { f.sources[2].tables[0].exceptionRanges.push({ first: 1, last: 1 }); },
    f => { f.sources[2].strategy = 'skip-reverted'; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => orderReplaySources(f.sources, { headers: f.headers }), /PG_SOURCE_REPLAY_RETIREMENT_/); }
});
test('partial or malformed retirement receipts and cycles are rejected', () => {
  for (const mutate of [
    f => { f.headers[0].data.retirement.complete = false; },
    f => { delete f.headers[0].data.retirement.completedAt; },
    f => { f.headers[0].data.retirement.extra = true; },
    f => { f.headers[0].data.retirement.completedAt = at(14); },
    f => { delete f.headers[0].data.retirement; },
    f => { f.headers[0].data.status = 'applied'; },
    f => { f.sources[0].strategy = 'normal-import'; },
    f => { f.sources[0].appliedAt = at(15); },
    f => { f.sources[0].orderBasis = 'core-update'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => orderReplaySources(f.sources, { headers: f.headers }), /PG_SOURCE_REPLAY_RETIREMENT_/); }
  const f = fixture(); f.retire(2, 0);
  assert.throws(() => orderReplaySources(f.sources, { headers: f.headers }), { code: 'PG_SOURCE_REPLAY_RETIREMENT_CYCLE' });
});
test('a Trade successor needs its confirmed completed catalog and ordinary no-retirement order stays unchanged', () => {
  const f = fixture(); f.sources.forEach(source => { source.kind = 'trade'; }); f.headers.forEach(header => { header.data.kind = 'trade'; });
  f.headers[2].data.catalog.complete = false;
  assert.throws(() => orderReplaySources(f.sources, { headers: f.headers }), { code: 'PG_SOURCE_REPLAY_RETIREMENT_UNCONFIRMED' });
  for (const header of f.headers) { delete header.data.retirement; header.data.status = 'applied'; }
  for (const source of f.sources) { source.strategy = 'normal-import'; source.appliedAt = source.appliedAt || at(15); source.retirement = null; }
  const expected = [...f.sources].sort((a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.sourceId.localeCompare(b.sourceId));
  assert.deepEqual(orderReplaySources(f.sources, { headers: f.headers }), expected);
  assert.deepEqual(orderReplaySources([], { headers: [] }), []);
});
test('metadata must bind every source once and a long valid chain does not use recursive stack space', () => {
  const f = fixture();
  assert.throws(() => orderReplaySources(f.sources, { headers: f.headers.slice(1) }), /PG_SOURCE_REPLAY_RETIREMENT_METADATA/);
  f.headers[0] = f.headers[1];
  assert.throws(() => orderReplaySources(f.sources, { headers: f.headers }), /PG_SOURCE_REPLAY_RETIREMENT_METADATA/);
  const sources = [], headers = [], n = 3000;
  for (let i = 0; i < n; i++) {
    const retirement = i < n - 1 ? { successorId: id('chain-' + (i + 1)), startedAt: at(15), completedAt: at(16), complete: true } : null;
    const source = { sourceId: id('chain-' + i), scopeId: 'scope', ownerId: 'actor', kind: 'bestell', strategy: i < n - 1 ? 'skip-retired-obsolete' : 'normal-import', appliedAt: retirement ? null : at(10), createdAt: at(9), orderBasis: retirement ? 'retirement-successor' : 'apply-progress', retirement,
      tables: [{ name: 'source_table', profileHash: id('profile'), deferred: null, exceptionRanges: [] }] };
    sources.push(source); headers.push({ sourceId: source.sourceId, scopeId: source.scopeId, ownerId: source.ownerId, data: { complete: true, status: i < n - 1 ? 'purged' : 'applied', kind: 'bestell', tables: source.tables,
      ...(retirement ? { retirement: { ...retirement } } : {}) } });
  }
  assert.deepEqual(orderReplaySources(sources.reverse(), { headers }).map(source => source.sourceId), headers.map(header => header.sourceId));
});
