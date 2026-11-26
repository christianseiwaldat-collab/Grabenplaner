'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const H = require('../lib/tradefoto-history-profiles');
const { recoveryCluster } = require('../test-support/postgresql-recovery-cluster');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createCashSnapshotStore } = require('../lib/persistence/repositories/cash-snapshots');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { readTradeFotoFullSource } = require('../lib/tradefoto-full-import-source');
const { planCashRecovery, validateCashPlan, rehydrateCash } = require('../lib/persistence/postgresql/operations/cash-rehydration');
const TIME = '2026-11-16T12:00:00.000Z';
const raw = (name, extra) => ({ ...Object.fromEntries(H.tableFor('cash', name).columns.map(c => [c.name, null])), ...extra });
const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const cluster = recoveryCluster(test);
async function fixture(t) {
  const { client, access } = await cluster.sales(t);
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 4), indexKey: Buffer.alloc(32, 8), keyId: 'synthetic' });
  t.after(() => protection.destroy());
  const buffer = Buffer.alloc(4096); buffer.write('Standard ACE DB', 4); buffer[0x14] = 3;
  const fileSha256 = checksum(buffer), actor = { scopeId: 'synthetic', ownerId: 'person-1' };
  const id = protection.digest(['source', actor, 'cash', fileSha256]);
  const values = { KassenJournal: [raw('KassenJournal', { Vorgang: 'journal-1', Filiale: '18', Datum: '2010-01-02T00:00:00.000' })],
  KassenJournal_Details: [raw('KassenJournal_Details', { Vorgang: 'journal-1', Filiale: '18', Beleg: 'journal-receipt', Datum: '2010-01-02T00:00:00.000', Einzahlung: '0.300000000001' })],
  Umsatz_KASSE: [raw('Umsatz_KASSE', { Bonnr: '000001', Filialid: '18', Kassenid: '01', Bondatum: '2010-01-02T00:00:00.000',
    KUND_NR: 'private-customer', VerkäuferID: 'private-seller', RechnungsBetrag: '0.300000000001' })],
  Umsatz_Kasse_Details: [raw('Umsatz_Kasse_Details', { Bonnr: '000001', Filialid: '18', Kassenid: '01', Bondatum: '2010-01-02T00:00:00.000',
    RepID: '00000000-0000-0000-0000-000000000001', EAN: '000042', VKMenge: '1', VK_Preis: '0.300000000001' })],
  Tagesbericht: [raw('Tagesbericht', { Bondatum: null })] };
  const store = createCashSnapshotStore({ access, protection, actor, clock: () => TIME });
  await store.begin(id, { kind: 'cash', fileSha256, bytes: buffer.length, tables: TABLES.map(table => ({ name: table.name, profileHash: table.profile.fingerprint, declaredRows: values[table.name]?.length || 0 })) });
  for (const table of TABLES) {
    const rows = values[table.name] || []; await store.startTable(id, table.name, rows.length);
    if (rows.length) await store.append(id, table.name, 1, rows.map((row, i) => H.prepareTradeFotoHistoryRow('cash', table.name, row, { fileSha256, rowNumber: i + 1 })));
    await store.finishTable(id, table.name);
  }
  await store.seal(id, { tables: TABLES.length, rows: 5 });
  let reviewed; do { reviewed = await store.review(id); } while (reviewed.status === 'reviewing');
  const source = { kind: 'cash', sourceId: id, fileSha256, bytes: buffer.length };
  const archiveProof = { version: 1, available: true, generationSha256: 'a'.repeat(64), kinds: [{ kind: 'cash', current: source, previous: null }] };
  const readerFactory = () => ({ getTableNames: () => TABLES.map(t => t.name), getTable(name) { const table = TABLES.find(t => t.name === name), rows = values[name] || [];
    return { rowCount: rows.length, getColumnNames: () => table.columns.map(c => c.name), getColumns: () => table.columns.map(c => ({ type: c.type })),
      getData: ({ columns, rowOffset = 0, rowLimit = Infinity }) => rows.slice(rowOffset, rowOffset + rowLimit).map(row => Object.fromEntries(columns.map(name => [name, row[name] ?? null]))) }; } });
  const seenBuffers = [], passwords = [];
  const archive = { verify: async () => archiveProof, async useSource(kind, options, work) { assert.equal(kind, 'cash'); assert.equal(options.generation, 'current');
    const bytes = Buffer.from(buffer); seenBuffers.push(bytes); return work({ buffer: bytes, password: 'synthetic-unlock-password', source }); } };
  const readSource = options => { passwords.push(options.password); return readTradeFotoFullSource({ ...options, readerFactory }); };
  const plan = await planCashRecovery(client, { protection, archiveProof });
  const read = async sql => (await client.query(sql)).rows;
  const inventoryRows = () => read('SELECT * FROM kassa.cash_snapshot_inventory ORDER BY dataset_slot,table_index');
  const datasetRows = () => read('SELECT * FROM kassa.cash_snapshot_datasets ORDER BY slot');
  const sourceRows = table => read(`SELECT * FROM kassa.${table.sqlName} ORDER BY source_row`);
  const inventory = await inventoryRows(), metadata = await datasetRows(), original = [];
  for (const table of TABLES) original.push(await sourceRows(table));
  async function omit() {
    for (const table of [...TABLES].reverse()) await client.query(`DELETE FROM kassa.${table.sqlName}`);
    for (const row of inventory) await client.query('UPDATE kassa.cash_snapshot_inventory SET row_count=$1,generation=$2 WHERE dataset_slot=$3 AND table_index=$4', [row.row_count, row.generation, row.dataset_slot, row.table_index]);
  }
  return { client, protection, archiveProof, archive, readSource, plan, inventory, metadata, original, omit, values, seenBuffers, passwords, store, id, inventoryRows, datasetRows, sourceRows };
}
test('cash recovery authenticates complete retained datasets and refuses missing historical source coverage', cluster.options, async t => {
  const f = await fixture(t); assert.equal(validateCashPlan(f.plan, { archiveProof: f.archiveProof }), f.plan); assert.equal(f.plan.datasets.length, 1);
  assert.doesNotMatch(JSON.stringify(f.plan), /private|0\.300|000042|password/);
  const incomplete = structuredClone(f.archiveProof); incomplete.kinds[0].current = null;
  await assert.rejects(planCashRecovery(f.client, { protection: f.protection, archiveProof: incomplete }), /PG_CASH_RECOVERY_SOURCE_COVERAGE/);
  for (const mutate of [p => { p.datasets[0].slot++; }, p => { p.datasets[0].tables[0].expectedRows++; }, p => { p.extra = true; }, p => { p.datasets[0].inventory[0].generation++; }]) {
    const plan = structuredClone(f.plan); mutate(plan); assert.throws(() => validateCashPlan(plan, { archiveProof: f.archiveProof }));
  }
});
test('isolated recovery rebuilds exact encrypted cash values and parent keys without modifying metadata or inventory generations', cluster.options, async t => {
  const f = await fixture(t); await f.omit();
  const result = await rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true, readSource: f.readSource });
  assert.equal(result.verified, true); assert.equal(result.rowsRestored, 5);
  assert.deepEqual(await f.datasetRows(), f.metadata);
  assert.deepEqual(await f.inventoryRows(), f.inventory);
  for (const [index, table] of TABLES.entries()) {
    const rows = await f.sourceRows(table);
    assert.deepEqual(rows.map(({ payload, ...row }) => row), f.original[index].map(({ payload, ...row }) => row));
    for (const row of rows) assert.doesNotMatch(row.payload, /private|0\.300|000042/);
  }
  assert.equal((await f.store.summary(f.id)).status, 'ready');
  assert.deepEqual(f.passwords, ['synthetic-unlock-password']); assert.ok(f.seenBuffers.every(buffer => buffer.every(byte => byte === 0)));
});
test('cash recovery refuses product endpoints, populated restores and stale source plans without overwriting data', cluster.options, async t => {
  const f = await fixture(t);
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan }), /PG_CASH_RECOVERY_ISOLATION_REQUIRED/);
  const product = { connectionParameters: { host: '/var/run/postgresql', port: 55484 },
    query() { assert.fail('Production endpoint must be refused before a query'); } };
  await assert.rejects(rehydrateCash(product, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true }), /PG_CASH_RECOVERY_ISOLATION_REQUIRED/);
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true }), /PG_CASH_RECOVERY_NOT_EMPTY/);
  const stale = structuredClone(f.plan); stale.datasets[0].revision++;
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: stale, isolatedRecovery: true }), /PG_CASH_RECOVERY_INTEGRITY/);
  assert.equal((await f.sourceRows(TABLES[0])).length, f.original[0].length);
});
test('a changed source value rolls back all rebuilt rows and inventory writes and clears decrypted bytes', cluster.options, async t => {
  const f = await fixture(t); await f.omit(); f.values.Umsatz_KASSE[0].RechnungsBetrag = '999';
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true, readSource: f.readSource }), /PG_CASH_RECOVERY_INTEGRITY/);
  for (const table of TABLES) assert.deepEqual(await f.sourceRows(table), []);
  assert.deepEqual(await f.inventoryRows(), f.inventory);
  assert.deepEqual(await f.datasetRows(), f.metadata);
  assert.ok(f.seenBuffers.every(buffer => buffer.every(byte => byte === 0)));
});

test('cash journal detail replay preserves parent lookup guards and rolls back earlier tables on missing parents', cluster.options, async t => {
  const f = await fixture(t); await f.omit(); f.values.KassenJournal_Details[0].Vorgang = 'missing-parent';
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true, readSource: f.readSource }), /PG_CASH_RECOVERY_PARENT_MISSING/);
  for (const table of TABLES) assert.deepEqual(await f.sourceRows(table), []);
  assert.deepEqual(await f.inventoryRows(), f.inventory);
  assert.ok(f.seenBuffers.every(buffer => buffer.every(byte => byte === 0)));
});
