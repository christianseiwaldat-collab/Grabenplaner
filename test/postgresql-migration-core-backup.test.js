'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module');
const file=path.resolve(__dirname,'../lib/persistence/postgresql/operations/runtime.js');
const realRequire=createRequire(file),source=fs.readFileSync(file,'utf8');
function fixture(t,change=()=>{},options={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gp-migration-core-proof-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const now=Date.now(),sha='a'.repeat(64),point={verified:true,scope:'deploy-owned',
  backup:{providerId:'postgresql-deploy-owned',recoveryScope:'deploy-owned',sha256:sha,
   bundle:path.join(directory,'00000000-0000-4000-8000-000000000001.owned'),createdAt:new Date(now-3*3600000).toISOString()},
  ownedRecovery:{verified:true,manifestSha256:sha,verifiedAt:new Date(now-300000).toISOString()}};
 change(point);
 let calls=0;const exports={};
 const app=path.resolve(path.dirname(file),'../../../..');
 const context={module:{exports},exports,__dirname:path.dirname(file),Buffer,URL,Date,
  process:{platform:'linux',getuid:()=>0},require(id){
   if(id==='../../../../server-tools/linux/lib/core-deploy-proof')return {async readProof(installed,candidate,envFile){
    calls++;assert.equal(installed,app);assert.equal(candidate,app);
    assert.equal(envFile,'/etc/grabenplaner/grabenplaner.env');
    if(options.rejectProof)throw new Error('CORE_DEPLOY_PACKAGE_BINDING');return point;
   }};
   return realRequire(id);
  }};
 vm.runInNewContext(source,context,{filename:file});
 const config={mode:'productive',sourceFiles:'/var/lib/grabenplaner',backupDirectory:directory};
 return {read:configOverride=>context.module.exports.latestBackup({...config,...configOverride},{short:options.short!==false,maximumAgeHours:1}),calls:()=>calls,point};
}
test('maintenance accepts an older captured Core point only after recent restoration with the installed target package',async t=>{
 const f=fixture(t),result=await f.read();
 assert.equal(result.verified,true);assert.equal(result.recoveryScope,'deploy-owned');
 assert.equal(result.verificationScope,'qualified-core-plus');assert.equal(result.createdAt,f.point.backup.createdAt);
 assert.ok(result.ageSeconds>=3*3600);assert.ok(result.qualificationAgeSeconds>=300&&result.qualificationAgeSeconds<310);
 assert.equal(f.calls(),1);
});
for(const [name,change]of[
 ['unverified restore',p=>p.ownedRecovery.verified=false],
 ['different restored point',p=>p.ownedRecovery.manifestSha256='b'.repeat(64)],
 ['different backup directory',p=>p.backup.bundle=path.join(path.dirname(p.backup.bundle),'other','point.owned')],
 ['stale restoration',p=>p.ownedRecovery.verifiedAt=new Date(Date.now()-2*3600000).toISOString()],
 ['future restoration',p=>p.ownedRecovery.verifiedAt=new Date(Date.now()+600000).toISOString()],
 ['wrong recovery scope',p=>p.scope='full'],
])test('maintenance rejects '+name+' without a valid full fallback',async t=>{
 const f=fixture(t,change);await assert.rejects(f.read(),/PG_OPERATIONS_BACKUP_MISSING/);assert.equal(f.calls(),1);
});
test('a changed target package cannot use the previous Core qualification',async t=>{
 const f=fixture(t,()=>{},{rejectProof:true});await assert.rejects(f.read(),/PG_OPERATIONS_BACKUP_MISSING/);
});
test('full/content probes never substitute Core proof for a complete pair',async t=>{
 const f=fixture(t,()=>{},{short:false});await assert.rejects(f.read(),/PG_OPERATIONS_BACKUP_MISSING/);assert.equal(f.calls(),0);
});
test('nonproductive probes retain the complete-pair contract',async t=>{
 const f=fixture(t);await assert.rejects(f.read({mode:'rehearsal'}),/PG_OPERATIONS_BACKUP_MISSING/);assert.equal(f.calls(),0);
});
