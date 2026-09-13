'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('../lib/sales-report-model');
const { createSalesAnalysisPdf } = require('../lib/sales-analysis-pdf');
function fixture(orientation, kind) {
  const metadata = { locations: [{ id: '18', label: 'Filiale 18 (Beispiel)' }], merchandiseGroups: [{ id: '13', label: 'Foto und Video' }],
    productGroups: [{ id: '130', label: 'Systemkameras' }], manufacturers: [], sellers: [], dimensions: M.DIMENSIONS,
    source: { label: 'Synthetische Beispieldaten', coverageLabel: 'Keine produktiven Verkaufszahlen' } };
  const query = M.normalizeReportQuery({ reportVersion: 4, sourceId: 'compact-cash', dateFrom: '2026-01-01', dateTo: '2026-09-13',
    chartType: 'timeline', orientation, timeGrain: kind === 'daily' ? 'day' : 'week', groupBy: [], merchandiseGroupIds: ['13'], productGroupIds: ['130'],
    metrics: [kind === 'ratio' ? 'marginRate' : 'netRevenue'], chartMetric: kind === 'ratio' ? 'marginRate' : 'netRevenue' },
    { today: '2026-09-13', locations: metadata.locations, projection: { read: true, margin: true } });
  const state = M.accumulator();
  if (kind !== 'empty') for (let n = 0; n < 256; n++) {
    if (n >= 150 && n < 165) continue;
    const amount = (kind === 'negative' && n % 17 < 5 ? -1 : 1) * Math.round(270 + n * 3 + Math.sin(n / 15) * 260);
    const date = new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
    M.accumulate(state, 'current', query, { date, metric: n === 130 ? null : { status: amount < 0 ? 'return' : 'sale', gross: String(amount * 1.2), net: String(amount) },
      quantity: amount < 0 ? '-1' : '1', margin: String(amount * 0.24), receiptKey: 'synthetic-' + n, customerKey: null,
      merchandiseGroup: metadata.merchandiseGroups[0], productGroup: metadata.productGroups[0], location: metadata.locations[0] });
  }
  return { title: 'Umsatz im Zeitverlauf · Systemkameras · Beispieldaten', query, metadata, report: M.finishReport(state, query), completedAt: '2026-09-13T21:00:00.000Z' };
}
for (const [orientation, kind] of [['landscape', 'daily'], ['landscape', 'weekly'], ['portrait', 'negative'], ['landscape', 'ratio'], ['portrait', 'empty']]) {
  test(`timeline PDF ${orientation}/${kind} retains selection, missing values and text inside every page`, async () => {
    const input = fixture(orientation, kind), buffer = await createSalesAnalysisPdf(input);
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-'); assert.ok(buffer.length < 12 * 1024 * 1024);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await loading.promise;
    try {
      assert.equal(pdf.numPages, 2); let all = '';
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), size = page.getViewport({ scale: 1 }), content = await page.getTextContent();
        assert.equal(size.width > size.height, orientation === 'landscape');
        for (const item of content.items.filter(i => i.str?.trim())) {
          const [a, b, , , x, y] = item.transform;
          assert.ok(x >= 20 && x <= size.width - 20 && y >= 14 && y <= size.height - 25, `text origin outside page ${n}: ${item.str}`);
          if (Math.abs(b) < 0.001) assert.ok(x + item.width <= size.width - 20, `horizontal overflow: ${item.str}`);
          else assert.ok(Math.abs(a) < 0.001 && y + item.width <= size.height - 25, `rotated axis overflow: ${item.str}`);
        }
        const dates = content.items.filter(i => /^\d{2}\.\d{2}\.$/.test(i.str)).sort((a, b) => a.transform[4] - b.transform[4]);
        for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1].transform[4] + dates[i - 1].width + 2 < dates[i].transform[4], 'adjacent date ticks overlap');
        const text = content.items.map(i => i.str).join(' '); assert.match(text, new RegExp(`Seite ${n} / 2`)); all += '\n' + text;
      }
      assert.match(all, /Warengruppen \(WGR\): Foto und Video/); assert.match(all, /Sortimentsgruppen: Systemkameras/);
      assert.match(all, /Keine produktiven Verkaufszahlen/); assert.match(all, /01.01.2026 bis 13.09.2026/);
      assert.match(all, /keine Quelldaten/); if (kind === 'empty') assert.match(all, /keine vollständig auswertbaren Werte/);
      if (kind === 'ratio') assert.match(all, /Rohertrag in % vom Nettoumsatz/);
      if (process.env.SALES_TIMELINE_PREVIEW_DIR) {
        const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_TIMELINE_PREVIEW_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SALES_TIMELINE_PREVIEW_DIR, `timeline-${orientation}-${kind}.pdf`), buffer);
      }
    } finally { await loading.destroy(); }
  });
}
