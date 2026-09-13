'use strict';
const {createSchemaPlan}=require('./schema');
const {verifyEnvironment,PROFILE,ENVIRONMENT_ID}=require('./environment');
const {schemaFingerprint}=require('./fingerprint');
const literal=s=>"'"+s.replace(/'/g,"''")+"'";
async function migrateCoreDevelopment(client,{rebuildEmptyDevelopment=false}={}) {
  await verifyEnvironment(client,{purpose:'migrator'});
  const plan=createSchemaPlan();
  await client.query('SELECT pg_advisory_lock(9261203)');
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SET LOCAL ROLE gp_core_owner');await client.query('SET LOCAL search_path=pg_catalog,gp');
    if(rebuildEmptyDevelopment){
      const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='gp' AND tablename NOT IN ('environment_contract','core_migration_history')")).rows;
      if(tables.some(t=>!/^\w+$/.test(t.tablename)))throw new Error('Unexpected development table identifier');
      if(tables.length){
        const count=await client.query(tables.map(t=>`SELECT EXISTS(SELECT 1 FROM gp."${t.tablename}") occupied`).join(' UNION ALL '));
        if(count.rows.some(r=>r.occupied))throw new Error('Development rebuild requires empty application tables');
      }
      await client.query('DROP SCHEMA gp CASCADE');
      await client.query('CREATE SCHEMA gp AUTHORIZATION gp_core_owner');
      await client.query('CREATE TABLE gp.environment_contract(environment_id text PRIMARY KEY,domain text NOT NULL,profile text NOT NULL)');
      await client.query('INSERT INTO gp.environment_contract VALUES ($1,$2,$3)',[ENVIRONMENT_ID,'core',PROFILE]);
      await client.query('GRANT USAGE ON SCHEMA gp TO gp_core_app,gp_core_reader');
      await client.query('GRANT SELECT ON gp.environment_contract TO gp_core_app,gp_core_reader');
    }
    const ledgerExists=(await client.query("SELECT to_regclass('gp.core_migration_history') name")).rows[0].name;
    if(ledgerExists){
      const rows=(await client.query('SELECT * FROM gp.core_migration_history')).rows;
      if(rows.length!==1||rows[0].source_sha256!==plan.sourceSchemaSha256||rows[0].plan_sha256!==plan.digest)throw new Error('Core migration history drift; explicit new migration required');
      await require('../boundary/migrate').verifyCoreSchema(client);
      await client.query('COMMIT');return {applied:false,digest:plan.digest,productActivation:false};
    }
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE gp_core_owner IN SCHEMA gp GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO gp_core_app');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE gp_core_owner IN SCHEMA gp GRANT SELECT ON TABLES TO gp_core_reader');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE gp_core_owner IN SCHEMA gp GRANT USAGE,SELECT ON SEQUENCES TO gp_core_app');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE gp_core_owner IN SCHEMA gp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
    const actions=plan.statements.map(item=>`item_id=${literal(item.id)};EXECUTE ${literal(item.sql)};`).join('\n');
    await client.query(`DO $migration$ DECLARE item_id text; BEGIN ${actions} EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION '%: % [%]',item_id,SQLERRM,SQLSTATE;END $migration$`);
    await client.query('CREATE TABLE gp.core_migration_history(version integer PRIMARY KEY CHECK(version=1),source_sha256 text NOT NULL,plan_sha256 text NOT NULL,target_sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('REVOKE ALL ON gp.core_migration_history FROM gp_core_app,gp_core_reader');
    await client.query('GRANT SELECT(version,source_sha256,plan_sha256,target_sha256) ON gp.core_migration_history TO gp_core_app,gp_core_reader');
    const targetDigest=await schemaFingerprint(client);
    await client.query('INSERT INTO gp.core_migration_history(version,source_sha256,plan_sha256,target_sha256) VALUES(1,$1,$2,$3)',[plan.sourceSchemaSha256,plan.digest,targetDigest]);
    await client.query('COMMIT');
    return {applied:true,digest:plan.digest,...plan.sourceCounts,statements:plan.statements.length,productActivation:false};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{await client.query('SELECT pg_advisory_unlock(9261203)');}
}
module.exports={migrateCoreDevelopment};
