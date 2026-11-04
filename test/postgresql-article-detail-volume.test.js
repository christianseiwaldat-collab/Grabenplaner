'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadSalesArticleDetailData}=require('../lib/sales-article-detail-source');
test('Native article detail under one second with a production-sized synthetic history',
 {skip:!process.env.GP_CORE_MIGRATOR_URL||process.env.GP_ARTICLE_VOLUME_CHECK!=='1',timeout:1200000},async t=>{
 await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async pg=>{
  const f=await require('../test-support/article-stock-snapshots-fixture').snapshotFixture(t,{access:pg.access,protection:pg.protection,scopeId:'synthetic-migration',ownerId:'00001'});
  const {article}=await require('../test-support/sales-article-workspace-fixture').seedWorkspace({access:pg.access,source:f});
  const volume=await require('../test-support/article-detail-volume-fixture').addArticleVolume(pg,f);
  const times=[];
  const load=async()=>{
   const started=performance.now();
   const value=await loadSalesArticleDetailData({access:pg.access,vault:pg.vault,scopeId:f.scopeId,article,projection:{read:true,pricesRead:true,costsRead:true},section:'main'});
   const elapsed=performance.now()-started;times.push(elapsed);
   assert.deepEqual(value.branchStock.rows.map(r=>[r.id,r.quantity]),[['18','3'],['19','0']]);assert.equal(value.notes.deferred,true);
   return elapsed;
  };
  const first=await load();for(let i=0;i<9;i++)await load();
  const serial=[...times];times.length=0;await Promise.all(Array.from({length:4},()=>load()));
  const otherEntrypoints=[];
  for(let i=0;i<3;i++){
   let started=performance.now();
   const complete=await loadSalesArticleDetailData({access:pg.access,vault:pg.vault,scopeId:f.scopeId,article,projection:{read:true,pricesRead:true,costsRead:true}});
   otherEntrypoints.push({entrypoint:'complete-detail-tools-and-labels',ms:performance.now()-started});
   assert.deepEqual(complete.branchStock.rows.map(r=>[r.id,r.quantity]),[['18','3'],['19','0']]);
   started=performance.now();
   const branch=await require('../lib/branch-article-detail').createBranchArticleDetail({access:pg.access,vault:pg.vault,scopeId:f.scopeId})(article.articleNumber,{accountId:'00001',locationId:'18'});
   otherEntrypoints.push({entrypoint:'branch-article-detail',ms:performance.now()-started});
   assert.deepEqual(branch.stocks.map(r=>[r.id,r.quantity]),[['18','3'],['19','0']]);
  }
  const revisionUpdates=[];
  for(let i=0;i<5;i++){
   const started=performance.now();
   await pg.client.query("UPDATE integration.import_history_records SET revision=revision+1 WHERE id IN (SELECT 'volume-'||g FROM generate_series(3,52) g)");
   revisionUpdates.push(performance.now()-started);
   assert.equal(Number((await pg.client.query('SELECT count(*) FROM integration.import_history_snapshot_attestations WHERE run_id=$1',[volume.run.id])).rows[0].count),1);
  }
  const result={qualification:'article-main-volume',...volume,run:volume.run.id,firstRequestMs:first,serialMs:serial,concurrentFourMs:times,otherEntrypoints,revisionUpdatesMs:revisionUpdates,includes:'vault loading, authenticated master data, stock proof, selected stock decryption and price projection',excludes:'HTTP session checks, browser rendering, network and production load'};
  console.log(JSON.stringify(result));
  assert.ok(Math.max(...serial,...times,...otherEntrypoints.map(v=>v.ms))<1000,'Every article projection must stay below the 1000 ms budget');
  assert.ok(Math.max(...revisionUpdates)<750,'Ordinary import revision batches must not rescan snapshot history');
  await pg.client.query('DELETE FROM integration.import_history_snapshot_members WHERE run_id=$1 AND row_number=237630',[volume.run.id]);
  const invalidStarted=performance.now();await assert.rejects(load(),{code:'IMPORT_HISTORY_SNAPSHOT_INCOMPLETE'});
  assert.ok(performance.now()-invalidStarted<1000,'An invalid proof must fail quickly rather than scan or show partial stock');
 },{warmWorkers:false});
});
