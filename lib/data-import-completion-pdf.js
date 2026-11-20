'use strict';

const path = require('node:path');
const PDFDocument = require('pdfkit');

function toPdf({ facts, totals, comparison, tables }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44, autoFirstPage: false,
      info: { Title: 'Import-Abschlussbericht', Author: 'Grabenplaner' } });
    doc.registerFont('Regular', path.join(__dirname, 'pdf-fonts/Roboto-Regular.ttf'));
    doc.registerFont('Bold', path.join(__dirname, 'pdf-fonts/Roboto-Bold.ttf'));
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = 44, width = 507, bottom = 782;
    let y, page = 0;
    function startPage() {
      page++;
      doc.addPage();
      doc.rect(left, 42, width, 36).fill('#e9f2ef');
      doc.font('Bold').fillColor('#174739').fontSize(15).text('Import-Abschlussbericht', left + 10, 52, { width: width - 75 });
      doc.font('Regular').fontSize(9).text('Seite ' + page, left + width - 65, 54, { width: 55, align: 'right' });
      y = 91;
    }
    function font(bold, size) {
      doc.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor('#182b27');
    }
    function line(text, bold = false, size = 10, gap = 5) {
      font(bold, size);
      const height = doc.heightOfString(text, { width });
      if (y + height > bottom) startPage();
      font(bold, size);
      doc.text(text, left, y, { width });
      y += height + gap;
    }
    function twoColumns(values) {
      for (const [label,value] of values) {
        const split = 215;
        font(false, 10);
        const height = Math.max(15, doc.heightOfString(value, { width: width - split }));
        if (y + height > bottom) startPage();
        font(true, 9);
        doc.text(label, left, y, { width: split - 10 });
        font(false, 10);
        doc.text(value, left + split, y, { width: width - split });
        y += height + 2;
      }
    }
    function table({ title, headers, rows }) {
      const first = headers.length === 5 ? 188 : headers.length === 4 ? 116 : 220;
      const widths = [first, ...headers.slice(1).map(() => (width - first) / (headers.length - 1))];
      function cells(values, bold) {
        font(bold, 9);
        const height = Math.max(...values.map((value, index) => doc.heightOfString(value, { width: widths[index] - 14 }))) + 8;
        return { values, height, bold };
      }
      function write({ values, height, bold }) {
        if (bold) doc.rect(left, y, width, height).fill('#e9f2ef');
        else doc.moveTo(left, y + height).lineTo(left + width, y + height).lineWidth(.5).strokeColor('#d8e4df').stroke();
        font(bold, 9);
        let x = left;
        values.forEach((value, index) => {
          doc.text(value, x + 7, y + 4, { width: widths[index] - 14, align: index === 0 ? 'left' : 'right' });
          x += widths[index];
        });
        y += height;
      }
      const header = cells(headers, true);
      if (y + header.height + (rows.length ? cells(rows[0], false).height : 0) + 25 > bottom) startPage();
      line(title, true, 12);
      write(header);
      for (const row of rows) {
        const cell = cells(row, false);
        if (y + cell.height > bottom) { startPage(); line(title, true, 12); write(header); }
        write(cell);
      }
      y += 13;
    }
    try {
      startPage();
      twoColumns(facts);
      y += 12;
      line('Ergebnis', true, 12);
      twoColumns(totals);
      y += 10;
      line(comparison, false, 9, 10);
      tables.forEach(table);
      doc.end();
    } catch (error) { doc.destroy(error); }
  });
}

module.exports = { toPdf };
