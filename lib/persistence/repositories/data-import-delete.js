'use strict';
const C=require('../../data-import-contract');
const {S}=require('../sqlite/data-import-delete-catalog');
const D=require('../statements/data-import').DATA_IMPORT_STATEMENTS;
const CASH=require('../statements/cash-snapshots');
const SAFE=new Set(['staging','reviewing','needs_review','ready','cancelled','purged']);
const PROTECTED=new Set(['applying','applied','reverting','reverted']);
const BATCH=2000;
async function inspect(tx,source,actor){
 const d=source.data;
 if(PROTECTED.has(d.status)||d.catalog?.pending||d.catalog?.batches?.length)C.fail('IMPORT_DELETE_ALREADY_APPLIED',409);
 if(d.storage==='cash-compact-v1'){
  if((await tx.queryOne(S.publications,{id:source.row.id})).count)C.fail('IMPORT_DELETE_ALREADY_APPLIED',409);
  const dataset=await tx.queryOne(CASH.CASH_SNAPSHOT_STATEMENTS.get,{id:source.row.id,...actor});
  return {dataset,runs:[]};
 }
 if(!d.deletion){
  // Recover a table checkpoint lost between committing rows and saving the
  // source envelope. Only this owner's exact file and source instance qualify.
  let beforeAt='9999-12-31T23:59:59.999Z',beforeId='f'.repeat(64),scanned=0;
  while(true){
   const page=await tx.queryAll(D.listRuns,{...actor,beforeAt,beforeId,limit:100});scanned+=page.length;
   if(scanned>10000)C.fail('IMPORT_DELETE_METADATA_LIMIT',413);
   for(const run of page){
    if(run.manifest.fileSha256!==d.fileSha256||run.manifest.sourceInstance!=='tradefoto-'+d.kind)continue;
    if(!(d.tables||[]).some(t=>t.run?.id===run.id)){
     d.tables||=[];d.tables.push({name:run.profile.sourceTable,profileHash:run.profileHash,declaredRows:run.manifest.expectedRows,run:{id:run.id,receivedRows:run.receivedCount,status:run.status}});
    }
   }
   if(page.length<100)break;beforeAt=page.at(-1).createdAt;beforeId=page.at(-1).id;
  }
 }
 const runs=[];
 for(const table of d.tables||[]){
  if(table.deleted||!table.run)continue;
  const run=await tx.queryOne(D.getRun,{id:table.run.id,...actor});
  if(!run){if(d.deletion){table.deleted=true;table.run=null;continue;}C.fail('IMPORT_SOURCE_INTEGRITY',409);}
  if(!SAFE.has(run.status)||(await tx.queryOne(S.dependencies,{runId:run.id})).count)C.fail('IMPORT_DELETE_ALREADY_APPLIED',409);
  runs.push({table,run});
 }
 return {runs,dataset:null};
}
async function deleteSource({access,source,actor,check,save,now,preview=false}){
 const d=source.data;
 if(preview||!d.deletion){
  const state=await access.transaction(async tx=>{await check('prepare');return inspect(tx,source,actor);},{isolation:'serializable',readOnly:true});
  const totalRows=d.storage==='cash-compact-v1'?(d.tables||[]).reduce((n,t)=>n+(t.run?.receivedRows||0),0):state.runs.reduce((n,item)=>n+item.run.receivedCount,0);
  if(preview)return {id:source.row.id,revision:source.row.revision,canDelete:true,rows:totalRows,tableCount:d.tables?.length||0};
  // Core owns the encrypted source checkpoint, Sales owns import rows. Persist
  // the deletion intent first; never attempt a transaction with two writers.
  d.status='deleting';d.deletion={startedAt:now(),removedRows:0,totalRows};
  await check('prepare');await save(source);
  return {deleted:false,id:source.row.id,revision:source.row.revision,status:'deleting',removedRows:0};
 }
 const remains=await access.transaction(async tx=>{
  await check('prepare');
  const state=await inspect(tx,source,actor);
  let remains=false;
  if(d.storage==='cash-compact-v1'&&state.dataset){
   // Children precede their headers; foreign keys continue to protect every row.
   for(let i=CASH.CASH_SNAPSHOT_TABLES.length-1;i>=0;i--){
    const t=CASH.CASH_SNAPSHOT_TABLES[i],rows=await tx.queryAll(t.statements.page,{datasetSlot:state.dataset.slot,after:0,limit:BATCH});
    if(!rows.length)continue;
    d.deletion.removedRows+=(await tx.execute(S['cash'+i],{datasetSlot:state.dataset.slot,through:rows.at(-1).sourceRow})).rowsAffected;
    remains=true;break;
   }
   if(!remains){await tx.execute(S.cashInventory,{datasetSlot:state.dataset.slot});await tx.execute(S.cashDataset,{id:source.row.id,...actor});}
  }else if(state.runs.length){
   const {table,run}=state.runs[0],rows=await tx.queryAll(D.listRows,{runId:run.id,after:0,limit:BATCH});
   if(rows.length){
    const params={runId:run.id,through:rows.at(-1).rowNumber},blocks=await tx.queryAll(S.blocks,params);
    await tx.execute(S.rowRefs,params);d.deletion.removedRows+=(await tx.execute(S.rows,params)).rowsAffected;
    if(blocks.length)await tx.execute(S.orphanBlocks,{ids:blocks.map(b=>b.id)});
   }else{
    await tx.execute(S.events,{runId:run.id});await tx.execute(S.counts,{runId:run.id});
    if((await tx.execute(S.run,{runId:run.id,...actor})).rowsAffected!==1)C.fail('IMPORT_CONCURRENT_CHANGE',409);
    table.deleted=true;table.run=null;
   }
   remains=true;
  }
  await check('prepare');
  return remains;
 },{isolation:'serializable'});
 // A lost checkpoint is safe: row deletion is idempotent, missing finished
 // runs are recovered above, and productive rows are rechecked on every call.
 if(remains){await check('prepare');await save(source);return {deleted:false,id:source.row.id,revision:source.row.revision,status:'deleting',removedRows:d.deletion.removedRows};}
 return access.transaction(async tx=>{
  await check('prepare');
  if((await tx.execute(S.source,{id:source.row.id,...actor,revision:source.row.revision})).rowsAffected!==1)C.fail('IMPORT_REVISION_CONFLICT',409);
  const removedRows=d.deletion.totalRows??d.deletion.removedRows;
  await tx.execute(S.audit,
   {actor:actor.ownerId,action:'import.source.delete',entityType:'data_import_source',entityId:source.row.id,
    detail:{removedRows,unappliedOnly:true},timestamp:now()});
  return {deleted:true,id:source.row.id,removedRows};
 },{isolation:'serializable'});
}
module.exports={deleteSource,inspect};
