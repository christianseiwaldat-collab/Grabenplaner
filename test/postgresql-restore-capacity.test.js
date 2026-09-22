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
