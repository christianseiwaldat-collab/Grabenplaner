'use strict';
const C=require('../../data-import-contract'),H=require('../../tradefoto-history-profiles'),M=require('../../tradefoto-master-profiles');
const {projectionFor}=require('../../tradefoto-bestell/access');
const {loadManagedDataImportProtection}=require('../../data-import-managed-protection');
const {createImportHistoryService}=require('./import-history');
const {historyPage}=require('./history-page');
const {IMPORT_HISTORY_STATEMENTS:S}=require('../statements/import-history');
const {IMPORT_MASTER_STATEMENTS:MS}=require('../statements/import-master-data');
const {DATA_IMPORT_STATEMENTS:DS}=require('../statements/data-import');
const {createSalesMasterReader}=require('./sales-master-data');
const P=require('../../tradefoto-bestell/purchasing');
const Search=require('../../flexible-search');
const scopeIdDefault='grabenplaner-main';
const tables={purchasing:'BESTELLDETAILS',transfers:'BESTELLKORB'};
function createTradeInsightRuntime({access,vault,scopeId=scopeIdDefault,cashBackendFactory,today=()=>new Date().toISOString().slice(0,10)}){
 async function run(getSession,operation,input={},options={}){
  let session=await getSession();const authority=value=>C.canonical([value?.id||null,value?.employeeNumber||null,projectionFor(value),value?.permissions||[]]);
  const identity=authority(session),p=projectionFor(session);
  if(!p.read)C.fail('IMPORT_FORBIDDEN',403);
  const articleHistory=p.read&&require('../../sales-article-catalog-access').buildSalesArticleCatalogProjection(session).read;
  if(operation==='article-history'&&!articleHistory)C.fail('IMPORT_FORBIDDEN',403);
  const fresh=async executor=>{const current=await getSession(executor);if(identity!==authority(current))C.fail('IMPORT_FORBIDDEN',403);return current;};
  const protection=await loadManagedDataImportProtection({access,vault,create:false});
  try{
   if(!protection)return operation==='article-history'?{available:false,rows:[],scanned:0,next:null,sources:{currentImports:0,archiveImports:0}}:{available:false,projection:{...p,articleHistory},locations:[]};
   let sourceRevision;
   const result=await access.transaction(async tx=>{
    const epoch=await tx.queryOne(S.epoch,{scopeId}),reader=createSalesMasterReader({protection,scopeId,batch:require('./import-batch-support').supportsImportBatches(access)});
    const annotationEpoch=await tx.queryOne(require('../statements/trade-annotations').A.epoch,{scopeId});
    const cashState=await tx.queryOne(require('../statements/cash-publications').CASH_PUBLICATION_STATEMENTS.state,{scopeId});
    sourceRevision=protection.digest(['trade-insight-source',epoch,annotationEpoch,cashState?.revision||0]);
    if(options.sourceRevision&&options.sourceRevision!==sourceRevision)C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED',409);
    const sourceCache=new Map(),locationCache=new Map(),runCache=new Map(),documentCache=new Map();
    async function source(table,instance='tradefoto-bestell'){
     const key=instance+':'+table;if(sourceCache.has(key))return sourceCache.get(key);
     const profile=H.profileFor('trade',table),runs=await tx.queryAll(require('../statements/trade-insights').SOURCES,{scopeId,profileHash:profile.fingerprint,limit:100});
     const found=runs.filter(r=>['applied','purged'].includes(r.status)&&r.manifest.sourceInstance===instance)
      .sort((a,b)=>b.manifest.snapshotAt.localeCompare(a.manifest.snapshotAt)||b.createdAt.localeCompare(a.createdAt))[0];
     if(found){
      const expected=protection.digest(['run',C.VERSION,{scopeId:found.scopeId,ownerId:found.ownerId},profile.fingerprint,found.manifest,found.attemptId]);
      if(found.id!==expected||!C.equal(found.profile,profile)||found.receivedCount!==found.manifest.expectedRows)C.fail('IMPORT_HISTORY_INTEGRITY');
      runCache.set(found.id,found);
     }
     sourceCache.set(key,found||null);return found||null;
    }
    async function location(raw){
     if(raw===null||raw===undefined||raw==='')return null;raw=String(raw);
     if(locationCache.has(raw))return locationCache.get(raw);
     const reference=require('./import-master-data').createImportMasterReferenceReader({protection,authorize:()=>true});
     let value=null;
     for(const key of raw==='00'?['00','0']:[raw]){
      const binding=await reference(tx,{scopeId,ownerId:String(session.employeeNumber),sourceInstance:'tradefoto-trade'},'FILIALEN',[key]);
      if(['linked','historical_mapping'].includes(binding.status)){value=String(binding.targetId);break;}
     }
     locationCache.set(raw,value);return value;
    }
    async function visible(raw,filter=''){
     const target=await location(raw);return (!filter||filter===target)&& (target?(p.company||p.locationIds.includes(target)):p.company&&p.unassigned&&!filter);
    }
    function history(prefetched){return createImportHistoryService({access,executor:tx,protection,prefetched,getActor:()=>({scopeId,ownerId:String(session.employeeNumber)}),
     authorize:v=>['history.read','history.scope','history.reference'].includes(v.action)
      &&(!v.sourceInstance||['tradefoto-bestell','tradefoto-trade'].includes(v.sourceInstance)||v.sourceInstance==='tradefoto-weum'&&v.sourceTable==='WE'||v.sourceInstance==='tradefoto-inventur'&&['Inventur','Inventurdetails'].includes(v.sourceTable))
      &&v.dataClasses.every(c=>c==='internal_business'||c==='catalog_costs'&&p.costs||c==='customer_restricted'&&(p.customers||v.sourceTable==='BESTELLUNGEN'&&p.purchasing)||c==='restricted_finance'&&p.finance)});}
    async function document(record,prefetched){
     const cacheKey=record.id;if(documentCache.has(cacheKey))return documentCache.get(cacheKey);
     const value=await history(prefetched).detail(record.id),v=value.provenance;
     let run=runCache.get(v.runId);if(!run){
      const version=prefetched?.versions.get(record.id+':'+record.revision)||await tx.queryOne(S.version,{recordId:record.id,revision:record.revision});
      run=await tx.queryOne(DS.getRun,{scopeId,id:v.runId,ownerId:version.importedBy});runCache.set(v.runId,run);
     }
     if(!run||!['applied','purged'].includes(run.status)&&!(run.status==='reverted'&&v.restoredFromRevision))C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
     const expected=protection.digest(['run',C.VERSION,{scopeId:run.scopeId,ownerId:run.ownerId},run.profileHash,run.manifest,run.attemptId]);
     if(expected!==run.id||run.manifest.sourceInstance!==v.sourceInstance||run.profileHash!==record.profileHash)C.fail('IMPORT_HISTORY_INTEGRITY');
     documentCache.set(cacheKey,value);return value;
    }
    async function byKey(table,key,instance='tradefoto-bestell'){
     const row=await tx.queryOne(S.find,{scopeId,identityHash:H.historyIdentity(protection,{scopeId,sourceInstance:instance},'trade',table,key)});
     if(!row)return null;if(row.sourceInstance!==instance||row.sourceTable!==table)C.fail('IMPORT_HISTORY_INTEGRITY');return document(row);
    }
    const env={access,tx,scopeId,session,p,protection,reader,source,location,visible,document,byKey,epoch,today,fresh,cashBackendFactory};
    if(operation==='article-history')return require('./trade-article-history').articleHistoryPage({...env,p:{...p,articleHistory}},input);
    if(operation==='movements')return require('./trade-movements').movementsPage(env,input);
    if(operation==='stocktakes')return require('./trade-stocktakes').stocktakesPage(env,input);
    if(operation==='suggestions')return require('./trade-suggestions').suggestionsPage({...env,annotationEpoch},input);
    if(operation==='context'){
     const rows=await tx.queryAll(MS.locationTargets,{after:'',query:'',limit:1000});
     const sources={};for(const name of Object.keys(tables))if(p.purchasing){const s=await source(tables[name]);sources[name]=s?{date:s.manifest.snapshotAt,rows:s.receivedCount}:null;}
     if(p.purchasing){const s=await source('WE','tradefoto-weum');sources.movements=s?{date:s.manifest.snapshotAt,rows:s.receivedCount}:null;}
     if(p.inventory){const s=await source('Inventur','tradefoto-inventur');sources.stocktakes=s?{date:s.manifest.snapshotAt,rows:s.receivedCount}:null;}
     return {available:true,projection:{...p,articleHistory},locations:rows.filter(l=>l.active&&(p.company||p.locationIds.includes(l.id))).map(l=>({id:l.id,label:l.label})),sources,today:today()};
    }
    if(['inventory','stock-summary','prices','stock-metadata','stock-summary-metadata','classification','classification-save'].includes(operation)){
     env.annotationEpoch=await tx.queryOne(require('../statements/trade-annotations').A.epoch,{scopeId});
     return require('./trade-stock').stockOperation(env,operation,input);
    }
    if(['repairs','repair-detail','repair-save','customer-history','device-history'].includes(operation)){
     env.annotationEpoch=await tx.queryOne(require('../statements/trade-annotations').A.epoch,{scopeId});
     return require('./trade-customer-history').customerOperation(env,operation,input);
    }
    if(!tables[operation])C.fail('IMPORT_BESTELL_VIEW',422);
    if(!p.purchasing)C.fail('IMPORT_FORBIDDEN',403);
    C.exact(input,['query','locationId','supplier','dateFrom','dateTo','cursor']);
    const q={query:input.query||'',locationId:input.locationId||'',supplier:input.supplier||'',dateFrom:input.dateFrom||'',dateTo:input.dateTo||''};
    for(const key of ['query','supplier'])if(q[key])C.text(q[key],150);if(q.locationId)C.id(q.locationId);
    for(const key of ['dateFrom','dateTo'])if(q[key])require('../../sales-history-query').normalizeSalesHistoryQuery({sourceId:'x',dateFrom:q[key],dateTo:q[key]},{today:today(),projection:{read:true,company:true}});
    if(q.dateFrom&&q.dateTo&&q.dateFrom>q.dateTo)C.fail('IMPORT_HISTORY_DATE_RANGE');
    if(q.locationId&&!p.company&&!p.locationIds.includes(q.locationId))C.fail('IMPORT_FORBIDDEN',403);
    const table=tables[operation],active=await source(table);if(!active)return {available:false,rows:[],next:null};
    const signature=protection.digest([identity,operation,q,epoch,active.id]),cursorContext=['trade-insights-cursor',scopeId,String(session.employeeNumber)];
    let after='';if(input.cursor){C.text(input.cursor,2400);let saved;try{saved=protection.open(input.cursor,cursorContext);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}
     if(saved.signature!==signature||saved.expires<Date.now())C.fail('IMPORT_BESTELL_CURSOR',409);after=C.id(saved.after);}
    const prefetched=await historyPage(tx,{scopeId,sourceInstance:'tradefoto-bestell',source:'trade',sourceTable:table,after,limit:51,
     snapshot:H.tableFor('trade',table).keys?null:active.manifest.fileSha256});
    const records=[...prefetched.records.values()],rows=[];
    for(const record of records.slice(0,50)){
     const value=await document(record,prefetched),f=value.fields;let row,rawLocation,date;
     if(operation==='purchasing'){
      const head=await byKey('BESTELLUNGEN',[String(f.BestellNr)]),h=head?.fields||{};rawLocation=h.LFilialID;date=h.Bestelldatum;
      if(!await visible(rawLocation,q.locationId))continue;
      row={id:value.id,orderNumber:f.BestellNr,articleNumber:f.EAN,label:f.BArtikelbezeichnung||'',supplier:h.Suchname||'',
       ordered:f.BMenge,deliveredCumulative:f.gMenge,...P.supplyState(f.BMenge??null,f.gMenge??null),receiptEventsAvailable:false};
     }else{
      rawLocation=f.Filiale;date=f.KDatum;if(!await visible(rawLocation,q.locationId))continue;
      const entry=P.branchRequest(f,new Map());
      row={id:value.id,articleNumber:entry.articleNumber,label:entry.label,quantity:entry.quantity,state:entry.state,sourceStatus:entry.sourceStatus,
       from:await visible(f.UmlagerungvonFil)?String(f.UmlagerungvonFil??''):'',processedAt:entry.processedAt,physicalReceiptConfirmed:false};
     }
     const day=String(date||'').slice(0,10);if(q.dateFrom&&(!day||day<q.dateFrom)||q.dateTo&&(!day||day>q.dateTo))continue;
     if(!Search.matches([row.articleNumber,row.label,row.orderNumber],q.query)||!Search.matches([row.supplier],q.supplier))continue;
     rows.push({...row,date:date||null,sourceLocation:String(rawLocation??''),locationId:await location(rawLocation),sourceDate:value.provenance.snapshotAt});
    }
    const last=records.slice(0,50).at(-1),next=records.length>50?protection.seal({signature,after:last.id,expires:Date.now()+900000},cursorContext):null;
    return {available:true,rows,next,scanned:Math.min(50,records.length),sourceDate:active.manifest.snapshotAt,scope:'page',
     note:operation==='purchasing'?'Kumulierte Liefermengen je Artikel; keine Liste aktuell offener Aufträge und kein Wareneingangsjournal.':'Vermerkte Filialanforderungen und Umlagerungen; kein bestätigter physischer Wareneingang.'};
   },{isolation:'serializable',readOnly:!operation.endsWith('-save')});
   session=await getSession();if(identity!==authority(session))C.fail('IMPORT_FORBIDDEN',403);
   return {...result,sourceRevision};
  }finally{protection?.destroy();}
 }
 return {run};
}
module.exports={createTradeInsightRuntime};
