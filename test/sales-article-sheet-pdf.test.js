'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const sharp = require('sharp');
const { createSalesArticleSheetPdf, normalizeArticleSheetOptions, MAX_ROWS } = require('../lib/sales-article-sheet-pdf');
const selection = ['master', 'prices', 'notes', 'identifiers', 'movements', 'sales'];
function model() {
  return { generatedAt: '2026-10-01T13:45:00.000Z', article: {
    articleNumber: '001234', description: 'Synthetische Testkamera - vollständiger Artikelname', active: true, currentRevision: 3,
    identifiers: [{ identifierType: 'ean13', identifierValue: '4547410533644', isPrimary: true, verifiedAt: '2026-09-19T12:00:00.000Z' }],
    provenance: { originSourceSystem: 'tradefoto.artikel_stamm', currentSourceSystem: 'tradefoto.artikel_stamm', updatedAt: '2026-09-19T12:00:00.000Z' },
    sourceSections: [{ id: 'master', title: 'TradeFoto-Stammdaten', fields: [{ label: 'Marke', value: 'Fuji' }, { label: 'Internetbezeichnung', value: 'Fujifilm Testkamera Silber' }] },
      { id: 'supplier', title: 'Lieferant & Bestellung', fields: [{ label: 'Lieferant', value: 'FUR', title: 'Fujifilm Beispiel GmbH' }, { label: 'Bestellnummer', value: '16828284' }, { label: 'Lieferantenbemerkung', value: 'Langer Hinweis mit Details '.repeat(32) }] }],
    branchStock: { sourceAt: '2026-09-19T12:00:00.000Z', rows: [{ id: '18', name: 'Grabenweg', quantity: '2' }, { id: '99', name: 'United Camera Wien', quantity: '1' }] },
    priceMatrix: { costsRead: true, vatPercent: 20, purchase: [{ label: 'Ø EK', current: { amount: '1234.50' }, future: null }],
      sales: [{ label: 'EH', gross: { amount: '1599.00' }, net: { amount: '1332.50' }, margin: { amount: '98.00' }, marginPercent: '7.35459', discountPercent: '0', date: '2026-09-01', person: '42' }] },
    notes: { available: true, sourceAt: '2026-09-19T12:00:00.000Z', items: [{ date: '2026-09-19', person: '42', text: 'IMPORTIERTE-NOTIZ - unveränderter Quelltext.' }] },
  }, localNotes: { items: [{ id: 'synthetic', text: 'EIGENE-GP-NOTIZ\nKundenbestellung für Abholung.', createdAt: '2026-10-01T12:00:00.000Z', author: '42' }] },
    revisions: [{ revision: 3, articleNumber: '001234', description: 'Aktueller Stand', active: true, createdAt: '2026-10-01T13:00:00.000Z' },
      { revision: 2, articleNumber: '001234', description: 'Vorheriger Stand', active: true, createdAt: '2026-09-19T12:00:00.000Z' }],
    movements: { durationMs: 1234, available: true, dateFrom: '2026-09-01', dateTo: '2026-09-30', rows: Array.from({ length: 36 }, (_, index) => ({
      date: '2026-09-19', articleNumber: '001234', quantity: index % 2 ? '-1' : '2', label: 'ARTIKEL-UM-' + String(index).padStart(3, '0'),
      from: 'Filiale 0', to: 'Filiale 18', documentRefs: 'Korb ' + index + ' / LS 12345', issueLabel: index % 2 ? 'Negative Menge - Grund ungeklärt' : 'Keine Auffälligkeit' })) },
    sales: { durationMs: 4567, available: true, complete: true, capabilities: { sellers: true, customers: true, margin: true }, note: 'Historische Preise werden nur aus belegten Quellen angezeigt.',
      rows: Array.from({ length: 36 }, (_, index) => ({ date: '2026-09-20', locationId: '18', sourceLocationId: '18',
        personnel: '252', personnelSurname: 'Seiwald', articleNumber: '001234', quantity: '1', description: 'ARTIKEL-VK-' + String(index).padStart(3, '0'),
        customerNumber: '1234', customerName: 'Vorname Nachname', deviceNumber: 'DEVICE-' + index, receipt: 'BELEG-' + index,
        listSourcePrice: '1599', listGross: null, listMargin: null, listMarginPercent: null,
        actualGross: index ? '1499' : '9007199254740991.02', actualMargin: '14.50', actualMarginPercent: '1.16077', status: 'sale', issues: [] })) },
  };
}
async function pages(buffer) {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await task.promise;
  try {
    const result = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index), content = await page.getTextContent(), operators = await page.getOperatorList();
      result.push({ items: content.items, text: content.items.map(item => item.str).join(' '), width: page.view[2], height: page.view[3],
        imageCount: operators.fnArray.filter(id => [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(id)).length });
    }
    return result;
  } finally { await task.destroy(); }
}

test('Article sheet options require at least one unique known section and a boolean image choice', () => {
  assert.deepEqual(normalizeArticleSheetOptions(), { sections: ['master'], includeImage: false });
  assert.deepEqual(normalizeArticleSheetOptions({ sections: ['sales', 'master'], includeImage: true }), { sections: ['master', 'sales'], includeImage: true });
  for (const input of [null, [], { sections: [] }, { sections: ['master', 'master'] }, { sections: ['unknown'] }, { sections: 'master' }, { includeImage: 'true' }, { includeImage: true, file: 'private' }]) {
    assert.throws(() => normalizeArticleSheetOptions(input), { code: 'ARTICLE_SHEET_OPTIONS' });
  }
});

test('Article sheet includes selected content, optional photo, provenance and all paginated history fields without guessing historical prices', async () => {
  const input = model(); input.imageBuffer = await sharp({ create: { width: 500, height: 340, channels: 3, background: '#276b58' } }).webp().toBuffer();
  const buffer = await createSalesArticleSheetPdf(input, { sections: selection, includeImage: true }), result = await pages(buffer);
  const text = result.map(page => page.text).join(' ');
  assert.ok(result.length >= 5); assert.equal(result.reduce((sum, page) => sum + page.imageCount, 0), 1);
  for (const label of ['Stammdaten', 'Preise', 'Eigene GP-Notizen', 'Notizen aus Trade', 'Kennungen', 'Verlauf', 'Umlagerungen', 'Verkäufe']) assert.match(text, new RegExp(label));
  for (const label of ['EIGENE-GP-NOTIZ', 'IMPORTIERTE-NOTIZ', 'Fujifilm Beispiel GmbH', 'Seiwald', 'Vorname Nachname', '4547410533644']) assert.match(text, new RegExp(label));
  assert.match(text.replace(/\s/g, ''), /9\.007\.199\.254\.740\.991,02/); assert.match(text, /nicht durch aktuelle Artikelpreise ersetzt/);
  assert.match(result.at(-1).text, /Abfragedauer - Umlagerungen: 1,23 s.*Verkäufe: 4,57 s/);
  assert.ok(result.slice(0, -1).every(page => !page.text.includes('Abfragedauer')));
  for (const row of input.movements.rows) assert.equal(result.flatMap(page => page.items).filter(item => item.str === row.label).length, 1);
  for (const row of input.sales.rows) assert.equal(result.flatMap(page => page.items).filter(item => item.str === row.description).length, 1);
  for (const page of result) {
    assert.match(page.text, /Seite \d+ \/ \d+/); assert.match(page.text, /Erstellt:.*Wien/);
    for (const item of page.items.filter(item => item.str)) {
      assert.ok(item.transform[4] >= 31.5 && item.transform[4] + item.width <= page.width - 31, item.str);
      assert.ok(item.transform[5] >= 20 && item.transform[5] <= page.height - 23, item.str);
    }
  }
  const selected = await pages(await createSalesArticleSheetPdf(input, { sections: ['identifiers'], includeImage: false }));
  assert.equal(selected.reduce((sum, page) => sum + page.imageCount, 0), 0);
  assert.doesNotMatch(selected.map(page => page.text).join(' '), /EIGENE-GP-NOTIZ|IMPORTIERTE-NOTIZ|ARTIKEL-UM|ARTIKEL-VK|Ø EK/);
  if (process.env.ARTICLE_SHEET_PDF_PREVIEW_DIR) {
    const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.ARTICLE_SHEET_PDF_PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.ARTICLE_SHEET_PDF_PREVIEW_DIR, 'article-sheet-full.pdf'), buffer);
  }
});

test('Long own notes preserve all text across page breaks; absent permissions conceal private sales fields and row caps are visible', async () => {
  const input = model(), longText = 'NOTIZ-BEGINN ' + 'Fortlaufende Notiz mit allen Details. '.repeat(103) + ' NOTIZ-ENDE';
  assert.ok(longText.length <= 4000);
  input.localNotes.items = Array.from({ length: 200 }, (_, index) => ({ text: 'GP-NOTIZ-' + index + '\n' + longText,
    createdAt: '2026-10-01T12:00:00.000Z', author: '42' }));
  const result = await pages(await createSalesArticleSheetPdf(input, { sections: ['notes'] }));
  const text = result.map(page => page.text).join(' ');
  assert.ok(result.length > 100 && result.length < 600);
  assert.equal(result.flatMap(page => page.items).filter(item => item.str === 'NOTIZ-ENDE').length, 0, 'End marker can share a wrapped line');
  assert.equal((text.match(/NOTIZ-BEGINN/g) || []).length, 200); assert.equal((text.match(/NOTIZ-ENDE/g) || []).length, 200);
  assert.ok(result.every(page => page.items.filter(item => item.str).every(item => item.transform[5] >= 20)));
  input.sales.capabilities = { sellers: false, customers: false, margin: false };
  input.sales.rows = Array.from({ length: MAX_ROWS + 1 }, (_, index) => ({ ...model().sales.rows[0], description: 'SALE-CAP-' + index,
    personnel: 'STAFF-SECRET', personnelSurname: 'SURNAME-SECRET', customerName: 'CUSTOMER-SECRET', customerNumber: 'CUSTOMER-NUMBER-SECRET',
    actualMargin: '987654321.12', actualMarginPercent: '98765.12' }));
  const safe = (await pages(await createSalesArticleSheetPdf(input, { sections: ['sales'] }))).map(page => page.text).join(' ');
  assert.doesNotMatch(safe, /STAFF-SECRET|SURNAME-SECRET|CUSTOMER-SECRET|CUSTOMER-NUMBER-SECRET|987\.654\.321,12|98\.765,12/);
  assert.match(safe, /Auszug: 1000 Positionen/); assert.match(safe, /SALE-CAP-999/); assert.doesNotMatch(safe, /SALE-CAP-1000/);
  await assert.rejects(createSalesArticleSheetPdf({ ...input, imageBuffer: Buffer.from('invalid') }, { sections: ['master'], includeImage: true }), { code: 'ARTICLE_SHEET_IMAGE' });
});
