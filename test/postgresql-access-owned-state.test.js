'use strict';
// Actual relational constraints/recursive SQL with a small PostgreSQL transport
// adapter. Native PostgreSQL and Access replay are qualified separately.
const test = require('node:test'), assert = require('node:assert/strict'), { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const C = require('../lib/data-import-contract'), M = require('../lib/tradefoto-master-profiles'), H = require('../lib/tradefoto-history-profiles');
const { definitions } = require('../lib/tradefoto-full-import-source'), { SOURCE_KINDS } = require('../lib/data-import-source-catalog');
const { createDataImportProtection } = require('../lib/data-import-protection');
const P = require('../lib/persistence/postgresql/operations/access-owned-state');
const TIME = '2026-11-16T12:00:00.000Z', sha = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const schema = name => name.startsWith('sales_article') || name === 'sales_articles' || name.startsWith('import_master') ? 'trade' : 'integration';
const DDL = `
CREATE TABLE data_import_runs(id TEXT PRIMARY KEY,scope_id TEXT,owner_id TEXT,profile_hash TEXT,manifest TEXT,status TEXT,attempt_id TEXT NOT NULL DEFAULT 'default');
CREATE TABLE data_import_events(id TEXT PRIMARY KEY,run_id TEXT REFERENCES data_import_runs(id),action TEXT);
CREATE TABLE data_import_rows(run_id TEXT REFERENCES data_import_runs(id),row_number INTEGER,identity_hash TEXT,payload TEXT,state TEXT,PRIMARY KEY(run_id,row_number));
CREATE TABLE data_import_changes(run_id TEXT,row_number INTEGER,identity_hash TEXT,payload TEXT,reverted_at TEXT,PRIMARY KEY(run_id,row_number),FOREIGN KEY(run_id,row_number) REFERENCES data_import_rows(run_id,row_number));
CREATE TABLE data_import_links(id TEXT PRIMARY KEY,scope_id TEXT,entity TEXT,target_id TEXT,revision INTEGER,last_run_id TEXT REFERENCES data_import_runs(id),payload TEXT);
CREATE TABLE data_import_payload_blocks(id TEXT PRIMARY KEY,scope_id TEXT,owner_id TEXT,profile_hash TEXT,source_system TEXT,source_instance TEXT,source_table TEXT,entity TEXT,block_type TEXT,payload TEXT);
CREATE TABLE data_import_row_payload_refs(run_id TEXT,row_number INTEGER,slot TEXT,block_id TEXT REFERENCES data_import_payload_blocks(id),PRIMARY KEY(run_id,row_number,slot),FOREIGN KEY(run_id,row_number) REFERENCES data_import_rows(run_id,row_number));
CREATE TABLE data_import_change_payload_refs(run_id TEXT,row_number INTEGER,slot TEXT,block_id TEXT REFERENCES data_import_payload_blocks(id),PRIMARY KEY(run_id,row_number,slot),FOREIGN KEY(run_id,row_number) REFERENCES data_import_changes(run_id,row_number));
CREATE TABLE data_import_run_state_counts(run_id TEXT REFERENCES data_import_runs(id),state TEXT,count INTEGER,PRIMARY KEY(run_id,state));
CREATE TABLE import_master_records(id TEXT PRIMARY KEY,scope_id TEXT,source_instance TEXT,source_table TEXT,profile_hash TEXT,identity_hash TEXT UNIQUE,revision INTEGER,updated_by TEXT,updated_at TEXT);
CREATE TABLE import_master_segments(record_id TEXT REFERENCES import_master_records(id),kind TEXT,data_class TEXT,payload TEXT,PRIMARY KEY(record_id,kind,data_class));
CREATE TABLE import_master_relations(record_id TEXT REFERENCES import_master_records(id),slot INTEGER,parent_table TEXT,identity_hash TEXT,state TEXT,evidence TEXT,PRIMARY KEY(record_id,slot));
CREATE TABLE import_master_bindings(record_id TEXT PRIMARY KEY REFERENCES import_master_records(id));
CREATE TABLE import_master_events(id TEXT PRIMARY KEY,record_id TEXT);
CREATE TABLE import_master_holds(record_id TEXT REFERENCES import_master_records(id),consumer_id TEXT,PRIMARY KEY(record_id,consumer_id));
CREATE TABLE import_history_records(id TEXT PRIMARY KEY,scope_id TEXT,source_instance TEXT,source TEXT,source_table TEXT,profile_hash TEXT,identity_hash TEXT UNIQUE,revision INTEGER);
CREATE TABLE import_history_versions(record_id TEXT REFERENCES import_history_records(id),revision INTEGER,file_sha256 TEXT,snapshot_at TEXT,imported_by TEXT,imported_at TEXT,run_id TEXT,master_source_instance TEXT,business_date TEXT,parent_id TEXT,parent_revision INTEGER,payload TEXT,PRIMARY KEY(record_id,revision),FOREIGN KEY(parent_id,parent_revision) REFERENCES import_history_versions(record_id,revision));
CREATE TABLE import_history_segments(record_id TEXT,revision INTEGER,data_class TEXT,payload TEXT,PRIMARY KEY(record_id,revision,data_class),FOREIGN KEY(record_id,revision) REFERENCES import_history_versions(record_id,revision));
CREATE TABLE import_history_references(record_id TEXT,revision INTEGER,role TEXT,data_class TEXT,master_record_id TEXT REFERENCES import_master_records(id),lookup_hash TEXT,PRIMARY KEY(record_id,revision,role),FOREIGN KEY(record_id,revision) REFERENCES import_history_versions(record_id,revision));
CREATE TABLE import_history_holds(record_id TEXT REFERENCES import_history_records(id),consumer_id TEXT,PRIMARY KEY(record_id,consumer_id));
CREATE TABLE import_history_snapshots(run_id TEXT PRIMARY KEY,scope_id TEXT,source_instance TEXT,profile_hash TEXT,file_sha256 TEXT,snapshot_at TEXT,owner_id TEXT,expected_rows INTEGER,status TEXT,payload TEXT);
CREATE TABLE import_history_snapshot_members(run_id TEXT REFERENCES import_history_snapshots(run_id),row_number INTEGER,record_id TEXT,revision INTEGER,payload TEXT,PRIMARY KEY(run_id,row_number),FOREIGN KEY(record_id,revision) REFERENCES import_history_versions(record_id,revision));
CREATE TABLE import_history_snapshot_attestations(run_id TEXT PRIMARY KEY REFERENCES import_history_snapshots(run_id),header_payload TEXT);
CREATE TABLE sales_article_import_snapshots(id TEXT PRIMARY KEY,source_system TEXT,source_file_sha256 TEXT);
CREATE TABLE sales_articles(product_id TEXT PRIMARY KEY,article_number TEXT,current_revision INTEGER,FOREIGN KEY(product_id,current_revision) REFERENCES sales_article_revisions(product_id,revision));
CREATE TABLE sales_article_revisions(product_id TEXT REFERENCES sales_articles(product_id),revision INTEGER,article_number TEXT,description TEXT,active INTEGER,source_snapshot_id TEXT REFERENCES sales_article_import_snapshots(id),PRIMARY KEY(product_id,revision),UNIQUE(source_snapshot_id,product_id));
CREATE TABLE sales_article_price_snapshots(id TEXT PRIMARY KEY,product_id TEXT,source_snapshot_id TEXT,amount TEXT,source_field TEXT,FOREIGN KEY(source_snapshot_id,product_id) REFERENCES sales_article_revisions(source_snapshot_id,product_id));
CREATE TABLE sales_article_identifiers(id TEXT PRIMARY KEY,product_id TEXT REFERENCES sales_articles(product_id),source_snapshot_id TEXT REFERENCES sales_article_import_snapshots(id),identifier_value TEXT);
CREATE TABLE sales_article_import_impacts(snapshot_id TEXT REFERENCES sales_article_import_snapshots(id),ordinal INTEGER,product_id TEXT,imported_revision INTEGER,previous_current_revision INTEGER,PRIMARY KEY(snapshot_id,ordinal),FOREIGN KEY(product_id,imported_revision) REFERENCES sales_article_revisions(product_id,revision),FOREIGN KEY(product_id,previous_current_revision) REFERENCES sales_article_revisions(product_id,revision));
CREATE TABLE sales_article_import_findings(snapshot_id TEXT REFERENCES sales_article_import_snapshots(id),ordinal INTEGER,code TEXT,PRIMARY KEY(snapshot_id,ordinal));
CREATE TABLE sales_article_own_images(article_number TEXT PRIMARY KEY,content BLOB);
CREATE TABLE own_unknown_notes(id TEXT PRIMARY KEY,note TEXT);
`;
function client(database) {
  const result = { database, writes: 0, connectionParameters: { host: '/tmp/gp-pg-recovery-ownedfixture', port: 55484 }, async query(sql, args = []) {
    if (sql.startsWith('CREATE TEMP TABLE ')) assert.equal(/\btext\b(?! COLLATE "C")/.test(sql), false, 'temporary text keys must match the source C collation for recursive closure');
    if (sql.startsWith("SELECT current_setting('unix_socket_directories')")) return { rows: [{ socket: this.connectionParameters.host, port: '55484', listen: '' }] };
    if (sql.startsWith('SELECT to_regclass')) {
      const requested = args[0] || sql.match(/to_regclass\('([^']+)'\)/)[1], name = requested.split('.').at(-1);
      return { rows: [{ name: database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)?.name || null }] };
    }
    if (sql.startsWith('SELECT a.attname')) return { rows: database.prepare('PRAGMA table_info("' + args[1] + '")').all().map(c => ({ name: c.name, type: c.type.toLowerCase(), notNull: Boolean(c.notnull), identity: '', generated: '' })) };
    if (sql.startsWith('SELECT count(*)::text AS n FROM pg_trigger')) return { rows: [{ n: '0' }] };
    if (sql.includes('FROM pg_constraint f')) {
      assert.ok(sql.includes('array_agg(ca.attname::text ORDER BY k.ord)') && sql.includes('array_agg(pa.attname::text ORDER BY k.ord)'), 'native pg must receive parsed text[] rather than unparsed name[] metadata');
      const rows = [];
      for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        const groups = new Map();
        for (const fk of database.prepare('PRAGMA foreign_key_list("' + name + '")').all()) { if (!groups.has(fk.id)) groups.set(fk.id, []); groups.get(fk.id).push(fk); }
        for (const keys of groups.values()) { keys.sort((a, b) => a.seq - b.seq); rows.push({ schema: schema(name), table: name, parentSchema: schema(keys[0].table), parentTable: keys[0].table, columns: keys.map(k => k.from), parentColumns: keys.map(k => k.to), validated:true,deferrable:false,enforced:Boolean(database.prepare('PRAGMA foreign_keys').get().foreign_keys),noInheritance:true }); }
      }
      return { rows };
    }
    if (sql.includes('jsonb_populate_recordset')) {
      const name = sql.match(/INSERT INTO "[a-z]+"\."([a-z_]+)"/)[1], rows = JSON.parse(args[0]);
      const fields = database.prepare('PRAGMA table_info("' + name + '")').all().map(c => c.name), stmt = database.prepare('INSERT INTO "' + name + '"(' + fields.join(',') + ') VALUES(' + fields.map(() => '?').join(',') + ')');
      for (const row of rows) { stmt.run(...fields.map(field => row[field])); this.writes++; }
      return { rows: [], rowCount: rows.length };
    }
    if (sql.includes('jsonb_to_recordset')) {
      const target = sql.match(/^INSERT INTO pg_temp\."([a-z0-9_]+)"/)[1], fields = sql.match(/AS r\(([^)]+)\)/)[1].split(',').map(s => s.trim().split(' ')[0]), rows = JSON.parse(args[0]);
      const statement = database.prepare('INSERT OR IGNORE INTO "' + target + '"(' + fields.join(',') + ') VALUES(' + fields.map(() => '?').join(',') + ')');
      for (const row of rows) statement.run(...fields.map(field => typeof row[field] === 'boolean' ? Number(row[field]) : row[field]));
      return { rows: [], rowCount: rows.length };
    }
    let text = sql.replace(/=ANY\((\$\d+)::text\[\]\)/g,' IN (SELECT value FROM json_each($1))').replace(/(?:"(?:trade|integration|gp)"|\b(?:trade|integration|gp|pg_temp))\./g, '').replace(/ ON COMMIT DROP/g, '').replace(/::(?:text|jsonb)/g, '')
      .replace(/jsonb_array_elements_text\((\$\d+)\)/g, 'json_each($1)').replace(/COLLATE "C"/g, 'COLLATE BINARY');
    if (/^INSERT INTO/.test(text) && text.includes('ON CONFLICT DO NOTHING')) text = text.replace(/^INSERT INTO/, 'INSERT OR IGNORE INTO').replace(/ ON CONFLICT DO NOTHING/g, '');
    if (text === 'BEGIN') text = 'SAVEPOINT owned_loader';
    else if (text === 'COMMIT') text = 'RELEASE SAVEPOINT owned_loader';
    else if (text === 'ROLLBACK') text = 'ROLLBACK TO SAVEPOINT owned_loader; RELEASE SAVEPOINT owned_loader';
    if (text.includes('; RELEASE')) { database.exec(text); return { rows: [] }; }
    const bound = []; text = text.replace(/\$([1-9][0-9]*)/g, (_, n) => { const value=args[Number(n)-1];bound.push(Array.isArray(value)?JSON.stringify(value):value); return '?'; });
    const statement = database.prepare(text);
    if (statement.columns().length) return { rows: statement.all(...bound).map(row => { const value = { ...row }; for(const field of ['missing','present']) if (Object.hasOwn(value, field)) value[field] = Boolean(value[field]); if (Object.hasOwn(value, 'n')) value.n = String(value.n); return value; }) };
    return { rows: [], rowCount: Number(statement.run(...bound).changes) };
  } };
  return result;
}
function insert(db, table, row) { const fields = Object.keys(row); db.prepare('INSERT INTO ' + table + '(' + fields.join(',') + ') VALUES(' + fields.map(() => '?').join(',') + ')').run(...fields.map(f => row[f])); }
async function fixture(t, { bulk = 1000, authenticated = false, strictRunKeys = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gp-owned-state-test-'))); await fs.chmod(directory, 0o700);
  const salesDb = new DatabaseSync(':memory:'), coreDb = new DatabaseSync(':memory:'); salesDb.exec('PRAGMA foreign_keys=OFF;' + (strictRunKeys ? DDL.replaceAll('run_id TEXT','run_id TEXT NOT NULL').replaceAll('row_number INTEGER','row_number INTEGER NOT NULL') : DDL));
  coreDb.exec('CREATE TABLE trade_source_references(id TEXT PRIMARY KEY); CREATE TABLE import_master_holds(record_id TEXT,consumer_id TEXT); CREATE TABLE article_reference_snapshots(product_id TEXT,revision INTEGER);');
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 6), indexKey: Buffer.alloc(32, 17), keyId: 'owned-state' });
  t.after(async () => { protection.destroy(); salesDb.close(); coreDb.close(); await fs.rm(directory, { recursive: true, force: true }); });
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
  run(masterRun, masterDef); run(historyRun, historyDef); run(pendingRun, masterDef, 'needs_review'); run(unknownRun, masterDef, 'applied', 'own-source');
  run(undoRun, { profile: undoProfile }, 'reverted', 'tradefoto-cash', 'b'.repeat(64));
  insert(salesDb, 'data_import_events', { id: uuid(90), run_id: undoRun, action: 'import.undo' });
  const masters = [], masterValues = new Map(), historyValues = new Map();
  for (const n of [1, 2, 3, 4, 5]) {
    const raw = Object.fromEntries(masterDef.profile.fields.map(field => [field.source, null])); raw.EAN = String(n); raw.Artikelbezeichnung = n === 1 ? 'Own protected anchor' : 'Source ' + n;
    const normalized = C.normalizeDataImportRow(masterDef.profile, raw), header = { id: uuid(n), scope_id: 'scope', source_instance: n === 4 ? 'own-source' : 'tradefoto-trade', source_table: masterDef.name,
      profile_hash: masterDef.profile.fingerprint, identity_hash: M.masterIdentity(protection, { scopeId: 'scope', sourceInstance: n === 4 ? 'own-source' : 'tradefoto-trade' }, masterDef.name, normalized.key), revision: 3, updated_by: 'owner', updated_at: TIME };
    insert(salesDb, 'import_master_records', header);
    masterValues.set(header.id, normalized);
    for (const segment of M.masterSegments(masterDef.name, normalized.data)) insert(salesDb, 'import_master_segments', { record_id: header.id, kind: segment.kind, data_class: segment.dataClass,
      payload: protection.seal(segment.data, ['master-segment', 'scope', header.source_instance, masterDef.name, header.identity_hash, header.id, header.profile_hash, 3, segment.kind, segment.dataClass]) });
    const runId = n === 3 ? pendingRun : n === 4 ? unknownRun : masterRun;
    insert(salesDb, 'data_import_links', { id: sha('link-' + n), scope_id: 'scope', entity: masterDef.profile.entity, target_id: header.id, revision: 1, last_run_id: runId, payload: 'kept opaque link-' + n }); masters.push(header);
  }
  insert(coreDb, 'import_master_holds', { record_id: uuid(1), consumer_id: 'own-repair-decision' });
  insert(salesDb, 'import_master_relations', { record_id: uuid(1), slot: 0, parent_table: masterDef.name, identity_hash: masters[4].identity_hash, state: 'candidate', evidence: 'own anchor parent' });
  for (const [id, payload] of [[pendingRun, 'Own pending review'], [unknownRun, 'Own Core-target undo']]) {
    insert(salesDb, 'data_import_rows', { run_id: id, row_number: 1, identity_hash: sha('link-' + (id === pendingRun ? 3 : 4)), payload, state: 'conflict' });
    insert(salesDb, 'data_import_changes', { run_id: id, row_number: 1, identity_hash: sha('link-' + (id === pendingRun ? 3 : 4)), payload: payload + ' before-image', reverted_at: null });
    insert(salesDb, 'data_import_run_state_counts', { run_id: id, state: 'conflict', count: 1 });
  }
  const history = (id, def, runId, revision = 1, parent = null, file = fileSha256, ownUndo = false, actor = 'owner') => {
    const sourceName = def.source || 'cash', raw = Object.fromEntries(def.profile.fields.map(field => [field.source, null]));
    if (def.name === 'ARTIKEL_FILIALEN') { raw.EAN = id; raw.FilialID = '18'; }
    else if (def.name === 'Umsatz_KASSE') Object.assign(raw, { Bonnr: id, Filialid: '18', Kassenid: '1', Bondatum: '2010-01-02T00:00:00.000' });
    else raw.RepID = id;
    const normalized = C.normalizeDataImportRow(def.profile, raw), header = { id, scope_id: 'scope', source_instance: sourceName === 'cash' ? 'tradefoto-cash' : 'tradefoto-trade', source: sourceName,
      source_table: def.name, profile_hash: def.profile.fingerprint, identity_hash: H.historyIdentity(protection, { scopeId: 'scope', sourceInstance: sourceName === 'cash' ? 'tradefoto-cash' : 'tradefoto-trade' }, sourceName, def.name, normalized.key, def.profile.fingerprint), revision };
    insert(salesDb, 'import_history_records', header);
    historyValues.set(header.id, normalized);
    for (let rev = 1; rev <= revision; rev++) {
      const v = { record_id: id, revision: rev, file_sha256: rev === revision ? file : fileSha256, snapshot_at: TIME, imported_by: actor, imported_at: TIME,
        run_id: rev === revision ? runId : historyRun, master_source_instance: 'tradefoto-trade', business_date: null, parent_id: parent, parent_revision: parent ? 1 : null };
      const context = ['history-version', 'scope', header.source_instance, sourceName, def.name, id, header.identity_hash, header.profile_hash, rev, v.file_sha256, TIME, actor, TIME, v.run_id, 'tradefoto-trade', null, parent, parent ? 1 : null];
      insert(salesDb, 'import_history_versions', { ...v, payload: protection.seal({ references: [], dependencyToken: 'f'.repeat(64), dataHash: protection.digest(normalized.data), restoredFromRevision: ownUndo && rev === revision ? 1 : null }, context) });
      for (const segment of H.historySegments(sourceName, def.name, normalized.data, def.profile.fingerprint)) insert(salesDb, 'import_history_segments', { record_id: id, revision: rev, data_class: segment.dataClass, payload: protection.seal(segment.data, [...context, 'segment', segment.dataClass]) });
      if (ownUndo && rev === revision) masters.undoContext = context;
    }
  };
  history(uuid(22), { source: 'cash', name: 'Umsatz_KASSE', profile: H.profileFor('cash', 'Umsatz_KASSE') }, historyRun);
  history(uuid(23), { source: 'cash', name: 'Umsatz_Kasse_Details', profile: undoProfile }, undoRun, 2, uuid(22), 'b'.repeat(64), true);
  for (let i = 0; i < bulk; i++) history(uuid(1000 + i), historyDef, historyRun);
  for (const [index, system] of ['tradefoto.artikel_stamm', 'manual.article-catalog', 'tradefoto.article.import.undo', 'unknown.future'].entries()) {
    const snap = sha('snapshot-' + index), product = uuid(200 + index);
    insert(salesDb, 'sales_article_import_snapshots', { id: snap, source_system: system, source_file_sha256: fileSha256 });
    insert(salesDb, 'sales_articles', { product_id: product, article_number: 'A' + index, current_revision: 2 });
    for (const revision of [1, 2]) insert(salesDb, 'sales_article_revisions', { product_id: product, revision, article_number: 'A' + index, description: system + ' original ' + revision, active: 1, source_snapshot_id: revision === 2 ? snap : sha('old-' + index) });
    insert(salesDb, 'sales_article_import_snapshots', { id: sha('old-' + index), source_system: 'tradefoto.artikel_stamm', source_file_sha256: fileSha256 });
    for (const snapshot of [snap, sha('old-' + index)]) insert(salesDb, 'sales_article_price_snapshots', { id: sha('price-' + snapshot), product_id: product, source_snapshot_id: snapshot, amount: '0.300000000001', source_field: 'Vkp1' });
    insert(salesDb, 'sales_article_identifiers', { id: uuid(300 + index), product_id: product, source_snapshot_id: snap, identifier_value: 'own-' + index });
    insert(salesDb, 'sales_article_import_impacts', { snapshot_id: snap, ordinal: 1, product_id: product, imported_revision: 2, previous_current_revision: 1 });
    insert(salesDb, 'sales_article_import_findings', { snapshot_id: snap, ordinal: 1, code: 'source_detail' });
  }
  insert(coreDb, 'article_reference_snapshots', { product_id: uuid(200), revision: 1 });
  insert(salesDb, 'sales_article_own_images', { article_number: 'A1', content: Buffer.from('original own photo') });
  insert(salesDb, 'own_unknown_notes', { id: 'own-note', note: 'Never part of an import' });
  salesDb.exec('PRAGMA foreign_keys=ON'); assert.deepEqual(salesDb.prepare('PRAGMA foreign_key_check').all(), []);
  return { directory, salesDb, coreDb, sales: client(salesDb), core: client(coreDb), protection, archiveProof: proof, sourceReplayPlan, masters, masterValues, historyValues, masterRun, historyRun, pendingRun, undoRun, addHistory: history, addRun: run };
}
function copyNormal(f, target) {
  const projected = new Set(P.PROJECTED_TABLES.map(t => t.table));
  for (const { name } of f.salesDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) if (!projected.has(name)) for (const row of f.salesDb.prepare('SELECT * FROM "' + name + '"').all()) insert(target, name, row);
}
test('sparse state preserves own/unknown/pending rows, Core master hold, native catalog values and a real undo version', async t => {
  const f = await fixture(t), plan = await P.exportOwnedState(f), targetDb = new DatabaseSync(':memory:'); targetDb.exec('PRAGMA foreign_keys=OFF;' + DDL); t.after(() => targetDb.close()); copyNormal(f, targetDb);
  assert.equal(P.validateOwnedPlan(plan), plan); assert.ok(plan.rows < 100); assert.equal(plan.stats.masterAnchors, 4); assert.equal(plan.stats.historyAnchors, 2);
  const result = await P.restoreOwnedState({ ...f, sales: client(targetDb), plan, isolatedRecovery: true }); assert.equal(result.verified, true); assert.equal(result.rehydrated, false);
  targetDb.exec('PRAGMA foreign_keys=ON'); assert.deepEqual(targetDb.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(targetDb.prepare('SELECT id FROM import_master_records ORDER BY id').all().map(r => r.id), [1, 3, 4, 5].map(uuid));
  assert.equal(targetDb.prepare('SELECT COUNT(*) n FROM import_history_records').get().n, 2);
  const undone = targetDb.prepare('SELECT payload FROM import_history_versions WHERE record_id=? AND revision=2').get(uuid(23));
  assert.equal(f.protection.open(undone.payload, f.masters.undoContext).restoredFromRevision, 1);
  assert.deepEqual(targetDb.prepare('SELECT run_id,payload FROM data_import_rows ORDER BY run_id').all().map(r => r.payload).sort(), ['Own Core-target undo', 'Own pending review'].sort());
  assert.equal(targetDb.prepare('SELECT COUNT(*) n FROM sales_article_price_snapshots').get().n, 7);
  assert.equal(targetDb.prepare('SELECT amount FROM sales_article_price_snapshots WHERE id=?').get(sha('price-' + sha('old-0'))).amount, '0.300000000001', 'Core loan snapshot retains its original imported prices');
  assert.equal(targetDb.prepare('SELECT amount FROM sales_article_price_snapshots WHERE id=?').get(sha('price-' + sha('old-2'))).amount, '0.300000000001', 'native undo retains prices of its previous imported revision');
  assert.equal(targetDb.prepare('SELECT amount FROM sales_article_price_snapshots WHERE id=?').get(sha('price-' + sha('snapshot-0'))), undefined, 'ordinary current imported prices await replay');
  assert.equal(targetDb.prepare('SELECT COUNT(*) n FROM sales_article_revisions').get().n, 8);
  assert.equal(Buffer.from(targetDb.prepare('SELECT content FROM sales_article_own_images WHERE article_number=?').get('A1').content).toString(), 'original own photo');
  assert.equal(targetDb.prepare('SELECT note FROM own_unknown_notes').get().note, 'Never part of an import');
  assert.equal(targetDb.prepare('SELECT action FROM data_import_events').get().action, 'import.undo');
  assert.ok(!(await fs.readFile(path.join(f.directory, plan.file), 'utf8')).includes('Own pending review'));
});
test('completed imported row volume does not enlarge the sparse state file or manifest', async t => {
  const small = await fixture(t, { bulk: 1 }), large = await fixture(t, { bulk: 2000 });
  const a = await P.exportOwnedState(small), b = await P.exportOwnedState(large);
  assert.equal(a.rows, b.rows); assert.equal(a.bytes, b.bytes); assert.equal(JSON.stringify(a).length, JSON.stringify(b).length);
  assert.equal(a.tables.find(t => t.table === 'import_history_records').rows, 2);
});

test('pending rows and changes retain their original links even when the last linked run is reconstructible',async t=>{
 const f=await fixture(t,{bulk:1,authenticated:true});
 for(const [number,target] of [[2,2],[3,2],[4,5]])insert(f.salesDb,'data_import_rows',{run_id:f.pendingRun,row_number:number,identity_hash:sha('link-'+target),payload:'own pending association',state:'conflict'});
 for(const [number,target] of [[3,2],[4,5]])insert(f.salesDb,'data_import_changes',{run_id:f.pendingRun,row_number:number,identity_hash:sha('link-'+target),payload:'own pending before-image',reverted_at:null});
 const plan=await P.exportOwnedState({...f,basis:P.FRESH_BASIS}),target=new DatabaseSync(':memory:');target.exec('PRAGMA foreign_keys=OFF;'+DDL);t.after(()=>target.close());copyNormal(f,target);
 await P.restoreOwnedState({...f,sales:client(target),plan,isolatedRecovery:true});
 assert.deepEqual(target.prepare('SELECT id FROM data_import_links ORDER BY id').all().map(row=>row.id),[2,3,4,5].map(n=>sha('link-'+n)).sort());
 assert.deepEqual(target.prepare('SELECT id FROM import_master_records ORDER BY id').all().map(row=>row.id),[1,2,3,4,5].map(uuid));
 assert.equal(target.prepare('SELECT count(*) AS n FROM data_import_rows').get().n,5);
 target.exec('PRAGMA foreign_keys=ON');assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('uncovered current source facts and unexpected incoming GP foreign keys refuse the reduced point', async t => {
  const f = await fixture(t, { bulk: 1 }); f.sourceReplayPlan.sources[0].tables.find(t => t.name === 'ARTIKEL_FILIALEN').runId = sha('not-the-current-run');
  const { planSha256, ...body } = f.sourceReplayPlan; f.sourceReplayPlan.planSha256 = sha(C.canonical(body));
  await assert.rejects(P.exportOwnedState(f), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  await assert.rejects(fs.access(path.join(f.directory, P.FILE)), { code: 'ENOENT' });
  const master = await fixture(t, { bulk: 1 }); master.salesDb.prepare('DELETE FROM data_import_links WHERE target_id=?').run(uuid(2));
  await assert.rejects(P.exportOwnedState(master), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  const price = await fixture(t, { bulk: 1 }); price.salesDb.prepare('UPDATE sales_article_import_snapshots SET source_file_sha256=? WHERE id=?').run('b'.repeat(64), sha('snapshot-0'));
  await assert.rejects(P.exportOwnedState(price), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  const g = await fixture(t, { bulk: 1 }); g.salesDb.exec('CREATE TABLE own_new_history_reference(id TEXT PRIMARY KEY,record_id TEXT REFERENCES import_history_records(id));');
  insert(g.salesDb, 'own_new_history_reference', { id: 'own', record_id: uuid(1000) });
  await assert.rejects(P.exportOwnedState(g), error => error.code === 'PG_DEPLOY_OWNED_FK_CLOSURE');
});
test('component hardlinks, ancestor junctions, corrupted bytes and live sockets are rejected before inserts', async t => {
  const f = await fixture(t, { bulk: 1 }), plan = await P.exportOwnedState(f), empty = new DatabaseSync(':memory:'); empty.exec(DDL); t.after(() => empty.close()); const sales = client(empty);
  const component = path.join(f.directory, P.FILE), linked = path.join(f.directory, 'extra-hardlink'); await fs.link(component, linked);
  await assert.rejects(P.restoreOwnedState({ ...f, sales, plan, isolatedRecovery: true }), /OWNED_FILE/); await fs.unlink(linked);
  const ancestor = path.join(f.directory, 'alias'); await fs.symlink(f.directory, ancestor, 'junction');
  await assert.rejects(P.restoreOwnedState({ ...f, sales, plan, directory: ancestor, isolatedRecovery: true }), /OWNED_DIRECTORY/);
  const remote = client(empty); remote.connectionParameters.host = '127.0.0.1';
  await assert.rejects(P.restoreOwnedState({ ...f, sales: remote, plan, isolatedRecovery: true }), /ISOLATION_REQUIRED/);
  const bytes = await fs.readFile(component); bytes[20] ^= 1; await fs.writeFile(component, bytes);
  await assert.rejects(P.restoreOwnedState({ ...f, sales, plan, isolatedRecovery: true }), /FILE_HASH/); assert.equal(sales.writes, 0);
});
test('failed sparse insertion rolls back every projected row and retains normal own state', async t => {
  const f = await fixture(t, { bulk: 1 }), plan = await P.exportOwnedState(f), target = new DatabaseSync(':memory:'); target.exec('PRAGMA foreign_keys=OFF;' + DDL); t.after(() => target.close()); copyNormal(f, target);
  const sales = client(target), query = sales.query.bind(sales); let inserts = 0;
  sales.query = async (sql, args) => { if (sql.includes('jsonb_populate_recordset') && ++inserts === 3) throw new Error('synthetic sparse insert failure'); return query(sql, args); };
  await assert.rejects(P.restoreOwnedState({ ...f, sales, plan, isolatedRecovery: true }), /synthetic sparse insert failure/);
  for (const table of P.PROJECTED_TABLES) assert.equal(target.prepare('SELECT count(*) n FROM "' + table.table + '"').get().n, 0);
  assert.equal(target.prepare('SELECT note FROM own_unknown_notes').get().note, 'Never part of an import');
});
test('large unknown GP evidence is chunked without exposing or changing its original bytes', async t => {
  const f = await fixture(t, { bulk: 1 }), value = 'own-protected-opaque-' + 'q'.repeat(1_200_000);
  f.salesDb.prepare('UPDATE data_import_rows SET payload=? WHERE run_id=?').run(value, f.pendingRun);
  const plan = await P.exportOwnedState(f), target = new DatabaseSync(':memory:'); target.exec('PRAGMA foreign_keys=OFF;' + DDL); t.after(() => target.close()); copyNormal(f, target);
  assert.ok(!(await fs.readFile(path.join(f.directory, plan.file), 'utf8')).includes('own-protected-opaque-'));
  await P.restoreOwnedState({ ...f, sales: client(target), plan, isolatedRecovery: true });
  assert.equal(target.prepare('SELECT payload FROM data_import_rows WHERE run_id=?').get(f.pendingRun).payload, value);
});
test('legacy cash omission is covered by its actual batch actor and never by the compact source checkpoint alone', async t => {
  const f = await fixture(t, { bulk: 1 }), cashProfile = H.profileFor('cash', 'Umsatz_KASSE'), runId = sha('legacy-cash-run'), fileSha256 = 'a'.repeat(64);
  f.addRun(runId, { profile: cashProfile }, 'applied', 'tradefoto-cash'); f.salesDb.prepare('UPDATE data_import_runs SET owner_id=? WHERE id=?').run('legacy-owner', runId);
  f.addHistory(uuid(700), { source: 'cash', name: 'Umsatz_KASSE', profile: cashProfile }, runId, 1, null, fileSha256, false, 'legacy-owner');
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
  const plan = await P.exportOwnedState(f); assert.equal(plan.stats.historyAnchors, 2);
  const bytes = await fs.readFile(path.join(f.directory, P.FILE));
  cash.genericCashBatches[0].ownerId = 'owner'; rehash();
  await assert.rejects(P.exportOwnedState(f), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
  assert.deepEqual(await fs.readFile(path.join(f.directory, P.FILE)), bytes, 'an admission failure must never unlink an existing component');
  cash.genericCashBatches[0].ownerId = 'legacy-owner'; rehash();
  await assert.rejects(P.exportOwnedState(f), { code: 'EEXIST' }); assert.deepEqual(await fs.readFile(path.join(f.directory, P.FILE)), bytes);
});

test('a retained stock anchor must be an authenticated current member of the required published snapshot', async t => {
  const make = async (ownUndo = false) => {
    const f = await fixture(t, { bulk: 0 }), recordId = uuid(1000), def = definitions('trade').find(d => d.name === 'ARTIKEL_FILIALEN'), profileHash = def.profile.fingerprint;
    f.addHistory(recordId, def, ownUndo ? f.undoRun : f.historyRun, ownUndo ? 2 : 1, null, 'a'.repeat(64), ownUndo);
    insert(f.salesDb, 'import_history_holds', { record_id: recordId, consumer_id: 'own-stock-decision' });
    const stock = { scopeId: 'scope', sourceInstance: 'tradefoto-trade', profileHash, fileSha256: 'a'.repeat(64), snapshotAt: TIME, ownerId: 'owner', expectedRows: 1, originalRunId: f.historyRun };
    const header = ['history-snapshot', f.historyRun, 'scope', 'tradefoto-trade', profileHash, stock.fileSha256, TIME, 'owner', 1];
    insert(f.salesDb, 'import_history_snapshots', { run_id: f.historyRun, scope_id: 'scope', source_instance: 'tradefoto-trade', profile_hash: profileHash, file_sha256: stock.fileSha256,
      snapshot_at: TIME, owner_id: 'owner', expected_rows: 1, status: 'published', payload: f.protection.seal({ version: 1 }, [...header, 'published']) });
    const record = f.salesDb.prepare('SELECT r.*,v.file_sha256,v.snapshot_at,v.imported_by,v.imported_at,v.run_id,v.master_source_instance,v.business_date,v.parent_id,v.parent_revision,v.payload FROM import_history_records r JOIN import_history_versions v ON v.record_id=r.id AND v.revision=1 WHERE r.id=?').get(recordId);
    const version = f.protection.open(record.payload, ['history-version', 'scope', 'tradefoto-trade', 'trade', 'ARTIKEL_FILIALEN', recordId, record.identity_hash, profileHash, 1, stock.fileSha256, TIME, 'owner', TIME, f.historyRun, 'tradefoto-trade', null, null, null]);
    insert(f.salesDb, 'import_history_snapshot_members', { run_id: f.historyRun, row_number: 1, record_id: recordId, revision: 1, payload: f.protection.seal({ dataHash: version.dataHash }, [...header, 'building', 'member', 1, recordId, 1]) });
    f.sourceReplayPlan.stockPublications.push(stock); const { planSha256, ...body } = f.sourceReplayPlan; f.sourceReplayPlan.planSha256 = sha(C.canonical(body));
    return f;
  };
  const positive = await make(), plan = await P.exportOwnedState(positive); assert.equal(plan.stats.historyAnchors, 3);
  const mismatch = await make(true); assert.deepEqual(mismatch.salesDb.prepare('PRAGMA foreign_key_check').all(), []);
  await assert.rejects(P.exportOwnedState(mismatch), { code: 'PG_DEPLOY_ACCESS_STOCK_ANCHOR' });
  await assert.rejects(fs.access(path.join(mismatch.directory, P.FILE)), { code: 'ENOENT' });
  const corrupt = await make(); corrupt.salesDb.prepare('UPDATE import_history_snapshots SET payload=?').run('corrupt-publication-proof');
  await assert.rejects(P.exportOwnedState(corrupt));
  const stale = await make(); insert(stale.salesDb, 'import_history_snapshots', { ...stale.salesDb.prepare('SELECT * FROM import_history_snapshots').get(), run_id: sha('newer-publication'), snapshot_at: '2026-11-16T13:00:00.000Z' });
  await assert.rejects(P.exportOwnedState(stale), { code: 'PG_DEPLOY_ACCESS_STOCK_ANCHOR' });
  const omitted = await make(); omitted.sourceReplayPlan.stockPublications = []; const { planSha256, ...body } = omitted.sourceReplayPlan; omitted.sourceReplayPlan.planSha256 = sha(C.canonical(body));
  await assert.rejects(P.exportOwnedState(omitted), { code: 'PG_DEPLOY_ACCESS_STOCK_ANCHOR' });
});

test('fresh-generation V4 creates and restores sparse GP state without old originals or a future source plan', async t => {
  const f = await fixture(t, { bulk: 2000, authenticated: true }), { archiveProof, sourceReplayPlan, ...input } = f;
  const plan = await P.exportOwnedState({ ...input, basis: P.FRESH_BASIS });
  assert.equal(plan.format, P.FRESH_FORMAT); assert.equal(plan.basis, 'fresh-source-rebuild'); assert.equal(Object.hasOwn(plan, 'archiveGenerationSha256'), false);
  assert.equal(plan.stats.completedAccessRuns, 3); assert.equal(plan.stats.masterAnchors, 4); assert.equal(plan.stats.historyAnchors, 2); assert.ok(plan.rows < 100);
  const target = new DatabaseSync(':memory:'); target.exec('PRAGMA foreign_keys=OFF;' + DDL); t.after(() => target.close()); copyNormal(f, target);
  const restored = await P.restoreOwnedState({ ...input, sales: client(target), plan, isolatedRecovery: true });
  assert.equal(restored.verified, true); assert.equal(restored.requiresFreshAccess, true); assert.equal(restored.rehydrated, false);
  target.exec('PRAGMA foreign_keys=ON'); assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(target.prepare('SELECT count(*) n FROM import_history_records').get().n, 2, 'bulk Access facts can be regenerated from a new generation');
  assert.equal(target.prepare('SELECT payload FROM data_import_rows WHERE run_id=?').get(f.pendingRun).payload, 'Own pending review');
  assert.equal(target.prepare('SELECT payload FROM data_import_changes WHERE run_id=?').get(sha('unknown')).payload, 'Own Core-target undo before-image');
  assert.equal(target.prepare('SELECT description FROM sales_article_revisions WHERE product_id=? AND revision=2').get(uuid(201)).description, 'manual.article-catalog original 2');
  assert.equal(target.prepare('SELECT amount FROM sales_article_price_snapshots WHERE id=?').get(sha('price-' + sha('old-0'))).amount, '0.300000000001');
  assert.equal(Buffer.from(target.prepare('SELECT content FROM sales_article_own_images').get().content).toString(), 'original own photo');
  const tampered = { ...plan, archiveGenerationSha256: 'f'.repeat(64) }; assert.throws(() => P.validateOwnedPlan(tampered), /OWNED_SHAPE/);
  assert.throws(() => P.validateOwnedPlan({ ...plan, basis: 'archived-originals' }), /OWNED_PLAN/);
  await assert.rejects(P.exportOwnedState({ ...input, basis: 'archive-optional' }), /OWNED_BASIS/);
});

test('fresh omission requires actual completed run HMAC, exact schema and recognized profile namespace', async t => {
  const f = await fixture(t, { bulk: 1, authenticated: true }), row = f.salesDb.prepare('SELECT * FROM data_import_runs WHERE id=?').get(f.masterRun);
  const options = { basis: P.FRESH_BASIS, protection: f.protection };
  assert.equal(P.classifyRun(row, options).omit, true);
  for (const mutate of [copy => copy.id = sha('forged-run'), copy => copy.owner_id = 'other-owner', copy => copy.attempt_id = 'other-attempt',
    copy => copy.profile_hash = 'f'.repeat(64), copy => copy.status = 'needs_review',
    copy => { const data = JSON.parse(copy.manifest); data.schemaSha256 = 'f'.repeat(64); copy.manifest = JSON.stringify(data); },
    copy => { const data = JSON.parse(copy.manifest); data.sourceInstance = 'own-source'; copy.manifest = JSON.stringify(data); }]) {
    const copy = { ...row }; mutate(copy); assert.equal(P.classifyRun(copy, options).omit, false);
  }
  const forgedRun = sha('own-evidence-with-copied-source-profile'); f.addRun(forgedRun, definitions('trade').find(d => d.name === 'ARTIKEL_STAMM'));
  insert(f.salesDb, 'data_import_rows', { run_id: forgedRun, row_number: 1, identity_hash: sha('own-row'), payload: 'own evidence with copied Access profile', state: 'conflict' });
  const { archiveProof, sourceReplayPlan, ...input } = f, plan = await P.exportOwnedState({ ...input, basis: P.FRESH_BASIS });
  assert.equal(plan.stats.retainedPendingOrUnknownRuns, 3); assert.equal(plan.tables.find(table => table.table === 'data_import_rows').rows, 3);
});

test('fresh-generation mode still rejects missing retained foreign-key anchors before sealing', async t => {
  const f = await fixture(t, { bulk: 1, authenticated: true }), { archiveProof, sourceReplayPlan, ...input } = f;
  f.salesDb.exec('CREATE TABLE own_future_history_link(id TEXT PRIMARY KEY,record_id TEXT REFERENCES import_history_records(id))');
  insert(f.salesDb, 'own_future_history_link', { id: 'own', record_id: uuid(1000) });
  await assert.rejects(P.exportOwnedState({ ...input, basis: P.FRESH_BASIS }), { code: 'PG_DEPLOY_OWNED_FK_CLOSURE' });
  await assert.rejects(fs.access(path.join(f.directory, P.FILE)), { code: 'ENOENT' });
});

test('indexed history closure checks the complete composite key of retained segments', async t => {
  const f = await fixture(t, { bulk: 1, authenticated: true });
  const retained = uuid(1000);
  insert(f.salesDb, 'import_history_holds', { record_id: retained, consumer_id: 'own-revision-link' });
  f.salesDb.exec('PRAGMA foreign_keys=OFF');
  insert(f.salesDb, 'import_history_segments', {
    record_id: retained, revision: 900000, data_class: 'sales', payload: 'missing revision fixture',
  });
  await assert.rejects(P.exportOwnedState({ ...f, basis: P.FRESH_BASIS }), { code: 'PG_DEPLOY_OWNED_FK_CLOSURE' });
  await assert.rejects(fs.access(path.join(f.directory, P.FILE)), { code: 'ENOENT' });
});

async function onlyCompletedRuns(t,{strictRunKeys=true}={}) {
 const f=await fixture(t,{bulk:1,authenticated:true,strictRunKeys});
 f.salesDb.exec('DELETE FROM data_import_change_payload_refs; DELETE FROM data_import_row_payload_refs; DELETE FROM data_import_changes; DELETE FROM data_import_rows; DELETE FROM data_import_run_state_counts; DELETE FROM data_import_events;');
 f.salesDb.prepare('DELETE FROM data_import_links WHERE last_run_id NOT IN (?,?)').run(f.masterRun,f.historyRun);
 f.salesDb.prepare('DELETE FROM data_import_runs WHERE id NOT IN (?,?)').run(f.masterRun,f.historyRun);
 insert(f.salesDb,'data_import_rows',{run_id:f.masterRun,row_number:1,identity_hash:sha('rebuild-row'),payload:'derived source row',state:'unchanged'});
 insert(f.salesDb,'data_import_changes',{run_id:f.masterRun,row_number:1,identity_hash:sha('rebuild-row'),payload:'derived change',reverted_at:null});
 insert(f.salesDb,'data_import_payload_blocks',{id:'block',scope_id:'scope',owner_id:'owner',profile_hash:'unknown',source_system:'own',source_instance:'own',source_table:'own',entity:'own',block_type:'source',payload:'own block'});
 for(const name of ['data_import_row_payload_refs','data_import_change_payload_refs'])insert(f.salesDb,name,{run_id:f.masterRun,row_number:1,slot:'source',block_id:'block'});
 insert(f.salesDb,'data_import_run_state_counts',{run_id:f.masterRun,state:'unchanged',count:1});
 insert(f.salesDb,'import_history_snapshots',{run_id:f.historyRun,scope_id:'scope',source_instance:'tradefoto-trade',profile_hash:definitions('trade').find(d=>d.name==='ARTIKEL_FILIALEN').profile.fingerprint,file_sha256:'a'.repeat(64),snapshot_at:TIME,owner_id:'owner',expected_rows:1,status:'published',payload:'source snapshot'});
 insert(f.salesDb,'import_history_snapshot_members',{run_id:f.historyRun,row_number:1,record_id:uuid(1000),revision:1,payload:'source member'});
 return f;
}

test('proven empty source selections avoid source export/FK scans including composite FK run chains',async t=>{
 const f=await onlyCompletedRuns(t),queries=[],query=f.sales.query.bind(f.sales);
 f.sales.query=async(sql,args)=>{queries.push(sql);return query(sql,args);};
 const plan=await P.exportOwnedState({...f,basis:P.FRESH_BASIS});
 for(const table of ['data_import_rows','data_import_changes','data_import_run_state_counts','data_import_row_payload_refs','data_import_change_payload_refs','import_history_snapshots','import_history_snapshot_members','import_history_snapshot_attestations']){
  assert.equal(plan.tables.find(t=>t.table===table).rows,0,table);
  assert.equal(queries.some(sql=>sql.startsWith('SELECT t.* FROM "integration"."'+table+'"')),false,table+' export');
  assert.equal(queries.some(sql=>sql.startsWith('SELECT EXISTS(SELECT 1 FROM "integration"."'+table+'" c')),false,table+' FK');
 }
 assert.equal(plan.tables.find(t=>t.table==='data_import_payload_blocks').rows,1,'unknown own block remains');
});

test('run empty shortcut requires validated enforced non-deferrable NOT NULL FKs without inheritance',async t=>{
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
  await P.exportOwnedState({...f,basis:P.FRESH_BASIS});
  assert.equal(queries.some(sql=>sql.startsWith('SELECT t.* FROM "integration"."data_import_rows"')),true,kind);
 }
});

test('nullable and orphan run rows remain conservative when the FK shortcut cannot be proven',async t=>{
 const f=await onlyCompletedRuns(t,{strictRunKeys:false});
 f.salesDb.exec('PRAGMA foreign_keys=OFF');
 for(const [runId,rowNumber]of[[null,2],['missing-own-run',3]])insert(f.salesDb,'data_import_rows',{run_id:runId,row_number:rowNumber,identity_hash:sha('own'+rowNumber),payload:'own unresolved '+rowNumber,state:'conflict'});
 f.salesDb.exec('PRAGMA foreign_keys=ON');
 const plan=await P.exportOwnedState({...f,basis:P.FRESH_BASIS});
 assert.equal(plan.tables.find(table=>table.table==='data_import_rows').rows,2,'neither nullable nor unresolved own row is classified as reconstructible');
});

function addAuthenticatedPending(f,{status='ready',attempt='pending-source-only',state='create',change=false}={}){
 const original=f.salesDb.prepare('SELECT * FROM data_import_runs WHERE id=?').get(f.masterRun),manifest=JSON.parse(original.manifest);
 const id=f.protection.digest(['run',C.VERSION,{scopeId:original.scope_id,ownerId:original.owner_id},original.profile_hash,manifest,attempt]);
 insert(f.salesDb,'data_import_runs',{...original,id,attempt_id:attempt,status});
 insert(f.salesDb,'data_import_rows',{run_id:id,row_number:1,identity_hash:sha('link-2'),payload:'Access-derived uncommitted preview',state});
 insert(f.salesDb,'data_import_events',{id:crypto.randomUUID(),run_id:id,action:'import.source-tolerance.accepted:'+sha('own-count-decision')});
 if(change)insert(f.salesDb,'data_import_changes',{run_id:id,row_number:1,identity_hash:sha('link-2'),payload:'GP before-image must survive',reverted_at:null});
 return id;
}

test('authenticated unapplied Access previews are omitted while their original decision headers and audit events remain',async t=>{
 const f=await fixture(t,{bulk:1,authenticated:true}),ids=['staging','reviewing','ready','needs_review','cancelled'].map(status=>addAuthenticatedPending(f,{status,attempt:'source-only-'+status}));
 const plan=await P.exportOwnedState({...f,basis:P.FRESH_BASIS});assert.equal(plan.stats.omittedUnappliedAccessRuns,5);
 const target=new DatabaseSync(':memory:');target.exec('PRAGMA foreign_keys=OFF;'+DDL);t.after(()=>target.close());copyNormal(f,target);
 await P.restoreOwnedState({...f,sales:client(target),plan,isolatedRecovery:true});
 for(const id of ids){
  assert.equal(target.prepare('SELECT count(*) AS n FROM data_import_rows WHERE run_id=?').get(id).n,0);
  assert.deepEqual(target.prepare('SELECT * FROM data_import_runs WHERE id=?').get(id),f.salesDb.prepare('SELECT * FROM data_import_runs WHERE id=?').get(id));
  assert.deepEqual(target.prepare('SELECT * FROM data_import_events WHERE run_id=?').get(id),f.salesDb.prepare('SELECT * FROM data_import_events WHERE run_id=?').get(id));
 }
 assert.equal(target.prepare('SELECT id FROM import_master_records WHERE id=?').get(uuid(2)),undefined,'source-only previews must not pull reconstructible target graphs into the point');
 assert.equal(target.prepare('SELECT payload FROM data_import_rows WHERE run_id=?').get(f.pendingRun).payload,'Own pending review','unauthenticated or unknown pending evidence remains protected');
 target.exec('PRAGMA foreign_keys=ON');assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('pending Access status cannot omit actual before-images, applied rows, undo rows or an in-progress apply',async t=>{
 const f=await fixture(t,{bulk:1,authenticated:true}),ids=[
  addAuthenticatedPending(f,{attempt:'with-before-image',change:true}),addAuthenticatedPending(f,{attempt:'with-applied-row',state:'applied'}),
  addAuthenticatedPending(f,{attempt:'with-undo-row',state:'reverted'}),addAuthenticatedPending(f,{attempt:'partly-applying',status:'applying'}),
 ];
 const plan=await P.exportOwnedState({...f,basis:P.FRESH_BASIS});assert.equal(plan.stats.omittedUnappliedAccessRuns,0);
 const target=new DatabaseSync(':memory:');target.exec('PRAGMA foreign_keys=OFF;'+DDL);t.after(()=>target.close());copyNormal(f,target);
 await P.restoreOwnedState({...f,sales:client(target),plan,isolatedRecovery:true});
 for(const id of ids)assert.equal(target.prepare('SELECT count(*) AS n FROM data_import_rows WHERE run_id=?').get(id).n,1);
 assert.equal(target.prepare('SELECT payload FROM data_import_changes WHERE run_id=?').get(ids[0]).payload,'GP before-image must survive');
 assert.ok(target.prepare('SELECT id FROM import_master_records WHERE id=?').get(uuid(2)));
 target.exec('PRAGMA foreign_keys=ON');assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(),[]);
});

function sourceLink(f, { recordId, table, record, runId, revision }) {
  const def = definitions('trade').find(def => def.name === table), profile = def.profile;
  const id = f.protection.digest(['identity', 'scope', profile.sourceSystem, 'tradefoto-trade', table, profile.entity, profile.keyFields, record.key]);
  f.salesDb.prepare('DELETE FROM data_import_links WHERE target_id=?').run(recordId);
  insert(f.salesDb, 'data_import_links', { id, scope_id: 'scope', entity: profile.entity, target_id: recordId, revision: 1, last_run_id: runId,
    payload: f.protection.seal({ record, contentHash: f.protection.digest({ record }), targetRevision: revision }, ['link', id]) });
  return id;
}
test('V4 retains only genuine original import baselines of finite Core/master and held stock anchors', async t => {
  const f = await fixture(t, { bulk: 1, authenticated: true });
  const masterId = sourceLink(f, { recordId: uuid(1), table: 'ARTIKEL_STAMM', record: f.masterValues.get(uuid(1)), runId: f.masterRun, revision: 3 });
  insert(f.salesDb, 'import_history_holds', { record_id: uuid(1000), consumer_id: 'own-original-stock-reference' });
  const historyId = sourceLink(f, { recordId: uuid(1000), table: 'ARTIKEL_FILIALEN', record: f.historyValues.get(uuid(1000)), runId: f.historyRun, revision: 1 });
  const { archiveProof, sourceReplayPlan, ...input } = f, plan = await P.exportOwnedState({ ...input, basis: P.FRESH_BASIS });
  const target = new DatabaseSync(':memory:'); target.exec('PRAGMA foreign_keys=OFF;' + DDL); t.after(() => target.close()); copyNormal(f, target);
  await P.restoreOwnedState({ ...input, sales: client(target), plan, isolatedRecovery: true });
  for (const id of [masterId, historyId]) assert.deepEqual(target.prepare('SELECT * FROM data_import_links WHERE id=?').get(id), f.salesDb.prepare('SELECT * FROM data_import_links WHERE id=?').get(id));
  assert.equal(plan.tables.find(table => table.table === 'data_import_links').rows, 4, 'only two protected anchor baselines join the two own pending/unknown links');
  target.exec('PRAGMA foreign_keys=ON'); assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a held WEUM history uses its trade history domain when retaining the original update baseline',async t=>{
 const f=await fixture(t,{bulk:1,authenticated:true}),def=definitions('weum').find(def=>def.name==='WE'),fileSha256='a'.repeat(64),actor={scopeId:'scope',ownerId:'owner'};
 const raw=Object.fromEntries(def.profile.fields.map(field=>[field.source,null]));Object.assign(raw,{We_ID:'501',Menge:'2.5'});
 const prepared=H.prepareTradeFotoHistoryRow(def.source,def.name,raw,{fileSha256,rowNumber:1,profileHash:def.profile.fingerprint}),record=C.normalizeDataImportRow(def.profile,prepared);
 const manifest=C.normalizeDataImportManifest({sourceInstance:'tradefoto-weum',fileSha256,schemaSha256:def.profile.schemaSha256,expectedRows:1,declaredRows:1,snapshotAt:TIME,gates:[]},def.profile);
 const runId=f.protection.digest(['run',C.VERSION,actor,def.profile.fingerprint,manifest,'default']),id=uuid(901),identityHash=H.historyIdentity(f.protection,{scopeId:'scope',sourceInstance:'tradefoto-weum'},def.source,def.name,record.key);
 insert(f.salesDb,'data_import_runs',{id:runId,scope_id:'scope',owner_id:'owner',attempt_id:'default',profile_hash:def.profile.fingerprint,manifest:JSON.stringify(manifest),status:'applied'});
 insert(f.salesDb,'import_history_records',{id,scope_id:'scope',source_instance:'tradefoto-weum',source:def.source,source_table:def.name,profile_hash:def.profile.fingerprint,identity_hash:identityHash,revision:1});
 const ctx=['history-version','scope','tradefoto-weum',def.source,def.name,id,identityHash,def.profile.fingerprint,1,fileSha256,TIME,'owner',TIME,runId,'tradefoto-trade',null,null,null];
 insert(f.salesDb,'import_history_versions',{record_id:id,revision:1,file_sha256:fileSha256,snapshot_at:TIME,imported_by:'owner',imported_at:TIME,run_id:runId,master_source_instance:'tradefoto-trade',business_date:null,parent_id:null,parent_revision:null,
  payload:f.protection.seal({references:[],dependencyToken:'f'.repeat(64),dataHash:f.protection.digest(record.data),restoredFromRevision:null},ctx)});
 for(const segment of H.historySegments(def.source,def.name,record.data,def.profile.fingerprint))insert(f.salesDb,'import_history_segments',{record_id:id,revision:1,data_class:segment.dataClass,payload:f.protection.seal(segment.data,[...ctx,'segment',segment.dataClass])});
 insert(f.salesDb,'import_history_holds',{record_id:id,consumer_id:'own-weum-reference'});
 const linkId=f.protection.digest(['identity','scope',def.profile.sourceSystem,'tradefoto-weum',def.name,def.profile.entity,def.profile.keyFields,record.key]);
 const link={id:linkId,scope_id:'scope',entity:def.profile.entity,target_id:id,revision:1,last_run_id:runId,payload:f.protection.seal({record,contentHash:f.protection.digest({record}),targetRevision:1},['link',linkId])};insert(f.salesDb,'data_import_links',link);
 const plan=await P.exportOwnedState({...f,basis:P.FRESH_BASIS}),target=new DatabaseSync(':memory:');target.exec('PRAGMA foreign_keys=OFF;'+DDL);t.after(()=>target.close());copyNormal(f,target);
 await P.restoreOwnedState({...f,sales:client(target),plan,isolatedRecovery:true});
 assert.deepEqual({...target.prepare('SELECT * FROM data_import_links WHERE id=?').get(linkId)},link);
 assert.equal(target.prepare('SELECT count(*) AS n FROM import_history_versions WHERE record_id=?').get(id).n,1);
 target.exec('PRAGMA foreign_keys=ON');assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('V4 never retains a fresh update baseline for a GP undo, changed own value or stale original target revision', async t => {
  for (const kind of ['undo', 'changed-value', 'stale-revision']) {
    const f = await fixture(t, { bulk: 1, authenticated: true }), record = structuredClone(f.masterValues.get(uuid(1)));
    if (kind === 'changed-value') { record.source.Artikelbezeichnung = 'Earlier import description'; Object.assign(record, C.normalizeDataImportRow(M.profileFor('ARTIKEL_STAMM'), record.source)); }
    const id = sourceLink(f, { recordId: uuid(1), table: 'ARTIKEL_STAMM', record, runId: f.masterRun, revision: kind === 'stale-revision' ? 2 : 3 });
    if (kind === 'undo') {
      insert(f.salesDb, 'data_import_rows', { run_id: f.undoRun, row_number: 1, identity_hash: id, payload: 'own undo row', state: 'reverted' });
      insert(f.salesDb, 'data_import_changes', { run_id: f.undoRun, row_number: 1, identity_hash: id, payload: 'own undo before-image', reverted_at: TIME });
    }
    const { archiveProof, sourceReplayPlan, ...input } = f, plan = await P.exportOwnedState({ ...input, basis: P.FRESH_BASIS });
    assert.equal(plan.tables.find(table => table.table === 'data_import_links').rows, 2, kind);
    assert.equal(plan.stats.masterAnchors, 4, 'the actual GP source anchor remains protected');
  }
});
