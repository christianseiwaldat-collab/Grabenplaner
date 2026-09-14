'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createDataImportLifecycle}=require('../lib/data-import-lifecycle');
const {streamTradeFotoFullSource}=require('../lib/tradefoto-full-import-reader');
const turn=()=>new Promise(r=>setImmediate(r));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function buffer(){const b=Buffer.alloc(4096);b.write('Standard ACE DB',4);b[0x14]=3;return b;}
function worker(){const w=new EventEmitter();w.postMessage=()=>{};w.terminate=async()=>{w.emit('exit',1);return 1;};return w;}
test('maintenance blocks admission and shutdown waits for checkpoint cleanup after HTTP completion',async()=>{
 let maintenance=false;const life=createDataImportLifecycle({maintenanceActive:()=>maintenance});
 const checkpoint=deferred(),started=deferred();let saved=false;
 const running=life.run(async signal=>{started.resolve(signal);await checkpoint.promise;saved=true;});
 const signal=await started.promise;maintenance=true;
 await assert.rejects(life.run(()=>assert.fail()),{code:'IMPORT_MAINTENANCE'});
 const stopping=life.stop();let closed=false;void stopping.then(()=>{closed=true;});
 assert.equal(signal.aborted,true);await turn();assert.equal(closed,false);
 checkpoint.resolve();await running;await stopping;assert.equal(saved,true);assert.equal(life.active,0);
 maintenance=false;await assert.rejects(life.run(()=>assert.fail()),{code:'IMPORT_MAINTENANCE'});
});
test('worker progress can exceed the idle timeout in total without cancellation',async()=>{
 const w=worker(),received=[];let sequence=0;
 w.postMessage=()=>{if(sequence===6){w.emit('exit',0);return;}setTimeout(()=>w.emit('message',{sequence:++sequence,payload:{type:sequence===6?'complete':'rows'}}),25);};
 const reading=streamTradeFotoFullSource({buffer:buffer(),kind:'bestell',timeoutMs:100,maxDurationMs:1500,workerFactory:()=>w,onMessage:async p=>{received.push(p);await wait(20);}});
 w.postMessage();await reading;assert.equal(received.length,6);
});
test('idle timeout and cancellation wait for an in-flight consumer before releasing its resources',async()=>{
 for(const cancel of [false,true]){
  const w=worker(),pending=deferred(),entered=deferred(),abort=new AbortController();let settled=false;
  const reading=streamTradeFotoFullSource({buffer:buffer(),kind:'bestell',timeoutMs:40,signal:abort.signal,workerFactory:()=>w,onMessage:()=>{entered.resolve();return pending.promise;}});
  const checked=assert.rejects(reading,{code:cancel?'IMPORT_SOURCE_INTERRUPTED':'IMPORT_SOURCE_READ_TIMEOUT'}).then(()=>{settled=true;});
  w.emit('message',{sequence:1,payload:{type:'rows'}});await entered.promise;
  if(cancel)abort.abort();await wait(65);assert.equal(settled,false);
  pending.resolve();await checked;
 }
});
test('progress does not bypass the separately bounded maximum duration',async()=>{
 const w=worker();let sequence=0;
 const interval=setInterval(()=>w.emit('message',{sequence:++sequence,payload:{type:'rows'}}),10);
 try{await assert.rejects(streamTradeFotoFullSource({buffer:buffer(),kind:'bestell',timeoutMs:60,maxDurationMs:100,workerFactory:()=>w,onMessage:()=>{}}),{code:'IMPORT_SOURCE_DURATION_LIMIT'});}finally{clearInterval(interval);}
});
