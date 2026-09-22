'use strict';
const GiB=1024**3;
function bytes(value){
 const result=Number(value);
 if(!Number.isSafeInteger(result)||result<0||value===null||value==='')throw new Error('PG_PAIR_RESTORE_SIZE_INVALID');
 return result;
}
function restoreCapacity(manifest){
 const measured=manifest.checkpoint?.databaseBytes;
 const files=manifest.files||[];
 const extra=files.filter(f=>!['core.dump','sales.dump'].includes(f.file)).reduce((sum,f)=>sum+bytes(f.bytes),0);
 let databaseBytes,basis;
 if(measured!==undefined){
  databaseBytes=bytes(measured.core)+bytes(measured.sales);
  if(databaseBytes<=0)throw new Error('PG_PAIR_RESTORE_SIZE_INVALID');
  basis='measured-database-size';
 }else{
  // Older sealed bundles have no physical measurement. Compressed dumps are
  // only a conservative estimate; they must never be presented as a measurement.
  databaseBytes=files.filter(f=>['core.dump','sales.dump'].includes(f.file)).reduce((sum,f)=>sum+bytes(f.bytes),0)*8;
  basis='legacy-dump-estimate';
 }
 const requiredBytes=Math.max(10*GiB,Math.ceil(databaseBytes*(measured===undefined?1:1.5))+extra+2*GiB);
 if(!Number.isSafeInteger(requiredBytes))throw new Error('PG_PAIR_RESTORE_SIZE_INVALID');
 return {requiredBytes,basis};
}
function assertRestoreCapacity(manifest,availableBytes){
 const estimate=restoreCapacity(manifest);
 if(bytes(availableBytes)<estimate.requiredBytes)throw Object.assign(new Error('PG_PAIR_RESTORE_DISK_RESERVE'),estimate);
 return estimate;
}
module.exports={restoreCapacity,assertRestoreCapacity};
