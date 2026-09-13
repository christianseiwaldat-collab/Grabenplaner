'use strict';
const fs=require('node:fs');
const {Client}=require('pg');
const {sourceEntries,compileCoreEntry}=require('../../lib/persistence/postgresql/core/catalog');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');
async function main(){
  const client=new Client({connectionString:process.env.GP_CORE_APP_URL});await client.connect();
  const failures=[],passed=[],candidates=[];
  try{
    await verifyEnvironment(client);await client.query('SET search_path=pg_catalog,gp');
    for(const entry of sourceEntries()){
      let compiled;
      try{
        compiled=compileCoreEntry(entry);
        candidates.push({id:entry.statement.id,sql:compiled.providerEntry.sql,provenance:compiled.provenance,source:entry.sql});
      }catch(error){failures.push({id:entry.statement.id,message:error.message,code:error.code,position:error.position,sql:compiled?.providerEntry.sql,source:entry.sql});}
    }
    const payload=JSON.stringify(candidates.map(({id,sql})=>({id,sql}))).replace(/'/g,"''");
    await client.query(`DO $validation$ DECLARE item jsonb;types text[];results jsonb='[]'; BEGIN
      FOR item IN SELECT value FROM jsonb_array_elements('${payload}'::jsonb) LOOP
        BEGIN
          EXECUTE 'PREPARE migration_check AS '||(item->>'sql');
          SELECT parameter_types::text[] INTO types FROM pg_prepared_statements WHERE name='migration_check';
          DEALLOCATE migration_check;
          results=results||jsonb_build_array(jsonb_build_object('id',item->>'id','parameterTypes',types));
        EXCEPTION WHEN OTHERS THEN results=results||jsonb_build_array(jsonb_build_object('id',item->>'id','error',SQLERRM,'code',SQLSTATE)); END;
      END LOOP;PERFORM set_config('gp.migration_validation',results::text,false);END $validation$`);
    const checks=(await client.query("SELECT current_setting('gp.migration_validation')::jsonb results")).rows[0].results;
    for(const check of checks){
      const candidate=candidates.find(e=>e.id===check.id);
      if(check.error)failures.push({id:check.id,message:check.error,code:check.code,sql:candidate.sql,source:candidate.source});
      else passed.push({...candidate.provenance,parameterTypes:check.parameterTypes});
    }
  }finally{await client.end();}
  const report={scope:'core-development',productActivation:false,total:sourceEntries().length,prepared:passed.length,failures,passed};
  fs.writeFileSync('tmp/postgresql-catalog-validation.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({total:report.total,prepared:report.prepared,failures:failures.length,examples:failures.slice(0,14).map(({id,message})=>({id,message}))},null,2));
  if(failures.length)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
