'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const UI = require('../public/sales-history');

const result = (extra = {}) => ({
  query: { kind: 'sales', dateFrom: '2025-10-06', dateTo: '2026-10-05' }, items: [], next: null,
  analysis: { cursor: null, complete: true }, totals: null,
  coverage: { label: 'Synthetic cash data', complete: true, counts: { records: 0, checked: 0, review: 0 }, unresolved: {}, issues: [] },
  days: [], ...extra
});
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test('A missing customer link is distinct from a completed search with no assigned purchases', () => {
  const open = UI.renderSummary(result({ customerAssignment: { status: 'unlinked', method: null } }));
  assert.match(open, /Kundenzuordnung offen/);
  assert.match(open, /noch nicht vollständig zugeordnet/);
  assert.match(open, /Eine leere Liste bestätigt nicht, dass keine Käufe vorliegen/);
  assert.doesNotMatch(open, /Kundenzuordnung bestätigt|keine zugeordneten Käufe .* gefunden/);

  const linked = UI.renderSummary(result({ customerAssignment: { status: 'linked', method: 'master' } }));
  assert.match(linked, /Kundenzuordnung bestätigt/);
  assert.match(linked, /importierten Kundenstamm verbunden/);
  assert.match(linked, /In den freigegebenen Filialen und im gewählten Zeitraum wurden keine zugeordneten Käufe im ausgewählten Datenstand gefunden/);
  assert.match(linked, /Vollständigkeit der Quelldaten ist damit nicht bestätigt/);
  assert.doesNotMatch(linked, /Kundenzuordnung offen|keine Käufe vorliegen/);
});

test('Confirmed cash mappings and historical mappings retain their precise meaning', () => {
  const nonempty = result({ customerAssignment: { status: 'linked', method: 'publication' } });
  nonempty.coverage = { ...nonempty.coverage, counts: { records: 1, checked: 1, review: 0 } };
  const cash = UI.renderSummary(nonempty);
  assert.match(cash, /Kassenbelegen des ausgewählten Datenstands verbunden/);
  assert.doesNotMatch(cash, /keine zugeordneten Käufe/);
  const historical = UI.renderSummary(result({ customerAssignment: { status: 'historical_mapping', method: 'publication' } }));
  assert.match(historical, /Historische Kundenzuordnung bestätigt/);
});

test('Unassigned and unusable customer targets never imply no purchases', () => {
  for (const status of ['unassigned', 'target_missing', 'target_inactive']) {
    const html = UI.renderSummary(result({ customerAssignment: { status, method: null } }));
    assert.match(html, /Eine leere Liste bestätigt nicht, dass keine Käufe vorliegen/);
    assert.match(html, status === 'unassigned' ? /Kundenzuordnung offen/ : /Kundenzuordnung derzeit nicht nutzbar/);
    assert.doesNotMatch(html, /Kundenzuordnung bestätigt|keine zugeordneten Käufe .* gefunden/);
  }
});

test('An incomplete analysis does not report a confirmed empty period before processing finishes', () => {
  const incomplete = result({ customerAssignment: { status: 'linked', method: 'master' } });
  incomplete.coverage = { ...incomplete.coverage, complete: false };
  const html = UI.renderSummary(incomplete);
  assert.match(html, /Kundenzuordnung bestätigt/);
  assert.match(html, /Zeitraumsauswertung noch nicht vollständig/);
  assert.doesNotMatch(html, /keine zugeordneten Käufe .* gefunden/);
});

test('Assignment notices never reflect unexpected fields, source IDs or executable markup', () => {
  const injection = '<img src=x onerror=alert(1)>';
  for (const assignment of [
    { status: injection, method: injection, sourceId: 'PRIVATE-SOURCE', name: 'PRIVATE-CUSTOMER' },
    { status: 'linked', method: injection, sourceId: 'PRIVATE-SOURCE', name: 'PRIVATE-CUSTOMER' }
  ]) {
    const response = result({ customerAssignment: assignment }); response.coverage.label = injection;
    const html = UI.renderSummary(response);
    assert.doesNotMatch(html, /<img|onerror="|PRIVATE-SOURCE|PRIVATE-CUSTOMER/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
});

test('Older responses and general sales summaries remain usable without a customer assignment notice', () => {
  const html = UI.renderSummary(result());
  assert.doesNotMatch(html, /sales-history-customer-assignment|Kundenzuordnung/);
  assert.match(html, /Datenabdeckung und offene Prüfungen/);
});

function mountFixture(t) {
  const nodes = new Map(), requests = [];
  const node = name => {
    if (!nodes.has(name)) {
      const handlers = new Map();
      nodes.set(name, { value: ({ source: 'cash', kind: 'sales', 'seller-role': 'line_seller' })[name] || '',
        innerHTML: '', textContent: '', disabled: false, hidden: false,
        addEventListener: (event, handler) => handlers.set(event, handler), close() {},
        fire(event) { handlers.get(event)?.({ preventDefault() {} }); } });
    }
    return nodes.get(name);
  };
  let html = '';
  const body = { textContent: '', querySelector: selector => node(selector.match(/data-h="([^"]+)"/)[1]),
    replaceChildren() { html = ''; nodes.clear(); }, get innerHTML() { return html; },
    set innerHTML(value) { html = value; for (const match of value.matchAll(/<input[^>]*data-h="([^"]+)"[^>]*value="([^"]*)"/g)) node(match[1]).value = match[2]; } };
  const root = { open: true, querySelector: () => body, contains: () => true, setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
  const workspace = UI.mount(root, { customerId: 'synthetic-customer',
    api: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    calendarFactory: () => ({ open() {}, destroy() {} }) });
  t.after(() => workspace.destroy());
  return { node, requests, async ready() {
    requests[0].resolve({ available: true, today: '2026-10-05', projection: {}, sources: [{ id: 'cash', label: 'Synthetic cash data', locations: [], snapshots: [] }] });
    await settle();
  } };
}

test('Analysis continuation refreshes the customer assignment notice alongside its coverage', async t => {
  const fixture = mountFixture(t); await fixture.ready();
  fixture.requests[1].resolve(result({ analysis: { cursor: 'synthetic-cursor', complete: false }, customerAssignment: { status: 'unlinked', method: null } }));
  await settle();
  assert.match(fixture.node('results').innerHTML, /Kundenzuordnung offen/);
  assert.match(fixture.requests[2].url, /synthetic-customer\/purchases\/analyze$/);
  fixture.requests[2].resolve(result({ customerAssignment: { status: 'linked', method: 'master' } })); await settle();
  assert.match(fixture.node('results').innerHTML, /Kundenzuordnung bestätigt/);
  assert.doesNotMatch(fixture.node('results').innerHTML, /Kundenzuordnung offen/);
});

test('An older analysis response preserves the confirmed assignment received by search', async t => {
  const fixture = mountFixture(t); await fixture.ready();
  fixture.requests[1].resolve(result({ analysis: { cursor: 'synthetic-cursor', complete: false }, customerAssignment: { status: 'linked', method: 'publication' } }));
  await settle(); fixture.requests[2].resolve(result()); await settle();
  assert.match(fixture.node('results').innerHTML, /Kundenzuordnung bestätigt/);
  assert.match(fixture.node('results').innerHTML, /Kassenbelegen des ausgewählten Datenstands verbunden/);
});
