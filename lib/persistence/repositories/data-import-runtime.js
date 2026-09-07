"use strict";
const crypto = require('node:crypto');
const C = require('../../data-import-contract');
const { assertPersistenceAccess } = require('../contract');
const { DATA_IMPORT_RUNTIME_STATEMENTS: S } = require('../statements/data-import-runtime');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const { buildDataImportProjection } = require('../../data-import-access');
const { createDataImportRepository } = require('./data-import');
const { createDataImportEngine } = require('../../data-import-engine');
const { createImportMasterWriters } = require('./import-master-data');
const { createImportHistoryWriters } = require('./import-history');
const { definitions, assertSourceBytes } = require('../../tradefoto-full-import-source');
const { streamTradeFotoFullSource } = require('../../tradefoto-full-import-reader');
const { TRADEFOTO_SOURCE_TOLERANCES } = require('../../tradefoto-source-tolerances');
const { createCashSnapshotStore, CASH_SNAPSHOT_FORMAT } = require('./cash-snapshots');
const PROFILES = [...definitions('trade'), ...definitions('cash')].map(d=>d.profile);
const sourceContext = row => ['source',row.scopeId,row.ownerId,row.id,row.revision];
const safeCode = e => e instanceof C.DataImportError && /^IMPORT_[A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'IMPORT_OPERATION_FAILED';
const emptyRun = table => ({name:table.name,profileHash:table.profileHash,declaredRows:table.declaredRows,run:null});

// One bounded reader per app process. Database revisions remain authoritative
// across restarts. The HTTP composition never accepts profiles, writers or gates.
function createDataImportRuntime({access,vault,scopeId='grabenplaner-main',allowApply=false,sharedPayloads=false,compactCash=false,
  sourceTolerances=TRADEFOTO_SOURCE_TOLERANCES,readSource=streamTradeFotoFullSource,clock=()=>new Date().toISOString()}) {
  assertPersistenceAccess(access); C.id(scopeId);
  if(typeof sharedPayloads!=='boolean'||typeof compactCash!=='boolean') C.fail('IMPORT_COMPOSITION_INVALID');
  const repository=createDataImportRepository(access), busy=new Map();
  const now=()=>C.utc(clock());
  const actorOf=session=>({scopeId,ownerId:C.id(String(session.employeeNumber))});
  async function withContext(getSession,action,create,work) {
    let session=await getSession(), actor=actorOf(session || {});
    async function check(nextAction=action) {
      session=await getSession();
      if(!session || !C.equal(actorOf(session),actor) || !buildDataImportProjection(session)[nextAction]) C.fail('IMPORT_FORBIDDEN',403);
    }
    await check();
    const protection=await loadManagedDataImportProtection({access,vault,create,clock});
    if(!protection) return work({actor,check,protection:null});
    const authorized=({scopeId:scope,ownerId,action:operation})=> {
      if(scope!==actor.scopeId || ownerId!==actor.ownerId) return false;
      const p=buildDataImportProjection(session);
      if(operation==='apply') return allowApply===true && p.apply && p.prepare;
      if(operation==='undo') return p.undo;
      if(operation==='read') return p.read;
      if(['stage','review'].includes(operation)) return p.prepare;
      // Only internal writer dependency checks, never a raw-source HTTP view.
      return ['master.reference','history.reference','history.scope'].includes(operation) && (p.prepare || p.undo);
    };
    const engine=createDataImportEngine({repository,protection,profiles:PROFILES,sourceTolerances,sharedPayloads,getActor:()=>actor,authorize:authorized,clock,
      writers:{...createImportMasterWriters({protection}),...createImportHistoryWriters({protection,authorize:authorized,
        resolveMasterSourceInstance:()=> 'tradefoto-trade'})}});
    const cash=createCashSnapshotStore({access,protection,actor,check,sourceTolerances,clock});
    const sourceId=(kind,hash)=>protection.digest(['source',actor,kind,hash]);
    async function get(id) {
      C.sha(id);
      const row=await access.queryOne(S.source,{id,...actor});
      if(!row) C.fail('IMPORT_SOURCE_NOT_FOUND',404);
      const data=protection.open(row.payload,sourceContext(row));
      if(sourceId(data.kind,data.fileSha256)!==id) C.fail('IMPORT_SOURCE_INTEGRITY');
      return {row,data};
    }
    async function save(source) {
      const {row,data}=source, updatedAt=now();
      const payload=protection.seal(data,sourceContext({...row,revision:row.revision+1}));
      const result=await access.execute(S.updateSource,{id:row.id,...actor,revision:row.revision,updatedAt,payload});
      if(result.rowsAffected!==1) C.fail('IMPORT_CONCURRENT_CHANGE',409);
      source.row={...row,revision:row.revision+1,updatedAt,payload};
    }
    const summarize=source=> {
      const active=busy.has(source.row.id), interrupted=source.data.status==='reading'&&!active;
      return {id:source.row.id,revision:source.row.revision,createdAt:source.row.createdAt,updatedAt:source.row.updatedAt,
        ...source.data,...(interrupted?{status:'interrupted',error:'IMPORT_SOURCE_INTERRUPTED'}:{}),active,
        activationEnabled:allowApply===true&&source.data.storage!==CASH_SNAPSHOT_FORMAT};
    };
    try {return await work({actor,check,protection,engine,cash,sourceId,get,save,summarize});}
    finally {protection.destroy();}
  }
  async function exclusive(id,work) {
    if(busy.has(id)) C.fail('IMPORT_SOURCE_BUSY',409);
    busy.set(id,true);
    try{return await work();} finally{busy.delete(id);}
  }
  async function upload(getSession,{buffer,kind,password='',onStarted=()=>{}}) {
    try {
      assertSourceBytes(buffer); definitions(kind);
      if(typeof password!=='string' || Buffer.byteLength(password)>256) C.fail('IMPORT_SOURCE_PASSWORD_INVALID');
      if(busy.size) C.fail('IMPORT_SOURCE_BUSY',409);
      return await withContext(getSession,'prepare',true,async context=> {
        const {actor,protection,sourceId,get,save,summarize,engine,cash,check}=context;
        const fileSha256=crypto.createHash('sha256').update(buffer).digest('hex'), id=sourceId(kind,fileSha256), at=now();
        return exclusive(id,async()=> {
          const row={id,...actor,revision:1,createdAt:at,updatedAt:at};
          const data={kind,fileSha256,bytes:buffer.length,status:'reading',complete:false,error:'',tables:[],excludedTableNames:[],
            ...(kind==='cash'&&compactCash?{storage:CASH_SNAPSHOT_FORMAT,scope:'full'}:{})};
          await access.execute(S.insertSource,{...row,payload:protection.seal(data,sourceContext(row))});
          let source=await get(id);
          if(source.data.complete) {onStarted(summarize(source));return summarize(source);}
          source.data.status='reading'; source.data.error=''; await save(source);
          onStarted(summarize(source));
          let current=null, seenManifest=false, tableIndex=0;
          const compact=source.data.storage===CASH_SNAPSHOT_FORMAT;
          const cashProgress=result=>{source.data.tables=result.tables;source.data.verifiedRows=result.verifiedRows;};
          try {
            await readSource({buffer,kind,password,onMessage:async message=> {
              await check();
              const d=source.data;
              if(message.type==='manifest') {
                if(seenManifest || message.fileSha256!==fileSha256 || message.kind!==kind) C.fail('IMPORT_SOURCE_INTEGRITY');
                const known=definitions(kind);
                if(!C.equal(message.tables.map(t=>[t.name,t.profileHash]),known.map(t=>[t.name,t.profile.fingerprint]))) C.fail('IMPORT_PROFILE_UNAVAILABLE');
                if(d.tables.length && !C.equal(d.tables.map(t=>[t.name,t.profileHash,t.declaredRows]),message.tables.map(t=>[t.name,t.profileHash,t.declaredRows]))) C.fail('IMPORT_SOURCE_INTEGRITY');
                if(!d.tables.length) d.tables=message.tables.map(emptyRun);
                if(compact) cashProgress(await cash.begin(id,message));
                d.excludedTableNames=message.excludedTableNames; seenManifest=true;
              } else if(message.type==='table') {
                if(!seenManifest || current || d.tables[tableIndex]?.name!==message.name) C.fail('IMPORT_SOURCE_PROTOCOL_INVALID');
                current=d.tables[tableIndex];
                if(compact) {
                  cashProgress(await cash.startTable(id,message.name,message.expectedRows));current=d.tables[tableIndex];
                } else {
                const profile=PROFILES.find(p=>p.fingerprint===current.profileHash);
                const run=await engine.start({profileHash:current.profileHash,existingRunId:current.run?.id,manifest:{sourceInstance:`tradefoto-${kind}`,fileSha256,
                  schemaSha256:profile.schemaSha256,expectedRows:message.expectedRows,declaredRows:current.declaredRows,
                  snapshotAt:source.row.createdAt,gates:[]}});
                if(current.run && current.run.id!==run.id) C.fail('IMPORT_SOURCE_INTEGRITY');
                current.run=run;
                }
              } else if(message.type==='rows') {
                if(!current || current.name!==message.name) C.fail('IMPORT_SOURCE_PROTOCOL_INVALID');
                if(compact) {cashProgress(await cash.append(id,message.name,message.startRow,message.rows));current=d.tables[tableIndex];}
                else current.run=await engine.stage(current.run.id,{expectedRevision:current.run.revision,startRow:message.startRow,rows:message.rows});
              } else if(message.type==='table-complete') {
                if(!current || current.name!==message.name || current.run.receivedRows!==current.run.expectedRows) C.fail('IMPORT_SOURCE_INCOMPLETE');
                if(compact) cashProgress(await cash.finishTable(id,message.name));
                else if(current.run.status==='staging') current.run=await engine.seal(current.run.id,current.run.revision);
                current=null;tableIndex++;
              } else if(message.type==='complete') {
                if(!seenManifest || current || tableIndex!==d.tables.length || message.tables!==tableIndex
                  || message.rows!==d.tables.reduce((n,t)=>n+t.run.receivedRows,0)) C.fail('IMPORT_SOURCE_INCOMPLETE');
                d.complete=true;d.status='reviewing';
                if(compact) {const result=await cash.seal(id,message);cashProgress(result);d.status=result.status;}
              } else C.fail('IMPORT_SOURCE_PROTOCOL_INVALID');
              await save(source);
            }});
            if(!source.data.complete) C.fail('IMPORT_SOURCE_INCOMPLETE');
          } catch(error) {
            // Source may be resumed only by supplying exactly the same bytes.
            source.data.complete=false;source.data.status='interrupted';source.data.error=safeCode(error);await save(source);throw error;
          }
          return summarize(source);
        });
      });
    } finally {if(Buffer.isBuffer(buffer)) buffer.fill(0); password='';}
  }
  async function sourceOperation(getSession,id,action,input={}) {
    C.exact(input,['expectedRevision','runId','after','beforeRow','limit']);
    return withContext(getSession,action==='apply'?'apply':action==='undo'||action==='undo-preview'?'undo':action==='review'?'prepare':'read',false,async context=> {
      const {protection,get,save,summarize,engine,cash,check}=context;
      if(!protection) C.fail('IMPORT_SOURCE_NOT_FOUND',404);
      const execute=async()=> {
        const source=await get(id), d=source.data;
        if(action==='read') return summarize(source);
        if(d.storage===CASH_SNAPSHOT_FORMAT) {
          if(action==='rows') {
            const table=d.tables.find(t=>t.run?.id===input.runId);
            if(!table) C.fail('IMPORT_RUN_NOT_FOUND',404);
            return cash.preview(id,table.name,{after:input.after??0,limit:input.limit??50});
          }
          if(action==='apply') C.fail('IMPORT_NOT_ACTIVATED',409);
          if(action!=='review') C.fail('IMPORT_ACTION_INVALID');
          C.integer(input.expectedRevision,1,Number.MAX_SAFE_INTEGER);
          if(input.expectedRevision!==source.row.revision) C.fail('IMPORT_REVISION_CONFLICT',409);
          if(!d.complete) C.fail('IMPORT_SOURCE_INCOMPLETE',409);
          const result=await cash.review(id);
          d.tables=result.tables;d.status=result.status;d.verifiedRows=result.verifiedRows;d.error='';
          await check();await save(source);return summarize(source);
        }
        if(['events','rows','undo-preview'].includes(action)) {
          const table=d.tables.find(t=>t.run?.id===input.runId);
          if(!table) C.fail('IMPORT_RUN_NOT_FOUND',404);
          if(action==='events') return engine.events(table.run.id,{after:input.after??0,limit:input.limit??50});
          if(action==='rows') return engine.preview(table.run.id,{after:input.after??0,limit:input.limit??50});
          return engine.undoPreview(table.run.id,{beforeRow:input.beforeRow??C.LIMITS.rows+1,limit:input.limit??100});
        }
        C.integer(input.expectedRevision,1,Number.MAX_SAFE_INTEGER);
        if(input.expectedRevision!==source.row.revision) C.fail('IMPORT_REVISION_CONFLICT',409);
        if(!d.complete) C.fail('IMPORT_SOURCE_INCOMPLETE',409);
        if(action==='apply' && allowApply!==true) C.fail('IMPORT_NOT_ACTIVATED',409);
        // Refresh only the table being advanced. Recounting every large source
        // table on each 200-row step would turn a full import quadratic.
        const refreshTable=async t=>{
          const checkpoint=await engine.checkpoint(t.run.id);
          // Recount after a lost checkpoint, not on every unchanged 200-row step.
          t.run=checkpoint.revision===t.run.revision?{...t.run,...checkpoint}:await engine.preview(t.run.id,{limit:1}).then(({rows,...run})=>run);
        };
        await check();
        let table;
        if(action==='review') {
          if(d.tables.some(t=>['applying','applied','reverting','reverted'].includes(t.run.status))) C.fail('IMPORT_STATE_CONFLICT',409);
          for(table of d.tables.filter(t=>t.run.status==='reviewing')) {
            await refreshTable(table);
            if(table.run.status==='reviewing') {table.run=await engine.review(table.run.id,table.run.revision);break;}
          }
          d.status=d.tables.some(t=>t.run.status==='reviewing')?'reviewing':d.tables.some(t=>t.run.status==='needs_review')?'needs_review':'ready';
        } else if(action==='apply') {
          if(d.tables.some(t=>t.run.gates.length || t.run.counts.invalid || !['ready','needs_review','applied','applying','reviewing'].includes(t.run.status))) C.fail('IMPORT_DECISION_GATE',409);
          table=d.tables.find(t=>t.run.status!=='applied');
          while(table) {
            await refreshTable(table);
            if(table.run.status!=='applied')break;
            table=d.tables.find(t=>t.run.status!=='applied');
          }
          if(table) {
            if(['ready','needs_review'].includes(table.run.status) && d.recheckedRun!==table.run.id) {
              table.run=await engine.recheck(table.run.id,table.run.revision); d.recheckedRun=table.run.id;
            } else if(table.run.status==='reviewing') table.run=await engine.review(table.run.id,table.run.revision);
            else table.run=await engine.apply(table.run.id,table.run.revision);
          }
          d.status=d.tables.every(t=>t.run.status==='applied')?'applied':'applying';
        } else if(action==='undo') {
          const candidates=[...d.tables].reverse().filter(t=>['applied','applying','reverting'].includes(t.run.status));
          let dependencyError;
          for(table of candidates) {
            await refreshTable(table);
            if(!['applied','applying','reverting'].includes(table.run.status)) continue;
            try {table.run=await engine.undo(table.run.id,table.run.revision);dependencyError=null;break;}
            catch(error) {if(error.code!=='IMPORT_UNDO_DEPENDENCIES') throw error;dependencyError=error;}
          }
          if(dependencyError) throw dependencyError;
          if(!candidates.length) C.fail('IMPORT_STATE_CONFLICT',409);
          d.status=d.tables.some(t=>['applied','applying','reverting'].includes(t.run.status))?'reverting':'reverted';
        } else C.fail('IMPORT_ACTION_INVALID');
        d.error='';await save(source);return summarize(source);
      };
      return ['read','events','rows','undo-preview'].includes(action)?execute():exclusive(id,execute);
    });
  }
  return Object.freeze({
    async context(getSession) {
      const session=await getSession(), projection=buildDataImportProjection(session);
      if(!projection.read) C.fail('IMPORT_FORBIDDEN',403);
      let available=false;
      try {const protection=await loadManagedDataImportProtection({access,vault,clock});protection?.destroy();available=true;}
      catch { /* Missing or mismatched vault stays a closed, non-mutating gate. */ }
      return {available,projection,activationEnabled:allowApply===true,maxBytes:512*1024*1024,
        message:!available?'Geschützte Schlüsselverwaltung nicht verfügbar. Es werden keine Quelldaten angenommen.':'Geschützte Vorschau verfügbar. Die produktive Übernahme benötigt eine gesonderte technische Freigabe.'};
    },
    async list(getSession,input={}) {
      C.exact(input,['beforeAt','beforeId','limit']);
      const beforeAt=C.utc(input.beforeAt??'9999-12-31T23:59:59.999Z'),beforeId=C.sha(input.beforeId??'f'.repeat(64)),limit=C.integer(input.limit??20,1,50);
      return withContext(getSession,'read',false,async c=> {
        if(!c.protection) return {items:[],next:null};
        const rows=await access.queryAll(S.sources,{...c.actor,beforeAt,beforeId,limit});
        const items=[];for(const row of rows) items.push(c.summarize(await c.get(row.id)));
        const last=rows.at(-1);return {items,next:rows.length===limit?{beforeAt:last.createdAt,beforeId:last.id}:null};
      });
    },upload,sourceOperation,
  });
}
module.exports={createDataImportRuntime};
