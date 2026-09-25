'use strict';
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const C=require('../../data-import-contract');
const {SALES_REPORT_JOB_STATEMENTS:S}=require('../statements/sales-report-jobs');
const {loadManagedDataImportProtection}=require('../../data-import-managed-protection');
const {projectionFor}=require('../../tradefoto-bestell/access');
const {titles}=require('../../../public/trade-insight-results');
// Reuse the durable report queue with a separate namespace. Both database backends
// already provide encrypted payload storage and optimistic, leased updates.
function createTradeInsightJobs({access,vault,runtime,resolvePrincipal,dispatchRead,scopeId='grabenplaner-main',now=Date.now,onError=()=>{}}){
 const scope=scopeId+':trade-insights',worker=crypto.randomUUID();let timer=null,pending=null,stopped=false;
 const stamp=()=>new Date(now()).toISOString();
 function authority(session){
  const projection=projectionFor(session);if(!projection.read||session?.mustChangePassword)C.fail('IMPORT_FORBIDDEN',403);
  return {employeeNumber:C.id(String(session.employeeNumber)),projection};
 }
 const owner=(p,session)=>p.digest(['trade-insight-owner',scope,authority(session).employeeNumber]);
 const sealContext=row=>['trade-insight-result-v1',scope,row.owner,row.id];
 const maxBytes=16*1024*1024;
 function encode(p,row,data){
  const json=Buffer.from(JSON.stringify(data));if(json.length>maxBytes)C.fail('IMPORT_REPORT_DATA_LIMIT',413);
  // Compress the structured snapshot before the small general-purpose encrypted
  // envelope. Keep the global protection limits unchanged for other imports.
  const value={encoding:'deflate-base64',payload:zlib.deflateRawSync(json,{level:1}).toString('base64')};
  if(Buffer.byteLength(JSON.stringify(value))>C.LIMITS.rowBytes*6)C.fail('IMPORT_REPORT_DATA_LIMIT',413);
  return p.seal(value,sealContext(row));
 }
 function decode(p,row){const value=p.open(row.payload,sealContext(row));return value.encoding==='deflate-base64'?JSON.parse(zlib.inflateRawSync(Buffer.from(value.payload,'base64'),{maxOutputLength:maxBytes}).toString('utf8')):value;}
 async function protectedWork(work){const p=await loadManagedDataImportProtection({access,vault,create:false});if(!p)C.fail('IMPORT_HISTORY_NOT_ACTIVATED',503);try{return await work(p);}finally{p.destroy();}}
 const permitted=(p,session,data)=>p.digest(authority(session))===data.authority;
 function view(row,data,allowed=true){return {id:row.id,status:row.status,created:row.created,updated:row.updated,title:allowed?data.title:'Ergebnis mit geänderten Berechtigungen',kind:data.kind,processed:data.processed||0,count:allowed?data.result?.rows?.length||0:0,completedAt:data.completedAt||null,error:data.error||null,accessible:allowed};}
 async function owned(p,session,id){C.id(id);const row=await access.queryOne(S.get,{scope,id});if(!row||row.owner!==owner(p,session))C.fail('IMPORT_HISTORY_NOT_FOUND',404);return [row,decode(p,row)];}
 async function save(p,row,data,status=row.status,lease=0){const update={...row,status,updated:stamp(),worker,lease,payload:encode(p,row,data)};const r=await access.execute(S.update,update);return r.rowsAffected===1?{...update,revision:row.revision+1}:null;}
 function validateKind(session,kind){
  if(!Object.hasOwn(titles,kind))C.fail('IMPORT_SHAPE_INVALID');
  const p=authority(session).projection,key=['inventory','stock-summary','stocktakes','suggestions'].includes(kind)?'inventory':kind==='repairs'?'repairs':['customer-history','device-history'].includes(kind)?'customers':'purchasing';
  if(!p[key])C.fail('IMPORT_FORBIDDEN',403);
 }
 async function create(session,input){
  C.exact(input,['kind','query','title']);validateKind(session,input.kind);
  C.exact(input.query,['query','locationId','supplier','dateFrom','dateTo','days','group','wgr','customer','serial','articleNumber','movementType','review','stocktakeId','stocktakeVersion','stocktakeSource','difference','suggestionType']);
  for(const value of Object.values(input.query))if(value!=='')C.text(value,150);
  const title=C.text(input.title?.trim()||titles[input.kind],120),a=authority(session);
  return protectedWork(async p=>{
   const context=await runtime.run(async()=>session,'context');if(!context.sourceRevision)C.fail('IMPORT_HISTORY_NOT_ACTIVATED',503);
   const row={id:crypto.randomUUID(),scope,owner:owner(p,session),status:'queued',revision:1,created:stamp(),updated:stamp(),lease:0,worker:'',payload:''};
   const data={title,kind:input.kind,query:input.query,employeeNumber:a.employeeNumber,projection:a.projection,authority:p.digest(a),sourceRevision:context.sourceRevision,processed:0,next:null,result:null};
   row.payload=encode(p,row,data);
   await access.transaction(async tx=>{const existing=await tx.queryAll(S.list,{scope,owner:row.owner});if(existing.length>=50||existing.filter(r=>['queued','running'].includes(r.status)).length>=3)C.fail('IMPORT_HISTORY_ANALYSIS_BUSY',409);await tx.execute(S.insert,row);});
   return view(row,data);
  });
 }
 const list=session=>protectedWork(async p=>(await access.queryAll(S.list,{scope,owner:owner(p,session)})).map(row=>{const data=decode(p,row);return view(row,data,permitted(p,session,data));}));
 const get=(session,id)=>protectedWork(async p=>{const [row,data]=await owned(p,session,id);if(!permitted(p,session,data))C.fail('IMPORT_FORBIDDEN',403);if(row.status!=='completed')C.fail('IMPORT_REVISION_CONFLICT',409);return {...view(row,data),query:data.query,projection:data.projection,result:data.result,startedAt:data.startedAt};});
 const rename=(session,id,input)=>protectedWork(async p=>{C.exact(input,['title']);const title=C.text(input.title?.trim(),120),[row,data]=await owned(p,session,id);if(!permitted(p,session,data))C.fail('IMPORT_FORBIDDEN',403);if(row.status!=='completed')C.fail('IMPORT_REVISION_CONFLICT',409);const saved=await save(p,row,{...data,title});if(!saved)C.fail('IMPORT_REVISION_CONFLICT',409);return view(saved,{...data,title});});
 const cancel=(session,id)=>protectedWork(async p=>{const [row,data]=await owned(p,session,id);if(!['queued','running'].includes(row.status))return view(row,data);const saved=await save(p,row,{...data,result:null,next:null},'cancelled');if(!saved)C.fail('IMPORT_REVISION_CONFLICT',409);return view(saved,{...data,result:null});});
 const remove=(session,id)=>protectedWork(async p=>{const [row]=await owned(p,session,id);if(['queued','running'].includes(row.status))C.fail('IMPORT_REVISION_CONFLICT',409);if((await access.execute(S.remove,{id,scope,owner:row.owner,revision:row.revision})).rowsAffected!==1)C.fail('IMPORT_REVISION_CONFLICT',409);return {ok:true};});
 async function step(){
  const candidate=await access.queryOne(S.next,{scope,worker,now:now()});if(!candidate)return;
  await protectedWork(async p=>{
   let row=candidate,data;
   try{data=decode(p,row);}catch{await save(p,row,{title:'Nicht lesbarer Auftrag',kind:'purchasing',error:'IMPORT_REPORT_FAILED'},'failed');return;}
   data={...data,startedAt:data.startedAt||stamp()};
   // Lease exceeds the reporting worker timeout. A restarted process resumes
   // the persisted cursor; it never silently reruns against a newer source.
   row=await save(p,row,data,'running',now()+180000);if(!row)return;
   try{
    const fresh=async()=>{const session=await resolvePrincipal(data.employeeNumber);if(!permitted(p,session,data))C.fail('IMPORT_FORBIDDEN',403);return session;};
    const query={...data.query,...(data.next?{cursor:data.next}:{})};
    const result=dispatchRead?await dispatchRead({operation:'trade-insights',kind:data.kind,query,sourceRevision:data.sourceRevision,session:{employeeNumber:(await fresh()).employeeNumber}}):await runtime.run(fresh,data.kind,query,{sourceRevision:data.sourceRevision});
    await fresh();if(stopped)return;
    if(result.available===false)C.fail('IMPORT_SOURCE_INCOMPLETE',409);
    if(result.sourceRevision!==data.sourceRevision)C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED',409);
    const rows=result.cumulative?(result.rows||[]):[...(data.result?.rows||[]),...(result.rows||[])];
    if(rows.length>20000)C.fail('IMPORT_REPORT_DATA_LIMIT',413);
    const {next,...snapshot}=result;
    const sourceDates=[...new Set([...(data.result?.sourceDates||[]),...(snapshot.sourceDates||[]),snapshot.sourceDate].filter(Boolean))];
    data={...data,next:next||null,processed:result.cumulative?result.scanned||0:data.processed+(result.scanned||0),result:{...data.result,...snapshot,rows,sourceDates},...(!next?{completedAt:stamp()}: {})};
    if(Buffer.byteLength(JSON.stringify(data))>maxBytes)C.fail('IMPORT_REPORT_DATA_LIMIT',413);
    await save(p,row,data,next?'running':'completed',next?now()+180000:0);
   }catch(error){
    if(stopped)return;
    const code=/^IMPORT_[A-Z_]+$/.test(error?.code||'')?error.code:'IMPORT_REPORT_FAILED';onError(code);
    await save(p,row,{...data,result:null,next:null,error:code},'failed');
   }
  });
 }
 function tick(){if(stopped||pending)return pending;pending=step().finally(()=>{pending=null;});return pending;}
 return {create,list,get,rename,cancel,remove,tick,
  start(){if(timer)return;stopped=false;timer=setInterval(()=>{void tick()?.catch(e=>onError(e.code||'IMPORT_REPORT_FAILED'));},1000);timer.unref();},
  async stop(){stopped=true;clearInterval(timer);timer=null;await pending;}
 };
}
module.exports={createTradeInsightJobs};
