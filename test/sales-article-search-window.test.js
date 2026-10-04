'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {DEFAULTS,contentBounds,fit,defaultGeometry,attach,createPreferences} = require('../public/sales-article-search-window');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve,reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

function surface() {
  const listeners = new Map();
  return {addEventListener(type,fn) { if (!listeners.has(type)) listeners.set(type,new Set()); listeners.get(type).add(fn); },
    removeEventListener(type,fn) { listeners.get(type)?.delete(fn); },
    emit(type,options = {}) { const event = {type,target:this,button:0,pointerId:1,clientX:0,clientY:0,
      preventDefault() {this.prevented=true;},stopPropagation() {this.stopped=true;},...options};
      for (const fn of listeners.get(type) || []) fn(event); return event; }};
}
function domFixture(onChange) {
  const win = surface(), doc = {...surface(),defaultView:win,activeElement:null}; win.visualViewport = surface();
  function element(attributes = {},parent = null) {
    const classes = new Set(), attrs = {...attributes}, captures = new Set();
    const node = {...surface(),ownerDocument:doc,parent,style:{},hidden:false,offsetHeight:44,textContent:'',
      classList:{add(...values) {values.forEach(v => classes.add(v));},remove(...values) {values.forEach(v => classes.delete(v));},
        contains:value => classes.has(value),toggle(value,on) { if (on) classes.add(value); else classes.delete(value); }},
      hasAttribute:key => Object.hasOwn(attrs,key),setAttribute(key,value) {attrs[key]=value;},getAttribute:key => attrs[key],
      closest(selector) { for (let p=this;p;p=p.parent) if (selector.split(',').some(s => p.hasAttribute(s.slice(1,-1)))) return p; return null; },
      contains(candidate) { for (let p=candidate;p;p=p.parent) if (p===this) return true; return false; },
      focus() {doc.activeElement=this;},setPointerCapture(id) {captures.add(id);},hasPointerCapture:id => captures.has(id),
      releasePointerCapture(id) {captures.delete(id);},querySelector(selector) {return nodes.find(n => n!==this && this.contains(n) && n.hasAttribute(selector.slice(1,-1))) || null;}};
    return node;
  }
  const host=element(), title=element({'data-article-window-title':''},host), move=element({'data-article-window-move':''},title);
  const toggle=element({'data-article-window-toggle':''},title), reset=element({'data-article-window-reset':''},title);
  const body=element({'data-article-window-body':''},host), input=element({},body);
  const resize=element({'data-article-window-resize':''},host), status=element({'data-article-window-status':''},host);
  const nodes=[host,title,move,toggle,reset,body,input,resize,status], saved=[], layouts=[];
  let bounds={left:250,top:130,width:1200,height:800}, permitted=true, scale=1.25;
  const controller=attach(host,{window:win,bounds:() => bounds,scale:() => scale,canUse:() => permitted,
    change:value => {saved.push(value);onChange?.(value);},resize:value => layouts.push(value)});
  controller.activate();
  return {win,doc,host,title,move,toggle,reset,body,input,resize,status,saved,layouts,controller,
    bounds(value) {bounds=value;},permit(value) {permitted=value;},scale(value) {scale=value;}};
}

test('Visible content bounds exclude sidebar/header and convert GP zoom once', () => {
  assert.deepEqual(contentBounds({left:300,right:1500},{bottom:160},{width:1600,height:900},1.25),
    {left:240,top:134.4,width:960,height:579.2});
  const small=contentBounds({left:0,right:400},{bottom:160},{left:0,top:40,width:400,height:480},1);
  assert.deepEqual(small,{left:8,top:168,width:384,height:344});
  assert.equal(defaultGeometry({width:1200}).x,640);
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
  assert.equal(f.controller.preferred.x,140); assert.equal(f.controller.preferred.height,410);
  f.host.emit('keydown',{target:f.resize,key:'End'});
  assert.equal(f.controller.fitted.width,1060); assert.equal(f.controller.fitted.height,760);
  f.input.focus(); f.toggle.emit('click');
  assert.equal(f.doc.activeElement,f.toggle); assert.equal(f.body.hidden,true); assert.equal(f.resize.hidden,true);
  assert.equal(f.toggle.getAttribute('aria-expanded'),'false'); assert.equal(f.controller.fitted.height,44);
  assert.equal(f.controller.preferred.height,760);
  f.controller.restore(); assert.equal(f.body.hidden,false); assert.equal(f.controller.fitted.height,760);
  f.reset.emit('click'); assert.deepEqual(f.controller.preferred,defaultGeometry({width:1200}));
  assert.match(f.status.textContent,/Suchfenster:/);
});

function preferencesFixture() {
  let key='A|read', allowed=true; const applied=[],errors=[],requests=[];
  const controller=createPreferences({key:() => key,canUse:() => allowed,apply:value => applied.push(value),error:error => errors.push(error),
    api(url,options = {}) { const pending=deferred(); requests.push({url,options,...pending}); return pending.promise; }});
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
