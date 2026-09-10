'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), http = require('node:http');
const { createSalesReportBatchWorker } = require('../lib/sales-report-batch-worker');
const workerFile = path.resolve(__dirname, '../test-support/sales-report-load-worker.js');
test('CPU-heavy reporting leaves HTTP responsive and worker shutdown is bounded', async t => {
  const worker = createSalesReportBatchWorker({ workerFile }); t.after(() => worker.stop());
  const server = http.createServer((req, res) => res.end('ready'));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  let completed = false;
  const calculation = worker.run({ milliseconds: 1200 }).then(result => { completed = true; return result; });
  await new Promise(r => setTimeout(r, 150));
  const start = performance.now(), response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await response.text(), 'ready'); assert.equal(completed, false);
  assert.ok(performance.now() - start < 800, 'HTTP must finish while the calculation is still running');
  assert.equal((await calculation).complete, true);
  const interrupted = worker.run({ milliseconds: 30000 });
  const failed = assert.rejects(interrupted, e => e.code === 'IMPORT_REPORT_WORKER_FAILED');
  await worker.stop(); await failed;
});
test('a timed-out worker is replaced and does not poison the next request', async t => {
  const worker = createSalesReportBatchWorker({ workerFile, timeoutMs: 500 }); t.after(() => worker.stop());
  await assert.rejects(worker.run({ milliseconds: 5000 }), e => e.code === 'IMPORT_REPORT_WORKER_TIMEOUT');
  assert.equal((await worker.run({ milliseconds: 0 })).complete, true);
});
