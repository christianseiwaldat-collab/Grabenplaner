'use strict';
const GiB=1024**3;
function bytes(value){
 const result=Number(value);
 if(!Number.isSafeInteger(result)||result<0||value===null||value==='')throw new Error('PG_PAIR_RESTORE_SIZE_INVALID');
 return result;
}
function restoreCapacity(manifest,{rehydrate=false}={}){
 if(typeof rehydrate!=='boolean')throw new Error('PG_PAIR_RESTORE_SIZE_INVALID');
 const measured=rehydrate?manifest.recovery?.rehydrationDatabaseBytes:manifest.checkpoint?.databaseBytes;
 // A reduced dump says nothing about the space needed to expand its archived
 // Access values. Never reuse retained-table estimates for emergency replay.
 if(rehydrate&&(!measured||bytes(measured.core)<=0||bytes(measured.sales)<=0))throw new Error('PG_PAIR_RESTORE_SIZE_INVALID');
 const files=manifest.files||[];
 const extra=files.filter(f=>!['core.dump','sales.dump'].includes(f.file)).reduce((sum,f)=>sum+bytes(f.bytes),0);
 let databaseBytes,basis;
 if(measured!==undefined){
  databaseBytes=bytes(measured.core)+bytes(measured.sales);
  if(databaseBytes<=0)throw new Error('PG_PAIR_RESTORE_SIZE_INVALID');
  basis=rehydrate?'measured-full-before-rehydration':'measured-database-size';
 }else{
  // Older sealed bundles have no physical measurement. Compressed dumps are
  // only a conservative estimate; they must never be presented as a measurement.
  databaseBytes=files.filter(f=>['core.dump','sales.dump'].includes(f.file)).reduce((sum,f)=>sum+bytes(f.bytes),0)*8;
  basis='legacy-dump-estimate';
 }
 // Access replay spools encrypted unique values while the restored DB expands.
 // Reserve an additional original Sales database, beyond normal restore/WAL.
 const accessScratchBytes=rehydrate?bytes(measured.sales):0;
 const requiredBytes=Math.max(10*GiB,Math.ceil(databaseBytes*(measured===undefined?1:1.5))+accessScratchBytes+extra+2*GiB);
 if(!Number.isSafeInteger(requiredBytes))throw new Error('PG_PAIR_RESTORE_SIZE_INVALID');
 return {requiredBytes,basis,...(rehydrate?{accessScratchBytes}:{})};
}
function assertRestoreCapacity(manifest,availableBytes,options){
 const estimate=restoreCapacity(manifest,options);
 if(bytes(availableBytes)<estimate.requiredBytes)throw Object.assign(new Error('PG_PAIR_RESTORE_DISK_RESERVE'),estimate);
 return estimate;
}
module.exports={restoreCapacity,assertRestoreCapacity};
