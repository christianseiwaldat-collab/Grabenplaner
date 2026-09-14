"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const UI = require("../public/portal-branch-sales"), Lines = require("../public/receipt-line-format");
const { branchSalesContext, branchSalesIdentity, branchReceiptProjection, BRANCH_ARTICLES_PERMISSION: A, BRANCH_RECEIPTS_PERMISSION: R } = require("../lib/branch-sales-access");
const user = () => ({ sessionKind: "organization", id: "session-a", isEmployee: false, accountId: "account-a", accountType: "branch", permissions: [A, R], scopes: [{ locationId: "00", departmentId: null }] });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const article = name => ({ articleNumber: "00042", description: name, active: true, primaryIdentifier: "4006381333931", retailGross: "249.9", internetGross: "239" });
const result = name => ({ items: [article(name)], total: 1, offset: 0 });

function harness(kind) {
  const elements = new Map(), requests = [], downloads = [], listeners = new Map();
  let html = "", current = user();
  const node = name => {
    if (!elements.has(name)) {
      const handlers = new Map();
      elements.set(name, { name, value: name === "status" ? "active" : "", textContent: "", innerHTML: "", disabled: false, open: false,
        classList: { toggle() {} }, addEventListener: (type, fn) => handlers.set(type, fn),
        fire(type, event = { preventDefault() {} }) { handlers.get(type)?.(event); },
        replaceChildren() { this.innerHTML = this.textContent = ""; },
        showModal() { this.open = true; }, close() { if (this.open) { this.open = false; handlers.get("close")?.(); } }, reset() {} });
    }
    return elements.get(name);
  };
  const root = {
    get firstChild() { return html ? {} : null; }, set innerHTML(value) { html = value; }, get innerHTML() { return html; },
    querySelector(selector) { return node(selector.match(/data-b="([^"]+)"/)[1]); }, querySelectorAll() { return []; },
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type),
    replaceChildren() { html = ""; elements.clear(); }, contains: () => true,
  };
  const workspace = UI.mount(root, { kind, api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    getUser: () => current, lineFormat: Lines, download: (...args) => downloads.push(args) });
  const click = data => { const button = { dataset: data }; listeners.get("click")?.({ target: { closest: () => button } }); };
  const load = async (extra = {}) => {
    const promise = workspace.load();
    if (kind === "receipts") requests[0].resolve({ available: true, today: "2026-09-13", location: { id: "00", name: "Demo" }, sourceLabel: "Demo", coverageLabel: "13.09.2026", ...extra });
    await promise;
  };
  return { workspace, requests, downloads, node, root, click, load, fireRoot(type, target) { return listeners.get(type)?.({ target }); }, setUser(value) { current = value; } };
}

test("Die zwei Berechtigungen sind unabhängig, auf Filialkonten begrenzt und erhalten führende Nullen", () => {
  const actor = user(); assert.equal(branchSalesContext(actor, R).locationId, "00");
  assert.deepEqual(branchReceiptProjection(actor).locationIds, ["00"]); assert.equal(branchReceiptProjection(actor).company, false);
  actor.permissions = [A]; assert.equal(UI.allowed("branchArticles", actor), true); assert.equal(UI.allowed("branchReceipts", actor), false);
  assert.throws(() => branchSalesContext(actor, R), e => e.status === 403);
  for (const changed of [{ accountType: "terminal" }, { isEmployee: true }, { scopes: [] }, { scopes: [{ locationId: "00", departmentId: 2 }] }, { scopes: [{ locationId: "00" }, { locationId: "70" }] }]) {
    assert.equal(UI.allowed("branchArticles", { ...actor, ...changed }), false);
    assert.throws(() => branchSalesContext({ ...actor, ...changed }, A), e => e.status === 403);
  }
  assert.notEqual(branchSalesIdentity(actor, A), branchSalesIdentity({ ...actor, id: "new-session" }, A));
});
test("Suchtreffer und Belegtexte werden maskiert, null-Preise bleiben erkennbar", () => {
  assert.doesNotMatch(UI.articleRows([article('<img src=x onerror="alert(1)">')]), /<img/);
  assert.match(UI.articleBody({ ...article("Kamera"), retailGross: null, internetGross: "0" }), /Nicht hinterlegt/);
  assert.match(UI.articleBody({ ...article("Kamera"), internetGross: "0" }), /0,00/);
  assert.doesNotMatch(UI.receiptRows([{ id: '"><img>', receipt: "<script>", location: "<img>", description: "<img>" }]), /<img|<script>/);
  const detail = UI.receiptDetail({ lines: [{ description: "<img>", quantity: "2", sourcePrice: "249.9", status: "review" }] }, Lines);
  assert.doesNotMatch(detail, /<img/); assert.match(detail, /499,80/);
});
test('Artikel werden einmal beim Aufklappen geladen; verspätete Details nach neuer Suche verworfen', async () => {
  const f = harness('articles'); await f.load();
  const body = { textContent: '', innerHTML: '' }, card = { open: true, dataset: { article: '00042' }, matches: () => true, querySelector: () => body };
  const pending = f.fireRoot('toggle', card); await f.fireRoot('toggle', card);
  assert.equal(f.requests.length, 1); assert.match(f.requests[0].url, /detail\?articleNumber=00042$/);
  f.node('form').fire('input'); f.requests[0].resolve(article('Private alte Details')); await pending;
  assert.equal(body.innerHTML, '');
  const next = f.fireRoot('toggle', card); f.requests[1].resolve({ ...article('Kamera'), calculation: { available: true, purchaseNet: '100', vatPercent: 20 } }); await next;
  assert.match(body.innerHTML, /VK brutto kalkulieren/); await f.fireRoot('toggle', card); assert.equal(f.requests.length, 2);
});
test('Ein Kontowechsel verhindert verspätete Artikeldetails und Berechnungsgrundlagen', async () => {
  const f = harness('articles'); await f.load(); const body = { textContent: '', innerHTML: '' };
  const pending = f.fireRoot('toggle', { open: true, dataset: { article: '00042' }, matches: () => true, querySelector: () => body });
  f.setUser({ ...user(), accountId: 'other' }); f.requests[0].resolve({ ...article('Privat'), calculation: { purchaseNet: '100' } }); await pending;
  assert.equal(body.innerHTML, '');
});
test("Eine alte Artikelsuche kann neue Suchangaben und Treffer nicht überschreiben", async () => {
  const f = harness("articles"); await f.load();
  f.node("query").value = "Alt"; f.node("form").fire("submit");
  f.node("query").value = "Neu"; f.node("form").fire("input"); f.node("form").fire("submit");
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(result("NEUER-TREFFER")); await settle();
  f.requests[0].resolve(result("ALTER-TREFFER")); await settle();
  assert.match(f.node("results").innerHTML, /NEUER-TREFFER/); assert.doesNotMatch(f.node("results").innerHTML, /ALTER-TREFFER/);
});
test("Nach Logout füllt eine verspätete Suche keine verborgenen Ergebnisse auf", async () => {
  const f = harness("articles"); await f.load(); f.node("form").fire("submit"); f.workspace.destroy();
  f.requests[0].resolve(result("PRIVATE-RESULT")); await settle(); assert.equal(f.root.innerHTML, "");
});
test("Ein verspäteter PDF-Download bleibt nach Kontowechsel aus", async () => {
  const f = harness("receipts"); await f.load(); f.click({ pdf: "receipt-a" });
  assert.equal(f.requests[1].options.responseType, "blob");
  f.setUser({ ...user(), accountId: "account-b" }); f.requests[1].resolve(new Blob(["%PDF-"])); await settle();
  assert.equal(f.downloads.length, 0);
});
test("Doppelter PDF-Klick sendet einmal; der Download verwendet nur die gewählte ID", async () => {
  const f = harness("receipts"); await f.load(); f.click({ pdf: "receipt-a" }); f.click({ pdf: "receipt-a" });
  assert.equal(f.requests.length, 2); assert.deepEqual(JSON.parse(f.requests[1].options.body), { ids: ["receipt-a"] });
  const blob = new Blob(["%PDF-"]); f.requests[1].resolve(blob); await settle(); assert.deepEqual(f.downloads, [[blob, "Beleginformation-keine-Rechnung.pdf"]]);
});
test("Belegdetails eines zuvor geschlossenen Dialogs erscheinen nicht im neuen Dialog", async () => {
  const f = harness("receipts"); await f.load(); f.click({ detail: "receipt-a" }); f.node("close").fire("click");
  f.click({ detail: "receipt-b" });
  f.requests[1].resolve({ items: [{ receipt: "ALTER-BELEG", lines: [] }] }); await settle();
  assert.doesNotMatch(f.node("detail-title").textContent, /ALTER/);
  f.requests[2].resolve({ items: [{ receipt: "NEUER-BELEG", lines: [] }] }); await settle();
  assert.match(f.node("detail-title").textContent, /NEUER-BELEG/);
});
test("Artikelsuche und Belegsuche behalten getrennte Filter und Ergebnisse", async () => {
  const a = harness("articles"), b = harness("receipts"); await a.load(); await b.load();
  a.node("query").value = "Aurora"; a.node("form").fire("submit"); b.node("receipt").value = "10001"; b.node("form").fire("submit");
  a.requests[0].resolve(result("Artikel-Aurora")); b.requests[1].resolve({ items: [], processed: 8, next: null }); await settle();
  b.node("form").fire("input"); assert.match(a.node("results").innerHTML, /Artikel-Aurora/);
  assert.equal(a.node("query").value, "Aurora");
});
test("Eine ergebnislose Belegseite wird fortgesetzt, kann aber vom Nutzer pausiert werden", async () => {
  const f = harness("receipts"); await f.load(); f.node("form").fire("submit");
  f.requests[1].resolve({ items: [], processed: 100, next: "cursor-1" }); await settle();
  assert.equal(JSON.parse(f.requests[2].options.body).cursor, "cursor-1");
  f.node("pause").fire("click"); f.requests[2].resolve({ items: [], processed: 100, next: "cursor-2" }); await settle();
  assert.equal(f.requests.length, 3); assert.equal(f.node("next").disabled, false); assert.match(f.node("message").textContent, /fortgesetzt/);
});
test("Eingaben während des Ladens verhindern die Initialisierung der Belegsuche nicht", async () => {
  const f = harness("receipts"), promise = f.workspace.load();
  f.node("query").value = "Kamera"; f.node("form").fire("input");
  f.requests[0].resolve({ available: true, today: "2026-09-13", location: { id: "00", name: "Demo" } }); await promise;
  assert.equal(f.node("search").disabled, false); assert.equal(f.node("query").value, "Kamera");
});
test('Belegfilter haben ein Kundenfeld, kombinierbare Filialgruppen und erhalten den eigenen Standard', async () => {
  const f = harness('receipts'), Filters = require('../public/branch-receipt-filters');
  await f.load({ location: { id: '18', name: 'Demo 18' }, defaultLocationIds: ['18'],
    locations: [...Filters.STOCK, ...Filters.INTERNET, '94'].map(id => ({ id, label: id })) });
  assert.equal((f.root.innerHTML.match(/data-b="customer"/g) || []).length, 1);
  f.node('customer').value = 'Mia 6020'; f.node('sellers').value = '12, 34'; f.node('form').fire('submit');
  let sent = JSON.parse(f.requests[1].options.body);
  assert.deepEqual(sent.locations, ['18']); assert.equal(sent.customer, 'Mia 6020'); assert.equal(sent.sellers, '12, 34');
  f.requests[1].resolve({ items: [], processed: 0, next: 'old-cursor' });
  // A new location selection invalidates this response and its continuation.
  f.node('form').fire('input', { target: { dataset: { locationGroup: 'internet' }, checked: true } });
  await settle(); assert.equal(f.node('next').disabled, true);
  f.node('form').fire('input', { target: { dataset: { locationGroup: 'stock' }, checked: true } });
  f.node('form').fire('input', { target: { dataset: { location: '94' }, checked: true } });
  f.node('form').fire('input', { target: { dataset: { location: '03' }, checked: false } });
  f.node('form').fire('submit'); sent = JSON.parse(f.requests.at(-1).options.body);
  assert.deepEqual(sent.locations, [...Filters.STOCK, ...Filters.INTERNET.filter(id => id !== '03'), '94'].sort());
  assert.equal(sent.cursor, '');
  f.requests.at(-1).resolve({ items: [], processed: 0, next: null }); await settle();
  f.node('reset').fire('click'); f.node('form').fire('submit');
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body).locations, ['18']);
});
test('Leere Filialauswahl und unvollständige Personalnummern senden keine Suchanfrage', async () => {
  const f = harness('receipts'); await f.load();
  f.node('sellers').value = '12,'; f.node('form').fire('submit'); await settle();
  assert.equal(f.requests.length, 1); assert.match(f.node('message').textContent, /Personalnummern/);
  f.node('sellers').value = ''; f.node('form').fire('input', { target: { dataset: { location: '00' }, checked: false } });
  f.node('form').fire('submit'); await settle();
  assert.equal(f.requests.length, 1); assert.match(f.node('message').textContent, /mindestens eine Filiale/);
});
