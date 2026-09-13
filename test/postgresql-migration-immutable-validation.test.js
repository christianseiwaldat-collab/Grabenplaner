'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../lib/data-import-contract');
const profile=()=>C.defineDataImportProfile({id:'synthetic-cache',entity:'synthetic-cache',version:1,sourceSystem:'test',schemaSha256:'a'.repeat(64),sourceTable:'test',keyFields:['id'],fields:[{source:'id',target:'id',type:'identifier',nullable:false},{source:'value',target:'value',type:'integer',nullable:false}],dataClasses:['internal_business']});
test('Immutable row reuse preserves validation, binds its profile and rejects forged or modified sources',()=>{
  const p=profile(),raw={id:'00001',value:7},ordinary=C.normalizeDataImportRow(p,raw),immutable=C.normalizeDataImportRow(p,raw,true);
  assert.deepEqual(immutable,ordinary);assert.equal(C.canonical(immutable),C.canonical(ordinary));
  assert.strictEqual(C.normalizeDataImportRow(p,immutable.source),immutable);
  assert.throws(()=>{immutable.source.value=8;},TypeError);assert.throws(()=>{immutable.key.push('bad');},TypeError);
  raw.value=8;assert.equal(C.normalizeDataImportRow(p,raw).data.value,8);assert.equal(immutable.data.value,7);
  assert.notStrictEqual(C.normalizeDataImportRow(profile(),immutable.source),immutable);
  assert.throws(()=>C.normalizeDataImportRow(p,Object.freeze({id:'00001',value:'7'})),e=>e.code==='IMPORT_INTEGER_INVALID');
});
test('Canonical hashes remain sensitive to nested mutation and cached objects cannot bypass depth limits',()=>{
  const nested={a:[{b:1}]},shallow=Object.freeze({nested});const before=C.fingerprint(shallow);nested.a[0].b=2;assert.notEqual(C.fingerprint(shallow),before);
  const immutable=C.freeze({a:[{b:2}]});assert.equal(C.canonical(immutable),'{"a":[{"b":2}]}');assert.equal(C.canonical(immutable),C.canonical(nested));
  let wrapped=immutable;for(let i=0;i<12;i++)wrapped={x:wrapped};assert.throws(()=>C.canonical(wrapped),e=>e.code==='IMPORT_VALUE_TOO_DEEP');
  assert.equal(C.canonical({2:'second',10:'tenth',label:'x'}),'{"10":"tenth","2":"second","label":"x"}');
  assert.equal(C.canonical({z:[null,-0,'a\"b'],a:true}),'{"a":true,"z":[null,0,"a\\\"b"]}');
  assert.throws(()=>C.canonical({a:NaN}),e=>e.code==='IMPORT_VALUE_INVALID');
});
test('Compiled row encoding preserves lexical keys, scalar escaping, nesting and the complete row-byte limit',()=>{
  const p=C.defineDataImportProfile({id:'synthetic-encoding',entity:'synthetic',version:1,sourceSystem:'test',schemaSha256:'a'.repeat(64),sourceTable:'test',keyFields:['id'],dataClasses:['internal_business'],fields:[
    {source:'id',target:'id',type:'identifier',nullable:false},{source:'2',target:'2',type:'integer',nullable:false},
    {source:'10',target:'10',type:'boolean',nullable:true},{source:'memo',target:'memo',type:'source_text',nullable:false}]});
  for(let i=0;i<100;i++){
    const raw={id:String(i).padStart(5,'0'),2:i%2?-i:i,10:i%3?Boolean(i%2):null,memo:'Ä\\\"\n\u0000'+String.fromCharCode(0xd800+i)+' €'.repeat(i)};
    const frozen=C.normalizeDataImportRow(p,raw,true),copy=JSON.parse(JSON.stringify(frozen));
    assert.equal(C.canonical(frozen),C.canonical(copy));assert.equal(C.canonical([frozen.source,frozen.data,frozen.key]),C.canonical([copy.source,copy.data,copy.key]));
    let nested=frozen;for(let n=0;n<10;n++)nested=[nested];assert.equal(C.canonical(nested),C.canonical(JSON.parse(JSON.stringify(nested))));
    assert.throws(()=>C.canonical([nested]),e=>e.code==='IMPORT_VALUE_TOO_DEEP');
  }
  assert.throws(()=>C.normalizeDataImportRow(p,{id:'1',2:1,10:null,memo:'x'.repeat(131072)},true),e=>e.code==='IMPORT_ROW_TOO_LARGE');
});
