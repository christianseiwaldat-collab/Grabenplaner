'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSalesAnalysisPdf } = require('../lib/sales-analysis-pdf');
const M = require('../lib/sales-report-model');

function fixture(groups, negative = false, presentation = {}) {
  const metadata = { locations: [{ id: '18', label: 'Filiale 18 (synthetisch)' }], productGroups: [], manufacturers: [], sellers: [],
    dimensions: M.DIMENSIONS, source: { label: 'Synthetischer Kassenstand', coverageLabel: 'Testdaten' }, projection: { customers: true }, marginStatus: 'unconfirmed' };
  const query = M.normalizeReportQuery({ sourceId: 'compact-cash', dateFrom: '2026-08-01', dateTo: '2026-08-31', groupBy: ['manufacturer'],
    metrics: ['netRevenue','grossMargin','receiptCount','revenuePerCustomer'], chartMetric: 'netRevenue', ...presentation },
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

for (const [orientation, chartType, negative, reportVersion = 3] of [['landscape', 'shares', false], ['landscape', 'shares', true], ['portrait', 'none', false], ['landscape', 'none', false, 4]])
  test(`presentation v${reportVersion} ${orientation}/${chartType}, returns=${negative} preserves every value, page bounds and chart choice`, async () => {
    const input = fixture(10, negative, { reportVersion, orientation, chartType });
    const buffer = await createSalesAnalysisPdf(input);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await loading.promise;
    try {
      const text = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
        assert.equal(viewport.width > viewport.height, orientation === 'landscape');
        for (const item of content.items.filter(i => i.str?.trim())) {
          assert.ok(item.transform[4] >= 39 && item.transform[4] + item.width <= viewport.width - 38, `horizontal overflow page ${n}: ${item.str}`);
          assert.ok(item.transform[5] >= 39 && item.transform[5] <= viewport.height - 32, `vertical overflow page ${n}: ${item.str}`);
        }
        text.push(content.items.map(t => t.str).join(' '));
        assert.match(text.at(-1), new RegExp(`Seite ${n} / ${pdf.numPages}`)); page.cleanup();
      }
      const all = text.join('\n');
      for (let i = 0; i < 10; i++) assert.match(all, new RegExp(`Hersteller ${i} ·`));
      if (reportVersion === 4) { assert.match(all, /Warengruppen \(WGR\):/); assert.match(all, /Sortimentsgruppen:/); }
      if (chartType === 'none') assert.doesNotMatch(all, /Anteile im Auswertungszeitraum|Übersicht|Skala:/);
      else if (negative) { assert.match(all, /als Balkendiagramm dargestellt/); assert.doesNotMatch(all, /Anteile im Auswertungszeitraum/); }
      else { assert.match(all, /Anteile im Auswertungszeitraum/); assert.doesNotMatch(all, /als Balkendiagramm dargestellt/); }
      if (process.env.SALES_REPORT_PDF_PREVIEW_DIR && chartType !== 'none') {
        const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, `sales-analysis-${orientation}-${negative ? 'returns' : chartType}.pdf`), buffer);
      }
    } finally { await loading.destroy(); }
  });

for (const orientation of ['portrait', 'landscape']) test(`partial manufacturer values remain visible and labelled in ${orientation} PDF without false shares or comparisons`, async () => {
  const input = fixture(0, false, { reportVersion: 3, orientation, chartType: 'shares' });
  input.title = 'Herstellervergleich mit offenen Belegen (synthetisch)';
  const state = M.accumulator(), line = (id, metric, extra = {}) => ({ manufacturer: { id, label: id === 'sony' ? 'Sony' : id === 'canon' ? 'Canon' : 'Nur offene Belege' },
    metric, quantity: '1', margin: null, receiptKey: id, customerKey: null, ...extra });
  M.accumulate(state, 'current', input.query, line('sony', { status: 'sale', net: '100.00', gross: '120.00' }));
  M.accumulate(state, 'current', input.query, line('sony', null, { reviewIssues: ['STATUS_REVIEW_REQUIRED', 'RECEIPT_AMOUNT_MISMATCH'] }));
  M.accumulate(state, 'comparison', input.query, line('sony', { status: 'sale', net: '50.00', gross: '60.00' }));
  M.accumulate(state, 'current', input.query, line('canon', { status: 'sale', net: '200.00', gross: '240.00' }));
  M.accumulate(state, 'comparison', input.query, line('canon', { status: 'sale', net: '100.00', gross: '120.00' }));
  M.accumulate(state, 'current', input.query, line('open', null, { reviewIssues: ['VAT_CODE_UNKNOWN'] }));
  input.report = M.finishReport(state, input.query);
  const buffer = await createSalesAnalysisPdf(input), { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await loading.promise;
  try {
    const text = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
      text.push(content.items.map(i => i.str).join(' '));
      for (const item of content.items.filter(i => i.str?.trim())) {
        assert.ok(item.transform[4] >= 39 && item.transform[4] + item.width <= viewport.width - 38, `horizontal overflow page ${n}`);
        assert.ok(item.transform[5] >= 39 && item.transform[5] <= viewport.height - 32, `vertical overflow page ${n}`);
      }
      page.cleanup();
    }
    const all = text.join('\n');
    assert.match(all, /100,00\s*€\s*\*/); assert.match(all, /300,00\s*€\s*\*/);
    assert.match(all, /Sony · aktuell \*/); assert.match(all, /unvollständigem Datenstand/);
    assert.match(all, /1 Gruppe ohne auswertbaren aktuellen Wert steht/); assert.doesNotMatch(all, /Anteile im Auswertungszeitraum/);
    assert.match(all, /Offene Belegprüfungen/); assert.match(all, /Verkaufsstatus, Belegsumme/); assert.match(all, /MwSt.-Zuordnung/);
    assert.match(all, /1 \/ 1/); assert.match(all, /Nur offene Belege/);
    assert.match(text[0], /Vergleich: 2 passende Positionen/, 'both coverage notes stay on the overview page');
    const details = text.find(page => page.startsWith('GRABENPLANER') && page.includes('Umsatz netto · Detailwerte'));
    assert.match(details, /Sony\s+100,00\s*€\s*\*\s+50,00\s*€\s+Nicht verfügbar\s+Nicht verfügbar/);
    if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
      const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, `sales-analysis-partial-${orientation}.pdf`), buffer);
    }
  } finally { await loading.destroy(); }
});

for (const partial of [false, true]) test(`939 seller/product-group combinations and six metrics, partial=${partial}, fit without losing values or reducing font size`, async () => {
  const input = fixture(0);
  input.metadata.marginStatus = 'confirmed';
  input.query.groupBy = ['seller', 'productGroup'];
  input.query.metrics = ['netRevenue', 'quantity', 'receiptCount', 'grossMargin', 'revenuePerReceipt', 'marginRate'];
  const state = M.accumulator();
  for (let i = 0; i < 939; i++) for (const phase of ['current', 'comparison']) {
    const line = {
    metric: { status: 'sale', net: phase === 'current' ? '12345.67' : '9876.54', gross: '14814.80' },
    margin: i % 11 ? '2345.67' : null, quantity: '123.000001', receiptKey: `r${i}`, customerKey: null,
    manufacturer: { id: 'm1', label: 'Testmarke' }, location: input.metadata.locations[0],
    seller: { id: `s${Math.floor(i / 100)}`, label: `MA ${String(Math.floor(i / 100)).padStart(3, '0')}` },
    productGroup: { id: `g${i}`, label: `WGR / Sortiment ${String(i).padStart(4, '0')} - Testartikel` }
    };
    M.accumulate(state, phase, input.query, line);
    if (partial) M.accumulate(state, phase, input.query, { ...line, metric: null, reviewIssues: ['RECEIPT_AMOUNT_MISMATCH'] });
  }
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
    for (const value of ['12345,67', '9876,54', ...(partial ? [] : ['2469,13']), '123,000001', 'Nichtverfügbar']) assert.ok(compact.includes(value), `missing value ${value}`);
    if (partial) { assert.match(all, /Offene Belegprüfungen/); assert.match(all, /Belegsumme/); assert.ok(compact.includes('12345,67€*')); }
    if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
      const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, `sales-analysis-939${partial ? '-partial' : ''}.pdf`), buffer);
    }
  } finally { await loading.destroy(); }
});
