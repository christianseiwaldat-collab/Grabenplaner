'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const E = require('../public/trade-export-options');
const P = require('../public/trade-pdf-request'), B = require('../public/gp-branch-order-pdf-window');
const createMount = () => E.mount;
const tick = () => new Promise(setImmediate);
const context = () => ({ owner:'actor:scope', key:()=> 'actor:scope', canUse:()=>true, signal:new AbortController().signal });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };

test('PDF generation keeps the entire captured query and the server result, independent of the currently displayed rows', async () => {
  const source = { kind:'purchasing', title:'Jahreseinkauf', query:{locationId:'18',dateFrom:'2026-01-01',dateTo:'2026-12-31'}, sort:'date', direction:'desc' };
  const payload = P.capturedTarget(source); source.query.locationId='99';
  const calls=[]; let polls=0;
  const target = await P.completeTarget(payload, { ...context(), wait: async()=>{}, api:async(path,body)=>{
    calls.push({path,body});
    return path==='jobs'&&body?{id:'job-full'}:[{id:'job-full',status:++polls===1?'running':'completed',accessible:true,count:16344}];
  }});
  assert.deepEqual(calls[0].body,{kind:'purchasing',title:'Jahreseinkauf',query:{locationId:'18',dateFrom:'2026-01-01',dateTo:'2026-12-31'}});
  assert.equal(target,'/api/trade-insights/jobs/job-full/pdf?sort=date&direction=desc');
  assert.equal(calls.some(call=>Object.hasOwn(call.body||{},'rows')),false);
  await P.completeTarget(payload,{...context(),wait:async()=>{},api:async()=>[{id:'job-full',status:'completed'}]});
  assert.equal(calls.filter(call=>call.body).length,1);
});

test('Job polling stops after an account or permission change, even when the server response arrives late', async () => {
  for (const change of ['actor','rights','signal']) {
    const pending=deferred(), abort=new AbortController(); let key='a', allowed=true, calls=0;
    const waiting=P.completeTarget(P.capturedTarget({kind:'inventory',query:{}}),{owner:'a',key:()=>key,canUse:()=>allowed,signal:abort.signal,api:async()=>{calls++;return pending.promise;}});
    if(change==='actor')key='b';if(change==='rights')allowed=false;if(change==='signal')abort.abort();
    pending.resolve({id:'new-job'});
    await assert.rejects(waiting,{name:'AbortError'});assert.equal(calls,1);
  }
});

test('Completed inaccessible, missing, failed and cancelled jobs do not produce a PDF URL', async () => {
  for (const row of [null,{status:'completed',accessible:false},{status:'failed'},{status:'cancelled'},{status:'unknown'}]) {
    const payload=P.capturedTarget({kind:'inventory',query:{}});payload.jobId='j';
    await assert.rejects(P.completeTarget(payload,{...context(),api:async()=>row?[{id:'j',...row}]:[]}));
  }
});

test('Abortable poll delay clears its timer immediately', async () => {
  const abort=new AbortController();let cleared=false;
  const waiting=P.delay(1500,abort.signal,{setTimeout:()=>17,clearTimeout:id=>{assert.equal(id,17);cleared=true;}});
  abort.abort();await assert.rejects(waiting,{name:'AbortError'});assert.equal(cleared,true);
});

test('All four established filename options and the full 110-character base name reach the existing PDF endpoint', () => {
  const name='a'.repeat(110), settings={stamp:'date-suffix',position:'after',separator:' ',suffix:'Filiale18'};
  const result=P.downloadUrl('/api/trade-insights/jobs/job/pdf?sort=date&direction=desc',{name,settings,validateOptions:E.options,origin:'https://gp.example'});
  const url=new URL(result,'https://gp.example');
  assert.equal(url.searchParams.get('name'),name);assert.equal(url.searchParams.get('sort'),'date');assert.equal(url.searchParams.get('direction'),'desc');
  for(const [key,value]of Object.entries(settings))assert.equal(url.searchParams.get(key),value);
  for(const url of ['https://other.example/api/trade-insights/jobs/j/pdf','/api/trade-insights/jobs/j','/api/trade-insights/jobs/j/pdf#x','/api/portal/v1/branch-orders/j/pdf'])assert.throws(()=>P.downloadUrl(url,{name:'A',settings:{},validateOptions:E.options,origin:'https://gp.example'}));
  assert.throws(()=>P.downloadUrl('/api/trade-insights/jobs/j/pdf',{name:'a'.repeat(111),settings:{},validateOptions:E.options,origin:'https://gp.example'}));
  assert.throws(()=>P.downloadUrl('/api/trade-insights/jobs/j/pdf',{name:'A',settings:{employeeNumber:'other'},validateOptions:E.options,origin:'https://gp.example'}));
});

function standardFixture() {
  let config, payload, opens=0, resets=0;
  const controller={open(input){payload=input.payload;opens++;return true;},reset(){resets++;},sync(){return true;},activate(){},deactivate(){},destroy(){},state:{},element:{}};
  const document={defaultView:{AbortController,location:{origin:'https://gp.example'},GpExistingPdfWindow:{mount(value){config=value;return controller;}}}};
  return {document,root:{ownerDocument:document},get config(){return config;},get payload(){return payload;},get opens(){return opens;},get resets(){return resets;}};
}

function renderedTradeSettings(f, actor) {
  const fields=Object.fromEntries(['Name','Stamp','Position','Separator','Suffix'].map(name=>['tradePdf'+name,{value:'',addEventListener(){},removeEventListener(){}}]));
  const other={addEventListener(){},removeEventListener(){},textContent:''};
  const host={addEventListener(){},removeEventListener(){},
    set innerHTML(html){for(const match of html.matchAll(/name="(tradePdf\w+)"[^>]*value="([^"]*)"/g))fields[match[1]].value=match[2];},
    querySelector(selector){return fields[selector.match(/name="(\w+)"/)?.[1]]||other;}};
  const dispose=f.config.renderOptions(host,{payload:f.payload,actor});
  const result=f.config.readOptions(host).settings;dispose();return result;
}

test('Late old-account export preferences never replace the new account defaults or its successfully loaded preferences',async()=>{
  for(const newLoadFails of [false,true]){
    const f=standardFixture(),late=deferred();let actor='a',phase='initial';
    const old={stamp:'date-suffix',position:'after',separator:'_',suffix:'Old account'};
    const fresh={stamp:'date',position:'after',separator:' ',suffix:'New account'};
    const workspace=E.mount(f.root,{rawApi:()=>{},accessKey:()=>actor,scopeKey:()=> 'stock:inventory',api:async(path)=>{
      if(path!=='export-options')return [];
      if(phase==='initial')return old;
      if(phase==='old-late')return late.promise;
      if(newLoadFails)throw Error('New account load failed');
      return fresh;
    }});
    await workspace.open({url:'/api/trade-insights/jobs/j/pdf',title:'A'});
    assert.deepEqual(renderedTradeSettings(f,actor),old);
    phase='old-late';const pending=workspace.open({url:'/api/trade-insights/jobs/j/pdf',title:'A'});
    actor='b';workspace.sync();phase='new';
    assert.equal(await workspace.open({url:'/api/trade-insights/jobs/k/pdf',title:'B'}),true);
    const expected=newLoadFails?E.defaults:fresh;
    assert.deepEqual(renderedTradeSettings(f,actor),expected);
    late.resolve({...old,suffix:'Late private old value'});assert.equal(await pending,false);
    assert.deepEqual(renderedTradeSettings(f,actor),expected);
    workspace.destroy();
  }
});

test('Editing PDF filename options reuses one complete job, without automatically saving preference changes', async () => {
  const f=standardFixture();let creates=0,saves=0;
  const api=async(path,body)=>{
    if(path==='export-options'){if(body)saves++;return {...E.defaults};}
    if(body){creates++;return{id:'j'};}return[{id:'j',status:'completed',accessible:true}];
  };
  const workspace=createMount(E,P)(f.root,{api,rawApi:()=>{},accessKey:()=> 'a',scopeKey:()=> 'stock:inventory',canUse:()=>true,active:()=>true});
  assert.equal(await workspace.open({kind:'inventory',query:{days:'180'},title:'Inventar'}),true);
  const actor=f.config.key(),signal=new AbortController().signal;
  const first=await f.config.request({payload:f.payload,actor,signal,options:{name:'Inventar',settings:{...E.defaults}}});
  const second=await f.config.request({payload:f.payload,actor,signal,options:{name:'Auswahl',settings:{stamp:'none',position:'after',separator:'_',suffix:''}}});
  assert.match(first.url,/\/jobs\/j\/pdf/);assert.match(second.url,/name=Auswahl/);assert.equal(creates,1);assert.equal(saves,0);assert.equal(f.config.useServerFilename,true);
  workspace.destroy();
});

test('Closing the trade window cancels incomplete result creation and prevents a late PDF request', async () => {
  const f=standardFixture(),pending=deferred();let calls=0;
  const workspace=createMount(E,P)(f.root,{api:async(path,body)=>path==='export-options'?{...E.defaults}:(calls++,pending.promise),rawApi:()=>{},accessKey:()=> 'a',scopeKey:()=> 's'});
  await workspace.open({kind:'inventory',query:{},title:'A'});
  const waiting=f.config.request({payload:f.payload,actor:f.config.key(),signal:new AbortController().signal,options:{name:'A',settings:{...E.defaults}}});
  workspace.close();pending.resolve({id:'late'});
  await assert.rejects(waiting,{name:'AbortError'});assert.equal(calls,1);assert.ok(f.resets>0);
});

test('Branch order requests preserve archived originals and cannot cross account, location, page or current history selection', () => {
  for(const changed of ['actor','scope','page','rights','history']){
    const f=standardFixture(),order={id:'order/original',calendarWeek:41,submittedAt:'2026-10-10T12:00:00Z'};
    let actor='a',scope='18',page=true,rights=true,orders=[order];
    const workspace=B.mount({document:f.document,rawApi:()=>{},key:()=>actor,scopeKey:()=>scope,canUse:()=>rights,active:()=>page,orders:()=>orders});
    assert.equal(workspace.open(order),true);assert.deepEqual(f.config.request({payload:f.payload}),{url:'/api/portal/v1/branch-orders/order%2Foriginal/pdf'});
    assert.deepEqual(f.config.commonFields,{title:'readonly',filename:true,orientation:false});assert.match(f.config.summary,/Unverändertes Original/);
    if(changed==='actor')actor='b';if(changed==='scope')scope='99';if(changed==='page')page=false;if(changed==='rights')rights=false;if(changed==='history')orders=[];
    assert.equal(f.config.canUse(),changed==='page');assert.throws(()=>f.config.request({payload:f.payload}),{name:'AbortError'});
    workspace.deactivate();assert.ok(f.resets>0);
  }
});

test('Branch order window refuses an order not in the current authorized history',()=>{
  const f=standardFixture(),workspace=B.mount({document:f.document,rawApi:()=>{},key:()=> 'a',scopeKey:()=> '18',canUse:()=>true,active:()=>true,orders:()=>[]});
  assert.equal(workspace.open({id:'other'}),false);assert.equal(f.opens,0);assert.throws(()=>B.pdfUrl(''));assert.throws(()=>B.pdfUrl('a\nb'));
});

test('Navigation deactivates trade requests while retaining window payload and export options for the same domain',async()=>{
 const f=standardFixture();let active=true,scope='stock:inventory';
 const workspace=createMount(E,P)(f.root,{api:async(path)=>path==='export-options'?{...E.defaults}:[],rawApi:()=>{},accessKey:()=> 'a',scopeKey:()=>scope,canUse:()=>true,active:()=>active});
 await workspace.open({url:'/api/trade-insights/jobs/j/pdf',title:'Bestand'});const payload=f.payload,resets=f.resets;
 active=false;workspace.deactivate();workspace.sync();assert.equal(f.resets,resets);assert.equal(f.config.canUse(),true);assert.equal(f.config.active(),false);assert.equal(f.payload,payload);
 await assert.rejects(f.config.request({payload,actor:'a',signal:new AbortController().signal,options:{name:'B',settings:{...E.defaults}}}),{name:'AbortError'});
 active=true;workspace.activate();workspace.sync();assert.equal(f.resets,resets);
 const request=await f.config.request({payload,actor:'a',signal:new AbortController().signal,options:{name:'B',settings:{...E.defaults}}});assert.match(request.url,/name=B/);
 scope='stock:movements';workspace.sync();assert.ok(f.resets>resets);workspace.destroy();
});

test('Navigation preserves an unchanged branch order selection but rejects its PDF until the page is active again',()=>{
 const f=standardFixture(),order={id:'one',calendarWeek:41};let page=true;
 const workspace=B.mount({document:f.document,rawApi:()=>{},key:()=> 'a',scopeKey:()=> '18',canUse:()=>true,active:()=>page,orders:()=>[order]});
 workspace.open(order);const payload=f.payload,resets=f.resets;page=false;workspace.deactivate();workspace.sync();assert.equal(f.resets,resets);assert.equal(f.config.canUse(),true);
 assert.throws(()=>f.config.request({payload}),{name:'AbortError'});page=true;workspace.activate();workspace.sync();assert.equal(f.resets,resets);assert.match(f.config.request({payload}).url,/branch-orders\/one\/pdf/);workspace.destroy();
});

test('An untouched order filename uses the archived server name; a chosen filename changes only the download name', () => {
  const f=standardFixture(),order={id:'one',calendarWeek:41,submittedAt:'2026-10-10T00:00:00Z'};
  B.mount({document:f.document,rawApi:()=>{},key:()=> 'a',scopeKey:()=> '18',canUse:()=>true,active:()=>true,orders:()=>[order]}).open(order);
  assert.equal(f.config.useServerFilename({payload:f.payload,values:{filename:f.payload.filename}}),true);
  assert.equal(f.config.useServerFilename({payload:f.payload,values:{filename:'Mein Download'}}),false);
});

function portalFixture() {
  const source=fs.readFileSync(path.join(__dirname,'../public/portal.js'),'utf8');
  const helper=source.slice(source.indexOf('function branchOrderPdfScope()'),source.indexOf('function renderBranchOrderPortalHistory()'));
  const f={user:{homeLocationId:'18',permissions:['branch_orders:submit','branch_orders:manage'],role:'admin'},portalWindowActor:'a',
    portalState:{session:{authenticated:true},activeTab:'branchOrders',branchOrderPortalHistory:[],branchOrderHistory:[]},
    document:{},api:async()=>({orders:[]}),el:{branchOrderPortalHistoryList:{innerHTML:''},branchOrderHistoryList:{innerHTML:''}},
    renders:0,mounts:[],esc:String,syncPortalWindows(){},
    portalUser(){return f.user;},branchOrderCapabilityEnabled(){return f.user.permissions.includes('branch_orders:submit');},
    branchOrderManagementEnabled(){return f.user.permissions.includes('branch_orders:manage')&&f.user.role==='admin';},
    renderBranchOrderPortalHistory(){f.renders++;},renderBranchOrderHistory(){f.renders++;},portalWindowManager:{preferences:{}},window:{}};
  f.window.GpBranchOrderPdfWindow={mount(config){const controller={config,payload:null,deactivations:0,open(order){this.payload=order;},activate(){},deactivate(){this.deactivations++;},sync(){if(!config.canUse())this.payload=null;},reset(){this.payload=null;}};f.mounts.push(controller);return controller;}};
  vm.runInNewContext('const branchOrderPrintWindows=new Map(),branchOrderPdfOwners=new Map(),branchOrderPdfRequests=new Map();\n'+helper+
    '\nthis.hooks={loadBranchOrderPdfHistory,openBranchOrderPdf,syncBranchOrderPrintWindows};',f);
  return f;
}

test('Both Portal order histories reject late responses after account, location, permission or newer request changes',async()=>{
  for (const kind of ['submit','manage']) for (const changed of ['actor','scope','rights','request']) {
    const f=portalFixture(),late=deferred();f.api=()=>late.promise;
    const pending=f.hooks.loadBranchOrderPdfHistory(kind);
    if(changed==='actor')f.portalWindowActor='b';if(changed==='scope')f.user.homeLocationId='99';if(changed==='rights')f.user.permissions=[];
    if(changed==='request'){f.api=async()=>({orders:[{id:'newer'}]});await f.hooks.loadBranchOrderPdfHistory(kind);}
    late.resolve({orders:[{id:'old'}]});await pending;
    const orders=kind==='submit'?f.portalState.branchOrderPortalHistory:f.portalState.branchOrderHistory;
    assert.deepEqual(orders.map(order=>order.id),changed==='request'?['newer']:[]);
    assert.equal(f.renders,changed==='request'?1:0);
  }
});

test('Portal order preview requires current history ownership and retains options only during same-account navigation',async()=>{
  for(const kind of ['submit','manage']){
    const f=portalFixture();f.portalState.activeTab=kind==='submit'?'branchOrders':'settings';f.api=async()=>({orders:[{id:'original'}]});
    f.hooks.openBranchOrderPdf(kind,'original',{});assert.equal(f.mounts.length,0);
    await f.hooks.loadBranchOrderPdfHistory(kind);f.hooks.openBranchOrderPdf(kind,'original',{});assert.equal(f.mounts.length,1);
    const controller=f.mounts[0];assert.equal(controller.config.canUse(),true);
    f.portalState.activeTab='home';f.hooks.syncBranchOrderPrintWindows();assert.equal(controller.payload.id,'original');assert.equal(controller.config.canUse(),true);assert.equal(controller.config.active(),false);
    f.portalWindowActor='b';f.hooks.syncBranchOrderPrintWindows();assert.equal(controller.payload,null);assert.equal(controller.config.canUse(),false);
    assert.equal((kind==='submit'?f.portalState.branchOrderPortalHistory:f.portalState.branchOrderHistory).length,0);
    f.portalState.activeTab=kind==='submit'?'branchOrders':'settings';f.hooks.openBranchOrderPdf(kind,'original',{});assert.equal(controller.payload,null);
  }
});

test('Portal order failures from an old account cannot replace the current history; current revocation resets its preview',async()=>{
  const f=portalFixture(),late=deferred();f.api=()=>late.promise;
  const pending=f.hooks.loadBranchOrderPdfHistory('submit');f.portalWindowActor='b';late.reject(Error('private old error'));await pending;
  assert.equal(f.el.branchOrderPortalHistoryList.innerHTML,'');
  f.api=async()=>({orders:[{id:'one'}]});await f.hooks.loadBranchOrderPdfHistory('submit');f.hooks.openBranchOrderPdf('submit','one',{});
  f.api=async()=>{throw Object.assign(Error('Zugriff entzogen'),{status:403});};await f.hooks.loadBranchOrderPdfHistory('submit');
  assert.equal(f.mounts[0].payload,null);assert.equal(f.portalState.branchOrderPortalHistory.length,0);assert.match(f.el.branchOrderPortalHistoryList.innerHTML,/Zugriff entzogen/);
});

test('All three order surfaces load the standard adapter and use its original-order action',()=>{
  const read=name=>fs.readFileSync(path.join(__dirname,'../public',name),'utf8');
  for(const name of ['index.html','portal.html'])assert.equal((read(name).match(/src="\/gp-branch-order-pdf-window\.js"/g)||[]).length,1);
  const app=read('app.js'),portal=read('portal.js');
  assert.match(app,/data-branch-order-pdf="\$\{escapeHtml\(order.id\)\}"/);
  assert.match(app,/window\.GpBranchOrderPdfWindow\.mount\(/);
  assert.match(app,/api, rawApi, accessKey: startDashboardWorkspaceActorKey, canUse: canAccessTradeInsights/);
  assert.equal((portal.match(/data-branch-order-pdf="\$\{esc\(order.id\)\}"/g)||[]).length,2);
});
