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
test('WGR and assortment selections apply jointly without guessing a parent from its number', () => {
  const q = query({ reportVersion: 4, merchandiseGroupIds: ['13'], productGroupIds: ['1'], groupBy: ['merchandiseGroup', 'productGroup'] });
  assert.deepEqual(query(q), q);
  const s = M.accumulator();
  M.accumulate(s, 'current', q, line({ merchandiseGroup: { id: '13', label: 'Foto' } }));
  M.accumulate(s, 'current', q, line({ merchandiseGroup: { id: '12', label: 'Andere WGR' } }));
  M.accumulate(s, 'current', q, line({ merchandiseGroup: { id: '13', label: 'Foto' }, productGroup: { id: '2', label: 'Anderes Sortiment' } }));
  M.accumulate(s, 'current', q, line());
  const result = M.finishReport(s, q); assert.equal(result.total.metrics.netRevenue.current, '100.00'); assert.equal(result.coverage.current.checked, 1);
  assert.deepEqual(result.rows[0].dimensions.map(d => d.id), ['13', '1']);
  assert.throws(() => query({ reportVersion: 3, merchandiseGroupIds: ['13'] }), { code: 'IMPORT_REPORT_SELECTION' });
  assert.throws(() => query({ reportVersion: 4, merchandiseGroupIds: Array.from({ length: 11 }, (_, i) => String(i)) }), { code: 'IMPORT_REPORT_SELECTION' });
});

test('timeline intervals preserve partial months, Monday weeks and leap days', () => {
  assert.deepEqual(M.timelineIntervals({ dateFrom: '2024-02-28', dateTo: '2024-03-01', timeGrain: 'day' }).map(i => i.from), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(M.timelineIntervals({ dateFrom: '2026-01-01', dateTo: '2026-01-06', timeGrain: 'week' }), [
    { id: '2025-12-29', from: '2026-01-01', to: '2026-01-04' }, { id: '2026-01-05', from: '2026-01-05', to: '2026-01-06' }
  ]);
  assert.deepEqual(M.timelineIntervals({ dateFrom: '2026-01-15', dateTo: '2026-02-03', timeGrain: 'month' }), [
    { id: '2026-01-01', from: '2026-01-15', to: '2026-01-31' }, { id: '2026-02-01', from: '2026-02-01', to: '2026-02-03' }
  ]);
});

test('timeline ratios use weighted totals, retain returns and distinguish missing days from known zero selections', () => {
  const q = query({ reportVersion: 4, chartType: 'timeline', timeGrain: 'day', groupBy: [], sellerIds: ['42'], chartMetric: 'marginRate' });
  const s = M.accumulator();
  M.accumulate(s, 'current', q, line({ date: '2026-02-01' }));
  M.accumulate(s, 'current', q, line({ date: '2026-02-01', metric: { status: 'sale', gross: '360.00', net: '300.00' }, margin: '120.00', receiptKey: 'other' }));
  M.accumulate(s, 'current', q, line({ date: '2026-02-02', seller: { id: '43' } }));
  M.accumulate(s, 'current', q, line({ date: '2026-02-04', metric: { status: 'return', gross: '-120.00', net: '-100.00' }, quantity: '-1', margin: '-20.00' }));
  M.accumulate(s, 'current', q, line({ date: '2026-02-05', metric: null, reviewIssues: ['RECEIPT_AMOUNT_MISMATCH'] }));
  M.accumulate(s, 'current', q, line({ date: '2026-02-06', margin: null }));
  const finish = metric => M.finishReport(JSON.parse(JSON.stringify(s)), { ...q, chartMetric: metric }).timeline.series[0].points;
  const ratio = finish('marginRate'), revenue = finish('netRevenue');
  assert.equal(ratio[0].value, '35.00'); assert.equal(ratio[1].value, null); assert.equal(ratio[1].hasSource, true);
  assert.equal(revenue[1].value, '0.00'); assert.equal(revenue[2].value, null); assert.equal(revenue[2].hasSource, false);
  assert.equal(revenue[3].value, '-100.00'); assert.equal(ratio[3].value, null);
  assert.equal(revenue[4].value, null); assert.equal(revenue[4].review, 1);
  assert.equal(ratio[5].value, null); assert.equal(ratio[5].missingMargin, 1);
  assert.deepEqual(query(q), q); assert.throws(() => query({ reportVersion: 4, chartType: 'timeline', timeGrain: 'hour' }));
  assert.throws(() => query({ reportVersion: 4, chartType: 'timeline', groupBy: ['seller', 'location'] }));
});

test('confirmed cash margin multiplies unit margin by quantity before rounding, preserving return signs and precision', () => {
  assert.equal(M.positionMargin('8.141666666666667', '2'), '16.28');
  assert.equal(M.positionMargin('17.86844166666667', '1'), '17.87');
  assert.equal(M.positionMargin('8.141666666666667', '-2'), '-16.28');
  assert.equal(M.positionMargin('0.004999999', '2000000'), '10000.00');
  assert.equal(M.positionMargin('-0.005', '1'), '-0.01');
  assert.equal(M.positionMargin(null, '2'), null);
});

test('separate branch graphics do not turn another branch source day into a confirmed zero', () => {
  const q = query({ reportVersion: 4, chartType: 'timeline', timeGrain: 'day', groupBy: ['location'], chartMetric: 'netRevenue' }), s = M.accumulator();
  M.accumulate(s, 'current', q, line({ date: '2026-02-01', location: { id: 'a', label: 'A' } }));
  M.accumulate(s, 'current', q, line({ date: '2026-02-02', location: { id: 'b', label: 'B' } }));
  const series = M.finishReport(JSON.parse(JSON.stringify(s)), q).timeline.series;
  assert.equal(series[0].points[0].value, '100.00'); assert.equal(series[0].points[1].value, null); assert.equal(series[0].points[1].hasSource, false);
  assert.equal(series[1].points[0].value, null); assert.equal(series[1].points[1].value, '100.00');
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
