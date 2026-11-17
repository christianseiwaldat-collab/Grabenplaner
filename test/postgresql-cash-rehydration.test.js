'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const C = require('../lib/data-import-contract'), H = require('../lib/tradefoto-history-profiles');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createCashSnapshotStore } = require('../lib/persistence/repositories/cash-snapshots');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { readTradeFotoFullSource } = require('../lib/tradefoto-full-import-source');
const { planCashRecovery, validateCashPlan, rehydrateCash } = require('../lib/persistence/postgresql/operations/cash-rehydration');
const TIME = '2026-11-16T12:00:00.000Z';
const raw = (name, extra) => ({ ...Object.fromEntries(H.tableFor('cash', name).columns.map(c => [c.name, null])), ...extra });
const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// A synthetic PostgreSQL client adapter over actual relational FK/trigger/
// transaction behavior. This is not native PostgreSQL/paid/live-server evidence.
function relationalClient(database) {
  return { connectionParameters: { host: '/tmp/gp-pg-recovery-synthetic', port: 55484 }, async query(sql, parameters = []) {
    if (sql.startsWith("SELECT current_setting('unix_socket_directories')")) return { rows: [{ socket: this.connectionParameters.host, port: '55484', listen: '' }] };
    if (sql.startsWith('BEGIN')) { database.exec('SAVEPOINT cash_recovery_test'); return { rows: [] }; }
    if (sql === 'COMMIT') { database.exec('RELEASE cash_recovery_test'); return { rows: [] }; }
    if (sql === 'ROLLBACK') { database.exec('ROLLBACK TO cash_recovery_test; RELEASE cash_recovery_test'); return { rows: [] }; }
    if (sql.includes('jsonb_to_recordset')) {
      const table = sql.match(/INSERT INTO kassa\.(cash_snapshot_[0-6])/)[1], rows = JSON.parse(parameters[0]);
      const statement = database.prepare(`INSERT INTO ${table}(dataset_slot,source_row,source_key,business_date,parent_row,location_key,seller_key,customer_key,article_key,payload) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const row of rows) statement.run(row.datasetSlot, row.sourceRow, Buffer.from(row.sourceKey, 'hex'), row.businessDate, row.parentRow,
        ...['locationKey', 'sellerKey', 'customerKey', 'articleKey'].map(key => row[key] === null ? null : Buffer.from(row[key], 'hex')), row.payload);
      return { rows: [], rowCount: rows.length };
    }
    const text = sql.replaceAll('kassa.', '').replaceAll('::text', '').replace(/\$[1-9][0-9]*/g, '?');
    const statement = database.prepare(text);
    if (text.startsWith('SELECT')) {
      const rows = statement.all(...parameters).map(row => { if ('populated' in row) row.populated = Boolean(row.populated); return row; });
      return { rows };
    }
    return { rows: [], rowCount: Number(statement.run(...parameters).changes) };
  } };
}
async function fixture(t) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: SQLITE_APPLICATION_CATALOG });
  ensureSqliteDataImportRuntimeSchema(app.database); app.database.exec('PRAGMA foreign_keys=ON');
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 4), indexKey: Buffer.alloc(32, 8), keyId: 'synthetic' });
  t.after(async () => { protection.destroy(); await app.provider.close(); app.database.close(); });
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
  const store = createCashSnapshotStore({ access: app.provider, protection, actor, clock: () => TIME });
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
  const client = relationalClient(app.database);
  const readerFactory = () => ({ getTableNames: () => TABLES.map(t => t.name), getTable(name) { const table = TABLES.find(t => t.name === name), rows = values[name] || [];
    return { rowCount: rows.length, getColumnNames: () => table.columns.map(c => c.name), getColumns: () => table.columns.map(c => ({ type: c.type })),
      getData: ({ columns, rowOffset = 0, rowLimit = Infinity }) => rows.slice(rowOffset, rowOffset + rowLimit).map(row => Object.fromEntries(columns.map(name => [name, row[name] ?? null]))) }; } });
  const seenBuffers = [], passwords = [];
  const archive = { verify: async () => archiveProof, async useSource(kind, options, work) { assert.equal(kind, 'cash'); assert.equal(options.generation, 'current');
    const bytes = Buffer.from(buffer); seenBuffers.push(bytes); return work({ buffer: bytes, password: 'synthetic-unlock-password', source }); } };
  const readSource = options => { passwords.push(options.password); return readTradeFotoFullSource({ ...options, readerFactory }); };
  const plan = await planCashRecovery(client, { protection, archiveProof });
  const inventory = app.database.prepare('SELECT * FROM cash_snapshot_inventory ORDER BY dataset_slot,table_index').all();
  const metadata = app.database.prepare('SELECT * FROM cash_snapshot_datasets ORDER BY slot').all();
  const original = TABLES.map(table => app.database.prepare(`SELECT * FROM ${table.sqlName} ORDER BY source_row`).all());
  function omit() {
    for (const table of [...TABLES].reverse()) app.database.exec(`DELETE FROM ${table.sqlName}`);
    for (const row of inventory) app.database.prepare('UPDATE cash_snapshot_inventory SET row_count=?,generation=? WHERE dataset_slot=? AND table_index=?').run(row.row_count, row.generation, row.dataset_slot, row.table_index);
  }
  return { ...app, client, protection, archiveProof, archive, readSource, plan, inventory, metadata, original, omit, values, seenBuffers, passwords, store, id };
}
test('cash recovery authenticates complete retained datasets and refuses missing historical source coverage', async t => {
  const f = await fixture(t); assert.equal(validateCashPlan(f.plan, { archiveProof: f.archiveProof }), f.plan); assert.equal(f.plan.datasets.length, 1);
  assert.doesNotMatch(JSON.stringify(f.plan), /private|0\.300|000042|password/);
  const incomplete = structuredClone(f.archiveProof); incomplete.kinds[0].current = null;
  await assert.rejects(planCashRecovery(f.client, { protection: f.protection, archiveProof: incomplete }), /PG_CASH_RECOVERY_SOURCE_COVERAGE/);
  for (const mutate of [p => { p.datasets[0].slot++; }, p => { p.datasets[0].tables[0].expectedRows++; }, p => { p.extra = true; }, p => { p.datasets[0].inventory[0].generation++; }]) {
    const plan = structuredClone(f.plan); mutate(plan); assert.throws(() => validateCashPlan(plan, { archiveProof: f.archiveProof }));
  }
});
test('isolated recovery rebuilds exact encrypted cash values and parent keys without modifying metadata or inventory generations', async t => {
  const f = await fixture(t); f.omit();
  const result = await rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true, readSource: f.readSource });
  assert.equal(result.verified, true); assert.equal(result.rowsRestored, 5);
  assert.deepEqual(f.database.prepare('SELECT * FROM cash_snapshot_datasets ORDER BY slot').all(), f.metadata);
  assert.deepEqual(f.database.prepare('SELECT * FROM cash_snapshot_inventory ORDER BY dataset_slot,table_index').all(), f.inventory);
  for (const [index, table] of TABLES.entries()) {
    const rows = f.database.prepare(`SELECT * FROM ${table.sqlName} ORDER BY source_row`).all();
    assert.deepEqual(rows.map(({ payload, ...row }) => row), f.original[index].map(({ payload, ...row }) => row));
    for (const row of rows) assert.doesNotMatch(row.payload, /private|0\.300|000042/);
  }
  assert.equal(f.database.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal((await f.store.summary(f.id)).status, 'ready');
  assert.deepEqual(f.passwords, ['synthetic-unlock-password']); assert.ok(f.seenBuffers.every(buffer => buffer.every(byte => byte === 0)));
});
test('cash recovery refuses product endpoints, populated restores and stale source plans without overwriting data', async t => {
  const f = await fixture(t);
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan }), /PG_CASH_RECOVERY_ISOLATION_REQUIRED/);
  f.client.connectionParameters.host = '/var/run/postgresql';
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true }), /PG_CASH_RECOVERY_ISOLATION_REQUIRED/);
  f.client.connectionParameters.host = '/tmp/gp-pg-recovery-synthetic';
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true }), /PG_CASH_RECOVERY_NOT_EMPTY/);
  const stale = structuredClone(f.plan); stale.datasets[0].revision++;
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: stale, isolatedRecovery: true }), /PG_CASH_RECOVERY_INTEGRITY/);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM cash_snapshot_0').get().n, f.original[0].length);
});
test('a changed source value rolls back all rebuilt rows and inventory writes and clears decrypted bytes', async t => {
  const f = await fixture(t); f.omit(); f.values.Umsatz_KASSE[0].RechnungsBetrag = '999';
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true, readSource: f.readSource }), /PG_CASH_RECOVERY_INTEGRITY/);
  for (const table of TABLES) assert.equal(f.database.prepare(`SELECT count(*) n FROM ${table.sqlName}`).get().n, 0);
  assert.deepEqual(f.database.prepare('SELECT * FROM cash_snapshot_inventory ORDER BY dataset_slot,table_index').all(), f.inventory);
  assert.deepEqual(f.database.prepare('SELECT * FROM cash_snapshot_datasets ORDER BY slot').all(), f.metadata);
  assert.ok(f.seenBuffers.every(buffer => buffer.every(byte => byte === 0)));
});

test('cash journal detail replay preserves parent lookup guards and rolls back earlier tables on missing parents', async t => {
  const f = await fixture(t); f.omit(); f.values.KassenJournal_Details[0].Vorgang = 'missing-parent';
  await assert.rejects(rehydrateCash(f.client, { protection: f.protection, archive: f.archive, plan: f.plan, isolatedRecovery: true, readSource: f.readSource }), /PG_CASH_RECOVERY_PARENT_MISSING/);
  for (const table of TABLES) assert.equal(f.database.prepare(`SELECT count(*) n FROM ${table.sqlName}`).get().n, 0);
  assert.deepEqual(f.database.prepare('SELECT * FROM cash_snapshot_inventory ORDER BY dataset_slot,table_index').all(), f.inventory);
  assert.ok(f.seenBuffers.every(buffer => buffer.every(byte => byte === 0)));
});
