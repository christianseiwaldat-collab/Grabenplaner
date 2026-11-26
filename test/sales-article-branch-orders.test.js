'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { seedBranchOrders } = require('../test-support/sales-article-branch-orders-fixture');
const { loadSalesArticleDetailData } = require('../lib/sales-article-detail-source');
const { loadSalesArticleBranchOrders, LIMIT, ITEM_LIMIT } = require('../lib/sales-article-branch-orders');
const UI = require('../public/sales-article-layout');

test('Unauthorized branch order read returns before any source lookup', async () => {
  let calls=0;
  const result = await loadSalesArticleBranchOrders({tx:{queryAll(){calls++;throw Error('must not query');}},rows:[{id:'18',quantity:'3',ordered:'4'}],session:{}});
  assert.equal(calls,0); assert.equal(result[0].quantity,'3'); assert.equal(result[0].ordered,null);
});
test('Browser detail cache invalidates purchasing data for role, identity kind, inventory rights and scope changes', () => {
  const vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const start=source.indexOf('function currentSalesArticleCatalogDetailAccessKey()'), end=source.indexOf('\nfunction syncSalesArticleCatalogActorState()',start);
  const base={role:'developer',isEmployee:true,sessionKind:'employee',accountId:'one',permissions:['sales:purchasing:read'],scopes:[{locationId:'18'}],
    salesHistory:{read:true},salesAnalytics:{inventory:true},mustChangePassword:false};
  const state={portalSession:{user:base}};
  const context={state,currentSalesArticleCatalogActorKey:()=> 'person',canReadSalesArticles:()=>true,canReadSalesArticlePrices:()=>true,
    canReadSalesArticleCosts:()=>true,canWriteSalesArticles:()=>true,canImportSalesArticles:()=>true};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.key=currentSalesArticleCatalogDetailAccessKey;',context);
  const before=context.key();
  for(const change of [{role:'employee'},{isEmployee:false},{sessionKind:'organization'},{accountId:'two'},
    {permissions:[]},{scopes:[{locationId:'19'}]},{salesAnalytics:{inventory:false}},{mustChangePassword:true}]) {
    state.portalSession.user={...base,...change}; assert.notEqual(context.key(),before,JSON.stringify(change));
  }
});
