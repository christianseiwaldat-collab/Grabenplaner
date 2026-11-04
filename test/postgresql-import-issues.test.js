'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {openTwoDatabaseDevelopmentApplication}=require('../lib/persistence/postgresql/boundary/application');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const C=require('../lib/data-import-contract');
const code=wanted=>error=>error.code===wanted;

test('Native PostgreSQL: indexed issue preview keeps same-file context, permissions, paging and protected payload checks',
 {skip:process.env.GP_PG_MIGRATION_LIVE!=='1'},()=>withCoreFixture(core=>withSalesFixture(8,async f=>{
  const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,authorize:async()=>true});
  await core.application.close();await f.application.close();
  const field=(source,type='identifier',nullable=false)=>({source,target:source,type,nullable});
  const profile=(sourceTable,fields,keyFields)=>C.defineDataImportProfile({id:sourceTable,version:1,entity:sourceTable,sourceSystem:'tradefoto.master-data',schemaSha256:'a'.repeat(64),sourceTable,keyFields,excludedFields:[],dataClasses:['internal_business'],fields});
  const parent=profile('ARTIKEL_STAMM',[field('EAN'),field('Artikelbezeichnung','text'),field('Verkaufspreis','source_decimal'),field('Filialbestand','source_decimal',true)],['EAN']);
  const alias=profile('ARTIKEL_ZWEITEAN',[field('EAN'),field('ZweitEAN'),field('Rang','integer')],['EAN','ZweitEAN']);
  let who={scopeId:'synthetic-issues',ownerId:'00001'},permitted=true;
  const engine=createDataImportEngine({repository:createDataImportRepository(app.provider),protection:f.protection,profiles:[parent,alias],getActor:()=>who,authorize:()=>permitted,clock:()=> '2026-09-14T12:00:00.000Z'});
  const start=(p,count,file='b'.repeat(64))=>engine.start({profileHash:p.fingerprint,manifest:{sourceInstance:'synthetic-only',fileSha256:file,schemaSha256:p.schemaSha256,expectedRows:count,declaredRows:count,snapshotAt:'2026-09-14T12:00:00.000Z',gates:[]}});
  try {
   let article=await start(parent,1),run=await start(alias,10003);
   article=await engine.stage(article.id,{expectedRevision:article.revision,startRow:1,rows:[{EAN:'0000000000042',Artikelbezeichnung:'Synthetic camera',Verkaufspreis:'5000',Filialbestand:null}]});
   // A large valid prefix must never be read/decrypted by this preview.
   await f.client.query(`INSERT INTO integration.data_import_rows(run_id,row_number,identity_hash,content_hash,state,issue,payload)
    SELECT $1,n,NULL,repeat('c',64),'create','','synthetic-index-only' FROM generate_series(1,10000) n`,[run.id]);
   await f.client.query('UPDATE integration.data_import_runs SET received_count=10000 WHERE id=$1',[run.id]);
   run=await engine.stage(run.id,{expectedRevision:run.revision,startRow:10001,rows:[{EAN:'0000000000042',ZweitEAN:null,Rang:1},{EAN:'0000000000042',ZweitEAN:'4006381333931',Rang:2},{EAN:'0000000000042',ZweitEAN:'4006381333931',Rang:3}]});
   const before=performance.now(),first=await engine.issues(run.id,{articleRunId:article.id,limit:1});
   const ms=performance.now()-before;
   assert.equal(first.rows[0].rowNumber,10001);assert.equal(first.rows[0].article.Verkaufspreis,'5000');assert.equal(first.rows[0].article.Filialbestand,null);assert.equal(first.rows[0].impact,'optional_identifier');
   assert.deepEqual(first.next,{after:10001});
   const last=await engine.issues(run.id,{articleRunId:article.id,after:first.next.after});
   assert.deepEqual(last.rows.map(r=>[r.rowNumber,r.state]),[[10002,'conflict'],[10003,'conflict']]);assert.equal(last.next,null);
   permitted=false;await assert.rejects(engine.issues(run.id),code('IMPORT_FORBIDDEN'));permitted=true;
   const original=who;who={...who,ownerId:'00002'};await assert.rejects(engine.issues(run.id),code('IMPORT_RUN_NOT_FOUND'));who=original;
   const foreign=await start(parent,0,'d'.repeat(64));await assert.rejects(engine.issues(run.id,{articleRunId:foreign.id}),code('IMPORT_SOURCE_INTEGRITY'));
   await f.client.query('ANALYZE integration.data_import_rows');
   const plan=(await f.client.query("EXPLAIN (ANALYZE,FORMAT JSON) SELECT * FROM integration.data_import_rows WHERE run_id=$1 AND state='invalid' AND row_number>0 ORDER BY row_number LIMIT 26",[run.id])).rows[0]['QUERY PLAN'];
   assert.match(JSON.stringify(plan),/Index (Only )?Scan/);assert.doesNotMatch(JSON.stringify(plan),/Seq Scan|Rows Removed by Filter":10000/);
   await f.client.query("UPDATE integration.data_import_rows SET payload='tampered' WHERE run_id=$1 AND row_number=10001",[run.id]);
   await assert.rejects(engine.issues(run.id),code('IMPORT_PROTECTED_PAYLOAD_INVALID'));
   process.stdout.write(JSON.stringify({validPrefix:10000,problemRows:3,previewMs:Math.round(ms),indexed:true,readOnly:true,productionContact:false})+'\n');
  }finally{await app.close();}
 })));
