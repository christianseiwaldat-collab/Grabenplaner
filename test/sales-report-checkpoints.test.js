'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createSalesReportCheckpointStore } = require('../lib/sales-report-checkpoints');
const { createDataImportProtection } = require('../lib/data-import-protection');
const Model = require('../lib/sales-report-model');
const protection = () => createDataImportProtection({ encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 2), keyId: 'test', compression: true });
test('large report checkpoints retain exact totals and distinct receipt counts beyond the single-payload limit', () => {
  const p = protection(), store = createSalesReportCheckpointStore(), state = Model.accumulator();
  const q = { productGroupIds: [], manufacturerIds: [], sellerIds: [], groupBy: ['manufacturer'], metrics: ['netRevenue','receiptCount','customerCount'] };
  for (let i = 0; i < 10000; i++) Model.accumulate(state, 'current', q, {
    metric: { status: 'included', gross: '12.00', net: '10.00' }, margin: '2.00', quantity: '1',
    receiptKey: crypto.createHash('sha256').update(String(i)).digest('hex'), customerKey: null,
    manufacturer: { id: String(i % 3), label: 'ÄÖ 📷 Synthetic ' + (i % 3) },
  });
  assert.throws(() => p.seal(state, ['report']), e => e.code === 'IMPORT_PROTECTED_PAYLOAD_TOO_LARGE');
  const cursor = store.put(p, ['report'], state); assert.ok(cursor.length < 1024);
  const restored = store.take(p, ['report'], cursor);
  assert.deepEqual(Model.finishReport(restored, q), Model.finishReport(state, q));
  assert.equal(Model.finishReport(restored, q).total.metrics.receiptCount.current, '10000');
  assert.throws(() => store.take(p, ['report'], cursor), e => e.code === 'IMPORT_HISTORY_ANALYSIS_EXPIRED');
  p.destroy();
});
test('checkpoint tokens are authenticated, principal-bound, expiring and bounded in number', () => {
  let now = 0; const p = protection(), store = createSalesReportCheckpointStore({ now: () => now });
  const first = store.put(p, ['owner-a'], { private: 'synthetic' });
  assert.throws(() => store.take(p, ['owner-b'], first), e => e.code === 'IMPORT_PROTECTED_PAYLOAD_INVALID');
  assert.deepEqual(store.take(p, ['owner-a'], first), { private: 'synthetic' });
  const expired = store.put(p, ['owner-a'], { i: 1 }); now += 15 * 60 * 1000;
  assert.throws(() => store.take(p, ['owner-a'], expired), e => e.code === 'IMPORT_HISTORY_ANALYSIS_EXPIRED');
  const cursors = Array.from({ length: 17 }, (_, i) => store.put(p, ['owner-a'], { i }));
  assert.throws(() => store.take(p, ['owner-a'], cursors[0]), e => e.code === 'IMPORT_HISTORY_ANALYSIS_EXPIRED');
  assert.deepEqual(store.take(p, ['owner-a'], cursors[16]), { i: 16 });
  store.clear(); p.destroy();
});
