'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restorePerformance,restoreArguments,restoreSettings}=require('../lib/persistence/postgresql/operations/restore-performance');
const {phaseTimer}=require('../lib/persistence/postgresql/operations/phase-timing');
test('recovery profiles cap parallelism and cannot accept arbitrary native flags',()=>{
 for(const bad of ['__proto__','toString','--jobs=99',{},null,2])assert.throws(()=>restorePerformance(bad),/PG_PAIR_RESTORE_PROFILE/);
 const serial=restoreArguments('example','/isolated/example.dump','memory');
 const parallel=restoreArguments('example','/isolated/example.dump');
 assert.ok(serial.includes('--single-transaction'));assert.ok(!serial.some(s=>s.startsWith('--jobs')));
 assert.ok(parallel.includes('--jobs=2'));assert.ok(!parallel.includes('--single-transaction'));
 for(const args of [serial,parallel])assert.ok(args.includes('--exit-on-error'));
 assert.match(restoreSettings(),/maintenance_work_mem='256MB'/);
 assert.match(restoreSettings(),/max_parallel_maintenance_workers=0/);
 assert.ok(Object.isFrozen(restorePerformance()));
});
test('phase measurements preserve values and the original failure even if telemetry fails',async()=>{
 const entries=[],measure=phaseTimer(entry=>entries.push(entry));
 const result={checkpoint:'unchanged'};assert.equal(await measure('row-counts',async()=>result),result);
 const failure=new Error('synthetic-operation-failure');
 await assert.rejects(measure('dump',async()=>{throw failure;}),e=>e===failure);
 assert.deepEqual(entries.map(e=>[e.phase,e.succeeded]),[['row-counts',true],['dump',false]]);
 assert.ok(entries.every(e=>Number.isInteger(e.milliseconds)&&e.milliseconds>=0));
 const broken=phaseTimer(()=>{throw new Error('telemetry');});
 assert.equal(await broken('file-copy',async()=>result),result);
 await assert.rejects(broken('dump',async()=>{throw failure;}),e=>e===failure);
});

test('paired backup returns phase timings outside the unchanged signed checkpoint',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {createPairedSnapshot}=require('../lib/persistence/postgresql/operations/paired-backup');
 const {verifyPairBundle}=require('../lib/persistence/postgresql/operations/paired-bundle');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gp-backup-phases-'));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let released=0,commits=0;
 const domains=['core','sales'].map(domain=>({domain,database:'test_'+domain,ownerRole:'test_owner',pool:{async connect(){return {
  async query(sql){
   if(sql.includes('current_database()'))return {rows:[{name:'test_'+domain}]};
   if(sql.includes('FROM pg_tables'))return {rows:[{schemaname:'gp',tablename:'example'}]};
   if(sql.includes('pg_export_snapshot'))return {rows:[{id:'123-A'}]};
   if(sql==='COMMIT')commits++;
   return {rows:[]};
  },release(){released++;},
 };}}}));
 const result=await createPairedSnapshot({backupDirectory:root,domains,withQuiescedWrites:work=>work({active:true,pendingMutations:0}),
  async readCheckpoint({domain,onTiming}){return phaseTimer(onTiming)('row-counts',async()=>({fixture:domain}));},
  async runDump({targetFile,onTiming}){await phaseTimer(onTiming)('dump',()=>fs.writeFileSync(targetFile,'synthetic',{mode:0o600}));},
  async captureRecoveryFiles({directory,onTiming}){await phaseTimer(onTiming)('file-copy',()=>{for(const name of ['roles.sql','configuration.env'])fs.writeFileSync(path.join(directory,name),'synthetic',{mode:0o600});});},
 });
 assert.equal(commits,2);assert.equal(released,2);
 assert.deepEqual(result.phaseTimings.filter(e=>e.phase==='row-counts').map(e=>e.domain),['core','sales']);
 assert.ok(result.phaseTimings.some(e=>e.phase==='hash-and-seal'&&e.succeeded));
 const verified=await verifyPairBundle(result.bundle,result.commitMarker);
 assert.deepEqual(verified.manifest.checkpoint.domains,{core:{fixture:'core'},sales:{fixture:'sales'}});
 assert.equal(Object.hasOwn(verified.manifest,'phaseTimings'),false);
});
