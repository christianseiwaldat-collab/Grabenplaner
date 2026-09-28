'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withReportFixture } = require('../test-support/postgresql-migration/report-fixture');
const { receipt, sourceRows } = require('../test-support/postgresql-migration/cash-fixture');
const { createPostgresqlCashHistoryBackend } = require('../lib/persistence/postgresql/reporting/receipt-prefetch');
const { receiptMeasurement } = require('../test-support/receipt-prefetch-measurement');
const live = { skip: !process.env.GP_CORE_MIGRATOR_URL || !process.env.GP_SALES_MIGRATOR_URL };

test('PostgreSQL receipt pages and exports batch all needed groups with identical scoped results', live, () => withReportFixture(async f => {
  const data = sourceRows(Array.from({ length: 101 }, (_, index) => receipt(index + 1, '600', Array.from({ length: 5 }, () => ({})))));
  const built = await f.cash.build(data); await f.cash.activate(f.cash.request(built.id));
  const session = await f.resolvePrincipal('00001');
  const query = { sourceId: 'compact-cash', dateFrom: '2026-08-01', dateTo: '2026-08-31', locationId: '18', limit: 50 };
  const options = { access: f.access, protection: f.protection, scopeId: 'synthetic-migration', session, query, backendFactory: createPostgresqlCashHistoryBackend };
  const measurements = [];
  for (let run = 0; run < 3; run++) {
    const legacy = await receiptMeasurement({ ...options, mode: 'legacy-prefix' });
    const current = await receiptMeasurement(options);
    const before = await legacy.measure('search', query), after = await current.measure('search', query);
    assert.deepEqual(after.result.items, before.result.items); assert.equal(after.result.items.length, 50);
    assert.equal(before.batchReads, 2); assert.equal(before.scalarRows, 60);
    assert.equal(after.batchReads, 6); assert.equal(after.scalarRows, 0);
    const warm = await current.measure('search', query);
    assert.deepEqual(warm.result.items, after.result.items); assert.equal(warm.batchReads, 3); assert.equal(warm.scalarRows, 0);
    const ids = after.result.items.map(row => row.id);
    const beforeExport = await legacy.measure('documents', { ids }), afterExport = await current.measure('documents', { ids });
    assert.deepEqual(afterExport.result, beforeExport.result);
    assert.equal(beforeExport.scalarRows, 100); assert.equal(beforeExport.batchReads, 0);
    assert.equal(afterExport.scalarRows, 0); assert.equal(afterExport.batchReads, 6);
    const compact = ({ milliseconds, queries, batchReads, scalarRows }) => ({ milliseconds: +milliseconds.toFixed(3), queries, batchReads, scalarRows });
    measurements.push({ before: compact(before), after: compact(after), warm: compact(warm), beforeExport: compact(beforeExport), afterExport: compact(afterExport) });
    await legacy.close(); await current.close();
  }
  const current = await receiptMeasurement(options);
  const selective = await current.measure('search', { ...query, receipt: 'not-present' });
  assert.equal(selective.result.items.length, 0); assert.equal(selective.result.processed, 100);
  assert.equal(selective.batchReads, 10); assert.equal(selective.scalarRows, 0);
  assert.ok(selective.result.next);
  const tail = await current.measure('search', { ...query, receipt: 'not-present', cursor: selective.result.next });
  assert.equal(tail.result.processed, 1); assert.equal(tail.result.complete, true);
  const small = await current.measure('search', { ...query, limit: 1 });
  assert.equal(small.result.items.length, 1); assert.equal(small.batchReads, 2);
  const noSellers = await receiptMeasurement({ ...options, session: { ...session, permissions: session.permissions.filter(p => p !== 'sales:history:sellers:read') } });
  const safe = await noSellers.measure('documents', { ids: small.result.items.map(row => row.id) });
  for (const row of safe.result.items) {
    assert.equal(Object.hasOwn(row, 'personnel'), false);
    assert.equal(Object.hasOwn(row, 'linePersonnel'), false);
    assert.ok(row.lines.every(line => !Object.hasOwn(line, 'personnel')));
  }
  const otherScope = await receiptMeasurement({ ...options, session: { ...session, permissions: session.permissions.filter(p => !['sales:analytics:company:read', 'sales:history:unassigned:read'].includes(p)), scopes: [{ locationId: '19' }] } });
  await assert.rejects(otherScope.measure('documents', { ids: small.result.items.map(row => row.id) }), e => e.status === 403);
  await current.close(); await noSellers.close(); await otherScope.close();
  const report = { synthetic: true, receipts: 101, positionsPerReceipt: 5, measuredPageSize: 50, runs: measurements,
    explanation: 'Control reproduces prior first-20-only prefetch and scalar document export; same SQL, scope, decoder and reconciliation.' };
  console.log('RECEIPT_PREFETCH_PERFORMANCE ' + JSON.stringify(report));
}, { warmWorkers: false }));
