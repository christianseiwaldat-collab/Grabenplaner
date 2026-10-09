'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), crypto = require('node:crypto');
const { registerSalesBwlSimulationRoutes } = require('../lib/sales-bwl-simulation-routes');
const M = require('../lib/sales-bwl-simulation-model');
const { simulationFixture } = require('../test-support/sales-bwl-simulation-fixture');
async function fixture(t, { real = false } = {}) {
  const f = real ? await simulationFixture(t) : { state: { session: { id: 'session', employeeNumber: '42', accountId: 'a', isEmployee: true, active: true,
    permissions: ['sales:history:read', 'sales:analytics:access', 'sales:analytics:location:read', 'sales:analytics:inventory:read', 'sales:articles:access', 'sales:articles:read', 'sales:articles:prices:read'], scopes: [{ locationId: '18' }] } } };
  f.calls = []; f.hook = null; const app = express(); app.use(express.json());
  const mutation = async (op, fresh, ...args) => { await fresh({ synthetic: true }); f.calls.push([op, ...args]); await f.hook?.(); return { operation: op, args }; };
  registerSalesBwlSimulationRoutes(app, {
    sessionFor: () => structuredClone(f.state.session), assertFresh: async () => structuredClone(f.state.session),
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(new Error('CSRF'), { status: 403, code: 'CSRF' }); },
    privateHeaders(res) { res.set('X-Test-Private', 'true'); },
    async loadSimulation(fresh, op, input) { f.calls.push([op, input]); await fresh(); await f.hook?.(); if (real) return f.runtime.run(fresh, 'bwl-simulation-' + op, input);
      if (op === 'context') return M.unavailableContext(await fresh());
      if (op === 'snapshot') { if (input.snapshotToken !== 'server-token') throw Object.assign(Error('Changed'), { status: 409, code: 'BWL_SIMULATION_SNAPSHOT_EXPIRED' }); return { sentinel: 'SERVER_SNAPSHOT' }; }
      return { operation: op, input }; },
    variants: { list: fresh => mutation('list', fresh), get: (fresh, id) => mutation('get', fresh, id), create: (fresh, ...args) => mutation('create', fresh, ...args),
      update: (fresh, ...args) => mutation('update', fresh, ...args), remove: (fresh, ...args) => mutation('remove', fresh, ...args) },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.request = async (path, body, method = body === undefined ? 'GET' : 'POST', csrf = 'synthetic') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/sales/bwl/simulation/' + path,
      { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() };
  }; return f;
}
test('simulation routes serve a private consistent unavailable context and normalized scenario without any cash analysis', async t => {
  const f = await fixture(t), context = await f.request('context'); assert.equal(context.response.status, 200); assert.equal(context.body.available, false); assert.ok(context.body.columns.length);
  assert.equal(context.response.headers.get('cache-control'), 'private, no-store'); assert.equal(context.response.headers.get('x-test-private'), 'true');
  const calculated = await f.request('calculate', { filters: { locations: ['18'] }, assumptions: { horizonDays: 365 } }); assert.equal(calculated.response.status, 200);
  assert.equal(calculated.body.operation, 'calculate'); assert.deepEqual(calculated.body.input.filters, { query: '', assortment: 'all', locations: ['18'], stock: 'positive' });
  assert.equal(calculated.body.input.assumptions.horizonDays, 365);
});
test('variant routes use UUIDs, exact input, CAS and server-token snapshots only; rename does not recalculate', async t => {
  const f = await fixture(t), id = crypto.randomUUID(); assert.equal((await f.request('variants')).body.operation, 'list');
  assert.equal((await f.request('variants/' + id)).body.operation, 'get');
  let result = await f.request('variants', { id, name: ' BEISPIEL Variante ', snapshotToken: 'server-token' }); assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.args, [{ id, name: 'BEISPIEL Variante' }, { sentinel: 'SERVER_SNAPSHOT' }]);
  const snapshotsBefore = f.calls.filter(([op]) => op === 'snapshot').length;
  result = await f.request('variants/' + id, { version: 1, name: 'Umbenannt' }, 'PUT'); assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.args, [id, { version: 1, name: 'Umbenannt' }, null]); assert.equal(f.calls.filter(([op]) => op === 'snapshot').length, snapshotsBefore);
  result = await f.request('variants/' + id, { version: 2, name: 'Neuberechnet', snapshotToken: 'server-token' }, 'PUT'); assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.args[2], { sentinel: 'SERVER_SNAPSHOT' }); assert.equal((await f.request('variants/' + id, { version: 3 }, 'DELETE')).body.operation, 'remove');
});
test('API rejects forged finance rows, owner/filial bypass flags, missing CSRF and unsafe versions before mutation', async t => {
  const f = await fixture(t), id = crypto.randomUUID();
  const cases = [['calculate', { rows: [{ retailGross: '999' }], filters: {}, assumptions: {} }], ['calculate', { filters: { sort: 'retailGross' }, assumptions: {} }],
    ['calculate', { filters: {}, assumptions: { discountPercent: '101' } }], ['variants', { id, name: 'x', snapshotToken: 'server-token', owner: 'other' }],
    ['variants/' + id, { version: '1', name: 'x' }, 'PUT'], ['variants/' + id, { version: 1, bypass: true }, 'DELETE'], ['variants/not-a-uuid', undefined, 'GET']];
  for (const [path, body, method] of cases) assert.equal((await f.request(path, body, method)).response.status, 422);
  assert.equal((await f.request('calculate', { filters: {}, assumptions: {} }, 'POST', '')).response.status, 403);
  assert.equal((await f.request('context?owner=other')).response.status, 422); assert.equal((await f.request('variants?location=other')).response.status, 422);
  assert.equal(f.calls.length, 0);
});
test('full fresh identity changes withhold scenario and variant output, including changes after mutation', async t => {
  const f = await fixture(t); f.hook = () => { f.state.session.accountId = 'changed'; };
  assert.equal((await f.request('calculate', { filters: {}, assumptions: {} })).response.status, 403);
  f.hook = () => { f.state.session.permissions.push('changed:permission'); }; assert.equal((await f.request('variants')).response.status, 403);
  f.state.session.mustChangePassword = true; assert.equal((await f.request('context')).response.status, 403);
});
test('real HTTP calculation returns source-bound trusted snapshot and preserves separate gross/net incomplete totals', async t => {
  const f = await fixture(t, { real: true }), result = await f.request('calculate', { filters: { locations: ['18'] }, assumptions: { additionalCosts: '5' } });
  assert.equal(result.response.status, 200); assert.equal(result.body.snapshot.rows[0].articleNumber, '000042'); assert.equal(result.body.snapshot.summary.totals.scenarioResult.value, '35');
  assert.match(result.body.snapshotToken, /^gp-import-v[12]:/); const context = await f.request('context'); assert.equal(context.body.sourceFingerprint, result.body.snapshot.sourceFingerprint);
});
test('expired or wrong snapshot tokens cannot create or replace a durable variant', async t => {
  const f = await fixture(t), id = crypto.randomUUID();
  assert.equal((await f.request('variants', { id, name: 'x', snapshotToken: 'wrong' })).response.status, 409);
  assert.equal((await f.request('variants/' + id, { version: 1, name: 'x', snapshotToken: 'wrong' }, 'PUT')).response.status, 409);
  assert.equal(f.calls.some(([op]) => ['create', 'update'].includes(op)), false);
});
