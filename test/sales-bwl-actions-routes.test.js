'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), crypto = require('node:crypto');
const { registerSalesBwlActionsRoutes } = require('../lib/sales-bwl-actions-routes');
const { createSalesBwlActionsStore } = require('../lib/sales-bwl-actions-store');
const { simulationFixture } = require('../test-support/sales-bwl-simulation-fixture');
async function fixture(t) {
  const f = await simulationFixture(t); f.state.session.role = 'manager'; f.state.session.permissions.push('sales:bwl:actions:write');
  f.id = crypto.randomUUID(); f.hook = null; f.assignees = [{ employeeNumber: '101', firstName: '' }]; f.transactions = 0;
  const app = express(); app.use(express.json());
  const loadLocations = async fresh => { await fresh(); return [{ id: '18', label: 'BEISPIEL 18' }, { id: '19', label: 'BEISPIEL 19' }]; };
  const loadAssignees = async (fresh, location, tx) => { await fresh(tx); if (tx) f.transactions++; return f.assignees; };
  const store = createSalesBwlActionsStore({ access: f.app.provider, vault: f.vault, loadLocations, loadAssignees,
    loadSourceHint: (fresh, locationId, sourceHint, tx) => f.runtime.run(fresh, 'bwl-actions-source', { locationId, sourceHint }, { executor: tx }) });
  const actions = Object.fromEntries(Object.keys(store).map(op => [op, async (...args) => { const value = await store[op](...args); await f.hook?.(); return value; }]));
  registerSalesBwlActionsRoutes(app, { sessionFor: () => structuredClone(f.state.session), assertFresh: async () => structuredClone(f.state.session),
    assertCsrf(req) { if (req.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(Error('CSRF'), { status: 403, code: 'CSRF' }); },
    privateHeaders(res) { res.set('X-Test-Private', 'true'); }, loadLocations, loadAssignees, actions,
    preferences: require('../lib/sales-bwl-actions-preferences-store').createSalesBwlActionsPreferencesStore({ access: f.app.provider, vault: f.vault }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.request = async (path = '', body, method = body === undefined ? 'GET' : 'POST', csrf = 'synthetic') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/sales/bwl/actions' + path,
      { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
  }; return f;
}
test('private HTTP context and scoped actions persist through real encrypted CAS with only minimum assignee fields', async t => {
  const f = await fixture(t), context = await f.request('/context'); assert.equal(context.response.status, 200); assert.equal(context.body.available, true); assert.equal(context.body.capabilities.write, true);
  assert.equal(context.response.headers.get('cache-control'), 'private, no-store'); assert.equal(context.response.headers.get('x-test-private'), 'true');
  const people = await f.request('/assignees?locationId=18'); assert.equal(people.response.status, 200); assert.deepEqual(people.body.rows, [{ employeeNumber: '101', firstName: '' }]);
  const created = await f.request('', { id: f.id, locationId: '18', title: 'BEISPIEL Schaufenster', assigneeNumber: '101' });
  assert.equal(created.response.status, 200); assert.equal(created.body.version, 1); assert.equal(created.body.creationHash, undefined); assert.ok(f.transactions >= 2);
  const get = await f.request('/' + f.id + '?locationId=18'); assert.equal(get.body.title, 'BEISPIEL Schaufenster');
  const page = await f.request('?locationId=18&limit=1&sort=title&direction=asc'); assert.equal(page.body.total, 1); assert.equal(page.body.rows[0].id, f.id);
  assert.equal((await f.request('/' + f.id + '?locationId=19')).response.status, 404);
  const completed = await f.request('/' + f.id + '?locationId=18', { version: 1, status: 'done', note: 'BEISPIEL erledigt' }, 'PUT'); assert.equal(completed.body.version, 2); assert.ok(completed.body.completedAt);
  assert.equal((await f.request('/' + f.id + '?locationId=18', { version: 1, title: 'veraltet' }, 'PUT')).response.status, 409);
  assert.equal((await f.request('/' + f.id + '?locationId=18', { version: 2 }, 'DELETE')).response.status, 404);
});
test('HTTP inventory proof is server-read inside write transaction; financial rows and fabricated notes are refused', async t => {
  const f = await fixture(t), context = await f.simulation('context'), sourceHint = { kind: 'inventory', rowId: JSON.stringify(['0000000000042', '18']), sourceFingerprint: context.sourceFingerprint };
  const created = await f.request('', { id: f.id, locationId: '18', title: 'BEISPIEL Abverkauf', articleNumber: 'forged-label', sourceHint });
  assert.equal(created.response.status, 200); assert.equal(created.body.articleNumber, '000042'); assert.equal(created.body.source.label, 'BEISPIEL Fernglas');
  assert.doesNotMatch(JSON.stringify(created.body.source), /retailGross|averageCost|quantity/);
  for (const extra of [{ financialRows: [] }, { ownerId: 'other' }, { source: {} }, { sourceHint: { ...sourceHint, reason: 'forged' } }]) assert.equal((await f.request('', { id: crypto.randomUUID(), locationId: '18', title: 'x', ...extra })).response.status, 422);
  assert.equal((await f.request('', { id: crypto.randomUUID(), locationId: '18', title: 'x', sourceHint: { ...sourceHint, sourceFingerprint: '0'.repeat(64) } })).response.status, 409);
});
test('GET/PUT require explicit single filial and exact shapes; CSRF, role, whole-filial authority are enforced', async t => {
  const f = await fixture(t), body = { id: f.id, locationId: '18', title: 'x' };
  for (const path of ['', '?locationId=18&owner=other', '/context?owner=other', '/assignees', '/' + f.id, '/not-a-uuid?locationId=18']) assert.equal((await f.request(path)).response.status, 422);
  assert.equal((await f.request('', body, 'POST', '')).response.status, 403);
  assert.equal((await f.request('?locationId=18', body)).response.status, 422);
  f.state.session.role = 'employee'; assert.equal((await f.request('', body)).response.status, 403); assert.equal((await f.request('/assignees?locationId=18')).response.status, 403);
  f.state.session.scopes = [{ locationId: '18', departmentId: 0 }];
  assert.equal((await f.request('?locationId=18')).response.status, 200);
  f.state.session.role = 'manager'; f.state.session.permissions = f.state.session.permissions.filter(p => p !== 'sales:analytics:company:read'); f.state.session.scopes = [{ locationId: '18', departmentId: 0 }];
  assert.equal((await f.request('?locationId=19')).response.status, 403); assert.equal((await f.request('/context')).body.locations.length, 1);
  f.state.session.scopes[0].departmentId = 3; assert.equal((await f.request('/context')).response.status, 403);
});
test('late fresh-session changes withhold action output and unsafe assignee projection never escapes', async t => {
  const f = await fixture(t); f.hook = () => { f.state.session.accountId = 'changed'; };
  assert.equal((await f.request('?locationId=18')).response.status, 403);
  f.hook = null; f.assignees = [{ employeeNumber: '101', firstName: 'BEISPIEL', fullName: 'private' }];
  const people = await f.request('/assignees?locationId=18'); assert.equal(people.response.status, 422); assert.doesNotMatch(JSON.stringify(people.body), /private/);
  f.state.session.mustChangePassword = true; assert.equal((await f.request('/context')).response.status, 403);
});
test('preference routes precede UUID detail routes and enforce exact CAS, private output and CSRF independently of action writes', async t => {
  const f = await fixture(t), initial = await f.request('/preferences'); assert.equal(initial.response.status, 200); assert.equal(initial.body.version, 0);
  const input = { version: 0, preferences: { ...initial.body.preferences, columns: ['title', 'status'], columnWidths: { title: 420 } } };
  f.state.session.permissions = f.state.session.permissions.filter(p => p !== 'sales:bwl:actions:write');
  assert.equal((await f.request('/preferences', input, 'PUT', '')).response.status, 403);
  const saved = await f.request('/preferences', input, 'PUT'); assert.equal(saved.response.status, 200); assert.equal(saved.body.version, 1);
  assert.equal((await f.request('/preferences', input, 'PUT')).response.status, 409);
  assert.equal((await f.request('/preferences?locationId=18')).response.status, 422);
  assert.equal((await f.request('/preferences', { ...input, ownerId: 'other' }, 'PUT')).response.status, 422);
});
