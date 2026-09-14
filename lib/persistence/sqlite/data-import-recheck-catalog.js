'use strict';
const {RECHECK:S}=require('../statements/data-import-recheck');
// One state at a time uses the existing (run_id,state,row_number) index. Finished
// prefixes leave the queue, including during an interrupted recheck.
const states="state IN ('create','update','refresh','unchanged','conflict') AND (state<>'conflict' OR issue<>'SOURCE_KEY_CONFLICT')";
const DATA_IMPORT_RECHECK_CATALOG=Object.freeze([
  {statement:S.pendingRecheck,sql:`SELECT state FROM data_import_rows WHERE run_id=$runId AND ${states} ORDER BY state,row_number LIMIT 1`,returning:false},
  {statement:S.resetReviewBatch,sql:`UPDATE data_import_rows SET state='staged',issue='' WHERE run_id=$runId AND row_number IN
    (SELECT row_number FROM data_import_rows WHERE run_id=$runId AND state=$state AND ${states} ORDER BY row_number LIMIT $limit)`,returning:false},
]);
module.exports={DATA_IMPORT_RECHECK_CATALOG};
