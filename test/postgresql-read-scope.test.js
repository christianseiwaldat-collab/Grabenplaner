'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createReadScope}=require('../lib/persistence/postgresql/read-scope');
const {createPersistenceProviderFacade,definePersistenceStatement}=require('../lib/persistence/contract');
const {POSTGRESQL_CAPABILITIES}=require('../lib/persistence/postgresql/provider');
const statement=definePersistenceStatement({id:'test.read-scope',operation:'queryOne',parameters:{id:{kind:'text'}},columns:{id:{kind:'text'},data:{kind:'json'}}});

function fixture() {
  const calls=[];let version=1,allowed=true;
  const rows=p=>[{id:p.id,data:{version}}];
  const base={providerId:'postgresql',capabilities:POSTGRESQL_CAPABILITIES,
    async query(s,p){calls.push('single');return rows(p);},
    async execute(){throw Error('unexpected write');},async close(){},
    async beginTransaction(options){
      calls.push(['begin',options]);const snapshot=version;
      return {async query(s,p){calls.push(['read',p.id]);await Promise.resolve();return [{id:p.id,data:{version:snapshot}}];},
        async execute(){throw Error('unexpected write');},
        async commit(){calls.push('authorize');if(!allowed)throw Error('revoked');calls.push('commit');},
        async rollback(){calls.push('rollback');}};
    }};
  const underlying=createPersistenceProviderFacade(base),scope=createReadScope({getProvider:async()=>underlying});
  const provider=createPersistenceProviderFacade({...base,query:scope.query,
    async execute(){scope.assertOutside();return base.execute();},
    async beginTransaction(options){return scope.join(options)||base.beginTransaction(options);}});
  return {scope,provider,calls,bump(){version++;},revoke(){allowed=false;}};
}

test('read model shares concurrent reads, isolates returned objects and reauthorizes once',async()=>{
  const f=fixture();
  await f.scope.run(async()=>{
    const [a,b]=await Promise.all([f.provider.queryOne(statement,{id:'a'}),f.provider.queryOne(statement,{id:'a'})]);
    assert.throws(()=>{a.data.version=99;},TypeError);assert.equal(b.data.version,1);
    assert.notEqual(a,b);assert.notEqual(a.data,b.data);
    f.bump();assert.equal((await f.provider.queryOne(statement,{id:'a'})).data.version,1);
    assert.equal((await f.provider.queryOne(statement,{id:'b'})).data.version,1);
  });
  assert.deepEqual(f.calls,[['begin',{isolation:'serializable',readOnly:true}],['read','a'],['read','b'],'authorize','commit']);
  assert.equal((await f.scope.run(()=>f.provider.queryOne(statement,{id:'a'}))).data.version,2);
});
test('independent requests never share cached values or transactions',async()=>{
  const f=fixture();let release;const wait=new Promise(r=>release=r);
  const first=f.scope.run(async()=>{const row=await f.provider.queryOne(statement,{id:'same'});await wait;return row;});
  await new Promise(setImmediate);f.bump();
  const second=await f.scope.run(()=>f.provider.queryOne(statement,{id:'same'}));release();
  assert.equal((await first).data.version,1);assert.equal(second.data.version,2);
});
test('revocation before completion rejects the whole response and rolls back',async()=>{
  const f=fixture();
  await assert.rejects(f.scope.run(async()=>{await f.provider.queryOne(statement,{id:'a'});f.revoke();return 'must not return';}));
  assert.ok(f.calls.includes('rollback'));assert.ok(!f.calls.includes('commit'));
});
test('writes and independently opened transactions cannot escape the read-only scope',async()=>{
  const f=fixture();
  await assert.rejects(f.scope.run(async()=>{
    await assert.rejects(f.provider.transaction(async()=>{}),{code:'PERSISTENCE_TRANSACTION_STATE_INVALID'});
  }),{code:'PERSISTENCE_TRANSACTION_STATE_INVALID'});
  assert.ok(!f.calls.includes('commit'));
});
test('explicit read-only repository transactions join the snapshot; an inner rollback aborts it',async()=>{
  const f=fixture();
  await f.scope.run(async()=>{
    await f.provider.queryOne(statement,{id:'shared'});
    await f.provider.transaction(tx=>tx.queryOne(statement,{id:'shared'}),{readOnly:true});
  });
  assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='begin').length,1);
  assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='read').length,1);
  await assert.rejects(f.scope.run(async()=>{
    await assert.rejects(f.provider.transaction(async()=>{throw Error('inner failure');},{readOnly:true}));
  }),{code:'PERSISTENCE_TRANSACTION_STATE_INVALID'});
});
test('failed reads and late asynchronous continuations cannot reuse a completed scope',async()=>{
  const f=fixture();let late;
  await assert.rejects(f.scope.run(async()=>{
    late=()=>f.provider.queryOne(statement,{id:'a'});
    throw Error('failed model');
  }),/failed model/);
  // An inherited async context remains closed even after its parent completed.
  let finish,continuation;
  const gate=new Promise(r=>finish=r);
  await f.scope.run(async()=>{continuation=gate.then(()=>late());});
  finish();await assert.rejects(continuation,{code:'PERSISTENCE_TRANSACTION_STATE_INVALID'});
  assert.equal((await f.provider.queryOne(statement,{id:'a'})).data.version,1);
});
