'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withReportFixture } = require('../test-support/postgresql-migration/report-fixture');
const { receipt, sourceRows } = require('../test-support/postgresql-migration/cash-fixture');
const { insightFixture } = require('../test-support/trade-insights-fixture');
const { IMPORT_MASTER_STATEMENTS: M } = require('../lib/persistence/statements/import-master-data');
const { CASH_PUBLICATION_STATEMENTS: S } = require('../lib/persistence/statements/cash-publications');
const code = expected => error => error?.code === expected;

test('Native CRM purchases bridge confirmed customer imports into existing and future cash publications without rewriting them',
  { skip: process.env.GP_PG_MIGRATION_LIVE !== '1', timeout: 150000 }, () => withReportFixture(async f => {
    const built = await f.cash.build(sourceRows([receipt(1, '240', [{}, {}]), receipt(2, '240', [{}, {}])]));
    await f.cash.activate(f.cash.request(built.id));
    const publicationState = () => f.access.transaction(async tx => {
      const state = await f.cash.publications.state(tx), active = await f.cash.publications.active(tx);
      return { revision: state.row.revision, publicationId: active.row.id, payload: active.row.payload,
        inventory: await tx.queryOne(S.bindingInventory, { publicationId: active.row.id }),
        customerBindings: await tx.queryAll(S.bindings, { publicationId: active.row.id, kind: 'KUNDEN', limit: 10001 }) };
    }, { readOnly: true });
    const before = await publicationState(); assert.equal(before.customerBindings.length, 0);
    const source = await insightFixture({ access: f.access, protection: f.protection, scopeId: 'synthetic-migration', ownerId: '00001', seedBase: false });
    const customer = { KUND_NR: '000031', VORNAME: 'Synthetic', NACHNAME: 'Customer', EMail: 'synthetic@example.test' };
    await source.ingest('KUNDEN', [customer], { master: true });
    async function sync(key) {
      const record = (await source.masters.mappings({ table: 'KUNDEN', sourceInstance: 'tradefoto-trade', key })).items[0];
      const request = { recordId: record.id, expectedSourceRevision: record.revision, decision: { customerType: 'private' } };
      return source.masters.syncCustomer(request, (await source.masters.previewCustomer(request)).planHash);
    }
    let synced = await sync(customer.KUND_NR), customerId = synced.targetId;
    const session = { ...await f.resolvePrincipal('00001'), employeeNumber: '00001', isEmployee: true,
      permissions: ['sales:analytics:access', 'sales:analytics:company:read', 'sales:history:read', 'crm:access', 'crm:customers:read', 'crm:purchases:read'] };
    let current = session;
    const runtime = f.makeRuntime(), query = { sourceId: 'compact-cash', kind: 'sales', dateFrom: '2026-08-01', dateTo: '2026-08-31', limit: 1 };
    const run = (id = customerId, changes = {}) => runtime.run(async () => current, workspace => workspace.search({ ...query, ...changes }, { customerId: id }));
    const first = await run();
    assert.equal(first.items.length, 1); assert.equal(first.coverage.counts.records, 4); assert.ok(first.next);
    assert.deepEqual(first.customerAssignment, { status: 'linked', method: 'master' });
    assert.deepEqual(await publicationState(), before, 'customer binding reads and Core import sync must not rewrite the active sealed cash publication');
    assert.equal((await run(customerId, { cursor: first.next })).items.length, 1);
    assert.equal((await run(customerId, { limit: 100 })).items.length, 4);
    assert.doesNotMatch(JSON.stringify(first), /synthetic@example\.test|000031|revisionFingerprint|customerKey/);

    await source.ingest('KUNDEN', [{ KUND_NR: '000032', VORNAME: 'Other', NACHNAME: 'Synthetic customer' }], { master: true });
    const other = await sync('000032');
    assert.equal((await run(other.targetId)).items.length, 0, 'a confirmed different customer key must not match');
    current = { ...session, permissions: session.permissions.filter(p => p !== 'crm:purchases:read') };
    await assert.rejects(run(), code('IMPORT_FORBIDDEN'));
    current = { ...session, scopes: [{ locationId: '19' }], permissions: session.permissions.filter(p => p !== 'sales:analytics:company:read').concat('sales:analytics:location:read') };
    assert.equal((await run()).items.length, 0, 'a customer assignment does not grant another branch');
    await assert.rejects(run(customerId, { locationId: '18' }), code('IMPORT_FORBIDDEN'));
    current = { ...current, scopes: [{ locationId: '18', departmentId: 0 }] };
    assert.equal((await run(customerId, { limit: 100 })).items.length, 4);
    current = session;

    const oldSourceCursor = (await run()).next;
    await source.ingest('KUNDEN', [{ ...customer, NACHNAME: 'Updated synthetic source' }], { master: true, snapshotAt: '2026-09-15T12:00:00.000Z' });
    await assert.rejects(run(customerId, { cursor: oldSourceCursor }), code('IMPORT_HISTORY_RESULTS_CHANGED'));
    const updated = await run(); assert.equal(updated.coverage.counts.records, 4);
    await source.masters.undo(synced.eventId);
    await assert.rejects(run(customerId, { cursor: updated.next }), code('IMPORT_HISTORY_RESULTS_CHANGED'));
    assert.equal((await run()).customerAssignment.status, 'unlinked');
    synced = await sync(customer.KUND_NR); customerId = synced.targetId;
    assert.equal((await run()).coverage.counts.records, 4);
    assert.deepEqual(await publicationState(), before);

    // The link is read afresh; a later import automatically uses the confirmed
    // source identity even when the new publication again has no CRM bindings.
    const nextSource = await f.cash.build(sourceRows([receipt(3, '120', [{}])]));
    const nextPublication = await f.cash.activate(f.cash.request(nextSource.id, before.revision));
    const replacement = await run(); assert.equal(replacement.items.length, 1);
    assert.deepEqual(replacement.customerAssignment, { status: 'linked', method: 'master' });
    const after = await publicationState(); assert.equal(after.customerBindings.length, 0);
    assert.equal(after.revision, nextPublication.revision);

    // An explicit, reviewed cash mapping has priority over the read bridge.
    const explicit = f.cash.request(nextSource.id, after.revision);
    explicit.mappings.push({ kind: 'KUNDEN', sourceId: '000031', targetId: other.targetId, historical: false });
    await f.cash.activate(explicit);
    const excluded = await run(); assert.equal(excluded.items.length, 0);
    assert.deepEqual(excluded.customerAssignment, { status: 'unlinked', method: null });
    const assigned = await run(other.targetId); assert.equal(assigned.items.length, 1);
    assert.equal((await publicationState()).customerBindings.length, 1);
    assert.ok(await f.access.queryOne(M.crmGet, { id: customerId }));
  }, { warmWorkers: false }));
