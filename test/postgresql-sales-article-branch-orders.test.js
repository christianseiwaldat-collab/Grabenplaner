'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
test('Native PostgreSQL branch orders: narrow authenticated batches, demand branches and current purchasing scope',
  {skip:process.env.GP_PG_MIGRATION_LIVE !== '1'}, async () => {
  for (const area of ['CORE','SALES']) for (const role of ['MIGRATOR','APP']) {
    require('../test-support/postgresql-migration/ci-endpoint').assertSyntheticEndpoint(
      process.env['GP_'+area+'_'+role+'_URL'], area.toLowerCase(), ['25475']);
  }
  await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f => {
    await f.core.migrator.query('SET ROLE gp_core_owner');
    await f.core.migrator.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id) VALUES('cc19','19','Synthetic 19','branch','branch'); INSERT INTO gp.locations(id,name,active,cost_center_id) VALUES('19','Synthetic 19',1,'cc19')");
    await f.core.migrator.query('RESET ROLE');
    const scopeId='synthetic-migration';
    const source=await require('../test-support/trade-insights-fixture').insightFixture({access:f.access,protection:f.protection,scopeId,ownerId:'00001'});
    const {article,details}=await require('../test-support/sales-article-branch-orders-fixture').seedBranchOrders({access:f.access,source});
    await source.ingest('BESTELLDETAILS',[...details,...Array.from({length:100},(_,i)=>({
      BestellId:String(20000+i),BestellNr:106,EAN:'005479',BMenge:'1',gMenge:'1',Verteiler:false,
    }))],{snapshotAt:'2026-09-23T09:00:00.000Z'});
    const session={employeeNumber:'00001',permissions:require('../test-support/trade-insights-sqlite').rights,scopes:[]};
    const load=(section='all')=>require('../lib/sales-article-detail-source').loadSalesArticleDetailData({access:f.access,vault:f.vault,scopeId,article,projection:{read:true},session,section});
    const timings=[];
    for(let i=0;i<4;i++) {
      const start=performance.now(),main=await load('main');timings.push(performance.now()-start);
      assert.deepEqual(main.branchStock.rows.map(row=>[row.id,row.ordered,row.orders.state]),[['18','4','deferred'],['19','6','deferred']]);
    }
    assert.ok(Math.max(...timings)<1000,'Main article must not wait for its 106 purchase candidates');
    console.log(JSON.stringify({qualification:'article-with-purchasing-authority',candidateCount:106,mainMs:timings,includes:'native reader, authenticated stock and current purchasing scope',excludes:'HTTP, network and rendering'}));
    const fullPermissions=session.permissions;
    session.permissions=fullPermissions.filter(p=>p!=='sales:analytics:company:read');session.scopes=[{locationId:'18'}];
    assert.deepEqual((await load('main')).branchStock.rows.map(r=>[r.id,r.ordered]),[['18','4'],['19',null]],'A narrower fresh scope must not inherit the initial company projection');
    session.permissions=fullPermissions;session.scopes=[];
    const concurrent=await Promise.all(Array.from({length:4},async()=>{
      const start=performance.now(),value=await load('main');
      assert.deepEqual(value.branchStock.rows.map(r=>[r.id,r.quantity,r.ordered]),[['18','3','4'],['19','0','6']]);
      return performance.now()-start;
    }));
    assert.ok(Math.max(...concurrent)<700,'Concurrent main reads must retain headroom for HTTP and rendering');
    console.log(JSON.stringify({qualification:'concurrent-authorized-article-main',concurrentMs:concurrent}));
    const rows=(await load()).branchStock.rows;
    assert.deepEqual(rows.map(row=>[row.id,row.ordered,row.orders.matched]),[['18','4',true],['19','6',true]]);
    assert.deepEqual(rows[1].orders.items.map(item=>[item.number,item.remaining]),[['101','4'],['106','2']]);
    assert.deepEqual((await load('orders')).branchStock.rows,rows);
    const permissions=session.permissions;
    session.permissions=session.permissions.filter(permission=>permission!=='sales:purchasing:read');
    assert.ok((await load()).branchStock.rows.every(row=>row.ordered===null && row.orders.state==='restricted'));
    assert.ok((await load('orders')).branchStock.rows.every(row=>row.ordered===null && row.orders.state==='restricted'));
    session.permissions=permissions;
    await f.client.query("UPDATE integration.import_history_segments SET payload='synthetic-tamper' WHERE data_class='internal_business' AND record_id IN (SELECT id FROM integration.import_history_records WHERE source_table='BestellVerteilung')");
    assert.equal((await load('main')).branchStock.rows[0].ordered,'4');
    await assert.rejects(load('orders'));
    await assert.rejects(load());
  },{warmWorkers:false});
});
