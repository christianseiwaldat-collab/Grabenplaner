'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {DEFAULTS,contentBounds,viewportBounds,migrateGeometry,fit,defaultGeometry,attach,createPreferences} = require('../public/sales-article-search-window');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

const {documentFixture}=require('./helpers/gp-window-dom');
function domFixture(onChange, extra = {}) {
  const {win,doc,element}=documentFixture();
  const host=element('section',{},doc.body),title=element('header',{'data-article-window-title':''},host),move=element('button',{'data-article-window-move':''},title);
  const toggle=element('button',{'data-article-window-minimize':''},title),close=element('button',{'data-article-window-close':''},title);
  const body=element('div',{'data-article-window-body':''},host),input=element('input',{},body);
  const resize=element('button',{'data-article-window-resize':''},host),status=element('span',{'data-article-window-status':''},host);
  const saved=[],layouts=[];let bounds={left:250,top:130,width:1200,height:800},permitted=true,scale=1.25;
  const controller=attach(host,{window:win,bounds:()=>bounds,scale:()=>scale,canUse:()=>permitted,
    change:value=>{saved.push(value);onChange?.(value);},resize:value=>layouts.push(value),...extra});
  controller.activate();
  return {win,doc,host,title,move,toggle,close,body,input,resize,status,saved,layouts,controller,
    bounds(value){bounds=value;},permit(value){permitted=value;},scale(value){scale=value;}};
}

test('Legacy content bounds remain available for migration and convert GP zoom once', () => {
  assert.deepEqual(contentBounds({left:300,right:1500},{bottom:160},{width:1600,height:900},1.25),
    {left:240,top:134.4,width:960,height:579.2});
  const small=contentBounds({left:0,right:400},{bottom:160},{left:0,top:40,width:400,height:480},1);
  assert.deepEqual(small,{left:8,top:168,width:384,height:344});
  assert.equal(defaultGeometry({width:1200}).x,640);
});

test('Viewport geometry reaches the complete top-left corner and accounts for zoom and a visual viewport', () => {
  assert.deepEqual(viewportBounds({width:1600,height:900},1.25),{left:0,top:0,width:1280,height:720});
  assert.deepEqual(viewportBounds({left:20,top:60,width:400,height:480},1.25),{left:16,top:48,width:320,height:384});
  const f=domFixture(); f.bounds(viewportBounds({width:1600,height:900},1.25));
  f.controller.set({...DEFAULTS,x:350,y:130,width:500,height:400});
  f.host.emit('pointerdown',{target:f.move,clientX:300,clientY:150});
  f.host.emit('pointermove',{target:f.move,clientX:-999,clientY:-999});
  f.host.emit('pointerup',{target:f.move});
  assert.equal(f.host.style.left,'0px'); assert.equal(f.host.style.top,'0px');
  assert.equal(f.saved[0].x,0); assert.equal(f.saved[0].y,0);
  f.host.emit('keydown',{target:f.move,key:'End'});
  f.host.emit('keydown',{target:f.move,key:'Home'});
  assert.equal(f.host.style.left,'0px'); assert.equal(f.host.style.top,'0px');
  f.permit(false); f.controller.refresh(); assert.equal(f.host.hidden,true);
  f.controller.destroy();
});

test('V1 migration preserves visible placement and preferred size; V2 is never translated again', () => {
  const legacy={left:240,top:134,width:960,height:579}, bounds={left:0,top:0,width:1280,height:720};
  const old={...DEFAULTS,version:1,x:85,y:35,width:790,height:540,minimized:true};
  const upgraded=migrateGeometry(old,legacy,bounds);
  assert.deepEqual(upgraded,{...old,version:2,x:325,y:169});
  assert.deepEqual(migrateGeometry(upgraded,{...legacy,left:400,top:200},bounds),upgraded);
  assert.deepEqual(migrateGeometry({...upgraded,x:0,y:0},legacy,bounds),{...upgraded,x:0,y:0});
  const oversized=migrateGeometry({...old,width:1400,height:1000,minimized:false},legacy,bounds);
  assert.equal(oversized.x,240); assert.equal(oversized.y,134);
  assert.equal(oversized.width,1400); assert.equal(oversized.height,1000);
  const initial=migrateGeometry(null,legacy,bounds);
  assert.equal(initial.x,640); assert.equal(initial.y,134);
  const f=domFixture(undefined,{initialGeometry:() => initial});
  f.controller.set({...DEFAULTS,x:0,y:0}); f.controller.set(null);
  assert.deepEqual(f.controller.preferred,initial);
  f.controller.destroy();
});

test('Responsive fitting never replaces the account preference and minimized height remains restorable', () => {
  const preferred={...DEFAULTS,x:800,y:500,width:900,height:700};
  assert.deepEqual(fit(preferred,{width:300,height:250}),{...preferred,x:0,y:0,width:300,height:250});
  assert.equal(preferred.width,900);
  assert.equal(fit({...preferred,minimized:true},{width:1200,height:800}).height,44);
  const f=domFixture(); f.controller.set(preferred);
  f.bounds({left:8,top:130,width:270,height:200}); f.win.emit('resize');
  assert.equal(f.controller.fitted.width,270); assert.equal(f.controller.preferred.width,900);
  f.bounds({left:250,top:130,width:1200,height:800}); f.win.emit('resize');
  assert.equal(f.controller.fitted.width,900); assert.equal(f.controller.preferred.y,500);
  assert.equal(f.saved.length,0,'fitting alone must not save a constrained geometry');
  f.controller.destroy();
});

test('Touch/pointer dragging uses zoom, clamps bounds and commits once on release', () => {
  const f=domFixture(); f.controller.set({...DEFAULTS,x:100,y:40,width:500,height:400});
  f.host.emit('pointerdown',{target:f.move,clientX:20,clientY:20,pointerType:'touch'});
  f.host.emit('pointermove',{target:f.move,clientX:120,clientY:70,pointerType:'touch'});
  assert.equal(f.controller.preferred.x,180); assert.equal(f.controller.preferred.y,80); assert.equal(f.saved.length,0);
  f.host.emit('pointermove',{target:f.move,clientX:9999,clientY:9999});
  assert.equal(f.controller.preferred.x,700); assert.equal(f.controller.preferred.y,400);
  f.host.emit('pointerup',{target:f.move});
  assert.equal(f.saved.length,1); assert.equal(f.move.hasPointerCapture(1),false);
  assert.equal(f.host.style.left,'950px'); assert.equal(f.host.style.top,'530px');
});

test('Pointer cancellation, lost capture, Escape and denied access restore the last preference without writes', () => {
  for (const reason of ['pointercancel','lostpointercapture','Escape','deny']) {
    const f=domFixture(), original={...DEFAULTS,x:100,y:40,width:500,height:400}; f.controller.set(original);
    f.host.emit('pointerdown',{target:f.resize}); f.host.emit('pointermove',{target:f.resize,clientX:120,clientY:60});
    assert.notEqual(f.controller.preferred.width,500);
    if (reason==='Escape') { const e=f.doc.emit('keydown',{target:f.resize,key:'Escape'}); assert.equal(e.prevented,true); }
    else if (reason==='deny') {f.permit(false); f.host.emit('pointermove',{target:f.resize,clientX:130,clientY:70});}
    else f.host.emit(reason,{target:f.resize});
    assert.deepEqual(f.controller.preferred,original,reason); assert.equal(f.saved.length,0,reason);
  }
});

test('Keyboard move and corner resize are constrained; minimization preserves size and moves focus out of the hidden body', () => {
  const f=domFixture(); f.controller.set({...DEFAULTS,x:100,y:40,width:500,height:400});
  assert.equal(f.host.emit('keydown',{target:f.move,key:'ArrowRight',shiftKey:true}).prevented,true);
  f.host.emit('keydown',{target:f.resize,key:'ArrowDown'});
  assert.equal(f.controller.preferred.x,101); assert.equal(f.controller.preferred.height,410);
  f.host.emit('keydown',{target:f.resize,key:'End'});
  assert.equal(f.controller.fitted.width,1099); assert.equal(f.controller.fitted.height,760);
  f.input.focus(); f.toggle.emit('click');
  assert.equal(f.doc.activeElement,f.toggle); assert.equal(f.body.hidden,true); assert.equal(f.resize.hidden,true);
  assert.equal(f.toggle.getAttribute('aria-expanded'),'false'); assert.equal(f.controller.fitted.height,44);
  assert.equal(f.controller.preferred.height,760);
  f.controller.restore(); assert.equal(f.body.hidden,false); assert.equal(f.controller.fitted.height,760);
  f.controller.set(null); assert.deepEqual(f.controller.preferred,defaultGeometry({width:1200}));
  assert.match(f.status.textContent,/Fenster:/);
});

test('Close docks search without erasing selected work; navigation preserves dock and reopening is explicitly fresh',async()=>{
  let closed=0,fresh=0;
  const f=domFixture(undefined,{onClose(){closed++;},onFreshSearch(){fresh++;f.input.value='';}});
  f.input.value='Sony';f.controller.set({...DEFAULTS,width:900,height:700});
  await f.controller.close();assert.equal(closed,1);assert.equal(f.controller.docked,true);assert.equal(f.host.hidden,true);
  f.controller.suspend();f.controller.activate();assert.equal(f.host.hidden,true);assert.equal(f.input.value,'Sony');
  f.controller.reopenFresh();assert.equal(fresh,1);assert.equal(f.controller.docked,false);assert.equal(f.input.value,'');
  assert.equal(f.host.hidden,false);assert.equal(f.controller.preferred.width,900);assert.equal(f.controller.preferred.height,700);
  f.toggle.emit('click');assert.equal(f.controller.fitted.width,260);f.controller.restore();assert.equal(f.controller.fitted.width,900);
  f.controller.destroy();
});

function preferencesFixture(extra = {}) {
  let key='A|read', allowed=true; const applied=[],errors=[],requests=[];
  const controller=createPreferences({key:() => key,canUse:() => allowed,apply:value => applied.push(value),error:error => errors.push(error),
    api(url,options = {}) { const pending=deferred(); requests.push({url,options,...pending}); return pending.promise; },...extra});
  return {controller,applied,errors,requests,key(value) {key=value;},permit(value) {allowed=value;}};
}

test('A late GET cannot override manual movement', async () => {
  const f=preferencesFixture(), loading=f.controller.activate();
  const save=f.controller.change({...DEFAULTS,x:120,minimized:false}); await tick();
  assert.equal(f.requests[0].options.signal.aborted,true);
  f.requests[0].resolve({...DEFAULTS,x:5,minimized:true,configured:true}); await loading;
  assert.deepEqual(f.applied,[null]);
  f.requests[1].resolve({configured:true}); await save; assert.equal(f.errors.length,0);
});

test('V1 upgrade is saved once in the same queue and never overwrites a newer viewport movement', async () => {
  const migrate=value => migrateGeometry(value,{left:250,top:130,width:1200,height:800},{left:0,top:0,width:1600,height:1000});
  const f=preferencesFixture({migrate}), loading=f.controller.activate();
  f.requests[0].resolve({...DEFAULTS,version:1,x:20,y:30,configured:true}); await loading; await tick();
  const migrated={...DEFAULTS,x:270,y:160};
  assert.deepEqual(f.applied.at(-1),migrated);
  assert.deepEqual(JSON.parse(f.requests[1].options.body),migrated);
  const latest=f.controller.change({...DEFAULTS,x:0,y:0,width:900});
  f.controller.suspend(); await f.controller.activate();
  assert.equal(f.requests.length,2,'re-entry must not fetch coordinates older than the queued movement');
  f.requests[1].resolve({configured:true}); await tick();
  assert.deepEqual(JSON.parse(f.requests[2].options.body),{...DEFAULTS,x:0,y:0,width:900});
  f.requests[2].resolve({configured:true}); await latest;
  assert.equal(f.errors.length,0);
});

test('An invalidated or stale legacy read cannot migrate across movement, account, rights or navigation', async () => {
  for (const reason of ['movement','account','rights','navigation']) {
    let migrations=0;
    const f=preferencesFixture({migrate:value => {migrations++;return {...value,x:300};}}), loading=f.controller.activate();
    let save;
    if (reason==='movement') save=f.controller.change({...DEFAULTS,x:0,y:0});
    if (reason==='account') {f.key('B|read');f.controller.invalidate();}
    if (reason==='rights') {f.permit(false);f.controller.invalidate();}
    if (reason==='navigation') f.controller.suspend();
    f.requests[0].resolve({...DEFAULTS,version:1,configured:true}); await loading; await tick();
    assert.equal(migrations,0,reason);
    assert.equal(f.requests.length,reason==='movement' ? 2 : 1,reason);
    if (save) {f.requests[1].resolve({configured:true});await save;}
  }
});

test('A failed migration retries from V1 without double translation and cannot discard a newer queued edit', async () => {
  const migrate=value => migrateGeometry(value,{left:250,top:130,width:1200,height:800},{left:0,top:0,width:1600,height:1000});
  const f=preferencesFixture({migrate}), stored={...DEFAULTS,version:1,x:20,y:30,configured:true};
  const first=f.controller.activate(); f.requests[0].resolve(stored); await first; await tick();
  f.requests[1].reject(new Error('save failed')); await tick();
  f.controller.suspend(); const reload=f.controller.activate(); f.requests[2].resolve(stored); await reload; await tick();
  assert.equal(f.applied.at(-1).x,270); assert.equal(f.applied.at(-1).y,160);
  const latest=f.controller.change({...DEFAULTS,x:0,y:0});
  f.requests[3].reject(new Error('migration failed again')); await tick();
  f.controller.suspend(); await f.controller.activate();
  assert.equal(f.requests.length,5,'newer queued edit remains authoritative after a failed migration');
  assert.equal(JSON.parse(f.requests[4].options.body).x,0);
  f.requests[4].resolve({configured:true}); await latest;
  assert.equal(f.errors.length,2);
});

test('Navigation keeps all same-account keyboard saves and re-entry cannot reload older geometry over the latest edit', async () => {
  const f=preferencesFixture(), initial=f.controller.activate(); f.requests[0].resolve({configured:false}); await initial;
  const first=f.controller.change({...DEFAULTS,x:10});
  const second=f.controller.change({...DEFAULTS,x:20});
  const last=f.controller.change({...DEFAULTS,x:30}); await tick();
  f.controller.suspend(); assert.equal(f.requests[1].options.signal.aborted,false);
  f.requests[1].resolve({configured:true}); await first; await tick();
  assert.equal(JSON.parse(f.requests[2].options.body).x,20);
  f.requests[2].resolve({configured:true}); await second; await tick();
  assert.equal(JSON.parse(f.requests[3].options.body).x,30);
  await f.controller.activate(); assert.equal(f.requests.length,4,'cached latest edit must survive navigation');
  f.requests[3].resolve({configured:true}); await last;
  assert.equal(f.errors.length,0);
});

test('Actor/permission invalidation aborts pending writes and discards queued old-account saves', async () => {
  for (const reason of ['actor','permissions']) {
    const f=preferencesFixture(), initial=f.controller.activate(); f.requests[0].resolve({...DEFAULTS,configured:true}); await initial;
    const first=f.controller.change({...DEFAULTS,x:10}), queued=f.controller.change({...DEFAULTS,x:20}); await tick();
    f.key(reason==='actor' ? 'B|read' : 'A|newReadProjection'); f.controller.invalidate();
    assert.equal(f.requests[1].options.signal.aborted,true);
    const reload=f.controller.activate(); f.requests[2].resolve({...DEFAULTS,x:3,configured:true}); await reload;
    const next=f.controller.change({...DEFAULTS,x:77});
    f.requests[1].resolve({configured:true}); await first; await queued; await tick();
    assert.equal(f.requests.length,4); assert.equal(JSON.parse(f.requests[3].options.body).x,77);
    f.requests[3].resolve({configured:true}); await next;
    assert.equal(f.applied.at(-1).x,3); assert.equal(f.errors.length,0);
  }
});

test('READ denial and unload suppress late GET/error continuations and prevent queued saves', async () => {
  const f=preferencesFixture(), initial=f.controller.activate(); f.requests[0].resolve({configured:false}); await initial;
  const first=f.controller.change({...DEFAULTS,x:10}), queued=f.controller.change({...DEFAULTS,x:20}); await tick();
  f.permit(false); f.controller.invalidate(); f.controller.suspend();
  f.requests[1].reject(new Error('late aborted save')); await first; await queued;
  assert.equal(f.requests.length,2); assert.equal(f.errors.length,0);
  f.permit(true); const reentry=f.controller.activate();
  f.controller.suspend({abortWrites:true}); assert.equal(f.requests[2].options.signal.aborted,true);
  f.requests[2].resolve({...DEFAULTS,minimized:true,configured:true}); await reentry;
  assert.equal(f.applied.at(-1),null);
  const reload=f.controller.activate(); f.requests[3].resolve({...DEFAULTS,x:44,configured:true}); await reload;
  assert.equal(f.applied.at(-1).x,44);
});

test('A view-suspended GET is aborted and a new read alone can apply on re-entry', async () => {
  const f=preferencesFixture(), first=f.controller.activate(); f.controller.suspend();
  const second=f.controller.activate(); f.requests[0].resolve({...DEFAULTS,x:1,configured:true}); await first;
  assert.equal(f.requests[0].options.signal.aborted,true); assert.deepEqual(f.applied,[null]);
  f.requests[1].resolve({...DEFAULTS,x:2,configured:true}); await second;
  assert.equal(f.applied.at(-1).x,2);
});

test('App function-search target reveals the complete minimized search region before focusing and respects READ', async () => {
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const start=source.indexOf('async function revealSalesArticleSearchWindowTarget('), end=source.indexOf('\n}',start)+2;
  const f=domFixture(); f.toggle.emit('click'); let read=true;
  const ctx={document:{getElementById:id => ({salesArticleSearchWindow:f.host,salesArticleSearchQuery:f.input,other:{}})[id]},
    canReadSalesArticles:() => read,salesArticleSearchWindow:f.controller,salesArticleWindowPreferences:{activate:async () => {}},
    currentSalesArticleCatalogDetailAccessKey:() => 'A',state:{currentView:'articleCatalog'}};
  vm.createContext(ctx); vm.runInContext(source.slice(start,end),ctx);
  await ctx.revealSalesArticleSearchWindowTarget({view:'articleCatalog',focusId:'salesArticleSearchQuery'});
  assert.equal(f.controller.preferred.minimized,false);
  f.toggle.emit('click'); read=false;
  await ctx.revealSalesArticleSearchWindowTarget({view:'articleCatalog',focusId:'salesArticleSearchQuery'});
  assert.equal(f.controller.preferred.minimized,true);
  read=true; await ctx.revealSalesArticleSearchWindowTarget({view:'articleCatalog',focusId:'other'});
  assert.equal(f.controller.preferred.minimized,true);
});

test('Initial function-search activation keeps stored geometry and expands only after its current GET', async () => {
  let preferences; const f=domFixture(value => {void preferences.change(value);}), requests=[];
  preferences=createPreferences({key:() => 'A',canUse:() => true,apply:value => f.controller.set(value),error:assert.fail,
    api(url,options = {}) {const pending=deferred();requests.push({...pending,options});return pending.promise;}});
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const start=source.indexOf('async function revealSalesArticleSearchWindowTarget('),end=source.indexOf('\n}',start)+2;
  const ctx={document:{getElementById:id => ({salesArticleSearchWindow:f.host,salesArticleSearchQuery:f.input})[id]},
    canReadSalesArticles:() => true,currentSalesArticleCatalogDetailAccessKey:() => 'A',
    state:{currentView:'articleCatalog'},salesArticleSearchWindow:f.controller,salesArticleWindowPreferences:preferences};
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  const initial=preferences.activate(), reveal=ctx.revealSalesArticleSearchWindowTarget({view:'articleCatalog',focusId:'salesArticleSearchQuery'});
  assert.equal(requests.length,1);assert.equal(requests[0].options.signal.aborted,false);assert.equal(f.saved.length,0);
  f.input.focus(); const stored={...DEFAULTS,x:85,y:35,width:790,height:540,minimized:true};
  requests[0].resolve({...stored,configured:true});await initial;await reveal;await tick();
  assert.equal(f.doc.activeElement,f.toggle,'the asynchronous minimized read must not leave hidden input focus');
  assert.deepEqual(f.controller.preferred,{...stored,minimized:false});
  assert.equal(requests.length,2);assert.deepEqual(JSON.parse(requests[1].options.body),{...stored,minimized:false});
  requests[1].resolve({configured:true});await tick();
  const saves=f.saved.length; await ctx.revealSalesArticleSearchWindowTarget({view:'articleCatalog',focusId:'salesArticleSearchQuery'});
  assert.equal(f.saved.length,saves,'already-expanded restore must not save or discard geometry');
});

test('Function-search restore cannot cross a newer navigation or actor while waiting for geometry', async () => {
  for (const reason of ['navigation','actor','view','rights']) {
    const f=domFixture(); f.toggle.emit('click'); const pending=deferred();let key='A',read=true,current=true;
    const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
    const start=source.indexOf('async function revealSalesArticleSearchWindowTarget('),end=source.indexOf('\n}',start)+2;
    const ctx={document:{getElementById:id => ({salesArticleSearchWindow:f.host,salesArticleSearchQuery:f.input})[id]},
      canReadSalesArticles:() => read,currentSalesArticleCatalogDetailAccessKey:() => key,state:{currentView:'articleCatalog'},
      salesArticleSearchWindow:f.controller,salesArticleWindowPreferences:{activate:() => pending.promise}};
    vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
    const reveal=ctx.revealSalesArticleSearchWindowTarget({view:'articleCatalog',focusId:'salesArticleSearchQuery'},() => current);
    if (reason==='navigation') current=false; else if (reason==='actor') key='B'; else if (reason==='view') ctx.state.currentView='crm'; else read=false;
    pending.resolve();await reveal;assert.equal(f.controller.preferred.minimized,true,reason);
  }
});

test('An older failed save cannot enable a stale re-entry GET over a newer queued save', async () => {
  const f=preferencesFixture(), initial=f.controller.activate();f.requests[0].resolve({...DEFAULTS,x:100,configured:true});await initial;
  const first=f.controller.change({...DEFAULTS,x:200}),last=f.controller.change({...DEFAULTS,x:300});await tick();
  f.requests[1].reject(new Error('temporary failure'));await first;await tick();
  f.controller.suspend();await f.controller.activate();
  assert.equal(f.requests.length,3,'a newer queued change remains authoritative during re-entry');
  assert.equal(JSON.parse(f.requests[2].options.body).x,300);f.requests[2].resolve({configured:true});await last;
  assert.equal(f.errors.length,1);
});
