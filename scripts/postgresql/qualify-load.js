'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {withReportFixture,reportQuery}=require('../../test-support/postgresql-migration/report-fixture');
const {receipt,sourceRows}=require('../../test-support/postgresql-migration/cash-fixture');
const {article,articleSnapshot}=require('../../test-support/postgresql-migration/trade-fixture');
const {createSalesArticleCatalogRepository}=require('../../lib/persistence/repositories/sales-article-catalog');
const {createManagedSalesHistoryRuntime}=require('../../lib/persistence/repositories/sales-history-runtime');
if(process.env.GP_PG_SERVER_QUALIFICATION!=='1')throw Error('Run only inside the dedicated server qualification');
const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b);return {n:values.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)};};
async function main(){await withReportFixture(async f=>{
  const report={recordedAt:new Date().toISOString(),scope:'isolated-postgresql-development',productActivation:false,nodeVersion:process.version,hostLogicalCpus:require('node:os').cpus().length,articleCount:20000,receiptCount:2000,lineCount:8000,users:5,samplesPerPhase:100,coldDefinition:'Fresh application receipt caches for every call; receipt workers and schema-verified connections are started beforehand; shared PostgreSQL and OS caches are not flushed',workerConfiguration:{receiptWorkers:3,reportWorkers:1,maximumWaitingReceipts:10,coreAppPool:3,salesAppPool:2,readerPool:1,clusterConnections:20,reservedSuperuserConnections:3,corePoolComposition:'One shared Core application pool for interactive Core reads, rights and cross-domain requests; standalone fixture providers are closed'},poolMetricScope:'Interactive composite provider; separate worker pools excluded',rssScope:'Whole Node process including worker threads',phases:{},plans:[]};
  report.workerConfiguration.authorityReaderPool=1;report.workerReadiness=f.workerReadiness;
  assert.equal(report.workerReadiness.length,3);assert.ok(report.workerReadiness.every(item=>item.ready&&item.scheduling.applied&&item.scheduling.workerNice===19));
  const catalog=createSalesArticleCatalogRepository(f.access),articles=Array.from({length:report.articleCount},(_,i)=>({...article(String(i+1).padStart(8,'0')),description:(i%2?'Canon EOS':'Sony A7')+' Synthetisch '+i,prices:[{priceType:'sales',amount:(100+i%1000)+'.123456789012',currency:'EUR',priceBasis:'gross',qualityStatus:'confirmed',sourceField:'Verkaufspreis'}]}));
  console.log('Preparing 20,000 valid synthetic articles; bulk fixture setup after separate runtime-import qualification');let at=performance.now();await require('../../test-support/postgresql-migration/load-articles').seedLoadArticles(f,articles);report.articleFixtureMs=performance.now()-at;report.articleFixtureMode='Existing SQLite repository creates the synthetic source state; bulk PostgreSQL setup with active constraints, not a historical migration or import benchmark';console.log('Article fixture ready');
  const receipts=Array.from({length:report.receiptCount},(_,i)=>{
    const r=receipt(i+1,'480',Array.from({length:4},()=>({UMarke:i%2?'Canon':'Sony'}))),date=(i<1000?'2026':'2025')+'-08-'+String(i%28+1).padStart(2,'0')+'T00:00:00.000';
    r.head.Bondatum=date;for(const line of r.lines)line.Bondatum=date;return r;
  });
  console.log('Preparing 2,000 complete receipts / 8,000 positions through the encrypted cash importer');at=performance.now();
  const built=await f.cash.build(sourceRows(receipts));await f.cash.activate(f.cash.request(built.id));report.cashImportMs=performance.now()-at;console.log('Cash fixture ready');
  await f.client.query('ANALYZE trade.sales_articles,trade.sales_article_search_projection,kassa.cash_snapshot_1,kassa.cash_snapshot_6');await f.core.migrator.query('ANALYZE gp.portal_users,gp.employees,gp.portal_roles');
  fs.writeFileSync('tmp/postgresql-block8-load-progress.json',JSON.stringify(report,null,2)+'\n');
  const session=await f.resolvePrincipal('00001'),receiptQuery={sourceId:'compact-cash',kind:'receipts',dateFrom:'2026-08-01',dateTo:'2026-08-31',locationId:'18',limit:20,sort:'date',direction:'desc'};
  const fresh=()=>f.makeRuntime({freshCaches:true});
  let reportDone=false,overlap=0;
  async function phase(name,{cold=false,loaded=false}={}){
    const timing={core:[],articleFirst:[],articleNext:[],receiptFirst:[],receiptNext:[]};
    const cpu=process.cpuUsage(),started=performance.now(),loop=monitorEventLoopDelay({resolution:10});loop.enable();
    f.poolMetrics.length=0;let maxRss=process.memoryUsage().rss;const sample=setInterval(()=>{maxRss=Math.max(maxRss,process.memoryUsage().rss);},100);sample.unref();
    const timed=async(key,work)=>{const started=performance.now(),result=await work();timing[key].push(performance.now()-started);return result;};
    await Promise.all(Array.from({length:5},async(_,user)=>{
      for(let i=0;i<(process.argv.includes('--profile')?4:20);i++){
        await timed('core',async()=>assert.ok(await f.app.coreRepositories.portalAccess.getReportPrincipal({employeeNumber:String(user%3+1).padStart(5,'0'),businessDate:'2026-09-12'})));
        const first=await timed('articleFirst',()=>catalog.search({query:i%2?'Sony A7':'Canon EOS',limit:20,offset:0,sort:'articleNumber',direction:'asc'}));assert.equal(first.total,10000);assert.equal(first.items.length,20);
        const next=await timed('articleNext',()=>catalog.search({query:i%2?'Sony A7':'Canon EOS',limit:20,offset:20,sort:'articleNumber',direction:'asc'}));assert.ok(!first.items.some(a=>next.items.some(b=>a.productId===b.productId)));
        const runtime=cold?fresh():f.runtime;
        const page=await timed('receiptFirst',()=>runtime.run(()=>f.resolvePrincipal('00001'),w=>w.receipts.search(receiptQuery)));assert.equal(page.items.length,20);assert.ok(page.next);
        const second=await timed('receiptNext',()=>runtime.run(()=>f.resolvePrincipal('00001'),w=>w.receipts.search({...receiptQuery,cursor:page.next})));assert.equal(second.items.length,20);assert.ok(!page.items.some(a=>second.items.some(b=>a.id===b.id)));
        if(loaded&&!reportDone)overlap++;
      }
    }));
    report.phases[name]=Object.fromEntries(Object.entries(timing).map(([k,v])=>[k,summarize(v)]));console.log(JSON.stringify({phase:name,...report.phases[name]}));
    clearInterval(sample);loop.disable();
    report.phases[name].resources={durationMs:performance.now()-started,cpuMicroseconds:process.cpuUsage(cpu),maxRssBytes:maxRss,eventLoopP95Ms:loop.percentile(95)/1e6,eventLoopMaxMs:loop.max/1e6,poolWait:Object.fromEntries(['core','sales'].map(domain=>{const samples=f.poolMetrics.filter(e=>e.domain===domain).map(e=>e.milliseconds);return [domain,samples.length?summarize(samples):null];}))};
  }
  if(process.argv.includes('--profile')){
    report.diagnostic=true;report.samplesPerPhase=20;
    const inspector=require('node:inspector/promises'),profiling=new inspector.Session();profiling.connect();
    await profiling.post('Profiler.enable');await profiling.post('Profiler.start');await phase('coldApplication',{cold:true});
    const {profile}=await profiling.post('Profiler.stop');profiling.disconnect();
    fs.writeFileSync('tmp/postgresql-block8-search.cpuprofile',JSON.stringify(profile));fs.writeFileSync('tmp/postgresql-block8-profile-metrics.json',JSON.stringify(report,null,2));return;
  }
  await phase('coldApplication',{cold:true});await phase('warm');
  at=performance.now();const job=await f.jobs.create(session,{title:'Synthetischer Lasttest',query:reportQuery});report.acceptMs=performance.now()-at;
  report.reportTickIntervalMs=1000; // Same cadence as createSalesReportJobs.start().
  const large=(async()=>{for(let i=0;i<100;i++){const started=performance.now();await f.jobs.tick();const row=(await f.jobs.list(session)).find(r=>r.id===job.id);if(row.status==='completed'){reportDone=true;return row;}assert.notEqual(row.status,'failed',JSON.stringify(f.errors));await new Promise(resolve=>setTimeout(resolve,Math.max(0,report.reportTickIntervalMs-(performance.now()-started))));}throw Error('Large report did not finish');})();large.catch(()=>{});
  try{await phase('withReport',{loaded:true});report.completed=await large;report.overlapSamples=overlap;assert.ok(overlap>=100,'All 100 interactive samples must overlap the large report');}
  finally{await large.catch(()=>{});}
  assert.equal(report.completed.processed,8000);assert.equal(report.completed.phase,'complete');
  const pdf=await f.jobs.download(session,job.id);report.pdfBytes=pdf.length;assert.ok(report.pdfBytes>1000);fs.writeFileSync('tmp/postgresql-block8-load.pdf',pdf);
  for(const [name,sql,params] of [
    ['articleContains',"SELECT product_id FROM trade.sales_article_search_projection WHERE search_text_folded LIKE '%synthetisch198%'",[]],
    ['receiptDate',"SELECT source_row FROM kassa.cash_snapshot_1 WHERE dataset_slot=$1 AND business_date BETWEEN '2026-08-01' AND '2026-08-31' ORDER BY business_date DESC,source_row DESC LIMIT 20",[1]],
  ])report.plans.push({name,plan:(await f.client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN']});
  const params={...require('../../lib/flexible-search').parameters('Sony A7'),active:null,identifierLike:'%',sourceSystem:null,sort:'articleNumber',direction:'asc',limit:20,offset:0};
  for(const e of require('../../lib/persistence/postgresql/sales/catalog').createSalesCatalog(8).entries.filter(e=>['sales-article-catalog.articles.search','sales-article-catalog.articles.search.count'].includes(e.statement.id))){
    report.plans.push({name:e.statement.id,plan:(await f.client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+e.sql,e.parameterBindings.map(b=>params[b.parameter]))).rows[0]['QUERY PLAN']});
  }
  report.coreDegradation=report.phases.withReport.core.p95/report.phases.warm.core.p95-1;
  report.checks={firstPages:Object.values(report.phases).every(p=>p.articleFirst.p95<1000&&p.receiptFirst.p95<1000),nextPages:Object.values(report.phases).every(p=>p.articleNext.p95<500&&p.receiptNext.p95<500),accept:report.acceptMs<1000,core:report.coreDegradation<=.2,overlap:overlap>=100};
  fs.writeFileSync('docs/postgresql-migration/block-8-load.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks:report.checks,acceptMs:report.acceptMs,coreDegradation:report.coreDegradation}));
  assert.ok(Object.values(report.checks).every(Boolean),'Defined latency targets must all pass');
});}
main().catch(e=>{console.error(e);process.exitCode=1;});
