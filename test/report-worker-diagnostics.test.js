'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {classifyReportWorkerError,sanitizeReportWorkerDiagnostic}=require('../lib/report-worker-diagnostics');
const {createSalesReportBatchWorker}=require('../lib/sales-report-batch-worker');
const workerFile=path.resolve(__dirname,'../test-support/report-worker-startup-fixture.js');

for(const [scenario,phase,errorClass,originalCode] of [
  ['capacity','core-database','connection-capacity','53300'],
  ['connection','core-database','connection','ECONNREFUSED'],
  ['timeout','sales-database','query-timeout',null],
  ['schema','sales-database','schema-contract',null],
  ['unknown','sales-database','unknown',null],
])test('real worker startup preserves '+scenario+' diagnosis without exposing private errors',async t=>{
  const worker=createSalesReportBatchWorker({workerFile,workerConfiguration:{scenario}});t.after(()=>worker.stop());
  await assert.rejects(worker.run({operation:'initialize'}),error=>{
    assert.equal(error.code,'IMPORT_REPORT_FAILED');
    assert.equal(error.status,503);
    assert.deepEqual(error.reportWorkerDiagnostic,{phase,errorClass,...(originalCode?{originalCode}:{})});
    assert.equal(Object.keys(error).includes('reportWorkerDiagnostic'),false);
    assert.doesNotMatch(JSON.stringify(error.reportWorkerDiagnostic),/PRIVATE|SECRET|PASSWORD|TOKEN|message|stack/);
    return true;
  });
});

test('startup progress messages do not finish an initialization request',async t=>{
  const worker=createSalesReportBatchWorker({workerFile,workerConfiguration:{scenario:'success'}});t.after(()=>worker.stop());
  const result=await worker.run({operation:'initialize'});
  assert.equal(result.ready,true);
  if(process.platform==='linux')assert.equal(result.scheduling.applied,true);
});

test('worker timeout keeps its existing public code and observed database phase',async t=>{
  const worker=createSalesReportBatchWorker({workerFile,workerConfiguration:{scenario:'hang'},timeoutMs:700});t.after(()=>worker.stop());
  await assert.rejects(worker.run({operation:'initialize'}),error=>{
    assert.equal(error.code,'IMPORT_REPORT_WORKER_TIMEOUT');
    assert.deepEqual(error.reportWorkerDiagnostic,{phase:'core-database',errorClass:'worker-timeout',originalCode:'IMPORT_REPORT_WORKER_TIMEOUT'});
    return true;
  });
});

test('untrusted diagnostic values do not escape the worker client',async t=>{
  const worker=createSalesReportBatchWorker({workerFile,workerConfiguration:{scenario:'invalid-diagnostic'}});t.after(()=>worker.stop());
  await assert.rejects(worker.run({operation:'initialize'}),error=>{
    assert.equal(error.code,'IMPORT_REPORT_FAILED');assert.equal(error.reportWorkerDiagnostic,undefined);return true;
  });
});

test('a loader failure before the request handler preserves its safe technical code',async t=>{
  const worker=createSalesReportBatchWorker({workerFile,workerConfiguration:{scenario:'module-failure'}});t.after(()=>worker.stop());
  await assert.rejects(worker.run({operation:'initialize'}),error=>{
    assert.equal(error.code,'IMPORT_REPORT_WORKER_FAILED');
    assert.deepEqual(error.reportWorkerDiagnostic,{phase:'worker-load',errorClass:'module-load',originalCode:'MODULE_NOT_FOUND'});
    return true;
  });
});

test('classification preserves known codes but neither guesses cancellation cause nor echoes arbitrary text',()=>{
  assert.deepEqual(classifyReportWorkerError({code:'57014',message:'SECRET'},'sales-database'),
    {phase:'sales-database',errorClass:'query-cancelled',originalCode:'57014'});
  assert.deepEqual(classifyReportWorkerError({message:'Connection terminated due to connection timeout'},'core-database'),
    {phase:'core-database',errorClass:'connection-timeout'});
  assert.deepEqual(classifyReportWorkerError({message:'Query read timeout SECRET',code:'PRIVATE'},'PRIVATE'),
    {phase:'worker-load',errorClass:'unknown'});
  assert.equal(sanitizeReportWorkerDiagnostic({phase:'PRIVATE',errorClass:'unknown'}),null);
  assert.deepEqual(sanitizeReportWorkerDiagnostic({phase:'sales-database',errorClass:'query-timeout',originalCode:'53300',password:'SECRET'}),
    {phase:'sales-database',errorClass:'query-timeout'});
});
