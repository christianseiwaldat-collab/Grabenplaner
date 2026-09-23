'use strict';
// Fresh GitHub Actions service container only; never connects to a product DB.
const crypto=require('node:crypto'),{spawnSync}=require('node:child_process'),{Client}=require('pg');
async function main(){
 const connection=new URL(process.env.TEST_POSTGRESQL_URL||'');
 if(process.env.CI!=='true'||connection.hostname!=='127.0.0.1'||connection.port!=='5432'||connection.pathname!=='/grabenplaner_test'||connection.username!=='postgres')throw new Error('CI synthetic database required');
 const client=new Client({connectionString:connection.href});await client.connect();
 const env={...process.env,GP_PG_MIGRATION_LIVE:'1',GP_MIGRATION_ADMIN_URL:connection.href};
 try {
  for(const domain of ['core','sales']){
   const owner='gp_'+domain+'_owner',database='gp_migration_'+domain;
   await client.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
   for(const purpose of ['migrator','app','reader']){
    const role='gp_'+domain+'_'+purpose,password=crypto.randomBytes(32).toString('hex');
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5`);
    await client.query(`ALTER ROLE ${role} SET search_path TO pg_catalog`);
    const url=new URL(connection);url.pathname='/'+database;url.username=role;url.password=password;env[role.toUpperCase()+'_URL']=url.href;
   }
   await client.query(`GRANT ${owner} TO gp_${domain}_migrator`);
   await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
   await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
   await client.query(`GRANT CONNECT ON DATABASE ${database} TO gp_${domain}_migrator,gp_${domain}_app,gp_${domain}_reader`);
   const url=new URL(connection);url.pathname='/'+database;
   const setup=new Client({connectionString:url.href});await setup.connect();
   try{
    await setup.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await setup.query(`CREATE SCHEMA gp AUTHORIZATION ${owner}`);
    await setup.query(`GRANT USAGE ON SCHEMA gp TO gp_${domain}_app,gp_${domain}_reader`);
    await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO gp_${domain}_app`);
    await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT SELECT ON TABLES TO gp_${domain}_reader`);
    await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT USAGE,SELECT ON SEQUENCES TO gp_${domain}_app`);
    await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
   }finally{await setup.end();}
  }
 }finally{await client.end();}
 const commands=[['scripts/postgresql/mark-development-environment.js'],['scripts/postgresql/apply-core-schema.js'],['scripts/postgresql/apply-sales-schema.js','5'],['scripts/postgresql/apply-sales-schema.js','6'],['scripts/postgresql/apply-boundary-schema.js'],['scripts/postgresql/apply-sales-schema.js','8'],
 ['-e',"const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await c.connect();try{await require('./lib/persistence/postgresql/core/trade-annotations').migrate(c);}finally{await c.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;})"],
 ['--test','--test-concurrency=1','test/postgresql-stock-import-delete.test.js']];
 for(const args of commands){const result=spawnSync(process.execPath,args,{env,stdio:'inherit'});if(result.status!==0)throw new Error('Synthetic migration qualification failed: '+args[0]);}
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
