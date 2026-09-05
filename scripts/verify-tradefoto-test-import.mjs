// Block 6: offline, aggregate-only verification. NEVER opens the GP application DB.
// Sources are read only. Encrypted subset exports live only in a fresh temporary
// test database; ephemeral keys are not written to disk. No operational mappings.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import Reader from 'mdb-reader';
import { Database } from '../node_modules/mdb-reader/lib/node/Database.js';
const require = createRequire(import.meta.url);
const C = require('../lib/data-import-contract');
const M = require('../lib/tradefoto-master-profiles');
const H = require('../lib/tradefoto-history-profiles');
const { createDataImportEngine } = require('../lib/data-import-engine');
const { createDataImportProtection } = require('../lib/data-import-protection');
const { createDataImportRepository } = require('../lib/persistence/repositories/data-import');
const { createImportMasterWriters } = require('../lib/persistence/repositories/import-master-data');
const { createImportHistoryWriters } = require('../lib/persistence/repositories/import-history');
const { IMPORT_MASTER_STATEMENTS: MS } = require('../lib/persistence/statements/import-master-data');
const { IMPORT_HISTORY_STATEMENTS: HS } = require('../lib/persistence/statements/import-history');
const { openTradeFotoBlock6Store } = require('../test-support/tradefoto-block6-store');
const [tradeFile, cashFile, reportFile] = process.argv.slice(2);
if (!tradeFile || !cashFile || !reportFile || process.argv.length !== 5) throw new Error('Usage: verify-tradefoto-test-import.mjs TRADE.accdb CASH.accdb NEW-REPORT.json');
const reportPath = path.resolve(reportFile), inputs = [tradeFile, cashFile].map(f => fs.realpathSync(f));
if (fs.existsSync(reportPath) || inputs.some(f => f.toLowerCase() === reportPath.toLowerCase())) throw new Error('Report must be a new file, never a source or existing artifact.');
const catalog = JSON.parse(fs.readFileSync(new URL('../docs/tradefoto-gesamtimport-v0.1/catalog.json', import.meta.url), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const started = Date.now(), time = new Date().toISOString(), batches = [], proofs = [], tables = [];
const report = { format: 'grabenplaner.tradefoto.block6-test.v1', createdAt: time, productionWrites: false, fullProductionImport: false,
  privacy: 'Counts and error codes only. No source field values, passwords, keys, customers or staff names in this report.', sources: proofs, tables,
  independentAccessEngine: false, sourceReportReconciliation: 'pending_confirmed_reports_and_business_rules',
  physicalPageCheck: 'Additional physical slot count using pinned page codec; not an independent Access engine or a proof that deleted/free pages are business records.',
  excludedTables: [], testImport: { type: 'explicit_subset_exports_not_complete_source_manifests', status: 'pending' } };
const receiptKey = row => JSON.stringify(['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'].map(k => row[k]));
const selectedHeads = new Set(), selectedJournals = new Set();
function physicalCounts(buffer, reader, names) {
  const db = new Database(Buffer.from(buffer), ''), format = db.format;
  const objects = reader.getTable('MSysObjects').getData({ columns: ['Id', 'Name', 'Type'] });
  const owners = new Map(objects.filter(o => names.has(o.Name) && (o.Type & 0x7f) === 1).map(o => [o.Id & 0x00ffffff,
    { table: o.Name, dataPages: 0, activeSlots: 0, deletedSlots: 0, overflowSlots: 0 }]));
  for (let page = 1; page < buffer.length / format.pageSize; page++) {
    const bytes = db.getPage(page); if (bytes[0] !== 1) continue;
    const owner = owners.get(bytes.readUInt32LE(4)); if (!owner) continue;
    owner.dataPages++; const n = bytes.readUInt16LE(format.dataPage.recordCountOffset);
    if (format.dataPage.recordCountOffset + 2 + n * 2 > format.pageSize) throw new Error('PHYSICAL_PAGE_INVALID');
    for (let i = 0; i < n; i++) {
      const flags = bytes.readUInt16LE(format.dataPage.recordCountOffset + 2 + i * 2);
      owner[flags & 0x4000 ? 'deletedSlots' : 'activeSlots']++; if (flags & 0x8000) owner.overflowSlots++;
    }
  }
  return [...owners.values()];
}
for (const [index, file] of inputs.entries()) {
  const id = index ? 'cash' : 'trade', expected = catalog.sources.find(s => s.id === id), stat = fs.statSync(file), buffer = fs.readFileSync(file), fileSha256 = hash(buffer);
  if (fileSha256 !== expected.sha256 || stat.size !== expected.bytes) throw new Error('SOURCE_DIFFERS_FROM_PINNED_CATALOG');
  const reader = new Reader(Buffer.from(buffer));
  const physical = physicalCounts(buffer, reader, new Set(id === 'trade' ? ['ARTIKEL_STAMM', 'ARTIKEL_FILIALEN'] : ['Umsatz_KASSE', 'Umsatz_Kasse_Details']));
  const sourceProof = { id, fileSha256, bytes: stat.size, unchangedAfterRead: false, physical }; proofs.push(sourceProof);
  const definitions = [...(id === 'trade' ? M.TRADEFOTO_MASTER_METADATA.tables.map(t => ({ ...t, master: true })) : []),
    ...H.TRADEFOTO_HISTORY_METADATA.tables.filter(t => t.source === id).sort((a, b) =>
      (a.name === 'Umsatz_KASSE' || a.name === 'KassenJournal' ? -1 : 0) - (b.name === 'Umsatz_KASSE' || b.name === 'KassenJournal' ? -1 : 0))];
  report.excludedTables.push(...expected.tables.filter(t => !definitions.some(d => d.name === t.name)).map(t => ({ source: id, table: t.name,
    rows: t.scannedRows, reason: 'legacy_access_credentials_configuration_or_technical_archive_not_activated' })));
  for (const definition of definitions) {
    const { name, master } = definition, table = reader.getTable(name), pinned = expected.tables.find(t => t.name === name);
    if (!C.equal(table.getColumnNames(), definition.columns.map(c => c.name))) throw new Error('SCHEMA_COLUMNS_CHANGED');
    const profile = master ? M.profileFor(name) : H.profileFor(id, name), columns = definition.columns.filter(c => !c.excluded).map(c => c.name);
    const rows = table.getData({ columns }), selected = [], errors = {}, keys = new Set();
    const sourceTextReview = { rows: 0, longTextRows: 0, controlCharacterRows: 0, fields: {} };
    let sampledLongText = false, sampledControlText = false;
    let valid = 0, duplicateKeys = 0, conflictingKeys = 0; const payloads = new Map();
    for (let ordinal = 0; ordinal < rows.length; ordinal++) {
      try {
        const prepared = master ? M.prepareTradeFotoMasterRow(name, rows[ordinal], { fileSha256, rowNumber: ordinal + 1 })
          : H.prepareTradeFotoHistoryRow(id, name, rows[ordinal], { fileSha256, rowNumber: ordinal + 1 });
        const normalized = C.normalizeDataImportRow(profile, prepared); valid++;
        let longText = false, controlText = false;
        for (const field of profile.fields.filter(f => f.type === 'source_text')) {
          const value = normalized.source[field.source]; if (value === null) continue;
          const long = Buffer.byteLength(value) > C.LIMITS.textBytes, control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
          if (long || control) { sourceTextReview.fields[field.source] = (sourceTextReview.fields[field.source] || 0) + 1; longText ||= long; controlText ||= control; }
        }
        if (longText || controlText) sourceTextReview.rows++;
        if (longText) sourceTextReview.longTextRows++; if (controlText) sourceTextReview.controlCharacterRows++;
        const key = C.canonical(normalized.key);
        if (definition.keys) {
          const payloadHash = C.fingerprint(normalized.data);
          if (keys.has(key)) { duplicateKeys++; if (payloads.get(key) !== payloadHash) conflictingKeys++; } else { keys.add(key); payloads.set(key, payloadHash); }
        }
        let take = selected.length < 12;
        if (master && ((longText && !sampledLongText) || (controlText && !sampledControlText))) {
          take = true; sampledLongText ||= longText; sampledControlText ||= controlText;
        }
        if (id === 'cash' && name === 'Umsatz_KASSE') { take = selected.length < 60; if (take) selectedHeads.add(receiptKey(normalized.source)); }
        if (id === 'cash' && name === 'Umsatz_Kasse_Details') take = selectedHeads.has(receiptKey(normalized.source));
        if (id === 'cash' && name === 'KassenJournal' && take) selectedJournals.add(String(normalized.source.Vorgang));
        if (id === 'cash' && name === 'KassenJournal_Details') take = selectedJournals.has(String(normalized.source.Vorgang));
        if (take) selected.push({ row: Object.fromEntries(Object.entries(normalized.source).filter(([k]) => !k.startsWith('_source_'))), ordinal: ordinal + 1 });
      } catch (error) {
        if (!(error instanceof C.DataImportError)) throw new Error('SOURCE_VALIDATION_FAILED');
        errors[error.code] = (errors[error.code] || 0) + 1;
      }
    }
    const check = { source: id, table: name, declared: table.rowCount, catalogRead: pinned.scannedRows, read: rows.length, valid,
      rejected: rows.length - valid, errors, duplicateKeys, conflictingKeys, sourceTextReview, sampled: selected.length };
    tables.push(check); if (selected.length) batches.push({ id, name, master, profile, selected });
    console.log(JSON.stringify(check));
  }
  sourceProof.unchangedAfterRead = hash(fs.readFileSync(file)) === fileSha256 && fs.statSync(file).mtimeMs === stat.mtimeMs;
  if (!sourceProof.unchangedAfterRead) throw new Error('SOURCE_CHANGED_DURING_READ');
}
const taskTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'grabenplaner-tradefoto-block6-'));
if (!taskTemp.toLowerCase().startsWith(path.join(os.tmpdir(), 'grabenplaner-tradefoto-block6-').toLowerCase())) throw new Error('TEMP_SCOPE_INVALID');
const databasePath = path.join(taskTemp, 'isolated-encrypted-test.db');
const encryptionKey = crypto.randomBytes(32), indexKey = crypto.randomBytes(32);
const protection = createDataImportProtection({ encryptionKey, indexKey, keyId: 'ephemeral-test-only' }); encryptionKey.fill(0); indexKey.fill(0);
const actor = { scopeId: 'isolated-block6', ownerId: 'test-only' }, authorize = () => true;
const writers = { ...createImportMasterWriters({ protection }), ...createImportHistoryWriters({ protection, authorize, resolveMasterSourceInstance: () => 'test-subset-trade' }) };
let app, engine, restarted = false;
const runs = [];
function open() {
  app = openTradeFotoBlock6Store(databasePath);
  engine = createDataImportEngine({ repository: createDataImportRepository(app.provider), protection, profiles: [...M.TRADEFOTO_MASTER_PROFILES, ...H.TRADEFOTO_HISTORY_PROFILES],
    writers, getActor: () => actor, authorize, clock: () => time });
}
async function close() { if (app) { await app.close(); app = null; } }
function counts() { return app.counts(); }
try {
  open(); report.testImport.before = counts(); let verifiedRows = 0, repeated = 0;
  for (const batch of batches) {
    // A bounded sample is its OWN explicit export, never declared to be the full
    // ACCDB. Fresh encrypted export bytes prevent publishing row-value hashes.
    const fileSha256 = hash(protection.seal(batch.selected, ['test-subset-export', batch.id, batch.name]));
    const manifest = { sourceInstance: 'test-subset-' + batch.id, fileSha256, schemaSha256: batch.profile.schemaSha256,
      expectedRows: batch.selected.length, declaredRows: batch.selected.length, snapshotAt: time, gates: [] };
    const rows = batch.selected.map(({ row, ordinal }) => batch.master ? M.prepareTradeFotoMasterRow(batch.name, row, { fileSha256, rowNumber: ordinal })
      : H.prepareTradeFotoHistoryRow(batch.id, batch.name, row, { fileSha256, rowNumber: ordinal }));
    let run = await engine.start({ profileHash: batch.profile.fingerprint, manifest });
    for (let i = 0; i < rows.length; i += C.LIMITS.batch) run = await engine.stage(run.id, { expectedRevision: run.revision, startRow: i + 1, rows: rows.slice(i, i + C.LIMITS.batch) });
    if (!restarted) { await close(); open(); restarted = true; }
    run = await engine.seal(run.id, run.revision);
    do { run = await engine.review(run.id, run.revision); } while (run.status === 'reviewing');
    if (run.status !== 'ready') { report.testImport.reviewRequired = { source: batch.id, table: batch.name, counts: run.counts }; throw new Error('SUBSET_REVIEW_REQUIRED'); }
    do { run = await engine.apply(run.id, run.revision); } while (run.status === 'applying');
    runs.push(run);
    const before = counts(), repeat = await engine.start({ profileHash: batch.profile.fingerprint, manifest });
    if (repeat.id !== run.id || repeat.status !== 'applied' || !C.equal(before, counts())) throw new Error('REPEAT_CHANGED_COUNTS'); repeated++;
    const context = { ...actor, sourceInstance: manifest.sourceInstance, sourceSystem: batch.profile.sourceSystem, sourceTable: batch.name, profileHash: batch.profile.fingerprint,
      runId: run.id, at: time, fileSha256, snapshotAt: time };
    await app.provider.transaction(async tx => {
      for (const row of rows) {
        const normalized = C.normalizeDataImportRow(batch.profile, row);
        const identityHash = batch.master ? M.masterIdentity(protection, context, batch.name, normalized.key) : H.historyIdentity(protection, context, batch.id, batch.name, normalized.key);
        const record = await tx.queryOne(batch.master ? MS.find : HS.find, { identityHash, scopeId: actor.scopeId });
        const actual = record ? await writers[batch.profile.entity].read(tx, record.id, context) : null;
        if (!actual || !C.equal(actual.data, normalized.data)) throw new Error('ROUNDTRIP_FIELD_MISMATCH'); verifiedRows++;
      }
    }, { isolation: 'serializable' });
  }
  report.testImport.after = counts(); report.testImport.verifiedRows = verifiedRows; report.testImport.repeatedRuns = repeated;
  // Source references can point to a table imported later. Respect the real
  // dependency graph: undo leaves first; never force-delete reference holds.
  let pending = runs.reverse(); report.testImport.undoDependencyDeferrals = 0;
  while (pending.length) {
    const deferred = [];
    for (const saved of pending) {
      try {
        let run = await engine.preview(saved.id);
        do { run = await engine.undo(run.id, run.revision); } while (run.status === 'reverting');
        if (run.status !== 'reverted') throw new Error('UNDO_INCOMPLETE');
      } catch (error) {
        if (error.code !== 'IMPORT_UNDO_DEPENDENCIES') throw error;
        deferred.push(saved); report.testImport.undoDependencyDeferrals++;
      }
    }
    if (deferred.length === pending.length) throw new Error('UNDO_DEPENDENCY_CYCLE_REQUIRES_REVIEW');
    pending = deferred;
  }
  report.testImport.afterUndo = counts();
  if (['import_master_records', 'import_history_records', 'import_history_versions', 'import_master_holds'].some(k => report.testImport.afterUndo[k] !== 0)) throw new Error('UNDO_RETAINED_TARGET');
  Object.assign(report.testImport, app.verify());
  report.testImport.restartBeforeApply = restarted; report.testImport.status = 'passed';
} catch (error) { report.testImport.status = 'failed'; report.testImport.error = /^[A-Z_]+$/u.test(error.code || error.message) ? (error.code || error.message) : 'TEST_IMPORT_FAILED'; process.exitCode = 1; }
finally {
  await close(); protection.destroy();
  // This exact fresh test directory contains only generated artifacts. Source
  // paths and application/workspace roots are never cleanup targets.
  if (path.dirname(taskTemp).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(taskTemp).startsWith('grabenplaner-tradefoto-block6-')) throw new Error('TEMP_SCOPE_INVALID');
  fs.rmSync(taskTemp, { recursive: true }); report.testImport.ephemeralFilesRemoved = true;
}
report.summary = { tables: tables.length, read: tables.reduce((n, t) => n + t.read, 0), rejected: tables.reduce((n, t) => n + t.rejected, 0),
  rowCountDifferences: tables.filter(t => t.declared !== t.read).map(t => ({ source: t.source, table: t.table, declared: t.declared, read: t.read })),
  productionReady: false, durationMs: Date.now() - started };
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ summary: report.summary, testImport: report.testImport }));
