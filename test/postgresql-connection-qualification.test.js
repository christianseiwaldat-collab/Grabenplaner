'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createPostgresqlPersistenceProvider}=require('../lib/persistence/postgresql/provider');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture(connect){
 const queries=[],releases=[];
 const client={async query(sql){queries.push(sql);return {rows:[],rowCount:0};},release(discard){releases.push(discard);}};
 const pool={connect:connect||async function(){return client;},async end(){},on(){},removeListener(){}};
 return {pool,client,queries,releases};
}

test('a valid schema qualification may finish after the acquisition deadline without admitting unverified queries',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(),qualification=deferred();let preparing=false,completed=false;
 const provider=createPostgresqlPersistenceProvider({pool:f.pool,prepareClient:async client=>{
  assert.equal(client,f.client);preparing=true;await qualification.promise;
 }});
 t.after(()=>qualification.resolve());
 const request=provider.transaction(async()=>{completed=true;return 'ready';},{readOnly:true});request.catch(()=>{});
 await turn();assert.equal(preparing,true);assert.deepEqual(f.queries,[]);
 t.mock.timers.tick(6000);await turn();
 assert.equal(completed,false);assert.deepEqual(f.queries,[]);assert.deepEqual(f.releases,[]);
 qualification.resolve();assert.equal(await request,'ready');assert.equal(completed,true);
 assert.match(f.queries[0],/^BEGIN /);assert.equal(f.queries.at(-1),'COMMIT');
 await provider.close();
});

test('an exhausted pool still fails at five seconds and discards a late connection without qualifying it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=deferred(),f=fixture(()=>pending.promise);let preparations=0;
 const provider=createPostgresqlPersistenceProvider({pool:f.pool,prepareClient:async()=>{preparations++;}});
 const rejected=assert.rejects(provider.transaction(async()=>{}, {readOnly:true}),{code:'PERSISTENCE_TIMEOUT'});
 await turn();t.mock.timers.tick(5000);await rejected;
 pending.resolve(f.client);await turn();
 assert.equal(preparations,0);assert.deepEqual(f.queries,[]);assert.deepEqual(f.releases,[true]);
 await provider.close();
});

for(const [code,expected] of [['42P01','PERSISTENCE_SCHEMA_INVALID'],['57014','PERSISTENCE_TIMEOUT']]){
 test('failed qualification '+code+' discards the connection before any application transaction',async()=>{
  const f=fixture();const provider=createPostgresqlPersistenceProvider({pool:f.pool,prepareClient:async()=>{throw Object.assign(new Error('PRIVATE'),{code});}});
  await assert.rejects(provider.transaction(async()=>assert.fail('unverified work'),{readOnly:true}),{code:expected});
  assert.deepEqual(f.queries,[]);assert.deepEqual(f.releases,[true]);await provider.close();
 });
}

for(const domain of ['core','sales'])for(const failReplacement of [false,true]){
 test(domain+' verifies each replacement connection before exposing it; rejected='+failReplacement,async()=>{
  const verified=[],clients=[];let ended=false;
  class Pool{
   async connect(){const client={number:clients.length+1,releases:[],queries:[],
    async query(sql){this.queries.push(sql);return {rows:sql.startsWith('SELECT stage,')?[{stage:5,plan_sha256:'plan',source_sha256:'source',target_sha256:'schema'}]:[],rowCount:0};},
    release(value){this.releases.push(value);}};clients.push(client);return client;}
   async end(){ended=true;}on(){}removeListener(){}
  }
  const modules={
   pg:{Pool},
   '../provider':{createPostgresqlPersistenceProvider},
   '../../application-repositories':{createApplicationRepositories:()=>({})},
   './environment':{configuration:()=>({max:1}),async verifyEnvironment(client){verified.push(client.number);if(failReplacement&&client.number===2)throw Object.assign(new Error('PRIVATE'),{code:'42P01'});}},
   './catalog':{createCoreCatalog:()=>({entries:[]}),createSalesCatalog:()=>({entries:[]})},
   './schema':{createSalesSchemaPlan:()=>({digest:'plan',sourceSchemaSha256:'source'})},
   './fingerprint':{schemaFingerprint:async()=> 'schema'},
   '../boundary/migrate':{verifyCoreSchema:async()=>({boundary:true})},
   './layout':{SCHEMAS:['gp'],SEARCH_PATH:'pg_catalog,gp'},
   './import-work-queues':{indexedImportWorkQueues:entries=>entries},
  };
  modules['../core/environment']=modules['./environment'];modules['../core/fingerprint']=modules['./fingerprint'];
  const file=path.resolve(__dirname,'../lib/persistence/postgresql/'+domain+'/application.js');
  const context={module:{exports:{}},performance,require:id=>modules[id]||{CATALOG:[]}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  const application=await context.module.exports[domain==='core'?'openCoreDevelopmentApplication':'openSalesDevelopmentApplication']({stage:5});
  assert.deepEqual(verified,[1]);
  const request=application.provider.transaction(async()=> 'verified',{readOnly:true});
  if(failReplacement){await assert.rejects(request,{code:'PERSISTENCE_SCHEMA_INVALID'});assert.deepEqual(clients[1].releases,[true]);assert.equal(clients[1].queries.length,0);}
  else{assert.equal(await request,'verified');assert.ok(clients[1].queries.some(sql=>sql.startsWith('BEGIN ')));}
  assert.deepEqual(verified,[1,2]);await application.close();assert.equal(ended,true);
 });
}
