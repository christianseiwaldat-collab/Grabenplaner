'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTransactionActivity,STATEMENTS,CATALOG}=require('../lib/persistence/postgresql/boundary/transaction-activity');
const {createPostgresqlPersistenceProvider}=require('../lib/persistence/postgresql/provider');
function fixture(){
  let now=0;const events=[],last={core:0,sales:0},failures={};
  const activity=createTransactionActivity({now:()=>now,intervalMs:5000});
  const raw=domain=>Object.fromEntries(['queryOne','queryAll','execute'].map(method=>[method,async statement=>{
    if(failures[domain])throw failures[domain];
    if(now-last[domain]>=30000)throw new Error('Synthetic idle timeout');
    last[domain]=now;events.push([domain,statement?.id||'business']);
    return statement===STATEMENTS[domain]?{alive:1}:method==='execute'?{rowsAffected:1}:{ok:true};
  }]));
  return {events,failures,advance:ms=>now+=ms,activity,core:activity.attach('core',raw('core')),sales:activity.attach('sales',raw('sales'))};
}
test('ongoing work in either database preserves the idle partner across the real 30 second boundary',async()=>{
  for(const working of ['core','sales']){
    const f=fixture(),other=working==='core'?'sales':'core';
    for(let i=0;i<14;i++){f.advance(3000);await f[working].execute({id:'business'});}
    assert.ok(f.events.some(([domain,id])=>domain===other&&id===STATEMENTS[other].id));
    assert.deepEqual(await f[other].queryOne({id:'business'}),{ok:true});
  }
});
test('short work needs no pulse and an abandoned transaction still times out',async()=>{
  const f=fixture();f.advance(1000);await f.sales.queryAll({id:'business'});
  assert.deepEqual(f.events,[['sales','business']]);
  f.advance(31000);await assert.rejects(f.sales.queryOne({id:'business'}),/idle timeout/);
});
test('a lost partner rejects the whole operation before another business write',async()=>{
  const f=fixture(),failure=new Error('Synthetic connection lost');f.failures.core=failure;f.advance(6000);
  await assert.rejects(f.sales.execute({id:'write'}),e=>e===failure);assert.deepEqual(f.events,[]);
});
test('completed participants are detached and never touched after commit',async()=>{
  const f=fixture();f.activity.detach('core');f.advance(6000);await f.sales.queryOne({id:'business'});
  assert.deepEqual(f.events,[['sales','business']]);
});
test('activity statements qualify as read-only without changing migration catalogs',async()=>{
  for(const entry of Object.values(CATALOG)){
    const p=createPostgresqlPersistenceProvider({pool:{connect:async()=>{throw new Error('No connection expected');},end:async()=>{}},catalog:[entry]});
    assert.equal(entry.statement.operation,'queryOne');await p.close();
  }
});
