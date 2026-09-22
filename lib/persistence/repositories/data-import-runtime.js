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
const contentDates = require('../../data-import-content-date');
const {buildSalesArticleCatalogProjection}=require('../../sales-article-catalog-access');
const PROFILES = ['trade','cash','bestell'].flatMap(kind=>definitions(kind)).map(d=>d.profile);
const sourceContext = row => ['source',row.scopeId,row.ownerId,row.id,row.revision];
const safeCode = e => e instanceof C.DataImportError && /^IMPORT_[A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'IMPORT_OPERATION_FAILED';
const emptyRun = table => ({name:table.name,profileHash:table.profileHash,declaredRows:table.declaredRows,run:null});
const {createDataImportLifecycle}=require('../../data-import-lifecycle');
const {importFileName}=require('../../data-import-file-name');

// One bounded reader per app process. Database revisions remain authoritative
// across restarts. The HTTP composition never accepts profiles, writers or gates.
function createDataImportRuntime({access,vault,scopeId='grabenplaner-main',allowApply=false,sharedPayloads=false,compactCash=false,syncArticleCatalog=false,
  sourceTolerances=TRADEFOTO_SOURCE_TOLERANCES,readSource=streamTradeFotoFullSource,clock=()=>new Date().toISOString(),lifecycle=createDataImportLifecycle()}) {
  assertPersistenceAccess(access); C.id(scopeId);
  if(typeof sharedPayloads!=='boolean'||typeof compactCash!=='boolean'||typeof syncArticleCatalog!=='boolean') C.fail('IMPORT_COMPOSITION_INVALID');
  const articleSync=syncArticleCatalog?require('../../data-import-article-sync').createDataImportArticleSync():null;
  const repository=createDataImportRepository(access), busy=new Map();
  const operationBatchSize=C.LIMITS.batch,stageBatchSize=access.getCapabilities?.().providerId==='postgresql'&&!require('./import-batch-support').supportsImportBatches(access)?25:C.LIMITS.batch;
  const now=()=>C.utc(clock());
  const actorOf=session=>({scopeId,ownerId:C.id(String(session.employeeNumber))});
  async function withContext(getSession,action,create,work) {
    let session=await getSession(), actor=actorOf(session || {});
    async function check(nextAction=action) {
      session=await getSession();
      if(!session || !C.equal(actorOf(session),actor) || !buildDataImportProjection(session)[nextAction]) C.fail('IMPORT_FORBIDDEN',403);
    }
    await check();
    const checkCatalog=async(permission='apply')=>{await check(permission);if(!buildSalesArticleCatalogProjection(session).import)C.fail('IMPORT_ARTICLE_CATALOG_FORBIDDEN',403);};
    const protection=await loadManagedDataImportProtection({access,vault,create,clock});
    if(!protection) return work({actor,check,protection:null});
    const authorized=({scopeId:scope,ownerId,action:operation})=> {
      if(scope!==actor.scopeId || ownerId!==actor.ownerId) return false;
      const p=buildDataImportProjection(session);
      if(operation==='apply') return allowApply===true && p.apply && p.prepare;
      if(operation==='undo') return p.undo;
      if(operation==='read') return p.read;
      if(operation==='catalog.read') return p.prepare&&p.apply&&buildSalesArticleCatalogProjection(session).import;
      if(['stage','review'].includes(operation)) return p.prepare;
      // Only internal writer dependency checks, never a raw-source HTTP view.
      return ['master.reference','history.reference','history.scope'].includes(operation) && (p.prepare || p.undo);
    };
    const engine=createDataImportEngine({repository,protection,profiles:PROFILES,sourceTolerances,sharedPayloads,operationBatchSize,
      operationBudgetMs:access.getCapabilities?.().providerId==='postgresql'?750:Infinity,getActor:()=>actor,authorize:authorized,clock,
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
    async function save(source,executor=access) {
      const {row,data}=source, updatedAt=now();
      const payload=protection.seal(data,sourceContext({...row,revision:row.revision+1}));
      const result=await executor.execute(S.updateSource,{id:row.id,...actor,revision:row.revision,updatedAt,payload});
      if(result.rowsAffected!==1) C.fail('IMPORT_CONCURRENT_CHANGE',409);
      source.row={...row,revision:row.revision+1,updatedAt,payload};
    }
    const summarize=source=> {
      const active=busy.has(source.row.id), interrupted=source.data.status==='reading'&&!active;
      return {id:source.row.id,revision:source.row.revision,createdAt:source.row.createdAt,updatedAt:source.row.updatedAt,
        ...source.data,...(interrupted?{status:'interrupted',error:'IMPORT_SOURCE_INTERRUPTED'}:{}),active,
        ...(source.data.catalog?{catalog:Object.fromEntries(['after','changed','unchanged','blocked','total','complete','batches'].filter(k=>Object.hasOwn(source.data.catalog,k)).map(k=>[k,source.data.catalog[k]]))}:{}),
        catalogUpdatePending:!!articleSync&&source.data.kind==='trade'&&source.data.status==='applied'&&!source.data.catalog?.complete,
        activationEnabled:allowApply===true&&source.data.storage!==CASH_SNAPSHOT_FORMAT};
    };
    try {return await work({actor,check,checkCatalog,protection,engine,cash,sourceId,get,save,summarize});}
    finally {protection.destroy();}
  }
  async function exclusive(id,work) {
    if(busy.has(id)) C.fail('IMPORT_SOURCE_BUSY',409);
    busy.set(id,true);
    try{return await work();} finally{busy.delete(id);}
  }
  const interrupted=signal=>{if(signal.aborted) C.fail('IMPORT_SOURCE_INTERRUPTED',409);};
  function upload(getSession,input) {return lifecycle.run(signal=>uploadSource(getSession,{...input,signal:input.signal?AbortSignal.any([signal,input.signal]):signal}));}
  function reserve(getSession,{buffer,kind,fileName}) {return lifecycle.run(async()=>{
    assertSourceBytes(buffer);definitions(kind);
    fileName=importFileName(fileName);
    const fileSha256=crypto.createHash('sha256').update(buffer).digest('hex');
    return withContext(getSession,'prepare',true,async({actor,protection,sourceId,get,summarize})=>{
      const id=sourceId(kind,fileSha256),at=now(),row={id,...actor,revision:1,createdAt:at,updatedAt:at};
      // Only the durable job envelope can promise queued processing. A failed
      // spool admission must leave an honestly resumable source, not a phantom job.
      const data={kind,fileSha256,fileName,bytes:buffer.length,status:'interrupted',complete:false,error:'IMPORT_SOURCE_INCOMPLETE',tables:[],excludedTableNames:[],contentDate:contentDates.empty(),
        ...(kind==='cash'&&compactCash?{storage:CASH_SNAPSHOT_FORMAT,scope:'full'}:{})};
      await access.execute(S.insertSource,{...row,payload:protection.seal(data,sourceContext(row))});
      const reserved=await get(id);if(reserved.data.status==='deleting')C.fail('IMPORT_DELETE_IN_PROGRESS',409);return summarize(reserved);
    });
  });}
  async function uploadSource(getSession,{buffer,kind,fileName,password='',onStarted=()=>{},signal}) {
    try {
      interrupted(signal);
      assertSourceBytes(buffer); definitions(kind);
      fileName=importFileName(fileName);
      if(typeof password!=='string' || Buffer.byteLength(password)>256) C.fail('IMPORT_SOURCE_PASSWORD_INVALID');
      if(busy.size) C.fail('IMPORT_SOURCE_BUSY',409);
      return await withContext(getSession,'prepare',true,async context=> {
        const {actor,protection,sourceId,get,save,summarize,engine,cash,check}=context;
        const fileSha256=crypto.createHash('sha256').update(buffer).digest('hex'), id=sourceId(kind,fileSha256), at=now();
        return exclusive(id,async()=> {
          const row={id,...actor,revision:1,createdAt:at,updatedAt:at};
          const data={kind,fileSha256,fileName,bytes:buffer.length,status:'reading',complete:false,error:'',tables:[],excludedTableNames:[],contentDate:contentDates.empty(),
            ...(kind==='cash'&&compactCash?{storage:CASH_SNAPSHOT_FORMAT,scope:'full'}:{})};
          await access.execute(S.insertSource,{...row,payload:protection.seal(data,sourceContext(row))});
          let source=await get(id);
          if(source.data.status==='deleting')C.fail('IMPORT_DELETE_IN_PROGRESS',409);
          if(source.data.complete) {onStarted(summarize(source));return summarize(source);}
          source.data.contentDate??=contentDates.empty();
          source.data.status='reading'; source.data.error=''; await save(source);
          onStarted(summarize(source));
          let current=null, seenManifest=false, tableIndex=0;
          const compact=source.data.storage===CASH_SNAPSHOT_FORMAT;
          const cashProgress=result=>{source.data.tables=result.tables;source.data.verifiedRows=result.verifiedRows;};
          try {
            await readSource({buffer,kind,password,signal,consumeBuffer:true,onMessage:async message=> {
              interrupted(signal);
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
                if(current.run.receivedRows>(d.contentDate.positions?.[message.name]||0)) {d.contentDate.requiresScan=true;d.contentDate.status='pending';}
              } else if(message.type==='rows') {
                if(!current || current.name!==message.name) C.fail('IMPORT_SOURCE_PROTOCOL_INVALID');
                if(compact) {cashProgress(await cash.append(id,message.name,message.startRow,message.rows));current=d.tables[tableIndex];}
                else for(let offset=0;offset<message.rows.length;offset+=stageBatchSize) {
                  current.run=await engine.stage(current.run.id,{expectedRevision:current.run.revision,startRow:message.startRow+offset,rows:message.rows.slice(offset,offset+stageBatchSize)});
                  interrupted(signal);
                }
                if(d.contentDate?.version===contentDates.VERSION) {
                  contentDates.accumulate(d.contentDate,PROFILES.find(p=>p.fingerprint===current.profileHash),message.rows,source.row.createdAt);
                  (d.contentDate.positions??={})[message.name]=current.run.receivedRows;
                }
              } else if(message.type==='table-complete') {
                if(!current || current.name!==message.name || current.run.receivedRows!==current.run.expectedRows) C.fail('IMPORT_SOURCE_INCOMPLETE');
                if(compact) cashProgress(await cash.finishTable(id,message.name));
                else if(current.run.status==='staging') current.run=await engine.seal(current.run.id,current.run.revision);
                current=null;tableIndex++;
              } else if(message.type==='complete') {
                if(!seenManifest || current || tableIndex!==d.tables.length || message.tables!==tableIndex
                  || message.rows!==d.tables.reduce((n,t)=>n+t.run.receivedRows,0)) C.fail('IMPORT_SOURCE_INCOMPLETE');
                d.complete=true;d.status='reviewing';
                if(d.contentDate?.version===contentDates.VERSION && !d.contentDate.requiresScan) {d.contentDate.status='complete';delete d.contentDate.positions;}
                if(compact) {const result=await cash.seal(id,message);cashProgress(result);d.status=result.status;}
              } else C.fail('IMPORT_SOURCE_PROTOCOL_INVALID');
              await save(source);
              interrupted(signal);
              return message.type==='table'?{resumeAfter:current.run.receivedRows}:undefined;
            }});
            if(!source.data.complete) C.fail('IMPORT_SOURCE_INCOMPLETE');
          } catch(error) {
            // Source may be resumed only by supplying exactly the same bytes.
            source.data.complete=false;source.data.status='interrupted';source.data.error=safeCode(error);await save(source);throw error;
          }
          return summarize(source);
        });
      });
    } finally {if(Buffer.isBuffer(buffer)&&buffer.length) buffer.fill(0); password='';}
  }
  function sourceOperation(getSession,id,action,input={}) {
    const work=()=>performSourceOperation(getSession,id,action,input);
    return ['read','events','rows','undo-preview'].includes(action)?work():lifecycle.run(work);
  }
  async function performSourceOperation(getSession,id,action,input={}) {
    C.exact(input,['expectedRevision','runId','after','beforeRow','limit']);
    return withContext(getSession,action==='apply'?'apply':action==='undo'||action==='undo-preview'?'undo':['review','content-date','delete','delete-preview'].includes(action)?'prepare':'read',false,async context=> {
      const {actor,protection,get,save,summarize,engine,cash,check,checkCatalog}=context;
      if(!protection) C.fail('IMPORT_SOURCE_NOT_FOUND',404);
      const execute=async()=> {
        const source=await get(id), d=source.data;
        if(action==='read') return summarize(source);
        if(['delete','delete-preview'].includes(action)){
          C.exact(input,['expectedRevision']);C.integer(input.expectedRevision,1,Number.MAX_SAFE_INTEGER);
          if(input.expectedRevision!==source.row.revision)C.fail('IMPORT_REVISION_CONFLICT',409);
          return require('./data-import-delete').deleteSource({access,source,actor,check,save,now,preview:action==='delete-preview'});
        }
        if(d.status==='deleting')C.fail('IMPORT_DELETE_IN_PROGRESS',409);
        if(action==='content-date') {
          if(!d.complete) C.fail('IMPORT_SOURCE_INCOMPLETE',409);
          if(d.contentDate?.version===contentDates.VERSION && d.contentDate.status==='complete') return summarize(source);
          if(d.contentDate?.version!==contentDates.VERSION) d.contentDate=contentDates.empty();
          const progress=d.contentDate, candidates=d.tables.filter(t=>contentDates.fieldsFor(PROFILES.find(p=>p.fingerprint===t.profileHash)).length);
          const table=candidates[progress.tableIndex||0];
          if(table && table.run.receivedRows) {
            const options={after:progress.after||0,uploadedAt:source.row.createdAt};
            const part=d.storage===CASH_SNAPSHOT_FORMAT ? await cash.contentDate(id,table.name,options) : await engine.contentDate(table.run.id,options);
            if(!part.complete&&part.after<=options.after)C.fail('IMPORT_SOURCE_INTEGRITY',409);
            contentDates.merge(progress,part);progress.after=part.after;
            if(part.complete) {progress.tableIndex=(progress.tableIndex||0)+1;progress.after=0;}
          } else if(table) {progress.tableIndex=(progress.tableIndex||0)+1;progress.after=0;}
          if((progress.tableIndex||0)>=candidates.length) {progress.status='complete';delete progress.after;delete progress.tableIndex;delete progress.positions;delete progress.requiresScan;}
          await check();await save(source);return summarize(source);
        }
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
        if(articleSync&&d.kind==='trade'&&(action==='undo'||action==='apply'&&!d.catalog?.complete)
          &&d.tables.some(t=>t.run.expiresAt<=now()))C.fail('IMPORT_RUN_EXPIRED',409);
        if(action==='apply'&&['reverting','reverted'].includes(d.status))C.fail('IMPORT_STATE_CONFLICT',409);
        if(action==='apply'&&articleSync&&d.kind==='trade')await checkCatalog();
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
          // Apply only the supplied records. Missing records in a newer Access
          // export are not deletion authority; retained repairs keep their GP
          // history and source provenance. Removal requires an explicit undo.
          if(d.tables.some(t=>t.run.gates.length || t.run.counts.invalid || !['ready','needs_review','applied','applying','reviewing'].includes(t.run.status))) C.fail('IMPORT_DECISION_GATE',409);
          table=d.tables.find(t=>t.run.status!=='applied');
          while(table) {
            await refreshTable(table);
            if(table.run.status!=='applied')break;
            table=d.tables.find(t=>t.run.status!=='applied');
          }
          if(table) {
            if(['ready','needs_review'].includes(table.run.status) && d.recheckedRun!==table.run.id) {
              table.run=await engine.recheck(table.run.id,table.run.revision);
              if(table.run.status==='reviewing')d.recheckedRun=table.run.id;
              d.currentStep={table:table.name,phase:'rechecking'};
            } else if(table.run.status==='reviewing') {table.run=await engine.review(table.run.id,table.run.revision);d.currentStep={table:table.name,phase:'reviewing'};}
            else if(table.run.status==='needs_review') C.fail('IMPORT_DECISION_GATE',409);
            else {table.run=await engine.apply(table.run.id,table.run.revision);d.currentStep={table:table.name,phase:'applying'};}
          }
          d.status=d.tables.every(t=>t.run.status==='applied')?'applied':'applying';
          if(d.status==='applied'&&articleSync&&d.kind==='trade'&&!d.catalog?.complete) {
            if(d.catalog?.pending) {
              await checkCatalog();
              d.catalog=await access.transaction(tx=>articleSync.commit(tx,d.catalog,{ownerId:actor.ownerId,at:now()}),{isolation:'serializable'});
            } else {
              const prepared=await articleSync.prepareSource(summarize(source),async(name,after)=>{
                const table=d.tables.find(t=>t.name===name);if(!table?.run)C.fail('IMPORT_SOURCE_INCOMPLETE',409);
                return engine.articleCatalogRows(table.run.id,{after});
              },checkCatalog);
              await checkCatalog();
              d.catalog=await access.transaction(tx=>articleSync.plan(tx,{...d,id:source.row.id},prepared),{isolation:'serializable',readOnly:true});
            }
            d.status=d.catalog.complete?'applied':'applying';d.currentStep={table:'Artikelkatalog',phase:'applying'};
          }
        } else if(action==='undo') {
          if(articleSync&&(d.catalog?.pending||d.catalog?.pendingUndo||d.catalog?.batches?.some(b=>!b.reverted))) {
            await checkCatalog('undo');
            d.catalog=await access.transaction(tx=>d.catalog.pending
              ?articleSync.commit(tx,d.catalog,{ownerId:actor.ownerId,at:now()},true)
              :d.catalog.pendingUndo?articleSync.commitUndo(tx,d.catalog,{ownerId:actor.ownerId,at:now()}):articleSync.planUndo(tx,d.catalog),
              {isolation:'serializable',readOnly:!d.catalog.pendingUndo});
            d.status='reverting';d.error='';await save(source);return summarize(source);
          }
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
    stop:async()=>{await lifecycle.stop();articleSync?.clear();},
    async context(getSession) {
      const session=await getSession(), projection=buildDataImportProjection(session);
      if(!projection.read) C.fail('IMPORT_FORBIDDEN',403);
      let available=false;
      try {const protection=await loadManagedDataImportProtection({access,vault,clock});protection?.destroy();available=true;}
      catch { /* Missing or mismatched vault stays a closed, non-mutating gate. */ }
      return {available,projection,activationEnabled:allowApply===true,maxBytes:512*1024*1024,
        sourceKinds:['trade','cash','bestell'],
        message:!available?'Geschützte Schlüsselverwaltung nicht verfügbar. Es werden keine Quelldaten angenommen.':allowApply===true
          ? 'Datei auswählen, vollständig prüfen und anschließend bewusst übernehmen. Der Fortschritt bleibt gespeichert.'
          : 'Geschützte Vorschau verfügbar. Die produktive Übernahme benötigt eine gesonderte technische Freigabe.'};
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
    },upload,reserve,sourceOperation,
  });
}
module.exports={createDataImportRuntime};
