'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const catalogRights=Object.values(require('../lib/sales-article-catalog-access').SALES_ARTICLE_CATALOG_PERMISSIONS);
test('Both providers expose bounded indexed article-order pages and narrow catalog links',()=>{
 for(const catalog of [require('../lib/persistence/sqlite/sales-article-branch-orders-catalog').ARTICLE_BRANCH_ORDERS_CATALOG,require('../lib/persistence/postgresql/reporting/sales-article-branch-orders-catalog').ARTICLE_BRANCH_ORDERS_CATALOG]){
  const page=catalog.find(entry=>entry.statement.id==='sales-article-branch-orders.page');assert.ok(page);assert.match(page.sql,/master_record_id/);assert.match(page.sql,/LIMIT/);assert.match(page.sql,/101/);
  const links=catalog.find(entry=>entry.statement.id==='sales-article-branch-orders.article-links');assert.ok(links);assert.doesNotMatch(links.sql,/purchase_price|customer|personnel/);
 }
});
