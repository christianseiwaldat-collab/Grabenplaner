'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Client}=require('pg');
const {snapshotFixture}=require('../test-support/article-stock-snapshots-fixture');
const {S}=require('../lib/persistence/statements/import-history-snapshots');
const {createHistorySnapshots}=require('../lib/persistence/repositories/import-history-snapshots');
test('Native publication proofs invalidate on data changes and cannot be forged by application or reader',
 {skip:!process.env.GP_CORE_MIGRATOR_URL},async t=>{
 await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async pg=>{
  const f=await snapshotFixture(t,{access:pg.access,protection:pg.protection,scopeId:'synthetic-migration',ownerId:'00001'});
  await f.ingest('ARTIKEL_STAMM',[{EAN:'102004',Artikelbezeichnung:'Synthetic article'}],{master:true});
  const run=await f.ingest('ARTIKEL_FILIALEN',[{EAN:'102004',FilialID:18,FBestand:3},{EAN:'102004',FilialID:19,FBestand:2}]);
  const snapshots=createHistorySnapshots({protection:pg.protection});
  const publication=()=>pg.access.transaction(tx=>snapshots.publication(tx,run.id),{readOnly:true});
  const proof=async()=>Number((await pg.client.query('SELECT count(*) FROM integration.import_history_snapshot_attestations WHERE run_id=$1',[run.id])).rows[0].count);
  const certify=()=>pg.client.query('SELECT gp.certify_history_snapshot($1)',[run.id]);
  assert.equal(await proof(),1);await publication();
  await pg.access.transaction(async tx=>{
   let scans=0;const proxy={queryOne:(statement,p)=>{if(statement===S.coverage)scans++;return tx.queryOne(statement,p);}};
   await snapshots.publication(proxy,run.id);assert.equal(scans,0,'Native reads use the guarded proof, not the full coverage query');
  },{readOnly:true});
  const member=(await pg.client.query('SELECT * FROM integration.import_history_snapshot_members WHERE run_id=$1 ORDER BY row_number LIMIT 1',[run.id])).rows[0];
  const record=(await pg.client.query('SELECT * FROM integration.import_history_records WHERE id=$1',[member.record_id])).rows[0];
  const W=require('../lib/persistence/statements/sales-article-workspace');
  const portable=require('../lib/persistence/postgresql/sales/catalog').compileSalesEntry(require('../lib/persistence/catalogs/sales-article-workspace-catalog').CATALOG.find(e=>e.statement===W.articleStock),8).providerEntry;
  const native=require('../lib/persistence/postgresql/reporting/article-stock-selection').articleStock;
  const reference=(await pg.client.query("SELECT * FROM integration.import_history_references WHERE record_id=$1 AND role='article'",[record.id])).rows[0];
  const parameters={scopeId:f.scopeId,sourceInstance:'tradefoto-trade',snapshot:run.id,articleHash:reference.lookup_hash||'',masterRecordId:reference.master_record_id||'',limit:101};
  const parity=async changes=>{const p={...parameters,...changes};assert.deepEqual((await pg.client.query(native.sql,native.parameterOrder.map(k=>p[k]))).rows,(await pg.client.query(portable.sql,portable.parameterOrder.map(k=>p[k]))).rows);};
  for(const changes of [{},{articleHash:'missing'},{masterRecordId:'missing'},{articleHash:'missing',masterRecordId:'missing'},{scopeId:'other'},{sourceInstance:'other'},{snapshot:'f'.repeat(64)},{limit:1}])await parity(changes);
  const cases=[
   ['member ciphertext',"UPDATE integration.import_history_snapshot_members SET payload=$2 WHERE run_id=$1 AND row_number=1",[run.id,'invalid'],[run.id,member.payload]],
   ['member ordering',"UPDATE integration.import_history_snapshot_members SET row_number=$2 WHERE run_id=$1 AND record_id=$3",[run.id,99,member.record_id],[run.id,1,member.record_id]],
   ...['scope_id','source_instance','profile_hash','source','source_table'].map(field=>[field,`UPDATE integration.import_history_records SET ${field}=$2 WHERE id=$1`,[record.id,field==='profile_hash'?'f'.repeat(64):field==='source'?'cash':'foreign'],[record.id,record[field]]]),
  ];
  for(const [name,sql,changed,original] of cases){
   await pg.client.query(sql,changed);assert.equal(await proof(),0,name);
   await assert.rejects(publication(),{code:'IMPORT_HISTORY_SNAPSHOT_INCOMPLETE'},name);
   if(name!=='member ciphertext')await assert.rejects(certify(),e=>e.code==='23514',name+' cannot be recertified while invalid');
   await pg.client.query(sql,original);await certify();await publication();
  }
  await pg.client.query('DELETE FROM integration.import_history_snapshot_members WHERE run_id=$1 AND row_number=1',[run.id]);
  assert.equal(await proof(),0);await assert.rejects(certify(),e=>e.code==='23514');
  await pg.client.query('INSERT INTO integration.import_history_snapshot_members(run_id,row_number,record_id,revision,payload) VALUES($1,$2,$3,$4,$5)',Object.values(member));
  assert.equal(await proof(),0,'Insert alone cannot restore a proof');await certify();
  await pg.client.query('UPDATE integration.import_history_records SET revision=revision+1 WHERE id=$1',[record.id]);
  assert.equal(await proof(),1,'An unchanged historical version stays valid when the current revision advances');
  await parity({});
  await pg.client.query('UPDATE integration.import_history_records SET revision=$2 WHERE id=$1',[record.id,record.revision]);
  await pg.client.query('BEGIN');
  await pg.client.query('DELETE FROM integration.import_history_snapshot_members WHERE run_id=$1',[run.id]);
  assert.equal(await proof(),0);await pg.client.query('ROLLBACK');assert.equal(await proof(),1,'Rollback restores data and proof together');
  for(const purpose of ['APP','READER']){
   const client=new Client({connectionString:process.env['GP_SALES_'+purpose+'_URL']});await client.connect();
   try{
    for(const sql of ["DELETE FROM integration.import_history_snapshot_attestations", "INSERT INTO integration.import_history_snapshot_attestations SELECT run_id,payload FROM integration.import_history_snapshots", "SELECT gp.certify_history_snapshot('missing')",'TRUNCATE integration.import_history_snapshot_members'])
     await assert.rejects(client.query(sql),e=>e.code==='42501',purpose+': '+sql);
   }finally{await client.end();}
  }
  // Exercise a real predecessor-to-extension migration inside an owned fixture
  // transaction. Both a successful backfill and a failed one must roll back.
  const migration=require('../lib/persistence/postgresql/sales/import-history-attestations');
  const base=(await pg.client.query('SELECT target_sha256 FROM gp.import_history_snapshots_migration_history')).rows[0].target_sha256;
  for(const damaged of [false,true]){
   await pg.client.query('BEGIN');
   try{
    for(const sql of migration.statements){const match=sql.match(/^CREATE FUNCTION gp\.(\w+)\(([^)]*)\)/);if(match)await pg.client.query('DROP FUNCTION gp.'+match[1]+'('+(match[2]?'TEXT':'')+') CASCADE');}
    await pg.client.query('DROP TABLE integration.import_history_snapshot_attestations, gp.import_history_attestations_migration_history');
    if(damaged)await pg.client.query('DELETE FROM integration.import_history_snapshot_members WHERE run_id=$1 AND row_number=1',[run.id]);
    if(damaged)await assert.rejects(migration.migrateWithinTransaction(pg.client,base),e=>e.code==='23514');
    else{assert.equal((await migration.migrateWithinTransaction(pg.client,base)).applied,true);assert.equal(await proof(),1);}
   }finally{await pg.client.query('ROLLBACK');}
   assert.equal(await proof(),1);await publication();
  }
  const concurrent=new Client({connectionString:process.env.GP_SALES_MIGRATOR_URL});await concurrent.connect();
  try{
   await concurrent.query('SET ROLE gp_sales_owner');const pid=(await concurrent.query('SELECT pg_backend_pid() AS id')).rows[0].id;
   await pg.client.query('BEGIN');await pg.client.query('DELETE FROM integration.import_history_snapshot_members WHERE run_id=$1 AND row_number=1',[run.id]);
   const pending=concurrent.query('SELECT gp.certify_history_snapshot($1)',[run.id]).then(()=>null,e=>e);
   let blocked=false;
   for(let i=0;i<50&&!blocked;i++){blocked=(await pg.client.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;if(!blocked)await new Promise(r=>setTimeout(r,10));}
   assert.equal(blocked,true,'Recertification must wait for the invalidating writer');
   await pg.client.query('COMMIT');assert.equal((await pending)?.code,'23514');assert.equal(await proof(),0);
   await pg.client.query('INSERT INTO integration.import_history_snapshot_members(run_id,row_number,record_id,revision,payload) VALUES($1,$2,$3,$4,$5)',Object.values(member));await certify();
  }finally{await pg.client.query('ROLLBACK');await concurrent.end();}
  await f.undo(run);assert.equal(await proof(),0);await assert.rejects(publication(),{code:'IMPORT_HISTORY_SNAPSHOT_UNPUBLISHED'});
  const legacy=await f.ingest('ARTIKEL_FILIALEN',[{EAN:'102004',FilialID:18,FBestand:9}],{legacy:true});await parity({snapshot:legacy.id});
  const empty=await f.ingest('ARTIKEL_FILIALEN',[]);assert.equal((await f.list(empty)).items.length,0);
 },{warmWorkers:false});
});
