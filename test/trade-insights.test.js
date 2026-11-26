'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {insightFixture}=require('../test-support/trade-insights-fixture');
const {createTradeInsightRuntime}=require('../lib/persistence/repositories/trade-insights');
const A=require('../lib/sales-analytics-access').SALES_ANALYTICS_PERMISSIONS,H=require('../lib/sales-history-access').SALES_HISTORY_PERMISSIONS;
test('Added history prefetch compiles to native PostgreSQL tables without changing existing migrations',()=>{
 const entries=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.filter(e=>['trade-insights.versions','trade-insights.segments','trade-insights.references'].includes(e.statement.id));
 assert.equal(entries.length,3);for(const e of entries){assert.match(e.sql,/import_history_/);assert.match(e.sql,/LIMIT/);assert.doesNotMatch(e.sql,/\$scopeId/);}
});
