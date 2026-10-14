'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('Native snapshot extension rolls back partial creation, is idempotent and fingerprints grants',{skip:process.env.GP_PG_MIGRATION_LIVE!=='1'},async()=>{
 const {Client}=require('pg'),client=new Client({connectionString:process.env.GP_SALES_MIGRATOR_URL});await client.connect();
 const migration=require('../lib/persistence/postgresql/sales/import-delete'),snapshots=require('../lib/persistence/postgresql/sales/import-history-snapshots');
 try{
  const existed=(await client.query("SELECT to_regclass('gp.import_history_snapshots_migration_history') AS name")).rows[0].name;
  if(!existed){
   const fault=new Error('Synthetic snapshot interruption');
   await assert.rejects(migration.migrate({query:(sql,...args)=>sql.startsWith('CREATE TABLE integration.import_history_snapshot_members')?Promise.reject(fault):client.query(sql,...args)}),e=>e===fault);
   assert.equal((await client.query("SELECT to_regclass('integration.import_history_snapshots') AS name")).rows[0].name,null);
   assert.equal((await client.query("SELECT to_regclass('gp.import_history_snapshots_migration_history') AS name")).rows[0].name,null);
  }
  await migration.migrate(client);assert.equal((await migration.migrate(client)).applied,false);
  await client.query('SET search_path=pg_catalog,gp,kassa,integration,trade,reporting');
  const base=(await client.query('SELECT target_sha256 FROM gp.sales_migration_history ORDER BY stage DESC LIMIT 1')).rows[0].target_sha256;
  assert.equal(await migration.target(client,base),await require('../lib/persistence/postgresql/core/fingerprint').schemaFingerprint(client,require('../lib/persistence/postgresql/sales/layout').SCHEMAS));
  const ledger=(await client.query('SELECT * FROM gp.import_history_snapshots_migration_history')).rows;assert.equal(ledger.length,1);assert.equal(ledger[0].plan_sha256,snapshots.digest);
  const indexes=(await client.query("SELECT c.relname,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('import_history_snapshots_source','import_history_snapshot_members_version')")).rows;
  assert.equal(indexes.length,2);assert.ok(indexes.every(r=>r.indisvalid&&r.indisready));
  const grants=(await client.query(`SELECT
   has_table_privilege('gp_sales_reader','integration.import_history_snapshot_members','SELECT') AS reader_read,
   has_table_privilege('gp_sales_reader','integration.import_history_snapshot_members','INSERT') AS reader_write,
   has_table_privilege('gp_sales_app','integration.import_history_snapshot_members','INSERT') AS app_write,
   has_table_privilege('gp_sales_app','gp.import_history_snapshots_migration_history','UPDATE') AS app_ledger_write`)).rows[0];
  assert.deepEqual(grants,{reader_read:true,reader_write:false,app_write:true,app_ledger_write:false});
  const parents=(await client.query("SELECT confrelid::regclass::text AS parent,confdeltype FROM pg_constraint WHERE conrelid='integration.import_history_snapshot_members'::regclass AND contype='f'")).rows;
  assert.equal(parents.length,2);assert.ok(parents.every(r=>r.confdeltype==='r'));
  await client.query('BEGIN');await client.query('SET LOCAL ROLE gp_sales_owner');
  await client.query("UPDATE gp.import_history_snapshots_migration_history SET plan_sha256=repeat('0',64)");
  await assert.rejects(migration.target(client,base),/migration contract mismatch/);await client.query('ROLLBACK');
 }finally{await client.query('ROLLBACK');await client.end();}
});
