'use strict';
const {Client}=require('pg');
async function main(){const client=new Client({connectionString:process.env.GP_MIGRATION_ADMIN_URL});await client.connect();
  try{
    const r=(await client.query("SELECT current_user AS owner,current_database() AS database,current_setting('data_directory') AS directory,inet_server_port() AS port")).rows[0];
    if(r.owner!=='gp_migration_admin'||r.database!=='postgres'||r.directory!=='/home/gpadmin/grabenplaner-pg-migration-20260912/data'||r.port!==55482)throw Error('Dedicated development cluster required');
    await client.query('ALTER ROLE gp_core_app CONNECTION LIMIT 8');
    await client.query('ALTER ROLE gp_sales_app CONNECTION LIMIT 7');
    console.log(JSON.stringify({domain:'isolated-development',coreApplicationConnections:8,salesApplicationConnections:7,coreReason:'3 Core + 3 cross-domain reads + 1 coordinator + 1 reserve',salesPoolConnections:2,salesReason:'Bounded application pool leaves room for three receipt readers and one report reader',clusterLimit:20,productActivation:false}));
  }finally{await client.end();}
}main().catch(e=>{console.error(e.message);process.exitCode=1;});
