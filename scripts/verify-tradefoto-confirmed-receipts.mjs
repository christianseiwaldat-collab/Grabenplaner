// Exact, user-confirmed examples in a SEPARATE explicit subset export. This
// exercises real values/roundtrips/mappings/refresh/undo; it does NOT claim that
// the full source (or its unresolved trade counters) was applied or approved.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../lib/data-import-contract');
const M = require('../lib/tradefoto-master-profiles'), H = require('../lib/tradefoto-history-profiles');
const { streamTradeFotoFullSource } = require('../lib/tradefoto-full-import-reader');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportEngine } = require('../lib/data-import-engine');
const { createDataImportRepository } = require('../lib/persistence/repositories/data-import');
const { createImportMasterWriters, createImportMasterService } = require('../lib/persistence/repositories/import-master-data');
const { createImportHistoryWriters, createImportHistoryService } = require('../lib/persistence/repositories/import-history');
const { IMPORT_HISTORY_STATEMENTS: HS } = require('../lib/persistence/statements/import-history');
const { STATUS_FIELDS, defineTradeFotoSalesPolicy, defineTradeFotoReceiptCoverage } = require('../lib/tradefoto-sales-rules');
const { openTradeFotoBlock3Store } = require('../test-support/tradefoto-block3-store');
if (process.argv.length !== 3) throw new Error('Usage: verify-tradefoto-confirmed-receipts.mjs CASH.accdb');
const sourcePath = fs.realpathSync(process.argv[2]), stat = fs.statSync(sourcePath);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = hash(fs.readFileSync(sourcePath));
assert.equal(fileSha256, '6a7e9f3cb8404299da54aef8c5ab661d7d66e1791003ebcd62c10d60a6a4e395', 'SOURCE_HASH_CHANGED');
const root = path.resolve(import.meta.dirname, '../tmp'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'tradefoto-block3-receipts-'));
const time = new Date().toISOString(), started = Date.now(), report = { format: 'grabenplaner.tradefoto.confirmed-receipts.v1',
  createdAt: time, productionWrites: false, fullSourceApplied: false, sourceFileSha256: fileSha256,
  scope: 'Explicit subset export of complete confirmed receipts; synthetic GP mapping targets only.', results: [], status: 'running' };
const actor = { scopeId: 'isolated-receipts', ownerId: 'test-only' }, sourceInstance = 'verified-subset-cash';
const encryptionKey = crypto.randomBytes(32), indexKey = crypto.randomBytes(32);
const protection = createDataImportProtection({ encryptionKey, indexKey, keyId: 'ephemeral-test' }); encryptionKey.fill(0); indexKey.fill(0);
const heads = new Map(), selectedLines = [], sourceCounts = {}, membership = new Set(); let table = '', allLines = 0, orphanLines = 0;
const receiptKey = row => C.canonical(['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'].map(key => row[key]));
const selected = row => row.Filialid === '18' && row.Kassenid === '18' && (['2026-09-03', '2026-09-04'].includes(row.Bondatum?.slice(0, 10))
  || row.Bondatum?.startsWith('2026-08-26T') && row.Bonnr === '88721');
let app;
try {
  const buffer = fs.readFileSync(sourcePath);
  try { await streamTradeFotoFullSource({ buffer, kind: 'cash', onMessage: async message => {
    report.peakRssBytes = Math.max(report.peakRssBytes || 0, process.memoryUsage().rss);
    if (message.type === 'table') { table = message.name; sourceCounts[table] = { declared: message.declaredRows, read: message.expectedRows }; }
    if (message.type !== 'rows') return;
    if (table === 'Umsatz_KASSE') for (const raw of message.rows) {
      const row = C.normalizeDataImportRow(H.profileFor('cash', table), raw).source, key = receiptKey(row);
      membership.add(protection.digest(key));
      if (selected(row)) { assert.equal(heads.has(key), false, 'DUPLICATE_SELECTED_HEAD'); heads.set(key, row); }
    }
    if (table === 'Umsatz_Kasse_Details') for (const raw of message.rows) {
      // Key membership is checked over EVERY line, not a page of imported rows.
      const key = receiptKey(raw); allLines++;
      if (!membership.has(protection.digest(key))) orphanLines++;
      if (selected(raw)) selectedLines.push(C.normalizeDataImportRow(H.profileFor('cash', table), raw).source);
    }
  } }); } finally { buffer.fill(0); }
  report.sourceCounts = sourceCounts; report.sourceMembership = { heads: membership.size, lines: allLines, orphanLines };
  assert.equal(allLines, 385877); assert.equal(sourceCounts.Umsatz_Kasse_Details.declared, allLines);
  assert.equal(membership.size, sourceCounts.Umsatz_KASSE.declared, 'SOURCE_HEAD_COUNT_MISMATCH');
  assert.equal(orphanLines, 0, 'SOURCE_PARENT_MISSING');
  const selectedHeads = [...heads.values()];
  assert.equal(selectedHeads.length, 68); assert.equal(selectedLines.length, 86);
  const exportSha256 = hash(protection.seal({ heads: selectedHeads, lines: selectedLines }, ['explicit-complete-receipt-subset-export']));
  app = openTradeFotoBlock3Store(directory);
  const sellerKeys = [...new Set([...selectedHeads, ...selectedLines].map(row => row['VerkäuferID'] ?? row['Verkäuferid']).filter(value => value && value !== '0'))];
  app.seedTestTargets(sellerKeys);
  const composition = { protection, getActor: () => actor, authorize: () => true, clock: () => time };
  const writers = { ...createImportMasterWriters({ protection }), ...createImportHistoryWriters({ ...composition, resolveMasterSourceInstance: () => 'synthetic-test-masters' }) };
  const engine = createDataImportEngine({ ...composition, repository: createDataImportRepository(app.provider),
    profiles: [...M.TRADEFOTO_MASTER_PROFILES, ...H.TRADEFOTO_HISTORY_PROFILES], writers });
  const masters = createImportMasterService({ ...composition, access: app.provider });
  const history = createImportHistoryService({ ...composition, access: app.provider });
  const runs = [], events = [];
  async function ingest(name, rows, { master = false, attemptId = 'default' } = {}) {
    const profile = master ? M.profileFor(name) : H.profileFor('cash', name);
    const manifest = { sourceInstance: master ? 'synthetic-test-masters' : sourceInstance, fileSha256: exportSha256,
      schemaSha256: profile.schemaSha256, expectedRows: rows.length, declaredRows: rows.length, snapshotAt: time, gates: [] };
    let run = await engine.start({ profileHash: profile.fingerprint, manifest, attemptId });
    for (let i = 0; i < rows.length; i += C.LIMITS.batch) run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: i + 1, rows: rows.slice(i, i + C.LIMITS.batch) });
    run = await engine.seal(run.id, run.revision);
    do { run = await engine.review(run.id, run.revision); } while (run.status === 'reviewing');
    assert.equal(run.status, 'ready', 'SUBSET_REVIEW_REQUIRED');
    do { run = await engine.apply(run.id, run.revision); } while (run.status === 'applying'); runs.push(run);
    const before = app.counts(), repeat = await engine.start({ profileHash: profile.fingerprint, manifest, attemptId });
    assert.equal(repeat.id, run.id); assert.deepEqual(app.counts(), before);
    return run;
  }
  const masterRaw = (name, extra) => M.prepareTradeFotoMasterRow(name, { ...Object.fromEntries(M.tableFor(name).columns.filter(c => !c.excluded).map(c => [c.name, null])), ...extra }, { fileSha256: exportSha256, rowNumber: 1 });
  await ingest('FILIALEN', [masterRaw('FILIALEN', { FilialID: '18' })], { master: true });
  await ingest('MITARBEITER', sellerKeys.map(key => masterRaw('MITARBEITER', { Verkäufer_ID: key })), { master: true });
  async function bind(name, key, targetId) {
    const record = (await masters.mappings({ table: name, sourceInstance: 'synthetic-test-masters', key })).items[0];
    assert.ok(record, 'SYNTHETIC_MAPPING_SOURCE_REQUIRED');
    const input = { recordId: record.id, expectedSourceRevision: 1, targetId, historical: false, reason: 'Isolated test target, not a productive assignment' };
    const preview = await masters.previewBinding(input), saved = await masters.bind(input, preview.planHash); events.push(saved.eventId);
  }
  await bind('FILIALEN', '18', 'test-branch-18');
  await ingest('Umsatz_KASSE', selectedHeads); await ingest('Umsatz_Kasse_Details', selectedLines);
  const rules = new Map();
  for (const row of selectedLines) {
    const flags = Object.fromEntries(STATUS_FIELDS.map(field => [field, row[field]]));
    const quantitySign = Number(row.VKMenge) < 0 ? 'negative' : 'positive';
    const key = C.canonical([flags, quantitySign]);
    if (!rules.has(key)) rules.set(key, { id: 'confirmed-example-' + rules.size, flags, quantitySign, status: quantitySign === 'negative' ? 'return' : 'sale' });
  }
  const evidenceSha256 = C.fingerprint({ dates: ['2026-08-26', '2026-09-03', '2026-09-04'], totals: ['525.78', '2494.51', '1001.71'], fileSha256,
    note: 'User-confirmed receipt/daily-report examples only; no general historical activation.' });
  const policy = defineTradeFotoSalesPolicy({ id: 'isolated-confirmed-examples', version: 1, scopeId: actor.scopeId, sourceInstance,
    schemaSha256: H.profileFor('cash', 'Umsatz_KASSE').schemaSha256, evidenceSha256, approvedBy: 'isolated-test', approvedAt: time,
    currency: 'EUR', minorUnits: 2, priceBasis: 'gross', priceMeaning: 'final_unit', headerBasis: 'gross',
    rounding: 'half_away_from_zero', vatRates: { '20': '20', '0': '0' }, statusRules: [...rules.values()], headerToleranceMinor: 0, headerZeroMeaning: 'unavailable' });
  // The two code-0 positions in this exact confirmed selection have zero final
  // price; retain both in membership. This does not approve historical VAT codes.
  const zeroTaxRows = selectedLines.filter(row => row.MWST === '0');
  assert.equal(zeroTaxRows.length, 2); assert.ok(zeroTaxRows.every(row => Number(row.VK_Preis) === 0));
  report.zeroPriceTaxCodeZeroRows = zeroTaxRows.length;
  const lookup = (name, row) => app.provider.queryOne(HS.find, { scopeId: actor.scopeId,
    identityHash: H.historyIdentity(protection, { ...actor, sourceInstance }, 'cash', name, H.profileFor('cash', name).keyFields.map(key => row[key])) });
  const verified = new Map();
  async function reconcile() {
    const dayTotals = new Map(); let roundtrips = 0;
    for (const row of selectedHeads) {
      const record = await lookup('Umsatz_KASSE', row), detail = await history.detail(record.id);
      assert.deepEqual(detail.fields, row, 'HEAD_ROUNDTRIP_MISMATCH'); roundtrips++;
      assert.ok(detail.references.some(ref => ref.targetId === 'test-branch-18'), 'PRE_IMPORT_BRANCH_MAPPING_MISSING');
      const lines = selectedLines.filter(line => receiptKey(line) === receiptKey(row));
      const coverage = defineTradeFotoReceiptCoverage({ scopeId: actor.scopeId, sourceInstance, fileSha256: exportSha256,
        schemaSha256: policy.schemaSha256, evidenceSha256, expectedSourceRows: selectedLines.length, verifiedSourceRows: selectedLines.length, head: row, lines });
      const receipt = await history.receipt(record.id, policy, coverage);
      if (!receipt.canAggregate) {
        report.reconciliationIssues = [...new Set([...(report.reconciliationIssues || []), ...receipt.issues])];
        throw new Error('CONFIRMED_RECEIPT_NOT_RECONCILED');
      }
      const day = row.Bondatum.slice(0, 10), minor = BigInt(receipt.totals.gross.replace('.', ''));
      const summary = dayTotals.get(day) || { receipts: 0, lines: 0, grossMinor: 0n, negativeReceipts: 0, zeroReceipts: 0 };
      summary.receipts++; summary.lines += lines.length; summary.grossMinor += minor;
      summary.negativeReceipts += minor < 0n ? 1 : 0; summary.zeroReceipts += minor === 0n ? 1 : 0; dayTotals.set(day, summary);
      if (verified.has(record.id)) assert.deepEqual(receipt.totals, verified.get(record.id), 'REFRESH_CHANGED_REVENUE');
      verified.set(record.id, receipt.totals);
    }
    for (const row of selectedLines) {
      const record = await lookup('Umsatz_Kasse_Details', row), detail = await history.detail(record.id);
      assert.deepEqual(detail.fields, row, 'LINE_ROUNDTRIP_MISMATCH'); roundtrips++;
    }
    const expected = { '2026-08-26': 52578n, '2026-09-03': 249451n, '2026-09-04': 100171n };
    report.results = [...dayTotals].map(([date, totals]) => {
      assert.equal(totals.grossMinor, expected[date], 'CONFIRMED_DAY_AMOUNT_MISMATCH');
      return { date, ...totals, grossMinor: String(totals.grossMinor), matchesConfirmedReport: true };
    });
    report.fieldExactRoundtrips = roundtrips;
  }
  await reconcile(); report.beforeRefresh = app.counts();
  // Binding a test seller must not silently alter already archived references.
  const sample = await lookup('Umsatz_KASSE', selectedHeads.find(row => sellerKeys.includes(row['VerkäuferID'])));
  assert.ok(sample, 'TEST_SELLER_SAMPLE_REQUIRED');
  const beforeBinding = await history.detail(sample.id);
  for (const seller of sellerKeys) await bind('MITARBEITER', seller, 'test-seller-' + seller);
  assert.deepEqual((await history.detail(sample.id)).references, beforeBinding.references, 'BINDING_REWROTE_HISTORY');
  await assert.rejects(masters.undo(events.at(-1)), error => error.code === 'IMPORT_UNDO_DEPENDENCIES');
  await ingest('Umsatz_KASSE', selectedHeads, { attemptId: 'explicit-reference-refresh' });
  await ingest('Umsatz_Kasse_Details', selectedLines, { attemptId: 'explicit-reference-refresh' });
  const refreshed = await history.detail(sample.id);
  assert.ok(refreshed.revision > beforeBinding.revision, 'REFRESH_DID_NOT_CREATE_VERSION');
  assert.ok(refreshed.references.some(ref => ref.role === 'header_seller' && ref.targetId?.startsWith('test-seller-')), 'REFRESH_MAPPING_MISSING');
  await reconcile(); report.afterRefresh = app.counts();
  assert.equal(report.afterRefresh.import_history_records, report.beforeRefresh.import_history_records, 'REFRESH_DUPLICATED_RECORDS');
  report.referenceRefresh = 'passed_explicit_version_no_duplicates_same_amounts';
  // Unwind the actual dependency graph: restored parents may remain held by
  // older child versions until those child imports have been undone.
  let pending = runs.slice(2).reverse(), deferrals = 0;
  while (pending.length) {
    const deferred = [];
    for (const saved of pending) {
      try {
        let run = await engine.preview(saved.id);
        do { run = await engine.undo(run.id, run.revision); } while (run.status === 'reverting');
        assert.equal(run.status, 'reverted', 'UNDO_INCOMPLETE');
      } catch (error) {
        if (!['IMPORT_UNDO_DEPENDENCIES', 'IMPORT_UNDO_LATER_IMPORT'].includes(error.code)) throw error;
        deferred.push(saved); deferrals++;
      }
    }
    assert.ok(deferred.length < pending.length, 'UNDO_DEPENDENCY_CYCLE'); pending = deferred;
  }
  for (const event of [...events].reverse()) await masters.undo(event);
  for (const saved of runs.slice(0, 2).reverse()) { let run = await engine.preview(saved.id); do { run = await engine.undo(run.id, run.revision); } while (run.status === 'reverting'); }
  const final = app.counts();
  for (const name of ['data_import_links', 'import_master_records', 'import_history_records', 'import_history_versions', 'import_master_holds']) assert.equal(final[name], 0, 'UNDO_RETAINED_TARGET');
  report.undo = { status: 'passed', dependencyDeferrals: deferrals }; report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof C.DataImportError ? error.code : /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SUBSET_VERIFICATION_FAILED';
  process.exitCode = 1;
} finally {
  if (app) { report.finalCounts = app.counts(); report.integrity = app.verify(); await app.close(); }
  protection.destroy();
  report.sourceUnchanged = hash(fs.readFileSync(sourcePath)) === fileSha256 && fs.statSync(sourcePath).mtimeMs === stat.mtimeMs;
  assert.equal(path.dirname(fs.realpathSync(directory)), root);
  for (const name of ['isolated-encrypted.db', 'isolated-encrypted.db-wal', 'isolated-encrypted.db-shm']) {
    const filename = path.join(directory, name); if (fs.existsSync(filename)) fs.unlinkSync(filename);
  }
  report.encryptedTestFilesRemoved = true; report.durationMs = Date.now() - started;
  const reportPath = path.join(directory, 'report.json'); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ reportPath, ...report }));
}
