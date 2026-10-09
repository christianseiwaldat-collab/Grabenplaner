'use strict';
const fs = require('node:fs'), path = require('node:path');
const PDFDocument = require('pdfkit'), C = require('./data-import-contract'), D = require('./tradefoto-bestell/decimal');
const M = require('./sales-bwl-simulation-model');
const { SORTIMENTS } = require('./sales-article-report-model');
const MAX_COLUMNS = 8;
const plain = (value, max = 1000) => String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
function filename(value) { return (plain(value, 120).replace(/[<>:"/\\|?*]/g, '-').replace(/\.pdf$/i, '')
  .replace(/^[. -]+|[. -]+$/g, '') || 'Abverkaufs-Simulation') + '.pdf'; }
function uuid(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) C.fail('BWL_SIMULATION_PDF_OPTIONS'); return value.toLowerCase(); }
function normalize(input, caps) {
  C.exact(input, ['snapshotToken', 'variantId', 'version', 'title', 'name', 'orientation', 'columns', 'sort', 'direction', 'comparisonVariantId', 'comparisonVersion']);
  const token = input.snapshotToken !== undefined, variant = input.variantId !== undefined;
  if (token === variant || token && input.version !== undefined) C.fail('BWL_SIMULATION_PDF_OPTIONS');
  const selector = token ? { snapshotToken: C.text(input.snapshotToken, 16384) } : { variantId: uuid(input.variantId), version: C.integer(input.version, 1, Number.MAX_SAFE_INTEGER - 1) };
  const comparing = input.comparisonVariantId !== undefined;
  if (comparing !== (input.comparisonVersion !== undefined)) C.fail('BWL_SIMULATION_PDF_OPTIONS');
  if (comparing) { selector.comparisonVariantId = uuid(input.comparisonVariantId); selector.comparisonVersion = C.integer(input.comparisonVersion, 1, Number.MAX_SAFE_INTEGER - 1);
    if (selector.comparisonVariantId === selector.variantId) C.fail('BWL_SIMULATION_PDF_OPTIONS'); }
  for (const [id, max] of [['title', 160], ['name', 120]]) if (input[id] !== undefined
    && (typeof input[id] !== 'string' || input[id].length > max || /[\u0000-\u001f\u007f]/.test(input[id]))) C.fail('BWL_SIMULATION_PDF_OPTIONS');
  const orientation = input.orientation ?? 'landscape'; if (!['portrait', 'landscape'].includes(orientation)) C.fail('BWL_SIMULATION_PDF_OPTIONS');
  const prefs = M.normalizePreferences({ ...(input.columns === undefined ? {} : { columns: input.columns }),
    ...(input.sort === undefined ? {} : { sort: input.sort }), ...(input.direction === undefined ? {} : { direction: input.direction }) }, caps);
  if (prefs.columns.length > MAX_COLUMNS) C.fail('BWL_SIMULATION_PDF_COLUMNS_LIMIT', 422);
  return { ...selector, title: plain(input.title || 'Abverkaufs-Simulation', 160) || 'Abverkaufs-Simulation',
    name: filename(input.name || 'Abverkaufs-Simulation'), orientation, columns: prefs.columns.map(id => M.COLUMNS.find(c => c.id === id)), sort: prefs.sort, direction: prefs.direction };
}
function decimalText(value, type = 'decimal') {
  if (value === null || value === undefined) return 'Prüfen';
  if (typeof value !== 'string' || !/^-?\d{1,80}(?:\.\d{1,40})?$/.test(value)) C.fail('BWL_SIMULATION_PDF_INTEGRITY', 409);
  const rounded = D.divide(value, '1', type === 'money' || type === 'percent' ? 2 : 6), match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(rounded);
  const whole = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, '.'), fraction = type === 'money' ? (match[3] || '').padEnd(2, '0') : (match[3] || '');
  return match[1] + whole + (fraction ? ',' + fraction : '') + (type === 'money' ? ' EUR' : type === 'percent' ? ' %' : '');
}
function cell(row, column) { return column.type === 'text' ? plain(row[column.id], column.id === 'description' ? 1000 : 512) || '-' : decimalText(row[column.id], column.type); }
function sortedRows(rows, sort, direction) {
  const column = M.COLUMNS.find(c => c.id === sort); if (!column || !['asc', 'desc'].includes(direction)) C.fail('BWL_SIMULATION_PDF_OPTIONS');
  return [...rows].sort((a, b) => {
    const av = a[sort], bv = b[sort]; let order;
    if (av == null || bv == null) order = av == null && bv == null ? 0 : av == null ? 1 : -1;
    else { order = column.type === 'text' ? String(av).localeCompare(String(bv), 'de-AT', { numeric: true, sensitivity: 'base' }) : D.compare(av, bv); order *= direction === 'desc' ? -1 : 1; }
    return order || String(a.id).localeCompare(String(b.id), 'en');
  });
}
function validate(snapshot, spec) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length > M.LIMITS.rows
    || snapshot.rows.length !== snapshot.summary?.rows || !snapshot.summary.totals || !snapshot.assumptions || !snapshot.filters
    || !snapshot.capabilities || typeof snapshot.sourceFingerprint !== 'string' || Buffer.byteLength(C.canonical(snapshot)) > M.LIMITS.snapshotBytes) C.fail('BWL_SIMULATION_PDF_INTEGRITY', 409);
  M.assumptions(snapshot.assumptions);
  if (spec) { const allowed = new Set(M.columnsFor(snapshot.capabilities).map(c => c.id));
    if (spec.columns.some(c => !allowed.has(c.id)) || !allowed.has(spec.sort)) C.fail('BWL_SIMULATION_FORBIDDEN', 403); }
}
function render({ spec, snapshot, variant = null, comparison = null, generatedAt = new Date().toISOString() }) {
  if (!spec || !Array.isArray(spec.columns) || !spec.columns.length || spec.columns.length > MAX_COLUMNS
    || spec.columns.some(c => !M.COLUMNS.some(allowed => C.canonical(c) === C.canonical(allowed))) || !['portrait', 'landscape'].includes(spec.orientation)) C.fail('BWL_SIMULATION_PDF_OPTIONS');
  validate(snapshot, spec); if (comparison) validate(comparison.snapshot);
  const rows = sortedRows(snapshot.rows, spec.sort, spec.direction);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: spec.orientation, margin: 0, bufferPages: true, autoFirstPage: false, compress: true,
      info: { Title: spec.title, Author: 'Grabenplaner', Subject: 'Abverkaufs-Szenario mit ausdrücklich gewählten Annahmen', CreationDate: new Date(generatedAt), ModDate: new Date(generatedAt) } });
    const chunks = []; let bytes = 0, settled = false;
    doc.on('data', chunk => { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) { settled = true; doc.destroy(); reject(Object.assign(Error('BWL_SIMULATION_PDF_LIMIT'), { code: 'BWL_SIMULATION_PDF_LIMIT', status: 413 })); } else chunks.push(chunk); });
    doc.on('error', reject);
    try {
      const directory = path.join(__dirname, '../public/fonts/price-labels/roboto');
      if (fs.existsSync(path.join(directory, 'Regular.ttf')) && fs.existsSync(path.join(directory, 'Bold.ttf'))) {
        doc.registerFont('Regular', path.join(directory, 'Regular.ttf')); doc.registerFont('Bold', path.join(directory, 'Bold.ttf'));
      } else { doc.registerFont('Regular', 'Helvetica'); doc.registerFont('Bold', 'Helvetica-Bold'); }
      const size = spec.orientation === 'portrait' ? { width: 595.28, height: 841.89 } : { width: 841.89, height: 595.28 };
      const left = 32, width = size.width - 64, bottom = size.height - 54;
      const colors = { ink: '#1c2b33', green: '#245748', muted: '#687976', line: '#dbe4df', header: '#edf3ef', stripe: '#f8faf8' };
      const numeric = new Set(M.COLUMNS.filter(c => c.type !== 'text').map(c => c.id));
      const minimum = c => c.id === 'description' ? 92 : c.id === 'status' ? 82 : c.id === 'location' ? 61 : c.type === 'money' ? 63 : c.type === 'percent' ? 48 : 45;
      const sum = spec.columns.reduce((s, c) => s + minimum(c), 0), surplus = Math.max(0, width - sum), scale = Math.min(1, width / sum);
      const weight = spec.columns.reduce((s, c) => s + c.width, 0);
      const labels = { articleNumber: 'Artikel-Nr.', scenarioQuantity: 'Szenario-\nmenge' };
      const columns = spec.columns.map(c => ({ ...c, label: labels[c.id] || c.label, width: minimum(c) * scale + surplus * c.width / weight }));
      const font = spec.orientation === 'portrait' ? 7.2 : 8, padding = 5;
      doc.font('Bold').fontSize(font); const headerHeight = Math.max(27, ...columns.map(c => doc.heightOfString(c.label, { width: c.width - 2 * padding }) + 12));
      let y = 0;
      const localDate = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Nicht hinterlegt'; };
      function page(section) {
        doc.addPage(); doc.font('Bold').fontSize(7).fillColor(colors.green).text('VERKAUF - BETRIEBSWIRTSCHAFT', left, 27, { width, height: 12 });
        doc.fontSize(18).fillColor(colors.ink).text(spec.title, left, 43, { width, height: 43, ellipsis: true });
        doc.font('Regular').fontSize(8).fillColor(colors.muted).text(section, left, 93, { width, height: 15 }); y = 118;
      }
      function note(text, { bold = false, size: fontSize = 8 } = {}) {
        doc.font(bold ? 'Bold' : 'Regular').fontSize(fontSize); const height = doc.heightOfString(text, { width }) + 8;
        if (height > bottom - y) page('Annahmen und Datengrundlage - Fortsetzung');
        if (height > bottom - y) C.fail('BWL_SIMULATION_PDF_ROW_TOO_LONG', 413);
        doc.fillColor(bold ? colors.green : colors.muted).text(text, left, y, { width, height: height - 2 }); y += height;
      }
      function totals(data) {
        const labels = { scenarioQuantity: 'Szenariomenge (verschiedene Einheiten)', scenarioGrossRevenue: 'Szenarioerlös brutto', scenarioNetRevenue: 'Szenarioerlös netto', scenarioCost: 'Szenariowareneinsatz netto', scenarioGrossMargin: 'Szenario-Rohertrag', scenarioResult: 'Szenarioergebnis nach Zusatzkosten' };
        for (const [id, label] of Object.entries(labels)) {
          const total = data.summary.totals[id]; if (!total) continue;
          const value = decimalText(total.value, id === 'scenarioQuantity' ? 'decimal' : 'money');
          note(`${label}: ${value}${total.complete ? '' : ' · bekannter Teilbetrag ' + decimalText(total.knownSubtotal, id === 'scenarioQuantity' ? 'decimal' : 'money') + ' · ' + total.missingRows + ' ungeprüfte Zeile(n)'}`);
        }
      }
      function scenario(data, name, historical, version) {
        note(plain(name, 120) + (version ? ' · Version ' + version : ''), { bold: true, size: 11 });
        note(`${historical ? 'Gespeicherter Stand - unverändert exportiert' : 'Aktuelle Berechnung'} · Bestand: ${localDate(data.sourceAt)} · Berechnet: ${localDate(data.generatedAt)} · Quellenkennung: ${plain(data.sourceFingerprint, 12)}`);
        const a = data.assumptions;
        note(`Annahmen: Rabatt ${decimalText(a.discountPercent, 'percent')} · Abverkaufsquote ${decimalText(a.sellThroughPercent, 'percent')} · Zeitraum ${a.horizonDays} Tage · Zusatzkosten ${decimalText(a.additionalCosts, 'money')}`);
        const assortment = SORTIMENTS.find(item => item.id === data.filters.assortment)?.label || plain(data.filters.assortment.replace(/^source:/, ''), 120);
        note(`Auswahl: ${plain(data.filters.query || 'alle Artikel', 200)} · ${assortment} · Filialen ${data.filters.locations.length ? data.filters.locations.map(id => plain(id, 40)).join(', ') : 'alle freigegebenen'} · ${data.summary.rows} Artikel-Filial-Zeilen.`);
        totals(data); y += 8;
      }
      page(comparison ? 'Variantenvergleich - Annahmen und Datengrundlagen' : 'Szenario - Annahmen und Datengrundlage');
      if (comparison && spec.orientation === 'landscape') {
        const panelWidth = (width - 16) / 2, startY = y;
        function panel(data, name, historical, version, x) {
          const contentWidth = panelWidth - 24; let cursor = startY + 12;
          const fields = [[plain(name, 120) + (version ? ' · Version ' + version : ''), true, 10.5],
            [historical ? 'Gespeicherter Stand - unverändert exportiert' : 'Aktuelle Berechnung', false, 7.5],
            [`Bestand: ${localDate(data.sourceAt)} · Berechnet: ${localDate(data.generatedAt)}`, false, 7.5],
            [`Quellenkennung: ${plain(data.sourceFingerprint, 12)} · ${data.summary.rows} Artikel-Filial-Zeilen`, false, 7.5]];
          const a = data.assumptions;
          fields.push([`Rabatt ${decimalText(a.discountPercent, 'percent')} · Quote ${decimalText(a.sellThroughPercent, 'percent')} · ${a.horizonDays} Tage · Zusatzkosten ${decimalText(a.additionalCosts, 'money')}`, false, 8]);
          const assortment = SORTIMENTS.find(item => item.id === data.filters.assortment)?.label || plain(data.filters.assortment.replace(/^source:/, ''), 100);
          const locations = data.filters.locations, first = locations.slice(0, 6).map(id => plain(id, 40)).join(', ');
          fields.push([`${plain(data.filters.query || 'Alle Artikel', 150)} · ${assortment} · Filialen ${locations.length ? first + (locations.length > 6 ? ' (+ ' + (locations.length - 6) + ')' : '') : 'alle freigegebenen'}`, false, 7.5]);
          const labels = { scenarioQuantity: 'Szenariomenge (verschiedene Einheiten)', scenarioGrossRevenue: 'Szenarioerlös brutto', scenarioNetRevenue: 'Szenarioerlös netto', scenarioCost: 'Szenariowareneinsatz netto', scenarioGrossMargin: 'Szenario-Rohertrag', scenarioResult: 'Ergebnis nach Zusatzkosten' };
          for (const [id, label] of Object.entries(labels)) { const total = data.summary.totals[id]; if (!total) continue;
            const type = id === 'scenarioQuantity' ? 'decimal' : 'money';
            fields.push([`${label}: ${decimalText(total.value, type)}${total.complete ? '' : ' · bekannter Teilbetrag ' + decimalText(total.knownSubtotal, type) + ' · ' + total.missingRows + ' ungeprüfte Zeile(n)'}`, false, 8]); }
          const measured = fields.map(([text, bold, fontSize]) => { doc.font(bold ? 'Bold' : 'Regular').fontSize(fontSize); return { text, bold, fontSize, height: doc.heightOfString(text, { width: contentWidth }) + 7 }; });
          const height = measured.reduce((sum, field) => sum + field.height, 24);
          if (height > bottom - startY) C.fail('BWL_SIMULATION_PDF_ROW_TOO_LONG', 413);
          doc.roundedRect(x, startY, panelWidth, height, 5).fill(colors.stripe);
          for (const field of measured) { doc.font(field.bold ? 'Bold' : 'Regular').fontSize(field.fontSize).fillColor(field.bold ? colors.green : colors.ink)
            .text(field.text, x + 12, cursor, { width: contentWidth, height: field.height - 2 }); cursor += field.height; }
          return startY + height;
        }
        const leftBottom = panel(snapshot, variant?.name || 'Aktuelle Berechnung', !!variant, variant?.version, left);
        const rightBottom = panel(comparison.snapshot, comparison.name, true, comparison.version, left + panelWidth + 16);
        y = Math.max(leftBottom, rightBottom) + 12;
      } else {
        scenario(snapshot, variant?.name || 'Aktuelle Berechnung', !!variant, variant?.version);
        if (comparison) { note('Vergleichsvariante', { bold: true }); scenario(comparison.snapshot, comparison.name, true, comparison.version); }
      }
      if (comparison) note('Varianten können unterschiedliche Artikel, Filialen, Quellenstände und Annahmen enthalten. Die Szenariowerte weisen keine erzielte Veränderung nach. Die vollständige Tabelle folgt für die Hauptvariante.', { size: 7.3 });
      note(M.NOTE, { size: 7.3 }); note('Anzeige: Geld zwei, Mengen sechs, Prozent zwei Nachkommastellen; Summen aus ungerundeten Werten. Fehlende Werte: Prüfen.', { size: 7.3 });
      function tableHeader() {
        doc.rect(left, y, width, headerHeight).fill(colors.header); let x = left;
        for (const column of columns) { doc.font('Bold').fontSize(font).fillColor(colors.green).text(column.label, x + padding, y + 6, { width: column.width - 2 * padding, height: headerHeight - 10 }); x += column.width; } y += headerHeight;
      }
      function tablePage() { page(`${variant ? plain(variant.name, 100) : 'Aktuelle Berechnung'} · ${rows.length} Artikel-Filial-Zeilen · vollständige Haupttabelle`); tableHeader(); }
      tablePage();
      for (let index = 0; index < rows.length; index++) {
        const values = columns.map(c => cell(rows[index], c)); doc.font('Regular').fontSize(font);
        const height = Math.max(24, ...values.map((value, i) => doc.heightOfString(value, { width: columns[i].width - 2 * padding }) + 12));
        if (height > bottom - y) tablePage(); if (height > bottom - y) C.fail('BWL_SIMULATION_PDF_ROW_TOO_LONG', 413);
        if (index % 2) doc.rect(left, y, width, height).fill(colors.stripe); let x = left;
        for (let i = 0; i < columns.length; i++) {
          doc.font('Regular').fontSize(font).fillColor(colors.ink).text(values[i], x + padding, y + 6, { width: columns[i].width - 2 * padding, height: height - 10, align: numeric.has(columns[i].id) ? 'right' : 'left' }); x += columns[i].width;
        }
        doc.moveTo(left, y + height).lineTo(left + width, y + height).lineWidth(.35).strokeColor(colors.line).stroke(); y += height;
      }
      if (!rows.length) doc.font('Regular').fontSize(10).fillColor(colors.muted).text('Keine Artikel-Filial-Zeilen für dieses Szenario.', left, y + 16, { width, height: 20 });
      const range = doc.bufferedPageRange(), pages = range.count;
      for (let index = range.start; index < range.start + range.count; index++) {
        doc.switchToPage(index); const footer = size.height - 42;
        doc.moveTo(left, footer - 6).lineTo(left + width, footer - 6).lineWidth(.5).strokeColor(colors.line).stroke();
        doc.font('Regular').fontSize(6.5).fillColor(colors.muted).text(`Grabenplaner · Abverkaufs-Simulation · Erstellt: ${localDate(generatedAt)}`, left, footer, { width: width - 62, height: 13 });
        doc.font('Bold').text(`${index - range.start + 1} / ${pages}`, size.width - 88, footer, { width: 56, height: 12, align: 'right' });
        doc.font('Regular').fontSize(6.2).text('Annahmenbasiertes Szenario. Keine Nachfrage-, Ergebnis- oder Liquiditätsprognose. Fehlende Werte: Prüfen.', left, footer + 14, { width, height: 11 });
      }
      doc.on('end', () => { if (!settled) resolve({ buffer: Buffer.concat(chunks), pages, rows: rows.length, name: spec.name }); }); doc.end();
    } catch (error) { settled = true; doc.destroy(); reject(error); }
  });
}
module.exports = { MAX_COLUMNS, normalize, render, filename, plain, decimalText, cell, sortedRows };
