'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../public/trade-insight-results');

test('Repeated result formatting reuses locale formatters without changing display values', () => {
  let constructions = 0;
  const context = {
    module: { exports: {} },
    Intl: {
      Collator: Intl.Collator,
      NumberFormat: function (...args) { constructions++; return new Intl.NumberFormat(...args); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/trade-insight-results.js'), 'utf8'), context);
  const { format } = context.module.exports;
  const initial = constructions;
  assert.equal(initial, 2);
  for (let i = 0; i < 10000; i++) {
    assert.equal(format('1234.5678', 'number'), '1\u00a0234,5678');
    assert.equal(format('1234.5678', 'money'), '€\u00a01.234,57');
  }
  assert.equal(constructions, initial);
  for (const value of [null, undefined, '']) assert.equal(format(value, 'number'), '–');
  assert.equal(format('9007199254740993.1234', 'decimal'), '9007199254740993,1234');
  assert.equal(format('2026-09-28T12:00:00Z', 'date'), '28.09.2026');
});

test('Related article links preserve the first occurrence and stop after twelve distinct articles', () => {
  const original = [{ articleNumber: '0001', label: 'first' }, { articleNumber: '0001', label: 'duplicate' },
    ...Array.from({ length: 20000 }, (_, i) => ({ articleNumber: String(i + 2) }))];
  let inspected = 0;
  const input = { *[Symbol.iterator]() { for (const row of original) { inspected++; yield row; } } };
  const result = model.relatedArticles(input);
  assert.deepEqual(result, [original[0], ...original.slice(2, 13)]);
  assert.equal(result[0], original[0]);
  assert.equal(inspected, 13);
  assert.deepEqual(model.relatedArticles([{ articleNumber: 'same' }, { articleNumber: 'same' }]), [{ articleNumber: 'same' }]);
});

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) {
  const index = app.indexOf(start), finish = app.indexOf(end, index + start.length);
  assert.ok(index >= 0 && finish > index);
  return app.slice(index, finish);
}

function catalogFixture() {
  const renders = [], pending = [];
  const catalog = { requestId: 1, items: [{ productId: 'one' }], total: 2, nextOffset: 1, limit: 50, searchStarted: true };
  let resets = 0;
  const context = {
    state: { salesArticleCatalog: catalog }, elements: {}, Intl,
    canReadSalesArticles: () => true,
    applySalesArticleCatalogReadState() {},
    resetSalesArticleCatalogDetailState() { resets++; },
    salesArticleCatalogFormValues: () => ({ query: 'camera', status: 'active' }),
    salesArticleCatalogSearchParameters: offset => 'offset=' + offset,
    setSalesArticleCatalogStatus() {},
    renderSalesArticleCatalogResults: options => renders.push(options?.detail ?? true),
    normalizeSalesArticleCatalogItem: item => item,
    salesArticleCatalogItemKey: item => item.productId,
    salesArticleCatalogSort: (sort, direction) => ({ sort, direction }),
    api: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  };
  vm.createContext(context);
  vm.runInContext(section('async function loadSalesArticleCatalog({', 'function changeSalesArticleCatalogSort('), context);
  return { context, catalog, renders, pending, resets: () => resets };
}

test('Paging and sorting keep the open article DOM and trial values; a new search clears it once', async () => {
  for (const [options, expected, resetCount] of [[{}, [false, false], 0], [{ reset: true, preserveDetail: true }, [false, false], 0], [{ reset: true }, [true, false], 1]]) {
    const f = catalogFixture(), work = f.context.loadSalesArticleCatalog(options);
    f.pending[0].resolve({ items: [{ productId: 'two' }], total: 2 });
    await work;
    assert.deepEqual(f.renders, expected);
    assert.equal(f.resets(), resetCount);
    assert.equal(f.catalog.loading, false);
  }
});

test('Obsolete catalog responses cannot render when permissions reset the request generation', async () => {
  const f = catalogFixture(), work = f.context.loadSalesArticleCatalog();
  f.catalog.requestId++;
  f.catalog.items = [];
  f.pending[0].resolve({ items: [{ productId: 'private' }], total: 1 });
  await work;
  assert.deepEqual(f.catalog.items, []);
  assert.deepEqual(f.renders, [false]);
});

test('List-only rendering skips article reconstruction; normal reset rendering still clears protected details', () => {
  let details = 0, imports = 0;
  const context = { state: { salesArticleCatalog: {} }, elements: {},
    renderSalesArticleLastImport() { imports++; },
    renderSalesArticleCatalogDetail() { details++; },
  };
  vm.createContext(context);
  vm.runInContext(section('function renderSalesArticleCatalogResults(', 'function salesArticleCatalogFormValues('), context);
  context.renderSalesArticleCatalogResults({ detail: false });
  assert.equal(details, 0);
  context.renderSalesArticleCatalogResults();
  assert.equal(details, 1);
  assert.equal(imports, 2);
});
