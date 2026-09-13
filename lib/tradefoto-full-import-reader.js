"use strict";
const path = require('node:path');
const { Worker, isMarkedAsUntransferable } = require('node:worker_threads');
const C = require('./data-import-contract');
const { assertSourceBytes } = require('./tradefoto-full-import-source');
const WORKER_MAX_OLD_MB = 512;
function streamTradeFotoFullSource({ buffer, kind, password = '', onMessage, signal, timeoutMs = 1500000, consumeBuffer = false }) {
  assertSourceBytes(buffer);
  return new Promise((resolve,reject) => {
    // HTTP uploads surrender their owned bytes after hashing. Transfer that
    // allocation instead of keeping a second full ACCDB file in the web process.
    // A caller's slice/pool may contain unrelated data and must never be detached.
    const owned = consumeBuffer && buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
      && buffer.buffer instanceof ArrayBuffer && !isMarkedAsUntransferable(buffer.buffer);
    const transferable = owned ? buffer : new Uint8Array(buffer);
    const worker = new Worker(path.join(__dirname,'tradefoto-full-import-worker.js'), {
      workerData: { bytes: transferable.buffer, kind, password }, transferList: [transferable.buffer],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_MB, maxYoungGenerationSizeMb: 32 },
    });
    if (consumeBuffer && buffer.length) buffer.fill(0);
    let settled=false, expected=1, busy=false, completed=false, pending=Promise.resolve();
    const finish = error => {
      if(settled)return; settled=true; clearTimeout(timer); signal?.removeEventListener('abort',abort);
      // Do not destroy the caller's keys while its last acknowledged database
      // transaction is still finishing after cancellation or a worker timeout.
      void Promise.allSettled([worker.terminate(),pending]).then(()=>error?reject(error):resolve());
    };
    const abort = () => finish(new C.DataImportError('IMPORT_SOURCE_INTERRUPTED',409));
    const timer = setTimeout(()=>finish(new C.DataImportError('IMPORT_SOURCE_READ_TIMEOUT',409)),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted) abort();
    worker.on('error',()=>finish(new C.DataImportError('IMPORT_SOURCE_READ_FAILED')));
    worker.on('exit',code=>{ if(!settled) finish(completed && code===0 ? null : new C.DataImportError('IMPORT_SOURCE_READ_INTERRUPTED',409)); });
    worker.on('message', message => {
      if(settled)return;
      if(message?.error) return finish(new C.DataImportError(/^IMPORT_[A-Z0-9_]+$/.test(message.error)?message.error:'IMPORT_SOURCE_READ_FAILED'));
      if(busy || message?.sequence!==expected++ || !message.payload) return finish(new C.DataImportError('IMPORT_SOURCE_PROTOCOL_INVALID'));
      busy=true;
      pending=Promise.resolve().then(()=>onMessage(message.payload));
      void pending.then(()=>{
        if(settled)return;
        completed=message.payload.type==='complete'; busy=false;
        worker.postMessage({type:'ack',sequence:message.sequence});
      }).catch(finish);
    });
  });
}
module.exports = { streamTradeFotoFullSource, WORKER_MAX_OLD_MB };
