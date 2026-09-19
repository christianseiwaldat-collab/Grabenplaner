'use strict';
const crypto=require('node:crypto');
const {Pool}=require('pg');
const {createPersistenceProviderFacade,PersistenceError,PERSISTENCE_ERROR_CODES}=require('../../contract');
const {POSTGRESQL_CAPABILITIES,mapPostgresqlError}=require('../provider');
const {configuration,verifyEnvironment,PROFILE}=require('../core/environment');
const {openCoreDevelopmentApplication}=require('../core/application');
const {openSalesDevelopmentApplication}=require('../sales/application');
const {sourceEntries}=require('../core/catalog');
const {salesSourceEntries}=require('../sales/catalog');
const {B,CORE_BOUNDARY_CATALOG,SALES_BOUNDARY_CATALOG}=require('./catalog');
const {IMPORT_MASTER_STATEMENTS:S}=require('../../statements/import-master-data');
const {PERSONAL_ACTION_LOG_STATEMENTS:PA}=require('../../statements/personal-action-log');
const receipts=require('./personal-actions');
const salesAudit=require('../../statements/sales-article-catalog').SALES_ARTICLE_CATALOG_STATEMENTS;
const HISTORY_HOLDS=require('../../statements/trade-insights').HISTORY_HOLDS;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure=(code,message=code)=>Object.assign(new Error(message),{code});
const ABORT=failure('BOUNDARY_ROLLBACK');
async function held(provider,options){
  let ready,failed,finish,cancel;
  const started=new Promise((resolve,reject)=>{ready=resolve;failed=reject;});
  const end=new Promise((resolve,reject)=>{finish=resolve;cancel=reject;});end.catch(()=>{});
  const done=provider.transaction(async tx=>{ready(tx);await end;},options);done.catch(failed);
  const tx=await started;
  return {tx,async end(commit){commit?finish():cancel(ABORT);try{await done;}catch(e){if(e!==ABORT)throw e;}}};
}
async function openTwoDatabaseDevelopmentApplication({coreUrl,salesUrl,stage=7,authorize,autoDeliver=false,onInitializationPhase,...options}){
  if(typeof authorize!=='function'||stage<7)throw new TypeError('Fresh authorization and boundary stage required');
  const settings={profile:PROFILE,tlsMode:'disable-local-only',...options};
  let core,sales;const locks=new Pool({...configuration({...settings,databaseUrl:coreUrl}),max:1});
  const lockClients=new WeakSet(),lockErrors=new WeakMap();locks.on('error',()=>{});
  const phase=value=>{try{onInitializationPhase?.(value);}catch{/* Diagnostics must not change database initialization. */}};
  try{
    phase('core-database');core=await openCoreDevelopmentApplication({...settings,databaseUrl:coreUrl,boundary:true});
    phase('sales-database');sales=await openSalesDevelopmentApplication({...settings,databaseUrl:salesUrl,stage});
  }
  catch(e){await core?.close();await locks.end();throw e;}
  phase('database-routing');
  const owners=new Map();
  // Both providers already compiled and qualified their catalogs above. Routing
  // needs only the source statement IDs, not a second SQL compilation per worker.
  for(const [domain,entries] of [['core',[...sourceEntries(),...CORE_BOUNDARY_CATALOG]],['sales',[...salesSourceEntries(stage),...SALES_BOUNDARY_CATALOG,...receipts.CATALOG,...(stage>=8?require('../reporting/catalog').REPORTING_BOUNDARY_CATALOG:[])]]])for(const e of entries){
    if(domain==='core'&&e.statement.id==='sales-article-catalog.audit.insert')continue;
    if(owners.has(e.statement.id)){await sales.close();await core.close();await locks.end();throw new Error('Ambiguous database owner '+e.statement.id);}owners.set(e.statement.id,domain);
  }
  if(stage>=8)for(const entry of require('../reporting/branch-article-catalog').BRANCH_ARTICLE_CATALOG)owners.set(entry.statement.id,'sales');
  if(stage>=8)for(const entry of require('../sales/import-recheck-catalog').IMPORT_RECHECK_CATALOG)owners.set(entry.statement.id,'sales');
  if(stage>=8)for(const entry of require('../sales/cash-publication-batches').CASH_PUBLICATION_BATCH_CATALOG)owners.set(entry.statement.id,'sales');
  if(stage>=8)for(const entry of require('../sales/import-batches').IMPORT_BATCH_CATALOG)owners.set(entry.statement.id,'sales');
  if(stage>=8)for(const entry of require('../sales/import-reader-batches').IMPORT_READER_BATCH_CATALOG)owners.set(entry.statement.id,'sales');
  if(stage>=8)for(const entry of require('../core/import-reader-batches').CORE_IMPORT_READER_BATCH_CATALOG)owners.set(entry.statement.id,'core');
  for(const entry of require('../core/trade-annotations').CATALOG)owners.set(entry.statement.id,'core');
  for(const entry of require('../core/personnel-learning-runs').CATALOG)owners.set(entry.statement.id,'core');
  for(const entry of require('../core/xoffi-snapshots').CATALOG)owners.set(entry.statement.id,'core');
  async function lock(){
    let client;
    try { client=await locks.connect(); }
    catch (error) { throw mapPostgresqlError(error,{operation:'boundary-lock',fallbackCode:PERSISTENCE_ERROR_CODES.CONNECTION_UNAVAILABLE}); }
    if(!lockClients.has(client)){lockClients.add(client);client.on('error',e=>lockErrors.set(client,e));}
    try{await verifyEnvironment(client,{purpose:settings.purpose||'app',binding:settings.binding});await client.query('SELECT pg_advisory_lock(9261207)');}
    catch(e){client.release(true);throw mapPostgresqlError(e,{operation:'boundary-lock'});}
    const check=()=>{if(lockErrors.has(client))throw mapPostgresqlError(lockErrors.get(client),{operation:'transaction'});};
    const release=async()=>{try{check();await client.query('SELECT pg_advisory_unlock(9261207)');client.release();}catch(e){client.release(true);throw e;}};
    release.check=check;return release;
  }
  let deliveryNeeded=autoDeliver&&settings.purpose!=='reader',delivery;
  async function drain(){
    if(!deliveryNeeded)return;
    if(!delivery)delivery=(async()=>{let result;do{result=await deliverAudits({limit:100});}while(result.delivered===100);deliveryNeeded=false;})().finally(()=>{delivery=null;});
    await delivery;
  }
  async function begin(options){
    await drain();
    let unlock,domains={},writer=null,finished=false,committedSales=false;const touched=new Set(),pendingDomains={},pendingReceipts=new Map();
    try{
      if(!options.readOnly)unlock=await lock();
    }catch(e){await domains.core?.end(false);await unlock?.();throw e;}
    async function domainTx(domain){
      pendingDomains[domain]||=held((domain==='core'?core:sales).provider,options).then(value=>(domains[domain]=value));
      return (await pendingDomains[domain]).tx;
    }
    async function own(statement,write=false){
      const domain=owners.get(statement.id);if(!domain)throw failure('BOUNDARY_STATEMENT_UNKNOWN');
      touched.add(statement.id);
      if(write){if(writer&&writer!==domain)throw new PersistenceError(PERSISTENCE_ERROR_CODES.TRANSACTION_STATE_INVALID,{operation:'transaction'});writer=domain;}
      return domainTx(domain);
    }
    async function query(statement,parameters){
      if(statement===PA.getOwn&&pendingReceipts.has(parameters.id)){
        const receipt=pendingReceipts.get(parameters.id);touched.add(statement.id);
        return receipt.actorId===parameters.actorId?[receipt]:[];
      }
      if(statement===S.dependencies){
        const [salesTx,coreTx]=await Promise.all([domainTx('sales'),domainTx('core')]);
        const [local,remote,history]=await Promise.all([salesTx.queryOne(statement,parameters),coreTx.queryOne(B.masterDependents,{id:parameters.id}),
          stage>=8?salesTx.queryOne(HISTORY_HOLDS.count,{recordId:parameters.id}):{count:0}]);
        touched.add(statement.id);return [{count:local.count+remote.count+history.count}];
      }
      if(stage>=8&&[S.holdCount,S.crmDependents].includes(statement)){
        const [salesTx,coreTx]=await Promise.all([domainTx('sales'),domainTx('core')]);
        const [local,history]=await Promise.all([coreTx.queryOne(statement,parameters),salesTx.queryOne(HISTORY_HOLDS.count,{recordId:parameters.recordId})]);
        touched.add(statement.id);return [{count:local.count+history.count}];
      }
      if(statement===S.listMappings&&parameters.status!=='all'){
        await domainTx('sales');await domainTx('core');
        touched.add(statement.id);let after=parameters.after;const result=[];
        while(result.length<parameters.limit){
          const rows=await domains.sales.tx.queryAll(statement,{...parameters,status:'all',after,limit:Math.min(200,parameters.limit)});
          if(!rows.length)break;
          for(const row of rows){after=row.id;const bound=Boolean(await domains.core.tx.queryOne(S.getBinding,{recordId:row.id}));if(bound===(parameters.status==='linked'))result.push(row);if(result.length===parameters.limit)break;}
          if(rows.length<Math.min(200,parameters.limit))break;
        }
        return result;
      }
      const tx=await own(statement);
      if(statement.operation==='queryOne'){const row=await tx.queryOne(statement,parameters);return row?[row]:[];}
      return tx.queryAll(statement,parameters);
    }
    async function sourceReference(recordId){
      await domainTx('sales');await domainTx('core');
      const row=await domains.sales.tx.queryOne(B.sourceHeader,{id:recordId});if(!row)throw failure('BOUNDARY_SOURCE_MISSING');
      const value={id:recordId,revision:Number(row.data.revision),sha:digest(row.data)};
      await domains.core.tx.execute(B.sourceReference,value);await domains.core.tx.execute(B.sourceVersion,value);
      if((await domains.core.tx.queryOne(B.getSourceVersion,{id:recordId,revision:value.revision}))?.sha!==value.sha)throw failure('BOUNDARY_SOURCE_DRIFT');
    }
    async function articleReference(id,revision){
      await domainTx('sales');await domainTx('core');
      const row=await domains.sales.tx.queryOne(B.articleRevision,{id,revision});if(!row)throw failure('BOUNDARY_ARTICLE_REVISION_MISSING');
      const sha=digest(row.data);await domains.core.tx.execute(B.publishArticle,{id,revision,sha,articleNumber:row.data.article_number});
      if((await domains.core.tx.queryOne(B.getArticleReference,{id,revision}))?.sha!==sha)throw failure('BOUNDARY_ARTICLE_REVISION_DRIFT');
    }
    async function execute(statement,parameters){
      if(stage>=8&&[S.insertHold,S.removeHold].includes(statement)&&parameters.consumerId.startsWith('history.')){
        // Historical references and their master rows are in Sales. The actual
        // reference is the atomic hold; all Core dependency checks include it.
        // Never start a second database writer for a redundant hold row.
        const match=/^history\.([0-9a-f-]{36})\.([1-9][0-9]*)$/.exec(parameters.consumerId);
        if(!match||!Number.isSafeInteger(Number(match[2]))||writer&&writer!=='sales')throw failure('BOUNDARY_HISTORY_HOLD_INVALID');
        const salesTx=await domainTx('sales');
        const ref=await salesTx.queryOne(HISTORY_HOLDS.reference,{recordId:parameters.recordId,historyId:match[1],revision:Number(match[2])});
        if(!ref?.count)throw failure('BOUNDARY_HISTORY_HOLD_REFERENCE_MISSING');
        if(statement===S.removeHold){
          const coreTx=await domainTx('core');
          if((await coreTx.queryOne(S.holdCount,{recordId:parameters.recordId})).count)throw failure('BOUNDARY_LEGACY_HISTORY_HOLD_REQUIRES_REVIEW');
        }
        writer='sales';touched.add(statement.id);return {rowsAffected:1,returnedRows:[]};
      }
      if(statement===PA.insert&&writer==='sales'){
        const receipt=receipts.receiptIntent(parameters);
        const audit=await domains.sales.tx.queryOne(receipts.auditById,{id:receipt.sourceAuditId});
        if(!audit||audit.data.actor!==receipt.actorId)throw failure('PG_PERSONAL_ACTION_SOURCE_AUDIT');
        await domains.sales.tx.execute(salesAudit.insertAudit,{actor:receipt.actorId,action:receipts.PERSONAL_ACTION_EVENT,entityType:'personal_action_receipt',entityId:receipt.id,detail:receipt,timestamp:receipt.createdAt});
        pendingReceipts.set(receipt.id,receipt);touched.add(statement.id);
        return {rowsAffected:1,returnedRows:[]};
      }
      const tx=await own(statement,true);
      if([S.insertBinding,S.insertEvent,S.insertHold].includes(statement))await sourceReference(parameters.recordId);
      if(statement.id==='loan-module.insert-loan-item'&&parameters.payload.productId)await articleReference(parameters.payload.productId,parameters.payload.productRevisionSnapshot);
      if(stage>=8&&statement.id.startsWith('sales-analytics.')&&parameters.locationId){
        await domainTx('core');
        const location=await domains.core.tx.queryOne(S.location,{id:parameters.locationId});if(!location)throw new PersistenceError(PERSISTENCE_ERROR_CODES.FOREIGN_KEY_VIOLATION,{operation:'reporting-location-reference'});
        await domains.sales.tx.execute(require('../reporting/catalog').publishLocation,{id:location.id,sha:digest(location)});
      }
      return tx.execute(statement,parameters);
    }
    async function end(commit){
      if(finished)return;finished=true;
      try{
        if(commit){
          unlock?.check();
          if(!await authorize({statementIds:[...touched].sort(),readOnly:options.readOnly}))throw failure('BOUNDARY_AUTHORIZATION_CHANGED');
          // Commit the read participant first. The separate coordinator lock
          // remains held until the sole writer has committed or rolled back.
          const reader=writer==='core'?'sales':'core';if(domains[reader]){await domains[reader].end(true);delete domains[reader];}
          unlock?.check();const remaining=Object.keys(domains)[0];if(remaining){await domains[remaining].end(true);delete domains[remaining];if(autoDeliver&&remaining==='sales'&&writer==='sales'){committedSales=true;deliveryNeeded=true;}}
        }
      }finally{
        try{await Promise.allSettled(Object.values(domains).map(d=>d.end(false)));}finally{await unlock?.();}
      }
      // The Sales commit is durable even if Core becomes unavailable here.
      // Keep the intent for restart and block later operations until delivery.
      if(committedSales)await drain().catch(()=>{});
    }
    return {query,execute,commit:()=>end(true),rollback:()=>end(false)};
  }
  async function single(statement,parameters,write){
    const tx=await begin({isolation:'serializable',readOnly:!write});
    try{const result=await tx[write?'execute':'query'](statement,parameters);await tx.commit();return result;}
    catch(e){await tx.rollback();throw e;}
  }
  const provider=createPersistenceProviderFacade({providerId:'postgresql',capabilities:POSTGRESQL_CAPABILITIES,
    query:(s,p)=>single(s,p,false),execute:(s,p)=>single(s,p,true),beginTransaction:begin,
    async close(){await sales.close();await core.close();await locks.end();}});
  async function deliverAudits({limit=50,afterCoreCommit}={}){
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new TypeError('Bounded audit delivery required');
    const pending=await sales.provider.queryAll(B.pendingAudits,{limit});let delivered=0;
    for(const {data} of pending){
      const unlock=await lock();
      try{
        const personal=data.action===receipts.PERSONAL_ACTION_EVENT?receipts.readReceiptIntent(data):null;
        const source=personal?await sales.provider.queryOne(receipts.auditById,{id:personal.sourceAuditId}):null;
        if(personal&&(!source||source.data.actor!==personal.actorId))throw failure('PG_PERSONAL_ACTION_SOURCE_AUDIT');
        const sha=digest(data),receipt=await core.provider.transaction(async tx=>{
          const previous=await tx.queryOne(B.getAuditReceipt,{id:data.event_id});
          if(previous){if(previous.sha!==sha)throw failure('BOUNDARY_AUDIT_DRIFT');return previous;}
          const created=await tx.execute(B.appendAudit,{actor:data.actor,action:data.action,entityType:data.entity_type,entityId:data.entity_id,detail:data.detail,timestamp:data.created_at});
          if(personal){
            const sourceReceipt=await tx.queryOne(B.getAuditReceipt,{id:source.data.event_id});
            if(!sourceReceipt)throw failure('PG_PERSONAL_ACTION_AUDIT_NOT_DELIVERED');
            await tx.execute(PA.insert,{...personal,sourceAuditId:sourceReceipt.auditId});
          }
          const auditId=created.returnedRows[0].id;await tx.execute(B.ackAudit,{id:data.event_id,sha,auditId});return {auditId,sha};
        },{isolation:'serializable'});
        await afterCoreCommit?.({eventId:data.event_id,action:data.action});
        await sales.provider.execute(B.deliveredAudit,{id:data.event_id,auditId:receipt.auditId,sha});delivered++;
      }finally{await unlock();}
    }
    return {delivered};
  }
  if(stage>=8)require('../../repositories/import-batch-support').enableImportBatches(provider,{coreReferences:true});
  return Object.freeze({provider,coreRepositories:core.repositories,deliverAudits,drain,close:()=>provider.close(),stage,productActivation:false});
}
module.exports={openTwoDatabaseDevelopmentApplication};
