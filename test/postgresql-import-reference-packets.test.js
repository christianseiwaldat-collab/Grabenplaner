'use strict';
// Owned synthetic fixtures only. A skipped group is not a native execution claim.
// Native semantics: GP_PG_MIGRATION_LIVE=1.
// Native volume/plans: additionally GP_IMPORT_REFERENCE_VOLUME_CHECK=1.
// Use the existing verified Sales fixture URLs; never point this at production.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const {IMPORT_BATCHES:B}=require('../lib/persistence/statements/import-batches');
const {DATA_IMPORT_STATEMENTS:D}=require('../lib/persistence/statements/data-import');
const {IMPORT_BATCH_CATALOG}=require('../lib/persistence/postgresql/sales/import-batches');
const M=require('../lib/tradefoto-master-profiles');
const native=process.env.GP_PG_MIGRATION_LIVE==='1';
const volume=native&&process.env.GP_IMPORT_REFERENCE_VOLUME_CHECK==='1';
const TIME='2026-10-15T12:00:00.000Z',profile=M.profileFor('KUNDEN');
const actor={scopeId:'synthetic-reference-packets',ownerId:'synthetic-reference-owner'};
const slots=['afterTarget.data','beforeLink.payload','beforeTarget.data','patch','record.data','record.source'];
const volumeSlots=['beforeTarget.data','record.data','record.source'];
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const entry=statement=>IMPORT_BATCH_CATALOG.find(item=>item.statement===statement);
// Frozen comparison SQL exists only in this test, never as a runtime fallback.
const previous=Object.freeze({
 [B.rowRefs.id]:'SELECT run_id::text AS "runId",row_number AS "rowNumber",slot::text AS slot,block_id::text AS "blockId" FROM integration.data_import_row_payload_refs WHERE run_id=$1::text AND row_number IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb)) ORDER BY row_number,slot',
 [B.deleteRowRefs.id]:'DELETE FROM integration.data_import_row_payload_refs WHERE run_id=$1::text AND row_number IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb))',
});
async function start(f,count,label){
 const engine=createDataImportEngine({repository:createDataImportRepository(f.postgres),protection:f.protection,
  profiles:[profile],getActor:()=>actor,authorize:()=>true,clock:()=>TIME});
 return engine.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'synthetic-references-'+label,
  fileSha256:sha(label),schemaSha256:profile.schemaSha256,expectedRows:count,declaredRows:count,snapshotAt:TIME,gates:[]}});
}
async function block(f,label){
 const id=sha('reference-block-'+label),payload=f.protection.sealBlock({syntheticFixture:label},['synthetic-reference-block',id]);
 await f.postgres.execute(D.insertPayloadBlock,{id,...actor,profileHash:profile.fingerprint,sourceSystem:profile.sourceSystem,
  sourceInstance:'synthetic-reference-blocks',sourceTable:profile.sourceTable,entity:profile.entity,blockType:'object',
  payload,keyId:payload.split(':')[1],nonce:payload.split(':')[2],createdAt:TIME});
 return id;
}
async function insert(f,run,count,blockId,selectedSlots=slots){
 for(let offset=0;offset<count;offset+=10000){
  const end=Math.min(offset+10000,count);
  // Generated, encrypted synthetic rows; no production source is consulted.
  await f.client.query(`INSERT INTO integration.data_import_rows(run_id,row_number,identity_hash,content_hash,state,issue,payload)
   SELECT $1,g,NULL,repeat('a',64),'staged','synthetic issue',$4
   FROM generate_series($2::int,$3::int)g`,[run.id,offset+1,end,
   f.protection.seal({syntheticFixture:'reference packet volume'},['synthetic-reference-row-fixture',run.id])]);
  await f.client.query(`INSERT INTO integration.data_import_row_payload_refs(run_id,row_number,slot,block_id)
   SELECT $1,g,s,$4 FROM generate_series($2::int,$3::int)g CROSS JOIN unnest($5::text[])s`,
  [run.id,offset+1,end,blockId,selectedSlots]);
 }
}
async function small(f,label){
 const target=await start(f,6,label+'-target'),other=await start(f,6,label+'-other');
 const targetBlock=await block(f,label+'-target'),otherBlock=await block(f,label+'-other');
 await insert(f,target,6,targetBlock);await insert(f,other,6,otherBlock);
 return {target,other,targetBlock,otherBlock};
}
async function evidence(f){
 return {rows:(await f.client.query('SELECT * FROM integration.data_import_rows ORDER BY run_id,row_number')).rows,
  refs:(await f.client.query('SELECT * FROM integration.data_import_row_payload_refs ORDER BY run_id,row_number,slot')).rows,
  blocks:(await f.client.query('SELECT * FROM integration.data_import_payload_blocks ORDER BY id')).rows,
  counts:(await f.client.query('SELECT * FROM integration.data_import_run_state_counts ORDER BY run_id,state')).rows};
}
const normalizeRefs=rows=>rows.map(row=>({...row,rowNumber:Number(row.rowNumber)}));
const selectedRefs=(state,runId,numbers)=>state.refs.filter(row=>row.run_id===runId&&numbers.includes(Number(row.row_number)))
 .map(row=>({runId:row.run_id,rowNumber:Number(row.row_number),slot:row.slot,blockId:row.block_id}));

test('reference packet SQL keeps exact run binding, column contract and slot ordering with the existing row-array form',()=>{
 for(const statement of [B.rowRefs,B.deleteRowRefs]){
  const current=entry(statement);assert.deepEqual(current.parameterOrder,['runId','rows']);
  assert.match(current.sql,/WHERE run_id=\$1::text AND row_number = ANY\(ARRAY\(SELECT value::bigint FROM jsonb_array_elements_text\(\$2::jsonb\)\)\)/);
  assert.doesNotMatch(current.sql,/row_number IN \(/);assert.notEqual(current.sql,previous[statement.id]);
 }
 assert.match(entry(B.rowRefs).sql,/ORDER BY row_number,slot$/);
 assert.deepEqual(Object.keys(B.rowRefs.columns),['runId','rowNumber','slot','blockId']);
});

test('Native reference packets preserve exact selected runs, every slot, ciphertext, empty packets and read replay',
 {skip:!native},()=>withSalesFixture(8,async f=>{
 const {target,other}=await small(f,'selection'),before=await evidence(f);
 for(const [runId,rows] of [[target.id,[6,2,6,999999,0]],[other.id,[1,3]],
  [target.id,[]],[sha('missing-reference-run'),[1,2]],[target.id,[0,-1,999999]],[target.id,[1,null]]]){
  const expected=selectedRefs(before,runId,rows);
  const current=await f.postgres.queryAll(B.rowRefs,{runId,rows});
  assert.deepEqual(current,expected);
  assert.deepEqual(await f.postgres.queryAll(B.rowRefs,{runId,rows}),current,'Repeated reads retain exact slot order');
  const legacy=await f.client.query(previous[B.rowRefs.id],[runId,JSON.stringify(rows)]);
  assert.deepEqual(normalizeRefs(legacy.rows),current,'Frozen former SQL and candidate select the same references');
 }
 assert.deepEqual(await evidence(f),before,'Reference prefetch never changes rows, counters or protected blocks');
}));

test('Native reference deletion keeps other runs and protected blocks intact and permits idempotent empty replay',
 {skip:!native},()=>withSalesFixture(8,async f=>{
 const {target}=await small(f,'deletion'),before=await evidence(f),rows=[2,6,2];
 for(const packet of [rows,[1,null],[],[0,-1,999999]]){
  await f.client.query('BEGIN');
  try{
   const expectedCount=selectedRefs(before,target.id,packet).length;
   const result=await f.client.query(previous[B.deleteRowRefs.id],[target.id,JSON.stringify(packet)]);
   assert.equal(result.rowCount,expectedCount,'Frozen deletion removes every selected slot once');
  }finally{await f.client.query('ROLLBACK');}
  assert.deepEqual(await evidence(f),before);
 }
 const expected=before.refs.filter(row=>row.run_id!==target.id||![2,6].includes(Number(row.row_number)));
 assert.equal((await f.postgres.execute(B.deleteRowRefs,{runId:target.id,rows})).rowsAffected,12,
  'All six slots are removed for each distinct selected row; duplicates never multiply deletions');
 const after=await evidence(f);assert.deepEqual(after,{...before,refs:expected});
 for(const [runId,packet] of [[target.id,rows],[target.id,[]],[sha('absent-run'),[1]],[target.id,[0,-1,999999]]])
  assert.equal((await f.postgres.execute(B.deleteRowRefs,{runId,rows:packet})).rowsAffected,0);
 assert.deepEqual(await evidence(f),after);
}));

test('Native reference packets reject malformed numbers atomically and roll back both deletion and foreign-key failures',
 {skip:!native},()=>withSalesFixture(8,async f=>{
 const {target,targetBlock}=await small(f,'rollback'),before=await evidence(f);
 for(const statement of [B.rowRefs,B.deleteRowRefs])for(const rows of [
  {row:1},[1,'1); DELETE FROM integration.data_import_rows; --'],[1,'9223372036854775808'],[1,1.5],
 ]){
  await assert.rejects(f.postgres.transaction(tx=>tx[statement.operation](statement,{runId:target.id,rows})));
  assert.deepEqual(await evidence(f),before);
 }
 await assert.rejects(f.postgres.transaction(async tx=>{
  assert.equal((await tx.execute(B.deleteRowRefs,{runId:target.id,rows:[2,5]})).rowsAffected,12);
  assert.deepEqual(await tx.queryAll(B.rowRefs,{runId:target.id,rows:[2,5]}),[]);
  throw new Error('Synthetic reference rollback after deletion');
 }),/Synthetic reference rollback/);
 assert.deepEqual(await evidence(f),before);
 // The selector change must not weaken existing slot, composite-parent or block guards.
 for(const input of [{rowNumber:1,slot:'not-a-slot',blockId:targetBlock},
  {rowNumber:999,slot:'record.source',blockId:targetBlock},
  {rowNumber:1,slot:'record.source',blockId:sha('missing-block')},
  {rowNumber:1,slot:'record.source',blockId:targetBlock}]){
  await assert.rejects(f.postgres.transaction(async tx=>{
   await tx.execute(B.deleteRowRefs,{runId:target.id,rows:[2]});
   await tx.execute(D.insertRowPayloadRef,{runId:target.id,...input});
  }));
  assert.deepEqual(await evidence(f),before,'A late FK, slot or uniqueness error also rolls back earlier packet deletions');
 }
}));

function nodes(plan){return [plan,...(plan.Plans||[]).flatMap(nodes)];}
function summarize(explain){
 const plan=explain.Plan;
 return {milliseconds:explain['Execution Time'],planningMs:explain['Planning Time'],
  blocks:(plan['Shared Hit Blocks']||0)+(plan['Shared Read Blocks']||0),
  scans:nodes(plan).filter(n=>n['Relation Name']==='data_import_row_payload_refs'&&n['Node Type']!=='ModifyTable')
   .map(n=>({node:n['Node Type'],index:n['Index Name'],condition:n['Index Cond']||n['Recheck Cond']||null,
    filter:n.Filter||null,estimated:n['Plan Rows'],actual:n['Actual Rows'],removedByFilter:n['Rows Removed by Filter']||0,
    removedByRecheck:n['Rows Removed by Index Recheck']||0,loops:n['Actual Loops']}))};
}

test('Native 237893-row reference packets: stale/current statistics and custom/generic plans compare both SQL forms without assumed speedup',
 {skip:!volume,timeout:600000},()=>withSalesFixture(8,async f=>{
 const background=await start(f,10000,'volume-background'),target=await start(f,237893,'volume-target');
 const targetBlock=await block(f,'volume-target'),backgroundBlock=await block(f,'volume-background');
 const relations=['integration.data_import_rows','integration.data_import_row_payload_refs'];
 const settings=[],measurements=[];
 try{
  for(const relation of relations){
   settings.push({relation,options:(await f.client.query('SELECT reloptions FROM pg_class WHERE oid=$1::regclass',[relation])).rows[0].reloptions||[]});
   // Only the owned synthetic fixture changes its autovacuum setting; restore below.
   await f.client.query('ALTER TABLE '+relation+' SET (autovacuum_enabled=false)');
  }
  await insert(f,background,10000,backgroundBlock,volumeSlots);
  for(const relation of relations)await f.client.query('ANALYZE '+relation);
  await insert(f,target,237893,targetBlock,volumeSlots);
  const targetRefs=237893*volumeSlots.length,backgroundRefs=10000*volumeSlots.length;
  const count=async runId=>(await f.client.query('SELECT count(*)::int n FROM integration.data_import_row_payload_refs WHERE run_id=$1',[runId])).rows[0].n;
  assert.equal(await count(target.id),targetRefs);assert.equal(await count(background.id),backgroundRefs);
  for(const statistics of ['stale','current']){
   if(statistics==='current')for(const relation of relations)await f.client.query('ANALYZE '+relation);
   for(const mode of ['force_custom_plan','force_generic_plan']){
    await f.client.query('SET plan_cache_mode='+mode);
    for(const [operationIndex,statement] of [B.rowRefs,B.deleteRowRefs].entries())for(const [form,query] of [
     ['before',previous[statement.id]],['after',entry(statement).sql],
    ]){
     const name='ref_packet_'+statistics+'_'+mode+'_'+operationIndex+'_'+form;
     await f.client.query('PREPARE '+name+'(text,jsonb) AS '+query);
     try{for(const size of [1,5,20,50,200]){
      const rows=Array.from({length:size},(_,i)=>237893-2*i),encoded=JSON.stringify(rows);
      // Only locally generated positive integers and the synthetic SHA run ID enter literals.
      const execute=`EXECUTE ${name}('${target.id}','${encoded}')`;
      await f.client.query('BEGIN');
      try{
       const explanation=(await f.client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+execute)).rows[0]['QUERY PLAN'][0];
       const measured=summarize(explanation);assert.ok(Number.isFinite(measured.milliseconds)&&measured.milliseconds>=0);
       if(statement===B.rowRefs)assert.equal(explanation.Plan['Actual Rows'],size*volumeSlots.length);
       else assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.data_import_row_payload_refs WHERE run_id=$1 AND row_number=ANY($2::bigint[])',[target.id,rows])).rows[0].n,0);
       measurements.push({statistics,mode,statement:statement.id,form,size,slotsPerRow:volumeSlots.length,...measured});
      }finally{await f.client.query('ROLLBACK');}
     }}finally{await f.client.query('DEALLOCATE '+name);}
    }
   }
   assert.equal(await count(target.id),targetRefs,'Measured deletes always roll back');
   assert.equal(await count(background.id),backgroundRefs,'Foreign-run references never change');
  }
  assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.data_import_payload_blocks')).rows[0].n,2);
  // Evidence reports actual plans and buffers. No broad legacy scan or improvement
  // ratio is assumed; indistinguishable plans are a valid diagnostic result.
  const comparisons=measurements.filter(m=>m.form==='after').map(after=>{
   const before=measurements.find(m=>m.form==='before'&&m.statistics===after.statistics&&m.mode===after.mode&&m.statement===after.statement&&m.size===after.size);
   return {statistics:after.statistics,mode:after.mode,statement:after.statement,size:after.size,
    beforeMs:before.milliseconds,afterMs:after.milliseconds,beforeBlocks:before.blocks,afterBlocks:after.blocks};
  });
  process.stdout.write(JSON.stringify({kind:'import-reference-volume-proof',rows:237893,slotsPerRow:volumeSlots.length,
   targetReferences:targetRefs,backgroundRows:10000,backgroundReferences:backgroundRefs,productionContact:false,
   assumedPlanRegression:false,measurements,comparisons})+'\n');
 }finally{
  await f.client.query('ROLLBACK');await f.client.query('RESET plan_cache_mode');
  for(const {relation,options} of settings){const old=options.find(value=>value.startsWith('autovacuum_enabled='));
   await f.client.query(old?'ALTER TABLE '+relation+' SET ('+old+')':'ALTER TABLE '+relation+' RESET (autovacuum_enabled)');}
 }
}));
