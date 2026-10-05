'use strict';
const {spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const TOOL_MS=20*60*1000,OPERATION_MS=22*60*1000,SNAPSHOT_IDLE_MS=25*60*1000;
const STATEMENT_MS=5*60*1000,TERMINATION_MS=30*1000,LIFECYCLE_REQUEST_MS=25*60*1000;
const failure=code=>Object.assign(new Error(code),{code});
function createBackupBudget({now=()=>performance.now(),milliseconds=OPERATION_MS}={}){
 if(typeof now!=='function'||!Number.isSafeInteger(milliseconds)||milliseconds<1||milliseconds>OPERATION_MS)throw failure('PG_BACKUP_BUDGET_INVALID');
 const started=now();if(!Number.isFinite(started))throw failure('PG_BACKUP_BUDGET_INVALID');
 const expires=started+milliseconds;
 const remaining=()=>{const value=expires-now();if(!Number.isFinite(value)||value<=0)throw failure('PG_BACKUP_OPERATION_TIMEOUT');return Math.ceil(value);};
 return Object.freeze({remaining,toolMilliseconds:()=>Math.min(TOOL_MS,remaining()),statementMilliseconds:()=>Math.min(STATEMENT_MS,remaining())});
}
// This client is already inside an owned transaction. Each query, including
// checkpoint counts, receives no more than the remaining operation budget.
function boundedSnapshotClient(client,budget){
 return Object.freeze({async query(...args){
  await client.query("SET LOCAL statement_timeout='"+budget.statementMilliseconds()+"ms'");
  const value=await client.query(...args);budget.remaining();return value;
 }});
}
function lifecycleRequestCurrent(value,now=Date.now()){
 const age=now-Date.parse(value?.acceptedAt);
 return value?.state==='preparing'&&typeof value.requestId==='string'&&value.requestId.length>0&&Number.isFinite(age)&&age>=0&&age<LIFECYCLE_REQUEST_MS;
}
function runBackupTool(binary,argv,{environment,output,error,timeoutMs,terminationMs=TERMINATION_MS,spawnImpl=spawn}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>TOOL_MS||!Number.isSafeInteger(terminationMs)||terminationMs<1||terminationMs>TERMINATION_MS)throw failure('PG_BACKUP_TOOL_BUDGET_INVALID');
 return new Promise((resolve,reject)=>{
  let child,timer,termination,expired=false,started=false,startFailed=false,closed=false;
  const finish=errorValue=>{if(closed)return;closed=true;clearTimeout(timer);clearTimeout(termination);errorValue?reject(errorValue):resolve();};
  try{child=spawnImpl(binary,argv,{env:environment,stdio:['ignore',output,error]});}catch{return finish(failure('PG_OPERATIONS_TOOL_START'));}
  child.once('spawn',()=>{started=true;});
  child.once('error',()=>{startFailed=true;if(!started&&!child.pid)finish(failure('PG_OPERATIONS_TOOL_START'));});
  timer=setTimeout(()=>{expired=true;try{child.kill('SIGTERM');}catch{/* wait for close; never release a live tool */}
   termination=setTimeout(()=>{if(!closed)try{child.kill('SIGKILL');}catch{/* close remains mandatory */}},terminationMs);
  },timeoutMs);
  // Expiry alone never resolves/rejects: transactions and leases outlive the
  // owned child until its actual close, including the bounded KILL escalation.
  child.once('close',code=>finish(expired?failure('PG_OPERATIONS_TOOL_TIMEOUT'):startFailed?failure('PG_OPERATIONS_TOOL_START'):code===0?null:failure('PG_OPERATIONS_TOOL_FAILED')));
 });
}
module.exports={TOOL_MS,OPERATION_MS,SNAPSHOT_IDLE_MS,STATEMENT_MS,TERMINATION_MS,LIFECYCLE_REQUEST_MS,createBackupBudget,boundedSnapshotClient,lifecycleRequestCurrent,runBackupTool};
