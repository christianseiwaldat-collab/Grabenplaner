'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const widths = require('../public/sales-article-column-widths');
const {articleTablePreferences} = require('../lib/sales-article-table');

test('Column widths survive order changes and keep hidden permitted columns', () => {
  const saved = {columns:['articleNumber','description'], columnWidths:{articleNumber:140, description:415, primaryIdentifier:210}, visibleRows:10};
  const result = articleTablePreferences(saved, {read:true});
  assert.deepEqual(result.columnWidths, saved.columnWidths);
  assert.deepEqual(articleTablePreferences({...saved, columns:['description','articleNumber']}, {read:true}).columnWidths, result.columnWidths);
  assert.deepEqual(articleTablePreferences(null, {read:true}).columnWidths, {});
});

test('Stored widths are bounded and never expose unavailable price columns', () => {
  const input = {columnWidths:{articleNumber:2, description:99999, purchaseNet:150, retailGross:160, unknown:200, status:NaN}};
  assert.deepEqual(articleTablePreferences(input, {read:true}).columnWidths, {articleNumber:80, description:800});
  assert.deepEqual(articleTablePreferences(input, {read:true, pricesRead:true}).columnWidths, {articleNumber:80, description:800, retailGross:160});
  assert.equal(widths.valid({description:340}), true);
  for (const value of [null, [], {description:'340'}, {description:Infinity}, {unknown:140}, {status:90.5}, {description:801}]) assert.equal(widths.valid(value), false);
});
