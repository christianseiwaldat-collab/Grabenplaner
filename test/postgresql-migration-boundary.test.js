'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {withCoreFixture}=require('../test-support/postgresql-migration/core-fixture');
const {withSalesFixture}=require('../test-support/postgresql-migration/sales-fixture');
const {masterFixture,raw,articleSnapshot,article,TIME}=require('../test-support/postgresql-migration/trade-fixture');
const {openTwoDatabaseDevelopmentApplication}=require('../lib/persistence/postgresql/boundary/application');
const {IMPORT_MASTER_STATEMENTS:S}=require('../lib/persistence/statements/import-master-data');
const {LOAN_MODULE_STATEMENTS:L}=require('../lib/persistence/statements/loan-module');
const {createSalesArticleCatalogRepository}=require('../lib/persistence/repositories/sales-article-catalog');
const {B}=require('../lib/persistence/postgresql/boundary/catalog');
const live={skip:process.env.GP_PG_MIGRATION_LIVE!=='1'};
const fixture=work=>withCoreFixture(core=>withSalesFixture(7,async sales=>{
  const state={allowed:true};
  const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:sales.stage,authorize:async()=>state.allowed});
  try{await work({...sales,core,state,app,access:app.provider});}finally{await app.close();}
}));
test('Live Block 7 CRM synchronization, mappings and source undo have a single atomic owner',live,()=>fixture(async f=>{
  const m=masterFixture(f.access,f.protection);
  const run=await m.ingest('KUNDEN',[raw('KUNDEN',{KUND_NR:'000419',VORNAME:'Synthetisch',NACHNAME:'Migration'})]);
  const record=(await f.client.query("SELECT id FROM trade.import_master_records WHERE source_table='KUNDEN'")).rows[0];
  const request={recordId:record.id,expectedSourceRevision:1,decision:{customerType:'private'}};
  const preview=await m.service.previewCustomer(request),result=await m.service.syncCustomer(request,preview.planHash);
  assert.equal((await f.access.queryOne(S.crmGet,{id:result.targetId})).accountNumber,'000419');
  assert.equal((await f.core.migrator.query('SELECT count(*)::int n FROM gp.import_master_bindings')).rows[0].n,1);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM trade.import_master_bindings')).rows[0].n,0);
  const params={scopeId:'synthetic-migration',sourceInstance:'test-ledger',sourceTable:'KUNDEN',status:'linked',after:'',limit:5};
  assert.equal((await f.access.queryAll(S.listMappings,params)).length,1);assert.equal((await f.access.queryAll(S.listMappings,{...params,status:'unlinked'})).length,0);
  await assert.rejects(m.engine.undo(run.id,run.revision));
  await m.service.undo(result.eventId);assert.equal(await f.access.queryOne(S.crmGet,{id:result.targetId}),null);
  assert.equal((await m.engine.undo(run.id,run.revision)).status,'reverted');
}));
test('Live Block 7 current permission rejection and a second write owner roll back all changes',live,()=>fixture(async f=>{
  const m=masterFixture(f.access,f.protection);await m.ingest('KUNDEN',[raw('KUNDEN',{KUND_NR:'000420',NACHNAME:'Denied'})]);
  const record=(await f.client.query('SELECT id FROM trade.import_master_records')).rows[0];
  const request={recordId:record.id,expectedSourceRevision:1,decision:{customerType:'private'}},preview=await m.service.previewCustomer(request);
  f.state.allowed=false;await assert.rejects(m.service.syncCustomer(request,preview.planHash));f.state.allowed=true;
  assert.equal((await f.core.migrator.query('SELECT count(*)::int n FROM gp.crm_customers')).rows[0].n,0);
  assert.equal((await f.core.migrator.query('SELECT count(*)::int n FROM gp.import_master_bindings')).rows[0].n,0);
  await assert.rejects(f.access.transaction(async tx=>{
    await tx.execute(B.appendAudit,{actor:'00001',action:'test',entityType:'test',entityId:'test',detail:'{}',timestamp:TIME});
    await tx.execute(S.remove,{id:record.id,scopeId:'synthetic-migration',expectedRevision:1});
  }),e=>e.code==='PERSISTENCE_TRANSACTION_STATE_INVALID');
  assert.equal((await f.core.migrator.query('SELECT count(*)::int n FROM gp.audit_log')).rows[0].n,0);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM trade.import_master_records')).rows[0].n,1);
}));
test('Live Block 7 exact article revisions support loans and interrupted audit delivery is idempotent',live,()=>fixture(async f=>{
  const catalog=createSalesArticleCatalogRepository(f.access);await catalog.importSnapshot(articleSnapshot(1,[article('000042')]));
  const product=await catalog.getByArticleNumber('000042'),loanId=crypto.randomUUID();
  await f.access.transaction(async tx=>{
    await tx.execute(L.insertLoan,{payload:{id:loanId,locationId:'18',borrowerEmployeeNumber:'00002',createdByEmployeeNumber:'00001',dueDate:'2026-09-20',notes:'Synthetisch',issuedAt:TIME}});
    await tx.execute(L.insertLoanItem,{payload:{id:crypto.randomUUID(),loanId,position:1,productId:product.productId,productRevisionSnapshot:1,articleNumber:'000042',descriptionSnapshot:product.description,serialNumber:'',conditionOut:'',conditionReturn:'',itemNote:'',createdAt:TIME,updatedAt:TIME}});
  });
  assert.equal((await f.core.migrator.query('SELECT revision FROM gp.article_reference_snapshots')).rows[0].revision,'1');
  await catalog.importSnapshot(articleSnapshot(2,[article('000042',2)]));
  assert.equal((await f.core.migrator.query('SELECT product_revision_snapshot FROM gp.loan_items')).rows[0].product_revision_snapshot,'1');
  const expected=(await f.client.query('SELECT count(*)::int n FROM integration.core_audit_outbox')).rows[0].n;assert.ok(expected>=2);
  await assert.rejects(f.app.deliverAudits({afterCoreCommit(){throw Error('simulated delivery interruption');}}),/simulated delivery/);
  assert.equal((await f.core.migrator.query('SELECT count(*)::int n FROM gp.sales_audit_inbox')).rows[0].n,1);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM integration.core_audit_delivery')).rows[0].n,0);
  assert.equal((await f.app.deliverAudits()).delivered,expected);assert.equal((await f.app.deliverAudits()).delivered,0);
  assert.equal((await f.core.migrator.query('SELECT count(*)::int n FROM gp.sales_audit_inbox')).rows[0].n,expected);
  assert.equal((await f.core.migrator.query('SELECT count(*)::int n FROM gp.audit_log')).rows[0].n,expected);
}));
test('Live Block 7 cash mappings validate real Core employees and locations before publication',live,()=>fixture(async f=>{
  const {cashFixture,receipt,sourceRows}=require('../test-support/postgresql-migration/cash-fixture');
  const cash=cashFixture(f.access,f.protection,{actualTargets:true});const built=await cash.build(sourceRows([receipt(1,'120',[{}])]));
  const input=cash.request(built.id);await cash.preview(input);
  await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("UPDATE gp.employees SET active=0 WHERE personnel_number='00003'");await f.core.migrator.query('RESET ROLE');
  await assert.rejects(cash.activate(input));
  await f.core.migrator.query('SET ROLE gp_core_owner');await f.core.migrator.query("UPDATE gp.employees SET active=1 WHERE personnel_number='00003'");await f.core.migrator.query('RESET ROLE');
  await cash.activate(input);assert.ok(await f.access.transaction(tx=>cash.publications.active(tx),{readOnly:true}));
}));
