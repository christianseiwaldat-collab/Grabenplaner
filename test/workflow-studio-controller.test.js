"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createController}=require('../public/workflow-studio');const {functionSource}=require('../test-support/learning-workspace-ui');
const payload=()=>({contractVersion:1,model:'linear-v1',capabilities:{canRead:true},definitions:[],legacyDefinitions:[],publications:[],instances:[],instanceWindow:'open'});
const turn=()=>new Promise(setImmediate);
test('Studio controller preserves no response across account ABA, scope, page or source-right changes',async()=>{
 let session={},key='same',active=true,allowed=true,scope='A';const pending=[];const ctrl=createController({api:(_url,{signal})=>new Promise((resolve,reject)=>pending.push({resolve,reject,signal})),session:()=>session,key:()=>key,active:()=>active,canUse:()=>allowed,scope:()=>scope});ctrl.sync();assert.equal(ctrl.current().status,'loading');session={};ctrl.sync();assert.equal(pending[0].signal.aborted,true);pending[0].resolve({...payload(),generatedAt:'old'});await turn();assert.equal(ctrl.current().status,'loading');pending[1].resolve(payload());await turn();assert.equal(ctrl.current().status,'ready');active=false;ctrl.sync();assert.equal(ctrl.current().data,null);active=true;scope='B';ctrl.sync();allowed=false;ctrl.sync();assert.equal(pending[2].signal.aborted,true);pending[2].resolve(payload());await turn();assert.equal(ctrl.current().status,'denied');assert.equal(ctrl.current().data,null);
});
test('Studio source errors stay unknown; retry can acknowledge an actually empty authorized catalog',async()=>{
 let fail=true;const ctrl=createController({api:async()=>{if(fail)throw Error('offline');return payload();},session:()=>null,key:()=>'local',active:()=>true,canUse:()=>true});ctrl.sync();await turn();assert.equal(ctrl.current().status,'failed');assert.equal(ctrl.current().data,null);fail=false;await ctrl.load();assert.equal(ctrl.current().status,'ready');assert.equal(ctrl.current().data.definitions.length,0);
});
test('Actual Center navigation gate does not derive Studio rights from O8 or M5; existing source permissions still open their own area',()=>{
 const state={portalStatus:{portalEnabled:true},portalSession:{authenticated:true,user:{role:'hr',active:true,permissions:['rights:read']}}};let o8=false,m5=false;const ctx=vm.createContext({state,hasGovernancePermission:p=>state.portalSession.user.permissions.includes(p),canReadPersonnelWorkflowInstances:()=>m5,canReadPersonnelLifecycleEditorCatalog:()=>o8});vm.runInContext(functionSource('canReadWorkflowStudioCatalog')+functionSource('canOpenWorkflowCenter'),ctx);assert.equal(ctx.canOpenWorkflowCenter(),true);state.portalSession.user.role='manager';assert.equal(ctx.canReadWorkflowStudioCatalog(),false);state.portalSession.user.permissions=['personnel:lifecycle:editor:read'];o8=true;assert.equal(ctx.canOpenWorkflowCenter(),true);assert.equal(ctx.canReadWorkflowStudioCatalog(),false);o8=false;m5=true;assert.equal(ctx.canOpenWorkflowCenter(),true);state.portalSession.user.role='hr';state.portalSession.user.permissions=['rights:read'];state.portalSession.user.mustChangePassword=true;assert.equal(ctx.canReadWorkflowStudioCatalog(),false);
});

test('Actual API keeps a fresh same-account session when an older 401 error detail arrives; current 401 still opens login',async()=>{
 const state={portalSession:{authenticated:true,user:{employeeNumber:'A'}}};const details=[];let loginCalls=0;
 const ctx=vm.createContext({state,document:{cookie:''},elements:{loginGate:{}},location:{hostname:'synthetic.invalid'},fetch:async()=>({ok:false,status:401}),window:{GrabenplanerApiErrors:{fromResponse:()=>new Promise(resolve=>details.push(resolve))}},showLoginGate:()=>{loginCalls++;},Error});
 vm.runInContext(functionSource('api'),ctx);
 const old=ctx.api('/api/portal/v1/workflow-studio/catalog');await turn();
 state.portalSession=null;state.portalSession={authenticated:true,user:{employeeNumber:'A'}};
 const replacement=state.portalSession;
 details.shift()({message:'expired',code:'EXPIRED'});await assert.rejects(old,error=>error.code==='PORTAL_SESSION_CHANGED');assert.equal(loginCalls,0);assert.equal(state.portalSession,replacement);
 const current=ctx.api('/api/portal/v1/workflow-studio/catalog');await turn();details.shift()({message:'expired',code:'EXPIRED'});await assert.rejects(current,error=>error.status===401);assert.equal(loginCalls,1);
});
