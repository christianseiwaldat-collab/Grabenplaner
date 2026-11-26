'use strict';
// The projection and its cursors use a private native PostgreSQL cluster.
const test = require('node:test'), assert = require('node:assert/strict');
const cluster = require('../test-support/postgresql-recovery-cluster').recoveryCluster(test);
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const C = require('../lib/data-import-contract'), M = require('../lib/tradefoto-master-profiles'), H = require('../lib/tradefoto-history-profiles');
const { definitions } = require('../lib/tradefoto-full-import-source'), { SOURCE_KINDS } = require('../lib/data-import-source-catalog');
const { createDataImportProtection } = require('../lib/data-import-protection');
const P = require('../lib/persistence/postgresql/operations/access-owned-state');
const TIME = '2026-11-16T12:00:00.000Z', sha = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const DDL = `
CREATE SCHEMA integration; CREATE SCHEMA trade;
CREATE TABLE integration.data_import_runs(id TEXT PRIMARY KEY,scope_id TEXT,owner_id TEXT,profile_hash TEXT,manifest TEXT,status TEXT,attempt_id TEXT NOT NULL DEFAULT 'default');
CREATE TABLE integration.data_import_events(id TEXT PRIMARY KEY,run_id TEXT,action TEXT);
CREATE TABLE integration.data_import_rows(run_id TEXT,row_number INTEGER,identity_hash TEXT,payload TEXT,state TEXT,PRIMARY KEY(run_id,row_number));
CREATE TABLE integration.data_import_changes(run_id TEXT,row_number INTEGER,identity_hash TEXT,payload TEXT,reverted_at TEXT,PRIMARY KEY(run_id,row_number));
CREATE TABLE integration.data_import_links(id TEXT PRIMARY KEY,scope_id TEXT,entity TEXT,target_id TEXT,revision INTEGER,last_run_id TEXT,payload TEXT);
CREATE TABLE integration.data_import_payload_blocks(id TEXT PRIMARY KEY,scope_id TEXT,owner_id TEXT,profile_hash TEXT,source_system TEXT,source_instance TEXT,source_table TEXT,entity TEXT,block_type TEXT,payload TEXT);
CREATE TABLE integration.data_import_row_payload_refs(run_id TEXT,row_number INTEGER,slot TEXT,block_id TEXT,PRIMARY KEY(run_id,row_number,slot));
CREATE TABLE integration.data_import_change_payload_refs(run_id TEXT,row_number INTEGER,slot TEXT,block_id TEXT,PRIMARY KEY(run_id,row_number,slot));
CREATE TABLE integration.data_import_run_state_counts(run_id TEXT,state TEXT,count INTEGER,PRIMARY KEY(run_id,state));
CREATE TABLE trade.import_master_records(id TEXT PRIMARY KEY,scope_id TEXT,source_instance TEXT,source_table TEXT,profile_hash TEXT,identity_hash TEXT UNIQUE,revision INTEGER,updated_by TEXT,updated_at TEXT);
CREATE TABLE trade.import_master_segments(record_id TEXT,kind TEXT,data_class TEXT,payload TEXT,PRIMARY KEY(record_id,kind,data_class));
CREATE TABLE trade.import_master_relations(record_id TEXT,slot INTEGER,parent_table TEXT,identity_hash TEXT,state TEXT,evidence TEXT,PRIMARY KEY(record_id,slot));
CREATE TABLE trade.import_master_bindings(record_id TEXT PRIMARY KEY);
CREATE TABLE trade.import_master_events(id TEXT PRIMARY KEY,record_id TEXT);
CREATE TABLE trade.import_master_holds(record_id TEXT,consumer_id TEXT,PRIMARY KEY(record_id,consumer_id));
CREATE TABLE integration.import_history_records(id TEXT PRIMARY KEY,scope_id TEXT,source_instance TEXT,source TEXT,source_table TEXT,profile_hash TEXT,identity_hash TEXT UNIQUE,revision INTEGER);
CREATE TABLE integration.import_history_versions(record_id TEXT,revision INTEGER,file_sha256 TEXT,snapshot_at TEXT,imported_by TEXT,imported_at TEXT,run_id TEXT,master_source_instance TEXT,business_date TEXT,parent_id TEXT,parent_revision INTEGER,payload TEXT,PRIMARY KEY(record_id,revision));
CREATE TABLE integration.import_history_segments(record_id TEXT,revision INTEGER,data_class TEXT,payload TEXT,PRIMARY KEY(record_id,revision,data_class));
CREATE TABLE integration.import_history_references(record_id TEXT,revision INTEGER,role TEXT,data_class TEXT,master_record_id TEXT,lookup_hash TEXT,PRIMARY KEY(record_id,revision,role));
CREATE TABLE integration.import_history_holds(record_id TEXT,consumer_id TEXT,PRIMARY KEY(record_id,consumer_id));
CREATE TABLE integration.import_history_snapshots(run_id TEXT PRIMARY KEY,scope_id TEXT,source_instance TEXT,profile_hash TEXT,file_sha256 TEXT,snapshot_at TEXT,owner_id TEXT,expected_rows INTEGER,status TEXT,payload TEXT);
CREATE TABLE integration.import_history_snapshot_members(run_id TEXT,row_number INTEGER,record_id TEXT,revision INTEGER,payload TEXT,PRIMARY KEY(run_id,row_number));
CREATE TABLE integration.import_history_snapshot_attestations(run_id TEXT PRIMARY KEY,header_payload TEXT);
CREATE TABLE trade.sales_article_import_snapshots(id TEXT PRIMARY KEY,source_system TEXT,source_file_sha256 TEXT);
CREATE TABLE trade.sales_articles(product_id TEXT PRIMARY KEY,article_number TEXT,current_revision INTEGER);
CREATE TABLE trade.sales_article_revisions(product_id TEXT,revision INTEGER,article_number TEXT,description TEXT,active INTEGER,source_snapshot_id TEXT,PRIMARY KEY(product_id,revision),UNIQUE(source_snapshot_id,product_id));
CREATE TABLE trade.sales_article_price_snapshots(id TEXT PRIMARY KEY,product_id TEXT,source_snapshot_id TEXT,amount TEXT,source_field TEXT);
CREATE TABLE trade.sales_article_identifiers(id TEXT PRIMARY KEY,product_id TEXT,source_snapshot_id TEXT,identifier_value TEXT);
CREATE TABLE trade.sales_article_import_impacts(snapshot_id TEXT,ordinal INTEGER,product_id TEXT,imported_revision INTEGER,previous_current_revision INTEGER,PRIMARY KEY(snapshot_id,ordinal));
CREATE TABLE trade.sales_article_import_findings(snapshot_id TEXT,ordinal INTEGER,code TEXT,PRIMARY KEY(snapshot_id,ordinal));
CREATE TABLE trade.sales_article_own_images(article_number TEXT PRIMARY KEY,content bytea);
CREATE TABLE integration.own_unknown_notes(id TEXT PRIMARY KEY,note TEXT);
`;
const FOREIGN_KEYS = `
ALTER TABLE integration.data_import_events ADD FOREIGN KEY (run_id) REFERENCES integration.data_import_runs(id);
ALTER TABLE integration.data_import_rows ADD FOREIGN KEY (run_id) REFERENCES integration.data_import_runs(id);
ALTER TABLE integration.data_import_changes ADD FOREIGN KEY (run_id,row_number) REFERENCES integration.data_import_rows(run_id,row_number);
ALTER TABLE integration.data_import_links ADD FOREIGN KEY (last_run_id) REFERENCES integration.data_import_runs(id);
ALTER TABLE integration.data_import_row_payload_refs ADD FOREIGN KEY (block_id) REFERENCES integration.data_import_payload_blocks(id);
ALTER TABLE integration.data_import_row_payload_refs ADD FOREIGN KEY (run_id,row_number) REFERENCES integration.data_import_rows(run_id,row_number);
ALTER TABLE integration.data_import_change_payload_refs ADD FOREIGN KEY (block_id) REFERENCES integration.data_import_payload_blocks(id);
ALTER TABLE integration.data_import_change_payload_refs ADD FOREIGN KEY (run_id,row_number) REFERENCES integration.data_import_changes(run_id,row_number);
ALTER TABLE integration.data_import_run_state_counts ADD FOREIGN KEY (run_id) REFERENCES integration.data_import_runs(id);
ALTER TABLE trade.import_master_segments ADD FOREIGN KEY (record_id) REFERENCES trade.import_master_records(id);
ALTER TABLE trade.import_master_relations ADD FOREIGN KEY (record_id) REFERENCES trade.import_master_records(id);
ALTER TABLE trade.import_master_bindings ADD FOREIGN KEY (record_id) REFERENCES trade.import_master_records(id);
ALTER TABLE trade.import_master_holds ADD FOREIGN KEY (record_id) REFERENCES trade.import_master_records(id);
ALTER TABLE integration.import_history_versions ADD FOREIGN KEY (record_id) REFERENCES integration.import_history_records(id);
ALTER TABLE integration.import_history_versions ADD FOREIGN KEY (parent_id,parent_revision) REFERENCES integration.import_history_versions(record_id,revision);
ALTER TABLE integration.import_history_segments ADD FOREIGN KEY (record_id,revision) REFERENCES integration.import_history_versions(record_id,revision);
ALTER TABLE integration.import_history_references ADD FOREIGN KEY (master_record_id) REFERENCES trade.import_master_records(id);
ALTER TABLE integration.import_history_references ADD FOREIGN KEY (record_id,revision) REFERENCES integration.import_history_versions(record_id,revision);
ALTER TABLE integration.import_history_holds ADD FOREIGN KEY (record_id) REFERENCES integration.import_history_records(id);
ALTER TABLE integration.import_history_snapshot_members ADD FOREIGN KEY (run_id) REFERENCES integration.import_history_snapshots(run_id);
ALTER TABLE integration.import_history_snapshot_members ADD FOREIGN KEY (record_id,revision) REFERENCES integration.import_history_versions(record_id,revision);
ALTER TABLE integration.import_history_snapshot_attestations ADD FOREIGN KEY (run_id) REFERENCES integration.import_history_snapshots(run_id);
ALTER TABLE trade.sales_articles ADD FOREIGN KEY (product_id,current_revision) REFERENCES trade.sales_article_revisions(product_id,revision);
ALTER TABLE trade.sales_article_revisions ADD FOREIGN KEY (product_id) REFERENCES trade.sales_articles(product_id);
ALTER TABLE trade.sales_article_revisions ADD FOREIGN KEY (source_snapshot_id) REFERENCES trade.sales_article_import_snapshots(id);
ALTER TABLE trade.sales_article_price_snapshots ADD FOREIGN KEY (source_snapshot_id,product_id) REFERENCES trade.sales_article_revisions(source_snapshot_id,product_id);
ALTER TABLE trade.sales_article_identifiers ADD FOREIGN KEY (product_id) REFERENCES trade.sales_articles(product_id);
ALTER TABLE trade.sales_article_identifiers ADD FOREIGN KEY (source_snapshot_id) REFERENCES trade.sales_article_import_snapshots(id);
ALTER TABLE trade.sales_article_import_impacts ADD FOREIGN KEY (snapshot_id) REFERENCES trade.sales_article_import_snapshots(id);
ALTER TABLE trade.sales_article_import_impacts ADD FOREIGN KEY (product_id,imported_revision) REFERENCES trade.sales_article_revisions(product_id,revision);
ALTER TABLE trade.sales_article_import_impacts ADD FOREIGN KEY (product_id,previous_current_revision) REFERENCES trade.sales_article_revisions(product_id,revision);
ALTER TABLE trade.sales_article_import_findings ADD FOREIGN KEY (snapshot_id) REFERENCES trade.sales_article_import_snapshots(id);
`;
async function rows(db, sql, parameters = []) { return (await db.query(sql, parameters)).rows; }
async function row(db, sql, parameters = []) { return (await rows(db, sql, parameters))[0]; }
async function insert(db, table, values) {
  const fields = Object.keys(values), parameters = fields.map((_, index) => '$' + (index + 1));
  await db.query('INSERT INTO ' + table + '(' + fields.join(',') + ') VALUES(' + parameters.join(',') + ')', fields.map(field => values[field]));
}
async function salesDatabase(t, strictRunKeys = false) {
  const { client } = await cluster.database(t);
  // Historical fixtures include a nullable composite reference.
  const schema = strictRunKeys ? DDL : DDL.replace('identity_hash TEXT,payload TEXT,state TEXT,PRIMARY KEY(run_id,row_number)', 'identity_hash TEXT,payload TEXT,state TEXT,UNIQUE(run_id,row_number)');
  await client.query(schema);
  await client.query('SET search_path=pg_catalog,trade,integration');
  return client;
}
async function exportState(f) {
  await f.sales.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try { return await P.exportOwnedState(f); } finally { await f.sales.query('ROLLBACK'); }
}
async function targetDatabase(t, f) {
  const target = await salesDatabase(t);
  if(f) await copyNormal(f, target);
  return target;
}
async function fixture(t, { bulk = 1, authenticated = false, strictRunKeys = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gp-owned-state-test-'))); await fs.chmod(directory, 0o700);
  const salesDb = await salesDatabase(t, strictRunKeys), { client: coreDb } = await cluster.database(t);
  await coreDb.query('CREATE SCHEMA gp; SET search_path=pg_catalog,gp; CREATE TABLE trade_source_references(id TEXT PRIMARY KEY); CREATE TABLE import_master_holds(record_id TEXT,consumer_id TEXT); CREATE TABLE article_reference_snapshots(product_id TEXT,revision INTEGER);');
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 6), indexKey: Buffer.alloc(32, 17), keyId: 'owned-state' });
  t.after(async () => { protection.destroy(); await fs.rm(directory, { recursive: true, force: true }); });
  const defs = definitions('trade'), masterDef = defs.find(d => d.name === 'ARTIKEL_STAMM'), historyDef = defs.find(d => d.name === 'ARTIKEL_FILIALEN'), fileSha256 = 'a'.repeat(64);
  const sourceId = protection.digest(['source', { scopeId: 'scope', ownerId: 'owner' }, 'trade', fileSha256]);
  const source = { kind: 'trade', sourceId, fileSha256, bytes: 4096, fileName: 'Trade.accdb', capturedAt: 1, appliedAt: 2, revision: 1, requiresPassword: false, file: sourceId + '.source' };
  const proof = { version: 1, available: true, generation: 1, kinds: SOURCE_KINDS.map(kind => ({ kind, current: kind === 'trade' ? source : null, previous: null })), candidates: [],
    files: [{ file: 'index.source-archive', bytes: 1, sha256: 'c'.repeat(64) }, { file: source.file, bytes: 4096, sha256: 'd'.repeat(64) }] };
  proof.generationSha256 = sha(JSON.stringify({ generation: proof.generation, kinds: proof.kinds, candidates: proof.candidates, files: proof.files }));
  const sourceReplayPlan = { format: 'grabenplaner-access-source-replay-v1', archiveGenerationSha256: proof.generationSha256, stockPublications: [], sources: [{ sourceId, kind: 'trade', fileSha256, bytes: 4096, strategy: 'normal-import',
    scopeId: 'scope', ownerId: 'owner', createdAt: TIME, appliedAt: TIME, orderBasis: 'apply-progress', retirement: null, sourceRevision: 1, sourceMetadataSha256: 'e'.repeat(64), genericCash: false, genericCashBatches: [],
    tables: defs.map(d => ({ name: d.name, profileHash: d.profile.fingerprint, declaredRows: 1, expectedRows: 1, runId: sha('run-' + d.name), deferred: null, countApproved: false, exceptionRanges: [] })) }] };
  sourceReplayPlan.planSha256 = sha(C.canonical(sourceReplayPlan));
  const runManifest = (def, sourceInstance = 'tradefoto-trade', file = fileSha256) => ({ sourceInstance, fileSha256: file,
    ...(authenticated ? { schemaSha256: def.profile.schemaSha256, expectedRows: bulk, declaredRows: bulk, snapshotAt: TIME, gates: [] } : {}) });
  const run = (id, def, status = 'applied', sourceInstance = 'tradefoto-trade', file = fileSha256) => insert(salesDb, 'data_import_runs', { id, scope_id: 'scope', owner_id: 'owner', profile_hash: def.profile.fingerprint,
    manifest: JSON.stringify(runManifest(def, sourceInstance, file)), status });
  const undoProfile = H.profileFor('cash', 'Umsatz_Kasse_Details');
  const runId = (label, def, sourceInstance = 'tradefoto-trade', file = fileSha256) => authenticated
    ? protection.digest(['run', C.VERSION, { scopeId: 'scope', ownerId: 'owner' }, def.profile.fingerprint, runManifest(def, sourceInstance, file), 'default']) : sha(label);
  const masterRun = runId('run-ARTIKEL_STAMM', masterDef), historyRun = runId('run-ARTIKEL_FILIALEN', historyDef), pendingRun = sha('pending'), unknownRun = sha('unknown'), undoRun = runId('undo', { profile: undoProfile }, 'tradefoto-cash', 'b'.repeat(64));
  await run(masterRun, masterDef); await run(historyRun, historyDef); await run(pendingRun, masterDef, 'needs_review'); await run(unknownRun, masterDef, 'applied', 'own-source');
  await run(undoRun, { profile: undoProfile }, 'reverted', 'tradefoto-cash', 'b'.repeat(64));
  await insert(salesDb, 'data_import_events', { id: uuid(90), run_id: undoRun, action: 'import.undo' });
  const masters = [], masterValues = new Map(), historyValues = new Map();
  for (const n of [1, 2, 3, 4, 5]) {
    const raw = Object.fromEntries(masterDef.profile.fields.map(field => [field.source, null])); raw.EAN = String(n); raw.Artikelbezeichnung = n === 1 ? 'Own protected anchor' : 'Source ' + n;
    const normalized = C.normalizeDataImportRow(masterDef.profile, raw), header = { id: uuid(n), scope_id: 'scope', source_instance: n === 4 ? 'own-source' : 'tradefoto-trade', source_table: masterDef.name,
      profile_hash: masterDef.profile.fingerprint, identity_hash: M.masterIdentity(protection, { scopeId: 'scope', sourceInstance: n === 4 ? 'own-source' : 'tradefoto-trade' }, masterDef.name, normalized.key), revision: 3, updated_by: 'owner', updated_at: TIME };
    await insert(salesDb, 'import_master_records', header);
    masterValues.set(header.id, normalized);
    for (const segment of M.masterSegments(masterDef.name, normalized.data)) await insert(salesDb, 'import_master_segments', { record_id: header.id, kind: segment.kind, data_class: segment.dataClass,
      payload: protection.seal(segment.data, ['master-segment', 'scope', header.source_instance, masterDef.name, header.identity_hash, header.id, header.profile_hash, 3, segment.kind, segment.dataClass]) });
    const runId = n === 3 ? pendingRun : n === 4 ? unknownRun : masterRun;
    await insert(salesDb, 'data_import_links', { id: sha('link-' + n), scope_id: 'scope', entity: masterDef.profile.entity, target_id: header.id, revision: 1, last_run_id: runId, payload: 'kept opaque link-' + n }); masters.push(header);
  }
  await insert(coreDb, 'import_master_holds', { record_id: uuid(1), consumer_id: 'own-repair-decision' });
  await insert(salesDb, 'import_master_relations', { record_id: uuid(1), slot: 0, parent_table: masterDef.name, identity_hash: masters[4].identity_hash, state: 'candidate', evidence: 'own anchor parent' });
  for (const [id, payload] of [[pendingRun, 'Own pending review'], [unknownRun, 'Own Core-target undo']]) {
    await insert(salesDb, 'data_import_rows', { run_id: id, row_number: 1, identity_hash: sha('link-' + (id === pendingRun ? 3 : 4)), payload, state: 'conflict' });
    await insert(salesDb, 'data_import_changes', { run_id: id, row_number: 1, identity_hash: sha('link-' + (id === pendingRun ? 3 : 4)), payload: payload + ' before-image', reverted_at: null });
    await insert(salesDb, 'data_import_run_state_counts', { run_id: id, state: 'conflict', count: 1 });
  }
  const history = async (id, def, runId, revision = 1, parent = null, file = fileSha256, ownUndo = false, actor = 'owner') => {
    const sourceName = def.source || 'cash', raw = Object.fromEntries(def.profile.fields.map(field => [field.source, null]));
    if (def.name === 'ARTIKEL_FILIALEN') { raw.EAN = id; raw.FilialID = '18'; }
    else if (def.name === 'Umsatz_KASSE') Object.assign(raw, { Bonnr: id, Filialid: '18', Kassenid: '1', Bondatum: '2010-01-02T00:00:00.000' });
    else raw.RepID = id;
    const normalized = C.normalizeDataImportRow(def.profile, raw), header = { id, scope_id: 'scope', source_instance: sourceName === 'cash' ? 'tradefoto-cash' : 'tradefoto-trade', source: sourceName,
      source_table: def.name, profile_hash: def.profile.fingerprint, identity_hash: H.historyIdentity(protection, { scopeId: 'scope', sourceInstance: sourceName === 'cash' ? 'tradefoto-cash' : 'tradefoto-trade' }, sourceName, def.name, normalized.key, def.profile.fingerprint), revision };
    await insert(salesDb, 'import_history_records', header);
    historyValues.set(header.id, normalized);
    for (let rev = 1; rev <= revision; rev++) {
      const v = { record_id: id, revision: rev, file_sha256: rev === revision ? file : fileSha256, snapshot_at: TIME, imported_by: actor, imported_at: TIME,
        run_id: rev === revision ? runId : historyRun, master_source_instance: 'tradefoto-trade', business_date: null, parent_id: parent, parent_revision: parent ? 1 : null };
      const context = ['history-version', 'scope', header.source_instance, sourceName, def.name, id, header.identity_hash, header.profile_hash, rev, v.file_sha256, TIME, actor, TIME, v.run_id, 'tradefoto-trade', null, parent, parent ? 1 : null];
      await insert(salesDb, 'import_history_versions', { ...v, payload: protection.seal({ references: [], dependencyToken: 'f'.repeat(64), dataHash: protection.digest(normalized.data), restoredFromRevision: ownUndo && rev === revision ? 1 : null }, context) });
      for (const segment of H.historySegments(sourceName, def.name, normalized.data, def.profile.fingerprint)) await insert(salesDb, 'import_history_segments', { record_id: id, revision: rev, data_class: segment.dataClass, payload: protection.seal(segment.data, [...context, 'segment', segment.dataClass]) });
      if (ownUndo && rev === revision) masters.undoContext = context;
    }
  };
  await history(uuid(22), { source: 'cash', name: 'Umsatz_KASSE', profile: H.profileFor('cash', 'Umsatz_KASSE') }, historyRun);
  await history(uuid(23), { source: 'cash', name: 'Umsatz_Kasse_Details', profile: undoProfile }, undoRun, 2, uuid(22), 'b'.repeat(64), true);
  for (let i = 0; i < bulk; i++) await history(uuid(1000 + i), historyDef, historyRun);
  for (const [index, system] of ['tradefoto.artikel_stamm', 'manual.article-catalog', 'tradefoto.article.import.undo', 'unknown.future'].entries()) {
    const snap = sha('snapshot-' + index), product = uuid(200 + index);
    await insert(salesDb, 'sales_article_import_snapshots', { id: snap, source_system: system, source_file_sha256: fileSha256 });
    await insert(salesDb, 'sales_articles', { product_id: product, article_number: 'A' + index, current_revision: 2 });
    for (const revision of [1, 2]) await insert(salesDb, 'sales_article_revisions', { product_id: product, revision, article_number: 'A' + index, description: system + ' original ' + revision, active: 1, source_snapshot_id: revision === 2 ? snap : sha('old-' + index) });
    await insert(salesDb, 'sales_article_import_snapshots', { id: sha('old-' + index), source_system: 'tradefoto.artikel_stamm', source_file_sha256: fileSha256 });
    for (const snapshot of [snap, sha('old-' + index)]) await insert(salesDb, 'sales_article_price_snapshots', { id: sha('price-' + snapshot), product_id: product, source_snapshot_id: snapshot, amount: '0.300000000001', source_field: 'Vkp1' });
    await insert(salesDb, 'sales_article_identifiers', { id: uuid(300 + index), product_id: product, source_snapshot_id: snap, identifier_value: 'own-' + index });
    await insert(salesDb, 'sales_article_import_impacts', { snapshot_id: snap, ordinal: 1, product_id: product, imported_revision: 2, previous_current_revision: 1 });
    await insert(salesDb, 'sales_article_import_findings', { snapshot_id: snap, ordinal: 1, code: 'source_detail' });
  }
  await insert(coreDb, 'article_reference_snapshots', { product_id: uuid(200), revision: 1 });
  await insert(salesDb, 'sales_article_own_images', { article_number: 'A1', content: Buffer.from('original own photo') });
  await insert(salesDb, 'own_unknown_notes', { id: 'own-note', note: 'Never part of an import' });
  await salesDb.query(FOREIGN_KEYS);
  return { directory, salesDb, coreDb, sales: salesDb, core: coreDb, protection, archiveProof: proof, sourceReplayPlan, masters, masterValues, historyValues, masterRun, historyRun, pendingRun, undoRun, addHistory: history, addRun: run };
}
async function copyNormal(f, target) {
  const projected = new Set(P.PROJECTED_TABLES.map(t => t.table));
  for (const { tablename } of await rows(f.salesDb, "SELECT tablename FROM pg_tables WHERE schemaname IN ('trade','integration')")) {
    if (!projected.has(tablename)) for (const record of await rows(f.salesDb, 'SELECT * FROM "' + tablename + '"')) await insert(target, tablename, record);
  }
}
test('sparse state preserves own/unknown/pending rows, Core master hold, native catalog values and a real undo version', cluster.options, async t => {
  const f = await fixture(t), plan = await exportState(f), targetDb = await targetDatabase(t, f);
  assert.equal(P.validateOwnedPlan(plan), plan); assert.ok(plan.rows < 100); assert.equal(plan.stats.masterAnchors, 4); assert.equal(plan.stats.historyAnchors, 2);
  const result = await P.restoreOwnedState({ ...f, sales: targetDb, plan, isolatedRecovery: true }); assert.equal(result.verified, true); assert.equal(result.rehydrated, false);
  await targetDb.query(FOREIGN_KEYS);
  assert.deepEqual((await rows(targetDb, 'SELECT id FROM import_master_records ORDER BY id')).map(r => r.id), [1, 3, 4, 5].map(uuid));
  assert.equal((await row(targetDb, 'SELECT count(*)::integer n FROM import_history_records')).n, 2);
  const undone = (await row(targetDb, 'SELECT payload FROM import_history_versions WHERE record_id=$1 AND revision=2', [uuid(23)]));
  assert.equal(f.protection.open(undone.payload, f.masters.undoContext).restoredFromRevision, 1);
  assert.deepEqual((await rows(targetDb, 'SELECT run_id,payload FROM data_import_rows ORDER BY run_id')).map(r => r.payload).sort(), ['Own Core-target undo', 'Own pending review'].sort());
  assert.equal((await row(targetDb, 'SELECT count(*)::integer n FROM sales_article_price_snapshots')).n, 7);
  assert.equal((await row(targetDb, 'SELECT amount FROM sales_article_price_snapshots WHERE id=$1', [sha('price-' + sha('old-0'))])).amount, '0.300000000001', 'Core loan snapshot retains its original imported prices');
  assert.equal((await row(targetDb, 'SELECT amount FROM sales_article_price_snapshots WHERE id=$1', [sha('price-' + sha('old-2'))])).amount, '0.300000000001', 'native undo retains prices of its previous imported revision');
  assert.equal((await row(targetDb, 'SELECT amount FROM sales_article_price_snapshots WHERE id=$1', [sha('price-' + sha('snapshot-0'))])), undefined, 'ordinary current imported prices await replay');
  assert.equal((await row(targetDb, 'SELECT count(*)::integer n FROM sales_article_revisions')).n, 8);
  assert.equal(Buffer.from((await row(targetDb, 'SELECT content FROM sales_article_own_images WHERE article_number=$1', ['A1'])).content).toString(), 'original own photo');
  assert.equal((await row(targetDb, 'SELECT note FROM own_unknown_notes')).note, 'Never part of an import');
  assert.equal((await row(targetDb, 'SELECT action FROM data_import_events')).action, 'import.undo');
  assert.ok(!(await fs.readFile(path.join(f.directory, plan.file), 'utf8')).includes('Own pending review'));
});
test('completed imported row volume does not enlarge the sparse state file or manifest', cluster.options, async t => {
  const small = await fixture(t, { bulk: 1 }), large = await fixture(t, { bulk: 2000 });
  const a = await exportState(small), b = await exportState(large);
  assert.equal(a.rows, b.rows); assert.equal(a.bytes, b.bytes); assert.equal(JSON.stringify(a).length, JSON.stringify(b).length);
  assert.equal(a.tables.find(t => t.table === 'import_history_records').rows, 2);
});

test('retained pending work crosses cursor batches without gaps and closes its portal', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1 });
  for (let number = 2; number <= 251; number++) await insert(f.salesDb, 'data_import_rows', { run_id: f.pendingRun,
    row_number: number, identity_hash: sha('link-3'), payload: 'pending-' + number, state: 'conflict' });
  const plan = await exportState(f), target = await targetDatabase(t, f);
  await P.restoreOwnedState({ ...f, sales: target, plan, isolatedRecovery: true });
  assert.deepEqual((await rows(target, 'SELECT row_number,payload FROM data_import_rows WHERE run_id=$1 ORDER BY row_number', [f.pendingRun])),
    (await rows(f.salesDb, 'SELECT row_number,payload FROM data_import_rows WHERE run_id=$1 ORDER BY row_number', [f.pendingRun])), 'same rows and original order');
  assert.deepEqual(await rows(f.salesDb, "SELECT name FROM pg_cursors WHERE name LIKE 'gp_owned_export_%'"), []);
});

test('a cursor fetch failure retains its original error and removes the incomplete export', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1 }), query = f.sales.query.bind(f.sales), failure = new Error('synthetic cursor read failure');
  f.sales.query = async (...args) => { if (args[0].startsWith('FETCH FORWARD ')) throw failure; return query(...args); };
  await assert.rejects(exportState(f), error => error === failure);
  assert.deepEqual(await rows(f.salesDb, "SELECT name FROM pg_cursors WHERE name LIKE 'gp_owned_export_%'"), []);
  await assert.rejects(fs.access(path.join(f.directory, P.FILE)), { code: 'ENOENT' });
});

test('pending rows and changes retain their original links even when the last linked run is reconstructible', cluster.options, async t =>{
 const f=await fixture(t,{bulk:1,authenticated:true});
 for(const [number,target] of [[2,2],[3,2],[4,5]])await insert(f.salesDb,'data_import_rows',{run_id:f.pendingRun,row_number:number,identity_hash:sha('link-'+target),payload:'own pending association',state:'conflict'});
 for(const [number,target] of [[3,2],[4,5]])await insert(f.salesDb,'data_import_changes',{run_id:f.pendingRun,row_number:number,identity_hash:sha('link-'+target),payload:'own pending before-image',reverted_at:null});
 const plan=await exportState({...f,basis:P.FRESH_BASIS}),target=await targetDatabase(t, f);
 await P.restoreOwnedState({...f,sales:target,plan,isolatedRecovery:true});
 assert.deepEqual((await rows(target, 'SELECT id FROM data_import_links ORDER BY id')).map(row=>row.id),[2,3,4,5].map(n=>sha('link-'+n)).sort());
 assert.deepEqual((await rows(target, 'SELECT id FROM import_master_records ORDER BY id')).map(row=>row.id),[1,2,3,4,5].map(uuid));
 assert.equal((await row(target, 'SELECT count(*)::integer AS n FROM data_import_rows')).n,5);
 await target.query(FOREIGN_KEYS);
});
test('uncovered current source facts and unexpected incoming GP foreign keys refuse the reduced point', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1 }); f.sourceReplayPlan.sources[0].tables.find(t => t.name === 'ARTIKEL_FILIALEN').runId = sha('not-the-current-run');
  const { planSha256, ...body } = f.sourceReplayPlan; f.sourceReplayPlan.planSha256 = sha(C.canonical(body));
  await assert.rejects(exportState(f), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  await assert.rejects(fs.access(path.join(f.directory, P.FILE)), { code: 'ENOENT' });
  const master = await fixture(t, { bulk: 1 }); await master.salesDb.query('DELETE FROM data_import_links WHERE target_id=$1', [uuid(2)]);
  await assert.rejects(exportState(master), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  const price = await fixture(t, { bulk: 1 }); await price.salesDb.query('UPDATE sales_article_import_snapshots SET source_file_sha256=$1 WHERE id=$2', ['b'.repeat(64), sha('snapshot-0')]);
  await assert.rejects(exportState(price), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  const g = await fixture(t, { bulk: 1 }); await g.salesDb.query('CREATE TABLE own_new_history_reference(id TEXT PRIMARY KEY,record_id TEXT REFERENCES import_history_records(id));');
  await insert(g.salesDb, 'own_new_history_reference', { id: 'own', record_id: uuid(1000) });
  await assert.rejects(exportState(g), error => error.code === 'PG_DEPLOY_OWNED_FK_CLOSURE');
});
test('component hardlinks, ancestor junctions, corrupted bytes and live sockets are rejected before inserts', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1 }), plan = await exportState(f), sales = await targetDatabase(t);
  let writes = 0;
  const query = sales.query.bind(sales);
  sales.query = async (sql, args) => { if (sql.startsWith('INSERT INTO')) writes++; return query(sql, args); };
  const component = path.join(f.directory, P.FILE), linked = path.join(f.directory, 'extra-hardlink'); await fs.link(component, linked);
  await assert.rejects(P.restoreOwnedState({ ...f, sales, plan, isolatedRecovery: true }), /OWNED_FILE/); await fs.unlink(linked);
  const ancestor = path.join(f.directory, 'alias'); await fs.symlink(f.directory, ancestor, 'junction');
  await assert.rejects(P.restoreOwnedState({ ...f, sales, plan, directory: ancestor, isolatedRecovery: true }), /OWNED_DIRECTORY/);
  const remote = { connectionParameters: { host: '127.0.0.1', port: 55484 },
    query() { assert.fail('Unverified endpoint must be rejected before a query'); } };
  await assert.rejects(P.restoreOwnedState({ ...f, sales: remote, plan, isolatedRecovery: true }), /ISOLATION_REQUIRED/);
  const bytes = await fs.readFile(component); bytes[20] ^= 1; await fs.writeFile(component, bytes);
  await assert.rejects(P.restoreOwnedState({ ...f, sales, plan, isolatedRecovery: true }), /FILE_HASH/); assert.equal(writes, 0);
});
test('failed sparse insertion rolls back every projected row and retains normal own state', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1 }), plan = await exportState(f), target = await targetDatabase(t, f);
  const sales = target, query = sales.query.bind(sales); let inserts = 0;
  sales.query = async (sql, args) => { if (sql.includes('jsonb_populate_recordset') && ++inserts === 3) throw new Error('synthetic sparse insert failure'); return query(sql, args); };
  await assert.rejects(P.restoreOwnedState({ ...f, sales, plan, isolatedRecovery: true }), /synthetic sparse insert failure/);
  for (const table of P.PROJECTED_TABLES) assert.equal((await row(target, 'SELECT count(*)::integer n FROM "' + table.table + '"')).n, 0);
  assert.equal((await row(target, 'SELECT note FROM own_unknown_notes')).note, 'Never part of an import');
});
test('large unknown GP evidence is chunked without exposing or changing its original bytes', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1 }), value = 'own-protected-opaque-' + 'q'.repeat(1_200_000);
  await f.salesDb.query('UPDATE data_import_rows SET payload=$1 WHERE run_id=$2', [value, f.pendingRun]);
  const plan = await exportState(f), target = await targetDatabase(t, f);
  assert.ok(!(await fs.readFile(path.join(f.directory, plan.file), 'utf8')).includes('own-protected-opaque-'));
  await P.restoreOwnedState({ ...f, sales: target, plan, isolatedRecovery: true });
  assert.equal((await row(target, 'SELECT payload FROM data_import_rows WHERE run_id=$1', [f.pendingRun])).payload, value);
});
test('legacy cash omission is covered by its actual batch actor and never by the compact source checkpoint alone', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1 }), cashProfile = H.profileFor('cash', 'Umsatz_KASSE'), runId = sha('legacy-cash-run'), fileSha256 = 'a'.repeat(64);
  await f.addRun(runId, { profile: cashProfile }, 'applied', 'tradefoto-cash'); await f.salesDb.query('UPDATE data_import_runs SET owner_id=$1 WHERE id=$2', ['legacy-owner', runId]);
  await f.addHistory(uuid(700), { source: 'cash', name: 'Umsatz_KASSE', profile: cashProfile }, runId, 1, null, fileSha256, false, 'legacy-owner');
  const sourceId = f.protection.digest(['source', { scopeId: 'scope', ownerId: 'owner' }, 'cash', fileSha256]);
  const source = { ...f.archiveProof.kinds[0].current, kind: 'cash', sourceId, file: sourceId + '.source' };
  f.archiveProof.kinds.find(s => s.kind === 'cash').current = source; f.archiveProof.files.push({ file: source.file, bytes: 4096, sha256: 'f'.repeat(64) });
  f.archiveProof.generationSha256 = sha(JSON.stringify({ generation: f.archiveProof.generation, kinds: f.archiveProof.kinds, candidates: f.archiveProof.candidates, files: f.archiveProof.files }));
  f.sourceReplayPlan.archiveGenerationSha256 = f.archiveProof.generationSha256;
  const oldTable = { name: 'Umsatz_KASSE', profileHash: cashProfile.fingerprint, declaredRows: 1, expectedRows: 1, runId, deferred: null, countApproved: false, exceptionRanges: [] };
  const cash = { sourceId, kind: 'cash', fileSha256, bytes: 4096, strategy: 'cash-snapshot-plan', scopeId: 'scope', ownerId: 'owner', createdAt: TIME, appliedAt: TIME, orderBasis: 'apply-progress', retirement: null, sourceRevision: 1, sourceMetadataSha256: 'e'.repeat(64),
    tables: definitions('cash').map(d => ({ name: d.name, profileHash: d.profile.fingerprint, declaredRows: 0, expectedRows: 0, runId: sha('compact-' + d.name), deferred: null, countApproved: false, exceptionRanges: [] })),
    genericCash: true, genericCashBatches: [{ scopeId: 'scope', ownerId: 'legacy-owner', snapshotAt: TIME, appliedAt: TIME, tables: [oldTable] }] };
  f.sourceReplayPlan.sources.push(cash); const rehash = () => { const { planSha256, ...body } = f.sourceReplayPlan; f.sourceReplayPlan.planSha256 = sha(C.canonical(body)); }; rehash();
  const plan = await exportState(f); assert.equal(plan.stats.historyAnchors, 2);
  const bytes = await fs.readFile(path.join(f.directory, P.FILE));
  cash.genericCashBatches[0].ownerId = 'owner'; rehash();
  await assert.rejects(exportState(f), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  assert.deepEqual(await fs.readFile(path.join(f.directory, P.FILE)), bytes, 'an admission failure must never unlink an existing component');
  cash.genericCashBatches[0].ownerId = 'legacy-owner'; rehash();
  await assert.rejects(exportState(f), { code: 'EEXIST' }); assert.deepEqual(await fs.readFile(path.join(f.directory, P.FILE)), bytes);
});

test('a retained stock anchor must be an authenticated current member of the required published snapshot', cluster.options, async t => {
  const make = async (ownUndo = false) => {
    const f = await fixture(t, { bulk: 0 }), recordId = uuid(1000), def = definitions('trade').find(d => d.name === 'ARTIKEL_FILIALEN'), profileHash = def.profile.fingerprint;
    await f.addHistory(recordId, def, ownUndo ? f.undoRun : f.historyRun, ownUndo ? 2 : 1, null, 'a'.repeat(64), ownUndo);
    await insert(f.salesDb, 'import_history_holds', { record_id: recordId, consumer_id: 'own-stock-decision' });
    const stock = { scopeId: 'scope', sourceInstance: 'tradefoto-trade', profileHash, fileSha256: 'a'.repeat(64), snapshotAt: TIME, ownerId: 'owner', expectedRows: 1, originalRunId: f.historyRun };
    const header = ['history-snapshot', f.historyRun, 'scope', 'tradefoto-trade', profileHash, stock.fileSha256, TIME, 'owner', 1];
    await insert(f.salesDb, 'import_history_snapshots', { run_id: f.historyRun, scope_id: 'scope', source_instance: 'tradefoto-trade', profile_hash: profileHash, file_sha256: stock.fileSha256,
      snapshot_at: TIME, owner_id: 'owner', expected_rows: 1, status: 'published', payload: f.protection.seal({ version: 1 }, [...header, 'published']) });
    const record = (await row(f.salesDb, 'SELECT r.*,v.file_sha256,v.snapshot_at,v.imported_by,v.imported_at,v.run_id,v.master_source_instance,v.business_date,v.parent_id,v.parent_revision,v.payload FROM import_history_records r JOIN import_history_versions v ON v.record_id=r.id AND v.revision=1 WHERE r.id=$1', [recordId]));
    const version = f.protection.open(record.payload, ['history-version', 'scope', 'tradefoto-trade', 'trade', 'ARTIKEL_FILIALEN', recordId, record.identity_hash, profileHash, 1, stock.fileSha256, TIME, 'owner', TIME, f.historyRun, 'tradefoto-trade', null, null, null]);
    await insert(f.salesDb, 'import_history_snapshot_members', { run_id: f.historyRun, row_number: 1, record_id: recordId, revision: 1, payload: f.protection.seal({ dataHash: version.dataHash }, [...header, 'building', 'member', 1, recordId, 1]) });
    f.sourceReplayPlan.stockPublications.push(stock); const { planSha256, ...body } = f.sourceReplayPlan; f.sourceReplayPlan.planSha256 = sha(C.canonical(body));
    return f;
  };
  const positive = await make(), plan = await exportState(positive); assert.equal(plan.stats.historyAnchors, 3);
  const mismatch = await make(true);
  await assert.rejects(exportState(mismatch), { code: 'PG_DEPLOY_ACCESS_STOCK_ANCHOR' });
  await assert.rejects(fs.access(path.join(mismatch.directory, P.FILE)), { code: 'ENOENT' });
  const corrupt = await make(); await corrupt.salesDb.query('UPDATE import_history_snapshots SET payload=$1', ['corrupt-publication-proof']);
  await assert.rejects(exportState(corrupt));
  const stale = await make(); await insert(stale.salesDb, 'import_history_snapshots', { ...(await row(stale.salesDb, 'SELECT * FROM import_history_snapshots')), run_id: sha('newer-publication'), snapshot_at: '2026-11-16T13:00:00.000Z' });
  await assert.rejects(exportState(stale), { code: 'PG_DEPLOY_ACCESS_STOCK_ANCHOR' });
  const omitted = await make(); omitted.sourceReplayPlan.stockPublications = []; const { planSha256, ...body } = omitted.sourceReplayPlan; omitted.sourceReplayPlan.planSha256 = sha(C.canonical(body));
  await assert.rejects(exportState(omitted), { code: 'PG_DEPLOY_ACCESS_STOCK_ANCHOR' });
});

test('fresh-generation V4 creates and restores sparse GP state without old originals or a future source plan', cluster.options, async t => {
  const f = await fixture(t, { bulk: 2000, authenticated: true }), { archiveProof, sourceReplayPlan, ...input } = f;
  const plan = await exportState({ ...input, basis: P.FRESH_BASIS });
  assert.equal(plan.format, P.FRESH_FORMAT); assert.equal(plan.basis, 'fresh-source-rebuild'); assert.equal(Object.hasOwn(plan, 'archiveGenerationSha256'), false);
  assert.equal(plan.stats.completedAccessRuns, 3); assert.equal(plan.stats.masterAnchors, 4); assert.equal(plan.stats.historyAnchors, 2); assert.ok(plan.rows < 100);
  const target = await targetDatabase(t, f);
  const restored = await P.restoreOwnedState({ ...input, sales: target, plan, isolatedRecovery: true });
  assert.equal(restored.verified, true); assert.equal(restored.requiresFreshAccess, true); assert.equal(restored.rehydrated, false);
  await target.query(FOREIGN_KEYS);
  assert.equal((await row(target, 'SELECT count(*)::integer n FROM import_history_records')).n, 2, 'bulk Access facts can be regenerated from a new generation');
  assert.equal((await row(target, 'SELECT payload FROM data_import_rows WHERE run_id=$1', [f.pendingRun])).payload, 'Own pending review');
  assert.equal((await row(target, 'SELECT payload FROM data_import_changes WHERE run_id=$1', [sha('unknown')])).payload, 'Own Core-target undo before-image');
  assert.equal((await row(target, 'SELECT description FROM sales_article_revisions WHERE product_id=$1 AND revision=2', [uuid(201)])).description, 'manual.article-catalog original 2');
  assert.equal((await row(target, 'SELECT amount FROM sales_article_price_snapshots WHERE id=$1', [sha('price-' + sha('old-0'))])).amount, '0.300000000001');
  assert.equal(Buffer.from((await row(target, 'SELECT content FROM sales_article_own_images')).content).toString(), 'original own photo');
  const tampered = { ...plan, archiveGenerationSha256: 'f'.repeat(64) }; assert.throws(() => P.validateOwnedPlan(tampered), /OWNED_SHAPE/);
  assert.throws(() => P.validateOwnedPlan({ ...plan, basis: 'archived-originals' }), /OWNED_PLAN/);
  await assert.rejects(exportState({ ...input, basis: 'archive-optional' }), /OWNED_BASIS/);
});

test('fresh omission requires actual completed run HMAC, exact schema and recognized profile namespace', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1, authenticated: true }), runRow = await row(f.salesDb, 'SELECT * FROM data_import_runs WHERE id=$1', [f.masterRun]);
  const options = { basis: P.FRESH_BASIS, protection: f.protection };
  assert.equal(P.classifyRun(runRow, options).omit, true);
  for (const mutate of [copy => copy.id = sha('forged-run'), copy => copy.owner_id = 'other-owner', copy => copy.attempt_id = 'other-attempt',
    copy => copy.profile_hash = 'f'.repeat(64), copy => copy.status = 'needs_review',
    copy => { const data = JSON.parse(copy.manifest); data.schemaSha256 = 'f'.repeat(64); copy.manifest = JSON.stringify(data); },
    copy => { const data = JSON.parse(copy.manifest); data.sourceInstance = 'own-source'; copy.manifest = JSON.stringify(data); }]) {
    const copy = { ...runRow }; mutate(copy); assert.equal(P.classifyRun(copy, options).omit, false);
  }
  const forgedRun = sha('own-evidence-with-copied-source-profile'); await f.addRun(forgedRun, definitions('trade').find(d => d.name === 'ARTIKEL_STAMM'));
  await insert(f.salesDb, 'data_import_rows', { run_id: forgedRun, row_number: 1, identity_hash: sha('own-row'), payload: 'own evidence with copied Access profile', state: 'conflict' });
  const { archiveProof, sourceReplayPlan, ...input } = f, plan = await exportState({ ...input, basis: P.FRESH_BASIS });
  assert.equal(plan.stats.retainedPendingOrUnknownRuns, 3); assert.equal(plan.tables.find(table => table.table === 'data_import_rows').rows, 3);
});

test('fresh-generation mode still rejects missing retained foreign-key anchors before sealing', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1, authenticated: true }), { archiveProof, sourceReplayPlan, ...input } = f;
  await f.salesDb.query('CREATE TABLE own_future_history_link(id TEXT PRIMARY KEY,record_id TEXT REFERENCES import_history_records(id))');
  await insert(f.salesDb, 'own_future_history_link', { id: 'own', record_id: uuid(1000) });
  await assert.rejects(exportState({ ...input, basis: P.FRESH_BASIS }), { code: 'PG_DEPLOY_OWNED_FK_CLOSURE' });
  await assert.rejects(fs.access(path.join(f.directory, P.FILE)), { code: 'ENOENT' });
});

test('indexed history closure checks the complete composite key of retained segments', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1, authenticated: true });
  const retained = uuid(1000);
  await insert(f.salesDb, 'import_history_holds', { record_id: retained, consumer_id: 'own-revision-link' });
  await f.salesDb.query('ALTER TABLE integration.import_history_segments DISABLE TRIGGER ALL');
  await insert(f.salesDb, 'import_history_segments', {
    record_id: retained, revision: 900000, data_class: 'sales', payload: 'missing revision fixture',
  });
  await assert.rejects(exportState({ ...f, basis: P.FRESH_BASIS }), { code: 'PG_DEPLOY_OWNED_FK_CLOSURE' });
  await assert.rejects(fs.access(path.join(f.directory, P.FILE)), { code: 'ENOENT' });
});

test('matching retained selectors use enforced foreign keys while disabled or unknown constraints require row checks', cluster.options, async t => {
  for (const change of [null, { enforced: false }, { validated: false }, { deferrable: true }, { noInheritance: false }]) {
    const f = await fixture(t, { bulk: 1, authenticated: true }), native = f.sales.query.bind(f.sales);
    let checkedSegments = 0;
    f.sales.query = async (sql, args) => {
      if (sql.startsWith('SELECT EXISTS(') && sql.includes('FROM "integration"."import_history_segments" c')) checkedSegments++;
      const result = await native(sql, args);
      if (change && sql.includes('FROM pg_constraint f')) result.rows = result.rows.map(edge => ({ ...edge, ...change }));
      return result;
    };
    await exportState({ ...f, basis: P.FRESH_BASIS });
    assert.equal(checkedSegments > 0, Boolean(change), JSON.stringify(change));
  }
});

async function onlyCompletedRuns(t,{strictRunKeys=true}={}) {
 const f=await fixture(t,{bulk:1,authenticated:true,strictRunKeys});
 await f.salesDb.query('DELETE FROM data_import_change_payload_refs; DELETE FROM data_import_row_payload_refs; DELETE FROM data_import_changes; DELETE FROM data_import_rows; DELETE FROM data_import_run_state_counts; DELETE FROM data_import_events;');
 await f.salesDb.query('DELETE FROM data_import_links WHERE last_run_id NOT IN ($1,$2)', [f.masterRun, f.historyRun]);
 await f.salesDb.query('DELETE FROM data_import_runs WHERE id NOT IN ($1,$2)', [f.masterRun, f.historyRun]);
 await insert(f.salesDb,'data_import_rows',{run_id:f.masterRun,row_number:1,identity_hash:sha('rebuild-row'),payload:'derived source row',state:'unchanged'});
 await insert(f.salesDb,'data_import_changes',{run_id:f.masterRun,row_number:1,identity_hash:sha('rebuild-row'),payload:'derived change',reverted_at:null});
 await insert(f.salesDb,'data_import_payload_blocks',{id:'block',scope_id:'scope',owner_id:'owner',profile_hash:'unknown',source_system:'own',source_instance:'own',source_table:'own',entity:'own',block_type:'source',payload:'own block'});
 for(const name of ['data_import_row_payload_refs','data_import_change_payload_refs'])await insert(f.salesDb,name,{run_id:f.masterRun,row_number:1,slot:'source',block_id:'block'});
 await insert(f.salesDb,'data_import_run_state_counts',{run_id:f.masterRun,state:'unchanged',count:1});
 await insert(f.salesDb,'import_history_snapshots',{run_id:f.historyRun,scope_id:'scope',source_instance:'tradefoto-trade',profile_hash:definitions('trade').find(d=>d.name==='ARTIKEL_FILIALEN').profile.fingerprint,file_sha256:'a'.repeat(64),snapshot_at:TIME,owner_id:'owner',expected_rows:1,status:'published',payload:'source snapshot'});
 await insert(f.salesDb,'import_history_snapshot_members',{run_id:f.historyRun,row_number:1,record_id:uuid(1000),revision:1,payload:'source member'});
 return f;
}

test('proven empty source selections avoid source export/FK scans including composite FK run chains', cluster.options, async t =>{
 const f=await onlyCompletedRuns(t),queries=[],query=f.sales.query.bind(f.sales);
 f.sales.query=async(sql,args)=>{queries.push(sql);return query(sql,args);};
 const plan=await exportState({...f,basis:P.FRESH_BASIS});
 for(const table of ['data_import_rows','data_import_changes','data_import_run_state_counts','data_import_row_payload_refs','data_import_change_payload_refs','import_history_snapshots','import_history_snapshot_members','import_history_snapshot_attestations']){
  assert.equal(plan.tables.find(t=>t.table===table).rows,0,table);
  assert.equal(queries.some(sql=>sql.includes('SELECT t.* FROM "integration"."'+table+'"')),false,table+' export');
  assert.equal(queries.some(sql=>sql.startsWith('SELECT EXISTS(SELECT 1 FROM "integration"."'+table+'" c')),false,table+' FK');
 }
 assert.equal(plan.tables.find(t=>t.table==='data_import_payload_blocks').rows,1,'unknown own block remains');
});

test('run empty shortcut requires validated enforced non-deferrable NOT NULL FKs without inheritance', cluster.options, async t =>{
 for(const kind of ['nullable','unvalidated','deferrable','disabled','inherited','wrong-parent-column','missing-edge']){
  const f=await onlyCompletedRuns(t,{strictRunKeys:kind!=='nullable'}),queries=[],query=f.sales.query.bind(f.sales);
  f.sales.query=async(sql,args)=>{
   queries.push(sql);const result=await query(sql,args);
   if(sql.includes('FROM pg_constraint f')){
    const edge=result.rows.find(edge=>edge.table==='data_import_rows'&&edge.parentTable==='data_import_runs');
    if(kind==='unvalidated')edge.validated=false;
    if(kind==='deferrable')edge.deferrable=true;
    if(kind==='disabled')edge.enforced=false;
    if(kind==='inherited')edge.noInheritance=false;
    if(kind==='wrong-parent-column')edge.parentColumns=['scope_id'];
    if(kind==='missing-edge')result.rows=result.rows.filter(row=>row!==edge);
   }
   return result;
  };
  await exportState({...f,basis:P.FRESH_BASIS});
  assert.equal(queries.some(sql=>sql.includes('SELECT t.* FROM "integration"."data_import_rows"')),true,kind);
 }
});

test('nullable and orphan run rows remain conservative when the FK shortcut cannot be proven', cluster.options, async t =>{
 const f=await onlyCompletedRuns(t,{strictRunKeys:false});
 await f.salesDb.query('ALTER TABLE integration.data_import_rows DISABLE TRIGGER ALL');
 for(const [runId,rowNumber]of[[null,2],['missing-own-run',3]])await insert(f.salesDb,'data_import_rows',{run_id:runId,row_number:rowNumber,identity_hash:sha('own'+rowNumber),payload:'own unresolved '+rowNumber,state:'conflict'});
 await f.salesDb.query('ALTER TABLE integration.data_import_rows ENABLE TRIGGER ALL');
 const plan=await exportState({...f,basis:P.FRESH_BASIS});
 assert.equal(plan.tables.find(table=>table.table==='data_import_rows').rows,2,'neither nullable nor unresolved own row is classified as reconstructible');
});

async function addAuthenticatedPending(f,{status='ready',attempt='pending-source-only',state='create',change=false}={}){
 const original=(await row(f.salesDb, 'SELECT * FROM data_import_runs WHERE id=$1', [f.masterRun])),manifest=JSON.parse(original.manifest);
 const id=f.protection.digest(['run',C.VERSION,{scopeId:original.scope_id,ownerId:original.owner_id},original.profile_hash,manifest,attempt]);
 await insert(f.salesDb,'data_import_runs',{...original,id,attempt_id:attempt,status});
 await insert(f.salesDb,'data_import_rows',{run_id:id,row_number:1,identity_hash:sha('link-2'),payload:'Access-derived uncommitted preview',state});
 await insert(f.salesDb,'data_import_events',{id:crypto.randomUUID(),run_id:id,action:'import.source-tolerance.accepted:'+sha('own-count-decision')});
 if(change)await insert(f.salesDb,'data_import_changes',{run_id:id,row_number:1,identity_hash:sha('link-2'),payload:'GP before-image must survive',reverted_at:null});
 return id;
}

test('authenticated unapplied Access previews are omitted while their original decision headers and audit events remain', cluster.options, async t =>{
 const f=await fixture(t,{bulk:1,authenticated:true}),ids=[];
 for (const status of ['staging','reviewing','ready','needs_review','cancelled']) ids.push(await addAuthenticatedPending(f,{status,attempt:'source-only-'+status}));
 const plan=await exportState({...f,basis:P.FRESH_BASIS});assert.equal(plan.stats.omittedUnappliedAccessRuns,5);
 const target=await targetDatabase(t, f);
 await P.restoreOwnedState({...f,sales:target,plan,isolatedRecovery:true});
 for(const id of ids){
  assert.equal((await row(target, 'SELECT count(*)::integer AS n FROM data_import_rows WHERE run_id=$1', [id])).n,0);
  assert.deepEqual((await row(target, 'SELECT * FROM data_import_runs WHERE id=$1', [id])),(await row(f.salesDb, 'SELECT * FROM data_import_runs WHERE id=$1', [id])));
  assert.deepEqual((await row(target, 'SELECT * FROM data_import_events WHERE run_id=$1', [id])),(await row(f.salesDb, 'SELECT * FROM data_import_events WHERE run_id=$1', [id])));
 }
 assert.equal((await row(target, 'SELECT id FROM import_master_records WHERE id=$1', [uuid(2)])),undefined,'source-only previews must not pull reconstructible target graphs into the point');
 assert.equal((await row(target, 'SELECT payload FROM data_import_rows WHERE run_id=$1', [f.pendingRun])).payload,'Own pending review','unauthenticated or unknown pending evidence remains protected');
 await target.query(FOREIGN_KEYS);
});

test('pending Access status cannot omit actual before-images, applied rows, undo rows or an in-progress apply', cluster.options, async t =>{
 const f=await fixture(t,{bulk:1,authenticated:true}),ids=[
  await addAuthenticatedPending(f,{attempt:'with-before-image',change:true}),await addAuthenticatedPending(f,{attempt:'with-applied-row',state:'applied'}),
  await addAuthenticatedPending(f,{attempt:'with-undo-row',state:'reverted'}),await addAuthenticatedPending(f,{attempt:'partly-applying',status:'applying'}),
 ];
 const plan=await exportState({...f,basis:P.FRESH_BASIS});assert.equal(plan.stats.omittedUnappliedAccessRuns,0);
 const target=await targetDatabase(t, f);
 await P.restoreOwnedState({...f,sales:target,plan,isolatedRecovery:true});
 for(const id of ids)assert.equal((await row(target, 'SELECT count(*)::integer AS n FROM data_import_rows WHERE run_id=$1', [id])).n,1);
 assert.equal((await row(target, 'SELECT payload FROM data_import_changes WHERE run_id=$1', [ids[0]])).payload,'GP before-image must survive');
 assert.ok((await row(target, 'SELECT id FROM import_master_records WHERE id=$1', [uuid(2)])));
 await target.query(FOREIGN_KEYS);
});

async function sourceLink(f, { recordId, table, record, runId, revision }) {
  const def = definitions('trade').find(def => def.name === table), profile = def.profile;
  const id = f.protection.digest(['identity', 'scope', profile.sourceSystem, 'tradefoto-trade', table, profile.entity, profile.keyFields, record.key]);
  await f.salesDb.query('DELETE FROM data_import_links WHERE target_id=$1', [recordId]);
  await insert(f.salesDb, 'data_import_links', { id, scope_id: 'scope', entity: profile.entity, target_id: recordId, revision: 1, last_run_id: runId,
    payload: f.protection.seal({ record, contentHash: f.protection.digest({ record }), targetRevision: revision }, ['link', id]) });
  return id;
}
test('V4 retains only genuine original import baselines of finite Core/master and held stock anchors', cluster.options, async t => {
  const f = await fixture(t, { bulk: 1, authenticated: true });
  const masterId = await sourceLink(f, { recordId: uuid(1), table: 'ARTIKEL_STAMM', record: f.masterValues.get(uuid(1)), runId: f.masterRun, revision: 3 });
  await insert(f.salesDb, 'import_history_holds', { record_id: uuid(1000), consumer_id: 'own-original-stock-reference' });
  const historyId = await sourceLink(f, { recordId: uuid(1000), table: 'ARTIKEL_FILIALEN', record: f.historyValues.get(uuid(1000)), runId: f.historyRun, revision: 1 });
  const { archiveProof, sourceReplayPlan, ...input } = f, plan = await exportState({ ...input, basis: P.FRESH_BASIS });
  const target = await targetDatabase(t, f);
  await P.restoreOwnedState({ ...input, sales: target, plan, isolatedRecovery: true });
  for (const id of [masterId, historyId]) assert.deepEqual((await row(target, 'SELECT * FROM data_import_links WHERE id=$1', [id])), (await row(f.salesDb, 'SELECT * FROM data_import_links WHERE id=$1', [id])));
  assert.equal(plan.tables.find(table => table.table === 'data_import_links').rows, 4, 'only two protected anchor baselines join the two own pending/unknown links');
  await target.query(FOREIGN_KEYS);
});

test('a held WEUM history uses its trade history domain when retaining the original update baseline', cluster.options, async t =>{
 const f=await fixture(t,{bulk:1,authenticated:true}),def=definitions('weum').find(def=>def.name==='WE'),fileSha256='a'.repeat(64),actor={scopeId:'scope',ownerId:'owner'};
 const raw=Object.fromEntries(def.profile.fields.map(field=>[field.source,null]));Object.assign(raw,{We_ID:'501',Menge:'2.5'});
 const prepared=H.prepareTradeFotoHistoryRow(def.source,def.name,raw,{fileSha256,rowNumber:1,profileHash:def.profile.fingerprint}),record=C.normalizeDataImportRow(def.profile,prepared);
 const manifest=C.normalizeDataImportManifest({sourceInstance:'tradefoto-weum',fileSha256,schemaSha256:def.profile.schemaSha256,expectedRows:1,declaredRows:1,snapshotAt:TIME,gates:[]},def.profile);
 const runId=f.protection.digest(['run',C.VERSION,actor,def.profile.fingerprint,manifest,'default']),id=uuid(901),identityHash=H.historyIdentity(f.protection,{scopeId:'scope',sourceInstance:'tradefoto-weum'},def.source,def.name,record.key);
 await insert(f.salesDb,'data_import_runs',{id:runId,scope_id:'scope',owner_id:'owner',attempt_id:'default',profile_hash:def.profile.fingerprint,manifest:JSON.stringify(manifest),status:'applied'});
 await insert(f.salesDb,'import_history_records',{id,scope_id:'scope',source_instance:'tradefoto-weum',source:def.source,source_table:def.name,profile_hash:def.profile.fingerprint,identity_hash:identityHash,revision:1});
 const ctx=['history-version','scope','tradefoto-weum',def.source,def.name,id,identityHash,def.profile.fingerprint,1,fileSha256,TIME,'owner',TIME,runId,'tradefoto-trade',null,null,null];
 await insert(f.salesDb,'import_history_versions',{record_id:id,revision:1,file_sha256:fileSha256,snapshot_at:TIME,imported_by:'owner',imported_at:TIME,run_id:runId,master_source_instance:'tradefoto-trade',business_date:null,parent_id:null,parent_revision:null,
  payload:f.protection.seal({references:[],dependencyToken:'f'.repeat(64),dataHash:f.protection.digest(record.data),restoredFromRevision:null},ctx)});
 for(const segment of H.historySegments(def.source,def.name,record.data,def.profile.fingerprint))await insert(f.salesDb,'import_history_segments',{record_id:id,revision:1,data_class:segment.dataClass,payload:f.protection.seal(segment.data,[...ctx,'segment',segment.dataClass])});
 await insert(f.salesDb,'import_history_holds',{record_id:id,consumer_id:'own-weum-reference'});
 const linkId=f.protection.digest(['identity','scope',def.profile.sourceSystem,'tradefoto-weum',def.name,def.profile.entity,def.profile.keyFields,record.key]);
 const link={id:linkId,scope_id:'scope',entity:def.profile.entity,target_id:id,revision:1,last_run_id:runId,payload:f.protection.seal({record,contentHash:f.protection.digest({record}),targetRevision:1},['link',linkId])};await insert(f.salesDb,'data_import_links',link);
 const plan=await exportState({...f,basis:P.FRESH_BASIS}),target=await targetDatabase(t, f);
 await P.restoreOwnedState({...f,sales:target,plan,isolatedRecovery:true});
 assert.deepEqual({...(await row(target, 'SELECT * FROM data_import_links WHERE id=$1', [linkId]))},link);
 assert.equal((await row(target, 'SELECT count(*)::integer AS n FROM import_history_versions WHERE record_id=$1', [id])).n,1);
 await target.query(FOREIGN_KEYS);
});

test('V4 never retains a fresh update baseline for a GP undo, changed own value or stale original target revision', cluster.options, async t => {
  for (const kind of ['undo', 'changed-value', 'stale-revision']) {
    const f = await fixture(t, { bulk: 1, authenticated: true }), record = structuredClone(f.masterValues.get(uuid(1)));
    if (kind === 'changed-value') { record.source.Artikelbezeichnung = 'Earlier import description'; Object.assign(record, C.normalizeDataImportRow(M.profileFor('ARTIKEL_STAMM'), record.source)); }
    const id = await sourceLink(f, { recordId: uuid(1), table: 'ARTIKEL_STAMM', record, runId: f.masterRun, revision: kind === 'stale-revision' ? 2 : 3 });
    if (kind === 'undo') {
      await insert(f.salesDb, 'data_import_rows', { run_id: f.undoRun, row_number: 1, identity_hash: id, payload: 'own undo row', state: 'reverted' });
      await insert(f.salesDb, 'data_import_changes', { run_id: f.undoRun, row_number: 1, identity_hash: id, payload: 'own undo before-image', reverted_at: TIME });
    }
    const { archiveProof, sourceReplayPlan, ...input } = f, plan = await exportState({ ...input, basis: P.FRESH_BASIS });
    assert.equal(plan.tables.find(table => table.table === 'data_import_links').rows, 2, kind);
    assert.equal(plan.stats.masterAnchors, 4, 'the actual GP source anchor remains protected');
  }
});
