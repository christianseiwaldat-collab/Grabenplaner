'use strict';
const fs=require('node:fs'),path=require('node:path');
const {applicationStartupPhase,sanitizeReportWorkerDiagnostic}=require('../../../../lib/report-worker-diagnostics');
const PHASES=new Set(['preparing','requiring-server','server-required','initializing-application','application-data','receipt-workers','report-worker','initialization-wait','initialization-failed','application-initialized','starting-listener','listener-ready','/api/health/live','/api/health/ready']);
function boundedFile(root,name,limit,tail=false){
 const file=path.join(root,'work','application',name);let fd;
 try{
  if(fs.realpathSync(file)!==file)return null;
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||!tail&&stat.size>limit)return null;
  const start=tail?Math.max(0,stat.size-limit):0,buffer=Buffer.alloc(Math.min(stat.size,limit));
  const count=fs.readSync(fd,buffer,0,buffer.length,start),text=buffer.subarray(0,count).toString('utf8');
  return start?text.slice(text.indexOf('\n')+1):text;
 }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function safeDiagnostics(root){
 const result={},progress=[];
 for(const line of (boundedFile(root,'http-progress.jsonl',65536,true)||'').trim().split('\n').slice(-64)){
  try{
   const row=JSON.parse(line);if(!PHASES.has(row.phase))continue;
   const entry={phase:row.phase};
   if(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.at||''))entry.at=row.at;
   for(const key of ['heap','rss'])if(Number.isSafeInteger(row[key])&&row[key]>=0)entry[key]=row[key];
   progress.push(entry);
  }catch{/* A partial final progress record is not a verification failure. */}
 }
 if(progress.length)result.httpProgress=progress;
 try{
  const failure=JSON.parse(boundedFile(root,'startup-failure.json',4096)||'null');
  const startupPhase=applicationStartupPhase(failure?.startupPhase),diagnostic=sanitizeReportWorkerDiagnostic(failure?.diagnostic);
  if(startupPhase&&diagnostic){
   result.startupFailure={startupPhase,diagnostic};
   if(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(failure.at||''))result.startupFailure.at=failure.at;
  }
 }catch{/* Only fixed technical classes survive cleanup; never raw worker errors. */}
 try{
  const response=JSON.parse(boundedFile(root,'http-last-response-private.json',65536)||'null');
  if(response&&['/api/health/live','/api/health/ready'].includes(response.route)&&Number.isInteger(response.status)&&response.status>=100&&response.status<=599){
   const health={route:response.route,status:response.status};
   for(const key of ['ok','ready'])if(typeof response.body?.[key]==='boolean')health[key]=response.body[key];
   const code=response.body?.code||response.body?.errorCode||response.body?.error?.code;
   if(/^[A-Z][A-Z0-9_]{1,79}$/.test(code||''))health.code=code;
   result.health=health;
  }
 }catch{/* Never copy raw response bodies or assertion messages. */}
 return result;
}
module.exports={safeDiagnostics};
