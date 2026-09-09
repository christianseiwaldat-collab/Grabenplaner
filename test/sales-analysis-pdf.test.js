'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSalesAnalysisPdf } = require('../lib/sales-analysis-pdf');
const M = require('../lib/sales-report-model');

function fixture(groups, negative = false) {
  const metadata = { locations: [{ id: '18', label: 'Filiale 18 (synthetisch)' }], productGroups: [], manufacturers: [], sellers: [],
    dimensions: M.DIMENSIONS, source: { label: 'Synthetischer Kassenstand', coverageLabel: 'Testdaten' }, projection: { customers: true }, marginStatus: 'unconfirmed' };
  const query = M.normalizeReportQuery({ sourceId: 'compact-cash', dateFrom: '2026-08-01', dateTo: '2026-08-31', groupBy: ['manufacturer'],
    metrics: ['netRevenue','grossMargin','receiptCount','revenuePerCustomer'], chartMetric: 'netRevenue' },
  { today: '2026-09-09', projection: { read: true, company: true, margin: true, customers: true }, locations: metadata.locations });
  const state = M.accumulator();
  for (let i = 0; i < groups; i++) for (const phase of ['current', 'comparison']) M.accumulate(state, phase, query, {
    metric: { status: 'sale', net: String((phase === 'current' ? 100 : 80) * (negative && i === 0 ? -1 : 1)), gross: '120' }, margin: null, quantity: '1',
    receiptKey: 'r' + i, customerKey: i % 2 ? null : 'c' + i, manufacturer: { id: 'm' + i, label: `Hersteller ${i} · ÄÖÜ & Zubehör mit längerer vollständiger Bezeichnung` },
    productGroup: { id: '130', label: 'Systemkameras' }, location: metadata.locations[0], seller: { id: '7', label: 'MA 7' } });
  return { title: 'Systemkameras · Herstellervergleich (Test)', query, metadata, report: M.finishReport(state, query), completedAt: '2026-09-09T12:00:00.000Z' };
}
for (const [count, negative] of [[5, false], [65, true]]) test(`PDF with ${count} groups preserves text, comparison, unknown margins and page bounds`, async () => {
  const buffer = await createSalesAnalysisPdf(fixture(count, negative));
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-'); assert.ok(buffer.length < 12 * 1024 * 1024);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await loading.promise;
  try {
    const text = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), content = await page.getTextContent();
      text.push(content.items.map(t => t.str).join(' '));
      for (const item of content.items.filter(i => i.str?.trim())) {
        assert.ok(item.transform[4] >= 39 && item.transform[4] + item.width <= 557, `horizontal overflow page ${n}: ${item.str}`);
        assert.ok(item.transform[5] >= 39 && item.transform[5] <= 809, `vertical overflow page ${n}: ${item.str}`);
      }
      assert.match(text.at(-1), new RegExp(`Seite ${n} / ${pdf.numPages}`)); page.cleanup();
    }
    const all = text.join('\n'); assert.match(all, /Nicht verfügbar/); assert.match(all, /2025-08-01/); assert.match(all, /Kundenanzahl zählt/);
    for (let i = 0; i < count; i++) assert.match(all, new RegExp(`Hersteller ${i} ·`));
    assert.ok(pdf.numPages >= 6); if (negative) assert.match(all, /Fortsetzung/);
    if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
      const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, `sales-analysis-${count}.pdf`), buffer);
    }
  } finally { await loading.destroy(); }
});
