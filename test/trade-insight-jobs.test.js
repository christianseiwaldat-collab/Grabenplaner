'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../test-support/trade-insights-sqlite');
const {createTradeInsightJobs}=require('../lib/persistence/repositories/trade-insight-jobs');
const M=require('../public/trade-insight-results');
function queue(f,extra={}){return createTradeInsightJobs({access:f.app.provider,vault:f.vault,runtime:f.runtime,resolvePrincipal:async()=>({...f.state.session,id:undefined}),...extra});}
async function complete(jobs,session){for(let n=0;n<10;n++){await jobs.tick();if(!(await jobs.list(session)).some(r=>['queued','running'].includes(r.status)))return;}throw Error('Queue did not finish');}
test('server queue persists every page and reloads the original encrypted result after imports change',async t=>{
 const f=await fixture(t),jobs=queue(f);t.after(()=>jobs.stop());
 const job=await jobs.create(f.state.session,{kind:'purchasing',query:{},title:'September Ergebnis'});
 assert.equal(job.status,'queued');await complete(jobs,f.state.session);
 const before=await jobs.get(f.state.session,job.id);assert.equal(before.status,'completed');assert.ok(before.result.rows.length>50);
 f.state.session={...f.state.session,permissions:[...f.state.session.permissions,'sales:articles:access','sales:articles:read']};
 assert.equal((await f.run('context')).projection.articleHistory,true);
 assert.deepEqual((await jobs.get(f.state.session,job.id)).result,before.result,'article-history access does not change the authority of existing saved results');
 const raw=f.app.database.prepare('SELECT payload FROM sales_report_jobs WHERE id=?').get(job.id).payload;assert.doesNotMatch(raw,/September Ergebnis|articleNumber|synthetic-owner/);
 await f.ingest('BESTELLDETAILS',[{BestellId:'999',BestellNr:1,EAN:'new-result',BMenge:'9',gMenge:'1'}]);
 const restarted=queue(f);t.after(()=>restarted.stop());
 assert.deepEqual((await restarted.get(f.state.session,job.id)).result,before.result);
 await restarted.rename(f.state.session,job.id,{title:'Archiv September'});
 assert.equal((await restarted.get(f.state.session,job.id)).title,'Archiv September');
 assert.deepEqual((await restarted.get(f.state.session,job.id)).result,before.result);
});
test('a new worker resumes the durable cursor after the lease, without re-reading the first page',async t=>{
 const f=await fixture(t);let time=Date.now();const jobs=queue(f,{now:()=>time});
 const job=await jobs.create(f.state.session,{kind:'purchasing',query:{}});await jobs.tick();
 assert.equal((await jobs.list(f.state.session))[0].processed,50);await jobs.stop();
 time+=180001;const restarted=queue(f,{now:()=>time});t.after(()=>restarted.stop());await complete(restarted,f.state.session);
 const result=await restarted.get(f.state.session,job.id);assert.equal(result.result.rows.length,65);assert.equal(result.processed,65);
 assert.equal(new Set(result.result.rows.map(r=>r.id)).size,65);
});
test('changed sources fail closed instead of producing a mixed snapshot',async t=>{
 const f=await fixture(t),jobs=queue(f);t.after(()=>jobs.stop());
 const job=await jobs.create(f.state.session,{kind:'purchasing',query:{}});await jobs.tick();
 await f.ingest('BESTELLDETAILS',[{BestellId:'999',BestellNr:1,EAN:'changed',BMenge:'1',gMenge:'0'}]);await jobs.tick();
 const [state]=await jobs.list(f.state.session);assert.equal(state.status,'failed');assert.equal(state.error,'IMPORT_HISTORY_ANALYSIS_CHANGED');
 await assert.rejects(jobs.get(f.state.session,job.id),e=>e.status===409);
});
test('saved results retain ownership and current grants; revoked workers cannot finish',async t=>{
 const f=await fixture(t),jobs=queue(f);t.after(()=>jobs.stop());const session=f.state.session;
 const job=await jobs.create(session,{kind:'purchasing',query:{}});await complete(jobs,session);
 await assert.rejects(jobs.get({...session,employeeNumber:'someone-else'},job.id),e=>e.status===404);
 f.state.session={...session,permissions:session.permissions.filter(p=>p!=='sales:analytics:margin:read')};
 assert.equal((await jobs.list(f.state.session))[0].accessible,false);
 await assert.rejects(jobs.get(f.state.session,job.id),e=>e.status===403);
 await assert.rejects(jobs.rename(f.state.session,job.id,{title:'x'}),e=>e.status===403);
 f.state.session=session;const pending=await jobs.create(session,{kind:'purchasing',query:{}});await jobs.tick();
 f.state.session={...session,permissions:[]};await jobs.tick();f.state.session=session;
 assert.equal((await jobs.list(session)).find(r=>r.id===pending.id).status,'failed');
});
test('cancel prevents late worker results, deletion is explicit and the queue is bounded',async t=>{
 const f=await fixture(t);let release;const jobs=queue(f,{dispatchRead:()=>new Promise(r=>{release=r;})});t.after(()=>jobs.stop());
 const job=await jobs.create(f.state.session,{kind:'purchasing',query:{}}),work=jobs.tick();
 while(!release)await new Promise(setImmediate);
 await jobs.cancel(f.state.session,job.id);release({available:true,rows:[],next:null});await work;
 assert.equal((await jobs.list(f.state.session))[0].status,'cancelled');
 await jobs.remove(f.state.session,job.id);assert.equal((await jobs.list(f.state.session)).length,0);
 for(let i=0;i<3;i++)await jobs.create(f.state.session,{kind:'purchasing',query:{}});
 await assert.rejects(jobs.create(f.state.session,{kind:'purchasing',query:{}}),e=>e.status===409);
 await assert.rejects(jobs.create(f.state.session,{kind:'prices',query:{}}),e=>e.code==='IMPORT_SHAPE_INVALID');
});
test('all result columns sort by raw values, dates and natural identifiers; nulls stay last',()=>{
 const rows=[{articleNumber:'a10',ordered:'100.5',date:'2026-01-01'},{articleNumber:'A2',ordered:'9.9',date:'2025-12-31'},{articleNumber:'a1',ordered:null,date:null}];
 const cols=M.columns('purchasing');
 assert.deepEqual(M.sortRows(rows,cols,'articleNumber').map(r=>r.articleNumber),['a1','A2','a10']);
 assert.deepEqual(M.sortRows(rows,cols,'ordered','asc').map(r=>r.ordered),['9.9','100.5',null]);
 assert.deepEqual(M.sortRows(rows,cols,'ordered','desc').map(r=>r.ordered),['100.5','9.9',null]);
 assert.deepEqual(M.sortRows(rows,cols,'date').map(r=>r.date),['2025-12-31','2026-01-01',null]);
 const large=[{ordered:'9007199254740993.01'},{ordered:'9007199254740992.99'}];assert.equal(M.sortRows(large,cols,'ordered')[0],large[1]);
 assert.equal(rows[0].articleNumber,'a10');
});

test('large structured results fit the encrypted queue without weakening shared payload limits',async t=>{
 const f=await fixture(t),context=await f.run('context');
 const rows=Array.from({length:8000},(_,i)=>({id:String(i),articleNumber:String(i),label:'Ausführliche synthetische Artikelbezeichnung '.repeat(6),ordered:'123.45'}));
 assert.ok(Buffer.byteLength(JSON.stringify(rows))>require('../lib/data-import-contract').LIMITS.rowBytes*6);
 const jobs=queue(f,{dispatchRead:async()=>({available:true,sourceRevision:context.sourceRevision,rows,next:null,scanned:8000})});t.after(()=>jobs.stop());
 const job=await jobs.create(f.state.session,{kind:'purchasing',query:{}});await jobs.tick();
 assert.deepEqual((await jobs.get(f.state.session,job.id)).result.rows,rows);
});

test('all remaining views retain typed results and source notes across empty final pages',async t=>{
 const f=await fixture(t);
 await f.ingest('ARTIKEL_STAMM',[{EAN:'a',Artikelbezeichnung:'Kamera',DurchschnittEK:'20'}],{master:true});
 await f.ingest('ARTIKEL_FILIALEN',[{EAN:'a',FilialID:18,FBestand:'2'}],{sourceInstance:'tradefoto-trade'});
 await f.ingest('Reparatur',Array.from({length:35},(_,i)=>({ReparaturNr:i+1,FilialId:'18',KUND_NR:42,AName:'Kamera '+i,ANr:i<2?'ABC':'SERIAL'+i,erledigt:false})));
 const jobs=queue(f);t.after(()=>jobs.stop());
 for(const [kind,query,count] of [['transfers',{},1],['stock-summary',{},1],['inventory',{},1],['repairs',{},35],['customer-history',{customer:'42'},35],['device-history',{serial:'ABC'},2]]){
  const job=await jobs.create(f.state.session,{kind,query});await complete(jobs,f.state.session);
  const saved=await jobs.get(f.state.session,job.id);assert.equal(saved.result.rows.length,count,kind);assert.ok(saved.result.note,kind);assert.ok(saved.result.sourceDates.length,kind);
 }
});
