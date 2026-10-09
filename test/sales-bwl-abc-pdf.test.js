'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const M = require('../lib/sales-bwl-abc-model'), Pdf = require('../lib/sales-bwl-abc-pdf');
const query = { dateFrom: '2026-01-01', dateTo: '2026-10-09', locationIds: ['18'], metric: 'netRevenue', aLimit: 80, bLimit: 95 };
function fixture(count = 85) {
  const state = M.accumulator();
  for (let i = 0; i < count; i++) M.accumulate(state, { articleNumber: 'ART-' + String(i).padStart(5, '0'), description: 'BEISPIEL-ZEILE-' + String(i).padStart(5, '0'),
    locationId: '18', location: 'BEISPIEL Filiale', metric: { status: 'sale', net: String(count - i) + '.00' }, quantity: '1.000000', margin: i % 11 ? '2.00' : null });
  M.accumulate(state, { articleNumber: null, metric: null, quantity: null, reviewIssues: ['BEISPIEL-PRUEFFALL'] });
  return { query, coverage: M.COVERAGE, sourceAt: '2026-10-08T12:00:00.000Z', ...M.finish(state, query, { margin: true }) };
}
async function read(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'), task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await task.promise;
  try { const pages = [], metadata = await pdf.getMetadata();
    for (let index = 1; index <= pdf.numPages; index++) { const page = await pdf.getPage(index), content = await page.getTextContent();
      pages.push({ width: page.view[2], height: page.view[3], items: content.items, text: content.items.map(item => item.str).join(' ') }); }
    return { pages, metadata };
  } finally { await task.destroy(); }
}
test('ABC PDF options reject client rows, unavailable grants, malformed tokens and controls while sanitizing filenames', () => {
  const input = { exportToken: 'server-token', columns: ['articleNumber', 'netRevenue'], sort: 'netRevenue', direction: 'desc', title: '  Meine ABC-Auswertung  ', name: '../Meine:Auswertung.pdf' };
  const spec = Pdf.normalize(input, { margin: false }); assert.equal(spec.title, 'Meine ABC-Auswertung'); assert.equal(spec.name, 'Meine-Auswertung.pdf'); assert.equal(spec.orientation, 'landscape');
  for (const change of [{ rows: [] }, { source: 'client' }, { exportToken: '' }, { exportToken: 'x'.repeat(16385) }, { columns: [] },
    { columns: ['grossMargin'] }, { columns: ['articleNumber', 'articleNumber'] }, { sort: 'grossMargin' }, { sort: 'secret' }, { direction: 'up' },
    { orientation: 'A3' }, { title: 'a\nHidden title' }, { title: null }, { name: 123 }, { title: 'x'.repeat(161) }]) assert.throws(() => Pdf.normalize({ ...input, ...change }, { margin: false }));
  assert.equal(Pdf.normalize({ exportToken: 'x', name: '   ' }, {}).name, 'ABC-Analyse.pdf');
});
test('ABC PDF displays exact decimal money, sorts without number coercion and keeps nulls last in either direction', () => {
  assert.equal(Pdf.decimalText('9007199254740991.02', true), '9.007.199.254.740.991,02 EUR');
  assert.equal(Pdf.decimalText('-0.000001'), '-0,000001'); assert.equal(Pdf.cell({ grossMargin: null }, { id: 'grossMargin' }), 'Prüfen');
  const rows = [{ id: 'b', netRevenue: '9007199254740991.02' }, { id: 'a', netRevenue: '9007199254740991.03' }, { id: 'n', netRevenue: null }];
  assert.deepEqual(Pdf.sortedRows(rows, 'netRevenue', 'asc').map(r => r.id), ['b', 'a', 'n']);
  assert.deepEqual(Pdf.sortedRows(rows, 'netRevenue', 'desc').map(r => r.id), ['a', 'b', 'n']);
  assert.deepEqual(rows.map(r => r.id), ['b', 'a', 'n']);
});
test('ABC PDF has true portrait/landscape pages, custom metadata, every chosen row exactly once, valid geometry and coverage notes', async () => {
  const snapshot = fixture(), title = 'BEISPIEL - ABC nach Filiale und Artikel';
  for (const orientation of ['portrait', 'landscape']) {
    const spec = Pdf.normalize({ exportToken: 'server-token', title, name: 'BEISPIEL-ABC-' + orientation,
      orientation, columns: M.COLUMNS.map(c => c.id), sort: 'articleNumber', direction: 'desc' }, { margin: true });
    const result = await Pdf.render({ spec, snapshot, generatedAt: '2026-10-09T12:00:00.000Z' }), parsed = await read(result.buffer);
    assert.equal(result.pages, parsed.pages.length); assert.equal(result.rows, snapshot.rows.length); assert.ok(result.pages > 2);
    assert.equal(parsed.metadata.info.Title, title); const text = parsed.pages.map(p => p.text).join(' ');
    assert.match(text, /Zeitraumvollständigkeit nicht nachgewiesen/); assert.match(text, /Datengrundlage und gesonderte Positionen/); assert.match(text, /Belegprüfung offen: 1 Position/); assert.match(text, /Prüfen/);
    for (const row of snapshot.rows) assert.equal(parsed.pages.flatMap(p => p.items).filter(item => item.str === row.description).length, 1, orientation + ': ' + row.description);
    for (const page of parsed.pages) {
      assert.ok(Math.abs(page.width - (orientation === 'portrait' ? 595.28 : 841.89)) < .1); assert.ok(Math.abs(page.height - (orientation === 'portrait' ? 841.89 : 595.28)) < .1);
      for (const item of page.items.filter(i => i.str)) {
        assert.ok(item.transform[4] >= 31.5 && item.transform[4] + item.width <= page.width - 31, orientation + ': x bounds ' + item.str);
        assert.ok(item.transform[5] >= 16 && item.transform[5] <= page.height - 23, orientation + ': y bounds ' + item.str);
      }
    }
    const firstMarker = parsed.pages.flatMap(p => p.items).find(item => item.str.startsWith('BEISPIEL-ZEILE-')); assert.equal(firstMarker.str, snapshot.rows.at(-1).description);
    if (process.env.ABC_PDF_PREVIEW_DIR) { fs.mkdirSync(process.env.ABC_PDF_PREVIEW_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.ABC_PDF_PREVIEW_DIR, 'abc-' + orientation + '.pdf'), result.buffer); }
  }
});
test('ABC full 5000-row export retains all rows and actual page count without browser pagination or a larger data budget', async () => {
  const snapshot = fixture(5000), spec = Pdf.normalize({ exportToken: 'server-token', columns: ['articleNumber', 'description', 'netRevenue'], orientation: 'landscape' }, { margin: true });
  const result = await Pdf.render({ spec, snapshot, generatedAt: '2026-10-09T12:00:00.000Z' }), parsed = await read(result.buffer);
  assert.equal(result.rows, 5000); assert.equal(result.pages, parsed.pages.length); assert.ok(result.pages > 100);
  const markers = parsed.pages.flatMap(p => p.items).filter(i => /^BEISPIEL-ZEILE-\d{5}$/.test(i.str)).map(i => i.str);
  assert.equal(markers.length, 5000); assert.equal(new Set(markers).size, 5000); assert.ok(markers.includes('BEISPIEL-ZEILE-04999'));
  assert.throws(() => Pdf.render({ spec, snapshot: { ...snapshot, rows: [...snapshot.rows, snapshot.rows[0]], summary: { ...snapshot.summary, groups: 5001 } } }), { code: 'BWL_ABC_PDF_INTEGRITY' });
});
test('ABC empty completed snapshot exports truthful coverage, and incomplete snapshot is rejected', async () => {
  const snapshot = fixture(0), spec = Pdf.normalize({ exportToken: 'server-token' }, {}), result = await Pdf.render({ spec, snapshot });
  assert.equal(result.rows, 0); const parsed = await read(result.buffer); assert.match(parsed.pages[0].text, /Keine Artikel-Filial-Zeilen/);
  assert.throws(() => Pdf.render({ spec, snapshot: { ...snapshot, summary: { ...snapshot.summary, groups: 1 } } }), { status: 409 });
});
module.exports = { fixture };
