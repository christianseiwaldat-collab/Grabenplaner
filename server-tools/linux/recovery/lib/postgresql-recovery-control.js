'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {cgroupPath,readCgroupActivity,readPhase,terminateAndConfirm}=require('./postgresql-recovery-activity');
const {safeDiagnostics}=require('./postgresql-recovery-diagnostics');
function fault(code){return Object.assign(new Error(code),{code});}
function cancellation(emitter=process){
 let reject,cancelled=false;const promise=new Promise((resolve,failed)=>{reject=failed;});
 const interrupted=()=>{cancelled=true;reject(fault('PG_RECOVERY_INTERRUPTED'));};
 promise.catch(()=>{}); // Signals may arrive during the initial synchronous copy.
 for(const signal of ['SIGTERM','SIGINT'])emitter.on(signal,interrupted);
 function throwIfCancelled(){if(cancelled)throw fault('PG_RECOVERY_INTERRUPTED');}
 return {promise,throwIfCancelled,async checkpoint(){await new Promise(resolve=>setImmediate(resolve));throwIfCancelled();},dispose(){for(const signal of ['SIGTERM','SIGINT'])emitter.removeListener(signal,interrupted);}};
}
function unitController({unit,root,uid,launcherClosed,run=spawnSync,read=fs.readFileSync}){
 if(!/^grabenplaner-pg-recovery-[a-f0-9-]{36}$/.test(unit))throw fault('PG_RECOVERY_UNIT');
 const service=unit+'.service',expected='/system.slice/'+service;
 function command(args){return run('/usr/bin/systemctl',args,{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});}
 function state(){
  const result=command(['show',service,'--property=LoadState','--property=ActiveState','--property=ControlGroup']);
  if(result.error||![0,1].includes(result.status))throw fault('PG_RECOVERY_UNIT_OBSERVATION');
  const value=Object.fromEntries(String(result.stdout).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  if(!['loaded','not-found'].includes(value.LoadState)||!value.ActiveState||value.ControlGroup&&value.ControlGroup!==expected)throw fault('PG_RECOVERY_UNIT_BINDING');
  return value;
 }
 function isStopped(){
  const current=state();let populated;
  try{const events=read(cgroupPath(expected)+'/cgroup.events','utf8');populated=events.match(/^populated ([01])$/m)?.[1];if(populated===undefined)throw fault('PG_RECOVERY_CGROUP_EVENTS');}
  catch(error){if(error.code!=='ENOENT')throw error;populated='0';}
  return launcherClosed()&&['inactive','failed'].includes(current.ActiveState)&&populated==='0';
 }
 let stopping;
 return {
  sample(){const current=state();if(current.ControlGroup!==expected)throw fault('PG_RECOVERY_CGROUP_UNAVAILABLE');return readCgroupActivity(expected,readPhase(root,uid));},
  isStopped,
  stop(){return stopping||(stopping=terminateAndConfirm({isStopped,signal(signal){
   // Stopping prevents a pending activation from restarting the worker. Kill
   // targets all members of this UUID-bound unit, including the PostgreSQL server.
   command(['stop','--no-block',service]);command(['kill','--kill-whom=all','--signal='+signal,service]);
  }}));}
 };
}
function safeWorkspace(root,base,identity){
 if(path.dirname(root)!==base||! /^[a-f0-9-]{36}$/.test(path.basename(root))||fs.realpathSync(base)!==base||fs.realpathSync(root)!==root)throw fault('PG_RECOVERY_CLEANUP_GUARD');
 const stat=fs.lstatSync(root);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==identity.ino||stat.dev!==identity.dev)throw fault('PG_RECOVERY_CLEANUP_GUARD');
 return stat;
}
async function finishWorkspace({root,base,identity,stop,code,progress={},seal=true}){
 // A receipt is small and outside the disposable tree. No database names,
 // command output, environment values or data paths are copied into it.
 let stopped=false,failure;
 try{await stop();stopped=true;}catch(error){failure=error;}
 const safeCode=/^PG_[A-Z0-9_]{1,100}$/.test(code||'')?code:'PG_RECOVERY_FAILED';
 const diagnostic={format:'grabenplaner-postgresql-recovery-run-v1',code:code==='ok'?'ok':safeCode,stopped,cleaned:false,finishedAt:new Date().toISOString()};
 if(/^[a-z][a-z0-9-]{0,63}$/.test(progress.phase||''))diagnostic.phase=progress.phase;
 for(const key of ['elapsedSeconds','idleSeconds'])if(Number.isSafeInteger(progress[key])&&progress[key]>=0)diagnostic[key]=progress[key];
 if(typeof progress.observable==='boolean')diagnostic.observable=progress.observable;
 let eligible=false;
 if(stopped){
  try{
   safeWorkspace(root,base,identity);
   if(seal){fs.chownSync(root,0,0);fs.chmodSync(root,0o500);}
   Object.assign(diagnostic,safeDiagnostics(root));
   eligible=true;
  }catch(error){failure=error;}
 }
 const file=base+'/'+path.basename(root)+'.run.json';
 function persist(target){
  if(failure)diagnostic.cleanupCode=/^PG_[A-Z0-9_]{1,100}$/.test(failure.code||failure.message||'')?(failure.code||failure.message):'PG_RECOVERY_CLEANUP_FAILED';
  const fd=fs.openSync(target,'wx',0o400);try{fs.writeFileSync(fd,JSON.stringify(diagnostic)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }
 // Preserve useful evidence before deleting large scratch files. If the
 // receipt cannot be made durable, retain the copy for a later safe cleanup.
 persist(file);
 if(eligible){
  try{
   // rm unlinks nested symlinks instead of following them. Once the whole
   // cgroup is empty, a stale postmaster.pid is safe to remove with the copy.
   fs.rmSync(root,{recursive:true});diagnostic.cleaned=true;
  }catch(error){failure=error;}
  persist(file+'.pending');fs.chmodSync(file,0o600);fs.renameSync(file+'.pending',file);
 }
 if(failure)throw failure;
 return diagnostic;
}
module.exports={unitController,finishWorkspace,safeWorkspace,cancellation};
