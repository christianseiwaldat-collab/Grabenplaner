// Read-only capacity analysis. This is not an import, deletion or retention job.
// Only aggregate counters leave the process; linked Access tables are not opened.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { definitions, assertSourceBytes } = require('../lib/tradefoto-full-import-source');
const { sha256File } = require('../lib/file-integrity');
const root = path.resolve(import.meta.dirname, '..');

export function historyWindow(asOfDay, months = 24) {
  assert.match(asOfDay, /^\d{4}-\d{2}-\d{2}$/);
  const end = new Date(asOfDay + 'T00:00:00.000Z');
  assert.equal(end.toISOString().slice(0, 10), asOfDay, 'INVALID_AS_OF_DAY');
  assert.ok(end.getUTCFullYear() >= 1900 && Number.isSafeInteger(months) && months > 0 && months <= 120);
  const start = new Date(end);
  start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - months);
  const monthEnd = new Date(start); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1); monthEnd.setUTCDate(0);
  start.setUTCDate(Math.min(end.getUTCDate(), monthEnd.getUTCDate()));
  end.setUTCDate(end.getUTCDate() + 1);
  return { months, asOfDay, fromInclusive: start.toISOString().slice(0, 10), toExclusive: end.toISOString().slice(0, 10),
    anchor: 'explicit_supplied_business_snapshot_day', clockDrivenExpiry: false };
}
export function classifyCivilDate(value, window) {
  // mdb-reader Date UTC components encode Access civil time, not UTC instants.
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getUTCFullYear() < 1900) return 'unknown';
  const day = value.toISOString().slice(0, 10);
  if (day < window.fromInclusive) return 'older';
  return day < window.toExclusive ? 'within' : 'future';
}
export function journalSelection(headState, lineCounts) {
  // Preserve whole journal groups; old supporting rows are not period turnover.
  if (headState === 'within' || lineCounts.within > 0) return 'within';
  if (headState !== 'older' || lineCounts.unknown > 0 || lineCounts.future > 0) return 'review';
  return 'older';
}
const emptyCounts = () => ({ within: 0, older: 0, unknown: 0, future: 0 });
const sum = counts => Object.values(counts).reduce((a, b) => a + b, 0);
const dateFields = {
  trade: {
    FiL_Umsatz: ['LDatum'], Rechnung_Export: ['Anlegedatum'], Rechnungsdetails_Export: ['Lieferscheindatum'],
    tblProtBestand: ['Aenderung'], tblProtBestand_comp: ['Aenderung'], tblProtPreis: ['Aenderung'],
    Transfer_Alte_Umsatz_Kasse: ['Bondatum'], Transfer_Alte_Umsatz_Kasse_Details: ['Bondatum'],
    Verkauf_Artikel: ['vkdatum'], WE_Kontrolle: ['WEDatum'], Lagerumschlag: ['Enddatum'],
    // Activity dates only. A warranty date is not the business transaction date.
    Export_Reparatur: ['Anlegedatum', 'KVDatum', 'ReklamationDatum', 'RepAuftragDatum', 'AbzuholenDatum',
      'AbgeholtDatum', 'Bezahlt_Datum', 'AbholNachrichtDatum'],
  },
  cash: { Umsatz_KASSE: ['Bondatum'], Umsatz_Kasse_Details: ['Bondatum'], Tagesbericht: ['Bondatum'],
    KassenJournal: ['Datum'], KassenJournal_Details: ['Datum'] },
};
const receiptFields = ['Bonnr', 'Filialid', 'Kassenid', 'Bondatum'];
const receiptKey = row => JSON.stringify(receiptFields.map(name => row[name] instanceof Date ? row[name].toISOString() : row[name]));

async function measureSource(kind, file, window, baseline) {
  const started = Date.now(), before = fs.statSync(file), sha256 = sha256File(file);
  assert.equal(sha256, baseline.fileSha256, 'SOURCE_HASH_CHANGED');
  const buffer = fs.readFileSync(file); assertSourceBytes(buffer);
  const result = { kind, fileName: path.basename(file), bytes: buffer.length, sha256, tables: [] };
  const receiptHeads = new Map(), journalHeads = new Map(), journalLines = new Map();
  const relations = { receiptLines: 0, receiptOrphans: 0, selectedReceiptOrphans: 0, journalOrphans: 0 };
  let unchanged = false;
  try {
    const MDBReader = (await import('mdb-reader')).default;
    const reader = new MDBReader(buffer);
    for (const def of definitions(kind)) {
      const expected = baseline.tables.find(t => t.name === def.name);
      assert.ok(expected, 'UNMEASURED_TABLE');
      const table = reader.getTable(def.name), fields = dateFields[kind][def.name];
      assert.deepEqual(table.getColumnNames(), def.columns.map(c => c.name), 'SOURCE_SCHEMA_CHANGED');
      let columns = fields || [];
      if (kind === 'cash' && def.name.startsWith('Umsatz_')) columns = receiptFields;
      if (kind === 'cash' && def.name.startsWith('KassenJournal')) columns = ['Vorgang', 'Datum'];
      const counts = emptyCounts(); let readRows = 0;
      for (let offset = 0; offset < expected.received; offset += 10000) {
        const limit = Math.min(10000, expected.received - offset);
        const rows = table.getData({ columns, rowOffset: offset, rowLimit: limit });
        assert.equal(rows.length, limit, 'SOURCE_ROW_COUNT_CHANGED'); readRows += rows.length;
        for (const row of rows) {
          const present = (fields || []).map(name => row[name]).filter(value => value != null);
          const states = present.map(value => classifyCivilDate(value, window));
          const state = states.includes('future') ? 'future' : states.includes('unknown') ? 'unknown'
            : states.includes('within') ? 'within' : states.length ? 'older' : 'unknown';
          if (fields) counts[state]++;
          if (kind !== 'cash') continue;
          if (def.name === 'Umsatz_KASSE') {
            const key = receiptKey(row); assert.ok(!receiptHeads.has(key), 'DUPLICATE_RECEIPT_HEAD'); receiptHeads.set(key, state);
          } else if (def.name === 'Umsatz_Kasse_Details') {
            relations.receiptLines++;
            const parent = receiptHeads.get(receiptKey(row));
            if (!parent) relations.receiptOrphans++;
            if (state === 'within' && parent !== 'within') relations.selectedReceiptOrphans++;
          } else if (def.name === 'KassenJournal') {
            assert.ok(row.Vorgang != null && !journalHeads.has(row.Vorgang), 'INVALID_JOURNAL_HEAD');
            journalHeads.set(row.Vorgang, state);
          } else if (def.name === 'KassenJournal_Details') {
            if (!journalHeads.has(row.Vorgang)) relations.journalOrphans++;
            const group = journalLines.get(row.Vorgang) || emptyCounts(); group[state]++; journalLines.set(row.Vorgang, group);
          }
        }
      }
      assert.equal(table.getData({ columns: [], rowOffset: expected.received, rowLimit: 1 }).length, 0, 'EXTRA_SOURCE_ROW');
      assert.equal(readRows, expected.received);
      result.tables.push({ name: def.name, group: def.group, master: def.master, rows: readRows,
        handling: fields ? 'business_activity_date_candidate' : def.master ? 'retain_master_data'
          : def.group === 'inventory.branch_snapshot' ? 'retain_current_inventory_snapshot'
          : def.group === 'inventory.legacy_aggregates' ? 'retain_pending_interval_semantics_review' : 'retain_reference_or_undated_data',
        dateFields: fields || [], dateCounts: fields ? counts : null,
        removableOlderRows: fields ? counts.older : 0,
        reviewDateRows: fields ? counts.unknown + counts.future : 0 });
      console.log(JSON.stringify({ phase: 'read_only_window_count', kind, table: def.name, rows: readRows, elapsedMs: Date.now() - started }));
    }
    if (kind === 'cash') {
      assert.equal(relations.receiptOrphans, 0, 'SOURCE_RECEIPT_ORPHANS');
      assert.equal(relations.selectedReceiptOrphans, 0, 'WINDOW_BREAKS_RECEIPT');
      assert.equal(relations.journalOrphans, 0, 'SOURCE_JOURNAL_ORPHANS');
      const groups = { within: 0, older: 0, review: 0, olderSupportingHeads: 0, olderSupportingLines: 0 };
      const headTable = result.tables.find(t => t.name === 'KassenJournal');
      const lineTable = result.tables.find(t => t.name === 'KassenJournal_Details');
      headTable.removableOlderRows = 0; lineTable.removableOlderRows = 0;
      for (const [key, state] of journalHeads) {
        const lines = journalLines.get(key) || emptyCounts(), selection = journalSelection(state, lines); groups[selection]++;
        if (selection === 'older') { headTable.removableOlderRows++; lineTable.removableOlderRows += sum(lines); }
        if (selection === 'within') {
          groups.olderSupportingHeads += Number(state === 'older'); groups.olderSupportingLines += lines.older;
        }
      }
      headTable.handling = lineTable.handling = 'complete_journal_groups_with_uncertain_groups_retained_for_review';
      result.relations = { ...relations, journalGroups: groups };
    }
    result.rows = result.tables.reduce((n, t) => n + t.rows, 0);
    result.removableOlderRows = result.tables.reduce((n, t) => n + t.removableOlderRows, 0);
    result.retainedOrReviewRows = result.rows - result.removableOlderRows;
    result.rowReductionPercent = 100 * result.removableOlderRows / result.rows;
    result.snapshotRowsRetained = result.tables.filter(t => t.group === 'inventory.branch_snapshot').reduce((n, t) => n + t.rows, 0);
    result.masterRowsRetained = result.tables.filter(t => t.master).reduce((n, t) => n + t.rows, 0);
    assert.equal(result.rows, baseline.tables.reduce((n, t) => n + t.received, 0), 'BASELINE_ROW_COUNT_MISMATCH');
  } finally {
    buffer.fill(0); receiptHeads.clear(); journalHeads.clear(); journalLines.clear();
    const after = fs.statSync(file);
    unchanged = before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && sha256File(file) === sha256;
    assert.ok(unchanged, 'SOURCE_CHANGED_DURING_READ');
  }
  return { ...result, sourceUnchanged: unchanged, durationMs: Date.now() - started };
}
async function main() {
  assert.equal(process.argv.length, 6, 'Usage: measure-tradefoto-history-window.mjs TRADE.accdb CASH.accdb AS_OF_DAY REPORT.json');
  const [, , tradeFile, cashFile, asOfDay, output] = process.argv;
  const out = path.resolve(output); assert.ok(!fs.existsSync(out), 'REPORT_ALREADY_EXISTS');
  const baselineFile = path.join(root, 'tmp/tradefoto-block3-2Ap4l0/report.json');
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  assert.equal(baseline.status, 'passed_full_import_and_backup_measurement');
  const window = historyWindow(asOfDay), sources = [], started = Date.now();
  for (const [kind, file] of [['trade', tradeFile], ['cash', cashFile]]) {
    sources.push(await measureSource(kind, fs.realpathSync(file), window, baseline.sources.find(s => s.kind === kind)));
    global.gc?.();
  }
  const rows = sources.reduce((n, s) => n + s.rows, 0), removableOlderRows = sources.reduce((n, s) => n + s.removableOlderRows, 0);
  const report = { format: 'grabenplaner.tradefoto.history-window-analysis.v1', measuredAt: new Date().toISOString(),
    productionWrites: false, sourceWrites: false, importPerformed: false, runtimeFilterImplemented: false,
    window, sources, totals: { rows, removableOlderRows, retainedOrReviewRows: rows - removableOlderRows,
      rowReductionPercent: 100 * removableOlderRows / rows },
    databaseBytes: null, archiveBytes: null, capacityApproved: false,
    limitations: ['Source row reduction is not a measured storage reduction.',
      'Master data, inventory snapshots, references and uncertain date/group semantics are conservatively retained.',
      'Older supporting records must not be counted as turnover inside the selected period.',
      'Source completeness and selected import coverage require separate manifests before runtime filtering.'],
    evidence: { baselineReportSha256: sha256File(baselineFile), scriptSha256: sha256File(fileURLToPath(import.meta.url)) },
    durationMs: Date.now() - started };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ phase: 'complete', totals: report.totals, durationMs: report.durationMs }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: error.code || 'ANALYSIS_FAILED', name: error.name })); process.exitCode = 1; });
}
