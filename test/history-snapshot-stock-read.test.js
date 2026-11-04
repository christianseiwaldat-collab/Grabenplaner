'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('../test-support/trade-insights-sqlite');
const { historyPage } = require('../lib/persistence/repositories/history-page');
const { createImportHistoryService } = require('../lib/persistence/repositories/import-history');
const { IMPORT_MASTER_STATEMENTS: M } = require('../lib/persistence/statements/import-master-data');
const Stock = require('../lib/persistence/statements/branch-article-stock');
const W = require('../lib/persistence/statements/sales-article-workspace');
const Report = require('../lib/sales-article-report-statements');
const scopeId = 'grabenplaner-main', sourceInstance = 'tradefoto-trade';
async function prepare(t) {
  const f = await fixture(t);
  await f.ingest('ARTIKEL_STAMM', ['000042', '000043'].map(EAN => ({ EAN, Artikelbezeichnung: 'Synthetic ' + EAN,
    Sachkonto: false, OhneBestand: false, DurchschnittEK: '10' })), { master: true });
  const rows = [{ EAN: '000042', FilialID: 18, FBestand: '2' }, { EAN: '000042', FilialID: 19, FBestand: '4' },
    { EAN: '000043', FilialID: 18, FBestand: '7' }];
  const ingest = (values, hour) => f.ingest('ARTIKEL_FILIALEN', values, { sourceInstance, snapshotAt: `2026-09-14T${hour}:00:00.000Z` });
  const first = await ingest(rows, '10'), unchanged = await ingest(rows, '11');
  assert.equal(f.app.database.prepare("SELECT count(*) AS n FROM import_history_versions v JOIN import_history_records r ON r.id=v.record_id WHERE r.source_table='ARTIKEL_FILIALEN'").get().n, 3);
  const changed = await ingest([{ ...rows[0], FBestand: '9' }, rows[2]], '12');
  const lookup = (table, key) => f.app.provider.queryOne(M.find, { scopeId,
    identityHash: require('../lib/tradefoto-master-profiles').masterIdentity(f.protection, { scopeId, sourceInstance }, table, [key]) });
  return { ...f, ingest, first, unchanged, changed, article: await lookup('ARTIKEL_STAMM', '000042'), location: await lookup('FILIALEN', '18') };
}
const listParameters = snapshot => ({ scopeId, sourceInstance, source: 'trade', sourceTable: 'ARTIKEL_FILIALEN', snapshot, after: '', limit: 100 });
async function partialFixture(t) {
  const f = await fixture(t);
  await f.ingest('ARTIKEL_STAMM', ['000042', '000043'].map(EAN => ({ EAN, Artikelbezeichnung: 'Synthetic ' + EAN,
    Sachkonto: false, OhneBestand: false, DurchschnittEK: '10' })), { master: true });
  const snapshots = await require('../test-support/article-stock-snapshots-fixture').snapshotFixture(t,
    { access: f.app.provider, protection: f.protection, scopeId, ownerId: 'synthetic-owner', batchSize: 1 });
  const rows = [{ EAN: '000042', FilialID: 18, FBestand: '2' }, { EAN: '000043', FilialID: 18, FBestand: '7' }];
  return { f, snapshots, rows };
}
test('Snapshot readers keep the selected old revision after later changes and exclude removed pairs in every stock SQL family', async t => {
  const f = await prepare(t), base = { scopeId, sourceInstance, articleHash: 'unbound', masterRecordId: f.article.id, limit: 100 };
  for (const statement of [Stock.articleStock, W.articleStock]) {
    const old = await f.app.provider.queryAll(statement, { ...base, snapshot: f.unchanged.id });
    const latest = await f.app.provider.queryAll(statement, { ...base, snapshot: f.changed.id });
    assert.equal(old.length, 2); assert.ok(old.every(row => row.revision === 1));
    assert.equal(latest.length, 1); assert.equal(latest[0].revision, 2);
  }
  for (const run of [f.unchanged, f.changed]) {
    const pair = await f.app.provider.queryAll(Stock.articleBranchStock,
      { scopeId, snapshot: run.id, articleMaster: f.article.id, locationMaster: f.location.id });
    const report = await f.app.provider.queryAll(Report.stockCandidates,
      { scopeId, snapshot: run.id, articles: [f.article.id], locations: [f.location.id], after: '', limit: 100 });
    assert.deepEqual(report, pair); assert.equal(pair[0].revision, run.id === f.unchanged.id ? 1 : 2);
    const branch = await f.app.provider.queryAll(Stock.branchStock, { scopeId, snapshot: run.id, locationHash: 'unbound', after: '', limit: 100,
      ...Object.fromEntries(Array.from({ length: 32 }, (_, index) => ['master' + index, index === 0 ? f.location.id : ''])) });
    assert.equal(branch.length, 2); assert.ok(branch.some(row => row.id === pair[0].id && row.revision === pair[0].revision));
  }
  await f.app.provider.transaction(async tx => {
    const page = await historyPage(tx, listParameters(f.unchanged.id));
    const record = [...page.records.values()].find(header => header.revision === 2);
    assert.ok(record, 'The real current header must remain revision two');
    assert.equal(page.selectedRevisions.get(record.id), 1);
    const service = createImportHistoryService({ access: f.app.provider, executor: tx, protection: f.protection, prefetched: page,
      getActor: () => ({ scopeId, ownerId: 'synthetic-owner' }), authorize: () => true });
    const detail = await service.detail(record.id, { snapshot: f.unchanged.id });
    assert.equal(detail.revision, 1); assert.equal(detail.fields.FBestand, '2');
    assert.equal(detail.provenance.runId, f.first.id);
    assert.equal(detail.snapshot.runId, f.unchanged.id);
    assert.notEqual(detail.snapshot.fileSha256, detail.provenance.fileSha256);
    const listed = await service.list({ source: 'trade', table: 'ARTIKEL_FILIALEN', sourceInstance, snapshot: f.unchanged.id });
    assert.equal(listed.items.length, 3);
    assert.ok(listed.items.every(item => item.revision === 1 && item.snapshot.runId === f.unchanged.id));
  }, { isolation: 'serializable', readOnly: true });
  const inventory = await f.run('inventory');
  assert.equal(inventory.rows.length, 2);
  assert.equal(inventory.rows.find(row => row.articleNumber === '000042').stock, '9');
  assert.equal(inventory.sourceDate, '2026-09-14T12:00:00.000Z');
  assert.ok(inventory.rows.every(row => row.sourceDate === inventory.sourceDate));
  const summary = await f.run('stock-summary'); assert.equal(summary.totals.quantity, '16');
});

test('A published snapshot reads an unchanged version committed by a still applying producer', async t => {
  const { f, snapshots, rows } = await partialFixture(t);
  const producer = await snapshots.ready('ARTIKEL_FILIALEN', rows, { snapshotAt: '2026-09-14T10:00:00.000Z' });
  const partial = await snapshots.engine.apply(producer.id, producer.revision);
  assert.equal(partial.status, 'applying');
  const selected = await snapshots.ingest('ARTIKEL_FILIALEN', [rows[0]], { snapshotAt: '2026-09-14T11:00:00.000Z' });
  assert.equal(selected.counts.unchanged, 1);
  const detail = (await snapshots.list(selected)).items[0];
  assert.equal(detail.provenance.runId, producer.id);
  assert.equal(detail.snapshot.runId, selected.id);
  assert.equal((await snapshots.engine.checkpoint(producer.id)).status, 'applying');
  const inventory = await f.run('inventory');
  assert.equal(inventory.rows.length, 1);
  assert.equal(inventory.rows[0].stock, '2');
  assert.equal(inventory.rows[0].sourceDate, '2026-09-14T11:00:00.000Z');
  assert.equal((await f.run('stock-summary')).totals.quantity, '2');
});

test('A published snapshot reads an unchanged restoration while its producer is still reverting', async t => {
  const { f, snapshots, rows } = await partialFixture(t);
  await snapshots.ingest('ARTIKEL_FILIALEN', rows, { snapshotAt: '2026-09-14T10:00:00.000Z' });
  const producer = await snapshots.ingest('ARTIKEL_FILIALEN', rows.map(row => ({ ...row, FBestand: '9' })),
    { snapshotAt: '2026-09-14T11:00:00.000Z' });
  const partial = await snapshots.engine.undo(producer.id, producer.revision);
  assert.equal(partial.status, 'reverting');
  const selected = await snapshots.ingest('ARTIKEL_FILIALEN', [rows[1]], { snapshotAt: '2026-09-14T12:00:00.000Z' });
  assert.equal(selected.counts.unchanged, 1);
  const detail = (await snapshots.list(selected)).items[0];
  assert.equal(detail.provenance.runId, producer.id);
  assert.equal(detail.provenance.restoredFromRevision, 1);
  assert.equal(detail.snapshot.runId, selected.id);
  assert.equal((await snapshots.engine.checkpoint(producer.id)).status, 'reverting');
  const inventory = await f.run('inventory');
  assert.equal(inventory.rows.length, 1);
  assert.equal(inventory.rows[0].stock, '7');
  assert.equal(inventory.rows[0].sourceDate, '2026-09-14T12:00:00.000Z');
  assert.equal((await f.run('stock-summary')).totals.quantity, '7');
});
test('A published empty snapshot stays empty and missing publication members fail closed', async t => {
  const f = await prepare(t), db = f.app.database;
  const removed = db.prepare('SELECT * FROM import_history_snapshot_members WHERE run_id=? ORDER BY row_number LIMIT 1').get(f.changed.id);
  db.prepare('DELETE FROM import_history_snapshot_members WHERE run_id=? AND row_number=?').run(removed.run_id, removed.row_number);
  await assert.rejects(f.run('inventory'), error => error.code === 'IMPORT_HISTORY_SNAPSHOT_INCOMPLETE');
  db.prepare('INSERT INTO import_history_snapshot_members VALUES(?,?,?,?,?)').run(removed.run_id, removed.row_number, removed.record_id, removed.revision, removed.payload);
  const empty = await f.ingest([], '13');
  assert.equal((await f.run('inventory')).rows.length, 0);
  assert.equal((await f.run('stock-summary')).totals.positions, 0);
  const page = await f.app.provider.transaction(tx => historyPage(tx, listParameters(empty.id)));
  assert.equal(page.records.size, 0);
  assert.ok(db.prepare("SELECT count(*) AS n FROM import_history_records WHERE source_table='ARTIKEL_FILIALEN'").get().n > 0);
  const previous = await f.app.provider.transaction(tx => historyPage(tx, listParameters(f.unchanged.id)));
  assert.equal(previous.records.size, 3);
});
