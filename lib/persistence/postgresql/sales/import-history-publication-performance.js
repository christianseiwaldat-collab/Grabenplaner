'use strict';
// A versioned extension: the original attestation contract remains immutable.
const crypto=require('node:crypto');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS}=require('./layout');
const predecessor=require('./import-history-attestations');
const original=name=>predecessor.statements.find(s=>s.startsWith('CREATE FUNCTION gp.'+name+'('));
const recordsChanged=['scope_id','source_instance','source','source_table','profile_hash']
 .map(f=>`o.${f} IS DISTINCT FROM n.${f}`).join(' OR ');
const statements=[
 `CREATE INDEX import_history_stock_identity ON integration.import_history_records(scope_id,source_instance,profile_hash,id)
  WHERE source='trade' AND source_table='ARTIKEL_FILIALEN'`,
 'CREATE INDEX import_history_member_coverage ON integration.import_history_snapshot_members(run_id,row_number) INCLUDE(record_id,revision)',
 `CREATE OR REPLACE FUNCTION gp.certify_history_snapshot(target TEXT) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog AS $body$
 DECLARE h integration.import_history_snapshots%ROWTYPE; c RECORD;
 BEGIN
  SELECT * INTO STRICT h FROM integration.import_history_snapshots WHERE run_id=target FOR UPDATE;
  IF h.status<>'published' THEN RAISE EXCEPTION 'IMPORT_HISTORY_SNAPSHOT_UNPUBLISHED' USING ERRCODE='23514'; END IF;
  SELECT COUNT(*) AS count,COALESCE(MIN(m.row_number),0) AS first,COALESCE(MAX(m.row_number),0) AS last,
   COUNT(r.id) FILTER (WHERE v.record_id IS NOT NULL) AS qualified
   INTO c FROM integration.import_history_snapshot_members m
   LEFT JOIN integration.import_history_records r ON r.id=m.record_id
    AND r.scope_id=h.scope_id AND r.source_instance=h.source_instance AND r.profile_hash=h.profile_hash
    AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN'
   LEFT JOIN integration.import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision
   WHERE m.run_id=target;
  IF c.count<>h.expected_rows OR c.first<>(CASE WHEN h.expected_rows>0 THEN 1 ELSE 0 END)
   OR c.last<>h.expected_rows OR c.qualified<>h.expected_rows THEN
   RAISE EXCEPTION 'IMPORT_HISTORY_SNAPSHOT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  INSERT INTO integration.import_history_snapshot_attestations(run_id,header_payload) VALUES(h.run_id,h.payload)
   ON CONFLICT(run_id) DO UPDATE SET header_payload=EXCLUDED.header_payload;
 END $body$`,
 // Ordinary revision advances preserve historical identity. Avoid joining the
 // complete membership history when the transition tables contain no changes
 // to identity or scope. Actual changes still use the original lock/invalidation.
 original('history_records_invalidate_update').replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
  .replace('BEGIN',`BEGIN
   IF NOT EXISTS(SELECT 1 FROM old_rows o FULL JOIN new_rows n ON n.id=o.id
    WHERE o.id IS NULL OR n.id IS NULL OR ${recordsChanged}) THEN RETURN NULL; END IF;`),
 original('history_versions_invalidate_update').replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
  .replace('BEGIN',`BEGIN
   IF NOT EXISTS(SELECT 1 FROM old_rows o FULL JOIN new_rows n ON n.record_id=o.record_id AND n.revision=o.revision
    WHERE o.record_id IS NULL OR n.record_id IS NULL) THEN RETURN NULL; END IF;`),
 'CREATE TABLE gp.import_history_publication_performance_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)',
 'REVOKE ALL ON gp.import_history_publication_performance_history FROM PUBLIC,gp_sales_app,gp_sales_reader',
 'GRANT SELECT ON gp.import_history_publication_performance_history TO gp_sales_app,gp_sales_reader',
];
const digest=crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex');
async function target(client,base){
 if(!(await client.query("SELECT to_regclass('gp.import_history_publication_performance_history') AS name")).rows[0].name)return base;
 const rows=(await client.query('SELECT * FROM gp.import_history_publication_performance_history')).rows;
 if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==digest||rows[0].base_target_sha256!==base)
  throw new Error('Import history publication performance migration contract mismatch');
 return rows[0].target_sha256;
}
async function migrateWithinTransaction(client,base){
 const expected=await target(client,base);
 if(await schemaFingerprint(client,SCHEMAS)!==expected)throw new Error('Import history publication performance schema drift');
 if(expected!==base)return {applied:false,target:expected};
 for(const sql of statements)await client.query(sql);
 const result=await schemaFingerprint(client,SCHEMAS);
 await client.query('INSERT INTO gp.import_history_publication_performance_history VALUES(1,$1,$2,$3)',[digest,base,result]);
 return {applied:true,target:result};
}
async function rollbackWithinTransaction(client,base){
 const expected=await target(client,base);
 if(await schemaFingerprint(client,SCHEMAS)!==expected)throw new Error('Import history publication performance rollback schema drift');
 if(expected===base)return {applied:false,target:base};
 for(const name of ['certify_history_snapshot','history_records_invalidate_update','history_versions_invalidate_update'])
  await client.query(original(name).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
 await client.query('DROP INDEX integration.import_history_stock_identity, integration.import_history_member_coverage');
 await client.query('DROP TABLE gp.import_history_publication_performance_history');
 if(await schemaFingerprint(client,SCHEMAS)!==base)throw new Error('Import history publication performance rollback mismatch');
 return {applied:true,target:base};
}
module.exports={statements,digest,target,migrateWithinTransaction,rollbackWithinTransaction};
