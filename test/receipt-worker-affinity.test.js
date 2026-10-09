'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createDataImportProtection}=require('../lib/data-import-protection');
const {createReceiptResultStore,sortedSearch}=require('../lib/receipt-result-store');
const runtimePath=path.resolve(__dirname,'../lib/persistence/postgresql/reporting/receipt-runtime.js');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const changed=error=>error.code==='IMPORT_HISTORY_RESULTS_CHANGED'&&error.status===409;
const query={sourceId:'synthetic',query:'',customer:'',sort:'receipt',direction:'asc',limit:1,cursor:'',resultSet:''};

function fixture(t,{partial=false}={}){
  const protection=createDataImportProtection({encryptionKey:Buffer.alloc(32,11),indexKey:Buffer.alloc(32,12),keyId:'receipt-affinity'});
  const slots=[],events=[];let now=1000,epoch='original-source';
  const createSalesReportBatchWorker=()=>{
    const index=slots.length,slot={store:createReceiptResultStore(),release:null};slots.push(slot);
    return {async run(input){
      events.push({slot:index,operation:input.operation,employeeNumber:input.session?.employeeNumber,accountId:input.session?.accountId});
      if(input.testHold)return new Promise(resolve=>{slot.release=()=>{slot.release=null;resolve({slot:index});};});
      if(input.testFailure)throw Object.assign(new Error('worker failed'),{code:'IMPORT_REPORT_WORKER_FAILED',status:503});
      if(!['receipt-search','branch-receipt-search'].includes(input.operation))return {slot:index};
      if((input.query.sort||'date')==='date'&&(input.query.direction||'desc')==='desc'&&!input.query.resultSet)return {slot:index,items:[],next:'stateless-date-cursor'};
      const owner=protection.digest([input.operation,input.session,input.testAuthority||'allowed']);
      return sortedSearch({store:slot.store,protection,owner,query:input.query,epoch,now:()=>now,
        scan:async q=>({epoch,items:partial&&!q.cursor?[{id:'b',receipt:'2'},{id:'c',receipt:'3'}]:partial?[{id:'a',receipt:'1'}]:[{id:'b',receipt:'2'},{id:'a',receipt:'1'}],
          processed:partial&&q.cursor?1:2,complete:!partial||!!q.cursor,next:partial&&!q.cursor?'synthetic-scan-continuation':null})});
    },async stop(){slot.release?.();slot.store=createReceiptResultStore();}};
  };
  // Exercise the shipped scheduler and the real encrypted result store. Only
  // the database-backed worker transport is replaced by isolated memory stores.
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(runtimePath,'utf8'),{module,__dirname:path.dirname(runtimePath),require:id=>{
    if(id==='../../../sales-report-batch-worker')return {createSalesReportBatchWorker};
    if(id==='../../repositories/sales-history-runtime')return {createManagedSalesHistoryRuntime:()=>{throw Error('Unused test dependency');}};
    return require(id);
  }},{filename:runtimePath});
  const pool=module.exports.createPostgresqlReceiptWorkers({});
  t.after(async()=>{for(const slot of slots)slot.release?.();await pool.close();protection.destroy();});
  return {pool,slots,events,advance:milliseconds=>{now+=milliseconds;},changeSource:()=>{epoch='new-source';},
    reset:index=>{slots[index].store=createReceiptResultStore();}};
}

async function continueWhileBusy(f,input,origin){
  await turn();
  const holds=Array.from({length:3},()=>f.pool.run({operation:'trade-insights',testHold:true}));
  await turn();assert.equal(f.slots.filter(slot=>slot.release).length,3);
  let settled=false;
  const pending=f.pool.run(input);pending.then(()=>{settled=true;},()=>{settled=true;});
  for(const [index,slot] of f.slots.entries())if(index!==origin)slot.release();
  await turn();
  const independent=await f.pool.run({operation:'trade-insights'});
  assert.notEqual(independent.slot,origin,'independent work uses a free worker');
  assert.equal(settled,false,'continuation waits for its original worker despite other free workers');
  f.slots[origin].release();await Promise.all(holds);
  return pending;
}

for(const principal of [
  {operation:'receipt-search',session:{employeeNumber:'personal-1'}},
  {operation:'branch-receipt-search',session:{accountId:'branch-18',sessionKind:'organization'}},
])test(`${principal.operation}: scan, pagination and re-sort survive concurrent jobs without moving encrypted state`,async t=>{
  const f=fixture(t,{partial:true});
  const initial=await f.pool.run({...principal,query});
  const origin=f.events.at(-1).slot;
  assert.equal(initial.sorting,true);assert.equal(initial.items.length,0);assert.ok(initial.next);
  assert.match(initial.next,/^gp-import-v1:/);
  const first=await continueWhileBusy(f,{...principal,query:{...query,cursor:initial.next}},origin);
  assert.equal(first.items[0].receipt,'1');assert.ok(first.next);assert.ok(first.resultSet);
  const second=await continueWhileBusy(f,{...principal,query:{...query,cursor:first.next}},origin);
  assert.equal(second.items[0].receipt,'2');
  const resort=await continueWhileBusy(f,{...principal,query:{...query,direction:'desc',resultSet:first.resultSet}},origin);
  assert.equal(resort.items[0].receipt,'3');
  // Even a switch to the normally stateless default sort must retain affinity
  // when it refers to an existing sorted result set.
  const byDate=await continueWhileBusy(f,{...principal,query:{...query,sort:'date',direction:'desc',resultSet:first.resultSet}},origin);
  assert.equal(byDate.items.length,1);
  assert.ok(f.events.filter(e=>e.operation===principal.operation).every(e=>e.slot===origin));
});

test('receipt affinity preserves owner, query, source and expiry validation',async t=>{
  const f=fixture(t),base={operation:'receipt-search',session:{employeeNumber:'personal-1'}};
  const first=await f.pool.run({...base,query});
  await assert.rejects(f.pool.run({...base,session:{employeeNumber:'another-person'},query:{...query,cursor:first.next}}),changed);
  await assert.rejects(f.pool.run({...base,query:{...query,customer:'different-customer',cursor:first.next}}),changed);
  await assert.rejects(f.pool.run({...base,testAuthority:'changed-rights',query:{...query,cursor:first.next}}),changed);
  assert.equal((await f.pool.run({...base,query:{...query,cursor:first.next}})).items[0].receipt,'2');
  f.changeSource();
  await assert.rejects(f.pool.run({...base,query:{...query,resultSet:first.resultSet}}),changed);
  const fresh=await f.pool.run({...base,query});f.advance(16*60*1000);
  await assert.rejects(f.pool.run({...base,query:{...query,cursor:fresh.next}}),changed);
});

test('ordinary date-descending receipt pages remain free to use another available worker',async t=>{
  const f=fixture(t),base={operation:'receipt-search',session:{employeeNumber:'personal-1'}};
  const q={...query,sort:'date',direction:'desc'};
  const first=await f.pool.run({...base,query:q});await turn();
  const held=f.pool.run({operation:'trade-insights',testHold:true});await turn();
  const second=await f.pool.run({...base,query:{...q,cursor:first.next}});
  assert.notEqual(second.slot,first.slot);
  for(const slot of f.slots)slot.release?.();await held;
});

test('branch account changes cannot adopt another account result or personal result',async t=>{
  const f=fixture(t),base={operation:'branch-receipt-search',session:{accountId:'branch-18',sessionKind:'organization'}};
  const first=await f.pool.run({...base,query});
  await assert.rejects(f.pool.run({...base,session:{...base.session,accountId:'branch-19'},query:{...query,cursor:first.next}}),changed);
  await assert.rejects(f.pool.run({operation:'receipt-search',session:{employeeNumber:'branch-18'},query:{...query,resultSet:first.resultSet}}),changed);
  assert.equal((await f.pool.run({...base,query:{...query,cursor:first.next}})).items[0].receipt,'2');
});

test('lost worker cache and result eviction fail closed, while a fresh search succeeds',async t=>{
  const f=fixture(t),base={operation:'receipt-search',session:{employeeNumber:'personal-1'}};
  const beforeRestart=await f.pool.run({...base,query}),origin=f.events.at(-1).slot;
  f.reset(origin);
  await assert.rejects(f.pool.run({...base,query:{...query,cursor:beforeRestart.next}}),changed);
  const first=await f.pool.run({...base,query});assert.equal(first.items[0].receipt,'1');
  for(let index=0;index<4;index++)await f.pool.run({...base,query:{...query,query:'another-query-'+index}});
  await assert.rejects(f.pool.run({...base,query:{...query,resultSet:first.resultSet}}),changed);
});

test('affinity keeps queue bounds and releases slots after failures and shutdown',async t=>{
  const f=fixture(t),base={operation:'receipt-search',session:{employeeNumber:'personal-1'}};
  const first=await f.pool.run({...base,query});await turn();
  const holds=Array.from({length:3},()=>f.pool.run({operation:'trade-insights',testHold:true}));await turn();
  const queued=Array.from({length:10},()=>f.pool.run({...base,query:{...query,cursor:first.next}}));
  await assert.rejects(f.pool.run({...base,query}),error=>error.code==='IMPORT_HISTORY_ANALYSIS_BUSY'&&error.status===503);
  for(const slot of f.slots)slot.release();await Promise.all(holds);
  for(const result of await Promise.all(queued))assert.equal(result.items[0].receipt,'2');
  await assert.rejects(f.pool.run({operation:'trade-insights',testFailure:true}),error=>error.code==='IMPORT_REPORT_WORKER_FAILED');
  assert.equal((await f.pool.run({...base,query})).items[0].receipt,'1');
  await turn();
  const holding=Array.from({length:3},()=>f.pool.run({operation:'trade-insights',testHold:true}));await turn();
  const stopped=assert.rejects(f.pool.run({...base,query}),error=>error.code==='IMPORT_REPORT_WORKER_FAILED');
  await f.pool.close();await stopped;await Promise.all(holding);
  await assert.rejects(f.pool.run({...base,query}),error=>error.code==='IMPORT_REPORT_WORKER_FAILED');
});

test('PostgreSQL receipt wrapper forwards a branded outer executor for protected source reads',async t=>{
  const f=await require('../test-support/trade-insights-sqlite').fixture(t);
  const {assertPersistenceExecutor}=require('../lib/persistence/contract');
  const {createPostgresqlReceiptWorkers}=require('../lib/persistence/postgresql/reporting/receipt-runtime');
  const pool=createPostgresqlReceiptWorkers({});t.after(()=>pool.close());
  const runtime=pool.runtime({access:f.app.provider,vault:f.vault,cashEnabled:true});
  let freshReads=0;
  // Use the shipped PostgreSQL wrapper and the real protected runtime. The
  // empty synthetic publication avoids starting database-backed workers; key
  // and publication reads must still reuse this outer branded transaction.
  await f.app.provider.transaction(async tx=>{
    assertPersistenceExecutor(tx);
    const getSession=async executor=>{assert.strictEqual(executor,tx);freshReads++;return f.state.session;};
    assert.equal(await runtime.run(getSession,workspace=>workspace,{executor:tx}),null);
  },{isolation:'serializable',readOnly:true});
  assert.ok(freshReads>=2,'fresh authorization uses the same executor before protected reads');
  await assert.rejects(runtime.run(async()=>f.state.session,()=>null,{executor:{}}),{code:'PERSISTENCE_CONTRACT_VIOLATION'});
  assert.equal(await runtime.run(async()=>f.state.session,workspace=>workspace),null,'ordinary calls keep the existing default transaction behavior');
});
