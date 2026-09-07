"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { SALES_HISTORY_PERMISSIONS: H, SALES_HISTORY_PERMISSION_CATALOG, buildSalesHistoryProjection, salesHistoryPermissionDependencies } = require('../lib/sales-history-access');
const { SALES_ANALYTICS_PERMISSIONS: A } = require('../lib/sales-analytics-access');
const { CRM_PERMISSIONS: C } = require('../lib/crm-access');
const { normalizeSalesHistoryQuery } = require('../lib/sales-history-query');
const { registerSalesHistoryRoutes } = require('../lib/sales-history-routes');
const UI = require('../public/sales-history');
const base = () => ({ employeeNumber: '419', isEmployee: true, permissions: [H.READ, A.ACCESS, A.LOCATION_READ], scopes: [{ locationId: '1', departmentId: 0 }] });
test('Block 5: personal, branch and feature rights are cumulative; IT/default roles gain no sales history rights', () => {
  const session = base(); assert.equal(buildSalesHistoryProjection(session).read, true);
  for (const change of [{ employeeNumber: null }, { isEmployee: false }, { sessionKind: 'organization' }, { permissions: [H.READ] }, { scopes: [{ locationId: '1', departmentId: 2 }] }])
    assert.equal(buildSalesHistoryProjection({ ...session, ...change }).read, false);
  for (const role of ['manager', 'admin', 'it_admin', 'developer', 'hr', 'department_manager']) assert.equal(buildSalesHistoryProjection({ ...session, role, permissions: [] }).read, false);
  assert.equal(buildSalesHistoryProjection({ ...session, permissions: [...session.permissions, H.CUSTOMER_PURCHASES] }).customerPurchases, false);
  assert.equal(buildSalesHistoryProjection({ ...session, permissions: [...session.permissions, H.CUSTOMER_PURCHASES, C.ACCESS, C.CUSTOMERS_READ] }).customerPurchases, true);
  assert.equal(buildSalesHistoryProjection({ ...session, permissions: [...session.permissions, H.UNASSIGNED] }).unassigned, false);
  assert.ok(SALES_HISTORY_PERMISSION_CATALOG.every(p => !p.eligibleRoles.includes('it_admin')));
});
test('Block 5: delegation validates all new dependencies without expanding protected rights on other roles', () => {
  assert.equal(salesHistoryPermissionDependencies([]).valid, true);
  for (const p of Object.values(H)) assert.equal(salesHistoryPermissionDependencies([p]).valid, false);
  assert.equal(salesHistoryPermissionDependencies([...Object.values(H), A.ACCESS, A.COMPANY_READ, C.ACCESS, C.CUSTOMERS_READ]).valid, true);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.equal(server.split('...SALES_HISTORY_PERMISSION_CATALOG').length - 1, 2);
  assert.match(server, /salesHistoryPermissionDependencies\(\[\.\.\.projected\]\)/);
  assert.doesNotMatch(server, /ensureSqliteImportHistorySchema|createImportHistoryWriters|createSalesHistoryWorkspace/);
});
test('Block 5: filters default to year-to-report-end and reject open, invalid, future or oversized ranges', () => {
  const projection = buildSalesHistoryProjection(base()), options = { today: '2026-09-05', projection };
  const q = normalizeSalesHistoryQuery({ sourceId: 'cash' }, options); assert.equal(q.dateFrom, '2026-01-01'); assert.equal(q.dateTo, '2026-09-05');
  for (const change of [{ dateFrom: '2026-02-30' }, { dateTo: '2026-09-06' }, { dateFrom: '2025-01-01' }, { dateFrom: '2026-09-05', dateTo: '2026-09-04' }, { limit: 101 }, { limit: 'NaN' }, { kind: 'everything' }, { sellerRole: 'auto' }, { scopeId: 'other' }])
    assert.throws(() => normalizeSalesHistoryQuery({ sourceId: 'cash', ...change }, options));
});
async function apiFixture(t) {
  const app = express(); app.use(express.json({ limit: '16kb' })); const state = { session: base(), workspace: null, calls: 0, exists: true };
  registerSalesHistoryRoutes(app, { requireSession() { if (!state.session) throw Object.assign(new Error('secret diagnostic'), { status: 401, code: 'PORTAL_LOGIN_REQUIRED' }); return state.session; },
    assertCsrf(request) { if (request.get('X-CSRF-Token') !== 'synthetic') throw Object.assign(new Error('secret csrf'), { status: 403, code: 'PORTAL_CSRF_INVALID' }); },
    getWorkspace: () => state.workspace, customerExists: async () => state.exists });
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  return { state, async request(url, { method = 'GET', csrf = true, body = {} } = {}) { return fetch(`http://127.0.0.1:${listener.address().port}${url}`,
    { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': 'synthetic' } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) }); } };
}
test('Block 5: production route stays disabled until trusted source activation; no-store and personal login enforced', async t => {
  const f = await apiFixture(t), context = await f.request('/api/sales-history/context'); assert.equal(context.status, 200);
  assert.match(context.headers.get('cache-control'), /private, no-store/); assert.equal((await context.json()).available, false);
  const unavailable = await f.request('/api/sales-history/search', { method: 'POST' }); assert.equal(unavailable.status, 503);
  f.state.session.isEmployee = false; assert.equal((await f.request('/api/sales-history/context')).status, 403);
  f.state.session = null; assert.equal((await f.request('/api/sales-history/context')).status, 401);
});
test('Block 5: search routes require CSRF, cumulative CRM rights and an existing CRM target', async t => {
  const f = await apiFixture(t); f.state.workspace = { async search(query, options) { f.state.calls++; return { query, customerId: options?.customerId || null }; } };
  assert.equal((await f.request('/api/sales-history/search', { method: 'POST', csrf: false })).status, 403); assert.equal(f.state.calls, 0);
  const purchase = '/api/crm/customers/synthetic-customer/purchases/search';
  assert.equal((await f.request(purchase, { method: 'POST' })).status, 403); assert.equal(f.state.calls, 0);
  f.state.session.permissions.push(H.CUSTOMER_PURCHASES, C.ACCESS, C.CUSTOMERS_READ); f.state.exists = false;
  assert.equal((await f.request(purchase, { method: 'POST' })).status, 404); assert.equal(f.state.calls, 0);
  f.state.exists = true; const result = await f.request(purchase, { method: 'POST', body: { sourceId: 'cash' } });
  assert.equal(result.status, 200); assert.equal((await result.json()).customerId, 'synthetic-customer'); assert.equal(f.state.calls, 1);
});
test('Block 5: routes never expose source values, keys or SQL errors in failure messages', async t => {
  const f = await apiFixture(t); f.state.workspace = { async search() { throw new Error('customer=secret, SELECT private FROM protected'); } };
  const result = await f.request('/api/sales-history/search', { method: 'POST' }); assert.equal(result.status, 500);
  assert.doesNotMatch(await result.text(), /secret|SELECT|protected/);
});

test('Productive Block 2: analysis continuation has the same CSRF, CRM and personal rights as search', async t => {
  const f = await apiFixture(t); f.state.workspace = { async analyze(input, options) { f.state.calls++; return { customerId: options?.customerId || null, complete: true }; } };
  const post = (url, csrf = true) => f.request(url, { method: 'POST', csrf, body: { query: { sourceId: 'cash' }, cursor: 'opaque' } });
  assert.equal((await post('/api/sales-history/analyze', false)).status, 403);
  assert.equal((await post('/api/sales-history/analyze')).status, 200);
  const purchase = '/api/crm/customers/synthetic-customer/purchases/analyze';
  assert.equal((await post(purchase)).status, 403);
  f.state.session.permissions.push(H.CUSTOMER_PURCHASES, C.ACCESS, C.CUSTOMERS_READ);
  assert.equal((await (await post(purchase)).json()).customerId, 'synthetic-customer');
  f.state.exists = false; assert.equal((await post(purchase)).status, 404);
  f.state.session.mustChangePassword = true; assert.equal((await post('/api/sales-history/analyze')).status, 403);
});

test('Productive Block 2: UI exposes processing progress, pause/resume and no partial amount', () => {
  const result = { totals: null, coverage: { label: 'Synthetic', complete: false, counts: { records: 200, checked: 200, review: 0 }, unresolved: {}, issues: [] }, days: [] };
  const markup = UI.renderSummary(result); assert.match(markup, /200 Datensätze verarbeitet/); assert.match(markup, /Keine freigegebene Umsatzsumme/);
  const source = fs.readFileSync(path.join(__dirname,'../public/sales-history.js'),'utf8');assert.match(source,/Nach diesem Schritt pausieren/);assert.match(source,/Zeitraumsauswertung fortsetzen/);assert.match(source,/endpoint\('analyze'\)/);
});
test('Block 5: UI escapes imported text, labels page sorting and separates raw prices from checked sales', () => {
  const html = UI.renderTable([{ id: '1', date: '2026-09-04', receipt: '<script>x</script>', description: '<img src=x onerror=x>', article: '001', quantity: '1.000', sourcePrice: '12',
    location: { status: 'missing_source' }, articleReference: { status: 'unlinked' }, issues: ['SALES_SEMANTICS_UNCONFIRMED'], provenance: {} }], 'sales');
  assert.doesNotMatch(html, /<script>|<img/); assert.match(html, /&lt;script&gt;/); assert.match(html, /Sortierung der angezeigten Seite/);
  assert.match(html, /Quellpreis \(ungeprüft\)/); assert.match(html, /Prüfung offen/); assert.doesNotMatch(html, /Positionsverkäufer/);
});
test('Block 5: UI reuses calendar/theme, keeps search explicit and clears outstanding reads when accounts change', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../public/sales-history.js'), 'utf8'), app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(ui, /GrabenplanerDateRangeCalendar\?\.createDateRangeCalendar/); assert.doesNotMatch(ui, /type="date"|localStorage|sessionStorage|innerHTML\s*=\s*error/);
  assert.match(ui, /ticket !== generation/); assert.match(ui, /controller\?\.abort\(\)/); assert.match(ui, /body\.replaceChildren\(\)/);
  assert.match(app, /state\.portalSession = null;\s+syncSalesHistoryAccess\(\)/);
  const css = fs.readFileSync(path.join(__dirname, '../public/sales-history.css'), 'utf8'); assert.match(css, /position:sticky/); assert.match(css, /max-height:400px/);
  assert.match(css, /var\(--surface\)/); assert.doesNotMatch(css, /--paper/);
});
test('Block 5: destroying a UI before a late context response prevents private data from reappearing', async () => {
  let resolve; const response = new Promise(r => { resolve = r; }), events = {}, body = { textContent: '', querySelector: () => null, replaceChildren() { this.textContent = ''; } };
  const root = { open: true, querySelector: () => body, addEventListener: (n, f) => { events[n] = f; }, removeEventListener: n => { delete events[n]; }, removeAttribute() {} };
  let signal; const controller = UI.mount(root, { api: (_url, options) => { signal = options.signal; return response; } });
  controller.destroy(); assert.equal(signal.aborted, true); resolve({ available: false, message: 'must never appear after logout' });
  await new Promise(r => setImmediate(r)); assert.equal(body.textContent, '');
});
