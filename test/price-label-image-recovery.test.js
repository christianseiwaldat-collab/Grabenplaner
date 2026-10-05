'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite'), { EventEmitter } = require('node:events');
const { createRequire } = require('node:module'), { spawnSync } = require('node:child_process'), vm = require('node:vm');
const { createAmuStorage, syncEncryptedFilesBackup } = require('../lib/amu-storage');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { createDataImportProtection } = require('../lib/data-import-protection');
const recovery = require('../server-tools/linux/recovery/lib/recovery-verify');
const runtime = require('../lib/persistence/postgresql/operations/runtime');
const root = path.resolve(__dirname, '..');
const amuModule = path.join(root, 'lib/amu-storage.js'), integrationModule = path.join(root, 'lib/integration-secret-vault.js');
const stageHelper = path.join(root, 'server-tools/linux/offsite/lib/offsite-stage.js');
const backupVerifier = path.join(root, 'server-tools/linux/lib/verify-backup.js');
const policy = require('../server-tools/linux/recovery/lib/recovery-metadata').__internalTestOnly.nonRootOwnershipPolicy;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=', 'base64');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
function permissions(directory, frozen) {
 if (!fs.existsSync(directory)) return;
 fs.chmodSync(directory, 0o700);
 for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  const file = path.join(directory, entry.name);
  if (entry.isDirectory()) permissions(file, frozen); else fs.chmodSync(file, frozen ? 0o400 : 0o600);
 }
 if (frozen) fs.chmodSync(directory, 0o500);
}
async function fixture(t, { corrupt = '' } = {}) {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-image-recovery-'));
 fs.chmodSync(directory, 0o700); t.after(() => { permissions(directory, false); fs.rmSync(directory, { recursive: true, force: true }); });
 const environment = { GRABENPLANER_AMU_KEY_ID: 'synthetic', GRABENPLANER_AMU_KEY: Buffer.alloc(32, 7).toString('base64'),
  GRABENPLANER_INTEGRATION_KEY_ID: 'synthetic', GRABENPLANER_INTEGRATION_KEY: Buffer.alloc(32, 8).toString('base64') };
 const sourceDirectory = path.join(directory, 'source', 'private', 'amu');
 const storage = createAmuStorage({ rootDirectory: sourceDirectory, encryptionKeys: { synthetic: environment.GRABENPLANER_AMU_KEY }, activeKeyId: 'synthetic' });
 const metadata = await storage.saveBuffer({ buffer: image, originalName: 'synthetic.png' });
 const vault = createIntegrationSecretVault({ activeKeyId: 'synthetic', keys: { synthetic: environment.GRABENPLANER_INTEGRATION_KEY } });
 const bytes = Buffer.alloc(64, 9), keyPayload = vault.seal(bytes, { namespace: 'data-import', connectorId: 'data-import-v1', field: 'data-and-index-keys', purpose: 'source-archive-and-recovery' });
 const protection = createDataImportProtection({ encryptionKey: bytes.subarray(0, 32), indexKey: bytes.subarray(32), keyId: 'data-import-v1', compression: true });
 const assetId = crypto.randomUUID();
 const rows = [
  { scopeId: 'synthetic:price-label-images', kind: 'price-label-image', value: { schemaVersion: 1, assetId, ownerId: 'employee:synthetic', width: 1, height: 1,
   bytes: image.length, sha256: corrupt === 'content' ? '0'.repeat(64) : crypto.createHash('sha256').update(image).digest('hex'), storageKey: metadata.storageKey } },
  { scopeId: metadata.storageKey, kind: 'price-label-image-storage-v1', value: { schemaVersion: 1, assetId, storageKey: metadata.storageKey } },
 ].map(({ scopeId, kind, value }) => {
  const id = protection.digest(['trade-annotation-id', scopeId, kind, assetId]), revision = 1;
  return { id, scopeId, kind, revision, payload: protection.seal(value, ['trade-annotation-v1', scopeId, kind, id, revision]) };
 });
 protection.destroy(); bytes.fill(0);
 if (corrupt === 'marker') rows.pop();
 if (corrupt === 'missing') fs.unlinkSync(path.join(sourceDirectory, 'blobs', metadata.storageKey));
 const environmentFile = path.join(directory, 'configuration.env');
 fs.writeFileSync(environmentFile, Object.entries(environment).map(([name, value]) => name + '=' + value).join('\n') + '\n', { mode: 0o600 });
 return { directory, sourceDirectory, environment, environmentFile, keyPayload, rows, storageKey: metadata.storageKey };
}
function buildFrozenSqliteStage(f) {
 const stage = path.join(f.directory, 'stage'), backup = path.join(stage, 'backup'), contract = path.join(stage, 'recovery');
 fs.mkdirSync(backup, { recursive: true }); fs.mkdirSync(contract);
 const database = path.join(backup, 'snapshot.db'), documents = path.join(backup, 'snapshot.amu'), marker = path.join(backup, 'snapshot.complete.json');
 const db = new DatabaseSync(database);
 try {
  db.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,app_version TEXT NOT NULL); INSERT INTO schema_migrations VALUES('base','0.73.0-beta'); CREATE TABLE trade_annotations(id TEXT PRIMARY KEY,scope_id TEXT,kind TEXT,revision INTEGER,payload TEXT); CREATE TABLE data_import_runtime_keys(id TEXT PRIMARY KEY,payload TEXT);");
  for (const row of f.rows) db.prepare('INSERT INTO trade_annotations VALUES(?,?,?,?,?)').run(row.id, row.scopeId, row.kind, row.revision, row.payload);
  db.prepare('INSERT INTO data_import_runtime_keys VALUES(?,?)').run('data-import-v1', f.keyPayload);
 } finally { db.close(); }
 const databaseSha256 = digest(database), createdAt = new Date().toISOString();
 const copied = syncEncryptedFilesBackup({ sourceDirectory: f.sourceDirectory, targetDirectory: documents, manifestMetadata: { database: { fileName: 'snapshot.db', sha256: databaseSha256 } } });
 const manifest = path.join(documents, 'manifest.json');
 json(marker, { format: 'grabenplaner-backup-commit', schemaVersion: 1, snapshot: 'snapshot', committedAt: createdAt,
  database: { fileName: 'snapshot.db', sha256: databaseSha256, bytes: fs.statSync(database).size },
  protectedDocuments: { directoryName: 'snapshot.amu', files: copied.fileCount, manifestFileName: 'manifest.json', manifestSha256: digest(manifest), manifestBytes: fs.statSync(manifest).size },
  verification: { status: 'verified', verifiedAt: createdAt } });
 const targetPackage = path.join(contract, 'package.json'), targetRuntime = path.join(contract, 'runtime-schema.json'), example = path.join(contract, 'grabenplaner.env.example');
 json(targetPackage, { version: '0.73.0-beta' }); json(targetRuntime, { format: 'grabenplaner-linux-runtime-contract', schemaVersion: 1, deploymentSchemaVersion: 1 }); fs.writeFileSync(example, 'NODE_ENV=production\n');
 const receipt = path.join(f.directory, 'backup-result.json');
 json(receipt, { ok: true, path: database, amuBackup: documents, commitMarker: marker, sha256: databaseSha256, createdAt });
 const result = spawnSync(process.execPath, [stageHelper, 'create', stage, receipt, example, targetPackage, targetRuntime], { encoding: 'utf8' });
 assert.equal(result.status, 0, result.stderr);
 permissions(stage, true);
 return { stage, database, documents, stageHelper, backupVerifier, amuModule, integrationModule, environment: f.environmentFile,
  targetPackage, targetRuntime, scratchRoot: f.directory, output: path.join(f.directory, 'verification.json') };
}
function fileHashes(directory) {
 return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).filter(name => fs.statSync(path.join(directory, name)).isFile()).sort()
  .map(name => [name, digest(path.join(directory, name))]));
}
test('complete frozen SQLite recovery authenticates image references and leaves all backup files unchanged', async t => {
 const f = await fixture(t), options = buildFrozenSqliteStage(f), before = fileHashes(options.stage);
 const result = await recovery.verifyRecovery(options, policy);
 assert.equal(result.ok, true); assert.equal(result.protectedPriceLabelImages, 1);
 assert.equal(JSON.parse(fs.readFileSync(options.output)).protectedPriceLabelImages, 1);
 assert.deepEqual(fileHashes(options.stage), before);
 assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.recovery-key-check-')), false);
});
test('SQLite recovery rejects self-consistent manifests whose database images are missing, changed or incompletely referenced', async t => {
 for (const corrupt of ['missing', 'content', 'marker']) await t.test(corrupt, async child => {
  const f = await fixture(child, { corrupt }), options = buildFrozenSqliteStage(f), before = fileHashes(options.stage);
  await assert.rejects(recovery.verifyRecovery(options, policy));
  assert.equal(fs.existsSync(options.output), false, 'no successful recovery receipt on reference failure');
  assert.deepEqual(fileHashes(options.stage), before);
 });
});
test('older SQLite and PostgreSQL snapshots without image metadata need neither an image key nor file storage', async () => {
 const db = new DatabaseSync(':memory:');
 try { assert.equal(await recovery.verifyPriceLabelImageFiles(db, {}), 0); } finally { db.close(); }
 let queries = 0;
 assert.equal(await runtime.verifyPriceLabelImageFiles({ query: async sql => { queries++; assert.match(sql, /to_regclass/); return { rows: [{ present: false }] }; } }), 0);
 assert.equal(queries, 1, 'historical snapshots do not query a table that did not exist yet');
 assert.equal(await runtime.verifyPriceLabelImageFiles({ query: async sql => ({ rows: sql.includes('to_regclass') ? [{ present: true }] : [] }) }), 0);
 await assert.rejects(runtime.verifyPriceLabelImageFiles({ query: async () => ({ rows: [] }) }), /PG_PAIR_IMAGE_SCHEMA/);
});
test('PostgreSQL recovery reader uses the supplied read-only snapshot, checks keys and propagates the backup deadline', async t => {
 const f = await fixture(t), queries = [], client = { query: async sql => { queries.push(sql);
  if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
  if (sql.includes('FROM gp.trade_annotations')) return { rows: f.rows };
  if (sql.includes('FROM gp.data_import_runtime_keys')) return { rows: [{ payload: f.keyPayload }] };
  assert.fail('unexpected query'); } };
 const options = { sourceDirectory: f.sourceDirectory, environment: f.environment };
 assert.equal(await runtime.verifyPriceLabelImageFiles(client, options), 1);
 assert.equal(queries.length, 3); assert.ok(queries.every(sql => sql.startsWith('SELECT ')));
 queries.length = 0;
 assert.equal(await runtime.verifyPriceLabelImageFiles(client, { ...options, keyPayload: f.keyPayload }), 1);
 assert.equal(queries.length, 2, 'restore reuses the already authenticated key row');
 await assert.rejects(runtime.verifyPriceLabelImageFiles(client, { ...options, keyPayload: null }), { code: 'PRICE_LABEL_IMAGE_INTEGRITY' });
 let checks = 0;
 await assert.rejects(runtime.verifyPriceLabelImageFiles(client, { ...options, checkBudget() {
  if (++checks === 3) throw Object.assign(new Error('synthetic deadline'), { code: 'PG_BACKUP_OPERATION_TIMEOUT' });
 } }), { code: 'PG_BACKUP_OPERATION_TIMEOUT' });
 assert.equal(checks, 3, 'the copy/reference check remains inside the overall operation budget');
});
function backupRuntime(f) {
 const sourceFile = path.join(root, 'lib/persistence/postgresql/operations/runtime.js'), actualRequire = createRequire(sourceFile);
 const clients = [], events = [];
 class Pool {
  constructor(options) { this.database = options.database; }
  async connect() {
   const c = new EventEmitter(); c.database = this.database; c.queries = []; c.release = () => {};
   c.query = async sql => {
    c.queries.push(sql); events.push(c.database + ':' + sql);
    if (sql.includes('ISOLATION LEVEL REPEATABLE READ')) c.retainedRows = f.rows.map(row => ({ ...row }));
    if (sql.includes('pg_stat_activity')) return { rows: [{ n: 0 }] };
    if (sql.includes('current_database() AS name')) return { rows: [{ name: c.database }] };
    if (sql.includes('FROM pg_tables')) return { rows: [{ schemaname: 'gp', tablename: 'trade_annotations' }] };
    if (sql.includes('pg_database_size')) return { rows: [{ bytes: '1024' }] };
    if (sql.includes('pg_export_snapshot')) return { rows: [{ id: '123-AB' }] };
    if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
    if (sql.includes('FROM gp.trade_annotations')) {
     assert.ok(c.retainedRows, 'image reads must use the dump snapshot, never a new pool connection');
     assert.ok(!c.queries.includes('COMMIT') && !c.queries.includes('ROLLBACK'), 'snapshot must still be retained');
     return { rows: c.retainedRows };
    }
    if (sql.includes('FROM gp.data_import_runtime_keys')) return { rows: [{ payload: f.keyPayload }] };
    return { rows: [] };
   };
   clients.push(c); return c;
  }
  async end() { events.push(this.database + ':pool-end'); }
 }
 const module = { exports: {} };
 const nativeTool = async (_config, name, args, output) => {
  events.push('native:' + name); fs.writeFileSync(output.outputFile, 'synthetic-tool-output', { flag: 'wx', mode: 0o600 });
  if (name === 'pg_restore' && args.database === 'sales') f.rows = [], events.push('live-rows-changed');
 };
 const sandbox = { require: name => name === 'pg' ? { Pool } : name === './paired-checkpoint' ? { captureCheckpoint: async () => ({ synthetic: true }) } : actualRequire(name),
  module, exports: module.exports, performance, syntheticNativeTool: nativeTool };
 vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8') + '\ninspectPair=async()=>({core:{},sales:{}});nativeTool=syntheticNativeTool;', sandbox, { filename: sourceFile });
 const backupDirectory = path.join(f.directory, 'pairs'), workDirectory = path.join(f.directory, 'work');
 fs.mkdirSync(backupDirectory, { mode: 0o700 }); fs.mkdirSync(workDirectory, { mode: 0o700 });
 const config = { mode: 'qualification', sourceFiles: path.join(f.directory, 'source'), environmentFile: f.environmentFile,
  backupDirectory, workDirectory, host: 'synthetic', port: 1, administrator: { role: 'synthetic', password: 'synthetic' },
  domains: ['core', 'sales'].map(domain => ({ domain, database: domain, role: 'gp_' + domain + '_migrator', password: 'synthetic' })) };
 return { run: () => module.exports.createBackup(config), clients, events, backupDirectory };
}
test('PostgreSQL backup checks copied images against the retained dump snapshot before committing and sealing', async t => {
 const f = await fixture(t), native = backupRuntime(f), result = await native.run();
 assert.equal(result.ok, true); assert.equal(result.protectedPriceLabelImages, 1); assert.ok(fs.existsSync(result.commitMarker));
 assert.equal(f.rows.length, 0, 'later live changes do not replace the retained dump rows');
 const index = native.events.findIndex(item => item.includes('FROM gp.trade_annotations'));
 assert.ok(index > native.events.indexOf('live-rows-changed'));
 assert.ok(index < native.events.indexOf('native:pg_dumpall'));
 for (const c of native.clients.filter(c => c.retainedRows)) assert.ok(c.queries.includes('COMMIT'));
});
test('PostgreSQL backup rejects missing or changed snapshot images, rolls back both databases and publishes no complete marker', async t => {
 for (const corrupt of ['missing', 'content', 'marker']) await t.test(corrupt, async child => {
  const f = await fixture(child, { corrupt }), native = backupRuntime(f);
  await assert.rejects(native.run());
  const retained = native.clients.filter(c => c.retainedRows); assert.equal(retained.length, 2);
  for (const c of retained) { assert.ok(c.queries.includes('ROLLBACK')); assert.ok(!c.queries.includes('COMMIT')); }
  assert.equal(native.events.includes('native:pg_dumpall'), false, 'failure stops the remaining backup work');
  assert.equal(fs.readdirSync(native.backupDirectory).some(name => name.endsWith('.complete.json')), false);
 });
});
