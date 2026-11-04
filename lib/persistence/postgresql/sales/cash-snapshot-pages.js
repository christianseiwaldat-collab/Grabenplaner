'use strict';
const {CASH_SNAPSHOT_TABLES:TABLES}=require('../../statements/cash-snapshots');
const PAGE_IDS=new Set(TABLES.map(table=>table.statements.page.id));

// The installed cash primary keys are (dataset_slot, source_row), with both
// columns NOT NULL. SQLite's translated NULLS FIRST prevents PostgreSQL from
// using that index order and sorts the remaining dataset for every small page.
// Preserve the frozen migration catalogs; only runtime page reads use the
// equivalent NULLS LAST order of the existing ascending primary key.
function indexedCashSnapshotPages(entries){
  return entries.map(entry=>{
    if(!PAGE_IDS.has(entry.statement.id))return entry;
    return Object.freeze({...entry,sql:entry.sql.replace(/\bsource_row NULLS FIRST\b/g,'source_row NULLS LAST')});
  });
}
module.exports={indexedCashSnapshotPages};
