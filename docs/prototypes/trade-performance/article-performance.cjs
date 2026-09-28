'use strict';
// Reproducible local benchmark. Uses synthetic data in disposable in-memory databases only.
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { fixture } = require('../../../test-support/trade-insights-sqlite');
const { seedWorkspace } = require('../../../test-support/sales-article-workspace-fixture');
const { loadSalesArticleDetailData } = require('../../../lib/sales-article-detail-source');
const { matching } = require('../../../lib/persistence/repositories/sales-article-workspace');
const { IMPORT_MASTER_SCHEMA_SQL } = require('../../../lib/persistence/sqlite/operations/import-master-schema');
const W = require('../../../lib/persistence/statements/sales-article-workspace');
const sql = require('../../../lib/persistence/sqlite/sales-article-workspace-catalog').CATALOG.find(e => e.statement === W.notes).sql;
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const round = value => Math.round(value * 100) / 100;
function stockLookupProbe(db) {
  db.exec(require('../../../lib/persistence/sqlite/operations/import-history-schema').IMPORT_HISTORY_SCHEMA_SQL);
  const record=db.prepare("INSERT INTO import_history_records VALUES(?,'grabenplaner-main','tradefoto-trade','trade','ARTIKEL_FILIALEN',?,?,1)");
  const version=db.prepare("INSERT INTO import_history_versions VALUES(?,1,?,'2026-09-28T00:00:00.000Z','synthetic','2026-09-28T00:00:00.000Z','synthetic','tradefoto-trade',NULL,NULL,NULL,'synthetic')");
  const reference=db.prepare("INSERT INTO import_history_references VALUES(?,1,'article','internal_business',?,?)");
  const master=db.prepare("INSERT INTO import_master_records VALUES(?,'grabenplaner-main','tradefoto-trade','ARTIKEL_STAMM',?,?,1,'synthetic','2026-09-28T00:00:00.000Z')");
  db.exec('BEGIN');
  for(let i=0;i<10000;i++)master.run('article-'+i,'a'.repeat(64),String(i+1000000).padStart(64,'0'));
  for(let i=0;i<100000;i++) {
    const id='stock-'+i,article=String(Math.floor(i/10));
    record.run(id,'b'.repeat(64),String(i).padStart(64,'0'));version.run(id,'c'.repeat(64));
    reference.run(id,'article-'+article,article.padStart(64,'0'));
  }
  db.exec('COMMIT');
  const sql=require('../../../lib/persistence/sqlite/branch-article-stock-catalog').BRANCH_ARTICLE_STOCK_CATALOG[0].sql;
  const params={scopeId:'grabenplaner-main',sourceInstance:'tradefoto-trade',snapshot:'c'.repeat(64),articleHash:'9500'.padStart(64,'0'),masterRecordId:'article-9500',limit:101};
  const run=(query=sql)=>{
    const statement=db.prepare(query),times=[];
    for(let i=0;i<7;i++){const start=performance.now();if(statement.all(params).length!==10)throw new Error('Unexpected stock result');times.push(performance.now()-start);}
    return {medianMs:round(median(times)),plan:db.prepare('EXPLAIN QUERY PLAN '+query).all(params).map(row=>row.detail)};
  };
  const current=run();
  const selectiveSql=require('../../../lib/persistence/sqlite/sales-article-workspace-catalog').CATALOG.find(entry=>entry.statement===W.articleStock).sql;
  const selective=run(selectiveSql);
  // This optional index exists only in this synthetic benchmark database.
  db.exec('CREATE INDEX benchmark_history_master_reference ON import_history_references(master_record_id,role,record_id,revision)');
  return {rows:100000,matches:10,current,selective,withExperimentalMasterIndex:run(selectiveSql)};
}
async function main() {
  let calls=0;
  const prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql) {
    const statement=prepare.call(this,sql);
    return new Proxy(statement,{get(target,key) {
      const value=target[key];
      return typeof value!=='function' ? value : (...args)=>{if(key==='all'&&/^\s*(SELECT|WITH)\b/i.test(sql))calls++;return value.apply(target,args);};
    }});
  };
  const cleanups = [], f = await fixture({after: work => cleanups.push(work)});
  try {
    const {article} = await seedWorkspace({access:f.app.provider,source:f});
    const branches = Array.from({length:20},(_,i) => String(i + 18));
    await f.ingest('FILIALEN',branches.map(FilialID => ({FilialID,FName:'Synthetic '+FilialID})),{master:true});
    await f.ingest('ARTIKEL_FILIALEN',branches.map((FilialID,i) => ({EAN:'005479',FilialID,FBestand:i})),{sourceInstance:'tradefoto-trade',snapshotAt:'2026-09-25T09:00:00.000Z'});
    await f.ingest('Artikel_Bemerkungen',Array.from({length:100},(_,i) => ({EAN:'005479',Datum:'2026-09-20T00:00:00.000',Text:'Synthetic note '+i,LBAe:42})),{master:true,snapshotAt:'2026-09-25T09:00:00.000Z'});
    const access = f.app.provider;
    const detailTimes = [], detailCalls = [];
    for (let i=0;i<7;i++) {
      calls=0;const start=performance.now();
      const value=await loadSalesArticleDetailData({access,vault:f.vault,article,projection:{read:true,pricesRead:true,costsRead:true}});
      if(value.notes.items.length!==100||value.branchStock.rows.length!==20)throw new Error('Unexpected benchmark result');
      detailTimes.push(performance.now()-start);detailCalls.push(calls);
    }
    const rows = new Map(Array.from({length:50000},(_,i) => [String(i),{articleKey:String(i),number:'hama'+String(i).padStart(6,'0'),secondary:false}]));
    const searchTimes=[];let matches;
    for(let i=0;i<7;i++){const start=performance.now();matches=matching(rows,'Hama 005120');searchTimes.push(performance.now()-start);}
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(IMPORT_MASTER_SCHEMA_SQL);
      const record=db.prepare("INSERT INTO import_master_records VALUES(?,'grabenplaner-main','tradefoto-trade','Artikel_Bemerkungen',?,?,1,'synthetic','2026-09-28T00:00:00.000Z')");
      const relation=db.prepare("INSERT INTO import_master_relations VALUES(?,0,'ARTIKEL_STAMM',?,'candidate','synthetic')");
      db.exec('BEGIN');
      for(let i=0;i<100000;i++) {
        const id=String(i).padStart(8,'0');record.run(id,'a'.repeat(64),String(i).padStart(64,'0'));
        relation.run(id,String(Math.floor(i/10)).padStart(64,'0'));
      }
      db.exec('COMMIT');
      const params={scopeId:'grabenplaner-main',articleIdentity:String(9500).padStart(64,'0'),after:'',limit:200};
      const statement=db.prepare(sql), noteTimes=[];
      for(let i=0;i<7;i++){const start=performance.now();if(statement.all(params).length!==10)throw new Error('Unexpected note result');noteTimes.push(performance.now()-start);}
      console.log(JSON.stringify({synthetic:true,articleDetail:{notes:100,branches:20,medianMs:round(median(detailTimes)),queryCalls:median(detailCalls)},
        orderMatch:{rows:rows.size,matches:matches.length,medianMs:round(median(searchTimes))},
        noteLookup:{rows:100000,matches:10,medianMs:round(median(noteTimes)),plan:db.prepare('EXPLAIN QUERY PLAN '+sql).all(params).map(r=>r.detail)},
        ...(process.argv.includes('--stock-index-probe') ? {stockLookupProbe:stockLookupProbe(db)} : {})},null,2));
    } finally { db.close(); }
  } finally { for(const cleanup of cleanups.reverse())await cleanup(); DatabaseSync.prototype.prepare=prepare; }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
