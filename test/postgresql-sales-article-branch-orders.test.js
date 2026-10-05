'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
test('Native PostgreSQL branch orders: narrow authenticated batches, demand branches and current purchasing scope',
  {skip:process.env.GP_PG_MIGRATION_LIVE !== '1'}, async () => {
  for (const area of ['CORE','SALES']) for (const role of ['MIGRATOR','APP']) {
    const url = new URL(process.env['GP_'+area+'_'+role+'_URL']);
    assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.port==='25475' && url.pathname==='/gp_migration_'+area.toLowerCase(), 'Only guarded synthetic local cluster');
  }
  await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f => {
    await f.core.migrator.query('SET ROLE gp_core_owner');
    await f.core.migrator.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id) VALUES('cc19','19','Synthetic 19','branch','branch'); INSERT INTO gp.locations(id,name,active,cost_center_id) VALUES('19','Synthetic 19',1,'cc19')");
    await f.core.migrator.query('RESET ROLE');
    const scopeId='synthetic-migration';
    const source=await require('../test-support/trade-insights-fixture').insightFixture({access:f.access,protection:f.protection,scopeId,ownerId:'00001'});
    const {article}=await require('../test-support/sales-article-branch-orders-fixture').seedBranchOrders({access:f.access,source});
    const session={employeeNumber:'00001',permissions:require('../test-support/trade-insights-sqlite').rights,scopes:[]};
    const load=()=>require('../lib/sales-article-detail-source').loadSalesArticleDetailData({access:f.access,vault:f.vault,scopeId,article,projection:{read:true},session});
    const rows=(await load()).branchStock.rows;
    assert.deepEqual(rows.map(row=>[row.id,row.ordered,row.orders.matched]),[['18','4',true],['19','6',true]]);
    assert.deepEqual(rows[1].orders.items.map(item=>[item.number,item.remaining]),[['101','4'],['106','2']]);
    session.permissions=session.permissions.filter(permission=>permission!=='sales:purchasing:read');
    assert.ok((await load()).branchStock.rows.every(row=>row.ordered===null && row.orders.state==='restricted'));
  },{warmWorkers:false});
});
