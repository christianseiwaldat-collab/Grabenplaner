"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { openTradeFotoBlock3Store } = require('../test-support/tradefoto-block3-store');
const { measureTradeFotoFullBackup } = require('../test-support/tradefoto-full-backup-measurement');
const { planTradeFotoMeasurementBudget } = require('../test-support/tradefoto-measurement-budget');

test('full-source measurement never replaces the ordinary full-import/undo acceptance', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-tradefoto-full-import.mjs'), 'utf8');
  assert.match(source, /args\.length === 5 && args\[2\] === '--measure-backup'/);
  assert.match(source, /BACKUP_REQUIRES_COMPLETE_IMPORT/);
  assert.match(source, /not_repeated_in_backup_measurement/);
  assert.match(source, /FULL_UNDO_REMAINDER/);
  const measurement = fs.readFileSync(path.join(__dirname, '../test-support/tradefoto-full-backup-measurement.js'), 'utf8');
  assert.match(measurement, /VACUUM INTO/);
  assert.doesNotMatch(measurement, /\.exec\(['"]VACUUM['"]\)/);
  assert.match(measurement, /verifySqliteDatabaseFile\(candidate\)\.ok/);
  assert.match(measurement, /walk\(parent\)/);
  assert.match(measurement, /point\.coupledBytes \+ 64/);
});

test('full-size measurement path restores coupled files and the same managed key using pinned Restic', {
  skip: !process.env.GP_TEST_RESTIC_BINARY || !process.env.GP_TEST_RESTIC_SHA256,
}, async () => {
  const tmp = path.resolve(__dirname, '../tmp'); fs.mkdirSync(tmp, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tmp, 'tradefoto-block3-'));
  const key = crypto.randomBytes(32), report = {};
  const vault = createIntegrationSecretVault({ activeKeyId: 'fixture', resolveKey: id => id === 'fixture' ? key : null });
  let app = openTradeFotoBlock3Store(directory);
  try {
    const protection = await loadManagedDataImportProtection({ access: app.provider, vault, create: true });
    const expectedKeyProof = protection.digest(['full-backup-qualification']); protection.destroy();
    await app.close(); app = null;
    await measureTradeFotoFullBackup({ directory, binary: process.env.GP_TEST_RESTIC_BINARY,
      binarySha256: process.env.GP_TEST_RESTIC_SHA256, vault, expectedKeyProof, report,
      budget: planTradeFotoMeasurementBudget() });
    assert.equal(report.status, 'passed_full_source_backup_measurement');
    assert.equal(report.productionQualified, false);
    assert.equal(report.points.length, 3);
    assert.ok(report.points.filter(p => p.kind !== 'unchanged-repeat').every(p => p.restored && p.managedImportKeyRecovered && p.documentsVerified));
    assert.equal(report.changeSample.actualBusinessChangeWindow, false);
    assert.equal(report.isolatedMeasurementFilesRemoved, true);
    assert.equal(report.measurementImplementation, 'vacuum-into-v2');
    assert.equal(report.compactions.length, 2);
    assert.ok(report.compactions.every(c => c.method === 'VACUUM INTO' && c.independentlyVerified && c.sourceClosedBeforeReplacement));
    assert.ok(report.peakDirectoryBytes >= report.coupledSnapshotBytes + report.baselineArchiveBytes);
    assert.ok(report.peakDatabaseFamilyBytes >= 2 * report.compactedDatabaseBytes);
    assert.ok(report.minimumFreeBytes >= 10 * 1024 ** 3);
    assert.equal(report.sampledPeakOnly, true);
  } finally {
    if (app) await app.close(); key.fill(0);
    assert.equal(path.dirname(fs.realpathSync(directory)), tmp); fs.rmSync(directory, { recursive: true });
  }
});

test('future measurement preserves the original isolated DB when candidate replacement fails', {
  skip: !process.env.GP_TEST_RESTIC_BINARY || !process.env.GP_TEST_RESTIC_SHA256,
}, async () => {
  const tmp = path.resolve(__dirname, '../tmp');
  const directory = fs.mkdtempSync(path.join(tmp, 'tradefoto-block3-'));
  const original = path.join(directory, 'isolated-encrypted.db'), key = crypto.randomBytes(32), report = {};
  const vault = createIntegrationSecretVault({ activeKeyId: 'fixture', resolveKey: id => id === 'fixture' ? key : null });
  let app = openTradeFotoBlock3Store(directory);
  const rename = fs.renameSync;
  try {
    const protection = await loadManagedDataImportProtection({ access: app.provider, vault, create: true });
    const expectedKeyProof = protection.digest(['full-backup-qualification']); protection.destroy();
    await app.close(); app = null;
    fs.renameSync = (source, target) => {
      if (String(source).includes('.vacuum-') && target === original) throw new Error('synthetic-replacement-failure');
      return rename(source, target);
    };
    await assert.rejects(measureTradeFotoFullBackup({ directory, binary: process.env.GP_TEST_RESTIC_BINARY,
      binarySha256: process.env.GP_TEST_RESTIC_SHA256, vault, expectedKeyProof, report }), /synthetic-replacement-failure/);
    fs.renameSync = rename;
    assert.equal(report.status, 'failed'); assert.ok(fs.existsSync(original));
    assert.deepEqual(fs.readdirSync(directory), ['isolated-encrypted.db']);
    app = openTradeFotoBlock3Store(directory);
    const recovered = await loadManagedDataImportProtection({ access: app.provider, vault, create: false });
    try { assert.equal(recovered.digest(['full-backup-qualification']), expectedKeyProof); }
    finally { recovered.destroy(); }
  } finally {
    fs.renameSync = rename;
    if (app) await app.close(); key.fill(0);
    assert.equal(path.dirname(fs.realpathSync(directory)), tmp); fs.rmSync(directory, { recursive: true });
  }
});
