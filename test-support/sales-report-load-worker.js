'use strict';
// Synthetic CPU load only, for verifying that the real worker client isolates HTTP.
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, input }) => {
  if(input.releaseSignal){
    const signal=new Int32Array(input.releaseSignal),deadline=performance.now()+10000;
    Atomics.store(signal,1,1);
    while(Atomics.load(signal,0)===0&&performance.now()<deadline)Math.sqrt(12345);
    Atomics.store(signal,2,1);
    parentPort.postMessage({id,result:{complete:true,released:Atomics.load(signal,0)===1}});return;
  }
  const end = performance.now() + input.milliseconds;
  while (performance.now() < end) Math.sqrt(12345);
  parentPort.postMessage({ id, result: { complete: true } });
});
