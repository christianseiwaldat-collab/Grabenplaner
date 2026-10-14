'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/data-import-contract'),M=require('../lib/tradefoto-master-profiles');
const {createDataImportProtection}=require('../lib/data-import-protection');
const {createImportMasterWriters}=require('../lib/persistence/repositories/import-master-data');
const {IMPORT_MASTER_STATEMENTS:S}=require('../lib/persistence/statements/import-master-data');
const {DATA_IMPORT_STATEMENTS:D}=require('../lib/persistence/statements/data-import');
const {IMPORT_BATCHES:B}=require('../lib/persistence/statements/import-batches');
const {IMPORT_BATCH_CATALOG}=require('../lib/persistence/postgresql/sales/import-batches');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const TIME='2026-10-15T10:00:00.000Z',enabled=process.env.GP_PG_MIGRATION_LIVE==='1';
const profile=M.profileFor('KUNDEN');
const context={scopeId:'synthetic-update-batches',ownerId:'synthetic-owner',sourceInstance:'synthetic-masters',
  sourceTable:'KUNDEN',sourceSystem:profile.sourceSystem,profileHash:profile.fingerprint,at:TIME};
const code=expected=>error=>error?.code===expected;
const data=(key,changed=false)=>C.normalizeDataImportRow(profile,M.prepareTradeFotoMasterRow('KUNDEN',{
  ...Object.fromEntries(M.tableFor('KUNDEN').columns.map(column=>[column.name,null])),
  KUND_NR:String(key),VORNAME:'Synthetic',NACHNAME:changed?'Updated synthetic customer':'Original synthetic customer',
  KFiliale:changed?null:'18',BankKntNr:changed?'updated-private-synthetic':'original-private-synthetic',
})).data;
const packet=(count,changed=false)=>Array.from({length:count},(_,i)=>({id:'synthetic-master-'+(i+1),expectedRevision:1,data:data(i+1,changed)}));
const delegate=tx=>Object.fromEntries(['queryOne','queryAll','execute'].map(method=>[method,(statement,parameters)=>tx[method](statement,parameters)]));

test('Master update packets reject empty, oversized, duplicate and invalid-revision requests before I/O',async()=>{
  const protection=createDataImportProtection({encryptionKey:Buffer.alloc(32,7),indexKey:Buffer.alloc(32,8),keyId:'synthetic'});
  try{
    const writer=createImportMasterWriters({protection})[profile.entity];
    const tx=new Proxy({},{get(){assert.fail('Invalid packet must not access persistence');}});
    for(const inputs of [null,[],packet(51)])await assert.rejects(writer.updateBatch(tx,inputs,context),code('IMPORT_BATCH_INVALID'));
    await assert.rejects(writer.updateBatch(tx,[packet(1)[0],packet(1)[0]],context),code('IMPORT_BATCH_INVALID'));
    for(const expectedRevision of [0,1.5,Number.MAX_SAFE_INTEGER])
      await assert.rejects(writer.updateBatch(tx,[{...packet(1)[0],expectedRevision}],context),code('IMPORT_INTEGER_INVALID'));
    await assert.rejects(writer.updateBatch(tx,[null],context),code('IMPORT_SHAPE_INVALID'));
  }finally{protection.destroy();}
});

test('Import status packets preserve ciphertext and CAS writes remain scoped runtime statements',()=>{
  const entry=statement=>IMPORT_BATCH_CATALOG.find(row=>row.statement===statement);
  for(const statement of [B.markRowsUnchanged,B.markUpdatesApplied]){
    const row=entry(statement);
    assert.deepEqual(row.parameterOrder,['runId','rows']);
    assert.match(row.sql,/WHERE run_id=\$1::text AND state/);
    assert.doesNotMatch(row.sql,/\bpayload\b|\bDELETE\b|\bINSERT\b/);
  }
  assert.match(entry(B.markRowsUnchanged).sql,/state='staged'/);
  assert.match(entry(B.markUpdatesApplied).sql,/state IN \('update','refresh'\)/);
  assert.match(entry(B.updateLinks).sql,/l\.revision=v\.revision/);
  assert.match(entry(B.updateMasterRecords).sql,/r\.scope_id=v\."scopeId" AND r\.revision=v\."expectedRevision"/);
  for(const statement of [B.deleteMasterSegments,B.deleteMasterRelations]){
    assert.match(entry(statement).sql,/r\.scope_id=v\."scopeId"/);
    assert.match(entry(statement).sql,/r\.revision=v\."expectedRevision"\+1/);
  }
});

test('Native master update packet replaces 50 protected records and relations with bounded SQL and authenticated read-back',
 {skip:!enabled},()=>withSalesFixture(8,async f=>{
  const writer=createImportMasterWriters({protection:f.protection})[profile.entity],original=packet(50),changed=packet(50,true);
  await f.postgres.transaction(tx=>writer.createBatch(tx,original.map(({id,data})=>({id,data})),context));
  const before=(await f.client.query('SELECT record_id,kind,data_class,payload FROM trade.import_master_segments ORDER BY record_id,kind,data_class')).rows;
  const calls=[];
  const results=await f.postgres.transaction(tx=>{
    const wrapped=Object.fromEntries(['queryOne','queryAll','execute'].map(method=>[method,(statement,parameters)=>{
      calls.push(statement.id);return tx[method](statement,parameters);
    }]));
    return writer.updateBatch(wrapped,changed,context);
  },{isolation:'serializable'});
  assert.deepEqual(results,changed.map(({id,data})=>({id,revision:2,data})));
  assert.ok(calls.length<=10,'SQL count must be bounded by packet, not by 50 records');
  assert.equal(calls.filter(id=>id===B.updateMasterRecords.id).length,1);
  assert.ok(!calls.includes(S.update.id)&&!calls.includes(S.insertSegment.id));
  const after=(await f.client.query('SELECT record_id,kind,data_class,payload FROM trade.import_master_segments ORDER BY record_id,kind,data_class')).rows;
  assert.equal(after.length,before.length);
  assert.ok(after.every((row,i)=>row.payload!==before[i].payload));
  for(const {id,data} of changed){
    const references=await f.postgres.queryAll(S.relations,{recordId:id,scopeId:context.scopeId});
    assert.deepEqual(references.map(({targetId,...row})=>row),M.masterReferences(f.protection,context,'KUNDEN',data).map(row=>({recordId:id,...row})));
  }
 }));

test('Native master packets roll back all revisions and protected parts on partial CAS, identity changes and tampered read-back',
 {skip:!enabled},()=>withSalesFixture(8,async f=>{
  const writer=createImportMasterWriters({protection:f.protection})[profile.entity],original=packet(3),changed=packet(3,true);
  await f.postgres.transaction(tx=>writer.createBatch(tx,original.map(({id,data})=>({id,data})),context));
  const stored=async()=>{
    const values=[];
    for(const [table,order] of [['import_master_records','id'],['import_master_segments','record_id,kind,data_class'],['import_master_relations','record_id,slot']])
      values.push((await f.client.query(`SELECT * FROM trade.${table} ORDER BY ${order}`)).rows);
    return values;
  };
  const before=await stored();
  await assert.rejects(f.postgres.transaction(tx=>{
    const wrapped=delegate(tx),execute=wrapped.execute;
    wrapped.execute=async(statement,parameters)=>{
      if(statement===B.updateMasterRecords)await tx.execute(S.update,{id:changed[1].id,scopeId:context.scopeId,expectedRevision:1,
        profileHash:profile.fingerprint,updatedBy:context.ownerId,updatedAt:TIME});
      return execute(statement,parameters);
    };
    return writer.updateBatch(wrapped,changed,context);
  },{isolation:'serializable'}),code('IMPORT_CONCURRENT_CHANGE'));
  assert.deepEqual(await stored(),before);
  await assert.rejects(f.postgres.transaction(tx=>writer.updateBatch(tx,[changed[0],{...changed[1],data:data('different-key',true)}],context)),
    code('IMPORT_MASTER_IDENTITY_IMMUTABLE'));
  assert.deepEqual(await stored(),before);
  await assert.rejects(f.postgres.transaction(tx=>writer.updateBatch(tx,changed,{...context,sourceInstance:'other-source'})),
    code('IMPORT_MASTER_CONTEXT_INVALID'));
  assert.deepEqual(await stored(),before);
  await assert.rejects(f.postgres.transaction(tx=>{
    const wrapped=delegate(tx),execute=wrapped.execute;
    wrapped.execute=(statement,parameters)=>execute(statement,statement===B.masterSegments
      ?{rows:parameters.rows.map((row,index)=>index?row:{...row,payload:'tampered'})}:parameters);
    return writer.updateBatch(wrapped,changed,context);
  },{isolation:'serializable'}),code('IMPORT_PROTECTED_PAYLOAD_INVALID'));
  assert.deepEqual(await stored(),before);
 }));

test('Native status-only packets retain exact payloads and references; link packets respect expected revisions',
 {skip:!enabled},()=>withSalesFixture(8,async f=>{
  const runId='synthetic-state-only-run',sha='a'.repeat(64);
  await f.postgres.execute(D.insertRun,{id:runId,scopeId:context.scopeId,ownerId:context.ownerId,attemptId:'synthetic',profileHash:sha,
    profile:{},manifest:{},status:'reviewing',revision:1,receivedCount:5,createdAt:TIME,updatedAt:TIME,expiresAt:'2026-10-16T10:00:00.000Z'});
  const rows=['staged','update','refresh','conflict','create'].map((state,i)=>({runId,rowNumber:i+1,identityHash:null,contentHash:sha,state,issue:'synthetic-issue',payload:'preserved-ciphertext-'+i}));
  await f.postgres.execute(B.insertRows,{rows});
  const block={id:'b'.repeat(64),scopeId:context.scopeId,ownerId:context.ownerId,profileHash:sha,sourceSystem:profile.sourceSystem,
    sourceInstance:context.sourceInstance,sourceTable:'KUNDEN',entity:profile.entity,blockType:'string',payload:'synthetic-block',keyId:'synthetic',nonce:Buffer.alloc(12,7).toString('base64'),createdAt:TIME};
  await f.postgres.execute(D.insertPayloadBlock,block);
  for(const row of rows)await f.postgres.execute(D.insertRowPayloadRef,{runId,rowNumber:row.rowNumber,slot:'record.data',blockId:block.id});
  const refs=()=>f.client.query('SELECT * FROM integration.data_import_row_payload_refs ORDER BY row_number,slot').then(result=>result.rows);
  const beforeRefs=await refs();
  await f.postgres.transaction(async tx=>{
    assert.equal((await tx.execute(B.markRowsUnchanged,{runId,rows:[1,4,5]})).rowsAffected,1);
    assert.equal((await tx.execute(B.markUpdatesApplied,{runId,rows:[1,2,3,4,5]})).rowsAffected,2);
  });
  const updated=await f.postgres.queryAll(D.listRows,{runId,after:0,limit:10});
  assert.deepEqual(updated.map(row=>row.state),['unchanged','applied','applied','conflict','create']);
  assert.deepEqual(updated.map(row=>row.payload),rows.map(row=>row.payload));
  assert.deepEqual(await refs(),beforeRefs);
  assert.deepEqual(updated.map(row=>row.issue),['','','','synthetic-issue','synthetic-issue']);
  const link={id:'c'.repeat(64),scopeId:context.scopeId,entity:profile.entity,targetId:'target-before',revision:1,lastRunId:runId,payload:'before'};
  await f.postgres.execute(D.insertLink,link);
  assert.equal((await f.postgres.execute(B.updateLinks,{rows:[{id:link.id,revision:2,targetId:'invalid',lastRunId:runId,payload:'invalid'}]})).rowsAffected,0);
  assert.deepEqual(await f.postgres.queryOne(D.getLink,{id:link.id}),link);
  assert.equal((await f.postgres.execute(B.updateLinks,{rows:[{id:link.id,revision:1,targetId:'target-after',lastRunId:runId,payload:'after'}]})).rowsAffected,1);
  assert.deepEqual(await f.postgres.queryOne(D.getLink,{id:link.id}),{...link,revision:2,targetId:'target-after',payload:'after'});
 }));
