'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const UI = require('../public/sales-article-price-controls');
const layout = require('../public/sales-article-layout');
const { buildSalesArticlePriceMatrix } = require('../lib/sales-article-price-matrix');
function matrix(cost = '1827.87', vatPercent = '20') {
  return { costsRead: true, vatPercent,
    purchase: [{ id: 'average_purchase', current: { amount: cost, currency: 'EUR' } }],
    sales: [{ id: 'upe', gross: { amount: '2999' } }, { id: 'internet_5', gross: { amount: '2340' }, net: { amount: '1950' } }] };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
test('100 EUR margin derives net, gross, net-relative margin percent and UVP discount without mutating source prices', () => {
  const source = matrix(), before = JSON.stringify(source);
  const { values } = UI.calculate('margin', '100,00', source);
  close(values.net, 1927.87); close(values.gross, 2313.444); close(values.margin, 100);
  close(values.marginPercent, 100 / 1927.87 * 100);
  close(values.discountPercent, (2999 - 2313.444) / 2999 * 100);
  assert.equal(JSON.stringify(source), before);
});
test('All four entry points produce the same scenario, using net margin instead of cost markup', () => {
  const source = matrix('100');
  for (const [field, value] of [['gross', '150'], ['net', '125'], ['margin', '25'], ['marginPercent', '20']]) {
    const { values } = UI.calculate(field, value, source);
    close(values.gross, 150); close(values.net, 125); close(values.margin, 25); close(values.marginPercent, 20);
  }
  close(UI.calculate('gross', '2.340,00', matrix()).values.margin, 122.13);
  close(UI.calculate('gross', '2340.00', matrix()).values.margin, 122.13);
});
test('Invalid entries and impossible target margins never leave stale computed values', () => {
  for (const [field, value] of [['gross', ''], ['net', '-'], ['gross', '-1'], ['net', 'Infinity'],
    ['gross', '1e3'], ['marginPercent', '100'], ['marginPercent', '120'], ['margin', '-2000'], ['net', '1000000000001']]) {
    const result = UI.calculate(field, value, matrix());
    assert.ok(result.error, field + ': ' + value); assert.equal(result.values, undefined);
  }
});
test('Half-cent boundaries use commercial rounding and do not display negative zero', () => {
  assert.equal(UI.format(UI.calculate('marginPercent', '20', matrix()).values.gross), '2741,81');
  assert.equal(UI.format(1.005), '1,01');
  assert.equal(UI.format(-1.005), '-1,01');
  assert.equal(UI.format(-0.001), '0,00');
});
test('Zero prices, zero VAT/cost and loss-making scenarios remain well-defined', () => {
  const zero = UI.calculate('gross', '0', matrix('100', '0')).values;
  assert.equal(zero.gross, 0); assert.equal(zero.net, 0); assert.equal(zero.margin, -100); assert.equal(zero.marginPercent, null);
  close(UI.calculate('margin', '-20', matrix('100')).values.marginPercent, -25);
  close(UI.calculate('marginPercent', '-25', matrix('100')).values.gross, 96);
  assert.ok(UI.calculate('marginPercent', '50', matrix('0')).error);
  assert.equal(UI.calculate('net', '100', matrix('0')).values.marginPercent, 100);
  assert.equal(UI.calculate('net', '100', matrix('100', '0')).values.gross, 100);
});
test('Denied or unconfirmed costs are not reconstructed; missing VAT disables simulation', () => {
  const source = matrix();
  const denied = layout.restrictPrices(source, { pricesRead: true, costsRead: false });
  assert.equal(UI.trialBasis(denied).cost, null);
  assert.equal(UI.calculate('gross', '240', denied).values.margin, null);
  assert.equal(UI.calculate('gross', '240', denied).values.marginPercent, null);
  assert.ok(UI.calculate('margin', '100', denied).error);
  source.purchase[0].current.sourceValue = true;
  assert.equal(UI.trialBasis(source).cost, null);
  assert.ok(UI.calculate('marginPercent', '20', source).error);
  assert.ok(UI.calculate('gross', '240', matrix('100', null)).error);
  source.sales[0].gross.amount = '0';
  assert.equal(UI.calculate('gross', '240', source).values.discountPercent, null);
});
test('Column choices survive unknown/corrupt preferences and never allow hiding the last column', () => {
  const columns = ['sales', 'internet_3', 'internet_5'];
  assert.deepEqual(UI.normalizeColumns(null, columns), columns);
  assert.deepEqual(UI.normalizeColumns([], columns), columns);
  assert.deepEqual(UI.normalizeColumns(['removed'], columns), columns);
  assert.deepEqual(UI.normalizeColumns(['internet_5', 'internet_5', 'removed'], columns), ['internet_5']);
  assert.deepEqual(UI.toggleColumn(['internet_5'], 'internet_5', false, columns), ['internet_5']);
  assert.deepEqual(UI.toggleColumn(['internet_5'], 'sales', true, columns), ['sales', 'internet_5']);
});
test('Price matrix exposes UCW and Versuch without changing Trade source identifiers', () => {
  const source = buildSalesArticlePriceMatrix({ prices: [] }, null, { pricesRead: true });
  assert.equal(source.sales.find(c => c.id === 'internet_3').label, 'UCW');
  assert.equal(source.sales.find(c => c.id === 'internet_5').label, 'Versuch');
});
