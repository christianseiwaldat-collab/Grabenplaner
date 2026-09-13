(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GrabenplanerBranchSales = api;
}(typeof globalThis === "object" ? globalThis : this, function () {
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

  function articleRows(items) {
    return items.map(row => `<article class="branch-search-result"><div><strong>${esc(row.description)}</strong>
      <p>Artikelnr. <b>${esc(row.articleNumber)}</b> · ${row.active ? "Aktiv" : "Archiviert"}</p>
      <p>EAN / GTIN: ${esc(row.primaryIdentifier || "Nicht hinterlegt")}</p></div>
      <dl><div><dt>VK brutto</dt><dd>${esc(money(row.retailGross))}</dd></div><div><dt>Internet brutto</dt><dd>${esc(money(row.internetGross))}</dd></div></dl></article>`).join("");
  }
  function receiptRows(items) {
    return items.map(row => `<article class="branch-search-result"><div><strong>Beleg ${esc(row.receipt || "ohne Nummer")}</strong>
      <p>${esc(date(row.date))} · ${esc(row.location)}${row.register ? " · Kasse " + esc(row.register) : ""}</p>
      <p>${esc(row.description || "Keine Bezeichnung")} · ${esc(count(row.positions, "Position", "Positionen"))}</p>
      ${row.invoice ? `<p>Rechnungsreferenz: ${esc(row.invoice)}</p>` : ""}</div>
      <div class="branch-search-actions"><button class="text-button" type="button" data-detail="${esc(row.id)}">Beleg ansehen</button>
      <button class="text-button" type="button" data-pdf="${esc(row.id)}">PDF herunterladen</button></div></article>`).join("");
  }
  function receiptDetail(item, lines) {
    if (!item) return "<p>Der Beleg ist nicht mehr verfügbar.</p>";
    return `<p>${esc(date(item.date))} · ${esc(item.location)} · ${esc(count(item.positions, "Position", "Positionen"))}</p>
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
    }
    function formMarkup() {
      root.innerHTML = `<form data-b="form" class="branch-search-form">
        <label class="branch-search-wide"><span>${kind === "articles" ? "Artikelnummer, Bezeichnung oder EAN" : "Artikelnummer oder Bezeichnung im Beleg"}</span>
          <input type="search" data-b="query" maxlength="160" autocomplete="off" placeholder="${kind === "articles" ? "z. B. Kamera oder 00042" : "z. B. Objektiv"}"></label>
        ${kind === "articles" ? '<label><span>Status</span><select data-b="status"><option value="active">Aktiv</option><option value="all">Alle</option><option value="inactive">Archiviert</option></select></label>'
          : '<label class="branch-search-receipt"><span>Belegnummer / Rechnungsreferenz</span><input type="search" data-b="receipt" maxlength="80" autocomplete="off"></label><label><span>Von</span><input type="date" data-b="from" required min="1900-01-01"></label><label><span>Bis</span><input type="date" data-b="to" required min="1900-01-01"></label>'}
        <div class="branch-search-actions"><button class="primary" data-b="search" type="submit">Suchen</button><button class="text-button" data-b="reset" type="button">Zurücksetzen</button></div></form>
        <p class="branch-search-source" data-b="source"></p><p class="message" data-b="message" role="status" aria-live="polite">Suche wird vorbereitet …</p>
        <div data-b="results" class="branch-search-results"></div><nav class="branch-search-actions" aria-label="Suchergebnisse">
        <button class="text-button" data-b="previous" type="button" ${kind === "receipts" ? "hidden" : ""}>Zurück</button>
        <button class="text-button" data-b="next" type="button">${kind === "articles" ? "Weiter" : "Suche fortsetzen"}</button>
        <button class="text-button" data-b="pause" type="button" hidden>Suche pausieren</button></nav>
        ${kind === "receipts" ? '<dialog class="branch-receipt-dialog" data-b="dialog" aria-labelledby="branchReceiptDetailTitle"><div class="branch-search-dialog-heading"><h2 id="branchReceiptDetailTitle" data-b="detail-title">Beleg</h2><button class="text-button" data-b="close" type="button" aria-label="Beleg schließen">Schließen</button></div><p class="branch-search-source">Informationsauszug aus dem Kassenstand. Kein Ersatz für den Originalbeleg.</p><div data-b="detail-body"></div><button class="primary" data-b="detail-pdf" type="button">PDF herunterladen</button></dialog>' : ""}`;
      el("form").addEventListener("submit", event => { event.preventDefault(); void search(0); });
      el("form").addEventListener("input", () => { invalidate(); message("Suchangaben geändert. Suche starten."); });
      el("reset").addEventListener("click", () => { invalidate(); el("form").reset(); dates(); message("Suchangaben zurückgesetzt."); });
      el("previous").addEventListener("click", () => void search(Math.max(0, offset - 20)));
      el("next").addEventListener("click", () => void search(kind === "articles" ? offset + 20 : next));
      el("pause").addEventListener("click", () => { paused = true; message("Suche pausiert nach diesem Abschnitt …"); });
      el("close")?.addEventListener("click", closeDetail);
      el("dialog")?.addEventListener("close", () => { detailId = null; detailGeneration++; el("detail-body").replaceChildren(); });
      el("detail-pdf")?.addEventListener("click", () => { if (detailId) void pdf(detailId); });
      root.addEventListener("click", click);
      actions();
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
            today = value.today || ""; dates();
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
      busy = true; paused = false; downloading = false; closeDetail(); el("results").replaceChildren(); message("Suche läuft …"); actions();
      try {
        if (kind === "articles") {
          const query = new URLSearchParams({ query: el("query").value, status: el("status").value, offset: String(page) });
          const result = await api("/api/portal/v1/branch-articles?" + query);
          if (!valid(ticket)) return;
          offset = result.offset; total = result.total; el("results").innerHTML = articleRows(result.items);
          message(total ? (total === 1 ? "1 Artikel gefunden." : `${offset + 1}–${offset + result.items.length} von ${total} Artikeln`) : "Keine passenden Artikel gefunden.");
        } else {
          let cursor = page || "", processed = 0, items = [];
          const query = { query: el("query").value, receipt: el("receipt").value, dateFrom: el("from").value, dateTo: el("to").value };
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
    function click(event) {
      const button = event.target.closest("button"); if (!button || !root.contains(button)) return;
      if (button.dataset.detail) void detail(button.dataset.detail);
      if (button.dataset.pdf) void pdf(button.dataset.pdf);
    }
    return { load, suspend() { paused = true; closeDetail(); }, destroy() {
      disposed = true; generation++; closeDetail(); root.removeEventListener("click", click); root.replaceChildren(); context = null;
    } };
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return { allowed, owner, mount, articleRows, receiptRows, receiptDetail };
}));
