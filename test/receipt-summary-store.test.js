'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createReceiptSummaryStore, readReceiptSummary, writeReceiptSummary, RECEIPT_SUMMARY_LIMITS: L } = require('../lib/receipt-summary-store');

function fixture(t) {
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 2), keyId: 'synthetic-summary', compression: true });
  t.after(() => protection.destroy());
  let time = 1000;
  const options = { store: createReceiptSummaryStore(), protection, context: ['receipt-position-summary-v1', 'personal-rights', 'verified-epoch', 'receipt-1'], now: () => time };
  return { options, advance: delta => { time += delta; } };
}

test('receipt summaries retain no plaintext and bind rights, source epoch, record and expiry', t => {
  const { options, advance } = fixture(t), value = { gross: '12.00', lineSearch: ['private-article', 'Ärmeltasche'], linePersonnel: ['person-private'] };
  writeReceiptSummary({ ...options, value });
  assert.doesNotMatch(JSON.stringify([...options.store.entries]), /private|Ärmeltasche|12\.00|receipt-1/);
  assert.deepEqual(readReceiptSummary(options), value);
  for (const index of [1, 2, 3]) {
    const context = [...options.context]; context[index] = 'changed';
    assert.equal(readReceiptSummary({ ...options, context }), null);
  }
  advance(L.TTL); assert.equal(readReceiptSummary(options), null);
  assert.equal(options.store.entries.size, 0); assert.equal(options.store.bytes, 0);
});

test('receipt summaries evict old entries within bounds and a damaged or oversized entry is rebuilt without blocking search', t => {
  const { options } = fixture(t);
  writeReceiptSummary({ ...options, value: { description: 'synthetic' } });
  const [entry] = options.store.entries.values(); entry.payload = 'damaged';
  assert.equal(readReceiptSummary(options), null); assert.equal(options.store.bytes, 0);
  writeReceiptSummary({ ...options, value: { description: 'x'.repeat(L.MAX_ENTRY_BYTES + 1) } });
  assert.equal(readReceiptSummary(options), null);
  for (let i = 0; i <= L.MAX_ENTRIES; i++) writeReceiptSummary({ ...options, context: [...options.context, i], value: { positions: i } });
  assert.equal(options.store.entries.size, L.MAX_ENTRIES);
  assert.ok(options.store.bytes <= L.MAX_BYTES);
  assert.equal(readReceiptSummary({ ...options, context: [...options.context, 0] }), null);
  assert.deepEqual(readReceiptSummary({ ...options, context: [...options.context, L.MAX_ENTRIES] }), { positions: L.MAX_ENTRIES });
  assert.equal(options.store.bytes, [...options.store.entries.values()].reduce((sum, e) => sum + e.bytes, 0));
});
