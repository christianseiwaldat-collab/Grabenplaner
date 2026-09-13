'use strict';
const {Client}=require('pg');
const {migrateBoundaryCore}=require('../../lib/persistence/postgresql/boundary/migrate');
const {migrateSalesDevelopment}=require('../../lib/persistence/postgresql/sales/migrate');
async function main(){
  for(const [domain,operation] of [['core',migrateBoundaryCore],['sales',c=>migrateSalesDevelopment(c,7)]]){
    const client=new Client({connectionString:process.env['GP_'+domain.toUpperCase()+'_MIGRATOR_URL']});await client.connect();
    try{console.log(JSON.stringify({domain,...await operation(client)}));}finally{await client.end();}
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
