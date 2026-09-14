'use strict';
const C=require('./data-import-contract');
function importFailure(error){
  if(error instanceof C.DataImportError)throw error;
  if(error?.code==='PERSISTENCE_RETRYABLE_TRANSACTION')C.fail('IMPORT_CONCURRENT_CHANGE',409);
  if(['PERSISTENCE_TIMEOUT','PERSISTENCE_BUSY','PERSISTENCE_CONNECTION_UNAVAILABLE'].includes(error?.code))C.fail('IMPORT_RETRY_LATER',503);
  C.fail('IMPORT_OPERATION_FAILED',500);
}
module.exports={importFailure};
