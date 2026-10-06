'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../test-support/trade-insights-sqlite');
const {branchWindowContext,createBranchWindowPreferencesStore}=require('../lib/branch-window-preferences-store');
const session={id:'synthetic',accountId:'branch-a',accountType:'branch',sessionKind:'organization',isEmployee:false,
  mustChangePassword:false,permissions:[],scopes:[{locationId:'18'}]};
const gpWindows={version:1,windows:{'price-label-search':{x:12,y:23,width:610,height:480,minimized:true}}};
test('branch geometry contexts cannot be forged or use personal/multiple-scope/password actors',async t=>{
  const p=await fixture(t),store=createBranchWindowPreferencesStore({access:p.app.provider,vault:p.vault});
  for(const value of [{...session,isEmployee:true},{...session,accountType:'supplier'},{...session,scopes:[]},
    {...session,scopes:[{locationId:'18'},{locationId:'19'}]},{...session,scopes:[{locationId:'18',departmentId:'1'}]}]) {
    assert.throws(()=>branchWindowContext(value),{code:'BRANCH_WINDOWS_FORBIDDEN'});
  }
  assert.throws(()=>branchWindowContext({...session,mustChangePassword:true}),{status:428});
  await assert.rejects(store.get({...branchWindowContext(session)}),{status:403});
  const context=branchWindowContext(session);let checks=0;
  await assert.rejects(store.save(context,{revision:0,gpWindows},{assertFresh:async executor=>{checks++;if(executor)throw Object.assign(new Error(),{code:'BRANCH_WINDOWS_FORBIDDEN',status:403});}}),{status:403});
  assert.equal(checks,2);assert.deepEqual(await store.get(context),{revision:0,gpWindows:{version:1,windows:{}}});
  const saved=await store.save(context,{revision:0,gpWindows});assert.equal(saved.revision,1);
  assert.deepEqual(await createBranchWindowPreferencesStore({access:p.app.provider,vault:p.vault}).get(context),saved);
  const other=branchWindowContext({...session,accountId:'branch-b'});assert.equal((await store.get(other)).revision,0);
});
