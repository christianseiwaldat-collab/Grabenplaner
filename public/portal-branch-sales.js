(function (root, factory) {
  const common = typeof module === 'object' && module.exports;
  const api = factory(common ? require('./branch-article-calculation') : root.GrabenplanerArticleCalculation,
    common ? require('./branch-receipt-filters') : root.GrabenplanerReceiptFilters);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GrabenplanerBranchSales = api;
}(typeof globalThis === "object" ? globalThis : this, function (Calc, Filters) {
  "use strict";
  const permissions = { branchArticles: "branch_articles:read", branchReceipts: "branch_receipts:read" };
  const allowed = (tab, user) => user?.isEmployee === false && user.accountType === "branch"
    && user.permissions?.includes(permissions[tab]) === true
    && user.scopes?.length === 1 && !!user.scopes[0].locationId && !user.scopes[0].departmentId;
  const owner = user => JSON.stringify([user?.accountId, user?.accountType, user?.isEmployee, user?.permissions, user?.scopes]);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const money = value => value === null || value === undefined || value === "" ? "Nicht hinterlegt"
    : Number.isFinite(Number(value)) ? new Intl.NumberFormat("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value)) : "–";
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.slice(8) + "." + value.slice(5, 7) + "." + value.slice(0, 4) : "–";
  const count = (value, singular, plural) => `${value} ${Number(value) === 1 ? singular : plural}`;

  const articleNumber = value => /^\d{1,6}$/.test(String(value)) ? String(value).padStart(6, '0') : String(value || '');
  const sign = value => value != null && Number(value) > 0 ? 'branch-positive' : value != null && Number(value) < 0 ? 'branch-negative' : '';
  const euro = value => value == null ? 'Nicht hinterlegt' : money(value) + ' €';
  function marginText(value) {
    return value ? `RE <span class="${sign(value.percent)}">${value.percent == null ? '–' : esc(money(value.percent))} %</span> · <span class="${sign(value.amount)}">${esc(money(value.amount))} € netto</span>` : 'RE nicht verfügbar';
  }
  function articleRows(items) {
    return items.map(row => `<details class="branch-article" data-article="${esc(row.articleNumber)}"><summary>
      <strong>${esc(articleNumber(row.articleNumber))} ${esc(row.description)}</strong><span class="branch-article-chevron" aria-hidden="true">⌄</span></summary>
      <div data-article-body><p class="branch-article-note">Artikeldaten werden beim Öffnen geladen.</p></div></details>`).join('');
  }
  function articleBody(row) {
    const own = (row.stocks || []).filter(s => s.own), others = (row.stocks || []).filter(s => !s.own);
    const quantity = value => value == null ? 'Nicht hinterlegt' : new Intl.NumberFormat('de-AT', { maximumFractionDigits: 3 }).format(Number(value));
    const ownValue = own.length === 1 ? own[0].quantity : null;
    const stockRows = others.map(s => `<div><span>Filiale ${esc(s.id)}</span><b class="${sign(s.quantity)}">${esc(s.ambiguous ? 'Unklar' : quantity(s.quantity))}</b></div>`).join('');
    const links = (row.links || []).filter(l => { try { const url = new URL(l.href); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } });
    const image = typeof row.imageUrl === 'string' && row.imageUrl.startsWith('/api/portal/v1/branch-articles/image?articleNumber=') ? row.imageUrl : null;
    const price = (label, value) => `<div class="branch-article-price"><span>${label}</span><strong class="${sign(value)}">${esc(euro(value))}</strong><small>${marginText(Calc.margin(value, row.calculation))}</small></div>`;
    return `<div class="branch-article-layout"><div class="branch-article-info"><p class="branch-article-status">${esc(row.status || 'Status nicht hinterlegt')}</p>
      <p class="branch-article-ean">EAN / GTIN: ${esc(row.primaryIdentifier || 'Nicht hinterlegt')}</p>
      <div class="branch-article-stock"><button type="button" data-stock aria-expanded="false">Bestand · Filiale ${esc(row.ownLocationId)} <b class="${sign(ownValue)}">${esc(quantity(ownValue))}</b><span aria-hidden="true"> ⓘ</span></button>
        <div class="branch-article-stock-list"><strong>Andere Filialen</strong>${stockRows || '<p>Keine weiteren Bestände hinterlegt.</p>'}</div></div>
      <p class="branch-article-note">${row.stockAt ? 'Bestandsstand: ' + esc(date(row.stockAt.slice(0, 10))) : 'Kein freigegebener Bestandsstand vorhanden.'}</p>
      <div class="branch-article-media">${image ? `<img src="${esc(image)}" alt="${esc(row.description)}" width="88" height="76" loading="lazy" decoding="async">` : '<span class="branch-article-no-image">Kein Bild</span>'}
        <nav aria-label="Produktlinks">${links.map(l => `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join('') || '<span class="branch-article-note">Keine Produktlinks hinterlegt</span>'}</nav></div></div>
      <div class="branch-article-prices">${price('VK brutto', row.retailGross)}${price('Internet brutto', row.internetGross)}
        <div class="branch-article-calculator"><label><span>VK brutto kalkulieren (€)</span><input data-calc="gross" class="${sign(row.retailGross)}" type="text" inputmode="decimal" maxlength="22" autocomplete="off" value="${row.retailGross == null ? '' : esc(money(row.retailGross))}" ${row.calculation?.available ? '' : 'disabled'}></label>
          <output data-calc-result="gross" aria-live="polite">${marginText(Calc.margin(row.retailGross, row.calculation))}</output>
          <label><span>Ziel-RE (%)</span><input data-calc="percent" type="text" inputmode="decimal" maxlength="16" autocomplete="off" placeholder="z. B. 3" ${row.calculation?.available ? '' : 'disabled'}></label>
          <output data-calc-result="percent" aria-live="polite"><small>Gewünschten RE eingeben.</small></output>
          <p class="branch-article-note">${row.calculation?.available ? 'Basis: ' + esc(row.calculation.basis) + ' · ' + esc(money(row.calculation.vatPercent)) + ' % MwSt.' : 'Netto-Einkaufspreis oder MwSt. nicht verfügbar.'}</p>
        </div></div></div>`;
  }
  function receiptRows(items) {
    return items.map(row => `<article class="branch-search-result"><div><strong>Beleg ${esc(row.receipt || "ohne Nummer")}</strong>
      <p>${esc(date(row.date))} · ${esc(row.location)}${row.register ? " · Kasse " + esc(row.register) : ""}</p>
      <p>${esc(receiptCustomer(row))}${row.personnel ? ' · Belegverkäufer ' + esc(row.personnel) : ''}</p>
      <p>${esc(row.description || "Keine Bezeichnung")} · ${esc(count(row.positions, "Position", "Positionen"))}</p>
      ${row.invoice ? `<p>Rechnungsreferenz: ${esc(row.invoice)}</p>` : ""}</div>
      <div class="branch-search-actions"><button class="text-button" type="button" data-detail="${esc(row.id)}">Beleg ansehen</button>
      <button class="text-button" type="button" data-pdf="${esc(row.id)}">PDF herunterladen</button></div></article>`).join("");
  }
  function receiptCustomer(row) {
    return [row.customerName, row.customerNumber || row.customerAccount ? 'Kundennr. ' + (row.customerNumber || row.customerAccount) : ''].filter(Boolean).join(' · ') || 'Kein Kunde zugeordnet';
  }
  function receiptDetail(item, lines) {
    if (!item) return "<p>Der Beleg ist nicht mehr verfügbar.</p>";
    return `<p>${esc(date(item.date))} · ${esc(item.location)} · ${esc(count(item.positions, "Position", "Positionen"))}</p>
      <p>${esc(receiptCustomer(item))}${item.personnel ? ' · Belegverkäufer ' + esc(item.personnel) : ''}</p>
      ${[item.customerAddress, item.customerPhone, item.customerEmail].filter(Boolean).map(value => '<p>' + esc(value) + '</p>').join('')}
      ${item.invoice ? `<p>Rechnungsreferenz: ${esc(item.invoice)}</p>` : ""}
      <div class="branch-receipt-lines">${item.lines.map(row => `<article><div><strong>${esc(row.description)}</strong>
        <small>Artikelnr. ${esc(row.article || "–")}${lines?.note(row.status) ? " · " + esc(lines.note(row.status)) : ""}</small></div>
        <p>${esc(row.quantity)} × ${esc(money(row.sourcePrice))} = <b>${esc(lines?.money(lines.total(row.sourcePrice, row.quantity)) || "–")}</b></p></article>`).join("")}</div>`;
  }

  function mount(root, { kind, api, getUser, lineFormat, download = saveBlob }) {
    const tab = kind === "articles" ? "branchArticles" : "branchReceipts";
    const identity = owner(getUser());
    let disposed = false, generation = 0, busy = false, downloading = false, paused = false;
    let initialized = false, loading = null, available = false, offset = 0, total = 0, next = null, detailId = null;
    let detailGeneration = 0, today = "", context = null;
    let selectedLocations = new Set();
    const articles = new Map(), pendingArticles = new WeakSet();
    const valid = ticket => !disposed && ticket === generation && owner(getUser()) === identity && allowed(tab, getUser());
    const el = name => root.querySelector(`[data-b="${name}"]`);
    function message(text, error = false) { el("message").textContent = text; el("message").classList.toggle("error", error); }
    function actions() {
      el("search").disabled = busy || !available;
      el("previous").disabled = busy || !available || offset <= 0;
      el("next").disabled = busy || !available || (kind === "articles" ? offset + 20 >= total : !next);
      el("pause").hidden = kind === "articles" || !busy;
      root.querySelectorAll("[data-pdf], [data-b=detail-pdf]").forEach(button => { button.disabled = downloading || !available; });
    }
    function closeDetail() { detailId = null; detailGeneration++; el("dialog")?.close(); el("detail-body")?.replaceChildren(); }
    function invalidate() {
      generation++; busy = false; paused = true; downloading = false;
      offset = total = 0; next = null; closeDetail(); el("results").replaceChildren(); actions();
      articles.clear();
    }
    function formMarkup() {
      root.innerHTML = `<form data-b="form" class="branch-search-form">
        <label class="branch-search-wide"><span>${kind === "articles" ? "Artikelnummer, Bezeichnung oder EAN" : "Artikelnummer oder Bezeichnung im Beleg"}</span>
          <input type="search" data-b="query" maxlength="160" autocomplete="off" placeholder="${kind === "articles" ? "z. B. Kamera oder 000042" : "z. B. Objektiv"}"></label>
        ${kind === "articles" ? '<label><span>Status</span><select data-b="status"><option value="active">Aktiv</option><option value="all">Alle</option><option value="inactive">Archiviert</option></select></label>'
          : `<label class="branch-search-receipt"><span>Belegnummer / Rechnungsreferenz</span><input type="search" data-b="receipt" maxlength="80" autocomplete="off"></label>
            <label><span>Von</span><input type="date" data-b="from" required min="1900-01-01"></label><label><span>Bis</span><input type="date" data-b="to" required min="1900-01-01"></label>
            <label class="branch-search-wide branch-search-customer"><span>Kunde</span><input type="search" data-b="customer" maxlength="160" autocomplete="off" placeholder="z. B. Müller 6020"><small>Name, Straße, PLZ, Ort, Nummer, Telefon oder E-Mail.</small></label>
            <label class="branch-search-sellers"><span>Belegverkäufer · Personalnummern</span><input type="text" data-b="sellers" maxlength="440" autocomplete="off" placeholder="z. B. 12, 34, 56"><small>Mehrere Nummern durch Beistriche trennen.</small></label>
            <details class="branch-receipt-locations"><summary data-b="location-summary">Filialauswahl wird geladen …</summary><div data-b="locations"></div></details>`}
        <div class="branch-search-actions"><button class="primary" data-b="search" type="submit">Suchen</button><button class="text-button" data-b="reset" type="button">Zurücksetzen</button></div></form>
        <p class="branch-search-source" data-b="source"></p><p class="message" data-b="message" role="status" aria-live="polite">Suche wird vorbereitet …</p>
        <div data-b="results" class="branch-search-results"></div><nav class="branch-search-actions" aria-label="Suchergebnisse">
        <button class="text-button" data-b="previous" type="button" ${kind === "receipts" ? "hidden" : ""}>Zurück</button>
        <button class="text-button" data-b="next" type="button">${kind === "articles" ? "Weiter" : "Suche fortsetzen"}</button>
        <button class="text-button" data-b="pause" type="button" hidden>Suche pausieren</button></nav>
        ${kind === "receipts" ? '<dialog class="branch-receipt-dialog" data-b="dialog" aria-labelledby="branchReceiptDetailTitle"><div class="branch-search-dialog-heading"><h2 id="branchReceiptDetailTitle" data-b="detail-title">Beleg</h2><button class="text-button" data-b="close" type="button" aria-label="Beleg schließen">Schließen</button></div><p class="branch-search-source">Informationsauszug aus dem Kassenstand. Kein Ersatz für den Originalbeleg.</p><div data-b="detail-body"></div><button class="primary" data-b="detail-pdf" type="button">PDF herunterladen</button></dialog>' : ""}`;
      el("form").addEventListener("submit", event => { event.preventDefault(); void search(0); });
      el("form").addEventListener("input", event => { locationInput(event.target); invalidate(); message("Suchangaben geändert. Suche starten."); });
      el("reset").addEventListener("click", () => { invalidate(); el("form").reset(); dates(); resetLocations(); message("Suchangaben zurückgesetzt."); });
      el("previous").addEventListener("click", () => void search(Math.max(0, offset - 20)));
      el("next").addEventListener("click", () => void search(kind === "articles" ? offset + 20 : next));
      el("pause").addEventListener("click", () => { paused = true; message("Suche pausiert nach diesem Abschnitt …"); });
      el("close")?.addEventListener("click", closeDetail);
      el("dialog")?.addEventListener("close", () => { detailId = null; detailGeneration++; el("detail-body").replaceChildren(); });
      el("detail-pdf")?.addEventListener("click", () => { if (detailId) void pdf(detailId); });
      root.addEventListener("click", click);
      root.addEventListener('toggle', articleToggle, true);
      root.addEventListener('input', calculate);
      root.addEventListener('keydown', stockKey);
      root.addEventListener('mouseout', stockLeave);
      actions();
    }
    function choices() { return context?.locations || (context?.location ? [{ id: context.location.id, label: context.location.name }] : []); }
    function groups() { return context?.locationGroups || { stock: Filters.STOCK, internet: Filters.INTERNET }; }
    function resetLocations() {
      if (kind !== 'receipts') return;
      selectedLocations = new Set(context?.defaultLocationIds || (context?.location ? [context.location.id] : []));
      renderLocations();
    }
    function renderLocations() {
      if (kind !== 'receipts') return;
      const list = choices(), group = groups();
      const checkbox = row => `<label class="branch-location-option"><input type="checkbox" data-location="${esc(row.id)}" ${selectedLocations.has(row.id) ? 'checked' : ''}><span>${esc(row.label === row.id || row.label.startsWith(row.id + ' · ') ? row.label : row.id + ' · ' + row.label)}</span></label>`;
      const section = (name, title, ids) => `<fieldset><legend><label class="branch-location-option branch-location-group"><input type="checkbox" data-location-group="${name}"><span>${title}</span></label></legend><div class="branch-location-options">${list.filter(l => ids.includes(l.id)).map(checkbox).join('')}</div></fieldset>`;
      el('locations').innerHTML = `<button type="button" class="text-button" data-location-own>Eigene Filiale</button>`
        + section('stock', 'Alle Bestandsfilialen', group.stock) + section('internet', 'Internetverkäufe', group.internet)
        + (list.some(l => ![...group.stock, ...group.internet].includes(l.id)) ? '<fieldset><legend>Weitere Filialen</legend><div class="branch-location-options">' + list.filter(l => ![...group.stock, ...group.internet].includes(l.id)).map(checkbox).join('') + '</div></fieldset>' : '');
      syncLocations();
    }
    function syncLocations() {
      const ids = [...selectedLocations].sort();
      const own = context?.defaultLocationIds || [context?.location?.id];
      el('location-summary').textContent = ids.length ? 'Filialen: ' + (ids.length === own.length && own.every(id => selectedLocations.has(id)) ? 'Eigene Filiale · ' : '') + ids.join(', ') : 'Filialen: Bitte mindestens eine auswählen';
      root.querySelectorAll('[data-location]').forEach(input => { input.checked = selectedLocations.has(input.dataset.location); });
      root.querySelectorAll('[data-location-group]').forEach(input => {
        const ids = groups()[input.dataset.locationGroup].filter(id => choices().some(l => l.id === id));
        const checked = ids.filter(id => selectedLocations.has(id)).length;
        input.checked = ids.length > 0 && checked === ids.length; input.indeterminate = checked > 0 && checked < ids.length;
      });
    }
    function locationInput(input) {
      if (kind !== 'receipts') return;
      const group = input?.dataset?.locationGroup, id = input?.dataset?.location;
      const ids = group ? groups()[group].filter(id => choices().some(l => l.id === id)) : id ? [id] : [];
      for (const id of ids) { if (input.checked) selectedLocations.add(id); else selectedLocations.delete(id); }
      if (ids.length) syncLocations();
    }
    function dates() {
      if (kind !== "receipts" || !today) return;
      const start = new Date(today + "T12:00:00Z"); start.setUTCDate(start.getUTCDate() - 30);
      el("from").value = start.toISOString().slice(0, 10); el("to").value = today;
      el("from").max = el("to").max = today;
    }
    async function load() {
      if (disposed || initialized) return;
      if (loading) return loading;
      const live = () => valid(generation);
      if (!root.firstChild) formMarkup();
      loading = (async () => {
        try {
          if (kind === "receipts") {
            const value = await api("/api/portal/v1/branch-receipts/context");
            if (!live()) return;
            context = value; available = value.available === true;
            today = value.today || ""; dates(); resetLocations();
            el("source").textContent = available ? `${value.location.name} · ${value.sourceLabel} · ${value.coverageLabel}` : "";
          } else available = true;
          if (!live()) return;
          initialized = available;
          message(available ? "Suchangaben wählen und Suche starten." : "Ein freigegebener Kassenstand ist noch nicht verfügbar. Bereich erneut öffnen, um es nochmals zu versuchen.");
        } catch (error) { if (live()) message(error.message, true); }
        finally { loading = null; if (live()) actions(); }
      })();
      return loading;
    }
    async function search(page) {
      if (busy || !available || !valid(generation)) return;
      const ticket = ++generation;
      busy = true; paused = false; downloading = false; closeDetail(); articles.clear(); el("results").replaceChildren(); message("Suche läuft …"); actions();
      try {
        if (kind === "articles") {
          const query = new URLSearchParams({ query: el("query").value, status: el("status").value, offset: String(page) });
          const result = await api("/api/portal/v1/branch-articles?" + query);
          if (!valid(ticket)) return;
          offset = result.offset; total = result.total; el("results").innerHTML = articleRows(result.items);
          message(total ? (total === 1 ? "1 Artikel gefunden." : `${offset + 1}–${offset + result.items.length} von ${total} Artikeln`) : "Keine passenden Artikel gefunden.");
        } else {
          let cursor = page || "", processed = 0, items = [];
          if (!selectedLocations.size) throw new Error('Bitte mindestens eine Filiale auswählen.');
          try { Filters.sellers(el('sellers').value); } catch { throw new Error('Bitte bis zu 20 vollständige Personalnummern durch Beistriche getrennt eingeben.'); }
          const query = { query: el("query").value, receipt: el("receipt").value, dateFrom: el("from").value, dateTo: el("to").value,
            customer: el('customer').value, sellers: el('sellers').value, locations: [...selectedLocations].sort() };
          do {
            const result = await api("/api/portal/v1/branch-receipts/search", { method: "POST", body: JSON.stringify({ ...query, cursor }) });
            if (!valid(ticket)) return;
            items.push(...result.items); processed += result.processed; cursor = result.next; next = cursor;
            el("results").innerHTML = receiptRows(items);
            message(`${count(items.length, "Beleg", "Belege")} gefunden · ${count(processed, "Beleg", "Belege")} in diesem Suchabschnitt geprüft …`);
          } while (cursor && items.length < 20 && !paused);
          message(items.length ? `${count(items.length, "Beleg", "Belege")} gefunden.${next ? " Weitere Belege mit „Suche fortsetzen“." : " Zeitraum vollständig durchsucht."}`
            : next ? "Bisher keine Treffer. Die Suche kann fortgesetzt werden." : "Keine passenden Belege in diesem Zeitraum gefunden.");
        }
      } catch (error) {
        if (valid(ticket)) { next = null; total = 0; el("results").replaceChildren(); message(error.message, true); }
      } finally { if (valid(ticket)) { busy = false; actions(); } }
    }
    async function detail(id) {
      const ticket = generation, detailTicket = ++detailGeneration; detailId = id;
      el("detail-title").textContent = "Beleg wird geladen …"; el("detail-body").replaceChildren(); el("detail-pdf").disabled = true; el("dialog").showModal();
      try {
        const result = await api("/api/portal/v1/branch-receipts/documents", { method: "POST", body: JSON.stringify({ ids: [id] }) });
        if (!valid(ticket) || detailTicket !== detailGeneration || detailId !== id) return;
        el("detail-title").textContent = "Beleg " + result.items[0].receipt;
        el("detail-body").innerHTML = receiptDetail(result.items[0], lineFormat); el("detail-pdf").disabled = downloading;
      } catch (error) { if (valid(ticket) && detailTicket === detailGeneration) { detailId = null; el("detail-body").textContent = error.message; } }
    }
    async function pdf(id) {
      if (downloading || !valid(generation)) return;
      const ticket = generation; downloading = true; actions(); message("PDF wird erstellt …");
      try {
        const blob = await api("/api/portal/v1/branch-receipts/export.pdf", { method: "POST", body: JSON.stringify({ ids: [id] }), responseType: "blob" });
        if (!valid(ticket)) return;
        download(blob, "Beleginformation-keine-Rechnung.pdf"); message("PDF-Download gestartet.");
      } catch (error) { if (valid(ticket)) { message(error.message, true); if (el("dialog")?.open) el("detail-body").textContent = error.message; } }
      finally { if (valid(ticket)) { downloading = false; actions(); } }
    }
    async function articleToggle(event) {
      const card = event.target;
      if (!card.matches?.('.branch-article') || !card.open || !valid(generation) || !root.contains(card) || pendingArticles.has(card)) return;
      const number = card.dataset.article, ticket = generation, body = card.querySelector('[data-article-body]');
      if (articles.has(number)) return;
      pendingArticles.add(card); body.textContent = 'Artikeldaten werden geladen …';
      try {
        const row = await api('/api/portal/v1/branch-articles/detail?' + new URLSearchParams({ articleNumber: number }));
        if (!valid(ticket) || !root.contains(card)) return;
        articles.set(number, row); body.innerHTML = articleBody(row);
      } catch (error) { if (valid(ticket) && root.contains(card)) body.textContent = error.message + ' Zum Wiederholen schließen und erneut öffnen.'; }
      finally { pendingArticles.delete(card); }
    }
    function calculate(event) {
      const input = event.target;
      if (!input.dataset?.calc || !valid(generation)) return;
      const card = input.closest('.branch-article'), row = articles.get(card?.dataset.article);
      if (!row) return;
      const value = Calc.input(input.value), result = input.dataset.calc === 'gross' ? Calc.margin(value, row.calculation) : Calc.sellingPrice(value, row.calculation);
      input.classList.remove('branch-positive', 'branch-negative');
      const color = sign(value); if (color) input.classList.add(color);
      const output = card.querySelector(`[data-calc-result="${input.dataset.calc}"]`);
      if (input.dataset.calc === 'gross') output.innerHTML = result ? marginText(result) : 'Bitte einen gültigen Brutto-VK ab 0 € eingeben.';
      else output.innerHTML = result ? `<strong class="${sign(result.gross)}">${esc(euro(result.gross))} brutto</strong><small>${marginText(result)}</small>`
        : '<small>' + (value == null ? 'Gewünschten RE eingeben.' : Number(row.calculation.purchaseNet) === 0 ? 'Bei 0 € Einkauf ist kein eindeutiger Zielpreis berechenbar.' : 'Bitte einen Ziel-RE unter 100 % eingeben.') + '</small>';
    }
    function stockKey(event) {
      if (event.key !== 'Escape') return;
      const stock = event.target.closest?.('.branch-article-stock') || root.querySelector('.branch-article-stock:hover');
      if (!stock) return;
      stock.dataset.open = 'false'; stock.dataset.dismissed = 'true'; stock.querySelector('[data-stock]').setAttribute('aria-expanded', 'false');
    }
    function stockLeave(event) {
      const stock = event.target.closest?.('.branch-article-stock');
      if (stock && !stock.contains(event.relatedTarget)) delete stock.dataset.dismissed;
    }
    function click(event) {
      const button = event.target.closest("button"); if (!button || !root.contains(button)) return;
      if (button.hasAttribute?.('data-location-own')) { resetLocations(); invalidate(); message('Suche auf die eigene Filiale zurückgesetzt.'); }
      if (button.hasAttribute?.('data-stock')) {
        const stock = button.closest('.branch-article-stock'), open = stock.dataset.open !== 'true';
        stock.dataset.open = String(open); stock.dataset.dismissed = String(!open); button.setAttribute('aria-expanded', String(open));
      }
      if (button.dataset.detail) void detail(button.dataset.detail);
      if (button.dataset.pdf) void pdf(button.dataset.pdf);
    }
    return { load, suspend() { paused = true; closeDetail(); }, destroy() {
      disposed = true; generation++; closeDetail(); articles.clear(); root.removeEventListener("click", click);
      root.removeEventListener('toggle', articleToggle, true); root.removeEventListener('input', calculate); root.replaceChildren(); context = null;
      root.removeEventListener('keydown', stockKey); root.removeEventListener('mouseout', stockLeave);
    } };
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return { allowed, owner, mount, articleRows, articleBody, articleNumber, receiptRows, receiptDetail };
}));
