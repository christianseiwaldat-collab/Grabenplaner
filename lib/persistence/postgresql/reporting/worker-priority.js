'use strict';
const os=require('node:os'),{isMainThread}=require('node:worker_threads');
function lowerCurrentWorkerPriority(){
  if(isMainThread)throw new TypeError('Background worker thread required');
  if(process.platform!=='linux')return Object.freeze({applied:false,platform:process.platform});
  // Linux/NPTL gives each thread its own nice value. pid=0 addresses this
  // calling thread; explicitly addressing process.pid observes the main thread.
  const mainNice=os.getPriority(process.pid);
  os.setPriority(0,19);
  if(os.getPriority(0)!==19||os.getPriority(process.pid)!==mainNice)throw new Error('Worker scheduling isolation unavailable');
  return Object.freeze({applied:true,workerNice:19,mainNice});
}
module.exports={lowerCurrentWorkerPriority};
