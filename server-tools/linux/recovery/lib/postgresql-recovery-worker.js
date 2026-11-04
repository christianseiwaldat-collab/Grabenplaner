'use strict';
const fs=require('node:fs'),path=require('node:path');
const {restorePair}=require('../../../../lib/persistence/postgresql/operations/paired-restore');
const {phaseReporter}=require('./postgresql-recovery-activity');
async function prepareRestoredSchema({config,connect}){
 const core=config.domains.find(domain=>domain.domain==='core');
 if(!core)throw new Error('PG_RECOVERY_CORE_MISSING');
 // connect belongs to restorePair's private Unix-socket cluster. Source
 // checkpoints and protected data have already been verified by restorePair;
 // These upgrades change only the disposable application test copy. Its
 // authentication state is invalidated separately on every explicit restore,
 // including backups whose one-time schema migrations already ran. The verified
 // source pair remains untouched and is never opened by the target application.
 const client=connect(core.database,'gp_core_migrator');
 try{
  // The final schema fingerprint runs after the migrations commit their LOCAL settings.
  await client.connect();await client.query("SET search_path=pg_catalog,gp;SET lock_timeout='5s';SET statement_timeout='30s'");
  const xoffi=await require('../../../../lib/persistence/postgresql/core/xoffi-snapshots').migrate(client,{binding:config.binding});
  const vocationalSchool=await require('../../../../lib/persistence/postgresql/core/vocational-school').migrate(client,{binding:config.binding});
  const sessionSecurity=await require('../../../../lib/persistence/postgresql/core/session-security').migrate(client,{binding:config.binding});
  const passkeys=await require('../../../../lib/persistence/postgresql/core/passkeys').migrate(client,{binding:config.binding});
  await require('../../../../lib/persistence/postgresql/boundary/migrate').verifyCoreSchema(client,{requireVocationalSchool:true,requireSessionSecurity:true,requirePasskeys:true});
  const restoreAuthentication=require('../../../../lib/persistence/postgresql/operations/restore-authentication');
  const authenticationInvalidation=await restoreAuthentication.invalidateRestoredAuthentication(client,{binding:config.binding,scope:restoreAuthentication.SCOPE});
  return {xoffi,vocationalSchool,sessionSecurity,passkeys,authenticationInvalidation};
 }finally{await client.end();}
}
async function main(){
 const [root]=process.argv.slice(2);
 if(process.platform!=='linux'||process.getuid()===0||!/^\/var\/lib\/grabenplaner-offsite\/postgresql-recovery\/[a-f0-9-]{36}$/.test(root||'')||fs.realpathSync(root)!==root||fs.statSync(root).uid!==process.getuid())throw new Error('PG_RECOVERY_WORKER_ROOT');
 const request=JSON.parse(fs.readFileSync(root+'/request.json','utf8'));
 if(!/^[a-f0-9-]{36}\.pair$/.test(request.bundle)||request.commitMarker!==request.bundle+'.complete.json')throw new Error('PG_RECOVERY_WORKER_REQUEST');
 const bundle=path.join(root,'source',request.bundle),commitMarker=path.join(root,'source',request.commitMarker);
 const progress=phaseReporter(root);
 const result=await restorePair({bundle,commitMarker,workRoot:root+'/work',onProgress:progress,privateApplicationNetwork:true,async onRestored({config,connect,workRoot}){
  progress('verify-application-schema');
  const client=connect(config.domains[0].database,'gp_core_reader');
  try{
   await client.connect();const rows=(await client.query("SELECT id,app_version FROM gp.schema_migrations WHERE btrim(app_version)<>''")).rows;
   const {compareSemver}=require('./recovery-shared');
   if(compareSemver(request.sourceVersion,request.targetVersion)>0)throw new Error('PG_RECOVERY_APP_DOWNGRADE');
   for(const row of rows){const version=request.sourceVersion==='0.92.32-beta'&&row.id==='developer-permission-defaults-v1'&&row.app_version==='local'?'0.92.32-beta':row.app_version;if(compareSemver(version,request.targetVersion)>0)throw new Error('PG_RECOVERY_SCHEMA_NEWER_THAN_APP');}
  }finally{await client.end();}
  const schemaUpgrades=await prepareRestoredSchema({config,connect});progress('prepare-application-copy');
  const applicationRoot=workRoot+'/application';fs.mkdirSync(applicationRoot,{mode:0o700});
  fs.writeFileSync(applicationRoot+'/ownership-marker','grabenplaner-postgresql-full-application-v1\n',{flag:'wx',mode:0o600});
  fs.copyFileSync(bundle+'/postgresql-operations.json',applicationRoot+'/operations-config.json');fs.chmodSync(applicationRoot+'/operations-config.json',0o600);
  fs.copyFileSync(bundle+'/configuration.env',applicationRoot+'/source-encryption.env');fs.chmodSync(applicationRoot+'/source-encryption.env',0o600);
  for(const name of ['private','branding-kits'])if(fs.existsSync(bundle+'/'+name))fs.cpSync(bundle+'/'+name,applicationRoot+'/'+name,{recursive:true,errorOnExist:true,force:false});
  progress('verify-application-http');
  const smoke=await require('./postgresql-application-smoke').qualifyHttp({root:applicationRoot,config,rehearsal:'paired-restore',connectionPort:55484});
  if(smoke.fullApplicationSmoke!==true||smoke.passed!==true)throw new Error('PG_RECOVERY_APPLICATION_SMOKE');
  return {...smoke,compatibility:true,schemaUpgrades};
 }});
 fs.writeFileSync(root+'/result.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});
 progress('complete');
}
if(require.main===module)main().catch(error=>{process.stderr.write(JSON.stringify({failed:true,code:error.code||null,error:/^PG_/.test(error.message)?error.message:'PostgreSQL recovery failed'})+'\n');process.exitCode=1;});
module.exports={prepareRestoredSchema};
