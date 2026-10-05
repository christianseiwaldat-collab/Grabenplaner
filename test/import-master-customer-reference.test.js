'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../lib/data-import-contract'), M = require('../lib/tradefoto-master-profiles');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createImportMasterWriters, createImportMasterService, createImportMasterCustomerReferenceReader } = require('../lib/persistence/repositories/import-master-data');
const { IMPORT_MASTER_STATEMENTS: S } = require('../lib/persistence/statements/import-master-data');
const { SQLITE_IMPORT_MASTER_CATALOG } = require('../lib/persistence/sqlite/import-master-catalog');
const { SQLITE_CRM_CUSTOMERS_CATALOG } = require('../lib/persistence/sqlite/crm-customers-catalog');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const TIME = '2026-10-05T12:00:00.000Z';
const code = expected => error => error?.code === expected;
async function fixture(t) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: [...SQLITE_IMPORT_MASTER_CATALOG, ...SQLITE_CRM_CUSTOMERS_CATALOG] });
  require('../lib/persistence/sqlite/operations/import-master-schema').ensureSqliteImportMasterSchema(app.database);
  require('../lib/persistence/sqlite/operations/crm-schema').ensureSqliteCrmSchema(app.database);
  app.database.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 8), indexKey: Buffer.alloc(32, 9), keyId: 'synthetic' });
  const context = { scopeId: 'synthetic-scope', ownerId: 'synthetic-owner', sourceInstance: 'tradefoto-trade' };
  const authorize = () => true, profile = M.profileFor('KUNDEN');
  const writer = createImportMasterWriters({ protection })[profile.entity];
  const service = createImportMasterService({ access: app.provider, protection, authorize,
    getActor: () => ({ scopeId: context.scopeId, ownerId: context.ownerId }), clock: () => TIME });
  const value = { ...context, at: TIME, profileHash: profile.fingerprint, sourceTable: 'KUNDEN', sourceSystem: profile.sourceSystem };
  const normalize = fields => C.normalizeDataImportRow(profile, M.prepareTradeFotoMasterRow('KUNDEN', {
    ...Object.fromEntries(M.tableFor('KUNDEN').columns.map(c => [c.name, null])),
    KUND_NR: '000419', VORNAME: 'Synthetic', NACHNAME: 'Private', BankKntNr: 'DO-NOT-RETURN', ...fields,
  })).data;
  let n = 0;
  async function create(fields = {}, options = {}) {
    const recordId = 'synthetic-record-' + ++n, data = normalize(fields), sourceContext = { ...value, ...options };
    await app.provider.transaction(tx => writer.create(tx, { id: recordId, data }, sourceContext));
    return { recordId, data, sourceContext };
  }
  async function bind(recordId, expectedSourceRevision = 1) {
    const input = { recordId, expectedSourceRevision, decision: { customerType: 'private' } };
    await service.syncCustomer(input, (await service.previewCustomer(input)).planHash);
    return (await app.provider.queryOne(S.getBinding, { recordId })).targetId;
  }
  const reader = createImportMasterCustomerReferenceReader({ protection, authorize });
  const read = (customerId, extra = {}) => app.provider.transaction(tx => reader(tx, { ...context, ...extra }, customerId), { readOnly: true });
  t.after(async () => { protection.destroy(); await app.provider.close(); app.database.close(); });
  return { ...app, protection, context, create, bind, read, writer, service, normalize };
}

test('Customer source reference uses the confirmed original key despite manually edited CRM numbers', async t => {
  const f = await fixture(t), record = await f.create(), customerId = await f.bind(record.recordId);
  const first = await f.read(customerId);
  assert.equal(first.status, 'linked'); assert.equal(first.targetId, customerId); assert.equal(first.sourceId, '000419');
  assert.match(first.revisionFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first).sort(), ['revisionFingerprint', 'sourceId', 'status', 'targetId']);
  assert.ok(!JSON.stringify(first).includes('DO-NOT-RETURN'));
  f.database.prepare('UPDATE crm_customers SET account_number=?,customer_number=?,revision=revision+1 WHERE id=?').run('MANUAL-OTHER', '88888', customerId);
  const changed = await f.read(customerId);
  assert.equal(changed.sourceId, first.sourceId);
  assert.notEqual(changed.revisionFingerprint, first.revisionFingerprint);
  const unrelated = await f.create({ KUND_NR: 'MANUAL-OTHER' });
  assert.equal((await f.read(customerId)).sourceId, '000419', unrelated.recordId);
});

test('Missing or foreign-scope bindings remain unlinked and source instances are fixed by composition', async t => {
  const f = await fixture(t), record = await f.create(), customerId = await f.bind(record.recordId);
  assert.equal((await f.read('unbound-customer')).status, 'unlinked');
  assert.equal((await f.read(customerId, { scopeId: 'another-scope' })).sourceId, null);
  await assert.rejects(f.read(customerId, { sourceInstance: 'tradefoto-bestell' }), code('IMPORT_MASTER_CONTEXT_INVALID'));
  const binding = await f.provider.queryOne(S.getBinding, { recordId: record.recordId });
  f.database.prepare('UPDATE import_master_bindings SET source_instance=? WHERE record_id=?').run('another-ledger', binding.recordId);
  assert.equal((await f.read(customerId)).status, 'unlinked');
});

test('Customer source authorization runs before reading protected source data', async t => {
  const f = await fixture(t); let reads = 0, request;
  const reader = createImportMasterCustomerReferenceReader({ protection: f.protection, authorize: value => { request = value; return false; } });
  await assert.rejects(reader({ queryOne() { reads++; } }, f.context, 'customer-a'), code('IMPORT_FORBIDDEN'));
  assert.equal(reads, 0); assert.equal(request.targetId, 'customer-a');
  assert.deepEqual(request.dataClasses, ['customer_restricted']);
});

test('Tampering with a customer binding target fails authentication', async t => {
  const f = await fixture(t), record = await f.create(); await f.bind(record.recordId);
  f.database.prepare('UPDATE import_master_bindings SET target_id=? WHERE record_id=?').run('changed-target', record.recordId);
  await assert.rejects(f.read('changed-target'), code('IMPORT_PROTECTED_PAYLOAD_INVALID'));
});

test('Tampered master source headers or protected segments never become customer matches', async t => {
  const f = await fixture(t), record = await f.create(), customerId = await f.bind(record.recordId);
  f.database.prepare('UPDATE import_master_records SET source_instance=? WHERE id=?').run('another-ledger', record.recordId);
  await assert.rejects(f.read(customerId), code('IMPORT_MASTER_INTEGRITY'));
  f.database.prepare('UPDATE import_master_records SET source_instance=? WHERE id=?').run('tradefoto-trade', record.recordId);
  f.database.prepare('UPDATE import_master_segments SET payload=? WHERE record_id=?').run('tampered', record.recordId);
  await assert.rejects(f.read(customerId), code('IMPORT_PROTECTED_PAYLOAD_INVALID'));
});

test('A later import preserves immutable customer identity and changes the cursor fingerprint', async t => {
  const f = await fixture(t), record = await f.create(), customerId = await f.bind(record.recordId);
  const before = await f.read(customerId), data = f.normalize({ NACHNAME: 'Corrected synthetic name' });
  await f.provider.transaction(tx => f.writer.update(tx, { id: record.recordId, expectedRevision: 1, data }, record.sourceContext));
  const after = await f.read(customerId);
  assert.equal(after.status, 'linked'); assert.equal(after.sourceId, before.sourceId);
  assert.notEqual(after.revisionFingerprint, before.revisionFingerprint);
  await f.bind(record.recordId, 2);
  assert.notEqual((await f.read(customerId)).revisionFingerprint, after.revisionFingerprint);
});

test('A missing CRM target cannot receive a usable source match', async t => {
  const f = await fixture(t), record = await f.create(), customerId = await f.bind(record.recordId);
  f.database.prepare('DELETE FROM crm_customers WHERE id=?').run(customerId);
  const result = await f.read(customerId);
  assert.equal(result.status, 'target_missing'); assert.equal(result.sourceId, null);
});

test('Historical bindings remain usable and zero customer references remain anonymous', async t => {
  const f = await fixture(t), record = await f.create(), customerId = await f.bind(record.recordId);
  let binding = await f.provider.queryOne(S.getBinding, { recordId: record.recordId });
  const bindingContext = b => ['master-binding', b.scopeId, b.recordId, b.targetKind, b.targetId, b.revision, b.sourceRevision, b.historical, b.lastEventId];
  const payload = f.protection.open(binding.payload, bindingContext(binding));
  const historical = { ...binding, historical: true };
  f.database.prepare('UPDATE import_master_bindings SET historical=1,payload=? WHERE record_id=?').run(f.protection.seal(payload, bindingContext(historical)), record.recordId);
  assert.equal((await f.read(customerId)).status, 'historical_mapping');
  const zero = await f.create({ KUND_NR: '0' });
  // Model an older, authenticated zero mapping that current import writers
  // refuse to create, so anonymous cash never leaks through compatibility data.
  f.database.prepare('DELETE FROM import_master_bindings WHERE record_id=?').run(record.recordId);
  binding = { ...binding, recordId: zero.recordId };
  await f.provider.execute(S.insertBinding, { ...binding, payload: f.protection.seal(payload, bindingContext(binding)) });
  const result = await f.read(customerId);
  assert.equal(result.status, 'unassigned'); assert.equal(result.sourceId, null);
});

test('Customer reverse lookup is indexed and the native statement stays in Core', async t => {
  const f = await fixture(t), source = SQLITE_IMPORT_MASTER_CATALOG.find(e => e.statement === S.getBindingByTarget);
  const plan = f.database.prepare('EXPLAIN QUERY PLAN ' + source.sql).all({ scopeId: 's', sourceInstance: 'tradefoto-trade', sourceTable: 'KUNDEN', targetKind: 'crm_customer', targetId: 'c' });
  assert.match(plan.map(p => p.detail).join(' '), /SEARCH import_master_bindings USING INDEX/);
  const [native] = require('../lib/persistence/postgresql/core/import-master-customer-reference').CATALOG;
  assert.equal(native.statement, S.getBindingByTarget); assert.match(native.sql, /gp\.import_master_bindings/);
  assert.equal(native.parameterBindings.length, 5);
  assert.ok(native.parameterBindings.every(b => b.source === 'value'));
});
