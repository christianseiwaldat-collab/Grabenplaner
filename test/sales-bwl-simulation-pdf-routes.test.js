'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const M = require('../lib/sales-bwl-simulation-model'), Pdf = require('../lib/sales-bwl-simulation-pdf');
const { registerSalesBwlSimulationRoutes } = require('../lib/sales-bwl-simulation-routes');
const mainId = '76f78930-1cef-4b23-8c52-4c417da6ba46', otherId = 'bc3e6d97-3e17-4bfa-899f-b72a4824d9ca';
function snapshot() { const caps = { read: true, prices: true, costs: true, margin: true }; return M.calculate([{ id: 'row', articleNumber: 'BEISPIEL-000042', description: 'BEISPIEL Fernglas',
  assortment: 'Abverkauf', location: 'BEISPIEL Filiale', locationId: '18', quantity: '4', eligible: true, status: 'Vollständig', retailGross: '120', retailNet: '100', averageCost: '70' }],
  M.normalize({ filters: { locations: ['18'] }, assumptions: {} }, caps), caps, { sourceAt: '2026-10-08T12:00:00.000Z', generatedAt: '2026-10-09T12:00:00.000Z', sourceFingerprint: 'old-source-fingerprint' }); }
async function fixture(t) {
  const f = { calls: [], epoch: 1, renderHook: null, session: { id: 'session', employeeNumber: '42', accountId: 'account', active: true, isEmployee: true,
    permissions: ['sales:history:read', 'sales:analytics:access', 'sales:analytics:location:read', 'sales:analytics:inventory:read', 'sales:analytics:margin:read',
      'sales:articles:access', 'sales:articles:read', 'sales:articles:prices:read', 'sales:articles:costs:read'], scopes: [{ locationId: '18' }] },
  variants: new Map([[mainId, { id: mainId, name: 'BEISPIEL Hauptvariante', version: 2, snapshot: snapshot() }], [otherId, { id: otherId, name: 'BEISPIEL Vergleich', version: 3, snapshot: snapshot() }]]) };
  const app = express(); app.use(express.json());
  registerSalesBwlSimulationRoutes(app, {
    sessionFor: () => structuredClone(f.session), assertFresh: async () => structuredClone(f.session),
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(Error('CSRF'), { code: 'CSRF', status: 403 }); },
    privateHeaders(res) { res.set('X-Test-Private', 'yes'); },
    async loadSimulation(fresh, op, input) { f.calls.push([op, input]); await fresh(); if (op !== 'snapshot') return M.unavailableContext(await fresh());
      if (input.snapshotToken !== 'current-server-token' || f.epoch !== 1) throw Object.assign(Error('Stale'), { code: 'BWL_SIMULATION_SNAPSHOT_EXPIRED', status: 409 }); return snapshot(); },
    variants: { async get(fresh, id) { f.calls.push(['get', id]); await fresh(); const record = f.variants.get(id); if (!record) throw Object.assign(Error('Missing'), { code: 'BWL_SIMULATION_VARIANT_MISSING', status: 404 });
      return { ...structuredClone(record), snapshot: M.filterHistorical(record.snapshot, M.authority(await fresh())), historical: true }; } },
    preferences: { async read(fresh) { await fresh({ synthetic: true }); f.calls.push(['preferences-read']); return { version: 0, preferences: M.normalizePreferences({}, M.authority(await fresh()).caps) }; },
      async write(fresh, body) { await fresh({ synthetic: true }); f.calls.push(['preferences-write', body]); return body; } },
    pdf: { normalize: Pdf.normalize, async render(input) { f.calls.push(['render', { variant: input.variant?.name, comparison: input.comparison?.name }]); const result = await Pdf.render(input); await f.renderHook?.(); return result; } },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.request = async (path, body, method = body === undefined ? 'GET' : 'POST', csrf = 'synthetic') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/sales/bwl/simulation/' + path,
      { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: response.headers.get('content-type')?.startsWith('application/pdf') ? Buffer.from(await response.arrayBuffer()) : await response.json() };
  }; return f;
}
test('simulation PDF routes render trusted live snapshots, actual pages, private preview and download headers', async t => {
  const f = await fixture(t), input = { snapshotToken: 'current-server-token', columns: ['articleNumber', 'description', 'scenarioNetRevenue'], name: 'BEISPIEL - Ferngläser', orientation: 'portrait' };
  const preview = await f.request('pdf-preview', input); assert.equal(preview.response.status, 200); assert.equal(preview.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal(preview.response.headers.get('x-pdf-pages'), '2'); assert.equal(preview.response.headers.get('x-report-rows'), '1'); assert.match(preview.response.headers.get('content-disposition'), /^inline/);
  assert.match(preview.response.headers.get('content-disposition'), /Ferngl%C3%A4ser.pdf/); assert.equal(preview.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(preview.response.headers.get('x-test-private'), 'yes'); assert.match(preview.response.headers.get('content-security-policy'), /sandbox/);
  assert.equal(f.calls.filter(([op]) => op === 'snapshot').length, 2); const download = await f.request('pdf', input);
  assert.equal(download.response.status, 200); assert.match(download.response.headers.get('content-disposition'), /^attachment/);
});
test('historical main and comparison variants export pinned versions without refreshing the current source', async t => {
  const f = await fixture(t); f.epoch = 99;
  const result = await f.request('pdf', { variantId: mainId, version: 2, comparisonVariantId: otherId, comparisonVersion: 3, columns: ['articleNumber', 'scenarioNetRevenue'] });
  assert.equal(result.response.status, 200); assert.equal(f.calls.filter(([op]) => op === 'snapshot').length, 0);
  assert.equal(f.calls.filter(([op, id]) => op === 'get' && id === mainId).length, 2); assert.equal(f.calls.filter(([op, id]) => op === 'get' && id === otherId).length, 2);
  assert.deepEqual(f.calls.find(([op]) => op === 'render')[1], { variant: 'BEISPIEL Hauptvariante', comparison: 'BEISPIEL Vergleich' });
  assert.equal((await f.request('pdf', { variantId: mainId, version: 1 })).response.status, 409);
});
test('PDF routes reject client financial rows, foreign selectors, missing CSRF and unavailable historical grants before rendering', async t => {
  const f = await fixture(t), input = { snapshotToken: 'current-server-token' };
  for (const body of [{ ...input, rows: [] }, { ...input, ownerId: 'other' }, { ...input, snapshot: snapshot() }, { ...input, variantId: mainId, version: 2 },
    { ...input, columns: M.COLUMNS.slice(0, 9).map(c => c.id) }, { variantId: 'bad', version: 1 }, { variantId: mainId, version: '2' }, { ...input, comparisonVariantId: otherId }]) {
    assert.equal((await f.request('pdf-preview', body)).response.status, 422);
  }
  assert.equal((await f.request('pdf-preview', input, 'POST', '')).response.status, 403);
  assert.equal((await f.request('pdf?owner=other', input)).response.status, 422); assert.equal(f.calls.some(([op]) => op === 'render'), false);
  f.variants.get(mainId).snapshot.capabilities = { read: true, prices: true, costs: false, margin: false };
  assert.equal((await f.request('pdf', { variantId: mainId, version: 2, columns: ['scenarioGrossMargin'] })).response.status, 403);
});
test('asynchronous rendering rechecks fresh identity, live epoch and both historical versions before returning bytes', async t => {
  const f = await fixture(t); f.renderHook = () => { f.epoch = 2; };
  assert.equal((await f.request('pdf-preview', { snapshotToken: 'current-server-token' })).response.status, 409);
  f.renderHook = () => { f.variants.get(mainId).version++; };
  assert.equal((await f.request('pdf-preview', { variantId: mainId, version: 2 })).response.status, 409);
  f.renderHook = () => { f.variants.get(otherId).version++; };
  assert.equal((await f.request('pdf-preview', { variantId: mainId, version: 3, comparisonVariantId: otherId, comparisonVersion: 3 })).response.status, 409);
  f.renderHook = () => { f.session.accountId = 'changed'; };
  assert.equal((await f.request('pdf-preview', { variantId: mainId, version: 3 })).response.status, 403);
});
test('simulation preferences use transaction-aware fresh sessions and exact query shape; unavailable context has usable defaults', async t => {
  const f = await fixture(t), get = await f.request('preferences'); assert.equal(get.response.status, 200); assert.equal(get.body.version, 0);
  assert.ok(get.body.preferences.columns.includes('articleNumber'));
  const input = { version: 0, preferences: { columns: ['articleNumber', 'description'], columnWidths: { description: 300 }, sort: 'description', direction: 'asc' } };
  const put = await f.request('preferences', input, 'PUT'); assert.deepEqual(put.body, input);
  assert.equal((await f.request('preferences?owner=other')).response.status, 422);
  assert.equal((await f.request('preferences', input, 'PUT', '')).response.status, 403);
  const context = await f.request('context'); assert.deepEqual(context.body.defaultColumns, M.normalizePreferences({}, M.authority(f.session).caps).columns);
});
