'use strict';
const C=require('../../data-import-contract'),M=require('../../tradefoto-master-profiles'),H=require('../../tradefoto-history-profiles');
const {IMPORT_MASTER_STATEMENTS:MS}=require('../statements/import-master-data'),{IMPORT_HISTORY_STATEMENTS:HS}=require('../statements/import-history');
const {DATA_IMPORT_STATEMENTS:DS}=require('../statements/data-import'),{ARTICLE_SOURCE_STATE}=require('../statements/trade-insights');
const {createSalesMasterReader}=require('./sales-master-data'),{createImportHistoryService}=require('./import-history');
const {historyPage}=require('./history-page'),{resolveArticleReference}=require('../../trade-article-reference'),Search=require('../../flexible-search');
const ARCHIVE='ARTIKEL_STAMMGelöscht',CURRENT='ARTIKEL_STAMM',FIELDS=['EAN','Artikelbezeichnung','Sortiment','Anlagedatum'];
function createTradeArticleReader({access,tx,protection,scopeId,ownerId}){
 const master=createSalesMasterReader({protection,scopeId}),cache=new Map(),runCache=new Map();let statePromise;
 const state=()=>statePromise||=(tx.queryOne(ARTICLE_SOURCE_STATE,{scopeId,currentHash:M.profileFor(CURRENT).fingerprint,archiveHash:H.profileFor('trade',ARCHIVE).fingerprint}));
 async function current(record){
  if(!record)return null;const f=await master.projectedRecord(tx,record,FIELDS);
  if(record.sourceTable!==CURRENT)C.fail('IMPORT_MASTER_INTEGRITY');
  return {articleNumber:f.EAN,label:f.Artikelbezeichnung||'',group:f.Sortiment,origin:'current',source:'Trade_Daten.accdb',recordId:record.id,revision:record.revision,createdAt:f.Anlagedatum,deletedAt:null,importedAt:record.updatedAt,snapshotAt:null};
 }
 async function archived(record,prefetched){
  if(!record)return null;
  const service=createImportHistoryService({access,executor:tx,protection,prefetched,getActor:()=>({scopeId,ownerId}),authorize:v=>
   ['history.read','history.scope','history.reference'].includes(v.action)&&(!v.sourceInstance||v.sourceInstance==='tradefoto-weum')&&(!v.sourceTable||v.sourceTable===ARCHIVE)&&v.dataClasses.every(c=>c==='internal_business')});
  const d=await service.detail(record.id),p=d.provenance;
  const version=prefetched?.versions.get(record.id+':'+record.revision)||await tx.queryOne(HS.version,{recordId:record.id,revision:record.revision});
  if(!version)C.fail('IMPORT_HISTORY_INTEGRITY');
  if(!runCache.has(p.runId))runCache.set(p.runId,await tx.queryOne(DS.getRun,{id:p.runId,scopeId,ownerId:version.importedBy}));
  const run=runCache.get(p.runId);
  if(!run||!['applied','purged'].includes(run.status)&&!(run.status==='reverted'&&p.restoredFromRevision))C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
  const expected=protection.digest(['run',C.VERSION,{scopeId:run.scopeId,ownerId:run.ownerId},run.profileHash,run.manifest,run.attemptId]);
  if(expected!==run.id||run.profileHash!==record.profileHash||run.manifest.sourceInstance!=='tradefoto-weum')C.fail('IMPORT_HISTORY_INTEGRITY');
  const f=d.fields;
  return {articleNumber:f.EAN,label:f.Artikelbezeichnung||'',group:f.Sortiment,origin:'archive',source:'WEUM.accdb · Artikelarchiv',recordId:d.id,revision:d.revision,createdAt:f.Anlagedatum,deletedAt:f.Löschdatum,importedAt:p.importedAt,snapshotAt:p.snapshotAt};
 }
 async function candidates(key){
  if(cache.has(key))return cache.get(key);
  const a=await tx.queryOne(MS.find,{scopeId,identityHash:M.masterIdentity(protection,{scopeId,sourceInstance:'tradefoto-trade'},CURRENT,[key])});
  const b=await tx.queryOne(HS.find,{scopeId,identityHash:H.historyIdentity(protection,{scopeId,sourceInstance:'tradefoto-weum'},'trade',ARCHIVE,[key])});
  const rows=[await current(a),await archived(b)].filter(Boolean);cache.set(key,rows);return rows;
 }
 return {state,current,archived,async resolve(value,businessDate=null){
  const key=value==null?'':String(value);if(!key||key.length>120)return {articleNumber:key,status:'missing',label:null,candidates:[],businessDate};
  // Exact source keys only. Leading zeroes, case and punctuation are not identity aliases.
  if((await state()).pending)return {articleNumber:key,status:'source_pending',label:null,candidates:[],businessDate};
  return resolveArticleReference(key,await candidates(key),{businessDate});
 }};
}
async function articleHistoryPage(env,input){
 const {access,tx,protection,scopeId,session,epoch,p}=env;
 if(!p.articleHistory)C.fail('IMPORT_FORBIDDEN',403);
 C.exact(input,['query','status','searchMode','cursor']);const q={query:input.query||'',status:input.status||'archived',searchMode:input.searchMode||'text'};
 if(!['text','exact'].includes(q.searchMode))C.fail('IMPORT_SHAPE_INVALID');if(q.searchMode==='exact')C.text(q.query,120);
 if(q.query)C.text(q.query,150);if(!['all','current','archived','ambiguous'].includes(q.status))C.fail('IMPORT_SHAPE_INVALID');
 const reader=createTradeArticleReader({access,tx,protection,scopeId,ownerId:String(session.employeeNumber)}),sources=await reader.state();
 if(sources.pending)C.fail('IMPORT_BESTELL_SOURCE_INCOMPLETE',409);
 if(q.searchMode==='exact'){
  if(input.cursor)C.fail('IMPORT_BESTELL_CURSOR',409);
  const resolved=await reader.resolve(q.query),candidate=resolved.candidates.find(c=>c.origin===(q.status==='current'?'current':'archive'))||(['all','ambiguous'].includes(q.status)?resolved.candidates[0]:null);
  return {available:!!(sources.currentImports||sources.archiveImports),rows:candidate&&(q.status!=='ambiguous'||resolved.status==='ambiguous')?[{...resolved,label:resolved.label||candidate.label,group:candidate.group}]:[],scanned:resolved.candidates.length,sources,next:null,note:'Exakte Artikelkennung in Artikelstamm und Archiv. Führende Nullen bleiben Teil der Kennung; mehrdeutige Referenzen bleiben sichtbar.'};
 }
 const signature=protection.digest([q,epoch,sources,p,session.employeeNumber]),context=['trade-article-search',scopeId,String(session.employeeNumber)];
 let stage=q.status==='current'?'current':'archive',after='';
 if(input.cursor){let token;try{C.text(input.cursor,2400);token=protection.open(input.cursor,context);}catch{C.fail('IMPORT_BESTELL_CURSOR',409);}
  if(token.signature!==signature||token.expires<Date.now()||!['current','archive'].includes(token.stage))C.fail('IMPORT_BESTELL_CURSOR',409);stage=token.stage;after=token.after===''?'':C.id(token.after);}
 const prefetched=stage==='archive'?await historyPage(tx,{scopeId,sourceInstance:'tradefoto-weum',source:'trade',sourceTable:ARCHIVE,after,limit:101,snapshot:null}):null;
 const records=prefetched?[...prefetched.records.values()]:await tx.queryAll(MS.listMappings,{scopeId,sourceInstance:'tradefoto-trade',sourceTable:CURRENT,after,status:'all',limit:101});
 const rows=[];
 for(const record of records.slice(0,100)){
  const c=stage==='archive'?await reader.archived(record,prefetched):await reader.current(record);
  if(!c)continue;
  const resolved=await reader.resolve(c.articleNumber);
  if(!Search.matches([c.articleNumber,...resolved.candidates.flatMap(v=>[v.label,v.group])],q.query))continue;
  // On the combined search, an archive/current collision is emitted once with both provenances.
  if(stage==='current'&&['all','ambiguous'].includes(q.status)&&resolved.candidates.some(v=>v.origin==='archive'))continue;
  if(q.status==='ambiguous'&&resolved.status!=='ambiguous')continue;
  rows.push({...resolved,label:resolved.label||c.label,group:c.group});
 }
 let next=null;
 if(records.length>100)next={stage,after:records[99].id};
 else if(stage==='archive'&&['all','ambiguous'].includes(q.status))next={stage:'current',after:''};
 return {available:!!(sources.currentImports||sources.archiveImports),rows,scanned:Math.min(records.length,100),sources,
  next:next?protection.seal({...next,signature,expires:Date.now()+900000},context):null,
  note:'Artikelreferenzen aus übernommenen Quellen. Archivierte Artikel werden nicht aktiviert. Bei mehreren Referenzen bleibt die Zuordnung offen.'};
}
module.exports={createTradeArticleReader,articleHistoryPage};
