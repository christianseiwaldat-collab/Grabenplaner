"use strict";
const { workerData, parentPort } = require('node:worker_threads');
const { readTradeFotoFullSource } = require('./tradefoto-full-import-source');
let sequence = 0, pending = null;
parentPort.on('message', message => {
  if (!pending || message?.sequence !== sequence || message.type !== 'ack') return;
  const resolve = pending; pending = null; resolve(message.result);
});
const send = payload => new Promise(resolve => { pending = resolve; parentPort.postMessage({ sequence: ++sequence, payload }); });
(async () => {
  const buffer = Buffer.from(workerData.bytes);
  try { await readTradeFotoFullSource({ buffer, kind: workerData.kind, password: workerData.password, send }); }
  catch (error) { parentPort.postMessage({ error: /^IMPORT_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'IMPORT_SOURCE_READ_FAILED' }); }
  finally { buffer.fill(0); workerData.password = ''; parentPort.close(); }
})();
