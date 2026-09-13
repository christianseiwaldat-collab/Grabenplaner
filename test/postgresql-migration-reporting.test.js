'use strict';
const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const {withReportFixture,reportQuery}=require('../test-support/postgresql-migration/report-fixture');
const {receipt,sourceRows}=require('../test-support/postgresql-migration/cash-fixture');
const {createSalesSchemaPlan}=require('../lib/persistence/postgresql/sales/schema');
const {createSalesCatalog}=require('../lib/persistence/postgresql/sales/catalog');
const live={skip:process.env.GP_PG_MIGRATION_LIVE!=='1'};
test('Live Block 8 aggregate archive keeps exact metrics, source identity and the Core location reference atomic',live,()=>withReportFixture(async f=>{
  const {createSalesAnalyticsPersistenceRepository}=require('../lib/persistence/repositories/sales-analytics');
  const repository=createSalesAnalyticsPersistenceRepository(f.access);
  const preview=require('../test-support/postgresql-migration/aggregate-fixture').aggregatePreview();
  assert.equal(preview.reconciliation.status,'match');assert.equal(preview.issues.length,0);
  const input={preview,locationId:'18',currency:'EUR',confirmed:true,actor:'00001',timestamp:'2026-09-12T12:00:00.000Z'};
  await assert.rejects(repository.recordConfirmedTradeFotoReport({...input,locationId:'missing'}),e=>e.code==='PERSISTENCE_FOREIGN_KEY_VIOLATION'&&e.operation==='reporting-location-reference');
  assert.equal((await f.client.query('SELECT count(*)::int n FROM reporting.sales_branch_mapping_heads')).rows[0].n,0);
  const first=await repository.recordConfirmedTradeFotoReport(input),again=await repository.recordConfirmedTradeFotoReport(input);
  assert.equal(first.created,true);assert.equal(again.created,false);assert.equal(first.report.id,again.report.id);
  const bundle=await repository.getReportBundle(first.report.id);
  assert.equal(bundle.productGroupMetrics.length,2);assert.equal(bundle.totals.length,2);
  assert.equal(bundle.productGroupMetrics[0].currentNetRevenue,'100.0000');assert.equal(bundle.productGroupMetrics[0].currentGrossMargin,'25.0000');
  assert.equal((await repository.listActiveBranchMappings('tradefoto_report'))[0].locationId,'18');
  assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.core_location_references')).rows[0].n,1);
  await assert.rejects(f.client.query("UPDATE reporting.sales_aggregate_reports SET currency='USD' WHERE id=$1",[first.report.id]));
}));
test('Block 8 covers the remaining reporting schema and complete Sales SQL catalog',()=>{
  assert.deepEqual(createSalesSchemaPlan(8).sourceCounts,{tables:10,indexes:8,triggers:15});assert.equal(createSalesCatalog(8).entries.length,219);
});
test('Live Block 8 stopped report worker resumes after its lease without partial totals or duplicate positions',live,()=>withReportFixture(async f=>{
  const built=await f.cash.build(sourceRows(Array.from({length:150},(_,i)=>receipt(i+1,'480',[{},{},{},{}]))));await f.cash.activate(f.cash.request(built.id));
  const session=await f.resolvePrincipal('00001'),created=await f.jobs.create(session,{title:'Synthetischer Wiederanlauf',query:reportQuery});
  await f.jobs.tick();const partial=(await f.jobs.list(session)).find(j=>j.id===created.id);assert.equal(partial.status,'running');assert.ok(partial.processed>0&&partial.processed<600);
  await f.jobs.stop();const resumed=f.makeQueue({now:()=>Date.now()+31000}).jobs;
  let row;for(let i=0;i<20;i++){await resumed.tick();row=(await resumed.list(session)).find(j=>j.id===created.id);assert.notEqual(row.status,'failed',JSON.stringify(f.errors));if(row.status==='completed')break;}
  assert.equal(row.status,'completed');assert.equal(row.restarts,1);assert.equal(row.processed,600);assert.match((await resumed.download(session,created.id)).toString('ascii',0,8),/^%PDF-/);
}));
test('Live Block 8 generated search values match SQLite for accents, wildcards, exact decimals and every visible sort',live,()=>withReportFixture(async f=>{
  const {article}=require('../test-support/postgresql-migration/trade-fixture');
  const articles=['Sony A7 II','SONY A7 III','Canon ÄÖÜ Straße','Buch 100% Qualität','Sofortdruck 10_20','Leica ! Q3','Zubehör €'].map((description,i)=>({...article('0000'+i),description,prices:i%3?[{priceType:'sales',amount:(i+1)+'.123456789012',currency:'EUR',priceBasis:'gross',qualityStatus:'confirmed',sourceField:'Verkaufspreis'}]:[]}));
  await require('../test-support/postgresql-migration/load-articles').seedLoadArticles(f,articles);
  const {createSalesArticleCatalogRepository}=require('../lib/persistence/repositories/sales-article-catalog'),pg=createSalesArticleCatalogRepository(f.access),sqlite=createSalesArticleCatalogRepository(f.sqliteProvider);
  const projection={pricesRead:true,costsRead:true};
  // Numeric PostgreSQL decoding keeps the exact same decimal representation.
  for(const query of ['Sony A7','a*7','ÄÖÜ straße','100%','10_20','!','00002','does-not-exist',''])for(const sort of ['articleNumber','description','retailGross','status','primaryIdentifier','sourceSystem'])for(const direction of ['asc','desc']){
    const input={query,sort,direction,limit:5,offset:0};assert.deepEqual(await pg.search(input,projection),await sqlite.search(input,projection),JSON.stringify(input));
  }
  const folded=(await f.client.query('SELECT count(*)::int n FROM trade.sales_article_search_projection WHERE search_text_folded<>gp.ascii_fold(gp.lower(search_text))')).rows[0].n;assert.equal(folded,0);
}));
test('Live Block 8 real PostgreSQL worker produces a PDF, preserves cash margin and enforces revocation/cancellation',live,()=>withReportFixture(async f=>{
  const built=await f.cash.build(sourceRows([receipt(1,'120',[{}]),receipt(2,'39.08',[{VKMenge:'2',VK_Preis:'19.54',RohertragDM:'8.141667',KalkRohertrag:'16.283333'}])]));await f.cash.activate(f.cash.request(built.id));
  const session=await f.resolvePrincipal('00001');assert.ok(session.permissions.includes('sales:analytics:margin:read'));
  const query={sourceId:'compact-cash',kind:'receipts',dateFrom:'2026-08-01',dateTo:'2026-08-31',locationId:'18',limit:20,sort:'date',direction:'desc'};
  const plain=require('../lib/persistence/repositories/sales-history-runtime').createManagedSalesHistoryRuntime({...f.runtimeOptions,cashBackendFactory:require('../lib/persistence/repositories/cash-history-backend').createCashHistoryBackend});
  const prefetched=await f.runtime.run(()=>f.resolvePrincipal('00001'),w=>w.receipts.search(query));
  const baseline=await plain.run(()=>f.resolvePrincipal('00001'),w=>w.receipts.search(query));assert.deepEqual(prefetched.items,baseline.items);assert.equal(prefetched.items.length,2);
  const ids=prefetched.items.map(r=>r.id);
  assert.deepEqual(await f.runtime.run(()=>f.resolvePrincipal('00001'),w=>w.receipts.documents({ids})),await plain.run(()=>f.resolvePrincipal('00001'),w=>w.receipts.documents({ids})));
  let model;
  await f.runtime.run(()=>f.resolvePrincipal('00001'),async workspace=>{
    const q=workspace.reports.normalize(reportQuery),metadata=await workspace.reports.metadata();let step;
    do{step=await workspace.reports.step(q,metadata,step?.analysis.cursor);}while(!step.analysis.complete);model=step.report;
  });
  fs.writeFileSync('tmp/postgresql-block8-model.json',JSON.stringify(model,null,2)+'\n');
  assert.equal(model.rows.length,1);assert.equal(model.rows[0].metrics.grossRevenue.current,'159.08');
  assert.equal(model.rows[0].metrics.grossMargin.current,'36.28');
  const job=await f.jobs.create(session,{title:'Synthetische PostgreSQL-Verkaufsanalyse',query:reportQuery});
  for(let i=0;i<10;i++){await f.jobs.tick();const row=(await f.jobs.list(session)).find(r=>r.id===job.id);if(row.status==='completed')break;assert.notEqual(row.status,'failed',JSON.stringify(f.errors));}
  const bytes=await f.jobs.download(session,job.id);assert.match(bytes.toString('ascii',0,8),/^%PDF-/);
  const output=path.resolve('output/pdf/grabenplaner-postgresql-block8-synthetic.pdf');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,bytes);
  await assert.rejects(f.jobs.download({...session,permissions:session.permissions.filter(p=>p!=='sales:analytics:margin:read')},job.id),e=>e.code==='IMPORT_FORBIDDEN');
  const cancelled=await f.jobs.create(session,{title:'Abbruchprobe',query:reportQuery});await f.jobs.cancel(session,cancelled.id);await f.jobs.tick();assert.equal((await f.jobs.list(session)).find(r=>r.id===cancelled.id).status,'cancelled');
  const permissions=session.permissions;
  await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("UPDATE gp.portal_roles SET permissions=$1 WHERE id='employee'",[JSON.stringify(permissions)]);await f.core.migrator.query('RESET ROLE');
  const employee=await f.resolvePrincipal('00002');assert.ok(employee.permissions.includes('sales:history:read'));
  const denied=await f.jobs.create(employee,{title:'Rechteentzug',query:reportQuery});
  await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("UPDATE gp.portal_users SET active=0 WHERE employee_number='00002'");await f.core.migrator.query('RESET ROLE');
  assert.equal(await f.resolvePrincipal('00002'),null);await f.jobs.tick();const state=(await f.jobs.list(employee)).find(r=>r.id===denied.id);assert.equal(state.status,'failed');assert.equal(state.error,'IMPORT_FORBIDDEN');
  // A stale caller-side principal must not bypass the worker's fresh Core read.
  await assert.rejects(f.runtime.run(()=>employee,w=>w.receipts.search(query)),e=>e.code==='IMPORT_FORBIDDEN');
}));
