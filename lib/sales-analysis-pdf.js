'use strict';
const PDFDocument = require('pdfkit');
const path = require('node:path');
const ChartOptions = require('../public/sales-chart-options');
const C = require('./data-import-contract');
const { METRICS } = require('./sales-report-model');
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\u2010-\u2015]/g, '-');
const palette = ['#245448', '#4878a0', '#bf7543', '#8c638c', '#818a45', '#667d86', '#d1a137', '#754e42', '#459c99', '#bd6b7c'];
function display(value, unit) {
  if (value === null || value === undefined) return 'Nicht verfügbar';
  return new Intl.NumberFormat('de-AT', { minimumFractionDigits: ['EUR', '%'].includes(unit) ? 2 : 0,
    maximumFractionDigits: unit === 'quantity' ? 6 : ['EUR', '%'].includes(unit) ? 2 : 0 }).format(Number(value)) + (unit === 'EUR' ? ' €' : unit === '%' ? ' %' : '');
}
function displayedMetric(result, phase, unit) {
  const value = result[phase], checked = result[phase === 'current' ? 'verifiedCurrent' : 'verifiedPrevious'];
  return value == null && checked != null ? display(checked, unit) + ' *' : display(value, unit);
}
function reviewReasons(quality) {
  const labels = { STATUS_REVIEW_REQUIRED: 'Verkaufsstatus', STATUS_RULE_AMBIGUOUS: 'Verkaufsstatus',
    QUANTITY_STATUS_CONFLICT: 'Menge / Status', AMOUNT_STATUS_CONFLICT: 'Betrag / Status',
    VAT_CODE_UNKNOWN: 'MwSt.-Zuordnung', NEGATIVE_UNIT_PRICE_REVIEW: 'Negativer Einzelpreis',
    RECEIPT_AMOUNT_MISMATCH: 'Belegsumme', RECEIPT_AMOUNT_INVALID: 'Belegbetrag',
    BUSINESS_DATE_REVIEW_REQUIRED: 'Belegdatum', BUSINESS_TIME_REVIEW_REQUIRED: 'Belegzeit' };
  return [...new Set([...Object.keys(quality.current.issues || {}), ...Object.keys(quality.previous.issues || {})]
    .map(code => labels[code] || 'Belegprüfung'))].join(', ') || 'Belegprüfung';
}
function createSalesAnalysisPdf({ title, query, metadata, report, completedAt }) {
  if (query.chartType === 'timeline') return require('./sales-timeline-pdf').createSalesTimelinePdf({ title, query, metadata, report, completedAt });
  return new Promise((resolve, reject) => {
    const layout = query.orientation === 'landscape' ? 'landscape' : 'portrait';
    const pageWidth = layout === 'landscape' ? 841.89 : 595.28, pageHeight = layout === 'landscape' ? 595.28 : 841.89;
    const summaryGap = layout === 'landscape' ? 2 : 7;
    const doc = new PDFDocument({ size: 'A4', layout, margin: 40, bufferPages: true, autoFirstPage: false,
      info: { Title: clean(title), Author: 'Grabenplaner', Subject: 'Verkaufsanalyse aus importierten Kassendaten' } });
    doc.registerFont('Report', path.join(__dirname, 'pdf-fonts/Roboto-Regular.ttf'));
    doc.registerFont('ReportBold', path.join(__dirname, 'pdf-fonts/Roboto-Bold.ttf'));
    const chunks = []; let bytes = 0, y = 0, pageCount = 0;
    const left = 40, width = pageWidth - 80, bottom = pageHeight - 77;
    doc.on('data', chunk => { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) doc.destroy(new C.DataImportError('IMPORT_REPORT_PDF_LIMIT', 413)); else chunks.push(chunk); });
    doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    function font(size = 9, bold = false, color = '#203b34') { return doc.font(bold ? 'ReportBold' : 'Report').fontSize(size).fillColor(color); }
    function page(section = '') {
      if (++pageCount > 250) C.fail('IMPORT_REPORT_PDF_LIMIT', 413);
      doc.addPage(); doc.rect(left, 32, width, 25).fill('#e9f1ee');
      font(9, true).text('GRABENPLANER  ·  VERKAUFSANALYSE', left + 10, 40, { width: width - 20, lineBreak: false });
      y = 70;
      if (section) text(section, { size: 15, bold: true });
    }
    function text(value, { size = 9, bold = false, color = '#203b34', gap = 7 } = {}) {
      const t = clean(value); font(size, bold, color);
      const h = doc.heightOfString(t, { width });
      if (h > Math.min(650, bottom - 70)) C.fail('IMPORT_REPORT_PDF_LIMIT', 413);
      if (y + h > bottom) page();
      font(size, bold, color).text(t, left, y, { width }); y += h + gap;
    }
    function table(columns, rows, section) {
      const sum = columns.reduce((n, c) => n + c.weight, 0), widths = columns.map(c => width * c.weight / sum);
      function row(values, header) {
        font(header ? 8 : 8.5, header);
        const heights = values.map((v, i) => doc.heightOfString(clean(v), { width: widths[i] - 10 }));
        const height = Math.max(13, ...heights) + 8;
        if (height > bottom - 140) C.fail('IMPORT_REPORT_PDF_LIMIT', 413);
        if (y + height > bottom) { page(section + ' (Fortsetzung)'); row(columns.map(c => c.label), true); }
        if (header) doc.rect(left, y, width, height).fill('#e9f1ee');
        let x = left;
        values.forEach((v, i) => { font(header ? 8 : 8.5, header).text(clean(v), x + 5, y + 4, { width: widths[i] - 10, align: columns[i].numeric ? 'right' : 'left' }); x += widths[i]; });
        y += height; doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.4).strokeColor('#ccd9d4').stroke();
      }
      if (y + 80 > bottom) page(section);
      row(columns.map(c => c.label), true);
      for (const values of rows) row(values, false);
      y += 12;
    }
    function chart(metric) {
      if (query.chartType === 'none') return;
      const design = ChartOptions.normalize(query.chartDesign || {}), shown = value => ChartOptions.formatted(value, metric.unit, design);
      const ink=ChartOptions.ink(design),muted=ChartOptions.muted(design);
      function diagramPage(title){page(title);if(design.backgroundColor!=='#ffffff')doc.rect(left-8,y-3,width+16,bottom-y).fill(design.backgroundColor);}
      const entries = report.rows.map(row => {
        const result = row.metrics[metric.id], currentPartial = result.current == null && result.verifiedCurrent != null,
          previousPartial = result.previous == null && result.verifiedPrevious != null;
        const label = row.dimensions.map(d => d.label).join(' / ');
        return { row, label, chartLabel: label + (currentPartial ? ' · aktuell *' : '') + (previousPartial ? ' · Vergleich *' : ''),
          value: result.current ?? result.verifiedCurrent ?? null, previous: result.previous ?? result.verifiedPrevious ?? null,
          partial: currentPartial || previousPartial };
      })
        .filter(r => r.value !== null).sort((a, b) => Number(b.value) - Number(a.value));
      diagramPage(metric.label + ' · Übersicht');
      if (!entries.length) { text('Für diese Kennzahl liegen keine vollständig auswertbaren Werte vor. Details und Prüfhinweise stehen in den Tabellen.',{color:ink}); return; }
      const incomplete = report.rows.some(row => row.metrics[metric.id].current == null);
      const shares = !(query.chartDesign && design.showComparison) && !incomplete && query.chartType !== 'bars' && entries.length <= (query.chartType === 'shares' ? 10 : 6)
        && entries.every(r => Number(r.value) >= 0) && entries.some(r => Number(r.value) > 0)
        && ['netRevenue', 'grossRevenue', 'quantity'].includes(metric.id);
      if (shares) {
        text('Anteile im Auswertungszeitraum', { color: muted });
        const total = entries.reduce((n, r) => n + Number(r.value), 0), cx = left + width / 2, cy = y + 98, radius = 82;
        let angle = -Math.PI / 2;
        for (const [index, entry] of entries.entries()) {
          const span = Number(entry.value) / total * Math.PI * 2;
          if (!span) continue;
          const points = [[cx, cy]], steps = Math.max(2, Math.ceil(span * 40));
          for (let i = 0; i <= steps; i++) points.push([cx + radius * Math.cos(angle + span * i / steps), cy + radius * Math.sin(angle + span * i / steps)]);
          doc.polygon(...points).fill(ChartOptions.color(design,index)); angle += span;
        }
        doc.circle(cx, cy, 45).fill(design.backgroundColor); y = cy + 100;
        for (const [index, entry] of (design.showLegend ? entries : []).entries()) {
          font(9); const label = entry.label + (design.showValues ? ': ' + shown(entry.value) : '')
            + (design.showShare || !query.chartDesign ? ` (${(Number(entry.value) / total * 100).toFixed(1).replace('.', ',')} %)` : '');
          const h = doc.heightOfString(label, { width: width - 20 });
          if (y + h > bottom) diagramPage(metric.label + ' · Legende (Fortsetzung)');
          doc.rect(left, y + 3, 9, 9).fill(ChartOptions.color(design,index));
          font(9,false,ink).text(label, left + 18, y, { width: width - 20 }); y += h + 9;
          for(const id of design.annotations.filter(id=>id!==metric.id&&entry.row.metrics[id])){const extra=METRICS.find(m=>m.id===id),value=entry.row.metrics[id].current;
            if(y+22>bottom)diagramPage(metric.label+' · Legende (Fortsetzung)');
            font(8,false,muted).text((id==='grossMargin'?'RE':extra.label)+': '+ChartOptions.formatted(value,extra.unit,design),left+18,y,{width:width-20,lineBreak:false,ellipsis:true});y+=15;}
        }
      } else {
        if (incomplete) text('Balkendiagramm mit unvollständigem Datenstand: Fehlende Werte ergeben keine verlässlichen Anteile. * kennzeichnet ausschließlich geprüfte Teilwerte.', { size: 8, color: '#65746f' });
        else if (query.chartType === 'shares') text(design.showComparison?'Der direkte Vergleich wird als Balkendiagramm dargestellt. Für ein Ringdiagramm den Vergleich in der Diagrammgestaltung ausschalten.':'Diese Auswahl wird als Balkendiagramm dargestellt: Anteile benötigen höchstens zehn Gruppen, positive Summen und eine additive Kennzahl.', { size: 8, color: '#65746f' });
        if (design.showLegend) {
          doc.rect(left, y + 2, 9, 9).fill(design.currentColor);
          font(8,false,ink).text('Aktuell', left + 15, y + 1, { width: 70, lineBreak: false });
          if (design.showComparison) { doc.rect(left + 90, y + 2, 9, 9).fill(design.comparisonColor); font(8,false,ink).text('Vergleich', left + 105, y + 1, { width: 90, lineBreak: false }); }
          y += 23;
        }
        if (!incomplete && entries.some(entry => entry.partial)) text('* = geprüfter Teilwert; der jeweilige Zeitraum ist noch unvollständig.', { size: 8, color: '#65746f' });
        const missing = report.rows.length - entries.length;
        if (missing) text(`${missing} ${missing === 1 ? 'Gruppe ohne auswertbaren aktuellen Wert steht' : 'Gruppen ohne auswertbaren aktuellen Wert stehen'} nur in den Detailtabellen.`, { size: 8, color: muted });
        const visible = entries.slice(0, 20), values = visible.flatMap(r => [Number(r.value), ...(design.showComparison ? [Number(r.previous || 0)] : [])]);
        const min = Math.min(0, ...values), max = Math.max(0, ...values), range = max - min || 1;
        const x = left + 215, chartWidth = width - 215, zero = x + -min / range * chartWidth;
        for (const [index, entry] of visible.entries()) {
          const annotations = design.annotations.filter(id => id !== metric.id && entry.row.metrics[id]);
          const parts = [];
          if (design.showValues) parts.push(shown(entry.value) + (design.showComparison ? ' / ' + shown(entry.previous) : ''));
          const result = entry.row.metrics[metric.id];
          if (design.showComparison && design.showPercent && result.percent != null) parts.push((Number(result.percent)>0?'+':'') + display(result.percent,'%'));
          if (design.showComparison && design.showAbsolute && result.absolute != null) parts.push('Δ ' + shown(result.absolute));
          if (design.showShare && ['netRevenue','grossRevenue','quantity'].includes(metric.id) && report.total.metrics[metric.id]?.current != null
            && Number(report.total.metrics[metric.id].current)>0 && Number(entry.value)>=0) parts.push('Anteil '+(100*Number(entry.value)/Number(report.total.metrics[metric.id].current)).toLocaleString('de-AT',{maximumFractionDigits:1})+' %');
          font(8); const h = Math.max(parts.length ? 51 : 37, doc.heightOfString(entry.chartLabel, { width: 202 }) + 8) + annotations.length * 13;
          if (y + h > bottom) diagramPage(metric.label + ' · Übersicht (Fortsetzung)');
          font(8,false,ink).text(entry.chartLabel, left, y + 2, { width: 202 });
          [entry.value, ...(design.showComparison ? [entry.previous] : [])].forEach((value, i) => {
            if (value === null) return;
            const end = x + (Number(value) - min) / range * chartWidth;
            const bx=Math.min(zero,end),bw=Math.max(0.4,Math.abs(end-zero));
            if (design.corners==='rounded') doc.roundedRect(bx,y+i*13,bw,10,Math.min(3,bw/2)); else doc.rect(bx,y+i*13,bw,10);
            doc.fill(i ? design.comparisonColor : ChartOptions.color(design,index));
          });
          if (parts.length) font(7,false,ink).text(parts.join(' · '), x, y+29, {width:chartWidth,lineBreak:false,ellipsis:true});
          annotations.forEach((id,n)=>{const extra=METRICS.find(m=>m.id===id),v=entry.row.metrics[id];
            const label=(id==='grossMargin'?'RE':extra.label)+': '+ChartOptions.formatted(v.current,extra.unit,design)+(design.showComparison?' / '+ChartOptions.formatted(v.previous,extra.unit,design):'');
            font(7,false,muted).text(label,left,y+Math.max(parts.length?48:34,doc.heightOfString(entry.chartLabel,{width:202})+6)+n*13,{width,lineBreak:false,ellipsis:true});});
          doc.moveTo(zero, y - 2).lineTo(zero, y + h - 4).strokeColor('#71847a').lineWidth(0.5).stroke(); y += h;
        }
        text(`Skala: ${display(String(min), metric.unit)} bis ${display(String(max), metric.unit)}`, { size: 8, color: muted });
        if (entries.length > 20) text('Diagramm: die 20 größten aktuellen Werte. Die folgenden Tabellen enthalten alle Gruppen.', { size: 8,color:muted });
      }
    }
    try {
      page(); text(title, { size: 20, bold: true });
      text(`Zeitraum: ${query.dateFrom} bis ${query.dateTo}`, { size: 11, bold: true });
      text(`Vergleich: ${query.comparisonFrom} bis ${query.comparisonTo}`, { size: 10 });
      text(`Filialen: ${query.locationIds.map(id => metadata.locations.find(l => l.id === id)?.label || id).join(', ')}`, { gap: summaryGap });
      text(`Aufschlüsselung: ${query.groupBy.map(id => metadata.dimensions.find(d => d.id === id)?.label || id).join(' > ')}`, { gap: summaryGap });
      for (const [label, ids, options] of [[query.reportVersion >= 4 ? 'Sortimentsgruppen' : 'WGR / Sortiment', query.productGroupIds, metadata.productGroups],
        ...(query.reportVersion >= 4 ? [['Warengruppen (WGR)', query.merchandiseGroupIds || [], metadata.merchandiseGroups || []]] : []),
        ['Hersteller / Marke', query.manufacturerIds, metadata.manufacturers], ['MA', query.sellerIds, metadata.sellers]]) {
        text(`${label}: ${ids.length ? ids.map(id => options.find(o => o.id === id)?.label || id).join(', ') : 'Alle im gewählten Umfang'}`, { size: 8.5, gap: summaryGap });
      }
      text(`Quelle: ${metadata.source.label} · ${metadata.source.coverageLabel}`, { size: 8, color: '#65746f', gap: summaryGap });
      text(`Erstellt: ${completedAt.slice(0, 19).replace('T', ' ')} UTC · ${report.processed} Positionen geprüft`, { size: 8, color: '#65746f', gap: summaryGap });
      const selected = query.metrics.map(id => METRICS.find(m => m.id === id));
      const columns = [{ label: 'Kennzahl', weight: 2.5 }, { label: 'Aktuell', weight: 1.5, numeric: true }, { label: 'Vergleich', weight: 1.5, numeric: true },
        ...(query.changes.includes('absolute') ? [{ label: 'Änderung absolut', weight: 1.5, numeric: true }] : []),
        ...(query.changes.includes('percent') ? [{ label: 'Änderung %', weight: 1.2, numeric: true }] : [])];
      const cells = (m, result) => [displayedMetric(result, 'current', m.unit), displayedMetric(result, 'previous', m.unit),
        ...(query.changes.includes('absolute') ? [display(result.absolute, m.unit)] : []), ...(query.changes.includes('percent') ? [display(result.percent, '%')] : [])];
      text('Gesamtergebnis', { size: 13, bold: true });
      table(columns, selected.map(m => [m.label, ...cells(m, report.total.metrics[m.id])]), 'Gesamtergebnis');
      text('Hinweise zur Auswertung', { size: 11, bold: true });
      text('Historische Kassenpositionen; Hersteller und Sortiment entsprechen dem gespeicherten Verkaufsstand. Fehlende Tage sind keine bestätigten Nullumsätze. Bei einem leeren Quellzeitraum ist kein Vorjahresvergleich verfügbar.', { size: 8, gap: summaryGap });
      if (query.reportVersion >= 4) text('Die Zuordnung der Sortimentsgruppen zu WGR stammt aus dem beim Auftrag gespeicherten Quellkatalog. WGR- und Sortimentsauswahl werden gemeinsam angewendet.', { size: 8, gap: summaryGap });
      text('Retouren fließen mit ihrem Vorzeichen ein. Ungeprüfte Belege verhindern vollständige Summen. Prozentänderung: Differenz / Betrag des Vergleichswerts; bei Vergleichswert null nicht verfügbar.', { size: 8, gap: summaryGap });
      const openGroups = report.rows.filter(row => row.quality.current.review || row.quality.previous.review);
      if (openGroups.length) text('* = geprüfter Teilwert ohne offene Belege. Änderungen erfordern vollständige Werte. Prüfhinweise je Gruppe stehen am Berichtsende.', { size: 8, gap: summaryGap });
      if (query.metrics.some(id => ['customerCount', 'revenuePerCustomer', 'marginPerCustomer'].includes(id))) text('Kundenanzahl zählt unterschiedliche bekannte Kundenkonten. Anonyme Belege bleiben getrennt. Werte je Kunde verwenden ausschließlich Umsätze bzw. Roherträge dieser bekannten Konten. Kunden- und Belegzahlen verschiedener Gruppen dürfen nicht addiert werden.', { size: 8, gap: summaryGap });
      if (query.metrics.some(id => ['grossMargin', 'marginPerCustomer', 'marginRate'].includes(id)) && metadata.marginStatus !== 'confirmed') text('Rohertrag: Die Bedeutung des historischen Kassenfelds ist noch nicht bestätigt. Deshalb wird kein Rohertrag aus heutigen Einkaufspreisen oder ungeklärten Quellwerten berechnet.', { size: 8, gap: summaryGap });
      if (query.metrics.some(id => ['grossMargin', 'marginPerCustomer', 'marginRate'].includes(id)) && metadata.marginStatus === 'confirmed') text('Rohertrag: historischer Kassen-Rohertrag je Stück × verkaufte Menge, je Position auf Cent gerundet. Fehlt ein Quellwert, bleiben die betroffenen Rohertragskennzahlen nicht verfügbar.', { size: 8, gap: summaryGap });
      if (query.metrics.includes('marginRate')) text('Absolute Änderungen der Rohertragsquote sind Prozentpunkte.', { size: 8, gap: summaryGap });
      for (const [key, label] of [['current', 'Aktuell'], ['comparison', 'Vergleich']]) {
        const c = report.coverage[key];
        text(`${label}: ${c.selectedRecords} passende Positionen, ${c.review} ungeprüft, ${c.excluded} ausgeschlossen${metadata.projection.customers ? `, ${c.anonymousReceipts} Belege ohne bekanntes Kundenkonto` : ''}.`, { size: 8, gap: summaryGap });
      }
      for (const id of query.chartMetrics || [query.chartMetric]) chart(METRICS.find(m => m.id === id));
      for (const metric of selected) {
        page(metric.label + ' · Detailwerte');
        text(`${query.dateFrom} bis ${query.dateTo} | Vergleich ${query.comparisonFrom} bis ${query.comparisonTo}`, { size: 8, color: '#65746f' });
        if (metric === selected[0]) text('Sofortrabatte bleiben bei ihrer eigenen Warengruppe und Marke. Gutscheinausgaben erzeugen keinen Warenumsatz oder Rohertrag. Gutscheineinlösungen sind Zahlungsmittel. Umsatz und Rohertrag entstehen beim Warenkauf. Bestätigte Anzahlungen erhöhen bei Einzahlung den Umsatz und vermindern ihn bei Verrechnung. Sie bleiben in ihrer eigenen Warengruppe und Marke, ohne Rohertrag; der Waren-Rohertrag bleibt unverändert. UID-Zwischenbuchungen betreffen die Zahlungsabwicklung ohne Warenumsatz oder Rohertrag. Rabatt-, Anzahlungs-, Gutschein- und Verrechnungspositionen zählen nicht als verkaufte Stücke.', { size: 8 });
        table([{ ...columns[0], label: 'Gruppe', weight: 3.25 }, ...columns.slice(1)], report.rows.map(row => [row.dimensions.map(d => d.label).join(' / '), ...cells(metric, row.metrics[metric.id])]), metric.label);
        text(`Gesamt: ${displayedMetric(report.total.metrics[metric.id], 'current', metric.unit)}`, { bold: true });
        if (!report.rows.length) text('Keine passenden Positionen in den gewählten Quellzeiträumen.');
      }
      if (openGroups.length) {
        page('Offene Belegprüfungen');
        text('Geprüft / offen zählt die passenden Positionen je Gruppe. Eine offene Position kann durch eine andere Zeile desselben Belegs betroffen sein. Teilwerte enthalten ausschließlich vollständig geprüfte Belege.', { size: 8 });
        table([{ label: 'Gruppe', weight: 3 }, { label: 'Aktuell geprüft / offen', weight: 1.4 },
          { label: 'Vergleich geprüft / offen', weight: 1.4 }, { label: 'Prüfgrund', weight: 2 }], openGroups.map(row => [
            row.dimensions.map(d => d.label).join(' / '), `${row.quality.current.checked} / ${row.quality.current.review}`,
            `${row.quality.previous.checked} / ${row.quality.previous.review}`, reviewReasons(row.quality)]), 'Offene Belegprüfungen');
      }
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i); font(7, false, '#65746f').text(`Grabenplaner · Verkaufsanalyse · Seite ${i + 1} / ${range.count}`, left, pageHeight - 52, { width, lineBreak: false });
      }
      doc.end();
    } catch (error) { doc.destroy(error); }
  });
}
module.exports = { createSalesAnalysisPdf, display };
