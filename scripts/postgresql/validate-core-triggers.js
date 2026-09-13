'use strict';
const {Client}=require('pg');
const {createSchemaPlan}=require('../../lib/persistence/postgresql/core/schema');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');
const literal=s=>"'"+s.replace(/'/g,"''")+"'";
async function main(){
 const client=new Client({connectionString:process.env.GP_CORE_MIGRATOR_URL});await client.connect();
 try {
  await verifyEnvironment(client,{purpose:'migrator'});
  await client.query('BEGIN');await client.query('SET LOCAL ROLE gp_core_owner');await client.query('SET LOCAL search_path=pg_catalog,gp');
  await client.query('CREATE TEMP TABLE validation_results(name text,code text,message text)');
  const statements=createSchemaPlan().statements.filter(s=>s.validation);
  const actions=statements.map((s,i)=>{
    const v=s.validation,name='trigger_probe_'+i;
    const body=`CREATE FUNCTION pg_temp.${name}(NEW gp."${v.table}",OLD gp."${v.table}") RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,gp AS $probe$ BEGIN ${v.condition?'PERFORM ('+v.condition+');':''} ${v.actions} RETURN true; END $probe$`;
    return `EXECUTE ${literal(body)};BEGIN EXECUTE 'SELECT pg_temp.${name}(NULL::gp."${v.table}",NULL::gp."${v.table}")';EXCEPTION WHEN OTHERS THEN IF SQLSTATE NOT IN ('23514','23502','23503','23505') THEN INSERT INTO validation_results VALUES (${literal(s.id)},SQLSTATE,SQLERRM);END IF;END;`;
  }).join('\n');
  await client.query(`DO $validate$ BEGIN ${actions} END $validate$`);
  const failures=(await client.query('SELECT * FROM validation_results')).rows;
  console.log(JSON.stringify({functions:statements.length,failures},null,2));
  await client.query('ROLLBACK');if(failures.length)process.exitCode=1;
 }finally{await client.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
