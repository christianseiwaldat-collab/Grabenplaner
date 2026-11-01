'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadSalesArticleBranchOrders}=require('../lib/sales-article-branch-orders');
const permissions=require('../test-support/trade-insights-sqlite').rights;
const session={employeeNumber:'synthetic-owner',permissions,scopes:[]};
const rows=[{id:'18',quantity:'3',ordered:'4'},{id:'99',quantity:'2',ordered:'7'},
 {id:'unmapped',quantity:'1',ordered:'8'},{id:'ambiguous',quantity:null,ordered:'9',ambiguous:true}];

test('Initial all-branch quantity authorization needs no mapping lookup and retains stock ambiguity',async()=>{
 const tx={queryOne(){assert.fail('An all-branch grant does not depend on a mapping');}};
 const values=await loadSalesArticleBranchOrders({tx,rows,session,masterRecordId:'synthetic-master',deferDetails:true});
 assert.deepEqual(values.map(v=>[v.id,v.quantity,v.ordered,v.orders.state]),
  [['18','3','4','deferred'],['99','2','7','deferred'],['unmapped','1','8','deferred'],['ambiguous',null,null,'deferred']]);
 assert.ok(values.every(v=>v.orders.items.length===0));
 assert.equal(rows[3].ordered,'9','Projection does not mutate authenticated source rows');
});

test('Fresh purchasing revocation and organization sessions cannot reuse the all-branch quantity path',async()=>{
 for(const restricted of [{...session,permissions:permissions.filter(p=>p!=='sales:purchasing:read')},
  {...session,sessionKind:'organization',isEmployee:false},{...session,mustChangePassword:true},{}]){
  const result=await loadSalesArticleBranchOrders({rows,session:restricted,deferDetails:true});
  assert.ok(result.every(v=>v.ordered===null&&v.orders.state==='restricted'));
 }
});

test('Company scope alone and a retained unassigned flag without company scope still require verified mappings',async()=>{
 const sentinel=Error('authenticated-mapping-path');
 for(const omitted of ['sales:history:unassigned:read','sales:analytics:company:read']){
  const scoped={...session,permissions:permissions.filter(p=>p!==omitted),scopes:[{locationId:'18'}]};
  const protection={digest(){throw sentinel;}};
  await assert.rejects(loadSalesArticleBranchOrders({access:{},tx:{},rows,session:scoped,protection,
   scopeId:'synthetic-scope',masterRecordId:'synthetic-master',deferDetails:true}),e=>e===sentinel);
 }
});
