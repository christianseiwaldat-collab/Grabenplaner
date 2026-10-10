'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const Planning=require('../public/gp-planning-print'),Existing=require('../public/gp-existing-pdf-window');
function fixture(kind='schedule'){
 let context={page:kind==='schedule'?'planning':'vacations',query:kind==='schedule'?{week:'2026-10-05',location:'18',department:'3'}:{year:'2026',view:'quarter',quarter:'4',month:'10',location:'18'},settings:{pdf_title:'My schedule',pdf_filename_prefix:'Schedule',vacation_pdf_title:'My vacation',vacation_pdf_filename_prefix:'Vacation'},designs:[{id:'matrix',label:'Compact'},{id:'timeline',label:'Timeline'}],modelRevision:1},allowed=true,owner='one',passed,input;
 const response={ok:true,headers:new Headers({'Content-Disposition':'attachment; filename="Original-Plan.pdf"'}),blob:async()=>new Blob(['%PDF-1.7 unchanged'],{type:'application/pdf'})};
 let api=async()=>response;
 const controller={open(value){input=value;return passed.canUse();},activate(){},deactivate(){},reset(){},sync(){},destroy(){}};
 const doc={defaultView:{location:{origin:'https://gp.example.test'},GpExistingPdfWindow:Existing,GpPrintWindow:{mount(config){passed=config;return controller;}}}};
 const print=Planning.mount({document:doc,kind,rawApi:(...args)=>api(...args),key:()=>owner,canUse:()=>allowed,context:()=>context});
 return{print,response,get context(){return context;},change(value){context={...context,...value};},allow(value){allowed=value;},owner(value){owner=value;},api(value){api=value;},get config(){return passed;},get input(){return input;}};
}
test('schedule keeps active design rank and exact week/location/department context without global mutations',()=>{
 const f=fixture();assert.equal(f.print.open(),true);assert.equal(f.input.payload.design,'matrix');
 const request=f.config.request({payload:f.input.payload,options:{design:'timeline'}});const url=new URL(request.url,'https://gp.example.test');
 assert.equal(url.pathname,'/api/schedule.pdf');assert.deepEqual(Object.fromEntries(url.searchParams),{week:'2026-10-05',location:'18',department:'3',design:'timeline'});
 assert.throws(()=>f.print.open({design:'unsaved'}),/gespeichertes aktives/);
});
test('department output preserves selected departmentId while source context is separately guarded',()=>{
 const f=fixture();f.print.open({departmentId:'7'});const request=f.config.request({payload:f.input.payload,options:{design:'matrix'}}),url=new URL(request.url,'https://gp.example.test');
 assert.equal(url.searchParams.get('departmentId'),'7');assert.equal(url.searchParams.has('department'),false);assert.equal(f.context.query.department,'3','Source context is not mutated');
 f.change({query:{...f.context.query,location:'19'}});assert.equal(f.config.canUse(),false);assert.throws(()=>f.config.request({payload:f.input.payload,options:{design:'matrix'}}),/Planungsstand/);
});
test('vacation retains year/view/quarter/month and fixed paper controls',()=>{
 const f=fixture('vacation');assert.equal(f.print.open(),true);const request=f.config.request({payload:f.input.payload,options:{}});
 assert.deepEqual(Object.fromEntries(new URL(request.url,'https://gp.example.test').searchParams),{year:'2026',view:'quarter',quarter:'4',month:'10',location:'18'});
 assert.deepEqual(f.config.commonFields,{title:'readonly',filename:true,orientation:false});
 f.change({query:{...f.context.query,year:'2027'}});assert.equal(f.config.canUse(),false);
});
test('late PDF responses are discarded after page, plan, settings, permission or owner changes',async()=>{
 for(const mutate of [f=>f.change({page:'startDashboard'}),f=>f.change({query:{...f.context.query,week:'2026-10-12'}}),f=>f.change({modelRevision:2}),f=>f.change({settings:{...f.context.settings,pdf_title:'Changed'}}),f=>f.allow(false),f=>f.owner('two')]){
  const f=fixture();f.print.open();let release;f.api(()=>new Promise(resolve=>{release=resolve;}));
  const input={actor:'one',signal:new AbortController().signal,payload:f.input.payload,values:f.input.values,options:{design:'matrix'}};
  const pending=f.config.createPdf(input);await Promise.resolve();mutate(f);release(f.response);await assert.rejects(pending,{name:'AbortError'});
 }
});
test('unchanged planning filename preserves server conventions and a custom filename remains usable',async()=>{
 const f=fixture();f.print.open();const input={actor:'one',signal:new AbortController().signal,payload:f.input.payload,values:f.input.values,options:{design:'matrix'}};
 assert.equal((await f.config.createPdf(input)).filename,'Original-Plan.pdf');input.values={...input.values,filename:'My renamed plan'};
 assert.equal((await f.config.createPdf(input)).filename,'My renamed plan');
});
test('settings preview actions only open the GP print window and never save general settings',async()=>{
 const source=fs.readFileSync(require.resolve('../public/app'),'utf8'),start=source.indexOf('async function generateSchedulePdfPreview() {'),end=source.indexOf('let toastTimer;',start);
 const opens=[],sandbox={elements:{schedulePdfPreviewDesign:{value:'matrix'},schedulePdfPreviewButton:{id:'schedule'},vacationPdfPreviewButton:{id:'vacation'}},schedulePdfDesignIdsFromSettings:()=>['timeline'],openPlanningPdf:(...args)=>opens.push(args),saveSettings:()=>{throw Error('Unexpected global settings write');}};
 vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);await sandbox.generateSchedulePdfPreview();await sandbox.generateVacationPdfPreview();
 assert.equal(opens.length,2);assert.equal(opens[0][0],'schedule');assert.equal(opens[0][1].design,'matrix');assert.equal(opens[1][0],'vacation');
});

test('ordinary page changes suspend visibility but preserve authority and options until the business source changes',()=>{
 const f=fixture();f.print.open();f.change({page:'settings'});assert.equal(f.config.canUse(),true);assert.equal(f.config.active(),false);
 f.change({page:'planning'});assert.equal(f.config.canUse(),true);assert.equal(f.config.active(),true);
 f.change({query:{...f.context.query,location:'19'}});assert.equal(f.config.canUse(),false);
});

test('application navigation deactivates unavailable pages without resetting retained planning choices',()=>{
 const source=fs.readFileSync(require.resolve('../public/app'),'utf8');function take(name){const begin=source.indexOf('function '+name+'('),end=source.indexOf('\n}',begin)+2;return source.slice(begin,end);}
 const calls=[],print={activate:()=>calls.push('activate'),deactivate:()=>calls.push('deactivate'),sync:()=>calls.push('sync'),reset:()=>{throw Error('Navigation reset loses draft');}};
 const state={currentView:'planning'},sandbox={state,planningPrintWindows:{schedule:print},canUsePlanningPrint:()=>true};vm.createContext(sandbox);vm.runInContext(take('planningPrintPageAllowed')+'\n'+take('syncPlanningPrintWindows'),sandbox);
 sandbox.syncPlanningPrintWindows();state.currentView='sales';sandbox.syncPlanningPrintWindows();state.currentView='planning';sandbox.syncPlanningPrintWindows();assert.deepEqual(calls,['activate','sync','deactivate','sync','activate','sync']);
});

test('real shell sync reaches Planning before dependency early-return and logout clears it after session withdrawal',()=>{
 const source=fs.readFileSync(require.resolve('../public/app'),'utf8'),take=name=>{const begin=source.indexOf('function '+name+'('),end=source.indexOf('\n}',begin)+2;return source.slice(begin,end);};
 const calls=[],state={currentView:'planning',portalStatus:{portalEnabled:true},portalSession:{authenticated:true,user:{}}},print={activate:()=>calls.push('activate'),deactivate:()=>calls.push('deactivate'),sync:()=>calls.push('sync')};
 const sandbox={state,window:{},syncSettingsSaveScopes(){},planningPrintWindows:{schedule:print},canReadStartDashboardSchedule:()=>true,canReadStartDashboardVacations:()=>true};vm.createContext(sandbox);vm.runInContext(['canUsePlanningPrint','planningPrintPageAllowed','syncPlanningPrintWindows','syncGpWindows'].map(take).join('\n'),sandbox);
 sandbox.syncGpWindows();state.currentView='sales';sandbox.syncGpWindows();assert.deepEqual(calls,['activate','sync','deactivate','sync']);
 const logout=take('showLoginGate');assert.ok(logout.indexOf('syncPlanningPrintWindows();')>logout.indexOf('state.portalSession = null;'));
 vm.runInContext(logout.slice(logout.indexOf('  state.portalSession = null;'),logout.indexOf('  gpDocumentPrint?.reset();')),sandbox);assert.equal(state.portalSession,null);assert.deepEqual(calls.slice(-2),['deactivate','sync']);
 assert.match(take('setView'),/syncGpWindows\(\)/,'The production navigation path must invoke the shared lifecycle sync');
});
