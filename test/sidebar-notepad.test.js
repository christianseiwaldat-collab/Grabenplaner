'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../public/sidebar-notepad-preferences');
const {createStore}=require('../public/sidebar-notepad');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const note=(text,more={})=>({...model.empty(),text,...more});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,api){
  let key='A:developer',identity='A',allowed=true;
  const errors=[],store=createStore({key:()=>key,identity:()=>identity,canUse:()=>allowed,api,delay:60000,error:error=>errors.push(error.message)});
  t.after(()=>store.destroy());
  return {store,errors,switchTo(next,role='employee'){identity=next;key=next+':'+role;},deny(){allowed=false;},allow(){allowed=true;}};
}
test('strict notes schema preserves exact text and rejects oversized, corrupt or unknown input',()=>{
  const original=note('  <img src=x onerror=alert(1)>\n\tNotiz  ',{height:1200,open:true});
  assert.deepEqual(model.validate(original),original);assert.notEqual(model.validate(original),original);
  assert.deepEqual(model.parseStored(undefined),model.empty());assert.deepEqual(model.parseStored(JSON.stringify(original)),original);
  assert.equal(model.validate(note('x'.repeat(20000))).text.length,20000);
  for(const invalid of [null,{},[],{...original,actor:'B'},{...original,open:1},{...original,height:119},{...original,height:1201},{...original,height:200.5},{...original,text:'x'.repeat(20001)},{...original,text:'A\0B'}])assert.throws(()=>model.validate(invalid));
  for(const invalid of [null,'null','{damaged'])assert.throws(()=>model.parseStored(invalid));
});
test('all genuine personal accounts including developer have access, shared/local and password-change sessions do not',()=>{
  const actor={sessionKind:'employee',accountType:'employee',isEmployee:true,employeeNumber:'A',active:true,role:'developer',permissions:[]};
  assert.equal(model.isPersonalActor(actor),true);
  for(const role of ['admin','hr','employee','manager'])assert.equal(model.isPersonalActor({...actor,role}),true);
  for(const patch of [{isEmployee:false},{sessionKind:'organization'},{accountType:'branch'},{employeeNumber:'local'},{employeeNumber:'system'},{employeeNumber:''},{active:false},{mustChangePassword:true}])assert.equal(model.isPersonalActor({...actor,...patch}),false);
});
test('initial GET must succeed before editing or saving existing notes',async t=>{
  const get=deferred(),requests=[];const {store}=fixture(t,(url,o)=>{requests.push(o);return get.promise;});
  const ready=store.activate();assert.equal(store.ready,false);assert.equal(store.change(note('overwrite')),false);assert.equal(await store.flush(),false);assert.equal(requests.length,1);
  get.resolve({sidebarNotepad:note('Existing',{open:true,height:321})});await ready;
  assert.equal(store.ready,true);assert.deepEqual(store.value,note('Existing',{open:true,height:321}));
});
test('failed or malformed GET keeps notes noneditable until explicit successful retry',async t=>{
  let count=0;const requests=[];const {store,errors}=fixture(t,async(url,o)=>{requests.push(o);if(++count===1)throw Error('offline');if(count===2)return {sidebarNotepad:null};return{sidebarNotepad:note('Saved')};});
  await store.activate();assert.equal(store.status,'load-error');assert.equal(store.change(note('New')),false);await store.activate();assert.equal(count,1);
  await store.retry();assert.equal(store.ready,false);await store.retry();assert.equal(store.ready,true);assert.equal(store.value.text,'Saved');assert.equal(errors.length,2);assert.ok(requests.every(o=>o.method!== 'PUT'));
});
test('immutable autosave drain serializes old request and coalesces later input to newest value',async t=>{
  const first=deferred(),writes=[];const {store}=fixture(t,(url,o)=>{if(o.method!=='PUT')return Promise.resolve({sidebarNotepad:note('Old')});writes.push(JSON.parse(o.body));return writes.length===1?first.promise:Promise.resolve({sidebarNotepad:note('stale response')});});
  await store.activate();const input=note('First');store.change(input);const saving=store.flush();input.text='Mutated';
  store.change(note('Second'));store.change(note('Latest',{open:true,height:355}));assert.equal(writes.length,1);assert.equal(writes[0].sidebarNotepad.text,'First');
  first.resolve({});assert.equal(await saving,true);assert.equal(writes.length,2);assert.deepEqual(writes[1].sidebarNotepad,note('Latest',{open:true,height:355}));assert.equal(store.value.text,'Latest');assert.equal(store.hasUnsaved,false);
});
test('a revert during pending PUT is saved after its response instead of being mistaken for unchanged data',async t=>{
  const first=deferred(),writes=[];const {store}=fixture(t,(url,o)=>{if(o.method!=='PUT')return Promise.resolve({sidebarNotepad:note('Original')});writes.push(JSON.parse(o.body).sidebarNotepad.text);return writes.length===1?first.promise:Promise.resolve({});});
  await store.activate();store.change(note('Temporary'));const save=store.flush();store.change(note('Original'));assert.equal(store.hasUnsaved,true);first.resolve({});await save;assert.deepEqual(writes,['Temporary','Original']);assert.equal(store.hasUnsaved,false);
});
test('failed PUT preserves late input and retries the newest text without a baseline reload',async t=>{
  const first=deferred(),writes=[];const {store}=fixture(t,(url,o)=>{if(o.method!=='PUT')return Promise.resolve({sidebarNotepad:note('Saved')});writes.push(JSON.parse(o.body).sidebarNotepad);return writes.length===1?first.promise:Promise.resolve({});});
  await store.activate();store.change(note('Early'));const save=store.flush();store.change(note('Late'));first.reject(Error('offline'));assert.equal(await save,false);assert.equal(store.status,'save-error');assert.equal(store.value.text,'Late');assert.equal(store.hasUnsaved,true);
  assert.equal(await store.retry(),true);assert.equal(writes[1].text,'Late');assert.equal(store.status,'saved');
});
test('rapid account changes abort requests and restore only the owning account draft after its fresh GET',async t=>{
  const slowA=deferred(),backA=deferred(),writes=[];let reads=0;
  const f=fixture(t,(url,o)=>{if(o.method==='PUT'){writes.push({body:JSON.parse(o.body),signal:o.signal});return writes.length===1?slowA.promise:Promise.resolve({});}reads++;return reads===1?Promise.resolve({sidebarNotepad:note('StoredA')}):reads===2?Promise.resolve({sidebarNotepad:note('StoredB')}):backA.promise;});
  await f.store.activate();f.store.change(note('DraftA'));const saving=f.store.flush();f.store.change(note('NewestA'));
  f.switchTo('B');await f.store.activate();assert.equal(writes[0].signal.aborted,true);assert.equal(f.store.value.text,'StoredB');assert.equal(f.store.hasUnsaved,false);
  slowA.resolve({sidebarNotepad:note('WrongA')});assert.equal(await saving,false);assert.equal(f.store.value.text,'StoredB');
  f.switchTo('A','developer');const returning=f.store.activate();assert.equal(f.store.ready,false);assert.equal(f.store.hasUnsaved,true);assert.equal(f.store.value.text,'');assert.equal(f.store.change(note('Too soon')),false);
  backA.resolve({sidebarNotepad:note('ServerA')});await returning;assert.equal(f.store.value.text,'NewestA');await f.store.flush();assert.equal(writes.at(-1).body.sidebarNotepad.text,'NewestA');assert.equal(f.store.hasUnsaved,false);
});
test('late GET from previous account cannot render, and revoked access clears visible notes immediately',async t=>{
  const old=deferred(),calls=[];const f=fixture(t,(url,o)=>{calls.push(o);return calls.length===1?old.promise:Promise.resolve({sidebarNotepad:note('B')});});
  const a=f.store.activate();f.switchTo('B');await f.store.activate();assert.equal(calls[0].signal.aborted,true);old.resolve({sidebarNotepad:note('PrivateA')});await a;assert.equal(f.store.value.text,'B');
  f.deny();await f.store.activate();assert.equal(f.store.ready,false);assert.equal(f.store.value.text,'');assert.equal(await f.store.flush(),false);
});
test('revoking access during the initial GET aborts it even before a baseline exists',async t=>{
  const pending=deferred();let signal;const f=fixture(t,(url,o)=>{signal=o.signal;return pending.promise;});
  const load=f.store.activate();f.deny();await f.store.activate();assert.equal(signal.aborted,true);
  pending.resolve({sidebarNotepad:note('Private')});await load;assert.equal(f.store.value.text,'');assert.equal(f.store.ready,false);
});
test('closing the note changes only open status; text and preferred height survive responsive projection',async t=>{
  const writes=[];const {store}=fixture(t,async(url,o)=>{if(o.method==='PUT'){writes.push(JSON.parse(o.body).sidebarNotepad);return{};}return{sidebarNotepad:note('Keep me',{height:700,open:true})};});
  await store.activate();store.change({...store.value,open:false});await store.flush();assert.deepEqual(writes,[note('Keep me',{height:700,open:false})]);assert.equal(store.value.text,'Keep me');
});
test('debounced autosave writes current input and destroy cancels pending timers',async t=>{
  let writes=0;const store=createStore({key:()=> 'A',canUse:()=>true,delay:0,api:async(url,o)=>{if(o.method==='PUT'){writes++;return{};}return{sidebarNotepad:model.empty()};}});t.after(()=>store.destroy());
  await store.activate();store.change(note('First'));store.change(note('Last'));await new Promise(resolve=>setTimeout(resolve,10));assert.equal(writes,1);assert.equal(store.hasUnsaved,false);
  store.change(note('Destroyed'));store.destroy();await tick();assert.equal(writes,1);
});
