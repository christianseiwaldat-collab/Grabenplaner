'use strict';
const crypto=require('node:crypto');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS,SEARCH_PATH}=require('./layout');
const trigger='trigger_'+crypto.createHash('sha256').update('data_import_payload_blocks_no_delete').digest('hex').slice(0,20);
const statements=[
 'CREATE INDEX import_history_reference_master ON integration.import_history_references(master_record_id,role,record_id,revision)',
 'CREATE INDEX data_import_row_payload_block ON integration.data_import_row_payload_refs(block_id)',
 'CREATE INDEX data_import_change_payload_block ON integration.data_import_change_payload_refs(block_id)',
 `CREATE OR REPLACE FUNCTION gp."${trigger}"() RETURNS trigger LANGUAGE plpgsql SET search_path=${SEARCH_PATH} AS $body$
 BEGIN
 IF EXISTS(SELECT 1 FROM integration.data_import_row_payload_refs WHERE block_id=OLD.id)
 OR EXISTS(SELECT 1 FROM integration.data_import_change_payload_refs WHERE block_id=OLD.id)
 THEN RAISE EXCEPTION USING MESSAGE='DATA_IMPORT_PAYLOAD_BLOCK_REFERENCED',ERRCODE='23514'; END IF;
 RETURN OLD; END $body$`,
 'CREATE TABLE gp.import_delete_migration_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)',
 'REVOKE ALL ON gp.import_delete_migration_history FROM PUBLIC,gp_sales_app,gp_sales_reader',
 'GRANT SELECT ON gp.import_delete_migration_history TO gp_sales_app,gp_sales_reader',
];
const digest=crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex');
async function baseTarget(client,base){
 const exists=(await client.query("SELECT to_regclass('gp.import_delete_migration_history') AS name")).rows[0].name;
 if(!exists)return base;
 const rows=(await client.query('SELECT * FROM gp.import_delete_migration_history')).rows;
 if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==digest||rows[0].base_target_sha256!==base)throw new Error('Import deletion migration contract mismatch');
 return rows[0].target_sha256;
}
async function target(client,base){
 return require('./import-delete-performance').target(client,await baseTarget(client,base));
}
async function migrate(client,{binding}={}){
 await require('../core/environment').verifyEnvironment(client,{domain:'sales',purpose:'migrator',binding});await client.query('SELECT pg_advisory_lock(9261720)');
 try{
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query('SET LOCAL ROLE gp_sales_owner');await client.query('SET LOCAL search_path='+SEARCH_PATH);
  const history=(await client.query('SELECT stage,source_sha256,plan_sha256,target_sha256 FROM gp.sales_migration_history ORDER BY stage')).rows;
  const plan=require('./schema').createSalesSchemaPlan;
  if(JSON.stringify(history.map(r=>r.stage))!=='[5,6,7,8]'||history.some(r=>r.plan_sha256!==plan(r.stage).digest||r.source_sha256!==plan(r.stage).sourceSchemaSha256))throw new Error('Import deletion base contract mismatch');
  const base=history.at(-1).target_sha256,current=await schemaFingerprint(client,SCHEMAS),expected=await target(client,base);
  if(expected!==current)throw new Error('Import deletion schema drift');
  let applied=false;
  if(expected===base){
   for(const sql of statements)await client.query(sql);
   const result=await schemaFingerprint(client,SCHEMAS);await client.query('INSERT INTO gp.import_delete_migration_history VALUES(1,$1,$2,$3)',[digest,base,result]);
   applied=true;
  }
  const performance=require('./import-delete-performance');
  const result=await performance.migrateWithinTransaction(client,await baseTarget(client,base));
  await client.query('COMMIT');return {applied:applied||result.applied,digest,performanceDigest:performance.digest,target:result.target};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{await client.query('SELECT pg_advisory_unlock(9261720)');}
}
module.exports={target,migrate,digest,statements};
