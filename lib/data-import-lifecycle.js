"use strict";
const {DataImportError}=require('./data-import-contract');

// Tracks work after its HTTP 202 response, so server.close() alone cannot close
// the database underneath a source checkpoint. No source files or keys live here.
function createDataImportLifecycle({maintenanceActive=()=>false}={}) {
  let stopping=false,stopPromise;
  const jobs=new Set();
  function assertAvailable(){
    if(stopping||maintenanceActive())throw new DataImportError('IMPORT_MAINTENANCE',503);
  }
  async function run(work){
    assertAvailable();
    const controller=new AbortController(),job={controller,done:null};
    jobs.add(job);
    job.done=Promise.resolve().then(()=>work(controller.signal)).finally(()=>jobs.delete(job));
    return job.done;
  }
  function stop(){
    if(stopPromise)return stopPromise;
    stopping=true;
    for(const job of jobs)job.controller.abort();
    // The reader settles only after its current acknowledged database operation
    // AND the interrupted-source status have finished. Never race DB close.
    stopPromise=Promise.allSettled([...jobs].map(job=>job.done)).then(()=>undefined);
    return stopPromise;
  }
  return Object.freeze({run,stop,assertAvailable,get active(){return jobs.size;}});
}
module.exports={createDataImportLifecycle};
