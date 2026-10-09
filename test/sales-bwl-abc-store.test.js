'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSalesBwlAbcStore, TTL } = require('../lib/sales-bwl-abc-store');
const { createDataImportProtection } = require('../lib/data-import-protection');
const protection = () => createDataImportProtection({ encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 2), keyId: 'test', compression: true });
test('ABC cursor is single-use; completed snapshot is repeatable and all tokens are principal/purpose bound', t => {
  const p = protection(), store = createSalesBwlAbcStore(), ctx = ['owner-a'], id = store.begin(ctx); t.after(() => p.destroy());
  const cursor = store.put(p, ctx, id, 'cursor', { synthetic: true });
  assert.throws(() => store.take(p, ['owner-b'], cursor), { code: 'IMPORT_PROTECTED_PAYLOAD_INVALID' });
  assert.throws(() => store.read(p, ctx, cursor), { status: 409 });
  assert.deepEqual(store.take(p, ctx, cursor).value, { synthetic: true }); assert.throws(() => store.take(p, ctx, cursor), { status: 409 });
  const token = store.put(p, ctx, id, 'snapshot', { rows: ['safe'] });
  assert.deepEqual(store.read(p, ctx, token).value, { rows: ['safe'] }); assert.deepEqual(store.read(p, ctx, token).value, { rows: ['safe'] });
  assert.throws(() => store.take(p, ctx, token), { status: 409 });
});
test('late cancellation of a consumed cursor prevents checkpoint/result publication for the in-flight analysis', t => {
  const p = protection(), store = createSalesBwlAbcStore(), ctx = ['owner'], id = store.begin(ctx); t.after(() => p.destroy());
  const token = store.put(p, ctx, id, 'cursor', { phase: 1 }); store.take(p, ctx, token);
  assert.deepEqual(store.cancel(p, ctx, token), { cancelled: true });
  assert.throws(() => store.assertActive(id, ctx), { code: 'BWL_ABC_ANALYSIS_CANCELLED', status: 409 });
  assert.throws(() => store.put(p, ctx, id, 'snapshot', {}), { code: 'BWL_ABC_ANALYSIS_CANCELLED' });
});
test('TTL does not slide when advancing; analysis count evicts oldest results', t => {
  let now = 0; const p = protection(), store = createSalesBwlAbcStore({ now: () => now }), ctx = ['owner']; t.after(() => p.destroy());
  const id = store.begin(ctx), token = store.put(p, ctx, id, 'cursor', {}); now = TTL - 1; store.take(p, ctx, token);
  const later = store.put(p, ctx, id, 'snapshot', {}); now++; assert.throws(() => store.read(p, ctx, later), { code: 'BWL_ABC_ANALYSIS_EXPIRED' });
  const tokens = Array.from({ length: 17 }, () => store.put(p, ctx, store.begin(ctx), 'snapshot', {}));
  assert.throws(() => store.read(p, ctx, tokens[0]), { status: 409 }); assert.deepEqual(store.read(p, ctx, tokens[16]).value, {});
  store.clear(); assert.throws(() => store.read(p, ctx, tokens[16]), { status: 409 });
});
test('large state is chunked exactly and tampering is rejected', t => {
  const p = protection(), store = createSalesBwlAbcStore(), ctx = ['owner'], id = store.begin(ctx); t.after(() => p.destroy());
  const value = { text: 'ÄÖ😀 synthetic '.repeat(20000) }; const token = store.put(p, ctx, id, 'cursor', value);
  assert.ok(token.length < 1024); assert.deepEqual(store.take(p, ctx, token).value, value);
  assert.throws(() => store.take(p, ctx, token.slice(0, -4) + 'AAAA'));
  assert.throws(() => store.put(p, ctx, id, 'snapshot', { text: 'x'.repeat(65 * 1024 * 1024) }), { code: 'BWL_ABC_DATA_LIMIT', status: 413 });
});
