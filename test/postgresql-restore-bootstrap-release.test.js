'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const file=path.resolve(__dirname,'../lib/persistence/postgresql/operations/paired-restore.js');
const source=fs.readFileSync(file,'utf8'),localRequire=createRequire(file);
// Exercise the complete unchanged restore orchestration with synthetic native,
// filesystem and PostgreSQL adapters; never launch a cluster or access user data.
function fixture({adminEndFails=false,stopFails=false}={}){
 const events=[],clients=[],accounts=Object.fromEntries(['gp_migration_admin','gp_operations_monitor',...['core','sales'].flatMap(d=>['app','reader','migrator'].map(p=>'gp_'+d+'_'+p))].map(name=>[name,'x'.repeat(24)]));
 const config={format:'grabenplaner-postgresql-operations-v1',recoveryAccounts:accounts,domains:['core','sales'].map(domain=>({domain,database:'grabenplaner_'+domain,environmentId:'synthetic',profile:'synthetic'}))};
 const verified={manifestSha256:'synthetic',manifest:{
  files:[{file:'postgresql-operations.json'}],databases:config.domains,
  checkpoint:{domains:{core:{restore:{}},sales:{restore:{}}}},
 }};
 const closeError=new Error('synthetic bootstrap close failure'),stopError=new Error('synthetic cluster stop failure');
 class Client{
  constructor(options){this.options=options;this.bootstrap=options.database==='postgres';this.closed=false;clients.push(this);}
  async connect(){events.push(this.bootstrap?'admin-connected':'client-connected');}
  async query(sql){
   assert.equal(this.closed,false,'a closed client cannot be used');
   if(sql.startsWith('SELECT format'))return {rows:[{sql:'synthetic role password update'}]};
   if(sql.includes('FROM gp.environment_contract')){const d=config.domains.find(d=>d.database===this.options.database);return {rows:[{domain:d.domain,environment_id:d.environmentId,profile:d.profile}]};}
   if(sql.includes('FROM gp.data_import_runtime_keys'))return {rows:[{payload:'synthetic-key'}]};
   return {rows:[]};
  }
  async end(){events.push(this.bootstrap?'admin-end':'client-end');if(this.bootstrap&&adminEndFails)throw closeError;await new Promise(resolve=>setImmediate(resolve));this.closed=true;}
 }
 const virtualFs={
  statSync:name=>({uid:name.startsWith('/usr/')?0:500}),readdirSync:()=>[],statfsSync:()=>({bavail:20,bsize:1024**3}),
  mkdtempSync:()=>'/tmp/gp-pg-recovery-synthetic',chmodSync(){},writeFileSync(){},appendFileSync(){},unlinkSync(){},closeSync(){},openSync:()=>3,
  lstatSync:()=>({uid:0,mode:0o755,isFile:()=>true}),realpathSync:name=>name,
  rmSync:name=>{assert.equal(name,'/tmp/gp-pg-recovery-synthetic');events.push('socket-removed');},
  readFileSync(name){
   if(name.endsWith('/postgresql-operations.json'))return JSON.stringify(config);
   if(name.endsWith('/roles.sql'))return 'CREATE ROLE gp_migration_admin;\n';
   if(name.endsWith('/configuration.env'))return '';
   throw new Error('unexpected synthetic file '+name);
  },
 };
 const mocks={
  'node:fs':virtualFs,'node:path':path.posix,'pg':{Client},
  'node:child_process':{spawn(binary,args){const stop=binary.endsWith('/pg_ctl')&&args.at(-1)==='stop';if(stop)events.push('cluster-stop');return {once(){},stop};}},
  './paired-bundle':{safeRoot(){},async verifyPairBundle(){events.push('verify-bundle');return verified;}},
  './paired-checkpoint':{async verifyCheckpoint(_client,domain){events.push('verify-'+domain);return {verified:true};}},
  './restore-privileges':{async materializeDefaultPrivileges(){}},'../sales/layout':{SCHEMAS:['synthetic']},
  '../../../../server-tools/linux/recovery/lib/recovery-verify':{protectedRecordChecks:function*(){return 0;}},
  '../../../../server-tools/linux/recovery/lib/postgresql-recovery-activity':{
   childCompletion:child=>child.stop&&stopFails?Promise.reject(stopError):Promise.resolve({code:0}),
   monitorActivity:({completion})=>completion,terminateAndConfirm(){},readCgroupActivity(){},processCgroup(){},
  },
  '../../../amu-storage':{validateEncryptionKeyForStorage:()=>({fileCount:0}),createAmuStorage:()=>({})},
  '../../../integration-secret-vault':{createIntegrationSecretVault:()=>({useSecret:async(_a,_b,work)=>work(Buffer.alloc(64))})},
 };
 const context={module:{exports:{}},process:{platform:'linux',getuid:()=>500},performance,Buffer,require:name=>Object.hasOwn(mocks,name)?mocks[name]:localRequire(name)};
 vm.runInNewContext(source,context,{filename:file});
 return {events,clients,closeError,stopError,run:callback=>context.module.exports.restorePair({bundle:'/synthetic/bundle',commitMarker:'/synthetic/marker',workRoot:'/synthetic/work',onRestored:callback})};
}

test('bootstrap connection is closed before the real onRestored callback and never reacquired',async()=>{
 const f=fixture();
 const result=await f.run(async()=>{f.events.push('callback');assert.ok(f.clients.every(c=>c.closed));return {passed:true};});
 assert.equal(result.application.passed,true);assert.equal(f.events.filter(e=>e==='admin-end').length,1);
 assert.ok(f.events.indexOf('admin-end')<f.events.indexOf('callback'));
 assert.deepEqual(f.events.slice(-3),['verify-bundle','cluster-stop','socket-removed']);
});
test('callback failure preserves its error and still stops the cluster and removes its socket',async()=>{
 const f=fixture(),failure=new Error('synthetic callback failure');
 await assert.rejects(f.run(async()=>{assert.ok(f.clients.find(c=>c.bootstrap).closed);throw failure;}),e=>e===failure);
 assert.equal(f.events.filter(e=>e==='admin-end').length,1);assert.deepEqual(f.events.slice(-2),['cluster-stop','socket-removed']);
});
test('bootstrap close failure prevents the callback but cannot bypass cluster shutdown',async()=>{
 const f=fixture({adminEndFails:true});let called=false;
 await assert.rejects(f.run(async()=>{called=true;}),e=>e===f.closeError);
 assert.equal(called,false);assert.deepEqual(f.events.slice(-2),['cluster-stop','socket-removed']);
});
test('failed cluster stop retains its socket and rejects rather than claiming cleanup',async()=>{
 const f=fixture({stopFails:true});
 await assert.rejects(f.run(async()=>({passed:true})),e=>e===f.stopError);
 assert.equal(f.events.at(-1),'cluster-stop');assert.equal(f.events.includes('socket-removed'),false);
});
