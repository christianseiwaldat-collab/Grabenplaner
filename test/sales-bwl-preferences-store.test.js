'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Model = require('../lib/sales-bwl-abc-model');
const {createSalesBwlPreferencesStore} = require('../lib/sales-bwl-preferences-store');
const {openSqliteApplicationPersistence} = require('../lib/persistence/sqlite/provider');
const {SQLITE_APPLICATION_CATALOG} = require('../lib/persistence/sqlite/application-catalog');
const {loadManagedDataImportProtection} = require('../lib/data-import-managed-protection');
const {definePersistenceStatement} = require('../lib/persistence/contract');
const READ_ONLY = definePersistenceStatement({id: 'sales-bwl-test.read-only', operation: 'queryOne', columns: {value: 'safe_integer'}});
const ADVANCE_REVISION = definePersistenceStatement({id: 'sales-bwl-test.advance-revision', operation: 'execute', parameters: {id: 'text'}});
const TEST_CATALOG = [
  ...SQLITE_APPLICATION_CATALOG,
  {statement: READ_ONLY, returning: false, sql: 'SELECT query_only AS value FROM pragma_query_only'},
  {statement: ADVANCE_REVISION, returning: false, sql: 'UPDATE trade_annotations SET revision=revision+1 WHERE id=$id'},
];
const KIND = 'sales-bwl-abc-preferences';
const SCOPE = 'grabenplaner-main:personal-bwl-preferences';
const A = require('../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS;
const H = require('../lib/sales-history-access').SALES_HISTORY_PERMISSIONS;
const CRM = require('../lib/crm-access').CRM_PERMISSIONS;
const session = extra => ({id: 'synthetic-session', employeeNumber: '42', accountId: '',
  sessionKind: 'employee', isEmployee: true, active: true, mustChangePassword: false, role: 'manager',
  permissions: [A.ACCESS, A.LOCATION_READ, H.READ], scopes: [{locationId: '18', departmentId: null}], ...extra});
const defaults = actor => Model.normalizePreferences({}, Model.authority(actor).projection);
const preferences = (actor = session(), extra = {}) => ({...defaults(actor), direction: 'desc', ...extra});

function fixture(t, {databasePath = ':memory:', resume = false} = {}) {
  const app = openSqliteApplicationPersistence({databasePath, catalog: TEST_CATALOG});
  if (!resume) {
    app.database.exec(require('../lib/persistence/sqlite/trade-annotations-catalog').TRADE_ANNOTATIONS_SCHEMA);
    app.database.exec(require('../lib/persistence/sqlite/operations/data-import-runtime-schema').DATA_IMPORT_RUNTIME_SCHEMA_SQL);
    app.database.exec('CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity_type TEXT,entity_id TEXT,detail TEXT,created_at TEXT)');
  }
  const vault = require('../lib/integration-secret-vault').createIntegrationSecretVault({
    activeKeyId: 'synthetic', keys: {synthetic: Buffer.alloc(32, 42)},
  });
  let closed = false;
  const close = async () => {if (!closed) {closed = true; await app.provider.close(); app.database.close();}};
  t.after(close);
  const store = scopeId => createSalesBwlPreferencesStore({access: app.provider, vault,
    ...(scopeId ? {scopeId} : {})});
  return {...app, vault, store, close,
    rows: () => app.database.prepare('SELECT id,scope_id AS scopeId,kind,revision,payload FROM trade_annotations ORDER BY id').all(),
    audits: () => app.database.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    keyCount: () => app.database.prepare('SELECT COUNT(*) AS count FROM data_import_runtime_keys').get().count,
    protection: () => loadManagedDataImportProtection({access: app.provider, vault, create: false})};
}

test('ABC preferences GET without a managed key remains read-only and checks authority inside the transaction', async t => {
  const f = fixture(t), actor = session(), calls = [];
  const result = await f.store().get(async tx => {
    calls.push(Boolean(tx));
    if (tx) assert.equal((await tx.queryOne(READ_ONLY, {})).value, 1);
    return actor;
  });
  assert.deepEqual(result, {version: 0, preferences: defaults(actor)});
  assert.deepEqual(calls, [false, false, true, true]);
  assert.equal(f.keyCount(), 0); assert.equal(f.rows().length, 0); assert.equal(f.audits().length, 0);
});

test('ABC preferences persist across database reopening, use account isolation, and are encrypted with a neutral audit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-bwl-preferences-'));
  let f, reopened;
  t.after(async () => {
    await f?.close(); await reopened?.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('gp-bwl-preferences-'));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const databasePath = path.join(directory, 'preferences.sqlite');
  f = fixture(t, {databasePath});
  const actor = session(), prefs = preferences(actor);
  assert.equal(actor.permissions.includes('sales:bwl:actions:write'), false);
  const saved = await f.store().save(async () => actor, {version: 0, preferences: prefs});
  assert.deepEqual(saved, {version: 1, preferences: prefs});
  const row = f.rows()[0], audit = f.audits()[0];
  assert.equal(row.scopeId, SCOPE); assert.equal(row.kind, KIND); assert.match(row.id, /^[a-f0-9]{64}$/);
  assert.match(row.payload, /^gp-import-v[12]:/);
  assert.doesNotMatch(row.payload, /ownerId|accountId|preferences|articleNumber|direction/);
  assert.equal(audit.actor, actor.employeeNumber); assert.equal(audit.action, 'trade.' + KIND + '.update');
  assert.equal(audit.entity_type, 'trade_annotation'); assert.equal(audit.entity_id, row.id);
  assert.deepEqual(JSON.parse(audit.detail), {revision: 1});
  const protection = await f.protection();
  try {
    assert.deepEqual(protection.open(row.payload, ['trade-annotation-v1', SCOPE, KIND, row.id, 1]),
      {schemaVersion: 1, ownerId: '42', accountId: '', preferences: prefs});
  } finally {protection.destroy();}
  for (const other of [session({employeeNumber: '43'}), session({accountId: '42'}), session({accountId: 'new-account'})]) {
    assert.equal((await f.store().get(async () => other)).version, 0);
  }
  assert.equal((await f.store('other-installation').get(async () => actor)).version, 0);
  await f.close();
  reopened = fixture(t, {databasePath, resume: true});
  assert.deepEqual(await reopened.store().get(async () => actor), saved);
  await reopened.close();
});

test('ABC preferences reject organization, inactive, password-gated and non-reading employee accounts', async t => {
  const f = fixture(t), store = f.store();
  for (const actor of [null, session({employeeNumber: ''}), session({isEmployee: false}),
    session({sessionKind: 'organization'}), session({active: false}), session({mustChangePassword: true}),
    session({permissions: []}), session({scopes: [{locationId: '18', departmentId: 7}]})]) {
    await assert.rejects(store.get(async () => actor), {status: 403});
    await assert.rejects(store.save(async () => actor, {version: 0, preferences: {}}), {status: 403});
  }
  assert.equal(f.keyCount(), 0); assert.equal(f.rows().length, 0); assert.equal(f.audits().length, 0);
});

test('ABC saves require both strict input keys and safe bounded integer versions', async t => {
  const f = fixture(t), actor = session(), store = f.store();
  for (const input of [undefined, null, {}, {version: 0}, {preferences: preferences(actor)},
    {version: 0, preferences: undefined}, {version: 0, preferences: null}, {version: 0, preferences: []},
    {version: 0, preferences: preferences(actor), key: 'someone-else'},
    ...[-1, 1.5, '0', Number.MAX_SAFE_INTEGER, Infinity].map(version => ({version, preferences: preferences(actor)}))]) {
    await assert.rejects(store.save(async () => actor, input), {code: 'BWL_ABC_PREFERENCES_INVALID', status: 422});
  }
  assert.equal(f.keyCount(), 0); assert.equal(f.rows().length, 0);
});

test('ABC request snapshots cannot be changed by mutating the caller version or preferences during an await', async t => {
  const f = fixture(t), actor = session(), input = {version: 0, preferences: preferences(actor)};
  let checks = 0;
  const saved = await f.store().save(async () => {
    if (++checks === 2) {input.version = 123; input.preferences.direction = 'asc';}
    return actor;
  }, input);
  assert.equal(saved.version, 1); assert.equal(saved.preferences.direction, 'desc');
});

test('ABC two-store concurrent creates and updates admit one writer; identical stale values still conflict', async t => {
  const f = fixture(t), actor = session(), getSession = async () => actor;
  const first = f.store(), second = f.store();
  const assertRace = async version => {
    const outcomes = await Promise.allSettled([
      first.save(getSession, {version, preferences: preferences(actor)}),
      second.save(getSession, {version, preferences: preferences(actor, {direction: 'asc'})}),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
    const error = outcomes.find(result => result.status === 'rejected').reason;
    assert.equal(error.code, 'BWL_ABC_PREFERENCES_CHANGED'); assert.equal(error.status, 409);
    return outcomes.find(result => result.status === 'fulfilled').value;
  };
  const created = await assertRace(0);
  await assert.rejects(second.save(getSession, {version: 0, preferences: created.preferences}),
    {code: 'BWL_ABC_PREFERENCES_CHANGED', status: 409});
  const updated = await assertRace(1);
  await assert.rejects(first.save(getSession, {version: 1, preferences: updated.preferences}),
    {code: 'BWL_ABC_PREFERENCES_CHANGED', status: 409});
  assert.equal(f.rows()[0].revision, 2); assert.equal(f.audits().length, 2);
  assert.deepEqual(await second.get(getSession), updated);
});

test('ABC real SQL CAS rejects a revision changed after the store read and rolls the transaction back', async t => {
  const f = fixture(t), actor = session(), getSession = async () => actor;
  await f.store().save(getSession, {version: 0, preferences: preferences(actor)});
  const row = f.rows()[0];
  let transactionChecks = 0;
  await assert.rejects(f.store().save(async tx => {
    if (tx && ++transactionChecks === 2) await tx.execute(ADVANCE_REVISION, {id: row.id});
    return actor;
  }, {version: 1, preferences: preferences(actor, {direction: 'asc'})}),
  {code: 'BWL_ABC_PREFERENCES_CHANGED', status: 409});
  assert.equal(f.rows()[0].revision, 1); assert.equal(f.audits().length, 1);
});

test('ABC a real SQLite writer lock maps busy contention to a 409 and preserves persisted preferences', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-bwl-preferences-'));
  let first, second;
  t.after(async () => {
    await first?.close(); await second?.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('gp-bwl-preferences-'));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const databasePath = path.join(directory, 'preferences.sqlite'), actor = session();
  first = fixture(t, {databasePath});
  const saved = await first.store().save(async () => actor, {version: 0, preferences: preferences(actor)});
  second = fixture(t, {databasePath, resume: true});
  second.database.exec('PRAGMA busy_timeout=1');
  first.database.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(second.store().save(async () => actor,
      {version: 1, preferences: preferences(actor, {direction: 'asc'})}),
    {code: 'BWL_ABC_PREFERENCES_CHANGED', status: 409});
  } finally {first.database.exec('ROLLBACK');}
  assert.deepEqual(await second.store().get(async () => actor), saved);
  assert.equal(first.audits().length, 1);
});

test('ABC unchanged identity includes all rights and scopes, and late changes roll back writes and audits', async t => {
  for (const change of [actor => ({...actor, id: 'other-session'}), actor => ({...actor, employeeNumber: '43'}),
    actor => ({...actor, accountId: 'other-account'}), actor => ({...actor, role: 'admin'}),
    actor => ({...actor, permissions: [...actor.permissions, 'unrelated:read']}),
    actor => ({...actor, scopes: [...actor.scopes, {locationId: '18', departmentId: 4}]}),
    actor => ({...actor, permissions: []}), actor => ({...actor, mustChangePassword: true}),
    actor => ({...actor, active: false})]) {
    for (const at of [1, 2, 3]) {
      const f = fixture(t), original = session(); let txChecks = 0, actor = original;
      await assert.rejects(f.store().save(async tx => {
        if (tx && ++txChecks === at) actor = change(original);
        return actor;
      }, {version: 0, preferences: preferences(original)}), {status: 403});
      assert.equal(f.rows().length, 0); assert.equal(f.audits().length, 0);
      await f.close();
    }
  }
});

test('ABC reads revalidate authority after protected loading, within the transaction, and after reading', async t => {
  const f = fixture(t), original = session();
  await f.store().save(async () => original, {version: 0, preferences: preferences(original)});
  for (const at of [2, 3, 4]) {
    let checks = 0;
    await assert.rejects(f.store().get(async () => ++checks >= at
      ? {...original, accountId: 'changed-account'} : original), {status: 403});
  }
  assert.equal(f.rows()[0].revision, 1); assert.equal(f.audits().length, 1);
});

test('ABC annotation and audit errors or silently ignored writes never report success or leave partial state', async t => {
  for (const table of ['trade_annotations', 'audit_log']) {
    for (const action of ["RAISE(ABORT, 'synthetic unavailable')", 'RAISE(IGNORE)']) {
      const f = fixture(t), actor = session();
      f.database.exec(`CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON ${table} BEGIN SELECT ${action}; END`);
      await assert.rejects(f.store().save(async () => actor, {version: 0, preferences: preferences(actor)}));
      assert.equal(f.rows().length, 0); assert.equal(f.audits().length, 0);
      await f.close();
    }
  }
});

test('ABC ignored or failed SQL UPDATE and audit writes preserve the previous revision and ciphertext', async t => {
  for (const target of ['UPDATE ON trade_annotations', 'INSERT ON audit_log']) {
    for (const action of ["RAISE(ABORT, 'synthetic unavailable')", 'RAISE(IGNORE)']) {
      const f = fixture(t), actor = session(), store = f.store();
      await store.save(async () => actor, {version: 0, preferences: preferences(actor)});
      const previous = f.rows()[0];
      f.database.exec(`CREATE TRIGGER synthetic_update_failure BEFORE ${target} BEGIN SELECT ${action}; END`);
      await assert.rejects(store.save(async () => actor,
        {version: 1, preferences: preferences(actor, {direction: 'asc'})}));
      assert.deepEqual(f.rows()[0], previous); assert.equal(f.audits().length, 1);
      await f.close();
    }
  }
});

test('ABC valid saved gross-margin preferences are reduced after grant withdrawal without rewriting storage', async t => {
  const f = fixture(t), actor = session({permissions: [...Object.values(A), ...Object.values(H), ...Object.values(CRM)]});
  const broad = preferences(actor);
  broad.columns = [...broad.columns.filter(id => id !== 'grossMargin'), 'grossMargin'];
  broad.columnWidths = {...broad.columnWidths, grossMargin: 130}; broad.sort = 'grossMargin';
  const saved = await f.store().save(async () => actor, {version: 0, preferences: broad});
  const row = f.rows()[0], narrowed = session();
  const loaded = await f.store().get(async () => narrowed);
  assert.equal(loaded.version, saved.version); assert.equal(loaded.preferences.columns.includes('grossMargin'), false);
  assert.equal(Object.hasOwn(loaded.preferences.columnWidths, 'grossMargin'), false);
  assert.notEqual(loaded.preferences.sort, 'grossMargin');
  assert.deepEqual(f.rows()[0], row); assert.equal(f.audits().length, 1);
  await assert.rejects(f.store().save(async () => narrowed, {version: saved.version, preferences: broad}));
  assert.deepEqual(f.rows()[0], row); assert.equal(f.audits().length, 1);
});

test('ABC malformed authenticated envelopes and tampered ciphertext fail closed without repair writes', async t => {
  const f = fixture(t), actor = session(), store = f.store(), prefs = preferences(actor);
  await store.save(async () => actor, {version: 0, preferences: prefs});
  const row = f.rows()[0], protection = await f.protection();
  const valid = {schemaVersion: 1, ownerId: '42', accountId: '', preferences: prefs};
  const context = ['trade-annotation-v1', SCOPE, KIND, row.id, 1];
  try {
    for (const invalid of [{...valid, schemaVersion: 2}, {...valid, ownerId: '43'}, {...valid, accountId: '42'},
      {...valid, extra: true}, {schemaVersion: 1, ownerId: '42', accountId: ''},
      {...valid, preferences: {}},
      {...valid, preferences: {...prefs, columns: ['unknown-column']}},
      {...valid, preferences: {...prefs, columns: [...prefs.columns, prefs.columns[0]]}},
      {...valid, preferences: {...prefs, direction: 'invalid'}}]) {
      f.database.prepare('UPDATE trade_annotations SET payload=? WHERE id=?').run(protection.seal(invalid, context), row.id);
      await assert.rejects(store.get(async () => actor), {code: 'BWL_ABC_PREFERENCES_INTEGRITY', status: 503});
      await assert.rejects(store.save(async () => actor, {version: 1, preferences: prefs}),
        {code: 'BWL_ABC_PREFERENCES_INTEGRITY', status: 503});
      assert.equal(f.rows()[0].revision, 1); assert.equal(f.audits().length, 1);
    }
    f.database.prepare('UPDATE trade_annotations SET payload=? WHERE id=?').run('corrupted-ciphertext', row.id);
    await assert.rejects(store.get(async () => actor), {code: 'BWL_ABC_PREFERENCES_INTEGRITY', status: 503});
  } finally {protection.destroy();}
});
