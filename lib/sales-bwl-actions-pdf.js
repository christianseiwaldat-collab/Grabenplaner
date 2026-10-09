'use strict';
const fs = require('node:fs'), path = require('node:path'), PDFDocument = require('pdfkit');
const C = require('./data-import-contract'), M = require('./sales-bwl-actions-model');
const MAX_COLUMNS = 8;
const plain = value => String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  .replace(/[\u2010-\u2015\u2212]/g, '-').trim();
function filename(value) { return (plain(value).replace(/[<>:"/\\|?*\n]/g, '-').replace(/\.pdf$/i, '').replace(/^[. -]+|[. -]+$/g, '') || 'Filialmaßnahmen') + '.pdf'; }
function normalize(input, caps) {
  C.exact(input, ['query', 'title', 'name', 'orientation', 'columns']); C.exact(input.query, ['locationId', 'status', 'query', 'sort', 'direction']);
  const query = M.normalizeQuery(input.query); delete query.limit; delete query.offset;
  for (const [id, max] of [['title', 160], ['name', 120]]) if (input[id] !== undefined && (typeof input[id] !== 'string' || input[id].length > max || /[\u0000-\u001f\u007f]/.test(input[id]))) C.fail('BWL_ACTIONS_PDF_OPTIONS');
  const orientation = input.orientation ?? 'landscape'; if (!['portrait', 'landscape'].includes(orientation)) C.fail('BWL_ACTIONS_PDF_OPTIONS');
  const prefs = M.normalizePreferences({ ...(input.columns === undefined ? {} : { columns: input.columns }) }, caps);
  if (prefs.columns.length > MAX_COLUMNS) C.fail('BWL_ACTIONS_PDF_COLUMNS_LIMIT');
  return { query, title: plain(input.title || 'Filialmaßnahmen') || 'Filialmaßnahmen', name: filename(input.name || 'Filialmaßnahmen'), orientation,
    columns: prefs.columns.map(id => M.COLUMNS.find(column => column.id === id)) };
}
function date(value, time = false) {
  if (!value) return '-';
  if (!time && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('.');
  const d = new Date(value); return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'medium', ...(time ? { timeStyle: 'short' } : {}) }).format(d) : '-';
}
function cell(row, column) {
  const value = row[column.id]; if (value === null || value === undefined || value === '') return '-';
  if (column.id === 'status') return M.STATUSES.find(s => s.id === value)?.label || 'Prüfen';
  if (column.id === 'priority') return M.PRIORITIES.find(p => p.id === value)?.label || 'Prüfen';
  if (column.id === 'dueDate' || column.id === 'updatedAt') return date(value, column.id === 'updatedAt');
  if (column.id === 'source') return [value.kind === 'abc' ? 'ABC-Analyse' : 'Artikel / Bestand', value.label, value.reason, 'Stand: ' + date(value.sourceAt, true)].filter(Boolean).map(plain).join('\n');
  return plain(value);
}
function validateRows(rows, locationId) {
  if (!Array.isArray(rows) || rows.length > M.LIMITS.perLocation || new Set(rows.map(row => row.id)).size !== rows.length) C.fail('BWL_ACTIONS_PDF_INTEGRITY', 409);
  for (const row of rows) {
    M.uuid(row.id); if (row.locationId !== locationId) C.fail('BWL_ACTIONS_FORBIDDEN', 403); C.text(row.title, M.LIMITS.title); C.integer(row.version, 1, Number.MAX_SAFE_INTEGER - 1);
    if (!M.STATUSES.some(s => s.id === row.status) || !M.PRIORITIES.some(p => p.id === row.priority)) C.fail('BWL_ACTIONS_PDF_INTEGRITY', 409);
    C.utc(row.updatedAt); if (row.source !== null) M.validateSourceRecord(row.source);
    if (row.note !== null && (typeof row.note !== 'string' || row.note.length > M.LIMITS.note || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.note))) C.fail('BWL_ACTIONS_PDF_INTEGRITY', 409);
  }
}
// Wrap all content explicitly, including a long unbroken token. Each line is
// later painted independently, so an oversized note can continue on new pages.
function wrap(doc, text, width) {
  const lines = [];
  for (const paragraph of plain(text).split('\n')) {
    let line = '';
    for (const original of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && doc.widthOfString(line + ' ' + original) <= width) { line += ' ' + original; continue; }
      if (line) { lines.push(line); line = ''; }
      let word = Array.from(original);
      while (word.length && doc.widthOfString(word.join('')) > width) {
        let left = 1, right = word.length;
        while (left < right) { const middle = Math.ceil((left + right) / 2); if (doc.widthOfString(word.slice(0, middle).join('')) <= width) left = middle; else right = middle - 1; }
        if (doc.widthOfString(word.slice(0, left).join('')) > width) C.fail('BWL_ACTIONS_PDF_OPTIONS');
        lines.push(word.slice(0, left).join('')); word = word.slice(left);
      }
      line = word.join('');
    }
    lines.push(line);
  }
  return lines.length ? lines : ['-'];
}
function render({ spec, rows, location, generatedAt = new Date().toISOString() }) {
  if (!spec || !Array.isArray(spec.columns) || !spec.columns.length || spec.columns.length > MAX_COLUMNS || !['portrait', 'landscape'].includes(spec.orientation)
    || spec.columns.some(column => !M.COLUMNS.some(c => C.canonical(c) === C.canonical(column)))) C.fail('BWL_ACTIONS_PDF_OPTIONS');
  validateRows(rows, spec.query.locationId); C.exact(location, ['id', 'label']); if (location.id !== spec.query.locationId) C.fail('BWL_ACTIONS_FORBIDDEN', 403); C.text(location.label, 200); C.utc(generatedAt);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: spec.orientation, margin: 0, bufferPages: true, autoFirstPage: false,
      info: { Title: spec.title, Author: 'Grabenplaner', Subject: 'Manuelle Filialmaßnahmen mit dokumentierten Quellenhinweisen', CreationDate: new Date(generatedAt), ModDate: new Date(generatedAt) } });
    const chunks = []; let bytes = 0, settled = false;
    doc.on('data', chunk => { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) { settled = true; doc.destroy(); reject(Object.assign(Error('BWL_ACTIONS_PDF_LIMIT'), { code: 'BWL_ACTIONS_PDF_LIMIT', status: 413 })); } else chunks.push(chunk); }); doc.on('error', reject);
    try {
      const directory = path.join(__dirname, '../public/fonts/price-labels/roboto');
      if (fs.existsSync(path.join(directory, 'Regular.ttf')) && fs.existsSync(path.join(directory, 'Bold.ttf'))) {
        doc.registerFont('Regular', path.join(directory, 'Regular.ttf')); doc.registerFont('Bold', path.join(directory, 'Bold.ttf'));
      } else { doc.registerFont('Regular', 'Helvetica'); doc.registerFont('Bold', 'Helvetica-Bold'); }
      const pageSize = spec.orientation === 'portrait' ? { width: 595.28, height: 841.89 } : { width: 841.89, height: 595.28 };
      const left = 32, width = pageSize.width - 64, bottom = pageSize.height - 49, font = spec.orientation === 'portrait' ? 7.3 : 8, padding = 5, lineHeight = font * 1.38;
      const colors = { ink: '#1c2b33', green: '#245748', muted: '#687976', line: '#dbe4df', header: '#edf3ef', stripe: '#f8faf8' };
      const minimum = { title: 85, articleNumber: 51, priority: 40, status: 49, dueDate: 54, assigneeNumber: 59, source: 86, note: 100, updatedAt: 64 };
      const sum = spec.columns.reduce((s, c) => s + minimum[c.id], 0), surplus = Math.max(0, width - sum), scale = Math.min(1, width / sum), weight = spec.columns.reduce((s, c) => s + c.width, 0);
      const labels = { articleNumber: 'Artikel-Nr.', assigneeNumber: 'Personal-Nr.', updatedAt: 'Geändert am', source: 'Quellenhinweis' };
      const columns = spec.columns.map(c => ({ ...c, label: labels[c.id] || c.label, width: minimum[c.id] * scale + surplus * c.width / weight }));
      doc.font('Bold').fontSize(font); const headerLines = columns.map(c => wrap(doc, c.label, c.width - 2 * padding)), headerHeight = Math.max(27, Math.max(...headerLines.map(l => l.length)) * lineHeight + 12);
      let y;
      function page() {
        doc.addPage(); doc.font('Bold').fontSize(7).fillColor(colors.green).text('VERKAUF - BETRIEBSWIRTSCHAFT', left, 27, { width, height: 12 });
        doc.fontSize(17).fillColor(colors.ink); const titleHeight = doc.heightOfString(spec.title, { width }) + 4;
        doc.text(spec.title, left, 44, { width, height: titleHeight }); y = 48 + titleHeight;
        const status = M.STATUSES.find(s => s.id === spec.query.status)?.label || 'Alle Status';
        const filter = `${location.label} · ${rows.length} Maßnahmen · ${status}${spec.query.query ? ' · Suche: ' + spec.query.query : ''}`;
        doc.font('Regular').fontSize(8).fillColor(colors.muted); const filterHeight = doc.heightOfString(filter, { width }) + 7; doc.text(filter, left, y, { width, height: filterHeight }); y += filterHeight + 6;
        doc.rect(left, y, width, headerHeight).fill(colors.header); let x = left;
        columns.forEach((column, i) => { headerLines[i].forEach((line, n) => doc.font('Bold').fontSize(font).fillColor(colors.green).text(line, x + padding, y + 6 + n * lineHeight, { width: column.width - 2 * padding, height: lineHeight + 2, lineBreak: false })); x += column.width; }); y += headerHeight;
      }
      page();
      rows.forEach((row, index) => {
        doc.font('Regular').fontSize(font); const lines = columns.map(column => wrap(doc, cell(row, column), column.width - 2 * padding)), lineCount = Math.max(...lines.map(v => v.length));
        const fullHeight = Math.max(24, lineCount * lineHeight + 12);
        if (fullHeight > bottom - y && fullHeight <= bottom - 160) page();
        let offset = 0;
        while (offset < lineCount) {
          let count = Math.floor((bottom - y - 12) / lineHeight);
          if (count < 1) { page(); count = Math.floor((bottom - y - 12) / lineHeight); }
          if (count < 1) C.fail('BWL_ACTIONS_PDF_OPTIONS');
          count = Math.min(count, lineCount - offset); const height = Math.max(24, count * lineHeight + 12);
          if (height > bottom - y) { page(); continue; }
          if (index % 2) doc.rect(left, y, width, height).fill(colors.stripe); let x = left;
          columns.forEach((column, i) => { for (let n = 0; n < count; n++) if (lines[i][offset + n] !== undefined) {
            doc.font('Regular').fontSize(font).fillColor(column.id === 'status' ? colors.green : colors.ink).text(lines[i][offset + n], x + padding, y + 6 + n * lineHeight,
              { width: column.width - 2 * padding, height: lineHeight + 2, lineBreak: false });
          } x += column.width; });
          doc.moveTo(left, y + height).lineTo(left + width, y + height).lineWidth(.35).strokeColor(colors.line).stroke(); y += height; offset += count;
          if (offset < lineCount) {
            page(); doc.font('Bold').fontSize(7).fillColor(colors.muted);
            const continuation = 'Fortsetzung: ' + (row.articleNumber || row.title), continuationHeight = doc.heightOfString(continuation, { width }) + 9;
            doc.text(continuation, left + padding, y + 4, { width: width - 2 * padding, height: continuationHeight }); y += continuationHeight;
          }
        }
      });
      if (!rows.length) doc.font('Regular').fontSize(10).fillColor(colors.muted).text('Keine Maßnahmen für diese Auswahl.', left, y + 16, { width, height: 25 });
      const range = doc.bufferedPageRange();
      for (let index = range.start; index < range.start + range.count; index++) {
        doc.switchToPage(index); const footer = pageSize.height - 36;
        doc.moveTo(left, footer - 7).lineTo(left + width, footer - 7).lineWidth(.5).strokeColor(colors.line).stroke();
        doc.font('Regular').fontSize(6.4).fillColor(colors.muted).text(`Grabenplaner · Manuelle Filialmaßnahmen · Erstellt: ${date(generatedAt, true)}`, left, footer, { width: width - 60, height: 12 });
        doc.font('Bold').text(`${index - range.start + 1} / ${range.count}`, pageSize.width - 88, footer, { width: 56, height: 12, align: 'right' });
        doc.font('Regular').fontSize(6.2).text('Dokumentierter Arbeitsstand. Keine automatische Bestellung, Umlagerung oder Preisänderung.', left, footer + 12, { width, height: 11 });
      }
      const pages = range.count; doc.on('end', () => { if (!settled) resolve({ buffer: Buffer.concat(chunks), pages, rows: rows.length, name: spec.name }); }); doc.end();
    } catch (error) { settled = true; doc.destroy(); reject(error); }
  });
}
module.exports = { normalize, render, filename, cell, date, wrap, validateRows, MAX_COLUMNS };
