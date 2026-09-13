'use strict';
const {Client}=require('pg');
const {migrateSalesDevelopment,resetEmptySalesDevelopment}=require('../../lib/persistence/postgresql/sales/migrate');
async function main(){
  const client=new Client({connectionString:process.env.GP_SALES_MIGRATOR_URL});await client.connect();
  try{
    const stage=Number(process.argv[2]||5);
    if(process.argv.includes('--rebuild-empty-development')){
      require('../../lib/persistence/postgresql/sales/schema').createSalesSchemaPlan(stage);
      await resetEmptySalesDevelopment(client);
      for(let current=5;current<=stage;current++)console.log(JSON.stringify(await migrateSalesDevelopment(client,current)));
    }else console.log(JSON.stringify(await migrateSalesDevelopment(client,stage)));
  }
  finally{await client.end();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
