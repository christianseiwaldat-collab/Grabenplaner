'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/data-import-contract'),M=require('../lib/tradefoto-master-profiles');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createDataImportPayloadStore}=require('../lib/data-import-payload-store');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const {createImportMasterWriters}=require('../lib/persistence/repositories/import-master-data');
const {IMPORT_MASTER_STATEMENTS:S}=require('../lib/persistence/statements/import-master-data');
const {DATA_IMPORT_STATEMENTS:D}=require('../lib/persistence/statements/data-import');
const {IMPORT_BATCHES:B}=require('../lib/persistence/statements/import-batches');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const enabled=process.env.GP_PG_MIGRATION_LIVE==='1',TIME='2026-10-15T11:00:00.000Z';
const profile=M.profileFor('KUNDEN'),actor={scopeId:'synthetic-mixed-apply',ownerId:'synthetic-owner'};
const context={...actor,sourceInstance:'synthetic-mixed-masters',sourceSystem:profile.sourceSystem,
  sourceTable:'KUNDEN',profileHash:profile.fingerprint,at:TIME};
const code=expected=>error=>error?.code===expected;
const raw=(key,version='original')=>M.prepareTradeFotoMasterRow('KUNDEN',{
  ...Object.fromEntries(M.tableFor('KUNDEN').columns.map(column=>[column.name,null])),KUND_NR:String(key),
  VORNAME:'Synthetic',NACHNAME:version+' customer '+key,BankKntNr:version+'-private-synthetic-'+key,
  INFO:('Synthetic retained evidence for customer '+key+'; ').repeat(120),
});
const normalized=(key,version)=>C.normalizeDataImportRow(profile,raw(key,version));
const delegate=tx=>Object.fromEntries(['queryOne','queryAll','execute'].map(method=>[method,(statement,parameters)=>tx[method](statement,parameters)]));
function engine(f,{writer,...options}={}){
  const writers=createImportMasterWriters({protection:f.protection});
  return createDataImportEngine({repository:createDataImportRepository(f.postgres),protection:f.protection,profiles:[profile],
    writers:writer?{...writers,[profile.entity]:writer}:writers,sharedPayloads:true,getActor:()=>actor,authorize:()=>true,clock:()=>TIME,...options});
}
async function finish(e,run,action){
  let calls=0;
  do{run=await e[action](run.id,run.revision);assert.ok(++calls<100,'Fixture operation must remain bounded');}
  while(run.status===({review:'reviewing',apply:'applying',undo:'reverting'}[action]));
  return run;
}
async function ready(e,rows,fileSha256){
  let run=await e.start({profileHash:profile.fingerprint,manifest:{sourceInstance:context.sourceInstance,fileSha256,
    schemaSha256:profile.schemaSha256,expectedRows:rows.length,declaredRows:rows.length,snapshotAt:TIME,gates:[]}});
  for(let offset=0;offset<rows.length;offset+=C.LIMITS.batch)
    run=await e.stage(run.id,{expectedRevision:run.revision,startRow:offset+1,rows:rows.slice(offset,offset+C.LIMITS.batch)});
  run=await e.seal(run.id,run.revision);return finish(e,run,'review');
}
async function target(f,key){
  const writer=createImportMasterWriters({protection:f.protection})[profile.entity];
  return f.postgres.transaction(async tx=>(await writer.findExisting(tx,normalized(key),context))[0]||null,{readOnly:true});
}
async function setup(f){
  const e=engine(f),writer=createImportMasterWriters({protection:f.protection})[profile.entity];
  const first=await finish(e,await ready(e,[2,3,4,6].map(key=>raw(key)),'a'.repeat(64)),'apply');
  const refreshBefore=await target(f,4);
  await f.postgres.transaction(tx=>writer.update(tx,{id:refreshBefore.id,expectedRevision:refreshBefore.revision,data:normalized(4,'updated').data},context));
  const incoming=[1,2,3,4,5,6].map(key=>raw(key,key===1||key===5?'original':'updated'));
  const next=await ready(e,incoming,'b'.repeat(64));
  assert.equal(next.status,'ready');assert.deepEqual(next.counts,{create:2,update:3,refresh:1});
  const rows=await f.postgres.queryAll(D.listRows,{runId:next.id,after:0,limit:10});
  assert.deepEqual(rows.map(row=>row.state),['create','update','update','refresh','create','update']);
  const beforeTargets=new Map(),beforeLinks=new Map();
  for(let key=1;key<=6;key++){
    beforeTargets.set(key,await target(f,key));
    beforeLinks.set(key,await f.postgres.queryOne(D.getLink,{id:rows[key-1].identityHash}));
  }
  return {e,writer,first,next,incoming,rows,beforeTargets,beforeLinks};
}
async function rowEvidence(f,runId){
  const rows=(await f.client.query('SELECT row_number,payload FROM integration.data_import_rows WHERE run_id=$1 ORDER BY row_number',[runId])).rows;
  const refs=(await f.client.query('SELECT row_number,slot,block_id FROM integration.data_import_row_payload_refs WHERE run_id=$1 ORDER BY row_number,slot',[runId])).rows;
  return {rows,refs};
}
async function allStored(f){
  const tables=[['trade.import_master_records','id'],['trade.import_master_segments','record_id,kind,data_class'],
    ['trade.import_master_relations','record_id,slot'],['integration.data_import_runs','id'],['integration.data_import_rows','run_id,row_number'],
    ['integration.data_import_links','id'],['integration.data_import_changes','run_id,row_number'],['integration.data_import_events','id'],
    ['integration.data_import_payload_blocks','id'],['integration.data_import_row_payload_refs','run_id,row_number,slot'],
    ['integration.data_import_change_payload_refs','run_id,row_number,slot'],['integration.data_import_run_state_counts','run_id,state']];
  const result={};
  for(const [table,order] of tables)result[table]=(await f.client.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
  return result;
}
async function decodedChanges(f,runId){
  const repository=createDataImportRepository(f.postgres),store=createDataImportPayloadStore({protection:f.protection});
  return repository.atomic(async tx=>{
    const run=await tx.getRun({id:runId,...actor}),changes=await tx.pendingUndo({runId,limit:100}),result=new Map();
    for(const change of changes){
      const original=await tx.getRow({runId,rowNumber:change.rowNumber});
      result.set(change.rowNumber,await store.decode(tx,{run,profile,row:{...original,payload:change.payload},kind:'change'}));
    }
    return result;
  },{readOnly:true});
}

test('Native mixed master apply preserves review evidence, refresh revisions and exact undo before/after values',
 {skip:!enabled},()=>withSalesFixture(8,async f=>{
  const s=await setup(f),before=await rowEvidence(f,s.next.id);
  assert.ok(before.refs.length>0,'Fixture must exercise shared protected evidence');
  let applied=await s.e.apply(s.next.id,s.next.revision);
  assert.equal(applied.status,'applied');assert.deepEqual(applied.counts,{applied:6});
  assert.deepEqual(await rowEvidence(f,s.next.id),before);
  const changes=await decodedChanges(f,applied.id),actions=['create','update','update','refresh','create','update'];
  for(let key=1;key<=6;key++){
    const current=await target(f,key),expectedData=C.normalizeDataImportRow(profile,s.incoming[key-1]).data;
    assert.deepEqual(current.data,expectedData);
    assert.equal(current.revision,key===1||key===5?1:2);
    assert.deepEqual(changes.get(key),{action:actions[key-1],beforeTarget:s.beforeTargets.get(key),afterTarget:current,beforeLink:s.beforeLinks.get(key)});
  }
  assert.deepEqual(await target(f,4),s.beforeTargets.get(4),'Refresh must not rewrite the manually matching target');
  assert.equal((await f.client.query('SELECT count(*)::int count FROM integration.import_history_versions')).rows[0].count,0);
  const auditBefore=(await f.client.query('SELECT row_number,payload FROM integration.data_import_changes WHERE run_id=$1 ORDER BY row_number',[applied.id])).rows;
  const changeRefsBefore=(await f.client.query('SELECT * FROM integration.data_import_change_payload_refs WHERE run_id=$1 ORDER BY row_number,slot',[applied.id])).rows;
  assert.ok((await s.e.undoPreview(applied.id)).rows.every(row=>row.canUndo));
  applied=await finish(engine(f),applied,'undo');assert.equal(applied.status,'reverted');
  assert.equal(await target(f,1),null);assert.equal(await target(f,5),null);
  for(const key of [2,3,6]){
    const restored=await target(f,key);
    assert.deepEqual(restored,{...s.beforeTargets.get(key),revision:3});
  }
  assert.deepEqual(await target(f,4),s.beforeTargets.get(4));
  for(const key of [2,3,4,6]){
    const link=await f.postgres.queryOne(D.getLink,{id:s.rows[key-1].identityHash}),old=s.beforeLinks.get(key);
    assert.equal(link.targetId,old.targetId);assert.equal(link.lastRunId,s.first.id);assert.equal(link.revision,old.revision+2);
    const previous=f.protection.open(old.payload,['link',old.id]);
    assert.deepEqual(f.protection.open(link.payload,['link',link.id]),{...previous,targetRevision:key===4?2:3});
  }
  assert.deepEqual((await f.client.query('SELECT row_number,payload FROM integration.data_import_changes WHERE run_id=$1 ORDER BY row_number',[applied.id])).rows,auditBefore);
  assert.deepEqual((await f.client.query('SELECT * FROM integration.data_import_change_payload_refs WHERE run_id=$1 ORDER BY row_number,slot',[applied.id])).rows,changeRefsBefore);
 }));

test('Native mixed apply rolls back earlier create groups after an update error, partial CAS or failed authenticated read-back',
 {skip:!enabled},async t=>withSalesFixture(8,async f=>{
  const s=await setup(f),before=await allStored(f);
  for(const mode of ['second-group-error','partial-cas','tampered-read-back'])await t.test(mode,async()=>{
    let created=0,updates=0;
    const writer={...s.writer,async createBatch(tx,inputs,value){created+=inputs.length;return s.writer.createBatch(tx,inputs,value);},
      async updateBatch(tx,inputs,value){
        updates++;assert.equal(created,1,'The earlier create must have executed inside this transaction');
        if(mode==='second-group-error')C.fail('IMPORT_TARGET_CHANGED',409);
        const wrapped=delegate(tx),execute=wrapped.execute;
        wrapped.execute=async(statement,parameters)=>{
          if(mode==='partial-cas'&&statement===B.updateMasterRecords){
            const stale=inputs[1];assert.ok(stale,'Fixture requires a partial two-target CAS');
            await tx.execute(S.update,{id:stale.id,scopeId:context.scopeId,expectedRevision:stale.expectedRevision,
              profileHash:profile.fingerprint,updatedBy:context.ownerId,updatedAt:TIME});
          }
          return execute(statement,mode==='tampered-read-back'&&statement===B.masterSegments
            ?{rows:parameters.rows.map((row,index)=>index?row:{...row,payload:'tampered'})}:parameters);
        };
        return s.writer.updateBatch(wrapped,inputs,value);
      }};
    await assert.rejects(engine(f,{writer}).apply(s.next.id,s.next.revision),code({
      'second-group-error':'IMPORT_TARGET_CHANGED','partial-cas':'IMPORT_CONCURRENT_CHANGE','tampered-read-back':'IMPORT_PROTECTED_PAYLOAD_INVALID',
    }[mode]));
    assert.equal(updates,1);assert.deepEqual(await allStored(f),before);
  });
  const recovered=await finish(engine(f),s.next,'apply');assert.equal(recovered.status,'applied');
  assert.equal((await f.client.query('SELECT count(*)::int count FROM trade.import_master_records')).rows[0].count,6);
 }));

test('Native mixed apply rejects stale manual targets, then recheck surfaces field conflicts without losing earlier evidence',
 {skip:!enabled},()=>withSalesFixture(8,async f=>{
  const s=await setup(f),existing=s.beforeTargets.get(2);
  await f.postgres.transaction(tx=>s.writer.update(tx,{id:existing.id,expectedRevision:existing.revision,data:normalized(2,'manual').data},context));
  const before=await allStored(f);
  await assert.rejects(engine(f).apply(s.next.id,s.next.revision),code('IMPORT_TARGET_CHANGED'));
  assert.deepEqual(await allStored(f),before);
  let run=s.next,calls=0,e=engine(f);
  do{run=await e.recheck(run.id,run.revision);assert.ok(++calls<20);}while(run.status!=='reviewing');
  run=await finish(e,run,'review');assert.equal(run.status,'needs_review');
  assert.deepEqual(run.counts,{create:2,update:2,refresh:1,conflict:1});
  const conflict=await f.postgres.queryOne(D.getRow,{runId:run.id,rowNumber:2});
  assert.equal(conflict.state,'conflict');assert.equal(conflict.issue,'MANUAL_FIELD_CONFLICT');
  await assert.rejects(e.apply(run.id,run.revision));
  assert.deepEqual((await target(f,2)).data,normalized(2,'manual').data);
  assert.equal(await target(f,1),null);assert.equal(await target(f,5),null);
 }));

test('Native mixed apply respects the budget between groups and a restarted engine resumes only remaining rows after a lost reply',
 {skip:!enabled},()=>withSalesFixture(8,async f=>{
  const s=await setup(f),before=await rowEvidence(f,s.next.id);
  const writer={...s.writer,async createBatch(tx,inputs,value){
    const result=await s.writer.createBatch(tx,inputs,value);
    await new Promise(resolve=>setTimeout(resolve,5));return result;
  }};
  // Discard the successful response as if the browser/worker lost its reply.
  await engine(f,{writer,operationBudgetMs:1}).apply(s.next.id,s.next.revision);
  const resumed=engine(f,{operationBatchSize:3}),checkpoint=await resumed.checkpoint(s.next.id);
  assert.equal(checkpoint.status,'applying');assert.equal(checkpoint.revision,s.next.revision+1);
  const partialRows=await f.postgres.queryAll(D.listRows,{runId:s.next.id,after:0,limit:10});
  assert.deepEqual(partialRows.map(row=>row.state),['applied','update','update','refresh','create','update']);
  const firstCreated=await target(f,1),partial=await allStored(f);
  await assert.rejects(resumed.apply(s.next.id,s.next.revision),code('IMPORT_REVISION_CONFLICT'));
  assert.deepEqual(await allStored(f),partial);
  const applied=await finish(resumed,checkpoint,'apply');assert.equal(applied.status,'applied');
  assert.deepEqual(await target(f,1),firstCreated,'Resume must not create or rewrite an already applied target');
  assert.deepEqual(await rowEvidence(f,s.next.id),before);
  assert.equal((await f.client.query('SELECT count(*)::int count FROM integration.data_import_changes WHERE run_id=$1',[s.next.id])).rows[0].count,6);
  assert.equal((await f.client.query('SELECT count(*)::int count FROM trade.import_master_records')).rows[0].count,6);
  for(const key of [2,3,4,6])assert.equal((await target(f,key)).revision,2);
 }));
