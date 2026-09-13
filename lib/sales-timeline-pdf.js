'use strict';
const PDFDocument = require('pdfkit'), path = require('node:path');
const C = require('./data-import-contract');
const { METRICS } = require('./sales-report-model');
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\u2010-\u2015]/g, '-');
const colors = { background: '#031b35', panel: '#052442', border: '#168ac4', grid: '#185077', ink: '#e7f2ff', muted: '#88b5dd', gold: '#ffce13', warning: '#ff9f8f' };
const dateLabel = value => new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z'));
function selectionLines(query, metadata) {
  const selected = (ids, choices) => ids?.length ? ids.map(id => choices?.find(c => c.id === id)?.label || id).join(', ') : 'Alle im gewählten Umfang';
  return [
    'Filialen: ' + selected(query.locationIds, metadata.locations),
    'Warengruppen (WGR): ' + selected(query.merchandiseGroupIds, metadata.merchandiseGroups),
    'Sortimentsgruppen: ' + selected(query.productGroupIds, metadata.productGroups),
    'Hersteller / Marke: ' + selected(query.manufacturerIds, metadata.manufacturers),
    'MA (Positionsverkäufer): ' + selected(query.sellerIds, metadata.sellers)
  ];
}
function createSalesTimelinePdf({ title, query, metadata, report, completedAt }) {
  return new Promise((resolve, reject) => {
    const landscape = query.orientation === 'landscape', width = landscape ? 841.89 : 595.28, height = landscape ? 595.28 : 841.89;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 0, autoFirstPage: false, bufferPages: true,
      info: { Title: clean(title), Author: 'Grabenplaner', Subject: 'Verkaufsanalyse - Grafik im Zeitverlauf' } });
    doc.registerFont('Regular', path.join(__dirname, 'pdf-fonts/Roboto-Regular.ttf'));
    doc.registerFont('Bold', path.join(__dirname, 'pdf-fonts/Roboto-Bold.ttf'));
    const chunks = []; let bytes = 0;
    doc.on('data', chunk => { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) doc.destroy(new C.DataImportError('IMPORT_REPORT_PDF_LIMIT', 413)); else chunks.push(chunk); });
    doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    const font = (size = 9, bold = false, color = colors.ink) => doc.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor(color);
    function page() { doc.addPage(); doc.rect(0, 0, width, height).fill(colors.background); doc.roundedRect(20, 25, width - 40, height - 67, 12).lineWidth(0.7).fillAndStroke(colors.panel, colors.border); }
    try {
      const timeline = report.timeline, metric = METRICS.find(m => m.id === query.chartMetric);
      if (!timeline || !metric || timeline.series.length > 50 || timeline.intervals.length > 366) C.fail('IMPORT_REPORT_PDF_LIMIT', 413);
      const series = timeline.series.length ? timeline.series : [{ dimensions: [], points: timeline.intervals.map(i => ({ date: i.id, value: null, hasSource: false })) }];
      const grain = { day: 'Tage', week: 'Wochen', month: 'Monate' }[timeline.grain];
      for (const current of series) {
        page();
        for (let i = 0; i < 3; i++) doc.roundedRect(41 + i * 7, 62 - i * 5, 4, 11 + i * 5, 2).fill('#00c1f9');
        font(17, true).text(clean(title), 76, 43, { width: width - 120 });
        const headingBottom = doc.y;
        font(10, false, colors.muted).text(`${dateLabel(query.dateFrom)} bis ${dateLabel(query.dateTo)} · ${grain}`, 76, headingBottom + 7, { width: width - 120 });
        const group = current.dimensions.length ? current.dimensions.map(d => d.label).join(' / ') : 'Gesamte Auswahl';
        font(10, true).text(clean(group), 40, doc.y + 12, { width: width - 80 });
        const top = Math.max(137, doc.y + 20), left = 91, right = width - 42, bottom = height - 159, plotHeight = bottom - top, plotWidth = right - left;
        if (plotHeight < 170) C.fail('IMPORT_REPORT_PDF_LIMIT', 413);
        const numbers = current.points.filter(p => p.value !== null && Number.isFinite(Number(p.value))).map(p => Number(p.value));
        const minValue = Math.min(0, ...numbers), maxValue = Math.max(0, ...numbers);
        const rawStep = (maxValue - minValue || 1) / 5, magnitude = 10 ** Math.floor(Math.log10(rawStep));
        const step = Math.max(metric.unit === 'count' ? 1 : 0, [1, 2, 5, 10].find(n => n * magnitude >= rawStep) * magnitude);
        const minimum = Math.floor(minValue / step) * step, maximum = maxValue === 0 && minValue === 0 ? step * 5 : Math.ceil(maxValue / step) * step;
        const y = value => bottom - (value - minimum) / (maximum - minimum) * plotHeight;
        const zero = y(0), digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
        for (let tick = minimum; tick <= maximum + step / 10; tick += step) {
          const py = y(tick); doc.moveTo(left, py).lineTo(right, py).lineWidth(0.5).dash(2, { space: 2 }).strokeColor(colors.grid).stroke().undash();
          font(8, false, colors.muted).text(new Intl.NumberFormat('de-AT', { maximumFractionDigits: digits }).format(Math.abs(tick) < step / 100 ? 0 : tick), 34, py - 4, { width: left - 42, align: 'right', lineBreak: false });
        }
        doc.moveTo(left, top).lineTo(left, bottom).moveTo(left, zero).lineTo(right, zero).lineWidth(0.8).strokeColor(colors.border).stroke();
        const unit = metric.unit === 'EUR' ? '€' : metric.unit === '%' ? '%' : metric.unit === 'count' ? 'Anzahl' : 'Stück';
        doc.save(); doc.rotate(-90, { origin: [28, top + plotHeight / 2] });
        font(8, false, colors.muted).text(`${metric.label} (${unit})`, 28 - plotHeight / 2, top + plotHeight / 2 - 5, { width: plotHeight, align: 'center', lineBreak: false }); doc.restore();
        const cell = plotWidth / Math.max(1, current.points.length), barWidth = Math.max(0.6, cell * 0.76);
        const ticks = new Set([0, current.points.length - 1]);
        for (let i = 0; i < current.points.length; i += Math.max(1, Math.ceil(current.points.length / (landscape ? 9 : 5)))) {
          if ((current.points.length - 1 - i) * cell >= 54) ticks.add(i);
        }
        current.points.forEach((point, index) => {
          const x = left + (index + 0.5) * cell;
          if (ticks.has(index)) {
            doc.moveTo(x, top).lineTo(x, bottom).lineWidth(0.4).dash(2, { space: 3 }).strokeColor(colors.grid).stroke().undash();
            const label = timeline.grain === 'month'
              ? new Intl.DateTimeFormat('de-AT', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(point.date + 'T12:00:00Z'))
              : dateLabel(timeline.intervals[index].from).slice(0, 6);
            font(8, false, colors.muted).text(label, Math.max(left - 10, Math.min(right - 39, x - 25)), bottom + 10, { width: 50, align: 'center', lineBreak: false });
          }
          if (point.value === null || !Number.isFinite(Number(point.value))) {
            const review = point.review > 0 || point.missingMargin > 0 || point.hasSource;
            doc.rect(x - Math.min(barWidth, 5) / 2, bottom + 2, Math.min(barWidth, 5), 3).fill(review ? colors.warning : colors.grid);
            return;
          }
          const value = Number(point.value), end = y(value), high = Math.min(zero, end), barHeight = Math.abs(zero - end);
          if (!barHeight) { doc.moveTo(x - barWidth / 2, zero).lineTo(x + barWidth / 2, zero).lineWidth(1).strokeColor(colors.gold).stroke(); return; }
          doc.save().rect(x - barWidth / 2, high, barWidth, barHeight).clip();
          const tile = landscape ? 9 : 11;
          for (let offset = 0; offset < barHeight; offset += tile + 2) {
            const py = value >= 0 ? zero - offset - tile : zero + offset;
            doc.fillOpacity(0.36 + 0.64 * Math.min(1, (offset + tile) / barHeight)).rect(x - barWidth / 2, py, barWidth, tile).fill(colors.gold);
          }
          doc.restore();
        });
        font(8, true, colors.gold).text('Gelb: geprüfte Werte', 40, height - 121, { width: width - 80 });
        font(8, false, colors.muted).text('Blaue Markierung: keine Quelldaten. Korallfarbene Markierung: Prüfung offen oder Kennzahl nicht berechenbar.', 40, doc.y + 4, { width: width - 80 });
        if (!numbers.length) font(10, true).text('Für diese Auswahl liegen keine vollständig auswertbaren Werte vor.', left + 15, top + plotHeight / 2, { width: plotWidth - 30, align: 'center' });
        font(7, false, colors.muted).text('Auswahl, Datenstand und Berechnung auf der letzten Seite.', 40, height - 65, { width: width - 80, lineBreak: false });
      }
      page(); let cursor = 47;
      function detail(text, bold = false) {
        font(bold ? 13 : 9, bold); const h = doc.heightOfString(clean(text), { width: width - 82 });
        if (cursor + h > height - 82) { page(); cursor = 47; }
        if (h > height - 135) C.fail('IMPORT_REPORT_PDF_LIMIT', 413);
        font(bold ? 13 : 9, bold).text(clean(text), 41, cursor, { width: width - 82 }); cursor += h + 10;
      }
      detail('Auswahl und Datenstand', true); detail(title);
      detail(`${dateLabel(query.dateFrom)} bis ${dateLabel(query.dateTo)} · ${grain} · ${metric.label}`);
      for (const line of selectionLines(query, metadata)) detail(line);
      detail('Quelle: ' + metadata.source.label + ' · ' + metadata.source.coverageLabel);
      detail('Hersteller und Sortimentsnummer stammen aus der historischen Kassenposition. Die WGR-Zuordnung stammt aus dem beim Auftrag gespeicherten Trade-Katalog.');
      detail('Rohertrag wird aus dem historischen Kassen-Rohertrag je Stück mal signierter Menge berechnet. Die Rohertragsquote ist die Summe des Rohertrags geteilt durch die Summe des Nettoumsatzes im jeweiligen Zeitabschnitt. Bei Nettoumsatz von null oder darunter ist die Quote nicht verfügbar.');
      detail('Retouren behalten ihr Vorzeichen. Fehlende Quelldaten, offene Belege und fehlender Rohertrag werden nicht als Nullwerte dargestellt. Null bedeutet keine passenden Verkäufe in einem Zeitabschnitt mit vorhandenen Kassendaten.');
      detail(`Erstellt: ${completedAt.slice(0, 19).replace('T', ' ')} UTC · ${report.processed} Positionen verarbeitet.`);
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) { doc.switchToPage(i); font(7, false, colors.muted).text(`Grabenplaner · Grafiken · Seite ${i + 1} / ${range.count}`, 30, height - 25, { width: width - 60, lineBreak: false }); }
      doc.end();
    } catch (error) { doc.destroy(error); }
  });
}
module.exports = { createSalesTimelinePdf, selectionLines };
