'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Pool}=require('pg');
const {configuration,PROFILE}=require('../lib/persistence/postgresql/core/environment');
const runtime=require('../lib/persistence/postgresql/runtime-binding');
const {createPostgresqlPersistenceProvider}=require('../lib/persistence/postgresql/provider');
const {definePersistenceStatement}=require('../lib/persistence/contract');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const binding={format:runtime.FORMAT,profile:runtime.PROFILE,clusterId:'1234567890123456789',environmentId:'grabenplaner-pair-12345678-1234-4234-8234-123456789abc'};
function config(domain,{productiveConcurrency=true,development=false,purpose='app'}={}) {
  return configuration({profile:development?PROFILE:runtime.PROFILE,...(!development?{binding}:{}),domain,purpose,productiveConcurrency,
    databaseUrl:`postgresql://gp_${domain}_${purpose}:synthetic@127.0.0.1:55486/${development?'gp_migration':'grabenplaner'}_${domain}`,tlsMode:'disable-local-only'});
}

test('only explicitly activated productive pools grow; development, recovery and readers keep their budgets',()=>{
  for(const domain of ['core','sales']) {
    const productive=config(domain),recovery=config(domain,{productiveConcurrency:false}),development=config(domain,{productiveConcurrency:false,development:true});
    assert.equal(productive.max,4);
    assert.equal(recovery.max,domain==='core'?3:2);assert.equal(development.max,recovery.max);
    assert.equal(config(domain,{purpose:'reader'}).max,1);
    assert.equal(config(domain,{productiveConcurrency:false,development:true,purpose:'migrator'}).max,1);
    for(const settings of [productive,recovery,development]) {
      assert.equal(settings.connectionTimeoutMillis,5000);assert.equal(settings.statement_timeout,10000);
      assert.equal(settings.query_timeout,12000);assert.equal(settings.idle_in_transaction_session_timeout,30000);
    }
    assert.throws(()=>config(domain,{development:true}),/Verified database profile/);
    assert.throws(()=>config(domain,{productiveConcurrency:'true'}),/Verified database profile/);
  }
  // Main app + lock/auth/operations pools and four reader workers, including
  // their unused lock-pool ceilings. Preserve six nonreserved admin slots.
  const main=config('core').max+config('sales').max+3,workers=4*(1+1+1);
  assert.ok(main+workers<=32-3-6);
  assert.ok(config('core').max+2<=10);assert.ok(config('sales').max<=8);
});

const read=definePersistenceStatement({id:'concurrency.navigation',operation:'queryOne',parameters:{},columns:{value:'safe_integer'}});
const catalog=[{statement:read,sql:'SELECT 42 AS value',parameterOrder:[],returning:false}];
// Exercise the installed pg pool's real admission queue, with socket-free clients.
class SyntheticClient extends EventEmitter {
  constructor(){super();this._queryable=true;this._ending=false;}
  connect(callback){queueMicrotask(()=>callback(null));}
  async query(input){
    const sql=typeof input==='string'?input:input.text;
    return sql==='SELECT 42 AS value'?{rows:[[42]],rowCount:1,fields:[{name:'value',dataTypeID:23}]}:{rows:[],rowCount:0,fields:[]};
  }
  end(callback){this._ending=true;queueMicrotask(()=>{this.emit('end');callback?.();});}
  ref(){} unref(){}
}
function fixture(t,settings) {
  t.mock.timers.enable({apis:['setTimeout']});
  const pool=new Pool({...settings,min:settings.max,Client:SyntheticClient});
  const provider=createPostgresqlPersistenceProvider({pool,catalog,poolOwnership:'provider'});
  let release;
  const gate=new Promise(resolve=>{release=resolve;}),held=[];
  let entered=0;
  const hold=()=>{
    const pending=provider.transaction(async()=>{entered++;await gate;},{readOnly:true});
    pending.catch(()=>{});held.push(pending);
  };
  t.after(async()=>{release();await Promise.allSettled(held);await turn();await provider.close();assert.equal(pool.totalCount,0);});
  return {provider,pool,hold,release,get entered(){return entered;}};
}

for(const domain of ['core','sales']) {
  test(`${domain}: navigation completes alongside import and two other held requests without waiting five seconds`,async t=>{
    const f=fixture(t,config(domain));
    // One import packet, its status request and a second GP request are busy.
    f.hold();f.hold();f.hold();await turn();assert.equal(f.entered,3);
    assert.deepEqual(await f.provider.queryOne(read,{}),{value:42});
    assert.equal(f.pool.totalCount,4);assert.equal(f.pool.waitingCount,0);
    t.mock.timers.tick(6000);await turn();
    assert.deepEqual(await f.provider.queryOne(read,{}),{value:42});
    assert.equal(f.pool.totalCount,4);assert.equal(f.entered,3);
    f.release();
  });

  for(const productiveConcurrency of [false,true])test(`${domain}: ${productiveConcurrency?'new':'old'} pool limits still reject real exhaustion after five seconds`,async t=>{
    const settings=config(domain,{productiveConcurrency}),f=fixture(t,settings);
    for(let i=0;i<settings.max;i++)f.hold();
    await turn();assert.equal(f.entered,settings.max);
    const rejected=assert.rejects(f.provider.queryOne(read,{}),{code:'PERSISTENCE_TIMEOUT'});
    await turn();assert.equal(f.pool.waitingCount,1);
    t.mock.timers.tick(5000);await rejected;
    f.release();await turn();
    assert.ok(f.pool.totalCount<=settings.max);
    assert.deepEqual(await f.provider.queryOne(read,{}),{value:42});
  });
}
