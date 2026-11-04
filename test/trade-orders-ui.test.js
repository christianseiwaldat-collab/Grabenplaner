'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createController,fieldList}=require('../public/trade-orders');
const context={projection:{purchasing:true},purchasingLocations:[{id:'18',label:'Synthetic branch'}]},row={id:'order-1',revision:1,orderNumber:'1'},revision='source-1';
const result=(rows=[row],next=null)=>({available:true,rows,next,sourceRevision:revision,coverage:{complete:!next},sources:{}});
function fixture(){const calls=[],changes=[],actor={key:'actor-A',session:{id:'A'},allowed:true,page:true};const controller=createController({key:()=>actor.key,session:()=>actor.session,canUse:()=>actor.allowed,pageActive:()=>actor.page,change:s=>changes.push(s.message),api:(url,options)=>new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}))});return {controller,calls,actor,changes};}
const tick=()=>new Promise(setImmediate);
async function activated(f){const pending=f.controller.activate();f.calls.at(-1).resolve(context);await pending;}
async function searched(f,query={query:'BE-1',mode:'exact'}){f.controller.setQuery(query);const pending=f.controller.search();f.calls.at(-1).resolve(result());await pending;}
test('Orders mount/controller stays lazy and retains search controls across navigation with fresh results',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);await activated(f);assert.equal(f.calls.length,1);await searched(f);
 f.controller.suspend();assert.equal(f.controller.getState().rows.length,0);assert.equal(f.controller.getState().query.query,'BE-1');
 const again=f.controller.activate();f.calls.at(-1).resolve(context);await tick();assert.match(f.calls.at(-1).url,/\/orders$/);assert.equal(JSON.parse(f.calls.at(-1).options.body).query,'BE-1');f.calls.at(-1).resolve(result());await again;assert.equal(f.controller.getState().rows.length,1);
});
test('Search continuation handles empty nonterminal pages and preserves the source-bound query',async()=>{
 const f=fixture();await activated(f);f.controller.setQuery({query:'1',mode:'contains'});
 const first=f.controller.search();f.calls.at(-1).resolve(result([],'opaque-cursor'));await first;assert.equal(f.controller.getState().coverage.complete,false);
 const second=f.controller.search({more:true});assert.equal(JSON.parse(f.calls.at(-1).options.body).cursor,'opaque-cursor');f.calls.at(-1).resolve(result());await second;assert.equal(f.controller.getState().rows.length,1);assert.equal(f.controller.getState().coverage.complete,true);
});
test('Typing and searching during initial context loading retains the authorized receiving dropdown',async()=>{
 const f=fixture(),activation=f.controller.activate(),contextCall=f.calls[0];f.controller.setQuery({query:'1',mode:'exact'});const search=f.controller.search(),searchCall=f.calls.at(-1);
 assert.equal(contextCall.options.signal.aborted,false);searchCall.resolve(result());await search;contextCall.resolve(context);await activation;
 assert.deepEqual(f.controller.getState().context.purchasingLocations,context.purchasingLocations);assert.equal(f.calls.length,2);assert.equal(f.controller.getState().rows.length,1);
});
test('Changed form, actor/session ABA and revoked permissions reject late responses and clear sensitive results',async()=>{
 for(const mutation of [f=>f.controller.setQuery({query:'new',mode:'exact'}),f=>{f.actor.key='actor-B';},f=>{f.actor.session={id:'A'};},f=>{f.actor.allowed=false;},f=>{f.controller.suspend();}]){
  const f=fixture();await activated(f);f.controller.setQuery({query:'1',mode:'exact'});const pending=f.controller.search(),call=f.calls.at(-1);mutation(f);call.resolve(result());await pending;assert.equal(f.controller.getState().rows.length,0);
 }
});
test('Detail requests carry exact parent/source scope, abort on close and cannot revive a closed/replaced window',async()=>{
 const f=fixture();await activated(f);await searched(f);let pending=f.controller.open(row),call=f.calls.at(-1);
 assert.deepEqual(JSON.parse(call.options.body),{orderId:row.id,orderRevision:1,sourceRevision:revision,part:'header'});
 f.controller.closeDetail();assert.equal(call.options.signal.aborted,true);call.resolve({...result(),order:row,part:'header'});await pending;assert.equal(f.controller.getState().selected,null);
 pending=f.controller.open(row);call=f.calls.at(-1);call.resolve({...result([]),order:row,part:'header'});await pending;
 const first=f.controller.detail('positions'),old=f.calls.at(-1),second=f.controller.detail('receipts'),current=f.calls.at(-1);assert.equal(old.options.signal.aborted,true);
 current.resolve({...result([]),order:row,part:'receipts',available:false});await second;old.resolve({...result(),order:row,part:'positions'});await first;assert.equal(f.controller.getState().detail.part,'receipts');assert.equal(f.controller.getState().detail.available,false);
});
test('Source change or failed detail discards the entire mixed result and exposes a fresh-search state',async()=>{
 const f=fixture();await activated(f);await searched(f);const pending=f.controller.open(row);f.calls.at(-1).reject(Object.assign(new Error('Import changed'),{code:'IMPORT_HISTORY_ANALYSIS_CHANGED'}));await pending;
 assert.equal(f.controller.getState().selected,null);assert.equal(f.controller.getState().rows.length,0);assert.equal(f.controller.getState().sourceRevision,null);assert.equal(f.controller.getState().message,'Import changed');
});
test('All imported text renders as escaped text, including source memos and original keys',()=>{
 const html=fieldList({Text1:'<img src=x onerror=evil()>',BestellNr:'001'});assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/001/);
});
test('A source revision change on continuation clears the result instead of mixing pages',async()=>{
 const f=fixture();await activated(f);f.controller.setQuery({query:'',mode:'contains'});let pending=f.controller.search();f.calls.at(-1).resolve(result([row],'next'));await pending;
 pending=f.controller.search({more:true});f.calls.at(-1).resolve({...result([{...row,id:'different'}]),sourceRevision:'changed'});await pending;assert.equal(f.controller.getState().rows.length,0);assert.equal(f.controller.getState().next,null);assert.equal(f.controller.getState().error,true);
});
test('Denied authoritative context disables orders even if a browser capability became stale',async()=>{
 const f=fixture(),activation=f.controller.activate();f.calls[0].resolve({projection:{purchasing:false},locations:[]});await activation;f.controller.setQuery({query:'1',mode:'exact'});await f.controller.search();assert.equal(f.calls.length,1);assert.equal(f.controller.getState().rows.length,0);
});
test('Shell deep links, route recording and logistics access follow actual functions',()=>{
 const vm=require('node:vm'),{functionSource}=require('../test-support/xoffi-import-ui');
 const state={currentView:'startDashboard',portalSession:{user:{salesHistory:{read:true},salesAnalytics:{inventory:true},permissions:['sales:purchasing:read']}}},window={location:{search:'?view=logistics&section=orders'}},scope={state,window,URLSearchParams,logisticsTab:'purchasing',restoreRememberedOverallContext:()=>false,planningContextNeedsReload:()=>false,setView:view=>state.currentView=view,closeMobileNavigation(){}};
 const context=vm.createContext(scope);vm.runInContext(functionSource('applyRequestedView')+'\n'+functionSource('currentAdministrationRoute')+'\n'+functionSource('canReadTradeMovements'),context);
 vm.runInContext('applyRequestedView({loadContext:false});',context);assert.equal(state.currentView,'logistics');assert.equal(vm.runInContext('currentAdministrationRoute().section',context),'orders');assert.equal(vm.runInContext('canReadTradeMovements()',context),true);
 window.location.search='?view=logistics&section=unsupported';vm.runInContext('applyRequestedView({loadContext:false});',context);assert.equal(vm.runInContext('currentAdministrationRoute().section',context),'purchasing');
 state.portalSession.user.salesAnalytics.inventory=false;assert.equal(vm.runInContext('canReadTradeMovements()',context),false);
});
test('Starting a GP-window close rejects a pending detail before the close animation finishes',async()=>{
 const f=fixture();await activated(f);await searched(f);const pending=f.controller.open(row),call=f.calls.at(-1);f.controller.cancelDetail();assert.equal(call.options.signal.aborted,true);
 call.resolve({...result(),order:row,part:'header'});await pending;assert.equal(f.controller.getState().detail,null);f.controller.closeDetail();assert.equal(f.controller.getState().selected,null);
});
