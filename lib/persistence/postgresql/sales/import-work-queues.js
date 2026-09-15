'use strict';
const {DATA_IMPORT_STATEMENTS:S}=require('../../statements/data-import');
const {RECHECK}=require('../../statements/data-import-recheck');
const WORK_QUEUE_IDS=new Set([S.pendingReview,S.pendingApply,S.pendingUndo,S.listRows,S.findIdentity,S.undoPage,
  RECHECK.pendingRecheck,RECHECK.resetReviewBatch].map(s=>s.id));

// These queue keys are NOT NULL in the installed, fingerprinted import schema.
// SQLite's translated NULLS FIRST adds a sort in front of PostgreSQL's existing
// indexes, rescanning the large source for every small packet. Null placement
// cannot change these results. Keep historical migration catalogs immutable;
// apply the equivalent index order only when composing the running provider.
function indexedImportWorkQueues(entries){
  return entries.map(entry=>{
    if(!WORK_QUEUE_IDS.has(entry.statement.id))return entry;
    const sql=entry.sql.replace(/\b(state|row_number) NULLS FIRST\b/g,'$1 NULLS LAST')
      .replace(/\brow_number DESC NULLS LAST\b/g,'row_number DESC NULLS FIRST');
    return Object.freeze({...entry,sql});
  });
}
module.exports={indexedImportWorkQueues};
