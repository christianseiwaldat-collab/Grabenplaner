'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const scheduling=require('./worker-priority').lowerCurrentWorkerPriority();
const C=require('../../../data-import-contract');
const {createIntegrationSecretVault}=require('../../../integration-secret-vault');
const {openTwoDatabaseDevelopmentApplication}=require('../boundary/application');
const {createManagedSalesHistoryRuntime}=require('../../repositories/sales-history-runtime');
const {createSalesAnalysisPdf}=require('../../../sales-analysis-pdf');
const {createPostgresqlReportPrincipalResolver}=require('./principal');
const {createPostgresqlCashHistoryBackend}=require('./receipt-prefetch');
const {createBranchReceiptRuntime}=require('../../repositories/branch-receipt-runtime');
const {executeBranchReceiptWork}=require('../../../branch-sales-worker');
const today=()=>workerData.today||new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Vienna'}).format(new Date());
const application=openTwoDatabaseDevelopmentApplication({...workerData.workerConfiguration,purpose:'reader',stage:8,authorize:({readOnly})=>readOnly});
application.catch(()=>{});let busy=false;
const environment=application.then(app=>{
  const options={access:app.provider,vault:createIntegrationSecretVault(workerData.keyConfiguration),scopeId:workerData.scopeId,cashEnabled:true,retainCompletedAnalyses:false,today,cashBackendFactory:createPostgresqlCashHistoryBackend};
  return {insights:require('../../repositories/trade-insights').createTradeInsightRuntime(options),resolve:createPostgresqlReportPrincipalResolver({portalAccess:app.coreRepositories.portalAccess,today}),runtime:createManagedSalesHistoryRuntime(options),fresh:()=>createManagedSalesHistoryRuntime(options),branch:createBranchReceiptRuntime(options)};
});environment.catch(()=>{});
parentPort.on('message',async({id,input})=>{
  if(busy){parentPort.postMessage({id,error:'IMPORT_HISTORY_ANALYSIS_BUSY'});return;}busy=true;
  try{
    const env=await environment,{resolve}=env,runtime=input.freshCaches?env.fresh():env.runtime;
    if(input.operation==='initialize'){
      parentPort.postMessage({id,result:{ready:true,scheduling}});return;
    }
    if(input.operation==='prepare'){
      if(!await resolve(input.session?.employeeNumber))C.fail('IMPORT_FORBIDDEN',403);
      parentPort.postMessage({id,result:{ready:true,scheduling}});return;
    }
    if(['branch-receipt-search','branch-receipt-documents'].includes(input.operation)){
      const result=await executeBranchReceiptWork(env.branch,input);
      parentPort.postMessage({id,result});return;
    }
    if(input.operation==='trade-insights'){const result=await env.insights.run(()=>resolve(input.session?.employeeNumber),input.kind,input.query);parentPort.postMessage({id,result});return;}
    const result=await runtime.run(()=>resolve(input.session?.employeeNumber),workspace=>{
      if(!workspace||workspace.reportSourceRevision!==input.sourceRevision)C.fail('IMPORT_HISTORY_ANALYSIS_CHANGED',409);
      if(input.operation==='receipt-search')return workspace.receipts.search(input.query);
      if(input.operation==='receipt-documents')return workspace.receipts.documents(input.query);
      return workspace.reports.step(input.query,input.metadata,input.cursor);
    });
    if(!input.operation&&result.analysis.complete){result.artifact=(await createSalesAnalysisPdf({title:input.title,query:input.query,metadata:input.metadata,report:result.report,completedAt:input.completedAt})).toString('base64');delete result.report;}
    parentPort.postMessage({id,result});
  }catch(e){parentPort.postMessage({id,error:/^(IMPORT_|BRANCH_RECEIPT_)[A-Z_]+$/.test(e?.code||'')?e.code:'IMPORT_REPORT_FAILED',status:e?.status});}finally{busy=false;}
});
