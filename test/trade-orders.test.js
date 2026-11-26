'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS,H=require('../lib/sales-history-access').SALES_HISTORY_PERMISSIONS;
async function selected(f,query='1'){const page=await f.run('orders',{query});assert.equal(page.rows.length,1);return {orderId:page.rows[0].id,orderRevision:page.rows[0].revision,sourceRevision:page.sourceRevision};}
test('New read kinds reuse compiled bounded history and identity indexes in both providers',()=>{
 const sqlite=require('../lib/persistence/sqlite/trade-insights-catalog').TRADE_INSIGHTS_CATALOG;
 const postgres=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG;
 for(const catalog of [sqlite,postgres])for(const name of ['versions','segments','references']){const entry=catalog.find(e=>e.statement.id==='trade-insights.'+name);assert.ok(entry);assert.match(entry.sql,/LIMIT/);}
});
