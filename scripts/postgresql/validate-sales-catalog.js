'use strict';
const fs=require('node:fs');
const {Client}=require('pg');
const {salesSourceEntries,compileSalesEntry}=require('../../lib/persistence/postgresql/sales/catalog');
const {createSalesSchemaPlan}=require('../../lib/persistence/postgresql/sales/schema');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');
const {SEARCH_PATH}=require('../../lib/persistence/postgresql/sales/layout');
async function main(){
  const stage=Number(process.argv[2]||5),client=new Client({connectionString:process.env.GP_SALES_APP_URL});await client.connect();
  const failures=[],passed=[];
  try{
    await verifyEnvironment(client,{domain:'sales'});await client.query('SET search_path='+SEARCH_PATH);
    for(const source of salesSourceEntries(stage)){
      let compiled;
      try{
        compiled=compileSalesEntry(source,stage);
        await client.query('PREPARE migration_check AS '+compiled.providerEntry.sql);
        const types=(await client.query("SELECT parameter_types::text[] AS types FROM pg_prepared_statements WHERE name='migration_check'")).rows[0].types;
        await client.query('DEALLOCATE migration_check');passed.push({...compiled.provenance,parameterTypes:types});
      }catch(error){failures.push({id:source.statement.id,message:error.message,code:error.code,sql:compiled?.providerEntry.sql});await client.query('DEALLOCATE ALL');}
    }
  }finally{await client.end();}
  const report={scope:'sales-development',stage,productActivation:false,total:salesSourceEntries(stage).length,prepared:passed.length,failures,entries:passed,schemaPlanSha256:createSalesSchemaPlan(stage).digest};
  fs.writeFileSync('tmp/postgresql-sales-'+stage+'-validation.json',JSON.stringify(report,null,2)+'\n');
  if(!failures.length&&process.argv.includes('--record'))fs.writeFileSync('docs/postgresql-migration/block-'+stage+'-catalog.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({total:report.total,prepared:report.prepared,failures:failures.map(({id,message})=>({id,message}))},null,2));
  if(failures.length)process.exitCode=1;
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
