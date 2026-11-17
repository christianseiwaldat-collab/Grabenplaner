'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
function fixture({host='/tmp/gp-pg-recovery-owned',port=55484,listen='127.0.0.1',external=false,uid=500,socketUid=500,socketMode=0o700,mismatch=false,replayError=null,fresh=false}={}){
 const file=path.resolve(__dirname,'../lib/persistence/postgresql/operations/owned-recovery.js'),localRequire=createRequire(file),events=[];
 const config={domains:['core','sales'].map(domain=>({domain,database:'gp_migration_'+domain})),recoveryAccounts:{gp_core_app:'a'.repeat(24),gp_sales_app:'b'.repeat(24)}};
 const clients=['core','sales'].map((domain,index)=>({connectionParameters:{host,port,database:'gp_migration_'+domain},async query(){events.push('identity-'+domain);return {rows:[{socket:host,port:String(port),listen,cluster_id:mismatch&&index===1?'222':'111'}]};}}));
 const access={synthetic:true};
 const mocks={
  'node:fs':{lstatSync:()=>({uid:socketUid,mode:socketMode,isDirectory:()=>true,isSymbolicLink:()=>false}),realpathSync:p=>p},
  'node:os':{networkInterfaces:()=>({lo:[{internal:true}],...(external?{eth0:[{internal:false}]}:{})})},
  './access-owned-state':{FORMAT:'grabenplaner-access-owned-state-v3',FRESH_FORMAT:'grabenplaner-access-owned-state-v4'},
  '../boundary/application':{async openTwoDatabaseDevelopmentApplication(options){events.push('application-open');
   for(const domain of ['core','sales']){const url=new URL(options[domain+'Url']);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55484');assert.equal(url.pathname,'/gp_migration_'+domain);assert.equal(decodeURIComponent(url.username),'gp_'+domain+'_app');}
   return {provider:access,async close(){events.push('application-close');}};
  }},
  './access-source-replay':{async replaySources(options){events.push('source-replay');assert.equal(options.access,access);assert.equal(options.isolatedRecovery,true);
   for(const phase of ['review','apply','generic-cash-history'])options.onProgress({phase,sourceId:'private-source-id'});
   if(replayError)throw replayError;return {verified:true,rehydrated:true};}},
  './access-fresh-rebuild':{async rebuildFreshSources(options){events.push('fresh-rebuild');assert.equal(options.access,access);assert.equal(options.isolatedRecovery,true);assert.equal(options.sourceDirectory,'/synthetic/fresh-access');
   options.onProgress({phase:'cash',sourceId:'private-new-source-id'});return {verified:true,rehydrated:true,cash:{verified:true}};}},
 };
 const context={module:{exports:{}},process:{platform:'linux',getuid:()=>uid},URL,Buffer,require:name=>Object.hasOwn(mocks,name)?mocks[name]:localRequire(name)};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 return {events,run:(onProgress=()=>{})=>context.module.exports.rehydrateOwnedSources({core:clients[0],sales:clients[1],vault:{},archive:{},recovery:fresh?{basis:'fresh-source-rebuild',accessPlan:{format:'grabenplaner-access-owned-state-v4'},freshSourcePlan:{}}:{accessPlan:{format:'grabenplaner-access-owned-state-v3'},sourceReplayPlan:{}},config,socket:'/tmp/gp-pg-recovery-owned',workRoot:'/synthetic/private/work',freshSourceDirectory:'/synthetic/fresh-access',onProgress})};
}
test('source replay opens application pools only for both verified private restored databases',async()=>{
 const f=fixture();assert.equal((await f.run()).verified,true);
 assert.deepEqual(f.events,['identity-core','identity-sales','application-open','source-replay','application-close']);
});
test('productive endpoints, root execution, external interfaces and unsafe socket ownership reject before application access',async()=>{
 for(const options of [{host:'127.0.0.1',port:55486},{port:55486},{uid:0},{external:true},{socketUid:0},{socketMode:0o755}]){
  const f=fixture(options);await assert.rejects(f.run(),/PG_DEPLOY_SOURCE_REPLAY_ISOLATION/);
  assert.equal(f.events.includes('application-open'),false);
 }
});
test('a server with different loopback settings or a mismatched database cluster cannot be replayed',async()=>{
 for(const options of [{listen:'*'},{listen:''},{mismatch:true}]){
  const f=fixture(options);await assert.rejects(f.run(),/PG_DEPLOY_SOURCE_REPLAY_ISOLATION/);
  assert.equal(f.events.includes('application-open'),false);
 }
});
test('failed source replay always closes its application pools',async()=>{
 const failure=new Error('synthetic source failure'),f=fixture({replayError:failure});
 await assert.rejects(f.run(),error=>error===failure);assert.equal(f.events.at(-1),'application-close');
});
test('source progress is adapted to the real worker phase protocol without source metadata',async()=>{
 const f=fixture(),phases=[];
 await f.run(phase=>{assert.equal(typeof phase,'string');assert.match(phase,/^[a-z0-9-]+$/);phases.push(phase);});
 assert.deepEqual(phases,['replay-access-review','replay-access-apply','replay-cash-history']);
});

test('new Access generation uses the same isolated endpoint guard and emits no historical source identity',async()=>{
 const f=fixture({fresh:true}),phases=[];const result=await f.run(phase=>phases.push(phase));
 assert.equal(result.cash.verified,true);assert.deepEqual(phases,['rebuild-cash-source']);
 assert.deepEqual(f.events,['identity-core','identity-sales','application-open','fresh-rebuild','application-close']);
 const unsafe=fixture({fresh:true,external:true});await assert.rejects(unsafe.run(),/PG_DEPLOY_SOURCE_REPLAY_ISOLATION/);
 assert.equal(unsafe.events.includes('application-open'),false);
});

test('the real worker chooses GP smoke for fresh generations and keeps full fixture checks for full and exact-archive recovery',()=>{
 const choose=require('../server-tools/linux/recovery/lib/postgresql-recovery-worker').applicationScenario;
 assert.equal(choose({scope:'full'}),'full');assert.equal(choose({scope:'deploy-owned'}),'deploy-owned');
 assert.equal(choose({scope:'deploy-owned',rehydrate:true}),'full');
 for(const rehydrate of [false,true])assert.equal(choose({scope:'deploy-owned',rehydrate,basis:'fresh-source-rebuild'}),'deploy-owned');
 assert.throws(()=>choose({scope:'full-ish'}),/PG_RECOVERY_SCOPE_INVALID/);
 assert.throws(()=>choose({scope:'deploy-owned',rehydrate:true,basis:'unverified'}),/PG_RECOVERY_SCOPE_INVALID/);
});

test('fresh worker receipts require GP smoke plus every chosen new input hash and never claim the old full Sales fixture',()=>{
 const {applicationRecoveryPassed:passed}=require('../server-tools/linux/recovery/lib/postgresql-recovery');
 const kinds=require('../lib/data-import-source-catalog').SOURCE_KINDS.map(kind=>({kind})),recovery={basis:'fresh-source-rebuild',freshSourcePlan:{planSha256:'a'.repeat(64),actors:[{scopeId:'fixture'}],kinds}};
 const freshInputProof={verified:true,sources:kinds.map(({kind})=>({kind,bytes:4096,sha256:'b'.repeat(64)}))};
 const replay={format:require('../lib/persistence/postgresql/operations/access-fresh-rebuild').FORMAT,basis:recovery.basis,verified:true,rehydrated:true,newSourceGeneration:true,oldSourceValuesReconstructed:false,planSha256:recovery.freshSourcePlan.planSha256,
  sourceCount:6,sources:kinds.map(({kind})=>({kind,scopeId:'fixture',fileSha256:'b'.repeat(64),bytes:4096,status:kind==='cash'?'ready':'applied'}))};
 const result={fullRecovery:false,requiresFreshAccess:false,requiresAccessRehydration:false,requiresCashRehydration:false,application:{ownedApplicationSmoke:true,fullApplicationSmoke:false},cashRehydration:{verified:true},accessRehydration:{verified:true,rehydrated:true,sourceReplay:replay}};
 const context={scope:'deploy-owned',rehydrate:true,fresh:true,recovery,result,freshInputProof};assert.equal(passed(context),true);
 for(const change of [c=>c.result.application.fullApplicationSmoke=true,c=>c.result.application.ownedApplicationSmoke=false,c=>c.result.fullRecovery=true,
  c=>c.result.requiresFreshAccess=true,c=>c.result.cashRehydration.verified=false,c=>c.result.accessRehydration.sourceReplay.sources.pop(),
  c=>c.result.accessRehydration.sourceReplay.sources[0].fileSha256='c'.repeat(64),c=>c.result.accessRehydration.sourceReplay.sources[0].scopeId='other',
  c=>c.result.accessRehydration.sourceReplay.sources[0]=c.result.accessRehydration.sourceReplay.sources[1],c=>c.result.accessRehydration.sourceReplay.verified=false,
  c=>c.result.accessRehydration.sourceReplay.oldSourceValuesReconstructed=true,c=>c.result.accessRehydration.sourceReplay.planSha256='d'.repeat(64),
  c=>c.freshInputProof.verified=false,c=>c.freshInputProof.sources[0].bytes=8192]){
  const copy=JSON.parse(JSON.stringify(context));change(copy);assert.equal(passed(copy),false);
 }
 assert.equal(passed({scope:'full',result:{application:{fullApplicationSmoke:true}}}),true);
 assert.equal(passed({scope:'deploy-owned',rehydrate:true,fresh:false,result:{...result,application:{fullApplicationSmoke:true}}}),true);
 const fast={...context,rehydrate:false,result:{...result,requiresCashRehydration:true,requiresAccessRehydration:true,requiresFreshAccess:true}};
 assert.equal(passed(fast),true);assert.equal(passed({...fast,result:{...fast.result,requiresFreshAccess:false}}),false);
});
