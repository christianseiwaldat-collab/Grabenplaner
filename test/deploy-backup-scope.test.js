'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const P=require('../lib/deploy-backup-scope');
const revision='09baa6e8-0be9-4b44-93c0-e726cba9ed17';
const stored=(scope='deploy-owned',overrides={})=>JSON.stringify({format:P.FORMAT,scope,revision,...overrides});
const sha=v=>crypto.createHash('sha256').update(String(v)).digest('hex');

test('missing preference is full; only an exact persisted schema and string UUID can opt into owned',()=>{
 for(const raw of [undefined,null,''])assert.deepEqual(P.read(raw),{scope:'full',revision:'0',valid:true});
 assert.deepEqual(P.read(stored()),{scope:'deploy-owned',revision,valid:true});
 for(const raw of ['{','null','[]','true','{}',stored('other'),stored('deploy-owned',{format:'other'}),stored('deploy-owned',{extra:true}),
  stored('deploy-owned',{revision:[revision]}),stored('deploy-owned',{revision:{value:revision}}),stored('deploy-owned',{revision:0}),stored('deploy-owned',{revision:revision.toUpperCase()})]){
  assert.deepEqual(P.read(raw),{scope:'full',revision:'invalid-'+sha(raw),valid:false});
 }
});

test('mutation input rejects unknown keys, alternate scopes and non-string or unrecognized revisions',()=>{
 for(const body of [null,[],{},'full',{scope:'full'},{scope:'full',expectedRevision:0},{scope:'full',expectedRevision:[revision]},
  {scope:'owned',expectedRevision:'0'},{scope:'full',expectedRevision:'bad'},
  {scope:'full',expectedRevision:'0',force:true},{scope:'full',expectedRevision:'0',path:'/tmp'}])
  assert.throws(()=>P.validateChange(body),{code:'DEPLOY_BACKUP_SCOPE_INVALID'});
 for(const expectedRevision of ['0',revision,'invalid-'+'a'.repeat(64)])assert.deepEqual(P.validateChange({scope:'full',expectedRevision}),{scope:'full',expectedRevision});
});

test('CAS applies one new revision, is idempotent and repairs invalid storage without reusing its value',()=>{
 const first=P.change(undefined,{scope:'deploy-owned',expectedRevision:'0'});assert.equal(first.changed,true);assert.equal(first.state.valid,true);assert.equal(first.state.scope,'deploy-owned');
 assert.notEqual(first.state.revision,'0');assert.deepEqual(P.change(first.value,{scope:'deploy-owned',expectedRevision:first.state.revision}),{changed:false,value:first.value,state:first.state});
 assert.throws(()=>P.change(first.value,{scope:'full',expectedRevision:'0'}),{code:'DEPLOY_BACKUP_SCOPE_STALE'});
 const corrupt='PRIVATE_INVALID_SETTING',fallback=P.read(corrupt),repaired=P.change(corrupt,{scope:'full',expectedRevision:fallback.revision});
 assert.equal(repaired.changed,true);assert.equal(repaired.state.valid,true);assert.equal(repaired.state.scope,'full');assert.notEqual(repaired.state.revision,fallback.revision);
 assert.equal(repaired.value.includes(corrupt),false);
});

test('public response and policy preserve the update-only boundary and explicit CLI selection',()=>{
 assert.deepEqual(P.response(P.read(undefined)),{scope:'full',revision:'0',label:'Vollständig: GP Core und Sales',appliesTo:'deploy-auto',available:true,valid:true});
 for(const verification of ['auto','full','deploy-owned'])for(const scope of P.SCOPES)
  assert.equal(P.effectivePolicy(verification,scope),verification==='auto'&&scope==='deploy-owned'?'deploy-owned':verification);
 assert.throws(()=>P.effectivePolicy('unknown','deploy-owned'),{code:'DEPLOY_BACKUP_SCOPE_INVALID'});
});

// Execute the exported operations client's actual source with an injected driver.
// This checks its SQL/protocol and lifecycle, without opening a native database.
const runtime=fs.readFileSync(path.join(__dirname,'../lib/persistence/postgresql/operations/runtime.js'),'utf8');
function sourceFunction(name){const start=runtime.search(new RegExp('^(?:async )?function '+name+'\\(','m')),end=runtime.indexOf('\n}',start);assert.ok(start>=0&&end>start);return runtime.slice(start,end+2);}
function reader({raw,environment,settings,errorAt,missingCore=false}={}){
 const calls=[],clients=[];
 class Client{
  constructor(options){this.options=options;clients.push(this);}
  async connect(){calls.push(['connect']);if(errorAt==='connect')throw new Error('CONNECT_TEST');}
  async query(sql,parameters){calls.push([sql,parameters]);if(errorAt===sql)throw new Error('QUERY_TEST');
   if(sql.includes('environment_contract'))return{rows:environment||[{environment_id:'synthetic-env',profile:'development',domain:'core'}]};
   if(sql.includes('gp.settings'))return{rows:settings|| (raw===undefined?[]:[{value:raw}])};return{rows:[]};}
  async end(){calls.push(['end']);}
 }
 const context=vm.createContext({require:name=>{if(name==='pg')return{Client};assert.equal(name,'../../../deploy-backup-scope');return P;}});
 vm.runInContext(sourceFunction('url')+'\n'+sourceFunction('readDeployBackupScope'),context);
 const config={host:'127.0.0.1',port:55482,domains:missingCore?[]:[{domain:'core',database:'synthetic_core',role:'gp_core_migrator',password:'synthetic-only',environmentId:'synthetic-env',profile:'development'}]};
 return{calls,clients,run:()=>context.readDeployBackupScope(config)};
}

test('operations scope reader is read-only, parameterized, environment-bound and closes the client',async()=>{
 const f=reader({raw:stored()});assert.equal((await f.run()).scope,'deploy-owned');
 assert.equal(f.clients.length,1);assert.equal(f.clients[0].options.statement_timeout,5000);assert.equal(f.clients[0].options.database,'synthetic_core');
 assert.deepEqual(f.calls.map(row=>row[0]),['connect','BEGIN READ ONLY','SELECT environment_id,profile,domain FROM gp.environment_contract','SELECT value FROM gp.settings WHERE key=$1','COMMIT','end']);
 assert.deepEqual(Array.from(f.calls[3][1]),[P.KEY]);
});

test('operations scope reader rejects unknown or mismatched environments before reading the preference',async()=>{
 for(const environment of [[],[{environment_id:'foreign',profile:'development',domain:'core'}],[{environment_id:'synthetic-env',profile:'productive',domain:'core'}],[{environment_id:'synthetic-env',profile:'development',domain:'sales'}]]){
  const f=reader({environment});await assert.rejects(f.run(),/PG_OPERATIONS_ENVIRONMENT/);assert.equal(f.calls.at(-1)[0],'end');
  assert.equal(f.calls.some(([sql])=>sql.includes('gp.settings')||sql==='COMMIT'),false);
 }
 const f=reader({missingCore:true});await assert.rejects(f.run(),/PG_OPERATIONS_DOMAINS/);assert.equal(f.clients.length,0);
});

test('operations missing/invalid preference falls back to full and duplicate settings fail closed',async()=>{
 for(const raw of [undefined,'invalid',stored('deploy-owned',{revision:[revision]})]){const f=reader({raw});assert.equal((await f.run()).scope,'full');assert.equal(f.calls.at(-1)[0],'end');}
 const f=reader({settings:[{value:stored()},{value:stored()}]});await assert.rejects(f.run(),/PG_OPERATIONS_SETTINGS/);assert.equal(f.calls.at(-1)[0],'end');assert.equal(f.calls.some(([sql])=>sql==='COMMIT'),false);
});

test('operations client closes on connect and query failures without committing',async()=>{
 for(const errorAt of ['connect','BEGIN READ ONLY','SELECT environment_id,profile,domain FROM gp.environment_contract','SELECT value FROM gp.settings WHERE key=$1']){
  const f=reader({errorAt});await assert.rejects(f.run(),/CONNECT_TEST|QUERY_TEST/);assert.equal(f.calls.at(-1)[0],'end');assert.equal(f.calls.some(([sql])=>sql==='COMMIT'),false);
 }
});
