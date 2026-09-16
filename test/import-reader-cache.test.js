'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Q=require('../lib/persistence/repositories/import-reader-cache');
const {createDataImportProtection}=require('../lib/data-import-protection');
test('Authenticated import reuse is limited to a transaction, protection instance and complete header; failed authentication is never reused',async()=>{
 const a=createDataImportProtection({encryptionKey:Buffer.alloc(32,11),indexKey:Buffer.alloc(32,12),keyId:'synthetic-a'});
 const b=createDataImportProtection({encryptionKey:Buffer.alloc(32,21),indexKey:Buffer.alloc(32,22),keyId:'synthetic-b'});
 try{
  const tx={},next={},header={id:'synthetic-record',scopeId:'synthetic-scope',revision:1,identityHash:'a'.repeat(64)},context=['synthetic-cache'];
  const ciphertext=a.seal({data:{amount:'0.001',empty:null}},context);let reads=0;
  const read=()=>{reads++;return a.open(ciphertext,context);};Q.start(tx);Q.start(next);
  const value=await Q.verified(tx,a,'master',header,read);
  assert.equal(await Q.verified(tx,a,'master',header,read),value);assert.equal(reads,1);
  assert.throws(()=>{value.data.amount='wrong';},TypeError);
  await assert.rejects(Q.verified(tx,b,'master',header,()=>b.open(ciphertext,context)));
  await Q.verified(next,a,'master',header,read);assert.equal(reads,2);
  await Q.verified(tx,a,'master',{...header,revision:2},read);assert.equal(reads,3);
  Q.invalidate(tx,header);await Q.verified(tx,a,'master',header,read);assert.equal(reads,4);
  let failed=0;const bad=()=>{failed++;throw new Error('synthetic authentication failure');};
  for(let i=0;i<2;i++)await assert.rejects(Q.verified(tx,a,'master',{...header,id:'broken'},bad));
  assert.equal(failed,2);
 }finally{a.destroy();b.destroy();}
});
