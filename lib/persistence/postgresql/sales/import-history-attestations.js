'use strict';
const crypto=require('node:crypto');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS}=require('./layout');
const statements=[
 `CREATE TABLE integration.import_history_snapshot_attestations (
  run_id TEXT COLLATE "C" PRIMARY KEY REFERENCES integration.import_history_snapshots(run_id) ON DELETE CASCADE,
  header_payload TEXT COLLATE "C" NOT NULL
 )`,
 'REVOKE ALL ON integration.import_history_snapshot_attestations FROM PUBLIC,gp_sales_app,gp_sales_reader',
 'GRANT SELECT ON integration.import_history_snapshot_attestations TO gp_sales_app,gp_sales_reader',
 `CREATE FUNCTION gp.certify_history_snapshot(target TEXT) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog AS $body$
 DECLARE h integration.import_history_snapshots%ROWTYPE; c RECORD;
 BEGIN
  SELECT * INTO STRICT h FROM integration.import_history_snapshots WHERE run_id=target FOR UPDATE;
  IF h.status<>'published' THEN RAISE EXCEPTION 'IMPORT_HISTORY_SNAPSHOT_UNPUBLISHED' USING ERRCODE='23514'; END IF;
  SELECT COUNT(*) AS count,COALESCE(MIN(m.row_number),0) AS first,COALESCE(MAX(m.row_number),0) AS last,
   COALESCE(SUM(CASE WHEN r.scope_id=h.scope_id AND r.source_instance=h.source_instance AND r.profile_hash=h.profile_hash
    AND r.source='trade' AND r.source_table='ARTIKEL_FILIALEN' AND v.record_id IS NOT NULL THEN 1 ELSE 0 END),0) AS qualified
   INTO c FROM integration.import_history_snapshot_members m
   LEFT JOIN integration.import_history_records r ON r.id=m.record_id
   LEFT JOIN integration.import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision WHERE m.run_id=target;
  IF c.count<>h.expected_rows OR c.first<>(CASE WHEN h.expected_rows>0 THEN 1 ELSE 0 END)
   OR c.last<>h.expected_rows OR c.qualified<>h.expected_rows THEN
   RAISE EXCEPTION 'IMPORT_HISTORY_SNAPSHOT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  INSERT INTO integration.import_history_snapshot_attestations(run_id,header_payload) VALUES(h.run_id,h.payload)
   ON CONFLICT(run_id) DO UPDATE SET header_payload=EXCLUDED.header_payload;
 END $body$`,
 'REVOKE ALL ON FUNCTION gp.certify_history_snapshot(TEXT) FROM PUBLIC,gp_sales_app,gp_sales_reader',
 `CREATE FUNCTION gp.history_snapshot_publication_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog AS $body$
 BEGIN
  DELETE FROM integration.import_history_snapshot_attestations WHERE run_id=NEW.run_id;
  IF NEW.status='published' AND (TG_OP='INSERT' OR OLD.status='building') THEN
   PERFORM gp.certify_history_snapshot(NEW.run_id);
  END IF;
  RETURN NEW;
 END $body$`,
 'REVOKE ALL ON FUNCTION gp.history_snapshot_publication_guard() FROM PUBLIC,gp_sales_app,gp_sales_reader',
 'CREATE TRIGGER history_snapshot_publication_guard AFTER INSERT OR UPDATE ON integration.import_history_snapshots FOR EACH ROW EXECUTE FUNCTION gp.history_snapshot_publication_guard()',
];
// Invalidation is batched once per statement, including writes outside the
// importer. Parent row locks serialize it with publication. A committed read
// sees either the old certified snapshot or the changed, uncertified snapshot.
function invalidator(name,table,event,changed,referencing){
 statements.push(`CREATE FUNCTION gp.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path=pg_catalog AS $body$
  DECLARE target TEXT;
  BEGIN
   FOR target IN ${changed} ORDER BY 1 LOOP
    PERFORM 1 FROM integration.import_history_snapshots WHERE run_id=target FOR UPDATE;
    DELETE FROM integration.import_history_snapshot_attestations WHERE run_id=target;
   END LOOP;
   RETURN NULL;
  END $body$`,
  `REVOKE ALL ON FUNCTION gp.${name}() FROM PUBLIC,gp_sales_app,gp_sales_reader`,
  `CREATE TRIGGER ${name} AFTER ${event} ON integration.${table} REFERENCING ${referencing} FOR EACH STATEMENT EXECUTE FUNCTION gp.${name}()`);
}
for(const [event,changed,referencing] of [
 ['INSERT','SELECT DISTINCT run_id FROM new_rows','NEW TABLE AS new_rows'],
 ['DELETE','SELECT DISTINCT run_id FROM old_rows','OLD TABLE AS old_rows'],
 ['UPDATE','SELECT run_id FROM old_rows UNION SELECT run_id FROM new_rows','OLD TABLE AS old_rows NEW TABLE AS new_rows'],
])invalidator('history_members_invalidate_'+event.toLowerCase(),'import_history_snapshot_members',event,changed,referencing);
const fields=['scope_id','source_instance','source','source_table','profile_hash'];
invalidator('history_records_invalidate_update','import_history_records','UPDATE',
 `SELECT DISTINCT m.run_id FROM integration.import_history_snapshot_members m JOIN (
 SELECT COALESCE(o.id,n.id) AS id FROM old_rows o FULL JOIN new_rows n ON n.id=o.id
 WHERE o.id IS NULL OR n.id IS NULL OR ${fields.map(f=>`o.${f} IS DISTINCT FROM n.${f}`).join(' OR ')}) changed ON changed.id=m.record_id`,
 'OLD TABLE AS old_rows NEW TABLE AS new_rows');
invalidator('history_records_invalidate_delete','import_history_records','DELETE',
 'SELECT DISTINCT m.run_id FROM integration.import_history_snapshot_members m JOIN old_rows o ON o.id=m.record_id','OLD TABLE AS old_rows');
invalidator('history_versions_invalidate_update','import_history_versions','UPDATE',
 `SELECT DISTINCT m.run_id FROM integration.import_history_snapshot_members m JOIN (
 SELECT COALESCE(o.record_id,n.record_id) AS id,COALESCE(o.revision,n.revision) AS revision
 FROM old_rows o FULL JOIN new_rows n ON n.record_id=o.record_id AND n.revision=o.revision
 WHERE o.record_id IS NULL OR n.record_id IS NULL) changed ON changed.id=m.record_id AND changed.revision=m.revision`,
 'OLD TABLE AS old_rows NEW TABLE AS new_rows');
invalidator('history_versions_invalidate_delete','import_history_versions','DELETE',
 'SELECT DISTINCT m.run_id FROM integration.import_history_snapshot_members m JOIN old_rows o ON o.record_id=m.record_id AND o.revision=m.revision','OLD TABLE AS old_rows');
statements.push(
 // Existing publications are certified once during the controlled migration.
 // A damaged publication aborts the whole migration; no historical failure is hidden.
 "SELECT gp.certify_history_snapshot(run_id) FROM integration.import_history_snapshots WHERE status='published' ORDER BY run_id",
 'CREATE TABLE gp.import_history_attestations_migration_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)',
 'REVOKE ALL ON gp.import_history_attestations_migration_history FROM PUBLIC,gp_sales_app,gp_sales_reader',
 'GRANT SELECT ON gp.import_history_attestations_migration_history TO gp_sales_app,gp_sales_reader',
);
const digest=crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex');
async function target(client,base){
 if(!(await client.query("SELECT to_regclass('gp.import_history_attestations_migration_history') AS name")).rows[0].name)return base;
 const rows=(await client.query('SELECT * FROM gp.import_history_attestations_migration_history')).rows;
 if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==digest||rows[0].base_target_sha256!==base)
  throw new Error('Import history attestations migration contract mismatch');
 return rows[0].target_sha256;
}
async function migrateWithinTransaction(client,base){
 const current=await schemaFingerprint(client,SCHEMAS),expected=await target(client,base);
 if(current!==expected)throw new Error('Import history attestations schema drift');
 if(expected!==base)return {applied:false,target:expected};
 for(const sql of statements)await client.query(sql);
 const result=await schemaFingerprint(client,SCHEMAS);
 await client.query('INSERT INTO gp.import_history_attestations_migration_history VALUES(1,$1,$2,$3)',[digest,base,result]);
 return {applied:true,target:result};
}
module.exports={statements,digest,target,migrateWithinTransaction};
