'use strict';
const {definePersistenceStatement}=require('../contract');
const {IMPORT_MASTER_STATEMENTS:M}=require('./import-master-data');
const {IMPORT_HISTORY_STATEMENTS:H}=require('./import-history');
const READERS=Object.freeze([M.find,M.get,M.segments,H.find,H.get,H.version,H.segments,H.references,M.getBinding].map(statement=>Object.freeze({
 domain:statement===M.getBinding?'core':'sales',
 source:statement,batch:definePersistenceStatement({id:'import-reader-batches.'+statement.id,operation:'queryAll',parameters:{requests:'json'},columns:{batchOrdinal:'safe_integer',...statement.columns}}),
})));
module.exports={IMPORT_READER_BATCHES:READERS};
