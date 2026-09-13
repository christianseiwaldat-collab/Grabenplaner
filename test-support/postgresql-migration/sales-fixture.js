'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Client}=require('pg');
const {verifyEnvironment,PROFILE}=require('../../lib/persistence/postgresql/core/environment');
const {stageTables,relation,SEARCH_PATH}=require('../../lib/persistence/postgresql/sales/layout');
const {openSalesDevelopmentApplication}=require('../../lib/persistence/postgresql/sales/application');
const {createSqliteSource,seedCoreFixture}=require('./sqlite-source');
const {createSqlitePersistenceProvider}=require('../../lib/persistence/sqlite/provider');
const {SQLITE_APPLICATION_CATALOG}=require('../../lib/persistence/sqlite/application-catalog');
const {createDataImportProtection}=require('../../lib/data-import-protection');
async function withSalesFixture(stage,work){
  const client=new Client({connectionString:process.env.GP_SALES_MIGRATOR_URL});await client.connect();
  let owned=false,sqlite,sqliteProvider,application,protection;
  const marker='synthetic-sales-'+crypto.randomUUID();let relations;
  try{
    await verifyEnvironment(client,{domain:'sales',purpose:'migrator'});
    await client.query('SELECT pg_advisory_lock(9261250)');
    const current=(await client.query('SELECT max(stage)::int stage FROM gp.sales_migration_history')).rows[0].stage;
    assert.ok([5,6,7,8].includes(current)&&current>=stage,'Requested fixture needs an installed, known migration stage');stage=current;
    relations=[...stageTables(stage).map(t=>relation(t.name)),...(stage>=6?['integration.core_audit_outbox']:[]),...(stage>=7?['integration.core_audit_delivery']:[]),...(stage>=8?['integration.core_location_references']:[])];
    await client.query('SET ROLE gp_sales_owner');await client.query('SET search_path='+SEARCH_PATH);
    assert.equal((await client.query('SELECT * FROM gp.migration_fixture_owner')).rows.length,0,'No other fixture may own this database');
    assert.ok((await client.query(relations.map(table=>'SELECT EXISTS(SELECT 1 FROM '+table+') AS occupied').join(' UNION ALL '))).rows.every(r=>!r.occupied),'Synthetic fixture refuses existing business rows');
    await client.query('INSERT INTO gp.migration_fixture_owner(id) VALUES($1)',[marker]);owned=true;
    sqlite=createSqliteSource();seedCoreFixture(sqlite,3);
    sqliteProvider=createSqlitePersistenceProvider({database:sqlite,catalog:SQLITE_APPLICATION_CATALOG,closeDatabase:false});
    application=await openSalesDevelopmentApplication({profile:PROFILE,databaseUrl:process.env.GP_SALES_APP_URL,tlsMode:'disable-local-only',stage});
    protection=createDataImportProtection({encryptionKey:Buffer.alloc(32,42),indexKey:Buffer.alloc(32,43),keyId:'synthetic-migration',compression:true});
    await work({client,sqlite,sqliteProvider,postgres:application.provider,application,protection,stage});
  }finally{
    await application?.close();await sqliteProvider?.close();sqlite?.close();protection?.destroy();
    await client.query('ROLLBACK');await client.query('RESET ROLE');
    if(owned){
      await verifyEnvironment(client,{domain:'sales',purpose:'migrator'});await client.query('SET ROLE gp_sales_owner');
      assert.deepEqual((await client.query('SELECT id FROM gp.migration_fixture_owner')).rows,[{id:marker}]);
      await client.query('BEGIN');
      await client.query('TRUNCATE '+relations.join(',')+' RESTART IDENTITY CASCADE');
      await client.query('DELETE FROM gp.migration_fixture_owner WHERE id=$1',[marker]);await client.query('COMMIT');
    }
    await client.query('SELECT pg_advisory_unlock(9261250)');await client.end();
  }
}
module.exports={withSalesFixture};
