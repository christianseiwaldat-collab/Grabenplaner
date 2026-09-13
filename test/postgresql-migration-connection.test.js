'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {Pool}=require('pg');
const {configuration,verifyEnvironment,PROFILE}=require('../lib/persistence/postgresql/core/environment');
const {createPostgresqlPersistenceProvider}=require('../lib/persistence/postgresql/provider');
test('Live Linux background priority affects only its worker and refuses the main thread',{skip:process.env.GP_PG_MIGRATION_LIVE!=='1'||process.platform!=='linux'},async()=>{
  const os=require('node:os'),{Worker}=require('node:worker_threads'),{once}=require('node:events');
  const modulePath=require.resolve('../lib/persistence/postgresql/reporting/worker-priority'),mainNice=os.getPriority(process.pid);
  assert.throws(()=>require(modulePath).lowerCurrentWorkerPriority(),/Background worker thread required/);
  const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage(require(workerData).lowerCurrentWorkerPriority());",{eval:true,workerData:modulePath});
  try{const [result]=await once(worker,'message');assert.deepEqual(result,{applied:true,workerNice:19,mainNice});assert.equal(os.getPriority(process.pid),mainNice);}finally{await worker.terminate();}
});
test('Live idle-in-transaction termination is contained and the next connection remains usable',{skip:process.env.GP_PG_MIGRATION_LIVE!=='1'},async()=>{
  const pool=new Pool({...configuration({profile:PROFILE,databaseUrl:process.env.GP_CORE_APP_URL,tlsMode:'disable-local-only'}),max:1,idle_in_transaction_session_timeout:100});
  const first=await pool.connect();try{await verifyEnvironment(first);}finally{first.release();}
  const errors=[],provider=createPostgresqlPersistenceProvider({pool,catalog:[],poolOwnership:'provider',onPoolError:e=>errors.push(e.code)});
  try{
    await assert.rejects(provider.transaction(async()=>{await new Promise(r=>setTimeout(r,300));}),e=>e.code==='PERSISTENCE_CONNECTION_UNAVAILABLE');
    assert.ok(errors.includes('PERSISTENCE_CONNECTION_UNAVAILABLE'));
    assert.equal(await provider.transaction(async()=> 'usable'),'usable');
  }finally{await provider.close();}
});
