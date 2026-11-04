'use strict';
const C=require('../lib/data-import-contract'),H=require('../lib/tradefoto-history-profiles'),M=require('../lib/tradefoto-master-profiles');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const {createImportMasterWriters}=require('../lib/persistence/repositories/import-master-data');
const {createImportHistoryWriters,createImportHistoryService}=require('../lib/persistence/repositories/import-history');
const TIME='2026-10-15T10:00:00.000Z';
async function snapshotFixture(t,options={}){
 let app,access=options.access,protection=options.protection;
 if(!access){
  app=require('../lib/persistence/sqlite/provider').openSqliteApplicationPersistence({databasePath:':memory:',catalog:[
   ...require('../lib/persistence/sqlite/data-import-catalog').SQLITE_DATA_IMPORT_CATALOG,
   ...require('../lib/persistence/sqlite/import-master-catalog').SQLITE_IMPORT_MASTER_CATALOG,
   ...require('../lib/persistence/sqlite/import-history-catalog').SQLITE_IMPORT_HISTORY_CATALOG,
   ...require('../lib/persistence/sqlite/trade-insights-catalog').TRADE_INSIGHTS_CATALOG,
  ]});access=app.provider;
  app.database.exec('CREATE TABLE employees(personnel_number TEXT PRIMARY KEY,active INTEGER NOT NULL); CREATE TABLE locations(id TEXT PRIMARY KEY,active INTEGER NOT NULL);');
  require('../lib/persistence/sqlite/operations/data-import-schema').ensureSqliteDataImportSchema(app.database);
  require('../lib/persistence/sqlite/operations/import-master-schema').ensureSqliteImportMasterSchema(app.database);
  require('../lib/persistence/sqlite/operations/import-history-schema').ensureSqliteImportHistorySchema(app.database);
  protection=require('../lib/data-import-protection').createDataImportProtection({encryptionKey:Buffer.alloc(32,4),indexKey:Buffer.alloc(32,6),keyId:'synthetic-stock'});
  t.after(async()=>{protection.destroy();await access.close();app.database.close();});
 }
 const scopeId=options.scopeId||'stock-snapshot-scope',ownerId=options.ownerId||'synthetic-owner';
 const state={denied:false};let clockTick=0;
 const composition={protection,getActor:()=>({scopeId,ownerId}),authorize:()=>!state.denied,clock:()=>new Date(Date.parse(TIME)+clockTick).toISOString()};
 const writers={...createImportMasterWriters({protection}),...createImportHistoryWriters({...composition,resolveMasterSourceInstance:()=> 'tradefoto-trade'})};
 const engineOptions={...composition,repository:createDataImportRepository(access),profiles:[...M.TRADEFOTO_MASTER_PROFILES,...H.TRADEFOTO_HISTORY_READABLE_PROFILES],writers,operationBatchSize:options.batchSize||200};
 const engine=createDataImportEngine(engineOptions),history=createImportHistoryService({...composition,access});let sequence=0;
 async function ready(table,values,{legacy=false,master=false,instance='tradefoto-trade',fileSha256=C.fingerprint(['synthetic-stock',++sequence]),snapshotAt=TIME}={}){
  clockTick+=1000;
  const profile=master?M.profileFor(table):legacy?H.profilesFor('trade',table).find(p=>p.version===1):H.profileFor('trade',table);
  const definition=master?M.tableFor(table):H.tableFor('trade',table);
  let run=await engine.start({profileHash:profile.fingerprint,manifest:{sourceInstance:instance,fileSha256,schemaSha256:profile.schemaSha256,expectedRows:values.length,declaredRows:values.length,snapshotAt,gates:[]}});
  const rows=values.map((row,i)=>{const raw={...Object.fromEntries(definition.columns.map(c=>[c.name,null])),...row};
   return master?M.prepareTradeFotoMasterRow(table,raw,{fileSha256,rowNumber:i+1}):H.prepareTradeFotoHistoryRow('trade',table,raw,{fileSha256,rowNumber:i+1,profileHash:profile.fingerprint});});
  for(let i=0;i<rows.length;i+=C.LIMITS.batch)run=await engine.stage(run.id,{expectedRevision:run.revision,startRow:i+1,rows:rows.slice(i,i+C.LIMITS.batch)});
  run=await engine.seal(run.id,run.revision);do{run=await engine.review(run.id,run.revision);}while(run.status==='reviewing');
  return {...run,fileSha256};
 }
 async function apply(input){let run=input;do{run=await engine.apply(run.id,run.revision);}while(run.status==='applying');return {...run,fileSha256:input.fileSha256};}
 async function ingest(table,values,opts){return apply(await ready(table,values,opts));}
 async function undo(input){let run=await engine.checkpoint(input.id);do{run=await engine.undo(run.id,run.revision);}while(run.status==='reverting');return run;}
 const list=(run,instance='tradefoto-trade')=>history.list({source:'trade',table:'ARTIKEL_FILIALEN',sourceInstance:instance,snapshot:run.id,limit:100});
 return {app,access,protection,scopeId,ownerId,state,engine,engineOptions,history,ready,apply,ingest,undo,list};
}
module.exports={snapshotFixture,TIME};
