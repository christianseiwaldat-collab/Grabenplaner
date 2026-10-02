'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {insightFixture}=require('../test-support/trade-insights-fixture');
const {createTradeInsightRuntime}=require('../lib/persistence/repositories/trade-insights');
const {fixture,rights}=require('../test-support/trade-insights-sqlite');
const A=require('../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS,H=require('../lib/sales-history-access').SALES_HISTORY_PERMISSIONS;
test('Purchasing uses encrypted current history, exact delivered differences, bounded continuation and branch grants',async t=>{
 const f=await fixture(t);const context=await f.run('context');assert.equal(context.sources.purchasing.rows,65);assert.equal(context.locations.length,2);
 let page=await f.run('purchasing'),rows=[...page.rows];assert.equal(rows.length,50);assert.ok(page.next);
 const first=page;page=await f.run('purchasing',{cursor:page.next});rows.push(...page.rows);assert.equal(rows.length,65);assert.equal(page.next,null);
 assert.equal(rows.filter(r=>r.supplier==='Canon').length,60);assert.equal(rows.find(r=>r.state==='overdelivered_quantity').rawDifference,'-2');
 assert.ok(rows.every(r=>r.receiptEventsAvailable===false));assert.doesNotMatch(JSON.stringify(rows),/KUND_NR|EK_|Verkäufer/);
 await assert.rejects(f.run('purchasing',{cursor:first.next,query:'changed'}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 f.state.session={...f.state.session,permissions:rights.filter(p=>![A.COMPANY_READ,H.UNASSIGNED].includes(p)),scopes:[{locationId:'18'}]};
 page=await f.run('purchasing');assert.ok(page.rows.every(r=>r.locationId==='18'));await assert.rejects(f.run('purchasing',{locationId:'19'}),e=>e.status===403);
 const transfers=await f.run('transfers');assert.equal(transfers.rows[0].state,'transfer_processed');assert.equal(transfers.rows[0].physicalReceiptConfirmed,false);assert.equal(transfers.rows[0].from,'');
 let calls=0;await assert.rejects(f.runtime.run(async()=>++calls===1?f.state.session:{...f.state.session,permissions:[]},'purchasing',{}),e=>e.status===403);
 f.state.session={...f.state.session,sessionKind:'organization',isEmployee:false};await assert.rejects(f.run('context'),e=>e.status===403);
});
test('Added history prefetch compiles to native PostgreSQL tables without changing existing migrations',()=>{
 const entries=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.filter(e=>['trade-insights.versions','trade-insights.segments','trade-insights.references'].includes(e.statement.id));
 assert.equal(entries.length,3);for(const e of entries){assert.match(e.sql,/import_history_/);assert.match(e.sql,/LIMIT/);assert.doesNotMatch(e.sql,/\$scopeId/);}
});
test('Trade context and period validation share the Vienna day across summer and winter UTC midnight boundaries',async t=>{
 const f=await fixture(t),runtime=createTradeInsightRuntime({access:f.app.provider,vault:f.vault});
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-02T22:30:00.000Z')});
 for(const [instant,day,nextDay]of [['2026-10-02T22:30:00.000Z','2026-10-03','2026-10-04'],['2026-12-15T23:30:00.000Z','2026-12-16','2026-12-17']]){
  t.mock.timers.setTime(Date.parse(instant));
  const run=(kind,input={})=>runtime.run(async()=>f.state.session,kind,input);
  const context=await run('context');assert.equal(context.today,day);assert.notEqual(context.today,new Date().toISOString().slice(0,10));
  await run('purchasing',{dateFrom:day,dateTo:day});
  await run('article-movements',{articleNumber:'100001',dateFrom:day,dateTo:day});
  await assert.rejects(run('article-movements',{articleNumber:'100001',dateTo:nextDay}),e=>e.code==='IMPORT_HISTORY_DATE_RANGE');
 }
});

test('Purchasing offers imported central and historical receiving branches without widening grants',async t=>{
 const f=await fixture(t);
 f.app.database.exec("INSERT INTO locations VALUES('3',1,'Großhandel'),('99',0,'United Camera Wien')");
 await f.ingest('FILIALEN',[{FilialID:'0',FName:'Zentrallager'},{FilialID:'3',FName:'Großhandel'},{FilialID:'99',FName:'United Camera Wien'}],{master:true});
 for(const key of ['3','99']){
  const record=(await f.masters.mappings({table:'FILIALEN',sourceInstance:'tradefoto-trade',key})).items[0];
  const input={recordId:record.id,expectedSourceRevision:record.revision,targetId:key,historical:key==='99',reason:'Synthetic receiving branch qualification'};
  await f.masters.bind(input,(await f.masters.previewBinding(input)).planHash);
 }
 await f.ingest('BESTELLUNGEN',['0','3','99'].map((key,i)=>({BestellNr:String(100+i),Suchname:'Synthetic supplier',LFilialID:Number(key),Bestelldatum:'2026-09-10T09:00:00.000'})));
 await f.ingest('BESTELLDETAILS',['0','3','99'].map((key,i)=>({BestellId:String(100+i),BestellNr:100+i,EAN:'100001',BArtikelbezeichnung:'Synthetic receiving article',BMenge:'2',gMenge:'1'})));
 const full=f.state.session,context=await f.run('context');
 assert.equal(context.locations.some(l=>l.id==='99'),false,'other views keep their active GP selector');
 assert.equal(context.purchasingLocations.find(l=>l.id==='trade-source:0').label,'0 · Zentrallager');
 assert.equal(context.purchasingLocations.find(l=>l.id==='3').label,'3 · Großhandel');
 assert.equal(context.purchasingLocations.find(l=>l.id==='99').label,'99 · United Camera Wien');
 for(const [id,source] of [['trade-source:0','0'],['3','3'],['99','99']]){
  const page=await f.runtime.run(async()=>f.state.session,'purchasing',{locationId:id},{pageSize:500});
  assert.equal(page.rows.length,1);assert.equal(page.rows[0].sourceLocation,source);
 }
 f.state.session={...full,permissions:full.permissions.filter(p=>p!==H.UNASSIGNED)};
 assert.equal((await f.run('context')).purchasingLocations.some(l=>l.id==='trade-source:0'),false);
 await assert.rejects(f.run('purchasing',{locationId:'trade-source:0'}),e=>e.status===403);
 assert.equal((await f.run('context')).purchasingLocations.some(l=>l.id==='99'),true);
 f.state.session={...full,permissions:rights.filter(p=>![A.COMPANY_READ,H.UNASSIGNED].includes(p)),scopes:[{locationId:'3'}]};
 assert.deepEqual((await f.run('context')).purchasingLocations.map(l=>l.id),['3']);
 assert.equal((await f.runtime.run(async()=>f.state.session,'purchasing',{locationId:'3'},{pageSize:500})).rows.length,1);
 await assert.rejects(f.run('purchasing',{locationId:'99'}),e=>e.status===403);
 await assert.rejects(f.run('purchasing',{locationId:'trade-source:0'}),e=>e.status===403);
});
module.exports={fixture,rights};
