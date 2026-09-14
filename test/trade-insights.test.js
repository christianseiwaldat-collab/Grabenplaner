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
module.exports={fixture,rights};
