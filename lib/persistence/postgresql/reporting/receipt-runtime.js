'use strict';
const path=require('node:path');
const crypto=require('node:crypto');
const {createSalesReportBatchWorker}=require('../../../sales-report-batch-worker');
const {createManagedSalesHistoryRuntime}=require('../../repositories/sales-history-runtime');
function createPostgresqlReceiptWorkers(options){
  let stopped=false;const queue=[];
  // Keep room for PostgreSQL's reserved connections, the report reader and the
  // bounded application pools; never create one unbounded worker per request.
  const slots=Array.from({length:3},()=>({busy:false,worker:createSalesReportBatchWorker({...options,workerFile:path.join(__dirname,'worker.js')})}));
  const error=code=>Object.assign(new Error(code),{code,status:503});
  function affinity(input){
    if(!['receipt-search','branch-receipt-search'].includes(input?.operation))return null;
    const query=input.query||{};
    if((query.sort||'date')==='date'&&(query.direction||'desc')==='desc'&&!query.resultSet)return null;
    // Sorted continuations refer to an encrypted, worker-local result store.
    // Keep the trusted principal on one slot without changing opaque cursors
    // or caching authorization here. The worker still checks owner, filters,
    // source revision and expiry, including after its cache or process is lost.
    const owner=input.operation==='branch-receipt-search'
      ? ['branch',String(input.session?.accountId||'')]
      : ['personal',String(input.session?.employeeNumber||'')];
    return crypto.createHash('sha256').update(JSON.stringify(owner)).digest().readUInt32BE(0)%slots.length;
  }
  function dispatch(){
    if(stopped)return;
    for(const [index,slot] of slots.entries()){
      if(slot.busy||!queue.length)continue;
      // A continuation waits for its own slot; independent work may still use
      // another free worker instead of waiting behind it in the shared queue.
      const next=queue.findIndex(request=>request.slot===null||request.slot===index);
      if(next<0)continue;
      const [request]=queue.splice(next,1);slot.busy=true;
      Promise.resolve().then(()=>slot.worker.run(request.input)).then(request.resolve,request.reject).finally(()=>{slot.busy=false;dispatch();});
    }
  }
  function run(input){
    if(stopped)return Promise.reject(error('IMPORT_REPORT_WORKER_FAILED'));
    if(queue.length>=10)return Promise.reject(error('IMPORT_HISTORY_ANALYSIS_BUSY'));
    return new Promise((resolve,reject)=>{queue.push({input,slot:affinity(input),resolve,reject});dispatch();});
  }
  return {
    run,async warm(employeeNumber){return Promise.all(slots.map(()=>run(employeeNumber
      ?{operation:'prepare',session:{employeeNumber}}:{operation:'initialize'})));},
    runtime(runtimeOptions,{freshCaches=false}={}){
      const base=createManagedSalesHistoryRuntime(runtimeOptions);
      return Object.freeze({run(getSession,work,runOptions){return base.run(getSession,workspace=>{
        if(!workspace?.receipts)return work(workspace);
        async function request(operation,query){const session=await getSession();return run({operation,query,sourceRevision:workspace.reportSourceRevision,session:{employeeNumber:session?.employeeNumber},freshCaches});}
        return work(Object.freeze({...workspace,receipts:Object.freeze({search:query=>request('receipt-search',query),documents:query=>request('receipt-documents',query)})}));
      },runOptions);}});
    },
    async close(){stopped=true;for(const r of queue.splice(0))r.reject(error('IMPORT_REPORT_WORKER_FAILED'));await Promise.all(slots.map(s=>s.worker.stop()));},
  };
}
module.exports={createPostgresqlReceiptWorkers};
