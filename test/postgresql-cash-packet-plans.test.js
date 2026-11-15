'use strict';
// Owned synthetic selector fixtures only. Skipped native groups are not proof.
// GP_PG_MIGRATION_LIVE=1 enables native semantics; volume additionally requires
// GP_CASH_PACKET_VOLUME_CHECK=1. Never use production URLs or business sources.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {createCashSnapshotStore}=require('../lib/persistence/repositories/cash-snapshots');
const {CASH_SNAPSHOT_STATEMENTS:S,CASH_SNAPSHOT_TABLES:TABLES,CASH_SNAPSHOT_COLUMNS}=require('../lib/persistence/statements/cash-snapshots');
const {IMPORT_BATCHES:B}=require('../lib/persistence/statements/import-batches');
const {CASH_PUBLICATION_BATCHES:P}=require('../lib/persistence/statements/cash-publication-batches');
const {IMPORT_BATCH_CATALOG}=require('../lib/persistence/postgresql/sales/import-batches');
const {CASH_PUBLICATION_BATCH_CATALOG}=require('../lib/persistence/postgresql/sales/cash-publication-batches');
const {createSalesCatalog}=require('../lib/persistence/postgresql/sales/catalog');
const {createSalesSchemaPlan}=require('../lib/persistence/postgresql/sales/schema');
const native=process.env.GP_PG_MIGRATION_LIVE==='1';
const volume=native&&process.env.GP_CASH_PACKET_VOLUME_CHECK==='1';
const TIME='2026-10-15T12:00:00.000Z';
const actor={scopeId:'synthetic-cash-packets',ownerId:'synthetic-cash-packet-owner'};
const parents={KassenJournal_Details:'KassenJournal',Umsatz_Kasse_Details:'Umsatz_KASSE'};
const historical=createSalesCatalog(8).entries;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const md5=value=>crypto.createHash('md5').update(value).digest('hex');
// Deterministic synthetic 32-byte selector values, intentionally shared by both
// datasets. These are not production HMAC identities or a cash-decoder fixture.
const sourceKey=(index,ordinal)=>md5('cash-packet-a:'+index+':'+ordinal)+md5('cash-packet-b:'+index+':'+ordinal);
const projection=table=>historical.find(e=>e.statement===table.statements.page).sql.split(' WHERE ')[0];
const qualified=table=>'kassa."'+table.sqlName+'"';
const families=Object.freeze(TABLES.flatMap((table,index)=>[
  {kind:'keys',index,table,statement:B.cashKeys[index],catalog:IMPORT_BATCH_CATALOG,parameter:'keys',
    // Only the projection comes from the pinned historical catalog. The old
    // predicate is frozen here, not reconstructed from the candidate SQL.
    previous:projection(table)+" WHERE dataset_slot=$1::bigint AND source_key IN (SELECT decode(value,'hex') FROM jsonb_array_elements_text($2::jsonb))"},
  {kind:'rows',index,table,statement:P.rows[index],catalog:CASH_PUBLICATION_BATCH_CATALOG,parameter:'rows',
    previous:projection(table)+' WHERE dataset_slot=$1::bigint AND source_row IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb))'},
]));
const entry=family=>family.catalog.find(e=>e.statement===family.statement);
const input=(family,datasetSlot,values)=>({datasetSlot,[family.parameter]:values});
const normalize=rows=>rows.map(row=>({...row,datasetSlot:Number(row.datasetSlot),sourceRow:Number(row.sourceRow),
  parentRow:row.parentRow===null?null:Number(row.parentRow),
  ...Object.fromEntries(['sourceKey','locationKey','sellerKey','customerKey','articleKey']
    .map(key=>[key,row[key]===null?null:Buffer.from(row[key]).toString('hex')]))}))
  .sort((a,b)=>a.datasetSlot-b.datasetSlot||a.sourceRow-b.sourceRow);
const packet=(family,numbers)=>family.kind==='keys'?numbers.map(number=>number===null?null:sourceKey(family.index,number)):numbers;

async function dataset(f,label,count,indexes=TABLES.map((_,i)=>i)){
 const id=sha('synthetic-cash-packet-dataset-'+label),fileSha256=sha('synthetic-cash-packet-file-'+label);
 const store=createCashSnapshotStore({access:f.postgres,protection:f.protection,actor,clock:()=>TIME});
 await store.begin(id,{kind:'cash',fileSha256,bytes:4096,tables:TABLES.map((table,index)=>({name:table.name,
  profileHash:table.profile.fingerprint,declaredRows:indexes.includes(index)?count:0}))});
 const row=await f.postgres.queryOne(S.get,{id,...actor});assert.ok(row);
 return row;
}
function row(f,datasetRow,index,ordinal){
 const table=TABLES[index],key=Buffer.from(sourceKey(index,ordinal),'hex');
 return {datasetSlot:datasetRow.slot,sourceRow:ordinal,sourceKey:key,businessDate:ordinal%2?'2026-10-15':null,
  parentRow:parents[table.name]?ordinal:null,locationKey:ordinal%2?Buffer.from(sha('synthetic-location'),'hex'):null,
  sellerKey:null,customerKey:null,articleKey:null,
  payload:f.protection.seal({syntheticSelectorFixture:true,dataset:datasetRow.id,table:index,ordinal},
    ['synthetic-cash-selector-row',datasetRow.id,index,ordinal])};
}
async function small(f,label){
 const target=await dataset(f,label+'-target',8),foreign=await dataset(f,label+'-foreign',8);
 // Both parent tables are inserted before either child table. Parent ordinal
 // and dataset slot satisfy the original composite foreign keys exactly.
 const order=TABLES.map((_,index)=>index).sort((a,b)=>Number(!!parents[TABLES[a].name])-Number(!!parents[TABLES[b].name]));
 for(const index of order)for(const datasetRow of [target,foreign])for(let ordinal=1;ordinal<=8;ordinal++)
  await f.postgres.execute(TABLES[index].statements.insert,row(f,datasetRow,index,ordinal));
 return {target,foreign};
}
async function evidence(f){
 return {datasets:(await f.client.query('SELECT * FROM kassa.cash_snapshot_datasets ORDER BY slot')).rows,
  inventory:(await f.client.query('SELECT * FROM kassa.cash_snapshot_inventory ORDER BY dataset_slot,table_index')).rows,
  tables:await Promise.all(TABLES.map(async table=>(await f.client.query('SELECT * FROM '+qualified(table)+' ORDER BY dataset_slot,source_row')).rows))};
}
async function expected(f,family,datasetSlot,numbers){
 const rows=await f.postgres.queryAll(family.table.statements.page,{datasetSlot,after:0,limit:100});
 return normalize(rows.filter(row=>numbers.includes(Number(row.sourceRow))));
}

test('all fourteen cash packet selectors retain their parameters and columns beside unchanged historical catalogs',()=>{
 assert.equal(TABLES.length,7);assert.equal(families.length,14);
 const before=JSON.stringify(historical),schema=createSalesSchemaPlan(5).statements;
 for(const table of TABLES){
  const ddl=schema.find(statement=>statement.id===table.sqlName).sql;
  assert.match(ddl,/dataset_slot BIGINT NOT NULL/);
  assert.match(ddl,/source_key BYTEA NOT NULL/);
  assert.match(ddl,/UNIQUE \( dataset_slot , source_key \)/,
   'LIMIT 1 is equivalent only because every exact dataset/key pair is already unique');
 }
 for(const family of families){
  const current=entry(family);assert.ok(current);assert.equal(family.statement.operation,'queryAll');
  assert.deepEqual(current.parameterOrder,['datasetSlot',family.parameter]);
  assert.deepEqual(family.statement.columns,family.table.statements.page.columns);
  assert.deepEqual(Object.keys(family.statement.columns),Object.keys(CASH_SNAPSHOT_COLUMNS.ROW));
  if(family.kind==='keys'){
   assert.match(current.sql,/WITH wanted AS MATERIALIZED \(\s*SELECT DISTINCT \$1::bigint AS dataset_slot,decode\(value,'hex'\) AS source_key FROM jsonb_array_elements_text\(\$2::jsonb\)\s*\) SELECT found\.\* FROM wanted CROSS JOIN LATERAL \(/);
   assert.match(current.sql,/WHERE dataset_slot=wanted\.dataset_slot AND source_key=wanted\.source_key LIMIT 1\s*\) found$/);
   assert.doesNotMatch(current.sql,/source_key = ANY|SELECT DISTINCT value/);
  }else {
   assert.match(current.sql,/WHERE dataset_slot=\$1::bigint AND/);
   assert.match(current.sql,/source_row = ANY\(ARRAY\(SELECT value::bigint FROM jsonb_array_elements_text\(\$2::jsonb\)\)\)/);
  }
  assert.notEqual(current.sql,family.previous);assert.doesNotMatch(current.sql,/\bIN \(SELECT/);
 }
 assert.equal(JSON.stringify(createSalesCatalog(8).entries),before,'Runtime packets never change the pinned migration catalog');
 assert.equal(TABLES[1].name,'Umsatz_KASSE');assert.equal(TABLES[6].name,'Umsatz_Kasse_Details');
});

test('Native all fourteen cash packets preserve dataset scope, ciphertext, duplicates, empty/null packets and read-only replay',
 {skip:!native},()=>withSalesFixture(8,async f=>{
 const {target,foreign}=await small(f,'semantics'),before=await evidence(f);
 assert.notEqual(target.id,foreign.id);assert.notEqual(target.slot,foreign.slot);
 for(const family of families){
  for(const [datasetSlot,numbers] of [[target.slot,[8,2,8,999999,0]],[foreign.slot,[1,3]],
   [target.slot,[]],[999999,[1,2]],[target.slot,[0,-1,999999]],[target.slot,[1,null]]]){
   const values=packet(family,numbers),wanted=await expected(f,family,datasetSlot,numbers);
   const current=await f.postgres.transaction(tx=>tx.queryAll(family.statement,input(family,datasetSlot,values)),
    {readOnly:true,isolation:'serializable'});
   assert.deepEqual(normalize(current),wanted);
   assert.deepEqual(normalize(await f.postgres.queryAll(family.statement,input(family,datasetSlot,values))),wanted,'Read replay is stable');
   const previous=await f.client.query(family.previous,[datasetSlot,JSON.stringify(values)]);
   assert.deepEqual(normalize(previous.rows),wanted,'Frozen old and candidate SQL select identical complete rows');
  }
  if(family.kind==='keys'){
   const lower=sourceKey(family.index,2),values=[lower,lower.toUpperCase(),'',null];
   const current=await f.postgres.queryAll(family.statement,input(family,target.slot,values));
   assert.equal(current.length,1,'DISTINCT decoded bytea prevents mixed-case keys from multiplying the one matching row');
   assert.deepEqual(normalize(current),await expected(f,family,target.slot,[2]));
   assert.deepEqual(normalize((await f.client.query(family.previous,[target.slot,JSON.stringify(values)])).rows),normalize(current),
    'Mixed-case, empty and null keys retain the frozen IN-selector semantics');
  }
 }
 assert.deepEqual(await evidence(f),before,'All reads preserve encrypted rows, dataset metadata and inventory generations');
}));

test('Native all fourteen cash packets reject malformed arrays atomically and retain read-only and foreign-key guards',
 {skip:!native},()=>withSalesFixture(8,async f=>{
 const {target,foreign}=await small(f,'malformed'),before=await evidence(f);
 for(const family of families){
  const bad=family.kind==='keys'?
   [[sourceKey(family.index,1),'zz'],[sourceKey(family.index,1),'0'],[sourceKey(family.index,1),{}],{not:'an-array'}]:
   [[1,'not-a-number'],[1,'9223372036854775808'],[1,1.5],{not:'an-array'}];
  for(const values of bad){
   await assert.rejects(f.postgres.transaction(async tx=>{
    // A later malformed selector must roll back an earlier valid owned write.
    await tx.execute(TABLES[0].statements.insert,row(f,target,0,99));
    await tx.queryAll(family.statement,input(family,target.slot,values));
   }));
   assert.deepEqual(await evidence(f),before);
  }
 }
 await assert.rejects(f.postgres.transaction(async tx=>{
  await tx.queryAll(B.cashKeys[0],{datasetSlot:target.slot,keys:[sourceKey(0,1)]});
  await tx.execute(TABLES[0].statements.insert,row(f,target,0,99));
 },{readOnly:true,isolation:'serializable'}));
 assert.deepEqual(await evidence(f),before,'Read-only queries cannot open a write path');
 // A parent in a foreign dataset must never satisfy the child composite FK.
 await f.postgres.execute(TABLES[1].statements.insert,row(f,foreign,1,99));
 const withForeignParent=await evidence(f);
 await assert.rejects(f.postgres.transaction(async tx=>{
  await tx.execute(TABLES[0].statements.insert,row(f,target,0,99));
  await tx.execute(TABLES[6].statements.insert,row(f,target,6,99));
 }));
 assert.deepEqual(await evidence(f),withForeignParent);
}));

async function insertVolume(f,datasetRow,index,count){
 const table=TABLES[index],parent=parents[table.name]?'g':'NULL';
 // SQL rows are selector-only encrypted synthetic fixtures. They do not claim
 // to be complete cash source payloads, pass decoder validation or activate data.
 const payload=f.protection.seal({syntheticSelectorVolume:true,dataset:datasetRow.id,table:index},
  ['synthetic-cash-selector-volume',datasetRow.id,index]);
 for(let offset=0;offset<count;offset+=10000){
  await f.client.query(`INSERT INTO ${qualified(table)}
   (dataset_slot,source_row,source_key,business_date,parent_row,location_key,seller_key,customer_key,article_key,payload)
   SELECT $1,g,decode(md5('cash-packet-a:'||$5::text||':'||g::text)||md5('cash-packet-b:'||$5::text||':'||g::text),'hex'),
    NULL,${parent},NULL,NULL,NULL,NULL,$4
   FROM generate_series($2::int,$3::int)g`,[datasetRow.slot,offset+1,Math.min(offset+10000,count),payload,String(index)]);
 }
}
function nodes(plan){return [plan,...(plan.Plans||[]).flatMap(nodes)];}
function exactKeyProbeEvidence(explain,table,uniqueKeys){
 const scans=nodes(explain.Plan).filter(node=>node['Relation Name']===table.sqlName);
 assert.ok(scans.length>0,'The expected target cash table must actually be read');
 const accesses=new Set(),measuredScans=[];
 for(const scan of scans){
  assert.ok(['Index Scan','Index Only Scan','Bitmap Heap Scan'].includes(scan['Node Type']),
   'A bounded key probe must use an index, never a full target-dataset scan');
  const indexNodes=nodes(scan).filter(node=>typeof node['Index Cond']==='string');
  assert.ok(indexNodes.length>0,'A heap recheck or filter alone is not an index-key condition');
  const conditions=indexNodes.map(node=>node['Index Cond']).join(' AND ');
  assert.match(conditions,/\bdataset_slot\b\s*=/,'The actual target-table index access must bind the dataset slot');
  assert.match(conditions,/\bsource_key\b\s*=/,'The actual target-table index access must probe the decoded source key');
  indexNodes.forEach(node=>accesses.add(node));
  measuredScans.push(probeVisits(scan,uniqueKeys));
 }
 const measuredAccesses=[...accesses].map(node=>probeVisits(node,uniqueKeys));
 assert.ok(measuredScans.reduce((sum,scan)=>sum+scan.visitedRows,0)<=uniqueKeys,
  'The target relation may visit at most its one exact matching row per distinct fixture key');
 return {uniqueProbeKeys:uniqueKeys,relationScans:measuredScans,indexAccesses:measuredAccesses};
}
function probeVisits(node,uniqueKeys){
 // EXPLAIN reports rows and removals as per-loop averages. Multiplying by
 // Actual Loops exposes a dataset-prefix scan even if LIMIT emits one row.
 const rows=node['Actual Rows']||0,filtered=node['Rows Removed by Filter']||0,
  rechecked=node['Rows Removed by Index Recheck']||0,loops=node['Actual Loops']||0;
 const visitedPerLoop=rows+filtered+rechecked,visitedRows=visitedPerLoop*loops;
 assert.ok(Number.isFinite(loops)&&loops>=0&&loops<=uniqueKeys,'No more index probes than distinct known fixture keys');
 assert.ok(visitedPerLoop<=1,'The unique composite fixture keys need at most one visited row per index-probe loop');
 assert.ok(visitedRows<=uniqueKeys,'Filtered or rechecked dataset-prefix rows must not hide behind a one-row LIMIT');
 return {node:node['Node Type'],index:node['Index Name']||null,condition:node['Index Cond']||null,
  rowsPerLoop:rows,removedByFilterPerLoop:filtered,removedByRecheckPerLoop:rechecked,loops,visitedRows};
}
function summarize(explain,table){
 return {milliseconds:explain['Execution Time'],planningMs:explain['Planning Time'],
  blocks:(explain.Plan['Shared Hit Blocks']||0)+(explain.Plan['Shared Read Blocks']||0),
  scans:nodes(explain.Plan).filter(node=>node['Relation Name']===table.sqlName)
   .map(node=>({node:node['Node Type'],index:node['Index Name']||null,
    condition:node['Index Cond']||node['Recheck Cond']||null,filter:node.Filter||null,
    estimated:node['Plan Rows'],actual:node['Actual Rows'],loops:node['Actual Loops'],
    removedByFilter:node['Rows Removed by Filter']||0,removedByRecheck:node['Rows Removed by Index Recheck']||0}))};
}

test('Native cash packet plans compare both families on parent/detail volume with stale/current statistics and custom/generic plans',
 {skip:!volume,timeout:600000},()=>withSalesFixture(8,async f=>{
 const indexes=[1,6],targetCount=237893,foreignCount=10000;
 const target=await dataset(f,'volume-target',targetCount,indexes),foreign=await dataset(f,'volume-foreign',foreignCount,indexes);
 const settings=[],measurements=[],relations=indexes.map(index=>qualified(TABLES[index]));
 const count=async(index,slot)=>(await f.client.query('SELECT count(*)::int n FROM '+qualified(TABLES[index])+' WHERE dataset_slot=$1',[slot])).rows[0].n;
 const initialPlanMode=(await f.client.query('SHOW plan_cache_mode')).rows[0].plan_cache_mode;
 assert.ok(['auto','force_custom_plan','force_generic_plan'].includes(initialPlanMode));
 try{
  for(const relation of relations){
   settings.push({relation,options:(await f.client.query('SELECT reloptions FROM pg_class WHERE oid=$1::regclass',[relation])).rows[0].reloptions||[]});
   await f.client.query('ALTER TABLE '+relation+' SET (autovacuum_enabled=false)');
  }
  // Both parent populations precede either matching detail population.
  for(const index of indexes)await insertVolume(f,foreign,index,foreignCount);
  for(const relation of relations)await f.client.query('ANALYZE '+relation);
  for(const index of indexes)await insertVolume(f,target,index,targetCount);
  for(const index of indexes){assert.equal(await count(index,target.slot),targetCount);assert.equal(await count(index,foreign.slot),foreignCount);}
  const metadataBefore=(await f.client.query('SELECT * FROM kassa.cash_snapshot_datasets ORDER BY slot')).rows;
  const inventoryBefore=(await f.client.query('SELECT * FROM kassa.cash_snapshot_inventory ORDER BY dataset_slot,table_index')).rows;
  for(const statistics of ['stale','current']){
   if(statistics==='current')for(const relation of relations)await f.client.query('ANALYZE '+relation);
   for(const mode of ['force_custom_plan','force_generic_plan']){
    await f.client.query('SET plan_cache_mode='+mode);
    for(const family of families.filter(item=>indexes.includes(item.index)))for(const [form,query] of [
     ['before',family.previous],['after',entry(family).sql],
    ]){
     const name='cash_packet_'+statistics+'_'+mode+'_'+family.index+'_'+family.kind+'_'+form;
     await f.client.query('PREPARE '+name+'(bigint,jsonb) AS '+query);
     try{for(const size of [1,20,200]){
      const numbers=Array.from({length:size},(_,index)=>targetCount-2*index),values=packet(family,numbers);
      // Only locally generated integer slots, ordinals and hex keys enter the
      // EXECUTE literal; no database value, source content or request is interpolated.
      const execute=`EXECUTE ${name}(${target.slot},'${JSON.stringify(values)}')`;
      await f.client.query('BEGIN READ ONLY');
      try{
       const explanation=(await f.client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+execute)).rows[0]['QUERY PLAN'][0];
       assert.equal(explanation.Plan['Actual Rows'],size);
       const measured=summarize(explanation,family.table);
       assert.ok(Number.isFinite(measured.milliseconds)&&measured.milliseconds>=0);
       if(family.kind==='keys'&&form==='after')
        measured.exactKeyProbes=exactKeyProbeEvidence(explanation,family.table,new Set(values.map(value=>Buffer.from(value,'hex').toString('hex'))).size);
       measurements.push({statistics,mode,form,family:family.kind,tableIndex:family.index,
        table:family.table.sqlName,statement:family.statement.id,size,...measured});
      }finally{await f.client.query('ROLLBACK');}
     }}finally{await f.client.query('DEALLOCATE '+name);}
    }
   }
   for(const index of indexes){assert.equal(await count(index,target.slot),targetCount);assert.equal(await count(index,foreign.slot),foreignCount);}
  }
  assert.deepEqual((await f.client.query('SELECT * FROM kassa.cash_snapshot_datasets ORDER BY slot')).rows,metadataBefore);
  assert.deepEqual((await f.client.query('SELECT * FROM kassa.cash_snapshot_inventory ORDER BY dataset_slot,table_index')).rows,inventoryBefore);
  const comparisons=measurements.filter(item=>item.form==='after').map(after=>{
   const before=measurements.find(item=>item.form==='before'&&item.statistics===after.statistics&&item.mode===after.mode
    &&item.family===after.family&&item.tableIndex===after.tableIndex&&item.size===after.size);
   return {statistics:after.statistics,mode:after.mode,family:after.family,tableIndex:after.tableIndex,size:after.size,
    beforeMs:before.milliseconds,afterMs:after.milliseconds,beforeBlocks:before.blocks,afterBlocks:after.blocks};
  });
  process.stdout.write(JSON.stringify({kind:'cash-packet-volume-proof',targetRowsPerTable:targetCount,
   foreignRowsPerTable:foreignCount,tableIndexes:indexes,productionContact:false,schemaOrIndexChanges:false,
   assumedPlanRegression:false,measurements,comparisons})+'\n');
 }finally{
  await f.client.query('ROLLBACK');await f.client.query('SET plan_cache_mode='+initialPlanMode);
  for(const {relation,options} of settings){
   const previous=options.find(value=>value.startsWith('autovacuum_enabled='));
   await f.client.query(previous?'ALTER TABLE '+relation+' SET ('+previous+')':'ALTER TABLE '+relation+' RESET (autovacuum_enabled)');
  }
 }
}));
