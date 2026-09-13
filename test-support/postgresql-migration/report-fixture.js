'use strict';
const path=require('node:path');
const {withCoreFixture}=require('./core-fixture');
const {withSalesFixture}=require('./sales-fixture');
const {openTwoDatabaseDevelopmentApplication}=require('../../lib/persistence/postgresql/boundary/application');
const {createIntegrationSecretVault}=require('../../lib/integration-secret-vault');
const {loadManagedDataImportProtection}=require('../../lib/data-import-managed-protection');
const {createPostgresqlReportPrincipalResolver}=require('../../lib/persistence/postgresql/reporting/principal');
const {createManagedSalesHistoryRuntime}=require('../../lib/persistence/repositories/sales-history-runtime');
const {createSalesReportJobs}=require('../../lib/persistence/repositories/sales-report-jobs');
const {createSalesReportBatchWorker}=require('../../lib/sales-report-batch-worker');
const {cashFixture}=require('./cash-fixture');
const today=()=> '2026-09-12';
async function withReportFixture(work){return withCoreFixture(core=>withSalesFixture(8,async sales=>{
  await core.migrator.query('SET ROLE gp_core_owner');await core.migrator.query('UPDATE gp.portal_users SET must_change_password=0');await core.migrator.query('RESET ROLE');
  const poolMetrics=[];
  const authority=await require('../../lib/persistence/postgresql/core/application').openCoreDevelopmentApplication({profile:'core-migration-development',databaseUrl:process.env.GP_CORE_READER_URL,purpose:'reader',tlsMode:'disable-local-only'});
  const app=await openTwoDatabaseDevelopmentApplication({coreUrl:process.env.GP_CORE_APP_URL,salesUrl:process.env.GP_SALES_APP_URL,stage:8,onDevelopmentMetric:event=>poolMetrics.push(event),authorize:async()=>Boolean(await authority.repositories.portalAccess.getReportPrincipal({employeeNumber:'00001',businessDate:today()}))});
  // The composed application owns one Core pool. The generic setup fixtures
  // also opened standalone providers; those are not part of this runtime.
  await core.application.close();await sales.application.close();
  const keyConfiguration={activeKeyId:'synthetic-migration',keys:{'synthetic-migration':Buffer.alloc(32,78)}};
  const vault=createIntegrationSecretVault(keyConfiguration),protection=await loadManagedDataImportProtection({access:app.provider,vault,create:true});
  // A dedicated one-connection authority reader sees fresh rights even while
  // all application connections are held by transactions awaiting that check.
  const resolvePrincipal=createPostgresqlReportPrincipalResolver({portalAccess:authority.repositories.portalAccess,today});
  const runtimeOptions={access:app.provider,vault,scopeId:'synthetic-migration',cashEnabled:true,today,cashBackendFactory:require('../../lib/persistence/postgresql/reporting/receipt-prefetch').createPostgresqlCashHistoryBackend};
  const receiptWorkers=require('../../lib/persistence/postgresql/reporting/receipt-runtime').createPostgresqlReceiptWorkers({keyConfiguration,scopeId:'synthetic-migration',today:today(),workerConfiguration:{coreUrl:process.env.GP_CORE_READER_URL,salesUrl:process.env.GP_SALES_READER_URL}});
  const makeRuntime=options=>receiptWorkers.runtime(runtimeOptions,options),runtime=makeRuntime();
  const errors=[],queues=[];
  function makeQueue(options={}){
    const worker=createSalesReportBatchWorker({keyConfiguration,scopeId:'synthetic-migration',today:today(),workerFile:path.resolve(__dirname,'../../lib/persistence/postgresql/reporting/worker.js'),workerConfiguration:{coreUrl:process.env.GP_CORE_READER_URL,salesUrl:process.env.GP_SALES_READER_URL},timeoutMs:120000});
    const jobs=createSalesReportJobs({access:app.provider,vault,runtime,resolvePrincipal,batchWorker:worker,scope:'synthetic-migration',onError:code=>errors.push(code),...options});queues.push(jobs);return {jobs,worker};
  }
  try{const workerReadiness=await receiptWorkers.warm('00001');const {jobs,worker}=makeQueue();await work({...sales,core,app,access:app.provider,protection,vault,resolvePrincipal,runtime,runtimeOptions,makeRuntime,worker,jobs,makeQueue,errors,poolMetrics,workerReadiness,cash:cashFixture(app.provider,protection,{actualTargets:true})});}
  finally{for(const queue of queues)await queue.stop();await receiptWorkers.close();protection.destroy();await app.close();await authority.close();}
}));}
const reportQuery={reportVersion:3,sourceId:'compact-cash',dateFrom:'2026-08-01',dateTo:'2026-08-31',locationIds:['18'],manufacturerIds:['sony'],productGroupIds:[],sellerIds:[],groupBy:['manufacturer'],metrics:['grossRevenue','netRevenue','grossMargin','quantity','receiptCount','customerCount'],changes:['absolute','percent'],chartMetric:'grossRevenue',chartType:'bars',orientation:'landscape'};
module.exports={withReportFixture,reportQuery};
