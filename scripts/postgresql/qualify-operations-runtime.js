'use strict';
const fs=require('node:fs'),{spawn}=require('node:child_process'),{Client}=require('pg');
const R=require('../../lib/persistence/postgresql/operations/paired-development');
const {FORMAT}=require('../../lib/persistence/postgresql/operations/runtime');
async function run(args){
 const child=spawn(process.execPath,['server-tools/linux/lib/postgresql-operations.js',...args],{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});let output='',error='';
 child.stdout.on('data',value=>{output+=value;if(output.length>262144)child.kill();});child.stderr.on('data',value=>{error+=value;if(error.length>16384)child.kill();});
 return new Promise((resolve,reject)=>child.once('close',code=>code===0?resolve(JSON.parse(output)):reject(new Error(error||'Operations CLI failed'))));
}
async function main(){
 R.guard();const configFile=R.ROOT+'/operations-config.json';if(fs.existsSync(configFile))throw new Error('PG_PAIR_RUNTIME_ALREADY_INITIALIZED');
 fs.mkdirSync(R.ROOT+'/runtime-work',{mode:0o700});fs.mkdirSync(R.ROOT+'/runtime-backups',{mode:0o700});
 const admin=new Client({connectionString:R.connectionString('admin')});let clusterId;try{await admin.connect();clusterId=(await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;}finally{await admin.end();}
 const accounts=R.credentials().accounts,config={format:FORMAT,mode:'qualification',host:'127.0.0.1',port:55482,clusterId,sourceFiles:R.BASE+'/historical-9/source',backupDirectory:R.ROOT+'/runtime-backups',workDirectory:R.ROOT+'/runtime-work',environmentFile:R.BASE+'/historical-9/source/configuration.env',domains:['core','sales'].map(domain=>({domain,database:'gp_migration_'+domain,role:'gp_'+domain+'_migrator',password:accounts['gp_'+domain+'_migrator'],environmentId:'grabenplaner-development-20260912',profile:'core-migration-development'})),administrator:{role:'gp_migration_admin',password:accounts.gp_migration_admin},monitor:JSON.parse(fs.readFileSync(R.ROOT+'/monitor-credentials.json','utf8'))};
 config.recoveryAccounts={...accounts,[config.monitor.role]:config.monitor.password};
 fs.writeFileSync(configFile,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
 const identity=await run(['identity',configFile]),monitor=await run(['monitor',configFile]),backup=await run(['backup',configFile]);
 const verified=await run(['verify',configFile,backup.bundle,backup.commitMarker]);
 const result={checkedAt:new Date().toISOString(),verified:true,identity,monitoredDomains:Object.keys(monitor),backupMilliseconds:backup.milliseconds,backupManifestSha256:backup.sha256,files:verified.files,componentBytes:verified.bytes,productActivation:false};
 fs.writeFileSync(R.ROOT+'/runtime-verification.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(JSON.stringify({failed:true,error:e.message,code:e.code||null}));process.exitCode=1;});
