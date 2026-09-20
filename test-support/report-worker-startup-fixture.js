'use strict';
// Exercise the production worker message handler and client in a real thread;
// only its database and business services are replaced by synthetic fixtures.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),threads=require('node:worker_threads');
const file=path.resolve(__dirname,'../lib/persistence/postgresql/reporting/worker.js');
const localRequire=createRequire(file),scenario=threads.workerData.workerConfiguration.scenario;
if(scenario==='module-failure')throw Object.assign(new Error('PRIVATE MODULE PATH'),{code:'MODULE_NOT_FOUND'});
if(scenario==='invalid-diagnostic'){
  threads.parentPort.on('message',({id})=>threads.parentPort.postMessage({id,error:'IMPORT_REPORT_FAILED',
    diagnostic:{phase:'SELECT SECRET',errorClass:'PRIVATE',originalCode:'TOKEN',message:'SECRET'}}));
}else{
  const modes={
    capacity:()=>Object.assign(new Error('PRIVATE SQL AND PASSWORD'),{code:'53300'}),
    connection:()=>Object.assign(new Error('PRIVATE CONNECTION URL'),{code:'ECONNREFUSED'}),
    timeout:()=>new Error('Query read timeout'),
    schema:()=>new Error('Sales application schema contract mismatch'),
    unknown:()=>Object.assign(new Error('PRIVATE SQL AND PASSWORD'),{code:'PRIVATE_DATABASE_TOKEN'}),
  };
  const runtime=()=>({});
  const modules={
    '../boundary/application':{async openTwoDatabaseDevelopmentApplication({onInitializationPhase}){
      onInitializationPhase('core-database');
      if(['capacity','connection'].includes(scenario))throw modes[scenario]();
      if(scenario==='hang')await new Promise(()=>{});
      onInitializationPhase('sales-database');
      if(modes[scenario])throw modes[scenario]();
      onInitializationPhase('database-routing');
      return {provider:{},coreRepositories:{portalAccess:{}}};
    }},
    '../../../data-import-contract':{},
    '../../../integration-secret-vault':{createIntegrationSecretVault:runtime},
    '../../repositories/sales-history-runtime':{createManagedSalesHistoryRuntime:runtime},
    '../../../sales-analysis-pdf':{},
    './principal':{createPostgresqlReportPrincipalResolver:runtime},
    './receipt-prefetch':{},
    '../../repositories/branch-receipt-runtime':{createBranchReceiptRuntime:runtime},
    '../../../branch-sales-worker':{},
    '../../repositories/trade-insights':{createTradeInsightRuntime:runtime},
  };
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{
    require(id){return Object.hasOwn(modules,id)?modules[id]:localRequire(id);},Intl,Date,
  },{filename:file});
}
