'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{Module}=require('node:module');
const repo=fs.realpathSync(process.env.GP_IMPORT_CANDIDATE_ROOT||path.resolve(__dirname,'..')),req=name=>require(path.join(repo,name));
function compileAs(filename,text,override){const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const real=m.require.bind(m);m.require=name=>override?.(name,real)||real(name);m._compile(text,filename);return m.exports;}
const enginePath=path.join(repo,'lib/data-import-engine.js'),prototype=req('lib/data-import-engine');
const fixturePath=path.join(repo,'test/data-import-foundation.test.js'),fixtureText=fs.readFileSync(fixturePath,'utf8'),cut=fixtureText.indexOf("test('Small import transactions");assert(cut>0);
const F=compileAs(fixturePath,fixtureText.slice(0,cut)+'\nmodule.exports={fixture,sourceRow,profileInput};',name=>name==='../lib/data-import-engine'?prototype:null);
const C=req('lib/data-import-contract'),runtimePath=path.join(repo,'lib/persistence/repositories/data-import-runtime.js'),runtimeSource=fs.readFileSync(runtimePath,'utf8');
const helperStart=runtimeSource.indexOf('async function advanceReadyValidation('),helperEnd=runtimeSource.indexOf('// One bounded reader per app process.',helperStart);
assert(helperStart>0&&helperEnd>helperStart,'The installed private runtime helper must be tested');
const {advanceReadyValidation}=compileAs(runtimePath,'const C=require("../../data-import-contract");\n'+runtimeSource.slice(helperStart,helperEnd)+'\nmodule.exports={advanceReadyValidation};');
const eligible=C.defineDataImportProfile(F.profileInput({sourceSystem:'tradefoto.bestell'}));
const row=(n,extra={})=>F.sourceRow(String(n),extra),sha=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t,options={}){const f=await F.fixture(t,{profile:eligible,...options});f.sourceState={revision:1};return f;}
function binding(f,cursor=null,fileSha256='a'.repeat(64)){const revision=f.sourceState.revision;return {sourceId:'d'.repeat(64),sourceRevision:revision,fileSha256,cursor,sourceGuard:async()=>{if(f.sourceState.revision!==revision)C.fail('IMPORT_CONCURRENT_CHANGE',409);}};}
function originalRows(f,run){return sha(JSON.stringify({rows:f.database.prepare('SELECT * FROM data_import_rows WHERE run_id=? ORDER BY row_number').all(run.id),refs:f.database.prepare('SELECT * FROM data_import_row_payload_refs WHERE run_id=? ORDER BY row_number,slot').all(run.id),blocks:f.database.prepare('SELECT * FROM data_import_payload_blocks ORDER BY id').all()}));}
function business(f,run){return {targets:f.targets(),changes:f.database.prepare('SELECT count(*) n FROM data_import_changes WHERE run_id=?').get(run.id).n};}
async function step(e,f,run,cursor=null,file='a'.repeat(64)){const result=await e.validateReadyPlans(run.id,run.revision,binding(f,cursor,file));if(result)f.sourceState.revision++;return result;}
async function complete(e,f,run,file='a'.repeat(64)){let result=null,n=0;do{result=await step(e,f,run,result?.cursor||null,file);assert(result);assert.ok(++n<100);}while(!result.complete);return result;}
async function ready(e,f,rows,extra={}){let r=await e.start({profileHash:f.profile.fingerprint,manifest:f.manifest(rows.length,extra)});for(let from=0;from<rows.length;from+=200)r=await e.stage(r.id,{expectedRevision:r.revision,startRow:from+1,rows:rows.slice(from,from+200)});r=await e.seal(r.id,r.revision);do{r=await e.review(r.id,r.revision);}while(r.status==='reviewing');return r;}

test('all rows validate before first business write without ciphertext or refs changes',async t=>{
 const f=await fixture(t),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:2,sharedPayloads:true}),run=await ready(e,f,Array.from({length:5},(_,n)=>row(n+1))),before=originalRows(f,run);let p=null;
 for(const expected of [2,4,5]){p=await step(e,f,run,p?.cursor);assert.equal(p.verifiedRows,expected);assert.equal(f.targets().length,0);assert.equal(originalRows(f,run),before);assert.equal(p.run.revision,run.revision);}
 assert.equal(p.complete,true);const applied=await e.apply(run.id,run.revision,{readyValidation:binding(f,p.cursor)});assert.equal(applied.counts.applied,2);
});
test('a conflict already present at row 500 is found globally before any business writes',async t=>{
 const f=await fixture(t);let first=await f.ready(Array.from({length:500},(_,n)=>row(n+1)));do{first=await f.engine.apply(first.id,first.revision);}while(first.status==='applying');
 const run=await f.ready(Array.from({length:500},(_,n)=>row(n+1,{Label:'Incoming'})),{fileSha256:'b'.repeat(64)}),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:200});
 const target=f.targets().find(r=>r.number==='500');f.database.prepare('UPDATE import_fixture SET revision=revision+1,data=? WHERE id=?').run(JSON.stringify({...target.data,label:'Manual'}),target.id);const before=business(f,run),cipher=originalRows(f,run);
 let p=await step(e,f,run,null,'b'.repeat(64));p=await step(e,f,run,p.cursor,'b'.repeat(64));await assert.rejects(step(e,f,run,p.cursor,'b'.repeat(64)),error=>error.code==='IMPORT_READY_PLAN_CHANGED');assert.deepEqual(business(f,run),before);assert.equal(originalRows(f,run),cipher);
});
test('the coordinator refreshes every stale create plan with current dependencies before business writes',async t=>{
 const f=await fixture(t),versions={1:1,2:1,3:1,4:1,5:1},fusionReads=[];let inFusion=false;
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

test('run revision changes invalidate an authenticated cursor without writing targets',async t=>{
 const f=await fixture(t),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:1}),run=await f.ready([row(1),row(2)]),p=await step(e,f,run);
 f.database.prepare('UPDATE data_import_runs SET revision=revision+1 WHERE id=?').run(run.id);const fresh=await e.checkpoint(run.id);
 await assert.rejects(step(e,f,fresh,p.cursor),error=>error.code==='IMPORT_READY_CURSOR_STALE');assert.equal(f.targets().length,0);
});
test('source revision changes invalidate old progress while an in-flight source CAS race remains an error',async t=>{
 const f=await fixture(t),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:1}),run=await f.ready([row(1),row(2)]),p=await step(e,f,run);f.sourceState.revision++;
 await assert.rejects(step(e,f,run,p.cursor),error=>error.code==='IMPORT_READY_CURSOR_STALE');const staleBinding=binding(f);f.sourceState.revision++;
 await assert.rejects(e.validateReadyPlans(run.id,run.revision,staleBinding),error=>error.code==='IMPORT_CONCURRENT_CHANGE');assert.equal(f.targets().length,0);
});
test('partial, tampered, foreign and replayed completion tokens never authorize a blank first apply',async t=>{
 const f=await fixture(t),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:1}),run=await f.ready([row(1),row(2)]),p=await step(e,f,run);
 await assert.rejects(e.apply(run.id,run.revision,{readyValidation:binding(f,p.cursor)}),error=>error.code==='IMPORT_READY_CURSOR_STALE');
 await assert.rejects(step(e,f,run,p.cursor+'!'));await assert.rejects(e.validateReadyPlans(run.id,run.revision,{...binding(f,p.cursor),sourceId:'e'.repeat(64)}));assert.equal(f.targets().length,0);
 const done=await step(e,f,run,p.cursor),applied=await e.apply(run.id,run.revision,{readyValidation:binding(f,done.cursor)});f.sourceState.revision++;
 await assert.rejects(e.apply(applied.id,applied.revision,{readyValidation:binding(f,done.cursor)}),error=>error.code==='IMPORT_READY_CURSOR_STALE');assert.equal(f.targets().length,1);
});
test('real transaction counts, not stale cached creates, exclude all mixed/incomplete state cases',async t=>{
 for(const state of ['staged','invalid','conflict','unchanged','applied','reverted','duplicate']){const f=await fixture(t),run=await f.ready([row(1)]);f.database.prepare('UPDATE data_import_rows SET state=? WHERE run_id=?').run(state,run.id);assert.equal(await step(f.engine,f,run),null);assert.equal(f.targets().length,0);}
});
test('snapshot writers and other source systems retain the old full path',async t=>{
 const f=await fixture(t),run=await f.ready([row(1)]),writer={...f.writer,recordSnapshotRows:async()=>{},finishSnapshot:async()=>{},withdrawSnapshot:async()=>{}},e=prototype.createDataImportEngine({...f.composition,writers:{[f.profile.entity]:writer}});assert.equal(await step(e,f,run),null);
 const g=await F.fixture(t);g.sourceState={revision:1};const other=await g.ready([row(2)]);assert.equal(await step(g.engine,g,other),null);
});
test('read/review/apply permission, expiry and exact proof errors never become validation fallback',async t=>{
 for(const action of ['read','review','apply']){const f=await fixture(t),run=await f.ready([row(1)]);f.context.denied.add(action);await assert.rejects(step(f.engine,f,run),error=>error.code==='IMPORT_FORBIDDEN');assert.equal(f.targets().length,0);}
 const f=await fixture(t),run=await f.ready([row(1)]);f.context.time='2099-01-01T00:00:00.000Z';await assert.rejects(step(f.engine,f,run),error=>error.code==='IMPORT_RUN_EXPIRED');
 const g=await fixture(t),blocked=await g.ready([row(2)],{declaredRows:2});g.database.prepare("UPDATE data_import_runs SET status='ready' WHERE id=?").run(blocked.id);await assert.rejects(step(g.engine,g,blocked),error=>error.code==='IMPORT_DECISION_GATE');
});
test('integrity, CAS and arbitrary errors propagate rather than being converted into a full recheck',async()=>{
 for(const code of ['IMPORT_CONCURRENT_CHANGE','IMPORT_REVISION_CONFLICT','IMPORT_FORBIDDEN','IMPORT_ROW_INTEGRITY','IMPORT_READY_CURSOR_INTEGRITY','IMPORT_SOURCE_INTEGRITY','IMPORT_WRITER_CONTRACT','IMPORT_OPERATION_FAILED']){let calls=0;const e={validateReadyPlans:async()=>C.fail(code,409),recheck:async()=>{calls++;}};await assert.rejects(advanceReadyValidation(e,{run:{id:'a'.repeat(64),revision:1}},null,{}),error=>error.code===code);assert.equal(calls,0);}
});
test('ordinal gaps and authenticated-plan corruption are detected without rewriting source rows',async t=>{
 const f=await fixture(t),run=await f.ready([row(1),row(2)]);f.database.prepare('UPDATE data_import_rows SET row_number=3 WHERE run_id=? AND row_number=2').run(run.id);const before=originalRows(f,run);await assert.rejects(step(f.engine,f,run),error=>error.code==='IMPORT_ROW_INTEGRITY');assert.equal(originalRows(f,run),before);assert.equal(f.targets().length,0);
});
test('large legitimate run/source revision values remain supported across cursor checkpoints',async t=>{
 const f=await fixture(t),run=await f.ready([row(1),row(2)]);f.database.prepare('UPDATE data_import_runs SET revision=2000001 WHERE id=?').run(run.id);f.sourceState.revision=2000001;const e=prototype.createDataImportEngine({...f.composition,operationBatchSize:1}),fresh=await e.checkpoint(run.id),p=await step(e,f,fresh),done=await step(e,f,fresh,p.cursor);assert.equal(done.complete,true);assert.equal(f.targets().length,0);
});
test('the real source runtime persists and resumes the private cursor through reconstruction without leaking it',async t=>{
 let f;const trace=[];const instrumented={createDataImportEngine:options=>{const e=prototype.createDataImportEngine({...options,operationBatchSize:2});return Object.freeze({...e,validateReadyPlans:async(...args)=>{const r=await e.validateReadyPlans(...args);if(r){assert.equal(f.database.prepare("SELECT count(*) n FROM import_history_records WHERE source_table='BESTELLUNGEN'").get().n,0);trace.push({id:args[0],n:r.verifiedRows,done:r.complete});}return r;},apply:async(...args)=>{if(args[2]?.readyValidation)assert.equal(trace.filter(x=>x.id===args[0]).at(-1).done,true);return e.apply(...args);}});}};
 const runtimePath=path.join(repo,'lib/persistence/repositories/data-import-runtime.js'),runtime=compileAs(runtimePath,fs.readFileSync(runtimePath,'utf8'),name=>name==='../../data-import-engine'?instrumented:null);
 const testPath=path.join(repo,'test/data-import-runtime.test.js'),text=fs.readFileSync(testPath,'utf8'),start=text.indexOf("test('progress timings survive");const R=compileAs(testPath,text.slice(0,start)+'\nmodule.exports={fixture};',name=>name==='../lib/persistence/repositories/data-import-runtime'?runtime:null);
 const table=req('lib/tradefoto-bestell/profiles').tableFor('BESTELLUNGEN'),rows=[1,2,3,4,5].map(n=>({...Object.fromEntries(table.columns.map(c=>[c.name,null])),BestellNr:n}));f=await R.fixture(t,{kind:'bestell',values:{BESTELLUNGEN:rows}});let source=await f.upload();source=await f.finish(source,'review');const id=source.tables.find(x=>x.name==='BESTELLUNGEN').run.id;
 let n=0;while(source.status!=='applied'){f.reload();source=await f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision});assert.equal(source.readyPlanValidation,undefined);assert.ok(++n<250);}
 assert.deepEqual(trace.filter(x=>x.id===id).map(x=>x.n),[2,4,5]);assert.equal(source.tables.find(x=>x.name==='BESTELLUNGEN').run.counts.applied,5);
});

const engineText=fs.readFileSync(enginePath,'utf8').replaceAll('\r\n','\n');
const masterTradeProfile=C.defineDataImportProfile(F.profileInput({sourceSystem:'tradefoto.master-data'}));
async function tradeFixture(t){const f=await F.fixture(t,{profile:masterTradeProfile});f.sourceState={revision:1};return f;}
test('Trade master producing plans validate all 501 ordinals before any target write, without changing encrypted rows or refs',async t=>{
 const f=await tradeFixture(t),run=await f.ready(Array.from({length:501},(_,i)=>row(i+1))),e=prototype.createDataImportEngine({...f.composition,operationBatchSize:200}),before=originalRows(f,run);let p=null;
 for(const count of [200,400,501]){p=await step(e,f,run,p?.cursor);assert.equal(p.verifiedRows,count);assert.equal(f.targets().length,0);assert.equal(originalRows(f,run),before);assert.equal(p.run.revision,run.revision);}
 assert.equal(p.complete,true);const applied=await e.apply(run.id,run.revision,{readyValidation:binding(f,p.cursor)});assert.equal(applied.counts.applied,200);
});
test('Trade late dependency change at row500 refreshes all501 plans and keeps the real reservation before business writes',async t=>{
 const f=await tradeFixture(t),versions=new Map(Array.from({length:501},(_,i)=>[String(i+1),1])),fresh=[];let inFusion=false;
 f.writer.review=async(_tx,record)=>{if(inFusion)fresh.push({number:Number(record.data.number),version:versions.get(record.data.number)});return {issue:'',token:C.fingerprint(versions.get(record.data.number)),rewrite:false};};
 let run=await f.ready(Array.from({length:501},(_,i)=>row(i+1)));const e=prototype.createDataImportEngine({...f.composition,operationBatchSize:200}),wrapped={...e,recheckAndReviewCreatePlans:async(...args)=>{inFusion=true;try{return await e.recheckAndReviewCreatePlans(...args);}finally{inFusion=false;}}};
 const reserve=()=>sha(JSON.stringify({row:f.database.prepare('SELECT payload FROM data_import_rows WHERE run_id=? AND row_number=501').get(run.id),refs:f.database.prepare('SELECT slot,block_id FROM data_import_row_payload_refs WHERE run_id=? AND row_number=501 ORDER BY slot').all(run.id)}));
 async function records(){const store=req('lib/data-import-payload-store').createDataImportPayloadStore({protection:f.protection});return f.repository.atomic(async tx=>{const header=await tx.getRun({id:run.id,...f.context.who}),rows=await tx.listRows({runId:run.id,after:0,limit:1000});await tx.prepareRead?.(run.id,rows);const values=await Promise.all(rows.map(row=>store.decode(tx,{run:header,profile:f.profile,row,kind:'row'})));return C.canonical(values.map(v=>v.record));},{readOnly:true});}
 const originalRecords=await records(),reserved=reserve();let p=await step(e,f,run);p=await step(e,f,run,p.cursor);versions.set('500',2);
 const validationEvidence=originalRows(f,run);wrapped.validateReadyPlans=async(...args)=>{try{return await e.validateReadyPlans(...args);}catch(error){assert.equal(originalRows(f,run),validationEvidence,'The failed validation-only pass preserves every ciphertext, block and shared ref before replanning');throw error;}};
 let current=await advanceReadyValidation(wrapped,{run},{runId:run.id,cursor:p.cursor,complete:false},binding(f));f.sourceState.revision++;
 assert.equal(current.progress.fusion,true);assert.equal(current.progress.fallback,true);assert.equal(current.run.counts.staged,1);assert.equal(current.run.counts.create,500);assert.equal(f.targets().length,0);assert.equal(reserve(),reserved,'The still-unprocessed real last row retains exact ciphertext and shared refs');
 await assert.rejects(e.apply(current.run.id,current.run.revision),e=>e.code==='IMPORT_PREVIEW_INCOMPLETE');assert.equal(f.targets().length,0);
 for(let n=0;current.progress!==null;n++){assert(n<10);current=await advanceReadyValidation(wrapped,{run:current.run},current.progress,binding(f));f.sourceState.revision++;assert.equal(f.targets().length,0);if(current.progress){assert.equal(current.progress.fusion,true);assert.equal(current.run.counts.staged,1);assert.equal(reserve(),reserved);}}
 assert.equal(current.run.status,'ready');assert.equal(current.run.counts.create,501);assert.equal(current.run.counts.staged,undefined);assert.deepEqual(fresh,Array.from({length:501},(_,i)=>({number:i+1,version:i===499?2:1})),'All501 plans must use current dependency evidence, including changed row500');assert.equal(await records(),originalRecords,'Replanning may replace plan ciphertext, never original source/data/key records');
});
test('snapshot admission is only exact current AFv2 with all three original hooks; AFv1 and every unknown snapshot remain excluded',async t=>{
 const H=req('lib/tradefoto-history-profiles'),M=req('lib/tradefoto-master-profiles');
 const factory=compileAs(enginePath,engineText.replace('  const engine = {','  const engine = { __pendingReady:pendingReady,')).createDataImportEngine;
 const f=await fixture(t),e=factory(f.composition),run={status:'ready',receivedCount:501,manifest:{expectedRows:501}};
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
test('other producing source families remain outside this explicit Trade/Bestell extension',async t=>{
 for(const system of ['tradefoto.history.cash','tradefoto.weum','tradefoto.inventur','tradefoto.lieferantenrechnungen','synthetic-unknown']){
  const profile=C.defineDataImportProfile(F.profileInput({sourceSystem:system})),f=await F.fixture(t,{profile});f.sourceState={revision:1};const run=await f.ready([row(1)]);
  assert.equal(await step(f.engine,f,run),null);assert.equal(f.targets().length,0);
 }
});
test('actual Trade runtime uses the same private complete-cursor pass for a current master profile',async t=>{
 let f;const trace=[];
 const instrumented={createDataImportEngine:options=>{const e=prototype.createDataImportEngine({...options,operationBatchSize:2});return Object.freeze({...e,
  validateReadyPlans:async(...args)=>{const r=await e.validateReadyPlans(...args);if(r){assert.equal(f.database.prepare("SELECT count(*) n FROM import_master_records WHERE source_table='KUNDEN'").get().n,0);trace.push({id:args[0],n:r.verifiedRows,done:r.complete});}return r;},
  apply:async(...args)=>{if(args[2]?.readyValidation)assert.equal(trace.filter(x=>x.id===args[0]).at(-1).done,true);return e.apply(...args);}});}};
 const runtimePath=path.join(repo,'lib/persistence/repositories/data-import-runtime.js'),runtime=compileAs(runtimePath,fs.readFileSync(runtimePath,'utf8'),name=>name==='../../data-import-engine'?instrumented:null);
 const testPath=path.join(repo,'test/data-import-runtime.test.js'),text=fs.readFileSync(testPath,'utf8'),cut=text.indexOf("test('progress timings survive"),R=compileAs(testPath,text.slice(0,cut)+'\nmodule.exports={fixture};',name=>name==='../lib/persistence/repositories/data-import-runtime'?runtime:null);
 const M=req('lib/tradefoto-master-profiles'),table=M.tableFor('KUNDEN'),rows=[1,2,3,4,5].map(n=>({...Object.fromEntries(table.columns.map(c=>[c.name,null])),KUND_NR:String(n),NACHNAME:'Synthetic '+n}));
 f=await R.fixture(t,{kind:'trade',values:{KUNDEN:rows}});let source=await f.upload();source=await f.finish(source,'review');const id=source.tables.find(t=>t.name==='KUNDEN').run.id;
 for(let i=0;source.status!=='applied';i++){assert.ok(i<500);f.reload();source=await f.runtime.sourceOperation(f.getSession,source.id,'apply',{expectedRevision:source.revision});assert.equal(source.readyPlanValidation,undefined);}
 assert.deepEqual(trace.filter(x=>x.id===id).map(x=>x.n),[2,4,5]);assert.equal(source.tables.find(t=>t.name==='KUNDEN').run.counts.applied,5);
});
