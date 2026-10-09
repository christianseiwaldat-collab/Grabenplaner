'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../public/start-dashboard-workspace-preferences');
const {createStore}=require('../public/start-dashboard-workspace');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const value=title=>({version:1,fields:{'group:personnel':{title}}});

function appFixture() {
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
 const state={portalStatus:{portalEnabled:true,localOnly:true},portalSession:{authenticated:true,user:{
  employeeNumber:'A',sessionKind:'employee',isEmployee:true,role:'developer',permissions:['schedule:read'],scopes:[],mustChangePassword:false}},
  startDashboardPreferences:{hidden:[],hiddenWidgets:[]}};
 const context={state,START_DASHBOARD_GROUPS:[{id:'branch',cardIds:['schedule','vacation']}],
  START_DASHBOARD_WIDGETS:[{id:'branchOnDuty',cardId:'schedule'}],
  accessibleDashboardModes:()=>['control'],normalizeStartDashboardPreferences:value=>value,
  startDashboardCardAccessible:id=>['schedule','vacation'].includes(id)};
 vm.createContext(context);
 for(const name of ['isLocalStartDashboardWorkspace','canUseStartDashboardWorkspace','startDashboardWorkspaceActorKey','startDashboardWorkspaceFieldAllowed']) {
  const start=source.indexOf('function '+name+'(');
  assert.ok(start>=0,name);vm.runInContext(source.slice(start,source.indexOf('\n}',start)+2),context);
 }
 return context;
}

test('real app guard requires personal authentication or an explicitly local installation',()=>{
 const c=appFixture(),original=structuredClone(c.state.portalSession);
 assert.equal(c.canUseStartDashboardWorkspace(),true);
 for(const change of [{authenticated:false},{user:{...original.user,isEmployee:false}},
  {user:{...original.user,sessionKind:'organization'}},{user:{...original.user,employeeNumber:''}},
  {user:{...original.user,employeeNumber:'local'}},{user:{...original.user,mustChangePassword:true}},
  {user:{...original.user,active:false}}]) {
  c.state.portalSession={...original,...change};assert.equal(c.canUseStartDashboardWorkspace(),false,JSON.stringify(change));
 }
 c.state.portalSession=null;c.state.portalStatus=null;assert.equal(c.canUseStartDashboardWorkspace(),false);
 c.state.portalStatus={portalEnabled:false,localOnly:false};assert.equal(c.canUseStartDashboardWorkspace(),false);
 c.state.portalStatus={portalEnabled:false,localOnly:true};assert.equal(c.canUseStartDashboardWorkspace(),true);
});

test('real app actor key changes with account, rights, scope, type and password requirement',()=>{
 const c=appFixture(),original=structuredClone(c.state.portalSession),key=c.startDashboardWorkspaceActorKey();
 for(const change of [{employeeNumber:'B'},{role:'manager'},{permissions:[]},{scopes:[{locationId:'19'}]},
  {mustChangePassword:true},{sessionKind:'organization'},{accountId:'other'},{active:false},
  {salesAnalytics:{available:false}}]) {
  c.state.portalSession={...original,user:{...original.user,...change}};
  assert.notEqual(c.startDashboardWorkspaceActorKey(),key,JSON.stringify(change));
 }
});

test('field rights explicitly include parent card and hidden states even for detached widgets',()=>{
 const c=appFixture();assert.equal(c.startDashboardWorkspaceFieldAllowed('widget:branchOnDuty'),true);
 assert.equal(c.startDashboardWorkspaceFieldAllowed('widget:unknown'),false);
 c.state.startDashboardPreferences.hidden=['schedule'];
 assert.equal(c.startDashboardWorkspaceFieldAllowed('widget:branchOnDuty'),false);
 assert.equal(c.startDashboardWorkspaceFieldAllowed('card:schedule'),false);
 assert.equal(c.startDashboardWorkspaceFieldAllowed('group:branch'),true);
 c.state.startDashboardPreferences.hidden=['schedule','vacation'];assert.equal(c.startDashboardWorkspaceFieldAllowed('group:branch'),false);
 c.state.startDashboardPreferences={hidden:[],hiddenWidgets:['branchOnDuty']};
 assert.equal(c.startDashboardWorkspaceFieldAllowed('widget:branchOnDuty'),false);
 c.state.startDashboardPreferences.hiddenWidgets=[];c.startDashboardCardAccessible=()=>false;
 assert.equal(c.startDashboardWorkspaceFieldAllowed('widget:branchOnDuty'),false);
 c.state.portalSession=null;assert.equal(c.startDashboardWorkspaceFieldAllowed('control:center'),false);
});
test('strict bounded schema prevents unknown fields and preserves plain labels',()=>{
 const original={version:1,fields:{'group:personnel':{title:'  <img src=x onerror=alert(1)>  ',description:'Beschreibung',geometry:{x:0,y:123,width:300,height:400}}}};
 const result=model.validate(original);assert.equal(result.fields['group:personnel'].title,'<img src=x onerror=alert(1)>');
 result.fields['group:personnel'].geometry.width=400;assert.equal(original.fields['group:personnel'].geometry.width,300);
 for(const invalid of [{...value('Personal'),actor:'other'}, {version:1,fields:{'card:unregistered':{title:'X'}}},
  {version:1,fields:{'group:personnel':{title:' '}}},{version:1,fields:{'group:personnel':{title:'a\nb'}}},
  {version:1,fields:{'group:personnel':{title:'a',geometry:{x:0,y:0,width:199,height:100}}}},
  {version:1,fields:{'group:personnel':{geometry:{x:0,y:0,width:200,height:100,z:1}}}},
  {version:1,fields:JSON.parse('{"__proto__":{"title":"x"}}')}]) assert.throws(()=>model.validate(invalid));
});

test('the two control cards can independently be hidden while legacy workspace values remain valid',()=>{
 const hidden={version:1,fields:{'control:center':{hidden:true},'control:vps':{hidden:false,title:'VPS'}}};
 assert.deepEqual(model.validate(hidden),hidden);assert.ok(model.IDS.includes('control:vps'));
 assert.deepEqual(model.validate(value('Personal')),value('Personal'));
 for(const invalid of [{version:1,fields:{'card:schedule':{hidden:true}}},{version:1,fields:{'control:center':{hidden:1}}},{version:1,fields:{'control:vps':{hidden:'true'}}}])assert.throws(()=>model.validate(invalid));
});

test('field colors accept only the shared palette and defaults need no migration',()=>{
 assert.deepEqual(model.COLORS,['sage','blue','sand','rose','lavender','peach']);
 assert.equal(Object.isFrozen(model.COLORS),true);
 for(const color of model.COLORS) {
  const preferences={version:1,fields:{'group:branch':{color,title:'Filiale',geometry:{x:0,y:50,width:300,height:500}},'control:vps':{color,hidden:true}}};
  assert.deepEqual(model.validate(preferences),preferences);
 }
 for(const color of ['',null,undefined,0,true,'standard','SAGE','#fff','url(https://example.com/image)','sage blue',{toString:()=> 'sage'}]) {
  assert.throws(()=>model.validate({version:1,fields:{'card:schedule':{color}}}),TypeError);
 }
 const legacy=value('Personal');assert.deepEqual(model.validate(legacy),legacy);
 assert.equal(Object.hasOwn(model.validate(legacy).fields['group:personnel'],'color'),false);
 assert.deepEqual(model.validate({version:1,fields:{'card:schedule':{}}}),model.empty());
});

test('color changes and reset preserve other saved field settings in the account cache',async()=>{
 const cache=new Map();let actor='local:A';
 const store=createStore({canUse:()=>true,key:()=>actor,localOnly:()=>true,
  storage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)},api:()=>assert.fail('local preferences must remain local'),error:()=>{}});
 await store.activate();
 await store.change({version:1,fields:{'group:personnel':{title:'Personal',color:'sage'},'card:sales':{color:'blue'}}});
 actor='local:B';await store.activate();assert.deepEqual(store.value,model.empty());
 await store.change({version:1,fields:{'group:personnel':{color:'rose'}}});
 actor='local:A';await store.activate();
 assert.equal(store.value.fields['group:personnel'].color,'sage');
 const defaults=store.value;delete defaults.fields['group:personnel'].color;await store.change(defaults);
 assert.deepEqual(store.value.fields['group:personnel'],{title:'Personal'});
 assert.equal(store.value.fields['card:sales'].color,'blue');
 store.invalidate();await store.activate();assert.deepEqual(store.value,defaults);
 await store.change(model.empty());store.invalidate();await store.activate();assert.deepEqual(store.value,model.empty());
 actor='local:B';await store.activate();assert.equal(store.value.fields['group:personnel'].color,'rose');
});
test('initial slow GET gates changes so another saved field cannot be overwritten',async()=>{
 const get=deferred(),requests=[],errors=[];
 const store=createStore({canUse:()=>true,key:()=> 'employee:A',api:(url,options={})=>{requests.push(options);return options.method==='PUT'?Promise.resolve({}):get.promise;},error:e=>errors.push(e)});
 const read=store.activate();assert.equal(store.ready,false);assert.equal(await store.change(value('Personal')),false);
 assert.equal(requests.length,1);assert.equal(requests[0].signal.aborted,false);
 get.resolve({startDashboardWorkspace:{version:1,fields:{'card:sales':{title:'Already saved'}}}});await read;
 assert.equal(store.ready,true);const next=store.value;next.fields['group:personnel']={title:'Personal'};await store.change(next);
 assert.equal(store.value.fields['card:sales'].title,'Already saved');assert.equal(store.value.fields['group:personnel'].title,'Personal');assert.deepEqual(errors,[]);
});
test('queued PUT values are immutable and serialized',async()=>{
 const first=deferred(),writes=[];
 const store=createStore({canUse:()=>true,key:()=> 'A',api:(url,o)=>{if(o.method!=='PUT')return Promise.resolve({});writes.push(JSON.parse(o.body));return writes.length===1?first.promise:Promise.resolve({});},error:()=>{}});
 await store.activate();
 const initial=value('First');const a=store.change(initial);initial.fields['group:personnel'].title='Tampered';
 const b=store.change(value('Second'));await tick();assert.equal(writes.length,1);assert.equal(writes[0].startDashboardWorkspace.fields['group:personnel'].title,'First');
 first.resolve({});await Promise.all([a,b]);assert.equal(writes[1].startDashboardWorkspace.fields['group:personnel'].title,'Second');
});
test('account and role transitions invalidate pending results and queued writes',async()=>{
 let actor='A:developer',pending=deferred();const writes=[];
 const store=createStore({canUse:()=>true,key:()=>actor,api:(url,o={})=>o.method==='PUT'?(writes.push(JSON.parse(o.body)),Promise.resolve({})):pending.promise,error:()=>{}});
 const a=store.activate();actor='B:employee';store.invalidate();pending.resolve({startDashboardWorkspace:value('AccountA')});await a;assert.deepEqual(store.value,model.empty());
 pending=deferred();const b=store.activate();assert.equal(await store.change(value('AccountB')),false);assert.equal(writes.length,0);
 pending.resolve({startDashboardWorkspace:value('StoredB')});await b;await store.change(value('AccountB'));
 assert.equal(store.value.fields['group:personnel'].title,'AccountB');assert.equal(writes.length,1);
 actor='B:restricted';store.invalidate();assert.deepEqual(store.value,model.empty());assert.equal(store.ready,false);
});
test('failed save preserves later editing and a retry keeps the latest snapshot',async()=>{
 const errors=[],writes=[];let fail=true;
 const store=createStore({canUse:()=>true,key:()=> 'A',api:(url,o)=>{if(o.method!=='PUT')return Promise.resolve({});writes.push(JSON.parse(o.body));if(fail){fail=false;return Promise.reject(new Error('save-failed'));}return Promise.resolve({});},error:e=>errors.push(e.message)});
 await store.activate();
 await store.change(value('First'));await store.change(value('Second'));assert.equal(store.value.fields['group:personnel'].title,'Second');assert.deepEqual(errors,['save-failed']);
 await store.change(store.value);assert.equal(writes.at(-1).startDashboardWorkspace.fields['group:personnel'].title,'Second');
});
test('local cache is isolated by identity and never used for personal API failures',async()=>{
 const cache=new Map();let actor='local:A',local=true,apiCalls=0;
 const store=createStore({canUse:()=>true,key:()=>actor,localOnly:()=>local,storage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)},api:()=>{apiCalls++;return Promise.reject(new Error('unavailable'));},error:()=>{}});
 await store.activate();await store.change(value('LocalA'));actor='local:B';await store.activate();assert.deepEqual(store.value,model.empty());
 actor='local:A';await store.activate();assert.equal(store.value.fields['group:personnel'].title,'LocalA');
 actor='employee:A';local=false;await store.activate();assert.deepEqual(store.value,model.empty());assert.equal(apiCalls,1);
});
test('damaged or inaccessible local cache uses defaults once without repeated rendering errors',async()=>{
 for(const mode of ['invalid-json','unavailable']) {
  let reads=0;const errors=[];
  const store=createStore({canUse:()=>true,key:()=> 'local',localOnly:()=>true,
   storage:{getItem(){reads++;if(mode==='unavailable')throw Error('disabled');return '{broken';}},
   api:()=>assert.fail('local cache must not call the API'),error:error=>errors.push(error)});
  await store.activate();await store.activate();await store.activate();
  assert.deepEqual(store.value,model.empty());assert.equal(reads,1);assert.deepEqual(errors,[]);
 }
});

test('failed initial GET stays gated until an explicit retry obtains the saved baseline',async()=>{
 let reads=0;const writes=[],errors=[];
 const store=createStore({canUse:()=>true,key:()=> 'A',error:e=>errors.push(e.message),api:async(url,o)=>{
  if(o.method==='PUT'){writes.push(JSON.parse(o.body));return {};}
  if(++reads===1)throw Error('read-failed');return {startDashboardWorkspace:value('Stored')};
 }});
 await store.activate();assert.equal(store.ready,false);assert.equal(store.failed,true);
 assert.equal(await store.change(model.empty()),false);await store.activate();await store.activate();
 assert.equal(reads,1);assert.deepEqual(writes,[]);assert.deepEqual(errors,['read-failed']);
 await store.activate({retry:true});assert.equal(store.ready,true);assert.equal(store.failed,false);
 const next=store.value;next.fields['card:sales']={title:'Sales'};await store.change(next);
 assert.equal(writes[0].startDashboardWorkspace.fields['group:personnel'].title,'Stored');
 assert.equal(writes[0].startDashboardWorkspace.fields['card:sales'].title,'Sales');
});
