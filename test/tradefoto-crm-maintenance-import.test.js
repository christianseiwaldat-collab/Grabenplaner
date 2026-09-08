'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTools } = require('../scripts/import-tradefoto-crm.cjs');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { ensureSqliteCrmSchema } = require('../lib/persistence/sqlite/operations/crm-schema');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportEngine } = require('../lib/data-import-engine');
const { createDataImportRepository } = require('../lib/persistence/repositories/data-import');
const { createImportMasterWriters, createImportMasterReferenceReader } = require('../lib/persistence/repositories/import-master-data');
const { DATA_IMPORT_RUNTIME_STATEMENTS: R } = require('../lib/persistence/statements/data-import-runtime');
const M = require('../lib/tradefoto-master-profiles');
const raw = extra => Object.assign(Object.fromEntries(M.tableFor('KUNDEN').columns.map(c => [c.name, null])), extra);

async function fixture(t, extraRows = []) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: SQLITE_APPLICATION_CATALOG });
  app.database.exec('CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
  ensureSqliteDataImportRuntimeSchema(app.database); ensureSqliteCrmSchema(app.database);
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 2), keyId: 'synthetic', compression: true });
  t.after(async () => { protection.destroy(); await app.provider.close(); app.database.close(); });
  const actor = { scopeId: 'grabenplaner-main', ownerId: 'synthetic-owner' }, profile = M.profileFor('KUNDEN');
  const engine = createDataImportEngine({ repository: createDataImportRepository(app.provider), protection, profiles: [profile],
    writers: createImportMasterWriters({ protection }), getActor: () => actor, authorize: () => true });
  const fileSha256 = 'a'.repeat(64), at = new Date().toISOString();
  const rows = [raw({ KUND_NR: '0' }), raw({ KUND_NR: '0001', VORNAME: 'Synthetisch', NACHNAME: 'Test', EMail: 's@example.test' }),
    raw({ KUND_NR: '2', EMail: 'kaputt@@example', UStID: 'ATU123', Handy: '1234' }), ...extraRows];
  let run = await engine.start({ profileHash: profile.fingerprint, manifest: { sourceInstance: 'tradefoto-trade', fileSha256,
    schemaSha256: profile.schemaSha256, expectedRows: rows.length, declaredRows: rows.length, snapshotAt: at, gates: [] } });
  run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows: rows.map(row => M.prepareTradeFotoMasterRow('KUNDEN', row)) });
  run = await engine.seal(run.id, run.revision); run = await engine.review(run.id, run.revision);
  assert.equal(run.status, 'ready');
  const sourceId = protection.digest(['source', actor, 'trade', fileSha256]);
  const data = { kind: 'trade', fileSha256, status: 'ready', complete: true, tables: [{ name: 'KUNDEN', profileHash: profile.fingerprint, declaredRows: rows.length, run }] };
  await app.provider.execute(R.insertSource, { id: sourceId, ...actor, revision: 1, createdAt: at, updatedAt: at,
    payload: protection.seal(data, ['source', actor.scopeId, actor.ownerId, sourceId, 1]) });
  return { ...app, protection, actor, engine, run, tools: createTools(),
    options: { access: app.provider, protection, sourceId, expectedSourceSha256: fileSha256, ownerId: actor.ownerId } };
}

test('CRM maintenance projection keeps account identity, missing fields and all invalid original values', () => {
  const tools = createTools();
  assert.equal(tools.project({ KUND_NR: '0' }), null);
  const result = tools.project({ KUND_NR: '00042', EMail: 'bad@@mail', UStID: 'ATU123', TELEFON: '', Handy: 'x'.repeat(81), NACHNAME: null });
  assert.equal(result.accountNumber, '00042'); assert.equal(result.normalized.customerType, 'unknown');
  assert.equal(result.normalized.customerNumber, null); assert.equal(result.normalized.email, ''); assert.equal(result.normalized.vatId, '');
  assert.equal(result.reviewFields.length, 3); assert(result.reviewFields.some(f => f.value.includes('Handy') && f.value.includes('x'.repeat(81))));
  assert.equal(result.nameless, true); assert.equal(tools.project({ KUND_NR: '43', TELEFON: '123', Handy: '456' }).normalized.phone, '123');
  assert.throws(() => tools.project({ KUND_NR: '' }));
});

test('CRM maintenance import plans without cards, creates source bindings and is resumable without duplicates', async t => {
  const f = await fixture(t), prepared = await f.tools.plan(f.options);
  assert.equal(f.database.prepare('SELECT count(*) n FROM crm_customers').get().n, 0);
  assert.equal(f.database.prepare('SELECT count(*) n FROM import_master_records').get().n, 0);
  assert.equal(prepared.summary.customerCards, 2); assert.equal(prepared.summary.reviewCustomers, 1);
  await assert.rejects(f.tools.apply(prepared, 'b'.repeat(64)), /CRM_PLAN_CONFIRMATION_MISMATCH/);
  const first = await f.tools.apply(prepared, prepared.summary.planHash);
  assert.equal(first.created, 2); assert.equal(first.reviewNotesAdded, 1);
  assert.deepEqual(await f.tools.verify(prepared), { verifiedCustomerCards: 2, reviewCustomers: 1, nameless: 1, zeroCustomerCreated: false });
  const after = await f.tools.plan(f.options); assert.equal(after.summary.planHash, prepared.summary.planHash);
  const second = await f.tools.apply(after, after.summary.planHash); assert.equal(second.created, 0); assert.equal(second.alreadyLinked, 2);
  assert.equal(f.database.prepare("SELECT count(*) n FROM audit_log WHERE action='import.customer.create'").get().n, 2);
  assert.equal(f.database.prepare('SELECT count(*) n FROM crm_customer_custom_fields').get().n, 2);
  const reader = createImportMasterReferenceReader({ protection: f.protection, authorize: () => true });
  const reference = await f.provider.transaction(tx => reader(tx, { ...f.actor, sourceInstance: 'tradefoto-trade' }, 'KUNDEN', ['0001']));
  assert.equal(reference.status, 'linked');
  await assert.rejects(f.tools.plan({ ...f.options, expectedSourceSha256: 'b'.repeat(64) }));
  await assert.rejects(f.tools.plan({ ...f.options, ownerId: 'another-owner' }));
});

test('CRM maintenance import resumes when original-value note storage fails and preserves manual fields', async t => {
  const f = await fixture(t), prepared = await f.tools.plan(f.options);
  f.database.exec("CREATE TRIGGER fail_review BEFORE INSERT ON crm_customer_custom_fields BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(f.tools.apply(prepared, prepared.summary.planHash));
  assert.equal(f.database.prepare('SELECT count(*) n FROM crm_customers').get().n, 2);
  assert.equal(f.database.prepare('SELECT count(*) n FROM import_master_bindings').get().n, 2);
  f.database.exec('DROP TRIGGER fail_review');
  const resumed = await f.tools.plan(f.options); await f.tools.apply(resumed, resumed.summary.planHash);
  assert.equal((await f.tools.verify(resumed)).reviewCustomers, 1);
  f.database.prepare("UPDATE crm_customers SET phone='manual',revision=revision+1 WHERE account_number='0001'").run();
  await f.tools.apply(await f.tools.plan(f.options), resumed.summary.planHash);
  assert.equal(f.database.prepare("SELECT phone FROM crm_customers WHERE account_number='0001'").get().phone, 'manual');
});
