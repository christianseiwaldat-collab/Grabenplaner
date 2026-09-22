'use strict';
// Updates stay forbidden. Only blocks with no row/change references may be
// collected by the explicitly requested deletion of an unapplied source.
function ensureImportDeleteSchema(db){db.exec(`
 CREATE INDEX IF NOT EXISTS import_history_reference_master ON import_history_references(master_record_id,role,record_id,revision);
 CREATE INDEX IF NOT EXISTS data_import_row_payload_block ON data_import_row_payload_refs(block_id);
 CREATE INDEX IF NOT EXISTS data_import_change_payload_block ON data_import_change_payload_refs(block_id);
 DROP TRIGGER IF EXISTS data_import_payload_blocks_no_delete;
 CREATE TRIGGER data_import_payload_blocks_no_delete BEFORE DELETE ON data_import_payload_blocks
 WHEN EXISTS(SELECT 1 FROM data_import_row_payload_refs WHERE block_id=OLD.id)
   OR EXISTS(SELECT 1 FROM data_import_change_payload_refs WHERE block_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'DATA_IMPORT_PAYLOAD_BLOCK_REFERENCED'); END;
`);}
module.exports={ensureImportDeleteSchema};
