'use strict';
const PDFDocument = require('pdfkit');
const path = require('node:path');
const C = require('./data-import-contract');
const Lines = require('../public/receipt-line-format');
const clean = value => String(value ?? '-').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\u2010-\u2015]/g, '-');
const number = value => value == null ? '-' : String(value).replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1').replace('.', ',');
const money = value => {
  const result = number(value); if (result === '-') return result;
  return result.includes(',') ? result.padEnd(result.indexOf(',') + 3, '0') : result + ',00';
};
function createReceiptInfoPdf({ items, sourceLabel }, { createdAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(items) || !items.length || items.length > 50) C.fail('IMPORT_RECEIPT_SELECTION');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, autoFirstPage: false,
      info: { Title: 'Beleginformation - keine Rechnung', Author: 'Grabenplaner', Subject: 'Information aus dem importierten Kassenstand' } });
    doc.registerFont('Receipt-Regular', path.join(__dirname, 'pdf-fonts/Roboto-Regular.ttf'));
    doc.registerFont('Receipt-Bold', path.join(__dirname, 'pdf-fonts/Roboto-Bold.ttf'));
    const chunks = []; let bytes = 0;
    doc.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) doc.destroy(new Error('PDF size limit')); else chunks.push(chunk); });
    doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      const left = 42, width = 511, bottom = 770;
      let y = 0, currentItem = null;
      function line(text, { size = 9, bold = false, color = '#213d38', gap = 7 } = {}) {
        const font = () => doc.font(bold ? 'Receipt-Bold' : 'Receipt-Regular').fontSize(size).fillColor(color);
        font();
        const h = doc.heightOfString(clean(text), { width });
        if (y + h > bottom) page(true);
        font();
        doc.text(clean(text), left, y, { width }); y += h + gap;
      }
      function page(continuation = false) {
        doc.addPage();
        doc.rect(left, 38, width, 31).fill('#e9f2ef');
        doc.font('Receipt-Bold').fontSize(14).fillColor('#173e34').text('Beleginformation - keine Rechnung', left + 10, 46, { width: width - 20 });
        y = 82;
        if (continuation && currentItem) line(`Fortsetzung · Beleg ${currentItem.receipt} · ${currentItem.date} · ${currentItem.location} · Kasse ${currentItem.register || '-'}`, { bold: true });
      }
      function table(rows, columns, groups = [{ personnel: null, lines: rows }]) {
        const total = columns.reduce((n, c) => n + c.weight, 0);
        const colWidth = columns.map(c => width * c.weight / total);
        function header() {
          doc.rect(left, y, width, 26).fill('#e9f2ef'); let x = left;
          columns.forEach((c, i) => { doc.font('Receipt-Bold').fontSize(8).fillColor('#213d38').text(c.label, x + 5, y + 7, { width: colWidth[i] - 10, align: c.numeric ? 'right' : 'left' }); x += colWidth[i]; }); y += 30;
        }
        function layout(row) {
          doc.font('Receipt-Regular').fontSize(8.5);
          const texts = columns.map(c => c.multiline ? c.value(row).split('\n').map(clean).join('\n') : clean(c.value(row)));
          const heights = texts.map((t, i) => doc.heightOfString(t, { width: colWidth[i] - 10 }));
          const height = Math.max(17, ...heights) + 12;
          if (height > 620) C.fail('IMPORT_RECEIPT_EXPORT_LIMIT', 413);
          return { texts, height };
        }
        function personnel(group, continuation = false, draw = true) {
          if (group.personnel === null) return 0;
          const label = clean(`Personalnr.: ${group.personnel || 'nicht zugeordnet'}${continuation ? ' (Fortsetzung)' : ''}`);
          doc.font('Receipt-Bold').fontSize(9);
          const height = doc.heightOfString(label, { width: width - 10 }) + 13;
          if (draw) {
            doc.rect(left, y, width, height).fill('#f3f6f5');
            doc.font('Receipt-Bold').fontSize(9).fillColor('#213d38').text(label, left + 5, y + 5, { width: width - 10 });
            y += height;
          }
          return height;
        }
        const first = groups.find(g => g.lines.length);
        if (y + 30 + (first ? personnel(first, false, false) + layout(first.lines[0]).height : 0) > bottom) page(true);
        header();
        for (const group of groups) {
          if (!group.lines.length) continue;
          if (y + personnel(group, false, false) + layout(group.lines[0]).height > bottom) { page(true); header(); }
          personnel(group);
          for (const row of group.lines) {
            const { texts, height } = layout(row);
            if (y + height > bottom) { page(true); header(); personnel(group, true); }
            if (y + height > bottom) C.fail('IMPORT_RECEIPT_EXPORT_LIMIT', 413);
            let x = left;
            texts.forEach((t, i) => { doc.font('Receipt-Regular').fontSize(8.5).fillColor('#243633').text(t, x + 5, y + 4, { width: colWidth[i] - 10, align: columns[i].numeric ? 'right' : 'left' }); x += colWidth[i]; });
            y += height; doc.moveTo(left, y - 4).lineTo(left + width, y - 4).strokeColor('#dbe4e1').lineWidth(0.5).stroke();
          }
        }
        y += 8;
      }
      for (const [index, item] of items.entries()) {
        currentItem = item;
        page();
        line(`${index + 1} von ${items.length} · ${item.kind === 'receipts' ? 'Beleg' : item.kind === 'daily' ? 'Tagesbericht - Buchung' : 'Kassenjournal - Buchung'} ${item.receipt || '-'}`, { size: 17, bold: true });
        line('Informationsauszug aus gespeicherten Quelldaten. Kein Rechnungsdokument und kein Ersatz für den Originalbeleg.', { size: 9, color: '#5d6462' });
        line(`Datum: ${item.date}   |   Filiale: ${item.location}${item.register ? '   |   Kasse: ' + item.register : ''}`);
        if (item.invoice) line(`Rechnungsreferenz der Quelle: ${item.invoice}`);
        if (Object.hasOwn(item, 'personnel')) line(`Personalnummer (Belegverkäufer): ${item.personnel || 'Zuordnung offen'}`, { bold: true });
        if (Object.hasOwn(item, 'customerNumber')) {
          line(`Kunden-Kontonummer: ${item.customerAccount || 'Ohne Zuordnung'}${item.customerName ? '   |   ' + item.customerName : ''}`);
          if (item.customerNumber) line(`Kundennummer: ${item.customerNumber}`);
          if (item.customerSourceAccount) line(`TradeFoto-KontoNr (Zusatzangabe): ${item.customerSourceAccount}`);
          if (item.customerAddress) line(`Adresse: ${item.customerAddress}`);
          if (item.customerPhone || item.customerEmail) line([item.customerPhone, item.customerEmail].filter(Boolean).join(' · '));
          line(item.customerStatus, { size: 8, color: '#5d6462' });
        }
        line(`Datenstand: ${sourceLabel}`, { bold: true });
        line(`Importiert: ${item.provenance.importedAt?.slice(0, 10) || '-'}   |   PDF erstellt: ${createdAt.slice(0, 10)}`, { size: 8, color: '#5d6462' });
        if (item.kind === 'receipts') {
          line(`${item.positions} Positionen des vollständigen Quellbelegs · ${item.state}`, { bold: true });
          const columns = [{ label: 'Menge', weight: .9, numeric: true, value: l => number(l.quantity) },
            { label: 'Artikelnr.', weight: 1.8, value: l => l.article },
            { label: 'Bezeichnung', weight: 5.4, multiline: true, value: l => [clean(l.description), Lines.note(l.status)].filter(Boolean).join('\n') },
            { label: 'Einzelpreis', weight: 1.6, numeric: true, value: l => Lines.money(l.sourcePrice) },
            { label: 'Gesamtpreis', weight: 1.8, numeric: true, value: l => Lines.money(Lines.total(l.sourcePrice, l.quantity)) }];
          table(item.lines, columns, Lines.groups(item));
          line('Gesamtpreis = Menge × Einzelpreis, je Position auf Cent gerundet. Gutscheinausgaben, Zahlungsmittel und UID-Zwischenbuchungen sind kein Warenumsatz.', { size: 8 });
          line(item.gross == null ? `Quellbetrag des Belegkopfs: ${Lines.money(item.sourceAmount)} ${item.currency} · Belegabgleich offen` : `Geprüfter Warenumsatz: ${Lines.money(item.gross)} ${item.currency}`, { size: 11, bold: true });
          if (item.gross == null) line('Die angezeigten Positionsbeträge sind noch keine freigegebene Umsatzsumme.', { size: 8 });
        } else {
          table([item], [{ label: 'Buchung / Konto', weight: 5, value: l => [l.description, l.account].filter(Boolean).join(' · ') },
            { label: 'Einzahlung', weight: 2, value: l => money(l.inflow) }, { label: 'Auszahlung', weight: 2, value: l => money(l.outflow) }]);
          line('Separate Kassenbuchung; nicht als zusätzlicher Verkauf zu werten.', { size: 8 });
        }
        line(`Quellbeleg-ID: ${item.id}`, { size: 7, color: '#5d6462' });
        line(`Quelldatei SHA-256: ${item.provenance.fileSha256}`, { size: 7, color: '#5d6462' });
      }
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i); doc.font('Receipt-Regular').fontSize(7).fillColor('#5d6462');
        doc.text(`Grabenplaner · Beleginformation - keine Rechnung · Seite ${i + 1} / ${range.count}`, left, 780, { width, lineBreak: false });
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}
module.exports = { createReceiptInfoPdf };
