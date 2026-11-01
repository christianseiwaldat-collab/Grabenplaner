'use strict';
// Runs only against the verified, owned synthetic Sales fixture. Volume data
// never comes from a production import. A skip is not a native execution proof.
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {createDataImportEngine}=require('../lib/data-import-engine');
const {createDataImportRepository}=require('../lib/persistence/repositories/data-import');
const {createReviewBatchPolicy}=require('../lib/data-import-review-batching');
const {IMPORT_BATCHES:B}=require('../lib/persistence/statements/import-batches');
const {DATA_IMPORT_STATEMENTS:D}=require('../lib/persistence/statements/data-import');
const {IMPORT_BATCH_CATALOG}=require('../lib/persistence/postgresql/sales/import-batches');
const M=require('../lib/tradefoto-master-profiles');
const native=process.env.GP_PG_MIGRATION_LIVE==='1';
const volume=native&&process.env.GP_IMPORT_STATE_VOLUME_CHECK==='1';
const TIME='2026-10-15T12:00:00.000Z',profile=M.profileFor('KUNDEN');
const actor={scopeId:'synthetic-state-packets',ownerId:'synthetic-owner'};
const variants=[
 {statement:B.markRowsUnchanged,states:['staged'],after:'unchanged'},
 {statement:B.markCreatesApplied,states:['create'],after:'applied'},
 {statement:B.markUpdatesApplied,states:['update','refresh'],after:'applied'},
];
const sql=statement=>IMPORT_BATCH_CATALOG.find(entry=>entry.statement===statement).sql;
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
async function start(f,count,label,{stage=false}={}){
 const e=createDataImportEngine({repository:createDataImportRepository(f.postgres),protection:f.protection,
  profiles:[profile],getActor:()=>actor,authorize:()=>true,clock:()=>TIME});
 let run=await e.start({profileHash:profile.fingerprint,manifest:{sourceInstance:'synthetic-status-'+label,
  fileSha256:sha(label),schemaSha256:profile.schemaSha256,expectedRows:count,declaredRows:count,snapshotAt:TIME,gates:[]}});
 if(stage)run=await e.stage(run.id,{expectedRevision:run.revision,startRow:1,rows:Array.from({length:count},(_,i)=>
  M.prepareTradeFotoMasterRow('KUNDEN',{...Object.fromEntries(M.tableFor('KUNDEN').columns.map(c=>[c.name,null])),
   KUND_NR:String(i+1),VORNAME:'Synthetic',NACHNAME:'Status fixture '+(i+1)}))});
 return run;
}
const states=['staged','create','update','refresh','unchanged','invalid','conflict','applied','reverted','duplicate'];
async function reset(f,run){
 await f.client.query(`UPDATE integration.data_import_rows r SET state=v.state,issue='synthetic issue'
  FROM unnest($2::text[]) WITH ORDINALITY AS v(state,n) WHERE r.run_id=$1 AND r.row_number=v.n`,[run.id,states]);
}
async function evidence(f){
 return {rows:(await f.client.query('SELECT * FROM integration.data_import_rows ORDER BY run_id,row_number')).rows,
  counts:(await f.client.query('SELECT * FROM integration.data_import_run_state_counts ORDER BY run_id,state')).rows};
}

test('Native state packets preserve exact run, state, ciphertext, hashes and transactional counters', {skip:!native},()=>withSalesFixture(8,async f=>{
 const run=await start(f,states.length,'target',{stage:true}), other=await start(f,states.length,'other',{stage:true});
 await reset(f,other);
 for(const variant of variants){
  await reset(f,run);const before=await evidence(f);
  const numbers=states.map((_,i)=>i+1);
  const result=await f.postgres.execute(variant.statement,{runId:run.id,rows:numbers});
  assert.equal(result.rowsAffected,variant.states.length);
  const after=await evidence(f);
  for(let i=0;i<before.rows.length;i++){
   const row=before.rows[i],change=row.run_id===run.id&&variant.states.includes(row.state);
   assert.deepEqual(after.rows[i],change?{...row,state:variant.after,issue:''}:row);
  }
  const recomputed=(await f.client.query('SELECT run_id,state,count(*)::bigint count FROM integration.data_import_rows GROUP BY run_id,state ORDER BY run_id,state')).rows;
  assert.deepEqual(after.counts,recomputed);
  assert.equal((await f.postgres.execute(variant.statement,{runId:run.id,rows:numbers})).rowsAffected,0,'Replay must not confirm an already changed state');
 }
}));

test('Native state packets reject malformed row numbers and preserve rollback, missing rows and foreign runs', {skip:!native},()=>withSalesFixture(8,async f=>{
 const run=await start(f,states.length,'negative',{stage:true});await reset(f,run);
 const before=await evidence(f);
 for(const variant of variants){
  for(const [runId,rows] of [[run.id,[]],[sha('absent'),[1,2,3,4]],[run.id,[0,999999]]])
   assert.equal((await f.postgres.execute(variant.statement,{runId,rows})).rowsAffected,0);
  for(const rows of [{row:1},[1,'1); DELETE FROM integration.data_import_rows; --'],[1,'9223372036854775808']]){
   await assert.rejects(f.postgres.transaction(tx=>tx.execute(variant.statement,{runId:run.id,rows})));
   assert.deepEqual(await evidence(f),before);
  }
  const rowNumber=states.indexOf(variant.states[0])+1;
  for(const rows of [[rowNumber,999999],[rowNumber,rowNumber]]){
   await assert.rejects(f.postgres.transaction(async tx=>{
    const result=await tx.execute(variant.statement,{runId:run.id,rows});
    // Same affected-row invariant used by the real import engine.
    if(result.rowsAffected!==rows.length)throw Object.assign(new Error('Packet conflict'),{code:'IMPORT_CONCURRENT_CHANGE'});
   }),error=>error.code==='IMPORT_CONCURRENT_CHANGE');
   assert.deepEqual(await evidence(f),before);
  }
  await assert.rejects(f.postgres.transaction(async tx=>{
   assert.equal((await tx.execute(variant.statement,{runId:run.id,rows:[rowNumber]})).rowsAffected,1);
   throw new Error('Synthetic failure after confirmation');
  }),/Synthetic failure/);
  assert.deepEqual(await evidence(f),before,'State and trigger counters must roll back together');
 }
}));

test('Native concurrent state change invalidates a serializable packet without overwriting the competing result', {skip:!native},()=>withSalesFixture(8,async f=>{
 const run=await start(f,states.length,'concurrent',{stage:true});await reset(f,run);
 const before=await f.postgres.queryOne(D.getRow,{runId:run.id,rowNumber:3});
 await assert.rejects(f.postgres.transaction(async tx=>{
  assert.equal((await tx.queryOne(D.getRow,{runId:run.id,rowNumber:3})).state,'update');
  await f.client.query("UPDATE integration.data_import_rows SET state='conflict',issue='competing change' WHERE run_id=$1 AND row_number=3",[run.id]);
  await tx.execute(B.markUpdatesApplied,{runId:run.id,rows:[3,4]});
 },{isolation:'serializable'}),error=>error.code==='PERSISTENCE_RETRYABLE_TRANSACTION');
 assert.deepEqual(await f.postgres.queryOne(D.getRow,{runId:run.id,rowNumber:3}),{...before,state:'conflict',issue:'competing change'});
 assert.equal((await f.postgres.queryOne(D.getRow,{runId:run.id,rowNumber:4})).state,'refresh');
 assert.equal((await f.postgres.execute(B.markUpdatesApplied,{runId:run.id,rows:[3]})).rowsAffected,0);
}));

function nodes(plan){return [plan,...(plan.Plans||[]).flatMap(nodes)];}
function indexedPacket(plan){
 const scans=nodes(plan).filter(n=>n['Relation Name']==='data_import_rows'&&n['Node Type']!=='ModifyTable');
 assert.ok(scans.length>0);
 assert.ok(scans.every(n=>/Index|Bitmap Heap/.test(n['Node Type'])&&/row_number/.test(n['Index Cond']||n['Recheck Cond']||'')),JSON.stringify(scans));
}
function summary(explain){
 const plan=explain.Plan;
 return {milliseconds:explain['Execution Time'],blocks:(plan['Shared Hit Blocks']||0)+(plan['Shared Read Blocks']||0),
  scans:nodes(plan).filter(n=>n['Relation Name']==='data_import_rows'&&n['Node Type']!=='ModifyTable')
   .map(n=>({node:n['Node Type'],index:n['Index Name'],condition:n['Index Cond'],estimated:n['Plan Rows'],actual:n['Actual Rows'],loops:n['Actual Loops']}))};
}

test('Native 237893-row import: stale and refreshed statistics, custom/generic plans, bounded reads and recovery from one-row packets',
 {skip:!volume,timeout:600000},()=>withSalesFixture(8,async f=>{
 const background=await start(f,10000,'volume-background'), target=await start(f,237893,'volume-current');
 const options=(await f.client.query("SELECT reloptions FROM pg_class WHERE oid='integration.data_import_rows'::regclass")).rows[0].reloptions;
 // Prevent a background ANALYZE from removing the regression condition while
 // measuring. This is an owned local fixture, never a productive configuration.
 await f.client.query('ALTER TABLE integration.data_import_rows SET (autovacuum_enabled=false)');
 const insert=async(run,count)=>{
  for(let offset=0;offset<count;offset+=10000)await f.client.query(`INSERT INTO integration.data_import_rows(run_id,row_number,identity_hash,content_hash,state,issue,payload)
   SELECT $1,g,NULL,repeat('a',64),(ARRAY['staged','create','update','refresh'])[1+(g-1)%4], '',repeat(md5(g::text),16)
   FROM generate_series($2::int,$3::int)g`,[run.id,offset+1,Math.min(offset+10000,count)]);
 };
 const measurements=[];
 try{
  await insert(background,10000);await f.client.query('ANALYZE integration.data_import_rows');
  await insert(target,237893);
  const beforeCount=(await f.client.query('SELECT count(*)::int n FROM integration.data_import_rows WHERE run_id=$1',[target.id])).rows[0].n;
  assert.equal(beforeCount,237893);
  const previous=require('../test-support/import-state-packets-before.json');
  for(const statistics of ['stale','current']){
   if(statistics==='current')await f.client.query('ANALYZE integration.data_import_rows');
   for(const mode of ['force_custom_plan','force_generic_plan']){
    await f.client.query('SET plan_cache_mode='+mode);
    for(const [index,variant] of variants.entries()){
     const name='status_packet_'+statistics+'_'+mode+'_'+index;
     await f.client.query(`PREPARE ${name}(text,jsonb) AS `+sql(variant.statement));
     try{
      for(const size of [1,5,50,200]){
       const rows=Array.from({length:size},(_,i)=>1+index+4*i);
       // Literals below are bounded generated fixture numbers and SHA IDs.
       const explainSql=`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE ${name}('${target.id}','${JSON.stringify(rows)}')`;
       await f.client.query('BEGIN');
       try{
        const data=(await f.client.query(explainSql)).rows[0]['QUERY PLAN'][0];indexedPacket(data.Plan);
        const result=summary(data);assert.ok(result.blocks<2000+size*250,'Packet work must be bounded by selected rows, not the remaining import');
        measurements.push({statistics,mode,variant:variant.statement.id,size,...result});
       }finally{await f.client.query('ROLLBACK');}
      }
     }finally{await f.client.query('DEALLOCATE '+name);}
    }
   }
   if(statistics==='stale'){
    await f.client.query('SET plan_cache_mode=force_custom_plan');
    const rows=JSON.stringify([3]);
    for(const [kind,query] of [['before',previous.statements[B.markUpdatesApplied.id]],['after',sql(B.markUpdatesApplied)]]){
     await f.client.query('BEGIN');
     try{
      const data=(await f.client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,[target.id,rows])).rows[0]['QUERY PLAN'][0];
      measurements.push({comparison:kind,...summary(data)});
     }finally{await f.client.query('ROLLBACK');}
    }
   }
  }
  const before=measurements.find(x=>x.comparison==='before'),after=measurements.find(x=>x.comparison==='after');
  assert.ok(before.scans.some(n=>!n.condition.includes('row_number')&&n.actual>50000),'Legacy fixture must reproduce the broad scan');
  assert.ok(after.blocks*20<before.blocks,'At least 20x less buffer work in the reproduced regression');
  const policy=createReviewBatchPolicy({maximumRows:50,budgetMs:750});
  policy.observe('apply',{preparedRows:16,reviewedRows:1,durationMs:1300});assert.equal(policy.limit('apply'),1);
  const packetSizes=[];
  for(let i=0;i<20&&policy.limit('apply')<50;i++){
   const size=policy.limit('apply'),rows=Array.from({length:size},(_,i)=>3+4*i),started=performance.now();
   await f.postgres.transaction(async tx=>{
    assert.equal((await tx.execute(B.markUpdatesApplied,{runId:target.id,rows})).rowsAffected,size);
    throw new Error('Synthetic rollback of measured packet');
   }).catch(error=>{assert.equal(error.message,'Synthetic rollback of measured packet');});
   const durationMs=performance.now()-started;policy.observe('apply',{preparedRows:size,reviewedRows:size,durationMs});packetSizes.push({size,durationMs});
  }
  assert.ok(policy.limit('apply')>1,'Repaired calls must allow the existing adaptive policy to recover');
  assert.equal((await f.client.query("SELECT count(*)::int n FROM integration.data_import_rows WHERE run_id=$1 AND state='applied'",[target.id])).rows[0].n,0);
  process.stdout.write(JSON.stringify({kind:'import-state-volume-proof',rows:237893,productionContact:false,measurements,packetSizes,nextPacketSize:policy.limit('apply')})+'\n');
 }finally{
  await f.client.query('ROLLBACK');await f.client.query('RESET plan_cache_mode');
  const old=(options||[]).find(v=>v.startsWith('autovacuum_enabled='));
  await f.client.query(old?'ALTER TABLE integration.data_import_rows SET ('+old+')':'ALTER TABLE integration.data_import_rows RESET (autovacuum_enabled)');
 }
}));
