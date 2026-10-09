'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSalesBwlAbcWorkspace } = require('../lib/persistence/repositories/sales-bwl-abc-workspace');
const { createSalesBwlAbcStore, TTL } = require('../lib/sales-bwl-abc-store');
const { createDataImportProtection } = require('../lib/data-import-protection');
function fixture(t, { count = 201 } = {}) {
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 2), keyId: 'test', compression: true });
  t.after(() => protection.destroy());
  const f = { session: { employeeNumber: '42', accountId: '42-a', active: true, permissions: ['sales:analytics:access', 'sales:analytics:location:read', 'sales:history:read', 'sales:analytics:margin:read'], scopes: [{ locationId: 'a', departmentId: null }] },
    epoch: 1, now: 0, calls: [], options: [], hook: null };
  const records = Array.from({ length: count }, (_, index) => ({ id: 'line-' + String(count - index).padStart(6, '0'), businessDate: '2026-10-01' }));
  const tx = { syntheticTransaction: true };
  const access = { async transaction(work, options) { f.options.push(options); return work(tx); } };
  const backend = { source: { scopeId: 'test', locations: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    async epoch() { return [f.epoch]; },
    async search(_, q) { f.calls.push(q); assert.equal(q.limit, 201); assert.equal(q.locationId, 'a');
      return records.filter(r => r.businessDate < q.afterDate || r.businessDate === q.afterDate && r.id < q.afterId).slice(0, q.limit); },
    service(_, allow) {
      const base = { source: 'cash', sourceInstance: 'tradefoto-cash', sourceTable: 'Umsatz_Kasse_Details' };
      assert.equal(allow({ ...base, action: 'history.scope', locations: [{ role: 'location.filialid', targetId: 'a', status: 'linked' }] }), true);
      assert.equal(allow({ ...base, action: 'history.scope', locations: [{ role: 'location.filialid', targetId: 'b', status: 'linked' }] }), false);
      assert.equal(allow({ ...base, action: 'history.fields', dataClasses: ['personnel_restricted'] }), false);
      assert.equal(allow({ ...base, action: 'history.reference', targetKind: 'crm_customer' }), false);
      return { async detail(id) {
        await f.hook?.(id);
        return id === 'head' ? { fields: { KUND_NR: 'private-customer' } } : { table: 'Umsatz_Kasse_Details',
          provenance: { businessDate: '2026-10-01', parentId: 'head' }, fields: { RepID: id, EAN: '00042', Artikelbezeichnung: 'BEISPIEL Kamera', VKMenge: '1', RohertragDM: '2.015', Filialid: '018' },
          references: [{ role: 'location.filialid', targetId: 'a', status: 'linked' }] }; },
        async receipt() { return { canAggregate: true, positions: records.map(r => ({ key: r.id, status: 'sale', net: '10.00' })), issues: [] }; } };
    } };
  f.store = createSalesBwlAbcStore({ now: () => f.now });
  f.workspace = createSalesBwlAbcWorkspace({ access, protection, backend, scopeId: 'test', today: () => '2026-10-09',
    marginPolicy: { field: 'RohertragDM', quantityField: 'VKMenge' }, sourceAt: '2026-10-08T00:00:00.000Z',
    getSession: async () => f.session, store: f.store });
  f.query = { dateFrom: '2026-10-01', dateTo: '2026-10-09', locationIds: ['a'], metric: 'netRevenue' };
  return f;
}
test('ABC scans exactly one current period in bounded read-only batches and exports a pinned server snapshot', async t => {
  const f = fixture(t), context = await f.workspace.metadata(); assert.deepEqual(context.locations, [{ id: 'a', label: 'A' }]);
  assert.deepEqual(context.metrics.map(m => m.id), ['netRevenue', 'grossMargin']);
  const first = await f.workspace.step(f.query); assert.equal(first.analysis.processed, 200); assert.equal(first.snapshot, null); assert.ok(first.analysis.cursor);
  const last = await f.workspace.step(f.query, first.analysis.cursor); assert.equal(last.analysis.complete, true); assert.equal(last.analysis.processed, 201);
  assert.equal(last.snapshot.rows[0].quantity, '201.000000'); assert.equal(last.snapshot.rows[0].netRevenue, '2010.00'); assert.equal(last.snapshot.rows[0].grossMargin, '406.02');
  assert.equal(last.snapshot.rows[0].class, 'A'); assert.equal(last.snapshot.coverage.periodCompleteness, 'not-established');
  assert.equal(last.snapshot.sourceAt, context.sourceAt); assert.equal(f.calls.length, 2); assert.ok(f.calls.every(c => c.dateFrom === f.query.dateFrom));
  assert.ok(f.options.every(o => o.isolation === 'serializable' && o.readOnly));
  assert.deepEqual(await f.workspace.snapshot(last.exportToken), last.snapshot); assert.deepEqual(await f.workspace.snapshot(last.exportToken), last.snapshot);
  assert.ok(!JSON.stringify(last.snapshot).includes('private-customer'));
  await assert.rejects(f.workspace.step(f.query, first.analysis.cursor), { code: 'BWL_ABC_ANALYSIS_EXPIRED' });
});
test('ABC continuation binds exact query, whole rights/account identity and current source epoch', async t => {
  const f = fixture(t), start = await f.workspace.step(f.query);
  await assert.rejects(f.workspace.step({ ...f.query, aLimit: 70 }, start.analysis.cursor), { status: 403 });
  const next = await f.workspace.step(f.query); f.epoch++;
  await assert.rejects(f.workspace.step(f.query, next.analysis.cursor), { code: 'IMPORT_HISTORY_ANALYSIS_CHANGED', status: 409 });
  const other = await f.workspace.step(f.query); f.session.accountId = 'other-account';
  await assert.rejects(f.workspace.step(f.query, other.analysis.cursor));
  await assert.rejects(f.workspace.normalize({ ...f.query, locationIds: ['b'] }), { status: 403 });
});
test('ABC export snapshot expires, loses source validity and cannot outlive permission changes', async t => {
  const f = fixture(t, { count: 1 }), result = await f.workspace.step(f.query);
  f.epoch++; await assert.rejects(f.workspace.snapshot(result.exportToken), { code: 'IMPORT_HISTORY_ANALYSIS_CHANGED' });
  f.epoch--; f.now = TTL; await assert.rejects(f.workspace.snapshot(result.exportToken), { code: 'BWL_ABC_ANALYSIS_EXPIRED' });
  f.now = 0; const fresh = await f.workspace.step(f.query); f.session.permissions.push('unrelated:new-right');
  await assert.rejects(f.workspace.snapshot(fresh.exportToken));
  f.session.permissions = []; await assert.rejects(f.workspace.metadata(), { status: 403 });
});
test('ABC checks fresh authority inside the transaction and after detail reads', async t => {
  const f = fixture(t, { count: 1 });
  f.hook = async id => { if (id.startsWith('line-')) f.session.permissions.push('unrelated:changed-mid-read'); };
  await assert.rejects(f.workspace.step(f.query), { status: 403 });
});
test('late cancel wins after a cursor is consumed while the next batch is in flight', async t => {
  const f = fixture(t), first = await f.workspace.step(f.query); let release, entered;
  const wait = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.hook = async id => { if (id.startsWith('line-')) { entered(); await wait; } };
  const running = f.workspace.step(f.query, first.analysis.cursor); await started;
  assert.deepEqual(await f.workspace.cancel(first.analysis.cursor), { cancelled: true }); release();
  await assert.rejects(running, { code: 'BWL_ABC_ANALYSIS_CANCELLED', status: 409 });
});
