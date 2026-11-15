'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {insertArticlePrices,PRICE_PACKET_ROWS}=require('../lib/persistence/repositories/sales-article-price-batches');
const {INSERT_ARTICLE_PRICES}=require('../lib/persistence/statements/sales-article-price-batches');
const {SALES_ARTICLE_CATALOG_STATEMENTS:S}=require('../lib/persistence/statements/sales-article-catalog');
const {CATALOG}=require('../lib/persistence/postgresql/sales/article-price-batches');
const {article,articleSnapshot,TIME}=require('../test-support/postgresql-migration/trade-fixture');
const enabled=process.env.GP_PG_MIGRATION_LIVE==='1';
const row=i=>({id:crypto.randomUUID(),productId:'be130c45-c45b-4a4a-b181-66976f4456c4',sourceSnapshotId:'a'.repeat(64),priceType:'sales',
 amount:i===0?null:i===1?'0.000000000000':'36.229729729730',currency:'EUR',priceBasis:'unknown',qualityStatus:'unresolved',
 sourceField:'SyntheticPrice'+i,actor:'00001',timestamp:TIME});
const prices=()=>require('../lib/tradefoto-article-source-profile').TRADEFOTO_MONETARY_PRICE_FIELD_MAPPINGS.map((mapping,i)=>({...mapping,
 amount:i===0?null:i===1?'0.000000000000':'36.229729729730',currency:'EUR'}));

test('Article price packets preserve every typed scalar and bound each statement to 200 rows',async()=>{
 const rows=Array.from({length:401},(_,i)=>row(i)),calls=[];
 await insertArticlePrices({importBatchReads:true,execute:async(statement,parameters)=>{calls.push({statement,parameters});return {rowsAffected:parameters.rows.length};}},rows);
 assert.equal(PRICE_PACKET_ROWS,200);assert.deepEqual(calls.map(c=>c.parameters.rows.length),[200,200,1]);
 assert.ok(calls.every(c=>c.statement===INSERT_ARTICLE_PRICES));
 assert.deepEqual(calls.flatMap(c=>c.parameters.rows),rows);assert.equal(new Set(rows.map(r=>r.id)).size,401);
});
test('Article prices keep the original statement and scalar values without installed packet capability',async()=>{
 const rows=[row(0),row(1),row(2)],calls=[];
 await insertArticlePrices({execute:async(statement,parameters)=>{calls.push({statement,parameters});return {rowsAffected:1};}},rows);
 assert.ok(calls.every(c=>c.statement===S.insertPriceSnapshot));assert.deepEqual(calls.map(c=>c.parameters),rows);
});
test('Malformed packet rows fail their original scalar contract before any execute',async()=>{
 for(const invalid of [{...row(1),amount:3},{...row(1),extra:'unqualified'},{...row(1),timestamp:'not-utc'},Object.fromEntries(Object.entries(row(1)).filter(([k])=>k!=='actor'))]){
  let calls=0;await assert.rejects(insertArticlePrices({importBatchReads:true,execute:async()=>{calls++;}},[row(0),invalid]),e=>e.code==='PERSISTENCE_STATEMENT_INVALID');assert.equal(calls,0);
 }
});
test('Price packet row-count mismatch requires rollback and empty prices execute nothing',async()=>{
 await assert.rejects(insertArticlePrices({importBatchReads:true,execute:async()=>({rowsAffected:0})},[row(0)]),e=>e.code==='PERSISTENCE_RETRYABLE_TRANSACTION');
 let calls=0;await insertArticlePrices({importBatchReads:true,execute:async()=>{calls++;}},[]);assert.equal(calls,0);
});
test('The packet is a single typed insert into the existing price relation without DDL, upserts or trigger changes',()=>{
 assert.equal(CATALOG.length,1);assert.equal(CATALOG[0].statement,INSERT_ARTICLE_PRICES);assert.deepEqual(CATALOG[0].parameterOrder,['rows']);
 assert.match(CATALOG[0].sql,/INSERT INTO trade\.sales_article_price_snapshots/);assert.match(CATALOG[0].sql,/jsonb_to_recordset\(\$1::jsonb\)/);
 assert.match(CATALOG[0].sql,/v\.amount::numeric/);assert.doesNotMatch(CATALOG[0].sql,/::(?:timestamptz|uuid)\b/);
 assert.doesNotMatch(CATALOG[0].sql,/\b(?:CREATE|ALTER|DROP|TRUNCATE|UPDATE|DELETE|CONFLICT)\b/i);
});

async function fixture(work){
 const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture'),{withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
 return withCoreFixture(core=>withSalesFixture(8,async sales=>{
  await core.application.close();await sales.application.close();const state={allowed:true};
  const app=await require('../lib/persistence/postgresql/boundary/application').openTwoDatabaseDevelopmentApplication({
   coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,autoDeliver:true,authorize:async()=>state.allowed});
  try{return await work({core,sales,state,app,access:app.provider});}finally{await app.close();}
 }));
}
test('Native article imports write all 35 prices per article, refresh search, replay and deliver real audits',{skip:!enabled},()=>fixture(async f=>{
 const Client=f.sales.client.constructor,original=Client.prototype.query;let bulkCalls=0,singleCalls=0;
 const single=require('../lib/persistence/postgresql/sales/catalog').compileSalesEntry(require('../lib/persistence/catalogs/application-catalog').SQLITE_APPLICATION_CATALOG.find(e=>e.statement===S.insertPriceSnapshot),8).providerEntry.sql;
 Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text;if(sql===CATALOG[0].sql)bulkCalls++;if(sql===single)singleCalls++;return original.apply(this,args);};
 try{
  const repo=require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(f.access),articles=Array.from({length:5},(_,i)=>article('40000'+i,1,prices())),request=articleSnapshot(1,articles);
  const preview=await repo.inspectImportSnapshot({snapshot:request.snapshot});assert.ok(preview.rows.every(r=>r.action==='create'));
  const result=await repo.importSnapshot({...request,expectedStateSha256:preview.stateSha256});assert.equal(result.replayed,false);
  assert.equal(bulkCalls,5);assert.equal(singleCalls,0);
  const stored=(await f.sales.client.query('SELECT id,source_field,amount::text,currency::text,price_basis,quality_status,created_by,created_at FROM trade.sales_article_price_snapshots ORDER BY source_field,id')).rows;
  assert.equal(stored.length,175);assert.equal(new Set(stored.map(r=>r.id)).size,175);
  for(const field of prices()){
   const matching=stored.filter(r=>r.source_field===field.sourceField);assert.equal(matching.length,5);
   assert.ok(matching.every(r=>r.amount===field.amount&&r.currency===field.currency&&r.price_basis===field.priceBasis&&r.quality_status===field.qualityStatus&&r.created_by==='00001'&&r.created_at===TIME&&r.created_at.length===24));
  }
  assert.equal((await f.sales.client.query('SELECT count(*)::int n FROM trade.sales_article_search_dirty')).rows[0].n,0);
  const audit=(await f.sales.client.query('SELECT count(*)::int n FROM integration.core_audit_outbox')).rows[0].n;
  assert.equal(audit,6);assert.equal((await f.core.migrator.query('SELECT count(*)::int n FROM gp.sales_audit_inbox')).rows[0].n,audit);
  assert.equal((await f.sales.client.query('SELECT count(*)::int n FROM integration.core_audit_delivery')).rows[0].n,audit);
  assert.equal((await repo.importSnapshot(request)).replayed,true);assert.equal(bulkCalls,5);
  assert.equal((await f.sales.client.query('SELECT count(*)::int n FROM trade.sales_article_price_snapshots')).rows[0].n,175);
 }finally{Client.prototype.query=original;}
}));
test('Native price packets preserve commit authorization, atomic rollback and database uniqueness guards',{skip:!enabled},()=>fixture(async f=>{
 const {createSalesArticleCatalogRepository}=require('../lib/persistence/repositories/sales-article-catalog'),support=require('../lib/persistence/repositories/import-batch-support');
 const request=articleSnapshot(1,[article('410001',1,prices())]);
 await assert.rejects(f.access.transaction(async tx=>{
  support.enableImportBatches(tx);await createSalesArticleCatalogRepository(tx).importSnapshot(request);f.state.allowed=false;
 },{isolation:'serializable'}));f.state.allowed=true;
 for(const table of ['sales_articles','sales_article_revisions','sales_article_price_snapshots'])assert.equal((await f.sales.client.query('SELECT count(*)::int n FROM trade.'+table)).rows[0].n,0);
 assert.equal((await f.sales.client.query('SELECT count(*)::int n FROM integration.core_audit_outbox')).rows[0].n,0);
 const repo=createSalesArticleCatalogRepository(f.access);await repo.importSnapshot(request);
 const product=await repo.getByArticleNumber('410001'),existing=(await f.sales.client.query('SELECT id::text,source_snapshot_id FROM trade.sales_article_price_snapshots LIMIT 1')).rows[0];
 const duplicate={...row(91),id:existing.id,productId:product.productId,sourceSnapshotId:existing.source_snapshot_id};
 for(const [timezone,datestyle]of [['Pacific/Auckland','SQL, DMY'],['America/Los_Angeles','Postgres, MDY']]){
  await f.sales.client.query('BEGIN');
  try{
   await f.sales.client.query("SELECT set_config('TimeZone',$1,true),set_config('DateStyle',$2,true)",[timezone,datestyle]);
   const exact={...duplicate,id:crypto.randomUUID()};await f.sales.client.query(CATALOG[0].sql,[JSON.stringify([exact])]);
   const saved=(await f.sales.client.query('SELECT id,product_id,created_at,length(created_at)::int length FROM trade.sales_article_price_snapshots WHERE id=$1',[exact.id])).rows[0];
   assert.deepEqual(saved,{id:exact.id,product_id:product.productId,created_at:TIME,length:24});
  }finally{await f.sales.client.query('ROLLBACK');}
 }
 await assert.rejects(f.access.transaction(tx=>insertArticlePrices({importBatchReads:true,execute:(s,p)=>tx.execute(s,p)},[{...duplicate,id:crypto.randomUUID()},duplicate]),{isolation:'serializable'}),e=>e.code==='PERSISTENCE_UNIQUE_VIOLATION');
 assert.equal((await f.sales.client.query('SELECT count(*)::int n FROM trade.sales_article_price_snapshots')).rows[0].n,35);
 assert.equal((await repo.importSnapshot(request)).replayed,true);
}));
