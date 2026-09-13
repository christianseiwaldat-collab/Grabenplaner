'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {verifyPairBundle}=require('../../../../lib/persistence/postgresql/operations/paired-bundle');
const BASE='/var/lib/grabenplaner-offsite/postgresql-recovery';
const ACCOUNT='grabenplaner-offsite';
function ownTree(root,uid,gid){
 for(const name of fs.readdirSync(root)){const file=path.join(root,name),info=fs.lstatSync(file);if(info.isSymbolicLink()||!info.isDirectory()&&(!info.isFile()||info.nlink!==1))throw new Error('PG_RECOVERY_TREE');if(info.isDirectory())ownTree(file,uid,gid);else{fs.chownSync(file,uid,gid);fs.chmodSync(file,0o600);}}
 fs.chownSync(root,uid,gid);fs.chmodSync(root,0o700);
}
async function verifyPostgresqlRecovery({stageOutput,stage,sourcePackage,targetPackage,sourceRuntime,targetRuntime,frozenFiles}){
 if(process.platform!=='linux'||process.getuid()!==0)throw new Error('PG_RECOVERY_ROOT_REQUIRED');
 for(const name of ['bundle','commitMarker'])if(!path.resolve(stageOutput[name]||'').startsWith(stage+path.sep))throw new Error('PG_RECOVERY_SOURCE_PATH');
 for(const contract of [sourceRuntime,targetRuntime])if(contract.format!=='grabenplaner-linux-runtime-contract'||contract.schemaVersion!==1||!Number.isSafeInteger(contract.deploymentSchemaVersion)||contract.deploymentSchemaVersion<1)throw new Error('PG_RECOVERY_RUNTIME_CONTRACT');
 if(sourceRuntime.deploymentSchemaVersion>targetRuntime.deploymentSchemaVersion)throw new Error('PG_RECOVERY_RUNTIME_DOWNGRADE');
 const source=await verifyPairBundle(stageOutput.bundle,stageOutput.commitMarker,{expectedSha256:stageOutput.manifestSha256});
 if(!/^[a-f0-9-]{36}\.pair$/.test(path.basename(stageOutput.bundle)))throw new Error('PG_RECOVERY_BUNDLE_NAME');
 const passwd=fs.readFileSync('/etc/passwd','utf8').split('\n').map(r=>r.split(':')).find(r=>r[0]===ACCOUNT);
 if(!passwd||!/^\d+$/.test(passwd[2])||!/^\d+$/.test(passwd[3])||Number(passwd[2])<100)throw new Error('PG_RECOVERY_ACCOUNT');
 const uid=Number(passwd[2]),gid=Number(passwd[3]);
 if(!fs.existsSync(BASE))fs.mkdirSync(BASE,{mode:0o711});
 if(fs.realpathSync(BASE)!==BASE||fs.statSync(BASE).uid!==0||(fs.statSync(BASE).mode&0o777)!==0o711)throw new Error('PG_RECOVERY_BASE');
 const runId=crypto.randomUUID(),root=path.join(BASE,runId);fs.mkdirSync(root,{mode:0o700});
 fs.mkdirSync(root+'/source',{mode:0o700});fs.mkdirSync(root+'/work',{mode:0o700});
 fs.cpSync(stageOutput.bundle,root+'/source/'+path.basename(stageOutput.bundle),{recursive:true,errorOnExist:true,force:false,dereference:false});
 fs.copyFileSync(stageOutput.commitMarker,root+'/source/'+path.basename(stageOutput.commitMarker),fs.constants.COPYFILE_EXCL);
 fs.writeFileSync(root+'/request.json',JSON.stringify({bundle:path.basename(stageOutput.bundle),commitMarker:path.basename(stageOutput.commitMarker),sourceVersion:sourcePackage.version,targetVersion:targetPackage.version})+'\n',{flag:'wx',mode:0o600});
 ownTree(root,uid,gid);
 const worker=path.join(__dirname,'postgresql-recovery-worker.js');
 if(fs.realpathSync(worker)!==worker||fs.statSync(worker).uid!==0||(fs.statSync(worker).mode&0o022))throw new Error('PG_RECOVERY_WORKER_OWNERSHIP');
 const unit='grabenplaner-pg-recovery-'+runId;
 const properties=['User='+ACCOUNT,'Group='+ACCOUNT,'PrivateNetwork=yes','PrivateTmp=yes','NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=yes','ProtectProc=invisible','RestrictSUIDSGID=yes','RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK','UMask=0077','KillMode=control-group','MemoryMax=1536M','CPUQuota=100%','Nice=15','RuntimeMaxSec=900','ReadWritePaths='+root,'InaccessiblePaths=-/var/lib/grabenplaner -/var/lib/grabenplaner-postgresql -/etc/grabenplaner -/run/postgresql -/run/grabenplaner-offsite'];
 let code;
 try{
  const child=spawn('/usr/bin/systemd-run',['--quiet','--wait','--collect','--unit='+unit,...properties.flatMap(p=>['--property='+p]),'/usr/bin/node',worker,root],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','ignore','ignore']});
  code=await new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('PG_RECOVERY_WORKER_START')));child.once('close',resolve);});
 }finally{
  // The transient service has exited and KillMode tears down every child.
  fs.chownSync(root,0,0);fs.chmodSync(root,0o500);
 }
 if(code!==0)throw new Error('PG_RECOVERY_WORKER_FAILED');
 const resultFile=root+'/result.json',info=fs.lstatSync(resultFile);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==uid||info.gid!==gid||(info.mode&0o077)||info.size>1048576)throw new Error('PG_RECOVERY_RESULT');
 const fd=fs.openSync(resultFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let result;try{if(fs.fstatSync(fd).ino!==info.ino)throw new Error('PG_RECOVERY_RESULT');result=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
 if(result.providerId!=='postgresql-pair'||result.verified!==true||result.manifestSha256!==source.manifestSha256||result.recoveryAccounts!==8||result.managedImportKey!==true||result.application?.compatibility!==true||result.application?.fullApplicationSmoke!==true||!result.databases?.core||!result.databases?.sales)throw new Error('PG_RECOVERY_RESULT_BINDING');
 await verifyPairBundle(stageOutput.bundle,stageOutput.commitMarker,{expectedSha256:source.manifestSha256});
 const receipt={ok:true,providerId:'postgresql-pair',databaseSha256:source.manifestSha256,pairManifestSha256:source.manifestSha256,stageManifestSha256:crypto.createHash('sha256').update(fs.readFileSync(stage+'/offsite-stage-manifest.json')).digest('hex'),sourceAppVersion:sourcePackage.version,targetAppVersion:targetPackage.version,deploymentSchemaVersion:sourceRuntime.deploymentSchemaVersion,protectedDocuments:result.protectedDocuments,protectedRecords:result.protectedRecords,integrationCredentials:result.integrationCredentials,frozenFiles:frozenFiles.length,verifiedAt:new Date().toISOString(),pairedRestore:result,fullApplicationSmoke:result.application.fullApplicationSmoke};
 const receiptFile=BASE+'/'+runId+'.restore.json';fs.writeFileSync(receiptFile,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o400});
 const receiptFd=fs.openSync(receiptFile,'r');try{fs.fsyncSync(receiptFd);}finally{fs.closeSync(receiptFd);}
 // The waited transient unit has terminated its entire cgroup. Only its own
 // canonical, sealed run directory is eligible for cleanup after the receipt.
 if(path.dirname(root)!==BASE||fs.realpathSync(root)!==root||fs.statSync(root).uid!==0||fs.existsSync(root+'/work/data/postmaster.pid'))throw new Error('PG_RECOVERY_CLEANUP_GUARD');
 fs.rmSync(root,{recursive:true});
 return receipt;
}
module.exports={verifyPostgresqlRecovery};
