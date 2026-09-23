'use strict';
const crypto=require('node:crypto');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS}=require('./layout');
const statements=[
 'CREATE INDEX data_import_links_last_run ON integration.data_import_links(last_run_id)',
 'CREATE INDEX import_history_versions_run ON integration.import_history_versions(run_id)',
 'CREATE TABLE gp.import_delete_performance_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)',
 'REVOKE ALL ON gp.import_delete_performance_history FROM PUBLIC,gp_sales_app,gp_sales_reader',
 'GRANT SELECT ON gp.import_delete_performance_history TO gp_sales_app,gp_sales_reader',
];
const digest=crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex');
async function target(client,base){
 if(!(await client.query("SELECT to_regclass('gp.import_delete_performance_history') AS name")).rows[0].name)return base;
 const rows=(await client.query('SELECT * FROM gp.import_delete_performance_history')).rows;
 if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==digest||rows[0].base_target_sha256!==base)throw new Error('Import deletion performance contract mismatch');
 return rows[0].target_sha256;
}
// The caller owns the migration lock and serializable owner transaction.
async function migrateWithinTransaction(client,base){
 const current=await schemaFingerprint(client,SCHEMAS),expected=await target(client,base);
 if(current!==expected)throw new Error('Import deletion performance schema drift');
 if(expected!==base)return {applied:false,target:expected};
 for(const sql of statements)await client.query(sql);
 const result=await schemaFingerprint(client,SCHEMAS);
 await client.query('INSERT INTO gp.import_delete_performance_history VALUES(1,$1,$2,$3)',[digest,base,result]);
 return {applied:true,target:result};
}
module.exports={statements,digest,target,migrateWithinTransaction};
