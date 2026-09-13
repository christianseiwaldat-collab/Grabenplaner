'use strict';
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {createSqliteSource,seedCoreFixture}=require('./sqlite-source');
const {createSqlitePersistenceProvider}=require('../../lib/persistence/sqlite/provider');
const {sourceEntries}=require('../../lib/persistence/postgresql/core/catalog');
const {coreRepositories,openCoreDevelopmentApplication}=require('../../lib/persistence/postgresql/core/application');
const {verifyEnvironment,PROFILE}=require('../../lib/persistence/postgresql/core/environment');
const inventory=require('../../docs/postgresql-migration/block-1-inventory.json');
const baseTableNames=[...inventory.tables.filter(t=>t.database==='core').map(t=>t.name),'article_reference_snapshots'];
const quote=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const fixtureId='synthetic-core-parity-v1';
const schema=require('./source-schema-v09237.json');
const initialTables=['cost_center_types','cost_centers','locations','positions','cost_center_type_positions','departments','employees','portal_users','portal_roles','portal_access_scopes','shifts'];
const historicalTimes=initialTables.map(name=>{
  const columns=schema.tables.find(t=>t.name===name).columns.filter(c=>['created_at','updated_at'].includes(c.name));
  return columns.length?'UPDATE '+name+' SET '+columns.map(c=>c.name+"='2020-02-29 10:00:00'").join(',')+';':'';
}).join('\n');
const baseSql=`
 INSERT INTO settings(key,value) VALUES('migration-test-owner','${fixtureId}');
 INSERT INTO portal_roles(id,name,permissions) VALUES('developer','Developer','["*"]'),('employee','MA','["own_time:read"]'),('manager','AL','["own_time:read","schedule:write"]');
 INSERT INTO portal_users(employee_number,password_hash,role,active) VALUES('00001','synthetic-hash','developer',1),('00002','synthetic-hash','employee',1),('00003','synthetic-hash','manager',1);
 INSERT INTO portal_access_scopes(employee_number,location_id,department_id) VALUES('00002','18',0),('00003','18',1);
 INSERT INTO shifts(employee_number,location_id,department_id,shift_date,start_time,end_time,area,note) VALUES('00002','18',1,'2026-09-07','08:00','16:30','Verkauf','synthetisch');
 ${historicalTimes}
`;
async function withCoreFixture(work){
  const migrator=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await migrator.connect();
  let sqlite,sqliteProvider,application,owned=false;const tableNames=[...baseTableNames];
  try {
    await verifyEnvironment(migrator,{purpose:'migrator'});
    if((await migrator.query("SELECT to_regclass('gp.boundary_migration_history') AS name")).rows[0].name)tableNames.push('import_master_bindings','import_master_events','import_master_holds','trade_source_references','trade_source_reference_versions','sales_audit_inbox');
    const occupied=(await migrator.query(tableNames.map(t=>`SELECT EXISTS(SELECT 1 FROM gp."${t}") occupied`).join(' UNION ALL '))).rows;
    assert.ok(occupied.every(r=>!r.occupied),'Parity fixture requires empty development application tables');
    const operations=[];seedCoreFixture({exec(sql){if(!['BEGIN','COMMIT'].includes(sql))operations.push(sql);},prepare(sql){return{run(...params){let i=0;operations.push(sql.replace(/\?/g,()=>quote(params[i++])));}};}},3);
    await migrator.query('BEGIN');await migrator.query('SET LOCAL ROLE gp_core_owner');await migrator.query('SET LOCAL search_path=pg_catalog,gp');
    await migrator.query(operations.join(';')+';'+baseSql);
    await migrator.query("SELECT setval(pg_get_serial_sequence('gp.departments','id'),1,true)");
    await migrator.query('COMMIT');owned=true;
    sqlite=createSqliteSource();seedCoreFixture(sqlite,3);sqlite.exec(baseSql);
    sqliteProvider=createSqlitePersistenceProvider({database:sqlite,catalog:sourceEntries(),closeDatabase:false});
    application=await openCoreDevelopmentApplication({profile:PROFILE,databaseUrl:process.env.GP_CORE_APP_URL,tlsMode:'disable-local-only'});
    await work({sqlite,sqliteProvider,postgres:application.provider,sqliteRepositories:coreRepositories(sqliteProvider),postgresRepositories:application.repositories,application,migrator});
  }finally{
    await application?.close();await sqliteProvider?.close();sqlite?.close();
    await migrator.query('ROLLBACK');
    if(owned){
      await verifyEnvironment(migrator,{purpose:'migrator'});
      const marker=(await migrator.query("SELECT value FROM gp.settings WHERE key='migration-test-owner'")).rows;
      assert.deepEqual(marker,[{value:fixtureId}],'Test data ownership must be preserved before cleanup');
      await migrator.query('BEGIN');await migrator.query('SET LOCAL ROLE gp_core_owner');
      await migrator.query('TRUNCATE '+tableNames.map(t=>'gp."'+t+'"').join(',')+' RESTART IDENTITY CASCADE');
      await migrator.query('COMMIT');
    }
    await migrator.end();
  }
}
module.exports={withCoreFixture};
