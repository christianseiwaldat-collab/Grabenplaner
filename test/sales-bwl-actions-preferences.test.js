'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { simulationFixture } = require('../test-support/sales-bwl-simulation-fixture');
const { createSalesBwlActionsPreferencesStore: create } = require('../lib/sales-bwl-actions-preferences-store');
async function setup(t) { const f = await simulationFixture(t); f.state.session.role = 'manager'; f.state.session.permissions.push('sales:bwl:actions:write');
  return { ...f, store: create({ access: f.app.provider, vault: f.vault }), fresh: async () => f.state.session }; }
test('personal action columns, order, widths and sort persist encrypted and account-scoped through CAS', async t => {
  const f = await setup(t), initial = await f.store.read(f.fresh); assert.equal(initial.version, 0);
  const preferences = { columns: ['status', 'title', 'note'], columnWidths: { title: 410 }, sort: 'priority', direction: 'asc' };
  const saved = await f.store.write(f.fresh, { version: 0, preferences }); assert.deepEqual(saved, { version: 1, preferences });
  assert.deepEqual(await create({ access: f.app.provider, vault: f.vault }).read(f.fresh), saved);
  await assert.rejects(f.store.write(f.fresh, { version: 0, preferences }), { status: 409 });
  assert.equal((await f.store.read(async () => ({ ...f.state.session, accountId: 'other' }))).version, 0);
  const row = f.app.database.prepare("SELECT payload FROM trade_annotations WHERE kind='sales-bwl-actions-preferences'").get(); assert.doesNotMatch(row.payload, /columnWidths|status|priority/);
  assert.deepEqual(JSON.parse(f.app.database.prepare("SELECT detail FROM audit_log WHERE action='trade.sales-bwl-actions-preferences.update'").get().detail), { revision: 1 });
});
test('early caller mutation is copied before await; late account withdrawal rolls back preference plus audit', async t => {
  const f = await setup(t), input = await f.store.read(f.fresh); input.preferences.direction = 'asc';
  const saved = await f.store.write(async () => { input.version = 20; input.preferences.direction = 'desc'; return f.state.session; }, input); assert.equal(saved.version, 1); assert.equal(saved.preferences.direction, 'asc');
  let checks = 0; await assert.rejects(f.store.write(async tx => tx && ++checks === 3 ? { ...f.state.session, accountId: 'changed' } : f.state.session,
    { version: 1, preferences: { ...saved.preferences, direction: 'desc' } }), { status: 403 });
  assert.equal((await f.store.read(f.fresh)).version, 1); assert.equal(f.app.database.prepare("SELECT count(*) AS n FROM audit_log WHERE action='trade.sales-bwl-actions-preferences.update'").get().n, 1);
});
test('table preferences need action read rights and never confer organizational write rights', async t => {
  const f = await setup(t), initial = await f.store.read(f.fresh);
  f.state.session.permissions = f.state.session.permissions.filter(p => p !== 'sales:bwl:actions:write');
  assert.deepEqual(await f.store.write(f.fresh, initial), { version: 1, preferences: initial.preferences });
  f.state.session.permissions = f.state.session.permissions.filter(p => p !== 'sales:analytics:inventory:read');
  await assert.rejects(f.store.read(f.fresh), { status: 403 }); await assert.rejects(f.store.write(f.fresh, { version: 1, preferences: initial.preferences }), { status: 403 });
});
test('unknown or empty/duplicate columns and unsafe widths, direction and versions fail before persistence', async t => {
  const f = await setup(t), { preferences } = await f.store.read(f.fresh);
  for (const bad of [{ columns: [] }, { columns: ['retailGross'] }, { columns: ['title', 'title'] }, { columnWidths: { title: 801 } }, { columnWidths: { title: 79 } }, { columnWidths: { title: 100.5 } }, { sort: 'secret' }, { direction: 'invalid' }]) await assert.rejects(f.store.write(f.fresh, { version: 0, preferences: { ...preferences, ...bad } }), { status: 422 });
  await assert.rejects(f.store.write(f.fresh, { version: -1, preferences }), { status: 422 });
  assert.equal(f.app.database.prepare("SELECT count(*) AS n FROM trade_annotations WHERE kind='sales-bwl-actions-preferences'").get().n, 0);
});
test('authenticated but corrupted owner data cannot be repaired by read or overwrite', async t => {
  const f = await setup(t), { preferences } = await f.store.read(f.fresh); await f.store.write(f.fresh, { version: 0, preferences });
  const row = f.app.database.prepare("SELECT id,scope_id AS scopeId,kind,revision,payload FROM trade_annotations WHERE kind='sales-bwl-actions-preferences'").get(), context = ['trade-annotation-v1', row.scopeId, row.kind, row.id, row.revision];
  const value = f.protection.open(row.payload, context); value.ownerId = 'other'; f.app.database.prepare('UPDATE trade_annotations SET payload=? WHERE id=?').run(f.protection.seal(value, context), row.id);
  await assert.rejects(f.store.read(f.fresh), { status: 503 }); await assert.rejects(f.store.write(f.fresh, { version: 1, preferences }), { status: 503 });
});
