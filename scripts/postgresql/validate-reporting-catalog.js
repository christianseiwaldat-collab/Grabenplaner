'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),{Client}=require('pg');
const {REPORTING_BOUNDARY_CATALOG}=require('../../lib/persistence/postgresql/reporting/catalog');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');
async function main(){
  const client=new Client({connectionString:process.env.GP_SALES_APP_URL}),entries=[];await client.connect();
  try{
    await verifyEnvironment(client,{domain:'sales'});
    for(const e of REPORTING_BOUNDARY_CATALOG){await client.query('PREPARE reporting_check AS '+e.sql);await client.query('DEALLOCATE reporting_check');entries.push({id:e.statement.id,sha256:crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex')});}
  }finally{await client.end();}
  const report={productActivation:false,prepared:entries.length,entries};
  fs.writeFileSync('docs/postgresql-migration/block-8-reporting-catalog.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
