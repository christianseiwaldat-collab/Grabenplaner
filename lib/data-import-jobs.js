'use strict';
const C=require('./data-import-contract'),{buildDataImportProjection}=require('./data-import-access');
const {assertSourceBytes}=require('./tradefoto-full-import-source');
const {createDataImportJobStore}=require('./data-import-job-store');
const RETRY_DELAYS=[30000,120000,600000];
const RETRYABLE=new Set(['IMPORT_SOURCE_READ_TIMEOUT','IMPORT_SOURCE_READ_INTERRUPTED','IMPORT_SOURCE_READ_FAILED',
  'IMPORT_SOURCE_INTERRUPTED','IMPORT_SOURCE_BUSY','IMPORT_CONCURRENT_CHANGE','IMPORT_REVISION_CONFLICT',
  'IMPORT_RETRY_LATER','PERSISTENCE_TIMEOUT','PERSISTENCE_BUSY','PERSISTENCE_CONNECTION_UNAVAILABLE','PERSISTENCE_RETRYABLE_TRANSACTION']);
const codeOf=e=>/^(?:IMPORT_|PERSISTENCE_)[A-Z0-9_]{1,80}$/.test(e?.code||'')?e.code:'IMPORT_JOB_FAILED';
const ACTIVE=new Set(['queued','reading','reviewing','retrying']);

// One worker follows the app's existing instance lock. No browser cookie,
// session token or stored permission grant is used. Business apply needs a
// separate, explicit admission; uploads can never grant it implicitly.
function createDataImportJobs({directory,vault,runtime,resolvePrincipal,lifecycle,now=Date.now,onError=()=>{},store=createDataImportJobStore({directory,vault,now}),retryDelays=RETRY_DELAYS}) {
  const jobs=new Map();let initialized=null,pending=null,timer=null,stopped=false,controller=null,current=null,admitting=false,uploadHeld=false;
  function beginUpload(){
    lifecycle.assertAvailable();
    if(stopped)C.fail('IMPORT_MAINTENANCE',503);
    if(uploadHeld||admitting||current&&jobs.get(current)?.phase==='reading')C.fail('IMPORT_SOURCE_BUSY',409);
    uploadHeld=true;let released=false;return ()=>{if(!released){released=true;uploadHeld=false;}};
  }
  const owner=(session,apply=false)=>{const p=buildDataImportProjection(session);if(!p.prepare||apply&&!p.apply)C.fail('IMPORT_FORBIDDEN',403);return C.id(String(session.employeeNumber));};
  async function init(){if(!initialized)initialized=(async()=>{
    for(const job of await store.list()){
      if(job.expires<=now()||job.status==='completed'){if(job.blob)await store.remove(job.blob.name);await store.remove(job.id);continue;}
      // The interrupted attempt resumes at database checkpoints, not row zero.
      if(['reading','reviewing'].includes(job.status)){job.status='queued';job.nextAt=now();await store.save(job);}
      jobs.set(job.id,job);
    }
  })().catch(e=>{initialized=null;throw e;});return initialized;}
  const summary=j=>j?{status:j.operation==='content-date'&&ACTIVE.has(j.status)?'dating':j.operation==='apply'&&j.status==='reviewing'?'applying':j.status,phase:j.operation==='content-date'?'content-date':j.operation==='apply'?'applying':j.phase,retries:j.retries,maxRetries:retryDelays.length,
    nextAt:ACTIVE.has(j.status)?new Date(j.nextAt).toISOString():null,expiresAt:new Date(j.expires).toISOString(),error:j.error||null}:null;
  async function overlay(source){await init();const job=jobs.get(source.id);return {...source,uploadFileAvailable:!!job?.blob,...(job?{background:summary(job),active:source.active||current===source.id||ACTIVE.has(job.status)}:{})};}
  async function cleanExpired(){for(const j of jobs.values())if(j.expires<=now()&&j.id!==current){
    if(j.blob)await store.remove(j.blob.name);await store.remove(j.id);jobs.delete(j.id);
  }}
  async function enqueue(getSession,{buffer,kind,fileName,password='',signal}){
    if(stopped)C.fail('IMPORT_MAINTENANCE',503);
    if(admitting)C.fail('IMPORT_SOURCE_BUSY',409);admitting=true;let blob,saved=false;
    try{
      lifecycle.assertAvailable();assertSourceBytes(buffer);
      if(typeof password!=='string'||Buffer.byteLength(password)>256)C.fail('IMPORT_SOURCE_PASSWORD_INVALID');
      const employee=owner(await getSession());await init();await cleanExpired();
      const source=await runtime.reserve(getSession,{buffer,kind,fileName}),prior=jobs.get(source.id);
      if(prior&&ACTIVE.has(prior.status))return overlay(source);
      if(source.complete&&['ready','needs_review','applied'].includes(source.status))return source;
      await store.capacity(source.complete?0:buffer.length,[...jobs.values()].filter(j=>j.id!==source.id));
      if(!source.complete)blob=await store.encrypt(source.id,buffer,signal);
      if(signal?.aborted||stopped)C.fail('IMPORT_MAINTENANCE',503);
      if(owner(await getSession())!==employee)C.fail('IMPORT_FORBIDDEN',403);
      const created=now();
      const job={version:1,id:source.id,kind,owner:employee,status:'queued',phase:source.complete?'reviewing':'reading',
        created,expires:created+store.retentionMs,nextAt:created,retries:0,error:null,blob:blob||null,password:source.complete?'':password};
      await store.save(job);saved=true;jobs.set(job.id,job);
      if(prior?.blob&&prior.blob.name!==job.blob?.name)await store.remove(prior.blob.name);
      return overlay(source);
    }finally{admitting=false;if(blob&&!saved)await store.remove(blob.name);}
  }
  async function action(getSession,id,action){
    C.sha(id);const employee=owner(await getSession());await init();const job=jobs.get(id);
    if(!job||job.owner!==employee)C.fail('IMPORT_SOURCE_NOT_FOUND',404);
    owner(await getSession(),job.operation==='apply');
    if(job.expires<=now())C.fail('IMPORT_JOB_EXPIRED',409);
    if(action==='pause'){
      job.status='paused';job.error=null;if(current===id)controller?.abort();await store.save(job);
    }else if(action==='retry'){
      if(current===id)C.fail('IMPORT_SOURCE_BUSY',409);
      if(job.phase==='reading'&&!job.blob)C.fail('IMPORT_JOB_FILE_DELETED',409);
      lifecycle.assertAvailable();job.status='queued';job.error=null;job.retries=0;job.nextAt=now();await store.save(job);
    }else C.fail('IMPORT_ACTION_INVALID');
    return overlay(await runtime.sourceOperation(getSession,id,'read'));
  }
  async function enqueueApply(getSession,id,input={}){
    C.sha(id);C.exact(input,['expectedRevision']);C.integer(input.expectedRevision,1,Number.MAX_SAFE_INTEGER);
    lifecycle.assertAvailable();if(stopped)C.fail('IMPORT_MAINTENANCE',503);
    if(admitting)C.fail('IMPORT_SOURCE_BUSY',409);admitting=true;
    try{
      const employee=owner(await getSession(),true);await init();await cleanExpired();
      const source=await runtime.sourceOperation(getSession,id,'read'),prior=jobs.get(id);
      if(prior&&ACTIVE.has(prior.status)){
        if(prior.owner===employee&&prior.operation==='apply')return overlay(source);
        C.fail('IMPORT_SOURCE_BUSY',409);
      }
      if(source.revision!==input.expectedRevision)C.fail('IMPORT_REVISION_CONFLICT',409);
      if(!source.activationEnabled)C.fail('IMPORT_NOT_ACTIVATED',409);
      if(!source.complete)C.fail('IMPORT_SOURCE_INCOMPLETE',409);
      if(source.status==='applied'&&!source.catalogUpdatePending)return source;
      if(!['ready','needs_review','applying','applied'].includes(source.status))C.fail('IMPORT_STATE_CONFLICT',409);
      if(source.tables?.some(t=>t.run?.gates?.length||t.run?.counts?.invalid))C.fail('IMPORT_DECISION_GATE',409);
      await store.capacity(0,[...jobs.values()].filter(j=>j.id!==id));
      if(owner(await getSession(),true)!==employee)C.fail('IMPORT_FORBIDDEN',403);
      lifecycle.assertAvailable();if(stopped)C.fail('IMPORT_MAINTENANCE',503);
      // Keep the v1 preparation envelope readable by the previous release. Its
      // worker never applies data; only this explicit operation enables apply.
      const created=now();
      const job={version:1,id,kind:source.kind,owner:employee,operation:'apply',requestedRevision:source.revision,
        status:'queued',phase:'reviewing',created,expires:created+store.retentionMs,nextAt:created,retries:0,error:null,blob:null,password:''};
      await store.save(job);jobs.set(id,job);if(prior?.blob)await store.remove(prior.blob.name);
      return overlay(source);
    }finally{admitting=false;}
  }
  async function assertIdle(id){await init();if(current===id||ACTIVE.has(jobs.get(id)?.status))C.fail('IMPORT_SOURCE_BUSY',409);}
  async function enqueueContentDate(getSession,id) {
    C.sha(id);if(stopped||admitting)return false;
    admitting=true;
    try {
      lifecycle.assertAvailable();const employee=owner(await getSession());await init();await cleanExpired();
      if(jobs.has(id)||current===id||[...jobs.values()].some(j=>j.operation==='content-date'&&(ACTIVE.has(j.status)||j.id===current)))return false;
      const source=await runtime.sourceOperation(getSession,id,'read');
      if(!source.complete||source.active||source.contentDate?.status==='complete')return false;
      await store.capacity(0,[...jobs.values()]);
      if(owner(await getSession())!==employee)C.fail('IMPORT_FORBIDDEN',403);
      const created=now(),job={version:1,id,kind:source.kind,owner:employee,operation:'content-date',requestedRevision:source.revision,
        status:'queued',phase:'reviewing',created,expires:created+store.retentionMs,nextAt:created,retries:0,error:null,blob:null,password:''};
      await store.save(job);jobs.set(id,job);return true;
    } finally {admitting=false;}
  }
  async function deleteUpload(getSession,id,input={}) {
    C.sha(id);C.exact(input,['expectedRevision']);C.integer(input.expectedRevision,1,Number.MAX_SAFE_INTEGER);
    lifecycle.assertAvailable();if(stopped)C.fail('IMPORT_MAINTENANCE',503);
    if(admitting)C.fail('IMPORT_SOURCE_BUSY',409);admitting=true;
    try {
      const employee=owner(await getSession());await init();
      const source=await runtime.sourceOperation(getSession,id,'read'),job=jobs.get(id);
      if(source.revision!==input.expectedRevision)C.fail('IMPORT_REVISION_CONFLICT',409);
      if(job&&job.owner!==employee)C.fail('IMPORT_SOURCE_NOT_FOUND',404);
      await assertIdle(id);
      if(job?.blob) {
        if(owner(await getSession())!==employee)C.fail('IMPORT_FORBIDDEN',403);
        // Delete only the temporary Access copy. There are deliberately no GP
        // persistence writes here; staged/applied data and evidence stay intact.
        await store.remove(job.blob.name);
        job.blob=null;job.password='';
        if(source.complete&&['ready','needs_review','applied','reverted'].includes(source.status)) {await store.remove(job.id);jobs.delete(id);}
        else {job.phase=source.complete?'reviewing':'reading';job.status=source.complete?'paused':'failed';job.error=source.complete?null:'IMPORT_JOB_FILE_DELETED';await store.save(job);}
      }
      return overlay(source);
    } finally {admitting=false;}
  }
  async function deleteSource(getSession,id,input={},preview=false){
    C.sha(id);lifecycle.assertAvailable();if(stopped)C.fail('IMPORT_MAINTENANCE',503);
    if(admitting||uploadHeld)C.fail('IMPORT_SOURCE_BUSY',409);admitting=true;
    try{
      const employee=owner(await getSession());await init();await assertIdle(id);
      const job=jobs.get(id);if(job&&job.owner!==employee)C.fail('IMPORT_SOURCE_NOT_FOUND',404);
      // Read-only eligibility first; an applied source never loses its upload.
      const eligibility=await runtime.sourceOperation(getSession,id,'delete-preview',input);
      if(preview)return eligibility;
      if(owner(await getSession())!==employee)C.fail('IMPORT_FORBIDDEN',403);
      if(job?.blob)await store.remove(job.blob.name);
      if(job){await store.remove(job.id);jobs.delete(id);}
      return await runtime.sourceOperation(getSession,id,'delete',input);
    }finally{admitting=false;}
  }
  async function execute(job){
    current=job.id;controller=new AbortController();
    const getSession=async()=>{if(job.expires<=now())C.fail('IMPORT_JOB_EXPIRED',409);const session=await resolvePrincipal(job.owner);if(owner(session,job.operation==='apply')!==job.owner)C.fail('IMPORT_FORBIDDEN',403);return session;};
    let buffer;
    try{
      await getSession();lifecycle.assertAvailable();
      job.status=job.phase;job.error=null;await store.save(job);
      if(job.phase==='reading'){
        if(!job.blob)C.fail('IMPORT_JOB_FILE_INVALID');
        buffer=await store.decrypt(job.blob,controller.signal);
        const result=await runtime.upload(getSession,{buffer,kind:job.kind,password:job.password,signal:controller.signal});
        if(!result.complete||result.id!==job.id)C.fail('IMPORT_SOURCE_INCOMPLETE');
        job.phase='reviewing';if(job.status!=='paused')job.status='reviewing';job.password='';
        // Retain the file reference until unlink succeeds. On restart a fully
        // read source needs only cleanup, never another read of the Access DB.
        await store.save(job);
      }
      if(job.phase==='reviewing'&&job.blob){await store.remove(job.blob.name);job.blob=null;await store.save(job);}
      const applying=job.operation==='apply',dating=job.operation==='content-date';
      const complete=source=>source.complete&&(dating?source.contentDate?.status==='complete':applying?source.status==='applied'&&!source.catalogUpdatePending:['ready','needs_review','applied'].includes(source.status));
      let source=null;
      while(!stopped&&!controller.signal.aborted&&job.status!=='paused'){
        lifecycle.assertAvailable();
        source??=await runtime.sourceOperation(getSession,job.id,'read');
        if(complete(source)){
          job.status='completed';job.password='';await store.save(job);await store.remove(job.id);jobs.delete(job.id);return;
        }
        // Optional metadata backfills yield at a saved page when actual import
        // work arrives; they must not delay a newly requested data update.
        if(dating&&[...jobs.values()].some(other=>other.id!==job.id&&other.operation!=='content-date'&&ACTIVE.has(other.status)&&other.nextAt<=now()))break;
        if(!source.complete||!dating&&!(applying?['ready','needs_review','applying','applied']:['reviewing']).includes(source.status))C.fail('IMPORT_STATE_CONFLICT',409);
        const result=await runtime.sourceOperation(getSession,job.id,dating?'content-date':applying?'apply':'review',{expectedRevision:source.revision});
        // The next operation rechecks rights and the expected revision. Reuse
        // its acknowledged progress, but reread the durable terminal state.
        // A retry/restart always begins with a fresh read as well.
        source=complete(result)?null:result;
        if(job.retries){job.retries=0;await store.save(job);}
        // Yield between bounded review transactions for ordinary GP requests.
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      if(job.status!=='paused'){job.status='queued';job.nextAt=now();}await store.save(job);
    }catch(error){
      const code=codeOf(error);job.error=code;
      if(job.status==='paused'){/* An explicit pause wins over the worker's abort. */}
      else if(stopped||code==='IMPORT_MAINTENANCE'){job.status='queued';job.nextAt=now()+2000;}
      else if(RETRYABLE.has(code)&&job.retries<retryDelays.length){job.status='retrying';job.nextAt=now()+retryDelays[job.retries++];}
      else job.status='failed';
      await store.save(job);onError(code);
    }finally{if(buffer?.length)buffer.fill(0);job.password=job.phase==='reviewing'?'':job.password;current=null;controller=null;}
  }
  function tick(){
    if(stopped||pending||admitting||uploadHeld)return pending||Promise.resolve();
    pending=(async()=>{await init();await cleanExpired();
      // Admission or shutdown may have arrived while the spool was opening.
      if(stopped||admitting||uploadHeld)return;
      const job=[...jobs.values()].filter(j=>ACTIVE.has(j.status)&&j.nextAt<=now()).sort((a,b)=>Number(a.operation==='content-date')-Number(b.operation==='content-date')||a.nextAt-b.nextAt||a.created-b.created)[0];
      if(job)await execute(job);
    })().catch(e=>{try{onError(codeOf(e));}catch{}}).finally(()=>{pending=null;});return pending;
  }
  function start(){if(timer||stopped)return;timer=setInterval(()=>{void tick();},2000);timer.unref();void tick();}
  async function stop(){stopped=true;clearInterval(timer);controller?.abort();await pending;}
  return {enqueue,enqueueApply,enqueueContentDate,deleteUpload,deleteSource,assertIdle,overlay,action,tick,start,stop,beginUpload};
}
module.exports={createDataImportJobs,RETRY_DELAYS,RETRYABLE};
