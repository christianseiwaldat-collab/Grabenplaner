'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPostgresqlBranchOrderOperations } = require('../lib/persistence/postgresql/application-operations/branch-orders');
const { createSqliteSource, seedCoreFixture } = require('../test-support/postgresql-migration/sqlite-source');

// Exercise the asynchronous production module even in ordinary test runs.
// Use real SQL constraints and rollback, and defer each query result.
function asynchronousSqlite(database) {
  let sequence = 0;
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return Object.fromEntries(['get', 'all', 'run'].map(method => [method, async (...args) => {
        await new Promise(resolve => setImmediate(resolve));
        return statement[method](...args);
      }]));
    },
    async transaction(work) {
      const name = 'branch_settings_test_' + (++sequence);
      database.exec('SAVEPOINT ' + name);
      try { const result = await work(); database.exec('RELEASE SAVEPOINT ' + name); return result; }
      catch (error) { database.exec('ROLLBACK TO SAVEPOINT ' + name); database.exec('RELEASE SAVEPOINT ' + name); throw error; }
    },
  };
}

async function exerciseSettings(access) {
  const operations = createPostgresqlBranchOrderOperations(access);
  const before = await operations.settingsSnapshot('18'), draft = structuredClone(before);
  draft.units.push({ id: 'new-unit', title: 'Testgebinde' });
  draft.items.push({ id: 'new-position', title: 'Synthetische neue Position', unitId: 'new-unit', recipientId: before.recipients[0].id });
  draft.groups[0].itemIds.push('new-position');
  draft.groups.push({ id: 'new-group', title: 'Synthetische Gruppe', hint: '', itemIds: ['new-position'] });
  const saved = await operations.replaceConfiguration('18', draft, 'synthetic');
  for (const kind of ['recipients', 'units', 'items', 'groups']) {
    for (const original of before[kind]) assert.ok(saved[kind].some(row => row.id === original.id), kind + ' keeps existing IDs');
  }
  const added = saved.items.find(row => row.title === 'Synthetische neue Position');
  const unit = saved.units.find(row => row.title === 'Testgebinde');
  const group = saved.groups.find(row => row.title === 'Synthetische Gruppe');
  assert.notEqual(added.id, 'new-position'); assert.notEqual(unit.id, 'new-unit'); assert.notEqual(group.id, 'new-group');
  assert.equal(added.unitId, unit.id); assert.equal(added.recipientId, before.recipients[0].id);
  assert.ok(saved.groups[0].itemIds.includes(added.id)); assert.deepEqual(group.itemIds, [added.id]);
  assert.deepEqual(await operations.settingsSnapshot('18'), saved);

  // Creating the local order only stores a snapshot/PDF. No mail transport runs.
  await operations.createOrder('18', { selectedEmployeeNumber: '00001', submittedByAccountId: 'synthetic-account',
    submittedByLogin: 'synthetic', draftOwnerKind: 'employee', senderEmail: 'test@example.invalid',
    weekStart: '2026-09-14', calendarWeek: 38, submittedAt: '2026-09-16T10:00:00.000Z',
    items: [{ itemId: added.id, quantity: 2, note: 'Synthetic history' }] });
  const history = await operations.history('18', 10);
  const changed = structuredClone(saved);
  changed.items.find(row => row.id === added.id).title = 'Synthetische Position geändert';
  const updated = await operations.replaceConfiguration('18', changed, 'synthetic');
  assert.equal(updated.items.find(row => row.id === added.id).title, 'Synthetische Position geändert');
  assert.equal(updated.units.find(row => row.title === unit.title).id, unit.id);
  assert.deepEqual(updated.groups.find(row => row.id === group.id).itemIds, [added.id]);
  assert.deepEqual(await operations.history('18', 10), history, 'Saved order history must stay unchanged');
  assert.deepEqual(await operations.replaceConfiguration('18', updated, 'synthetic'), updated, 'Repeated saving preserves IDs and memberships');

  const invalid = structuredClone(updated); invalid.items[0].unitId = 'missing-unit';
  await assert.rejects(operations.replaceConfiguration('18', invalid, 'synthetic'), { code: 'BRANCH_ORDER_CONFIGURATION_INVALID' });
  assert.deepEqual(await operations.settingsSnapshot('18'), updated);

  const failing = createPostgresqlBranchOrderOperations({
    transaction: work => access.transaction(work),
    prepare(sql) {
      const statement = access.prepare(sql);
      return { ...statement, async run(...args) {
        if (/INSERT INTO branch_order_catalog_items/.test(sql) && args.includes('Synthetischer Schreibabbruch')) throw new Error('SYNTHETIC_INSERT_FAILURE');
        return statement.run(...args);
      } };
    },
  });
  const interrupted = structuredClone(updated); interrupted.items.at(-1).title = 'Synthetischer Schreibabbruch';
  await assert.rejects(failing.replaceConfiguration('18', interrupted, 'synthetic'), /SYNTHETIC_INSERT_FAILURE/);
  assert.deepEqual(await operations.settingsSnapshot('18'), updated, 'A failed save rolls back every configuration table');
  assert.deepEqual(await operations.history('18', 10), history);
}

test('asynchronous branch settings save new positions, retain IDs/history and roll back failures', async () => {
  const database = createSqliteSource();
  try { seedCoreFixture(database, 3); await exerciseSettings(asynchronousSqlite(database)); }
  finally { database.close(); }
});

test('native PostgreSQL branch configuration round trip and rollback', { skip: process.env.GP_PG_MIGRATION_LIVE !== '1' }, async () => {
  const { withCoreFixture } = require('../test-support/postgresql-migration/core-fixture');
  const { openCoreOperations } = require('../lib/persistence/postgresql/application-operations/access');
  await withCoreFixture(async () => {
    const access = await openCoreOperations({ profile: 'core-migration-development', databaseUrl: process.env.GP_CORE_APP_URL, tlsMode: 'disable-local-only' });
    try { await exerciseSettings(access); } finally { await access.close(); }
  });
});
