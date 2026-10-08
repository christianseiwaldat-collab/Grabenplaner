'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {adjust,fit,persistedGeometry,attach,createPreferences}=require('../public/gp-window');
const model=require('../public/gp-window-preferences');
const {documentFixture}=require('./helpers/gp-window-dom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('all eight resize directions anchor opposite edges and ignore unrelated axes',()=>{
  const value={x:100,y:80,width:500,height:300,minimized:false},bounds={width:1400,height:900};
  for(const edge of ['n','ne','e','se','s','sw','w','nw']) {
    const result=adjust(value,edge,30,20,bounds);
    if(edge.includes('w'))assert.equal(result.x+result.width,value.x+value.width,edge);
    if(edge.includes('n'))assert.equal(result.y+result.height,value.y+value.height,edge);
    if(!edge.includes('w'))assert.equal(result.x,value.x,edge);
    if(!edge.includes('n'))assert.equal(result.y,value.y,edge);
    if(!/[ew]/.test(edge))assert.equal(result.width,value.width,edge);
    if(!/[ns]/.test(edge))assert.equal(result.height,value.height,edge);
  }
  assert.deepEqual(adjust(value,'nw',9999,9999,bounds),{...value,x:400,y:300,width:200,height:80});
  assert.deepEqual(adjust(value,'se',9999,9999,bounds),{...value,width:1300,height:820});
});
test('viewport shrinking and compact minimization preserve saved expanded size',()=>{
  const value={x:800,y:500,width:900,height:700,minimized:false};
  const small=fit(value,{width:300,height:250});assert.deepEqual(small,{...value,x:0,y:0,width:300,height:250});
  const vertical=persistedGeometry(value,small,adjust(small,'s',0,-20,{width:300,height:250}),'s');
  assert.equal(vertical.width,900);assert.equal(vertical.height,230);assert.equal(vertical.x,800);
  assert.equal(fit({...value,minimized:true},{width:1800,height:1000}).width,260);
  assert.equal(fit(value,{width:1800,height:1400}).width,900);assert.equal(value.height,700);
});
function fixture(extra={}) {
  const f=documentFixture(),host=f.element('section',{},f.doc.body),title=f.element('header',{},host),body=f.element('div',{},host),toggle=f.element('button',{},title),close=f.element('button',{},title),saved=[];
  let allowed=true,bounds={left:0,top:0,width:1600,height:1000};
  const controller=attach(host,{title,body,toggle,closeButton:close,active:true,bounds:()=>bounds,scale:()=>1.25,
    geometry:{x:100,y:80,width:500,height:300,minimized:false},canUse:()=>allowed,change:value=>saved.push(value),...extra});
  return {...f,host,title,body,toggle,close,saved,controller,allowed(value){allowed=value;},bounds(value){bounds=value;}};
}
test('pointer and keyboard resize use edge direction, zoom and rights; cancellation restores geometry',()=>{
  const f=fixture(),west=f.host.querySelector('[data-gp-window-edge="w"]'),east=f.host.querySelector('[data-gp-window-edge="e"]');
  west.emit('pointerdown',{clientX:100,clientY:80});west.emit('pointermove',{clientX:125,clientY:500});west.emit('pointerup');
  assert.deepEqual(f.controller.preferred,{x:120,y:80,width:480,height:300,minimized:false});
  east.emit('keydown',{key:'ArrowRight'});assert.equal(f.controller.preferred.width,490);
  const before=f.controller.preferred;west.emit('pointerdown');west.emit('pointermove',{clientX:100});
  f.doc.emit('keydown',{key:'Escape'});assert.deepEqual(f.controller.preferred,before);
  east.emit('pointerdown');east.emit('pointermove',{clientX:100});f.allowed(false);east.emit('pointermove',{clientX:120});
  assert.deepEqual(f.controller.preferred,before);f.controller.destroy();
});
test('minimize shifts body focus to title control; close animation targets opener and fresh activation remains usable',async()=>{
  let closed=0;const f=fixture({onClose:()=>closed++}),opener=f.element('button');opener.style.left='4px';opener.style.top='900px';opener.style.width='30px';opener.style.height='28px';
  const second=attach(f.element('section',{},f.doc.body),{active:true,closeTarget:opener,onClose:()=>closed++});
  f.body.focus();f.toggle.emit('click');assert.equal(f.doc.activeElement,f.toggle);assert.equal(f.body.hidden,true);assert.equal(f.host.style.width,'260px');
  f.toggle.emit('click');assert.equal(f.host.style.width,'500px');assert.equal(f.controller.preferred.height,300);
  await second.close();assert.equal(closed,1);assert.equal(f.doc.activeElement,opener);second.activate();assert.equal(second.preferred.minimized,false);
  second.destroy();f.controller.destroy();
});
test('restore, pointer and keyboard focus bring one window forward without unbounded stacking or stale ownership',async()=>{
  const f=fixture(),other=f.element('section',{},f.doc.body),title=f.element('header',{},other);
  const second=attach(other,{title,active:true});
  f.controller.activate();assert.equal(f.host.classList.contains('is-active-window'),true);
  second.activate();assert.equal(f.host.classList.contains('is-active-window'),false);assert.equal(other.classList.contains('is-active-window'),true);
  f.controller.minimize(true);f.controller.restore();assert.equal(f.host.classList.contains('is-active-window'),true);assert.equal(other.classList.contains('is-active-window'),false);
  other.emit('pointerdown');assert.equal(other.classList.contains('is-active-window'),true);
  f.host.emit('focusin');assert.equal(f.host.classList.contains('is-active-window'),true);
  f.controller.suspend();assert.equal(f.host.classList.contains('is-active-window'),false);
  second.activate();await second.close();assert.equal(other.classList.contains('is-active-window'),false);
  second.destroy();f.controller.destroy();
});

test('shared title bars stay 44px tall and profile identity changes do not replace the expanded title',()=>{
  const f=documentFixture(),host=f.element('section',{},f.doc.body),title=f.element('header',{},host);
  const text=f.element('strong',{},title),toggle=f.element('button',{},title),close=f.element('button',{},title),body=f.element('div',{},host);
  text.textContent='Persönliches Rechteprofil';title.offsetHeight=180;let profile='001 · Anna';
  const controller=attach(host,{title,body,toggle,closeButton:close,active:true,bounds:()=>({left:0,top:0,width:1600,height:1000}),
    geometry:{x:20,y:30,width:700,height:600,minimized:false},minimizedTitle:()=>profile});
  assert.equal(title.querySelectorAll('.gp-window-grip').length,1);assert.equal(close.classList.contains('gp-window-control'),true);
  controller.minimize(true);assert.equal(controller.fitted.width,260);assert.equal(controller.fitted.height,44);
  assert.equal(text.textContent,'001 · Anna');assert.equal(controller.preferred.width,700);assert.equal(controller.preferred.height,600);
  profile='002 · Bernd';controller.refresh();assert.equal(text.textContent,'002 · Bernd');
  controller.restore();assert.equal(text.textContent,'Persönliches Rechteprofil');assert.equal(controller.fitted.width,700);
  controller.destroy();assert.equal(title.querySelectorAll('.gp-window-grip').length,0);assert.equal(text.textContent,'Persönliches Rechteprofil');
});

test('account preferences merge early movement with delayed server windows and retain changes through navigation',async()=>{
  const requests=[],applied=[];let actor='A';
  const prefs=createPreferences({actorKey:()=>actor,canUse:()=>true,api:(url,options)=>{const request=deferred();requests.push({url,options,...request});return request.promise;},apply:value=>applied.push(value)});
  const loading=prefs.activate(),edit=prefs.change('search',{x:40,y:20,width:600,height:420,minimized:false});await tick();assert.equal(requests.length,1);
  requests[0].resolve({gpWindows:{version:1,windows:{other:{x:1,y:2,width:500,height:300,minimized:false},search:{x:9,y:9,width:500,height:300,minimized:false}}}});
  await loading;await tick();assert.equal(requests.length,2);const sent=JSON.parse(requests[1].options.body).gpWindows;
  assert.equal(sent.windows.other.width,500);assert.equal(sent.windows.search.x,40);
  prefs.suspend();assert.equal(requests[1].options.signal.aborted,false);requests[1].resolve({});assert.equal(await edit,true);
  actor='B';prefs.invalidate();assert.deepEqual(prefs.value,model.empty());prefs.destroy();
});
test('validation accepts only bounded geometry and protects prototype keys',()=>{
  const valid={version:1,windows:{'search:articles':{x:0,y:0,width:500,height:300,minimized:false}}};
  assert.deepEqual(model.validate(valid),valid);
  assert.throws(()=>model.validate({...valid,extra:'text'}));
  assert.throws(()=>model.validate({version:1,windows:{constructor:valid.windows['search:articles']}}));
  assert.throws(()=>model.validate({version:1,windows:{search:{...valid.windows['search:articles'],width:99}}}));
  assert.deepEqual(model.normalize({version:1,windows:{search:{text:'not geometry'}}}),model.empty());
});

test('account switch aborts active preference writes and rejects queued old-account continuations',async()=>{
  const requests=[];let actor='A';
  const prefs=createPreferences({actorKey:()=>actor,canUse:()=>true,api:(url,options)=>{const request=deferred();requests.push({options,...request});return request.promise;}});
  const load=prefs.activate();requests[0].resolve({gpWindows:model.empty()});await load;
  const old=prefs.change('search',{x:10,y:20,width:500,height:300,minimized:false});
  const queued=prefs.change('search',{x:30,y:20,width:500,height:300,minimized:false});await tick();
  assert.equal(requests.length,2);actor='B';prefs.invalidate();assert.equal(requests[1].options.signal.aborted,true);
  const current=prefs.activate();requests[2].resolve({gpWindows:{version:1,windows:{search:{x:2,y:3,width:600,height:400,minimized:false}}}});await current;
  requests[1].resolve({});assert.deepEqual(await Promise.all([old,queued]),[false,false]);assert.equal(requests.length,3);
  assert.equal(prefs.value.windows.search.x,2);prefs.destroy();
});
