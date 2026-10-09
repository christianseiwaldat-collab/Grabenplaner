'use strict';

const PDFDocument = require('pdfkit');
const path = require('node:path');
const sharp = require('sharp');
const SECTIONS = Object.freeze([
  { id: 'master', label: 'Stammdaten' }, { id: 'prices', label: 'Preise' },
  { id: 'notes', label: 'Notizen' }, { id: 'identifiers', label: 'Kennungen & Verlauf' },
  { id: 'movements', label: 'Umlagerungen' }, { id: 'sales', label: 'Verkäufe' },
].map(Object.freeze));
const MAX_ROWS = 1000, MAX_PAGES = 600, MAX_BYTES = 32 * 1024 * 1024;
class SalesArticleSheetPdfError extends Error {
  constructor(message, code = 'ARTICLE_SHEET_OPTIONS', status = 400) {
    super(message); this.name = 'SalesArticleSheetPdfError'; this.code = code; this.status = status;
  }
}
function normalizeArticleSheetOptions(value = {}) {
  if (!value || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !['sections', 'includeImage', 'title', 'orientation'].includes(key))) throw new SalesArticleSheetPdfError('Die PDF-Auswahl ist ungültig.');
  const sections = value.sections === undefined ? ['master'] : value.sections;
  if (!Array.isArray(sections) || !sections.length || sections.length > SECTIONS.length
    || sections.some(section => !SECTIONS.some(known => known.id === section))
    || new Set(sections).size !== sections.length || value.includeImage !== undefined && typeof value.includeImage !== 'boolean') {
    throw new SalesArticleSheetPdfError('Bitte mindestens einen gültigen Reiter für das Artikelstammblatt auswählen.');
  }
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 160 || /[\u0000-\u001f\u007f]/u.test(value.title))) {
    throw new SalesArticleSheetPdfError('Bitte einen gültigen PDF-Titel mit höchstens 160 Zeichen eingeben.');
  }
  if (value.orientation !== undefined && !['portrait', 'landscape'].includes(value.orientation)) throw new SalesArticleSheetPdfError('Bitte Hoch- oder Querformat wählen.');
  // Preserve the existing default shape for older callers and saved selections.
  return { sections: SECTIONS.map(section => section.id).filter(section => sections.includes(section)), includeImage: value.includeImage === true,
    ...(value.title?.trim() ? { title: value.title.trim() } : {}), ...(value.orientation === undefined ? {} : { orientation: value.orientation }) };
}
const clean = value => String(value ?? '').replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/[\u2010-\u2015]/g, '-');
const shown = value => value === null || value === undefined || value === '' ? '-' : clean(value);
const number = (value, digits = 2) => {
  if (value === null || value === undefined || value === '') return '-';
  const source = String(typeof value === 'object' ? value.amount : value), match = /^(-?)(\d{1,309})(?:\.(\d{1,324}))?$/.exec(source);
  if (!match) return '-';
  const scale = (match[3] || '').length, absolute = BigInt(match[2] + (match[3] || ''));
  const divisor = 10n ** BigInt(scale), scaled = absolute * 10n ** BigInt(digits);
  const rounded = scaled / divisor + (scaled % divisor * 2n >= divisor ? 1n : 0n);
  const text = rounded.toString().padStart(digits + 1, '0'), whole = (digits ? text.slice(0, -digits) : text).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (match[1] && rounded ? '-' : '') + whole + (digits ? ',' + text.slice(-digits) : '');
};
const money = value => value == null || number(value) === '-' ? '-' : number(value) + ' €' + (value?.sourceValue ? ' *' : '');
const percent = value => value == null || number(value) === '-' ? '-' : number(value) + ' %';
function date(value, withTime = false) {
  if (!value) return '-';
  const stamp = new Date(value);
  if (!Number.isFinite(stamp.getTime())) return '-';
  return new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(stamp);
}
function duration(value) {
  if (!Number.isFinite(value) || value < 0) return 'nicht ermittelt';
  return value < 1000 ? Math.round(value) + ' ms' : value < 60000 ? (value / 1000).toLocaleString('de-AT', { maximumFractionDigits: 2 }) + ' s'
    : Math.floor(value / 60000) + ' min ' + Math.round(value % 60000 / 1000) + ' s';
}

async function createSalesArticleSheetPdf(model, value = {}) {
  const options = normalizeArticleSheetOptions(value), article = model?.article;
  if (!article || typeof article.articleNumber !== 'string' || !article.articleNumber.trim()) throw new SalesArticleSheetPdfError('Der Artikel fehlt im PDF-Ergebnisstand.', 'ARTICLE_SHEET_INPUT');
  let image;
  if (options.includeImage && model.imageBuffer) {
    if (!Buffer.isBuffer(model.imageBuffer) || model.imageBuffer.length > 50 * 1024) throw new SalesArticleSheetPdfError('Das Artikelbild ist für den Export ungültig.', 'ARTICLE_SHEET_IMAGE', 503);
    try { image = await sharp(model.imageBuffer, { limitInputPixels: 1280 * 1280 }).rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).png().toBuffer(); }
    catch { throw new SalesArticleSheetPdfError('Das Artikelbild konnte nicht in das PDF übernommen werden.', 'ARTICLE_SHEET_IMAGE', 503); }
  }
  const generatedAt = model.generatedAt || new Date().toISOString();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: options.orientation || 'landscape', margin: 32, bufferPages: true, autoFirstPage: false,
      info: { Title: clean(options.title || 'Artikelstammblatt ' + article.articleNumber), Author: 'Grabenplaner', Subject: 'Artikelstamm und freigegebene Historien' } });
    doc.registerFont('Regular', path.join(__dirname, 'pdf-fonts/Roboto-Regular.ttf'));
    doc.registerFont('Bold', path.join(__dirname, 'pdf-fonts/Roboto-Bold.ttf'));
    const chunks = []; let bytes = 0, y = 0, pages = 0;
    doc.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) doc.destroy(new SalesArticleSheetPdfError('Das Artikelstammblatt ist zu groß.', 'ARTICLE_SHEET_LIMIT', 413)); else chunks.push(chunk); });
    doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    const left = 32; let width = 0, bottom = 0;
    const font = (bold = false, size = 8.5, color = '#233e37') => doc.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor(color);
    function page() {
      if (++pages > MAX_PAGES) throw new SalesArticleSheetPdfError('Das Artikelstammblatt ist zu umfangreich.', 'ARTICLE_SHEET_LIMIT', 413);
      doc.addPage(); width = doc.page.width - left * 2; bottom = doc.page.height - 72;
      doc.rect(left, 24, width, 24).fill('#e8f0ed');
      font(true, 9).text('GRABENPLANER  /  ARTIKELSTAMMBLATT', left + 10, 31, { lineBreak: false });
      font(false, 8).text('Artikel ' + clean(article.articleNumber), left + width - 220, 31, { width: 210, align: 'right', lineBreak: false }); y = 62;
    }
    function lines(value, maxWidth, bold = false, size = 8.5) {
      font(bold, size);
      const result = [];
      for (const paragraph of clean(value).split('\n')) {
        let line = '';
        const words = paragraph.replace(/\t/g, '    ').split(/ +/);
        for (const word of words) {
          if (!word) continue;
          const candidate = line ? line + ' ' + word : word;
          if (doc.widthOfString(candidate) <= maxWidth) { line = candidate; continue; }
          if (line) { result.push(line); line = ''; }
          // Split a long unbroken token by Unicode characters, preserving all text.
          for (const character of word) {
            if (line && doc.widthOfString(line + character) > maxWidth) { result.push(line); line = ''; }
            line += character;
          }
        }
        result.push(line);
      }
      return result;
    }
    function block(value, { bold = false, size = 9, color = '#233e37', gap = 8, maxWidth = width } = {}) {
      const wrapped = lines(value, maxWidth, bold, size), lineHeight = size * 1.32;
      for (const line of wrapped) {
        if (y + lineHeight > bottom) page();
        font(bold, size, color).text(line, left, y, { width: maxWidth, lineBreak: false }); y += lineHeight;
      }
      y += gap;
    }
    function heading(title) {
      if (y + 85 > bottom) page();
      y += 8; block(title, { bold: true, size: 13, gap: 11 });
    }
    function table(columns, rows) {
      // Keep short dates, identities and numeric values legible in portrait too.
      // Reserve their minimum width, then share the remaining space by weight.
      const minimums = columns.map(column => column.label === 'Datum' ? 58 : column.label === 'Pos.' ? 30
        : column.label === 'Anzahl' ? 43 : ['Artikelnummer', 'Artikelnr.'].includes(column.label) ? 52
        : column.label === 'Filial-ID' || column.label === 'Beleg' ? 34 : column.align === 'right' ? 56 : 12);
      const widths = columns.map(() => 0), flexible = new Set(columns.map((_, index) => index)); let remaining = width;
      while (flexible.size) {
        const total = [...flexible].reduce((sum, index) => sum + (columns[index].weight || 1), 0);
        const narrow = [...flexible].filter(index => remaining * (columns[index].weight || 1) / total < minimums[index]);
        if (!narrow.length) { for (const index of flexible) widths[index] = remaining * (columns[index].weight || 1) / total; break; }
        for (const index of narrow) { widths[index] = minimums[index]; remaining -= widths[index]; flexible.delete(index); }
      }
      const lineHeight = 10.8;
      const wrapped = values => values.map((cell, index) => lines(shown(cell), widths[index] - 12, false, 8));
      function paint(values, height, header, stripe) {
        if (header || stripe) doc.rect(left, y, width, height).fill(header ? '#e8f0ed' : '#f7f9f8');
        let x = left;
        values.forEach((cellLines, index) => {
          cellLines.forEach((line, lineIndex) => font(header, 8).text(line, x + 6, y + 5 + lineIndex * lineHeight,
            { width: widths[index] - 12, align: columns[index].align || 'left', lineBreak: false }));
          x += widths[index];
        });
        y += height; doc.moveTo(left, y).lineTo(left + width, y).lineWidth(.35).strokeColor('#d5dfdb').stroke();
      }
      const compactLabels = options.orientation === 'portrait' ? { 'Artikelnummer': 'Artikelnr.', 'Personalnr. / Nachname': 'Pers.\nName',
        'Kundennr.': 'Kdnr.', 'Kundenname': 'Name', 'Gerätenr.': 'Gerät', 'Tatsächlicher VK brutto': 'Ist-VK brutto',
        'Tatsächlicher RE netto €': 'Ist-RE netto €', 'Tatsächlicher RE %': 'Ist-RE %' } : {};
      const headers = columns.map((column, index) => lines(compactLabels[column.label] || column.label, widths[index] - 12, true, 8));
      const headerHeight = Math.max(...headers.map(value => value.length)) * lineHeight + 10;
      function header() { if (y + headerHeight + lineHeight + 10 > bottom) page(); paint(headers, headerHeight, true, false); }
      header();
      rows.forEach((row, index) => {
        const values = wrapped(row), count = Math.max(...values.map(cell => cell.length)); let offset = 0;
        const fullHeight = count * lineHeight + 10;
        if (y + fullHeight > bottom && fullHeight <= bottom - 62 - headerHeight) { page(); header(); }
        while (offset < count) {
          let fit = Math.floor((bottom - y - 10) / lineHeight);
          if (fit < 1) { page(); header(); fit = Math.floor((bottom - y - 10) / lineHeight); }
          const length = Math.min(fit, count - offset);
          paint(values.map(cell => cell.slice(offset, offset + length)), length * lineHeight + 10, false, index % 2 === 0);
          offset += length;
          if (offset < count) { page(); header(); }
        }
      }); y += 12;
    }
    function sourceSection(title, fields) {
      if (!fields?.length) return; heading(title);
      table([{ label: 'Feld', weight: 1.3 }, { label: 'Wert', weight: 4.7 }], fields.map(field => [field.label, field.value + (field.title ? ' - ' + field.title : '')]));
    }
    function historyIntro(history) {
      if (!history) { block('Diese Historie wurde für den Export nicht geladen.'); return []; }
      if (history.dateFrom || history.dateTo) block('Zeitraum: ' + date(history.dateFrom) + ' bis ' + date(history.dateTo), { size: 8 });
      if (history.filterLabels?.length) block(history.filterLabels.map(filter => filter.label + ': ' + filter.value).join('  |  '), { size: 8 });
      if (history.note) block(history.note, { size: 8, color: '#64786f' });
      const rows = Array.isArray(history.rows) ? history.rows.slice(0, MAX_ROWS) : [];
      if (history.truncated || history.next || history.complete === false || (history.rows?.length || 0) > MAX_ROWS) {
        block(`Auszug: ${rows.length} Positionen. Weitere Ergebnisse sind vorhanden; den Zeitraum für einen vollständigen Auszug eingrenzen.`, { bold: true, size: 8 });
      }
      if (!rows.length) block(history.emptyReason || (history.available === false ? 'Noch keine übernommenen Daten für diese Historie verfügbar.' : 'Keine Treffer für diese Auswahl.'));
      return rows;
    }
    try {
      page(); block(options.title || 'Artikel ' + article.articleNumber, { bold: true, size: 20, gap: 8, maxWidth: image ? width - 175 : width });
      if (options.title) block('Artikel ' + article.articleNumber, { size: 10, gap: 8, maxWidth: image ? width - 175 : width });
      const heroY = y;
      if (image) doc.image(image, left + width - 158, heroY - 30, { fit: [150, 105], align: 'center', valign: 'center' });
      block(article.description || '-', { bold: true, size: 12, maxWidth: image ? width - 175 : width });
      block((article.active ? 'Aktiv' : 'Archiviert / inaktiv') + '  |  Revision ' + shown(article.currentRevision), { size: 8, maxWidth: image ? width - 175 : width });
      if (image) y = Math.max(y, heroY + 82);
      block('Auswahl: ' + options.sections.map(id => SECTIONS.find(section => section.id === id).label).join('  /  '), { size: 8, color: '#64786f' });
      for (const section of options.sections) {
        if (section === 'master') {
          heading('Stammdaten');
          table([{ label: 'Artikelnummer' }, { label: 'Bezeichnung', weight: 3 }, { label: 'Status' }], [[article.articleNumber, article.description, article.active ? 'Aktiv' : 'Archiviert / inaktiv']]);
          for (const group of article.sourceSections || []) sourceSection(group.title, group.fields);
          const stock = article.branchStock;
          if (stock?.rows?.length) {
            heading('Filialbestand'); if (stock.sourceAt) block('Datenstand: ' + date(stock.sourceAt, true), { size: 8 });
            table([{ label: 'Filial-ID' }, { label: 'Filiale', weight: 3 }, { label: 'Bestand', align: 'right' }],
              stock.rows.slice(0, 100).map(row => [row.id, row.name || 'Nicht zugeordnet', row.ambiguous ? 'Zuordnung prüfen' : number(row.quantity, 3)]));
          }
        } else if (section === 'prices') {
          heading('Preise'); const matrix = article.priceMatrix;
          if (matrix?.purchase?.length) {
            block('EK-Preise', { bold: true });
            table([{ label: 'Preisart', weight: 2 }, { label: 'Aktuell', align: 'right' }, { label: 'Zukunft', align: 'right' }], matrix.purchase.map(row => [row.label, row.current?.unit === 'number' ? number(row.current, 3) + ' *' : money(row.current), money(row.future)]));
            if (matrix.purchaseDate) block('EK-Datum: ' + date(matrix.purchaseDate) + '  |  WKZ: ' + shown(matrix.wkz) + '  |  WKZ-Art: ' + shown(matrix.wkzType), { size: 8 });
          }
          if (matrix?.sales?.length) {
            block('VK-Preise', { bold: true });
            const columns = [{ label: 'Preisart', weight: 1.2 }, { label: 'Brutto-VK', align: 'right' }, { label: 'Netto-VK', align: 'right' },
              ...(matrix.costsRead ? [{ label: 'RE netto €', align: 'right' }, { label: 'RE %', align: 'right' }] : []),
              { label: 'Abschlag UVP %', align: 'right' }, { label: 'Datum / Person', weight: 1.3 }];
            table(columns, matrix.sales.map(row => [row.label, money(row.gross), money(row.net), ...(matrix.costsRead ? [money(row.margin), percent(row.marginPercent)] : []), percent(row.discountPercent), date(row.date) + ' / ' + shown(row.person)]));
          }
          if (!matrix?.sales?.length && !matrix?.purchase?.length) block('Keine freigegebenen Preise verfügbar.');
          if ([...(matrix?.sales || []), ...(matrix?.purchase || [])].some(row => row.gross?.sourceValue || row.net?.sourceValue || row.current?.sourceValue || row.future?.sourceValue)) block('* Importierter Quellwert; Preisbasis beziehungsweise Bedeutung noch nicht bestätigt.', { size: 8 });
        } else if (section === 'notes') {
          heading('Eigene GP-Notizen');
          const local = model.localNotes?.items || [];
          if (!local.length) block('Noch keine eigenen GP-Notizen hinterlegt.');
          local.slice(0, 200).forEach(note => { if (y + 45 > bottom) page(); block(date(note.createdAt, true) + '  |  Personalnummer ' + shown(note.author), { bold: true, size: 8 }); block(note.text, { size: 9, gap: 12 }); });
          block('Eigene GP-Notizen bleiben bei einer Aktualisierung der Trade-Daten erhalten.', { size: 8, color: '#64786f' });
          heading('Notizen aus Trade'); const imported = article.notes;
          if (!imported?.items?.length) block(imported?.available ? 'Keine Notizen im übernommenen Trade-Stand.' : 'Noch keine Trade-Notizen übernommen.');
          if (imported?.sourceAt) block('Trade-Datenstand: ' + date(imported.sourceAt, true), { size: 8 });
          if ((imported?.items?.length || 0) > 1000) block('Auszug: Die ersten 1000 Trade-Notizen sind enthalten.', { bold: true, size: 8 });
          (imported?.items || []).slice(0, 1000).forEach(note => { if (y + 45 > bottom) page(); block(date(note.date) + '  |  Personalnummer ' + shown(note.person), { bold: true, size: 8 }); block(note.text, { size: 9, gap: 12 }); });
        } else if (section === 'identifiers') {
          heading('Kennungen'); const identifiers = article.identifiers || [];
          if (identifiers.length) table([{ label: 'Art' }, { label: 'Kennung', weight: 3 }, { label: 'Primär' }, { label: 'Verifiziert am', weight: 2 }], identifiers.map(row => [row.identifierType, row.identifierValue, row.isPrimary ? 'Ja' : 'Nein', date(row.verifiedAt, true)]));
          else block('Keine Kennungen hinterlegt.');
          sourceSection('Herkunft', Object.entries(article.provenance || {}).map(([key, val]) => ({ label: { originSourceSystem: 'Ursprüngliche Quelle', currentSourceSystem: 'Aktuelle Quelle', sourceUpdatedAt: 'Quelländerung', createdAt: 'Im GP angelegt', updatedAt: 'Im GP aktualisiert' }[key] || key,
            value: key.endsWith('At') ? date(val, true) : shown(val) })));
          heading('Verlauf'); const revisions = model.revisions || [];
          if (revisions.length) table([{ label: 'Revision' }, { label: 'Datum', weight: 1.3 }, { label: 'Artikelnummer' }, { label: 'Bezeichnung', weight: 3 }, { label: 'Status' }], revisions.slice(0, 1000).map(row => [row.revision, date(row.createdAt, true), row.articleNumber, row.description, row.active ? 'Aktiv' : 'Archiviert / inaktiv']));
          else block('Kein weiterer Verlauf hinterlegt.');
        } else if (section === 'movements') {
          heading('Umlagerungen'); const rows = historyIntro(model.movements);
          if (rows.length) table([{ label: 'Datum' }, { label: 'Artikelnummer' }, { label: 'Anzahl', align: 'right', weight: .7 }, { label: 'Artikelbezeichnung', weight: 2.5 }, { label: 'Von Filiale', weight: 1.3 }, { label: 'Zu Filiale', weight: 1.3 }, { label: 'Belegverweise', weight: 1.7 }, { label: 'Hinweise', weight: 1.5 }],
            rows.map(row => [date(row.date), row.articleNumber, number(row.quantity, 3), row.label || row.description, row.from, row.to, row.documentRefs, row.issueLabel]));
        } else if (section === 'sales') {
          heading('Verkäufe'); const history = model.sales, rows = historyIntro(history);
          if (rows.length) {
            const sellers = history.capabilities?.sellers === true || history.columns?.sellers === true;
            const customers = history.capabilities?.customers === true || history.columns?.customers === true;
            const margin = history.capabilities?.margin === true || history.columns?.margin === true;
            const core = [{ label: 'Pos.', weight: .4 }, { label: 'Datum', weight: .9 }, { label: 'Filial-ID', weight: .6 },
              ...(sellers ? [{ label: 'Personalnr. / Nachname', weight: 1.1 }] : []), { label: 'Artikelnr.', weight: .9 }, { label: 'Anzahl', weight: .6, align: 'right' }, { label: 'Artikelbezeichnung', weight: 2.3 },
              ...(customers ? [{ label: 'Kundennr.', weight: .9 }, { label: 'Kundenname', weight: 1.4 }] : []), { label: 'Gerätenr.', weight: 1 }, { label: 'Beleg', weight: .7 }];
            table(core, rows.map((row, index) => [index + 1, date(row.date), row.sourceLocationId || row.locationId,
              ...(sellers ? [shown(row.personnel) + (row.personnelSurname ? ' / ' + row.personnelSurname : '')] : []), row.articleNumber, number(row.quantity, 3), row.description,
              ...(customers ? [row.customerNumber, row.customerName] : []), row.deviceNumber, row.receipt]));
            heading('Verkäufe - Preise und Rohertrag je Stück');
            block('Die Positionsnummer verbindet diese Tabelle mit den Verkäufen oben. Soll-VK ist ein unbestätigter Quellwert. Fehlende historische Preis- und Kostenbasis wird nicht durch aktuelle Artikelpreise ersetzt.', { size: 8, color: '#64786f' });
            const pricing = [{ label: 'Pos.', weight: .5 }, { label: 'Soll-VK (Quellwert)', weight: 1.1, align: 'right' }, { label: 'VK brutto damals', weight: 1.1, align: 'right' },
              ...(margin ? [{ label: 'RE netto € damals', align: 'right' }, { label: 'RE % damals', align: 'right' }] : []), { label: 'Tatsächlicher VK brutto', weight: 1.2, align: 'right' },
              ...(margin ? [{ label: 'Tatsächlicher RE netto €', weight: 1.2, align: 'right' }, { label: 'Tatsächlicher RE %', weight: 1.1, align: 'right' }] : []), { label: 'Prüfung', weight: 1.5 }];
            table(pricing, rows.map((row, index) => [index + 1, money(row.listSourcePrice), money(row.listGross), ...(margin ? [money(row.listMargin), percent(row.listMarginPercent)] : []), money(row.actualGross),
              ...(margin ? [money(row.actualMargin), percent(row.actualMarginPercent)] : []), (row.issues || []).join(' / ') || ({ sale: 'Verkauf', return: 'Rücknahme', review: 'Prüfung erforderlich' }[row.status] || row.status)]));
          }
        }
      }
      const range = doc.bufferedPageRange(), durations = options.sections.filter(section => ['movements', 'sales'].includes(section))
        .map(section => `${section === 'movements' ? 'Umlagerungen' : 'Verkäufe'}: ${duration(model[section]?.durationMs)}`);
      for (let index = 0; index < range.count; index += 1) {
        doc.switchToPage(index); doc.page.margins.bottom = 0;
        const footerY = doc.page.height - 34;
        if (index === range.count - 1 && durations.length) font(false, 8, '#64786f').text('Abfragedauer - ' + durations.join('  |  '), left, doc.page.height - 56, { width, lineBreak: false });
        font(false, 8, '#64786f').text('Erstellt: ' + date(generatedAt, true) + ' (Wien)', left, footerY, { width: width - 160, lineBreak: false });
        font(false, 8, '#64786f').text(`Seite ${index + 1} / ${range.count}`, left + width - 150, footerY, { width: 150, align: 'right', lineBreak: false });
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}
module.exports = { createSalesArticleSheetPdf, normalizeArticleSheetOptions, ARTICLE_SHEET_SECTIONS: SECTIONS, SalesArticleSheetPdfError, MAX_ROWS };
