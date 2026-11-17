'use strict';
// Fixed local capability. No repository, credentials, command or path crosses it.
const crypto=require('node:crypto'),net=require('node:net');
const FORMAT='gp-manual-drive-control-v1',SOCKET='/run/grabenplaner-drive-control/request.sock';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const STAGE='/var/lib/grabenplaner-offsite/staging/current',MAX_RESPONSE=512*1024,MAX_BACKUPS=1000;
const STATES=['queued','running','succeeded','failed'],PHASES=['queued','preparing','uploading','confirming','deleting','complete','failed'];
const CODES=['DRIVE_BACKUP_UNAVAILABLE','DRIVE_BACKUP_BUSY','DRIVE_BACKUP_NOT_FOUND','DRIVE_BACKUP_PROTECTED','DRIVE_BACKUP_REQUEST_CONFLICT','DRIVE_BACKUP_INVALID','DRIVE_BACKUP_FAILED'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
function exact(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
function utc(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
function request(value){
 if(!exact(value,['format','requestId','action','snapshotId'])||value.format!==FORMAT||!UUID.test(value.requestId)||!['list','create','delete','dispatch'].includes(value.action)
  ||(value.action==='delete'?!SHA.test(value.snapshotId):value.snapshotId!==null))fail('DRIVE_BACKUP_INVALID');
 return value;
}
function body(value,action){
 const keys=action==='delete'?['requestId','currentPassword','confirmation']:['requestId'];
 if(!exact(value,keys)||!UUID.test(value.requestId)||action==='delete'&&(value.confirmation!=='DELETE_BACKUP'||typeof value.currentPassword!=='string'||!value.currentPassword.length||value.currentPassword.length>512))fail('DRIVE_BACKUP_INVALID');
 return value;
}
function operation(value){
 if(value===null)return null;
 if(!exact(value,['requestId','action','state','phase','requestedAt','startedAt','finishedAt','snapshotId','errorCode'])||!UUID.test(value.requestId)||!['create','delete'].includes(value.action)
  ||!STATES.includes(value.state)||!PHASES.includes(value.phase)||!utc(value.requestedAt)||value.startedAt!==null&&!utc(value.startedAt)||value.finishedAt!==null&&!utc(value.finishedAt)
  ||value.snapshotId!==null&&!SHA.test(value.snapshotId)||value.errorCode!==null&&!CODES.includes(value.errorCode)
  ||['queued','running'].includes(value.state)!==(value.finishedAt===null)||value.state==='failed'!==(value.errorCode!==null)
  ||value.action==='create'&&value.state==='succeeded'&&!SHA.test(value.snapshotId)||value.action==='delete'&&!SHA.test(value.snapshotId))fail('DRIVE_BACKUP_UNAVAILABLE');
 return value;
}
function model(value){
 if(!exact(value,['available','providerId','generatedAt','verifiedAt','stale','busy','backups','operation'])||value.available!==true||value.providerId!=='google_drive'
  ||!utc(value.generatedAt)||value.verifiedAt!==null&&!utc(value.verifiedAt)||typeof value.stale!=='boolean'||typeof value.busy!=='boolean'||!Array.isArray(value.backups)||value.backups.length>MAX_BACKUPS)fail('DRIVE_BACKUP_UNAVAILABLE');
 const ids=new Set();
 for(const row of value.backups){
  if(!exact(row,['snapshotId','createdAt','sizeBytes','sizeBasis','scope','status','manual','deletable','blockedDeleteReason'])||!SHA.test(row.snapshotId)||ids.has(row.snapshotId)||!utc(row.createdAt)
   ||row.sizeBytes!==null&&(!Number.isSafeInteger(row.sizeBytes)||row.sizeBytes<0)||row.sizeBasis!==(row.sizeBytes===null?'unknown':'logical')||row.scope!=='full'||row.status!=='confirmed'
   ||typeof row.manual!=='boolean'||typeof row.deletable!=='boolean'||![null,'NEWEST_BACKUP','AUTOMATIC_BACKUP','OPERATION_BUSY'].includes(row.blockedDeleteReason)
   ||row.deletable&&(!row.manual||value.busy||value.stale||row.blockedDeleteReason!==null))fail('DRIVE_BACKUP_UNAVAILABLE');
  ids.add(row.snapshotId);
 }
 operation(value.operation);return value;
}
function snapshots(values,host){
 if(!Array.isArray(values)||values.length>5000||!/^grabenplaner-[a-f0-9]{32}$/.test(host))fail('DRIVE_BACKUP_UNAVAILABLE');
 const result=[],seen=new Set();
 for(const item of values){
  if(item?.hostname!==host||!Array.isArray(item.paths)||item.paths.length!==1||item.paths[0]!==STAGE||!Array.isArray(item.tags))continue;
  const tags=[...item.tags].sort(),manual=tags.length===3&&tags.includes('grabenplaner-offsite')&&tags.includes('manual-admin-ui')&&tags.some(t=>typeof t==='string'&&t.startsWith('gp-manual-')&&UUID.test(t.slice(10)));
  const daily=tags.length===2&&tags.join(',')==='daily,grabenplaner-offsite';if(!manual&&!daily)continue;
  if(!SHA.test(item.id)||seen.has(item.id)||!Number.isFinite(Date.parse(item.time)))fail('DRIVE_BACKUP_UNAVAILABLE');seen.add(item.id);
  const bytes=item.summary?.total_bytes_processed,sizeBytes=Number.isSafeInteger(bytes)&&bytes>=0?bytes:null;
  result.push({snapshotId:item.id,createdAt:new Date(item.time).toISOString(),sizeBytes,sizeBasis:sizeBytes===null?'unknown':'logical',scope:'full',status:'confirmed',manual,deletable:false,blockedDeleteReason:null});
 }
 if(result.length>MAX_BACKUPS)fail('DRIVE_BACKUP_UNAVAILABLE');
 result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.snapshotId.localeCompare(b.snapshotId));return result;
}
function publicModel(cache,job,{busy=false,stale=false,now=new Date().toISOString()}={}){
 const backups=cache.backups.map((row,index)=>({...row,deletable:row.manual&&index!==0&&!busy&&!stale,
  blockedDeleteReason:busy||stale?'OPERATION_BUSY':!row.manual?'AUTOMATIC_BACKUP':index===0?'NEWEST_BACKUP':null}));
 return model({available:true,providerId:'google_drive',generatedAt:now,verifiedAt:cache.verifiedAt,stale,busy,backups,operation:job});
}
async function exchange(action,{requestId=crypto.randomUUID(),snapshotId=null}={}){
 if(process.platform!=='linux')fail('DRIVE_BACKUP_UNAVAILABLE');
 require('./offsite-target-client').assertSafeSocket(SOCKET);
 const value=request({format:FORMAT,requestId,action,snapshotId});
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection({path:SOCKET,allowHalfOpen:true}),chunks=[];let bytes=0,done=false;
  const end=(error,result)=>{if(done)return;done=true;socket.destroy();error?reject(error):resolve(result);};
  socket.setTimeout(35000);socket.on('connect',()=>socket.end(JSON.stringify(value)+'\n'));
  socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_RESPONSE)end(Object.assign(new Error('DRIVE_BACKUP_UNAVAILABLE'),{code:'DRIVE_BACKUP_UNAVAILABLE'}));else chunks.push(chunk);});
  socket.on('error',()=>end(Object.assign(new Error('DRIVE_BACKUP_UNAVAILABLE'),{code:'DRIVE_BACKUP_UNAVAILABLE'})));socket.on('timeout',()=>end(Object.assign(new Error('DRIVE_BACKUP_UNAVAILABLE'),{code:'DRIVE_BACKUP_UNAVAILABLE'})));
  socket.on('end',()=>{try{
   const raw=Buffer.concat(chunks).toString('utf8');if(!raw.endsWith('\n')||raw.trim().includes('\n'))fail('DRIVE_BACKUP_UNAVAILABLE');const result=JSON.parse(raw);
   if(!exact(result,['format','requestId','ok','errorCode','model'])||result.format!==FORMAT||result.requestId!==requestId||typeof result.ok!=='boolean')fail('DRIVE_BACKUP_UNAVAILABLE');
   if(!result.ok){if(!CODES.includes(result.errorCode)||result.model!==null)fail('DRIVE_BACKUP_UNAVAILABLE');fail(result.errorCode);}
   if(result.errorCode!==null)fail('DRIVE_BACKUP_UNAVAILABLE');const current=model(result.model);
   if(['create','delete'].includes(action)&&(current.operation?.requestId!==requestId||current.operation.action!==action))fail('DRIVE_BACKUP_UNAVAILABLE');
   end(null,current);
  }catch(error){end(error);}});
 });
}
module.exports={FORMAT,SOCKET,UUID,SHA,STAGE,MAX_RESPONSE,MAX_BACKUPS,CODES,PHASES,exact,utc,request,body,operation,model,snapshots,publicModel,exchange};
