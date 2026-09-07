// Full-source GP runtime and coupled archive/restore qualification. All writes
// are confined to one new local fixture; no source, live GP or real vault access.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { createDataImportRuntime } = require('../lib/persistence/repositories/data-import-runtime');
const { createCashSnapshotStore } = require('../lib/persistence/repositories/cash-snapshots');
const { CASH_SNAPSHOT_TABLES: TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { streamTradeFotoFullSource } = require('../lib/tradefoto-full-import-reader');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { DATA_IMPORT_PERMISSIONS: P } = require('../lib/data-import-access');
const { createAmuStorage, syncEncryptedFilesBackup } = require('../lib/amu-storage');
const { writeBackupCommitMarker, verifyCommittedBackup } = require('../lib/backup-commit');
const { verifyStandaloneBackupPair } = require('../backup');
const { verifyBackupRecoveryKeys } = require('../lib/backup-recovery-keys');
const { createLocalBackupArchive } = require('../lib/local-backup-archive');
const { sha256File } = require('../lib/file-integrity');
const root = path.resolve(import.meta.dirname, '..'), started = Date.now();
const BINARY_SHA = '034b7bf67a23049d30d58ddf4fb318239726cc74728b80bff876de824f2fc786';
const implementation = ['scripts/verify-compact-cash-full.mjs', 'lib/persistence/repositories/cash-snapshots.js',
  'lib/persistence/repositories/data-import-runtime.js', 'lib/persistence/sqlite/cash-snapshots-catalog.js',
  'lib/persistence/sqlite/operations/cash-snapshots-schema.js', 'lib/persistence/statements/cash-snapshots.js',
  'lib/data-import-managed-protection.js', 'lib/data-import-protection.js', 'lib/local-backup-archive.js', 'lib/backup-recovery-keys.js'];
function treeBytes(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((n, entry) => {
    const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false); return n + (stat.isDirectory() ? treeBytes(file) : stat.size);
  }, 0);
}
async function main() {
  assert.equal(process.argv.length, 4, 'Usage: verify-compact-cash-full.mjs CASH.accdb NEW-REPORT.json');
  const sourcePath = fs.realpathSync(process.argv[2]), output = path.resolve(process.argv[3]);
  assert.equal(fs.existsSync(output), false, 'REPORT_EXISTS');
  const before = fs.statSync(sourcePath), sourceSha = sha256File(sourcePath);
  const baselineFile = path.join(root, 'docs/tradefoto-gesamtimport-v0.1/24-MONATE-QUELLENMESSUNG-2026-09-07.json');
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).sources.find(s => s.kind === 'cash');
  assert.equal(sourceSha, baseline.sha256); assert.equal(before.size, baseline.bytes);
  const binary = fs.realpathSync(path.join(root, 'tmp/backup-restic-tools-20260906/bin/restic_0.18.1_windows_amd64.exe'));
  assert.equal(sha256File(binary), BINARY_SHA);
  const tmp = fs.realpathSync(path.join(root, 'tmp')), free = () => { const s = fs.statfsSync(tmp); return s.bavail * s.bsize; };
  assert.ok(free() > 16 * 1024 ** 3, 'FREE_SPACE_REQUIRED');
  const directory = fs.mkdtempSync(path.join(tmp, 'cash-full-managed-')); assert.equal(path.dirname(fs.realpathSync(directory)), tmp);
  const backupDirectory = path.join(directory, 'backups'); fs.mkdirSync(backupDirectory);
  const snapshot = 'dienstplan-cash-full', file = path.join(backupDirectory, snapshot + '.db');
  const vaultKey = crypto.randomBytes(32), documentKey = crypto.randomBytes(32);
  let environment = { GRABENPLANER_INTEGRATION_KEY_ID: 'measurement', GRABENPLANER_INTEGRATION_KEY: vaultKey.toString('base64'),
    GRABENPLANER_AMU_KEY_ID: 'measurement', GRABENPLANER_AMU_KEY: documentKey.toString('base64') };
  const newVault = () => createIntegrationSecretVault({ activeKeyId: 'measurement', keys: { measurement: vaultKey } });
  const vault = newVault(); let app, protection, restored, lastProgress = 0, phase = 'building';
  const report = { format: 'grabenplaner.cash.full-managed-prototype.v1', measuredAt: new Date().toISOString(), scope: 'full',
    source: { bytes: before.size, sha256: sourceSha, fileName: path.basename(sourcePath), rows: baseline.rows },
    productionWrites: false, sourceWrites: false, tradeReadOrChanged: false, runtimeIntegration: 'normal-managed-upload-and-review',
    businessActivation: false, allSourceFields: TABLES.reduce((n, t) => n + t.columns.length, 0),
    minimumFreeBytes: free(), sampledPeakWorkspaceBytes: 0, sampledPeakMainRssBytes: 0,
    footprintScope: 'isolated directory including database, WAL, paired backups, local archive and restores; sampled, excludes native temp files outside this directory and worker RSS',
    evidence: { baselineCountReportSha256: sha256File(baselineFile), implementation: implementation.map(file => ({ file, sha256: sha256File(path.join(root, file)) })) },
    limitations: ['Isolated local prototype; no VPS deployment or live import.', 'Business mapping, sales rules, location/class views and dataset activation are not enabled.',
      'Local Restic archive is measured; no claim about Drive quota, existing backup retention, or total VPS capacity with Trade.'] };
  function progress(extra = {}, force = false) {
    assert.ok(Date.now() - started < 30 * 60 * 1000, 'MEASUREMENT_TIME_LIMIT');
    assert.ok(free() > 10 * 1024 ** 3, 'MEASUREMENT_DISK_RESERVE');
    report.minimumFreeBytes = Math.min(report.minimumFreeBytes, free());
    report.sampledPeakWorkspaceBytes = Math.max(report.sampledPeakWorkspaceBytes, treeBytes(directory));
    assert.ok(report.sampledPeakWorkspaceBytes < 6 * 1024 ** 3, 'MEASUREMENT_DISK_LIMIT');
    report.sampledPeakMainRssBytes = Math.max(report.sampledPeakMainRssBytes, process.memoryUsage().rss);
    if (force || Date.now() - lastProgress > 20000) {
      const status = { phase, elapsedMs: Date.now() - started, ...extra };
      fs.writeFileSync(path.join(directory, 'progress.json'), JSON.stringify(status));
      console.log(JSON.stringify(status)); lastProgress = Date.now();
    }
  }
  const close = async () => { if (app) { await app.provider.close(); app.database.close(); app = null; } };
  try {
    app = openSqliteApplicationPersistence({ databasePath: file, catalog: SQLITE_APPLICATION_CATALOG });
    ensureSqliteDataImportRuntimeSchema(app.database);
    app.database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=524288;');
    const session = { employeeNumber: 'isolated-cash-importer', accountId: 'isolated-personal-account', isEmployee: true,
      permissions: [...Object.values(P), 'sales:analytics:access', 'sales:analytics:company:read'] };
    const getSession = async () => session;
    const options = { access: app.provider, vault, compactCash: true, allowApply: false,
      readSource: args => streamTradeFotoFullSource({ ...args, onMessage: async message => {
        await args.onMessage(message); progress({ table: message.name, sourceRow: message.startRow });
      } }) };
    let runtime = createDataImportRuntime(options), source;
    const bytes = fs.readFileSync(sourcePath); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sourceSha);
    source = await runtime.upload(getSession, { buffer: bytes, kind: 'cash' });
    assert.ok(bytes.every(byte => byte === 0)); report.uploadMs = Date.now() - started;
    phase = 'verifying-every-value'; progress({}, true); const reviewStarted = Date.now();
    do { source = await runtime.sourceOperation(getSession, source.id, 'review', { expectedRevision: source.revision }); progress({ verifiedRows: source.verifiedRows }); }
    while (source.status === 'reviewing');
    assert.equal(source.status, 'ready'); assert.equal(source.verifiedRows, baseline.rows); assert.equal(source.activationEnabled, false);
    report.reviewMs = Date.now() - reviewStarted; report.tables = source.tables.map(t => ({ name: t.name, rows: t.run.receivedRows, verifiedRows: t.run.verifiedRows }));
    assert.deepEqual(report.tables.map(t => [t.name, t.rows]).sort(), baseline.tables.map(t => [t.name, t.rows]).sort());
    for (const name of ['data_import_rows', 'data_import_links', 'data_import_changes', 'import_history_records', 'import_history_versions']) assert.equal(app.database.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n, 0);
    report.genericCashCopies = 0;
    phase = 'compacting'; progress({}, true); const compactStarted = Date.now();
    app.database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    assert.equal(app.database.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(app.database.prepare('PRAGMA integrity_check').all().every(r => Object.values(r)[0] === 'ok'));
    report.compactMs = Date.now() - compactStarted; report.databaseBytes = fs.statSync(file).size;
    report.footprint = app.database.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all();
    report.sourceSizeRatio = report.databaseBytes / before.size;
    protection = await loadManagedDataImportProtection({ access: app.provider, vault });
    const keyProof = protection.digest(['full-cash-recovery-proof', sourceSha]); protection.destroy(); protection = null;
    await close(); progress({ databaseBytes: report.databaseBytes }, true);
    const documents = path.join(directory, 'documents');
    const storage = createAmuStorage({ rootDirectory: documents, encryptionKeys: { measurement: documentKey }, activeKeyId: 'measurement',
      scanner: async () => ({ available: true, clean: true, engine: 'isolated-measurement' }) });
    await storage.saveBuffer({ buffer: Buffer.from('%PDF-1.7\nsynthetic compact cash recovery fixture'), originalName: 'fixture.pdf' });
    const verifyPair = (paths, marker) => { verifyStandaloneBackupPair(paths, marker, { environment });
      return verifyBackupRecoveryKeys({ databasePath: paths.databasePath, protectedDirectory: paths.protectedDirectory, environment }); };
    function publish(name) {
      const database = path.join(backupDirectory, name + '.db'), sha256 = sha256File(database);
      syncEncryptedFilesBackup({ sourceDirectory: documents, targetDirectory: path.join(backupDirectory, name + '.amu'),
        manifestMetadata: { database: { fileName: name + '.db', sha256 } } });
      writeBackupCommitMarker({ backupDirectory, snapshot: name, databaseSha256: sha256 });
      verifyCommittedBackup(backupDirectory, name + '.complete.json', { verifyPair });
    }
    publish(snapshot); phase = 'archive-and-coupled-restore'; progress({}, true); const archiveStarted = Date.now();
    let archive = createLocalBackupArchive({ backupDirectory, binary, binarySha256: BINARY_SHA, vault, expectedStream: 'app' });
    archive.initialize({ host: 'gp-compact-cash-measurement', stream: 'app', confirmation: 'initialize-local-archive' });
    const receipt = archive.archivePair(snapshot, { verifyPair }); assert.equal(receipt.archived, true);
    report.archiveAndAutomaticRestoreMs = Date.now() - archiveStarted;
    report.archiveBytes = treeBytes(path.join(backupDirectory, '.gp-local-archive'));
    progress({ archiveBytes: report.archiveBytes }, true);
    // New vault/provider objects model restarting from the paired backup. All
    // business values are authenticated again, not just the archive/file hash.
    phase = 'restore-all-values'; const restoreStarted = Date.now();
    archive = createLocalBackupArchive({ backupDirectory, binary, binarySha256: BINARY_SHA, vault: newVault(), expectedStream: 'app' });
    restored = archive.materialize(snapshot, { verifyPair }); progress({}, true);
    assert.equal(sha256File(restored.databasePath), sha256File(file));
    app = openSqliteApplicationPersistence({ databasePath: restored.databasePath, catalog: SQLITE_APPLICATION_CATALOG });
    protection = await loadManagedDataImportProtection({ access: app.provider, vault: newVault(), create: false });
    assert.equal(protection.digest(['full-cash-recovery-proof', sourceSha]), keyProof);
    const store = createCashSnapshotStore({ access: app.provider, protection, actor: { scopeId: 'grabenplaner-main', ownerId: session.employeeNumber } });
    await store.reverify(source.id); let verified;
    do { verified = await store.review(source.id); progress({ verifiedRows: verified.verifiedRows }); } while (verified.status === 'reviewing');
    assert.equal(verified.status, 'ready'); assert.equal(verified.verifiedRows, baseline.rows);
    report.restore = { everyValueVerified: true, rows: verified.verifiedRows, fileSha256Equal: true, managedKeyReopened: true, pairedDocumentsVerified: true,
      durationMs: Date.now() - restoreStarted };
    protection.destroy(); protection = null; await close(); restored.cleanup(); restored = null;
    phase = 'unchanged-backup-deduplication'; progress({}, true); const repeatStarted = Date.now(), repeat = snapshot + '-repeat';
    fs.copyFileSync(file, path.join(backupDirectory, repeat + '.db')); publish(repeat);
    archive.archivePair(repeat, { verifyPair });
    report.unchangedBackup = { addedArchiveBytes: treeBytes(path.join(backupDirectory, '.gp-local-archive')) - report.archiveBytes,
      durationMs: Date.now() - repeatStarted, automaticCoupledRestorePassed: true };
    progress(report.unchangedBackup, true);
    assert.equal(archive.listMetadata().length, 2);
    // Detect implementation changes during the evidence run; rerun if needed.
    for (const item of report.evidence.implementation) assert.equal(sha256File(path.join(root, item.file)), item.sha256, 'IMPLEMENTATION_CHANGED_DURING_RUN');
  } finally {
    protection?.destroy(); await close(); restored?.cleanup();
    vaultKey.fill(0); documentKey.fill(0); environment = {};
    assert.equal(path.dirname(fs.realpathSync(directory)), tmp); treeBytes(directory);
    fs.rmSync(directory, { recursive: true });
    const after = fs.statSync(sourcePath);
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
    assert.equal(sha256File(sourcePath), sourceSha);
  }
  report.status = 'passed_full_cash_managed_prototype'; report.durationMs = Date.now() - started;
  report.sourceUnchanged = true; report.isolatedDataAndArchiveRemoved = true; report.testKeysPersisted = false;
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, databaseBytes: report.databaseBytes, archiveBytes: report.archiveBytes, durationMs: report.durationMs }));
}
main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: error.code || 'CASH_FULL_QUALIFICATION_FAILED', name: error.name, diagnostic: error.message?.startsWith('IMPORT_') ? error.message : undefined })); process.exitCode = 1; });
