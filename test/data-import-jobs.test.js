'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createDataImportJobs}=require('../lib/data-import-jobs'),{createDataImportJobStore,RETENTION_MS}=require('../lib/data-import-job-store');
const {createDataImportLifecycle}=require('../lib/data-import-lifecycle'),{createIntegrationSecretVault}=require('../lib/integration-secret-vault');
const C=require('../lib/data-import-contract'),{DATA_IMPORT_PERMISSIONS:P}=require('../lib/data-import-access');
const session=()=>({employeeNumber:'synthetic',accountId:null,isEmployee:true,permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read']});
const sourceBuffer=()=>{const b=Buffer.alloc(4096);b.write('Standard ACE DB',4);b[0x14]=3;b.write('private synthetic input',256);return b;};
const turn=()=>new Promise(r=>setImmediate(r));
async function fixture(t,{advancingClock=false}={}){
 // Windows CI exposes TEMP through an 8.3 alias. The private spool deliberately
 // requires canonical paths, so resolve the fixture parent before creating it.
 const temporaryRoot=await fsp.realpath(os.tmpdir());
 const parent=await fsp.mkdtemp(path.join(temporaryRoot,'gp-import-jobs-')),directory=path.join(parent,'spool');
 const vault=createIntegrationSecretVault({activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}}),sources=new Map();
 const state={principal:session(),now:Date.now(),calls:0,failures:0,failCode:'IMPORT_SOURCE_READ_TIMEOUT',reviews:0},getSession=async()=>state.principal;
 const runtime={reserve:async(get,{buffer,kind})=>{const user=await get(),id=crypto.createHash('sha256').update(user.employeeNumber).update(kind).update(buffer).digest('hex');
   if(!sources.has(id))sources.set(id,{id,kind,status:'queued',complete:false,activationEnabled:true,revision:1,received:0});return {...sources.get(id)};},
  upload:async(get,{buffer,signal})=>{assert.equal((await get()).employeeNumber,'synthetic');assert.ok(buffer.includes(Buffer.from('private synthetic input')));state.calls++;
   const s=[...sources.values()][0];if(state.block)await state.block(signal);s.received++;
   if(state.failures-->0)throw new C.DataImportError(state.failCode,409);
   s.complete=true;s.status='reviewing';return {...s};},
  sourceOperation:async(get,id,action)=>{await get();const s=sources.get(id);if(action==='review'){state.reviews++;s.status='ready';}
    if(action==='apply'){if(state.beforeApply)await state.beforeApply();s.applied=(s.applied||0)+1;s.revision++;s.status=s.applied>=3?'applied':'applying';}return {...s};}};
 let queue;const now=()=>advancingClock?state.now++:state.now;
 const store=createDataImportJobStore({directory,vault,now});
 const options={directory,vault,runtime,store,resolvePrincipal:getSession,now};
 const make=()=>{queue=createDataImportJobs({...options,lifecycle:createDataImportLifecycle()});return queue;};make();
 const enqueue=()=>queue.enqueue(getSession,{buffer:sourceBuffer(),kind:'trade',password:'synthetic-password'});
 t.after(async()=>{await queue.stop();assert.equal(path.dirname(await fsp.realpath(parent)),await fsp.realpath(os.tmpdir()));await fsp.rm(parent,{recursive:true,force:true});});
 return {directory,store,state,getSession,make,enqueue,runtime,sources,get queue(){return queue;}};
}

test('accepted file is encrypted and completes reading plus review with no browser or session token',async t=>{
 const f=await fixture(t),source=await f.enqueue();assert.equal(f.state.calls,0);
 const names=await fsp.readdir(f.directory);assert.equal(names.length,2);
 for(const n of names){const bytes=await fsp.readFile(path.join(f.directory,n));assert.equal(bytes.includes(Buffer.from('private synthetic')),false);assert.equal(bytes.includes(Buffer.from('synthetic-password')),false);}
 assert.equal((await f.queue.overlay(source)).background.status,'queued');
 await f.queue.tick();assert.equal(f.state.calls,1);assert.equal(f.state.reviews,1);assert.deepEqual(await fsp.readdir(f.directory),[]);
 assert.equal(f.sources.get(source.id).status,'ready');
});

test('deleting a paused Access copy removes bytes and password, but never writes GP import state',async t=>{
 const f=await fixture(t),source=await f.enqueue();
 await assert.rejects(f.queue.deleteUpload(f.getSession,source.id,{expectedRevision:1}),{code:'IMPORT_SOURCE_BUSY'});
 await f.queue.action(f.getSession,source.id,'pause');
 const before=JSON.stringify([...f.sources]),job=await f.store.read(source.id);
 await assert.rejects(f.queue.deleteUpload(f.getSession,source.id,{expectedRevision:2}),{code:'IMPORT_REVISION_CONFLICT'});
 f.state.principal={...session(),permissions:session().permissions.filter(p=>p!==P.PREPARE)};
 await assert.rejects(f.queue.deleteUpload(f.getSession,source.id,{expectedRevision:1}),{code:'IMPORT_FORBIDDEN'});
 f.state.principal=session();
 const result=await f.queue.deleteUpload(f.getSession,source.id,{expectedRevision:1});
 assert.equal(result.uploadFileAvailable,false);assert.equal(JSON.stringify([...f.sources]),before);assert.equal(f.state.calls,0);assert.equal(f.state.reviews,0);
 assert.equal(fs.existsSync(path.join(f.directory,job.blob.name)),false);
 const saved=await f.store.read(source.id);assert.equal(saved.blob,null);assert.equal(saved.password,'');assert.equal(saved.error,'IMPORT_JOB_FILE_DELETED');
 await assert.rejects(f.queue.action(f.getSession,source.id,'retry'),{code:'IMPORT_JOB_FILE_DELETED'});
 await f.queue.stop();f.make();await f.queue.tick();assert.equal(JSON.stringify([...f.sources]),before);
 await f.queue.deleteUpload(f.getSession,source.id,{expectedRevision:1});
 await f.enqueue();await f.queue.tick();assert.equal(f.sources.get(source.id).status,'ready');
});

test('content-date backfill survives a restart and never authorizes apply or reuploads a file',async t=>{
 const f=await fixture(t),source=await f.enqueue();await f.queue.tick();
 let dates=0;const original=f.runtime.sourceOperation;
 f.runtime.sourceOperation=async(get,id,action,input)=>{
  if(action==='content-date'){await get();dates++;const s=f.sources.get(id);s.contentDate={status:'complete',value:'2026-09-03T23:59:00.000'};return {...s};}
  return original(get,id,action,input);
 };
 await f.queue.enqueueContentDate(f.getSession,source.id);assert.equal((await f.queue.overlay(source)).background.status,'dating');
 assert.equal((await f.store.read(source.id)).blob,null);
 await f.queue.stop();f.make();await f.queue.tick();
 assert.equal(dates,1);assert.equal(f.state.calls,1);assert.equal(f.state.reviews,1);assert.equal(f.sources.get(source.id).applied,undefined);
 assert.equal((await f.queue.overlay(f.sources.get(source.id))).background,undefined);
 await f.queue.enqueueContentDate(f.getSession,source.id);assert.deepEqual(await fsp.readdir(f.directory),[]);
});

test('failed Access-file cleanup keeps its reference and retries deletion without rereading completed GP data',async t=>{
 const f=await fixture(t),source=await f.enqueue(),remove=f.store.remove;
 let fail=true;f.store.remove=async name=>{if(name.endsWith('.source')&&fail){fail=false;throw Object.assign(new Error('synthetic unlink failure'),{code:'EACCES'});}return remove(name);};
 await f.queue.tick();
 const failed=await f.store.read(source.id);assert.equal(failed.phase,'reviewing');assert.equal(failed.password,'');assert.ok(failed.blob);
 assert.equal((await f.queue.overlay(f.sources.get(source.id))).uploadFileAvailable,true);assert.equal(f.state.calls,1);
 await f.queue.stop();f.make();await f.queue.action(f.getSession,source.id,'retry');await f.queue.tick();
 assert.equal(f.state.calls,1);assert.equal(f.sources.get(source.id).status,'ready');assert.deepEqual(await fsp.readdir(f.directory),[]);
});

test('optional date backfill yields its saved page when a requested takeover arrives',async t=>{
 const f=await fixture(t),source=await f.enqueue();await f.queue.tick();
 const second={id:'c'.repeat(64),kind:'trade',status:'ready',complete:true,activationEnabled:true,revision:1,received:1};f.sources.set(second.id,second);
 let dates=0;const original=f.runtime.sourceOperation;
 f.runtime.sourceOperation=async(get,id,action,input)=>{
  if(action==='content-date'){
   await get();dates++;const s=f.sources.get(id);s.contentDate={status:dates===2?'complete':'pending',value:'2026-09-03T23:59:00.000'};
   if(dates===1)await f.queue.enqueueApply(f.getSession,second.id,{expectedRevision:1});
   return {...s};
  }
  return original(get,id,action,input);
 };
 await f.queue.enqueueContentDate(f.getSession,source.id);await f.queue.tick();
 assert.equal(dates,1);assert.equal(f.sources.get(second.id).applied,undefined);
 assert.equal((await f.store.read(source.id)).status,'queued');
 await f.queue.tick();assert.equal(f.sources.get(second.id).status,'applied');assert.equal(dates,1);
 await f.queue.tick();assert.equal(dates,2);assert.deepEqual(await fsp.readdir(f.directory),[]);
});

test('deleting a remaining Access copy after reading preserves the GP checkpoint and allows review without reupload',async t=>{
 const f=await fixture(t),source=await f.enqueue(),remove=f.store.remove;
 f.store.remove=async name=>{if(name.endsWith('.source'))throw new Error('synthetic cleanup failure');return remove(name);};
 await f.queue.tick();const before=JSON.stringify([...f.sources]);f.store.remove=remove;
 const cleared=await f.queue.deleteUpload(f.getSession,source.id,{expectedRevision:1});
 assert.equal(JSON.stringify([...f.sources]),before);assert.equal(cleared.uploadFileAvailable,false);assert.equal(cleared.background.status,'paused');
 await f.queue.action(f.getSession,source.id,'retry');await f.queue.tick();assert.equal(f.state.calls,1);assert.equal(f.sources.get(source.id).status,'ready');
});

test('upload and takeover survive reconstruction when the clock advances between every call',async t=>{
 const f=await fixture(t,{advancingClock:true}),source=await f.enqueue();
 assert.equal((await f.store.read(source.id)).expires-(await f.store.read(source.id)).created,RETENTION_MS);
 await f.queue.stop();f.make();await f.queue.tick();assert.equal(f.sources.get(source.id).status,'ready');
 await f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:1});
 const job=await f.store.read(source.id);assert.equal(job.expires-job.created,RETENTION_MS);
 await f.queue.stop();f.make();await f.queue.tick();
 assert.equal(f.sources.get(source.id).applied,3);assert.equal(f.sources.get(source.id).status,'applied');
});

test('legacy millisecond expiry drift is normalized and does not prevent takeover resumption',async t=>{
 const f=await fixture(t),source=await f.enqueue();await f.queue.tick();
 await f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:1});
 const job=await f.store.read(source.id);
 for(const drift of [1,17,1000]){
  await f.store.save({...job,expires:job.created+RETENTION_MS+drift});
  assert.equal((await f.store.read(source.id)).expires,job.created+RETENTION_MS);
 }
 for(const drift of [-1,1001]){
  await f.store.save({...job,expires:job.created+RETENTION_MS+drift});
  await assert.rejects(f.store.read(source.id),{code:'IMPORT_JOB_STATE_INVALID'});
 }
 await f.store.save({...job,expires:job.created+RETENTION_MS+1});
 await f.queue.stop();f.make();await f.queue.tick();
 assert.equal(f.sources.get(source.id).applied,3);assert.deepEqual(await fsp.readdir(f.directory),[]);
});

test('only an explicit takeover starts business writes and it resumes after a transient error plus restart',async t=>{
  const f=await fixture(t),source=await f.enqueue();await f.queue.tick();
  assert.equal(f.sources.get(source.id).applied,undefined);
  const accepted=await f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:1});
  assert.equal(accepted.background.phase,'applying');assert.equal(f.sources.get(source.id).applied,undefined);
  await assert.rejects(f.queue.assertIdle(source.id),{code:'IMPORT_SOURCE_BUSY'});
  assert.equal((await f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:1})).background.phase,'applying');
  f.state.beforeApply=()=>{if(f.sources.get(source.id).applied===1){
    const failure=require('../lib/persistence/postgresql/provider').mapPostgresqlError(new Error('Query read timeout'));
    require('../lib/data-import-errors').importFailure(failure);
  }};
  await f.queue.tick();assert.equal(f.sources.get(source.id).applied,1);
  assert.equal((await f.queue.overlay(source)).background.status,'retrying');
  await f.queue.stop();f.make();f.state.now+=30001;f.state.beforeApply=null;await f.queue.tick();
  assert.equal(f.sources.get(source.id).applied,3);assert.equal(f.sources.get(source.id).status,'applied');
  assert.deepEqual(await fsp.readdir(f.directory),[]);
});

test('takeover admission checks revision and current apply rights, and pause survives a completed packet',async t=>{
  const f=await fixture(t),source=await f.enqueue();await f.queue.tick();
  await assert.rejects(f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:2}),{code:'IMPORT_REVISION_CONFLICT'});
  f.state.principal={...session(),permissions:session().permissions.filter(p=>p!==P.APPLY)};
  await assert.rejects(f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:1}),{code:'IMPORT_FORBIDDEN'});
  f.state.principal=session();await f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:1});
  f.state.beforeApply=async()=>{await f.queue.action(f.getSession,source.id,'pause');};
  await f.queue.tick();assert.equal(f.sources.get(source.id).applied,1);assert.equal((await f.queue.overlay(source)).background.status,'paused');
  await f.queue.action(f.getSession,source.id,'retry');f.state.principal={...session(),permissions:[]};await f.queue.tick();
  assert.equal(f.sources.get(source.id).applied,1);assert.equal((await f.queue.overlay(source)).background.error,'IMPORT_FORBIDDEN');
});
test('timeout resumes automatically after process reconstruction and delay, without another upload',async t=>{
 const f=await fixture(t),source=await f.enqueue();f.state.failures=1;
 await f.queue.tick();assert.equal((await f.queue.overlay(source)).background.status,'retrying');
 assert.equal((await f.queue.overlay(source)).background.retries,1);await f.queue.stop();f.make();
 await f.queue.tick();assert.equal(f.state.calls,1);f.state.now+=30001;await f.queue.tick();
 assert.equal(f.state.calls,2);assert.equal(f.sources.get(source.id).status,'ready');assert.deepEqual(await fsp.readdir(f.directory),[]);
});

test('successive takeover packets reuse acknowledged progress and verify durable completion',async t=>{
 const f=await fixture(t),source=await f.enqueue();await f.queue.tick();
 await f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:1});
 const original=f.runtime.sourceOperation;let reads=0,applies=0;
 f.runtime.sourceOperation=async(get,id,action,input)=>{
  if(action==='read')reads++;
  if(action==='apply'){applies++;assert.equal(input.expectedRevision,f.sources.get(id).revision);}
  return original(get,id,action,input);
 };
 await f.queue.tick();assert.equal(applies,3);assert.equal(reads,2);
 assert.equal(f.sources.get(source.id).status,'applied');assert.deepEqual(await fsp.readdir(f.directory),[]);
});

test('reusing import progress never reuses a permission grant between packets',async t=>{
 const f=await fixture(t),source=await f.enqueue();await f.queue.tick();
 await f.queue.enqueueApply(f.getSession,source.id,{expectedRevision:1});
 const original=f.runtime.sourceOperation;
 f.runtime.sourceOperation=async(...args)=>{
  const result=await original(...args);
  if(args[2]==='apply')f.state.principal={...session(),permissions:session().permissions.filter(p=>p!==P.APPLY)};
  return result;
 };
 await f.queue.tick();assert.equal(f.sources.get(source.id).applied,1);
 assert.equal((await f.queue.overlay(source)).background.error,'IMPORT_FORBIDDEN');
});
test('retries are bounded and can be explicitly resumed with the retained encrypted file',async t=>{
 const f=await fixture(t),source=await f.enqueue();f.state.failures=4;
 for(let i=0;i<4;i++){await f.queue.tick();f.state.now+=600001;}
 assert.equal((await f.queue.overlay(source)).background.status,'failed');await f.queue.tick();assert.equal(f.state.calls,4);
 await f.queue.action(f.getSession,source.id,'retry');await f.queue.tick();assert.equal(f.state.calls,5);assert.equal(f.state.reviews,1);
});
test('invalid sources are not automatically retried and current rights are checked after logout-independent admission',async t=>{
 const f=await fixture(t),source=await f.enqueue();f.state.failures=1;f.state.failCode='IMPORT_SOURCE_SCHEMA_CHANGED';
 await f.queue.tick();f.state.now+=600001;await f.queue.tick();assert.equal(f.state.calls,1);assert.equal((await f.queue.overlay(source)).background.status,'failed');
 await f.queue.action(f.getSession,source.id,'retry');f.state.principal={...session(),permissions:[]};await f.queue.tick();
 assert.equal(f.state.calls,1);assert.equal((await f.queue.overlay(source)).background.error,'IMPORT_FORBIDDEN');
 await assert.rejects(f.queue.action(f.getSession,source.id,'retry'),{code:'IMPORT_FORBIDDEN'});
});
test('duplicate upload does not create another worker; another owner cannot resume or pause it',async t=>{
 const f=await fixture(t),source=await f.enqueue();assert.equal((await f.enqueue()).id,source.id);assert.equal((await fsp.readdir(f.directory)).length,2);
 await assert.rejects(f.queue.action(async()=>({...session(),employeeNumber:'other'}),source.id,'pause'),{code:'IMPORT_SOURCE_NOT_FOUND'});
 await f.queue.action(f.getSession,source.id,'pause');await f.queue.tick();assert.equal(f.state.calls,0);
 await f.queue.action(f.getSession,source.id,'retry');await f.queue.tick();assert.equal(f.state.calls,1);
});
test('shutdown waits for the acknowledged import stop and the next process continues the same job',async t=>{
 const f=await fixture(t),source=await f.enqueue();let entered,release;
 const started=new Promise(r=>entered=r),checkpoint=new Promise(r=>release=r);
 f.state.block=async signal=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await checkpoint;throw new C.DataImportError('IMPORT_SOURCE_INTERRUPTED',409);};
 const running=f.queue.tick();await started;let stopped=false;const stop=f.queue.stop().then(()=>stopped=true);await turn();assert.equal(stopped,false);
 release();await stop;await running;f.state.block=null;f.state.now+=3000;f.make();await f.queue.tick();
 assert.equal(f.sources.get(source.id).status,'ready');assert.equal(f.state.calls,2);
});
test('source integrity, retention and spool capacity fail closed',async t=>{
 const f=await fixture(t),source=await f.enqueue();const job=await f.store.read(source.id);
 const file=path.join(f.directory,job.blob.name),bytes=await fsp.readFile(file);bytes[0]^=1;await fsp.writeFile(file,bytes);
 await f.queue.tick();assert.equal((await f.queue.overlay(source)).background.error,'IMPORT_JOB_FILE_INVALID');assert.equal(f.state.calls,0);
 await assert.rejects(f.store.capacity(1,Array(6).fill(job)),{code:'IMPORT_JOB_QUEUE_FULL'});
 await assert.rejects(f.store.remove('../unrelated'),{code:'IMPORT_JOB_PATH_INVALID'});
 f.state.now+=RETENTION_MS+1;await f.queue.tick();assert.deepEqual(await fsp.readdir(f.directory),[]);
});
test('job envelopes cannot be exchanged and accepted state survives an immediate worker-free restart',async t=>{
 const f=await fixture(t),source=await f.enqueue();await f.queue.stop();
 const invalid=path.join(f.directory,'f'.repeat(64));await fsp.copyFile(path.join(f.directory,source.id),invalid);
 await assert.rejects(f.store.read('f'.repeat(64)));await fsp.unlink(invalid);
 f.make();await f.queue.tick();assert.equal(f.state.calls,1);assert.equal(f.sources.get(source.id).status,'ready');
});

test('encrypted source streaming preserves bytes across multiple chunks and removes an aborted temporary file',async t=>{
 const f=await fixture(t);await f.store.init();const input=crypto.randomBytes(2*1024*1024+4096),id='b'.repeat(64);
 const blob=await f.store.encrypt(id,input),restored=await f.store.decrypt(blob);
 assert.deepEqual(restored,input);restored.fill(0);await f.store.remove(blob.name);
 const controller=new AbortController();controller.abort();
 await assert.rejects(f.store.encrypt(id,input,controller.signal),{code:'IMPORT_SOURCE_INTERRUPTED'});
 assert.deepEqual(await fsp.readdir(f.directory),[]);input.fill(0);
});

test('upload admission prevents another large reader allocation and blocks starting during body transfer',async t=>{
 const f=await fixture(t);await f.enqueue();const release=f.queue.beginUpload();
 await f.queue.tick();assert.equal(f.state.calls,0);assert.throws(()=>f.queue.beginUpload(),{code:'IMPORT_SOURCE_BUSY'});release();release();
 let entered,finish;const started=new Promise(r=>entered=r),wait=new Promise(r=>finish=r);
 f.state.block=async()=>{entered();await wait;};const running=f.queue.tick();await started;
 assert.throws(()=>f.queue.beginUpload(),{code:'IMPORT_SOURCE_BUSY'});finish();await running;
});

test('an explicit pause survives a concurrent checkpoint and process reconstruction',async t=>{
 const f=await fixture(t),source=await f.enqueue();let entered,finish;
 const started=new Promise(r=>entered=r),wait=new Promise(r=>finish=r);
 f.state.block=async signal=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await wait;throw new C.DataImportError('IMPORT_SOURCE_INTERRUPTED',409);};
 const running=f.queue.tick();await started;await f.queue.action(f.getSession,source.id,'pause');finish();await running;
 await f.queue.stop();f.make();await f.queue.tick();assert.equal(f.state.calls,1);assert.equal((await f.queue.overlay(source)).background.status,'paused');
});

test('upload admission arriving during spool startup prevents the pending tick from starting a reader',async t=>{
 const f=await fixture(t);await f.enqueue();await f.queue.stop();f.make();
 const list=f.store.list;let release;const wait=new Promise(r=>release=r);
 f.store.list=async()=>{await wait;return list();};
 const running=f.queue.tick(),releaseUpload=f.queue.beginUpload();release();await running;
 assert.equal(f.state.calls,0);releaseUpload();await f.queue.tick();assert.equal(f.state.calls,1);
});

test('real encrypted import repository resumes committed rows and finishes review in the background',async t=>{
 const f=await fixture(t);
 const {openSqliteApplicationPersistence}=require('../lib/persistence/sqlite/provider');
 const {SQLITE_APPLICATION_CATALOG}=require('../lib/persistence/sqlite/application-catalog');
 const {ensureSqliteDataImportRuntimeSchema}=require('../lib/persistence/sqlite/operations/data-import-runtime-schema');
 const {createDataImportRuntime}=require('../lib/persistence/repositories/data-import-runtime');
 const {definitions,readTradeFotoFullSource}=require('../lib/tradefoto-full-import-source');
 const app=openSqliteApplicationPersistence({databasePath:':memory:',catalog:SQLITE_APPLICATION_CATALOG});ensureSqliteDataImportRuntimeSchema(app.database);
 const vault=createIntegrationSecretVault({activeKeyId:'test',keys:{test:Buffer.alloc(32,9)}});
 const defs=definitions('trade'),starts=[];let failure=true;
 const readSource=args=>readTradeFotoFullSource({...args,readerFactory:()=>({getTableNames:()=>defs.map(d=>d.name),getTable:name=>{
  const def=defs.find(d=>d.name===name),rows=name==='FILIALEN'?Array.from({length:401},(_,i)=>({FilialID:String(i+1)})):[];
  return {rowCount:rows.length,getColumnNames:()=>def.columns.map(c=>c.name),getColumns:()=>def.columns,
   getData:({columns,rowOffset=0,rowLimit=Infinity})=>rows.slice(rowOffset,rowOffset+rowLimit).map(row=>Object.fromEntries(columns.map(c=>[c,row[c]??null])))};
 }}),send:async message=>{if(message.type==='rows')starts.push(message.startRow);const ack=await args.onMessage(message);
  if(message.type==='rows'&&failure){failure=false;throw new C.DataImportError('IMPORT_SOURCE_READ_TIMEOUT',409);}return ack;}});
 const runtime=createDataImportRuntime({access:app.provider,vault,readSource}),jobs=createDataImportJobs({directory:path.join(path.dirname(f.directory),'real'),vault,runtime,
  lifecycle:createDataImportLifecycle(),resolvePrincipal:f.getSession,now:()=>f.state.now});
 t.after(async()=>{await jobs.stop();await runtime.stop();await app.provider.close();app.database.close();});
 const source=await jobs.enqueue(f.getSession,{buffer:sourceBuffer(),kind:'trade'});await jobs.tick();
 assert.equal((await runtime.sourceOperation(f.getSession,source.id,'read')).tables.find(t=>t.name==='FILIALEN').run.receivedRows,200);
 f.state.now+=30001;await jobs.tick();
 const result=await runtime.sourceOperation(f.getSession,source.id,'read');assert.ok(['ready','needs_review'].includes(result.status));
 assert.equal(result.complete,true);assert.deepEqual(starts,[1,201,401]);
 assert.equal(app.database.prepare('SELECT COUNT(*) n FROM data_import_rows').get().n,401);
 assert.equal(app.database.prepare('SELECT COUNT(*) n FROM import_master_records').get().n,0);
 assert.equal((await jobs.overlay(result)).background,undefined);
});
