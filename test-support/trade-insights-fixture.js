'use strict';
const C=require('../lib/data-import-contract'),M=require('../lib/tradefoto-master-profiles'),H=require('../lib/tradefoto-history-profiles');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const {createImportMasterWriters,createImportMasterService}=require('../lib/persistence/repositories/import-master-data');
const {createImportHistoryWriters}=require('../lib/persistence/repositories/import-history');
const TIME='2026-09-14T09:00:00.000Z';
async function insightFixture({access,protection,scopeId='grabenplaner-main',ownerId='synthetic-owner',branches=['18','19'],seedBase=true,clock=()=>TIME}){
 const composition={protection,getActor:()=>({scopeId,ownerId}),authorize:()=>true,clock};
 const engine=createDataImportEngine({...composition,repository:createDataImportRepository(access),profiles:[...M.TRADEFOTO_MASTER_PROFILES,...H.TRADEFOTO_HISTORY_PROFILES],
  writers:{...createImportMasterWriters({protection}),...createImportHistoryWriters({...composition,resolveMasterSourceInstance:()=> 'tradefoto-trade'})}});
 const masters=createImportMasterService({...composition,access});
 async function ingest(table,values,{master=false,sourceInstance=master?'tradefoto-trade':'tradefoto-bestell',snapshotAt=TIME,apply=true,fileSha256=C.fingerprint([table,values,snapshotAt])}={}){
  const profile=master?M.profileFor(table):H.profileFor('trade',table),definition=master?M.tableFor(table):H.tableFor('trade',table);
  let run=await engine.start({profileHash:profile.fingerprint,manifest:{sourceInstance,fileSha256,schemaSha256:profile.schemaSha256,expectedRows:values.length,declaredRows:values.length,snapshotAt,gates:[]}});
  if(run.status==='applied')return run;
  const rows=values.map((v,i)=>{const raw={...Object.fromEntries(definition.columns.map(c=>[c.name,null])),...v};return master?M.prepareTradeFotoMasterRow(table,raw,{fileSha256,rowNumber:i+1}):H.prepareTradeFotoHistoryRow('trade',table,raw,{fileSha256,rowNumber:i+1});});
  for(let i=0;i<rows.length;i+=C.LIMITS.batch)run=await engine.stage(run.id,{expectedRevision:run.revision,startRow:i+1,rows:rows.slice(i,i+C.LIMITS.batch)});
  run=await engine.seal(run.id,run.revision);do{run=await engine.review(run.id,run.revision);}while(run.status==='reviewing');
  if(run.status!=='ready')throw new Error(JSON.stringify(await engine.preview(run.id)));
  if(apply)do{run=await engine.apply(run.id,run.revision);}while(run.status==='applying');return run;
 }
 if(!seedBase)return {ingest,masters,engine};
 await ingest('FILIALEN',branches.map(FilialID=>({FilialID,FName:'Synthetic branch '+FilialID})),{master:true});
 for(const key of branches){const record=(await masters.mappings({table:'FILIALEN',sourceInstance:'tradefoto-trade',key})).items[0];if(!record.binding){
  const input={recordId:record.id,expectedSourceRevision:record.revision,targetId:key,historical:false,reason:'Synthetic qualification'};await masters.bind(input,(await masters.previewBinding(input)).planHash);}}
 await ingest('BESTELLUNGEN',[{BestellNr:'1',Suchname:'Canon',LFilialID:Number(branches[0]),Bestelldatum:'2026-08-01T09:00:00.000'},{BestellNr:'2',Suchname:'Sony',LFilialID:Number(branches[1]),Bestelldatum:'2026-08-02T09:00:00.000'}]);
 await ingest('BESTELLDETAILS',Array.from({length:65},(_,i)=>({BestellId:String(i+1),BestellNr:i<60?1:2,EAN:'000042',BArtikelbezeichnung:'Synthetic camera '+i,BMenge:'5',gMenge:i===0?'7':'2'})));
 await ingest('BESTELLKORB',[{KorbID:'1',KEAN:'000042',Filiale:Number(branches[0]),UmlagerungvonFil:Number(branches[1]),KDatum:'2026-08-03T09:00:00.000',KArtikelbezeichnung:'Synthetic transfer',KMenge:'2',Status:'Umlagerung',erledigt:true}]);
 return {ingest,masters,engine};
}
module.exports={insightFixture,TIME};
