'use strict';
const {definePersistenceStatement}=require('../contract');
const catalog=[],S={};
function add(key,operation,parameters,columns,sql){const statement=definePersistenceStatement({id:'data-import-delete.'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),operation,parameters,columns});S[key]=statement;catalog.push({statement,sql,returning:false});}
const run={runId:'text'},source={id:'text',scopeId:'text',ownerId:'text',revision:'safe_integer'};
add('dependencies','queryOne',run,{count:'safe_integer'},`SELECT
 (SELECT COUNT(*) FROM data_import_changes WHERE run_id=$runId)+
 (SELECT COUNT(*) FROM data_import_links WHERE last_run_id=$runId)+
 (SELECT COUNT(*) FROM import_history_versions WHERE run_id=$runId)+
 (SELECT COUNT(*) FROM data_import_rows WHERE run_id=$runId AND state IN ('applied','reverted')) AS count`);
add('blocks','queryAll',{...run,through:'safe_integer'},{id:'text'},'SELECT DISTINCT block_id AS id FROM data_import_row_payload_refs WHERE run_id=$runId AND row_number<=$through');
add('rowRefs','execute',{...run,through:'safe_integer'},{},'DELETE FROM data_import_row_payload_refs WHERE run_id=$runId AND row_number<=$through');
add('rows','execute',{...run,through:'safe_integer'},{},'DELETE FROM data_import_rows WHERE run_id=$runId AND row_number<=$through');
add('orphanBlocks','execute',{ids:'json'},{},`DELETE FROM data_import_payload_blocks WHERE id IN (SELECT value FROM json_each($ids))
 AND NOT EXISTS(SELECT 1 FROM data_import_row_payload_refs r WHERE r.block_id=data_import_payload_blocks.id)
 AND NOT EXISTS(SELECT 1 FROM data_import_change_payload_refs c WHERE c.block_id=data_import_payload_blocks.id)`);
add('events','execute',run,{},'DELETE FROM data_import_events WHERE run_id=$runId');
add('counts','execute',run,{},'DELETE FROM data_import_run_state_counts WHERE run_id=$runId');
add('run','execute',{...run,scopeId:'text',ownerId:'text'}, {},"DELETE FROM data_import_runs WHERE id=$runId AND scope_id=$scopeId AND owner_id=$ownerId AND status IN ('staging','reviewing','needs_review','ready','cancelled','purged')");
add('source','execute',source,{},'DELETE FROM data_import_sources WHERE id=$id AND scope_id=$scopeId AND owner_id=$ownerId AND revision=$revision');
add('audit','execute',{actor:'text',action:'text',entityType:'text',entityId:'text',detail:'json',timestamp:'text'}, {},'INSERT INTO audit_log(actor,action,entity_type,entity_id,detail,created_at) VALUES($actor,$action,$entityType,$entityId,$detail,$timestamp)');
add('publications','queryOne',{id:'text'},{count:'safe_integer'},'SELECT COUNT(*) AS count FROM cash_publications WHERE dataset_id=$id');
const cash={datasetSlot:'safe_integer',through:'safe_integer'};
for(const [i,t] of require('../statements/cash-snapshots').CASH_SNAPSHOT_TABLES.entries())add('cash'+i,'execute',cash,{},`DELETE FROM ${t.sqlName} WHERE dataset_slot=$datasetSlot AND source_row<=$through`);
add('cashInventory','execute',{datasetSlot:'safe_integer'},{},'DELETE FROM cash_snapshot_inventory WHERE dataset_slot=$datasetSlot');
add('cashDataset','execute',{id:'text',scopeId:'text',ownerId:'text'},{},'DELETE FROM cash_snapshot_datasets WHERE id=$id AND scope_id=$scopeId AND owner_id=$ownerId');
module.exports={S:Object.freeze(S),CATALOG:Object.freeze(catalog)};
