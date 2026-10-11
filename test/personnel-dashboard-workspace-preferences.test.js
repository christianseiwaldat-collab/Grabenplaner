'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../public/personnel-dashboard-workspace-preferences');
const start=require('../public/start-dashboard-workspace-preferences');
const {createStore}=require('../public/start-dashboard-workspace');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const value=title=>({...model.empty(),fields:{'card:employees':{title}}});
function fixture(extra={}){let actor='A',session={};const writes=[],errors=[],cache=new Map();const store=createStore({model,property:'personnelDashboardWorkspace',cachePrefix:'gp.personnel.dashboard.workspace.v1.',key:()=>actor,sessionReference:()=>session,canUse:()=>true,error:e=>errors.push(e),storage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)},migrate:model.migrate,extraPreferences:v=>({personnelDashboardLayout:model.layout(v)}),api:async(_url,o)=>{if(o.method==='PUT'){writes.push(JSON.parse(o.body));return {};}return {personnelDashboardWorkspace:null};},...extra});return {store,writes,errors,cache,setActor:a=>actor=a,setSession:s=>session=s};}
test('Personal model has its own complete IDs, strict order and shared safe palette/bounds',()=>{
  assert.equal(model.IDS.length,12);assert.notEqual(model.KEY,start.KEY);assert.equal(model.COLORS,start.COLORS);assert.equal(model.LIMITS,start.LIMITS);
  const p=value('  Team <img src=x>  ');p.fields['card:employees'].color='blue';p.fields['card:employees'].hidden=true;p.fields['card:employees'].geometry={x:0,y:0,width:300,height:400};
  const clean=model.validate(p);assert.equal(clean.fields['card:employees'].title,'Team <img src=x>');clean.order.reverse();clean.fields['card:employees'].geometry.width=500;assert.equal(p.fields['card:employees'].geometry.width,300);
  for(const p of [{...model.empty(),extra:true},{...model.empty(),order:[]},{...model.empty(),order:[...model.IDS.slice(1),model.IDS[1]]},{version:1,fields:{'group:personnel':{title:'x'}}},{version:1,fields:{'card:employees':{geometry:{x:0,y:0,width:199,height:100}}}},{version:1,fields:{'card:employees':{hidden:1}}},{version:1,fields:{'card:employees':{color:'#fff'}}},{version:1,fields:JSON.parse('{"__proto__":{"title":"x"}}')}])assert.throws(()=>model.validate(p));
});
test('only absent new settings migrate legacy order/hiding; explicit empty always wins',()=>{
  const legacy={order:['vacations','employees','vacations','unknown'],hidden:['positions','unknown']};const migrated=model.migrate(null,legacy);
  assert.deepEqual(migrated.order.slice(0,2),['card:vacations','card:employees']);assert.equal(migrated.order.length,12);assert.equal(migrated.fields['card:positions'].hidden,true);
  assert.deepEqual(model.migrate(model.empty(),legacy),model.empty());assert.deepEqual(model.migrate({damaged:true},legacy),model.empty());
  assert.deepEqual(model.layout(migrated).hidden,['positions']);
});
test('configured API property preserves immutable serialized writes and paired legacy schema',async()=>{
  const first=deferred(),writes=[];const f=fixture({api:async(_url,o)=>{if(o.method!=='PUT')return {personnelDashboardWorkspace:model.empty()};writes.push(JSON.parse(o.body));if(writes.length===1)await first.promise;return {};}});
  await f.store.activate();const a=value('First');const one=f.store.change(a);a.fields['card:employees'].title='Mutated';const two=f.store.change(value('Second'));await tick();assert.equal(writes.length,1);assert.equal(writes[0].personnelDashboardWorkspace.fields['card:employees'].title,'First');first.resolve();assert.deepEqual(await Promise.all([one,two]),[true,true]);assert.equal(writes[1].personnelDashboardWorkspace.fields['card:employees'].title,'Second');assert.deepEqual(writes[1].personnelDashboardLayout,model.layout(value('Second')));assert.equal(writes[0].startDashboardWorkspace,undefined);
});
test('same account new session invalidates an old read and pending/queued writes',async()=>{
  const read=deferred(),write=deferred(),requests=[];const f=fixture({api:async(_url,o)=>{requests.push(o);if(o.method==='PUT'){await write.promise;return {};}if(requests.length===1)return read.promise;return {personnelDashboardWorkspace:model.empty()};}});
  const old=f.store.activate();f.setSession({});const fresh=f.store.activate();read.resolve({personnelDashboardWorkspace:value('OLD')});await Promise.all([old,fresh]);assert.deepEqual(f.store.value,model.empty());assert.equal(requests[0].signal.aborted,true);
  const one=f.store.change(value('A')),two=f.store.change(value('Queued'));await tick();f.setSession({});assert.equal(f.store.ready,false);await f.store.activate();write.resolve();assert.deepEqual(await Promise.all([one,two]),[false,false]);assert.equal(requests.filter(o=>o.method==='PUT').length,1);assert.deepEqual(f.store.value,model.empty());
});
test('local migration/save/reset update separate Personal and legacy caches for captured account',async()=>{
  const legacy=new Map([['A',{order:['vacations'],hidden:['employees']}]]);const f=fixture({localOnly:()=>true,legacy:()=>legacy.get(actor),localPreferences:(p,key)=>legacy.set(key,p.personnelDashboardLayout),api:()=>assert.fail('local only')});let actor='A';
  await f.store.activate();assert.equal(f.store.value.order[0],'card:vacations');await f.store.change(value('Local'));assert.deepEqual(legacy.get('A'),model.layout(value('Local')));assert.ok(f.cache.has('gp.personnel.dashboard.workspace.v1.A'));assert.equal(f.cache.has('gp.dashboard.workspace.v1.A'),false);
  await f.store.change(model.empty());f.store.invalidate();await f.store.activate();assert.deepEqual(f.store.value,model.empty());assert.deepEqual(legacy.get('A'),model.layout(model.empty()));
  f.setActor('B');actor='B';await f.store.activate();assert.deepEqual(f.store.value,model.empty());assert.equal(f.cache.has('gp.personnel.dashboard.workspace.v1.B'),false);
});
test('denied/slow load and failed save cannot falsely report persisted values',async()=>{
  const pending=deferred();let allowed=true;const f=fixture({canUse:()=>allowed,api:(_url,o)=>o.method==='PUT'?Promise.reject(Error('synthetic failure')):pending.promise});const load=f.store.activate();assert.equal(await f.store.change(value('Too early')),false);pending.resolve({personnelDashboardWorkspace:model.empty()});await load;assert.equal(await f.store.change(value('Draft')),false);assert.equal(f.errors.length,1);allowed=false;assert.equal(f.store.ready,false);assert.deepEqual(f.store.value,model.empty());
});
