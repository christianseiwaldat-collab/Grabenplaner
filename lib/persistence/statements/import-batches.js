'use strict';
// Runtime-only PostgreSQL packets. Historical migration catalogs stay pinned.
const {definePersistenceStatement}=require('../contract');
const {CASH_SNAPSHOT_TABLES:TABLES,CASH_SNAPSHOT_COLUMNS}=require('./cash-snapshots');
const {DATA_IMPORT_COLUMNS:C}=require('./data-import');
const def=(id,operation,parameters,columns={})=>definePersistenceStatement({id:'import-batches.'+id,operation,parameters,columns});
const B=Object.freeze({
 cashInsert:Object.freeze(TABLES.map((t,i)=>def('cash.'+i+'.insert','execute',{rows:'json'}))),
 cashKeys:Object.freeze(TABLES.map((t,i)=>def('cash.'+i+'.keys','queryAll',{datasetSlot:'safe_integer',keys:'json'},CASH_SNAPSHOT_COLUMNS.ROW))),
 identities:def('identities','queryAll',{runId:'text',keys:'json'},C.ROW),
 insertRows:def('rows.insert','execute',{rows:'json'}),
 updateRows:def('rows.update','execute',{rows:'json'}),
 markCreatesApplied:def('rows.apply-creates','execute',{runId:'text',rows:'json'}),
 blocks:def('blocks.get','queryAll',{keys:'json'},C.PAYLOAD_BLOCK),
 insertBlocks:def('blocks.insert','execute',{rows:'json'}),
 links:def('links.get','queryAll',{keys:'json'},C.LINK),
 rowRefs:def('row-refs.get','queryAll',{runId:'text',rows:'json'},C.PAYLOAD_REF),
 deleteRowRefs:def('row-refs.delete','execute',{runId:'text',rows:'json'}),
 insertRowRefs:def('row-refs.insert','execute',{rows:'json'}),
 insertLinks:def('links.insert','execute',{rows:'json'}),
 insertChanges:def('changes.insert','execute',{rows:'json'}),
 insertChangeRefs:def('change-refs.insert','execute',{rows:'json'}),
 masterRecords:def('master-records.insert','execute',{rows:'json'}),
 masterSegments:def('master-segments.insert','execute',{rows:'json'}),
 masterRelations:def('master-relations.insert','execute',{rows:'json'}),
 historyRecords:def('history-records.insert','execute',{rows:'json'}),
 historyVersions:def('history-versions.insert','execute',{rows:'json'}),
 historySegments:def('history-segments.insert','execute',{rows:'json'}),
 historyReferences:def('history-references.insert','execute',{rows:'json'}),
 historyHolds:def('history-holds.check','queryOne',{rows:'json'},{count:'safe_integer'}),
});
module.exports={IMPORT_BATCHES:B};
