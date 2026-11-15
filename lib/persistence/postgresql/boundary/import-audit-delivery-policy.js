'use strict';
const {DATA_IMPORT_STATEMENTS:I}=require('../../statements/data-import');
const {IMPORT_BATCHES:B}=require('../../statements/import-batches');

// Only these exact qualified statements write the import's technical staging
// tables without producing Core audit intents. Their count/immutability triggers
// do not append to core_audit_outbox. No prefix, caller flag or cloned statement
// grants this capability; every other Sales write retains conservative delivery.
const IMPORT_WRITES_WITHOUT_AUDIT=Object.freeze([
  I.insertRun,I.updateRun,I.insertRow,I.conflictIdentity,I.resetReview,I.resetReviewBatch,I.updateRow,I.insertEvent,
  I.insertPayloadBlock,I.deleteRowPayloadRefs,I.insertRowPayloadRef,
  B.insertRows,B.updateRows,B.markRowsUnchanged,B.insertBlocks,B.deleteRowRefs,B.insertRowRefs,
]);
const known=new Set(IMPORT_WRITES_WITHOUT_AUDIT);
function importWriteWithoutAudit(statement){return known.has(statement);}
module.exports={IMPORT_WRITES_WITHOUT_AUDIT,importWriteWithoutAudit};
