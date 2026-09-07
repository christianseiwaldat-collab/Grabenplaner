// Bounded, isolated comparison of full cash and 24-month cash snapshots.
// No production import, no Trade reads, no persistent test key or plaintext dataset.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { historyWindow, classifyCivilDate, journalSelection } from './measure-tradefoto-history-window.mjs';
const require = createRequire(import.meta.url);
const C = require('../lib/data-import-contract'), H = require('../lib/tradefoto-history-profiles');
const { sha256File } = require('../lib/file-integrity');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { openCashSnapshotPrototype, tables } = require('../test-support/cash-history-snapshot-prototype');
const root = path.resolve(import.meta.dirname, '..'), started = Date.now();
const counts = () => ({ within: 0, older: 0, unknown: 0, future: 0 });
const receiptKey = row => C.canonical(['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'].map(name => row[name] instanceof Date ? row[name].toISOString() : String(row[name])));
const knownFiles = ['full.db', 'full.db-wal', 'full.db-shm', 'window.db', 'window.db-wal', 'window.db-shm',
  'window.db.gz', 'restored.db', 'restored.db-wal', 'restored.db-shm'];
async function main() {
  assert.equal(process.argv.length, 4, 'Usage: measure-cash-history-snapshot.mjs CASH.accdb NEW-REPORT.json');
  const sourcePath = fs.realpathSync(process.argv[2]), output = path.resolve(process.argv[3]);
  assert.ok(!fs.existsSync(output), 'REPORT_EXISTS');
  const sourceBefore = fs.statSync(sourcePath), sourceSha256 = sha256File(sourcePath);
  const previous = JSON.parse(fs.readFileSync(path.join(root, 'docs/tradefoto-gesamtimport-v0.1/24-MONATE-QUELLENMESSUNG-2026-09-07.json'), 'utf8'));
  const baseline = previous.sources.find(source => source.kind === 'cash'); assert.equal(sourceSha256, baseline.sha256, 'SOURCE_CHANGED');
  const window = historyWindow(previous.window.asOfDay), tmpRoot = fs.realpathSync(path.join(root, 'tmp'));
  const free = () => { const st = fs.statfsSync(tmpRoot); return st.bavail * st.bsize; };
  assert.ok(free() > 16 * 1024 ** 3, 'EXPERIMENT_FREE_SPACE_REQUIRED');
  const directory = fs.mkdtempSync(path.join(tmpRoot, 'cash-snapshot-measurement-'));
  assert.equal(path.dirname(fs.realpathSync(directory)), tmpRoot);
  const clean = name => {
    assert.ok(knownFiles.includes(name)); const target = path.resolve(directory, name);
    assert.equal(path.dirname(target), fs.realpathSync(directory)); if (fs.existsSync(target)) fs.rmSync(target);
  };
  const buffer = fs.readFileSync(sourcePath);
  assert.equal(crypto.createHash('sha256').update(buffer).digest('hex'), sourceSha256, 'SOURCE_CHANGED_DURING_OPEN');
  const encryptionKey = crypto.randomBytes(32), indexKey = crypto.randomBytes(32);
  const protection = createDataImportProtection({ encryptionKey, indexKey, keyId: 'cash-snapshot-experiment', compression: true });
  encryptionKey.fill(0); indexKey.fill(0);
  let store, restored, peakDirectoryBytes = 0, peakRssBytes = 0, result;
  const guard = () => {
    assert.ok(Date.now() - started < 15 * 60 * 1000, 'EXPERIMENT_TIME_LIMIT');
    assert.ok(free() > 10 * 1024 ** 3, 'EXPERIMENT_RESERVE');
    const bytes = knownFiles.reduce((n, name) => n + (fs.existsSync(path.join(directory, name)) ? fs.statSync(path.join(directory, name)).size : 0), 0);
    assert.ok(bytes < 4 * 1024 ** 3, 'EXPERIMENT_DISK_LIMIT'); peakDirectoryBytes = Math.max(peakDirectoryBytes, bytes);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  try {
    const MDBReader = (await import('mdb-reader')).default, reader = new MDBReader(buffer);
    const receiptHeads = new Map(), journalHeads = new Map(), journalLines = new Map(), journalGroups = new Map();
    function each(name, columns, visitor) {
      const table = reader.getTable(name), expected = baseline.tables.find(t => t.name === name).rows;
      assert.deepEqual(table.getColumnNames(), H.tableFor('cash', name).columns.map(c => c.name));
      for (let offset = 0; offset < expected; offset += 10000) {
        const limit = Math.min(10000, expected - offset), rows = table.getData({ columns, rowOffset: offset, rowLimit: limit });
        assert.equal(rows.length, limit, 'SOURCE_COUNT_MISMATCH'); visitor(rows, offset); guard();
      }
      assert.equal(table.getData({ columns: [], rowOffset: expected, rowLimit: 1 }).length, 0, 'SOURCE_EXTRA_ROW');
    }
    each('Umsatz_KASSE', ['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'], (rows, offset) => rows.forEach((row, i) => {
      const key = receiptKey(row); assert.ok(!receiptHeads.has(key)); receiptHeads.set(key, { ordinal: offset + i + 1, state: classifyCivilDate(row.Bondatum, window) });
    }));
    each('KassenJournal', ['Vorgang', 'Datum'], (rows, offset) => rows.forEach((row, i) => {
      assert.ok(!journalHeads.has(row.Vorgang)); journalHeads.set(row.Vorgang, { ordinal: offset + i + 1, state: classifyCivilDate(row.Datum, window) });
    }));
    each('KassenJournal_Details', ['Vorgang', 'Datum'], rows => rows.forEach(row => {
      assert.ok(journalHeads.has(row.Vorgang), 'JOURNAL_PARENT_MISSING'); const group = journalLines.get(row.Vorgang) || counts();
      group[classifyCivilDate(row.Datum, window)]++; journalLines.set(row.Vorgang, group);
    }));
    for (const [key, head] of journalHeads) journalGroups.set(key, journalSelection(head.state, journalLines.get(key) || counts()));
    result = { format: 'grabenplaner.cash.snapshot-storage-measurement.v1', measuredAt: new Date().toISOString(),
      productionWrites: false, sourceWrites: false, tradeReadOrChanged: false, runtimeIntegration: false, window,
      source: { fileName: path.basename(sourcePath), bytes: sourceBefore.size, sha256: sourceSha256, rows: baseline.rows },
      method: 'One encrypted normalized source value array per row, source ordinals, authenticated metadata, FK parents and HMAC query indexes; no generic staging/link/undo/version copies.',
      variants: [], limits: { databaseMaxBytes: 2 * 1024 ** 3, sampledDirectoryMaxBytes: 4 * 1024 ** 3, reserveBytes: 10 * 1024 ** 3, timeMs: 15 * 60 * 1000 },
      limitations: ['Storage prototype, not a deployed historical statistics feature.', 'No productive account/location/class authorization or Trade master binding is supplied by this prototype.',
        'No sales-rule/turnover reconciliation or daily completeness qualification is performed here.',
        'No atomic live dataset selection, changed-upload replay, key-vault recovery or production backup integration is implemented.',
        'Archive uses gzip of an already encrypted SQLite file; it is not a Restic/offsite retention measurement.'] };
    for (const mode of ['full', 'window']) {
      const phaseStarted = Date.now(), file = path.join(directory, mode + '.db');
      const manifest = { purpose: 'isolated-storage-experiment', sourceSystem: 'tradefoto.history.cash', sourceSha256,
        sourceBytes: buffer.length, mode, window: mode === 'window' ? window : null,
        schemaProfiles: tables.map(t => [t.name, t.profile.fingerprint]) };
      store = openCashSnapshotPrototype({ file, protection, manifest });
      const variant = { mode, selectedTables: [], allSourceFields: tables.reduce((n, t) => n + t.columns.length, 0) };
      let lastProgress = 0;
      for (const table of tables) {
        let selected = 0, excluded = 0;
        each(table.name, table.columns.map(c => c.name), (rows, offset) => {
          store.transaction(() => {
            for (let i = 0; i < rows.length; i++) {
              const raw = rows[i], state = classifyCivilDate(raw.Bondatum ?? raw.Datum, window);
              const journal = table.name.startsWith('KassenJournal');
              const keep = mode === 'full' || (journal ? journalGroups.get(raw.Vorgang) !== 'older' : state !== 'older');
              if (!keep) { excluded++; continue; }
              const ordinal = offset + i + 1;
              const prepared = H.prepareTradeFotoHistoryRow('cash', table.name, raw, { fileSha256: sourceSha256, rowNumber: ordinal });
              const normalized = C.normalizeDataImportRow(table.profile, prepared);
              let parentRow = null;
              if (table.name === 'Umsatz_Kasse_Details') {
                const head = receiptHeads.get(receiptKey(raw)); assert.ok(head, 'RECEIPT_PARENT_MISSING');
                assert.ok(mode === 'full' || head.state !== 'older', 'WINDOW_PARENT_EXCLUDED'); parentRow = head.ordinal;
              } else if (table.name === 'KassenJournal_Details') parentRow = journalHeads.get(raw.Vorgang).ordinal;
              const businessDate = (normalized.source.Bondatum ?? normalized.source.Datum)?.slice(0, 10) || null;
              store.append(table.name, ordinal, normalized, { businessDate, dateState: state, parentRow }); selected++;
            }
          });
          if (Date.now() - lastProgress > 20000) {
            console.log(JSON.stringify({ mode, phase: 'building', table: table.name, selected, elapsedMs: Date.now() - phaseStarted })); lastProgress = Date.now();
          }
        });
        assert.equal(selected, mode === 'full' ? baseline.tables.find(t => t.name === table.name).rows
          : baseline.tables.find(t => t.name === table.name).rows - baseline.tables.find(t => t.name === table.name).removableOlderRows, 'WINDOW_COUNT_MISMATCH');
        variant.selectedTables.push({ name: table.name, rows: selected, excluded });
      }
      const proof = store.finish(); variant.buildAndCompactMs = Date.now() - phaseStarted; guard();
      variant.databaseBytes = fs.statSync(file).size; variant.footprint = store.footprint();
      variant.tableBytes = variant.footprint.filter(row => /^cash_\d$/.test(row.name) || row.name === 'snapshot_meta').reduce((n, row) => n + row.bytes, 0);
      variant.otherPagesAndIndexesBytes = variant.databaseBytes - variant.tableBytes;
      console.log(JSON.stringify({ mode, phase: 'verifying_every_value', databaseBytes: variant.databaseBytes }));
      const verifyStarted = Date.now(); variant.verification = store.verify(proof); variant.verifyMs = Date.now() - verifyStarted;
      store.close(); store = null;
      variant.sourceSizeRatio = variant.databaseBytes / sourceBefore.size;
      if (mode === 'window') {
        const archive = path.join(directory, 'window.db.gz'), restore = path.join(directory, 'restored.db'), archiveStarted = Date.now();
        await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 1 }), fs.createWriteStream(archive, { flags: 'wx' }));
        variant.archiveBytes = fs.statSync(archive).size; variant.archiveMs = Date.now() - archiveStarted; guard();
        const restoreStarted = Date.now();
        await pipeline(fs.createReadStream(archive), zlib.createGunzip(), fs.createWriteStream(restore, { flags: 'wx' }));
        assert.equal(sha256File(restore), sha256File(file), 'RESTORE_FILE_HASH'); guard();
        restored = openCashSnapshotPrototype({ file: restore, protection, manifest, readOnly: true });
        variant.restoreVerification = restored.verify(proof); restored.close(); restored = null;
        variant.restoreMs = Date.now() - restoreStarted;
      }
      variant.durationMs = Date.now() - phaseStarted; result.variants.push(variant);
      console.log(JSON.stringify({ mode, phase: 'verified', rows: variant.verification.rows, databaseBytes: variant.databaseBytes, durationMs: variant.durationMs }));
      for (const name of knownFiles.filter(name => name.startsWith(mode + '.'))) clean(name);
    }
    result.peakDirectoryBytes = peakDirectoryBytes; result.peakRssBytes = peakRssBytes;
    result.evidence = { sourceCountReportSha256: sha256File(path.join(root, 'docs/tradefoto-gesamtimport-v0.1/24-MONATE-QUELLENMESSUNG-2026-09-07.json')),
      implementationFiles: ['scripts/measure-cash-history-snapshot.mjs', 'test-support/cash-history-snapshot-prototype.js',
        'scripts/measure-tradefoto-history-window.mjs', 'lib/data-import-protection.js', 'lib/tradefoto-history-profiles.js', 'lib/data-import-contract.js']
        .map(file => ({ file, sha256: sha256File(path.join(root, file)) })) };
  } finally {
    restored?.close(); store?.close(); protection.destroy(); buffer.fill(0);
    for (const name of knownFiles) clean(name);
    assert.equal(fs.readdirSync(directory).length, 0, 'UNEXPECTED_EXPERIMENT_FILE'); fs.rmdirSync(directory);
    const after = fs.statSync(sourcePath);
    assert.ok(after.size === sourceBefore.size && after.mtimeMs === sourceBefore.mtimeMs && after.ctimeMs === sourceBefore.ctimeMs
      && sha256File(sourcePath) === sourceSha256, 'SOURCE_CHANGED');
    if (result) { result.encryptedExperimentFilesRemoved = true; result.ephemeralKeyDestroyed = true; result.sourceUnchanged = true; }
  }
  result.durationMs = Date.now() - started; result.status = 'passed_isolated_storage_comparison';
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, durationMs: result.durationMs, sourceUnchanged: true, experimentFilesRemoved: true }));
}
main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: error.code || 'CASH_SNAPSHOT_EXPERIMENT_FAILED', name: error.name })); process.exitCode = 1; });
