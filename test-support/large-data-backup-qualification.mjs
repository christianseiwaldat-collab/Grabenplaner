// Isolated qualification: synthetic data only, explicit pinned local Restic.
// Never reads a productive DB, environment file, or existing backup repository.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sha256File } = require('../lib/file-integrity');
const { writeBackupCommitMarker, verifyCommittedBackup } = require('../lib/backup-commit');
const { verifyStandaloneBackupPair } = require('../backup');
const { createAmuStorage, syncEncryptedFilesBackup, validateEncryptionKeyForStorage } = require('../lib/amu-storage');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { ensureSqliteDataImportRuntimeSchema } = require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
const { planArchiveRetention } = require('../lib/local-backup-policy');
const [binaryArg, binaryHash] = process.argv.slice(2);
assert.ok(binaryArg && /^[a-f0-9]{64}$/.test(binaryHash || ''), 'PINNED_RESTIC_ARGUMENTS_REQUIRED');
const binary = fs.realpathSync(binaryArg);
assert.equal(sha256File(binary), binaryHash, 'RESTIC_BINARY_HASH_MISMATCH');
const tmp = path.resolve(import.meta.dirname, '../tmp');
const free = () => { const s = fs.statfsSync(tmp); return s.bavail * s.bsize; };
assert.ok(free() > 10 * 1024 ** 3 + 4 * 1024 ** 3, 'DISK_RESERVE_REQUIRED');
const root = fs.mkdtempSync(path.join(tmp, 'large-backup-qualification-'));
const work = path.join(root, 'isolated'), stage = path.join(work, 'stage'), repository = path.join(work, 'repository');
fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
const password = crypto.randomBytes(32), vaultKey = crypto.randomBytes(32), amuKey = crypto.randomBytes(32);
const report = { format: 'grabenplaner.large-backup-qualification.v1', startedAt: new Date().toISOString(),
  syntheticOnly: true, productionWrites: false, productionQualified: false, status: 'running',
  binarySha256: binaryHash, snapshots: [], retentionChanged: false, existingBackupsDeleted: false };
const started = Date.now();
const persist = () => fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const progress = (phase, extra = {}) => { report.phase = phase; report.durationMs = Date.now() - started; persist();
  console.log(JSON.stringify({ phase, elapsedMs: report.durationMs, ...extra })); };
const dirBytes = folder => fs.readdirSync(folder, { withFileTypes: true }).reduce((n, e) =>
  n + (e.isDirectory() ? dirBytes(path.join(folder, e.name)) : fs.statSync(path.join(folder, e.name)).size), 0);
async function run(args, cwd = stage) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--repo', repository, '--no-cache', '--retry-lock', '0s', '--compression', 'auto', ...args], {
      cwd, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR, TMP: work, TEMP: work, TMPDIR: work,
        RESTIC_PASSWORD: password.toString('base64'), GOMAXPROCS: '2', GOMEMLIMIT: '384MiB' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', tooLarge = false;
    const collect = (value, which) => {
      if (which === 'out') stdout += value; else stderr += value;
      if (stdout.length + stderr.length > 16 * 1024 ** 2) { tooLarge = true; child.kill(); }
    };
    child.stdout.on('data', d => collect(d, 'out')); child.stderr.on('data', d => collect(d, 'err'));
    const timer = setTimeout(() => child.kill(), 1500000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer);
      if (code !== 0 || tooLarge) return reject(new Error(`RESTIC_${args[0].toUpperCase()}_FAILED_${code}`));
      resolve(stdout); });
  });
}
function findFile(directory, name) {
  for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
    if (e.isFile() && e.name === name) return path.join(directory, name);
    if (e.isDirectory()) { const found = findFile(path.join(directory, e.name), name); if (found) return found; }
  }
  return null;
}
let app;
try {
  // Above the old readFileSync 2 GiB ceiling; a separate child proves bounded
  // process memory. Zeros here test file size, not realistic deduplication.
  const large = path.join(work, 'synthetic-large.bin'), length = 2 * 1024 ** 3 + 17;
  const fd = fs.openSync(large, 'wx'); fs.ftruncateSync(fd, length); fs.closeSync(fd);
  progress('large-file-hash');
  const hashResult = await new Promise((resolve, reject) => {
    const code = `const {sha256File}=require(process.argv[1]); console.log(JSON.stringify({hash:sha256File(process.argv[2]),rss:process.resourceUsage().maxRSS*1024}));`;
    const child = spawn(process.execPath, ['--max-old-space-size=64', '-e', code, path.resolve(import.meta.dirname, '../lib/file-integrity.js'), large], { windowsHide: true });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.resume();
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('LARGE_HASH_FAILED')));
  });
  assert.ok(hashResult.rss < 160 * 1024 ** 2, 'HASH_MEMORY_LIMIT_EXCEEDED');
  assert.equal(hashResult.hash, 'd9378e43c0e666027848e63668ba0a821b4726843e366626946e3823b477299e', 'LARGE_HASH_CONTENT_MISMATCH');
  report.largeFileHash = { bytes: length, peakRssBytes: hashResult.rss, bufferBytes: 1024 ** 2, passed: true };
  fs.unlinkSync(large);
  const vault = key => createIntegrationSecretVault({ activeKeyId: 'synthetic', resolveKey: id => id === 'synthetic' ? key : null });
  app = openSqliteApplicationPersistence({ databasePath: path.join(work, 'source.db'), catalog: SQLITE_APPLICATION_CATALOG });
  ensureSqliteDataImportRuntimeSchema(app.database);
  app.database.exec('CREATE TABLE synthetic(id INTEGER PRIMARY KEY, payload BLOB); CREATE TABLE probe(id INTEGER PRIMARY KEY, payload TEXT);');
  const protection = await loadManagedDataImportProtection({ access: app.provider, vault: vault(vaultKey), create: true });
  app.database.prepare('INSERT INTO probe VALUES(1,?)').run(protection.seal({ test: 'synthetic-recovery' }, ['backup-probe']));
  protection.destroy();
  app.database.exec('BEGIN');
  for (let i = 0; i < 64; i++) app.database.prepare('INSERT INTO synthetic VALUES(?,?)').run(i, crypto.randomBytes(1024 ** 2));
  app.database.exec('COMMIT');
  const protectedRoot = path.join(work, 'documents');
  const storage = createAmuStorage({ rootDirectory: protectedRoot, encryptionKeys: { synthetic: amuKey }, activeKeyId: 'synthetic',
    scanner: async () => ({ available: true, clean: true, engine: 'synthetic' }) });
  await storage.saveBuffer({ buffer: Buffer.from('%PDF-1.7\nsynthetic protected document'), originalName: 'test.pdf' });
  // Only synthetic keys; the real recovery envelope/configuration is untouched.
  fs.writeFileSync(path.join(stage, 'synthetic-recovery.json'), JSON.stringify({ vault: vaultKey.toString('base64'), amu: amuKey.toString('base64') }), { mode: 0o600, flag: 'wx' });
  await run(['init', '--repository-version', '2']);
  const pair = 'dienstplan-synthetic-qualification', databaseFile = path.join(stage, pair + '.db');
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(databaseFile)) fs.unlinkSync(databaseFile); // Own disposable fixture, never a retained backup.
    app.database.prepare('UPDATE synthetic SET payload=? WHERE id=?').run(crypto.randomBytes(1024 ** 2), i % 64);
    app.database.exec(`VACUUM INTO '${databaseFile.replaceAll("'", "''")}'`);
    const hash = sha256File(databaseFile);
    syncEncryptedFilesBackup({ sourceDirectory: protectedRoot, targetDirectory: path.join(stage, pair + '.amu'),
      manifestMetadata: { database: { fileName: pair + '.db', sha256: hash } } });
    writeBackupCommitMarker({ backupDirectory: stage, snapshot: pair, databaseSha256: hash });
    verifyCommittedBackup(stage, pair + '.complete.json', { verifyPair: verifyStandaloneBackupPair });
    const output = await run(['backup', '--json', '--force', '--read-concurrency', '1', '--host', 'gp-synthetic',
      '--tag', 'grabenplaner-local', '--tag', 'stream-app', '--time', `2026-08-${String(i % 28 + 1).padStart(2, '0')} 12:${String(i).padStart(2, '0')}:00`, '--', '.']);
    const summary = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(x => x.message_type === 'summary');
    assert.match(summary?.snapshot_id || '', /^[a-f0-9]{64}$/);
    report.snapshots.push({ id: summary.snapshot_id, databaseSha256: hash, bytes: fs.statSync(databaseFile).size });
    progress('deduplicated-snapshots', { completed: i + 1, total: 32 });
  }
  await app.provider.close(); app.database.close(); app = null;
  // Destroy the original keys before restoration. Each point must carry the
  // matching synthetic recovery set; wrong/missing keys must remain an error.
  vaultKey.fill(0); amuKey.fill(0); fs.unlinkSync(path.join(stage, 'synthetic-recovery.json'));
  await run(['check', '--read-data']);
  const inventory = JSON.parse(await run(['snapshots', '--json']));
  const latest = [...inventory].sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
  const retention = planArchiveRetention({ snapshots: inventory, host: 'gp-synthetic', stream: 'app', latestId: latest.id, now: latest.time });
  report.retention = { retained: retention.retained, removablePreviewOnly: retention.removable, removed: 0 };
  for (const point of report.snapshots) {
    const restored = fs.mkdtempSync(path.join(work, 'restore-'));
    await run(['restore', point.id, '--target', restored, '--verify']);
    const restoredDb = findFile(restored, pair + '.db'); assert.ok(restoredDb, 'RESTORED_DATABASE_MISSING');
    assert.equal(sha256File(restoredDb), point.databaseSha256);
    const restoredStage = path.dirname(restoredDb);
    verifyCommittedBackup(restoredStage, pair + '.complete.json', { verifyPair: verifyStandaloneBackupPair });
    const recovery = JSON.parse(fs.readFileSync(path.join(restoredStage, 'synthetic-recovery.json'), 'utf8'));
    const recoveredVaultKey = Buffer.from(recovery.vault, 'base64'), recoveredAmuKey = Buffer.from(recovery.amu, 'base64');
    validateEncryptionKeyForStorage({ sourceDirectory: path.join(restoredStage, pair + '.amu'), encryptionKeys: { synthetic: recoveredAmuKey }, activeKeyId: 'synthetic' });
    const db = openSqliteApplicationPersistence({ databasePath: restoredDb, catalog: SQLITE_APPLICATION_CATALOG });
    try {
      const recovered = await loadManagedDataImportProtection({ access: db.provider, vault: vault(recoveredVaultKey), create: false });
      assert.deepEqual(recovered.open(db.database.prepare('SELECT payload FROM probe WHERE id=1').get().payload, ['backup-probe']), { test: 'synthetic-recovery' });
      recovered.destroy();
      await assert.rejects(loadManagedDataImportProtection({ access: db.provider, vault: vault(Buffer.alloc(32, 1)), create: true }), e => e.code === 'IMPORT_VAULT_UNAVAILABLE');
      point.restored = true; point.managedImportKeyRecovered = true; point.wrongKeyRejected = true;
    } finally { await db.provider.close(); db.database.close(); recoveredVaultKey.fill(0); recoveredAmuKey.fill(0); }
    assert.equal(path.dirname(fs.realpathSync(restored)), work);
    fs.rmSync(restored, { recursive: true, force: true });
    progress('independent-restores', { completed: report.snapshots.filter(x => x.restored).length, total: 32 });
  }
  assert.equal(JSON.parse(await run(['snapshots', '--json'])).length, 32);
  report.archiveBytes = dirBytes(repository);
  report.equivalentFullCopyBytes = report.snapshots.reduce((n, x) => n + x.bytes, 0);
  // Prove the repository check is not merely a successful-command placeholder.
  const dataRoot = path.join(repository, 'data');
  const packDirectory = fs.readdirSync(dataRoot).find(name => fs.readdirSync(path.join(dataRoot, name)).length);
  assert.ok(packDirectory, 'SYNTHETIC_PACK_REQUIRED');
  const packName = fs.readdirSync(path.join(dataRoot, packDirectory))[0];
  assert.match(packName, /^[a-f0-9]{64}$/);
  const pack = path.join(dataRoot, packDirectory, packName);
  assert.ok(fs.realpathSync(pack).startsWith(fs.realpathSync(repository) + path.sep));
  const packFd = fs.openSync(pack, 'r+'), byte = Buffer.alloc(1);
  try { fs.readSync(packFd, byte, 0, 1, 0); byte[0] ^= 1; fs.writeSync(packFd, byte, 0, 1, 0); }
  finally { fs.closeSync(packFd); }
  await assert.rejects(run(['check', '--read-data']), /RESTIC_CHECK_FAILED/);
  report.corruptArchiveRejected = true;
  report.model = '64 MiB random base, 1 MiB changed per point, 32 points; not a full-source forecast';
  report.status = 'passed_synthetic_qualification';
} catch (error) {
  report.status = 'failed'; report.error = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'QUALIFICATION_ASSERTION_FAILED';
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (app) { await app.provider.close(); app.database.close(); }
  password.fill(0); vaultKey.fill(0); amuKey.fill(0);
  assert.equal(path.dirname(fs.realpathSync(work)), root);
  assert.equal(path.dirname(fs.realpathSync(root)), tmp);
  fs.rmSync(work, { recursive: true, force: true }); // All files are generated synthetic fixtures.
  report.syntheticFilesRemoved = true; progress('finished', { status: report.status, reportPath: path.join(root, 'report.json') });
}
