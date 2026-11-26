'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const M = require('../lib/sales-bwl-simulation-model'), D = require('../lib/tradefoto-bestell/decimal');
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
