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

test('939 seller/product-group combinations and six metrics fit without losing values or reducing font size', async () => {
  const input = fixture(0);
  input.metadata.marginStatus = 'confirmed';
  input.query.groupBy = ['seller', 'productGroup'];
  input.query.metrics = ['netRevenue', 'quantity', 'receiptCount', 'grossMargin', 'revenuePerReceipt', 'marginRate'];
  const state = M.accumulator();
  for (let i = 0; i < 939; i++) for (const phase of ['current', 'comparison']) M.accumulate(state, phase, input.query, {
    metric: { status: 'sale', net: phase === 'current' ? '12345.67' : '9876.54', gross: '14814.80' },
    margin: i % 11 ? '2345.67' : null, quantity: '123.000001', receiptKey: `r${i}`, customerKey: null,
    manufacturer: { id: 'm1', label: 'Testmarke' }, location: input.metadata.locations[0],
    seller: { id: `s${Math.floor(i / 100)}`, label: `MA ${String(Math.floor(i / 100)).padStart(3, '0')}` },
    productGroup: { id: `g${i}`, label: `WGR / Sortiment ${String(i).padStart(4, '0')} - Testartikel` }
  });
  input.report = M.finishReport(state, input.query);
  const buffer = await createSalesAnalysisPdf(input);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await loading.promise;
  try {
    assert.ok(pdf.numPages <= 250);
    const text = []; let fullSizeValues = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), content = await page.getTextContent();
      text.push(content.items.map(t => t.str).join(' '));
      for (const item of content.items.filter(i => i.str?.trim())) {
        assert.ok(item.transform[4] >= 39 && item.transform[4] + item.width <= 557, `horizontal overflow page ${n}`);
        assert.ok(item.transform[5] >= 39 && item.transform[5] <= 809, `vertical overflow page ${n}`);
        if (/12345,67/.test(item.str.replace(/[.\s]/g, '')) && item.transform[0] === 8.5) fullSizeValues++;
      }
      assert.match(text.at(-1), new RegExp(`Seite ${n} / ${pdf.numPages}`)); page.cleanup();
    }
    const all = text.join('\n');
    assert.ok(fullSizeValues >= 939, 'all detail values retain the original 8.5 point font');
    for (let i = 0; i < 939; i++) assert.ok(all.split(`WGR / Sortiment ${String(i).padStart(4, '0')}`).length >= 7, `missing metric group ${i}`);
    const compact = all.replace(/[.\s]/g, '');
    for (const value of ['12345,67', '9876,54', '2469,13', '123,000001', 'Nichtverfügbar']) assert.ok(compact.includes(value), `missing value ${value}`);
    if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
      const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, 'sales-analysis-939.pdf'), buffer);
    }
  } finally { await loading.destroy(); }
});
