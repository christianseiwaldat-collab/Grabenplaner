'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {registerDataImportRoutes}=require('../lib/data-import-routes');
const {DATA_IMPORT_PERMISSIONS:P}=require('../lib/data-import-access');
async function fixture(t) {
  const principal=n=>({employeeNumber:n,accountId:'account-'+n,permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']});
  const state={session:principal('first'),csrf:true},stored=new Map(),app=express();
  app.use(express.json());
  const preferences={get:async(n,k)=>stored.get(n+':'+k),upsert:async(n,k,value)=>stored.set(n+':'+k,{value})};
  registerDataImportRoutes(app,{runtime:{context:async()=>({available:true})},preferences,
    requireSession(_r,p){if(!state.session)throw Object.assign(new Error(),{status:401});if(!state.session.permissions.includes(p))throw Object.assign(new Error(),{status:403});return state.session;},
    refreshSession:async()=>state.session,assertCsrf(){if(!state.csrf)throw Object.assign(new Error(),{status:403});}});
  const listener=app.listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));
  t.after(()=>new Promise(r=>listener.close(r)));
  const url='http://127.0.0.1:'+listener.address().port+'/api/data-import';
  return {state,stored,principal,get:async()=>(await fetch(url+'/context')).json(),save:value=>fetch(url+'/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})};
}
test('upload timeout persists per authenticated employee and context reloads the exact value',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.get()).uploadPolicy,{minutes:30,minMinutes:1,maxMinutes:120});
  assert.equal((await f.save({uploadTimeoutMinutes:75,employeeNumber:'second'})).status,200);
  assert.equal((await f.get()).uploadPolicy.minutes,75);
  f.state.session=f.principal('second');assert.equal((await f.get()).uploadPolicy.minutes,30);
  f.state.session=f.principal('first');assert.equal((await f.get()).uploadPolicy.minutes,75);
  assert.equal(f.stored.size,1);
});
test('timeout settings reject missing rights, CSRF and invalid values without altering saved preferences',async t=>{
  const f=await fixture(t);
  for(const value of [0,121,-1,1.5,'30',null,true])assert.equal((await f.save({uploadTimeoutMinutes:value})).status,400);
  f.state.csrf=false;assert.equal((await f.save({uploadTimeoutMinutes:20})).status,403);
  f.state.csrf=true;f.state.session.permissions=f.state.session.permissions.filter(p=>p!==P.PREPARE);
  assert.equal((await f.save({uploadTimeoutMinutes:20})).status,403);
  f.state.session=null;assert.equal((await f.save({uploadTimeoutMinutes:20})).status,401);
  assert.equal(f.stored.size,0);
});
test('invalid stored upload preference uses a finite default',async t=>{
  const f=await fixture(t);f.stored.set('first:data_import_upload_timeout_v1',{value:'{"uploadTimeoutMinutes":9999}'});
  assert.equal((await f.get()).uploadPolicy.minutes,30);
});
