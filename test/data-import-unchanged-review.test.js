'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/data-import-contract');
const { createDataImportEngine } = require('../lib/data-import-engine');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportRepository } = require('../lib/persistence/repositories/data-import');
const { definePersistenceStatement } = require('../lib/persistence/contract');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_DATA_IMPORT_CATALOG } = require('../lib/persistence/sqlite/data-import-catalog');
const { ensureSqliteDataImportSchema } = require('../lib/persistence/sqlite/operations/data-import-schema');
const { measuredPersistence } = require('../test-support/measured-persistence');

const SHA = 'a'.repeat(64), AT = '2026-10-15T08:00:00.000Z';
const profile = C.defineDataImportProfile({
  id: 'unchanged-review-fixture', version: 1, entity: 'unchanged-review-fixture',
  sourceSystem: 'synthetic-source', sourceTable: 'SyntheticItems', schemaSha256: SHA,
  keyFields: ['Number'], excludedFields: [], dataClasses: ['customer_restricted'],
  fields: [
    { source: 'Number', target: 'number', type: 'identifier', nullable: false },
    { source: 'Label', target: 'label', type: 'text', nullable: false },
    { source: 'Amount', target: 'amount', type: 'decimal', scale: 2, nullable: false },
    { source: 'Note', target: null, type: 'text', nullable: true },
  ],
});
const columns = { id: 'text', revision: 'safe_integer', data: 'json' };
const def = (name, operation, parameters, result = {}) => definePersistenceStatement({
  id: 'unchanged-fixture.' + name, operation, parameters, columns: result,
});
const S = {
  read: def('read', 'queryOne', { id: 'text' }, columns),
  find: def('find', 'queryAll', { number: 'text' }, columns),
  create: def('create', 'execute', { id: 'text', number: 'text', data: 'json' }),
  update: def('update', 'execute', { id: 'text', expectedRevision: 'safe_integer', data: 'json' }),
  remove: def('remove', 'execute', { id: 'text', expectedRevision: 'safe_integer' }),
};
const catalog = [
  [S.read, 'SELECT id,revision,data FROM unchanged_targets WHERE id=$id'],
  [S.find, 'SELECT id,revision,data FROM unchanged_targets WHERE number=$number'],
  [S.create, 'INSERT INTO unchanged_targets(id,number,revision,data) VALUES($id,$number,1,$data)'],
  [S.update, 'UPDATE unchanged_targets SET revision=revision+1,data=$data WHERE id=$id AND revision=$expectedRevision'],
  [S.remove, 'DELETE FROM unchanged_targets WHERE id=$id AND revision=$expectedRevision'],
].map(([statement, sql]) => ({ statement, sql, returning: false }));
const row = (number = '0001', extra = {}) => ({ Number: number, Label: 'Synthetic item '.repeat(100), Amount: '12', Note: null, ...extra });
const code = expected => error => error?.code === expected;

function snapshotObserver() {
  const calls = [], state = { failFinish: false };
  const hooks = {
    async recordSnapshotRows(_tx, entries, context) { calls.push({kind:'rows',entries:structuredClone(entries),context}); },
    async finishSnapshot(_tx, context) { if(state.failFinish)C.fail('IMPORT_HISTORY_SNAPSHOT_INCOMPLETE',409); calls.push({kind:'finish',context}); },
    async withdrawSnapshot(_tx, context) { calls.push({kind:'withdraw',context}); },
  };
  return {calls,state,hooks};
}

async function fixture(t, { sharedPayloads = false, dependencies = false, operationBatchSize = 200, snapshotHooks = null } = {}) {
  const app = openSqliteApplicationPersistence({ databasePath: ':memory:', catalog: [...SQLITE_DATA_IMPORT_CATALOG, ...catalog] });
  ensureSqliteDataImportSchema(app.database);
  app.database.exec('CREATE TABLE unchanged_targets(id TEXT PRIMARY KEY,number TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL)');
  const keys = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 17), indexKey: Buffer.alloc(32, 19), keyId: 'unchanged-test-key' });
  const cryptoCalls = { seals: 0, blocks: 0 }, state = { rewrite: false, issue: '', token: SHA, readFailure: false, reviews: 0, denied: new Set() };
  const protection = { ...keys,
    seal(...args) { cryptoCalls.seals++; return keys.seal(...args); },
    sealBlock(...args) { cryptoCalls.blocks++; return keys.sealBlock(...args); },
  };
  const read = (tx, id) => {
    if (state.readFailure) C.fail('IMPORT_TARGET_INVALID');
    return tx.queryOne(S.read, { id });
  };
  const update = async (tx, input) => { assert.equal((await tx.execute(S.update, input)).rowsAffected, 1); return read(tx, input.id); };
  const writer = {
    ...snapshotHooks,
    read, findExisting: (tx, record) => tx.queryAll(S.find, { number: record.data.number }),
    async create(tx, { id, data }) { await tx.execute(S.create, { id, number: data.number, data }); return read(tx, id); },
    update, restore: update, canRemove: async () => true, canRestore: async () => true,
    remove: async (tx, input) => (await tx.execute(S.remove, input)).rowsAffected === 1,
    ...(dependencies ? { review: async () => { state.reviews++; return { issue: state.issue, token: state.token, rewrite: state.rewrite }; } } : {}),
  };
  const measured = measuredPersistence(app.provider);
  const composition = { repository: createDataImportRepository(measured.access), protection, profiles: [profile],
    writers: { [profile.entity]: writer }, sharedPayloads, operationBatchSize,
    getActor: () => ({ scopeId: 'unchanged-scope', ownerId: 'unchanged-owner' }),
    authorize: ({ action }) => !state.denied.has(action), clock: () => AT };
  let engine = createDataImportEngine(composition);
  t.after(async () => { keys.destroy(); await app.provider.close(); app.database.close(); });
  async function staged(rows, sha = SHA) {
    let run = await engine.start({ profileHash: profile.fingerprint, manifest: {
      sourceInstance: 'synthetic-instance', fileSha256: sha, schemaSha256: SHA,
      expectedRows: rows.length, declaredRows: rows.length, snapshotAt: AT, gates: [],
    } });
    run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: 1, rows });
    return engine.seal(run.id, run.revision);
  }
  async function finish(run, action) {
    let steps = 0;
    do { run = await engine[action](run.id, run.revision); assert.ok(++steps < 30); }
    while (run.status === ({ review: 'reviewing', apply: 'applying', undo: 'reverting' }[action]));
    return run;
  }
  async function ready(rows, sha) { return finish(await staged(rows, sha), 'review'); }
  function evidence(id) {
    return {
      rows: app.database.prepare('SELECT row_number,payload FROM data_import_rows WHERE run_id=? ORDER BY row_number').all(id),
      refs: app.database.prepare('SELECT * FROM data_import_row_payload_refs WHERE run_id=? ORDER BY row_number,slot').all(id),
      blocks: app.database.prepare('SELECT * FROM data_import_payload_blocks ORDER BY id').all(),
    };
  }
  const targets = () => app.database.prepare('SELECT id,revision,data FROM unchanged_targets ORDER BY number').all().map(item => ({ ...item, data: JSON.parse(item.data) }));
  return { ...app, state, cryptoCalls, measured, keys, composition, targets, staged, ready, finish, evidence,
    get engine() { return engine; }, restart() { engine = createDataImportEngine(composition); },
    resetMeasurements() { measured.counts.clear(); cryptoCalls.seals = 0; cryptoCalls.blocks = 0; state.reviews = 0; },
  };
}

for (const sharedPayloads of [false, true]) test(`unchanged review retains original evidence without encryption or reference writes (shared=${sharedPayloads})`, async t => {
  const f = await fixture(t, { sharedPayloads });
  const first = await f.finish(await f.ready([row()]), 'apply');
  let next = await f.staged([row()], 'b'.repeat(64));
  const before = f.evidence(next.id), targets = f.targets();
  const links = f.database.prepare('SELECT * FROM data_import_links').all();
  assert.equal(before.refs.length > 0, sharedPayloads);
  f.resetMeasurements();
  next = await f.finish(next, 'review');
  assert.equal(next.status, 'ready'); assert.deepEqual(next.counts, { unchanged: 1 });
  assert.deepEqual(f.evidence(next.id), before);
  assert.deepEqual(f.cryptoCalls, { seals: 0, blocks: 0 });
  assert.equal(f.measured.counts.get(S.read.id), 1, 'unchanged still authenticates the target');
  for (const id of ['data-import.row-payload-refs.delete', 'data-import.row-payload-refs.insert', 'data-import.payload-blocks.insert'])
    assert.equal(f.measured.counts.get(id) || 0, 0);
  assert.deepEqual((await f.engine.detail(next.id, 1)).proposed, targets[0].data);
  next = await f.finish(next, 'apply'); assert.equal(next.status, 'applied');
  assert.deepEqual(f.targets(), targets); assert.deepEqual(f.database.prepare('SELECT * FROM data_import_links').all(), links);
  assert.equal(f.database.prepare('SELECT count(*) n FROM data_import_changes WHERE run_id=?').get(next.id).n, 0);
  // An unchanged run neither owns the old link nor invents undo work.
  assert.deepEqual((await f.engine.undoPreview(next.id)).rows, []);
  await f.finish(first, 'undo'); assert.deepEqual(f.targets(), []);
});

test('snapshot hooks record exact reused revisions and finish or withdraw runs with no target changes',async t=>{
  const observer=snapshotObserver(),f=await fixture(t,{snapshotHooks:observer.hooks,sharedPayloads:true});
  await f.finish(await f.ready([row()]),'apply');
  const target=f.targets()[0];observer.calls.length=0;
  let next=await f.ready([row()],'b'.repeat(64));
  assert.deepEqual(next.counts,{unchanged:1});
  assert.deepEqual(observer.calls.map(c=>c.kind),['rows']);
  assert.deepEqual(observer.calls[0].entries,[{rowNumber:1,target}]);
  assert.equal(observer.calls[0].context.expectedRows,1);
  assert.equal(observer.calls[0].context.runId,next.id);
  next=await f.finish(next,'apply');
  assert.deepEqual(observer.calls.map(c=>c.kind),['rows','finish']);
  assert.equal(f.database.prepare('SELECT count(*) n FROM data_import_changes WHERE run_id=?').get(next.id).n,0);
  await f.finish(next,'undo');
  assert.deepEqual(observer.calls.map(c=>c.kind),['rows','finish','withdraw']);
  assert.deepEqual(f.targets(),[target]);
});

test('snapshot hooks cover refresh, source recheck and cancel without forcing a new business version',async t=>{
  const observer=snapshotObserver(),f=await fixture(t,{snapshotHooks:observer.hooks});
  await f.finish(await f.ready([row()]),'apply');const target=f.targets()[0];
  observer.calls.length=0;
  let next=await f.ready([row('0001',{Note:'source-only change'})],'b'.repeat(64));
  assert.deepEqual(next.counts,{refresh:1});assert.deepEqual(observer.calls,[]);
  next=await f.finish(next,'apply');
  assert.deepEqual(observer.calls.map(c=>c.kind),['rows','finish']);
  assert.deepEqual(observer.calls[0].entries,[{rowNumber:1,target}]);
  observer.calls.length=0;
  let third=await f.ready([row('0001',{Note:'source-only change'})],'c'.repeat(64));
  third=await f.engine.recheck(third.id,third.revision);third=await f.finish(third,'review');
  assert.deepEqual(observer.calls.map(c=>c.kind),['rows','rows']);
  assert.deepEqual(observer.calls[0].entries,observer.calls[1].entries);
  assert.equal((await f.engine.cancel(third.id,third.revision)).status,'cancelled');
  assert.equal(observer.calls.at(-1).kind,'withdraw');assert.deepEqual(f.targets(),[target]);
});

test('snapshot completion failure rolls back business changes and can be resumed',async t=>{
  const observer=snapshotObserver(),f=await fixture(t,{snapshotHooks:observer.hooks});
  let first=await f.ready([row()]);observer.state.failFinish=true;
  await assert.rejects(f.engine.apply(first.id,first.revision),code('IMPORT_HISTORY_SNAPSHOT_INCOMPLETE'));
  assert.deepEqual(f.targets(),[]);assert.equal((await f.engine.checkpoint(first.id)).revision,first.revision);
  observer.state.failFinish=false;first=await f.finish(first,'apply');assert.equal(first.status,'applied');
  observer.calls.length=0;
  let next=await f.ready([row('0001',{Amount:'24'})],'b'.repeat(64));assert.equal(next.counts.update,1);
  next=await f.finish(next,'apply');
  assert.equal(observer.calls[0].entries[0].target.revision,2);
  assert.equal(observer.calls[0].entries[0].target.data.amount,'24.00');
});

test('snapshot hooks are an all-or-nothing writer contract',async t=>{
  const f=await fixture(t),writer=f.composition.writers[profile.entity];
  assert.throws(()=>createDataImportEngine({...f.composition,writers:{[profile.entity]:{...writer,recordSnapshotRows:async()=>{}}}}),code('IMPORT_WRITER_INVALID'));
});

test('unchanged recheck survives reconstruction and still preserves manual target fields', async t => {
  const f = await fixture(t, { sharedPayloads: true, operationBatchSize: 1 });
  await f.finish(await f.ready([row('1'), row('2')]), 'apply');
  const target = f.targets()[0];
  await f.provider.execute(S.update, { id: target.id, expectedRevision: target.revision, data: { ...target.data, label: 'Manual title' } });
  let next = await f.ready([row('1'), row('2')], 'b'.repeat(64));
  const before = f.evidence(next.id);
  next = await f.engine.recheck(next.id, next.revision);
  await assert.rejects(f.engine.apply(next.id, next.revision), code('IMPORT_PREVIEW_INCOMPLETE'));
  f.restart();
  next = await f.engine.recheck(next.id, next.revision);
  next = await f.finish(next, 'review');
  assert.deepEqual(next.counts, { unchanged: 2 }); assert.deepEqual(f.evidence(next.id), before);
  await f.finish(next, 'apply'); assert.equal(f.targets()[0].data.label, 'Manual title');
  let changed = await f.ready([row('1', { Amount: '24' }), row('2')], 'c'.repeat(64));
  assert.deepEqual(changed.counts, { unchanged: 1, update: 1 });
  changed = await f.finish(changed, 'apply');
  assert.equal(f.targets()[0].data.label, 'Manual title'); assert.equal(f.targets()[0].data.amount, '24.00');
  const conflict = await f.ready([row('1', { Amount: '24', Label: 'Source title' })], 'd'.repeat(64));
  assert.equal(conflict.status, 'needs_review');
  assert.equal((await f.engine.preview(conflict.id)).rows[0].issue, 'MANUAL_FIELD_CONFLICT');
});

test('same source hash does not hide a missing or unreadable linked target', async t => {
  const f = await fixture(t);
  await f.finish(await f.ready([row()]), 'apply');
  let next = await f.staged([row()], 'b'.repeat(64));
  f.state.readFailure = true;
  await assert.rejects(f.engine.review(next.id, next.revision), code('IMPORT_TARGET_INVALID'));
  assert.equal((await f.engine.checkpoint(next.id)).revision, next.revision);
  f.state.readFailure = false;
  f.database.exec('DELETE FROM unchanged_targets');
  next = await f.finish(next, 'review');
  assert.equal(next.status, 'needs_review'); assert.equal(next.counts.conflict, 1);
  assert.equal((await f.engine.preview(next.id)).rows[0].issue, 'LINKED_TARGET_MISSING');
});

test('dependency issues and rewrites take precedence over a matching source hash', async t => {
  const f = await fixture(t, { dependencies: true, sharedPayloads: true });
  await f.finish(await f.ready([row()]), 'apply');
  f.state.issue = 'HISTORY_PARENT_REQUIRED';
  let next = await f.ready([row()], 'b'.repeat(64));
  assert.equal(next.counts.conflict, 1);
  assert.equal((await f.engine.preview(next.id)).rows[0].issue, 'HISTORY_PARENT_REQUIRED');
  f.state.issue = ''; f.state.rewrite = true;
  next = await f.engine.recheck(next.id, next.revision); next = await f.finish(next, 'review');
  assert.deepEqual(next.counts, { update: 1 });
  f.state.token = 'c'.repeat(64);
  await assert.rejects(f.engine.apply(next.id, next.revision), code('IMPORT_DEPENDENCIES_CHANGED'));
  next = await f.engine.recheck(next.id, next.revision); next = await f.finish(next, 'review');
  await f.finish(next, 'apply'); assert.equal(f.targets()[0].revision, 2);
  f.state.rewrite = false;
  let third = await f.ready([row()], 'd'.repeat(64)); assert.equal(third.counts.unchanged, 1);
  f.state.issue = 'HISTORY_PARENT_REQUIRED';
  third = await f.engine.recheck(third.id, third.revision); third = await f.finish(third, 'review');
  assert.equal(third.counts.conflict, 1, 'recheck does not trust the previous unchanged state');
});

test('source-only changes still refresh provenance without rewriting the target', async t => {
  const f = await fixture(t, { sharedPayloads: true });
  await f.finish(await f.ready([row()]), 'apply');
  const targets = f.targets(), link = f.database.prepare('SELECT * FROM data_import_links').get();
  let next = await f.staged([row('0001', { Note: 'New source-only note' })], 'b'.repeat(64));
  const before = f.evidence(next.id).rows;
  next = await f.finish(next, 'review'); assert.equal(next.counts.refresh, 1);
  assert.notDeepEqual(f.evidence(next.id).rows, before);
  next = await f.finish(next, 'apply'); assert.deepEqual(f.targets(), targets);
  assert.equal(f.database.prepare('SELECT last_run_id FROM data_import_links').get().last_run_id, next.id);
  await f.finish(next, 'undo');
  assert.equal(f.database.prepare('SELECT last_run_id FROM data_import_links').get().last_run_id, link.last_run_id);
});

test('a mixed review packet keeps only unchanged evidence and preserves changes, counts and undo', async t => {
  const f = await fixture(t, { sharedPayloads: true });
  await f.finish(await f.ready([row('1'), row('2'), row('3')]), 'apply');
  let next = await f.staged([row('1'), row('2', { Amount: '42' }), row('3', { Note: 'Source detail' }), row('4')], 'b'.repeat(64));
  const before = f.evidence(next.id);
  next = await f.finish(next, 'review');
  assert.deepEqual(next.counts, { create: 1, refresh: 1, unchanged: 1, update: 1 });
  const after = f.evidence(next.id);
  assert.deepEqual(after.rows[0], before.rows[0]);
  assert.deepEqual(after.refs.filter(ref => ref.row_number === 1), before.refs.filter(ref => ref.row_number === 1));
  for (let index = 1; index < 4; index++) assert.notEqual(after.rows[index].payload, before.rows[index].payload);
  next = await f.finish(next, 'apply'); assert.deepEqual(next.counts, { applied: 3, unchanged: 1 });
  assert.equal(f.targets().length, 4); assert.equal(f.targets()[1].data.amount, '42.00');
  assert.equal(f.database.prepare('SELECT count(*) n FROM data_import_changes WHERE run_id=?').get(next.id).n, 3);
  await f.finish(next, 'undo'); assert.equal(f.targets().length, 3); assert.equal(f.targets()[1].data.amount, '12.00');
  const counted = f.database.prepare('SELECT state,count(*) count FROM data_import_rows WHERE run_id=? GROUP BY state ORDER BY state').all(next.id);
  assert.deepEqual(counted, f.database.prepare('SELECT state,count FROM data_import_run_state_counts WHERE run_id=? ORDER BY state').all(next.id));
});

test('a previously encoded create plan can become unchanged without retaining apply authority', async t => {
  const f = await fixture(t, { sharedPayloads: true });
  let earlier = await f.ready([row()]); assert.equal(earlier.counts.create, 1);
  const evidence = f.evidence(earlier.id);
  await f.finish(await f.ready([row()], 'b'.repeat(64)), 'apply');
  earlier = await f.engine.recheck(earlier.id, earlier.revision);
  earlier = await f.finish(earlier, 'review'); assert.equal(earlier.counts.unchanged, 1);
  // Old encrypted plans remain readable, but the durable row state owns the
  // apply queue. A stale create plan cannot create a second target.
  assert.deepEqual(f.evidence(earlier.id).rows, evidence.rows);
  assert.deepEqual(f.evidence(earlier.id).refs, evidence.refs);
  f.restart(); earlier = await f.finish(earlier, 'apply');
  assert.equal(earlier.status, 'applied'); assert.equal(f.targets().length, 1);
  assert.equal(f.database.prepare('SELECT count(*) n FROM data_import_changes WHERE run_id=?').get(earlier.id).n, 0);
  assert.deepEqual((await f.engine.detail(earlier.id, 1)).proposed, f.targets()[0].data);
});

for (const defect of ['row-payload', 'row-hash', 'link-payload', 'shared-ref']) test(`unchanged review fails closed on ${defect} tampering`, async t => {
  const f = await fixture(t, { sharedPayloads: defect === 'shared-ref' });
  await f.finish(await f.ready([row()]), 'apply');
  const next = await f.staged([row()], 'b'.repeat(64));
  if (defect === 'row-payload') f.database.prepare("UPDATE data_import_rows SET payload='invalid' WHERE run_id=?").run(next.id);
  if (defect === 'row-hash') f.database.prepare('UPDATE data_import_rows SET content_hash=? WHERE run_id=?').run('f'.repeat(64), next.id);
  if (defect === 'link-payload') f.database.exec("UPDATE data_import_links SET payload='invalid'");
  if (defect === 'shared-ref') f.database.prepare('DELETE FROM data_import_row_payload_refs WHERE run_id=?').run(next.id);
  await assert.rejects(f.engine.review(next.id, next.revision), error => /^IMPORT_(?:PROTECTED|ROW_INTEGRITY|EVIDENCE)/.test(error?.code));
  assert.equal((await f.engine.checkpoint(next.id)).revision, next.revision);
  assert.equal((await f.engine.preview(next.id)).counts.staged, 1);
  assert.equal(f.targets()[0].revision, 1);
});

test('revoked review permission does not turn matching source rows into accepted checkpoints', async t => {
  const f = await fixture(t);
  await f.finish(await f.ready([row()]), 'apply');
  const next = await f.staged([row()], 'b'.repeat(64)), before = f.evidence(next.id);
  f.state.denied.add('review');
  await assert.rejects(f.engine.review(next.id, next.revision), code('IMPORT_FORBIDDEN'));
  assert.deepEqual(f.evidence(next.id), before); assert.equal((await f.engine.checkpoint(next.id)).revision, next.revision);
});
