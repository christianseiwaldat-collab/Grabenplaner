'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('../lib/sales-report-model');
const context = { today: '2026-09-09', projection: { read: true, company: true, sellers: true, customers: true, margin: true, marginCustomers: true }, locations: [{ id: 'a' }, { id: 'b' }] };
const query = extra => M.normalizeReportQuery({ sourceId: 'compact-cash', dateFrom: '2026-02-01', dateTo: '2026-02-28', metrics: M.METRICS.map(m => m.id), ...extra }, context);
function line(extra = {}) { return { metric: { status: 'sale', gross: '120.00', net: '100.00' }, quantity: '1', margin: '20.00',
  receiptKey: 'receipt-1', customerKey: 'customer-1', productGroup: { id: '1', label: 'Systemkameras' }, manufacturer: { id: 'canon', label: 'Canon' }, location: { id: 'a', label: 'A' }, seller: { id: '42', label: 'MA 42' }, ...extra }; }
test('new PDF presentation choices and ten-item limits are validated without changing saved version-two queries', () => {
  const ten = Array.from({ length: 10 }, (_, i) => String(i));
  const input = { reportVersion: 3, orientation: 'landscape', chartType: 'shares', productGroupIds: ten, manufacturerIds: ten };
  const normalized = query(input);
  assert.equal(normalized.orientation, 'landscape'); assert.equal(normalized.chartType, 'shares');
  assert.deepEqual(query(normalized), normalized); assert.equal(M.isPdfReportQuery(normalized), true);
  for (const bad of [{ orientation: 'square' }, { chartType: 'timeline' }, { productGroupIds: [...ten, '11'] }, { manufacturerIds: [...ten, '11'] }])
    assert.throws(() => query({ ...input, ...bad }), { code: 'IMPORT_REPORT_SELECTION' });
  const old = query({ productGroupIds: [...ten, '11'], manufacturerIds: [...ten, '11'] });
  assert.equal(old.reportVersion, 2); assert.equal(Object.hasOwn(old, 'orientation'), false);
  assert.deepEqual(query(old), old); assert.throws(() => query({ chartType: 'bars' }), { code: 'IMPORT_REPORT_SELECTION' });
});
test('confirmed cash margin multiplies unit margin by quantity before rounding, preserving return signs and precision', () => {
  assert.equal(M.positionMargin('8.141666666666667', '2'), '16.28');
  assert.equal(M.positionMargin('17.86844166666667', '1'), '17.87');
  assert.equal(M.positionMargin('8.141666666666667', '-2'), '-16.28');
  assert.equal(M.positionMargin('0.004999999', '2000000'), '10000.00');
  assert.equal(M.positionMargin('-0.005', '1'), '-0.01');
  assert.equal(M.positionMargin(null, '2'), null);
});
test('calendar-year comparison clamps leap days, preserves custom dates and rejects invalid ranges/rights', () => {
  assert.equal(M.previousYear('2024-02-29'), '2023-02-28');
  assert.equal(query().comparisonFrom, '2025-02-01'); assert.deepEqual(query().locationIds, ['a','b']);
  assert.equal(query({ comparisonFrom: '2023-03-01', comparisonTo: '2023-03-05' }).comparisonFrom, '2023-03-01');
  for (const input of [{ dateFrom: '2026-02-30' }, { dateTo: '2027-01-01' }, { dateFrom: '2024-01-01' }, { metrics: [] }, { groupBy: ['privateCustomer'] }]) assert.throws(() => query(input));
  assert.throws(() => query({ locationIds: ['private'] }), { code: 'IMPORT_FORBIDDEN' });
  assert.throws(() => M.normalizeReportQuery({ ...query(), sellerIds: ['42'] }, { ...context, projection: { ...context.projection, sellers: false } }), { code: 'IMPORT_FORBIDDEN' });
  assert.throws(() => M.normalizeReportQuery(query(), { ...context, projection: { ...context.projection, margin: false } }), { code: 'IMPORT_FORBIDDEN' });
});
test('sums reconcile and distinct customers/receipts are not added across groups; anonymous turnover is not divided by known customers', () => {
  const state = M.accumulator(), q = query();
  M.accumulate(state, 'current', q, line());
  M.accumulate(state, 'current', q, line({ manufacturer: { id: 'nikon', label: 'Nikon' }, receiptKey: 'receipt-1' }));
  M.accumulate(state, 'current', q, line({ customerKey: null, receiptKey: 'receipt-2' }));
  M.accumulate(state, 'comparison', q, line());
  const r = M.finishReport(JSON.parse(JSON.stringify(state)), q);
  assert.equal(r.total.metrics.netRevenue.current, '300.00'); assert.equal(r.total.metrics.grossMargin.current, '60.00');
  assert.equal(r.total.metrics.customerCount.current, '1'); assert.equal(r.total.metrics.receiptCount.current, '2');
  assert.equal(r.total.metrics.revenuePerCustomer.current, '200.00'); assert.equal(r.total.metrics.marginPerCustomer.current, '40.00');
  assert.equal(r.total.metrics.netRevenue.absolute, '200.00'); assert.equal(r.total.metrics.netRevenue.percent, '200.00');
  assert.equal(r.rows.length, 2); assert.equal(r.coverage.current.anonymousReceipts, 1);
});
test('unknown source periods, unverified receipts and missing margin never produce fabricated totals', () => {
  const state = M.accumulator(), q = query();
  M.accumulate(state, 'current', q, line({ margin: null }));
  let result = M.finishReport(state, q);
  assert.equal(result.total.metrics.netRevenue.previous, null); assert.equal(result.total.metrics.netRevenue.percent, null);
  assert.equal(result.total.metrics.grossMargin.current, null); assert.equal(result.total.metrics.marginRate.current, null);
  M.accumulate(state, 'current', q, line({ metric: null })); result = M.finishReport(state, q);
  assert.equal(result.total.metrics.netRevenue.current, null); assert.equal(result.total.metrics.customerCount.current, null);
});
test('one unreconciled receipt retains explicitly separate verified subtotals, never full totals or changes', () => {
  const state = M.accumulator(), q = query({ groupBy: ['manufacturer'] });
  M.accumulate(state, 'current', q, line());
  M.accumulate(state, 'current', q, line({ metric: null, reviewIssues: ['STATUS_REVIEW_REQUIRED', 'RECEIPT_AMOUNT_MISMATCH'], receiptKey: 'open' }));
  M.accumulate(state, 'comparison', q, line({ metric: { status: 'sale', gross: '60.00', net: '50.00' } }));
  const r = M.finishReport(JSON.parse(JSON.stringify(state)), q), money = r.rows[0].metrics.netRevenue;
  assert.equal(money.current, null); assert.equal(money.verifiedCurrent, '100.00'); assert.equal(money.previous, '50.00');
  assert.equal(money.absolute, null); assert.equal(money.percent, null); assert.equal(money.verifiedPrevious, undefined);
  assert.equal(r.total.metrics.netRevenue.current, null); assert.equal(r.total.metrics.netRevenue.verifiedCurrent, '100.00');
  assert.equal(r.rows[0].metrics.quantity.verifiedCurrent, '1.000000'); assert.equal(r.rows[0].metrics.receiptCount.verifiedCurrent, '1');
  assert.deepEqual(r.rows[0].quality.current, { records: 2, checked: 1, review: 1, excluded: 0, marginMissing: 0,
    issues: { STATUS_REVIEW_REQUIRED: 1, RECEIPT_AMOUNT_MISMATCH: 1 } });
});
test('verified subtotals preserve returns, incomplete margins and the absence of checked positions', () => {
  const state = M.accumulator(), q = query({ groupBy: ['manufacturer'] });
  M.accumulate(state, 'current', q, line({ metric: { status: 'return', gross: '-120.00', net: '-100.00' }, quantity: '-1', margin: null }));
  M.accumulate(state, 'current', q, line({ metric: null }));
  M.accumulate(state, 'comparison', q, line({ metric: null }));
  const r = M.finishReport(state, q), money = r.rows[0].metrics.netRevenue;
  assert.equal(money.verifiedCurrent, '-100.00'); assert.equal(money.verifiedPrevious, undefined);
  assert.equal(r.rows[0].metrics.quantity.verifiedCurrent, '-1.000000');
  assert.equal(r.rows[0].metrics.grossMargin.verifiedCurrent, undefined);
  assert.equal(r.rows[0].metrics.customerCount.previous, null);
  assert.equal(r.rows[0].metrics.receiptCount.verifiedPrevious, undefined);
  assert.equal(money.percent, null); assert.equal(money.absolute, null);
});
test('manufacturer/WGR/MA multiselect applies jointly; returns and decimals keep exact signs', () => {
  const state = M.accumulator(), q = query({ manufacturerIds: [' CANON '], productGroupIds: ['1'], sellerIds: ['42'], locationIds: ['a'] });
  M.accumulate(state, 'current', q, line());
  M.accumulate(state, 'current', q, line({ metric: { status: 'return', gross: '-120.00', net: '-100.00' }, quantity: '-1', margin: '-20.00', receiptKey: 'receipt-2' }));
  M.accumulate(state, 'current', q, line({ seller: { id: '43', label: 'Other MA' } }));
  M.accumulate(state, 'comparison', q, line());
  const r = M.finishReport(state, q); assert.equal(r.total.metrics.netRevenue.current, '0.00'); assert.equal(r.total.metrics.quantity.current, '0.000000');
  assert.equal(r.total.metrics.netRevenue.percent, '-100.00'); assert.equal(r.coverage.current.selectedRecords, 2);
  assert.deepEqual(M.comparison('5.00', '0.00'), { absolute: '5.00', percent: null });
  assert.equal(M.scaled('-1.005'), -101n); assert.equal(M.scaled('999999999999999999.999'), 100000000000000000000n);
});
