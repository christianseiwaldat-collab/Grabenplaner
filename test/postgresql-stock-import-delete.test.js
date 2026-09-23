'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const enabled=process.env.GP_PG_MIGRATION_LIVE==='1';
test('native deletion migration is atomic, fingerprinted, idempotent and keeps referenced payloads protected',{skip:!enabled},async()=>{
 const {Client}=require('pg'),client=new Client({connectionString:process.env.GP_SALES_MIGRATOR_URL});await client.connect();
 const migration=require('../lib/persistence/postgresql/sales/import-delete');
 try{
  const exists=(await client.query("SELECT to_regclass('gp.import_delete_migration_history') AS name")).rows[0].name;
  if(!exists){
   const fault=new Error('Synthetic interruption');
   await assert.rejects(migration.migrate({query:(sql,...args)=>sql.startsWith('CREATE TABLE gp.import_delete_')?Promise.reject(fault):client.query(sql,...args)}),e=>e===fault);
   assert.equal((await client.query("SELECT to_regclass('integration.import_history_reference_master') AS name")).rows[0].name,null);
  }
  await migration.migrate(client);assert.equal((await migration.migrate(client)).applied,false);
  const indexes=await client.query("SELECT c.relname,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('data_import_links_last_run','import_history_versions_run')");
  assert.equal(indexes.rows.length,2);assert.ok(indexes.rows.every(r=>r.indisvalid&&r.indisready));
  assert.equal((await client.query("SELECT has_table_privilege('gp_sales_app','gp.import_delete_performance_history','UPDATE') AS allowed")).rows[0].allowed,false);
  const base=(await client.query('SELECT target_sha256 FROM gp.sales_migration_history ORDER BY stage DESC LIMIT 1')).rows[0].target_sha256;
  await client.query('SET search_path=pg_catalog,gp,kassa,integration,trade,reporting');
  assert.equal(await migration.target(client,base),await require('../lib/persistence/postgresql/core/fingerprint').schemaFingerprint(client,require('../lib/persistence/postgresql/sales/layout').SCHEMAS));
  assert.equal((await client.query("SELECT has_table_privilege('gp_sales_app','gp.import_delete_migration_history','UPDATE') AS allowed")).rows[0].allowed,false);
 }finally{await client.end();}
});

test('native branch summary and permanent unapplied deletion preserve productive master records',{skip:!enabled},async()=>{
 await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f=>{
  const C=require('../lib/data-import-contract'),M=require('../lib/tradefoto-master-profiles');
  const actor={scopeId:'synthetic-migration',ownerId:'00001'},TIME='2026-09-22T10:00:00.000Z';
  const source=await require('../test-support/trade-insights-fixture').insightFixture({access:f.access,protection:f.protection,...actor,branches:['18','18']});
  await source.ingest('ARTIKEL_Sortimente',[{Sortiment:10,Bezeichnung:'Synthetic cameras'}],{master:true});
  await source.ingest('ARTIKEL_STAMM',[{EAN:'123',Artikelbezeichnung:'Synthetic camera',Sortiment:10,DurchschnittEK:'12.34'}],{master:true});
  await source.ingest('ARTIKEL_FILIALEN',[{EAN:'123',FilialID:18,FBestand:'2'}],{sourceInstance:'tradefoto-trade'});
  const runtime=require('../lib/persistence/repositories/trade-insights').createTradeInsightRuntime(f.runtimeOptions),get=()=>f.resolvePrincipal('00001');
  const summary=await runtime.run(get,'stock-summary',{locationId:'trade-source:18'});
  assert.equal(summary.complete,true);assert.equal(summary.totals.provisionalNet,'24.68');assert.equal(summary.rows[0].label,'Synthetic cameras');
  const profile=M.profileFor('ARTIKEL_STAMM'),fileSha256='a'.repeat(64);
  const engine=require('../lib/data-import-engine').createDataImportEngine({repository:require('../lib/persistence/repositories/data-import').createDataImportRepository(f.access),
   protection:f.protection,profiles:[profile],sharedPayloads:true,getActor:()=>actor,authorize:()=>true,clock:()=>TIME,writers:require('../lib/persistence/repositories/import-master-data').createImportMasterWriters({protection:f.protection})});
  let run=await engine.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'tradefoto-trade',fileSha256,schemaSha256:profile.schemaSha256,expectedRows:1,declaredRows:1,snapshotAt:TIME,gates:[]}});
  const raw={...Object.fromEntries(M.tableFor('ARTIKEL_STAMM').columns.map(c=>[c.name,null])),EAN:'999',Artikelbezeichnung:'Synthetic unpublished article'};
  run=await engine.stage(run.id,{expectedRevision:run.revision,startRow:1,rows:[M.prepareTradeFotoMasterRow('ARTIKEL_STAMM',raw,{fileSha256,rowNumber:1})]});
  run=await engine.seal(run.id,run.revision);run=await engine.review(run.id,run.revision);
  const blocks=(await f.client.query('SELECT id FROM integration.data_import_payload_blocks')).rows;assert.ok(blocks.length);
  await assert.rejects(f.client.query('DELETE FROM integration.data_import_payload_blocks WHERE id=$1',[blocks[0].id]),e=>e.code==='23514');
  const id=f.protection.digest(['source',actor,'trade',fileSha256]),row={id,...actor,revision:1,createdAt:TIME,updatedAt:TIME};
  const data={kind:'trade',fileSha256,complete:true,status:'ready',tables:[{name:'ARTIKEL_STAMM',profileHash:profile.fingerprint,declaredRows:1,run}]};
  await f.access.execute(require('../lib/persistence/statements/data-import-runtime').DATA_IMPORT_RUNTIME_STATEMENTS.insertSource,{...row,payload:f.protection.seal(data,['source',actor.scopeId,actor.ownerId,id,1])});
  const imports=require('../lib/persistence/repositories/data-import-runtime').createDataImportRuntime({...f.runtimeOptions,sharedPayloads:true,clock:()=>TIME});
  const importPrincipal=async()=>{const p=await get();return {...p,permissions:[...p.permissions,...Object.values(require('../lib/data-import-access').DATA_IMPORT_PERMISSIONS)]};};
  let result={revision:1};for(let i=0;i<5&&!result.deleted;i++)result=await imports.sourceOperation(importPrincipal,id,'delete',{expectedRevision:result.revision});
  assert.equal(result.deleted,true);assert.equal(Number((await f.client.query('SELECT COUNT(*) AS n FROM integration.data_import_rows WHERE run_id=$1',[run.id])).rows[0].n),0);
  assert.equal(Number((await f.client.query('SELECT COUNT(*) AS n FROM integration.data_import_payload_blocks')).rows[0].n),0);
  assert.equal((await runtime.run(get,'stock-summary',{locationId:'trade-source:18'})).totals.provisionalNet,'24.68');
  assert.equal(Number((await f.core.migrator.query("SELECT COUNT(*) AS n FROM gp.audit_log WHERE action='import.source.delete'")).rows[0].n),1);
  const cashFixture=require('../test-support/postgresql-migration/cash-fixture');
  const cashRows=cashFixture.sourceRows([cashFixture.receipt(1,'120',[{}])]),cashSha=C.fingerprint(cashRows),cashId=f.protection.digest(['source',actor,'cash',cashSha]);
  const candidate=await f.cash.build(cashRows,cashId);
  const cashData={kind:'cash',fileSha256:cashSha,storage:'cash-compact-v1',status:'ready',complete:true,tables:candidate.summary.tables};
  await f.access.execute(require('../lib/persistence/statements/data-import-runtime').DATA_IMPORT_RUNTIME_STATEMENTS.insertSource,{...row,id:cashId,payload:f.protection.seal(cashData,['source',actor.scopeId,actor.ownerId,cashId,1])});
  result={revision:1};for(let i=0;i<8&&!result.deleted;i++)result=await imports.sourceOperation(importPrincipal,cashId,'delete',{expectedRevision:result.revision});
  assert.equal(result.deleted,true);assert.equal(Number((await f.client.query('SELECT COUNT(*) AS n FROM kassa.cash_snapshot_datasets')).rows[0].n),0);
 },{warmWorkers:false});
});
