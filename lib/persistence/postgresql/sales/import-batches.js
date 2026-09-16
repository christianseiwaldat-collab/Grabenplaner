'use strict';
const {IMPORT_BATCHES:B}=require('../../statements/import-batches');
const {CASH_SNAPSHOT_TABLES:TABLES,CASH_SNAPSHOT_COLUMNS}=require('../../statements/cash-snapshots');
const {DATA_IMPORT_STATEMENTS:S,DATA_IMPORT_COLUMNS:C}=require('../../statements/data-import');
const {IMPORT_MASTER_COLUMNS:M}=require('../../statements/import-master-data');
const {IMPORT_HISTORY_COLUMNS:H}=require('../../statements/import-history');
const {SQLITE_APPLICATION_CATALOG}=require('../../sqlite/application-catalog');
const {compileSalesEntry}=require('./catalog');
const compiled=s=>compileSalesEntry(SQLITE_APPLICATION_CATALOG.find(e=>e.statement===s),8).providerEntry.sql;
const select=s=>compiled(s).split(' WHERE ')[0];
const entry=(statement,sql,parameterOrder)=>Object.freeze({statement,sql,parameterOrder:Object.freeze(parameterOrder),returning:false});
const snake=n=>n.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
const type=definition=>({safe_integer:'bigint',bytes:'text',date:'date',utc_timestamp:'text',text:'text'})[typeof definition==='string'?definition:definition.kind];
function insert(table,columns,conflict=''){
 const fields=Object.keys(columns);
 return `INSERT INTO ${table} (${fields.map(snake).join(',')}) SELECT ${fields.map(n=>(typeof columns[n]==='string'?columns[n]:columns[n].kind)==='bytes'?`decode(v."${n}",'hex')`:`v."${n}"`).join(',')}
 FROM jsonb_to_recordset($1::jsonb) AS v(${fields.map(n=>`"${n}" ${type(columns[n])}`).join(',')})${conflict}`;
}
const IMPORT_BATCH_CATALOG=Object.freeze([
 ...TABLES.flatMap((t,i)=>[
  entry(B.cashInsert[i],insert('kassa.'+t.sqlName,CASH_SNAPSHOT_COLUMNS.ROW),['rows']),
  entry(B.cashKeys[i],select(t.statements.page)+' WHERE dataset_slot=$1::bigint AND source_key IN (SELECT decode(value,\'hex\') FROM jsonb_array_elements_text($2::jsonb))',['datasetSlot','keys']),
 ]),
 entry(B.identities,`SELECT r.* FROM jsonb_array_elements_text($2::jsonb) AS k(value) CROSS JOIN LATERAL (
 ${select(S.findIdentity)} WHERE run_id=$1::text AND identity_hash=k.value ORDER BY row_number LIMIT 1) AS r`,['runId','keys']),
 entry(B.insertRows,insert('integration.data_import_rows',C.ROW),['rows']),
 entry(B.updateRows,`UPDATE integration.data_import_rows r SET state=v.state,issue=v.issue,payload=v.payload
 FROM jsonb_to_recordset($1::jsonb) AS v("runId" text,"rowNumber" bigint,state text,issue text,payload text)
 WHERE r.run_id=v."runId" AND r.row_number=v."rowNumber"`,['rows']),
 entry(B.markCreatesApplied,`UPDATE integration.data_import_rows SET state='applied',issue=''
 WHERE run_id=$1::text AND state='create'
 AND row_number IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb))`,['runId','rows']),
 entry(B.blocks,select(S.getPayloadBlock)+' WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',['keys']),
 entry(B.insertBlocks,insert('integration.data_import_payload_blocks',C.PAYLOAD_BLOCK,' ON CONFLICT (id) DO NOTHING'),['rows']),
 entry(B.links,select(S.getLink)+' WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',['keys']),
 entry(B.rowRefs,'SELECT run_id::text AS "runId",row_number AS "rowNumber",slot::text AS slot,block_id::text AS "blockId" FROM integration.data_import_row_payload_refs WHERE run_id=$1::text AND row_number IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb)) ORDER BY row_number,slot',['runId','rows']),
 entry(B.deleteRowRefs,'DELETE FROM integration.data_import_row_payload_refs WHERE run_id=$1::text AND row_number IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb))',['runId','rows']),
 entry(B.insertRowRefs,insert('integration.data_import_row_payload_refs',C.PAYLOAD_REF),['rows']),
 entry(B.insertLinks,insert('integration.data_import_links',C.LINK),['rows']),
 entry(B.insertChanges,insert('integration.data_import_changes',C.CHANGE),['rows']),
 entry(B.insertChangeRefs,insert('integration.data_import_change_payload_refs',C.PAYLOAD_REF),['rows']),
 entry(B.masterRecords,insert('trade.import_master_records',M.RECORD),['rows']),
 entry(B.masterSegments,insert('trade.import_master_segments',M.SEGMENT),['rows']),
 entry(B.masterRelations,insert('trade.import_master_relations',M.RELATION),['rows']),
 entry(B.historyRecords,insert('integration.import_history_records',H.RECORD),['rows']),
 entry(B.historyVersions,insert('integration.import_history_versions',H.VERSION),['rows']),
 entry(B.historySegments,insert('integration.import_history_segments',H.SEGMENT),['rows']),
 entry(B.historyReferences,insert('integration.import_history_references',H.REFERENCE),['rows']),
 // The actual Sales reference is the hold in the two-database application.
 // Count every requested hold, just as boundary/application verifies it singly.
 entry(B.historyHolds,`SELECT count(*)::bigint AS count FROM jsonb_to_recordset($1::jsonb)
 AS v("recordId" text,"historyId" text,revision bigint) WHERE EXISTS (
 SELECT 1 FROM integration.import_history_references r WHERE r.master_record_id=v."recordId"
 AND r.record_id=v."historyId" AND r.revision=v.revision)`,['rows']),
]);
module.exports={IMPORT_BATCH_CATALOG};
