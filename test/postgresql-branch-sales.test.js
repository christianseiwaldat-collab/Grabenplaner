'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withReportFixture } = require('../test-support/postgresql-migration/report-fixture');
const { receipt, sourceRows } = require('../test-support/postgresql-migration/cash-fixture');
const { createBranchReceiptRuntime } = require('../lib/persistence/repositories/branch-receipt-runtime');
const { createPostgresqlReceiptWorkers } = require('../lib/persistence/postgresql/reporting/receipt-runtime');

test('Live PostgreSQL branch receipt search uses the shared worker protocol, scoped documents and fresh rights',
  { skip: process.env.GP_PG_MIGRATION_LIVE !== '1' }, () => withReportFixture(async f => {
    const built = await f.cash.build(sourceRows(Array.from({ length: 24 }, (_, i) => receipt(i + 1, '120', [{}]))));
    await f.cash.activate(f.cash.request(built.id));
    const workers = createPostgresqlReceiptWorkers({ scopeId: 'synthetic-migration', today: '2026-09-12',
      keyConfiguration: { activeKeyId: 'synthetic-migration', keys: { 'synthetic-migration': Buffer.alloc(32, 78) } },
      workerConfiguration: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL } });
    let current = { id: 'branch-test-session', sessionKind: 'organization', isEmployee: false, accountType: 'branch',
      accountId: 'synthetic-branch', employeeNumber: null, permissions: ['branch_receipts:read'], scopes: [{ locationId: '18' }] };
    let revoke = false;
    const runtime = createBranchReceiptRuntime({ ...f.runtimeOptions, dispatchRead: async input => {
      const result = await workers.run(input); if (revoke) current = { ...current, permissions: [] }; return result;
    } });
    const run = work => runtime.run(async () => current, work);
    const query = { sourceId: 'compact-cash', dateFrom: '2026-08-01', dateTo: '2026-08-31', locationId: '18', sort: 'date', direction: 'desc', limit: 20 };
    try {
      const first = await run(w => w.receipts.search(query)); assert.equal(first.items.length, 20);
      const second = await run(w => w.receipts.search({ ...query, cursor: first.next })); assert.equal(second.items.length, 4);
      const id = first.items[0].id;
      const document = await run(w => w.receipts.documents({ ids: [id] })); assert.equal(document.items[0].lines.length, 1);
      assert.equal(document.items[0].personnel, '00002');
      assert.doesNotMatch(JSON.stringify(document), /grossMargin/);
      current = { ...current, scopes: [{ locationId: '19' }] };
      const foreign = await run(w => w.receipts.documents({ ids: [id] }));
      assert.equal(foreign.items[0].locationId, '18');
      current = { ...current, scopes: [{ locationId: '18' }] }; revoke = true;
      await assert.rejects(run(w => w.receipts.documents({ ids: [id] })), e => e.status === 403);
    } finally { await workers.close(); }
  }));
