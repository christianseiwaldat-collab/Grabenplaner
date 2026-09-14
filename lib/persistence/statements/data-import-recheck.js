'use strict';
const {definePersistenceStatement:define}=require('../contract');
const RECHECK=Object.freeze({
  pendingRecheck:define({id:'data-import.recheck.pending',operation:'queryOne',parameters:{runId:'text'},columns:{state:'text'}}),
  resetReviewBatch:define({id:'data-import.recheck.batch',operation:'execute',parameters:{runId:'text',state:'text',limit:'safe_integer'},columns:{}}),
});
module.exports={RECHECK};
