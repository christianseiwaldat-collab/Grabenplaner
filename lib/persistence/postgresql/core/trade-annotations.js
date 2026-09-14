'use strict';
const crypto=require('node:crypto');
const {schemaFingerprint}=require('./fingerprint');
const {compileCoreEntry}=require('./catalog');
const statements=[
 'CREATE TABLE gp.trade_annotations(id TEXT COLLATE "C" PRIMARY KEY,scope_id TEXT COLLATE "C" NOT NULL,kind TEXT COLLATE "C" NOT NULL,revision BIGINT NOT NULL CHECK(revision>0),payload TEXT NOT NULL)',
 'REVOKE ALL ON gp.trade_annotations FROM PUBLIC',
 'GRANT SELECT,INSERT,UPDATE,DELETE ON gp.trade_annotations TO gp_core_app',
 'GRANT SELECT ON gp.trade_annotations TO gp_core_reader',
 'CREATE TABLE gp.trade_annotations_migration_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)',
 'REVOKE ALL ON gp.trade_annotations_migration_history FROM PUBLIC,gp_core_app,gp_core_reader',
 'GRANT SELECT ON gp.trade_annotations_migration_history TO gp_core_app,gp_core_reader',
];
const digest=crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex');
const CATALOG=Object.freeze(require('../../sqlite/trade-annotations-catalog').TRADE_ANNOTATIONS_CATALOG.map(e=>{
 const compiled=compileCoreEntry(e).providerEntry;return {...compiled,sql:compiled.sql.replace(/\btrade_annotations\b/g,'gp.trade_annotations')};
}));
async function target(client,baseTarget){
 const exists=(await client.query("SELECT to_regclass('gp.trade_annotations_migration_history') AS name")).rows[0].name;
 if(!exists)return baseTarget;
 const rows=(await client.query('SELECT * FROM gp.trade_annotations_migration_history')).rows;
 if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==digest||rows[0].base_target_sha256!==baseTarget)throw new Error('Trade annotation migration contract mismatch');
 return rows[0].target_sha256;
}
async function migrate(client,{binding}={}){
 await require('./environment').verifyEnvironment(client,{purpose:'migrator',binding});await client.query('SELECT pg_advisory_lock(9261246)');
 try{
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query('SET LOCAL ROLE gp_core_owner');await client.query('SET LOCAL search_path=pg_catalog,gp');
  await require('../boundary/migrate').verifyCoreSchema(client);
  if((await client.query("SELECT to_regclass('gp.trade_annotations_migration_history') AS name")).rows[0].name){await client.query('COMMIT');return {applied:false,digest};}
  const base=await schemaFingerprint(client);for(const sql of statements)await client.query(sql);
  const result=await schemaFingerprint(client);await client.query('INSERT INTO gp.trade_annotations_migration_history VALUES(1,$1,$2,$3)',[digest,base,result]);
  await client.query('COMMIT');return {applied:true,digest,target:result};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{await client.query('SELECT pg_advisory_unlock(9261246)');}
}
module.exports={CATALOG,target,migrate,digest};
