'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const Issues = require('../lib/sales-report-receipt-issues');
const { CASH_SNAPSHOT_TABLES } = require('../lib/persistence/statements/cash-snapshots');
const { readCheckedCashReportBatch, readCashReportReceiptIssues, START } = require('../lib/persistence/repositories/checked-cash-report-batch');
const name = t => CASH_SNAPSHOT_TABLES.find(table => table.name === t).sqlName;

test('head-only and undated receipts are found across complete pages without mixing datasets or dates', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const head = name('Umsatz_KASSE'), line = name('Umsatz_Kasse_Details');
    db.exec(`CREATE TABLE ${head}(dataset_slot INTEGER,source_row INTEGER,business_date TEXT);
      CREATE TABLE ${line}(dataset_slot INTEGER,parent_row INTEGER);`);
    const insert = db.prepare(`INSERT INTO ${head} VALUES(?,?,?)`);
    for (let i = 1; i <= 405; i++) insert.run(1, i, i <= 203 ? '2026-02-01' : null);
    insert.run(1, 406, '2026-01-01'); insert.run(2, 1, '2026-02-01');
    // A child from another dataset must not hide this head. A real child
    // suppresses a dated head but cannot make an undated head disappear.
    db.exec(`INSERT INTO ${line} VALUES(2,1),(1,2),(1,405);`);
    const query = db.prepare(Issues.CATALOG[0].sql);
    const params = { datasetSlot: 1, dateFrom: '2026-02-01', dateTo: '2026-02-28', afterDate: '9999-12-31', afterRow: 10000000, limit: 201 };
    const rows = [], pages = [];
    for (;;) {
      const page = query.all(params); pages.push(page.length); rows.push(...page);
      if (page.length < params.limit) break;
      params.afterDate = page.at(-1).businessDate; params.afterRow = page.at(-1).sourceRow;
    }
    assert.deepEqual(pages, [201, 201, 2]);
    assert.equal(rows.length, 404); assert.equal(new Set(rows.map(r => r.sourceRow)).size, 404);
    assert.ok(rows.some(r => r.sourceRow === 1)); assert.ok(!rows.some(r => r.sourceRow === 2 || r.sourceRow === 406));
    assert.equal(rows.filter(r => r.businessDate === null).length, 202);
    const sql = Issues.postgresql()[0].sql;
    assert.match(sql, /kassa\."cash_snapshot_1"/); assert.match(sql, /kassa\."cash_snapshot_6"/);
    assert.match(sql, /IS NOT DISTINCT FROM/); assert.match(sql, /NULLS LAST/);
  } finally { db.close(); }
});

function backendFor(checked) {
  const head = { table: 'Umsatz_KASSE', fields: { Bonnr: '7' }, provenance: { businessDate: '2026-02-01' } };
  const detail = { table: 'Umsatz_Kasse_Details', fields: { RepID: 'line-1', Bonnr: '7' }, references: [],
    provenance: { businessDate: '2026-02-01', parentId: 'head-1' } };
  return {
    search: async () => [{ id: 'line-1', businessDate: '2026-02-01' }],
    reportReceiptIssueCandidates: async (tx, query, onCandidate) => onCandidate({ id: 'head-1', businessDate: '2026-02-01' }),
    service: () => ({ detail: async id => id === 'head-1' ? head : detail, receipt: async () => checked })
  };
}
test('ordinary business reviews remain reportable while source coverage, policy and identity failures stop the report', async () => {
  const options = { tx: {}, query: { locationIds: ['18'] }, cursor: START, projection: {}, marginPolicy: null };
  const known = ['STATUS_REVIEW_REQUIRED', 'VAT_CODE_UNKNOWN', 'RECEIPT_AMOUNT_MISMATCH', 'RECEIPT_INVOICE_REFERENCE_MISMATCH'];
  const lines = [];
  await readCheckedCashReportBatch({ ...options, backend: backendFor({ canAggregate: false, issues: known }), onLine: l => lines.push(l) });
  assert.equal(lines[0].metric, null); assert.deepEqual(lines[0].reviewIssues, known);
  const heads = [];
  await readCashReportReceiptIssues({ ...options, backend: backendFor({ canAggregate: false, issues: ['RECEIPT_WITHOUT_LINES'] }), onReceipt: h => heads.push(h) });
  assert.equal(heads.length, 1);
  for (const issue of ['RECEIPT_SOURCE_COVERAGE_UNCONFIRMED', 'RECEIPT_SOURCE_COVERAGE_MISMATCH', 'STALE_RECEIPT_PARENT_REVISION', 'SALES_SEMANTICS_UNCONFIRMED', 'RECEIPT_LINE_KEY_MISMATCH', 'UNRECOGNISED_FUTURE_ERROR']) {
    const backend = backendFor({ canAggregate: false, issues: [...known, issue] });
    await assert.rejects(readCheckedCashReportBatch({ ...options, backend, onLine: () => assert.fail('untrusted row') }), { code: 'IMPORT_HISTORY_INTEGRITY' });
    await assert.rejects(readCashReportReceiptIssues({ ...options, backend, onReceipt: () => assert.fail('untrusted head') }), { code: 'IMPORT_HISTORY_INTEGRITY' });
  }
  await assert.rejects(readCheckedCashReportBatch({ ...options, backend: backendFor({ canAggregate: true, positions: [] }), onLine: () => {} }), { code: 'IMPORT_HISTORY_INTEGRITY' });
});
