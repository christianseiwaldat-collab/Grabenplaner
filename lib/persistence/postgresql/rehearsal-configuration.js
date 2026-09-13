'use strict';
const fs=require('node:fs'),os=require('node:os');
const ROOT='/home/gpadmin/grabenplaner-pg-migration-20260912/application-11';
function configuration(environment){
 const restore=environment.GRABENPLANER_POSTGRESQL_REHEARSAL==='paired-restore';
 const activation=environment.GRABENPLANER_POSTGRESQL_REHEARSAL==='activation-12';
 const root=restore?environment.GRABENPLANER_RESTORE_ROOT:activation?'/home/gpadmin/grabenplaner-pg-migration-20260912/activation-12':ROOT;
 if(restore&&!/^\/var\/lib\/grabenplaner-offsite\/postgresql-recovery\/[a-f0-9-]{36}\/work\/application$/.test(root||''))throw new Error('PG_APPLICATION_RECOVERY_SCOPE');
 const marker=restore?'grabenplaner-postgresql-full-application-v1':activation?'grabenplaner-postgresql-staging-v1':'grabenplaner-application-rehearsal-11-v1';
 if(process.platform!=='linux'||process.getuid()===0||environment.NODE_ENV!=='test'||environment.GRABENPLANER_DEPLOYMENT_KIND!=='recovery-smoke'
  ||environment.GRABENPLANER_DATA_DIR!==root+'/runtime'||environment.DATABASE_URL||environment.DB_PATH||fs.realpathSync(root)!==root
  ||fs.statSync(root).uid!==process.getuid()||(fs.statSync(root).mode&0o077)||fs.readFileSync(root+'/ownership-marker','utf8').trim()!==marker
  ||Object.values(os.networkInterfaces()).flat().some(x=>!x.internal))throw new Error('PG_APPLICATION_REHEARSAL_REQUIRED');
 const file=root+'/operations-config.json',stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)||fs.realpathSync(file)!==file)throw new Error('PG_APPLICATION_REHEARSAL_CREDENTIALS');
 const config=JSON.parse(fs.readFileSync(file,'utf8'));
 const port=restore?55484:activation?55486:55487;
 const binding=config.binding?require('./runtime-binding').validateBinding(config.binding):undefined;
 const prefix=binding?'grabenplaner_':'gp_migration_';
 const settings=binding?{profile:binding.profile,binding}:{};
 const urls=Object.fromEntries(['core','sales'].map(domain=>{const url=new URL('postgresql://127.0.0.1:'+port+'/'+prefix+domain);url.username='gp_'+domain+'_app';url.password=config.recoveryAccounts[url.username];return [domain+'Url',url.href];}));
 const readers=Object.fromEntries(['core','sales'].map(domain=>{const url=new URL('postgresql://127.0.0.1:'+port+'/'+prefix+domain);url.username='gp_'+domain+'_reader';url.password=config.recoveryAccounts[url.username];return [domain+'Url',url.href];}));
 return Object.freeze({providerId:'postgresql',databasePath:root+'/runtime/data/core.postgresql',databaseUrlConfigured:true,...urls,...settings,readers:Object.freeze({...readers,...settings}),rehearsal:true,productActivation:false});
}
module.exports={configuration};
