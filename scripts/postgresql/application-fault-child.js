'use strict';
const fs=require('node:fs');
const root='/home/gpadmin/grabenplaner-pg-migration-20260912/application-11';
const scenario=process.argv[2];
if(!['interrupt-report','resume-report'].includes(scenario))throw new Error('PG_APPLICATION_FAULT_SCENARIO');
const config=JSON.parse(fs.readFileSync(root+'/operations-config.json','utf8'));
require('../../server-tools/linux/recovery/lib/postgresql-application-smoke').qualifyHttp({root,config,scenario}).then(proof=>{
 fs.writeFileSync(root+'/fault-verification.json',JSON.stringify({...proof,checkedAt:new Date().toISOString(),productActivation:false},null,2)+'\n',{flag:'wx',mode:0o600});
}).catch(error=>{fs.writeFileSync(root+'/fault-failure-private.json',JSON.stringify({code:error.code,message:error.message,stack:error.stack}),{mode:0o600});process.exitCode=1;});
