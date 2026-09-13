'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const base='/home/gpadmin/grabenplaner-pg-migration-20260912';
if(process.platform!=='linux'||fs.realpathSync(process.cwd())!==base+'/qualification'||fs.readFileSync(base+'/ownership-marker','utf8').trim()!=='grabenplaner-postgresql-migration-development-v1'||fs.readFileSync('ownership-marker','utf8').trim()!=='postgresql-block-8-qualification')throw new Error('Dedicated qualification directory required');
const credentials=JSON.parse(fs.readFileSync(base+'/credentials.json','utf8')),env={...process.env,GP_PG_MIGRATION_LIVE:'1',GP_PG_SERVER_QUALIFICATION:'1'};
for(const [name,password] of Object.entries(credentials.accounts)){
  const database=name==='gp_migration_admin'?'postgres':'gp_migration_'+(name.includes('_sales_')?'sales':'core');
  env[name.toUpperCase()+'_URL']=`postgresql://${encodeURIComponent(name)}:${encodeURIComponent(password)}@127.0.0.1:55482/${database}`;
}
const result=spawnSync(process.execPath,process.argv.slice(2),{env,stdio:'inherit'});if(result.error)throw Error('Qualification subprocess failed');process.exitCode=result.status??1;
