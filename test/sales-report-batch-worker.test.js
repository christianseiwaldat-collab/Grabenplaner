'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), http = require('node:http');
const { createSalesReportBatchWorker } = require('../lib/sales-report-batch-worker');
const workerFile = path.resolve(__dirname, '../test-support/sales-report-load-worker.js');
test('CPU-heavy reporting leaves HTTP responsive and worker shutdown is bounded', async t => {
  const worker = createSalesReportBatchWorker({ workerFile }); t.after(() => worker.stop());
  const releaseSignal=new SharedArrayBuffer(12),signal=new Int32Array(releaseSignal);
  t.after(()=>Atomics.store(signal,0,1));
  let requestDuringWork=false;
  const server = http.createServer((req, res) => {requestDuringWork=Atomics.load(signal,1)===1&&Atomics.load(signal,2)===0;res.end('ready');});
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  let completed = false;
  const calculation = worker.run({ releaseSignal }).then(result => { completed = true; return result; });
  const deadline=performance.now()+10000;
  while(Atomics.load(signal,1)!==1&&performance.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(Atomics.load(signal,1),1,'worker must start before the HTTP probe');
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await response.text(), 'ready'); assert.equal(completed, false);
  assert.equal(requestDuringWork,true,'HTTP must be handled while the worker is doing CPU work');
  Atomics.store(signal,0,1);
  assert.deepEqual(await calculation,{complete:true,released:true});
  const interrupted = worker.run({ milliseconds: 30000 });
  const failed = assert.rejects(interrupted, e => e.code === 'IMPORT_REPORT_WORKER_FAILED');
  await worker.stop(); await failed;
});
test('a timed-out worker is replaced and does not poison the next request', async t => {
  const worker = createSalesReportBatchWorker({ workerFile, timeoutMs: 500 }); t.after(() => worker.stop());
  // Advance the client deadline explicitly; worker creation still uses a real
  // thread and cannot fail merely because a shared runner starts it slowly.
  t.mock.timers.enable({apis:['setTimeout']});
  const timedOut=assert.rejects(worker.run({ milliseconds: 5000 }), e => e.code === 'IMPORT_REPORT_WORKER_TIMEOUT');
  t.mock.timers.tick(500);await timedOut;
  assert.equal((await worker.run({ milliseconds: 0 })).complete, true);
});
