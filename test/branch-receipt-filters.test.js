'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('../public/branch-receipt-filters');
test('Receipt groups and exact comma-separated personnel numbers preserve user-defined semantics', () => {
  assert.deepEqual(F.STOCK, ['05', '11', '13', '18', '77', '99']);
  assert.deepEqual(F.INTERNET, ['00', '03', '70', '90']);
  assert.deepEqual(F.sellers(' 00012,34, 12 '), ['12', '34']);
  assert.deepEqual(F.sellers(''), []);
  for (const value of [null, 12, '1.2', '-1', '12;34', '12,', ',12', '12,,34', Array.from({ length: 21 }, (_, i) => i).join(',')]) assert.throws(() => F.sellers(value));
  assert.equal(F.location('003'), '03'); assert.equal(F.location('0'), '00');
  assert.equal(F.location(null), null); assert.equal(F.location('UNKNOWN'), null);
});
test('NULL-index candidates are decoded and distinguished from literal branch zero', async () => {
  const { backendFor } = require('../lib/branch-receipt-search');
  const calls = [], publication = { row: { id: 'publication' }, dataset: { row: { slot: 1 } }, reader: { decode: (_, table, row) => ({ normalized: { source: { Filialid: row.value } } }) } };
  const backend = backendFor({ base: { source: {} }, publication, publications: { referenceKey() { throw new Error('Zero uses NULL index'); } }, choices: { list: [{ id: '00', rawIds: ['0'], label: '00' }] } });
  const result = await backend.search({ queryAll: async (statement, params) => { calls.push(params); return [
    { sourceRow: 2, businessDate: '2026-09-10', value: null }, { sourceRow: 1, businessDate: '2026-09-10', value: '0' },
  ]; } }, { sourceTable: 'Umsatz_KASSE', locationId: '00', afterId: '~', afterDate: '2026-09-13', dateFrom: '2026-09-01', dateTo: '2026-09-13', limit: 20 });
  assert.equal(calls[0].locationKey, null); assert.deepEqual(result.map(r => r.receiptScopeAllowed), [false, true]);
  await assert.rejects(backend.search({}, { sourceTable: 'Tagesbericht' }), e => e.status === 403);
});
test('Receipt source filtering compiles to the PostgreSQL Sales schema with null-safe equality', () => {
  const { BRANCH_ARTICLE_CATALOG } = require('../lib/persistence/postgresql/reporting/branch-article-catalog');
  const entry = BRANCH_ARTICLE_CATALOG.find(e => e.statement.id === 'branch-receipt.source-search');
  assert.ok(entry); assert.match(entry.sql, /kassa\."cash_snapshot_1"/);
  assert.match(entry.sql, /IS NOT DISTINCT FROM/);
  assert.equal(entry.statement.operation, 'queryAll'); assert.equal(entry.parameterOrder.length, 7);
  assert.equal(require('../lib/persistence/postgresql/sales/catalog').createSalesCatalog(8).entries.length, 219);
});
