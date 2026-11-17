'use strict';

const fs=require('node:fs'),path=require('node:path');
const {buildSalesPlan,validateSalesPlan}=require('./deploy-data-policy');
const {encryptionConfiguration}=require('../../../../server-tools/linux/recovery/lib/recovery-shared');
const {createIntegrationSecretVault}=require('../../../integration-secret-vault');
const {createDataImportProtection}=require('../../../data-import-protection');
const {verifyImportSourceArchive,createImportSourceArchive}=require('../../../data-import-source-archive');

function recoveryVault(environment){
 const keys=encryptionConfiguration(new Map(Object.entries(environment)));
 return createIntegrationSecretVault({activeKeyId:keys.integrationKeyId,keys:keys.integrationKeys});
}
async function withProtection(core,vault,work){
 const rows=(await core.query("SELECT payload FROM gp.data_import_runtime_keys WHERE id='data-import-v1'")).rows;
 if(rows.length!==1)throw new Error('PG_DEPLOY_IMPORT_KEY_REQUIRED');
 let protection;
 try{
  await vault.useSecret(rows[0].payload,{namespace:'data-import',connectorId:'data-import-v1',field:'data-and-index-keys',purpose:'source-archive-and-recovery'},async bytes=>{
   if(bytes.length!==64)throw new Error('PG_DEPLOY_IMPORT_KEY_REQUIRED');
   protection=createDataImportProtection({encryptionKey:bytes.subarray(0,32),indexKey:bytes.subarray(32),keyId:'data-import-v1',compression:true});
  });
  return await work(protection);
 }finally{protection?.destroy();}
}
async function salesPlan(client,{basis}={}){
 const tables=(await client.query("SELECT schemaname AS schema,tablename AS table FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename",[['gp','kassa','integration','trade','reporting']])).rows;
 // Read all incoming edges, including tables outside the application schemas.
 const foreignKeys=(await client.query(`SELECT sn.nspname AS schema,s.relname AS table,tn.nspname AS "referencedSchema",t.relname AS "referencedTable"
  FROM pg_constraint f JOIN pg_class s ON s.oid=f.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace
  JOIN pg_class t ON t.oid=f.confrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace WHERE f.contype='f' ORDER BY 1,2,3,4`)).rows;
 return buildSalesPlan({tables,foreignKeys,...(basis?{basis}:{})});
}
async function sourceArchive(sourceRoot,environment,{allowMissing=true,referenceOnly=false,objectDirectory}={}){
 const directory=path.join(sourceRoot,'private','import-sources');
 if(allowMissing&&!fs.existsSync(directory))return {version:1,available:false,generationSha256:null,kinds:[],candidates:[]};
 return verifyImportSourceArchive({directory,vault:recoveryVault(environment),allowMissing,referenceOnly,objectDirectory,expectedUid:fs.lstatSync(directory).uid});
}
async function prepareOwnedRecovery({core,sales,sourceRoot,environment,directory,basis='fresh-source-rebuild',checkBudget=()=>{}}){
 if(basis!=='fresh-source-rebuild'&&basis!=='exact-archive')throw new Error('PG_DEPLOY_RECOVERY_BASIS');
 if(basis==='fresh-source-rebuild'){
  const plan=await salesPlan(sales,{basis}),vault=recoveryVault(environment);
  const prepared=await withProtection(core,vault,async protection=>{
   const freshSourcePlan=await require('./access-fresh-rebuild').createFreshPlan({core,sales,protection,checkBudget});
   const accessPlan=await require('./access-owned-state').exportOwnedState({core,sales,protection,directory,basis,checkBudget});
   return {accessPlan,freshSourcePlan};
  });
  return {scope:'deploy-owned',basis,fullRecovery:false,requiresCashRehydration:true,requiresAccessRehydration:true,
   requiresFreshAccess:true,archiveStorage:'none',salesPlan:plan,...prepared};
 }
 const archive=await sourceArchive(sourceRoot,environment,{allowMissing:false});
 if(Buffer.byteLength(JSON.stringify(archive))>2*1024*1024)throw new Error('PG_DEPLOY_SOURCE_PROOF_LIMIT');
 const plan=await salesPlan(sales);
 const vault=recoveryVault(environment);
 const prepared=await withProtection(core,vault,async protection=>{
  // Reconstructible staging, history and lookup graphs are replayed from their
  // authenticated source files. The point keeps only GP-owned rows and the
  // small anchor closure needed by them, rather than one recipe per import row.
  const sourceReplayPlan=await require('./access-source-replay').createReplayPlan({core,sales,protection,archiveProof:archive,checkBudget});
  const accessPlan=await require('./access-owned-state').exportOwnedState({core,sales,protection,directory,archiveProof:archive,sourceReplayPlan,checkBudget});
  const cashPlan=await require('./cash-rehydration').planCashRecovery(sales,{protection,archiveProof:archive});
  return {accessPlan,cashPlan,sourceReplayPlan};
 });
 return {scope:'deploy-owned',fullRecovery:false,requiresCashRehydration:true,requiresAccessRehydration:true,archiveStorage:'server-reference-v1',salesPlan:plan,sourceArchive:archive,...prepared};
}
async function verifyOwnedRecovery({core,sales,sourceRoot,environment,recovery}){
 require('./deploy-owned-contract').validateRecovery(recovery);
 const plan=await salesPlan(sales,{basis:recovery.basis});
 if(plan.planSha256!==validateSalesPlan(recovery.salesPlan).planSha256)throw new Error('PG_DEPLOY_SALES_PLAN_CHANGED');
 if(recovery.basis==='fresh-source-rebuild'){
  require('./access-fresh-rebuild').validateFreshPlan(recovery.freshSourcePlan);
  return {verified:true,basis:recovery.basis,requiresFreshAccess:true,accessProjection:recovery.accessPlan.planSha256,sourceKinds:recovery.salesPlan.requiredSourceKinds};
 }
 const archive=await sourceArchive(sourceRoot,environment,{allowMissing:false,referenceOnly:recovery.archiveStorage==='server-reference-v1'});
 if(archive.generationSha256!==recovery.sourceArchive.generationSha256)throw new Error('PG_DEPLOY_SOURCE_ARCHIVE_CHANGED');
 const cashPlan=await withProtection(core,recoveryVault(environment),protection=>require('./cash-rehydration').planCashRecovery(sales,{protection,archiveProof:archive}));
 if(cashPlan.planSha256!==recovery.cashPlan.planSha256)throw new Error('PG_DEPLOY_CASH_PLAN_CHANGED');
 if(recovery.sourceReplayPlan)require('./access-source-replay').validateReplayPlan(recovery.sourceReplayPlan,{archiveProof:archive});
 return {verified:true,generationSha256:archive.generationSha256,cashDatasets:cashPlan.datasets.length,accessProjection:recovery.accessPlan.planSha256,sourceKinds:recovery.salesPlan.requiredSourceKinds};
}
async function rehydrateOwnedSources({core,sales,access,vault,archive,recovery,config,socket,workRoot,freshSourceDirectory,onProgress=()=>{}}){
 const fresh=recovery.basis==='fresh-source-rebuild';
 if(recovery.accessPlan?.format!==require('./access-owned-state')[fresh?'FRESH_FORMAT':'FORMAT'])throw new Error('PG_DEPLOY_SOURCE_REPLAY_FORMAT');
 // The ordinary import facade accepts only loopback TCP URLs. The disposable
 // cluster therefore needs both its authenticated private socket and its own
 // loopback-only network namespace before those application pools are opened.
 if(process.platform!=='linux'||process.getuid()===0
  ||Object.values(require('node:os').networkInterfaces()).flat().some(item=>!item.internal)
  ||typeof socket!=='string'||!/^\/tmp\/gp-pg-recovery-[A-Za-z0-9_-]+$/.test(socket))throw new Error('PG_DEPLOY_SOURCE_REPLAY_ISOLATION');
 const info=fs.lstatSync(socket);
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077||fs.realpathSync(socket)!==socket)throw new Error('PG_DEPLOY_SOURCE_REPLAY_ISOLATION');
 let clusterId;
 for(const client of [core,sales]){
  const p=client?.connectionParameters;
  if(p?.host!==socket||Number(p.port)!==55484)throw new Error('PG_DEPLOY_SOURCE_REPLAY_ISOLATION');
  const row=(await client.query("SELECT current_setting('unix_socket_directories') AS socket,current_setting('port') AS port,current_setting('listen_addresses') AS listen,(SELECT system_identifier::text FROM pg_control_system()) AS cluster_id")).rows[0];
  if(row?.socket!==socket||row.port!=='55484'||row.listen!=='127.0.0.1'||!row.cluster_id||clusterId&&row.cluster_id!==clusterId)throw new Error('PG_DEPLOY_SOURCE_REPLAY_ISOLATION');
  clusterId=row.cluster_id;
 }
 let application;
 try{
  if(!access){
   const urls=Object.fromEntries(config.domains.map(domain=>{
    const role='gp_'+domain.domain+'_app',url=new URL('postgresql://127.0.0.1:55484/'+domain.database);
    url.username=role;url.password=config.recoveryAccounts[role];return [domain.domain+'Url',url.href];
   }));
   const settings=config.domains[0].database==='grabenplaner_core'
    ?{profile:require('../runtime-binding').PROFILE,binding:require('../runtime-binding').validateBinding(config.binding)}:{};
   application=await require('../boundary/application').openTwoDatabaseDevelopmentApplication({...urls,...settings,stage:8,autoDeliver:false,authorize:()=>true});
   access=application.provider;
  }
  const phases={review:'replay-access-review',apply:'replay-access-apply','generic-cash-history':'replay-cash-history',cash:'rebuild-cash-source'};
  const report=event=>{
   const phase=phases[event?.phase];
   if(!phase)throw new Error('PG_DEPLOY_SOURCE_REPLAY_PROGRESS');
   onProgress(phase);
  };
  if(fresh)return await require('./access-fresh-rebuild').rebuildFreshSources({core,sales,access,vault,plan:recovery.freshSourcePlan,ownedPlan:recovery.accessPlan,
   config,socket,workRoot,sourceDirectory:freshSourceDirectory,isolatedRecovery:true,onProgress:report});
  return await require('./access-source-replay').replaySources({core,sales,access,vault,archive,plan:recovery.sourceReplayPlan,ownedPlan:recovery.accessPlan,
   config,socket,workRoot,isolatedRecovery:true,onProgress:report});
 }finally{await application?.close();}
}
async function rehydrateOwnedCash({core,sales,sourceRoot,environment,recovery,isolatedRecovery,sourceArchiveDirectory}){
 await verifyOwnedRecovery({core,sales,sourceRoot,environment,recovery});
 const archive=createImportSourceArchive({directory:path.join(sourceRoot,'private','import-sources'),vault:recoveryVault(environment),readOnly:true,...(sourceArchiveDirectory?{objectDirectory:sourceArchiveDirectory,objectExpectedUid:fs.lstatSync(sourceArchiveDirectory).uid}:{})});
 return withProtection(core,recoveryVault(environment),protection=>require('./cash-rehydration').rehydrateCash(sales,{protection,archive,plan:recovery.cashPlan,isolatedRecovery}));
}
async function copyFrozenSourceObjects({bundle,sourceDirectory,targetDirectory,environment,recovery}){
 require('./deploy-owned-contract').validateRecovery(recovery);
 const {safeRoot,digest}=require('./paired-bundle');
 safeRoot(sourceDirectory);
 if(fs.existsSync(targetDirectory)||path.resolve(targetDirectory)!==targetDirectory||!path.isAbsolute(targetDirectory))throw new Error('PG_DEPLOY_SOURCE_TARGET');
 const frozen=await sourceArchive(bundle,environment,{allowMissing:false,referenceOnly:true});
 if(frozen.generationSha256!==recovery.sourceArchive.generationSha256)throw new Error('PG_DEPLOY_SOURCE_ARCHIVE_CHANGED');
 const applied=require('../../../data-import-source-archive').appliedImportSourceArchiveEntries(frozen);
 const files=new Set(applied.map(entry=>entry.file));
 const expected=frozen.files.filter(entry=>files.has(entry.file));
 if(expected.length!==files.size)throw new Error('PG_DEPLOY_SOURCE_OBJECTS');
 const needed=expected.reduce((n,entry)=>n+entry.bytes,0),capacity=fs.statfsSync(path.dirname(targetDirectory));
 if(capacity.bavail*capacity.bsize<needed+10*1024**3)throw new Error('PG_PAIR_RESTORE_DISK_RESERVE');
 fs.mkdirSync(targetDirectory,{mode:0o700});
 for(const entry of expected){
  if(!/^[a-f0-9]{64}\.source$/.test(entry.file))throw new Error('PG_DEPLOY_SOURCE_OBJECTS');
  const from=path.join(sourceDirectory,entry.file),to=path.join(targetDirectory,entry.file);
  const before=await digest(from);
  if(before.bytes!==entry.bytes||before.sha256!==entry.sha256)throw new Error('PG_DEPLOY_SOURCE_OBJECT_CHANGED');
  fs.cpSync(from,to,{errorOnExist:true,force:false,dereference:false});
  const after=await digest(to);
  if(after.bytes!==entry.bytes||after.sha256!==entry.sha256)throw new Error('PG_DEPLOY_SOURCE_OBJECT_CHANGED');
  fs.chmodSync(to,0o600);
 }
 return {verified:true,objects:expected.length,bytes:needed};
}
async function copyFreshSourceFiles({sourceDirectory,targetDirectory}){
 const {safeRoot,digest}=require('./paired-bundle');
 safeRoot(sourceDirectory);
 if(fs.existsSync(targetDirectory)||!path.isAbsolute(targetDirectory)||path.resolve(targetDirectory)!==targetDirectory)throw new Error('PG_DEPLOY_SOURCE_TARGET');
 const uid=fs.lstatSync(sourceDirectory).uid;
 const entries=require('../../../data-import-source-catalog').SOURCE_CATALOG.filter(entry=>entry.available);
 let bytes=0;const proofs=[];
 for(const entry of entries){
  const file=path.join(sourceDirectory,entry.fileName),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==uid||(stat.mode&0o077)||stat.size<4096||stat.size>require('../../../tradefoto-full-import-source').MAX_BYTES||fs.realpathSync(file)!==file)throw new Error('PG_DEPLOY_FRESH_SOURCE_FILE');
  const proof=await digest(file);proofs.push({kind:entry.kind,file:entry.fileName,...proof});bytes+=proof.bytes;
 }
 const capacity=fs.statfsSync(path.dirname(targetDirectory));
 if(capacity.bavail*capacity.bsize<bytes+10*1024**3)throw new Error('PG_PAIR_RESTORE_DISK_RESERVE');
 fs.mkdirSync(targetDirectory,{mode:0o700});
 for(const entry of proofs){
  const from=path.join(sourceDirectory,entry.file),to=path.join(targetDirectory,entry.file);
  fs.cpSync(from,to,{errorOnExist:true,force:false,dereference:false});fs.chmodSync(to,0o600);
  for(const file of [from,to]){const after=await digest(file);if(after.bytes!==entry.bytes||after.sha256!==entry.sha256)throw new Error('PG_DEPLOY_FRESH_SOURCE_CHANGED');}
 }
 return {verified:true,objects:proofs.length,bytes,sources:proofs};
}
module.exports={recoveryVault,withProtection,salesPlan,sourceArchive,prepareOwnedRecovery,verifyOwnedRecovery,rehydrateOwnedCash,rehydrateOwnedSources,copyFrozenSourceObjects,copyFreshSourceFiles};
