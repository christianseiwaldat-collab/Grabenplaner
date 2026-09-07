(function attach(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrabenplanerReceiptSearch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function receiptSearchModule() {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = value => value == null ? '–' : String(value).replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1').replace('.', ',');
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('.') : value || '–';
  const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;
  const value = (row, key) => key === 'gross' ? row.gross ?? row.sourceAmount : row[key];
  const customerColumns = ['customerNumber', 'customerAccount', 'customerSourceAccount', 'customerName', 'customerAddress', 'customerPhone', 'customerEmail'];
  function sortedRows(items, sort) {
    return [...items].sort((a, b) => {
      const left = value(a, sort.key), right = value(b, sort.key);
      if (left == null || right == null) return left == null ? right == null ? 0 : 1 : -1;
      if (['gross', 'inflow', 'outflow', 'positions'].includes(sort.key)) return (Number(left) - Number(right)) * sort.direction;
      return String(left).localeCompare(String(right), 'de-AT', { numeric: true }) * sort.direction;
    });
  }
  function cell(row, key) {
    if (key === 'date') return date(row.date);
    if (['gross', 'inflow', 'outflow'].includes(key)) return number(value(row, key));
    return value(row, key) ?? '–';
  }
  function renderTable(items, columns, labels, selected, sort) {
    const rows = sortedRows(items, sort);
    return `<div class="receipt-table-scroll" role="region" tabindex="0" aria-label="Belegsuchergebnisse"><table><caption>${items.length} angezeigte Treffer · Spaltenüberschrift zum Sortieren aller Treffer wählen</caption>
      <thead><tr><th scope="col"><input type="checkbox" data-r-all aria-label="Geladene Treffer auswählen (höchstens 50)" ${items.length && items.every(r => selected.has(r.id)) ? 'checked' : ''}></th>
      ${columns.map(k => `<th scope="col" aria-sort="${sort.key === k ? sort.direction === 1 ? 'ascending' : 'descending' : 'none'}"><button type="button" data-r-sort="${k}">${escape(labels[k])}${sort.key === k ? sort.direction === 1 ? ' ↑' : ' ↓' : ''}</button></th>`).join('')}<th scope="col">Beleginfo</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td><input type="checkbox" data-r-select="${escape(row.id)}" aria-label="${escape('Beleg ' + row.receipt + ' vom ' + date(row.date) + ' auswählen')}" ${selected.has(row.id) ? 'checked' : ''}></td>
      ${columns.map(k => `<td class="${['gross', 'inflow', 'outflow', 'positions'].includes(k) ? 'receipt-number' : ''}">${escape(cell(row, k))}</td>`).join('')}
      <td><button type="button" data-r-detail="${escape(row.id)}">Öffnen</button> <button type="button" data-r-pdf="${escape(row.id)}">PDF</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderDetail(row) {
    return `<p class="receipt-info-note"><strong>Beleginformation – keine Rechnung</strong><br>Informationsauszug aus dem importierten Kassenstand. Kein Ersatz für den Originalbeleg.</p>
      <dl class="receipt-meta"><dt>Beleg / Tag</dt><dd>${escape(row.receipt)} · ${escape(date(row.date))}</dd><dt>Filiale / Kasse</dt><dd>${escape(row.location)} · ${escape(row.register || '–')}</dd>
      ${Object.hasOwn(row, 'personnel') ? `<dt>Personalnummer (Beleg)</dt><dd>${escape(row.personnel || 'Zuordnung offen')}</dd>` : ''}
      ${Object.hasOwn(row, 'customerNumber') ? `<dt>Kunden-Kontonummer</dt><dd>${escape(row.customerAccount || 'Kein Kundenkonto am Beleg')}</dd>
      ${row.customerNumber ? `<dt>Kundennummer</dt><dd>${escape(row.customerNumber)}</dd>` : ''}${row.customerName ? `<dt>Kunde</dt><dd>${escape(row.customerName)}</dd>` : ''}
      ${row.customerAddress ? `<dt>Adresse</dt><dd>${escape(row.customerAddress)}</dd>` : ''}${row.customerPhone ? `<dt>Telefon</dt><dd>${escape(row.customerPhone)}</dd>` : ''}${row.customerEmail ? `<dt>E-Mail</dt><dd>${escape(row.customerEmail)}</dd>` : ''}
      <dt>Kundenzuordnung</dt><dd>${escape(row.customerStatus)}</dd>` : ''}
      ${row.customerSourceAccount ? `<dt>TradeFoto-KontoNr</dt><dd>${escape(row.customerSourceAccount)}</dd>` : ''}
      ${row.invoice ? `<dt>Rechnungsreferenz</dt><dd>${escape(row.invoice)}</dd>` : ''}<dt>Datenstand</dt><dd>${escape(row.provenance.sourceLabel)}</dd><dt>Importiert</dt><dd>${escape(date(row.provenance.importedAt?.slice(0, 10)))}</dd></dl>
      ${row.kind === 'receipts' ? `<p>${row.positions} vollständige Belegpositionen · ${escape(row.state)}</p><div class="receipt-table-scroll"><table><thead><tr><th>Artikel</th><th>Bezeichnung</th><th>Menge</th>${Object.hasOwn(row, 'personnel') ? '<th>Personalnummer (Position)</th>' : ''}<th>Quellpreis</th><th>Brutto</th><th>Status</th></tr></thead><tbody>
      ${row.lines.map(l => `<tr><td>${escape(l.article)}</td><td>${escape(l.description)}</td><td>${escape(number(l.quantity))}</td>${Object.hasOwn(row, 'personnel') ? `<td>${escape(l.personnel || '–')}</td>` : ''}<td>${escape(number(l.sourcePrice))}</td><td>${l.gross == null ? 'Prüfung offen' : escape(number(l.gross))}</td><td>${escape({ sale: 'Verkauf', return: 'Rückgabe', excluded: 'Ausgeschlossen', review: 'Prüfung offen' }[l.status])}</td></tr>`).join('')}</tbody></table></div><p><strong>${row.gross == null ? 'Quellbetrag' : 'Geprüfter Betrag'}: ${escape(number(row.gross ?? row.sourceAmount))} ${escape(row.gross == null ? '' : row.currency)}</strong></p>`
        : `<p>${escape(row.description)} · Konto ${escape(row.account)}</p><p>Einzahlung ${escape(number(row.inflow))} · Auszahlung ${escape(number(row.outflow))}</p><p>Separate Kassenbuchung; kein zusätzlicher Verkauf.</p>`}`;
  }
  function mount(root, { api, rawApi, calendarFactory = globalThis.GrabenplanerDateRangeCalendar?.createDateRangeCalendar } = {}) {
    let disposed = false, generation = 0, controller = null, context = null, loading = null, calendar = null;
    let from, to, query = null, next = null, resultSet = null, total = null, scanned = 0, items = [], selected = new Set(), columns = [], allColumns = [], sort = { key: 'date', direction: -1 };
    let running = false, paused = false, exporting = false, detailId = null, displayKind = null;
    const el = key => root.querySelector(`[data-r="${key}"]`);
    const message = text => { if (!disposed && el('message')) el('message').textContent = text; };
    function cancel() { generation++; controller?.abort(); controller = null; running = false; }
    function clear() {
      cancel(); items = []; selected.clear(); query = next = resultSet = total = null; scanned = 0; detailId = null;
      el('detail-dialog')?.close(); if (el('detail-body')) el('detail-body').replaceChildren(); render();
    }
    function actions() {
      if (!context || disposed) return;
      el('export').disabled = exporting || !selected.size;
      el('export').textContent = exporting ? 'PDF wird erstellt …' : `Auswahl als PDF (${selected.size})`;
      el('more').hidden = !next || running; el('more').disabled = false;
      el('pause').hidden = !running; el('search').disabled = running;
      el('count').textContent = `${items.length}${total == null ? '' : ' von ' + total} Treffer geladen · ${selected.size} ausgewählt`;
      const all = root.querySelector('[data-r-all]');
      if (all) { all.checked = items.length > 0 && sortedRows(items, sort).slice(0, 50).every(row => selected.has(row.id)); all.indeterminate = selected.size > 0 && !all.checked; }
    }
    function render() {
      if (!context || disposed) return;
      el('results').innerHTML = items.length ? renderTable(items, columns, context.columns, selected, sort) : '';
      actions();
    }
    function renderColumns() {
      const ordered = [...columns, ...allColumns.filter(k => !columns.includes(k))];
      el('columns').innerHTML = ordered.map(k => `<div class="receipt-column"><label><input type="checkbox" data-r-column="${k}" ${columns.includes(k) ? 'checked' : ''}>${escape(context.columns[k])}</label><span>
        <button type="button" data-r-move="${k}" data-direction="-1" aria-label="${escape(context.columns[k])} nach links" ${columns.indexOf(k) <= 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-r-move="${k}" data-direction="1" aria-label="${escape(context.columns[k])} nach rechts" ${!columns.includes(k) || columns.indexOf(k) === columns.length - 1 ? 'disabled' : ''}>↓</button></span></div>`).join('');
    }
    function filters() {
      const finance = el('kind').value !== 'receipts';
      if (displayKind !== el('kind').value) {
        context.preferencesByKind ||= { receipts: context.preferences };
        if (displayKind) context.preferencesByKind[displayKind] = { columns: [...columns] };
        displayKind = el('kind').value;
        el('columns-status').textContent = '';
        allColumns = Object.keys(context.columns).filter(k => finance ? !['personnel', 'positions', 'gross', 'state', ...customerColumns].includes(k) : !['account', 'inflow', 'outflow'].includes(k) && (k !== 'personnel' || context.projection.sellers) && (!customerColumns.includes(k) || context.projection.customerPurchases));
        if (!allColumns.includes(sort.key)) sort = { key: 'date', direction: -1 };
        columns = (context.preferencesByKind[displayKind]?.columns || ['date', 'receipt', 'location', 'description', 'account', 'inflow', 'outflow']).filter(k => allColumns.includes(k));
        if (!columns.length) columns = ['date', 'receipt'];
        renderColumns(); render();
      }
      el('seller-fields').hidden = finance || !context.projection.sellers;
      el('customer-fields').hidden = finance || !context.projection.customerPurchases;
      if (finance) el('seller').value = '';
      if (finance) el('customer').value = '';
      el('scope-note').textContent = finance ? 'Kassenbuchungen sind keine zusätzlichen Verkäufe.' : 'Personalnummer bezeichnet den Belegverkäufer. Positionsverkäufer stehen in der Beleginfo.';
    }
    async function search(more = false, resort = false) {
      if (disposed || !context || running) return;
      if (!more) {
        const reusable = resort ? resultSet : null, previousSelection = resort ? new Set(selected) : new Set();
        clear(); resultSet = reusable; selected = previousSelection;
        query = { sourceId: el('source').value, kind: el('kind').value, dateFrom: from, dateTo: to, locationId: el('location').value,
          query: el('query').value, receipt: el('receipt').value, seller: el('kind').value === 'receipts' && context.projection.sellers ? el('seller').value : '', sellerRole: el('seller-role').value,
          customer: el('kind').value === 'receipts' && context.projection.customerPurchases ? el('customer').value : '', sort: sort.key, direction: sort.direction === 1 ? 'asc' : 'desc', limit: 50 };
      } else cancel();
      const ticket = generation, target = items.length + 50;
      controller = new AbortController(); running = true; paused = false; actions();
      try {
        do {
          const result = await api('/api/receipt-search/search', { method: 'POST', body: JSON.stringify({ ...query, limit: Math.min(50, target - items.length), cursor: next || '', resultSet: resultSet || '' }), signal: controller.signal });
          if (disposed || ticket !== generation) return;
          const known = new Set(items.map(r => r.id)); items.push(...result.items.filter(r => !known.has(r.id))); next = result.next; scanned += result.processed;
          resultSet = result.resultSet || resultSet; total = result.total ?? total;
          render(); message(result.sorting ? `${result.matched} Treffer gefunden · ${scanned} Belege/Buchungen durchsucht. Sortierung aller Treffer wird vorbereitet …`
            : `${items.length}${total == null ? '' : ' von ' + total} Treffer · ${scanned} Belege/Buchungen durchsucht${next ? ' …' : ' · Suche abgeschlossen.'}`);
        } while (next && items.length < target && !paused);
        if (!next && !items.length) message('Keine passenden Belege oder Buchungen im gewählten Zeitraum. Suchtext verkürzen oder Zeitraum erweitern.');
        else if (paused) message(`${items.length} Treffer · Suche pausiert. Mit „Weitere Treffer suchen“ fortsetzen.`);
        else if (next) message(`${items.length}${total == null ? '' : ' von ' + total} Treffer geladen. Weitere Treffer lassen sich nachladen.`);
      } catch (error) {
        if (!disposed && ticket === generation) { items = []; selected.clear(); next = resultSet = total = null; render(); message(error.message || 'Suche fehlgeschlagen. Bitte erneut suchen.'); }
      } finally { if (!disposed && ticket === generation) { running = false; actions(); if (resort) root.querySelector(`[data-r-sort="${sort.key}"]`)?.focus(); } }
    }
    async function exportPdf(ids) {
      if (exporting || !ids.length || disposed) return;
      const ticket = generation; exporting = true; actions();
      try {
        const response = await rawApi('/api/receipt-search/export.pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'PDF konnte nicht erstellt werden.'); }
        const blob = await response.blob(); if (disposed || ticket !== generation) return;
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'Beleginformation-keine-Rechnung.pdf';
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
        message(`Beleginformation für ${ids.length} ausgewählte Belege/Buchungen erstellt.`);
      } catch (error) { if (!disposed && ticket === generation) message(error.message); }
      finally { exporting = false; if (!disposed) actions(); }
    }
    async function detail(id) {
      const ticket = generation; detailId = id; el('detail-body').textContent = 'Vollständiger Beleg wird geladen …'; el('detail-pdf').disabled = true; el('detail-dialog').showModal();
      try {
        const result = await api('/api/receipt-search/documents', { method: 'POST', body: JSON.stringify({ ids: [id] }) });
        if (disposed || ticket !== generation || detailId !== id) return;
        el('detail-body').innerHTML = renderDetail(result.items[0]); el('detail-pdf').disabled = false;
      } catch (error) { if (!disposed && ticket === generation && detailId === id) el('detail-body').textContent = error.message; }
    }
    async function load() {
      if (context || disposed) return; if (loading) return loading;
      const ticket = generation; root.textContent = 'Kassenstand wird geladen …';
      loading = (async () => {
        try {
          const result = await api('/api/receipt-search/context');
          if (disposed || ticket !== generation) return;
          if (!result.available) { root.textContent = 'Es ist noch kein geprüfter Kassenstand aktiviert.'; return; }
          context = result; to = context.today; const d = new Date(to); d.setUTCDate(d.getUTCDate() - 30); from = d.toISOString().slice(0, 10);
          allColumns = Object.keys(context.columns).filter(k => (k !== 'personnel' || context.projection.sellers) && (!['account', 'inflow', 'outflow'].includes(k) || context.projection.finance));
          columns = context.preferences.columns.filter(k => allColumns.includes(k)); if (!columns.length) columns = ['date', 'receipt'];
          root.innerHTML = `<form data-r="form" class="receipt-filters"><label class="receipt-query">Suchbegriff<input data-r="query" type="search" maxlength="160" placeholder="z. B. Sony A7* 24-105mm" aria-describedby="receiptSearchHelp"></label>
            <label>Beleg-/Rechnungsnummer<input data-r="receipt" type="search" maxlength="80" placeholder="Nummer oder Teil mit *"></label>
            <label data-r="customer-fields" class="receipt-query">Kunde<input data-r="customer" type="search" maxlength="160" placeholder="Kundennummer, Name, Adresse, Telefon oder E-Mail" autocomplete="off"></label>
            <label>Datenart<select data-r="kind">${option('receipts', 'Belege')}${context.projection.finance ? option('daily', 'Tagesberichte · Buchungen') + option('journal', 'Kassenjournal · Buchungen') : ''}</select></label>
            <label>Zeitraum<button type="button" data-r="range" class="date-range-trigger" aria-haspopup="dialog">${date(from)} – ${date(to)}</button></label>
            <label>Filiale<select data-r="location"></select></label><label>Datenstand<select data-r="source">${context.sources.map(s => option(s.id, s.label)).join('')}</select></label>
            <div data-r="seller-fields" class="receipt-seller"><label>Personalnummer<input data-r="seller" type="search" maxlength="80" placeholder="z. B. 426"></label><label>Verkäuferrolle<select data-r="seller-role">${option('header_seller', 'Belegverkäufer')}${option('line_seller', 'Positionsverkäufer')}</select></label></div>
            <div class="receipt-actions"><button type="submit" data-r="search" class="primary-button">Suchen</button><button type="button" data-r="reset" class="secondary-button">Zurücksetzen</button><button type="button" data-r="pause" class="secondary-button" hidden>Pausieren</button></div></form>
            <p id="receiptSearchHelp" class="settings-note">Alle eingegebenen Begriffe werden gesucht, unabhängig von ihrer Reihenfolge. * steht für beliebig viele Zeichen, ? für ein Zeichen. Großschreibung, Trennzeichen und zusätzliche Leerzeichen stören nicht.</p>
            ${context.projection.customerPurchases ? '<p class="settings-note">Kunden-Kontonummern kommen aus dem Beleg. Namen, Adressen und Kontaktdaten werden über die zugehörige Kundenkartei gesucht.</p>' : ''}
            <p data-r="scope-note" class="settings-note"></p><p data-r="message" role="status" aria-live="polite">Suche mit dem letzten Monat vorbelegt. Der Zeitraum lässt sich frei erweitern.</p>
            <div class="receipt-toolbar"><strong data-r="count"></strong><button type="button" data-r="export" class="secondary-button" disabled>Auswahl als PDF (0)</button><button type="button" data-r="unselect" class="secondary-button">Auswahl aufheben</button></div>
            <details class="receipt-columns"><summary>Spalten &amp; Reihenfolge</summary><p>Spalten einblenden und mit den Pfeilen ordnen. Die Auswahl gilt für dein Konto.</p><div data-r="columns" class="receipt-column-list"></div><button type="button" data-r="save-columns" class="secondary-button">Spalten speichern</button><span data-r="columns-status" role="status"></span></details>
            <div data-r="results"></div><button type="button" data-r="more" class="secondary-button" hidden>Weitere Treffer suchen</button>
            <dialog data-r="detail-dialog" class="modal receipt-detail" aria-label="Beleginformation"><div class="modal-header"><h2>Beleginfo</h2><button type="button" data-r="detail-close" aria-label="Beleginfo schließen">×</button></div><div data-r="detail-body"></div><div class="modal-actions"><button type="button" data-r="detail-pdf" class="primary-button">Diesen Beleg als PDF</button></div></dialog>
            <dialog data-r="dialog" class="modal date-range-dialog" aria-label="Suchzeitraum"><form data-r="range-form"><div class="modal-header"><h2>Zeitraum auswählen</h2><button type="button" data-r="range-close" aria-label="Kalender schließen">×</button></div>
              <label class="receipt-month-jump">Zu Monat / Jahr springen<input data-r="month-jump" type="month" min="1900-01" max="${context.today.slice(0, 7)}"></label>
              <div class="date-range-selection"><div><span>Beginn</span><strong data-r="start"></strong></div><div><span>Ende</span><strong data-r="end"></strong></div></div>
              <div class="date-range-toolbar"><button type="button" data-r="previous" aria-label="Voriger Monat">‹</button><strong data-r="month"></strong><button type="button" data-r="following" aria-label="Nächster Monat">›</button></div>
              <div class="date-range-weekdays" aria-hidden="true"><span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span></div><div class="date-range-grid" data-r="grid" role="grid" aria-label="Zeitraumkalender"></div><input type="checkbox" data-r="open-end" hidden>
              <div class="modal-actions"><button type="button" data-r="range-cancel" class="secondary-button">Abbrechen</button><button type="submit" data-r="apply" class="primary-button">Übernehmen</button></div></form></dialog>`;
          function source() { const s = context.sources.find(s => s.id === el('source').value); el('location').innerHTML = option('', 'Alle freigegebenen Filialen') + s.locations.map(l => option(l.id, l.label)).join('') + (context.projection.unassigned ? option('unassigned', 'Filialzuordnung offen') : ''); clear(); }
          calendar = calendarFactory?.({ dialog: el('dialog'), form: el('range-form'), grid: el('grid'), title: el('month'), monthInput: el('month-jump'), startText: el('start'), endText: el('end'), previousButton: el('previous'), nextButton: el('following'), openEndCheckbox: el('open-end'), applyButton: el('apply'), closeButtons: [el('range-close'), el('range-cancel')] });
          if (!calendar) throw new Error('Der Zeitraumkalender ist nicht verfügbar. Bitte neu laden.');
          el('range').addEventListener('click', () => calendar.open({ start: from, end: to, min: '1900-01-01', max: context.today, allowOpenEnd: false,
            onCommit: (start, end) => { from = start; to = end; el('range').textContent = `${date(from)} – ${date(to)}`; clear(); } }));
          el('form').addEventListener('submit', e => { e.preventDefault(); void search(); });
          el('form').addEventListener('input', () => { clear(); filters(); message('Suchfilter geändert. Suche erneut starten.'); });
          el('source').addEventListener('change', source); el('kind').addEventListener('change', filters);
          el('more').addEventListener('click', () => void search(true)); el('pause').addEventListener('click', () => { paused = true; message('Suche pausiert nach diesem Schritt …'); });
          el('reset').addEventListener('click', () => { el('form').reset(); to = context.today; const d = new Date(to); d.setUTCDate(d.getUTCDate() - 30); from = d.toISOString().slice(0, 10); el('range').textContent = `${date(from)} – ${date(to)}`; source(); filters(); message('Suchfilter zurückgesetzt.'); });
          el('export').addEventListener('click', () => void exportPdf([...selected])); el('unselect').addEventListener('click', () => { selected.clear(); render(); });
          el('detail-close').addEventListener('click', () => { detailId = null; el('detail-dialog').close(); });
          el('detail-dialog').addEventListener('close', () => { detailId = null; el('detail-body').replaceChildren(); });
          el('detail-pdf').addEventListener('click', () => { if (detailId) void exportPdf([detailId]); });
          el('save-columns').addEventListener('click', async () => {
            const button = el('save-columns'), body = JSON.stringify({ columns: [...columns], kind: displayKind }); button.disabled = true;
            const unchanged = () => !disposed && body === JSON.stringify({ columns: [...columns], kind: displayKind });
            try { await api('/api/receipt-search/preferences', { method: 'PUT', body }); if (unchanged()) el('columns-status').textContent = 'Gespeichert.'; }
            catch (error) { if (unchanged()) el('columns-status').textContent = error.message; } finally { if (!disposed) button.disabled = false; }
          });
          source(); filters(); renderColumns(); render();
        } catch (error) { if (!disposed) { context = null; root.textContent = error.message || 'Kassenstand nicht verfügbar.'; } }
        finally { loading = null; }
      })();
      return loading;
    }
    function click(event) {
      const button = event.target.closest('button'); if (!button || !root.contains(button)) return;
      if (button.dataset.rSort) { if (running) return; const key = button.dataset.rSort; sort = { key, direction: sort.key === key ? -sort.direction : 1 }; void search(false, true); }
      if (button.dataset.rDetail) void detail(button.dataset.rDetail);
      if (button.dataset.rPdf) void exportPdf([button.dataset.rPdf]);
      if (button.dataset.rMove) { const key = button.dataset.rMove, direction = button.dataset.direction, i = columns.indexOf(key), j = i + Number(direction); if (i >= 0 && j >= 0 && j < columns.length) { [columns[i], columns[j]] = [columns[j], columns[i]]; el('columns-status').textContent = 'Noch nicht gespeichert.'; renderColumns(); render(); root.querySelector(`[data-r-move="${key}"][data-direction="${direction}"]:not(:disabled)`)?.focus(); } }
    }
    function change(event) {
      const target = event.target;
      if (target.dataset.rSelect) { if (target.checked && selected.size >= 50) { target.checked = false; message('Bitte höchstens 50 Belege/Buchungen je PDF auswählen.'); return; }
        if (target.checked) selected.add(target.dataset.rSelect); else selected.delete(target.dataset.rSelect); actions(); }
      if (target.hasAttribute('data-r-all')) { selected = target.checked ? new Set(sortedRows(items, sort).slice(0, 50).map(r => r.id)) : new Set(); render(); if (items.length > 50) message('Die ersten 50 Treffer der aktuellen Sortierung sind ausgewählt.'); }
      if (target.dataset.rColumn) { const k = target.dataset.rColumn; if (target.checked) columns.push(k); else if (columns.length > 1) columns = columns.filter(c => c !== k); else target.checked = true; el('columns-status').textContent = 'Noch nicht gespeichert.'; renderColumns(); render(); root.querySelector(`[data-r-column="${k}"]`)?.focus(); }
    }
    root.addEventListener('click', click); root.addEventListener('change', change);
    return { load, suspend() { paused = true; el('dialog')?.close(); el('detail-dialog')?.close(); }, destroy() { disposed = true; cancel(); el('dialog')?.close(); el('detail-dialog')?.close(); root.removeEventListener('click', click); root.removeEventListener('change', change); root.replaceChildren(); selected.clear(); items = []; context = null; } };
  }
  return { mount, renderTable, renderDetail };
}));
