'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decimal,valueFor,createRowDigest}=require('../lib/persistence/postgresql/transfer/values');
test('historical transfer preserves exact integers, decimals and source identities',()=>{
  assert.equal(valueFor({kind:'integer'},9223372036854775807n),'9223372036854775807');
  assert.throws(()=>valueFor({kind:'integer'},Number.MAX_SAFE_INTEGER+1));
  assert.equal(decimal('999999999999999999.123456789012'),'999999999999999999.123456789012');
  assert.equal(decimal('1e-12'),'0.000000000001');assert.equal(decimal('-0.00'),'0.000000000000');
  assert.throws(()=>decimal('1e-13'));assert.throws(()=>decimal('9999999999999999999'));assert.throws(()=>decimal('NaN'));
  assert.equal(valueFor({kind:'text'},'001234'),'001234');assert.throws(()=>valueFor({kind:'text'},'\0'));assert.throws(()=>valueFor({kind:'text'},'\ud800'));
});
test('historical row hashes bind column type, binary content, nulls, order and every value',()=>{
  const columns=[{name:'id',kind:'integer'},{name:'amount',kind:'decimal'},{name:'payload',kind:'blob'},{name:'value',kind:'real'},{name:'text',kind:'text'}];
  const a=createRowDigest(columns),b=createRowDigest(columns);
  a.add([9999999999999999n,'19.54',Uint8Array.from([0,255,92]),0.1,'Sony\n\\N']);
  b.add(['9999999999999999','19.540000000000',Buffer.from([0,255,92]),'0.1','Sony\n\\N']);
  assert.deepEqual(a.finish(),b.finish());
  const c=createRowDigest(columns);assert.throws(()=>c.add([1]));
  assert.throws(()=>valueFor({kind:'real'},Infinity));
  assert.throws(()=>valueFor({kind:'real'},' '));assert.throws(()=>valueFor({kind:'real'},'0x20'));
  assert.throws(()=>valueFor({kind:'real'},9007199254740993n));assert.throws(()=>valueFor({kind:'blob'},'\\x00'));
});
