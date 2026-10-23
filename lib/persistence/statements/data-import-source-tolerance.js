'use strict';
const {definePersistenceStatement}=require('../contract');
const SOURCE_TOLERANCE=Object.freeze({
  listSourceToleranceEvents:definePersistenceStatement({id:'data-import.events.source-tolerances',operation:'queryAll',parameters:{runId:'text'},
    columns:{id:'text',runId:'text',revision:'safe_integer',actorId:'text',action:'text',at:'utc_timestamp'}}),
});
module.exports={SOURCE_TOLERANCE};
