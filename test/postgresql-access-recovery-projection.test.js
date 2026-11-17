'use strict';
// Transport/crypto/selection regression tests with a bounded synthetic SQL
// adapter. Native PostgreSQL and real Access parser qualification are separate.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const C = require('../lib/data-import-contract');
const { SOURCE_KINDS } = require('../lib/data-import-source-catalog');
const { definitions } = require('../lib/tradefoto-full-import-source');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportPayloadStore } = require('../lib/data-import-payload-store');
const P = require('../lib/persistence/postgresql/operations/access-recovery-projection');
const checksum = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => checksum(C.canonical(value));
const copy = value => JSON.parse(JSON.stringify(value));
const TIME = '2026-11-16T12:00:00.000Z';
const keys = {
  import_master_segments: ['record_id', 'kind', 'data_class'], import_history_segments: ['record_id', 'revision', 'data_class'],
  data_import_payload_blocks: ['id'], data_import_rows: ['run_id', 'row_number'], data_import_changes: ['run_id', 'row_number'],
  data_import_links: ['id'], sales_article_revisions: ['product_id', 'revision'], sales_article_price_snapshots: ['id'],
};
const baseColumns = {
  import_master_segments: ['record_id', 'kind', 'data_class', 'payload'], import_history_segments: ['record_id', 'revision', 'data_class', 'payload'],
  data_import_payload_blocks: ['id', 'scope_id', 'owner_id', 'profile_hash', 'source_system', 'source_instance', 'source_table', 'entity', 'block_type', 'payload', 'key_id', 'nonce', 'created_at'],
  data_import_rows: ['run_id', 'row_number', 'identity_hash', 'content_hash', 'state', 'issue', 'payload'],
  data_import_changes: ['run_id', 'row_number', 'identity_hash', 'payload', 'reverted_at'],
  data_import_links: ['id', 'scope_id', 'entity', 'target_id', 'revision', 'last_run_id', 'payload'],
  sales_article_revisions: ['product_id', 'revision', 'article_number', 'description', 'active', 'source_snapshot_id', 'source_updated_at', 'created_by', 'created_at'],
  sales_article_price_snapshots: ['id', 'product_id', 'source_snapshot_id', 'price_type', 'amount', 'currency', 'price_basis', 'quality_status', 'source_field', 'created_by', 'created_at'],
};
function sqlClient(source = {}, schemaColumns = null) {
  const data = Object.fromEntries(P.PROJECTED_TABLES.map(s => [s.table, copy(source[s.table] || [])]));
  const columnMap = Object.fromEntries(P.PROJECTED_TABLES.map(s => [s.table, (schemaColumns?.[s.table] || baseColumns[s.table]).map(name => ({ name,
    type: name === 'amount' ? 'numeric(30,12)' : ['revision', 'row_number', 'active'].includes(name) ? 'bigint' : 'text', notNull: !['amount', 'source_updated_at', 'reverted_at', 'identity_hash'].includes(name), identity: '', generated: '' }))]));
  let saved;
  const client = { data, columnMap, inserts: 0, maxBatch: 0, triggers: 0, failAfter: Infinity,
    connectionParameters: { host: '/tmp/gp-pg-recovery-projectionfixture', port: 55484 },
    async query(sql, args = []) {
      if (sql.startsWith("SELECT current_setting('unix_socket_directories')")) return { rows: [{ socket: this.connectionParameters.host, port: '55484', listen: '' }] };
      if (sql.includes('FROM pg_trigger')) return { rows: [{ n: String(this.triggers) }] };
      if (sql.startsWith('SELECT a.attname')) return { rows: copy(columnMap[args[1]]) };
      if (sql.startsWith('SELECT t.*')) {
        const table = sql.match(/FROM "[a-z]+"\."([a-z_]+)" t/)[1], key = keys[table], limit = args.at(-1), after = args.length > 1 ? args.slice(0, -1) : null;
        const compare = (a, b) => { for (let i = 0; i < a.length; i++) { const numeric = /^\d+$/.test(String(a[i])) && /^\d+$/.test(String(b[i])); const x = numeric ? BigInt(a[i]) : a[i], y = numeric ? BigInt(b[i]) : b[i]; if (x < y) return -1; if (x > y) return 1; } return 0; };
        return { rows: data[table].filter(row => !after || compare(key.map(k => row[k]), after) > 0).sort((a, b) => compare(key.map(k => a[k]), key.map(k => b[k]))).slice(0, limit).map(copy) };
      }
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: String(data[sql.match(/\."([a-z_]+)"/)[1]].length) }] };
      if (sql === 'BEGIN') { saved = copy(data); return { rows: [] }; }
      if (sql === 'COMMIT') { saved = null; return { rows: [] }; }
      if (sql === 'ROLLBACK') { for (const name of Object.keys(data)) data[name] = saved[name]; saved = null; return { rows: [] }; }
      if (sql.startsWith('INSERT INTO')) {
        if (this.inserts++ >= this.failAfter) throw new Error('synthetic insert failure');
        const name = sql.match(/INSERT INTO "[a-z]+"\."([a-z_]+)"/)[1], rows = JSON.parse(args[0]);
        this.maxBatch = Math.max(this.maxBatch, rows.length);
        for (const row of rows) {
          assert.deepEqual(Object.keys(row).sort(), columnMap[name].map(c => c.name).sort());
          assert.ok(!data[name].some(old => keys[name].every(key => old[key] === row[key])), 'original PK must remain unique');
          if (name === 'sales_article_revisions') assert.ok(row.description.length >= 1 && row.description.length <= 300 && row.description.trim() === row.description);
          if (name === 'sales_article_price_snapshots') assert.ok(!data[name].some(old => ['source_snapshot_id', 'product_id', 'price_type', 'price_basis', 'source_field'].every(key => old[key] === row[key])), 'price natural key must remain unique');
          data[name].push(copy(row));
        }
        return { rows: [], rowCount: rows.length };
      }
      throw new Error('Unexpected synthetic SQL');
    } };
  return client;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gp-access-projection-test-')); await fs.chmod(directory, 0o700);
  const protection = createDataImportProtection({ encryptionKey: Buffer.alloc(32, 11), indexKey: Buffer.alloc(32, 19), keyId: 'projection-test' });
  t.after(async () => { protection.destroy(); await fs.rm(directory, { recursive: true, force: true }); });
  const byValue = new Map(), byReference = new Map(), sources = SOURCE_KINDS.map((kind, index) => ({ kind,
    sourceId: String(index + 1).repeat(64), fileSha256: String(index + 1).repeat(64), bytes: 4096, fileName: kind + '.accdb', capturedAt: 1, appliedAt: 2, revision: 1, requiresPassword: false, file: String(index + 1).repeat(64) + '.source' }));
  const proof = { version: 1, available: true, generation: 1, generationSha256: '', kinds: sources.map(source => ({ kind: source.kind, current: source, previous: null })), candidates: [],
    files: [...sources.map(source => ({ file: source.file, bytes: 4096, sha256: 'c'.repeat(64) })), { file: 'index.source-archive', bytes: 1, sha256: 'c'.repeat(64) }] };
  proof.generationSha256 = checksum(JSON.stringify({ generation: proof.generation, kinds: proof.kinds, candidates: proof.candidates, files: proof.files }));
  function known(kind, value, transform = 'data') {
    const source = sources.find(s => s.kind === kind), definition = definitions(kind)[0];
    const reference = { kind, sourceId: source.sourceId, fileSha256: source.fileSha256, bytes: 4096, table: definition.name, ordinal: 1, profileHash: definition.profile.fingerprint, transform, expectedSha256: digest(value) };
    byValue.set(digest(value), reference); byReference.set(digest(reference), copy(value)); return value;
  }
  const dictionary = { archiveGenerationSha256: proof.generationSha256, dictionarySha256: 'b'.repeat(64), reference: value => byValue.get(digest(value)) || null,
    materialize: async reference => copy(byReference.get(digest(reference))) };
  const rows = Object.fromEntries(P.PROJECTED_TABLES.map(s => [s.table, []]));
  for (const [index, kind] of SOURCE_KINDS.entries()) {
    const id = checksum('link-' + kind), imported = known(kind, { sourceSecret: 'synthetic-sensitive-' + kind, number: index });
    rows.data_import_links.push({ id, scope_id: 'scope', entity: 'entity', target_id: 'target-' + kind, revision: '3', last_run_id: checksum('run-' + kind),
      payload: protection.seal({ record: { key: [index], source: imported, data: imported }, contentHash: digest(imported), targetRevision: 7 }, ['link', id]),
      __run: { profile_hash: definitions(kind)[0].profile.fingerprint, manifest: JSON.stringify({ sourceInstance: 'tradefoto-' + kind }) } });
  }
  const profile = definitions('trade').find(d => d.name === 'ARTIKEL_STAMM').profile;
  const record = { id: 'master-identity', scope_id: 'scope', source_instance: 'tradefoto-trade', source_table: 'ARTIKEL_STAMM', identity_hash: 'f'.repeat(64), profile_hash: profile.fingerprint, revision: 4 };
  const master = known('trade', { sourceSegment: 'synthetic-source-segment' });
  rows.import_master_segments.push({ record_id: record.id, kind: 'attributes', data_class: 'internal_business', payload: protection.seal(master,
    ['master-segment', record.scope_id, record.source_instance, record.source_table, record.identity_hash, record.id, record.profile_hash, 4, 'attributes', 'internal_business']), __record: record });
  const historyProfile = definitions('bestell')[0].profile;
  const historyRecord = { id: 'history-id', scope_id: 'scope', source_instance: 'tradefoto-bestell', source: 'trade', source_table: definitions('bestell')[0].name,
    identity_hash: '9'.repeat(64), profile_hash: historyProfile.fingerprint, revision: 4 };
  const version = { revision: 3, file_sha256: sources[2].fileSha256, snapshot_at: TIME, imported_by: 'owner', imported_at: TIME, run_id: checksum('history-run'),
    master_source_instance: 'tradefoto-trade', business_date: '2010-01-02', parent_id: 'parent-id', parent_revision: 2 };
  const historyContext = ['history-version', historyRecord.scope_id, historyRecord.source_instance, historyRecord.source, historyRecord.source_table, historyRecord.id,
    historyRecord.identity_hash, historyRecord.profile_hash, version.revision, version.file_sha256, version.snapshot_at, version.imported_by, version.imported_at, version.run_id,
    version.master_source_instance, version.business_date, version.parent_id, version.parent_revision, 'segment', 'internal_business'];
  const history = known('bestell', { historySourceSecret: 'synthetic-source-history' });
  rows.import_history_segments.push({ record_id: historyRecord.id, revision: '3', data_class: 'internal_business', payload: protection.seal(history, historyContext), __record: historyRecord, __version: version });
  const run = { id: checksum('run'), scopeId: 'scope', ownerId: 'owner', profileHash: profile.fingerprint,
    manifest: { fileSha256: sources[0].fileSha256, snapshotAt: TIME, sourceInstance: 'tradefoto-trade' } };
  const rawRow = { rowNumber: 1, identityHash: 'e'.repeat(64), contentHash: 'd'.repeat(64) };
  const imported = known('trade', { sourceSecret: 'sensitive-large-source-' + 's'.repeat(1600) });
  const gp = { gpSecret: 'synthetic-own-before-value', locallyEdited: true };
  const value = { record: { key: ['1'], source: imported, data: imported }, validation: null, beforeLink: { id: 'before', payload: 'opaque-gp-link' }, beforeTarget: { id: 'target', revision: 2, data: gp }, patch: gp, action: 'update', issue: '' };
  const store = createDataImportPayloadStore({ protection });
  const blockTx = {
    async getPayloadBlock({ id }) { const row = rows.data_import_payload_blocks.find(b => b.id === id); return row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v])) : null; },
    async insertPayloadBlock({ id, scopeId, ownerId, profileHash, sourceSystem, sourceInstance, sourceTable, entity, blockType, payload, keyId, nonce, createdAt }) {
      rows.data_import_payload_blocks.push({ id, scope_id: scopeId, owner_id: ownerId, profile_hash: profileHash, source_system: sourceSystem, source_instance: sourceInstance, source_table: sourceTable, entity, block_type: blockType, payload, key_id: keyId, nonce, created_at: createdAt }); return { rowsAffected: 1 };
    },
  };
  const encoded = await store.encode(blockTx, { run, profile, row: rawRow, kind: 'row', value, at: TIME });
  for (const block of rows.data_import_payload_blocks) block.__source_required = encoded.refs.some(ref => ref.blockId === block.id && ['record.source', 'record.data'].includes(ref.slot));
  const savedRun = { id: run.id, scope_id: run.scopeId, profile_hash: profile.fingerprint, manifest: JSON.stringify(run.manifest) };
  rows.data_import_rows.push({ run_id: run.id, row_number: 1, identity_hash: rawRow.identityHash, content_hash: rawRow.contentHash, state: 'applied', issue: '', payload: encoded.payload, __run: savedRun });
  const legacy = { record: { key: ['legacy'], source: known('weum', { legacySourceSecret: 'synthetic-legacy-source' }), data: known('inventur', { legacyDataSecret: 'synthetic-legacy-data' }) },
    beforeTarget: { id: 'owned', revision: 1, data: gp }, beforeLink: { payload: 'keep-opaque-before-link' }, action: 'update', patch: gp, issue: '' };
  rows.data_import_rows.push({ run_id: run.id, row_number: 2, identity_hash: '8'.repeat(64), content_hash: '7'.repeat(64), state: 'applied', issue: '', payload: protection.seal(legacy, ['row', 'scope', run.id, 2]), __run: savedRun });
  const invalid = { invalidSource: known('cash', { invalidSourceSecret: 'synthetic-invalid-source' }), issue: 'IMPORT_INTEGER_INVALID' };
  rows.data_import_rows.push({ run_id: run.id, row_number: 3, identity_hash: null, content_hash: '6'.repeat(64), state: 'invalid', issue: invalid.issue, payload: protection.seal(invalid, ['row', 'scope', run.id, 3]), __run: savedRun });
  const change = { action: 'update', beforeTarget: { id: 'target', revision: 2, data: gp }, afterTarget: { id: 'target', revision: 3, data: imported }, beforeLink: { payload: 'opaque-gp-before-link' } };
  rows.data_import_changes.push({ run_id: run.id, row_number: 1, identity_hash: rawRow.identityHash, payload: protection.seal(change, ['change', run.scopeId, run.id, 1]), reverted_at: null, __run: { id: run.id, scope_id: run.scopeId } });
  const revisionValue = known('trade', { description: 'Synthetic imported source description', active: true, sourceUpdatedAt: null });
  for (const [index, system] of ['tradefoto.artikel_stamm', 'manual.article-catalog', 'tradefoto.article.import.undo', 'unknown.future'].entries()) {
    rows.sales_article_revisions.push({ product_id: 'product-' + index, revision: '2', article_number: 'A' + index, description: revisionValue.description,
      active: '1', source_snapshot_id: 'snapshot-' + index, source_updated_at: null, created_by: 'person', created_at: TIME, __snapshot: { source_system: system } });
    for (const field of ['Vkp1', 'Vkp2']) {
      const price = known('trade', { amount: '0.300000000001', currency: 'EUR', priceBasis: 'gross', qualityStatus: 'confirmed', sourceField: field });
      rows.sales_article_price_snapshots.push({ id: 'price-' + index + '-' + field, product_id: 'product-' + index, source_snapshot_id: 'snapshot-' + index,
        price_type: 'sales', amount: price.amount, currency: price.currency, price_basis: price.priceBasis, quality_status: price.qualityStatus, source_field: price.sourceField, created_by: 'person', created_at: TIME, __snapshot: { source_system: system } });
    }
  }
  return { directory, protection, dictionary, proof, archive: { verify: async () => proof }, rows, known, run, profile, value, encoded, blockTx, rawRow, store, gp, legacy, invalid, history, historyContext };
}
const stripped = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('__'))));
test('projection protects all six kinds and preserves GP edits, identities, prices and opaque undo evidence', async t => {
  const f = await fixture(t), source = sqlClient(f.rows);
  const plan = await P.exportProjection({ ...f, sales: source });
  assert.equal(P.validateProjectionPlan(plan), plan);
  for (const kind of SOURCE_KINDS) assert.ok(plan.stats.omittedByKind[kind] >= 2, kind);
  const stored = await fs.readFile(path.join(f.directory, plan.file), 'utf8');
  assert.ok(!stored.includes('synthetic-sensitive-') && !stored.includes('synthetic-own-before-value'));
  assert.ok(!JSON.stringify(plan).includes('sourceSecret') && !JSON.stringify(plan).includes('product-'));
  const target = sqlClient();
  const restored = await P.restoreProjection({ ...f, plan, sales: target, sourceDictionary: f.dictionary, rehydrate: true, isolatedRecovery: true });
  assert.equal(restored.rehydrated, true); assert.equal(restored.requiresImportRehydration, false);
  for (const name of Object.keys(target.data)) {
    assert.equal(target.data[name].length, f.rows[name].length);
    if (['sales_article_revisions', 'sales_article_price_snapshots'].includes(name)) {
      assert.deepEqual(target.data[name].sort((a, b) => C.canonical(a).localeCompare(C.canonical(b))), stripped(f.rows[name]).sort((a, b) => C.canonical(a).localeCompare(C.canonical(b))));
    }
  }
  const restoredRoot = target.data.data_import_rows[0];
  const decodeTx = { getRowPayloadRefs: async () => f.encoded.refs, getPayloadBlock: async ({ id }) => {
    const block = target.data.data_import_payload_blocks.find(row => row.id === id);
    return Object.fromEntries(Object.entries(block).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
  } };
  assert.deepEqual(await f.store.decode(decodeTx, { run: f.run, profile: f.profile, row: { ...f.rawRow, payload: restoredRoot.payload }, kind: 'row' }), f.value);
  assert.deepEqual(f.protection.open(target.data.data_import_rows.find(row => row.row_number === 2).payload, ['row', 'scope', f.run.id, 2]), f.legacy);
  assert.deepEqual(f.protection.open(target.data.data_import_rows.find(row => row.row_number === 3).payload, ['row', 'scope', f.run.id, 3]), f.invalid);
  assert.deepEqual(f.protection.open(target.data.import_history_segments[0].payload, f.historyContext), f.history);
  assert.equal(protectionValue(f, target.data.data_import_changes[0], ['change', 'scope', f.run.id, 1]).beforeLink.payload, 'opaque-gp-before-link');
  assert.equal(target.data.data_import_links[0].target_id, stripped(f.rows.data_import_links).sort((a, b) => a.id.localeCompare(b.id))[0].target_id);
  assert.ok(!(await fs.readdir(f.directory)).some(name => name.endsWith('.pending')));
});
function protectionValue(f, row, context) { return f.protection.open(row.payload, context); }
test('owned restore inserts SQL-valid placeholders without changing price unique keys or GP/manual/unknown values', async t => {
  const f = await fixture(t), plan = await P.exportProjection({ ...f, sales: sqlClient(f.rows) }), target = sqlClient();
  const result = await P.restoreProjection({ ...f, plan, sales: target, rehydrate: false, isolatedRecovery: true });
  assert.equal(result.requiresImportRehydration, true);
  assert.equal(target.data.sales_article_revisions.find(row => row.product_id === 'product-0').description, '[source pending]');
  for (const index of [1, 2, 3]) assert.deepEqual(target.data.sales_article_revisions.find(row => row.product_id === 'product-' + index), stripped(f.rows.sales_article_revisions).find(row => row.product_id === 'product-' + index));
  const prices = target.data.sales_article_price_snapshots.filter(row => row.product_id === 'product-0');
  assert.equal(prices.length, 2); assert.ok(prices.every(row => row.amount === null)); assert.deepEqual(prices.map(row => row.source_field).sort(), ['Vkp1', 'Vkp2']);
  const root = f.protection.open(target.data.data_import_rows[0].payload.slice('gp-import-evidence-parts-v1:'.length), ['row', 'scope', f.run.id, 1]);
  assert.deepEqual(root.value.beforeTarget.data, f.gp); assert.equal(root.value.beforeLink.payload, 'opaque-gp-link');
});
test('projection rejects corrupt files, structural drift, live endpoints and post-data triggers before writes', async t => {
  const f = await fixture(t), plan = await P.exportProjection({ ...f, sales: sqlClient(f.rows) });
  const invoke = (sales, extra = {}) => P.restoreProjection({ ...f, plan, sales, isolatedRecovery: true, ...extra });
  const remote = sqlClient(); remote.connectionParameters.host = '127.0.0.1';
  await assert.rejects(invoke(remote), /ISOLATION_REQUIRED/); assert.equal(remote.inserts, 0);
  const activeTriggers = sqlClient(); activeTriggers.triggers = 1;
  await assert.rejects(invoke(activeTriggers), /REQUIRES_PRE_DATA/); assert.equal(activeTriggers.inserts, 0);
  const drift = sqlClient(); drift.columnMap.import_master_segments[0].type = 'varchar';
  await assert.rejects(invoke(drift), /PROJECTION_SCHEMA/); assert.equal(drift.inserts, 0);
  const changed = copy(plan); changed.stats.omittedByKind.trade++;
  assert.throws(() => P.validateProjectionPlan(changed), /PROJECTION_STATS/);
  const bytes = await fs.readFile(path.join(f.directory, plan.file)); bytes[20] ^= 1; await fs.writeFile(path.join(f.directory, plan.file), bytes);
  const corrupt = sqlClient(); await assert.rejects(invoke(corrupt), /FILE_HASH/); assert.equal(corrupt.inserts, 0);
});
test('source mismatch and insert failure roll back and drain private materialization files', async t => {
  const f = await fixture(t), plan = await P.exportProjection({ ...f, sales: sqlClient(f.rows) });
  const changedSource = { ...f.dictionary, materialize: async () => ({ wrong: 'source bytes changed' }) }, target = sqlClient();
  await assert.rejects(P.restoreProjection({ ...f, plan, sales: target, rehydrate: true, sourceDictionary: changedSource, isolatedRecovery: true }), /MATERIALIZED/);
  assert.equal(target.inserts, 0);
  const failing = sqlClient(); failing.failAfter = 2;
  await assert.rejects(P.restoreProjection({ ...f, plan, sales: failing, rehydrate: true, sourceDictionary: f.dictionary, isolatedRecovery: true }), /synthetic insert failure/);
  assert.ok(Object.values(failing.data).every(rows => rows.length === 0));
  assert.ok(!(await fs.readdir(f.directory)).some(name => name.endsWith('.pending')));
});
test('projection traverses source rows with bounded keyset batches and retains unmatched values exactly', async t => {
  const f = await fixture(t);
  f.rows.data_import_links = Array.from({ length: 251 }, (_, index) => {
    const id = String(index).padStart(64, '0'), value = { record: { key: [index], source: { ownUnmatched: index }, data: { ownUnmatched: index } }, targetRevision: 1 };
    return { id, scope_id: 'scope', entity: 'own', target_id: 'target-' + index, revision: '1', last_run_id: checksum('own-run'), payload: f.protection.seal(value, ['link', id]) };
  });
  const plan = await P.exportProjection({ ...f, sales: sqlClient(f.rows) }), target = sqlClient();
  await P.restoreProjection({ ...f, plan, sales: target, rehydrate: false, isolatedRecovery: true });
  assert.equal(target.data.data_import_links.length, 251); assert.ok(target.maxBatch <= 100);
  assert.deepEqual(target.data.data_import_links, f.rows.data_import_links);
});
test('earlier Sales stages permit an exact empty projection without invented tables or rowcounts', async t => {
  const f = await fixture(t), absent = Object.fromEntries(P.PROJECTED_TABLES.map(table => [table.table, []]));
  const plan = await P.exportProjection({ ...f, sales: sqlClient({}, absent) });
  assert.deepEqual(plan.tables, []); assert.equal(plan.rows, 0); assert.equal(plan.bytes, 0); assert.equal(plan.sha256, checksum(''));
  const result = await P.restoreProjection({ ...f, plan, sales: sqlClient({}, absent), rehydrate: true, isolatedRecovery: true });
  assert.equal(result.verified, true); assert.equal(result.rehydrated, true); assert.equal(result.rows, 0);
});
test('large retained envelopes use authenticated chunks and survive unchanged', async t => {
  const f = await fixture(t), id = checksum('large-gp-owned-envelope'), own = { ownLargeValue: 'p'.repeat(1_200_000) };
  for (const name of Object.keys(f.rows)) f.rows[name] = [];
  const payload = f.protection.seal({ record: { source: own, data: { ownFlag: true } }, targetRevision: 1 }, ['link', id]);
  f.rows.data_import_links.push({ id, scope_id: 'scope', entity: 'owned', target_id: 'owned-target', revision: '1', last_run_id: checksum('run-large'), payload });
  const plan = await P.exportProjection({ ...f, sales: sqlClient(f.rows) }), target = sqlClient();
  assert.ok(plan.bytes > 1_500_000);
  await P.restoreProjection({ ...f, plan, sales: target, rehydrate: false, isolatedRecovery: true });
  assert.equal(target.data.data_import_links[0].payload, payload);
});
test('missing source-only coverage refuses reduced export instead of retaining a silent cash-only/partial scope', async t => {
  for (const missing of ['master', 'history', 'article', 'price', 'legacy-source', 'invalid-source', 'source-block', ...SOURCE_KINDS.map(kind => 'link-' + kind)]) await t.test(missing, async t => {
    const f = await fixture(t), ordinary = f.dictionary.reference;
    const match = value => missing === 'master' ? Object.hasOwn(value, 'sourceSegment')
      : missing === 'history' ? Object.hasOwn(value, 'historySourceSecret')
        : missing === 'article' ? Object.hasOwn(value, 'description')
          : missing === 'price' ? Object.hasOwn(value, 'amount')
            : missing === 'legacy-source' ? Object.hasOwn(value, 'legacySourceSecret')
              : missing === 'invalid-source' ? Object.hasOwn(value, 'invalidSourceSecret')
              : missing === 'source-block' ? typeof value.sourceSecret === 'string' && value.sourceSecret.startsWith('sensitive-large-source-')
                : value.sourceSecret === 'synthetic-sensitive-' + missing.slice('link-'.length);
    f.dictionary.reference = value => match(value) ? null : ordinary(value);
    await assert.rejects(P.exportProjection({ ...f, sales: sqlClient(f.rows) }), error => error.code === 'PG_DEPLOY_ACCESS_SOURCE_COVERAGE');
    await assert.rejects(fs.access(path.join(f.directory, P.FILE)), { code: 'ENOENT' });
  });
});
test('replay can use a separate owned scratch directory and removes encrypted materialization files', async t => {
  const f = await fixture(t), scratch = path.join(f.directory, 'scratch'); await fs.mkdir(scratch, { mode: 0o700 });
  const plan = await P.exportProjection({ ...f, sales: sqlClient(f.rows) });
  await P.restoreProjection({ ...f, plan, sales: sqlClient(), sourceDictionary: f.dictionary, rehydrate: true, isolatedRecovery: true, materializationDirectory: scratch });
  assert.deepEqual(await fs.readdir(scratch), []);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [P.FILE, 'scratch'].sort());
});
test('fast owned projection verifies the frozen index without requesting external source objects', async t => {
  const f = await fixture(t), plan = await P.exportProjection({ ...f, sales: sqlClient(f.rows) });
  let verified = 0;
  const archive = { async verify(options) { assert.deepEqual(options, { allowMissing: false, referenceOnly: true }); verified++; return f.proof; },
    async useSource() { assert.fail('fast projection must not open Access source objects'); } };
  const result = await P.restoreProjection({ ...f, archive, plan, sales: sqlClient(), isolatedRecovery: true });
  assert.equal(verified, 1); assert.equal(result.rehydrated, false); assert.equal(result.requiresImportRehydration, true);
});
function searchFixture() {
  const S = require('../lib/persistence/statements/sales-article-catalog').SALES_ARTICLE_CATALOG_STATEMENTS;
  const sources = new Map(Array.from({ length: 251 }, (_, index) => {
    const productId = 'product-' + String(index).padStart(4, '0');
    return [productId, { productId, articleNumber: 'Ä' + index, currentRevision: index + 1, description: 'Öffentliche Kamera ' + index,
      active: index % 2 === 0, sourceSnapshotId: 'snapshot-' + index, sourceSystem: index % 2 ? 'manual.article-catalog' : 'tradefoto.artikel_stamm',
      primaryIdentifier: null, retailGross: '0.300000000001', internetGross: null, retailNet: null, internetNet: null, purchaseNet: null, purchaseGross: null }];
  }));
  const cache = new Map(), dirty = new Set([...sources.keys(), 'stale-orphan']), statements = [];
  const sales = { connectionParameters: { host: '/tmp/gp-pg-recovery-searchfixture', port: 55484 }, maxBatch: 0,
    async query(sql, parameters = []) {
      if (sql.startsWith("SELECT current_setting('unix_socket_directories')")) return { rows: [{ socket: this.connectionParameters.host, port: '55484', listen: '' }] };
      if (sql === 'SELECT count(*)::text AS n FROM trade.sales_article_search_projection') return { rows: [{ n: String(cache.size) }] };
      if (sql.startsWith('SELECT product_id')) {
        const values = [...(sql.includes('sales_article_search_dirty') ? dirty : sources.keys())].sort().filter(id => id > parameters[0]).slice(0, parameters[1]);
        this.maxBatch = Math.max(this.maxBatch, values.length); return { rows: values.map(product_id => ({ product_id })) };
      }
      if (sql.startsWith('SELECT (SELECT count(*)')) return { rows: [{ articles: String(sources.size), projected: String(cache.size), dirty: String(dirty.size),
        missing: String([...sources.values()].filter(row => cache.get(row.productId)?.currentRevision !== row.currentRevision).length) }] };
      throw new Error('Unexpected cache qualification SQL');
    } };
  const access = { transactions: 0, failAt: Infinity, closed: false,
    async close() { this.closed = true; },
    async transaction(work) {
      this.transactions++; const previous = copy([...cache]), previousDirty = [...dirty];
      try { return await work({ queryOne: async (statement, { productId }) => { assert.equal(statement, S.searchProjectionSource); statements.push(statement); return sources.get(productId); },
        execute: async (statement, parameters) => {
          statements.push(statement);
          if (statement === S.upsertSearchProjection) { if (cache.size >= this.failAt) throw new Error('synthetic cache failure'); cache.set(parameters.productId, copy(parameters)); return { rowsAffected: 1 }; }
          assert.equal(statement, S.clearSearchProjectionDirty); return { rowsAffected: dirty.delete(parameters.productId) ? 1 : 0 };
        } });
      } catch (error) { cache.clear(); for (const [key, value] of previous) cache.set(key, value); dirty.clear(); for (const value of previousDirty) dirty.add(value); throw error; }
    } };
  return { sales, access, sources, cache, dirty, statements, S };
}
test('isolated search reconstruction uses authoritative repository rows and the production projection transform', async () => {
  const f = searchFixture(), transform = require('../lib/sales-article-search-projection').articleSearchProjection;
  const result = await P.rebuildSearchProjection({ sales: f.sales, access: f.access, isolatedRecovery: true });
  assert.deepEqual(result, { verified: true, rows: 251, dirtyCleared: 252, source: 'authoritative-current-article-revisions', transform: 'articleSearchProjection' });
  assert.ok(f.sales.maxBatch <= 100); assert.equal(f.access.transactions, 1); assert.equal(f.access.closed, false);
  assert.equal(f.dirty.size, 0);
  for (const [id, source] of f.sources) assert.deepEqual(f.cache.get(id), transform(source));
  assert.ok(f.statements.every(statement => [f.S.searchProjectionSource, f.S.upsertSearchProjection, f.S.clearSearchProjectionDirty].includes(statement)));
});
test('search reconstruction refuses live/nonempty targets and rolls back failed cache writes', async () => {
  const live = searchFixture(); live.sales.connectionParameters.host = '127.0.0.1';
  await assert.rejects(P.rebuildSearchProjection({ sales: live.sales, access: live.access, isolatedRecovery: true }), /ISOLATION_REQUIRED/); assert.equal(live.access.transactions, 0);
  const nonempty = searchFixture(); nonempty.cache.set('existing', {});
  await assert.rejects(P.rebuildSearchProjection({ sales: nonempty.sales, access: nonempty.access, isolatedRecovery: true }), /SEARCH_NOT_EMPTY/); assert.equal(nonempty.access.transactions, 0);
  const failure = searchFixture(); failure.access.failAt = 2;
  await assert.rejects(P.rebuildSearchProjection({ sales: failure.sales, access: failure.access, isolatedRecovery: true }), /synthetic cache failure/);
  assert.equal(failure.cache.size, 0); assert.equal(failure.dirty.size, 252);
});
