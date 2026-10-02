'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTradeLocationResolver}=require('../lib/persistence/repositories/trade-location-reader');
function resolver({masters={},cash={},targets=['18','05']}={}){
 let masterReads=0,cashReads=0;
 const resolve=createTradeLocationResolver({readMaster:async key=>{masterReads++;return masters[key]||{status:'unlinked',targetId:null};},readCash:async key=>{cashReads++;return cash[key]||{status:'unassigned',targetId:null};},readTarget:async id=>targets.includes(id)?{id,active:true}:null});
 return {resolve,counts:()=>({masterReads,cashReads})};
}
test('published cash location mappings fill the separate unlinked Trade store, including confirmed numeric variants',async()=>{
 const r=resolver({cash:{18:{status:'linked',targetId:'18'},5:{status:'linked',targetId:'05'}}});
 assert.equal(await r.resolve('18'),'18');assert.equal(await r.resolve('05'),'05');
 const counts=r.counts();assert.equal(await r.resolve('18'),'18');assert.deepEqual(r.counts(),counts);
 assert.equal(await r.resolve('19'),null,'equal source/target numbers do not create a binding');
});
test('explicit Trade authority wins; conflicting cash mappings or unavailable targets stay unresolved',async()=>{
 let r=resolver({masters:{18:{status:'linked',targetId:'05'}},cash:{18:{status:'linked',targetId:'18'}}});
 assert.equal(await r.resolve('18'),'05');assert.equal(r.counts().cashReads,0);
 r=resolver({cash:{5:{status:'linked',targetId:'18'},'05':{status:'linked',targetId:'05'}}});assert.equal(await r.resolve('5'),null);
 r=resolver({masters:{18:{status:'target_missing',targetId:'18'}},cash:{18:{status:'linked',targetId:'18'}}});assert.equal(await r.resolve('18'),null);assert.equal(r.counts().cashReads,0);
 r=resolver({cash:{18:{status:'linked',targetId:'missing'}}});assert.equal(await r.resolve('18'),null);
});
test('missing and numeric zero location values stay distinct',async()=>{
 const r=resolver({cash:{0:{status:'linked',targetId:'18'}}});assert.equal(await r.resolve(''),null);assert.equal(await r.resolve(null),null);assert.equal(await r.resolve('00'),'18');
});
