'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,rights}=require('../test-support/trade-insights-sqlite');
const A=require('../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS,H=require('../lib/sales-history-access').SALES_HISTORY_PERMISSIONS;
async function selected(f,query='1'){const page=await f.run('orders',{query});assert.equal(page.rows.length,1);return {orderId:page.rows[0].id,orderRevision:page.rows[0].revision,sourceRevision:page.sourceRevision};}
test('Orders preserve exact original keys and declared BE aliases without supplier-SKU or zero coercion',async t=>{
 const f=await fixture(t);await f.ingest('BESTELLUNGEN',[{BestellNr:'001',Suchname:'Original zeros',LFilialID:18},{BestellNr:'BE1',Suchname:'Original prefix',LFilialID:18},{BestellNr:'11',Suchname:'Other order',LFilialID:18}]);
 for(const [query,number,matchMode]of [['1','1','original'],['001','001','original'],['BE1','BE1','original'],['BE-11','11','be_alias']]){
  const page=await f.run('orders',{query});assert.equal(page.rows[0].orderNumber,number);assert.equal(page.rows[0].matchMode,matchMode);assert.equal(page.coverage.complete,true);
 }
 const missing=await f.run('orders',{query:'BE-0011'});assert.equal(missing.rows.length,0);assert.equal(missing.coverage.complete,true);
 await assert.rejects(f.run('orders',{query:'1',supplierArticleNumber:'11'}),e=>e.code==='IMPORT_SHAPE_INVALID');
 const long='9'.repeat(200);await f.ingest('BESTELLUNGEN',[{BestellNr:long,LFilialID:18}]);assert.equal((await f.run('orders',{query:long})).rows[0].orderNumber,long);
});
test('Header DTO applies independent contact, finance, cost and personnel rights before JSON',async t=>{
 const f=await fixture(t);await f.ingest('BESTELLUNGEN',[{BestellNr:'1',LFilialID:18,Suchname:'Supplier allowed',BEmail:'private@example.invalid',Text1:'Private memo',zahlbetrag:'41',BKostenträgercode:'private-cost',verkäufer_id:9}]);
 f.state.session={...f.state.session,permissions:rights.filter(r=>![A.MARGIN_READ,H.FINANCE,'crm:purchases:read'].includes(r))};
 const page=await f.run('orders',{query:'1'}),serialized=JSON.stringify(page);
 assert.equal(page.rows[0].supplier,'Supplier allowed');assert.doesNotMatch(serialized,/private@example|Private memo|private-cost|verkäufer_id|zahlbetrag/);
 f.state.session={...f.state.session,permissions:rights};const full=await f.run('orders',{query:'1'});
 assert.equal(full.rows[0].fields.BEmail,'private@example.invalid');assert.equal(full.rows[0].fields.zahlbetrag,'41');assert.ok(!('verkäufer_id'in full.rows[0].fields));
});
test('History scans carry empty-page continuation and cumulative completeness, retaining unchanged older provenance',async t=>{
 const f=await fixture(t);await f.ingest('BESTELLUNGEN',Array.from({length:210},(_,i)=>({BestellNr:String(1000+i),LFilialID:18,Suchname:'Other'})));
 const page=await f.run('orders',{query:'not-present',mode:'contains'});assert.equal(page.rows.length,0);assert.ok(page.next);assert.equal(page.coverage.complete,false);assert.equal(page.coverage.scanned,100);
 let current=page;while(current.next)current=await f.run('orders',{query:'not-present',mode:'contains',cursor:current.next});
 assert.equal(current.coverage.complete,true);assert.equal(current.coverage.scanned,212);
 const old=await f.run('orders',{query:'1'});assert.equal(old.rows[0].sourceDate,'2026-09-14T09:00:00.000Z');
 await assert.rejects(f.run('orders',{query:'changed',mode:'contains',cursor:page.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 const env={tx:{queryOne:async()=>({pending:0})},scopeId:'grabenplaner-main',p:require('../lib/tradefoto-bestell/access').projectionFor(f.state.session),session:f.state.session,sourceRevision:page.sourceRevision,protection:f.protection,source:async()=>null};
 await assert.rejects(require('../lib/persistence/repositories/trade-orders').ordersPage(env,{query:'not-present',mode:'contains',cursor:page.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 await assert.rejects(require('../lib/persistence/repositories/trade-orders').ordersPage(env,{query:'1',cursor:page.next}),e=>e.code==='IMPORT_SHAPE_INVALID');
});
test('Sections retain BestellId identities, exact EAN links, missing sources and unverified negative movement quantities',async t=>{
 const f=await fixture(t);
 await f.ingest('BestellVerteilung',[{BestellNr:'1',BestellId:'1',FilialID:'18',EAN:'000042',Menge:'2'},{BestellNr:'1',BestellId:'2',FilialID:'18',EAN:'wrong',Menge:'3'},{BestellNr:'1',BestellId:'61',FilialID:'18',EAN:'000042',Menge:'4'}]);
 let key=await selected(f),missing=await f.run('order-detail',{...key,part:'receipts'});assert.equal(missing.available,false);assert.equal(missing.coverage.complete,false);
 const positions=await f.run('order-detail',{...key,part:'positions'});assert.equal(positions.rows.length,60);assert.equal(new Set(positions.rows.map(r=>r.positionId)).size,60);assert.equal(positions.rows.filter(r=>r.articleReference==='000042').length,60);
 const distribution=await f.run('order-detail',{...key,part:'distribution'});assert.equal(distribution.rows.length,1);assert.deepEqual(distribution.issues,{unresolvedPositions:1,articleConflicts:1});
 await f.ingest('WE',[{We_ID:'1',We:true,Umlagerung:false,Bestellnr:1,EAN:'000042',FilialID:'18',Menge:'-2',WEDatum:'2026-09-10T00:00:00.000',Lieferscheinnr:'unverified'}],{sourceInstance:'tradefoto-weum'});
 key=await selected(f);const receipts=await f.run('order-detail',{...key,part:'receipts'});
 assert.equal(receipts.rows[0].quantity,'-2');assert.equal(receipts.rows[0].quantityState,'negative');assert.equal(receipts.rows[0].physicalReceiptConfirmed,false);assert.equal(receipts.rows[0].documentReferencesVerified,false);
});
test('Order authority checks both header and related endpoints, masks foreign branches and rejects revoked actors',async t=>{
 const f=await fixture(t);await f.ingest('WE',[{We_ID:'1',We:false,Umlagerung:true,Bestellnr:1,FilialID:'19',Filialid2:'18',Menge:'1'}],{sourceInstance:'tradefoto-weum'});
 const original=await selected(f,'2');f.state.session={...f.state.session,permissions:rights.filter(r=>![A.COMPANY_READ,H.UNASSIGNED].includes(r)),scopes:[{locationId:'18'}]};
 const hidden=await f.run('orders',{query:'2'}),absent=await f.run('orders',{query:'999999'});assert.equal(hidden.rows.length,0);assert.deepEqual(hidden.coverage,absent.coverage);assert.equal(hidden.scanned,0);
 await assert.rejects(f.run('order-detail',{...original,part:'header'}),e=>e.status===404);
 const key=await selected(f),receipts=await f.run('order-detail',{...key,part:'receipts'});
 assert.deepEqual(receipts.rows[0].endpoints.from,{sourceId:null,locationId:null});assert.ok(!('FilialID'in receipts.rows[0].fields));assert.ok(!('Filialid2'in receipts.rows[0].fields));
 let calls=0;await assert.rejects(f.runtime.run(async()=>++calls===1?f.state.session:{...f.state.session,id:'replacement'},'orders',{query:'1'}),e=>e.status===403);
 f.state.session={...f.state.session,permissions:rights.filter(r=>r!==A.INVENTORY_READ)};await assert.rejects(f.run('orders',{query:'1'}),e=>e.status===403);
});
test('Detail pages bind parent, part, source revision, actor and pending imports',async t=>{
 const f=await fixture(t);await f.ingest('BESTELLDETAILS',Array.from({length:160},(_,i)=>({BestellId:String(100+i),BestellNr:1,EAN:'repeat',BMenge:'1',gMenge:'0'})));
 const key=await selected(f),first=await f.run('order-detail',{...key,part:'positions'});assert.ok(first.next);assert.equal(first.coverage.complete,false);
 for(const part of ['constructor','toString','__proto__',true])await assert.rejects(f.run('order-detail',{...key,part}),e=>e.code==='IMPORT_SHAPE_INVALID');
 let page=first,ids=new Set(first.rows.map(r=>r.id));while(page.next){page=await f.run('order-detail',{...key,part:'positions',cursor:page.next});for(const row of page.rows){assert.equal(ids.has(row.id),false);ids.add(row.id);}}
 assert.equal(ids.size,220);assert.equal(page.coverage.complete,true);
 await assert.rejects(f.run('order-detail',{...key,part:'distribution',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 await assert.rejects(f.run('order-detail',{...key,orderRevision:key.orderRevision+1,part:'positions'}),e=>e.code==='IMPORT_HISTORY_ANALYSIS_CHANGED');
 await f.ingest('BESTELLUNGEN',[{BestellNr:'1',LFilialID:18,Suchname:'Changed'}]);await assert.rejects(f.run('order-detail',{...key,part:'positions',cursor:first.next}),e=>e.code==='IMPORT_HISTORY_ANALYSIS_CHANGED');
 const pending=await f.ingest('BESTELLDETAILS',Array.from({length:205},(_,i)=>({BestellId:String(10000+i),BestellNr:1,EAN:'pending'})),{apply:false});await f.engine.apply(pending.id,pending.revision);
 await assert.rejects(f.run('orders',{query:'1'}),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
});
test('New read kinds reuse compiled bounded history and identity indexes in both providers',()=>{
 const sqlite=require('../lib/persistence/sqlite/trade-insights-catalog').TRADE_INSIGHTS_CATALOG;
 const postgres=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG;
 for(const catalog of [sqlite,postgres])for(const name of ['versions','segments','references']){const entry=catalog.find(e=>e.statement.id==='trade-insights.'+name);assert.ok(entry);assert.match(entry.sql,/LIMIT/);}
});
test('Distribution issues remain cumulative after empty final scan pages',async t=>{
 const f=await fixture(t);await f.ingest('BestellVerteilung',[...Array.from({length:205},(_,i)=>({BestellNr:'1',BestellId:'61',FilialID:'18',EAN:'foreign-'+i,Menge:'1'})),{BestellNr:'1',BestellId:'1',FilialID:'18',EAN:'000042',Menge:'2'}]);
 const key=await selected(f);let page=await f.run('order-detail',{...key,part:'distribution'});assert.equal(page.coverage.complete,false);while(page.next)page=await f.run('order-detail',{...key,part:'distribution',cursor:page.next});
 assert.equal(page.coverage.complete,true);assert.equal(page.issues.unresolvedPositions,205);assert.equal(page.coverage.matched,1);assert.equal(page.coverage.scanned,206);
});
test('Original old header/line provenance survives newer partial keyed imports without a latest-file assertion',async t=>{
 const f=await fixture(t);await f.ingest('BESTELLUNGEN',[{BestellNr:'700',LFilialID:18,Suchname:'Newer supplier'}],{snapshotAt:'2026-09-15T09:00:00.000Z'});await f.ingest('BESTELLDETAILS',[{BestellId:'700',BestellNr:700,EAN:'new'}],{snapshotAt:'2026-09-15T09:00:00.000Z'});
 const key=await selected(f),page=await f.run('order-detail',{...key,part:'positions'});assert.equal(page.sources.header.date,'2026-09-15T09:00:00.000Z');assert.equal(page.order.sourceDate,'2026-09-14T09:00:00.000Z');assert.equal(page.rows.length,60);assert.ok(page.rows.every(r=>r.sourceDate==='2026-09-14T09:00:00.000Z'));assert.equal(page.coverage.complete,true);
});
for(const [table,instance,values]of [
 ['BESTELLUNGEN','tradefoto-bestell',i=>({BestellNr:String(10000+i),LFilialID:18})],
 ['BESTELLDETAILS','tradefoto-bestell',i=>({BestellId:String(10000+i),BestellNr:1,EAN:'pending'})],
 ['BestellVerteilung','tradefoto-bestell',i=>({BestellNr:'1',BestellId:String(10000+i),FilialID:'18',EAN:'pending'})],
 ['WE','tradefoto-weum',i=>({We_ID:String(10000+i),Bestellnr:1,FilialID:'18',Menge:'1'})],
])test('Incomplete '+table+' imports cannot appear as complete orders',async t=>{
 const f=await fixture(t),run=await f.ingest(table,Array.from({length:205},(_,i)=>values(i)),{sourceInstance:instance,apply:false});const applying=await f.engine.apply(run.id,run.revision);assert.equal(applying.status,'applying');
 await assert.rejects(f.run('orders',{query:'1'}),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
});
test('A permitted replacement session cannot reuse an old detail cursor',async t=>{
 const f=await fixture(t);await f.ingest('BESTELLDETAILS',Array.from({length:120},(_,i)=>({BestellId:String(1000+i),BestellNr:1,EAN:'repeat'})));const key=await selected(f),first=await f.run('order-detail',{...key,part:'positions'});assert.ok(first.next);
 f.state.session={...f.state.session,id:'same-employee-new-session'};await assert.rejects(f.run('order-detail',{...key,part:'positions',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
});
test('A large order detail page uses one bounded authenticated history packet, with constant source round trips',async t=>{
 const f=await fixture(t);await f.ingest('BESTELLDETAILS',Array.from({length:250},(_,i)=>({BestellId:String(10000+i),BestellNr:1,EAN:'repeat'})));const key=await selected(f);
 const measured=require('../test-support/measured-persistence').measuredPersistence(f.app.provider);require('../lib/persistence/repositories/import-batch-support').enableImportBatches(measured.access,{coreReferences:true});
 const runtime=require('../lib/persistence/repositories/trade-insights').createTradeInsightRuntime({access:measured.access,vault:f.vault,today:()=> '2026-09-14'});
 try{const page=await runtime.run(()=>f.state.session,'order-detail',{...key,part:'positions'});assert.ok(page.next);assert.ok(page.rows.length<=100);assert.ok(page.scanned<=100);
  for(const id of ['import-history.list','trade-insights.versions','trade-insights.segments','trade-insights.references'])assert.equal(measured.counts.get(id),1,id);
  const queries=[...measured.counts.values()].reduce((a,b)=>a+b,0);assert.ok(queries<=40,'100-source-row page must not perform per-position database reads; got '+queries);
 }finally{await measured.access.close();}
});
