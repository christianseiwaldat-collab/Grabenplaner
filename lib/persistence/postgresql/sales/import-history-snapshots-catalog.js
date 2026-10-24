'use strict';
const {compileSalesEntry}=require('./catalog');
const {CATALOG:source}=require('../../catalogs/import-history-snapshots-catalog');
const {S}=require('../../statements/import-history-snapshots');
const CATALOG=Object.freeze(source.map(entry=>{
 if(entry.statement===S.membersPut)return Object.freeze({statement:entry.statement,returning:false,parameterOrder:['rows'],
  sql:`INSERT INTO integration.import_history_snapshot_members(run_id,row_number,record_id,revision,payload)
   SELECT v."runId",v."rowNumber",v."recordId",v.revision,v.payload
   FROM jsonb_to_recordset($1::jsonb) AS v("runId" text,"rowNumber" bigint,"recordId" text,revision bigint,payload text)
   WHERE EXISTS(SELECT 1 FROM integration.import_history_snapshots s WHERE s.run_id=v."runId" AND s.status='building')
   ON CONFLICT(run_id,row_number) DO UPDATE SET record_id=EXCLUDED.record_id,revision=EXCLUDED.revision,payload=EXCLUDED.payload`});
 return compileSalesEntry(entry,8).providerEntry;
}));
module.exports={CATALOG};
