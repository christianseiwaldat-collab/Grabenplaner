// Productive preparation Block 3: full sources, actual managed runtime/worker,
// fresh encrypted test DB. Never opens an application DB, changes an ACCDB,
// bypasses an unapproved source gate, or persists a key. Reports contain aggregates only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../lib/data-import-contract');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
const { createDataImportRuntime } = require('../lib/persistence/repositories/data-import-runtime');
const { loadManagedDataImportProtection } = require('../lib/data-import-managed-protection');
const { createCashSnapshotStore } = require('../lib/persistence/repositories/cash-snapshots');
const { createImportMasterService } = require('../lib/persistence/repositories/import-master-data');
const { streamTradeFotoFullSource } = require('../lib/tradefoto-full-import-reader');
const { definitions } = require('../lib/tradefoto-full-import-source');
const { DATA_IMPORT_PERMISSIONS } = require('../lib/data-import-access');
const { openTradeFotoBlock3Store } = require('../test-support/tradefoto-block3-store');
const { measureTradeFotoFullBackup } = require('../test-support/tradefoto-full-backup-measurement');
const { planTradeFotoMeasurementBudget, verifyTradeFotoMeasurementStart } = require('../test-support/tradefoto-measurement-budget');
const compactCash = process.argv.includes('--compact-cash');
const suppliedArgs = process.argv.slice(2).filter(arg => arg !== '--compact-cash');
const sharedPayloads = suppliedArgs.at(-1) === '--shared-payloads';
const args = sharedPayloads ? suppliedArgs.slice(0, -1) : suppliedArgs;
const measureBackup = args.length === 5 && args[2] === '--measure-backup';
if (args.length !== 2 && !measureBackup) throw new Error('Usage: verify-tradefoto-full-import.mjs TRADE.accdb CASH.accdb [--measure-backup RESTIC_BINARY SHA256] [--shared-payloads]');
if (compactCash && !measureBackup) throw new Error('COMPACT_CASH_REQUIRES_BACKUP_MEASUREMENT');
const expected = [
  { kind: 'trade', bytes: 188649472, sha256: '42a40cb19d867fcc5d6e6f3429065ba0ff77f65a7b9b7fcfaae3d0b61f8154f3' },
  { kind: 'cash', bytes: 330928128, sha256: '6a7e9f3cb8404299da54aef8c5ab661d7d66e1791003ebcd62c10d60a6a4e395' },
];
const root = path.resolve(import.meta.dirname, '../tmp');
fs.mkdirSync(root, { recursive: true });
const freeBytes = () => { const s = fs.statfsSync(root); return s.bavail * s.bsize; };
// Check before reading the sources or creating the isolated database. These are
// enforced experiment limits, not an extrapolated full-source saving forecast.
const measurementBudget = measureBackup ? planTradeFotoMeasurementBudget(compactCash ? { databaseBudgetBytes: 8 * 1024 ** 3 } : {}) : null;
const measurementPreflight = measurementBudget ? verifyTradeFotoMeasurementStart(measurementBudget, freeBytes()) : null;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inputs = args.slice(0, 2).map((file, index) => {
  const resolved = fs.realpathSync(file), stat = fs.statSync(resolved), proof = expected[index];
  assert.equal(stat.size, proof.bytes, 'SOURCE_SIZE_CHANGED');
  assert.equal(hash(fs.readFileSync(resolved)), proof.sha256, 'SOURCE_HASH_CHANGED');
  return { file: resolved, modifiedMs: stat.mtimeMs, ...proof };
});
if (freeBytes() < 10 * 1024 ** 3) throw new Error('TEST_DISK_RESERVE_REQUIRED');
const directory = fs.mkdtempSync(path.join(root, 'tradefoto-block3-'));
const reportPath = path.join(directory, 'report.json');
const started = Date.now(), vaultKey = crypto.randomBytes(32), sources = [];
const vault = () => createIntegrationSecretVault({ activeKeyId: 'ephemeral-test', resolveKey: id => id === 'ephemeral-test' ? vaultKey : null });
const report = { format: 'grabenplaner.tradefoto.full-test.v1', createdAt: new Date().toISOString(), productionWrites: false,
  processId: process.pid, nodeVersion: process.version,
  importEvidenceStorage: sharedPayloads ? 'shared-parts-v1' : 'legacy-full-payloads',
  cashStorage: compactCash ? 'cash-compact-v1' : 'generic-import-history',
  cashBusinessActivation: false,
  managedPayloadCompression: 'authenticated-deflate-v2-with-v1-dual-reader',
  progressCountStorage: 'transactional-state-counts-v1',
  privacy: 'Aggregates only; no source field values, names, credentials or keys.', status: 'running',
  independentAccessEngine: false, sources, metrics: { freeBytesBefore: freeBytes(), peakRssBytes: 0, peakDatabaseBytes: 0 },
  restartReplay: 'pending', repeat: 'pending', undo: 'pending', productionReady: false };
report.implementationFiles = [
  'scripts/verify-tradefoto-full-import.mjs', 'test-support/tradefoto-full-backup-measurement.js',
  'test-support/tradefoto-measurement-budget.js', 'lib/data-import-engine.js',
  'lib/data-import-protection.js', 'lib/data-import-managed-protection.js', 'lib/data-import-payload-store.js',
  'lib/persistence/repositories/data-import-runtime.js', 'lib/persistence/sqlite/data-import-catalog.js',
  'lib/persistence/sqlite/operations/data-import-schema.js', 'lib/tradefoto-full-import-worker.js',
  'lib/tradefoto-full-import-reader.js',
  ...(compactCash ? ['lib/persistence/repositories/cash-snapshots.js', 'lib/persistence/sqlite/cash-snapshots-catalog.js',
    'lib/persistence/sqlite/operations/cash-snapshots-schema.js', 'lib/persistence/statements/cash-snapshots.js',
    'test-support/tradefoto-block3-store.js'] : []),
].map(file => ({ file, sha256: hash(fs.readFileSync(path.resolve(import.meta.dirname, '..', file))) }));
if (measureBackup) {
  const { sha256File } = require('../lib/file-integrity');
  assert.match(args[4], /^[a-f0-9]{64}$/);
  assert.equal(sha256File(fs.realpathSync(args[3])), args[4], 'RESTIC_BINARY_HASH_MISMATCH');
  report.purpose = 'full-source-backup-measurement';
  report.measurementBudget = measurementBudget;
  report.measurementPreflight = measurementPreflight;
}
const session = { employeeNumber: 'isolated-verifier', accountId: 'isolated-account', isEmployee: true, role: 'developer',
  permissions: [...Object.values(DATA_IMPORT_PERMISSIONS), 'sales:analytics:access', 'sales:analytics:company:read'] };
const getSession = async () => session;
const mappingEvents = [], testSellers = ['419', '430'];
let mappingsApplied = false, mappingsReverted = false;
async function withMasters(work) {
  const protection = await loadManagedDataImportProtection({ access: app.provider, vault: vault() });
  try {
    const service = createImportMasterService({ access: app.provider, protection,
      getActor: () => ({ scopeId: 'isolated-full-test', ownerId: session.employeeNumber }), authorize: () => true });
    return await work(service);
  } finally { protection.destroy(); }
}
async function mappingStep(source, action) {
  if (source.kind !== 'trade') return;
  const masterNames = new Set(definitions('trade').filter(t => t.master).map(t => t.name));
  if (action === 'apply' && !mappingsApplied && source.tables.filter(t => masterNames.has(t.name)).every(t => t.run.status === 'applied')) {
    assert.ok(source.tables.filter(t => !masterNames.has(t.name)).every(t => !['applied', 'applying'].includes(t.run.status)), 'MAPPING_TOO_LATE');
    app.seedTestTargets(testSellers);
    await withMasters(async masters => {
      for (const [name, key, targetId] of [['FILIALEN', '18', 'test-branch-18'], ...testSellers.map(key => ['MITARBEITER', key, 'test-seller-' + key])]) {
        const record = (await masters.mappings({ table: name, sourceInstance: 'tradefoto-trade', key })).items[0];
        assert.ok(record, 'TEST_MAPPING_SOURCE_REQUIRED');
        const input = { recordId: record.id, expectedSourceRevision: 1, targetId, historical: false, reason: 'Isolated test target, not a productive assignment' };
        const preview = await masters.previewBinding(input), saved = await masters.bind(input, preview.planHash); mappingEvents.push(saved.eventId);
      }
    });
    mappingsApplied = true; report.mapping = { status: 'passed_before_history', syntheticTargets: mappingEvents.length, productiveAssignments: 0 };
  }
  if (action === 'undo' && mappingsApplied && !mappingsReverted && source.tables.filter(t => !masterNames.has(t.name)).every(t => t.run.status === 'reverted')) {
    await withMasters(async masters => { for (const id of [...mappingEvents].reverse()) await masters.undo(id); });
    mappingsReverted = true; report.mapping.undo = 'passed_after_dependent_history';
  }
}
let app, runtime, phase = 'preflight', table = '', processed = 0, injectInterruption = true, interrupted = false, lastProgress = 0;
function measure() {
  if (compactCash && Date.now() - started > 3 * 60 * 60 * 1000) throw new Error('MEASUREMENT_TIME_LIMIT');
  report.metrics.peakRssBytes = Math.max(report.metrics.peakRssBytes, process.memoryUsage().rss);
  const bytes = ['isolated-encrypted.db', 'isolated-encrypted.db-wal', 'isolated-encrypted.db-shm'].reduce((n, file) => {
    const target = path.join(directory, file); return n + (fs.existsSync(target) ? fs.statSync(target).size : 0);
  }, 0);
  report.metrics.peakDatabaseBytes = Math.max(report.metrics.peakDatabaseBytes, bytes);
  if (measurementBudget) {
    const databaseFile = path.join(directory, 'isolated-encrypted.db');
    if (fs.existsSync(databaseFile) && fs.statSync(databaseFile).size > measurementBudget.databaseBudgetBytes) {
      throw new Error('MEASUREMENT_DATABASE_BUDGET_EXCEEDED');
    }
    if (bytes > measurementBudget.databaseBudgetBytes + measurementBudget.walBudgetBytes) {
      throw new Error('MEASUREMENT_DATABASE_FAMILY_BUDGET_EXCEEDED');
    }
  }
  if (freeBytes() < 10 * 1024 ** 3) throw new C.DataImportError('IMPORT_TEST_DISK_RESERVE', 409);
}
function persist() {
  report.durationMs = Date.now() - started;
  report.progress = { phase, table, processed };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}
function progress(force = false) {
  if (!force && Date.now() - lastProgress < 20000) return;
  measure(); lastProgress = Date.now(); persist();
  console.log(JSON.stringify({ phase, table, processed, elapsedMs: Date.now() - started, rssBytes: process.memoryUsage().rss,
    peakDatabaseBytes: report.metrics.peakDatabaseBytes }));
}
function open() {
  app = openTradeFotoBlock3Store(directory);
  runtime = createDataImportRuntime({ access: app.provider, vault: vault(), scopeId: 'isolated-full-test', allowApply: true, sharedPayloads, compactCash,
    readSource: options => streamTradeFotoFullSource({ ...options, onMessage: async message => {
      if (message.type === 'table') { table = message.name; processed = 0; progress(true); }
      await options.onMessage(message);
      if (message.type === 'rows') {
        processed = message.startRow + message.rows.length - 1;
        if (injectInterruption) { injectInterruption = false; interrupted = true; throw new C.DataImportError('IMPORT_SOURCE_INTERRUPTED', 409); }
      }
      progress(message.type === 'table-complete');
    } }),
  });
}
async function close() { if (app) { await app.close(); app = null; } }
function tableReport(source) {
  return source.tables.map(t => ({ name: t.name, declared: t.declaredRows, expected: t.run.expectedRows,
    received: t.run.receivedRows, status: t.run.status, gates: t.run.gates, counts: t.run.counts,
    ...(t.run.acceptedDeviations ? { originalGates: t.run.originalGates, acceptedDeviations: t.run.acceptedDeviations } : {}) }));
}
async function advance(source, action) {
  let previous = '', steps = 0;
  do {
    await mappingStep(source, action);
    const state = [source.revision, source.tables.map(t => [t.run.status, t.run.revision])];
    const stamp = JSON.stringify(state);
    assert.notEqual(stamp, previous, 'TEST_PROGRESS_STALLED'); previous = stamp;
    source = await runtime.sourceOperation(getSession, source.id, action, { expectedRevision: source.revision });
    const active = source.tables.find(t => ['reviewing', 'applying', 'reverting'].includes(t.run.status));
    table = active?.name || '';
    processed = source.tables.reduce((n, t) => n + (action === 'review'
      ? t.run.receivedRows - (t.run.counts.staged || 0)
      : (t.run.counts.applied || 0) + (t.run.counts.reverted || 0)), 0);
    progress();
    if (++steps > 100000) throw new Error('TEST_STEPS_LIMIT');
  } while (source.status === ({ review: 'reviewing', apply: 'applying', undo: 'reverting' }[action]));
  return source;
}
const completed = [];
try {
  open(); report.before = app.counts();
  for (const input of inputs) {
    const sourceReport = { kind: input.kind, fileSha256: input.sha256, bytes: input.bytes, phases: {}, tables: [] }; sources.push(sourceReport);
    phase = input.kind + ':stage'; const stageStarted = Date.now(); let source;
    try { source = await runtime.upload(getSession, { kind: input.kind, buffer: fs.readFileSync(input.file) }); }
    catch (error) {
      if (!interrupted || error.code !== 'IMPORT_SOURCE_INTERRUPTED') throw error;
      interrupted = false;
      const beforeRestart = app.counts(), list = await runtime.list(getSession);
      assert.equal(list.items[0].status, 'interrupted'); const id = list.items[0].id;
      await close(); open(); assert.deepEqual(app.counts(), beforeRestart);
      source = await runtime.upload(getSession, { kind: input.kind, buffer: fs.readFileSync(input.file) });
      assert.equal(source.id, id); report.restartReplay = 'passed_same_source_and_checkpoint';
    }
    sourceReport.phases.stageMs = Date.now() - stageStarted; sourceReport.tables = tableReport(source);
    assert.equal(source.complete, true); assert.equal(source.tables.length, definitions(input.kind).length);
    const beforeRepeat = app.counts(); const repeatStarted = Date.now();
    const repeat = await runtime.upload(getSession, { kind: input.kind, buffer: fs.readFileSync(input.file) });
    assert.equal(repeat.id, source.id); assert.deepEqual(app.counts(), beforeRepeat);
    sourceReport.phases.repeatMs = Date.now() - repeatStarted; sourceReport.repeat = 'passed_no_duplicates';
    phase = input.kind + ':review'; const reviewStarted = Date.now();
    source = await advance(source, 'review');
    sourceReport.phases.reviewMs = Date.now() - reviewStarted; sourceReport.tables = tableReport(source);
    sourceReport.afterReview = app.counts(); sourceReport.status = source.status; persist();
    // Prerequisite conflicts are re-planned by the real runtime after parents.
    // Actual unresolved conflicts still stop the engine; no force-applied rows.
    if (compactCash && input.kind === 'cash') {
      assert.equal(source.status, 'ready', 'COMPACT_CASH_REVIEW_REQUIRED');
      assert.equal(source.verifiedRows, 1082167, 'COMPACT_CASH_FULL_COUNT_REQUIRED');
      assert.equal(source.activationEnabled, false);
      sourceReport.apply = 'not_activated_compact_preview';
      sourceReport.verifiedRows = source.verifiedRows;
      await assert.rejects(runtime.sourceOperation(getSession, source.id, 'apply', { expectedRevision: source.revision }),
        error => error.code === 'IMPORT_NOT_ACTIVATED');
      sourceReport.businessActivationGateVerified = true;
    } else if (source.tables.some(t => t.run.gates.length || t.run.counts.invalid)) {
      sourceReport.apply = 'blocked_unresolved_source_or_preview';
    } else {
      phase = input.kind + ':apply'; const applyStarted = Date.now();
      try { source = await advance(source, 'apply'); sourceReport.apply = source.status; }
      catch (error) { sourceReport.apply = error.code || 'IMPORT_TEST_APPLY_FAILED'; }
      sourceReport.phases.applyMs = Date.now() - applyStarted;
      source = await runtime.sourceOperation(getSession, source.id, 'read'); sourceReport.tables = tableReport(source);
    }
    const beforeAppliedRepeat = app.counts();
    const appliedRepeat = await runtime.upload(getSession, { kind: input.kind, buffer: fs.readFileSync(input.file) });
    assert.equal(appliedRepeat.id, source.id); assert.deepEqual(app.counts(), beforeAppliedRepeat);
    sourceReport.repeatAfterApply = 'passed_no_duplicates';
    completed.push({ source, sourceReport }); progress(true);
    if (compactCash && input.kind === 'trade') {
      phase = 'trade:separate-compaction'; progress(true);
      const required = 3 * fs.statSync(path.join(directory, 'isolated-encrypted.db')).size + 10 * 1024 ** 3;
      assert.ok(freeBytes() >= required, 'TRADE_COMPACTION_RESERVE');
      const compactStarted = Date.now();
      sourceReport.storage = app.storageFootprint({ compact: true });
      sourceReport.phases.compactMs = Date.now() - compactStarted;
      progress(true);
    }
  }
  report.after = app.counts(); report.issues = app.issues().map(row => ({ ...row,
    table: [...definitions('trade'), ...definitions('cash')].find(t => t.profile.fingerprint === row.profileHash)?.name }));
  report.repeat = 'passed_both_complete_sources';
  if (measureBackup) {
    assert.ok(sources.every(s => s.apply === 'applied' || (compactCash && s.kind === 'cash'
      && s.apply === 'not_activated_compact_preview' && s.verifiedRows === 1082167)), 'BACKUP_REQUIRES_COMPLETE_IMPORT');
    if (compactCash) {
      const tradeCounts = sources.find(s => s.kind === 'trade').afterReview;
      assert.equal(report.after.data_import_rows, tradeCounts.data_import_rows, 'GENERIC_CASH_DUPLICATION');
      report.genericCashCopies = 0;
    }
    report.verification = app.verify();
    assert.equal(report.verification.integrity && report.verification.foreignKeys, true, 'DATABASE_INTEGRITY_FAILED');
    const protection = await loadManagedDataImportProtection({ access: app.provider, vault: vault() });
    const expectedKeyProof = protection.digest(['full-backup-qualification']); protection.destroy();
    await close();
    phase = 'backup-measurement'; progress(true);
    report.backup = {};
    await measureTradeFotoFullBackup({ directory, binary: args[3], binarySha256: args[4], vault: vault(),
      expectedKeyProof, report: report.backup, budget: measurementBudget, onProgress: () => progress(true),
      verifyRestored: compactCash ? async ({ access, point }) => {
        const recovered = await loadManagedDataImportProtection({ access, vault: vault(), create: false });
        try {
          const cash = createCashSnapshotStore({ access, protection: recovered,
            actor: { scopeId: 'isolated-full-test', ownerId: session.employeeNumber } });
          const id = completed.find(entry => entry.source.kind === 'cash').source.id;
          await cash.reverify(id); let result;
          do { result = await cash.review(id); processed = result.verifiedRows; progress(); } while (result.status === 'reviewing');
          assert.equal(result.status, 'ready'); assert.equal(result.verifiedRows, 1082167);
          point.cashEveryValueVerified = true; point.cashVerifiedRows = result.verifiedRows;
        } finally { recovered.destroy(); }
      } : undefined });
    report.undo = 'not_repeated_in_backup_measurement; previous Block-3 acceptance remains separate';
    report.status = compactCash ? 'passed_trade_and_compact_cash_backup_measurement' : 'passed_full_import_and_backup_measurement';
  } else {
  phase = 'undo';
  for (const entry of [...completed].reverse()) {
    if (!entry.source.tables.some(t => ['applied', 'applying', 'reverting'].includes(t.run.status))) continue;
    const undoStarted = Date.now();
    entry.source = await advance(entry.source, 'undo'); entry.sourceReport.phases.undoMs = Date.now() - undoStarted;
    entry.sourceReport.undo = entry.source.status;
  }
  report.afterUndo = app.counts(); report.verification = app.verify();
  for (const name of ['import_master_records', 'import_history_records', 'import_history_versions', 'import_master_holds', 'data_import_links']) assert.equal(report.afterUndo[name], 0, 'FULL_UNDO_REMAINDER');
  assert.equal(report.verification.integrity, true, 'DATABASE_INTEGRITY_FAILED'); assert.equal(report.verification.foreignKeys, true, 'FOREIGN_KEYS_FAILED');
  report.undo = report.after.import_master_records + report.after.import_history_records > 0 ? 'passed_no_remaining_targets_versions_holds_links' : 'not_exercised_source_gates';
  report.status = sources.every(s => s.apply === 'applied') ? 'passed_full_import' : 'blocked_by_preserved_gates';
  }
} catch (error) {
  report.status = 'failed'; report.error = error instanceof C.DataImportError ? error.code : /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'TEST_FAILED';
  report.failedPhase = phase; report.failedTable = table; report.failedRow = processed; process.exitCode = 1;
  if (app) report.atFailure = app.counts();
} finally {
  for (const item of report.implementationFiles) {
    if (hash(fs.readFileSync(path.resolve(import.meta.dirname, '..', item.file))) !== item.sha256) {
      report.status = 'failed'; report.error = 'IMPLEMENTATION_CHANGED_DURING_RUN'; process.exitCode = 1;
    }
  }
  // A reserve failure must not prevent closing the DB or zeroing the test key.
  try { measure(); } catch (error) {
    report.status = 'failed';
    report.error = error instanceof C.DataImportError ? error.code
      : /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'TEST_FINAL_MEASUREMENT_FAILED';
    process.exitCode = 1;
  }
  try { await close(); } finally { vaultKey.fill(0); }
  report.sourcesUnchanged = inputs.map(input => ({ kind: input.kind,
    unchanged: fs.statSync(input.file).mtimeMs === input.modifiedMs && hash(fs.readFileSync(input.file)) === input.sha256 }));
  // Only three explicitly named generated files in the fresh validated directory.
  // Retain the aggregate report, never raw data or a recoverable test key.
  assert.equal(path.dirname(fs.realpathSync(directory)), root);
  for (const filename of ['isolated-encrypted.db', 'isolated-encrypted.db-wal', 'isolated-encrypted.db-shm']) {
    const target = path.join(directory, filename); if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  report.encryptedTestFilesRemoved = true; report.metrics.freeBytesAfter = freeBytes(); persist();
  console.log(JSON.stringify({ status: report.status, reportPath, durationMs: report.durationMs, error: report.error || null }));
}
