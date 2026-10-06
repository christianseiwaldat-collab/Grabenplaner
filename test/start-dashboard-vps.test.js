'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const widget=require('../public/start-dashboard-vps');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const payload=(freeBytes=1024)=>({generatedAt:'2026-10-06T12:00:00Z',capabilities:{technicalDiagnostics:true},resources:{uptimeSeconds:90061,cpu:{loadAverageOneMinute:0.35,logicalProcessors:4},memory:{usedPercent:41,availableBytes:2048,totalBytes:4096},storage:{freeBytes,databaseBytes:8192}}});
class Element{
  constructor(doc){this.ownerDocument=doc;this.children=[];this.attributes=new Map();this.listeners=new Map();this.dataset={};this.textContent='';this.classList={add(){}};this.visible=true;}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}
  setAttribute(key,value){this.attributes.set(key,value);}removeAttribute(key){this.attributes.delete(key);}
  querySelector(selector){const key=selector.slice(1,-1);return this.children.find(node=>node.attributes.has(key))||null;}
  getClientRects(){return this.visible?[{}]:[];}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
  removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
  fire(name){for(const fn of this.listeners.get(name)||[])fn();}
}
function setup(api){const doc=new Element(null);doc.visibilityState='visible';doc.createElement=()=>new Element(doc);doc.defaultView={};const host=new Element(doc);let key='A:technical',allowed=true,active=true,clock=0;const reads=[];
  const controller=widget.mount(host,{key:()=>key,canUse:()=>allowed,active:()=>active,now:()=>clock,api:(url,options)=>{reads.push({url,options,key});return api(url,options);}});
  return {host,doc,controller,reads,setKey:value=>key=value,setAllowed:value=>allowed=value,setActive:value=>active=value,advance:()=>clock+=60000,status:()=>host.querySelector('[data-vps-status]').textContent,output:()=>host.querySelector('[data-vps-metrics]')};}

test('resource summaries label load and app uptime honestly; absent or malformed values are unavailable',()=>{
  const rows=widget.metrics(payload());assert.equal(rows.length,7);assert.equal(rows[0].label,'CPU · Last (1 Min)');assert.equal(rows[0].value,'0,35');assert.equal(rows[4].label,'GP-Laufzeit');assert.equal(rows[4].value,'1 T 1 Std 1 Min');
  assert.equal(widget.bytes(0),'0 B');for(const value of [undefined,null,'',NaN,-1,Infinity])assert.equal(widget.bytes(value),'Nicht verfügbar');
  const malformed=payload();malformed.resources.memory.usedPercent=101;malformed.resources.cpu.loadAverageOneMinute=null;assert.equal(widget.metrics(malformed)[0].value,'Nicht verfügbar');assert.equal(widget.metrics(malformed)[1].value,'Nicht verfügbar');
  assert.deepEqual(widget.metrics({...payload(),capabilities:{technicalDiagnostics:false}}),[]);assert.deepEqual(widget.metrics({}),[]);
});
test('one read per activation or explicit refresh, single-flight and a minimum 60 seconds between attempts',async()=>{
  let gate=deferred();const f=setup(()=>gate.promise);assert.equal(f.reads.length,1);assert.equal(f.reads[0].url,widget.ENDPOINT);assert.equal(f.reads[0].options.method,undefined);assert.equal(f.controller.loading,true);
  f.controller.sync();const duplicate=f.controller.refresh();assert.equal(f.reads.length,1);gate.resolve(payload());await duplicate;await tick();assert.match(f.status(),/^Abgerufen/);
  assert.equal(await f.controller.refresh(),false);f.setActive(false);f.controller.sync();f.setActive(true);f.controller.sync();assert.equal(f.reads.length,1);
  f.advance();gate=deferred();const refreshed=f.controller.refresh();assert.equal(f.reads.length,2);gate.resolve(payload(4096));await refreshed;assert.equal(f.output().children.find(e=>e.dataset.vpsMetric==='storage').children[1].children[0].textContent,'4 KiB');f.controller.destroy();
});
test('hidden, background and unauthorized cards do not read; pending results are aborted',async()=>{
  let gate=deferred();const f=setup(()=>gate.promise);f.setActive(false);f.controller.sync();assert.equal(f.reads[0].options.signal.aborted,true);gate.resolve(payload());await tick();assert.equal(f.output().children.length,0);
  f.advance();f.setActive(true);f.doc.visibilityState='hidden';f.controller.sync();assert.equal(f.reads.length,1);
  gate=deferred();f.doc.visibilityState='visible';f.doc.fire('visibilitychange');assert.equal(f.reads.length,2);
  f.setAllowed(false);f.controller.sync();assert.equal(f.reads[1].options.signal.aborted,true);gate.resolve(payload());await tick();assert.equal(f.output().children.length,0);assert.equal(f.status(),'');assert.equal(await f.controller.refresh(),false);f.controller.destroy();
});
test('account and permission fingerprint changes purge old metrics and disregard late responses',async()=>{
  const gates=[];const f=setup(()=>{const gate=deferred();gates.push(gate);return gate.promise;});gates[0].resolve(payload());await tick();assert.equal(f.output().children.length,7);
  f.advance();void f.controller.refresh();f.setKey('B:technical');f.controller.sync();assert.equal(f.reads.length,3);assert.equal(f.reads[1].options.signal.aborted,true);assert.equal(f.output().children.length,0);
  gates[1].resolve(payload(9999));gates[2].resolve(payload(4096));await tick();assert.equal(f.output().children.find(e=>e.dataset.vpsMetric==='storage').children[1].children[0].textContent,'4 KiB');
  f.setKey('B:restricted');f.setAllowed(false);f.controller.sync();assert.equal(f.output().children.length,0);assert.equal(f.reads.length,3);f.controller.destroy();
});

test('nightly display requires verified history, selects the latest nightly instead of manual runs and labels stale results',()=>{
 const now=Date.parse('2026-10-06T12:00:00Z'),p=payload();p.recoveryAssurance={integrityVerified:true,statusAvailable:true,recentRuns:[
  {trigger:'manual',startedAt:'2026-10-06T11:00:00Z',status:'passed'},
  {trigger:'scheduled-nightly',startedAt:'2026-10-06T03:00:00Z',completedAt:'2026-10-06T04:00:00Z',status:'failed',phases:[{status:'passed'},{status:'failed'}]},
  {trigger:'scheduled-nightly',startedAt:'2026-10-05T03:00:00Z',completedAt:'2026-10-05T04:00:00Z',status:'passed'},
 ]};
 const row=()=>widget.metrics(p,now).find(r=>r.id==='nightly');assert.equal(row().value,'Fehlgeschlagen');assert.match(row().detail,/1\/2 Prüfschritte/);
 p.recoveryAssurance.integrityVerified=false;assert.equal(row().state,'unknown');p.recoveryAssurance.integrityVerified=true;
 p.recoveryAssurance.recentRuns[1].startedAt='2026-10-04T03:00:00Z';p.recoveryAssurance.recentRuns[1].completedAt='2026-10-04T04:00:00Z';p.recoveryAssurance.recentRuns.pop();assert.equal(row().value,'Veraltet · Fehlgeschlagen');
 p.recoveryAssurance.recentRuns[1].startedAt='2026-10-06T11:00:00Z';p.recoveryAssurance.recentRuns[1].completedAt=null;p.recoveryAssurance.recentRuns[1].status='running';assert.equal(row().value,'Läuft');
 p.recoveryAssurance.recentRuns[1].startedAt='2026-10-07T11:00:00Z';assert.equal(row().state,'unknown');
});
test('warnings reflect actual reported alerts, preserving unknown and stale states instead of an assumed zero',()=>{
 const now=Date.parse('2026-10-06T12:00:00Z'),p=payload(),row=()=>widget.metrics(p,now).find(r=>r.id==='warnings');assert.equal(row().value,'Nicht verfügbar');
 p.status={checkedAt:'2026-10-06T12:00:00Z',alerts:[]};assert.equal(row().value,'Keine gemeldet');
 p.status.alerts=[{severity:'info',title:'Info'},{severity:'critical',title:'Restore fehlgeschlagen'}];assert.equal(row().value,'1 gemeldet');assert.match(row().detail,/Restore fehlgeschlagen/);
 p.status.checkedAt='2026-10-06T11:50:00Z';assert.equal(row().value,'Veralteter Stand · 1 gemeldet');p.status.checkedAt=null;assert.equal(row().state,'unknown');
});
test('an endpoint rejection leaves a truthful error and does not repeatedly read; capability loss hides resources',async()=>{
  let response=Promise.reject(new Error('unavailable'));const f=setup(()=>response);await tick();assert.match(f.status(),/konnten nicht geladen werden/);f.controller.sync();await f.controller.refresh();assert.equal(f.reads.length,1);
  f.advance();response=Promise.resolve({...payload(),capabilities:{technicalDiagnostics:false}});await f.controller.refresh();assert.equal(f.output().children.length,0);assert.match(f.status(),/nicht verfügbar/);f.controller.destroy();assert.equal(f.status(),'');
});
