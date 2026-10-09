'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const M = require('../lib/sales-bwl-simulation-model'), D = require('../lib/tradefoto-bestell/decimal');
const { simulationFixture } = require('../test-support/sales-bwl-simulation-fixture');
const caps = { read: true, prices: true, costs: true, margin: true };
const pair = overrides => ({ key: 'source-key-18', source: { EAN: '0000000000042', Artikelbezeichnung: 'BEISPIEL', DurchschnittEK: '70', MWST: 1 },
  stock: { FBestand: '4', FilialID: 18 }, catalog: { articleNumber: '000042', description: 'BEISPIEL aktuelle Bezeichnung', retailGross: '120', retailNet: '100', sourceSystem: 'tradefoto.artikel_stamm' },
  location: { id: '18', label: '18 · BEISPIEL' }, ...overrides });
const provenance = { sourceAt: '2026-09-14T09:00:00.000Z', sourceFingerprint: 'a'.repeat(64), generatedAt: '2026-10-09T12:00:00.000Z' };
function snapshot(rows = [M.currentRow(pair(), caps)], change = {}, granted = caps) { return M.calculate(rows, M.normalize({ filters: {}, assumptions: { discountPercent: '10', sellThroughPercent: '50', horizonDays: 30, additionalCosts: '5', ...change } }, granted), granted, provenance); }
test('simulation arithmetic is exact and distinguishes gross/net revenue, cost, margin and once-only additional costs', () => {
  const s = snapshot(); assert.equal(s.rows[0].scenarioQuantity, '2'); assert.equal(s.rows[0].scenarioPriceGross, '108'); assert.equal(s.rows[0].scenarioPriceNet, '90');
  assert.equal(s.rows[0].scenarioGrossRevenue, '216'); assert.equal(s.rows[0].scenarioNetRevenue, '180'); assert.equal(s.rows[0].scenarioCost, '140'); assert.equal(s.rows[0].scenarioGrossMargin, '40');
  assert.equal(s.summary.totals.scenarioResult.value, '35'); assert.equal(s.summary.complete, true); assert.equal(s.rows[0].scenarioMarginPercent, '22.222222');
  const many = snapshot([M.currentRow(pair(), caps), M.currentRow(pair({ key: 'other' }), caps)]); assert.equal(many.summary.totals.scenarioResult.value, '75');
  assert.equal(snapshot(undefined, { horizonDays: 365 }).summary.totals.scenarioResult.value, '35', 'time horizon labels assumptions, never invents a forecast multiplier');
  assert.match(s.note, /keine Nachfrageprognose/); assert.equal(s.summary.mixedQuantityUnits, true);
});
test('fractional assumptions and values above Number precision retain exact decimal arithmetic', () => {
  const r = M.currentRow(pair({ stock: { FBestand: '9007199254740993', FilialID: 18 }, catalog: { ...pair().catalog, retailGross: '0.1', retailNet: '0.1' } }), caps);
  const s = snapshot([r], { discountPercent: '0', sellThroughPercent: '0.000001', additionalCosts: '0' });
  assert.equal(s.rows[0].scenarioQuantity, '90071992.54740993'); assert.equal(s.rows[0].scenarioGrossRevenue, '9007199.254740993');
});
test('manual accepted gross prices do not borrow stale imported VAT; missing net/cost never become zero totals', () => {
  const r = M.currentRow(pair({ catalog: { ...pair().catalog, retailGross: '240', retailNet: null, sourceSystem: 'manual', purchaseNet: null } }), caps), s = snapshot([r]);
  assert.equal(r.retailNet, null); assert.equal(r.averageCost, null); assert.equal(s.summary.totals.scenarioGrossRevenue.value, '432');
  for (const key of ['scenarioNetRevenue', 'scenarioCost', 'scenarioGrossMargin', 'scenarioResult']) { assert.equal(s.summary.totals[key].value, null); assert.equal(s.summary.totals[key].missingRows, 1); }
  const imported = M.currentRow(pair({ catalog: { ...pair().catalog, retailNet: null } }), caps); assert.equal(imported.retailNet, '100');
  const unknownTax = M.currentRow(pair({ source: { ...pair().source, MWST: 9 }, catalog: { ...pair().catalog, retailNet: null } }), caps); assert.equal(unknownTax.retailNet, null);
});
test('partial totals show known subtotals and physical, ambiguous or negative stock never inflates the scenario', () => {
  const invalid = [pair({ ambiguous: true }), pair({ stock: { FBestand: '-2', FilialID: 18 } }), pair({ source: { ...pair().source, OhneBestand: true } }), pair({ stock: { FBestand: null, FilialID: 18 } })].map(p => M.currentRow(p, caps));
  const s = snapshot([M.currentRow(pair(), caps), ...invalid]);
  assert.equal(s.summary.totals.scenarioQuantity.value, null); assert.equal(s.summary.totals.scenarioQuantity.knownSubtotal, '2'); assert.equal(s.summary.totals.scenarioQuantity.missingRows, 4);
  assert.equal(s.summary.totals.scenarioGrossMargin.knownSubtotal, '40'); assert.equal(s.summary.complete, false);
  const zero = snapshot([M.currentRow(pair({ stock: { FBestand: '0', FilialID: 18 } }), caps)]); assert.equal(zero.summary.totals.scenarioGrossRevenue.value, '0');
});
test('assumptions, filters and personal authorities enforce bounded strict data and existing inventory rights', async t => {
  for (const a of [{ discountPercent: '100.000001' }, { discountPercent: 10 }, { sellThroughPercent: '-1' }, { additionalCosts: '1e3' }, { additionalCosts: '1000000000000' }, { horizonDays: 366 }, { horizonDays: '30' }, { predictive: true }]) assert.throws(() => M.assumptions(a));
  for (const f of [{ locations: Array(101).fill('a') }, { sql: 'SELECT' }, { assortment: 'unknown' }, { sort: 'retailGross' }]) assert.throws(() => M.filters(f, caps));
  const f = await simulationFixture(t); assert.equal(M.authority(f.state.session).caps.read, true);
  for (const extra of [{ active: false }, { employeeActive: false }, { isEmployee: false }, { sessionKind: 'organization' }, { employeeNumber: '' }, { mustChangePassword: true }, { permissions: [] }]) assert.throws(() => M.authority({ ...f.state.session, ...extra }), { status: 403 });
  const original = M.authority(f.state.session).identity; for (const extra of [{ accountId: 'other' }, { scopes: [{ locationId: '18', departmentId: 4 }] }, { permissions: [...f.state.session.permissions, 'changed'] }]) assert.notEqual(M.authority({ ...f.state.session, ...extra }).identity, original);
});
test('real protected selection uses current accepted prices and source fingerprints, retains a trusted bounded token', async t => {
  const f = await simulationFixture(t), context = await f.simulation('context'); assert.equal(context.available, true); assert.equal(context.locations.length, 2); assert.equal(context.columns.length, M.COLUMNS.length);
  const s = await f.simulation('calculate', { filters: { assortment: 'sellout', locations: ['18'] }, assumptions: { additionalCosts: '5' } });
  assert.equal(s.snapshot.rows.length, 1); assert.equal(s.snapshot.summary.totals.scenarioResult.value, '35'); assert.equal(s.snapshot.sourceFingerprint, context.sourceFingerprint);
  assert.deepEqual(await f.simulation('snapshot', { snapshotToken: s.snapshotToken }), s.snapshot); assert.match(s.snapshotToken, /^gp-import-v[12]:/); assert.doesNotMatch(s.snapshotToken, /Fernglas|retailGross/);
  const current = await f.repo.getByArticleNumber('000042'); await f.repo.updateManual({ input: { currentArticleNumber: '000042', expectedRevision: current.currentRevision, articleNumber: '009999', description: 'BEISPIEL umbenannt', identifiers: [],
    prices: { sales: [{ priceType: 'sales', priceBasis: 'gross', amount: '240', currency: 'EUR' }] } }, actor: 'synthetic-owner', timestamp: '2026-09-14T10:00:00.000Z', mutationId: crypto.randomUUID() });
  assert.notEqual((await f.simulation('context')).sourceFingerprint, context.sourceFingerprint); await assert.rejects(f.simulation('snapshot', { snapshotToken: s.snapshotToken }), { status: 409 });
  const changed = await f.simulation('calculate', { filters: { query: 'umbenannt', assortment: 'sellout', locations: ['18'] }, assumptions: {} });
  assert.equal(changed.snapshot.rows[0].articleNumber, '009999'); assert.equal(changed.snapshot.rows[0].retailGross, '240'); assert.equal(changed.snapshot.rows[0].retailNet, null);
  assert.equal(changed.snapshot.summary.totals.scenarioNetRevenue.complete, false); assert.equal(changed.snapshot.summary.totals.scenarioGrossRevenue.value, '432');
});
test('scopes and separate price/cost grants hide both source fields and financial totals', async t => {
  const f = await simulationFixture(t); f.state.session.permissions = f.state.session.permissions.filter(p => !['sales:analytics:company:read', 'sales:articles:costs:read'].includes(p)); f.state.session.scopes = [{ locationId: '18' }];
  let s = await f.simulation('calculate', { filters: {}, assumptions: {} }); assert.equal(s.snapshot.rows.length, 1); assert.equal(s.snapshot.capabilities.prices, true);
  assert.equal(s.snapshot.capabilities.costs, false); assert.equal(s.snapshot.capabilities.margin, false); assert.doesNotMatch(JSON.stringify(s.snapshot), /averageCost|scenarioCost|scenarioGrossMargin|scenarioResult/);
  await assert.rejects(f.simulation('calculate', { filters: { locations: ['19'] }, assumptions: {} }), { status: 403 });
  f.state.session.permissions = f.state.session.permissions.filter(p => p !== 'sales:articles:prices:read'); s = await f.simulation('calculate', { filters: {}, assumptions: {} });
  assert.doesNotMatch(JSON.stringify(s.snapshot), /retailGross|retailNet|scenarioGrossRevenue|scenarioNetRevenue/); assert.equal(s.snapshot.summary.totals.scenarioQuantity.value, '2');
  f.state.session.permissions = f.state.session.permissions.filter(p => p !== 'sales:analytics:inventory:read'); await assert.rejects(f.simulation('context'), { status: 403 });
});
test('historical snapshots reduce revoked prices/costs without refreshing, but never reveal a withdrawn branch', async t => {
  const f = await simulationFixture(t), saved = (await f.simulation('calculate', { filters: {}, assumptions: {} })).snapshot;
  const restricted = { ...f.state.session, permissions: f.state.session.permissions.filter(p => !['sales:articles:prices:read', 'sales:articles:costs:read'].includes(p)) };
  const historical = M.filterHistorical(saved, M.authority(restricted)); assert.equal(historical.sourceFingerprint, saved.sourceFingerprint); assert.equal(historical.sourceAt, saved.sourceAt);
  assert.doesNotMatch(JSON.stringify(historical), /retailGross|averageCost|scenarioGrossRevenue|scenarioCost|scenarioGrossMargin/);
  assert.ok(saved.rows[0].retailGross); assert.equal(saved.rows.length, 2);
  const scoped = { ...restricted, scopes: [{ locationId: '18' }], permissions: restricted.permissions.filter(p => p !== 'sales:analytics:company:read') };
  assert.throws(() => M.filterHistorical(saved, M.authority(scoped)), { status: 403 });
});
test('duplicate protected stock rows remain unknown when all stock is selected and do not inflate physical totals', async t => {
  const f = await simulationFixture(t, { stocks: [{ EAN: '0000000000042', FilialID: 18, FBestand: '4' }, { EAN: '0000000000042', FilialID: 18, FBestand: '100' }] });
  const all = await f.simulation('calculate', { filters: { stock: 'all' }, assumptions: {} }); assert.equal(all.snapshot.rows.length, 1); assert.equal(all.snapshot.rows[0].quantity, null); assert.equal(all.snapshot.summary.totals.scenarioQuantity.value, null);
  const positive = await f.simulation('calculate', { filters: { stock: 'positive' }, assumptions: {} }); assert.equal(positive.snapshot.rows.length, 0); assert.equal(positive.snapshot.summary.totals.scenarioQuantity.value, '0');
});
test('new SQLite and native PostgreSQL source/CAS statements share typed contracts without schema changes', () => {
  const S = require('../lib/sales-bwl-simulation-statements'), pg = S.postgresql(), sqlite = require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG;
  assert.equal(pg.length, 2); assert.ok(sqlite.some(e => e.statement === S.catalogEpoch)); assert.ok(sqlite.some(e => e.statement === S.remove));
  assert.equal(pg[0].statement.operation, 'queryOne'); assert.match(pg[0].sql, /sum/i); assert.match(pg[0].sql, /current_revision/);
  assert.equal(pg[1].statement.operation, 'execute'); assert.deepEqual(new Set(pg[1].parameterBindings.map(b => b.parameter)), new Set(['id', 'scopeId', 'kind', 'expectedRevision']));
  assert.match(pg[1].sql, /delete/i); assert.match(pg[1].sql, /scope_id/); assert.match(pg[1].sql, /revision/);
  const sales = require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG, core = require('../lib/persistence/postgresql/core/trade-annotations').CATALOG;
  assert.equal(sales.filter(e => e.statement === S.catalogEpoch).length, 1); assert.equal(sales.some(e => e.statement === S.remove), false);
  assert.equal(core.filter(e => e.statement === S.remove).length, 1); assert.equal(core.some(e => e.statement === S.catalogEpoch), false); assert.match(pg[1].sql, /gp\s*\.\s*trade_annotations/);
});
