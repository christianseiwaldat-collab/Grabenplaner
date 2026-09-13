'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {masterFixture,raw,articleSnapshot,article,TIME}=require('../test-support/postgresql-migration/trade-fixture');
const M=require('../lib/tradefoto-master-profiles');
const {createSalesArticleCatalogRepository}=require('../lib/persistence/repositories/sales-article-catalog');
const {createSalesArticleImagesRepository}=require('../lib/persistence/repositories/sales-article-images');
const {createSalesSchemaPlan}=require('../lib/persistence/postgresql/sales/schema');
const {createSalesCatalog}=require('../lib/persistence/postgresql/sales/catalog');
const live={skip:process.env.GP_PG_MIGRATION_LIVE!=='1'};
test('Block 6 pins all Trade tables, typed triggers and SQL statements',()=>{
  assert.deepEqual(createSalesSchemaPlan(6).sourceCounts,{tables:34,indexes:25,triggers:29});
  assert.equal(createSalesCatalog(6).entries.length,194);
});
test('Live Block 6 all 66 master profiles preserve encrypted source values and match SQLite',live,()=>withSalesFixture(6,async f=>{
  const pg=masterFixture(f.postgres,f.protection),sq=masterFixture(f.sqliteProvider,f.protection);
  const include=['attributes','contacts','addresses','notes','conditions','media_references','loyalty_snapshot','provenance','financial','legacy_personnel','prices','costs'];
  let n=0;const identities=new Map();
  for(const table of M.TRADEFOTO_MASTER_METADATA.tables){
    const row=raw(table.name);for(const key of table.keys||[])row[key]='synthetic-key';
    const a=await pg.ingest(table.name,[row]),b=await sq.ingest(table.name,[row]);assert.equal(a.status,'applied');assert.equal(a.id,b.id);
    const record=(await f.client.query('SELECT id FROM trade.import_master_records WHERE source_table=$1',[table.name])).rows[0];
    const sourceRecord=f.sqlite.prepare('SELECT id FROM import_master_records WHERE source_table=?').get(table.name);
    identities.set(record.id,sourceRecord.id);
    const av=await pg.service.inspect(record.id,{include}),bv=await sq.service.inspect(sourceRecord.id,{include});
    const aligned=JSON.parse(JSON.stringify(av,(_key,value)=>identities.get(value)||value));
    assert.equal(av.revision,1,table.name);assert.deepEqual(aligned,bv,table.name);
    if(++n%10===0)process.stdout.write('# Trade profiles verified: '+n+'/66\n');
  }
  const memo='Synthetic <script>never execute</script>\u001f'+'x'.repeat(89000);
  await pg.ingest('ARTIKEL_STAMM',[raw('ARTIKEL_STAMM',{EAN:'000-memo',AKurzbeschreibung:memo})]);
  const records=(await f.client.query("SELECT id FROM trade.import_master_records WHERE source_table='ARTIKEL_STAMM' ORDER BY id")).rows;
  const views=await Promise.all(records.map(r=>pg.service.inspect(r.id)));
  assert.ok(views.some(v=>v.segments.attributes.AKurzbeschreibung===memo));
  const encrypted=(await f.client.query('SELECT payload FROM trade.import_master_segments')).rows;
  assert.ok(!JSON.stringify(encrypted).includes('never execute'));assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_customers').get().n,0);
}));
test('Live Block 6 article imports, exact prices, search, undo and own images survive source updates',live,()=>withSalesFixture(6,async f=>{
  const pg=createSalesArticleCatalogRepository(f.postgres),sq=createSalesArticleCatalogRepository(f.sqliteProvider),images=createSalesArticleImagesRepository(f.postgres);
  const prices=[{priceType:'sales',amount:'13.67144267874',currency:'EUR',priceBasis:'gross',qualityStatus:'confirmed',sourceField:'Verkaufspreis'}];
  for(const access of [pg,sq]){const v=articleSnapshot(1,[article('001234',1,prices),article('1234')]);await access.importSnapshot(v);assert.equal((await access.importSnapshot(v)).replayed,true);}
  const before=await pg.getByArticleNumber('001234');assert.equal(before.prices[0].amount,'13.671442678740');
  assert.equal((await f.client.query('SELECT amount::text AS amount FROM trade.sales_article_price_snapshots')).rows[0].amount,'13.671442678740');
  const pgs=await pg.search({query:'KAMERA',sort:'articleNumber',direction:'asc',limit:5,offset:0});
  const sqs=await sq.search({query:'KAMERA',sort:'articleNumber',direction:'asc',limit:5,offset:0});
  const business=v=>({...v,items:v.items.map(({productId,...data})=>data)});
  assert.deepEqual(business(pgs),business(sqs));assert.equal(pgs.total,2);
  const buffer=await require('sharp')({create:{width:32,height:32,channels:3,background:'#256c48'}}).webp().toBuffer();
  const saved=await images.save({articleNumber:'001234',productId:before.productId,expectedRevision:null,image:{buffer,mime:'image/webp',width:32,height:32},actor:'00001'});
  const imported=await pg.importSnapshot(articleSnapshot(2,[article('001234',2,prices),article('1234',2)]));
  assert.equal((await images.metadata('001234')).revision,saved.revision);assert.equal((await images.metadata('1234')).present,false);
  const preview=await pg.inspectImportUndo({snapshotId:imported.snapshot.id});assert.equal(preview.canUndo,true);
  await pg.undoImport({snapshotId:imported.snapshot.id,expectedImpactSha256:preview.impactSha256,actor:'00001',timestamp:TIME,undoId:crypto.randomUUID()});
  assert.equal((await pg.getByArticleNumber('001234')).description,'Synthetische Kamera 1');assert.deepEqual((await images.content('001234')).buffer,buffer);
  await assert.rejects(images.save({articleNumber:'001234',productId:before.productId,expectedRevision:null,image:null,actor:'00001'}),e=>e.code==='ARTICLE_IMAGE_CONFLICT');
  const audit=(await f.client.query('SELECT count(*)::int AS n FROM integration.core_audit_outbox')).rows[0].n;assert.ok(audit>=4);
  await f.client.query("UPDATE trade.sales_article_own_images SET sha256=$1 WHERE article_number='001234'",['0'.repeat(64)]);
  await assert.rejects(images.content('001234'),e=>e.code==='ARTICLE_IMAGE_INTEGRITY');
}));
test('Live Block 6 manual article writes enforce revisions, uniqueness and audit rollback',live,()=>withSalesFixture(6,async f=>{
  const catalog=createSalesArticleCatalogRepository(f.postgres);
  const call=input=>({input,actor:'00001',timestamp:TIME,mutationId:crypto.randomUUID()});
  const created=await catalog.createManual(call({articleNumber:'A/100',description:'Synthetisch',identifiers:[],prices:{sales:[{priceType:'sales',amount:'19.90',currency:'EUR',priceBasis:'gross'}],costs:[{priceType:'average_purchase',amount:'10',currency:'EUR',priceBasis:'net'}]}}));
  assert.equal(created.outcome,'created');assert.equal(created.article.currentRevision,1);
  const input={currentArticleNumber:'A/100',articleNumber:'A/100',expectedRevision:1,description:'Geändert',identifiers:[]};
  assert.equal((await catalog.updateManual(call(input))).outcome,'updated');assert.equal((await catalog.updateManual(call(input))).outcome,'conflict');
  const changed=await catalog.getByArticleNumber('A/100');assert.equal(changed.prices.length,2);
  await catalog.archiveManual(call({articleNumber:'A/100',expectedRevision:2}));
  await catalog.restoreManual({productId:created.article.productId,expectedRevision:3,restoreRevision:2,actor:'00001',timestamp:TIME,mutationId:crypto.randomUUID()});
  assert.equal((await catalog.getByArticleNumber('A/100')).active,true);
  const copied=await catalog.copyManual(call({sourceArticleNumber:'A/100',expectedRevision:4,articleNumber:'A/101'}));assert.equal(copied.outcome,'created');
  const count=async()=>(await f.client.query('SELECT count(*)::int n FROM integration.core_audit_outbox')).rows[0].n;
  const before=await count();
  await assert.rejects(catalog.createManual(call({articleNumber:'A/101',description:'Duplicate',identifiers:[]})));
  assert.equal(await count(),before);assert.equal((await catalog.listRevisions(created.article.productId)).length,4);
}));
