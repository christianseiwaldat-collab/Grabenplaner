'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {simulationFixture} = require('../test-support/sales-bwl-simulation-fixture');
const {createSalesBwlSimulationPreferencesStore: create} = require('../lib/sales-bwl-simulation-preferences-store');
const M = require('../lib/sales-bwl-simulation-model');
async function setup(t) {const f = await simulationFixture(t); return {...f, store: create({access: f.app.provider, vault: f.vault}), get: async () => f.state.session};}
test('simulation columns, order, widths and exact sort persist through account-scoped CAS', async t => {
  const f = await setup(t), initial = await f.store.read(f.get);
  const preferences = {...initial.preferences, columns: ['description', 'articleNumber', 'scenarioGrossMargin'], columnWidths: {description: 410}, sort: 'scenarioGrossMargin', direction: 'desc'};
  const saved = await f.store.write(f.get, {version: 0, preferences}); assert.deepEqual(saved, {version: 1, preferences});
  assert.deepEqual(await f.store.read(f.get), saved);
  await assert.rejects(f.store.write(f.get, {version: 0, preferences}), {status: 409});
  assert.equal((await f.store.read(async () => ({...f.state.session, accountId: 'other'}))).version, 0);
});
test('simulation early caller mutation and late account changes cannot overwrite preferences', async t => {
  const f = await setup(t), input = await f.store.read(f.get); input.preferences.direction = 'desc';
  const saved = await f.store.write(async () => {input.version = 20; input.preferences.direction = 'asc'; return f.state.session;}, input);
  assert.equal(saved.version, 1); assert.equal(saved.preferences.direction, 'desc');
  const next = {version: 1, preferences: {...saved.preferences, direction: 'desc'}}; let calls = 0;
  const persisted = await f.store.write(async () => {if (++calls === 2) {next.version = 30; next.preferences.direction = 'asc';} return f.state.session;}, next);
  assert.equal(persisted.version, 2); assert.equal(persisted.preferences.direction, 'desc');
  let checks = 0;
  await assert.rejects(f.store.write(async tx => tx && ++checks === 3 ? {...f.state.session, accountId: 'changed'} : f.state.session,
    {version: 2, preferences: saved.preferences}), {status: 403});
  assert.equal((await f.store.read(f.get)).version, 2);
});
test('simulation preference grant withdrawal removes protected columns and financial sorting', async t => {
  const f = await setup(t); const prefs = M.normalizePreferences({columns: ['articleNumber', 'scenarioGrossMargin'], sort: 'scenarioGrossMargin'}, M.authority(f.state.session).caps);
  await f.store.write(f.get, {version: 0, preferences: prefs});
  f.state.session = {...f.state.session, permissions: f.state.session.permissions.filter(p => p !== 'sales:articles:costs:read')};
  const result = await f.store.read(f.get); assert.deepEqual(result.preferences.columns, ['articleNumber']); assert.equal(result.preferences.sort, 'articleNumber');
  await assert.rejects(f.store.write(f.get, {version: 1, preferences: prefs}), {status: 403});
});
test('simulation preferences reject unknown/duplicate/empty columns and unsafe widths or versions', async t => {
  const f = await setup(t); const preferences = (await f.store.read(f.get)).preferences;
  for (const bad of [{columns: []}, {columns: ['unknown']}, {columns: ['articleNumber', 'articleNumber']}, {columnWidths: {description: 900}}, {sort: 'unknown'}, {direction: 'invalid'}]) {
    await assert.rejects(f.store.write(f.get, {version: 0, preferences: {...preferences, ...bad}}));
  }
  await assert.rejects(f.store.write(f.get, {version: -1, preferences}), {status: 422});
});
test('simulation authenticated corrupted preference owner cannot be repaired by reading or saving', async t => {
  const f = await setup(t); const preferences = (await f.store.read(f.get)).preferences;
  await f.store.write(f.get, {version: 0, preferences});
  const row = f.app.database.prepare("SELECT id,scope_id AS scopeId,kind,revision,payload FROM trade_annotations WHERE kind='sales-bwl-simulation-preferences'").get();
  const context = ['trade-annotation-v1', row.scopeId, row.kind, row.id, row.revision];
  const value = f.protection.open(row.payload, context); value.ownerId = 'other';
  f.app.database.prepare('UPDATE trade_annotations SET payload=? WHERE id=?').run(f.protection.seal(value, context), row.id);
  await assert.rejects(f.store.read(f.get), {status: 503}); await assert.rejects(f.store.write(f.get, {version: 1, preferences}), {status: 503});
});
