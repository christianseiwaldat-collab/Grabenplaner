'use strict';
const test = require('node:test'), assert = require('node:assert/strict');

test('mixed import overview keeps cash takeover status separate from supplier invoice imports', async t => {
  const express = require('express'), app = express(); app.use(express.json());
  const { registerDataImportRoutes } = require('../lib/data-import-routes');
  const { DATA_IMPORT_PERMISSIONS } = require('../lib/data-import-access');
  const UI = require('../public/data-import');
  const session = { employeeNumber: 'synthetic', permissions: [...Object.values(DATA_IMPORT_PERMISSIONS), 'sales:analytics:access', 'sales:analytics:company:read'] };
  const cash = { id: 'a'.repeat(64), kind: 'cash', fileName: 'Kassen_Umsätze.accdb', storage: 'cash-compact-v1', status: 'ready', complete: true, tables: [] };
  const invoice = { id: 'b'.repeat(64), kind: 'lieferantenrechnungen', fileName: 'TRADE_AusgangsRech.accdb', status: 'ready', complete: true, tables: [] };
  const items = [cash, invoice]; let statusReads = 0;
  const routes = registerDataImportRoutes(app, {
    runtime: { overview: async () => ({ items, complete: true }), list: async () => ({ items, next: null }), sourceOperation: async (_get, id) => items.find(s => s.id === id) },
    cashPublications: { operation: async (get, action) => { await get(); assert.equal(action, 'status'); statusReads++; return { sourceId: cash.id, revision: 2, available: true }; } },
    jobs: { overlay: async source => ({ ...source, background: { status: 'ready', state: 'completed' } }) },
    requireSession: () => session, refreshSession: async () => session, assertCsrf: () => {},
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await routes.stop(); await new Promise(resolve => server.close(resolve)); });
  const request = async (url, options) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/data-import${url}`, options);
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private, no-store/); return response.json();
  };
  const projection = { read: true, prepare: true, apply: true };
  for (const result of [await request('/overview'), await request('/sources/search', { method: 'POST' })]) {
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0].cashPublication, { active: true, revision: 2, available: true });
    assert.equal(result.items[1].cashPublication, undefined);
    assert.match(UI.renderSource(result.items[0], projection), /Übernommen/);
    assert.match(UI.renderSource(result.items[1], projection), /TRADE_AusgangsRech.accdb/);
    assert.doesNotMatch(UI.renderSource(result.items[1], projection), /Kassenstand|data-i-publish/);
  }
  assert.equal((await request('/sources/' + cash.id)).cashPublication.active, true);
  const before = statusReads;
  assert.equal((await request('/sources/' + invoice.id)).cashPublication, undefined);
  assert.equal(statusReads, before, 'invoice detail must not depend on cash publication lookup');
});

test('native PostgreSQL cash takeover and supplier invoice lookup coexist across cash replacement', { skip: !process.env.GP_CORE_MIGRATOR_URL }, async () => {
  await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f => {
    const source = await require('../test-support/trade-insights-fixture').insightFixture({ access: f.access, protection: f.protection, scopeId: 'synthetic-migration', ownerId: '00001', seedBase: false });
    const invoices = require('../test-support/trade-supplier-invoices-fixture');
    await source.ingest('ARTIKEL_STAMM', [{ EAN: '000042', Artikelbezeichnung: 'Demo Fernglas', Verkaufspreis: '399', DurchschnittEK: '227.3212' }], { master: true });
    await invoices.seedInvoiceArticleCatalog(f.access); await invoices.seedSupplierInvoices(source);
    const readInvoices = () => f.worker.run({ operation: 'trade-insights', kind: 'supplier-invoices', query: { articleNumber: '000042' }, session: { employeeNumber: '00001' } });
    const initialInvoices = await readInvoices(); assert.equal(initialInvoices.rows.length, 2);
    const assertInvoicesUnchanged = async () => {
      const { sourceRevision: previousRevision, ...expected } = initialInvoices;
      const { sourceRevision, ...actual } = await readInvoices();
      // Trade views intentionally invalidate their shared cursor when a cash
      // publication changes; invoice contents and business dates stay intact.
      assert.match(sourceRevision, /^[a-f0-9]{64}$/); assert.notEqual(sourceRevision, previousRevision);
      assert.deepEqual(actual, expected);
    };
    await f.core.migrator.query('SET ROLE gp_core_owner');
    try { await f.core.migrator.query("UPDATE gp.locations SET active=0 WHERE id='18'"); } finally { await f.core.migrator.query('RESET ROLE'); }
    const { receipt, sourceRows } = require('../test-support/postgresql-migration/cash-fixture');
    const branches = ['18', '0', '00', '70', '90'];
    const build = price => f.cash.build(sourceRows(branches.map((branch, index) => {
      const row = receipt(index + 1, price, [{ VK_Preis: price }]);
      row.head.Filialid = branch; row.lines.forEach(line => { line.Filialid = branch; }); return row;
    })));
    const publication = require('../lib/persistence/repositories/cash-publication-runtime').createCashPublicationRuntime({ access: f.access, vault: f.vault, scopeId: 'synthetic-migration', enabled: true, policies: require('../lib/cash-source-policies').CASH_SOURCE_POLICIES });
    const get = () => f.resolvePrincipal('00001');
    // The reporting worker deliberately cannot import. Model the separate,
    // personally authorized import session while keeping worker reads unchanged.
    const getImporter = async () => { const principal = await get(); return { ...principal, permissions: [...principal.permissions, ...Object.values(require('../lib/data-import-access').DATA_IMPORT_PERMISSIONS), 'locations:write'] }; };
    const first = await build('120');
    await assert.rejects(publication.operation(get, 'apply', { sourceId: first.id, expectedRevision: 0 }), error => error.code === 'IMPORT_FORBIDDEN');
    const applied = await publication.operation(getImporter, 'apply', { sourceId: first.id, expectedRevision: 0 });
    assert.equal(applied.revision, 1);
    const setup = (await publication.operation(getImporter, 'context', { sourceId: first.id })).mappingSetup;
    assert.deepEqual(setup.locations.map(row => row.sourceId).sort(), [...branches].sort());
    assert.equal(setup.locations.find(row => row.sourceId === '18').historical, true);
    const query = { sourceId: 'compact-cash', kind: 'receipts', dateFrom: '2026-08-01', dateTo: '2026-08-31', limit: 20, sort: 'date', direction: 'desc' };
    for (const location of setup.locations) {
      const result = await f.runtime.run(get, workspace => workspace.receipts.search({ ...query, locationId: location.targetId }));
      assert.equal(result.items.length, 1, `one receipt for source branch ${location.sourceId}`);
    }
    await assertInvoicesUnchanged();
    assert.equal((await publication.operation(getImporter, 'apply', { sourceId: first.id, expectedRevision: 0 })).alreadyApplied, true);
    const second = await build('240');
    assert.equal((await publication.operation(getImporter, 'apply', { sourceId: second.id, expectedRevision: 1 })).previous, applied.active);
    assert.equal((await publication.operation(getImporter, 'status')).sourceId, second.id);
    assert.deepEqual((await publication.operation(getImporter, 'context', { sourceId: second.id })).mappingSetup.locations, setup.locations);
    await assertInvoicesUnchanged();
  });
});
