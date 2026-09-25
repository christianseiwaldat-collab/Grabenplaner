'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../test-support/trade-insights-sqlite'),{seedStocktakes}=require('../test-support/trade-stocktakes-fixture');
const {difference}=require('../lib/persistence/repositories/trade-stocktakes');
const M=require('../public/trade-insight-results'),UI=require('../public/trade-stocktakes'),Period=require('../public/trade-period');
const detailsQuery=r=>({stocktakeId:r.id,stocktakeVersion:String(r.revision),stocktakeSource:r.sourceHash});
async function seed(t){const f=await fixture(t);await f.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Demo Systemkamera',Anlagedatum:'2020-01-01T00:00:00.000'}],{master:true});await f.ingest('ARTIKEL_STAMMGelöscht',[{EAN:'OLD-42',Artikelbezeichnung:'Demo Archivobjektiv',Anlagedatum:'2010-01-01T00:00:00.000',Löschdatum:'2026-09-12T00:00:00.000'}],{sourceInstance:'tradefoto-weum'});return {...f,stocktakes:await seedStocktakes(f)};}
test('inventory overview preserves full counts; details expose only selected rows with exact decimals and archive provenance',async t=>{
 const f=await seed(t),overview=await f.run('stocktakes');assert.equal(overview.rows.length,2);const h=overview.rows.find(r=>r.sourceLocation==='18');assert.equal(h.positions,120);assert.equal(h.unchanged,117);assert.equal(h.countsValid,true);
 const q=detailsQuery(h),result=await f.run('stocktakes',q);assert.equal(result.rows.length,4);assert.equal(result.stocktake.positions,120);assert.deepEqual(result.rows.map(r=>r.state).sort(),['incomplete','inconsistent','negative','positive']);assert.equal(result.rows.find(r=>r.articleNumber==='OLD-42').articleReference.status,'archived');assert.doesNotMatch(JSON.stringify(result),/NNPreis|149\.99/);
 for(const state of ['incomplete','inconsistent','positive','negative'])assert.equal((await f.run('stocktakes',{...q,difference:state})).rows.length,1);
 assert.equal((await f.run('stocktakes',{dateFrom:'2026-09-11',dateTo:'2026-09-11'})).rows.length,1);assert.equal((await f.run('stocktakes',{...q,query:'Archivobjektiv'})).rows.length,1);
 assert.equal(difference({AlteMenge:'9007199254740993',NeueMenge:'9007199254740992.99999',Differenz:'-0.00001'}).state,'negative');
 const html=UI.table(overview.rows,M.columns('stocktakes'),'date','desc',M);assert.match(html,/data-stocktake=/);assert.match(html,/aria-sort="descending"/);
});
test('branch and inventory grants also protect direct detail access and saved result creation',async t=>{
 const f=await seed(t),rows=(await f.run('stocktakes')).rows,other=detailsQuery(rows.find(r=>r.sourceLocation==='19')),base=f.state.session;
 f.state.session={...base,permissions:base.permissions.filter(p=>!p.includes('company')&&!p.includes('unassigned')),scopes:[{locationId:'18'}]};assert.equal((await f.run('stocktakes')).rows.length,1);await assert.rejects(f.run('stocktakes',other),e=>e.status===404);await assert.rejects(f.run('stocktakes',{locationId:'19'}),e=>e.status===403);
 f.state.session={...base,permissions:base.permissions.filter(p=>p!=='sales:analytics:inventory:read')};await assert.rejects(f.run('stocktakes'),e=>e.status===403);
});
test('heads and details cannot mix source files; stale overview references fail after a complete replacement',async t=>{
 const f=await seed(t),old=(await f.run('stocktakes')).rows[0],next={...f.stocktakes.options,snapshotAt:'2026-09-15T09:00:00.000Z',fileSha256:'b'.repeat(64)};
 await f.ingest('Inventur',f.stocktakes.heads,next);await assert.rejects(f.run('stocktakes'),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
 await f.ingest('Inventurdetails',f.stocktakes.details,next);await assert.rejects(f.run('stocktakes',detailsQuery(old)),e=>e.code==='IMPORT_HISTORY_ANALYSIS_CHANGED');assert.equal((await f.run('stocktakes')).rows.length,2);
});
test('saved overview and details retain their rows, count meaning and PDF after a new import',async t=>{
 const f=await seed(t),jobs=require('../lib/persistence/repositories/trade-insight-jobs').createTradeInsightJobs({access:f.app.provider,vault:f.vault,runtime:f.runtime,resolvePrincipal:async()=>f.state.session});t.after(()=>jobs.stop());
 const overview=await jobs.create(f.state.session,{kind:'stocktakes',query:{},title:'Inventurübersicht · Synthetische Abnahme'});await jobs.tick();const saved=await jobs.get(f.state.session,overview.id);
 const j=await jobs.create(f.state.session,{kind:'stocktakes',query:detailsQuery(saved.result.rows.find(r=>r.sourceLocation==='18')),title:'Inventur 101 · Filiale 18 · Synthetische Abnahme'});await jobs.tick();const before=await jobs.get(f.state.session,j.id);await seedStocktakes(f,{quantity:'-3',snapshotAt:'2026-09-15T09:00:00.000Z'});assert.deepEqual((await jobs.get(f.state.session,j.id)).result,before.result);
 const pdf=await require('../lib/trade-insight-pdf').createTradeInsightPdf(before,{sort:'difference',direction:'asc'});assert.equal(pdf.subarray(0,4).toString(),'%PDF');
 const loading=(await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({data:new Uint8Array(pdf),isEvalSupported:false});try{const doc=await loading.promise;let text='';for(let i=1;i<=doc.numPages;i++)text+=(await (await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');assert.match(text,/120 Positionen/);assert.match(text,/Archiviert/);assert.doesNotMatch(text,/stocktakeId|stocktakeVersion|stocktakeSource/);}finally{await loading.destroy();}
});
test('bounded detail SQL compiles natively and calendar accepts weeks and same-day ranges, rejects invalid days',()=>{
 const entries=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.filter(e=>e.statement.id.startsWith('trade-insights.stocktake-'));assert.equal(entries.length,4);for(const e of entries){assert.match(e.sql,/parent_id/);assert.match(e.sql,/LIMIT/);assert.doesNotMatch(e.sql,/\$parentId/);}
 for(const [from,to] of [['2026-09-01','2026-09-25'],['2026-09-25','2026-09-25']])assert.equal(Period.validRange(from,to,'2026-09-25'),true);for(const [from,to] of [['2026-02-30','2026-03-02'],['2026-09-25','2026-09-24'],['2026-09-24','2026-09-26'],['','']])assert.equal(Period.validRange(from,to,'2026-09-25'),false);
});
test('large detail searches cross page boundaries without duplicates, reject pending replacements and support complete initial undo',async t=>{
 const f=await fixture(t),options={sourceInstance:'tradefoto-inventur',fileSha256:'e'.repeat(64)},heads=[{InventurNummer:'701',InventurFilialid:'18',InventurDatum:'2026-09-10T00:00:00.000',Positionszahl:450,PositiveDifferenzen:450,NegativeDifferenzen:0,OhneDifferenz:0,UnvollstaendigeMengen:0}],details=Array.from({length:450},(_,i)=>({ID:String(i+1),Inventurnummer:'701',InventurFilialid:'18',EAN:'000042',AlteMenge:'0',NeueMenge:'1',Differenz:'1'}));
 let headRun=await f.ingest('Inventur',heads,options),detailRun=await f.ingest('Inventurdetails',details,options);
 const q=detailsQuery((await f.run('stocktakes')).rows[0]),rows=[];let cursor;do{const page=await f.run('stocktakes',{...q,...(cursor?{cursor}:{})});assert.ok(page.scanned<=200);rows.push(...page.rows);cursor=page.next;}while(cursor);assert.equal(rows.length,450);assert.equal(new Set(rows.map(r=>r.id)).size,450);
 const first=await f.run('stocktakes',q);await assert.rejects(f.run('stocktakes',{...q,difference:'negative',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 do{detailRun=await f.engine.undo(detailRun.id,detailRun.revision);}while(detailRun.status==='reverting');assert.equal(detailRun.status,'reverted');
 await assert.rejects(f.run('stocktakes'),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');headRun=await f.engine.undo(headRun.id,headRun.revision);assert.equal(headRun.status,'reverted');assert.equal((await f.run('stocktakes')).available,false);
 await f.ingest('Inventur',heads,{...options,fileSha256:'f'.repeat(64)});let pending=await f.ingest('Inventurdetails',details,{...options,fileSha256:'f'.repeat(64),apply:false});pending=await f.engine.apply(pending.id,pending.revision);assert.equal(pending.status,'applying');await assert.rejects(f.run('stocktakes'),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
});
