'use strict';
const crypto=require('node:crypto');
const M=require('../../lib/tradefoto-master-profiles');
const C=require('../../lib/data-import-contract');
const {createDataImportEngine}=require('../../lib/data-import-engine');
const {createDataImportRepository}=require('../../lib/persistence/repositories/data-import');
const {createImportMasterWriters,createImportMasterService}=require('../../lib/persistence/repositories/import-master-data');
const {salesArticleImportContentSha256}=require('../../lib/sales-article-catalog');
const TIME='2026-09-12T12:00:00.000Z';
const raw=(table,extra={})=>({...Object.fromEntries(M.tableFor(table).columns.map(c=>[c.name,null])),...extra});
function masterFixture(access,protection){
  const denied=new Set();
  const composition={protection,getActor:()=>({scopeId:'synthetic-migration',ownerId:'00001'}),clock:()=>TIME,authorize:({action,dataClasses})=>!denied.has(action)&&!dataClasses.some(c=>denied.has(c))};
  const engine=createDataImportEngine({...composition,repository:createDataImportRepository(access),profiles:M.TRADEFOTO_MASTER_PROFILES,writers:createImportMasterWriters({protection})});
  const service=createImportMasterService({...composition,access});let attempt=0;
  async function ingest(name,rows){
    const profile=M.profileFor(name),fileSha256=crypto.createHash('sha256').update('synthetic-trade-'+(++attempt)).digest('hex');
    let run=await engine.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'test-ledger',fileSha256,schemaSha256:profile.schemaSha256,expectedRows:rows.length,declaredRows:rows.length,snapshotAt:TIME,gates:[]}});
    const prepared=rows.map((r,i)=>M.prepareTradeFotoMasterRow(name,r,{fileSha256,rowNumber:i+1}));
    for(let i=0;i<rows.length;i+=C.LIMITS.batch)run=await engine.stage(run.id,{expectedRevision:run.revision,startRow:i+1,rows:prepared.slice(i,i+C.LIMITS.batch)});
    run=await engine.seal(run.id,run.revision);
    do{run=await engine.review(run.id,run.revision);}while(run.status==='reviewing');
    if(run.status!=='ready')throw new Error('Synthetic master import not ready: '+name+' '+JSON.stringify(await engine.preview(run.id)));
    do{run=await engine.apply(run.id,run.revision);}while(run.status==='applying');
    return run;
  }
  return {engine,service,ingest,denied};
}
function articleSnapshot(version,articles){
  return {snapshot:{sourceSystem:'tradefoto.artikel_stamm',sourceProfileVersion:'migration-v1',sourceSchemaSha256:'a'.repeat(64),sourceFileSha256:crypto.createHash('sha256').update('synthetic-articles-'+version).digest('hex'),contentSha256:salesArticleImportContentSha256(articles),snapshotAt:`2026-09-09T10:${String(version).padStart(2,'0')}:00.000Z`,articles},actor:'00001',timestamp:TIME};
}
const article=(articleNumber,version=1,prices=[])=>({sourceArticleKey:'ean-'+articleNumber,articleNumber,description:'Synthetische Kamera '+version,active:true,sourceUpdatedAt:null,identifiers:[],prices});
module.exports={masterFixture,raw,articleSnapshot,article,TIME};
