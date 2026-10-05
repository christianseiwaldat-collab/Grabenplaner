'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {project,adjust,persistedGeometry}=require('../public/start-dashboard-workspace-geometry');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('viewport projection bounds rendering without mutating preferred geometry',()=>{
 const preferred={x:100,y:20,width:1000,height:300},rendered=project(preferred,800);
 assert.deepEqual(rendered,{x:0,y:20,width:800,height:300});
 const moved=persistedGeometry(preferred,rendered,adjust(rendered,'move',0,10,800),'move');
 assert.deepEqual(moved,{x:100,y:30,width:1000,height:300});
 const resized=persistedGeometry(preferred,rendered,adjust(rendered,'resize',0,10,800),'resize');
 assert.deepEqual(resized,{x:100,y:20,width:1000,height:310});
 assert.equal(project(resized,1400).width,1000);
 assert.deepEqual(preferred,{x:100,y:20,width:1000,height:300});
});
test('pointer and keyboard movement stay within bounded coordinates and sizes',()=>{
 const value={x:20,y:20,width:350,height:180};
 assert.deepEqual(adjust(value,'move',-999,-999,900),{x:0,y:0,width:350,height:180});
 assert.deepEqual(adjust(value,'move',99999,99999,900),{x:550,y:16384,width:350,height:180});
 assert.deepEqual(adjust(value,'resize',-999,-999,900),{x:20,y:20,width:200,height:80});
 assert.deepEqual(adjust(value,'resize',99999,99999,900),{x:20,y:20,width:880,height:4096});
});
function fixture() {
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),requests=[],messages=[],cache=[];
 let actor='A';
 const context={state:{startDashboardPreferences:{version:3,hidden:[]}},startDashboardPreferenceActorEpoch:1,
  startDashboardPreferenceSaveRevision:0,startDashboardPreferenceSaveQueue:Promise.resolve(),
  canUseStartDashboardWorkspace:()=>true,startDashboardWorkspaceActorKey:()=>actor,
  normalizeStartDashboardPreferences:value=>structuredClone(value),startDashboardPreferencesStorageKey:()=>actor,
  localStorage:{setItem:(key,value)=>cache.push({key,value})},renderStartDashboard(){},
  showToast:(...args)=>messages.push(args),api:(url,options)=>{const request=deferred();requests.push({url,options,...request});return request.promise;}};
 vm.createContext(context);const start=source.indexOf('async function persistStartDashboardPreferences(');
 vm.runInContext(source.slice(start,source.indexOf('\n}',start)+2),context);
 return {context,requests,messages,cache,actor(value){actor=value;context.startDashboardPreferenceActorEpoch++;}};
}
test('actual V3 save path serializes immutable snapshots and ignores older replies',async()=>{
 const f=fixture(),first={version:3,hidden:['loans']},second={version:3,hidden:['sales']};
 const a=f.context.persistStartDashboardPreferences(first);first.hidden.push('tampered');
 const b=f.context.persistStartDashboardPreferences(second);await tick();assert.equal(f.requests.length,1);
 assert.deepEqual(JSON.parse(f.requests[0].options.body).startDashboardPreferences.hidden,['loans']);
 f.requests[0].resolve({startDashboardPreferences:{version:3,hidden:['old']}});await tick();assert.equal(f.requests.length,2);
 assert.deepEqual(f.context.state.startDashboardPreferences.hidden,['sales']);
 f.requests[1].resolve({});assert.deepEqual(await Promise.all([a,b]),[false,true]);
 assert.equal(f.messages.length,1);
});
test('actual V3 late errors and account-away-back epochs never replace later local input',async()=>{
 const f=fixture();const a=f.context.persistStartDashboardPreferences({version:3,hidden:['loans']});await tick();
 const b=f.context.persistStartDashboardPreferences({version:3,hidden:['sales']});
 f.requests[0].reject(Error('old failure'));await tick();assert.equal(f.messages.length,0);
 f.requests[1].reject(Error('latest failure'));assert.deepEqual(await Promise.all([a,b]),[false,false]);
 assert.deepEqual(f.context.state.startDashboardPreferences.hidden,['sales']);assert.equal(f.messages[0][0],'latest failure');
 const c=f.context.persistStartDashboardPreferences({version:3,hidden:[]});await tick();
 f.actor('B');f.actor('A');f.requests[2].resolve({startDashboardPreferences:{version:3,hidden:['wrong']}});
 assert.equal(await c,false);assert.equal(f.messages.length,1);
});
test('actual global reset clears labels and geometry while preserving selected business scope',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');let handler,resets=0,saved=null;
 const context={elements:{startDashboardResetButton:{addEventListener:(name,fn)=>{handler=fn;}}},
  state:{startDashboardPreferences:{version:3,hidden:['sales'],locationId:'18',departmentId:'4',salesLocationId:'19'}},
  startDashboardWorkspace:{store:{ready:true},resetAll(){resets++;}},canUseStartDashboardWorkspace:()=>true,
  normalizeStartDashboardPreferences:value=>value,defaultStartDashboardPreferences:()=>({version:3,hidden:[],hiddenWidgets:[]}),
  renderStartDashboardCustomizer(){},persistStartDashboardPreferences:async value=>{saved=value;}};
 vm.createContext(context);const start=source.indexOf('elements.startDashboardResetButton?.addEventListener');
 vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),context);
 await handler();assert.equal(resets,1);assert.deepEqual(JSON.parse(JSON.stringify(saved)),{version:3,hidden:[],hiddenWidgets:[],locationId:'18',departmentId:'4',salesLocationId:'19'});
 context.startDashboardWorkspace.store.ready=false;await handler();assert.equal(resets,1);
});
