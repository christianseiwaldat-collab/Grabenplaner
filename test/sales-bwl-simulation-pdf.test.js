'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const M = require('../lib/sales-bwl-simulation-model'), Pdf = require('../lib/sales-bwl-simulation-pdf');
const caps = { read: true, prices: true, costs: true, margin: true };
function fixture(count = 85, options = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: 'row-' + i, articleNumber: 'SIM-' + String(i).padStart(5, '0'), description: 'BEISPIEL Fernglas ' + i,
    assortment: 'Abverkauf', location: 'BEISPIEL Filiale', locationId: '18', quantity: '4', eligible: true,
    status: 'Vollständig', retailGross: i % 11 ? '120' : null, retailNet: i % 11 ? '100' : null, averageCost: '70' }));
  return M.calculate(rows, M.normalize({ filters: { locations: ['18'], assortment: 'sellout' }, assumptions: options.assumptions || { additionalCosts: '5' } }, caps), caps,
    { sourceAt: '2026-10-08T12:00:00.000Z', sourceFingerprint: 'a'.repeat(64), generatedAt: '2026-10-09T12:00:00.000Z' });
}
async function read(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'), task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await task.promise;
  try { const pages = [], metadata = await pdf.getMetadata();
    for (let index = 1; index <= pdf.numPages; index++) { const page = await pdf.getPage(index), content = await page.getTextContent();
      pages.push({ width: page.view[2], height: page.view[3], items: content.items, text: content.items.map(item => item.str).join(' ') }); }
    return { pages, metadata };
  } finally { await task.destroy(); }
}
test('simulation PDF accepts only a pinned server selector and at most eight allowed columns', () => {
  const input = { snapshotToken: 'server-token', columns: ['articleNumber', 'description', 'scenarioNetRevenue'], title: ' Mein Szenario ', name: '../Mein:Szenario.pdf' };
  const spec = Pdf.normalize(input, caps); assert.equal(spec.title, 'Mein Szenario'); assert.equal(spec.name, 'Mein-Szenario.pdf'); assert.equal(spec.orientation, 'landscape');
  assert.equal(Pdf.normalize({ variantId: '76f78930-1cef-4b23-8c52-4c417da6ba46', version: 2 }, caps).version, 2);
  for (const change of [{ rows: [] }, { snapshot: {} }, { snapshotToken: '' }, { snapshotToken: 'x'.repeat(16385) },
    { variantId: '76f78930-1cef-4b23-8c52-4c417da6ba46', version: 1 }, { version: 1 }, { comparisonVariantId: 'bad' }, { comparisonVersion: 2 },
    { columns: [] }, { columns: ['articleNumber', 'articleNumber'] }, { columns: M.COLUMNS.slice(0, 9).map(c => c.id) }, { columns: ['private'] },
    { orientation: 'A3' }, { title: 'a\nHidden' }, { name: null }, { sort: 'private' }, { direction: 'up' }]) assert.throws(() => Pdf.normalize({ ...input, ...change }, caps));
  assert.throws(() => Pdf.normalize({ snapshotToken: 'x', columns: ['scenarioGrossMargin'] }, { read: true, prices: true, costs: false, margin: false }), { status: 403 });
  assert.throws(() => Pdf.normalize({ variantId: '76f78930-1cef-4b23-8c52-4c417da6ba46', version: 1, comparisonVariantId: '76f78930-1cef-4b23-8c52-4c417da6ba46', comparisonVersion: 1 }, caps));
});
test('simulation PDF formats rounded display decimals exactly and sorts numeric values without number coercion', () => {
  assert.equal(Pdf.decimalText('9007199254740991.025', 'money'), '9.007.199.254.740.991,03 EUR');
  assert.equal(Pdf.decimalText('-0.005', 'money'), '-0,01 EUR'); assert.equal(Pdf.decimalText('1.12345678'), '1,123457');
  assert.equal(Pdf.cell({ scenarioNetRevenue: null }, M.COLUMNS.find(c => c.id === 'scenarioNetRevenue')), 'Prüfen');
  const rows = [{ id: 'b', scenarioNetRevenue: '9007199254740991.02' }, { id: 'a', scenarioNetRevenue: '9007199254740991.03' }, { id: 'n', scenarioNetRevenue: null }];
  assert.deepEqual(Pdf.sortedRows(rows, 'scenarioNetRevenue', 'asc').map(r => r.id), ['b', 'a', 'n']);
  assert.deepEqual(Pdf.sortedRows(rows, 'scenarioNetRevenue', 'desc').map(r => r.id), ['a', 'b', 'n']); assert.deepEqual(rows.map(r => r.id), ['b', 'a', 'n']);
});
test('simulation PDF has true A4 portrait/landscape, comparison provenance and assumptions, complete main table and valid page bounds', async () => {
  const snapshot = fixture(), comparison = { name: 'BEISPIEL Vergleichsvariante', version: 3, snapshot: fixture(20, { assumptions: { discountPercent: '30', sellThroughPercent: '80', horizonDays: 90, additionalCosts: '12' } }) };
  const title = 'BEISPIEL - Ferngläser-Szenario';
  for (const orientation of ['portrait', 'landscape']) {
    const spec = Pdf.normalize({ snapshotToken: 'server-token', title, name: 'BEISPIEL-Simulation-' + orientation, orientation,
      columns: ['articleNumber', 'description', 'location', 'quantity', 'scenarioQuantity', 'scenarioNetRevenue', 'scenarioGrossMargin', 'status'], sort: 'articleNumber', direction: 'desc' }, caps);
    const result = await Pdf.render({ spec, snapshot, variant: { name: 'BEISPIEL Hauptvariante', version: 2 }, comparison, generatedAt: '2026-10-09T12:00:00.000Z' }), parsed = await read(result.buffer);
    assert.equal(result.pages, parsed.pages.length); assert.equal(result.rows, 85); assert.equal(parsed.metadata.info.Title, title); assert.ok(result.pages > 3);
    const text = parsed.pages.map(p => p.text).join(' '), items = parsed.pages.flatMap(p => p.items);
    assert.match(text, /BEISPIEL Hauptvariante/); assert.match(text, /BEISPIEL Vergleichsvariante/); assert.match(text, /Version 3/); assert.match(text, /30 %/); assert.match(text, /90 Tage/);
    assert.match(text, /Gespeicherter Stand - unverändert exportiert/); assert.match(text, /bekannter Teilbetrag/); assert.match(text, /ungeprüfte Zeile/);
    assert.match(text, /Keine Preisänderung oder Liquiditätsprognose/); assert.match(text, /vollständige Haupttabelle/);
    for (const row of snapshot.rows) assert.equal(items.filter(item => item.str === row.articleNumber).length, 1, orientation + ': ' + row.articleNumber);
    assert.equal(items.find(item => /^SIM-\d{5}$/.test(item.str)).str, 'SIM-00084');
    for (const page of parsed.pages) {
      assert.ok(Math.abs(page.width - (orientation === 'portrait' ? 595.28 : 841.89)) < .1); assert.ok(Math.abs(page.height - (orientation === 'portrait' ? 841.89 : 595.28)) < .1);
      for (const item of page.items.filter(i => i.str)) {
        assert.ok(item.transform[4] >= 31.5 && item.transform[4] + item.width <= page.width - 31, orientation + ': x bounds ' + item.str);
        assert.ok(item.transform[5] >= 16 && item.transform[5] <= page.height - 23, orientation + ': y bounds ' + item.str);
      }
    }
    if (process.env.SIMULATION_PDF_PREVIEW_DIR) { fs.mkdirSync(process.env.SIMULATION_PDF_PREVIEW_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.SIMULATION_PDF_PREVIEW_DIR, 'simulation-' + orientation + '.pdf'), result.buffer); }
  }
});
test('simulation full 10000-row export retains all main rows and exact page count without extending its data cap', async () => {
  const snapshot = fixture(10000), spec = Pdf.normalize({ snapshotToken: 'server-token', columns: ['articleNumber', 'description', 'scenarioNetRevenue'], orientation: 'landscape' }, caps);
  const result = await Pdf.render({ spec, snapshot }), parsed = await read(result.buffer);
  assert.equal(result.rows, 10000); assert.equal(result.pages, parsed.pages.length); assert.ok(result.pages > 200);
  const markers = parsed.pages.flatMap(p => p.items).filter(item => /^SIM-\d{5}$/.test(item.str)).map(item => item.str);
  assert.equal(markers.length, 10000); assert.equal(new Set(markers).size, 10000); assert.ok(markers.includes('SIM-09999'));
  assert.throws(() => Pdf.render({ spec, snapshot: { ...snapshot, rows: [...snapshot.rows, snapshot.rows[0]], summary: { ...snapshot.summary, rows: 10001 } } }), { status: 409 });
});
test('simulation exports an empty scenario truthfully and denies historically absent financial columns', async () => {
  const spec = Pdf.normalize({ snapshotToken: 'x', columns: ['articleNumber', 'description'] }, caps), result = await Pdf.render({ spec, snapshot: fixture(0) });
  const parsed = await read(result.buffer); assert.match(parsed.pages.map(p => p.text).join(' '), /Keine Artikel-Filial-Zeilen für dieses Szenario/);
  assert.throws(() => Pdf.render({ spec, snapshot: { ...fixture(0), summary: { ...fixture(0).summary, rows: 1 } } }), { status: 409 });
  const revoked = { ...fixture(), capabilities: { read: true, prices: true, costs: false, margin: false } };
  assert.throws(() => Pdf.render({ spec: Pdf.normalize({ snapshotToken: 'x', columns: ['scenarioGrossMargin'] }, caps), snapshot: revoked }), { status: 403 });
});
