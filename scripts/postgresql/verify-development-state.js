'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{Client}=require('pg');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');
const {verifyCoreSchema}=require('../../lib/persistence/postgresql/boundary/migrate');
const {schemaFingerprint}=require('../../lib/persistence/postgresql/core/fingerprint');
const {SCHEMAS,SEARCH_PATH}=require('../../lib/persistence/postgresql/sales/layout');
const {createSalesSchemaPlan}=require('../../lib/persistence/postgresql/sales/schema');
async function inspect(domain){
  const client=new Client({connectionString:process.env[`GP_${domain.toUpperCase()}_MIGRATOR_URL`]});await client.connect();
  try{
    await verifyEnvironment(client,{domain,purpose:'migrator'});
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL ROLE gp_'+domain+'_owner');
    await client.query('SET LOCAL search_path='+(domain==='core'?'pg_catalog,gp':SEARCH_PATH));
    let schema;
    if(domain==='core')schema=await verifyCoreSchema(client);
    else{
      const history=(await client.query('SELECT stage,source_sha256,plan_sha256,target_sha256 FROM gp.sales_migration_history ORDER BY stage')).rows;
      assert.deepEqual(history.map(row=>row.stage),[5,6,7,8]);
      for(const row of history){const plan=createSalesSchemaPlan(row.stage);assert.equal(row.plan_sha256,plan.digest);assert.equal(row.source_sha256,plan.sourceSchemaSha256);}
      assert.equal(history.at(-1).target_sha256,await schemaFingerprint(client,SCHEMAS));schema={stages:history.map(row=>row.stage),plans:history.map(row=>({stage:row.stage,sha256:row.plan_sha256}))};
    }
    const schemas=domain==='core'?['gp']:SCHEMAS;
    const tables=(await client.query('SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename',[schemas])).rows
      .filter(row=>!['environment_contract','core_migration_history','boundary_migration_history','sales_migration_history'].includes(row.tablename));
    assert.ok(tables.length>0&&tables.every(row=>/^\w+$/.test(row.schemaname)&&/^\w+$/.test(row.tablename)));
    const occupied=(await client.query(tables.map(row=>`SELECT '${row.schemaname}.${row.tablename}' AS name WHERE EXISTS(SELECT 1 FROM "${row.schemaname}"."${row.tablename}")`).join(' UNION ALL '))).rows;
    assert.equal(occupied.length,0,'Synthetic business, reference and fixture-owner tables must be empty');
    await client.query('COMMIT');return {environmentVerified:true,schemaContractVerified:true,emptyBusinessAndReferenceTables:tables.length,occupiedTables:0,schema};
  }finally{await client.end();}
}
async function main(){const result={checkedAt:new Date().toISOString(),productActivation:false,core:await inspect('core'),sales:await inspect('sales')};fs.writeFileSync('tmp/postgresql-block8-development-state.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
