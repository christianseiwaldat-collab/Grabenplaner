'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('Native publication optimization migrates and rolls back atomically without changing stock proofs',
 {skip:!process.env.GP_CORE_MIGRATOR_URL},async t=>{
 await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async pg=>{
  const m=require('../lib/persistence/postgresql/sales/import-history-publication-performance');
  const fingerprint=()=>require('../lib/persistence/postgresql/core/fingerprint').schemaFingerprint(pg.client,require('../lib/persistence/postgresql/sales/layout').SCHEMAS);
  const base=(await pg.client.query('SELECT target_sha256 FROM gp.import_history_attestations_migration_history')).rows[0].target_sha256;
  const f=await require('../test-support/article-stock-snapshots-fixture').snapshotFixture(t,{access:pg.access,protection:pg.protection,scopeId:'synthetic-migration',ownerId:'00001'});
  await f.ingest('ARTIKEL_STAMM',[{EAN:'102004',Artikelbezeichnung:'Synthetic article'}],{master:true});
  const run=await f.ingest('ARTIKEL_FILIALEN',[{EAN:'102004',FilialID:18,FBestand:3}]);
  const proofs=async()=>(await pg.client.query('SELECT * FROM integration.import_history_snapshot_attestations ORDER BY run_id')).rows;
  const expectedProofs=await proofs(),expected=await fingerprint();
  for(const fault of [false,true]){
   await pg.client.query('BEGIN');
   try{
    assert.equal((await m.rollbackWithinTransaction(pg.client,base)).applied,true);
    assert.equal(await fingerprint(),base);assert.deepEqual(await proofs(),expectedProofs);
    await pg.client.query('SELECT gp.certify_history_snapshot($1)',[run.id]);
    if(fault){
     const injected=new Error('Synthetic interruption after first index');
     await assert.rejects(m.migrateWithinTransaction({query:(sql,...args)=>sql.startsWith('CREATE INDEX import_history_member_coverage')?Promise.reject(injected):pg.client.query(sql,...args)},base),e=>e===injected);
    }else{
     assert.equal((await m.migrateWithinTransaction(pg.client,base)).applied,true);
     assert.equal(await fingerprint(),expected);assert.deepEqual(await proofs(),expectedProofs);
     assert.equal((await m.migrateWithinTransaction(pg.client,base)).applied,false);
     await pg.client.query('SELECT gp.certify_history_snapshot($1)',[run.id]);
     await pg.client.query("UPDATE gp.import_history_publication_performance_history SET plan_sha256=repeat('0',64)");
     await assert.rejects(m.target(pg.client,base),/contract mismatch/);
     await assert.rejects(m.rollbackWithinTransaction(pg.client,base),/contract mismatch/);
    }
   }finally{await pg.client.query('ROLLBACK');}
   assert.equal(await fingerprint(),expected);assert.deepEqual(await proofs(),expectedProofs);
  }
  await pg.client.query('BEGIN');
  try{
   await pg.client.query('DROP INDEX integration.import_history_member_coverage');
   await assert.rejects(m.migrateWithinTransaction(pg.client,base),/schema drift/);
   await assert.rejects(m.rollbackWithinTransaction(pg.client,base),/schema drift/);
  }finally{await pg.client.query('ROLLBACK');}
 },{warmWorkers:false});
});
