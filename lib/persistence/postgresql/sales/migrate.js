'use strict';
const {verifyEnvironment,ENVIRONMENT_ID,PROFILE}=require('../core/environment');
const {schemaFingerprint}=require('../core/fingerprint');
const {SCHEMAS,SEARCH_PATH,tables:reviewedTables}=require('./layout');
const {createSalesSchemaPlan}=require('./schema');
const literal=value=>"'"+value.replace(/'/g,"''")+"'";
async function migrateSalesDevelopment(client,stage=5){
  await verifyEnvironment(client,{domain:'sales',purpose:'migrator'});
  const plan=createSalesSchemaPlan(stage);
  await client.query('SELECT pg_advisory_lock(9261205)');
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SET LOCAL ROLE gp_sales_owner');
    await client.query('SET LOCAL search_path='+SEARCH_PATH);
    const exists=(await client.query("SELECT to_regclass('gp.sales_migration_history') AS name")).rows[0].name;
    let previous=[];
    if(exists){
      previous=(await client.query('SELECT * FROM gp.sales_migration_history ORDER BY stage')).rows;
      if(!previous.length||previous.some(r=>r.source_sha256!==plan.sourceSchemaSha256||r.plan_sha256!==createSalesSchemaPlan(r.stage).digest))throw new Error('Sales migration history drift');
      if(previous.at(-1).target_sha256!==await schemaFingerprint(client,SCHEMAS))throw new Error('Sales target schema drift');
      if(previous.some(r=>r.stage===stage)){await client.query('COMMIT');return {applied:false,stage,digest:plan.digest,productActivation:false};}
    }
    if(stage!==5&&previous.at(-1)?.stage!==stage-1)throw new Error('Sales migrations must run sequentially');
    if(!exists){
      await client.query('CREATE TABLE gp.sales_migration_history(stage integer PRIMARY KEY CHECK(stage BETWEEN 5 AND 8),source_sha256 text NOT NULL,plan_sha256 text NOT NULL,target_sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      await client.query('REVOKE ALL ON gp.sales_migration_history FROM gp_sales_app,gp_sales_reader');
      await client.query('GRANT SELECT(stage,source_sha256,plan_sha256,target_sha256) ON gp.sales_migration_history TO gp_sales_app,gp_sales_reader');
      await client.query('CREATE TABLE gp.migration_fixture_owner(id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now())');
      await client.query('REVOKE ALL ON gp.migration_fixture_owner FROM gp_sales_app,gp_sales_reader');
    }
    const actions=plan.statements.map(s=>`item_id=${literal(s.id)};EXECUTE ${literal(s.sql)};`).join('\n');
    await client.query(`DO $migration$ DECLARE item_id text;BEGIN ${actions} EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION '%: % [%]',item_id,SQLERRM,SQLSTATE;END $migration$`);
    const target=await schemaFingerprint(client,SCHEMAS);
    await client.query('INSERT INTO gp.sales_migration_history(stage,source_sha256,plan_sha256,target_sha256) VALUES($1,$2,$3,$4)',[stage,plan.sourceSchemaSha256,plan.digest,target]);
    await client.query('COMMIT');
    return {applied:true,stage,digest:plan.digest,...plan.sourceCounts,productActivation:false};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{await client.query('SELECT pg_advisory_unlock(9261205)');}
}
async function resetEmptySalesDevelopment(client){
  await verifyEnvironment(client,{domain:'sales',purpose:'migrator'});
  await client.query('SELECT pg_advisory_lock(9261205)');
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query('SET LOCAL ROLE gp_sales_owner');
    const tables=(await client.query('SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1::text[])',[SCHEMAS])).rows;
    const technical=new Set(['environment_contract','sales_migration_history','migration_fixture_owner','core_audit_outbox','core_audit_delivery','core_location_references']);
    if(tables.some(t=>!/^\w+$/.test(t.tablename)||(!reviewedTables.has(t.tablename)&&!technical.has(t.tablename))))throw new Error('Unknown development object; no reset');
    const business=tables.filter(t=>!['environment_contract','sales_migration_history'].includes(t.tablename));
    if(business.length&&(await client.query(business.map(t=>`SELECT EXISTS(SELECT 1 FROM "${t.schemaname}"."${t.tablename}") AS occupied`).join(' UNION ALL '))).rows.some(r=>r.occupied))throw new Error('Development reset requires empty business tables and no owned fixture');
    for(const schema of [...SCHEMAS].reverse())await client.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
    await client.query('CREATE SCHEMA gp AUTHORIZATION gp_sales_owner');
    await client.query('CREATE TABLE gp.environment_contract(environment_id text PRIMARY KEY,domain text NOT NULL,profile text NOT NULL)');
    await client.query('INSERT INTO gp.environment_contract VALUES($1,$2,$3)',[ENVIRONMENT_ID,'sales',PROFILE]);
    await client.query('GRANT USAGE ON SCHEMA gp TO gp_sales_app,gp_sales_reader');await client.query('GRANT SELECT ON gp.environment_contract TO gp_sales_app,gp_sales_reader');
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{await client.query('SELECT pg_advisory_unlock(9261205)');}
}
module.exports={migrateSalesDevelopment,resetEmptySalesDevelopment};
