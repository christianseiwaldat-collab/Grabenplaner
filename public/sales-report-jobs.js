'use strict';
window.createSalesReportJobUi = function ({ api, visible }) {
  const el = id => document.getElementById(id), form = el('salesAnalyticsRequestForm'), hint = el('salesAnalyticsRequestHint'), list = el('salesReportJobList');
  let generation = 0, context = null, loading = false, busy = false, rows = [];
  function showError(error) { hint.textContent = error.message; const target = el('salesReportJobError'); if (target) { target.hidden = false; target.textContent = error.message; } }
  const labels = { queued: 'Wartet', running: 'Wird erstellt', completed: 'Fertig', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen' };
  function node(tag, text, className) { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; }
  function render() {
    const query = el('salesReportJobFilter').value.toLocaleLowerCase('de-AT');
    list.replaceChildren();
    for (const row of rows.filter(r => r.title.toLocaleLowerCase('de-AT').includes(query))) {
      const card = node('article', '', 'sales-report-job'), heading = node('h3', row.title);
      card.append(heading, node('p', `${labels[row.status]} · ${row.processed} Positionen verarbeitet${row.restarts ? ` · ${row.restarts} Wiederanläufe` : ''}`),
        node('p', `${row.query.dateFrom} – ${row.query.dateTo} · ${new Date(row.created).toLocaleString('de-AT')}`));
      if (row.error) card.append(node('p', row.error === 'IMPORT_FORBIDDEN' ? 'Die Berechtigung hat sich geändert. Bitte die Freigaben prüfen.' : row.error === 'IMPORT_HISTORY_ANALYSIS_CHANGED' ? 'Der Datenstand hat sich geändert. Bitte einen neuen Auftrag erteilen.' : 'Der Auftrag konnte nicht abgeschlossen werden. Bitte erneut beauftragen.'));
      const actions = node('div', '', 'sales-report-job-actions');
      const button = (text, work) => {
        const b = node('button', text, 'secondary-button'); b.type = 'button';
        b.addEventListener('click', async () => { b.disabled = true; const g = generation; try { await work(); if (g === generation) await refresh(); } catch (e) { if (g === generation) showError(e); } finally { b.disabled = false; } }); actions.append(b);
      };
      if (row.status === 'completed') { const a = node('a', 'Bericht herunterladen', 'secondary-button'); a.href = `/api/sales-report-jobs/${encodeURIComponent(row.id)}/download`; actions.append(a); }
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
      if (!context) {
        const next = await api('/api/sales-history/context'); if (g !== generation) return;
        context = next;
        const source = context.sources.find(s => s.id === 'compact-cash');
        el('salesReportJobLocation').replaceChildren(new Option('Alle freigegebenen Filialen', ''));
        for (const location of source?.locations || []) el('salesReportJobLocation').append(new Option(location.label || location.name || location.id, location.id));
        if (!el('salesReportJobFrom').value) el('salesReportJobFrom').value = context.today?.slice(0, 4) + '-01-01';
        if (!el('salesReportJobTo').value) el('salesReportJobTo').value = context.today || '';
        el('salesReportJobSubmit').disabled = !source || !context.projection?.read;
        hint.textContent = source ? 'Umsatz nach Zeitraum und Filiale. Der Server arbeitet weiter, auch wenn du diese Seite schließt. Bis zu drei offene Aufträge; fertige Berichte lassen sich herunterladen und drucken.' : 'Die geprüfte Kassendatenquelle ist derzeit nicht verfügbar.';
      }
      const next = await api('/api/sales-report-jobs'); if (g !== generation) return;
      if (el('salesReportJobError')) el('salesReportJobError').hidden = true;
      if (JSON.stringify(rows) !== JSON.stringify(next) || !list.children.length) { rows = next; render(); }
    } catch (error) { if (g === generation) { showError(error); context = null; rows = []; list.replaceChildren(); el('salesReportJobSubmit').disabled = true; } }
    finally { if (g === generation) loading = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !context) return;
    const g = generation; busy = true; el('salesReportJobSubmit').disabled = true;
    try {
      await api('/api/sales-report-jobs', { method: 'POST', body: JSON.stringify({ title: el('salesAnalyticsRequestQuery').value.trim() || 'Umsatzauswertung',
        query: { sourceId: 'compact-cash', dateFrom: el('salesReportJobFrom').value, dateTo: el('salesReportJobTo').value, locationId: el('salesReportJobLocation').value } }) });
      if (g === generation) { hint.textContent = 'Auftrag angenommen. Den Fortschritt findest du unter „Berichte“.'; await refresh(); }
    } catch (error) { if (g === generation) showError(error); }
    finally { if (g === generation) { busy = false; el('salesReportJobSubmit').disabled = false; } }
  });
  el('salesReportJobFilter').addEventListener('input', render);
  el('salesReportJobRefresh').addEventListener('click', () => { context = null; void refresh(); });
  setInterval(() => { if (visible() && !document.hidden) void refresh(); }, 4000);
  return { refresh, reset() { generation++; context = null; loading = false; busy = false; rows = []; list.replaceChildren(); form.reset(); el('salesReportJobFilter').value = ''; el('salesReportJobSubmit').disabled = true; hint.textContent = ''; if (el('salesReportJobError')) { el('salesReportJobError').hidden = true; el('salesReportJobError').textContent = ''; } } };
};
