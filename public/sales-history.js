(function attach(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrabenplanerSalesHistory = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function historyModule() {
  'use strict';
  const ArticleHistory = typeof module === 'object' && module.exports ? require('./trade-article-history') : globalThis.GrabenplanerArticleHistory;
  const DataQuality = typeof module === 'object' && module.exports ? require('./gp-data-quality') : globalThis.GrabenplanerDataQuality;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const statuses = { linked: 'Zugeordnet', historical_mapping: 'Historisch zugeordnet', unassigned: 'Nicht zugeordnet',
    unlinked: 'Zuordnung offen', missing_source: 'Altreferenz fehlt', target_missing: 'GP-Ziel fehlt', target_inactive: 'GP-Ziel inaktiv' };
  const issues = { SALES_SEMANTICS_UNCONFIRMED: 'Storno-, Preis- und Steuerregeln noch nicht bestätigt',
    RECEIPT_SOURCE_COVERAGE_UNCONFIRMED: 'Vollständigkeit des Quellbelegs noch nicht bestätigt', RECEIPT_SOURCE_COVERAGE_MISMATCH: 'Quellbeleg nicht vollständig abgeglichen',
    SOURCE_IMPORT_NOT_COMPLETE: 'Importlauf noch nicht abgeschlossen', RECEIPT_AMOUNT_MISMATCH: 'Belegsumme weicht ab',
    ANALYSIS_LIMIT_NARROW_DATE_RANGE: 'Prüfgrenze erreicht – bitte den Zeitraum oder die Filiale eingrenzen',
    SEPARATE_CASH_DATA_NOT_SALES: 'Kassenbewegungen sind keine zusätzlichen Verkäufe', STALE_RECEIPT_PARENT_REVISION: 'Belegkopf wurde geändert – erneuter Abgleich erforderlich' };
  const issueText = code => issues[code] || 'Fachlicher Belegabgleich erforderlich';
  const number = value => value === null || value === undefined ? '–' : String(value).replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1').replace('.', ',');
  const refLabel = ref => ref?.targetId ? `${ref.targetId} · ${statuses[ref.status] || 'Zuordnung prüfen'}` : statuses[ref?.status] || 'Nicht zugeordnet';
  const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;
  function defaultPeriod(today, customerId = null) {
    const start = new Date(`${today}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 364);
    return { from: customerId ? start.toISOString().slice(0, 10) : today.slice(0, 4) + '-01-01', to: today };
  }
  function renderTable(items, kind, sort = { key: 'date', direction: -1 }) {
    const sales = kind === 'sales', rows = [...items].sort((a, b) => String((sort.key==='description'?a.displayDescription||a.description:a[sort.key]) ?? '').localeCompare(String((sort.key==='description'?b.displayDescription||b.description:b[sort.key]) ?? ''), 'de-AT', { numeric: true }) * sort.direction);
    const heading = (key, label) => `<th scope="col" aria-sort="${sort.key === key ? sort.direction === 1 ? 'ascending' : 'descending' : 'none'}"><button type="button" data-history-sort="${key}">${label}</button></th>`;
    return `<div class="sales-history-table-scroll" tabindex="0" role="region" aria-label="Suchergebnisse, sortierbare aktuelle Seite"><table>
      <caption>Sortierung der angezeigten Seite · ${items.length} Datensätze</caption><thead><tr>${heading('date', 'Tag')}${heading('receipt', 'Beleg')}${heading('description', sales ? 'Artikel / Bezeichnung' : 'Buchung')}
      ${sales ? '<th scope="col">Menge</th><th scope="col">Geprüft brutto</th>' : '<th scope="col">Einzahlung</th><th scope="col">Auszahlung</th>'}<th scope="col">Details</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${escape(row.date)}</td><td>${escape(row.receipt || '–')}</td><td>${escape(row.displayDescription || row.description || 'Ohne Bezeichnung')}${ArticleHistory.referenceMarkup(row.articleDisplay,row.description)}${sales ? `<small>${escape(row.article || 'Artikelreferenz fehlt')}</small>` : ''}</td>
      ${sales ? `<td>${escape(number(row.quantity))}</td><td>${row.metric ? `${escape(number(row.metric.gross))} ${escape(row.metric.currency)}` : '<span class="sales-history-review">Prüfung offen</span>'}</td>`
        : `<td>${escape(number(row.inflow))}</td><td>${escape(number(row.outflow))}</td>`}
      <td><details><summary>Details</summary><dl><dt>Filialzuordnung</dt><dd>${escape(refLabel(row.location))}</dd>
      ${sales ? `<dt>Artikelzuordnung</dt><dd>${escape(refLabel(row.articleReference))}</dd><dt>Quellpreis (ungeprüft)</dt><dd>${escape(number(row.sourcePrice))}</dd>` : `<dt>Konto</dt><dd>${escape(row.account || '–')}</dd>`}
      ${row.sellers ? `<dt>Positionsverkäufer</dt><dd>${escape(refLabel(row.sellers.line))}</dd><dt>Belegverkäufer</dt><dd>${escape(refLabel(row.sellers.header))}</dd>` : ''}
      <dt>Quellstand</dt><dd>${escape(row.provenance?.snapshotAt || '–')}</dd><dt>Importiert</dt><dd>${escape(row.provenance?.importedAt || '–')}</dd>
      <dt>Prüfung</dt><dd>${escape(row.metric ? ({ sale: 'Verkauf', return: 'Rückgabe', adjustment: 'Rabatt / Gegenbuchung', deposit: 'Anzahlung / Verrechnung · ohne Rohertrag', payment: 'Zahlungsmittel', voucher_issue: 'Gutscheinausgabe · kein Warenumsatz', uid_clearing: 'UID-Zwischenbuchung · kein Warenumsatz', excluded: 'Ausgeschlossen' }[row.metric.status] || 'Geprüft') : (row.issues || []).map(issueText).join(' · '))}</dd></dl></details></td></tr>`).join('') || '<tr><td colspan="6">Keine zugeordneten Datensätze im gewählten Bereich. Das beweist keinen Umsatz von null.</td></tr>'}</tbody></table></div>`;
  }
  function renderCustomerAssignment(result) {
    const assignment = result.customerAssignment;
    if (!assignment) return '';
    const confirmed = assignment.status === 'linked' || assignment.status === 'historical_mapping';
    if (!confirmed) {
      const unusable = assignment.status === 'target_missing' || assignment.status === 'target_inactive';
      return `<p class="sales-history-customer-assignment"><strong>${unusable ? 'Kundenzuordnung derzeit nicht nutzbar.' : 'Kundenzuordnung offen.'}</strong> ${unusable ? 'Die Verbindung zu dieser Kundenkartei muss geprüft werden.' : 'Eine bestätigte Verbindung dieser Kundenkartei zu den importierten Kassenbelegen fehlt.'} Die Kaufhistorie kann deshalb noch nicht vollständig zugeordnet werden. Eine leere Liste bestätigt nicht, dass keine Käufe vorliegen.</p>`;
    }
    const label = assignment.status === 'historical_mapping' ? 'Historische Kundenzuordnung bestätigt.' : 'Kundenzuordnung bestätigt.';
    const detail = assignment.method === 'master' ? 'Die Kundenkartei ist mit dem importierten Kundenstamm verbunden.'
      : assignment.method === 'publication' ? 'Die Kundenkartei ist mit den Kassenbelegen des ausgewählten Datenstands verbunden.' : 'Die Verbindung dieser Kundenkartei zu den importierten Kassenbelegen wurde bestätigt.';
    const empty = result.coverage.complete && result.coverage.counts.records === 0
      ? ' In den freigegebenen Filialen und im gewählten Zeitraum wurden keine zugeordneten Käufe im ausgewählten Datenstand gefunden. Die Vollständigkeit der Quelldaten ist damit nicht bestätigt.' : '';
    return `<p class="sales-history-customer-assignment"><strong>${label}</strong> ${detail}${empty}</p>`;
  }
  function renderSummary(result) {
    const c = result.coverage;
    return `<section class="sales-history-summary"><h3>${result.totals ? 'Geprüfte importierte Positionen' : 'Datenabdeckung und offene Prüfungen'}</h3>
      ${renderCustomerAssignment(result)}
      ${DataQuality.render(DataQuality.history(result))}<p>${escape(c.label)}</p>
      ${result.totals ? `<p class="sales-history-total">Brutto ${escape(number(result.totals.gross))} ${escape(result.totals.currency)} · Netto ${escape(number(result.totals.net))} ${escape(result.totals.currency)}</p>` : '<p class="sales-history-review">Keine freigegebene Umsatzsumme.</p>'}
      <p>Fehlende Tage sind unbekannt, nicht automatisch umsatzfrei. PDF-Berichte, Einzelverkäufe und Kassenbewegungen werden nicht addiert.</p>
      ${c.issues.length ? `<ul>${[...new Set(c.issues.map(issueText))].map(issue => `<li>${escape(issue)}</li>`).join('')}</ul>` : ''}
      <details><summary>Nach Tagen aufschlüsseln</summary><div class="sales-history-days"><table><thead><tr><th scope="col">Tag</th><th scope="col">Datensätze</th><th scope="col">Prüfung offen</th><th scope="col">Geprüft brutto</th></tr></thead><tbody>
      ${result.days.map(day => `<tr><td>${escape(day.date)}</td><td>${day.records}</td><td>${day.review}</td><td>${escape(number(day.gross))}</td></tr>`).join('')}</tbody></table></div></details></section>`;
  }
  function mount(root, { api, customerId = null, calendarFactory = globalThis.GrabenplanerDateRangeCalendar?.createDateRangeCalendar }) {
    const body = root.querySelector('[data-history-body]');
    let disposed = false, generation = 0, controller = null, loaded = false, context, lastResult = null, lastQuery = null, calendar = null;
    let from = '', to = '', paused = false, reading = false, analysisTicket = null, defaultSearchStarted = false, sort = { key: 'date', direction: -1 };
    const el = name => body.querySelector(`[data-h="${name}"]`);
    function cancel() { generation++; controller?.abort(); controller = null; }
    function clearResults() { cancel(); reading = false; lastResult = null; lastQuery = null; if (el('results')) el('results').innerHTML = ''; for (const key of ['next', 'analyze', 'pause']) if (el(key)) { el(key).hidden = true; el(key).disabled = false; } root.removeAttribute('aria-busy'); }
    function selectedSource() { return context.sources.find(s => s.id === el('source').value); }
    function updateSource() {
      const source = selectedSource(), finance = el('kind').value !== 'sales';
      el('location').innerHTML = option('', 'Freigegebene Filialen') + source.locations.map(l => option(l.id, l.label)).join('')
        + (context.projection.unassigned ? option('unassigned', 'Ohne bestätigte Filialzuordnung') : '');
      el('snapshot').innerHTML = option('', 'Quellstand auswählen') + source.snapshots.map(s => option(s.id, s.label)).join('');
      el('snapshot-field').hidden = !finance; el('snapshot').required = finance;
      el('seller-fields').hidden = !context.projection.sellers || finance;
      clearResults();
    }
    function renderResults() { if (lastResult) { el('results').innerHTML = renderSummary(lastResult) + renderTable(lastResult.items, lastResult.query.kind, sort); el('next').hidden = !lastResult.next;
      el('analyze').hidden = !lastResult.analysis?.cursor; } }
    const endpoint = action => customerId ? `/api/crm/customers/${encodeURIComponent(customerId)}/purchases/${action}` : `/api/sales-history/${action}`;
    function updatePeriod(start, end) {
      from = start; to = end;
      if (customerId) { el('from').value = from; el('to').value = to; }
      el('range').textContent = customerId ? 'Kalender' : `${from} – ${to}`;
    }
    async function analyze(ticket) {
      analysisTicket = ticket;
      paused = false; el('pause').hidden = false; el('pause').disabled = false; el('analyze').disabled = true; el('next').disabled = true;
      try {
        while (!paused && lastResult?.analysis?.cursor && !disposed && ticket === generation) {
          const query = { ...lastQuery }; delete query.cursor;
          const result = await api(endpoint('analyze'), { method: 'POST', body: JSON.stringify({ query, cursor: lastResult.analysis.cursor }), signal: controller.signal });
          if (disposed || ticket !== generation) return;
          lastResult = { ...lastResult, coverage: result.coverage, totals: result.totals, days: result.days, analysis: result.analysis,
            ...(Object.prototype.hasOwnProperty.call(result, 'customerAssignment') ? { customerAssignment: result.customerAssignment } : {}) };
          renderResults(); el('message').textContent = result.analysis.complete ? 'Der gewählte Zeitraum ist vollständig verarbeitet.' : `${result.analysis.processed} Datensätze verarbeitet …`;
        }
        if (paused && ticket === generation && lastResult?.analysis?.cursor) el('message').textContent = 'Auswertung pausiert. Du kannst sie fortsetzen; eine Gesamtsumme bleibt bis zum Abschluss ausgeblendet.';
      } finally { if (analysisTicket === ticket) analysisTicket = null; if (!disposed && ticket === generation) { el('pause').hidden = true; el('analyze').disabled = false; el('next').disabled = false; } }
    }
    async function search(next = false) {
      if (customerId && (reading || analysisTicket === generation) && !next) return;
      if (customerId && !next) {
        from = el('from').value; to = el('to').value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || to > context.today) {
          el('message').textContent = 'Bitte einen gültigen Zeitraum von Anfang bis Ende und bis heute wählen.'; return;
        }
      }
      cancel(); const ticket = generation; controller = new AbortController(); root.setAttribute('aria-busy', 'true');
      reading = true;
      const kind = el('kind').value;
      const query = next ? { ...lastQuery, cursor: lastResult.next } : { sourceId: el('source').value, kind, dateFrom: from, dateTo: to,
        locationId: el('location').value, sellerRole: el('seller-role').value,
        sellerId: context.projection.sellers && kind === 'sales' ? el('seller').value.trim() : '',
        snapshot: kind === 'sales' ? '' : el('snapshot').value, limit: 50 };
      el('message').textContent = 'Freigegebene Daten werden geprüft …'; el('results').innerHTML = ''; el('next').hidden = true;
      try {
        const url = endpoint('search');
        const result = await api(url, { method: 'POST', body: JSON.stringify(query), signal: controller.signal });
        if (disposed || ticket !== generation) return;
        lastQuery = query; lastResult = result; renderResults(); el('message').textContent = `${result.query.dateFrom} bis ${result.query.dateTo} · ${kind === 'sales' ? 'Einzelverkäufe' : 'Getrennte Kassenhistorie'}`;
        if (result.analysis?.cursor) await analyze(ticket);
      } catch (error) {
        if (disposed || ticket !== generation) return;
        clearResults(); el('message').textContent = error.message || 'Daten konnten nicht gelesen werden. Bitte die Suche erneut starten.';
      } finally { if (!disposed && ticket === generation) { reading = false; root.removeAttribute('aria-busy'); } }
    }
    async function load() {
      if (loaded || disposed) return; loaded = true; const ticket = ++generation; controller = new AbortController();
      body.textContent = 'Datenquelle wird geprüft …';
      try {
        const response = await api('/api/sales-history/context', { signal: controller.signal });
        if (disposed || ticket !== generation) return;
        context = response;
        if (!context.available) { body.textContent = context.message || 'Die geprüfte Datenquelle ist noch nicht freigegeben.'; return; }
        ({ from, to } = defaultPeriod(context.today, customerId));
        body.innerHTML = `<p>${customerId ? 'Nur ausdrücklich zugeordnete Kundenkäufe in deinen freigegebenen Filialen. Die letzten 365 Kalendertage werden beim Öffnen geladen.' : 'Einzelverkäufe sind unabhängig von den bisherigen PDF-Statistikberichten. Suche wird erst nach Bestätigung ausgeführt.'}</p>
          <form data-h="form" class="sales-history-filters"><label>Quelle<select data-h="source">${context.sources.map(s => option(s.id, s.label)).join('')}</select></label>
          <label>Datenart<select data-h="kind">${option('sales', 'Einzelverkäufe')}${!customerId && context.projection.finance ? option('daily', 'Tagesberichte') + option('journal', 'Kassenjournal') : ''}</select></label>
          ${customerId ? `<div class="sales-history-period"><label>Von<input type="date" data-h="from" value="${from}" max="${context.today}" required /></label><label>Bis<input type="date" data-h="to" value="${to}" max="${context.today}" required /></label><button type="button" class="date-range-trigger" data-h="range" aria-haspopup="dialog" aria-label="Zeitraum im Kalender wählen">Kalender</button><small>Standard: letzte 365 Kalendertage einschließlich heute</small></div>` : `<label>Zeitraum<button type="button" class="date-range-trigger" data-h="range" aria-haspopup="dialog">${from} – ${to}</button><small>Standard: Jahr bis Berichtsende</small></label>`}
          <label>Filiale<select data-h="location"></select></label><label data-h="snapshot-field" hidden>Quellstand<select data-h="snapshot"></select></label>
          <div data-h="seller-fields" class="sales-history-seller-fields" hidden><label>GP-Personalnummer<input data-h="seller" maxlength="120" placeholder="leer: alle; unassigned: offen" autocomplete="off" /></label>
          <label>Verkäuferrolle<select data-h="seller-role">${option('line_seller', 'Positionsverkäufer')}${option('header_seller', 'Belegverkäufer')}</select></label></div>
          <button type="submit" class="primary-button">Auswerten</button></form><p data-h="message" role="status" aria-live="polite">${customerId ? 'Kundenkäufe werden geladen …' : 'Zeitraum auswählen oder Jahr bis Berichtsende auswerten.'}</p>
          <div data-h="results"></div><div class="sales-history-actions"><button data-h="analyze" type="button" class="secondary-button" hidden>Zeitraumsauswertung fortsetzen</button><button data-h="pause" type="button" class="secondary-button" hidden>Nach diesem Schritt pausieren</button><button data-h="next" type="button" class="secondary-button" hidden>Nächste Seite</button></div>
          <dialog class="modal date-range-dialog" data-h="dialog" aria-label="Zeitraum auswählen"><form data-h="range-form"><div class="modal-header"><h2>Zeitraum auswählen</h2><button type="button" data-h="close" class="close-button" aria-label="Kalender schließen">×</button></div>
          ${customerId ? `<label class="sales-history-month-jump">Zu Monat / Jahr springen<input data-h="month-jump" type="month" max="${context.today.slice(0, 7)}" /></label>` : ''}
          <div class="date-range-selection" aria-live="polite"><div><span>Beginn</span><strong data-h="start"></strong></div><div><span>Ende</span><strong data-h="end"></strong></div></div>
          <div class="date-range-toolbar"><button data-h="previous" type="button" aria-label="Voriger Monat">‹</button><strong data-h="month"></strong><button data-h="following" type="button" aria-label="Nächster Monat">›</button></div>
          <div class="date-range-weekdays" aria-hidden="true"><span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span></div>
          <div class="date-range-grid" data-h="grid" role="grid" aria-label="Zeitraumkalender"></div><input type="checkbox" data-h="open-end" hidden />
          <div class="modal-actions"><button type="button" data-h="cancel" class="secondary-button">Abbrechen</button><button type="submit" data-h="apply" class="primary-button">Übernehmen</button></div></form></dialog>`;
        calendar = calendarFactory?.({ dialog: el('dialog'), form: el('range-form'), grid: el('grid'), title: el('month'), monthInput: customerId ? el('month-jump') : null, startText: el('start'), endText: el('end'),
          previousButton: el('previous'), nextButton: el('following'), openEndCheckbox: el('open-end'), applyButton: el('apply'), closeButtons: [el('close'), el('cancel')] });
        if (!calendar) { body.textContent = 'Der Zeitraumkalender ist nicht verfügbar. Bitte die Seite neu laden.'; return; }
        el('range').addEventListener('click', () => calendar.open({ start: from, end: to, max: context.today, ...(customerId ? {} : { maxEndDays: 365 }), allowOpenEnd: false,
          onCommit: (start, end) => { updatePeriod(start, end); clearResults(); } }));
        el('form').addEventListener('submit', event => { event.preventDefault(); void search(); });
        el('source').addEventListener('change', updateSource); el('kind').addEventListener('change', updateSource);
        el('form').addEventListener('input', () => { if (customerId) { from = el('from').value; to = el('to').value; } clearResults(); });
        el('next').addEventListener('click', () => void search(true)); updateSource();
        el('pause').addEventListener('click', () => { paused = true; el('pause').disabled = true; });
        el('analyze').addEventListener('click', async () => {
          if (analysisTicket === generation || !lastResult?.analysis?.cursor) return;
          cancel(); controller = new AbortController(); const ticket = generation; el('pause').disabled = false;
          try { await analyze(ticket); } catch (error) { if (!disposed && ticket === generation) { clearResults(); el('message').textContent = error.message || 'Bitte die Auswertung neu starten.'; } }
        });
        if (customerId && !defaultSearchStarted) { defaultSearchStarted = true; void search(); }
      } catch (error) { if (!disposed && ticket === generation) { body.textContent = error.message || 'Datenquelle nicht verfügbar.'; loaded = false; } }
    }
    function suspend() { el('dialog')?.close(); clearResults(); loaded = false; context = calendar = null; body.replaceChildren(); }
    function pauseCustomerReads() {
      el('dialog')?.close();
      // An analysis request advances its server cursor even when HTTP is
      // aborted. Accept that bounded step before pausing further requests.
      if (analysisTicket === generation) { paused = true; el('pause').disabled = true; return; }
      cancel(); loaded = Boolean(context); paused = true;
      for (const key of ['next', 'analyze', 'pause']) if (el(key)) el(key).disabled = false;
      if (el('pause')) el('pause').hidden = true;
      if (el('message') && (reading || lastResult?.analysis?.cursor)) el('message').textContent = lastResult?.analysis?.cursor
        ? 'Auswertung pausiert. Du kannst die Zeitraumsauswertung fortsetzen.' : 'Abruf unterbrochen. Bitte Auswerten wählen, um erneut zu laden.';
      reading = false; root.removeAttribute('aria-busy');
    }
    function onToggle() { if (root.open) void load(); else if (customerId) pauseCustomerReads(); else suspend(); }
    function onVisibility() { if (globalThis.document?.hidden) { if (customerId) pauseCustomerReads(); else suspend(); } else if (root.open) void load(); }
    function onClick(event) {
      const button = event.target.closest('[data-history-sort]'); if (!button || !root.contains(button) || !lastResult) return;
      const key = button.dataset.historySort; if (!['date', 'receipt', 'description'].includes(key)) return;
      sort = { key, direction: sort.key === key ? -sort.direction : 1 }; renderResults();
      body.querySelector(`[data-history-sort="${key}"]`)?.focus();
    }
    root.addEventListener('toggle', onToggle); root.addEventListener('click', onClick); if (root.open) void load();
    globalThis.document?.addEventListener('visibilitychange', onVisibility);
    return { destroy() { disposed = true; cancel(); el('dialog')?.close(); root.removeEventListener('toggle', onToggle); root.removeEventListener('click', onClick);
      globalThis.document?.removeEventListener('visibilitychange', onVisibility);
      body.replaceChildren(); root.removeAttribute('aria-busy'); lastQuery = lastResult = context = calendar = null; } };
  }
  return { mount, renderTable, renderSummary, issueText, refLabel, defaultPeriod };
}));
