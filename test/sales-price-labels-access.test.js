'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {priceLabelSession}=require('../lib/sales-price-labels-access');
const {buildSalesArticleCatalogProjection}=require('../lib/sales-article-catalog-access');
const branch={sessionKind:'organization',isEmployee:false,accountId:'branch-18',accountType:'branch',homeLocationId:'18',scopes:[{locationId:'18'}],permissions:['branch_articles:read']};
test('branch can compose labels without personal article editing, cost access or mutating its session',()=>{
  const projected=priceLabelSession(branch), access=buildSalesArticleCatalogProjection(projected);
  assert.equal(access.pricesRead,true); for(const field of ['write','costsRead','import'])assert.equal(access[field],false);
  assert.equal(buildSalesArticleCatalogProjection(branch).read,false);
  assert.deepEqual(branch.permissions,['branch_articles:read']);
});
test('unscoped, wrong organization types, disabled permission and forced-password sessions cannot use labels',()=>{
  for(const changed of [{scopes:[]},{scopes:[{locationId:'18'},{locationId:'11'}]},{accountType:'warehouse'},{permissions:[]},{mustChangePassword:true},{scopes:[{locationId:'18',departmentId:1}]}])assert.throws(()=>priceLabelSession({...branch,...changed}),e=>e.status===403);
});
test('personal sale-price permission is required, including for a normal salesperson',()=>{
  const employee={employeeNumber:'419',isEmployee:true,sessionKind:'employee',role:'sales',permissions:['sales:articles:access','sales:articles:read','sales:articles:prices:read']};
  assert.equal(priceLabelSession(employee),employee);
  assert.throws(()=>priceLabelSession({...employee,permissions:['sales:articles:read']}),e=>e.status===403);
});
