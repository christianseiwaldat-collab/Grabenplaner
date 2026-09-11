'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Lines = require('../public/receipt-line-format');
const UI = require('../public/receipt-search');
const { createReceiptInfoPdf } = require('../lib/receipt-info-pdf');
const row = (id, personnel, extra = {}) => ({ article: id, description: 'Artikel ' + id, personnel,
  quantity: '1', sourcePrice: '12', gross: '12.00', status: 'sale', ...extra });
const receipt = lines => ({ id: 'synthetic-receipt', kind: 'receipts', date: '2026-09-01', receipt: '123',
  location: 'Filiale Test', register: '0', personnel: '999', positions: lines.length, lines,
  sourceAmount: '0', gross: '12.00', currency: 'EUR', state: 'Geprüft',
  provenance: { importedAt: '2026-09-07', fileSha256: 'a'.repeat(64), sourceLabel: 'Synthetische Testdaten' } });
async function pages(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }), pdf = await loading.promise;
  try {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), content = await page.getTextContent();
      pages.push({ items: content.items, text: content.items.map(t => t.str).join(' '), width: page.view[2], height: page.view[3] });
    }
    return pages;
  } finally { await loading.destroy(); }
}

test('receipt prices use exact signed source amounts independently of payment or review status', () => {
  for (const [price, quantity, expected] of [['100', '-4', '-400.00'], ['19.54', '2', '39.08'],
    ['200.004', '2', '400.01'], ['200.004', '-2', '-400.01'], ['0.005', '-1', '-0.01'],
    ['0', '2', '0.00'], ['9007199254740991.02', '1', '9007199254740991.02']]) {
    assert.equal(Lines.total(price, quantity), expected);
  }
  assert.equal(Lines.total(null, '1'), null); assert.equal(Lines.total('abc', '1'), null);
  assert.equal(Lines.money('19.54'), '19,54'); assert.equal(Lines.money('0'), '0,00');
  const html = UI.renderDetail(receipt([row('voucher', '252', { quantity: '-4', sourcePrice: '100', gross: '0', status: 'payment' }),
    row('issued', '252', { quantity: '2', sourcePrice: '10', gross: '0', status: 'voucher_issue' }),
    row('open', '252', { quantity: '2', sourcePrice: '75', gross: null, status: 'review' })]));
  assert.match(html, /-400,00/); assert.match(html, /150,00/); assert.match(html, /Zahlungsmittel/); assert.match(html, /Prüfung offen/);
  assert.match(html, /20,00/); assert.match(html, /Gutscheinausgabe · kein Warenumsatz/);
});

test('five-column receipt groups preserve staff and per-staff source order without inventing a header-seller fallback', () => {
  const item = receipt([row('first', '252'), row('second', '426'), row('third', '252'), row('fourth', '')]);
  const before = JSON.stringify(item), groups = Lines.groups(item);
  assert.deepEqual(groups.map(g => [g.personnel, g.lines.map(l => l.article)]), [['252', ['first', 'third']], ['426', ['second']], ['', ['fourth']]]);
  assert.equal(JSON.stringify(item), before);
  const html = UI.renderDetail(item), header = /<thead>(.*?)<\/thead>/s.exec(html)[1];
  assert.deepEqual([...header.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(m => m[1]), ['Menge', 'Artikelnr.', 'Bezeichnung', 'Einzelpreis', 'Gesamtpreis']);
  assert.match(html, /<strong>Personalnr\.: 252<\/strong>/); assert.match(html, /scope="rowgroup"/);
  assert.match(html, /Personalnr\.: nicht zugeordnet/);
  assert.ok(html.indexOf('Artikel third') < html.indexOf('Personalnr.: 426'));
  const hidden = { ...item }; delete hidden.personnel;
  assert.equal(Lines.groups(hidden).length, 1);
  assert.doesNotMatch(UI.renderDetail(hidden), /Personalnr|Personalnummer|252|426|999/);
  const hostile = receipt([row('<svg onload=attack>', '<script>attack</script>')]);
  assert.doesNotMatch(UI.renderDetail(hostile), /<svg|<script>/);
});

test('PDF repeats the bold staff group after page breaks and retains every item in the required columns', async () => {
  const lines = Array.from({ length: 64 }, (_, i) => row('A' + String(i).padStart(3, '0'), '252', {
    description: 'Lange vollständige Artikelbezeichnung ' + i + ' mit ausreichend Details zur eindeutigen Zuordnung', quantity: '2', sourcePrice: '19.54' }));
  lines.splice(3, 0, row('B001', '426', { quantity: '-4', sourcePrice: '100', status: 'payment', gross: '0' }));
  lines.splice(4, 0, row('B002', '426', { quantity: '2', sourcePrice: '10', status: 'voucher_issue', gross: '0' }));
  lines.push(row('0000000081619', '', { status: 'review', gross: null }));
  const pdf = await createReceiptInfoPdf({ items: [receipt(lines)], sourceLabel: 'Synthetische Testdaten' });
  const result = await pages(pdf), text = result.map(p => p.text).join(' ');
  assert.ok(result.length >= 4);
  for (const line of lines) assert.equal(result.flatMap(p => p.items).filter(t => t.str === line.article).length, 1, line.article);
  assert.ok(text.indexOf('A063') < text.indexOf('Personalnr.: 426')); assert.match(text, /-400,00/);
  assert.match(text, /Gutscheinausgabe · kein Warenumsatz/); assert.match(text, /20,00/);
  assert.match(text, /Personalnr\.: 252 \(Fortsetzung\)/); assert.match(text, /Personalnr\.: nicht zugeordnet/);
  for (const p of result) {
    const articles = p.items.filter(t => /^[ABC]\d{3}$/.test(t.str));
    if (!articles.length) continue;
    const headers = ['Menge', 'Artikelnr.', 'Bezeichnung', 'Einzelpreis', 'Gesamtpreis'].map(label => p.items.find(t => t.str === label));
    assert.ok(headers.every(Boolean)); assert.deepEqual(headers.map(t => t.transform[4]), headers.map(t => t.transform[4]).toSorted((a, b) => a - b));
    const group = p.items.find(t => t.str.startsWith('Personalnr.:'));
    assert.ok(group && group.transform[5] > articles[0].transform[5]); assert.notEqual(group.fontName, articles[0].fontName);
    assert.ok(p.items.filter(t => t.str).every(t => t.transform[4] >= 40 && t.transform[4] + t.width <= p.width - 40.5));
  }
  if (process.env.SALES_REPORT_PDF_PREVIEW_DIR) {
    const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.SALES_REPORT_PDF_PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.SALES_REPORT_PDF_PREVIEW_DIR, 'receipt-grouped-pagination.pdf'), pdf);
  }
  const hidden = receipt([row('PRIVATE', 'PERSON-SECRET')]); delete hidden.personnel;
  const safe = await pages(await createReceiptInfoPdf({ items: [hidden], sourceLabel: 'Test' }));
  assert.doesNotMatch(safe.map(p => p.text).join(' '), /PERSON-SECRET|Personalnummer|Personalnr/);
});
