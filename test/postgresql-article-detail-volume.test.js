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
  const result={qualification:'article-main-volume',...volume,run:volume.run.id,firstRequestMs:first,serialMs:serial,concurrentFourMs:times,includes:'vault loading, authenticated master data, stock proof, selected stock decryption and price projection',excludes:'HTTP session checks, browser rendering, network and production load'};
  console.log(JSON.stringify(result));
  assert.ok(Math.max(...serial,...times)<1000,'Article main projection must stay below the 1000 ms budget');
  await pg.client.query('DELETE FROM integration.import_history_snapshot_members WHERE run_id=$1 AND row_number=237630',[volume.run.id]);
  const invalidStarted=performance.now();await assert.rejects(load(),{code:'IMPORT_HISTORY_SNAPSHOT_INCOMPLETE'});
  assert.ok(performance.now()-invalidStarted<1000,'An invalid proof must fail quickly rather than scan or show partial stock');
 },{warmWorkers:false});
});
