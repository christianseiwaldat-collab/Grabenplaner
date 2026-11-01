'use strict';
const {definePersistenceStatement}=require('../contract');
const {DATA_IMPORT_COLUMNS}=require('./data-import');
const ISSUE_ROWS=definePersistenceStatement({id:'data-import.rows.issues',operation:'queryAll',
  parameters:{runId:'text',state:'text',after:'safe_integer',limit:'safe_integer'},columns:DATA_IMPORT_COLUMNS.ROW});
module.exports={ISSUE_ROWS};
