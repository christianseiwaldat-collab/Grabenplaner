'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../public/sales-article-detail-preferences');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture() {
  let key='A|read',allowed=true;const requests=[],errors=[],values=[];
  const store=model.createStore({key:()=>key,canUse:()=>allowed,error:error=>errors.push(error),
    api(url,options){const request={url,options,...deferred()};requests.push(request);return request.promise;}});
  store.subscribe(()=>values.push(store.value));
  return {store,requests,errors,values,key(value){key=value;},permit(value){allowed=value;}};
}
test('Stock preferences validate an independent, bounded contract with at least one visible column',()=>{
  const defaults=model.defaults();assert.equal(model.PREFERENCE_KEY,'sales_article_detail_v1');
  assert.deepEqual(model.normalize(defaults),defaults);
  const one={...defaults,columns:['ordered'],sort:'ordered',hiddenBranchIds:['00','18'],columnWidths:{branch:800,quantity:80}};
  const normalized=model.normalize(one);normalized.hiddenBranchIds.push('19');assert.deepEqual(one.hiddenBranchIds,['00','18']);
  for(const invalid of [null,{},[],{...defaults,version:2},{...defaults,employeeNumber:'other'},
    {...defaults,columns:[]},{...defaults,columns:['branch','branch']},{...defaults,columns:['secret']},
    {...defaults,columns:['quantity']},{...defaults,direction:'sql'},{...defaults,columnWidths:{branch:79}},
    {...defaults,columnWidths:{quantity:801}},{...defaults,columnWidths:{ordered:80.5}},{...defaults,columnWidths:{branch:'100'}},
    {...defaults,columnWidths:{unknown:100}},{...defaults,hiddenBranchIds:['18','18']},{...defaults,hiddenBranchIds:[' 18']},
    {...defaults,hiddenBranchIds:[18]},{...defaults,hiddenBranchIds:['x\0']},{...defaults,hiddenBranchIds:['x'.repeat(81)]},
    {...defaults,hiddenBranchIds:Array.from({length:501},(_,i)=>String(i))}]) assert.throws(()=>model.normalize(invalid),TypeError);
});
test('A delayed initial baseline blocks edits and saves, then preserves unrelated saved preferences',async()=>{
  for(const publish of [true,false]) {
    const f=fixture(),loading=f.store.activate();
    const baseline={...model.defaults(),hiddenBranchIds:['18'],columns:['branch','quantity'],columnWidths:{branch:230},sort:'quantity',direction:'desc'};
    assert.equal(f.store.ready,false);assert.equal(f.store.change({...model.defaults(),hiddenBranchIds:['19']},{publish}),false);
    assert.equal(await f.store.save(),false);assert.equal(f.requests[0].options.signal.aborted,false);
    assert.deepEqual(f.store.value,model.defaults());assert.equal(f.requests.length,1);
    f.requests[0].resolve({...baseline,configured:true});await loading;assert.equal(f.store.ready,true);
    const value={...f.store.value,hiddenBranchIds:[...f.store.value.hiddenBranchIds,'19']};
    assert.equal(f.store.change(value,{publish}),true);
    const saved=f.store.save();await tick();assert.deepEqual(JSON.parse(f.requests[1].options.body),value);
    f.requests[1].resolve({configured:true});await saved;
  }
});

test('Failed or invalid initial reads block all PUTs until an explicit successful retry',async()=>{
  for(const invalid of [false,true]) {
    const f=fixture(),loading=f.store.activate();
    if(invalid) f.requests[0].resolve({configured:true});else f.requests[0].reject(Error('read failed'));
    await loading;assert.equal(f.store.failed,true);assert.equal(f.store.ready,false);
    assert.equal(f.store.change({...model.defaults(),hiddenBranchIds:['19']}),false);assert.equal(await f.store.save(),false);
    await f.store.activate();assert.equal(f.requests.length,1,'a failed read waits for the explicit retry');
    const retry=f.store.activate({retry:true});assert.equal(f.store.failed,false);assert.equal(f.store.ready,false);
    const baseline={...model.defaults(),hiddenBranchIds:['18'],columnWidths:{branch:230}};
    f.requests[1].resolve({...baseline,configured:true});await retry;
    assert.equal(f.store.ready,true);assert.equal(f.store.failed,false);assert.deepEqual(f.store.value,baseline);
    f.store.change({...f.store.value,hiddenBranchIds:['18','19']});const saved=f.store.save();await tick();
    assert.equal(f.requests[2].options.method,'PUT');assert.deepEqual(JSON.parse(f.requests[2].options.body).columnWidths,{branch:230});
    f.requests[2].resolve({});await saved;assert.equal(f.errors.length,1);
  }
});

test('Switching accounts during initial loading gates edits until the new account baseline arrives',async()=>{
  const f=fixture(),first=f.store.activate();f.key('B|read');const second=f.store.activate();
  assert.equal(f.requests[0].options.signal.aborted,true);assert.equal(f.store.ready,false);
  assert.equal(f.store.change({...model.defaults(),hiddenBranchIds:['19']}),false);assert.equal(await f.store.save(),false);
  f.requests[0].resolve({...model.defaults(),hiddenBranchIds:['18'],configured:true});await first;
  assert.deepEqual(f.store.value,model.defaults());assert.equal(f.store.ready,false);
  const baseline={...model.defaults(),hiddenBranchIds:['20'],columnWidths:{quantity:150}};
  f.requests[1].resolve({...baseline,configured:true});await second;
  assert.equal(f.store.ready,true);assert.deepEqual(f.store.value,baseline);assert.equal(f.requests.length,2);
});
test('Rapid updates use immutable sequential snapshots and stale successful responses never change newer controls',async()=>{
  const f=fixture(),loading=f.store.activate();f.requests[0].resolve({...model.defaults(),configured:false});await loading;
  f.store.change({...model.defaults(),hiddenBranchIds:['18']});const first=f.store.save();
  f.store.change({...model.defaults(),hiddenBranchIds:['19'],columns:['quantity'],sort:'quantity'});const last=f.store.save();await tick();
  assert.equal(f.requests.length,2);assert.deepEqual(JSON.parse(f.requests[1].options.body).hiddenBranchIds,['18']);
  f.requests[1].resolve({...model.defaults(),configured:true});await first;await tick();
  assert.deepEqual(f.store.value.hiddenBranchIds,['19']);assert.deepEqual(JSON.parse(f.requests[2].options.body).columns,['quantity']);
  f.requests[2].resolve({});await last;assert.deepEqual(f.store.value.columns,['quantity']);
  await f.store.activate();assert.equal(f.requests.length,3,'article/navigation re-entry uses the current account state');
});
test('Failed writes retain current input, let later saves proceed and do not permit a stale reload',async()=>{
  const f=fixture(),loading=f.store.activate();f.requests[0].resolve({...model.defaults(),configured:false});await loading;
  f.store.change({...model.defaults(),hiddenBranchIds:['18']});const first=f.store.save();
  f.store.change({...model.defaults(),hiddenBranchIds:['19']});const last=f.store.save();await tick();
  f.requests[1].reject(Error('first failed'));await first;await tick();
  f.requests[2].reject(Error('latest failed'));await last;
  await f.store.activate();assert.equal(f.requests.length,3);assert.deepEqual(f.store.value.hiddenBranchIds,['19']);
  const retry=f.store.save();await tick();assert.deepEqual(JSON.parse(f.requests[3].options.body).hiddenBranchIds,['19']);
  f.requests[3].resolve({});await retry;assert.equal(f.errors.length,2);
});
test('Account, access projection and logout invalidation abort reads and discard pending and queued old writes',async()=>{
  for(const reason of ['account','projection','logout']) {
    const f=fixture(),loading=f.store.activate();f.requests[0].resolve({...model.defaults(),configured:true});await loading;
    f.store.change({...model.defaults(),hiddenBranchIds:['18']});const first=f.store.save();
    f.store.change({...model.defaults(),hiddenBranchIds:['19']});const queued=f.store.save();await tick();
    if(reason==='logout') f.permit(false);else f.key(reason==='account'?'B|read':'A|new-rights');
    f.store.invalidate();assert.equal(f.requests[1].options.signal.aborted,true);assert.deepEqual(f.store.value,model.defaults());
    f.requests[1].reject(Error('old account failure'));await first;await queued;
    assert.equal(f.requests.length,2);assert.equal(f.errors.length,0);
    f.permit(true);const reload=f.store.activate();f.requests[2].resolve({...model.defaults(),hiddenBranchIds:['00'],configured:true});await reload;
    assert.deepEqual(f.store.value.hiddenBranchIds,['00']);
  }
  const f=fixture(),read=f.store.activate();f.key('B|read');f.store.invalidate();
  f.requests[0].resolve({...model.defaults(),hiddenBranchIds:['18'],configured:true});await read;
  assert.deepEqual(f.store.value,model.defaults());
});
test('A failed read retries; disposed article subscriptions cannot receive later account preferences',async()=>{
  const f=fixture();let old=0,next=0;const remove=f.store.subscribe(()=>old++);
  const first=f.store.activate();f.requests[0].reject(Error('read failed'));await first;
  remove();const before=old;f.store.subscribe(()=>next++);
  const retry=f.store.activate({retry:true});f.requests[1].resolve({...model.defaults(),configured:false});await retry;
  assert.equal(old,before);assert.equal(next,2);assert.equal(f.errors.length,1);
});
