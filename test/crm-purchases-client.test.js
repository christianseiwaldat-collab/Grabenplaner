'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const UI = require('../public/sales-history');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t, customerId = 'customer-a') {
  const nodes = new Map(), requests = [], rootEvents = new Map(), documentEvents = new Map(), calendars = [];
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false, addEventListener: (name, handler) => documentEvents.set(name, handler), removeEventListener: name => documentEvents.delete(name) };
  t.after(() => { workspace.destroy(); if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  const node = name => {
    if (!nodes.has(name)) {
      const handlers = new Map();
      nodes.set(name, { value: ({ source: 'cash', kind: 'sales', 'seller-role': 'line_seller' })[name] || '', textContent: '', innerHTML: '', disabled: false, hidden: false,
        addEventListener: (event, handler) => handlers.set(event, handler), close() {},
        fire(event, value = { preventDefault() {} }) { handlers.get(event)?.(value); } });
    }
    return nodes.get(name);
  };
  let html = '';
  const body = { textContent: '', querySelector: selector => node(selector.match(/data-h="([^"]+)"/)[1]), replaceChildren() { html = ''; nodes.clear(); this.textContent = ''; },
    get innerHTML() { return html; }, set innerHTML(value) { html = value; for (const match of value.matchAll(/<input[^>]*data-h="([^"]+)"[^>]*value="([^"]*)"/g)) node(match[1]).value = match[2]; } };
  const root = { open: true, querySelector: () => body, contains: () => true, setAttribute() {}, removeAttribute() {},
    addEventListener: (name, handler) => rootEvents.set(name, handler), removeEventListener: name => rootEvents.delete(name) };
  const workspace = UI.mount(root, { customerId, api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    calendarFactory: options => { const item = { options, open(config) { item.config = config; } }; calendars.push(item); return item; } });
  return { root, body, node, requests, calendars, workspace,
    toggle(open) { root.open = open; rootEvents.get('toggle')?.(); }, visibility(hidden) { globalThis.document.hidden = hidden; documentEvents.get('visibilitychange')?.(); },
    async context() { requests[0].resolve({ available: true, today: '2026-10-04', projection: {}, sources: [{ id: 'cash', label: 'Synthetic', locations: [], snapshots: [] }] }); await settle(); } };
}
const result = (query, extra = {}) => ({ query, items: [], next: null, analysis: { cursor: null, complete: true }, totals: null,
  coverage: { label: 'Synthetic', complete: true, counts: { records: 0, checked: 0, review: 0 }, unresolved: {}, issues: [] }, days: [], ...extra });

test('Opening CRM loads one rolling 365-day search; toggles and visibility do not repeat completed reads', async t => {
  const f = fixture(t); f.toggle(true); assert.equal(f.requests.length, 1); await f.context();
  assert.equal(f.requests.length, 2); assert.match(f.requests[1].url, /customer-a\/purchases\/search$/);
  f.node('form').fire('submit'); assert.equal(f.requests.length, 2);
  const query = JSON.parse(f.requests[1].options.body); assert.equal(query.dateFrom, '2025-10-05'); assert.equal(query.dateTo, '2026-10-04');
  f.requests[1].resolve(result(query)); await settle();
  f.toggle(false); f.toggle(true); f.visibility(true); f.visibility(false); await settle(); assert.equal(f.requests.length, 2);
  assert.match(f.body.innerHTML, /type="date"/); assert.match(f.body.innerHTML, /Zu Monat \/ Jahr springen/);
  assert.equal(f.calendars[0].options.monthInput, f.node('month-jump'));
});

test('CRM direct dates and the shared calendar permit multi-year ranges without changing general history limits', async t => {
  const f = fixture(t); await f.context(); const first = JSON.parse(f.requests[1].options.body); f.requests[1].resolve(result(first)); await settle();
  f.node('from').value = '2010-01-01'; f.node('form').fire('input'); f.node('range').fire('click');
  assert.equal(f.calendars[0].config.start, '2010-01-01'); assert.equal(f.calendars[0].config.maxEndDays, undefined);
  f.calendars[0].config.onCommit('2011-02-03', '2026-10-04'); assert.equal(f.node('from').value, '2011-02-03');
  f.node('form').fire('submit'); assert.equal(JSON.parse(f.requests[2].options.body).dateFrom, '2011-02-03');
  f.requests[2].resolve(result(JSON.parse(f.requests[2].options.body))); await settle();
  f.node('to').value = '2010-01-01'; f.node('form').fire('submit'); assert.equal(f.requests.length, 3); assert.match(f.node('message').textContent, /gültigen Zeitraum/);
});

test('General history retains year-to-date and explicit search with a bounded calendar', async t => {
  const f = fixture(t, null); await f.context(); assert.equal(f.requests.length, 1); assert.doesNotMatch(f.body.innerHTML, /type="date"/);
  f.node('range').fire('click'); assert.equal(f.calendars[0].config.start, '2026-01-01'); assert.equal(f.calendars[0].config.maxEndDays, 365);
  f.node('form').fire('submit'); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].url, '/api/sales-history/search');
});

test('An aborted CRM read and destroyed customer workspace cannot restore late results or start reload loops', async t => {
  const f = fixture(t); await f.context(); const pending = f.requests[1], query = JSON.parse(pending.options.body);
  f.visibility(true); assert.equal(pending.options.signal.aborted, true); f.visibility(false); await settle(); assert.equal(f.requests.length, 2);
  pending.resolve(result(query, { items: [{ description: 'LATE-PRIVATE', location: {}, articleReference: {}, issues: [], provenance: {} }] })); await settle();
  assert.doesNotMatch(f.node('results').innerHTML, /LATE-PRIVATE/);
  f.node('form').fire('submit'); const retry = f.requests[2]; f.workspace.destroy(); assert.equal(retry.options.signal.aborted, true);
  retry.resolve(result(query)); await settle(); assert.equal(f.body.innerHTML, '');
});

test('Collapsing or hiding CRM completes the in-flight analysis step and resumes from its new cursor without a reload', async t => {
  const f = fixture(t); await f.context(); const query = JSON.parse(f.requests[1].options.body);
  f.requests[1].resolve(result(query, { analysis: { cursor: 'revision-1', complete: false } })); await settle();
  assert.equal(f.requests.length, 3); assert.equal(JSON.parse(f.requests[2].options.body).cursor, 'revision-1');
  f.toggle(false); f.visibility(true); assert.equal(f.requests[2].options.signal.aborted, false);
  f.requests[2].resolve(result(query, { analysis: { cursor: 'revision-2', complete: false } })); await settle();
  assert.equal(f.requests.length, 3); assert.match(f.node('message').textContent, /Auswertung pausiert/);
  f.toggle(true); f.visibility(false); await settle(); assert.equal(f.requests.length, 3);
  f.node('analyze').fire('click'); assert.equal(f.requests.length, 4); assert.equal(JSON.parse(f.requests[3].options.body).cursor, 'revision-2');
  f.node('analyze').fire('click'); f.node('form').fire('submit'); assert.equal(f.requests.length, 4);
  f.requests[3].resolve(result(query)); await settle(); assert.equal(f.node('analyze').hidden, true);
  f.visibility(true); f.visibility(false); await settle(); assert.equal(f.requests.length, 4);
});
