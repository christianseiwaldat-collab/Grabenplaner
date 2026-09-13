'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');const {Client}=require('pg');
const C=require('../../lib/persistence/postgresql/boundary/catalog');
const {verifyEnvironment}=require('../../lib/persistence/postgresql/core/environment');
async function main(){const entries=[];
  for(const domain of ['core','sales']){
    const client=new Client({connectionString:process.env['GP_'+domain.toUpperCase()+'_APP_URL']});await client.connect();
    try{await verifyEnvironment(client,{domain});await client.query('SET search_path=pg_catalog,gp,kassa,integration,trade,reporting');
      for(const e of C[domain.toUpperCase()+'_BOUNDARY_CATALOG']){
        await client.query('PREPARE boundary_check AS '+e.sql);await client.query('DEALLOCATE boundary_check');
        entries.push({domain,id:e.statement.id,sha256:crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex')});
      }
    }finally{await client.end();}
  }
  const report={productActivation:false,prepared:entries.length,entries};fs.writeFileSync('docs/postgresql-migration/block-7-boundary-catalog.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({prepared:entries.length}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
