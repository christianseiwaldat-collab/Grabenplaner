'use strict';
function formatSalesReportDuration(value) {
  const totalSeconds = Math.max(0, Math.round(Number(value) || 0));
  return `${Math.floor(totalSeconds / 60)}min ${totalSeconds % 60}sek`;
}
window.createSalesReportJobUi = function ({ api, rawApi, visible, accessKey, canUse, printActive, windowPreferences, scale, navigate = () => {} }) {
  const controls = window.SalesReportControls, DataQuality = window.GrabenplanerDataQuality;
  const el = id => document.getElementById(id), form = el('salesAnalyticsRequestForm'), hint = el('salesAnalyticsRequestHint'), list = el('salesReportJobList'), quality = el('salesReportDataQuality');
  let generation = 0, context = null, loading = false, busy = false, rows = [], comparisonCustom = false;
  let mode = 'report', templates = [], templatesLoaded = false, activeTemplate = null;
  let pdfWindow = null, pdfSelection = null, libraryLoaded = false, chartDesigner = null, chartDesign;
  const designButton = document.createElement('button'); designButton.type = 'button'; designButton.className = 'secondary-button'; designButton.textContent = 'Diagramme gestalten …';
  const designHost = document.createElement('div'); designHost.className = 'sales-chart-design-launch'; designHost.append(designButton);
  const designNote = document.createElement('small'); designNote.textContent = 'Farben, Werte, Ecken und direkte Vergleiche'; designHost.append(designNote);
  el('salesReportJobChartType').closest('fieldset').append(designHost);
  designButton.addEventListener('click', () => {
    if (!context || !window.SalesChartDesign) return;
    chartDesigner ||= window.SalesChartDesign.mount({ document, windowPreferences, scale, key: accessKey || (() => 'report'),
      canUse: () => !!context?.projection.read && visible() && (canUse?.() ?? true),
      onApply: value => { chartDesign = value; if(value.showComparison && ['auto','shares'].includes(el('salesReportJobChartType').value))el('salesReportJobChartType').value='bars'; designNote.textContent = 'Eigene Gestaltung übernommen · wird mit der Vorlage gespeichert'; } });
    chartDesigner.open(chartDesign, designButton, context.metrics.filter(m => selected('salesReportJobMetrics').includes(m.id)));
  });
  const explorer = window.createSalesReportLibraryUi({ api, reportActions, reportSummary, onError: showError,
    editTemplate: (id, title) => templateWork(async g => { const item = await api('/api/sales-report-templates/' + id); if (g !== generation) return; activeTemplate = item; loadSettings({ ...item, title }); }),
    deleteTemplate: choice => templateWork(async g => { await api('/api/sales-report-templates/' + choice.id, { method: 'DELETE', body: JSON.stringify({ revision: choice.revision }) }); if (g !== generation) return; templates = templates.filter(t => t.id !== choice.id); if (activeTemplate?.id === choice.id) activeTemplate = null; renderTemplates(); }) });
  const canPrint = () => Boolean(canUse?.() && context?.projection.read && pdfSelection
    && pdfSelection.generation === generation && rows.some(row => row.id === pdfSelection.id && row.status === 'completed' && row.format === 'pdf'));
  function syncPrint() {
    if (!pdfWindow) return;
    if (printActive?.()) pdfWindow.activate(); else pdfWindow.deactivate();
    pdfWindow.sync();
  }
  function openPdf(row, target) {
    if (!rawApi || !accessKey || !canUse?.() || !printActive?.()) return;
    pdfSelection = { id: row.id, generation };
    if (!canPrint()) return;
    pdfWindow ||= window.GpExistingPdfWindow.mount({ document, rawApi, key: accessKey, canUse: canPrint, active: printActive,
      id: 'sales-report-job-pdf', title: 'Verkaufsbericht als PDF', windowPreferences, scale,
      commonFields: { title: 'readonly', filename: true, orientation: false },
      useServerFilename: input => input.values.filename === input.payload.defaultFilename,
      request(input) {
        if (!canPrint() || input.payload.id !== pdfSelection?.id || input.payload.generation !== generation) throw Error('Der Bericht ist nicht mehr verfügbar.');
        return window.GpSalesAnalyticsPrint.completedJobRequest(rows.find(item => item.id === input.payload.id));
      }, summary: 'Gespeicherter Originalbericht' });
    pdfWindow.open({ target, payload: { ...pdfSelection, defaultFilename: 'Verkaufsanalyse' }, values: { title: row.title, filename: 'Verkaufsanalyse' } });
  }
  const selectors = new Map();
  const errors = { IMPORT_HISTORY_DATE_RANGE: 'Bitte gültige Zeiträume mit höchstens 366 Tagen und ohne zukünftige Tage wählen.',
    IMPORT_REPORT_METADATA_LIMIT: 'Die Auswahl enthält zu viele Stammdatenbezeichnungen. Bitte die technische Betreuung verständigen; die importierten Verkaufsdaten bleiben erhalten.',
    IMPORT_REPORT_SELECTION: 'Bitte Kennzahlen, Filialen und Aufschlüsselung prüfen. Höchstens je 10 WGR, Sortimentsgruppen und Hersteller auswählen.', IMPORT_REPORT_GROUP_LIMIT: 'Zu viele Gruppen. Bitte nach WGR, Sortiment, Hersteller, Filiale oder MA eingrenzen. Grafiken unterstützen höchstens 50 Gruppen.',
    IMPORT_REPORT_TEMPLATE_LIMIT: 'Höchstens 50 persönliche Vorlagen. Bitte eine bestehende Vorlage bearbeiten oder entfernen.',
    IMPORT_REVISION_CONFLICT: 'Die Ablage oder Vorlage wurde inzwischen geändert. Bitte aktualisieren und erneut versuchen.',
    IMPORT_REPORT_FOLDER_NOT_EMPTY: 'Dieser Ordner enthält noch Dateien oder Unterordner. Bitte zuerst verschieben oder löschen.',
    IMPORT_REPORT_FOLDER_DUPLICATE: 'Hier gibt es bereits einen Ordner mit diesem Namen.',
    IMPORT_REPORT_FOLDER_LIMIT: 'Höchstens 100 Ordner. Bitte vorhandene Ordner verwenden oder leere Ordner löschen.',
    IMPORT_REPORT_PDF_LIMIT: 'Der Bericht ist zu umfangreich. Bitte weniger Kennzahlen oder Gruppen auswählen.',
    IMPORT_REPORT_DATA_LIMIT: 'Der Bericht umfasst zu viele Daten. Bitte den Zeitraum oder die Auswahl eingrenzen.',
    IMPORT_HISTORY_ANALYSIS_EXPIRED: 'Der Zwischenstand ist abgelaufen. Bitte den Bericht erneut beauftragen.',
    IMPORT_REPORT_WORKER_FAILED: 'Die Hintergrundberechnung wurde beendet. Bitte den Bericht erneut beauftragen.',
    IMPORT_REPORT_WORKER_TIMEOUT: 'Ein Berechnungsschritt hat zu lange gedauert. Bitte die Auswahl eingrenzen und erneut beauftragen.',
    IMPORT_FORBIDDEN: 'Die Berechtigung hat sich geändert. Bitte die Freigaben prüfen.',
    IMPORT_HISTORY_ANALYSIS_CHANGED: 'Der Datenstand hat sich geändert. Bitte einen neuen Auftrag erteilen.' };
  function showError(error) { const message = errors[error.code] || error.message; hint.textContent = message; const target = el('salesReportJobError'); target.hidden = false; target.textContent = message; }
  const labels = { queued: 'Wartet', running: 'Wird erstellt', completed: 'Fertig', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen' };
  function node(tag, text, className) { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; }
  function multi(id, options, selected = [], { searchable = true, all = false, emptyAll = false } = {}) {
    const host = el(id), values = new Set(selected), checks = node('div', '', 'sales-report-checks'), counter = node('small', ''); host.replaceChildren();
    const update = () => { counter.textContent = !values.size && emptyAll ? 'Alle (keine Eingrenzung)' : `${values.size} ausgewählt`; if (id === 'salesReportJobMetrics') chartOptions(); };
    if (searchable) {
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Auswahl durchsuchen'; search.setAttribute('aria-label', host.closest('fieldset').querySelector('legend').textContent + ' durchsuchen');
      search.addEventListener('input', () => { const q = search.value.trim().toLocaleLowerCase('de-AT'); for (const label of checks.children) label.hidden = !label.textContent.toLocaleLowerCase('de-AT').includes(q); }); host.append(search);
    }
    if (all) {
      const actions = node('div', '', 'sales-report-selection-actions');
      for (const [label, checked] of (emptyAll ? [['Alle (keine Eingrenzung)', false]] : [['Alle auswählen', true], ['Auswahl leeren', false]])) {
        const b = node('button', label, 'text-button'); b.type = 'button'; b.addEventListener('click', () => { values.clear(); for (const input of checks.querySelectorAll('input')) { input.checked = checked; if (checked) values.add(input.value); } update(); }); actions.append(b);
      } host.append(actions);
    }
    for (const option of options) {
      const label = node('label', ''), input = document.createElement('input'); input.type = 'checkbox'; input.value = option.id; input.checked = values.has(option.id);
      input.addEventListener('change', () => { input.checked ? values.add(input.value) : values.delete(input.value); update(); }); label.append(input, node('span', option.label)); checks.append(label);
    }
    host.append(checks, counter); selectors.set(id, values); update();
  }
  const selected = id => [...(selectors.get(id) || [])];
  const extras = id => el(id).value.split(',').map(s => s.trim()).filter(Boolean);
  function comparisonDates(force = false) {
    if (force) comparisonCustom = false;
    if (!comparisonCustom) {
      el('salesReportJobComparisonFrom').value = controls.previousYear(el('salesReportJobFrom').value);
      el('salesReportJobComparisonTo').value = controls.previousYear(el('salesReportJobTo').value);
      comparisonPeriod.sync(currentPeriod.mode());
    }
    el('salesReportComparisonMode').textContent = comparisonCustom ? 'Vergleichszeitraum individuell gewählt' : 'Automatisch ein Jahr zuvor';
  }
  function chartOptions(chosen) {
    if (!context) return;
    const previous = chosen || selected('salesReportJobChartMetric');
    const options = context.metrics.filter(m => selected('salesReportJobMetrics').includes(m.id));
    const valid = previous.filter(id => options.some(m => m.id === id));
    multi('salesReportJobChartMetric', options, valid.length ? valid : options.slice(0, 1).map(m => m.id), { searchable: false, all: true });
    for (const input of el('salesReportJobChartMetric').querySelectorAll('input,button')) input.disabled = el('salesReportJobChartType').value === 'none';
  }
  function configure(next) {
    context = next;
    multi('salesReportJobLocations', next.locations, next.locations.map(l => l.id), { all: true });
    el('salesReportOnlineHint').hidden = !next.locations.some(l => l.id === 'tradefoto-online');
    selectors.set('salesReportJobProductGroups', controls.transferPicker(el('salesReportJobProductGroups'), next.productGroups));
    selectors.set('salesReportJobMerchandiseGroups', controls.transferPicker(el('salesReportJobMerchandiseGroups'), next.merchandiseGroups || []));
    selectors.set('salesReportJobManufacturers', controls.transferPicker(el('salesReportJobManufacturers'), next.manufacturers));
    multi('salesReportJobSellers', next.sellers, [], { all: true, emptyAll: true }); el('salesReportSellerField').hidden = !next.projection.sellers;
    multi('salesReportJobMetrics', next.metrics, ['netRevenue', 'quantity', 'receiptCount'], { searchable: false });
    multi('salesGraphicMetric', next.metrics, ['netRevenue'], { searchable: false, all: true });
    el('salesGraphicGroup').replaceChildren(new Option('Gesamte Auswahl gemeinsam', ''), ...next.dimensions.map(d => new Option('Eine Grafik je ' + d.label, d.id)));
    for (const [id, initial, optional] of [['salesReportJobGroupPrimary', 'productGroup', false], ['salesReportJobGroupSecondary', 'manufacturer', true], ['salesReportJobGroupThird', '', true]]) {
      el(id).replaceChildren(...(optional ? [new Option('Keine weitere Aufschlüsselung', '')] : []), ...next.dimensions.map(d => new Option(d.label, d.id))); el(id).value = initial;
    }
    if (!el('salesReportJobFrom').value) el('salesReportJobFrom').value = next.today.slice(0, 4) + '-01-01';
    if (!el('salesReportJobTo').value) el('salesReportJobTo').value = next.today;
    for (const id of ['salesReportJobFrom', 'salesReportJobTo', 'salesReportJobComparisonFrom', 'salesReportJobComparisonTo']) el(id).max = next.today;
    currentPeriod.sync(); comparisonDates();
    const marginHint = el('salesReportMarginHint'); marginHint.hidden = !next.projection.margin || next.marginStatus === 'confirmed';
    marginHint.textContent = 'Historischer Kassen-Rohertrag: Berechnungsbasis noch offen. Betroffene Kennzahlen werden im PDF als nicht verfügbar gekennzeichnet.';
    el('salesReportJobSubmit').disabled = !next.projection.read || !next.locations.length;
    templateButtons();
    hint.textContent = `${next.source.label}. Der Server erstellt den PDF-Bericht im Hintergrund. Bis zu drei offene Aufträge.`;
    if (quality) quality.innerHTML = DataQuality.render({ title: 'Datengrundlage · Verkaufsanalysen', source: DataQuality.sourceInfo(next.sourceQuality), calendarUnknown: true, note: 'Der Bericht verwendet geprüfte importierte Kassenpositionen. Offene Prüfungen und fehlender Rohertrag werden im Ergebnis ausgewiesen.' });
  }
  function render() { explorer.update(rows, templates); syncPrint(); }
  function reportSummary(row) {
    return `${labels[row.status]} · ${row.processed} Positionen verarbeitet${row.status === 'completed' && Number.isFinite(Number(row.durationSeconds)) ? ` · Dauer: ${formatSalesReportDuration(row.durationSeconds)}` : ''}`;
  }
  function reportActions(row) {
    const actions = [];
    const work = action => async target => { const g = generation; try { await action(target); if (g === generation) await refresh(); } catch (error) { if (g === generation) showError(error); } };
    if (row.status === 'completed') actions.push({ label: row.format === 'pdf' ? 'PDF öffnen' : 'Bericht herunterladen', primary: true, run: target => {
      if (row.format === 'pdf') openPdf(row, target);
      else { const a = document.createElement('a'); a.href = '/api/sales-report-jobs/' + encodeURIComponent(row.id) + '/download'; a.click(); }
    } });
    if (row.status === 'completed' && row.format === 'pdf') actions.push({ label: 'PDF herunterladen', run: () => { const a = document.createElement('a'); a.href = '/api/sales-report-jobs/' + encodeURIComponent(row.id) + '/download'; a.download = ''; a.click(); } });
    if (row.query?.sourceId === 'compact-cash') actions.push({ label: 'Als Vorlage für neuen Bericht verwenden', run: () => { activeTemplate = null; loadSettings({ title: row.title, query: row.query }); } });
    if (['queued', 'running'].includes(row.status)) actions.push({ label: 'Abbrechen', run: work(() => api('/api/sales-report-jobs/' + row.id + '/cancel', { method: 'POST', body: '{}' })) });
    else {
      if (row.status !== 'completed') actions.push({ label: 'Erneut beauftragen', run: work(() => api('/api/sales-report-jobs', { method: 'POST', body: JSON.stringify({ title: row.title, query: row.query }) })) });
      actions.push({ label: 'Entfernen', run: work(() => api('/api/sales-report-jobs/' + row.id, { method: 'DELETE' })) });
    }
    return actions;
  }
  async function refresh() {
    if (!visible() || loading) return;
    const g = generation; loading = true;
    try {
      if (!context) { const next = await api('/api/sales-report-jobs/context'); if (g !== generation) return; configure(next); }
      if (!libraryLoaded) { const saved = await api('/api/sales-report-library'); if (g !== generation) return; explorer.update(rows, templates, saved); libraryLoaded = true; }
      if (!templatesLoaded) { const saved = await api('/api/sales-report-templates'); if (g !== generation) return; templates = saved; templatesLoaded = true; renderTemplates(); }
      const next = await api('/api/sales-report-jobs'); if (g !== generation) return; el('salesReportJobError').hidden = true;
      if (JSON.stringify(rows) !== JSON.stringify(next) || !list.children.length) { rows = next; render(); }
    } catch (error) { if (g === generation) { if (error.code === 'IMPORT_FORBIDDEN') reset(); showError(error); context = null; rows = []; templates = []; libraryLoaded = false; templatesLoaded = false; explorer.reset(); list.replaceChildren(); quality?.replaceChildren(); el('salesReportJobSubmit').disabled = true; syncPrint(); } }
    finally { if (g === generation) loading = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !context) return;
    if (!selected('salesReportJobLocations').length || !selected(mode === 'graphic' ? 'salesGraphicMetric' : 'salesReportJobMetrics').length) { showError({ message: 'Bitte mindestens eine Filiale und eine Kennzahl auswählen.' }); return; }
    const g = generation; busy = true; el('salesReportJobSubmit').disabled = true;
    try {
      const created = await api('/api/sales-report-jobs', { method: 'POST', body: JSON.stringify({ title: el('salesAnalyticsRequestQuery').value.trim() || 'Verkaufsanalyse', query: collectQuery() }) });
      if (g === generation) { await explorer.place(created, 'report'); hint.textContent = 'PDF-Auftrag angenommen. Den Fortschritt und fertigen Download findest du unter „Berichte“.'; await refresh(); }
    } catch (error) { if (g === generation) showError(error); }
    finally { if (g === generation) { busy = false; el('salesReportJobSubmit').disabled = !context?.projection.read; templateButtons(); } }
  });
  function collectQuery() {
    const graphic = mode === 'graphic', chartMetrics = selected(graphic ? 'salesGraphicMetric' : 'salesReportJobChartMetric');
    if (!chartMetrics.length && (graphic || el('salesReportJobChartType').value !== 'none')) throw { message: 'Bitte mindestens eine Kennzahl für die Diagramme auswählen.' };
    return { reportVersion: 4, sourceId: 'compact-cash', dateFrom: el('salesReportJobFrom').value, dateTo: el('salesReportJobTo').value,
      comparisonFrom: graphic ? controls.previousYear(el('salesReportJobFrom').value) : el('salesReportJobComparisonFrom').value,
      comparisonTo: graphic ? controls.previousYear(el('salesReportJobTo').value) : el('salesReportJobComparisonTo').value,
      locationIds: selected('salesReportJobLocations'), productGroupIds: selected('salesReportJobProductGroups'), merchandiseGroupIds: selected('salesReportJobMerchandiseGroups'),
      manufacturerIds: selected('salesReportJobManufacturers'), sellerIds: context.projection.sellers ? [...new Set([...selected('salesReportJobSellers'), ...extras('salesReportJobSellerExtra')])] : [],
      metrics: graphic ? chartMetrics : selected('salesReportJobMetrics'),
      groupBy: graphic ? [el('salesGraphicGroup').value].filter(Boolean) : [...new Set(['salesReportJobGroupPrimary', 'salesReportJobGroupSecondary', 'salesReportJobGroupThird'].map(id => el(id).value).filter(Boolean))],
      orientation: el(graphic ? 'salesGraphicOrientation' : 'salesReportJobOrientation').value,
      chartType: graphic ? 'timeline' : el('salesReportJobChartType').value, chartMetric: chartMetrics[0] || selected('salesReportJobMetrics')[0],
      chartMetrics: chartMetrics.length ? chartMetrics : [selected('salesReportJobMetrics')[0]],
      changes: graphic ? [] : [...(el('salesReportJobAbsolute').checked ? ['absolute'] : []), ...(el('salesReportJobPercent').checked ? ['percent'] : [])],
      ...(!graphic && chartDesign ? { chartDesign: { ...chartDesign, annotations: chartDesign.annotations.filter(id => selected('salesReportJobMetrics').includes(id)) } } : {}),
      ...(graphic ? { timeGrain: el('salesGraphicGrain').value, chartStyle: el('salesGraphicStyle').value } : {}) };
  }
  function setMode(next) {
    mode = next === 'graphic' ? 'graphic' : 'report'; const graphic = mode === 'graphic';
    const host = el(graphic ? 'salesReportGraphicEditor' : 'salesReportCreateEditor');
    if (form.parentElement !== host) host.append(form, hint);
    for (const field of form.querySelectorAll('[data-report-only]')) { field.hidden = graphic; field.disabled = graphic; }
    for (const field of form.querySelectorAll('[data-graphic-only]')) { field.hidden = !graphic; field.disabled = !graphic; }
    el('salesReportJobSubmit').textContent = graphic ? 'Grafik-PDF beauftragen' : 'PDF-Bericht beauftragen';
  }
  function loadSettings(item) {
    if (!context) return;
    const q = item.query, graphic = q.chartType === 'timeline';
    chartDesign = q.chartDesign ? window.SalesChartOptions.normalize(q.chartDesign) : undefined;
    designNote.textContent = chartDesign ? 'Eigene Gestaltung aus der Vorlage geladen' : 'Farben, Werte, Ecken und direkte Vergleiche';
    setMode(graphic ? 'graphic' : 'report'); navigate(graphic ? 'graphics' : 'create');
    el('salesAnalyticsRequestQuery').value = item.title;
    for (const [id, value] of [['salesReportJobFrom', q.dateFrom], ['salesReportJobTo', q.dateTo], ['salesReportJobComparisonFrom', q.comparisonFrom || controls.previousYear(q.dateFrom)], ['salesReportJobComparisonTo', q.comparisonTo || controls.previousYear(q.dateTo)]]) el(id).value = value;
    multi('salesReportJobLocations', context.locations, q.locationIds || [], { all: true });
    for (const [id, choices, chosen] of [['salesReportJobMerchandiseGroups', context.merchandiseGroups || [], q.merchandiseGroupIds || []], ['salesReportJobProductGroups', context.productGroups, q.productGroupIds || []], ['salesReportJobManufacturers', context.manufacturers, q.manufacturerIds || []]]) selectors.set(id, controls.transferPicker(el(id), choices, chosen));
    multi('salesReportJobSellers', context.sellers, q.sellerIds || [], { all: true, emptyAll: true });
    el('salesReportJobSellerExtra').value = (q.sellerIds || []).filter(id => !context.sellers.some(s => s.id === id)).join(', ');
    if (graphic) { multi('salesGraphicMetric', context.metrics, q.chartMetrics || [q.chartMetric], { searchable: false, all: true }); el('salesGraphicStyle').value = q.chartStyle || 'classic'; graphicPreview(); el('salesGraphicGrain').value = q.timeGrain || 'month'; el('salesGraphicGroup').value = q.groupBy?.[0] || ''; el('salesGraphicOrientation').value = q.orientation || 'landscape'; }
    else {
      multi('salesReportJobMetrics', context.metrics, q.metrics, { searchable: false });
      ['salesReportJobGroupPrimary', 'salesReportJobGroupSecondary', 'salesReportJobGroupThird'].forEach((id, index) => { el(id).value = (q.groupBy || ['productGroup', 'manufacturer'])[index] || ''; });
      el('salesReportJobOrientation').value = q.orientation || 'portrait'; el('salesReportJobChartType').value = q.chartType || 'auto'; chartOptions(q.chartMetrics || [q.chartMetric]);
      el('salesReportJobAbsolute').checked = (q.changes || []).includes('absolute'); el('salesReportJobPercent').checked = (q.changes || []).includes('percent');
    }
    comparisonCustom = item.presentation?.comparisonCustom ?? true;
    currentPeriod.sync(item.presentation?.periodMode || 'custom'); comparisonPeriod.sync(item.presentation?.comparisonMode || 'custom');
    el('salesReportComparisonMode').textContent = comparisonCustom ? 'Vergleichszeitraum individuell gewählt' : 'Automatisch ein Jahr zuvor';
    templateButtons(); hint.textContent = 'Einstellungen geladen. Du kannst alle Felder anpassen und anschließend eine neue PDF beauftragen.';
  }
  function templateButtons() {
    el('salesReportTemplateTitle').textContent = activeTemplate ? 'Vorlage: ' + activeTemplate.title : 'Gespeicherte Vorlagen findest du unter Berichte.';
    el('salesReportTemplateSave').disabled = busy || !context?.projection.read;
    el('salesReportTemplateSave').textContent = activeTemplate ? 'Vorlage aktualisieren' : 'Als Vorlage speichern';
    el('salesReportTemplateCopy').hidden = !activeTemplate; el('salesReportTemplateCopy').disabled = busy;
  }
  function renderTemplates() { templateButtons(); render(); }
  async function templateWork(work) {
    if (busy || !context) return; const g = generation; busy = true; templateButtons(); el('salesReportJobSubmit').disabled = true;
    try { await work(g); } catch (error) { if (g === generation) showError(error); }
    finally { if (g === generation) { busy = false; templateButtons(); el('salesReportJobSubmit').disabled = !context?.projection.read; } }
  }
  async function saveTemplate(copy = false) {
    if (!form.reportValidity()) return;
    const title = el('salesAnalyticsRequestQuery').value.trim();
    if (!title) { showError({ message: 'Bitte einen Titel für die Vorlage eingeben.' }); el('salesAnalyticsRequestQuery').focus(); return; }
    await templateWork(async g => {
      const target = copy ? null : activeTemplate;
      const item = await api('/api/sales-report-templates' + (target ? '/' + target.id : ''), { method: target ? 'PUT' : 'POST', body: JSON.stringify({ title, query: collectQuery(),
        presentation: { periodMode: currentPeriod.mode(), comparisonMode: comparisonPeriod.mode(), comparisonCustom }, ...(target ? { revision: target.revision } : {}) }) });
      if (g !== generation) return; activeTemplate = item; await explorer.place(item, 'template');
      const saved = await api('/api/sales-report-templates'); if (g !== generation) return; templates = saved; renderTemplates(); hint.textContent = 'Berichtsvorlage gespeichert. Es wurde noch kein PDF-Auftrag gestartet.';
    });
  }
  el('salesReportTemplateSave').addEventListener('click', () => { void saveTemplate(); });
  el('salesReportTemplateCopy').addEventListener('click', () => { void saveTemplate(true); });
  function graphicPreview() { window.renderSalesGraphicPreview?.(el('salesGraphicStyle').value); }
  el('salesGraphicStyle').addEventListener('change', graphicPreview); graphicPreview();
  const today = () => context?.today || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna' }).format(new Date());
  const currentPeriod = controls.periodPicker(el('salesReportJobPeriod'), { from: el('salesReportJobFrom'), to: el('salesReportJobTo'), today, onChange: () => comparisonDates() });
  const comparisonPeriod = controls.periodPicker(el('salesReportJobComparisonPeriod'), { from: el('salesReportJobComparisonFrom'), to: el('salesReportJobComparisonTo'), today, onChange: () => { comparisonCustom = true; comparisonDates(); } });
  el('salesReportJobChartType').addEventListener('change', () => chartOptions());
  el('salesReportJobPreviousYear').addEventListener('click', () => comparisonDates(true));
  el('salesReportJobRefresh').addEventListener('click', () => { templatesLoaded = false; libraryLoaded = false; void refresh(); });
  setInterval(() => { if (visible() && !document.hidden) void refresh(); }, 4000);
  function reset() { generation++; chartDesigner?.reset(); chartDesign = undefined; explorer.reset(); libraryLoaded = false; pdfWindow?.reset(); pdfSelection = null; context = null; loading = false; busy = false; rows = []; comparisonCustom = false; templates = []; templatesLoaded = false; activeTemplate = null; selectors.clear(); list.replaceChildren(); quality?.replaceChildren(); form.reset(); currentPeriod.sync('custom'); comparisonPeriod.sync('custom'); renderTemplates();
    for (const id of ['salesReportJobLocations', 'salesReportJobProductGroups', 'salesReportJobMerchandiseGroups', 'salesReportJobManufacturers', 'salesReportJobSellers', 'salesReportJobMetrics', 'salesGraphicMetric', 'salesGraphicGroup']) el(id).replaceChildren();
    el('salesReportJobFilter').value = ''; el('salesReportJobSubmit').disabled = true; hint.textContent = ''; el('salesReportJobError').hidden = true; el('salesReportJobError').textContent = ''; }
  return { refresh, reset, setMode, syncPrint };
};
