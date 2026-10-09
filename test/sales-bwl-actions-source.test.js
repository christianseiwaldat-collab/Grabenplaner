'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { simulationFixture } = require('../test-support/sales-bwl-simulation-fixture');
const { createSalesBwlActionsStore } = require('../lib/sales-bwl-actions-store');
const { createSalesBwlAbcWorkspace } = require('../lib/persistence/repositories/sales-bwl-abc-workspace');
async function setup(t) { const f = await simulationFixture(t); f.state.session.role = 'manager'; f.state.session.permissions.push('sales:bwl:actions:write');
  f.fresh = async () => f.state.session;
  f.source = (locationId, sourceHint, tx) => f.runtime.run(f.fresh, 'bwl-actions-source', { locationId, sourceHint }, { executor: tx });
  const context = await f.simulation('context'); f.selector = { kind: 'inventory', rowId: JSON.stringify(['0000000000042', '18']), sourceFingerprint: context.sourceFingerprint }; return f; }
test('inventory source proof checks one indexed stock row and accepted article head without reading financial catalog fields', async t => {
  const f = await setup(t), hint = await f.source('18', f.selector);
  assert.equal(hint.articleNumber, '000042'); assert.equal(hint.label, 'BEISPIEL Fernglas'); assert.equal(hint.sourceFingerprint, f.selector.sourceFingerprint);
  assert.deepEqual(Object.keys(hint).sort(), ['articleNumber', 'kind', 'label', 'reason', 'rowId', 'sourceAt', 'sourceFingerprint', 'type']);
  assert.doesNotMatch(JSON.stringify(hint), /retailGross|averageCost|quantity/);
  // The contract rejects nested transactions. A successful proof in this outer
  // serializable transaction therefore proves the key and source reads reuse tx.
  const proof = await f.app.provider.transaction(tx => f.source('18', f.selector, tx), { isolation: 'serializable', readOnly: true }); assert.deepEqual(proof, hint);
  const store = createSalesBwlActionsStore({ access: f.app.provider, vault: f.vault, loadAssignees: async () => [], loadSourceHint: (_fresh, location, selector, tx) => f.source(location, selector, tx) });
  const action = await store.create(f.fresh, { id: crypto.randomUUID(), locationId: '18', title: 'BEISPIEL prüfen', sourceHint: f.selector });
  assert.deepEqual(action.source, hint); assert.equal(action.articleNumber, hint.articleNumber);
});
test('inventory proof rejects forged location, nonexistent stock, changed source and exact key aliases', async t => {
  const f = await setup(t);
  await assert.rejects(f.source('19', f.selector), { status: 403 });
  await assert.rejects(f.source('18', { ...f.selector, rowId: JSON.stringify(['000042', '18']) }), { status: 404 });
  await assert.rejects(f.source('18', { ...f.selector, rowId: '[ "0000000000042", "18" ]' }), { status: 403 });
  await assert.rejects(f.source('18', { ...f.selector, sourceFingerprint: '0'.repeat(64) }), { status: 409 });
  const current = await f.repo.getByArticleNumber('000042');
  await f.repo.updateManual({ input: { currentArticleNumber: '000042', expectedRevision: current.currentRevision, articleNumber: '009999', description: 'BEISPIEL akzeptiert', identifiers: [], prices: { sales: [] } }, actor: 'synthetic-owner', timestamp: '2026-10-09T00:00:00.000Z', mutationId: crypto.randomUUID() });
  await assert.rejects(f.source('18', f.selector), { status: 409 });
  const next = { ...f.selector, sourceFingerprint: (await f.simulation('context')).sourceFingerprint }, hint = await f.source('18', next);
  assert.equal(hint.articleNumber, '009999'); assert.equal(hint.label, 'BEISPIEL akzeptiert');
});
test('managed cash runtime can inspect publication inside an existing branded transaction', async t => {
  const f = await setup(t), { createManagedSalesHistoryRuntime } = require('../lib/persistence/repositories/sales-history-runtime');
  const runtime = createManagedSalesHistoryRuntime({ access: f.app.provider, vault: f.vault, cashEnabled: true });
  const result = await f.app.provider.transaction(tx => runtime.run(f.fresh, value => value, { executor: tx }), { isolation: 'serializable', readOnly: true });
  assert.equal(result, null); await assert.rejects(runtime.run(f.fresh, () => null, { executor: {} }), { code: 'PERSISTENCE_CONTRACT_VIOLATION' });
  await f.app.provider.transaction(async tx => { await assert.rejects(require('../lib/data-import-managed-protection').loadManagedDataImportProtection({ access: f.app.provider, vault: f.vault, executor: tx, create: true }), { status: 422 }); });
});
test('ABC source proof is minimal, snapshot-bound and executes epoch/fresh-authority checks inside the action CAS transaction', async t => {
  const f = await setup(t); let epoch = 1;
  const backend = { source: { scopeId: 'grabenplaner-main', locations: [{ id: '18', label: 'BEISPIEL 18' }] }, epoch: async () => [epoch],
    search: async () => [{ id: 'line', businessDate: '2026-10-01' }],
    service: () => ({ detail: async () => ({ table: 'Umsatz_Kasse_Details', provenance: { businessDate: '2026-10-01', parentId: 'head' },
      fields: { RepID: 'line', EAN: '00042', Artikelbezeichnung: 'BEISPIEL Kamera', VKMenge: '1', Filialid: '018' }, references: [{ role: 'location.filialid', targetId: '18', status: 'linked' }] }),
      receipt: async () => ({ canAggregate: true, positions: [{ key: 'line', status: 'sale', net: '10.00' }], issues: [] }) }) };
  const workspace = createSalesBwlAbcWorkspace({ access: f.app.provider, protection: f.protection, backend, getSession: f.fresh, scopeId: 'grabenplaner-main', today: () => '2026-10-09', sourceAt: '2026-10-08T00:00:00.000Z' });
  const result = await workspace.step({ dateFrom: '2026-10-01', dateTo: '2026-10-09', locationIds: ['18'] }), row = result.snapshot.rows[0];
  const hint = await f.app.provider.transaction(tx => workspace.sourceHint(result.exportToken, row.id, '18', { executor: tx }), { isolation: 'serializable', readOnly: true });
  assert.equal(hint.articleNumber, '00042'); assert.equal(hint.label, 'BEISPIEL Kamera'); assert.equal(hint.kind, 'abc'); assert.doesNotMatch(JSON.stringify(hint), /netRevenue|grossMargin|quantity|private-customer/);
  assert.equal(hint.reason, `Artikel der ABC-Klasse ${row.class} prüfen.`);
  await assert.rejects(workspace.sourceHint(result.exportToken, row.id, '19'), { status: 404 });
  epoch++; await assert.rejects(workspace.sourceHint(result.exportToken, row.id, '18'), { status: 409 });
});
