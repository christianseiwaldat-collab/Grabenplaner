'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const M = require('../lib/sales-bwl-actions-model'), Pdf = require('../lib/sales-bwl-actions-pdf');
const caps = { read: true, write: true, prices: true, costs: true, margin: true };
function fixture(count = 35) {
  return Array.from({ length: count }, (_, i) => ({ id: crypto.randomUUID(), locationId: '18', title: 'BEISPIEL Maßnahme ' + i,
    articleNumber: 'ACT-' + String(i).padStart(5, '0'), priority: i % 2 ? 'normal' : 'high', status: i % 3 ? 'open' : 'in_progress',
    dueDate: '2026-10-31', assigneeNumber: '101', note: 'BEISPIEL: Filialbestand prüfen und Vorgehen dokumentieren.',
    source: { kind: 'abc', rowId: 'synthetic-' + i, articleNumber: 'ACT-' + String(i).padStart(5, '0'), label: 'BEISPIEL Fernglas ' + i,
      reason: 'Artikel der ABC-Klasse A prüfen.', sourceAt: '2026-10-08T12:00:00.000Z', sourceFingerprint: 'a'.repeat(64), type: 'checked-cash-review' },
    version: 2, createdAt: '2026-10-08T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z', createdBy: 'synthetic-owner', updatedBy: 'synthetic-owner', completedAt: null }));
}
async function read(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'), task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await task.promise;
  try { const pages = [], metadata = await pdf.getMetadata();
    for (let index = 1; index <= pdf.numPages; index++) { const page = await pdf.getPage(index), content = await page.getTextContent();
      pages.push({ width: page.view[2], height: page.view[3], items: content.items, text: content.items.map(item => item.str).join(' ') }); }
    return { pages, metadata };
  } finally { await task.destroy(); }
}
const options = (extra = {}) => ({ query: { locationId: '18', status: 'open', sort: 'articleNumber', direction: 'asc' }, ...extra });
test('actions PDF accepts only trusted query selectors, allowed columns and strict professional print options', () => {
  const input = options({ columns: ['title', 'note'], title: ' BEISPIEL Maßnahmen ', name: '../BEISPIEL:Maßnahmen.pdf' });
  const spec = Pdf.normalize(input, caps); assert.equal(spec.name, 'BEISPIEL-Maßnahmen.pdf'); assert.equal(spec.title, 'BEISPIEL Maßnahmen'); assert.equal(spec.orientation, 'landscape');
  assert.deepEqual(spec.query, { ...input.query, query: '' }); assert.equal(spec.columns.length, 2);
  for (const change of [{ rows: [] }, { ownerId: 'other' }, { version: 1 }, { query: { locationId: '18', limit: 200 } }, { query: { locationId: '18', offset: 200 } },
    { query: { locationId: '18', locations: ['19'] } }, { query: { locationId: '18', sort: 'private' } }, { query: {} }, { columns: [] },
    { columns: ['title', 'title'] }, { columns: ['private'] }, { columns: M.COLUMNS.map(c => c.id) }, { orientation: 'A3' }, { title: 'hidden\nline' }, { name: null }])
    assert.throws(() => Pdf.normalize({ ...input, ...change }, caps));
  assert.throws(() => Pdf.normalize(input, { read: false }), { status: 403 });
  assert.equal(Pdf.cell({ updatedAt: '2026-10-09T12:00:00.000Z' }, M.COLUMNS.find(c => c.id === 'updatedAt')), '09.10.2026, 14:00');
  assert.equal(Pdf.cell({ assigneeNumber: '00101' }, M.COLUMNS.find(c => c.id === 'assigneeNumber')), '00101');
});
test('actual A4 portrait and landscape preserve all measures, complete long notes, unbroken tokens and page bounds', async () => {
  const rows = fixture(), longToken = 'LONGTOKEN' + 'x'.repeat(520) + 'TOKENEND';
  rows[2].note = ('BEISPIEL vollständige Ergebnisnotiz.\n').repeat(39) + longToken + '\nENDE-DER-NOTIZ'; assert.ok(rows[2].note.length < 2001);
  rows.at(-1).note = 'BEISPIEL Abschluss der Auswahl. LETZTER-ZEILENMARKER-ACT-00034';
  for (const orientation of ['portrait', 'landscape']) {
    const spec = Pdf.normalize(options({ orientation, title: 'BEISPIEL - Filialmaßnahmen für Ferngläser', name: 'BEISPIEL-Maßnahmen-' + orientation,
      columns: ['articleNumber', 'title', 'priority', 'status', 'dueDate', 'assigneeNumber', 'source', 'note'] }), caps);
    const result = await Pdf.render({ spec, rows, location: { id: '18', label: 'BEISPIEL Filiale 18' }, generatedAt: '2026-10-09T12:00:00.000Z' }), parsed = await read(result.buffer);
    assert.equal(result.pages, parsed.pages.length); assert.equal(result.rows, rows.length); assert.ok(result.pages > 2); assert.equal(parsed.metadata.info.Title, spec.title);
    const items = parsed.pages.flatMap(p => p.items), text = items.map(i => i.str).join(' '), compact = items.map(i => i.str).join('').replace(/\s/g, '');
    assert.ok(compact.includes(longToken)); assert.match(text, /ENDE-DER-NOTIZ/);
    assert.match(text, /ABC-Klasse A/); assert.match(text, /Keine automatische Bestellung/); assert.match(text, /Fortsetzung: ACT-00002/);
    assert.ok(compact.includes('LETZTER-ZEILENMARKER-ACT-00034'));
    for (const row of rows) assert.equal(items.filter(item => item.str === row.articleNumber).length, 1, orientation + ': ' + row.articleNumber);
    for (const page of parsed.pages) {
      assert.ok(Math.abs(page.width - (orientation === 'portrait' ? 595.28 : 841.89)) < .1); assert.ok(Math.abs(page.height - (orientation === 'portrait' ? 841.89 : 595.28)) < .1);
      for (const item of page.items.filter(i => i.str)) {
        assert.ok(item.transform[4] >= 31.5 && item.transform[4] + item.width <= page.width - 31, orientation + ': x bounds ' + item.str);
        assert.ok(item.transform[5] >= 16 && item.transform[5] <= page.height - 23, orientation + ': y bounds ' + item.str);
      }
    }
    if (process.env.ACTIONS_PDF_PREVIEW_DIR) { fs.mkdirSync(process.env.ACTIONS_PDF_PREVIEW_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.ACTIONS_PDF_PREVIEW_DIR, 'actions-' + orientation + '.pdf'), result.buffer); }
  }
});
test('all 500 allowed measures remain in the real PDF, with exact row/page counts and unchanged hard cap', async () => {
  const rows = fixture(500), spec = Pdf.normalize(options({ columns: ['articleNumber', 'title', 'status'], orientation: 'landscape' }), caps);
  const result = await Pdf.render({ spec, rows, location: { id: '18', label: 'BEISPIEL Filiale' } }), parsed = await read(result.buffer);
  const markers = parsed.pages.flatMap(p => p.items).filter(i => /^ACT-\d{5}$/.test(i.str));
  assert.equal(result.rows, 500); assert.equal(result.pages, parsed.pages.length); assert.equal(markers.length, 500); assert.equal(new Set(markers.map(i => i.str)).size, 500); assert.equal(markers.at(-1).str, 'ACT-00499');
  assert.throws(() => Pdf.render({ spec, rows: [...rows, fixture(1)[0]], location: { id: '18', label: 'BEISPIEL' } }), { status: 409 });
});
test('empty, cross-filial, duplicate, malformed and changed projections are handled truthfully', async () => {
  const spec = Pdf.normalize(options({ columns: ['title', 'note'] }), caps), location = { id: '18', label: 'BEISPIEL Filiale' }, row = fixture(1)[0];
  const result = await Pdf.render({ spec, rows: [], location }), parsed = await read(result.buffer); assert.equal(result.rows, 0); assert.match(parsed.pages.map(p => p.text).join(' '), /Keine Maßnahmen für diese Auswahl/);
  for (const rows of [[row, row], [{ ...row, version: 0 }], [{ ...row, note: 'x'.repeat(2001) }], [{ ...row, status: 'secret' }], [{ ...row, source: { ...row.source, averageCost: 'private' } }]]) assert.throws(() => Pdf.render({ spec, rows, location }));
  assert.throws(() => Pdf.render({ spec, rows: [{ ...row, locationId: '19' }], location }), { status: 403 });
  assert.throws(() => Pdf.render({ spec, rows: [row], location: { id: '19', label: 'other' } }), { status: 403 });
});
