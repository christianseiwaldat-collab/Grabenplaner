'use strict';
const {Client}=require('pg');
const {PROFILE,ENVIRONMENT_ID}=require('../../lib/persistence/postgresql/core/environment');
async function main(){
  for(const domain of ['core','sales']) {
    const url=new URL(process.env.GP_MIGRATION_ADMIN_URL);url.pathname='/gp_migration_'+domain;
    const client=new Client({connectionString:url.href});await client.connect();
    try {
      if((await client.query('SELECT current_database() name')).rows[0].name!=='gp_migration_'+domain) throw new Error('Wrong development database');
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE gp_${domain}_owner`);
      await client.query('CREATE TABLE gp.environment_contract(environment_id text PRIMARY KEY,domain text NOT NULL,profile text NOT NULL)');
      await client.query('INSERT INTO gp.environment_contract VALUES ($1,$2,$3)',[ENVIRONMENT_ID,domain,PROFILE]);
      await client.query(`REVOKE ALL ON gp.environment_contract FROM gp_${domain}_app,gp_${domain}_reader`);
      await client.query(`GRANT SELECT ON gp.environment_contract TO gp_${domain}_app,gp_${domain}_reader`);
      await client.query('COMMIT');
    } catch(error){await client.query('ROLLBACK');throw error;} finally {await client.end();}
  }
  console.log('Two isolated development markers installed; product activation false');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
