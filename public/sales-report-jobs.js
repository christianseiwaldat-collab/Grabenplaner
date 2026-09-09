'use strict';
window.createSalesReportJobUi = function ({ api, visible }) {
  const el = id => document.getElementById(id), form = el('salesAnalyticsRequestForm'), hint = el('salesAnalyticsRequestHint'), list = el('salesReportJobList');
  let generation = 0, context = null, loading = false, busy = false, rows = [], comparisonCustom = false;
  const selectors = new Map();
  const errors = { IMPORT_HISTORY_DATE_RANGE: 'Bitte gültige Zeiträume mit höchstens 366 Tagen und ohne zukünftige Tage wählen.',
    IMPORT_REPORT_SELECTION: 'Bitte Kennzahlen, Filialen und Aufschlüsselung prüfen.', IMPORT_REPORT_GROUP_LIMIT: 'Zu viele Gruppen. Bitte nach WGR, Hersteller, Filiale oder MA eingrenzen.',
    IMPORT_REPORT_PDF_LIMIT: 'Der Bericht ist zu umfangreich. Bitte weniger Kennzahlen oder Gruppen auswählen.',
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
  function priorYear(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const [year, month, day] = value.split('-').map(Number), max = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
    return `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, max)).padStart(2, '0')}`;
  }
  function comparisonDates(force = false) {
    if (force) comparisonCustom = false;
    if (!comparisonCustom) { el('salesReportJobComparisonFrom').value = priorYear(el('salesReportJobFrom').value); el('salesReportJobComparisonTo').value = priorYear(el('salesReportJobTo').value); }
    el('salesReportComparisonMode').textContent = comparisonCustom ? 'Vergleichszeitraum individuell gewählt' : 'Automatisch ein Jahr zuvor';
  }
  function chartOptions() {
    if (!context) return;
    const select = el('salesReportJobChartMetric'), previous = select.value;
    select.replaceChildren(...context.metrics.filter(m => selected('salesReportJobMetrics').includes(m.id)).map(m => new Option(m.label, m.id)));
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
  }
  function configure(next) {
    context = next;
    multi('salesReportJobLocations', next.locations, next.locations.map(l => l.id), { all: true });
    multi('salesReportJobProductGroups', next.productGroups, [], { all: true, emptyAll: true }); multi('salesReportJobManufacturers', next.manufacturers, [], { all: true, emptyAll: true });
    multi('salesReportJobSellers', next.sellers, [], { all: true, emptyAll: true }); el('salesReportSellerField').hidden = !next.projection.sellers;
    multi('salesReportJobMetrics', next.metrics, ['netRevenue', 'quantity', 'receiptCount'], { searchable: false });
    for (const [id, initial, optional] of [['salesReportJobGroupPrimary', 'productGroup', false], ['salesReportJobGroupSecondary', 'manufacturer', true], ['salesReportJobGroupThird', '', true]]) {
      el(id).replaceChildren(...(optional ? [new Option('Keine weitere Aufschlüsselung', '')] : []), ...next.dimensions.map(d => new Option(d.label, d.id))); el(id).value = initial;
    }
    if (!el('salesReportJobFrom').value) el('salesReportJobFrom').value = next.today.slice(0, 4) + '-01-01';
    if (!el('salesReportJobTo').value) el('salesReportJobTo').value = next.today;
    for (const id of ['salesReportJobFrom', 'salesReportJobTo', 'salesReportJobComparisonFrom', 'salesReportJobComparisonTo']) el(id).max = next.today;
    comparisonDates();
    const marginHint = el('salesReportMarginHint'); marginHint.hidden = !next.projection.margin || next.marginStatus === 'confirmed';
    marginHint.textContent = 'Historischer Kassen-Rohertrag: Berechnungsbasis noch offen. Betroffene Kennzahlen werden im PDF als nicht verfügbar gekennzeichnet.';
    el('salesReportJobSubmit').disabled = !next.projection.read || !next.locations.length;
    hint.textContent = `${next.source.label}. Der Server erstellt den PDF-Bericht im Hintergrund. Bis zu drei offene Aufträge.`;
  }
  function render() {
    const query = el('salesReportJobFilter').value.toLocaleLowerCase('de-AT'); list.replaceChildren();
    for (const row of rows.filter(r => r.title.toLocaleLowerCase('de-AT').includes(query))) {
      const card = node('article', '', 'sales-report-job');
      card.append(node('h3', row.title), node('p', `${labels[row.status]} · ${row.format === 'pdf' ? 'PDF' : 'HTML (früherer Bericht)'} · ${row.processed} Positionen verarbeitet${row.phase === 'comparison' ? ' · Vergleichszeitraum' : ''}${row.restarts ? ` · ${row.restarts} Wiederanläufe` : ''}`),
        node('p', `${row.query.dateFrom} – ${row.query.dateTo}${row.query.comparisonFrom ? ` · Vergleich ${row.query.comparisonFrom} – ${row.query.comparisonTo}` : ''} · ${new Date(row.created).toLocaleString('de-AT')}`));
      if (row.error) card.append(node('p', errors[row.error] || 'Der Auftrag konnte nicht abgeschlossen werden. Bitte erneut beauftragen.'));
      const actions = node('div', '', 'sales-report-job-actions');
      const button = (text, work) => {
        const b = node('button', text, 'secondary-button'); b.type = 'button';
        b.addEventListener('click', async () => { b.disabled = true; const g = generation; try { await work(); if (g === generation) await refresh(); } catch (e) { if (g === generation) showError(e); } finally { b.disabled = false; } }); actions.append(b);
      };
      if (row.status === 'completed') { const a = node('a', row.format === 'pdf' ? 'PDF herunterladen' : 'Früheren Bericht herunterladen', 'secondary-button'); a.href = `/api/sales-report-jobs/${encodeURIComponent(row.id)}/download`; actions.append(a); }
      if (['queued', 'running'].includes(row.status)) button('Abbrechen', () => api(`/api/sales-report-jobs/${row.id}/cancel`, { method: 'POST', body: '{}' }));
      else {
        if (row.status !== 'completed') button('Erneut beauftragen', () => api('/api/sales-report-jobs', { method: 'POST', body: JSON.stringify({ title: row.title, query: row.query }) }));
        button('Entfernen', () => api(`/api/sales-report-jobs/${row.id}`, { method: 'DELETE' }));
      }
      card.append(actions); list.append(card);
    }
    if (!list.children.length) list.append(node('p', rows.length ? 'Keine passenden Berichte.' : 'Noch keine Berichte beauftragt.'));
  }
  async function refresh() {
    if (!visible() || loading) return;
    const g = generation; loading = true;
    try {
      if (!context) { const next = await api('/api/sales-report-jobs/context'); if (g !== generation) return; configure(next); }
      const next = await api('/api/sales-report-jobs'); if (g !== generation) return; el('salesReportJobError').hidden = true;
      if (JSON.stringify(rows) !== JSON.stringify(next) || !list.children.length) { rows = next; render(); }
    } catch (error) { if (g === generation) { if (error.code === 'IMPORT_FORBIDDEN') reset(); showError(error); context = null; rows = []; list.replaceChildren(); el('salesReportJobSubmit').disabled = true; } }
    finally { if (g === generation) loading = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !context) return;
    if (!selected('salesReportJobLocations').length || !selected('salesReportJobMetrics').length) { showError({ message: 'Bitte mindestens eine Filiale und eine Kennzahl auswählen.' }); return; }
    const g = generation; busy = true; el('salesReportJobSubmit').disabled = true;
    try {
      await api('/api/sales-report-jobs', { method: 'POST', body: JSON.stringify({ title: el('salesAnalyticsRequestQuery').value.trim() || 'Verkaufsanalyse', query: {
        reportVersion: 2, sourceId: 'compact-cash', dateFrom: el('salesReportJobFrom').value, dateTo: el('salesReportJobTo').value,
        comparisonFrom: el('salesReportJobComparisonFrom').value, comparisonTo: el('salesReportJobComparisonTo').value,
        locationIds: selected('salesReportJobLocations'), productGroupIds: selected('salesReportJobProductGroups'),
        manufacturerIds: [...selected('salesReportJobManufacturers'), ...extras('salesReportJobManufacturerExtra')],
        sellerIds: context.projection.sellers ? [...selected('salesReportJobSellers'), ...extras('salesReportJobSellerExtra')] : [],
        metrics: selected('salesReportJobMetrics'), groupBy: [...new Set(['salesReportJobGroupPrimary', 'salesReportJobGroupSecondary', 'salesReportJobGroupThird'].map(id => el(id).value).filter(Boolean))],
        chartMetric: el('salesReportJobChartMetric').value, changes: [...(el('salesReportJobAbsolute').checked ? ['absolute'] : []), ...(el('salesReportJobPercent').checked ? ['percent'] : [])] } }) });
      if (g === generation) { hint.textContent = 'PDF-Auftrag angenommen. Den Fortschritt und fertigen Download findest du unter „Berichte“.'; await refresh(); }
    } catch (error) { if (g === generation) showError(error); }
    finally { if (g === generation) { busy = false; el('salesReportJobSubmit').disabled = !context?.projection.read; } }
  });
  for (const id of ['salesReportJobFrom', 'salesReportJobTo']) el(id).addEventListener('change', () => comparisonDates());
  for (const id of ['salesReportJobComparisonFrom', 'salesReportJobComparisonTo']) el(id).addEventListener('input', () => { comparisonCustom = true; comparisonDates(); });
  el('salesReportJobPreviousYear').addEventListener('click', () => comparisonDates(true)); el('salesReportJobFilter').addEventListener('input', render);
  el('salesReportJobRefresh').addEventListener('click', () => { void refresh(); });
  setInterval(() => { if (visible() && !document.hidden) void refresh(); }, 4000);
  function reset() { generation++; context = null; loading = false; busy = false; rows = []; comparisonCustom = false; selectors.clear(); list.replaceChildren(); form.reset();
    for (const id of ['salesReportJobLocations', 'salesReportJobProductGroups', 'salesReportJobManufacturers', 'salesReportJobSellers', 'salesReportJobMetrics']) el(id).replaceChildren();
    el('salesReportJobFilter').value = ''; el('salesReportJobSubmit').disabled = true; hint.textContent = ''; el('salesReportJobError').hidden = true; el('salesReportJobError').textContent = ''; }
  return { refresh, reset };
};
