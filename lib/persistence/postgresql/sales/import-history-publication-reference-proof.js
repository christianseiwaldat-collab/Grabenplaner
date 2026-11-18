'use strict';
// Retain the immutable predecessor and install this proof as a new extension.
const crypto=require('node:crypto');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS}=require('./layout');
const predecessor=require('./import-history-publication-performance');
const previous=predecessor.statements.find(sql=>sql.startsWith('CREATE OR REPLACE FUNCTION gp.certify_history_snapshot('));
const guard=`
  -- The immediate, validated FK certifies version existence on every member
  -- write and prevents deletion of referenced versions. Fail closed if that
  -- contract or any of its enforcement triggers has been changed.
  LOCK TABLE integration.import_history_snapshot_members,integration.import_history_versions IN ACCESS SHARE MODE;
  IF current_setting('session_replication_role')<>'origin' OR NOT EXISTS (
   SELECT 1 FROM pg_constraint fk
   WHERE fk.conrelid='integration.import_history_snapshot_members'::regclass
    AND fk.confrelid='integration.import_history_versions'::regclass
    AND fk.contype='f' AND fk.convalidated AND fk.conenforced AND NOT fk.condeferrable
    AND fk.confdeltype='r' AND fk.confupdtype='a'
    AND fk.conkey=ARRAY[
     (SELECT attnum FROM pg_attribute WHERE attrelid=fk.conrelid AND attname='record_id' AND NOT attisdropped),
     (SELECT attnum FROM pg_attribute WHERE attrelid=fk.conrelid AND attname='revision' AND NOT attisdropped)]::smallint[]
    AND fk.confkey=ARRAY[
     (SELECT attnum FROM pg_attribute WHERE attrelid=fk.confrelid AND attname='record_id' AND NOT attisdropped),
     (SELECT attnum FROM pg_attribute WHERE attrelid=fk.confrelid AND attname='revision' AND NOT attisdropped)]::smallint[]
    AND (SELECT count(*) FROM pg_attribute WHERE attrelid=fk.conrelid
     AND attname IN ('record_id','revision') AND attnotnull AND NOT attisdropped)=2
    AND (SELECT count(*) FROM pg_trigger WHERE tgconstraint=fk.oid)=4
    AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgconstraint=fk.oid AND tgenabled NOT IN ('O','A'))
  ) THEN RAISE EXCEPTION 'IMPORT_HISTORY_REFERENCE_CONTRACT' USING ERRCODE='23514'; END IF;`;
const versionJoin='   LEFT JOIN integration.import_history_versions v ON v.record_id=m.record_id AND v.revision=m.revision\n';
if(!previous||!previous.includes(versionJoin)||!previous.includes('COUNT(r.id) FILTER (WHERE v.record_id IS NOT NULL) AS qualified'))
 throw new Error('Import history reference proof predecessor mismatch');
const certify=previous.replace(' BEGIN\n',' BEGIN\n'+guard+'\n')
 .replace('COUNT(r.id) FILTER (WHERE v.record_id IS NOT NULL) AS qualified','COUNT(r.id) AS qualified')
 .replace(versionJoin,'');
const ledger='gp.import_history_reference_proof_migration_history';
const statements=Object.freeze([
 certify,
 `CREATE TABLE ${ledger}(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)`,
 `REVOKE ALL ON ${ledger} FROM PUBLIC,gp_sales_app,gp_sales_reader`,
 `GRANT SELECT ON ${ledger} TO gp_sales_app,gp_sales_reader`,
]);
const digest=crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex');
async function target(client,base){
 if(!(await client.query("SELECT to_regclass('"+ledger+"') AS name")).rows[0].name)return base;
 const rows=(await client.query('SELECT * FROM '+ledger)).rows;
 if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==digest||rows[0].base_target_sha256!==base)
  throw new Error('Import history reference proof migration contract mismatch');
 return rows[0].target_sha256;
}
async function migrateWithinTransaction(client,base){
 const expected=await target(client,base);
 if(await schemaFingerprint(client,SCHEMAS)!==expected)throw new Error('Import history reference proof schema drift');
 if(expected!==base)return {applied:false,target:expected};
 for(const sql of statements)await client.query(sql);
 const result=await schemaFingerprint(client,SCHEMAS);
 await client.query('INSERT INTO '+ledger+' VALUES(1,$1,$2,$3)',[digest,base,result]);
 return {applied:true,target:result};
}
async function rollbackWithinTransaction(client,base){
 const expected=await target(client,base);
 if(await schemaFingerprint(client,SCHEMAS)!==expected)throw new Error('Import history reference proof rollback schema drift');
 if(expected===base)return {applied:false,target:base};
 await client.query(previous);await client.query('DROP TABLE '+ledger);
 if(await schemaFingerprint(client,SCHEMAS)!==base)throw new Error('Import history reference proof rollback mismatch');
 return {applied:true,target:base};
}
module.exports={statements,digest,target,migrateWithinTransaction,rollbackWithinTransaction};
