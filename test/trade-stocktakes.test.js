'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {seedStocktakes}=require('../test-support/trade-stocktakes-fixture');
const {difference}=require('../lib/persistence/repositories/trade-stocktakes');
const M=require('../public/trade-insight-results'),UI=require('../public/trade-stocktakes'),Period=require('../public/trade-period');
const detailsQuery=r=>({stocktakeId:r.id,stocktakeVersion:String(r.revision),stocktakeSource:r.sourceHash});
test('bounded detail SQL compiles natively and calendar accepts weeks and same-day ranges, rejects invalid days',()=>{
 const entries=require('../lib/persistence/postgresql/reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG.filter(e=>e.statement.id.startsWith('trade-insights.stocktake-'));assert.equal(entries.length,4);for(const e of entries){assert.match(e.sql,/parent_id/);assert.match(e.sql,/LIMIT/);assert.doesNotMatch(e.sql,/\$parentId/);}
 for(const [from,to] of [['2026-09-01','2026-09-25'],['2026-09-25','2026-09-25']])assert.equal(Period.validRange(from,to,'2026-09-25'),true);for(const [from,to] of [['2026-02-30','2026-03-02'],['2026-09-25','2026-09-24'],['2026-09-24','2026-09-26'],['','']])assert.equal(Period.validRange(from,to,'2026-09-25'),false);
});
