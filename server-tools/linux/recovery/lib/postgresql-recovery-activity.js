'use strict';
const fs=require('node:fs'),path=require('node:path');
const CGROUP_ROOT='/sys/fs/cgroup';
const PHASE=/^[a-z][a-z0-9-]{0,63}$/;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fault(code){return Object.assign(new Error(code),{code});}
function activity(value){
 if(!value||['cpuUsec','ioBytes','sequence'].some(k=>!Number.isSafeInteger(value[k])||value[k]<0)||!PHASE.test(value.phase||''))throw fault('PG_RECOVERY_ACTIVITY_INVALID');
 return value;
}
function emitProgress(value){process.stderr.write(JSON.stringify({event:'postgresql-recovery-progress',...value})+'\n');}
// Low-frequency accounting and tiny HTTP heartbeat writes are not progress.
// PostgreSQL CPU work, substantive block I/O, or a new phase renew the idle lease.
async function monitorActivity({completion,sample,terminate,now=()=>performance.now(),pause,report=emitProgress,
 pollMs=15000,reportMs=60000,idleMs=10*60000,observationGraceMs=60000,minCpuUsec=100000,minIoBytes=65536}={}){
 const started=now();let lastActive=started,lastReport=started,unobservableSince=null,previous=null,lastPhase='starting';
 const finished=Promise.resolve(completion).then(value=>({done:true,value}),error=>({done:true,error}));
 const fail=async code=>{await terminate(code);throw fault(code);};
 for(;;){
  let timer;
  const tick=pause?pause(pollMs):new Promise(resolve=>{timer=setTimeout(resolve,pollMs);});
  const outcome=await Promise.race([finished,Promise.resolve(tick).then(()=>null)]);
  if(timer)clearTimeout(timer);
  if(outcome){if(outcome.error)throw outcome.error;return outcome.value;}
  const at=now();
  try{
   const current=activity(await sample());
   if(previous&&(current.cpuUsec<previous.cpuUsec||current.ioBytes<previous.ioBytes||current.sequence<previous.sequence))throw fault('PG_RECOVERY_ACTIVITY_RESET');
   if(!previous||current.cpuUsec-previous.cpuUsec>=minCpuUsec||current.ioBytes-previous.ioBytes>=minIoBytes||current.sequence>previous.sequence){lastActive=at;}
   previous=current;lastPhase=current.phase;unobservableSince=null;
  }catch{
   if(unobservableSince===null)unobservableSince=at;
  }
  if(at-lastReport>=reportMs){report({phase:lastPhase,elapsedSeconds:Math.floor((at-started)/1000),idleSeconds:Math.floor((at-lastActive)/1000),observable:unobservableSince===null});lastReport=at;}
  if(unobservableSince!==null&&at-unobservableSince>=observationGraceMs)return fail('PG_RECOVERY_ACTIVITY_UNAVAILABLE');
  if(unobservableSince===null&&at-lastActive>=idleMs)return fail('PG_RECOVERY_STALLED');
 }
}
async function terminateAndConfirm({signal,isStopped,now=()=>performance.now(),pause=delay,termGraceMs=30000,killGraceMs=15000,pollMs=1000}={}){
 const stopped=async()=>{try{return await isStopped()===true;}catch{return false;}};
 if(await stopped())return {confirmed:true,escalated:false};
 for(const [name,grace] of [['SIGTERM',termGraceMs],['SIGKILL',killGraceMs]]){
  try{await signal(name);}catch{/* Confirmation remains mandatory even if a unit vanishes during signalling. */}
  const end=now()+grace;
  while(now()<end){if(await stopped())return {confirmed:true,escalated:name==='SIGKILL'};await pause(Math.min(pollMs,end-now()));}
  if(await stopped())return {confirmed:true,escalated:name==='SIGKILL'};
 }
 throw fault('PG_RECOVERY_STOP_UNCONFIRMED');
}
function cgroupPath(relative){
 if(typeof relative!=='string'||!relative.startsWith('/')||relative.split('/').some(x=>x==='.'||x==='..')||/[\x00-\x20\\]/.test(relative))throw fault('PG_RECOVERY_CGROUP_PATH');
 const target=path.posix.join(CGROUP_ROOT,relative);
 if(target!==CGROUP_ROOT&&!target.startsWith(CGROUP_ROOT+'/'))throw fault('PG_RECOVERY_CGROUP_PATH');
 return target;
}
function readCgroupActivity(group,{phase='native-tool',sequence=0}={}){
 const target=cgroupPath(group),cpu=fs.readFileSync(target+'/cpu.stat','utf8'),io=fs.readFileSync(target+'/io.stat','utf8');
 const cpuUsec=Number(cpu.match(/^usage_usec (\d+)$/m)?.[1]);let ioBytes=0;
 for(const match of io.matchAll(/(?:^|\s)(?:rbytes|wbytes)=(\d+)/g))ioBytes+=Number(match[1]);
 return activity({cpuUsec,ioBytes,phase,sequence});
}
function processCgroup(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)throw fault('PG_RECOVERY_PROCESS');
 const group=fs.readFileSync('/proc/'+pid+'/cgroup','utf8').split('\n').find(line=>line.startsWith('0::'))?.slice(3);
 cgroupPath(group);return group;
}
function childCompletion(child,startCode='PG_RECOVERY_WORKER_START'){
 return new Promise((resolve,reject)=>{child.once('error',()=>reject(fault(startCode)));child.once('close',(code,signal)=>resolve({code,signal}));});
}
function phaseReporter(root){
 let sequence=0;
 return phase=>{
  if(!PHASE.test(phase))throw fault('PG_RECOVERY_PHASE');
  const temporary=root+'/progress.pending',target=root+'/progress.json';
  fs.writeFileSync(temporary,JSON.stringify({phase,sequence:++sequence})+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(temporary,target);
 };
}
function readPhase(root,uid){
 const file=root+'/progress.json';let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==uid||(stat.mode&0o077)||stat.size>1024)throw fault('PG_RECOVERY_PHASE_FILE');
  const value=JSON.parse(fs.readFileSync(fd,'utf8'));
  if(Object.keys(value).sort().join(',')!=='phase,sequence'||!PHASE.test(value.phase)||!Number.isSafeInteger(value.sequence)||value.sequence<1)throw fault('PG_RECOVERY_PHASE_FILE');
  return value;
 }catch(error){if(error.code==='ENOENT')return {phase:'starting',sequence:0};throw error;}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={monitorActivity,terminateAndConfirm,readCgroupActivity,processCgroup,childCompletion,phaseReporter,readPhase,cgroupPath,emitProgress};
