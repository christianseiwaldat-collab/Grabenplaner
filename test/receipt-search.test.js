'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const Search = require('../lib/flexible-search'), Model = require('../lib/receipt-search');
const { registerReceiptSearchRoutes } = require('../lib/receipt-search-routes');
const UI = require('../public/receipt-search');
test('forgiving search accepts the user example, reordered terms, Unicode and bounded wildcards', () => {
  const article = 'SONY A7 IV Kit FE 24-105mm F4 G OSS';
  for (const q of ['Sony  A7\\**24  -105mm  ', 'Sony  A7\\**&#x32;4  -105mm  ', '105mm Sony A7 24', 'sony a?*105mm']) assert.equal(Search.matches(article, q), true, q);
  assert.equal(Search.matches(article, 'Sony A9 24'), false);
  assert.equal(Search.matches('Ösen für Übergrößen CAFÉ', 'osen cafe'), true);
  assert.equal(Search.matches('Preis 10%', '%'), true);
  assert.equal(Search.matches('Preis 10', '%'), false);
  assert.equal(Search.matches('abc', '*a*a*a*a*a*a*a*a*a*a*a*a*b'), false);
  assert.throws(() => Search.terms(Array(11).fill('x').join(' ')), RangeError);
});
test('receipt filters accept historical periods and reject unsafe scopes, future dates and oversized inputs', () => {
  const projection = { read: true, sellers: true, finance: true }, opts = { today: '2026-09-07', projection };
  const base = { sourceId: 'compact-cash', dateFrom: '1998-01-01', dateTo: '2026-09-07' };
  assert.equal(Model.query(base, opts).kind, 'receipts');
  for (const extra of [{ dateFrom: '2026-02-30' }, { dateTo: '2026-09-08' }, { limit: 101 }, { query: 'x'.repeat(161) }, { kind: 'raw' }, { scopeId: 'someone' }]) assert.throws(() => Model.query({ ...base, ...extra }, opts));
  assert.throws(() => Model.query({ ...base, seller: '426' }, { ...opts, projection: { ...projection, sellers: false } }), e => e.status === 403);
  assert.throws(() => Model.query({ ...base, kind: 'journal' }, { ...opts, projection: { ...projection, finance: false } }), e => e.status === 403);
  for (const columns of [[], ['date', 'date'], ['KUND_NR']]) assert.throws(() => Model.preferences({ columns }));
});
async function fixture(t) {
  const state = { session: { employeeNumber: '252', accountId: 'account-1', isEmployee: true, permissions: ['sales:analytics:access', 'sales:analytics:company:read', 'sales:history:read', 'sales:history:sellers:read'] }, reads: 0, saved: [] };
  const app = express(); app.use(express.json());
  registerReceiptSearchRoutes(app, { requireSession() { if (!state.session) throw Object.assign(Error('login'), { code: 'PORTAL_LOGIN_REQUIRED', status: 401 }); return state.session; },
    refreshSession: async () => state.session, assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'test-token') throw Object.assign(Error('csrf'), { code: 'PORTAL_CSRF_INVALID', status: 403 }); },
    preferences: { get: async () => null, upsert: async (...args) => state.saved.push(args) },
    runtime: { async run(get, work) { await get(); return work({ context: () => ({ available: true, sources: [], projection: { sellers: true } }), receipts: {
      search: async () => { state.reads++; return { items: [] }; }, documents: async input => { state.reads++; return { items: input.ids.map(id => ({ id, kind: 'receipts', date: '2026-09-04', receipt: '123', location: 'Filiale', provenance: {}, lines: [], positions: 0 })) }; },
    } }); } },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
  return { state, request: (route, body, csrf = true) => fetch(`http://127.0.0.1:${server.address().port}/api/receipt-search/${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': 'test-token' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), server };
}
test('receipt HTTP search and PDF require personal rights and CSRF; exports are private PDFs', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('search', {}, false)).status, 403); assert.equal(f.state.reads, 0);
  const pdf = await f.request('export.pdf', { ids: ['id-1'] }); assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /application\/pdf/); assert.match(pdf.headers.get('cache-control'), /private, no-store/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  f.state.session.permissions = []; assert.equal((await f.request('documents', { ids: ['id-1'] })).status, 403);
  f.state.session = null; assert.equal((await f.request('context')).status, 401);
});
test('personal column settings cannot target another employee account', async t => {
  const f = await fixture(t), url = `http://127.0.0.1:${f.server.address().port}/api/receipt-search/preferences`;
  const send = body => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' }, body: JSON.stringify(body) });
  assert.equal((await send({ columns: ['personnel', 'date', 'receipt'] })).status, 200);
  assert.equal(f.state.saved[0][0], '252');
  assert.equal((await send({ columns: ['date'], employeeNumber: 'other' })).status, 422); assert.equal(f.state.saved.length, 1);
  assert.equal((await send({ columns: ['date', 'inflow'], kind: 'daily' })).status, 403);
  f.state.session.permissions.push('sales:history:finance:read');
  assert.equal((await send({ columns: ['date', 'inflow'], kind: 'daily' })).status, 200);
  assert.equal(f.state.saved[1][1], Model.PREFERENCE_KEY + '_daily');
  assert.equal(f.state.saved[0][1], Model.PREFERENCE_KEY);
  const context = await (await f.request('context')).json();
  assert.ok(context.preferencesByKind.daily.columns.includes('inflow'));
  assert.ok(context.preferences.columns.includes('personnel'));
});
test('receipt markup escapes source text and shows an explicit information-only notice', () => {
  const row = { id: 'id', date: '2026-09-04', kind: 'receipts', receipt: '<img src=x onerror=alert(1)>', description: '<script>x</script>', location: 'Filiale', lines: [], provenance: {}, positions: 0 };
  for (const html of [UI.renderTable([row], ['date', 'receipt'], Model.COLUMNS, new Set(), { key: 'date', direction: -1 }), UI.renderDetail(row)]) assert.doesNotMatch(html, /<img|<script/);
  assert.match(UI.renderDetail(row), /Beleginformation – keine Rechnung/);
  assert.doesNotMatch(UI.renderDetail(row), /Personalnummer/);
  const prices = [-2.2, -2.02, 2.05, 2.2, 10].map((gross, i) => ({ ...row, id: String(i), gross: String(gross), receipt: String(i) }));
  const html = UI.renderTable(prices.reverse(), ['gross'], Model.COLUMNS, new Set(), { key: 'gross', direction: 1 });
  assert.deepEqual([...html.matchAll(/data-r-select="([^"]+)"/g)].map(m => m[1]), ['0', '1', '2', '3', '4']);
});

test('receipt sort preserves decimal cents beyond floating point precision and rejects unauthorized customer filters', () => {
  const a = { id: 'a', gross: '9007199254740991.02' }, b = { id: 'b', gross: '9007199254740991.01' };
  assert.equal(Model.compareRows(a, b, 'gross', 'asc'), 1);
  assert.equal(Model.compareRows({ ...a, gross: '-2.20' }, { ...b, gross: '-2.02' }, 'gross', 'asc'), -1);
  const base = { sourceId: 'compact-cash', dateFrom: '2000-01-01', dateTo: '2026-09-07' }, options = { today: '2026-09-07', projection: { read: true } };
  for (const extra of [{ customer: '419' }, { sort: 'customerName' }]) assert.throws(() => Model.query({ ...base, ...extra }, options), e => e.status === 403);
});

test('sorted result cache is encrypted, expires, and rejects a scan exceeding its bounded result count', async () => {
  const { createDataImportProtection } = require('../lib/data-import-protection');
  const { createReceiptResultStore, sortedSearch } = require('../lib/receipt-result-store');
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 2), keyId: 'test' });
  const store = createReceiptResultStore(); let now = 1000;
  const query = { sourceId: 'test', query: '', customer: '', sort: 'receipt', direction: 'asc', limit: 1, cursor: '', resultSet: '' };
  const args = { store, protection, owner: 'owner', epoch: 'epoch', now: () => now, query,
    scan: async () => ({ items: [{ id: 'one', receipt: 'SECRET' }], epoch: 'epoch', complete: true, processed: 1, next: null }) };
  try {
    const result = await sortedSearch(args);
    assert.doesNotMatch(JSON.stringify([...store.entries.values()]), /SECRET/);
    now += 16 * 60 * 1000;
    await assert.rejects(sortedSearch({ ...args, query: { ...query, resultSet: result.resultSet } }), e => e.code === 'IMPORT_HISTORY_RESULTS_CHANGED');
    await assert.rejects(sortedSearch({ ...args, scan: async () => ({ items: Array.from({ length: 10001 }, (_, i) => ({ id: String(i), receipt: 'x' })), epoch: 'epoch', complete: true, processed: 10001 }) }), e => e.code === 'IMPORT_RECEIPT_SEARCH_LIMIT');
  } finally { protection.destroy(); }
});
