'use strict';
const crypto=require('node:crypto');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS}=require('./layout');
const statements=[
 `CREATE TABLE integration.import_history_snapshots (
  run_id TEXT COLLATE "C" PRIMARY KEY, scope_id TEXT COLLATE "C" NOT NULL,
  source_instance TEXT COLLATE "C" NOT NULL,
  profile_hash TEXT COLLATE "C" NOT NULL CHECK(length(profile_hash)=64),
  file_sha256 TEXT COLLATE "C" NOT NULL CHECK(length(file_sha256)=64),
  snapshot_at TEXT COLLATE "C" NOT NULL, owner_id TEXT COLLATE "C" NOT NULL,
  expected_rows BIGINT NOT NULL CHECK(expected_rows>=0),
  status TEXT COLLATE "C" NOT NULL CHECK(status IN ('building','published','withdrawn')),
  payload TEXT COLLATE "C" NOT NULL
 )`,
 'CREATE INDEX import_history_snapshots_source ON integration.import_history_snapshots(scope_id,source_instance,file_sha256,run_id)',
 `CREATE TABLE integration.import_history_snapshot_members (
  run_id TEXT COLLATE "C" NOT NULL REFERENCES integration.import_history_snapshots(run_id) ON DELETE RESTRICT,
  row_number BIGINT NOT NULL CHECK(row_number>0), record_id TEXT COLLATE "C" NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>0), payload TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY(run_id,row_number), UNIQUE(run_id,record_id),
  FOREIGN KEY(record_id,revision) REFERENCES integration.import_history_versions(record_id,revision) ON DELETE RESTRICT
 )`,
 'CREATE INDEX import_history_snapshot_members_version ON integration.import_history_snapshot_members(record_id,revision,run_id)',
 'REVOKE ALL ON integration.import_history_snapshots,integration.import_history_snapshot_members FROM PUBLIC',
 'GRANT SELECT,INSERT,UPDATE,DELETE ON integration.import_history_snapshots,integration.import_history_snapshot_members TO gp_sales_app',
 'GRANT SELECT ON integration.import_history_snapshots,integration.import_history_snapshot_members TO gp_sales_reader',
 'CREATE TABLE gp.import_history_snapshots_migration_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)',
 'REVOKE ALL ON gp.import_history_snapshots_migration_history FROM PUBLIC,gp_sales_app,gp_sales_reader',
 'GRANT SELECT ON gp.import_history_snapshots_migration_history TO gp_sales_app,gp_sales_reader',
];
const digest=crypto.createHash('sha256').update(JSON.stringify(statements)).digest('hex');
async function target(client,base){
 if(!(await client.query("SELECT to_regclass('gp.import_history_snapshots_migration_history') AS name")).rows[0].name)return base;
 const rows=(await client.query('SELECT * FROM gp.import_history_snapshots_migration_history')).rows;
 if(rows.length!==1||rows[0].version!==1||rows[0].plan_sha256!==digest||rows[0].base_target_sha256!==base)
  throw new Error('Import history snapshots migration contract mismatch');
 return rows[0].target_sha256;
}
// The existing migration orchestrator holds its advisory lock and serializable
// owner transaction; this extension never opens a connection or changes scope.
async function migrateWithinTransaction(client,base){
 const current=await schemaFingerprint(client,SCHEMAS),expected=await target(client,base);
 if(current!==expected)throw new Error('Import history snapshots schema drift');
 if(expected!==base)return {applied:false,target:expected};
 for(const sql of statements)await client.query(sql);
 const result=await schemaFingerprint(client,SCHEMAS);
 await client.query('INSERT INTO gp.import_history_snapshots_migration_history VALUES(1,$1,$2,$3)',[digest,base,result]);
 return {applied:true,target:result};
}
module.exports={statements,digest,target,migrateWithinTransaction};
