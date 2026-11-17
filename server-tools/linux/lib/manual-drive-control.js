#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const P=require('../../../lib/manual-drive-backups');
const ROOT='/var/lib/grabenplaner-offsite/manual-backups',APP='/opt/grabenplaner/app',SHELL=APP+'/server-tools/linux/lib/manual-drive-operation.sh';
const fail=code=>{throw Object.assign(new Error(code),{code});};
function secure(file,{directory=false,mode,missing=false}={}){
 try{
  if(!path.isAbsolute(file)||fs.realpathSync(file)!==file)fail('DRIVE_BACKUP_UNAVAILABLE');const s=fs.lstatSync(file);
  if(s.uid!==0||s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1))fail('DRIVE_BACKUP_UNAVAILABLE');
  if(s.mode&0o022||mode!==undefined&&(s.mode&0o777)!==mode)fail('DRIVE_BACKUP_UNAVAILABLE');
  return s;
 }catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}
}
function tree(file){for(let p=file;;p=path.dirname(p)){secure(p,{directory:p!==file});if(p==='/')break;}}
function initialize(){secure('/var/lib/grabenplaner-offsite',{directory:true});for(const p of [ROOT,ROOT+'/jobs']){try{fs.mkdirSync(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}secure(p,{directory:true,mode:0o700});}}
function read(file,{optional=false,maximum=1024*1024}={}){
 const s=secure(file,{mode:0o600,missing:optional});if(!s)return null;if(s.size>maximum)fail('DRIVE_BACKUP_UNAVAILABLE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const stat=fs.fstatSync(fd);if(stat.ino!==s.ino||stat.dev!==s.dev||stat.size!==s.size||stat.nlink!==1)fail('DRIVE_BACKUP_UNAVAILABLE');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
}
function write(file,value){
 secure(path.dirname(file),{directory:true,mode:0o700});secure(file,{mode:0o600,missing:true});const temp=path.join(path.dirname(file),'.'+crypto.randomUUID()+'.tmp');
 const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{fs.renameSync(temp,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function binding(){
 const cfg=require('../offsite/lib/offsite-target-broker').readRootConfig();try{
  const p='/etc/grabenplaner/offsite/installation-id';secure(p,{mode:0o600});const id=fs.readFileSync(p,'utf8').trim();if(!/^[a-f0-9]{32}$/.test(id))fail('DRIVE_BACKUP_UNAVAILABLE');
  return {repositoryId:cfg.repositoryId,host:'grabenplaner-'+id};
 }finally{cfg.password.fill(0);}
}
function same(a,b){return a?.repositoryId===b.repositoryId&&a?.host===b.host;}
function command(action,id){
 tree(SHELL);const args=[SHELL,action,...(id?[id]:[])];
 try{return cp.execFileSync('/bin/bash',args,{encoding:'utf8',maxBuffer:4*1024*1024,timeout:action==='work'?4*3600000:28000,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});}
 catch(error){fail(error.status===75?'DRIVE_BACKUP_BUSY':'DRIVE_BACKUP_UNAVAILABLE');}
}
function cache(expected){const c=read(ROOT+'/inventory.json',{optional:true});if(c&&(!same(c.binding,expected)||!P.utc(c.verifiedAt)||!Array.isArray(c.backups)))return null;return c;}
function refresh(expected){const raw=JSON.parse(command('list'));if(!same(raw.binding,expected))fail('DRIVE_BACKUP_UNAVAILABLE');const c={binding:expected,verifiedAt:new Date().toISOString(),backups:P.snapshots(raw.snapshots,expected.host)};P.publicModel(c,null);write(ROOT+'/inventory.json',c);return c;}
function job(id){if(!P.UUID.test(id))fail('DRIVE_BACKUP_INVALID');const j=read(ROOT+'/jobs/'+id+'.json',{optional:true,maximum:4096});if(j){if(!P.exact(j,['operation','binding'])||j.operation.requestId!==id)fail('DRIVE_BACKUP_UNAVAILABLE');P.operation(j.operation);}return j;}
function save(j){P.operation(j.operation);write(ROOT+'/jobs/'+j.operation.requestId+'.json',j);}
function latest(){const p=read(ROOT+'/latest.json',{optional:true,maximum:512});if(!p)return null;if(!P.exact(p,['requestId'])||!P.UUID.test(p.requestId))fail('DRIVE_BACKUP_UNAVAILABLE');return job(p.requestId);}
function unit(id){return 'grabenplaner-drive-backup@'+id+'.service';}
function state(id){try{return cp.execFileSync('/usr/bin/systemctl',['show',unit(id),'--property=ActiveState','--value'],{encoding:'utf8',timeout:5000}).trim();}catch{fail('DRIVE_BACKUP_UNAVAILABLE');}}
function reconcile(j){if(j?.operation.state==='running'&&!['active','activating','deactivating'].includes(state(j.operation.requestId))){j.operation={...j.operation,state:'failed',phase:'failed',finishedAt:new Date().toISOString(),errorCode:'DRIVE_BACKUP_UNAVAILABLE'};save(j);}return j;}
function view(expected,{update=true}={}){
 const j=reconcile(latest());let busy=!!j&&['queued','running'].includes(j.operation.state),stale=false,c=cache(expected);
 if(!busy&&update){try{c=refresh(expected);}catch(error){if(error.code!=='DRIVE_BACKUP_BUSY')throw error;busy=true;stale=true;}}
 else stale=busy;
 if(!c)c={verifiedAt:null,backups:[]};
 return P.publicModel(c,j?.operation||null,{busy,stale});
}
function queue(req,expected){
 const old=job(req.requestId);
 if(old){if(old.operation.action!==req.action||req.action==='delete'&&old.operation.snapshotId!==req.snapshotId||!same(old.binding,expected))fail('DRIVE_BACKUP_REQUEST_CONFLICT');return P.publicModel(cache(expected)||{verifiedAt:null,backups:[]},old.operation,{busy:['queued','running'].includes(old.operation.state),stale:true});}
 const active=reconcile(latest());if(active&&['queued','running'].includes(active.operation.state))fail('DRIVE_BACKUP_BUSY');
 command('probe');const c=refresh(expected);
 if(req.action==='delete'){const selected=P.publicModel(c,null).backups.find(row=>row.snapshotId===req.snapshotId);if(!selected)fail('DRIVE_BACKUP_NOT_FOUND');if(!selected.deletable)fail('DRIVE_BACKUP_PROTECTED');}
 if(fs.readdirSync(ROOT+'/jobs').filter(n=>P.UUID.test(n.slice(0,-5))&&n.endsWith('.json')).length>=4096)fail('DRIVE_BACKUP_UNAVAILABLE');
 const j={binding:expected,operation:{requestId:req.requestId,action:req.action,state:'queued',phase:'queued',requestedAt:new Date().toISOString(),startedAt:null,finishedAt:null,snapshotId:req.snapshotId,errorCode:null}};
 save(j);write(ROOT+'/latest.json',{requestId:req.requestId});return P.publicModel(c,j.operation,{busy:true});
}
function dispatch(req,expected){
 const j=job(req.requestId);if(!j||!same(j.binding,expected))fail('DRIVE_BACKUP_NOT_FOUND');
 if(j.operation.state==='queued'){
  try{cp.execFileSync('/usr/bin/systemctl',['start','--no-block',unit(req.requestId)],{stdio:'ignore',timeout:5000});}
  catch{j.operation={...j.operation,state:'failed',phase:'failed',finishedAt:new Date().toISOString(),errorCode:'DRIVE_BACKUP_UNAVAILABLE'};save(j);}
 }
 return P.publicModel(cache(expected)||{verifiedAt:null,backups:[]},j.operation,{busy:['queued','running'].includes(j.operation.state),stale:true});
}
function response(req,run){try{return {format:P.FORMAT,requestId:req.requestId,ok:true,errorCode:null,model:run()};}catch(e){return {format:P.FORMAT,requestId:req.requestId,ok:false,errorCode:P.CODES.includes(e.code)?e.code:'DRIVE_BACKUP_UNAVAILABLE',model:null};}}
function handle(req){P.request(req);initialize();const expected=binding();return response(req,()=>req.action==='list'?view(expected):req.action==='dispatch'?dispatch(req,expected):queue(req,expected));}
async function worker(id){
 initialize();const j=job(id),expected=binding();if(!j||!same(j.binding,expected)||j.operation.state!=='queued')fail('DRIVE_BACKUP_INVALID');
 j.operation={...j.operation,state:'running',phase:j.operation.action==='create'?'preparing':'deleting',startedAt:new Date().toISOString()};save(j);
 try{const result=JSON.parse(command('work',id));if(j.operation.action==='create'&&!P.SHA.test(result.snapshotId)||j.operation.action==='delete'&&result.snapshotId!==j.operation.snapshotId)fail('DRIVE_BACKUP_UNAVAILABLE');
  j.operation.snapshotId=result.snapshotId;refresh(expected);j.operation={...j.operation,state:'succeeded',phase:'complete',finishedAt:new Date().toISOString()};save(j);
 }catch(e){j.operation={...j.operation,state:'failed',phase:'failed',finishedAt:new Date().toISOString(),errorCode:P.CODES.includes(e.code)?e.code:'DRIVE_BACKUP_FAILED'};save(j);throw e;}
}
function updatePhase(id,phase){if(!['preparing','uploading','confirming','deleting'].includes(phase))fail('DRIVE_BACKUP_INVALID');const j=job(id);if(!j||j.operation.state!=='running')fail('DRIVE_BACKUP_INVALID');j.operation.phase=phase;save(j);}
async function main(){
 if(process.platform!=='linux'||process.getuid()!==0)fail('DRIVE_BACKUP_UNAVAILABLE');tree(APP+'/server-tools/linux/lib/manual-drive-control.js');
 const [action,id,phase,...rest]=process.argv.slice(2);if(rest.length)fail('DRIVE_BACKUP_INVALID');
 if(action==='worker'&&P.UUID.test(id)&&phase===undefined)return worker(id);
 if(action==='phase'&&P.UUID.test(id)&&phase)return updatePhase(id,phase);
 if(action!=='broker'||id!==undefined)fail('DRIVE_BACKUP_INVALID');
 let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>2048)fail('DRIVE_BACKUP_INVALID');}
 let req;try{if(!text.endsWith('\n')||text.trim().includes('\n'))fail('DRIVE_BACKUP_INVALID');req=P.request(JSON.parse(text));}catch{process.stdout.write(JSON.stringify({format:P.FORMAT,requestId:crypto.randomUUID(),ok:false,errorCode:'DRIVE_BACKUP_INVALID',model:null})+'\n');return;}
 process.stdout.write(JSON.stringify(handle(req))+'\n');
}
if(require.main===module)main().catch(()=>{process.stderr.write('DRIVE_BACKUP_FAILED\n');process.exitCode=1;});
module.exports={ROOT,secure,same,request:P.request,queue,response,handle,worker,updatePhase,unit};
