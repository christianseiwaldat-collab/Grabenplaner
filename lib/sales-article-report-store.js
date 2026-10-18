'use strict';
const crypto=require('node:crypto');
const Model=require('./sales-article-report-model'),Pdf=require('./sales-article-report-pdf');
const {projectionFor}=require('./tradefoto-bestell/access');
const {assertPersistenceAccess}=require('./persistence/contract');
const {loadManagedDataImportProtection}=require('./data-import-managed-protection');
const {annotations}=require('./persistence/repositories/trade-annotations');
const {canonical}=require('./data-import-contract');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LIMITS=Object.freeze({reports:50,bytes:100*1024*1024,pdfBytes:10*1024*1024});
const CHUNK_BYTES=256*1024,ALL_CAPS={read:true,prices:true,costs:true,margin:true};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=(message,status=400,code='ARTICLE_REPORT_INVALID')=>Model.fail(message,status,code);
const missing=()=>fail('Der gespeicherte Bericht wurde nicht gefunden.',404,'ARTICLE_REPORT_NOT_FOUND');
const integrity=()=>fail('Der gespeicherte Bericht konnte nicht sicher gelesen werden.',503,'ARTICLE_REPORT_STORAGE_INTEGRITY');
function actorFor(session){
 if(!Model.capabilities(session).read||!session?.employeeNumber||session.isEmployee===false||session.mustChangePassword)fail('Für die Artikelauswertung ist ein persönlicher Zugang erforderlich.',403,'ARTICLE_REPORT_FORBIDDEN');
 return {key:JSON.stringify([Model.text(String(session.employeeNumber),120),Model.text(String(session.accountId||''),120)]),employee:String(session.employeeNumber)};
}
function specValue(spec){return {filters:{...spec.filters,locations:[...spec.filters.locations]},columns:spec.columns.map(c=>c.id),title:spec.title,name:spec.name,orientation:spec.orientation};}
function canRead(session,value){
 const caps=Model.capabilities(session),projection=projectionFor(session);
 if(!caps.read)return false;
 const ids=Model.columnsFor(caps).map(c=>c.id);
 return value.spec.columns.every(id=>ids.includes(id))&&ids.includes(value.spec.filters.sort)
  &&value.locationIds.every(id=>id.startsWith('trade-source:')?projection.company&&projection.unassigned:projection.company||projection.locationIds.includes(id));
}
const summary=value=>({id:value.id,title:value.spec.title,name:value.spec.name,createdAt:value.createdAt,sourceAt:value.sourceAt,pages:value.pages,rows:value.rows,bytes:value.bytes,filters:value.spec.filters});

// Immutable PDFs are encrypted in bounded database records. The existing core
// database backup/restore includes their bytes; there are no client file paths,
// detached blobs, or preference-list queries that load every PDF into memory.
function createSalesArticleReportStore({access,vault,scopeId='grabenplaner-main',now=Date.now}){
 assertPersistenceAccess(access);const scope=scopeId+':article-report-documents';
 async function transaction(session,write,work,fresh=async()=>{}){
  const owner=actorFor(session);let protection;
  try{
   protection=await loadManagedDataImportProtection({access,vault,create:write});await fresh();
   const result=await access.transaction(tx=>work(protection?annotations({protection,scopeId:scope}):null,tx,owner),{isolation:'serializable',readOnly:!write});
   await fresh();return result;
  }catch(error){
   if(['IMPORT_CONCURRENT_CHANGE','PERSISTENCE_RETRYABLE_TRANSACTION','PERSISTENCE_BUSY','PERSISTENCE_UNIQUE_VIOLATION'].includes(error.code))fail('Die Berichtsliste wurde inzwischen geändert. Bitte erneut versuchen.',409,'ARTICLE_REPORT_STORAGE_CHANGED');
   if(['IMPORT_PROTECTED_PAYLOAD_INVALID','IMPORT_PROTECTION_KEY_INVALID','IMPORT_VAULT_UNAVAILABLE'].includes(error.code))integrity();
   throw error;
  }finally{protection?.destroy();}
 }
 function validIndex(row){
  const value=row.value||{schemaVersion:1,reports:[]};
  if(value.schemaVersion!==1||!Array.isArray(value.reports)||value.reports.length>LIMITS.reports||new Set(value.reports.map(r=>r.id)).size!==value.reports.length
   ||value.reports.some(r=>!UUID.test(r.id)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>LIMITS.pdfBytes)
   ||value.reports.reduce((sum,r)=>sum+r.bytes,0)>LIMITS.bytes)integrity();
  return value;
 }
 async function index(store,tx,owner){const row=store?await store.read(tx,'article-report-index',owner.key):{revision:0,value:null};return {...row,value:validIndex(row)};}
 function valid(value,id,owner){
  try{
   Model.exact(value,['schemaVersion','id','owner','createdAt','sourceAt','spec','locationIds','bytes','sha256','chunks','pages','rows']);
   if(value.schemaVersion!==1||value.id!==id||value.owner!==owner.key||!UUID.test(id)||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.sourceAt))
    ||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>LIMITS.pdfBytes||!/^[a-f0-9]{64}$/.test(value.sha256)
    ||value.chunks!==Math.ceil(value.bytes/CHUNK_BYTES)||!Number.isSafeInteger(value.pages)||value.pages<1||value.pages>10000||!Number.isSafeInteger(value.rows)||value.rows<1||value.rows>Model.MAX_ROWS
    ||!Array.isArray(value.locationIds)||!value.locationIds.length||value.locationIds.length>100||new Set(value.locationIds).size!==value.locationIds.length)throw new Error();
   value.locationIds.forEach(id=>{if(Model.text(id,120)!==id||!id)throw new Error();});
   if(canonical(specValue(Pdf.normalize(value.spec,ALL_CAPS)))!==canonical(value.spec))throw new Error();
  }catch{integrity();}return value;
 }
 async function read(store,tx,owner,list,id,{authorize=true,session}={}){
  if(!UUID.test(id)||!list.value.reports.some(r=>r.id===id))missing();
  const row=await store.read(tx,'article-report-document',owner.key+':'+id);valid(row.value,id,owner);
  if(row.value.bytes!==list.value.reports.find(r=>r.id===id).bytes)integrity();
  if(authorize&&!canRead(session,row.value))fail('Für diesen gespeicherten Bericht fehlen inzwischen Leserechte.',403,'ARTICLE_REPORT_FORBIDDEN');
  return row;
 }
 return Object.freeze({
  list(session,{assertFresh}={}){return transaction(session,false,async(store,tx,owner)=>{
   const list=await index(store,tx,owner),reports=[];
   for(const entry of list.value.reports){const row=await read(store,tx,owner,list,entry.id,{authorize:false});if(canRead(session,row.value))reports.push(summary(row.value));}
   return {reports:reports.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)),limits:LIMITS};
  },assertFresh);},
  get(session,id,{assertFresh}={}){return transaction(session,false,async(store,tx,owner)=>{
   const row=await read(store,tx,owner,await index(store,tx,owner),id,{session});return {report:{...summary(row.value),spec:row.value.spec}};
  },assertFresh);},
  create(session,snapshot,{assertFresh}={}){
   const owner=actorFor(session),spec=specValue(Pdf.normalize(snapshot.spec,Model.capabilities(session))),buffer=snapshot.pdf?.buffer;
   if(!Buffer.isBuffer(buffer)||buffer.length<8||buffer.length>LIMITS.pdfBytes||buffer.subarray(0,5).toString()!=='%PDF-')fail('Die PDF-Auswertung darf höchstens 10 MiB groß sein.',413,'ARTICLE_REPORT_STORAGE_LIMIT');
   const value={schemaVersion:1,id:snapshot.id,owner:owner.key,createdAt:new Date(now()).toISOString(),sourceAt:snapshot.sourceAt,spec,
    locationIds:[...new Set(snapshot.locationIds)].sort(),bytes:buffer.length,sha256:sha(buffer),chunks:Math.ceil(buffer.length/CHUNK_BYTES),pages:snapshot.pdf.pages,rows:snapshot.pdf.rows};
   valid(value,snapshot.id,owner);if(!canRead(session,value))fail('Für diesen Bericht fehlen Leserechte.',403,'ARTICLE_REPORT_FORBIDDEN');
   return transaction(session,true,async(store,tx,owner)=>{
    const list=await index(store,tx,owner);
    if(list.value.reports.some(r=>r.id===value.id)){
     const prior=await read(store,tx,owner,list,value.id,{session});
     if(prior.value.sha256!==value.sha256||canonical(prior.value.spec)!==canonical(value.spec))fail('Diese Berichtkennung ist bereits vergeben.',409,'ARTICLE_REPORT_STORAGE_CHANGED');
     return {report:summary(prior.value)};
    }
    if(list.value.reports.length>=LIMITS.reports||list.value.reports.reduce((sum,r)=>sum+r.bytes,0)+value.bytes>LIMITS.bytes)fail('Die Berichtsablage ist voll. Bitte ältere Berichte löschen.',413,'ARTICLE_REPORT_STORAGE_LIMIT');
    await store.write(tx,'article-report-document',owner.key+':'+value.id,value,0,owner.employee);
    for(let n=0;n<value.chunks;n++)await store.write(tx,'article-report-pdf',owner.key+':'+value.id+':'+n,{schemaVersion:1,id:value.id,part:n,data:buffer.subarray(n*CHUNK_BYTES,(n+1)*CHUNK_BYTES).toString('base64')},0,owner.employee);
    await store.write(tx,'article-report-index',owner.key,{schemaVersion:1,reports:[...list.value.reports,{id:value.id,bytes:value.bytes}]},list.revision,owner.employee);
    return {report:summary(value)};
   },assertFresh);
  },
  content(session,id,{assertFresh}={}){return transaction(session,false,async(store,tx,owner)=>{
   const {value}=await read(store,tx,owner,await index(store,tx,owner),id,{session}),parts=[];
   for(let n=0;n<value.chunks;n++){
    const chunk=(await store.read(tx,'article-report-pdf',owner.key+':'+id+':'+n)).value;
    if(!chunk||chunk.schemaVersion!==1||chunk.id!==id||chunk.part!==n||typeof chunk.data!=='string'||chunk.data.length>Math.ceil(CHUNK_BYTES/3)*4)integrity();
    const bytes=Buffer.from(chunk.data,'base64');if(bytes.toString('base64')!==chunk.data||bytes.length!==Math.min(CHUNK_BYTES,value.bytes-n*CHUNK_BYTES))integrity();parts.push(bytes);
   }
   const buffer=Buffer.concat(parts);if(buffer.length!==value.bytes||sha(buffer)!==value.sha256||buffer.subarray(0,5).toString()!=='%PDF-')integrity();
   return {buffer,pages:value.pages,rows:value.rows,name:value.spec.name};
  },assertFresh);},
  remove(session,id,{assertFresh}={}){return transaction(session,true,async(store,tx,owner)=>{
   const list=await index(store,tx,owner),row=await read(store,tx,owner,list,id,{session});
   for(let n=0;n<row.value.chunks;n++){
    const key=owner.key+':'+id+':'+n,chunk=await store.read(tx,'article-report-pdf',key);if(!chunk.value)integrity();
    await store.remove(tx,'article-report-pdf',key,chunk.revision,owner.employee);
   }
   await store.remove(tx,'article-report-document',owner.key+':'+id,row.revision,owner.employee);
   await store.write(tx,'article-report-index',owner.key,{schemaVersion:1,reports:list.value.reports.filter(r=>r.id!==id)},list.revision,owner.employee);return {removed:true};
  },assertFresh);},
 });
}
module.exports={createSalesArticleReportStore,actorFor,specValue,canRead,LIMITS,CHUNK_BYTES};
