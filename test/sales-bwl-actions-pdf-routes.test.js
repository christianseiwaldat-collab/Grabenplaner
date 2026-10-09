'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), crypto = require('node:crypto');
const M = require('../lib/sales-bwl-actions-model'), Pdf = require('../lib/sales-bwl-actions-pdf');
const { registerSalesBwlActionsRoutes } = require('../lib/sales-bwl-actions-routes');
async function fixture(t, count = 1) {
  const f = { session: { employeeNumber: '42', accountId: 'synthetic-account', role: 'manager', scopes: [{ locationId: '18', departmentId: 0 }],
    permissions: ['sales:history:read', 'sales:analytics:access', 'sales:analytics:location:read', 'sales:analytics:inventory:read', 'sales:articles:access', 'sales:articles:read'] },
    location: { id: '18', label: 'BEISPIEL Filiale' }, listCalls: [], renders: 0, listHook: null, renderHook: null };
  f.rows = Array.from({ length: count }, (_, i) => ({ id: crypto.randomUUID(), locationId: '18', title: 'SERVER-MEASURE-' + i,
    articleNumber: 'ACT-' + String(i).padStart(5, '0'), priority: 'normal', status: 'open', note: 'SERVER-TRUSTED-NOTE', source: null, assigneeNumber: '101',
    dueDate: '2026-10-31', version: 1, updatedAt: '2026-10-09T12:00:00.000Z', createdAt: '2026-10-08T12:00:00.000Z', createdBy: '42', updatedBy: '42', completedAt: null }));
  const app = express(); app.use(express.json());
  registerSalesBwlActionsRoutes(app, { sessionFor: () => structuredClone(f.session), assertFresh: async () => structuredClone(f.session),
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(Error('CSRF'), { status: 403, code: 'CSRF' }); },
    privateHeaders(res) { res.set('X-Test-Private', 'true'); }, loadLocations: async fresh => { await fresh(); return [structuredClone(f.location)]; }, loadAssignees: async () => [],
    actions: { async list(fresh, input) { await fresh(); f.listCalls.push(structuredClone(input));
      const rows = structuredClone(f.rows.slice(input.offset, input.offset + input.limit)), value = { rows, total: f.rows.length, hasMore: input.offset + rows.length < f.rows.length };
      await f.listHook?.(f.listCalls.length, value); return value; } },
    pdf: { ...Pdf, async render(input) { f.renders++; const result = await Pdf.render(input); await f.renderHook?.(); return result; } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.request = async (suffix, body = { query: { locationId: '18' } }, csrf = 'synthetic') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/sales/bwl/actions/' + suffix,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    return response.headers.get('content-type')?.startsWith('application/pdf') ? { response, buffer: Buffer.from(await response.arrayBuffer()) } : { response, body: await response.json() };
  }; return f;
}
test('actions PDF routes export all 500 server records through bounded 200 paging, fresh result proof and private real page headers', async t => {
  const f = await fixture(t, 500), input = { query: { locationId: '18', status: 'open', query: 'SERVER', sort: 'articleNumber', direction: 'asc' },
    columns: ['articleNumber', 'title', 'status'], title: 'BEISPIEL Maßnahmenliste', name: 'Übersicht Filiale', orientation: 'landscape' };
  for (const suffix of ['pdf-preview', 'pdf']) {
    f.listCalls = []; const result = await f.request(suffix, input); assert.equal(result.response.status, 200); assert.equal(result.buffer.subarray(0, 4).toString(), '%PDF');
    assert.equal(result.response.headers.get('x-report-rows'), '500'); assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.response.headers.get('x-test-private'), 'true'); assert.match(result.response.headers.get('content-disposition'), suffix === 'pdf' ? /^attachment/ : /^inline/);
    assert.match(result.response.headers.get('content-disposition'), /%C3%9Cbersicht/); assert.match(result.response.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(f.listCalls.map(c => c.offset), [0, 200, 400, 0, 200, 400, 0, 200, 400]);
    assert.ok(f.listCalls.every(c => c.limit === 200 && c.status === 'open' && c.query === 'SERVER' && c.sort === 'articleNumber' && c.direction === 'asc'));
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'), task = getDocument({ data: new Uint8Array(result.buffer), isEvalSupported: false });
    const pdf = await task.promise; try { assert.equal(Number(result.response.headers.get('x-pdf-pages')), pdf.numPages); let markers = [];
      for (let n = 1; n <= pdf.numPages; n++) markers.push(...(await (await pdf.getPage(n)).getTextContent()).items.filter(i => /^ACT-\d{5}$/.test(i.str)).map(i => i.str));
      assert.equal(markers.length, 500); assert.equal(markers.at(-1), 'ACT-00499');
    } finally { await task.destroy(); }
  }
  assert.equal(f.renders, 2); assert.equal(M.authority(f.session).caps.write, false, 'export only needs existing read rights');
});
test('actions PDF rejects HTTP client rows, broad queries, unauthorized filial, invalid options and missing CSRF before render', async t => {
  const f = await fixture(t), body = { query: { locationId: '18' } };
  for (const extra of [{ rows: [] }, { snapshot: {} }, { ownerId: 'other' }, { query: { locationId: '18', limit: 200 } }, { query: { locationId: '18', offset: 200 } },
    { columns: ['sourceFingerprint'] }, { columns: [] }, { orientation: 'A3' }]) assert.equal((await f.request('pdf', { ...body, ...extra })).response.status, 422);
  assert.equal((await f.request('pdf?locationId=18', body)).response.status, 422);
  assert.equal((await f.request('pdf', body, '')).response.status, 403);
  assert.equal((await f.request('pdf', { query: { locationId: '19' } })).response.status, 403); assert.equal(f.renders, 0);
});
test('complete version and content proof withholds changed PDF before rendering or after any financial-free record mutation', async t => {
  const f = await fixture(t); f.listHook = (call) => { if (call === 1) f.rows[0].note = 'Changed before rendering'; };
  const before = await f.request('pdf'); assert.equal(before.response.status, 409); assert.equal(before.buffer, undefined); assert.equal(f.renders, 0);
  f.listHook = null;
  for (const mutation of [() => f.rows[0].version++, () => f.rows[0].note += ' modified', () => f.rows[0].title += ' modified', () => f.rows[0].assigneeNumber = '102',
    () => f.location.label += ' renamed', () => f.rows[0].source = { kind: 'abc', rowId: 'synthetic', articleNumber: '000042', label: 'BEISPIEL source',
      reason: 'ABC-Klasse A prüfen.', sourceAt: '2026-10-08T12:00:00.000Z', sourceFingerprint: 'a'.repeat(64) }]) {
    f.renderHook = mutation; const after = await f.request('pdf-preview'); assert.equal(after.response.status, 409); assert.equal(after.buffer, undefined);
    assert.match(after.response.headers.get('content-type'), /application\/json/); assert.equal(after.response.headers.get('x-pdf-pages'), null);
  }
});
test('pagination integrity failures and late full authority changes never emit a PDF', async t => {
  const f = await fixture(t, 201);
  for (const mutate of [v => { v.total = 202; }, v => { v.hasMore = false; }, v => { v.rows.pop(); }, v => { v.rows[0].locationId = '19'; }]) {
    f.listHook = (_, value) => mutate(value); const result = await f.request('pdf'); assert.ok([403, 409].includes(result.response.status)); assert.equal(result.buffer, undefined);
  }
  f.listHook = null; f.rows = f.rows.slice(0, 1); f.renderHook = () => { f.session.accountId = 'changed'; };
  assert.equal((await f.request('pdf')).response.status, 403);
  f.renderHook = null; f.session.mustChangePassword = true; assert.equal((await f.request('pdf')).response.status, 403);
});
