'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {registerBranchSalesRoutes}=require('../lib/branch-sales-routes');
const F=require('../test-support/receipt-information-fixture');

async function fixture(t){
 const state={session:{id:'synthetic-session',sessionKind:'organization',accountType:'branch',isEmployee:false,accountId:'branch-test',permissions:['branch_receipts:read'],scopes:[{locationId:'18'}],mustChangePassword:false},calls:[],afterSearch:null};
 const app=express();app.use(express.json());
 registerBranchSalesRoutes(app,{
  requireSession:()=>state.session,refreshSession:async()=>state.session,
  assertCsrf:req=>{if(req.headers['x-csrf-token']!=='synthetic-token')throw Object.assign(Error('csrf'),{status:403,code:'CSRF_INVALID'});},
  receipts:{run:async(fresh,work)=>{await fresh();return work({receipts:{search:async input=>{state.calls.push(input);await state.afterSearch?.();return {items:[F.receipt()]};}}});}}
 });
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 state.post=async(body,token='synthetic-token')=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/portal/v1/branch-receipts/search',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':token},body:JSON.stringify(body)});
  return {status:response.status,headers:response.headers,body:await response.json()};
 };
 return state;
}
const query={dateFrom:'2026-11-01',dateTo:'2026-11-14',locations:['18'],deviceNumber:'DEVICE-000042',sellers:'252'};

test('branch search accepts the device filter and returns the additive receipt context through the real HTTP route',async t=>{
 const f=await fixture(t),result=await f.post(query);
 assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');
 assert.equal(f.calls[0].deviceNumber,query.deviceNumber);assert.deepEqual(f.calls[0].sourceLocationIds,['18']);assert.deepEqual(f.calls[0].sellerIds,['252']);
 assert.equal(result.body.items[0].time,'16:40:27.000');assert.equal(result.body.items[0].lines[0].deviceNumber,'DEVICE-000042');
 assert.equal(result.body.items[0].net,'50.00');
});

test('device search preserves CSRF, exact input validation, branch identity and post-read revocation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post(query,'wrong')).status,403);assert.equal(f.calls.length,0);
 assert.equal((await f.post({...query,projection:{company:true}})).status,422);assert.equal(f.calls.length,0);
 f.session.accountType='person';assert.equal((await f.post(query)).status,403);assert.equal(f.calls.length,0);
 f.session.accountType='branch';f.afterSearch=()=>{f.session.permissions=[];};
 const result=await f.post(query);assert.equal(result.status,403);assert.equal(f.calls.length,1);assert.equal(result.body.items,undefined);
});
