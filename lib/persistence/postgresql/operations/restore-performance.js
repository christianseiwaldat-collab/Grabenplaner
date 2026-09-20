'use strict';
// Fixed, bounded profiles for disposable recovery clusters only. No environment
// or HTTP-provided flags, database endpoints, or productive settings are accepted.
const profiles=Object.freeze({
 baseline:Object.freeze({jobs:1,sharedBuffersMB:64,maintenanceWorkMemMB:32,indexWorkers:2}),
 memory:Object.freeze({jobs:1,sharedBuffersMB:64,maintenanceWorkMemMB:256,indexWorkers:2}),
 parallel:Object.freeze({jobs:2,sharedBuffersMB:64,maintenanceWorkMemMB:256,indexWorkers:0}),
});
function restorePerformance(name='parallel'){
 if(typeof name!=='string'||!Object.hasOwn(profiles,name))throw new Error('PG_PAIR_RESTORE_PROFILE');
 return profiles[name];
}
function restoreArguments(database,dump,name='parallel'){
 const {jobs}=restorePerformance(name);
 // Two jobs cannot share one transaction. The destination is always a new,
 // private cluster: failure rejects the complete proof and stops that cluster.
 return ['--exit-on-error',jobs===1?'--single-transaction':'--jobs='+jobs,'--dbname='+database,dump];
}
function restoreSettings(name='parallel'){
 const p=restorePerformance(name);
 // Bound index workers to the two restore connections; avoid nested parallelism.
 return `shared_buffers='${p.sharedBuffersMB}MB'\nwork_mem='4MB'\nmaintenance_work_mem='${p.maintenanceWorkMemMB}MB'\nmax_parallel_maintenance_workers=${p.indexWorkers}\n`;
}
module.exports={restorePerformance,restoreArguments,restoreSettings};
