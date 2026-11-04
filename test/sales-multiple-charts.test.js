'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('../lib/sales-report-model'), { createSalesAnalysisPdf } = require('../lib/sales-analysis-pdf');
const context = { today: '2026-10-31', locations: [{ id: '18', label: 'Beispielfiliale' }], projection: { read: true, margin: true, customers: true, marginCustomers: true } };
function fixture(style, orientation, timeline = true) {
  const query = M.normalizeReportQuery({ sourceId: 'compact-cash', reportVersion: 4, dateFrom: '2026-10-01', dateTo: '2026-10-12',
    metrics: M.METRICS.map(m => m.id), chartMetrics: M.METRICS.map(m => m.id), chartType: timeline ? 'timeline' : 'bars',
    groupBy: timeline ? [] : ['location'], orientation, ...(timeline ? { chartStyle: style, timeGrain: 'day' } : {}) }, context);
  const state = M.accumulator();
  for (let n = 1; n <= 12; n++) {
    if (n === 5) continue;
    const net = n === 9 ? '-30' : String(50 + n * 7);
    const line = { date: '2026-10-' + String(n).padStart(2, '0'), metric: { status: n === 9 ? 'return' : 'sale', net, gross: String(Number(net) * 1.2) },
      quantity: n === 9 ? '-1' : '1', margin: String(Number(net) * 0.2), receiptKey: 'receipt-' + n, customerKey: n % 2 ? 'customer-' + n : null, location: context.locations[0] };
    M.accumulate(state, 'current', query, line); if (!timeline) M.accumulate(state, 'comparison', query, line);
  }
  return { title: 'Verkaufsanalysen · Alle Kennzahlen · Synthetische Beispiele', query, report: M.finishReport(state, query), completedAt: '2026-11-02T12:00:00.000Z',
    metadata: { ...context, dimensions: M.DIMENSIONS, source: { label: 'Synthetische Beispieldaten', coverageLabel: 'Keine produktiven Verkaufszahlen' }, marginStatus: 'confirmed', productGroups: [], manufacturers: [], sellers: [] } };
}
test('multiple diagram choices round-trip without altering old queries or bypassing metric rights', () => {
  const q = fixture('studio', 'portrait').query;
  assert.deepEqual(M.normalizeReportQuery(q, context), q);
  const report = fixture('studio', 'portrait').report;
  assert.equal(report.timelines.length, M.METRICS.length);
  const marginRate = report.timelines.find(t => t.metric === 'marginRate');
  assert.equal(marginRate.series[0].points[0].value, '20.00'); assert.equal(marginRate.series[0].points[4].value, null);
  assert.equal(marginRate.series[0].points[8].value, null);
  for (const patch of [{ chartMetrics: [] }, { chartMetrics: ['invented'] }, { chartMetrics: ['netRevenue'], metrics: ['quantity'] }, { chartStyle: 'invented' }])
    assert.throws(() => M.normalizeReportQuery({ ...q, ...patch }, context));
  assert.throws(() => M.normalizeReportQuery(q, { ...context, projection: { read: true } }), { code: 'IMPORT_FORBIDDEN' });
  const old = { ...q }; delete old.chartMetrics; delete old.chartStyle;
  const normalized = M.normalizeReportQuery(old, context); assert.equal(Object.hasOwn(normalized, 'chartMetrics'), false); assert.equal(Object.hasOwn(normalized, 'chartStyle'), false);
});
for (const orientation of ['portrait', 'landscape']) for (const style of ['classic', 'studio', 'aurora', 'editorial', 'pulse']) {
  test(`all ten metrics in one ${orientation} ${style} graphic PDF keep separate axes, missing data and page bounds`, async () => {
    const input = fixture(style, orientation), buffer = await createSalesAnalysisPdf(input);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await loading.promise;
    try {
      assert.ok(pdf.numPages >= 11 && pdf.numPages <= 12);
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), size = page.getViewport({ scale: 1 }), content = await page.getTextContent();
        const text = content.items.map(i => i.str).join(' ');
        if (n <= M.METRICS.length) assert.ok(text.includes(M.METRICS[n - 1].label), `metric ${n} missing`);
        for (const item of content.items.filter(i => i.str?.trim())) {
          const [a, b, , , x, y] = item.transform;
          assert.ok(x >= 20 && x <= size.width - 20 && y >= 14 && y <= size.height - 25, `origin outside page: ${item.str}`);
          if (Math.abs(b) < 0.001) assert.ok(x + item.width <= size.width - 20, `horizontal overflow: ${item.str}`);
          else assert.ok(Math.abs(a) < 0.001 && y + item.width <= size.height - 25, `axis overflow: ${item.str}`);
        }
      }
      if (process.env.SALES_MULTI_PREVIEW_DIR) { const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_MULTI_PREVIEW_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.SALES_MULTI_PREVIEW_DIR, `${style}-${orientation}.pdf`), buffer); }
    } finally { await loading.destroy(); }
  });
}
test('table report emits a separate overview for every requested metric including unavailable values', async () => {
  const input = fixture('classic', 'landscape', false);
  input.report.rows[0].metrics.grossMargin.current = null;
  const buffer = await createSalesAnalysisPdf(input), { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await loading.promise;
  try {
    const pages = []; for (let i = 1; i <= pdf.numPages; i++) pages.push((await (await pdf.getPage(i)).getTextContent()).items.map(t => t.str).join(' '));
    for (const metric of M.METRICS) assert.ok(pages.some(text => text.includes(metric.label + ' · Übersicht')), metric.label);
  } finally { await loading.destroy(); }
});
