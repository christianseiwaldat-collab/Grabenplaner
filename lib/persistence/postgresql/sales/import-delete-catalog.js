'use strict';
const {CATALOG}=require('../../sqlite/data-import-delete-catalog');
const {compileSalesEntry}=require('./catalog');
module.exports={CATALOG:Object.freeze(CATALOG.filter(e=>!['data-import-delete.source','data-import-delete.audit'].includes(e.statement.id)).map(entry=>{
 if(entry.statement.id==='data-import-delete.orphan-blocks')return {statement:entry.statement,returning:false,parameterOrder:['ids'],sql:`DELETE FROM integration.data_import_payload_blocks b WHERE b.id IN (SELECT jsonb_array_elements_text($1::jsonb))
 AND NOT EXISTS(SELECT 1 FROM integration.data_import_row_payload_refs r WHERE r.block_id=b.id)
 AND NOT EXISTS(SELECT 1 FROM integration.data_import_change_payload_refs c WHERE c.block_id=b.id)`};
 return compileSalesEntry(entry,8).providerEntry;
}))};
