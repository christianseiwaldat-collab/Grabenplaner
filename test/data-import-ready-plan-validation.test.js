'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{Module}=require('node:module');
const repo=fs.realpathSync(process.env.GP_IMPORT_CANDIDATE_ROOT||path.resolve(__dirname,'..')),req=name=>require(path.join(repo,name));
function compileAs(filename,text,override){const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const real=m.require.bind(m);m.require=name=>override?.(name,real)||real(name);m._compile(text,filename);return m.exports;}
const enginePath=path.join(repo,'lib/data-import-engine.js'),prototype=req('lib/data-import-engine');
const { withImportFixture, withFixture, nativeImport } = require('../test-support/data-import-known-af-fixture');
const C=req('lib/data-import-contract'),runtimePath=path.join(repo,'lib/persistence/repositories/data-import-runtime.js'),runtimeSource=fs.readFileSync(runtimePath,'utf8');
const helperStart=runtimeSource.indexOf('async function advanceReadyValidation('),helperEnd=runtimeSource.indexOf('// One bounded reader per app process.',helperStart);
assert(helperStart>0&&helperEnd>helperStart,'The installed private runtime helper must be tested');
const {advanceReadyValidation}=compileAs(runtimePath,'const C=require("../../data-import-contract");\n'+runtimeSource.slice(helperStart,helperEnd)+'\nmodule.exports={advanceReadyValidation};');
const HASH='a'.repeat(64);
function profileInput(overrides = {}) {
  return { id: "synthetic-import", version: 1, entity: "synthetic-item", sourceSystem: "synthetic-source", schemaSha256: HASH, sourceTable: "SyntheticRows",
    keyFields: ["Number"], excludedFields: ["Kennwort"], dataClasses: ["customer_restricted"],
    fields: [
      { source: "Number", target: "number", type: "identifier", nullable: false },
      { source: "Label", target: "label", type: "text", nullable: false },
      { source: "Amount", target: "amount", type: "decimal", scale: 4, nullable: false },
      { source: "Memo", target: null, type: "text", nullable: true },
    ], ...overrides };
}
function sourceRow(number = "000152", overrides = {}) { return { Number: number, Label: "Synthetischer Artikel", Amount: "12.5", Memo: null, Kennwort: "never-persist-this", ...overrides }; }
const eligible=C.defineDataImportProfile(profileInput({sourceSystem:'tradefoto.bestell'}));
const row=(n,extra={})=>sourceRow(String(n),extra),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function nativeTest(name, work) { test(name, nativeImport, t => withImportFixture(storage => work(t, storage))); }
function fixture(t, storage, {profile=eligible}={}) {
  const protection=req('lib/data-import-protection').createDataImportProtection({ encryptionKey: Buffer.alloc(32,7), indexKey: Buffer.alloc(32,9), keyId:'ready-plan-test' });
  t.after(() => protection.destroy());
  const repository=req('lib/persistence/repositories/data-import').createDataImportRepository(storage.provider);
  const context={who:{scopeId:crypto.randomUUID(),ownerId:'synthetic-owner'},denied:new Set(),time:'2026-09-05T10:00:00.000Z'};
  // A synthetic writer observes whether validation reaches the business write.
  // Runs, ciphertext, cursor state and revision checks use PostgreSQL.
  const targetsById=new Map();
  const read=(_tx,id)=>targetsById.get(id)||null;
  const update=(tx,{id,expectedRevision,data})=>{
    assert.equal(read(tx,id).revision,expectedRevision);
    const target={id,revision:expectedRevision+1,data}; targetsById.set(id,target); return target;
  };
  const writer={
    read,findExisting:(_tx,record)=>[...targetsById.values()].filter(target=>target.data.number===record.data.number),
    create:(_tx,{id,data})=>{ const target={id,revision:1,data}; targetsById.set(id,target); return target; },
    update,restore:update,canRestore:()=>true,canRemove:()=>true,remove:(_tx,{id})=>targetsById.delete(id),
  };
  const composition={repository,protection,profiles:[profile],writers:{[profile.entity]:writer},getActor:()=>context.who,
    authorize:({action})=>!context.denied.has(action),clock:()=>context.time};
  const engine=prototype.createDataImportEngine(composition);
  const manifest=(count,extra={})=>({sourceInstance:'synthetic-ledger',fileSha256:HASH,schemaSha256:profile.schemaSha256,
    expectedRows:count,declaredRows:count,snapshotAt:context.time,gates:[],...extra});
  const f={...storage,composition,context,engine,manifest,profile,protection,repository,writer,sourceState:{revision:1},
    targets:()=>[...targetsById.values()],ready:(rows,extra)=>ready(engine,f,rows,extra)};
  return f;
}
const readRows=async(db,sql,params=[]) => (await db.query(sql,params)).rows;
const readRow=async(db,sql,params=[]) => (await readRows(db,sql,params))[0];
function binding(f,cursor=null,fileSha256='a'.repeat(64)){const revision=f.sourceState.revision;return {sourceId:'d'.repeat(64),sourceRevision:revision,fileSha256,cursor,sourceGuard:async()=>{if(f.sourceState.revision!==revision)C.fail('IMPORT_CONCURRENT_CHANGE',409);}};}
async function originalRows(f,run){return sha(JSON.stringify({rows:(await readRows(f.sales, "SELECT * FROM integration.data_import_rows WHERE run_id=$1 ORDER BY row_number", [run.id])),refs:(await readRows(f.sales, "SELECT * FROM integration.data_import_row_payload_refs WHERE run_id=$1 ORDER BY row_number,slot", [run.id])),blocks:(await readRows(f.sales, "SELECT * FROM integration.data_import_payload_blocks ORDER BY id"))}));}
async function business(f,run){return {targets:f.targets(),changes:(await readRow(f.sales, "SELECT count(*)::integer n FROM integration.data_import_changes WHERE run_id=$1", [run.id])).n};}
async function step(e,f,run,cursor=null,file='a'.repeat(64)){const result=await e.validateReadyPlans(run.id,run.revision,binding(f,cursor,file));if(result)f.sourceState.revision++;return result;}
async function ready(e,f,rows,extra={}){let r=await e.start({profileHash:f.profile.fingerprint,manifest:f.manifest(rows.length,extra)});for(let from=0;from<rows.length;from+=200)r=await e.stage(r.id,{expectedRevision:r.revision,startRow:from+1,rows:rows.slice(from,from+200)});r=await e.seal(r.id,r.revision);do{r=await e.review(r.id,r.revision);}while(r.status==='reviewing');return r;}

nativeTest('all rows validate before first business write without ciphertext or refs changes',async (t,storage)=>{
 const f=fixture(t,storage),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:2,sharedPayloads:true}),run=await ready(e,f,Array.from({length:5},(_,n)=>row(n+1))),before=await originalRows(f,run);let p=null;
 for(const expected of [2,4,5]){p=await step(e,f,run,p?.cursor);assert.equal(p.verifiedRows,expected);assert.equal(f.targets().length,0);assert.equal(await originalRows(f,run),before);assert.equal(p.run.revision,run.revision);}
 assert.equal(p.complete,true);const applied=await e.apply(run.id,run.revision,{readyValidation:binding(f,p.cursor)});assert.equal(applied.counts.applied,2);
});
nativeTest('a conflict already present at row 500 is found globally before any business writes',async (t,storage)=>{
 const f=fixture(t,storage);let first=await f.ready(Array.from({length:500},(_,n)=>row(n+1)));do{first=await f.engine.apply(first.id,first.revision);}while(first.status==='applying');
 const run=await f.ready(Array.from({length:500},(_,n)=>row(n+1,{Label:'Incoming'})),{fileSha256:'b'.repeat(64)}),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:200});
 const target=f.targets().find(r=>r.data.number==='500');f.writer.update(null,{id:target.id,expectedRevision:target.revision,data:{...target.data,label:'Manual'}});const before=await business(f,run),cipher=await originalRows(f,run);
 let p=await step(e,f,run,null,'b'.repeat(64));p=await step(e,f,run,p.cursor,'b'.repeat(64));await assert.rejects(step(e,f,run,p.cursor,'b'.repeat(64)),error=>error.code==='IMPORT_READY_PLAN_CHANGED');assert.deepEqual(await business(f,run),before);assert.equal(await originalRows(f,run),cipher);
});
nativeTest('the coordinator refreshes every stale create plan with current dependencies before business writes',async (t,storage)=>{
 const f=fixture(t,storage),versions={1:1,2:1,3:1,4:1,5:1},fusionReads=[];let inFusion=false;
 f.writer.review=async(_tx,record)=>{if(inFusion)fusionReads.push({number:Number(record.data.number),version:versions[record.data.number]});return {issue:'',token:C.fingerprint(versions[record.data.number]),rewrite:false};};
 const run=await f.ready([1,2,3,4,5].map(n=>row(n))),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:2});versions[5]=2;
 let progress=null,current=run,fusionCalls=0;
 const wrapped={...e,recheck:async(...args)=>{assert.equal(f.targets().length,0);return e.recheck(...args);},recheckAndReviewCreatePlans:async(...args)=>{assert.equal(f.targets().length,0);fusionCalls++;inFusion=true;try{return await e.recheckAndReviewCreatePlans(...args);}finally{inFusion=false;}}};
 for(let n=0;n<3;n++){const result=await advanceReadyValidation(wrapped,{run:current},progress,binding(f));current=result.run;progress=result.progress;f.sourceState.revision++;}
 assert(fusionCalls>0,'The eligible stale-create case must execute the actual fusion path');assert.equal(progress.fusion,true);assert.equal(progress.fallback,true);assert.equal(current.counts.staged,1);assert.equal(f.targets().length,0);
 await assert.rejects(e.apply(current.id,current.revision),e=>e.code==='IMPORT_PREVIEW_INCOMPLETE');assert.equal(f.targets().length,0,'The real reservation blocks apply before the complete fresh plan pass');
 for(let n=0;progress!==null;n++){assert(n<10);const result=await advanceReadyValidation(wrapped,{run:current},progress,binding(f));current=result.run;progress=result.progress;f.sourceState.revision++;assert.equal(f.targets().length,0);if(progress){assert.equal(progress.fusion,true);assert.equal(current.counts.staged,1);}}
 assert.equal(current.status,'ready');assert.equal(current.counts.create,5);assert.equal(current.counts.staged,undefined);assert.deepEqual(fusionReads,[1,2,3,4,5].map(number=>({number,version:number===5?2:1})),'Every plan, including the stale dependency at5, must be recomputed from current writer evidence');
 while(current.status!=='applied')current=await e.apply(current.id,current.revision);assert.equal(current.counts.applied,5);assert.equal(f.targets().length,5);
});

nativeTest('run revision changes invalidate an authenticated cursor without writing targets',async (t,storage)=>{
 const f=fixture(t,storage),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:1}),run=await f.ready([row(1),row(2)]),p=await step(e,f,run);
 await f.sales.query("UPDATE integration.data_import_runs SET revision=revision+1 WHERE id=$1", [run.id]);const fresh=await e.checkpoint(run.id);
 await assert.rejects(step(e,f,fresh,p.cursor),error=>error.code==='IMPORT_READY_CURSOR_STALE');assert.equal(f.targets().length,0);
});
nativeTest('source revision changes invalidate old progress while an in-flight source CAS race remains an error',async (t,storage)=>{
 const f=fixture(t,storage),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:1}),run=await f.ready([row(1),row(2)]),p=await step(e,f,run);f.sourceState.revision++;
 await assert.rejects(step(e,f,run,p.cursor),error=>error.code==='IMPORT_READY_CURSOR_STALE');const staleBinding=binding(f);f.sourceState.revision++;
 await assert.rejects(e.validateReadyPlans(run.id,run.revision,staleBinding),error=>error.code==='IMPORT_CONCURRENT_CHANGE');assert.equal(f.targets().length,0);
});
nativeTest('partial, tampered, foreign and replayed completion tokens never authorize a blank first apply',async (t,storage)=>{
 const f=fixture(t,storage),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:1}),run=await f.ready([row(1),row(2)]),p=await step(e,f,run);
 await assert.rejects(e.apply(run.id,run.revision,{readyValidation:binding(f,p.cursor)}),error=>error.code==='IMPORT_READY_CURSOR_STALE');
 await assert.rejects(step(e,f,run,p.cursor+'!'));await assert.rejects(e.validateReadyPlans(run.id,run.revision,{...binding(f,p.cursor),sourceId:'e'.repeat(64)}));assert.equal(f.targets().length,0);
 const done=await step(e,f,run,p.cursor),applied=await e.apply(run.id,run.revision,{readyValidation:binding(f,done.cursor)});f.sourceState.revision++;
 await assert.rejects(e.apply(applied.id,applied.revision,{readyValidation:binding(f,done.cursor)}),error=>error.code==='IMPORT_READY_CURSOR_STALE');assert.equal(f.targets().length,1);
});
nativeTest('real transaction counts, not stale cached creates, exclude all mixed/incomplete state cases',async (t,storage)=>{
 for(const state of ['staged','invalid','conflict','unchanged','applied','reverted','duplicate']){const f=fixture(t,storage),run=await f.ready([row(1)]);await f.sales.query("UPDATE integration.data_import_rows SET state=$1 WHERE run_id=$2", [state, run.id]);assert.equal(await step(f.engine,f,run),null);assert.equal(f.targets().length,0);}
});
nativeTest('snapshot writers and other source systems retain the old full path',async (t,storage)=>{
 const f=fixture(t,storage),run=await f.ready([row(1)]),writer={...f.writer,recordSnapshotRows:async()=>{},finishSnapshot:async()=>{},withdrawSnapshot:async()=>{}},e=prototype.createDataImportEngine({...f.composition,writers:{[f.profile.entity]:writer}});assert.equal(await step(e,f,run),null);
 const g=fixture(t,storage,{profile:C.defineDataImportProfile(profileInput())});g.sourceState={revision:1};const other=await g.ready([row(2)]);assert.equal(await step(g.engine,g,other),null);
});
nativeTest('read/review/apply permission, expiry and exact proof errors never become validation fallback',async (t,storage)=>{
 for(const action of ['read','review','apply']){const f=fixture(t,storage),run=await f.ready([row(1)]);f.context.denied.add(action);await assert.rejects(step(f.engine,f,run),error=>error.code==='IMPORT_FORBIDDEN');assert.equal(f.targets().length,0);}
 const f=fixture(t,storage),run=await f.ready([row(1)]);f.context.time='2099-01-01T00:00:00.000Z';await assert.rejects(step(f.engine,f,run),error=>error.code==='IMPORT_RUN_EXPIRED');
 const g=fixture(t,storage),blocked=await g.ready([row(2)],{declaredRows:2});await g.sales.query("UPDATE integration.data_import_runs SET status='ready' WHERE id=$1", [blocked.id]);await assert.rejects(step(g.engine,g,blocked),error=>error.code==='IMPORT_DECISION_GATE');
});
test('integrity, CAS and arbitrary errors propagate rather than being converted into a full recheck',async()=>{
 for(const code of ['IMPORT_CONCURRENT_CHANGE','IMPORT_REVISION_CONFLICT','IMPORT_FORBIDDEN','IMPORT_ROW_INTEGRITY','IMPORT_READY_CURSOR_INTEGRITY','IMPORT_SOURCE_INTEGRITY','IMPORT_WRITER_CONTRACT','IMPORT_OPERATION_FAILED']){let calls=0;const e={validateReadyPlans:async()=>C.fail(code,409),recheck:async()=>{calls++;}};await assert.rejects(advanceReadyValidation(e,{run:{id:'a'.repeat(64),revision:1}},null,{}),error=>error.code===code);assert.equal(calls,0);}
});
nativeTest('ordinal gaps and authenticated-plan corruption are detected without rewriting source rows',async (t,storage)=>{
 const f=fixture(t,storage),run=await f.ready([row(1),row(2)]);await f.sales.query("UPDATE integration.data_import_rows SET row_number=3 WHERE run_id=$1 AND row_number=2", [run.id]);const before=await originalRows(f,run);await assert.rejects(step(f.engine,f,run),error=>error.code==='IMPORT_ROW_INTEGRITY');assert.equal(await originalRows(f,run),before);assert.equal(f.targets().length,0);
});
nativeTest('large legitimate run/source revision values remain supported across cursor checkpoints',async (t,storage)=>{
 const f=fixture(t,storage),run=await f.ready([row(1),row(2)]);await f.sales.query("UPDATE integration.data_import_runs SET revision=2000001 WHERE id=$1", [run.id]);f.sourceState.revision=2000001;const e=prototype.createDataImportEngine({...f.composition,operationBatchSize:1}),fresh=await e.checkpoint(run.id),p=await step(e,f,fresh),done=await step(e,f,fresh,p.cursor);assert.equal(done.complete,true);assert.equal(f.targets().length,0);
});
test('the real source runtime persists and resumes the private cursor through reconstruction without leaking it',nativeImport,async()=>{
 let f;const trace=[];const instrumented={createDataImportEngine:options=>{const e=prototype.createDataImportEngine({...options,operationBatchSize:2});return Object.freeze({...e,validateReadyPlans:async(...args)=>{const r=await e.validateReadyPlans(...args);if(r){assert.equal((await readRow(f.sales, "SELECT count(*)::integer n FROM integration.import_history_records WHERE source_table='BESTELLUNGEN'")).n,0);trace.push({id:args[0],n:r.verifiedRows,done:r.complete});}return r;},apply:async(...args)=>{if(args[2]?.readyValidation)assert.equal(trace.filter(x=>x.id===args[0]).at(-1).done,true);return e.apply(...args);}});}};
 const runtimePath=path.join(repo,'lib/persistence/repositories/data-import-runtime.js'),runtime=compileAs(runtimePath,fs.readFileSync(runtimePath,'utf8'),name=>name==='../../data-import-engine'?instrumented:null);
 const table=req('lib/tradefoto-bestell/profiles').tableFor('BESTELLUNGEN'),rows=[1,2,3,4,5].map(n=>({...Object.fromEntries(table.columns.map(c=>[c.name,null])),BestellNr:n}));
 await withFixture({kind:'bestell',values:{BESTELLUNGEN:rows},runtimeFactory:runtime.createDataImportRuntime},async storage=>{f=storage;let source=await f.upload();source=await f.finish(source,'review');const id=source.tables.find(x=>x.name==='BESTELLUNGEN').run.id;
 let n=0;while(source.status!=='applied'){f.reload();source=await f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision});assert.equal(source.readyPlanValidation,undefined);assert.ok(++n<250);}
 assert.deepEqual(trace.filter(x=>x.id===id).map(x=>x.n),[2,4,5]);assert.equal(source.tables.find(x=>x.name==='BESTELLUNGEN').run.counts.applied,5);
 });
});

const engineText=fs.readFileSync(enginePath,'utf8').replaceAll('\r\n','\n');
const masterTradeProfile=C.defineDataImportProfile(profileInput({sourceSystem:'tradefoto.master-data'}));
function tradeFixture(t,storage){return fixture(t,storage,{profile:masterTradeProfile});}
nativeTest('Trade master producing plans validate all 501 ordinals before any target write, without changing encrypted rows or refs',async (t,storage)=>{
 const f=tradeFixture(t,storage),run=await f.ready(Array.from({length:501},(_,i)=>row(i+1))),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:200}),before=await originalRows(f,run);let p=null;
 for(const count of [200,400,501]){p=await step(e,f,run,p?.cursor);assert.equal(p.verifiedRows,count);assert.equal(f.targets().length,0);assert.equal(await originalRows(f,run),before);assert.equal(p.run.revision,run.revision);}
 assert.equal(p.complete,true);const applied=await e.apply(run.id,run.revision,{readyValidation:binding(f,p.cursor)});assert.equal(applied.counts.applied,200);
});
nativeTest('Trade late dependency change at row500 refreshes all501 plans and keeps the real reservation before business writes',async (t,storage)=>{
 const f=tradeFixture(t,storage),versions=new Map(Array.from({length:501},(_,i)=>[String(i+1),1])),fresh=[];let inFusion=false;
 f.writer.review=async(_tx,record)=>{if(inFusion)fresh.push({number:Number(record.data.number),version:versions.get(record.data.number)});return {issue:'',token:C.fingerprint(versions.get(record.data.number)),rewrite:false};};
 let run=await f.ready(Array.from({length:501},(_,i)=>row(i+1)));const e=prototype.createDataImportEngine({...f.composition,operationBatchSize:200}),wrapped={...e,recheckAndReviewCreatePlans:async(...args)=>{inFusion=true;try{return await e.recheckAndReviewCreatePlans(...args);}finally{inFusion=false;}}};
 const reserve=async()=>sha(JSON.stringify({row:(await readRow(f.sales, "SELECT payload FROM integration.data_import_rows WHERE run_id=$1 AND row_number=501", [run.id])),refs:(await readRows(f.sales, "SELECT slot,block_id FROM integration.data_import_row_payload_refs WHERE run_id=$1 AND row_number=501 ORDER BY slot", [run.id]))}));
 async function records(){const store=req('lib/data-import-payload-store').createDataImportPayloadStore({protection:f.protection});return f.repository.atomic(async tx=>{const header=await tx.getRun({id:run.id,...f.context.who}),rows=await tx.listRows({runId:run.id,after:0,limit:1000});await tx.prepareRead?.(run.id,rows);const values=await Promise.all(rows.map(row=>store.decode(tx,{run:header,profile:f.profile,row,kind:'row'})));return C.canonical(values.map(v=>v.record));},{readOnly:true});}
 const originalRecords=await records(),reserved=await reserve();let p=await step(e,f,run);p=await step(e,f,run,p.cursor);versions.set('500',2);
 const validationEvidence=await originalRows(f,run);wrapped.validateReadyPlans=async(...args)=>{try{return await e.validateReadyPlans(...args);}catch(error){assert.equal(await originalRows(f,run),validationEvidence,'The failed validation-only pass preserves every ciphertext, block and shared ref before replanning');throw error;}};
 let current=await advanceReadyValidation(wrapped,{run},{runId:run.id,cursor:p.cursor,complete:false},binding(f));f.sourceState.revision++;
 assert.equal(current.progress.fusion,true);assert.equal(current.progress.fallback,true);assert.equal(current.run.counts.staged,1);assert.equal(current.run.counts.create,500);assert.equal(f.targets().length,0);assert.equal(await reserve(),reserved,'The still-unprocessed real last row retains exact ciphertext and shared refs');
 await assert.rejects(e.apply(current.run.id,current.run.revision),e=>e.code==='IMPORT_PREVIEW_INCOMPLETE');assert.equal(f.targets().length,0);
 for(let n=0;current.progress!==null;n++){assert(n<10);current=await advanceReadyValidation(wrapped,{run:current.run},current.progress,binding(f));f.sourceState.revision++;assert.equal(f.targets().length,0);if(current.progress){assert.equal(current.progress.fusion,true);assert.equal(current.run.counts.staged,1);assert.equal(await reserve(),reserved);}}
 assert.equal(current.run.status,'ready');assert.equal(current.run.counts.create,501);assert.equal(current.run.counts.staged,undefined);assert.deepEqual(fresh,Array.from({length:501},(_,i)=>({number:i+1,version:i===499?2:1})),'All501 plans must use current dependency evidence, including changed row500');assert.equal(await records(),originalRecords,'Replanning may replace plan ciphertext, never original source/data/key records');
});
nativeTest('snapshot admission is only exact current AFv2 with all three original hooks; AFv1 and every unknown snapshot remain excluded',async (t,storage)=>{
 const H=req('lib/tradefoto-history-profiles'),M=req('lib/tradefoto-master-profiles');
 const factory=compileAs(enginePath,engineText.replace('  const engine = {','  const engine = { __pendingReady:pendingReady,')).createDataImportEngine;
 const f=fixture(t,storage),e=factory(f.composition),run={status:'ready',receivedCount:501,manifest:{expectedRows:501}};
 const hooks={recordSnapshotRows:async()=>{},finishSnapshot:async()=>{},withdrawSnapshot:async()=>{}},af=H.profileFor('trade','ARTIKEL_FILIALEN');
 assert.equal(af.fingerprint,'6f0b0798b089440320a755b9999334aad7ef858a28cb1efacf2e63437eb52a41');
 for(const counts of [{create:501},{update:501},{refresh:501},{create:200,update:200,refresh:101}])assert.equal(await e.__pendingReady(run,af,hooks,counts),true);
 assert.equal(await e.__pendingReady(run,af,{}, {create:501}),false);
 for(const name of Object.keys(hooks)){const partial={...hooks};delete partial[name];assert.equal(await e.__pendingReady(run,af,partial,{create:501}),false);}
 assert.equal(await e.__pendingReady(run,H.profilesFor('trade','ARTIKEL_FILIALEN')[1],{}, {create:501}),false);
 assert.equal(await e.__pendingReady(run,M.profileFor('KUNDEN'),hooks,{create:501}),false);
 assert.equal(await e.__pendingReady(run,H.profileFor('trade','Shopware_Artikel'),hooks,{create:501}),false);
 assert.equal(await e.__pendingReady(run,M.profileFor('KUNDEN'),{}, {create:501}),true);
 assert.equal(await e.__pendingReady(run,H.profileFor('trade','Shopware_Artikel'),{}, {create:501}),true);
 for(const state of ['staged','unchanged','invalid','conflict','duplicate','applied','reverted'])assert.equal(await e.__pendingReady(run,af,hooks,{create:500,[state]:1}),false);
 for(const status of ['reviewing','needs_review','applying','applied','reverted'])assert.equal(await e.__pendingReady({...run,status},af,hooks,{create:501}),false);
 assert.equal(await e.__pendingReady({...run,receivedCount:500},af,hooks,{create:501}),false);
 assert.equal(await e.__pendingReady({...run,receivedCount:0,manifest:{expectedRows:0}},af,hooks,{}),false);
});
nativeTest('other producing source families remain outside this explicit Trade/Bestell extension',async (t,storage)=>{
 for(const system of ['tradefoto.history.cash','tradefoto.weum','tradefoto.inventur','tradefoto.lieferantenrechnungen','synthetic-unknown']){
  const profile=C.defineDataImportProfile(profileInput({sourceSystem:system})),f=fixture(t,storage,{profile});f.sourceState={revision:1};const run=await f.ready([row(1)]);
  assert.equal(await step(f.engine,f,run),null);assert.equal(f.targets().length,0);
 }
});
test('actual Trade runtime uses the same private complete-cursor pass for a current master profile',nativeImport,async()=>{
 let f;const trace=[];
 const instrumented={createDataImportEngine:options=>{const e=prototype.createDataImportEngine({...options,operationBatchSize:2});return Object.freeze({...e,
  validateReadyPlans:async(...args)=>{const r=await e.validateReadyPlans(...args);if(r){assert.equal((await readRow(f.sales, "SELECT count(*)::integer n FROM trade.import_master_records WHERE source_table='KUNDEN'")).n,0);trace.push({id:args[0],n:r.verifiedRows,done:r.complete});}return r;},
  apply:async(...args)=>{if(args[2]?.readyValidation)assert.equal(trace.filter(x=>x.id===args[0]).at(-1).done,true);return e.apply(...args);}});}};
 const runtimePath=path.join(repo,'lib/persistence/repositories/data-import-runtime.js'),runtime=compileAs(runtimePath,fs.readFileSync(runtimePath,'utf8'),name=>name==='../../data-import-engine'?instrumented:null);
 const M=req('lib/tradefoto-master-profiles'),table=M.tableFor('KUNDEN'),rows=[1,2,3,4,5].map(n=>({...Object.fromEntries(table.columns.map(c=>[c.name,null])),KUND_NR:String(n),NACHNAME:'Synthetic '+n}));
 await withFixture({kind:'trade',values:{KUNDEN:rows},runtimeFactory:runtime.createDataImportRuntime},async storage=>{f=storage;let source=await f.upload();source=await f.finish(source,'review');const id=source.tables.find(t=>t.name==='KUNDEN').run.id;
 for(let i=0;source.status!=='applied';i++){assert.ok(i<500);f.reload();source=await f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision});assert.equal(source.readyPlanValidation,undefined);}
 assert.deepEqual(trace.filter(x=>x.id===id).map(x=>x.n),[2,4,5]);assert.equal(source.tables.find(t=>t.name==='KUNDEN').run.counts.applied,5);
 });
});
