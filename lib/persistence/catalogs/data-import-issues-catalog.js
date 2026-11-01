'use strict';
const {ISSUE_ROWS}=require('../statements/data-import-issues');
const {DATA_IMPORT_COLUMNS}=require('../statements/data-import');
const columns=Object.keys(DATA_IMPORT_COLUMNS.ROW).map(name=>`${name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())} AS "${name}"`).join(', ');
const IMPORT_ISSUES_CATALOG=Object.freeze([Object.freeze({statement:ISSUE_ROWS,returning:false,
  sql:`SELECT ${columns} FROM data_import_rows WHERE run_id=$runId AND state=$state AND row_number>$after ORDER BY row_number LIMIT $limit`})]);
module.exports={IMPORT_ISSUES_CATALOG};
