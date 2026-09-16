'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/data-import-contract'),H=require('../lib/tradefoto-history-profiles');
const M=require('../lib/tradefoto-master-profiles');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {openTwoDatabaseDevelopmentApplication}=require('../lib/persistence/postgresql/boundary/application');
const {openDeferredPostgresqlApplication}=require('../lib/persistence/postgresql/application');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createImportHistoryWriters}=require('../lib/persistence/repositories/import-history');
const {createImportMasterWriters,createImportMasterService}=require('../lib/persistence/repositories/import-master-data');
const {createCashSnapshotStore}=require('../lib/persistence/repositories/cash-snapshots');
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../lib/persistence/statements/cash-snapshots');
const TIME='2026-09-15T12:00:00.000Z',actor={scopeId:'synthetic-packets',ownerId:'00001'};
const enabled=process.env.GP_PG_MIGRATION_LIVE==='1';
const code=expected=>error=>error?.code===expected;
async function fixture(work,{deferred=false}={}){return withCoreFixture(core=>withSalesFixture(8,async f=>{
 await core.application.close();await f.application.close();
 const options={coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,authorize:async()=>true};
 const app=deferred?openDeferredPostgresqlApplication({...options,readers:{coreUrl:process.env.GP_CORE_READER_URL,salesUrl:process.env.GP_SALES_READER_URL}})
  :await openTwoDatabaseDevelopmentApplication(options);
 try{
  if(deferred){
   const support=require('../lib/persistence/repositories/import-batch-support');
   assert.equal(support.supportsImportBatches(app.provider),true,'Production facade must advertise packets before asynchronous readiness');
   assert.equal(support.supportsCoreImportReferences(app.provider),true);await app.ready;
  }
  await work({...f,core,access:app.provider});
 }finally{await app.provider.close();}
}));}
function engine(f){return createDataImportEngine({repository:createDataImportRepository(f.access),protection:f.protection,
 profiles:H.TRADEFOTO_HISTORY_PROFILES,sharedPayloads:true,getActor:()=>actor,authorize:()=>true,clock:()=>TIME,
 writers:createImportHistoryWriters({protection:f.protection,authorize:()=>true,resolveMasterSourceInstance:()=> 'synthetic-masters'})});}
const repair=(id,changed=false)=>H.prepareTradeFotoHistoryRow('trade','Reparatur',{
 ...Object.fromEntries(H.tableFor('trade','Reparatur').columns.map(c=>[c.name,null])),ReparaturNr:id,FilialId:'18',AName:'Synthetic '+id,
 Fehler:'Encrypted synthetic evidence '.repeat(90),erledigt:changed,
});
async function start(e,count,sha='a'.repeat(64)){
 const profile=H.profileFor('trade','Reparatur');
 return e.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'synthetic-bestell',fileSha256:sha,schemaSha256:profile.schemaSha256,expectedRows:count,declaredRows:count,snapshotAt:TIME,gates:[]}});
}
async function finish(e,run,action){let calls=0;do{run=await e[action](run.id,run.revision);if(++calls>100)throw new Error('Unbounded test');}while(run.status===({review:'reviewing',apply:'applying',undo:'reverting'}[action]));return run;}
async function unlocked(f){assert.equal((await f.core.migrator.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND objid=9261207 AND granted")).rows[0].n,0);}

test('Native unified Trade import: dates, catalog batches, replay and undo share the production PostgreSQL facade',{skip:!enabled},()=>fixture(async f=>{
 const {definitions,readTradeFotoFullSource}=require('../lib/tradefoto-full-import-source');
 const defs=definitions('trade'),raw={...Object.fromEntries(M.tableFor('ARTIKEL_STAMM').columns.map(c=>[c.name,null])),
  EAN:'0000000000017',Artikelbezeichnung:'Synthetic native catalog',MWST:1,Verkaufspreis:12,eNvk:10,'Änderungsdatum':new Date('2026-09-14T23:58:00Z')};
 const readerFactory=()=>({getTableNames:()=>defs.map(d=>d.name),getTable:name=>{
  const table=defs.find(d=>d.name===name),rows=name==='ARTIKEL_STAMM'?[raw]:[];
  return {rowCount:rows.length,getColumnNames:()=>table.columns.map(c=>c.name),getColumns:()=>table.columns.map(c=>({name:c.name,type:c.type})),
   getData:({columns,rowOffset=0,rowLimit=Infinity})=>rows.slice(rowOffset,rowOffset+rowLimit).map(row=>Object.fromEntries(columns.map(key=>[key,row[key]??null])))};
 }});
 const vault=require('../lib/integration-secret-vault').createIntegrationSecretVault({activeKeyId:'native-synthetic',keys:{'native-synthetic':Buffer.alloc(32,71)}});
 const P=require('../lib/data-import-access').DATA_IMPORT_PERMISSIONS;
 const get=async()=>({employeeNumber:'00001',accountId:'synthetic-personal',isEmployee:true,permissions:[...Object.values(P),'sales:analytics:access','sales:analytics:company:read','sales:articles:access','sales:articles:read','sales:articles:import']});
 const runtime=require('../lib/persistence/repositories/data-import-runtime').createDataImportRuntime({access:f.access,vault,scopeId:'synthetic-native-unified',allowApply:true,sharedPayloads:true,syncArticleCatalog:true,clock:()=>TIME,
  readSource:options=>readTradeFotoFullSource({...options,readerFactory,send:options.onMessage})});
 const buffer=Buffer.alloc(4096);buffer.write('Standard ACE DB',4);buffer[0x14]=3;
 let source=await runtime.upload(get,{buffer,kind:'trade',fileName:'Trade_Daten.accdb'});
 assert.equal(source.contentDate.value,'2026-09-14T23:58:00.000');
 const advance=async action=>{let n=0;do{source=await runtime.sourceOperation(get,source.id,action,{expectedRevision:source.revision});assert.ok(++n<500);}while(source.status===({review:'reviewing',apply:'applying',undo:'reverting'}[action]));};
 await advance('review');await advance('apply');
 assert.equal(source.status,'applied');assert.equal(source.catalog.changed,1);
 const catalog=require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(f.access);
 assert.equal((await catalog.getByArticleNumber('000017')).description,'Synthetic native catalog');
 source=await runtime.sourceOperation(get,source.id,'apply',{expectedRevision:source.revision});assert.equal(source.catalog.batches.length,1);
 await advance('undo');assert.equal(source.status,'reverted');assert.equal((await catalog.getByArticleNumber('000017')).active,false);
 await runtime.stop();await unlocked(f);
},{deferred:true}));

test('Native import packets: cross-packet duplicates/conflicts, lost acknowledgements and encrypted block tampering remain fail-closed',{skip:!enabled},()=>fixture(async f=>{
 const e=engine(f);let run=await start(e,203);
 const rows=Array.from({length:200},(_,i)=>repair(i+1));
 run=await e.stage(run.id,{expectedRevision:run.revision,startRow:1,rows});
 const replay=await e.stage(run.id,{expectedRevision:1,startRow:1,rows});assert.equal(replay.revision,run.revision);
 await assert.rejects(e.stage(run.id,{expectedRevision:1,startRow:1,rows:[repair(1,true)]}),code('IMPORT_REPLAY_CONFLICT'));
 run=await e.stage(run.id,{expectedRevision:run.revision,startRow:201,rows:[repair(200),repair(199,true),repair(199)]});
 assert.deepEqual(run.counts,{staged:199,conflict:3,duplicate:1});
 const counts=(await f.client.query('SELECT state,count(*)::int count FROM integration.data_import_rows WHERE run_id=$1 GROUP BY state ORDER BY state',[run.id])).rows;
 assert.deepEqual(counts,(await f.client.query('SELECT state,count::int count FROM integration.data_import_run_state_counts WHERE run_id=$1 ORDER BY state',[run.id])).rows);
 await assert.rejects(f.client.query("UPDATE integration.data_import_payload_blocks SET nonce='AAAAAAAAAAAAAAAA' WHERE id=(SELECT id FROM integration.data_import_payload_blocks LIMIT 1)"),code('23514'));
 await f.client.query("UPDATE integration.data_import_rows SET payload=left(payload,length(payload)-1)||'!' WHERE run_id=$1 AND row_number=1",[run.id]);
 run=await e.seal(run.id,run.revision);
 await assert.rejects(e.review(run.id,run.revision),code('IMPORT_PROTECTED_PAYLOAD_INVALID'));
 assert.equal((await e.preview(run.id)).revision,run.revision);await unlocked(f);
}));

test('Native import packets: a 1% change creates exactly two versions, rechecks concurrent changes and survives undo',{skip:!enabled},()=>fixture(async f=>{
 let e=engine(f),run=await start(e,200);
 const rows=Array.from({length:200},(_,i)=>repair(i+1));
 run=await e.stage(run.id,{expectedRevision:run.revision,startRow:1,rows});run=await e.seal(run.id,run.revision);
 run=await finish(e,run,'review');assert.equal(run.status,'ready');run=await finish(e,run,'apply');assert.equal(run.status,'applied');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.import_history_versions')).rows[0].n,200);
 e=engine(f);let next=await start(e,200,'b'.repeat(64));rows[0]=repair(1,true);rows[1]=repair(2,true);
 next=await e.stage(next.id,{expectedRevision:next.revision,startRow:1,rows});next=await e.seal(next.id,next.revision);next=await finish(e,next,'review');
  assert.deepEqual(next.counts,{unchanged:198,update:2});
 await f.client.query("UPDATE integration.data_import_links SET revision=revision+1 WHERE id=(SELECT identity_hash FROM integration.data_import_rows WHERE run_id=$1 AND state='update' ORDER BY row_number LIMIT 1)",[next.id]);
 await assert.rejects(e.apply(next.id,next.revision),code('IMPORT_SOURCE_LINK_CHANGED'));
 assert.equal((await e.preview(next.id)).revision,next.revision);
 do{next=await e.recheck(next.id,next.revision);}while(next.status!=='reviewing');
 next=await finish(e,next,'review');
 next=await finish(e,next,'apply');assert.equal(next.status,'applied');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.import_history_versions')).rows[0].n,202);
 next=await finish(e,next,'undo');assert.equal(next.status,'reverted');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.import_history_versions')).rows[0].n,204);
 await unlocked(f);
},{deferred:true}));

test('Native cash packets: complete parent verification, atomic rejection and replay preserve original rows',{skip:!enabled},()=>fixture(async f=>{
 const id='c'.repeat(64),sha='d'.repeat(64),store=createCashSnapshotStore({access:f.access,protection:f.protection,actor,clock:()=>TIME});
 const manifest={kind:'cash',fileSha256:sha,bytes:4096,tables:TABLES.map(t=>({name:t.name,profileHash:t.profile.fingerprint,declaredRows:['Umsatz_KASSE','Umsatz_Kasse_Details'].includes(t.name)?200:0}))};
 await store.begin(id,manifest);
 const raw=(table,extra)=>({...Object.fromEntries(table.columns.map(c=>[c.name,null])),...extra});
 const prepare=(table,extra,n)=>H.prepareTradeFotoHistoryRow('cash',table.name,raw(table,extra),{fileSha256:sha,rowNumber:n});
 for(const table of TABLES){
  const size=manifest.tables.find(t=>t.name===table.name).declaredRows;await store.startTable(id,table.name,size);
  if(size){
   const details=table.name==='Umsatz_Kasse_Details';
   const rows=Array.from({length:200},(_,i)=>prepare(table,{Bonnr:i+1,Filialid:'18',Kassenid:1,Bondatum:new Date('2026-09-01T12:00:00Z'),...(details?{RepID:'00000000-0000-0000-0000-'+String(i+1).padStart(12,'0')}: {})},i+1));
   if(details){const broken=structuredClone(rows);broken[199].Bonnr='9999';
    await assert.rejects(store.append(id,table.name,1,broken),code('IMPORT_HISTORY_PARENT_MISSING'));
    assert.equal((await f.client.query('SELECT count(*)::int n FROM kassa.'+table.sqlName)).rows[0].n,0);
   }else{const duplicate=[...rows.slice(0,199),rows[0]];await assert.rejects(store.append(id,table.name,1,duplicate));
    assert.equal((await f.client.query('SELECT count(*)::int n FROM kassa.'+table.sqlName)).rows[0].n,0);
   }
   await store.append(id,table.name,1,rows);await store.append(id,table.name,1,rows);
  }
  await store.finishTable(id,table.name);
 }
 await store.seal(id,{rows:400,tables:TABLES.length});let result;do{result=await store.review(id);}while(result.status==='reviewing');
 assert.equal(result.status,'ready');assert.equal(result.verifiedRows,400);await unlocked(f);
}));

test('Native target packets: failed publication rolls back every master; history references retain their removal holds',{skip:!enabled},()=>fixture(async f=>{
 const profile=M.profileFor('KUNDEN'),writers=createImportMasterWriters({protection:f.protection}),base=writers[profile.entity];
 let rejectAfterWrite=true;
 const e=createDataImportEngine({repository:createDataImportRepository(f.access),protection:f.protection,profiles:M.TRADEFOTO_MASTER_PROFILES,
  sharedPayloads:true,getActor:()=>actor,authorize:()=>true,clock:()=>TIME,writers:{...writers,[profile.entity]:{...base,
   async createBatch(...args){const result=await base.createBatch(...args);if(rejectAfterWrite)C.fail('IMPORT_CONCURRENT_CHANGE',409);return result;}}}});
 const rows=Array.from({length:50},(_,i)=>M.prepareTradeFotoMasterRow('KUNDEN',{
  ...Object.fromEntries(M.tableFor('KUNDEN').columns.map(c=>[c.name,null])),KUND_NR:String(i+1),NACHNAME:'Synthetic master '+i,
 }));
 let run=await e.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'synthetic-masters',fileSha256:'e'.repeat(64),
  schemaSha256:profile.schemaSha256,expectedRows:50,declaredRows:50,snapshotAt:TIME,gates:[]}});
 run=await e.stage(run.id,{expectedRevision:run.revision,startRow:1,rows});run=await e.seal(run.id,run.revision);run=await finish(e,run,'review');
 const reviewedPayloads=(await f.client.query('SELECT row_number,payload FROM integration.data_import_rows WHERE run_id=$1 ORDER BY row_number',[run.id])).rows;
 const reviewedRefs=(await f.client.query('SELECT row_number,slot,block_id FROM integration.data_import_row_payload_refs WHERE run_id=$1 ORDER BY row_number,slot',[run.id])).rows;
 await assert.rejects(e.apply(run.id,run.revision),code('IMPORT_CONCURRENT_CHANGE'));
 assert.equal((await e.preview(run.id)).revision,run.revision);
 for(const table of ['trade.import_master_records','trade.import_master_segments','trade.import_master_relations','integration.data_import_links','integration.data_import_changes'])
  assert.equal((await f.client.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
 await unlocked(f);rejectAfterWrite=false;run=await finish(e,run,'apply');assert.equal(run.counts.applied,50);
 assert.deepEqual((await f.client.query('SELECT row_number,payload FROM integration.data_import_rows WHERE run_id=$1 ORDER BY row_number',[run.id])).rows,reviewedPayloads);
 assert.deepEqual((await f.client.query('SELECT row_number,slot,block_id FROM integration.data_import_row_payload_refs WHERE run_id=$1 ORDER BY row_number,slot',[run.id])).rows,reviewedRefs);
 const masterIds=(await f.client.query('SELECT id FROM trade.import_master_records ORDER BY id LIMIT 2')).rows.map(row=>row.id);
 const masterService=createImportMasterService({access:f.access,protection:f.protection,getActor:()=>actor,authorize:()=>true,clock:()=>TIME});
 const customerInput={recordId:masterIds[0],expectedSourceRevision:1,decision:{customerType:'unknown'}};
 const customerPlan=await masterService.previewCustomer(customerInput),customerBinding=await masterService.syncCustomer(customerInput,customerPlan.planHash);
 const h=engine(f);let history=await start(h,50);
 const repairs=Array.from({length:50},(_,i)=>({...repair(i+1),KUND_NR:i+1}));
 history=await h.stage(history.id,{expectedRevision:history.revision,startRow:1,rows:repairs});history=await h.seal(history.id,history.revision);
 const {Client}=require('pg'),originalQuery=Client.prototype.query;let bindingReads=0;
 Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text||'';
  if(/FROM\s+(?:gp\.\s*)?"?import_master_bindings"?\s+WHERE/i.test(sql))bindingReads++;return originalQuery.apply(this,args);};
 try{
  history=await finish(h,history,'review');assert.equal(history.status,'ready',JSON.stringify(await h.preview(history.id)));
  history=await finish(h,history,'apply');assert.equal(history.counts.applied,50);
 }finally{Client.prototype.query=originalQuery;}
 assert.ok(bindingReads>0&&bindingReads<=4,'Fifty source references must not cause fifty Core binding round trips; observed '+bindingReads);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.import_history_references WHERE master_record_id IS NOT NULL')).rows[0].n,50);
 assert.equal(await f.access.transaction(tx=>base.canRemove(tx,masterIds[1],{...actor,sourceInstance:'synthetic-masters',sourceSystem:profile.sourceSystem,
  sourceTable:profile.sourceTable,profileHash:profile.fingerprint,at:TIME}),{isolation:'serializable'}),false);
 await assert.rejects(e.undo(run.id,run.revision),code('IMPORT_UNDO_DEPENDENCIES'));
 history=await finish(h,history,'undo');assert.equal(history.status,'reverted');
 await masterService.undo(customerBinding.eventId);
 run=await finish(e,run,'undo');assert.equal(run.status,'reverted');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM trade.import_master_records')).rows[0].n,0);
 await unlocked(f);
},{deferred:true}));
