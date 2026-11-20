'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { registerDataImportRoutes } = require('../lib/data-import-routes');
const { buildCompletion } = require('../lib/data-import-completion');
const { DATA_IMPORT_PERMISSIONS: P } = require('../lib/data-import-access');

const start = '2026-11-20T09:00:00.000Z';
const end = '2026-11-20T09:01:30.000Z';
const table = (name, receivedRows, counts = {}) => ({
  name, declaredRows: receivedRows, run: { status: 'applied', receivedRows, counts },
});
const source = {
  id: 'a'.repeat(64), kind: 'trade', fileName: 'Trade_Daten & <Stand>.accdb', complete: true, status: 'applied',
  createdAt: start, contentDate: { status: 'complete', value: '2026-11-20' },
  tables: [table('ARTIKEL_STAMM', 50, { invalid: 1, conflict: 2 }),
    { ...table('ARTIKEL_FILIALEN', 30), deferred: 'INCOMPLETE_STOCK_SNAPSHOT' }],
  reportPhases: { read: { startedAt: start, finishedAt: end }, review: { startedAt: end, finishedAt: end },
    apply: { startedAt: end, finishedAt: '2026-11-20T09:08:30.000Z' } },
};
const previous = {
  ...source, id: 'b'.repeat(64), fileName: 'Trade_Daten_vorher.accdb',
  reportPhases: { apply: { startedAt: '2026-11-19T09:01:00.000Z', finishedAt: '2026-11-19T09:23:00.000Z' } },
};

test('completion reports distinguish checked, confirmed and deferred records and preserve historical missing timings', () => {
  const report = buildCompletion(source, previous);
  assert.deepEqual(report.counts, { received: 80, checked: 80, confirmed: 47, invalid: 1, conflict: 2, deferredTables: 1, deferredRows: 30 });
  assert.deepEqual(report.durations, { read: 90000, review: 0, apply: 420000 });
  assert.equal(report.previous.durations.apply, 1320000);
  assert.equal(report.previous.durations.read, null);
  assert.equal(buildCompletion({ ...source, status: 'applying' }, previous), null);
  assert.equal(buildCompletion({ ...source, catalogUpdatePending: true }, previous), null);
  assert.equal(buildCompletion({ ...source, reportPhases: undefined }).finishedAt, null);

  const cash = { ...source, kind: 'cash', status: 'ready', tables: [{ name: 'Umsatz_KASSE', declaredRows: 3, run: { receivedRows: 3, verifiedRows: 3 } }] };
  assert.equal(buildCompletion(cash), null);
  const published = buildCompletion(cash, null, { startedAt: start, finishedAt: end, active: true });
  assert.equal(published.counts.confirmed, 3);
  assert.equal(published.durations.apply, 90000);
  assert.equal(published.cashActive, true);
});

test('completion download formats use the same protected source and respect subsequent permission changes', async t => {
  const actor = { employeeNumber: '100', accountId: 'own', isEmployee: true,
    permissions: [P.READ, 'sales:analytics:access', 'sales:analytics:company:read'] };
  let session = actor, status = 'applied', afterRead = null;
  const app = express();
  registerDataImportRoutes(app, {
    requireSession: () => session,
    refreshSession: async () => session,
    runtime: {
      async sourceOperation(get, id, action) {
        assert.equal((await get()).employeeNumber, actor.employeeNumber);
        assert.equal(action, 'read');
        if (id !== source.id) throw Object.assign(new Error('Source was not found'), { code: 'IMPORT_SOURCE_NOT_FOUND', status: 404 });
        afterRead?.();
        return { ...source, status };
      },
      previousCompletion: async () => previous,
    },
  });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const download = (ext, id = source.id) => fetch('http://127.0.0.1:' + server.address().port + '/api/data-import/sources/' + id + '/completion-report/' + ext);
  for (const ext of ['html','md','pdf']) {
    const response = await download(ext);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Disposition'), new RegExp('attachment; filename="GP-Importabschluss-trade-2026-11-20\\.' + ext + '"'));
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    if (ext === 'pdf') {
      assert.equal(response.headers.get('Content-Type'), 'application/pdf');
      assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    } else {
      const text = await response.text();
      const name = ext === 'md' ? 'Trade\\_Daten' : 'Trade_Daten';
      assert.ok(text.includes(name + ' &amp; &lt;Stand&gt;.accdb'));
      assert.match(text, /20\.11\.2026/);
      assert.match(text, /7 Min 0 Sek/);
      assert.match(text, /- 15 Min 0 Sek/);
      assert.match(text, /Nicht erfasst/);
    }
  }
  assert.equal((await download('csv')).status, 404);
  assert.equal((await download('pdf', 'f'.repeat(64))).status, 404);
  status = 'applying';
  assert.equal((await download('pdf')).status, 409);
  status = 'applied';
  afterRead = () => { session = { ...actor, permissions: [] }; };
  assert.equal((await download('md')).status, 403);
});
