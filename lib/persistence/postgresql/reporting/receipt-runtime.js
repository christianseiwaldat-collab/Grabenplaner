'use strict';
const path=require('node:path');
const {createSalesReportBatchWorker}=require('../../../sales-report-batch-worker');
const {createManagedSalesHistoryRuntime}=require('../../repositories/sales-history-runtime');
function createPostgresqlReceiptWorkers(options){
  let stopped=false;const queue=[];
  // Keep room for PostgreSQL's reserved connections, the report reader and the
  // bounded application pools; never create one unbounded worker per request.
  const slots=Array.from({length:3},()=>({busy:false,worker:createSalesReportBatchWorker({...options,workerFile:path.join(__dirname,'worker.js')})}));
  const error=code=>Object.assign(new Error(code),{code,status:503});
  function dispatch(){
    if(stopped)return;
    for(const slot of slots){if(slot.busy||!queue.length)continue;const request=queue.shift();slot.busy=true;
      slot.worker.run(request.input).then(request.resolve,request.reject).finally(()=>{slot.busy=false;dispatch();});
    }
  }
  function run(input){
    if(stopped)return Promise.reject(error('IMPORT_REPORT_WORKER_FAILED'));
    if(queue.length>=10)return Promise.reject(error('IMPORT_HISTORY_ANALYSIS_BUSY'));
    return new Promise((resolve,reject)=>{queue.push({input,resolve,reject});dispatch();});
  }
  return {
    run,async warm(employeeNumber){return Promise.all(slots.map(()=>run(employeeNumber
      ?{operation:'prepare',session:{employeeNumber}}:{operation:'initialize'})));},
    runtime(runtimeOptions,{freshCaches=false}={}){
      const base=createManagedSalesHistoryRuntime(runtimeOptions);
      return Object.freeze({run(getSession,work){return base.run(getSession,workspace=>{
        if(!workspace?.receipts)return work(workspace);
        async function request(operation,query){const session=await getSession();return run({operation,query,sourceRevision:workspace.reportSourceRevision,session:{employeeNumber:session?.employeeNumber},freshCaches});}
        return work(Object.freeze({...workspace,receipts:Object.freeze({search:query=>request('receipt-search',query),documents:query=>request('receipt-documents',query)})}));
      });}});
    },
    async close(){stopped=true;for(const r of queue.splice(0))r.reject(error('IMPORT_REPORT_WORKER_FAILED'));await Promise.all(slots.map(s=>s.worker.stop()));},
  };
}
module.exports={createPostgresqlReceiptWorkers};
