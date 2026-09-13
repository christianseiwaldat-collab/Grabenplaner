'use strict';
// Credentials remain in an ignored, access-restricted local directory.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const file=path.resolve(__dirname,'../../tmp/postgresql-development/credentials.json');
const credentials=JSON.parse(fs.readFileSync(file,'utf8'));
const environment={...process.env,GP_PG_MIGRATION_LIVE:'1'};
for(const [name,password] of Object.entries(credentials.accounts)) {
  const domain=name.includes('_sales_')?'sales':'core';
  const database=name==='gp_migration_admin'?'postgres':'gp_migration_'+domain;
  environment[name.toUpperCase()+'_URL']=`postgresql://${encodeURIComponent(name)}:${encodeURIComponent(password)}@127.0.0.1:55483/${database}`;
}
const result=spawnSync(process.execPath,process.argv.slice(2),{env:environment,stdio:'inherit'});
if(result.error) throw new Error('Development subprocess could not start');
process.exitCode=result.status??1;
