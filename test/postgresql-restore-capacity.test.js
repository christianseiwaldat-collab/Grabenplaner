'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {restoreCapacity,assertRestoreCapacity}=require('../lib/persistence/postgresql/operations/restore-capacity');
const GiB=1024**3;
test('physical sizes of both databases determine restore reserve before cluster initialization',()=>{
 const manifest={checkpoint:{databaseBytes:{core:GiB,sales:10*GiB}},files:[{file:'private/document',bytes:GiB}]};
 const plan=restoreCapacity(manifest);
 assert.equal(plan.requiredBytes,19.5*GiB);assert.equal(plan.basis,'measured-database-size');
 assert.throws(()=>assertRestoreCapacity(manifest,19*GiB),/PG_PAIR_RESTORE_DISK_RESERVE/);
 assert.deepEqual(assertRestoreCapacity(manifest,19.5*GiB),plan);
});
test('legacy bundles remain usable with a bounded dump estimate and minimum reserve',()=>{
 const manifest={files:[{file:'core.dump',bytes:GiB},{file:'sales.dump',bytes:GiB}]};
 assert.deepEqual(restoreCapacity(manifest),{requiredBytes:18*GiB,basis:'legacy-dump-estimate'});
 assert.equal(restoreCapacity({files:[]}).requiredBytes,10*GiB);
});
test('partial, invalid and overflowing measurements fail closed',()=>{
 for(const measurement of [{core:1},{core:1,sales:-1},{core:0,sales:0},{core:1,sales:null},{core:Number.MAX_SAFE_INTEGER,sales:1}]){
  assert.throws(()=>restoreCapacity({checkpoint:{databaseBytes:measurement},files:[]}),/PG_PAIR_RESTORE_SIZE_INVALID/);
 }
});

test('reduced restore and emergency Access replay reserve the full databases and encrypted materialization scratch',()=>{
 const manifest={checkpoint:{databaseBytes:{core:GiB,sales:GiB}},
  recovery:{rehydrationDatabaseBytes:{core:GiB,sales:40*GiB}},files:[{file:'private/import-sources/fixture.source',bytes:GiB}]};
 assert.deepEqual(restoreCapacity(manifest),{requiredBytes:10*GiB,basis:'measured-database-size'});
 const replay={requiredBytes:104.5*GiB,basis:'measured-full-before-rehydration',accessScratchBytes:40*GiB};
 assert.deepEqual(restoreCapacity(manifest,{rehydrate:true}),replay);
 assert.deepEqual(assertRestoreCapacity(manifest,105*GiB,{rehydrate:true}),replay);
 assert.throws(()=>assertRestoreCapacity(manifest,65*GiB,{rehydrate:true}),/PG_PAIR_RESTORE_DISK_RESERVE/);
 assert.throws(()=>assertRestoreCapacity(manifest,10*GiB,{rehydrate:true}),/PG_PAIR_RESTORE_DISK_RESERVE/);
});

test('emergency replay refuses unknown, partial, zero and overflowing full measurements instead of estimating from small dumps',()=>{
 for(const measurement of [undefined,null,{}, {core:GiB},{core:GiB,sales:0},{core:0,sales:GiB},
  {core:GiB,sales:-1},{core:GiB,sales:null},{core:Number.MAX_SAFE_INTEGER,sales:1}]){
  const manifest={checkpoint:{databaseBytes:{core:GiB,sales:GiB}},recovery:{rehydrationDatabaseBytes:measurement},files:[{file:'sales.dump',bytes:1}]};
  assert.throws(()=>restoreCapacity(manifest,{rehydrate:true}),/PG_PAIR_RESTORE_SIZE_INVALID/);
 }
 assert.throws(()=>restoreCapacity({},{rehydrate:'true'}),/PG_PAIR_RESTORE_SIZE_INVALID/);
});
