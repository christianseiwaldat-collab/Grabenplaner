'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/data-import-contract'),H=require('../lib/tradefoto-history-profiles'),M=require('../lib/tradefoto-master-profiles');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {openTwoDatabaseDevelopmentApplication}=require('../lib/persistence/postgresql/boundary/application');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createDataImportPayloadStore}=require('../lib/data-import-payload-store');
const {createImportHistoryWriters}=require('../lib/persistence/repositories/import-history');
const {createImportMasterWriters}=require('../lib/persistence/repositories/import-master-data');
const {DATA_IMPORT_STATEMENTS:D}=require('../lib/persistence/statements/data-import');
const profile=H.profileFor('trade','BestellVerteilung'),actor={scopeId:'synthetic-history-engine',ownerId:'00001'};
const FIRST='2026-10-15T10:00:00.000Z',NEXT='2026-10-16T10:00:00.000Z',masters='synthetic-engine-masters';
const enabled=process.env.GP_PG_MIGRATION_LIVE==='1',code=expected=>error=>error?.code===expected;
const article=key=>[3,6].includes(key)?'000000000050':String(key).padStart(12,'0');
const raw=(key,changed=false)=>H.prepareTradeFotoHistoryRow('trade',profile.sourceTable,{
  ...Object.fromEntries(H.tableFor('trade',profile.sourceTable).columns.map(column=>[column.name,null])),
  BestellNr:'synthetic-order',BestellId:String(key),FilialID:'18',EAN:article(key),
  Artikelbezeichnung:'Synthetic order item '+key,Menge:changed?'2':'1',
});
const context=f=>({...actor,sourceInstance:'synthetic-bestell-engine',sourceSystem:profile.sourceSystem,
  sourceTable:profile.sourceTable,profileHash:profile.fingerprint,fileSha256:'b'.repeat(64),snapshotAt:NEXT,
  at:f.at,runId:'f'.repeat(64)});
const historyWriter=f=>createImportHistoryWriters({protection:f.protection,authorize:()=>true,
  resolveMasterSourceInstance:()=>masters})[profile.entity];
function engine(f,{writer=historyWriter(f),operationBatchSize=200}={}){
  return createDataImportEngine({repository:createDataImportRepository(f.access),protection:f.protection,
    profiles:[profile],writers:{[profile.entity]:writer},sharedPayloads:true,operationBatchSize,
    getActor:()=>actor,authorize:()=>true,clock:()=>f.at});
}
async function finish(e,run,action){
  let calls=0;
  do{run=await e[action](run.id,run.revision);assert.ok(++calls<20,'Synthetic chain must remain bounded');}
  while(run.status===({review:'reviewing',apply:'applying',undo:'reverting'}[action]));
  return run;
}
async function ready(f,e,rows,sha){
  let run=await e.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'synthetic-bestell-engine',fileSha256:sha,
    schemaSha256:profile.schemaSha256,expectedRows:rows.length,declaredRows:rows.length,snapshotAt:f.at,gates:[]}});
  run=await e.stage(run.id,{expectedRevision:run.revision,startRow:1,rows});
  run=await e.seal(run.id,run.revision);
  return finish(e,run,'review');
}
async function target(f,key){
  const row=C.normalizeDataImportRow(profile,raw(key));
  return f.access.transaction(async tx=>(await historyWriter(f).findExisting(tx,row,context(f)))[0]||null,{readOnly:true});
}
async function evidence(f,runId){
  return {
    rows:(await f.client.query('SELECT row_number,payload FROM integration.data_import_rows WHERE run_id=$1 ORDER BY row_number',[runId])).rows,
    refs:(await f.client.query('SELECT row_number,slot,block_id FROM integration.data_import_row_payload_refs WHERE run_id=$1 ORDER BY row_number,slot',[runId])).rows,
  };
}
async function decoded(f,runId,kind){
  const store=createDataImportPayloadStore({protection:f.protection});
  return createDataImportRepository(f.access).atomic(async tx=>{
    const run=await tx.getRun({id:runId,...actor}),result=new Map();
    const changes=kind==='change'?new Map((await tx.pendingUndo({runId,limit:20})).map(change=>[change.rowNumber,change])):null;
    for(const row of await tx.listRows({runId,after:0,limit:20})){
      const change=changes?.get(row.rowNumber);
      if(kind==='change'&&!change)continue;
      result.set(row.rowNumber,await store.decode(tx,{run,profile,row:change?{...row,payload:change.payload}:row,kind}));
    }
    return result;
  },{readOnly:true});
}
async function seedDependency(f){
  const p=M.profileFor('ARTIKEL_STAMM'),data=C.normalizeDataImportRow(p,M.prepareTradeFotoMasterRow('ARTIKEL_STAMM',{
    ...Object.fromEntries(M.tableFor('ARTIKEL_STAMM').columns.map(column=>[column.name,null])),
    EAN:article(3),Artikelbezeichnung:'Synthetic newly available article',
  })).data;
  await f.access.transaction(tx=>createImportMasterWriters({protection:f.protection})[p.entity].create(tx,
    {id:'synthetic-engine-article',data},{...actor,sourceInstance:masters,sourceSystem:p.sourceSystem,
      sourceTable:p.sourceTable,profileHash:p.fingerprint,at:f.at}),{isolation:'serializable'});
}

test('Native history engine batches mixed value/dependency updates, resumes exact checkpoints and retains evidence through undo',
  {skip:!enabled},()=>withCoreFixture(core=>withSalesFixture(8,async sales=>{
    await core.application.close();await sales.application.close();
    const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,
      salesUrl:process.env.GP_SALES_APP_URL,stage:8,authorize:async()=>true});
    const f={...sales,access:app.provider,at:FIRST};
    try{
      const keys=[1,2,3,4,5,6,7,8],initial=engine(f);
      const first=await finish(initial,await ready(f,initial,keys.map(key=>raw(key)),'a'.repeat(64)),'apply');
      assert.equal(first.status,'applied');assert.deepEqual(first.counts,{applied:8});
      const oldVersions=(await f.client.query('SELECT * FROM integration.import_history_versions ORDER BY record_id,revision')).rows;
      const oldSegments=(await f.client.query('SELECT * FROM integration.import_history_segments ORDER BY record_id,revision,data_class')).rows;
      const oldReferences=(await f.client.query('SELECT * FROM integration.import_history_references ORDER BY record_id,revision,role')).rows;
      const beforeTargets=new Map();for(const key of keys)beforeTargets.set(key,await target(f,key));

      f.at=NEXT;await seedDependency(f);
      const incoming=keys.map(key=>raw(key,[2,4,7].includes(key))),base=historyWriter(f),calls=[];
      const writer={...base,async updateBatch(tx,inputs,value){calls.push(inputs.map(input=>input.id));return base.updateBatch(tx,inputs,value);},
        async update(){assert.fail('History engine must use the native packet hook');}};
      const e=engine(f,{writer,operationBatchSize:2}),next=await ready(f,e,incoming,'b'.repeat(64));
      assert.equal(next.status,'ready');assert.deepEqual(next.counts,{unchanged:3,update:5});
      const plans=await decoded(f,next.id,'row');
      for(const key of [3,6]){
        assert.deepEqual(plans.get(key).patch,{});
        assert.equal(plans.get(key).validation.rewrite,true,'Unchanged business fields retain the updated source dependency');
      }
      for(const key of [2,4,7])assert.ok(Object.keys(plans.get(key).patch).length>0);
      const rowEvidence=await evidence(f,next.id);

      // Ignore the successful response: a fresh engine must discover the exact
      // durable checkpoint and never rewrite the already acknowledged targets.
      await e.apply(next.id,next.revision);
      const resumed=engine(f,{writer,operationBatchSize:2}),checkpoint=await resumed.checkpoint(next.id);
      assert.equal(checkpoint.status,'applying');assert.equal(checkpoint.revision,next.revision+1);
      const partialRows=await f.access.queryAll(D.listRows,{runId:next.id,after:0,limit:20});
      assert.deepEqual(partialRows.map(row=>row.state),['unchanged','applied','applied','update','unchanged','update','update','unchanged']);
      const committed=new Map();for(const key of [2,3])committed.set(key,await target(f,key));
      const partialVersionCount=(await f.client.query('SELECT count(*)::int count FROM integration.import_history_versions')).rows[0].count;
      assert.equal(partialVersionCount,10);
      await assert.rejects(resumed.apply(next.id,next.revision),code('IMPORT_REVISION_CONFLICT'));
      assert.equal((await f.client.query('SELECT count(*)::int count FROM integration.import_history_versions')).rows[0].count,partialVersionCount);

      const applied=await finish(resumed,checkpoint,'apply');
      assert.equal(applied.status,'applied');assert.deepEqual(applied.counts,{unchanged:3,applied:5});
      const ordinal=new Map([...beforeTargets].map(([key,value])=>[value.id,key]));
      assert.deepEqual(calls.map(group=>group.map(id=>ordinal.get(id))),[[2,3],[4,6],[7]]);
      for(const [key,value] of committed)assert.deepEqual(await target(f,key),value,'Resume preserves the first committed packet');
      assert.deepEqual(await evidence(f,next.id),rowEvidence,'Status-only application retains the authenticated review ciphertext and references');
      const changes=await decoded(f,next.id,'change');assert.equal(changes.size,5);
      for(const key of keys){
        const current=await target(f,key),changed=[2,3,4,6,7].includes(key);
        assert.equal(current.revision,changed?2:1);
        assert.deepEqual(current.data,C.normalizeDataImportRow(profile,incoming[key-1]).data);
        if(changed){
          assert.equal(changes.get(key).action,'update');
          assert.deepEqual(changes.get(key).beforeTarget,beforeTargets.get(key));
          assert.deepEqual(changes.get(key).afterTarget,current);
        }
      }
      for(const [table,old,order] of [['import_history_versions',oldVersions,'record_id,revision'],
        ['import_history_segments',oldSegments,'record_id,revision,data_class'],['import_history_references',oldReferences,'record_id,revision,role']])
        assert.deepEqual((await f.client.query('SELECT * FROM integration.'+table+' WHERE revision=1 ORDER BY '+order)).rows,old);
      assert.equal((await f.client.query('SELECT count(*)::int count FROM integration.import_history_versions')).rows[0].count,13);
      const changeEvidence=(await f.client.query('SELECT row_number,payload FROM integration.data_import_changes WHERE run_id=$1 ORDER BY row_number',[next.id])).rows;
      assert.ok((await resumed.undoPreview(next.id)).rows.every(row=>row.canUndo));
      const undone=await finish(engine(f),applied,'undo');assert.equal(undone.status,'reverted');
      for(const key of keys){
        const current=await target(f,key);
        assert.deepEqual(current.data,beforeTargets.get(key).data);
        assert.equal(current.revision,[2,3,4,6,7].includes(key)?3:1);
      }
      assert.equal((await f.client.query('SELECT count(*)::int count FROM integration.import_history_versions')).rows[0].count,18);
      assert.deepEqual((await f.client.query('SELECT row_number,payload FROM integration.data_import_changes WHERE run_id=$1 ORDER BY row_number',[next.id])).rows,changeEvidence);
      // Undo saves an authenticated "reverted" row and may re-encrypt its plan.
      // The apply checkpoint above remains byte-exact; undo must preserve the
      // decoded evidence, unchanged rows and immutable history/change records.
      assert.deepEqual(await decoded(f,next.id,'row'),plans);
      const afterUndoEvidence=await evidence(f,next.id);
      assert.equal(afterUndoEvidence.rows.length,rowEvidence.rows.length);
      assert.deepEqual(afterUndoEvidence.refs,rowEvidence.refs);
      for(const key of [1,5,8])assert.deepEqual(afterUndoEvidence.rows[key-1],rowEvidence.rows[key-1]);
      for(const [table,old,order] of [['import_history_versions',oldVersions,'record_id,revision'],
        ['import_history_segments',oldSegments,'record_id,revision,data_class'],['import_history_references',oldReferences,'record_id,revision,role']])
        assert.deepEqual((await f.client.query('SELECT * FROM integration.'+table+' WHERE revision=1 ORDER BY '+order)).rows,old);
    }finally{await app.provider.close();}
  })));
