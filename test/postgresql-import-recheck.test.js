'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {openTwoDatabaseDevelopmentApplication}=require('../lib/persistence/postgresql/boundary/application');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const C=require('../lib/data-import-contract');

test('Native PostgreSQL: 30,567-row recheck keeps count triggers atomic and releases coordination after every packet',
 {skip:process.env.GP_PG_MIGRATION_LIVE!=='1'},()=>withCoreFixture(core=>withSalesFixture(8,async f=>{
  const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,authorize:async()=>true});
  await core.application.close();await f.application.close();
  const profile=C.defineDataImportProfile({id:'synthetic-recheck',version:1,entity:'synthetic-recheck',sourceSystem:'synthetic',schemaSha256:'a'.repeat(64),sourceTable:'LargeSource',
    keyFields:['Id'],excludedFields:[],dataClasses:['internal_business'],fields:[{source:'Id',target:'id',type:'identifier',nullable:false}]});
  const options={repository:createDataImportRepository(app.provider),protection:f.protection,profiles:[profile],getActor:()=>({scopeId:'synthetic-recheck',ownerId:'00001'}),authorize:()=>true,clock:()=> '2026-09-14T12:00:00.000Z'};
  try{
    let engine=createDataImportEngine(options),run=await engine.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'synthetic-only',fileSha256:'b'.repeat(64),schemaSha256:profile.schemaSha256,expectedRows:30569,declaredRows:30569,snapshotAt:'2026-09-14T12:00:00.000Z',gates:[]}});
    for(let from=1;from<=30569;from+=200){
      await f.client.query('BEGIN');
      await f.client.query(`INSERT INTO integration.data_import_rows(run_id,row_number,identity_hash,content_hash,state,issue,payload)
        SELECT $1,n,NULL,repeat('c',64),CASE WHEN n=30568 THEN 'invalid' WHEN n=30569 THEN 'conflict' ELSE 'create' END,
        CASE WHEN n=30569 THEN 'SOURCE_KEY_CONFLICT' ELSE '' END,'synthetic-recheck-only' FROM generate_series($2::int,$3::int) n`,[run.id,from,Math.min(from+199,30569)]);
      await f.client.query('COMMIT');
    }
    await f.client.query("UPDATE integration.data_import_runs SET status='needs_review',received_count=30569 WHERE id=$1",[run.id]);
    run=await engine.preview(run.id,{limit:1});let steps=0,maxMs=0;
    do{
      const before=run.counts.staged||0,start=performance.now();
      run=await engine.recheck(run.id,run.revision);maxMs=Math.max(maxMs,performance.now()-start);
      assert.ok((run.counts.staged||0)-before<=200);assert.equal(run.counts.invalid,1);assert.equal(run.counts.conflict,1);
      // Reconstruct between steps as after a lost browser/worker process.
      if(++steps===20)engine=createDataImportEngine(options);
      const held=(await core.migrator.query('SELECT count(*)::int n FROM pg_locks WHERE locktype=\'advisory\' AND objid=9261207 AND granted')).rows[0].n;
      assert.equal(held,0);
    }while(run.status!=='reviewing'&&steps<200);
    assert.equal(steps,153);assert.equal(run.counts.staged,30567);assert.ok(maxMs<5000,'Each packet must finish before the app connection admission timeout');
    const direct=(await f.client.query('SELECT state,count(*)::int count FROM integration.data_import_rows WHERE run_id=$1 GROUP BY state ORDER BY state',[run.id])).rows;
    assert.deepEqual(direct,(await f.client.query('SELECT state,count::int count FROM integration.data_import_run_state_counts WHERE run_id=$1 ORDER BY state',[run.id])).rows);
    process.stdout.write(JSON.stringify({nativeRecheckRows:30567,steps,maxPacketMs:Math.round(maxMs),preservedInvalidAndConflict:2})+'\n');
  }finally{await app.close();}
 })));
