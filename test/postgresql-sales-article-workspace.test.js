'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('Native article workspace: current order sources, EAN aliases, stock and independent price rights',
  {skip:!process.env.GP_CORE_MIGRATOR_URL},async()=>{
  await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f=>{
    await f.core.migrator.query('SET ROLE gp_core_owner');
    await f.core.migrator.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id) VALUES('cc19','19','Synthetic 19','branch','branch'); INSERT INTO gp.locations(id,name,active,cost_center_id) VALUES('19','Synthetic 19',1,'cc19')");
    await f.core.migrator.query('RESET ROLE');
    const scopeId='synthetic-migration';
    const source=await require('../test-support/trade-insights-fixture').insightFixture({access:f.access,protection:f.protection,scopeId,ownerId:'00001'});
    const {article}=await require('../test-support/sales-article-workspace-fixture').seedWorkspace({access:f.access,source});
    const search=(orderNumber,query='',projection={read:true})=>require('../lib/persistence/repositories/sales-article-workspace').searchSalesArticleWorkspace({
      access:f.access,vault:f.vault,scopeId,projection,orderNumber,
      search:require('../lib/sales-article-catalog').normalizeSalesArticleSearch({query})});
    assert.equal((await search('H-5120')).total,2);
    assert.equal((await search('L-98765')).items[0].articleNumber,'005479');
    assert.equal((await search('','4006381333931')).total,1);
    await source.ingest('ARTIKEL_ZWEITLIEFERANT',[{EAN:'005479',ZBestellnummer:'NEW-77'}],{master:true,snapshotAt:'2026-09-17T10:00:00.000Z'});
    assert.equal((await search('L-98765')).total,0);
    assert.equal((await search('NEW-77')).total,1);
    const data=await require('../lib/sales-article-detail-source').loadSalesArticleDetailData({
      access:f.access,vault:f.vault,scopeId,article,projection:{read:true,pricesRead:true,costsRead:true}});
    assert.deepEqual(data.branchStock.rows.map(r=>[r.id,r.quantity]),[['18','3'],['19','0']]);
    assert.equal(data.priceMatrix.sales.find(p=>p.id==='sales').margin.amount,'20.833333333333');
    assert.equal((await search('NEW-77')).items[0].purchaseNet,undefined);
  },{warmWorkers:false});
});
