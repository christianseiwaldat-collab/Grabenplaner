'use strict';
const {Client}=require('pg');
const {migrateCoreDevelopment}=require('../../lib/persistence/postgresql/core/migrate');
async function main(){
  const client=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await client.connect();
  try{
    console.log(JSON.stringify(await migrateCoreDevelopment(client,{rebuildEmptyDevelopment:process.argv.includes('--rebuild-empty-development')})));
  }catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
