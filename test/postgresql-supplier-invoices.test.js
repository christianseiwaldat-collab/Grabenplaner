'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('native PostgreSQL invoice imports, blind lookup, worker search and source replacement',{skip:!process.env.GP_CORE_MIGRATOR_URL},async()=>{
 await require('../test-support/postgresql-migration/report-fixture').withReportFixture(async f=>{
  const source=await require('../test-support/trade-insights-fixture').insightFixture({access:f.access,protection:f.protection,scopeId:'synthetic-migration',ownerId:'00001',seedBase:false});
  const seed=require('../test-support/trade-supplier-invoices-fixture');
  await source.ingest('ARTIKEL_STAMM',[{EAN:'000042',Artikelbezeichnung:'Demo Fernglas',Verkaufspreis:'399',DurchschnittEK:'227.3212'}],{master:true});
  await seed.seedInvoiceArticleCatalog(f.access);const data=await seed.seedSupplierInvoices(source);
  const read=query=>f.worker.run({operation:'trade-insights',kind:'supplier-invoices',query,session:{employeeNumber:'00001'}});
  assert.equal((await read({articleNumber:'000042'})).rows[0].quantity,'0.3');assert.equal((await read({query:'Fernglas'})).articles[0].number,'000042');
  assert.equal((await read({query:'OLD-0042'})).articles[0].number,'OLD-0042');assert.equal((await read({articleNumber:'OLD-0042'})).article.current,false);
  await seed.seedSupplierInvoices(source);assert.equal((await read({articleNumber:'000042'})).rows.length,2);
  const options={...data.options,fileSha256:'d'.repeat(64),snapshotAt:'2026-09-14T09:00:00.000Z'};
  await source.ingest('Rechnung_A',data.heads,options);await assert.rejects(read({articleNumber:'000042'}),e=>e.code==='IMPORT_BESTELL_SOURCE_INCOMPLETE');
  await source.ingest('Rechnungsdetails_A',data.details.slice(0,1),options);assert.equal((await read({articleNumber:'000042'})).rows[0].quantity,'0.1');
  await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("UPDATE gp.portal_users SET active=0 WHERE employee_number='00001'");await f.core.migrator.query('RESET ROLE');
  await assert.rejects(read({articleNumber:'000042'}),e=>e.code==='IMPORT_FORBIDDEN');
 });
});
