'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {unusedArticleNumber}=require('../server-tools/linux/recovery/lib/postgresql-smoke-fixture');
const {normalizeTradeFotoSourceArticleKey}=require('../lib/tradefoto-article-source-profile');
test('a collision chooses another candidate and includes archived articles',async()=>{
 const routes=[],candidates=[900001,900002];
 const result=await unusedArticleNumber(async route=>{routes.push(route);return routes.length===1?{total:2,items:[{}]}:{total:0,items:[]};},{randomInt:()=>candidates.shift()});
 assert.equal(result,'900002');assert.deepEqual(routes,['/api/sales/articles?status=all&query=900001','/api/sales/articles?status=all&query=900002']);
 assert.equal(normalizeTradeFotoSourceArticleKey(result.padStart(13,'0')).articleNumber,result);
});
test('candidate exhaustion is bounded, fails closed and never writes articles',async()=>{
 let calls=0,candidate=900000;
 await assert.rejects(unusedArticleNumber(async route=>{assert.ok(route.startsWith('/api/sales/articles?status=all&query='));calls++;return {total:1,items:[{}]};},{randomInt:()=>candidate++}),{code:'PG_RECOVERY_FIXTURE_UNAVAILABLE'});
 assert.equal(calls,20);
 calls=0;await assert.rejects(unusedArticleNumber(async()=>{calls++;return {total:1,items:[{}]};},{randomInt:()=>900001}),{code:'PG_RECOVERY_FIXTURE_UNAVAILABLE'});assert.equal(calls,1);
});
test('invalid results and read errors are not mistaken for a free number',async()=>{
 for(const result of [null,{items:[]},{total:-1,items:[]},{total:0,items:null}])await assert.rejects(unusedArticleNumber(async()=>result),{code:'ERR_ASSERTION'});
 const error=new Error('synthetic read failure');await assert.rejects(unusedArticleNumber(async()=>{throw error;}),e=>e===error);
 await assert.rejects(unusedArticleNumber(async()=>({total:0,items:[]}),{randomInt:()=>1000000}),{code:'ERR_ASSERTION'});
});
