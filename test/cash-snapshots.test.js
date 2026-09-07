'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const C = require('../lib/data-import-contract');
const H = require('../lib/tradefoto-history-profiles');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { SQLITE_CASH_SNAPSHOTS_CATALOG } = require('../lib/persistence/sqlite/cash-snapshots-catalog');
const { compilePostgresqlDialectEntry } = require('../lib/persistence/postgresql/dialect-compiler');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { createCashSnapshotStore, CASH_SNAPSHOT_FORMAT } = require('../lib/persistence/repositories/cash-snapshots');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { readTradeFotoFullSource } = require('../lib/tradefoto-full-import-source');
const { createDataImportRuntime } = require('../lib/persistence/repositories/data-import-runtime');
const { DATA_IMPORT_PERMISSIONS: P } = require('../lib/data-import-access');
const TIME = '2026-09-07T12:00:00.000Z', actor = { scopeId: 'synthetic', ownerId: 'person-1' };
const sourceBuffer = (version = 0) => { const b = Buffer.alloc(4096); b.write('Standard ACE DB', 4); b[0x14] = 3; b[4095] = version; return b; };
const hash = version => crypto.createHash('sha256').update(sourceBuffer(version)).digest('hex');
const raw = (name, values) => ({ ...Object.fromEntries(H.tableFor('cash', name).columns.map(c => [c.name, null])), ...values });
const header = (date = '2010-01-02T00:00:00.000') => raw('Umsatz_KASSE', { Bonnr: '000001', Filialid: '18', Kassenid: '01', Bondatum: date,
  KUND_NR: '000-private-customer', VerkäuferID: 'private-seller', RechnungsBetrag: '0.300000000001' });
const line = (date = '2010-01-02T00:00:00.000', ordinal = 1) => raw('Umsatz_Kasse_Details', { Bonnr: '000001', Filialid: '18', Kassenid: '01', Bondatum: date,
  RepID: '00000000-0000-0000-0000-' + String(ordinal).padStart(12, '0'), EAN: '000042', VKMenge: '1', VK_Preis: '0.300000000001' });
const values = () => ({ Umsatz_KASSE: [header()], Umsatz_Kasse_Details: [line()],
  Tagesbericht: [raw('Tagesbericht', { Bondatum: null })] });
const code = wanted => e => e?.code === wanted;
async function fixture(t, data = values(), overrides = {}) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: SQLITE_APPLICATION_CATALOG });
  ensureSqliteDataImportRuntimeSchema(app.database); ensureSqliteDataImportRuntimeSchema(app.database);
  app.database.exec('PRAGMA foreign_keys=ON');
  const vault = createIntegrationSecretVault({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 9) } });
  const protection = await loadManagedDataImportProtection({ access: app.provider, vault, create: true, clock: () => TIME });
  const options = { access: app.provider, protection, actor, clock: () => TIME, ...overrides };
  const store = createCashSnapshotStore(options);
  const manifest = { kind: 'cash', fileSha256: hash(0), bytes: 4096,
    tables: TABLES.map(t => ({ name: t.name, profileHash: t.profile.fingerprint, declaredRows: data[t.name]?.length || 0 })) };
  const id = protection.digest(['synthetic-source', manifest.fileSha256]);
  const prepare = (table, row, ordinal) => H.prepareTradeFotoHistoryRow('cash', table.name, row, { fileSha256: manifest.fileSha256, rowNumber: ordinal });
  async function build(targetId = id) {
    await store.begin(targetId, manifest);
    for (const table of TABLES) {
      const rows = data[table.name] || []; await store.startTable(targetId, table.name, rows.length);
      for (let offset = 0; offset < rows.length; offset += C.LIMITS.batch) await store.append(targetId, table.name, offset + 1,
        rows.slice(offset, offset + C.LIMITS.batch).map((r, i) => prepare(table, r, offset + i + 1)));
      await store.finishTable(targetId, table.name);
    }
    return store.seal(targetId, { tables: TABLES.length, rows: Object.values(data).reduce((n, rows) => n + rows.length, 0) });
  }
  async function verify(target = store, targetId = id) {
    let result; do { result = await target.review(targetId); } while (result.status === 'reviewing'); return result;
  }
  t.after(async () => { protection.destroy(); await app.provider.close(); app.database.close(); });
  return { ...app, vault, protection, options, store, manifest, id, build, verify, prepare };
}
test('compact cash: full history, null dates and original precision use one encrypted source copy with provider statements', async t => {
  const f = await fixture(t); await f.build(); const result = await f.verify();
  assert.equal(result.storage, CASH_SNAPSHOT_FORMAT); assert.equal(result.scope, 'full'); assert.equal(result.status, 'ready');
  assert.equal(result.verifiedRows, 3); assert.equal(result.businessActivationEnabled, false);
  for (const name of ['data_import_rows', 'data_import_links', 'data_import_changes', 'import_history_records', 'import_history_versions']) {
    assert.equal(f.database.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n, 0);
  }
  const table = TABLES.find(t => t.name === 'Umsatz_Kasse_Details');
  const row = f.database.prepare(`SELECT * FROM ${table.sqlName}`).get();
  assert.equal(row.business_date, '2010-01-02'); assert.equal(row.parent_row, 1);
  assert.doesNotMatch(row.payload, /private|000042|0\.300/);
  assert.equal(f.database.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.doesNotMatch(JSON.stringify(await f.store.preview(f.id, table.name)), /private|000042|0\.300/);
  for (const entry of SQLITE_CASH_SNAPSHOTS_CATALOG) assert.ok(compilePostgresqlDialectEntry(entry));
});
test('compact cash: replay after a crash is idempotent, rejects changed rows, and keeps other datasets intact', async t => {
  const f = await fixture(t); await f.build(); await f.verify();
  await f.build(); assert.equal((await f.verify()).verifiedRows, 3);
  const table = TABLES.find(t => t.name === 'Umsatz_Kasse_Details');
  await assert.rejects(f.store.append(f.id, table.name, 1, [f.prepare(table, { ...line(), VK_Preis: '999' }, 1)]), code('IMPORT_SOURCE_INTEGRITY'));
  const second = 'b'.repeat(64); await f.build(second); await f.verify(f.store, second);
  assert.equal(f.database.prepare(`SELECT COUNT(*) n FROM ${table.sqlName}`).get().n, 2);
  assert.equal((await f.store.summary(f.id)).status, 'ready');
  const other = createCashSnapshotStore({ ...f.options, actor: { ...actor, ownerId: 'person-2' } });
  await assert.rejects(other.summary(f.id), code('IMPORT_SOURCE_NOT_FOUND'));
});
test('compact cash: no partial batch or proof survives a missing parent, duplicate identity or revoked permission', async t => {
  let allowed = true; const f = await fixture(t, values(), { check: async () => { if (!allowed) C.fail('IMPORT_FORBIDDEN', 403); } });
  await f.store.begin(f.id, f.manifest);
  for (const table of TABLES) {
    if (table.name === 'Umsatz_Kasse_Details') {
      await f.store.startTable(f.id, table.name, 2);
      const good = f.prepare(table, line(), 1), bad = f.prepare(table, { ...line(undefined, 2), Bonnr: 'missing' }, 2);
      await assert.rejects(f.store.append(f.id, table.name, 1, [good, bad]), code('IMPORT_HISTORY_PARENT_MISSING'));
      assert.equal(f.database.prepare(`SELECT COUNT(*) n FROM ${table.sqlName}`).get().n, 0);
      await assert.rejects(f.store.append(f.id, table.name, 1, [good, good]), code('PERSISTENCE_UNIQUE_VIOLATION'));
      assert.equal((await f.store.summary(f.id)).tables.find(t => t.name === table.name).run.receivedRows, 0);
      allowed = false; await assert.rejects(f.store.append(f.id, table.name, 1, [good]), code('IMPORT_FORBIDDEN')); break;
    }
    const rows = table.name === 'Umsatz_KASSE' ? [header()] : [];
    await f.store.startTable(f.id, table.name, rows.length);
    if (rows.length) await f.store.append(f.id, table.name, 1, rows.map((r, i) => f.prepare(table, r, i + 1)));
    await f.store.finishTable(f.id, table.name);
  }
});
test('compact cash: restore review catches altered indexes, missing values and the wrong vault without replacing the key', async t => {
  const f = await fixture(t); await f.build(); await f.verify();
  const table = TABLES.find(t => t.name === 'Umsatz_Kasse_Details');
  const oldKey = f.database.prepare('SELECT payload FROM data_import_runtime_keys').get().payload;
  const wrong = createIntegrationSecretVault({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 8) } });
  await assert.rejects(loadManagedDataImportProtection({ access: f.provider, vault: wrong, create: true }), code('IMPORT_VAULT_UNAVAILABLE'));
  assert.equal(f.database.prepare('SELECT payload FROM data_import_runtime_keys').get().payload, oldKey);
  f.database.prepare(`UPDATE ${table.sqlName} SET business_date='2020-01-01'`).run();
  await f.store.reverify(f.id); await assert.rejects(f.verify(), e => e instanceof C.DataImportError);
  f.database.prepare(`UPDATE ${table.sqlName} SET business_date='2010-01-02'`).run();
  await f.store.reverify(f.id); assert.equal((await f.verify()).status, 'ready');
  f.database.prepare(`DELETE FROM ${table.sqlName}`).run();
  await f.store.reverify(f.id); await assert.rejects(f.verify(), code('IMPORT_SOURCE_INTEGRITY'));
});
test('compact cash: normal upload, restarted review and safe preview use the managed key and keep business activation closed', async t => {
  const data = values(), f = await fixture(t, data);
  let session = { employeeNumber: 'person-1', accountId: 'account-1', isEmployee: true,
    permissions: [...Object.values(P), 'sales:analytics:access', 'sales:analytics:company:read'] };
  const getSession = async () => {
    // Actual GP session refresh queries this provider; it cannot run inside an
    // unrelated repository transaction (a constant test session hid that bug).
    const { DATA_IMPORT_RUNTIME_STATEMENTS: S } = require('../lib/persistence/statements/data-import-runtime');
    await f.provider.queryOne(S.key, { id: 'data-import-v1' }); return session;
  };
  const readerFactory = () => ({ getTableNames: () => TABLES.map(t => t.name), getTable: name => {
    const table = TABLES.find(t => t.name === name), rows = data[name] || [];
    return { rowCount: rows.length, getColumnNames: () => table.columns.map(c => c.name), getColumns: () => table.columns,
      getData: ({ columns, rowOffset = 0, rowLimit = Infinity }) => rows.slice(rowOffset, rowOffset + rowLimit).map(r => Object.fromEntries(columns.map(c => [c, r[c]]))) };
  } });
  const options = { access: f.provider, vault: f.vault, compactCash: true, allowApply: true, scopeId: actor.scopeId, clock: () => TIME,
    readSource: args => readTradeFotoFullSource({ ...args, readerFactory, send: args.onMessage }) };
  let runtime = createDataImportRuntime(options);
  const goodReader=options.readSource;
  options.readSource=async args=>{await goodReader(args);throw new C.DataImportError('IMPORT_SOURCE_INTERRUPTED',409);};
  runtime=createDataImportRuntime(options);
  await assert.rejects(runtime.upload(getSession,{buffer:sourceBuffer(),kind:'cash'}),code('IMPORT_SOURCE_INTERRUPTED'));
  assert.equal((await runtime.list(getSession)).items[0].complete,false);
  options.readSource=goodReader;runtime=createDataImportRuntime(options);
  let source = await runtime.upload(getSession, { buffer: sourceBuffer(), kind: 'cash' });
  runtime = createDataImportRuntime(options);
  do { source = await runtime.sourceOperation(getSession, source.id, 'review', { expectedRevision: source.revision }); } while (source.status === 'reviewing');
  assert.equal(source.status, 'ready'); assert.equal(source.verifiedRows, 3); assert.equal(source.activationEnabled, false);
  assert.equal((await runtime.upload(getSession, { buffer: sourceBuffer(), kind: 'cash' })).id, source.id);
  await assert.rejects(runtime.sourceOperation(getSession, source.id, 'apply', { expectedRevision: source.revision }), code('IMPORT_NOT_ACTIVATED'));
  const table = source.tables.find(t => t.name === 'Umsatz_Kasse_Details');
  assert.deepEqual((await runtime.sourceOperation(getSession, source.id, 'rows', { runId: table.run.id })).rows, [{ rowNumber: 1, state: 'verified' }]);
  session = { ...session, permissions: [] };
  await assert.rejects(runtime.sourceOperation(getSession, source.id, 'read'), code('IMPORT_FORBIDDEN'));
});
