'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,rights}=require('../test-support/trade-insights-sqlite');
const catalogRights=Object.values(require('../lib/sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSIONS);
async function setup(t){const f=await fixture(t);await require('../test-support/sales-article-workspace-fixture').seedWorkspace({access:f.app.provider,source:f});f.state.session={...f.state.session,permissions:[...rights,...catalogRights]};return f;}
test('Article orders paginate beyond the 400-record popup limit and preserve confirmed source links',async t=>{
 const f=await setup(t);
 await f.ingest('BESTELLDETAILS',Array.from({length:530},(_,i)=>({BestellId:String(30000+i),BestellNr:1,EAN:'005479',BMenge:'2',gMenge:'1'})));
 let page=await f.run('article-orders',{articleNumber:'005479'}),rows=[...page.rows],calls=1;
 assert.ok(page.next);assert.equal(page.coverage.complete,false);assert.ok(page.rows.length<=100);
 while(page.next){page=await f.run('article-orders',{articleNumber:'005479',cursor:page.next});rows.push(...page.rows);calls++;assert.ok(calls<12);}
 assert.equal(rows.length,530);assert.equal(new Set(rows.map(r=>r.id)).size,530);assert.equal(page.coverage.complete,true);
 assert.ok(rows.every(r=>r.articleNumber==='005479'&&r.orderNumber==='1'&&r.remaining==='1'&&r.articleIdentity==='confirmed_master_reference'));
});
test('Article orders keep original BE keys, link only validated distribution parents and protect branches',async t=>{
 const f=await setup(t);await f.ingest('BESTELLUNGEN',[{BestellNr:'001',LFilialID:18}]);
 await f.ingest('BESTELLDETAILS',[{BestellId:'300',BestellNr:1,EAN:'005479',BMenge:'2',gMenge:'0'},{BestellId:'301',BestellNr:2,EAN:'005479',BMenge:'3',gMenge:'0'}]);
 await f.ingest('BestellVerteilung',[{BestellNr:'1',BestellId:'300',FilialID:'18',EAN:'005479',Menge:'1',GelMenge:'0'},{BestellNr:'1',BestellId:'300',FilialID:'19',EAN:'005479',Menge:'1',GelMenge:'0'},{BestellNr:'1',BestellId:'999',FilialID:'18',EAN:'005479',Menge:'9'}]);
 f.state.session={...f.state.session,permissions:f.state.session.permissions.filter(r=>!['sales:analytics:company:read','sales:history:unassigned:read'].includes(r)),scopes:[{locationId:'18'}]};
 // Use the permission constants so this test stays attached to the actual rights contract.
 const A=require('../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS,H=require('../lib/sales-history-access').SALES_HISTORY_PERMISSIONS;
 f.state.session.permissions=f.state.session.permissions.filter(r=>![A.COMPANY_READ,H.UNASSIGNED].includes(r));
 const result=await f.run('article-orders',{articleNumber:'005479'});assert.equal(result.rows.length,2);assert.ok(result.rows.every(r=>r.orderNumber==='1'&&r.locationId==='18'));assert.ok(!result.rows.some(r=>r.orderNumber==='001'));
 assert.deepEqual(result.rows.map(r=>r.kind).sort(),['Bestellposition','Filialzuweisung']);
});
test('Article-order continuation rejects replacement sessions and changed article or import state',async t=>{
 const f=await setup(t);await f.ingest('BESTELLDETAILS',Array.from({length:110},(_,i)=>({BestellId:String(40000+i),BestellNr:1,EAN:'005479'})));
 const first=await f.run('article-orders',{articleNumber:'005479'});assert.ok(first.next);
 await assert.rejects(f.run('article-orders',{articleNumber:'005480',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 f.state.session={...f.state.session,id:'replacement'};await assert.rejects(f.run('article-orders',{articleNumber:'005479',cursor:first.next}),e=>e.code==='IMPORT_BESTELL_CURSOR');
 f.state.session={...f.state.session,permissions:f.state.session.permissions.filter(r=>r!=='sales:articles:read')};await assert.rejects(f.run('article-orders',{articleNumber:'005479'}),e=>e.status===403);
});
test('Both providers expose bounded indexed article-order pages and narrow catalog links',()=>{
 for(const catalog of [require('../lib/persistence/sqlite/sales-article-branch-orders-catalog').ARTICLE_BRANCH_ORDERS_CATALOG,require('../lib/persistence/postgresql/reporting/sales-article-branch-orders-catalog').ARTICLE_BRANCH_ORDERS_CATALOG]){
  const page=catalog.find(entry=>entry.statement.id==='sales-article-branch-orders.page');assert.ok(page);assert.match(page.sql,/master_record_id/);assert.match(page.sql,/LIMIT/);assert.match(page.sql,/101/);
  const links=catalog.find(entry=>entry.statement.id==='sales-article-branch-orders.article-links');assert.ok(links);assert.doesNotMatch(links.sql,/purchase_price|customer|personnel/);
 }
});
