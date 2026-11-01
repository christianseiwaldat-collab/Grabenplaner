'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {catalogPrice}=require('../lib/data-import-catalog-price');
const {normalizeDecimal12}=require('../lib/sales-article-catalog');
test('Access catalog projection rounds decimal text at twelve places without binary arithmetic or cent rounding',()=>{
 for(const [source,expected] of [
  ['36.229729729729726','36.229729729730'],['0.0008333333333333334','0.000833333333'],
  ['0.024999999999999998','0.025000000000'],['123.12345678901249','123.123456789012'],
  ['123.1234567890125','123.123456789013'],['1.9999999999999','2.000000000000'],
  ['999999999999999998.9999999999999','999999999999999999.000000000000'],
 ])assert.equal(catalogPrice(source),expected);
 for(const value of [null,'0','49.9','12.123456789012','-2.50'])assert.equal(catalogPrice(value),value);
});
test('Overflow, positive underflow, negatives with excess scale and malformed source prices stay blocked',()=>{
 for(const value of ['999999999999999999.9999999999999','0.0000000000004','-0.0000000000001',
  '-1.0000000000001','1e-13','1,2345678901234',' 1.1234567890123','NaN','Infinity',1.2]) {
  assert.equal(catalogPrice(value),value);
  assert.throws(()=>normalizeDecimal12(catalogPrice(value)));
 }
});
