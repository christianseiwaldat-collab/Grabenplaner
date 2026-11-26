'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Issues = require('../lib/sales-report-receipt-issues');
const { readCheckedCashReportBatch, readCashReportReceiptIssues, START } = require('../lib/persistence/repositories/checked-cash-report-batch');

test('receipt-issue paging uses native PostgreSQL snapshot tables and a null-safe cursor', () => {
  const sql = Issues.postgresql()[0].sql;
  assert.match(sql, /kassa\."cash_snapshot_1"/);
  assert.match(sql, /kassa\."cash_snapshot_6"/);
  assert.match(sql, /IS NOT DISTINCT FROM/);
  assert.match(sql, /NULLS LAST/);
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
