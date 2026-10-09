'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {simulationFixture} = require('../test-support/sales-bwl-simulation-fixture');
const {createSalesBwlSimulationVariantsStore: create} = require('../lib/sales-bwl-simulation-variants-store');
const C = require('../lib/data-import-contract'), M = require('../lib/sales-bwl-simulation-model');
const SCOPE = 'grabenplaner-main:personal-bwl-simulation';
async function setup(t, options) {
  const f = await simulationFixture(t, options), get = async () => f.state.session;
  const store = create({access: f.app.provider, vault: f.vault});
  const snapshot = (await f.simulation('calculate', {filters: {locations: ['18']}, assumptions: {}})).snapshot;
  const rows = () => f.app.database.prepare('SELECT id,scope_id AS scopeId,kind,revision,payload FROM trade_annotations WHERE scope_id=? ORDER BY id').all(SCOPE);
  const audits = () => f.app.database.prepare("SELECT * FROM audit_log WHERE action LIKE 'trade.sales-bwl-simulation-variant.%' ORDER BY id").all();
  return {...f, store, get, snapshot, rows, audits, input: {id: crypto.randomUUID(), name: 'BEISPIEL Fernglas-Aktion'}};
}
const seal = (f, row, value) => f.app.database.prepare('UPDATE trade_annotations SET payload=? WHERE id=?').run(
  f.protection.seal(value, ['trade-annotation-v1', row.scopeId, row.kind, row.id, row.revision]), row.id);
const open = (f, row) => f.protection.open(row.payload, ['trade-annotation-v1', row.scopeId, row.kind, row.id, row.revision]);

test('simulation variants persist as encrypted owner/account data with neutral audits and cross-store reading', async t => {
  const f = await setup(t); assert.deepEqual(await f.store.list(f.get), {variants: []});
  const saved = await f.store.create(f.get, f.input, f.snapshot);
  assert.equal(saved.version, 1); assert.equal(saved.historical, true); assert.deepEqual(saved.snapshot, f.snapshot);
  const otherStore = create({access: f.app.provider, vault: f.vault});
  assert.deepEqual(await otherStore.get(f.get, f.input.id), saved);
  const listed = await otherStore.list(f.get); assert.equal(listed.variants[0].id, f.input.id); assert.equal(listed.variants[0].version, 1);
  assert.equal(f.rows().length, 3); assert.equal(f.audits().length, 1);
  for (const row of f.rows()) {assert.match(row.payload, /^gp-import-v[12]:/); assert.doesNotMatch(row.payload, /Fernglas|ownerId|scenarioGrossMargin/);}
  assert.deepEqual(JSON.parse(f.audits()[0].detail), {revision: 1});
  assert.doesNotMatch(JSON.stringify(f.audits()), /Fernglas|120|scenario/);
  const original = f.state.session;
  for (const actor of [{...original, employeeNumber: 'other'}, {...original, accountId: 'other'}]) {
    assert.deepEqual(await otherStore.list(async () => actor), {variants: []});
    await assert.rejects(otherStore.get(async () => actor, f.input.id), {status: 404});
  }
});

test('simulation exact create retry returns the latest renamed version without overwriting or auditing again', async t => {
  const f = await setup(t); await f.store.create(f.get, f.input, f.snapshot);
  const renamed = await f.store.update(f.get, f.input.id, {version: 1, name: 'BEISPIEL umbenannt'});
  const before = f.rows(); assert.deepEqual(await f.store.create(f.get, f.input, f.snapshot), renamed);
  assert.deepEqual(f.rows(), before); assert.equal(f.audits().length, 2);
  await assert.rejects(f.store.create(f.get, {...f.input, name: 'anderer Inhalt'}, f.snapshot), {status: 409});
  await assert.rejects(f.store.update(f.get, f.input.id, {version: 1, name: 'veraltet'}), {status: 409});
  assert.deepEqual(f.rows(), before);
});

test('simulation create and update copy inputs before awaiting session lookup', async t => {
  const f = await setup(t), input = {...f.input}, snapshot = structuredClone(f.snapshot);
  const saved = await f.store.create(async () => {input.name = 'mutiert'; snapshot.assumptions.discountPercent = '90'; return f.state.session;}, input, snapshot);
  assert.equal(saved.name, f.input.name); assert.equal(saved.snapshot.assumptions.discountPercent, '10');
  const update = {version: 1, name: 'BEISPIEL korrekt'};
  const renamed = await f.store.update(async () => {update.version = 300; update.name = 'mutiert'; return f.state.session;}, f.input.id, update);
  assert.equal(renamed.version, 2); assert.equal(renamed.name, 'BEISPIEL korrekt');
});

test('simulation multi-chunk snapshots are verified, replaced atomically, and surplus chunks removed', async t => {
  const f = await setup(t), large = {...f.snapshot, note: 'BEISPIEL '.repeat(100000)};
  const saved = await f.store.create(f.get, f.input, large); assert.equal(saved.snapshot.note, large.note);
  assert.equal(f.rows().filter(r => r.kind.endsWith('-chunk')).length, 2);
  const next = await f.store.update(f.get, f.input.id, {version: 1, name: 'BEISPIEL klein'}, f.snapshot);
  assert.equal(next.version, 2); assert.deepEqual(next.snapshot, f.snapshot);
  assert.equal(f.rows().filter(r => r.kind.endsWith('-chunk')).length, 1);
  await assert.rejects(f.store.create(f.get, {id: crypto.randomUUID(), name: 'Zu groß'}, {...f.snapshot, note: 'x'.repeat(M.LIMITS.snapshotBytes)}), {status: 413});
  assert.equal(f.audits().length, 2);
});

test('simulation source changes reject new/replaced snapshots but historical reading and renaming stay possible', async t => {
  const f = await setup(t); const saved = await f.store.create(f.get, f.input, f.snapshot);
  f.app.database.prepare("UPDATE sales_articles SET updated_at='2026-10-09T00:00:00.000Z'").run();
  assert.deepEqual(await f.store.get(f.get, f.input.id), saved);
  const renamed = await f.store.update(f.get, f.input.id, {version: 1, name: 'BEISPIEL historisch'});
  assert.deepEqual(renamed.snapshot, f.snapshot);
  await assert.rejects(f.store.update(f.get, f.input.id, {version: 2, name: 'BEISPIEL ersetzen'}, f.snapshot), {code: 'BWL_SIMULATION_SOURCE_CHANGED', status: 409});
  await assert.rejects(f.store.create(f.get, {id: crypto.randomUUID(), name: 'BEISPIEL alt'}, f.snapshot), {status: 409});
  assert.deepEqual(await f.store.create(f.get, f.input, f.snapshot), renamed);
  assert.equal(f.audits().length, 2);
});

test('simulation remove uses expected version, deletes encrypted chunks, and prevents UUID resurrection', async t => {
  const f = await setup(t); await f.store.create(f.get, f.input, f.snapshot);
  await assert.rejects(f.store.remove(f.get, f.input.id, {version: 2}), {status: 409});
  assert.deepEqual(await f.store.remove(f.get, f.input.id, {version: 1}), {removed: true});
  assert.equal(f.rows().length, 1); assert.deepEqual(await f.store.list(f.get), {variants: []});
  await assert.rejects(f.store.get(f.get, f.input.id), {status: 404});
  await assert.rejects(f.store.create(f.get, f.input, f.snapshot), {status: 409});
  assert.equal(f.audits().length, 2);
});

test('simulation concurrent create and updates allow idempotent retries or exactly one version writer', async t => {
  const f = await setup(t), second = create({access: f.app.provider, vault: f.vault});
  const both = await Promise.all([f.store.create(f.get, f.input, f.snapshot), second.create(f.get, f.input, f.snapshot)]);
  assert.deepEqual(both[0], both[1]); assert.equal(f.audits().length, 1);
  const raced = await Promise.allSettled([f.store.update(f.get, f.input.id, {version: 1, name: 'A'}), second.update(f.get, f.input.id, {version: 1, name: 'B'})]);
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(raced.find(r => r.status === 'rejected').reason.status, 409); assert.equal(f.audits().length, 2);
});

test('simulation withdrawn financial grants redact old fields/totals without rewriting the snapshot', async t => {
  const f = await setup(t); await f.store.create(f.get, f.input, f.snapshot); const previous = f.rows();
  f.state.session = {...f.state.session, permissions: f.state.session.permissions.filter(p => !['sales:articles:costs:read', 'sales:articles:prices:read'].includes(p))};
  const read = await f.store.get(f.get, f.input.id);
  assert.equal(read.snapshot.capabilities.prices, false); assert.equal(read.snapshot.capabilities.costs, false);
  assert.equal(Object.hasOwn(read.snapshot.rows[0], 'retailGross'), false); assert.equal(Object.hasOwn(read.snapshot.rows[0], 'averageCost'), false);
  assert.deepEqual(Object.keys(read.snapshot.summary.totals), ['scenarioQuantity']); assert.deepEqual(f.rows(), previous);
});

test('simulation organization/inactive/password-gated accounts and revoked location scope cannot read personal variants', async t => {
  const f = await setup(t); await f.store.create(f.get, f.input, f.snapshot);
  const actor = f.state.session;
  for (const patch of [{permissions: []}, {active: false}, {employeeActive: false}, {mustChangePassword: true}, {sessionKind: 'organization'}, {employeeNumber: ''}]) {
    await assert.rejects(f.store.list(async () => ({...actor, ...patch})), {status: 403});
  }
  const A = require('../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS;
  const scoped = {...actor, permissions: actor.permissions.filter(p => p !== A.COMPANY_READ), scopes: [{locationId: '19', departmentId: null}]};
  assert.equal(M.authority(scoped).stock.company, false);
  await assert.rejects(f.store.get(async () => scoped, f.input.id), {status: 403});
});

test('simulation late account/grant changes roll back chunks, indexes, manifests and audits', async t => {
  for (const at of [1, 2, 3]) {
    const f = await setup(t); let checks = 0;
    await assert.rejects(f.store.create(async tx => tx && ++checks >= at ? {...f.state.session, accountId: 'switched'} : f.state.session, f.input, f.snapshot), {status: 403});
    assert.equal(f.rows().length, 0); assert.equal(f.audits().length, 0);
  }
});

test('simulation ignored or failed audit writes roll back complete creates, updates and deletions', async t => {
  for (const op of ['create', 'update', 'remove']) {
    const f = await setup(t);
    if (op !== 'create') await f.store.create(f.get, f.input, f.snapshot);
    const previous = f.rows(), count = f.audits().length;
    f.app.database.exec("CREATE TRIGGER synthetic_simulation_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'trade.sales-bwl-simulation-variant.%' BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(op === 'create' ? f.store.create(f.get, f.input, f.snapshot) : op === 'update'
      ? f.store.update(f.get, f.input.id, {version: 1, name: 'BEISPIEL ändern'}, f.snapshot) : f.store.remove(f.get, f.input.id, {version: 1}), {status: 503});
    assert.deepEqual(f.rows(), previous); assert.equal(f.audits().length, count);
  }
});

test('simulation authenticated corrupt manifests/chunks and raw ciphertext fail closed without writes', async t => {
  const f = await setup(t); await f.store.create(f.get, f.input, f.snapshot);
  const manifest = f.rows().find(r => r.kind.endsWith('-variant')), valid = open(f, manifest);
  for (const bad of [{...valid, ownerId: 'other'}, {...valid, extra: 1}, {...valid, bytes: valid.bytes + 1}, {...valid, sha: 'a'.repeat(64)}, {...valid, chunkCount: 30}]) {
    seal(f, manifest, bad); await assert.rejects(f.store.get(f.get, f.input.id), {status: 503});
  }
  seal(f, manifest, valid);
  const chunk = f.rows().find(r => r.kind.endsWith('-chunk')), original = open(f, chunk);
  for (const bad of [{...original, index: 2}, {...original, data: original.data + '='}, {...original, ownerId: 'other'}]) {
    seal(f, chunk, bad); await assert.rejects(f.store.get(f.get, f.input.id), {status: 503});
  }
  f.app.database.prepare('UPDATE trade_annotations SET payload=? WHERE id=?').run('corrupt', chunk.id);
  await assert.rejects(f.store.list(f.get), {status: 503}); assert.equal(f.audits().length, 1);
});

test('simulation strict mutation shape, version bounds, UUIDs and variant count limits are enforced', async t => {
  const f = await setup(t);
  for (const bad of [{}, {...f.input, ownerId: 'x'}, {...f.input, id: 'not-a-uuid'}, {...f.input, name: ' '}, {...f.input, name: 'x'.repeat(121)}]) {
    await assert.rejects(f.store.create(f.get, bad, f.snapshot), {status: 422});
  }
  for (let i = 0; i < M.LIMITS.variants; i++) await f.store.create(f.get, {id: crypto.randomUUID(), name: 'BEISPIEL ' + i}, f.snapshot);
  await assert.rejects(f.store.create(f.get, f.input, f.snapshot), {status: 413});
  assert.equal((await f.store.list(f.get)).variants.length, 20);
});

test('simulation durable variants are readable through a fresh native SQLite provider connection', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-simulation-'));
  const f = await setup(t, {databasePath: path.join(dir, 'variants.sqlite')});
  t.after(() => {assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('gp-simulation-')); fs.rmSync(dir, {recursive: true, force: true});});
  const saved = await f.store.create(f.get, f.input, f.snapshot);
  const app = require('../lib/persistence/sqlite/provider').openSqliteApplicationPersistence({databasePath: path.join(dir, 'variants.sqlite'),
    catalog: require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG});
  try {assert.deepEqual(await create({access: app.provider, vault: f.vault}).get(f.get, f.input.id), saved);}
  finally {await app.provider.close(); app.database.close();}
});

test('simulation SQL delete CAS rolls back index, chunks and audit if item revision changes after reading', async t => {
  const f = await setup(t); await f.store.create(f.get, f.input, f.snapshot); const previous = f.rows();
  const row = previous.find(r => r.kind.endsWith('-variant')); let checks = 0;
  await assert.rejects(f.store.remove(async tx => {
    if (tx && ++checks === 2) await tx.execute(require('../lib/persistence/statements/trade-annotations').A.update,
      {...row, revision: row.revision + 1, expectedRevision: row.revision});
    return f.state.session;
  }, f.input.id, {version: 1}), {status: 409});
  assert.deepEqual(f.rows(), previous); assert.equal(f.audits().length, 1);
});

test('simulation listing without a managed key remains empty without provisioning a key', async t => {
  const f = await setup(t); f.app.database.exec('DELETE FROM data_import_runtime_keys');
  assert.deepEqual(await f.store.list(f.get), {variants: []});
  assert.equal(f.app.database.prepare('SELECT COUNT(*) AS count FROM data_import_runtime_keys').get().count, 0);
  await assert.rejects(f.store.get(f.get, f.input.id), {status: 404}); assert.equal(f.rows().length, 0);
});
