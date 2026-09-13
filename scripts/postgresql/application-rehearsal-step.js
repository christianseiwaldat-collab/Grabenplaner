'use strict';
// Runs exclusively in the private network of the application rehearsal unit.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const BASE='/home/gpadmin/grabenplaner-pg-migration-20260912',ROOT=BASE+'/application-11';
async function main(){
 if(process.platform!=='linux'||process.getuid()===0||fs.realpathSync(ROOT)!==ROOT||fs.readFileSync(ROOT+'/ownership-marker','utf8').trim()!=='grabenplaner-application-rehearsal-11-v1')throw new Error('APPLICATION_REHEARSAL_SCOPE');
 if(Object.values(os.networkInterfaces()).flat().some(x=>!x.internal))throw new Error('APPLICATION_REHEARSAL_PRIVATE_NETWORK_REQUIRED');
 const step=process.argv[2];if(!['operations','http','fault','outbox','load','export'].includes(step))throw new Error('APPLICATION_REHEARSAL_STEP');
 if(fs.existsSync(ROOT+'/data/postmaster.pid'))throw new Error('APPLICATION_REHEARSAL_ALREADY_RUNNING');
 const config=JSON.parse(fs.readFileSync(ROOT+'/operations-config.json','utf8'));
 async function ctl(args){await new Promise((resolve,reject)=>{const child=spawn('/usr/lib/postgresql/18/bin/pg_ctl',['-D',ROOT+'/data',...args],{stdio:'ignore',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('APPLICATION_REHEARSAL_PG_CONTROL')));});}
 let running=false,access;const started=performance.now();
 try{
  await ctl(['-l',ROOT+'/postgresql.log','-w','start']);running=true;
  const url=new URL('postgresql://127.0.0.1:55487/gp_migration_core');url.username='gp_core_app';url.password=config.recoveryAccounts.gp_core_app;
  let result;
  if(step==='operations'){
   access=await require('../../lib/persistence/postgresql/application-operations/access').openCoreOperations({profile:'core-migration-development',databaseUrl:url.href,tlsMode:'disable-local-only'});
   result=await require('../../test-support/postgresql-migration/application-operations').qualifyOperations(access);
  }else if(step==='outbox')result=await require('../../test-support/postgresql-migration/application-outbox').qualifyOutbox({root:ROOT,config});
  else if(step==='export')result=await require('../../test-support/postgresql-migration/application-export').qualifyExport({root:ROOT,config});
  else if(step==='fault'){
   if(fs.existsSync(ROOT+'/interrupted-report.json')||fs.existsSync(ROOT+'/fault-verification.json'))throw new Error('APPLICATION_REHEARSAL_FAULT_ALREADY_RUN');
   for(const scenario of ['interrupt-report','resume-report']){
    const outcome=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[__dirname+'/application-fault-child.js',scenario],{stdio:'inherit',env:process.env});child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    if(scenario==='interrupt-report'?outcome.signal!=='SIGKILL':outcome.code!==0)throw new Error('APPLICATION_REHEARSAL_FAULT_CHILD');
   }
   result=JSON.parse(fs.readFileSync(ROOT+'/fault-verification.json','utf8'));
  }else result=await require('../../test-support/postgresql-migration/application-http').qualifyHttp({root:ROOT,config,
   ...(step==='load'?{extraScenario:require('../../test-support/postgresql-migration/application-load').qualifyLoad}:{})});
  const proof={...result,step,checkedAt:new Date().toISOString(),milliseconds:Math.round(performance.now()-started),productActivation:false};
  fs.writeFileSync(ROOT+'/'+step+'-verification.json',JSON.stringify(proof,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(proof));
 }finally{await access?.close();if(running)await ctl(['-m','fast','-w','stop']);}
}
main().catch(error=>{fs.writeFileSync(ROOT+'/failure-private.json',JSON.stringify({message:error.message,detail:error.detail,stack:error.stack},null,2),{mode:0o600});console.error(JSON.stringify({failed:true,code:error.code||error.message,stack:String(error.stack).split('\n').filter(s=>s.includes('/qualification/')).slice(0,6)}));process.exitCode=1;});
