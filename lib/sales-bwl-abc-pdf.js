'use strict';
const fs = require('node:fs'), path = require('node:path');
const PDFDocument = require('pdfkit');
const C = require('./data-import-contract');
const M = require('./sales-bwl-abc-model');
const plain = (value, max = 1000) => String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
function filename(value) { const name = plain(value, 120).replace(/[<>:"/\\|?*]/g, '-').replace(/\.pdf$/i, '')
  .replace(/^[. -]+|[. -]+$/g, '') || 'ABC-Analyse'; return name + '.pdf'; }
function normalize(input, projection) {
  C.exact(input, ['exportToken', 'title', 'name', 'orientation', 'columns', 'sort', 'direction']); C.text(input.exportToken, 16384);
  for (const [id, max] of [['title', 160], ['name', 120]]) if (input[id] !== undefined
    && (typeof input[id] !== 'string' || input[id].length > max || /[\u0000-\u001f\u007f]/.test(input[id]))) C.fail('BWL_ABC_PDF_OPTIONS');
  const orientation = input.orientation ?? 'landscape'; if (!['portrait', 'landscape'].includes(orientation)) C.fail('BWL_ABC_PDF_OPTIONS');
  const prefs = M.normalizePreferences({ ...(input.columns === undefined ? {} : { columns: input.columns }),
    ...(input.sort === undefined ? {} : { sort: input.sort }), ...(input.direction === undefined ? {} : { direction: input.direction }) }, projection);
  return { exportToken: input.exportToken, title: plain(input.title || 'ABC-Analyse', 160) || 'ABC-Analyse',
    name: filename(input.name || 'ABC-Analyse'), orientation, columns: prefs.columns.map(id => M.COLUMNS.find(c => c.id === id)),
    sort: prefs.sort, direction: prefs.direction };
}
function compareDecimal(a, b) {
  const parse = value => { const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
    if (!match) C.fail('BWL_ABC_PDF_INTEGRITY', 409); return { negative: match[1] === '-', whole: match[2], fraction: match[3] || '' }; };
  const left = parse(a), right = parse(b), scale = Math.max(left.fraction.length, right.fraction.length);
  const units = v => BigInt((v.negative ? '-' : '') + v.whole + v.fraction.padEnd(scale, '0'));
  const difference = units(left) - units(right); return difference > 0n ? 1 : difference < 0n ? -1 : 0;
}
const NUMERIC = new Set(['rank', 'quantity', 'netRevenue', 'grossMargin', 'sharePercent', 'cumulativePercent']);
function sortedRows(rows, sort, direction) {
  return [...rows].sort((a, b) => {
    const av = a[sort], bv = b[sort]; let order;
    if (av === null || av === undefined || bv === null || bv === undefined) order = av == null && bv == null ? 0 : av == null ? 1 : -1;
    else { order = NUMERIC.has(sort) ? compareDecimal(av, bv) : String(av).localeCompare(String(bv), 'de-AT', { numeric: true, sensitivity: 'base' }); order *= direction === 'desc' ? -1 : 1; }
    return order || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  });
}
function decimalText(value, money = false) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value)); if (!match) return 'Prüfen';
  const whole = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, '.'), fraction = money ? (match[3] || '').padEnd(2, '0') : (match[3] || '').replace(/0+$/, '');
  return match[1] + whole + (fraction ? ',' + fraction : '') + (money ? ' EUR' : '');
}
const STATUS = { ranked: 'Geprüft', nonpositive: 'Nicht positive Basis', 'margin-missing': 'Rohertrag fehlt', review: 'Belegprüfung offen' };
function cell(row, column) {
  const value = row[column.id];
  if (value === null || value === undefined) return ['quantity', 'netRevenue', 'grossMargin'].includes(column.id) ? 'Prüfen' : '-';
  if (column.id === 'rankingStatus') return STATUS[value] || 'Prüfen';
  if (['netRevenue', 'grossMargin'].includes(column.id)) return decimalText(value, true);
  if (['quantity', 'rank'].includes(column.id)) return decimalText(value);
  if (['sharePercent', 'cumulativePercent'].includes(column.id)) return decimalText(value) + ' %';
  return plain(value, column.id === 'description' ? 1000 : 256) || '-';
}
function render({ spec, snapshot, generatedAt = new Date().toISOString() }) {
  if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length > M.LIMITS.groups || snapshot.rows.length !== snapshot.summary?.groups
    || !snapshot.query || !snapshot.coverage || !Array.isArray(snapshot.buckets)) C.fail('BWL_ABC_PDF_INTEGRITY', 409);
  // Normalized specs are server-created. Never accept a custom column object or
  // client rows through the HTTP API, even when their labels look plausible.
  if (!Array.isArray(spec.columns) || !spec.columns.length || spec.columns.some(column => !M.COLUMNS.some(c => c.id === column.id))) C.fail('BWL_ABC_PDF_OPTIONS');
  const rows = sortedRows(snapshot.rows, spec.sort, spec.direction);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: spec.orientation, margin: 0, bufferPages: true, autoFirstPage: false, compress: true,
      info: { Title: spec.title, Author: 'Grabenplaner', Subject: 'ABC-Analyse geprüfter importierter Kassenpositionen', CreationDate: new Date(generatedAt), ModDate: new Date(generatedAt) } });
    const chunks = []; let bytes = 0, settled = false;
    doc.on('data', chunk => { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) { settled = true; doc.destroy(); reject(Object.assign(Error('BWL_ABC_PDF_LIMIT'), { code: 'BWL_ABC_PDF_LIMIT', status: 413 })); } else chunks.push(chunk); });
    doc.on('error', reject); doc.on('end', () => { if (!settled) resolve({ buffer: Buffer.concat(chunks), pages: doc.bufferedPageRange().count, rows: rows.length, name: spec.name }); });
    try {
      const directory = path.join(__dirname, '../public/fonts/price-labels/roboto');
      if (fs.existsSync(path.join(directory, 'Regular.ttf')) && fs.existsSync(path.join(directory, 'Bold.ttf'))) {
        doc.registerFont('Regular', path.join(directory, 'Regular.ttf')); doc.registerFont('Bold', path.join(directory, 'Bold.ttf'));
      } else { doc.registerFont('Regular', 'Helvetica'); doc.registerFont('Bold', 'Helvetica-Bold'); }
      const size = spec.orientation === 'portrait' ? { width: 595.28, height: 841.89 } : { width: 841.89, height: 595.28 };
      const left = 32, width = size.width - 64, bottom = size.height - 54;
      const colors = { ink: '#1c2b33', green: '#245748', muted: '#687976', line: '#dbe4df', header: '#edf3ef', stripe: '#f8faf8' };
      const minWidths = { rank: 25, class: 25, articleNumber: 48, description: 85, location: 44, quantity: 40, netRevenue: 68, grossMargin: 68, sharePercent: 46, cumulativePercent: 48, rankingStatus: 61 };
      const totalMinimum = spec.columns.reduce((sum, c) => sum + minWidths[c.id], 0);
      const surplus = Math.max(0, width - totalMinimum), weight = spec.columns.reduce((sum, c) => sum + c.width, 0);
      const scale = totalMinimum > width ? width / totalMinimum : 1;
      const labels = { rank: spec.orientation === 'portrait' ? 'Rg.' : 'Rang', articleNumber: 'Artikel-Nr.', quantity: 'Menge', sharePercent: 'Anteil %', cumulativePercent: 'Kumuliert %', rankingStatus: 'Prüfung' };
      const columns = spec.columns.map(c => ({ ...c, width: minWidths[c.id] * scale + surplus * c.width / weight, label: labels[c.id] || c.label }));
      const font = totalMinimum > width ? 7 : 8, padding = 5;
      doc.font('Bold').fontSize(font);
      const headerHeight = Math.max(27, ...columns.map(c => doc.heightOfString(c.label, { width: c.width - padding * 2 }) + 12));
      let y = 0, pageNumber = 0;
      const localDate = value => { const date = new Date(value); return Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Nicht hinterlegt'; };
      const period = `${snapshot.query.dateFrom.split('-').reverse().join('.')} - ${snapshot.query.dateTo.split('-').reverse().join('.')}`;
      const metric = snapshot.query.metric === 'grossMargin' ? 'Rohertrag' : 'Umsatz netto';
      function tableHeader() {
        doc.rect(left, y, width, headerHeight).fill(colors.header); let x = left;
        for (const column of columns) { doc.font('Bold').fontSize(font).fillColor(colors.green).text(column.label, x + padding, y + 6,
          { width: column.width - padding * 2, height: headerHeight - 10 }); x += column.width; } y += headerHeight;
      }
      function page(first = false) {
        doc.addPage(); pageNumber++;
        doc.font('Bold').fontSize(7).fillColor(colors.green).text('VERKAUF - BETRIEBSWIRTSCHAFT', left, 27, { width, height: 12 });
        doc.fontSize(18).fillColor(colors.ink).text(spec.title, left, 43, { width, height: 45, ellipsis: true });
        doc.font('Regular').fontSize(8).fillColor(colors.muted).text(`${period} · ${metric} · ${snapshot.query.locationIds.length} Filiale(n) · ${rows.length} Artikel-Filial-Zeilen`, left, 93, { width, height: 12 });
        y = 114;
        if (first) {
          const cardWidth = (width - 16) / 3;
          for (const [index, id] of ['A', 'B', 'C'].entries()) {
            const data = snapshot.summary.classes[id], x = left + index * (cardWidth + 8);
            doc.roundedRect(x, y, cardWidth, 45, 4).fill(colors.header); doc.font('Bold').fontSize(12).fillColor(colors.green).text(id, x + 9, y + 7, { width: 20, height: 16 });
            doc.font('Regular').fontSize(8).fillColor(colors.ink).text(`${data.count} Artikel-Filial-Zeilen`, x + 30, y + 7, { width: cardWidth - 38, height: 13 });
            doc.fillColor(colors.muted).text(`${data.sharePercent === null ? '-' : decimalText(data.sharePercent) + ' %'} des positiven Wertbeitrags`, x + 9, y + 26, { width: cardWidth - 18, height: 12 });
          }
          y += 55;
          doc.font('Regular').fontSize(8).fillColor(colors.ink).text(`Positive Rangbasis: ${decimalText(snapshot.summary.positiveBasis, true)} · ${snapshot.summary.ranked} gereiht · ${snapshot.summary.unranked} ohne Rang`, left, y, { width, height: 16 }); y += 19;
          doc.fillColor(colors.muted).fontSize(7.3).text('A bis ' + snapshot.query.aLimit + ' %, B bis ' + snapshot.query.bLimit + ' %; grenzüberschreitende Zeilen bleiben in der vorherigen Klasse. Nur positive, geprüfte Artikelbeiträge bilden die Rangbasis.', left, y, { width, height: 25 }); y += 29;
        }
        tableHeader();
      }
      page(true);
      for (let index = 0; index < rows.length; index++) {
        const values = columns.map(c => cell(rows[index], c)); doc.font('Regular').fontSize(font);
        const height = Math.max(24, ...values.map((value, i) => doc.heightOfString(value, { width: columns[i].width - padding * 2 }) + 12));
        if (height > bottom - y) page();
        if (height > bottom - y) C.fail('BWL_ABC_PDF_ROW_TOO_LONG', 413);
        if (index % 2) doc.rect(left, y, width, height).fill(colors.stripe); let x = left;
        for (let i = 0; i < columns.length; i++) {
          doc.font('Regular').fontSize(font).fillColor(columns[i].id === 'class' ? colors.green : colors.ink).text(values[i], x + padding, y + 6,
            { width: columns[i].width - padding * 2, height: height - 10, align: NUMERIC.has(columns[i].id) ? 'right' : 'left' }); x += columns[i].width;
        }
        doc.moveTo(left, y + height).lineTo(left + width, y + height).lineWidth(.35).strokeColor(colors.line).stroke(); y += height;
      }
      if (!rows.length) { doc.font('Regular').fontSize(10).fillColor(colors.muted).text('Keine Artikel-Filial-Zeilen für die gewählte Auswertung.', left, y + 16, { width, height: 20 }); y += 50; }
      function note(text, bold = false) {
        doc.font(bold ? 'Bold' : 'Regular').fontSize(8); const h = doc.heightOfString(text, { width }) + 6;
        if (h > bottom - y) { page(); y += 8; }
        doc.font(bold ? 'Bold' : 'Regular').fontSize(8).fillColor(bold ? colors.green : colors.muted).text(text, left, y, { width, height: h }); y += h;
      }
      y += 16; note('Datengrundlage und gesonderte Positionen', true);
      note(M.COVERAGE.label); note('Prüffälle und nicht positive Beiträge bleiben ohne Rang. Bei Bewertung nach Rohertrag bleiben fehlende Roherträge ebenfalls ohne Rang. Retouren werden mit ihrem Vorzeichen verrechnet. Historische Artikelnummern werden exakt beibehalten; aktuelle Preise oder Einkaufskosten ersetzen keine fehlenden historischen Werte.');
      const bucketLabels = { adjustment: 'Verrechnungen', deposit: 'Anzahlungen', excluded: 'Ausgeschlossen', payment: 'Zahlungen', voucher_issue: 'Gutscheinausgaben', uid_clearing: 'UID-Verrechnungen', 'unidentified-article': 'Artikel nicht eindeutig', review: 'Belegprüfung offen' };
      for (const bucket of snapshot.buckets) note(`${bucketLabels[bucket.id] || bucket.id}: ${bucket.positions} ${bucket.positions === 1 ? 'Position' : 'Positionen'} · ${bucket.netRevenue === null ? 'Nettobetrag nicht vollständig geprüft' : decimalText(bucket.netRevenue, true)}.`);
      const range = doc.bufferedPageRange();
      for (let index = range.start; index < range.start + range.count; index++) {
        doc.switchToPage(index); const footer = size.height - 42;
        doc.moveTo(left, footer - 6).lineTo(left + width, footer - 6).lineWidth(.5).strokeColor(colors.line).stroke();
        doc.font('Regular').fontSize(6.5).fillColor(colors.muted).text(`Grabenplaner · ABC-Analyse · Quelle: ${localDate(snapshot.sourceAt)} · Erstellt: ${localDate(generatedAt)}`, left, footer, { width: width - 62, height: 14 });
        doc.font('Bold').text(`${index - range.start + 1} / ${range.count}`, size.width - 88, footer, { width: 56, height: 12, align: 'right' });
        doc.font('Regular').fontSize(6.2).text('Geprüfter Importstand; Zeitraumvollständigkeit nicht nachgewiesen. Fehlende Werte: Prüfen.', left, footer + 14, { width, height: 11 });
      }
      // bufferedPageRange becomes empty after doc.end(), so preserve the count.
      const pages = range.count;
      doc.removeAllListeners('end'); doc.on('end', () => { if (!settled) resolve({ buffer: Buffer.concat(chunks), pages, rows: rows.length, name: spec.name }); }); doc.end();
    } catch (error) { settled = true; doc.destroy(); reject(error); }
  });
}
module.exports = { normalize, render, filename, plain, cell, sortedRows, compareDecimal, decimalText };
