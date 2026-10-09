'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const { registerSalesBwlAbcRoutes } = require('../lib/sales-bwl-abc-routes');
const M = require('../lib/sales-bwl-abc-model');
const Pdf = require('../lib/sales-bwl-abc-pdf');
async function fixture(t, { withPdf = false } = {}) {
  const f = { session: { employeeNumber: '42', accountId: 'a', active: true,
    permissions: ['sales:analytics:access', 'sales:analytics:location:read', 'sales:history:read'], scopes: [{ locationId: 'a', departmentId: null }] }, calls: [], hook: null, renderHook: null, epoch: 1 };
  const query = { dateFrom: '2026-01-01', dateTo: '2026-10-09', locationIds: ['a'], metric: 'netRevenue', aLimit: 80, bLimit: 95 }, accumulator = M.accumulator();
  M.accumulate(accumulator, { articleNumber: '001234', description: 'SERVER-TRUSTED-ABC-ARTICLE', locationId: 'a', location: 'A', quantity: '1', metric: { status: 'sale', net: '123.00' }, margin: null });
  f.snapshot = { query, sourceAt: '2026-10-09T00:00:00.000Z', coverage: M.COVERAGE, ...M.finish(accumulator, query) };
  const app = express(); app.use(express.json());
  registerSalesBwlAbcRoutes(app, {
    sessionFor() { return structuredClone(f.session); }, async assertFresh() { return structuredClone(f.session); },
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(new Error('CSRF'), { status: 403, code: 'CSRF' }); },
    privateHeaders(res) { res.set('X-Test-Private', 'true'); },
    async loadAbc(getSession, op, input) { f.calls.push([op, input]); await getSession(); await f.hook?.();
      if (withPdf && op === 'snapshot') { if (input.exportToken !== 'server-token' || f.epoch !== 1) throw Object.assign(Error('Changed'), { code: 'IMPORT_HISTORY_ANALYSIS_CHANGED', status: 409 }); return f.snapshot; }
      return op === 'context' ? M.unavailableContext(await getSession(), '2026-10-09') : { operation: op, input }; },
    preferences: { async get(getSession) { await getSession(); await f.hook?.(); return { version: 0, preferences: M.normalizePreferences({}, M.authority(f.session).projection) }; },
      async save(getSession, body) { await getSession({ syntheticTx: true }); f.calls.push(['prefs', body]); await f.hook?.(); return { version: 1 }; } },
    ...(withPdf ? { pdf: { ...Pdf, async render(input) { const result = await Pdf.render(input); await f.renderHook?.(); return result; } } } : {}),
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.request = async (path, body, method = body === undefined ? 'GET' : 'POST', csrf = 'synthetic') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/sales/bwl/' + path,
      { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.headers.get('content-type')?.startsWith('application/pdf') ? { response, buffer: Buffer.from(await response.arrayBuffer()) } : { response, body: await response.json() };
  }; return f;
}
test('ABC routes expose private consistent context, bounded operations and independent personal preferences', async t => {
  const f = await fixture(t), context = await f.request('abc/context'); assert.equal(context.response.status, 200);
  assert.equal(context.body.available, false); assert.ok(context.body.columns.length); assert.equal(context.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(context.response.headers.get('x-test-private'), 'true');
  const query = { dateFrom: '2026-01-01', dateTo: '2026-10-09', locationIds: ['a'] };
  assert.equal((await f.request('abc/step', { query, cursor: 'cursor' })).body.operation, 'step');
  assert.equal((await f.request('abc/snapshot', { exportToken: 'snapshot' })).body.operation, 'snapshot');
  assert.equal((await f.request('abc/cancel', { cursor: 'cursor' })).body.operation, 'cancel');
  assert.equal((await f.request('preferences/abc')).body.version, 0);
  assert.equal((await f.request('preferences/abc', { version: 0, preferences: {} }, 'PUT')).body.version, 1);
});
test('ABC routes require CSRF for writes and reject source/body flags or GET selectors', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('abc/step', { query: {} }, 'POST', '')).response.status, 403);
  for (const [path, body] of [['abc/step', { query: {}, bypass: true }], ['abc/snapshot', { exportToken: 'x', rows: [] }], ['abc/cancel', { cursor: '' }]]) assert.equal((await f.request(path, body)).response.status, 422);
  assert.equal((await f.request('abc/context?owner=other')).response.status, 422); assert.equal((await f.request('preferences/abc?key=other')).response.status, 422);
  assert.equal(f.calls.length, 0);
});
test('ABC routes use refreshed session returns and withhold output after any full identity mutation', async t => {
  const f = await fixture(t); f.hook = () => { f.session.permissions.push('changed:grant'); };
  assert.equal((await f.request('abc/step', { query: {} })).response.status, 403);
  f.hook = () => { f.session.accountId = 'other-account'; };
  assert.equal((await f.request('preferences/abc', { version: 0, preferences: {} }, 'PUT')).response.status, 403);
  f.session.active = false; assert.equal((await f.request('abc/context')).response.status, 403);
});
test('ABC PDF routes render only the server token snapshot with true pages/rows and inline or attachment headers', async t => {
  const f = await fixture(t, { withPdf: true }), body = { exportToken: 'server-token', title: 'Meine ABC-Auswertung', name: 'Übersicht Filiale', orientation: 'portrait', columns: ['articleNumber', 'description', 'netRevenue'], sort: 'rank', direction: 'asc' };
  for (const suffix of ['pdf-preview', 'pdf']) {
    const result = await f.request('abc/' + suffix, body); assert.equal(result.response.status, 200); assert.equal(result.buffer.subarray(0, 4).toString(), '%PDF');
    assert.equal(result.response.headers.get('x-report-rows'), '1'); assert.equal(result.response.headers.get('x-pdf-pages'), '1');
    assert.match(result.response.headers.get('content-disposition'), new RegExp(suffix === 'pdf-preview' ? '^inline' : '^attachment'));
    assert.match(result.response.headers.get('content-disposition'), /filename\*=UTF-8''%C3%9Cbersicht%20Filiale\.pdf/);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'), task = getDocument({ data: new Uint8Array(result.buffer), isEvalSupported: false }), pdf = await task.promise;
    const content = await (await pdf.getPage(1)).getTextContent(); assert.match(content.items.map(i => i.str).join(' '), /SERVER-TRUSTED-ABC-ARTICLE/); await task.destroy();
  }
  assert.equal(f.calls.filter(([op]) => op === 'snapshot').length, 4, 'each export verifies the epoch before and after rendering');
});
test('ABC PDF rejects client rows and denied columns before loading, enforces CSRF and pinned tokens', async t => {
  const f = await fixture(t, { withPdf: true }), body = { exportToken: 'server-token' };
  assert.equal((await f.request('abc/pdf', body, 'POST', '')).response.status, 403);
  for (const change of [{ rows: [] }, { columns: ['grossMargin'] }, { sort: 'grossMargin' }, { title: 'a\nHidden' }, { orientation: 'A3' }]) assert.ok([403, 422].includes((await f.request('abc/pdf-preview', { ...body, ...change })).response.status));
  assert.equal(f.calls.length, 0); assert.equal((await f.request('abc/pdf', { exportToken: 'wrong-token' })).response.status, 409);
});
test('ABC PDF output is withheld when rights or source epoch change during asynchronous rendering', async t => {
  const f = await fixture(t, { withPdf: true }), body = { exportToken: 'server-token' };
  f.renderHook = () => { f.session.permissions.push('changed:grant'); };
  const revoked = await f.request('abc/pdf', body); assert.equal(revoked.response.status, 403); assert.equal(revoked.buffer, undefined);
  f.renderHook = () => { f.epoch++; }; const changed = await f.request('abc/pdf-preview', body);
  assert.equal(changed.response.status, 409); assert.equal(changed.body.code, 'IMPORT_HISTORY_ANALYSIS_CHANGED'); assert.equal(changed.buffer, undefined);
});
