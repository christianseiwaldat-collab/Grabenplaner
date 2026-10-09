'use strict';
const C = require('./data-import-contract');
const M = require('./sales-bwl-actions-model');
const {assertPersistenceAccess} = require('./persistence/contract');
const {loadManagedDataImportProtection} = require('./data-import-managed-protection');
const {A} = require('./persistence/statements/trade-annotations');
const {CRM_CUSTOMER_STATEMENTS: Audit} = require('./persistence/statements/crm-customers');
const K = {index:'sales-bwl-actions-index',item:'sales-bwl-action'};
const fail = (code,status) => C.fail('BWL_ACTIONS_'+code,status);
const integrity = () => fail('INTEGRITY',503), changed = () => fail('CHANGED',409);
const concurrent = new Set(['IMPORT_CONCURRENT_CHANGE','PERSISTENCE_RETRYABLE_TRANSACTION','PERSISTENCE_BUSY','PERSISTENCE_UNIQUE_VIOLATION']);
const protectedErrors = new Set(['IMPORT_PROTECTED_PAYLOAD_INVALID','IMPORT_PROTECTION_KEY_INVALID','IMPORT_VAULT_UNAVAILABLE','IMPORT_PROTECTION_UNAVAILABLE']);
const uuid = value => {if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))fail('INVALID',422);return value.toLowerCase();};
const publicRecord = record => {const result={...record};delete result.creationHash;return result;};
const copy = value => {try{return JSON.parse(C.canonical(value));}catch{fail('INVALID',422);}};
function createSalesBwlActionsStore({access,vault,scopeId='grabenplaner-main',loadAssignees,loadSourceHint,loadLocations,today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Vienna'}).format(new Date())}) {
  assertPersistenceAccess(access);const baseScope=C.id(scopeId);
  async function current(fresh,tx,expected){if(typeof fresh!=='function')fail('FORBIDDEN',403);const auth=M.authority(await fresh(tx));if(expected&&auth.identity!==expected.identity)fail('FORBIDDEN',403);return auth;}
  async function read(tx,p,scope,kind,key){const id=p.digest(['trade-annotation-id',scope,kind,key]),row=await tx.queryOne(A.get,{id,scopeId:scope,kind});if(!row)return {id,revision:0,value:null};try{C.integer(row.revision,1,Number.MAX_SAFE_INTEGER-1);if(row.id!==id||row.scopeId!==scope||row.kind!==kind)integrity();return {id,revision:row.revision,value:p.open(row.payload,['trade-annotation-v1',scope,kind,id,row.revision])};}catch{integrity();}}
  async function write(tx,p,scope,kind,prior,value){const row={id:prior.id,scopeId:scope,kind,revision:prior.revision+1},payload=p.seal(value,['trade-annotation-v1',scope,kind,row.id,row.revision]);const result=await tx.execute(prior.revision?A.update:A.insert,{...row,payload,...(prior.revision?{expectedRevision:prior.revision}:{})});if(result.rowsAffected!==1)changed();return row.revision;}
  function checkEnvelope(value,locationId,fields){try{C.exact(value,['schemaVersion','locationId',...fields]);if(Object.keys(value).length!==2+fields.length||value.schemaVersion!==1||value.locationId!==locationId)integrity();}catch{integrity();}}
  async function index(tx,p,scope,locationId){const prior=await read(tx,p,scope,K.index,locationId);if(!prior.revision)return {...prior,value:{schemaVersion:1,locationId,ids:[]}};checkEnvelope(prior.value,locationId,['ids']);try{const ids=prior.value.ids;if(!Array.isArray(ids)||ids.length>500||new Set(ids).size!==ids.length||ids.some(id=>uuid(id)!==id))integrity();}catch{integrity();}return prior;}
  function checkedItem(prior,locationId,id){const v=prior.value;checkEnvelope(v,locationId,['record']);const r=v.record;try{C.exact(r,['id','locationId','title','articleNumber','priority','status','dueDate','assigneeNumber','note','source','createdAt','updatedAt','createdBy','updatedBy','completedAt','creationHash']);if(Object.keys(r).length!==16||r.id!==id||r.locationId!==locationId)integrity();C.text(r.title,120);if(!r.title.trim()||r.articleNumber!==null&&(typeof r.articleNumber!=='string'||r.articleNumber.length>120)||r.note!==null&&(typeof r.note!=='string'||r.note.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(r.note)))integrity();if(!['low','normal','high'].includes(r.priority)||!['open','in_progress','done','discarded'].includes(r.status))integrity();for(const k of ['createdAt','updatedAt'])C.utc(r[k]);C.sha(r.creationHash);for(const k of ['createdBy','updatedBy'])C.text(r[k],120);if(r.dueDate!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(r.dueDate)||!Number.isFinite(Date.parse(r.dueDate))||new Date(r.dueDate).toISOString().slice(0,10)!==r.dueDate))integrity();if(r.assigneeNumber!==null)C.text(r.assigneeNumber,120);if(r.completedAt!==null)C.utc(r.completedAt);if(['done','discarded'].includes(r.status)!==(r.completedAt!==null))integrity();if(r.source!==null)M.validateSourceRecord(r.source);}catch{integrity();}return {...r,version:prior.revision};}
  async function item(tx,p,scope,locationId,id){const prior=await read(tx,p,scope,K.item,id);if(!prior.revision)integrity();checkedItem(prior,locationId,id);return prior;}
  async function validateAssignee(fresh,locationId,number,tx){if(number===null)return;if(typeof loadAssignees!=='function')fail('ASSIGNEE_INVALID',422);const candidates=await loadAssignees(fresh,locationId,tx);if(!Array.isArray(candidates)||!candidates.some(row=>row.employeeNumber===number))fail('ASSIGNEE_INVALID',422);}
  async function source(fresh,locationId,selector,tx){if(!selector)return null;if(typeof loadSourceHint!=='function')fail('SOURCE_UNAVAILABLE',503);const value=copy(await loadSourceHint(fresh,locationId,selector,tx));return M.validateSourceRecord(value);}
  async function work(fresh,operation,rawLocation,rawId,rawInput){
    const writing=['create','update'].includes(operation);let input=rawInput===undefined?undefined:copy(rawInput),id=rawId===undefined?undefined:uuid(rawId);
    if(operation==='create'){input=M.normalizeCreate(input,{today:today()});id=input.id;rawLocation=input.locationId;}
    if(operation==='update')input=M.normalizeUpdate(input,{today:today()});
    if(operation==='list'){input=M.normalizeQuery(input);rawLocation=input.locationId;}
    const auth=await current(fresh),locationId=M.assertLocation(auth,rawLocation,{write:writing}),scope=baseScope+':bwl-actions:'+locationId;
    let protection;
    try{
      protection=await loadManagedDataImportProtection({access,vault,create:writing});await current(fresh,undefined,auth);
      return await access.transaction(async tx=>{
        M.assertLocation(await current(fresh,tx,auth),locationId,{write:writing});
        if(!protection){if(operation==='list')return {rows:[],total:0,hasMore:false};fail('NOT_FOUND',404);}
        const idx=await index(tx,protection,scope,locationId),exists=id&&idx.value.ids.includes(id);
        if(operation==='list'){
          const rows=[];for(const itemId of idx.value.ids){rows.push(checkedItem(await item(tx,protection,scope,locationId,itemId),locationId,itemId));}
          const needle=(input.query||'').toLocaleLowerCase('de');let selected=rows.filter(r=>(input.status==='all'||r.status===input.status)&&(!needle||[r.title,r.articleNumber,r.note].some(v=>String(v??'').toLocaleLowerCase('de').includes(needle))));
          const sort=input.sort||'updatedAt',direction=input.direction==='asc'?1:-1;
          const value=r=>sort==='source'?r.source?.reason||'':sort==='priority'?({low:1,normal:2,high:3}[r.priority]):sort==='status'?({open:1,in_progress:2,done:3,discarded:4}[r.status]):r[sort]??'';
          selected.sort((a,b)=>String(value(a)).localeCompare(String(value(b)),'de',{numeric:true})*direction||a.id.localeCompare(b.id));
          const total=selected.length,offset=input.offset||0,limit=input.limit||50;selected=selected.slice(offset,offset+limit);await current(fresh,tx,auth);return {rows:selected.map(publicRecord),total,hasMore:offset+selected.length<total};
        }
        if(operation!=='create'&&!exists)fail('NOT_FOUND',404);
        let prior=exists?await item(tx,protection,scope,locationId,id):await read(tx,protection,scope,K.item,id);
        if(!exists&&prior.revision)integrity();
        if(operation==='get'){await current(fresh,tx,auth);return publicRecord(checkedItem(prior,locationId,id));}
        const creationHash=operation==='create'?C.fingerprint(input):prior.value.record.creationHash;
        if(operation==='create'&&exists){if(prior.value.record.creationHash!==creationHash)changed();await current(fresh,tx,auth);return publicRecord(checkedItem(prior,locationId,id));}
        if(operation==='create'&&idx.value.ids.length>=500)fail('LIMIT',413);
        if(operation==='update'&&input.version!==prior.revision)changed();
        if(loadLocations&&!(await loadLocations(fresh,tx)).some(l=>l.id===locationId))fail('LOCATION_INACTIVE',422);
        const assigneeNumber=operation==='create'?input.assigneeNumber:(Object.hasOwn(input,'assigneeNumber')?input.assigneeNumber:prior.value.record.assigneeNumber);
        await validateAssignee(fresh,locationId,assigneeNumber,tx);
        const hint=operation==='create'?await source(fresh,locationId,input.sourceHint,tx):prior.value.record.source;
        await current(fresh,tx,auth);const timestamp=new Date().toISOString();let record;
        if(operation==='create')record={id,locationId,title:input.title,articleNumber:hint?.articleNumber||input.articleNumber,priority:input.priority,status:'open',dueDate:input.dueDate,assigneeNumber:input.assigneeNumber,note:input.note,source:hint,createdAt:timestamp,updatedAt:timestamp,createdBy:auth.ownerId,updatedBy:auth.ownerId,completedAt:null,creationHash};
        else {const priorRecord=prior.value.record;record={...priorRecord,...M.transition(priorRecord,input),updatedAt:timestamp,updatedBy:auth.ownerId,completedAt:['done','discarded'].includes(input.status??priorRecord.status)?priorRecord.completedAt||timestamp:null};}
        const envelope={schemaVersion:1,locationId,record};checkedItem({value:envelope,revision:prior.revision+1},locationId,id);
        const version=await write(tx,protection,scope,K.item,prior,envelope);
        if(operation==='create'){idx.value.ids.push(id);await write(tx,protection,scope,K.index,idx,idx.value);}
        const audit=await tx.execute(Audit.insertAudit,{actor:auth.ownerId,action:'trade.sales-bwl-action.'+operation,entityType:'trade_annotation',entityId:prior.id,detail:JSON.stringify({revision:version,status:record.status}),timestamp});if(audit.rowsAffected!==1)integrity();
        await validateAssignee(fresh,locationId,assigneeNumber,tx);
        if(operation==='create'&&hint&&!C.equal(hint,await source(fresh,locationId,input.sourceHint,tx)))fail('SOURCE_CHANGED',409);
        if(loadLocations&&!(await loadLocations(fresh,tx)).some(l=>l.id===locationId))fail('LOCATION_INACTIVE',422);
        await current(fresh,tx,auth);return publicRecord({...record,version});
      },{isolation:'serializable',readOnly:!writing});
    }catch(error){if(concurrent.has(error.code))changed();if(protectedErrors.has(error.code))integrity();throw error;}finally{protection?.destroy();}
  }
  return Object.freeze({list:(fresh,query)=>work(fresh,'list',undefined,undefined,query),get:(fresh,locationId,id)=>work(fresh,'get',locationId,id),create:(fresh,input)=>work(fresh,'create',undefined,undefined,input),update:(fresh,locationId,id,input)=>work(fresh,'update',locationId,id,input)});
}
module.exports={createSalesBwlActionsStore};
