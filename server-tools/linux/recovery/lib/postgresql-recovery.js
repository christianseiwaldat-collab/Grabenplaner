'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {verifyPairBundle}=require('../../../../lib/persistence/postgresql/operations/paired-bundle');
const {monitorActivity,childCompletion,emitProgress}=require('./postgresql-recovery-activity');
const {unitController,finishWorkspace,cancellation}=require('./postgresql-recovery-control');
const BASE='/var/lib/grabenplaner-offsite/postgresql-recovery';
const ACCOUNT='grabenplaner-offsite';
function ownTree(root,uid,gid){
 for(const name of fs.readdirSync(root)){const file=path.join(root,name),info=fs.lstatSync(file);if(info.isSymbolicLink()||!info.isDirectory()&&(!info.isFile()||info.nlink!==1))throw new Error('PG_RECOVERY_TREE');if(info.isDirectory())ownTree(file,uid,gid);else{fs.chownSync(file,uid,gid);fs.chmodSync(file,0o600);}}
 fs.chownSync(root,uid,gid);fs.chmodSync(root,0o700);
}
function recoveryUnitProperties(root){
 if(typeof root!=='string'||path.dirname(root)!==BASE||! /^[a-f0-9-]{36}$/.test(path.basename(root)))throw new Error('PG_RECOVERY_UNIT_ROOT');
 // As in the SQLite smoke service, group access exists only inside this
 // process. Live files and maintenance sockets remain inaccessible.
 // Match the verified recovery-only resource envelope, including two restore
 // jobs and subsequent application workers; never alter the productive unit.
 return ['User='+ACCOUNT,'Group='+ACCOUNT,'SupplementaryGroups=grabenplaner','PrivateNetwork=yes','PrivateTmp=yes','NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=yes','ProtectProc=invisible','RestrictSUIDSGID=yes','RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK','UMask=0077','KillMode=control-group','MemoryMax=3G','CPUQuota=200%','Nice=15','RuntimeMaxSec=infinity','CPUAccounting=yes','IOAccounting=yes','TimeoutStopSec=30s','SendSIGKILL=yes','ReadOnlyPaths=/opt/grabenplaner/app','ReadWritePaths='+root,'InaccessiblePaths=-/var/lib/grabenplaner -/var/lib/grabenplaner-postgresql -/etc/grabenplaner -/var/backups/grabenplaner -/var/backups/grabenplaner-postgresql -/var/log/grabenplaner -/var/lib/grabenplaner-assurance -/run/postgresql -/run/grabenplaner -/run/grabenplaner-offsite -/run/grabenplaner-assurance-control -/var/lib/grabenplaner-offsite/credentials -/var/lib/grabenplaner-offsite/uploader-home -/var/lib/grabenplaner-offsite/staging -/var/lib/grabenplaner-offsite/restore-tests -/var/lib/grabenplaner-offsite/status.json'];
}
function applicationRecoveryPassed({scope,rehydrate,fresh,recovery,result,freshInputProof}){
 if(scope==='full')return result.application?.fullApplicationSmoke===true;
 if(result.fullRecovery!==false)return false;
 if(!rehydrate)return result.application?.ownedApplicationSmoke===true&&result.application?.fullApplicationSmoke===false&&result.requiresCashRehydration===true&&result.requiresAccessRehydration===true&&(!fresh||result.requiresFreshAccess===true);
 if(result.cashRehydration?.verified!==true||result.accessRehydration?.verified!==true||result.accessRehydration?.rehydrated!==true)return false;
 if(!fresh)return result.application?.fullApplicationSmoke===true;
 const replay=result.accessRehydration.sourceReplay,plan=recovery.freshSourcePlan;
 if(result.requiresFreshAccess!==false||result.requiresAccessRehydration!==false||result.requiresCashRehydration!==false||result.application?.ownedApplicationSmoke!==true||result.application?.fullApplicationSmoke!==false
  ||replay?.format!==require('../../../../lib/persistence/postgresql/operations/access-fresh-rebuild').FORMAT||replay.basis!==recovery.basis
  ||replay.verified!==true||replay.rehydrated!==true||replay.newSourceGeneration!==true||replay.oldSourceValuesReconstructed!==false||replay.planSha256!==plan.planSha256||!Array.isArray(replay.sources)
  ||freshInputProof?.verified!==true||!Array.isArray(freshInputProof.sources)||freshInputProof.sources.length!==plan.kinds.length)return false;
 const expected=new Set(plan.actors.flatMap(actor=>plan.kinds.map(kind=>actor.scopeId+':'+kind.kind))),inputs=new Map(freshInputProof.sources.map(source=>[source.kind,source]));
 if(inputs.size!==plan.kinds.length||replay.sourceCount!==expected.size||replay.sources.length!==expected.size)return false;
 for(const source of replay.sources){
  const input=inputs.get(source?.kind);
  if(!input||!expected.delete(source.scopeId+':'+source.kind)||source.fileSha256!==input.sha256||source.bytes!==input.bytes||source.status!==(source.kind==='cash'?'ready':'applied'))return false;
 }
 return expected.size===0;
}
async function verifyPostgresqlRecovery({stageOutput,stage,sourcePackage,targetPackage,sourceRuntime,targetRuntime,frozenFiles,scope='full',rehydrate=false,freshSourceDirectory}){
 require('../../../../lib/persistence/postgresql/operations/deploy-data-policy').normalizeScope(scope);
 if(scope==='full'&&(rehydrate||freshSourceDirectory!==undefined)||!rehydrate&&freshSourceDirectory!==undefined)throw new Error('PG_RECOVERY_SCOPE_INVALID');
 if(process.platform!=='linux'||process.getuid()!==0)throw new Error('PG_RECOVERY_ROOT_REQUIRED');
 for(const name of ['bundle','commitMarker'])if(!path.resolve(stageOutput[name]||'').startsWith(stage+path.sep))throw new Error('PG_RECOVERY_SOURCE_PATH');
 for(const contract of [sourceRuntime,targetRuntime])if(contract.format!=='grabenplaner-linux-runtime-contract'||contract.schemaVersion!==1||!Number.isSafeInteger(contract.deploymentSchemaVersion)||contract.deploymentSchemaVersion<1)throw new Error('PG_RECOVERY_RUNTIME_CONTRACT');
 if(sourceRuntime.deploymentSchemaVersion>targetRuntime.deploymentSchemaVersion)throw new Error('PG_RECOVERY_RUNTIME_DOWNGRADE');
 const source=await verifyPairBundle(stageOutput.bundle,stageOutput.commitMarker,{expectedSha256:stageOutput.manifestSha256,scope});
 const fresh=source.manifest.recovery?.basis==='fresh-source-rebuild';
 if(rehydrate&&fresh!==Boolean(freshSourceDirectory))throw new Error('PG_DEPLOY_FRESH_SOURCE_REQUIRED');
 const bundlePattern=scope==='full'?/^[a-f0-9-]{36}\.pair$/:/^[a-f0-9-]{36}\.owned$/;
 if(!bundlePattern.test(path.basename(stageOutput.bundle)))throw new Error('PG_RECOVERY_BUNDLE_NAME');
 const passwd=fs.readFileSync('/etc/passwd','utf8').split('\n').map(r=>r.split(':')).find(r=>r[0]===ACCOUNT);
 if(!passwd||!/^\d+$/.test(passwd[2])||!/^\d+$/.test(passwd[3])||Number(passwd[2])<100)throw new Error('PG_RECOVERY_ACCOUNT');
 const uid=Number(passwd[2]),gid=Number(passwd[3]);
 if(!fs.existsSync(BASE))fs.mkdirSync(BASE,{mode:0o711});
 if(fs.realpathSync(BASE)!==BASE||fs.statSync(BASE).uid!==0||(fs.statSync(BASE).mode&0o777)!==0o711)throw new Error('PG_RECOVERY_BASE');
 const runId=crypto.randomUUID(),root=path.join(BASE,runId);fs.mkdirSync(root,{mode:0o700});
 const identity=fs.lstatSync(root),interruption=cancellation(),started=performance.now();let controller,outcome='PG_RECOVERY_FAILED',freshInputProof;
 let lastProgress={phase:'copy-backup',elapsedSeconds:0,idleSeconds:0,observable:true};
 const report=value=>{lastProgress=value;emitProgress(value);};
 try{
 report(lastProgress);
 fs.mkdirSync(root+'/source',{mode:0o700});fs.mkdirSync(root+'/work',{mode:0o700});
 fs.cpSync(stageOutput.bundle,root+'/source/'+path.basename(stageOutput.bundle),{recursive:true,errorOnExist:true,force:false,dereference:false});
 fs.copyFileSync(stageOutput.commitMarker,root+'/source/'+path.basename(stageOutput.commitMarker),fs.constants.COPYFILE_EXCL);
 if(scope!=='full'&&rehydrate){
  if(fresh){
   freshInputProof=await require('../../../../lib/persistence/postgresql/operations/owned-recovery').copyFreshSourceFiles({sourceDirectory:freshSourceDirectory,targetDirectory:root+'/fresh-access'});
  }else{
  const operations=JSON.parse(fs.readFileSync(stageOutput.bundle+'/postgresql-operations.json','utf8'));
  if(operations.mode!=='productive'||operations.sourceFiles!=='/var/lib/grabenplaner')throw new Error('PG_DEPLOY_SOURCE_ROOT');
  await require('../../../../lib/persistence/postgresql/operations/owned-recovery').copyFrozenSourceObjects({bundle:stageOutput.bundle,
   sourceDirectory:'/var/lib/grabenplaner/private/import-sources',targetDirectory:root+'/access-sources',
   environment:require('node:util').parseEnv(fs.readFileSync(stageOutput.bundle+'/configuration.env','utf8')),recovery:source.manifest.recovery});
  }
 }
 fs.writeFileSync(root+'/request.json',JSON.stringify({bundle:path.basename(stageOutput.bundle),commitMarker:path.basename(stageOutput.commitMarker),sourceVersion:sourcePackage.version,targetVersion:targetPackage.version,...(scope==='full'?{}:{scope,rehydrate,...(fresh?{freshAccess:true}:{})})})+'\n',{flag:'wx',mode:0o600});
 ownTree(root,uid,gid);
 const worker=path.join(__dirname,'postgresql-recovery-worker.js');
 if(fs.realpathSync(worker)!==worker||fs.statSync(worker).uid!==0||(fs.statSync(worker).mode&0o022))throw new Error('PG_RECOVERY_WORKER_OWNERSHIP');
 const unit='grabenplaner-pg-recovery-'+runId;
 const properties=recoveryUnitProperties(root);
 // Deliver queued signals from the synchronous backup copy before starting
 // anything. A later signal races completion and enters confirmed shutdown.
 await interruption.checkpoint();
 const child=spawn('/usr/bin/systemd-run',['--quiet','--wait','--collect','--unit='+unit,...properties.flatMap(p=>['--property='+p]),'/usr/bin/node',worker,root],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','ignore','inherit']});
 let launcherClosed=false;const completion=childCompletion(child);
 child.once('close',()=>{launcherClosed=true;});child.once('error',()=>{launcherClosed=true;});
 controller=unitController({unit,root,uid,launcherClosed:()=>launcherClosed});
 const completed=await monitorActivity({completion:Promise.race([completion,interruption.promise]),sample:()=>{const value=controller.sample();lastProgress={...lastProgress,phase:value.phase};return value;},terminate:()=>controller.stop(),report});
 // systemd-run's exit alone is not proof that PostgreSQL descendants exited.
 await controller.stop();
 fs.chownSync(root,0,0);fs.chmodSync(root,0o500);
 if(completed.code!==0)throw new Error('PG_RECOVERY_WORKER_FAILED');
 const resultFile=root+'/result.json',info=fs.lstatSync(resultFile);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==uid||info.gid!==gid||(info.mode&0o077)||info.size>1048576)throw new Error('PG_RECOVERY_RESULT');
 const fd=fs.openSync(resultFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let result;try{if(fs.fstatSync(fd).ino!==info.ino)throw new Error('PG_RECOVERY_RESULT');result=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
 const expectedProvider=scope==='full'?'postgresql-pair':'postgresql-deploy-owned';
 const applicationPassed=applicationRecoveryPassed({scope,rehydrate,fresh,recovery:source.manifest.recovery,result,freshInputProof});
 if(result.providerId!==expectedProvider||result.verified!==true||result.manifestSha256!==source.manifestSha256||result.recoveryAccounts!==8||result.managedImportKey!==true||result.application?.compatibility!==true||!applicationPassed||!result.databases?.core||!result.databases?.sales)throw new Error('PG_RECOVERY_RESULT_BINDING');
 await verifyPairBundle(stageOutput.bundle,stageOutput.commitMarker,{expectedSha256:source.manifestSha256,scope});
 interruption.throwIfCancelled();
 const receipt={ok:true,providerId:expectedProvider,...(scope==='full'?{}:{recoveryScope:scope,fullRecovery:false,ownedApplicationSmoke:result.application.ownedApplicationSmoke===true,...(freshInputProof?{freshAccessSources:freshInputProof.sources}: {})}),databaseSha256:source.manifestSha256,pairManifestSha256:source.manifestSha256,stageManifestSha256:scope==='full'?crypto.createHash('sha256').update(fs.readFileSync(stage+'/offsite-stage-manifest.json')).digest('hex'):null,sourceAppVersion:sourcePackage.version,targetAppVersion:targetPackage.version,deploymentSchemaVersion:sourceRuntime.deploymentSchemaVersion,protectedDocuments:result.protectedDocuments,protectedRecords:result.protectedRecords,integrationCredentials:result.integrationCredentials,frozenFiles:frozenFiles.length,verifiedAt:new Date().toISOString(),pairedRestore:result,fullApplicationSmoke:result.application.fullApplicationSmoke};
 const receiptFile=BASE+'/'+runId+'.restore.json';fs.writeFileSync(receiptFile,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o400});
 const receiptFd=fs.openSync(receiptFile,'r');try{fs.fsyncSync(receiptFd);}finally{fs.closeSync(receiptFd);}
 outcome='ok';
 return receipt;
 }catch(error){outcome=error.code||error.message;throw error;}
 finally{
  try{await finishWorkspace({root,base:BASE,identity,stop:()=>controller?controller.stop():Promise.resolve(),code:outcome,progress:{...lastProgress,elapsedSeconds:Math.floor((performance.now()-started)/1000)}});}
  finally{interruption.dispose();}
 }
}
module.exports={verifyPostgresqlRecovery,recoveryUnitProperties,applicationRecoveryPassed};
