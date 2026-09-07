"use strict";
// Isolated, aggregate-only measurement. The imported data and keys never leave
// the newly created test directory/process; the two original ACCDBs are untouched.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sha256File } = require('../lib/file-integrity');
const { writeBackupCommitMarker, verifyCommittedBackup } = require('../lib/backup-commit');
const { verifyStandaloneBackupPair } = require('../backup');
const { createAmuStorage, syncEncryptedFilesBackup, validateEncryptionKeyForStorage } = require('../lib/amu-storage');
const { openSqliteApplicationPersistence } = require('../lib/persistence/sqlite/provider');
const { SQLITE_APPLICATION_CATALOG } = require('../lib/persistence/sqlite/application-catalog');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { verifySqliteDatabaseFile } = require('../lib/persistence/sqlite/operations/maintenance');
const RESERVE = 10 * 1024 ** 3;
const bytesIn = folder => fs.readdirSync(folder, { withFileTypes: true }).reduce((n, entry) => n + (entry.isDirectory()
  ? bytesIn(path.join(folder, entry.name)) : fs.statSync(path.join(folder, entry.name)).size), 0);

async function measureTradeFotoFullBackup({ directory, binary, binarySha256, vault, expectedKeyProof, report, budget = null, onProgress = () => {}, verifyRestored }) {
  const measurementStarted = Date.now();
  const parent = fs.realpathSync(directory), tmp = path.resolve(__dirname, '../tmp');
  assert.equal(path.dirname(parent), tmp); assert.match(path.basename(parent), /^tradefoto-block3-/);
  binary = fs.realpathSync(binary); assert.equal(sha256File(binary), binarySha256, 'RESTIC_BINARY_HASH_MISMATCH');
  const root = fs.mkdtempSync(path.join(parent, 'backup-measurement-'));
  const stage = path.join(root, 'stage'), repo = path.join(root, 'repository'), docs = path.join(root, 'documents');
  fs.mkdirSync(stage, { mode: 0o700 });
  const password = crypto.randomBytes(32), documentKey = crypto.randomBytes(32);
  const free = () => { const s = fs.statfsSync(parent); return s.bavail * s.bsize; };
  const reserve = extra => assert.ok(free() >= RESERVE + extra, 'BACKUP_MEASUREMENT_DISK_RESERVE');
  function sampleFootprint() {
    let total = 0, databaseFamilyBytes = 0, archiveBytes = 0;
    const walk = folder => {
      let entries;
      try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const file = path.join(folder, entry.name); let stat;
        try { stat = fs.lstatSync(file); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        assert.equal(stat.isSymbolicLink(), false, 'MEASUREMENT_TREE_LINK');
        if (stat.isDirectory()) walk(file);
        else {
          // Concurrent Restic publication may briefly expose two hardlinked
          // names. Count both conservatively; never follow a symbolic link.
          assert.ok(stat.isFile(), 'MEASUREMENT_TREE_SPECIAL_FILE');
          total += stat.size;
          if (file.startsWith(repo + path.sep)) archiveBytes += stat.size;
          if (/\.db(?:[.-]|$)/.test(entry.name)) databaseFamilyBytes += stat.size;
        }
      }
    };
    walk(parent);
    report.peakDirectoryBytes = Math.max(report.peakDirectoryBytes || 0, total);
    report.peakDatabaseFamilyBytes = Math.max(report.peakDatabaseFamilyBytes || 0, databaseFamilyBytes);
    report.minimumFreeBytes = Math.min(report.minimumFreeBytes ?? Number.MAX_SAFE_INTEGER, free());
    report.freeBytes = free();
    if (budget) {
      assert.ok(total <= budget.peakWorkspaceBudgetBytes, 'MEASUREMENT_WORKSPACE_BUDGET_EXCEEDED');
      assert.ok(archiveBytes <= budget.archiveBudgetBytes, 'MEASUREMENT_ARCHIVE_BUDGET_EXCEEDED');
    }
  }
  const progress = phase => { report.phase = phase; sampleFootprint(); onProgress(); };
  Object.assign(report, { status: 'running', source: 'complete-import', productionQualified: false,
    productionKeysUsed: false, vaultKeyPersisted: false, points: [], sourceMutation: false,
    measurementImplementation: 'vacuum-into-v2', compactions: [],
    footprintScope: 'entire-isolated-import-directory-including-staging-archive-and-restores', sampledPeakOnly: true });
  let connection;
  async function close() { if (connection) { await connection.provider.close(); connection.database.close(); connection = null; } }
  function open(file) { connection = openSqliteApplicationPersistence({ databasePath: file, catalog: SQLITE_APPLICATION_CATALOG }); return connection.database; }
  async function compact(file, kind) {
    const compactionStarted = Date.now();
    const db = open(file);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const scalar = sql => Number(Object.values(db.prepare(sql).get())[0]);
    const used = (scalar('PRAGMA page_count') - scalar('PRAGMA freelist_count')) * scalar('PRAGMA page_size');
    const sourceBytes = fs.statSync(file).size;
    if (budget) assert.ok(sourceBytes <= budget.databaseBudgetBytes, 'MEASUREMENT_DATABASE_BUDGET_EXCEEDED');
    const required = Math.max(sourceBytes, used) + 64 * 1024 ** 2;
    reserve(required);
    // Unlike plain VACUUM, INTO does not overwrite the source and does not
    // simultaneously create a second full-sized rollback/WAL copy. The only
    // replacement is this newly created, independently checked fixture file.
    const suffix = crypto.randomUUID(), candidate = `${file}.vacuum-${suffix}.db`, previous = `${file}.before-vacuum-${suffix}`;
    assert.equal(fs.existsSync(candidate), false); assert.equal(fs.existsSync(previous), false);
    let swapped = false;
    try {
      db.exec(`VACUUM INTO '${candidate.replaceAll('\\', '/').replaceAll("'", "''")}'`);
      sampleFootprint(); await close();
      assert.equal(verifySqliteDatabaseFile(candidate).ok, true, 'VACUUM_CANDIDATE_VERIFICATION_FAILED');
      for (const target of [file, candidate]) {
        assert.equal(fs.realpathSync(target), target);
        const st = fs.lstatSync(target); assert.ok(st.isFile() && st.nlink === 1, 'VACUUM_TARGET_INVALID');
      }
      assert.ok(!fs.existsSync(file + '-wal') || fs.statSync(file + '-wal').size === 0, 'VACUUM_SOURCE_WAL_NOT_CLOSED');
      const candidateBytes = fs.statSync(candidate).size;
      fs.renameSync(file, previous);
      try { fs.renameSync(candidate, file); swapped = true; }
      catch (error) { fs.renameSync(previous, file); throw error; }
      sampleFootprint();
      assert.equal(fs.realpathSync(previous), previous); fs.unlinkSync(previous);
      report.compactions.push({ kind, method: 'VACUUM INTO', sourceBytes, usedPageBytes: used,
        candidateBytes, extraSpaceReservedBytes: required, independentlyVerified: true, sourceClosedBeforeReplacement: true,
        durationMs: Date.now() - compactionStarted });
      sampleFootprint();
    } finally {
      await close();
      if (!swapped && fs.existsSync(candidate)) {
        assert.equal(fs.realpathSync(candidate), candidate); fs.unlinkSync(candidate);
      }
    }
  }
  async function restic(args, cwd = stage) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ['--repo', repo, '--no-cache', '--retry-lock', '0s', '--compression', 'auto', ...args], {
        cwd, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
          TEMP: root, TMP: root, TMPDIR: root, RESTIC_PASSWORD: password.toString('base64'), GOMAXPROCS: '2', GOMEMLIMIT: '384MiB' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errorOutput = '', failure;
      const timer = setTimeout(() => { failure = 'TIMEOUT'; child.kill(); }, 1500000);
      const spaceTimer = setInterval(() => {
        try { sampleFootprint(); if (free() < RESERVE) { failure = 'DISK_RESERVE'; child.kill(); } }
        catch { failure = 'FOOTPRINT_CHECK'; child.kill(); }
      }, 1000);
      const take = (part, error) => { if (error) errorOutput += part; else output += part;
        if (output.length + errorOutput.length > 16 * 1024 ** 2) { failure = 'OUTPUT_LIMIT'; child.kill(); } };
      child.stdout.on('data', d => take(d, false)); child.stderr.on('data', d => take(d, true));
      child.on('error', () => { clearTimeout(timer); clearInterval(spaceTimer); reject(new Error('RESTIC_START_FAILED')); });
      child.on('close', code => { clearTimeout(timer); clearInterval(spaceTimer);
        if (code !== 0 || failure) reject(new Error(`RESTIC_${args[0].toUpperCase()}_${failure || 'FAILED'}`)); else resolve(output); });
    });
  }
  const snapshot = 'dienstplan-full-source-measurement', database = path.join(stage, snapshot + '.db');
  async function capture(kind) {
    const captureStarted = Date.now();
    progress('capture-' + kind); reserve(0);
    if (budget) assert.ok(fs.statSync(database).size <= budget.databaseBudgetBytes, 'MEASUREMENT_DATABASE_BUDGET_EXCEEDED');
    const hash = sha256File(database);
    syncEncryptedFilesBackup({ sourceDirectory: docs, targetDirectory: path.join(stage, snapshot + '.amu'),
      manifestMetadata: { database: { fileName: snapshot + '.db', sha256: hash } } });
    writeBackupCommitMarker({ backupDirectory: stage, snapshot, databaseSha256: hash });
    verifyCommittedBackup(stage, snapshot + '.complete.json', { verifyPair: verifyStandaloneBackupPair });
    if (budget) assert.ok(bytesIn(stage) <= budget.coupledBudgetBytes, 'MEASUREMENT_COUPLED_BUDGET_EXCEEDED');
    reserve(bytesIn(stage) + 64 * 1024 ** 2);
    const beforeBytes = fs.existsSync(repo) ? bytesIn(repo) : 0;
    const output = await restic(['backup', '--json', '--force', '--read-concurrency', '1', '--host', 'gp-full-source-measurement',
      '--tag', 'grabenplaner-local', '--tag', 'stream-app', '--', '.']);
    const summary = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(x => x.message_type === 'summary');
    assert.match(summary?.snapshot_id || '', /^[a-f0-9]{64}$/);
    const point = { kind, id: summary.snapshot_id, databaseSha256: hash, databaseBytes: fs.statSync(database).size,
      coupledBytes: bytesIn(stage), archiveBytes: bytesIn(repo), addedArchiveBytes: bytesIn(repo) - beforeBytes,
      captureDurationMs: Date.now() - captureStarted };
    report.points.push(point); progress('captured-' + kind); return point;
  }
  try {
    progress('compaction');
    const original = path.join(parent, 'isolated-encrypted.db');
    report.beforeCompactionBytes = fs.statSync(original).size;
    await compact(original, 'full-source'); report.compactedDatabaseBytes = fs.statSync(original).size;
    open(original);
    report.compactedFootprint = connection.database.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all();
    await close();
    // Move only the exact freshly generated test DB, after its provider closed.
    assert.equal(fs.realpathSync(original), original); assert.ok(fs.lstatSync(original).isFile());
    fs.renameSync(original, database);
    const storage = createAmuStorage({ rootDirectory: docs, encryptionKeys: { measurement: documentKey }, activeKeyId: 'measurement',
      scanner: async () => ({ available: true, clean: true, engine: 'isolated-measurement' }) });
    await storage.saveBuffer({ buffer: Buffer.from('%PDF-1.7\nsynthetic attachment for full-source backup'), originalName: 'measurement.pdf' });
    await restic(['init', '--repository-version', '2']);
    const baseline = await capture('full-source');
    report.baselineArchiveBytes = baseline.archiveBytes; report.coupledSnapshotBytes = baseline.coupledBytes;
    await capture('unchanged-repeat');
    // A clearly labelled capacity stress sample, not a claimed new business day.
    // The imported source tables are not edited; 2,000 KiB of random new/changed
    // records exercises compaction on the real full-sized DB layout.
    if (free() >= RESERVE + baseline.databaseBytes + 128 * 1024 ** 2) {
      progress('change-stress-sample'); const changed = open(database);
      changed.exec('CREATE TABLE backup_capacity_probe(id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
      changed.exec('BEGIN');
      for (let i = 0; i < 2000; i++) changed.prepare('INSERT INTO backup_capacity_probe VALUES(?,?)').run(i, crypto.randomBytes(1024));
      changed.exec('COMMIT'); await close(); await compact(database, '2000-row-stress-sample');
      const point = await capture('2000-row-stress-sample');
      report.changeSample = { measured: true, rows: 2000, randomBytesPerRow: 1024, addedArchiveBytes: point.addedArchiveBytes,
        actualBusinessChangeWindow: false, sourceRowsChanged: false };
    } else report.changeSample = { measured: false, reason: 'local-compaction-reserve', actualBusinessChangeWindow: false };
    progress('archive-integrity'); const integrityStarted = Date.now(); await restic(['check', '--read-data']);
    report.archiveIntegrityDurationMs = Date.now() - integrityStarted;
    // Only the disposable full-import fixture is removed to make room for one
    // independent restore at a time. Original sources and user backups stay put.
    assert.equal(fs.realpathSync(database), database); fs.unlinkSync(database); sampleFootprint();
    for (const point of report.points.filter(p => p.kind !== 'unchanged-repeat')) {
      const restoreStarted = Date.now();
      progress('restore-' + point.kind); reserve(point.coupledBytes + 64 * 1024 ** 2);
      const restored = fs.mkdtempSync(path.join(root, 'restore-'));
      try {
        await restic(['restore', point.id, '--target', restored, '--verify']);
        sampleFootprint();
        const restoredDb = path.join(restored, snapshot + '.db');
        assert.equal(sha256File(restoredDb), point.databaseSha256, 'FULL_RESTORE_HASH_MISMATCH');
        verifyCommittedBackup(restored, snapshot + '.complete.json', { verifyPair: verifyStandaloneBackupPair });
        validateEncryptionKeyForStorage({ sourceDirectory: path.join(restored, snapshot + '.amu'),
          encryptionKeys: { measurement: documentKey }, activeKeyId: 'measurement' });
        open(restoredDb);
        const protection = await loadManagedDataImportProtection({ access: connection.provider, vault, create: false });
        assert.ok(protection, 'MANAGED_IMPORT_KEY_MISSING');
        try { assert.equal(protection.digest(['full-backup-qualification']), expectedKeyProof, 'MANAGED_IMPORT_KEY_MISMATCH'); }
        finally { protection.destroy(); }
        if (verifyRestored) await verifyRestored({ access: connection.provider, point });
        point.restored = true; point.managedImportKeyRecovered = true; point.documentsVerified = true;
        point.restoreDurationMs = Date.now() - restoreStarted;
      } finally {
        await close(); assert.equal(path.dirname(fs.realpathSync(restored)), root); fs.rmSync(restored, { recursive: true });
      }
    }
    report.archiveIntegrity = true; report.status = 'passed_full_source_backup_measurement';
  } catch (error) {
    report.status = 'failed'; report.error = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'BACKUP_MEASUREMENT_FAILED'; throw error;
  } finally {
    await close(); password.fill(0); documentKey.fill(0);
    assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true });
    report.isolatedMeasurementFilesRemoved = true; report.durationMs = Date.now() - measurementStarted; progress('finished');
  }
}
module.exports = { measureTradeFotoFullBackup };
