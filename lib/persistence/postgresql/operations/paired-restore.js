'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{Client}=require('pg');
const {verifyPairBundle,safeRoot}=require('./paired-bundle');
const {verifyCheckpoint}=require('./paired-checkpoint');
const {SCHEMAS}=require('../sales/layout');
const {materializeDefaultPrivileges}=require('./restore-privileges');
const {restorePerformance,restoreArguments,restoreSettings}=require('./restore-performance');
const {assertRestoreCapacity}=require('./restore-capacity');
const {protectedRecordChecks}=require('../../../../server-tools/linux/recovery/lib/recovery-shared');
const {monitorActivity,terminateAndConfirm,readCgroupActivity,processCgroup,childCompletion}=require('../../../../server-tools/linux/recovery/lib/postgresql-recovery-activity');
const BIN='/usr/lib/postgresql/18/bin';
const quote=value=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw new Error('PG_PAIR_RESTORE_IDENTIFIER');return '"'+value+'"';};

async function waitForRestoreTool(child,{name,commandNumber,watch={}}) {
 let closed=false,group;
 const completion=childCompletion(child,'PG_PAIR_RESTORE_TOOL_START');
 child.once('close',()=>{closed=true;});child.once('error',()=>{closed=true;});
 // PostgreSQL performs restore work in backend processes, not only pg_restore.
 // They share the dedicated isolated service cgroup; account for all of them.
 const result=await monitorActivity({completion,
  sample:()=>readCgroupActivity(group||(group=processCgroup(child.pid))),
  terminate:()=>terminateAndConfirm({signal:signal=>child.kill(signal),isStopped:()=>closed}),
  ...watch});
 if(result.code!==0)throw Object.assign(new Error('PG_PAIR_RESTORE_TOOL_FAILED'),{tool:name,commandNumber});
}

async function protectedRecords(client,storage){
 // One set of context and content checks is shared with SQLite recovery.
 // The generator only describes reads; PostgreSQL reads remain asynchronous.
 const generator=protectedRecordChecks(storage);let step=generator.next();
 while(!step.done){
  const request=step.value;let result;
  if(request.kind==='notification-schema')result={exists:true,valid:true}; // Exact restored schema was already checked.
  else if(request.kind==='notification-rows')result=require('../../../personal-notification-contact-validation').validatePersonalNotificationContactRows((await client.query('SELECT * FROM gp.personal_notification_contacts ORDER BY employee_number')).rows);
  else{
   const [table,columns,sql]=request.args;
   const found=(await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',['gp',table])).rows.map(r=>r.column_name);
   if(!found.length||columns.some(c=>!found.includes(c)))throw new Error('PG_PAIR_PROTECTED_SCHEMA');
   result=(await client.query(sql)).rows;
  }
  step=generator.next(result);
 }
 return step.value;
}

async function restorePair({bundle,commitMarker,workRoot,onRestored,onOwnedRestored,onProgress=()=>{},privateApplicationNetwork=false,performanceProfile='parallel',scope='full',rehydrate=false,sourceArchiveDirectory,freshSourceDirectory}={}){
 require('./deploy-data-policy').normalizeScope(scope);
 if(scope!=='full'&&onRestored||scope==='full'&&(onOwnedRestored||rehydrate))throw new Error('PG_RECOVERY_CALLBACK_SCOPE');
 const tuning=restorePerformance(performanceProfile);
 if(process.platform!=='linux'||process.getuid()===0)throw new Error('PG_PAIR_RESTORE_UNPRIVILEGED');
 safeRoot(workRoot);
 if(privateApplicationNetwork&&Object.values(require('node:os').networkInterfaces()).flat().some(x=>!x.internal))throw new Error('PG_PAIR_RESTORE_PRIVATE_NETWORK');
 if(fs.statSync(workRoot).uid!==process.getuid()||fs.readdirSync(workRoot).length)throw new Error('PG_PAIR_RESTORE_NEW_WORKSPACE');
 const capacity=fs.statfsSync(workRoot);if(capacity.bavail*capacity.bsize<10*1024**3)throw new Error('PG_PAIR_RESTORE_DISK_RESERVE');
 onProgress('verify-bundle');const verified=await verifyPairBundle(bundle,commitMarker,{scope});
 const fresh=verified.manifest.recovery?.basis==='fresh-source-rebuild';
 const currentCapacity=fs.statfsSync(workRoot);
 const capacityPlan=assertRestoreCapacity(verified.manifest,currentCapacity.bavail*currentCapacity.bsize,{rehydrate});
 if(!verified.manifest.files.some(f=>f.file==='postgresql-operations.json'))throw new Error('PG_PAIR_RECOVERY_CONFIG_REQUIRED');
 const config=JSON.parse(fs.readFileSync(bundle+'/postgresql-operations.json','utf8'));
 const environment=require('node:util').parseEnv(fs.readFileSync(bundle+'/configuration.env','utf8'));
 if(scope!=='full'&&rehydrate){const sources=fresh?freshSourceDirectory:sourceArchiveDirectory;safeRoot(sources);if(fs.statSync(sources).uid!==process.getuid())throw new Error('PG_DEPLOY_SOURCE_OWNER');}
 if(config.format!=='grabenplaner-postgresql-operations-v1'||config.domains?.map(d=>d.domain).join(',')!=='core,sales')throw new Error('PG_PAIR_RECOVERY_CONFIG');
 const accounts=config.recoveryAccounts;
 if(!accounts||Object.keys(accounts).length!==8||Object.keys(accounts).some(name=>!/^gp_(?:(?:core|sales)_(?:app|reader|migrator)|migration_admin|operations_monitor)$/.test(name))||Object.values(accounts).some(p=>typeof p!=='string'||p.length<24))throw new Error('PG_PAIR_RECOVERY_ACCOUNTS');
 for(const d of config.domains){
  const binding=verified.manifest.databases.find(x=>x.domain===d.domain);
  if(d.database!==binding.database||!verified.manifest.checkpoint?.domains?.[d.domain]?.restore)throw new Error('PG_PAIR_RECOVERY_CHECKPOINT');
  quote(d.database);
 }
 // No productive socket/port is ever an input. The new cluster is reachable
 // only through its own private Unix socket. Preserve the original grantor
 // identity: PostgreSQL role grants bind ADMIN OPTION to that grantor.
 const data=workRoot+'/data',socket=fs.mkdtempSync('/tmp/gp-pg-recovery-'),bootstrap=accounts.gp_migration_admin;
 fs.chmodSync(socket,0o700);
 const passwordFile=workRoot+'/bootstrap.password';fs.writeFileSync(passwordFile,bootstrap+'\n',{flag:'wx',mode:0o600});
 let commandNumber=0;
 async function native(name,args,{database='postgres'}={}){
  if(!['initdb','pg_ctl','psql','pg_restore'].includes(name))throw new Error('PG_PAIR_RESTORE_TOOL');
  const binary=BIN+'/'+name,info=fs.lstatSync(binary);if(info.uid!==0||(info.mode&0o022)||!info.isFile()||fs.realpathSync(binary)!==binary)throw new Error('PG_PAIR_RESTORE_BINARY');
  const stem=workRoot+'/tool-'+(++commandNumber),out=fs.openSync(stem+'.out','wx',0o600),err=fs.openSync(stem+'.err','wx',0o600);
  const child=spawn(binary,args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PGHOST:socket,PGPORT:'55484',PGUSER:'gp_migration_admin',PGPASSWORD:bootstrap,PGDATABASE:database,PGCONNECT_TIMEOUT:'5'},stdio:['ignore',out,err]});fs.closeSync(out);fs.closeSync(err);
  await waitForRestoreTool(child,{name,commandNumber});
 }
 function connect(database,role='gp_migration_admin'){
  return new Client({host:socket,port:55484,database,user:role,password:accounts[role],connectionTimeoutMillis:5000});
 }
 const started=performance.now(),databases={},timings=[];let running=false,admin,accessRehydration;
 try{
  onProgress('initialize-cluster');
  await native('initdb',['-D',data,'-U','gp_migration_admin','--auth-local=scram-sha-256','--auth-host=reject','--encoding=UTF8','--locale=C.UTF-8','--pwfile='+passwordFile]);fs.unlinkSync(passwordFile);
  fs.appendFileSync(data+'/postgresql.conf',"\nlisten_addresses=''\nport=55484\nunix_socket_directories='"+socket.replace(/'/g,"''")+"'\n"+restoreSettings(performanceProfile)+"max_connections=20\nmax_locks_per_transaction=256\nlog_min_messages=warning\n");
  // This short-lived restored cluster shares its resource limit with app checks.
  // Post-restore autovacuum scans otherwise starve the low-priority report
  // workers. Integrity, checkpoint and application checks still run in full;
  // the live cluster's maintenance configuration is never changed here.
  fs.appendFileSync(data+'/postgresql.conf',"autovacuum=off\n");
  if(privateApplicationNetwork){fs.appendFileSync(data+'/postgresql.conf',"\nlisten_addresses='127.0.0.1'\n");fs.writeFileSync(data+'/pg_hba.conf',"local all all scram-sha-256\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n",{mode:0o600});}
  await native('pg_ctl',['-D',data,'-l',workRoot+'/postgresql.log','-w','start']);running=true;
  admin=connect('postgres');await admin.connect();
  onProgress('restore-roles');
  const roleText=fs.readFileSync(bundle+'/roles.sql','utf8');
  if(roleText.split(/^CREATE ROLE gp_migration_admin;\r?\n/m).length!==2)throw new Error('PG_PAIR_RECOVERY_GRANTOR');
  fs.writeFileSync(workRoot+'/roles.restore.sql',roleText.replace(/^CREATE ROLE gp_migration_admin;\r?\n/m,''),{flag:'wx',mode:0o600});
  await native('psql',['--no-psqlrc','--set=ON_ERROR_STOP=1','--file='+workRoot+'/roles.restore.sql']);
  for(const [name,password] of Object.entries(accounts))await admin.query((await admin.query('SELECT format($1::text,$2::text,$3::text) AS sql',['ALTER ROLE %I PASSWORD %L',name,password])).rows[0].sql);
  for(const d of config.domains){
   onProgress('restore-'+d.domain);
   await admin.query('CREATE DATABASE '+quote(d.database)+' OWNER '+quote('gp_'+d.domain+'_owner')+" TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C.UTF-8'");
   const before=performance.now();
   if(scope!=='full'&&d.domain==='sales'){
    // Restore the exact schema/data without its foreign-key triggers first.
    // The projection restores original IDs and owned values before post-data.
    for(const section of ['pre-data','data'])await native('pg_restore',['--section='+section,...restoreArguments(d.database,bundle+'/'+d.domain+'.dump',performanceProfile)],{database:d.database});
    const coreForProjection=connect(config.domains[0].database,'gp_core_reader'),salesForProjection=connect(d.database);
    try{
     await coreForProjection.connect();await salesForProjection.connect();
     const owned=require('./owned-recovery'),vault=owned.recoveryVault(environment);
     if(['grabenplaner-access-owned-state-v3','grabenplaner-access-owned-state-v4'].includes(verified.manifest.recovery.accessPlan.format)){
      onProgress('restore-owned-sales-state');
      accessRehydration=await owned.withProtection(coreForProjection,vault,protection=>require('./access-owned-state').restoreOwnedState({core:coreForProjection,sales:salesForProjection,protection,plan:verified.manifest.recovery.accessPlan,directory:bundle,isolatedRecovery:true}));
     }else{
      const archive=require('../../../data-import-source-archive').createImportSourceArchive({directory:bundle+'/private/import-sources',...(rehydrate?{objectDirectory:sourceArchiveDirectory}:{}),readOnly:true,vault});
      const materializationDirectory=workRoot+'/access-materialization';
      if(rehydrate)fs.mkdirSync(materializationDirectory,{mode:0o700});
      onProgress(rehydrate?'rehydrate-access-values':'restore-owned-access-projection');
      accessRehydration=await owned.withProtection(coreForProjection,vault,protection=>require('./access-recovery-projection').restoreProjection({sales:salesForProjection,protection,archive,plan:verified.manifest.recovery.accessPlan,directory:bundle,materializationDirectory,rehydrate,isolatedRecovery:true,archiveProof:verified.manifest.recovery.sourceArchive}));
     }
    }finally{await coreForProjection.end();await salesForProjection.end();}
    await native('pg_restore',['--section=post-data',...restoreArguments(d.database,bundle+'/'+d.domain+'.dump',performanceProfile)],{database:d.database});
   }else await native('pg_restore',restoreArguments(d.database,bundle+'/'+d.domain+'.dump',performanceProfile),{database:d.database});
   timings.push({domain:d.domain,milliseconds:Math.round(performance.now()-before)});
   const client=connect(d.database);await client.connect();
   onProgress('verify-'+d.domain);
   try{
    await materializeDefaultPrivileges(client,d.domain==='core'?['gp']:SCHEMAS);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    databases[d.domain]=await verifyCheckpoint(client,d.domain,verified.manifest.checkpoint.domains[d.domain].restore);
    await client.query('COMMIT');
   }finally{await client.end();}
   // A correct superuser restore does not prove application logins work.
   for(const purpose of ['app','reader','migrator']){const c=connect(d.database,'gp_'+d.domain+'_'+purpose);try{await c.connect();await c.query('BEGIN READ ONLY');const env=(await c.query('SELECT environment_id,profile,domain FROM gp.environment_contract')).rows;if(env.length!==1||env[0].domain!==d.domain||env[0].environment_id!==d.environmentId||env[0].profile!==d.profile)throw new Error('PG_PAIR_RESTORED_ACCOUNT_BINDING');await c.query('COMMIT');}finally{await c.end();}}
  }
  onProgress('verify-protected-records');
  const id=environment.GRABENPLANER_AMU_KEY_ID,amu=require('../../../amu-storage');
  const documents=amu.validateEncryptionKeyForStorage({sourceDirectory:bundle+'/private/amu',encryptionKeys:{[id]:environment.GRABENPLANER_AMU_KEY},activeKeyId:id});
  const storage=amu.createAmuStorage({rootDirectory:workRoot+'/key-check',encryptionKeys:{[id]:environment.GRABENPLANER_AMU_KEY},activeKeyId:id});
  const core=connect(config.domains[0].database,'gp_core_reader');let records,integrationCredentials=0,managedImportKey=false,protectedPriceLabelImages=0;
  try{
   await core.connect();await core.query('BEGIN READ ONLY');await core.query('SET LOCAL search_path=pg_catalog,gp');records=await protectedRecords(core,storage);
   const vaultId=environment.GRABENPLANER_INTEGRATION_KEY_ID,keys=environment.GRABENPLANER_INTEGRATION_KEYS?JSON.parse(environment.GRABENPLANER_INTEGRATION_KEYS):{};keys[vaultId]=environment.GRABENPLANER_INTEGRATION_KEY;
   const vault=require('../../../integration-secret-vault').createIntegrationSecretVault({activeKeyId:vaultId,keys});
   for(const row of (await core.query("SELECT id,kind,protected_credentials FROM gp.integration_connections WHERE protected_credentials<>'' ORDER BY id")).rows){
    await vault.useSecret(row.protected_credentials,{namespace:'integration-connection',connectorId:String(row.id),field:'credentials',purpose:String(row.kind||'integration')},async bytes=>{const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('PG_PAIR_INTEGRATION_CREDENTIALS');});integrationCredentials++;
   }
   const archiveKey=(await core.query("SELECT payload FROM gp.data_import_runtime_keys WHERE id='data-import-v1'")).rows;
   if(archiveKey.length!==1)throw new Error('PG_PAIR_ARCHIVE_KEY');
   await vault.useSecret(archiveKey[0].payload,{namespace:'data-import',connectorId:'data-import-v1',field:'data-and-index-keys',purpose:'source-archive-and-recovery'},async bytes=>{if(bytes.length!==64)throw new Error('PG_PAIR_ARCHIVE_KEY');managedImportKey=true;});
   protectedPriceLabelImages=await require('./runtime').verifyPriceLabelImageFiles(core,{sourceDirectory:bundle+'/private/amu',environment,keyPayload:archiveKey[0].payload});
   await core.query('COMMIT');
  }finally{await core.end();}
  onProgress('verify-import-source-archive');
  const owned=require('./owned-recovery');
  const protectedImportSources=fresh?{available:false,requiresFreshAccess:true,basis:verified.manifest.recovery.basis}:await owned.sourceArchive(bundle,environment,{referenceOnly:scope!=='full'});
  let ownedRecovery,cashRehydration;
  if(scope!=='full'){
   const sparse=['grabenplaner-access-owned-state-v3','grabenplaner-access-owned-state-v4'].includes(verified.manifest.recovery.accessPlan.format);
   const coreClient=connect(config.domains[0].database,(rehydrate&&sparse)||fresh?'gp_migration_admin':'gp_core_reader'),salesClient=connect(config.domains[1].database,rehydrate||fresh?'gp_migration_admin':'gp_sales_reader');
   try{
    await coreClient.connect();await salesClient.connect();
    ownedRecovery=await owned.verifyOwnedRecovery({core:coreClient,sales:salesClient,sourceRoot:bundle,environment,recovery:verified.manifest.recovery});
    if(fresh){
     onProgress('invalidate-reconstructible-cash-readiness');
     const prepared=await owned.withProtection(coreClient,owned.recoveryVault(environment),protection=>require('./access-fresh-rebuild').prepareFreshRestore({core:coreClient,sales:salesClient,protection,plan:verified.manifest.recovery.freshSourcePlan,isolatedRecovery:true}));
     if(prepared?.verified!==true)throw new Error('PG_DEPLOY_FRESH_PREPARATION_INCOMPLETE');
     ownedRecovery={...ownedRecovery,freshRestorePreparation:prepared};
    }
    if(rehydrate){
     if(sparse){
      const archive=fresh?undefined:require('../../../data-import-source-archive').createImportSourceArchive({directory:bundle+'/private/import-sources',objectDirectory:sourceArchiveDirectory,readOnly:true,vault:owned.recoveryVault(environment)});
      onProgress('replay-access-imports');
      const replay=await owned.rehydrateOwnedSources({core:coreClient,sales:salesClient,vault:owned.recoveryVault(environment),archive,recovery:verified.manifest.recovery,config,socket,workRoot,freshSourceDirectory,onProgress});
      if(replay?.verified!==true||replay.rehydrated!==true)throw new Error('PG_DEPLOY_SOURCE_REPLAY_INCOMPLETE');
      accessRehydration={...accessRehydration,rehydrated:true,requiresAccessRehydration:false,requiresImportRehydration:false,...(fresh?{requiresFreshAccess:false}:{}),sourceReplay:replay};
      if(fresh){if(replay.cash?.verified!==true)throw new Error('PG_DEPLOY_FRESH_CASH_INCOMPLETE');cashRehydration=replay.cash;}
     }
     if(!fresh){onProgress('rehydrate-cash');cashRehydration=await owned.rehydrateOwnedCash({core:coreClient,sales:salesClient,sourceRoot:bundle,environment,recovery:verified.manifest.recovery,isolatedRecovery:true,sourceArchiveDirectory});}
     // Catalog replay may already have populated part of this derived cache.
     // Rebuild it completely from the authoritative heads after all sources.
     if(sparse)await salesClient.query('DELETE FROM trade.sales_article_search_projection');
     onProgress('rebuild-article-search');accessRehydration.searchProjection=await require('./access-recovery-projection').rebuildSearchProjection({sales:salesClient,isolatedRecovery:true});
    }
   }finally{await coreClient.end();await salesClient.end();}
  }
  // Bootstrap is complete. Release its reserved-slot pressure before the full
  // application and its bounded reader pools share this small test cluster.
  await admin.end();admin=undefined;
  const result={providerId:scope==='full'?'postgresql-pair':'postgresql-deploy-owned',...(scope==='full'?{}:{recoveryScope:scope,fullRecovery:false,requiresCashRehydration:!rehydrate,requiresAccessRehydration:!rehydrate,...(fresh?{requiresFreshAccess:!rehydrate,basis:verified.manifest.recovery.basis}:{}),ownedRecovery,cashRehydration,accessRehydration}),verified:true,checkedAt:new Date().toISOString(),manifestSha256:verified.manifestSha256,databases,protectedDocuments:documents.fileCount,protectedRecords:records,protectedPriceLabelImages,protectedImportSources,integrationCredentials,managedImportKey,recoveryAccounts:8,timings,milliseconds:Math.round(performance.now()-started)};
  result.performance={profile:performanceProfile,...tuning};
  result.capacity=capacityPlan;
  if(onRestored){onProgress('application-smoke');result.application=await onRestored({config,connect,socket,workRoot,bundle});}
  if(onOwnedRestored){onProgress('owned-application-smoke');result.application=await onOwnedRestored({config,connect,socket,workRoot,bundle,rehydrated:rehydrate,recoveryBasis:verified.manifest.recovery.basis});if(result.application?.fullApplicationSmoke===true&&!rehydrate)throw new Error('PG_RECOVERY_FULL_SMOKE_SCOPE');}
  onProgress('verify-final-bundle');
  await verifyPairBundle(bundle,commitMarker,{expectedSha256:verified.manifestSha256,scope});
  return result;
 }finally{
  try{onProgress('stop-cluster');}catch{/* A telemetry write must never skip cluster shutdown. */}
  try{await admin?.end();}
  finally{
   if(running)await native('pg_ctl',['-D',data,'-m','fast','-w','stop']);
   if(fs.realpathSync(socket)===socket&&fs.statSync(socket).uid===process.getuid()&&path.dirname(socket)==='/tmp'&&path.basename(socket).startsWith('gp-pg-recovery-'))fs.rmSync(socket,{recursive:true});
  }
 }
}
module.exports={restorePair,protectedRecords,waitForRestoreTool};
